#!/bin/bash
# One-time: copy every package the node build pins from nuget.org (src/Directory.Packages.props)
# into the upstream-mirror release, so the node builds without nuget.org (offline machines,
# restricted build servers, or if a package is ever removed). Needs: curl, gh logged in with
# write access to navoranetwork/zenprotocol. Safe to run again: existing assets are skipped.
#   bash scripts/mirror-nuget-packages.sh
set -euo pipefail
REPO=navoranetwork/zenprotocol; TAG=upstream-mirror
cd "$(dirname "$0")/.."
have=$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')
mirrored="Zulib CGPContract FsBech32 ZFS-Tools ZFStar Zen.FSharp.Compiler.Service zen_secp256k1_linux zen_secp256k1_osx zen_z3_linux zen_z3_osx zen_z3_windows secp256k1-vc140"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
sed -n 's/.*PackageVersion Include="\([^"]*\)" Version="\[\{0,1\}\([^]"]*\)\]\{0,1\}".*/\1 \2/p' src/Directory.Packages.props |
while read -r id ver; do
  case " $mirrored " in *" $id "*) continue;; esac
  name="packages__$id.$ver.nupkg"
  if echo "$have" | grep -qxF "$name"; then echo "have $id $ver"; continue; fi
  lid=$(echo "$id" | tr 'A-Z' 'a-z'); lver=$(echo "$ver" | tr 'A-Z' 'a-z')
  curl -fsSL "https://api.nuget.org/v3-flatcontainer/$lid/$lver/$lid.$lver.nupkg" -o "$tmp/$name"
  gh release upload "$TAG" "$tmp/$name" --repo "$REPO"
  echo "added $id $ver ($(sha256sum "$tmp/$name" | cut -c1-16))"
done
echo "done: $(gh release view "$TAG" --repo "$REPO" --json assets --jq '[.assets[].name | select(endswith(".nupkg"))] | length') packages in $TAG"
