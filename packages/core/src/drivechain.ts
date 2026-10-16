/**
 * BIP300 deposits (M5) and peg lookups against bip300301_enforcer.
 *
 * A deposit spends the slot's current treasury UTXO (the CTIP) and recreates
 * it, holding the old value plus the deposit, at output i; output i+1 must be
 * OP_RETURN <sidechain address>. The treasury script is anyone-can-spend, so
 * the CTIP input needs no signature (empty scriptSig) and only the
 * depositor's own inputs are signed.
 *
 * Verified against bip300301_enforcer lib/messages.rs (create_m5_deposit_output,
 * OpDrivechain::parse) and lib/wallet/mod.rs (create_deposit_psbt).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { OP_DRIVECHAIN } from './networks';

const OP_PUSHBYTES_1 = 0x01;
const OP_TRUE = 0x51;
const OP_RETURN = 0x6a;

/** `OP_DRIVECHAIN OP_PUSHBYTES_1 <slot> OP_TRUE`. */
export function treasuryScript(slot: number, opDrivechain = OP_DRIVECHAIN): Uint8Array {
  assertSlot(slot);
  return Uint8Array.of(opDrivechain, OP_PUSHBYTES_1, slot, OP_TRUE);
}

/** The slot a treasury script belongs to, or undefined if it is not one. */
export function parseTreasuryScript(script: Uint8Array, opDrivechain = OP_DRIVECHAIN): number | undefined {
  if (script.length !== 4) return undefined;
  if (script[0] !== opDrivechain || script[1] !== OP_PUSHBYTES_1 || script[3] !== OP_TRUE) return undefined;
  return script[2];
}

/** `OP_RETURN <data>` with a minimal push. */
export function opReturnScript(data: Uint8Array): Uint8Array {
  if (data.length > 80) throw new Error('OP_RETURN data is over 80 bytes');
  const push = data.length <= 75 ? Uint8Array.of(data.length) : Uint8Array.of(0x4c, data.length);
  return Uint8Array.from([OP_RETURN, ...push, ...data]);
}

function assertSlot(slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new Error(`sidechain slot ${slot} is not 0-255`);
}

/**
 * The sidechain address to put in the deposit's OP_RETURN.
 *
 * Accepts the bare base58 address or the `s<slot>_<base58>_<checksum>` form
 * sidechain wallets display (`format_deposit_address`), checking its slot and
 * checksum. The sidechain parses the OP_RETURN as a base58 20-byte address
 * and credits the all-zero address when that fails, so anything else is
 * refused here rather than burned there.
 */
export function normalizeSidechainAddress(input: string, slot: number): string {
  const s = input.trim();
  let bare = s;
  const m = /^s(\d{1,3})_([1-9A-HJ-NP-Za-km-z]+)_([0-9a-f]{6})$/.exec(s);
  if (m) {
    const [, slotStr, addr, checksum] = m;
    if (Number(slotStr) !== slot) throw new Error(`this deposit address is for slot ${slotStr}, not slot ${slot}`);
    const prefix = `s${slotStr}_${addr}_`;
    if (bytesToHex(sha256(utf8ToBytes(prefix)).slice(0, 3)) !== checksum)
      throw new Error('deposit address checksum does not match; check for a typo');
    bare = addr!;
  } else if (s.startsWith('s') && s.includes('_')) {
    throw new Error('malformed deposit address; expected s<slot>_<address>_<checksum>');
  }
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(bare);
  } catch {
    throw new Error('sidechain address is not base58');
  }
  if (decoded.length !== 20) throw new Error(`sidechain address decodes to ${decoded.length} bytes, expected 20`);
  return bare;
}

/** sidechain wallets' display form: `s<slot>_<base58>_<sha256(prefix)[..3] hex>`. */
export function formatDepositAddress(bare: string, slot: number): string {
  const prefix = `s${slot}_${bare}_`;
  return prefix + bytesToHex(sha256(utf8ToBytes(prefix)).slice(0, 3));
}

export interface Ctip {
  txid: string;
  vout: number;
  value: bigint;
}

export interface DepositOutputs {
  treasury: { script: Uint8Array; amount: bigint };
  address: { script: Uint8Array; amount: bigint };
}

/** The two outputs of an M5, which must sit next to each other in this order. */
export function depositOutputs(opts: {
  slot: number;
  ctipValue: bigint;
  amount: bigint;
  sidechainAddress: string;
  opDrivechain?: number;
}): DepositOutputs {
  if (opts.amount <= 0n) throw new Error('deposit amount must be positive');
  const bare = normalizeSidechainAddress(opts.sidechainAddress, opts.slot);
  return {
    treasury: { script: treasuryScript(opts.slot, opts.opDrivechain), amount: opts.ctipValue + opts.amount },
    address: { script: opReturnScript(utf8ToBytes(bare)), amount: 0n },
  };
}

// ---- enforcer (Connect JSON over HTTP) ----------------------------------

import type { Fetch } from './esplora';

async function enforcerCall<T>(base: string, service: string, method: string, body: unknown, f: Fetch = fetch): Promise<T> {
  const res = await f(`${base.replace(/\/$/, '')}/cusf.mainchain.v1.${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`enforcer ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** The slot's treasury UTXO, or null before its first deposit. */
export async function getCtip(enforcer: string, slot: number, f?: Fetch): Promise<Ctip | null> {
  assertSlot(slot);
  const r = await enforcerCall<{ ctip?: { txid: { hex: string }; vout?: number; value?: string } }>(
    enforcer,
    'ValidatorService',
    'GetCtip',
    { sidechainNumber: slot },
    f
  );
  if (!r.ctip) return null;
  return { txid: r.ctip.txid.hex, vout: r.ctip.vout ?? 0, value: BigInt(r.ctip.value ?? '0') };
}

export interface ActiveSidechain {
  slot: number;
  title: string;
  description: string;
  activationHeight?: number;
}

/** Sidechains miners have activated (M2), with their M1 declarations. */
export async function getSidechains(enforcer: string, f?: Fetch): Promise<ActiveSidechain[]> {
  type Raw = {
    sidechainNumber?: number;
    activationHeight?: number;
    declaration?: { v0?: { title?: string; description?: string } };
    description?: { hex?: string };
  };
  const r = await enforcerCall<{ sidechains?: Raw[] }>(enforcer, 'ValidatorService', 'GetSidechains', {}, f);
  return (r.sidechains ?? []).map((s) => ({
    slot: s.sidechainNumber ?? 0,
    title: s.declaration?.v0?.title ?? `Slot ${s.sidechainNumber ?? 0}`,
    description: s.declaration?.v0?.description ?? '',
    activationHeight: s.activationHeight,
  }));
}

export { bytesToHex, hexToBytes };
