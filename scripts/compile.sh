#!/bin/bash
# Sequential compilation for QuantLab (15GB RAM safe)
#
# `gulp compile` runs 42 TypeScript programs in parallel (~38GB peak).
# This script runs the same steps sequentially (~5-6GB peak).
# Zero code changes — uses existing gulp tasks.

set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS="--max-old-space-size=8192"

t0=$SECONDS

echo "[1/3] Compiling core (src/ → out/) ..."
npx gulp compile-client
echo "      done in $(( SECONDS - t0 ))s"

t1=$SECONDS
echo "[2/3] Transpiling extensions (ESBuild) ..."
npx gulp transpile-extensions
echo "      done in $(( SECONDS - t1 ))s"

t2=$SECONDS
echo "[3/3] Building extension media ..."
npx gulp compile-extension-media
echo "      done in $(( SECONDS - t2 ))s"

echo ""
echo "Compilation complete in $(( SECONDS - t0 ))s total."
