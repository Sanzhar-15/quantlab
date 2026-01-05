#!/usr/bin/env bash
# Comprehensive verification script for Quantlab
# Runs all verification scripts in sequence and exits non-zero on any failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$PROJECT_ROOT"

echo "=== Quantlab Comprehensive Verification ==="
echo "Project root: ${PROJECT_ROOT}"
echo ""

# Track if any verification fails
FAILED=0

# Function to run a verification script and track failures
run_verify() {
    local script_name="$1"
    local script_path="${SCRIPT_DIR}/${script_name}"

    if [ ! -f "$script_path" ]; then
        echo "ERROR: Verification script not found: $script_path"
        FAILED=1
        return 1
    fi

    if [ ! -x "$script_path" ]; then
        echo "WARNING: Making script executable: $script_path"
        chmod +x "$script_path"
    fi

    echo "--- Running: ${script_name} ---"
    if "$script_path"; then
        echo "✓ ${script_name} passed"
        echo ""
        return 0
    else
        echo "✗ ${script_name} failed (exit code: $?)"
        echo ""
        FAILED=1
        return 1
    fi
}

# Required verifications (must pass)
echo "Running required verifications..."
echo ""

run_verify "preflight.sh"
run_verify "verify-build.sh"
run_verify "verify-identity.sh"
run_verify "verify-network-surface.sh"
run_verify "verify-marketplace.sh"

# Optional verification (only if artifacts exist)
echo "Checking for optional verifications..."
echo ""

# Check if verify-artifacts.sh should run
# Look for common artifact locations
ARTIFACT_PATHS=(
    "VSCode-win32-x64"
    "VSCode-darwin-x64"
    "VSCode-linux-x64"
    "../VSCode-win32-x64"
    "../VSCode-darwin-x64"
    "../VSCode-linux-x64"
    ".build/linux/deb"
    ".build/linux/client"
)

HAS_ARTIFACTS=0
for path in "${ARTIFACT_PATHS[@]}"; do
    if [ -e "$path" ]; then
        HAS_ARTIFACTS=1
        break
    fi
done

if [ "$HAS_ARTIFACTS" -eq 1 ]; then
    echo "Artifacts detected, running verify-artifacts.sh..."
    if run_verify "verify-artifacts.sh"; then
        echo "✓ verify-artifacts.sh passed (optional)"
    else
        echo "⚠ verify-artifacts.sh failed (optional, but recommended to fix)"
        # Don't fail the entire run for optional verification
    fi
    echo ""
else
    echo "No artifacts detected, skipping verify-artifacts.sh (optional)"
    echo ""
fi

# Final summary
echo "=== Verification Summary ==="
if [ "$FAILED" -eq 0 ]; then
    echo "✓ All required verifications passed"
    echo ""
    exit 0
else
    echo "✗ One or more verifications failed"
    echo ""
    echo "Please review the errors above and fix the issues before proceeding."
    echo ""
    exit 1
fi

