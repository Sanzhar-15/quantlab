# ADR-0004: Upstream Sync Policy

## Status

Accepted

## Context

Quantlab is a fork of microsoft/vscode (VS Code OSS). To maintain compatibility, security updates, and access to new features, we need a strategy to regularly sync with upstream changes. This includes:

- Merging upstream commits into our fork
- Resolving conflicts while preserving Quantlab-specific changes
- Verifying that syncs don't break our identity, marketplace, or network policies
- Ensuring CI continues to pass after syncs

The sync process must be:
- Repeatable and documented
- Verifiable (automated checks)
- Safe (doesn't break existing functionality)
- Efficient (minimal manual work)

## Decision

Implement a regular upstream sync workflow with automated verification:

1. **Sync Method**: Regular merges from `upstream/main` (or specific upstream tags for versioned syncs)
2. **Verification**: Run `scripts/verify-all.sh` after each sync to ensure all checks pass
3. **Conflict Resolution**: Manually resolve conflicts, prioritizing Quantlab identity and configuration
4. **CI Validation**: Push to trigger CI, which runs smoke tests and packaging jobs
5. **Documentation**: Maintain clear documentation of the sync process

### Sync Workflow

1. `git fetch upstream` - Get latest upstream changes
2. `git checkout main` - Ensure on main branch
3. `git merge upstream/main` - Merge upstream changes
4. Resolve conflicts if any (preserve Quantlab identity)
5. `./scripts/verify-all.sh` - Run comprehensive verification
6. `git push origin main` - Push and rely on CI for final validation

## Rationale

1. **Maintainability**: Regular syncs prevent large merge conflicts
2. **Security**: Get security fixes and updates from upstream
3. **Compatibility**: Stay compatible with VS Code extension ecosystem
4. **Automation**: Verification scripts catch issues before pushing
5. **CI Safety**: CI provides final validation on all platforms

## Consequences

### Positive

- Regular access to upstream improvements and fixes
- Automated verification catches issues early
- Clear process reduces errors
- CI validates on all platforms
- Maintains compatibility with VS Code ecosystem

### Negative

- Requires manual conflict resolution
- Verification must pass before pushing
- Syncs may introduce breaking changes that need investigation
- Time investment for regular syncs

### Risks

- **Risk**: Upstream changes break Quantlab-specific modifications
  - **Mitigation**: Verification scripts catch this, CI validates on all platforms

- **Risk**: Conflicts in critical files (product.json, build scripts)
  - **Mitigation**: Clear documentation on conflict resolution, identity scripts can restore branding

- **Risk**: Upstream changes require updates to our scripts
  - **Mitigation**: Scripts are designed to be resilient, verification catches failures

- **Risk**: Sync frequency too low (large conflicts) or too high (maintenance burden)
  - **Mitigation**: Document recommended sync frequency, adjust based on upstream activity

## Alternatives Considered

### Rebase Instead of Merge

- **Description**: Use `git rebase` instead of `git merge` for cleaner history
- **Rejected because**: Rewrites history, more complex conflict resolution, harder to track upstream changes

### Cherry-Pick Specific Commits

- **Description**: Only cherry-pick security fixes and specific features
- **Rejected because**: Time-consuming, easy to miss important changes, doesn't maintain full compatibility

### Separate Sync Branch

- **Description**: Maintain separate branch for upstream syncs, merge to main after verification
- **Rejected because**: Adds complexity, merge workflow is sufficient

### Automated Sync with CI

- **Description**: Automate syncs via GitHub Actions
- **Rejected because**: Requires conflict resolution automation (complex), manual review is safer

## Implementation

- **Documentation**: [`docs/upstream-sync.md`](../upstream-sync.md)
- **Verification Script**: [`scripts/verify-all.sh`](../../scripts/verify-all.sh)
- **Identity Restoration**: [`scripts/apply-identity.sh`](../../scripts/apply-identity.sh)
- **Marketplace Restoration**: [`scripts/apply-marketplace.sh`](../../scripts/apply-marketplace.sh)
- **Network Surface Restoration**: [`scripts/apply-network-surface.sh`](../../scripts/apply-network-surface.sh)

## References

- [Upstream Sync Strategy](../upstream-sync.md)
- [ADR-0001: Quantlab Identity](./0001-quantlab-identity.md)
- [ADR-0002: Open VSX Marketplace](./0002-open-vsx-marketplace.md)
- [ADR-0003: Network Surface Policy](./0003-network-surface-policy.md)

