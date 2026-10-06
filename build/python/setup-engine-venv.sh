#!/usr/bin/env bash
# Creates the engine bundling environment on a macOS build machine (targets darwin-arm64 and darwin-x64).
#
# Usage: build/python/setup-engine-venv.sh <python3.12> <venv dir> <darwin-arm64|darwin-x64>
#
# <python3.12> must report the target's machine when started plainly, as gulp starts QUANTLAB_ENGINE_PYTHON: arm64 for
# darwin-arm64, x86_64 for darwin-x64. On Apple silicon that means an x86_64-only binary (run by Rosetta); a universal2
# interpreter starts as arm64 and is refused. The venv gets requirements-engine-<target>.txt with --require-hashes and binary
# wheels only: a package without a matching hashed wheel fails the install, nothing is compiled.
# The last line printed is `QUANTLAB_ENGINE_PYTHON=<venv python>`. Any failure exits non-zero.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <python3.12> <venv dir> <darwin-arm64|darwin-x64>" >&2; exit 64; }
python=$1; venv=$2; target=$3
case $target in
	darwin-arm64) want=arm64 ;;
	darwin-x64) want=x86_64 ;;
	*) echo "unknown target '$target'" >&2; exit 64 ;;
esac
lock="$(cd "$(dirname "$0")" && pwd)/requirements-engine-$target.txt"
[ -f "$lock" ] || { echo "lock file not found: $lock" >&2; exit 1; }
[ -e "$venv" ] && { echo "venv directory already exists: $venv (choose a new one)" >&2; exit 1; }

read -r machine version < <("$python" -c 'import platform, sys; print(platform.machine(), "%d.%d" % sys.version_info[:2])')
[ "$machine" = "$want" ] || { echo "$python reports machine '$machine'; $target needs $want" >&2; exit 1; }
[ "$version" = "3.12" ] || { echo "$python is Python $version; the lock is resolved for 3.12" >&2; exit 1; }

"$python" -m venv "$venv"
"$venv/bin/python" -m pip install --disable-pip-version-check --no-input --require-hashes --only-binary :all: --no-deps -r "$lock"
"$venv/bin/python" -m pip check
"$venv/bin/python" -c 'import PyInstaller, numpy, pandas, pyarrow, libcst, cryptography, argon2, psutil, yaml, alpaca, httpx, jsonrpclib; print("imports ok")'
echo "QUANTLAB_ENGINE_PYTHON=$venv/bin/python"
