#!/usr/bin/env bash
# Generate Linux icons from SVG source
# Generates required PNG sizes and writes to exact filenames used by packaging

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

# Check prerequisites
check_prerequisites() {
    local missing=0

    # Check for ImageMagick (convert) or Inkscape
    if command -v convert &> /dev/null; then
        info "Using ImageMagick (convert) for icon generation"
        ICON_TOOL="convert"
    elif command -v inkscape &> /dev/null; then
        info "Using Inkscape for icon generation"
        ICON_TOOL="inkscape"
    else
        error "Neither ImageMagick (convert) nor Inkscape found"
        error "Install with: sudo apt install imagemagick (or inkscape)"
        missing=1
    fi

    # Check for SVG source
    local svg_source="${PROJECT_ROOT}/resources/quantlab-icon.svg"
    if [[ ! -f "${svg_source}" ]]; then
        error "SVG source not found: ${svg_source}"
        missing=1
    fi

    return ${missing}
}

# Generate PNG from SVG using ImageMagick
generate_png_imagemagick() {
    local svg_source="$1"
    local png_output="$2"
    local size="$3"

    convert -background none -density 300 -resize "${size}x${size}" \
        "${svg_source}" "${png_output}" 2>/dev/null
}

# Generate PNG from SVG using Inkscape
generate_png_inkscape() {
    local svg_source="$1"
    local png_output="$2"
    local size="$3"

    inkscape --export-type=png --export-filename="${png_output}" \
        --export-width="${size}" --export-height="${size}" \
        "${svg_source}" 2>/dev/null
}

# Generate icon
generate_icon() {
    local svg_source="${PROJECT_ROOT}/resources/quantlab-icon.svg"
    local icon_name="${LINUX_ICON_NAME}"
    local icon_dir="${PROJECT_ROOT}/resources/linux"

    # Ensure directory exists
    mkdir -p "${icon_dir}"

    # Target filename: build system expects code.png as source
    # It will be renamed to ${LINUX_ICON_NAME}.png during packaging
    local target_png="${icon_dir}/code.png"

    info "Generating icon: ${target_png} (will be packaged as ${icon_name}.png)"

    # Generate 1024x1024 PNG (standard Linux icon size)
    if [[ "${ICON_TOOL}" == "convert" ]]; then
        generate_png_imagemagick "${svg_source}" "${target_png}" 1024
    elif [[ "${ICON_TOOL}" == "inkscape" ]]; then
        generate_png_inkscape "${svg_source}" "${target_png}" 1024
    else
        error "Unknown icon tool: ${ICON_TOOL}"
        return 1
    fi

    if [[ -f "${target_png}" ]]; then
        info "  ✓ Generated ${target_png}"

        # Verify the file
        if command -v file &> /dev/null; then
            local file_info
            file_info=$(file "${target_png}")
            info "  ✓ ${file_info}"
        fi
        return 0
    else
        error "  ✗ Failed to generate ${target_png}"
        return 1
    fi
}

# List generated files
list_generated_files() {
    info "Generated icon files:"
    echo ""

    local icon_dir="${PROJECT_ROOT}/resources/linux"
    local target_png="${icon_dir}/code.png"

    if [[ -f "${target_png}" ]]; then
        local file_size
        file_size=$(stat -c%s "${target_png}" 2>/dev/null || stat -f%z "${target_png}" 2>/dev/null || echo "unknown")
        echo "  ${target_png} (${file_size} bytes)"
        echo "    → Will be packaged as: ${LINUX_ICON_NAME}.png"
    else
        warn "  ${target_png} not found"
    fi

    echo ""
}

main() {
    echo "=== Generate Quantlab Icons ==="
    echo "Identity config: ${IDENTITY_CONFIG}"
    echo ""

    if ! check_prerequisites; then
        exit 1
    fi

    echo ""
    generate_icon || exit 1

    echo ""
    list_generated_files

    info "=== Icon Generation Complete ==="
}

main "$@"

