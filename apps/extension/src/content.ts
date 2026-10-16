/**
 * Content script (isolated world): relays page requests to the background and
 * wallet events back to the page. Chrome attaches the tab's real origin to
 * each message, so the page cannot claim to be another site.
 */
import { FROM_CONTENT, FROM_PAGE, type BackgroundToContent } from './shared';

const target = window.location.origin === 'null' ? '*' : window.location.origin;
const toPage = (msg: object) => window.postMessage({ source: FROM_CONTENT, ...msg }, target);

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== FROM_PAGE || d.type !== 'request' || typeof d.id !== 'string') return;
  const reply = (response: unknown) => toPage({ type: 'response', id: d.id, response });
  try {
    chrome.runtime.sendMessage({ type: 'rpc', id: d.id, method: d.method, params: d.params }, (response) => {
      if (chrome.runtime.lastError || !response) {
        reply({
          jsonrpc: '2.0',
          id: d.id,
          error: { code: -32603, message: `eCash Cat Wallet did not answer: ${chrome.runtime.lastError?.message ?? 'no response'}. Try again.` },
        });
      } else reply(response);
    });
  } catch (e) {
    // The extension was reloaded or removed while this page stayed open.
    reply({ jsonrpc: '2.0', id: d.id, error: { code: -32603, message: 'eCash Cat Wallet was updated; reload this page.' } });
  }
});

chrome.runtime.onMessage.addListener((msg: BackgroundToContent) => {
  if (msg?.type === 'ecash-event' && msg.targets.includes(window.location.origin)) toPage({ type: 'event', event: msg.event });
});
