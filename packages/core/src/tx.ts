/**
 * Transaction building for single-key p2wpkh wallets: plain transfers and
 * BIP300 deposits, with coin selection that respects replay safety.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as btc from '@scure/btc-signer';
import { type Ctip, depositOutputs, parseTreasuryScript } from './drivechain';
import { RpcError, RpcErrorCode } from './errors';
import type { BtcSignerNetwork } from './networks';
import type { ReplayStatus } from './replay';

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  confirmed: boolean;
  /** From ReplayChecker; omitted where replay does not apply. */
  replay?: ReplayStatus;
}

export interface Wallet {
  network: BtcSignerNetwork;
  /** p2wpkh address the coins sit at; also receives change. */
  address: string;
  publicKey: Uint8Array;
}

/** p2wpkh input: 41 vB of outpoint/sequence/empty scriptSig plus ~27 vB of witness. */
const P2WPKH_INPUT_VB = 68;
/** The CTIP input: outpoint, empty scriptSig, sequence; no witness. */
const BARE_INPUT_VB = 41;
/** version, locktime, counts, plus the segwit marker and flag. */
const TX_OVERHEAD_VB = 11;
const DUST = 330n;

const outputVb = (script: Uint8Array) => 8 + (script.length < 0xfd ? 1 : 3) + script.length;

interface Planned {
  script: Uint8Array;
  amount: bigint;
}

export interface BuiltTx {
  tx: btc.Transaction;
  fee: bigint;
  /** The wallet's own coins this spends. */
  spent: Utxo[];
  vsize: number;
}

/**
 * Picks coins to cover `outputs` plus fee. When replay applies (any utxo
 * carries a `replay` status) and no fixed input already makes the tx
 * ECX-only, the smallest non-shared coin goes in first; with none available,
 * this refuses rather than build a tx Bitcoin would accept too.
 */
function select(opts: {
  utxos: Utxo[];
  outputs: Planned[];
  feeRate: number;
  fixedVb: number;
  fixedValue: bigint;
  fixedIsReplaySafe: boolean;
  changeScript: Uint8Array;
}) {
  const need = opts.outputs.reduce((s, o) => s + o.amount, 0n);
  const outVb = opts.outputs.reduce((s, o) => s + outputVb(o.script), 0);
  const changeVb = outputVb(opts.changeScript);
  const replayApplies = opts.utxos.some((u) => u.replay !== undefined);

  const pool = [...opts.utxos].sort((a, b) =>
    a.confirmed !== b.confirmed ? (a.confirmed ? -1 : 1) : a.value > b.value ? -1 : a.value < b.value ? 1 : 0
  );
  const chosen: Utxo[] = [];
  if (replayApplies && !opts.fixedIsReplaySafe) {
    const safe = pool.filter((u) => u.replay && u.replay !== 'shared').sort((a, b) => (a.value < b.value ? -1 : 1));
    if (!safe.length) {
      throw new RpcError(
        RpcErrorCode.REPLAY_UNSAFE,
        'Every coin in this wallet also exists on Bitcoin, so this transaction could be replayed there and spend your BTC. Receive a small amount of ECX that was sent on eCash after the fork, then try again: the wallet will mix it in.'
      );
    }
    chosen.push(safe[0]!);
  }
  for (const u of pool) {
    const value = opts.fixedValue + chosen.reduce((s, c) => s + c.value, 0n);
    const vb = TX_OVERHEAD_VB + opts.fixedVb + chosen.length * P2WPKH_INPUT_VB + outVb;
    const feeNoChange = BigInt(Math.ceil(vb * opts.feeRate));
    if (value >= need + feeNoChange) break;
    if (!chosen.includes(u)) chosen.push(u);
  }
  const value = opts.fixedValue + chosen.reduce((s, c) => s + c.value, 0n);
  const vbNoChange = TX_OVERHEAD_VB + opts.fixedVb + chosen.length * P2WPKH_INPUT_VB + outVb;
  const feeNoChange = BigInt(Math.ceil(vbNoChange * opts.feeRate));
  if (value < need + feeNoChange) {
    throw new RpcError(
      RpcErrorCode.INSUFFICIENT_FUNDS,
      `Not enough ECX: need ${need + feeNoChange} sats including fee, have ${opts.fixedValue + opts.utxos.reduce((s, u) => s + u.value, 0n)}.`
    );
  }
  const feeWithChange = BigInt(Math.ceil((vbNoChange + changeVb) * opts.feeRate));
  const change = value - need - feeWithChange;
  if (change >= DUST) return { chosen, change, fee: feeWithChange, vsize: vbNoChange + changeVb };
  return { chosen, change: 0n, fee: value - need, vsize: vbNoChange };
}

function newTx() {
  return new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, lowR: true });
}

function addOwnInputs(tx: btc.Transaction, w: Wallet, coins: Utxo[]) {
  const script = btc.p2wpkh(w.publicKey, w.network).script;
  for (const c of coins) tx.addInput({ txid: c.txid, index: c.vout, witnessUtxo: { script, amount: c.value } });
}

export function buildTransfer(opts: {
  wallet: Wallet;
  utxos: Utxo[];
  recipients: { address: string; amount: bigint }[];
  feeRate: number;
}): BuiltTx {
  const { wallet: w } = opts;
  const decode = btc.Address(w.network);
  const outputs = opts.recipients.map((r) => {
    if (r.amount < DUST) throw new RpcError(RpcErrorCode.INVALID_PARAMS, `amount ${r.amount} is below the ${DUST}-sat dust limit`);
    let script: Uint8Array;
    try {
      script = btc.OutScript.encode(decode.decode(r.address));
    } catch {
      throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${r.address} is not a valid address on this network`);
    }
    return { script, amount: r.amount };
  });
  const changeScript = btc.p2wpkh(w.publicKey, w.network).script;
  const plan = select({ utxos: opts.utxos, outputs, feeRate: opts.feeRate, fixedVb: 0, fixedValue: 0n, fixedIsReplaySafe: false, changeScript });
  const tx = newTx();
  addOwnInputs(tx, w, plan.chosen);
  for (const o of outputs) tx.addOutput(o);
  if (plan.change > 0n) tx.addOutput({ script: changeScript, amount: plan.change });
  return { tx, fee: plan.fee, spent: plan.chosen, vsize: plan.vsize };
}

/**
 * A BIP300 deposit (M5). `ctip` is the slot's treasury as the enforcer reports
 * it and `ctipTxHex` its funding tx (the PSBT carries it as non_witness_utxo,
 * as the enforcer's own wallet does). With no ctip this is the slot's first
 * deposit and creates the treasury.
 */
export function buildDeposit(opts: {
  wallet: Wallet;
  utxos: Utxo[];
  slot: number;
  sidechainAddress: string;
  amount: bigint;
  ctip: Ctip | null;
  ctipTxHex?: string;
  feeRate: number;
  opDrivechain?: number;
}): BuiltTx & { treasuryValue: bigint } {
  const { wallet: w, ctip } = opts;
  if (ctip && !opts.ctipTxHex) throw new Error('ctipTxHex is required when the slot has a treasury');
  let outs;
  try {
    outs = depositOutputs({
      slot: opts.slot,
      ctipValue: ctip?.value ?? 0n,
      amount: opts.amount,
      sidechainAddress: opts.sidechainAddress,
      opDrivechain: opts.opDrivechain,
    });
  } catch (e) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, (e as Error).message);
  }
  const changeScript = btc.p2wpkh(w.publicKey, w.network).script;
  // The treasury output re-locks the old ctip value, which the ctip input brings in.
  const plan = select({
    utxos: opts.utxos.filter((u) => !(ctip && u.txid === ctip.txid && u.vout === ctip.vout)),
    outputs: [outs.treasury, outs.address],
    feeRate: opts.feeRate,
    fixedVb: ctip ? BARE_INPUT_VB : 0,
    fixedValue: ctip?.value ?? 0n,
    // The ctip's funding tx is a drivechain tx: it only exists on ECX.
    fixedIsReplaySafe: !!ctip,
    changeScript,
  });
  const tx = newTx();
  if (ctip) {
    tx.addInput({
      txid: ctip.txid,
      index: ctip.vout,
      nonWitnessUtxo: hexToBytes(opts.ctipTxHex!),
      finalScriptSig: new Uint8Array(0),
    });
  }
  addOwnInputs(tx, w, plan.chosen);
  // BIP300: the OP_RETURN address must directly follow the treasury output.
  tx.addOutput(outs.treasury);
  tx.addOutput(outs.address);
  if (plan.change > 0n) tx.addOutput({ script: changeScript, amount: plan.change });
  return { tx, fee: plan.fee, spent: plan.chosen, vsize: plan.vsize, treasuryValue: outs.treasury.amount };
}

/** Inputs of a PSBT as outpoints, for ReplayChecker. */
export function psbtOutpoints(tx: btc.Transaction) {
  const out: { txid: string; vout: number }[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    out.push({ txid: bytesToHex(inp.txid!), vout: inp.index! });
  }
  return out;
}

/** The scriptPubKey an input spends, from its witness or non-witness utxo. */
function prevScript(tx: btc.Transaction, idx: number): Uint8Array | undefined {
  const inp = tx.getInput(idx);
  if (inp.witnessUtxo) return inp.witnessUtxo.script;
  if (inp.nonWitnessUtxo) return inp.nonWitnessUtxo.outputs[inp.index!]?.script;
  return undefined;
}

/** Whether input `idx` spends a BIP300 treasury, which takes an empty scriptSig. */
export function isTreasuryInput(tx: btc.Transaction, idx: number, opDrivechain?: number): boolean {
  const script = prevScript(tx, idx);
  return !!script && parseTreasuryScript(script, opDrivechain) !== undefined;
}

/**
 * Raw transaction bytes once every input is final. btc-signer has no notion
 * of an input finalized with an empty scriptSig, which is exactly what a
 * treasury (CTIP) input is, so those are let through and every other input
 * must be finalized.
 */
export function extractTx(tx: btc.Transaction, opDrivechain?: number): Uint8Array {
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const final = !!inp.finalScriptSig?.length || !!inp.finalScriptWitness?.length;
    if (!final && !isTreasuryInput(tx, i, opDrivechain)) throw new Error(`input ${i} is not signed`);
  }
  return tx.toBytes(true, true);
}
