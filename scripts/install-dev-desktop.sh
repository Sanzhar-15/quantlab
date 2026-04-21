#!/usr/bin/env bash

# Install a .desktop file for Quantlab development mode
# This enables the taskbar icon to display correctly when running from source

set -e

# Determine the root of the Quantlab repository
if [[ "$OSTYPE" == "darwin"* ]]; then
	echo "This script is for Linux only"
	exit 1
fi

ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")

# Verify we're in the right directory
if [ ! -f "$ROOT/product.json" ]; then
	echo "Error: product.json not found. Are you in the Quantlab repository?"
	exit 1
fi

# Check for the icon
ICON_PATH="$ROOT/resources/linux/quantlab.png"
if [ ! -f "$ICON_PATH" ]; then
	echo "Error: Icon not found at $ICON_PATH"
	exit 1
fi

# Create the .desktop file
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

DESKTOP_FILE="$DESKTOP_DIR/quantlab-dev.desktop"

cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=Quantlab (Dev)
Comment=Quantlab Development Build
GenericName=Trading Platform
Exec=env CHROME_DESKTOP=quantlab-dev.desktop bash $ROOT/scripts/code.sh %F
Icon=$ICON_PATH
Type=Application
StartupNotify=false
StartupWMClass=Quantlab
Categories=Development;Finance;
Keywords=quantlab;trading;finance;
Actions=new-empty-window;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=env CHROME_DESKTOP=quantlab-dev.desktop bash $ROOT/scripts/code.sh --new-window %F
Icon=$ICON_PATH
EOF

echo "Installed $DESKTOP_FILE"
echo ""
echo "To see the taskbar icon:"
echo "  1. Log out and log back in, OR"
echo "  2. Run: update-desktop-database $DESKTOP_DIR"
echo ""
echo "If the icon still doesn't show:"
echo "  - Some desktop environments cache icons. Try restarting the DE."
echo "  - Make sure Quantlab is started via ./scripts/code.sh"
