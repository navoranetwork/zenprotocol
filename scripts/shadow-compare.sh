#!/bin/bash
# Compares the shadow node (new build, API 127.0.0.1:11568) with the official node (API 127.0.0.1:11567):
# the same tip hash at the same height, and the same CGP state. Read-only. See docs/CGP-PAYOUT-UPGRADE.md.
A=${A:-http://127.0.0.1:11567}; B=${B:-http://127.0.0.1:11568}
f() { curl -s -m 20 "$1/blockchain/info" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["blocks"], d["tip"])' 2>/dev/null; }
for i in $(seq 1 30); do
  read HA TA <<< "$(f $A)"; read HB TB <<< "$(f $B)"
  if [ -n "$HA" ] && [ "$HA" = "$HB" ]; then
    echo "height $HA"; echo "official $TA"; echo "shadow   $TB"
    [ "$TA" = "$TB" ] && echo "TIP: SAME" || echo "TIP: DIFFERENT"
    CA=$(curl -s -m 20 "$A/blockchain/cgp"); CB=$(curl -s -m 20 "$B/blockchain/cgp")
    echo "cgp official $CA"; echo "cgp shadow   $CB"
    [ "$CA" = "$CB" ] && echo "CGP: SAME" || echo "CGP: DIFFERENT"
    exit 0
  fi
  echo "heights differ (official ${HA:-?}, shadow ${HB:-?}), waiting"; sleep 20
done
echo "no common height after 10 minutes"; exit 1
