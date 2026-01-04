#!/usr/bin/env bash
# Apply network surface safety patches to product.json
# Patches product links and ensures no Microsoft endpoints by default

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

# Check if product.json exists
if [[ ! -f "${PRODUCT_JSON}" ]]; then
    error "product.json not found: ${PRODUCT_JSON}"
    exit 1
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
    error "jq is required for JSON manipulation"
    exit 1
fi

# Discover network-related fields
discover_network_fields() {
    info "Discovering network-related fields in product.json..."
    echo ""

    local product_json="${PROJECT_ROOT}/product.json"

    echo "Update/Telemetry/Crash fields:"
    for key in updateUrl updateEndpoint telemetry crashReporter; do
        if jq -e ".${key}" "${product_json}" > /dev/null 2>&1; then
            local value
            value=$(jq -r ".${key}" "${product_json}")
            if [[ "${value}" == "null" ]]; then
                echo "  ✓ ${key}: null (not configured)"
            else
                echo "  ✓ ${key}: ${value}"
            fi
        else
            echo "  ✗ ${key}: not present"
        fi
    done
    echo ""

    echo "Product links:"
    for key in reportIssueUrl homepageUrl licenseUrl serverLicenseUrl privacyUrl documentationUrl; do
        if jq -e ".${key}" "${product_json}" > /dev/null 2>&1; then
            local value
            value=$(jq -r ".${key}" "${product_json}")
            if [[ "${value}" == "null" ]]; then
                echo "  ✓ ${key}: null (not configured)"
            else
                echo "  ✓ ${key}: ${value}"
            fi
        else
            echo "  ✗ ${key}: not present"
        fi
    done
    echo ""

    echo "Other network fields:"
    if jq -e ".extensionsGallery" "${product_json}" > /dev/null 2>&1; then
        echo "  ✓ extensionsGallery: present"
        jq -r '.extensionsGallery.serviceUrl // "null"' "${product_json}" | sed 's/^/    serviceUrl: /'
    else
        echo "  ✗ extensionsGallery: not present"
    fi

    if jq -e ".webviewContentExternalBaseUrlTemplate" "${product_json}" > /dev/null 2>&1; then
        local webview_url
        webview_url=$(jq -r '.webviewContentExternalBaseUrlTemplate' "${product_json}")
        echo "  ✓ webviewContentExternalBaseUrlTemplate: ${webview_url}"
    fi
    echo ""
}

# Apply network surface patches
apply_network_patches() {
    info "Applying network surface safety patches..."
    echo ""

    local backup_json="${PRODUCT_JSON}.backup.network"

    # Create backup if it doesn't exist (preserve identity backup)
    if [[ ! -f "${PRODUCT_JSON}.backup" ]]; then
        cp "${PRODUCT_JSON}" "${backup_json}"
        info "Created backup: ${backup_json}"
    else
        cp "${PRODUCT_JSON}" "${backup_json}"
        info "Created network backup: ${backup_json}"
    fi

    # Start with current JSON content
    local json_content
    json_content=$(cat "${PRODUCT_JSON}")

    # Patch reportIssueUrl -> ISSUES_URL
    if jq -e ".reportIssueUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".reportIssueUrl = \"${ISSUES_URL}\"")
        info "  ✓ Patched reportIssueUrl: ${ISSUES_URL}"
    fi

    # Patch licenseUrl -> LICENSE_URL
    if jq -e ".licenseUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".licenseUrl = \"${LICENSE_URL}\"")
        info "  ✓ Patched licenseUrl: ${LICENSE_URL}"
    fi

    # Patch serverLicenseUrl -> LICENSE_URL
    if jq -e ".serverLicenseUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".serverLicenseUrl = \"${LICENSE_URL}\"")
        info "  ✓ Patched serverLicenseUrl: ${LICENSE_URL}"
    fi

    # Ensure updateUrl is null or not pointing to Microsoft
    if jq -e ".updateUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local update_url
        update_url=$(jq -r '.updateUrl' "${PRODUCT_JSON}")
        if [[ "${update_url}" != "null" ]] && [[ "${update_url}" == *"microsoft.com"* ]] || [[ "${update_url}" == *"visualstudio.com"* ]]; then
            if [[ "${ALLOW_MICROSOFT_UPDATE_ENDPOINTS}" == "0" ]]; then
                json_content=$(echo "${json_content}" | jq '.updateUrl = null')
                info "  ✓ Disabled updateUrl (was pointing to Microsoft)"
            fi
        fi
    fi

    # Ensure telemetry is disabled if ALLOW_TELEMETRY_DEFAULT=0
    if [[ "${ALLOW_TELEMETRY_DEFAULT}" == "0" ]]; then
        if jq -e ".enableTelemetry" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            json_content=$(echo "${json_content}" | jq '.enableTelemetry = false')
            info "  ✓ Disabled enableTelemetry (ALLOW_TELEMETRY_DEFAULT=0)"
        fi
        if jq -e ".enabledTelemetryLevels" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            json_content=$(echo "${json_content}" | jq '.enabledTelemetryLevels = {"error": false, "usage": false}')
            info "  ✓ Disabled enabledTelemetryLevels (ALLOW_TELEMETRY_DEFAULT=0)"
        fi
    fi

    # Write result
    echo "${json_content}" | jq . > "${PRODUCT_JSON}"
    info "✓ Applied network surface patches to product.json"
    echo ""
}

main() {
    echo "=== Apply Network Surface Safety ==="
    echo "Product JSON: ${PRODUCT_JSON}"
    echo "Identity Config: ${IDENTITY_CONFIG}"
    echo ""

    discover_network_fields
    apply_network_patches

    echo ""
    info "=== Network Surface Safety Complete ==="
    info "Backup saved to: ${PRODUCT_JSON}.backup.network"
    info "Run ./scripts/verify-network-surface.sh to verify changes"
}

main "$@"

