/**
 * Message signing for eCash, identical to Bitcoin's because ECX kept the
 * "Bitcoin Signed Message:\n" magic (src/common/signmessage.cpp).
 *
 * - BIP322 "simple" for p2wpkh (the default, as in sats-connect for segwit).
 * - ECDSA, i.e. BIP137 compact signatures (header 39-42 for p2wpkh).
 *
 * Signing is for wallets; verification is for dapps and servers checking a
 * user owns an address.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { MessageSigningProtocols } from './methods';
import type { BtcSignerNetwork } from './networks';

const MESSAGE_MAGIC = 'Bitcoin Signed Message:\n';
const sha256d = (b: Uint8Array) => sha256(sha256(b));
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}
const varBytes = (b: Uint8Array) => concatBytes(varint(b.length), b);

/** BIP137 / Bitcoin Core message hash. */
export function magicHash(message: string): Uint8Array {
  return sha256d(concatBytes(varBytes(utf8ToBytes(MESSAGE_MAGIC)), varBytes(utf8ToBytes(message))));
}

/** BIP322 tagged hash of the message. */
export function bip322MessageHash(message: string): Uint8Array {
  const tag = sha256(utf8ToBytes('BIP0322-signed-message'));
  return sha256(concatBytes(tag, tag, utf8ToBytes(message)));
}

function p2wpkhProgram(address: string, network: BtcSignerNetwork): Uint8Array {
  const dec = btc.Address(network).decode(address);
  if (dec.type !== 'wpkh') throw new Error('only p2wpkh (bc1q...) addresses are supported for message signing');
  return dec.hash;
}

/** to_spend's txid (display order), per BIP322. */
function toSpendTxid(messageHash: Uint8Array, scriptPubKey: Uint8Array): string {
  const raw = concatBytes(
    Uint8Array.of(0, 0, 0, 0), // version 0
    Uint8Array.of(1), // one input
    new Uint8Array(32),
    Uint8Array.of(0xff, 0xff, 0xff, 0xff),
    varBytes(concatBytes(Uint8Array.of(0x00, 0x20), messageHash)), // OP_0 PUSH32 <hash>
    Uint8Array.of(0, 0, 0, 0), // sequence 0
    Uint8Array.of(1), // one output
    new Uint8Array(8), // value 0
    varBytes(scriptPubKey),
    Uint8Array.of(0, 0, 0, 0) // locktime 0
  );
  return bytesToHex(sha256d(raw).reverse());
}

function toSign(messageHash: Uint8Array, scriptPubKey: Uint8Array) {
  const tx = new btc.Transaction({ version: 0, allowUnknownVersion: true, allowUnknownOutputs: true, lowR: true });
  tx.addInput({
    txid: toSpendTxid(messageHash, scriptPubKey),
    index: 0,
    sequence: 0,
    witnessUtxo: { script: scriptPubKey, amount: 0n },
  });
  tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
  return tx;
}

/**
 * DER ECDSA with Bitcoin Core's low-R grinding: plain RFC6979 first, then
 * extra entropy = LE32(1), LE32(2), ... until r < 2^255. Matching Core's
 * counter (btc-signer starts at 0) makes signatures reproducible against it.
 */
export function signLowR(hash: Uint8Array, privateKey: Uint8Array): Uint8Array {
  let sig = secp256k1.sign(hash, privateKey, { prehash: false });
  for (let counter = 1; sig[0]! >= 0x80; counter++) {
    const extraEntropy = new Uint8Array(32);
    new DataView(extraEntropy.buffer).setUint32(0, counter, true);
    sig = secp256k1.sign(hash, privateKey, { prehash: false, extraEntropy });
  }
  return secp256k1.Signature.fromBytes(sig).toBytes('der');
}

export interface MessageSignature {
  signature: string;
  messageHash: string;
  address: string;
  protocol: MessageSigningProtocols;
}

export function signMessage(opts: {
  privateKey: Uint8Array;
  address: string;
  message: string;
  network: BtcSignerNetwork;
  protocol?: MessageSigningProtocols;
}): MessageSignature {
  const { privateKey, address, message, network } = opts;
  const protocol = opts.protocol ?? MessageSigningProtocols.BIP322;
  const program = p2wpkhProgram(address, network);
  const pub = secp256k1.getPublicKey(privateKey, true);
  if (bytesToHex(hash160(pub)) !== bytesToHex(program)) throw new Error('this key does not own that address');

  if (protocol === MessageSigningProtocols.ECDSA) {
    const hash = magicHash(message);
    const rec = secp256k1.sign(hash, privateKey, { prehash: false, format: 'recovered' });
    const sig = concatBytes(Uint8Array.of(39 + rec[0]!), rec.subarray(1));
    return { signature: base64.encode(sig), messageHash: bytesToHex(hash), address, protocol };
  }

  const hash = bip322MessageHash(message);
  const tx = toSign(hash, btc.OutScript.encode({ type: 'wpkh', hash: program }));
  const sighash = tx.preimageWitnessV0(0, btc.OutScript.encode({ type: 'pkh', hash: program }), btc.SigHash.ALL, 0n);
  const witness = [concatBytes(signLowR(sighash, privateKey), Uint8Array.of(btc.SigHash.ALL)), pub];
  return { signature: base64.encode(btc.RawWitness.encode(witness)), messageHash: bytesToHex(hash), address, protocol };
}

/** BIP137 headers: 27-30 p2pkh uncompressed, 31-34 compressed, 35-38 p2sh-p2wpkh, 39-42 p2wpkh. */
function verifyEcdsa(address: string, message: string, sig: Uint8Array, network: BtcSignerNetwork): boolean {
  if (sig.length !== 65) return false;
  const header = sig[0]!;
  if (header < 27 || header > 42) return false;
  const recid = (header - 27) & 3;
  const hash = magicHash(message);
  let pub: Uint8Array;
  try {
    pub = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(recid), sig.subarray(1)), hash, { prehash: false });
  } catch {
    return false;
  }
  const compressed = header >= 31;
  const pk = compressed ? secp256k1.Point.fromBytes(pub).toBytes(true) : secp256k1.Point.fromBytes(pub).toBytes(false);
  const candidates = [btc.p2pkh(pk, network).address];
  if (compressed) {
    candidates.push(btc.p2wpkh(pk, network).address, btc.p2sh(btc.p2wpkh(pk, network), network).address);
  }
  return candidates.includes(address);
}

function verifyBip322(address: string, message: string, sig: Uint8Array, network: BtcSignerNetwork): boolean {
  let program: Uint8Array;
  try {
    program = p2wpkhProgram(address, network);
  } catch {
    return false;
  }
  let witness: Uint8Array[];
  try {
    witness = btc.RawWitness.decode(sig);
  } catch {
    return false;
  }
  if (witness.length !== 2) return false;
  const [derWithType, pub] = witness as [Uint8Array, Uint8Array];
  if (pub.length !== 33 || bytesToHex(hash160(pub)) !== bytesToHex(program)) return false;
  if (derWithType[derWithType.length - 1] !== btc.SigHash.ALL) return false;
  const scriptPubKey = btc.OutScript.encode({ type: 'wpkh', hash: program });
  const tx = toSign(bip322MessageHash(message), scriptPubKey);
  const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: program });
  const sighash = tx.preimageWitnessV0(0, scriptCode, btc.SigHash.ALL, 0n);
  try {
    return secp256k1.verify(derWithType.subarray(0, -1), sighash, pub, { prehash: false, format: 'der', lowS: false });
  } catch {
    return false;
  }
}

/** Checks a BIP322 (p2wpkh) or BIP137 signature over `message` by `address`. */
export function verifyMessage(opts: {
  address: string;
  message: string;
  signature: string;
  network: BtcSignerNetwork;
  protocol?: MessageSigningProtocols;
}): boolean {
  let sig: Uint8Array;
  try {
    sig = base64.decode(opts.signature);
  } catch {
    return false;
  }
  const protocol = opts.protocol ?? (sig.length === 65 ? MessageSigningProtocols.ECDSA : MessageSigningProtocols.BIP322);
  return protocol === MessageSigningProtocols.ECDSA
    ? verifyEcdsa(opts.address, opts.message, sig, opts.network)
    : verifyBip322(opts.address, opts.message, sig, opts.network);
}

export { hexToBytes };
