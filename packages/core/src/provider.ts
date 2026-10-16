/**
 * How dapps find eCash wallets. Same scheme as sats-connect: a wallet puts its
 * provider object somewhere on `window` and announces itself in a shared
 * registry, here `window.ecash_providers` (sats-connect: `btc_providers`).
 * A provider id is the object path from `window`, e.g.
 * `EcashCatWallet.EcashProvider`.
 */
import type { Method, RpcParams } from './methods';
import type { NetworkInfo, Address } from './methods';
import type { SpecResponse } from './rpcSpec';

export type AccountChangeEvent = { type: 'accountChange'; addresses?: Address[] };
export type NetworkChangeEvent = { type: 'networkChange'; ecash: NetworkInfo['ecash']; addresses?: Address[] };
export type DisconnectEvent = { type: 'disconnect' };
export type WalletEvent = AccountChangeEvent | NetworkChangeEvent | DisconnectEvent;

export type ListenerInfo =
  | { eventName: 'accountChange'; cb: (e: AccountChangeEvent) => void }
  | { eventName: 'networkChange'; cb: (e: NetworkChangeEvent) => void }
  | { eventName: 'disconnect'; cb: (e: DisconnectEvent) => void };

export type AddListener = (info: ListenerInfo) => () => void;

/** What a wallet must expose on `window`. */
export interface EcashProvider {
  request: <M extends Method>(method: M, params: RpcParams<M>) => Promise<SpecResponse>;
  addListener?: AddListener;
}

export interface ProviderInfo {
  /** Object path from `window` to the provider. */
  id: string;
  name: string;
  /** Data URI or URL. */
  icon: string;
  webUrl?: string;
  chromeWebStoreUrl?: string;
  mozillaAddOnsUrl?: string;
  methods?: Method[];
}

export interface SupportedWallet extends ProviderInfo {
  isInstalled: boolean;
}

declare global {
  interface Window {
    EcashProvider?: EcashProvider;
    ecash_providers?: ProviderInfo[];
  }
}

export function getProviders(): ProviderInfo[] {
  if (!window.ecash_providers) window.ecash_providers = [];
  return window.ecash_providers;
}

export function getProviderById(providerId: string): EcashProvider | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return providerId?.split('.').reduce((acc: any, part) => acc?.[part], window);
}

export function isProviderInstalled(providerId: string) {
  return !!getProviderById(providerId);
}

/** The first provider found: the default slot, then the first registered one. */
export function getDefaultInstalledProvider(): EcashProvider | undefined {
  if (window.EcashProvider) return window.EcashProvider;
  for (const p of getProviders()) {
    const found = getProviderById(p.id);
    if (found) return found;
  }
  return undefined;
}

const DEFAULT_PROVIDER_KEY = 'ecash-connect_defaultProvider';

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function setDefaultProvider(providerId: string) {
  storage()?.setItem(DEFAULT_PROVIDER_KEY, providerId);
}

export function getDefaultProvider() {
  return storage()?.getItem(DEFAULT_PROVIDER_KEY) ?? null;
}

export function removeDefaultProvider() {
  storage()?.removeItem(DEFAULT_PROVIDER_KEY);
}

/**
 * Wallets a dapp can offer: every wallet that registered itself, plus the
 * known ones (so the selector can show an install prompt for them).
 */
export function getSupportedWallets(known: ProviderInfo[] = []): SupportedWallet[] {
  const byId = new Map<string, ProviderInfo>();
  for (const p of known) byId.set(p.id, p);
  for (const p of getProviders()) byId.set(p.id, { ...byId.get(p.id), ...p });
  return [...byId.values()].map((p) => ({ ...p, isInstalled: isProviderInstalled(p.id) }));
}
