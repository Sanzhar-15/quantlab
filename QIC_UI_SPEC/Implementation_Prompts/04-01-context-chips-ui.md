# Prompt 04-01: Context Chips UI

**Phase:** 4 - Context System
**Dependencies:** Phase 3 Complete
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Implement the visual context chips that appear above the input area, showing attached files, code selections, symbols, and other context items. Users can view, remove, and manage context through these chips.

---

## Context

The context system allows users to attach relevant information to their prompts:
- **Files**: Entire files or specific line ranges
- **Selections**: Code selected in the editor
- **Symbols**: Functions, classes, variables
- **URLs**: Web references
- **Images**: Screenshots or diagrams

Context chips provide:
1. Visual indicator of what's attached
2. Quick removal via × button
3. Click to expand details (drawer)
4. Overflow handling for many items
5. Type-specific icons and styling

Reference: `QIC_UI_SPEC/Optimal_plan/08-CONTEXT-SYSTEM.md`

---

## Scope

### In Scope
- Create context chips container HTML/CSS
- Implement chip component with icon, label, remove button
- Support different chip types (file, selection, symbol, url, image)
- Handle overflow (show "+N more" when too many)
- Click handler to open context drawer
- Remove button functionality
- Keyboard accessibility
- Animation for add/remove

### Out of Scope
- Context drawer implementation (04-02)
- @-mention autocomplete (04-03)
- State service integration (04-04)
- Drag-and-drop reordering

---

## Pre-Conditions

- [ ] Phase 3 complete
- [ ] Input area implemented (02-05)
- [ ] Git branch created: `qic-ui/04-01-context-chips`

---

## Tasks

### 1. Add Context Chips Container HTML

In `chat.template.html`, add above the input area:

```html
<!-- Context Chips Container -->
<div id="context-chips-container" class="context-chips-container" aria-label="Attached context">
  <div id="context-chips" class="context-chips" role="list">
    <!-- Chips inserted dynamically -->
  </div>
  <button
    id="context-overflow-btn"
    class="context-overflow-btn hidden"
    aria-label="Show all context items"
    title="Show all attached items"
  >
    <span class="overflow-count">+0 more</span>
  </button>
  <button
    id="add-context-btn"
    class="add-context-btn"
    aria-label="Add context"
    title="Add file, selection, or symbol (@)"
  >
    <span class="codicon codicon-add"></span>
  </button>
</div>
```

### 2. Add Context Chips CSS

In `chat.css`:

```css
/* ========================================
   Context Chips Container
   ======================================== */

.context-chips-container {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-widget-border);
  background: var(--vscode-editor-background);
  min-height: 40px;
  flex-wrap: wrap;
}

.context-chips-container:empty,
.context-chips-container.hidden {
  display: none;
}

.context-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

/* ========================================
   Individual Chip
   ======================================== */

.context-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 12px;
  font-size: 12px;
  max-width: 200px;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.15s ease;
  animation: chipFadeIn 0.2s ease;
}

@keyframes chipFadeIn {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.context-chip:hover {
  background: var(--vscode-badge-background);
  filter: brightness(1.1);
}

.context-chip:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.context-chip.removing {
  animation: chipFadeOut 0.2s ease forwards;
}

@keyframes chipFadeOut {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.9);
  }
}

/* Chip Icon */
.context-chip-icon {
  flex-shrink: 0;
  font-size: 14px;
  opacity: 0.9;
}

/* Chip Label */
.context-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* Chip Remove Button */
.context-chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: 50%;
  opacity: 0.7;
  flex-shrink: 0;
  transition: opacity 0.15s ease, background-color 0.15s ease;
}

.context-chip-remove:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.context-chip-remove:focus {
  outline: none;
  opacity: 1;
  background: rgba(255, 255, 255, 0.15);
}

/* ========================================
   Chip Type Variants
   ======================================== */

/* File chip */
.context-chip[data-type="file"] {
  background: var(--vscode-textLink-foreground);
  color: var(--vscode-editor-background);
}

.context-chip[data-type="file"] .context-chip-icon::before {
  content: "\eb60"; /* codicon-file */
}

/* Selection chip */
.context-chip[data-type="selection"] {
  background: var(--vscode-editor-selectionBackground);
  color: var(--vscode-editor-foreground);
  border: 1px solid var(--vscode-editor-selectionBackground);
}

.context-chip[data-type="selection"] .context-chip-icon::before {
  content: "\eb01"; /* codicon-selection */
}

/* Symbol chip */
.context-chip[data-type="symbol"] {
  background: var(--vscode-symbolIcon-functionForeground);
  color: var(--vscode-editor-background);
}

.context-chip[data-type="symbol"] .context-chip-icon::before {
  content: "\eb5f"; /* codicon-symbol-method */
}

/* Symbol subtypes */
.context-chip[data-type="symbol"][data-symbol-kind="class"] .context-chip-icon::before {
  content: "\eb5b"; /* codicon-symbol-class */
}

.context-chip[data-type="symbol"][data-symbol-kind="function"] .context-chip-icon::before {
  content: "\eb5f"; /* codicon-symbol-method */
}

.context-chip[data-type="symbol"][data-symbol-kind="variable"] .context-chip-icon::before {
  content: "\eb68"; /* codicon-symbol-variable */
}

/* URL chip */
.context-chip[data-type="url"] {
  background: var(--vscode-textLink-foreground);
  color: var(--vscode-editor-background);
}

.context-chip[data-type="url"] .context-chip-icon::before {
  content: "\eb14"; /* codicon-link */
}

/* Image chip */
.context-chip[data-type="image"] {
  background: var(--vscode-charts-purple);
  color: var(--vscode-editor-background);
}

.context-chip[data-type="image"] .context-chip-icon::before {
  content: "\eb09"; /* codicon-file-media */
}

/* Error chip (failed to load) */
.context-chip[data-state="error"] {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}

/* Loading chip */
.context-chip[data-state="loading"] {
  opacity: 0.7;
}

.context-chip[data-state="loading"] .context-chip-icon::before {
  content: "\eb55"; /* codicon-loading */
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ========================================
   Overflow Button
   ======================================== */

.context-overflow-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.context-overflow-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.context-overflow-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.context-overflow-btn.hidden {
  display: none;
}

/* ========================================
   Add Context Button
   ======================================== */

.add-context-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: 1px dashed var(--vscode-widget-border);
  border-radius: 12px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.add-context-btn:hover {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
  color: var(--vscode-foreground);
}

.add-context-btn:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

/* ========================================
   Empty State
   ======================================== */

.context-chips-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  font-style: italic;
}
```

### 3. Implement Context Chips Manager (JavaScript)

In `main.js`, add the context chips manager:

```javascript
// ========================================
// Context Chips Manager
// ========================================

class ContextChipsManager {
  constructor() {
    this.container = document.getElementById('context-chips-container');
    this.chipsContainer = document.getElementById('context-chips');
    this.overflowBtn = document.getElementById('context-overflow-btn');
    this.addBtn = document.getElementById('add-context-btn');

    this.items = new Map(); // id -> ContextItem
    this.maxVisibleChips = 5;

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Add context button
    this.addBtn?.addEventListener('click', () => {
      this.triggerAddContext();
    });

    // Overflow button
    this.overflowBtn?.addEventListener('click', () => {
      this.openContextDrawer();
    });

    // Keyboard support
    this.chipsContainer?.addEventListener('keydown', (e) => {
      this.handleKeyDown(e);
    });

    // Click on chip
    this.chipsContainer?.addEventListener('click', (e) => {
      const chip = e.target.closest('.context-chip');
      const removeBtn = e.target.closest('.context-chip-remove');

      if (removeBtn && chip) {
        e.stopPropagation();
        this.removeItem(chip.dataset.id);
      } else if (chip) {
        this.openItemDetails(chip.dataset.id);
      }
    });
  }

  handleKeyDown(e) {
    const chip = e.target.closest('.context-chip');
    if (!chip) return;

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.removeItem(chip.dataset.id);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.openItemDetails(chip.dataset.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.focusPreviousChip(chip);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.focusNextChip(chip);
        break;
    }
  }

  focusPreviousChip(currentChip) {
    const chips = Array.from(this.chipsContainer.querySelectorAll('.context-chip'));
    const index = chips.indexOf(currentChip);
    if (index > 0) {
      chips[index - 1].focus();
    }
  }

  focusNextChip(currentChip) {
    const chips = Array.from(this.chipsContainer.querySelectorAll('.context-chip'));
    const index = chips.indexOf(currentChip);
    if (index < chips.length - 1) {
      chips[index + 1].focus();
    }
  }

  /**
   * Add a context item
   * @param {ContextItem} item
   */
  addItem(item) {
    if (this.items.has(item.id)) {
      console.warn(`Context item ${item.id} already exists`);
      return;
    }

    this.items.set(item.id, item);
    this.renderChips();
    this.updateVisibility();

    // Notify extension
    vscode.postMessage({
      type: 'context:add',
      item: this.serializeItem(item)
    });
  }

  /**
   * Remove a context item
   * @param {string} id
   */
  removeItem(id) {
    const chip = this.chipsContainer.querySelector(`[data-id="${id}"]`);

    if (chip) {
      chip.classList.add('removing');
      setTimeout(() => {
        this.items.delete(id);
        this.renderChips();
        this.updateVisibility();

        // Notify extension
        vscode.postMessage({
          type: 'context:remove',
          id
        });
      }, 200);
    } else {
      this.items.delete(id);
      this.renderChips();
      this.updateVisibility();
    }
  }

  /**
   * Clear all context items
   */
  clearAll() {
    this.items.clear();
    this.renderChips();
    this.updateVisibility();

    vscode.postMessage({
      type: 'context:clear'
    });
  }

  /**
   * Get all context items
   * @returns {ContextItem[]}
   */
  getItems() {
    return Array.from(this.items.values());
  }

  /**
   * Render chips in container
   */
  renderChips() {
    const items = Array.from(this.items.values());
    const visibleItems = items.slice(0, this.maxVisibleChips);
    const hiddenCount = items.length - visibleItems.length;

    this.chipsContainer.innerHTML = visibleItems
      .map(item => this.createChipHTML(item))
      .join('');

    // Update overflow button
    if (hiddenCount > 0) {
      this.overflowBtn.querySelector('.overflow-count').textContent = `+${hiddenCount} more`;
      this.overflowBtn.classList.remove('hidden');
    } else {
      this.overflowBtn.classList.add('hidden');
    }
  }

  /**
   * Create HTML for a single chip
   * @param {ContextItem} item
   * @returns {string}
   */
  createChipHTML(item) {
    const label = this.getItemLabel(item);
    const icon = this.getItemIcon(item);
    const symbolKind = item.type === 'symbol' ? `data-symbol-kind="${item.symbolKind || 'function'}"` : '';
    const state = item.state ? `data-state="${item.state}"` : '';

    return `
      <div
        class="context-chip"
        data-id="${item.id}"
        data-type="${item.type}"
        ${symbolKind}
        ${state}
        role="listitem"
        tabindex="0"
        aria-label="${label}"
        title="${this.getItemTooltip(item)}"
      >
        <span class="context-chip-icon codicon ${icon}" aria-hidden="true"></span>
        <span class="context-chip-label">${this.escapeHtml(label)}</span>
        <button
          class="context-chip-remove"
          aria-label="Remove ${label}"
          title="Remove"
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </div>
    `;
  }

  /**
   * Get display label for item
   */
  getItemLabel(item) {
    switch (item.type) {
      case 'file':
        // Show filename, optionally with line range
        const filename = item.path.split('/').pop();
        if (item.startLine && item.endLine) {
          return `${filename}:${item.startLine}-${item.endLine}`;
        }
        return filename;

      case 'selection':
        return item.label || `Selection (${item.lineCount} lines)`;

      case 'symbol':
        return item.name || 'Symbol';

      case 'url':
        try {
          return new URL(item.url).hostname;
        } catch {
          return item.url.substring(0, 30);
        }

      case 'image':
        return item.label || 'Image';

      default:
        return item.label || 'Context';
    }
  }

  /**
   * Get icon class for item type
   */
  getItemIcon(item) {
    switch (item.type) {
      case 'file':
        return 'codicon-file';
      case 'selection':
        return 'codicon-selection';
      case 'symbol':
        return this.getSymbolIcon(item.symbolKind);
      case 'url':
        return 'codicon-link';
      case 'image':
        return 'codicon-file-media';
      default:
        return 'codicon-circle-filled';
    }
  }

  /**
   * Get icon for symbol kind
   */
  getSymbolIcon(kind) {
    const icons = {
      'class': 'codicon-symbol-class',
      'function': 'codicon-symbol-method',
      'method': 'codicon-symbol-method',
      'variable': 'codicon-symbol-variable',
      'constant': 'codicon-symbol-constant',
      'interface': 'codicon-symbol-interface',
      'enum': 'codicon-symbol-enum',
      'property': 'codicon-symbol-property',
      'field': 'codicon-symbol-field',
    };
    return icons[kind] || 'codicon-symbol-misc';
  }

  /**
   * Get tooltip for item
   */
  getItemTooltip(item) {
    switch (item.type) {
      case 'file':
        let tooltip = item.path;
        if (item.startLine && item.endLine) {
          tooltip += `\nLines ${item.startLine}-${item.endLine}`;
        }
        return tooltip;

      case 'selection':
        return `${item.path}\n${item.lineCount} lines selected`;

      case 'symbol':
        return `${item.symbolKind || 'symbol'}: ${item.name}\n${item.path}`;

      case 'url':
        return item.url;

      case 'image':
        return item.path || 'Image attachment';

      default:
        return item.label || '';
    }
  }

  /**
   * Update container visibility
   */
  updateVisibility() {
    if (this.items.size === 0) {
      this.container.classList.add('hidden');
    } else {
      this.container.classList.remove('hidden');
    }
  }

  /**
   * Trigger add context action
   */
  triggerAddContext() {
    vscode.postMessage({
      type: 'context:showPicker'
    });
  }

  /**
   * Open context drawer with all items
   */
  openContextDrawer() {
    vscode.postMessage({
      type: 'context:openDrawer'
    });
  }

  /**
   * Open details for specific item
   */
  openItemDetails(id) {
    const item = this.items.get(id);
    if (item) {
      vscode.postMessage({
        type: 'context:openItem',
        id,
        item: this.serializeItem(item)
      });
    }
  }

  /**
   * Serialize item for messaging
   */
  serializeItem(item) {
    return {
      id: item.id,
      type: item.type,
      label: this.getItemLabel(item),
      ...item
    };
  }

  /**
   * Handle message from extension
   */
  handleMessage(message) {
    switch (message.type) {
      case 'context:set':
        this.items.clear();
        (message.items || []).forEach(item => {
          this.items.set(item.id, item);
        });
        this.renderChips();
        this.updateVisibility();
        break;

      case 'context:added':
        if (message.item) {
          this.items.set(message.item.id, message.item);
          this.renderChips();
          this.updateVisibility();
        }
        break;

      case 'context:removed':
        this.items.delete(message.id);
        this.renderChips();
        this.updateVisibility();
        break;

      case 'context:cleared':
        this.items.clear();
        this.renderChips();
        this.updateVisibility();
        break;

      case 'context:updateState':
        const item = this.items.get(message.id);
        if (item) {
          item.state = message.state;
          this.renderChips();
        }
        break;
    }
  }

  /**
   * Escape HTML for safe rendering
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Context item type definition (for documentation)
/**
 * @typedef {Object} ContextItem
 * @property {string} id - Unique identifier
 * @property {'file'|'selection'|'symbol'|'url'|'image'} type - Item type
 * @property {string} [path] - File path (for file, selection, symbol)
 * @property {string} [label] - Display label
 * @property {number} [startLine] - Start line (for file range, selection)
 * @property {number} [endLine] - End line (for file range, selection)
 * @property {number} [lineCount] - Number of lines (for selection)
 * @property {string} [name] - Symbol name
 * @property {string} [symbolKind] - Symbol kind (class, function, etc.)
 * @property {string} [url] - URL (for url type)
 * @property {string} [content] - Content preview
 * @property {'loading'|'error'|'ready'} [state] - Loading state
 */

// Initialize
let contextChipsManager;
document.addEventListener('DOMContentLoaded', () => {
  contextChipsManager = new ContextChipsManager();
});
```

### 4. Wire Message Handler

Update the main message handler:

```javascript
// In the main message handler
window.addEventListener('message', (event) => {
  const message = event.data;

  // Route context messages
  if (message.type?.startsWith('context:')) {
    contextChipsManager?.handleMessage(message);
    return;
  }

  // ... other message handling
});
```

### 5. Add Extension-Side Handler

In `qicPanel.ts`, add handlers for context messages:

```typescript
// In handleWebviewMessage
case 'context:add':
  this.handleContextAdd(message.item);
  return;

case 'context:remove':
  this.handleContextRemove(message.id);
  return;

case 'context:clear':
  this.handleContextClear();
  return;

case 'context:showPicker':
  this.showContextPicker();
  return;

case 'context:openDrawer':
  this.openContextDrawer();
  return;

case 'context:openItem':
  this.openContextItem(message.id, message.item);
  return;

// Implementation stubs (to be completed in 04-04)
private handleContextAdd(item: ContextItem): void {
  // TODO: 04-04 - Add to state service
  this.stateService.addContextItem(item);
}

private handleContextRemove(id: string): void {
  // TODO: 04-04 - Remove from state service
  this.stateService.removeContextItem(id);
}

private handleContextClear(): void {
  // TODO: 04-04 - Clear from state service
  this.stateService.clearContextItems();
}

private showContextPicker(): void {
  // TODO: 04-03 - Show mention autocomplete
  vscode.commands.executeCommand('qic.showContextPicker');
}

private openContextDrawer(): void {
  // TODO: 04-02 - Open drawer
  vscode.commands.executeCommand('qic.openContextDrawer');
}

private openContextItem(id: string, item: ContextItem): void {
  // Open file/symbol in editor
  if (item.type === 'file' || item.type === 'selection') {
    const uri = vscode.Uri.file(item.path);
    vscode.window.showTextDocument(uri, {
      selection: item.startLine
        ? new vscode.Range(item.startLine - 1, 0, item.endLine - 1, 0)
        : undefined
    });
  }
}
```

---

## Verification

### Success Criteria
- [ ] Context chips container renders above input
- [ ] Add button visible and clickable
- [ ] File chip displays with file icon
- [ ] Selection chip displays with selection icon
- [ ] Symbol chip displays with appropriate icon
- [ ] URL chip displays with link icon
- [ ] Image chip displays with media icon
- [ ] Remove button removes chip with animation
- [ ] Overflow shows "+N more" when > 5 items
- [ ] Click on chip triggers detail open
- [ ] Keyboard navigation works (arrows, delete, enter)
- [ ] Loading state shows spinner
- [ ] Error state shows error styling
- [ ] Container hides when empty

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Add file | Call addItem with file | Chip appears |
| Add selection | Call addItem with selection | Chip with lines |
| Add symbol | Call addItem with symbol | Symbol icon |
| Remove chip | Click × button | Chip fades out |
| Keyboard remove | Focus chip, press Delete | Chip removed |
| Click chip | Click on chip | Detail opens |
| Overflow | Add 6+ items | "+N more" shows |
| Overflow click | Click "+N more" | Drawer opens |
| Add button | Click + button | Picker opens |
| Empty state | Remove all | Container hides |

### Accessibility Tests

| Test | Expected |
|------|----------|
| Tab to chips | Focus moves through chips |
| Arrow keys | Navigate between chips |
| Screen reader | Announces chip labels |
| High contrast | Chips visible |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/chat.template.html
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
git checkout src/vs/workbench/contrib/qic/browser/media/main.js
```

---

## Notes

- Chips use VS Code's badge colors for consistency
- Max visible chips (5) is configurable
- Animation duration (200ms) matches VS Code patterns
- Symbol icons follow VS Code's symbol icon conventions
- Consider adding drag-to-reorder in future iteration
- Image chips may need thumbnail preview in drawer

