/**
 * eCash Connect: the dapp entry point. A port of sats-connect's `Wallet`
 * (MIT, Secret Key Labs) onto @ecash-connect/core and the forked selector UI.
 *
 *   import Wallet from 'ecash-connect';
 *   const res = await Wallet.request('getAddresses', { purposes: ['payment'] });
 *
 * The first request opens the wallet selector unless a wallet was chosen
 * before; the choice is remembered per site.
 */
import {
  BaseAdapter,
  DefaultAdaptersInfo,
  defaultAdapters,
  getDefaultProvider,
  getSupportedWallets,
  isProviderInstalled,
  removeDefaultProvider,
  RpcErrorCode,
  setDefaultProvider,
  type AddListener,
  type EcashConnectAdapter,
  type ListenerInfo,
  type Method,
  type RequestReturn,
  type RpcParams,
  type SupportedWallet,
} from '@ecash-connect/core';
import { close, loadSelector, selectWalletProvider, walletClose, walletOpen, type Config } from '@ecash-connect/ui';

/** Installed wallets first; known but missing ones get an install prompt when they have a URL. */
export function makeDefaultConfig(providers: SupportedWallet[]): Config {
  const options = providers
    .filter((p) => p.isInstalled || p.chromeWebStoreUrl || p.mozillaAddOnsUrl || p.webUrl)
    .sort((a, b) => Number(b.isInstalled) - Number(a.isInstalled))
    .map((p) => ({
      name: p.name,
      id: p.id,
      icon: p.icon,
      installPrompt: p.isInstalled ? undefined : { url: (p.chromeWebStoreUrl ?? p.mozillaAddOnsUrl ?? p.webUrl)! },
    }));
  return { options };
}

export class Wallet {
  private providerId: string | undefined;
  private createCustomConfig?: (providers: SupportedWallet[]) => Config;
  private readonly adapters: Record<string, new (id: string) => EcashConnectAdapter> = { ...defaultAdapters };

  /** Replace the selector's wallet list (order, names, install links). */
  setCreateCustomConfig(createCustomConfig: (providers: SupportedWallet[]) => Config) {
    this.createCustomConfig = createCustomConfig;
  }

  /** Register an adapter for a wallet that does not speak eCash Connect natively. */
  registerAdapter(providerId: string, adapter: new (id: string) => EcashConnectAdapter) {
    this.adapters[providerId] = adapter;
  }

  /** Wallets the selector would offer: registered ones plus the known list. */
  getWallets(): SupportedWallet[] {
    return getSupportedWallets(Object.values(DefaultAdaptersInfo));
  }

  async selectProvider() {
    const wallets = this.getWallets();
    const config = this.createCustomConfig ? this.createCustomConfig(wallets) : makeDefaultConfig(wallets);
    if (!config.options.length) throw new Error('No eCash wallets detected; prompt the user to install one.');
    this.providerId = await selectWalletProvider(config);
  }

  async disconnect() {
    if (this.providerId || getDefaultProvider()) await this.request('wallet_renouncePermissions', undefined);
    this.providerId = undefined;
    removeDefaultProvider();
  }

  private adapter(): EcashConnectAdapter {
    const id = this.providerId!;
    const A = this.adapters[id] ?? BaseAdapter;
    return new A(id);
  }

  async request<const M extends Method>(method: M, params: RpcParams<M>): Promise<RequestReturn<M>> {
    loadSelector();
    const remembered = getDefaultProvider();
    if (!this.providerId) {
      if (remembered && isProviderInstalled(remembered)) this.providerId = remembered;
      else {
        try {
          await this.selectProvider();
        } catch (e) {
          // The selector rejects with nothing on cancel; selectProvider throws when no wallet exists.
          const noWallet = e instanceof Error;
          return {
            status: 'error',
            error: noWallet
              ? { code: RpcErrorCode.INTERNAL_ERROR, message: 'No eCash wallet is installed. Install one (for example eCash Cat Wallet), then reload this page.' }
              : { code: RpcErrorCode.USER_REJECTION, message: 'The wallet picker was closed without choosing a wallet.' },
          };
        }
      }
    }
    walletOpen(this.providerId!);
    let response: RequestReturn<M>;
    try {
      response = await this.adapter().request(method, params);
    } catch (e) {
      response = { status: 'error', error: { code: RpcErrorCode.INTERNAL_ERROR, message: (e as Error).message } };
    } finally {
      walletClose();
      close();
    }
    if (response.status === 'error' && response.error.code === RpcErrorCode.USER_REJECTION) {
      // A rejection on the very first request lets the user pick another wallet next time.
      if (!remembered) this.providerId = undefined;
    } else {
      setDefaultProvider(this.providerId!);
    }
    return response;
  }

  addListener: AddListener = (info: ListenerInfo) => {
    const remembered = getDefaultProvider();
    if (!this.providerId && remembered) this.providerId = remembered;
    if (!this.providerId) {
      console.error('No wallet selected yet: make a request first, then add listeners.');
      return () => {};
    }
    return this.adapter().addListener(info);
  };
}

export * from '@ecash-connect/core';
export type { Config } from '@ecash-connect/ui';

export default new Wallet();
