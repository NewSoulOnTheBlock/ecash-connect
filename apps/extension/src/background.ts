/**
 * Service worker: hosts WalletService and connects it to Chrome.
 *
 * - Content scripts send `rpc` messages; the origin comes from Chrome's
 *   `sender`, never from the page.
 * - The popup (an extension page) calls the internal API below.
 * - Approvals open popup.html#approve=<id> in its own window; closing it
 *   rejects. Requests the popup itself makes are shown in the popup.
 */
import type { WalletEvent } from '@ecash-connect/core';
import { newMnemonic } from './wallet/keys';
import { WALLET_ORIGIN, WalletService, type KV, type Pending } from './wallet/service';
import type { BackgroundToContent, ContentToBackground } from './shared';

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

interface Waiter {
  resolve: (ok: boolean) => void;
  windowId?: number;
}
const waiters = new Map<string, Waiter>();

async function ask(p: Pending): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const w: Waiter = { resolve };
    waiters.set(p.id, w);
    if (p.origin === WALLET_ORIGIN) {
      // The popup asked; it is open and shows the request itself.
      chrome.runtime.sendMessage({ type: 'pending', id: p.id }).catch(() => decide(p.id, false));
      return;
    }
    chrome.windows
      .create({ url: chrome.runtime.getURL(`popup.html#approve=${p.id}`), type: 'popup', width: 380, height: 640, focused: true })
      .then((win) => (w.windowId = win?.id))
      .catch(() => decide(p.id, false));
  });
}

function decide(id: string, ok: boolean) {
  const w = waiters.get(id);
  if (!w) return;
  waiters.delete(id);
  w.resolve(ok);
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, w] of waiters) if (w.windowId === windowId) decide(id, false);
});

// The toolbar popup holds this port open; when it closes, its own pending
// requests (send, deposit) are rejected instead of waiting forever.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup' || port.sender?.id !== chrome.runtime.id) return;
  port.onDisconnect.addListener(() => {
    for (const p of wallet.listPending()) if (p.origin === WALLET_ORIGIN) decide(p.id, false);
  });
});

async function emit(origin: string, event: WalletEvent) {
  const sites = Object.keys((await wallet.state()).sites);
  const targets = origin === '*' ? sites : [origin];
  if (!targets.length) return;
  const msg: BackgroundToContent = { type: 'ecash-event', targets, event };
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}

const wallet = new WalletService({
  local: chromeKV(chrome.storage.local),
  session: chromeKV(chrome.storage.session),
  ask,
  emit: (origin, event) => void emit(origin, event),
});

/** What the popup may call. Content scripts never reach this. */
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
  getPending: (a: { id: string }) => wallet.getPending(a.id) ?? null,
  decide: (a: { id: string; ok: boolean }) => decide(a.id, a.ok),
  /** The popup's own requests (send, deposit), approved in the popup. */
  rpc: (a: { method: string; params: unknown }) => wallet.handle(WALLET_ORIGIN, a.method, a.params, 'popup'),
};

// Not `new URL(...).origin`: for chrome-extension: URLs that is the string
// "null" (WHATWG only computes origins for special schemes), while Chrome
// reports `sender.origin` as "chrome-extension://<id>".
const extensionBase = chrome.runtime.getURL('');
const extensionOrigin = extensionBase.replace(/\/$/, '');

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Judged by the sender's URL, not by `sender.tab`: an approval window is a
  // popup window, and the page in it counts as a tab. Content scripts always
  // report the web page's URL, so they can never pass this.
  const fromExtensionPage = sender.origin === extensionOrigin || (!sender.origin && !!sender.url?.startsWith(extensionBase));
  const senderOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);

  if (fromExtensionPage && msg?.type === 'internal') {
    const fn = internal[msg.call];
    if (!fn) {
      sendResponse({ error: `unknown call ${msg.call}` });
      return false;
    }
    Promise.resolve()
      .then(() => fn(msg.args ?? {}))
      .then((result) => sendResponse({ result }), (e) => sendResponse({ error: (e as Error).message }));
    return true;
  }

  if (sender.tab && !fromExtensionPage && msg?.type === 'rpc') {
    const m = msg as ContentToBackground;
    const origin = senderOrigin;
    if (!origin || origin === 'null') {
      sendResponse({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'eCash Cat Wallet only serves http(s) pages.' } });
      return false;
    }
    wallet.handle(origin, m.method, m.params, m.id).then(sendResponse);
    return true;
  }
  return false;
});

// Auto-lock is checked on every key use; this also catches an idle wallet.
chrome.alarms.create('autolock', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autolock') void wallet.state();
});
