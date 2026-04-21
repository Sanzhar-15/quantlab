# Prompt 03-06: Remove Floating Panels

**Phase:** 3 - Native Integration
**Dependencies:** 03-02 (History Quick Pick), 03-03 (Checkpoints Quick Pick)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Remove the legacy floating panels (history panel, checkpoint panel, settings panel) now that their functionality has been replaced with native VS Code Quick Picks. This cleanup reduces complexity, removes dead code, and ensures users interact through the native UI patterns.

---

## Context

The original QIC UI used custom floating panels rendered in the webview:
- **History Panel**: Floating overlay showing conversation history
- **Checkpoint Panel**: Floating overlay showing checkpoints
- **Settings Panel**: Floating overlay for configuration

These have been replaced by:
- History → VS Code Quick Pick (03-02)
- Checkpoints → VS Code Quick Pick (03-03)
- Settings → VS Code Settings UI (existing)
- Provider → VS Code Quick Pick (03-04)

The floating panels should now be removed to:
1. Reduce code complexity
2. Eliminate duplicate functionality
3. Improve performance (less DOM, less JS)
4. Ensure consistent native UX

Reference: `QIC_UI_SPEC/Optimal_plan/07-NATIVE-INTEGRATION.md`

---

## Scope

### In Scope
- Remove floating panel HTML from chat.template.html
- Remove floating panel CSS from chat.css
- Remove floating panel JavaScript from main.js
- Remove panel toggle logic
- Update menu to use Quick Picks instead of panels
- Clean up any orphaned event listeners
- Update tests if any reference removed code

### Out of Scope
- Modifying Quick Pick implementations (already done)
- Removing webview entirely (still needed for chat)
- Major refactoring beyond panel removal

---

## Pre-Conditions

- [ ] 03-02 complete (History Quick Pick works)
- [ ] 03-03 complete (Checkpoints Quick Pick works)
- [ ] Git branch created: `qic-ui/03-06-remove-floating-panels`

---

## Tasks

### 1. Audit Floating Panel Code

First, identify all floating panel code to remove:

```bash
# Find panel-related code in HTML
grep -n "panel\|floating\|overlay\|history-panel\|checkpoint-panel\|settings-panel" \
  src/vs/workbench/contrib/qic/browser/media/chat.template.html

# Find panel-related CSS
grep -n "panel\|floating\|overlay" \
  src/vs/workbench/contrib/qic/browser/media/chat.css

# Find panel-related JS
grep -n "panel\|floating\|showHistory\|showCheckpoints\|showSettings" \
  src/vs/workbench/contrib/qic/browser/media/main.js
```

### 2. Remove Floating Panel HTML

In `chat.template.html`, remove these sections:

```html
<!-- REMOVE: History floating panel -->
<div id="history-panel" class="floating-panel">
  <div class="panel-header">
    <h3>Conversation History</h3>
    <button class="panel-close" data-action="closeHistory">×</button>
  </div>
  <div class="panel-content">
    <div id="history-list"></div>
  </div>
</div>

<!-- REMOVE: Checkpoint floating panel -->
<div id="checkpoint-panel" class="floating-panel">
  <div class="panel-header">
    <h3>Checkpoints</h3>
    <button class="panel-close" data-action="closeCheckpoints">×</button>
  </div>
  <div class="panel-content">
    <div id="checkpoint-list"></div>
  </div>
</div>

<!-- REMOVE: Settings floating panel -->
<div id="settings-panel" class="floating-panel">
  <div class="panel-header">
    <h3>Settings</h3>
    <button class="panel-close" data-action="closeSettings">×</button>
  </div>
  <div class="panel-content">
    <!-- Settings form content -->
  </div>
</div>

<!-- REMOVE: Overlay backdrop -->
<div id="panel-overlay" class="panel-overlay"></div>
```

### 3. Remove Floating Panel CSS

In `chat.css`, remove these styles:

```css
/* REMOVE: Floating panel base styles */
.floating-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  min-width: 400px;
  max-width: 600px;
  max-height: 80vh;
  display: none;
}

.floating-panel.visible {
  display: block;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-widget-border);
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.panel-close {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: var(--vscode-foreground);
  opacity: 0.7;
}

.panel-close:hover {
  opacity: 1;
}

.panel-content {
  padding: 16px;
  overflow-y: auto;
  max-height: calc(80vh - 60px);
}

/* REMOVE: Overlay backdrop */
.panel-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
  display: none;
}

.panel-overlay.visible {
  display: block;
}

/* REMOVE: History panel specific styles */
#history-panel .history-item {
  padding: 12px;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 8px;
}

#history-panel .history-item:hover {
  background: var(--vscode-list-hoverBackground);
}

#history-panel .history-item-title {
  font-weight: 500;
  margin-bottom: 4px;
}

#history-panel .history-item-date {
  font-size: 12px;
  opacity: 0.7;
}

#history-panel .history-group {
  margin-bottom: 16px;
}

#history-panel .history-group-header {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.6;
  margin-bottom: 8px;
}

/* REMOVE: Checkpoint panel specific styles */
#checkpoint-panel .checkpoint-item {
  padding: 12px;
  border-radius: 4px;
  margin-bottom: 8px;
  border: 1px solid var(--vscode-widget-border);
}

#checkpoint-panel .checkpoint-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

#checkpoint-panel .checkpoint-item-title {
  font-weight: 500;
}

#checkpoint-panel .checkpoint-item-time {
  font-size: 12px;
  opacity: 0.7;
}

#checkpoint-panel .checkpoint-item-files {
  font-size: 12px;
  margin-top: 8px;
  opacity: 0.8;
}

#checkpoint-panel .checkpoint-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* REMOVE: Settings panel specific styles */
#settings-panel .setting-group {
  margin-bottom: 16px;
}

#settings-panel .setting-label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
}

#settings-panel .setting-input {
  width: 100%;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  color: var(--vscode-input-foreground);
  border-radius: 4px;
}
```

### 4. Remove Floating Panel JavaScript

In `main.js`, remove these sections:

```javascript
// REMOVE: Panel state management
let activePanels = {
  history: false,
  checkpoints: false,
  settings: false
};

// REMOVE: Panel toggle functions
function showHistoryPanel() {
  hideAllPanels();
  document.getElementById('history-panel').classList.add('visible');
  document.getElementById('panel-overlay').classList.add('visible');
  activePanels.history = true;
  loadHistoryList();
}

function hideHistoryPanel() {
  document.getElementById('history-panel').classList.remove('visible');
  document.getElementById('panel-overlay').classList.remove('visible');
  activePanels.history = false;
}

function showCheckpointPanel() {
  hideAllPanels();
  document.getElementById('checkpoint-panel').classList.add('visible');
  document.getElementById('panel-overlay').classList.add('visible');
  activePanels.checkpoints = true;
  loadCheckpointList();
}

function hideCheckpointPanel() {
  document.getElementById('checkpoint-panel').classList.remove('visible');
  document.getElementById('panel-overlay').classList.remove('visible');
  activePanels.checkpoints = false;
}

function showSettingsPanel() {
  hideAllPanels();
  document.getElementById('settings-panel').classList.add('visible');
  document.getElementById('panel-overlay').classList.add('visible');
  activePanels.settings = true;
}

function hideSettingsPanel() {
  document.getElementById('settings-panel').classList.remove('visible');
  document.getElementById('panel-overlay').classList.remove('visible');
  activePanels.settings = false;
}

function hideAllPanels() {
  hideHistoryPanel();
  hideCheckpointPanel();
  hideSettingsPanel();
}

// REMOVE: History list rendering
function loadHistoryList() {
  const container = document.getElementById('history-list');
  container.innerHTML = '<div class="loading">Loading history...</div>';

  vscode.postMessage({ type: 'getHistory' });
}

function renderHistoryList(conversations) {
  const container = document.getElementById('history-list');
  const grouped = groupByDate(conversations);

  container.innerHTML = Object.entries(grouped)
    .map(([group, items]) => `
      <div class="history-group">
        <div class="history-group-header">${group}</div>
        ${items.map(item => `
          <div class="history-item" data-id="${item.id}">
            <div class="history-item-title">${item.title}</div>
            <div class="history-item-date">${formatRelativeTime(item.timestamp)}</div>
          </div>
        `).join('')}
      </div>
    `).join('');
}

// REMOVE: Checkpoint list rendering
function loadCheckpointList() {
  const container = document.getElementById('checkpoint-list');
  container.innerHTML = '<div class="loading">Loading checkpoints...</div>';

  vscode.postMessage({ type: 'getCheckpoints' });
}

function renderCheckpointList(checkpoints) {
  const container = document.getElementById('checkpoint-list');

  if (checkpoints.length === 0) {
    container.innerHTML = '<div class="empty">No checkpoints yet</div>';
    return;
  }

  container.innerHTML = checkpoints.map(cp => `
    <div class="checkpoint-item" data-id="${cp.id}">
      <div class="checkpoint-item-header">
        <span class="checkpoint-item-title">${cp.description || 'Checkpoint'}</span>
        <span class="checkpoint-item-time">${formatRelativeTime(cp.timestamp)}</span>
      </div>
      <div class="checkpoint-item-files">${cp.files.length} files</div>
      <div class="checkpoint-actions">
        <button class="btn btn-secondary" data-action="previewCheckpoint" data-id="${cp.id}">Preview</button>
        <button class="btn btn-primary" data-action="restoreCheckpoint" data-id="${cp.id}">Restore</button>
        <button class="btn btn-danger" data-action="deleteCheckpoint" data-id="${cp.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

// REMOVE: Panel event listeners
document.getElementById('panel-overlay')?.addEventListener('click', hideAllPanels);

document.querySelectorAll('[data-action="closeHistory"]').forEach(btn => {
  btn.addEventListener('click', hideHistoryPanel);
});

document.querySelectorAll('[data-action="closeCheckpoints"]').forEach(btn => {
  btn.addEventListener('click', hideCheckpointPanel);
});

document.querySelectorAll('[data-action="closeSettings"]').forEach(btn => {
  btn.addEventListener('click', hideSettingsPanel);
});

// REMOVE: Keyboard shortcut for closing panels
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAllPanels();
  }
});

// REMOVE: History item click handlers
document.getElementById('history-list')?.addEventListener('click', (e) => {
  const item = e.target.closest('.history-item');
  if (item) {
    const id = item.dataset.id;
    vscode.postMessage({ type: 'loadConversation', id });
    hideHistoryPanel();
  }
});

// REMOVE: Checkpoint action handlers
document.getElementById('checkpoint-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'previewCheckpoint':
      vscode.postMessage({ type: 'previewCheckpoint', id });
      break;
    case 'restoreCheckpoint':
      if (confirm('Restore this checkpoint? Current changes will be overwritten.')) {
        vscode.postMessage({ type: 'restoreCheckpoint', id });
        hideCheckpointPanel();
      }
      break;
    case 'deleteCheckpoint':
      if (confirm('Delete this checkpoint? This cannot be undone.')) {
        vscode.postMessage({ type: 'deleteCheckpoint', id });
        loadCheckpointList();
      }
      break;
  }
});

// REMOVE: Message handlers for panel data
case 'historyData':
  renderHistoryList(message.conversations);
  break;

case 'checkpointsData':
  renderCheckpointList(message.checkpoints);
  break;
```

### 5. Update Menu Actions

Update the menu to trigger Quick Picks instead of panels:

```javascript
// In main.js - Update menu item handlers

// BEFORE (REMOVE):
case 'showHistory':
  showHistoryPanel();
  break;

case 'showCheckpoints':
  showCheckpointPanel();
  break;

// AFTER (ADD):
case 'showHistory':
  // Delegate to native Quick Pick
  vscode.postMessage({ type: 'quickPick:history' });
  break;

case 'showCheckpoints':
  // Delegate to native Quick Pick
  vscode.postMessage({ type: 'quickPick:checkpoints' });
  break;

case 'switchProvider':
  // Delegate to native Quick Pick
  vscode.postMessage({ type: 'quickPick:provider' });
  break;
```

### 6. Remove Panel-Related Message Handlers

In `qicPanel.ts`, remove handlers that served the floating panels:

```typescript
// REMOVE: These message handlers are no longer needed
case 'getHistory':
  const history = await this.stateService.getConversationSummaries();
  this.postMessage({ type: 'historyData', conversations: history });
  return;

case 'getCheckpoints':
  const checkpoints = this.stateService.state.checkpoints;
  this.postMessage({ type: 'checkpointsData', checkpoints });
  return;

case 'previewCheckpoint':
  // Preview now handled in Quick Pick
  return;

// KEEP: These handlers are still used by Quick Picks
case 'quickPick:history':
  this.showHistoryQuickPick();
  return;

case 'quickPick:checkpoints':
  this.showCheckpointQuickPick();
  return;

case 'quickPick:provider':
  this.showProviderQuickPick();
  return;
```

### 7. Clean Up Utility Functions

Remove helper functions that were only used by floating panels:

```javascript
// REMOVE if only used by floating panels (check usage first)
function groupByDate(items) {
  // ... date grouping logic
}

// KEEP if used elsewhere, otherwise REMOVE
function formatRelativeTime(date) {
  // ... relative time formatting
  // Note: This might be used elsewhere - check before removing
}
```

### 8. Update Imports

Clean up any imports that are no longer needed:

```typescript
// In qicPanel.ts - Remove unused imports
// REMOVE if no longer used:
import { HistoryPanelData, CheckpointPanelData } from './types.js';
```

### 9. Final Cleanup Verification

Run these checks to ensure complete removal:

```bash
# Check for any remaining panel references
grep -rn "floating-panel\|history-panel\|checkpoint-panel\|settings-panel" \
  src/vs/workbench/contrib/qic/browser/

# Check for orphaned CSS classes
grep -rn "\.panel-\|\.floating-" \
  src/vs/workbench/contrib/qic/browser/media/

# Check for unused panel functions in JS
grep -n "showHistoryPanel\|showCheckpointPanel\|showSettingsPanel\|hideAllPanels" \
  src/vs/workbench/contrib/qic/browser/media/main.js

# Verify Quick Pick messages are handled
grep -n "quickPick:" \
  src/vs/workbench/contrib/qic/browser/qicPanel.ts
```

---

## Verification

### Success Criteria
- [ ] No floating panel HTML in chat.template.html
- [ ] No floating panel CSS in chat.css
- [ ] No floating panel JS in main.js
- [ ] Menu "History" opens Quick Pick (not floating panel)
- [ ] Menu "Checkpoints" opens Quick Pick (not floating panel)
- [ ] Menu "Settings" opens VS Code settings (not floating panel)
- [ ] No overlay backdrop elements
- [ ] No panel-related event listeners
- [ ] No console errors when clicking menu items
- [ ] Code passes lint checks

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| History menu | Click menu → History | Quick Pick opens (not panel) |
| Checkpoints menu | Click menu → Checkpoints | Quick Pick opens (not panel) |
| Settings menu | Click menu → Settings | VS Code settings opens |
| Provider menu | Click menu → Provider | Quick Pick opens |
| No orphan DOM | Inspect DOM | No panel/overlay elements |
| Clean console | Open DevTools | No errors related to panels |
| Escape key | Press Escape | No panel hide behavior |

### Code Quality Checks

```bash
# Run linter
npm run lint

# Check for unused exports
# (Manual: search for exported functions that are no longer imported)

# Verify bundle size reduced
npm run build
# Compare bundle sizes before/after
```

---

## Rollback

```bash
# If issues arise, restore the removed files
git checkout src/vs/workbench/contrib/qic/browser/media/chat.template.html
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
git checkout src/vs/workbench/contrib/qic/browser/media/main.js
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
```

---

## Notes

- Keep `formatRelativeTime` if used by other parts of the UI
- The Quick Picks provide better UX than floating panels
- This cleanup reduces webview complexity significantly
- Consider removing panel-related test files if they exist
- Document removal in CHANGELOG for transparency
- Estimated code reduction: ~500-800 lines of HTML/CSS/JS

---

## Migration Checklist

Before removing, ensure these alternatives work:

| Old Feature | New Alternative | Status |
|-------------|-----------------|--------|
| History floating panel | `qic.showHistory` Quick Pick | Verify |
| Checkpoint floating panel | `qic.showCheckpoints` Quick Pick | Verify |
| Settings floating panel | VS Code Settings + Provider Quick Pick | Verify |
| Panel overlay backdrop | VS Code Quick Pick overlay | N/A |
| Escape to close | Quick Pick built-in | N/A |
| Click outside to close | Quick Pick built-in | N/A |

