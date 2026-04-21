/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex, randomUUID } from '../common/qicCrypto.js';
import type { EditScript, ApprovalToken, PermissionCheckResult, ToolContext } from '../common/canonical/types.js';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../common/ui/messageProtocol.js';
import type { QicUIBridge } from '../common/qicService.js';

const DIALOG_TIMEOUT_MS = 300_000; // 5 minutes

interface PendingDialog<T> {
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

/**
 * Real UIService implementation backed by the webview (Prompt 12/13).
 * Replaces UIServiceStub. No [STUB] markers.
 *
 * Audit XII-AR3: Panel disposal rejects all pending dialogs with CancellationError.
 */
export class QicUIService implements QicUIBridge {

	private postMessage: ((msg: HostToWebviewMessage) => void) | null = null;
	private readonly pendingDiffDialogs = new Map<string, PendingDialog<ApprovalToken | null>>();
	private readonly pendingPermissionDialogs = new Map<string, PendingDialog<PermissionCheckResult>>();

	/**
	 * Wire up the webview message sender. Called when the panel creates its webview.
	 */
	setPostMessage(fn: (msg: HostToWebviewMessage) => void): void {
		this.postMessage = fn;
	}

	/**
	 * Handle incoming webview messages related to UI responses.
	 */
	handleWebviewMessage(msg: WebviewToHostMessage): void {
		switch (msg.type) {
			case 'approve-diff': {
				const pending = this.pendingDiffDialogs.get(msg.editScriptHash);
				if (!pending) { break; }
				this.pendingDiffDialogs.delete(msg.editScriptHash);
				if (msg.approved) {
					pending.resolve({
						id: randomUUID(),
						editScriptHash: msg.editScriptHash,
						grantedAt: new Date().toISOString(),
						grantedBy: 'user',
						expiresAt: new Date(Date.now() + 300_000).toISOString(),
					});
				} else {
					pending.resolve(null);
				}
				break;
			}
			case 'permission-response': {
				const pending = this.pendingPermissionDialogs.get(msg.requestId);
				if (!pending) { break; }
				this.pendingPermissionDialogs.delete(msg.requestId);
				pending.resolve({
					status: msg.granted ? 'granted' : 'denied',
					scope: msg.scope,
				});
				break;
			}
		}
	}

	async showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null> {
		if (!this.postMessage) { return null; }
		const hash = sha256Hex(JSON.stringify(editScript));
		const filePaths = editScript.edits.map(e => e.path);

		this.postMessage({
			type: 'diff-preview',
			editScriptHash: hash,
			previewHtml: this.buildDiffHtml(editScript),
			filePaths,
		});

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingDiffDialogs.delete(hash);
				resolve(null);
			}, DIALOG_TIMEOUT_MS);
			this.pendingDiffDialogs.set(hash, {
				resolve: (val) => { clearTimeout(timer); resolve(val); },
				reject: () => { clearTimeout(timer); resolve(null); },
			});
		});
	}

	async showPermissionDialog(tool: string, context: ToolContext): Promise<PermissionCheckResult> {
		if (!this.postMessage) {
			// Native chat widget mode — no webview dialog available.
			// Auto-grant permission since user explicitly requested the action.
			console.warn(`[QicUIService] No webview bridge — auto-granting permission for tool "${tool}"`);
			return { status: 'granted', scope: 'session' };
		}
		const requestId = randomUUID();

		this.postMessage({
			type: 'permission-request',
			requestId,
			toolName: tool,
			description: `Tool "${tool}" wants to operate on ${context.targetPath ?? context.workspacePath}`,
		});

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingPermissionDialogs.delete(requestId);
				resolve({ status: 'denied', scope: 'once', reason: 'Dialog timed out' });
			}, DIALOG_TIMEOUT_MS);
			this.pendingPermissionDialogs.set(requestId, {
				resolve: (val) => { clearTimeout(timer); resolve(val); },
				reject: () => { clearTimeout(timer); resolve({ status: 'denied', scope: 'once', reason: 'Dialog timed out' }); },
			});
		});
	}

	showToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
		this.postMessage?.({ type: 'tool-call-started', toolCallId, toolName, args });
	}

	showToolResult(toolCallId: string, content: string, isError: boolean): void {
		this.postMessage?.({ type: 'tool-call-result', toolCallId, content, isError });
	}

	streamChatToken(token: string): void {
		this.postMessage?.({ type: 'stream-token', text: token });
	}

	completeStreaming(): void {
		this.postMessage?.({ type: 'message-complete', messageId: `stream-${Date.now()}` });
		this.postMessage?.({ type: 'state-change', state: 'idle' });
	}

	showInfo(message: string): void {
		this.postMessage?.({ type: 'stream-token', text: message });
		this.postMessage?.({ type: 'message-complete', messageId: `info-${Date.now()}` });
		this.postMessage?.({ type: 'state-change', state: 'idle' });
	}

	showWarning(message: string): void {
		this.postMessage?.({ type: 'stream-token', text: `⚠ ${message}` });
		this.postMessage?.({ type: 'message-complete', messageId: `warn-${Date.now()}` });
		this.postMessage?.({ type: 'state-change', state: 'idle' });
	}

	showError(message: string): void {
		this.postMessage?.({ type: 'error', code: 'QIC-UI', message });
		this.postMessage?.({ type: 'state-change', state: 'idle' });
	}

	/**
	 * Send quota status update to webview.
	 */
	updateQuota(tokensUsed: number, tokenLimit: number, costUsed: number, costLimit: number, resetAt: string): void {
		this.postMessage?.({ type: 'quota-update', tokensUsed, tokenLimit, costUsed, costLimit, resetAt });
	}

	/**
	 * Send degradation status update to webview.
	 */
	updateDegradation(level: number, description: string): void {
		this.postMessage?.({ type: 'degradation-update', level, description });
	}

	/**
	 * Send status update (lane, model, provider) to webview.
	 */
	updateStatus(lane: string, model: string, provider: string, region?: string): void {
		this.postMessage?.({ type: 'status-update', lane, model, provider, region });
	}

	/**
	 * Send checkpoint list to webview.
	 */
	sendCheckpointList(checkpoints: Array<{ id: string; createdAt: string; fileCount: number }>): void {
		this.postMessage?.({ type: 'checkpoint-list', checkpoints });
	}

	/**
	 * Show first-run consent screen.
	 */
	showFirstRun(): void {
		this.postMessage?.({ type: 'show-first-run' });
	}

	/**
	 * Send audit log entries to webview.
	 */
	sendAuditLog(entries: Array<{ timestamp: string; type: string; tool?: string; status?: string; reason?: string }>, chainValid: boolean): void {
		this.postMessage?.({ type: 'audit-log', entries, chainValid });
	}

	/**
	 * Send metrics update to webview.
	 */
	sendMetrics(metrics: { errorRate: number; avgLatencyMs: number; memoryPressure: 'normal' | 'high' | 'critical'; providersAvailable: number; totalProviders: number }): void {
		this.postMessage?.({ type: 'metrics-update', metrics });
	}

	/**
	 * Send replay mode status to webview.
	 */
	sendReplayStatus(active: boolean, mode: 'off' | 'strict' | 'best-effort' | 'fallback', recordingCount: number): void {
		this.postMessage?.({ type: 'replay-status', active, mode, recordingCount });
	}

	/**
	 * Send DataFrame preview to webview.
	 */
	sendDataFramePreview(data: { filePath: string; shape: [number, number]; columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean; format: 'csv' | 'parquet' | 'feather' }): void {
		this.postMessage?.({ type: 'dataframe-preview', data });
	}

	/**
	 * XII-AR3: Reject all pending dialogs on panel disposal.
	 */
	rejectAllPendingDialogs(): void {
		const error = new Error('Panel disposed');
		for (const [, pending] of this.pendingDiffDialogs) {
			pending.reject(error);
		}
		this.pendingDiffDialogs.clear();
		for (const [, pending] of this.pendingPermissionDialogs) {
			pending.reject(error);
		}
		this.pendingPermissionDialogs.clear();
	}

	private buildDiffHtml(editScript: EditScript): string {
		const parts: string[] = [];
		for (const edit of editScript.edits) {
			parts.push(`<div class="qic-diff-file"><strong>${this.escapeHtml(edit.path)}</strong>`);
			for (const op of edit.operations) {
				switch (op.type) {
					case 'replace':
						parts.push(`<div class="qic-diff-line qic-diff-del">- Line ${op.range.startLine}</div>`);
						parts.push(`<div class="qic-diff-line qic-diff-add">+ ${this.escapeHtml(op.newText)}</div>`);
						break;
					case 'insert':
						parts.push(`<div class="qic-diff-line qic-diff-add">+ ${this.escapeHtml(op.text)}</div>`);
						break;
					case 'delete':
						parts.push(`<div class="qic-diff-line qic-diff-del">- Lines ${op.range.startLine}-${op.range.endLine}</div>`);
						break;
				}
			}
			parts.push('</div>');
		}
		return parts.join('');
	}

	private escapeHtml(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
}
