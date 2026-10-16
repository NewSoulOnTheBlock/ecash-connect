/**
 * End to end against the local eCash Cat devnet (ECX regtest + electrs +
 * bip300301_enforcer, see ~/dev/ecash-cat-chain/devnet):
 *
 *   bun apps/extension/test/devnet.e2e.ts
 *
 * Drives the extension's WalletService exactly as dapps do, with approvals
 * auto-clicked, and checks each result against the chain.
 */
import { base58, base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import * as btc from '@scure/btc-signer';
import {
  buildTransfer,
  ECASH_NETWORKS,
  EcashNetworkType,
  Esplora,
  formatDepositAddress,
  getCtip,
  RpcErrorCode,
  verifyMessage,
  type SpecResponse,
} from '@ecash-connect/core';
import { deriveAccount, newMnemonic } from '../src/wallet/keys';
import { WalletService, type KV, type Pending } from '../src/wallet/service';

const ESPLORA = 'http://127.0.0.1:3002';
const ENFORCER = 'http://127.0.0.1:50051';
const SLOT = Number(process.env.SLOT ?? 77);
const DAPP = 'https://dapp.example';
const NET = ECASH_NETWORKS[EcashNetworkType.Regtest].address;

function memKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    set: async (k, v) => void m.set(k, structuredClone(v)),
    remove: async (k) => void m.delete(k),
  };
}

let answer = true;
const asked: Pending[] = [];
const events: unknown[] = [];
const svc = new WalletService({
  local: memKV(),
  session: memKV(),
  ask: async (p) => (asked.push(p), answer),
  emit: (origin, e) => events.push({ origin, e }),
});
const esplora = new Esplora(ESPLORA);

function devnet(...args: string[]): string {
  const r = Bun.spawnSync(['wsl', '-d', 'Debian', '--', 'bash', '/mnt/c/Users/roota/dev/ecash-connect/apps/extension/test/devnet.sh', ...args]);
  if (r.exitCode !== 0) throw new Error(`devnet ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function waitFor(what: string, ok: () => Promise<boolean>, secs = 60) {
  for (let i = 0; i < secs * 2; i++) {
    if (await ok()) return;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let step = 0;
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok ${++step} ${msg}`);
}

async function call(method: string, params?: unknown): Promise<SpecResponse & { result?: any; error?: any }> {
  return (await svc.handle(DAPP, method, params, step)) as any;
}

async function mineAndIndex(txid?: string) {
  const height = Number(devnet('mine', '1'));
  await waitFor(`electrs at height ${height}`, async () => (await esplora.tipHeight()) >= height);
  if (txid) await waitFor(`${txid} confirmed`, async () => (await (await fetch(`${ESPLORA}/tx/${txid}/status`)).json()).confirmed);
}

console.log('eCash Cat Wallet e2e on the devnet');

// ---- setup + connect ---------------------------------------------------------
await svc.setup(newMnemonic(), 'correct horse battery');
const st = await svc.state();
check(st.initialized && st.unlocked && st.network === EcashNetworkType.Regtest, 'wallet set up and unlocked on regtest');
const me = st.account!.address;
check(me.startsWith('bcrt1q'), `account is p2wpkh: ${me}`);

const info = await call('getInfo');
check(info.result?.methods.includes('drivechain_deposit'), 'getInfo lists drivechain_deposit');
check((await call('getBalance')).error?.code === RpcErrorCode.ACCESS_DENIED, 'getBalance is refused before connecting');

answer = false;
check((await call('wallet_connect')).error?.code === RpcErrorCode.USER_REJECTION, 'rejecting the connect prompt returns USER_REJECTION');
answer = true;
const conn = await call('wallet_connect', { message: 'e2e' });
check(conn.result?.addresses[0].address === me, 'wallet_connect returns the account address');
check(asked.at(-1)?.kind === 'connect', 'the user was asked to connect');
check((await call('getAddresses', { purposes: ['payment'] })).result?.addresses.length === 1, 'getAddresses works once connected');

// ---- fund ------------------------------------------------------------------------
const fundTxid = devnet('fund', me, '300000000');
check(/^[0-9a-f]{64}$/.test(fundTxid), `funded 3 ECX from the enforcer wallet (${fundTxid.slice(0, 12)}…)`);
await waitFor('funding in electrs', async () => BigInt((await svc.balance()).total) >= 300_000_000n);
const pendingBal = (await call('getBalance')).result;
check(pendingBal.unconfirmed === '300000000', 'getBalance shows the funding as unconfirmed');
await mineAndIndex(fundTxid);
check((await call('getBalance')).result.confirmed === '300000000', 'confirmed after one block');

// ---- sign message --------------------------------------------------------------
const sm = await call('signMessage', { address: me, message: 'eCash Cat says meow' });
check(verifyMessage({ address: me, message: 'eCash Cat says meow', signature: sm.result.signature, network: NET }), 'BIP322 signature verifies');
const sm2 = await call('signMessage', { address: me, message: 'meow', protocol: 'ECDSA' });
check(verifyMessage({ address: me, message: 'meow', signature: sm2.result.signature, network: NET }), 'ECDSA (BIP137) signature verifies');
check((await call('signMessage', { address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', message: 'x' })).error?.code === RpcErrorCode.INVALID_PARAMS, 'signing for a foreign address is refused');

// ---- sendTransfer ---------------------------------------------------------------
const friend = deriveAccount(newMnemonic(), EcashNetworkType.Regtest).address;
const sent = await call('sendTransfer', { recipients: [{ address: friend, amount: 10_000_000 }], feeRate: 2 });
check(/^[0-9a-f]{64}$/.test(sent.result?.txid ?? ''), `sendTransfer broadcast ${sent.result?.txid?.slice(0, 12)}…`);
check(asked.at(-1)?.title === 'Send 0.1 ECX?', `the prompt said "${asked.at(-1)?.title}"`);
await mineAndIndex(sent.result.txid);
const friendUtxos = await esplora.utxos(friend);
check(friendUtxos.length === 1 && friendUtxos[0]!.value === 10_000_000, 'recipient received exactly 0.1 ECX');

// ---- signPsbt (dapp-built) -------------------------------------------------------
const utxos = (await esplora.utxos(me)).map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: u.status.confirmed }));
const acct = (await svc.state()).account!;
const built = buildTransfer({
  wallet: { network: NET, address: me, publicKey: hexToBytes(acct.publicKey) },
  utxos,
  recipients: [{ address: friend, amount: 5_000_000n }],
  feeRate: 3,
});
const psbtB64 = base64.encode(built.tx.toPSBT());
const signedPsbt = await call('signPsbt', { psbt: psbtB64, broadcast: true });
check(/^[0-9a-f]{64}$/.test(signedPsbt.result?.txid ?? ''), `signPsbt signed and broadcast a dapp-built PSBT (${signedPsbt.result?.txid?.slice(0, 12)}…)`);
const back = btc.Transaction.fromPSBT(base64.decode(signedPsbt.result.psbt));
check(back.isFinal, 'returned PSBT has its inputs finalized');
check(signedPsbt.result.replay.applicable === false, 'replay check reports not applicable on regtest');
await mineAndIndex(signedPsbt.result.txid);

const bad = await call('signPsbt', { psbt: psbtB64, signInputs: { [friend]: [0] } });
check(bad.error?.code === RpcErrorCode.INVALID_PARAMS, 'signPsbt refuses signInputs for an address it does not own');

// ---- drivechain ---------------------------------------------------------------------
const chains = await call('drivechain_getSidechains');
const chain = chains.result?.find((c: any) => c.slot === SLOT);
check(chain, `drivechain_getSidechains lists slot ${SLOT} ("${chain?.title}")`);
const before = await getCtip(ENFORCER, SLOT);

// A 20-byte sidechain address in the display form sidechain wallets print.
const scAddr = base58.encode(crypto.getRandomValues(new Uint8Array(20)));
const wrongSlot = await call('drivechain_deposit', { slot: SLOT, sidechainAddress: formatDepositAddress(scAddr, SLOT + 1), amount: 1_000 });
check(wrongSlot.error?.code === RpcErrorCode.INVALID_PARAMS, 'a deposit address for another slot is refused');
const noChain = await call('drivechain_deposit', { slot: 199, sidechainAddress: scAddr, amount: 1_000 });
check(noChain.error?.code === RpcErrorCode.INVALID_PARAMS, 'a deposit to an inactive slot is refused');

const dep = await call('drivechain_deposit', { slot: SLOT, sidechainAddress: formatDepositAddress(scAddr, SLOT), amount: 25_000_000, feeRate: 2 });
check(/^[0-9a-f]{64}$/.test(dep.result?.txid ?? ''), `drivechain_deposit broadcast an M5 (${dep.result?.txid?.slice(0, 12)}…)`);
check(dep.result.treasuryValue === String((before?.value ?? 0n) + 25_000_000n), 'new treasury = old treasury + deposit');
await mineAndIndex(dep.result.txid);
await waitFor('enforcer to see the deposit', async () => (await getCtip(ENFORCER, SLOT))?.txid === dep.result.txid, 30);
const after = await getCtip(ENFORCER, SLOT);
check(after?.txid === dep.result.txid && after!.value === (before?.value ?? 0n) + 25_000_000n, `the enforcer accepted it as slot ${SLOT}'s new CTIP (${after?.value} sats)`);
const depTx = btc.Transaction.fromRaw(hexToBytes(dep.result.transaction), { allowUnknownInputs: true, allowUnknownOutputs: true });
check(new TextDecoder().decode(depTx.getOutput(1).script!.slice(2)) === scAddr, 'OP_RETURN carries the bare sidechain address');

// ---- lock ------------------------------------------------------------------------------
await svc.lock();
const locked = await call('signMessage', { address: me, message: 'x' });
check(locked.error?.code === RpcErrorCode.WALLET_LOCKED, 'signing while locked fails with WALLET_LOCKED after approval');
check((await call('getBalance')).result?.confirmed, 'balance still readable while locked');
check(await svc.unlock('correct horse battery'), 'unlock with the password');
check(!(await svc.unlock('wrong password')), 'a wrong password does not unlock');

await svc.disconnectSite(DAPP);
check((await call('getBalance')).error?.code === RpcErrorCode.ACCESS_DENIED, 'after disconnect the site is refused again');
check(events.some((e: any) => e.e.type === 'disconnect' && e.origin === DAPP), 'the site got a disconnect event');

console.log(`\nall ${step} checks passed`);
