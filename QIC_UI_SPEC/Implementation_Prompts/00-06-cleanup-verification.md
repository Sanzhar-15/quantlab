# Prompt 00-06: Cleanup Verification

**Phase:** 0 - Cleanup
**Dependencies:** 00-02, 00-03, 00-04, 00-05
**Estimated Effort:** 0.5 session
**Critical Path:** Yes

---

## Objective

Verify that all Phase 0 cleanup work is complete and the codebase is ready for Phase 1 (Foundation).

---

## Context

Phase 0 cleanup tasks:
- [x] 00-01: Dead code audit
- [x] 00-02: Remove dead HTML
- [x] 00-03: Remove dead JavaScript
- [x] 00-04: Remove dead CSS
- [x] 00-05: Fix status bar persistence

This prompt verifies all work and creates a clean baseline.

---

## Scope

### In Scope
- Verify all cleanup tasks complete
- Run comprehensive tests
- Document remaining issues
- Create git tag for clean baseline
- Update DEAD_CODE_INVENTORY.md with completion status

### Out of Scope
- Any new implementation
- Any fixes (create tickets instead)

---

## Pre-Conditions

- [ ] All Phase 0 prompts (00-02 through 00-05) marked complete
- [ ] All changes merged to feature branch

---

## Tasks

### 1. Code Verification

Run these checks:

```bash
# Build passes
npm run compile
echo "Build: $?"

# No dead HTML file
! test -f src/vs/workbench/contrib/qic/browser/media/chat.html && echo "chat.html removed: PASS"

# No dead references (from inventory)
echo "Checking dead references..."
grep -rn "getElementById.*connection-status" src/vs/workbench/contrib/qic/ && echo "FAIL" || echo "PASS"
grep -rn "getElementById.*provider-select" src/vs/workbench/contrib/qic/ && echo "FAIL" || echo "PASS"
grep -rn "getElementById.*context-btn" src/vs/workbench/contrib/qic/ && echo "FAIL" || echo "PASS"
```

### 2. Functional Verification

Manually test each feature:

| Feature | Test | Pass? |
|---------|------|-------|
| Panel opens | Click QIC icon | ☐ |
| Panel closes | Click X or toggle | ☐ |
| Status bar shows | When panel open | ☐ |
| Status bar hides | When panel closed | ☐ |
| Send message | Type and send | ☐ |
| Streaming | Response streams | ☐ |
| Cancel | Stop button works | ☐ |
| Menu | Opens and closes | ☐ |
| No console errors | Check DevTools | ☐ |

### 3. Regression Check

Compare current behavior with pre-cleanup:

- [ ] All features that worked before still work
- [ ] No new console errors
- [ ] No visual regressions
- [ ] Performance is same or better

### 4. Update Inventory

Update `DEAD_CODE_INVENTORY.md`:

```markdown
# Dead Code Inventory

## Status: CLEANUP COMPLETE

Cleanup performed: [DATE]
Prompts completed: 00-02, 00-03, 00-04, 00-05

## Summary
- Files deleted: X
- Lines removed: ~Y
- Issues fixed: Z

## Remaining Items (if any)
- [ ] Item that couldn't be addressed (reason)
```

### 5. Create Git Tag

```bash
# Create tag for clean baseline
git tag -a qic-ui/phase-0-complete -m "QIC UI Phase 0 Cleanup Complete"

# Push tag
git push origin qic-ui/phase-0-complete
```

### 6. Document Known Issues

If any issues were found but not fixed, create tickets:

```markdown
## Known Issues After Cleanup

1. **Issue**: [description]
   - **Severity**: Low/Medium/High
   - **Ticket**: [link]
   - **Notes**: [why not fixed now]
```

---

## Verification

### Success Criteria
- [ ] Build passes
- [ ] All functional tests pass
- [ ] No regressions
- [ ] DEAD_CODE_INVENTORY.md updated
- [ ] Git tag created
- [ ] Ready for Phase 1

### Final Checklist

```markdown
## Phase 0 Completion Checklist

### Code Quality
- [ ] No dead HTML files
- [ ] No dead JavaScript references
- [ ] No dead CSS rules
- [ ] Status bar lifecycle correct

### Testing
- [ ] Build passes
- [ ] Manual testing complete
- [ ] No console errors
- [ ] No regressions

### Documentation
- [ ] Inventory updated
- [ ] Known issues documented
- [ ] Git tag created

### Sign-off
- [ ] Ready for Phase 1: Foundation
```

---

## Output

After this prompt:
1. Clean codebase ready for new features
2. Git tag marking clean baseline
3. Documentation of what was cleaned
4. Any remaining issues tracked

---

## Next Steps

With Phase 0 complete, proceed to:
- **01-01-state-service-interfaces.md** - Begin Phase 1 Foundation
