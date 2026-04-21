# Prompt 00-04: Remove Dead CSS

**Phase:** 0 - Cleanup
**Dependencies:** 00-03 (Remove Dead JavaScript)
**Estimated Effort:** 1 session
**Critical Path:** No (but recommended)

---

## Objective

Remove CSS rules that target non-existent elements or are never applied. This reduces CSS file size and prevents confusion.

---

## Context

From the audit (00-01), dead CSS includes:
- Rules targeting removed element IDs
- Rules for floating panels that don't exist
- Duplicate/overridden rules
- Rules for classes no longer used

---

## Scope

### In Scope
- Remove CSS rules targeting non-existent elements
- Remove duplicate rules
- Remove rules for removed features
- Consolidate related rules if trivial

### Out of Scope
- Redesigning CSS architecture
- Adding new styles
- Changing existing visual appearance
- CSS variable changes

---

## Pre-Conditions

- [ ] `00-03-remove-dead-javascript.md` is complete
- [ ] `DEAD_CODE_INVENTORY.md` lists dead CSS rules
- [ ] Git branch created: `qic-ui/00-04-remove-dead-css`

---

## Tasks

### 1. List All CSS Selectors

Extract all selectors from the CSS file:

```bash
# Extract selectors (rough)
grep -E '^\s*[.#]?[a-zA-Z]' src/vs/workbench/contrib/qic/browser/media/chat.css
```

### 2. Cross-Reference with HTML

For each selector, verify it has a matching element in the inline HTML:

| Selector | Exists in HTML? | Status |
|----------|-----------------|--------|
| `.qic-header` | Yes | Keep |
| `#connection-status` | No | Remove |
| `.floating-panel` | No | Remove |
| ... | ... | ... |

### 3. Remove Dead Rules

Remove entire rule blocks for dead selectors:

```css
/* REMOVE - element doesn't exist */
#connection-status {
    display: flex;
    align-items: center;
    /* ... */
}

/* REMOVE - floating panels removed */
.floating-panel {
    position: absolute;
    /* ... */
}
```

### 4. Remove Dead Animations

If animations are only used by removed elements:

```css
/* REMOVE - only used by removed elements */
@keyframes connection-pulse {
    0% { opacity: 0.5; }
    50% { opacity: 1; }
    100% { opacity: 0.5; }
}
```

### 5. Clean Up Comments

Remove or update comments that reference removed elements:

```css
/* REMOVE this comment */
/* Styles for connection status indicator */

/* UPDATE this comment */
/* Old: Styles for floating panels */
/* New: (remove entirely or update) */
```

### 6. Verify Visual Consistency

After removal:
1. Open QIC panel
2. Screenshot before and after
3. Compare - should be identical
4. Test all visual states (hover, focus, disabled)

---

## Verification

### Success Criteria
- [ ] All dead CSS rules removed (per inventory)
- [ ] No visual regressions
- [ ] CSS file size reduced
- [ ] No console warnings about missing styles
- [ ] All interactive states still work

### Verification Commands
```bash
# Check file size reduction
wc -c src/vs/workbench/contrib/qic/browser/media/chat.css

# Verify no references to removed elements
grep -n "connection-status" src/vs/workbench/contrib/qic/browser/media/chat.css
grep -n "floating-panel" src/vs/workbench/contrib/qic/browser/media/chat.css

# Build
npm run compile
```

### Visual Verification
1. Take screenshot of QIC panel BEFORE changes
2. Make changes
3. Take screenshot AFTER changes
4. Compare screenshots - should be identical

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Code Changes

### Files to Modify
| File | Change Type | Estimated Lines |
|------|-------------|-----------------|
| `chat.css` | Remove dead rules | -30 to -100 |

---

## Notes

- CSS removal is lower risk than JS removal
- If unsure about a rule, leave it (can be cleaned up later)
- Use browser DevTools to verify which rules are actually applied
- Some rules may look dead but are applied dynamically - verify first
