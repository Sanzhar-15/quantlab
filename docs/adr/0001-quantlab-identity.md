# ADR-0001: Quantlab Identity and Branding

## Status

Accepted

## Context

Quantlab is a fork of VS Code OSS (microsoft/vscode) that requires complete rebranding from "Code - OSS" to "Quantlab" while maintaining compatibility with the upstream codebase. This includes:

- Product names and identifiers
- Application executable names
- Data folder names
- Icons and desktop files
- URL protocols
- Bundle identifiers (macOS)
- Windows App User Model IDs

The rebranding must be:
- Consistent across all platforms (Linux, Windows, macOS)
- Maintainable and easy to update
- Verifiable through automated scripts
- Preserved during upstream syncs

## Decision

Use a centralized identity configuration file (`config/quantlab.identity.env`) as the single source of truth for all Quantlab branding. Apply this identity through an automated script (`scripts/apply-identity.sh`) that patches `product.json` and related files.

### Key Components

1. **Configuration File**: `config/quantlab.identity.env`
   - Contains all identity values (APP_NAME, APPLICATION_NAME, data folders, etc.)
   - Single source of truth for branding

2. **Application Script**: `scripts/apply-identity.sh`
   - Reads from `config/quantlab.identity.env`
   - Patches `product.json` with Quantlab values
   - Updates icons, desktop files, and other platform-specific files
   - Preserves upstream structure while replacing branding

3. **Verification Script**: `scripts/verify-identity.sh`
   - Validates that `product.json` matches `config/quantlab.identity.env`
   - Ensures consistency across all identity fields

## Rationale

1. **Centralized Configuration**: All branding values in one place makes maintenance simple
2. **Scriptable**: Automated application ensures consistency and reduces human error
3. **Verifiable**: Automated verification catches identity drift
4. **Upstream-Safe**: Scripts can be re-run after upstream syncs to restore identity
5. **Platform-Agnostic**: Same configuration works across Linux, Windows, and macOS

## Consequences

### Positive

- Single source of truth eliminates inconsistencies
- Easy to update branding (change one file, re-run script)
- Automated verification catches identity issues early
- Identity can be restored after upstream merges
- Clear separation between upstream code and Quantlab branding

### Negative

- Requires running `apply-identity.sh` after upstream syncs
- Must resolve conflicts in `product.json` carefully to preserve identity
- Identity configuration must be maintained separately from upstream

### Risks

- **Risk**: Identity lost during upstream merge conflicts
  - **Mitigation**: `verify-identity.sh` catches this, and `apply-identity.sh` can restore it

- **Risk**: Upstream changes to identity-related code break our scripts
  - **Mitigation**: Scripts patch only existing keys, preserving upstream structure

- **Risk**: Manual edits to `product.json` override identity
  - **Mitigation**: Verification script warns about mismatches

## Alternatives Considered

### Manual Editing of product.json

- **Description**: Manually edit `product.json` and related files each time
- **Rejected because**: Error-prone, hard to maintain, easy to miss files, doesn't scale

### Fork-Specific product.json Branch

- **Description**: Maintain a separate branch with Quantlab `product.json`
- **Rejected because**: Complex merge strategy, conflicts with upstream changes, harder to sync

### Build-Time Configuration

- **Description**: Use environment variables or build flags to set identity
- **Rejected because**: Requires build system changes, harder to verify, less explicit

## Implementation

- **Configuration**: [`config/quantlab.identity.env`](../../config/quantlab.identity.env)
- **Application Script**: [`scripts/apply-identity.sh`](../../scripts/apply-identity.sh)
- **Verification Script**: [`scripts/verify-identity.sh`](../../scripts/verify-identity.sh)
- **Related Documentation**: [Upstream Sync Strategy](../upstream-sync.md)

## References

- [VS Code Product Configuration](https://github.com/microsoft/vscode/blob/main/product.json)
- [ADR-0004: Upstream Sync Policy](./0004-upstream-sync-policy.md)

