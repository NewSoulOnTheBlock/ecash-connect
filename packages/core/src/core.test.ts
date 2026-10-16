import { describe, expect, test } from 'bun:test';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import {
  bip322MessageHash,
  buildDeposit,
  buildTransfer,
  depositOutputs,
  extractTx,
  ECASH_NETWORKS,
  EcashNetworkType,
  formatDepositAddress,
  MessageSigningProtocols,
  normalizeSidechainAddress,
  parseTreasuryScript,
  psbtOutpoints,
  ReplayChecker,
  request,
  RpcErrorCode,
  signMessage,
  treasuryScript,
  verifyMessage,
  type Fetch,
  type Utxo,
} from './index';

const MAIN = ECASH_NETWORKS[EcashNetworkType.Mainnet].address;
const REGTEST = ECASH_NETWORKS[EcashNetworkType.Regtest].address;

// BIP322 test vectors (bip-0322.mediawiki)
const VEC_WIF = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k';
const VEC_ADDR = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
const VEC_KEY = btc.WIF().decode(VEC_WIF);

describe('messages', () => {
  test('BIP322 message hashes match the spec', () => {
    expect(bytesToHex(bip322MessageHash(''))).toBe('c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1');
    expect(bytesToHex(bip322MessageHash('Hello World'))).toBe(
      'f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a'
    );
  });

  test('BIP322 signatures match the spec vectors byte for byte', () => {
    const empty = signMessage({ privateKey: VEC_KEY, address: VEC_ADDR, message: '', network: MAIN });
    expect(empty.signature).toBe(
      'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='
    );
    const hello = signMessage({ privateKey: VEC_KEY, address: VEC_ADDR, message: 'Hello World', network: MAIN });
    expect(hello.signature).toBe(
      'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI='
    );
  });

  test('BIP322 verify accepts the spec signature and rejects a different message', () => {
    const sig =
      'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=';
    expect(verifyMessage({ address: VEC_ADDR, message: 'Hello World', signature: sig, network: MAIN })).toBe(true);
    expect(verifyMessage({ address: VEC_ADDR, message: 'Hello World!', signature: sig, network: MAIN })).toBe(false);
    expect(
      verifyMessage({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', message: 'Hello World', signature: sig, network: MAIN })
    ).toBe(false);
  });

  test('ECDSA (BIP137) round-trips with a p2wpkh header', () => {
    const s = signMessage({ privateKey: VEC_KEY, address: VEC_ADDR, message: 'meow', network: MAIN, protocol: MessageSigningProtocols.ECDSA });
    const raw = Uint8Array.from(atob(s.signature), (c) => c.charCodeAt(0));
    expect(raw.length).toBe(65);
    expect(raw[0]).toBeGreaterThanOrEqual(39);
    expect(raw[0]).toBeLessThanOrEqual(42);
    expect(verifyMessage({ address: VEC_ADDR, message: 'meow', signature: s.signature, network: MAIN })).toBe(true);
    expect(verifyMessage({ address: VEC_ADDR, message: 'woof', signature: s.signature, network: MAIN })).toBe(false);
  });

  test('refuses to sign for an address the key does not own', () => {
    expect(() =>
      signMessage({ privateKey: VEC_KEY, address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', message: 'x', network: MAIN })
    ).toThrow('does not own');
  });
});

describe('drivechain', () => {
  test('treasury script is OP_DRIVECHAIN PUSH1 <slot> OP_TRUE', () => {
    expect(bytesToHex(treasuryScript(77))).toBe('b7014d51');
    expect(parseTreasuryScript(treasuryScript(236))).toBe(236);
    expect(parseTreasuryScript(Uint8Array.of(0xb4, 1, 5, 0x51))).toBeUndefined();
  });

  const bare = '2ynmtLyBPcYLJgn8PiUWFHkRmYky';
  test('deposit address: bare and formatted forms, slot and checksum checked', () => {
    expect(normalizeSidechainAddress(bare, 236)).toBe(bare);
    const formatted = formatDepositAddress(bare, 236);
    expect(normalizeSidechainAddress(formatted, 236)).toBe(bare);
    expect(() => normalizeSidechainAddress(formatted, 77)).toThrow('slot 236');
    const typo = formatted.slice(0, -1) + (formatted.endsWith('0') ? '1' : '0');
    expect(() => normalizeSidechainAddress(typo, 236)).toThrow('checksum');
    expect(() => normalizeSidechainAddress('bc1qnotasidechainaddress', 236)).toThrow();
    expect(() => normalizeSidechainAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 236)).toThrow('20');
  });

  test('deposit outputs add to the treasury and carry the bare address', () => {
    const o = depositOutputs({ slot: 77, ctipValue: 5_000n, amount: 1_000n, sidechainAddress: formatDepositAddress(bare, 77) });
    expect(o.treasury.amount).toBe(6_000n);
    expect(new TextDecoder().decode(o.address.script.slice(2))).toBe(bare);
    expect(o.address.script[0]).toBe(0x6a);
    expect(o.address.script[1]).toBe(bare.length);
  });
});

describe('tx building', () => {
  const key = btc.utils.randomPrivateKeyBytes();
  const pub = secp256k1.getPublicKey(key, true);
  const wallet = { network: REGTEST, address: btc.p2wpkh(pub, REGTEST).address!, publicKey: pub };
  const utxo = (n: number, value: bigint, replay?: Utxo['replay']): Utxo => ({
    txid: n.toString(16).padStart(64, '0'),
    vout: 0,
    value,
    confirmed: true,
    replay,
  });

  test('transfer: pays, changes back, and the fee matches the signed size', () => {
    const b = buildTransfer({ wallet, utxos: [utxo(1, 50_000n), utxo(2, 100_000n)], recipients: [{ address: wallet.address, amount: 30_000n }], feeRate: 2 });
    b.tx.sign(key);
    b.tx.finalize();
    expect(b.spent.length).toBe(1);
    expect(b.tx.fee).toBe(b.fee);
    const actual = b.tx.vsize;
    expect(Math.abs(actual - b.vsize)).toBeLessThanOrEqual(2);
  });

  test('transfer: insufficient funds is a typed error', () => {
    try {
      buildTransfer({ wallet, utxos: [utxo(1, 1_000n)], recipients: [{ address: wallet.address, amount: 30_000n }], feeRate: 2 });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { code: number }).code).toBe(RpcErrorCode.INSUFFICIENT_FUNDS);
    }
  });

  test('transfer: refuses when every coin is shared with Bitcoin, mixes in an ECX-only coin otherwise', () => {
    try {
      buildTransfer({ wallet, utxos: [utxo(1, 500_000n, 'shared')], recipients: [{ address: wallet.address, amount: 30_000n }], feeRate: 2 });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { code: number }).code).toBe(RpcErrorCode.REPLAY_UNSAFE);
    }
    const b = buildTransfer({
      wallet,
      utxos: [utxo(1, 500_000n, 'shared'), utxo(2, 1_000n, 'ecx-only')],
      recipients: [{ address: wallet.address, amount: 30_000n }],
      feeRate: 2,
    });
    expect(b.spent.map((s) => s.replay)).toContain('ecx-only');
  });

  test('deposit: ctip first with an empty scriptSig, treasury then OP_RETURN', () => {
    const prev = new btc.Transaction({ allowUnknownOutputs: true });
    prev.addInput({ txid: '11'.repeat(32), index: 0, finalScriptSig: new Uint8Array(0) });
    prev.addOutput({ script: treasuryScript(77), amount: 74_990_000n });
    const prevHex = bytesToHex(prev.toBytes(true, true));
    const ctip = { txid: prev.id, vout: 0, value: 74_990_000n };
    const b = buildDeposit({
      wallet,
      utxos: [utxo(3, 2_000_000n, 'shared')],
      slot: 77,
      sidechainAddress: '2ynmtLyBPcYLJgn8PiUWFHkRmYky',
      amount: 1_000_000n,
      ctip,
      ctipTxHex: prevHex,
      feeRate: 2,
    });
    expect(b.treasuryValue).toBe(75_990_000n);
    expect(psbtOutpoints(b.tx)[0]).toEqual({ txid: ctip.txid, vout: 0 });
    expect(bytesToHex(b.tx.getOutput(0).script!)).toBe('b7014d51');
    expect(b.tx.getOutput(1).script![0]).toBe(0x6a);
    b.tx.signIdx(key, 1);
    b.tx.finalizeIdx(1);
    const raw = extractTx(b.tx);
    const parsed = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownInputs: true });
    expect(parsed.getInput(0).finalScriptSig?.length ?? 0).toBe(0);
    expect(b.tx.fee).toBe(b.fee);
  });
});

describe('replay checker', () => {
  const fakeBtc = (known: Record<string, { spent: boolean }>) =>
    (async (url: string) => {
      const m = /\/tx\/([0-9a-f]+)\/(status|outspend\/(\d+))$/.exec(String(url));
      if (!m) return new Response('nope', { status: 404 });
      const k = known[m[1]!];
      if (!k) return new Response('Transaction not found', { status: 404 });
      if (m[2] === 'status') return Response.json({ confirmed: true });
      return Response.json({ spent: k.spent, status: { confirmed: true } });
    }) as unknown as Fetch;

  test('classifies inputs and calls a tx safe when one input cannot exist on Bitcoin', async () => {
    const c = new ReplayChecker(EcashNetworkType.Mainnet, {
      fetch: fakeBtc({ ['aa'.repeat(32)]: { spent: false }, ['bb'.repeat(32)]: { spent: true } }),
    });
    const shared = await c.check([{ txid: 'aa'.repeat(32), vout: 0 }]);
    expect(shared).toMatchObject({ safe: false, applicable: true });
    const spent = await c.check([{ txid: 'aa'.repeat(32), vout: 0 }, { txid: 'bb'.repeat(32), vout: 1 }]);
    expect(spent.safe).toBe(true);
    expect(spent.inputs[1]!.status).toBe('spent-on-bitcoin');
    const fresh = await c.check([{ txid: 'cc'.repeat(32), vout: 0 }]);
    expect(fresh.inputs[0]!.status).toBe('ecx-only');
  });

  test('does not apply on regtest', async () => {
    const r = await new ReplayChecker(EcashNetworkType.Regtest).check([{ txid: 'aa'.repeat(32), vout: 0 }]);
    expect(r).toMatchObject({ safe: true, applicable: false });
  });
});

describe('request', () => {
  test('unwraps JSON-RPC success and error from an injected provider', async () => {
    (globalThis as any).window = {
      EcashCatWallet: {
        EcashProvider: {
          request: async (method: string) =>
            method === 'getBalance'
              ? { jsonrpc: '2.0', id: '1', result: { confirmed: '5', unconfirmed: '0', total: '5' } }
              : { jsonrpc: '2.0', id: '1', error: { code: RpcErrorCode.USER_REJECTION, message: 'no' } },
        },
      },
    };
    const ok = await request('getBalance', undefined, 'EcashCatWallet.EcashProvider');
    expect(ok).toEqual({ status: 'success', result: { confirmed: '5', unconfirmed: '0', total: '5' } });
    const err = await request('signMessage', { address: 'x', message: 'y' }, 'EcashCatWallet.EcashProvider');
    expect(err.status).toBe('error');
    delete (globalThis as any).window;
  });
});
