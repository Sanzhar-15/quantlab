# Prompt 01-05: Webview State Manager

**Phase:** 1 - Foundation
**Dependencies:** 01-03 (Protocol V2 Types)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement the webview-side state manager that handles revision-based state synchronization with the VS Code host.

---

## Context

The webview needs to:
1. Receive and apply state updates from the host
2. Track revision numbers to detect gaps
3. Request full state when gaps detected
4. Notify UI components of state changes
5. Handle both full state and patch updates

This runs in the webview (browser context), not Node.js.

Reference: `QIC_UI_SPEC/Optimal_plan/03-STATE-AND-PROTOCOL.md`

---

## Scope

### In Scope
- Create `stateManager.js` for webview
- Implement state storage
- Implement patch application
- Implement gap detection
- Implement subscriber notification
- Export global `window.qicState` API

### Out of Scope
- UI rendering (uses this state)
- Host-side code
- TypeScript (webview uses plain JS)

---

## Pre-Conditions

- [ ] 01-03 complete (understand message formats)
- [ ] Git branch created: `qic-ui/01-05-webview-state`

---

## Tasks

### 1. Create State Manager File

```bash
touch src/vs/workbench/contrib/qic/browser/media/stateManager.js
```

### 2. Implement State Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/stateManager.js
// @ts-nocheck
/**
 * QIC Webview State Manager
 * Handles revision-based state synchronization with VS Code host
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // State Storage
    // ═══════════════════════════════════════════════════════════════════

    /** @type {Object|null} Current state */
    let state = null;

    /** @type {number} Current revision number */
    let currentRevision = 0;

    /** @type {Set<Function>} State change listeners */
    const listeners = new Set();

    /** @type {boolean} Whether we've received initial state */
    let initialized = false;

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Get current state (read-only)
     * @returns {Object|null}
     */
    function getState() {
        return state;
    }

    /**
     * Get current revision
     * @returns {number}
     */
    function getRevision() {
        return currentRevision;
    }

    /**
     * Check if state is initialized
     * @returns {boolean}
     */
    function isInitialized() {
        return initialized;
    }

    /**
     * Subscribe to state changes
     * @param {Function} listener - Called with (state, patch) on change
     * @returns {Function} Unsubscribe function
     */
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    /**
     * Get a specific value from state using dot notation
     * @param {string} path - e.g., 'conversation.messages'
     * @param {*} defaultValue - Value if path not found
     * @returns {*}
     */
    function get(path, defaultValue = undefined) {
        if (!state) return defaultValue;

        const parts = path.split('.');
        let current = state;

        for (const part of parts) {
            if (current === null || current === undefined) {
                return defaultValue;
            }
            current = current[part];
        }

        return current !== undefined ? current : defaultValue;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Handling
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Handle incoming message from host
     * @param {Object} msg - Message from host
     * @returns {boolean} Whether message was handled
     */
    function handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return false;

        switch (msg.type) {
            case 'state:full':
                return handleFullState(msg);

            case 'state:patch':
                return handlePatch(msg);

            case 'state:sync':
                // Host is checking if we're in sync
                sendRevisionAck();
                return true;

            default:
                return false;
        }
    }

    /**
     * Handle full state message
     * @param {Object} msg
     * @returns {boolean}
     */
    function handleFullState(msg) {
        if (typeof msg.revision !== 'number') {
            console.warn('[StateManager] Full state missing revision');
            return false;
        }

        state = msg.payload;
        currentRevision = msg.revision;
        initialized = true;

        notifyListeners(null); // null patch means full update
        sendRevisionAck();

        console.log('[StateManager] Full state received, revision:', currentRevision);
        return true;
    }

    /**
     * Handle patch message
     * @param {Object} msg
     * @returns {boolean}
     */
    function handlePatch(msg) {
        if (typeof msg.revision !== 'number') {
            console.warn('[StateManager] Patch missing revision');
            return false;
        }

        // Not initialized yet - request full state
        if (!state) {
            console.warn('[StateManager] Received patch but no state, requesting full');
            requestFullState();
            return false;
        }

        // Check for revision gap
        if (msg.revision > currentRevision + 1) {
            console.warn('[StateManager] Gap detected:', currentRevision, '->', msg.revision);
            requestFullState();
            return false;
        }

        // Ignore old revisions
        if (msg.revision <= currentRevision) {
            console.log('[StateManager] Ignoring old revision:', msg.revision);
            return true;
        }

        // Apply patch
        const patch = msg.payload;
        state = applyPatch(state, patch);
        currentRevision = msg.revision;

        notifyListeners(patch);
        sendRevisionAck();

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Patch Application
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Apply a patch to state (immutable)
     * @param {Object} state - Current state
     * @param {Object} patch - Patch to apply
     * @returns {Object} New state
     */
    function applyPatch(state, patch) {
        const path = patch.path;
        const value = patch.value;

        // Special case: full state replacement
        if (path === '*') {
            return { ...value, revision: patch.revision };
        }

        // Build new state with patch applied
        const newState = { ...state, revision: patch.revision };
        const parts = path.split('.');

        if (parts.length === 1) {
            // Top-level property
            newState[parts[0]] = value;
        } else {
            // Nested property - need to rebuild path
            setNestedValue(newState, parts, value);
        }

        return newState;
    }

    /**
     * Set a nested value immutably
     * @param {Object} obj - Object to modify (will be mutated at top level)
     * @param {string[]} path - Path parts
     * @param {*} value - Value to set
     */
    function setNestedValue(obj, path, value) {
        let current = obj;

        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i];
            // Create shallow copy of each level
            current[key] = { ...current[key] };
            current = current[key];
        }

        // Set the final value
        current[path[path.length - 1]] = value;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Communication with Host
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send revision acknowledgment to host
     */
    function sendRevisionAck() {
        if (typeof vscode !== 'undefined') {
            vscode.postMessage({
                type: 'revision:ack',
                revision: currentRevision
            });
        }
    }

    /**
     * Request full state from host (gap recovery)
     */
    function requestFullState() {
        if (typeof vscode !== 'undefined') {
            vscode.postMessage({
                type: 'state:request'
            });
        }
    }

    /**
     * Signal that webview is ready
     */
    function signalReady() {
        if (typeof vscode !== 'undefined') {
            vscode.postMessage({
                type: 'ready'
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Listener Notification
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Notify all listeners of state change
     * @param {Object|null} patch - The patch that was applied, or null for full update
     */
    function notifyListeners(patch) {
        for (const listener of listeners) {
            try {
                listener(state, patch);
            } catch (e) {
                console.error('[StateManager] Listener error:', e);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Selectors (convenience helpers)
    // ═══════════════════════════════════════════════════════════════════

    const selectors = {
        /** Get service status */
        getServiceStatus: () => get('serviceStatus', 'initializing'),

        /** Get agent state */
        getAgentState: () => get('agentState', 'idle'),

        /** Get connection info */
        getConnection: () => get('connection', {}),

        /** Get messages */
        getMessages: () => get('conversation.messages', []),

        /** Get context items */
        getContextItems: () => get('context.items', []),

        /** Get pending permission */
        getPendingPermission: () => get('permissions.pending', null),

        /** Get pending changes */
        getPendingChanges: () => get('conversation.pendingChanges', null),

        /** Get active tool calls */
        getActiveToolCalls: () => get('conversation.activeToolCalls', []),

        /** Get current lane */
        getCurrentLane: () => get('currentLane', 'chat-ask'),

        /** Check if streaming */
        isStreaming: () => get('conversation.isStreaming', false),

        /** Get token usage */
        getTokenUsage: () => ({
            used: get('context.totalTokens', 0),
            max: get('context.maxTokens', 32000)
        })
    };

    // ═══════════════════════════════════════════════════════════════════
    // Export Global API
    // ═══════════════════════════════════════════════════════════════════

    window.qicState = {
        // Core API
        getState,
        getRevision,
        isInitialized,
        subscribe,
        get,

        // Message handling
        handleMessage,
        signalReady,

        // Selectors
        selectors,

        // For debugging
        _debug: {
            getCurrentRevision: () => currentRevision,
            getListenerCount: () => listeners.size,
            forceRefresh: requestFullState
        }
    };

    // Log initialization
    console.log('[StateManager] Initialized');

})();
```

### 3. Add to Webview HTML

The state manager needs to be included in the webview HTML. In `qicPanel.ts`'s `getWebviewHtml()`:

```html
<!-- Include before other scripts -->
<script src="${stateManagerUri}"></script>

<!-- Other scripts can now use window.qicState -->
<script>
    // Example usage in main script
    window.addEventListener('message', (event) => {
        const msg = event.data;

        // Let state manager handle state messages
        if (window.qicState.handleMessage(msg)) {
            return;
        }

        // Handle other messages...
    });

    // Signal ready when loaded
    window.qicState.signalReady();
</script>
```

---

## Verification

### Success Criteria
- [ ] State manager loads without errors
- [ ] Full state handled correctly
- [ ] Patches applied correctly
- [ ] Gap detection works
- [ ] Listeners notified on changes
- [ ] Selectors return correct values

### Browser Console Tests

```javascript
// After webview loads:

// Check initialization
console.log('Initialized:', window.qicState.isInitialized());
console.log('Revision:', window.qicState.getRevision());

// Test subscription
const unsub = window.qicState.subscribe((state, patch) => {
    console.log('State changed:', patch ? patch.path : 'full');
});

// Test selectors
console.log('Service status:', window.qicState.selectors.getServiceStatus());
console.log('Agent state:', window.qicState.selectors.getAgentState());
console.log('Messages:', window.qicState.selectors.getMessages().length);

// Cleanup
unsub();
```

### Patch Application Test

```javascript
// Simulate patch
const state = { conversation: { messages: [], isStreaming: false } };
const patch = { revision: 1, path: 'conversation.isStreaming', value: true };

// After applying, state.conversation.isStreaming should be true
// and state.conversation.messages should still be []
```

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/media/stateManager.js
```

---

## Notes

- This is plain JavaScript (runs in webview, not Node.js)
- No external dependencies
- Uses IIFE to avoid global pollution except `window.qicState`
- Selectors provide convenient access patterns
- Debug API for development troubleshooting
