/**
 * One p2wpkh account per network, BIP84: m/84'/<coin>'/0'/0/0. Mainnet uses
 * coin type 0, Bitcoin's, so importing a Bitcoin seed finds its fork coins
 * (and the replay guard is what keeps that safe).
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as btc from '@scure/btc-signer';
import { ECASH_NETWORKS, type EcashNetworkType } from '@ecash-connect/core';

export interface PublicAccount {
  address: string;
  publicKey: string;
  path: string;
}

export interface Account extends PublicAccount {
  privateKey: Uint8Array;
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizeMnemonic(words: string): string {
  return words.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(words: string): boolean {
  return validateMnemonic(normalizeMnemonic(words), wordlist);
}

export function deriveAccount(mnemonic: string, network: EcashNetworkType): Account {
  const params = ECASH_NETWORKS[network];
  const path = `m/84'/${params.coinType}'/0'/0/0`;
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizeMnemonic(mnemonic))).derive(path);
  if (!node.privateKey) throw new Error('key derivation failed');
  const publicKey = secp256k1.getPublicKey(node.privateKey, true);
  const address = btc.p2wpkh(publicKey, params.address).address!;
  return { address, publicKey: bytesToHex(publicKey), path, privateKey: node.privateKey };
}

export function publicPart(a: Account): PublicAccount {
  return { address: a.address, publicKey: a.publicKey, path: a.path };
}
