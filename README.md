# eCash Connect

Connect dapps to **eCash (ECX)** wallets. A port of
[sats-connect](https://github.com/secretkeylabs/sats-connect) to eCash, the
Bitcoin fork with BIP300 drivechains, with the same request API plus
eCash-specific pieces: sidechain deposits and protection against transactions
being replayed onto Bitcoin.

| Package | For | |
|---|---|---|
| [`ecash-connect`](packages/ecash-connect) | dapps | `Wallet.request(...)`, the wallet picker, everything below re-exported |
| [`@ecash-connect/core`](packages/core) | wallets, servers | protocol, provider discovery, BIP322/BIP137, transaction and deposit building, replay checks |
| [`@ecash-connect/ui`](packages/ui) | | the wallet picker (fork of sats-connect-ui) |

Wallet: [eCash Cat Wallet](https://github.com/NewSoulOnTheBlock/ecash-cat-wallet) (Chrome extension).

```sh
npm install ecash-connect
```

```ts
import Wallet from 'ecash-connect';

const res = await Wallet.request('getAddresses', { purposes: ['payment'] });
if (res.status === 'success') console.log(res.result.addresses[0].address);
```

See [packages/ecash-connect](packages/ecash-connect#readme) for every method,
error codes and the two things every eCash dapp must get right (replay and
deposit addresses).

## Develop

```sh
bun install
bun run build       # core -> ui -> ecash-connect -> demo
bun run test        # core unit tests, incl. BIP322 spec vectors
bun run demo        # demo dapp at http://localhost:5174 (needs an eCash wallet extension)
```

## How it differs from sats-connect

- One method table (`packages/core/src/methods.ts`) instead of a file per method; the
  method names and payloads of the `bitcoin` and `wallet` namespaces are kept.
- No Stacks, Runes, Ordinals, Spark or Starknet namespaces; added `drivechain_*`
  and `ecash_checkReplay`.
- Discovery uses `window.ecash_providers` and its own selector events, so it can
  sit on a page next to sats-connect without clashing.

## License

MIT. Derived from sats-connect, sats-connect-core and sats-connect-ui,
© 2025 Secret Key Labs.
