# Prompt 01-04: Message Bridge

**Phase:** 1 - Foundation
**Dependencies:** 01-02 (State Service), 01-03 (Protocol V2)
**Estimated Effort:** 1-2 sessions
**Critical Path:** Yes

---

## Objective

Implement the `QicMessageBridge` class that handles bidirectional communication between the VS Code host and the webview with revision-based synchronization.

---

## Context

The message bridge is responsible for:
1. Forwarding state changes from QicStateService to the webview
2. Handling webview lifecycle (ready, reload)
3. Managing revision acknowledgments
4. Detecting and recovering from sync gaps
5. Queuing messages when webview isn't ready

Reference: `QIC_UI_SPEC/Optimal_plan/03-STATE-AND-PROTOCOL.md`

---

## Scope

### In Scope
- Create `QicMessageBridge` class
- Implement state forwarding
- Implement revision tracking
- Implement gap detection and recovery
- Handle webview ready event
- Handle permission dialog Promise resolution (GAP-06)

### Out of Scope
- Modifying QicChatViewPane (integration in later prompt)
- Webview-side handling (separate prompt)
- Legacy protocol handling (keep in panel for now)

---

## Pre-Conditions

- [ ] 01-02 complete (QicStateService implemented)
- [ ] 01-03 complete (Protocol V2 types defined)
- [ ] Git branch created: `qic-ui/01-04-message-bridge`

---

## Tasks

### 1. Create Bridge File

```bash
touch src/vs/workbench/contrib/qic/browser/messageBridge.ts
```

### 2. Implement Core Bridge Class

```typescript
// src/vs/workbench/contrib/qic/browser/messageBridge.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { IQicStateService, QICStatePatch, PermissionRequest } from '../common/state/qicStateService.js';
import {
    HostToWebviewMessageV2,
    WebviewToHostMessageV2,
    isV2WebviewMessage
} from '../common/ui/messageProtocolV2.js';

interface PermissionCheckResult {
    granted: boolean;
    scope: 'once' | 'session' | 'always';
    reason?: string;
}

interface PendingPermission {
    resolve: (result: PermissionCheckResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

export class QicMessageBridge extends Disposable {
    private webviewReady = false;
    private messageQueue: HostToWebviewMessageV2[] = [];
    private lastAckedRevision = 0;
    private pendingPermissions = new Map<string, PendingPermission>();

    private readonly PERMISSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    private readonly SYNC_CHECK_INTERVAL = 30_000; // 30 seconds

    constructor(
        private readonly stateService: IQicStateService,
        private readonly postMessage: (msg: HostToWebviewMessageV2) => void,
        private readonly generateId: () => string = () =>
            Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
    ) {
        super();
        this.setupStateForwarding();
        this.setupSyncCheck();
    }

    // ═══════════════════════════════════════════════════════════════════
    // State Forwarding
    // ═══════════════════════════════════════════════════════════════════

    private setupStateForwarding(): void {
        this._register(this.stateService.onDidChangeState(patch => {
            this.sendPatch(patch);
        }));
    }

    private sendPatch(patch: QICStatePatch): void {
        this.send({
            type: 'state:patch',
            revision: patch.revision,
            payload: patch
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Sync Check
    // ═══════════════════════════════════════════════════════════════════

    private setupSyncCheck(): void {
        const interval = setInterval(() => {
            if (this.webviewReady) {
                this.checkSync();
            }
        }, this.SYNC_CHECK_INTERVAL);

        this._register({ dispose: () => clearInterval(interval) });
    }

    private checkSync(): void {
        const currentRevision = this.stateService.revision;
        if (this.lastAckedRevision < currentRevision - 5) {
            // Significant gap, request ack
            this.send({
                type: 'state:sync',
                revision: currentRevision
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Sending
    // ═══════════════════════════════════════════════════════════════════

    send(msg: HostToWebviewMessageV2): void {
        if (!this.webviewReady) {
            this.messageQueue.push(msg);
            return;
        }
        this.postMessage(msg);
    }

    private flushQueue(): void {
        while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift()!;
            this.postMessage(msg);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Webview Lifecycle
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Called when webview sends 'ready' message
     */
    onWebviewReady(): void {
        this.webviewReady = true;

        // Send full state
        this.sendFullState();

        // Flush queued messages
        this.flushQueue();
    }

    /**
     * Called when webview is being disposed/reloaded
     */
    onWebviewDisposed(): void {
        this.webviewReady = false;
        this.lastAckedRevision = 0;
        this.messageQueue = [];

        // Reject pending permissions
        for (const [id, pending] of this.pendingPermissions) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Webview disposed'));
        }
        this.pendingPermissions.clear();
    }

    /**
     * Send full state snapshot to webview
     */
    private sendFullState(): void {
        this.send({
            type: 'state:full',
            revision: this.stateService.revision,
            payload: this.stateService.getFullState()
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Revision Handling
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Called when webview acknowledges a revision
     */
    onRevisionAck(revision: number): void {
        this.lastAckedRevision = Math.max(this.lastAckedRevision, revision);
    }

    /**
     * Called when webview requests full state (gap detected)
     */
    onStateRequest(): void {
        this.sendFullState();
    }

    /**
     * Check if webview is in sync
     */
    isInSync(): boolean {
        return this.lastAckedRevision >= this.stateService.revision;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Permission Dialog Flow (GAP-06 FIX)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Show permission dialog and wait for response
     */
    async showPermissionDialog(
        toolName: string,
        description: string,
        riskLevel: 'low' | 'medium' | 'high' = 'medium'
    ): Promise<PermissionCheckResult> {
        const requestId = this.generateId();

        return new Promise((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                this.pendingPermissions.delete(requestId);
                this.stateService.setPermissionRequest(null);
                reject(new Error('Permission request timed out'));
            }, this.PERMISSION_TIMEOUT);

            // Store pending
            this.pendingPermissions.set(requestId, { resolve, reject, timeout });

            // Update state
            const request: PermissionRequest = {
                id: requestId,
                toolName,
                description,
                riskLevel
            };
            this.stateService.setPermissionRequest(request);

            // Send to webview
            this.send({
                type: 'permission:request',
                revision: this.stateService.revision,
                payload: request
            });
        });
    }

    /**
     * Handle permission allow response from webview
     */
    onPermissionAllow(id: string, scope: 'once' | 'session' | 'always'): void {
        const pending = this.pendingPermissions.get(id);
        if (!pending) {
            console.warn('[MessageBridge] No pending permission for id:', id);
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingPermissions.delete(id);
        this.stateService.setPermissionRequest(null);

        pending.resolve({
            granted: true,
            scope,
            reason: undefined
        });
    }

    /**
     * Handle permission deny response from webview
     */
    onPermissionDeny(id: string): void {
        const pending = this.pendingPermissions.get(id);
        if (!pending) {
            console.warn('[MessageBridge] No pending permission for id:', id);
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingPermissions.delete(id);
        this.stateService.setPermissionRequest(null);

        pending.resolve({
            granted: false,
            scope: 'once',
            reason: 'User denied permission'
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Message Handling
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Handle incoming message from webview
     * Returns true if message was handled, false otherwise
     */
    handleWebviewMessage(msg: unknown): boolean {
        if (!isV2WebviewMessage(msg)) {
            return false; // Not a V2 message, let caller handle
        }

        const v2Msg = msg as WebviewToHostMessageV2;

        switch (v2Msg.type) {
            case 'ready':
                this.onWebviewReady();
                return true;

            case 'revision:ack':
                this.onRevisionAck(v2Msg.revision);
                return true;

            case 'state:request':
                this.onStateRequest();
                return true;

            case 'permission:allow':
                this.onPermissionAllow(v2Msg.payload.id, v2Msg.payload.scope);
                return true;

            case 'permission:deny':
                this.onPermissionDeny(v2Msg.payload.id);
                return true;

            default:
                // Other V2 messages handled elsewhere
                return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Convenience Methods
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send a streaming token
     */
    sendStreamToken(messageId: string, content: string, kind: 'text' | 'code' = 'text'): void {
        this.send({
            type: 'message:chunk',
            revision: this.stateService.revision,
            payload: { id: messageId, content, kind }
        });
    }

    /**
     * Signal stream start
     */
    sendStreamStart(messageId: string): void {
        this.send({
            type: 'message:start',
            revision: this.stateService.revision,
            payload: { id: messageId }
        });
    }

    /**
     * Signal stream complete
     */
    sendStreamComplete(messageId: string, metadata?: Record<string, unknown>): void {
        this.send({
            type: 'message:complete',
            revision: this.stateService.revision,
            payload: { id: messageId, metadata }
        });
    }

    /**
     * Send tool call start
     */
    sendToolStart(toolCall: { id: string; name: string; args?: Record<string, unknown> }): void {
        this.stateService.addToolCall({
            id: toolCall.id,
            name: toolCall.name,
            status: 'running',
            args: toolCall.args
        });

        this.send({
            type: 'tool:start',
            revision: this.stateService.revision,
            payload: {
                id: toolCall.id,
                name: toolCall.name,
                status: 'running',
                args: toolCall.args
            }
        });
    }

    /**
     * Send tool call result
     */
    sendToolResult(id: string, content: string, isError: boolean): void {
        this.stateService.updateToolCall(id, {
            status: isError ? 'error' : 'complete',
            result: content,
            isError
        });

        this.send({
            type: 'tool:result',
            revision: this.stateService.revision,
            payload: { id, content, isError }
        });
    }

    override dispose(): void {
        this.onWebviewDisposed();
        super.dispose();
    }
}
```

---

## Verification

### Success Criteria
- [ ] Bridge compiles without errors
- [ ] State patches forwarded to webview
- [ ] Message queue works when webview not ready
- [ ] Gap detection triggers full state send
- [ ] Permission dialog Promise resolves correctly
- [ ] Timeout handling works

### Verification Commands
```bash
# Build
npm run compile

# Type check
npx tsc --noEmit src/vs/workbench/contrib/qic/browser/messageBridge.ts
```

### Manual Test Scenario
```typescript
// Create mock postMessage
const messages: any[] = [];
const postMessage = (msg: any) => messages.push(msg);

// Create bridge
const stateService = new QicStateService();
const bridge = new QicMessageBridge(stateService, postMessage);

// Simulate webview ready
bridge.handleWebviewMessage({ type: 'ready' });
console.log('Messages after ready:', messages.length); // Should be 1 (full state)

// Update state
stateService.setServiceStatus('ready');
console.log('Messages after update:', messages.length); // Should be 2 (patch)

// Simulate ack
bridge.handleWebviewMessage({ type: 'revision:ack', revision: 2 });
console.log('In sync:', bridge.isInSync()); // Should be true
```

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/messageBridge.ts
```

---

## Notes

- Bridge owns the webview communication pattern
- Panel will instantiate bridge and pass postMessage function
- Keep synchronous operations fast (async for permissions only)
- Consider adding metrics for sync health
