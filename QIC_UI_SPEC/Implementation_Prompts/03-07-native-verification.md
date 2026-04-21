# Prompt 03-07: Native Integration Verification

**Phase:** 3 - Native Integration
**Dependencies:** 03-01 through 03-06
**Estimated Effort:** 0.5 sessions
**Critical Path:** Yes

---

## Objective

Comprehensively verify that all Phase 3 native integration components work correctly together. This verification ensures Quick Picks, status bar, and the removal of floating panels has been completed successfully before proceeding to Phase 4.

---

## Context

Phase 3 replaced custom floating panels with native VS Code Quick Picks:
- **03-01**: Quick Pick infrastructure
- **03-02**: History Quick Pick
- **03-03**: Checkpoints Quick Pick
- **03-04**: Provider Quick Pick
- **03-05**: Status Bar Update
- **03-06**: Remove Floating Panels

This verification prompt ensures:
1. All Quick Picks function correctly
2. Status bar displays accurate state
3. Floating panels are completely removed
4. No regressions in existing functionality
5. User flows work end-to-end

---

## Pre-Conditions

- [ ] 03-01 through 03-06 complete
- [ ] All individual prompt verifications passed
- [ ] Extension loads without errors
- [ ] Git branch: `qic-ui/03-07-native-verification`

---

## Verification Checklist

### 1. Quick Pick Infrastructure (03-01)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 1.1 | Menu renders | Click hamburger menu | 7-dot menu appears | ☐ |
| 1.2 | Menu keyboard | Press Ctrl+. | Menu opens | ☐ |
| 1.3 | Menu closes | Click outside | Menu closes | ☐ |
| 1.4 | Menu escape | Press Escape | Menu closes | ☐ |
| 1.5 | Menu items clickable | Click each item | Action triggers | ☐ |
| 1.6 | Icons display | View menu | Codicons visible | ☐ |
| 1.7 | No console errors | Open DevTools | No errors | ☐ |

### 2. History Quick Pick (03-02)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 2.1 | Opens from menu | Menu → History | Quick Pick opens | ☐ |
| 2.2 | Opens from command | Ctrl+Shift+H | Quick Pick opens | ☐ |
| 2.3 | Opens from palette | Cmd Palette → "QIC: History" | Quick Pick opens | ☐ |
| 2.4 | Empty state | No history exists | Notification shown | ☐ |
| 2.5 | Shows conversations | History exists | List displays | ☐ |
| 2.6 | Date grouping | Multiple dates | Grouped correctly | ☐ |
| 2.7 | Search works | Type in search box | List filters | ☐ |
| 2.8 | Select loads | Click conversation | Conversation loads | ☐ |
| 2.9 | Delete button | Click trash icon | Confirmation shows | ☐ |
| 2.10 | Delete confirms | Confirm delete | Item removed | ☐ |
| 2.11 | Delete cancels | Cancel delete | Item remains | ☐ |
| 2.12 | Export button | Click export icon | JSON copied | ☐ |
| 2.13 | Escape closes | Press Escape | Picker closes | ☐ |
| 2.14 | Relative time | Check timestamps | "2h ago" format | ☐ |

### 3. Checkpoints Quick Pick (03-03)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 3.1 | Opens from menu | Menu → Checkpoints | Quick Pick opens | ☐ |
| 3.2 | Opens from palette | Cmd Palette → "QIC: Checkpoints" | Quick Pick opens | ☐ |
| 3.3 | Empty state | No checkpoints | Notification shown | ☐ |
| 3.4 | Shows checkpoints | Checkpoints exist | List displays | ☐ |
| 3.5 | Sorted by date | Multiple checkpoints | Newest first | ☐ |
| 3.6 | File count shown | Check detail | "3 files" visible | ☐ |
| 3.7 | Preview button | Click eye icon | Files listed | ☐ |
| 3.8 | Select restores | Click checkpoint | Confirmation shows | ☐ |
| 3.9 | Restore confirms | Confirm restore | Files restored | ☐ |
| 3.10 | Restore shows files | Check confirmation | File list visible | ☐ |
| 3.11 | Delete button | Click trash icon | Confirmation shows | ☐ |
| 3.12 | Delete confirms | Confirm delete | Checkpoint removed | ☐ |
| 3.13 | Create manual | Cmd Palette → "QIC: Create Checkpoint" | Checkpoint created | ☐ |
| 3.14 | Escape closes | Press Escape | Picker closes | ☐ |

### 4. Provider Quick Pick (03-04)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 4.1 | Opens from menu | Menu → Provider | Quick Pick opens | ☐ |
| 4.2 | Opens from palette | Cmd Palette → "QIC: Switch Provider" | Quick Pick opens | ☐ |
| 4.3 | Current marked | Check list | Checkmark on current | ☐ |
| 4.4 | Cloud section | Check sections | "Cloud Providers" header | ☐ |
| 4.5 | Local section | Check sections | "Local / Offline" header | ☐ |
| 4.6 | Status shown | Check items | "Connected • 45ms" | ☐ |
| 4.7 | Degraded shown | Degrade provider | Warning indicator | ☐ |
| 4.8 | Unavailable shown | Provider down | Error indicator | ☐ |
| 4.9 | Switch works | Select different | Provider switches | ☐ |
| 4.10 | Same no-op | Select current | No change | ☐ |
| 4.11 | Unavailable warn | Select unavailable | Warning notification | ☐ |
| 4.12 | Model shown | Check description | Current model visible | ☐ |
| 4.13 | Escape closes | Press Escape | Picker closes | ☐ |

### 5. Status Bar (03-05)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 5.1 | Status visible | Check left status bar | "$(sparkle) QIC" visible | ☐ |
| 5.2 | Quota visible | Check right status bar | Token count visible | ☐ |
| 5.3 | Ready state | Service ready | Sparkle icon | ☐ |
| 5.4 | Initializing | Service starting | Spinner icon | ☐ |
| 5.5 | Processing | Send message | Spinner icon | ☐ |
| 5.6 | Waiting approval | Trigger approval | Bell icon | ☐ |
| 5.7 | Degraded | Degrade service | Warning icon + bg | ☐ |
| 5.8 | Error | Trigger error | Error icon + bg | ☐ |
| 5.9 | Suspended | Suspend session | Pause icon | ☐ |
| 5.10 | Click opens panel | Click status | Panel opens | ☐ |
| 5.11 | Keyboard toggle | Ctrl+Shift+Q | Panel toggles | ☐ |
| 5.12 | Quota < 75% | Check color | Default color | ☐ |
| 5.13 | Quota 75-90% | Simulate usage | Warning color | ☐ |
| 5.14 | Quota > 90% | Simulate usage | Error color | ☐ |
| 5.15 | Quota click | Click quota | Details notification | ☐ |
| 5.16 | Tooltip correct | Hover status | State description | ☐ |
| 5.17 | Tooltip quota | Hover quota | Usage details | ☐ |

### 6. Floating Panel Removal (03-06)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 6.1 | No history panel | Inspect DOM | No #history-panel | ☐ |
| 6.2 | No checkpoint panel | Inspect DOM | No #checkpoint-panel | ☐ |
| 6.3 | No settings panel | Inspect DOM | No #settings-panel | ☐ |
| 6.4 | No overlay | Inspect DOM | No .panel-overlay | ☐ |
| 6.5 | History → Quick Pick | Click History | Quick Pick opens | ☐ |
| 6.6 | Checkpoints → Quick Pick | Click Checkpoints | Quick Pick opens | ☐ |
| 6.7 | Settings → VS Code | Click Settings | VS Code settings | ☐ |
| 6.8 | No panel CSS | Search chat.css | No .floating-panel | ☐ |
| 6.9 | No panel JS | Search main.js | No showHistoryPanel | ☐ |
| 6.10 | No console errors | Test all actions | No errors | ☐ |

### 7. Integration Tests

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 7.1 | Full history flow | Create conversation → History → Load | Works | ☐ |
| 7.2 | Full checkpoint flow | Make change → Create → Restore | Works | ☐ |
| 7.3 | Provider switch flow | Switch → Send message | New provider used | ☐ |
| 7.4 | Status reflects agent | Send → Processing → Idle | Status updates | ☐ |
| 7.5 | Quota updates | Send messages | Quota increases | ☐ |
| 7.6 | Panel + Quick Pick | Toggle panel, open Quick Pick | Both work | ☐ |
| 7.7 | Keyboard shortcuts | All shortcuts | All work | ☐ |
| 7.8 | Command palette | All QIC commands | All work | ☐ |

### 8. State Consistency

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8.1 | Status syncs | Change state | Status bar updates | ☐ |
| 8.2 | Quick Pick reflects state | Open after changes | Current state shown | ☐ |
| 8.3 | Webview syncs | Change via Quick Pick | Webview updates | ☐ |
| 8.4 | Reload preserves | Reload webview | State preserved | ☐ |
| 8.5 | Multi-window | Open second window | Each has own state | ☐ |

### 9. Error Handling

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 9.1 | History load error | Simulate error | Error notification | ☐ |
| 9.2 | Checkpoint restore error | Simulate error | Error notification | ☐ |
| 9.3 | Provider switch error | Simulate error | Error notification | ☐ |
| 9.4 | Quota unavailable | No quota data | Graceful handling | ☐ |
| 9.5 | Network error | Disconnect | Degraded status | ☐ |

### 10. Accessibility

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 10.1 | Keyboard navigation | Tab through | All accessible | ☐ |
| 10.2 | Screen reader | Enable VoiceOver/NVDA | Announces correctly | ☐ |
| 10.3 | ARIA labels | Inspect elements | Labels present | ☐ |
| 10.4 | Focus indicators | Tab through | Focus visible | ☐ |
| 10.5 | High contrast | Enable HC mode | All visible | ☐ |

---

## Automated Tests

### Unit Tests to Run

```bash
# Run all QIC tests
npm test -- --grep "QIC"

# Run Quick Pick specific tests
npm test -- --grep "QuickPick"

# Run status bar tests
npm test -- --grep "StatusBar"

# Run state service tests
npm test -- --grep "QicStateService"
```

### Integration Tests to Run

```bash
# Run integration tests
npm run test:integration -- --grep "QIC"
```

### Expected Test Results

| Test Suite | Expected | Actual | Pass |
|------------|----------|--------|------|
| QicStateService | All pass | | ☐ |
| HistoryQuickPick | All pass | | ☐ |
| CheckpointQuickPick | All pass | | ☐ |
| ProviderQuickPick | All pass | | ☐ |
| QicStatusBarItem | All pass | | ☐ |
| QicPanel | All pass | | ☐ |

---

## Performance Checks

| # | Metric | Target | Actual | Pass |
|---|--------|--------|--------|------|
| 1 | Quick Pick open time | < 100ms | | ☐ |
| 2 | History load time (100 items) | < 200ms | | ☐ |
| 3 | Status bar update time | < 16ms | | ☐ |
| 4 | Memory after Quick Picks | No leaks | | ☐ |
| 5 | Bundle size reduction | Reduced | | ☐ |

---

## Code Quality Checks

```bash
# Run linter
npm run lint

# Type check
npm run typecheck

# Check for unused exports
# (Manual review of removed code)

# Verify no TODO comments for Phase 3
grep -rn "TODO: 03-" src/vs/workbench/contrib/qic/
```

---

## Sign-Off

### Phase 3 Completion Criteria

- [ ] All 10 verification sections passed (100%)
- [ ] All automated tests pass
- [ ] No P0 or P1 bugs
- [ ] Performance targets met
- [ ] Code quality checks pass
- [ ] No regressions from Phase 2

### Approval

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer | | | |
| Reviewer | | | |
| QA | | | |

---

## Issues Found

Document any issues discovered during verification:

| # | Severity | Description | Resolution | Status |
|---|----------|-------------|------------|--------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

---

## Notes

- Run verification on multiple platforms (Windows, macOS, Linux) if possible
- Test with different VS Code themes (light, dark, high contrast)
- Test with different extension configurations
- Document any edge cases discovered
- Update prompts if verification reveals missing functionality

---

## Next Steps

After successful verification:
1. Merge Phase 3 branches to main
2. Tag release: `qic-ui-phase3-complete`
3. Update README with new features
4. Begin Phase 4: Context System

---

## Summary Scorecard

| Section | Total | Passed | Percentage |
|---------|-------|--------|------------|
| 1. Quick Pick Infra | 7 | | |
| 2. History Quick Pick | 14 | | |
| 3. Checkpoints Quick Pick | 14 | | |
| 4. Provider Quick Pick | 13 | | |
| 5. Status Bar | 17 | | |
| 6. Panel Removal | 10 | | |
| 7. Integration | 8 | | |
| 8. State Consistency | 5 | | |
| 9. Error Handling | 5 | | |
| 10. Accessibility | 5 | | |
| **Total** | **98** | | |

**Minimum Pass Rate:** 95% (93/98 tests)

