# Prompt 02-10: First-Run Experience

**Phase:** 2 - Panel Structure
**Dependencies:** 02-08 (Panel Integration)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement the first-run onboarding experience that guides new users through provider selection, consent collection, and capability introduction. This is critical for user activation and compliance.

---

## Context

When QIC is first activated, users need to:
1. Select their LLM provider (QIC Cloud, BYOK, Ollama, Offline)
2. Consent to data usage (required for cloud providers)
3. Understand QIC capabilities
4. Optionally configure privacy tier

Without this flow, users cannot use QIC effectively and compliance requirements aren't met.

Reference: `QIC_UI_SPEC/QIC-UI-Specification-v1.4.md` Section 13

---

## Scope

### In Scope
- First-run detection logic
- Provider selection UI
- Consent collection flow
- Capability matrix display
- Privacy tier selection
- Persistence of first-run completion
- Skip/defer option for setup

### Out of Scope
- Provider configuration details (handled by provider service)
- API key validation (backend)
- Full settings UI

---

## Pre-Conditions

- [ ] 02-08 complete (panel integration working)
- [ ] State service available
- [ ] Provider service exists in backend
- [ ] Git branch created: `qic-ui/02-10-first-run`

---

## Tasks

### 1. Create First-Run Detection

```typescript
// src/vs/workbench/contrib/qic/browser/firstRun/firstRunService.ts

import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';

const FIRST_RUN_KEY = 'qic.firstRunComplete';
const FIRST_RUN_VERSION = 1;

export interface IFirstRunService {
    readonly _serviceBrand: undefined;
    readonly isFirstRun: boolean;
    readonly onDidCompleteFirstRun: Event<void>;

    completeFirstRun(): void;
    resetFirstRun(): void;
    showFirstRunIfNeeded(): Promise<boolean>;
}

export class FirstRunService extends Disposable implements IFirstRunService {
    readonly _serviceBrand: undefined;

    private _isFirstRun: boolean;
    private readonly _onDidCompleteFirstRun = this._register(new Emitter<void>());
    readonly onDidCompleteFirstRun = this._onDidCompleteFirstRun.event;

    constructor(
        @IStorageService private readonly storageService: IStorageService,
    ) {
        super();

        const storedVersion = this.storageService.getNumber(
            FIRST_RUN_KEY,
            StorageScope.APPLICATION,
            0
        );
        this._isFirstRun = storedVersion < FIRST_RUN_VERSION;
    }

    get isFirstRun(): boolean {
        return this._isFirstRun;
    }

    completeFirstRun(): void {
        this.storageService.store(
            FIRST_RUN_KEY,
            FIRST_RUN_VERSION,
            StorageScope.APPLICATION,
            StorageTarget.USER
        );
        this._isFirstRun = false;
        this._onDidCompleteFirstRun.fire();
    }

    resetFirstRun(): void {
        this.storageService.remove(FIRST_RUN_KEY, StorageScope.APPLICATION);
        this._isFirstRun = true;
    }

    async showFirstRunIfNeeded(): Promise<boolean> {
        if (!this._isFirstRun) {
            return false;
        }
        // Trigger first-run UI in webview
        return true;
    }
}
```

### 2. Create First-Run Wizard HTML

```html
<!-- First-Run Wizard Template -->
<div id="first-run-wizard" class="qic-first-run" role="dialog" aria-labelledby="first-run-title" hidden>
    <!-- Step indicator -->
    <div class="qic-first-run-progress">
        <div class="step" data-step="1"><span>1</span> Provider</div>
        <div class="step" data-step="2"><span>2</span> Consent</div>
        <div class="step" data-step="3"><span>3</span> Privacy</div>
        <div class="step" data-step="4"><span>4</span> Ready</div>
    </div>

    <!-- Step 1: Provider Selection -->
    <div class="qic-first-run-step" data-step="1">
        <h2 id="first-run-title">Welcome to QIC</h2>
        <p class="qic-first-run-subtitle">Choose how you'd like to connect to AI</p>

        <div class="qic-provider-options" role="radiogroup" aria-label="Select provider">
            <!-- QIC Cloud -->
            <button class="qic-provider-option" data-provider="qic-cloud" role="radio" aria-checked="false">
                <div class="qic-provider-icon">
                    <span class="codicon codicon-cloud"></span>
                </div>
                <div class="qic-provider-info">
                    <span class="qic-provider-name">QIC Cloud</span>
                    <span class="qic-provider-desc">Fastest, most capable. Managed by Quantlab.</span>
                </div>
                <span class="qic-provider-badge recommended">Recommended</span>
            </button>

            <!-- BYOK -->
            <button class="qic-provider-option" data-provider="byok" role="radio" aria-checked="false">
                <div class="qic-provider-icon">
                    <span class="codicon codicon-key"></span>
                </div>
                <div class="qic-provider-info">
                    <span class="qic-provider-name">Your API Key (BYOK)</span>
                    <span class="qic-provider-desc">Use your own OpenAI/Anthropic key.</span>
                </div>
            </button>

            <!-- Ollama -->
            <button class="qic-provider-option" data-provider="ollama" role="radio" aria-checked="false">
                <div class="qic-provider-icon">
                    <span class="codicon codicon-server"></span>
                </div>
                <div class="qic-provider-info">
                    <span class="qic-provider-name">Ollama (Local)</span>
                    <span class="qic-provider-desc">Run models locally. Requires Ollama installed.</span>
                </div>
            </button>

            <!-- Offline -->
            <button class="qic-provider-option" data-provider="offline" role="radio" aria-checked="false">
                <div class="qic-provider-icon">
                    <span class="codicon codicon-debug-disconnect"></span>
                </div>
                <div class="qic-provider-info">
                    <span class="qic-provider-name">Offline Mode</span>
                    <span class="qic-provider-desc">Basic features only. No AI capabilities.</span>
                </div>
            </button>
        </div>
    </div>

    <!-- Step 2: Consent -->
    <div class="qic-first-run-step" data-step="2" hidden>
        <h2>Data & Privacy</h2>
        <p class="qic-first-run-subtitle">QIC needs your consent to function</p>

        <div class="qic-consent-items">
            <!-- LLM Consent -->
            <div class="qic-consent-item">
                <label class="qic-consent-label">
                    <input type="checkbox" id="consent-llm" required>
                    <span class="qic-consent-text">
                        <strong>Send code to LLM</strong>
                        <span>Allow QIC to send code snippets and context to the language model for analysis and suggestions.</span>
                    </span>
                </label>
            </div>

            <!-- Embeddings Consent -->
            <div class="qic-consent-item">
                <label class="qic-consent-label">
                    <input type="checkbox" id="consent-embeddings">
                    <span class="qic-consent-text">
                        <strong>Code search indexing</strong>
                        <span>Allow QIC to create embeddings for semantic code search. Improves context accuracy.</span>
                    </span>
                </label>
            </div>

            <!-- Telemetry Consent -->
            <div class="qic-consent-item">
                <label class="qic-consent-label">
                    <input type="checkbox" id="consent-telemetry">
                    <span class="qic-consent-text">
                        <strong>Usage analytics</strong>
                        <span>Help improve QIC by sharing anonymous usage data. No code or content is shared.</span>
                    </span>
                </label>
            </div>
        </div>

        <p class="qic-consent-note">
            <span class="codicon codicon-info"></span>
            You can change these settings anytime in QIC Settings.
        </p>
    </div>

    <!-- Step 3: Privacy Tier -->
    <div class="qic-first-run-step" data-step="3" hidden>
        <h2>Privacy Level</h2>
        <p class="qic-first-run-subtitle">Choose your data sharing preference</p>

        <div class="qic-privacy-options" role="radiogroup" aria-label="Select privacy level">
            <button class="qic-privacy-option" data-tier="private" role="radio" aria-checked="false">
                <span class="codicon codicon-lock"></span>
                <div class="qic-privacy-info">
                    <span class="qic-privacy-name">Private</span>
                    <span class="qic-privacy-desc">No data shared beyond request processing. Conversations not stored on server.</span>
                </div>
            </button>

            <button class="qic-privacy-option selected" data-tier="anonymous-metrics" role="radio" aria-checked="true">
                <span class="codicon codicon-graph"></span>
                <div class="qic-privacy-info">
                    <span class="qic-privacy-name">Anonymous Metrics</span>
                    <span class="qic-privacy-desc">Share usage patterns to improve QIC. No code or conversation content shared.</span>
                </div>
                <span class="qic-privacy-badge">Default</span>
            </button>

            <button class="qic-privacy-option" data-tier="data-contributor" role="radio" aria-checked="false">
                <span class="codicon codicon-heart"></span>
                <div class="qic-privacy-info">
                    <span class="qic-privacy-name">Data Contributor</span>
                    <span class="qic-privacy-desc">Help train better models. Anonymized conversations may be used for improvement.</span>
                </div>
            </button>
        </div>
    </div>

    <!-- Step 4: Ready -->
    <div class="qic-first-run-step" data-step="4" hidden>
        <div class="qic-first-run-ready">
            <div class="qic-ready-icon">
                <span class="codicon codicon-sparkle"></span>
            </div>
            <h2>You're All Set!</h2>
            <p class="qic-first-run-subtitle">QIC is ready to help you code</p>

            <div class="qic-capability-matrix">
                <h3>What QIC Can Do</h3>
                <ul class="qic-capabilities">
                    <li><span class="codicon codicon-comment-discussion"></span> Answer questions about your code</li>
                    <li><span class="codicon codicon-edit"></span> Make code changes with your approval</li>
                    <li><span class="codicon codicon-search"></span> Search and understand your codebase</li>
                    <li><span class="codicon codicon-beaker"></span> Generate tests and documentation</li>
                    <li><span class="codicon codicon-history"></span> Create checkpoints before changes</li>
                </ul>
            </div>

            <div class="qic-quick-tips">
                <h3>Quick Tips</h3>
                <ul>
                    <li><kbd>Cmd+L</kbd> Focus QIC input anytime</li>
                    <li>Use <kbd>@</kbd> to mention files or symbols</li>
                    <li><kbd>Cmd+Shift+H</kbd> View conversation history</li>
                </ul>
            </div>
        </div>
    </div>

    <!-- Navigation -->
    <div class="qic-first-run-nav">
        <button id="first-run-back" class="qic-btn secondary" hidden>
            <span class="codicon codicon-chevron-left"></span> Back
        </button>
        <div class="qic-first-run-spacer"></div>
        <button id="first-run-skip" class="qic-btn tertiary">Skip for now</button>
        <button id="first-run-next" class="qic-btn primary">
            Continue <span class="codicon codicon-chevron-right"></span>
        </button>
    </div>
</div>
```

### 3. Add First-Run Styles

```css
/* ========================================
   First-Run Experience Styles
   ======================================== */

.qic-first-run {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background);
    z-index: 100;
    padding: 24px;
    overflow-y: auto;
}

/* Progress indicator */
.qic-first-run-progress {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 32px;
}

.qic-first-run-progress .step {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-first-run-progress .step span {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--vscode-button-secondaryBackground);
    font-weight: 600;
}

.qic-first-run-progress .step.active span {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.qic-first-run-progress .step.complete span {
    background: var(--qic-status-success);
    color: white;
}

.qic-first-run-progress .step.complete span::before {
    content: '✓';
}

/* Step content */
.qic-first-run-step {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 500px;
    margin: 0 auto;
}

.qic-first-run-step h2 {
    margin: 0 0 8px 0;
    font-size: 24px;
    font-weight: 600;
}

.qic-first-run-subtitle {
    margin: 0 0 24px 0;
    color: var(--vscode-descriptionForeground);
}

/* Provider options */
.qic-provider-options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
}

.qic-provider-option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s ease, background-color 0.15s ease;
}

.qic-provider-option:hover {
    border-color: var(--vscode-focusBorder);
}

.qic-provider-option[aria-checked="true"] {
    border-color: var(--vscode-button-background);
    background: var(--qic-accent-primary-muted);
}

.qic-provider-icon {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--vscode-button-secondaryBackground);
    border-radius: 8px;
    font-size: 20px;
}

.qic-provider-info {
    flex: 1;
    display: flex;
    flex-direction: column;
}

.qic-provider-name {
    font-weight: 600;
    margin-bottom: 2px;
}

.qic-provider-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-provider-badge {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 4px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.qic-provider-badge.recommended {
    background: var(--qic-status-success);
}

/* Consent items */
.qic-consent-items {
    width: 100%;
    text-align: left;
}

.qic-consent-item {
    padding: 16px;
    margin-bottom: 12px;
    background: var(--vscode-input-background);
    border-radius: 8px;
}

.qic-consent-label {
    display: flex;
    gap: 12px;
    cursor: pointer;
}

.qic-consent-label input[type="checkbox"] {
    width: 18px;
    height: 18px;
    margin-top: 2px;
    flex-shrink: 0;
}

.qic-consent-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.qic-consent-text strong {
    font-weight: 600;
}

.qic-consent-text span:last-child {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-consent-note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

/* Privacy options */
.qic-privacy-options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
}

.qic-privacy-option {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
}

.qic-privacy-option:hover {
    border-color: var(--vscode-focusBorder);
}

.qic-privacy-option[aria-checked="true"],
.qic-privacy-option.selected {
    border-color: var(--vscode-button-background);
    background: var(--qic-accent-primary-muted);
}

.qic-privacy-option > .codicon {
    font-size: 24px;
    margin-top: 4px;
}

.qic-privacy-info {
    flex: 1;
    display: flex;
    flex-direction: column;
}

.qic-privacy-name {
    font-weight: 600;
    margin-bottom: 4px;
}

.qic-privacy-desc {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}

.qic-privacy-badge {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}

/* Ready state */
.qic-first-run-ready {
    display: flex;
    flex-direction: column;
    align-items: center;
}

.qic-ready-icon {
    font-size: 48px;
    color: var(--qic-status-success);
    margin-bottom: 16px;
}

.qic-capability-matrix,
.qic-quick-tips {
    width: 100%;
    text-align: left;
    margin-top: 24px;
}

.qic-capability-matrix h3,
.qic-quick-tips h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 12px 0;
}

.qic-capabilities,
.qic-quick-tips ul {
    list-style: none;
    padding: 0;
    margin: 0;
}

.qic-capabilities li,
.qic-quick-tips li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    font-size: 13px;
}

.qic-quick-tips kbd {
    padding: 2px 6px;
    background: var(--vscode-keybindingLabel-background);
    border: 1px solid var(--vscode-keybindingLabel-border);
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--qic-font-mono);
}

/* Navigation */
.qic-first-run-nav {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 24px;
    border-top: 1px solid var(--vscode-widget-border);
    margin-top: 24px;
}

.qic-first-run-spacer {
    flex: 1;
}

.qic-btn.tertiary {
    background: transparent;
    color: var(--vscode-descriptionForeground);
}

.qic-btn.tertiary:hover {
    color: var(--vscode-foreground);
}
```

### 4. Create First-Run Manager JavaScript

```javascript
// src/vs/workbench/contrib/qic/browser/media/firstRunManager.js
// @ts-nocheck
/**
 * QIC First-Run Experience Manager
 * Handles the onboarding wizard flow
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    let currentStep = 1;
    const totalSteps = 4;

    const selections = {
        provider: null,
        consent: {
            llm: false,
            embeddings: false,
            telemetry: false
        },
        privacyTier: 'anonymous-metrics'
    };

    // ═══════════════════════════════════════════════════════════════════
    // DOM Elements
    // ═══════════════════════════════════════════════════════════════════

    const wizard = document.getElementById('first-run-wizard');
    const backBtn = document.getElementById('first-run-back');
    const nextBtn = document.getElementById('first-run-next');
    const skipBtn = document.getElementById('first-run-skip');

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    function show() {
        if (!wizard) return;
        wizard.hidden = false;
        currentStep = 1;
        updateUI();

        // Focus first provider option
        const firstOption = wizard.querySelector('.qic-provider-option');
        firstOption?.focus();
    }

    function hide() {
        if (!wizard) return;
        wizard.hidden = true;
    }

    function isVisible() {
        return wizard && !wizard.hidden;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Navigation
    // ═══════════════════════════════════════════════════════════════════

    function nextStep() {
        if (!validateCurrentStep()) {
            return;
        }

        if (currentStep < totalSteps) {
            currentStep++;
            updateUI();
        } else {
            completeSetup();
        }
    }

    function prevStep() {
        if (currentStep > 1) {
            currentStep--;
            updateUI();
        }
    }

    function skipSetup() {
        // Use defaults
        selections.provider = 'qic-cloud';
        selections.consent.llm = true;
        completeSetup();
    }

    function validateCurrentStep() {
        switch (currentStep) {
            case 1: // Provider
                if (!selections.provider) {
                    showError('Please select a provider');
                    return false;
                }
                return true;

            case 2: // Consent
                if (!selections.consent.llm && selections.provider !== 'offline') {
                    showError('LLM consent is required for AI features');
                    return false;
                }
                return true;

            case 3: // Privacy
            case 4: // Ready
                return true;

            default:
                return true;
        }
    }

    function updateUI() {
        // Update step visibility
        wizard.querySelectorAll('.qic-first-run-step').forEach(step => {
            const stepNum = parseInt(step.dataset.step, 10);
            step.hidden = stepNum !== currentStep;
        });

        // Update progress
        wizard.querySelectorAll('.qic-first-run-progress .step').forEach(step => {
            const stepNum = parseInt(step.dataset.step, 10);
            step.classList.toggle('active', stepNum === currentStep);
            step.classList.toggle('complete', stepNum < currentStep);
        });

        // Update navigation
        backBtn.hidden = currentStep === 1;
        skipBtn.hidden = currentStep === totalSteps;

        if (currentStep === totalSteps) {
            nextBtn.innerHTML = 'Get Started <span class="codicon codicon-sparkle"></span>';
        } else {
            nextBtn.innerHTML = 'Continue <span class="codicon codicon-chevron-right"></span>';
        }

        // Skip consent step for offline mode
        if (currentStep === 2 && selections.provider === 'offline') {
            nextStep();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Completion
    // ═══════════════════════════════════════════════════════════════════

    function completeSetup() {
        // Send configuration to host
        vscode.postMessage({
            type: 'first-run:complete',
            payload: {
                provider: selections.provider,
                consent: selections.consent,
                privacyTier: selections.privacyTier
            }
        });

        hide();

        // Announce completion
        window.QicAnnouncer?.announce('Setup complete. QIC is ready.');
    }

    // ═══════════════════════════════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════════════════════════════

    function setupEventListeners() {
        if (!wizard) return;

        // Navigation buttons
        nextBtn?.addEventListener('click', nextStep);
        backBtn?.addEventListener('click', prevStep);
        skipBtn?.addEventListener('click', skipSetup);

        // Provider selection
        wizard.querySelectorAll('.qic-provider-option').forEach(option => {
            option.addEventListener('click', () => {
                // Deselect all
                wizard.querySelectorAll('.qic-provider-option').forEach(o => {
                    o.setAttribute('aria-checked', 'false');
                });
                // Select clicked
                option.setAttribute('aria-checked', 'true');
                selections.provider = option.dataset.provider;
            });
        });

        // Consent checkboxes
        document.getElementById('consent-llm')?.addEventListener('change', (e) => {
            selections.consent.llm = e.target.checked;
        });
        document.getElementById('consent-embeddings')?.addEventListener('change', (e) => {
            selections.consent.embeddings = e.target.checked;
        });
        document.getElementById('consent-telemetry')?.addEventListener('change', (e) => {
            selections.consent.telemetry = e.target.checked;
        });

        // Privacy tier selection
        wizard.querySelectorAll('.qic-privacy-option').forEach(option => {
            option.addEventListener('click', () => {
                wizard.querySelectorAll('.qic-privacy-option').forEach(o => {
                    o.setAttribute('aria-checked', 'false');
                    o.classList.remove('selected');
                });
                option.setAttribute('aria-checked', 'true');
                option.classList.add('selected');
                selections.privacyTier = option.dataset.tier;
            });
        });

        // Keyboard navigation
        wizard.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                skipSetup();
            } else if (e.key === 'Enter' && e.target.classList.contains('qic-provider-option')) {
                nextStep();
            }
        });
    }

    function showError(message) {
        // Use existing notification system
        vscode.postMessage({
            type: 'notification',
            payload: { severity: 'warning', message }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Initialize
    // ═══════════════════════════════════════════════════════════════════

    function init() {
        setupEventListeners();
    }

    // Export
    window.QicFirstRun = {
        show,
        hide,
        isVisible,
        init
    };

    // Auto-init when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
```

### 5. Wire to Panel Integration

```typescript
// In qicPanel.ts - add first-run check

private async initializeWebview(): Promise<void> {
    // ... existing initialization ...

    // Check for first run
    if (this.firstRunService.isFirstRun) {
        this.postMessage({ type: 'show-first-run' });
    }
}

// Handle first-run completion
private handleMessage(message: WebviewMessage): void {
    switch (message.type) {
        case 'first-run:complete':
            this.handleFirstRunComplete(message.payload);
            break;
        // ... other cases
    }
}

private async handleFirstRunComplete(payload: FirstRunPayload): Promise<void> {
    // Configure provider
    await this.providerService.setProvider(payload.provider);

    // Store consent
    await this.consentStore.setConsent('llm', payload.consent.llm);
    await this.consentStore.setConsent('embeddings', payload.consent.embeddings);
    await this.consentStore.setConsent('telemetry', payload.consent.telemetry);

    // Set privacy tier
    await this.configService.setPrivacyTier(payload.privacyTier);

    // Mark first run complete
    this.firstRunService.completeFirstRun();

    // Initialize QIC with selected provider
    await this.qicService.initialize();
}
```

### 6. Message Handler in Webview

```javascript
// In main.js - handle show-first-run message
case 'show-first-run':
    window.QicFirstRun?.show();
    break;
```

---

## Verification

### Success Criteria
- [ ] First-run wizard shows on fresh install
- [ ] All 4 steps navigable
- [ ] Provider selection works
- [ ] Consent checkboxes functional
- [ ] Privacy tier selection works
- [ ] Skip button works with defaults
- [ ] Completion persists (doesn't show again)
- [ ] Keyboard navigation works
- [ ] Screen reader accessible

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Fresh install | Clear storage, reload | Wizard shows |
| Provider select | Click QIC Cloud | Option highlighted |
| Skip required consent | Skip LLM checkbox | Error shown |
| Complete flow | Fill all steps | Wizard hides, QIC ready |
| Persistence | Reload after complete | Wizard doesn't show |
| Keyboard nav | Tab through options | Focus visible |
| Escape key | Press Escape | Skips with defaults |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/firstRun/
git checkout src/vs/workbench/contrib/qic/browser/media/firstRunManager.js
```

---

## Notes

- First-run must complete before QIC features work
- Offline mode skips consent step
- Privacy tier affects what data is collected
- All settings changeable later in QIC Settings
- Consider A/B testing different flows
