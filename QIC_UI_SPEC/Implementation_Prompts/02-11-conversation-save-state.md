# Prompt 02-11: Conversation Save State (GAP-08 Fix)

**Phase:** 2 - Panel Structure
**Dependencies:** 02-08 (Panel Integration), 03-02 (History Quick Pick)
**Estimated Effort:** 1 session
**Critical Path:** No

---

## Objective

Implement conversation save state indicators and handling. Users need to know when their conversation is saved, see when they have unsaved changes, and receive prompts before losing work. This addresses GAP-08 from the audit.

---

## Context

From GAP-08 in the audit:
- The backend has conversation persistence via `ConversationState.persist()` and `restore()`
- Users need visibility into save state
- Switching conversations without saving could lose work
- Auto-save should be indicated but not intrusive

User expectations:
- See when conversation is being saved
- Know if they have unsaved changes
- Get warned before losing unsaved work
- Confidence that their work is preserved

---

## Scope

### In Scope
- Save state indicator (Saved / Saving... / Unsaved)
- Modified conversation marker
- Auto-save trigger and indicator
- Unsaved warning dialog when switching
- Manual save trigger
- Save error handling

### Out of Scope
- Backend persistence logic
- Conversation list management (03-02)
- History search (03-02)

---

## Pre-Conditions

- [ ] 02-08 complete (panel integration)
- [ ] 03-02 complete (history quick pick)
- [ ] ConversationState persistence exists in backend
- [ ] Git branch created: `qic-ui/02-11-save-state`

---

## Tasks

### 1. Define Save State Types

```typescript
// src/vs/workbench/contrib/qic/common/types/saveState.ts

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

export interface ConversationSaveState {
    conversationId: string;
    status: SaveStatus;
    lastSavedAt: number | null;
    isDirty: boolean;
    error?: string;
}

export interface SaveStateConfig {
    autoSaveDelayMs: number;      // Delay before auto-save (default: 2000)
    autoSaveEnabled: boolean;     // Enable auto-save (default: true)
    showSaveIndicator: boolean;   // Show indicator in header (default: true)
    warnOnUnsavedSwitch: boolean; // Warn before switching (default: true)
}

export const DEFAULT_SAVE_CONFIG: SaveStateConfig = {
    autoSaveDelayMs: 2000,
    autoSaveEnabled: true,
    showSaveIndicator: true,
    warnOnUnsavedSwitch: true,
};
```

### 2. Add Save State Indicator HTML

```html
<!-- In header area, after title -->
<div id="save-state-indicator" class="qic-save-indicator" hidden>
    <span class="qic-save-icon codicon"></span>
    <span class="qic-save-text"></span>
</div>

<!-- Modified indicator (dot next to conversation title) -->
<span id="conversation-modified" class="qic-modified-dot" hidden title="Unsaved changes"></span>

<!-- Unsaved Warning Dialog -->
<div id="unsaved-warning-dialog" class="qic-modal-overlay" hidden role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title">
    <div class="qic-modal qic-unsaved-modal">
        <div class="qic-modal-header">
            <span class="codicon codicon-warning"></span>
            <h3 id="unsaved-title">Unsaved Changes</h3>
        </div>
        <div class="qic-modal-body">
            <p>You have unsaved changes in this conversation. What would you like to do?</p>
        </div>
        <div class="qic-modal-footer">
            <button class="qic-btn secondary" data-action="discard">
                Don't Save
            </button>
            <button class="qic-btn secondary" data-action="cancel">
                Cancel
            </button>
            <button class="qic-btn primary" data-action="save">
                Save & Continue
            </button>
        </div>
    </div>
</div>
```

### 3. Add Save State Styles

```css
/* ========================================
   Save State Indicator Styles
   ======================================== */

.qic-save-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 2px 8px;
    border-radius: 4px;
    transition: all 0.2s ease;
}

.qic-save-indicator[data-status="saving"] {
    color: var(--vscode-foreground);
}

.qic-save-indicator[data-status="saving"] .qic-save-icon {
    animation: pulse 1s ease-in-out infinite;
}

.qic-save-indicator[data-status="unsaved"] {
    color: var(--qic-status-warning);
}

.qic-save-indicator[data-status="error"] {
    color: var(--qic-status-error);
}

.qic-save-indicator[data-status="saved"] {
    opacity: 0;
    transition: opacity 0.5s ease 2s; /* Fade out after 2s */
}

.qic-save-indicator:hover[data-status="saved"] {
    opacity: 1;
    transition: opacity 0.1s ease;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

/* Modified Dot */
.qic-modified-dot {
    width: 8px;
    height: 8px;
    background: var(--qic-status-warning);
    border-radius: 50%;
    margin-left: 6px;
    flex-shrink: 0;
}

/* Unsaved Warning Modal */
.qic-unsaved-modal {
    max-width: 400px;
}

.qic-unsaved-modal .qic-modal-header {
    color: var(--qic-status-warning);
}

.qic-unsaved-modal .qic-modal-body p {
    margin: 0;
    line-height: 1.5;
}

.qic-unsaved-modal .qic-modal-footer {
    gap: 8px;
}
```

### 4. Create Save State Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/saveStateManager.js
// @ts-nocheck
/**
 * QIC Save State Manager
 * Handles conversation save state and auto-save
 * GAP-08 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const CONFIG = {
        autoSaveDelayMs: 2000,
        autoSaveEnabled: true,
        showSaveIndicator: true,
        warnOnUnsavedSwitch: true,
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentState = {
        conversationId: null,
        status: 'saved',
        lastSavedAt: null,
        isDirty: false,
    };

    let autoSaveTimeout = null;
    let pendingSwitchAction = null;

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const indicator = document.getElementById('save-state-indicator');
    const modifiedDot = document.getElementById('conversation-modified');
    const warningDialog = document.getElementById('unsaved-warning-dialog');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Mark conversation as modified (dirty)
     */
    function markDirty() {
        if (!currentState.isDirty) {
            currentState.isDirty = true;
            currentState.status = 'unsaved';
            updateIndicator();
        }

        // Schedule auto-save
        if (CONFIG.autoSaveEnabled) {
            scheduleAutoSave();
        }
    }

    /**
     * Mark conversation as saved
     */
    function markSaved() {
        currentState.isDirty = false;
        currentState.status = 'saved';
        currentState.lastSavedAt = Date.now();
        updateIndicator();

        // Clear any pending auto-save
        clearAutoSave();
    }

    /**
     * Set save status
     */
    function setStatus(status, error) {
        currentState.status = status;
        if (error) {
            currentState.error = error;
        }
        updateIndicator();
    }

    /**
     * Check if can switch conversations
     * Returns Promise that resolves to true if switch allowed
     */
    async function canSwitchConversation() {
        if (!currentState.isDirty || !CONFIG.warnOnUnsavedSwitch) {
            return true;
        }

        return showUnsavedWarning();
    }

    /**
     * Trigger manual save
     */
    function triggerSave() {
        if (!currentState.isDirty) {
            return;
        }

        setStatus('saving');

        vscode.postMessage({
            type: 'conversation:save',
            payload: {
                conversationId: currentState.conversationId,
            }
        });
    }

    /**
     * Set current conversation
     */
    function setConversation(conversationId, isDirty = false) {
        currentState.conversationId = conversationId;
        currentState.isDirty = isDirty;
        currentState.status = isDirty ? 'unsaved' : 'saved';
        currentState.lastSavedAt = isDirty ? null : Date.now();
        updateIndicator();
    }

    /**
     * Get current save state
     */
    function getState() {
        return { ...currentState };
    }

    // ═══════════════════════════════════════════════════════════════════
    // Auto-Save
    // ═══════════════════════════════════════════════════════════════════

    function scheduleAutoSave() {
        clearAutoSave();

        autoSaveTimeout = setTimeout(() => {
            if (currentState.isDirty) {
                triggerSave();
            }
        }, CONFIG.autoSaveDelayMs);
    }

    function clearAutoSave() {
        if (autoSaveTimeout) {
            clearTimeout(autoSaveTimeout);
            autoSaveTimeout = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // UI Updates
    // ═══════════════════════════════════════════════════════════════════

    function updateIndicator() {
        if (!indicator || !CONFIG.showSaveIndicator) {
            return;
        }

        indicator.hidden = false;
        indicator.dataset.status = currentState.status;

        const icon = indicator.querySelector('.qic-save-icon');
        const text = indicator.querySelector('.qic-save-text');

        switch (currentState.status) {
            case 'saved':
                icon.className = 'qic-save-icon codicon codicon-check';
                text.textContent = formatSavedTime(currentState.lastSavedAt);
                break;

            case 'saving':
                icon.className = 'qic-save-icon codicon codicon-sync';
                text.textContent = 'Saving...';
                break;

            case 'unsaved':
                icon.className = 'qic-save-icon codicon codicon-circle-filled';
                text.textContent = 'Unsaved';
                break;

            case 'error':
                icon.className = 'qic-save-icon codicon codicon-error';
                text.textContent = 'Save failed';
                break;
        }

        // Update modified dot
        if (modifiedDot) {
            modifiedDot.hidden = !currentState.isDirty;
        }
    }

    function formatSavedTime(timestamp) {
        if (!timestamp) return 'Saved';

        const now = Date.now();
        const diff = now - timestamp;

        if (diff < 5000) {
            return 'Just saved';
        } else if (diff < 60000) {
            return 'Saved';
        } else {
            const date = new Date(timestamp);
            return `Saved at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Unsaved Warning Dialog
    // ═══════════════════════════════════════════════════════════════════

    function showUnsavedWarning() {
        return new Promise((resolve) => {
            if (!warningDialog) {
                resolve(true);
                return;
            }

            pendingSwitchAction = resolve;
            warningDialog.hidden = false;

            // Focus save button
            warningDialog.querySelector('[data-action="save"]')?.focus();

            // Announce
            window.QicAnnouncer?.announce('You have unsaved changes. Choose to save, discard, or cancel.');
        });
    }

    function hideUnsavedWarning() {
        if (warningDialog) {
            warningDialog.hidden = true;
        }
        pendingSwitchAction = null;
    }

    function handleWarningAction(action) {
        const resolve = pendingSwitchAction;
        hideUnsavedWarning();

        if (!resolve) return;

        switch (action) {
            case 'save':
                // Save first, then allow switch
                triggerSave();
                // Wait for save confirmation
                const handler = (state) => {
                    if (state.status === 'saved') {
                        resolve(true);
                    } else if (state.status === 'error') {
                        resolve(false);
                    }
                };
                // Listen for next state change
                onNextStateChange(handler);
                break;

            case 'discard':
                // Discard changes, allow switch
                currentState.isDirty = false;
                currentState.status = 'saved';
                updateIndicator();
                resolve(true);
                break;

            case 'cancel':
                // Don't switch
                resolve(false);
                break;
        }
    }

    let stateChangeCallback = null;
    function onNextStateChange(callback) {
        stateChangeCallback = callback;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Handling
    // ═══════════════════════════════════════════════════════════════════

    function handleMessage(message) {
        switch (message.type) {
            case 'conversation:saved':
                markSaved();
                if (stateChangeCallback) {
                    stateChangeCallback(currentState);
                    stateChangeCallback = null;
                }
                break;

            case 'conversation:save-error':
                setStatus('error', message.payload?.error);
                if (stateChangeCallback) {
                    stateChangeCallback(currentState);
                    stateChangeCallback = null;
                }
                break;

            case 'conversation:loaded':
                setConversation(message.payload.conversationId, false);
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        // Warning dialog actions
        warningDialog?.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                handleWarningAction(btn.dataset.action);
            });
        });

        // Escape to cancel warning
        warningDialog?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                handleWarningAction('cancel');
            }
        });

        // Click outside to cancel
        warningDialog?.addEventListener('click', (e) => {
            if (e.target === warningDialog) {
                handleWarningAction('cancel');
            }
        });

        // Keyboard shortcut to save (Cmd+S)
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                triggerSave();
            }
        });

        // Mark dirty when user types
        const input = document.getElementById('message-input');
        input?.addEventListener('input', () => {
            // Don't mark dirty for empty input
            if (input.value.trim()) {
                markDirty();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
        updateIndicator();
    }

    // Export
    window.QicSaveStateManager = {
        markDirty,
        markSaved,
        setStatus,
        canSwitchConversation,
        triggerSave,
        setConversation,
        getState,
        handleMessage,
        init,
    };

    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
```

### 5. Wire to Panel Integration

```typescript
// In qicPanel.ts - add save state handling

// When conversation changes
private async switchConversation(newConversationId: string): Promise<void> {
    // Check if can switch (GAP-08)
    const canSwitch = await this.webviewBridge.invoke('canSwitchConversation');
    if (!canSwitch) {
        return; // User cancelled
    }

    // Proceed with switch
    await this.loadConversation(newConversationId);
}

// When message is added
private onMessageAdded(): void {
    this.postMessage({ type: 'mark-dirty' });
}

// Handle save request from webview
private handleSaveRequest(conversationId: string): void {
    this.conversationService.save(conversationId)
        .then(() => {
            this.postMessage({ type: 'conversation:saved' });
        })
        .catch((error) => {
            this.postMessage({
                type: 'conversation:save-error',
                payload: { error: error.message }
            });
        });
}
```

### 6. Wire to Message Handler

```javascript
// In main.js

case 'conversation:saved':
case 'conversation:save-error':
case 'conversation:loaded':
    window.QicSaveStateManager?.handleMessage(message);
    break;

case 'mark-dirty':
    window.QicSaveStateManager?.markDirty();
    break;
```

---

## Verification

### Success Criteria
- [ ] Save indicator shows "Saved" after auto-save
- [ ] Save indicator shows "Saving..." during save
- [ ] Modified dot appears when conversation modified
- [ ] Cmd+S triggers manual save
- [ ] Warning dialog appears when switching with unsaved changes
- [ ] "Save & Continue" saves then switches
- [ ] "Don't Save" discards and switches
- [ ] "Cancel" stays on current conversation
- [ ] Auto-save triggers after 2 seconds of inactivity

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Auto-save | Type message, wait 2s | "Saving..." then "Saved" |
| Modified dot | Type message | Dot appears next to title |
| Manual save | Press Cmd+S | Saves immediately |
| Switch warning | Modify, try to switch | Warning dialog shows |
| Save and switch | Click "Save & Continue" | Saves, then switches |
| Discard | Click "Don't Save" | Switches without saving |
| Cancel | Click "Cancel" | Stays on conversation |
| Save error | Disconnect, try save | "Save failed" shown |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/saveStateManager.js
```

---

## Notes

- Auto-save delay is configurable (default 2s)
- Warning dialog can be disabled in settings
- Save indicator fades out after showing "Saved"
- Modified dot is always visible until saved
- Cmd+S works as manual save override
