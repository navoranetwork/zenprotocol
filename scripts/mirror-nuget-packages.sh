#!/bin/bash
# Copy into the upstream-mirror release every package a node restore needs (the pinned ones
# and all they depend on), so the node builds from the mirror alone. Safe to run again.
# Needs: python3, gh logged in with write access to navoranetwork/zenprotocol. Details: mirror_nuget.py
set -euo pipefail
command -v gh >/dev/null || { echo "gh is not installed: apt-get install -y gh && gh auth login"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed: apt-get install -y python3"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in: gh auth login"; exit 1; }
exec python3 "$(dirname "$0")/mirror_nuget.py" "$@"
