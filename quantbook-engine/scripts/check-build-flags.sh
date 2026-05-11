#!/usr/bin/env bash
# Quantbook Phase 0 Amendment A3 — guard against `-C target-cpu=native` in distributable builds.
#
# Per CORR-08 + Phase 0 Decision F: distributable Quantbook binaries MUST use runtime SIMD
# dispatch (pulp + multiversion). `target-cpu=native` would compile against the build machine's
# specific CPU features, causing SIGILL on customer machines that lack them (e.g., shipping
# AVX2-compiled binaries to users without AVX2).
#
# This script scans:
#   - quantbook-engine/.cargo/config.toml for `target-cpu = native` in any rustflags entry
#   - the RUSTFLAGS environment variable
#   - .github/workflows/*.yml for embedded `target-cpu=native`
#
# Exit 0 if clean. Exit non-zero with a clear error message if any violation found.

set -euo pipefail

# Locate the quantbook-engine root regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ENGINE_ROOT/.." && pwd)"

err=0
banned='target-cpu[[:space:]]*=[[:space:]]*"\?native'

# 1. .cargo/config.toml
if [[ -f "$ENGINE_ROOT/.cargo/config.toml" ]]; then
  if grep -E "$banned" "$ENGINE_ROOT/.cargo/config.toml" > /dev/null 2>&1; then
    echo "ERROR: $ENGINE_ROOT/.cargo/config.toml contains 'target-cpu=native'." >&2
    err=1
  fi
fi

# 2. RUSTFLAGS env
if [[ "${RUSTFLAGS:-}" =~ target-cpu[[:space:]]*=[[:space:]]*\"?native ]]; then
  echo "ERROR: RUSTFLAGS env contains 'target-cpu=native' (value: $RUSTFLAGS)." >&2
  err=1
fi

# 3. GitHub workflows (look only at quantbook-engine-related workflows)
if [[ -d "$REPO_ROOT/.github/workflows" ]]; then
  if grep -rE "$banned" "$REPO_ROOT/.github/workflows" > /dev/null 2>&1; then
    echo "ERROR: a workflow file under .github/workflows/ contains 'target-cpu=native'." >&2
    grep -nE "$banned" "$REPO_ROOT/.github/workflows" >&2 || true
    err=1
  fi
fi

if [[ $err -ne 0 ]]; then
  echo "" >&2
  echo "Phase 0 Amendment A3 violated: distributable builds may NOT use '-C target-cpu=native'." >&2
  echo "Use the per-target floors in .cargo/config.toml (sse4.2 x86_64, neon aarch64) and rely on" >&2
  echo "runtime SIMD dispatch via pulp + multiversion. See QUANTBOOK-v1-SPECIFICATION.md Part V §2 F." >&2
  exit 1
fi

echo "OK: A3 check passed — no 'target-cpu=native' detected."
exit 0
