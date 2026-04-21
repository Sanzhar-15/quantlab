# Prompt 12 — UI Layer Part 1: Chat Panel Webview

**Phase**: 7 (UI Layer)
**Prerequisites**: Prompt 10 (orchestrator), Prompt 00 (panel scaffold)
**Estimated Scope**: ~8 files created/modified, ~1500 lines

---

## Objective

Implement the QIC chat panel as a VS Code webview in the auxiliary bar. This is the primary user interaction surface — where users type messages, see AI responses with streaming, view tool call progress, and interact with code suggestions.

---

## Spec References

- Implementation Plan v3: Phase 7 (lines 1462–1576) — UI Layer

## Audit Fixes Incorporated

- **I-7 (HIGH)**: Define the webview message protocol (message types, payloads, error handling).
- **IV-AO7 (HIGH)**: Add explicit webview message protocol with full message type enumerations and ready handshake.
- **XI-SV5 (HIGH)**: Strengthen markdown renderer security and CSP policy.
- **XII-AR3 (HIGH)**: Handle panel disposal — reject pending permission Promises with CancellationError.

---

## Implementation Instructions

### 1. Webview Message Protocol (AUDIT FIX I-7, AUDIT FIX IV-AO7)

Define the contract between the extension host and the webview.

**AUDIT FIX IV-AO7**: The complete message protocol with explicit enumeration of all message types:

**ExtensionToWebview (Host → Webview)**: `stream-token`, `tool-call-started`, `tool-call-result`, `diff-preview`, `permission-request`, `error`, `state-change`, `clear-chat`, `restore-history`, `degradation-update`

**WebviewToExtension (Webview → Host)**: `user-message`, `cancel-request`, `approve-diff`, `permission-response`, `copy-code`, `insert-code`, `webview-ready`

**CRITICAL**: The webview MUST acknowledge `webview-ready` before the extension sends any messages. The extension queues all messages until `webview-ready` is received.

```typescript
// src/vs/workbench/contrib/qic/common/ui/messageProtocol.ts

// === Host → Webview messages ===
export type HostToWebviewMessage =
    | { type: 'stream-token'; text: string }
    | { type: 'message-complete'; messageId: string }
    | { type: 'tool-call-started'; toolCallId: string; toolName: string; args: Record<string, unknown> }
    | { type: 'tool-call-result'; toolCallId: string; content: string; isError: boolean }
    | { type: 'diff-preview'; editScript: EditScript; previewHtml: string }
    | { type: 'permission-request'; requestId: string; toolName: string; description: string }
    | { type: 'state-change'; state: 'idle' | 'processing' | 'waiting_approval' | 'error' }
    | { type: 'error'; code: string; message: string }
    | { type: 'clear-chat' }
    | { type: 'restore-history'; messages: SerializedMessage[] }
    | { type: 'set-theme'; theme: 'light' | 'dark' | 'high-contrast' }
    | { type: 'degradation-update'; level: number; description: string };

// === Webview → Host messages ===
export type WebviewToHostMessage =
    | { type: 'user-message'; text: string }
    | { type: 'cancel-request' }
    | { type: 'permission-response'; requestId: string; granted: boolean }
    | { type: 'approve-diff'; editScriptHash: string; approved: boolean }
    | { type: 'new-chat' }
    | { type: 'copy-code'; code: string }
    | { type: 'insert-code'; code: string; filePath?: string }
    | { type: 'webview-ready' };  // MUST be sent before host sends any messages

export interface SerializedMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: string;
    toolCalls?: Array<{ name: string; status: string }>;
}
```

**Message queueing**: The extension host MUST implement a message queue:
```typescript
private webviewReady = false;
private messageQueue: HostToWebviewMessage[] = [];

private postMessage(message: HostToWebviewMessage): void {
    if (!this.webviewReady) {
        this.messageQueue.push(message);
        return;
    }
    this.webview?.postMessage(message);
}

// When 'webview-ready' is received:
private onWebviewReady(): void {
    this.webviewReady = true;
    for (const msg of this.messageQueue) {
        this.webview?.postMessage(msg);
    }
    this.messageQueue = [];
}
```

### 2. Replace the Placeholder Panel

Replace the placeholder `QicChatViewPane` from Prompt 00 with the real webview-based panel:

```typescript
// src/vs/workbench/contrib/qic/browser/qicPanel.ts

export class QicChatViewPane extends ViewPane {
    private webview: IOverlayWebview | undefined;

    protected override renderBody(container: HTMLElement): void {
        // Create webview inside the view pane container
        // Load the chat HTML/CSS/JS from the media/ directory
        // Set up message handlers for the protocol
    }

    /**
     * Send a message to the webview.
     */
    private postMessage(message: HostToWebviewMessage): void;

    /**
     * Handle messages from the webview.
     */
    private handleWebviewMessage(message: WebviewToHostMessage): void;
}
```

### 3. Chat Webview HTML/CSS/JS

Create the chat interface that runs inside the webview:

**`browser/media/chat.html`** — The main webview HTML:
- Message list container (scrollable)
- Input area with textarea and send button
- Loading indicator
- Tool call progress indicators

**`browser/media/chat.css`** — Styling:
- Use VS Code CSS variables for theming (`--vscode-*`)
- Message bubbles (user messages right-aligned, assistant left-aligned)
- Markdown rendering support
- Code block styling with syntax highlighting
- Tool call cards (collapsed by default, expandable)
- Diff preview styling
- Streaming animation (blinking cursor)

**`browser/media/chat.js`** — Webview logic:
- Handle messages from host via `window.addEventListener('message', ...)`
- Send messages to host via `vscode.postMessage()`
- Markdown rendering (use a lightweight markdown parser — no external deps)
- Code block rendering with language detection
- Auto-scroll to bottom on new messages
- Streaming text animation
- Input handling (Enter to send, Shift+Enter for newline)
- Copy code button on code blocks

### 4. Markdown Renderer

**AUDIT FIX XI-SV5**: Strengthen the markdown renderer to prevent XSS. Use VS Code's built-in `MarkdownRenderer` if available, OR implement a strict HTML tag allowlist.

```typescript
// src/vs/workbench/contrib/qic/browser/media/markdownRenderer.js
// REMEDIATION FIX 4e: Standardized on .js extension — this is a webview file,
// not a TypeScript module compiled by the main build.

// PREFERRED: Use VS Code's built-in MarkdownRenderer
// import { MarkdownRenderer } from 'vs/editor/contrib/markdownRenderer/browser/markdownRenderer';

// If implementing custom renderer, enforce strict security:
export function renderMarkdown(text: string): string {
    // Handle: headers, bold, italic, code blocks, inline code,
    // lists, links, blockquotes
    // Code blocks: <pre><code class="language-{lang}">...</code></pre>

    // AUDIT FIX XI-SV5: Strict HTML tag allowlist
    // Only allow: <p>, <br>, <strong>, <em>, <code>, <pre>, <h1>-<h6>,
    //             <ul>, <ol>, <li>, <blockquote>, <a>, <span>
    // Strip ALL other tags.

    // AUDIT FIX XI-SV5: Validate all href attributes
    // Only allow: https://, http://, # (anchor links)
    // REJECT: javascript:, data:, vbscript:, blob:, file:
    const sanitizedHtml = sanitizeHtml(rawHtml, {
        allowedTags: ['p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3',
                       'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'a', 'span'],
        validateHref: (href: string) => {
            const allowed = /^(https?:\/\/|#)/i;
            return allowed.test(href.trim());
        }
    });
    return sanitizedHtml;
}
```

### 5. Wire Up the Orchestrator

Connect the webview to the orchestrator:

```typescript
// In qicPanel.ts
private handleWebviewMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
        case 'user-message':
            this.orchestrator.handleUserMessage(message.text);
            break;
        case 'cancel-request':
            this.cancellationManager.cancel('current-request', 'User cancelled');
            break;
        case 'diff-approval':
            // Handle edit approval/rejection
            break;
        case 'new-chat':
            this.startNewChat();
            break;
    }
}
```

### 6. Implement Real UIService

Replace the stub UIService with the real webview-backed implementation.

**AUDIT FIX XII-AR3**: Handle panel disposal — if the QIC panel is closed while a permission dialog or diff approval is pending, reject the Promise with `CancellationError` so the orchestrator does not hang indefinitely.

```typescript
// src/vs/workbench/contrib/qic/browser/uiService.ts
export class QicUIService implements UIService {
    // AUDIT FIX XII-AR3: Track pending promises so they can be rejected on disposal
    private readonly pendingDialogs = new Map<string, {
        resolve: (value: any) => void;
        reject: (reason: any) => void;
    }>();

    constructor(private readonly panel: QicChatViewPane) {
        // AUDIT FIX XII-AR3: Listen for panel disposal
        this.panel.onDidDispose(() => this.rejectAllPendingDialogs());
    }

    streamChatToken(token: string): void {
        this.panel.postMessage({ type: 'stream-token', text: token });
    }

    async showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null> {
        // Send diff to webview, wait for user approval
        this.panel.postMessage({ type: 'diff-preview', editScript, previewHtml: this.renderDiff(editScript) });
        return new Promise((resolve, reject) => {
            const requestId = generateId();
            // AUDIT FIX XII-AR3: Track this pending dialog
            this.pendingDialogs.set(requestId, { resolve, reject });
            // Listen for approve-diff message from webview
        });
    }

    async showPermissionDialog(tool: string, context: ToolContext): Promise<PermissionCheckResult> {
        return new Promise((resolve, reject) => {
            const requestId = generateId();
            // AUDIT FIX XII-AR3: Track this pending dialog
            this.pendingDialogs.set(requestId, { resolve, reject });
            // Send permission request to webview, wait for response
            this.panel.postMessage({
                type: 'permission-request',
                requestId,
                toolName: tool,
                description: context.description
            });
        });
    }

    // AUDIT FIX XII-AR3: Reject all pending dialogs on panel disposal
    private rejectAllPendingDialogs(): void {
        for (const [requestId, { reject }] of this.pendingDialogs) {
            reject(new CancellationError());
        }
        this.pendingDialogs.clear();
    }
}
```

### 7. Content Security Policy

**AUDIT FIX XI-SV5**: Strengthened CSP — remove `'unsafe-inline'` from `style-src`, add `form-action 'none'` and `base-uri 'none'`.

The webview must have a strict CSP:
```html
<meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'nonce-${styleNonce}';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} data:;
    form-action 'none';
    base-uri 'none';
">
```

**Changes from default (AUDIT FIX XI-SV5)**:
- `style-src`: Replaced `'unsafe-inline'` with `'nonce-${styleNonce}'` — all inline styles must use a nonce
- `form-action 'none'`: Prevents any form submission from the webview
- `base-uri 'none'`: Prevents `<base>` tag injection that could redirect relative URLs

No external resources. No inline scripts (use nonce). No inline styles without nonce. All resources from extension bundle.

---

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/common/ui/messageProtocol.ts` | Message protocol types |
| `src/vs/workbench/contrib/qic/browser/qicPanel.ts` | **Modify** — Replace placeholder with webview |
| `src/vs/workbench/contrib/qic/browser/uiService.ts` | Real UIService |
| `src/vs/workbench/contrib/qic/browser/media/chat.html` | Webview HTML |
| `src/vs/workbench/contrib/qic/browser/media/chat.css` | **Modify** — Full chat styles |
| `src/vs/workbench/contrib/qic/browser/media/chat.js` | Webview JavaScript |
| `src/vs/workbench/contrib/qic/browser/media/markdownRenderer.js` | Markdown rendering |
| `src/vs/workbench/contrib/qic/browser/qic.contribution.ts` | **Modify** — Register UIService |

---

## Acceptance Criteria

```
□ QIC chat panel renders in the auxiliary bar with proper styling
□ User can type messages and see them appear in the chat
□ Assistant responses stream token-by-token with cursor animation
□ Markdown is rendered correctly (headers, code blocks, lists)
□ Markdown renderer uses strict HTML tag allowlist (audit fix XI-SV5)
□ All href attributes validated — only https://, http://, # allowed (audit fix XI-SV5)
□ Code blocks have copy button and syntax highlighting
□ Tool calls show progress cards (started → completed/failed)
□ Theme changes are reflected (light/dark/high-contrast via CSS variables)
□ Strict CSP enforced — no 'unsafe-inline', form-action 'none', base-uri 'none' (audit fix XI-SV5)
□ Webview message protocol matches defined types (audit fix I-7, IV-AO7)
□ Extension queues messages until 'webview-ready' is received (audit fix IV-AO7)
□ Panel disposal rejects all pending permission/diff Promises with CancellationError (audit fix XII-AR3)
□ UIService.streamChatToken routes to webview
□ Enter sends message, Shift+Enter creates newline
□ Auto-scrolls to bottom on new content
□ TypeScript compiles with no errors
```

---

## Audit Fixes Applied

| Fix ID | Severity | Summary |
|--------|----------|---------|
| IV-AO7 | HIGH | Added explicit webview message protocol with full enumeration of ExtensionToWebview and WebviewToExtension message types; webview must acknowledge 'webview-ready' before extension sends messages; extension queues messages until ready |
| XI-SV5 | HIGH | Strengthened markdown renderer with strict HTML tag allowlist and href validation (reject javascript:, data:, vbscript:); CSP hardened — removed 'unsafe-inline' from style-src, added form-action 'none' and base-uri 'none' |
| XII-AR3 | HIGH | Handle panel disposal — reject all pending permission dialog and diff approval Promises with CancellationError when panel is closed, preventing orchestrator hangs |
