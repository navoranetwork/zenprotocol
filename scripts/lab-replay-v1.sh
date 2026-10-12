#!/bin/bash
# V0 replay with the V1 node, on a lab server (zp-lab-1). Reports go to the branch
# `replay-results` of navoranetwork/zenprotocol, so the result can be read without access
# to the server.
#
# What it checks: a node built from v1-contracts syncs mainnet from genesis (validating and
# re-compiling every V0 contract on the way) and agrees with the stored reference of the
# official 1.0.13 node (branch reference-data: block hashes every 1,000 blocks, CGP and supply
# state), then with the live community node at the same tip.
#
# On a fresh Ubuntu 24.04 server, as root:
#   export GH_TOKEN=<GitHub token with write access to navoranetwork/zenprotocol contents>
#   curl -fsSL https://raw.githubusercontent.com/navoranetwork/zenprotocol/v1-contracts/scripts/lab-replay-v1.sh | bash
#
# It installs Docker, clones the branch, builds the image, starts the replay in the
# background (a systemd unit, so it survives logout), and returns. Progress is pushed every
# hour; the final report when the node reaches the reference height or MAX_HOURS passes.
#   journalctl -u zp-replay -f        # follow it on the server
set -euo pipefail
: "${GH_TOKEN:?export GH_TOKEN (a token with write access to navoranetwork/zenprotocol contents)}"
BRANCH="${BRANCH:-v1-contracts}"
MAX_HOURS="${MAX_HOURS:-48}"
DIR=/opt/zp-lab
REPO=navoranetwork/zenprotocol

# 1. tools
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y git curl python3 ca-certificates >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

# 2. code and packages
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else git clone -q -b "$BRANCH" "https://github.com/$REPO.git" "$DIR"; fi
cd "$DIR"
bash scripts/restore-from-mirror.sh >/dev/null

# 3. image
docker build -f Docker/Dockerfile.v1 -t zen-node:v1 . > /var/log/zp-image-build.log 2>&1 \
  || { tail -30 /var/log/zp-image-build.log; echo "image build failed (full log: /var/log/zp-image-build.log)"; exit 1; }
echo "image zen-node:v1 built ($(git rev-parse --short HEAD))"

# 4. the replay itself, as a service
install -m 600 /dev/null /etc/zp-lab.env
printf 'GH_TOKEN=%s\nMAX_HOURS=%s\n' "$GH_TOKEN" "$MAX_HOURS" > /etc/zp-lab.env
cat > /etc/systemd/system/zp-replay.service <<EOF
[Unit]
Description=ZP V0 replay with the V1 node
After=docker.service
Requires=docker.service
[Service]
Type=simple
EnvironmentFile=/etc/zp-lab.env
WorkingDirectory=$DIR
ExecStart=/bin/bash $DIR/scripts/lab-replay-run.sh
Restart=no
EOF
systemctl daemon-reload
systemctl restart zp-replay
echo "replay started: journalctl -u zp-replay -f   (reports: branch replay-results of $REPO)"
