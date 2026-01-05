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

## Downloading Artifacts

Artifacts are automatically built by the CI workflow (`.github/workflows/quantlab-ci.yml`) on every push to `main` or manual workflow dispatch.

### From GitHub Actions

1. Go to the [Actions](https://github.com/Sanzhar-15/quantlab/actions) tab
2. Select the workflow run you want (look for "Quantlab CI")
3. Scroll down to the "Artifacts" section at the bottom
4. Click on the artifact for your platform to download

### Available Artifacts

- **Linux**: `quantlab-linux-x64-tar` (TAR archive) and `quantlab-linux-x64-deb` (DEB package)
- **Windows**: `quantlab-win32-x64` (ZIP archive)
- **macOS**: `quantlab-darwin-x64` (ZIP archive)

**Note**: Artifacts are retained for 90 days by default. After that, they expire and are no longer available for download.

## Installing and Running Artifacts

### Linux TAR Archive

**Download**: `quantlab-linux-x64.tar.gz` from GitHub Actions artifacts

**Installation**:
```bash
# Extract the archive
tar -xzf quantlab-linux-x64.tar.gz

# The extracted directory contains everything needed
cd VSCode-linux-x64
```

**Running**:
```bash
# Run from the extracted directory
./quantlab

# Or create a symlink for system-wide access
sudo ln -s $(pwd)/quantlab /usr/local/bin/quantlab
quantlab  # Now available system-wide
```

**Uninstallation**: Simply delete the extracted directory:
```bash
rm -rf VSCode-linux-x64
```

### Linux DEB Package

**Download**: `quantlab_*.deb` from GitHub Actions artifacts (e.g., `quantlab_1.108.0-1767472612_amd64.deb`)

**Installation**:
```bash
# Install the DEB package
sudo dpkg -i quantlab_*.deb

# If dependencies are missing, fix them
sudo apt-get install -f
```

**Running**:
```bash
# After installation, Quantlab is available as a command
quantlab
```

**Installation Location**:
- Binary: `/usr/share/quantlab/quantlab`
- Symlink: `/usr/bin/quantlab`
- Desktop files: `/usr/share/applications/quantlab*.desktop`
- Icons: `/usr/share/pixmaps/quantlab.png`

**Uninstallation**:
```bash
sudo dpkg -r quantlab
```

### Windows ZIP Archive

**Download**: `quantlab-win32-x64.zip` from GitHub Actions artifacts

**Installation**:
1. Extract the ZIP file to a location of your choice (e.g., `C:\Program Files\Quantlab\`)
2. No installer is required - the extracted directory contains everything

**Running**:
1. Navigate to the extracted directory
2. Double-click `quantlab.exe` or run from command prompt:
   ```cmd
   cd C:\Program Files\Quantlab\VSCode-win32-x64
   quantlab.exe
   ```

**Optional**: Create a desktop shortcut:
1. Right-click `quantlab.exe`
2. Select "Create shortcut"
3. Move the shortcut to your Desktop

**Uninstallation**: Delete the extracted directory

### macOS ZIP Archive

**Download**: `quantlab-darwin-x64.zip` from GitHub Actions artifacts

**Installation**:
1. Extract the ZIP file
2. Move `Quantlab.app` to your Applications folder:
   ```bash
   # Extract
   unzip quantlab-darwin-x64.zip

   # Move to Applications
   mv VSCode-darwin-x64/Quantlab.app /Applications/
   ```

**Running**:
1. **GUI**: Open Finder, go to Applications, double-click `Quantlab.app`
2. **Terminal**:
   ```bash
   open /Applications/Quantlab.app
   ```
3. **Command line**: Create a symlink for terminal access:
   ```bash
   sudo ln -s /Applications/Quantlab.app/Contents/Resources/app/bin/quantlab /usr/local/bin/quantlab
   quantlab  # Now available in terminal
   ```

**Note**: macOS may warn about the app being from an unidentified developer. This is normal for unsigned builds. To allow it:
1. Right-click `Quantlab.app`
2. Select "Open"
3. Click "Open" in the security dialog

**Uninstallation**: Delete `Quantlab.app` from Applications folder

## Artifact Source

All artifacts are built automatically by the GitHub Actions CI workflow:

- **Workflow**: `.github/workflows/quantlab-ci.yml`
- **Trigger**: Push to `main` branch or manual `workflow_dispatch`
- **Jobs**:
  - `package-linux`: Builds Linux TAR and DEB packages
  - `package-win`: Builds Windows ZIP package
  - `package-mac`: Builds macOS ZIP package

For more details on the CI workflow, see [CI Documentation](ci.md).

## Verification

After downloading and extracting artifacts, you can verify they're working correctly:

```bash
# Linux
./VSCode-linux-x64/quantlab --version

# Windows
quantlab.exe --version

# macOS
/Applications/Quantlab.app/Contents/Resources/app/bin/quantlab --version
```

All should output the Quantlab version (e.g., `1.108.0`).

## Troubleshooting

### Linux: "Permission denied" when running quantlab

**Solution**: Make the binary executable:
```bash
chmod +x VSCode-linux-x64/quantlab
```

### Linux DEB: "dpkg: error processing package"

**Solution**: Install missing dependencies:
```bash
sudo apt-get install -f
```

### macOS: "Quantlab.app is damaged and can't be opened"

**Solution**: Remove the quarantine attribute:
```bash
xattr -d com.apple.quarantine /Applications/Quantlab.app
```

### Windows: Antivirus blocks execution

**Solution**: Add an exception for the Quantlab directory in your antivirus software. This is a false positive common with unsigned executables.

