#!/usr/bin/env bash
# Verify that product identity matches quantlab.identity.env
# Validates all corresponding keys in product.json (only those that exist)
# Runs print-version.sh and prints expected Linux paths

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IDENTITY_CONFIG="${PROJECT_ROOT}/config/quantlab.identity.env"

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

# Verify a key in product.json matches expected value
verify_key() {
    local key="$1"
    local expected="$2"
    local description="$3"
    local product_json="${PROJECT_ROOT}/product.json"

    if [[ ! -f "${product_json}" ]]; then
        warn "product.json not found - skipping ${description}"
        return 0
    fi

    # Check if key exists
    if ! jq -e ".${key}" "${product_json}" > /dev/null 2>&1; then
        warn "Key '${key}' not present in product.json - skipping ${description}"
        return 0
    fi

    # Get actual value
    local actual
    actual=$(jq -r ".${key}" "${product_json}")

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

# Verify version script
verify_version() {
    local version_script="${PROJECT_ROOT}/scripts/print-version.sh"

    if [[ ! -f "${version_script}" ]]; then
        error "scripts/print-version.sh not found"
        return 1
    fi

    if [[ ! -x "${version_script}" ]]; then
        error "scripts/print-version.sh is not executable"
        return 1
    fi

    info "Running version check..."
    local version
    if version=$("${version_script}" 2>&1); then
        if [[ -n "${version}" ]]; then
            info "✓ Version: ${version}"
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

# Print expected Linux paths
print_linux_paths() {
    local product_json="${PROJECT_ROOT}/product.json"

    if [[ ! -f "${product_json}" ]]; then
        warn "product.json not found - cannot determine paths"
        return 0
    fi

    info "Expected Linux paths (for manual verification):"
    echo ""

    # Get dataFolderName from product.json (preferred) or config
    local data_folder
    if jq -e ".dataFolderName" "${product_json}" > /dev/null 2>&1; then
        data_folder=$(jq -r ".dataFolderName" "${product_json}")
    else
        data_folder="${DATA_FOLDER_NAME}"
    fi

    # Get serverDataFolderName from product.json (preferred) or config
    local server_data_folder
    if jq -e ".serverDataFolderName" "${product_json}" > /dev/null 2>&1; then
        server_data_folder=$(jq -r ".serverDataFolderName" "${product_json}")
    else
        server_data_folder="${SERVER_DATA_FOLDER_NAME}"
    fi

    # Settings/config directory (typically ~/.config/<app-name>)
    local config_dir="${HOME}/.config/${APPLICATION_NAME}"

    echo "  Settings/Config: ${config_dir}"
    # data_folder should already have the dot prefix (e.g., .quantlab)
    # Handle path concatenation: if starts with ., use ${HOME}/.${folder#.} to get proper path
    if [[ "${data_folder}" == .* ]]; then
        echo "  Extensions/Data: ${HOME}/.${data_folder#.}"
    else
        echo "  Extensions/Data: ${HOME}/.${data_folder}"
    fi
    if [[ "${server_data_folder}" == .* ]]; then
        echo "  Server Data: ${HOME}/.${server_data_folder#.}"
    else
        echo "  Server Data: ${HOME}/.${server_data_folder}"
    fi
    echo ""
}

main() {
    echo "Verifying Quantlab identity configuration..."
    echo "Identity config: ${IDENTITY_CONFIG}"
    echo ""

    local errors=0

    # Verify standard identity keys (only if they exist)
    verify_key "nameShort" "${APP_NAME}" "nameShort" || errors=$((errors + 1))
    verify_key "nameLong" "${APP_NAME}" "nameLong" || errors=$((errors + 1))
    verify_key "applicationName" "${APPLICATION_NAME}" "applicationName" || errors=$((errors + 1))
    verify_key "dataFolderName" "${DATA_FOLDER_NAME}" "dataFolderName" || errors=$((errors + 1))
    verify_key "serverApplicationName" "${SERVER_APPLICATION_NAME}" "serverApplicationName" || errors=$((errors + 1))
    verify_key "serverDataFolderName" "${SERVER_DATA_FOLDER_NAME}" "serverDataFolderName" || errors=$((errors + 1))
    verify_key "tunnelApplicationName" "${TUNNEL_APPLICATION_NAME}" "tunnelApplicationName" || errors=$((errors + 1))
    verify_key "linuxIconName" "${LINUX_ICON_NAME}" "linuxIconName" || errors=$((errors + 1))
    verify_key "urlProtocol" "${URL_PROTOCOL}" "urlProtocol" || errors=$((errors + 1))
    verify_key "darwinBundleIdentifier" "${DARWIN_BUNDLE_IDENTIFIER}" "darwinBundleIdentifier" || errors=$((errors + 1))

    # Verify win32AppUserModelId
    verify_key "win32AppUserModelId" "${WIN32_APP_USER_MODEL_ID}" "win32AppUserModelId" || errors=$((errors + 1))

    echo ""

    # Verify version
    verify_version || errors=$((errors + 1))

    echo ""

    # Print expected Linux paths
    print_linux_paths

    if [[ ${errors} -eq 0 ]]; then
        info "All identity verifications passed!"
        return 0
    else
        error "${errors} verification(s) failed"
        return 1
    fi
}

main "$@"

