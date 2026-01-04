#!/usr/bin/env bash
# Print version string for Quantlab
# Discovery-first: tries multiple methods to determine version
# Exits 0 with version string, or non-zero if cannot determine
# Does NOT require GUI

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Try to get version from CLI entrypoints
try_cli_version() {
    local entrypoint="$1"
    local version_flag="${2:---version}"

    if [[ ! -f "${entrypoint}" ]]; then
        return 1
    fi

    # Try to run with --version flag (non-interactive, no GUI)
    # Use timeout to prevent hanging, redirect stderr to avoid noise
    if timeout 5 "${entrypoint}" "${version_flag}" 2>/dev/null | head -1; then
        return 0
    fi

    return 1
}

# Try to get version from package.json
try_package_json_version() {
    local pkg_json="${PROJECT_ROOT}/package.json"

    if [[ ! -f "${pkg_json}" ]]; then
        return 1
    fi

    # Use jq if available
    if command -v jq &> /dev/null; then
        local version
        version=$(jq -r '.version // empty' "${pkg_json}" 2>/dev/null)
        if [[ -n "${version}" && "${version}" != "null" ]]; then
            echo "${version}"
            return 0
        fi
    fi

    # Fallback to grep/sed
    local version
    version=$(grep -E '"version"\s*:' "${pkg_json}" 2>/dev/null | head -1 | sed -E 's/.*"version"\s*:\s*"([^"]+)".*/\1/' || true)
    if [[ -n "${version}" ]]; then
        echo "${version}"
        return 0
    fi

    return 1
}

main() {
    local version=""

    # Method 1: Try scripts/code-cli.sh --version
    if version=$(try_cli_version "${PROJECT_ROOT}/scripts/code-cli.sh" "--version" 2>/dev/null); then
        # Extract just the version number (first line, first field)
        echo "${version}" | head -1 | awk '{print $1}' | tr -d '\n'
        return 0
    fi

    # Method 2: Try node out/vs/code/node/cli.js --version (preferred, non-GUI)
    if [[ -f "${PROJECT_ROOT}/out/vs/code/node/cli.js" ]]; then
        if command -v node &> /dev/null; then
            if version=$(timeout 5 node "${PROJECT_ROOT}/out/vs/code/node/cli.js" --version 2>/dev/null | head -1); then
                if [[ -n "${version}" ]]; then
                    # Extract just the version number (first line, first field)
                    echo "${version}" | head -1 | awk '{print $1}' | tr -d '\n'
                    return 0
                fi
            fi
        fi
    fi

    # Method 3: Try out/cli.js (if exists)
    if [[ -f "${PROJECT_ROOT}/out/cli.js" ]]; then
        if command -v node &> /dev/null; then
            if version=$(timeout 5 node "${PROJECT_ROOT}/out/cli.js" --version 2>/dev/null | head -1); then
                if [[ -n "${version}" ]]; then
                    echo "${version}" | head -1 | awk '{print $1}' | tr -d '\n'
                    return 0
                fi
            fi
        fi
    fi

    # Method 4: Try package.json version (fallback)
    if version=$(try_package_json_version 2>/dev/null); then
        echo "${version}"
        return 0
    fi

    # All methods failed
    echo "ERROR: Cannot determine version" >&2
    echo "Tried:" >&2
    echo "  - scripts/code-cli.sh --version" >&2
    echo "  - node out/vs/code/node/cli.js --version" >&2
    echo "  - node out/cli.js --version" >&2
    echo "  - package.json version field" >&2
    return 1
}

main "$@"

