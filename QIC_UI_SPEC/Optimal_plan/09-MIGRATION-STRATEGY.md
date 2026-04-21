# Migration Strategy

**Purpose:** Safe transition from current implementation to spec v1.4

---

## Overview

This document outlines how to migrate from the current QIC UI implementation to the new spec without breaking existing functionality. The strategy prioritizes:

1. **Zero downtime** - QIC remains usable throughout
2. **Incremental changes** - Small, testable PRs
3. **Feature flags** - Ability to rollback
4. **Parallel operation** - Old and new can coexist

---

## Migration Phases

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 0: Cleanup (Week 1)                                              │
│ Remove dead code, resolve conflicts                                    │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 1: Foundation (Week 2)                                           │
│ State service, protocol v2, message bridge                             │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 2: Panel (Weeks 3-4)                                             │
│ New header, conversation, input (behind flag)                          │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 3: Native Integration (Week 5)                                   │
│ Quick Picks, status bar, remove floating panels                        │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 4: Context (Weeks 6-7)                                           │
│ Context chips, drawer, @ mentions                                      │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 5: Changes (Weeks 8-9)                                           │
│ Diff UI, CodeLens, review mode                                         │
├────────────────────────────────────────────────────────────────────────┤
│ Phase 6: Polish (Weeks 10-11)                                          │
│ Accessibility, animations, edge cases                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Feature Flags

### 1. Configuration-Based Flags

**File:** `src/vs/workbench/contrib/qic/common/constants.ts`

```typescript
export const QIC_FEATURE_FLAGS = {
    // UI v2 features
    USE_NEW_HEADER: 'qic.experimental.newHeader',
    USE_STATE_SERVICE: 'qic.experimental.stateService',
    USE_PROTOCOL_V2: 'qic.experimental.protocolV2',
    USE_QUICK_PICKS: 'qic.experimental.quickPicks',
    USE_CONTEXT_CHIPS: 'qic.experimental.contextChips',
    USE_NEW_DIFF_UI: 'qic.experimental.newDiffUi',
} as const;
```

### 2. Runtime Flag Checking

```typescript
// In panel or service
private isFeatureEnabled(flag: string): boolean {
    return this.configurationService.getValue<boolean>(flag) ?? false;
}

// Usage
if (this.isFeatureEnabled(QIC_FEATURE_FLAGS.USE_NEW_HEADER)) {
    this.renderNewHeader();
} else {
    this.renderLegacyHeader();
}
```

### 3. Gradual Rollout

| Week | Flags Enabled (Internal) | Flags Enabled (Public) |
|------|-------------------------|------------------------|
| 1-2 | None | None |
| 3-4 | newHeader, stateService | None |
| 5-6 | + quickPicks, protocolV2 | newHeader, stateService |
| 7-8 | + contextChips | + quickPicks |
| 9-10 | + newDiffUi | + contextChips |
| 11 | All | All |

---

## Migration Details by Component

### 1. Message Protocol Migration

**Goal:** Move from current protocol to revision-based v2 without breaking existing functionality.

**Strategy: Dual Protocol Support**

```typescript
// qicPanel.ts - Handle both protocols
private handleWebviewMessage(msg: any): void {
    // V2 messages (new)
    if (this.isV2Message(msg)) {
        this.handleV2Message(msg);
        return;
    }

    // V1 messages (legacy) - existing handlers
    switch (msg.type) {
        case 'user-message':
            // ... existing code
            break;
        // ... etc
    }
}

private isV2Message(msg: any): boolean {
    return msg.type?.startsWith('state:') ||
           msg.type?.startsWith('revision:') ||
           msg.type?.startsWith('quickPick:');
}
```

**Timeline:**
1. Week 2: Add v2 types, implement bridge
2. Week 3: Webview sends both v1 and v2
3. Week 4: Host responds with v2
4. Week 6: Remove v1 webview code
5. Week 8: Remove v1 host code

---

### 2. Header Migration

**Goal:** Replace complex header with minimal spec header.

**Strategy: Template Switching**

```typescript
// In getWebviewHtml()
private getHeaderHtml(): string {
    if (this.isFeatureEnabled(QIC_FEATURE_FLAGS.USE_NEW_HEADER)) {
        return this.getNewHeaderHtml();
    }
    return this.getLegacyHeaderHtml();
}

private getNewHeaderHtml(): string {
    return `
        <header class="qic-header qic-header-v2">
            <div class="qic-header-left">
                <button id="status-btn" class="qic-status-btn">...</button>
                <span class="qic-title">QIC</span>
            </div>
            <div class="qic-header-right">
                <button id="menu-btn">⋮</button>
                <button id="new-chat-btn">+</button>
            </div>
        </header>
    `;
}

private getLegacyHeaderHtml(): string {
    return `
        <!-- Current header code -->
    `;
}
```

**CSS Strategy:**

```css
/* New styles scoped to v2 */
.qic-header-v2 {
    /* New header styles */
}

/* Legacy styles still work */
.qic-header:not(.qic-header-v2) {
    /* Old header styles */
}
```

---

### 3. Floating Panels → Quick Picks

**Goal:** Replace webview floating panels with native Quick Picks.

**Strategy: Parallel Implementation**

| Panel | Current | New | Migration |
|-------|---------|-----|-----------|
| Settings | Floating panel | VS Code Settings | Direct replacement |
| Checkpoints | Floating panel | Quick Pick | Add Quick Pick, then remove panel |
| History | None | Quick Pick | New feature |
| Provider | Dropdown | Quick Pick | Add Quick Pick, then remove dropdown |
| Context | Floating panel | Context drawer | Redesign |

**Example: Checkpoint Panel Migration**

```typescript
// Old: Floating panel in webview
case 'open-checkpoint-panel':
    this.postMessage({ type: 'show-checkpoint-panel', checkpoints });
    break;

// New: Quick Pick (parallel)
case 'quickPick:checkpoints':
    this.showCheckpointQuickPick();
    break;

private async showCheckpointQuickPick(): Promise<void> {
    const checkpoints = this.stateService.state.checkpoints;

    const items = checkpoints.map(cp => ({
        label: cp.description || `Before: ${cp.changeSetId}`,
        description: this.formatRelativeTime(cp.timestamp),
        detail: `${cp.files.length} files`,
        id: cp.id
    }));

    const pick = await this.quickInputService.pick(items, {
        placeHolder: 'Restore checkpoint...'
    });

    if (pick) {
        this.restoreCheckpoint(pick.id);
    }
}
```

**Cutover:**
1. Week 5: Implement Quick Picks alongside panels
2. Week 6: Menu items trigger Quick Picks
3. Week 7: Remove panel code from webview
4. Week 8: Remove panel message types

---

### 4. State Migration

**Goal:** Migrate from fragmented state to unified QicStateService.

**Strategy: Incremental Adoption**

```typescript
// Phase 1: StateService reads from existing services
class QicStateService {
    constructor(
        private qicService: IQicService,
        private checkpointManager: CheckpointManager,
        // ... etc
    ) {
        // Sync existing state
        this.syncFromLegacyServices();
    }

    private syncFromLegacyServices(): void {
        // Pull state from existing services
        this.updateConnection({
            status: this.qicService.getState(),
            // ...
        });
    }
}

// Phase 2: Services write to StateService
class QicService {
    setState(state: string): void {
        this._state = state;
        // Also update state service
        this.stateService.updateConnection({ status: state });
    }
}

// Phase 3: Services read from StateService
class QicService {
    get state(): string {
        return this.stateService.state.connection.status;
    }
}

// Phase 4: Remove legacy state from services
```

---

### 5. CSS Migration

**Goal:** Move from current CSS to spec design system.

**Strategy: CSS Custom Properties**

```css
/* Phase 1: Add new variables alongside old */
:root {
    /* Old variables (keep for compatibility) */
    --qic-bg: var(--vscode-editor-background, #1e1e1e);
    --qic-fg: var(--vscode-editor-foreground, #d4d4d4);

    /* New variables (from spec) */
    --qic-bg-primary: var(--qic-bg);  /* Map to old */
    --qic-fg-primary: var(--qic-fg);
    --qic-bg-secondary: var(--vscode-sideBar-background, #252526);
    /* ... etc */
}

/* Phase 2: New components use new variables */
.qic-header-v2 {
    background: var(--qic-bg-secondary);
}

/* Phase 3: Migrate old components */
.qic-message {
    /* Change from old to new variables */
    background: var(--qic-bg-secondary);  /* was: var(--qic-user-bg) */
}

/* Phase 4: Remove old variables */
```

---

## Rollback Procedures

### 1. Feature Flag Rollback

```bash
# Disable a feature for all users
# In settings.json or via configuration service
{
    "qic.experimental.newHeader": false
}
```

### 2. Git Rollback

Each phase is a separate branch/PR:

```bash
# If Phase 3 causes issues
git revert phase-3-quick-picks

# Or cherry-pick fixes
git cherry-pick <fix-commit>
```

### 3. State Rollback

```typescript
// If state service causes issues, fallback to legacy
class QicStateService {
    private useLegacyMode = false;

    enableLegacyMode(): void {
        this.useLegacyMode = true;
        // Stop syncing to webview
        // Let old code paths handle state
    }
}
```

---

## Testing Strategy

### 1. Unit Tests

Each new component has unit tests:

```typescript
// test/state/qicStateService.test.ts
suite('QicStateService', () => {
    test('migrations preserve data', () => {
        const legacyState = loadLegacyState();
        const newState = migrateState(legacyState);
        assert.deepStrictEqual(newState.conversation.messages, legacyState.messages);
    });
});
```

### 2. Integration Tests

```typescript
// test/integration/protocolMigration.test.ts
suite('Protocol Migration', () => {
    test('v1 and v2 messages both work', async () => {
        // Send v1 message
        panel.handleMessage({ type: 'user-message', text: 'hello' });
        // Verify response

        // Send v2 message
        panel.handleMessage({ type: 'send', payload: { content: 'hello', mentions: [] } });
        // Verify same response
    });
});
```

### 3. Visual Regression Tests

```typescript
// test/visual/headerRegression.test.ts
suite('Header Visual Regression', () => {
    test('new header matches spec', async () => {
        const screenshot = await captureComponent('.qic-header-v2');
        await compareToBaseline(screenshot, 'header-v2-baseline.png');
    });
});
```

### 4. Manual Testing Checklist

For each phase:

- [ ] All existing features still work
- [ ] New features work as specified
- [ ] No console errors
- [ ] Keyboard navigation works
- [ ] Screen reader announces correctly
- [ ] Theme switching works
- [ ] Narrow/wide panel works
- [ ] High contrast mode works

---

## Communication Plan

### 1. Internal Documentation

- Update ARCHITECTURE.md with new patterns
- Add migration notes to each changed file
- Document feature flags in README

### 2. Changelog

```markdown
## v2.0.0 (Upcoming)

### Breaking Changes
- Removed floating settings panel (use VS Code Settings)
- Removed floating checkpoint panel (use Quick Pick)

### New Features
- Unified state management
- Revision-based protocol for reliability
- @ mentions for files and symbols
- Context drawer with token counts

### Migration
- Enable `qic.experimental.*` flags to test new features
- Report issues with [UI v2] prefix
```

### 3. User Communication

For beta users:
- Enable experimental flags
- Provide feedback channel
- Document known issues

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing workflows | Feature flags, gradual rollout |
| Performance regression | Benchmark each phase |
| State data loss | Backup/restore in state service |
| User confusion | Keep UI similar where possible |
| Incomplete migration | Track progress, don't ship half-done |

---

## Success Criteria

### Per-Phase Gates

Before enabling each phase:

1. All unit tests pass
2. All integration tests pass
3. Manual testing checklist complete
4. No P0/P1 bugs
5. Performance benchmarks met
6. Accessibility audit passed

### Final Migration Complete

- [ ] All feature flags removed (features default on)
- [ ] All v1 protocol code removed
- [ ] All legacy CSS removed
- [ ] All floating panels removed
- [ ] Documentation updated
- [ ] Changelog published
