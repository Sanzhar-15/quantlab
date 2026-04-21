#!/bin/bash
# NEW-BUILD-001: Linux build script (AppImage)
#
# Builds the Quantlab application for Linux including:
# - VS Code fork (TypeScript compilation)
# - Quantlab extension
# - Python engine (PyInstaller bundle)
# - AppImage packaging

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/linux"
ENGINE_DIR="$ROOT_DIR/engine"
EXT_DIR="$ROOT_DIR/extensions/quantlab"

echo "=== Building Quantlab for Linux ==="

# Step 1: Build VS Code fork
echo "[1/5] Building VS Code fork..."
cd "$ROOT_DIR"
if [ -f "package.json" ]; then
    npm run compile 2>&1 || { echo "VS Code compilation failed"; exit 1; }
fi

# Step 2: Build extension
echo "[2/5] Building Quantlab extension..."
cd "$EXT_DIR"
if [ -f "package.json" ]; then
    npm run compile 2>&1 || { echo "Extension compilation failed"; exit 1; }
fi

# Step 3: Bundle Python engine
echo "[3/5] Bundling Python engine..."
cd "$ENGINE_DIR"
if [ -f "pyproject.toml" ]; then
    python3 -m pip install --quiet pyinstaller 2>&1
    python3 -m PyInstaller \
        --name quantlab-engine \
        --onedir \
        --noconfirm \
        --distpath "$BUILD_DIR/dist" \
        --hidden-import quantlab \
        --hidden-import quantlab.daemon \
        --hidden-import quantlab.daemon.main \
        --hidden-import quantlab.backtest \
        --hidden-import quantlab.backtest.core \
        --hidden-import quantlab.providers \
        --hidden-import quantlab.risk \
        --hidden-import quantlab.trading \
        --hidden-import quantlab.metrics \
        --hidden-import quantlab.data \
        quantlab/daemon/__main__.py 2>&1
fi

# Step 4: Create AppImage structure
echo "[4/5] Creating AppImage structure..."
mkdir -p "$BUILD_DIR/AppDir/usr/bin"
mkdir -p "$BUILD_DIR/AppDir/usr/lib/quantlab"
mkdir -p "$BUILD_DIR/AppDir/usr/share/applications"
mkdir -p "$BUILD_DIR/AppDir/usr/share/icons/hicolor/256x256/apps"

# Copy engine bundle
if [ -d "$BUILD_DIR/dist/quantlab-engine" ]; then
    cp -r "$BUILD_DIR/dist/quantlab-engine/"* "$BUILD_DIR/AppDir/usr/lib/quantlab/"
    ln -sf "../lib/quantlab/quantlab-engine" "$BUILD_DIR/AppDir/usr/bin/quantlab-engine"
fi

# Create desktop entry
cat > "$BUILD_DIR/AppDir/quantlab.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Quantlab
Comment=Quantitative Trading Platform
Exec=quantlab
Icon=quantlab
Type=Application
Categories=Finance;Development;Science;
StartupWMClass=quantlab
DESKTOP

cp "$BUILD_DIR/AppDir/quantlab.desktop" "$BUILD_DIR/AppDir/usr/share/applications/"

# Create AppRun
cat > "$BUILD_DIR/AppDir/AppRun" << 'APPRUN'
#!/bin/bash
APPDIR="$(dirname "$(readlink -f "$0")")"
export PATH="$APPDIR/usr/bin:$PATH"
export LD_LIBRARY_PATH="$APPDIR/usr/lib:$LD_LIBRARY_PATH"
exec "$APPDIR/usr/bin/quantlab" "$@"
APPRUN
chmod +x "$BUILD_DIR/AppDir/AppRun"

# Step 5: Build AppImage
echo "[5/5] Building AppImage..."
if command -v appimagetool &> /dev/null; then
    ARCH="$(uname -m)" appimagetool "$BUILD_DIR/AppDir" "$BUILD_DIR/Quantlab-$(uname -m).AppImage"
    echo "AppImage created: $BUILD_DIR/Quantlab-$(uname -m).AppImage"
else
    echo "appimagetool not found. AppDir created at: $BUILD_DIR/AppDir"
    echo "Install from: https://github.com/AppImage/AppImageKit/releases"
fi

echo "=== Linux build complete ==="
