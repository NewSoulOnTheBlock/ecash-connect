/**
 * eCash (ECX) networks. ECX is a Bitcoin fork whose only consensus change is
 * the difficulty at the fork block (EcashHeight). Addresses, script, sighash
 * and the signed-message magic are Bitcoin's, byte for byte. That is why the
 * same keys and PSBTs work, and why replay protection is the wallet's job
 * (see replay.ts).
 *
 * Verified against github.com/ecash-com/bitcoin src/kernel/chainparams.cpp.
 */

export enum EcashNetworkType {
  Mainnet = 'Mainnet',
  Betanet = 'Betanet',
  Regtest = 'Regtest',
}

/** The shape @scure/btc-signer expects for address encoding. */
export interface BtcSignerNetwork {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
}

export interface EcashNetworkParams {
  name: EcashNetworkType;
  /** Address encoding, identical to the matching Bitcoin network. */
  address: BtcSignerNetwork;
  /** BIP44 coin type used for key derivation (0 on mainnet, so a Bitcoin seed finds its fork coins). */
  coinType: number;
  /** P2P message start (network magic) as hex. */
  magic: string;
  p2pPort: number;
  /** First ECX-only block, or 0 when the network never shared history with Bitcoin. */
  forkHeight: number;
  /** BIP300 OP_DRIVECHAIN opcode on this network (OP_NOP8). */
  opDrivechain: number;
  /**
   * A Bitcoin Esplora API whose chain shares this network's pre-fork history.
   * Set only where replay onto Bitcoin is possible.
   */
  replayEsplora?: string;
}

export const OP_DRIVECHAIN = 0xb7;

export const ECASH_NETWORKS: Record<EcashNetworkType, EcashNetworkParams> = {
  [EcashNetworkType.Mainnet]: {
    name: EcashNetworkType.Mainnet,
    address: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
    coinType: 0,
    magic: 'eca5dcb7',
    p2pPort: 8533,
    forkHeight: 973_728,
    opDrivechain: OP_DRIVECHAIN,
    replayEsplora: 'https://mempool.space/api',
  },
  // Master's CTestNetParams (eca5b114, port 18533). Check against the betanet
  // branch before relying on it.
  [EcashNetworkType.Betanet]: {
    name: EcashNetworkType.Betanet,
    address: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    coinType: 1,
    magic: 'eca5b114',
    p2pPort: 18533,
    forkHeight: 0,
    opDrivechain: OP_DRIVECHAIN,
  },
  [EcashNetworkType.Regtest]: {
    name: EcashNetworkType.Regtest,
    address: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    coinType: 1,
    magic: 'eca5b134',
    p2pPort: 18644,
    forkHeight: 0,
    opDrivechain: OP_DRIVECHAIN,
  },
};

/** Where a wallet reads the chain and the drivechain peg for one network. */
export interface EcashEndpoints {
  /** Esplora REST API of an ECX indexer (mempool/electrs). */
  esplora: string;
  /** bip300301_enforcer, spoken as Connect JSON over HTTP. Needed for deposits. */
  enforcer?: string;
}

/**
 * Defaults a wallet can start from. Only the local devnet has known public
 * endpoints today; mainnet and betanet must be configured by the user.
 */
export const DEFAULT_ENDPOINTS: Partial<Record<EcashNetworkType, EcashEndpoints>> = {
  [EcashNetworkType.Regtest]: {
    esplora: 'http://127.0.0.1:3002',
    enforcer: 'http://127.0.0.1:50051',
  },
};
