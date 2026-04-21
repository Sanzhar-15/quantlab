# Prompt 04-02: Context Drawer

**Phase:** 4 - Context System
**Dependencies:** 04-01 (Context Chips UI)
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Implement the expandable context drawer that shows full details of all attached context items. The drawer provides a comprehensive view when users click the overflow button or want to see complete file contents, code previews, and manage context in bulk.

---

## Context

The context drawer is an expandable panel that:
- Shows all attached context items (not just visible chips)
- Displays content previews for files and selections
- Allows bulk removal of items
- Provides search/filter across context
- Can be collapsed to save space
- Opens automatically on overflow click

The drawer appears between the context chips and the conversation area.

Reference: `QIC_UI_SPEC/Optimal_plan/08-CONTEXT-SYSTEM.md`

---

## Scope

### In Scope
- Create drawer HTML structure
- Implement drawer CSS with expand/collapse
- Create drawer item components
- Show content preview for files/selections
- Implement bulk actions (clear all, remove selected)
- Add search/filter functionality
- Handle large content gracefully
- Animate expand/collapse
- Keyboard accessibility

### Out of Scope
- Context picker/add functionality (04-03)
- State service integration (04-04)
- Inline editing of context

---

## Pre-Conditions

- [ ] 04-01 complete (Context Chips)
- [ ] Git branch created: `qic-ui/04-02-context-drawer`

---

## Tasks

### 1. Add Context Drawer HTML

In `chat.template.html`, add after context chips:

```html
<!-- Context Drawer -->
<div id="context-drawer" class="context-drawer collapsed" aria-expanded="false">
  <!-- Drawer Header -->
  <div class="context-drawer-header">
    <button
      id="context-drawer-toggle"
      class="context-drawer-toggle"
      aria-label="Toggle context drawer"
      aria-controls="context-drawer-content"
    >
      <span class="codicon codicon-chevron-down toggle-icon"></span>
      <span class="drawer-title">Attached Context</span>
      <span class="drawer-count">(0 items)</span>
    </button>

    <div class="context-drawer-actions">
      <div class="context-drawer-search">
        <span class="codicon codicon-search"></span>
        <input
          type="text"
          id="context-search-input"
          placeholder="Filter context..."
          aria-label="Filter context items"
        >
      </div>
      <button
        id="context-clear-all-btn"
        class="context-action-btn"
        title="Clear all context"
        aria-label="Clear all context items"
      >
        <span class="codicon codicon-clear-all"></span>
      </button>
    </div>
  </div>

  <!-- Drawer Content -->
  <div id="context-drawer-content" class="context-drawer-content" role="list">
    <!-- Items rendered dynamically -->
  </div>

  <!-- Drawer Footer -->
  <div class="context-drawer-footer">
    <span class="context-size-indicator">
      <span id="context-token-count">0</span> tokens estimated
    </span>
    <button
      id="context-collapse-btn"
      class="context-collapse-btn"
      aria-label="Collapse drawer"
    >
      Collapse
    </button>
  </div>
</div>
```

### 2. Add Context Drawer CSS

In `chat.css`:

```css
/* ========================================
   Context Drawer
   ======================================== */

.context-drawer {
  border-bottom: 1px solid var(--vscode-widget-border);
  background: var(--vscode-sideBar-background);
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.context-drawer.collapsed {
  max-height: 0;
  border-bottom: none;
}

.context-drawer.expanded {
  max-height: 400px;
}

.context-drawer.hidden {
  display: none;
}

/* ========================================
   Drawer Header
   ======================================== */

.context-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-widget-border);
  min-height: 36px;
}

.context-drawer-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  font-size: 12px;
}

.context-drawer-toggle:hover {
  background: var(--vscode-list-hoverBackground);
}

.context-drawer-toggle:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: -2px;
}

.toggle-icon {
  transition: transform 0.2s ease;
}

.context-drawer.expanded .toggle-icon {
  transform: rotate(180deg);
}

.drawer-title {
  font-weight: 500;
}

.drawer-count {
  color: var(--vscode-descriptionForeground);
}

/* Drawer Actions */
.context-drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.context-drawer-search {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  padding: 2px 8px;
}

.context-drawer-search .codicon {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.context-drawer-search input {
  background: transparent;
  border: none;
  color: var(--vscode-input-foreground);
  font-size: 12px;
  width: 120px;
  outline: none;
}

.context-drawer-search input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.context-drawer-search:focus-within {
  border-color: var(--vscode-focusBorder);
}

.context-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
}

.context-action-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.context-action-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: -2px;
}

/* ========================================
   Drawer Content
   ======================================== */

.context-drawer-content {
  max-height: 300px;
  overflow-y: auto;
  padding: 8px;
}

.context-drawer-content:empty::after {
  content: "No context items attached";
  display: block;
  text-align: center;
  padding: 24px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* ========================================
   Drawer Item
   ======================================== */

.context-drawer-item {
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
  transition: border-color 0.15s ease;
}

.context-drawer-item:last-child {
  margin-bottom: 0;
}

.context-drawer-item:hover {
  border-color: var(--vscode-focusBorder);
}

.context-drawer-item:focus-within {
  border-color: var(--vscode-focusBorder);
  outline: none;
}

.context-drawer-item.filtered-out {
  display: none;
}

/* Item Header */
.context-drawer-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  cursor: pointer;
}

.context-drawer-item-icon {
  flex-shrink: 0;
  font-size: 16px;
}

.context-drawer-item-icon.file { color: var(--vscode-symbolIcon-fileForeground); }
.context-drawer-item-icon.selection { color: var(--vscode-editor-selectionBackground); }
.context-drawer-item-icon.symbol { color: var(--vscode-symbolIcon-functionForeground); }
.context-drawer-item-icon.url { color: var(--vscode-textLink-foreground); }
.context-drawer-item-icon.image { color: var(--vscode-charts-purple); }

.context-drawer-item-info {
  flex: 1;
  min-width: 0;
}

.context-drawer-item-title {
  font-weight: 500;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-drawer-item-meta {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-drawer-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.context-drawer-item-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.context-drawer-item:hover .context-drawer-item-btn,
.context-drawer-item:focus-within .context-drawer-item-btn {
  opacity: 1;
}

.context-drawer-item-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.context-drawer-item-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: -2px;
  opacity: 1;
}

/* Item Content Preview */
.context-drawer-item-content {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.2s ease;
}

.context-drawer-item.expanded .context-drawer-item-content {
  max-height: 200px;
}

.context-drawer-item-preview {
  padding: 8px 12px;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  line-height: 1.5;
  background: var(--vscode-textCodeBlock-background);
  overflow-x: auto;
  white-space: pre;
  color: var(--vscode-editor-foreground);
}

.context-drawer-item-preview.truncated::after {
  content: "\n... (truncated)";
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* Image preview */
.context-drawer-item-image {
  padding: 8px;
  text-align: center;
}

.context-drawer-item-image img {
  max-width: 100%;
  max-height: 150px;
  border-radius: 4px;
  border: 1px solid var(--vscode-widget-border);
}

/* ========================================
   Drawer Footer
   ======================================== */

.context-drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-top: 1px solid var(--vscode-widget-border);
  font-size: 11px;
}

.context-size-indicator {
  color: var(--vscode-descriptionForeground);
}

.context-collapse-btn {
  padding: 4px 8px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}

.context-collapse-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.context-collapse-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

/* ========================================
   Token Warning
   ======================================== */

.context-size-indicator.warning {
  color: var(--vscode-editorWarning-foreground);
}

.context-size-indicator.error {
  color: var(--vscode-editorError-foreground);
}
```

### 3. Implement Context Drawer Manager

In `main.js`:

```javascript
// ========================================
// Context Drawer Manager
// ========================================

class ContextDrawerManager {
  constructor(chipsManager) {
    this.chipsManager = chipsManager;
    this.drawer = document.getElementById('context-drawer');
    this.content = document.getElementById('context-drawer-content');
    this.toggleBtn = document.getElementById('context-drawer-toggle');
    this.searchInput = document.getElementById('context-search-input');
    this.clearAllBtn = document.getElementById('context-clear-all-btn');
    this.collapseBtn = document.getElementById('context-collapse-btn');
    this.countEl = this.drawer?.querySelector('.drawer-count');
    this.tokenCountEl = document.getElementById('context-token-count');

    this.isExpanded = false;
    this.expandedItems = new Set();
    this.maxPreviewLines = 20;
    this.maxPreviewChars = 2000;

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Toggle drawer
    this.toggleBtn?.addEventListener('click', () => {
      this.toggle();
    });

    // Collapse button
    this.collapseBtn?.addEventListener('click', () => {
      this.collapse();
    });

    // Clear all
    this.clearAllBtn?.addEventListener('click', () => {
      this.confirmClearAll();
    });

    // Search filter
    this.searchInput?.addEventListener('input', (e) => {
      this.filterItems(e.target.value);
    });

    // Item interactions
    this.content?.addEventListener('click', (e) => {
      this.handleContentClick(e);
    });

    // Keyboard
    this.content?.addEventListener('keydown', (e) => {
      this.handleKeyDown(e);
    });
  }

  handleContentClick(e) {
    const item = e.target.closest('.context-drawer-item');
    if (!item) return;

    const itemId = item.dataset.id;

    // Toggle expand
    if (e.target.closest('.context-drawer-item-header') &&
        !e.target.closest('.context-drawer-item-btn')) {
      this.toggleItemExpand(itemId);
      return;
    }

    // Open in editor
    if (e.target.closest('[data-action="open"]')) {
      this.openItem(itemId);
      return;
    }

    // Remove item
    if (e.target.closest('[data-action="remove"]')) {
      this.removeItem(itemId);
      return;
    }
  }

  handleKeyDown(e) {
    const item = e.target.closest('.context-drawer-item');
    if (!item) return;

    const itemId = item.dataset.id;

    switch (e.key) {
      case 'Enter':
      case ' ':
        if (e.target.closest('.context-drawer-item-header')) {
          e.preventDefault();
          this.toggleItemExpand(itemId);
        }
        break;
      case 'Delete':
        e.preventDefault();
        this.removeItem(itemId);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.focusNextItem(item);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.focusPreviousItem(item);
        break;
    }
  }

  focusNextItem(current) {
    const next = current.nextElementSibling;
    if (next?.classList.contains('context-drawer-item')) {
      next.querySelector('.context-drawer-item-header').focus();
    }
  }

  focusPreviousItem(current) {
    const prev = current.previousElementSibling;
    if (prev?.classList.contains('context-drawer-item')) {
      prev.querySelector('.context-drawer-item-header').focus();
    }
  }

  /**
   * Toggle drawer expand/collapse
   */
  toggle() {
    if (this.isExpanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  /**
   * Expand the drawer
   */
  expand() {
    this.isExpanded = true;
    this.drawer.classList.remove('collapsed');
    this.drawer.classList.add('expanded');
    this.drawer.setAttribute('aria-expanded', 'true');
    this.render();
  }

  /**
   * Collapse the drawer
   */
  collapse() {
    this.isExpanded = false;
    this.drawer.classList.add('collapsed');
    this.drawer.classList.remove('expanded');
    this.drawer.setAttribute('aria-expanded', 'false');
  }

  /**
   * Open drawer (called from chips overflow)
   */
  open() {
    if (!this.isExpanded) {
      this.expand();
    }
  }

  /**
   * Toggle individual item expand
   */
  toggleItemExpand(itemId) {
    const itemEl = this.content.querySelector(`[data-id="${itemId}"]`);
    if (!itemEl) return;

    if (this.expandedItems.has(itemId)) {
      this.expandedItems.delete(itemId);
      itemEl.classList.remove('expanded');
    } else {
      this.expandedItems.add(itemId);
      itemEl.classList.add('expanded');
      this.loadItemContent(itemId);
    }
  }

  /**
   * Load content preview for item
   */
  async loadItemContent(itemId) {
    const item = this.chipsManager.items.get(itemId);
    if (!item || item.contentLoaded) return;

    const itemEl = this.content.querySelector(`[data-id="${itemId}"]`);
    const previewEl = itemEl?.querySelector('.context-drawer-item-preview');
    if (!previewEl) return;

    previewEl.textContent = 'Loading...';

    // Request content from extension
    vscode.postMessage({
      type: 'context:getContent',
      id: itemId
    });
  }

  /**
   * Update item content preview
   */
  updateItemContent(itemId, content) {
    const item = this.chipsManager.items.get(itemId);
    if (item) {
      item.content = content;
      item.contentLoaded = true;
    }

    const itemEl = this.content.querySelector(`[data-id="${itemId}"]`);
    const previewEl = itemEl?.querySelector('.context-drawer-item-preview');
    if (!previewEl) return;

    const truncated = this.truncateContent(content);
    previewEl.textContent = truncated.text;
    if (truncated.isTruncated) {
      previewEl.classList.add('truncated');
    }
  }

  /**
   * Truncate content for preview
   */
  truncateContent(content) {
    if (!content) return { text: '(empty)', isTruncated: false };

    const lines = content.split('\n');
    let text = content;
    let isTruncated = false;

    if (lines.length > this.maxPreviewLines) {
      text = lines.slice(0, this.maxPreviewLines).join('\n');
      isTruncated = true;
    }

    if (text.length > this.maxPreviewChars) {
      text = text.substring(0, this.maxPreviewChars);
      isTruncated = true;
    }

    return { text, isTruncated };
  }

  /**
   * Filter items by search query
   */
  filterItems(query) {
    const normalizedQuery = query.toLowerCase().trim();
    const items = this.content.querySelectorAll('.context-drawer-item');

    items.forEach(itemEl => {
      const item = this.chipsManager.items.get(itemEl.dataset.id);
      if (!item) return;

      const searchText = [
        item.path,
        item.label,
        item.name,
        item.url,
        item.content
      ].filter(Boolean).join(' ').toLowerCase();

      if (!normalizedQuery || searchText.includes(normalizedQuery)) {
        itemEl.classList.remove('filtered-out');
      } else {
        itemEl.classList.add('filtered-out');
      }
    });
  }

  /**
   * Open item in editor
   */
  openItem(itemId) {
    const item = this.chipsManager.items.get(itemId);
    if (item) {
      vscode.postMessage({
        type: 'context:openItem',
        id: itemId,
        item: this.chipsManager.serializeItem(item)
      });
    }
  }

  /**
   * Remove item
   */
  removeItem(itemId) {
    this.chipsManager.removeItem(itemId);
    this.render();
  }

  /**
   * Confirm and clear all items
   */
  confirmClearAll() {
    // Use simple confirm for now; could use VS Code dialog later
    if (confirm('Remove all context items?')) {
      this.chipsManager.clearAll();
      this.render();
    }
  }

  /**
   * Render drawer content
   */
  render() {
    const items = Array.from(this.chipsManager.items.values());

    // Update count
    if (this.countEl) {
      this.countEl.textContent = `(${items.length} item${items.length !== 1 ? 's' : ''})`;
    }

    // Update token estimate
    this.updateTokenEstimate(items);

    // Update visibility
    if (items.length === 0) {
      this.drawer.classList.add('hidden');
    } else {
      this.drawer.classList.remove('hidden');
    }

    // Render items
    this.content.innerHTML = items.map(item => this.renderItem(item)).join('');

    // Restore expanded state
    this.expandedItems.forEach(id => {
      const itemEl = this.content.querySelector(`[data-id="${id}"]`);
      if (itemEl) {
        itemEl.classList.add('expanded');
      }
    });
  }

  /**
   * Render a single item
   */
  renderItem(item) {
    const icon = this.getIcon(item);
    const title = this.getTitle(item);
    const meta = this.getMeta(item);
    const preview = this.renderPreview(item);

    return `
      <div
        class="context-drawer-item"
        data-id="${item.id}"
        data-type="${item.type}"
        role="listitem"
      >
        <div class="context-drawer-item-header" tabindex="0">
          <span class="context-drawer-item-icon ${item.type} codicon ${icon}"></span>
          <div class="context-drawer-item-info">
            <div class="context-drawer-item-title">${this.escapeHtml(title)}</div>
            <div class="context-drawer-item-meta">${this.escapeHtml(meta)}</div>
          </div>
          <div class="context-drawer-item-actions">
            <button
              class="context-drawer-item-btn"
              data-action="open"
              title="Open in editor"
              aria-label="Open ${title} in editor"
            >
              <span class="codicon codicon-go-to-file"></span>
            </button>
            <button
              class="context-drawer-item-btn"
              data-action="remove"
              title="Remove"
              aria-label="Remove ${title}"
            >
              <span class="codicon codicon-close"></span>
            </button>
          </div>
        </div>
        <div class="context-drawer-item-content">
          ${preview}
        </div>
      </div>
    `;
  }

  /**
   * Render content preview section
   */
  renderPreview(item) {
    if (item.type === 'image') {
      return `
        <div class="context-drawer-item-image">
          <img src="${item.dataUrl || item.path}" alt="${item.label || 'Image'}" />
        </div>
      `;
    }

    const content = item.content || 'Click to load preview...';
    const truncated = this.truncateContent(content);

    return `
      <pre class="context-drawer-item-preview ${truncated.isTruncated ? 'truncated' : ''}">${this.escapeHtml(truncated.text)}</pre>
    `;
  }

  /**
   * Get icon for item
   */
  getIcon(item) {
    const icons = {
      file: 'codicon-file',
      selection: 'codicon-selection',
      symbol: this.getSymbolIcon(item.symbolKind),
      url: 'codicon-link',
      image: 'codicon-file-media',
    };
    return icons[item.type] || 'codicon-circle-filled';
  }

  getSymbolIcon(kind) {
    const icons = {
      'class': 'codicon-symbol-class',
      'function': 'codicon-symbol-method',
      'method': 'codicon-symbol-method',
      'variable': 'codicon-symbol-variable',
    };
    return icons[kind] || 'codicon-symbol-misc';
  }

  /**
   * Get title for item
   */
  getTitle(item) {
    switch (item.type) {
      case 'file':
        return item.path?.split('/').pop() || 'File';
      case 'selection':
        return item.label || `Selection`;
      case 'symbol':
        return item.name || 'Symbol';
      case 'url':
        return item.label || item.url;
      case 'image':
        return item.label || 'Image';
      default:
        return item.label || 'Context';
    }
  }

  /**
   * Get meta info for item
   */
  getMeta(item) {
    switch (item.type) {
      case 'file':
        if (item.startLine && item.endLine) {
          return `${item.path} • Lines ${item.startLine}-${item.endLine}`;
        }
        return item.path || '';
      case 'selection':
        return `${item.path} • ${item.lineCount || 0} lines`;
      case 'symbol':
        return `${item.symbolKind || 'symbol'} in ${item.path || 'unknown'}`;
      case 'url':
        return item.url || '';
      case 'image':
        return item.path || 'Attached image';
      default:
        return '';
    }
  }

  /**
   * Update token estimate
   */
  updateTokenEstimate(items) {
    // Rough estimate: ~4 chars per token
    let totalChars = 0;
    items.forEach(item => {
      if (item.content) {
        totalChars += item.content.length;
      } else {
        // Estimate based on type
        totalChars += item.type === 'file' ? 5000 : 500;
      }
    });

    const tokens = Math.round(totalChars / 4);

    if (this.tokenCountEl) {
      this.tokenCountEl.textContent = tokens.toLocaleString();

      const indicator = this.tokenCountEl.closest('.context-size-indicator');
      if (indicator) {
        indicator.classList.remove('warning', 'error');
        if (tokens > 50000) {
          indicator.classList.add('error');
        } else if (tokens > 20000) {
          indicator.classList.add('warning');
        }
      }
    }
  }

  /**
   * Handle messages from extension
   */
  handleMessage(message) {
    switch (message.type) {
      case 'context:content':
        this.updateItemContent(message.id, message.content);
        break;
    }
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize drawer after chips manager
let contextDrawerManager;
document.addEventListener('DOMContentLoaded', () => {
  // Assumes contextChipsManager already initialized
  setTimeout(() => {
    contextDrawerManager = new ContextDrawerManager(contextChipsManager);
  }, 0);
});
```

### 4. Wire Drawer to Chips Manager

Update `ContextChipsManager`:

```javascript
// In ContextChipsManager
openContextDrawer() {
  contextDrawerManager?.open();
}

// Update render to also update drawer
renderChips() {
  // ... existing code ...

  // Also update drawer
  contextDrawerManager?.render();
}
```

### 5. Add Extension Handler for Content

In `qicPanel.ts`:

```typescript
case 'context:getContent':
  this.handleGetContextContent(message.id);
  return;

private async handleGetContextContent(id: string): Promise<void> {
  const item = this.stateService.state.contextItems?.find(i => i.id === id);
  if (!item) return;

  let content = '';

  try {
    if (item.type === 'file' || item.type === 'selection') {
      const uri = vscode.Uri.file(item.path);
      const document = await vscode.workspace.openTextDocument(uri);

      if (item.startLine && item.endLine) {
        const lines = [];
        for (let i = item.startLine - 1; i < item.endLine && i < document.lineCount; i++) {
          lines.push(document.lineAt(i).text);
        }
        content = lines.join('\n');
      } else {
        content = document.getText();
      }
    }
  } catch (error) {
    content = `Error loading content: ${error.message}`;
  }

  this.postMessage({
    type: 'context:content',
    id,
    content
  });
}
```

---

## Verification

### Success Criteria
- [ ] Drawer appears when items exist
- [ ] Toggle button expands/collapses drawer
- [ ] Items display with correct icons and info
- [ ] Search filters items in real-time
- [ ] Clear all removes all items with confirmation
- [ ] Item expand shows content preview
- [ ] Open button opens file in editor
- [ ] Remove button removes item
- [ ] Token estimate updates correctly
- [ ] Token warning shows at thresholds
- [ ] Animations smooth for expand/collapse
- [ ] Keyboard navigation works

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Toggle drawer | Click toggle button | Expands/collapses |
| Expand item | Click item header | Content preview shows |
| Search | Type in search | Items filter |
| Clear all | Click clear, confirm | All items removed |
| Open file | Click open button | File opens in editor |
| Remove item | Click × button | Item removed |
| Token warning | Add large files | Warning shows |
| Keyboard nav | Use arrows | Navigate items |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.template.html
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
git checkout src/vs/workbench/contrib/qic/browser/media/main.js
```

---

## GAP-11 Amendment: Lane-Specific Context Budgets

The context drawer's token counter must show lane-specific limits. Different operational lanes have different context budgets:

### Lane Configurations

```javascript
const LANE_BUDGETS = {
    'chat-ask': { maxContext: 16000, label: 'Ask mode' },
    'chat-gather': { maxContext: 32000, label: 'Gather mode' },
    'chat-plan': { maxContext: 64000, label: 'Plan mode' },
    'chat-act': { maxContext: 200000, label: 'Code mode' },
};
```

### Update Token Counter Display

Modify the context drawer footer to show lane-specific limit:

```html
<!-- Updated drawer footer -->
<div class="context-drawer-footer">
    <span class="context-size-indicator">
        <span id="context-token-count">0</span> /
        <span id="context-token-limit">16K</span> tokens
        <span id="context-lane-badge" class="lane-badge">(Ask)</span>
    </span>
    <button id="context-collapse-btn" class="context-collapse-btn">
        Collapse
    </button>
</div>
```

### Update Token Counter Logic

```javascript
// In contextDrawerManager.js

/**
 * Set the context limit based on current lane
 * Called when lane changes
 */
function setLimit(maxTokens) {
    const limitEl = document.getElementById('context-token-limit');
    const badgeEl = document.getElementById('context-lane-badge');

    if (limitEl) {
        limitEl.textContent = formatTokens(maxTokens);
    }

    // Update badge
    const lane = getLaneForBudget(maxTokens);
    if (badgeEl && lane) {
        badgeEl.textContent = `(${LANE_BUDGETS[lane].label})`;
    }

    // Update warning state
    updateWarningState();
}

/**
 * Update warning state when approaching limit
 */
function updateWarningState() {
    const current = getCurrentTokenCount();
    const limit = getCurrentLimit();
    const percentage = (current / limit) * 100;

    const indicator = document.querySelector('.context-size-indicator');
    if (!indicator) return;

    indicator.classList.remove('warning', 'error');

    if (percentage >= 90) {
        indicator.classList.add('error');
    } else if (percentage >= 75) {
        indicator.classList.add('warning');
    }
}
```

### Add Warning Styles

```css
.context-size-indicator.warning {
    color: var(--qic-status-warning);
}

.context-size-indicator.error {
    color: var(--qic-status-error);
    font-weight: 600;
}

.lane-badge {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-left: 4px;
}
```

### Wire to Lane Manager

```javascript
// Subscribe to lane changes
window.QicLaneManager?.onLaneChange((lane) => {
    const budget = LANE_BUDGETS[lane];
    if (budget) {
        window.QicContextDrawer?.setLimit(budget.maxContext);
    }
});
```

This ensures users always see the correct context budget for their current operational mode.

---

## Notes

- Max drawer height (400px) is configurable
- Token estimate is approximate (4 chars/token)
- Content preview truncates at 20 lines / 2000 chars
- Consider lazy loading content for performance
- Image previews use data URLs or file paths
- Search is case-insensitive
- **Lane-specific limits update automatically on mode change**

