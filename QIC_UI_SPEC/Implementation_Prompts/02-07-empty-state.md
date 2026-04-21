# Prompt 02-07: Empty State

**Phase:** 2 - Panel Structure
**Dependencies:** 02-03 (Conversation Structure)
**Estimated Effort:** 0.5 session
**Critical Path:** No

---

## Objective

Create the empty conversation state UI: welcome message, quick action suggestions, and first-use guidance. This provides a good onboarding experience when no messages exist.

---

## Context

When a conversation has no messages, users should see:
1. **Welcome message** - Friendly greeting
2. **Quick actions** - Suggested prompts to get started
3. **Keyboard hints** - How to use the panel
4. **Feature highlights** - What QIC can do

The empty state should:
- Be visually appealing but not overwhelming
- Provide actionable starting points
- Disappear when first message is sent
- Be accessible

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md`

---

## Scope

### In Scope
- Create empty state HTML structure
- Create quick action buttons
- Add styling for empty state
- Wire quick actions to input
- Show/hide based on message count

### Out of Scope
- First-run consent flow (existing)
- Tutorial/onboarding wizard
- Feature discovery tooltips

---

## Pre-Conditions

- [ ] 02-03 complete (conversation area exists)
- [ ] Git branch created: `qic-ui/02-07-empty-state`

---

## Tasks

### 1. Create Empty State HTML

Update the empty state div in the webview HTML:

```html
<!-- Empty state (inside conversation area) -->
<div id="empty-state" class="qic-empty-state" role="region" aria-label="Get started with QIC">
    <div class="qic-empty-content">
        <!-- Logo/Icon -->
        <div class="qic-empty-icon" aria-hidden="true">
            <span class="qic-logo-large">◇</span>
        </div>

        <!-- Welcome message -->
        <h2 class="qic-empty-title">Welcome to QIC</h2>
        <p class="qic-empty-subtitle">Your AI coding assistant for Quantlab</p>

        <!-- Quick actions -->
        <div class="qic-quick-actions">
            <h3 class="qic-quick-actions-title">Try asking:</h3>
            <div class="qic-quick-action-grid">
                <button class="qic-quick-action" data-prompt="Explain this file">
                    <span class="codicon codicon-file-code"></span>
                    <span class="qic-action-text">Explain this file</span>
                </button>
                <button class="qic-quick-action" data-prompt="Find bugs in my code">
                    <span class="codicon codicon-bug"></span>
                    <span class="qic-action-text">Find bugs in my code</span>
                </button>
                <button class="qic-quick-action" data-prompt="Write tests for the selected function">
                    <span class="codicon codicon-beaker"></span>
                    <span class="qic-action-text">Write tests</span>
                </button>
                <button class="qic-quick-action" data-prompt="Refactor this to be more efficient">
                    <span class="codicon codicon-wand"></span>
                    <span class="qic-action-text">Refactor code</span>
                </button>
                <button class="qic-quick-action" data-prompt="Help me analyze this dataset">
                    <span class="codicon codicon-graph"></span>
                    <span class="qic-action-text">Analyze data</span>
                </button>
                <button class="qic-quick-action" data-prompt="Explain this trading strategy">
                    <span class="codicon codicon-pulse"></span>
                    <span class="qic-action-text">Explain strategy</span>
                </button>
            </div>
        </div>

        <!-- Feature highlights -->
        <div class="qic-features">
            <div class="qic-feature">
                <span class="codicon codicon-symbol-method"></span>
                <span>Use <kbd>@</kbd> to mention files, symbols, or docs</span>
            </div>
            <div class="qic-feature">
                <span class="codicon codicon-file-symlink-file"></span>
                <span>Click <code>[[file paths]]</code> to open files</span>
            </div>
            <div class="qic-feature">
                <span class="codicon codicon-save-all"></span>
                <span>Changes are checkpointed for safety</span>
            </div>
        </div>

        <!-- Keyboard shortcuts -->
        <div class="qic-keyboard-hints">
            <div class="qic-kb-hint">
                <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd>
                <span>Toggle panel</span>
            </div>
            <div class="qic-kb-hint">
                <kbd>Ctrl</kbd>+<kbd>N</kbd>
                <span>New chat</span>
            </div>
            <div class="qic-kb-hint">
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
                <span>Send message</span>
            </div>
        </div>
    </div>
</div>
```

### 2. Create Empty State Manager

```javascript
// Add to messageManager.js or create separate file

(function() {
    'use strict';

    let emptyState = null;

    function initEmptyState() {
        emptyState = document.getElementById('empty-state');
        if (!emptyState) return;

        // Wire quick action buttons
        emptyState.querySelectorAll('.qic-quick-action').forEach(btn => {
            btn.addEventListener('click', () => {
                const prompt = btn.dataset.prompt;
                if (prompt) {
                    insertPrompt(prompt);
                }
            });
        });
    }

    function insertPrompt(prompt) {
        // Insert into input and focus
        if (window.qicInputCore) {
            window.qicInputCore.setValue(prompt);
            window.qicInputCore.focus();
        }
    }

    function showEmptyState() {
        if (emptyState) {
            emptyState.hidden = false;
        }
    }

    function hideEmptyState() {
        if (emptyState) {
            emptyState.hidden = true;
        }
    }

    window.qicEmptyState = {
        init: initEmptyState,
        show: showEmptyState,
        hide: hideEmptyState
    };

    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEmptyState);
    } else {
        initEmptyState();
    }

})();
```

### 3. Add Empty State CSS

```css
/* ═══════════════════════════════════════════════════════════════════════
   EMPTY STATE
   ═══════════════════════════════════════════════════════════════════════ */

.qic-empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: var(--qic-space-6);
    text-align: center;
    overflow-y: auto;
}

.qic-empty-state[hidden] {
    display: none;
}

.qic-empty-content {
    max-width: 400px;
}

.qic-empty-icon {
    margin-bottom: var(--qic-space-4);
}

.qic-logo-large {
    font-size: 48px;
    color: var(--qic-accent-primary);
    display: inline-block;
    animation: qic-pulse-gentle 3s ease-in-out infinite;
}

@keyframes qic-pulse-gentle {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.8; transform: scale(1.05); }
}

.qic-empty-title {
    font-size: var(--qic-text-xl);
    font-weight: 600;
    color: var(--qic-fg-primary);
    margin: 0 0 var(--qic-space-1);
}

.qic-empty-subtitle {
    font-size: var(--qic-text-sm);
    color: var(--qic-fg-muted);
    margin: 0 0 var(--qic-space-6);
}

/* ═══════════════════════════════════════════════════════════════════════
   QUICK ACTIONS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-quick-actions {
    margin-bottom: var(--qic-space-6);
}

.qic-quick-actions-title {
    font-size: var(--qic-text-sm);
    font-weight: 500;
    color: var(--qic-fg-secondary);
    margin: 0 0 var(--qic-space-3);
}

.qic-quick-action-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--qic-space-2);
}

.qic-quick-action {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-sm);
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}

.qic-quick-action:hover {
    background: var(--qic-bg-tertiary);
    border-color: var(--qic-accent-primary);
}

.qic-quick-action .codicon {
    font-size: 16px;
    color: var(--qic-accent-primary);
}

.qic-action-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Single column on narrow panels */
@media (max-width: 350px) {
    .qic-quick-action-grid {
        grid-template-columns: 1fr;
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   FEATURE HIGHLIGHTS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-features {
    display: flex;
    flex-direction: column;
    gap: var(--qic-space-2);
    margin-bottom: var(--qic-space-6);
    text-align: left;
}

.qic-feature {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-secondary);
}

.qic-feature .codicon {
    color: var(--qic-fg-muted);
    font-size: 14px;
}

.qic-feature kbd {
    display: inline-block;
    padding: 1px 4px;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-sm);
    font-family: inherit;
    font-size: 10px;
}

.qic-feature code {
    background: var(--qic-bg-secondary);
    padding: 1px 4px;
    border-radius: var(--qic-radius-sm);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
}

/* ═══════════════════════════════════════════════════════════════════════
   KEYBOARD HINTS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-keyboard-hints {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--qic-space-4);
    padding-top: var(--qic-space-4);
    border-top: 1px solid var(--qic-border-default);
}

.qic-kb-hint {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1);
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
}

.qic-kb-hint kbd {
    display: inline-block;
    padding: 2px 5px;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-sm);
    font-family: inherit;
    font-size: 10px;
    min-width: 18px;
    text-align: center;
}

/* Hide some hints on very narrow panels */
@media (max-width: 280px) {
    .qic-keyboard-hints {
        display: none;
    }

    .qic-features {
        display: none;
    }
}
```

### 4. Wire to Message Manager

Update `messageManager.js` to show/hide empty state:

```javascript
function renderMessages() {
    const state = window.qicState?.getState?.();
    if (!state) return;

    const messages = state.conversation?.messages || [];

    // Show/hide empty state
    if (window.qicEmptyState) {
        if (messages.length === 0) {
            window.qicEmptyState.show();
        } else {
            window.qicEmptyState.hide();
        }
    }

    // ... rest of render logic
}
```

---

## Verification

### Success Criteria
- [ ] Empty state visible when no messages
- [ ] Empty state hidden when messages exist
- [ ] Quick action buttons insert prompts
- [ ] Input focuses after quick action click
- [ ] Styling looks good on various widths
- [ ] Keyboard shortcuts displayed correctly
- [ ] Animation is subtle and not distracting
- [ ] Screen reader can access content

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Initial load | Open new chat | Empty state visible |
| Quick action | Click "Explain this file" | Prompt in input, input focused |
| First message | Send message | Empty state disappears |
| New chat | Click new chat | Empty state reappears |
| Narrow panel | Resize to 250px | Single column, some hints hidden |

---

## Rollback

```bash
# Revert HTML changes and CSS additions
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- Quick actions are Quantlab-specific ("Analyze data", "Explain strategy")
- Consider making quick actions configurable later
- Animation should be subtle - not distracting
- May want to A/B test different quick action sets
- Consider adding dynamic suggestions based on open file
