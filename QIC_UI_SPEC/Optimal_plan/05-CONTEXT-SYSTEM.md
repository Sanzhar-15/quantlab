# Phase 4: Context Management System

**Duration:** 1.5 weeks | **Depends on:** Phase 2 (Panel)

---

## Overview

This phase implements the context chips row, expandable drawer, and @ mention system as specified in sections 5 and 4.3 of the UI spec.

---

## 1. Context Chips Row

### 1.1 Structure

```
┌─────────────────────────────────────────┐
│ ▼ Context                   12K / 32K   │
│ [📄 main.py ×] [⌷ L50-60 ×] [+3 more]   │
└─────────────────────────────────────────┘
```

### 1.2 HTML

```html
<div class="qic-context-row">
    <button class="qic-context-toggle" aria-expanded="false" aria-controls="context-drawer">
        <span class="qic-toggle-icon">▼</span>
        <span class="qic-context-label">Context</span>
    </button>

    <div class="qic-context-chips" role="list" aria-label="Context items">
        <!-- Chips rendered dynamically -->
    </div>

    <div class="qic-token-counter" aria-live="polite">
        <span class="qic-token-count">12K</span>
        <span class="qic-token-separator">/</span>
        <span class="qic-token-limit">32K</span>
    </div>
</div>
```

### 1.3 Chip Types

```html
<!-- File chip -->
<div class="qic-chip qic-chip-file" role="listitem" data-id="ctx-1" data-path="/src/main.py">
    <span class="qic-chip-icon">📄</span>
    <span class="qic-chip-label">main.py</span>
    <button class="qic-chip-remove" aria-label="Remove main.py from context">×</button>
</div>

<!-- Selection chip -->
<div class="qic-chip qic-chip-selection" role="listitem" data-id="ctx-2">
    <span class="qic-chip-icon">⌷</span>
    <span class="qic-chip-label">L50-60</span>
    <button class="qic-chip-remove" aria-label="Remove selection from context">×</button>
</div>

<!-- Pinned chip -->
<div class="qic-chip qic-chip-file qic-chip-pinned" role="listitem" data-id="ctx-3">
    <span class="qic-chip-icon">📄</span>
    <span class="qic-chip-pin">📌</span>
    <span class="qic-chip-label">risk.py</span>
    <button class="qic-chip-remove" aria-label="Unpin risk.py">×</button>
</div>

<!-- Overflow chip -->
<button class="qic-chip qic-chip-overflow" aria-expanded="false">
    +3 more
</button>
```

### 1.4 CSS

```css
.qic-context-row {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    border-top: 1px solid var(--qic-border-default);
    background: var(--qic-bg-secondary);
    flex-shrink: 0;
    min-height: 40px;
}

.qic-context-toggle {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1);
    padding: var(--qic-space-1) var(--qic-space-2);
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--qic-fg-secondary);
    font-size: var(--qic-text-sm);
    font-weight: 500;
    border-radius: var(--qic-radius-sm);
}

.qic-context-toggle:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
}

.qic-toggle-icon {
    font-size: 10px;
    transition: transform 0.2s;
}

.qic-context-toggle[aria-expanded="true"] .qic-toggle-icon {
    transform: rotate(180deg);
}

.qic-context-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--qic-space-1);
    flex: 1;
    min-width: 0;
    overflow: hidden;
}

.qic-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--qic-space-1);
    height: var(--qic-height-chip, 24px);
    padding: 0 var(--qic-space-2);
    background: var(--qic-chip-bg);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-full);
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-primary);
    max-width: 150px;
    cursor: default;
}

.qic-chip-pinned {
    background: var(--qic-chip-pinned-bg);
    border-color: var(--qic-accent-primary);
}

.qic-chip-icon {
    font-size: 12px;
    flex-shrink: 0;
}

.qic-chip-pin {
    font-size: 10px;
    margin-left: -2px;
}

.qic-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.qic-chip-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    margin-left: var(--qic-space-1);
    margin-right: -4px;
    background: transparent;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    color: var(--qic-fg-muted);
    font-size: 12px;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s;
}

.qic-chip:hover .qic-chip-remove {
    opacity: 1;
}

.qic-chip-remove:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
}

.qic-chip-overflow {
    background: transparent;
    border: 1px dashed var(--qic-border-default);
    color: var(--qic-fg-secondary);
    cursor: pointer;
}

.qic-chip-overflow:hover {
    background: var(--qic-bg-tertiary);
    border-style: solid;
}

/* Token counter */
.qic-token-counter {
    display: flex;
    align-items: center;
    gap: 2px;
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
}

.qic-token-counter.qic-warning {
    color: var(--qic-status-warning);
}

.qic-token-counter.qic-critical {
    color: var(--qic-status-error);
}

.qic-token-counter.qic-warning::after,
.qic-token-counter.qic-critical::after {
    content: ' ⚠';
}
```

---

## 2. Context Drawer

### 2.1 Structure

```
┌─────────────────────────────────────────┐
│ ▲ Context                   12K / 32K   │
├─────────────────────────────────────────┤
│ SYSTEM                           1.2K   │
│ CONVERSATION                     4.8K   │
│ FILES                            5.2K   │
│ ├ 📄 main.py              2.1K   [×]    │
│ ├ 📄 risk_metrics.py 📌   1.8K   [×]    │
│ └ ⌷ Selection             1.3K   [×]    │
│ TERMINAL                         0.8K   │
│ └ Last 100 lines          0.8K   [×]    │
├─────────────────────────────────────────┤
│ [+ Add file] [+ Add folder] [Clear all] │
└─────────────────────────────────────────┘
```

### 2.2 HTML

```html
<div id="context-drawer" class="qic-context-drawer" hidden>
    <div class="qic-drawer-content">
        <!-- System section (non-removable) -->
        <div class="qic-context-section">
            <div class="qic-section-header">
                <span class="qic-section-title">SYSTEM</span>
                <span class="qic-section-tokens">1.2K</span>
            </div>
        </div>

        <!-- Conversation section (non-removable) -->
        <div class="qic-context-section">
            <div class="qic-section-header">
                <span class="qic-section-title">CONVERSATION</span>
                <span class="qic-section-tokens">4.8K</span>
            </div>
        </div>

        <!-- Files section -->
        <div class="qic-context-section">
            <div class="qic-section-header">
                <span class="qic-section-title">FILES</span>
                <span class="qic-section-tokens">5.2K</span>
            </div>
            <ul class="qic-context-items" role="list">
                <li class="qic-context-item" data-id="ctx-1">
                    <span class="qic-item-icon">📄</span>
                    <span class="qic-item-name">main.py</span>
                    <span class="qic-item-tokens">2.1K</span>
                    <button class="qic-item-pin" title="Pin">📌</button>
                    <button class="qic-item-remove" title="Remove">×</button>
                </li>
                <!-- More items... -->
            </ul>
        </div>

        <!-- Terminal section -->
        <div class="qic-context-section">
            <div class="qic-section-header">
                <span class="qic-section-title">TERMINAL</span>
                <span class="qic-section-tokens">0.8K</span>
            </div>
            <ul class="qic-context-items" role="list">
                <li class="qic-context-item" data-id="ctx-term">
                    <span class="qic-item-icon">▣</span>
                    <span class="qic-item-name">Last 100 lines</span>
                    <span class="qic-item-tokens">0.8K</span>
                    <button class="qic-item-remove" title="Remove">×</button>
                </li>
            </ul>
        </div>
    </div>

    <!-- Drawer actions -->
    <div class="qic-drawer-actions">
        <button class="qic-drawer-btn" data-action="add-file">
            <span class="codicon codicon-add"></span>
            Add file
        </button>
        <button class="qic-drawer-btn" data-action="add-folder">
            <span class="codicon codicon-folder-opened"></span>
            Add folder
        </button>
        <button class="qic-drawer-btn qic-btn-danger" data-action="clear">
            Clear all
        </button>
    </div>
</div>
```

### 2.3 CSS

```css
.qic-context-drawer {
    border-top: 1px solid var(--qic-border-default);
    background: var(--qic-bg-primary);
    max-height: 250px;
    overflow: hidden;
    transition: max-height 0.2s cubic-bezier(0, 0, 0.2, 1);
}

.qic-context-drawer[hidden] {
    max-height: 0;
    border-top: none;
}

.qic-drawer-content {
    max-height: 200px;
    overflow-y: auto;
    padding: var(--qic-space-2) 0;
}

.qic-context-section {
    padding: 0 var(--qic-space-3);
}

.qic-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--qic-space-1) 0;
    color: var(--qic-fg-muted);
    font-size: var(--qic-text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.qic-section-tokens {
    font-weight: normal;
    font-variant-numeric: tabular-nums;
}

.qic-context-items {
    list-style: none;
    padding: 0;
    margin: 0;
}

.qic-context-item {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-1) var(--qic-space-2);
    margin-left: var(--qic-space-3);
    border-radius: var(--qic-radius-sm);
    font-size: var(--qic-text-sm);
}

.qic-context-item:hover {
    background: var(--qic-bg-secondary);
}

.qic-item-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
}

.qic-item-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.qic-item-tokens {
    color: var(--qic-fg-muted);
    font-size: var(--qic-text-xs);
    font-variant-numeric: tabular-nums;
}

.qic-item-pin,
.qic-item-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: var(--qic-radius-sm);
    cursor: pointer;
    color: var(--qic-fg-muted);
    opacity: 0;
    transition: opacity 0.15s, color 0.15s;
}

.qic-context-item:hover .qic-item-pin,
.qic-context-item:hover .qic-item-remove {
    opacity: 1;
}

.qic-item-pin:hover,
.qic-item-remove:hover {
    color: var(--qic-fg-primary);
    background: var(--qic-bg-tertiary);
}

.qic-drawer-actions {
    display: flex;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    border-top: 1px solid var(--qic-border-default);
}

.qic-drawer-btn {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1);
    padding: var(--qic-space-1) var(--qic-space-2);
    background: transparent;
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-sm);
    cursor: pointer;
    color: var(--qic-fg-secondary);
    font-size: var(--qic-text-xs);
}

.qic-drawer-btn:hover {
    background: var(--qic-bg-secondary);
    color: var(--qic-fg-primary);
}

.qic-btn-danger {
    margin-left: auto;
    color: var(--qic-status-error);
    border-color: transparent;
}

.qic-btn-danger:hover {
    background: var(--qic-status-error-bg);
}
```

---

## 3. @ Mention System

### 3.1 Autocomplete Dropdown

```html
<div id="mention-dropdown" class="qic-mention-dropdown" role="listbox" hidden>
    <div class="qic-mention-section">
        <div class="qic-mention-section-title">FILES</div>
        <div class="qic-mention-item" role="option" data-type="file" data-path="/src/risk_metrics.py">
            <span class="qic-mention-icon">📄</span>
            <span class="qic-mention-name">risk_metrics.py</span>
            <span class="qic-mention-badge">Recent</span>
        </div>
        <div class="qic-mention-item" role="option" data-type="file" data-path="/src/backtest.py">
            <span class="qic-mention-icon">📄</span>
            <span class="qic-mention-name">backtest.py</span>
        </div>
    </div>

    <div class="qic-mention-section">
        <div class="qic-mention-section-title">SYMBOLS</div>
        <div class="qic-mention-item" role="option" data-type="symbol" data-path="sharpe_ratio">
            <span class="qic-mention-icon">ƒ</span>
            <span class="qic-mention-name">sharpe_ratio</span>
        </div>
    </div>

    <div class="qic-mention-section">
        <div class="qic-mention-section-title">FOLDERS</div>
        <div class="qic-mention-item" role="option" data-type="folder" data-path="/strategies">
            <span class="qic-mention-icon">📁</span>
            <span class="qic-mention-name">strategies/</span>
        </div>
    </div>
</div>
```

### 3.2 CSS

```css
.qic-mention-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 320px;
    margin-bottom: var(--qic-space-1);
    background: var(--qic-bg-primary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    box-shadow: var(--qic-shadow-lg);
    overflow-y: auto;
    z-index: var(--qic-z-dropdown);
}

.qic-mention-section {
    padding: var(--qic-space-1) 0;
}

.qic-mention-section:not(:last-child) {
    border-bottom: 1px solid var(--qic-border-default);
}

.qic-mention-section-title {
    padding: var(--qic-space-1) var(--qic-space-3);
    font-size: var(--qic-text-xs);
    font-weight: 600;
    color: var(--qic-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.qic-mention-item {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    cursor: pointer;
}

.qic-mention-item:hover,
.qic-mention-item[aria-selected="true"] {
    background: var(--qic-bg-secondary);
}

.qic-mention-icon {
    width: 16px;
    text-align: center;
    flex-shrink: 0;
}

.qic-mention-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.qic-mention-badge {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
    padding: 1px 6px;
    background: var(--qic-bg-tertiary);
    border-radius: var(--qic-radius-sm);
}
```

### 3.3 Mention Chip in Input

```css
/* Mention chips rendered in contenteditable or alongside textarea */
.qic-input-mention {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 20px;
    padding: 0 6px;
    margin: 0 2px;
    background: var(--qic-chip-bg);
    border-radius: var(--qic-radius-full);
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-primary);
    vertical-align: middle;
}

.qic-input-mention-icon {
    font-size: 11px;
}

.qic-input-mention-remove {
    display: none;
    width: 12px;
    height: 12px;
    margin-left: 2px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--qic-fg-muted);
    font-size: 10px;
}

.qic-input-mention:hover .qic-input-mention-remove {
    display: flex;
    align-items: center;
    justify-content: center;
}
```

---

## 4. JavaScript Implementation

### 4.1 Context Chip Rendering

```javascript
function renderContextChips(items, maxVisible = 5) {
    const container = document.querySelector('.qic-context-chips');
    container.innerHTML = '';

    const visible = items.slice(0, maxVisible);
    const overflow = items.length - maxVisible;

    visible.forEach(item => {
        const chip = createChip(item);
        container.appendChild(chip);
    });

    if (overflow > 0) {
        const overflowChip = document.createElement('button');
        overflowChip.className = 'qic-chip qic-chip-overflow';
        overflowChip.textContent = `+${overflow} more`;
        overflowChip.addEventListener('click', () => toggleDrawer(true));
        container.appendChild(overflowChip);
    }
}

function createChip(item) {
    const chip = document.createElement('div');
    chip.className = `qic-chip qic-chip-${item.type}${item.pinned ? ' qic-chip-pinned' : ''}`;
    chip.dataset.id = item.id;
    chip.setAttribute('role', 'listitem');

    chip.innerHTML = `
        <span class="qic-chip-icon">${getIcon(item.type)}</span>
        ${item.pinned ? '<span class="qic-chip-pin">📌</span>' : ''}
        <span class="qic-chip-label">${item.displayName}</span>
        <button class="qic-chip-remove" aria-label="Remove ${item.displayName} from context">×</button>
    `;

    chip.querySelector('.qic-chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'context:remove', payload: { id: item.id } });
    });

    return chip;
}
```

### 4.2 Mention Autocomplete

```javascript
const mentionDropdown = document.getElementById('mention-dropdown');
let mentionQuery = '';
let selectedIndex = 0;

inputEl.addEventListener('input', (e) => {
    const text = e.target.value;
    const cursorPos = e.target.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);

    // Check for @ trigger
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch) {
        mentionQuery = atMatch[1];
        showMentionDropdown(mentionQuery);
    } else {
        hideMentionDropdown();
    }
});

function showMentionDropdown(query) {
    // Request suggestions from host
    vscode.postMessage({
        type: 'mention:search',
        payload: { query }
    });
}

function handleMentionResults(results) {
    mentionDropdown.hidden = false;
    mentionDropdown.innerHTML = '';
    selectedIndex = 0;

    // Group by type
    const grouped = groupBy(results, 'type');

    Object.entries(grouped).forEach(([type, items]) => {
        const section = document.createElement('div');
        section.className = 'qic-mention-section';
        section.innerHTML = `<div class="qic-mention-section-title">${type.toUpperCase()}</div>`;

        items.forEach((item, i) => {
            const el = document.createElement('div');
            el.className = 'qic-mention-item';
            el.setAttribute('role', 'option');
            el.dataset.type = item.type;
            el.dataset.path = item.path;
            el.innerHTML = `
                <span class="qic-mention-icon">${getIcon(item.type)}</span>
                <span class="qic-mention-name">${item.displayName}</span>
                ${item.recent ? '<span class="qic-mention-badge">Recent</span>' : ''}
            `;
            section.appendChild(el);
        });

        mentionDropdown.appendChild(section);
    });
}

inputEl.addEventListener('keydown', (e) => {
    if (mentionDropdown.hidden) return;

    const items = mentionDropdown.querySelectorAll('.qic-mention-item');

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % items.length;
            updateSelection(items);
            break;
        case 'ArrowUp':
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            updateSelection(items);
            break;
        case 'Enter':
        case 'Tab':
            e.preventDefault();
            selectMention(items[selectedIndex]);
            break;
        case 'Escape':
            hideMentionDropdown();
            break;
    }
});

function selectMention(item) {
    if (!item) return;

    const mention = {
        type: item.dataset.type,
        path: item.dataset.path,
        displayName: item.querySelector('.qic-mention-name').textContent
    };

    // Replace @query with mention chip
    insertMention(mention);
    hideMentionDropdown();
}
```

---

## 5. Data Flow

### 5.1 Context Updates

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Editor    │────▶│ StateService│────▶│   Webview   │
│ (file open) │     │ (context)   │     │ (chips/drawer)
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │ Active file       │ context:update    │ render
       │ changes           │ message           │ UI
       ▼                   ▼                   ▼
```

### 5.2 Mention Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Webview   │────▶│    Host     │────▶│   Webview   │
│ (@ typed)   │     │ (search)    │     │ (dropdown)  │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │ mention:search    │ query symbols    │ mention:results
       │                   │ query files      │
       ▼                   ▼                   ▼
```

---

## 6. Checklist

### Context Chips
- [ ] Create chip row HTML
- [ ] Implement chip types (file, selection, terminal, folder, symbol)
- [ ] Add pinned state styling
- [ ] Add overflow chip with count
- [ ] Implement remove button
- [ ] Add token counter with states

### Context Drawer
- [ ] Create drawer HTML structure
- [ ] Implement section headers with token counts
- [ ] Add item list with remove/pin actions
- [ ] Add drawer actions (add file, add folder, clear)
- [ ] Implement expand/collapse animation

### @ Mentions
- [ ] Implement @ trigger detection
- [ ] Create dropdown component
- [ ] Add fuzzy search
- [ ] Implement keyboard navigation
- [ ] Add mention chip insertion
- [ ] Support backspace to remove

### Integration
- [ ] Wire to state service
- [ ] Add context:update message handling
- [ ] Add mention:search/results messages
- [ ] Test with real file/symbol data
