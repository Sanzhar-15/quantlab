# Prompt 02-06: Input Lockout (GAP-17 Fix)

**Phase:** 2 - Panel Structure
**Dependencies:** 02-05 (Input Area), 01-05 (State Manager)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement input lockout during processing to prevent concurrent requests, double-clicks, and race conditions. This addresses GAP-17 from the audit.

---

## Context

Without input lockout:
- User can send multiple messages rapidly
- Double-clicking send creates duplicates
- Interacting during state transitions causes bugs

Solution:
- Lock input when agentState is not 'idle'
- Debounce submit button
- Show appropriate feedback
- Unlock on state change

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md` (GAP-17 FIX section)

---

## Scope

### In Scope
- Create `inputManager.js` for webview
- Implement input lockout logic
- Subscribe to agentState changes
- Add debounce to prevent double-clicks
- Show toast feedback
- Handle cancel via Escape
- Update placeholder during lock

### Out of Scope
- Input auto-resize (02-05)
- Mention autocomplete (Phase 4)
- Validation (Phase 6)

---

## Pre-Conditions

- [ ] 02-05 complete (input area structure)
- [ ] 01-05 complete (state manager with selectors)
- [ ] Git branch created: `qic-ui/02-06-input-lockout`

---

## Tasks

### 1. Create Input Manager

```bash
touch src/vs/workbench/contrib/qic/browser/media/inputManager.js
```

### 2. Implement Input Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/inputManager.js
// @ts-nocheck
/**
 * QIC Input Manager
 * Handles input lockout and concurrent request prevention
 * GAP-17 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const CONFIG = {
        DEBOUNCE_MS: 300,           // Prevent double-clicks
        ERROR_UNLOCK_DELAY_MS: 3000, // Unlock after error state
        TOAST_DURATION_MS: 2000,    // Toast visibility duration
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let chatInput = null;
    let sendBtn = null;
    let cancelBtn = null;
    let isLocked = false;
    let lastSubmitTime = 0;
    let currentPlaceholder = 'Ask anything...';
    let unsubscribe = null;

    // ═══════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        chatInput = document.getElementById('chat-input');
        sendBtn = document.getElementById('send-btn');
        cancelBtn = document.getElementById('cancel-btn');

        if (!chatInput || !sendBtn) {
            console.error('[InputManager] Required elements not found');
            return;
        }

        setupEventListeners();
        subscribeToState();
        updateSendButtonState();

        console.log('[InputManager] Initialized');
    }

    function setupEventListeners() {
        // Input changes
        chatInput.addEventListener('input', handleInput);

        // Keyboard shortcuts
        chatInput.addEventListener('keydown', handleKeydown);

        // Send button click
        sendBtn.addEventListener('click', handleSendClick);

        // Cancel button (if exists)
        cancelBtn?.addEventListener('click', handleCancel);

        // Prevent form submission
        chatInput.form?.addEventListener('submit', (e) => {
            e.preventDefault();
            submit();
        });
    }

    function subscribeToState() {
        if (!window.qicState) {
            console.warn('[InputManager] State manager not available');
            return;
        }

        unsubscribe = window.qicState.subscribe((state, patch) => {
            // React to agentState changes
            if (!patch || patch.path === 'agentState' || patch.path === '*') {
                handleAgentStateChange(window.qicState.selectors.getAgentState());
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════════════════════════════

    function handleInput() {
        updateSendButtonState();
        autoResize();
    }

    function handleKeydown(e) {
        // Cmd/Ctrl + Enter to submit
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
            return;
        }

        // Escape to cancel (when locked)
        if (e.key === 'Escape' && isLocked) {
            e.preventDefault();
            handleCancel();
            return;
        }

        // Plain Enter (optional: submit on Enter without modifier)
        // Uncomment if desired:
        // if (e.key === 'Enter' && !e.shiftKey) {
        //     e.preventDefault();
        //     submit();
        // }
    }

    function handleSendClick(e) {
        e.preventDefault();
        submit();
    }

    function handleCancel() {
        if (!isLocked) return;

        vscode.postMessage({ type: 'cancel' });
        showToast('Cancelling...');
    }

    function handleAgentStateChange(agentState) {
        console.log('[InputManager] Agent state:', agentState);

        switch (agentState) {
            case 'idle':
                unlock();
                break;

            case 'processing':
                lock('processing');
                break;

            case 'waiting_approval':
                lock('waiting_approval');
                break;

            case 'error':
                lock('error');
                // Auto-unlock after delay for error state
                setTimeout(() => {
                    const currentState = window.qicState?.selectors.getAgentState();
                    if (currentState === 'error') {
                        unlock();
                    }
                }, CONFIG.ERROR_UNLOCK_DELAY_MS);
                break;

            case 'suspended':
                lock('suspended');
                break;

            default:
                console.warn('[InputManager] Unknown agent state:', agentState);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Lock/Unlock
    // ═══════════════════════════════════════════════════════════════════

    function lock(reason) {
        if (isLocked) return;

        isLocked = true;
        chatInput.disabled = true;
        sendBtn.disabled = true;

        // Show cancel button, hide send button
        if (cancelBtn) {
            sendBtn.hidden = true;
            cancelBtn.hidden = false;
        }

        // Update placeholder
        currentPlaceholder = chatInput.placeholder;
        chatInput.placeholder = getPlaceholderForReason(reason);

        // Add visual indicator
        chatInput.classList.add('qic-input-locked');

        console.log('[InputManager] Locked:', reason);
    }

    function unlock() {
        if (!isLocked) return;

        isLocked = false;
        chatInput.disabled = false;
        updateSendButtonState();

        // Show send button, hide cancel button
        if (cancelBtn) {
            sendBtn.hidden = false;
            cancelBtn.hidden = true;
        }

        // Restore placeholder
        chatInput.placeholder = currentPlaceholder || 'Ask anything...';

        // Remove visual indicator
        chatInput.classList.remove('qic-input-locked');

        // Focus input
        chatInput.focus();

        console.log('[InputManager] Unlocked');
    }

    function getPlaceholderForReason(reason) {
        const placeholders = {
            'processing': 'Waiting for response...',
            'waiting_approval': 'Waiting for your approval...',
            'error': 'Error occurred - check status',
            'suspended': 'Conversation suspended'
        };
        return placeholders[reason] || 'Please wait...';
    }

    // ═══════════════════════════════════════════════════════════════════
    // Submit
    // ═══════════════════════════════════════════════════════════════════

    function submit() {
        const now = Date.now();

        // Debounce rapid submissions
        if (now - lastSubmitTime < CONFIG.DEBOUNCE_MS) {
            console.log('[InputManager] Debounced rapid submit');
            return false;
        }

        // Check lock state
        if (isLocked) {
            showToast('Please wait for the current response...');
            return false;
        }

        // Get content
        const content = chatInput.value.trim();
        if (!content) {
            return false;
        }

        // Record submit time
        lastSubmitTime = now;

        // Lock immediately for responsive feel
        lock('processing');

        // Collect mentions (basic implementation)
        const mentions = extractMentions(content);

        // Send message
        vscode.postMessage({
            type: 'send',
            payload: { content, mentions }
        });

        // Clear input
        chatInput.value = '';
        autoResize();

        console.log('[InputManager] Submitted');
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function updateSendButtonState() {
        if (isLocked) {
            sendBtn.disabled = true;
            return;
        }
        sendBtn.disabled = !chatInput.value.trim();
    }

    function autoResize() {
        chatInput.style.height = 'auto';
        const newHeight = Math.min(chatInput.scrollHeight, 200);
        chatInput.style.height = newHeight + 'px';
    }

    function extractMentions(content) {
        // Basic mention extraction
        // Full implementation in Phase 4
        const mentions = [];
        const regex = /@([\w./\-]+)/g;
        let match;

        while ((match = regex.exec(content)) !== null) {
            mentions.push({
                id: match[1],
                type: 'file',
                path: match[1],
                displayName: match[1],
                tokens: 0
            });
        }

        return mentions;
    }

    function showToast(message) {
        // Remove existing toast
        const existing = document.querySelector('.qic-toast');
        existing?.remove();

        // Create new toast
        const toast = document.createElement('div');
        toast.className = 'qic-toast';
        toast.textContent = message;
        toast.setAttribute('role', 'alert');
        document.body.appendChild(toast);

        // Remove after duration
        setTimeout(() => toast.remove(), CONFIG.TOAST_DURATION_MS);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    window.qicInput = {
        init,
        submit,
        cancel: handleCancel,
        isLocked: () => isLocked,
        focus: () => chatInput?.focus(),

        // For debugging
        _debug: {
            lock,
            unlock,
            getLastSubmitTime: () => lastSubmitTime
        }
    };

    // Auto-init when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
```

### 3. Add Required CSS

```css
/* ═══════════════════════════════════════════════════════════════════════
   INPUT LOCKOUT STYLES (GAP-17)
   ═══════════════════════════════════════════════════════════════════════ */

.qic-input-locked {
    opacity: 0.7;
    cursor: not-allowed !important;
}

.qic-input-locked::placeholder {
    font-style: italic;
}

/* Cancel Button */
#cancel-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--qic-height-input, 36px);
    height: var(--qic-height-input, 36px);
    background: var(--qic-status-error);
    border: none;
    border-radius: var(--qic-radius-md);
    cursor: pointer;
    color: white;
    flex-shrink: 0;
}

#cancel-btn:hover {
    opacity: 0.9;
}

#cancel-btn[hidden] {
    display: none;
}

/* Toast */
.qic-toast {
    position: fixed;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    padding: var(--qic-space-2) var(--qic-space-4);
    background: var(--qic-bg-tertiary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-sm);
    z-index: var(--qic-z-toast, 1000);
    animation: qic-toast-in 0.2s ease-out;
    box-shadow: var(--qic-shadow-lg);
}

@keyframes qic-toast-in {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}

/* Z-index for toast */
:root {
    --qic-z-toast: 1000;
}
```

### 4. Update Input Area HTML

Add cancel button to input area:

```html
<div class="qic-input-area">
    <textarea
        id="chat-input"
        class="qic-input"
        placeholder="Ask anything..."
        rows="1"
        aria-label="Message input"
    ></textarea>
    <button
        id="send-btn"
        class="qic-send-btn"
        title="Send (Cmd+Enter)"
        aria-label="Send message"
        disabled
    >
        <span class="codicon codicon-send"></span>
    </button>
    <button
        id="cancel-btn"
        class="qic-cancel-btn"
        title="Cancel (Escape)"
        aria-label="Cancel"
        hidden
    >
        <span class="codicon codicon-stop"></span>
    </button>
</div>
```

### 5. Include in Webview HTML

```html
<!-- After stateManager.js and before other scripts -->
<script src="${inputManagerUri}"></script>
```

---

## Verification

### Success Criteria
- [ ] Input locked during processing
- [ ] Double-click doesn't duplicate
- [ ] Toast shows when locked
- [ ] Escape triggers cancel
- [ ] Unlock happens on idle
- [ ] Error state auto-unlocks
- [ ] Cancel button appears when locked
- [ ] Focus returns after unlock

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Basic lock | Send message | Input disables, placeholder changes |
| Double-click | Click send rapidly | Only one message sent |
| Toast feedback | Click send while locked | Toast appears |
| Escape cancel | Press Escape while locked | Cancel message sent |
| Auto-unlock | Wait for response | Input re-enables |
| Error unlock | Trigger error | Unlocks after 3s |
| Focus | After unlock | Input gets focus |

### State Transition Test

```javascript
// In DevTools console
// Simulate state changes
window.qicState._debug.forceRefresh();

// Check lock state
console.log('Locked:', window.qicInput.isLocked());
```

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/media/inputManager.js
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- Input manager auto-initializes on DOM ready
- Integrates with state manager for agent state
- Toast is a simple implementation - can be enhanced later
- Mention extraction is basic - full implementation in Phase 4
