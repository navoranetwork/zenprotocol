#!/bin/bash
# V1 contracts end to end on a real local node (not the test runner, whose host has FSharp.Core 10
# and resolves assemblies for the contract; a node does not):
#   1. start a Debug node on the local chain with its miner, ZP_NODE_V1_ONLY=1 (no V0 tooling);
#   2. import the local genesis wallet;
#   3. zp-engine make token  -> a verified contract (check, test, proven build);
#   4. zp-engine publish      -> HighV(1) activation through the node's wallet; wait until active;
#   5. zp-engine call buy     -> 500 ZP in, 500 of the contract's token back to the wallet.
#
# usage: ZP_V1_TOOLCHAIN=<zp-contracts-v1> FSTAR_HOME=<F*> scripts/v1-local-e2e.sh
# Builds src/Node in Debug first if needed. Uses ports 10000/20000 and a fresh data folder.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="${ZP_V1_TOOLCHAIN:?set ZP_V1_TOOLCHAIN to a zp-contracts-v1 checkout (Zulib verified)}"
: "${FSTAR_HOME:?set FSTAR_HOME}"
BIN="$ROOT/src/Node/bin/Debug"
API=http://127.0.0.1:20000
WORK="$(mktemp -d)"; LOG="$WORK/node.log"
MNEMONIC="feel muffin volcano click mercy abuse bachelor ginger limb tomorrow okay input spend athlete boring security document exclude liar dune usage camera ranch thought"
export ZP_WALLET_PASSWORD=e2e-1234

[ -f "$BIN/zen-node.dll" ] || dotnet build "$ROOT/src/Node/Node.fsproj" -c Debug --configfile "$ROOT/nuget.mirror.config" -v q
curl -s -m 2 "$API/blockchain/info" > /dev/null && { echo "a node already answers on $API; stop it first"; exit 1; }

PID=
start() {
  (cd "$BIN" && ZP_NODE_V1_ONLY=1 ZP_V1_TOOLCHAIN="$TC" FSTAR_HOME="$FSTAR_HOME" PATH="$FSTAR_HOME/bin:$PATH" \
     exec dotnet zen-node.dll --local 0 --miner 1 >> "$LOG" 2>&1) &
  PID=$!
  for _ in $(seq 60); do curl -s -m 2 "$API/blockchain/info" > /dev/null && return; sleep 1; done
  echo "node did not start"; tail -20 "$LOG"; exit 1
}
stop() { if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; PID=; }
trap 'stop' EXIT
post() { curl -sf -H 'Content-Type: application/json' -X POST "$API/$1" -d "$2"; }

rm -rf "$BIN/data/local/0"
start
words=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1].split()))' "$MNEMONIC")
post wallet/import "{\"words\": $words, \"password\": \"$ZP_WALLET_PASSWORD\"}" > /dev/null
curl -sf "$API/wallet/resync" > /dev/null
for _ in $(seq 30); do curl -s "$API/wallet/balance" | grep -q '"00"' && break; sleep 1; done
sleep 3                # let the wallet write its account before the restart
stop; start            # the miner takes its address from the wallet at start
for _ in $(seq 30); do curl -s "$API/wallet/balance" | grep -q '"00"' && break; sleep 1; done
echo "node up on the local chain; wallet: $(curl -s "$API/wallet/balance")"

"$TC/tools/engine/zp-engine" make token --out "$WORK/token" > /dev/null
echo "made: token contract $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contractId"])' "$WORK/token/report.json")"

"$TC/tools/engine/zp-engine" publish "$WORK/token" --node "$API" --blocks 100 --wait --timeout 600 --yes > /dev/null
cid=$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["active"], p; print(p["contractId"])' "$WORK/token/publish.json")
echo "published and active: $cid"

before=$(curl -s "$API/wallet/balance")
"$TC/tools/engine/zp-engine" call "$WORK/token" --node "$API" --command buy --spend 00:500 --return-address > /dev/null
for _ in $(seq 60); do
  bal=$(curl -s "$API/wallet/balance")
  tokens=$(python3 -c 'import json,sys; print(sum(int(b["balance"]) for b in json.loads(sys.argv[1]) if b["asset"] == sys.argv[2]))' "$bal" "$cid")
  [ "$tokens" = 500 ] && break; sleep 2
done
[ "$tokens" = 500 ] || { echo "FAIL: expected 500 tokens; balance before $before, now $bal"; tail -30 "$LOG"; exit 1; }
echo "called buy: the wallet holds 500 of the contract's token"
echo "V1 end to end: passed"
rm -rf "$WORK"
