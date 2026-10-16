/**
 * The encrypted recovery phrase. AES-256-GCM under a key stretched from the
 * password with PBKDF2-SHA256 (600k iterations, OWASP 2023). WebCrypto only,
 * so it runs the same in the extension's service worker and under Bun.
 */
import { base64 } from '@scure/base';

export interface Vault {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealVault(secret: string, password: string, iterations = ITERATIONS): Promise<Vault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: base64.encode(salt), iv: base64.encode(iv), ciphertext: base64.encode(ct) };
}

/** The secret, or null for a wrong password (GCM authentication fails). */
export async function openVault(vault: Vault, password: string): Promise<string | null> {
  const key = await deriveKey(password, base64.decode(vault.salt), vault.iterations);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64.decode(vault.iv) as BufferSource },
      key,
      base64.decode(vault.ciphertext) as BufferSource
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
