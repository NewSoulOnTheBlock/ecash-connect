/**
 * The wallet. Everything a dapp or the popup can ask for goes through here;
 * the extension supplies storage, the approval window and event delivery, and
 * tests drive the same class against a devnet.
 *
 * Request flow: validate params -> check the site is connected -> build a
 * preview (needs no key, so it works while locked) -> ask the user -> unlock
 * key -> sign -> broadcast.
 */
import { base64 } from '@scure/base';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import * as btc from '@scure/btc-signer';
import {
  AddressPurpose,
  AddressType,
  buildDeposit,
  buildTransfer,
  DEFAULT_ENDPOINTS,
  ECASH_NETWORKS,
  EcashNetworkType,
  Esplora,
  extractTx,
  getCtip,
  getSidechains,
  isMethod,
  isTreasuryInput,
  METHOD_NAMES,
  MessageSigningProtocols,
  normalizeSidechainAddress,
  parseParams,
  parseTreasuryScript,
  pickFeeRate,
  PUBLIC_METHODS,
  ReplayChecker,
  RpcError,
  RpcErrorCode,
  signMessage,
  treasuryScript,
  type Address,
  type BuiltTx,
  type EcashEndpoints,
  type Fetch,
  type Method,
  type ReplayReport,
  type RpcParams,
  type RpcResult,
  type SpecResponse,
  type Utxo,
  type WalletEvent,
} from '@ecash-connect/core';
import { deriveAccount, isValidMnemonic, normalizeMnemonic, publicPart, type PublicAccount } from './keys';
import { openVault, sealVault, type Vault } from './vault';

export const WALLET_ORIGIN = 'ecash-cat-wallet';
export const VERSION = '0.1.0';
const AUTO_LOCK_MS = 15 * 60_000;

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DetailRow {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'mono';
}

export interface Pending {
  id: string;
  origin: string;
  method: Method;
  kind: 'connect' | 'signMessage' | 'transaction';
  title: string;
  rows: DetailRow[];
  /** Shown above the buttons. */
  note?: string;
  /** When set, the request cannot be approved and this says why. */
  blocked?: string;
  createdAt: number;
}

export interface Deps {
  local: KV;
  session: KV;
  /** Shows a pending request and resolves with the user's decision. */
  ask(p: Pending): Promise<boolean>;
  /** Delivers a wallet event to one connected origin, or all of them ('*'). */
  emit(origin: string, event: WalletEvent): void;
  fetch?: Fetch;
  now?: () => number;
}

interface Settings {
  network: EcashNetworkType;
  endpoints: Partial<Record<EcashNetworkType, EcashEndpoints>>;
}

type Sites = Record<string, { connectedAt: number }>;
type Accounts = Partial<Record<EcashNetworkType, PublicAccount>>;

export interface WalletState {
  initialized: boolean;
  unlocked: boolean;
  network: EcashNetworkType;
  account?: PublicAccount;
  endpoints?: EcashEndpoints;
  sites: Sites;
}

const fail = (code: RpcErrorCode, message: string, data?: unknown): never => {
  throw new RpcError(code, message, data);
};

export function formatEcx(sats: bigint | number): string {
  const s = BigInt(sats);
  const neg = s < 0n;
  const a = neg ? -s : s;
  const whole = a / 100_000_000n;
  const frac = (a % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''} ECX`;
}

export class WalletService {
  private readonly pending = new Map<string, Pending>();
  private readonly checkers = new Map<EcashNetworkType, ReplayChecker>();
  private readonly f: Fetch;
  private readonly now: () => number;

  constructor(private readonly d: Deps) {
    this.f = d.fetch ?? ((input, init) => fetch(input, init));
    this.now = d.now ?? Date.now;
  }

  // ---- storage -------------------------------------------------------------

  private async settings(): Promise<Settings> {
    const s = await this.d.local.get<Settings>('settings');
    return s ?? { network: EcashNetworkType.Regtest, endpoints: {} };
  }

  private async endpoints(network?: EcashNetworkType): Promise<EcashEndpoints | undefined> {
    const s = await this.settings();
    const n = network ?? s.network;
    return s.endpoints[n] ?? DEFAULT_ENDPOINTS[n];
  }

  private async sites(): Promise<Sites> {
    return (await this.d.local.get<Sites>('sites')) ?? {};
  }

  private async account(): Promise<PublicAccount | undefined> {
    const accounts = (await this.d.local.get<Accounts>('accounts')) ?? {};
    return accounts[(await this.settings()).network];
  }

  /** The unlocked recovery phrase, honoring the auto-lock timer. */
  private async mnemonic(): Promise<string | undefined> {
    const m = await this.d.session.get<string>('mnemonic');
    if (!m) return undefined;
    const last = (await this.d.session.get<number>('lastActive')) ?? 0;
    if (this.now() - last > AUTO_LOCK_MS) {
      await this.lock();
      return undefined;
    }
    await this.d.session.set('lastActive', this.now());
    return m;
  }

  private async esplora(): Promise<Esplora> {
    const e = await this.endpoints();
    if (!e?.esplora) fail(RpcErrorCode.INTERNAL_ERROR, 'No ECX indexer is set for this network. Add one in the wallet settings.');
    return new Esplora(e!.esplora, this.f);
  }

  private async checker(): Promise<ReplayChecker> {
    const n = (await this.settings()).network;
    let c = this.checkers.get(n);
    if (!c) this.checkers.set(n, (c = new ReplayChecker(n, { fetch: this.f })));
    return c;
  }

  // ---- popup API -----------------------------------------------------------

  async state(): Promise<WalletState> {
    const s = await this.settings();
    return {
      initialized: !!(await this.d.local.get<Vault>('vault')),
      unlocked: !!(await this.mnemonic()),
      network: s.network,
      account: await this.account(),
      endpoints: await this.endpoints(),
      sites: await this.sites(),
    };
  }

  /** Creates or imports the wallet. Replaces any existing one. */
  async setup(mnemonic: string, password: string): Promise<void> {
    if (!isValidMnemonic(mnemonic)) fail(RpcErrorCode.INVALID_PARAMS, 'That recovery phrase is not valid.');
    if (password.length < 8) fail(RpcErrorCode.INVALID_PARAMS, 'Use a password of at least 8 characters.');
    const words = normalizeMnemonic(mnemonic);
    const accounts: Accounts = {};
    for (const n of Object.values(EcashNetworkType)) accounts[n] = publicPart(deriveAccount(words, n));
    // A new seed means new addresses: connected sites are told, then forgotten.
    if (await this.d.local.get('vault')) {
      this.d.emit('*', { type: 'disconnect' });
      await this.d.local.set('sites', {});
    }
    await this.d.local.set('vault', await sealVault(words, password));
    await this.d.local.set('accounts', accounts);
    await this.d.session.set('mnemonic', words);
    await this.d.session.set('lastActive', this.now());
  }

  async unlock(password: string): Promise<boolean> {
    const vault = await this.d.local.get<Vault>('vault');
    if (!vault) return false;
    const words = await openVault(vault, password);
    if (!words) return false;
    await this.d.session.set('mnemonic', words);
    await this.d.session.set('lastActive', this.now());
    return true;
  }

  async lock(): Promise<void> {
    await this.d.session.remove('mnemonic');
    await this.d.session.remove('lastActive');
  }

  async revealMnemonic(password: string): Promise<string | null> {
    const vault = await this.d.local.get<Vault>('vault');
    return vault ? openVault(vault, password) : null;
  }

  async setNetwork(network: EcashNetworkType): Promise<void> {
    if (!Object.values(EcashNetworkType).includes(network)) fail(RpcErrorCode.INVALID_PARAMS, 'unknown network');
    const s = await this.settings();
    if (s.network === network) return;
    await this.d.local.set('settings', { ...s, network });
    const account = await this.account();
    this.d.emit('*', { type: 'networkChange', ecash: { name: network }, addresses: account ? [this.address(account)] : undefined });
  }

  async setEndpoints(network: EcashNetworkType, endpoints: EcashEndpoints | null): Promise<void> {
    const s = await this.settings();
    const next = { ...s.endpoints };
    if (endpoints) next[network] = { esplora: endpoints.esplora.trim(), enforcer: endpoints.enforcer?.trim() || undefined };
    else delete next[network];
    await this.d.local.set('settings', { ...s, endpoints: next });
  }

  async disconnectSite(origin: string): Promise<void> {
    const sites = await this.sites();
    if (!sites[origin]) return;
    delete sites[origin];
    await this.d.local.set('sites', sites);
    this.d.emit(origin, { type: 'disconnect' });
  }

  async balance(): Promise<RpcResult<'getBalance'>> {
    const account = (await this.account()) ?? fail(RpcErrorCode.WALLET_LOCKED, 'Set up the wallet first.');
    const utxos = await (await this.esplora()).utxos(account.address);
    let confirmed = 0n;
    let unconfirmed = 0n;
    for (const u of utxos) (u.status.confirmed ? (confirmed += BigInt(u.value)) : (unconfirmed += BigInt(u.value)));
    return { confirmed: String(confirmed), unconfirmed: String(unconfirmed), total: String(confirmed + unconfirmed) };
  }

  getPending(id: string): Pending | undefined {
    return this.pending.get(id);
  }

  listPending(): Pending[] {
    return [...this.pending.values()];
  }

  // ---- dapp API ------------------------------------------------------------

  /** One JSON-RPC request from `origin`, answered as a JSON-RPC response. Never throws. */
  async handle(origin: string, method: unknown, params: unknown, id: string | number | null = null): Promise<SpecResponse> {
    try {
      if (!isMethod(method)) fail(RpcErrorCode.METHOD_NOT_FOUND, `Unknown method ${String(method)}`);
      const m = method as Method;
      const parsed = parseParams(m, params);
      if (!parsed.success) fail(RpcErrorCode.INVALID_PARAMS, parsed.issues.map((i) => i.message).join('; '));
      if (origin !== WALLET_ORIGIN && !PUBLIC_METHODS.includes(m) && !(await this.sites())[origin]) {
        fail(RpcErrorCode.ACCESS_DENIED, 'Connect to the wallet first (wallet_connect or getAddresses).');
      }
      const result = await this.dispatch(origin, m, parsed.output as RpcParams<Method>);
      return { jsonrpc: '2.0', id, result: result ?? null };
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(RpcErrorCode.INTERNAL_ERROR, (e as Error)?.message ?? String(e));
      return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, data: err.data } };
    }
  }

  private async dispatch(origin: string, method: Method, params: any): Promise<unknown> {
    switch (method) {
      case 'getInfo':
        return { version: VERSION, methods: METHOD_NAMES, supports: ['replay-guard', 'drivechain-deposit', 'bip322'] };
      case 'wallet_connect':
        return this.connect(origin, params ?? {});
      case 'getAddresses': {
        const acct = (await this.sites())[origin] ? await this.accountResult() : await this.connect(origin, { message: params.message });
        return { addresses: acct.addresses, network: acct.network };
      }
      case 'wallet_getAccount':
        return this.accountResult();
      case 'wallet_getNetwork':
        return { ecash: { name: (await this.settings()).network } };
      case 'wallet_getCurrentPermissions':
        return (await this.sites())[origin] ? [{ type: 'account', origin }] : [];
      case 'wallet_disconnect':
      case 'wallet_renouncePermissions':
        await this.disconnectSite(origin);
        return null;
      case 'getBalance':
        return this.balance();
      case 'signMessage':
        return this.signMessage(origin, params);
      case 'signPsbt':
        return this.signPsbt(origin, params);
      case 'sendTransfer':
        return this.sendTransfer(origin, params);
      case 'drivechain_getSidechains':
        return this.listSidechains();
      case 'drivechain_deposit':
        return this.deposit(origin, params);
      case 'ecash_checkReplay':
        return this.replayReport(this.decodePsbt(params.psbt));
    }
  }

  // ---- approvals ------------------------------------------------------------

  private async approve(p: Omit<Pending, 'id' | 'createdAt'>): Promise<void> {
    const pending: Pending = { ...p, id: crypto.randomUUID(), createdAt: this.now() };
    this.pending.set(pending.id, pending);
    let ok = false;
    try {
      ok = await this.d.ask(pending);
    } finally {
      this.pending.delete(pending.id);
    }
    if (!ok) fail(RpcErrorCode.USER_REJECTION, 'The user rejected the request.');
    if (pending.blocked) fail(RpcErrorCode.INVALID_REQUEST, pending.blocked);
  }

  /** Called after approval: the signing key, or an error if the user did not unlock. */
  private async privateKey(): Promise<Uint8Array> {
    const words = await this.mnemonic();
    if (!words) fail(RpcErrorCode.WALLET_LOCKED, 'The wallet is locked. Unlock it and try again.');
    return deriveAccount(words!, (await this.settings()).network).privateKey;
  }

  // ---- methods ---------------------------------------------------------------

  private address(a: PublicAccount): Address {
    return { address: a.address, publicKey: a.publicKey, purpose: AddressPurpose.Payment, addressType: AddressType.p2wpkh };
  }

  private async accountResult(): Promise<RpcResult<'wallet_connect'>> {
    const a = (await this.account()) ?? fail(RpcErrorCode.WALLET_LOCKED, 'Set up the wallet first.');
    return {
      id: a.publicKey,
      addresses: [this.address(a)],
      walletType: 'software',
      network: { ecash: { name: (await this.settings()).network } },
    };
  }

  private async connect(origin: string, params: NonNullable<RpcParams<'wallet_connect'>>) {
    const initialized = !!(await this.d.local.get('vault'));
    const network = (await this.settings()).network;
    const switching = params.network && params.network !== network ? params.network : undefined;
    const account = await this.account();
    if (origin !== WALLET_ORIGIN) {
      await this.approve({
        origin,
        method: 'wallet_connect',
        kind: 'connect',
        title: 'Connect to this site?',
        rows: [
          { label: 'Site', value: origin, tone: 'mono' },
          { label: 'It will see', value: 'Your address and balance' },
          ...(account && !switching ? [{ label: 'Address', value: account.address, tone: 'mono' as const }] : []),
          { label: 'Network', value: switching ? `${network} → ${switching}` : network, tone: switching ? 'warn' : undefined },
          ...(params.message ? [{ label: 'Message', value: params.message }] : []),
        ],
        note: 'It cannot move ECX without asking you each time.',
        blocked: initialized ? undefined : 'Set up the wallet first: open eCash Cat Wallet from the toolbar.',
      });
      if (switching) await this.setNetwork(switching);
      const sites = await this.sites();
      sites[origin] = { connectedAt: this.now() };
      await this.d.local.set('sites', sites);
    }
    return this.accountResult();
  }

  private async signMessage(origin: string, params: RpcParams<'signMessage'>) {
    const a = (await this.account())!;
    if (params.address !== a.address) fail(RpcErrorCode.INVALID_PARAMS, `${params.address} is not this wallet's address.`);
    const protocol = params.protocol ?? MessageSigningProtocols.BIP322;
    await this.approve({
      origin,
      method: 'signMessage',
      kind: 'signMessage',
      title: 'Sign this message?',
      rows: [
        { label: 'Site', value: origin, tone: 'mono' },
        { label: 'Message', value: params.message },
        { label: 'Address', value: a.address, tone: 'mono' },
        { label: 'Format', value: protocol === MessageSigningProtocols.BIP322 ? 'BIP322' : 'ECDSA (BIP137)' },
      ],
      note: 'Signing proves you own this address. It does not move any ECX.',
    });
    const network = ECASH_NETWORKS[(await this.settings()).network].address;
    return signMessage({ privateKey: await this.privateKey(), address: a.address, message: params.message, network, protocol });
  }

  /** The wallet's coins, each tagged with its replay status where replay applies. */
  private async utxos(): Promise<Utxo[]> {
    const a = (await this.account())!;
    const raw = await (await this.esplora()).utxos(a.address);
    const checker = await this.checker();
    const statuses = checker.applicable ? await Promise.all(raw.map((u) => checker.status(u))) : [];
    return raw.map((u, i) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      confirmed: u.status.confirmed,
      replay: checker.applicable ? statuses[i] : undefined,
    }));
  }

  private async feeRate(requested?: number): Promise<number> {
    return requested ?? (await pickFeeRate(await this.esplora()));
  }

  private async wallet() {
    const a = (await this.account())!;
    return { network: ECASH_NETWORKS[(await this.settings()).network].address, address: a.address, publicKey: hexToBytes(a.publicKey) };
  }

  /** Human rows for a transaction's outputs, fee and replay safety. */
  private async txRows(tx: btc.Transaction, opts: { fee?: bigint; replay?: ReplayReport; slotTitles?: Record<number, string> } = {}) {
    const a = (await this.account())!;
    const n = (await this.settings()).network;
    const net = ECASH_NETWORKS[n].address;
    const rows: DetailRow[] = [];
    let leaving = 0n;
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      const script = o.script!;
      const amount = o.amount ?? 0n;
      const slot = parseTreasuryScript(script, ECASH_NETWORKS[n].opDrivechain);
      if (slot !== undefined) {
        rows.push({ label: `Sidechain treasury, slot ${slot}`, value: formatEcx(amount) });
        continue;
      }
      if (script[0] === 0x6a) {
        const data = script.slice(script[1] === 0x4c ? 3 : 2);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
        rows.push({ label: 'Data (OP_RETURN)', value: /^[\x20-\x7e]+$/.test(text) ? text : bytesToHex(data), tone: 'mono' });
        continue;
      }
      let addr: string;
      try {
        addr = btc.Address(net).encode(btc.OutScript.decode(script));
      } catch {
        addr = `script ${bytesToHex(script)}`;
      }
      if (addr === a.address) rows.push({ label: 'Change (back to you)', value: formatEcx(amount) });
      else {
        leaving += amount;
        rows.push({ label: `To ${addr}`, value: formatEcx(amount), tone: 'mono' });
      }
    }
    if (opts.fee !== undefined) rows.push({ label: 'Network fee', value: formatEcx(opts.fee) });
    if (opts.replay?.applicable) {
      rows.push(
        opts.replay.safe
          ? { label: 'Replay on Bitcoin', value: 'Protected: this cannot be replayed on Bitcoin', tone: 'good' }
          : { label: 'Replay on Bitcoin', value: 'UNSAFE: every coin also exists on Bitcoin', tone: 'bad' }
      );
    }
    return { rows, leaving };
  }

  private replayBlock(report: ReplayReport): string | undefined {
    if (!report.applicable || report.safe) return undefined;
    return 'This transaction would also be valid on Bitcoin and could spend your BTC there. Receive some ECX sent on eCash after the fork, then try again; the wallet mixes it in to make the transaction eCash-only.';
  }

  private async broadcast(raw: Uint8Array): Promise<string> {
    return (await this.esplora()).broadcast(bytesToHex(raw));
  }

  private async replayReport(tx: btc.Transaction): Promise<ReplayReport> {
    const checker = await this.checker();
    const inputs = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      inputs.push({ txid: bytesToHex(inp.txid!), vout: inp.index! });
    }
    return checker.check(inputs);
  }

  private decodePsbt(psbt: string): btc.Transaction {
    try {
      return btc.Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true, lowR: true });
    } catch (e) {
      return fail(RpcErrorCode.INVALID_PARAMS, `Could not read the PSBT: ${(e as Error).message}`);
    }
  }

  private async signPsbt(origin: string, params: RpcParams<'signPsbt'>) {
    const a = (await this.account())!;
    const n = (await this.settings()).network;
    const tx = this.decodePsbt(params.psbt);
    const ownScript = btc.p2wpkh(hexToBytes(a.publicKey), ECASH_NETWORKS[n].address).script;
    const own: number[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const s = tx.getInput(i).witnessUtxo?.script;
      if (s && bytesToHex(s) === bytesToHex(ownScript)) own.push(i);
    }
    let toSign = own;
    if (params.signInputs) {
      toSign = [];
      for (const [addr, idxs] of Object.entries(params.signInputs)) {
        if (addr !== a.address) fail(RpcErrorCode.INVALID_PARAMS, `${addr} is not this wallet's address.`);
        for (const i of idxs) {
          if (!own.includes(i)) fail(RpcErrorCode.INVALID_PARAMS, `Input ${i} is not spendable by this wallet (needs a witnessUtxo at ${a.address}).`);
          toSign.push(i);
        }
      }
    }
    if (!toSign.length) fail(RpcErrorCode.INVALID_PARAMS, 'This PSBT has no inputs this wallet can sign.');
    const replay = await this.replayReport(tx);
    let fee: bigint | undefined;
    try {
      fee = tx.fee;
    } catch {
      fee = undefined;
    }
    const { rows } = await this.txRows(tx, { fee, replay });
    let ownIn = 0n;
    for (const i of toSign) ownIn += tx.getInput(i).witnessUtxo!.amount;
    await this.approve({
      origin,
      method: 'signPsbt',
      kind: 'transaction',
      title: params.broadcast ? 'Sign and send this transaction?' : 'Sign this transaction?',
      rows: [{ label: 'Site', value: origin, tone: 'mono' }, { label: `Spends from you (${toSign.length} input${toSign.length > 1 ? 's' : ''})`, value: formatEcx(ownIn) }, ...rows],
      blocked: this.replayBlock(replay),
    });
    const key = await this.privateKey();
    for (const i of toSign) {
      tx.signIdx(key, i, [btc.SigHash.ALL]);
      tx.finalizeIdx(i);
    }
    let txid: string | undefined;
    if (params.broadcast) txid = await this.broadcast(extractTx(tx, ECASH_NETWORKS[n].opDrivechain));
    return { psbt: base64.encode(tx.toPSBT()), txid, replay };
  }

  private async signAndSend(built: BuiltTx, broadcast = true) {
    const key = await this.privateKey();
    const n = (await this.settings()).network;
    for (let i = 0; i < built.tx.inputsLength; i++) {
      if (isTreasuryInput(built.tx, i, ECASH_NETWORKS[n].opDrivechain)) continue;
      built.tx.signIdx(key, i, [btc.SigHash.ALL]);
      built.tx.finalizeIdx(i);
    }
    const raw = extractTx(built.tx, ECASH_NETWORKS[n].opDrivechain);
    const hex = bytesToHex(raw);
    const txid = broadcast ? await this.broadcast(raw) : built.tx.id;
    return { txid, transaction: hex };
  }

  private async sendTransfer(origin: string, params: RpcParams<'sendTransfer'>) {
    const built = buildTransfer({
      wallet: await this.wallet(),
      utxos: await this.utxos(),
      recipients: params.recipients.map((r) => ({ address: r.address, amount: BigInt(r.amount) })),
      feeRate: await this.feeRate(params.feeRate),
    });
    const replay = await this.replayReport(built.tx);
    const { rows, leaving } = await this.txRows(built.tx, { fee: built.fee, replay });
    await this.approve({
      origin,
      method: 'sendTransfer',
      kind: 'transaction',
      title: `Send ${formatEcx(leaving)}?`,
      rows: [...(origin !== WALLET_ORIGIN ? [{ label: 'Site', value: origin, tone: 'mono' as const }] : []), ...rows, { label: 'Total', value: formatEcx(leaving + built.fee) }],
      blocked: this.replayBlock(replay),
    });
    return this.signAndSend(built, params.broadcast ?? true);
  }

  private async enforcer(): Promise<string> {
    const e = await this.endpoints();
    if (!e?.enforcer) fail(RpcErrorCode.INTERNAL_ERROR, 'No drivechain enforcer is set for this network. Add one in the wallet settings.');
    return e!.enforcer!;
  }

  private async listSidechains(): Promise<RpcResult<'drivechain_getSidechains'>> {
    const enforcer = await this.enforcer();
    const chains = await getSidechains(enforcer, this.f);
    return Promise.all(
      chains.map(async (c) => {
        const ctip = await getCtip(enforcer, c.slot, this.f);
        return { ...c, treasury: ctip ? { txid: ctip.txid, vout: ctip.vout, value: String(ctip.value) } : undefined };
      })
    );
  }

  private async deposit(origin: string, params: RpcParams<'drivechain_deposit'>) {
    const enforcer = await this.enforcer();
    const n = (await this.settings()).network;
    const op = ECASH_NETWORKS[n].opDrivechain;
    const chains = await getSidechains(enforcer, this.f);
    const chain = chains.find((c) => c.slot === params.slot);
    if (!chain) fail(RpcErrorCode.INVALID_PARAMS, `No active sidechain in slot ${params.slot}. Deposits to an inactive slot are not credited.`);
    let bare: string;
    try {
      bare = normalizeSidechainAddress(params.sidechainAddress, params.slot);
    } catch (e) {
      return fail(RpcErrorCode.INVALID_PARAMS, (e as Error).message);
    }
    const esplora = await this.esplora();
    const ctip = await getCtip(enforcer, params.slot, this.f);
    let ctipTxHex: string | undefined;
    if (ctip) {
      // The enforcer's view must match the chain: the ctip is unspent and is this slot's treasury.
      ctipTxHex = await esplora.txHex(ctip.txid);
      const prev = btc.Transaction.fromRaw(hexToBytes(ctipTxHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
      const out = prev.getOutput(ctip.vout);
      if (!out.script || bytesToHex(out.script) !== bytesToHex(treasuryScript(params.slot, op)) || out.amount !== ctip.value) {
        fail(RpcErrorCode.INTERNAL_ERROR, 'The enforcer reported a treasury output that does not match the chain. Not depositing.');
      }
      const spend = await esplora.outspend(ctip.txid, ctip.vout);
      if (spend.spent) fail(RpcErrorCode.INTERNAL_ERROR, 'The treasury was just spent by another deposit or withdrawal. Try again in a moment.');
    }
    const built = buildDeposit({
      wallet: await this.wallet(),
      utxos: await this.utxos(),
      slot: params.slot,
      sidechainAddress: bare!,
      amount: BigInt(params.amount),
      ctip,
      ctipTxHex,
      feeRate: await this.feeRate(params.feeRate),
      opDrivechain: op,
    });
    const replay = await this.replayReport(built.tx);
    const { rows } = await this.txRows(built.tx, { fee: built.fee, replay });
    await this.approve({
      origin,
      method: 'drivechain_deposit',
      kind: 'transaction',
      title: `Deposit ${formatEcx(BigInt(params.amount))} to ${chain!.title}?`,
      rows: [
        ...(origin !== WALLET_ORIGIN ? [{ label: 'Site', value: origin, tone: 'mono' as const }] : []),
        { label: 'Sidechain', value: `${chain!.title} (slot ${params.slot})` },
        { label: 'Credited to', value: bare!, tone: 'mono' },
        { label: 'You deposit', value: formatEcx(BigInt(params.amount)) },
        ...rows,
      ],
      note: 'The sidechain credits this after its next block is merge-mined. Withdrawing back to eCash needs miner votes and takes much longer.',
      blocked: this.replayBlock(replay),
    });
    const sent = await this.signAndSend(built);
    return { ...sent, treasuryValue: String(built.treasuryValue) };
  }
}
