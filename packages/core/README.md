# @ecash-connect/core

The protocol and chain helpers behind [ecash-connect](https://www.npmjs.com/package/ecash-connect),
for **wallet makers**, and for dapps that build their own transactions or verify
signatures on a server. Derived from
[@sats-connect/core](https://github.com/secretkeylabs/sats-connect-core) (MIT, Secret Key Labs).

```sh
npm install @ecash-connect/core
```

## Making a wallet speak eCash Connect

Expose a provider on `window` and announce it in `window.ecash_providers`:

```ts
window.MyWallet = {
  EcashProvider: {
    // Resolve with a JSON-RPC 2.0 response: { jsonrpc: '2.0', id, result } or { jsonrpc: '2.0', id, error }
    request: async (method, params) => handle(method, params),
    addListener: ({ eventName, cb }) => subscribe(eventName, cb), // returns an unsubscribe function
  },
};
window.ecash_providers = [...(window.ecash_providers ?? []), { id: 'MyWallet.EcashProvider', name: 'My Wallet', icon: 'data:image/svg+xml;base64,…' }];
```

Validate incoming params with `parseParams(method, params)`; `methods` holds a
[valibot](https://valibot.dev) schema for every method's params and result.
Events: `accountChange`, `networkChange`, `disconnect`.

## What's inside

| Module | |
|---|---|
| `methods`, `RpcErrorCode`, `rpcSpec` | The method table and JSON-RPC envelope |
| `request`, `addListener`, `getSupportedWallets`, adapters | Dapp-side discovery and calls |
| `ECASH_NETWORKS` | Mainnet / betanet / regtest params, verified against ECX `chainparams.cpp` |
| `signMessage`, `verifyMessage`, `bip322MessageHash`, `signLowR` | BIP322 (p2wpkh) and BIP137; output matches the BIP322 test vectors byte for byte |
| `buildTransfer`, `buildDeposit`, `extractTx` | p2wpkh transfers and BIP300 deposits with replay-aware coin selection |
| `treasuryScript`, `depositOutputs`, `normalizeSidechainAddress`, `getCtip`, `getSidechains` | BIP300 M5 details and enforcer (Connect JSON over HTTP) lookups |
| `ReplayChecker` | Classifies inputs as `ecx-only`, `spent-on-bitcoin` or `shared` via a Bitcoin Esplora API |
| `Esplora` | Minimal Esplora REST client |

## eCash facts this relies on

- ECX changed one consensus rule (difficulty at the fork height 973,728). Addresses,
  scripts, sighash and the `"Bitcoin Signed Message:\n"` magic are Bitcoin's, so
  there is **no replay protection**: a transaction is safe from replay on Bitcoin
  only if one of its inputs cannot exist there.
- A deposit spends the slot's treasury (`OP_DRIVECHAIN(0xb7) PUSH1 <slot> OP_TRUE`)
  and recreates it with the deposit added, immediately followed by
  `OP_RETURN <bare base58 sidechain address>`. Take the treasury from the enforcer,
  never from an indexer: stray payments to the treasury script are not the treasury.

## License

MIT. Derived from sats-connect-core, © 2025 Secret Key Labs.
