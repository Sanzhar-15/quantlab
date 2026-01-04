#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Guard: prevent accidental Node 18 usage
NODE_MAJOR="$(node -p "parseInt(process.versions.node.split('.')[0], 10)")"
if (( NODE_MAJOR < 20 )); then
  echo "ERROR: Node >= 20 required for this repo. Found: $(node --version)"
  echo "Fix: run 'fnm use' or 'nvm use' in $REPO_ROOT, then retry."
  exit 1
fi

# Force Quantlab dev isolation paths (override defaults)
USER_DATA_DIR="${QUANTLAB_USER_DATA_DIR:-$HOME/.config/quantlab-dev}"
EXTENSIONS_DIR="${QUANTLAB_EXTENSIONS_DIR:-$HOME/.quantlab-dev/extensions}"

mkdir -p "$USER_DATA_DIR" "$EXTENSIONS_DIR"

# Known-good workaround for your machine (NVIDIA/Electron): disable GPU
exec "$REPO_ROOT/scripts/code.sh" \
  --disable-gpu \
  --user-data-dir "$USER_DATA_DIR" \
  --extensions-dir "$EXTENSIONS_DIR" \
  "$@"
