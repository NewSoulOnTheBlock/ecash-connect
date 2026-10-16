/** Constants shared by the inpage script, content script, background and popup. */
export const FROM_PAGE = 'ecash-cat-wallet:page';
export const FROM_CONTENT = 'ecash-cat-wallet:content';
export const PROVIDER_ID = 'EcashCatWallet.EcashProvider';
export const WALLET_NAME = 'eCash Cat Wallet';

/** Same mark as @ecash-connect/core's DefaultAdaptersInfo, so the selector shows one icon. */
export const WALLET_ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#16130f"/><path d="M14 50V20l10 9h16l10-9v30a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6z" fill="#f5a524"/><circle cx="26" cy="39" r="3.2" fill="#16130f"/><circle cx="38" cy="39" r="3.2" fill="#16130f"/><path d="M29 46h6l-3 3z" fill="#16130f"/></svg>'
  );

/** Messages a content script sends the background. */
export type ContentToBackground = { type: 'rpc'; id: string; method: string; params: unknown };

/** What the background pushes to tabs. */
export type BackgroundToContent = { type: 'ecash-event'; targets: string[]; event: unknown };
