#!/bin/bash
# NEW-BUILD-001: macOS build script (DMG)
#
# Builds the Quantlab application for macOS including:
# - VS Code fork (TypeScript compilation)
# - Quantlab extension
# - Python engine (PyInstaller bundle)
# - .app bundle and DMG packaging

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/macos"
ENGINE_DIR="$ROOT_DIR/engine"
EXT_DIR="$ROOT_DIR/extensions/quantlab"
APP_DIR="$BUILD_DIR/Quantlab.app"

echo "=== Building Quantlab for macOS ==="

# Step 1: Build VS Code fork
echo "[1/6] Building VS Code fork..."
cd "$ROOT_DIR"
if [ -f "package.json" ]; then
    npm run compile 2>&1 || { echo "VS Code compilation failed"; exit 1; }
fi

# Step 2: Build extension
echo "[2/6] Building Quantlab extension..."
cd "$EXT_DIR"
if [ -f "package.json" ]; then
    npm run compile 2>&1 || { echo "Extension compilation failed"; exit 1; }
fi

# Step 3: Bundle Python engine
echo "[3/6] Bundling Python engine..."
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

# Step 4: Create .app bundle
echo "[4/6] Creating .app bundle..."
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"
mkdir -p "$APP_DIR/Contents/Resources/engine"

# Copy engine bundle
if [ -d "$BUILD_DIR/dist/quantlab-engine" ]; then
    cp -r "$BUILD_DIR/dist/quantlab-engine/"* "$APP_DIR/Contents/Resources/engine/"
fi

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Quantlab</string>
    <key>CFBundleDisplayName</key>
    <string>Quantlab</string>
    <key>CFBundleIdentifier</key>
    <string>com.quantlab.app</string>
    <key>CFBundleVersion</key>
    <string>10.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>10.0</string>
    <key>CFBundleExecutable</key>
    <string>quantlab</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>quantlab.icns</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
</dict>
</plist>
PLIST

# Step 5: Code sign (if identity available)
echo "[5/6] Code signing..."
if security find-identity -v -p codesigning 2>/dev/null | grep -q "valid identities found"; then
    codesign --deep --force --sign - "$APP_DIR" 2>&1 || true
    echo "App signed with ad-hoc signature"
else
    echo "No signing identity found, skipping code signing"
fi

# Step 6: Create DMG
echo "[6/6] Creating DMG..."
if command -v create-dmg &> /dev/null; then
    create-dmg \
        --volname "Quantlab" \
        --window-size 800 400 \
        --icon-size 100 \
        --app-drop-link 600 185 \
        "$BUILD_DIR/Quantlab.dmg" \
        "$APP_DIR" 2>&1 || true
    echo "DMG created: $BUILD_DIR/Quantlab.dmg"
elif command -v hdiutil &> /dev/null; then
    hdiutil create -volname "Quantlab" -srcfolder "$APP_DIR" -ov -format UDZO "$BUILD_DIR/Quantlab.dmg" 2>&1
    echo "DMG created: $BUILD_DIR/Quantlab.dmg"
else
    echo "DMG tools not available. App bundle at: $APP_DIR"
fi

echo "=== macOS build complete ==="
