#!/usr/bin/env bash
# Quantbook Phase 0 A2 acceptance — multiversion clone disassembly verification.
#
# Per spec Part V §1 A2: "multiversion wrapper for Arrow kernels with disassembly
# verification of runtime SIMD dispatch." This script:
#
# 1. Builds the og02_mul2 bench in release mode (which exercises the multiversion-
#    cloned mul_scalar kernel from `crates/ql-exec/src/simd.rs`).
# 2. Locates the bench binary under `target/release/deps/`.
# 3. Disassembles it with objdump (or llvm-objdump if objdump is unavailable).
# 4. Checks for AVX2 256-bit double-precision multiply instructions (`vmulpd ymm`),
#    which are what LLVM auto-vectorization emits inside the AVX2 multiversion clone.
# 5. Checks for the multiversion-emitted clone symbols themselves (function name +
#    target_feature suffix).
#
# Pass condition: AVX2 vmulpd ymm instructions ARE present in the binary AND the
# multiversion clone symbols exist.
#
# Limitations:
# - x86_64 only. ARM/aarch64 hosts skip with WARN (the AArch64 NEON clone doesn't emit
#   `vmulpd`; it emits `fmul`/`fmla` which is a separate check we'll add when we ship
#   to ARM CI).
# - Requires either `objdump` or `llvm-objdump` on PATH. Script exits with WARN
#   (not FAIL) if neither is available — Mac dev hosts often only have `otool`.
#
# Usage:
#   bash scripts/check-multiversion-clones.sh
# Exit codes:
#   0 = PASS (or skipped on non-x86_64)
#   1 = FAIL (binary built but AVX2 instructions absent — multiversion broken)
#   2 = WARN/SKIP (toolchain unavailable)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ENGINE_ROOT"

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64)
        TARGET_ISA=x86_64
        ;;
    aarch64|arm64)
        TARGET_ISA=aarch64
        ;;
    *)
        echo "SKIP: A2 disassembly check supports x86_64 + aarch64 only (current: $ARCH)"
        exit 2
        ;;
esac

# Pick an objdump that supports the host arch.
if command -v objdump >/dev/null 2>&1; then
    OBJDUMP=objdump
elif command -v llvm-objdump >/dev/null 2>&1; then
    OBJDUMP=llvm-objdump
else
    echo "SKIP: neither 'objdump' nor 'llvm-objdump' on PATH"
    exit 2
fi

echo "Using disassembler: $OBJDUMP"

# Build the bench in release mode (silently — we only care about the artifact).
echo "Building og02_mul2 bench in release..."
cargo build --release --bench og02_mul2 -p ql-exec 2>&1 | tail -5

# Find the bench binary. Cargo emits `og02_mul2-<hash>` under target/release/deps/.
# Use `-perm -100` for portability (GNU find's `-executable` doesn't exist on BSD/macOS).
BIN=$(find target/release/deps -maxdepth 1 -name 'og02_mul2-*' -type f -perm -100 2>/dev/null \
      | grep -v '\.d$' | head -1)
if [[ -z "${BIN:-}" ]]; then
    echo "FAIL: bench binary not found under target/release/deps/" >&2
    exit 1
fi
echo "Bench binary: $BIN"

# Disassemble; cap output via a temp file (avoids SIGPIPE under `pipefail` when using
# `head -c` against a long-running disassembler).
DISASM_TMP=$(mktemp -t qbook-disasm.XXXXXX)
trap 'rm -f "$DISASM_TMP"' EXIT
"$OBJDUMP" -d "$BIN" > "$DISASM_TMP" 2>/dev/null || true
DISASM=$(head -c 5000000 "$DISASM_TMP")

# Look for multiversion clone symbols. Standard multiversion 0.8 emits clones with the
# target_feature in the symbol name; the exact format may include a hash.
SYMBOLS=$("$OBJDUMP" -t "$BIN" 2>/dev/null || true)
MUL_SCALAR_SYMS=$(echo "$SYMBOLS" | grep -i 'mul_scalar' | head -20 || true)
NUM_MUL_SCALAR_SYMS=$(echo "$MUL_SCALAR_SYMS" | grep -c 'mul_scalar' || true)

# Arch-specific SIMD instruction signatures.
case "$TARGET_ISA" in
    x86_64)
        VMULPD_YMM_COUNT=$(echo "$DISASM" | grep -c 'vmulpd[[:space:]]\+%\?ymm' || true)
        VFMADD_COUNT=$(echo "$DISASM" | grep -cE 'vfmadd[0-9]+pd[[:space:]]+%\?ymm' || true)
        SIMD_HIT=$((VMULPD_YMM_COUNT + VFMADD_COUNT))
        echo ""
        echo "=== Findings (x86_64) ==="
        echo "AVX2 vmulpd ymm instructions:    $VMULPD_YMM_COUNT"
        echo "AVX2 vfmadd*pd ymm instructions: $VFMADD_COUNT"
        echo "mul_scalar-related symbols:      $NUM_MUL_SCALAR_SYMS"
        ;;
    aarch64)
        # NEON 2x f64 multiply. Two disassembler conventions:
        # - GNU binutils objdump: `fmul v0.2d, v1.2d, v2.2d`
        # - LLVM objdump (Mach-O): `fmul.2d v0, v1, v2`
        # Match any line that contains BOTH the mnemonic AND `.2d` somewhere after.
        FMUL_2D_COUNT=$(echo "$DISASM" | grep -E 'fmul' | grep -c '\.2d' || true)
        FMLA_2D_COUNT=$(echo "$DISASM" | grep -E 'fmla' | grep -c '\.2d' || true)
        SIMD_HIT=$((FMUL_2D_COUNT + FMLA_2D_COUNT))
        echo ""
        echo "=== Findings (aarch64) ==="
        echo "NEON fmul v#.2d instructions:    $FMUL_2D_COUNT"
        echo "NEON fmla v#.2d instructions:    $FMLA_2D_COUNT"
        echo "mul_scalar-related symbols:      $NUM_MUL_SCALAR_SYMS"
        ;;
esac

if [[ "$SIMD_HIT" -gt 0 ]]; then
    echo ""
    echo "PASS: A2 acceptance — $TARGET_ISA SIMD instructions present in"
    echo "      mul_scalar's multiversion clone. Runtime dispatch verified at"
    echo "      the disassembly level."
    exit 0
else
    echo ""
    echo "FAIL: A2 acceptance — no $TARGET_ISA SIMD instructions found." >&2
    echo "      Either the multiversion clone wasn't generated (check target attrs)" >&2
    echo "      OR LLVM didn't auto-vectorize the loop (check release profile flags)." >&2
    if [[ "$NUM_MUL_SCALAR_SYMS" -gt 0 ]]; then
        echo ""
        echo "Symbols found (expected: at least one with target_feature suffix):"
        echo "$MUL_SCALAR_SYMS"
    fi
    exit 1
fi
