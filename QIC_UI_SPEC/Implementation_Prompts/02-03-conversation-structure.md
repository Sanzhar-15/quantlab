# Prompt 02-03: Conversation Structure

**Phase:** 2 - Panel Structure
**Dependencies:** 02-01 (Header HTML/CSS)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Create the conversation area structure: message list container, message components, role-based styling, timestamps, and tool call display. This is the foundation for streaming (02-04) and all message rendering.

---

## Context

The conversation area displays:
1. **User messages** - Right-aligned, user avatar
2. **Assistant messages** - Left-aligned, QIC avatar
3. **Tool call cards** - Inline with assistant messages
4. **Error cards** - When messages fail
5. **System messages** - Centered, subtle styling

Messages must support:
- Markdown rendering (basic)
- Code blocks with syntax highlighting
- File references (`[[path]]` clickable)
- Branching UI (for regenerated responses)
- Timestamps

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md`

---

## Scope

### In Scope
- Create conversation area HTML structure
- Create message component templates
- Create tool call card templates
- Create error card templates
- Add role-based CSS styling
- Implement message rendering function
- Implement file reference click handling
- Wire to state manager for message list
- Implement lazy loading sentinel

### Out of Scope
- Streaming implementation (02-04)
- Markdown library integration (use basic for now)
- Syntax highlighting (Phase 6)
- Branching UI (Phase 6)
- Virtualization (deferred per ADR-004)

---

## Pre-Conditions

- [ ] 02-01 complete (header structure exists)
- [ ] 01-05 complete (state manager available)
- [ ] Git branch created: `qic-ui/02-03-conversation`

---

## Tasks

### 1. Create Conversation Area HTML

Update the webview HTML template to include:

```html
<!-- Conversation Area -->
<main id="conversation-area" class="qic-conversation-area" role="log" aria-live="polite" aria-label="Conversation">
    <!-- Empty state (shown when no messages) -->
    <div id="empty-state" class="qic-empty-state">
        <!-- Filled in by 02-07 -->
    </div>

    <!-- Messages container -->
    <div id="messages" class="qic-messages" role="list">
        <!-- Messages rendered here -->
    </div>

    <!-- Lazy loading sentinel -->
    <div id="load-more-sentinel" class="qic-load-sentinel" aria-hidden="true"></div>

    <!-- Scroll to bottom button -->
    <button id="scroll-to-bottom" class="qic-scroll-btn" hidden aria-label="Scroll to bottom">
        <span class="codicon codicon-chevron-down"></span>
    </button>
</main>
```

### 2. Create Message Manager

```bash
touch src/vs/workbench/contrib/qic/browser/media/messageManager.js
```

### 3. Implement Message Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/messageManager.js
// @ts-nocheck
/**
 * QIC Message Manager
 * Handles message rendering and conversation display
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const CONFIG = {
        MESSAGE_BATCH_SIZE: 50,
        SCROLL_BUTTON_THRESHOLD: 200,
        FILE_REFERENCE_REGEX: /\[\[([^\]]+)\]\]/g,
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let messagesContainer = null;
    let emptyState = null;
    let scrollBtn = null;
    let loadSentinel = null;
    let renderedMessageIds = new Set();
    let unsubscribe = null;

    // ═══════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        messagesContainer = document.getElementById('messages');
        emptyState = document.getElementById('empty-state');
        scrollBtn = document.getElementById('scroll-to-bottom');
        loadSentinel = document.getElementById('load-more-sentinel');

        if (!messagesContainer) {
            console.error('[MessageManager] Messages container not found');
            return;
        }

        setupEventListeners();
        setupIntersectionObserver();
        subscribeToState();

        console.log('[MessageManager] Initialized');
    }

    function setupEventListeners() {
        // Scroll button
        scrollBtn?.addEventListener('click', () => scrollToBottom(true));

        // Track scroll position for scroll button visibility
        messagesContainer.addEventListener('scroll', handleScroll);

        // Delegate click for file references and actions
        messagesContainer.addEventListener('click', handleMessageClick);
    }

    function setupIntersectionObserver() {
        if (!loadSentinel) return;

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                loadMoreMessages();
            }
        }, { rootMargin: '100px' });

        observer.observe(loadSentinel);
    }

    function subscribeToState() {
        if (!window.qicState) {
            console.warn('[MessageManager] State manager not available');
            return;
        }

        unsubscribe = window.qicState.subscribe((state, patch) => {
            if (!patch || patch.path === '*' || patch.path.startsWith('conversation')) {
                renderMessages();
            }
        });

        // Initial render
        renderMessages();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════════════════════════════

    function handleScroll() {
        const isNearBottom = isScrollNearBottom();
        if (scrollBtn) {
            scrollBtn.hidden = isNearBottom;
        }
    }

    function handleMessageClick(e) {
        const target = e.target;

        // File reference click
        if (target.classList.contains('qic-file-ref')) {
            e.preventDefault();
            const path = target.dataset.path;
            const isFolder = target.dataset.isFolder === 'true';
            vscode.postMessage({ type: 'open-file-reference', path, isFolder });
            return;
        }

        // Copy code button
        if (target.classList.contains('qic-copy-code-btn') || target.closest('.qic-copy-code-btn')) {
            const codeBlock = target.closest('.qic-code-block');
            const code = codeBlock?.querySelector('code')?.textContent || '';
            vscode.postMessage({ type: 'copy-code', code });
            showCopyFeedback(target);
            return;
        }

        // Insert code button
        if (target.classList.contains('qic-insert-code-btn') || target.closest('.qic-insert-code-btn')) {
            const codeBlock = target.closest('.qic-code-block');
            const code = codeBlock?.querySelector('code')?.textContent || '';
            vscode.postMessage({ type: 'insert-code', code });
            return;
        }

        // Retry button
        if (target.classList.contains('qic-retry-btn')) {
            const messageId = target.closest('.qic-message')?.dataset.id;
            if (messageId) {
                vscode.postMessage({ type: 'retry', payload: { messageId } });
            }
            return;
        }

        // Regenerate button
        if (target.classList.contains('qic-regenerate-btn')) {
            const messageId = target.closest('.qic-message')?.dataset.id;
            if (messageId) {
                vscode.postMessage({ type: 'regenerate', payload: { messageId } });
            }
            return;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Rendering
    // ═══════════════════════════════════════════════════════════════════

    function renderMessages() {
        const state = window.qicState?.getState?.();
        if (!state) return;

        const messages = state.conversation?.messages || [];
        const toolCalls = state.conversation?.activeToolCalls || [];

        // Show/hide empty state
        if (emptyState) {
            emptyState.hidden = messages.length > 0;
        }
        if (messagesContainer) {
            messagesContainer.hidden = messages.length === 0;
        }

        // Render messages
        messages.forEach(message => {
            if (!renderedMessageIds.has(message.id)) {
                appendMessage(message);
                renderedMessageIds.add(message.id);
            } else {
                updateMessage(message);
            }
        });

        // Render active tool calls
        renderToolCalls(toolCalls);

        // Auto-scroll if at bottom
        if (isScrollNearBottom()) {
            scrollToBottom();
        }
    }

    function appendMessage(message) {
        const element = createMessageElement(message);
        messagesContainer.appendChild(element);
    }

    function updateMessage(message) {
        const element = messagesContainer.querySelector(`.qic-message[data-id="${message.id}"]`);
        if (!element) return;

        // Update content
        const contentEl = element.querySelector('.qic-message-content');
        if (contentEl && !element.classList.contains('qic-streaming')) {
            contentEl.innerHTML = renderContent(message.content, message.role);
        }

        // Update error state
        if (message.error) {
            element.classList.add('qic-message-error');
            let errorEl = element.querySelector('.qic-error-card');
            if (!errorEl) {
                errorEl = createErrorCard(message.error);
                element.appendChild(errorEl);
            }
        }
    }

    function createMessageElement(message) {
        const article = document.createElement('article');
        article.className = `qic-message qic-message-${message.role}`;
        article.dataset.id = message.id;
        article.setAttribute('role', 'listitem');

        const isUser = message.role === 'user';
        const isSystem = message.role === 'system';

        article.innerHTML = `
            <header class="qic-message-header">
                <span class="qic-message-avatar" aria-hidden="true">${getAvatar(message.role)}</span>
                <span class="qic-message-author">${getAuthorName(message.role)}</span>
                <time class="qic-message-time" datetime="${message.timestamp}">
                    ${formatTime(message.timestamp)}
                </time>
                ${!isUser && !isSystem ? `
                    <div class="qic-message-actions">
                        <button class="qic-action-btn qic-regenerate-btn" title="Regenerate">
                            <span class="codicon codicon-refresh"></span>
                        </button>
                    </div>
                ` : ''}
            </header>
            <div class="qic-message-content">
                ${renderContent(message.content, message.role)}
            </div>
            ${message.mentions?.length ? renderMentions(message.mentions) : ''}
            ${message.changes ? renderChangeSummary(message.changes) : ''}
            ${message.error ? createErrorCard(message.error).outerHTML : ''}
        `;

        return article;
    }

    function renderContent(content, role) {
        if (!content) return '';

        // Escape HTML first
        let html = escapeHtml(content);

        // Convert file references [[path]] to clickable links
        html = html.replace(CONFIG.FILE_REFERENCE_REGEX, (match, path) => {
            const isFolder = path.endsWith('/');
            const displayPath = path.length > 40 ? '...' + path.slice(-37) : path;
            return `<a href="#" class="qic-file-ref" data-path="${escapeAttr(path)}" data-is-folder="${isFolder}" title="${escapeAttr(path)}">${escapeHtml(displayPath)}</a>`;
        });

        // Basic markdown rendering (full implementation can use marked.js)
        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
            return `
                <div class="qic-code-block" data-language="${escapeAttr(lang)}">
                    <div class="qic-code-header">
                        <span class="qic-code-language">${lang || 'text'}</span>
                        <div class="qic-code-actions">
                            <button class="qic-copy-code-btn" title="Copy">
                                <span class="codicon codicon-copy"></span>
                            </button>
                            <button class="qic-insert-code-btn" title="Insert at cursor">
                                <span class="codicon codicon-insert"></span>
                            </button>
                        </div>
                    </div>
                    <pre><code>${escapeHtml(code.trim())}</code></pre>
                </div>
            `;
        });

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code class="qic-inline-code">$1</code>');

        // Bold
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // Italic
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // Line breaks
        html = html.replace(/\n/g, '<br>');

        return html;
    }

    function renderMentions(mentions) {
        if (!mentions?.length) return '';

        return `
            <div class="qic-message-mentions">
                ${mentions.map(m => `
                    <span class="qic-mention-chip qic-mention-${m.type}">
                        <span class="codicon codicon-${getMentionIcon(m.type)}"></span>
                        ${escapeHtml(m.displayName)}
                    </span>
                `).join('')}
            </div>
        `;
    }

    function renderChangeSummary(changes) {
        if (!changes) return '';

        return `
            <div class="qic-changes-summary">
                <span class="codicon codicon-edit"></span>
                <span>${changes.files.length} file${changes.files.length !== 1 ? 's' : ''} changed</span>
                <button class="qic-view-changes-btn">View Changes</button>
            </div>
        `;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Tool Call Rendering
    // ═══════════════════════════════════════════════════════════════════

    function renderToolCalls(toolCalls) {
        // Remove old tool call cards
        messagesContainer.querySelectorAll('.qic-tool-call-card').forEach(el => {
            if (!toolCalls.find(tc => tc.id === el.dataset.id)) {
                el.remove();
            }
        });

        toolCalls.forEach(toolCall => {
            let card = messagesContainer.querySelector(`.qic-tool-call-card[data-id="${toolCall.id}"]`);

            if (!card) {
                card = createToolCallCard(toolCall);
                messagesContainer.appendChild(card);
            } else {
                updateToolCallCard(card, toolCall);
            }
        });
    }

    function createToolCallCard(toolCall) {
        const div = document.createElement('div');
        div.className = `qic-tool-call-card qic-tool-${toolCall.status}`;
        div.dataset.id = toolCall.id;
        div.setAttribute('role', 'status');

        div.innerHTML = `
            <div class="qic-tool-header">
                <span class="qic-tool-icon">
                    ${toolCall.status === 'running' ? '<span class="codicon codicon-loading qic-spin"></span>' : ''}
                    ${toolCall.status === 'complete' ? '<span class="codicon codicon-check"></span>' : ''}
                    ${toolCall.status === 'error' ? '<span class="codicon codicon-error"></span>' : ''}
                </span>
                <span class="qic-tool-name">${escapeHtml(toolCall.name)}</span>
                <span class="qic-tool-status">${getToolStatusText(toolCall.status)}</span>
            </div>
            ${toolCall.args ? `
                <details class="qic-tool-args">
                    <summary>Arguments</summary>
                    <pre><code>${escapeHtml(JSON.stringify(toolCall.args, null, 2))}</code></pre>
                </details>
            ` : ''}
            ${toolCall.result ? `
                <div class="qic-tool-result ${toolCall.isError ? 'qic-tool-result-error' : ''}">
                    <pre><code>${escapeHtml(toolCall.result)}</code></pre>
                </div>
            ` : ''}
        `;

        return div;
    }

    function updateToolCallCard(card, toolCall) {
        card.className = `qic-tool-call-card qic-tool-${toolCall.status}`;

        const statusEl = card.querySelector('.qic-tool-status');
        if (statusEl) {
            statusEl.textContent = getToolStatusText(toolCall.status);
        }

        const iconEl = card.querySelector('.qic-tool-icon');
        if (iconEl) {
            iconEl.innerHTML = toolCall.status === 'running'
                ? '<span class="codicon codicon-loading qic-spin"></span>'
                : toolCall.status === 'complete'
                    ? '<span class="codicon codicon-check"></span>'
                    : '<span class="codicon codicon-error"></span>';
        }

        if (toolCall.result && !card.querySelector('.qic-tool-result')) {
            const resultEl = document.createElement('div');
            resultEl.className = `qic-tool-result ${toolCall.isError ? 'qic-tool-result-error' : ''}`;
            resultEl.innerHTML = `<pre><code>${escapeHtml(toolCall.result)}</code></pre>`;
            card.appendChild(resultEl);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Error Card
    // ═══════════════════════════════════════════════════════════════════

    function createErrorCard(error) {
        const div = document.createElement('div');
        div.className = 'qic-error-card';
        div.setAttribute('role', 'alert');

        div.innerHTML = `
            <div class="qic-error-header">
                <span class="codicon codicon-error"></span>
                <span class="qic-error-title">${escapeHtml(error.title || 'Error')}</span>
                ${error.code ? `<span class="qic-error-code">${escapeHtml(error.code)}</span>` : ''}
            </div>
            <div class="qic-error-message">${escapeHtml(error.message)}</div>
            ${error.recoverable ? `
                <div class="qic-error-actions">
                    <button class="qic-retry-btn">Retry</button>
                </div>
            ` : ''}
        `;

        return div;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function loadMoreMessages() {
        // Request more messages from host
        vscode.postMessage({
            type: 'messages:loadMore',
            payload: { offset: renderedMessageIds.size, limit: CONFIG.MESSAGE_BATCH_SIZE }
        });
    }

    function scrollToBottom(instant = false) {
        if (!messagesContainer) return;
        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: instant ? 'auto' : 'smooth'
        });
    }

    function isScrollNearBottom() {
        if (!messagesContainer) return true;
        const threshold = CONFIG.SCROLL_BUTTON_THRESHOLD;
        return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
    }

    function getAvatar(role) {
        switch (role) {
            case 'user': return '👤';
            case 'assistant': return '◇';
            case 'system': return '⚙';
            default: return '?';
        }
    }

    function getAuthorName(role) {
        switch (role) {
            case 'user': return 'You';
            case 'assistant': return 'QIC';
            case 'system': return 'System';
            default: return 'Unknown';
        }
    }

    function getMentionIcon(type) {
        const icons = {
            'file': 'file',
            'folder': 'folder',
            'symbol': 'symbol-method',
            'docs': 'book',
            'selection': 'selection',
            'terminal': 'terminal',
        };
        return icons[type] || 'file';
    }

    function getToolStatusText(status) {
        switch (status) {
            case 'running': return 'Running...';
            case 'complete': return 'Complete';
            case 'error': return 'Failed';
            default: return status;
        }
    }

    function formatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function escapeAttr(text) {
        if (!text) return '';
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function showCopyFeedback(target) {
        const btn = target.closest('.qic-copy-code-btn');
        if (!btn) return;
        btn.innerHTML = '<span class="codicon codicon-check"></span>';
        setTimeout(() => {
            btn.innerHTML = '<span class="codicon codicon-copy"></span>';
        }, 1500);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    window.qicMessages = {
        init,
        renderMessages,
        scrollToBottom,
        appendMessage,
        clearMessages: () => {
            messagesContainer.innerHTML = '';
            renderedMessageIds.clear();
        },

        // For debugging
        _debug: {
            getRenderedIds: () => renderedMessageIds,
            isNearBottom: isScrollNearBottom
        }
    };

    // Auto-init when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
```

### 4. Add Conversation CSS

```css
/* ═══════════════════════════════════════════════════════════════════════
   CONVERSATION AREA
   ═══════════════════════════════════════════════════════════════════════ */

.qic-conversation-area {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
}

.qic-messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--qic-space-3);
    scroll-behavior: smooth;
}

.qic-messages[hidden] {
    display: none;
}

/* ═══════════════════════════════════════════════════════════════════════
   MESSAGE STYLING
   ═══════════════════════════════════════════════════════════════════════ */

.qic-message {
    display: flex;
    flex-direction: column;
    margin-bottom: var(--qic-space-4);
    animation: qic-fade-in 0.2s ease-out;
}

@keyframes qic-fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

.qic-message-header {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    margin-bottom: var(--qic-space-1);
}

.qic-message-avatar {
    font-size: 16px;
}

.qic-message-author {
    font-weight: 600;
    font-size: var(--qic-text-sm);
    color: var(--qic-fg-primary);
}

.qic-message-time {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
}

.qic-message-actions {
    margin-left: auto;
    opacity: 0;
    transition: opacity 0.15s;
}

.qic-message:hover .qic-message-actions {
    opacity: 1;
}

.qic-action-btn {
    background: none;
    border: none;
    color: var(--qic-fg-muted);
    cursor: pointer;
    padding: var(--qic-space-1);
    border-radius: var(--qic-radius-sm);
}

.qic-action-btn:hover {
    background: var(--qic-bg-tertiary);
    color: var(--qic-fg-primary);
}

.qic-message-content {
    padding: var(--qic-space-3);
    border-radius: var(--qic-radius-lg);
    line-height: 1.5;
}

/* User messages */
.qic-message-user .qic-message-content {
    background: var(--qic-accent-primary);
    color: white;
    margin-left: 20%;
}

/* Assistant messages */
.qic-message-assistant .qic-message-content {
    background: var(--qic-bg-secondary);
    margin-right: 10%;
}

/* System messages */
.qic-message-system {
    text-align: center;
}

.qic-message-system .qic-message-content {
    background: none;
    color: var(--qic-fg-muted);
    font-size: var(--qic-text-sm);
    font-style: italic;
}

/* ═══════════════════════════════════════════════════════════════════════
   CODE BLOCKS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-code-block {
    background: var(--qic-bg-tertiary);
    border-radius: var(--qic-radius-md);
    margin: var(--qic-space-2) 0;
    overflow: hidden;
}

.qic-code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--qic-space-1) var(--qic-space-2);
    background: rgba(0, 0, 0, 0.1);
    border-bottom: 1px solid var(--qic-border-default);
}

.qic-code-language {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
    text-transform: uppercase;
}

.qic-code-actions {
    display: flex;
    gap: var(--qic-space-1);
}

.qic-copy-code-btn,
.qic-insert-code-btn {
    background: none;
    border: none;
    color: var(--qic-fg-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--qic-radius-sm);
}

.qic-copy-code-btn:hover,
.qic-insert-code-btn:hover {
    background: var(--qic-bg-secondary);
    color: var(--qic-fg-primary);
}

.qic-code-block pre {
    margin: 0;
    padding: var(--qic-space-3);
    overflow-x: auto;
}

.qic-code-block code {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--qic-text-sm);
}

.qic-inline-code {
    background: var(--qic-bg-tertiary);
    padding: 2px 6px;
    border-radius: var(--qic-radius-sm);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
}

/* ═══════════════════════════════════════════════════════════════════════
   FILE REFERENCES
   ═══════════════════════════════════════════════════════════════════════ */

.qic-file-ref {
    color: var(--qic-accent-primary);
    text-decoration: none;
    border-bottom: 1px dashed currentColor;
    cursor: pointer;
}

.qic-file-ref:hover {
    text-decoration: underline;
}

/* ═══════════════════════════════════════════════════════════════════════
   TOOL CALL CARDS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-tool-call-card {
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    padding: var(--qic-space-2) var(--qic-space-3);
    margin: var(--qic-space-2) 0;
    margin-right: 10%;
}

.qic-tool-header {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
}

.qic-tool-icon .codicon {
    font-size: 14px;
}

.qic-tool-running .qic-tool-icon {
    color: var(--qic-accent-primary);
}

.qic-tool-complete .qic-tool-icon {
    color: var(--qic-status-success);
}

.qic-tool-error .qic-tool-icon {
    color: var(--qic-status-error);
}

.qic-tool-name {
    font-weight: 500;
    font-size: var(--qic-text-sm);
}

.qic-tool-status {
    margin-left: auto;
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
}

.qic-tool-args {
    margin-top: var(--qic-space-2);
    font-size: var(--qic-text-xs);
}

.qic-tool-args summary {
    cursor: pointer;
    color: var(--qic-fg-muted);
}

.qic-tool-args pre {
    margin: var(--qic-space-1) 0 0 0;
    padding: var(--qic-space-2);
    background: var(--qic-bg-tertiary);
    border-radius: var(--qic-radius-sm);
    overflow-x: auto;
}

.qic-tool-result {
    margin-top: var(--qic-space-2);
    font-size: var(--qic-text-xs);
}

.qic-tool-result pre {
    margin: 0;
    padding: var(--qic-space-2);
    background: var(--qic-bg-tertiary);
    border-radius: var(--qic-radius-sm);
    overflow-x: auto;
    max-height: 200px;
}

.qic-tool-result-error pre {
    border-left: 3px solid var(--qic-status-error);
}

.qic-spin {
    animation: qic-spin 1s linear infinite;
}

@keyframes qic-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

/* ═══════════════════════════════════════════════════════════════════════
   ERROR CARDS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-error-card {
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-status-error);
    border-radius: var(--qic-radius-md);
    padding: var(--qic-space-3);
    margin-top: var(--qic-space-2);
}

.qic-error-header {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    color: var(--qic-status-error);
}

.qic-error-title {
    font-weight: 600;
}

.qic-error-code {
    margin-left: auto;
    font-size: var(--qic-text-xs);
    background: var(--qic-bg-tertiary);
    padding: 2px 6px;
    border-radius: var(--qic-radius-sm);
}

.qic-error-message {
    margin-top: var(--qic-space-2);
    font-size: var(--qic-text-sm);
    color: var(--qic-fg-secondary);
}

.qic-error-actions {
    margin-top: var(--qic-space-3);
}

.qic-retry-btn {
    background: var(--qic-status-error);
    color: white;
    border: none;
    padding: var(--qic-space-1) var(--qic-space-3);
    border-radius: var(--qic-radius-md);
    cursor: pointer;
    font-size: var(--qic-text-sm);
}

.qic-retry-btn:hover {
    opacity: 0.9;
}

/* ═══════════════════════════════════════════════════════════════════════
   SCROLL BUTTON
   ═══════════════════════════════════════════════════════════════════════ */

.qic-scroll-btn {
    position: absolute;
    bottom: var(--qic-space-3);
    right: var(--qic-space-3);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--qic-bg-secondary);
    border: 1px solid var(--qic-border-default);
    color: var(--qic-fg-primary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--qic-shadow-md);
    z-index: 10;
}

.qic-scroll-btn:hover {
    background: var(--qic-bg-tertiary);
}

.qic-scroll-btn[hidden] {
    display: none;
}

/* ═══════════════════════════════════════════════════════════════════════
   MENTIONS
   ═══════════════════════════════════════════════════════════════════════ */

.qic-message-mentions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--qic-space-1);
    margin-top: var(--qic-space-2);
}

.qic-mention-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--qic-bg-tertiary);
    border-radius: var(--qic-radius-full);
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-secondary);
}

.qic-mention-chip .codicon {
    font-size: 12px;
}

/* ═══════════════════════════════════════════════════════════════════════
   CHANGES SUMMARY
   ═══════════════════════════════════════════════════════════════════════ */

.qic-changes-summary {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    margin-top: var(--qic-space-2);
    padding: var(--qic-space-2);
    background: var(--qic-bg-tertiary);
    border-radius: var(--qic-radius-md);
    font-size: var(--qic-text-sm);
}

.qic-view-changes-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--qic-accent-primary);
    cursor: pointer;
    font-size: var(--qic-text-sm);
}

.qic-view-changes-btn:hover {
    text-decoration: underline;
}

/* ═══════════════════════════════════════════════════════════════════════
   LOAD SENTINEL
   ═══════════════════════════════════════════════════════════════════════ */

.qic-load-sentinel {
    height: 1px;
    visibility: hidden;
}
```

### 5. Include in Webview HTML

```html
<script src="${messageManagerUri}"></script>
```

---

## Verification

### Success Criteria
- [ ] Messages render correctly by role
- [ ] User messages right-aligned
- [ ] Assistant messages left-aligned
- [ ] Code blocks render with copy/insert buttons
- [ ] File references are clickable
- [ ] Tool call cards display correctly
- [ ] Error cards display with retry button
- [ ] Scroll to bottom button appears when scrolled up
- [ ] State subscription works
- [ ] No XSS vulnerabilities (HTML escaped)

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| User message | Submit message | Appears right-aligned with avatar |
| File reference | Click [[path]] link | Opens file message sent |
| Copy code | Click copy on code block | Code copied, feedback shown |
| Tool call running | Trigger tool | Card shows spinning indicator |
| Tool call complete | Wait for tool | Card shows checkmark |
| Error | Trigger error | Red error card appears |
| Scroll button | Scroll up | Button appears |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/media/messageManager.js
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- This is the foundation for streaming (02-04)
- Markdown rendering is basic - can enhance with marked.js later
- Syntax highlighting deferred to Phase 6
- Branching UI deferred to Phase 6
- Consider adding message virtualization if performance issues arise
