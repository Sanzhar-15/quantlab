# Prompt 04-03: Mention Autocomplete

**Phase:** 4 - Context System
**Dependencies:** 04-01 (Context Chips UI)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement @-mention autocomplete in the input area that allows users to quickly attach files, symbols, and other context by typing `@` followed by a search term. This provides a fast, keyboard-driven way to add context.

---

## Context

The @-mention system provides:
- Trigger on `@` character in input
- Fuzzy search across files, symbols, and recent items
- Categorized suggestions (Files, Symbols, Recent)
- Keyboard navigation (arrows, enter, escape)
- Preview of selected item
- Integration with context chips

Similar to VS Code's `@` symbol navigation and GitHub's @-mentions.

Reference: `QIC_UI_SPEC/Optimal_plan/08-CONTEXT-SYSTEM.md`

---

## Scope

### In Scope
- Detect `@` trigger in input
- Create autocomplete dropdown UI
- Implement file search
- Implement symbol search
- Show recent context items
- Keyboard navigation
- Insert selected item as chip
- Handle edge cases (cursor position, escape)
- Debounce search requests

### Out of Scope
- URL autocomplete (future)
- Image picker (future)
- Custom context types
- Multi-workspace search

---

## Pre-Conditions

- [ ] 04-01 complete (Context Chips)
- [ ] Input area implemented (02-05)
- [ ] Git branch created: `qic-ui/04-03-mention-autocomplete`

---

## Tasks

### 1. Add Autocomplete HTML

In `chat.template.html`, add after the input area:

```html
<!-- Mention Autocomplete Dropdown -->
<div id="mention-autocomplete" class="mention-autocomplete hidden" role="listbox" aria-label="Context suggestions">
  <div class="mention-autocomplete-header">
    <span class="mention-autocomplete-title">Add Context</span>
    <span class="mention-autocomplete-hint">Type to search files, symbols...</span>
  </div>

  <div class="mention-autocomplete-content">
    <!-- Recent Section -->
    <div class="mention-section" data-section="recent">
      <div class="mention-section-header">
        <span class="codicon codicon-history"></span>
        Recent
      </div>
      <div class="mention-section-items" role="group"></div>
    </div>

    <!-- Files Section -->
    <div class="mention-section" data-section="files">
      <div class="mention-section-header">
        <span class="codicon codicon-file"></span>
        Files
      </div>
      <div class="mention-section-items" role="group"></div>
    </div>

    <!-- Symbols Section -->
    <div class="mention-section" data-section="symbols">
      <div class="mention-section-header">
        <span class="codicon codicon-symbol-method"></span>
        Symbols
      </div>
      <div class="mention-section-items" role="group"></div>
    </div>
  </div>

  <div class="mention-autocomplete-footer">
    <span class="mention-shortcut"><kbd>↑↓</kbd> Navigate</span>
    <span class="mention-shortcut"><kbd>Enter</kbd> Select</span>
    <span class="mention-shortcut"><kbd>Esc</kbd> Cancel</span>
  </div>
</div>
```

### 2. Add Autocomplete CSS

In `chat.css`:

```css
/* ========================================
   Mention Autocomplete
   ======================================== */

.mention-autocomplete {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  max-height: 350px;
  background: var(--vscode-editorSuggestWidget-background);
  border: 1px solid var(--vscode-editorSuggestWidget-border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 100;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mention-autocomplete.hidden {
  display: none;
}

/* Header */
.mention-autocomplete-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-widget-border);
  background: var(--vscode-editorSuggestWidget-background);
}

.mention-autocomplete-title {
  font-weight: 500;
  font-size: 12px;
}

.mention-autocomplete-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* Content */
.mention-autocomplete-content {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

/* Sections */
.mention-section {
  margin-bottom: 4px;
}

.mention-section:empty,
.mention-section.hidden {
  display: none;
}

.mention-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.mention-section-items {
  display: flex;
  flex-direction: column;
}

.mention-section-items:empty::after {
  content: "No results";
  display: block;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* Individual Items */
.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.mention-item:hover,
.mention-item.focused {
  background: var(--vscode-editorSuggestWidget-selectedBackground);
}

.mention-item.focused {
  outline: none;
}

.mention-item[aria-selected="true"] {
  background: var(--vscode-editorSuggestWidget-selectedBackground);
}

.mention-item-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.mention-item-icon.file { color: var(--vscode-symbolIcon-fileForeground); }
.mention-item-icon.symbol { color: var(--vscode-symbolIcon-functionForeground); }
.mention-item-icon.class { color: var(--vscode-symbolIcon-classForeground); }
.mention-item-icon.variable { color: var(--vscode-symbolIcon-variableForeground); }
.mention-item-icon.recent { color: var(--vscode-descriptionForeground); }

.mention-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.mention-item-label {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-item-label .highlight {
  background: var(--vscode-editor-findMatchHighlightBackground);
  border-radius: 2px;
}

.mention-item-detail {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-item-badge {
  flex-shrink: 0;
  padding: 2px 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  font-size: 10px;
}

/* Footer */
.mention-autocomplete-footer {
  display: flex;
  gap: 16px;
  padding: 6px 12px;
  border-top: 1px solid var(--vscode-widget-border);
  background: var(--vscode-editorSuggestWidget-background);
}

.mention-shortcut {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.mention-shortcut kbd {
  display: inline-block;
  padding: 1px 4px;
  background: var(--vscode-keybindingLabel-background);
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-radius: 3px;
  font-family: inherit;
  font-size: 10px;
}

/* Loading State */
.mention-autocomplete.loading .mention-autocomplete-content::before {
  content: "Searching...";
  display: block;
  padding: 16px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

/* Empty State */
.mention-autocomplete.empty .mention-autocomplete-content::after {
  content: "No results found";
  display: block;
  padding: 16px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

/* Position relative to input */
.input-area-wrapper {
  position: relative;
}
```

### 3. Implement Mention Autocomplete Manager

In `main.js`:

```javascript
// ========================================
// Mention Autocomplete Manager
// ========================================

class MentionAutocompleteManager {
  constructor(inputElement, chipsManager) {
    this.input = inputElement;
    this.chipsManager = chipsManager;
    this.dropdown = document.getElementById('mention-autocomplete');
    this.content = this.dropdown?.querySelector('.mention-autocomplete-content');

    this.isOpen = false;
    this.query = '';
    this.triggerPosition = -1;
    this.focusedIndex = -1;
    this.items = [];
    this.debounceTimer = null;
    this.debounceMs = 150;

    this.sections = {
      recent: this.dropdown?.querySelector('[data-section="recent"] .mention-section-items'),
      files: this.dropdown?.querySelector('[data-section="files"] .mention-section-items'),
      symbols: this.dropdown?.querySelector('[data-section="symbols"] .mention-section-items'),
    };

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Input events
    this.input?.addEventListener('input', (e) => this.handleInput(e));
    this.input?.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.input?.addEventListener('blur', (e) => this.handleBlur(e));

    // Click on items
    this.dropdown?.addEventListener('click', (e) => this.handleClick(e));

    // Prevent dropdown from stealing focus
    this.dropdown?.addEventListener('mousedown', (e) => e.preventDefault());
  }

  handleInput(e) {
    const value = this.input.value;
    const cursorPos = this.input.selectionStart;

    // Find @ trigger before cursor
    const textBeforeCursor = value.substring(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      this.close();
      return;
    }

    // Check if @ is at start or after whitespace
    const charBeforeAt = lastAtIndex > 0 ? value[lastAtIndex - 1] : ' ';
    if (!/\s/.test(charBeforeAt) && lastAtIndex > 0) {
      this.close();
      return;
    }

    // Check if there's a space after the @ query (query ended)
    const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
    if (textAfterAt.includes(' ') && textAfterAt.trim().includes(' ')) {
      this.close();
      return;
    }

    // Extract query
    this.triggerPosition = lastAtIndex;
    this.query = textAfterAt.trim();

    // Open and search
    this.open();
    this.debouncedSearch(this.query);
  }

  handleKeyDown(e) {
    if (!this.isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.focusNext();
        break;

      case 'ArrowUp':
        e.preventDefault();
        this.focusPrevious();
        break;

      case 'Enter':
        if (this.focusedIndex >= 0) {
          e.preventDefault();
          this.selectFocused();
        }
        break;

      case 'Tab':
        if (this.focusedIndex >= 0) {
          e.preventDefault();
          this.selectFocused();
        }
        break;

      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  handleBlur(e) {
    // Delay close to allow click on dropdown
    setTimeout(() => {
      if (!this.dropdown?.contains(document.activeElement)) {
        this.close();
      }
    }, 150);
  }

  handleClick(e) {
    const item = e.target.closest('.mention-item');
    if (item) {
      const index = parseInt(item.dataset.index, 10);
      if (!isNaN(index)) {
        this.selectItem(index);
      }
    }
  }

  /**
   * Open autocomplete dropdown
   */
  open() {
    if (this.isOpen) return;

    this.isOpen = true;
    this.dropdown?.classList.remove('hidden');
    this.focusedIndex = -1;

    // Load recent items initially
    if (!this.query) {
      this.showRecent();
    }
  }

  /**
   * Close autocomplete dropdown
   */
  close() {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.dropdown?.classList.add('hidden');
    this.query = '';
    this.triggerPosition = -1;
    this.focusedIndex = -1;
    this.items = [];

    // Clear debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Debounced search
   */
  debouncedSearch(query) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.search(query);
    }, this.debounceMs);
  }

  /**
   * Search for items
   */
  search(query) {
    this.dropdown?.classList.add('loading');

    // Request search from extension
    vscode.postMessage({
      type: 'mention:search',
      query
    });
  }

  /**
   * Show recent items
   */
  showRecent() {
    vscode.postMessage({
      type: 'mention:getRecent'
    });
  }

  /**
   * Handle search results from extension
   */
  handleSearchResults(results) {
    this.dropdown?.classList.remove('loading');
    this.items = [];

    // Render recent
    this.renderSection('recent', results.recent || []);

    // Render files
    this.renderSection('files', results.files || []);

    // Render symbols
    this.renderSection('symbols', results.symbols || []);

    // Check if empty
    if (this.items.length === 0) {
      this.dropdown?.classList.add('empty');
    } else {
      this.dropdown?.classList.remove('empty');
      this.focusedIndex = 0;
      this.updateFocusedItem();
    }
  }

  /**
   * Render a section
   */
  renderSection(sectionName, items) {
    const container = this.sections[sectionName];
    if (!container) return;

    const section = container.closest('.mention-section');

    if (items.length === 0) {
      section?.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    section?.classList.remove('hidden');

    container.innerHTML = items.map((item, localIndex) => {
      const globalIndex = this.items.length;
      this.items.push({ ...item, section: sectionName });

      return this.renderItem(item, globalIndex);
    }).join('');
  }

  /**
   * Render a single item
   */
  renderItem(item, index) {
    const icon = this.getItemIcon(item);
    const iconClass = this.getItemIconClass(item);
    const label = this.highlightMatch(item.label, this.query);
    const detail = item.detail || '';
    const badge = item.badge || '';

    return `
      <div
        class="mention-item"
        data-index="${index}"
        role="option"
        aria-selected="false"
      >
        <span class="mention-item-icon ${iconClass} codicon ${icon}"></span>
        <div class="mention-item-content">
          <div class="mention-item-label">${label}</div>
          ${detail ? `<div class="mention-item-detail">${this.escapeHtml(detail)}</div>` : ''}
        </div>
        ${badge ? `<span class="mention-item-badge">${this.escapeHtml(badge)}</span>` : ''}
      </div>
    `;
  }

  /**
   * Get icon for item
   */
  getItemIcon(item) {
    if (item.icon) return item.icon;

    switch (item.type) {
      case 'file': return 'codicon-file';
      case 'symbol': return this.getSymbolIcon(item.symbolKind);
      case 'recent': return 'codicon-history';
      default: return 'codicon-circle-filled';
    }
  }

  /**
   * Get icon class for styling
   */
  getItemIconClass(item) {
    if (item.type === 'symbol') {
      return item.symbolKind || 'symbol';
    }
    return item.type || 'file';
  }

  /**
   * Get symbol-specific icon
   */
  getSymbolIcon(kind) {
    const icons = {
      'class': 'codicon-symbol-class',
      'function': 'codicon-symbol-method',
      'method': 'codicon-symbol-method',
      'variable': 'codicon-symbol-variable',
      'constant': 'codicon-symbol-constant',
      'interface': 'codicon-symbol-interface',
      'property': 'codicon-symbol-property',
    };
    return icons[kind] || 'codicon-symbol-misc';
  }

  /**
   * Highlight matching text
   */
  highlightMatch(text, query) {
    if (!query) return this.escapeHtml(text);

    const escaped = this.escapeHtml(text);
    const queryEscaped = this.escapeHtml(query);
    const regex = new RegExp(`(${queryEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

    return escaped.replace(regex, '<span class="highlight">$1</span>');
  }

  /**
   * Focus next item
   */
  focusNext() {
    if (this.items.length === 0) return;

    this.focusedIndex = (this.focusedIndex + 1) % this.items.length;
    this.updateFocusedItem();
  }

  /**
   * Focus previous item
   */
  focusPrevious() {
    if (this.items.length === 0) return;

    this.focusedIndex = this.focusedIndex <= 0
      ? this.items.length - 1
      : this.focusedIndex - 1;
    this.updateFocusedItem();
  }

  /**
   * Update focused item visual
   */
  updateFocusedItem() {
    const items = this.dropdown?.querySelectorAll('.mention-item');
    items?.forEach((item, index) => {
      const isFocused = index === this.focusedIndex;
      item.classList.toggle('focused', isFocused);
      item.setAttribute('aria-selected', isFocused ? 'true' : 'false');

      if (isFocused) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /**
   * Select focused item
   */
  selectFocused() {
    if (this.focusedIndex >= 0 && this.focusedIndex < this.items.length) {
      this.selectItem(this.focusedIndex);
    }
  }

  /**
   * Select item by index
   */
  selectItem(index) {
    const item = this.items[index];
    if (!item) return;

    // Create context item
    const contextItem = this.createContextItem(item);

    // Add to chips
    this.chipsManager.addItem(contextItem);

    // Remove @query from input
    this.removeQueryFromInput();

    // Close dropdown
    this.close();
  }

  /**
   * Create context item from mention item
   */
  createContextItem(item) {
    const id = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    switch (item.type) {
      case 'file':
        return {
          id,
          type: 'file',
          path: item.path,
          label: item.label,
        };

      case 'symbol':
        return {
          id,
          type: 'symbol',
          name: item.name,
          path: item.path,
          symbolKind: item.symbolKind,
          startLine: item.startLine,
          endLine: item.endLine,
        };

      case 'recent':
        // Recent items already have full context
        return {
          id,
          ...item.contextData,
        };

      default:
        return {
          id,
          type: item.type || 'file',
          label: item.label,
          path: item.path,
        };
    }
  }

  /**
   * Remove @query from input
   */
  removeQueryFromInput() {
    if (this.triggerPosition === -1) return;

    const value = this.input.value;
    const cursorPos = this.input.selectionStart;

    // Find the end of the query (cursor position or next space)
    let queryEnd = cursorPos;

    // Remove @query
    const before = value.substring(0, this.triggerPosition);
    const after = value.substring(queryEnd);

    this.input.value = before + after;
    this.input.selectionStart = this.input.selectionEnd = this.triggerPosition;

    // Trigger input event for any listeners
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Handle message from extension
   */
  handleMessage(message) {
    switch (message.type) {
      case 'mention:results':
        this.handleSearchResults(message.results);
        break;
    }
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

// Initialize
let mentionAutocomplete;
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chat-input');
  // Assumes contextChipsManager already initialized
  setTimeout(() => {
    mentionAutocomplete = new MentionAutocompleteManager(input, contextChipsManager);
  }, 0);
});
```

### 4. Add Extension-Side Search Handler

In `qicPanel.ts`:

```typescript
case 'mention:search':
  this.handleMentionSearch(message.query);
  return;

case 'mention:getRecent':
  this.handleMentionGetRecent();
  return;

private async handleMentionSearch(query: string): Promise<void> {
  const results = {
    recent: [],
    files: [],
    symbols: [],
  };

  try {
    // Search files
    if (query) {
      const filePattern = `**/*${query}*`;
      const files = await vscode.workspace.findFiles(filePattern, '**/node_modules/**', 10);
      results.files = files.map(uri => ({
        type: 'file',
        label: path.basename(uri.fsPath),
        detail: vscode.workspace.asRelativePath(uri),
        path: uri.fsPath,
      }));
    }

    // Search symbols
    if (query && query.length >= 2) {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );

      results.symbols = (symbols || []).slice(0, 10).map(sym => ({
        type: 'symbol',
        label: sym.name,
        detail: `${vscode.SymbolKind[sym.kind]} in ${path.basename(sym.location.uri.fsPath)}`,
        name: sym.name,
        path: sym.location.uri.fsPath,
        symbolKind: vscode.SymbolKind[sym.kind].toLowerCase(),
        startLine: sym.location.range.start.line + 1,
        endLine: sym.location.range.end.line + 1,
      }));
    }

    // Get recent (from state)
    const recentItems = this.stateService.state.recentContext || [];
    results.recent = recentItems
      .filter(item => !query || item.label?.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 5)
      .map(item => ({
        type: 'recent',
        label: item.label,
        detail: item.path || item.type,
        contextData: item,
      }));

  } catch (error) {
    console.error('Mention search error:', error);
  }

  this.postMessage({
    type: 'mention:results',
    results
  });
}

private async handleMentionGetRecent(): Promise<void> {
  const recentItems = this.stateService.state.recentContext || [];

  this.postMessage({
    type: 'mention:results',
    results: {
      recent: recentItems.slice(0, 10).map(item => ({
        type: 'recent',
        label: item.label,
        detail: item.path || item.type,
        contextData: item,
      })),
      files: [],
      symbols: [],
    }
  });
}
```

### 5. Register Context Picker Command

```typescript
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.showContextPicker',
      title: localize('qic.showContextPicker', 'QIC: Add Context'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    // Focus input and insert @
    const panelService = accessor.get(IQicPanelService);
    panelService.focusInputWithAt();
  }
});
```

---

## Verification

### Success Criteria
- [ ] `@` triggers autocomplete dropdown
- [ ] Typing after `@` searches files/symbols
- [ ] Results grouped by category
- [ ] Arrow keys navigate items
- [ ] Enter/Tab selects item
- [ ] Escape closes dropdown
- [ ] Selected item added as chip
- [ ] `@query` removed from input
- [ ] Recent items show when no query
- [ ] Search is debounced (150ms)
- [ ] Empty state shows message
- [ ] Match highlighting works

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Trigger @ | Type `@` | Dropdown opens |
| Search file | Type `@main` | Files matching "main" |
| Search symbol | Type `@MyClass` | Symbols matching |
| Arrow down | Press ↓ | Next item focused |
| Arrow up | Press ↑ | Previous item focused |
| Select enter | Press Enter | Item added as chip |
| Select tab | Press Tab | Item added as chip |
| Cancel | Press Escape | Dropdown closes |
| Click item | Click on item | Item added as chip |
| Empty query | Just `@` | Recent items shown |

### Edge Cases

| Case | Steps | Expected |
|------|-------|----------|
| Mid-sentence @ | Type `hello @file` | Trigger works |
| @ at start | Type `@file` | Trigger works |
| Cancel and retype | Escape, then `@` again | Works normally |
| No results | `@xyznonexistent` | Empty state |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.template.html
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
git checkout src/vs/workbench/contrib/qic/browser/media/main.js
```

---

## Notes

- Debounce prevents excessive API calls
- File search uses VS Code's `findFiles` API
- Symbol search uses workspace symbol provider
- Recent items are stored in state service
- Consider adding fuzzy matching for better UX
- Keyboard shortcut (Ctrl+Shift+A) focuses input with @
- Max results per category: 10 files, 10 symbols, 5 recent

