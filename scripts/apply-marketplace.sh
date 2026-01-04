#!/usr/bin/env bash
# Configure Open VSX as default marketplace
# Adds extensionsGallery and linkProtectionTrustedDomains to product.json

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

# Inspect current marketplace configuration
inspect_marketplace() {
    info "Inspecting current marketplace configuration..."
    echo ""

    if jq -e ".extensionsGallery" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        echo "Current extensionsGallery:"
        jq '.extensionsGallery' "${PRODUCT_JSON}" | sed 's/^/  /'
    else
        echo "  extensionsGallery: not present"
    fi
    echo ""

    if jq -e ".linkProtectionTrustedDomains" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        echo "Current linkProtectionTrustedDomains:"
        jq '.linkProtectionTrustedDomains' "${PRODUCT_JSON}" | sed 's/^/  /'
    else
        echo "  linkProtectionTrustedDomains: not present"
    fi
    echo ""
}

# Apply Open VSX marketplace configuration
apply_open_vsx() {
    info "Applying Open VSX marketplace configuration..."
    echo ""

    local backup_json="${PRODUCT_JSON}.backup.marketplace"

    # Create backup
    cp "${PRODUCT_JSON}" "${backup_json}"
    info "Created backup: ${backup_json}"

    # Start with current JSON content
    local json_content
    json_content=$(cat "${PRODUCT_JSON}")

    # Open VSX URLs
    local open_vsx_service_url="https://open-vsx.org/vscode/gallery"
    local open_vsx_item_url="https://open-vsx.org/vscode/item"
    local open_vsx_resource_template="https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/{path}"

    # Check if extensionsGallery already exists
    if jq -e ".extensionsGallery" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        # Update existing extensionsGallery
        info "  Updating existing extensionsGallery..."

        # Update serviceUrl
        json_content=$(echo "${json_content}" | jq ".extensionsGallery.serviceUrl = \"${open_vsx_service_url}\"")
        info "    ✓ serviceUrl: ${open_vsx_service_url}"

        # Update itemUrl if present, otherwise add it
        if jq -e ".extensionsGallery.itemUrl" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            json_content=$(echo "${json_content}" | jq ".extensionsGallery.itemUrl = \"${open_vsx_item_url}\"")
            info "    ✓ itemUrl: ${open_vsx_item_url}"
        else
            json_content=$(echo "${json_content}" | jq ".extensionsGallery.itemUrl = \"${open_vsx_item_url}\"")
            info "    ✓ Added itemUrl: ${open_vsx_item_url}"
        fi

        # Update resourceUrlTemplate if present, otherwise add it
        if jq -e ".extensionsGallery.resourceUrlTemplate" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            local existing_template
            existing_template=$(jq -r '.extensionsGallery.resourceUrlTemplate' "${PRODUCT_JSON}")
            info "    ℹ Keeping existing resourceUrlTemplate: ${existing_template}"
        else
            json_content=$(echo "${json_content}" | jq ".extensionsGallery.resourceUrlTemplate = \"${open_vsx_resource_template}\"")
            info "    ✓ Added resourceUrlTemplate: ${open_vsx_resource_template}"
        fi
    else
        # Create new extensionsGallery
        info "  Creating extensionsGallery..."
        json_content=$(echo "${json_content}" | jq ".extensionsGallery = {
            \"serviceUrl\": \"${open_vsx_service_url}\",
            \"itemUrl\": \"${open_vsx_item_url}\",
            \"resourceUrlTemplate\": \"${open_vsx_resource_template}\"
        }")
        info "    ✓ Created extensionsGallery with Open VSX URLs"
    fi

    # Handle linkProtectionTrustedDomains
    if jq -e ".linkProtectionTrustedDomains" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        # Check if open-vsx.org is already in the list
        if jq -e '.linkProtectionTrustedDomains[] | select(. == "https://open-vsx.org")' "${PRODUCT_JSON}" > /dev/null 2>&1; then
            info "  ✓ open-vsx.org already in linkProtectionTrustedDomains"
        else
            # Add open-vsx.org to the array
            json_content=$(echo "${json_content}" | jq '.linkProtectionTrustedDomains += ["https://open-vsx.org"]')
            info "  ✓ Added https://open-vsx.org to linkProtectionTrustedDomains"
        fi
    else
        # Create new linkProtectionTrustedDomains array
        json_content=$(echo "${json_content}" | jq '.linkProtectionTrustedDomains = ["https://open-vsx.org"]')
        info "  ✓ Created linkProtectionTrustedDomains with https://open-vsx.org"
    fi

    # Write result
    echo "${json_content}" | jq . > "${PRODUCT_JSON}"
    info "✓ Applied Open VSX marketplace configuration"
    echo ""
}

main() {
    echo "=== Configure Open VSX Marketplace ==="
    echo "Product JSON: ${PRODUCT_JSON}"
    echo "Identity Config: ${IDENTITY_CONFIG}"
    echo ""

    inspect_marketplace
    apply_open_vsx

    echo ""
    info "=== Marketplace Configuration Complete ==="
    info "Backup saved to: ${PRODUCT_JSON}.backup.marketplace"
    info "Run ./scripts/verify-marketplace.sh to verify changes"
}

main "$@"

