#!/usr/bin/env bash
# Devnet helper for the wallet e2e test, run inside WSL:
#   devnet.sh fund <address> <sats>   send from the enforcer wallet
#   devnet.sh mine [n]                mine n L1 blocks through the enforcer
#   devnet.sh describe                print the SendTransaction request shape
set -euo pipefail
DEVNET=${DEVNET:-/mnt/c/Users/roota/dev/ecash-cat-chain/devnet}
# shellcheck source=/dev/null
source "$DEVNET/lib.sh"

case "${1:-}" in
  fund)
    body=$(jq -nc --arg a "$2" --arg v "$3" '{destinations: {($a): ($v | tonumber)}}')
    grpc WalletService SendTransaction "$body" | jq -r '.txid.hex // .txid'
    ;;
  mine)
    mine_l1 "${2:-1}"
    btc getblockcount
    ;;
  describe)
    grpcurl -plaintext "127.0.0.1:$ENFORCER_GRPC_PORT" describe cusf.mainchain.v1.SendTransactionRequest
    ;;
  *)
    echo "usage: $0 fund <address> <sats> | mine [n] | describe" >&2
    exit 2
    ;;
esac
