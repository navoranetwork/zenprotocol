#!/bin/bash
# Throughput comparison on zp-lab-1: the ORIGINAL Zen node (A) and ours (B), same machine, same load, one at a time.
#   A  upstream a0191cbc (the last upstream commit before ours), built from source as upstream's CI did (Mono, paket,
#      msbuild of the solution).
#   B  ours: zp-pow testnet-v1 (BRANCH_B, default the branch head), .NET 10.
# Both get the SAME patches, recorded in <out>/A-patch.diff and B-patch.diff:
#   - Release build with the local chain: `#if DEBUG` -> `#if DEBUG || LOCALCHAIN` (except the log level, which stays
#     Info as in Release), built with LOCALCHAIN defined. Only the local chain's availability changes.
#   - the local chain's block interval = BLOCK_S seconds (default 10; upstream 60, ours 2). At 2 s the local chain's
#     trivial difficulty let the miner find blocks continuously on a stale template (over 95% of mined blocks went to
#     forks in the first run, in BOTH nodes), so block times measured the miner, not the node.
# One node on the local chain, 1 miner thread, address index on, fresh chain each run, node container on CPUs 0-3.
# Load: wallet/tools/load-test.mjs (zenprotocol node-upgrade-script), two senders with their own funded wallets
# (CPUs 4-5 and 6-7), each at half the total rate. Schedule: every rate in RATES, RUNS times, in one shuffled order
# (fixed SEED, the same for A and B), STEP_MIN minutes each; the first minute of each step is warm-up and is not
# measured (scripts/throughput-report.py). Every 10 s: docker stats of the node.
# PROFILE=1: instead, ours only at PROFILE_RATE (default 3000/min total) for 5 minutes, with a 60 s dotnet-trace
# CPU sample of the node at minute 2 (speedscope + the top frames, scripts/speedscope-top.py).
# Results on the branch replay-results, tests/throughput-<date>/ (or profile-<date>/).
#
# On zp-lab-1, as root (/etc/zp-lab.env holds GH_TOKEN):
#   cd /opt/zp-lab && git pull -q && systemd-run --unit zp-tput --property=EnvironmentFile=/etc/zp-lab.env \
#     bash /opt/zp-lab/scripts/lab-throughput.sh
# Settings: RATES (total per minute, default 300,600,1500,3000,6000,15000), RUNS (3), STEP_MIN (6), BLOCK_S (10),
# SEED (1), ONLY=A|B, PROFILE=1.
# VARIANTS="t0s0 t0 t1000s0 t1000": run B once per variant, tN = ZP_TEMPLATE_INTERVAL_MS=N, s0 = ZP_VERIFIED_SIGNATURES=0
#   (t0s0 = the node as before both changes; results in B-<variant>; default: one
#   run of B as built). REALISTIC=1: the local chain's easiest target is POW_LIMIT (default 0x1f0bfbd5: easy enough for A's Mono miner,
#   which did not reach 40 blocks in 30 min at 0x1e0bfbd5, 2026-10-17) in both trees, so blocks come from real hashing;
#   each node's difficulty rule then raises it until its blocks come near BLOCK_S, and the load waits for that.
# PROFILE=1 (PROFILE_RATE, PROFILE_ENV) also takes the finalizer queue (dotnet-dump), a heap report (dotnet-gcdump) and GC counters (dotnet-counters).
set -uo pipefail
: "${GH_TOKEN:?}"
DIR=/opt/zp-lab; REPO=navoranetwork/zenprotocol; GH="https://x-access-token:$GH_TOKEN@github.com"
UPSTREAM=a0191cbc; BRANCH_B=${BRANCH_B:-testnet-v1}
RATES=${RATES:-300,600,1500,3000,6000,15000}; RUNS=${RUNS:-3}; STEP_MIN=${STEP_MIN:-6}; BLOCK_S=${BLOCK_S:-10}; SEED=${SEED:-1}
PROFILE=${PROFILE:-}; PROFILE_RATE=${PROFILE_RATE:-3000}
VARIANTS=${VARIANTS:-}; REALISTIC=${REALISTIC:-}; POW_LIMIT=${POW_LIMIT:-0x1f0bfbd5}; NODE_ENV=""
STAMP=$(date -u +%Y%m%d-%H%M); RUN="$([ -n "$PROFILE" ] && echo profile || echo throughput)-$STAMP"
OUT="$DIR/replay-out/$RUN"; mkdir -p "$OUT"; W=/opt/zp-tput; mkdir -p "$W"
M1="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
# the miner's wallet (M0) only funds the two senders; each sender has its own wallet (the miner's wallet as a
# sender failed: its split could not find the last 100 outputs among the coinbase outputs, 2026-10-14 run)
M0="$M1"
M1="legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
M2="letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless"
API=http://127.0.0.1:20000; NODE_C=zp-tput-node
export GIT_AUTHOR_NAME=zp-lab GIT_AUTHOR_EMAIL=zp-lab@navora.network GIT_COMMITTER_NAME=zp-lab GIT_COMMITTER_EMAIL=zp-lab@navora.network
log() { echo "[$(date -u +%F' '%H:%M)] $*" | tee -a "$OUT/summary.txt"; }
publish() {
  local wt="$DIR/replay-results"
  git -C "$wt" pull -q --rebase "$GH/$REPO.git" replay-results 2>/dev/null
  mkdir -p "$wt/tests/$RUN" && cp -r "$OUT"/. "$wt/tests/$RUN/"
  git -C "$wt" add -A tests && git -C "$wt" commit -q -m "tests $RUN: $1" || true
  git -C "$wt" push -q "$GH/$REPO.git" replay-results 2>&1 | tail -1
}
stop() { log "STOPPED: $*"; docker rm -f $NODE_C zp-tput-s1 zp-tput-s2 > /dev/null 2>&1; publish "stopped: $*"; exit 1; }
height() { curl -fs -m 10 $API/blockchain/info | sed -n 's/.*"blocks" *: *\([0-9]*\).*/\1/p'; }

# the same patch for both trees: local chain in Release (LOCALCHAIN), block interval BLOCK_S
patch_tree() {  # $1: tree, $2: the local chain's blockInterval line pattern (sed regex)
  local t=$1
  find "$t/src" -name '*.fs' ! -path '*Tests*' ! -name 'Log.fs' -print0 | xargs -0 sed -i 's/^\(\s*\)#if DEBUG\s*$/\1#if DEBUG || LOCALCHAIN/'
  sed -i "s/$2/blockInterval=${BLOCK_S}000UL;   \/\/ throughput comparison (lab-throughput.sh)/" "$t/src/Consensus/Chain.fs"
  grep -q "blockInterval=${BLOCK_S}000UL;   // throughput comparison" "$t/src/Consensus/Chain.fs" || return 1
  if [ -n "$REALISTIC" ]; then   # the local chain's easiest target (it occurs only there in Chain.fs, in both trees)
    sed -i "s/0x20fffffful/${POW_LIMIT}ul/" "$t/src/Consensus/Chain.fs"; grep -q "${POW_LIMIT}ul" "$t/src/Consensus/Chain.fs"
  fi
}

# ---- sources ----
log "$([ -n "$PROFILE" ] && echo "profile of ours at $PROFILE_RATE/min" || echo "throughput comparison: rates $RATES /min x $RUNS runs, shuffled (seed $SEED), $STEP_MIN min steps (1 min warm-up)"); Release + LOCALCHAIN, ${BLOCK_S} s blocks"
git -C "$DIR" fetch -q origin "$UPSTREAM" 2>/dev/null; git -C "$DIR" cat-file -e "$UPSTREAM^{commit}" || stop "upstream commit $UPSTREAM not in $DIR"
rm -rf "$W/a" "$W/a0" && mkdir -p "$W/a" "$W/a0" && git -C "$DIR" archive "$UPSTREAM" | tar -x -C "$W/a" && cp -r "$W/a/src" "$W/a0/" || stop "archive A"
patch_tree "$W/a" 'blockInterval=1000UL \* 60UL;' || stop "A patch"
(cd "$W" && diff -ru a0/src a/src) > "$OUT/A-patch.diff"; rm -rf "$W/a0"
cp "$DIR/Docker/devnet-entrypoint.sh" "$W/a/"
sed -e 's|msbuild src/zenprotocol.sln /p:Configuration=Debug|msbuild src/zenprotocol.sln /p:Configuration=Release /p:DefineConstants=LOCALCHAIN|' \
    -e 's|bin/Debug|bin/Release|g' "$DIR/Docker/Dockerfile.upstream-devnet" > "$W/a/Dockerfile.tput"
# Mono 6.12's TLS no longer verifies nuget.org (CERTIFICATE_VERIFY_FAILED, 2026-10-17, also after cert-sync), and a
# patched src (REALISTIC=1) reruns paket restore: take the packages from an A image built before, so restore has
# nothing to download (paket.lock is upstream's, so the packages are the same)
if docker image inspect zen-tput-a > /dev/null 2>&1 && docker run --rm --entrypoint test zen-tput-a -d /src/packages; then
  docker tag zen-tput-a zen-tput-a-packages
  sed -i 's|^RUN mono .paket/paket.exe restore|COPY --from=zen-tput-a-packages /src/packages ./packages\nRUN mono .paket/paket.exe restore|' "$W/a/Dockerfile.tput"
  log "A: packages from the previous A image (zen-tput-a-packages)"
fi
if [ -d "$W/b-src/.git" ]; then git -C "$W/b-src" fetch -q "$GH/navoranetwork/zp-pow.git" "$BRANCH_B" && git -C "$W/b-src" checkout -q -f FETCH_HEAD
else git clone -q -b "$BRANCH_B" "$GH/navoranetwork/zp-pow.git" "$W/b-src"; fi || stop "B source"
rm -rf "$W/b" "$W/b0" && mkdir -p "$W/b" "$W/b0" && git -C "$W/b-src" archive HEAD | tar -x -C "$W/b" && cp -r "$W/b/src" "$W/b0/" || stop "archive B"
patch_tree "$W/b" 'blockInterval=2000UL;' || stop "B patch"
(cd "$W" && diff -ru b0/src b/src) > "$OUT/B-patch.diff"; rm -rf "$W/b0"
cp "$DIR/Docker/devnet-entrypoint.sh" "$W/b/Docker/"
sed -e 's|-c Debug|-c Release -p:DefineConstants=LOCALCHAIN|g' -e 's|bin/Debug|bin/Release|g' "$W/b/Docker/Dockerfile.devnet" > "$W/b/Docker/Dockerfile.tput"
if [ -d "$W/wallet-src/.git" ]; then git -C "$W/wallet-src" fetch -q origin node-upgrade-script && git -C "$W/wallet-src" checkout -q -f FETCH_HEAD
else git clone -q -b node-upgrade-script "$GH/$REPO.git" "$W/wallet-src"; fi || stop "wallet source"
log "B: $(git -C "$W/b-src" log --oneline -1 | cut -c1-70); load tool: zenprotocol $(git -C "$W/wallet-src" log --oneline -1 | cut -c1-50)"
docker run --rm -v "$W/wallet-src/wallet:/w" -w /w node:22 sh -c "npm ci --no-audit --no-fund > /dev/null" || stop "npm ci"
publish "started"

# ---- images ----
if [ -z "$PROFILE" ] && [ "${ONLY:-}" != B ]; then
  log "build A (upstream, Mono, Release+LOCALCHAIN)"; (cd "$W/a" && docker build -f Dockerfile.tput -t zen-tput-a .) > "$OUT/A-build.txt" 2>&1 || stop "A build (A-build.txt)"
fi
if [ "${ONLY:-}" != A ]; then
  log "build B (ours, .NET 10, Release+LOCALCHAIN)"; (cd "$W/b" && docker build -f Docker/Dockerfile.tput -t zen-tput-b .) > "$OUT/B-build.txt" 2>&1 || stop "B build (B-build.txt)"
fi

addr_of() {
  docker run --rm -v "$W/wallet-src/wallet:/w" -w /w -e M="$1" node:22 node --input-type=module -e \
    "import { openWallet, receiveAddress } from './src/wallet.js'; console.log(receiveAddress(openWallet({id:'x',name:'x',network:'test',kind:'mnemonic'}, process.env.M)))"
}

start_node() {  # $1: A or B (or B-<variant>), $2: result folder. A fresh chain, mining, both senders funded and mature
  local K=$1 D=$2 IMG=zen-tput-$(echo ${1:0:1} | tr AB ab)
  docker rm -f $NODE_C zp-tput-s1 zp-tput-s2 > /dev/null 2>&1; rm -rf "$W/diag"; mkdir -p "$W/diag"
  docker run -d --name $NODE_C --cpuset-cpus 0-3 -p 127.0.0.1:20000:20000 -v "$W/diag:/tmp" -e NODES=1 -e MINER_THREADS=1 \
    -e DEVNET_MNEMONIC="$M0" $NODE_ENV $IMG > /dev/null || stop "$K: docker run"
  local h=""; for i in $(seq 360); do sleep 5; h=$(height); [ -n "$h" ] && [ "$h" -ge 40 ] && break
    docker inspect -f '{{.State.Running}}' $NODE_C 2>/dev/null | grep -q true || break; done
  [ -n "$h" ] && [ "$h" -ge 40 ] || { docker logs --tail 50 $NODE_C > "$D/node-start.log" 2>&1; stop "$K: the node does not mine (node-start.log)"; }
  local a1 a2; a1=$(addr_of "$M1") || stop "$K: address of sender 1"; a2=$(addr_of "$M2") || stop "$K: address of sender 2"
  r=$(curl -s -m 120 -X POST -H 'Content-Type: application/json' $API/wallet/send \
      -d "{\"outputs\":[{\"address\":\"$a1\",\"asset\":\"00\",\"amount\":\"3000000000\"},{\"address\":\"$a2\",\"asset\":\"00\",\"amount\":\"3000000000\"}],\"password\":\"devnet\"}")
  echo "send to sender 1 ($a1) and sender 2 ($a2): $r" > "$D/fund.txt"
  # both wallets need >= 20 ZP mature (coinbase maturity 10): wait 40 more blocks
  for i in $(seq 360); do sleep 5; h2=$(height); [ -n "$h2" ] && [ "$h2" -ge $((h + 40)) ] && break; done
  if [ -n "$REALISTIC" ]; then  # the difficulty starts at POW_LIMIT: wait until a minute holds at most 60/BLOCK_S + 2 blocks
    local h0 hn ok=""; for i in $(seq 120); do h0=$(height); sleep 60; hn=$(height)
      [ -n "$h0" ] && [ -n "$hn" ] && [ $((hn - h0)) -le $((60 / BLOCK_S + 2)) ] && { ok=1; break; }; done
    [ -n "$ok" ] || stop "$K: blocks did not slow to ${BLOCK_S} s in 120 min"
    log "$K: blocks near ${BLOCK_S} s ($((hn - h0)) in the last minute, block $hn)"
  fi
  log "$K: node up, block $(height), senders 1 and 2 funded"
}

stats_loop() {  # docker stats every 10 s into $1
  ( echo "time,cpu_percent,mem_usage"; while docker inspect $NODE_C > /dev/null 2>&1; do
      docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' $NODE_C 2>/dev/null | sed "s/^/$(date -u +%H:%M:%S),/"; sleep 10; done ) > "$1" &
  echo $!
}

senders() {  # $1: result folder, $2: per-sender rates, $3: step minutes, $4: max minutes
  for s in 1 2; do
    local m; [ $s = 1 ] && m="$M1" || m="$M2"
    local cpus; [ $s = 1 ] && cpus=4-5 || cpus=6-7
    mkdir -p "$1/s$s"
    docker run -d --name zp-tput-s$s --cpuset-cpus $cpus --network host -v "$W/wallet-src/wallet:/w" -v "$1/s$s:/out" -w /w \
      -e TESTNET_MNEMONIC="$m" node:22 node tools/load-test.mjs --node $API --rates "$2" --step-min "$3" \
      --outputs 20000 --unit 0.001 --max-min "$4" --max-mempool 400000 --out /out > /dev/null || stop "sender $s"
  done
  # both senders must get past their split (a few blocks): a sender that exits early makes a one-sender run
  for i in $(seq 60); do sleep 10
    [ -f "$1/s1/load.csv" ] && [ -f "$1/s2/load.csv" ] && return 0
    for s in 1 2; do
      docker inspect -f '{{.State.Running}}' zp-tput-s$s 2>/dev/null | grep -q true && continue
      [ -f "$1/s$s/load.csv" ] && continue
      docker logs --tail 20 zp-tput-s$s > "$1/s$s/sender.log" 2>&1; stop "sender $s exited before its load ($(tail -1 "$1/s$s/sender.log"))"
    done
  done
  stop "the senders did not start their load in 10 minutes"
}

collect() {  # $1: result folder, $2: stats pid
  docker wait zp-tput-s1 zp-tput-s2 > /dev/null
  for s in 1 2; do docker logs zp-tput-s$s > "$1/s$s/sender.log" 2>&1; done
  docker rm -f zp-tput-s1 zp-tput-s2 > /dev/null 2>&1
  docker exec $NODE_C sh -c 'cat /data/logs/node0.log' 2>/dev/null | gzip > "$1/node0.log.gz"
  kill $2 2>/dev/null; wait $2 2>/dev/null
}

if [ -n "$PROFILE" ]; then
  NODE_ENV="${PROFILE_ENV:-}"   # e.g. PROFILE_ENV="-e ZP_TEMPLATE_INTERVAL_MS=1000"
  D="$OUT/B"; mkdir -p "$D"; start_node B "$D"; SP=$(stats_loop "$D/stats.csv")
  half=$((PROFILE_RATE / 2)); log "profile: load $PROFILE_RATE/min (two senders), trace 60 s at minute 2"
  senders "$D" "$half" 9 10   # long enough for the trace, the counters and the dumps
  sleep 120
  pid=$(docker exec $NODE_C sh -c 'for p in /proc/[0-9]*; do [ "$p" = /proc/$$ ] && continue; case "$(tr "\0" " " < $p/cmdline 2>/dev/null)" in *dotnet*zen-node.dll*|*zen-node.dll*) basename $p;; esac; done' | head -1)
  [ -n "$pid" ] || stop "profile: no zen-node process in the container"
  docker run --rm --pid container:$NODE_C -v "$W/diag:/tmp" -v "$D:/out" mcr.microsoft.com/dotnet/sdk:10.0 sh -c \
    "dotnet tool install -g dotnet-trace > /dev/null && /root/.dotnet/tools/dotnet-trace collect -p $pid --providers Microsoft-DotNETCore-SampleProfiler,Microsoft-Windows-DotNETRuntime:0x1:4 --duration 00:00:01:00 --format speedscope -o /out/trace.nettrace" \
    > "$D/trace.txt" 2>&1 || log "profile: dotnet-trace failed (trace.txt)"
  # what is finalized (item 3), where the memory goes (item 4), GC pauses (item 5)
  docker run --rm --pid container:$NODE_C --cap-add SYS_PTRACE -v "$W/diag:/tmp" -v "$D:/out" mcr.microsoft.com/dotnet/sdk:10.0 sh -c \
    "for t in dotnet-dump dotnet-gcdump dotnet-counters; do dotnet tool install -g \$t > /dev/null; done; T=/root/.dotnet/tools
     \$T/dotnet-counters collect -p $pid --counters System.Runtime --refresh-interval 1 --duration 00:00:01:00 --format csv -o /out/counters.csv > /dev/null
     \$T/dotnet-gcdump collect -p $pid -o /out/heap.gcdump > /dev/null && \$T/dotnet-gcdump report /out/heap.gcdump > /out/heap-report.txt
     \$T/dotnet-dump collect -p $pid --type Heap -o /tmp/core.dmp > /dev/null && \$T/dotnet-dump analyze /tmp/core.dmp -c 'finalizequeue' -c exit > /out/finalizequeue.txt
     rm -f /tmp/core.dmp /out/heap.gcdump" > "$D/diag.txt" 2>&1 || log "profile: diagnostics failed (diag.txt)"
  collect "$D" "$SP"; docker rm -f $NODE_C > /dev/null 2>&1
  [ -f "$D/trace.speedscope.json" ] && python3 "$DIR/scripts/speedscope-top.py" "$D/trace.speedscope.json" > "$D/profile-top.txt" 2>&1
  rm -f "$D/trace.nettrace"; gzip -f "$D/trace.speedscope.json" 2>/dev/null
  log "profile done: $(head -3 "$D/profile-top.txt" 2>/dev/null | tr '\n' ' ')"
  publish "done"; exit 0
fi

# the shuffled schedule (the same for A and B): every rate RUNS times; per sender, half of each
SCHED=$(python3 -c "import random,sys; r=[int(x) for x in sys.argv[1].split(',')]*int(sys.argv[2]); random.Random(int(sys.argv[3])).shuffle(r); print(','.join(map(str,r)))" "$RATES" "$RUNS" "$SEED")
HALF=$(echo "$SCHED" | tr ',' '\n' | awk '{printf "%s%d", (NR>1?",":""), $1/2}')
NSTEPS=$(echo "$SCHED" | tr ',' '\n' | wc -l); MAXMIN=$((NSTEPS * STEP_MIN + 15))
echo "$SCHED" > "$OUT/schedule.txt"; log "schedule (total per minute): $SCHED"

run_one() {
  local K=$1 D="$OUT/$1"; mkdir -p "$D"
  start_node $K "$D"; local SP; SP=$(stats_loop "$D/stats.csv")
  log "$K: load, $NSTEPS steps of $STEP_MIN min"
  senders "$D" "$HALF" "$STEP_MIN" "$MAXMIN"
  collect "$D" "$SP"
  log "$K: done at block $(height)"
  docker rm -f $NODE_C > /dev/null 2>&1
  publish "$K done"
}
[ "${ONLY:-}" != B ] && run_one A
if [ "${ONLY:-}" != A ]; then
  if [ -z "$VARIANTS" ]; then run_one B
  else for v in $VARIANTS; do   # tN[s0]: template interval N ms; s0 = remembered signatures off
    n=${v#t}; n=${n%s0}; NODE_ENV="-e ZP_TEMPLATE_INTERVAL_MS=$n"; case $v in *s0) NODE_ENV="$NODE_ENV -e ZP_VERIFIED_SIGNATURES=0";; esac
    run_one "B-$v"; done; NODE_ENV=""; fi
fi
python3 "$DIR/scripts/throughput-report.py" "$OUT" > "$OUT/report.txt" 2>&1 || log "report failed (report.txt)"
log "done"; publish "done"
