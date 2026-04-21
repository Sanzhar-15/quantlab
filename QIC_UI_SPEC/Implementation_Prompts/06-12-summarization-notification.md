# Prompt 06-12: Summarization Notification (GAP-09 Fix)

**Phase:** 6 - Polish
**Dependencies:** 02-04 (Streaming), 04-02 (Context Drawer)
**Estimated Effort:** 0.5 session
**Critical Path:** No

---

## Objective

Implement UI notifications when the backend auto-summarizes conversation context. Users need to understand when and why their earlier messages were compressed, and optionally view the summary. This addresses GAP-09 from the audit.

---

## Context

From GAP-09 in the audit:
- Backend auto-summarizes at 80% context budget threshold
- Uses `triggerSummarization()` in AgentOrchestrator
- Earlier messages are compressed into a summary
- Users may be confused when messages "change" or context seems lost

```typescript
// Backend behavior
const TOKEN_BUDGET_SUMMARIZE_THRESHOLD = 0.8;
if (tokenUsage > budget * TOKEN_BUDGET_SUMMARIZE_THRESHOLD) {
    await this.triggerSummarization();
}
```

Users need:
- Notification that summarization occurred
- Understanding of why (context limit reached)
- Option to view the summary
- Token savings information

---

## Scope

### In Scope
- Summarization notification toast/banner
- View summary option
- Token savings display
- Summarization in-progress indicator
- Summary viewer modal
- Accessibility announcements

### Out of Scope
- Backend summarization logic
- Summary quality tuning
- User-triggered manual summarization

---

## Pre-Conditions

- [ ] 02-04 complete (streaming)
- [ ] 04-02 complete (context drawer)
- [ ] Backend sends summarization events
- [ ] Git branch created: `qic-ui/06-12-summarization`

---

## Tasks

### 1. Define Summarization Types

```typescript
// src/vs/workbench/contrib/qic/common/types/summarization.ts

export interface SummarizationEvent {
    type: 'started' | 'completed' | 'failed';
    conversationId: string;
    messageCount?: number;      // Messages summarized
    tokensBefore?: number;      // Tokens before summarization
    tokensAfter?: number;       // Tokens after summarization
    tokensSaved?: number;       // Tokens freed up
    summary?: string;           // The summary text
    error?: string;
}

export interface SummarizationState {
    inProgress: boolean;
    lastSummarizedAt: number | null;
    totalSummarizations: number;
    totalTokensSaved: number;
}
```

### 2. Add Summarization Notification HTML

```html
<!-- Summarization Toast -->
<div id="summarization-toast" class="qic-summarization-toast" hidden aria-live="polite">
    <div class="qic-summarization-content">
        <span class="qic-summarization-icon codicon codicon-sparkle"></span>
        <div class="qic-summarization-text">
            <span class="qic-summarization-title">Context optimized</span>
            <span class="qic-summarization-desc">Earlier messages were summarized to free up space.</span>
        </div>
    </div>
    <div class="qic-summarization-actions">
        <button class="qic-btn-link" data-action="view-summary">View summary</button>
        <button class="qic-btn-link" data-action="dismiss">Dismiss</button>
    </div>
    <div class="qic-summarization-savings" hidden>
        <span class="codicon codicon-arrow-down"></span>
        <span class="savings-text"></span>
    </div>
</div>

<!-- Summarization In-Progress Banner -->
<div id="summarization-progress" class="qic-summarization-progress" hidden>
    <span class="codicon codicon-loading qic-spin"></span>
    <span>Optimizing context...</span>
</div>

<!-- Summary Viewer Modal -->
<div id="summary-viewer-modal" class="qic-modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="summary-title">
    <div class="qic-modal qic-summary-modal">
        <div class="qic-modal-header">
            <span class="codicon codicon-note"></span>
            <h3 id="summary-title">Conversation Summary</h3>
            <button class="qic-modal-close" aria-label="Close" data-action="close">
                <span class="codicon codicon-close"></span>
            </button>
        </div>
        <div class="qic-modal-body">
            <p class="qic-summary-info">
                This summary replaced <span id="summary-message-count">0</span> earlier messages,
                saving approximately <span id="summary-tokens-saved">0</span> tokens.
            </p>
            <div id="summary-content" class="qic-summary-content">
                <!-- Summary text rendered here -->
            </div>
        </div>
        <div class="qic-modal-footer">
            <button class="qic-btn primary" data-action="close">Close</button>
        </div>
    </div>
</div>
```

### 3. Add Summarization Styles

```css
/* ========================================
   Summarization Notification Styles
   ======================================== */

/* Toast notification */
.qic-summarization-toast {
    position: fixed;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 8px;
    box-shadow: var(--qic-shadow-lg);
    max-width: 400px;
    z-index: var(--qic-z-toast);
    animation: slideUp 0.3s ease-out;
}

@keyframes slideUp {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}

.qic-summarization-toast.hiding {
    animation: slideDown 0.2s ease-in forwards;
}

@keyframes slideDown {
    to {
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
    }
}

.qic-summarization-content {
    display: flex;
    align-items: flex-start;
    gap: 12px;
}

.qic-summarization-icon {
    font-size: 20px;
    color: var(--qic-accent-primary);
}

.qic-summarization-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.qic-summarization-title {
    font-weight: 600;
    font-size: 13px;
}

.qic-summarization-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-summarization-actions {
    display: flex;
    gap: 12px;
    margin-left: 32px;
}

.qic-btn-link {
    background: none;
    border: none;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
}

.qic-btn-link:hover {
    text-decoration: underline;
}

.qic-summarization-savings {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 32px;
    font-size: 11px;
    color: var(--qic-status-success);
}

.qic-summarization-savings .codicon {
    font-size: 12px;
}

/* In-progress banner */
.qic-summarization-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--qic-accent-primary-muted);
    color: var(--qic-accent-primary);
    font-size: 12px;
    border-bottom: 1px solid var(--qic-accent-primary);
}

.qic-summarization-progress .codicon {
    font-size: 14px;
}

/* Summary viewer modal */
.qic-summary-modal {
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
}

.qic-summary-info {
    margin: 0 0 16px 0;
    padding: 12px;
    background: var(--vscode-textBlockQuote-background);
    border-left: 3px solid var(--qic-accent-primary);
    border-radius: 0 4px 4px 0;
    font-size: 13px;
}

.qic-summary-info span {
    font-weight: 600;
    color: var(--qic-accent-primary);
}

.qic-summary-content {
    padding: 16px;
    background: var(--vscode-input-background);
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.6;
    max-height: 400px;
    overflow-y: auto;
}

.qic-summary-content p {
    margin: 0 0 12px 0;
}

.qic-summary-content p:last-child {
    margin-bottom: 0;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
    .qic-summarization-toast,
    .qic-summarization-toast.hiding {
        animation: none;
    }
}
```

### 4. Create Summarization Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/summarizationManager.js
// @ts-nocheck
/**
 * QIC Summarization Manager
 * Handles summarization notifications and summary viewing
 * GAP-09 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let state = {
        inProgress: false,
        lastSummary: null,
        lastEvent: null,
    };

    let dismissTimeout = null;

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const toast = document.getElementById('summarization-toast');
    const progressBanner = document.getElementById('summarization-progress');
    const modal = document.getElementById('summary-viewer-modal');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Handle summarization event from backend
     */
    function handleSummarizationEvent(event) {
        state.lastEvent = event;

        switch (event.type) {
            case 'started':
                showProgress();
                break;

            case 'completed':
                hideProgress();
                state.lastSummary = event.summary;
                showCompletionToast(event);
                break;

            case 'failed':
                hideProgress();
                showFailureToast(event);
                break;
        }
    }

    /**
     * Show the summary viewer modal
     */
    function showSummaryViewer() {
        if (!modal || !state.lastSummary) return;

        // Populate modal
        const messageCount = modal.querySelector('#summary-message-count');
        const tokensSaved = modal.querySelector('#summary-tokens-saved');
        const content = modal.querySelector('#summary-content');

        if (state.lastEvent) {
            messageCount.textContent = state.lastEvent.messageCount || '?';
            tokensSaved.textContent = formatTokens(state.lastEvent.tokensSaved);
        }

        content.innerHTML = formatSummary(state.lastSummary);

        modal.hidden = false;

        // Focus close button
        modal.querySelector('[data-action="close"]')?.focus();

        // Announce
        window.QicAnnouncer?.announce('Conversation summary opened');
    }

    /**
     * Hide the summary viewer modal
     */
    function hideSummaryViewer() {
        if (modal) {
            modal.hidden = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Progress Banner
    // ═══════════════════════════════════════════════════════════════════

    function showProgress() {
        state.inProgress = true;
        if (progressBanner) {
            progressBanner.hidden = false;
        }

        // Announce
        window.QicAnnouncer?.announce('Optimizing conversation context');
    }

    function hideProgress() {
        state.inProgress = false;
        if (progressBanner) {
            progressBanner.hidden = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Toast Notifications
    // ═══════════════════════════════════════════════════════════════════

    function showCompletionToast(event) {
        if (!toast) return;

        // Update savings display
        const savingsEl = toast.querySelector('.qic-summarization-savings');
        const savingsText = toast.querySelector('.savings-text');

        if (event.tokensSaved && savingsEl && savingsText) {
            savingsText.textContent = `${formatTokens(event.tokensSaved)} tokens freed`;
            savingsEl.hidden = false;
        } else if (savingsEl) {
            savingsEl.hidden = true;
        }

        // Show toast
        toast.hidden = false;
        toast.classList.remove('hiding');

        // Announce
        window.QicAnnouncer?.announce(
            `Context optimized. ${event.messageCount || 'Earlier'} messages were summarized, ` +
            `saving ${formatTokens(event.tokensSaved)} tokens.`
        );

        // Auto-dismiss after 10 seconds
        clearTimeout(dismissTimeout);
        dismissTimeout = setTimeout(() => {
            dismissToast();
        }, 10000);
    }

    function showFailureToast(event) {
        // Use error display system instead
        vscode.postMessage({
            type: 'notification',
            payload: {
                severity: 'warning',
                message: 'Context optimization failed. You may experience reduced context capacity.',
            }
        });
    }

    function dismissToast() {
        if (!toast) return;

        toast.classList.add('hiding');
        setTimeout(() => {
            toast.hidden = true;
            toast.classList.remove('hiding');
        }, 200);

        clearTimeout(dismissTimeout);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function formatTokens(tokens) {
        if (!tokens) return '0';
        if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toString();
    }

    function formatSummary(summary) {
        if (!summary) return '<p>Summary not available.</p>';

        // Convert markdown-style formatting
        return summary
            .split('\n\n')
            .map(para => `<p>${escapeHtml(para)}</p>`)
            .join('');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        // Toast actions
        toast?.querySelector('[data-action="view-summary"]')?.addEventListener('click', () => {
            dismissToast();
            showSummaryViewer();
        });

        toast?.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
            dismissToast();
        });

        // Modal actions
        modal?.querySelectorAll('[data-action="close"]').forEach(btn => {
            btn.addEventListener('click', hideSummaryViewer);
        });

        // Click outside modal
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideSummaryViewer();
            }
        });

        // Escape key
        modal?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideSummaryViewer();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Handling
    // ═══════════════════════════════════════════════════════════════════

    function handleMessage(message) {
        switch (message.type) {
            case 'summarization:started':
                handleSummarizationEvent({ type: 'started', ...message.payload });
                break;

            case 'summarization:completed':
                handleSummarizationEvent({ type: 'completed', ...message.payload });
                break;

            case 'summarization:failed':
                handleSummarizationEvent({ type: 'failed', ...message.payload });
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
    }

    // Export
    window.QicSummarizationManager = {
        handleSummarizationEvent,
        showSummaryViewer,
        hideSummaryViewer,
        handleMessage,
        init,
    };

    // Auto-init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
```

### 5. Wire to Message Handler

```javascript
// In main.js

case 'summarization:started':
case 'summarization:completed':
case 'summarization:failed':
    window.QicSummarizationManager?.handleMessage(message);
    break;
```

### 6. Backend Integration Points

```typescript
// In agentOrchestrator.ts - send events to UI

async triggerSummarization(): Promise<void> {
    // Notify UI that summarization started
    this.uiService.postMessage({
        type: 'summarization:started',
        payload: {
            conversationId: this.currentConversationId,
        }
    });

    try {
        const result = await this.summarizer.summarize(this.messages);

        // Notify UI of completion
        this.uiService.postMessage({
            type: 'summarization:completed',
            payload: {
                conversationId: this.currentConversationId,
                messageCount: result.summarizedCount,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                tokensSaved: result.tokensBefore - result.tokensAfter,
                summary: result.summaryText,
            }
        });
    } catch (error) {
        // Notify UI of failure
        this.uiService.postMessage({
            type: 'summarization:failed',
            payload: {
                conversationId: this.currentConversationId,
                error: error.message,
            }
        });
    }
}
```

---

## Verification

### Success Criteria
- [ ] Progress banner shows during summarization
- [ ] Toast notification appears after summarization
- [ ] Token savings displayed correctly
- [ ] "View summary" opens modal
- [ ] Summary content displayed correctly
- [ ] Dismiss button works
- [ ] Auto-dismiss after 10 seconds
- [ ] Failure notification shown on error
- [ ] Screen reader announces events

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Progress indicator | Trigger summarization | Banner shows |
| Completion toast | Wait for completion | Toast appears |
| View summary | Click "View summary" | Modal opens |
| Token savings | Check toast | Shows tokens saved |
| Dismiss | Click "Dismiss" | Toast hides |
| Auto-dismiss | Wait 10 seconds | Toast auto-hides |
| Failure | Force error | Warning notification |
| Accessibility | Use screen reader | Events announced |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/summarizationManager.js
```

---

## Notes

- Summarization is triggered by backend at 80% context budget
- Summary is stored for later viewing
- Toast auto-dismisses but summary remains accessible
- Consider adding "Don't show again" preference
- Summary quality depends on backend summarizer
