# Phase 2: Panel Structure

**Duration:** 1.5 weeks | **Depends on:** Phase 1 (State & Protocol)

---

## Overview

This phase implements the new panel structure per spec: minimal header, conversation area, context chips, and input area. This replaces the current cluttered header with floating panels.

---

## 1. New Panel Layout

### 1.1 Structure

```
┌─────────────────────────────────────────┐
│ HEADER (40px)                           │
│ [◇] QIC                      [⋮]   [+]  │
├─────────────────────────────────────────┤
│ CONVERSATION (flex-1, scrollable)       │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ You · 10:23 AM                  [✎] │ │
│ │ Fix the Sharpe calculation          │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ QIC · 10:24 AM                  [⟲] │ │
│ │ The Sharpe ratio calculation...     │ │
│ └─────────────────────────────────────┘ │
│                                         │
├─────────────────────────────────────────┤
│ CONTEXT (auto, collapsible)             │
│ ▼ Context                   12K / 32K   │
│ [📄 main.py ×] [⌷ L50-60 ×] [+3 more]   │
├─────────────────────────────────────────┤
│ INPUT (36-200px)                        │
│ Ask anything...              [→]        │
└─────────────────────────────────────────┘
```

---

## 2. Header Component

### 2.1 New HTML Structure

Replace the current complex header with:

```html
<header class="qic-header">
    <div class="qic-header-left">
        <button id="status-btn" class="qic-status-btn" title="Connection status" aria-label="View status">
            <span class="qic-status-indicator" data-status="connected"></span>
            <span class="qic-logo">◇</span>
        </button>
        <span class="qic-title">QIC</span>
    </div>
    <div class="qic-header-right">
        <button id="menu-btn" class="qic-header-btn" title="Menu" aria-label="Open menu" aria-haspopup="menu">
            <span class="codicon codicon-ellipsis"></span>
        </button>
        <button id="new-chat-btn" class="qic-header-btn" title="New conversation (Cmd+Shift+N)" aria-label="New conversation">
            <span class="codicon codicon-add"></span>
        </button>
    </div>
</header>
```

### 2.2 Header CSS

```css
.qic-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: var(--qic-height-header, 40px);
    padding: 0 var(--qic-space-3, 12px);
    border-bottom: 1px solid var(--qic-border-default);
    background: var(--qic-bg-secondary);
    flex-shrink: 0;
}

.qic-header-left {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2, 8px);
}

.qic-header-right {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1, 4px);
}

.qic-status-btn {
    display: flex;
    align-items: center;
    gap: var(--qic-space-1, 4px);
    padding: var(--qic-space-1, 4px) var(--qic-space-2, 8px);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--qic-radius-md, 5px);
    cursor: pointer;
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-base, 13px);
    transition: background 0.15s, border-color 0.15s;
}

.qic-status-btn:hover {
    background: var(--qic-bg-tertiary);
    border-color: var(--qic-border-default);
}

.qic-status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.qic-status-indicator[data-status="connected"] {
    background: var(--qic-status-success);
}

.qic-status-indicator[data-status="connecting"] {
    background: var(--qic-accent-primary);
    animation: qic-pulse 1.5s infinite;
}

.qic-status-indicator[data-status="degraded"] {
    background: var(--qic-status-warning);
}

.qic-status-indicator[data-status="disconnected"],
.qic-status-indicator[data-status="error"] {
    background: var(--qic-status-error);
}

.qic-status-indicator[data-status="offline"] {
    background: var(--qic-fg-muted);
}

.qic-logo {
    font-size: 16px;
    font-weight: 600;
}

.qic-title {
    font-weight: 600;
    font-size: var(--qic-text-lg, 14px);
    color: var(--qic-fg-primary);
}

.qic-header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--qic-height-button, 28px);
    height: var(--qic-height-button, 28px);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--qic-radius-sm, 3px);
    cursor: pointer;
    color: var(--qic-fg-secondary);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.qic-header-btn:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
    border-color: var(--qic-border-default);
}

.qic-header-btn:focus-visible {
    outline: 2px solid var(--qic-accent-primary);
    outline-offset: 1px;
}
```

### 2.3 Menu Dropdown

The menu dropdown opens when clicking [⋮]. Implement as a native-style dropdown:

```html
<div id="menu-dropdown" class="qic-menu-dropdown" role="menu" hidden>
    <button class="qic-menu-item" role="menuitem" data-action="history">
        <span class="codicon codicon-history"></span>
        <span>Conversation history</span>
        <kbd>Cmd+Shift+H</kbd>
    </button>
    <button class="qic-menu-item" role="menuitem" data-action="rename">
        <span class="codicon codicon-edit"></span>
        <span>Rename conversation</span>
    </button>
    <div class="qic-menu-separator" role="separator"></div>
    <button class="qic-menu-item" role="menuitem" data-action="checkpoints">
        <span class="codicon codicon-history"></span>
        <span>View checkpoints</span>
    </button>
    <button class="qic-menu-item" role="menuitem" data-action="create-checkpoint">
        <span class="codicon codicon-add"></span>
        <span>Create checkpoint</span>
        <kbd>Cmd+Shift+C</kbd>
    </button>
    <div class="qic-menu-separator" role="separator"></div>
    <button class="qic-menu-item" role="menuitem" data-action="permissions">
        <span class="codicon codicon-shield"></span>
        <span>View permissions</span>
    </button>
    <button class="qic-menu-item" role="menuitem" data-action="audit">
        <span class="codicon codicon-list-flat"></span>
        <span>View audit log</span>
    </button>
    <div class="qic-menu-separator" role="separator"></div>
    <button class="qic-menu-item" role="menuitem" data-action="provider">
        <span class="codicon codicon-server"></span>
        <span>Switch provider</span>
    </button>
    <button class="qic-menu-item" role="menuitem" data-action="settings">
        <span class="codicon codicon-settings-gear"></span>
        <span>Settings</span>
    </button>
    <button class="qic-menu-item" role="menuitem" data-action="help">
        <span class="codicon codicon-question"></span>
        <span>Help & shortcuts</span>
        <kbd>Cmd+/</kbd>
    </button>
</div>
```

```css
.qic-menu-dropdown {
    position: absolute;
    top: calc(var(--qic-height-header) + 4px);
    right: var(--qic-space-3);
    width: var(--qic-width-menu, 220px);
    background: var(--qic-bg-primary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    box-shadow: var(--qic-shadow-lg);
    z-index: var(--qic-z-dropdown, 10);
    padding: var(--qic-space-1) 0;
}

.qic-menu-item {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    width: 100%;
    padding: var(--qic-space-2) var(--qic-space-3);
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-sm);
    text-align: left;
}

.qic-menu-item:hover {
    background: var(--qic-bg-secondary);
}

.qic-menu-item:focus-visible {
    background: var(--qic-bg-secondary);
    outline: none;
}

.qic-menu-item kbd {
    margin-left: auto;
    color: var(--qic-fg-muted);
    font-size: var(--qic-text-xs);
}

.qic-menu-separator {
    height: 1px;
    background: var(--qic-border-default);
    margin: var(--qic-space-1) 0;
}
```

---

## 3. Conversation Area

### 3.1 Message Structure

```html
<div id="messages" class="qic-messages" role="log" aria-live="polite">
    <!-- User message -->
    <article class="qic-message qic-message-user" data-id="msg-1">
        <header class="qic-message-header">
            <span class="qic-message-author">You</span>
            <span class="qic-message-time">10:23 AM</span>
            <div class="qic-message-actions">
                <button class="qic-action-btn" title="Edit" aria-label="Edit message">
                    <span class="codicon codicon-edit"></span>
                </button>
                <button class="qic-action-btn" title="Copy" aria-label="Copy message">
                    <span class="codicon codicon-copy"></span>
                </button>
            </div>
        </header>
        <div class="qic-message-content">
            Fix the Sharpe calculation bug in @risk_metrics.py
        </div>
        <footer class="qic-message-footer">
            <span class="qic-edited-indicator">[edited]</span>
        </footer>
    </article>

    <!-- Assistant message -->
    <article class="qic-message qic-message-assistant" data-id="msg-2">
        <header class="qic-message-header">
            <span class="qic-message-author">QIC</span>
            <span class="qic-message-time">10:24 AM</span>
            <div class="qic-message-actions">
                <button class="qic-action-btn" title="Regenerate" aria-label="Regenerate response">
                    <span class="codicon codicon-refresh"></span>
                </button>
                <button class="qic-action-btn" title="Copy" aria-label="Copy response">
                    <span class="codicon codicon-copy"></span>
                </button>
            </div>
        </header>
        <div class="qic-message-content">
            <!-- Rendered markdown content -->
        </div>
        <footer class="qic-message-footer">
            <!-- Branch pills if regenerated -->
            <div class="qic-branch-pills">
                <button class="qic-branch-pill" data-branch="1">v1</button>
                <button class="qic-branch-pill qic-branch-active" data-branch="2">v2 ●</button>
                <button class="qic-branch-pill" data-branch="3">v3</button>
            </div>
        </footer>
    </article>

    <!-- Streaming message -->
    <article class="qic-message qic-message-assistant qic-streaming" data-id="msg-3">
        <header class="qic-message-header">
            <span class="qic-message-author">QIC</span>
            <span class="qic-message-time">streaming...</span>
        </header>
        <div class="qic-message-content">
            <span class="qic-stream-text">The Sharpe ratio is calculated by...</span>
            <span class="qic-cursor"></span>
        </div>
    </article>

    <!-- Pre-stream loading -->
    <div class="qic-loading-dots" aria-label="Thinking">
        <span class="qic-dot"></span>
        <span class="qic-dot"></span>
        <span class="qic-dot"></span>
    </div>
</div>
```

### 3.2 Message CSS

```css
.qic-messages {
    flex: 1;
    overflow-y: auto;
    padding: var(--qic-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--qic-space-4);
    scroll-behavior: smooth;
}

.qic-message {
    padding: var(--qic-space-3);
    border-radius: var(--qic-radius-lg);
    background: var(--qic-bg-secondary);
}

.qic-message-user {
    border-left: 3px solid var(--qic-accent-primary);
}

.qic-message-assistant {
    background: transparent;
}

.qic-message-header {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    margin-bottom: var(--qic-space-2);
    font-size: var(--qic-text-sm);
}

.qic-message-author {
    font-weight: 600;
    color: var(--qic-fg-primary);
}

.qic-message-time {
    color: var(--qic-fg-muted);
}

.qic-message-actions {
    display: flex;
    gap: var(--qic-space-1);
    margin-left: auto;
    opacity: 0;
    transition: opacity 0.15s;
}

.qic-message:hover .qic-message-actions {
    opacity: 1;
}

.qic-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: var(--qic-radius-sm);
    cursor: pointer;
    color: var(--qic-fg-secondary);
}

.qic-action-btn:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
}

.qic-message-content {
    color: var(--qic-fg-primary);
    line-height: 1.6;
}

.qic-message-footer {
    margin-top: var(--qic-space-2);
}

.qic-edited-indicator {
    color: var(--qic-fg-muted);
    font-size: var(--qic-text-xs);
}

/* Branch pills */
.qic-branch-pills {
    display: flex;
    gap: var(--qic-space-1);
}

.qic-branch-pill {
    padding: var(--qic-space-1) var(--qic-space-2);
    background: var(--qic-chip-bg);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-sm);
    cursor: pointer;
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-secondary);
}

.qic-branch-pill:hover {
    background: var(--qic-bg-tertiary);
}

.qic-branch-pill.qic-branch-active {
    background: var(--qic-accent-primary-muted);
    border-color: var(--qic-accent-primary);
    color: var(--qic-accent-primary);
}

/* Streaming */
.qic-streaming .qic-message-time {
    animation: qic-pulse 1.5s infinite;
}

.qic-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: var(--qic-accent-primary);
    animation: qic-blink 1.06s infinite;
    vertical-align: text-bottom;
    margin-left: 1px;
}

/* Loading dots */
.qic-loading-dots {
    display: flex;
    gap: var(--qic-space-1);
    padding: var(--qic-space-3);
}

.qic-dot {
    width: 8px;
    height: 8px;
    background: var(--qic-fg-muted);
    border-radius: 50%;
}

.qic-dot:nth-child(1) { animation: qic-dots 1.2s infinite 0ms; }
.qic-dot:nth-child(2) { animation: qic-dots 1.2s infinite 150ms; }
.qic-dot:nth-child(3) { animation: qic-dots 1.2s infinite 300ms; }

@keyframes qic-dots {
    0%, 20% { opacity: 0.3; }
    50% { opacity: 1; }
    80%, 100% { opacity: 0.3; }
}
```

### 3.3 GAP-03 FIX: Streaming Token Buffering

The backend sends individual tokens via `streamChatToken(token: string)`. For smooth rendering:

```javascript
// ═══════════════════════════════════════════════════════════════════════
// GAP-03 FIX: Token Buffering for Smooth Streaming
// ═══════════════════════════════════════════════════════════════════════

(function() {
    'use strict';

    // State
    let tokenBuffer = '';
    let renderTimeout = null;
    let streamingMessageId = null;
    let streamElement = null;
    let markdownRenderScheduled = false;
    let lastScrollPosition = 0;

    const RENDER_INTERVAL = 16; // ~60fps
    const MARKDOWN_RENDER_INTERVAL = 100; // Re-render markdown every 100ms during streaming
    const SCROLL_THRESHOLD = 100; // Pixels from bottom to auto-scroll

    // Initialize streaming for a new message
    function startStreaming(messageId) {
        streamingMessageId = messageId;
        tokenBuffer = '';

        // Create streaming message element
        const messagesContainer = document.getElementById('messages');
        const messageEl = createStreamingMessageElement(messageId);
        messagesContainer.appendChild(messageEl);
        streamElement = messageEl.querySelector('.qic-stream-text');

        // Scroll to bottom when starting
        scrollToBottom();
    }

    // Handle incoming token
    function handleStreamToken(token) {
        if (!streamingMessageId) {
            console.warn('Received token but no streaming message active');
            return;
        }

        tokenBuffer += token;

        // Debounce rendering for performance
        if (!renderTimeout) {
            renderTimeout = setTimeout(() => {
                renderBufferedTokens();
                renderTimeout = null;
            }, RENDER_INTERVAL);
        }
    }

    // Render accumulated tokens
    function renderBufferedTokens() {
        if (!streamElement || !tokenBuffer) return;

        // Append raw text (not HTML to prevent XSS)
        streamElement.textContent += tokenBuffer;
        tokenBuffer = '';

        // Auto-scroll if user is near bottom
        if (isNearBottom()) {
            scrollToBottom();
        }

        // Schedule markdown re-render (debounced)
        scheduleMarkdownRender();
    }

    // Check if scroll is near bottom
    function isNearBottom() {
        const messagesContainer = document.getElementById('messages');
        const scrollBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
        return scrollBottom < SCROLL_THRESHOLD;
    }

    // Smooth scroll to bottom
    function scrollToBottom() {
        const messagesContainer = document.getElementById('messages');
        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: 'smooth'
        });
    }

    // Schedule markdown render (debounced during streaming)
    function scheduleMarkdownRender() {
        if (markdownRenderScheduled) return;

        markdownRenderScheduled = true;
        setTimeout(() => {
            renderMarkdown();
            markdownRenderScheduled = false;
        }, MARKDOWN_RENDER_INTERVAL);
    }

    // Render markdown content
    function renderMarkdown() {
        if (!streamElement) return;

        const rawText = streamElement.textContent;

        // Create a hidden element for rendered markdown
        const renderedEl = streamElement.parentElement.querySelector('.qic-rendered-content');
        if (renderedEl) {
            // Use a simple markdown renderer (e.g., marked.js)
            renderedEl.innerHTML = window.marked ? window.marked.parse(rawText) : escapeHtml(rawText);

            // Syntax highlight code blocks if available
            if (window.hljs) {
                renderedEl.querySelectorAll('pre code').forEach(block => {
                    window.hljs.highlightElement(block);
                });
            }
        }
    }

    // Complete streaming
    function completeStreaming(messageId, metadata) {
        // Flush any remaining tokens
        if (tokenBuffer) {
            renderBufferedTokens();
        }

        // Clear timeouts
        if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
        }

        // Final markdown render
        renderMarkdown();

        // Update message element to non-streaming state
        const messageEl = document.querySelector(`.qic-message[data-id="${messageId}"]`);
        if (messageEl) {
            messageEl.classList.remove('qic-streaming');
            // Remove cursor
            const cursor = messageEl.querySelector('.qic-cursor');
            if (cursor) cursor.remove();
            // Show final timestamp
            const timeEl = messageEl.querySelector('.qic-message-time');
            if (timeEl) timeEl.textContent = formatTime(new Date());
        }

        // Reset state
        streamingMessageId = null;
        streamElement = null;
    }

    // Create streaming message element
    function createStreamingMessageElement(messageId) {
        const article = document.createElement('article');
        article.className = 'qic-message qic-message-assistant qic-streaming';
        article.dataset.id = messageId;
        article.innerHTML = `
            <header class="qic-message-header">
                <span class="qic-message-author">QIC</span>
                <span class="qic-message-time">streaming...</span>
            </header>
            <div class="qic-message-content">
                <span class="qic-stream-text"></span>
                <span class="qic-cursor"></span>
            </div>
            <div class="qic-rendered-content" hidden></div>
        `;
        return article;
    }

    function formatTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Export
    window.qicStreaming = {
        startStreaming,
        handleStreamToken,
        completeStreaming,
        isStreaming: () => !!streamingMessageId
    };
})();
```

**Integration with message handler:**

```javascript
// In main message handler
window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'message:start':
            window.qicStreaming.startStreaming(msg.payload.id);
            break;

        case 'stream-token': // Legacy message type
        case 'message:chunk':
            window.qicStreaming.handleStreamToken(msg.payload?.content || msg.text);
            break;

        case 'message-complete': // Legacy
        case 'message:complete':
            window.qicStreaming.completeStreaming(msg.payload?.id || msg.messageId, msg.payload?.metadata);
            break;
    }
});
```

---

## 4. Input Area

### 4.1 Input Structure

```html
<div class="qic-input-area">
    <textarea
        id="chat-input"
        class="qic-input"
        placeholder="Ask anything..."
        rows="1"
        aria-label="Message input"
    ></textarea>
    <button
        id="send-btn"
        class="qic-send-btn"
        title="Send (Cmd+Enter)"
        aria-label="Send message"
        disabled
    >
        <span class="codicon codicon-send"></span>
    </button>
</div>
```

### 4.2 Input CSS

```css
.qic-input-area {
    display: flex;
    align-items: flex-end;
    gap: var(--qic-space-2);
    padding: var(--qic-space-3);
    border-top: 1px solid var(--qic-border-default);
    background: var(--qic-bg-primary);
    flex-shrink: 0;
}

.qic-input {
    flex: 1;
    min-height: var(--qic-height-input, 36px);
    max-height: 200px;
    padding: var(--qic-space-2) var(--qic-space-3);
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    color: var(--qic-fg-primary);
    font-family: var(--qic-font-sans);
    font-size: var(--qic-text-base);
    line-height: 1.5;
    resize: none;
    transition: border-color 0.15s, box-shadow 0.15s;
}

.qic-input:focus {
    outline: none;
    border-color: var(--qic-accent-primary);
    box-shadow: 0 0 0 2px var(--qic-accent-primary-muted);
}

.qic-input::placeholder {
    color: var(--qic-fg-muted);
}

.qic-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.qic-input.qic-input-error {
    border-color: var(--qic-status-error);
}

.qic-send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--qic-height-input, 36px);
    height: var(--qic-height-input, 36px);
    background: var(--qic-accent-primary);
    border: none;
    border-radius: var(--qic-radius-md);
    cursor: pointer;
    color: white;
    flex-shrink: 0;
    transition: background 0.15s, opacity 0.15s;
}

.qic-send-btn:hover:not(:disabled) {
    background: var(--qic-accent-primary-hover);
}

.qic-send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.qic-send-btn:focus-visible {
    outline: 2px solid var(--qic-accent-primary);
    outline-offset: 2px;
}
```

### 4.3 GAP-17 FIX: Concurrent Request Prevention

Prevent race conditions from multiple rapid submits or interaction during processing:

```javascript
// ═══════════════════════════════════════════════════════════════════════
// GAP-17 FIX: Input Lockout and Concurrent Request Prevention
// ═══════════════════════════════════════════════════════════════════════

(function() {
    'use strict';

    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');

    let isLocked = false;
    let lastSubmitTime = 0;
    const DEBOUNCE_MS = 300; // Prevent double-clicks

    // Lock input during processing
    function lockInput(reason = 'processing') {
        isLocked = true;
        chatInput.disabled = true;
        sendBtn.disabled = true;
        chatInput.placeholder = getPlaceholderForReason(reason);
        chatInput.classList.add('qic-input-locked');
    }

    // Unlock input when idle
    function unlockInput() {
        isLocked = false;
        chatInput.disabled = false;
        updateSendButtonState();
        chatInput.placeholder = 'Ask anything...';
        chatInput.classList.remove('qic-input-locked');
        chatInput.focus();
    }

    function getPlaceholderForReason(reason) {
        switch (reason) {
            case 'processing': return 'Waiting for response...';
            case 'waiting_approval': return 'Waiting for your approval...';
            case 'suspended': return 'Conversation suspended';
            case 'error': return 'Error occurred - check status';
            default: return 'Please wait...';
        }
    }

    // Update send button based on input content
    function updateSendButtonState() {
        if (isLocked) {
            sendBtn.disabled = true;
            return;
        }
        sendBtn.disabled = !chatInput.value.trim();
    }

    // Submit message with debounce protection
    function submitMessage() {
        const now = Date.now();

        // Debounce rapid clicks
        if (now - lastSubmitTime < DEBOUNCE_MS) {
            console.log('Debounced rapid submit');
            return false;
        }

        // Check lock state
        if (isLocked) {
            showToast('Please wait for the current response...');
            return false;
        }

        const content = chatInput.value.trim();
        if (!content) {
            return false;
        }

        // Record submit time
        lastSubmitTime = now;

        // Lock immediately for responsive feel
        lockInput('processing');

        // Collect any @mentions
        const mentions = collectMentions(content);

        // Send message
        vscode.postMessage({
            type: 'send',
            payload: { content, mentions }
        });

        // Clear input
        chatInput.value = '';
        autoResizeInput();

        return true;
    }

    // Cancel current operation
    function cancelOperation() {
        if (!isLocked) return;

        vscode.postMessage({ type: 'cancel' });
        // Don't unlock immediately - wait for state change
    }

    // Subscribe to state changes to manage lock
    window.qicState.subscribe((state, patch) => {
        const agentState = state.agentState;

        switch (agentState) {
            case 'idle':
                unlockInput();
                break;
            case 'processing':
                lockInput('processing');
                break;
            case 'waiting_approval':
                lockInput('waiting_approval');
                break;
            case 'error':
                lockInput('error');
                // Auto-unlock after short delay for error state
                setTimeout(() => {
                    if (window.qicState.getState().agentState === 'error') {
                        unlockInput(); // Allow user to try again
                    }
                }, 2000);
                break;
            case 'suspended':
                lockInput('suspended');
                break;
        }
    });

    // Event listeners
    chatInput.addEventListener('input', updateSendButtonState);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submitMessage();
        }
        // Escape to cancel
        if (e.key === 'Escape' && isLocked) {
            cancelOperation();
        }
    });

    sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        submitMessage();
    });

    // Prevent form submission if accidentally wrapped in form
    chatInput.form?.addEventListener('submit', (e) => {
        e.preventDefault();
        submitMessage();
    });

    // Simple toast for feedback
    function showToast(message) {
        // Use existing toast system or create simple one
        const toast = document.createElement('div');
        toast.className = 'qic-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    function collectMentions(content) {
        // Extract @file and @symbol mentions
        const mentions = [];
        const mentionRegex = /@(\S+)/g;
        let match;
        while ((match = mentionRegex.exec(content)) !== null) {
            mentions.push({
                id: match[1],
                type: 'file', // Would need smarter detection
                path: match[1],
                displayName: match[1],
                tokens: 0 // Calculated by host
            });
        }
        return mentions;
    }

    function autoResizeInput() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
    }

    // Export for external use
    window.qicInput = {
        submit: submitMessage,
        cancel: cancelOperation,
        isLocked: () => isLocked
    };
})();
```

**Toast CSS:**

```css
.qic-toast {
    position: fixed;
    bottom: var(--qic-space-4);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--qic-space-2) var(--qic-space-4);
    background: var(--qic-bg-tertiary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    color: var(--qic-fg-primary);
    font-size: var(--qic-text-sm);
    z-index: var(--qic-z-toast, 100);
    animation: qic-toast-in 0.2s ease-out;
}

@keyframes qic-toast-in {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}

.qic-input-locked {
    opacity: 0.7;
    cursor: not-allowed;
}
```

---

## 5. Empty State

### 5.1 Empty State Structure

```html
<div id="empty-state" class="qic-empty-state">
    <div class="qic-empty-logo">◇</div>
    <h2 class="qic-empty-title">How can I help?</h2>
    <div class="qic-suggestions">
        <button class="qic-suggestion" data-prompt="Explain this file">
            <span class="codicon codicon-file"></span>
            Explain this file
        </button>
        <button class="qic-suggestion" data-prompt="Find bugs">
            <span class="codicon codicon-bug"></span>
            Find bugs
        </button>
        <button class="qic-suggestion" data-prompt="Write tests">
            <span class="codicon codicon-beaker"></span>
            Write tests
        </button>
        <button class="qic-suggestion" data-prompt="Optimize">
            <span class="codicon codicon-zap"></span>
            Optimize
        </button>
    </div>
</div>
```

### 5.2 Empty State CSS

```css
.qic-empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--qic-space-4);
    text-align: center;
}

.qic-empty-logo {
    font-size: 48px;
    color: var(--qic-fg-muted);
    margin-bottom: var(--qic-space-4);
}

.qic-empty-title {
    font-size: var(--qic-text-lg);
    font-weight: 600;
    color: var(--qic-fg-primary);
    margin-bottom: var(--qic-space-4);
}

.qic-suggestions {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--qic-space-2);
    max-width: 300px;
}

.qic-suggestion {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    cursor: pointer;
    color: var(--qic-fg-secondary);
    font-size: var(--qic-text-sm);
    transition: background 0.15s, color 0.15s;
}

.qic-suggestion:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
}
```

---

## 6. JavaScript Updates

### 6.1 Menu Handler

```javascript
// Menu dropdown logic
const menuBtn = document.getElementById('menu-btn');
const menuDropdown = document.getElementById('menu-dropdown');

menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menuDropdown.hidden;
    menuDropdown.hidden = !isHidden;
    menuBtn.setAttribute('aria-expanded', !isHidden);

    if (!isHidden) {
        // Focus first item
        menuDropdown.querySelector('.qic-menu-item')?.focus();
    }
});

// Close on outside click
document.addEventListener('click', () => {
    menuDropdown.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
});

// Menu item actions
menuDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.qic-menu-item');
    if (!item) return;

    const action = item.dataset.action;
    menuDropdown.hidden = true;

    switch (action) {
        case 'history':
            vscode.postMessage({ type: 'quickPick:history' });
            break;
        case 'checkpoints':
            vscode.postMessage({ type: 'quickPick:checkpoints' });
            break;
        case 'provider':
            vscode.postMessage({ type: 'quickPick:provider' });
            break;
        case 'settings':
            vscode.postMessage({ type: 'openSettings' });
            break;
        case 'help':
            vscode.postMessage({ type: 'showHelp' });
            break;
        // ... etc
    }
});

// Keyboard navigation in menu
menuDropdown.addEventListener('keydown', (e) => {
    const items = Array.from(menuDropdown.querySelectorAll('.qic-menu-item'));
    const current = document.activeElement;
    const index = items.indexOf(current);

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            items[(index + 1) % items.length]?.focus();
            break;
        case 'ArrowUp':
            e.preventDefault();
            items[(index - 1 + items.length) % items.length]?.focus();
            break;
        case 'Escape':
            menuDropdown.hidden = true;
            menuBtn.focus();
            break;
    }
});
```

### 6.2 Status Button Handler

```javascript
const statusBtn = document.getElementById('status-btn');
const statusIndicator = statusBtn.querySelector('.qic-status-indicator');

statusBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'quickPick:status' });
});

// Update status from state
function updateStatus(connection) {
    statusIndicator.dataset.status = connection.status;
    statusBtn.title = `${connection.status} - ${connection.provider}`;
}

// Subscribe to state changes
window.qicState.subscribe((state, patch) => {
    if (!patch || patch.path === 'connection') {
        updateStatus(state.connection);
    }
});
```

---

## 7. Removed Elements

### 7.1 Elements to Remove

From the current implementation, remove:

| Element | Replacement |
|---------|-------------|
| `#connection-status` | Status button with indicator |
| `#provider-select` | Menu → Switch provider → Quick Pick |
| `#cost-display` | Status bar quota item |
| `#context-btn` in header | Context row toggle |
| `#checkpoint-btn` in header | Menu → View checkpoints |
| `#settings-btn` in header | Menu → Settings |
| Floating `#checkpoint-panel` | Quick Pick |
| Floating `#settings-panel` | VS Code Settings |
| Floating `#context-panel` | Context drawer |

---

## 8. Checklist

### Header
- [ ] Create new header HTML structure
- [ ] Implement status button with indicator
- [ ] Implement menu dropdown
- [ ] Add keyboard navigation
- [ ] Wire up Quick Pick triggers
- [ ] Remove old header elements

### Conversation Area
- [ ] Update message structure
- [ ] Add hover actions
- [ ] Implement branch pills
- [ ] Add streaming cursor
- [ ] Add loading dots
- [ ] Implement lazy loading
- [ ] GAP-03 FIX: Implement token buffering (~60fps)
- [ ] GAP-03 FIX: Implement incremental markdown rendering
- [ ] GAP-03 FIX: Implement smart scroll-to-bottom

### Input Area
- [ ] Simplify input structure
- [ ] Implement auto-resize
- [ ] Add disabled states
- [ ] Wire up send/cancel
- [ ] GAP-17 FIX: Implement input lockout during processing
- [ ] GAP-17 FIX: Add debounce to prevent double-clicks
- [ ] GAP-17 FIX: Subscribe to agentState for lock management

### Empty State
- [ ] Create empty state component
- [ ] Wire up suggestion clicks
- [ ] Show/hide based on messages

### Cleanup
- [ ] Remove old floating panels
- [ ] Remove old header elements
- [ ] Update CSS to remove dead styles
