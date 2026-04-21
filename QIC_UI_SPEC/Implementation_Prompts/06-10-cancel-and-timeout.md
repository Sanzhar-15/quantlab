# Prompt 06-10: Cancel Semantics & Timeout Handling

**Phase:** 6 - Polish
**Dependencies:** 02-04 (Streaming), 02-06 (Input Lockout)
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Implement comprehensive cancel and timeout handling throughout the QIC UI. This addresses GAP-02 (state timeout handling) and GAP-10 (cancel semantics) from the audit.

---

## Context

Users need clear feedback and control when:
1. **Pre-stream cancel**: User cancels before response starts
2. **Mid-stream cancel**: User cancels while streaming
3. **Pending tool cancel**: User cancels during tool execution
4. **Permission cancel**: User cancels permission dialog
5. **Timeout warning**: Request taking longer than expected
6. **Timeout recovery**: Automatic recovery after timeout

From GAP-02, the backend has state timeouts:
```typescript
const STATE_TIMEOUTS = {
    'idle->processing': 120_000,      // 2 min
    'processing->waiting_approval': 300_000,  // 5 min
    'processing->idle': 600_000,      // 10 min
};
```

---

## Scope

### In Scope
- Cancel button states and behavior
- Cancel confirmation for destructive actions
- Partial message handling on cancel
- Timeout warning UI
- Timeout recovery actions
- State cleanup after cancel/timeout
- Keyboard cancel (Escape, Cmd+.)

### Out of Scope
- Backend timeout logic
- Retry queue management
- Network error handling (06-03)

---

## Pre-Conditions

- [ ] 02-04 complete (streaming implementation)
- [ ] 02-06 complete (input lockout)
- [ ] State service with agentState
- [ ] Git branch created: `qic-ui/06-10-cancel-timeout`

---

## Tasks

### 1. Define Cancel and Timeout Types

```typescript
// src/vs/workbench/contrib/qic/common/types/cancelTimeout.ts

export type CancelReason =
    | 'user_requested'
    | 'timeout'
    | 'error'
    | 'navigation'
    | 'panel_closed';

export interface CancelResult {
    reason: CancelReason;
    preservePartial: boolean;
    messageId?: string;
    partialContent?: string;
}

export interface TimeoutWarning {
    stage: 'processing' | 'waiting_approval' | 'tool_execution';
    elapsed: number;
    threshold: number;
    message: string;
}

export interface TimeoutConfig {
    warningThreshold: number;  // Show warning after this (ms)
    hardTimeout: number;       // Auto-cancel after this (ms)
    showRetry: boolean;
}
```

### 2. Create Cancel Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/cancelManager.js
// @ts-nocheck
/**
 * QIC Cancel Manager
 * Handles cancel actions and their effects
 * GAP-10 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const CANCEL_SCENARIOS = {
        'pre-stream': {
            // Before any response received
            effect: 'clear_pending',
            preservePartial: false,
            confirmRequired: false,
        },
        'mid-stream': {
            // During streaming
            effect: 'finalize_partial',
            preservePartial: true,
            confirmRequired: false,
        },
        'tool-pending': {
            // During tool execution
            effect: 'abort_tool',
            preservePartial: true,
            confirmRequired: true,
            confirmMessage: 'Cancel tool execution? This may leave your workspace in an inconsistent state.',
        },
        'permission-pending': {
            // Waiting for permission
            effect: 'deny_permission',
            preservePartial: false,
            confirmRequired: false,
        },
        'approval-pending': {
            // Waiting for change approval
            effect: 'dismiss_changes',
            preservePartial: false,
            confirmRequired: true,
            confirmMessage: 'Dismiss pending changes? You can regenerate them later.',
        },
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentOperation = null;
    let cancelInProgress = false;

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Request cancellation of current operation
     * @returns {Promise<CancelResult>}
     */
    async function requestCancel(reason = 'user_requested') {
        if (cancelInProgress) {
            console.log('[Cancel] Cancel already in progress');
            return null;
        }

        const scenario = determineScenario();
        if (!scenario) {
            console.log('[Cancel] Nothing to cancel');
            return null;
        }

        const config = CANCEL_SCENARIOS[scenario];

        // Check if confirmation needed
        if (config.confirmRequired) {
            const confirmed = await showConfirmation(config.confirmMessage);
            if (!confirmed) {
                return null;
            }
        }

        cancelInProgress = true;

        try {
            // Execute cancel based on scenario
            const result = await executeCancel(scenario, reason);

            // Update UI
            handleCancelComplete(scenario, result);

            return result;
        } finally {
            cancelInProgress = false;
        }
    }

    /**
     * Determine current scenario based on state
     */
    function determineScenario() {
        const state = window.QicStateManager?.getState();
        if (!state) return null;

        const agentState = state.agentState;

        // Check for streaming
        if (window.QicStreamingManager?.isStreaming()) {
            return 'mid-stream';
        }

        // Check for pending tool
        if (state.pendingToolCall) {
            return 'tool-pending';
        }

        // Check for pending permission
        if (document.querySelector('.qic-permission-card:not([hidden])')) {
            return 'permission-pending';
        }

        // Check for pending approval
        if (state.pendingChanges?.length > 0) {
            return 'approval-pending';
        }

        // Check if processing but no stream yet
        if (agentState === 'processing') {
            return 'pre-stream';
        }

        return null;
    }

    /**
     * Execute the cancel action
     */
    async function executeCancel(scenario, reason) {
        const config = CANCEL_SCENARIOS[scenario];
        const result = {
            scenario,
            reason,
            preservePartial: config.preservePartial,
        };

        switch (config.effect) {
            case 'clear_pending':
                // Just notify backend, no cleanup needed
                vscode.postMessage({
                    type: 'cancel:request',
                    payload: { reason, scenario }
                });
                break;

            case 'finalize_partial':
                // Finalize the partial message
                const partialContent = window.QicStreamingManager?.getContent();
                window.QicStreamingManager?.completeStream(true);

                result.partialContent = partialContent;

                vscode.postMessage({
                    type: 'cancel:request',
                    payload: {
                        reason,
                        scenario,
                        preservePartial: true,
                        partialContent,
                    }
                });
                break;

            case 'abort_tool':
                vscode.postMessage({
                    type: 'cancel:abort-tool',
                    payload: { reason }
                });
                break;

            case 'deny_permission':
                // Close all permission cards with denial
                document.querySelectorAll('.qic-permission-card').forEach(card => {
                    const requestId = card.dataset.requestId;
                    window.QicPermissionManager?.respondToPermission(requestId, false, 'once', 'Cancelled');
                });
                break;

            case 'dismiss_changes':
                vscode.postMessage({
                    type: 'changes:dismiss-all',
                    payload: { reason }
                });
                break;
        }

        return result;
    }

    /**
     * Handle cancel completion
     */
    function handleCancelComplete(scenario, result) {
        // Show feedback
        let message = 'Cancelled';

        switch (scenario) {
            case 'mid-stream':
                message = result.preservePartial
                    ? 'Stopped. Partial response preserved.'
                    : 'Stopped.';
                break;
            case 'tool-pending':
                message = 'Tool execution cancelled.';
                break;
            case 'permission-pending':
                message = 'Permission denied.';
                break;
            case 'approval-pending':
                message = 'Changes dismissed.';
                break;
        }

        // Show indicator
        showCancelIndicator(message);

        // Announce for screen readers
        window.QicAnnouncer?.announce(message);

        // Re-enable input
        window.QicInputManager?.setEnabled(true);
    }

    /**
     * Show cancel indicator on message
     */
    function showCancelIndicator(message) {
        const indicator = document.createElement('div');
        indicator.className = 'qic-cancel-indicator';
        indicator.innerHTML = `
            <span class="codicon codicon-debug-stop"></span>
            <span>${message}</span>
            <button class="qic-retry-btn" title="Retry">
                <span class="codicon codicon-refresh"></span> Retry
            </button>
        `;

        indicator.querySelector('.qic-retry-btn')?.addEventListener('click', () => {
            retryLastRequest();
            indicator.remove();
        });

        // Insert after last message
        const messages = document.getElementById('messages');
        if (messages) {
            messages.appendChild(indicator);
            messages.scrollTop = messages.scrollHeight;
        }

        // Auto-remove after 10 seconds
        setTimeout(() => {
            indicator.classList.add('fading');
            setTimeout(() => indicator.remove(), 300);
        }, 10000);
    }

    /**
     * Retry the last cancelled request
     */
    function retryLastRequest() {
        vscode.postMessage({ type: 'retry:last' });
    }

    /**
     * Show confirmation dialog
     */
    async function showConfirmation(message) {
        return new Promise(resolve => {
            // Use simple confirm for now
            // Could be replaced with custom modal
            resolve(window.confirm(message));
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Keyboard Handling
    // ═══════════════════════════════════════════════════════════════════

    function setupKeyboardHandlers() {
        // Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const scenario = determineScenario();
                if (scenario) {
                    e.preventDefault();
                    requestCancel('user_requested');
                }
            }
        });

        // Cmd+. (macOS stop shortcut)
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === '.') {
                e.preventDefault();
                requestCancel('user_requested');
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Export
    // ═══════════════════════════════════════════════════════════════════

    window.QicCancelManager = {
        requestCancel,
        determineScenario,
    };

    // Initialize
    setupKeyboardHandlers();
})();
```

### 3. Create Timeout Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/timeoutManager.js
// @ts-nocheck
/**
 * QIC Timeout Manager
 * Handles timeout warnings and recovery
 * GAP-02 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const TIMEOUTS = {
        processing: {
            warning: 30000,    // 30 seconds - show warning
            extended: 60000,   // 1 minute - show extended warning
            hard: 120000,      // 2 minutes - auto-cancel option
        },
        tool_execution: {
            warning: 15000,    // 15 seconds
            extended: 30000,   // 30 seconds
            hard: 60000,       // 1 minute
        },
        waiting_approval: {
            warning: 300000,   // 5 minutes
            hard: 600000,      // 10 minutes (soft reminder)
        },
    };

    const MESSAGES = {
        processing: {
            warning: 'Taking longer than usual...',
            extended: 'Still working. This is taking a while.',
            hard: 'Request may have stalled. Consider cancelling.',
        },
        tool_execution: {
            warning: 'Tool execution in progress...',
            extended: 'Tool is still running.',
            hard: 'Tool execution taking too long.',
        },
        waiting_approval: {
            warning: 'Waiting for your approval.',
            hard: 'Changes are still pending approval.',
        },
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentStage = null;
    let stageStartTime = null;
    let timers = {};
    let warningBanner = null;

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Start tracking a stage
     */
    function startStage(stage) {
        clearTimers();
        currentStage = stage;
        stageStartTime = Date.now();

        const config = TIMEOUTS[stage];
        if (!config) return;

        // Set warning timers
        if (config.warning) {
            timers.warning = setTimeout(() => {
                showWarning(stage, 'warning');
            }, config.warning);
        }

        if (config.extended) {
            timers.extended = setTimeout(() => {
                showWarning(stage, 'extended');
            }, config.extended);
        }

        if (config.hard) {
            timers.hard = setTimeout(() => {
                showWarning(stage, 'hard');
            }, config.hard);
        }

        console.log(`[Timeout] Started tracking: ${stage}`);
    }

    /**
     * End tracking current stage
     */
    function endStage() {
        clearTimers();
        hideWarning();
        currentStage = null;
        stageStartTime = null;
    }

    /**
     * Clear all timers
     */
    function clearTimers() {
        Object.values(timers).forEach(t => clearTimeout(t));
        timers = {};
    }

    /**
     * Get elapsed time in current stage
     */
    function getElapsed() {
        if (!stageStartTime) return 0;
        return Date.now() - stageStartTime;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Warning Banner
    // ═══════════════════════════════════════════════════════════════════

    function showWarning(stage, level) {
        const message = MESSAGES[stage]?.[level] || 'Taking longer than expected...';

        if (!warningBanner) {
            createWarningBanner();
        }

        // Update message
        warningBanner.querySelector('.qic-timeout-message').textContent = message;

        // Update styling based on level
        warningBanner.dataset.level = level;

        // Show/hide cancel button based on level
        const cancelBtn = warningBanner.querySelector('.qic-timeout-cancel');
        if (cancelBtn) {
            cancelBtn.hidden = level !== 'hard';
        }

        // Update elapsed time
        updateElapsedTime();

        warningBanner.hidden = false;

        // Announce for screen readers
        window.QicAnnouncer?.announce(message);
    }

    function hideWarning() {
        if (warningBanner) {
            warningBanner.hidden = true;
        }
    }

    function createWarningBanner() {
        warningBanner = document.createElement('div');
        warningBanner.className = 'qic-timeout-banner';
        warningBanner.innerHTML = `
            <span class="codicon codicon-loading qic-timeout-spinner"></span>
            <span class="qic-timeout-message"></span>
            <span class="qic-timeout-elapsed"></span>
            <button class="qic-timeout-cancel qic-btn secondary" hidden>
                Cancel
            </button>
        `;

        warningBanner.querySelector('.qic-timeout-cancel')?.addEventListener('click', () => {
            window.QicCancelManager?.requestCancel('timeout');
        });

        // Insert at top of messages
        const messages = document.getElementById('messages');
        if (messages) {
            messages.parentNode.insertBefore(warningBanner, messages);
        }

        // Start elapsed time updater
        setInterval(updateElapsedTime, 1000);
    }

    function updateElapsedTime() {
        if (!warningBanner || warningBanner.hidden) return;

        const elapsed = getElapsed();
        const seconds = Math.floor(elapsed / 1000);
        const minutes = Math.floor(seconds / 60);

        let text;
        if (minutes > 0) {
            text = `${minutes}m ${seconds % 60}s`;
        } else {
            text = `${seconds}s`;
        }

        const elapsedEl = warningBanner.querySelector('.qic-timeout-elapsed');
        if (elapsedEl) {
            elapsedEl.textContent = text;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // State Change Handling
    // ═══════════════════════════════════════════════════════════════════

    function handleStateChange(newState, oldState) {
        const agentState = newState.agentState;
        const prevAgentState = oldState?.agentState;

        if (agentState === prevAgentState) return;

        switch (agentState) {
            case 'processing':
                startStage('processing');
                break;

            case 'waiting_approval':
                startStage('waiting_approval');
                break;

            case 'idle':
            case 'error':
                endStage();
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Export
    // ═══════════════════════════════════════════════════════════════════

    window.QicTimeoutManager = {
        startStage,
        endStage,
        getElapsed,
        handleStateChange,
    };
})();
```

### 4. Add Cancel/Timeout Styles

```css
/* ========================================
   Cancel & Timeout Styles
   ======================================== */

/* Cancel Indicator */
.qic-cancel-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    margin: 8px 0;
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    border-radius: 6px;
    font-size: 13px;
}

.qic-cancel-indicator .codicon {
    color: var(--qic-status-warning);
}

.qic-retry-btn {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
}

.qic-retry-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.qic-cancel-indicator.fading {
    animation: fadeOut 0.3s ease-out forwards;
}

@keyframes fadeOut {
    to {
        opacity: 0;
        height: 0;
        padding: 0;
        margin: 0;
        overflow: hidden;
    }
}

/* Timeout Banner */
.qic-timeout-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--qic-status-warning-bg);
    border-bottom: 1px solid var(--qic-status-warning);
    font-size: 13px;
}

.qic-timeout-banner[data-level="hard"] {
    background: var(--qic-status-error-bg);
    border-color: var(--qic-status-error);
}

.qic-timeout-spinner {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.qic-timeout-message {
    flex: 1;
}

.qic-timeout-elapsed {
    font-family: var(--qic-font-mono);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-timeout-banner[data-level="hard"] .qic-timeout-elapsed {
    color: var(--qic-status-error);
    font-weight: 600;
}

.qic-timeout-cancel {
    margin-left: 8px;
}

/* Stop Button */
.qic-stop-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: var(--qic-status-error);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.qic-stop-btn:hover {
    background: var(--qic-status-error);
    filter: brightness(1.1);
}

.qic-stop-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
    .qic-timeout-spinner {
        animation: none;
    }

    .qic-cancel-indicator.fading {
        animation: none;
        opacity: 0;
    }
}
```

### 5. Update Input Area with Stop Button

```javascript
// In inputManager.js - add stop button handling

function updateInputState(agentState) {
    const stopBtn = document.getElementById('stop-btn');
    const sendBtn = document.getElementById('send-btn');

    if (agentState === 'processing' || agentState === 'waiting_approval') {
        // Show stop button, hide send
        if (stopBtn) stopBtn.hidden = false;
        if (sendBtn) sendBtn.hidden = true;
    } else {
        // Show send button, hide stop
        if (stopBtn) stopBtn.hidden = true;
        if (sendBtn) sendBtn.hidden = false;
    }
}

// Wire stop button
document.getElementById('stop-btn')?.addEventListener('click', () => {
    window.QicCancelManager?.requestCancel('user_requested');
});
```

### 6. Wire to State Changes

```javascript
// In main.js or stateManager.js

// Subscribe to state changes for timeout tracking
window.QicStateManager?.onStateChange((newState, oldState) => {
    window.QicTimeoutManager?.handleStateChange(newState, oldState);
});
```

---

## Verification

### Success Criteria
- [ ] Escape key cancels current operation
- [ ] Cmd+. cancels current operation
- [ ] Stop button appears during processing
- [ ] Pre-stream cancel clears cleanly
- [ ] Mid-stream cancel preserves partial
- [ ] Cancel indicator shows with retry button
- [ ] Timeout warning shows after 30s
- [ ] Extended warning shows after 1m
- [ ] Hard timeout shows cancel option
- [ ] Elapsed time updates correctly

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Escape cancel | Press Escape during stream | Stream stops |
| Cmd+. cancel | Press Cmd+. during stream | Stream stops |
| Stop button | Click stop during stream | Stream stops |
| Partial preserved | Cancel mid-stream | Partial text shown |
| Retry button | Click Retry | Request retries |
| 30s warning | Wait 30s | Warning banner shows |
| Hard timeout | Wait 2m | Cancel option shows |
| Tool cancel | Cancel during tool | Confirmation shown |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/cancelManager.js
git checkout src/vs/workbench/contrib/qic/browser/media/timeoutManager.js
```

---

## Notes

- Partial content preservation is best-effort
- Tool abort may leave inconsistent state (warning shown)
- Timeout thresholds could be configurable
- Consider adaptive timeouts based on history
- Retry uses same context as original request
