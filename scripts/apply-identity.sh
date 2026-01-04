#!/usr/bin/env bash
# Apply Quantlab identity to product.json
# Patches only existing keys, preserves unrelated fields
# Version strategy: inherit upstream (no prerelease suffixes)

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
    error "Install with: sudo apt install jq (or equivalent)"
    exit 1
fi

# Inspect and list existing identity keys
inspect_identity_keys() {
    info "Inspecting product.json for identity keys..."
    echo ""

    local keys_to_check=(
        "nameShort"
        "nameLong"
        "applicationName"
        "dataFolderName"
        "serverApplicationName"
        "serverDataFolderName"
        "tunnelApplicationName"
        "linuxIconName"
        "urlProtocol"
        "darwinBundleIdentifier"
    )

    echo "Checking standard identity keys:"
    for key in "${keys_to_check[@]}"; do
        if jq -e ".${key}" "${PRODUCT_JSON}" > /dev/null 2>&1; then
            local value
            value=$(jq -r ".${key}" "${PRODUCT_JSON}")
            echo "  ✓ ${key}: ${value}"
        else
            echo "  ✗ ${key}: not present"
        fi
    done
    echo ""

    echo "Checking win32* keys:"
    jq -r 'keys[]' "${PRODUCT_JSON}" | grep -E '^win32' | while read -r key; do
        local value
        value=$(jq -r ".${key}" "${PRODUCT_JSON}")
        echo "  ✓ ${key}: ${value}"
    done
    echo ""
}

# Apply identity patches
apply_identity_patches() {
    info "Applying Quantlab identity patches..."
    echo ""

    local backup_json="${PRODUCT_JSON}.backup"

    # Create backup
    cp "${PRODUCT_JSON}" "${backup_json}"
    info "Created backup: ${backup_json}"

    # Start with original JSON content
    local json_content
    json_content=$(cat "${PRODUCT_JSON}")

    # Map identity config to product.json keys
    # Only patch keys that exist in product.json

    # nameShort -> APP_NAME
    if jq -e ".nameShort" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".nameShort = \"${APP_NAME}\"")
        info "  ✓ Patched nameShort: ${APP_NAME}"
    fi

    # nameLong -> APP_NAME
    if jq -e ".nameLong" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".nameLong = \"${APP_NAME}\"")
        info "  ✓ Patched nameLong: ${APP_NAME}"
    fi

    # applicationName -> APPLICATION_NAME
    if jq -e ".applicationName" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".applicationName = \"${APPLICATION_NAME}\"")
        info "  ✓ Patched applicationName: ${APPLICATION_NAME}"
    fi

    # dataFolderName -> DATA_FOLDER_NAME
    if jq -e ".dataFolderName" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".dataFolderName = \"${DATA_FOLDER_NAME}\"")
        info "  ✓ Patched dataFolderName: ${DATA_FOLDER_NAME}"
    fi

    # serverApplicationName -> SERVER_APPLICATION_NAME
    if jq -e ".serverApplicationName" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".serverApplicationName = \"${SERVER_APPLICATION_NAME}\"")
        info "  ✓ Patched serverApplicationName: ${SERVER_APPLICATION_NAME}"
    fi

    # serverDataFolderName -> SERVER_DATA_FOLDER_NAME
    if jq -e ".serverDataFolderName" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".serverDataFolderName = \"${SERVER_DATA_FOLDER_NAME}\"")
        info "  ✓ Patched serverDataFolderName: ${SERVER_DATA_FOLDER_NAME}"
    fi

    # tunnelApplicationName -> TUNNEL_APPLICATION_NAME
    if jq -e ".tunnelApplicationName" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".tunnelApplicationName = \"${TUNNEL_APPLICATION_NAME}\"")
        info "  ✓ Patched tunnelApplicationName: ${TUNNEL_APPLICATION_NAME}"
    fi

    # linuxIconName -> LINUX_ICON_NAME
    if jq -e ".linuxIconName" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".linuxIconName = \"${LINUX_ICON_NAME}\"")
        info "  ✓ Patched linuxIconName: ${LINUX_ICON_NAME}"
    fi

    # urlProtocol -> URL_PROTOCOL
    if jq -e ".urlProtocol" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".urlProtocol = \"${URL_PROTOCOL}\"")
        info "  ✓ Patched urlProtocol: ${URL_PROTOCOL}"
    fi

    # darwinBundleIdentifier -> DARWIN_BUNDLE_IDENTIFIER
    if jq -e ".darwinBundleIdentifier" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        json_content=$(echo "${json_content}" | jq ".darwinBundleIdentifier = \"${DARWIN_BUNDLE_IDENTIFIER}\"")
        info "  ✓ Patched darwinBundleIdentifier: ${DARWIN_BUNDLE_IDENTIFIER}"
    fi

    # win32* keys (if any exist)
    local win32_keys
    win32_keys=$(jq -r 'keys[]' "${PRODUCT_JSON}" | grep -E '^win32' || true)

    if [[ -n "${win32_keys}" ]]; then
        while IFS= read -r key; do
            [[ -z "${key}" ]] && continue
            # Map to appropriate value based on key type
            case "${key}" in
                win32AppUserModelId)
                    json_content=$(echo "${json_content}" | jq ".${key} = \"${WIN32_APP_USER_MODEL_ID}\"")
                    info "  ✓ Patched ${key}: ${WIN32_APP_USER_MODEL_ID}"
                    ;;
                win32MutexName)
                    # Use APPLICATION_NAME for mutex
                    json_content=$(echo "${json_content}" | jq ".${key} = \"${APPLICATION_NAME}\"")
                    info "  ✓ Patched ${key}: ${APPLICATION_NAME}"
                    ;;
                win32TunnelMutex)
                    # Use TUNNEL_APPLICATION_NAME for tunnel mutex
                    json_content=$(echo "${json_content}" | jq ".${key} = \"${TUNNEL_APPLICATION_NAME}\"")
                    info "  ✓ Patched ${key}: ${TUNNEL_APPLICATION_NAME}"
                    ;;
                win32TunnelServiceMutex)
                    # Use TUNNEL_APPLICATION_NAME for tunnel service mutex
                    json_content=$(echo "${json_content}" | jq ".${key} = \"${TUNNEL_APPLICATION_NAME}-tunnelservice\"")
                    info "  ✓ Patched ${key}: ${TUNNEL_APPLICATION_NAME}-tunnelservice"
                    ;;
                win32DirName|win32NameVersion)
                    # Use APP_NAME for directory/name
                    json_content=$(echo "${json_content}" | jq ".${key} = \"${APP_NAME}\"")
                    info "  ✓ Patched ${key}: ${APP_NAME}"
                    ;;
                win32RegValueName|win32ShellNameShort)
                    # Use APPLICATION_NAME for registry/shell
                    json_content=$(echo "${json_content}" | jq ".${key} = \"${APPLICATION_NAME^}\"")
                    info "  ✓ Patched ${key}: ${APPLICATION_NAME^}"
                    ;;
                *)
                    # Generic mapping for other win32 keys (AppIds, etc.) - keep original or use APPLICATION_NAME
                    warn "  ⚠ ${key}: keeping original value (no mapping defined)"
                    ;;
            esac
        done <<< "${win32_keys}"
    fi

    # Write result
    echo "${json_content}" | jq . > "${PRODUCT_JSON}"
    info "✓ Applied patches to product.json"
    echo ""

    # Show diff summary
    info "Summary of changes:"
    if command -v diff &> /dev/null; then
        diff -u "${backup_json}" "${PRODUCT_JSON}" | head -80 || true
    fi
}

# Handle version strategy
handle_version_strategy() {
    info "Version strategy: ${VERSION_STRATEGY}"
    echo ""

    # Check if version exists in product.json
    if jq -e ".version" "${PRODUCT_JSON}" > /dev/null 2>&1; then
        local current_version
        current_version=$(jq -r ".version" "${PRODUCT_JSON}")
        info "  Current version in product.json: ${current_version}"
    else
        warn "  No version field in product.json"
    fi

    # Check package.json version
    if [[ -f "${PROJECT_ROOT}/package.json" ]]; then
        if jq -e ".version" "${PROJECT_ROOT}/package.json" > /dev/null 2>&1; then
            local pkg_version
            pkg_version=$(jq -r ".version" "${PROJECT_ROOT}/package.json")
            info "  Version in package.json: ${pkg_version}"
        fi
    fi

    if [[ "${VERSION_STRATEGY}" == "inherit_upstream" ]]; then
        info "  ✓ Inheriting upstream version (no prerelease suffix)"
        info "  ✓ Preserves extension engine compatibility"
    fi

    echo ""
}

main() {
    echo "=== Apply Quantlab Identity ==="
    echo "Product JSON: ${PRODUCT_JSON}"
    echo "Identity Config: ${IDENTITY_CONFIG}"
    echo ""

    inspect_identity_keys
    apply_identity_patches
    handle_version_strategy

    echo ""
    info "=== Identity Application Complete ==="
    info "Backup saved to: ${PRODUCT_JSON}.backup"
    info "Run ./scripts/verify-identity.sh to verify changes"
}

main "$@"

