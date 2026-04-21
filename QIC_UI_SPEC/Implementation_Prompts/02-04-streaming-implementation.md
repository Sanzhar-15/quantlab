# Prompt 02-04: Streaming Implementation (GAP-03 Fix)

**Phase:** 2 - Panel Structure
**Dependencies:** 02-03 (Conversation Structure), 01-05 (State Manager)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement smooth token streaming with buffered rendering, smart scroll-to-bottom, and incremental markdown rendering. This addresses GAP-03 from the audit.

---

## Context

The backend sends individual tokens via `streamChatToken(token: string)`. Without buffering:
- Rendering every token causes jank
- Scroll position jumps constantly
- Markdown re-parsing is expensive

Solution:
- Buffer tokens and render at ~60fps
- Only auto-scroll if user is near bottom
- Debounce markdown rendering

Reference: `QIC_UI_SPEC/Optimal_plan/04-PANEL-STRUCTURE.md` (GAP-03 FIX section)

---

## Scope

### In Scope
- Create `streamingManager.js` for webview
- Implement token buffering
- Implement debounced rendering
- Implement smart scroll behavior
- Implement incremental markdown rendering
- Handle stream start/complete lifecycle
- Wire to message handler

### Out of Scope
- Markdown library selection (use existing or basic)
- Syntax highlighting (Phase 6 polish)
- Full message rendering (handled by conversation area)

---

## Pre-Conditions

- [ ] 02-03 complete (conversation area structure exists)
- [ ] 01-05 complete (state manager available)
- [ ] Git branch created: `qic-ui/02-04-streaming`

---

## Tasks

### 1. Create Streaming Manager

```bash
touch src/vs/workbench/contrib/qic/browser/media/streamingManager.js
```

### 2. Implement Streaming Manager

```javascript
// src/vs/workbench/contrib/qic/browser/media/streamingManager.js
// @ts-nocheck
/**
 * QIC Streaming Manager
 * Handles token buffering and smooth rendering for streaming responses
 * GAP-03 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const CONFIG = {
        RENDER_INTERVAL_MS: 16,      // ~60fps
        MARKDOWN_DEBOUNCE_MS: 150,   // Re-render markdown max every 150ms
        SCROLL_THRESHOLD_PX: 100,    // Auto-scroll if within 100px of bottom
        MAX_BUFFER_SIZE: 10000,      // Flush if buffer exceeds this
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentStreamId = null;
    let tokenBuffer = '';
    let fullContent = '';
    let renderTimeoutId = null;
    let markdownTimeoutId = null;
    let streamElement = null;
    let renderedElement = null;
    let messagesContainer = null;
    let userScrolledAway = false;

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Start streaming a new message
     * @param {string} messageId
     */
    function startStream(messageId) {
        // Cleanup any existing stream
        if (currentStreamId) {
            console.warn('[Streaming] Starting new stream while one is active');
            completeStream(currentStreamId);
        }

        currentStreamId = messageId;
        tokenBuffer = '';
        fullContent = '';
        userScrolledAway = false;

        // Get or create message element
        messagesContainer = document.getElementById('messages');
        if (!messagesContainer) {
            console.error('[Streaming] Messages container not found');
            return;
        }

        // Create streaming message element
        const messageEl = createStreamingMessage(messageId);
        messagesContainer.appendChild(messageEl);

        streamElement = messageEl.querySelector('.qic-stream-text');
        renderedElement = messageEl.querySelector('.qic-rendered-content');

        // Initial scroll to bottom
        scrollToBottom(true);

        // Track if user scrolls away
        messagesContainer.addEventListener('scroll', handleScroll);

        console.log('[Streaming] Started:', messageId);
    }

    /**
     * Add tokens to the stream
     * @param {string} tokens
     */
    function addTokens(tokens) {
        if (!currentStreamId) {
            console.warn('[Streaming] Received tokens but no active stream');
            return;
        }

        tokenBuffer += tokens;
        fullContent += tokens;

        // Force render if buffer is large
        if (tokenBuffer.length > CONFIG.MAX_BUFFER_SIZE) {
            flushBuffer();
        }

        // Schedule render if not already scheduled
        if (!renderTimeoutId) {
            renderTimeoutId = setTimeout(flushBuffer, CONFIG.RENDER_INTERVAL_MS);
        }
    }

    /**
     * Complete the stream
     * @param {string} messageId
     * @param {Object} [metadata]
     */
    function completeStream(messageId, metadata) {
        if (currentStreamId !== messageId) {
            console.warn('[Streaming] Complete called for different stream');
        }

        // Flush any remaining tokens
        flushBuffer();

        // Clear timeouts
        if (renderTimeoutId) {
            clearTimeout(renderTimeoutId);
            renderTimeoutId = null;
        }
        if (markdownTimeoutId) {
            clearTimeout(markdownTimeoutId);
            markdownTimeoutId = null;
        }

        // Final markdown render
        renderMarkdown(true);

        // Update message element
        const messageEl = document.querySelector(`.qic-message[data-id="${messageId}"]`);
        if (messageEl) {
            messageEl.classList.remove('qic-streaming');

            // Remove cursor
            const cursor = messageEl.querySelector('.qic-cursor');
            cursor?.remove();

            // Update timestamp
            const timeEl = messageEl.querySelector('.qic-message-time');
            if (timeEl) {
                timeEl.textContent = formatTime(new Date());
            }

            // Show rendered content, hide raw
            if (streamElement) streamElement.hidden = true;
            if (renderedElement) renderedElement.hidden = false;
        }

        // Remove scroll listener
        messagesContainer?.removeEventListener('scroll', handleScroll);

        // Final scroll
        if (!userScrolledAway) {
            scrollToBottom(true);
        }

        // Reset state
        currentStreamId = null;
        streamElement = null;
        renderedElement = null;
        tokenBuffer = '';
        fullContent = '';

        console.log('[Streaming] Completed:', messageId);
    }

    /**
     * Cancel the current stream
     * @param {string} messageId
     */
    function cancelStream(messageId) {
        if (currentStreamId !== messageId && currentStreamId !== null) {
            console.warn('[Streaming] Cancel called for different stream');
            return;
        }

        // Flush buffer
        flushBuffer();

        // Clear timeouts
        if (renderTimeoutId) {
            clearTimeout(renderTimeoutId);
            renderTimeoutId = null;
        }
        if (markdownTimeoutId) {
            clearTimeout(markdownTimeoutId);
            markdownTimeoutId = null;
        }

        // Update message element
        const messageEl = document.querySelector(`.qic-message[data-id="${messageId}"]`);
        if (messageEl) {
            messageEl.classList.remove('qic-streaming');
            messageEl.classList.add('qic-cancelled');

            // Remove cursor, add cancelled indicator
            const cursor = messageEl.querySelector('.qic-cursor');
            cursor?.remove();

            const content = messageEl.querySelector('.qic-message-content');
            if (content && fullContent.trim()) {
                content.innerHTML += '<span class="qic-cancelled-indicator">[Cancelled]</span>';
            }
        }

        // Remove scroll listener
        messagesContainer?.removeEventListener('scroll', handleScroll);

        // Reset state
        currentStreamId = null;
        streamElement = null;
        renderedElement = null;
        tokenBuffer = '';
        fullContent = '';

        console.log('[Streaming] Cancelled:', messageId);
    }

    /**
     * Check if currently streaming
     * @returns {boolean}
     */
    function isStreaming() {
        return currentStreamId !== null;
    }

    /**
     * Get current stream ID
     * @returns {string|null}
     */
    function getStreamId() {
        return currentStreamId;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Internal Functions
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Flush the token buffer to the DOM
     */
    function flushBuffer() {
        renderTimeoutId = null;

        if (!tokenBuffer || !streamElement) return;

        // Append text content (safe from XSS)
        streamElement.textContent = fullContent;
        tokenBuffer = '';

        // Auto-scroll if near bottom
        if (!userScrolledAway && isNearBottom()) {
            scrollToBottom();
        }

        // Schedule markdown render
        scheduleMarkdownRender();
    }

    /**
     * Schedule markdown render (debounced)
     */
    function scheduleMarkdownRender() {
        if (markdownTimeoutId) return;

        markdownTimeoutId = setTimeout(() => {
            markdownTimeoutId = null;
            renderMarkdown(false);
        }, CONFIG.MARKDOWN_DEBOUNCE_MS);
    }

    /**
     * Render markdown content
     * @param {boolean} isFinal
     */
    function renderMarkdown(isFinal) {
        if (!renderedElement || !fullContent) return;

        try {
            // Use marked.js if available, otherwise basic rendering
            if (typeof marked !== 'undefined') {
                renderedElement.innerHTML = marked.parse(fullContent, {
                    breaks: true,
                    gfm: true
                });
            } else {
                // Basic fallback: preserve newlines, escape HTML
                renderedElement.innerHTML = escapeHtml(fullContent)
                    .replace(/\n/g, '<br>')
                    .replace(/`([^`]+)`/g, '<code>$1</code>');
            }

            // Syntax highlight code blocks if available
            if (isFinal && typeof hljs !== 'undefined') {
                renderedElement.querySelectorAll('pre code').forEach(block => {
                    hljs.highlightElement(block);
                });
            }
        } catch (e) {
            console.error('[Streaming] Markdown render error:', e);
            renderedElement.textContent = fullContent;
        }
    }

    /**
     * Check if scroll is near bottom
     * @returns {boolean}
     */
    function isNearBottom() {
        if (!messagesContainer) return true;

        const scrollBottom = messagesContainer.scrollHeight
            - messagesContainer.scrollTop
            - messagesContainer.clientHeight;

        return scrollBottom < CONFIG.SCROLL_THRESHOLD_PX;
    }

    /**
     * Scroll to bottom
     * @param {boolean} [instant=false]
     */
    function scrollToBottom(instant = false) {
        if (!messagesContainer) return;

        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: instant ? 'auto' : 'smooth'
        });
    }

    /**
     * Handle scroll events to detect user scrolling away
     */
    function handleScroll() {
        if (!isNearBottom()) {
            userScrolledAway = true;
        } else {
            userScrolledAway = false;
        }
    }

    /**
     * Create streaming message element
     * @param {string} messageId
     * @returns {HTMLElement}
     */
    function createStreamingMessage(messageId) {
        const article = document.createElement('article');
        article.className = 'qic-message qic-message-assistant qic-streaming';
        article.dataset.id = messageId;
        article.setAttribute('role', 'article');
        article.innerHTML = `
            <header class="qic-message-header">
                <span class="qic-message-author">QIC</span>
                <span class="qic-message-time" aria-live="polite">streaming...</span>
            </header>
            <div class="qic-message-content">
                <span class="qic-stream-text" aria-live="polite"></span>
                <span class="qic-cursor" aria-hidden="true"></span>
                <div class="qic-rendered-content" hidden></div>
            </div>
        `;
        return article;
    }

    /**
     * Format time for display
     * @param {Date} date
     * @returns {string}
     */
    function formatTime(date) {
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text
     * @returns {string}
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Export
    // ═══════════════════════════════════════════════════════════════════

    window.qicStreaming = {
        startStream,
        addTokens,
        completeStream,
        cancelStream,
        isStreaming,
        getStreamId,

        // For debugging
        _debug: {
            getBuffer: () => tokenBuffer,
            getFullContent: () => fullContent,
            forceFlush: flushBuffer
        }
    };

    console.log('[Streaming] Manager initialized');

})();
```

### 3. Add Streaming CSS

```css
/* ═══════════════════════════════════════════════════════════════════════
   STREAMING STYLES
   ═══════════════════════════════════════════════════════════════════════ */

.qic-streaming .qic-message-time {
    color: var(--qic-accent-primary);
    animation: qic-pulse 1.5s infinite;
}

.qic-cursor {
    display: inline-block;
    width: 2px;
    height: 1.1em;
    background: var(--qic-accent-primary);
    animation: qic-blink 1.06s infinite;
    vertical-align: text-bottom;
    margin-left: 2px;
}

@keyframes qic-blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
}

.qic-stream-text {
    white-space: pre-wrap;
    word-break: break-word;
}

.qic-rendered-content {
    /* Markdown content styles */
}

.qic-rendered-content code {
    background: var(--qic-bg-tertiary);
    padding: 2px 4px;
    border-radius: var(--qic-radius-sm);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
}

.qic-rendered-content pre {
    background: var(--qic-bg-tertiary);
    padding: var(--qic-space-2);
    border-radius: var(--qic-radius-md);
    overflow-x: auto;
}

.qic-rendered-content pre code {
    background: none;
    padding: 0;
}

.qic-cancelled-indicator {
    display: inline-block;
    margin-left: var(--qic-space-2);
    padding: 2px 6px;
    background: var(--qic-status-warning);
    color: white;
    border-radius: var(--qic-radius-sm);
    font-size: var(--qic-text-xs);
}
```

### 4. Wire to Message Handler

In main webview script:

```javascript
// Wire streaming manager to message handler
window.addEventListener('message', (event) => {
    const msg = event.data;

    // State messages handled by state manager
    if (window.qicState.handleMessage(msg)) {
        return;
    }

    // Streaming messages
    switch (msg.type) {
        case 'message:start':
            window.qicStreaming.startStream(msg.payload.id);
            break;

        case 'stream-token': // Legacy
        case 'message:chunk':
            const content = msg.payload?.content ?? msg.text;
            window.qicStreaming.addTokens(content);
            break;

        case 'message-complete': // Legacy
        case 'message:complete':
            const id = msg.payload?.id ?? msg.messageId;
            window.qicStreaming.completeStream(id, msg.payload?.metadata);
            break;

        case 'message:error':
            window.qicStreaming.cancelStream(msg.payload.id);
            // Also show error (handled elsewhere)
            break;

        // ... other handlers
    }
});
```

### 5. Include in Webview HTML

Update `getWebviewHtml()` to include the script:

```html
<script src="${streamingManagerUri}"></script>
```

---

## Verification

### Success Criteria
- [ ] Tokens buffer correctly (not rendering every token)
- [ ] Rendering is smooth (~60fps)
- [ ] Auto-scroll works when near bottom
- [ ] User can scroll up during streaming
- [ ] Scroll resumes when user returns to bottom
- [ ] Markdown renders correctly
- [ ] Cancel works and shows indicator
- [ ] No memory leaks

### Performance Test

1. Send a message that generates long response
2. Open DevTools Performance tab
3. Record during streaming
4. Verify no jank (consistent 60fps)

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Basic stream | Send message | Tokens appear smoothly |
| Auto-scroll | Send message, stay at bottom | Scrolls with content |
| Scroll away | Scroll up during stream | Doesn't force scroll |
| Scroll back | Return to bottom during stream | Resumes auto-scroll |
| Cancel | Click stop during stream | Shows [Cancelled] |
| Complete | Let stream finish | Timestamp updates |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/media/streamingManager.js
# Revert CSS changes
git checkout src/vs/workbench/contrib/qic/browser/media/chat.css
```

---

## Notes

- This is a significant UX improvement
- Buffer size and intervals can be tuned based on testing
- Consider adding metrics for streaming performance
- Markdown library (marked.js) may need to be bundled
