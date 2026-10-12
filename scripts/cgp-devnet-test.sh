#!/bin/bash
# The cgp-devnet test (.github/workflows/cgp-devnet.yml) on any Linux machine with Docker and python3, for when
# GitHub Actions is not available. A whole CGP cycle on a private devnet in Docker (local chain, 2 s blocks), then a
# check that the chain passes the payout block (610). Touches nothing outside its own container (zen-devnet-test,
# API 127.0.0.1:20000) and the folder it runs in. Takes about 60-90 minutes (most of it building the image).
#
#   bash scripts/cgp-devnet-test.sh relay    the miner behaves like release 1.0.13 (ZEN_CGP_PAYOUT=off); a second
#                                            node must relay the payout transaction so the miner's payout block is valid
#   bash scripts/cgp-devnet-test.sh miner    one node: the miner creates the payout itself
#
# Result in the last lines: "RESULT: PASS" or "RESULT: FAIL ...". Remove afterwards: docker rm -f zen-devnet-test
set -uo pipefail
MODE=${1:-relay}; NAME=zen-devnet-test; API=http://127.0.0.1:20000
MN="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
cd "$(dirname "$0")/.."
tip() { curl -fs -m 10 $API/blockchain/info | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p'; }
fail() { echo "RESULT: FAIL $*"; exit 1; }
sim() { docker run --rm --network host -v "$PWD/wallet:/w" -w /w -e TESTNET_MNEMONIC="$MN" -e CGP_POLL_MS=1000 node:22 "$@"; }

echo "== $(date -u +%H:%M:%S) build the devnet image from $(git log --oneline -1)"
docker build -q -f Docker/Dockerfile.devnet -t zen-devnet-test . >/dev/null || fail "image build"
docker rm -f $NAME >/dev/null 2>&1
if [ "$MODE" = relay ]; then RUN=(-e NODES=2 -e MINER_CGP_PAYOUT=off); else RUN=(-e NODES=1); fi
echo "== $(date -u +%H:%M:%S) start ($MODE: ${RUN[*]})"
docker run -d --name $NAME -p 127.0.0.1:20000:20000 "${RUN[@]}" -e MINER_THREADS=1 zen-devnet-test >/dev/null || fail "docker run"
for i in $(seq 120); do sleep 5; T=$(tip); [ -n "$T" ] && [ "$T" -ge 40 ] && break; done
echo "block ${T:-?}"; [ -n "$T" ] && [ "$T" -ge 40 ] || fail "the devnet does not mine"

echo "== $(date -u +%H:%M:%S) activate the CGP and voting contracts"
bash scripts/testnet-cgp-contracts.sh $API devnet 100000 || fail "contract activation"
echo "== $(date -u +%H:%M:%S) fund the test voters (snapshot 590)"
sim sh -c "npm ci --no-audit --no-fund >/dev/null && node --no-warnings tools/cgp-sim.mjs fund --send --target 590 --node $API" | tail -n 5
echo "== $(date -u +%H:%M:%S) run the vote (nominations, payout votes) through interval 6"
sim timeout 5400 node --no-warnings tools/cgp-sim.mjs run --send --target 590 --node $API > cgp-devnet-sim.log 2>&1
grep -E "published" cgp-devnet-sim.log | tail -n 8

for i in $(seq 120); do T=$(tip); [ -n "$T" ] && [ "$T" -ge 620 ] && break; sleep 5; done
CGP=$(curl -fs $API/blockchain/cgp/history; curl -fs $API/blockchain/cgp)
LOG=$(docker exec $NAME sh -c 'for f in /data/logs/node*.log; do grep -H -E "commitments mismatch|Miner created the CGP|Relaying the CGP|Could not create the CGP|No payout|failed validation" $f | tail -n 6; done' | cut -c1-300)
echo "== $(date -u +%H:%M:%S) tip ${T:-?}"; echo "$CGP" | head -c 600; echo; echo "$LOG"
echo "$CGP" | grep -q recipient || fail "the vote produced no payout winner, so the payout block was not tested"
[ -n "$T" ] && [ "$T" -ge 620 ] || fail "the chain stopped at ${T:-?} (payout block 610)"
echo "$LOG" | grep -q "commitments mismatch" && fail "commitments mismatch"
if [ "$MODE" = relay ]; then
  echo "$LOG" | grep -q "node0.log.*Miner created the CGP" && fail "the miner made the payout itself, so the relay was not tested"
  echo "$LOG" | grep -q "node1.log.*Relaying the CGP" || fail "node 1 did not relay the payout"
fi
echo "RESULT: PASS ($MODE): the chain passed the payout block 610 and is at $T"
