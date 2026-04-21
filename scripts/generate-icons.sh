#!/bin/bash
# Generate Quantlab icons from provided PNG files
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🎨 Quantlab Icon Generator (PNG-based)"
echo "======================================"
echo ""

# Get the script directory and project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Source PNGs
TRANSPARENT_PNG="$PROJECT_ROOT/Logo/Transparent.png"
APP_LOGO_PNG="$PROJECT_ROOT/Logo/App_logo.png"

# Check if source PNGs exist
if [ ! -f "$TRANSPARENT_PNG" ]; then
    echo -e "${RED}Error: Transparent.png not found at $TRANSPARENT_PNG${NC}"
    exit 1
fi

if [ ! -f "$APP_LOGO_PNG" ]; then
    echo -e "${RED}Error: App_logo.png not found at $APP_LOGO_PNG${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Found source PNGs:"
echo "  - Transparent.png (for inside app)"
echo "  - App_logo.png (for taskbar)"

# Check for ImageMagick
if ! command -v convert &> /dev/null; then
    echo -e "${RED}✗ ImageMagick (convert) is required but not installed${NC}"
    echo ""
    echo "Please install ImageMagick:"
    echo "  Ubuntu/Debian: sudo apt-get install imagemagick"
    echo "  macOS:         brew install imagemagick"
    echo ""
    exit 1
fi

echo -e "${GREEN}✓${NC} ImageMagick is installed"
echo ""

# Create output directories if they don't exist
mkdir -p "$PROJECT_ROOT/resources/generated_icons"
mkdir -p "$PROJECT_ROOT/resources/linux"
mkdir -p "$PROJECT_ROOT/resources/win32"
mkdir -p "$PROJECT_ROOT/resources/darwin"
mkdir -p "$PROJECT_ROOT/resources/server"

echo "📦 Generating PNG icons at various sizes..."
echo "   (Using Transparent.png for in-app icons)"

# Generate PNGs at various sizes from Transparent.png (for in-app use)
SIZES=(16 32 48 70 128 150 256 512 1024)
for size in "${SIZES[@]}"; do
    output="$PROJECT_ROOT/resources/generated_icons/quantlab_${size}.png"
    echo -e "  ${YELLOW}→${NC} Generating ${size}x${size} PNG..."
    convert "$TRANSPARENT_PNG" -resize ${size}x${size} -background none -gravity center -extent ${size}x${size} "$output"
    echo -e "  ${GREEN}✓${NC} Created: quantlab_${size}.png"
done

echo ""
echo "🐧 Generating Linux icon (taskbar)..."
echo "   (Using App_logo.png for taskbar)"
# For Linux taskbar, use App_logo.png
convert "$APP_LOGO_PNG" -resize 512x512 -background none -gravity center -extent 512x512 "$PROJECT_ROOT/resources/linux/quantlab.png"
echo -e "${GREEN}✓${NC} Created: resources/linux/quantlab.png"

echo ""
echo "🪟 Generating Windows .ico file (taskbar)..."
echo "   (Using App_logo.png for taskbar)"
# For Windows taskbar, use App_logo.png resized to multiple sizes
TMP_DIR=$(mktemp -d)
for size in 16 32 48 256; do
    convert "$APP_LOGO_PNG" -resize ${size}x${size} -background none -gravity center -extent ${size}x${size} "$TMP_DIR/icon_${size}.png"
done

convert "$TMP_DIR/icon_256.png" "$TMP_DIR/icon_48.png" "$TMP_DIR/icon_32.png" "$TMP_DIR/icon_16.png" \
    "$PROJECT_ROOT/resources/win32/quantlab.ico"
echo -e "${GREEN}✓${NC} Created: resources/win32/quantlab.ico"

# Copy to generated_icons as well
cp "$PROJECT_ROOT/resources/win32/quantlab.ico" "$PROJECT_ROOT/resources/generated_icons/quantlab.ico"
rm -rf "$TMP_DIR"

echo ""
echo "🍎 Generating macOS .icns file (taskbar)..."
echo "   (Using App_logo.png for taskbar)"

# Create temporary iconset directory
ICONSET_DIR="$PROJECT_ROOT/quantlab.iconset"
mkdir -p "$ICONSET_DIR"

# Generate icon sizes for macOS from App_logo.png
convert "$APP_LOGO_PNG" -resize 16x16 "$ICONSET_DIR/icon_16x16.png"
convert "$APP_LOGO_PNG" -resize 32x32 "$ICONSET_DIR/icon_16x16@2x.png"
convert "$APP_LOGO_PNG" -resize 32x32 "$ICONSET_DIR/icon_32x32.png"
convert "$APP_LOGO_PNG" -resize 64x64 "$ICONSET_DIR/icon_32x32@2x.png"
convert "$APP_LOGO_PNG" -resize 128x128 "$ICONSET_DIR/icon_128x128.png"
convert "$APP_LOGO_PNG" -resize 256x256 "$ICONSET_DIR/icon_128x128@2x.png"
convert "$APP_LOGO_PNG" -resize 256x256 "$ICONSET_DIR/icon_256x256.png"
convert "$APP_LOGO_PNG" -resize 512x512 "$ICONSET_DIR/icon_256x256@2x.png"
convert "$APP_LOGO_PNG" -resize 512x512 "$ICONSET_DIR/icon_512x512.png"
convert "$APP_LOGO_PNG" -resize 1024x1024 "$ICONSET_DIR/icon_512x512@2x.png"

# Check if we're on macOS and can use iconutil
if [[ "$OSTYPE" == "darwin"* ]] && command -v iconutil &> /dev/null; then
    iconutil -c icns "$ICONSET_DIR" -o "$PROJECT_ROOT/resources/darwin/quantlab.icns"
    echo -e "${GREEN}✓${NC} Created: resources/darwin/quantlab.icns (using iconutil)"
else
    # Try using png2icns if available (works on Linux)
    if command -v png2icns &> /dev/null; then
        png2icns "$PROJECT_ROOT/resources/darwin/quantlab.icns" \
            "$ICONSET_DIR/icon_16x16.png" \
            "$ICONSET_DIR/icon_32x32.png" \
            "$ICONSET_DIR/icon_128x128.png" \
            "$ICONSET_DIR/icon_256x256.png" \
            "$ICONSET_DIR/icon_512x512.png"
        echo -e "${GREEN}✓${NC} Created: resources/darwin/quantlab.icns (using png2icns)"
    else
        # Use ImageMagick as fallback (creates a basic .icns)
        convert "$ICONSET_DIR/icon_512x512@2x.png" \
                "$ICONSET_DIR/icon_512x512.png" \
                "$ICONSET_DIR/icon_256x256@2x.png" \
                "$ICONSET_DIR/icon_256x256.png" \
                "$ICONSET_DIR/icon_128x128@2x.png" \
                "$ICONSET_DIR/icon_128x128.png" \
                "$ICONSET_DIR/icon_32x32@2x.png" \
                "$ICONSET_DIR/icon_32x32.png" \
                "$ICONSET_DIR/icon_16x16@2x.png" \
                "$ICONSET_DIR/icon_16x16.png" \
                "$PROJECT_ROOT/resources/darwin/quantlab.icns"
        echo -e "${GREEN}✓${NC} Created: resources/darwin/quantlab.icns (using ImageMagick)"
    fi
fi

# Clean up iconset directory
rm -rf "$ICONSET_DIR"

echo ""
echo "🌐 Generating server/web icons..."
echo "   (Using Transparent.png for web icons)"
# For server/web, use Transparent.png
convert "$TRANSPARENT_PNG" -resize 192x192 -background none -gravity center -extent 192x192 "$PROJECT_ROOT/resources/server/quantlab-192.png"
echo -e "${GREEN}✓${NC} Created: resources/server/quantlab-192.png"

convert "$TRANSPARENT_PNG" -resize 512x512 -background none -gravity center -extent 512x512 "$PROJECT_ROOT/resources/server/quantlab-512.png"
echo -e "${GREEN}✓${NC} Created: resources/server/quantlab-512.png"

# Generate favicon.ico for web (using App_logo.png for consistency with taskbar)
echo ""
echo "🌐 Generating favicon.ico (taskbar style)..."
TMP_DIR=$(mktemp -d)
convert "$APP_LOGO_PNG" -resize 48x48 "$TMP_DIR/favicon_48.png"
convert "$APP_LOGO_PNG" -resize 32x32 "$TMP_DIR/favicon_32.png"
convert "$APP_LOGO_PNG" -resize 16x16 "$TMP_DIR/favicon_16.png"

convert "$TMP_DIR/favicon_48.png" "$TMP_DIR/favicon_32.png" "$TMP_DIR/favicon_16.png" \
    "$PROJECT_ROOT/resources/server/favicon.ico"
rm -rf "$TMP_DIR"
echo -e "${GREEN}✓${NC} Created: resources/server/favicon.ico"

echo ""
echo "🎯 Generating Windows taskbar icons..."
# Additional Windows-specific sizes using App_logo.png
convert "$APP_LOGO_PNG" -resize 70x70 -background none -gravity center -extent 70x70 "$PROJECT_ROOT/resources/win32/quantlab_70x70.png"
echo -e "${GREEN}✓${NC} Created: resources/win32/quantlab_70x70.png"

convert "$APP_LOGO_PNG" -resize 150x150 -background none -gravity center -extent 150x150 "$PROJECT_ROOT/resources/win32/quantlab_150x150.png"
echo -e "${GREEN}✓${NC} Created: resources/win32/quantlab_150x150.png"

convert "$APP_LOGO_PNG" -resize 256x256 -background none -gravity center -extent 256x256 "$PROJECT_ROOT/resources/win32/quantlab_256.png"
echo -e "${GREEN}✓${NC} Created: resources/win32/quantlab_256.png"

echo ""
echo -e "${GREEN}✅ Icon generation complete!${NC}"
echo ""
echo "Generated files:"
echo "  📱 In-app icons (Transparent.png):"
echo "     • PNG icons: resources/generated_icons/quantlab_*.png"
echo "     • Server icons: resources/server/quantlab-*.png"
echo ""
echo "  🖥️  Taskbar/OS icons (App_logo.png):"
echo "     • Linux: resources/linux/quantlab.png"
echo "     • Windows: resources/win32/quantlab.ico"
echo "     • macOS: resources/darwin/quantlab.icns"
echo "     • Favicon: resources/server/favicon.ico"
echo ""
echo "Next steps:"
echo "  1. Rebuild the application: npm run compile"
echo "  2. Test the application to verify logos appear correctly"
echo "     - Taskbar should show App_logo.png (with background)"
echo "     - In-app UI should show Transparent.png (transparent)"
