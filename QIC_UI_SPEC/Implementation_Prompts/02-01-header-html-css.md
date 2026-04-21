# Prompt 02-01: Header HTML & CSS

**Phase:** 2 - Panel Structure
**Dependencies:** Phase 1 Complete
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement the new minimal header structure with status button, title, menu button, and new chat button. This replaces the current cluttered header.

---

## Context

The spec requires a simplified header:
```
┌─────────────────────────────────────────┐
│ [◇] QIC                      [⋮]   [+]  │
└─────────────────────────────────────────┘
```

Where:
- `[◇]` = Status indicator (click for Quick Pick)
- `QIC` = Title
- `[⋮]` = Menu (history, checkpoints, settings, etc.)
- `[+]` = New conversation

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md`

---

## Scope

### In Scope
- New header HTML structure
- Header CSS styles
- Status indicator states
- Menu dropdown structure
- New chat button
- CSS variables for theming

### Out of Scope
- JavaScript behavior (next prompt)
- Menu actions (use Quick Picks - Phase 3)
- Removing old header (keep during migration)

---

## Pre-Conditions

- [ ] Phase 1 complete
- [ ] Git branch created: `qic-ui/02-01-header`

---

## Tasks

### 1. Add Feature Flag

In `qicPanel.ts`:

```typescript
private useNewHeader(): boolean {
    return this.configurationService.getValue<boolean>('qic.experimental.newHeader') ?? false;
}
```

### 2. Create New Header HTML

In `getWebviewHtml()`, add conditional header:

```typescript
private getHeaderHtml(): string {
    if (this.useNewHeader()) {
        return this.getNewHeaderHtml();
    }
    return this.getLegacyHeaderHtml();
}

private getNewHeaderHtml(): string {
    return `
        <header class="qic-header qic-header-v2">
            <div class="qic-header-left">
                <button id="status-btn" class="qic-status-btn"
                        title="Connection status"
                        aria-label="View status"
                        aria-haspopup="dialog">
                    <span class="qic-status-indicator" data-status="connected"></span>
                    <span class="qic-logo">◇</span>
                </button>
                <span class="qic-title">QIC</span>
            </div>
            <div class="qic-header-right">
                <button id="menu-btn" class="qic-header-btn"
                        title="Menu"
                        aria-label="Open menu"
                        aria-haspopup="menu"
                        aria-expanded="false">
                    <span class="codicon codicon-ellipsis"></span>
                </button>
                <button id="new-chat-btn" class="qic-header-btn"
                        title="New conversation (${this.isMac ? 'Cmd' : 'Ctrl'}+Shift+N)"
                        aria-label="Start new conversation">
                    <span class="codicon codicon-add"></span>
                </button>
            </div>
        </header>
        ${this.getMenuDropdownHtml()}
    `;
}

private getMenuDropdownHtml(): string {
    const mod = this.isMac ? 'Cmd' : 'Ctrl';
    return `
        <div id="menu-dropdown" class="qic-menu-dropdown" role="menu" hidden aria-label="QIC menu">
            <button class="qic-menu-item" role="menuitem" data-action="history">
                <span class="codicon codicon-history"></span>
                <span class="qic-menu-label">Conversation history</span>
                <kbd>${mod}+Shift+H</kbd>
            </button>
            <button class="qic-menu-item" role="menuitem" data-action="rename">
                <span class="codicon codicon-edit"></span>
                <span class="qic-menu-label">Rename conversation</span>
            </button>
            <div class="qic-menu-separator" role="separator"></div>
            <button class="qic-menu-item" role="menuitem" data-action="checkpoints">
                <span class="codicon codicon-history"></span>
                <span class="qic-menu-label">View checkpoints</span>
            </button>
            <button class="qic-menu-item" role="menuitem" data-action="create-checkpoint">
                <span class="codicon codicon-save"></span>
                <span class="qic-menu-label">Create checkpoint</span>
                <kbd>${mod}+Shift+C</kbd>
            </button>
            <div class="qic-menu-separator" role="separator"></div>
            <button class="qic-menu-item" role="menuitem" data-action="permissions">
                <span class="codicon codicon-shield"></span>
                <span class="qic-menu-label">View permissions</span>
            </button>
            <button class="qic-menu-item" role="menuitem" data-action="audit">
                <span class="codicon codicon-list-flat"></span>
                <span class="qic-menu-label">View audit log</span>
            </button>
            <div class="qic-menu-separator" role="separator"></div>
            <button class="qic-menu-item" role="menuitem" data-action="provider">
                <span class="codicon codicon-server"></span>
                <span class="qic-menu-label">Switch provider</span>
            </button>
            <button class="qic-menu-item" role="menuitem" data-action="settings">
                <span class="codicon codicon-settings-gear"></span>
                <span class="qic-menu-label">Settings</span>
            </button>
            <button class="qic-menu-item" role="menuitem" data-action="help">
                <span class="codicon codicon-question"></span>
                <span class="qic-menu-label">Help & shortcuts</span>
                <kbd>${mod}+/</kbd>
            </button>
        </div>
    `;
}
```

### 3. Add Header CSS

In `chat.css`, add new header styles:

```css
/* ═══════════════════════════════════════════════════════════════════════
   NEW HEADER (v2) - Minimal header per spec
   ═══════════════════════════════════════════════════════════════════════ */

.qic-header-v2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: var(--qic-height-header, 40px);
    padding: 0 var(--qic-space-3, 12px);
    border-bottom: 1px solid var(--qic-border-default);
    background: var(--qic-bg-secondary);
    flex-shrink: 0;
}

.qic-header-left {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2, 8px);
}

.qic-header-right {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1, 4px);
}

/* Status Button */
.qic-status-btn {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1, 4px);
    padding: var(--qic-space-1, 4px) var(--qic-space-2, 8px);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--qic-radius-md, 5px);
    cursor: pointer;
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-base, 13px);
    transition: background 0.15s ease, border-color 0.15s ease;
}

.qic-status-btn:hover {
    background: var(--qic-bg-tertiary);
    border-color: var(--qic-border-default);
}

.qic-status-btn:focus-visible {
    outline: 2px solid var(--qic-focus-ring, var(--vscode-focusBorder));
    outline-offset: 1px;
}

/* Status Indicator Dot */
.qic-status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.qic-status-indicator[data-status="connected"],
.qic-status-indicator[data-status="ready"] {
    background: var(--qic-status-success, #4caf50);
}

.qic-status-indicator[data-status="connecting"],
.qic-status-indicator[data-status="initializing"] {
    background: var(--qic-accent-primary);
    animation: qic-pulse 1.5s infinite;
}

.qic-status-indicator[data-status="degraded"] {
    background: var(--qic-status-warning, #ff9800);
}

.qic-status-indicator[data-status="disconnected"],
.qic-status-indicator[data-status="error"] {
    background: var(--qic-status-error, #f44336);
}

.qic-status-indicator[data-status="offline"] {
    background: var(--qic-fg-muted);
}

/* Logo */
.qic-logo {
    font-size: 16px;
    font-weight: 600;
}

/* Title */
.qic-title {
    font-weight: 600;
    font-size: var(--qic-text-lg, 14px);
    color: var(--qic-fg-primary);
}

/* Header Buttons */
.qic-header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--qic-height-button, 28px);
    height: var(--qic-height-button, 28px);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--qic-radius-sm, 3px);
    cursor: pointer;
    color: var(--qic-fg-secondary);
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.qic-header-btn:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
    border-color: var(--qic-border-default);
}

.qic-header-btn:focus-visible {
    outline: 2px solid var(--qic-focus-ring, var(--vscode-focusBorder));
    outline-offset: 1px;
}

/* ═══════════════════════════════════════════════════════════════════════
   MENU DROPDOWN
   ═══════════════════════════════════════════════════════════════════════ */

.qic-menu-dropdown {
    position: absolute;
    top: calc(var(--qic-height-header, 40px) + 4px);
    right: var(--qic-space-3, 12px);
    width: var(--qic-width-menu, 240px);
    max-height: calc(100vh - 100px);
    overflow-y: auto;
    background: var(--qic-bg-primary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md, 5px);
    box-shadow: var(--qic-shadow-lg, 0 4px 16px rgba(0, 0, 0, 0.2));
    z-index: var(--qic-z-dropdown, 100);
    padding: var(--qic-space-1, 4px) 0;
}

.qic-menu-dropdown[hidden] {
    display: none;
}

.qic-menu-item {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2, 8px);
    width: 100%;
    padding: var(--qic-space-2, 8px) var(--qic-space-3, 12px);
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-sm, 12px);
    text-align: left;
    transition: background 0.1s ease;
}

.qic-menu-item:hover {
    background: var(--qic-bg-secondary);
}

.qic-menu-item:focus-visible {
    background: var(--qic-bg-secondary);
    outline: none;
}

.qic-menu-item .codicon {
    flex-shrink: 0;
    width: 16px;
    color: var(--qic-fg-secondary);
}

.qic-menu-label {
    flex: 1;
}

.qic-menu-item kbd {
    margin-left: auto;
    color: var(--qic-fg-muted);
    font-size: var(--qic-text-xs, 11px);
    font-family: inherit;
}

.qic-menu-separator {
    height: 1px;
    background: var(--qic-border-default);
    margin: var(--qic-space-1, 4px) 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   ANIMATIONS
   ═══════════════════════════════════════════════════════════════════════ */

@keyframes qic-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}
```

### 4. Add CSS Variables (if not present)

```css
/* ═══════════════════════════════════════════════════════════════════════
   CSS VARIABLES (Design Tokens)
   ═══════════════════════════════════════════════════════════════════════ */

:root {
    /* Spacing */
    --qic-space-1: 4px;
    --qic-space-2: 8px;
    --qic-space-3: 12px;
    --qic-space-4: 16px;

    /* Sizes */
    --qic-height-header: 40px;
    --qic-height-button: 28px;
    --qic-width-menu: 240px;

    /* Border Radius */
    --qic-radius-sm: 3px;
    --qic-radius-md: 5px;
    --qic-radius-lg: 8px;

    /* Typography */
    --qic-text-xs: 11px;
    --qic-text-sm: 12px;
    --qic-text-base: 13px;
    --qic-text-lg: 14px;

    /* Colors - mapped from VS Code theme */
    --qic-bg-primary: var(--vscode-editor-background);
    --qic-bg-secondary: var(--vscode-sideBar-background);
    --qic-bg-tertiary: var(--vscode-list-hoverBackground);
    --qic-fg-primary: var(--vscode-editor-foreground);
    --qic-fg-secondary: var(--vscode-descriptionForeground);
    --qic-fg-muted: var(--vscode-disabledForeground);
    --qic-border-default: var(--vscode-panel-border);
    --qic-accent-primary: var(--vscode-button-background);
    --qic-focus-ring: var(--vscode-focusBorder);

    /* Status Colors */
    --qic-status-success: #4caf50;
    --qic-status-warning: #ff9800;
    --qic-status-error: #f44336;

    /* Shadows */
    --qic-shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.2);

    /* Z-index */
    --qic-z-dropdown: 100;
}
```

---

## Verification

### Success Criteria
- [ ] Header renders when flag enabled
- [ ] Status indicator shows correct color
- [ ] Menu dropdown opens/closes
- [ ] Buttons have hover states
- [ ] Focus states visible
- [ ] Theme colors work (light/dark)
- [ ] No visual regressions when flag disabled

### Visual Tests
1. Enable `qic.experimental.newHeader`
2. Verify header layout matches spec
3. Test hover states on all buttons
4. Test focus states (Tab navigation)
5. Toggle dark/light theme
6. Test high contrast theme

---

## Rollback

Disable feature flag:
```json
{
    "qic.experimental.newHeader": false
}
```

Or revert changes:
```bash
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- Keep old header code during migration
- Feature flag allows safe rollout
- Menu dropdown styled but not functional yet (next prompt)
- Status indicator data-status updated by state manager
