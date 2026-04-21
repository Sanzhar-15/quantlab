# Prompt 06-06: Final Verification

**Phase:** 6 - Polish
**Dependencies:** 06-01 through 06-05
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Perform comprehensive verification that the new QIC UI is complete, functional, beautiful, and optimal. This is the gate before declaring the implementation complete.

---

## Context

After 6 phases of work:
- Phase 0: Cleanup
- Phase 1: Foundation (state, protocol)
- Phase 2: Panel structure
- Phase 3: Native integration (Quick Picks)
- Phase 4: Context system
- Phase 5: Changes & diff
- Phase 6: Polish (accessibility, animations, edge cases, errors)

This prompt verifies everything works together.

---

## Scope

### In Scope
- Full functional testing
- Accessibility audit
- Performance testing
- Visual regression testing
- Edge case testing
- Cross-theme testing
- Documentation verification

### Out of Scope
- Fixing issues (create tickets)
- New features
- Legacy code removal (next prompt)

---

## Tasks

### 1. Functional Testing

#### Core Features

| Feature | Test | Status |
|---------|------|--------|
| **Panel** | | |
| Open panel | Click QIC icon | ☐ |
| Close panel | Click X or toggle | ☐ |
| Resize panel | Drag edge | ☐ |
| New conversation | Click + | ☐ |
| **Messaging** | | |
| Send message | Type and submit | ☐ |
| Streaming | Observe smooth streaming | ☐ |
| Cancel | Click stop during stream | ☐ |
| Edit message | Click edit, modify, resend | ☐ |
| Regenerate | Click regenerate | ☐ |
| Branch switch | Click branch pill | ☐ |
| **Context** | | |
| @ mention file | Type @file | ☐ |
| @ mention symbol | Type @symbol | ☐ |
| Context chips | Verify chips appear | ☐ |
| Pin context | Click pin | ☐ |
| Remove context | Click X | ☐ |
| Context drawer | Open drawer | ☐ |
| Token count | Verify accurate | ☐ |
| **Changes** | | |
| Accept change | Click Accept | ☐ |
| Reject change | Click Reject | ☐ |
| Accept all | Click Accept All | ☐ |
| View diff | Click change card | ☐ |
| **Permissions** | | |
| Allow once | Select Once | ☐ |
| Allow session | Select Session | ☐ |
| Allow always | Select Always | ☐ |
| Deny | Click Deny | ☐ |
| **Quick Picks** | | |
| History | Cmd+Shift+H | ☐ |
| Checkpoints | Menu → Checkpoints | ☐ |
| Provider | Menu → Provider | ☐ |
| Status | Click status button | ☐ |
| **Status Bar** | | |
| Shows status | Check status bar | ☐ |
| Disappears on close | Close panel, check | ☐ |
| Click opens panel | Click status item | ☐ |

### 2. Accessibility Testing

#### WCAG 2.1 Checklist

| Criterion | Test | Status |
|-----------|------|--------|
| **Perceivable** | | |
| 1.1.1 Non-text Content | Icons have labels | ☐ |
| 1.3.1 Info and Relationships | Proper headings | ☐ |
| 1.4.1 Use of Color | Not only color | ☐ |
| 1.4.3 Contrast | 4.5:1 minimum | ☐ |
| 1.4.4 Resize Text | 200% zoom works | ☐ |
| **Operable** | | |
| 2.1.1 Keyboard | All keyboard accessible | ☐ |
| 2.1.2 No Keyboard Trap | Can tab out | ☐ |
| 2.4.3 Focus Order | Logical tab order | ☐ |
| 2.4.6 Headings | Descriptive headings | ☐ |
| 2.4.7 Focus Visible | Clear focus indicator | ☐ |
| **Understandable** | | |
| 3.2.1 On Focus | No surprise changes | ☐ |
| 3.3.1 Error Identification | Errors identified | ☐ |
| **Robust** | | |
| 4.1.2 Name, Role, Value | ARIA labels correct | ☐ |

#### Screen Reader Test
1. Enable VoiceOver (Mac) or NVDA (Windows)
2. Navigate entire UI
3. Verify all elements announced correctly
4. Verify live regions work during streaming

### 3. Performance Testing

#### Metrics to Measure

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Panel open time | <200ms | | ☐ |
| First message render | <100ms | | ☐ |
| Streaming FPS | 60fps | | ☐ |
| Context switch time | <500ms | | ☐ |
| Memory after 10 messages | <100MB | | ☐ |

#### Performance Test Steps
1. Open DevTools Performance tab
2. Start recording
3. Open panel
4. Send message
5. Observe streaming
6. Stop recording
7. Analyze results

### 4. Visual Regression Testing

#### Themes to Test
- [ ] Dark theme (default)
- [ ] Light theme
- [ ] High contrast dark
- [ ] High contrast light

#### Components to Screenshot
For each theme:
- [ ] Empty state
- [ ] Header
- [ ] Message (user)
- [ ] Message (assistant)
- [ ] Streaming state
- [ ] Context chips
- [ ] Context drawer
- [ ] Change card
- [ ] Permission card
- [ ] Error state
- [ ] Menu dropdown

### 5. Edge Case Testing

| Edge Case | Test | Status |
|-----------|------|--------|
| Empty conversation | New chat with no messages | ☐ |
| Very long message | Send 10K character message | ☐ |
| Many messages | 100+ messages in conversation | ☐ |
| Rapid sends | Send 10 messages quickly | ☐ |
| Network disconnect | Disable network mid-stream | ☐ |
| Panel resize extreme | Very narrow (200px) | ☐ |
| Unicode/emoji | Send message with 🎉 | ☐ |
| Code blocks | Send message with code | ☐ |
| Markdown | Headers, lists, links | ☐ |
| Concurrent changes | Multiple pending changes | ☐ |

### 6. Integration Testing

#### With Other VS Code Features
- [ ] Multiple editor groups
- [ ] Split editor
- [ ] Zen mode
- [ ] Full screen
- [ ] Multiple workspaces

### 7. Documentation Check

- [ ] README updated
- [ ] Changelog updated
- [ ] Migration notes complete
- [ ] API documentation current

---

## Verification Report Template

```markdown
# QIC UI v2 Final Verification Report

**Date:** [DATE]
**Version:** [VERSION]
**Tester:** [NAME]

## Summary
- Total tests: X
- Passed: Y
- Failed: Z
- Blocked: W

## Functional Testing
[Results table]

## Accessibility
[Results table]
Screen reader tested: [Yes/No]

## Performance
[Metrics table]
Streaming smooth: [Yes/No]

## Visual Regression
[Per-theme results]

## Edge Cases
[Results table]

## Issues Found
| ID | Severity | Description | Ticket |
|----|----------|-------------|--------|
| 1 | High | ... | QIC-XXX |

## Verdict
- [ ] **PASS** - Ready for release
- [ ] **CONDITIONAL PASS** - Ready with documented issues
- [ ] **FAIL** - Critical issues must be fixed

## Sign-off
- [ ] Development complete
- [ ] QA complete
- [ ] Documentation complete
- [ ] Ready for legacy cleanup
```

---

## Success Criteria

### Must Pass (Blocking)
- All core features work
- No critical accessibility violations
- Performance targets met
- No regressions from current behavior

### Should Pass (Non-blocking)
- All edge cases handled
- All themes look correct
- All minor accessibility items

---

## After Verification

If PASS:
1. Create verification report
2. Create git tag: `qic-ui/v2-verified`
3. Proceed to 06-07 (Legacy Cleanup)

If FAIL:
1. Document all issues
2. Create tickets
3. Fix critical issues
4. Re-run verification

---

## Notes

- Be thorough - this is the final gate
- Document everything
- Screenshots are valuable
- Time-box edge case testing
- Prioritize critical path features
