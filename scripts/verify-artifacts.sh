#!/usr/bin/env bash
# Verify packaging artifacts contain Quantlab identity
# Checks Linux artifacts (tar/dir and deb packages)

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

# Verify product.json in artifact
verify_artifact_product_json() {
    local artifact_path="$1"
    local description="$2"

    info "Verifying product.json in ${description}..."

    local product_json="${artifact_path}/product.json"
    if [[ ! -f "${product_json}" ]]; then
        error "product.json not found in ${description}: ${product_json}"
        return 1
    fi

    # Verify it's valid JSON
    if ! jq empty "${product_json}" 2>/dev/null; then
        error "product.json is not valid JSON in ${description}"
        return 1
    fi

    # Check key identity fields
    local errors=0

    if jq -e ".nameShort" "${product_json}" > /dev/null 2>&1; then
        local name_short
        name_short=$(jq -r '.nameShort' "${product_json}")
        if [[ "${name_short}" == "${APP_NAME}" ]]; then
            info "  ✓ nameShort: ${name_short}"
        else
            error "  ✗ nameShort mismatch: expected ${APP_NAME}, got ${name_short}"
            errors=$((errors + 1))
        fi
    fi

    if jq -e ".applicationName" "${product_json}" > /dev/null 2>&1; then
        local app_name
        app_name=$(jq -r '.applicationName' "${product_json}")
        if [[ "${app_name}" == "${APPLICATION_NAME}" ]]; then
            info "  ✓ applicationName: ${app_name}"
        else
            error "  ✗ applicationName mismatch: expected ${APPLICATION_NAME}, got ${app_name}"
            errors=$((errors + 1))
        fi
    fi

    if jq -e ".linuxIconName" "${product_json}" > /dev/null 2>&1; then
        local icon_name
        icon_name=$(jq -r '.linuxIconName' "${product_json}")
        if [[ "${icon_name}" == "${LINUX_ICON_NAME}" ]]; then
            info "  ✓ linuxIconName: ${icon_name}"
        else
            error "  ✗ linuxIconName mismatch: expected ${LINUX_ICON_NAME}, got ${icon_name}"
            errors=$((errors + 1))
        fi
    fi

    echo ""
    return ${errors}
}

# Verify deb package contents
verify_deb_package() {
    local deb_file="$1"

    info "Verifying deb package: ${deb_file}"
    echo ""

    if [[ ! -f "${deb_file}" ]]; then
        error "Deb package not found: ${deb_file}"
        return 1
    fi

    # Check if dpkg is available for inspection
    if ! command -v dpkg-deb &> /dev/null; then
        warn "dpkg-deb not available - skipping detailed deb verification"
        info "  ✓ Deb package exists: ${deb_file}"
        return 0
    fi

    # Extract to temp directory for inspection
    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf ${temp_dir}" EXIT

    # Extract deb contents
    if ! dpkg-deb -x "${deb_file}" "${temp_dir}" 2>/dev/null; then
        error "Failed to extract deb package"
        return 1
    fi

    info "  ✓ Deb package extracted successfully"

    # Check for desktop files
    local desktop_files
    desktop_files=$(find "${temp_dir}" -name "*.desktop" 2>/dev/null || true)

    if [[ -z "${desktop_files}" ]]; then
        error "  ✗ No desktop files found in deb package"
        return 1
    fi

    local found_main=0
    local found_url_handler=0

    while IFS= read -r desktop_file; do
        if [[ -z "${desktop_file}" ]]; then
            continue
        fi

        info "  Found desktop file: ${desktop_file}"

        # Check if it references Quantlab
        if grep -q "${APPLICATION_NAME}" "${desktop_file}" 2>/dev/null; then
            info "    ✓ Contains ${APPLICATION_NAME}"
        fi

        if grep -q "${APP_NAME}" "${desktop_file}" 2>/dev/null; then
            info "    ✓ Contains ${APP_NAME}"
        fi

        # Check icon reference
        if grep -q "Icon=${LINUX_ICON_NAME}" "${desktop_file}" 2>/dev/null; then
            info "    ✓ Icon references ${LINUX_ICON_NAME}"
        fi

        # Identify file type
        if grep -q "URL Handler" "${desktop_file}" 2>/dev/null; then
            found_url_handler=1
            info "    → URL handler desktop file"
        else
            found_main=1
            info "    → Main launcher desktop file"
        fi
    done <<< "${desktop_files}"

    if [[ ${found_main} -eq 0 ]]; then
        warn "  ⚠ Main launcher desktop file not found"
    fi

    if [[ ${found_url_handler} -eq 0 ]]; then
        warn "  ⚠ URL handler desktop file not found"
    fi

    # Check for icon files
    local icon_files
    icon_files=$(find "${temp_dir}" -name "${LINUX_ICON_NAME}.png" -o -name "code.png" 2>/dev/null || true)

    if [[ -z "${icon_files}" ]]; then
        warn "  ⚠ Icon files not found in deb package"
    else
        while IFS= read -r icon_file; do
            if [[ -n "${icon_file}" ]]; then
                info "  Found icon: ${icon_file}"
            fi
        done <<< "${icon_files}"
    fi

    echo ""
    return 0
}

main() {
    echo "Verifying Quantlab packaging artifacts..."
    echo "Identity config: ${IDENTITY_CONFIG}"
    echo ""

    local errors=0
    local artifacts_found=0

    # Check for Linux directory artifact
    local linux_dir="VSCode-linux-x64"
    if [[ -d "${PROJECT_ROOT}/${linux_dir}" ]]; then
        artifacts_found=1
        info "Found Linux directory artifact: ${linux_dir}"
        verify_artifact_product_json "${PROJECT_ROOT}/${linux_dir}" "${linux_dir}" || errors=$((errors + 1))
    else
        warn "Linux directory artifact not found: ${linux_dir}"
        warn "  Run: npm run gulp vscode-linux-x64 (requires compilation)"
    fi

    # Check for deb packages
    local deb_files
    deb_files=$(find "${PROJECT_ROOT}/.build/linux/deb" -name "*.deb" 2>/dev/null || true)

    if [[ -n "${deb_files}" ]]; then
        artifacts_found=1
        while IFS= read -r deb_file; do
            if [[ -n "${deb_file}" ]]; then
                verify_deb_package "${deb_file}" || errors=$((errors + 1))
            fi
        done <<< "${deb_files}"
    else
        warn "Deb packages not found in .build/linux/deb/"
        warn "  Run: npm run gulp vscode-linux-x64-prepare-deb && npm run gulp vscode-linux-x64-build-deb"
    fi

    echo ""
    if [[ ${artifacts_found} -eq 0 ]]; then
        warn "No artifacts found to verify"
        warn "Build artifacts first using the gulp tasks documented in docs/release/artifacts.md"
        return 0  # Don't fail if no artifacts exist yet
    elif [[ ${errors} -eq 0 ]]; then
        info "All artifact verifications passed!"
        return 0
    else
        error "${errors} verification(s) failed"
        return 1
    fi
}

main "$@"

