#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
# FE-1.5 W-T -- run the reactive acid#1 test in a REAL extension host (no GUI).
#
# Mirrors the built-in-extension launch pattern in scripts/test-integration.sh (the git-test variant):
# launches the from-sources Electron with --extensionDevelopmentPath + --extensionTestsPath under the
# core launch flags, with a temp workspace folder so workspaceFolders[0] exists for the trust gate.
# (The full test-integration.sh adds crash-reporter/logsPath dirs; omitted here for a focused run.)
# Requires QUANTBOOK_ENGINE_PATH (engine dylib) and QUANTLAB_PYTHON (an interpreter with
# ipykernel/jupyter_client/pyzmq/comm) -- the test self-skips if they are unset/missing.
#
# This script BUILDS the extension (out/) AND the bundled sheets webview (dist/) before launching, so the
# gate is self-consistent. NOTE (megaudit): the webview bundle (dist/webview/quantbook) is gitignored and
# is NOT produced by `npm run compile`, `npm test`, `vscode:prepublish`, or the aggregate CI build -- only
# by `build:webviews:quantbook`. A fresh checkout therefore has no Cell Grid / formula bar until that runs.
# Wiring the webview build into the packaging/CI path is a separate, pre-existing infra decision.
#
# Usage:
#   QUANTBOOK_ENGINE_PATH=<engine>/target/release/libql_bindings_node.dylib \
#   QUANTLAB_PYTHON=$HOME/.fe15-spike-venv/bin/python3.12 \
#   bash scripts/test-quantbook-acid1.sh

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

cd "$ROOT" || exit 1

# Build the extension + the (otherwise-unbuilt, gitignored) webview bundle so the host loads a fresh grid.
( cd "$ROOT/extensions/quantlab" && npm run compile && npm run build:webviews:quantbook ) || exit 1

VSCODEUSERDATADIR=$(mktemp -d 2>/dev/null)
WS=$(mktemp -d 2>/dev/null)

EXTRA="--disable-telemetry --disable-experiments --skip-welcome --skip-release-notes --no-cached-data --disable-updates --use-inmemory-secretstorage --disable-extensions --disable-workspace-trust --user-data-dir=$VSCODEUSERDATADIR"

"${INTEGRATION_TEST_ELECTRON_PATH:-./scripts/code.sh}" "$WS" \
	--extensionDevelopmentPath="$ROOT/extensions/quantlab" \
	--extensionTestsPath="$ROOT/extensions/quantlab/out/test/integration-host" \
	$EXTRA
CODE=$?

rm -rf "$VSCODEUSERDATADIR" "$WS"
exit $CODE
