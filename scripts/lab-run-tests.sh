#!/bin/bash
# Node tests that need Docker, run on the lab server (zp-lab-1) against branch v1-contracts:
#   1. scripts/cgp-devnet-test.sh relay   (a 1.0.13-like miner; a second node relays the payout)
#   2. scripts/cgp-devnet-test.sh miner   (the miner creates the payout)
#   3. BitZen stall-repro.sh on SeqProbe.fst (docs/MEMPOOL-CONTRACT-ORDER.md), when the token can
#      read navoranetwork/bitzen
# Each takes 60-90 minutes (mostly the devnet image build). Results go to the branch
# `replay-results` (tests/<run>/: summary.txt and one log per test), like the replay.
#
# On zp-lab-1, as root, after the replay setup (/etc/zp-lab.env holds GH_TOKEN):
#   cd /opt/zp-lab && git pull -q && systemd-run --unit zp-tests --property=EnvironmentFile=/etc/zp-lab.env \
#     bash /opt/zp-lab/scripts/lab-run-tests.sh
#   journalctl -u zp-tests -f        # follow it
set -uo pipefail
: "${GH_TOKEN:?}"
DIR=/opt/zp-lab; REPO=navoranetwork/zenprotocol
cd "$DIR"
git fetch -q origin v1-contracts && git checkout -q -f -B v1-contracts origin/v1-contracts
RUN="tests-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M)"
OUT="$DIR/replay-out/$RUN"; mkdir -p "$OUT"
export GIT_AUTHOR_NAME=zp-lab GIT_AUTHOR_EMAIL=zp-lab@navora.network GIT_COMMITTER_NAME=zp-lab GIT_COMMITTER_EMAIL=zp-lab@navora.network
log() { echo "[$(date -u +%F' '%H:%M)] $*" | tee -a "$OUT/summary.txt"; }

publish() {  # the results branch, in its worktree (made by the replay run)
  local wt="$DIR/replay-results"
  if [ ! -e "$wt/.git" ]; then
    rm -rf "$wt"; git worktree prune
    git fetch -q "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results:replay-results
    git worktree add -q "$wt" replay-results
  fi
  git -C "$wt" pull -q --rebase "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results 2>/dev/null
  mkdir -p "$wt/tests/$RUN" && cp "$OUT"/* "$wt/tests/$RUN/"
  git -C "$wt" add -A tests
  git -C "$wt" commit -q -m "tests $RUN: $1" || true
  git -C "$wt" push -q "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results 2>&1 | tail -1
}

log "node tests on $(git log --oneline -1)"
publish "started"
modes="relay miner"; [ -n "${ONLY_STALL:-}" ] && modes=""   # ONLY_STALL=1: only stall-repro
for mode in $modes; do
  log "cgp-devnet-test $mode: start"
  bash scripts/cgp-devnet-test.sh "$mode" > "$OUT/cgp-$mode.log" 2>&1
  docker rm -f zen-devnet-test > /dev/null 2>&1
  log "cgp-devnet-test $mode: $(grep -h 'RESULT' "$OUT/cgp-$mode.log" | tail -1)"
  publish "cgp $mode done"
done

B=/opt/bitzen
if { [ -d "$B/.git" ] && git -C "$B" pull -q; } || git clone -q "https://x-access-token:$GH_TOKEN@github.com/navoranetwork/bitzen" "$B" 2>/dev/null; then
  log "stall-repro (BitZen $(git -C "$B" log --oneline -1 | cut -c1-60)): start"
  (cd "$B" && ZEN_REF=v1-contracts WORK=/opt/bitzen-run bash scripts/devnet-run.sh stall-repro.sh SeqProbe.fst) > "$OUT/stall-repro.log" 2>&1
  log "stall-repro: $(grep -hE 'PASS|STALL|FAIL' "$OUT/stall-repro.log" | tail -4 | tr '\n' ' ')"
else
  log "stall-repro: SKIPPED (this token cannot read navoranetwork/bitzen)"
fi
log "done"
publish "done"
