# Prompt 01-07: Foundation Verification

**Phase:** 1 - Foundation
**Dependencies:** 01-01 through 01-06
**Estimated Effort:** 0.5 session
**Critical Path:** Yes

---

## Objective

Verify that all Phase 1 (Foundation) components work correctly together before proceeding to Phase 2 (Panel Structure).

---

## Context

Phase 1 established:
- QicStateService (centralized state)
- Protocol V2 types (message format)
- QicMessageBridge (host↔webview communication)
- Webview state manager (state sync)
- Service registration (DI wiring)

This verification ensures these components integrate correctly.

---

## Scope

### In Scope
- Verify all components compile
- Verify runtime integration
- Verify state sync works
- Verify no regressions in existing functionality
- Create git tag for milestone

### Out of Scope
- UI changes
- New features
- Fixing non-critical issues

---

## Pre-Conditions

- [ ] All Phase 1 prompts (01-01 through 01-06) complete
- [ ] All changes merged to feature branch

---

## Tasks

### 1. Build Verification

```bash
# Clean build
rm -rf out/
npm run compile

# Check for errors
echo "Build exit code: $?"

# Check for warnings
npm run compile 2>&1 | grep -i warning
```

### 2. Type Verification

```bash
# Full type check
npx tsc --noEmit

# Check specific files
npx tsc --noEmit \
    src/vs/workbench/contrib/qic/common/state/qicStateService.ts \
    src/vs/workbench/contrib/qic/common/ui/messageProtocolV2.ts \
    src/vs/workbench/contrib/qic/browser/messageBridge.ts
```

### 3. Unit Test State Service

Create a simple test if not exists:

```typescript
// Manual test or actual test file
import { QicStateService } from '../common/state/qicStateService.js';

function testStateService() {
    const service = new QicStateService();

    // Test initial state
    console.assert(service.revision === 0, 'Initial revision should be 0');
    console.assert(service.state.serviceStatus === 'initializing', 'Initial status should be initializing');

    // Test mutation
    const rev1 = service.setServiceStatus('ready');
    console.assert(rev1 === 1, 'After mutation, revision should be 1');
    console.assert(service.state.serviceStatus === 'ready', 'Status should be ready');

    // Test event
    let eventFired = false;
    service.onDidChangeState(() => { eventFired = true; });
    service.setAgentState('processing');
    console.assert(eventFired, 'Event should fire on mutation');

    console.log('State service tests passed');
}
```

### 4. Integration Test

Run VS Code and verify:

| Test | Steps | Expected |
|------|-------|----------|
| Panel opens | Click QIC icon | Panel renders |
| No errors | Check console | No "Cannot find service" errors |
| State initializes | (internal) | Bridge receives 'ready', sends state |
| Legacy works | Send message | Response received |

### 5. State Sync Test

In webview DevTools console:

```javascript
// After panel opens
console.log('State initialized:', window.qicState.isInitialized());
console.log('Revision:', window.qicState.getRevision());
console.log('State:', window.qicState.getState());

// Subscribe and watch for updates
window.qicState.subscribe((state, patch) => {
    console.log('State update:', patch ? patch.path : 'full');
});
```

### 6. Regression Test

Verify all existing features still work:

| Feature | Test | Pass? |
|---------|------|-------|
| New conversation | Click + button | ☐ |
| Send message | Type and send | ☐ |
| Streaming response | Observe streaming | ☐ |
| Cancel | Click stop | ☐ |
| Menu opens | Click ⋮ | ☐ |
| Settings | Open settings | ☐ |

### 7. Memory/Cleanup Test

1. Open QIC panel
2. Close QIC panel
3. Reopen QIC panel
4. Check for:
   - Duplicate listeners
   - Memory growth
   - Console errors

### 8. Create Verification Report

```markdown
# Phase 1 Foundation Verification Report

**Date:** [DATE]
**Tester:** [NAME]

## Build
- [ ] Clean build passes
- [ ] No TypeScript errors
- [ ] No warnings (or documented)

## Unit Tests
- [ ] State service tests pass
- [ ] (other tests)

## Integration
- [ ] Panel opens without errors
- [ ] State service injected correctly
- [ ] Message bridge initializes
- [ ] Webview state manager loads

## State Sync
- [ ] Full state received on ready
- [ ] Patches applied correctly
- [ ] Revision tracking works

## Regression
- [ ] All existing features work
- [ ] No new console errors
- [ ] Performance acceptable

## Issues Found
1. [Issue description] - [Severity] - [Ticket if created]

## Verdict
- [ ] **PASS** - Ready for Phase 2
- [ ] **FAIL** - Issues must be fixed
```

### 9. Create Git Tag

```bash
# If all tests pass
git tag -a qic-ui/phase-1-complete -m "QIC UI Phase 1 Foundation Complete"
git push origin qic-ui/phase-1-complete
```

---

## Verification

### Success Criteria
- [ ] All builds pass
- [ ] All tests pass
- [ ] No regressions
- [ ] State sync verified
- [ ] Verification report complete
- [ ] Git tag created

---

## Next Steps

With Phase 1 complete, proceed to:
- **Phase 2: Panel Structure** - Implement new header, conversation area, input

The foundation is now ready to support the new UI components.
