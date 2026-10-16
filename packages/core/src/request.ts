/**
 * `request()` and `addListener()`: sats-connect's calling convention. Every
 * call resolves to `{ status: 'success', result }` or
 * `{ status: 'error', error }` and never throws for wallet-side errors.
 */
import * as v from 'valibot';
import { RpcErrorCode } from './errors';
import type { Method, RpcParams, RpcResult } from './methods';
import { getDefaultInstalledProvider, getProviderById, type AddListener, type EcashProvider, type ListenerInfo } from './provider';
import { specErrorResponseSchema, specSuccessWithExtensionsResponseSchema, type SpecErrorResponse } from './rpcSpec';

export type RequestReturn<M extends Method> =
  | { status: 'success'; result: RpcResult<M> }
  | { status: 'error'; error: SpecErrorResponse['error'] };

function resolveProvider(providerId?: string): EcashProvider {
  const provider = providerId ? getProviderById(providerId) : getDefaultInstalledProvider();
  if (!provider) throw new Error('No eCash wallet provider was found');
  return provider;
}

export async function requestWith<const M extends Method>(
  provider: EcashProvider,
  method: M,
  params: RpcParams<M>
): Promise<RequestReturn<M>> {
  const response = await provider.request(method, params);
  if (v.is(specErrorResponseSchema, response)) return { status: 'error', error: response.error };
  if (v.is(specSuccessWithExtensionsResponseSchema, response))
    return { status: 'success', result: response.result as RpcResult<M> };
  return {
    status: 'error',
    error: { code: RpcErrorCode.INTERNAL_ERROR, message: 'Received unknown response from provider.', data: response },
  };
}

export async function request<const M extends Method>(
  method: M,
  params: RpcParams<M>,
  /** Object path to the provider on `window`, e.g. `EcashCatWallet.EcashProvider`. */
  providerId?: string
): Promise<RequestReturn<M>> {
  if (!method) throw new Error('A wallet method is required');
  return requestWith(resolveProvider(providerId), method, params);
}

export function addListener(info: ListenerInfo, providerId?: string): ReturnType<AddListener> {
  const provider = resolveProvider(providerId);
  if (!provider.addListener) {
    console.error('This eCash wallet does not support addListener.');
    return () => {};
  }
  return provider.addListener(info);
}
