# Prompt 02-05: Input Area

**Phase:** 2 - Panel Structure
**Dependencies:** 02-01 (Header HTML/CSS)
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Create the input area structure: auto-resizing textarea, send button, context chips row, and attachment indicators. This is the foundation for input lockout (02-06) and mentions (Phase 4).

---

## Context

The input area contains:
1. **Context chips row** - Shows attached context items (collapsible)
2. **Textarea** - Auto-resizing, placeholder text
3. **Send button** - Disabled when empty or locked
4. **Cancel button** - Shown during processing (hidden otherwise)
5. **Character/token estimate** - Optional footer

The input must:
- Auto-resize up to max height
- Support Ctrl+Enter / Cmd+Enter to submit
- Support Escape to cancel (when processing)
- Show placeholder based on state
- Be accessible (labels, roles)

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md`

---

## Scope

### In Scope
- Create input area HTML structure
- Create context chips row (basic - full implementation in Phase 4)
- Implement auto-resize textarea
- Implement send/cancel button toggle
- Add keyboard shortcuts
- Add character count display
- Wire basic form submission

### Out of Scope
- Input lockout logic (02-06)
- Mention autocomplete (Phase 4)
- Context chip interactions (Phase 4)
- Token estimation (Phase 4)

---

## Pre-Conditions

- [ ] 02-01 complete (header/panel structure)
- [ ] Git branch created: `qic-ui/02-05-input-area`

---

## Tasks

### 1. Create Input Area HTML

Update the webview HTML template:

```html
<!-- Input Area -->
<footer class="qic-input-footer">
    <!-- Context chips row -->
    <div id="context-chips-row" class="qic-context-chips-row" role="region" aria-label="Attached context">
        <div id="context-chips" class="qic-context-chips">
            <!-- Context chips rendered here -->
        </div>
        <button id="context-toggle" class="qic-context-toggle" title="Toggle context drawer" aria-expanded="false">
            <span class="codicon codicon-chevron-down"></span>
            <span id="context-count" class="qic-context-count">0</span>
        </button>
    </div>

    <!-- Input row -->
    <div class="qic-input-row">
        <div class="qic-input-wrapper">
            <textarea
                id="chat-input"
                class="qic-input"
                placeholder="Ask anything... (Ctrl+Enter to send)"
                rows="1"
                aria-label="Message input"
                autocomplete="off"
                spellcheck="true"
            ></textarea>
            <div class="qic-input-footer-info">
                <span id="char-count" class="qic-char-count" aria-live="polite"></span>
            </div>
        </div>
        <div class="qic-input-actions">
            <button
                id="send-btn"
                class="qic-send-btn"
                type="button"
                title="Send message (Ctrl+Enter)"
                aria-label="Send message"
                disabled
            >
                <span class="codicon codicon-send"></span>
            </button>
            <button
                id="cancel-btn"
                class="qic-cancel-btn"
                type="button"
                title="Cancel (Escape)"
                aria-label="Cancel"
                hidden
            >
                <span class="codicon codicon-stop"></span>
            </button>
        </div>
    </div>

    <!-- Keyboard hints -->
    <div class="qic-input-hints" aria-hidden="true">
        <span class="qic-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> send</span>
        <span class="qic-hint"><kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
        <span class="qic-hint"><kbd>@</kbd> mention</span>
    </div>
</footer>
```

### 2. Create Input Core Module

```bash
touch src/vs/workbench/contrib/qic/browser/media/inputCore.js
```

### 3. Implement Input Core

```javascript
// src/vs/workbench/contrib/qic/browser/media/inputCore.js
// @ts-nocheck
/**
 * QIC Input Core
 * Handles input area structure and basic interactions
 * Note: Lockout logic is in inputManager.js (02-06)
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const CONFIG = {
        MIN_HEIGHT: 36,
        MAX_HEIGHT: 200,
        CHAR_WARN_THRESHOLD: 10000,
        CHAR_MAX_THRESHOLD: 50000,
    };

    // ═══════════════════════════════════════════════════════════════════
    // Elements
    // ═══════════════════════════════════════════════════════════════════

    let chatInput = null;
    let sendBtn = null;
    let cancelBtn = null;
    let charCount = null;
    let contextChipsRow = null;
    let contextChips = null;
    let contextToggle = null;
    let contextCount = null;

    // ═══════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        chatInput = document.getElementById('chat-input');
        sendBtn = document.getElementById('send-btn');
        cancelBtn = document.getElementById('cancel-btn');
        charCount = document.getElementById('char-count');
        contextChipsRow = document.getElementById('context-chips-row');
        contextChips = document.getElementById('context-chips');
        contextToggle = document.getElementById('context-toggle');
        contextCount = document.getElementById('context-count');

        if (!chatInput || !sendBtn) {
            console.error('[InputCore] Required elements not found');
            return;
        }

        setupEventListeners();
        updateCharCount();
        updateSendButtonState();

        console.log('[InputCore] Initialized');
    }

    function setupEventListeners() {
        // Input events
        chatInput.addEventListener('input', handleInput);
        chatInput.addEventListener('keydown', handleKeydown);
        chatInput.addEventListener('focus', handleFocus);
        chatInput.addEventListener('blur', handleBlur);

        // Button events
        sendBtn.addEventListener('click', handleSendClick);
        cancelBtn?.addEventListener('click', handleCancelClick);

        // Context toggle
        contextToggle?.addEventListener('click', handleContextToggle);

        // Paste handling
        chatInput.addEventListener('paste', handlePaste);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════════════════════════════

    function handleInput(e) {
        autoResize();
        updateCharCount();
        updateSendButtonState();

        // Dispatch custom event for other modules
        dispatchInputEvent('qic:input', { value: chatInput.value });
    }

    function handleKeydown(e) {
        // Ctrl/Cmd + Enter to submit
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (!sendBtn.disabled) {
                dispatchInputEvent('qic:submit', { value: chatInput.value });
            }
            return;
        }

        // Shift + Enter for new line (default behavior, but we can enhance)
        if (e.key === 'Enter' && e.shiftKey) {
            // Allow default behavior
            return;
        }

        // Plain Enter - configurable behavior
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            // Option: Submit on Enter (uncomment to enable)
            // e.preventDefault();
            // if (!sendBtn.disabled) {
            //     dispatchInputEvent('qic:submit', { value: chatInput.value });
            // }
            return;
        }

        // Escape to cancel
        if (e.key === 'Escape') {
            e.preventDefault();
            dispatchInputEvent('qic:cancel', {});
            return;
        }

        // @ for mention autocomplete (handled by Phase 4)
        if (e.key === '@') {
            dispatchInputEvent('qic:mention-trigger', {
                position: chatInput.selectionStart
            });
            return;
        }

        // Tab for autocomplete accept (Phase 4)
        if (e.key === 'Tab') {
            const hasAutocomplete = document.querySelector('.qic-autocomplete-active');
            if (hasAutocomplete) {
                e.preventDefault();
                dispatchInputEvent('qic:autocomplete-accept', {});
            }
            return;
        }

        // Arrow keys for autocomplete navigation (Phase 4)
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const hasAutocomplete = document.querySelector('.qic-autocomplete-active');
            if (hasAutocomplete) {
                e.preventDefault();
                dispatchInputEvent('qic:autocomplete-navigate', {
                    direction: e.key === 'ArrowUp' ? 'up' : 'down'
                });
            }
            return;
        }
    }

    function handleFocus() {
        chatInput.parentElement?.classList.add('qic-input-focused');
        dispatchInputEvent('qic:focus', {});
    }

    function handleBlur() {
        chatInput.parentElement?.classList.remove('qic-input-focused');
        dispatchInputEvent('qic:blur', {});
    }

    function handleSendClick(e) {
        e.preventDefault();
        if (!sendBtn.disabled) {
            dispatchInputEvent('qic:submit', { value: chatInput.value });
        }
    }

    function handleCancelClick(e) {
        e.preventDefault();
        dispatchInputEvent('qic:cancel', {});
    }

    function handleContextToggle(e) {
        e.preventDefault();
        const isExpanded = contextToggle.getAttribute('aria-expanded') === 'true';
        contextToggle.setAttribute('aria-expanded', !isExpanded);
        dispatchInputEvent('qic:context-toggle', { expanded: !isExpanded });
    }

    function handlePaste(e) {
        // Allow normal paste, but dispatch event for potential processing
        dispatchInputEvent('qic:paste', {
            text: e.clipboardData?.getData('text')
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Auto-resize
    // ═══════════════════════════════════════════════════════════════════

    function autoResize() {
        if (!chatInput) return;

        // Reset height to auto to get accurate scrollHeight
        chatInput.style.height = 'auto';

        // Calculate new height
        const scrollHeight = chatInput.scrollHeight;
        const newHeight = Math.min(Math.max(scrollHeight, CONFIG.MIN_HEIGHT), CONFIG.MAX_HEIGHT);

        chatInput.style.height = newHeight + 'px';

        // Add/remove scrollable class
        if (scrollHeight > CONFIG.MAX_HEIGHT) {
            chatInput.classList.add('qic-input-scrollable');
        } else {
            chatInput.classList.remove('qic-input-scrollable');
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Character Count
    // ═══════════════════════════════════════════════════════════════════

    function updateCharCount() {
        if (!charCount || !chatInput) return;

        const length = chatInput.value.length;

        if (length === 0) {
            charCount.textContent = '';
            charCount.className = 'qic-char-count';
            return;
        }

        charCount.textContent = length.toLocaleString();

        // Add warning/error classes
        if (length >= CONFIG.CHAR_MAX_THRESHOLD) {
            charCount.className = 'qic-char-count qic-char-error';
        } else if (length >= CONFIG.CHAR_WARN_THRESHOLD) {
            charCount.className = 'qic-char-count qic-char-warn';
        } else {
            charCount.className = 'qic-char-count';
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Button State
    // ═══════════════════════════════════════════════════════════════════

    function updateSendButtonState() {
        if (!sendBtn || !chatInput) return;

        const hasContent = chatInput.value.trim().length > 0;
        const isOverLimit = chatInput.value.length >= CONFIG.CHAR_MAX_THRESHOLD;
        const isLocked = chatInput.classList.contains('qic-input-locked');

        sendBtn.disabled = !hasContent || isOverLimit || isLocked;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Context Chips (Basic - Full implementation in Phase 4)
    // ═══════════════════════════════════════════════════════════════════

    function updateContextChips(items) {
        if (!contextChips || !contextCount) return;

        // Update count
        contextCount.textContent = items.length.toString();

        // Show/hide row
        if (contextChipsRow) {
            contextChipsRow.hidden = items.length === 0;
        }

        // Render chips (basic - full implementation in Phase 4)
        contextChips.innerHTML = items.slice(0, 5).map(item => `
            <div class="qic-context-chip" data-id="${escapeAttr(item.id)}">
                <span class="codicon codicon-${getContextIcon(item.type)}"></span>
                <span class="qic-chip-label">${escapeHtml(item.displayName)}</span>
                <button class="qic-chip-remove" title="Remove" aria-label="Remove ${item.displayName}">
                    <span class="codicon codicon-close"></span>
                </button>
            </div>
        `).join('');

        // Add overflow indicator
        if (items.length > 5) {
            contextChips.innerHTML += `
                <span class="qic-chip-overflow">+${items.length - 5} more</span>
            `;
        }

        // Wire remove buttons
        contextChips.querySelectorAll('.qic-chip-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chip = btn.closest('.qic-context-chip');
                const id = chip?.dataset.id;
                if (id) {
                    dispatchInputEvent('qic:context-remove', { id });
                }
            });
        });
    }

    function getContextIcon(type) {
        const icons = {
            'file': 'file',
            'folder': 'folder',
            'selection': 'selection',
            'symbol': 'symbol-method',
            'terminal': 'terminal',
            'diagnostic': 'warning',
            'docs': 'book'
        };
        return icons[type] || 'file';
    }

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    function getValue() {
        return chatInput?.value || '';
    }

    function setValue(value) {
        if (!chatInput) return;
        chatInput.value = value;
        autoResize();
        updateCharCount();
        updateSendButtonState();
    }

    function clear() {
        setValue('');
    }

    function focus() {
        chatInput?.focus();
    }

    function blur() {
        chatInput?.blur();
    }

    function disable() {
        if (chatInput) chatInput.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
    }

    function enable() {
        if (chatInput) chatInput.disabled = false;
        updateSendButtonState();
    }

    function setPlaceholder(text) {
        if (chatInput) chatInput.placeholder = text;
    }

    function showCancelButton() {
        if (sendBtn) sendBtn.hidden = true;
        if (cancelBtn) cancelBtn.hidden = false;
    }

    function hideCancelButton() {
        if (sendBtn) sendBtn.hidden = false;
        if (cancelBtn) cancelBtn.hidden = true;
    }

    function insertText(text, position = null) {
        if (!chatInput) return;

        const start = position ?? chatInput.selectionStart;
        const end = chatInput.selectionEnd;
        const before = chatInput.value.substring(0, start);
        const after = chatInput.value.substring(end);

        chatInput.value = before + text + after;
        chatInput.selectionStart = chatInput.selectionEnd = start + text.length;

        autoResize();
        updateCharCount();
        updateSendButtonState();
        chatInput.focus();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function dispatchInputEvent(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail }));
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function escapeAttr(text) {
        if (!text) return '';
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ═══════════════════════════════════════════════════════════════════
    // Export
    // ═══════════════════════════════════════════════════════════════════

    window.qicInputCore = {
        init,
        getValue,
        setValue,
        clear,
        focus,
        blur,
        disable,
        enable,
        setPlaceholder,
        showCancelButton,
        hideCancelButton,
        insertText,
        autoResize,
        updateSendButtonState,
        updateContextChips,

        // For other modules
        getElement: () => chatInput,

        // For debugging
        _debug: {
            getConfig: () => CONFIG
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

### 4. Add Input Area CSS

```css
/* ═══════════════════════════════════════════════════════════════════════
   INPUT FOOTER
   ═══════════════════════════════════════════════════════════════════════ */

.qic-input-footer {
    flex-shrink: 0;
    padding: var(--qic-space-2) var(--qic-space-3) var(--qic-space-3);
    background: var(--qic-bg-primary);
    border-top: 1px solid var(--qic-border-default);
}

/* ═══════════════════════════════════════════════════════════════════════
   CONTEXT CHIPS ROW
   ═══════════════════════════════════════════════════════════════════════ */

.qic-context-chips-row {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    margin-bottom: var(--qic-space-2);
    padding-bottom: var(--qic-space-2);
    border-bottom: 1px solid var(--qic-border-default);
}

.qic-context-chips-row[hidden] {
    display: none;
}

.qic-context-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--qic-space-1);
    flex: 1;
    overflow: hidden;
}

.qic-context-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-full);
    font-size: var(--qic-text-xs);
    max-width: 150px;
}

.qic-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.qic-chip-remove {
    background: none;
    border: none;
    color: var(--qic-fg-muted);
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
}

.qic-chip-remove:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
}

.qic-chip-overflow {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
    padding: 2px 8px;
}

.qic-context-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    color: var(--qic-fg-muted);
    cursor: pointer;
    padding: var(--qic-space-1);
    border-radius: var(--qic-radius-sm);
}

.qic-context-toggle:hover {
    background: var(--qic-bg-secondary);
    color: var(--qic-fg-primary);
}

.qic-context-toggle[aria-expanded="true"] .codicon {
    transform: rotate(180deg);
}

.qic-context-count {
    background: var(--qic-bg-tertiary);
    padding: 0 6px;
    border-radius: var(--qic-radius-full);
    font-size: var(--qic-text-xs);
}

/* ═══════════════════════════════════════════════════════════════════════
   INPUT ROW
   ═══════════════════════════════════════════════════════════════════════ */

.qic-input-row {
    display: flex;
    align-items: flex-end;
    gap: var(--qic-space-2);
}

.qic-input-wrapper {
    flex: 1;
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-lg);
    transition: border-color 0.15s, box-shadow 0.15s;
}

.qic-input-wrapper:focus-within {
    border-color: var(--qic-accent-primary);
    box-shadow: 0 0 0 2px rgba(var(--qic-accent-primary-rgb), 0.2);
}

.qic-input-focused .qic-input-wrapper {
    border-color: var(--qic-accent-primary);
}

.qic-input {
    width: 100%;
    min-height: 36px;
    max-height: 200px;
    padding: var(--qic-space-2) var(--qic-space-3);
    background: transparent;
    border: none;
    color: var(--qic-fg-primary);
    font-family: inherit;
    font-size: var(--qic-text-sm);
    line-height: 1.5;
    resize: none;
    outline: none;
}

.qic-input::placeholder {
    color: var(--qic-fg-muted);
}

.qic-input-scrollable {
    overflow-y: auto;
}

.qic-input-footer-info {
    display: flex;
    justify-content: flex-end;
    padding: 0 var(--qic-space-2) var(--qic-space-1);
}

.qic-char-count {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
}

.qic-char-warn {
    color: var(--qic-status-warning);
}

.qic-char-error {
    color: var(--qic-status-error);
}

/* ═══════════════════════════════════════════════════════════════════════
   INPUT ACTIONS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-input-actions {
    display: flex;
    gap: var(--qic-space-1);
}

.qic-send-btn,
.qic-cancel-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--qic-radius-md);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s, opacity 0.15s;
}

.qic-send-btn {
    background: var(--qic-accent-primary);
    color: white;
}

.qic-send-btn:hover:not(:disabled) {
    opacity: 0.9;
}

.qic-send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.qic-cancel-btn {
    background: var(--qic-status-error);
    color: white;
}

.qic-cancel-btn:hover {
    opacity: 0.9;
}

.qic-cancel-btn[hidden],
.qic-send-btn[hidden] {
    display: none;
}

/* ═══════════════════════════════════════════════════════════════════════
   KEYBOARD HINTS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-input-hints {
    display: flex;
    gap: var(--qic-space-3);
    margin-top: var(--qic-space-2);
    justify-content: center;
}

.qic-hint {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
}

.qic-hint kbd {
    display: inline-block;
    padding: 1px 4px;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-sm);
    font-family: inherit;
    font-size: 10px;
}

/* Hide hints on narrow panels */
@media (max-width: 300px) {
    .qic-input-hints {
        display: none;
    }
}
```

### 5. Include in Webview HTML

```html
<script src="${inputCoreUri}"></script>
```

---

## Verification

### Success Criteria
- [ ] Textarea auto-resizes up to max height
- [ ] Character count updates on input
- [ ] Send button disabled when empty
- [ ] Send button disabled when over limit
- [ ] Ctrl+Enter triggers submit event
- [ ] Escape triggers cancel event
- [ ] Context chips row shows/hides correctly
- [ ] Context toggle expands/collapses
- [ ] Remove button removes chip
- [ ] Focus styling applied
- [ ] Keyboard hints visible

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Auto-resize | Type multi-line text | Textarea grows |
| Max height | Type very long text | Stops at 200px, scrollbar appears |
| Empty state | Clear input | Send disabled |
| Long text | Type 10000+ chars | Count turns warning color |
| Ctrl+Enter | Press shortcut | Submit event fires |
| Escape | Press Escape | Cancel event fires |
| Focus | Click input | Border highlights |
| Chip remove | Click X on chip | Remove event fires |

### Event Test

```javascript
// In DevTools console
window.addEventListener('qic:submit', (e) => console.log('Submit:', e.detail));
window.addEventListener('qic:cancel', (e) => console.log('Cancel'));
window.addEventListener('qic:context-remove', (e) => console.log('Remove:', e.detail));
```

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/media/inputCore.js
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- Input lockout logic is separate (02-06)
- Mention autocomplete is Phase 4
- Events use CustomEvent for loose coupling
- Context chips are basic - enhanced in Phase 4
- Consider adding drag-drop for file attachment later
