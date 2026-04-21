# Prompt 02-08: Panel Integration

**Phase:** 2 - Panel Structure
**Dependencies:** 02-01 through 02-07
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Wire all Phase 2 components together: integrate the header, conversation area, input area, and streaming manager into a cohesive panel. Update the host-side panel code to work with the new webview structure.

---

## Context

Phase 2 has created several independent modules:
- `headerManager.js` - Header interactions
- `messageManager.js` - Message rendering
- `streamingManager.js` - Token streaming
- `inputCore.js` - Input handling
- `inputManager.js` - Input lockout
- `stateManager.js` - State synchronization (Phase 1)

This prompt wires them together and updates `qicPanel.ts` to:
1. Generate the new HTML template
2. Handle new message types
3. Connect to the message bridge
4. Manage webview lifecycle

Reference: `QIC_UI_SPEC/Optimal_plan/09-MIGRATION-STRATEGY.md`

---

## Scope

### In Scope
- Create unified HTML template
- Wire all JavaScript modules
- Update `qicPanel.ts` message handling
- Connect to message bridge
- Handle theme changes
- Implement webview reload recovery (GAP-16)
- Add initialization sequence

### Out of Scope
- Quick Pick implementations (Phase 3)
- Context drawer (Phase 4)
- Diff UI (Phase 5)
- Legacy code removal (Phase 3)

---

## Pre-Conditions

- [ ] 02-01 through 02-07 complete
- [ ] Phase 1 complete (state service, message bridge)
- [ ] Git branch created: `qic-ui/02-08-integration`

---

## Tasks

### 1. Create Unified HTML Template

Create new template file:

```bash
touch src/vs/workbench/contrib/qic/browser/media/chat.template.ts
```

```typescript
// src/vs/workbench/contrib/qic/browser/media/chat.template.ts

export interface ChatTemplateParams {
    nonce: string;
    cspSource: string;
    cssUri: string;
    stateManagerUri: string;
    headerManagerUri: string;
    messageManagerUri: string;
    streamingManagerUri: string;
    inputCoreUri: string;
    inputManagerUri: string;
    mainScriptUri: string;
    theme: 'light' | 'dark' | 'high-contrast';
}

export function getChatTemplate(params: ChatTemplateParams): string {
    return `<!DOCTYPE html>
<html lang="en" data-theme="${params.theme}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        style-src ${params.cspSource} 'unsafe-inline';
        script-src 'nonce-${params.nonce}';
        img-src ${params.cspSource} https: data:;
        font-src ${params.cspSource};
    ">
    <link rel="stylesheet" href="${params.cssUri}">
    <title>QIC Chat</title>
</head>
<body>
    <div id="qic-panel" class="qic-panel">
        <!-- Header -->
        <header class="qic-header">
            <div class="qic-header-left">
                <button id="status-btn" class="qic-header-btn qic-status-btn" title="Status" aria-label="View status">
                    <span class="qic-logo">◇</span>
                </button>
                <span class="qic-title">QIC</span>
            </div>
            <div class="qic-header-right">
                <button id="menu-btn" class="qic-header-btn" title="Menu" aria-label="Open menu" aria-haspopup="true" aria-expanded="false">
                    <span class="codicon codicon-kebab-vertical"></span>
                </button>
                <button id="new-chat-btn" class="qic-header-btn" title="New chat (Ctrl+N)" aria-label="New chat">
                    <span class="codicon codicon-add"></span>
                </button>
            </div>
        </header>

        <!-- Conversation Area -->
        <main id="conversation-area" class="qic-conversation-area" role="log" aria-live="polite" aria-label="Conversation">
            <!-- Empty state -->
            <div id="empty-state" class="qic-empty-state" role="region" aria-label="Get started">
                <div class="qic-empty-content">
                    <div class="qic-empty-icon" aria-hidden="true">
                        <span class="qic-logo-large">◇</span>
                    </div>
                    <h2 class="qic-empty-title">Welcome to QIC</h2>
                    <p class="qic-empty-subtitle">Your AI coding assistant for Quantlab</p>
                    <div class="qic-quick-actions">
                        <h3 class="qic-quick-actions-title">Try asking:</h3>
                        <div class="qic-quick-action-grid">
                            <button class="qic-quick-action" data-prompt="Explain this file">
                                <span class="codicon codicon-file-code"></span>
                                <span>Explain this file</span>
                            </button>
                            <button class="qic-quick-action" data-prompt="Find bugs in my code">
                                <span class="codicon codicon-bug"></span>
                                <span>Find bugs</span>
                            </button>
                            <button class="qic-quick-action" data-prompt="Write tests for the selected function">
                                <span class="codicon codicon-beaker"></span>
                                <span>Write tests</span>
                            </button>
                            <button class="qic-quick-action" data-prompt="Help me analyze this dataset">
                                <span class="codicon codicon-graph"></span>
                                <span>Analyze data</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Messages container -->
            <div id="messages" class="qic-messages" role="list" hidden></div>

            <!-- Scroll to bottom -->
            <button id="scroll-to-bottom" class="qic-scroll-btn" hidden aria-label="Scroll to bottom">
                <span class="codicon codicon-chevron-down"></span>
            </button>
        </main>

        <!-- Input Area -->
        <footer class="qic-input-footer">
            <!-- Context chips row -->
            <div id="context-chips-row" class="qic-context-chips-row" hidden>
                <div id="context-chips" class="qic-context-chips"></div>
                <button id="context-toggle" class="qic-context-toggle" title="Toggle context" aria-expanded="false">
                    <span class="codicon codicon-chevron-down"></span>
                    <span id="context-count" class="qic-context-count">0</span>
                </button>
            </div>

            <!-- Input row -->
            <div class="qic-input-row">
                <div class="qic-input-wrapper">
                    <textarea
                        id="chat-input"
                        class="qic-input"
                        placeholder="Ask anything... (Ctrl+Enter to send)"
                        rows="1"
                        aria-label="Message input"
                    ></textarea>
                    <div class="qic-input-footer-info">
                        <span id="char-count" class="qic-char-count"></span>
                    </div>
                </div>
                <div class="qic-input-actions">
                    <button id="send-btn" class="qic-send-btn" title="Send (Ctrl+Enter)" aria-label="Send" disabled>
                        <span class="codicon codicon-send"></span>
                    </button>
                    <button id="cancel-btn" class="qic-cancel-btn" title="Cancel (Escape)" aria-label="Cancel" hidden>
                        <span class="codicon codicon-stop"></span>
                    </button>
                </div>
            </div>
        </footer>
    </div>

    <!-- Scripts (order matters for dependencies) -->
    <script nonce="${params.nonce}" src="${params.stateManagerUri}"></script>
    <script nonce="${params.nonce}" src="${params.headerManagerUri}"></script>
    <script nonce="${params.nonce}" src="${params.messageManagerUri}"></script>
    <script nonce="${params.nonce}" src="${params.streamingManagerUri}"></script>
    <script nonce="${params.nonce}" src="${params.inputCoreUri}"></script>
    <script nonce="${params.nonce}" src="${params.inputManagerUri}"></script>
    <script nonce="${params.nonce}" src="${params.mainScriptUri}"></script>
</body>
</html>`;
}
```

### 2. Create Main Webview Script

```bash
touch src/vs/workbench/contrib/qic/browser/media/main.js
```

```javascript
// src/vs/workbench/contrib/qic/browser/media/main.js
// @ts-nocheck
/**
 * QIC Main Webview Script
 * Initializes all modules and handles message routing
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // VS Code API
    // ═══════════════════════════════════════════════════════════════════

    // @ts-ignore
    const vscode = acquireVsCodeApi();
    window.vscode = vscode;

    // ═══════════════════════════════════════════════════════════════════
    // Message Handler
    // ═══════════════════════════════════════════════════════════════════

    window.addEventListener('message', (event) => {
        const msg = event.data;

        // State messages (handled by state manager)
        if (window.qicState?.handleMessage(msg)) {
            return;
        }

        // Route to appropriate handler
        switch (msg.type) {
            // ─────────────────────────────────────────────────────────────
            // Streaming messages
            // ─────────────────────────────────────────────────────────────
            case 'message:start':
                window.qicStreaming?.startStream(msg.payload.id);
                break;

            case 'stream-token':  // Legacy
            case 'message:chunk':
                const content = msg.payload?.content ?? msg.text;
                window.qicStreaming?.addTokens(content);
                break;

            case 'message-complete':  // Legacy
            case 'message:complete':
                const id = msg.payload?.id ?? msg.messageId;
                window.qicStreaming?.completeStream(id, msg.payload?.metadata);
                break;

            case 'message:error':
                window.qicStreaming?.cancelStream(msg.payload?.id);
                showError(msg.payload);
                break;

            // ─────────────────────────────────────────────────────────────
            // Tool calls
            // ─────────────────────────────────────────────────────────────
            case 'tool-call-started':
            case 'tool:start':
                // Handled by state manager
                break;

            case 'tool-call-result':
            case 'tool:result':
                // Handled by state manager
                break;

            // ─────────────────────────────────────────────────────────────
            // State changes (legacy)
            // ─────────────────────────────────────────────────────────────
            case 'state-change':
                // Legacy state change - map to new state
                const stateMap = {
                    'idle': 'idle',
                    'processing': 'processing',
                    'waiting_approval': 'waiting_approval',
                    'error': 'error'
                };
                // Will be handled by inputManager
                break;

            // ─────────────────────────────────────────────────────────────
            // UI messages
            // ─────────────────────────────────────────────────────────────
            case 'error':
                showError({ code: msg.code, message: msg.message });
                break;

            case 'clear-chat':
                window.qicMessages?.clearMessages();
                break;

            case 'restore-history':
                restoreHistory(msg.messages);
                break;

            case 'set-theme':
            case 'theme:change':
                setTheme(msg.theme ?? msg.payload?.theme);
                break;

            // ─────────────────────────────────────────────────────────────
            // Permission/Approval dialogs
            // ─────────────────────────────────────────────────────────────
            case 'permission-request':
            case 'permission:request':
                showPermissionDialog(msg);
                break;

            case 'diff-preview':
            case 'changes:pending':
                showDiffPreview(msg);
                break;

            // ─────────────────────────────────────────────────────────────
            // Context updates (legacy)
            // ─────────────────────────────────────────────────────────────
            case 'context:update':
                window.qicInputCore?.updateContextChips(msg.payload?.items || []);
                break;

            // ─────────────────────────────────────────────────────────────
            // Quota updates (legacy)
            // ─────────────────────────────────────────────────────────────
            case 'quota-update':
                // Will be handled by status bar (Phase 3)
                break;

            default:
                console.log('[Main] Unhandled message type:', msg.type);
        }
    });

    // ═══════════════════════════════════════════════════════════════════
    // Custom Event Handlers (from modules)
    // ═══════════════════════════════════════════════════════════════════

    // Submit event from input
    window.addEventListener('qic:submit', (e) => {
        const { value } = e.detail;
        if (!value?.trim()) return;

        // Collect mentions (basic - enhanced in Phase 4)
        const mentions = extractMentions(value);

        vscode.postMessage({
            type: 'send',
            payload: { content: value, mentions }
        });

        window.qicInputCore?.clear();
    });

    // Cancel event
    window.addEventListener('qic:cancel', () => {
        vscode.postMessage({ type: 'cancel' });
    });

    // Context toggle
    window.addEventListener('qic:context-toggle', (e) => {
        // Will be handled in Phase 4
    });

    // Context remove
    window.addEventListener('qic:context-remove', (e) => {
        vscode.postMessage({
            type: 'context:remove',
            payload: { id: e.detail.id }
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // Helper Functions
    // ═══════════════════════════════════════════════════════════════════

    function extractMentions(text) {
        const mentions = [];
        const regex = /@([\w./\-]+)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            mentions.push({
                id: match[1],
                type: 'file',
                path: match[1],
                displayName: match[1],
                tokens: 0
            });
        }
        return mentions;
    }

    function showError(error) {
        console.error('[QIC Error]', error);
        // Could show toast or inline error
    }

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    function restoreHistory(messages) {
        // Convert legacy message format and render
        const converted = messages.map((m, i) => ({
            id: `restored-${i}`,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp
        }));

        // Messages will be rendered via state update
    }

    function showPermissionDialog(msg) {
        // Basic implementation - enhanced in Phase 5
        const requestId = msg.requestId ?? msg.payload?.id;
        const toolName = msg.toolName ?? msg.payload?.toolName;
        const description = msg.description ?? msg.payload?.description;

        // For now, auto-approve (full UI in Phase 5)
        console.log('[Permission] Request:', toolName, description);

        // Show simple confirm
        // In production, this would be a proper dialog
    }

    function showDiffPreview(msg) {
        // Basic implementation - enhanced in Phase 5
        console.log('[Diff] Preview:', msg);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        console.log('[QIC] Initializing webview...');

        // Quick action buttons
        document.querySelectorAll('.qic-quick-action').forEach(btn => {
            btn.addEventListener('click', () => {
                const prompt = btn.dataset.prompt;
                if (prompt) {
                    window.qicInputCore?.setValue(prompt);
                    window.qicInputCore?.focus();
                }
            });
        });

        // Signal ready to host
        vscode.postMessage({ type: 'ready' });
        // Also send legacy ready signal
        vscode.postMessage({ type: 'webview-ready' });

        console.log('[QIC] Webview initialized');
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
```

### 3. Update qicPanel.ts

Update the panel to use new template and message handling:

```typescript
// In qicPanel.ts - update getWebviewHtml()

import { getChatTemplate, ChatTemplateParams } from './media/chat.template.js';

private getWebviewHtml(): string {
    if (!this.webview) return '';

    const webview = this.webview.webview;
    const extensionUri = FileAccess.asFileUri('vs/workbench/contrib/qic/browser/media');

    const nonce = this.generateNonce();

    const getUri = (file: string) => webview.asWebviewUri(
        URI.joinPath(extensionUri, file)
    ).toString();

    const params: ChatTemplateParams = {
        nonce,
        cspSource: webview.cspSource,
        cssUri: getUri('chat.css'),
        stateManagerUri: getUri('stateManager.js'),
        headerManagerUri: getUri('headerManager.js'),
        messageManagerUri: getUri('messageManager.js'),
        streamingManagerUri: getUri('streamingManager.js'),
        inputCoreUri: getUri('inputCore.js'),
        inputManagerUri: getUri('inputManager.js'),
        mainScriptUri: getUri('main.js'),
        theme: this.getTheme(),
    };

    return getChatTemplate(params);
}

private generateNonce(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

private getTheme(): 'light' | 'dark' | 'high-contrast' {
    const theme = this.themeService.getColorTheme();
    if (theme.type === 'hc') return 'high-contrast';
    if (theme.type === 'dark') return 'dark';
    return 'light';
}
```

### 4. Update Message Handling

```typescript
// In qicPanel.ts - update handleWebviewMessage()

private handleWebviewMessage(msg: WebviewToHostMessage | WebviewToHostMessageV2): void {
    // V2 messages (new)
    switch (msg.type) {
        case 'ready':
        case 'webview-ready':
            this.webviewReady = true;
            this.messageBridge?.onWebviewReady();
            this.flushMessageQueue();
            // Send initial state
            this.sendInitialState();
            return;

        case 'revision:ack':
            this.messageBridge?.onRevisionAck((msg as any).revision);
            return;

        case 'state:request':
            this.messageBridge?.onStateRequest();
            return;

        case 'send':
            const payload = (msg as any).payload;
            this.handleUserMessage(payload.content, payload.mentions);
            return;

        case 'cancel':
            this.handleCancel();
            return;

        case 'newChat':
        case 'new-chat':
            this.handleNewChat();
            return;

        // Quick Pick triggers
        case 'quickPick:status':
            this.showStatusQuickPick();
            return;
        case 'quickPick:history':
            this.showHistoryQuickPick();
            return;
        case 'quickPick:checkpoints':
            this.showCheckpointQuickPick();
            return;
        case 'quickPick:provider':
            this.showProviderQuickPick();
            return;

        // Context
        case 'context:remove':
            this.handleContextRemove((msg as any).payload.id);
            return;

        // Legacy messages
        case 'user-message':
            this.handleUserMessage((msg as any).text, []);
            return;

        case 'cancel-request':
            this.handleCancel();
            return;

        // ... other handlers
    }
}

private sendInitialState(): void {
    // Send full state to webview
    if (this.messageBridge && this.stateService) {
        this.messageBridge.send({
            type: 'state:full',
            revision: this.stateService.revision,
            payload: this.stateService.getFullState()
        });
    }

    // Send theme
    this.postMessage({
        type: 'set-theme',
        theme: this.getTheme()
    });
}

// GAP-16 FIX: Webview reload recovery
private handleWebviewReload(): void {
    // Re-send full state
    this.sendInitialState();

    // Re-establish pending operations
    const state = this.stateService?.state;
    if (!state) return;

    if (state.agentState === 'processing') {
        // Resume streaming indicator
        this.postMessage({ type: 'state-change', state: 'processing' });
    }

    if (state.agentState === 'waiting_approval') {
        // Re-send pending permission request
        if (state.permissions.pending) {
            this.postMessage({
                type: 'permission:request',
                revision: this.stateService.revision,
                payload: state.permissions.pending
            });
        }
    }
}
```

### 5. Wire Theme Changes

```typescript
// In qicPanel.ts constructor or init

this._register(this.themeService.onDidColorThemeChange(() => {
    this.postMessage({
        type: 'set-theme',
        theme: this.getTheme()
    });
}));
```

---

## Verification

### Success Criteria
- [ ] Panel loads with new template
- [ ] All modules initialize without errors
- [ ] State syncs from host to webview
- [ ] Messages render correctly
- [ ] Streaming works end-to-end
- [ ] Input submission works
- [ ] Cancel works
- [ ] Theme changes apply
- [ ] Webview reload recovers state
- [ ] No console errors

### Integration Tests

| Test | Steps | Expected |
|------|-------|----------|
| Full flow | Open panel, send message | Message streams, completes |
| State sync | Change state in host | Webview updates |
| Theme | Change VS Code theme | Panel theme updates |
| Reload | Reload webview (DevTools) | State restored |
| New chat | Click + | Conversation cleared |

### Console Verification

Open DevTools and check for:
```
[QIC] Initializing webview...
[StateManager] Initialized
[HeaderManager] Initialized
[MessageManager] Initialized
[Streaming] Manager initialized
[InputCore] Initialized
[InputManager] Initialized
[QIC] Webview initialized
```

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
rm src/vs/workbench/contrib/qic/browser/media/chat.template.ts
rm src/vs/workbench/contrib/qic/browser/media/main.js
```

---

## Notes

- This is the critical integration point for Phase 2
- Keep legacy message handling for backwards compatibility
- Quick Pick stubs will be implemented in Phase 3
- Test thoroughly before proceeding to Phase 3
- Consider adding feature flag for new UI
