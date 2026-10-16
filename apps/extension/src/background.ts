/**
 * Service worker: hosts WalletService and connects it to Chrome.
 *
 * - Dapp requests arrive on a per-request port from the content script; the
 *   origin comes from Chrome's `port.sender`, never from the page.
 * - Extension pages (popup, approval windows) use the internal API over
 *   runtime messages, and hold a UI port while open.
 * - Approvals open popup.html#approve=<id> in their own window; closing it
 *   rejects. The popup's own requests are shown in the popup.
 *
 * Chrome stops idle service workers after ~30 s. Everything that must outlive
 * that is in chrome.storage (WalletService), and an in-flight approval is kept
 * alive by the ports above: the requesting page's port and the window's.
 */
import type { WalletEvent } from '@ecash-connect/core';
import { newMnemonic } from './wallet/keys';
import { WALLET_ORIGIN, WalletService, type KV, type Pending } from './wallet/service';
import { RPC_PORT, UI_PORT, type BackgroundToContent, type ContentToBackground } from './shared';

function chromeKV(area: chrome.storage.StorageArea): KV {
  return {
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}

// Not `new URL(...).origin`: for chrome-extension: URLs that is the string
// "null" (WHATWG only computes origins for special schemes), while Chrome
// reports `sender.origin` as "chrome-extension://<id>".
const extensionBase = chrome.runtime.getURL('');
const extensionOrigin = extensionBase.replace(/\/$/, '');

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.origin) return sender.origin === extensionOrigin;
  return !!sender.url?.startsWith(extensionBase);
}

/**
 * Resolvers for approvals in flight. They cannot be persisted (they are the
 * live promise of a request), so the ports keep the worker alive while one
 * exists; the pending request itself is also in storage.session.
 */
interface Waiter {
  resolve: (ok: boolean) => void;
  windowId?: number;
}
const waiters = new Map<string, Waiter>();

function decide(id: string, ok: boolean) {
  const w = waiters.get(id);
  if (!w) return;
  waiters.delete(id);
  w.resolve(ok);
}

async function openApprovalWindow(p: Pending, w: Waiter) {
  try {
    if (p.origin === WALLET_ORIGIN) {
      // The popup asked; it is open and shows the request itself.
      await chrome.runtime.sendMessage({ type: 'pending', id: p.id });
      return;
    }
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`popup.html#approve=${p.id}`),
      type: 'popup',
      width: 380,
      height: 640,
      focused: true,
    });
    w.windowId = win?.id;
  } catch (e) {
    console.error('eCash Cat Wallet: could not show the approval', e);
    decide(p.id, false);
  }
}

function ask(p: Pending): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const w: Waiter = { resolve };
    waiters.set(p.id, w);
    void openApprovalWindow(p, w);
  });
}

async function emit(origin: string, event: WalletEvent) {
  try {
    const sites = Object.keys((await wallet.state()).sites);
    const targets = origin === '*' ? sites : [origin];
    if (!targets.length) return;
    const msg: BackgroundToContent = { type: 'ecash-event', targets, event };
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, msg);
      } catch {
        // No content script in that tab (chrome:// pages, or not loaded yet).
      }
    }
  } catch (e) {
    console.error('eCash Cat Wallet: could not deliver an event', e);
  }
}

const wallet = new WalletService({
  local: chromeKV(chrome.storage.local),
  session: chromeKV(chrome.storage.session),
  ask,
  emit: (origin, event) => void emit(origin, event),
});

/** What extension pages may call. Content scripts never reach this. */
const internal: Record<string, (a: any) => Promise<unknown> | unknown> = {
  state: () => wallet.state(),
  newMnemonic: () => newMnemonic(),
  setup: (a: { mnemonic: string; password: string }) => wallet.setup(a.mnemonic, a.password),
  unlock: (a: { password: string }) => wallet.unlock(a.password),
  lock: () => wallet.lock(),
  reveal: (a: { password: string }) => wallet.revealMnemonic(a.password),
  setNetwork: (a: { network: any }) => wallet.setNetwork(a.network),
  setEndpoints: (a: { network: any; endpoints: any }) => wallet.setEndpoints(a.network, a.endpoints),
  disconnectSite: (a: { origin: string }) => wallet.disconnectSite(a.origin),
  balance: () => wallet.balance(),
  getPending: (a: { id: string }) => wallet.getPending(a.id),
  decide: (a: { id: string; ok: boolean }) => decide(a.id, a.ok),
  /** The popup's own requests (send, deposit), approved in the popup. */
  rpc: (a: { method: string; params: unknown }) => wallet.handle(WALLET_ORIGIN, a.method, a.params, 'popup'),
};

// ---- listeners: registered synchronously at top level so Chrome can replay
// the event that woke the worker. -------------------------------------------

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  if (msg?.type !== 'internal') return false;
  if (!isExtensionPage(sender)) {
    // Never silently drop a call: say why it was refused.
    sendResponse({ error: `Refused an internal call from origin=${sender.origin ?? '-'} url=${sender.url ?? '-'} (expected ${extensionOrigin})` });
    return false;
  }
  const fn = internal[msg.call];
  if (!fn) {
    sendResponse({ error: `unknown call ${msg.call}` });
    return false;
  }
  (async () => {
    try {
      sendResponse({ result: await fn(msg.args ?? {}) });
    } catch (e) {
      sendResponse({ error: (e as Error).message });
    }
  })();
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (!sender || sender.id !== chrome.runtime.id) return port.disconnect();

  if (port.name === UI_PORT) {
    if (!isExtensionPage(sender)) return port.disconnect();
    // The toolbar popup's own requests die with it; approval windows are
    // handled by windows.onRemoved instead.
    const isToolbarPopup = !sender.tab;
    port.onMessage.addListener(() => {}); // heartbeats
    port.onDisconnect.addListener(() => {
      if (!isToolbarPopup) return;
      for (const p of wallet.listPending()) if (p.origin === WALLET_ORIGIN) decide(p.id, false);
    });
    return;
  }

  if (port.name === RPC_PORT) {
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
    if (!sender.tab || isExtensionPage(sender) || !origin || origin === 'null') {
      port.postMessage({
        type: 'response',
        response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'eCash Cat Wallet only serves http(s) pages.' } },
      });
      return port.disconnect();
    }
    let open = true;
    port.onDisconnect.addListener(() => (open = false));
    port.onMessage.addListener((m: ContentToBackground) => {
      if (m?.type !== 'rpc') return; // heartbeat
      (async () => {
        const response = await wallet.handle(origin, m.method, m.params, m.id);
        if (open) port.postMessage({ type: 'response', response });
      })();
    });
    return;
  }

  port.disconnect();
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, w] of waiters) if (w.windowId === windowId) decide(id, false);
});

// Auto-lock is checked on every key use; this alarm also catches an idle wallet.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create('autolock', { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'autolock') await wallet.state();
});
