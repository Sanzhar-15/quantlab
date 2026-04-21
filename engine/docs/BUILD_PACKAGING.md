# Quantlab Build and Packaging Strategy

**Version**: 1.0.0
**Status**: APPROVED
**Decision Reference**: A2, I54-I57

This document defines the strategy for bundling Python with the Quantlab application across all supported platforms.

---

## 1. Overview

Quantlab requires a Python 3.11+ runtime for the trading engine. To ensure consistent behavior and eliminate dependency issues, Python is bundled with the application.

### 1.1 Goals

- **Zero Configuration**: Users should not need to install Python separately
- **Reproducibility**: Same Python version and packages across all installations
- **Isolation**: Bundled Python does not interfere with system Python
- **Size Optimization**: Minimize download size while including necessary packages

### 1.2 Constraints

- Target bundled size: < 300MB (compressed)
- Python version: 3.11.x (LTS)
- Must support: Windows 10+, macOS 12+, Ubuntu 22.04+

---

## 2. Platform-Specific Bundling

### 2.1 Windows

**Approach**: Embedded Python Distribution

```
Quantlab/
├── resources/
│   └── python/
│       ├── python.exe
│       ├── python311.dll
│       ├── Lib/
│       │   └── site-packages/
│       │       └── quantlab/
│       └── python311.zip  (stdlib)
```

**Build Steps**:
1. Download embedded Python 3.11 from python.org
2. Extract to `resources/python/`
3. Create virtual environment in `Lib/site-packages/`
4. Install quantlab-engine wheel and dependencies
5. Remove unnecessary files (test/, __pycache__/, etc.)
6. Sign executables with EV code signing certificate

**Runtime**:
```javascript
const pythonPath = path.join(app.getPath('exe'), '..', 'resources', 'python', 'python.exe');
```

### 2.2 macOS

**Approach**: Framework Python in App Bundle

```
Quantlab.app/
└── Contents/
    ├── MacOS/
    │   └── Quantlab
    ├── Resources/
    │   └── python/
    │       ├── bin/
    │       │   └── python3.11
    │       ├── lib/
    │       │   └── python3.11/
    │       │       └── site-packages/
    │       │           └── quantlab/
    │       └── include/
    └── Frameworks/
        └── Python.framework/
```

**Build Steps**:
1. Download Python 3.11 from python.org (macOS installer)
2. Extract framework to `Contents/Frameworks/`
3. Create symlinks in `Contents/Resources/python/`
4. Install quantlab-engine wheel and dependencies
5. Fix library paths with `install_name_tool`
6. Code sign with Developer ID certificate
7. Notarize with Apple notary service

**Runtime**:
```javascript
const pythonPath = path.join(app.getPath('exe'), '..', 'Resources', 'python', 'bin', 'python3.11');
```

### 2.3 Linux

**Approach**: AppImage with Bundled Python

```
Quantlab.AppImage (mounted)
├── usr/
│   ├── bin/
│   │   └── quantlab
│   └── lib/
│       └── quantlab/
│           └── python/
│               ├── bin/
│               │   └── python3.11
│               ├── lib/
│               │   └── python3.11/
│               │       └── site-packages/
│               │           └── quantlab/
│               └── include/
└── AppRun
```

**Build Steps**:
1. Use python-build-standalone for portable Python
2. Extract to AppImage structure
3. Create virtual environment
4. Install quantlab-engine wheel and dependencies
5. Patch RPATH for portability
6. Create AppImage with appimagetool

**Runtime**:
```javascript
const pythonPath = path.join(process.resourcesPath, 'python', 'bin', 'python3.11');
```

---

## 3. Dependency Management

### 3.1 Core Dependencies

| Package | Version | Size (approx) | Purpose |
|---------|---------|---------------|---------|
| numpy | 1.26.x | 30MB | Numerical computing |
| pandas | 2.1.x | 50MB | Data manipulation |
| pyarrow | 14.x | 80MB | Debug file format |
| libcst | 1.1.x | 5MB | Code modification |
| argon2-cffi | 23.x | 2MB | Key derivation |
| cryptography | 41.x | 15MB | Encryption |
| psutil | 5.9.x | 2MB | Process management |
| pyyaml | 6.x | 1MB | Calendar files |
| alpaca-py | 0.20.x | 5MB | Broker integration |
| httpx | 0.25.x | 2MB | HTTP client |

**Total core**: ~200MB uncompressed, ~70MB compressed

### 3.2 Optimization Strategies

1. **Use `--no-deps` where safe**: Avoid duplicate dependencies
2. **Strip debug symbols**: `strip --strip-unneeded *.so`
3. **Remove test files**: Delete `tests/`, `test_*.py`
4. **Remove documentation**: Delete `docs/`, `*.md`, `*.rst`
5. **Bytecode compilation**: Pre-compile to `.pyc` only
6. **Exclude unnecessary wheels**: No source distributions

### 3.3 User Package Support

Users can install additional packages to `~/.quantlab/packages/`:

```python
# Engine adds user packages to path
import sys
sys.path.insert(0, os.path.expanduser('~/.quantlab/packages'))
```

---

## 4. Build Pipeline

### 4.1 CI/CD Workflow

```yaml
# .github/workflows/build-release.yml
name: Build Release

on:
  push:
    tags: ['v*']

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Download embedded Python
        run: scripts/download-python.ps1
      - name: Build engine wheel
        run: pip wheel ./engine -w dist/
      - name: Create bundle
        run: scripts/bundle-windows.ps1
      - name: Sign executables
        run: scripts/sign-windows.ps1
        env:
          CODESIGN_CERT: ${{ secrets.WINDOWS_CODESIGN_CERT }}
      - name: Create installer
        run: scripts/create-installer-windows.ps1
      - name: Upload artifact
        uses: actions/upload-artifact@v4

  build-macos:
    runs-on: macos-latest
    steps:
      # Similar steps for macOS...

  build-linux:
    runs-on: ubuntu-latest
    steps:
      # Similar steps for Linux...
```

### 4.2 Local Development

For development, use system Python with a virtual environment:

```bash
cd engine
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -e ".[dev]"
```

---

## 5. Runtime Selection

### 5.1 Priority Order

1. **Bundled Python** (default, recommended)
2. **User-specified path** (`quantlab.python.path` setting)
3. **System Python** (fallback, with warning)

### 5.2 Selection Logic

```python
def get_python_path() -> str:
    """Determine which Python to use."""

    # 1. Check for bundled Python
    bundled = get_bundled_python_path()
    if bundled and is_valid_python(bundled):
        return bundled

    # 2. Check user setting
    user_path = settings.get('quantlab.python.path')
    if user_path and is_valid_python(user_path):
        return user_path

    # 3. Fallback to system Python (with warning)
    system_python = shutil.which('python3') or shutil.which('python')
    if system_python and is_valid_python(system_python):
        show_warning(
            "Using system Python. For best results, use the bundled Python."
        )
        return system_python

    raise RuntimeError("No valid Python found")


def is_valid_python(path: str) -> bool:
    """Validate Python installation."""
    try:
        result = subprocess.run(
            [path, '--version'],
            capture_output=True,
            timeout=5
        )
        version = result.stdout.decode().strip()
        # Require Python 3.11+
        major, minor = map(int, version.split()[1].split('.')[:2])
        return major == 3 and minor >= 11
    except Exception:
        return False
```

---

## 6. Code Signing

### 6.1 Windows

- **Certificate**: EV Code Signing Certificate (required for SmartScreen)
- **Tool**: `signtool.exe` from Windows SDK
- **Files to sign**: All `.exe` and `.dll` files

### 6.2 macOS

- **Certificate**: Developer ID Application Certificate
- **Entitlements**: `hardened-runtime`, `allow-jit`
- **Notarization**: Required for Gatekeeper bypass
- **Tool**: `codesign` and `xcrun notarytool`

### 6.3 Linux

- No code signing required for AppImage
- Consider GPG signature for package verification

---

## 7. Update Mechanism

### 7.1 Decision Point (I55)

Evaluate VS Code's built-in updater vs electron-updater:

| Feature | VS Code Updater | electron-updater |
|---------|-----------------|------------------|
| Staged rollout | ✅ | ✅ |
| Crash-rate gating | ❓ Evaluate | ✅ |
| Live session block | ❓ Evaluate | Custom impl |
| Differential updates | ✅ | ✅ |

**Decision**: Document in `docs/decisions/auto-update.md` after evaluation.

### 7.2 Live Session Protection

Updates must be blocked during live trading sessions:

```typescript
async function checkForUpdates(): Promise<void> {
  if (sessionManager.hasActiveLiveSessions()) {
    // Defer update until sessions close
    pendingUpdate = true;
    return;
  }
  await autoUpdater.checkForUpdates();
}
```

---

## 8. Size Budget

| Component | Budget | Actual |
|-----------|--------|--------|
| Electron/VS Code base | 150MB | ~150MB |
| Bundled Python | 100MB | TBD |
| Python packages | 50MB | TBD |
| Extension + assets | 20MB | TBD |
| **Total compressed** | **300MB** | TBD |

---

## 9. Testing Matrix

| Platform | Python Source | Test |
|----------|---------------|------|
| Windows 10 | Embedded | ✅ |
| Windows 11 | Embedded | ✅ |
| macOS 12 (Intel) | Framework | ✅ |
| macOS 14 (ARM) | Framework | ✅ |
| Ubuntu 22.04 | python-build-standalone | ✅ |
| Ubuntu 24.04 | python-build-standalone | ✅ |

---

## 10. Rollback Plan

If bundled Python causes issues:

1. User can set `quantlab.python.path` to system Python
2. CI can revert to previous build
3. Emergency update can be pushed (72h SLA)

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-26 | Initial build strategy |

---

*This document is the authoritative source for Python bundling strategy.*
