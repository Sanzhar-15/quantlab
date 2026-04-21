/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IQicStateService, QICStatePatch, PermissionRequest, ToolCallInfo } from '../common/state/qicStateService.js';
import {
	HostToWebviewMessageV2,
	WebviewToHostMessageV2,
	MessageMetadata,
	isV2WebviewMessage
} from '../common/ui/messageProtocolV2.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PermissionCheckResult {
	granted: boolean;
	scope: 'once' | 'session' | 'always';
	reason?: string;
}

interface PendingPermission {
	resolve: (result: PermissionCheckResult) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE BRIDGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * QicMessageBridge handles bidirectional communication between the VS Code host
 * and the webview with revision-based synchronization.
 *
 * Responsibilities:
 * - Forward state changes from QicStateService to webview
 * - Handle webview lifecycle (ready, reload)
 * - Manage revision acknowledgments
 * - Detect and recover from sync gaps
 * - Queue messages when webview isn't ready
 * - Handle permission dialog Promise resolution (GAP-06)
 */
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

	// ═══════════════════════════════════════════════════════════════════════════
	// State Forwarding
	// ═══════════════════════════════════════════════════════════════════════════

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

	// ═══════════════════════════════════════════════════════════════════════════
	// Sync Check
	// ═══════════════════════════════════════════════════════════════════════════

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

	// ═══════════════════════════════════════════════════════════════════════════
	// Message Sending
	// ═══════════════════════════════════════════════════════════════════════════

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

	// ═══════════════════════════════════════════════════════════════════════════
	// Webview Lifecycle
	// ═══════════════════════════════════════════════════════════════════════════

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
		for (const [_id, pending] of this.pendingPermissions) {
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

	/**
	 * Check if webview is ready
	 */
	isReady(): boolean {
		return this.webviewReady;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Revision Handling
	// ═══════════════════════════════════════════════════════════════════════════

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

	/**
	 * Get the last acknowledged revision
	 */
	getLastAckedRevision(): number {
		return this.lastAckedRevision;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Permission Dialog Flow (GAP-06 FIX)
	// ═══════════════════════════════════════════════════════════════════════════

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

	/**
	 * Check if there's a pending permission request
	 */
	hasPendingPermission(): boolean {
		return this.pendingPermissions.size > 0;
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════════════

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

	// ═══════════════════════════════════════════════════════════════════════════
	// Convenience Methods for Streaming
	// ═══════════════════════════════════════════════════════════════════════════

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
	sendStreamComplete(messageId: string, metadata?: MessageMetadata): void {
		this.send({
			type: 'message:complete',
			revision: this.stateService.revision,
			payload: { id: messageId, metadata }
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Convenience Methods for Tool Calls
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Send tool call start
	 */
	sendToolStart(toolCall: { id: string; name: string; args?: Record<string, unknown> }): void {
		const toolCallInfo: ToolCallInfo = {
			id: toolCall.id,
			name: toolCall.name,
			status: 'running',
			args: toolCall.args
		};

		this.stateService.addToolCall(toolCallInfo);

		this.send({
			type: 'tool:start',
			revision: this.stateService.revision,
			payload: toolCallInfo
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

	// ═══════════════════════════════════════════════════════════════════════════
	// Cleanup
	// ═══════════════════════════════════════════════════════════════════════════

	override dispose(): void {
		this.onWebviewDisposed();
		super.dispose();
	}
}
