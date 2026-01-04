#!/usr/bin/env bash
# Verify build is complete and valid
# Checks: product.json validity, out/ directory, version script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

error() {
    echo -e "${RED}ERROR:${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}WARN:${NC} $1" >&2
}

info() {
    echo -e "${GREEN}INFO:${NC} $1"
}

# Check product.json is valid JSON
check_product_json() {
    local product_json="${PROJECT_ROOT}/product.json"

    if [[ ! -f "${product_json}" ]]; then
        error "product.json not found"
        return 1
    fi

    # Try to parse with jq if available
    if command -v jq &> /dev/null; then
        if jq empty "${product_json}" 2>/dev/null; then
            info "✓ product.json is valid JSON (verified with jq)"
            return 0
        else
            error "product.json is not valid JSON (jq parse failed)"
            return 1
        fi
    fi

    # Fallback: try with python
    if command -v python3 &> /dev/null; then
        if python3 -m json.tool "${product_json}" > /dev/null 2>&1; then
            info "✓ product.json is valid JSON (verified with python3)"
            return 0
        else
            error "product.json is not valid JSON (python3 parse failed)"
            return 1
        fi
    fi

    # Last resort: check if file exists and is readable
    if [[ -r "${product_json}" ]]; then
        warn "product.json exists but cannot validate JSON (jq/python3 not available)"
        return 0  # Don't fail if we can't validate
    else
        error "product.json is not readable"
        return 1
    fi
}

# Check out/ directory exists
check_out_directory() {
    local out_dir="${PROJECT_ROOT}/out"

    if [[ ! -d "${out_dir}" ]]; then
        error "out/ directory not found - build may not be complete"
        return 1
    fi

    if [[ ! -r "${out_dir}" ]]; then
        error "out/ directory is not readable"
        return 1
    fi

    info "✓ out/ directory exists"

    # Check if it's empty (might indicate incomplete build)
    if [[ -z "$(ls -A "${out_dir}" 2>/dev/null)" ]]; then
        warn "out/ directory is empty - build may not be complete"
        return 0  # Don't fail, just warn
    fi

    return 0
}

# Check print-version.sh succeeds
check_version_script() {
    local version_script="${PROJECT_ROOT}/scripts/print-version.sh"

    if [[ ! -f "${version_script}" ]]; then
        error "scripts/print-version.sh not found"
        return 1
    fi

    if [[ ! -x "${version_script}" ]]; then
        error "scripts/print-version.sh is not executable"
        return 1
    fi

    local version
    if version=$("${version_script}" 2>&1); then
        if [[ -n "${version}" ]]; then
            info "✓ Version check succeeded: ${version}"
            return 0
        else
            error "Version script returned empty output"
            return 1
        fi
    else
        error "Version script failed (exit code: $?)"
        return 1
    fi
}

main() {
    echo "Verifying Quantlab build..."
    echo "Project root: ${PROJECT_ROOT}"
    echo ""

    local errors=0

    check_product_json || errors=$((errors + 1))
    check_out_directory || errors=$((errors + 1))
    check_version_script || errors=$((errors + 1))

    echo ""
    if [[ ${errors} -eq 0 ]]; then
        info "All build verifications passed!"
        return 0
    else
        error "${errors} verification(s) failed"
        return 1
    fi
}

main "$@"

