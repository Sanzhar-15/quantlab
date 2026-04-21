# Phase 0: Cleanup - Dead Code & Conflict Resolution

**Duration:** 1 week | **Priority:** Blocking

---

## Overview

Before implementing the new UI spec, we must clean up technical debt that will cause confusion and bugs. This phase removes dead code, resolves HTML duplication, and prepares the foundation.

---

## 1. Dead Code Removal

### 1.1 Remove Unused HTML Template

**File:** `src/vs/workbench/contrib/qic/browser/media/chat.html`

**Status:** DEAD CODE - Never loaded

**Evidence:** `qicPanel.ts:getWebviewHtml()` generates HTML inline (lines 426-597). The separate `chat.html` file is never referenced.

**Action:** DELETE entire file

**Differences from used HTML:**
| chat.html (dead) | qicPanel.ts (used) |
|------------------|-------------------|
| degradation-badge, lane-badge, replay-badge | connection-status, provider-select, cost-display |
| metrics-btn, audit-btn | context-btn |
| No empty-state | Has empty-state with quick actions |
| quota-bar above input | token-estimate in footer |

---

### 1.2 Remove Dead JavaScript References

**File:** `src/vs/workbench/contrib/qic/browser/media/chat.js`

**Lines 69-91** reference elements that don't exist in the actual HTML:

```javascript
// REMOVE - Elements don't exist:
const auditBtn = document.getElementById('audit-btn');           // NULL
const auditPanel = document.getElementById('audit-panel');       // NULL
const closeAuditBtn = document.getElementById('close-audit-btn'); // NULL
const auditFilter = document.getElementById('audit-filter');     // NULL
const auditList = document.getElementById('audit-list');         // NULL
const auditChainStatus = document.getElementById('audit-chain-status'); // NULL

const metricsBtn = document.getElementById('metrics-btn');       // NULL
const metricsPanel = document.getElementById('metrics-panel');   // NULL
const closeMetricsBtn = document.getElementById('close-metrics-btn'); // NULL
const metricErrorRate = document.getElementById('metric-error-rate'); // NULL
const metricLatency = document.getElementById('metric-latency'); // NULL
const metricMemory = document.getElementById('metric-memory');   // NULL
const metricProviders = document.getElementById('metric-providers'); // NULL

const replayModeSelect = document.getElementById('replay-mode-select'); // NULL
const replayRecordingCount = document.getElementById('replay-recording-count'); // NULL
const replayBadge = document.getElementById('replay-badge');     // NULL

const quotaText = document.getElementById('quota-text');         // NULL (different structure)
const quotaFill = document.getElementById('quota-fill');         // NULL (different structure)
```

**Also remove associated event handlers (lines 256-280):**
- `auditBtn.addEventListener('click', ...)`
- `closeAuditBtn.addEventListener('click', ...)`
- `auditFilter.addEventListener('change', ...)`
- `metricsBtn.addEventListener('click', ...)`
- `closeMetricsBtn.addEventListener('click', ...)`
- `replayModeSelect.addEventListener('change', ...)`

**Also update `closeAllPanels()` function (lines 282-288):**
```javascript
// BEFORE:
function closeAllPanels() {
    if (checkpointPanel) { checkpointPanel.style.display = 'none'; }
    if (settingsPanel) { settingsPanel.style.display = 'none'; }
    if (auditPanel) { auditPanel.style.display = 'none'; }     // REMOVE
    if (metricsPanel) { metricsPanel.style.display = 'none'; } // REMOVE
}

// AFTER:
function closeAllPanels() {
    if (checkpointPanel) { checkpointPanel.style.display = 'none'; }
    if (settingsPanel) { settingsPanel.style.display = 'none'; }
    if (contextPanel) { contextPanel.style.display = 'none'; }
}
```

---

### 1.3 Remove Dead CSS

**File:** `src/vs/workbench/contrib/qic/browser/media/chat.css`

Remove styles for non-existent elements:

```css
/* REMOVE - These elements don't exist: */
.qic-audit-panel { ... }
.qic-audit-list { ... }
.qic-audit-filters { ... }
.qic-audit-entry { ... }
.qic-chain-status { ... }

.qic-metrics-panel { ... }
.qic-metrics-content { ... }
.qic-metric-row { ... }
.qic-metric-value { ... }

.qic-replay-section { ... }
.qic-replay-count { ... }

.qic-badge-lane { ... }
.qic-badge-replay { ... }

.qic-quota-bar { ... }  /* Different structure in actual HTML */
.qic-quota-text { ... }
.qic-quota-meter { ... }
.qic-quota-fill { ... }
```

---

### 1.4 Remove Dead Message Protocol Types

**File:** `src/vs/workbench/contrib/qic/common/ui/messageProtocol.ts`

These message types reference UI that doesn't exist or will be replaced:

```typescript
// AUDIT - Keep but flag for migration:
| { type: 'audit-log'; entries: AuditLogEntry[]; chainValid: boolean }
| { type: 'metrics-update'; metrics: MetricsData }
| { type: 'replay-status'; active: boolean; mode: 'off' | 'strict' | 'best-effort' | 'fallback'; recordingCount: number }

// The webview never sends these because the UI doesn't exist:
| { type: 'request-audit-log'; filter?: string }
| { type: 'request-metrics' }
| { type: 'set-replay-mode'; mode: 'off' | 'strict' | 'best-effort' | 'fallback'; recordingPath?: string }
```

**Decision:** Keep for now, mark as deprecated. Will be replaced in Protocol phase.

---

## 2. Conflict Resolution

### 2.1 HTML Source Consolidation

**Problem:** Two different HTML structures exist:
1. `qicPanel.ts:getWebviewHtml()` - USED
2. `chat.html` - UNUSED

**Resolution:** After deleting `chat.html`, refactor `getWebviewHtml()` to load from a template file for maintainability.

**New structure:**
```
src/vs/workbench/contrib/qic/browser/media/
├── chat.css          # Webview styles
├── chat.js           # Webview logic
├── chat.template.ts  # NEW: HTML template as TypeScript
├── markdownRenderer.js
└── qic.css           # Host-side styles (keep minimal)
```

**chat.template.ts:**
```typescript
export function getChatTemplate(params: {
    nonce: string;
    styleNonce: string;
    chatCssUri: string;
    markdownRendererUri: string;
    chatJsUri: string;
    cspSource: string;
}): string {
    return `<!DOCTYPE html>
<html lang="en">
...
</html>`;
}
```

---

### 2.2 Status Bar Behavior

**Current:** Status bar always visible regardless of panel state.
**Spec:** Status bar shows connection status, quota, checkpoint count.

**Conflict:** User reported "elements lingering when QIC closed" - this is the status bar.

**Resolution Options:**

| Option | Pros | Cons |
|--------|------|------|
| A: Keep always visible | Consistent, shows system status | User complaint |
| B: Hide when panel closed | Clean UI | Loses status visibility |
| C: Conditional based on setting | User choice | Complexity |

**Recommendation:** Option A (keep visible) - The spec explicitly defines status bar items. The "lingering" complaint may be about something else. Verify with user.

---

### 2.3 Header Structure Alignment

**Current header (qicPanel.ts:453-472):**
```html
<div class="qic-header-left">
    <div id="connection-status">...</div>
    <select id="provider-select">...</select>
    <span id="cost-display">$0.0000</span>
</div>
<div class="qic-header-right">
    <button id="context-btn">📄</button>
    <button id="new-chat-btn">+</button>
    <button id="checkpoint-btn">💾</button>
    <button id="settings-btn">⚙️</button>
</div>
```

**Spec header:**
```
[◇] QIC                    [⋮]   [+]
```

**Gap Analysis:**
| Current Element | Spec Equivalent | Action |
|-----------------|-----------------|--------|
| connection-status | Logo click → Status quick pick | REPLACE |
| provider-select | Menu → "Switch provider" | REMOVE from header |
| cost-display | Status bar quota item | REMOVE from header |
| context-btn | Context drawer toggle (▼) | MOVE to context row |
| new-chat-btn | [+] button | KEEP |
| checkpoint-btn | Menu → "View checkpoints" | REMOVE from header |
| settings-btn | Menu → "Settings" | REMOVE from header |

**New header (per spec):**
```html
<div class="qic-header">
    <div class="qic-header-left">
        <button id="status-btn" class="qic-logo-btn" title="Status">◇</button>
        <span class="qic-title">QIC</span>
    </div>
    <div class="qic-header-right">
        <button id="menu-btn" class="qic-header-btn" title="Menu">⋮</button>
        <button id="new-chat-btn" class="qic-header-btn" title="New chat">+</button>
    </div>
</div>
```

---

## 3. Cleanup Checklist

### Files to DELETE:
- [ ] `src/vs/workbench/contrib/qic/browser/media/chat.html`

### Files to MODIFY:

**chat.js:**
- [ ] Remove dead element references (lines 69-91)
- [ ] Remove dead event handlers (lines 256-280)
- [ ] Update `closeAllPanels()` function
- [ ] Remove quota bar handlers

**chat.css:**
- [ ] Remove `.qic-audit-*` styles
- [ ] Remove `.qic-metrics-*` styles
- [ ] Remove `.qic-replay-*` styles
- [ ] Remove `.qic-badge-lane`, `.qic-badge-replay`
- [ ] Remove `.qic-quota-bar`, `.qic-quota-meter`, `.qic-quota-fill`

**qicPanel.ts:**
- [ ] Extract HTML to template file
- [ ] Simplify header structure
- [ ] Remove provider-select, cost-display, excess buttons

**messageProtocol.ts:**
- [ ] Add deprecation comments to unused types
- [ ] No deletions yet (backend may use them)

---

## 4. Testing After Cleanup

### Smoke Tests:
1. Panel opens with Ctrl+Shift+Q
2. Panel renders without JS errors (check DevTools)
3. Can send a message
4. Can receive streaming response
5. File references (`[[path]]`) still work
6. Settings panel still opens
7. Checkpoint panel still opens
8. Status bar still shows

### Regression Risks:
- Removing quota display from header (ensure it's visible elsewhere)
- Removing provider select from header (ensure it's in menu)
- Context panel functionality (ensure it's not broken)

---

## 5. Git Strategy

```bash
# Single cleanup commit
git add -A
git commit -m "chore(qic): remove dead UI code and resolve HTML duplication

- Delete unused chat.html template
- Remove dead JS references (audit, metrics, replay, quota elements)
- Remove dead CSS for non-existent elements
- Simplify header structure
- Prepare for spec v1.4 implementation

BREAKING: Removes non-functional UI elements

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```
