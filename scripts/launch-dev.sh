#!/bin/bash
# Launch Quantlab in development mode
# This is required when running from the out/ directory because CSS imports
# require the CSS import maps which are only set up in VSCODE_DEV mode.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

export VSCODE_DEV=1

cd "$ROOT_DIR"
.build/electron/quantlab . --no-sandbox "$@"
