# Packaging Artifacts

This document records the gulp tasks for packaging artifacts across platforms.

## Linux Packaging Tasks

### Directory/TAR Artifacts
- `vscode-linux-x64` - Creates `VSCode-linux-x64/` directory (full build)
- `vscode-linux-x64-min` - Creates `VSCode-linux-x64/` directory (minified build)
- `vscode-linux-armhf` - Creates `VSCode-linux-armhf/` directory
- `vscode-linux-arm64` - Creates `VSCode-linux-arm64/` directory

### DEB Package Tasks
- `vscode-linux-x64-prepare-deb` - Prepares deb package structure
- `vscode-linux-x64-build-deb` - Builds deb package (requires fakeroot, dpkg-deb)
- `vscode-linux-armhf-prepare-deb` - Prepares deb package for armhf
- `vscode-linux-armhf-build-deb` - Builds deb package for armhf
- `vscode-linux-arm64-prepare-deb` - Prepares deb package for arm64
- `vscode-linux-arm64-build-deb` - Builds deb package for arm64

### RPM Package Tasks
- `vscode-linux-x64-prepare-rpm` - Prepares rpm package structure
- `vscode-linux-x64-build-rpm` - Builds rpm package
- `vscode-linux-armhf-prepare-rpm` - Prepares rpm package for armhf
- `vscode-linux-armhf-build-rpm` - Builds rpm package for armhf
- `vscode-linux-arm64-prepare-rpm` - Prepares rpm package for arm64
- `vscode-linux-arm64-build-rpm` - Builds rpm package for arm64

### Snap Package Tasks
- `vscode-linux-x64-prepare-snap` - Prepares snap package structure
- `vscode-linux-x64-build-snap` - Builds snap package (requires snapcraft)
- Similar tasks for armhf and arm64

## Windows Packaging Tasks

### Win32 x64
- `vscode-win32-x64` - Creates `VSCode-win32-x64/` directory (full build)
- `vscode-win32-x64-min` - Creates `VSCode-win32-x64/` directory (minified build)
- `vscode-win32-x64-ci` - CI-only task (no compilation)

### Win32 ARM64
- `vscode-win32-arm64` - Creates `VSCode-win32-arm64/` directory
- `vscode-win32-arm64-min` - Creates `VSCode-win32-arm64/` directory (minified)
- `vscode-win32-arm64-ci` - CI-only task

**Note:** Windows packaging typically uses Inno Setup (`.iss` files) for installer creation, which is separate from these gulp tasks.

## macOS (Darwin) Packaging Tasks

### Darwin x64
- `vscode-darwin-x64` - Creates `VSCode-darwin-x64/` directory (full build)
- `vscode-darwin-x64-min` - Creates `VSCode-darwin-x64/` directory (minified build)
- `vscode-darwin-x64-ci` - CI-only task

### Darwin ARM64 (Apple Silicon)
- `vscode-darwin-arm64` - Creates `VSCode-darwin-arm64/` directory
- `vscode-darwin-arm64-min` - Creates `VSCode-darwin-arm64/` directory (minified)
- `vscode-darwin-arm64-ci` - CI-only task

**Note:** macOS packaging typically creates `.app` bundles and may use additional tools for DMG creation.

## Task Discovery

Tasks are defined in:
- `build/gulpfile.vscode.ts` - Main packaging tasks (tar/dir artifacts)
- `build/gulpfile.vscode.linux.ts` - Linux-specific packaging (deb/rpm/snap)

To discover tasks (requires TypeScript compilation):
```bash
npm run gulp -- --tasks-simple
```

## Build Requirements

All packaging tasks require:
1. Full compilation (`npm run compile` or `npm run watch`)
2. Built artifacts in `out/` directory
3. Platform-specific tools:
   - Linux DEB: `fakeroot`, `dpkg-deb`
   - Linux RPM: `rpmbuild`
   - Linux Snap: `snapcraft`
   - Windows: Inno Setup compiler
   - macOS: Xcode tools

