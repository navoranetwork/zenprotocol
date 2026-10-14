#!/bin/bash
# The public testnet node's switch to V1 (fork at block 2050; switch after the CGP payout at 2010).
#
#   build    (on zp-lab-1; GH_TOKEN in the environment): builds zen-node:testnet-v1 from zp-pow testnet-v1
#            with the pinned V1 toolchain (TC_COMMIT; the image build verifies Zulib and checks the token
#            DLL hash), and saves it to /opt/zp-lab/zen-node-testnet-v1.tar.gz (+ .sha256)
#   install  (on the testnet server, after copying the .tar.gz and .sha256 there): loads the image, tags the
#            image the node runs now as zen-node:testnet-pre-v1 (rollback), recreates the node from the same
#            docker-compose project with the new image (same volume, same environment), waits for it to
#            sync and checks it follows the chain
#   rollback (on the testnet server, only BEFORE block 2050): back to zen-node:testnet-pre-v1
#   smoke    the V1 toolchain inside the running node container: SDK, F*, Zulib stamp, and one real
#            contract build (token template, pinned hash); install runs it right after the switch
#   status   height, image, compose project (what install will recreate), last errors
#   install-when-ready <tar.gz>  waits (checking every minute) until block 2011, then runs install; run it
#            under systemd-run so nobody has to be awake for the payout:
#            systemd-run --unit zp-switch bash /root/testnet-v1-switch.sh install-when-ready /root/zen-node-testnet-v1.tar.gz
#
#   systemd-run --unit zp-image --property=EnvironmentFile=/etc/zp-lab.env bash /opt/zp-lab/scripts/testnet-v1-switch.sh build
#   scp root@zp-lab-1:/opt/zp-lab/zen-node-testnet-v1.tar.gz* /root/ && bash testnet-v1-switch.sh install /root/zen-node-testnet-v1.tar.gz
set -uo pipefail
MODE=${1:?build, install, rollback or status}
NAME=${NODE_CONTAINER:-zen-testnet}; NEW=zen-node:testnet-v1; OLD=zen-node:testnet-pre-v1
API=${API:-http://127.0.0.1:31567}
log() { echo "[$(date -u +%F' '%H:%M)] $*"; }
height() { curl -fs -m 10 "$API/blockchain/info" | sed -n 's/.*"blocks" *: *\([0-9]*\).*/\1/p'; }

recreate() {   # $1: image. The node's compose project, file and service, from the container's labels
  local img=$1 dir file svc
  dir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$NAME" 2>/dev/null)
  file=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$NAME" 2>/dev/null)
  svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$NAME" 2>/dev/null)
  if [ -z "$dir" ] || [ -z "$svc" ]; then
    log "container $NAME was not started by docker compose: recreate it by hand with image $img, same volumes and environment:"
    docker inspect -f '{{.Config.Image}} {{range .Config.Env}}{{println .}}{{end}}{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$NAME"
    exit 1
  fi
  log "compose: $dir ($file), service $svc -> $img"
  # the values the node runs with now (compose takes MINER_THREADS etc. from the shell that started it)
  local v; for v in MINER_THREADS EXTERNAL_IP WALLET_API SEEDS TESTNET_MNEMONIC NETWORK_URL; do
    local val; val=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n "s/^$v=//p" | head -1)
    export "$v=$val"
  done
  log "keeping MINER_THREADS=$MINER_THREADS WALLET_API=$WALLET_API EXTERNAL_IP=$EXTERNAL_IP SEEDS=$SEEDS"
  (cd "$dir" && ZEN_TESTNET_IMAGE=$img docker compose -f "${file%%,*}" up -d --no-build --force-recreate "$svc") || { log "compose up failed"; exit 1; }
  docker inspect -f '{{.Config.Image}}' "$NAME" | grep -qx "$img" \
    || { log "the compose file does not take ZEN_TESTNET_IMAGE (image is $(docker inspect -f '{{.Config.Image}}' "$NAME")): set image: $img in it and run again"; exit 1; }
}

smoke() {   # the V1 build toolchain inside the running container ($1: container)
  log "smoke test in $1 (image $(docker inspect -f '{{.Image}}' "$1" | cut -c1-19))"
  docker exec "$1" sh -c '
    set -e
    echo "sdks: $(dotnet --list-sdks | tr "\n" " ")"
    echo "fstar: $($FSTAR_HOME/bin/fstar.exe --version | head -1)  (FSTAR_HOME=$FSTAR_HOME)"
    echo "python3: $(python3 --version)"
    echo "toolchain: $ZP_V1_TOOLCHAIN, Zulib stamp $(cat $ZP_V1_TOOLCHAIN/zulib/.cache_full/SOURCES.sha256)"
    ls /zen/libsecp256k1.so > /dev/null && echo "libsecp256k1: present"
    W=$(mktemp -d); $ZP_V1_TOOLCHAIN/tools/engine/zp-engine make token --out $W/t > /dev/null
    $ZP_V1_TOOLCHAIN/scripts/build-contract.sh --lax $W/t/contract.fst $W/out > $W/b.txt 2>&1 || { echo "build exit $?"; tail -5 $W/b.txt; exit 1; }
    echo "token template DLL: $(sha256sum $W/out/Z*.dll | cut -c1-64)"; rm -rf $W' 2>&1 | sed 's/^/  /'
  local rc=${PIPESTATUS[0]}
  if [ "$rc" = 0 ]; then log "SMOKE OK"; else log "SMOKE FAILED (exit $rc): this node cannot build V1 contracts - roll back BEFORE block 2050 (testnet-v1-switch.sh rollback)"; fi
  return $rc
}

case $MODE in
build)
  : "${GH_TOKEN:?}"; TC_COMMIT=${TC_COMMIT:-c86a2c4}; SRC=/opt/zp-pow-image; GH="https://x-access-token:$GH_TOKEN@github.com"
  rm -rf "$SRC" && git clone -q -b testnet-v1 "$GH/navoranetwork/zp-pow.git" "$SRC" || exit 1
  [ -d /opt/zp-contracts-v1/.git ] || git clone -q "$GH/navoranetwork/zp-contracts-v1.git" /opt/zp-contracts-v1
  git -C /opt/zp-contracts-v1 fetch -q "$GH/navoranetwork/zp-contracts-v1.git" main || exit 1
  git -C /opt/zp-contracts-v1 archive --prefix=zp-contracts-v1/ "$TC_COMMIT" | tar -x -C "$SRC" || exit 1
  log "node $(git -C "$SRC" log --oneline -1 | cut -c1-70); toolchain $(git -C /opt/zp-contracts-v1 log --oneline -1 "$TC_COMMIT" | cut -c1-60)"
  grep -n "v1ContractsHeight=" "$SRC/src/Consensus/Chain.fs"
  (cd "$SRC" && docker build -f Docker/Dockerfile.testnet-v1 -t $NEW .) > /opt/zp-lab/image-build.txt 2>&1 || { tail -30 /opt/zp-lab/image-build.txt; exit 1; }
  grep -ohE 'Zulib: [0-9]+ of [0-9]+ modules verify|token template DLL: [0-9a-f]{64}' /opt/zp-lab/image-build.txt
  docker save $NEW | gzip > /opt/zp-lab/zen-node-testnet-v1.tar.gz && (cd /opt/zp-lab && sha256sum zen-node-testnet-v1.tar.gz > zen-node-testnet-v1.tar.gz.sha256)
  log "saved: $(cat /opt/zp-lab/zen-node-testnet-v1.tar.gz.sha256) ($(du -h /opt/zp-lab/zen-node-testnet-v1.tar.gz | cut -f1))"
  ;;
install)
  TAR=${2:?the image .tar.gz}
  (cd "$(dirname "$TAR")" && sha256sum -c "$(basename "$TAR").sha256") || { log "checksum mismatch"; exit 1; }
  h=$(height); log "node $NAME at block ${h:-?} on $(docker inspect -f '{{.Config.Image}}' "$NAME")"
  [ -n "$h" ] && [ "$h" -ge 2050 ] && [ -z "${FORCE:-}" ] && { log "already at or past the fork height 2050: this node would have to resync (FORCE=1 to go on)"; exit 1; }
  [ -n "$h" ] && [ "$h" -lt 2011 ] && [ -z "${FORCE:-}" ] && { log "the CGP payout at 2010 is not done yet (FORCE=1 to switch before it)"; exit 1; }
  gunzip -c "$TAR" | docker load | tail -1
  # the rollback image is the one that ran before V1: keep it if an earlier install already tagged it
  if docker image inspect $OLD > /dev/null 2>&1; then log "rollback image kept: $OLD ($(docker image inspect -f '{{.Id}}' $OLD | cut -c1-19))"
  else docker tag "$(docker inspect -f '{{.Image}}' "$NAME")" $OLD && log "rollback image: $OLD"; fi
  log "installing image $(docker image inspect -f '{{.Id}}' $NEW) from $(cut -c1-16 "$TAR.sha256")..."
  recreate $NEW
  for i in $(seq 1 60); do sleep 10; n=$(height); [ -n "$n" ] && [ "$n" -ge "${h:-0}" ] && break; done
  log "node on $NEW at block $(height)"
  smoke "$NAME"
  log "following for 10 minutes"
  sleep 600; log "now at block $(height)"
  docker logs --since 15m "$NAME" 2>&1 | grep -iE "\[(ERR|FTL)|unhandled exception|invalid block" | tail -10 || true   # no matches is success
  ;;
rollback)
  h=$(height); [ -n "$h" ] && [ "$h" -ge 2050 ] && [ -z "${FORCE:-}" ] && { log "past the fork: rolling back means leaving V1 (FORCE=1)"; exit 1; }
  recreate $OLD; sleep 60; log "node on $OLD at block $(height)"
  ;;
install-when-ready)
  TAR=${2:?the image .tar.gz}
  (cd "$(dirname "$TAR")" && sha256sum -c "$(basename "$TAR").sha256") || { log "checksum mismatch"; exit 1; }
  log "waiting for block 2011 (the CGP payout at 2010 first)"
  while :; do
    h=$(height)
    if [ -n "$h" ] && [ "$h" -ge 2050 ]; then log "block $h: past the fork, NOT switching (needs a decision)"; exit 1; fi
    if [ -n "$h" ] && [ "$h" -ge 2011 ]; then log "block $h: switching"; exec bash "$0" install "$TAR"; fi
    [ $(( $(date +%s) / 60 % 30 )) = 0 ] && log "block ${h:-?}"
    sleep 60
  done
  ;;
smoke)
  smoke "${2:-$NAME}"
  ;;
status)
  log "node $NAME on $(docker inspect -f '{{.Config.Image}}' "$NAME") (image $(docker inspect -f '{{.Image}}' "$NAME")) at block $(height)"
  docker image inspect $NEW > /dev/null 2>&1 && log "loaded $NEW: $(docker image inspect -f '{{.Id}}' $NEW)"
  for f in /root/zen-node-testnet-v1.tar.gz.sha256; do [ -f "$f" ] && log "image file waiting: $(cut -c1-64 "$f")"; done
  dir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$NAME" 2>/dev/null)
  if [ -n "$dir" ]; then
    log "compose: $dir ($(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$NAME")), service $(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$NAME")"
    grep -n "image:" "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$NAME" | cut -d, -f1)" | head -3
  else log "NOT started by docker compose: install will stop and print what to recreate by hand"; fi
  log "env: $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | grep -E '^(MINER_THREADS|WALLET_API|EXTERNAL_IP|SEEDS|NETWORK)=' | tr '\n' ' ')"
  docker logs --since 30m "$NAME" 2>&1 | grep -iE "V1|\[(ERR|FTL)|invalid block" | tail -10 || true
  ;;
*) echo "unknown mode $MODE"; exit 2 ;;
esac
