#!/bin/bash
# Download our copy of the MyGet packages (release upstream-mirror) into ./packages-mirror, for building the node
# from source when the original MyGet feed is gone. Then restore with:
#   dotnet restore src/Node/Node.fsproj --source ./packages-mirror --source https://api.nuget.org/v3/index.json
set -euo pipefail
BASE="${MIRROR:-https://github.com/navoranetwork/zenprotocol/releases/download/upstream-mirror}"
mkdir -p packages-mirror && cd packages-mirror
curl -fsSL "$BASE/MANIFEST.json" -o MANIFEST.json
# only the packages the build pins (paket.lock, myget section) - not the CI builds in the feed
for f in $(sed -n '/remote: https:\/\/www.myget.org/,/^[A-Z]/p' ../paket.lock | sed -n 's/^    \([A-Za-z0-9_.-]*\) (\([^)]*\)).*/\1.\2.nupkg/p'); do
  [ -f "$f" ] || curl -fL -sS -o "$f" "$BASE/packages__$f"
  want=$(grep -A2 "\"packages/$f\"" MANIFEST.json | sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p')
  [ -z "$want" ] || echo "$want  $f" | sha256sum -c --quiet || { echo "checksum mismatch: $f"; exit 1; }
  echo "ok $f"
done
# and every other package in the mirror: the closure of the pinned nuget.org packages
# (scripts/mirror-nuget-packages.sh), downloaded with their release names
gh_list() { curl -fsSL "https://api.github.com/repos/navoranetwork/zenprotocol/releases/tags/upstream-mirror" | python3 -c 'import json,sys; [print(a["name"]) for a in json.load(sys.stdin)["assets"] if a["name"].startswith("packages__") and a["name"].endswith(".nupkg")]'; }
for asset in $(gh_list); do
  f=${asset#packages__}
  [ -f "$f" ] || curl -fL -sS -o "$f" "$BASE/$asset"
done
echo "$(ls *.nupkg | wc -l) packages in packages-mirror"
echo "restore from the mirror only: dotnet restore src/Node/Node.fsproj --configfile nuget.mirror.config"
