/**
 * The eCash Connect method table. Names and payloads follow sats-connect's
 * `bitcoin` and `wallet` namespaces so a sats-connect dapp ports by changing
 * its import; `drivechain_*` and `ecash_*` are eCash's own additions.
 *
 * One table instead of sats-connect's file-per-method layout: every method's
 * params and result schema sit side by side, and the request/response types
 * are derived from it.
 */
import * as v from 'valibot';
import { EcashNetworkType } from './networks';

export enum AddressPurpose {
  Payment = 'payment',
}

export enum AddressType {
  p2wpkh = 'p2wpkh',
}

export enum MessageSigningProtocols {
  ECDSA = 'ECDSA',
  BIP322 = 'BIP322',
}

export const addressSchema = v.object({
  address: v.string(),
  /** Compressed public key, hex. */
  publicKey: v.string(),
  purpose: v.enum(AddressPurpose),
  addressType: v.enum(AddressType),
});
export type Address = v.InferOutput<typeof addressSchema>;

export const networkSchema = v.object({ ecash: v.object({ name: v.enum(EcashNetworkType) }) });
export type NetworkInfo = v.InferOutput<typeof networkSchema>;

/** Amounts in a balance are strings: Chrome messaging cannot carry bigint. */
export const balanceSchema = v.object({
  confirmed: v.string(),
  unconfirmed: v.string(),
  total: v.string(),
});

const accountSchema = v.object({
  id: v.string(),
  addresses: v.array(addressSchema),
  walletType: v.picklist(['software']),
  network: networkSchema,
});

export const replayInputSchema = v.object({
  txid: v.string(),
  vout: v.number(),
  /**
   * `ecx-only`: the funding tx is not on Bitcoin. `spent-on-bitcoin`: it is, but
   * this outpoint is already spent there. `shared`: the same coin is live on
   * Bitcoin, so a tx spending only shared inputs can be replayed there.
   */
  status: v.picklist(['ecx-only', 'spent-on-bitcoin', 'shared']),
});

export const replayReportSchema = v.object({
  /** True when at least one input cannot exist on Bitcoin, so the tx cannot be replayed there. */
  safe: v.boolean(),
  /** False on networks with no Bitcoin history to replay onto. */
  applicable: v.boolean(),
  inputs: v.array(replayInputSchema),
});
export type ReplayReport = v.InferOutput<typeof replayReportSchema>;

const sidechainSchema = v.object({
  slot: v.number(),
  title: v.string(),
  description: v.string(),
  activationHeight: v.optional(v.number()),
  /** The treasury UTXO (CTIP); absent before the first deposit. */
  treasury: v.optional(v.object({ txid: v.string(), vout: v.number(), value: v.string() })),
});
export type SidechainInfo = v.InferOutput<typeof sidechainSchema>;

const empty = v.optional(v.nullable(v.undefined()));

export const methods = {
  // ---- discovery ---------------------------------------------------------
  getInfo: {
    params: empty,
    result: v.object({
      version: v.string(),
      /** Methods this wallet implements. */
      methods: v.array(v.string()),
      supports: v.array(v.string()),
    }),
  },

  // ---- wallet ------------------------------------------------------------
  wallet_connect: {
    params: v.optional(
      v.nullable(
        v.object({
          addresses: v.optional(v.array(v.enum(AddressPurpose))),
          /** Shown to the user on the approval screen. */
          message: v.optional(v.pipe(v.string(), v.maxLength(80))),
          network: v.optional(v.enum(EcashNetworkType)),
        })
      )
    ),
    result: accountSchema,
  },
  wallet_disconnect: { params: empty, result: v.nullable(v.undefined()) },
  wallet_renouncePermissions: { params: empty, result: v.nullable(v.undefined()) },
  wallet_getAccount: { params: empty, result: accountSchema },
  wallet_getNetwork: { params: empty, result: networkSchema },
  wallet_getCurrentPermissions: {
    params: empty,
    result: v.array(v.object({ type: v.literal('account'), origin: v.string() })),
  },

  // ---- ecash (sats-connect's `bitcoin` namespace) -------------------------
  getAddresses: {
    params: v.object({
      purposes: v.array(v.enum(AddressPurpose)),
      message: v.optional(v.string()),
    }),
    result: v.object({ addresses: v.array(addressSchema), network: networkSchema }),
  },
  getBalance: { params: empty, result: balanceSchema },
  signMessage: {
    params: v.object({
      address: v.string(),
      message: v.string(),
      /** Defaults to BIP322 for p2wpkh. ECDSA gives a BIP137 signature. */
      protocol: v.optional(v.enum(MessageSigningProtocols)),
    }),
    result: v.object({
      signature: v.string(),
      messageHash: v.string(),
      address: v.string(),
      protocol: v.enum(MessageSigningProtocols),
    }),
  },
  signPsbt: {
    params: v.object({
      /** Base64 PSBT. */
      psbt: v.string(),
      /** address -> input indexes to sign. Omitted: every input the wallet owns. */
      signInputs: v.optional(v.record(v.string(), v.array(v.number()))),
      broadcast: v.optional(v.boolean()),
    }),
    result: v.object({ psbt: v.string(), txid: v.optional(v.string()), replay: replayReportSchema }),
  },
  sendTransfer: {
    params: v.object({
      recipients: v.pipe(
        v.array(v.object({ address: v.string(), amount: v.pipe(v.number(), v.integer(), v.minValue(1)) })),
        v.minLength(1)
      ),
      /** sat/vB; the wallet picks one when omitted. */
      feeRate: v.optional(v.pipe(v.number(), v.minValue(1))),
      broadcast: v.optional(v.boolean()),
    }),
    result: v.object({ txid: v.string(), transaction: v.string() }),
  },

  // ---- drivechain (BIP300) ------------------------------------------------
  drivechain_getSidechains: { params: empty, result: v.array(sidechainSchema) },
  drivechain_deposit: {
    params: v.object({
      slot: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)),
      /** The address on the sidechain, as that sidechain's wallet prints it. */
      sidechainAddress: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      /** Sats to move into the sidechain. */
      amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
      feeRate: v.optional(v.pipe(v.number(), v.minValue(1))),
    }),
    result: v.object({ txid: v.string(), transaction: v.string(), treasuryValue: v.string() }),
  },

  // ---- eCash-specific ----------------------------------------------------
  ecash_checkReplay: { params: v.object({ psbt: v.string() }), result: replayReportSchema },
} as const;

export type Methods = typeof methods;
export type Method = keyof Methods;
export type RpcParams<M extends Method> = v.InferInput<Methods[M]['params']>;
export type RpcResult<M extends Method> = v.InferOutput<Methods[M]['result']>;
/** sats-connect's names for the same types. */
export type RpcRequestParams<M extends Method> = RpcParams<M>;
export type RpcSuccessResponseResult<M extends Method> = RpcResult<M>;

export const METHOD_NAMES = Object.keys(methods) as Method[];

/** Methods a site may call before the user has connected it. */
export const PUBLIC_METHODS: readonly Method[] = ['getInfo', 'wallet_connect', 'getAddresses', 'wallet_getCurrentPermissions'];

export function isMethod(name: unknown): name is Method {
  return typeof name === 'string' && Object.hasOwn(methods, name);
}

export function parseParams<M extends Method>(method: M, params: unknown) {
  return v.safeParse(methods[method].params, params);
}
