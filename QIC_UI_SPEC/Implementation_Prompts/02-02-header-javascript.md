# Prompt 02-02: Header JavaScript

**Phase:** 2 - Panel Structure
**Dependencies:** 02-01 (Header HTML/CSS)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement header interactivity: status button click, menu dropdown, and new chat button. Connect to state manager and wire Quick Pick triggers.

---

## Context

The header has three interactive elements:
1. **Status button (logo)** - Opens status Quick Pick showing service/agent state
2. **Menu button (⋮)** - Opens dropdown with History, Checkpoints, Provider, Settings, Help
3. **New Chat button (+)** - Creates new conversation

All buttons must respect the dual state model (GAP-01):
- ServiceStatus affects whether buttons are enabled
- AgentState affects visual indicators

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md`

---

## Scope

### In Scope
- Create `headerManager.js` for webview
- Implement status button with state indicator
- Implement menu dropdown with all items
- Implement new chat button
- Wire to state manager
- Send Quick Pick trigger messages to host
- Keyboard accessibility (Enter/Space activation)

### Out of Scope
- Quick Pick implementations (Phase 3)
- Status bar (Phase 3)
- Context drawer toggle (Phase 4)

---

## Pre-Conditions

- [ ] 02-01 complete (header HTML/CSS exists)
- [ ] 01-05 complete (state manager available)
- [ ] Git branch created: `qic-ui/02-02-header-js`

---

## Tasks

### 1. Create Header Manager

```bash
touch src/vs/workbench/contrib/qic/browser/media/headerManager.js
```

### 2. Implement Header Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/headerManager.js
// @ts-nocheck
/**
 * QIC Header Manager
 * Handles header button interactions and menu
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Elements
    // ═══════════════════════════════════════════════════════════════════

    let statusBtn = null;
    let menuBtn = null;
    let newChatBtn = null;
    let menuDropdown = null;
    let unsubscribe = null;

    // ═══════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        statusBtn = document.getElementById('status-btn');
        menuBtn = document.getElementById('menu-btn');
        newChatBtn = document.getElementById('new-chat-btn');
        menuDropdown = document.getElementById('menu-dropdown');

        if (!statusBtn || !menuBtn || !newChatBtn) {
            console.error('[HeaderManager] Required elements not found');
            return;
        }

        setupEventListeners();
        subscribeToState();
        createMenuDropdown();

        console.log('[HeaderManager] Initialized');
    }

    function setupEventListeners() {
        // Status button - opens status Quick Pick
        statusBtn.addEventListener('click', handleStatusClick);
        statusBtn.addEventListener('keydown', handleButtonKeydown);

        // Menu button - toggles dropdown
        menuBtn.addEventListener('click', handleMenuClick);
        menuBtn.addEventListener('keydown', handleButtonKeydown);

        // New chat button
        newChatBtn.addEventListener('click', handleNewChatClick);
        newChatBtn.addEventListener('keydown', handleButtonKeydown);

        // Close menu when clicking outside
        document.addEventListener('click', handleDocumentClick);

        // Close menu on Escape
        document.addEventListener('keydown', handleGlobalKeydown);
    }

    function subscribeToState() {
        if (!window.qicState) {
            console.warn('[HeaderManager] State manager not available');
            return;
        }

        unsubscribe = window.qicState.subscribe((state, patch) => {
            updateStatusIndicator();
            updateButtonStates();
        });

        // Initial update
        updateStatusIndicator();
        updateButtonStates();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════════════════════════════

    function handleStatusClick(e) {
        e.preventDefault();
        e.stopPropagation();

        // Close menu if open
        closeMenu();

        // Trigger status Quick Pick
        vscode.postMessage({ type: 'quickPick:status' });
    }

    function handleMenuClick(e) {
        e.preventDefault();
        e.stopPropagation();

        toggleMenu();
    }

    function handleNewChatClick(e) {
        e.preventDefault();

        // Check if allowed
        const serviceStatus = window.qicState?.selectors?.getServiceStatus?.() ?? 'ready';
        if (serviceStatus === 'error') {
            showToast('Cannot create new chat while QIC is in error state');
            return;
        }

        vscode.postMessage({ type: 'newChat' });
    }

    function handleButtonKeydown(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.target.click();
        }
    }

    function handleDocumentClick(e) {
        if (menuDropdown && !menuDropdown.contains(e.target) && !menuBtn.contains(e.target)) {
            closeMenu();
        }
    }

    function handleGlobalKeydown(e) {
        if (e.key === 'Escape') {
            closeMenu();
        }
    }

    function handleMenuItemClick(action) {
        closeMenu();

        switch (action) {
            case 'history':
                vscode.postMessage({ type: 'quickPick:history' });
                break;
            case 'checkpoints':
                vscode.postMessage({ type: 'quickPick:checkpoints' });
                break;
            case 'provider':
                vscode.postMessage({ type: 'quickPick:provider' });
                break;
            case 'settings':
                vscode.postMessage({ type: 'open-settings' });
                break;
            case 'help':
                vscode.postMessage({ type: 'show-help' });
                break;
            case 'export':
                vscode.postMessage({ type: 'export-conversation' });
                break;
            default:
                console.warn('[HeaderManager] Unknown menu action:', action);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Menu Management
    // ═══════════════════════════════════════════════════════════════════

    function createMenuDropdown() {
        if (menuDropdown) return;

        menuDropdown = document.createElement('div');
        menuDropdown.id = 'menu-dropdown';
        menuDropdown.className = 'qic-menu-dropdown';
        menuDropdown.setAttribute('role', 'menu');
        menuDropdown.hidden = true;

        const menuItems = [
            { action: 'history', label: 'History', icon: 'history', shortcut: 'Ctrl+Shift+H' },
            { action: 'checkpoints', label: 'Checkpoints', icon: 'save-all', shortcut: null },
            { divider: true },
            { action: 'provider', label: 'Switch Provider', icon: 'server', shortcut: null },
            { divider: true },
            { action: 'export', label: 'Export Chat', icon: 'export', shortcut: null },
            { action: 'settings', label: 'Settings', icon: 'settings-gear', shortcut: 'Ctrl+,' },
            { action: 'help', label: 'Help', icon: 'question', shortcut: 'F1' },
        ];

        menuItems.forEach((item, index) => {
            if (item.divider) {
                const divider = document.createElement('div');
                divider.className = 'qic-menu-divider';
                divider.setAttribute('role', 'separator');
                menuDropdown.appendChild(divider);
            } else {
                const menuItem = document.createElement('button');
                menuItem.className = 'qic-menu-item';
                menuItem.setAttribute('role', 'menuitem');
                menuItem.dataset.action = item.action;
                menuItem.innerHTML = `
                    <span class="codicon codicon-${item.icon}"></span>
                    <span class="qic-menu-label">${item.label}</span>
                    ${item.shortcut ? `<span class="qic-menu-shortcut">${item.shortcut}</span>` : ''}
                `;
                menuItem.addEventListener('click', () => handleMenuItemClick(item.action));
                menuItem.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleMenuItemClick(item.action);
                    }
                });
                menuDropdown.appendChild(menuItem);
            }
        });

        // Insert after menu button
        menuBtn.parentNode.appendChild(menuDropdown);
    }

    function toggleMenu() {
        if (!menuDropdown) return;

        const isOpen = !menuDropdown.hidden;
        if (isOpen) {
            closeMenu();
        } else {
            openMenu();
        }
    }

    function openMenu() {
        if (!menuDropdown) return;

        menuDropdown.hidden = false;
        menuBtn.setAttribute('aria-expanded', 'true');

        // Focus first item
        const firstItem = menuDropdown.querySelector('.qic-menu-item');
        firstItem?.focus();

        // Position dropdown
        positionDropdown();
    }

    function closeMenu() {
        if (!menuDropdown) return;

        menuDropdown.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
    }

    function positionDropdown() {
        if (!menuDropdown || !menuBtn) return;

        const btnRect = menuBtn.getBoundingClientRect();
        const dropdownRect = menuDropdown.getBoundingClientRect();

        // Position below button, right-aligned
        menuDropdown.style.top = `${btnRect.bottom + 4}px`;
        menuDropdown.style.right = `${window.innerWidth - btnRect.right}px`;
    }

    // ═══════════════════════════════════════════════════════════════════
    // State Updates
    // ═══════════════════════════════════════════════════════════════════

    function updateStatusIndicator() {
        if (!statusBtn || !window.qicState) return;

        const serviceStatus = window.qicState.selectors?.getServiceStatus?.() ?? 'ready';
        const agentState = window.qicState.selectors?.getAgentState?.() ?? 'idle';

        // Update status button appearance based on service status
        statusBtn.classList.remove('qic-status-ready', 'qic-status-degraded', 'qic-status-error', 'qic-status-initializing');
        statusBtn.classList.add(`qic-status-${serviceStatus}`);

        // Update tooltip
        const statusText = getStatusText(serviceStatus, agentState);
        statusBtn.title = statusText;
        statusBtn.setAttribute('aria-label', statusText);

        // Update status dot
        let statusDot = statusBtn.querySelector('.qic-status-dot');
        if (!statusDot) {
            statusDot = document.createElement('span');
            statusDot.className = 'qic-status-dot';
            statusBtn.appendChild(statusDot);
        }
        statusDot.className = `qic-status-dot qic-status-dot-${serviceStatus}`;
    }

    function updateButtonStates() {
        if (!window.qicState) return;

        const serviceStatus = window.qicState.selectors?.getServiceStatus?.() ?? 'ready';
        const isError = serviceStatus === 'error';

        // Disable new chat button when in error state
        if (newChatBtn) {
            newChatBtn.disabled = isError;
            newChatBtn.title = isError ? 'QIC is in error state' : 'New chat (Ctrl+N)';
        }
    }

    function getStatusText(serviceStatus, agentState) {
        const serviceTexts = {
            'initializing': 'QIC is starting up...',
            'ready': 'QIC is ready',
            'degraded': 'QIC is running with limited functionality',
            'error': 'QIC encountered an error',
        };

        const agentTexts = {
            'idle': '',
            'processing': ' - Processing...',
            'waiting_approval': ' - Waiting for approval',
            'error': ' - Error',
            'suspended': ' - Suspended',
        };

        return (serviceTexts[serviceStatus] || 'QIC') + (agentTexts[agentState] || '');
    }

    function showToast(message) {
        // Use shared toast if available, otherwise create simple one
        if (window.qicInput?.showToast) {
            window.qicInput.showToast(message);
            return;
        }

        const toast = document.createElement('div');
        toast.className = 'qic-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    window.qicHeader = {
        init,
        openMenu,
        closeMenu,
        updateStatusIndicator,

        // For debugging
        _debug: {
            getMenuDropdown: () => menuDropdown
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

### 3. Add Menu Dropdown CSS

Add to `chat.css`:

```css
/* ═══════════════════════════════════════════════════════════════════════
   HEADER MENU DROPDOWN
   ═══════════════════════════════════════════════════════════════════════ */

.qic-menu-dropdown {
    position: fixed;
    min-width: 200px;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    box-shadow: var(--qic-shadow-lg);
    z-index: var(--qic-z-dropdown, 100);
    padding: var(--qic-space-1) 0;
}

.qic-menu-dropdown[hidden] {
    display: none;
}

.qic-menu-item {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    width: 100%;
    padding: var(--qic-space-2) var(--qic-space-3);
    background: none;
    border: none;
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-sm);
    text-align: left;
    cursor: pointer;
}

.qic-menu-item:hover,
.qic-menu-item:focus {
    background: var(--qic-bg-tertiary);
    outline: none;
}

.qic-menu-item .codicon {
    font-size: 14px;
    opacity: 0.8;
}

.qic-menu-label {
    flex: 1;
}

.qic-menu-shortcut {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
    opacity: 0.7;
}

.qic-menu-divider {
    height: 1px;
    background: var(--qic-border-default);
    margin: var(--qic-space-1) 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   STATUS INDICATOR
   ═══════════════════════════════════════════════════════════════════════ */

.qic-status-dot {
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid var(--qic-bg-primary);
}

.qic-status-dot-ready {
    background: var(--qic-status-success);
}

.qic-status-dot-degraded {
    background: var(--qic-status-warning);
}

.qic-status-dot-error {
    background: var(--qic-status-error);
}

.qic-status-dot-initializing {
    background: var(--qic-fg-muted);
    animation: qic-pulse 1.5s infinite;
}

#status-btn {
    position: relative;
}

.qic-status-ready #status-btn {
    color: var(--qic-status-success);
}

.qic-status-degraded #status-btn {
    color: var(--qic-status-warning);
}

.qic-status-error #status-btn {
    color: var(--qic-status-error);
}

/* Z-index for dropdown */
:root {
    --qic-z-dropdown: 100;
}
```

### 4. Update Webview HTML

Include the script in `getWebviewHtml()`:

```html
<script src="${headerManagerUri}"></script>
```

### 5. Add Message Types

Ensure host handles new message types:

```typescript
// In qicPanel.ts handleWebviewMessage()
case 'quickPick:status':
    this.showStatusQuickPick();
    break;
case 'quickPick:history':
    this.showHistoryQuickPick();
    break;
case 'quickPick:checkpoints':
    this.showCheckpointQuickPick();
    break;
case 'quickPick:provider':
    this.showProviderQuickPick();
    break;
case 'show-help':
    this.showHelpModal();
    break;
case 'export-conversation':
    this.exportConversation();
    break;
```

---

## Verification

### Success Criteria
- [ ] Status button shows correct indicator color
- [ ] Status button opens Quick Pick (stub for now)
- [ ] Menu opens on click
- [ ] Menu closes on outside click
- [ ] Menu closes on Escape
- [ ] Menu items trigger correct messages
- [ ] New chat button works
- [ ] New chat disabled when in error state
- [ ] Keyboard navigation works (Enter/Space)
- [ ] Screen reader accessible (roles, labels)

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Status click | Click status button | Quick Pick message sent |
| Menu open | Click menu button | Dropdown appears |
| Menu close | Click outside menu | Dropdown closes |
| Menu item | Click "History" | Menu closes, message sent |
| New chat | Click + button | newChat message sent |
| Keyboard | Tab to menu, Enter | Menu opens |
| Disabled state | Set serviceStatus to error | New chat disabled |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/media/headerManager.js
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- Quick Pick implementations are in Phase 3
- Help modal implementation is in Phase 3
- Menu positioning may need adjustment for narrow panels
- Consider adding keyboard navigation within menu (arrow keys)
