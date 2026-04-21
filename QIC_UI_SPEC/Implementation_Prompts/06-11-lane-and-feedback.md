# Prompt 06-11: Lane Indicator & Feedback Buttons

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete, 01-02 (State Service)
**Estimated Effort:** 1 session
**Critical Path:** No

---

## Objective

Implement the lane indicator that shows the current operational mode (Ask/Plan/Code) and feedback buttons that allow users to rate responses. This addresses GAP-12 (lane transition UI) and GAP-14 (quality signal service) from the audit.

---

## Context

From `08-SPEC-AMENDMENTS.md`:

**Lane System**: The codebase has different operational modes:
- `chat-ask`: Standard Q&A (16K context)
- `chat-gather`: Context gathering (32K context)
- `chat-plan`: Planning mode
- `chat-act`: Execution mode (200K context)

Users should see which mode they're in and understand mode transitions.

**Quality Signals**: The backend has `QualitySignalService` for collecting user feedback. Feedback buttons on messages help improve the system.

---

## Scope

### In Scope
- Lane indicator in header or status area
- Lane-specific styling/badges
- Lane transition notification
- Context limit display per lane
- Feedback buttons on assistant messages
- Feedback submission to backend
- Optional feedback text input

### Out of Scope
- Lane routing logic (backend)
- Feedback analysis
- A/B testing infrastructure

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] State service includes lane information
- [ ] QualitySignalService exists in backend
- [ ] Git branch created: `qic-ui/06-11-lane-feedback`

---

## Tasks

### 1. Define Lane and Feedback Types

```typescript
// src/vs/workbench/contrib/qic/common/types/lane.ts

export type Lane = 'chat-ask' | 'chat-gather' | 'chat-plan' | 'chat-act';

export interface LaneConfig {
    name: string;
    displayName: string;
    icon: string;
    maxContext: number;
    maxResponse: number;
    description: string;
}

export const LANE_CONFIGS: Record<Lane, LaneConfig> = {
    'chat-ask': {
        name: 'chat-ask',
        displayName: 'Ask',
        icon: 'comment-discussion',
        maxContext: 16000,
        maxResponse: 8000,
        description: 'Answer questions about code',
    },
    'chat-gather': {
        name: 'chat-gather',
        displayName: 'Gather',
        icon: 'search',
        maxContext: 32000,
        maxResponse: 16000,
        description: 'Gather context for complex tasks',
    },
    'chat-plan': {
        name: 'chat-plan',
        displayName: 'Plan',
        icon: 'checklist',
        maxContext: 64000,
        maxResponse: 16000,
        description: 'Plan implementation strategy',
    },
    'chat-act': {
        name: 'chat-act',
        displayName: 'Code',
        icon: 'code',
        maxContext: 200000,
        maxResponse: 32000,
        description: 'Execute code changes',
    },
};

// Feedback types
export type FeedbackRating = 'positive' | 'negative';

export interface FeedbackPayload {
    messageId: string;
    rating: FeedbackRating;
    comment?: string;
    tags?: string[];
}
```

### 2. Create Lane Indicator HTML

```html
<!-- Lane Indicator (in header or below) -->
<div id="lane-indicator" class="qic-lane-indicator" hidden>
    <button class="qic-lane-badge" aria-describedby="lane-tooltip">
        <span class="qic-lane-icon codicon"></span>
        <span class="qic-lane-name"></span>
    </button>
    <div id="lane-tooltip" class="qic-lane-tooltip" role="tooltip" hidden>
        <div class="qic-lane-tooltip-content">
            <span class="qic-lane-desc"></span>
            <span class="qic-lane-context">Context: <strong></strong></span>
        </div>
    </div>
</div>

<!-- Lane Transition Toast -->
<div id="lane-transition-toast" class="qic-lane-toast" hidden aria-live="polite">
    <span class="codicon"></span>
    <span class="qic-lane-toast-text"></span>
</div>
```

### 3. Create Feedback Buttons Template

```html
<!-- Add to message template -->
<div class="qic-message-feedback" hidden>
    <span class="qic-feedback-label">Was this helpful?</span>
    <button class="qic-feedback-btn" data-rating="positive" title="Yes, helpful">
        <span class="codicon codicon-thumbsup"></span>
    </button>
    <button class="qic-feedback-btn" data-rating="negative" title="No, not helpful">
        <span class="codicon codicon-thumbsdown"></span>
    </button>
</div>

<!-- Feedback Comment Modal -->
<div id="feedback-comment-modal" class="qic-modal-overlay" hidden>
    <div class="qic-modal qic-feedback-modal">
        <div class="qic-modal-header">
            <span id="feedback-modal-icon" class="codicon"></span>
            <h3 id="feedback-modal-title">Thanks for your feedback!</h3>
            <button class="qic-modal-close" aria-label="Close">
                <span class="codicon codicon-close"></span>
            </button>
        </div>
        <div class="qic-modal-body">
            <p class="qic-feedback-prompt">Would you like to tell us more? (optional)</p>
            <textarea
                id="feedback-comment"
                class="qic-feedback-textarea"
                placeholder="What could be better?"
                maxlength="500"
            ></textarea>
            <div class="qic-feedback-tags">
                <label class="qic-feedback-tag">
                    <input type="checkbox" value="incorrect"> Incorrect
                </label>
                <label class="qic-feedback-tag">
                    <input type="checkbox" value="incomplete"> Incomplete
                </label>
                <label class="qic-feedback-tag">
                    <input type="checkbox" value="confusing"> Confusing
                </label>
                <label class="qic-feedback-tag">
                    <input type="checkbox" value="slow"> Too slow
                </label>
            </div>
        </div>
        <div class="qic-modal-footer">
            <button class="qic-btn secondary" data-action="skip">Skip</button>
            <button class="qic-btn primary" data-action="submit">Submit</button>
        </div>
    </div>
</div>
```

### 4. Add Lane and Feedback Styles

```css
/* ========================================
   Lane Indicator Styles
   ======================================== */

.qic-lane-indicator {
    position: relative;
    display: inline-flex;
}

.qic-lane-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border: none;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.qic-lane-badge:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.qic-lane-icon {
    font-size: 12px;
}

/* Lane-specific colors */
.qic-lane-indicator[data-lane="chat-ask"] .qic-lane-badge {
    background: var(--qic-accent-primary-muted);
    color: var(--qic-accent-primary);
}

.qic-lane-indicator[data-lane="chat-plan"] .qic-lane-badge {
    background: var(--qic-status-warning-bg);
    color: var(--qic-status-warning);
}

.qic-lane-indicator[data-lane="chat-act"] .qic-lane-badge {
    background: var(--qic-status-success-bg);
    color: var(--qic-status-success);
}

/* Tooltip */
.qic-lane-tooltip {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 8px;
    padding: 8px 12px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 6px;
    box-shadow: var(--qic-shadow-lg);
    white-space: nowrap;
    z-index: var(--qic-z-dropdown);
}

.qic-lane-tooltip::before {
    content: '';
    position: absolute;
    top: -6px;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-bottom-color: var(--vscode-editorWidget-border);
}

.qic-lane-tooltip-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
}

.qic-lane-desc {
    color: var(--vscode-descriptionForeground);
}

.qic-lane-context {
    font-size: 11px;
}

/* Lane Transition Toast */
.qic-lane-toast {
    position: fixed;
    top: 60px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 6px;
    box-shadow: var(--qic-shadow-lg);
    font-size: 13px;
    z-index: var(--qic-z-toast);
    animation: slideDown 0.2s ease-out;
}

@keyframes slideDown {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(-10px);
    }
    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}

.qic-lane-toast.hiding {
    animation: slideUp 0.2s ease-in forwards;
}

@keyframes slideUp {
    to {
        opacity: 0;
        transform: translateX(-50%) translateY(-10px);
    }
}

/* ========================================
   Feedback Button Styles
   ======================================== */

.qic-message-feedback {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-widget-border);
    opacity: 0;
    transition: opacity 0.2s ease;
}

.message:hover .qic-message-feedback,
.message:focus-within .qic-message-feedback {
    opacity: 1;
}

.qic-message-feedback.submitted {
    opacity: 1;
}

.qic-feedback-label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-feedback-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    transition: all 0.15s ease;
}

.qic-feedback-btn:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
}

.qic-feedback-btn[data-rating="positive"]:hover,
.qic-feedback-btn[data-rating="positive"].selected {
    border-color: var(--qic-status-success);
    background: var(--qic-status-success-bg);
    color: var(--qic-status-success);
}

.qic-feedback-btn[data-rating="negative"]:hover,
.qic-feedback-btn[data-rating="negative"].selected {
    border-color: var(--qic-status-error);
    background: var(--qic-status-error-bg);
    color: var(--qic-status-error);
}

.qic-feedback-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Feedback Modal */
.qic-feedback-modal {
    width: 400px;
}

.qic-feedback-prompt {
    margin: 0 0 12px 0;
    font-size: 13px;
}

.qic-feedback-textarea {
    width: 100%;
    min-height: 80px;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
}

.qic-feedback-textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
}

.qic-feedback-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.qic-feedback-tag {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--vscode-button-secondaryBackground);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
}

.qic-feedback-tag:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.qic-feedback-tag input {
    margin: 0;
}

/* Feedback submitted state */
.qic-feedback-submitted {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--qic-status-success);
    font-size: 12px;
}

.qic-feedback-submitted .codicon {
    font-size: 14px;
}
```

### 5. Create Lane Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/laneManager.js
// @ts-nocheck
/**
 * QIC Lane Manager
 * Handles lane indicator and transitions
 * GAP-12 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════

    const LANE_CONFIGS = {
        'chat-ask': {
            displayName: 'Ask',
            icon: 'codicon-comment-discussion',
            maxContext: 16000,
            description: 'Answer questions about code',
        },
        'chat-gather': {
            displayName: 'Gather',
            icon: 'codicon-search',
            maxContext: 32000,
            description: 'Gather context for complex tasks',
        },
        'chat-plan': {
            displayName: 'Plan',
            icon: 'codicon-checklist',
            maxContext: 64000,
            description: 'Plan implementation strategy',
        },
        'chat-act': {
            displayName: 'Code',
            icon: 'codicon-code',
            maxContext: 200000,
            description: 'Execute code changes',
        },
    };

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentLane = null;
    let tooltipVisible = false;

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const indicator = document.getElementById('lane-indicator');
    const badge = indicator?.querySelector('.qic-lane-badge');
    const tooltip = document.getElementById('lane-tooltip');
    const toast = document.getElementById('lane-transition-toast');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Set the current lane
     */
    function setLane(lane) {
        const prevLane = currentLane;
        currentLane = lane;

        if (!indicator) return;

        const config = LANE_CONFIGS[lane];
        if (!config) {
            indicator.hidden = true;
            return;
        }

        // Update badge
        indicator.hidden = false;
        indicator.dataset.lane = lane;

        const icon = badge.querySelector('.qic-lane-icon');
        const name = badge.querySelector('.qic-lane-name');

        icon.className = `qic-lane-icon codicon ${config.icon}`;
        name.textContent = config.displayName;

        // Update tooltip
        const desc = tooltip.querySelector('.qic-lane-desc');
        const context = tooltip.querySelector('.qic-lane-context strong');

        desc.textContent = config.description;
        context.textContent = formatTokens(config.maxContext);

        // Show transition toast if lane changed
        if (prevLane && prevLane !== lane) {
            showTransitionToast(prevLane, lane);
        }

        // Update context drawer limit if available
        window.QicContextDrawer?.setLimit(config.maxContext);
    }

    /**
     * Get current lane config
     */
    function getCurrentConfig() {
        return currentLane ? LANE_CONFIGS[currentLane] : null;
    }

    /**
     * Get context limit for current lane
     */
    function getContextLimit() {
        return getCurrentConfig()?.maxContext || 16000;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Tooltip
    // ═══════════════════════════════════════════════════════════════════

    function showTooltip() {
        if (tooltip) {
            tooltip.hidden = false;
            tooltipVisible = true;
        }
    }

    function hideTooltip() {
        if (tooltip) {
            tooltip.hidden = true;
            tooltipVisible = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Transition Toast
    // ═══════════════════════════════════════════════════════════════════

    function showTransitionToast(fromLane, toLane) {
        if (!toast) return;

        const toConfig = LANE_CONFIGS[toLane];
        if (!toConfig) return;

        const icon = toast.querySelector('.codicon');
        const text = toast.querySelector('.qic-lane-toast-text');

        icon.className = `codicon ${toConfig.icon}`;
        text.textContent = `Switched to ${toConfig.displayName} mode`;

        toast.hidden = false;
        toast.classList.remove('hiding');

        // Announce for screen readers
        window.QicAnnouncer?.announce(`Mode changed to ${toConfig.displayName}`);

        // Auto-hide after 3 seconds
        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => {
                toast.hidden = true;
            }, 200);
        }, 3000);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function formatTokens(tokens) {
        if (tokens >= 1000) {
            return `${Math.round(tokens / 1000)}K`;
        }
        return tokens.toString();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        if (!badge) return;

        badge.addEventListener('mouseenter', showTooltip);
        badge.addEventListener('mouseleave', hideTooltip);
        badge.addEventListener('focus', showTooltip);
        badge.addEventListener('blur', hideTooltip);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
    }

    // Export
    window.QicLaneManager = {
        setLane,
        getCurrentConfig,
        getContextLimit,
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

### 6. Create Feedback Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/feedbackManager.js
// @ts-nocheck
/**
 * QIC Feedback Manager
 * Handles response ratings and feedback collection
 * GAP-14 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    const submittedFeedback = new Set(); // messageIds that have been rated
    let currentFeedback = null; // { messageId, rating }

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const modal = document.getElementById('feedback-comment-modal');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Add feedback buttons to a message element
     */
    function addFeedbackButtons(messageEl, messageId) {
        if (submittedFeedback.has(messageId)) {
            showSubmittedState(messageEl);
            return;
        }

        const feedbackArea = messageEl.querySelector('.qic-message-feedback');
        if (!feedbackArea) return;

        feedbackArea.hidden = false;

        // Wire up buttons
        feedbackArea.querySelectorAll('.qic-feedback-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                handleRatingClick(messageId, btn.dataset.rating, feedbackArea);
            });
        });
    }

    /**
     * Handle rating button click
     */
    function handleRatingClick(messageId, rating, feedbackArea) {
        // Update button states
        feedbackArea.querySelectorAll('.qic-feedback-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.rating === rating);
            btn.disabled = true;
        });

        currentFeedback = { messageId, rating };

        // For negative feedback, show comment modal
        if (rating === 'negative') {
            showCommentModal();
        } else {
            // Submit positive feedback immediately
            submitFeedback(messageId, rating);
            showSubmittedState(feedbackArea);
        }
    }

    /**
     * Submit feedback to backend
     */
    function submitFeedback(messageId, rating, comment, tags) {
        submittedFeedback.add(messageId);

        vscode.postMessage({
            type: 'quality-signal',
            payload: {
                messageId,
                rating,
                comment,
                tags,
            }
        });

        // Announce
        window.QicAnnouncer?.announce('Feedback submitted. Thank you!');
    }

    /**
     * Show submitted state
     */
    function showSubmittedState(feedbackArea) {
        if (feedbackArea instanceof Element) {
            feedbackArea.classList.add('submitted');
            feedbackArea.innerHTML = `
                <div class="qic-feedback-submitted">
                    <span class="codicon codicon-check"></span>
                    <span>Thanks for your feedback!</span>
                </div>
            `;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Comment Modal
    // ═══════════════════════════════════════════════════════════════════

    function showCommentModal() {
        if (!modal || !currentFeedback) return;

        const icon = modal.querySelector('#feedback-modal-icon');
        const title = modal.querySelector('#feedback-modal-title');

        icon.className = 'codicon codicon-thumbsdown';
        title.textContent = 'Sorry to hear that!';

        // Clear previous input
        modal.querySelector('#feedback-comment').value = '';
        modal.querySelectorAll('.qic-feedback-tag input').forEach(cb => {
            cb.checked = false;
        });

        modal.hidden = false;

        // Focus textarea
        modal.querySelector('#feedback-comment')?.focus();
    }

    function hideCommentModal() {
        if (modal) {
            modal.hidden = true;
        }
    }

    function handleCommentSubmit() {
        if (!currentFeedback) return;

        const comment = modal.querySelector('#feedback-comment')?.value || '';
        const tags = Array.from(modal.querySelectorAll('.qic-feedback-tag input:checked'))
            .map(cb => cb.value);

        submitFeedback(currentFeedback.messageId, currentFeedback.rating, comment, tags);

        hideCommentModal();

        // Update the original feedback area
        const messageEl = document.querySelector(`[data-message-id="${currentFeedback.messageId}"]`);
        if (messageEl) {
            const feedbackArea = messageEl.querySelector('.qic-message-feedback');
            showSubmittedState(feedbackArea);
        }

        currentFeedback = null;
    }

    function handleCommentSkip() {
        if (!currentFeedback) return;

        // Submit without comment
        submitFeedback(currentFeedback.messageId, currentFeedback.rating);

        hideCommentModal();

        // Update the original feedback area
        const messageEl = document.querySelector(`[data-message-id="${currentFeedback.messageId}"]`);
        if (messageEl) {
            const feedbackArea = messageEl.querySelector('.qic-message-feedback');
            showSubmittedState(feedbackArea);
        }

        currentFeedback = null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        if (!modal) return;

        // Modal actions
        modal.querySelector('[data-action="submit"]')?.addEventListener('click', handleCommentSubmit);
        modal.querySelector('[data-action="skip"]')?.addEventListener('click', handleCommentSkip);
        modal.querySelector('.qic-modal-close')?.addEventListener('click', handleCommentSkip);

        // Click outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                handleCommentSkip();
            }
        });

        // Escape key
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                handleCommentSkip();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
    }

    // Export
    window.QicFeedbackManager = {
        addFeedbackButtons,
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

### 7. Wire to Message Rendering

```javascript
// In messageManager.js - add feedback buttons to assistant messages

function renderMessage(message) {
    // ... existing rendering ...

    // Add feedback buttons to assistant messages
    if (message.role === 'assistant') {
        window.QicFeedbackManager?.addFeedbackButtons(messageEl, message.id);
    }
}
```

### 8. Wire to State Changes

```javascript
// In main.js or stateManager.js

// Update lane when state changes
window.QicStateManager?.onStateChange((newState) => {
    if (newState.lane) {
        window.QicLaneManager?.setLane(newState.lane);
    }
});
```

---

## Verification

### Success Criteria
- [ ] Lane indicator shows current mode
- [ ] Lane badge has correct icon and color
- [ ] Tooltip shows on hover/focus
- [ ] Lane transition toast appears on change
- [ ] Context limit updates with lane
- [ ] Feedback buttons appear on assistant messages
- [ ] Positive feedback submits immediately
- [ ] Negative feedback shows comment modal
- [ ] Comment and tags submit correctly
- [ ] Submitted state persists

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Lane display | Send question | "Ask" badge shown |
| Lane tooltip | Hover badge | Tooltip with context limit |
| Lane transition | Trigger mode change | Toast notification |
| Positive feedback | Click thumbs up | Submitted state |
| Negative feedback | Click thumbs down | Comment modal opens |
| Submit with tags | Select tags, submit | Feedback sent |
| Skip comment | Click Skip | Feedback sent without comment |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/laneManager.js
git checkout src/vs/workbench/contrib/qic/browser/media/feedbackManager.js
```

---

## Notes

- Lane is set by backend based on request analysis
- Feedback is opt-in (appears on hover)
- Comment modal only for negative feedback
- Consider making feedback configurable
- Tags help categorize issues
