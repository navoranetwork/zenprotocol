#!/bin/bash
# Install a ZP node in one command, on a fresh Ubuntu server (nothing else installed) or any Linux/macOS machine:
#
#   curl -fsSL https://navora.network/install.sh | bash
#
# (the same file: https://raw.githubusercontent.com/navoranetwork/zenprotocol/node-upgrade-script/scripts/install-node.sh)
#
# What it does: waits for first-boot package updates to finish, checks disk and ports, adds swap on small
# servers, installs Git and Docker if missing (Linux), fetches the code, pulls the ready node image (or builds
# it when the registry is unreachable), loads the newest verified chain snapshot, opens port 9655 in ufw,
# starts the node (it restarts by itself after a reboot) and shows the sync status.
# Re-running it updates the code and restarts; the chain data and earlier settings are kept.
#
# Options (environment variables, in front of `bash`, e.g. `... | MINER_THREADS=2 bash`):
#   MINER_THREADS=2   mine with 2 CPU threads (own hardware only: cloud providers forbid mining)
#   PUBLIC_NODE=1     serve other users' wallets (server; see docs/SETUP.md)
#   SKIP_SNAPSHOT=1   sync from the network instead of loading a snapshot (takes many hours)
#   NO_SWAP=1         do not add a swap file on servers with less than 4 GB RAM
#   DIR=...           install folder (default ~/zenprotocol)
#
# Everything runs inside main(), called on the last line: with `curl | bash` the whole file is read before
# anything starts, so no command can swallow the rest of the script from stdin.
set -euo pipefail

main() {
  DIR="${DIR:-$HOME/zenprotocol}"
  BRANCH="node-upgrade-script"
  REPO="https://github.com/navoranetwork/zenprotocol.git"
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || { echo "Run as root or install sudo."; exit 1; }
    SUDO="sudo"
  fi
  export DEBIAN_FRONTEND=noninteractive
  OS="$(uname)"

  echo "== System"
  if [ "$OS" = "Linux" ]; then
    # a new cloud server installs updates during its first minutes; apt fails while they hold the lock
    command -v cloud-init >/dev/null && $SUDO cloud-init status --wait >/dev/null 2>&1 || true
    wait_apt
  fi

  echo "== Checks"
  mkdir -p "$(dirname "$DIR")"
  FREE_GB=$(df -Pk "$(dirname "$DIR")" | awk 'NR==2 {print int($4/1048576)}')
  echo "free disk: ${FREE_GB}G (needs 20, the snapshot is about 5 GB)"
  [ "$FREE_GB" -ge 20 ] || { echo "Need at least 20 GB free disk. Aborting."; exit 1; }
  if [ ! -d "$DIR/.git" ] && command -v ss >/dev/null; then   # first install: the ports must be free
    for p in 9655 11567; do
      if $SUDO ss -tln 2>/dev/null | grep -q ":$p "; then echo "Port $p is already in use. Aborting."; exit 1; fi
    done
  fi

  if [ "$OS" = "Linux" ] && [ "${NO_SWAP:-0}" != "1" ]; then
    MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    if [ "$MEM_MB" -lt 3900 ] && [ -z "$($SUDO swapon --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
      echo "== Swap (${MEM_MB} MB RAM: adding a 2 GB swap file so the node is not killed for memory)"
      $SUDO fallocate -l 2G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
      $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
    fi
  fi

  echo "== Packages"
  if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null; then
    NEED=""
    for c in git curl; do command -v "$c" >/dev/null || NEED="$NEED $c"; done
    command -v ss >/dev/null || NEED="$NEED iproute2"
    if [ -n "$NEED" ]; then
      $SUDO apt-get update -qq </dev/null
      # shellcheck disable=SC2086
      $SUDO apt-get install -y -qq $NEED ca-certificates </dev/null
    fi
  fi
  command -v git >/dev/null || { echo "Install git first (macOS: xcode-select --install)."; exit 1; }

  echo "== Docker"
  if ! command -v docker >/dev/null; then
    [ "$OS" = "Linux" ] || { echo "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/"; exit 1; }
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    wait_apt
    $SUDO sh /tmp/get-docker.sh </dev/null
    rm -f /tmp/get-docker.sh
  fi
  if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null; then
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true   # start now and after every reboot
  fi
  D="$SUDO docker"; docker info >/dev/null 2>&1 && D="docker"
  $D info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start it (Docker Desktop: open the app) and run this again."; exit 1; }
  if ! $D compose version >/dev/null 2>&1; then
    wait_apt; $SUDO apt-get install -y -qq docker-compose-plugin </dev/null
  fi

  echo "== Code"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only
  else
    git clone -q -b "$BRANCH" "$REPO" "$DIR"
  fi
  cd "$DIR"

  echo "== Firewall"
  if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow 9655/tcp comment 'zen-node p2p' >/dev/null && echo "ufw: port 9655 open"
  else
    echo "If a cloud firewall is used (e.g. Hetzner Cloud Firewall), allow inbound TCP 9655 there."
  fi

  echo "== Settings"
  # keep what an earlier run (or the user) wrote; options given now take precedence
  prev() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 || true; }
  EXTERNAL_IP="${EXTERNAL_IP:-$(curl -fs -m 10 https://api.ipify.org || prev EXTERNAL_IP)}"
  MINER_THREADS="${MINER_THREADS:-$(prev MINER_THREADS)}"; PUBLIC_NODE="${PUBLIC_NODE:-$(prev PUBLIC_NODE)}"
  ZEN_DATA="${ZEN_DATA:-$(prev ZEN_DATA)}"; [ "$OS" = "Darwin" ] && ZEN_DATA="${ZEN_DATA:-zen-data}"   # macOS: a volume, a folder is slow
  OTHER=""; [ -f .env ] && OTHER=$(grep -vE '^(EXTERNAL_IP|MINER_THREADS|PUBLIC_NODE|ZEN_DATA)=' .env || true)
  {
    echo "EXTERNAL_IP=$EXTERNAL_IP"; echo "MINER_THREADS=${MINER_THREADS:-0}"; echo "PUBLIC_NODE=${PUBLIC_NODE:-0}"
    [ -n "$ZEN_DATA" ] && echo "ZEN_DATA=$ZEN_DATA"
    [ -n "$OTHER" ] && echo "$OTHER"
  } > .env.new && mv .env.new .env
  echo "public IP: ${EXTERNAL_IP:-unknown}, mining threads: ${MINER_THREADS:-0}, public node: ${PUBLIC_NODE:-0}"

  echo "== Node image"
  $D compose pull -q zen-node </dev/null 2>/dev/null || { echo "Registry not reachable: building the image here (10-20 minutes)"; $D compose build </dev/null; }

  HAVE_CHAIN=0
  if [ -n "$ZEN_DATA" ] && [ "${ZEN_DATA#*/}" = "$ZEN_DATA" ]; then   # a Docker volume
    $D run --rm -v "$ZEN_DATA:/data" alpine test -d /data/main/blockchaindb >/dev/null 2>&1 && HAVE_CHAIN=1
  else
    [ -d "${ZEN_DATA:-$DIR/zen-data}/main/blockchaindb" ] && HAVE_CHAIN=1
  fi
  if [ "${SKIP_SNAPSHOT:-0}" != "1" ] && [ "$HAVE_CHAIN" = 0 ]; then
    echo "== Chain snapshot (about 5 GB, checked against its sha256)"
    $D compose down >/dev/null 2>&1 || true
    $D compose run --rm -T --no-deps --entrypoint /load-snapshot.sh zen-node </dev/null
  fi

  echo "== Start"
  $D compose up -d --force-recreate </dev/null
  echo "Waiting for the API (a few minutes the first time)..."
  INFO=""
  for _ in $(seq 1 60); do
    INFO=$(curl -fs -m 3 http://127.0.0.1:11567/blockchain/info 2>/dev/null) && break
    sleep 5
  done
  if [ -n "$INFO" ]; then echo "$INFO"; else echo "Not up yet. Watch it with: cd $DIR && $D compose logs -f --tail 50"; fi

  cat <<MSG

Node installed in $DIR. It starts by itself after a reboot.
  Status:  curl -s http://127.0.0.1:11567/blockchain/info   (synced when "blocks" equals "headers")
  Logs:    cd $DIR && $D compose logs -f --tail 50
  Update:  curl -fsSL https://navora.network/install.sh | bash
  Mining:  see docs/SETUP.md (own hardware only)
MSG
}

# wait until no other apt/dpkg process holds the lock (first boot, unattended-upgrades)
wait_apt() {
  [ "$(uname)" = "Linux" ] && command -v fuser >/dev/null || return 0
  local n=0
  while ${SUDO:-} fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do
    [ $n -eq 0 ] && echo "waiting for the system's automatic updates to finish..."
    n=$((n + 1)); [ $n -gt 180 ] && { echo "apt is still busy after 15 minutes; continuing"; return 0; }
    sleep 5
  done
}

main "$@"
