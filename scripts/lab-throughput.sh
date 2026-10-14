#!/bin/bash
# Throughput comparison on zp-lab-1: the ORIGINAL Zen node (A) and ours (B), same machine, same load, one at a time.
#   A  upstream a0191cbc (the last upstream commit before ours), built from source as upstream's CI did
#      (Mono, paket, msbuild, Debug), with ONE change: the local chain's block interval 60 s -> 2 s (as ours).
#   B  ours: zp-pow testnet-v1 (BRANCH_B, default the branch head), Debug devnet image (.NET 10).
# Both: one node on the `local` chain (Debug builds have it), 1 miner thread, address index on, fresh chain each run,
# node container pinned to CPUs 0-3, the senders to 4-7. Load: wallet/tools/load-test.mjs (zenprotocol
# node-upgrade-script) from two senders with their own funded wallets, each at half the total rate, same steps for A
# and B. Every 10 s: docker stats of the node. Results on the branch replay-results, tests/throughput-<date>/:
# A-*/ and B-*/ with summary.json + blocks.csv + load.csv per sender, stats.csv, the node log, and the A patch.
#
# On zp-lab-1, as root (/etc/zp-lab.env holds GH_TOKEN):
#   cd /opt/zp-lab && git pull -q && systemd-run --unit zp-tput --property=EnvironmentFile=/etc/zp-lab.env \
#     bash /opt/zp-lab/scripts/lab-throughput.sh
#   journalctl -u zp-tput -f
# Settings: RATES (total transfers per minute, default 600,1200,3000,6000,12000,30000), STEP_MIN (5), ONLY=A|B.
set -uo pipefail
: "${GH_TOKEN:?}"
DIR=/opt/zp-lab; REPO=navoranetwork/zenprotocol; GH="https://x-access-token:$GH_TOKEN@github.com"
UPSTREAM=a0191cbc; BRANCH_B=${BRANCH_B:-testnet-v1}
RATES=${RATES:-600,1200,3000,6000,12000,30000}; STEP_MIN=${STEP_MIN:-5}
STAMP=$(date -u +%Y%m%d-%H%M); RUN="throughput-$STAMP"; OUT="$DIR/replay-out/$RUN"; mkdir -p "$OUT"
W=/opt/zp-tput; mkdir -p "$W"
M1="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
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

# ---- sources ----
log "throughput comparison: A = upstream $UPSTREAM (+ block interval 2 s), B = zp-pow $BRANCH_B; rates $RATES /min, $STEP_MIN min each"
git -C "$DIR" fetch -q origin "$UPSTREAM" 2>/dev/null; git -C "$DIR" cat-file -e "$UPSTREAM^{commit}" || stop "upstream commit $UPSTREAM not in $DIR"
rm -rf "$W/a" && mkdir -p "$W/a" && git -C "$DIR" archive "$UPSTREAM" | tar -x -C "$W/a" || stop "archive A"
sed -i 's/blockInterval=1000UL \* 60UL;/blockInterval=2000UL;   \/\/ throughput comparison: 2 s blocks, as our devnet/' "$W/a/src/Consensus/Chain.fs"
diff -u <(git -C "$DIR" show "$UPSTREAM:src/Consensus/Chain.fs") "$W/a/src/Consensus/Chain.fs" > "$OUT/A-patch.diff"
grep -q "blockInterval=2000UL" "$W/a/src/Consensus/Chain.fs" || stop "A patch did not apply"
cp "$DIR/Docker/devnet-entrypoint.sh" "$DIR/Docker/Dockerfile.upstream-devnet" "$W/a/"
if [ -d "$W/b/.git" ]; then git -C "$W/b" fetch -q "$GH/navoranetwork/zp-pow.git" "$BRANCH_B" && git -C "$W/b" checkout -q -f FETCH_HEAD
else git clone -q -b "$BRANCH_B" "$GH/navoranetwork/zp-pow.git" "$W/b"; fi || stop "B source"
if [ -d "$W/wallet-src/.git" ]; then git -C "$W/wallet-src" fetch -q origin node-upgrade-script && git -C "$W/wallet-src" checkout -q -f FETCH_HEAD
else git clone -q -b node-upgrade-script "$GH/$REPO.git" "$W/wallet-src"; fi || stop "wallet source"
log "B: $(git -C "$W/b" log --oneline -1 | cut -c1-70); load tool: zenprotocol $(git -C "$W/wallet-src" log --oneline -1 | cut -c1-50)"
docker run --rm -v "$W/wallet-src/wallet:/w" -w /w node:22 sh -c "npm ci --no-audit --no-fund > /dev/null" || stop "npm ci"
publish "started"

# ---- images ----
if [ "${ONLY:-}" != B ]; then
  log "build A (upstream, Mono)"; (cd "$W/a" && docker build -f Dockerfile.upstream-devnet -t zen-tput-a .) > "$OUT/A-build.txt" 2>&1 || stop "A build (A-build.txt)"
fi
if [ "${ONLY:-}" != A ]; then
  log "build B (ours, .NET 10)"; (cd "$W/b" && cp "$DIR/Docker/devnet-entrypoint.sh" Docker/ && docker build -f Docker/Dockerfile.devnet -t zen-tput-b .) > "$OUT/B-build.txt" 2>&1 || stop "B build (B-build.txt)"
fi

addr_of() {  # the wallet's receive address for a mnemonic (as the load tool derives it)
  docker run --rm -v "$W/wallet-src/wallet:/w" -w /w -e M="$1" node:22 node --input-type=module -e \
    "import { openWallet, receiveAddress } from './src/wallet.js'; console.log(receiveAddress(openWallet({id:'x',name:'x',network:'test',kind:'mnemonic'}, process.env.M)))"
}

run_one() {  # $1: A or B
  local K=$1 IMG=zen-tput-$(echo $1 | tr AB ab) D="$OUT/$1"; mkdir -p "$D"
  docker rm -f $NODE_C zp-tput-s1 zp-tput-s2 > /dev/null 2>&1
  log "$K: start the node (fresh chain)"
  docker run -d --name $NODE_C --cpuset-cpus 0-3 -p 127.0.0.1:20000:20000 -e NODES=1 -e MINER_THREADS=1 \
    -e DEVNET_MNEMONIC="$M1" $IMG > /dev/null || stop "$K: docker run"
  for i in $(seq 180); do sleep 5; h=$(height); [ -n "$h" ] && [ "$h" -ge 60 ] && break; done
  [ -n "$h" ] && [ "$h" -ge 60 ] || { docker logs --tail 50 $NODE_C > "$D/node-start.log" 2>&1; stop "$K: the node does not mine (node-start.log)"; }
  log "$K: mining, block $h; fund sender 2"
  local a2; a2=$(addr_of "$M2") || stop "$K: address of sender 2"
  r=$(curl -s -m 120 -X POST -H 'Content-Type: application/json' $API/wallet/send \
      -d "{\"outputs\":[{\"address\":\"$a2\",\"asset\":\"00\",\"amount\":\"4000000000\"}],\"password\":\"devnet\"}")
  echo "send to sender 2 ($a2): $r" > "$D/fund.txt"
  for i in $(seq 60); do sleep 5; h2=$(height); [ "$h2" -ge $((h + 12)) ] && break; done
  # docker stats every 10 s
  ( echo "time,cpu_percent,mem_usage"; while docker inspect $NODE_C > /dev/null 2>&1; do
      docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' $NODE_C 2>/dev/null | sed "s/^/$(date -u +%H:%M:%S),/"; sleep 10; done ) > "$D/stats.csv" &
  local SP=$!
  # per-sender rates: half of each total rate
  local half; half=$(echo "$RATES" | tr ',' '\n' | awk '{printf "%s%d", (NR>1?",":""), $1/2}')
  log "$K: load, per sender $half /min, $STEP_MIN min each"
  for s in 1 2; do
    local m; [ $s = 1 ] && m="$M1" || m="$M2"
    local cpus; [ $s = 1 ] && cpus=4-5 || cpus=6-7
    mkdir -p "$D/s$s"
    docker run -d --name zp-tput-s$s --cpuset-cpus $cpus --network host -v "$W/wallet-src/wallet:/w" -v "$D/s$s:/out" -w /w \
      -e TESTNET_MNEMONIC="$m" node:22 node tools/load-test.mjs --node $API --rates "$half" --step-min "$STEP_MIN" \
      --outputs 20000 --unit 0.001 --max-min 60 --max-mempool 200000 --out /out > /dev/null || stop "$K: sender $s"
  done
  docker wait zp-tput-s1 zp-tput-s2 > /dev/null
  for s in 1 2; do docker logs zp-tput-s$s > "$D/s$s/sender.log" 2>&1; done
  docker rm -f zp-tput-s1 zp-tput-s2 > /dev/null 2>&1
  docker exec $NODE_C sh -c 'cat /data/logs/node0.log' 2>/dev/null | gzip > "$D/node0.log.gz"
  kill $SP 2>/dev/null; wait $SP 2>/dev/null
  log "$K: done at block $(height); $(for s in 1 2; do python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('s$s', {k: d[k] for k in d if k in ('steps','achieved_per_min','stopped','reason')})" "$D/s$s/summary.json" 2>/dev/null; done | tr '\n' ' ')"
  docker rm -f $NODE_C > /dev/null 2>&1
  publish "$K done"
}

[ "${ONLY:-}" != B ] && run_one A
[ "${ONLY:-}" != A ] && run_one B
log "done"
publish "done"
