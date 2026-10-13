#!/bin/bash
# Publishes the testnet pages (Dex, Oracle, Explorer, Assets) of this server over HTTPS at testnet.navora.network, next to the testnet stack
# (scripts/install-testnet-stack.sh). Read-only: the node's wallet and send endpoints are never exposed. Safe to run again.
# The domain is kept from the last run. Another server: DOMAIN=testnet.example.org; plain HTTP on the IP (no DNS yet): DOMAIN= (empty).
#
#   cd ~/zenprotocol-testnet && bash site/setup-testnet-web.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WEB=/var/www/zen-testnet
NODE=${NODE_PORT:-31567}; EXPLORER=${EXPLORER_PORT:-11581}; ORACLE=${ORACLE_PORT:-8085}; BRIDGE=${BRIDGE_PORT:-8090}; FAUCET=${FAUCET_PORT:-8095}; PROVER=${PROVER_PORT:-8096}
# the testnet stack's compose project (its folder name); STACK_PROJECT=zenprotocol-testnet when this script runs from another checkout
STACK_PROJECT=${STACK_PROJECT:-$(basename "$REPO")}
VOL=$(docker volume inspect "${STACK_PROJECT}_stack-data" --format '{{.Mountpoint}}' 2>/dev/null || true)

command -v nginx >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx; }
mkdir -p "$WEB"
# the indexer writes its json files inside the docker volume (/var/lib/docker is closed to nginx): copy them out every minute,
# through a temporary file and a rename, so a page never reads a half-copied file
if [ -n "$VOL" ]; then
  cat > /etc/cron.d/zen-testnet-json <<CRON
* * * * * root for f in stats assets cgp-history community-votes history bitzen; do [ -f "$VOL/web/\$f.json" ] && cp -f "$VOL/web/\$f.json" "$WEB/.\$f.json.tmp" && mv -f "$WEB/.\$f.json.tmp" "$WEB/\$f.json"; done
* * * * * root [ -f /var/lib/zp-stratum/stats.json ] && cp -f /var/lib/zp-stratum/stats.json "$WEB/mining.json"
CRON
  for f in stats assets cgp-history community-votes history bitzen; do [ -f "$VOL/web/$f.json" ] && cp -f "$VOL/web/$f.json" "$WEB/.$f.json.tmp" && mv -f "$WEB/.$f.json.tmp" "$WEB/$f.json"; done
fi
# the mining server's status (zp-stratum --stats-file, scripts/install-mining-server.sh) for the home page
[ -f /var/lib/zp-stratum/stats.json ] && cp -f /var/lib/zp-stratum/stats.json "$WEB/mining.json"
[ -n "$VOL" ] && rm -f /etc/cron.d/zen-testnet-mining   # the json cron above copies mining.json too
[ -n "$VOL" ] || echo "* * * * * root [ -f /var/lib/zp-stratum/stats.json ] && cp -f /var/lib/zp-stratum/stats.json \"$WEB/mining.json\"" > /etc/cron.d/zen-testnet-mining
# faucet top-up: every hour, the node wallet refills the faucet when it runs low (keeps a reserve; scripts/faucet-topup.sh)
cat > /etc/cron.d/zen-faucet-topup <<CRON
17 * * * * root bash $REPO/scripts/faucet-topup.sh >> /var/log/zen-faucet-topup.log 2>&1
CRON
for f in markets dex oracle explorer assets stats cgp bridge contract guide instruments developers faucet bitzen swap; do cp "$REPO/site/$f.html" "$WEB/$f.html"; done
cp "$REPO/site/testnet-home.html" "$WEB/index.html"
rm -rf "$WEB/shell"; cp -r "$REPO/site/shell" "$WEB/shell"
# Site frame settings. DOMAIN (e.g. testnet.example.org) turns on HTTPS; MAIN_URL links to the mainnet site.
old() { grep -o "\"$1\":\"[^\"]*\"" "$WEB/site-config.json" 2>/dev/null | cut -d'"' -f4 || true; }   # values from the last run are kept
if [ -z "${DOMAIN+x}" ]; then DOMAIN=$(old domain); DOMAIN="${DOMAIN:-testnet.navora.network}"; fi; MAIN_URL="${MAIN_URL:-$(old mainUrl)}"; MAIN_URL="${MAIN_URL:-https://navora.network}"; SITE_NAME="${SITE_NAME:-$(old name)}"; [ "$SITE_NAME" = "Zen Chain" ] && SITE_NAME=""; SITE_NAME="${SITE_NAME:-Navora}"
printf '{"kind":"test","name":"%s","mainUrl":"%s","domain":"%s","github":"https://github.com/navoranetwork/zenprotocol"}\n' "$SITE_NAME" "$MAIN_URL" "$DOMAIN" > "$WEB/site-config.json"
# ZP Wallet on the same site: its node is this site's /node/ (config.json names it), so the testnet works at once.
IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')
BASE=${DOMAIN:+https://$DOMAIN}; BASE=${BASE:-http://$IP}
if command -v docker >/dev/null; then
  docker run --rm -v "$REPO:/r" -w /r/wallet node:22-alpine sh -c "npm ci --no-audit --no-fund && npm test && npm run build" \
    && { rm -rf "$WEB/wallet"; mkdir -p "$WEB/wallet"; cp "$REPO"/wallet/dist/* "$WEB/wallet/"; echo "{\"testNode\":\"$BASE/node\"}" > "$WEB/wallet/config.json"; echo "wallet published at /wallet/"; } \
    || echo "wallet build or tests failed: /wallet/ left as it was"
fi

cat > /etc/nginx/sites-available/zen-testnet <<CONF
limit_req_zone \$binary_remote_addr zone=zentest:10m rate=10r/s;
limit_req_zone \$binary_remote_addr zone=zenfaucet:10m rate=6r/m;
limit_req_zone \$binary_remote_addr zone=zenengine:10m rate=30r/m;
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${DOMAIN:-_};
    root $WEB;
    index index.html;

    location = /api/info  { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$NODE/blockchain/info; add_header Cache-Control "no-store"; }
    location = /api/peers { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$NODE/network/connections/count; add_header Cache-Control "no-store"; }

    # read-only node endpoints for the explorer and light wallets
    location ~ ^/node/(blockchain/(info|headers|cgp|mempool|block|blocks|transaction|winner|totalzp|candidates|blockreward|publishtransaction|contract/execute)|addressdb/(balance|outputs|transactions|transactioncount|discovery)|contract/active|address/decode)\$ {
        limit_req zone=zentest burst=40 nodelay;
        proxy_pass http://127.0.0.1:$NODE/\$1\$is_args\$args;
        add_header Cache-Control "no-store";
    }
    location /node/ { return 404; }

    location /explorer/api/ { limit_req zone=zentest burst=40 nodelay; proxy_pass http://127.0.0.1:$EXPLORER; proxy_read_timeout 90s; add_header Cache-Control "no-cache"; }
    location ~ ^/oracle/(health|rounds|rounds/latest|auditpath)\$ {
        limit_req zone=zentest burst=20 nodelay; limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:$ORACLE/\$1\$is_args\$args;
        add_header Cache-Control "no-cache"; add_header Access-Control-Allow-Origin "*";
    }
    # faucet: the service keeps its own per-address, per-visitor and hourly limits; nginx adds a request rate limit
    location = /faucet/status  { limit_except GET { deny all; } limit_req zone=zentest burst=20 nodelay; proxy_pass http://127.0.0.1:$FAUCET/faucet/status; add_header Cache-Control "no-store"; }
    location = /faucet/request { limit_except POST { deny all; } limit_req zone=zenfaucet burst=3 nodelay; client_max_body_size 2k;
                                 proxy_set_header X-Real-IP \$remote_addr; proxy_pass http://127.0.0.1:$FAUCET/faucet/request; add_header Cache-Control "no-store"; }
    # live events for the bridge page (server-sent events: one long request per open page)
    # ZP <-> BTC swap page: offers come from the prover (site/bitzen/prover.mjs, PROVER_LISTEN); it signs reservations, so POST is rate-limited
    location = /swap/status  { limit_except GET  { deny all; } limit_req zone=zentest burst=20 nodelay; proxy_pass http://127.0.0.1:$PROVER/status; add_header Cache-Control "no-store"; }
    location = /swap/reserve { limit_except POST { deny all; } limit_req zone=zenfaucet burst=3 nodelay; client_max_body_size 2k; proxy_pass http://127.0.0.1:$PROVER/reserve; proxy_read_timeout 90s; add_header Cache-Control "no-store"; }
    # contract engine (zp-contracts-v1 tools/engine/server.py, docs/SERVICE.md) for the wallet's Create a contract; it never signs
    location /engine/ { limit_req zone=zenengine burst=20 nodelay; client_max_body_size 256k; proxy_pass http://127.0.0.1:${ENGINE_PORT:-11580}; proxy_set_header X-Forwarded-For \$remote_addr; proxy_read_timeout 30s; add_header Cache-Control "no-store"; }
    location = /bridge/events { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$BRIDGE/events; proxy_http_version 1.1; proxy_set_header Connection ""; proxy_buffering off; proxy_cache off; proxy_read_timeout 3600s; add_header Cache-Control "no-cache"; }
    location = /bridge/status { limit_except GET { deny all; } proxy_pass http://127.0.0.1:$BRIDGE/status; add_header Cache-Control "no-cache"; }
    # bridge page actions: look up an EVM address, link it to a ZP address (signed), claim a withdrawal
    location = /bridge/lookup   { limit_except GET  { deny all; } limit_req zone=zentest burst=20 nodelay; proxy_pass http://127.0.0.1:$BRIDGE/lookup\$is_args\$args; add_header Cache-Control "no-store"; }
    location = /bridge/link     { limit_except POST { deny all; } limit_req zone=zenfaucet burst=3 nodelay; client_max_body_size 4k; proxy_pass http://127.0.0.1:$BRIDGE/link; add_header Cache-Control "no-store"; }
    location = /bridge/withdraw { limit_except POST { deny all; } limit_req zone=zenfaucet burst=3 nodelay; client_max_body_size 4k; proxy_pass http://127.0.0.1:$BRIDGE/withdraw; proxy_read_timeout 120s; add_header Cache-Control "no-store"; }

    # files the indexer writes (assets, ...)
    location ~ ^/(stats|assets|cgp-history|community-votes|history|mining|bitzen)\.json\$ { root $WEB; add_header Cache-Control "no-cache"; }
    location / { try_files \$uri \$uri/ =404; }
}
CONF
ln -sf /etc/nginx/sites-available/zen-testnet /etc/nginx/sites-enabled/zen-testnet
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx || systemctl restart nginx
IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')
if [ -n "$DOMAIN" ]; then
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect --keep-until-expiring
  echo "Published: https://$DOMAIN/"
else
  echo "Published: http://$IP/   (Dex: http://$IP/dex.html)"
fi
