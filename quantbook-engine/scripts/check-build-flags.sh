#!/usr/bin/env bash
# Quantbook Phase 0 Amendment A3 — guard against `-C target-cpu=native` in distributable builds.
#
# Per CORR-08 + Phase 0 Decision F: distributable Quantbook binaries MUST use runtime SIMD
# dispatch (pulp + multiversion). `target-cpu=native` would compile against the build machine's
# specific CPU features, causing SIGILL on customer machines that lack them (e.g., shipping
# AVX2-compiled binaries to users without AVX2).
#
# This script scans (codex r11 + r12 audit findings drove the env-channel coverage):
#   - quantbook-engine/.cargo/config.toml — explicit rustflags entries
#   - RUSTFLAGS env (Cargo's primary rustflag channel)
#   - CARGO_BUILD_RUSTFLAGS env (build-section override)
#   - CARGO_ENCODED_RUSTFLAGS env (Cargo's space-separator-safe channel; uses \x1f delimiter)
#   - CARGO_TARGET_*_RUSTFLAGS env (per-target overrides)
#   - .github/workflows/*.{yml,yaml} embedded poisoning
#
# Matching is case-insensitive (grep -iE) and tolerates optional quotes / interior whitespace
# around the `=`. Comment-only lines (leading `#`) are filtered before matching so the rule
# itself can be documented in `.cargo/config.toml` and workflow files without self-triggering.
#
# Run `bash scripts/check-build-flags.sh --self-test` to replay the 19 poisoning forms the
# audits stress-tested; all must exit non-zero.
#
# Exit 0 if clean. Exit non-zero with a clear error message if any violation found.

set -euo pipefail

# Locate the quantbook-engine root regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ENGINE_ROOT/.." && pwd)"

# --self-test: re-invoke this script with each poisoning form and verify each is caught.
# Exits 0 only if every form fires the guard (every probe exits non-zero), else 1.
# Run from a clean tree (no live config/workflow violation) so probes only test what they
# inject via env.
if [[ "${1:-}" == "--self-test" ]]; then
  pass=0
  fail=0
  probe() {
    local label=$1
    shift
    if "$@" "$0" > /dev/null 2>&1; then
      echo "  MISS: $label"
      fail=$((fail + 1))
    else
      pass=$((pass + 1))
    fi
  }
  # Each probe sets one env channel to a poisoning value and re-runs this script.
  probe 'RUSTFLAGS=-C target-cpu=native'                    env RUSTFLAGS='-C target-cpu=native'
  probe 'RUSTFLAGS spaced'                                   env RUSTFLAGS='-C target-cpu = native'
  probe 'RUSTFLAGS quoted'                                   env RUSTFLAGS='-C target-cpu="native"'
  probe 'RUSTFLAGS quoted+spaced'                            env RUSTFLAGS='-C target-cpu = "native"'
  probe 'RUSTFLAGS uppercase NATIVE'                         env RUSTFLAGS='-C target-cpu=NATIVE'
  probe 'RUSTFLAGS mixed case'                               env RUSTFLAGS='-C TaRgEt-CpU=NaTiVe'
  probe 'CARGO_BUILD_RUSTFLAGS=-C target-cpu=native'         env CARGO_BUILD_RUSTFLAGS='-C target-cpu=native'
  probe 'CARGO_ENCODED_RUSTFLAGS encoded'                    env CARGO_ENCODED_RUSTFLAGS=$'-C\x1ftarget-cpu=native'
  probe 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS'    env CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS='-C target-cpu=native'
  probe 'CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS'        env CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS='-C target-cpu=native'
  echo ""
  echo "self-test: $pass pass / $fail fail"
  if [[ $fail -ne 0 ]]; then
    exit 1
  fi
  exit 0
fi

# Match real-world poisoning forms:
#   target-cpu=native            (no spaces, common in TOML/RUSTFLAGS strings)
#   target-cpu = native          (TOML-y with spaces)
#   target-cpu="native"          (quoted)
#   target-cpu = "native"        (quoted with spaces)
# Case-insensitive (rustc rejects uppercase NATIVE in practice but defense-in-depth).
# Note: '"?' is "optional double quote"; do NOT use '"\?' — in grep -E that means literal '?'.
BANNED='target-cpu[[:space:]]*=[[:space:]]*"?native'

# Strip comment-only lines (TOML/YAML/shell all use leading '#') before matching.
strip_comments() {
  awk 'NF && $0 !~ /^[[:space:]]*#/ { printf "%s:%d:%s\n", FILENAME, NR, $0 }' "$1"
}

# Decode CARGO_ENCODED_RUSTFLAGS unit-separators (\x1f) into spaces for matching.
decode_encoded() {
  printf '%s' "$1" | tr $'\x1f' ' '
}

err=0

# 1. .cargo/config.toml
if [[ -f "$ENGINE_ROOT/.cargo/config.toml" ]]; then
  hit=$(strip_comments "$ENGINE_ROOT/.cargo/config.toml" | grep -iE "$BANNED" || true)
  if [[ -n "$hit" ]]; then
    echo "ERROR: $ENGINE_ROOT/.cargo/config.toml contains 'target-cpu=native':" >&2
    echo "$hit" >&2
    err=1
  fi
fi

# 2. Cargo rustflag env channels — `RUSTFLAGS`, `CARGO_BUILD_RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`,
#    plus any `CARGO_TARGET_*_RUSTFLAGS` (per-target overrides; enumerable at runtime).
check_env_var() {
  local name=$1
  local raw=$2
  if [[ -z "$raw" ]]; then return; fi
  local decoded="$raw"
  if [[ "$name" == "CARGO_ENCODED_RUSTFLAGS" ]]; then
    decoded=$(decode_encoded "$raw")
  fi
  if echo "$decoded" | grep -iE "$BANNED" > /dev/null 2>&1; then
    echo "ERROR: env $name contains 'target-cpu=native' (value: $raw)." >&2
    err=1
  fi
}

check_env_var RUSTFLAGS               "${RUSTFLAGS:-}"
check_env_var CARGO_BUILD_RUSTFLAGS   "${CARGO_BUILD_RUSTFLAGS:-}"
check_env_var CARGO_ENCODED_RUSTFLAGS "${CARGO_ENCODED_RUSTFLAGS:-}"

# Enumerate every CARGO_TARGET_*_RUSTFLAGS that's set in env.
while IFS='=' read -r name _val; do
  case "$name" in
    CARGO_TARGET_*_RUSTFLAGS)
      check_env_var "$name" "${!name}"
      ;;
  esac
done < <(env)

# 3. GitHub workflows — scan every workflow file (any one of them poisoning is a real risk).
if [[ -d "$REPO_ROOT/.github/workflows" ]]; then
  workflow_hits=""
  while IFS= read -r -d '' wf; do
    h=$(strip_comments "$wf" | grep -iE "$BANNED" || true)
    if [[ -n "$h" ]]; then
      workflow_hits+="$h"$'\n'
    fi
  done < <(find "$REPO_ROOT/.github/workflows" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)
  if [[ -n "$workflow_hits" ]]; then
    echo "ERROR: a workflow file under .github/workflows/ contains 'target-cpu=native':" >&2
    printf '%s' "$workflow_hits" >&2
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
