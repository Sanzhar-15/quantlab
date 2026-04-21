# Spec Amendments: Codebase Features Not in Spec

**Purpose:** Document features that exist in the codebase but were not included in the UI spec because the spec author didn't have access to the full codebase.

---

## Overview

The UI spec v1.4 is comprehensive but was created without access to the Quantlab codebase. This document identifies existing features that need UI representation but weren't specified.

---

## 1. Lane System

### What Exists

The codebase has a sophisticated "lane" system for different operational modes:

**File:** `src/vs/workbench/contrib/qic/common/canonical/prompts.ts`

```typescript
export const PROMPT_TEMPLATES: Record<string, string> = {
    'completion': '...',      // Code completion
    'chat-ask': '...',        // Standard Q&A
    'chat-gather': '...',     // Context gathering
    'chat-plan': '...',       // Planning mode
    'chat-act': '...',        // Execution mode
    'repair': '...',          // Error fixing
    'fast-apply': '...',      // Quick edits
    'summarize': '...',       // Context summarization
};
```

### UI Requirement

The current lane should be visible to users and possibly switchable:

```
┌─────────────────────────────────────────┐
│ [◇] QIC                        [Ask ▾]  │
│                                         │
│              ▾ dropdown:                │
│              ○ Ask (Q&A)                │
│              ○ Plan                     │
│              ○ Code (execute)           │
└─────────────────────────────────────────┘
```

### Recommendation

Add lane indicator to header or as a mode toggle. Could be:
- Badge next to title: `QIC [Ask]`
- Dropdown in header for power users
- Or automatic (no UI) - system chooses based on request

**Decision needed:** Expose lane selection to users or keep automatic?

---

## 2. Tool Call Display

### What Exists

The codebase has message types for tool calls:

**File:** `src/vs/workbench/contrib/qic/common/ui/messageProtocol.ts`

```typescript
| { type: 'tool-call-started'; toolCallId: string; toolName: string; args: Record<string, unknown> }
| { type: 'tool-call-result'; toolCallId: string; content: string; isError: boolean }
```

The spec doesn't define how tool calls should be displayed in the conversation.

### UI Requirement

Tool calls should be visible in the conversation flow:

```
┌─────────────────────────────────────────┐
│ QIC · 10:24 AM                          │
│ Let me check that file...               │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ ⚙ read_file                   ✓     │ │
│ │ risk_metrics.py                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ The function calculates...              │
└─────────────────────────────────────────┘
```

### Recommendation

Add tool call cards to message rendering:

```html
<div class="qic-tool-call" data-status="complete">
    <div class="qic-tool-header">
        <span class="qic-tool-icon">⚙</span>
        <span class="qic-tool-name">read_file</span>
        <span class="qic-tool-status">✓</span>
    </div>
    <div class="qic-tool-args">
        <code>risk_metrics.py</code>
    </div>
    <details class="qic-tool-result">
        <summary>View result</summary>
        <pre>...</pre>
    </details>
</div>
```

---

## 3. File Reference Syntax

### What Exists

Recently implemented `[[path]]` syntax for clickable file references:

**File:** `src/vs/workbench/contrib/qic/browser/media/markdownRenderer.js`

```javascript
// Process [[path]] into clickable spans
// Also auto-detects common file patterns as fallback
function processFileReferences(html) { ... }
```

### UI Already Implemented

```css
.qic-file-ref {
    color: #e67e22;  /* Orange for files */
    cursor: pointer;
    border-bottom: 1px dotted currentColor;
}
.qic-folder-ref {
    color: #3498db;  /* Blue for folders */
}
```

### Spec Integration

This should be documented in the spec under "Conversation Patterns":

```
## File References

File and folder names in assistant responses are clickable:
- **Files**: Orange, opens in editor
- **Folders**: Blue, reveals in explorer

Syntax: [[filename.py]] or [[folder/]]
Auto-detection: Common extensions (.py, .csv, etc.) are auto-linked.
```

---

## 4. Code Completion Status

### What Exists

Separate code completion engine with its own state:

**File:** `src/vs/workbench/contrib/qic/browser/qic.contribution.ts`

```typescript
const completionEngine = new CompletionEngine(...);
const qicProvider = new QicInlineCompletionProvider(completionEngine, qualitySignalService);
```

### UI Requirement

Completion status should be visible, especially when degraded:

```
Status Bar: │ QIC ● │ Completions: On │
         or │ QIC ● │ Completions: Off (degraded) │
```

### Recommendation

Add completion status to status bar tooltip or as separate indicator when disabled:

```typescript
interface StatusBarInfo {
    // ... existing
    completionsEnabled: boolean;
    completionsDegraded: boolean;
}
```

---

## 5. Quality Signal Service

### What Exists

User feedback collection system:

**File:** (referenced in qic.contribution.ts)

```typescript
const qualitySignalService = new QualitySignalService(...);
```

### UI Requirement

Ability to rate responses or flag issues:

```
┌─────────────────────────────────────────┐
│ QIC · 10:24 AM                    [⟲]   │
│ The Sharpe ratio is calculated by...    │
│                                         │
│ Was this helpful?  [👍] [👎]            │
└─────────────────────────────────────────┘
```

### Recommendation

Add optional feedback buttons to assistant messages:

```html
<div class="qic-feedback" aria-label="Rate this response">
    <button class="qic-feedback-btn" data-rating="positive" title="Helpful">👍</button>
    <button class="qic-feedback-btn" data-rating="negative" title="Not helpful">👎</button>
</div>
```

Could be opt-in via settings: `qic.showFeedbackButtons: true`

---

## 6. Consent Store

### What Exists

Multi-boundary consent management:

**File:** (referenced throughout)

```typescript
const consentStore = new ConsentStore(...);
// Manages: llm, embeddings, telemetry consents
```

### UI Currently

First-run consent flow exists but spec doesn't detail it.

### Recommendation

The first-run flow should match spec section 12, but add:
- Consent for code completion (separate from chat)
- Consent for code search/indexing
- Clear explanation of what each consent enables

---

## 7. Data Tier / Privacy Modes

### What Exists

**File:** `src/vs/workbench/contrib/qic/common/constants.ts`

```typescript
export type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';
```

### UI Requirement

Privacy mode selection in first-run and settings:

```
┌─────────────────────────────────────────┐
│ Privacy Level                           │
│ ○ Private        - No data shared       │
│ ○ Anonymous      - Usage metrics only   │
│ ● Contributor    - Help improve QIC     │
└─────────────────────────────────────────┘
```

### Recommendation

Add to first-run flow and settings. Map to spec's "Private Tier Features" table.

---

## 8. Strategy File Detection

### What Exists

**File:** `src/vs/workbench/contrib/qic/common/constants.ts`

```typescript
'qic.strategyFolders': ['strategies/', 'live/'],
'qic.strategyConfirmation': true,
```

### Spec Coverage

Spec section 7 mentions Strategy Warning but doesn't detail detection.

### Recommendation

Document strategy file detection patterns:
- Files in `strategies/` or `live/` folders
- Files with `strategy` in name
- Custom patterns via settings

---

## 9. Replay System

### What Exists

Testing/debugging infrastructure (currently dead UI):

**File:** `src/vs/workbench/contrib/qic/common/ui/messageProtocol.ts`

```typescript
| { type: 'replay-status'; active: boolean; mode: 'off' | 'strict' | 'best-effort' | 'fallback'; recordingCount: number }
| { type: 'set-replay-mode'; mode: 'off' | 'strict' | 'best-effort' | 'fallback'; recordingPath?: string }
```

### Recommendation

Either:
1. **Remove** - If not needed for production
2. **Developer mode only** - Add to a hidden dev panel

Suggest: Keep for testing but don't expose in main UI.

---

## 10. Indexer Status

### What Exists

Background code indexing for search:

**File:** `src/vs/workbench/contrib/qic/browser/qic.contribution.ts`

```typescript
this.step('indexing', async () => {
    await indexer.indexWorkspace(workspacePath);
}).catch(() => {
    this.qicService.addDegradedFeature('code-search');
});
```

### UI Requirement

Show indexing status, especially when degraded:

```
Status Quick Pick:
● Connected — QIC Cloud · 143ms
Code Search: Indexed (12,345 files)
```

Or if degraded:
```
⚠ Code Search: Unavailable (indexing failed)
```

### Recommendation

Add to status quick pick and/or degradation banner.

---

## 11. Connection Mode

### What Exists

**File:** `src/vs/workbench/contrib/qic/common/constants.ts`

```typescript
export type ConnectionMode = 'cloud' | 'byok' | 'local';
```

### Spec Coverage

Spec mentions provider (qic-cloud, ollama, offline) but not BYOK (Bring Your Own Key).

### Recommendation

Add BYOK option to provider quick pick:
```
● QIC Cloud              Connected
○ Your API Key (BYOK)    Configured
○ Ollama (llama3:8b)     Available
○ Offline Mode
```

---

## Summary: Required Spec Additions

| Feature | Priority | UI Location |
|---------|----------|-------------|
| Tool call display | P0 | Conversation messages |
| File references | P0 | Already implemented |
| Lane indicator | P1 | Header or automatic |
| Completion status | P1 | Status bar |
| Feedback buttons | P2 | Message actions |
| Data tier selection | P1 | First-run, settings |
| Indexer status | P1 | Status quick pick |
| BYOK mode | P1 | Provider quick pick |
| Replay system | P3 | Dev mode only |
