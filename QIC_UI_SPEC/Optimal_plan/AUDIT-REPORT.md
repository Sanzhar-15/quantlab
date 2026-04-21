# Implementation Plan Audit Report

**Auditor:** Claude Opus 4.5
**Date:** February 2026
**Version:** 1.1 (Corrected after backend verification)
**Verdict:** ⚠️ **GAPS IDENTIFIED - PLAN REQUIRES AMENDMENTS**

---

## Executive Summary

The implementation plan is **structurally sound** but has **13 gaps** that must be addressed before it can produce a beautiful, functional, complete, and optimal UI. Most gaps relate to **backend integration details** that weren't fully captured.

**Corrections in v1.1:**
- GAP-04: Removed (backend handles tool call streaming internally)
- GAP-05: Downgraded from Critical to Moderate (simpler webview role)
- Added GAP-16, GAP-17: Additional gaps discovered during verification

| Category | Status | Gaps Found |
|----------|--------|------------|
| Visual Design | ✅ Good | 1 minor |
| State Management | ⚠️ Issues | 2 critical |
| Backend Integration | ⚠️ Issues | 4 critical |
| Message Protocol | ⚠️ Issues | 2 critical |
| Feature Completeness | ⚠️ Issues | 2 moderate |
| Robustness | ⚠️ Issues | 2 moderate (new) |
| **Total** | | **13 gaps** |

---

## Critical Gaps (Must Fix)

### GAP-01: Agent State Machine Not Integrated

**Severity:** 🔴 Critical

**Problem:** The plan conflates two different state concepts:

| Plan Has | Backend Has |
|----------|-------------|
| `ConnectionState.status` | `QicState` (service lifecycle): 'initializing' \| 'ready' \| 'degraded' \| 'error' |
| (same field) | `AgentState` (conversation): 'idle' \| 'processing' \| 'waiting_approval' \| 'error' \| 'suspended' |

The backend has **two separate state machines**:
1. **Service state** - Is QIC ready to use?
2. **Agent state** - What is the conversation doing?

**Fix Required:**
```typescript
export interface QICState {
    // Service lifecycle
    serviceStatus: 'initializing' | 'ready' | 'degraded' | 'error';

    // Conversation state machine
    agentState: 'idle' | 'processing' | 'waiting_approval' | 'error' | 'suspended';

    // Connection info (separate)
    connection: {
        provider: string;
        latencyMs: number;
        degradationLevel: 0 | 1 | 2 | 3 | 4;
    };
}
```

**UI Impact:** Status indicator must show BOTH states:
- Service status → Status bar color
- Agent state → Streaming indicator, input disabled state

---

### GAP-02: Missing State Timeout Handling

**Severity:** 🔴 Critical

**Problem:** The backend has state timeouts (Audit VII-DS2):

```typescript
const STATE_TIMEOUTS = {
    'idle->processing': 120_000,      // 2 min
    'processing->waiting_approval': 300_000,  // 5 min
    'processing->idle': 600_000,      // 10 min
};
```

The plan doesn't handle:
- What happens when a state times out?
- How to show timeout warnings?
- How to trigger recovery?

**Fix Required:** Add to `04-PANEL-STRUCTURE.md`:
- Timeout warning banner (e.g., "Request taking longer than expected...")
- Auto-recovery attempt after timeout
- Manual recovery button

---

### GAP-03: Streaming Token Buffering Not Specified

**Severity:** 🔴 Critical

**Problem:** The plan says "stream tokens" but doesn't specify:
- How to buffer tokens for smooth rendering?
- How to handle rapid token bursts?
- When to trigger scroll-to-bottom?
- How to render markdown incrementally?

**Backend sends:** Individual tokens via `streamChatToken(token: string)`

**Fix Required:** Add streaming implementation detail:

```javascript
// Token buffer with debounced rendering
let tokenBuffer = '';
let renderTimeout = null;

function handleStreamToken(token) {
    tokenBuffer += token;

    // Debounce rendering for performance
    if (!renderTimeout) {
        renderTimeout = setTimeout(() => {
            renderBufferedTokens();
            renderTimeout = null;
        }, 16); // ~60fps
    }
}

function renderBufferedTokens() {
    // Append to streaming element
    streamElement.textContent += tokenBuffer;
    tokenBuffer = '';

    // Scroll if near bottom
    if (isNearBottom()) {
        scrollToBottom();
    }

    // Re-render markdown periodically (not per token)
    scheduleMarkdownRender();
}
```

---

### GAP-04: ~~Tool Call Streaming Not Integrated~~ **CORRECTED**

**Severity:** 🟢 Not a Gap (Original assessment was incorrect)

**Original Problem:** I stated the UI needs to handle tool_call_start/delta/end streaming.

**Correction:** After verifying `agentOrchestrator.ts`, the orchestrator **processes tool call streaming internally**:

```typescript
// In agentOrchestrator.ts - processStreamChunk()
case 'tool_call_start':
    activeToolCalls.set(chunk.id, { name: chunk.name, argChunks: [] });
    break;
case 'tool_call_delta':
    activeToolCalls.get(chunk.id)?.argChunks.push(chunk.argumentsDelta);
    break;
case 'tool_call_end':
    // Parses args and adds to toolCalls array
    toolCalls.push({ id: chunk.id, name: tc.name, arguments: args });
    break;
```

The UI receives **complete tool calls** via:
- `tool-call-started` - When tool execution begins (after streaming complete)
- `tool-call-result` - When tool execution finishes

**No Fix Required:** The plan's `ToolCallInfo` handling of complete tool calls is correct. The plan should just ensure proper handling of these two message types, which it already covers.

---

### GAP-05: ~~ApprovalToken Security Flow Not Detailed~~ **CORRECTED**

**Severity:** 🟡 Moderate (Downgraded from Critical - simpler than originally assessed)

**Original Problem:** I stated the webview needs to generate ApprovalToken with hashing.

**Correction:** After verifying `uiService.ts`, the **host generates the hash**, not the webview:

```typescript
// In uiService.ts - showDiffPreview()
async showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null> {
    const hash = sha256Hex(JSON.stringify(editScript));  // HOST generates hash
    this.postMessage({
        type: 'diff-preview',
        editScriptHash: hash,  // Sends hash TO webview
        previewHtml: this.buildDiffHtml(editScript),
        filePaths
    });
    return new Promise((resolve) => {
        this.pendingDiffDialogs.set(hash, { resolve, reject });
    });
}
```

The webview's role is simple - return the hash with approval decision:

```javascript
// Webview - When user clicks "Accept" or "Reject"
function respondToDiff(editScriptHash, approved) {
    vscode.postMessage({
        type: 'approve-diff',
        editScriptHash: editScriptHash,  // Echo back the hash
        approved: approved
    });
}
```

**Remaining Gap:** The plan should document that:
1. Host generates and sends `editScriptHash` with diff preview
2. Webview echoes hash back with approval decision
3. Host resolves pending Promise and generates ApprovalToken internally

---

### GAP-06: Permission Dialog Response Flow Incomplete

**Severity:** 🔴 Critical

**Problem:** The backend's permission flow:

```
Tool needs permission → PermissionManager.check() →
  If not granted → uiService.showPermissionDialog() →
    Returns Promise<PermissionCheckResult> →
      { granted: boolean, scope: 'once' | 'session' | 'always', reason?: string }
```

The plan has permission cards but doesn't show how the Promise is resolved:

**Fix Required:**

```javascript
// Host side - waiting for response
const pendingPermissionDialogs = new Map(); // requestId -> { resolve, reject }

async function showPermissionDialog(tool, context) {
    const requestId = generateId();

    return new Promise((resolve, reject) => {
        pendingPermissionDialogs.set(requestId, { resolve, reject });

        postMessage({
            type: 'permission-request',
            requestId,
            toolName: tool,
            description: formatToolDescription(tool, context)
        });
    });
}

// When webview responds
function handlePermissionResponse(msg) {
    const pending = pendingPermissionDialogs.get(msg.requestId);
    if (pending) {
        pending.resolve({
            granted: msg.granted,
            scope: msg.scope,
            reason: msg.granted ? undefined : 'User denied'
        });
        pendingPermissionDialogs.delete(msg.requestId);
    }
}
```

---

### GAP-07: Error Code Display Strategy Missing

**Severity:** 🟡 Moderate

**Problem:** The backend has 24+ error codes with specific meanings:
- QIC-T001 through QIC-T005 (Tool errors)
- QIC-P001 through QIC-P006 (Provider errors)
- QIC-N001 through QIC-N004 (Network errors)
- etc.

The plan doesn't specify how to display these.

**Fix Required:** Add error display strategy:

| Error Type | Display Method |
|------------|----------------|
| Recoverable (warning) | Toast with retry button |
| Fatal (error) | Inline error card in conversation |
| Info (QIC-Y002 cancelled) | Status text, no card |
| Auth (QIC-P006) | Modal with "Re-authenticate" button |
| Rate limit (QIC-P005) | Banner with countdown |

```html
<div class="qic-error-card" data-code="QIC-T002" data-severity="error">
    <div class="qic-error-header">
        <span class="qic-error-icon">⚠</span>
        <span class="qic-error-title">Tool Execution Failed</span>
        <span class="qic-error-code">QIC-T002</span>
    </div>
    <div class="qic-error-message">
        The read_file tool encountered an error: File not found.
    </div>
    <div class="qic-error-actions">
        <button data-action="retry">Retry</button>
        <button data-action="report">Report Issue</button>
    </div>
</div>
```

---

### GAP-08: Conversation Persistence Not Addressed

**Severity:** 🟡 Moderate

**Problem:** The backend has:

```typescript
class ConversationState {
    async persist(db, conversationId): Promise<void>
    static async restore(db, conversationId): Promise<ConversationState | null>
}
```

The plan's history quick pick shows conversations but doesn't specify:
- When conversations are auto-saved
- How to load a conversation
- What happens to current conversation when switching

**Fix Required:** Add to `07-NATIVE-INTEGRATION.md`:

```typescript
// Load conversation from history
async function loadConversation(conversationId: string) {
    // 1. Prompt to save current if modified
    if (currentConversationModified) {
        const save = await confirmSaveCurrentConversation();
        if (save) await saveCurrentConversation();
    }

    // 2. Load from storage
    const conversation = await ConversationState.restore(db, conversationId);

    // 3. Update state and notify webview
    stateService.setConversation(
        conversation.id,
        conversation.title,
        conversation.getMessages()
    );

    // 4. Webview receives state:patch and re-renders
}
```

---

### GAP-09: Auto-Summarization Trigger Not Handled

**Severity:** 🟡 Moderate

**Problem:** The backend auto-summarizes at 80% budget:

```typescript
// In AgentOrchestrator.processMessage()
const TOKEN_BUDGET_SUMMARIZE_THRESHOLD = 0.8;
if (tokenUsage > budget * TOKEN_BUDGET_SUMMARIZE_THRESHOLD) {
    await this.triggerSummarization();
}
```

The plan doesn't specify:
- How to show summarization is happening
- What the user sees when history is compressed
- How to preserve important context markers

**Fix Required:** Add summarization UX:

```
┌─────────────────────────────────────────┐
│ ⚡ Context optimized                    │
│ Earlier messages were summarized to     │
│ free up context for your request.       │
│ [View summary] [Dismiss]                │
└─────────────────────────────────────────┘
```

---

### GAP-10: Cancel Semantics Not Fully Specified

**Severity:** 🟡 Moderate

**Problem:** The spec mentions cancel scenarios but the plan doesn't detail:

| Scenario | Backend Behavior | UI Should Show |
|----------|------------------|----------------|
| Pre-stream cancel | No message | Nothing, clear input |
| Mid-stream cancel | Partial preserved | "[Cancelled]" + "Retry" button |
| Pending tool cancel | Tool aborted | Tool card shows "Cancelled" |
| Permission cancel | Returns to previous | Permission card hidden |

**Fix Required:** Add cancel handling to `04-PANEL-STRUCTURE.md`.

---

### GAP-11: Context Budget Per-Lane Not Reflected

**Severity:** 🟡 Moderate

**Problem:** Each lane has different context budgets:

| Lane | Max Context | Max Response |
|------|-------------|--------------|
| chat-ask | 16K | 8K |
| chat-gather | 32K | 16K |
| chat-act | 200K | 32K |

The plan shows token counter but doesn't adapt to lane.

**Fix Required:** Update context drawer to show lane-specific limits:

```
▼ Context                   12K / 16K (Ask mode)
                            └─ Changes to 32K in Plan mode
```

---

### GAP-12: Lane Transition UI Not Specified

**Severity:** 🟡 Moderate

**Problem:** The LaneRouter auto-selects lanes based on input patterns. The plan mentions lane indicator but doesn't show:
- When/how lane changes
- Visual transition
- User override capability

**Fix Required:** Add lane transition handling:

```javascript
// When status-update received with different lane
function handleLaneChange(newLane) {
    if (newLane !== currentLane) {
        // Show subtle transition
        showLaneBadge(newLane);
        updateContextLimit(LANE_CONFIGS[newLane].budget);

        // Optional: Show why
        showToast(`Switched to ${newLane} mode based on your request`);
    }
}
```

---

### GAP-13: DataTier Privacy Mode Integration Missing

**Severity:** 🟡 Moderate

**Problem:** The backend has privacy tiers:
- `private` - No data shared
- `anonymous-metrics` - Usage stats only
- `data-contributor` - Full telemetry

The plan mentions this in amendments but doesn't integrate into:
- First-run flow
- Settings
- Status indicators

**Fix Required:** Add privacy tier selection to first-run and settings.

---

### GAP-14: Quality Signal Service Not Wired

**Severity:** 🟢 Minor

**Problem:** The backend has `QualitySignalService` for feedback. The plan mentions feedback buttons but doesn't wire to the service.

**Fix Required:** Add feedback message type:

```typescript
| { type: 'quality-signal'; messageId: string; rating: 'positive' | 'negative'; feedback?: string }
```

---

### GAP-15: Incomplete Visual Design Tokens

**Severity:** 🟢 Minor

**Problem:** The plan uses spec's color tokens but some are missing:
- Focus ring color for accessibility
- Selection highlight colors
- Syntax highlighting in code blocks

**Fix Required:** Add to CSS variables:

```css
--qic-focus-ring: var(--vscode-focusBorder, #007acc);
--qic-selection-bg: var(--vscode-editor-selectionBackground, #264f78);
```

---

### GAP-16: Webview Reload Recovery Not Specified

**Severity:** 🟡 Moderate

**Problem:** The plan doesn't address what happens when:
- Webview is reloaded (e.g., developer tools, VS Code restart)
- Panel is hidden and re-shown
- VS Code window loses focus for extended period

The conversation state could be lost or desynced.

**Fix Required:** Add to `03-STATE-AND-PROTOCOL.md`:

```typescript
// On webview ready (re-initialization)
function handleWebviewReady() {
    // 1. Send full state snapshot
    postMessage({
        type: 'state:snapshot',
        revision: currentRevision,
        state: stateService.getFullState()
    });

    // 2. Re-establish any pending operations
    if (agentState === 'processing') {
        // Resume streaming indicator
        postMessage({ type: 'resume-streaming' });
    }

    if (agentState === 'waiting_approval') {
        // Re-send pending approval requests
        resendPendingApprovals();
    }
}
```

---

### GAP-17: Concurrent Request Prevention Not Addressed

**Severity:** 🟡 Moderate

**Problem:** The plan doesn't specify how to prevent:
- User sending message while agent is processing
- Multiple rapid submits (double-click)
- Interaction with UI during state transitions

**Fix Required:** Add input lockout logic:

```javascript
// Input submission
function submitMessage() {
    if (state.agentState !== 'idle') {
        // Already processing - ignore or show feedback
        showToast('Please wait for the current response...');
        return;
    }

    // Disable input immediately
    setInputDisabled(true);

    // Send message
    vscode.postMessage({ type: 'send', payload: { content, mentions } });
}

// Re-enable on state change to idle
function handleStateChange(newState) {
    setInputDisabled(newState.agentState !== 'idle');
}
```

Also add debounce to submit button to prevent double-clicks.

---

## What's GOOD About the Plan

### ✅ Strengths

1. **Clean Architecture**
   - State service pattern is sound
   - Message protocol versioning strategy is safe
   - Migration path with feature flags is low-risk

2. **Native Integration**
   - Quick Picks for history/checkpoints is correct VS Code pattern
   - Status bar design follows spec well
   - Modal dialogs use native VS Code APIs

3. **Visual Design**
   - Header simplification aligns with spec
   - Context chips/drawer design is comprehensive
   - Change cards and diff UI are well-designed

4. **Cleanup Phase**
   - Dead code identification is accurate
   - Migration strategy is incremental and safe

---

## Recommendations

### Priority 1 (Before Any Implementation) - 4 Critical Gaps

1. **Fix GAP-01** - State machine alignment (dual state: service + agent)
2. **Fix GAP-03** - Streaming token buffering implementation
3. **Fix GAP-06** - Permission dialog Promise resolution flow
4. **Fix GAP-17** - Concurrent request prevention

### Priority 2 (During Phase 1-2) - 4 Moderate Gaps

5. **Fix GAP-05** - Document simplified ApprovalToken flow
6. **Fix GAP-07** - Error code display strategy
7. **Fix GAP-08** - Conversation persistence mechanics
8. **Fix GAP-10** - Cancel semantics for all scenarios

### Priority 3 (During Phase 3-4) - 4 Moderate Gaps

9. **Fix GAP-09** - Summarization UX notification
10. **Fix GAP-11** - Lane-specific context budgets
11. **Fix GAP-12** - Lane transition UI
12. **Fix GAP-16** - Webview reload recovery

### Priority 4 (Polish Phase) - 4 Minor Gaps

13. **Fix GAP-02** - State timeout handling
14. **Fix GAP-13** - Privacy tier integration
15. **Fix GAP-14** - Quality signal wiring
16. **Fix GAP-15** - Missing CSS tokens

**Note:** GAP-04 removed - backend handles tool call streaming internally.

---

## Verdict

### Will this plan produce a beautiful, functional, complete, and optimal UI?

**Current State:** ⚠️ **Not Yet**

**After Fixes:** ✅ **Yes**

The plan has strong foundations but **backend integration gaps** that would cause:
- Broken streaming (tokens not rendering smoothly)
- State desync (two state machines not handled)
- Race conditions (concurrent requests not prevented)
- Lost state (webview reload not recovered)

**With the 13 gaps addressed**, the plan will produce:
- ✅ **Beautiful** - Clean design system, proper theming
- ✅ **Functional** - All backend flows properly integrated
- ✅ **Complete** - All spec features + codebase features covered
- ✅ **Optimal** - Native VS Code patterns, efficient rendering, robust recovery

---

## Next Steps

1. **Amend the plan documents** with fixes for Priority 1 gaps (4 items)
2. **Review amended plan** before starting implementation
3. **Implement Phase 0** (cleanup) to establish clean foundation
4. **Implement Phase 1** (state/protocol) with gap fixes integrated

---

## Appendix: Correction Log

| Gap | Original Assessment | Corrected Assessment | Reason |
|-----|---------------------|----------------------|--------|
| GAP-04 | Critical - UI must handle tool_call streaming | Removed - Not a gap | Backend orchestrator processes streaming internally, sends complete tool calls to UI |
| GAP-05 | Critical - Webview must generate ApprovalToken with hash | Moderate - Document simplified flow | Host generates hash, webview only echoes it back with approval decision |
