# Upstream Sync Strategy

This document describes the process for syncing Quantlab with upstream VS Code (microsoft/vscode).

## Prerequisites

1. Ensure you have the `upstream` remote configured:
   ```bash
   git remote add upstream https://github.com/microsoft/vscode.git
   ```
   Or verify it exists:
   ```bash
   git remote -v
   ```

2. Ensure you're on the `main` branch and have a clean working tree:
   ```bash
   git status
   ```

## Sync Process

### Step 1: Fetch Latest from Upstream

```bash
git fetch upstream
```

This downloads all the latest commits, branches, and tags from microsoft/vscode without modifying your local branches.

### Step 2: Switch to Main Branch

```bash
git checkout main
```

Ensure you're on the main branch before merging.

### Step 3: Merge Upstream Changes

**Option A: Merge from upstream/main (recommended for regular syncs)**

```bash
git merge upstream/main
```

**Option B: Merge from a specific upstream tag (for versioned syncs)**

```bash
# First, list available tags
git fetch upstream --tags
git tag -l | grep "^1\." | sort -V | tail -10

# Then merge from a specific tag
git merge upstream/<tag-name>
# Example: git merge upstream/1.108.0
```

### Step 4: Resolve Conflicts (if any)

If there are merge conflicts:

1. **Identify conflicted files:**
   ```bash
   git status
   ```

2. **Resolve conflicts manually:**
   - Open conflicted files in your editor
   - Look for conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`
   - Resolve each conflict by choosing the appropriate code
   - Remove conflict markers

3. **Stage resolved files:**
   ```bash
   git add <resolved-file>
   ```

4. **Complete the merge:**
   ```bash
   git commit
   ```

### Step 5: Run Verification Scripts

Before pushing, run the comprehensive verification suite:

```bash
./scripts/verify-all.sh
```

This will run all verification scripts:
- `scripts/preflight.sh` - Environment and configuration checks
- `scripts/verify-build.sh` - Build artifact verification
- `scripts/verify-identity.sh` - Product identity verification
- `scripts/verify-network-surface.sh` - Network safety verification
- `scripts/verify-marketplace.sh` - Marketplace configuration verification
- `scripts/verify-artifacts.sh` - Artifact verification (if artifacts exist locally)

**Important:** If any verification fails, fix the issues before proceeding.

### Step 6: Push and Rely on CI

Once all verifications pass:

```bash
git push origin main
```

The CI workflow (`.github/workflows/quantlab-ci.yml`) will automatically:
- Run smoke tests on all platforms (Windows, macOS, Linux)
- Build and package artifacts
- Verify everything passes

Monitor the CI run at: https://github.com/Sanzhar-15/quantlab/actions

## Best Practices

1. **Sync regularly:** Keep your fork up-to-date with upstream to minimize conflicts
2. **Test before pushing:** Always run `verify-all.sh` locally before pushing
3. **Review changes:** Use `git log upstream/main..main` to see what changed
4. **Tag important syncs:** Consider tagging successful syncs for reference:
   ```bash
   git tag -a sync-$(date +%Y%m%d) -m "Synced with upstream/main"
   ```

## Troubleshooting

### Upstream remote not configured

If you see "fatal: 'upstream' does not appear to be a git repository":

```bash
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream
```

### Merge conflicts in product.json

If `product.json` has conflicts, you likely need to preserve Quantlab's identity:

1. Resolve conflicts by keeping Quantlab-specific values:
   - `nameShort: "Quantlab"`
   - `applicationName: "quantlab"`
   - `tunnelApplicationName: "quantlab-tunnel"`
   - Other Quantlab-specific branding

2. After resolving, verify identity:
   ```bash
   ./scripts/verify-identity.sh
   ```

### Verification failures

If `verify-all.sh` fails:

1. Check which specific script failed
2. Review the error output
3. Fix the underlying issue
4. Re-run `verify-all.sh` to confirm

### CI failures after sync

If CI fails after pushing:

1. Check the failed job logs in GitHub Actions
2. Compare with previous successful runs
3. Identify what changed in the sync
4. Fix issues and push again

## Related Documentation

- [CI Workflows](release/ci.md) - Details about automated CI verification
- [Build Preflight](BUILD_PREFLIGHT.md) - Preflight checks documentation
- [Verification Scripts](../scripts/README.md) - Individual verification script details

