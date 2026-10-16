# Chrome Web Store Listing — eCash Cat Wallet

> Last Updated: 2026-10-16

## Store Listing

**Extension Name**
eCash Cat Wallet

**Short Description** (≤132)
Hold eCash (ECX), approve what websites ask to sign, and move ECX into eCash sidechains, with protection against replay onto Bitcoin.

**Detailed Description**
eCash Cat Wallet holds your eCash (ECX) and lets eCash websites ask you to connect, sign a message, or send a payment, and every request waits for your approval.

Features:
Create a new wallet or import a 12 or 24 word recovery phrase.
See your ECX balance and address, and send ECX.
Approve or reject each website request in a window that shows exactly what will be signed or sent, the fee, and where every coin goes.
Sign messages to prove you own an address, for logging in to eCash sites.
Deposit ECX into an eCash sidechain, with the deposit address checked before anything is sent.
Replay protection: eCash shares its history with Bitcoin, so the wallet refuses to sign a payment that could also be valid on Bitcoin and move your BTC.
Connected sites are listed and can be disconnected at any time.

How to use:
1. Click the cat icon and create or import a wallet.
2. Visit an eCash website and click its connect button.
3. Review each request in the wallet window, then approve or reject it.

Privacy:
Your recovery phrase never leaves your browser and is stored encrypted with your password. Websites learn your address only after you connect them. The wallet reads balances and sends transactions through the eCash servers you choose in Settings.

**Category**
Developer Tools (until mainnet; then Productivity or the closest finance-related category offered)

**Single Purpose**
A wallet that holds eCash (ECX) and signs only what the user approves for eCash websites.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | static/icons/icon-128.png |
| Screenshot 1 | 1280×800 | ⬜ Not created | |
| Screenshot 2 | 1280×800 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |

### Screenshot Notes
1. The wallet popup with a balance and the Send / Deposit buttons.
2. A website's connect prompt next to the site (demo dapp + approval window).
3. A send approval showing recipients, fee and the replay-protection line.
4. A sidechain deposit approval.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | Stores the password-encrypted recovery phrase, the wallet's public address, the list of sites the user connected, and the user's server settings on this device. Session storage keeps the wallet unlocked until it auto-locks or the browser closes. |
| alarms | permissions | A once-a-minute check that locks the wallet after 15 minutes without use. |
| http://*/*, https://*/* (content_scripts) | content scripts | Adds the wallet's connect interface to web pages so eCash websites can ask to connect and request signatures. It reads nothing from the page and does nothing until the site sends a request. |
| http://127.0.0.1/*, http://localhost/* | host_permissions | Reaches an eCash node, indexer and drivechain enforcer the user runs on their own computer, the default setup for eCash development networks. |
| https://mempool.space/* | host_permissions | Checks whether the coins a payment spends also exist on Bitcoin, so the wallet can refuse payments that could be replayed there. Only transaction ids are sent. |
| https://*/*, http://*/* | optional_host_permissions | Requested only when the user enters their own eCash server address in Settings, and only for that server's origin. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes, financial info only, and only to run the wallet.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | | No |
| Health info | No | No | | No |
| Financial info | Yes: wallet address, balance, transactions | Yes: to the eCash servers the user configures (address and signed transactions); transaction ids to mempool.space for the replay check | Show balance, build and broadcast transactions | Only the servers listed |
| Authentication info | Yes: recovery phrase, encrypted with the user's password | No | Signing | No |
| Personal communications | No | No | | No |
| Location | No | No | | No |
| Web history | Yes: origins of sites the user chose to connect | No | Lets connected sites skip the connect prompt; user can disconnect | No |
| User activity | No | No | | No |
| Website content | No | No | | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**: not yet published (needed before submission). Suggested home: www.ecashcat.site/wallet/privacy.

## Distribution

**Visibility**: Unlisted until eCash mainnet support is configured and tested.
**Regions**: All regions

## Developer Info

**Publisher Name**: to fill in
**Contact Email**: to fill in (shown publicly)
**Support URL**: to fill in
**Homepage URL**: https://www.ecashcat.site

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-10-16 | First version: wallet, eCash Connect requests, BIP322/ECDSA signing, PSBT signing, transfers, sidechain deposits, Bitcoin replay guard | Draft |

## Review Notes

### Known Issues / Limitations
- Mainnet and betanet need the user to enter an eCash indexer in Settings; only the local devnet has defaults.
- One address per network (no address rotation yet).
- Financial-category extensions get extra review scrutiny; the description avoids price, investment or return claims.
