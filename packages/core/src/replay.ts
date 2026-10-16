/**
 * Replay safety. ECX kept Bitcoin's sighash with no fork id, so a transaction
 * signed on ECX is valid on Bitcoin whenever every coin it spends also exists,
 * unspent, on Bitcoin. Anyone could rebroadcast it there and move the user's
 * BTC.
 *
 * A transaction is invalid on Bitcoin, and so safe, as soon as one input is
 *   - from a funding tx Bitcoin has never seen (`ecx-only`), or
 *   - already spent on Bitcoin, confirmed (`spent-on-bitcoin`).
 * Coins that are live on both chains are `shared`. A tx made only of shared
 * inputs is refused until the user mixes in an ECX-only coin (a "split").
 *
 * Deposits are always safe once a sidechain has a treasury: the CTIP comes
 * from a drivechain tx that only exists on ECX.
 */
import type { ReplayReport } from './methods';
import { EcashNetworkType, ECASH_NETWORKS } from './networks';
import { Esplora, type Fetch } from './esplora';

export type ReplayStatus = ReplayReport['inputs'][number]['status'];

export interface Outpoint {
  txid: string;
  vout: number;
}

/** Remembers results: an ECX-only coin stays ECX-only, a spent one stays spent. */
export class ReplayChecker {
  private readonly cache = new Map<string, ReplayStatus>();
  private readonly btc?: Esplora;

  constructor(
    readonly network: EcashNetworkType,
    opts: { bitcoinEsplora?: string; fetch?: Fetch } = {}
  ) {
    const url = opts.bitcoinEsplora ?? ECASH_NETWORKS[network].replayEsplora;
    if (url) this.btc = new Esplora(url, opts.fetch);
  }

  /** Whether this network shares history with Bitcoin at all. */
  get applicable(): boolean {
    return !!this.btc;
  }

  async status(o: Outpoint): Promise<ReplayStatus> {
    if (!this.btc) return 'ecx-only';
    const key = `${o.txid}:${o.vout}`;
    const hit = this.cache.get(key);
    if (hit && hit !== 'shared') return hit;
    let s: ReplayStatus;
    if (!(await this.btc.hasTx(o.txid))) s = 'ecx-only';
    else {
      const spend = await this.btc.outspend(o.txid, o.vout);
      s = spend.spent && spend.status?.confirmed ? 'spent-on-bitcoin' : 'shared';
    }
    this.cache.set(key, s);
    return s;
  }

  async check(inputs: Outpoint[]): Promise<ReplayReport> {
    if (!this.btc) {
      return { safe: true, applicable: false, inputs: inputs.map((i) => ({ ...i, status: 'ecx-only' as const })) };
    }
    const statuses = await Promise.all(inputs.map((i) => this.status(i)));
    const rows = inputs.map((i, n) => ({ txid: i.txid, vout: i.vout, status: statuses[n]! }));
    return { safe: rows.some((r) => r.status !== 'shared'), applicable: true, inputs: rows };
  }
}
