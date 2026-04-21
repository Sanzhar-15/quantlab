# Prompt 00-05: Fix Status Bar Persistence

**Phase:** 0 - Cleanup
**Dependencies:** 00-01 (Dead Code Audit)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Fix the issue where QIC status bar items persist after the panel is closed. This is likely the "lingering element" issue reported.

---

## Context

The user reported: "When I close it, there are still some elements from the QIC."

This typically happens because:
1. Status bar items are created but not disposed
2. Disposal happens on wrong lifecycle event
3. Disposal is missing entirely

---

## Scope

### In Scope
- Find where status bar items are created
- Ensure proper disposal on panel close
- Ensure proper disposal on extension deactivation
- Test all close scenarios

### Out of Scope
- Redesigning status bar
- Adding new status bar features
- Changing status bar appearance

---

## Pre-Conditions

- [ ] `00-01-dead-code-audit.md` documents the lifecycle issue
- [ ] Git branch created: `qic-ui/00-05-fix-status-bar-persistence`

---

## Tasks

### 1. Find Status Bar Creation

Search for status bar item creation:

```bash
grep -rn "createStatusBarItem\|StatusBarItem\|statusBar" src/vs/workbench/contrib/qic/
```

Typical pattern:
```typescript
// Look for something like:
this.statusBarItem = this.statusBarService.createStatusBarItem(
    'qic.status',
    StatusBarAlignment.RIGHT,
    100
);
```

Document:
- [ ] File and line where created
- [ ] Variable name storing reference
- [ ] What triggers creation

### 2. Find Status Bar Disposal

Search for disposal:

```bash
grep -rn "statusBar.*dispose\|dispose.*statusBar" src/vs/workbench/contrib/qic/
```

Verify:
- [ ] Is `dispose()` called on the status bar item?
- [ ] Is it called when panel closes?
- [ ] Is it called when extension deactivates?

### 3. Identify the Bug

Common issues:

**Issue A: No disposal at all**
```typescript
// Creation exists
this.statusBarItem = this.statusBarService.createStatusBarItem(...);

// But no disposal
// FIX: Add to dispose()
```

**Issue B: Wrong lifecycle**
```typescript
// Disposal in wrong place
onDidDispose() {
    this.statusBarItem.dispose(); // This might not be called
}

// FIX: Use _register or explicit disposal
```

**Issue C: Not registered with disposables**
```typescript
// Created but not tracked
this.statusBarItem = this.statusBarService.createStatusBarItem(...);

// FIX: Register it
this._register(this.statusBarItem);
```

### 4. Implement Fix

Based on VS Code patterns, the correct approach:

```typescript
class QicChatViewPane extends ViewPane {
    private statusBarItem: IStatusBarItem | undefined;

    constructor(...) {
        super(...);

        // Create status bar item
        this.statusBarItem = this.statusBarService.createStatusBarItem(
            'qic.status',
            StatusBarAlignment.RIGHT,
            100
        );

        // Register for automatic disposal
        this._register(this.statusBarItem);

        // Or explicit disposal in dispose()
    }

    override dispose(): void {
        // Explicit disposal (if not using _register)
        this.statusBarItem?.dispose();
        this.statusBarItem = undefined;

        super.dispose();
    }
}
```

### 5. Handle Panel Hide vs Close

The panel can be:
- **Hidden**: Panel exists but not visible (status bar should maybe stay?)
- **Closed**: Panel destroyed (status bar MUST go)

Decide the correct behavior:
- [ ] Option A: Status bar visible only when panel is visible
- [ ] Option B: Status bar visible as long as QIC is available
- [ ] Option C: Status bar always visible once activated

Implement accordingly:

```typescript
// Option A: Hide with panel
onDidChangeVisibility(visible: boolean) {
    if (this.statusBarItem) {
        if (visible) {
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }
}
```

### 6. Test All Scenarios

| Scenario | Expected | Test |
|----------|----------|------|
| Open panel | Status bar visible | ✓ |
| Close panel | Status bar gone | ✓ |
| Hide panel (click away) | Status bar hidden/gone | ✓ |
| Show panel again | Status bar visible | ✓ |
| Reload window | Status bar in correct state | ✓ |
| Disable extension | Status bar gone | ✓ |

---

## Verification

### Success Criteria
- [ ] Status bar item created correctly
- [ ] Status bar item disposed on panel close
- [ ] No orphan status bar items after close
- [ ] Behavior consistent across reload
- [ ] No memory leaks

### Verification Steps

1. Open QIC panel - verify status bar appears
2. Close QIC panel - verify status bar disappears
3. Reopen QIC panel - verify status bar appears again
4. Reload VS Code - verify correct initial state
5. Check DevTools for memory leaks (if possible)

### Verification Commands
```bash
# Build
npm run compile

# No errors in build
echo $?
```

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
# or whatever file contains the status bar logic
```

---

## Code Changes

### Files to Modify
| File | Change Type |
|------|-------------|
| `qicPanel.ts` or related | Add/fix disposal |

### Expected Change Pattern

```typescript
// BEFORE (broken)
class QicChatViewPane extends ViewPane {
    private statusBarItem: IStatusBarItem;

    constructor(...) {
        this.statusBarItem = this.statusBarService.createStatusBarItem(...);
        // Never disposed!
    }
}

// AFTER (fixed)
class QicChatViewPane extends ViewPane {
    private statusBarItem: IStatusBarItem;

    constructor(...) {
        this.statusBarItem = this.statusBarService.createStatusBarItem(...);
        this._register(this.statusBarItem); // Auto-dispose
    }

    override dispose(): void {
        this.statusBarItem?.dispose();
        super.dispose();
    }
}
```

---

## Notes

- VS Code's `_register()` pattern is preferred for disposables
- Always call `super.dispose()` in override
- Test with VS Code's memory profiler if available
- This fix is critical - lingering UI is a bad user experience
