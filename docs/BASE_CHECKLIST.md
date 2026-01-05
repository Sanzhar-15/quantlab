# Quantlab Base Distribution - Completion Checklist

This checklist defines the "Definition of Done" for the Quantlab base distribution. All items must be completed and verified before considering the base distribution complete.

## Repository Setup

- [ ] Forked from `microsoft/vscode` (VS Code OSS)
- [ ] `upstream` remote configured: `git remote add upstream https://github.com/microsoft/vscode.git`
- [ ] `origin` remote points to Quantlab repository
- [ ] Main branch is `main` (or documented if different)

## Product Identity

- [ ] `config/quantlab.identity.env` exists and contains all identity values
- [ ] `scripts/apply-identity.sh` successfully applies identity to `product.json`
- [ ] `scripts/verify-identity.sh` passes (all identity fields match config)
- [ ] Product name is "Quantlab" (not "Code - OSS")
- [ ] Application name is "quantlab" (not "code-oss")
- [ ] Data folder is `.quantlab` (not `.vscode-oss`)
- [ ] Icons and desktop files use "quantlab" branding
- [ ] All platform-specific identifiers are set (Linux, Windows, macOS)

**Verification**: Run `./scripts/verify-identity.sh`

## Marketplace Configuration

- [ ] `scripts/apply-marketplace.sh` successfully configures Open VSX
- [ ] `scripts/verify-marketplace.sh` passes
- [ ] `product.json` contains `extensionsGallery` with Open VSX URLs:
  - `serviceUrl`: `https://open-vsx.org/vscode/gallery`
  - `itemUrl`: `https://open-vsx.org/vscode/item`
  - `resourceUrlTemplate`: `https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/{path}`
- [ ] `linkProtectionTrustedDomains` includes `https://open-vsx.org`
- [ ] No Microsoft marketplace endpoints configured

**Verification**: Run `./scripts/verify-marketplace.sh`

## Network Surface Policy

- [ ] `scripts/apply-network-surface.sh` successfully applies network policy
- [ ] `scripts/verify-network-surface.sh` passes
- [ ] No Microsoft update endpoints (`updateUrl` not present or disabled)
- [ ] No telemetry enabled by default (`telemetry` field not present or disabled)
- [ ] All product links point to GitHub (not microsoft.com):
  - `reportIssueUrl`: GitHub issues URL
  - `licenseUrl`: GitHub LICENSE URL
  - `serverLicenseUrl`: GitHub LICENSE URL
- [ ] Only Open VSX endpoints allowed in network surface

**Verification**: Run `./scripts/verify-network-surface.sh`

## Build and Compilation

- [ ] Code compiles successfully: `npm run compile`
- [ ] Build artifacts created in `out/` directory
- [ ] `scripts/verify-build.sh` passes
- [ ] Version script works: `./scripts/print-version.sh`
- [ ] No compilation errors or warnings (or documented acceptable warnings)

**Verification**: Run `./scripts/verify-build.sh`

## Verification Scripts

- [ ] `scripts/preflight.sh` - Environment and configuration checks
- [ ] `scripts/verify-build.sh` - Build artifact verification
- [ ] `scripts/verify-identity.sh` - Product identity verification
- [ ] `scripts/verify-network-surface.sh` - Network safety verification
- [ ] `scripts/verify-marketplace.sh` - Marketplace configuration verification
- [ ] `scripts/verify-artifacts.sh` - Artifact verification (if artifacts exist)
- [ ] `scripts/verify-all.sh` - Comprehensive verification (runs all above)

**Verification**: Run `./scripts/verify-all.sh` - all scripts must pass

## CI/CD Workflows

- [ ] `.github/workflows/quantlab-ci.yml` exists and is configured
- [ ] Workflow triggers configured:
  - Push to `main` branch
  - Pull requests
  - Manual `workflow_dispatch`
- [ ] All CI jobs defined:
  - `smoke-build` (matrix: ubuntu, windows, macos)
  - `package-linux`
  - `package-win`
  - `package-mac`
- [ ] CI workflows are enabled in GitHub repository settings

**Verification**: Check GitHub Actions tab shows workflow is enabled

## Smoke Tests

- [ ] Smoke tests pass on all platforms:
  - [ ] `smoke-build` (ubuntu-latest) - **PASS**
  - [ ] `smoke-build` (windows-latest) - **PASS**
  - [ ] `smoke-build` (macos-latest) - **PASS**
- [ ] All verification scripts run in smoke tests
- [ ] No smoke test failures in recent workflow runs

**Verification**: Check latest CI run - all smoke-build jobs show green checkmarks

## Packaging and Artifacts

- [ ] Packaging jobs produce artifacts:
  - [ ] `package-linux` produces `quantlab-linux-x64-tar` and `quantlab-linux-x64-deb`
  - [ ] `package-win` produces `quantlab-win32-x64` (ZIP)
  - [ ] `package-mac` produces `quantlab-darwin-x64` (ZIP)
- [ ] Artifacts are uploaded successfully
- [ ] Artifacts are downloadable from GitHub Actions
- [ ] Artifacts are installable and runnable:
  - [ ] Linux TAR: Extract and run `./quantlab`
  - [ ] Linux DEB: Install with `sudo dpkg -i` and run `quantlab`
  - [ ] Windows ZIP: Extract and run `quantlab.exe`
  - [ ] macOS ZIP: Extract and open `Quantlab.app`

**Verification**:
- Check latest CI run - all packaging jobs show green checkmarks
- Download artifacts and verify they install/run correctly

## Documentation

- [ ] Architecture Decision Records (ADRs) created:
  - [ ] `docs/adr/0001-quantlab-identity.md`
  - [ ] `docs/adr/0002-open-vsx-marketplace.md`
  - [ ] `docs/adr/0003-network-surface-policy.md`
  - [ ] `docs/adr/0004-upstream-sync-policy.md`
- [ ] Build documentation:
  - [ ] `docs/build/linux-dev.md` - Linux development build guide
- [ ] Release documentation:
  - [ ] `docs/release/artifacts.md` - Artifact download/install instructions
  - [ ] `docs/release/ci.md` - CI workflow documentation
- [ ] Upstream sync documentation:
  - [ ] `docs/upstream-sync.md` - Sync strategy and process
- [ ] Base checklist (this file):
  - [ ] `docs/BASE_CHECKLIST.md` - Completion checklist

**Verification**: All documentation files exist and are complete

## Upstream Sync Strategy

- [ ] Upstream sync process documented in `docs/upstream-sync.md`
- [ ] `scripts/verify-all.sh` can be run after syncs
- [ ] Identity restoration scripts work (`apply-identity.sh`, `apply-marketplace.sh`, `apply-network-surface.sh`)
- [ ] Sync workflow tested (fetch, merge, verify, push)

**Verification**: Follow sync process from documentation and verify it works

## Base Distribution Requirements

- [ ] **No quant-specific features**: Base distribution contains only:
  - Product identity changes (Quantlab branding)
  - Marketplace configuration (Open VSX)
  - Network surface policy (no Microsoft endpoints)
  - Documentation and verification scripts
- [ ] **No additional functionality**: No features beyond upstream VS Code OSS
- [ ] **Clean fork**: Only allowed changes per base distribution definition:
  - Product identity
  - Network defaults
  - Packaging/CI
  - Verification scripts
  - Documentation
  - ADRs

**Verification**: Review codebase - no quant-specific features should exist

## Final Verification

- [ ] All items above are checked
- [ ] Latest CI run shows all jobs passing (green checkmarks)
- [ ] Artifacts are downloadable and functional
- [ ] Documentation is complete and accurate
- [ ] `./scripts/verify-all.sh` passes locally
- [ ] Ready for use or further development

## Completion Criteria

The base distribution is considered **complete** when:

1. ✅ All checklist items are verified
2. ✅ CI workflows pass on all platforms
3. ✅ Artifacts are built and downloadable
4. ✅ Documentation is complete
5. ✅ Verification scripts all pass
6. ✅ No quant-specific features (base only)

## Next Steps (Post-Base)

After base completion, you may:
- Add quant-specific features
- Customize UI/UX
- Add additional tooling
- Extend functionality

But the **base distribution** itself is complete when this checklist is satisfied.

## Related Documentation

- [Architecture Decision Records](adr/) - Key architectural decisions
- [Linux Development Build](build/linux-dev.md) - Building locally
- [Artifacts](release/artifacts.md) - Downloading and installing
- [CI Workflows](release/ci.md) - CI/CD documentation
- [Upstream Sync](upstream-sync.md) - Syncing with upstream

