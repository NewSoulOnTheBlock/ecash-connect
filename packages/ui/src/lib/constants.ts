import { Config } from "./utils";

export const select = "ecash-connect_wallet-provider-selector_select";
export const cancel = "ecash-connect_wallet-provider-selector_cancel";
export const open = "ecash-connect_wallet-provider-selector_open";
export const close = "ecash-connect_wallet-provider-selector_close";
export const walletOpen = "ecash-connect_wallet-provider-selector_walletOpen";
export const walletClose = "ecash-connect_wallet-provider-selector_walletClose";

// Allow adding custom event listeners to the window object.
declare global {
  interface WindowEventMap {
    "ecash-connect_wallet-provider-selector_select": CustomEvent<string>;
    "ecash-connect_wallet-provider-selector_cancel": CustomEvent;
    "ecash-connect_wallet-provider-selector_open": CustomEvent<Config>;
    "ecash-connect_wallet-provider-selector_close": CustomEvent;
    "ecash-connect_wallet-provider-selector_walletOpen": CustomEvent<string>;
    "ecash-connect_wallet-provider-selector_walletClose": CustomEvent;
  }
}
