#!/usr/bin/env bash
# Integration tests for full workflows
# Tests identity → verification → network → marketplace workflows

set -eo pipefail  # Removed -u to avoid issues with command substitution in local declarations

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PRODUCT_JSON="${PROJECT_ROOT}/product.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

error() { echo -e "${RED}ERROR:${NC} $1" >&2; }
success() { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${YELLOW}INFO:${NC} $1"; }

# Test 1: Full identity workflow
test_identity_workflow() {
    info "Test 1: Full identity application workflow"

    local backup="${PRODUCT_JSON}.test-backup"
    cp "${PRODUCT_JSON}" "${backup}"

    cd "${PROJECT_ROOT}"

    # Corrupt identity
    local temp_json
    temp_json=$(mktemp)
    jq '.nameShort = "Wrong"' "${PRODUCT_JSON}" > "${temp_json}"
    mv "${temp_json}" "${PRODUCT_JSON}"

    # Apply identity
    bash "${PROJECT_ROOT}/scripts/apply-identity.sh" > /dev/null 2>&1 || {
        error "apply-identity.sh failed"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    }

    # Verify identity
    bash "${PROJECT_ROOT}/scripts/verify-identity.sh" > /dev/null 2>&1 || {
        error "verify-identity.sh failed after application"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    }

    success "Identity workflow test passed"
    cp "${backup}" "${PRODUCT_JSON}"
    rm -f "${backup}"
    return 0
}

# Test 2: Network surface workflow
test_network_workflow() {
    info "Test 2: Network surface verification workflow"

    cd "${PROJECT_ROOT}"

    # Apply network surface (should be idempotent)
    bash "${PROJECT_ROOT}/scripts/apply-network-surface.sh" > /dev/null 2>&1 || {
        error "apply-network-surface.sh failed"
        return 1
    }

    # Verify network surface
    bash "${PROJECT_ROOT}/scripts/verify-network-surface.sh" > /dev/null 2>&1 || {
        error "verify-network-surface.sh failed"
        return 1
    }

    success "Network surface workflow test passed"
    return 0
}

# Test 3: Marketplace workflow
test_marketplace_workflow() {
    info "Test 3: Marketplace verification workflow"

    cd "${PROJECT_ROOT}"

    # Apply marketplace (should be idempotent)
    bash "${PROJECT_ROOT}/scripts/apply-marketplace.sh" > /dev/null 2>&1 || {
        error "apply-marketplace.sh failed"
        return 1
    }

    # Verify marketplace
    bash "${PROJECT_ROOT}/scripts/verify-marketplace.sh" > /dev/null 2>&1 || {
        error "verify-marketplace.sh failed"
        return 1
    }

    success "Marketplace workflow test passed"
    return 0
}

# Test 4: Complete verification
test_complete_verification() {
    info "Test 4: Complete verification workflow"

    cd "${PROJECT_ROOT}"

    # Run all verifications
    bash "${PROJECT_ROOT}/scripts/verify-all.sh" > /dev/null 2>&1 || {
        error "verify-all.sh failed"
        return 1
    }

    success "Complete verification test passed"
    return 0
}

# Run all tests
main() {
    echo "=== Integration Tests ==="
    echo ""

    local failed=0
    test_identity_workflow || failed=$((failed + 1))
    test_network_workflow || failed=$((failed + 1))
    test_marketplace_workflow || failed=$((failed + 1))
    test_complete_verification || failed=$((failed + 1))

    echo ""
    if [ $failed -eq 0 ]; then
        success "All integration tests passed!"
        return 0
    else
        error "$failed test(s) failed"
        return 1
    fi
}

main "$@"

