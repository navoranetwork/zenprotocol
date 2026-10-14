#!/bin/bash
# Rehearsal of the testnet V1 upgrade on the lab server (zp-lab-1), before the public testnet node
# (91.98.3.17) is switched (fork at testParameters.v1ContractsHeight = 2050, switch after the CGP
# payout at 2010):
#   1. builds the testnet image of branch testnet-v1 (navoranetwork/zp-pow) with the pinned V1
#      toolchain (Docker/Dockerfile.testnet-v1: Zulib verified, token template DLL hash checked)
#   2. starts it as a second testnet node (no mining) that syncs the public testnet from
#      91.98.3.17, and waits until it is at the same tip (blocks = headers, near the expected height)
#   3. keeps following the chain (MINUTES, default 60) and reports heights and any error lines
#   4. (unless SKIP_LAB=1) the three-node V1 lab testnet + T5b/T7 on the testnet-v1 code
#      (scripts/lab-testnet-run.sh with SRC_REPO/BRANCH)
# The node stays running afterwards (container zp-rehearsal, API 127.0.0.1:41567) and crosses the
# fork with the public network: `docker logs -f zp-rehearsal`. Results: branch replay-results.
#
# On zp-lab-1, as root (/etc/zp-lab.env holds GH_TOKEN):
#   cd /opt/zp-lab && git pull -q && systemd-run --unit zp-rehearsal --property=EnvironmentFile=/etc/zp-lab.env \
#     bash /opt/zp-lab/scripts/lab-testnet-v1-rehearsal.sh
#   journalctl -u zp-rehearsal -f
set -uo pipefail
: "${GH_TOKEN:?}"
DIR=/opt/zp-lab; REPO=navoranetwork/zenprotocol; TC=/opt/zp-contracts-v1; SRC=/opt/zp-pow
BRANCH=${BRANCH:-testnet-v1}; TC_COMMIT=${TC_COMMIT:-c86a2c4}; SEED=${SEED:-91.98.3.17}
IMAGE=zen-node:testnet-v1; NAME=zp-rehearsal; API=http://127.0.0.1:41567
GH="https://x-access-token:$GH_TOKEN@github.com"
RUN="rehearsal-$(date -u +%Y%m%d-%H%M)"
OUT="$DIR/replay-out/$RUN"; mkdir -p "$OUT"
export GIT_AUTHOR_NAME=zp-lab GIT_AUTHOR_EMAIL=zp-lab@navora.network GIT_COMMITTER_NAME=zp-lab GIT_COMMITTER_EMAIL=zp-lab@navora.network
log() { echo "[$(date -u +%F' '%H:%M)] $*" | tee -a "$OUT/summary.txt"; }
publish() {
  local wt="$DIR/replay-results"
  if [ ! -e "$wt/.git" ]; then
    rm -rf "$wt"; git -C "$DIR" worktree prune
    git -C "$DIR" fetch -q "$GH/$REPO.git" replay-results:replay-results
    git -C "$DIR" worktree add -q "$wt" replay-results
  fi
  git -C "$wt" pull -q --rebase "$GH/$REPO.git" replay-results 2>/dev/null
  mkdir -p "$wt/tests/$RUN" && cp "$OUT"/*.txt "$wt/tests/$RUN/" 2>/dev/null
  docker logs --tail 300 $NAME > "$wt/tests/$RUN/node.log" 2>&1 || true
  git -C "$wt" add -A tests
  git -C "$wt" commit -q -m "tests $RUN: $1" || true
  git -C "$wt" push -q "$GH/$REPO.git" replay-results 2>&1 | tail -1
}
stop() { log "STOPPED: $*"; publish "stopped: $*"; exit 1; }
info() { curl -fs -m 10 "$API/blockchain/info"; }
field() { sed -n "s/.*\"$1\" *: *\"\{0,1\}\([^\",}]*\).*/\1/p"; }

# 1. sources and image
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q "$GH/navoranetwork/zp-pow.git" "$BRANCH" && git -C "$SRC" checkout -q -f FETCH_HEAD || stop "fetch $BRANCH"
else git clone -q -b "$BRANCH" "$GH/navoranetwork/zp-pow.git" "$SRC" || stop "clone zp-pow"; fi
log "rehearsal of $BRANCH $(git -C "$SRC" log --oneline -1 | cut -c1-80)"
grep -n "v1ContractsHeight=" "$SRC/src/Consensus/Chain.fs" | sed 's/^/  Chain.fs:/' | tee -a "$OUT/summary.txt"
publish "started"
if [ -d "$TC/.git" ]; then git -C "$TC" fetch -q "$GH/navoranetwork/zp-contracts-v1.git" main || stop "toolchain fetch"
else git clone -q "$GH/navoranetwork/zp-contracts-v1.git" "$TC" || stop "toolchain clone"; fi
rm -rf "$SRC/zp-contracts-v1" && git -C "$TC" archive --prefix=zp-contracts-v1/ "$TC_COMMIT" | tar -x -C "$SRC" || stop "toolchain $TC_COMMIT"
log "toolchain: zp-contracts-v1 $(git -C "$TC" log --oneline -1 "$TC_COMMIT" | cut -c1-70)"
log "image build: start (Zulib verification and the token DLL check run inside)"
(cd "$SRC" && docker build -f Docker/Dockerfile.testnet-v1 -t $IMAGE .) > "$OUT/image-build.txt" 2>&1 || stop "image build (image-build.txt)"
log "image built: $(docker image inspect $IMAGE --format '{{.Id}}' | cut -c1-19); $(grep -ohE 'Zulib: [0-9]+ of [0-9]+ modules verify|token template DLL: [0-9a-f]{64}' "$OUT/image-build.txt" | tr '\n' ';')"

# 2. a second testnet node, syncing from the public one
docker rm -f $NAME > /dev/null 2>&1
docker run -d --name $NAME --restart unless-stopped -p 127.0.0.1:41567:31567 -v zp-rehearsal-data:/data \
  -e NETWORK=test -e SEEDS="$SEED" -e NETWORK_URL=off -e WALLET_API=1 -e MINER_THREADS=0 $IMAGE > /dev/null || stop "docker run"
log "node started (seed $SEED); syncing"
synced=""
for i in $(seq 1 240); do                           # up to 4 hours
  sleep 60; j=$(info) || continue
  b=$(echo "$j" | field blocks); h=$(echo "$j" | field headers)
  [ $((i % 10)) = 0 ] && log "sync: blocks $b, headers $h"
  if [ -n "$b" ] && [ "$b" = "$h" ] && [ "$b" -ge "${MIN_HEIGHT:-1770}" ]; then synced=$b; break; fi
done
[ -n "$synced" ] || stop "not synced after 4 hours"
log "SYNCED at block $synced, tip $(info | field tip)"
publish "synced at $synced"

# 3. follow the chain
for i in $(seq 1 "${MINUTES:-60}"); do
  sleep 60; [ $((i % 15)) = 0 ] && log "following: $(info | field blocks) blocks, headers $(info | field headers)"
done
errs=$(docker logs $NAME 2>&1 | grep -ciE "\[(ERR|FTL)|unhandled exception|rejected|invalid block")
log "node: $(info | field blocks) blocks; error/rejected lines in log: $errs"
docker logs $NAME 2>&1 | grep -iE "\[(ERR|FTL)|unhandled exception|rejected|invalid block" | tail -40 > "$OUT/node-errors.txt"
publish "following done"

# 4. the lab testnet and T5b/T7 on the testnet-v1 code
if [ -z "${SKIP_LAB:-}" ]; then
  log "lab testnet on $BRANCH: start"
  SRC_REPO=navoranetwork/zp-pow BRANCH=$BRANCH bash "$DIR/scripts/lab-testnet-run.sh" > "$OUT/lab-testnet.txt" 2>&1
  log "lab testnet: exit $? ($(grep -E 'lab testnet on|PASSED|FAIL|T5b:|T7' "$OUT/lab-testnet.txt" | tail -4 | tr '\n' ' '))"
fi
log "done; node $NAME keeps running"
publish "done"
