/**
 * Runs in the page's own JavaScript world (manifest `world: "MAIN"`). Defines
 * `window.EcashCatWallet.EcashProvider` and announces it in
 * `window.ecash_providers`, the registry eCash Connect dapps read.
 *
 * It holds nothing secret: every request is posted to the content script,
 * which forwards it to the extension. The page can forge messages to itself,
 * which is harmless; the extension learns the page's origin from Chrome,
 * never from these messages.
 */
import type { ListenerInfo, ProviderInfo, WalletEvent } from '@ecash-connect/core';
import { FROM_CONTENT, FROM_PAGE, PROVIDER_ID, WALLET_ICON, WALLET_NAME } from './shared';

type Resolve = (r: unknown) => void;

const waiting = new Map<string, Resolve>();
const listeners = new Map<string, Set<(e: WalletEvent) => void>>();
let seq = 0;
const target = window.location.origin === 'null' ? '*' : window.location.origin;

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== FROM_CONTENT) return;
  if (d.type === 'response') {
    const done = waiting.get(d.id);
    if (done) {
      waiting.delete(d.id);
      done(d.response);
    }
  } else if (d.type === 'event') {
    for (const cb of listeners.get(d.event?.type) ?? []) {
      try {
        cb(d.event);
      } catch (e) {
        console.error('eCash Cat Wallet listener threw', e);
      }
    }
  }
});

const provider = Object.freeze({
  request(method: string, params?: unknown): Promise<unknown> {
    const id = `${Date.now().toString(36)}-${++seq}`;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      window.postMessage({ source: FROM_PAGE, type: 'request', id, method, params: params ?? null }, target);
    });
  },
  addListener(info: ListenerInfo): () => void {
    let set = listeners.get(info.eventName);
    if (!set) listeners.set(info.eventName, (set = new Set()));
    const cb = info.cb as (e: WalletEvent) => void;
    set.add(cb);
    return () => set!.delete(cb);
  },
});

const info: ProviderInfo = { id: PROVIDER_ID, name: WALLET_NAME, icon: WALLET_ICON };

if (!('EcashCatWallet' in window)) {
  Object.defineProperty(window, 'EcashCatWallet', {
    value: Object.freeze({ EcashProvider: provider }),
    writable: false,
    configurable: false,
  });
  window.ecash_providers = window.ecash_providers ?? [];
  if (!window.ecash_providers.some((p) => p.id === info.id)) window.ecash_providers.push(info);
  window.dispatchEvent(new CustomEvent('ecash-connect:provider', { detail: info }));
}
