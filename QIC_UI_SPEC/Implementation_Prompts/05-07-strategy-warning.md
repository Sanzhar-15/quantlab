# Prompt 05-07: Strategy File Warning

**Phase:** 5 - Changes & Diff
**Dependencies:** 05-01 (Change Cards), 05-03 (Approval Flow)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement the strategy file warning modal that appears when QIC is about to modify files in strategy folders. This is a critical safety feature for Quantlab where strategy files may affect live trading.

---

## Context

From the spec (Section 7) and constants:
- Files in `strategies/` or `live/` folders are considered strategy files
- When `qic.strategyConfirmation` is enabled, a warning modal must appear
- Users must acknowledge the risk before changes can be applied
- Modal includes checkbox confirmation and multiple action options

This prevents accidental modifications to live trading code.

Reference: `QIC_UI_SPEC/QIC-UI-Specification-v1.4.md` Section 7

---

## Scope

### In Scope
- Strategy file detection
- Warning modal UI
- Confirmation checkbox ("I understand this affects live trading")
- Session skip option ("Don't ask again this session")
- Action buttons (Cancel, Simulate First, Apply)
- Integration with approval flow

### Out of Scope
- Simulation execution (backend)
- Strategy folder configuration (settings)
- Actual file application (05-03)

---

## Pre-Conditions

- [ ] 05-01 complete (change cards exist)
- [ ] 05-03 complete (approval flow working)
- [ ] Git branch created: `qic-ui/05-07-strategy-warning`

---

## Tasks

### 1. Create Strategy Detection Service

```typescript
// src/vs/workbench/contrib/qic/browser/services/strategyDetectionService.ts

import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Disposable } from 'vs/base/common/lifecycle';

export interface IStrategyDetectionService {
    readonly _serviceBrand: undefined;
    isStrategyFile(filePath: string): boolean;
    getStrategyFiles(filePaths: string[]): string[];
    shouldShowWarning(): boolean;
    skipWarningForSession(): void;
}

export class StrategyDetectionService extends Disposable implements IStrategyDetectionService {
    readonly _serviceBrand: undefined;

    private sessionSkip = false;
    private strategyPatterns: RegExp[] = [];

    constructor(
        @IConfigurationService private readonly configService: IConfigurationService,
    ) {
        super();
        this.loadPatterns();

        this._register(this.configService.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('qic.strategyFolders')) {
                this.loadPatterns();
            }
        }));
    }

    private loadPatterns(): void {
        const folders = this.configService.getValue<string[]>('qic.strategyFolders') || [
            'strategies/',
            'live/',
        ];

        this.strategyPatterns = folders.map(folder => {
            // Convert folder pattern to regex
            const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|/)${escaped}`, 'i');
        });

        // Also match files with 'strategy' in the name
        this.strategyPatterns.push(/strategy/i);
    }

    isStrategyFile(filePath: string): boolean {
        return this.strategyPatterns.some(pattern => pattern.test(filePath));
    }

    getStrategyFiles(filePaths: string[]): string[] {
        return filePaths.filter(path => this.isStrategyFile(path));
    }

    shouldShowWarning(): boolean {
        const confirmationEnabled = this.configService.getValue<boolean>('qic.strategyConfirmation');
        return confirmationEnabled !== false && !this.sessionSkip;
    }

    skipWarningForSession(): void {
        this.sessionSkip = true;
    }
}
```

### 2. Create Strategy Warning Modal HTML

```html
<!-- Strategy Warning Modal -->
<div id="strategy-warning-modal" class="qic-modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="strategy-warning-title">
    <div class="qic-modal qic-strategy-modal">
        <div class="qic-modal-header">
            <span class="codicon codicon-warning qic-strategy-icon"></span>
            <h2 id="strategy-warning-title">Strategy File Warning</h2>
            <button class="qic-modal-close" aria-label="Close">
                <span class="codicon codicon-close"></span>
            </button>
        </div>

        <div class="qic-modal-body">
            <div class="qic-strategy-warning-banner">
                <span class="codicon codicon-warning"></span>
                <span>Changes may affect live trading</span>
            </div>

            <p class="qic-strategy-message">
                You're about to modify files in a strategy folder. These changes could impact live trading systems.
            </p>

            <div class="qic-strategy-files" id="strategy-files-list">
                <!-- Strategy files listed here -->
            </div>

            <div class="qic-strategy-confirmations">
                <label class="qic-confirm-checkbox required">
                    <input type="checkbox" id="strategy-understand-check" required>
                    <span>I understand this affects live trading</span>
                </label>

                <label class="qic-confirm-checkbox">
                    <input type="checkbox" id="strategy-session-skip">
                    <span>Don't ask again this session</span>
                </label>
            </div>
        </div>

        <div class="qic-modal-footer">
            <button class="qic-btn secondary" data-action="cancel">
                Cancel
            </button>
            <button class="qic-btn secondary" data-action="simulate">
                <span class="codicon codicon-beaker"></span> Simulate First
            </button>
            <button class="qic-btn primary" data-action="apply" disabled>
                <span class="codicon codicon-check"></span> Apply
            </button>
        </div>
    </div>
</div>
```

### 3. Add Strategy Modal Styles

```css
/* ========================================
   Strategy Warning Modal Styles
   ======================================== */

.qic-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--qic-z-modal);
    animation: fadeIn 0.15s ease-out;
}

.qic-modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 8px;
    width: 90%;
    max-width: 480px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--qic-shadow-lg);
    animation: scaleIn 0.15s ease-out;
}

@keyframes scaleIn {
    from {
        opacity: 0;
        transform: scale(0.95);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

.qic-strategy-modal {
    border-color: var(--qic-strategy-border);
}

.qic-modal-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--vscode-widget-border);
}

.qic-strategy-icon {
    font-size: 24px;
    color: var(--qic-status-warning);
}

.qic-modal-header h2 {
    flex: 1;
    margin: 0;
    font-size: 16px;
    font-weight: 600;
}

.qic-modal-close {
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: var(--vscode-foreground);
    opacity: 0.7;
}

.qic-modal-close:hover {
    opacity: 1;
}

.qic-modal-body {
    flex: 1;
    padding: 20px;
    overflow-y: auto;
}

.qic-strategy-warning-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: var(--qic-strategy-bg);
    border: 1px solid var(--qic-strategy-border);
    border-radius: 6px;
    margin-bottom: 16px;
    font-weight: 600;
    color: var(--qic-status-warning);
}

.qic-strategy-message {
    margin: 0 0 16px 0;
    line-height: 1.5;
}

.qic-strategy-files {
    margin-bottom: 20px;
    padding: 12px;
    background: var(--vscode-input-background);
    border-radius: 6px;
    max-height: 150px;
    overflow-y: auto;
}

.qic-strategy-file {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    font-family: var(--qic-font-mono);
    font-size: 12px;
}

.qic-strategy-file .codicon {
    color: var(--qic-status-warning);
}

.qic-strategy-confirmations {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.qic-confirm-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.qic-confirm-checkbox input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
}

.qic-confirm-checkbox.required span {
    font-weight: 600;
}

.qic-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid var(--vscode-widget-border);
}

.qic-modal-footer .qic-btn[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Focus trap indicator */
.qic-modal:focus-within {
    outline: none;
}
```

### 4. Create Strategy Warning Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/strategyWarningManager.js
// @ts-nocheck
/**
 * QIC Strategy Warning Manager
 * Handles the strategy file warning modal
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentResolve = null;
    let currentChangeSetId = null;
    let focusTrap = null;
    let previouslyFocused = null;

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const modal = document.getElementById('strategy-warning-modal');
    const filesList = document.getElementById('strategy-files-list');
    const understandCheck = document.getElementById('strategy-understand-check');
    const sessionSkipCheck = document.getElementById('strategy-session-skip');
    const applyBtn = modal?.querySelector('[data-action="apply"]');
    const cancelBtn = modal?.querySelector('[data-action="cancel"]');
    const simulateBtn = modal?.querySelector('[data-action="simulate"]');
    const closeBtn = modal?.querySelector('.qic-modal-close');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Show the strategy warning modal
     * @param {string} changeSetId
     * @param {string[]} strategyFiles - List of strategy file paths
     * @returns {Promise<{action: 'apply' | 'simulate' | 'cancel', skipSession: boolean}>}
     */
    function show(changeSetId, strategyFiles) {
        return new Promise((resolve) => {
            currentResolve = resolve;
            currentChangeSetId = changeSetId;

            // Populate files list
            populateFilesList(strategyFiles);

            // Reset checkboxes
            understandCheck.checked = false;
            sessionSkipCheck.checked = false;
            updateApplyButton();

            // Show modal
            modal.hidden = false;

            // Focus trap
            previouslyFocused = document.activeElement;
            setupFocusTrap();

            // Focus first interactive element
            understandCheck.focus();

            // Announce for screen readers
            window.QicAnnouncer?.announce('Strategy file warning. Please review before proceeding.');
        });
    }

    /**
     * Hide the modal
     */
    function hide() {
        if (!modal) return;

        modal.hidden = true;
        removeFocusTrap();

        // Restore focus
        previouslyFocused?.focus();

        currentResolve = null;
        currentChangeSetId = null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // File List
    // ═══════════════════════════════════════════════════════════════════

    function populateFilesList(files) {
        if (!filesList) return;

        filesList.innerHTML = '';

        files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'qic-strategy-file';
            item.innerHTML = `
                <span class="codicon codicon-warning"></span>
                <span>${escapeHtml(file)}</span>
            `;
            filesList.appendChild(item);
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Button State
    // ═══════════════════════════════════════════════════════════════════

    function updateApplyButton() {
        if (applyBtn) {
            applyBtn.disabled = !understandCheck.checked;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Actions
    // ═══════════════════════════════════════════════════════════════════

    function handleApply() {
        if (!understandCheck.checked) return;

        resolveWith('apply');
    }

    function handleSimulate() {
        resolveWith('simulate');
    }

    function handleCancel() {
        resolveWith('cancel');
    }

    function resolveWith(action) {
        const skipSession = sessionSkipCheck?.checked || false;

        hide();

        if (currentResolve) {
            currentResolve({
                action,
                skipSession,
            });
        }

        // If skipping for session, notify host
        if (skipSession && action !== 'cancel') {
            vscode.postMessage({
                type: 'strategy:skip-session',
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Focus Trap
    // ═══════════════════════════════════════════════════════════════════

    function setupFocusTrap() {
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];

        focusTrap = (e) => {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    if (document.activeElement === firstFocusable) {
                        e.preventDefault();
                        lastFocusable.focus();
                    }
                } else {
                    if (document.activeElement === lastFocusable) {
                        e.preventDefault();
                        firstFocusable.focus();
                    }
                }
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        };

        modal.addEventListener('keydown', focusTrap);
    }

    function removeFocusTrap() {
        if (focusTrap) {
            modal.removeEventListener('keydown', focusTrap);
            focusTrap = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        if (!modal) return;

        // Checkbox change
        understandCheck?.addEventListener('change', updateApplyButton);

        // Button clicks
        applyBtn?.addEventListener('click', handleApply);
        simulateBtn?.addEventListener('click', handleSimulate);
        cancelBtn?.addEventListener('click', handleCancel);
        closeBtn?.addEventListener('click', handleCancel);

        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                handleCancel();
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
    window.QicStrategyWarning = {
        show,
        hide,
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

### 5. Integrate with Approval Flow

```javascript
// In approvalManager.js - add strategy check before approval

async function acceptAllChanges(changeSetId) {
    const changeSet = getChangeSet(changeSetId);
    if (!changeSet) return;

    // Check for strategy files
    const strategyFiles = changeSet.changes
        .map(c => c.filePath)
        .filter(path => isStrategyFile(path));

    if (strategyFiles.length > 0 && shouldShowStrategyWarning()) {
        const result = await window.QicStrategyWarning.show(changeSetId, strategyFiles);

        switch (result.action) {
            case 'cancel':
                return; // Do nothing

            case 'simulate':
                // Request simulation from host
                vscode.postMessage({
                    type: 'changes:simulate',
                    payload: { changeSetId }
                });
                return;

            case 'apply':
                // Continue with apply
                break;
        }
    }

    // Proceed with normal approval
    for (const change of changeSet.changes) {
        acceptChange(changeSetId, change.id);
    }
}

function isStrategyFile(path) {
    const patterns = ['strategies/', 'live/', 'strategy'];
    return patterns.some(p => path.toLowerCase().includes(p.toLowerCase()));
}

function shouldShowStrategyWarning() {
    // Check if warning hasn't been skipped for session
    return !window._strategyWarningSkipped;
}
```

### 6. Handle Host Messages

```javascript
// In main.js - handle strategy warning request from host

case 'strategy:show-warning':
    // Host detected strategy files in changes
    window.QicStrategyWarning?.show(
        message.payload.changeSetId,
        message.payload.strategyFiles
    ).then(result => {
        vscode.postMessage({
            type: 'strategy:warning-response',
            payload: {
                changeSetId: message.payload.changeSetId,
                ...result
            }
        });
    });
    break;
```

---

## Verification

### Success Criteria
- [ ] Modal appears for strategy folder files
- [ ] Modal appears for files with "strategy" in name
- [ ] Cannot click Apply until checkbox checked
- [ ] Cancel closes modal without applying
- [ ] Simulate sends request to host
- [ ] Apply proceeds with changes
- [ ] Session skip works (no further warnings)
- [ ] Focus trap works (Tab cycles within modal)
- [ ] Escape closes modal
- [ ] Click outside closes modal
- [ ] Screen reader announces warning

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Strategy folder | Modify `strategies/algo.py` | Warning modal shows |
| Live folder | Modify `live/trader.py` | Warning modal shows |
| Non-strategy | Modify `src/utils.py` | No warning |
| Checkbox required | Try to click Apply | Button disabled |
| After checkbox | Check box, click Apply | Changes apply |
| Cancel | Click Cancel | Modal closes, no changes |
| Simulate | Click Simulate | Simulation triggered |
| Session skip | Check skip, apply, modify again | No second warning |
| Focus trap | Tab repeatedly | Stays in modal |
| Escape | Press Escape | Modal closes |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/services/strategyDetectionService.ts
git checkout src/vs/workbench/contrib/qic/browser/media/strategyWarningManager.js
```

---

## Notes

- Strategy patterns are configurable via `qic.strategyFolders`
- Session skip resets on VS Code restart
- Simulate button requires backend support
- Consider adding "always skip" setting
- Warning should not appear in offline/demo mode
