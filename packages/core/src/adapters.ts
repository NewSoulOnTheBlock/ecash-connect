/**
 * Adapters, as in sats-connect: a uniform `request()` over one wallet. Wallets
 * that speak eCash Connect natively use BaseAdapter; a wallet with its own API
 * gets a subclass that translates.
 */
import type { Method, RpcParams } from './methods';
import { getProviderById, type AddListener, type ProviderInfo } from './provider';
import { requestWith, type RequestReturn } from './request';

export abstract class EcashConnectAdapter {
  abstract readonly id: string;
  abstract requestInternal<M extends Method>(method: M, params: RpcParams<M>): Promise<RequestReturn<M>>;
  abstract addListener: AddListener;

  request<M extends Method>(method: M, params: RpcParams<M>): Promise<RequestReturn<M>> {
    return this.requestInternal(method, params);
  }
}

export class BaseAdapter extends EcashConnectAdapter {
  constructor(readonly id: string) {
    super();
  }

  private provider() {
    const p = getProviderById(this.id);
    if (!p) throw new Error(`eCash wallet ${this.id} is not installed`);
    return p;
  }

  requestInternal<M extends Method>(method: M, params: RpcParams<M>): Promise<RequestReturn<M>> {
    return requestWith(this.provider(), method, params);
  }

  addListener: AddListener = (info) => {
    const p = this.provider();
    return p.addListener ? p.addListener(info) : () => {};
  };
}

const CAT_ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#16130f"/><path d="M14 50V20l10 9h16l10-9v30a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6z" fill="#f5a524"/><circle cx="26" cy="39" r="3.2" fill="#16130f"/><circle cx="38" cy="39" r="3.2" fill="#16130f"/><path d="M29 46h6l-3 3z" fill="#16130f"/></svg>'
  );

/** Wallets eCash Connect knows about, so the selector can offer them. */
export const DefaultAdaptersInfo: Record<string, ProviderInfo> = {
  ecashCat: {
    id: 'EcashCatWallet.EcashProvider',
    name: 'eCash Cat Wallet',
    icon: CAT_ICON,
  },
};

export const defaultAdapters: Record<string, new (id: string) => EcashConnectAdapter> = {
  [DefaultAdaptersInfo.ecashCat!.id]: BaseAdapter,
};
