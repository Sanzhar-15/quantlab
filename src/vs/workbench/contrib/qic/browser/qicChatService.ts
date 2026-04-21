/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IQicService, QicRuntime } from '../common/qicService.js';
import { IChatProgress, IChatMarkdownContent } from '../../chat/common/chatService/chatService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/**
 * Bridge service that connects the VS Code chat agent protocol
 * to the existing QIC backend (AgentOrchestrator, Gateway, etc.).
 *
 * This replaces the webview postMessage bridge — the orchestrator's
 * streamed tokens now flow through IChatProgress callbacks instead
 * of being forwarded to a webview iframe.
 */

export const IQicChatService = createDecorator<IQicChatService>('qicChatService');

export interface IQicChatService {
	readonly _serviceBrand: undefined;

	/**
	 * Send a user message through the QIC orchestrator and stream
	 * the response back via the progress callback.
	 */
	sendMessage(
		message: string,
		command: string | undefined,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<QicChatResult>;

	/**
	 * Start a new conversation (clears conversation state).
	 */
	startNewConversation(): Promise<void>;

	/**
	 * Cancel the current request.
	 */
	cancelCurrentRequest(): void;

	/**
	 * Fires when the QIC backend becomes ready.
	 */
	readonly onDidBecomeReady: Event<void>;

	/**
	 * Whether the backend is ready to handle requests.
	 */
	isReady(): boolean;
}

export interface QicChatResult {
	errorDetails?: { message: string; responseIsFiltered?: boolean };
	timings?: { firstProgress?: number; totalElapsed: number };
}

/**
 * QicChatService — bridges the chat participant `invoke()` to the
 * existing AgentOrchestrator.
 *
 * Instead of replacing the orchestrator (which handles tool loops,
 * rate limiting, circuit breakers, security, etc.), this service
 * intercepts the UIService streaming calls and forwards them as
 * IChatProgress updates.
 */
export class QicChatService extends Disposable implements IQicChatService {
	declare readonly _serviceBrand: undefined;

	private _runtime: QicRuntime | null = null;
	private _progressCallback: ((parts: IChatProgress[]) => void) | null = null;
	private _isReady = false;
	private _fileReferenceBuffer = '';
	private _streamingActive = false;
	// Promise-chain mutex: each sendMessage() appends to this chain so that
	// _progressCallback / _fileReferenceBuffer are never accessed concurrently.
	private _sendQueue: Promise<QicChatResult> = Promise.resolve({} as QicChatResult);

	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	readonly onDidBecomeReady: Event<void> = this._onDidBecomeReady.event;

	constructor(
		@IQicService private readonly qicService: IQicService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		// Wire to runtime when it becomes available
		this._wireRuntime();
	}

	private _wireRuntime(): void {
		const runtime = this.qicService.getRuntime();
		if (runtime) {
			this._connectRuntime(runtime);
		} else {
			const disposable = this.qicService.onDidChangeState((state) => {
				if (state === 'ready' || state === 'degraded') {
					const rt = this.qicService.getRuntime();
					if (rt) {
						this._connectRuntime(rt);
						disposable.dispose();
					}
				}
			});
			this._register(disposable);
		}
	}

	private _connectRuntime(runtime: QicRuntime): void {
		this._runtime = runtime;
		this._isReady = true;

		// Intercept the UIService's streaming methods to redirect
		// output to the chat widget instead of the webview.
		// We wrap the existing uiService methods to also pipe
		// through our progress callback.
		const originalStreamToken = runtime.uiService.streamChatToken.bind(runtime.uiService);
		const originalComplete = runtime.uiService.completeStreaming.bind(runtime.uiService);
		const originalShowInfo = runtime.uiService.showInfo.bind(runtime.uiService);
		const originalShowWarning = runtime.uiService.showWarning.bind(runtime.uiService);
		const originalShowError = runtime.uiService.showError.bind(runtime.uiService);

		runtime.uiService.streamChatToken = (token: string) => {
			// Still call original (may be used by other consumers)
			originalStreamToken(token);

			// Pipe delta token to chat widget progress
			// ChatWidget's appendMarkdownString concatenates each delta internally
			if (this._progressCallback) {
				const parts = this.consumeFileReferences(token, false);
				if (parts.length) {
					this._progressCallback(parts);
				}
			}
		};

		runtime.uiService.completeStreaming = () => {
			if (this._progressCallback) {
				const parts = this.consumeFileReferences('', true);
				if (parts.length) {
					this._progressCallback(parts);
				}
			}
			// Unconditionally reset buffer: any partial marker still buffered at
			// end-of-response is malformed and must not bleed into the next message.
			this._fileReferenceBuffer = '';
			originalComplete();
			this._streamingActive = false;
		};

		runtime.uiService.showInfo = (message: string) => {
			originalShowInfo(message);
			if (this._progressCallback) {
				const parts = this.parseFileReferencesInMessage(message);
				this._progressCallback(parts);
			}
		};

		runtime.uiService.showWarning = (message: string) => {
			originalShowWarning(message);
			this.notificationService.warn(message);
		};

		runtime.uiService.showError = (message: string) => {
			originalShowError(message);
			this.notificationService.error(message);
		};

		this.logService.info('[QicChatService] Connected to QIC runtime');
		this._onDidBecomeReady.fire();
	}

	isReady(): boolean {
		return this._isReady;
	}

	sendMessage(
		message: string,
		command: string | undefined,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<QicChatResult> {
		if (!this._runtime) {
			return Promise.resolve({
				errorDetails: { message: 'Orion is not ready. Please wait for initialization to complete.' },
			});
		}
		// Serialize all sendMessage() calls via a promise chain so that
		// _progressCallback / _fileReferenceBuffer are never shared concurrently.
		const next = this._sendQueue.then(
			() => this._doSendMessage(message, command, progress, token),
			() => this._doSendMessage(message, command, progress, token),
		);
		// Tail of the queue always resolves so the chain can never permanently break.
		this._sendQueue = next.then(
			() => ({} as QicChatResult),
			() => ({} as QicChatResult),
		);
		return next;
	}

	private async _doSendMessage(
		message: string,
		command: string | undefined,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<QicChatResult> {
		const startTime = Date.now();
		let firstProgressTime: number | undefined;

		// BUG A FIX: Set _progressCallback BEFORE any orchestrator invocation so that
		// even a synchronous callback from handleUserMessage finds the callback ready.
		this._fileReferenceBuffer = '';
		this._streamingActive = true;
		this._progressCallback = (parts) => {
			if (firstProgressTime === undefined) {
				firstProgressTime = Date.now() - startTime;
			}
			progress(parts);
		};

		// BUG G: 5-minute hard deadline via the orchestrator's own cancellation
		// machinery — NOT Promise.race. cancelCurrentAndProcessNext() is exactly
		// what the user-cancel path does, so the orchestrator cleans up correctly.
		const ORCHESTRATOR_DEADLINE_MS = 5 * 60 * 1000;
		let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
		deadlineHandle = setTimeout(() => {
			this.logService.warn('[QicChatService] Orchestrator deadline reached — cancelling');
			this._runtime?.orchestrator.cancelCurrentAndProcessNext();
		}, ORCHESTRATOR_DEADLINE_MS);

		const cancelListener = token.onCancellationRequested(() => {
			clearTimeout(deadlineHandle);
			deadlineHandle = undefined;
			this._runtime?.orchestrator.cancelCurrentAndProcessNext();
		});

		try {
			const fullMessage = command ? `/${command} ${message}` : message;
			await this._runtime!.orchestrator.handleUserMessage(fullMessage);

			return {
				timings: {
					firstProgress: firstProgressTime,
					totalElapsed: Date.now() - startTime,
				},
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logService.error(`[QicChatService] Error processing message: ${errorMessage}`);
			return {
				errorDetails: { message: errorMessage },
				timings: {
					firstProgress: firstProgressTime,
					totalElapsed: Date.now() - startTime,
				},
			};
		} finally {
			clearTimeout(deadlineHandle);
			cancelListener.dispose();
			this._progressCallback = null;
			this._streamingActive = false;
			this._fileReferenceBuffer = '';
		}
	}

	private parseFileReferencesInMessage(message: string): IChatProgress[] {
		const priorBuffer = this._fileReferenceBuffer;
		const priorStreaming = this._streamingActive;
		this._fileReferenceBuffer = '';
		this._streamingActive = true;
		const parts = this.consumeFileReferences(message, true);
		this._fileReferenceBuffer = priorBuffer;
		this._streamingActive = priorStreaming;
		return parts.length ? parts : [{
			kind: 'markdownContent',
			content: new MarkdownString(message),
		}];
	}

	private consumeFileReferences(text: string, flush: boolean): IChatProgress[] {
		if (!this._streamingActive) {
			this._fileReferenceBuffer = '';
			this._streamingActive = true;
		}

		this._fileReferenceBuffer += text;
		const parts: IChatProgress[] = [];

		while (true) {
			const startIndex = this._fileReferenceBuffer.indexOf('[[');
			if (startIndex === -1) {
				if (flush) {
					this.pushMarkdown(parts, this._fileReferenceBuffer);
					this._fileReferenceBuffer = '';
				} else {
					if (this._fileReferenceBuffer.endsWith('[')) {
						this.pushMarkdown(parts, this._fileReferenceBuffer.slice(0, -1));
						this._fileReferenceBuffer = '[';
					} else {
						this.pushMarkdown(parts, this._fileReferenceBuffer);
						this._fileReferenceBuffer = '';
					}
				}
				break;
			}

			if (startIndex > 0) {
				this.pushMarkdown(parts, this._fileReferenceBuffer.slice(0, startIndex));
				this._fileReferenceBuffer = this._fileReferenceBuffer.slice(startIndex);
			}

			const endIndex = this._fileReferenceBuffer.indexOf(']]', 2);
			if (endIndex === -1) {
				if (flush) {
					this.pushMarkdown(parts, this._fileReferenceBuffer);
					this._fileReferenceBuffer = '';
				}
				break;
			}

			const rawRef = this._fileReferenceBuffer.slice(2, endIndex);
			this._fileReferenceBuffer = this._fileReferenceBuffer.slice(endIndex + 2);

			const normalized = this.normalizeReferenceText(rawRef);
			if (!normalized) {
				continue;
			}

			const inlinePart = this.buildInlineReferencePart(normalized);
			if (inlinePart) {
				parts.push(inlinePart);
			} else {
				this.pushMarkdown(parts, normalized);
			}
		}

		return parts;
	}

	private pushMarkdown(parts: IChatProgress[], text: string): void {
		if (!text) { return; }
		parts.push({
			kind: 'markdownContent',
			content: new MarkdownString(text),
		} satisfies IChatMarkdownContent);
	}

	private normalizeReferenceText(raw: string): string | null {
		const trimmed = raw.trim();
		if (!trimmed) {
			return null;
		}
		const unquoted = trimmed.replace(/^['"`]+|['"`]+$/g, '');
		const withoutTrailing = unquoted.replace(/[.,;:]+$/g, '');
		return withoutTrailing.trim() || null;
	}

	private buildInlineReferencePart(refText: string): IChatProgress | null {
		const { path, range } = this.extractRange(refText);
		const uri = this.resolveReferenceUri(path);
		if (!uri) {
			return null;
		}

		if (range) {
			return {
				kind: 'inlineReference',
				inlineReference: { uri, range },
				name: refText,
			};
		}

		return {
			kind: 'inlineReference',
			inlineReference: uri,
			name: refText,
		};
	}

	private extractRange(refText: string): { path: string; range?: Range } {
		if (refText.endsWith('/')) {
			return { path: refText };
		}

		const hashMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(refText);
		if (hashMatch) {
			const start = parseInt(hashMatch[1], 10);
			const end = hashMatch[2] ? parseInt(hashMatch[2], 10) : start;
			const path = refText.slice(0, hashMatch.index);
			return { path, range: new Range(start, 1, end, 1) };
		}

		const lineMatch = /:(\d+)(?:-(\d+))?$/.exec(refText);
		if (lineMatch) {
			const start = parseInt(lineMatch[1], 10);
			const end = lineMatch[2] ? parseInt(lineMatch[2], 10) : start;
			const path = refText.slice(0, lineMatch.index);
			return { path, range: new Range(start, 1, end, 1) };
		}

		return { path: refText };
	}

	private resolveReferenceUri(pathText: string): URI | null {
		const cleaned = pathText.trim();
		if (!cleaned) {
			return null;
		}

		if (this.looksLikeUri(cleaned)) {
			try {
				return URI.parse(cleaned);
			} catch {
				return null;
			}
		}

		const isFolder = cleaned.endsWith('/');
		const normalizedPath = isFolder ? cleaned.slice(0, -1) : cleaned;

		if (this.isAbsolutePath(normalizedPath)) {
			let uri = URI.file(normalizedPath);
			if (isFolder && !uri.path.endsWith('/')) {
				uri = uri.with({ path: `${uri.path}/` });
			}
			return uri;
		}

		const base = this.getPreferredBaseUri();
		if (!base || !base.path) {
			return null;
		}

		const segments = normalizedPath.split(/[\\/]/).filter(part => part.length > 0);
		let uri = URI.joinPath(base, ...segments);
		if (isFolder && !uri.path.endsWith('/')) {
			uri = uri.with({ path: `${uri.path}/` });
		}
		return uri;
	}

	private getPreferredBaseUri(): URI | undefined {
		const activeResource = this.editorService.activeEditor?.resource;
		if (activeResource) {
			// Only use activeResource if it's a file-based URI with a valid path
			// Skip URIs like 'untitled:', 'qic:', etc. that don't have file paths
			if (activeResource.scheme === 'file' && activeResource.path) {
				return dirname(activeResource);
			}
		}
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders[0].uri;
		}
		return undefined;
	}

	private looksLikeUri(value: string): boolean {
		return /^[a-zA-Z][a-zA-Z+.-]*:\/\//.test(value);
	}

	private isAbsolutePath(value: string): boolean {
		if (value.startsWith('/')) {
			return true;
		}
		return /^[a-zA-Z]:[\\/]/.test(value);
	}

	async startNewConversation(): Promise<void> {
		if (this._runtime) {
			await this._runtime.orchestrator.startNewConversation();
		}
	}

	cancelCurrentRequest(): void {
		this._runtime?.orchestrator.cancelCurrentAndProcessNext();
	}
}
