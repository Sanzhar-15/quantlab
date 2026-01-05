# Quantlab CI Workflows

This document describes the CI/CD workflows for Quantlab builds and packaging.

## Workflow: quantlab-ci.yml

### Triggers

The workflow runs on:
- **Push to `main` branch**: Runs all jobs (smoke tests + packaging)
- **Pull requests**: Runs smoke tests only (no packaging)
- **Manual dispatch**: Can be triggered manually via GitHub Actions UI (runs all jobs)

### Jobs

#### A) smoke-build

**Purpose**: Verify the codebase compiles and passes verification scripts across all platforms.

**Matrix**: Runs on `ubuntu-latest`, `windows-latest`, and `macos-latest`

**Steps**:
1. Checkout code
2. Setup Node.js from `.nvmrc` (version 22.21.1)
3. Install dependencies (`npm ci` if `package-lock.json` exists, else `npm install`)
4. Compile (`npm run compile`)
5. Run verification scripts:
   - `scripts/verify-build.sh` - Verifies build artifacts
   - `scripts/verify-identity.sh` - Verifies product identity
   - `scripts/verify-network-surface.sh` - Verifies network safety
   - `scripts/verify-marketplace.sh` - Verifies Open VSX marketplace (with `ALLOW_NET_FAIL=1`)

**When it runs**: On every push and pull request

#### B) package-linux

**Purpose**: Build Linux packages (TAR archive and DEB package).

**Platform**: `ubuntu-latest`

**Steps**:
1. Checkout code
2. Setup Node.js
3. Install system dependencies (pkg-config, GTK, fakeroot, dpkg-dev, etc.)
4. Install Node.js dependencies
5. Build Linux package (`npm run gulp vscode-linux-x64-min`)
6. Prepare DEB package (`npm run gulp vscode-linux-x64-prepare-deb`)
7. Build DEB package (`npm run gulp vscode-linux-x64-build-deb`)
8. Verify artifacts (`scripts/verify-artifacts.sh`)
9. Upload artifacts:
   - `quantlab-linux-x64-tar`: TAR archive (`quantlab-linux-x64.tar.gz`)
   - `quantlab-linux-x64-deb`: DEB package (`quantlab_*.deb`)

**When it runs**: Only on push to `main` or manual dispatch

#### C) package-win

**Purpose**: Build Windows package.

**Platform**: `windows-latest`

**Steps**:
1. Checkout code
2. Setup Node.js
3. Install Node.js dependencies
4. Build Windows package (`npm run gulp vscode-win32-x64-min`)
5. Verify embedded `product.json` identity
6. Create ZIP archive
7. Upload artifact: `quantlab-win32-x64` (ZIP file)

**When it runs**: Only on push to `main` or manual dispatch

#### D) package-mac

**Purpose**: Build macOS package.

**Platform**: `macos-latest`

**Steps**:
1. Checkout code
2. Setup Node.js
3. Install Node.js dependencies
4. Build macOS package (`npm run gulp vscode-darwin-x64-min`)
5. Verify embedded `product.json` identity
6. Create ZIP archive
7. Upload artifact: `quantlab-darwin-x64` (ZIP file)

**When it runs**: Only on push to `main` or manual dispatch

## Artifacts

### Linux

- **TAR Archive**: `quantlab-linux-x64.tar.gz`
  - Contains: `VSCode-linux-x64/` directory with all binaries and resources
  - Usage: Extract and run `./quantlab` from the extracted directory

- **DEB Package**: `quantlab_*.deb`
  - Usage: `sudo dpkg -i quantlab_*.deb`
  - Installs to: `/usr/share/quantlab/`
  - Creates: `/usr/bin/quantlab` symlink

### Windows

- **ZIP Archive**: `quantlab-win32-x64.zip`
  - Contains: `VSCode-win32-x64/` directory
  - Usage: Extract and run `quantlab.exe` from the extracted directory

### macOS

- **ZIP Archive**: `quantlab-darwin-x64.zip`
  - Contains: `VSCode-darwin-x64/` directory with `Quantlab.app` bundle
  - Usage: Extract and open `Quantlab.app` or run from terminal

## Downloading and Running Artifacts

### From GitHub Actions

1. Go to the [Actions](https://github.com/Sanzhar-15/quantlab/actions) tab
2. Select the workflow run you want
3. Scroll down to the "Artifacts" section
4. Download the artifact for your platform
5. Extract and run according to the instructions above

### Linux (TAR)

```bash
# Download and extract
tar -xzf quantlab-linux-x64.tar.gz
cd VSCode-linux-x64

# Run
./quantlab
```

### Linux (DEB)

```bash
# Install
sudo dpkg -i quantlab_*.deb

# Run
quantlab
```

### Windows

```powershell
# Extract ZIP file
Expand-Archive -Path quantlab-win32-x64.zip -DestinationPath .

# Run
.\VSCode-win32-x64\quantlab.exe
```

### macOS

```bash
# Extract ZIP file
unzip quantlab-darwin-x64.zip

# Run (GUI)
open VSCode-darwin-x64/Quantlab.app

# Or run from terminal
VSCode-darwin-x64/Quantlab.app/Contents/MacOS/Quantlab
```

## Manual Workflow Dispatch

To manually trigger a full build (including packaging):

1. Go to [Actions](https://github.com/Sanzhar-15/quantlab/actions)
2. Select "Quantlab CI" workflow
3. Click "Run workflow"
4. Select branch (usually `main`)
5. Click "Run workflow"

This will run all jobs including packaging, even if not on the `main` branch.

## Troubleshooting

### Build Failures

- **Compilation errors**: Check Node.js version matches `.nvmrc` (22.21.1)
- **Missing dependencies**: Ensure `package-lock.json` is committed
- **Linux packaging fails**: Check system dependencies are installed (fakeroot, dpkg-dev)

### Verification Failures

- **Identity mismatch**: Check `config/quantlab.identity.env` matches `product.json`
- **Network surface issues**: Verify no Microsoft endpoints in product configuration
- **Marketplace issues**: Check Open VSX is configured correctly

### Artifact Issues

- **Missing artifacts**: Check build logs for packaging step failures
- **Corrupted artifacts**: Re-run the workflow
- **Wrong architecture**: Ensure correct platform job ran (x64 vs arm64)

## CI Guarantees

### What CI Guarantees

The CI workflow provides the following guarantees when all jobs pass:

1. **Code Compiles**: The codebase successfully compiles on all platforms (Windows, macOS, Linux)
2. **Verification Passes**: All verification scripts pass:
   - Build artifacts are valid
   - Product identity is correct (Quantlab branding)
   - Network surface is safe (no Microsoft endpoints)
   - Marketplace is configured (Open VSX)
3. **Artifacts Build**: Packaging jobs successfully produce installable artifacts:
   - Linux TAR and DEB packages
   - Windows ZIP archive
   - macOS ZIP archive
4. **Artifacts Upload**: All artifacts are successfully uploaded and available for download
5. **Cross-Platform Compatibility**: Code compiles and basic verification works on all three platforms

### What CI Does NOT Guarantee

The CI workflow does **not** guarantee:

1. **Runtime Functionality**: CI does not run Quantlab or test that it actually works when launched
2. **Extension Compatibility**: CI does not test extension installation or functionality
3. **Performance**: CI does not measure or verify performance characteristics
4. **UI/UX**: CI does not verify the user interface works correctly
5. **Integration Testing**: CI does not run integration tests or end-to-end tests
6. **Security Audits**: CI does not perform security vulnerability scanning (beyond basic dependency checks)
7. **Long-Term Stability**: CI does not test long-running sessions or memory leaks
8. **Platform-Specific Features**: CI does not verify platform-specific features work (e.g., file associations, context menus)

### Interpreting CI Results

#### All Jobs Green (Success)

- ✅ Code compiles on all platforms
- ✅ Verification scripts pass
- ✅ Artifacts are built and uploaded
- ✅ Safe to download and test artifacts
- ⚠️ Still need to manually test runtime functionality

#### Smoke Tests Pass, Packaging Fails

- ✅ Code compiles and verification passes
- ❌ Artifacts are not available
- **Action**: Check packaging job logs for specific errors (often system dependencies or resource limits)

#### Smoke Tests Fail

- ❌ Code does not compile or verification fails
- ❌ Artifacts will not be built (packaging jobs may be skipped)
- **Action**: Fix compilation or verification issues before attempting to build artifacts

#### Partial Success (Some Platforms Pass)

- ✅ Some platforms compile successfully
- ⚠️ Platform-specific issues may exist
- **Action**: Review platform-specific job logs to identify issues

### Artifact Retention

- **Retention Period**: Artifacts are retained for **90 days** by default
- **Expiration**: After 90 days, artifacts are automatically deleted and cannot be recovered
- **Download**: Artifacts can be downloaded from the workflow run page while they're available
- **Size Limits**: GitHub Actions has artifact size limits (typically 10GB per artifact, 10GB total per workflow run)

**Best Practice**: Download artifacts you need for testing or distribution soon after the workflow completes.

### CI Status Indicators

- **Green Checkmark**: Job completed successfully
- **Red X**: Job failed (check logs for details)
- **Yellow Circle**: Job is in progress
- **Gray Circle**: Job was skipped (e.g., packaging skipped on PRs)

### Workflow Run States

- **Success**: All required jobs passed
- **Failure**: One or more required jobs failed
- **Cancelled**: Workflow was manually cancelled or superseded by a newer run
- **Skipped**: Workflow was skipped (e.g., no changes on a push event)

## Related Documentation

- [Artifacts](artifacts.md) - Detailed artifact download and installation instructions
- [Linux Development Build](../build/linux-dev.md) - Building Quantlab locally on Linux
- [Upstream Sync](../upstream-sync.md) - Syncing with upstream VS Code

