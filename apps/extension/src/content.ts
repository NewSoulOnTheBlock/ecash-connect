/**
 * Content script (isolated world): relays page requests to the background and
 * wallet events back to the page. Chrome attaches the tab's real origin to the
 * connection, so the page cannot claim to be another site.
 *
 * Each request gets its own port. An open port keeps the service worker
 * alive while the user reads the approval window (a one-shot sendMessage does
 * not, and the worker would be stopped after ~30 s idle), and a heartbeat
 * covers Chrome versions that only count port traffic.
 */
import { FROM_CONTENT, FROM_PAGE, RPC_PORT, type BackgroundToContent } from './shared';

const HEARTBEAT_MS = 20_000;
const target = window.location.origin === 'null' ? '*' : window.location.origin;
const toPage = (msg: object) => window.postMessage({ source: FROM_CONTENT, ...msg }, target);
const rpcError = (id: string, message: string) => ({ jsonrpc: '2.0', id, error: { code: -32603, message } });

function relay(id: string, method: unknown, params: unknown) {
  const reply = (response: unknown) => toPage({ type: 'response', id, response });
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: RPC_PORT });
  } catch {
    // The extension was reloaded or removed while this page stayed open.
    reply(rpcError(id, 'eCash Cat Wallet was updated; reload this page.'));
    return;
  }
  let answered = false;
  const beat = setInterval(() => port.postMessage({ type: 'ping' }), HEARTBEAT_MS);
  port.onMessage.addListener((m: { type?: string; response?: unknown }) => {
    if (m?.type !== 'response') return;
    answered = true;
    clearInterval(beat);
    reply(m.response);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => {
    clearInterval(beat);
    if (!answered) reply(rpcError(id, 'eCash Cat Wallet stopped before answering. Try again.'));
  });
  port.postMessage({ type: 'rpc', id, method, params });
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== FROM_PAGE || d.type !== 'request' || typeof d.id !== 'string') return;
  relay(d.id, d.method, d.params);
});

chrome.runtime.onMessage.addListener((msg: BackgroundToContent) => {
  if (msg?.type === 'ecash-event' && msg.targets.includes(window.location.origin)) toPage({ type: 'event', event: msg.event });
});
