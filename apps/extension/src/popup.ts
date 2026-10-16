/**
 * The wallet popup: onboarding, unlock, home (balance, send, receive,
 * deposit), settings, and approvals. Approvals open as popup.html#approve=<id>
 * in their own window for dapp requests, and inline for the popup's own
 * send/deposit.
 */
import { EcashNetworkType, type SidechainInfo } from '@ecash-connect/core';
import type { Pending, WalletState } from './wallet/service';

// ---- plumbing ----------------------------------------------------------------

async function call<T = unknown>(name: string, args?: unknown): Promise<T> {
  const r = await chrome.runtime.sendMessage({ type: 'internal', call: name, args });
  if (!r) throw new Error('The wallet did not answer. Try again.');
  if (r.error) throw new Error(r.error);
  return r.result as T;
}

type RpcResponse = { result?: any; error?: { code: number; message: string } };
const rpc = (method: string, params: unknown) => call<RpcResponse>('rpc', { method, params });

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const app = document.getElementById('app')!;
const netSelect = document.getElementById('network') as HTMLSelectElement;
const show = (...nodes: Child[]) => app.replaceChildren(...(nodes.filter(Boolean) as Node[]));
const msg = (text = '', kind: '' | 'err' | 'ok' = '') => h('div', { class: `msg ${kind}` }, text);

function setMsg(el: HTMLElement, text: string, kind: '' | 'err' | 'ok' = '') {
  el.className = `msg ${kind}`;
  el.textContent = text;
}

/** Runs an action with its button disabled and errors shown in `out`. */
async function busy(btn: HTMLButtonElement, out: HTMLElement, fn: () => Promise<void>) {
  btn.disabled = true;
  setMsg(out, '');
  try {
    await fn();
  } catch (e) {
    setMsg(out, (e as Error).message, 'err');
  } finally {
    btn.disabled = false;
  }
}

const SATS = 100_000_000n;
function toSats(ecx: string): bigint {
  const s = ecx.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(s)) throw new Error('Enter an amount in ECX, up to 8 decimals.');
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * SATS + BigInt(f.padEnd(8, '0'));
}
function fmt(sats: string | bigint): string {
  const v = BigInt(sats);
  const frac = (v % SATS).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / SATS}${frac ? '.' + frac : ''}`;
}

async function copy(text: string, btn: HTMLButtonElement) {
  await navigator.clipboard.writeText(text);
  const was = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = was), 1200);
}

/** Pending-request notices for the popup's own send/deposit. */
let onPending: ((id: string) => void) | null = null;
chrome.runtime.onMessage.addListener((m: any) => {
  if (m?.type === 'pending' && onPending) onPending(m.id);
});

// ---- views -----------------------------------------------------------------

async function main() {
  const st = await call<WalletState>('state');
  renderNetwork(st);
  if (!st.initialized) return welcome();
  if (!st.unlocked) return unlock();
  return home(st);
}

function renderNetwork(st: WalletState) {
  netSelect.hidden = !st.initialized;
  netSelect.replaceChildren(...Object.values(EcashNetworkType).map((n) => h('option', { value: n, selected: n === st.network }, n === 'Regtest' ? 'Devnet' : n)));
  netSelect.onchange = async () => {
    await call('setNetwork', { network: netSelect.value });
    main();
  };
}

function welcome() {
  show(
    h('h1', {}, 'Your eCash wallet'),
    h('p', {}, 'Hold ECX, approve what apps ask, and move ECX into sidechains.'),
    h('button', { class: 'primary', onclick: () => createWallet() }, 'Create a new wallet'),
    h('button', { onclick: () => importWallet() }, 'Import a recovery phrase')
  );
}

function passwordFields() {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, placeholder: 'At least 8 characters' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' });
  const read = () => {
    if (pw.value.length < 8) throw new Error('Use a password of at least 8 characters.');
    if (pw.value !== pw2.value) throw new Error('The passwords do not match.');
    return pw.value;
  };
  return { nodes: [h('label', {}, 'Password (unlocks this browser)', pw), h('label', {}, 'Confirm password', pw2)], read };
}

async function createWallet() {
  const words = await call<string>('newMnemonic');
  const saved = h('input', { type: 'checkbox', style: 'width:auto' });
  const pw = passwordFields();
  const out = msg();
  const go = h('button', { class: 'primary' }, 'Create wallet');
  go.onclick = () =>
    busy(go, out, async () => {
      if (!saved.checked) throw new Error('Write the 12 words down first, then tick the box.');
      await call('setup', { mnemonic: words, password: pw.read() });
      main();
    });
  show(
    h('button', { class: 'link back', onclick: welcome }, '← Back'),
    h('h1', {}, 'Your recovery phrase'),
    h('p', {}, 'These 12 words are the wallet. Anyone with them can take your ECX, and without them a lost device means lost ECX. Write them on paper.'),
    h('div', { class: 'card words' }, ...words.split(' ').map((w) => h('span', {}, w))),
    h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--ink)' }, saved, 'I wrote these 12 words down'),
    ...pw.nodes,
    go,
    out
  );
}

function importWallet() {
  const words = h('textarea', { placeholder: 'twelve or twenty-four words', spellcheck: 'false', autocomplete: 'off' });
  const pw = passwordFields();
  const out = msg();
  const go = h('button', { class: 'primary' }, 'Import');
  go.onclick = () =>
    busy(go, out, async () => {
      await call('setup', { mnemonic: words.value, password: pw.read() });
      main();
    });
  show(
    h('button', { class: 'link back', onclick: welcome }, '← Back'),
    h('h1', {}, 'Import a wallet'),
    h('p', {}, 'Mainnet uses the same derivation as Bitcoin wallets (BIP84), so a Bitcoin seed finds its ECX.'),
    h('label', {}, 'Recovery phrase', words),
    ...pw.nodes,
    go,
    out
  );
}

function unlock(after?: () => void) {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', autofocus: true });
  const out = msg();
  const go = h('button', { class: 'primary', type: 'submit' }, 'Unlock');
  const form = h('form', { class: 'card' }, h('label', {}, 'Password', pw), go, out);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(go, out, async () => {
      if (!(await call<boolean>('unlock', { password: pw.value }))) throw new Error('Wrong password.');
      after ? after() : main();
    });
  };
  show(h('h1', {}, 'Welcome back'), form);
  pw.focus();
}

async function home(st: WalletState) {
  const bal = h('div', { class: 'balance' }, '…');
  const pend = h('div', { class: 'pending' });
  const balMsg = msg();
  const addr = st.account!.address;
  const copyBtn = h('button', {}, 'Copy address');
  copyBtn.onclick = () => copy(addr, copyBtn);
  const sites = Object.keys(st.sites);
  show(
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'addr' }, addr),
      bal,
      pend,
      balMsg,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => sendView() }, 'Send'), h('button', { onclick: () => depositView() }, 'Deposit'), copyBtn)
    ),
    h('h2', {}, 'Connected sites'),
    sites.length
      ? h(
          'div',
          { class: 'sites' },
          ...sites.map((o) =>
            h('div', { class: 'site' }, h('span', { title: o }, o), h('button', { onclick: async () => (await call('disconnectSite', { origin: o }), main()) }, 'Disconnect'))
          )
        )
      : h('p', {}, 'None yet. Apps ask to connect the first time.'),
    h('div', { class: 'row' }, h('button', { onclick: () => settingsView(st) }, 'Settings'), h('button', { onclick: async () => (await call('lock'), main()) }, 'Lock'))
  );
  try {
    const b = await call<{ confirmed: string; unconfirmed: string }>('balance');
    bal.replaceChildren(fmt(b.confirmed), ' ', h('small', {}, 'ECX'));
    pend.textContent = BigInt(b.unconfirmed) ? `${BigInt(b.unconfirmed) > 0n ? '+' : ''}${fmt(b.unconfirmed)} ECX pending` : '';
  } catch (e) {
    bal.textContent = '-';
    setMsg(balMsg, (e as Error).message, 'err');
  }
}

/** Sends an rpc from the popup and shows its approval inline when it arrives. */
async function runOwnRequest(method: string, params: unknown, done: (result: any) => void, out: HTMLElement) {
  onPending = (id) => approvalView(id, false);
  try {
    const r = await rpc(method, params);
    onPending = null;
    if (r.error) {
      if (r.error.code === -32000) return main();
      show(h('button', { class: 'link back', onclick: main }, '← Home'), h('div', { class: 'blocked' }, r.error.message));
      return;
    }
    done(r.result);
  } catch (e) {
    onPending = null;
    setMsg(out, (e as Error).message, 'err');
  }
}

function sentView(title: string, txid: string) {
  const c = h('button', {}, 'Copy txid');
  c.onclick = () => copy(txid, c);
  show(h('h1', {}, title), h('p', {}, 'Broadcast. It confirms with the next eCash block.'), h('div', { class: 'card tx' }, txid), c, h('button', { class: 'primary', onclick: main }, 'Done'));
}

function sendView() {
  const to = h('input', { placeholder: 'bc1q… / bcrt1q…', spellcheck: 'false', autocomplete: 'off' });
  const amount = h('input', { inputmode: 'decimal', placeholder: '0.001' });
  const fee = h('input', { inputmode: 'numeric', placeholder: 'auto' });
  const out = msg();
  const go = h('button', { class: 'primary', type: 'submit' }, 'Review');
  const form = h('form', { class: 'card' }, h('label', {}, 'To', to), h('label', {}, 'Amount (ECX)', amount), h('label', {}, 'Fee rate (sat/vB)', fee), go, out);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(go, out, async () => {
      const params: any = { recipients: [{ address: to.value.trim(), amount: Number(toSats(amount.value)) }] };
      if (fee.value.trim()) params.feeRate = Number(fee.value);
      await runOwnRequest('sendTransfer', params, (r) => sentView('Sent', r.txid), out);
    });
  };
  show(h('button', { class: 'link back', onclick: main }, '← Home'), h('h1', {}, 'Send ECX'), form);
}

async function depositView() {
  const out = msg('Loading sidechains…');
  show(h('button', { class: 'link back', onclick: main }, '← Home'), h('h1', {}, 'Deposit to a sidechain'), out);
  const r = await rpc('drivechain_getSidechains', null);
  if (r.error) return setMsg(out, r.error.message, 'err');
  const chains = r.result as SidechainInfo[];
  if (!chains.length) return setMsg(out, 'No sidechains are active on this network yet.');
  const slot = h('select', {}, ...chains.map((c) => h('option', { value: c.slot }, `${c.title} (slot ${c.slot})`)));
  const addr = h('input', { placeholder: 's77_… or the bare sidechain address', spellcheck: 'false', autocomplete: 'off' });
  const amount = h('input', { inputmode: 'decimal', placeholder: '0.1' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Review');
  const form = h(
    'form',
    { class: 'card' },
    h('label', {}, 'Sidechain', slot),
    h('label', {}, 'Your address on the sidechain', addr),
    h('label', {}, 'Amount (ECX)', amount),
    go,
    out
  );
  setMsg(out, 'Copy the deposit address from the sidechain wallet. A mistyped address is caught here; a wrong but valid one cannot be recovered.');
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(go, out, async () => {
      await runOwnRequest(
        'drivechain_deposit',
        { slot: Number(slot.value), sidechainAddress: addr.value.trim(), amount: Number(toSats(amount.value)) },
        (res) => sentView('Deposit sent', res.txid),
        out
      );
    });
  };
  show(h('button', { class: 'link back', onclick: main }, '← Home'), h('h1', {}, 'Deposit to a sidechain'), form);
}

function settingsView(st: WalletState) {
  const esplora = h('input', { value: st.endpoints?.esplora ?? '', placeholder: 'https://…/api', spellcheck: 'false' });
  const enforcer = h('input', { value: st.endpoints?.enforcer ?? '', placeholder: 'http://127.0.0.1:50051 (for deposits)', spellcheck: 'false' });
  const out = msg();
  const save = h('button', { class: 'primary' }, 'Save');
  save.onclick = () =>
    busy(save, out, async () => {
      const urls = [esplora.value.trim(), enforcer.value.trim()].filter(Boolean);
      for (const u of urls) if (!/^https?:\/\//.test(u)) throw new Error(`${u} must start with http:// or https://`);
      const origins = urls.map((u) => new URL(u).origin + '/*');
      if (origins.length && !(await chrome.permissions.request({ origins }))) throw new Error('The wallet needs permission to reach those servers.');
      await call('setEndpoints', { network: st.network, endpoints: esplora.value.trim() ? { esplora: esplora.value, enforcer: enforcer.value } : null });
      setMsg(out, 'Saved.', 'ok');
    });
  const revealPw = h('input', { type: 'password', autocomplete: 'current-password' });
  const revealOut = msg();
  const reveal = h('button', { class: 'danger' }, 'Show recovery phrase');
  reveal.onclick = () =>
    busy(reveal, revealOut, async () => {
      const w = await call<string | null>('reveal', { password: revealPw.value });
      if (!w) throw new Error('Wrong password.');
      revealOut.replaceWith(h('div', { class: 'card words' }, ...w.split(' ').map((x) => h('span', {}, x))));
    });
  show(
    h('button', { class: 'link back', onclick: main }, '← Home'),
    h('h1', {}, 'Settings'),
    h('h2', {}, `${st.network === 'Regtest' ? 'Devnet' : st.network} servers`),
    h('div', { class: 'card' }, h('label', {}, 'ECX indexer (Esplora API)', esplora), h('label', {}, 'Drivechain enforcer', enforcer), save, out),
    h('h2', {}, 'Recovery phrase'),
    h('div', { class: 'card' }, h('label', {}, 'Password', revealPw), reveal, revealOut)
  );
}

async function approvalView(id: string, standalone: boolean) {
  const p = await call<Pending | null>('getPending', { id });
  if (!p) {
    show(h('h1', {}, 'Nothing to approve'), h('p', {}, 'This request was answered or expired.'), standalone && h('button', { onclick: () => window.close() }, 'Close'));
    return;
  }
  const st = await call<WalletState>('state');
  const needsKey = p.kind !== 'connect';
  const pw = needsKey && !st.unlocked ? h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' }) : null;
  const out = msg();
  const finish = async (ok: boolean) => {
    await call('decide', { id, ok });
    if (standalone) window.close();
    else show(h('p', {}, ok ? 'Working…' : 'Rejected.'));
  };
  const approve = h('button', { class: 'primary', disabled: !!p.blocked }, p.kind === 'connect' ? 'Connect' : p.kind === 'signMessage' ? 'Sign' : 'Approve');
  approve.onclick = () =>
    busy(approve, out, async () => {
      if (pw && !(await call<boolean>('unlock', { password: pw.value }))) throw new Error('Wrong password.');
      await finish(true);
    });
  const reject = h('button', {}, 'Reject');
  reject.onclick = () => finish(false);
  show(
    h('h1', {}, p.title),
    p.origin !== 'ecash-cat-wallet' && h('div', { class: 'addr' }, p.origin),
    h('dl', { class: 'card kv' }, ...p.rows.map((r) => h('div', {}, h('dt', {}, r.label), h('dd', { class: r.tone ?? '' }, r.value)))),
    p.note && h('div', { class: 'note' }, p.note),
    p.blocked && h('div', { class: 'blocked' }, p.blocked),
    pw && h('label', {}, 'Unlock to sign', pw),
    h('div', { class: 'row' }, reject, approve),
    out
  );
}

// ---- start -----------------------------------------------------------------------

const approveId = /^#approve=([\w-]+)$/.exec(location.hash)?.[1];
if (approveId) {
  document.body.classList.add('window');
  netSelect.hidden = true;
  approvalView(approveId, true).catch((e) => show(h('div', { class: 'blocked' }, (e as Error).message), h('button', { onclick: () => window.close() }, 'Close')));
} else {
  chrome.runtime.connect({ name: 'popup' });
  main().catch((e) => show(h('div', { class: 'blocked' }, (e as Error).message)));
}
