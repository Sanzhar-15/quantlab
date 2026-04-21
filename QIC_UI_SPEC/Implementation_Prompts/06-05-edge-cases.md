# Prompt 06-05: Edge Cases

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Handle edge cases and boundary conditions throughout the QIC UI to ensure robustness. This includes empty states, overflow handling, extreme inputs, race conditions, and error recovery.

---

## Context

Edge cases to handle:
- **Empty states**: No history, no context, no changes
- **Overflow**: Long file names, many items, large content
- **Extremes**: Very long messages, rapid inputs, slow networks
- **Concurrent operations**: Multiple actions at once
- **Interruptions**: Mid-operation cancellations, errors
- **Data integrity**: Stale data, missing data, malformed data

---

## Scope

### In Scope
- Empty state handling
- Text/content overflow
- Long lists and pagination
- Rapid/concurrent user actions
- Interrupted operations
- Stale state handling
- Data validation

### Out of Scope
- Security edge cases (separate concern)
- Performance optimization (06-04)
- Localization edge cases

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] Base features working
- [ ] Git branch created: `qic-ui/06-05-edge-cases`

---

## Tasks

### 1. Empty States

#### Conversation Empty State

```html
<div class="empty-state" id="conversation-empty">
  <div class="empty-state-icon">
    <span class="codicon codicon-sparkle"></span>
  </div>
  <h3 class="empty-state-title">Start a Conversation</h3>
  <p class="empty-state-description">
    Ask QIC to help with coding tasks, explain code, or make changes.
  </p>
  <div class="empty-state-actions">
    <button class="empty-state-action" data-action="explain">
      <span class="codicon codicon-question"></span>
      Explain this code
    </button>
    <button class="empty-state-action" data-action="refactor">
      <span class="codicon codicon-edit"></span>
      Refactor selection
    </button>
    <button class="empty-state-action" data-action="test">
      <span class="codicon codicon-beaker"></span>
      Write tests
    </button>
  </div>
</div>
```

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

.empty-state-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-state-title {
  margin: 0 0 8px 0;
  font-size: 18px;
  color: var(--vscode-foreground);
}

.empty-state-description {
  margin: 0 0 24px 0;
  max-width: 300px;
}

.empty-state-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.empty-state-action {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}
```

#### History Empty State

```javascript
// In showHistoryQuickPick
if (conversations.length === 0) {
  this.notificationService.info(
    'No conversation history yet. Start a conversation to see it here.'
  );
  return undefined;
}
```

#### Context Empty State

```javascript
// Context chips container hides when empty
updateVisibility() {
  if (this.items.size === 0) {
    this.container.classList.add('hidden');
  } else {
    this.container.classList.remove('hidden');
  }
}
```

### 2. Text Overflow Handling

```css
/* File paths - truncate start to show filename */
.file-path {
  direction: rtl;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Long chip labels */
.context-chip-label {
  max-width: 150px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Long menu items */
.menu-item-label {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Long error messages - wrap */
.qic-error-message {
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* Code blocks - scroll horizontally */
.message pre {
  max-width: 100%;
  overflow-x: auto;
}

/* Very long words */
.message-content {
  word-break: break-word;
  overflow-wrap: break-word;
}
```

```javascript
// Truncate helper
function truncateMiddle(str, maxLength) {
  if (str.length <= maxLength) return str;

  const half = Math.floor((maxLength - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(-half)}`;
}

// Use for file paths
function formatFilePath(path, maxLength = 40) {
  const filename = path.split('/').pop();
  if (path.length <= maxLength) return path;

  // Show as much of the path as possible, prioritizing filename
  const remaining = maxLength - filename.length - 4; // ".../"
  if (remaining > 0) {
    return `...${path.slice(-maxLength + 3)}`;
  }
  return truncateMiddle(filename, maxLength);
}
```

### 3. Long Lists and Pagination

```javascript
// Virtual scrolling for long conversation
class VirtualScroller {
  constructor(container, itemHeight, renderItem) {
    this.container = container;
    this.itemHeight = itemHeight;
    this.renderItem = renderItem;
    this.items = [];
    this.visibleItems = new Map();
    this.buffer = 5; // Render 5 extra items above/below

    this.container.addEventListener('scroll', () => this.onScroll());
  }

  setItems(items) {
    this.items = items;
    this.container.style.height = `${items.length * this.itemHeight}px`;
    this.render();
  }

  onScroll() {
    requestAnimationFrame(() => this.render());
  }

  render() {
    const scrollTop = this.container.scrollTop;
    const containerHeight = this.container.clientHeight;

    const startIndex = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.buffer);
    const endIndex = Math.min(
      this.items.length,
      Math.ceil((scrollTop + containerHeight) / this.itemHeight) + this.buffer
    );

    // Remove items outside range
    for (const [index, element] of this.visibleItems) {
      if (index < startIndex || index >= endIndex) {
        element.remove();
        this.visibleItems.delete(index);
      }
    }

    // Add items in range
    for (let i = startIndex; i < endIndex; i++) {
      if (!this.visibleItems.has(i)) {
        const element = this.renderItem(this.items[i], i);
        element.style.position = 'absolute';
        element.style.top = `${i * this.itemHeight}px`;
        this.container.appendChild(element);
        this.visibleItems.set(i, element);
      }
    }
  }
}

// Pagination for Quick Picks
const MAX_QUICK_PICK_ITEMS = 100;

function paginateItems(items, page = 0, pageSize = MAX_QUICK_PICK_ITEMS) {
  const start = page * pageSize;
  const paged = items.slice(start, start + pageSize);

  if (items.length > pageSize) {
    // Add "Load more" item
    if (start + pageSize < items.length) {
      paged.push({
        label: `Load more (${items.length - start - pageSize} remaining)`,
        isLoadMore: true,
        nextPage: page + 1,
      });
    }
  }

  return paged;
}
```

### 4. Rapid/Concurrent Actions

```javascript
// Debounce rapid typing
class Debouncer {
  constructor(delay = 150) {
    this.delay = delay;
    this.timer = null;
  }

  run(fn) {
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, this.delay);
  }

  cancel() {
    clearTimeout(this.timer);
  }
}

// Usage
const searchDebouncer = new Debouncer(150);
input.addEventListener('input', () => {
  searchDebouncer.run(() => performSearch(input.value));
});

// Prevent double-submit
class ActionGuard {
  constructor() {
    this.pending = new Set();
  }

  async guard(actionId, fn) {
    if (this.pending.has(actionId)) {
      console.warn(`Action ${actionId} already in progress`);
      return;
    }

    this.pending.add(actionId);
    try {
      return await fn();
    } finally {
      this.pending.delete(actionId);
    }
  }

  isPending(actionId) {
    return this.pending.has(actionId);
  }
}

// Usage
const actionGuard = new ActionGuard();

async function sendMessage() {
  await actionGuard.guard('send', async () => {
    // Disable button while sending
    sendBtn.disabled = true;
    try {
      await doSend();
    } finally {
      sendBtn.disabled = false;
    }
  });
}

// Abort previous request on new one
class CancellableRequest {
  constructor() {
    this.controller = null;
  }

  async fetch(url, options = {}) {
    // Abort previous
    this.abort();

    this.controller = new AbortController();
    return fetch(url, {
      ...options,
      signal: this.controller.signal,
    });
  }

  abort() {
    this.controller?.abort();
    this.controller = null;
  }
}
```

### 5. Interrupted Operations

```javascript
// Handle mid-operation cancellation
class OperationTracker {
  constructor() {
    this.operations = new Map();
  }

  start(opId, cleanup) {
    this.operations.set(opId, { cleanup, startTime: Date.now() });
  }

  complete(opId) {
    this.operations.delete(opId);
  }

  cancel(opId) {
    const op = this.operations.get(opId);
    if (op) {
      op.cleanup?.();
      this.operations.delete(opId);
    }
  }

  cancelAll() {
    for (const [opId, op] of this.operations) {
      op.cleanup?.();
    }
    this.operations.clear();
  }
}

// Usage for streaming
const opTracker = new OperationTracker();

function startStreaming(messageId) {
  opTracker.start(messageId, () => {
    // Cleanup: finalize partial message
    finalizeMessage(messageId);
  });
}

// Cancel on panel close or new message
function handlePanelClose() {
  opTracker.cancelAll();
}
```

### 6. Stale State Handling

```javascript
// Revision-based state sync
class StateSync {
  constructor() {
    this.revision = 0;
    this.pendingUpdates = [];
  }

  update(patch, expectedRevision) {
    if (expectedRevision !== this.revision) {
      console.warn('Stale update detected, re-syncing');
      this.requestFullSync();
      return false;
    }

    this.applyPatch(patch);
    this.revision++;
    return true;
  }

  requestFullSync() {
    vscode.postMessage({ type: 'state:requestSync' });
  }
}

// Handle webview reload
window.addEventListener('load', () => {
  vscode.postMessage({ type: 'webview:ready' });
});

// Extension side: restore state on webview ready
case 'webview:ready':
  this.syncFullState();
  return;
```

### 7. Data Validation

```javascript
// Validate incoming messages
function validateMessage(message) {
  if (!message || typeof message !== 'object') {
    console.error('Invalid message: not an object');
    return null;
  }

  if (!message.type || typeof message.type !== 'string') {
    console.error('Invalid message: missing type');
    return null;
  }

  return message;
}

// Validate context items
function validateContextItem(item) {
  const required = ['id', 'type', 'label'];
  for (const field of required) {
    if (!item[field]) {
      console.error(`Invalid context item: missing ${field}`);
      return null;
    }
  }

  const validTypes = ['file', 'selection', 'symbol', 'url', 'image'];
  if (!validTypes.includes(item.type)) {
    console.error(`Invalid context item type: ${item.type}`);
    return null;
  }

  return item;
}

// Sanitize user input
function sanitizeInput(input) {
  // Remove null bytes
  input = input.replace(/\0/g, '');

  // Limit length
  const MAX_LENGTH = 100000;
  if (input.length > MAX_LENGTH) {
    input = input.slice(0, MAX_LENGTH);
  }

  return input;
}
```

### 8. Special Input Handling

```javascript
// Handle paste of large content
input.addEventListener('paste', (e) => {
  const text = e.clipboardData.getData('text');

  if (text.length > 50000) {
    e.preventDefault();
    showWarning('Large paste detected. Consider adding as a file instead.');

    // Offer to add as context instead
    offerAddAsContext(text);
  }
});

// Handle drop of files
input.addEventListener('drop', (e) => {
  e.preventDefault();

  const files = Array.from(e.dataTransfer.files);
  if (files.length > 0) {
    // Add as context instead of pasting
    for (const file of files) {
      addFileAsContext(file);
    }
  }
});

// Handle special characters
function escapeForDisplay(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
```

### 9. Network Edge Cases

```javascript
// Handle slow network
const SLOW_NETWORK_THRESHOLD = 5000; // 5 seconds

function withSlowNetworkFeedback(promise, message = 'Taking longer than expected...') {
  let timer;

  const slowPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      showSlowNetworkIndicator(message);
    }, SLOW_NETWORK_THRESHOLD);
  });

  return Promise.race([
    promise.finally(() => {
      clearTimeout(timer);
      hideSlowNetworkIndicator();
    }),
    slowPromise,
  ]);
}

// Handle offline
window.addEventListener('offline', () => {
  showConnectionError('You appear to be offline. Some features may be unavailable.');
});

window.addEventListener('online', () => {
  hideConnectionError();
  // Retry pending operations
  retryPendingOperations();
});
```

### 10. Window/Panel Edge Cases

```javascript
// Handle panel resize
const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    handleResize(entry.contentRect);
  }
});
resizeObserver.observe(document.body);

function handleResize({ width, height }) {
  // Adjust layout for narrow panels
  if (width < 300) {
    document.body.classList.add('compact-mode');
  } else {
    document.body.classList.remove('compact-mode');
  }
}

// Handle visibility change (tab switch)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Refresh stale data
    refreshState();
  }
});
```

---

## Verification

### Success Criteria
- [ ] All empty states render correctly
- [ ] Long text truncates/wraps properly
- [ ] Large lists perform well
- [ ] Rapid actions handled safely
- [ ] Interrupted ops clean up
- [ ] Stale state detected and synced
- [ ] Invalid data handled gracefully
- [ ] Network issues handled
- [ ] Panel resizes correctly

### Edge Case Tests

| Test | Steps | Expected |
|------|-------|----------|
| Empty conversation | Start fresh | Empty state shown |
| 100+ messages | Load many | Scrolls smoothly |
| 200 char filename | Add context | Truncated |
| Rapid send | Click fast | Only one sent |
| Cancel mid-stream | Stop button | Cleans up |
| Reload webview | Developer reload | State restored |
| Paste 1MB text | Ctrl+V | Warning shown |
| Go offline | Disconnect | Banner shown |
| Narrow panel | Resize to 250px | Compact mode |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/
git checkout src/vs/workbench/contrib/qic/browser/*.ts
```

---

## Notes

- Test edge cases with real-world data
- Consider fuzzing inputs
- Log edge case encounters for analysis
- Add telemetry for unexpected states
- Document known limitations

