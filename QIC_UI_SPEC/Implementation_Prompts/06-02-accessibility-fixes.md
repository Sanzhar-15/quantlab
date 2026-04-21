# Prompt 06-02: Accessibility Fixes

**Phase:** 6 - Polish
**Dependencies:** 06-01 (Accessibility Audit)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Fix all P0 and P1 accessibility issues identified in the audit (06-01), and address as many P2/P3 issues as feasible. Ensure the QIC UI meets WCAG 2.1 AA standards.

---

## Context

Based on the audit findings, implement fixes for:
- Keyboard navigation gaps
- Screen reader compatibility
- Color contrast issues
- Focus management
- ARIA attributes
- Touch targets
- Animation preferences

This prompt provides patterns and code for common accessibility fixes.

---

## Scope

### In Scope
- Fix all P0 (critical) issues
- Fix all P1 (serious) issues
- Fix P2 issues as time permits
- Document any P3 issues deferred

### Out of Scope
- Redesigning UI layouts
- Adding new features
- Automated accessibility testing

---

## Pre-Conditions

- [ ] 06-01 complete (Audit with documented issues)
- [ ] Issue list available
- [ ] Git branch created: `qic-ui/06-02-a11y-fixes`

---

## Common Fixes

### 1. Keyboard Navigation Fixes

#### Add keyboard handlers for chips

```javascript
// In ContextChipsManager
setupEventListeners() {
  this.chipsContainer?.addEventListener('keydown', (e) => {
    const chip = e.target.closest('.context-chip');
    if (!chip) return;

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.removeItem(chip.dataset.id);
        // Move focus to next chip or add button
        this.focusNextAfterRemove(chip);
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
  });
}

focusNextAfterRemove(removedChip) {
  const chips = Array.from(this.chipsContainer.querySelectorAll('.context-chip'));
  const index = chips.indexOf(removedChip);

  // Focus next chip, or previous, or add button
  if (chips[index + 1]) {
    chips[index + 1].focus();
  } else if (chips[index - 1]) {
    chips[index - 1].focus();
  } else {
    this.addBtn?.focus();
  }
}
```

#### Add roving tabindex for menu

```javascript
// Menu keyboard navigation
class MenuKeyboardManager {
  constructor(menuElement) {
    this.menu = menuElement;
    this.items = [];
    this.currentIndex = 0;

    this.menu.addEventListener('keydown', (e) => this.handleKeyDown(e));
  }

  updateItems() {
    this.items = Array.from(this.menu.querySelectorAll('[role="menuitem"]'));
    // Set tabindex: only current item is tabbable
    this.items.forEach((item, i) => {
      item.setAttribute('tabindex', i === this.currentIndex ? '0' : '-1');
    });
  }

  handleKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.focusNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.focusPrevious();
        break;
      case 'Home':
        e.preventDefault();
        this.focusFirst();
        break;
      case 'End':
        e.preventDefault();
        this.focusLast();
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  focusNext() {
    this.currentIndex = (this.currentIndex + 1) % this.items.length;
    this.focusCurrent();
  }

  focusPrevious() {
    this.currentIndex = this.currentIndex === 0
      ? this.items.length - 1
      : this.currentIndex - 1;
    this.focusCurrent();
  }

  focusCurrent() {
    this.items.forEach((item, i) => {
      item.setAttribute('tabindex', i === this.currentIndex ? '0' : '-1');
    });
    this.items[this.currentIndex]?.focus();
  }
}
```

### 2. ARIA Attribute Fixes

#### Add ARIA to menu

```html
<!-- Menu button -->
<button
  id="menu-button"
  aria-haspopup="menu"
  aria-expanded="false"
  aria-controls="header-menu"
  aria-label="QIC menu"
>
  <span class="codicon codicon-kebab-vertical"></span>
</button>

<!-- Menu -->
<div
  id="header-menu"
  role="menu"
  aria-labelledby="menu-button"
  hidden
>
  <button role="menuitem" tabindex="0">New Chat</button>
  <button role="menuitem" tabindex="-1">History</button>
  <button role="menuitem" tabindex="-1">Checkpoints</button>
  <!-- etc -->
</div>
```

```javascript
// Update aria-expanded when menu opens/closes
function toggleMenu(isOpen) {
  const button = document.getElementById('menu-button');
  const menu = document.getElementById('header-menu');

  button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  menu.hidden = !isOpen;

  if (isOpen) {
    // Focus first item
    menu.querySelector('[role="menuitem"]')?.focus();
  }
}
```

#### Add ARIA to context chips

```html
<div
  id="context-chips"
  class="context-chips"
  role="list"
  aria-label="Attached context items"
>
  <div
    class="context-chip"
    role="listitem"
    tabindex="0"
    aria-label="main.ts, file. Press Delete to remove."
  >
    <span class="context-chip-icon codicon codicon-file" aria-hidden="true"></span>
    <span class="context-chip-label">main.ts</span>
    <button
      class="context-chip-remove"
      aria-label="Remove main.ts from context"
      tabindex="-1"
    >
      <span class="codicon codicon-close" aria-hidden="true"></span>
    </button>
  </div>
</div>
```

#### Add ARIA to autocomplete

```html
<input
  id="chat-input"
  role="combobox"
  aria-expanded="false"
  aria-haspopup="listbox"
  aria-controls="mention-autocomplete"
  aria-autocomplete="list"
  aria-activedescendant=""
>

<div
  id="mention-autocomplete"
  role="listbox"
  aria-label="Context suggestions"
>
  <div role="option" id="item-0" aria-selected="true">main.ts</div>
  <div role="option" id="item-1" aria-selected="false">utils.ts</div>
</div>
```

```javascript
// Update aria-activedescendant when navigating
function updateActiveDescendant(itemId) {
  const input = document.getElementById('chat-input');
  input.setAttribute('aria-activedescendant', itemId || '');
  input.setAttribute('aria-expanded', itemId ? 'true' : 'false');
}
```

#### Add ARIA to change cards

```html
<div
  class="change-card"
  role="region"
  aria-label="Modify src/main.ts, plus 5, minus 3"
>
  <!-- Card content -->
  <div class="change-card-status" role="status" aria-live="polite">
    Applied successfully
  </div>
</div>
```

### 3. Focus Management Fixes

#### Trap focus in dialogs/modals

```javascript
class FocusTrap {
  constructor(element) {
    this.element = element;
    this.focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    this.previouslyFocused = null;
  }

  activate() {
    this.previouslyFocused = document.activeElement;

    // Get focusable elements
    const focusable = this.element.querySelectorAll(this.focusableSelector);
    this.firstFocusable = focusable[0];
    this.lastFocusable = focusable[focusable.length - 1];

    // Add trap listener
    this.element.addEventListener('keydown', this.handleKeyDown.bind(this));

    // Focus first element
    this.firstFocusable?.focus();
  }

  deactivate() {
    this.element.removeEventListener('keydown', this.handleKeyDown.bind(this));
    this.previouslyFocused?.focus();
  }

  handleKeyDown(e) {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      // Shift+Tab: if on first, go to last
      if (document.activeElement === this.firstFocusable) {
        e.preventDefault();
        this.lastFocusable?.focus();
      }
    } else {
      // Tab: if on last, go to first
      if (document.activeElement === this.lastFocusable) {
        e.preventDefault();
        this.firstFocusable?.focus();
      }
    }
  }
}
```

#### Restore focus after actions

```javascript
// After removing a chip
removeItem(id) {
  const chip = this.chipsContainer.querySelector(`[data-id="${id}"]`);
  const nextFocus = chip?.nextElementSibling || chip?.previousElementSibling || this.addBtn;

  // Animate and remove
  chip?.classList.add('removing');
  setTimeout(() => {
    this.items.delete(id);
    this.renderChips();
    nextFocus?.focus();
  }, 200);
}
```

### 4. Color Contrast Fixes

#### Update CSS variables for better contrast

```css
/* Ensure text on badges meets 4.5:1 */
.change-type-badge {
  /* Use darker/lighter text for better contrast */
}

.change-card[data-type="create"] .change-type-badge {
  background: #2ea043; /* Darker green */
  color: #ffffff;
}

.change-card[data-type="modify"] .change-type-badge {
  background: #1f6feb; /* Ensure sufficient contrast */
  color: #ffffff;
}

.change-card[data-type="delete"] .change-type-badge {
  background: #da3633;
  color: #ffffff;
}

/* Placeholder text - ensure 4.5:1 against background */
.chat-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
  /* VS Code handles this, but verify in all themes */
}

/* Disabled state - still needs 3:1 minimum */
.button:disabled {
  opacity: 0.6; /* May not be enough - use specific colors */
  color: var(--vscode-disabledForeground);
}
```

### 5. Focus Indicator Fixes

```css
/* Ensure focus indicators are visible */
.context-chip:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

/* Don't remove outline, style it */
.button:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

/* For dark backgrounds, may need different approach */
.change-card:focus-within {
  box-shadow: 0 0 0 2px var(--vscode-focusBorder);
}

/* High contrast mode */
@media (forced-colors: active) {
  .context-chip:focus,
  .button:focus {
    outline: 2px solid CanvasText;
  }
}
```

### 6. Reduced Motion Support

```css
/* Respect user preference for reduced motion */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  .context-chip {
    animation: none;
  }

  .context-drawer {
    transition: none;
  }
}
```

### 7. Live Regions for Status Updates

```html
<!-- Add live region for announcements -->
<div
  id="qic-announcer"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  class="sr-only"
></div>

<style>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
```

```javascript
// Announce status changes
function announce(message) {
  const announcer = document.getElementById('qic-announcer');
  if (announcer) {
    announcer.textContent = '';
    // Brief delay ensures announcement
    setTimeout(() => {
      announcer.textContent = message;
    }, 50);
  }
}

// Use it
function applyChange(changeId) {
  // ... apply logic ...
  announce('Change applied successfully');
}

function rejectChange(changeId) {
  // ... reject logic ...
  announce('Change rejected');
}
```

### 8. Touch Target Fixes

```css
/* Ensure minimum 44x44px touch targets */
.context-chip-remove {
  min-width: 44px;
  min-height: 44px;
  /* Visual size can be smaller with padding */
  padding: 12px;
}

.change-action-btn {
  min-width: 44px;
  min-height: 44px;
}

/* Increase spacing between adjacent targets */
.change-card-actions {
  gap: 8px; /* At least 8px between buttons */
}
```

---

## Verification

### Success Criteria
- [ ] All P0 issues fixed
- [ ] All P1 issues fixed
- [ ] P2 issues fixed where feasible
- [ ] Keyboard navigation works throughout
- [ ] Screen reader announces all content
- [ ] Focus indicators visible
- [ ] Color contrast meets AA
- [ ] Animations respect reduced motion

### Re-test Checklist

After fixes, re-verify:

| Test | Before | After | Pass |
|------|--------|-------|------|
| Tab through all interactive elements | | | ☐ |
| Activate buttons with Enter/Space | | | ☐ |
| Navigate menus with arrows | | | ☐ |
| Remove chips with Delete | | | ☐ |
| Screen reader announces chips | | | ☐ |
| Screen reader announces status changes | | | ☐ |
| Focus visible on all elements | | | ☐ |
| Color contrast passes | | | ☐ |
| Reduced motion respected | | | ☐ |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/
```

---

## Amendment: GAP-15 Visual Design Tokens

QIC requires consistent CSS custom properties for focus indicators, selection highlighting, and syntax highlighting. These ensure visual consistency across themes and support high contrast modes.

### Required CSS Variables

Add to the QIC webview root stylesheet:

```css
/* src/vs/workbench/contrib/qic/browser/media/qic.css */

:root {
  /* Focus indicators (GAP-15) */
  --qic-focus-ring: var(--vscode-focusBorder, #007acc);
  --qic-focus-ring-width: 2px;
  --qic-focus-ring-offset: 2px;

  /* Selection highlighting */
  --qic-selection-bg: var(--vscode-editor-selectionBackground, rgba(0, 120, 215, 0.3));
  --qic-selection-fg: var(--vscode-editor-selectionForeground, inherit);
  --qic-inactive-selection-bg: var(--vscode-editor-inactiveSelectionBackground, rgba(0, 120, 215, 0.15));

  /* Syntax highlighting (for code blocks) */
  --qic-code-keyword: var(--vscode-editorSyntaxHighlight-keywordForeground, #569cd6);
  --qic-code-string: var(--vscode-editorSyntaxHighlight-stringForeground, #ce9178);
  --qic-code-number: var(--vscode-editorSyntaxHighlight-numberForeground, #b5cea8);
  --qic-code-comment: var(--vscode-editorSyntaxHighlight-commentForeground, #6a9955);
  --qic-code-function: var(--vscode-editorSyntaxHighlight-functionForeground, #dcdcaa);
  --qic-code-type: var(--vscode-editorSyntaxHighlight-typeForeground, #4ec9b0);
  --qic-code-variable: var(--vscode-editorSyntaxHighlight-variableForeground, #9cdcfe);
  --qic-code-operator: var(--vscode-editorSyntaxHighlight-operatorForeground, #d4d4d4);

  /* Interactive element states */
  --qic-hover-bg: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.31));
  --qic-active-bg: var(--vscode-list-activeSelectionBackground, #094771);
  --qic-active-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
}

/* High contrast theme support */
@media (forced-colors: active) {
  :root {
    --qic-focus-ring: CanvasText;
    --qic-focus-ring-width: 3px;
    --qic-selection-bg: Highlight;
    --qic-selection-fg: HighlightText;
  }
}
```

### Apply Focus Ring Consistently

```css
/* Universal focus style using custom properties */
.qic-focusable:focus,
.context-chip:focus,
.change-card:focus,
.message-action-btn:focus,
.input-area button:focus,
[tabindex="0"]:focus {
  outline: var(--qic-focus-ring-width) solid var(--qic-focus-ring);
  outline-offset: var(--qic-focus-ring-offset);
}

/* Remove default browser outline since we provide our own */
.qic-panel *:focus {
  outline: none;
}
.qic-panel *:focus-visible {
  outline: var(--qic-focus-ring-width) solid var(--qic-focus-ring);
  outline-offset: var(--qic-focus-ring-offset);
}
```

### Apply Syntax Highlighting to Code Blocks

```css
/* Code block syntax highlighting */
.message-content pre code .token.keyword { color: var(--qic-code-keyword); }
.message-content pre code .token.string { color: var(--qic-code-string); }
.message-content pre code .token.number { color: var(--qic-code-number); }
.message-content pre code .token.comment { color: var(--qic-code-comment); }
.message-content pre code .token.function { color: var(--qic-code-function); }
.message-content pre code .token.class-name { color: var(--qic-code-type); }
.message-content pre code .token.variable { color: var(--qic-code-variable); }
.message-content pre code .token.operator { color: var(--qic-code-operator); }
```

### Verification for GAP-15

- [ ] Focus ring visible on all interactive elements
- [ ] Focus ring uses `--qic-focus-ring` variable
- [ ] Selection background uses `--qic-selection-bg`
- [ ] Code blocks use syntax highlighting variables
- [ ] High contrast mode works correctly
- [ ] Variables fall back to VS Code defaults when unavailable

---

## Notes

- Test fixes with actual screen readers, not just ARIA
- VS Code Quick Picks handle their own accessibility
- Some issues may require CSS custom properties for theming
- Document any issues that can't be fixed and why
- Consider creating accessibility testing checklist for future features
- **GAP-15 design tokens ensure visual consistency across all themes**

