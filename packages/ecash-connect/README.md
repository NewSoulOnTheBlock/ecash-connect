# ecash-connect

Connect your dapp to **eCash (ECX)** wallets: get the user's address, have them
sign messages and PSBTs, send ECX, and deposit into BIP300 drivechain
sidechains.

It is a port of [sats-connect](https://github.com/secretkeylabs/sats-connect)
(MIT, Secret Key Labs) with the same calling convention, so a sats-connect dapp
moves over by changing its import. The wallet picker is a fork of
sats-connect-ui.

```sh
npm install ecash-connect
```

## Quick start

```ts
import Wallet, { AddressPurpose } from 'ecash-connect';

// Opens the wallet picker the first time; the choice is remembered per site.
const res = await Wallet.request('wallet_connect', { message: 'Sign in to My dApp' });
if (res.status === 'error') throw new Error(res.error.message);

const { address } = res.result.addresses.find((a) => a.purpose === AddressPurpose.Payment)!;
const network = res.result.network.ecash.name; // 'Mainnet' | 'Betanet' | 'Regtest'
```

Every call resolves to `{ status: 'success', result }` or
`{ status: 'error', error: { code, message } }`. It does not throw for
wallet-side errors such as a rejection.

## Methods

| Method | Params | Result |
|---|---|---|
| `wallet_connect` | `{ message?, network? }` | `{ id, addresses, walletType, network }` |
| `getAddresses` | `{ purposes: ['payment'], message? }` | `{ addresses, network }` |
| `getBalance` | none | `{ confirmed, unconfirmed, total }` (sats, strings) |
| `signMessage` | `{ address, message, protocol?: 'BIP322' \| 'ECDSA' }` | `{ signature, messageHash, address, protocol }` |
| `signPsbt` | `{ psbt (base64), signInputs?, broadcast? }` | `{ psbt, txid?, replay }` |
| `sendTransfer` | `{ recipients: [{ address, amount }], feeRate?, broadcast? }` | `{ txid, transaction }` |
| `drivechain_getSidechains` | none | `[{ slot, title, description, treasury? }]` |
| `drivechain_deposit` | `{ slot, sidechainAddress, amount, feeRate? }` | `{ txid, transaction, treasuryValue }` |
| `ecash_checkReplay` | `{ psbt }` | `{ safe, applicable, inputs }` |
| `wallet_getAccount`, `wallet_getNetwork`, `wallet_getCurrentPermissions`, `wallet_disconnect`, `getInfo` | | |

Amounts are integers in sats (1 ECX = 100,000,000 sats).

## Examples

```ts
// Prove address ownership (e.g. log in); verify on your server with the same library.
import Wallet, { verifyMessage, ECASH_NETWORKS } from 'ecash-connect';

const sig = await Wallet.request('signMessage', { address, message: 'login:nonce-123' });
if (sig.status === 'success') {
  const ok = verifyMessage({ address, message: 'login:nonce-123', signature: sig.result.signature, network: ECASH_NETWORKS[network].address });
}

// Pay
await Wallet.request('sendTransfer', { recipients: [{ address: 'bc1q…', amount: 50_000 }] });

// Move ECX into a sidechain (slot from drivechain_getSidechains; the address as the sidechain wallet prints it)
await Wallet.request('drivechain_deposit', { slot: 77, sidechainAddress: 's77_…_a1b2c3', amount: 1_000_000 });

// Wallet events
const off = Wallet.addListener({ eventName: 'networkChange', cb: (e) => console.log(e.ecash.name) });
```

## Things eCash dapps must know

**Replay onto Bitcoin.** ECX is a Bitcoin fork that kept Bitcoin's signature
hashing with no fork id. A transaction signed for ECX is valid on Bitcoin too
whenever every coin it spends still exists there, so anyone could rebroadcast
it and move the user's BTC. Wallets refuse such transactions (error code
`-32010`, `REPLAY_UNSAFE`). If you build PSBTs yourself, call
`ecash_checkReplay` or use `ReplayChecker` and include at least one input that
exists only on eCash.

**Deposit addresses.** A sidechain credits an address it cannot parse to the
all-zero address, so a deposit to a malformed address is lost. Pass the
address exactly as the sidechain wallet shows it (`s<slot>_<address>_<checksum>`
or the bare base58 form); wallets check the slot and checksum. You can check
early with `normalizeSidechainAddress(addr, slot)`.

## Customising the picker

```ts
Wallet.setCreateCustomConfig((wallets) => ({
  options: wallets.filter((w) => w.isInstalled).map((w) => ({ id: w.id, name: w.name, icon: w.icon })),
}));
```

Wallets with their own non-standard API can be wrapped with
`Wallet.registerAdapter(providerId, MyAdapter)` (see `EcashConnectAdapter` in
`@ecash-connect/core`).

## Error codes

| Code | Meaning |
|---|---|
| `-32000` | user rejected, or closed the picker |
| `-32002` | site not connected yet |
| `-32003` | wallet locked or not set up |
| `-32010` | transaction could be replayed on Bitcoin |
| `-32011` | not enough ECX |
| `-32602` | invalid params |

## Wallets

- [eCash Cat Wallet](https://github.com/NewSoulOnTheBlock/ecash-cat-wallet) (Chrome extension).
- Building a wallet? See [@ecash-connect/core](https://www.npmjs.com/package/@ecash-connect/core).

## License

MIT. Derived from sats-connect, © 2025 Secret Key Labs.
