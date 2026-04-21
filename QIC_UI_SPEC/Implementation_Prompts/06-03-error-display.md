# Prompt 06-03: Error Display

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement consistent, user-friendly error display throughout the QIC UI. Errors should be clear, actionable, and recoverable where possible. This includes connection errors, API errors, validation errors, and file operation failures.

---

## Context

Good error handling requires:
- Clear error messages (what went wrong)
- Actionable guidance (how to fix it)
- Appropriate severity indication
- Recovery options when possible
- Accessibility (errors announced)

Error types in QIC:
- **Connection errors**: Network, provider unavailable
- **API errors**: Rate limits, auth failures, server errors
- **Validation errors**: Invalid input, missing context
- **Operation errors**: File write failures, conflicts
- **Internal errors**: Unexpected exceptions

Reference: `QIC_UI_SPEC/Optimal_plan/11-ERROR-HANDLING.md`

---

## Scope

### In Scope
- Error message component/styles
- Error display in conversation
- Error display in status bar
- Inline validation errors
- Error recovery actions
- Error state management
- Accessible error announcements

### Out of Scope
- Error logging/telemetry
- Error retry logic (backend)
- Custom error boundaries

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] State service implemented
- [ ] Git branch created: `qic-ui/06-03-error-display`

---

## Tasks

### 1. Define Error Types

```typescript
// src/vs/workbench/contrib/qic/common/types/errors.ts

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type ErrorCategory =
  | 'connection'
  | 'authentication'
  | 'rate_limit'
  | 'validation'
  | 'operation'
  | 'internal';

export interface QicError {
  id: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  title: string;
  message: string;
  details?: string;
  timestamp: number;

  // Recovery
  recoverable: boolean;
  retryAction?: string;
  helpLink?: string;

  // Context
  component?: string;
  operationId?: string;
}

export interface ErrorDisplayOptions {
  showInline?: boolean;      // Show in conversation
  showNotification?: boolean; // Show VS Code notification
  showStatusBar?: boolean;   // Show in status bar
  autoDismiss?: number;      // Auto-dismiss after ms (0 = never)
}
```

### 2. Create Error Message Component

```html
<!-- Error Message Template -->
<template id="error-message-template">
  <div class="qic-error" role="alert" aria-live="assertive">
    <div class="qic-error-header">
      <span class="qic-error-icon codicon"></span>
      <span class="qic-error-title"></span>
      <button class="qic-error-dismiss" aria-label="Dismiss error">
        <span class="codicon codicon-close"></span>
      </button>
    </div>
    <div class="qic-error-body">
      <p class="qic-error-message"></p>
      <details class="qic-error-details">
        <summary>Details</summary>
        <pre class="qic-error-details-content"></pre>
      </details>
    </div>
    <div class="qic-error-actions">
      <!-- Action buttons inserted here -->
    </div>
  </div>
</template>

<!-- Inline Validation Error -->
<template id="validation-error-template">
  <div class="qic-validation-error" role="alert">
    <span class="codicon codicon-error"></span>
    <span class="validation-message"></span>
  </div>
</template>
```

### 3. Add Error Styles

```css
/* ========================================
   Error Message Styles
   ======================================== */

.qic-error {
  margin: 12px 0;
  border-radius: 6px;
  overflow: hidden;
  border-left: 4px solid;
}

/* Severity variants */
.qic-error[data-severity="info"] {
  background: var(--vscode-inputValidation-infoBackground);
  border-color: var(--vscode-inputValidation-infoBorder);
}

.qic-error[data-severity="warning"] {
  background: var(--vscode-inputValidation-warningBackground);
  border-color: var(--vscode-inputValidation-warningBorder);
}

.qic-error[data-severity="error"] {
  background: var(--vscode-inputValidation-errorBackground);
  border-color: var(--vscode-inputValidation-errorBorder);
}

.qic-error[data-severity="critical"] {
  background: var(--vscode-inputValidation-errorBackground);
  border-color: var(--vscode-errorForeground);
}

/* Header */
.qic-error-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.1);
}

.qic-error-icon {
  font-size: 16px;
}

.qic-error[data-severity="info"] .qic-error-icon::before {
  content: "\ea74"; /* info */
  color: var(--vscode-inputValidation-infoBorder);
}

.qic-error[data-severity="warning"] .qic-error-icon::before {
  content: "\ea6c"; /* warning */
  color: var(--vscode-inputValidation-warningBorder);
}

.qic-error[data-severity="error"] .qic-error-icon::before,
.qic-error[data-severity="critical"] .qic-error-icon::before {
  content: "\eb5d"; /* error */
  color: var(--vscode-errorForeground);
}

.qic-error-title {
  flex: 1;
  font-weight: 600;
  font-size: 13px;
}

.qic-error-dismiss {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 4px;
  opacity: 0.7;
  border-radius: 4px;
}

.qic-error-dismiss:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

/* Body */
.qic-error-body {
  padding: 10px 12px;
}

.qic-error-message {
  margin: 0 0 8px 0;
  font-size: 13px;
  line-height: 1.5;
}

.qic-error-details {
  font-size: 12px;
}

.qic-error-details summary {
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
}

.qic-error-details summary:hover {
  text-decoration: underline;
}

.qic-error-details-content {
  margin: 8px 0 0 0;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  overflow-x: auto;
  white-space: pre-wrap;
}

/* Actions */
.qic-error-actions {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.qic-error-action {
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}

.qic-error-action.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
}

.qic-error-action.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
}

/* ========================================
   Validation Error (Inline)
   ======================================== */

.qic-validation-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-top: 4px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-inputValidation-errorForeground);
}

.qic-validation-error .codicon {
  flex-shrink: 0;
}

/* ========================================
   Connection Error Banner
   ======================================== */

.qic-connection-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--vscode-inputValidation-warningBackground);
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
}

.qic-connection-error-message {
  flex: 1;
  font-size: 13px;
}

.qic-connection-error-retry {
  padding: 4px 12px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
```

### 4. Implement Error Manager

```javascript
// In main.js

class ErrorManager {
  constructor() {
    this.errors = new Map();
    this.template = document.getElementById('error-message-template');
    this.container = document.getElementById('conversation');
    this.announcer = document.getElementById('qic-announcer');

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Delegate error dismissal
    document.addEventListener('click', (e) => {
      if (e.target.closest('.qic-error-dismiss')) {
        const errorEl = e.target.closest('.qic-error');
        this.dismiss(errorEl?.dataset.errorId);
      }

      if (e.target.closest('.qic-error-action[data-action]')) {
        const btn = e.target.closest('.qic-error-action');
        const errorEl = e.target.closest('.qic-error');
        this.handleAction(errorEl?.dataset.errorId, btn.dataset.action);
      }
    });
  }

  /**
   * Display an error
   */
  show(error, options = {}) {
    const {
      showInline = true,
      showNotification = false,
      showStatusBar = true,
      autoDismiss = 0
    } = options;

    // Store error
    this.errors.set(error.id, error);

    // Show inline
    if (showInline) {
      this.renderInlineError(error);
    }

    // Show notification
    if (showNotification) {
      this.showNotification(error);
    }

    // Update status bar
    if (showStatusBar) {
      this.updateStatusBar(error);
    }

    // Announce for screen readers
    this.announce(error);

    // Auto-dismiss
    if (autoDismiss > 0) {
      setTimeout(() => this.dismiss(error.id), autoDismiss);
    }

    return error.id;
  }

  /**
   * Render error in conversation
   */
  renderInlineError(error) {
    const errorEl = this.template.content.cloneNode(true);
    const container = errorEl.querySelector('.qic-error');

    container.dataset.errorId = error.id;
    container.dataset.severity = error.severity;

    // Set content
    container.querySelector('.qic-error-title').textContent = error.title;
    container.querySelector('.qic-error-message').textContent = error.message;

    // Details
    const details = container.querySelector('.qic-error-details');
    if (error.details) {
      details.querySelector('.qic-error-details-content').textContent = error.details;
    } else {
      details.remove();
    }

    // Actions
    const actionsContainer = container.querySelector('.qic-error-actions');
    if (error.recoverable && error.retryAction) {
      actionsContainer.innerHTML = `
        <button class="qic-error-action primary" data-action="retry">
          Try Again
        </button>
        ${error.helpLink ? `
          <a class="qic-error-action secondary" href="${error.helpLink}" target="_blank">
            Learn More
          </a>
        ` : ''}
      `;
    } else if (error.helpLink) {
      actionsContainer.innerHTML = `
        <a class="qic-error-action secondary" href="${error.helpLink}" target="_blank">
          Learn More
        </a>
      `;
    } else {
      actionsContainer.remove();
    }

    // Insert in conversation
    this.container.appendChild(container);
    this.scrollToError(container);
  }

  /**
   * Show VS Code notification
   */
  showNotification(error) {
    vscode.postMessage({
      type: 'error:notification',
      error: {
        severity: error.severity,
        title: error.title,
        message: error.message,
      }
    });
  }

  /**
   * Update status bar with error
   */
  updateStatusBar(error) {
    vscode.postMessage({
      type: 'error:statusBar',
      error: {
        severity: error.severity,
        message: error.title,
      }
    });
  }

  /**
   * Announce error for screen readers
   */
  announce(error) {
    if (this.announcer) {
      const announcement = `${error.severity}: ${error.title}. ${error.message}`;
      this.announcer.textContent = '';
      setTimeout(() => {
        this.announcer.textContent = announcement;
      }, 50);
    }
  }

  /**
   * Dismiss an error
   */
  dismiss(errorId) {
    if (!errorId) return;

    const errorEl = document.querySelector(`[data-error-id="${errorId}"]`);
    if (errorEl) {
      errorEl.classList.add('dismissing');
      setTimeout(() => errorEl.remove(), 200);
    }

    this.errors.delete(errorId);
  }

  /**
   * Handle error action
   */
  handleAction(errorId, action) {
    const error = this.errors.get(errorId);
    if (!error) return;

    switch (action) {
      case 'retry':
        vscode.postMessage({
          type: 'error:retry',
          operationId: error.operationId,
        });
        this.dismiss(errorId);
        break;
    }
  }

  /**
   * Show connection error banner
   */
  showConnectionError(message) {
    // Remove existing
    document.querySelector('.qic-connection-error')?.remove();

    const banner = document.createElement('div');
    banner.className = 'qic-connection-error';
    banner.innerHTML = `
      <span class="codicon codicon-warning"></span>
      <span class="qic-connection-error-message">${this.escapeHtml(message)}</span>
      <button class="qic-connection-error-retry">Reconnect</button>
    `;

    banner.querySelector('.qic-connection-error-retry').addEventListener('click', () => {
      vscode.postMessage({ type: 'connection:retry' });
    });

    // Insert at top
    const header = document.querySelector('.qic-header');
    header.parentNode.insertBefore(banner, header.nextSibling);
  }

  /**
   * Hide connection error banner
   */
  hideConnectionError() {
    document.querySelector('.qic-connection-error')?.remove();
  }

  /**
   * Show validation error on input
   */
  showValidationError(inputId, message) {
    // Remove existing
    this.hideValidationError(inputId);

    const input = document.getElementById(inputId);
    if (!input) return;

    const errorEl = document.createElement('div');
    errorEl.className = 'qic-validation-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.id = `${inputId}-error`;
    errorEl.innerHTML = `
      <span class="codicon codicon-error"></span>
      <span>${this.escapeHtml(message)}</span>
    `;

    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', errorEl.id);
    input.parentNode.insertBefore(errorEl, input.nextSibling);
  }

  /**
   * Hide validation error
   */
  hideValidationError(inputId) {
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(`${inputId}-error`);

    if (input) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    errorEl?.remove();
  }

  scrollToError(errorEl) {
    errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
let errorManager;
document.addEventListener('DOMContentLoaded', () => {
  errorManager = new ErrorManager();
});
```

### 5. Add Extension Error Handlers

```typescript
// In qicPanel.ts

case 'error:notification':
  this.showErrorNotification(message.error);
  return;

case 'error:statusBar':
  this.updateStatusBarError(message.error);
  return;

case 'error:retry':
  this.retryOperation(message.operationId);
  return;

private showErrorNotification(error: { severity: string; title: string; message: string }): void {
  switch (error.severity) {
    case 'warning':
      this.notificationService.warn(`${error.title}: ${error.message}`);
      break;
    case 'error':
    case 'critical':
      this.notificationService.error(`${error.title}: ${error.message}`);
      break;
    default:
      this.notificationService.info(`${error.title}: ${error.message}`);
  }
}
```

### 6. Create Error Factory

```typescript
// src/vs/workbench/contrib/qic/common/errorFactory.ts

export class QicErrorFactory {
  static connectionError(details?: string): QicError {
    return {
      id: `err_${Date.now()}`,
      category: 'connection',
      severity: 'warning',
      title: 'Connection Error',
      message: 'Unable to connect to the AI service. Please check your internet connection.',
      details,
      timestamp: Date.now(),
      recoverable: true,
      retryAction: 'reconnect',
    };
  }

  static rateLimitError(resetTime?: Date): QicError {
    const resetMsg = resetTime
      ? ` Try again after ${resetTime.toLocaleTimeString()}.`
      : ' Please wait a moment before trying again.';

    return {
      id: `err_${Date.now()}`,
      category: 'rate_limit',
      severity: 'warning',
      title: 'Rate Limit Exceeded',
      message: `You've made too many requests.${resetMsg}`,
      timestamp: Date.now(),
      recoverable: true,
      retryAction: 'retry',
    };
  }

  static authError(): QicError {
    return {
      id: `err_${Date.now()}`,
      category: 'authentication',
      severity: 'error',
      title: 'Authentication Failed',
      message: 'Your API key is invalid or expired. Please update your credentials.',
      timestamp: Date.now(),
      recoverable: false,
      helpLink: 'command:qic.openSettings',
    };
  }

  static validationError(field: string, message: string): QicError {
    return {
      id: `err_${Date.now()}`,
      category: 'validation',
      severity: 'warning',
      title: 'Invalid Input',
      message: message,
      timestamp: Date.now(),
      recoverable: true,
      component: field,
    };
  }

  static operationError(operation: string, details?: string): QicError {
    return {
      id: `err_${Date.now()}`,
      category: 'operation',
      severity: 'error',
      title: `${operation} Failed`,
      message: details || 'The operation could not be completed.',
      details,
      timestamp: Date.now(),
      recoverable: true,
      retryAction: 'retry',
    };
  }
}
```

---

## Verification

### Success Criteria
- [ ] Error messages display correctly
- [ ] All severity levels styled appropriately
- [ ] Dismiss button works
- [ ] Retry action triggers retry
- [ ] Details expandable
- [ ] Connection error banner shows/hides
- [ ] Validation errors appear on inputs
- [ ] Errors announced to screen readers
- [ ] Status bar updates with errors
- [ ] Notifications show for critical errors

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Connection error | Disconnect network | Banner appears |
| Reconnect | Click Reconnect | Retry triggered |
| API error | Trigger 500 error | Error in conversation |
| Dismiss | Click × | Error removed |
| Retry | Click Try Again | Operation retried |
| Validation | Submit empty | Inline error shown |
| Screen reader | Trigger error | Error announced |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/media/
```

---

## GAP-07 Amendment: Complete Error Code Mapping

The backend has 24+ error codes with specific meanings. Each must map to an appropriate display strategy.

### Error Code Categories

```typescript
// src/vs/workbench/contrib/qic/common/errors/errorCodeMap.ts

export interface ErrorDisplayConfig {
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    displayMethod: 'toast' | 'inline' | 'banner' | 'modal';
    recoveryAction?: string;
    recoveryCommand?: string;
    autoDismiss?: number; // ms, 0 = never
}

export const ERROR_CODE_MAP: Record<string, ErrorDisplayConfig> = {
    // ═══════════════════════════════════════════════════════════════════
    // Tool Errors (QIC-T0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-T001': {
        title: 'Tool Not Found',
        message: 'The requested tool is not available.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Try a different approach',
    },
    'QIC-T002': {
        title: 'Tool Execution Failed',
        message: 'The tool encountered an error during execution.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Retry',
        recoveryCommand: 'qic.retryLastTool',
    },
    'QIC-T003': {
        title: 'Tool Timeout',
        message: 'The tool took too long to complete.',
        severity: 'warning',
        displayMethod: 'inline',
        recoveryAction: 'Retry',
        recoveryCommand: 'qic.retryLastTool',
    },
    'QIC-T004': {
        title: 'Tool Permission Denied',
        message: 'You denied permission for this tool.',
        severity: 'info',
        displayMethod: 'inline',
        autoDismiss: 5000,
    },
    'QIC-T005': {
        title: 'Tool Arguments Invalid',
        message: 'The tool received invalid arguments.',
        severity: 'error',
        displayMethod: 'inline',
    },

    // ═══════════════════════════════════════════════════════════════════
    // Provider Errors (QIC-P0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-P001': {
        title: 'Provider Unavailable',
        message: 'The LLM provider is currently unavailable.',
        severity: 'error',
        displayMethod: 'banner',
        recoveryAction: 'Switch Provider',
        recoveryCommand: 'qic.showProviderQuickPick',
    },
    'QIC-P002': {
        title: 'Provider Degraded',
        message: 'Some features may be limited due to provider issues.',
        severity: 'warning',
        displayMethod: 'toast',
        autoDismiss: 10000,
    },
    'QIC-P003': {
        title: 'Model Not Available',
        message: 'The requested model is not available.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Use default model',
    },
    'QIC-P004': {
        title: 'Context Too Large',
        message: 'The context exceeds the model\'s limit.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Reduce context',
        recoveryCommand: 'qic.showContextDrawer',
    },
    'QIC-P005': {
        title: 'Rate Limited',
        message: 'Too many requests. Please wait before trying again.',
        severity: 'warning',
        displayMethod: 'banner',
        recoveryAction: 'Retry in {countdown}',
        autoDismiss: 0, // Show countdown
    },
    'QIC-P006': {
        title: 'Authentication Failed',
        message: 'Your API key is invalid or expired.',
        severity: 'critical',
        displayMethod: 'modal',
        recoveryAction: 'Re-authenticate',
        recoveryCommand: 'qic.configureAuth',
    },

    // ═══════════════════════════════════════════════════════════════════
    // Network Errors (QIC-N0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-N001': {
        title: 'Connection Failed',
        message: 'Unable to connect to the QIC service.',
        severity: 'error',
        displayMethod: 'banner',
        recoveryAction: 'Retry',
        recoveryCommand: 'qic.testConnection',
    },
    'QIC-N002': {
        title: 'Request Timeout',
        message: 'The request timed out. Please try again.',
        severity: 'warning',
        displayMethod: 'inline',
        recoveryAction: 'Retry',
    },
    'QIC-N003': {
        title: 'Offline',
        message: 'You appear to be offline.',
        severity: 'warning',
        displayMethod: 'banner',
        autoDismiss: 0, // Persists until online
    },
    'QIC-N004': {
        title: 'Server Error',
        message: 'The QIC server encountered an error.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Report Issue',
        recoveryCommand: 'qic.reportIssue',
    },

    // ═══════════════════════════════════════════════════════════════════
    // Conversation Errors (QIC-C0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-C001': {
        title: 'Conversation Not Found',
        message: 'The conversation could not be loaded.',
        severity: 'error',
        displayMethod: 'toast',
        recoveryAction: 'Start New',
        recoveryCommand: 'qic.newConversation',
    },
    'QIC-C002': {
        title: 'Message Too Long',
        message: 'Your message exceeds the maximum length.',
        severity: 'warning',
        displayMethod: 'inline',
        autoDismiss: 5000,
    },
    'QIC-C003': {
        title: 'Empty Message',
        message: 'Please enter a message.',
        severity: 'info',
        displayMethod: 'inline',
        autoDismiss: 3000,
    },

    // ═══════════════════════════════════════════════════════════════════
    // File/Change Errors (QIC-F0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-F001': {
        title: 'File Not Found',
        message: 'The file could not be found.',
        severity: 'error',
        displayMethod: 'inline',
    },
    'QIC-F002': {
        title: 'File Read Error',
        message: 'Unable to read the file.',
        severity: 'error',
        displayMethod: 'inline',
    },
    'QIC-F003': {
        title: 'File Write Error',
        message: 'Unable to write changes to the file.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Retry',
    },
    'QIC-F004': {
        title: 'File Conflict',
        message: 'The file has been modified since the changes were generated.',
        severity: 'warning',
        displayMethod: 'inline',
        recoveryAction: 'Regenerate',
        recoveryCommand: 'qic.regenerateChanges',
    },

    // ═══════════════════════════════════════════════════════════════════
    // Cancellation (QIC-Y0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-Y001': {
        title: 'Request Cancelled',
        message: 'The request was cancelled.',
        severity: 'info',
        displayMethod: 'inline',
        autoDismiss: 3000,
    },
    'QIC-Y002': {
        title: 'Operation Cancelled',
        message: 'The operation was cancelled by user.',
        severity: 'info',
        displayMethod: 'toast',
        autoDismiss: 3000,
    },

    // ═══════════════════════════════════════════════════════════════════
    // Internal Errors (QIC-X0XX)
    // ═══════════════════════════════════════════════════════════════════
    'QIC-X001': {
        title: 'Internal Error',
        message: 'An unexpected error occurred.',
        severity: 'error',
        displayMethod: 'inline',
        recoveryAction: 'Report Issue',
        recoveryCommand: 'qic.reportIssue',
    },
    'QIC-X002': {
        title: 'State Sync Error',
        message: 'State synchronization failed. Refreshing...',
        severity: 'warning',
        displayMethod: 'toast',
        recoveryCommand: 'qic.refreshState',
    },
};
```

### Error Display Helper

```javascript
// In errorManager.js

function displayError(errorCode, additionalInfo = {}) {
    const config = ERROR_CODE_MAP[errorCode] || ERROR_CODE_MAP['QIC-X001'];

    const errorData = {
        code: errorCode,
        title: config.title,
        message: config.message,
        ...additionalInfo,
    };

    switch (config.displayMethod) {
        case 'toast':
            showErrorToast(errorData, config);
            break;
        case 'inline':
            showInlineError(errorData, config);
            break;
        case 'banner':
            showErrorBanner(errorData, config);
            break;
        case 'modal':
            showErrorModal(errorData, config);
            break;
    }

    // Log for debugging
    console.error(`[QIC Error] ${errorCode}:`, errorData);
}
```

This comprehensive mapping ensures every error type is handled appropriately with user-friendly messages and recovery options.

---

## Notes

- Error messages should be user-friendly, not technical
- Always provide recovery path when possible
- Show error codes in tooltips/details for support purposes
- Log technical details for debugging
- Consider retry with exponential backoff
- Errors should be dismissible unless critical
- **All 24+ error codes now have display configurations**

