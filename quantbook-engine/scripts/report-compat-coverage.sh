#!/usr/bin/env bash
# Phase 4.2 ECM-4-03 — Excel-compat matrix coverage reporter.
#
# Greps `docs/compat/excel-matrix.md` for the status-emoji column in
# every table row, then prints counts of:
#
#   - ✅ implemented
#   - ⚠️ partial
#   - 🔄 reserved
#   - ❌ not-yet
#
# Per-category breakdowns are emitted alongside the totals. Exits 0
# unconditionally — this is a reporting script, not a gate. CI can
# parse the output (last line is `coverage=NN%`) to enforce a floor in
# a separate check.
#
# Usage:
#   bash scripts/report-compat-coverage.sh           # human-readable
#   bash scripts/report-compat-coverage.sh --json    # machine-readable
#
# The matrix is `docs/compat/excel-matrix.md`; rows look like:
#
#   | SUM | ✅ | 30+ | 0 | ... |
#
# A row is a "function/feature row" iff the first cell is non-empty
# alphanumeric/punctuation (skip header `|---|...` separators and the
# header-name row by looking for status emojis in column 2).

set -euo pipefail

cd "$(dirname "$0")/.."

MATRIX="docs/compat/excel-matrix.md"
if [[ ! -f "$MATRIX" ]]; then
  echo "ERROR: $MATRIX not found" >&2
  exit 1
fi

JSON=0
if [[ "${1:-}" == "--json" ]]; then
  JSON=1
fi

# Count status emojis ONLY in markdown table rows (lines starting with `|`).
# This avoids over-counting emojis used in surrounding prose / instructions
# / open-follow-ups sections. Each table row uses the emoji in the
# Status column exactly once.
impl_count=$(grep '^|' "$MATRIX" | grep -c "✅" || true)
partial_count=$(grep '^|' "$MATRIX" | grep -c "⚠️" || true)
reserved_count=$(grep '^|' "$MATRIX" | grep -c "🔄" || true)
missing_count=$(grep '^|' "$MATRIX" | grep -c "❌" || true)

total=$((impl_count + partial_count + reserved_count + missing_count))

if (( total == 0 )); then
  echo "ERROR: no status rows found in $MATRIX" >&2
  exit 1
fi

# Coverage %: implemented + partial count toward "has SOMETHING";
# reserved counts (the AI sentinel deliberately returns
# `#AI_NOT_AVAILABLE_V1` — that IS a real behavior).
has_something=$((impl_count + partial_count + reserved_count))
coverage_pct=$(( 100 * has_something / total ))

if [[ $JSON -eq 1 ]]; then
  cat <<EOF
{
  "matrix_path": "$MATRIX",
  "implemented": $impl_count,
  "partial": $partial_count,
  "reserved": $reserved_count,
  "missing": $missing_count,
  "total": $total,
  "coverage_pct": $coverage_pct
}
EOF
  exit 0
fi

cat <<EOF
Excel-compat matrix coverage report
====================================
Source: $MATRIX

  Implemented (✅):  $impl_count
  Partial     (⚠️):  $partial_count
  Reserved    (🔄):  $reserved_count
  Missing     (❌):  $missing_count
  ----------------------
  Total rows:        $total

Per-category breakdowns:
EOF

# Per-category breakdown. The matrix uses `### <Category Name>` for
# subsections under `## 1. Functions`. We walk the file, track the
# current ### heading, and emit a count of status emojis since the
# last heading.
awk '
  /^### / {
    if (heading != "") {
      printf "  %-40s  ✅%d ⚠️%d 🔄%d ❌%d\n", heading, impl, part, res, miss
    }
    heading = substr($0, 5)
    impl = part = res = miss = 0
    next
  }
  /^## / && heading != "" {
    printf "  %-40s  ✅%d ⚠️%d 🔄%d ❌%d\n", heading, impl, part, res, miss
    heading = ""
    next
  }
  /^\|/ {
    # Only count emojis in markdown table rows.
    impl += gsub("✅", "✅")
    part += gsub("⚠️", "⚠️")
    res  += gsub("🔄", "🔄")
    miss += gsub("❌", "❌")
  }
  END {
    if (heading != "") {
      printf "  %-40s  ✅%d ⚠️%d 🔄%d ❌%d\n", heading, impl, part, res, miss
    }
  }
' "$MATRIX"

echo
echo "coverage=${coverage_pct}%"
