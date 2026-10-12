#!/bin/bash
# STATUS: work in progress, not yet passing end to end (step 2 call uses zp-engine publish next).
# V1 lab testnet: three nodes on the local chain cross the V1 fork, activate and call a V1
# contract, and go through a reorg that removes the activation. Debug build (local chain),
# ZP_NODE_V1_ONLY=1 (no V0 tooling).
#
#   A  miner, wallet (the local genesis wallet)      ports 10000 / 20000
#   B  follows A                                     ports 10001 / 20001
#   C  miner, alone until the reorg step              ports 10002 / 20002
#
# Checks:
#   1. before the fork height a V1 activation is refused;
#   2. after it, the activation from A makes the contract active on A and B (each builds it
#      itself) with byte-identical DLLs; a call to it is mined and both agree on the tip;
#   3. reorg: A stops mining, C (which mined its own chain from genesis) gets ahead, then joins:
#      A and B switch to C's chain, which has no activation; the activation and the call come
#      back from the mempool, C mines them, and all three end on one tip with the contract active.
#   4. prints the contract DLL's SHA-256, to compare with a build on another machine.
#
# usage: ZP_V1_TOOLCHAIN=<zp-contracts-v1, Zulib verified> FSTAR_HOME=<F*> scripts/lab-testnet-v1.sh
# FORK=<height> (default 60). Results in $OUT (default ./lab-testnet-out): report.txt, node logs.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="${ZP_V1_TOOLCHAIN:?set ZP_V1_TOOLCHAIN}"; : "${FSTAR_HOME:?set FSTAR_HOME}"
FORK="${FORK:-60}"
BIN="$ROOT/src/Node/bin/Debug"
OUT="$(mkdir -p "${OUT:-lab-testnet-out}" && cd "${OUT:-lab-testnet-out}" && pwd)"
WORK="$(mktemp -d)"
MNEMONIC="feel muffin volcano click mercy abuse bachelor ginger limb tomorrow okay input spend athlete boring security document exclude liar dune usage camera ranch thought"
export ZP_WALLET_PASSWORD=lab-1234
REPORT="$OUT/report.txt"; : > "$REPORT"
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$REPORT"; }
fail() { say "FAIL: $*"; for n in A B C; do echo "--- $n"; tail -15 "$OUT/$n.log"; done; exit 1; }

[ -f "$BIN/zen-node.dll" ] || dotnet build "$ROOT/src/Node/Node.fsproj" -c Debug --configfile "$ROOT/nuget.mirror.config" -v q
declare -A PIDS IDX=([A]=0 [B]=1 [C]=2) SEED=([A]="" [B]="" [C]=none)
api() { echo "http://127.0.0.1:$((20000 + ${IDX[$1]}))"; }
start() {  # start <node> [--miner 1]
  local n=$1; shift
  (cd "$BIN" && ZP_NODE_V1_ONLY=1 ZP_LOCAL_V1_HEIGHT="$FORK" ZP_LOCAL_SEED="${SEED[$n]}" \
     ZP_V1_TOOLCHAIN="$TC" FSTAR_HOME="$FSTAR_HOME" PATH="$FSTAR_HOME/bin:$PATH" \
     exec dotnet zen-node.dll --local "${IDX[$n]}" "$@" >> "$OUT/$n.log" 2>&1) &
  PIDS[$n]=$!
  for _ in $(seq 60); do curl -s -m 2 "$(api "$n")/blockchain/info" > /dev/null && return; sleep 1; done
  fail "node $n did not start"
}
stop() { local p=${PIDS[$1]}; [ -n "$p" ] && { kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; }; PIDS[$1]=; }
cleanup() { for n in A B C; do stop $n; done; rm -rf "$WORK"; }
trap cleanup EXIT
info() { curl -s -m 5 "$(api "$1")/blockchain/info"; }
height() { info "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])' 2>/dev/null || echo 0; }
tip() { info "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tip"])' 2>/dev/null; }
post() { curl -s -m 600 -H 'Content-Type: application/json' -X POST "$(api "$1")/$2" -d "$3"; }
active() { curl -s -m 5 "$(api "$1")/contract/active" | python3 -c 'import json,sys; print(any(c["contractId"] == sys.argv[1] for c in json.load(sys.stdin)))' "$2" 2>/dev/null || echo False; }
wait_for() {  # wait_for <seconds> <description> <command...>
  local t=$1 d=$2; shift 2
  for _ in $(seq $((t / 3))); do "$@" && return 0; sleep 3; done
  fail "after $t s: $d"
}
wallet() {  # import the genesis wallet on a node (a miner reads its address at start: restart it after)
  local words; words=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1].split()))' "$MNEMONIC")
  post "$1" wallet/import "{\"words\": $words, \"password\": \"$ZP_WALLET_PASSWORD\"}" > /dev/null
  curl -s "$(api "$1")/wallet/resync" > /dev/null
  for _ in $(seq 30); do curl -s "$(api "$1")/wallet/balance" | grep -q '"00"' && break; sleep 1; done
  sleep 3
}

rm -rf "$BIN/data/local/0" "$BIN/data/local/1" "$BIN/data/local/2"
say "lab testnet: V1 fork at block $FORK; node $(git -C "$ROOT" rev-parse --short HEAD), toolchain $(git -C "$TC" rev-parse --short HEAD)"
say "machine: $(hostname), $(nproc) cores, $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
"$TC/tools/engine/zp-engine" make token --out "$WORK/token" > /dev/null
CODE=$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$WORK/token/contract.fst")
CID=00000001$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contractId"])' "$WORK/token/report.json")
say "token contract $CID"
start A; wallet A          # not mining yet: the chain stays at genesis for check 1

# 1. before the fork: the genesis wallet's funds, at block 0 or 1
h=$(height A)
# the wallet answers with the transaction it made before the node validates it: look for it in
# the mempool and in the log
r=$(post A wallet/contract/activate "{\"code\": $CODE, \"numberOfBlocks\": 100, \"password\": \"$ZP_WALLET_PASSWORD\", \"version\": 1}")
tx=$(echo "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("txHash",""))' 2>/dev/null || true)
sleep 10
if [ -n "$tx" ] && { curl -s "$(api A)/blockchain/mempool" | grep -q "$tx" || grep -q "Transaction $tx added to mempool" "$OUT/A.log"; }; then
  fail "activation $tx entered the mempool at height $h, before the fork at $FORK"
fi
say "1. before the fork (height $h): activation not accepted ($(grep -A3 "${tx:-none}" "$OUT/A.log" | grep -oiE "(invalid|error|refused|not supported)[^\"]{0,60}" | head -1))"
stop A; start A --miner 1
start C; wallet C; stop C; start C --miner 1
start B

# 2. after the fork
wait_for 1800 "A reaches the fork" bash -c "[ \$(curl -s $(api A)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"blocks\"])') -ge $((FORK + 1)) ]"
"$TC/tools/engine/zp-engine" publish "$WORK/token" --node "$(api A)" --blocks 100 --yes > "$OUT/publish.json" 2>&1 \
  || fail "activation after the fork: $(tail -3 "$OUT/publish.json")"
say "2. activation sent from A at height $(height A)"
wait_for 900 "contract active on A" bash -c "[ \"\$(curl -s $(api A)/contract/active | python3 -c 'import json,sys; print(any(c[\"contractId\"]==\"$CID\" for c in json.load(sys.stdin)))')\" = True ]"
wait_for 900 "contract active on B" bash -c "[ \"\$(curl -s $(api B)/contract/active | python3 -c 'import json,sys; print(any(c[\"contractId\"]==\"$CID\" for c in json.load(sys.stdin)))')\" = True ]"
DLLS=$(find "$BIN/data/local/0" "$BIN/data/local/1" -name "Z${CID:8}.dll" | sort)
[ "$(echo "$DLLS" | wc -l)" = 2 ] || fail "expected the contract DLL on A and B, found: $DLLS"
SUMS=$(sha256sum $DLLS | awk '{print $1}' | sort -u)
[ "$(echo "$SUMS" | wc -l)" = 1 ] || fail "A and B built different DLLs: $(sha256sum $DLLS)"
say "   active on A and B; both built the same DLL, SHA-256 $SUMS"
grep -h "End building V1 contract" "$OUT/A.log" "$OUT/B.log" | sed 's/^.*Duration/   build time/' | tee -a "$REPORT"
"$TC/tools/engine/zp-engine" call "$WORK/token" --node "$(api A)" --command buy --spend 00:500 --return-address > "$OUT/call.json" 2>&1 \
  || fail "call buy: $(tail -3 "$OUT/call.json")"
say "   call buy sent from A"
wait_for 600 "A's wallet holds 500 tokens" bash -c "[ \"\$(curl -s $(api A)/wallet/balance | python3 -c 'import json,sys; print(sum(int(b[\"balance\"]) for b in json.load(sys.stdin) if b[\"asset\"]==\"$CID\"))')\" = 500 ]"
wait_for 300 "A and B on one tip" bash -c "[ \"\$(curl -s $(api A)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])')\" = \"\$(curl -s $(api B)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])')\" ]"
say "   buy mined: A's wallet holds 500 tokens; A and B agree at height $(height A)"

# 3. reorg: C, alone and mining since the start, overtakes A, then joins
hA=$(height A); hC=$(height C)
say "3. reorg: A at $hA, C (alone) at $hC; A stops mining"
stop A; start A
target=$((hA + 5))
wait_for 1800 "C passes $target" bash -c "[ \$(curl -s $(api C)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"blocks\"])') -ge $target ]"
[ "$(active C "$CID")" = False ] || fail "the contract is active on C, which never saw the activation"
stop C; SEED[C]=10000; start C --miner 1
say "   C at $(height C) joins A"
wait_for 900 "all three on one tip" bash -c "a=\$(curl -s $(api A)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])'); b=\$(curl -s $(api B)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])'); c=\$(curl -s $(api C)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])'); [ -n \"\$a\" ] && [ \"\$a\" = \"\$b\" ] && [ \"\$b\" = \"\$c\" ]"
say "   A and B switched to C's chain (height $(height A))"
wait_for 1200 "contract active again on all three" bash -c "for p in 20000 20001 20002; do [ \"\$(curl -s http://127.0.0.1:\$p/contract/active | python3 -c 'import json,sys; print(any(c[\"contractId\"]==\"$CID\" for c in json.load(sys.stdin)))')\" = True ] || exit 1; done"
wait_for 600 "all three on one tip after the activation" bash -c "a=\$(curl -s $(api A)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])'); c=\$(curl -s $(api C)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])'); b=\$(curl -s $(api B)/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"tip\"])'); [ \"\$a\" = \"\$b\" ] && [ \"\$b\" = \"\$c\" ]"
DLLC=$(find "$BIN/data/local/2" -name "Z${CID:8}.dll")
[ -n "$DLLC" ] && [ "$(sha256sum "$DLLC" | awk '{print $1}')" = "$SUMS" ] || fail "C's DLL differs or is missing"
say "   the activation came back from the mempool: active on all three at height $(height A), C built the same DLL"
grep -h "ERR\|Exception" "$OUT"/*.log | grep -vi "peer\|connect\|socket" | head -20 > "$OUT/errors.txt" || true
say "4. contract DLL SHA-256 $SUMS (compare with another machine: build-contract.sh of the same source)"
say "PASSED"
