#!/bin/bash
# Testnet faucet top-up (run every hour by cron, see site/setup-testnet-web.sh). When the faucet holds less than
# FAUCET_LOW test ZP, the node's wallet sends it more, but never takes the node's wallet below FAUCET_RESERVE: the oracle,
# the market maker and the bridge pay from that wallet too. Nothing to send: it logs that and tries again next hour.
# Testnet only: refuses to run against any other chain.
#
#   bash scripts/faucet-topup.sh            (FAUCET_LOW=5000 FAUCET_TOPUP=20000 FAUCET_RESERVE=10000 FAUCET_MIN=1000, in ZP)
set -uo pipefail
NODE=${NODE:-http://127.0.0.1:31567}; FAUCET=${FAUCET:-http://127.0.0.1:8095}; PW=${TESTNET_PASSWORD:-testnet}
LOW=${FAUCET_LOW:-5000}; TOPUP=${FAUCET_TOPUP:-20000}; RESERVE=${FAUCET_RESERVE:-10000}; MIN=${FAUCET_MIN:-1000}
say() { echo "$(date -u +%FT%TZ) $*"; }
CHAIN=$(curl -fs -m 10 "$NODE/blockchain/info" | python3 -c 'import json,sys;print(json.load(sys.stdin)["chain"])' 2>/dev/null)
[ "$CHAIN" = testnet ] || { say "node is not on the testnet (chain '${CHAIN:-unreachable}'): nothing done"; exit 1; }
read -r ADDR FBAL <<< "$(curl -fs -m 20 "$FAUCET/faucet/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["address"], d["balance"].replace(",",""))' 2>/dev/null)"
[ -n "${ADDR:-}" ] || { say "faucet not reachable: nothing done"; exit 1; }
NBAL=$(curl -fs -m 20 "$NODE/wallet/balance" | python3 -c 'import json,sys;print(sum(int(b["balance"]) for b in json.load(sys.stdin) if b["asset"]=="00")//100000000)' 2>/dev/null)
[ -n "${NBAL:-}" ] || { say "node wallet balance not readable: nothing done"; exit 1; }
FBAL=${FBAL%%.*}
if [ "$FBAL" -ge "$LOW" ]; then say "faucet holds $FBAL ZP (>= $LOW): no top-up needed"; exit 0; fi
SEND=$(( NBAL - RESERVE )); [ "$SEND" -gt "$TOPUP" ] && SEND=$TOPUP
if [ "$SEND" -lt "$MIN" ]; then say "faucet holds $FBAL ZP, node wallet $NBAL ZP (reserve $RESERVE): not enough to send, trying again next hour"; exit 0; fi
OUT=$(curl -s -m 60 -X POST -H 'Content-Type: application/json' -d "{\"outputs\":[{\"address\":\"$ADDR\",\"asset\":\"00\",\"amount\":\"${SEND}00000000\"}],\"password\":\"$PW\"}" "$NODE/wallet/send")
if echo "$OUT" | grep -qE '^"?[0-9a-f]{64}"?$'; then say "faucet held $FBAL ZP: sent $SEND ZP from the node wallet ($NBAL ZP before): $OUT"
else say "top-up of $SEND ZP failed: $(echo "$OUT" | head -c 200)"; exit 1; fi
