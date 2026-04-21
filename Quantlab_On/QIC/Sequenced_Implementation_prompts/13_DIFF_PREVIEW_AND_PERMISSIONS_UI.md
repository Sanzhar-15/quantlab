# Prompt 13 — UI Layer Part 2: Diff Preview, Permission Dialogs & Status Indicators

**Phase**: 7 (UI Layer)
**Prerequisites**: Prompt 12 (chat panel), Prompt 07 (mutation engine)
**Estimated Scope**: ~6 files created/modified, ~800 lines

---

## Objective

Implement the diff preview widget (showing proposed code changes for user approval), permission dialogs (granting tool access), first-run consent UI, and status bar indicators. This completes the UI layer and enables INV-T1 (Preview Before Apply).

---

## Spec References

- QIC Spec v6.2: §2.4 First-Run Consent (lines 1647–1806) — Consent UI
- QIC Spec v6.2: INV-T1 — Preview Before Apply
- QIC Spec v6.2: INV-T2 — No Silent Execution

## Audit Fixes Incorporated

- **XII-AR3 (HIGH)**: Permission dialogs must handle panel disposal — reject pending Promises with CancellationError.

---

## Implementation Instructions

### 1. Diff Preview Widget

Render EditScript diffs in the chat webview for user approval:

```typescript
// Add to webview chat.js
function renderDiffPreview(editScript, previewHtml) {
    // Create a diff card in the chat:
    // - File path header
    // - Unified diff view (red for deletions, green for additions)
    // - "Apply" and "Reject" buttons
    // - "Apply All" if multiple files
    // - Line numbers on both sides
}
```

The diff rendering should:
- Show unified diff format
- Color code additions (green) and deletions (red)
- Show file path and line numbers
- Provide "Apply" / "Reject" / "Apply All" buttons
- Show a warning if conflict detected (from ConflictDetector)
- Disable "Apply" if there are conflicts (force user to review)

### 2. Permission Dialog

When a tool requires permission, show an inline dialog in the chat:

```typescript
function renderPermissionRequest(requestId, toolName, description) {
    // Create a permission card:
    // - Tool icon and name
    // - Description of what the tool will do
    // - "Allow Once" / "Allow for Session" / "Deny" buttons
    // - "Always Allow" (smaller, secondary action)
}
```

**AUDIT FIX XII-AR3**: Permission dialogs MUST handle panel disposal. If the QIC panel is closed while a permission dialog is pending, the Promise backing the dialog must be rejected with `CancellationError` so the orchestrator does not hang indefinitely waiting for a response that will never come.

```typescript
// In the UIService (or wherever permission dialog Promises are created):
// Track all pending permission dialog Promises
private pendingPermissions = new Map<string, { resolve: Function; reject: Function }>();

// When panel is disposed:
panel.onDidDispose(() => {
    for (const [id, { reject }] of this.pendingPermissions) {
        reject(new CancellationError());
    }
    this.pendingPermissions.clear();
});

// The orchestrator's tool execution loop MUST catch CancellationError
// and treat it as a denial (do not execute the tool).
```

### 3. First-Run Consent UI

On first activation, show a welcome/consent screen in the QIC panel:

```typescript
function renderFirstRunConsent() {
    // Full-panel welcome screen:
    // - QIC logo and description
    // - Explanation of data usage
    // - Checkboxes for consent categories:
    //   □ Send code context to AI providers for completions and chat
    //   □ Generate code embeddings for search (local by default)
    //   □ Optional: anonymous usage telemetry
    // - "Get Started" button (enabled when minimum consent granted)
    // - Link to privacy policy
}
```

### 4. Status Bar Indicators

Add QIC status to the VS Code status bar:

```typescript
// src/vs/workbench/contrib/qic/browser/qicStatusBarItem.ts
export class QicStatusBarContribution {
    // Show in status bar:
    // - QIC icon + "Ready" / "Processing..." / "Degraded" / "Error"
    // - Current model name (e.g., "claude-3-5-sonnet")
    // - Token usage for current session
    // - Click to open QIC panel
}
```

Register the status bar item in `qic.contribution.ts`.

### 5. Inline Completion Status

Show a subtle indicator when inline completions are being generated:

```typescript
// When completion is triggered, show a small spinning indicator
// in the editor margin or status bar
// Disappears when completion arrives or is cancelled
```

### 6. Replace ALL UI Stubs

After this prompt, the UIService stub from Prompt 10 should be fully replaced:

- `showDiffPreview` → Renders diff in webview, waits for user response
- `showPermissionDialog` → Renders permission card, waits for response
- `streamChatToken` → Posts token to webview
- `showInfo/showWarning/showError` → Uses VS Code notification API

**Verify**: Search for `[STUB]` in UI-related code. All UI stubs should be replaced.

---

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/browser/media/chat.js` | **Modify** — Add diff, permission, first-run rendering |
| `src/vs/workbench/contrib/qic/browser/media/chat.css` | **Modify** — Add diff, permission, first-run styles |
| `src/vs/workbench/contrib/qic/browser/qicStatusBarItem.ts` | Status bar contribution |
| `src/vs/workbench/contrib/qic/browser/uiService.ts` | **Modify** — Complete UIService |
| `src/vs/workbench/contrib/qic/browser/qic.contribution.ts` | **Modify** — Register status bar |
| `src/vs/workbench/contrib/qic/browser/firstRunView.ts` | First-run consent |

---

## Acceptance Criteria

```
□ Diff preview shows unified diff with color coding (green/red)
□ "Apply" button creates ApprovalToken and applies via MutationEngine (INV-T1)
□ "Reject" button discards the edit
□ Permission dialogs show for tools with hasSideEffects: true
□ "Allow Once" / "Allow for Session" / "Deny" options work
□ Panel disposal rejects all pending permission/diff Promises with CancellationError (audit fix XII-AR3)
□ Orchestrator catches CancellationError and treats as denial (audit fix XII-AR3)
□ First-run consent screen appears on initial activation
□ Minimum consent required before QIC features activate
□ Status bar shows QIC state (Ready/Processing/Degraded/Error)
□ Status bar click opens QIC panel
□ No [STUB] warnings remain in UI-related code
□ TypeScript compiles with no errors
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| XII-AR3 | HIGH | Permission dialogs handle panel disposal: if QIC panel is closed while a permission dialog is pending, reject the Promise with CancellationError so the orchestrator does not hang; orchestrator must catch CancellationError and treat as denial |
