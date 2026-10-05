#!/usr/bin/env bash
# FEATURES closing checks (PLAN-FINAL 3.9) on a packaged macOS app.
# Usage: run.sh <path to the .app bundle> <evidence dir that does not exist yet>
# Requires QL_FEATURES_PYTHON: the absolute path of the declared interpreter (with ipykernel).
# Exit 0 only if all five checks are PASS. Everything the run writes stays under the evidence dir.
set -euo pipefail

if [ "$#" -ne 2 ]; then
	echo "usage: run.sh <path to the .app bundle> <evidence dir that does not exist yet>" >&2
	exit 64
fi
app=$1
evidence=$2
here=$(cd "$(dirname "$0")" && pwd)

if [ ! -d "$app/Contents/MacOS" ]; then
	echo "[app_not_found] $app is not a macOS .app bundle (no Contents/MacOS)" >&2
	exit 1
fi
if [ -e "$evidence" ]; then
	echo "[evidence_dir_exists] $evidence already exists; name a directory that does not" >&2
	exit 1
fi

name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
exe="$app/Contents/MacOS/$name"

# The launcher runs on the app's own Node, so the guest needs no other runtime.
ELECTRON_RUN_AS_NODE=1 exec "$exe" "$here/launcher.mjs" "$app" "$evidence"
