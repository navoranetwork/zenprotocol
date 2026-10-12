#!/bin/bash
# The replay run started by scripts/lab-replay-v1.sh (systemd unit zp-replay). Syncs a fresh
# zen-node:v1 from genesis to the reference height, checks it, and pushes progress and the
# report to the branch `replay-results` (replay/<run>/: progress.log, report.txt, errors.log).
set -uo pipefail
cd "$(dirname "$0")/.."
: "${GH_TOKEN:?}"
MAX_HOURS="${MAX_HOURS:-48}"
REPO=navoranetwork/zenprotocol
RUN="v1-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M)"
OUT="$PWD/replay-out/$RUN"; mkdir -p "$OUT"
API=127.0.0.1:11567
log() { echo "[$(date -u +%F' '%H:%M)] $*" | tee -a "$OUT/progress.log"; }
# a fresh server has no git identity; every commit here (the branch root included) needs one
export GIT_AUTHOR_NAME=zp-lab GIT_AUTHOR_EMAIL=zp-lab@navora.network GIT_COMMITTER_NAME=zp-lab GIT_COMMITTER_EMAIL=zp-lab@navora.network

# results branch in a separate worktree, pushed with the token
publish() {
  local wt="$PWD/replay-results"
  if [ ! -d "$wt/.git" ] && [ ! -f "$wt/.git" ]; then
    git fetch -q "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results:replay-results 2>/dev/null \
      || git branch -q replay-results "$(git commit-tree "$(git mktree < /dev/null)" -m 'replay results')"
    git worktree add -q "$wt" replay-results
  fi
  mkdir -p "$wt/replay/$RUN" && cp "$OUT"/* "$wt/replay/$RUN/" 2>/dev/null
  git -C "$wt" add -A replay
  git -C "$wt" -c user.name=zp-lab -c user.email=zp-lab@navora.network commit -q -m "replay $RUN: $1" || true
  git -C "$wt" push -q "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results 2>&1 | tail -1
}

git fetch -q origin reference-data
REF=$(git ls-tree -d --name-only origin/reference-data replay/reference/ | sort | tail -1)
H=$(git show "origin/reference-data:$REF/README.txt" | awk '/^height:/{print $2}')
{ echo "run: $RUN"; echo "commit: $(git rev-parse HEAD)"; echo "reference: $REF (height $H)"
  echo "server: $(hostname), $(nproc) cores, $(free -g | awk '/Mem/{print $2}') GB RAM, $(df -h --output=avail / | tail -1 | tr -d ' ') free"; } > "$OUT/report.txt"
log "start: reference height $H, at most $MAX_HOURS h"
publish "started"

docker rm -f zp-replay >/dev/null 2>&1; docker volume rm -f zp-replay >/dev/null 2>&1
docker run -d --name zp-replay -v zp-replay:/data -p "$API":11567 zen-node:v1 >/dev/null

tip() { curl -fs "http://$API/blockchain/info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])' 2>/dev/null; }
start=$(date +%s); last=0; t=0; stalled=0
while :; do
  sleep 300
  t=$(tip || echo "$t")
  el=$(( ($(date +%s) - start) / 60 ))
  if ! docker ps -q -f name=zp-replay | grep -q .; then log "NODE STOPPED at $t"; docker logs --tail 80 zp-replay > "$OUT/errors.log" 2>&1; publish "node stopped"; exit 1; fi
  if [ "${t:-0}" = "$last" ]; then stalled=$((stalled + 5)); else stalled=0; fi
  if (( el % 60 < 5 )); then
    log "+${el} min: block ${t:-?} of $H ($(( (${t:-0} - last) / 5 ))/min), disk $(df -h --output=avail / | tail -1 | tr -d ' ')"
    docker logs zp-replay 2>&1 | grep -E "ERR|Exception|nvalid" | grep -vi peer | tail -40 > "$OUT/errors.log"
    publish "block $t"
  fi
  last=${t:-$last}
  [ "${t:-0}" -ge "$H" ] && break
  (( stalled >= 120 )) && { log "STALLED at $t for 2 h"; docker logs --tail 80 zp-replay > "$OUT/errors.log" 2>&1; publish "stalled"; exit 1; }
  (( el >= MAX_HOURS * 60 )) && { log "TIME LIMIT at $t"; publish "time limit"; exit 1; }
done

log "reached $t: checking against the reference"
API=$API bash scripts/check-against-reference.sh >> "$OUT/report.txt" 2>&1; rc=$?
echo "reference check exit code: $rc" >> "$OUT/report.txt"
docker logs zp-replay 2>&1 | grep -E "ERR|Exception|nvalid" | grep -vi peer | tail -100 > "$OUT/errors.log"
# the live community node, once both are at the same tip
for i in $(seq 1 30); do
  a=$(tip); b=$(curl -fs https://navora.network/node/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])' 2>/dev/null)
  if [ -n "$a" ] && [ "$a" = "$b" ]; then
    for ep in cgp totalzp winner; do
      x=$(curl -fs "http://$API/blockchain/$ep"); y=$(curl -fs "https://navora.network/node/blockchain/$ep")
      [ "$x" = "$y" ] && echo "live $ep at $a: match" >> "$OUT/report.txt" || { echo "live $ep at $a: MISMATCH" >> "$OUT/report.txt"; rc=1; }
    done
    break
  fi
  sleep 60
done
if [ "$rc" = 0 ]; then log "PASSED"; publish "PASSED"; else log "FAILED (see report.txt)"; publish "FAILED"; fi
exit "$rc"
