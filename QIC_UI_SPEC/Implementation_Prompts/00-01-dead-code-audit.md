# Prompt 00-01: Dead Code Audit

**Phase:** 0 - Cleanup
**Dependencies:** None
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Perform a comprehensive audit of dead code in the QIC UI implementation. This audit will inform all subsequent cleanup prompts.

---

## Context

The current QIC implementation has accumulated dead code:
- `chat.html` file that is never loaded (HTML is inline in `qicPanel.ts`)
- JavaScript references to non-existent DOM elements
- CSS rules for elements that don't exist
- Status bar items that persist after panel closure

---

## Scope

### In Scope
- Audit `src/vs/workbench/contrib/qic/browser/media/chat.html`
- Audit inline HTML in `src/vs/workbench/contrib/qic/browser/qicPanel.ts` (lines 426-597)
- Audit JavaScript in qicPanel.ts for dead DOM references
- Audit CSS in `src/vs/workbench/contrib/qic/browser/media/chat.css`
- Document status bar lifecycle issues
- Create dead code inventory

### Out of Scope
- Actually removing code (done in subsequent prompts)
- Backend/runtime code audit
- Test file audit

---

## Tasks

### 1. Audit HTML Sources

**File:** `src/vs/workbench/contrib/qic/browser/media/chat.html`

Check:
- [ ] Is this file imported anywhere?
- [ ] Is this file referenced in `package.json` or build config?
- [ ] What elements does it define?

**File:** `src/vs/workbench/contrib/qic/browser/qicPanel.ts`

Check:
- [ ] Where is inline HTML defined? (Look for `getWebviewHtml()` or similar)
- [ ] What DOM IDs are created?
- [ ] Create a list of all element IDs in the actual template

### 2. Audit JavaScript References

In `qicPanel.ts` and any webview scripts, find all:
```javascript
document.getElementById('...')
document.querySelector('...')
$('#...') // if jQuery is used
```

Cross-reference with actual DOM IDs from step 1.

**Expected Dead References (from prior analysis):**
- `#connection-status`
- `#provider-select`
- `#context-btn`
- `#checkpoint-btn`
- `#settings-btn`
- `#floating-context-panel`
- `#floating-settings-panel`
- `#floating-checkpoint-panel`

### 3. Audit CSS Rules

In `chat.css`, identify:
- [ ] Rules targeting IDs that don't exist
- [ ] Rules targeting classes that don't exist
- [ ] Rules that are duplicated
- [ ] Rules overridden and never applied

### 4. Audit Status Bar Lifecycle

In `qicPanel.ts` or related files:
- [ ] Where is status bar item created?
- [ ] Is it disposed when panel is closed?
- [ ] Is it disposed when panel is hidden?
- [ ] What cleanup should happen?

### 5. Create Inventory Document

Create a file `DEAD_CODE_INVENTORY.md` with:

```markdown
# Dead Code Inventory

## Files to Delete
- [ ] path/to/file - reason

## Dead HTML Elements
| Element ID | File | Line | Reason |
|------------|------|------|--------|
| ... | ... | ... | ... |

## Dead JavaScript References
| Reference | File | Line | Missing Element |
|-----------|------|------|-----------------|
| ... | ... | ... | ... |

## Dead CSS Rules
| Selector | File | Line | Reason |
|----------|------|------|--------|
| ... | ... | ... | ... |

## Lifecycle Issues
| Issue | File | Line | Fix |
|-------|------|------|-----|
| ... | ... | ... | ... |
```

---

## Verification

### Success Criteria
- [ ] All HTML sources identified and documented
- [ ] All dead JS references documented with line numbers
- [ ] All dead CSS rules documented
- [ ] Status bar lifecycle issue documented
- [ ] `DEAD_CODE_INVENTORY.md` created in `QIC_UI_SPEC/` folder

### Verification Commands
```bash
# Verify inventory file exists
ls -la QIC_UI_SPEC/DEAD_CODE_INVENTORY.md

# Verify it has content
wc -l QIC_UI_SPEC/DEAD_CODE_INVENTORY.md
```

---

## Output

The primary output is `DEAD_CODE_INVENTORY.md` which will be used by:
- `00-02-remove-dead-html.md`
- `00-03-remove-dead-javascript.md`
- `00-04-remove-dead-css.md`
- `00-05-fix-status-bar-persistence.md`

---

## Rollback

This is an audit-only prompt. No code changes are made, so no rollback is needed.

---

## Notes

- Be thorough - missing dead code now means cleanup debt later
- When in doubt, mark as "possibly dead - verify"
- Document any code that LOOKS dead but might be dynamically used
