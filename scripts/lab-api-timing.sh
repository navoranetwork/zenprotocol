#!/bin/bash
# GET /blockchain/blocks and /blockchain/headers on a full mainnet database: the node of the last replay
# (container zp-replay, image zen-node:v1, which walks back from the tip) against the image the public mainnet node
# runs (ghcr.io/navoranetwork/zen-node:net10, which reads and sorts every header), on the same data volume, one after
# the other. Each request three times; the answers are compared by their hash.
# On zp-lab-1, as root, after a passed replay:   bash scripts/lab-api-timing.sh
set -uo pipefail
API=http://127.0.0.1:11567; OLD=${OLD:-ghcr.io/navoranetwork/zen-node:net10}
up() { for _ in $(seq 120); do curl -fs -m 5 $API/blockchain/info > /dev/null && return 0; sleep 5; done; echo "node did not answer"; exit 1; }
T=$(curl -fs $API/blockchain/info | python3 -c 'import json,sys; print(json.load(sys.stdin)["blocks"])') || { echo "zp-replay is not answering"; exit 1; }
echo "tip $T; the requests: blocks at the tip (10), blocks 15,000 back (100), headers at the tip (2,600)"
REQS=("blockchain/blocks?blockNumber=$T&take=10" "blockchain/blocks?blockNumber=$((T - 15000))&take=100" "blockchain/headers?blockNumber=$T&take=2600")
measure() {
  for r in "${REQS[@]}"; do
    ts=""; for i in 1 2 3; do ts="$ts $(curl -s -m 120 -o /tmp/api-$1.json -w '%{time_total}' "$API/$r")"; done
    printf '%-4s %-48s seconds:%s  answer %s (%s bytes)\n' "$1" "$r" "$ts" "$(sha256sum < /tmp/api-$1.json | cut -c1-12)" "$(stat -c %s /tmp/api-$1.json)"
    cp /tmp/api-$1.json "/tmp/api-$1-$(echo "$r" | tr -c 'a-z0-9' _).json"
  done
}
measure new
docker pull -q "$OLD" > /dev/null && docker stop zp-replay > /dev/null
docker run -d --name zp-old -v zp-replay:/data -p 127.0.0.1:11567:11567 "$OLD" > /dev/null && up
measure old
docker rm -f zp-old > /dev/null; docker start zp-replay > /dev/null
for r in "${REQS[@]}"; do k=$(echo "$r" | tr -c 'a-z0-9' _)
  cmp -s "/tmp/api-new-$k.json" "/tmp/api-old-$k.json" && echo "same answer: $r" || echo "DIFFERENT answer: $r"; done
