#!/bin/bash
# The three-node V1 lab testnet (scripts/lab-testnet-v1.sh) on the lab server (zp-lab-1), as a
# second machine: same scenario, and the contract DLL's SHA-256 to compare with a build on
# another machine and CPU. Installs what the V1 build needs (the pinned .NET SDK and F*, the
# toolchain repo zp-contracts-v1, which the token must be able to read), builds the node in
# Debug, runs the scenario, and posts the report to the branch `replay-results`
# (tests/<run>/: summary.txt, report.txt, node logs).
#
# On zp-lab-1, as root (/etc/zp-lab.env holds GH_TOKEN):
#   cd /opt/zp-lab && git pull -q && systemd-run --unit zp-testnet --property=EnvironmentFile=/etc/zp-lab.env \
#     bash /opt/zp-lab/scripts/lab-testnet-run.sh
#   journalctl -u zp-testnet -f
set -uo pipefail
: "${GH_TOKEN:?}"
DIR=/opt/zp-lab; REPO=navoranetwork/zenprotocol; TC=/opt/zp-contracts-v1
FSTAR_VERSION=v2026.09.27
FSTAR_SHA256=cafbbb8960efeb26f5d30bc447b61ab8a507968948507a2580585afd1397781d
# SRC_REPO/BRANCH (e.g. navoranetwork/zp-pow testnet-v1): run on that code instead, in its own
# checkout (/opt/zp-src-<branch>), so the scripts running from /opt/zp-lab are not changed under them
if [ -n "${SRC_REPO:-}" ]; then
  CODE=/opt/zp-src-${BRANCH:?}
  if [ -d "$CODE/.git" ]; then git -C "$CODE" fetch -q "https://x-access-token:$GH_TOKEN@github.com/$SRC_REPO.git" "$BRANCH" && git -C "$CODE" checkout -q -f FETCH_HEAD
  else git clone -q -b "$BRANCH" "https://x-access-token:$GH_TOKEN@github.com/$SRC_REPO.git" "$CODE"; fi || { echo "cannot fetch $SRC_REPO $BRANCH"; exit 1; }
  [ -e "$CODE/packages-mirror" ] || ln -s "$DIR/packages-mirror" "$CODE/packages-mirror"
  cd "$CODE"
else
  CODE=$DIR; cd "$DIR"
  git fetch -q origin v1-contracts && git checkout -q -f -B v1-contracts origin/v1-contracts
fi
RUN="testnet-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M)"
OUT="$DIR/replay-out/$RUN"; mkdir -p "$OUT"
export GIT_AUTHOR_NAME=zp-lab GIT_AUTHOR_EMAIL=zp-lab@navora.network GIT_COMMITTER_NAME=zp-lab GIT_COMMITTER_EMAIL=zp-lab@navora.network
export DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
log() { echo "[$(date -u +%F' '%H:%M)] $*" | tee -a "$OUT/summary.txt"; }
publish() {
  local wt="$DIR/replay-results"
  if [ ! -e "$wt/.git" ]; then
    rm -rf "$wt"; git -C "$DIR" worktree prune
    git -C "$DIR" fetch -q "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results:replay-results
    git -C "$DIR" worktree add -q "$wt" replay-results
  fi
  git -C "$wt" pull -q --rebase "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results 2>/dev/null
  mkdir -p "$wt/tests/$RUN" && cp "$OUT"/*.txt "$wt/tests/$RUN/" 2>/dev/null
  for n in A B C; do [ -f "$OUT/net/$n.log" ] && tail -300 "$OUT/net/$n.log" > "$wt/tests/$RUN/node-$n.log"; done
  [ -f "$OUT/net/report.txt" ] && cp "$OUT/net/report.txt" "$wt/tests/$RUN/report.txt"
  git -C "$wt" add -A tests
  git -C "$wt" commit -q -m "tests $RUN: $1" || true
  git -C "$wt" push -q "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" replay-results 2>&1 | tail -1
}
stop() { log "STOPPED: $*"; publish "stopped: $*"; exit 1; }

log "lab testnet on $(git log --oneline -1)"
publish "started"

# 1. tools
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q curl git python3 ca-certificates libgomp1 libgmp10 liblmdb-dev nodejs > /dev/null 2>&1 || stop "apt"   # lmdb: the node's database
SDK=10.0.112
if ! dotnet --list-sdks 2>/dev/null | grep -q "^$SDK "; then
  if [ ! -x /opt/dotnet/dotnet ] || ! /opt/dotnet/dotnet --list-sdks | grep -q "^$SDK "; then
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh || stop "dotnet-install download"
    bash /tmp/dotnet-install.sh --version "$SDK" --install-dir /opt/dotnet > "$OUT/dotnet-install.txt" 2>&1 || stop "dotnet-install"
  fi
  export PATH=/opt/dotnet:$PATH DOTNET_ROOT=/opt/dotnet
fi
log "dotnet: $(command -v dotnet), SDKs: $(dotnet --list-sdks | tr '\n' ' ')"
if ! /opt/fstar/bin/fstar.exe --version 2>/dev/null | grep -q "${FSTAR_VERSION#v}"; then
  curl -fsSL -o /tmp/fstar.tgz "https://github.com/FStarLang/FStar/releases/download/$FSTAR_VERSION/fstar-$FSTAR_VERSION-Linux-x86_64.tar.gz" || stop "F* download"
  echo "$FSTAR_SHA256  /tmp/fstar.tgz" | sha256sum -c --quiet - || stop "F* checksum"
  rm -rf /opt/fstar && tar -xzf /tmp/fstar.tgz -C /opt && rm /tmp/fstar.tgz
  chown -R root:root /opt/fstar && chmod -R a+rX /opt/fstar   # the release is uid 1001, mode 0600 (V1-REVIEW E3)
fi
export FSTAR_HOME=/opt/fstar
log "F*: $($FSTAR_HOME/bin/fstar.exe --version | head -1)"

# 2. the V1 toolchain (private repo)
if [ -d "$TC/.git" ]; then
  git -C "$TC" fetch -q "https://x-access-token:$GH_TOKEN@github.com/navoranetwork/zp-contracts-v1.git" main \
    && git -C "$TC" checkout -q -f FETCH_HEAD || stop "toolchain fetch"
else
  git clone -q "https://x-access-token:$GH_TOKEN@github.com/navoranetwork/zp-contracts-v1.git" "$TC" 2>/dev/null \
    || stop "this token cannot read navoranetwork/zp-contracts-v1 (give it read access to that repo)"
fi
log "toolchain: zp-contracts-v1 $(git -C "$TC" log --oneline -1 | cut -c1-70)"
(cd "$TC" && bash scripts/verify-zulib.sh) > "$OUT/verify-zulib.txt" 2>&1
n_ok=$(grep -c '^ok' "$TC/verify-report.txt"); n_all=$(wc -l < "$TC/verify-report.txt")
[ "$n_ok" = "$n_all" ] || stop "Zulib: $n_ok of $n_all modules verify"
log "Zulib: all $n_ok modules verify"

# 3. the node, Debug (the local chain)
[ -d packages-mirror ] || bash scripts/restore-from-mirror.sh > /dev/null || stop "package mirror"
dotnet build src/Node/Node.fsproj -c Debug --configfile nuget.mirror.config -v q > "$OUT/node-build.txt" 2>&1 || stop "node build (node-build.txt)"
log "node built (Debug)"

# 4. the scenario (SKIP_TESTNET=1: keep the last run's nodes and data, go to step 5)
if [ -z "${SKIP_TESTNET:-}" ]; then
  OUT="$OUT/net" ZP_V1_TOOLCHAIN="$TC" bash scripts/lab-testnet-v1.sh > "$OUT/testnet.txt" 2>&1; rc=$?
  log "lab-testnet-v1.sh: exit $rc; $(grep -E 'PASSED|FAIL' "$OUT/net/report.txt" | tail -1)"
  log "$(grep 'contract DLL SHA-256' "$OUT/net/report.txt" | sed 's/^.*4. //')"
fi
# the token template built by build-contract.sh, to compare byte by byte with another machine's
# build (the DLL in base64), and the intermediate F# it was compiled from
W=$(mktemp -d)
"$TC/tools/engine/zp-engine" make token --out "$W/token" > /dev/null 2>&1
KEEP_WORK="$W/keep" "$TC/scripts/build-contract.sh" --lax "$W/token/contract.fst" "$W/out" > "$OUT/token-build.txt" 2>&1
dll=$(ls "$W"/out/Z*.dll 2>/dev/null | head -1)
if [ -n "$dll" ]; then
  sha256sum "$dll" | sed "s|$W/out/||" > "$OUT/contract-dll-sha256.txt"
  base64 -w 0 "$dll" > "$OUT/contract-dll-base64.txt"
  log "token template DLL (build-contract.sh): $(cut -c1-64 "$OUT/contract-dll-sha256.txt")"
fi
dotnet --info > "$OUT/dotnet-info.txt" 2>&1
publish "testnet done"
[ -n "${DLL_ONLY:-}" ] && { log "done (DLL_ONLY)"; publish "done"; exit 0; }

# 5. BitZen T5b (a Bitcoin payment proved in a V1 contract), when the token can read the repo
B=/opt/bitzen
if { [ -d "$B/.git" ] && git -C "$B" pull -q "https://x-access-token:$GH_TOKEN@github.com/navoranetwork/bitzen.git" main 2>/dev/null; } \
   || git clone -q "https://x-access-token:$GH_TOKEN@github.com/navoranetwork/bitzen.git" "$B" 2>/dev/null; then
  log "T5b (BitZen $(git -C "$B" log --oneline -1 | cut -c1-60)): start"
  (cd "$B" && ZP_V1_TOOLCHAIN="$TC" FSTAR_HOME="$FSTAR_HOME" ZEN="$CODE" timeout 3600 bash scripts/v1-pay-devnet.sh) > "$OUT/t5b.txt" 2>&1
  cp "$B/v1-pay-out/report.txt" "$OUT/t5b-report.txt" 2>/dev/null
  log "T5b: $(grep -h 'RESULT' "$OUT/t5b.txt" | tail -1)"
else
  log "T5b: SKIPPED (this token cannot read navoranetwork/bitzen)"
fi
publish "done"
