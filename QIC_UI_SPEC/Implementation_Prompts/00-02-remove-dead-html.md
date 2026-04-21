# Prompt 00-02: Remove Dead HTML

**Phase:** 0 - Cleanup
**Dependencies:** 00-01 (Dead Code Audit)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Remove the dead `chat.html` file and clean up any references to it. This is safe because the actual HTML is defined inline in `qicPanel.ts`.

---

## Context

From the audit (00-01), we know:
- `chat.html` exists but is never loaded
- The real HTML template is inline in `qicPanel.ts` `getWebviewHtml()` method
- There may be build config or imports referencing `chat.html`

---

## Scope

### In Scope
- Delete `src/vs/workbench/contrib/qic/browser/media/chat.html`
- Remove any imports/references to `chat.html`
- Update build configuration if needed
- Verify no runtime errors

### Out of Scope
- Modifying the inline HTML in qicPanel.ts
- Removing JavaScript or CSS
- Any functional changes

---

## Pre-Conditions

- [ ] `00-01-dead-code-audit.md` is complete
- [ ] `DEAD_CODE_INVENTORY.md` confirms `chat.html` is dead
- [ ] Git branch created: `qic-ui/00-02-remove-dead-html`

---

## Tasks

### 1. Search for References

```bash
# Search for any references to chat.html
grep -r "chat.html" src/vs/workbench/contrib/qic/
grep -r "chat.html" build/
grep -r "chat.html" *.json
```

Document all found references.

### 2. Delete the File

```bash
rm src/vs/workbench/contrib/qic/browser/media/chat.html
```

### 3. Remove References

For each reference found in step 1:
- If it's an import, remove the import
- If it's a build config, remove the entry
- If it's a comment, update or remove the comment

### 4. Verify Build

```bash
# Run the build
npm run compile
# or
yarn compile
```

Ensure no build errors related to the removed file.

### 5. Verify Runtime

1. Start VS Code with the extension
2. Open QIC panel
3. Verify panel renders correctly
4. Check DevTools console for errors

---

## Verification

### Success Criteria
- [ ] `chat.html` file deleted
- [ ] No references to `chat.html` in codebase
- [ ] Build passes without errors
- [ ] QIC panel renders correctly
- [ ] No console errors related to missing file

### Verification Commands
```bash
# Verify file is gone
! test -f src/vs/workbench/contrib/qic/browser/media/chat.html && echo "File deleted"

# Verify no references remain
grep -r "chat.html" src/vs/workbench/contrib/qic/ || echo "No references found"

# Build check
npm run compile 2>&1 | grep -i error || echo "Build passed"
```

---

## Rollback

If issues arise:
```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.html
git checkout -- .  # Restore all changes
```

---

## Code Changes

### Files to Modify
| File | Change |
|------|--------|
| `src/vs/workbench/contrib/qic/browser/media/chat.html` | DELETE |
| (any files with references) | Remove reference |

### Expected Diff Size
- ~1 file deleted
- 0-2 files modified (if references exist)

---

## Notes

- This is a safe, low-risk change
- If build fails, check for unexpected dependencies
- The inline HTML in qicPanel.ts is the source of truth
