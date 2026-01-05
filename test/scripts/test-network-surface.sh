#!/usr/bin/env bash
# Unit tests for network surface scripts
# Tests verify-network-surface.sh

set -eo pipefail  # Removed -u to avoid issues with command substitution in local declarations

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERIFY_SCRIPT="${PROJECT_ROOT}/scripts/verify-network-surface.sh"
PRODUCT_JSON="${PROJECT_ROOT}/product.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

error() { echo -e "${RED}ERROR:${NC} $1" >&2; }
success() { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${YELLOW}INFO:${NC} $1"; }

# Test 1: Verify current network surface is clean
test_current_network_surface() {
    info "Test 1: Verify current network surface"

    cd "${PROJECT_ROOT}"
    if bash "${VERIFY_SCRIPT}" > /dev/null 2>&1; then
        success "Current network surface verification test passed"
        return 0
    else
        error "Current network surface verification failed"
        return 1
    fi
}

# Test 2: Detect Microsoft endpoints if present
test_detect_microsoft() {
    info "Test 2: Test detection of Microsoft endpoints"

    local backup="${PRODUCT_JSON}.test-backup"
    cp "${PRODUCT_JSON}" "${backup}"

    # Add a Microsoft endpoint
    local temp_json
    temp_json=$(mktemp)
    jq '.updateUrl = "https://update.code.visualstudio.com/api/update"' "${PRODUCT_JSON}" > "${temp_json}"
    mv "${temp_json}" "${PRODUCT_JSON}"

    cd "${PROJECT_ROOT}"

    # Verify should fail
    if bash "${VERIFY_SCRIPT}" > /dev/null 2>&1; then
        error "Should have detected Microsoft endpoint"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 1
    else
        success "Microsoft endpoint detection test passed"
        cp "${backup}" "${PRODUCT_JSON}"
        rm -f "${backup}"
        return 0
    fi
}

# Test 3: Verify defaultChatAgent is removed
test_no_default_chat_agent() {
    info "Test 3: Verify defaultChatAgent is not present"

    cd "${PROJECT_ROOT}"

    if jq -e ".defaultChatAgent" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        error "defaultChatAgent should not be present"
        return 1
    else
        success "defaultChatAgent correctly removed test passed"
        return 0
    fi
}

# Run all tests
main() {
    echo "=== Network Surface Script Tests ==="
    echo ""

    local failed=0
    test_current_network_surface || failed=$((failed + 1))
    test_detect_microsoft || failed=$((failed + 1))
    test_no_default_chat_agent || failed=$((failed + 1))

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

