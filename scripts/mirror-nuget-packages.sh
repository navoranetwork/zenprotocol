#!/bin/bash
# One-time: copy every package the node build pins from nuget.org (src/Directory.Packages.props)
# into the upstream-mirror release, so the node builds without nuget.org (offline machines,
# restricted build servers, or if a package is ever removed). Needs: curl, gh logged in with
# write access to navoranetwork/zenprotocol. Safe to run again: existing assets are skipped.
#   bash scripts/mirror-nuget-packages.sh
set -euo pipefail
command -v gh >/dev/null || { echo "gh is not installed: apt-get install -y gh && gh auth login"; exit 1; }
command -v curl >/dev/null || { echo "curl is not installed: apt-get install -y curl"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in: gh auth login"; exit 1; }
REPO=navoranetwork/zenprotocol; TAG=upstream-mirror
cd "$(dirname "$0")/.."
have=$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')
mirrored="Zulib CGPContract FsBech32 ZFS-Tools ZFStar Zen.FSharp.Compiler.Service zen_secp256k1_linux zen_secp256k1_osx zen_z3_linux zen_z3_osx zen_z3_windows secp256k1-vc140"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# nuget.org stores normalized versions: at least 3 parts (5.1 -> 5.1.0), a 4th part only if not 0
norm() {
  local v=$1 pre=""
  case "$v" in *-*) pre="-${v#*-}"; v=${v%%-*};; esac
  IFS=. read -r a b c d <<< "$v"
  v="$((10#${a:-0})).$((10#${b:-0})).$((10#${c:-0}))"
  [ -n "${d:-}" ] && [ "$((10#$d))" != 0 ] && v="$v.$((10#$d))"
  echo "$v$pre"
}
failed=""
while read -r id ver; do
  case " $mirrored " in *" $id "*) continue;; esac
  nver=$(norm "$ver")
  name="packages__$id.$nver.nupkg"
  if grep -qxF "$name" <<< "$have" || grep -qxF "packages__$id.$ver.nupkg" <<< "$have"; then echo "have $id $ver"; continue; fi
  lid=$(echo "$id" | tr 'A-Z' 'a-z'); lver=$(echo "$nver" | tr 'A-Z' 'a-z')
  if curl -fsSL "https://api.nuget.org/v3-flatcontainer/$lid/$lver/$lid.$lver.nupkg" -o "$tmp/$name"; then
    gh release upload "$TAG" "$tmp/$name" --repo "$REPO"
    echo "added $id $nver ($(sha256sum "$tmp/$name" | cut -c1-16))"
  else
    echo "NOT FOUND on nuget.org: $id $ver (tried $nver)"; failed="$failed $id@$ver"
  fi
done < <(sed -n 's/.*PackageVersion Include="\([^"]*\)" Version="\[\{0,1\}\([^]"]*\)\]\{0,1\}".*/\1 \2/p' src/Directory.Packages.props)
echo "done: $(gh release view "$TAG" --repo "$REPO" --json assets --jq '[.assets[].name | select(endswith(".nupkg"))] | length') packages in $TAG"
[ -z "$failed" ] || { echo "missing:$failed"; exit 1; }
