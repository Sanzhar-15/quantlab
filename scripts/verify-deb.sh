#!/usr/bin/env bash
# Verify Debian package contains Quantlab branding and no Microsoft references
# Exits non-zero on any mismatch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

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

# Find the latest .deb file
DEB_FILE=$(find "${PROJECT_ROOT}/.build/linux/deb" -name "*.deb" -type f 2>/dev/null | sort | tail -1)

if [[ -z "${DEB_FILE}" ]]; then
    error "No .deb file found in .build/linux/deb/"
    exit 1
fi

info "Found .deb file: ${DEB_FILE}"
echo ""

# Check if dpkg-deb is available
if ! command -v dpkg-deb &> /dev/null; then
    error "dpkg-deb is required for verification"
    exit 1
fi

# Extract to temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf ${TEMP_DIR}" EXIT

info "Extracting .deb contents..."
dpkg-deb -x "${DEB_FILE}" "${TEMP_DIR}/extracted" > /dev/null 2>&1
dpkg-deb -e "${DEB_FILE}" "${TEMP_DIR}/control" > /dev/null 2>&1

# Check DEBIAN directory exists
DEBIAN_DIR="${TEMP_DIR}/control"
if [[ ! -d "${DEBIAN_DIR}" ]]; then
    error "DEBIAN directory not found in .deb"
    exit 1
fi

info "Checking DEBIAN scripts and templates for forbidden strings..."
echo ""

# Forbidden strings to check
FORBIDDEN_STRINGS=(
    "Microsoft repository"
    "packages.microsoft.com"
    "Visual Studio Code"
    "vscode-linux@microsoft.com"
    "code.visualstudio.com"
)

ERRORS=0

# Check all DEBIAN files
for file in "${DEBIAN_DIR}"/*; do
    if [[ -f "${file}" ]]; then
        filename=$(basename "${file}")
        for forbidden in "${FORBIDDEN_STRINGS[@]}"; do
            if grep -qi "${forbidden}" "${file}" 2>/dev/null; then
                error "Found forbidden string '${forbidden}' in DEBIAN/${filename}"
                grep -i "${forbidden}" "${file}" | head -3 | sed 's/^/  /'
                ERRORS=$((ERRORS + 1))
            fi
        done
    fi
done

# Check if payload contains /usr/share/quantlab/
info "Checking .deb payload contains /usr/share/quantlab/..."
if [[ ! -d "${TEMP_DIR}/extracted/usr/share/quantlab" ]]; then
    error "DEB payload does not contain /usr/share/quantlab/ (control-only deb)"
    ERRORS=$((ERRORS + 1))
else
    info "  ✓ Found /usr/share/quantlab/ in payload"
fi

# Show package info
echo ""
info "Package information:"
dpkg-deb -I "${DEB_FILE}" 2>/dev/null | grep -E "Package|Version|Maintainer|Homepage|Description" | head -5 | sed 's/^/  /'

echo ""
if [[ ${ERRORS} -eq 0 ]]; then
    info "=== PASS: All verification checks passed ==="
    exit 0
else
    error "=== FAIL: ${ERRORS} verification error(s) found ==="
    exit 1
fi

