# Appendix A: Build and Packaging Workflow

**Source**: ChatGPT plan (enhanced)
**Status**: Authoritative for build/packaging
**Owner**: Release/Build + Engine

---

## Goals

- Ship a consistent Python 3.11 runtime and engine across Windows/macOS/Linux
- Ensure deterministic builds with pinned dependencies
- Enable in-place upgrades with migrations
- Keep all runtime assets inside the app bundle (or AppImage) by default

---

## Decision Constraints

| Decision | Requirement |
|----------|-------------|
| A1 | Engine lives under `engine/` |
| A2 | Bundled Python with embedded venv |
| I54 | Linux target: AppImage only |
| I55 | Auto-update: electron-updater (pending Phase 0 VS Code updater evaluation) |
| I56 | Code signing required (Windows EV, macOS Developer ID) |
| I57 | Extensions bundled at build time |

---

## Repository Layout (Target)

```
quantlab/
├── engine/
│   ├── quantlab/                 # Python package
│   │   ├── __init__.py
│   │   ├── backtest/
│   │   ├── daemon/
│   │   ├── data/
│   │   ├── risk/
│   │   └── migrations/
│   ├── pyproject.toml
│   ├── requirements.txt          # Pinned dependencies
│   └── tests/
├── extensions/
│   └── quantlab/                 # TypeScript extension
├── build/
│   ├── python/
│   │   ├── package-win.ps1       # Windows packaging
│   │   ├── package-mac.sh        # macOS packaging
│   │   └── package-linux.sh      # Linux packaging
│   └── scripts/
│       ├── download-python.sh
│       ├── create-venv.sh
│       └── sign-release.sh
├── resources/
│   └── python/                   # Bundled Python (build output)
└── schemas/
    └── quantlab/                 # Shared JSON schemas
```

---

## Build Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Source Code                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Engine Build │    │Extension Build│    │  Schema Gen   │
│  (Python)     │    │  (TypeScript) │    │  (JSON→TS/Py) │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
                    ┌───────────────┐
                    │   Packaging   │
                    │   (Per OS)    │
                    └───────┬───────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Windows     │    │    macOS      │    │    Linux      │
│   (.exe)      │    │   (.dmg)      │    │  (AppImage)   │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Per-OS Build Details

### Windows

```powershell
# build/python/package-win.ps1

# 1. Download Python 3.11 embedded zip
$pythonUrl = "https://www.python.org/ftp/python/3.11.8/python-3.11.8-embed-amd64.zip"
Invoke-WebRequest -Uri $pythonUrl -OutFile python.zip
Expand-Archive python.zip -DestinationPath resources/python

# 2. Enable pip in embedded Python
# Remove 'import site' line from python311._pth
(Get-Content resources/python/python311._pth) |
    Where-Object { $_ -notmatch 'import site' } |
    Set-Content resources/python/python311._pth

# 3. Create venv
.\resources\python\python.exe -m venv resources/python/venv

# 4. Install dependencies
.\resources\python\venv\Scripts\pip.exe install -r engine/requirements.txt

# 5. Install engine package
.\resources\python\venv\Scripts\pip.exe install -e engine/

# 6. Package with NSIS (via electron-builder)
npm run package:win
```

**Output**: `dist/Quantlab-Setup-1.0.0.exe` (NSIS installer)

### macOS

```bash
#!/bin/bash
# build/python/package-mac.sh

# 1. Download Python Framework
PYTHON_VERSION="3.11.8"
curl -O "https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-macos11.pkg"

# 2. Extract framework Python
# (Alternative: use pyenv or homebrew for CI)
mkdir -p Quantlab.app/Contents/Resources/python

# 3. Create venv inside app bundle
python3.11 -m venv Quantlab.app/Contents/Resources/python/venv

# 4. Install dependencies
./Quantlab.app/Contents/Resources/python/venv/bin/pip install -r engine/requirements.txt
./Quantlab.app/Contents/Resources/python/venv/bin/pip install -e engine/

# 5. Code sign
codesign --deep --force --verify --verbose \
    --sign "Developer ID Application: Quantlab Inc." \
    Quantlab.app

# 6. Notarize
xcrun notarytool submit Quantlab.app.zip \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$TEAM_ID" \
    --wait

# 7. Package as DMG
npm run package:mac
```

**Output**: `dist/Quantlab-1.0.0.dmg` (notarized DMG)

### Linux (AppImage)

```bash
#!/bin/bash
# build/python/package-linux.sh

# 1. Create AppDir structure
mkdir -p AppDir/usr/lib/quantlab/python

# 2. Bundle Python 3.11 (from pyenv or standalone)
# Using python-build-standalone for reproducibility
curl -LO "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.8-x86_64-unknown-linux-gnu-install_only.tar.gz"
tar -xzf cpython-3.11.8-*.tar.gz -C AppDir/usr/lib/quantlab/python

# 3. Create venv
AppDir/usr/lib/quantlab/python/bin/python3.11 -m venv AppDir/usr/lib/quantlab/python/venv

# 4. Install dependencies
./AppDir/usr/lib/quantlab/python/venv/bin/pip install -r engine/requirements.txt
./AppDir/usr/lib/quantlab/python/venv/bin/pip install -e engine/

# 5. Package as AppImage
ARCH=x86_64 appimagetool AppDir Quantlab-1.0.0-x86_64.AppImage
```

**Output**: `dist/Quantlab-1.0.0-x86_64.AppImage`

---

## Runtime Selection Logic

```typescript
// src/core/python/runtime.ts

interface PythonRuntime {
  path: string;
  version: string;
  venvPath: string;
}

function getPythonRuntime(): PythonRuntime {
  // 1. Check user override
  const customPath = vscode.workspace.getConfiguration('quantlab').get('python.path');
  if (customPath && isValidPython(customPath)) {
    return createRuntime(customPath);
  }

  // 2. Use bundled Python
  const bundledPath = getBundledPythonPath();
  if (isValidPython(bundledPath)) {
    return createRuntime(bundledPath);
  }

  // 3. Error: no valid Python
  throw new Error('No valid Python 3.11 runtime found');
}

function getBundledPythonPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(app.getAppPath(), 'resources', 'python', 'venv', 'Scripts', 'python.exe');
    case 'darwin':
      return path.join(app.getAppPath(), '..', 'Resources', 'python', 'venv', 'bin', 'python');
    case 'linux':
      return path.join(app.getAppPath(), 'usr', 'lib', 'quantlab', 'python', 'venv', 'bin', 'python');
  }
}

function isValidPython(pythonPath: string): boolean {
  try {
    const version = execSync(`"${pythonPath}" --version`).toString().trim();
    return version.startsWith('Python 3.11');
  } catch {
    return false;
  }
}
```

---

## Engine Upgrade and Migration

### Version Tracking

```json
// ~/.quantlab/version.json
{
  "engine_version": "1.0.0",
  "schema_version": 1,
  "last_migration": "2026-01-26T00:00:00Z"
}
```

### Migration Scripts

```
engine/quantlab/migrations/
├── __init__.py
├── 001_initial.py
├── 002_add_audit_log.py
└── 003_update_artifact_schema.py
```

```python
# engine/quantlab/migrations/001_initial.py

def upgrade(data_dir: Path) -> None:
    """Initialize Quantlab data directory."""
    (data_dir / 'history').mkdir(exist_ok=True)
    (data_dir / 'sessions').mkdir(exist_ok=True)
    (data_dir / 'logs').mkdir(exist_ok=True)

def downgrade(data_dir: Path) -> None:
    """Not supported for initial migration."""
    raise NotImplementedError("Cannot downgrade from initial")
```

### Migration Runner

```python
# engine/quantlab/migrations/runner.py

def run_migrations(data_dir: Path) -> None:
    """Run pending migrations."""
    version_file = data_dir / 'version.json'
    current = load_version(version_file)

    for migration in get_pending_migrations(current):
        try:
            migration.upgrade(data_dir)
            update_version(version_file, migration.version)
        except Exception as e:
            # Rollback and prompt user
            show_migration_error(migration, e)
            raise
```

---

## CI/CD Integration

### Build Matrix

```yaml
# .github/workflows/release.yml

jobs:
  build:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Python 3.11
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          npm ci
          pip install -r engine/requirements.txt

      - name: Run engine tests
        run: pytest engine/tests --cov=engine/quantlab --cov-report=xml

      - name: Run extension tests
        run: npm test

      - name: Package application
        run: npm run package
        env:
          CSC_LINK: ${{ secrets.WINDOWS_CERTIFICATE }}
          CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: quantlab-${{ matrix.os }}
          path: dist/
```

### Validation Steps

| Step | Validation |
|------|------------|
| Engine unit tests | ≥80% coverage |
| Extension unit tests | ≥70% coverage |
| Python version check | == 3.11.x |
| Engine import check | `python -c "import quantlab"` succeeds |
| Package size check | < 250MB (all platforms) |

---

## Security and Signing

### Windows

| Requirement | Details |
|-------------|---------|
| Certificate | EV Code Signing Certificate |
| Provider | DigiCert, Sectigo, or equivalent |
| Cost | ~$350-500/year |
| SmartScreen | EV avoids SmartScreen warning immediately |

### macOS

| Requirement | Details |
|-------------|---------|
| Certificate | Developer ID Application |
| Notarization | Required for Gatekeeper |
| Hardened Runtime | Required for notarization |
| Entitlements | Network, file access |

### Linux

| Requirement | Details |
|-------------|---------|
| Signing | GPG signature (optional) |
| Verification | Users can verify with public key |

---

## Package Size Budget

| Component | Target Size |
|-----------|-------------|
| Electron base | ~150MB |
| Extension bundle | ~20MB |
| Bundled Python | ~50MB |
| Engine + dependencies | ~30MB |
| **Total** | **<250MB** |

---

## Deliverables

- [ ] Build scripts under `build/python/`
- [ ] CI/CD workflows in `.github/workflows/`
- [ ] Release checklist in `docs/release.md`
- [ ] Code signing certificates procured
- [ ] Package size validated on all platforms

---

*This appendix is authoritative for build and packaging decisions. Reference from Phase 0 and Phase 5.*
