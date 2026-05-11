#!/usr/bin/env bash
# Quantbook Phase 0 — Cargo.lock pin guard.
#
# `[workspace.dependencies]` in `Cargo.toml` declares aspirational pins like
# `arrow = "=58.1.0"`. Those pins only constrain the resolver once a member crate actually
# imports the dep. Transitive consumers (e.g. arrow-array → arrow-buffer with `^58`) can drift
# the lockfile to a different patch version than the declared workspace pin.
#
# This script enforces that the workspace declares an `=N.M.P` pin for each Arrow crate AND
# that `Cargo.lock` resolves that exact version. If a transitive bump drifts the lock, CI
# fails until either:
#   1. The workspace pin is intentionally bumped (and the declaration matches), or
#   2. The drifting transitive is itself constrained.
#
# Codex r11 finding #9 (MINOR): `Cargo.toml` says `arrow-buffer = "=58.1.0"` but
# `Cargo.lock` has 58.3.0 today (because no member crate uses arrow-buffer directly — the
# workspace pin doesn't fire until then). This script makes that drift fail closed.
#
# Add new pinned packages here as direct deps land in member crates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_TOML="$ENGINE_ROOT/Cargo.toml"
CARGO_LOCK="$ENGINE_ROOT/Cargo.lock"

# Packages required to track exactly between workspace pin and Cargo.lock. Extend as more
# direct deps land — Phase 0 currently watches the Arrow family + Loro + calamine + criterion.
PINNED_PKGS=(
  arrow
  arrow-array
  arrow-buffer
  arrow-schema
  arrow-select
  arrow-arith
  arrow-cast
  loro
  calamine
  criterion
  pulp
  multiversion
  pyo3
  wasm-bindgen
  proptest
)

err=0

# Extract `=N.M.P` from a `name = "=N.M.P"` or `name = { version = "=N.M.P", ... }` line in
# workspace.dependencies. Returns empty if not found.
workspace_pin_for() {
  local pkg=$1
  # Look only inside the [workspace.dependencies] section.
  awk -v pkg="$pkg" '
    /^\[workspace\.dependencies\]/ { in_section=1; next }
    /^\[/ && !/^\[workspace\.dependencies\]/ { in_section=0 }
    in_section && $0 ~ "^"pkg"[[:space:]]*=" {
      # Strip everything up to and including "=" sign that opens the pin.
      if (match($0, /"=[0-9]+(\.[0-9]+)*"/)) {
        v = substr($0, RSTART+2, RLENGTH-3)
        print v
        exit
      }
    }
  ' "$CARGO_TOML"
}

# Extract version for a package from Cargo.lock.
lock_version_for() {
  local pkg=$1
  awk -v pkg="$pkg" '
    /^\[\[package\]\]/ { in_pkg=1; name=""; ver=""; next }
    in_pkg && $1 == "name" {
      gsub(/"/,"",$3); name=$3
    }
    in_pkg && $1 == "version" {
      gsub(/"/,"",$3); ver=$3
      if (name == pkg) { print ver; exit }
      in_pkg=0
    }
  ' "$CARGO_LOCK"
}

for pkg in "${PINNED_PKGS[@]}"; do
  pin=$(workspace_pin_for "$pkg")
  lock=$(lock_version_for "$pkg")

  if [[ -z "$lock" ]]; then
    # Package not in the lock — fine, nothing to enforce yet.
    continue
  fi

  if [[ -z "$pin" ]]; then
    echo "ERROR: $pkg is present in Cargo.lock ($lock) but has no workspace.dependencies pin." >&2
    echo "       Add `$pkg = \"=$lock\"` to [workspace.dependencies] in Cargo.toml." >&2
    err=1
    continue
  fi

  if [[ "$pin" != "$lock" ]]; then
    echo "ERROR: $pkg drift — workspace pin '=$pin' vs Cargo.lock '$lock'." >&2
    err=1
  fi
done

if [[ $err -ne 0 ]]; then
  echo "" >&2
  echo "Cargo.lock pin guard failed. Either:" >&2
  echo "  1. Update [workspace.dependencies] in Cargo.toml to match the lock, OR" >&2
  echo "  2. Constrain the transitive that's pulling the higher version (add to a member crate's deps)." >&2
  exit 1
fi

echo "OK: Cargo.lock pin guard passed (${#PINNED_PKGS[@]} watched packages aligned)."
exit 0
