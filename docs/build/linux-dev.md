# Linux Development Build Guide

This guide covers building and running Quantlab on Linux for development purposes.

## Prerequisites

### Node.js

Quantlab requires Node.js version **22.21.1** (specified in `.nvmrc`).

**Using nvm (recommended):**
```bash
nvm install
nvm use
```

**Or install manually:**
- Download from [nodejs.org](https://nodejs.org/)
- Ensure `node --version` outputs `v22.21.1`

### System Dependencies

Install required system packages for building native modules:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  libx11-dev \
  libx11-xcb-dev \
  libxkbfile-dev \
  libsecret-1-dev \
  libnotify-bin \
  libkrb5-dev \
  libgtk-3-0 \
  libgbm1
```

**For DEB packaging (optional):**
```bash
sudo apt-get install -y \
  fakeroot \
  dpkg-dev \
  perl \
  curl \
  python3
```

### Git

Ensure Git is installed and the `upstream` remote is configured:

```bash
git remote add upstream https://github.com/microsoft/vscode.git
```

## Build Steps

### 1. Install Dependencies

```bash
npm ci
```

This installs all Node.js dependencies from `package-lock.json`. If `package-lock.json` doesn't exist, use:

```bash
npm install
```

**Note**: The build process may download additional dependencies (like `@vscode/ripgrep`) which require GitHub API access. Ensure `GITHUB_TOKEN` is set if you encounter 403 errors.

### 2. Compile TypeScript

```bash
npm run compile
```

This compiles all TypeScript source code into JavaScript in the `out/` directory. This step:
- Requires ~4GB RAM minimum
- Takes approximately 10-15 minutes on a modern machine
- Produces build artifacts in `out/` and `out-build/`

### 3. Build Linux Package

For development (non-minified):
```bash
npm run gulp vscode-linux-x64
```

For production (minified):
```bash
npm run gulp vscode-linux-x64-min
```

This creates the `VSCode-linux-x64/` directory (or `../VSCode-linux-x64/` depending on build configuration) containing:
- `quantlab` - Main executable
- `resources/` - Application resources
- `bin/` - Binary files
- `extensions/` - Built-in extensions

**Note**: The minified build requires more memory and time but produces smaller artifacts.

## Running Quantlab

After building, run Quantlab from the build output directory:

```bash
./VSCode-linux-x64/quantlab
```

Or if the build output is in the parent directory:

```bash
../VSCode-linux-x64/quantlab
```

## Troubleshooting

### Kerberos Build Failure

**Error**: `fatal error: gssapi/gssapi.h: No such file or directory`

**Solution**: Install `libkrb5-dev`:
```bash
sudo apt-get install -y libkrb5-dev
```

### Memory Issues During Compilation

**Error**: `compilation requires 4GB of RAM` or out-of-memory errors

**Solutions**:
1. Increase available RAM or use swap
2. Use non-minified build (`vscode-linux-x64` instead of `vscode-linux-x64-min`)
3. Set Node.js memory limit: `NODE_OPTIONS="--max-old-space-size=6144" npm run compile`

### GitHub API Rate Limits

**Error**: `Error: Request failed: 403` when installing `@vscode/ripgrep`

**Solution**: Export GitHub token:
```bash
export GITHUB_TOKEN=your_token_here
export GH_TOKEN=your_token_here
npm ci
```

### Missing System Libraries

**Error**: Various "library not found" errors during native module compilation

**Solution**: Install missing development packages. Common ones:
- `libx11-dev` - X11 development files
- `libx11-xcb-dev` - X11 XCB development files
- `libxkbfile-dev` - XKB file development files
- `libsecret-1-dev` - Secret service development files

### Build Output Location

The build output may be in:
- `VSCode-linux-x64/` (current directory)
- `../VSCode-linux-x64/` (parent directory)

Check both locations if you can't find the build output.

### DEB Packaging Issues

**Error**: `dpkg-shlibdeps: cannot read .../quantlab-tunnel`

**Solution**: This is expected if the tunnel binary doesn't exist. The build process handles this automatically. If packaging fails, check that the build completed successfully first.

## Verification

After building, run verification scripts to ensure everything is correct:

### Quick Verification

```bash
./scripts/verify-build.sh
```

### Comprehensive Verification

```bash
./scripts/verify-all.sh
```

This runs all verification scripts:
- `preflight.sh` - Environment checks
- `verify-build.sh` - Build artifact verification
- `verify-identity.sh` - Product identity verification
- `verify-network-surface.sh` - Network safety verification
- `verify-marketplace.sh` - Marketplace configuration verification
- `verify-artifacts.sh` - Artifact verification (if artifacts exist)

## Development Workflow

### Watch Mode (for active development)

Compile and watch for changes:
```bash
npm run watch
```

This automatically recompiles when source files change.

### Clean Build

To start fresh:
```bash
# Remove build artifacts
rm -rf out out-* VSCode-linux-x64

# Rebuild
npm run compile
npm run gulp vscode-linux-x64
```

### Running Tests

```bash
# Unit tests
npm run test-node

# Integration tests
npm run test-integration
```

## Packaging for Distribution

### TAR Archive

After building:
```bash
cd ..
tar -czf quantlab-linux-x64.tar.gz VSCode-linux-x64
```

### DEB Package

```bash
# Prepare DEB structure
npm run gulp vscode-linux-x64-prepare-deb

# Build DEB package
npm run gulp vscode-linux-x64-build-deb
```

The DEB package will be in `.build/linux/deb/amd64/deb/quantlab_*.deb`

**Note**: DEB packaging requires `fakeroot` and `dpkg-dev` to be installed.

## Environment Setup (Advanced)

For production builds, you may need to set up the Linux build environment:

```bash
export VSCODE_ARCH=x64
export npm_config_arch=x64
source ./build/azure-pipelines/linux/setup-env.sh
```

This sets up:
- Sysroots for cross-compilation
- Clang toolchain
- libc++ headers and objects
- Compiler flags and environment variables

**Note**: This is typically only needed for packaging, not for development builds.

## Related Documentation

- [CI Workflows](../release/ci.md) - Automated build and packaging
- [Artifacts](../release/artifacts.md) - Downloading and installing artifacts
- [Upstream Sync](../upstream-sync.md) - Syncing with upstream VS Code
- [Build Preflight](../BUILD_PREFLIGHT.md) - Pre-build checks

