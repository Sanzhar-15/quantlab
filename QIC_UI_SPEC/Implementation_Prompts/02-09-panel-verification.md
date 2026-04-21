# Prompt 02-09: Panel Verification

**Phase:** 2 - Panel Structure
**Dependencies:** 02-01 through 02-08
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Comprehensive verification of Phase 2 implementation: run all tests, verify all acceptance criteria, document any issues, and confirm readiness for Phase 3.

---

## Context

Phase 2 has implemented:
- Header with status, menu, new chat buttons
- Conversation area with message rendering
- Streaming with token buffering
- Input area with auto-resize
- Input lockout during processing
- Empty state with quick actions
- Full panel integration

This prompt verifies everything works together correctly.

---

## Scope

### In Scope
- Run all unit tests
- Run integration tests
- Manual verification checklist
- Performance benchmarks
- Accessibility audit
- Document issues found
- Confirm Phase 3 readiness

### Out of Scope
- Fixing issues (create follow-up tasks)
- Phase 3 implementation
- Documentation updates

---

## Pre-Conditions

- [ ] 02-01 through 02-08 complete
- [ ] All code committed
- [ ] Clean git status

---

## Tasks

### 1. Run Unit Tests

```bash
# Run QIC-specific tests
npm run test -- --grep "qic"

# Or if using specific test runner
npx mocha src/vs/workbench/contrib/qic/test/**/*.test.ts

# Check for new tests that need to be written
grep -r "TODO.*test" src/vs/workbench/contrib/qic/browser/media/
```

### 2. Run Integration Tests

```bash
# Run E2E tests
npm run test:e2e -- --grep "qic"

# Run in watch mode for debugging
npm run test:e2e -- --watch --grep "qic"
```

### 3. Manual Verification Checklist

#### 3.1 Header Functionality

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Status button visible | Open panel | Button shows with status dot | [ ] |
| Status dot color - ready | Service ready | Green dot | [ ] |
| Status dot color - degraded | Degrade service | Yellow dot | [ ] |
| Status dot color - error | Error state | Red dot | [ ] |
| Status click | Click status | Quick Pick trigger (log for now) | [ ] |
| Menu opens | Click menu button | Dropdown appears | [ ] |
| Menu closes - outside | Click outside | Dropdown closes | [ ] |
| Menu closes - escape | Press Escape | Dropdown closes | [ ] |
| Menu item - history | Click History | Message sent | [ ] |
| Menu item - checkpoints | Click Checkpoints | Message sent | [ ] |
| Menu item - provider | Click Provider | Message sent | [ ] |
| Menu item - settings | Click Settings | Settings open | [ ] |
| Menu item - help | Click Help | Help message sent | [ ] |
| New chat button | Click + | New chat created | [ ] |
| New chat disabled | Error state | Button disabled | [ ] |
| Keyboard - menu | Tab to menu, Enter | Menu opens | [ ] |

#### 3.2 Conversation Area

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Empty state visible | New chat | Empty state shows | [ ] |
| Empty state hidden | Send message | Empty state hidden | [ ] |
| Quick action | Click "Explain" | Prompt in input | [ ] |
| User message render | Send message | Right-aligned, blue bg | [ ] |
| Assistant message render | Receive response | Left-aligned, gray bg | [ ] |
| Timestamp shown | View message | Time displayed | [ ] |
| Code block render | Message with code | Code block with copy btn | [ ] |
| Copy code | Click copy | Code copied, feedback | [ ] |
| Insert code | Click insert | Code inserted | [ ] |
| File reference | Click [[path]] | File opens | [ ] |
| Scroll to bottom | Scroll up, new msg | Button appears | [ ] |
| Scroll button click | Click button | Scrolls to bottom | [ ] |
| Auto-scroll | Near bottom, new msg | Auto-scrolls | [ ] |
| No auto-scroll | Far up, new msg | Doesn't scroll | [ ] |

#### 3.3 Streaming

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Stream start | Send message | Streaming indicator | [ ] |
| Tokens buffer | Fast tokens | Smooth rendering | [ ] |
| Cursor visible | During stream | Blinking cursor | [ ] |
| Stream complete | Response done | Cursor gone, timestamp | [ ] |
| Cancel stream | Click cancel | [Cancelled] shown | [ ] |
| Markdown render | Receive markdown | Rendered correctly | [ ] |
| Performance | Long response | No jank (60fps) | [ ] |

#### 3.4 Input Area

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Placeholder | Empty input | "Ask anything..." | [ ] |
| Auto-resize | Type multiline | Input grows | [ ] |
| Max height | Very long text | Stops at 200px, scrolls | [ ] |
| Character count | Type text | Count updates | [ ] |
| Warning threshold | 10000+ chars | Yellow count | [ ] |
| Error threshold | 50000+ chars | Red count | [ ] |
| Send disabled empty | Empty input | Button disabled | [ ] |
| Send enabled | Type text | Button enabled | [ ] |
| Ctrl+Enter | Press shortcut | Message sent | [ ] |
| Shift+Enter | Press shortcut | New line | [ ] |
| Escape | Press Escape | Cancel triggered | [ ] |
| Input focus | Click input | Border highlights | [ ] |
| Context chips | Add context | Chips shown | [ ] |
| Remove chip | Click X | Chip removed | [ ] |

#### 3.5 Input Lockout

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Lock on processing | Send message | Input disabled | [ ] |
| Placeholder change | While locked | "Waiting for response" | [ ] |
| Cancel button | While locked | Visible | [ ] |
| Send button | While locked | Hidden | [ ] |
| Unlock on idle | Response complete | Input enabled | [ ] |
| Focus on unlock | After unlock | Input focused | [ ] |
| Double-click prevent | Rapid clicks | One message only | [ ] |
| Toast feedback | Click send locked | Toast appears | [ ] |
| Error unlock | Error state | Unlocks after 3s | [ ] |

#### 3.6 State Synchronization

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Initial state | Open panel | State loaded | [ ] |
| State patch | Host updates | Webview updates | [ ] |
| Revision tracking | Multiple updates | Correct order | [ ] |
| Gap detection | Skip revision | Full state requested | [ ] |
| Webview reload | Reload panel | State restored | [ ] |

#### 3.7 Theme Support

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Light theme | Use light theme | Correct colors | [ ] |
| Dark theme | Use dark theme | Correct colors | [ ] |
| High contrast | Use HC theme | Accessible colors | [ ] |
| Theme change | Switch theme | Updates live | [ ] |

### 4. Performance Benchmarks

Run performance tests:

```javascript
// In DevTools console

// Test 1: Message render time
console.time('render-100-messages');
for (let i = 0; i < 100; i++) {
    window.qicMessages.appendMessage({
        id: `perf-${i}`,
        role: 'assistant',
        content: 'Test message ' + i,
        timestamp: new Date().toISOString()
    });
}
console.timeEnd('render-100-messages');
// Target: < 500ms

// Test 2: Streaming token rate
console.time('stream-1000-tokens');
window.qicStreaming.startStream('perf-stream');
for (let i = 0; i < 1000; i++) {
    window.qicStreaming.addTokens('word ');
}
window.qicStreaming.completeStream('perf-stream');
console.timeEnd('stream-1000-tokens');
// Target: < 200ms

// Test 3: Input response time
console.time('input-keystroke');
const input = document.getElementById('chat-input');
input.value = 'a'.repeat(1000);
input.dispatchEvent(new Event('input'));
console.timeEnd('input-keystroke');
// Target: < 16ms
```

**Performance Targets:**

| Metric | Target | Actual | Pass |
|--------|--------|--------|------|
| 100 messages render | < 500ms | | [ ] |
| 1000 tokens stream | < 200ms | | [ ] |
| Input keystroke | < 16ms | | [ ] |
| Panel open | < 200ms | | [ ] |
| Memory (idle) | < 50MB | | [ ] |

### 5. Accessibility Audit

Run automated accessibility check:

```bash
# Using aXe
npx axe-core src/vs/workbench/contrib/qic/browser/media/chat.template.ts
```

Manual accessibility checks:

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Keyboard nav | Tab through | All elements reachable | [ ] |
| Focus visible | Tab through | Focus ring visible | [ ] |
| Screen reader | Use NVDA/VoiceOver | Content announced | [ ] |
| ARIA labels | Check elements | Labels present | [ ] |
| ARIA roles | Check elements | Correct roles | [ ] |
| ARIA live | Send message | "polite" announcement | [ ] |
| Color contrast | Check text | 4.5:1 ratio | [ ] |
| Motion reduce | prefers-reduced-motion | No animations | [ ] |

### 6. Browser Compatibility

| Browser | Version | Status | Notes |
|---------|---------|--------|-------|
| Electron (VS Code) | Latest | | Primary |
| Chrome | 90+ | | Testing |
| Firefox | 85+ | | Testing |

### 7. Document Issues

Create issues for any failures:

```markdown
## Issue Template

**Test:** [Name of failed test]
**Expected:** [What should happen]
**Actual:** [What actually happened]
**Steps to reproduce:**
1. ...
2. ...

**Severity:** P0/P1/P2
**Blocking Phase 3:** Yes/No
```

### 8. Phase 3 Readiness Checklist

- [ ] All P0 issues resolved
- [ ] All P1 issues documented
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Performance targets met
- [ ] Accessibility audit passed
- [ ] Code reviewed
- [ ] Documentation updated

---

## Verification Summary

### Test Results

| Category | Total | Pass | Fail |
|----------|-------|------|------|
| Header | 16 | | |
| Conversation | 14 | | |
| Streaming | 7 | | |
| Input Area | 13 | | |
| Input Lockout | 9 | | |
| State Sync | 6 | | |
| Theme | 4 | | |
| Performance | 5 | | |
| Accessibility | 8 | | |
| **Total** | **82** | | |

### Issues Found

| ID | Description | Severity | Blocking |
|----|-------------|----------|----------|
| | | | |

### Decision

- [ ] **PASS** - Ready for Phase 3
- [ ] **CONDITIONAL** - Ready with documented issues
- [ ] **FAIL** - Issues must be fixed first

---

## Next Steps

If PASS:
1. Merge Phase 2 branch
2. Create Phase 3 branch
3. Begin `03-01-quick-pick-infrastructure.md`

If CONDITIONAL:
1. Document all issues
2. Create follow-up tasks
3. Get stakeholder approval
4. Proceed to Phase 3

If FAIL:
1. Prioritize blocking issues
2. Fix P0 issues
3. Re-run verification

---

## Notes

- This is a critical gate before Phase 3
- Don't skip accessibility testing
- Document everything for future reference
- Performance regression testing should be automated
