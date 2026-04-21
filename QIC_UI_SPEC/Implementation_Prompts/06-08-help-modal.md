# Prompt 06-08: Help & Shortcuts Modal

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete
**Estimated Effort:** 0.5 session
**Critical Path:** No

---

## Objective

Implement the Help & Shortcuts modal that displays all available keyboard shortcuts, quick tips, and links to documentation. This improves discoverability and helps users learn QIC's power features.

---

## Context

From the spec (Section 10):
- Triggered by Menu → "Help & shortcuts" or `Cmd+/`
- Width: 480px, max-height: 80vh, scrollable
- Organized by category (Global, Panel, Diff Review)
- Includes links to documentation and issue reporting

Reference: `QIC_UI_SPEC/QIC-UI-Specification-v1.4.md` Section 10

---

## Scope

### In Scope
- Help modal HTML structure
- Keyboard shortcut sections
- Documentation links
- Focus trapping
- Keyboard shortcut to open (`Cmd+/`)
- Accessible navigation

### Out of Scope
- Actual documentation content
- Issue reporting system
- Shortcut customization

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] Basic modal infrastructure from strategy warning
- [ ] Git branch created: `qic-ui/06-08-help-modal`

---

## Tasks

### 1. Create Help Modal HTML

```html
<!-- Help & Shortcuts Modal -->
<div id="help-modal" class="qic-modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="help-modal-title">
    <div class="qic-modal qic-help-modal">
        <div class="qic-modal-header">
            <span class="codicon codicon-question"></span>
            <h2 id="help-modal-title">Help & Shortcuts</h2>
            <button class="qic-modal-close" aria-label="Close" data-action="close">
                <span class="codicon codicon-close"></span>
            </button>
        </div>

        <div class="qic-modal-body qic-help-content">
            <!-- Global Shortcuts -->
            <section class="qic-help-section">
                <h3>Global</h3>
                <div class="qic-shortcuts-list">
                    <div class="qic-shortcut">
                        <kbd>Cmd+L</kbd>
                        <span>Focus QIC input</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+Shift+N</kbd>
                        <span>New conversation</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+Shift+H</kbd>
                        <span>Open history</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+Shift+C</kbd>
                        <span>Create checkpoint</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+Ctrl+Z</kbd>
                        <span>Restore checkpoint</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+/</kbd>
                        <span>Show this help</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+.</kbd>
                        <span>Stop generation</span>
                    </div>
                </div>
            </section>

            <!-- Panel Shortcuts -->
            <section class="qic-help-section">
                <h3>Panel</h3>
                <div class="qic-shortcuts-list">
                    <div class="qic-shortcut">
                        <kbd>Cmd+Enter</kbd>
                        <span>Send message</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Escape</kbd>
                        <span>Cancel / Clear</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>@</kbd>
                        <span>Mention file or symbol</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Up</kbd>
                        <span>Edit last message (when empty)</span>
                    </div>
                </div>
            </section>

            <!-- Diff Review Shortcuts -->
            <section class="qic-help-section">
                <h3>Diff Review</h3>
                <div class="qic-shortcuts-list">
                    <div class="qic-shortcut">
                        <kbd>Cmd+Enter</kbd>
                        <span>Accept change</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Escape</kbd>
                        <span>Reject change</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>F7</kbd>
                        <span>Next file</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Shift+F7</kbd>
                        <span>Previous file</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+Shift+R</kbd>
                        <span>Open review mode</span>
                    </div>
                </div>
            </section>

            <!-- Review Mode -->
            <section class="qic-help-section">
                <h3>Review Mode</h3>
                <div class="qic-shortcuts-list">
                    <div class="qic-shortcut">
                        <kbd>↓</kbd> / <kbd>↑</kbd>
                        <span>Navigate files</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>
                        <span>Navigate hunks</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>J</kbd> / <kbd>K</kbd>
                        <span>Vim-style navigation</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>A</kbd>
                        <span>Accept current file</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>R</kbd>
                        <span>Reject current file</span>
                    </div>
                    <div class="qic-shortcut">
                        <kbd>Cmd+Shift+A</kbd>
                        <span>Accept all</span>
                    </div>
                </div>
            </section>

            <!-- Tips -->
            <section class="qic-help-section">
                <h3>Tips</h3>
                <ul class="qic-tips-list">
                    <li>Use <code>@filename</code> to add files as context</li>
                    <li>Click file names in responses to open them</li>
                    <li>Checkpoints are created automatically before changes</li>
                    <li>Use "Explain" to understand code before modifying</li>
                    <li>Pin frequently used context items for persistence</li>
                </ul>
            </section>
        </div>

        <div class="qic-modal-footer qic-help-footer">
            <a href="#" class="qic-help-link" data-action="docs">
                <span class="codicon codicon-book"></span> Documentation
            </a>
            <a href="#" class="qic-help-link" data-action="report">
                <span class="codicon codicon-github"></span> Report issue
            </a>
            <button class="qic-btn primary" data-action="close">Close</button>
        </div>
    </div>
</div>
```

### 2. Add Help Modal Styles

```css
/* ========================================
   Help Modal Styles
   ======================================== */

.qic-help-modal {
    width: 480px;
}

.qic-help-content {
    max-height: calc(80vh - 140px);
    overflow-y: auto;
}

.qic-help-section {
    margin-bottom: 24px;
}

.qic-help-section:last-child {
    margin-bottom: 0;
}

.qic-help-section h3 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 12px 0;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
}

.qic-shortcuts-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.qic-shortcut {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
}

.qic-shortcut kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    padding: 2px 8px;
    background: var(--vscode-keybindingLabel-background);
    border: 1px solid var(--vscode-keybindingLabel-border);
    border-radius: 4px;
    font-family: var(--qic-font-mono);
    font-size: 11px;
    color: var(--vscode-keybindingLabel-foreground);
    box-shadow: 0 1px 0 var(--vscode-keybindingLabel-bottomBorder);
}

.qic-shortcut span {
    flex: 1;
    text-align: right;
    color: var(--vscode-foreground);
    font-size: 13px;
}

.qic-tips-list {
    margin: 0;
    padding-left: 20px;
}

.qic-tips-list li {
    margin-bottom: 8px;
    font-size: 13px;
    line-height: 1.5;
}

.qic-tips-list code {
    padding: 2px 4px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px;
    font-size: 12px;
}

.qic-help-footer {
    display: flex;
    align-items: center;
    gap: 16px;
}

.qic-help-link {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    font-size: 13px;
}

.qic-help-link:hover {
    color: var(--vscode-textLink-activeForeground);
    text-decoration: underline;
}

.qic-help-footer .qic-btn {
    margin-left: auto;
}

/* Scrollbar styling */
.qic-help-content::-webkit-scrollbar {
    width: 8px;
}

.qic-help-content::-webkit-scrollbar-track {
    background: transparent;
}

.qic-help-content::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
}

.qic-help-content::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
}
```

### 3. Create Help Modal Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/helpModalManager.js
// @ts-nocheck
/**
 * QIC Help Modal Manager
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════

    const DOCS_URL = 'https://docs.quantlab.io/qic';
    const ISSUES_URL = 'https://github.com/quantlab/qic/issues/new';

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let focusTrap = null;
    let previouslyFocused = null;

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const modal = document.getElementById('help-modal');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    function show() {
        if (!modal) return;

        modal.hidden = false;
        previouslyFocused = document.activeElement;
        setupFocusTrap();

        // Focus close button
        modal.querySelector('[data-action="close"]')?.focus();

        // Announce
        window.QicAnnouncer?.announce('Help and shortcuts dialog opened');
    }

    function hide() {
        if (!modal) return;

        modal.hidden = true;
        removeFocusTrap();
        previouslyFocused?.focus();
    }

    function toggle() {
        if (modal?.hidden) {
            show();
        } else {
            hide();
        }
    }

    function isVisible() {
        return modal && !modal.hidden;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Focus Trap
    // ═══════════════════════════════════════════════════════════════════

    function setupFocusTrap() {
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];

        focusTrap = (e) => {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    if (document.activeElement === firstFocusable) {
                        e.preventDefault();
                        lastFocusable.focus();
                    }
                } else {
                    if (document.activeElement === lastFocusable) {
                        e.preventDefault();
                        firstFocusable.focus();
                    }
                }
            } else if (e.key === 'Escape') {
                hide();
            }
        };

        modal.addEventListener('keydown', focusTrap);
    }

    function removeFocusTrap() {
        if (focusTrap) {
            modal.removeEventListener('keydown', focusTrap);
            focusTrap = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Actions
    // ═══════════════════════════════════════════════════════════════════

    function handleAction(action) {
        switch (action) {
            case 'close':
                hide();
                break;
            case 'docs':
                vscode.postMessage({
                    type: 'open-external',
                    payload: { url: DOCS_URL }
                });
                break;
            case 'report':
                vscode.postMessage({
                    type: 'open-external',
                    payload: { url: ISSUES_URL }
                });
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        if (!modal) return;

        // Action buttons and links
        modal.querySelectorAll('[data-action]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                handleAction(el.dataset.action);
            });
        });

        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hide();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
    }

    // Export
    window.QicHelpModal = {
        show,
        hide,
        toggle,
        isVisible,
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

### 4. Register Command and Keybinding

```typescript
// In qic.contribution.ts or commands registration

// Register help command
CommandsRegistry.registerCommand('qic.showHelp', async (accessor) => {
    const panelService = accessor.get(IQicPanelService);
    panelService.postMessage({ type: 'show-help' });
});

// Register keybinding
KeybindingsRegistry.registerKeybindingRule({
    id: 'qic.showHelp',
    weight: KeybindingWeight.WorkbenchContrib,
    when: undefined,
    primary: KeyMod.CtrlCmd | KeyCode.Slash,
});

// Add to menu
MenuRegistry.appendMenuItem(MenuId.QicMenu, {
    command: {
        id: 'qic.showHelp',
        title: localize('qic.help', 'Help & Shortcuts'),
    },
    group: 'z_help',
    order: 1,
});
```

### 5. Wire to Message Handler

```javascript
// In main.js

case 'show-help':
    window.QicHelpModal?.show();
    break;
```

---

## Verification

### Success Criteria
- [ ] Modal opens with `Cmd+/`
- [ ] Modal opens from menu
- [ ] All shortcuts displayed correctly
- [ ] Keyboard display uses proper styling
- [ ] Tips section visible
- [ ] Documentation link works
- [ ] Report issue link works
- [ ] Close button works
- [ ] Escape closes modal
- [ ] Click outside closes modal
- [ ] Focus trapped within modal
- [ ] Scrollable when content overflows

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Keyboard open | Press `Cmd+/` | Modal opens |
| Menu open | Menu → Help | Modal opens |
| Close button | Click Close | Modal closes |
| Escape | Press Escape | Modal closes |
| Click outside | Click overlay | Modal closes |
| Documentation | Click Docs link | Browser opens |
| Report issue | Click Report link | Browser opens |
| Scrolling | Resize window small | Content scrolls |
| Focus trap | Tab repeatedly | Stays in modal |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/helpModalManager.js
```

---

## Notes

- Shortcuts should match actual registered keybindings
- Consider making shortcuts configurable
- Documentation URL should be configurable
- Could add search/filter for shortcuts
- Consider dark/light theme variations for kbd styling
