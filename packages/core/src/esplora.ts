/** A small Esplora REST client (mempool/electrs, Blockstream esplora, mempool.space). */

/** Any fetch-compatible function (browser, Bun, a test double). */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export interface EsploraOutspend {
  spent: boolean;
  txid?: string;
  status?: { confirmed: boolean };
}

export class EsploraError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export class Esplora {
  constructor(
    readonly base: string,
    private readonly f: Fetch = (input, init) => fetch(input, init)
  ) {
    this.base = base.replace(/\/$/, '');
  }

  private async get(path: string): Promise<Response> {
    const res = await this.f(this.base + path);
    if (!res.ok) throw new EsploraError(res.status, `GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async tipHeight(): Promise<number> {
    return Number(await (await this.get('/blocks/tip/height')).text());
  }

  async utxos(address: string): Promise<EsploraUtxo[]> {
    return (await this.get(`/address/${address}/utxo`)).json();
  }

  async txHex(txid: string): Promise<string> {
    return (await this.get(`/tx/${txid}/hex`)).text();
  }

  /** Whether the tx is known (mined or in the mempool). */
  async hasTx(txid: string): Promise<boolean> {
    try {
      await this.get(`/tx/${txid}/status`);
      return true;
    } catch (e) {
      if (e instanceof EsploraError && (e.status === 404 || e.status === 400)) return false;
      throw e;
    }
  }

  async outspend(txid: string, vout: number): Promise<EsploraOutspend> {
    return (await this.get(`/tx/${txid}/outspend/${vout}`)).json();
  }

  /** target blocks -> sat/vB. Empty on a quiet regtest. */
  async feeEstimates(): Promise<Record<string, number>> {
    try {
      return await (await this.get('/fee-estimates')).json();
    } catch {
      return {};
    }
  }

  async broadcast(hex: string): Promise<string> {
    const res = await this.f(this.base + '/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' } });
    const text = (await res.text()).trim();
    if (!res.ok) throw new EsploraError(res.status, `broadcast rejected: ${text.slice(0, 300)}`);
    return text;
  }
}

/** A fee rate for `targetBlocks`, falling back to `floor` (sat/vB). */
export async function pickFeeRate(esplora: Esplora, targetBlocks = 3, floor = 2): Promise<number> {
  const est = await esplora.feeEstimates();
  const keys = Object.keys(est)
    .map(Number)
    .filter((k) => k >= targetBlocks)
    .sort((a, b) => a - b);
  const rate = keys.length ? est[String(keys[0])]! : undefined;
  return Math.max(floor, Math.ceil(rate ?? floor));
}
