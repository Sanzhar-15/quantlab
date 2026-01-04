#!/usr/bin/env bash
# Verify network surface safety
# Checks product links match config, ensures no Microsoft endpoints

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IDENTITY_CONFIG="${PROJECT_ROOT}/config/quantlab.identity.env"
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

# Load identity config
if [[ ! -f "${IDENTITY_CONFIG}" ]]; then
    error "Identity config not found: ${IDENTITY_CONFIG}"
    exit 1
fi

source "${IDENTITY_CONFIG}"

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

# Verify a URL field matches expected value
verify_url_field() {
    local key="$1"
    local expected="$2"
    local description="$3"

    if ! jq -e ".${key}" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        warn "Key '${key}' not present in product.json - skipping ${description}"
        return 0
    fi

    local actual
    actual=$(jq -r ".${key}" "${PRODUCT_JSON}")

    if [[ "${actual}" == "null" ]]; then
        warn "${description} is null (not configured)"
        return 0
    fi

    if [[ "${actual}" == "${expected}" ]]; then
        info "✓ ${description}: ${actual}"
        return 0
    else
        error "Mismatch for ${description}"
        error "  Expected: ${expected}"
        error "  Actual: ${actual}"
        return 1
    fi
}

# Check if URL contains forbidden domains
check_forbidden_domains() {
    local url="$1"
    local description="$2"

    if [[ -z "${url}" ]] || [[ "${url}" == "null" ]]; then
        return 0
    fi

    if [[ "${url}" == *"microsoft.com"* ]] || [[ "${url}" == *"visualstudio.com"* ]]; then
        error "Forbidden domain found in ${description}: ${url}"
        return 1
    fi

    return 0
}

# Discover and print all network endpoints/links
discover_endpoints() {
    info "Discovered network endpoints/links:"
    echo ""

    local errors=0

    # Product links
    echo "Product Links:"
    for key in reportIssueUrl homepageUrl licenseUrl serverLicenseUrl privacyUrl documentationUrl; do
        if jq -e ".${key}" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            local value
            value=$(jq -r ".${key}" "${PRODUCT_JSON}")
            if [[ "${value}" != "null" ]]; then
                echo "  ${key}: ${value}"
                check_forbidden_domains "${value}" "${key}" || errors=$((errors + 1))
            fi
        fi
    done
    echo ""

    # Update/Telemetry fields
    echo "Update/Telemetry Fields:"
    for key in updateUrl updateEndpoint telemetry crashReporter; do
        if jq -e ".${key}" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            local value
            value=$(jq -r ".${key}" "${PRODUCT_JSON}")
            if [[ "${value}" != "null" ]]; then
                echo "  ${key}: ${value}"
                check_forbidden_domains "${value}" "${key}" || errors=$((errors + 1))
            else
                echo "  ${key}: null (disabled)"
            fi
        fi
    done
    echo ""

    # Telemetry enablement
    if jq -e ".enableTelemetry" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local telemetry_enabled
        telemetry_enabled=$(jq -r '.enableTelemetry' "${PRODUCT_JSON}")
        echo "  enableTelemetry: ${telemetry_enabled}"
        if [[ "${ALLOW_TELEMETRY_DEFAULT}" == "0" ]] && [[ "${telemetry_enabled}" != "false" ]] && [[ "${telemetry_enabled}" != "null" ]]; then
            error "Telemetry should be disabled (ALLOW_TELEMETRY_DEFAULT=0)"
            errors=$((errors + 1))
        fi
    fi

    if jq -e ".enabledTelemetryLevels" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local telemetry_levels
        telemetry_levels=$(jq -c '.enabledTelemetryLevels' "${PRODUCT_JSON}")
        echo "  enabledTelemetryLevels: ${telemetry_levels}"
    fi
    echo ""

    # Extensions Gallery
    if jq -e ".extensionsGallery" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        echo "Extensions Gallery:"
        local service_url
        service_url=$(jq -r '.extensionsGallery.serviceUrl // "null"' "${PRODUCT_JSON}")
        echo "  serviceUrl: ${service_url}"
        check_forbidden_domains "${service_url}" "extensionsGallery.serviceUrl" || errors=$((errors + 1))
    else
        echo "Extensions Gallery: not present (safe)"
    fi
    echo ""

    # Other network fields
    echo "Other Network Fields:"
    if jq -e ".webviewContentExternalBaseUrlTemplate" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local webview_url
        webview_url=$(jq -r '.webviewContentExternalBaseUrlTemplate' "${PRODUCT_JSON}")
        echo "  webviewContentExternalBaseUrlTemplate: ${webview_url}"
        # Note: This may point to Microsoft CDN but is needed for functionality
        # We'll warn but not fail
        if [[ "${webview_url}" == *"microsoft.com"* ]] || [[ "${webview_url}" == *"visualstudio.com"* ]] || [[ "${webview_url}" == *"vscode-cdn.net"* ]]; then
            warn "  ⚠ webviewContentExternalBaseUrlTemplate points to Microsoft CDN (may be required for functionality)"
        fi
    fi

    if jq -e ".linkProtectionTrustedDomains" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local trusted_domains
        trusted_domains=$(jq -c '.linkProtectionTrustedDomains // []' "${PRODUCT_JSON}")
        echo "  linkProtectionTrustedDomains: ${trusted_domains}"
        # Check for Microsoft domains in trusted domains
        if echo "${trusted_domains}" | grep -qE '(microsoft\.com|visualstudio\.com)'; then
            warn "  ⚠ linkProtectionTrustedDomains contains Microsoft domains (may be required for functionality)"
        fi
    fi
    echo ""

    return ${errors}
}

main() {
    echo "Verifying network surface safety..."
    echo "Identity config: ${IDENTITY_CONFIG}"
    echo ""

    local errors=0

    # Verify product links match config
    info "Verifying product links match config:"
    verify_url_field "reportIssueUrl" "${ISSUES_URL}" "reportIssueUrl" || errors=$((errors + 1))
    verify_url_field "licenseUrl" "${LICENSE_URL}" "licenseUrl" || errors=$((errors + 1))
    verify_url_field "serverLicenseUrl" "${LICENSE_URL}" "serverLicenseUrl" || errors=$((errors + 1))

    # homepageUrl and privacyUrl are optional, check if present
    if jq -e ".homepageUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        verify_url_field "homepageUrl" "${HOMEPAGE_URL}" "homepageUrl" || errors=$((errors + 1))
    fi

    if jq -e ".privacyUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        verify_url_field "privacyUrl" "${PRIVACY_URL}" "privacyUrl" || errors=$((errors + 1))
    fi

    echo ""

    # Discover and check all endpoints
    discover_endpoints || errors=$((errors + 1))

    if [[ ${errors} -eq 0 ]]; then
        info "All network surface verifications passed!"
        return 0
    else
        error "${errors} verification(s) failed"
        return 1
    fi
}

main "$@"

