#!/usr/bin/env bash
# Verify Open VSX marketplace configuration
# Validates product.json and optionally tests Open VSX API

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PRODUCT_JSON="${PROJECT_ROOT}/product.json"

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

# Check if jq is available
if ! command -v jq &> /dev/null; then
    error "jq is required for JSON validation"
    exit 1
fi

# Check if product.json exists
if [[ ! -f "${PRODUCT_JSON}" ]]; then
    error "product.json not found: ${PRODUCT_JSON}"
    exit 1
fi

# Validate product.json is valid JSON
validate_json() {
    info "Validating product.json is valid JSON..."

    if jq empty "${PRODUCT_JSON}" 2>/dev/null; then
        info "✓ product.json is valid JSON"
        return 0
    else
        error "product.json is not valid JSON"
        return 1
    fi
}

# Verify extensionsGallery configuration
verify_extensions_gallery() {
    info "Verifying extensionsGallery configuration..."
    echo ""

    local errors=0

    # Check if extensionsGallery exists
    if ! jq -e ".extensionsGallery" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        error "extensionsGallery is not present in product.json"
        return 1
    fi

    # Expected Open VSX URLs
    local expected_service_url="https://open-vsx.org/vscode/gallery"
    local expected_item_url="https://open-vsx.org/vscode/item"

    # Verify serviceUrl
    if jq -e ".extensionsGallery.serviceUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local actual_service_url
        actual_service_url=$(jq -r '.extensionsGallery.serviceUrl' "${PRODUCT_JSON}")
        if [[ "${actual_service_url}" == "${expected_service_url}" ]]; then
            info "✓ serviceUrl: ${actual_service_url}"
        else
            error "serviceUrl mismatch"
            error "  Expected: ${expected_service_url}"
            error "  Actual: ${actual_service_url}"
            errors=$((errors + 1))
        fi
    else
        error "extensionsGallery.serviceUrl is not present"
        errors=$((errors + 1))
    fi

    # Verify itemUrl
    if jq -e ".extensionsGallery.itemUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local actual_item_url
        actual_item_url=$(jq -r '.extensionsGallery.itemUrl' "${PRODUCT_JSON}")
        if [[ "${actual_item_url}" == "${expected_item_url}" ]]; then
            info "✓ itemUrl: ${actual_item_url}"
        else
            error "itemUrl mismatch"
            error "  Expected: ${expected_item_url}"
            error "  Actual: ${actual_item_url}"
            errors=$((errors + 1))
        fi
    else
        error "extensionsGallery.itemUrl is not present"
        errors=$((errors + 1))
    fi

    # Check resourceUrlTemplate (optional but should be present)
    if jq -e ".extensionsGallery.resourceUrlTemplate" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local resource_template
        resource_template=$(jq -r '.extensionsGallery.resourceUrlTemplate' "${PRODUCT_JSON}")
        info "✓ resourceUrlTemplate: ${resource_template}"
    else
        warn "resourceUrlTemplate is not present (optional but recommended)"
    fi

    echo ""
    return ${errors}
}

# Verify linkProtectionTrustedDomains
verify_link_protection() {
    info "Verifying linkProtectionTrustedDomains..."
    echo ""

    local errors=0

    # Check if linkProtectionTrustedDomains exists
    if ! jq -e ".linkProtectionTrustedDomains" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        error "linkProtectionTrustedDomains is not present in product.json"
        return 1
    fi

    # Check if it's an array
    if ! jq -e '.linkProtectionTrustedDomains | type == "array"' "${PRODUCT_JSON}" > /dev/null 2>&1; then
        error "linkProtectionTrustedDomains is not an array"
        return 1
    fi

    # Check if open-vsx.org is in the list
    if jq -e '.linkProtectionTrustedDomains[] | select(. == "https://open-vsx.org")' "${PRODUCT_JSON}" > /dev/null 2>&1; then
        info "✓ https://open-vsx.org is in linkProtectionTrustedDomains"
    else
        error "https://open-vsx.org is not in linkProtectionTrustedDomains"
        errors=$((errors + 1))
    fi

    # Print all trusted domains
    local trusted_domains
    trusted_domains=$(jq -c '.linkProtectionTrustedDomains' "${PRODUCT_JSON}")
    info "  All trusted domains: ${trusted_domains}"
    echo ""

    return ${errors}
}

# Test Open VSX API (optional network test)
test_open_vsx_api() {
    info "Testing Open VSX API connectivity..."
    echo ""

    local service_url
    service_url=$(jq -r '.extensionsGallery.serviceUrl' "${PRODUCT_JSON}")

    if [[ -z "${service_url}" ]] || [[ "${service_url}" == "null" ]]; then
        error "Cannot test API: serviceUrl is not configured"
        return 1
    fi

    # Check if curl is available
    if ! command -v curl &> /dev/null; then
        warn "curl is not available - skipping API test"
        return 0
    fi

    # Build API endpoint
    local api_url="${service_url}/extensionquery"

    # Create a minimal query payload (query for a popular extension to test)
    local query_payload='{"filters":[{"criteria":[{"filterType":8,"value":"ms-python.python"}],"pageNumber":1,"pageSize":1}],"flags":131}'

    info "  Testing: POST ${api_url}"

    # Perform the request
    local http_code
    local response
    http_code=$(curl -s -o /tmp/open-vsx-test-response.json -w "%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -d "${query_payload}" \
        "${api_url}" 2>&1) || {
        local curl_exit=$?

        # Check if network failures should be ignored
        if [[ "${ALLOW_NET_FAIL:-0}" == "1" ]]; then
            warn "  Network request failed (exit code: ${curl_exit})"
            warn "  ALLOW_NET_FAIL=1, continuing..."
            return 0
        else
            error "  Network request failed (exit code: ${curl_exit})"
            return 1
        fi
    }

    # Check HTTP status code
    if [[ "${http_code}" == "200" ]]; then
        info "  ✓ HTTP ${http_code} - API is accessible"

        # Try to parse response as JSON
        if jq empty /tmp/open-vsx-test-response.json 2>/dev/null; then
            info "  ✓ Response is valid JSON"

            # Check if response contains expected structure
            if jq -e '.results' /tmp/open-vsx-test-response.json > /dev/null 2>&1; then
                info "  ✓ Response structure looks valid"
            else
                warn "  ⚠ Response structure may be unexpected"
            fi
        else
            warn "  ⚠ Response is not valid JSON"
        fi
    else
        if [[ "${ALLOW_NET_FAIL:-0}" == "1" ]]; then
            warn "  HTTP ${http_code} - API test failed but ALLOW_NET_FAIL=1, continuing..."
            return 0
        else
            error "  HTTP ${http_code} - API test failed"
            error "  Expected HTTP 200"
            return 1
        fi
    fi

    echo ""
    return 0
}

main() {
    echo "Verifying Open VSX marketplace configuration..."
    echo "Product JSON: ${PRODUCT_JSON}"
    echo ""

    local errors=0

    validate_json || errors=$((errors + 1))
    verify_extensions_gallery || errors=$((errors + 1))
    verify_link_protection || errors=$((errors + 1))

    echo ""
    test_open_vsx_api || {
        if [[ "${ALLOW_NET_FAIL:-0}" != "1" ]]; then
            errors=$((errors + 1))
        fi
    }

    if [[ ${errors} -eq 0 ]]; then
        info "All marketplace verifications passed!"
        return 0
    else
        error "${errors} verification(s) failed"
        return 1
    fi
}

main "$@"

