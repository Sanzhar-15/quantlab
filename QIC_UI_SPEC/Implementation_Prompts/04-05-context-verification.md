# Prompt 04-05: Context System Verification

**Phase:** 4 - Context System
**Dependencies:** 04-01 through 04-04
**Estimated Effort:** 0.5 sessions
**Critical Path:** Yes

---

## Objective

Comprehensively verify that all Phase 4 context system components work correctly together. This verification ensures context chips, drawer, mention autocomplete, and state integration function as a cohesive system before proceeding to Phase 5.

---

## Context

Phase 4 implemented the complete context system:
- **04-01**: Context Chips UI
- **04-02**: Context Drawer
- **04-03**: Mention Autocomplete
- **04-04**: Context State Integration

This verification prompt ensures:
1. All context UI components render correctly
2. Context CRUD operations work
3. State synchronization is reliable
4. Context is properly included in LLM requests
5. User workflows are smooth end-to-end

---

## Pre-Conditions

- [ ] 04-01 through 04-04 complete
- [ ] All individual prompt verifications passed
- [ ] Extension loads without errors
- [ ] Git branch: `qic-ui/04-05-context-verification`

---

## Verification Checklist

### 1. Context Chips UI (04-01)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 1.1 | Container renders | Open QIC panel | Chips container visible | ☐ |
| 1.2 | Add button visible | Check container | + button present | ☐ |
| 1.3 | File chip | Add file context | File chip appears | ☐ |
| 1.4 | Selection chip | Add selection | Selection chip appears | ☐ |
| 1.5 | Symbol chip | Add symbol | Symbol chip with icon | ☐ |
| 1.6 | URL chip | Add URL | URL chip appears | ☐ |
| 1.7 | Image chip | Add image | Image chip appears | ☐ |
| 1.8 | Chip icon correct | Check each type | Type-specific icon | ☐ |
| 1.9 | Chip label | Check label | Filename/name shown | ☐ |
| 1.10 | Remove button | Hover chip | × button visible | ☐ |
| 1.11 | Remove click | Click × | Chip removed | ☐ |
| 1.12 | Remove animation | Watch removal | Fade out animation | ☐ |
| 1.13 | Overflow | Add 6+ items | "+N more" shows | ☐ |
| 1.14 | Overflow click | Click "+N more" | Drawer opens | ☐ |
| 1.15 | Click chip | Click on chip | Details open | ☐ |
| 1.16 | Keyboard remove | Focus, press Delete | Chip removed | ☐ |
| 1.17 | Keyboard navigate | Arrow keys | Navigate chips | ☐ |
| 1.18 | Loading state | Add item | Spinner shows | ☐ |
| 1.19 | Error state | Invalid file | Error styling | ☐ |
| 1.20 | Empty hides | Remove all | Container hides | ☐ |

### 2. Context Drawer (04-02)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 2.1 | Drawer exists | Inspect DOM | Drawer element present | ☐ |
| 2.2 | Hidden initially | Check state | Drawer collapsed | ☐ |
| 2.3 | Toggle opens | Click toggle | Drawer expands | ☐ |
| 2.4 | Toggle closes | Click again | Drawer collapses | ☐ |
| 2.5 | Animation smooth | Watch expand | Smooth transition | ☐ |
| 2.6 | Item count | Check header | "(N items)" shown | ☐ |
| 2.7 | Search filter | Type in search | Items filtered | ☐ |
| 2.8 | Clear all button | Click clear | Confirmation dialog | ☐ |
| 2.9 | Clear confirms | Confirm | All items removed | ☐ |
| 2.10 | Item expand | Click item | Content preview shows | ☐ |
| 2.11 | Content loads | Expand file item | File content shown | ☐ |
| 2.12 | Content truncated | Large file | "truncated" shown | ☐ |
| 2.13 | Open button | Click open | File opens in editor | ☐ |
| 2.14 | Remove button | Click × | Item removed | ☐ |
| 2.15 | Token count | Check footer | Tokens estimated | ☐ |
| 2.16 | Token warning | Large context | Warning color | ☐ |
| 2.17 | Token error | Very large | Error color | ☐ |
| 2.18 | Keyboard nav | Use arrows | Navigate items | ☐ |
| 2.19 | Collapse button | Click collapse | Drawer closes | ☐ |
| 2.20 | Image preview | Add image | Thumbnail shown | ☐ |

### 3. Mention Autocomplete (04-03)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 3.1 | @ triggers | Type `@` | Dropdown opens | ☐ |
| 3.2 | Position correct | Check dropdown | Above input | ☐ |
| 3.3 | Recent section | Empty query | Recent items shown | ☐ |
| 3.4 | Files section | Type `@main` | Files matching | ☐ |
| 3.5 | Symbols section | Type `@MyClass` | Symbols matching | ☐ |
| 3.6 | Search debounce | Type fast | No rapid requests | ☐ |
| 3.7 | Highlight match | Check results | Query highlighted | ☐ |
| 3.8 | Arrow down | Press ↓ | Next item focused | ☐ |
| 3.9 | Arrow up | Press ↑ | Previous focused | ☐ |
| 3.10 | Enter selects | Press Enter | Item added as chip | ☐ |
| 3.11 | Tab selects | Press Tab | Item added as chip | ☐ |
| 3.12 | Escape closes | Press Escape | Dropdown closes | ☐ |
| 3.13 | Click selects | Click item | Item added as chip | ☐ |
| 3.14 | Query removed | After select | @query removed | ☐ |
| 3.15 | Mid-sentence | `hello @file` | Works correctly | ☐ |
| 3.16 | Empty results | Nonsense query | Empty message | ☐ |
| 3.17 | Loading state | Slow search | Loading indicator | ☐ |
| 3.18 | Shortcuts shown | Check footer | Keyboard hints | ☐ |
| 3.19 | Blur closes | Click outside | Dropdown closes | ☐ |
| 3.20 | Reopen | Close, type `@` | Opens again | ☐ |

### 4. Context State Integration (04-04)

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 4.1 | State stores items | Add context | In state service | ☐ |
| 4.2 | State removes items | Remove context | Removed from state | ☐ |
| 4.3 | State clears | Clear all | State empty | ☐ |
| 4.4 | Webview syncs add | Add in extension | Webview updated | ☐ |
| 4.5 | Webview syncs remove | Remove in ext | Webview updated | ☐ |
| 4.6 | Extension syncs add | Add in webview | Extension updated | ☐ |
| 4.7 | Extension syncs remove | Remove in webview | Extension updated | ☐ |
| 4.8 | Recent tracks | Add items | In recent list | ☐ |
| 4.9 | Recent persists | Reload window | Recent preserved | ☐ |
| 4.10 | Recent dedupes | Add same twice | Only one in recent | ☐ |
| 4.11 | Token estimate | Add file | Token count shown | ☐ |
| 4.12 | Budget warning | Exceed 50k | Warning shown | ☐ |
| 4.13 | Context in message | Send with context | Context included | ☐ |
| 4.14 | File content loaded | Add file | Content available | ☐ |
| 4.15 | Selection content | Add selection | Lines extracted | ☐ |
| 4.16 | Symbol content | Add symbol | Code extracted | ☐ |
| 4.17 | Cmd: Add file | Right-click file | Context added | ☐ |
| 4.18 | Cmd: Add selection | Ctrl+Shift+C | Selection added | ☐ |
| 4.19 | Error handling | Invalid path | Error state | ☐ |
| 4.20 | Duplicate prevention | Add same file | Not duplicated | ☐ |

### 5. Integration Tests

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 5.1 | Full file flow | Right-click → chip → drawer → send | All work | ☐ |
| 5.2 | Full selection flow | Select → Ctrl+Shift+C → send | All work | ☐ |
| 5.3 | @ mention flow | Type `@file` → select → send | All work | ☐ |
| 5.4 | Multiple context | Add 3 items → send | All included | ☐ |
| 5.5 | Mixed types | File + selection + symbol | All work | ☐ |
| 5.6 | Remove mid-flow | Add, remove, add | Works correctly | ☐ |
| 5.7 | Clear and re-add | Clear, add new | Works correctly | ☐ |
| 5.8 | Overflow + drawer | 6+ items → drawer | Consistent | ☐ |
| 5.9 | Search in drawer | Filter items | Chips unaffected | ☐ |
| 5.10 | Keyboard only | No mouse | Full functionality | ☐ |

### 6. State Consistency

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 6.1 | Chips match state | Compare | Identical | ☐ |
| 6.2 | Drawer matches state | Compare | Identical | ☐ |
| 6.3 | Token count matches | Compare | Identical | ☐ |
| 6.4 | After reload | Reload webview | State preserved | ☐ |
| 6.5 | After window reload | Reload VS Code | Recent preserved | ☐ |

### 7. Error Handling

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 7.1 | File not found | Add deleted file | Error state | ☐ |
| 7.2 | Binary file | Add binary | Graceful handling | ☐ |
| 7.3 | Large file | Add huge file | Warning or limit | ☐ |
| 7.4 | Search error | Simulate error | Error notification | ☐ |
| 7.5 | Content load error | Simulate error | Error in drawer | ☐ |

### 8. Performance Tests

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8.1 | Add speed | Add 10 items | < 100ms each | ☐ |
| 8.2 | Drawer render | Open with 20 items | < 200ms | ☐ |
| 8.3 | Search speed | Type fast | Responsive | ☐ |
| 8.4 | Memory | Add/remove many | No leaks | ☐ |
| 8.5 | Content loading | Large files | Background load | ☐ |

### 9. Accessibility

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 9.1 | Chip focus | Tab to chips | Focus visible | ☐ |
| 9.2 | Chip ARIA | Inspect | Labels correct | ☐ |
| 9.3 | Dropdown ARIA | Inspect | Listbox role | ☐ |
| 9.4 | Screen reader | Use NVDA/VO | Announces items | ☐ |
| 9.5 | High contrast | Enable | All visible | ☐ |
| 9.6 | Keyboard only | No mouse | Full access | ☐ |

### 10. Edge Cases

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 10.1 | Empty input + @ | Just `@` | Shows recent | ☐ |
| 10.2 | @ at end | `hello @` | Triggers | ☐ |
| 10.3 | Email address | `user@example.com` | No trigger | ☐ |
| 10.4 | Multiple @ | `@file @other` | Each triggers | ☐ |
| 10.5 | Unicode filename | Non-ASCII | Displays correctly | ☐ |
| 10.6 | Very long path | Deep nesting | Truncated label | ☐ |
| 10.7 | Same file twice | Add twice | Deduplicated | ☐ |
| 10.8 | Rapid add/remove | Fast operations | No race conditions | ☐ |

---

## Automated Tests

### Unit Tests to Run

```bash
# Run all context tests
npm test -- --grep "Context"

# Run specific tests
npm test -- --grep "ContextChipsManager"
npm test -- --grep "ContextDrawerManager"
npm test -- --grep "MentionAutocomplete"
npm test -- --grep "ContextBuilder"
```

### Expected Test Results

| Test Suite | Expected | Actual | Pass |
|------------|----------|--------|------|
| ContextChipsManager | All pass | | ☐ |
| ContextDrawerManager | All pass | | ☐ |
| MentionAutocomplete | All pass | | ☐ |
| ContextBuilder | All pass | | ☐ |
| QicStateService (context) | All pass | | ☐ |

---

## LLM Integration Verification

### Context in Messages

| # | Test | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 1 | Single file | Add file, send | File in message | ☐ |
| 2 | File with lines | Add range, send | Lines in message | ☐ |
| 3 | Multiple files | Add 3 files, send | All 3 in message | ☐ |
| 4 | Selection | Add selection, send | Code in message | ☐ |
| 5 | Symbol | Add function, send | Function in message | ☐ |
| 6 | Context format | Check LLM request | Properly formatted | ☐ |
| 7 | Token count | Check vs actual | Within 20% | ☐ |

### Message Format Verification

Verify the context appears correctly in the LLM message:

```
## Attached Context

The user has attached the following context to this conversation:

### File: src/main.ts

\`\`\`typescript
// file content here
\`\`\`

### Code from src/utils.ts (lines 10-25)

\`\`\`typescript
// selection content here
\`\`\`

---

[User's actual message here]
```

---

## Sign-Off

### Phase 4 Completion Criteria

- [ ] All 10 verification sections passed (90%+)
- [ ] All automated tests pass
- [ ] No P0 or P1 bugs
- [ ] LLM integration verified
- [ ] Performance targets met
- [ ] No regressions from Phase 3

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

- Test with different file types (code, text, binary)
- Test with workspace symbols and document symbols
- Verify context doesn't get sent if empty
- Check behavior when context exceeds model limits
- Test image context if supported by provider

---

## Next Steps

After successful verification:
1. Merge Phase 4 branches to main
2. Tag release: `qic-ui-phase4-complete`
3. Update README with context features
4. Begin Phase 5: Changes & Diff

---

## Summary Scorecard

| Section | Total | Passed | Percentage |
|---------|-------|--------|------------|
| 1. Context Chips UI | 20 | | |
| 2. Context Drawer | 20 | | |
| 3. Mention Autocomplete | 20 | | |
| 4. Context State | 20 | | |
| 5. Integration | 10 | | |
| 6. State Consistency | 5 | | |
| 7. Error Handling | 5 | | |
| 8. Performance | 5 | | |
| 9. Accessibility | 6 | | |
| 10. Edge Cases | 8 | | |
| **Total** | **119** | | |

**Minimum Pass Rate:** 90% (107/119 tests)

