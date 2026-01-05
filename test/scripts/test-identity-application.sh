#!/usr/bin/env bash
# Unit tests for identity application scripts
# Tests apply-identity.sh with various product.json states

set -eo pipefail  # Removed -u to avoid issues with command substitution in local declarations

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IDENTITY_SCRIPT="${PROJECT_ROOT}/scripts/apply-identity.sh"
VERIFY_SCRIPT="${PROJECT_ROOT}/scripts/verify-identity.sh"
PRODUCT_JSON="${PROJECT_ROOT}/product.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

error() { echo -e "${RED}ERROR:${NC} $1" >&2; }
success() { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${YELLOW}INFO:${NC} $1"; }

# Test 1: Verify identity script passes with current product.json
test_current_identity() {
    info "Test 1: Verify identity in current product.json"

    cd "${PROJECT_ROOT}"
    if bash "${VERIFY_SCRIPT}" > /dev/null 2>&1; then
        success "Current identity verification test passed"
        return 0
    else
        error "Current identity verification failed"
        return 1
    fi
}

# Test 2: Apply identity is idempotent
test_idempotent() {
    info "Test 2: Test identity application is idempotent"

    local backup="${PRODUCT_JSON}.test-backup"
    cp "${PRODUCT_JSON}" "${backup}"

    cd "${PROJECT_ROOT}"

    # Apply identity twice
    if ! bash "${IDENTITY_SCRIPT}" > /dev/null 2>&1; then
        error "First identity application failed (exit code: $?)"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    fi

    if ! bash "${IDENTITY_SCRIPT}" > /dev/null 2>&1; then
        error "Second identity application failed (exit code: $?)"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    fi

    # Verify identity is still valid
    if bash "${VERIFY_SCRIPT}" > /dev/null 2>&1; then
        success "Idempotent identity application test passed"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 0
    else
        error "Identity verification failed after double application"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    fi
}

# Test 3: Verify identity script detects mismatches
test_detect_mismatch() {
    info "Test 3: Verify detection of identity mismatches"

    local backup="${PRODUCT_JSON}.test-backup"
    cp "${PRODUCT_JSON}" "${backup}"

    # Modify product.json to have wrong identity
    local temp_json
    temp_json=$(mktemp)
    jq '.nameShort = "Wrong Name"' "${PRODUCT_JSON}" > "${temp_json}"
    mv "${temp_json}" "${PRODUCT_JSON}"

    cd "${PROJECT_ROOT}"

    # Verify should fail
    if bash "${VERIFY_SCRIPT}" > /dev/null 2>&1; then
        error "Verify script should have detected mismatch"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    else
        success "Mismatch detection test passed"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 0
    fi
}

# Test 4: Identity application fixes mismatches
test_fix_mismatch() {
    info "Test 4: Test identity application fixes mismatches"

    local backup="${PRODUCT_JSON}.test-backup"
    cp "${PRODUCT_JSON}" "${backup}"

    # Modify product.json to have wrong identity
    local temp_json
    temp_json=$(mktemp)
    jq '.applicationName = "wrong-name"' "${PRODUCT_JSON}" > "${temp_json}"
    mv "${temp_json}" "${PRODUCT_JSON}"

    cd "${PROJECT_ROOT}"

    # Apply identity should fix it
    if ! bash "${IDENTITY_SCRIPT}" > /dev/null 2>&1; then
        error "Identity application failed (exit code: $?)"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    fi

    # Verify should now pass
    if bash "${VERIFY_SCRIPT}" > /dev/null 2>&1; then
        success "Identity fix test passed"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 0
    else
        error "Verification failed after identity fix"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    fi
}

# Run all tests
main() {
    echo "=== Identity Application Script Tests ==="
    echo ""

    local failed=0
    test_current_identity || failed=$((failed + 1))
    test_idempotent || failed=$((failed + 1))
    test_detect_mismatch || failed=$((failed + 1))
    test_fix_mismatch || failed=$((failed + 1))

    echo ""
    if [ $failed -eq 0 ]; then
        success "All tests passed!"
        return 0
    else
        error "$failed test(s) failed"
        return 1
    fi
}

main "$@"

