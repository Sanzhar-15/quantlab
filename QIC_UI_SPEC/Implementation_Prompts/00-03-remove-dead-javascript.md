# Prompt 00-03: Remove Dead JavaScript

**Phase:** 0 - Cleanup
**Dependencies:** 00-02 (Remove Dead HTML)
**Estimated Effort:** 1-2 sessions
**Critical Path:** Yes

---

## Objective

Remove JavaScript code that references non-existent DOM elements. These are runtime errors waiting to happen and clutter the codebase.

---

## Context

From the audit (00-01), dead JavaScript references include:
- `document.getElementById('connection-status')` - element doesn't exist
- `document.getElementById('provider-select')` - element doesn't exist
- `document.getElementById('context-btn')` - element doesn't exist
- `document.getElementById('checkpoint-btn')` - element doesn't exist
- `document.getElementById('settings-btn')` - element doesn't exist
- References to floating panels that don't exist
- Event listeners attached to non-existent elements

---

## Scope

### In Scope
- Remove dead `getElementById` calls and their handlers
- Remove dead event listeners
- Remove functions that are only called by dead code
- Remove dead variables that stored references to non-existent elements
- Update related type definitions if needed

### Out of Scope
- Adding new functionality
- Modifying HTML structure
- CSS changes
- Backend changes

---

## Pre-Conditions

- [ ] `00-02-remove-dead-html.md` is complete
- [ ] `DEAD_CODE_INVENTORY.md` lists all dead JS references
- [ ] Git branch created: `qic-ui/00-03-remove-dead-javascript`

---

## Tasks

### 1. Identify All Dead References

Using the inventory, create a checklist:

```markdown
## Dead References to Remove

### qicPanel.ts
- [ ] Line XXX: `document.getElementById('connection-status')`
- [ ] Line XXX: `document.getElementById('provider-select')`
- [ ] Line XXX: Event handler for provider change
- [ ] ...

### Other files (if any)
- [ ] ...
```

### 2. Trace Dependencies

For each dead reference, trace what depends on it:

```
getElementById('connection-status')
  └── updateConnectionStatus(status)  // Also dead
      └── Called from handleStatusChange()  // Check if this is dead too
```

Only remove code that is ENTIRELY dead. If a function has both live and dead code, only remove the dead parts.

### 3. Remove Dead Code Systematically

Work top-down:
1. Remove event listeners first
2. Remove handler functions
3. Remove element reference variables
4. Remove helper functions only used by removed code

**Pattern for safe removal:**

```typescript
// BEFORE
const connectionStatus = document.getElementById('connection-status');
connectionStatus?.addEventListener('click', () => {
    showConnectionDetails();
});

function showConnectionDetails() {
    // ... implementation
}

// AFTER
// (All three items removed entirely)
```

### 4. Handle Conditional Dead Code

Some code may be conditionally dead:

```typescript
// This function might be partially dead
function updateUI(state) {
    updateMessages(state.messages);  // LIVE
    updateConnectionStatus(state.connection);  // DEAD - remove this line
    updateContext(state.context);  // LIVE
}
```

Only remove the dead lines, not the entire function.

### 5. Remove Orphaned Imports

After removing code, check for unused imports:

```typescript
// If this is no longer used
import { ConnectionStatusWidget } from './widgets/connectionStatus';
// Remove it
```

### 6. Verify No Runtime Errors

After each major removal:
1. Compile
2. Run extension
3. Open QIC panel
4. Interact with all features
5. Check console for errors

---

## Verification

### Success Criteria
- [ ] All dead JS references removed (per inventory)
- [ ] No orphaned functions remain
- [ ] No unused imports remain
- [ ] Build passes
- [ ] No runtime errors in console
- [ ] All live functionality still works

### Verification Commands
```bash
# Build check
npm run compile

# Search for known dead references (should return nothing)
grep -n "getElementById.*connection-status" src/vs/workbench/contrib/qic/
grep -n "getElementById.*provider-select" src/vs/workbench/contrib/qic/
grep -n "getElementById.*context-btn" src/vs/workbench/contrib/qic/

# Check for unused exports (optional, if tooling available)
npx ts-unused-exports tsconfig.json
```

### Manual Verification
1. Open QIC panel
2. Send a message
3. Verify streaming works
4. Verify cancel works
5. Open menu
6. Check all menu items work
7. No console errors

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
git checkout -- .
```

---

## Code Changes

### Files to Modify
| File | Change Type | Estimated Lines |
|------|-------------|-----------------|
| `qicPanel.ts` | Remove dead code | -50 to -200 |
| Webview scripts (if separate) | Remove dead code | -20 to -50 |

### Change Pattern

```typescript
// Remove blocks like this:

// DEAD CODE START - connection-status element doesn't exist
const connectionStatusEl = document.getElementById('connection-status');
if (connectionStatusEl) {
    connectionStatusEl.addEventListener('click', () => {
        // ...
    });
}

function updateConnectionStatus(status: string) {
    const el = document.getElementById('connection-status');
    if (el) {
        el.textContent = status;
        el.className = `status-${status}`;
    }
}
// DEAD CODE END
```

---

## Risk Mitigation

### High Risk Areas
1. **Shared functions**: Verify function is ONLY used by dead code before removing
2. **Event delegation**: Some handlers might be delegated, verify they're actually dead
3. **Dynamic IDs**: Some elements might be created dynamically - check for patterns like `element-${id}`

### Safety Checks
- Use TypeScript compiler errors to find broken references
- Test each major feature after removal
- Keep changes atomic - remove one "chunk" at a time and verify

---

## Notes

- The goal is ONLY removing dead code, not refactoring
- If you find code that's unclear, add a `// TODO: verify if dead` comment
- Document any surprising findings in the inventory
