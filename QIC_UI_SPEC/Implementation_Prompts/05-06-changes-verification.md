# Prompt 05-06: Changes & Diff Verification

**Phase:** 5 - Changes & Diff
**Dependencies:** 05-01 through 05-05
**Estimated Effort:** 0.5 sessions
**Critical Path:** Yes

---

## Objective

Comprehensively verify that all Phase 5 changes and diff components work correctly together. This verification ensures change cards, diff view, approval flow, CodeLens, and review mode function as a cohesive system before proceeding to Phase 6.

---

## Context

Phase 5 implemented the complete changes and diff system:
- **05-01**: Change Cards UI
- **05-02**: Diff View
- **05-03**: Approval Flow
- **05-04**: CodeLens Integration (optional)
- **05-05**: Review Mode (optional)

This verification ensures:
1. Change cards render correctly for all types
2. Diff view works with VS Code's diff editor
3. Apply/Reject flow functions properly
4. Changes are tracked and persisted
5. Integration between components is seamless

---

## Pre-Conditions

- [ ] 05-01 through 05-03 complete (critical)
- [ ] 05-04 and 05-05 complete if implemented
- [ ] All individual prompt verifications passed
- [ ] Extension loads without errors
- [ ] Git branch: `qic-ui/05-06-changes-verification`

---

## Verification Checklist

### 1. Change Cards UI (05-01)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 1.1 | Cards render | Agent proposes changes | Cards appear in message | ☐ |
| 1.2 | Create type | New file change | Green "New" badge | ☐ |
| 1.3 | Modify type | Modified file | Blue "Modified" badge | ☐ |
| 1.4 | Delete type | Deleted file | Red "Deleted" badge | ☐ |
| 1.5 | Rename type | Renamed file | Purple badge, both paths | ☐ |
| 1.6 | File path | Check card | Full path displayed | ☐ |
| 1.7 | Stats display | Check card | +N -N shown | ☐ |
| 1.8 | Icon correct | Each type | Correct icon | ☐ |
| 1.9 | Preview collapsed | Initial state | Preview hidden | ☐ |
| 1.10 | Preview expands | Click toggle | Preview shows | ☐ |
| 1.11 | Preview content | Check preview | Diff content visible | ☐ |
| 1.12 | View diff button | Click button | Diff opens | ☐ |
| 1.13 | Apply button | Click apply | Change applied | ☐ |
| 1.14 | Reject button | Click reject | Change rejected | ☐ |
| 1.15 | Applied state | After apply | Green border, no buttons | ☐ |
| 1.16 | Rejected state | After reject | Faded, no buttons | ☐ |
| 1.17 | Conflict state | Apply conflict | Warning state | ☐ |
| 1.18 | Multiple cards | 3+ changes | All render | ☐ |
| 1.19 | Apply All | Click button | All applied | ☐ |
| 1.20 | Reject All | Click button | All rejected | ☐ |

### 2. Diff View (05-02)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 2.1 | Opens from card | Click View Diff | VS Code diff opens | ☐ |
| 2.2 | Original side | Check left | Original content | ☐ |
| 2.3 | Modified side | Check right | New content | ☐ |
| 2.4 | Syntax highlight | Open .ts file | TypeScript colors | ☐ |
| 2.5 | New file | View create | Empty left side | ☐ |
| 2.6 | Deleted file | View delete | Empty right side | ☐ |
| 2.7 | Rename | View rename | Both paths in title | ☐ |
| 2.8 | Title correct | Check title | File name + type | ☐ |
| 2.9 | Description | Check description | Stats shown | ☐ |
| 2.10 | Apply button | In toolbar | Visible | ☐ |
| 2.11 | Reject button | In toolbar | Visible | ☐ |
| 2.12 | Apply from diff | Ctrl+Shift+A | Change applied | ☐ |
| 2.13 | Reject from diff | Ctrl+Shift+R | Change rejected | ☐ |
| 2.14 | Editor closes | After action | Diff editor closes | ☐ |
| 2.15 | Large file | View big diff | Performs well | ☐ |

### 3. Approval Flow (05-03)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 3.1 | Modal triggers | On dangerous change | Approval modal shows | ☐ |
| 3.2 | Change list | Check modal | All changes listed | ☐ |
| 3.3 | Approve button | Click approve | Changes applied | ☐ |
| 3.4 | Reject button | Click reject | Changes rejected | ☐ |
| 3.5 | Individual toggle | Uncheck one | One excluded | ☐ |
| 3.6 | View diff from modal | Click view | Diff opens | ☐ |
| 3.7 | Escape closes | Press Escape | Modal closes | ☐ |
| 3.8 | Click outside | Click backdrop | Modal closes | ☐ |
| 3.9 | Keyboard nav | Tab through | All accessible | ☐ |
| 3.10 | Status after | Check cards | Reflects approval | ☐ |

### 4. CodeLens (05-04) - If Implemented

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 4.1 | Lens appears | Open changed file | CodeLens visible | ☐ |
| 4.2 | Shows stats | Check lens | +N -N shown | ☐ |
| 4.3 | View action | Click view | Diff opens | ☐ |
| 4.4 | Apply action | Click apply | Change applied | ☐ |
| 4.5 | Reject action | Click reject | Change rejected | ☐ |
| 4.6 | Lens disappears | After action | CodeLens gone | ☐ |
| 4.7 | Multiple changes | File with 2 changes | 2 lens sections | ☐ |
| 4.8 | Disable setting | Set false | No CodeLens | ☐ |

### 5. Review Mode (05-05) - If Implemented

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 5.1 | Start review | Click review | Mode starts | ☐ |
| 5.2 | Progress bar | Check UI | Shows 1/N | ☐ |
| 5.3 | File name | Check UI | Current file shown | ☐ |
| 5.4 | Next | Alt+] | Next change | ☐ |
| 5.5 | Previous | Alt+[ | Previous change | ☐ |
| 5.6 | Apply | Alt+A | Applied, next | ☐ |
| 5.7 | Reject | Alt+R | Rejected, next | ☐ |
| 5.8 | Skip | Alt+S | Skipped, next | ☐ |
| 5.9 | End summary | Review all | Summary shown | ☐ |
| 5.10 | Exit | Escape | Mode closed | ☐ |

### 6. State Management

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 6.1 | Changes in state | Check state | Changes stored | ☐ |
| 6.2 | Status updates | Apply change | State updated | ☐ |
| 6.3 | Cards sync | State change | UI updates | ☐ |
| 6.4 | Persistence | Reload panel | Changes preserved | ☐ |
| 6.5 | Multiple sets | 2 change sets | Both tracked | ☐ |

### 7. Integration Tests

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 7.1 | Full apply flow | Card → Apply | File changed | ☐ |
| 7.2 | Full reject flow | Card → Reject | No change | ☐ |
| 7.3 | Diff → Apply | Diff → Apply | File changed | ☐ |
| 7.4 | CodeLens → Apply | Lens → Apply | File changed | ☐ |
| 7.5 | Review → Apply | Review mode | File changed | ☐ |
| 7.6 | Checkpoint created | Before apply | Checkpoint exists | ☐ |
| 7.7 | Undo via checkpoint | Restore | Original restored | ☐ |
| 7.8 | Mixed actions | Apply some, reject others | Correct outcome | ☐ |

### 8. File Operations

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8.1 | Create file | Apply create | File exists | ☐ |
| 8.2 | Modify file | Apply modify | Content changed | ☐ |
| 8.3 | Delete file | Apply delete | File gone | ☐ |
| 8.4 | Rename file | Apply rename | New name, old gone | ☐ |
| 8.5 | Nested create | Create in new dir | Dir + file created | ☐ |
| 8.6 | Binary file | Binary change | Handled gracefully | ☐ |

### 9. Error Handling

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 9.1 | File locked | Apply to locked | Error shown | ☐ |
| 9.2 | File modified | Apply to changed | Conflict detected | ☐ |
| 9.3 | Permission error | Read-only file | Error shown | ☐ |
| 9.4 | Missing parent | Create in nonexistent | Created or error | ☐ |
| 9.5 | Disk full | Simulate | Error shown | ☐ |

### 10. Accessibility

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 10.1 | Card focus | Tab to card | Focus visible | ☐ |
| 10.2 | Button focus | Tab to buttons | Focus on each | ☐ |
| 10.3 | Keyboard apply | Enter on Apply | Works | ☐ |
| 10.4 | Screen reader | Use NVDA/VO | Announces changes | ☐ |
| 10.5 | High contrast | Enable HC | All visible | ☐ |

---

## Automated Tests

### Unit Tests to Run

```bash
# Run all change-related tests
npm test -- --grep "Change"

# Run specific tests
npm test -- --grep "ChangeCardsManager"
npm test -- --grep "QicDiffService"
npm test -- --grep "ApprovalFlow"
npm test -- --grep "FileChange"
```

### Expected Test Results

| Test Suite | Expected | Actual | Pass |
|------------|----------|--------|------|
| ChangeCardsManager | All pass | | ☐ |
| QicDiffService | All pass | | ☐ |
| QicDiffDocumentProvider | All pass | | ☐ |
| ApprovalFlow | All pass | | ☐ |
| QicCodeLensProvider | All pass | | ☐ |
| QicReviewService | All pass | | ☐ |

---

## Performance Checks

| # | Metric | Target | Actual | Pass |
|---|--------|--------|--------|------|
| 1 | Card render (10 changes) | < 100ms | | ☐ |
| 2 | Diff open time | < 500ms | | ☐ |
| 3 | Apply change time | < 1s | | ☐ |
| 4 | Large diff (10K lines) | < 2s | | ☐ |
| 5 | Memory with 50 changes | Stable | | ☐ |

---

## Sign-Off

### Phase 5 Completion Criteria

- [ ] All critical sections passed (1-3, 6-9)
- [ ] Optional sections passed if implemented (4-5)
- [ ] All automated tests pass
- [ ] No P0 or P1 bugs
- [ ] File operations work correctly
- [ ] No regressions from Phase 4

### Approval

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer | | | |
| Reviewer | | | |
| QA | | | |

---

## Issues Found

| # | Severity | Description | Resolution | Status |
|---|----------|-------------|------------|--------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

---

## Notes

- Test with different file types and sizes
- Verify checkpoints are created before destructive changes
- Test conflict detection with externally modified files
- Ensure undo works via checkpoint restore
- CodeLens and Review Mode are optional enhancements

---

## Next Steps

After successful verification:
1. Merge Phase 5 branches to main
2. Tag release: `qic-ui-phase5-complete`
3. Update README with changes features
4. Begin Phase 6: Polish

---

## Summary Scorecard

| Section | Total | Passed | Percentage |
|---------|-------|--------|------------|
| 1. Change Cards UI | 20 | | |
| 2. Diff View | 15 | | |
| 3. Approval Flow | 10 | | |
| 4. CodeLens (if impl) | 8 | | |
| 5. Review Mode (if impl) | 10 | | |
| 6. State Management | 5 | | |
| 7. Integration | 8 | | |
| 8. File Operations | 6 | | |
| 9. Error Handling | 5 | | |
| 10. Accessibility | 5 | | |
| **Total (critical)** | **74** | | |
| **Total (with optional)** | **92** | | |

**Minimum Pass Rate:** 90% of critical tests

