#!/usr/bin/env bash
# Preflight checks for Quantlab base distribution
# Prints environment and configuration information

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Quantlab Preflight Report ==="
echo "Project root: ${PROJECT_ROOT}"
echo ""

echo "--- Git Remote ---"
if git remote -v 2>/dev/null; then
    echo ""
else
    echo "Not a git repository or no remotes configured"
    echo ""
fi

echo "--- Git Status ---"
if git status --porcelain 2>/dev/null; then
    echo ""
else
    echo "Not a git repository or working tree clean"
    echo ""
fi

echo "--- System Information ---"
uname -a
echo ""

echo "--- Node.js Versions ---"
if command -v node &> /dev/null; then
    node --version
else
    echo "node: not found"
fi
if command -v npm &> /dev/null; then
    npm --version
else
    echo "npm: not found"
fi
echo ""

echo "--- Python Version ---"
if command -v python &> /dev/null; then
    python --version
elif command -v python3 &> /dev/null; then
    python3 --version
else
    echo "python: not found"
fi
echo ""

echo "--- Disk Usage ---"
df -h .
echo ""

echo "--- Node Version Manager (if .nvmrc exists) ---"
if [[ -f "${PROJECT_ROOT}/.nvmrc" ]]; then
    cat "${PROJECT_ROOT}/.nvmrc"
else
    echo ".nvmrc not found"
fi
echo ""

echo "--- Scripts Directory ---"
ls -la "${PROJECT_ROOT}/scripts/" 2>/dev/null || echo "scripts/ directory not found"
echo ""

echo "--- Identity Configuration ---"
if [[ -f "${PROJECT_ROOT}/config/quantlab.identity.env" ]]; then
    cat "${PROJECT_ROOT}/config/quantlab.identity.env"
else
    echo "config/quantlab.identity.env not found"
fi
echo ""

echo "--- Product Configuration (product.json) ---"
PRODUCT_JSON="${PROJECT_ROOT}/product.json"
if [[ -f "${PRODUCT_JSON}" ]]; then
    echo "product.json exists"
    echo ""

    # Extract and print relevant keys in compact format
    # Using jq if available, otherwise fallback to grep/sed
    if command -v jq &> /dev/null; then
        echo "Relevant keys:"
        jq -c '{
            nameShort,
            nameLong,
            applicationName,
            dataFolderName,
            linuxIconName,
            urlProtocol,
            serverApplicationName,
            serverDataFolderName,
            tunnelApplicationName,
            extensionsGallery: (.extensionsGallery.serviceUrl // "not present"),
            linkProtectionTrustedDomains: (.linkProtectionTrustedDomains // "not present"),
            updateUrl: (.updateUrl // "not present"),
            telemetry: (.telemetry // "not present"),
            link: (.link // "not present")
        }' "${PRODUCT_JSON}" 2>/dev/null || echo "Error parsing product.json with jq"
    else
        echo "Relevant keys (jq not available, showing raw extract):"
        # Fallback: try to extract key lines
        grep -E '(nameShort|nameLong|applicationName|dataFolderName|linuxIconName|urlProtocol|serverApplicationName|serverDataFolderName|tunnelApplicationName|extensionsGallery|linkProtectionTrustedDomains|updateUrl|telemetry|link)' "${PRODUCT_JSON}" 2>/dev/null | head -20 || echo "Could not extract keys"
    fi
else
    echo "product.json not found"
fi
echo ""

echo "=== End Preflight Report ==="

