# Appendix A - Build and Packaging Workflow (Bundled Python + Engine)

Date: 2026-01-26
Status: Planning (Authoritative for build/packaging)
Owner: Release/Build + Engine

## Goals
- Ship a consistent Python 3.11 runtime and engine across Windows/macOS/Linux.
- Ensure deterministic builds with pinned dependencies.
- Enable in-place upgrades with migrations.
- Keep all runtime assets inside the app bundle (or AppImage) by default.

## Decision Constraints (from Implementation Decisions)
- Bundled Python with embedded venv.
- External wheels at build time (pinned requirements).
- Engine lives under `engine/`.
- Linux target: AppImage only.
- In-place upgrade + migration scripts.

## Repository Layout (target)
```
quantlab/
├── engine/
│   ├── quantlab/
│   ├── pyproject.toml
│   ├── requirements.txt
│   └── tests/
├── build/
│   ├── python/
│   │   ├── package-win.ps1
│   │   ├── package-mac.sh
│   │   └── package-linux.sh
│   └── scripts/
└── resources/
```

## Build Pipeline (Per OS)
### Windows
1. Download Python 3.11 embedded zip.
2. Create embedded venv in build output: `resources/python/venv/`.
3. Install engine and deps from `engine/requirements.txt` (pinned).
4. Copy engine package into venv site-packages.
5. Package into NSIS installer with `resources/python/`.

### macOS
1. Bundle Framework Python 3.11 inside app.
2. Create venv inside app bundle: `Quantlab.app/Contents/Resources/python/venv/`.
3. Install engine and deps at build time.
4. Code sign the bundle; notarize.

### Linux (AppImage)
1. Bundle Python 3.11 into AppImage `usr/` tree.
2. Create venv in `usr/lib/quantlab/python/venv/`.
3. Install engine and deps at build time.
4. Package as AppImage only.

## Runtime Selection Logic
- Default: bundled Python path in app resources.
- Override: `quantlab.python.path` setting for advanced users.
- On startup:
  - Validate Python version == 3.11.
  - Validate engine package present.
  - If invalid, show blocking error and fallback to bundled.

## Engine Upgrade and Migration
- Maintain `~/.quantlab/version.json` with engine version.
- On update:
  - Run migration scripts in `engine/quantlab/migrations/`.
  - If migration fails, rollback and prompt user.
- V1: history compatibility is breaking; warn users.

## CI/CD Integration
- Build jobs per OS with cached wheels.
- Validate:
  - Engine unit tests pass.
  - `python --version` = 3.11.x.
  - Engine package import succeeds.
- Artifacts:
  - Windows installer
  - macOS .dmg
  - Linux AppImage

## Security and Signing
- Windows: EV code signing certificate.
- macOS: Developer ID + notarization.
- Linux: optional GPG signature.

## Deliverables
- Build scripts under `build/python/`.
- Release checklist entries for Python/engine packaging.
- CI jobs documented in release runbook.

