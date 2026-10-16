/** JSON-RPC error codes, as in sats-connect, plus eCash's own. */
export enum RpcErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  /** The user rejected or closed the request. */
  USER_REJECTION = -32000,
  /** The method needs a connected site. */
  ACCESS_DENIED = -32002,
  /** The wallet is locked or not set up. */
  WALLET_LOCKED = -32003,
  /**
   * The transaction could be replayed on Bitcoin and spend the same coins
   * there. See replay.ts.
   */
  REPLAY_UNSAFE = -32010,
  /** Not enough confirmed and pending ECX to cover the transaction. */
  INSUFFICIENT_FUNDS = -32011,
}

export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}
