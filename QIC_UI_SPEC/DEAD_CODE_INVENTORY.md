# Dead Code Inventory

**Generated:** Phase 0, Prompt 00-01
**Status:** Audit Complete

---

## Executive Summary

The QIC webview has significant dead code due to a **dual HTML source** issue:
- `chat.html` (standalone file) is **NOT USED**
- `qicPanel.ts` generates HTML **inline** via `getWebviewHtml()` (lines 416-597)
- `chat.js` references elements from `chat.html` that don't exist in the inline HTML
- `chat.css` has rules for non-existent elements

**Impact:** ~40% of chat.js code is dead, ~30% of chat.css rules are dead.

---

## Files to Delete

| File | Reason | Action |
|------|--------|--------|
| `src/vs/workbench/contrib/qic/browser/media/chat.html` | Not loaded - HTML is inline in qicPanel.ts | DELETE |

---

## Dead HTML Elements

The following elements exist in `chat.html` but NOT in the actual inline HTML in `qicPanel.ts`:

| Element ID | chat.html Line | Purpose | Status |
|------------|----------------|---------|--------|
| `degradation-badge` | 34 | Shows degradation level badge | DEAD |
| `lane-badge` | 35 | Shows current lane (chat-ask, etc.) | DEAD |
| `replay-badge` | 36 | Indicates replay mode active | DEAD |
| `metrics-btn` | 39 | Opens metrics panel | DEAD |
| `audit-btn` | 40 | Opens audit log panel | DEAD |
| `audit-panel` | 105-120 | Entire audit log panel | DEAD |
| `audit-filter` | 111 | Audit log filter dropdown | DEAD |
| `audit-list` | 119 | Audit log entries container | DEAD |
| `audit-chain-status` | 117 | Hash chain integrity indicator | DEAD |
| `metrics-panel` | 121-154 | Entire metrics panel | DEAD |
| `metric-error-rate` | 129 | Error rate metric display | DEAD |
| `metric-latency` | 133 | Latency metric display | DEAD |
| `metric-memory` | 137 | Memory pressure display | DEAD |
| `metric-providers` | 141 | Providers available display | DEAD |
| `replay-mode-select` | 146 | Replay mode dropdown | DEAD |
| `replay-recording-count` | 152 | Recording count display | DEAD |
| `quota-text` | 157 | Token quota text | DEAD* |
| `quota-meter` | 158 | Quota progress bar | DEAD* |
| `quota-fill` | 158 | Quota fill element | DEAD* |

*Note: Quota elements exist in inline HTML but at different location (inside input-area, not header).

---

## Dead JavaScript References

The following DOM references in `chat.js` point to non-existent elements:

| Reference | File | Line | Missing Element | Impact |
|-----------|------|------|-----------------|--------|
| `document.getElementById('degradation-badge')` | chat.js | ~696 | `degradation-badge` | Function `updateDegradationStatus()` no-ops |
| `document.getElementById('lane-badge')` | chat.js | ~746 | `lane-badge` | Function `updateStatusDisplay()` partially fails |
| `document.getElementById('replay-badge')` | chat.js | 87 | `replay-badge` | Function `updateReplayStatus()` no-ops |
| `document.getElementById('metrics-btn')` | chat.js | 78 | `metrics-btn` | Metrics button handler never attached |
| `document.getElementById('audit-btn')` | chat.js | 70 | `audit-btn` | Audit button handler never attached |
| `document.getElementById('audit-panel')` | chat.js | 71 | `audit-panel` | Function `renderAuditLog()` no-ops |
| `document.getElementById('close-audit-btn')` | chat.js | 72 | `close-audit-btn` | Handler never attached |
| `document.getElementById('audit-filter')` | chat.js | 73 | `audit-filter` | Handler never attached |
| `document.getElementById('audit-list')` | chat.js | 74 | `audit-list` | Audit list never renders |
| `document.getElementById('audit-chain-status')` | chat.js | 75 | `audit-chain-status` | Chain status never shown |
| `document.getElementById('metrics-panel')` | chat.js | 79 | `metrics-panel` | Metrics panel never shows |
| `document.getElementById('close-metrics-btn')` | chat.js | 80 | `close-metrics-btn` | Handler never attached |
| `document.getElementById('metric-error-rate')` | chat.js | 81 | `metric-error-rate` | Metric never updates |
| `document.getElementById('metric-latency')` | chat.js | 82 | `metric-latency` | Metric never updates |
| `document.getElementById('metric-memory')` | chat.js | 83 | `metric-memory` | Metric never updates |
| `document.getElementById('metric-providers')` | chat.js | 84 | `metric-providers` | Metric never updates |
| `document.getElementById('replay-mode-select')` | chat.js | 85 | `replay-mode-select` | Handler never attached |
| `document.getElementById('replay-recording-count')` | chat.js | 86 | `replay-recording-count` | Count never shown |

### Dead Functions (due to missing elements)

| Function | Lines | Reason |
|----------|-------|--------|
| `updateDegradationStatus()` | 692-711 | `degradationBadge` is null |
| `updateStatusDisplay()` (partial) | 745-753 | `laneBadge` is null |
| `renderAuditLog()` | 818-847 | `auditList` is null |
| `updateMetricsDisplay()` | 851-870 | All metric elements null |
| `updateReplayStatus()` | 874-885 | `replayBadge` is null |
| `closeAllPanels()` (partial) | 1093-1099 | References to audit/metrics panels no-op |

---

## Dead CSS Rules

The following CSS rules in `chat.css` target non-existent elements:

| Selector | File | Line | Reason |
|----------|------|------|--------|
| `.qic-badge-reduced` | chat.css | 97 | Degradation badge element missing |
| `.qic-badge-limited` | chat.css | 98 | Degradation badge element missing |
| `.qic-badge-local` | chat.css | 99 | Degradation badge element missing |
| `.qic-badge-emergency` | chat.css | 100 | Degradation badge element missing |
| `.qic-badge-lane` | chat.css | 101 | Lane badge element missing |
| `.qic-badge-replay` | chat.css | 551-554 | Replay badge element missing |
| `.qic-audit-panel` | chat.css | 418-433 | Audit panel element missing |
| `.qic-audit-filters` | chat.css | 435-451 | Audit filter element missing |
| `.qic-audit-list` | chat.css | 461-466 | Audit list element missing |
| `.qic-audit-empty` | chat.css | 468-473 | Audit empty state missing |
| `.qic-audit-entry` | chat.css | 475-484 | Audit entry styling unused |
| `.qic-audit-*` (all) | chat.css | 485-490 | All audit sub-selectors unused |
| `.qic-chain-status` | chat.css | 453-456 | Chain status element missing |
| `.qic-chain-valid` | chat.css | 458 | Chain valid state missing |
| `.qic-chain-invalid` | chat.css | 459 | Chain invalid state missing |
| `.qic-metrics-panel` | chat.css | 492-504 | Metrics panel element missing |
| `.qic-metrics-content` | chat.css | 506-509 | Metrics content missing |
| `.qic-metric-row` | chat.css | 511-516 | Metric row styling unused |
| `.qic-metric-value` | chat.css | 518-521 | Metric value styling unused |
| `.qic-metric-normal` | chat.css | 523 | Metric state unused |
| `.qic-metric-warning` | chat.css | 524 | Metric state unused |
| `.qic-metric-error` | chat.css | 525 | Metric state unused |
| `.qic-replay-section` | chat.css | 527-547 | Replay section unused |
| `.qic-replay-count` | chat.css | 542-546 | Replay count unused |

---

## Lifecycle Issues

| Issue | File | Line | Fix |
|-------|------|------|-----|
| ~~Status bar persists after panel closure~~ | - | - | **NOT AN ISSUE** - Status bar correctly persists (workbench contribution lifecycle) |

**Note:** The status bar is managed by `QicActivation` which is a workbench contribution. It lives for the window lifetime and is properly disposed via `DisposableStore`. This is correct behavior - the status bar should show QIC status regardless of whether the chat panel is open.

---

## Synchronization Issue

The core problem is that **two HTML sources exist** but only one is used:

1. **`chat.html`** - Standalone file with full feature set (degradation badges, audit panel, metrics panel, replay controls)
2. **`qicPanel.ts:getWebviewHtml()`** - Inline HTML with reduced feature set (no degradation badges, no audit/metrics panels)

### Why This Happened

The inline HTML was likely created for faster iteration, but chat.html was never removed. Meanwhile, chat.js and chat.css were written to work with chat.html's full feature set.

### Resolution Options

1. **OPTION A (Recommended):** Delete chat.html, clean up chat.js/chat.css to match inline HTML
2. **OPTION B:** Update inline HTML to match chat.html, keep all features

The implementation prompts follow **Option A** - remove dead code and use the inline HTML as the source of truth.

---

## Statistics

| Category | Total Items | Dead Items | Dead % |
|----------|-------------|------------|--------|
| HTML Elements | ~45 | 18 | 40% |
| JS References | ~90 | 18 | 20% |
| JS Functions | ~35 | 6 | 17% |
| CSS Rules | ~180 | 35 | 19% |

---

## Next Steps

1. **00-02-remove-dead-html.md** - Delete `chat.html`
2. **00-03-remove-dead-javascript.md** - Remove dead DOM references and functions from `chat.js`
3. **00-04-remove-dead-css.md** - Remove dead CSS rules from `chat.css`
4. **00-05-fix-status-bar-persistence.md** - Already correct, verify only
5. **00-06-cleanup-verification.md** - Verify all dead code removed
