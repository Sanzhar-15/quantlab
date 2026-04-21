# Prompt 03-09: Permission Dialog Flow (GAP-06 Fix)

**Phase:** 3 - Native Integration
**Dependencies:** 02-08 (Panel Integration), 01-04 (Message Bridge)
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Implement the complete permission dialog flow that properly resolves the host-side Promise when users grant or deny permissions. This addresses GAP-06 from the audit.

---

## Context

From GAP-06 in the audit:
- Tools need permissions before execution
- Host calls `uiService.showPermissionDialog()` which returns a Promise
- Webview shows permission card with Allow/Deny options
- User response must resolve the host Promise with `PermissionCheckResult`

This is different from the ApprovalToken flow (GAP-05) - permissions are for tool execution authorization, not file change approval.

Flow:
```
Tool needs permission → PermissionManager.check() →
  If not granted → uiService.showPermissionDialog() →
    Returns Promise<PermissionCheckResult> →
      { granted: boolean, scope: 'once' | 'session' | 'always', reason?: string }
```

---

## Scope

### In Scope
- Permission request message handling (host → webview)
- Permission card UI in webview
- Permission response message (webview → host)
- Promise resolution on host side
- Scope selection (once/session/always)
- Permission card dismiss handling
- Multiple pending permissions

### Out of Scope
- PermissionManager backend logic
- Tool execution
- Permission storage (backend handles this)

---

## Pre-Conditions

- [ ] 02-08 complete (panel integration)
- [ ] 01-04 complete (message bridge)
- [ ] PermissionManager exists in backend
- [ ] Git branch created: `qic-ui/03-09-permission-flow`

---

## Tasks

### 1. Define Permission Types

```typescript
// src/vs/workbench/contrib/qic/common/types/permission.ts

export type PermissionScope = 'once' | 'session' | 'always';

export interface PermissionRequest {
    requestId: string;
    toolName: string;
    toolDisplayName: string;
    description: string;
    details?: string;
    riskLevel: 'low' | 'medium' | 'high';
    timestamp: number;
}

export interface PermissionResponse {
    requestId: string;
    granted: boolean;
    scope: PermissionScope;
    reason?: string;
}

export interface PermissionCheckResult {
    granted: boolean;
    scope: PermissionScope;
    reason?: string;
}
```

### 2. Implement Host-Side Permission Service

```typescript
// src/vs/workbench/contrib/qic/browser/services/permissionUIService.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { IQicPanelService } from './qicPanelService.js';
import { PermissionRequest, PermissionResponse, PermissionCheckResult } from '../../common/types/permission.js';

interface PendingPermission {
    resolve: (result: PermissionCheckResult) => void;
    reject: (error: Error) => void;
    request: PermissionRequest;
    timeout: NodeJS.Timeout;
}

const PERMISSION_TIMEOUT_MS = 300_000; // 5 minutes

export class PermissionUIService extends Disposable {
    private readonly pendingPermissions = new Map<string, PendingPermission>();

    constructor(
        @IQicPanelService private readonly panelService: IQicPanelService,
    ) {
        super();

        // Listen for responses from webview
        this._register(this.panelService.onDidReceiveMessage(msg => {
            if (msg.type === 'permission:response') {
                this.handlePermissionResponse(msg.payload);
            }
        }));
    }

    /**
     * Show a permission dialog and wait for user response
     * GAP-06 FIX: Returns a Promise that resolves when user responds
     */
    async showPermissionDialog(
        toolName: string,
        toolDisplayName: string,
        description: string,
        options?: {
            details?: string;
            riskLevel?: 'low' | 'medium' | 'high';
        }
    ): Promise<PermissionCheckResult> {
        const requestId = this.generateRequestId();

        const request: PermissionRequest = {
            requestId,
            toolName,
            toolDisplayName,
            description,
            details: options?.details,
            riskLevel: options?.riskLevel || 'medium',
            timestamp: Date.now(),
        };

        return new Promise<PermissionCheckResult>((resolve, reject) => {
            // Set timeout to auto-reject stale requests
            const timeout = setTimeout(() => {
                this.handleTimeout(requestId);
            }, PERMISSION_TIMEOUT_MS);

            // Store pending request
            this.pendingPermissions.set(requestId, {
                resolve,
                reject,
                request,
                timeout,
            });

            // Send to webview
            this.panelService.postMessage({
                type: 'permission:request',
                payload: request,
            });
        });
    }

    /**
     * Handle response from webview
     */
    private handlePermissionResponse(response: PermissionResponse): void {
        const pending = this.pendingPermissions.get(response.requestId);

        if (!pending) {
            console.warn(`[PermissionUI] Received response for unknown request: ${response.requestId}`);
            return;
        }

        // Clear timeout
        clearTimeout(pending.timeout);

        // Remove from pending
        this.pendingPermissions.delete(response.requestId);

        // Resolve the Promise
        pending.resolve({
            granted: response.granted,
            scope: response.scope,
            reason: response.reason,
        });
    }

    /**
     * Handle timeout - reject with timeout error
     */
    private handleTimeout(requestId: string): void {
        const pending = this.pendingPermissions.get(requestId);

        if (!pending) return;

        this.pendingPermissions.delete(requestId);

        pending.resolve({
            granted: false,
            scope: 'once',
            reason: 'Permission request timed out',
        });

        // Notify webview to remove the card
        this.panelService.postMessage({
            type: 'permission:timeout',
            payload: { requestId },
        });
    }

    /**
     * Cancel all pending permissions (e.g., on panel close)
     */
    cancelAllPending(): void {
        for (const [requestId, pending] of this.pendingPermissions) {
            clearTimeout(pending.timeout);
            pending.resolve({
                granted: false,
                scope: 'once',
                reason: 'Permission request cancelled',
            });
        }
        this.pendingPermissions.clear();
    }

    private generateRequestId(): string {
        return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    dispose(): void {
        this.cancelAllPending();
        super.dispose();
    }
}
```

### 3. Create Permission Card HTML Template

```html
<!-- Permission Card Template -->
<template id="permission-card-template">
    <div class="qic-permission-card" role="alertdialog" aria-labelledby="perm-title" aria-describedby="perm-desc">
        <div class="qic-permission-header">
            <span class="qic-permission-icon codicon"></span>
            <div class="qic-permission-title-area">
                <span class="qic-permission-title" id="perm-title"></span>
                <span class="qic-permission-tool"></span>
            </div>
        </div>

        <div class="qic-permission-body">
            <p class="qic-permission-desc" id="perm-desc"></p>
            <details class="qic-permission-details">
                <summary>More details</summary>
                <pre class="qic-permission-details-content"></pre>
            </details>
        </div>

        <div class="qic-permission-scope">
            <label class="qic-scope-option">
                <input type="radio" name="scope" value="once" checked>
                <span>Just this once</span>
            </label>
            <label class="qic-scope-option">
                <input type="radio" name="scope" value="session">
                <span>For this session</span>
            </label>
            <label class="qic-scope-option">
                <input type="radio" name="scope" value="always">
                <span>Always allow</span>
            </label>
        </div>

        <div class="qic-permission-actions">
            <button class="qic-btn secondary" data-action="deny">
                <span class="codicon codicon-close"></span> Deny
            </button>
            <button class="qic-btn primary" data-action="allow">
                <span class="codicon codicon-check"></span> Allow
            </button>
        </div>
    </div>
</template>
```

### 4. Add Permission Card Styles

```css
/* ========================================
   Permission Card Styles
   ======================================== */

.qic-permission-card {
    background: var(--vscode-notifications-background);
    border: 1px solid var(--vscode-notifications-border);
    border-radius: 8px;
    margin: 12px 0;
    padding: 16px;
    box-shadow: var(--qic-shadow-lg);
}

.qic-permission-card[data-risk="high"] {
    border-color: var(--qic-status-warning);
}

.qic-permission-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
}

.qic-permission-icon {
    font-size: 24px;
    color: var(--qic-status-warning);
}

.qic-permission-card[data-risk="low"] .qic-permission-icon {
    color: var(--qic-status-success);
}

.qic-permission-card[data-risk="high"] .qic-permission-icon {
    color: var(--qic-status-error);
}

.qic-permission-title-area {
    flex: 1;
}

.qic-permission-title {
    font-weight: 600;
    font-size: 14px;
    display: block;
}

.qic-permission-tool {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--qic-font-mono);
}

.qic-permission-body {
    margin-bottom: 12px;
}

.qic-permission-desc {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
}

.qic-permission-details {
    margin-top: 8px;
}

.qic-permission-details summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--vscode-textLink-foreground);
}

.qic-permission-details-content {
    margin-top: 8px;
    padding: 8px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px;
    font-size: 11px;
    overflow-x: auto;
}

.qic-permission-scope {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
    padding: 12px;
    background: var(--vscode-input-background);
    border-radius: 6px;
}

.qic-scope-option {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 13px;
}

.qic-scope-option input[type="radio"] {
    margin: 0;
}

.qic-permission-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

/* Animation */
.qic-permission-card {
    animation: slideIn 0.2s ease-out;
}

@keyframes slideIn {
    from {
        opacity: 0;
        transform: translateY(-8px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.qic-permission-card.removing {
    animation: slideOut 0.2s ease-in forwards;
}

@keyframes slideOut {
    from {
        opacity: 1;
        transform: translateY(0);
    }
    to {
        opacity: 0;
        transform: translateY(-8px);
    }
}
```

### 5. Create Permission Manager JavaScript (Webview)

```javascript
// src/vs/workbench/contrib/qic/browser/media/permissionManager.js
// @ts-nocheck
/**
 * QIC Permission Manager (Webview)
 * Handles permission card display and user responses
 * GAP-06 FIX
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════

    const pendingPermissions = new Map(); // requestId -> cardElement
    let permissionContainer = null;

    // ═══════════════════════════════════════════════════════════════════
    // Risk Configuration
    // ═══════════════════════════════════════════════════════════════════

    const RISK_ICONS = {
        low: 'codicon-info',
        medium: 'codicon-warning',
        high: 'codicon-error',
    };

    const RISK_TITLES = {
        low: 'Permission Required',
        medium: 'Permission Required',
        high: 'Elevated Permission Required',
    };

    // ═══════════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Show a permission request card
     * @param {PermissionRequest} request
     */
    function showPermissionRequest(request) {
        ensureContainer();

        const card = createPermissionCard(request);
        pendingPermissions.set(request.requestId, card);
        permissionContainer.appendChild(card);

        // Focus the allow button for keyboard users
        card.querySelector('[data-action="allow"]')?.focus();

        // Announce for screen readers
        window.QicAnnouncer?.announce(`Permission required for ${request.toolDisplayName}`);
    }

    /**
     * Remove a permission card (timeout or processed)
     * @param {string} requestId
     */
    function removePermissionCard(requestId) {
        const card = pendingPermissions.get(requestId);
        if (!card) return;

        card.classList.add('removing');
        setTimeout(() => {
            card.remove();
            pendingPermissions.delete(requestId);
        }, 200);
    }

    /**
     * Handle permission timeout from host
     * @param {string} requestId
     */
    function handleTimeout(requestId) {
        removePermissionCard(requestId);
        window.QicAnnouncer?.announce('Permission request timed out');
    }

    // ═══════════════════════════════════════════════════════════════════
    // Card Creation
    // ═══════════════════════════════════════════════════════════════════

    function createPermissionCard(request) {
        const template = document.getElementById('permission-card-template');
        const card = template.content.cloneNode(true).firstElementChild;

        card.dataset.requestId = request.requestId;
        card.dataset.risk = request.riskLevel;

        // Set icon
        const icon = card.querySelector('.qic-permission-icon');
        icon.classList.add(RISK_ICONS[request.riskLevel]);

        // Set title
        card.querySelector('.qic-permission-title').textContent =
            RISK_TITLES[request.riskLevel];

        // Set tool name
        card.querySelector('.qic-permission-tool').textContent =
            request.toolDisplayName;

        // Set description
        card.querySelector('.qic-permission-desc').textContent =
            request.description;

        // Set details if provided
        const detailsContent = card.querySelector('.qic-permission-details-content');
        const detailsElement = card.querySelector('.qic-permission-details');
        if (request.details) {
            detailsContent.textContent = request.details;
        } else {
            detailsElement.hidden = true;
        }

        // Wire up buttons
        card.querySelector('[data-action="allow"]').addEventListener('click', () => {
            respondToPermission(request.requestId, true, getSelectedScope(card));
        });

        card.querySelector('[data-action="deny"]').addEventListener('click', () => {
            respondToPermission(request.requestId, false, 'once');
        });

        // Keyboard support
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                respondToPermission(request.requestId, false, 'once', 'Dismissed by user');
            } else if (e.key === 'Enter' && e.target.matches('[data-action]')) {
                e.target.click();
            }
        });

        return card;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Response Handling
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send permission response to host
     * GAP-06 FIX: This response resolves the host Promise
     */
    function respondToPermission(requestId, granted, scope, reason) {
        // Remove the card
        removePermissionCard(requestId);

        // Send response to host
        vscode.postMessage({
            type: 'permission:response',
            payload: {
                requestId,
                granted,
                scope,
                reason: reason || (granted ? undefined : 'User denied'),
            }
        });

        // Announce result
        const message = granted
            ? `Permission granted (${scope})`
            : 'Permission denied';
        window.QicAnnouncer?.announce(message);
    }

    function getSelectedScope(card) {
        const selected = card.querySelector('input[name="scope"]:checked');
        return selected?.value || 'once';
    }

    // ═══════════════════════════════════════════════════════════════════
    // Container Management
    // ═══════════════════════════════════════════════════════════════════

    function ensureContainer() {
        if (permissionContainer) return;

        permissionContainer = document.getElementById('permission-container');
        if (!permissionContainer) {
            permissionContainer = document.createElement('div');
            permissionContainer.id = 'permission-container';
            permissionContainer.className = 'qic-permission-container';
            permissionContainer.setAttribute('role', 'region');
            permissionContainer.setAttribute('aria-label', 'Permission requests');

            // Insert after messages, before input
            const conversation = document.getElementById('conversation-area');
            conversation?.appendChild(permissionContainer);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Handling
    // ═══════════════════════════════════════════════════════════════════

    function handleMessage(message) {
        switch (message.type) {
            case 'permission:request':
                showPermissionRequest(message.payload);
                break;
            case 'permission:timeout':
                handleTimeout(message.payload.requestId);
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Export
    // ═══════════════════════════════════════════════════════════════════

    window.QicPermissionManager = {
        showPermissionRequest,
        removePermissionCard,
        handleTimeout,
        handleMessage,
    };
})();
```

### 6. Wire to Main Message Handler

```javascript
// In main.js - add permission message handling

window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
        case 'permission:request':
        case 'permission:timeout':
            window.QicPermissionManager?.handleMessage(message);
            break;

        // ... other cases
    }
});
```

---

## Verification

### Success Criteria
- [ ] Permission card shows when tool needs permission
- [ ] Allow button sends granted=true with selected scope
- [ ] Deny button sends granted=false
- [ ] Host Promise resolves with correct result
- [ ] Scope selection works (once/session/always)
- [ ] Timeout removes card and resolves Promise
- [ ] Multiple permissions can be pending
- [ ] Escape key denies permission
- [ ] Screen reader announces requests

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Allow once | Click Allow with "Just this once" | Response: granted=true, scope=once |
| Allow session | Select "For this session", click Allow | Response: granted=true, scope=session |
| Allow always | Select "Always allow", click Allow | Response: granted=true, scope=always |
| Deny | Click Deny | Response: granted=false |
| Escape key | Press Escape | Denied, card removed |
| Timeout | Wait 5 minutes | Card removed, Promise resolved with timeout |
| Multiple | Trigger 2 permissions | Both cards show, respond independently |

### Integration Test

```typescript
// Test the full flow
it('should resolve permission Promise when user allows', async () => {
    const result = permissionUIService.showPermissionDialog(
        'read_file',
        'Read File',
        'Access to read main.ts'
    );

    // Simulate user clicking Allow
    webview.postMessage({
        type: 'permission:response',
        payload: {
            requestId: /* captured from request */,
            granted: true,
            scope: 'session',
        }
    });

    const resolved = await result;
    expect(resolved.granted).toBe(true);
    expect(resolved.scope).toBe('session');
});
```

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/services/permissionUIService.ts
git checkout src/vs/workbench/contrib/qic/browser/media/permissionManager.js
```

---

## Notes

- Permission timeout is 5 minutes (configurable)
- "Always allow" persists to PermissionManager (backend)
- High-risk tools should default to "once"
- Consider adding "Remember my choice" checkbox
- Permission cards stack vertically if multiple
