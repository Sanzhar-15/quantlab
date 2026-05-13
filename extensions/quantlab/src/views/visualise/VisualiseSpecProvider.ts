/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VisualiseSpecProvider -- VS Code CustomEditorProvider for `.qviz.json`.
 *
 * Phase 5 step A.3 + step B.1 (validators wired) + step C
 * (persist + schema drift + drift-aware save) + Step C megaudit fixes.
 *
 * Step C wiring:
 *   - On openCustomDocument: load spec + (if a daemon is available)
 *     resolve dataset path, fetch live schema via `client.schema()`,
 *     and run `detectDrift`.
 *   - resolveCustomEditor: subscribe to lifecycle status; on `ready`
 *     from webview, send `init` (with schema if known) plus a
 *     `schemaChanged` follow-up if drift is non-`same-hash`.
 *   - FileSystemWatcher on the dataset's absolute path: re-fetches
 *     schema + re-runs drift detection on external file changes. The
 *     mid-session refresh sends ONLY `schemaChanged` (not `init`),
 *     so the webview's spec/query/persistence/renderer/ui slices are
 *     not clobbered (Step C megaudit C9).
 *   - saveCustomDocument: drift-aware. Drift unknown / detection
 *     in-flight / detection failed → save REFUSED with a structured
 *     error (Step C megaudit C5). `same-hash` saves verbatim;
 *     `fields-preserved` writes a refreshed spec atomically via
 *     `saveAsTransformed`; `fields-missing` refuses with a structured
 *     error.
 *
 * Race safety (Step C megaudit C6):
 *   - Per-document `driftGeneration` counter; bumped at the start of
 *     every `detectAndRecordDrift`. Stale callbacks (whose captured
 *     generation is below the current value) drop their results.
 *
 * State divergence (Step C megaudit C8):
 *   - Drift-aware save's atomic guarantee comes from
 *     `QvizSpecDocument.saveAsTransformed`: the disk write is the gate.
 *     `ctx.driftStatus` is mutated only AFTER `saveAsTransformed`
 *     resolves successfully.
 *
 * Visibility (Step C megaudit C2/C3/C4):
 *   - All daemon/dataset/schema-fetch failures surface visibly. No
 *     `console.warn` swallows. The user sees a notification AND the
 *     save flow refuses until detection completes successfully.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { getNonce, getWebviewUri } from '../../utils/webview';
import { generatePromoteScaffold, readExistingScaffold } from '../../qviz/promoteToChart';
import {
	type DaemonCapabilities,
	type DaemonStatusKind,
	type DaemonStatusMessage,
	type ExtensionMessage,
	type InitMessage,
	type SchemaChangedMessage,
	type SchemaInfo,
	PROTOCOL_VERSION,
	computeSpecHash,
	validateWebviewMessage,
} from '../../qviz/messageProtocol';
import {
	type DaemonLifecycle,
	type LifecycleStatus,
} from '../../qviz/daemon-lifecycle';
import {
	type DriftResult,
	detectDrift,
} from '../../qviz/schemaDrift';
import {
	refreshDatasetProvenance,
	resolveDatasetPath,
} from '../../qviz/persist';
import { decideSave } from '../../qviz/saveDecision';
import { mapDaemonCapsForInit } from '../../qviz/capabilitiesTransform';
import type { QvizSpec } from '../../qviz/spec';
import { QvizSpecDocument, type QvizSpecChangeEvent, SaveConflictError } from './QvizSpecDocument';

// ---------------------------------------------------------------------------
// per-document context -- drift status as a tagged union
// ---------------------------------------------------------------------------

/** Tagged status of drift detection for a document.
 *
 *   - `idle`       -- detection has not been attempted yet
 *                    (daemon was unavailable or doc just opened).
 *   - `in-flight`  -- detection is running; result not yet known.
 *   - `detected`   -- detection completed; `result` and `liveSchema`
 *                    are both authoritative.
 *   - `failed`     -- detection was attempted and failed; `error`
 *                    explains why. Save MUST refuse in this state.
 */
type DriftStatus =
	| { readonly kind: 'idle' }
	| { readonly kind: 'in-flight'; readonly generation: number }
	| {
		readonly kind: 'detected';
		readonly result: DriftResult;
		readonly liveSchema: SchemaInfo;
		readonly generation: number;
	}
	| {
		readonly kind: 'failed';
		readonly error: string;
		readonly generation: number;
	};

interface DocumentContext {
	/** Disposables for this document's subscriptions (events). The file
	 *  watcher is tracked separately as `watcher`. */
	readonly subs: vscode.Disposable[];
	/** Per-document monotonic generation counter; bumped at the start
	 *  of every `detectAndRecordDrift`. */
	driftGeneration: number;
	/** Current drift detection status. */
	driftStatus: DriftStatus;
	/** Resolved absolute path of the dataset the spec points at. Null
	 *  if path resolution failed. Tracking this lets us re-attach the
	 *  watcher only when the path actually changes (avoids the
	 *  watcher-thrash race from Step C megaudit). */
	datasetAbsPath: string | null;
	/** File watcher for the dataset (single dedicated slot, replacing
	 *  the prior dynamic-property-tag pattern). */
	watcher: vscode.Disposable | null;
	/** Cached capabilities snapshot, fetched lazily from the daemon
	 *  and shipped to the webview in every `init` message. Step 5.G.1. */
	capabilities: DaemonCapabilities | null;
	/** Megaudit MAJOR-26: when multiple `edit` messages are in flight
	 *  (e.g., a debounced burst from the webview followed by a
	 *  programmatic edit), each one's content event needs to be
	 *  suppressed only if it matches its specific spec hash. A single
	 *  slot loses earlier hashes; a Set holds all in-flight echoes and
	 *  consumes on match. */
	expectedEchoHashes: Set<string>;
	/** Megaudit MAJOR-23: the most recent failure broadcast type, so
	 *  the late `ready` handler can replay the correct channel
	 *  (`datasetStatus` vs `daemonStatus: 'unavailable'`) instead of
	 *  always sending daemonStatus regardless of root cause. */
	lastFailureBroadcast:
	| null
	| { kind: 'dataset'; payload: import('../../qviz/messageProtocol').DatasetStatusMessage }
	| { kind: 'daemon'; payload: DaemonStatusMessage };
	/** Megaudit MAJOR-22: spec.dataset.uri at last broadcast time. If
	 *  an edit changes the dataset URI, the provider must rebroadcast
	 *  datasetStatus and re-attach the watcher. */
	lastBroadcastDatasetUri: string | null;
}

// ---------------------------------------------------------------------------
// lifecycle source -- abstracts single-lifecycle vs per-folder lifecycle
// ---------------------------------------------------------------------------

/** Provider-side abstraction over daemon lifecycles. The extension
 *  activation supplies an implementation that may be:
 *    - `null`       → no Python found; drift detection disabled.
 *    - `Single`     → one shared lifecycle for all documents
 *                     (single-workspace setups).
 *    - `PerFolder`  → one lifecycle per workspace folder; documents
 *                     route to the lifecycle that owns their folder.
 */
export interface LifecycleSource {
	/** Returns the lifecycle that should serve `documentUri`, or null
	 *  if no daemon is available for this document. */
	getLifecycleForDocument(documentUri: vscode.Uri): DaemonLifecycle | null;
	/** Subscribe to status changes for the lifecycle serving the given
	 *  document. The handler is called for transitions while the
	 *  subscription is active. Returns a disposable that detaches. */
	onStatusChangeForDocument(
		documentUri: vscode.Uri,
		handler: (status: LifecycleStatus) => void,
	): vscode.Disposable;
	/** Latest known status for the lifecycle serving the given document. */
	getStatusForDocument(documentUri: vscode.Uri): LifecycleStatus | null;
}

export interface VisualiseSpecProviderOptions {
	/** Lifecycle source. May be null only when the extension activated
	 *  without a Python interpreter -- in that mode the editor opens
	 *  but drift detection is disabled and SAVE IS REFUSED. */
	readonly lifecycleSource: LifecycleSource | null;
}

export class VisualiseSpecProvider implements vscode.CustomEditorProvider<QvizSpecDocument> {
	public static readonly viewType = 'quantlab.visualiseSpecView';

	static register(
		context: vscode.ExtensionContext,
		options: VisualiseSpecProviderOptions = { lifecycleSource: null },
	): vscode.Disposable {
		const provider = new VisualiseSpecProvider(context, options);
		return vscode.window.registerCustomEditorProvider(
			VisualiseSpecProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<QvizSpecDocument>>();
	readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	private readonly panelByUri = new Map<string, vscode.WebviewPanel>();
	private readonly documentContexts = new Map<QvizSpecDocument, DocumentContext>();
	/** Per-panel monotonic outbound request id. Distinct from any
	 *  global counter so messages within a single panel are strictly
	 *  monotonic (Step C megaudit C-Major: prior global daemonStatus
	 *  counter caused non-monotonic ids within a panel). */
	private readonly outboundRequestIdByUri = new Map<string, number>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly options: VisualiseSpecProviderOptions,
	) { }

	// -----------------------------------------------------------------------
	// CustomEditorProvider lifecycle
	// -----------------------------------------------------------------------

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken,
	): Promise<QvizSpecDocument> {
		const document = await QvizSpecDocument.create(uri, openContext, {
			getDocumentData: async (target) => vscode.workspace.fs.readFile(target),
		});

		const ctx: DocumentContext = {
			subs: [],
			driftGeneration: 0,
			driftStatus: { kind: 'idle' },
			datasetAbsPath: null,
			watcher: null,
			capabilities: null,
			expectedEchoHashes: new Set<string>(),
			lastFailureBroadcast: null,
			lastBroadcastDatasetUri: null,
		};
		this.documentContexts.set(document, ctx);

		ctx.subs.push(
			document.onDidChange(e => this._onDidChangeCustomDocument.fire(e)),
			document.onDidChangeContent(e => this.onDocumentContentChanged(e)),
		);
		// onDidDispose is intentionally NOT pushed to ctx.subs: the
		// dispose handler iterates ctx.subs and would call dispose on
		// the very subscription that's currently firing. Track it
		// separately as a fire-and-forget.
		document.onDidDispose(() => this.onDocumentDispose(document));

		// Kick off drift detection asynchronously. The editor opens
		// regardless; the result lands as a follow-up message.
		void this.detectAndRecordDrift(document, ctx);

		return document;
	}

	async resolveCustomEditor(
		document: QvizSpecDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const key = document.uri.toString();
		this.panelByUri.set(key, webviewPanel);
		// Initialize per-panel counter (don't reuse a stale value).
		this.outboundRequestIdByUri.set(key, 0);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
				vscode.Uri.joinPath(
					this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist',
				),
			],
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
			(rawMsg: unknown) => this.handleWebviewMessage(document, webviewPanel, rawMsg),
		);

		webviewPanel.onDidDispose(() => {
			messageDisposable.dispose();
			if (this.panelByUri.get(key) === webviewPanel) {
				this.panelByUri.delete(key);
				this.outboundRequestIdByUri.delete(key);
			}
		});

		// Subscribe to lifecycle status events for this document and
		// forward to the webview as `daemonStatus` messages. If no
		// lifecycle is available, send a single 'unavailable' status.
		const source = this.options.lifecycleSource;
		if (source !== null) {
			let lastStatusForCaps: import('../../qviz/daemon-lifecycle').LifecycleStatus | null = null;
			const off = source.onStatusChangeForDocument(document.uri, (s) => {
				this.postOrLog(webviewPanel, this.buildDaemonStatusMessage(document.uri, s));
				// Audit M-23 (2026-05-11): on a crash → ready transition
				// (daemon respawn), refetch capabilities and re-broadcast
				// so the webview's inspector gate reflects what the new
				// daemon actually supports. Without this, a respawned
				// daemon with a downgraded capability bag silently keeps
				// the webview's stale flags alive until next init.
				const wasNotReady = lastStatusForCaps?.kind !== 'ready';
				lastStatusForCaps = s;
				if (s.kind === 'ready' && wasNotReady) {
					void this.refetchAndBroadcastCapabilities(document, webviewPanel);
				}
			});
			webviewPanel.onDidDispose(() => off.dispose());
			const initial = source.getStatusForDocument(document.uri);
			if (initial !== null) {
				lastStatusForCaps = initial;
				this.postOrLog(
					webviewPanel,
					this.buildDaemonStatusMessage(document.uri, initial),
				);
			}
		} else {
			this.postOrLog(webviewPanel, {
				type: 'daemonStatus',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(key),
				status: 'unavailable',
				lastError: 'no Python interpreter available; drift detection disabled, save will refuse',
			});
		}
	}

	// -----------------------------------------------------------------------
	// Save / revert / backup (Step C: drift-aware save with atomic disk-gate)
	// -----------------------------------------------------------------------

	async saveCustomDocument(
		document: QvizSpecDocument, _token: vscode.CancellationToken,
	): Promise<void> {
		// Megaudit-2 A2-CRITICAL-1/2/3: emit `saveStarted` BEFORE the
		// save so the webview's `pendingSaveHash` is populated; emit
		// `saveResult` (with the SAME attempted hash) on both success
		// and failure paths so the persistence reducer's gate accepts
		// the result. Wrap in try/catch so a failure still broadcasts.
		const attemptedHash = computeSpecHash(document.spec);
		this.broadcastSaveStarted(document, attemptedHash);
		try {
			await this.driftAwareSaveAs(document, document.uri);
			this.broadcastSaveResult(document, document.uri, 'ok', attemptedHash);
		} catch (e) {
			this.broadcastSaveResult(document, document.uri, 'failed', attemptedHash, (e as Error).message);
			throw e;
		}
	}

	async saveCustomDocumentAs(
		document: QvizSpecDocument, target: vscode.Uri, _token: vscode.CancellationToken,
	): Promise<void> {
		const attemptedHash = computeSpecHash(document.spec);
		// Megaudit Theme E (E1, 2026-05-13): refuse Save As across
		// workspace folders. Drift status, watcher, capabilities, and
		// daemon lifecycle are all bound to the SOURCE document's
		// workspace folder. Routing this save through the source
		// folder's daemon when target is in a different folder
		// produces provenance from the WRONG daemon (different
		// mtime_ns / schema_hash if the folders point at different
		// copies of the data file). Refuse with a clear message.
		const sourceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		const targetFolder = vscode.workspace.getWorkspaceFolder(target);
		const crossFolder = (
			(sourceFolder?.uri.toString() ?? null) !== (targetFolder?.uri.toString() ?? null)
		);
		if (target.toString() !== document.uri.toString() && crossFolder) {
			const msg = 'Visualise: Save As across workspace folders is not '
				+ 'supported (drift attribution would be incorrect). Open the '
				+ 'target folder in its own window and save there.';
			this.broadcastSaveResult(document, target, 'failed', attemptedHash, msg);
			void vscode.window.showErrorMessage(msg);
			throw new Error(msg);
		}
		this.broadcastSaveStarted(document, attemptedHash);
		try {
			await this.driftAwareSaveAs(document, target);
			this.broadcastSaveResult(document, target, 'ok', attemptedHash);
		} catch (e) {
			this.broadcastSaveResult(document, target, 'failed', attemptedHash, (e as Error).message);
			throw e;
		}
	}

	/**
	 * Megaudit CRITICAL-5: webview-initiated save (e.g., a builder UI
	 * Save button) must drive the SAME drift-aware path AND broadcast
	 * a `saveResult` so the webview's persistence slice tracks the
	 * outcome. Without this, the webview's `lastSavedHash` never
	 * advances after a successful save, and dirty state stays stuck.
	 */
	private async handleWebviewSave(
		document: QvizSpecDocument,
		panel: vscode.WebviewPanel,
		msg: import('../../qviz/messageProtocol').SaveMessage,
	): Promise<void> {
		// Megaudit Theme E (E14, 2026-05-13): idempotently emit
		// saveStarted from the provider. The convention was "the
		// webview already dispatched its own", documented only in
		// comments. A webview implementation that posts `save` without
		// having internally dispatched saveStarted leaves pendingSaveHash
		// unset, and the persistence reducer drops the saveResult.
		// Re-emitting saveStarted with the same hash is idempotent in
		// the reducer (same hash → no-op set). Closes the foot-gun.
		this.broadcastSaveStarted(document, msg.specHash);
		try {
			await this.driftAwareSaveAs(document, document.uri);
			this.broadcastSaveResult(document, document.uri, 'ok', msg.specHash);
		} catch (e) {
			this.broadcastSaveResult(document, document.uri, 'failed', msg.specHash, (e as Error).message);
			this.postEnvelopeError(panel, msg.requestId, msg.specHash,
				(e as Error).message, 'internal');
		}
	}

	private async handleWebviewSaveAs(
		document: QvizSpecDocument,
		panel: vscode.WebviewPanel,
		msg: import('../../qviz/messageProtocol').SaveAsMessage,
	): Promise<void> {
		// In v1 the webview can't supply a target URI; route through the
		// document URI to maintain a single save lifecycle path.
		// E14: same idempotent saveStarted emission as handleWebviewSave.
		this.broadcastSaveStarted(document, msg.specHash);
		try {
			await this.driftAwareSaveAs(document, document.uri);
			this.broadcastSaveResult(document, document.uri, 'ok', msg.specHash);
		} catch (e) {
			this.broadcastSaveResult(document, document.uri, 'failed', msg.specHash, (e as Error).message);
			this.postEnvelopeError(panel, msg.requestId, msg.specHash,
				(e as Error).message, 'internal');
		}
	}

	/** Megaudit-2 A2-CRITICAL-1: emit before host-initiated save so
	 *  the webview's persistence reducer populates `pendingSaveHash`
	 *  and the matching saveResult passes its specHash gate. */
	private broadcastSaveStarted(
		document: QvizSpecDocument, attemptedHash: string,
	): void {
		const panel = this.panelByUri.get(document.uri.toString());
		if (!panel) { return; }
		this.postOrLog(panel, {
			type: 'saveStarted',
			protocolVersion: PROTOCOL_VERSION,
			requestId: this.nextRequestId(document.uri.toString()),
			specHash: attemptedHash,
		});
	}

	/** Megaudit-2 A2-CRITICAL-2: takes the ATTEMPTED specHash (the
	 *  spec the user tried to save), not document.savedSpec. The
	 *  webview's persistence reducer requires
	 *  `pendingSaveHash === action.specHash`; only the attempted-hash
	 *  satisfies that.
	 *  Megaudit-2 A2-M1 / CODEX-6: NO LONGER re-emits init after
	 *  success -- that was a workaround for A2-CRITICAL-1 that also
	 *  reset the webview's ui slice (focus, active shelf, transform
	 *  editor index). With saveStarted now wired correctly, the
	 *  reducer advances lastSavedHash directly from saveResult. */
	private broadcastSaveResult(
		document: QvizSpecDocument,
		target: vscode.Uri,
		status: 'ok' | 'failed',
		attemptedHash: string,
		errorMessage?: string,
	): void {
		const panel = this.panelByUri.get(document.uri.toString());
		if (!panel) { return; }
		if (status === 'ok') {
			this.postOrLog(panel, {
				type: 'saveResult',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(document.uri.toString()),
				specHash: attemptedHash,
				status: 'ok',
				fsPath: target.fsPath,
			});
		} else {
			this.postOrLog(panel, {
				type: 'saveResult',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(document.uri.toString()),
				specHash: attemptedHash,
				status: 'failed',
				error: errorMessage ?? 'save failed (unknown error)',
			});
		}
	}

	async revertCustomDocument(
		document: QvizSpecDocument, _token: vscode.CancellationToken,
	): Promise<void> {
		// Megaudit-2 (true M-21): clear `expectedEchoHashes` BEFORE the
		// revert. Otherwise an in-flight edit's delayed contentChange
		// echo (whose hash matches the now-stale Set entry) would be
		// suppressed at broadcast time, and the user would see the
		// revert flash followed by a snap-back to the pre-revert state
		// when the (un-suppressed) prior edit's content event finally
		// fires.
		const ctx = this.documentContexts.get(document);
		if (ctx) { ctx.expectedEchoHashes.clear(); }
		await document.revert({
			getDocumentData: async (uri) => vscode.workspace.fs.readFile(uri),
		});
		// Re-run drift detection: the on-disk spec is now in memory, so
		// the schema_hash recorded there may differ from the live one.
		if (ctx) { void this.detectAndRecordDrift(document, ctx); }
	}

	async backupCustomDocument(
		document: QvizSpecDocument,
		context: vscode.CustomDocumentBackupContext,
		_token: vscode.CancellationToken,
	): Promise<vscode.CustomDocumentBackup> {
		return document.backup(context.destination);
	}

	// -----------------------------------------------------------------------
	// drift detection -- race-safe via generation counter
	// -----------------------------------------------------------------------

	/**
	 * Run drift detection for `document`. Race-safe: each invocation
	 * captures a generation number; results are committed only if the
	 * captured generation still matches the document's current
	 * generation at the time of write.
	 *
	 * Failure modes are SURFACED, not swallowed:
	 *   - Dataset resolution failure → `ctx.driftStatus = failed(...)`,
	 *     panel notified via daemonStatus 'unavailable' with lastError,
	 *     `vscode.window.showErrorMessage` for severe path violations.
	 *   - Daemon unavailable → `ctx.driftStatus = failed(...)`, panel
	 *     already informed by lifecycle status events.
	 *   - Schema fetch failure → `ctx.driftStatus = failed(...)`,
	 *     daemonStatus message synthesized with the underlying error.
	 *
	 * Save flow refuses unless `ctx.driftStatus.kind === 'detected'`
	 * AND result is not `fields-missing`.
	 */
	private async detectAndRecordDrift(
		document: QvizSpecDocument, ctx: DocumentContext,
	): Promise<void> {
		const source = this.options.lifecycleSource;
		if (source === null) {
			ctx.driftStatus = {
				kind: 'failed',
				error: 'no Python interpreter available; drift detection disabled',
				generation: ++ctx.driftGeneration,
			};
			return;
		}

		// Snapshot generation BEFORE any await; later writes guard on it.
		ctx.driftGeneration += 1;
		const myGeneration = ctx.driftGeneration;
		ctx.driftStatus = { kind: 'in-flight', generation: myGeneration };

		const spec = document.spec;
		const workspaceRoot = workspaceRootForUri(document.uri);
		const resolved = resolveDatasetPath(spec.dataset.uri, workspaceRoot);
		if (resolved.kind !== 'ok') {
			if (myGeneration !== ctx.driftGeneration) { return; }
			const message = `Dataset resolution failed for ${document.uri.fsPath}: ${resolved.message}`;
			ctx.driftStatus = {
				kind: 'failed', error: resolved.message, generation: myGeneration,
			};
			ctx.datasetAbsPath = null;
			this.detachWatcher(ctx);
			void vscode.window.showErrorMessage(`Visualise: ${message}`);
			// Step 5.I.3: send a dedicated datasetStatus banner instead
			// of recycling daemonStatus 'unavailable'. The webview can
			// distinguish "data file gone" from "daemon crashed".
			this.broadcastDatasetStatusToPanel(document, spec.dataset.uri, resolved);
			return;
		}

		// (Re-)attach watcher only when the absolute path actually changed.
		if (ctx.datasetAbsPath !== resolved.absPath) {
			this.detachWatcher(ctx);
			ctx.datasetAbsPath = resolved.absPath;
			this.attachDatasetWatcher(document, ctx, resolved.absPath);
		}

		const lifecycle = source.getLifecycleForDocument(document.uri);
		if (lifecycle === null) {
			if (myGeneration !== ctx.driftGeneration) { return; }
			const error = 'no daemon lifecycle available for this document\'s workspace folder';
			ctx.driftStatus = { kind: 'failed', error, generation: myGeneration };
			this.broadcastDriftFailureToPanel(document, ctx, error);
			return;
		}

		let client;
		try {
			client = await lifecycle.getClient();
		} catch (e) {
			if (myGeneration !== ctx.driftGeneration) { return; }
			const error = (e as Error).message;
			ctx.driftStatus = { kind: 'failed', error, generation: myGeneration };
			this.broadcastDriftFailureToPanel(document, ctx, error);
			return;
		}

		let liveSchema: SchemaInfo;
		try {
			const schemaResult = await client.schema(spec.dataset.uri);
			liveSchema = {
				uri: schemaResult.data.uri,
				schema_hash: schemaResult.data.schema_hash,
				mtime_ns: schemaResult.data.mtime_ns,
				row_count: schemaResult.data.row_count,
				columns: schemaResult.data.columns,
			};
		} catch (e) {
			// Step 5.G.1: capabilities are fetched in the same try-tree
			// so a daemon failure during init reports cleanly. Note:
			// schema-fetch errors are surfaced; capability-fetch errors
			// are caught separately below so a transient capability
			// failure doesn't block drift detection.
			if (myGeneration !== ctx.driftGeneration) { return; }
			const error = `schema fetch failed: ${(e as Error).message}`;
			ctx.driftStatus = { kind: 'failed', error, generation: myGeneration };
			void vscode.window.showErrorMessage(`Visualise: ${error}`);
			this.broadcastDriftFailureToPanel(document, ctx, error);
			return;
		}

		// Megaudit CRITICAL-8: fetch capabilities BEFORE writing the
		// `detected` status so the status assignment + broadcast is a
		// single non-awaiting sequence. If we wrote `detected` first
		// then awaited capabilities, a concurrent watcher fire during
		// the await could leave the status field stale-but-claiming-
		// detected, and a save in that window would use the old
		// liveSchema for provenance refresh.
		// Megaudit MAJOR-1: capability fetch failure is NOT silent
		// fallback. The webview's transform menu is derived from
		// capabilities; offering transforms the daemon can't run is
		// worse than refusing. Treat failure as a drift failure.
		let capabilities: DaemonCapabilities;
		try {
			const cap = await client.capabilities();
			if (myGeneration !== ctx.driftGeneration) { return; }
			// Megaudit F1 (2026-05-13): the snake/camel transform lives
			// in `capabilitiesTransform.ts` so this site and the
			// post-respawn refetch site below cannot drift.
			capabilities = mapDaemonCapsForInit(cap.data);
		} catch (e) {
			if (myGeneration !== ctx.driftGeneration) { return; }
			const error = `capabilities fetch failed: ${(e as Error).message}`;
			ctx.driftStatus = { kind: 'failed', error, generation: myGeneration };
			void vscode.window.showErrorMessage(`Visualise: ${error}`);
			this.broadcastDriftFailureToPanel(document, ctx, error);
			return;
		}
		// All I/O complete. Now write detected status + broadcast in a
		// single non-awaiting block (no further awaits below).
		if (myGeneration !== ctx.driftGeneration) { return; }
		const result = detectDrift(spec, liveSchema);
		ctx.capabilities = capabilities;
		ctx.driftStatus = {
			kind: 'detected', result, liveSchema, generation: myGeneration,
		};
		this.broadcastDetectedDriftToPanel(document, ctx, result, liveSchema, spec.dataset.uri);
	}

	private attachDatasetWatcher(
		document: QvizSpecDocument, ctx: DocumentContext, absPath: string,
	): void {
		const dir = vscodePath_dirname(absPath);
		const file = vscodePath_basename(absPath);
		const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), file);
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const onChange = (): void => {
			void this.detectAndRecordDrift(document, ctx);
		};
		const subs = [
			watcher.onDidChange(onChange),
			watcher.onDidCreate(onChange),
			watcher.onDidDelete(onChange),
			watcher,
		];
		ctx.watcher = vscode.Disposable.from(...subs);
	}

	private detachWatcher(ctx: DocumentContext): void {
		if (ctx.watcher !== null) {
			ctx.watcher.dispose();
			ctx.watcher = null;
		}
	}

	private onDocumentDispose(document: QvizSpecDocument): void {
		const ctx = this.documentContexts.get(document);
		if (!ctx) { return; }
		// Bump generation so any in-flight detection drops its result.
		ctx.driftGeneration += 1;
		this.detachWatcher(ctx);
		for (const d of ctx.subs) {
			try { d.dispose(); } catch (e) {
				// One disposable throwing must not block the rest. Logged
				// (system-boundary cleanup), per CLAUDE.md exception.
				console.warn('VisualiseSpecProvider: subscription dispose threw:', e);
			}
		}
		this.documentContexts.delete(document);
		// Megaudit Theme E (E10, 2026-05-13): defensively purge per-URI
		// maps. Normally onDidDispose on the webview panel handles this,
		// but in the corner case where a panel outlives its document
		// (extension-host error path), the entries would leak. Removing
		// them here means future re-resolution starts from a clean slot.
		const key = document.uri.toString();
		this.panelByUri.delete(key);
		this.outboundRequestIdByUri.delete(key);
	}

	private broadcastDetectedDriftToPanel(
		document: QvizSpecDocument,
		ctx: DocumentContext,
		result: DriftResult,
		liveSchema: SchemaInfo,
		// Megaudit-2 A2-M7: caller must pass the dataset URI AS
		// SNAPSHOTTED at drift-detection start. Reading `document.spec`
		// here would see the LIVE spec (mutated by edits during the
		// schema()+capabilities() awaits), so we'd announce a dataset
		// URI that doesn't match the URI we just ran schema() against.
		// Inconsistent state in the webview: result was computed for
		// dataset A, banner says dataset B.
		snapshottedDatasetUri: string,
	): void {
		// Megaudit: clear the recorded failure broadcast on a success,
		// AND record the current dataset URI so onDocumentContentChanged
		// can detect a URI change and re-resolve.
		ctx.lastFailureBroadcast = null;
		ctx.lastBroadcastDatasetUri = snapshottedDatasetUri;
		// Megaudit MAJOR-32: also send a `datasetStatus: 'ok'` so the
		// webview clears any prior dataset-error banner. The init/edit
		// path posts this elsewhere, but mid-session detection also
		// needs to.
		const panel = this.panelByUri.get(document.uri.toString());
		if (!panel) { return; }
		this.postOrLog(panel, {
			type: 'datasetStatus',
			protocolVersion: PROTOCOL_VERSION,
			requestId: this.nextRequestId(document.uri.toString()),
			status: 'ok',
			datasetUri: snapshottedDatasetUri,
		});
		// Mid-session refresh: send ONLY a schemaChanged message.
		// Sending init here would clobber spec/query/persistence/renderer/
		// ui slices on the webview side (Step C megaudit C9). The
		// schemaChanged message updates `info` (the column list) without
		// touching other slices, including drift kind = same-hash for
		// unchanged schemas.
		this.postOrLog(panel, this.buildSchemaChangedMessage(
			document.uri, result, liveSchema,
		));
	}

	private broadcastDatasetStatusToPanel(
		document: QvizSpecDocument,
		datasetUri: string,
		resolved: import('../../qviz/persist').ResolveDatasetError,
	): void {
		const ctx = this.documentContexts.get(document);
		const kind = mapResolveErrorToDatasetStatus(resolved.kind);
		const payload: import('../../qviz/messageProtocol').DatasetStatusMessage = {
			type: 'datasetStatus',
			protocolVersion: PROTOCOL_VERSION,
			requestId: this.nextRequestId(document.uri.toString()),
			status: kind,
			datasetUri,
			error: resolved.message,
		};
		// Megaudit MAJOR-23: record the broadcast so the late `ready`
		// handler can replay the SAME message type instead of always
		// sending daemonStatus 'unavailable'.
		if (ctx) {
			ctx.lastFailureBroadcast = { kind: 'dataset', payload };
			ctx.lastBroadcastDatasetUri = datasetUri;
		}
		const panel = this.panelByUri.get(document.uri.toString());
		if (!panel) { return; }
		this.postOrLog(panel, payload);
	}

	private broadcastDriftFailureToPanel(
		document: QvizSpecDocument, ctx: DocumentContext, error: string,
	): void {
		const payload: DaemonStatusMessage = {
			type: 'daemonStatus',
			protocolVersion: PROTOCOL_VERSION,
			requestId: this.nextRequestId(document.uri.toString()),
			status: 'unavailable',
			lastError: `drift detection failed: ${error}`,
		};
		ctx.lastFailureBroadcast = { kind: 'daemon', payload };
		const panel = this.panelByUri.get(document.uri.toString());
		if (!panel) { return; }
		this.postOrLog(panel, payload);
	}

	// -----------------------------------------------------------------------
	// drift-aware save -- atomic via QvizSpecDocument.saveAsTransformed
	// -----------------------------------------------------------------------

	private async driftAwareSaveAs(
		document: QvizSpecDocument, target: vscode.Uri,
	): Promise<void> {
		const ctx = this.documentContexts.get(document);
		if (!ctx) {
			throw new Error('Visualise: missing document context for save');
		}
		// Megaudit-2 A2-M5: re-compute `decision` on EVERY save attempt
		// (initial + each conflict-prompt retry) rather than capturing
		// it once. If the dataset file changes while the user is staring
		// at the Overwrite/Cancel modal, the file-system watcher fires,
		// drift detection updates ctx.driftStatus, and a stale captured
		// liveSchema would write provenance referring to a no-longer-
		// current schema_hash. Reading ctx.driftStatus fresh inside the
		// op closure guarantees the retry uses the latest detected
		// drift state.
		let lastWithRefreshLiveSchema: SchemaInfo | null = null;
		const computeOp = (skipConflictCheck: boolean): Promise<unknown> => {
			const statusNow = ctx.driftStatus;
			const decisionNow = decideSave(driftStatusForSave(statusNow));
			if (decisionNow.action === 'refuse') {
				void vscode.window.showErrorMessage(`Visualise: ${decisionNow.userMessage}`);
				throw new Error(decisionNow.userMessage);
			}
			if (decisionNow.action === 'with-refresh') {
				const liveSchema = decisionNow.liveSchema;
				lastWithRefreshLiveSchema = liveSchema;
				const transform = (spec: QvizSpec): QvizSpec => refreshDatasetProvenance(spec, {
					newSchemaHash: liveSchema.schema_hash,
					newMtimeNs: liveSchema.mtime_ns,
					newRowCount: liveSchema.row_count,
					nowIso: new Date().toISOString(),
				});
				return document.saveAsTransformed(
					target, transform, { skipConflictCheck },
				);
			}
			// decisionNow.action === 'verbatim'
			lastWithRefreshLiveSchema = null;
			return document.saveAs(target, { skipConflictCheck });
		};
		// Up-front refusal so the user-visible error fires once, before
		// any prompt UI. Don't catch -- let it propagate so VS Code knows
		// the save did not complete.
		const initialDecision = decideSave(driftStatusForSave(ctx.driftStatus));
		if (initialDecision.action === 'refuse') {
			void vscode.window.showErrorMessage(`Visualise: ${initialDecision.userMessage}`);
			throw new Error(initialDecision.userMessage);
		}
		await this.runWithConflictPrompt(document, target, computeOp);
		// Disk write succeeded with the LAST decision computed. If that
		// was a with-refresh, mutate ctx.driftStatus to reflect resolved
		// drift, using the liveSchema actually written.
		//
		// Megaudit Theme E (E5, 2026-05-13): drop the
		// `&& ctx.driftStatus.kind === 'detected'` guard. A parallel
		// watcher fire during the save's await window could transition
		// driftStatus to 'failed' (e.g., transient schema fetch error
		// after disk write); the guard previously kept that failed
		// state, so the next save refused with "drift detection
		// failed" even though disk was fresh. Bump the generation so
		// any still-in-flight detection's result is dropped on landing.
		if (lastWithRefreshLiveSchema !== null) {
			const liveSchema: SchemaInfo = lastWithRefreshLiveSchema;
			ctx.driftGeneration += 1;
			ctx.driftStatus = {
				kind: 'detected',
				result: {
					drift: 'same-hash',
					oldHash: liveSchema.schema_hash,
					newHash: liveSchema.schema_hash,
					missingFields: [],
				},
				liveSchema,
				generation: ctx.driftGeneration,
			};
		}
	}

	/**
	 * Step 5.I.4: wrap a save operation with conflict-prompt UI. The
	 * provided `op` accepts a `skipConflictCheck` boolean and runs the
	 * actual save. On first call we pass `false`; if it throws
	 * SaveConflictError, we prompt and (on Overwrite) retry with
	 * `true`. On Cancel we rethrow so VS Code's save flow knows the
	 * save did not complete.
	 */
	private async runWithConflictPrompt(
		_document: QvizSpecDocument,
		_target: vscode.Uri,
		op: (skipConflictCheck: boolean) => Promise<unknown>,
	): Promise<void> {
		try {
			await op(false);
			return;
		} catch (e) {
			if (!(e instanceof SaveConflictError)) { throw e; }
			const choice = await vscode.window.showWarningMessage(
				e.message,
				{ modal: true },
				'Overwrite', 'Cancel',
			);
			if (choice !== 'Overwrite') {
				throw e;
			}
			await op(true);
		}
	}

	// -----------------------------------------------------------------------
	// outbound messages
	// -----------------------------------------------------------------------

	private onDocumentContentChanged(e: QvizSpecChangeEvent): void {
		const panel = this.panelByUri.get(e.document.uri.toString());
		if (!panel) { return; }
		const ctx = this.documentContexts.get(e.document);
		// Megaudit MAJOR-26: the echo gate is a Set so multiple
		// in-flight edits don't clobber each other. Consume on match;
		// non-matching content (e.g., a revert during a pending edit
		// echo) leaves OTHER expected echoes intact for their own
		// content events to consume later.
		const incomingHash = computeSpecHash(e.next);
		if (ctx && ctx.expectedEchoHashes.has(incomingHash)) {
			ctx.expectedEchoHashes.delete(incomingHash);
			return;
		}
		// Megaudit MAJOR-22: if the dataset URI changed (e.g., user
		// edited it in the spec, or a revert restored a different URI),
		// re-resolve the dataset and rebroadcast datasetStatus. The
		// watcher is also re-attached to the new path inside
		// detectAndRecordDrift.
		const datasetUriChanged = ctx !== undefined
			&& ctx.lastBroadcastDatasetUri !== e.next.dataset.uri;
		if (datasetUriChanged) {
			// Megaudit Theme E (E4, 2026-05-13): transition driftStatus
			// to in-flight SYNCHRONOUSLY before firing the init.
			// Without this, the init carries the OLD dataset's
			// liveSchema, and the webview renders columns that don't
			// exist in the new file until the async detection completes.
			ctx.driftGeneration += 1;
			ctx.driftStatus = { kind: 'in-flight', generation: ctx.driftGeneration };
			void this.detectAndRecordDrift(e.document, ctx);
		}
		// E4: drop liveSchema when the dataset URI just changed —
		// the new schema isn't known yet. The webview shows "loading
		// schema…" until the follow-up schemaChanged lands.
		const liveSchema = (ctx && !datasetUriChanged && ctx.driftStatus.kind === 'detected')
			? ctx.driftStatus.liveSchema : null;
		this.postOrLog(panel, this.buildInitMessage(
			e.document.uri, e.next, liveSchema, ctx?.capabilities ?? null,
			e.document.savedSpec,
		));
		// Step C megaudit C7: every spec edit fires init with liveSchema,
		// which on the webview side resets `drift` to `same-hash` (the
		// init-with-schema reducer behavior). To preserve a non-same
		// drift warning across edits, re-send the schemaChanged message
		// after init when drift is non-same.
		if (
			ctx && ctx.driftStatus.kind === 'detected'
			&& ctx.driftStatus.result.drift !== 'same-hash'
		) {
			this.postOrLog(panel, this.buildSchemaChangedMessage(
				e.document.uri, ctx.driftStatus.result, ctx.driftStatus.liveSchema,
			));
		}
	}

	private handleWebviewMessage(
		document: QvizSpecDocument,
		panel: vscode.WebviewPanel,
		rawMsg: unknown,
	): void {
		const result = validateWebviewMessage(rawMsg);
		if (!result.ok) {
			console.error(`VisualiseSpecProvider: invalid webview message: ${result.error}`);
			void vscode.window.showErrorMessage(
				`Visualise spec: malformed webview message (${result.error})`,
			);
			return;
		}
		const msg = result.value;
		// Step D wiring: requestData drives the live-preview cycle. The
		// webview sends a request when the spec changes; we forward to
		// the daemon, then post `data` or `error` back. Stale-result
		// attribution rests on the protocol's requestId + specHash --
		// validators on both sides enforce them.
		if (msg.type === 'requestData') {
			void this.handleRequestData(document, panel, msg);
			return;
		}
		// Step 5.H.2: edit messages drive VS Code's standard undo stack
		// via document.applyEdit. The webview is the source of truth
		// for the new spec; provider records the edit but suppresses
		// the contentChange echo back to the source panel.
		if (msg.type === 'edit') {
			this.handleEdit(document, msg);
			return;
		}
		switch (msg.type) {
			case 'ready': {
				const ctx = this.documentContexts.get(document);
				const liveSchema = ctx && ctx.driftStatus.kind === 'detected'
					? ctx.driftStatus.liveSchema : null;
				this.postOrLog(panel, this.buildInitMessage(
					document.uri, document.spec, liveSchema, ctx?.capabilities ?? null,
					document.savedSpec,
				));
				// Megaudit-2 A3-MAJOR-3 / CODEX-5: re-emit current
				// daemonStatus AFTER init. The init reducer (correctly)
				// resets `runtime.daemonStatus` to 'idle' for the new
				// document; without re-emitting the live status, the
				// webview wedges at 'idle' until the next status
				// transition (which may never happen for a stable
				// daemon). The lifecycle status was posted at
				// resolveCustomEditor BEFORE init, so it gets
				// overwritten by init.
				const source = this.options.lifecycleSource;
				if (source !== null) {
					const liveStatus = source.getStatusForDocument(document.uri);
					if (liveStatus !== null) {
						this.postOrLog(panel,
							this.buildDaemonStatusMessage(document.uri, liveStatus));
					}
				}
				if (
					ctx && ctx.driftStatus.kind === 'detected'
					&& ctx.driftStatus.result.drift !== 'same-hash'
				) {
					this.postOrLog(panel, this.buildSchemaChangedMessage(
						document.uri, ctx.driftStatus.result, ctx.driftStatus.liveSchema,
					));
				}
				// Megaudit MAJOR-23: replay the SPECIFIC failure
				// broadcast captured at detection time, not always
				// daemonStatus. A dataset-resolution failure surfaces
				// as datasetStatus; a daemon/schema failure surfaces as
				// daemonStatus. If neither was recorded but drift is
				// failed, fall back to the daemon channel.
				if (ctx && ctx.driftStatus.kind === 'failed') {
					if (ctx.lastFailureBroadcast !== null) {
						// Megaudit-2 CODEX-7: rebuild the payload with a
						// FRESH requestId on replay. The stored payload
						// carries the ORIGINAL id from broadcast time;
						// replaying it after an `init` (which advanced
						// the counter) would emit a non-monotonic
						// duplicate. Spread + override the id.
						const stale = ctx.lastFailureBroadcast.payload;
						const freshId = this.nextRequestId(document.uri.toString());
						this.postOrLog(panel, { ...stale, requestId: freshId });
					} else {
						this.postOrLog(panel, {
							type: 'daemonStatus',
							protocolVersion: PROTOCOL_VERSION,
							requestId: this.nextRequestId(document.uri.toString()),
							status: 'unavailable',
							lastError: `drift detection failed: ${ctx.driftStatus.error}`,
						});
					}
				}
				return;
			}
			// Megaudit CRITICAL-5: persistence lifecycle messages.
			// VS Code's Cmd+S routes through `saveCustomDocument` (not
			// these webview messages), but the webview can also
			// request a save imperatively (e.g., a Save button in the
			// builder). The provider must respond by driving the same
			// driftAwareSaveAs path AND broadcasting saveResult so the
			// webview's persistence slice tracks the outcome.
			case 'save': {
				void this.handleWebviewSave(document, panel, msg);
				return;
			}
			case 'saveAs': {
				void this.handleWebviewSaveAs(document, panel, msg);
				return;
			}
			case 'requestInspectorData': {
				void this.handleRequestInspectorData(document, panel, msg);
				return;
			}
			case 'requestColumnStats': {
				void this.handleRequestColumnStats(document, panel, msg);
				return;
			}
			case 'retryDaemon': {
				void this.handleRetryDaemon(document, panel);
				return;
			}
			case 'recheckDataset': {
				void this.handleRecheckDataset(document, panel);
				return;
			}
			case 'promoteToChart': {
				void this.handlePromoteToChart(document);
				return;
			}
			case 'openSpec':
			case 'discardChanges':
				// Reserved protocol slots. v1 doesn't surface UI for
				// these; ignore loudly with a structured error so a
				// misbehaving sender sees the rejection rather than
				// silent acceptance.
				//
				// Megaudit Theme E (E11, 2026-05-13): use the CURRENT
				// doc spec hash. The previous all-zero `q1:0000...`
				// could never match any in-flight queryState entry, so
				// the webview's reducer silently dropped the error and
				// the user saw nothing. Now the error attributes to the
				// real state and at least logs as stale-attribution.
				this.postEnvelopeError(panel,
					(msg as { requestId: number }).requestId,
					computeSpecHash(document.spec),
					`'${msg.type}' is reserved and not handled in v1`,
					'internal');
				return;
			default: {
				const exhaustive: never = msg;
				throw new Error(`unknown WebviewMessage: ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	/**
	 * Forward a webview `requestData` to the daemon's aggregate op and
	 * post the result back. Drift-aware: refuses to dispatch if the
	 * spec's recorded drift is `fields-missing` or the drift status is
	 * unknown -- matches the save flow's policy.
	 *
	 * Errors are reported via the `error` message (kind 'internal' for
	 * daemon/lifecycle issues, 'compile' for daemon op rejections). The
	 * webview's queryState reducer routes them to its diagnostics panel.
	 */
	/**
	 * Record a webview-initiated edit on the document. Drives VS Code's
	 * standard undo stack: `document.applyEdit` fires the
	 * `onDidChange` event whose `undo` callback restores the previous
	 * spec on Cmd+Z. Step 5.H.2.
	 *
	 * The provider records the incoming spec hash in `expectedEchoHashes` so
	 * the resulting contentChange event (which fires synchronously from
	 * within applyEdit) is suppressed at the broadcast layer. Without
	 * this, the source panel would receive an `init` re-stating the
	 * spec it just sent -- wasteful at best, UI-state-clobbering at
	 * worst (focus / active shelf / editingTransformIndex would all
	 * reset).
	 */
	private handleEdit(
		document: QvizSpecDocument,
		msg: import('../../qviz/messageProtocol').EditMessage,
	): void {
		const ctx = this.documentContexts.get(document);
		if (!ctx) { return; }
		// Megaudit-2 CODEX-4 / A2-CRITICAL-5: skip the Set add when
		// the incoming spec hash equals the document's CURRENT hash --
		// `applyEdit` will short-circuit silently for structurally-
		// equal specs (no fireContent), so an added hash would never
		// be consumed and would leak. A subsequent legitimate edit
		// or revert producing the same hash would then be incorrectly
		// suppressed by the leaked entry.
		const currentHash = computeSpecHash(document.spec);
		const willEmit = msg.specHash !== currentHash;
		if (willEmit) {
			ctx.expectedEchoHashes.add(msg.specHash);
		}
		try {
			document.applyEdit(msg.spec, msg.label);
		} catch (e) {
			// applyEdit can throw in two distinct phases:
			//   (a) BEFORE any state mutation: disposed-doc, reentrant
			//       call, validator rejection -- the edit truly did NOT
			//       land on the undo stack.
			//   (b) AFTER fireEdit registered the undo entry, when a
			//       subscriber's content/edit handler threw -- the edit
			//       DID land; only a subscriber failed.
			// Megaudit-2 A2-M2: distinguish the two so the webview's
			// error toast is accurate. The previous unconditional
			// "Edit not recorded" was a lie for case (b) and would mislead
			// debugging.
			// Megaudit Theme E (E6, 2026-05-13): only delete the echo
			// hash when the error is pre-mutation. Post-mutation failures
			// (a subscriber threw AFTER fireEdit) already had their hash
			// consumed by `onDocumentContentChanged`; deleting it again
			// here is at best a no-op and at worst clobbers another
			// in-flight edit that happens to share the same hash.
			const errName = (e instanceof Error) ? e.name : '';
			const preMutation = (
				errName === 'ReentrantApplyEditError'
				|| errName === 'DisposedError'
				|| (e instanceof Error && e.message.includes('applyEdit rejected an invalid spec'))
			);
			if (willEmit && preMutation) {
				ctx.expectedEchoHashes.delete(msg.specHash);
			}
			console.error(
				`VisualiseSpecProvider: applyEdit failed for ${document.uri.toString()}: `,
				e,
			);
			const panel = this.panelByUri.get(document.uri.toString());
			if (panel) {
				const prefix = preMutation
					? 'Edit not recorded'
					: 'Edit recorded but a subscriber failed';
				this.postEnvelopeError(
					panel, msg.requestId, msg.specHash,
					`${prefix}: ${(e as Error).message}`,
					'internal',
				);
			}
		}
	}

	private async handleRequestData(
		document: QvizSpecDocument,
		panel: vscode.WebviewPanel,
		msg: import('../../qviz/messageProtocol').RequestDataMessage,
	): Promise<void> {
		const ctx = this.documentContexts.get(document);
		if (!ctx) { return; }
		// Drift gating: a save-time refusal also applies to data
		// fetches. We don't want to ask the daemon to aggregate a spec
		// that references missing columns.
		if (ctx.driftStatus.kind === 'detected'
			&& ctx.driftStatus.result.drift === 'fields-missing') {
			// Megaudit CRITICAL-2: error MUST echo the inbound requestId
			// so the webview's queryState reducer's specHash+requestId
			// gate accepts it. Without this, the reducer drops it as
			// stale and the UI stays "computing…" forever.
			this.postEnvelopeError(panel, msg.requestId, msg.specHash,
				`Cannot run aggregate: spec references missing fields (${ctx.driftStatus.result.missingFields.join(', ')}).`,
				'compile');
			return;
		}

		const source = this.options.lifecycleSource;
		if (source === null) {
			this.postEnvelopeError(panel, msg.requestId, msg.specHash,
				'No daemon available (no Python interpreter).', 'internal');
			return;
		}
		let client;
		try {
			const lifecycle = source.getLifecycleForDocument(document.uri);
			if (lifecycle === null) {
				this.postEnvelopeError(panel, msg.requestId, msg.specHash,
					"No daemon available for this document's workspace folder.", 'internal');
				return;
			}
			client = await lifecycle.getClient();
		} catch (e) {
			this.postEnvelopeError(panel, msg.requestId, msg.specHash,
				`Daemon unavailable: ${(e as Error).message}`, 'internal');
			return;
		}

		// H2 (megaudit, 2026-05-12): capability mismatch detection. If
		// the saved spec uses a transform kind the running daemon does
		// not advertise, fail with a clear "your daemon doesn't support
		// X" message BEFORE hitting the daemon — otherwise the user sees
		// a generic CompileError that hides the real cause (daemon age,
		// not their spec).
		if (ctx.capabilities !== null) {
			const advertised = new Set(ctx.capabilities.transformKinds);
			const unsupported = msg.spec.transforms
				.map((t, i) => ({ kind: t.kind, index: i }))
				.filter(e => !advertised.has(e.kind));
			if (unsupported.length > 0) {
				const detail = unsupported
					.map(e => `transforms[${e.index}].kind='${e.kind}'`)
					.join(', ');
				this.postEnvelopeError(
					panel, msg.requestId, msg.specHash,
					`Daemon does not support this spec: ${detail}. `
					+ `Daemon advertises [${ctx.capabilities.transformKinds.join(', ')}]. `
					+ 'Update your Quantlab Python daemon or remove the unsupported transform.',
					'compile',
				);
				return;
			}

			// Megaudit Theme E (E2, 2026-05-13): the inspector path
			// (handleRequestInspectorData) refuses requests that carry
			// inspectorFilters when the daemon doesn't advertise
			// aggregate_filters. Mirror the gate here so a malicious or
			// buggy webview can't bypass the check by sending the
			// filters through the aggregate path.
			if (msg.inspectorFilters && msg.inspectorFilters.length > 0
				&& ctx.capabilities.inspector
				&& !ctx.capabilities.inspector.aggregateFilters) {
				this.postEnvelopeError(
					panel, msg.requestId, msg.specHash,
					'Daemon does not advertise inspector aggregate_filters. '
					+ 'Reload after upgrading the daemon, or use a spec without inspector filters.',
					'compile',
				);
				return;
			}
		}

		try {
			// Phase 6 (6.D.3): forward the webview's inspectorFilters as a
			// `FilterTransform` prefix to the daemon's aggregate. Ephemeral
			// filters never make it into the saved spec -- they ride the
			// wire on this one call.
			const inspectorFilters = msg.inspectorFilters
				? inspectorFiltersToFilterTransforms(msg.inspectorFilters)
				: undefined;
			const r = await client.aggregate(msg.spec, { inspectorFilters });
			// Megaudit G5 (2026-05-13) -- opus audit: relay
			// compile-time precision-loss warnings from the daemon's
			// AggregateMeta to the webview's diagnostics readout. The
			// previous hardcoded `[]` made the warnings dead wire bytes
			// — present in the response, never visible to the user.
			// `diagnostics` is a flat `string[]` per the protocol; if
			// we ever need structured levels, that's a separate
			// wire-shape change.
			const warnings = r.meta.warnings ?? [];
			this.postOrLog(panel, {
				type: 'data',
				protocolVersion: PROTOCOL_VERSION,
				requestId: msg.requestId,
				specHash: msg.specHash,
				arrow: r.arrow,
				elapsedMs: r.elapsedMs,
				cached: r.cached,
				diagnostics: warnings,
			});
		} catch (e) {
			const error = (e as Error).message;
			// Megaudit MAJOR-34: daemon-side errors carry structured
			// `errorKind` in the response data so the webview can
			// distinguish security / timeout / memory from generic
			// compile failures. Falls back to legacy name-based mapping
			// for older daemon versions or non-DaemonOpError paths.
			const errorName = (e as Error).name;
			const structuredKind = (e as { errorKind?: string }).errorKind;
			// Megaudit-2 M1 / CODEX-2: 'internal' was missing from the
			// structuredKind branches, so daemon-internal errors fell
			// through to the legacy DaemonOpError → 'compile' fallback,
			// silently mis-categorizing real Python bugs as user-fixable
			// compile errors and defeating the MAJOR-34 fix.
			// Megaudit F3 (2026-05-13): `structuredKind === 'protocol'`
			// arm added so the new 'protocol' kind round-trips. The
			// DaemonOpError->compile name-fallback is dropped — strict
			// decoder at the wire means every DaemonOpError now carries
			// a real structured kind; a name-fallback would mask
			// decoder regressions.
			const kind: 'compile' | 'security' | 'timeout' | 'memory' | 'internal' | 'protocol' =
				structuredKind === 'security' ? 'security'
					: structuredKind === 'timeout' ? 'timeout'
						: structuredKind === 'memory' ? 'memory'
							: structuredKind === 'compile' ? 'compile'
								: structuredKind === 'internal' ? 'internal'
									: structuredKind === 'protocol' ? 'protocol'
										: errorName === 'DaemonProtocolError' ? 'protocol'
											: 'internal';
			this.postEnvelopeError(panel, msg.requestId, msg.specHash, error, kind);
		}
	}

	/**
	 * Phase 6 (6.D.3): inspector table window fetch. The webview
	 * dispatches `requestInspectorData` whenever the visible scroll
	 * window leaves the loaded data or filters change. We translate the
	 * webview's `InspectorFilter` objects into the daemon's
	 * `inspector_filters` list (which is just `FilterTransform[]`),
	 * call `client.preview(path, n, offset, {inspectorFilters})`, and
	 * post `inspectorData` (or `inspectorError`) back.
	 *
	 * The daemon's filtered preview returns a `total` field; the
	 * inspector's virtualized scrollbar needs that so its scrollbar
	 * length matches the post-filter dataset size.
	 */
	private async handleRequestInspectorData(
		document: QvizSpecDocument,
		panel: vscode.WebviewPanel,
		msg: import('../../qviz/messageProtocol').RequestInspectorDataMessage,
	): Promise<void> {
		const requestId = msg.requestId;
		// Audit M-54 (2026-05-11): inspector preview is gated by
		// schema-drift status, same as the chart aggregate. Without
		// this, a fields-missing drift state lets the inspector send
		// the daemon a query referencing dropped columns; the daemon
		// errors out cryptically and the inspector keeps retrying.
		const ctx = this.documentContexts.get(document);
		if (ctx
			&& ctx.driftStatus.kind === 'detected'
			&& ctx.driftStatus.result.drift === 'fields-missing') {
			this.postOrLog(panel, {
				type: 'inspectorError',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				error: `Cannot load inspector rows: spec references missing fields (${ctx.driftStatus.result.missingFields.join(', ')}).`,
				errorKind: 'internal',
			});
			return;
		}
		// Audit M-56 (2026-05-11): provider-side capability enforcement.
		// The webview's UI gate is bypassable by a malicious or buggy
		// webview; refuse here too.
		if (ctx && ctx.capabilities && ctx.capabilities.inspector) {
			const insCaps = ctx.capabilities.inspector;
			if (!insCaps.previewOffset || !insCaps.aggregateFilters) {
				this.postOrLog(panel, {
					type: 'inspectorError',
					protocolVersion: PROTOCOL_VERSION,
					requestId,
					error: 'Inspector data requires a daemon with preview_offset and aggregate_filters capabilities.',
					errorKind: 'internal',
				});
				return;
			}
		}
		const source = this.options.lifecycleSource;
		if (source === null) {
			this.postOrLog(panel, {
				type: 'inspectorError',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				error: 'No daemon available (no Python interpreter).',
				errorKind: 'internal',
			});
			return;
		}
		let client;
		try {
			const lifecycle = source.getLifecycleForDocument(document.uri);
			if (lifecycle === null) {
				this.postOrLog(panel, {
					type: 'inspectorError',
					protocolVersion: PROTOCOL_VERSION,
					requestId,
					error: "No daemon available for this document's workspace folder.",
					errorKind: 'internal',
				});
				return;
			}
			client = await lifecycle.getClient();
		} catch (e) {
			this.postOrLog(panel, {
				type: 'inspectorError',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				error: `Daemon unavailable: ${(e as Error).message}`,
				errorKind: 'internal',
			});
			return;
		}

		const datasetUri = document.spec.dataset.uri;
		const inspectorFilters = msg.inspectorFilters
			? inspectorFiltersToFilterTransforms(msg.inspectorFilters)
			: undefined;
		// Megaudit B-10 webview wireup (2026-05-11): when the spec has
		// aggregate / groupby transforms (e.g., pnl_by_strategy, factor_exposure
		// presets, or any user-built spec with an aggregation), the inspector's
		// raw preview shows pre-aggregate rows while the chart shows
		// post-aggregate bars -- confusing and breaks column-stats on derived
		// columns. Passing `applySpecTransforms` routes the preview through
		// `compile_spec` on the daemon side so the inspector matches the chart.
		const applySpecTransforms = specHasAggregateTransforms(document.spec)
			? document.spec
			: undefined;
		try {
			// `previewWithFilters` calls the same `client.preview` wrapper
			// added in Step 6.A.5 (TS daemon-client); when filters are
			// present they're appended to the request payload as
			// `inspector_filters`, matching the daemon's contract.
			const r = await previewWithFilters(
				client, datasetUri, msg.n, msg.offset, inspectorFilters, applySpecTransforms,
			);
			this.postOrLog(panel, {
				type: 'inspectorData',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				arrow: r.arrow,
				offset: msg.offset,
				n: r.n,
				...(r.total !== undefined ? { total: r.total } : {}),
				elapsedMs: r.elapsedMs,
			});
		} catch (e) {
			const errorName = (e as Error).name;
			const structuredKind = (e as { errorKind?: string }).errorKind;
			// Megaudit D3 audit (2026-05-13): `'compile'` reaches this
			// path when op_preview routes through `_preview_via_compile`
			// (apply_spec_transforms set). Previously this arm fell
			// through to `'internal'`, silently mis-classifying a
			// user-fixable spec error as a daemon bug.
			const kind: 'security' | 'timeout' | 'memory' | 'internal' | 'protocol' | 'compile' =
				structuredKind === 'security' ? 'security'
					: structuredKind === 'timeout' ? 'timeout'
						: structuredKind === 'memory' ? 'memory'
							: structuredKind === 'compile' ? 'compile'
								: structuredKind === 'internal' ? 'internal'
									: structuredKind === 'protocol' ? 'protocol'
										: errorName === 'DaemonProtocolError' ? 'protocol'
											: 'internal';
			this.postOrLog(panel, {
				type: 'inspectorError',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				error: (e as Error).message,
				errorKind: kind,
			});
		}
	}

	/**
	 * Phase 6 (6.D.2): column stats for a filter widget. Cached by the
	 * daemon on `(file fingerprint, column)`, so opening the same widget
	 * twice in a session is free.
	 */
	private async handleRequestColumnStats(
		document: QvizSpecDocument,
		panel: vscode.WebviewPanel,
		msg: import('../../qviz/messageProtocol').RequestColumnStatsMessage,
	): Promise<void> {
		const requestId = msg.requestId;
		const ctx = this.documentContexts.get(document);
		const postErr = (error: string): void => {
			this.postOrLog(panel, {
				type: 'columnStatsError',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				column: msg.column,
				error,
			});
		};
		// Audit M-54 + M-26 (2026-05-11): refuse stats when the dataset
		// is in fields-missing drift state; the requested column may
		// already be gone.
		if (ctx && ctx.driftStatus.kind === 'detected'
			&& ctx.driftStatus.result.drift === 'fields-missing') {
			postErr(`Column stats unavailable: spec references missing fields (${ctx.driftStatus.result.missingFields.join(', ')}).`);
			return;
		}
		// Audit M-56: capability check.
		if (ctx && ctx.capabilities && ctx.capabilities.inspector
			&& !ctx.capabilities.inspector.columnStats) {
			postErr('Column stats require a daemon that advertises column_stats capability.');
			return;
		}
		const source = this.options.lifecycleSource;
		if (source === null) {
			postErr('No daemon available (no Python interpreter).');
			return;
		}
		let client;
		try {
			const lifecycle = source.getLifecycleForDocument(document.uri);
			if (lifecycle === null) {
				postErr("No daemon available for this document's workspace folder.");
				return;
			}
			client = await lifecycle.getClient();
		} catch (e) {
			postErr(`Daemon unavailable: ${(e as Error).message}`);
			return;
		}
		const datasetUri = document.spec.dataset.uri;
		// Megaudit B-10 webview wireup: when the spec aggregates, column-stats
		// against a derived alias (`pnl_sum`, `exposure_mean`) would fail on
		// the raw parquet. Pass `applySpecTransforms` so the daemon compiles
		// the spec and queries the aggregate output.
		const applySpecTransforms = specHasAggregateTransforms(document.spec)
			? document.spec
			: undefined;
		try {
			const r = await client.columnStats(datasetUri, msg.column, {
				...(applySpecTransforms ? { applySpecTransforms } : {}),
			});
			const d = r.data;
			this.postOrLog(panel, {
				type: 'columnStats',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				column: msg.column,
				stats: {
					kind: d.kind,
					cardinality: d.cardinality,
					cardinalityIsExact: d.cardinality_is_exact,
					nullCount: d.null_count,
					total: d.total,
					...(d.min !== undefined ? { min: d.min } : {}),
					...(d.max !== undefined ? { max: d.max } : {}),
					...(d.distinct !== undefined ? { distinct: d.distinct } : {}),
				},
			});
		} catch (e) {
			postErr((e as Error).message);
		}
	}

	/**
	 * Phase 8 Step D: handle the `retryDaemon` webview message. The user
	 * clicked the "Retry connection" button on the daemon-status banner.
	 * Cancel the current backoff timer and start spawning immediately.
	 */
	private async handleRetryDaemon(
		document: QvizSpecDocument, _panel: vscode.WebviewPanel,
	): Promise<void> {
		const source = this.options.lifecycleSource;
		if (source === null) { return; }
		const lifecycle = source.getLifecycleForDocument(document.uri);
		if (lifecycle === null) { return; }
		try {
			// Skip backoff, force spawn. The lifecycle's status-change
			// subscription already broadcasts the transition through to
			// the webview, so the banner updates automatically.
			lifecycle.requestImmediateRetry();
		} catch {
			// requestImmediateRetry throws only when the lifecycle is
			// already disposed. In that case, the source will report no
			// lifecycle next time, and the banner already reflects
			// 'unavailable'. Nothing else to do.
		}
	}

	/**
	 * Phase 8 Step D: handle the `recheckDataset` webview message. The
	 * user clicked the "Re-check file" button on the dataset-status
	 * banner. Re-resolve the dataset path and broadcast a fresh
	 * datasetStatus message (which clears the banner when the file is
	 * now present, or refreshes the kind if the failure mode shifted).
	 */
	private async handleRecheckDataset(
		document: QvizSpecDocument, panel: vscode.WebviewPanel,
	): Promise<void> {
		const spec = document.spec;
		const workspaceRoot = workspaceRootForUri(document.uri);
		if (workspaceRoot === null) {
			// Megaudit Theme E (E12, 2026-05-13): the user clicked
			// "Re-check file" but the doc isn't inside any workspace
			// folder. Previously we returned silently — the banner
			// appeared frozen. Surface a structured status instead.
			this.postOrLog(panel, {
				type: 'datasetStatus',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(document.uri.toString()),
				status: 'no-workspace',
				datasetUri: spec.dataset.uri,
				error: 'No workspace folder owns this Visualise spec. '
					+ 'Open a folder in VS Code to enable file resolution.',
			});
			return;
		}
		const resolved = resolveDatasetPath(spec.dataset.uri, workspaceRoot);
		if (resolved.kind === 'ok') {
			// Dataset is now resolvable -- post an OK status to clear the
			// banner. The chart will re-query on the next requestData tick.
			this.postOrLog(panel, {
				type: 'datasetStatus',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(document.uri.toString()),
				status: 'ok',
				datasetUri: spec.dataset.uri,
			});
			return;
		}
		// Still failing -- broadcast the (possibly updated) failure kind
		// so the user sees the same/changed error.
		this.broadcastDatasetStatusToPanel(document, spec.dataset.uri, resolved);
	}

	/**
	 * Visualise v2: handle the `promoteToChart` webview message. Generate
	 * a minimal .py scaffold under .quantlab/visualise-promoted/ and
	 * open it in Quantlab's Chart view. The scaffold references the same
	 * dataset; the user adds indicators / wires live sessions in the
	 * Chart UI.
	 */
	private async handlePromoteToChart(document: QvizSpecDocument): Promise<void> {
		const workspaceRoot = workspaceRootForUri(document.uri);
		if (workspaceRoot === null) {
			void vscode.window.showWarningMessage(
				'Promote to Chart: no workspace folder is open. Open a folder first.',
			);
			return;
		}
		const result = generatePromoteScaffold(
			document.spec, document.uri.fsPath, workspaceRoot,
			{ readExistingFile: readExistingScaffold },
		);
		if (result.kind === 'error') {
			void vscode.window.showWarningMessage(`Promote to Chart: ${result.message}`);
			return;
		}
		// Write the scaffold. Ensure parent dir exists. Atomic-write via
		// tempfile + rename so a crash mid-write doesn't leave a partial
		// scaffold the Chart view would try to parse.
		const dir = path.dirname(result.scaffoldPath);
		try {
			await fs.promises.mkdir(dir, { recursive: true });
			const tmp = result.scaffoldPath + `.tmp.${process.pid}.${Date.now()}`;
			await fs.promises.writeFile(tmp, result.scaffoldBody, 'utf8');
			await fs.promises.rename(tmp, result.scaffoldPath);
		} catch (e) {
			void vscode.window.showWarningMessage(
				`Promote to Chart: failed to write scaffold: ${(e as Error).message}`,
			);
			return;
		}
		const scaffoldUri = vscode.Uri.file(result.scaffoldPath);
		try {
			await vscode.commands.executeCommand(
				'vscode.openWith', scaffoldUri, 'quantlab.chartView',
			);
		} catch (e) {
			// If the Chart view registration is missing or unavailable,
			// fall back to opening the .py file in the default editor so
			// the user still sees the scaffold + can copy/paste into
			// Chart manually.
			void vscode.window.showWarningMessage(
				`Promote to Chart: Chart view unavailable (${(e as Error).message}). `
				+ `Scaffold written to ${result.scaffoldPath}; open it manually.`,
			);
			await vscode.commands.executeCommand('vscode.open', scaffoldUri);
		}
	}

	/**
	 * Megaudit CRITICAL-2: errors that respond to a specific
	 * `requestData` MUST echo the inbound `requestId`. The webview's
	 * `queryState.errorReceived` reducer requires
	 * `requestId === inflight.requestId && specHash === inflight.specHash`
	 * to accept the error. Inventing a fresh id (the previous behavior)
	 * meant the reducer dropped the error as stale and the UI sat at
	 * "computing…" indefinitely after a daemon failure -- directly
	 * breaking Step I.1's "keep last successful chart visible" promise.
	 */
	private postEnvelopeError(
		panel: vscode.WebviewPanel,
		requestId: number,
		specHash: string,
		error: string,
		errorKind: 'compile' | 'security' | 'timeout' | 'memory' | 'internal' | 'protocol',
	): void {
		this.postOrLog(panel, {
			type: 'error',
			protocolVersion: PROTOCOL_VERSION,
			requestId,
			specHash,
			error,
			errorKind,
		});
	}

	private buildInitMessage(
		uri: vscode.Uri,
		spec: QvizSpec,
		schema: SchemaInfo | null,
		capabilities: DaemonCapabilities | null = null,
		savedSpec: QvizSpec = spec,
	): InitMessage {
		const requestId = this.nextRequestId(uri.toString());
		const msg: InitMessage = {
			type: 'init',
			protocolVersion: PROTOCOL_VERSION,
			requestId,
			specHash: computeSpecHash(spec),
			fsPath: uri.fsPath,
			spec,
			lastSavedHash: computeSpecHash(savedSpec),
			...(schema !== null ? { schema } : {}),
			...(capabilities !== null ? { capabilities } : {}),
		};
		return msg;
	}

	private buildSchemaChangedMessage(
		uri: vscode.Uri, drift: DriftResult, liveSchema: SchemaInfo,
	): SchemaChangedMessage {
		const requestId = this.nextRequestId(uri.toString());
		// Cross-field invariant required by the protocol validator:
		// missingFields is REQUIRED non-empty for fields-missing,
		// FORBIDDEN otherwise.
		if (drift.drift === 'fields-missing') {
			return {
				type: 'schemaChanged',
				protocolVersion: PROTOCOL_VERSION,
				requestId,
				oldHash: drift.oldHash,
				newHash: drift.newHash,
				drift: drift.drift,
				newSchema: liveSchema,
				missingFields: drift.missingFields,
			};
		}
		return {
			type: 'schemaChanged',
			protocolVersion: PROTOCOL_VERSION,
			requestId,
			oldHash: drift.oldHash,
			newHash: drift.newHash,
			drift: drift.drift,
			newSchema: liveSchema,
		};
	}

	/** Audit M-23 (2026-05-11): refetch capabilities from the (just-
	 *  respawned) daemon and post a fresh `capabilities` message to the
	 *  webview. Used on daemon ready-after-not-ready transitions so the
	 *  inspector capability gate stays accurate across respawns. The
	 *  webview's runtime slice picks up the new bag via
	 *  `capabilitiesUpdated` (which `sameCapabilities` now compares
	 *  including the inspector subfield, per the megaudit cure). */
	private async refetchAndBroadcastCapabilities(
		document: QvizSpecDocument, panel: vscode.WebviewPanel,
	): Promise<void> {
		const source = this.options.lifecycleSource;
		if (source === null) { return; }
		try {
			const lifecycle = source.getLifecycleForDocument(document.uri);
			if (lifecycle === null) { return; }
			const client = await lifecycle.getClient();
			const cap = await client.capabilities();
			const ctx = this.documentContexts.get(document);
			// Megaudit F1 (2026-05-13): see capabilitiesTransform.ts.
			const capabilities: DaemonCapabilities = mapDaemonCapsForInit(cap.data);
			// Cache on the document context so subsequent drift cycles
			// see the updated bag without an extra round-trip.
			if (ctx) { ctx.capabilities = capabilities; }
			this.postOrLog(panel, {
				type: 'capabilities',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(document.uri.toString()),
				capabilities,
			});
		} catch (e) {
			// Megaudit Theme E (E7, 2026-05-13): keeping the prior
			// capability bag re-creates the M-23 bug — the inspector
			// gate thinks features are available, the user clicks, and
			// the daemon errors cryptically. Broadcast a synthetic
			// "everything off" bag instead so the webview locks down
			// the gated features until a fresh successful refetch
			// updates them. Also clear ctx.capabilities so internal
			// gates (handleRequestData inspectorFilters, etc.) see the
			// empty state. Violates "no fallback" if we kept silent;
			// this is the loud surface.
			const errMsg = `capability refetch after respawn failed: ${(e as Error).message}`;
			console.warn(`VisualiseSpecProvider: ${errMsg}`);
			const ctx = this.documentContexts.get(document);
			const lockedDown: DaemonCapabilities = {
				// daemonVersion=1 (validator-safe) but every feature flag
				// is OFF so the webview can't dispatch anything that
				// would round-trip to the (now-unknown) daemon.
				daemonVersion: 1,
				transformKinds: [],
				chartFamilies: [],
				inspector: {
					previewOffset: false,
					columnStats: false,
					aggregateFilters: false,
				},
			};
			if (ctx) { ctx.capabilities = lockedDown; }
			this.postOrLog(panel, {
				type: 'capabilities',
				protocolVersion: PROTOCOL_VERSION,
				requestId: this.nextRequestId(document.uri.toString()),
				capabilities: lockedDown,
			});
		}
	}

	private buildDaemonStatusMessage(uri: vscode.Uri, s: LifecycleStatus): DaemonStatusMessage {
		const status: DaemonStatusKind = s.kind;
		const requestId = this.nextRequestId(uri.toString());
		const base = {
			type: 'daemonStatus' as const,
			protocolVersion: PROTOCOL_VERSION,
			requestId,
			status,
		};
		switch (s.kind) {
			case 'crashed':
				return { ...base, retryInMs: s.retryInMs, lastError: s.error };
			case 'respawning':
				// retryInMs is 0 (we just fired the timer). lastError
				// carries the underlying crash context so the UI doesn't
				// lose it across the crashed→respawning transition.
				return { ...base, retryInMs: 0, lastError: s.lastError };
			case 'disposing':
				// Megaudit E8 (2026-05-13): surface the reason in
				// lastError so the banner can show "Shutting down…"
				// with context. retryInMs intentionally absent — this
				// is a transient terminal state, not a respawn beat.
				return { ...base, lastError: s.reason };
			case 'unavailable':
				return { ...base, lastError: s.error };
			default:
				return base;
		}
	}

	private nextRequestId(key: string): number {
		const current = this.outboundRequestIdByUri.get(key) ?? 0;
		const next = current + 1;
		this.outboundRequestIdByUri.set(key, next);
		return next;
	}

	private postOrLog(panel: vscode.WebviewPanel, msg: ExtensionMessage): void {
		panel.webview.postMessage(msg).then(
			delivered => {
				if (!delivered) {
					// Megaudit Theme E (E3, 2026-05-13): the previous code
					// eagerly called releasePanelSlot(panel) on
					// delivered=false, BUT postMessage can return false
					// for transient delivery failures while the panel is
					// still alive (e.g. webview busy, window backgrounded).
					// Eager release orphans the live panel — every
					// subsequent outbound message becomes a silent no-op
					// because panelByUri.get(key) returns undefined.
					// onDidDispose is the SOLE authoritative release path.
					console.warn(
						`VisualiseSpecProvider: postMessage(${msg.type}) returned `
						+ 'delivered=false (panel may be hidden or transient '
						+ 'failure); waiting for onDidDispose for cleanup',
					);
				}
			},
			err => {
				// Same reasoning: rejection from postMessage doesn't
				// mean the panel is permanently gone. Log and wait for
				// onDidDispose.
				console.warn(
					`VisualiseSpecProvider: postMessage(${msg.type}) rejected:`, err,
				);
			},
		);
	}

	// Megaudit Theme E (E3, 2026-05-13): releasePanelSlot used to be
	// called from postOrLog's `delivered=false` / rejection paths.
	// That was incorrect — postMessage can transiently fail while the
	// panel is alive. Cleanup is now exclusively driven by
	// webviewPanel.onDidDispose. Function removed; per-URI cleanup
	// happens inline at the dispose hook (resolveCustomEditor:267) and
	// in onDocumentDispose (E10).

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = getWebviewUri(webview, this.context.extensionUri, [
			'dist', 'webview', 'qviz-spec.js',
		]);
		const styleUri = getWebviewUri(webview, this.context.extensionUri, [
			'dist', 'webview', 'qviz-spec-style.css',
		]);
		const codiconsUri = getWebviewUri(webview, this.context.extensionUri, [
			'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
		]);
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
	<link href="${codiconsUri}" rel="stylesheet">
	<link href="${styleUri}" rel="stylesheet">
	<title>Visualise Spec</title>
</head>
<body>
	<div id="qviz-spec-root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Resolve the workspace folder containing `uri`. Returns null if no
 *  workspace folder owns this URI; the caller is expected to surface
 *  this as a structured error (no implicit fallback to folders[0]). */
function workspaceRootForUri(uri: vscode.Uri): string | null {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (folder) { return folder.uri.fsPath; }
	return null;
}

/** Standard-library path.dirname/basename, inlined so the import block
 *  stays focused. Handles both POSIX and Windows separators. */
function vscodePath_dirname(p: string): string {
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	if (idx < 0) { return '.'; }
	if (idx === 0) { return p.substring(0, 1); }
	return p.substring(0, idx);
}

function vscodePath_basename(p: string): string {
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	if (idx < 0) { return p; }
	return p.substring(idx + 1);
}

/** Map persist's error-kind taxonomy to the protocol's narrower
 *  datasetStatus kinds. Some persist kinds don't have a 1:1 protocol
 *  match (system-error, not-file, empty-uri); they roll up into
 *  `missing` since the user-visible cause is "file unusable". */
function mapResolveErrorToDatasetStatus(
	kind: import('../../qviz/persist').ResolveDatasetError['kind'],
): import('../../qviz/messageProtocol').DatasetStatusKind {
	switch (kind) {
		case 'no-workspace': return 'no-workspace';
		case 'absolute-uri':
		case 'path-escape':
		case 'symlink-escape': return 'path-escape';
		case 'extension-not-allowed': return 'extension-not-allowed';
		case 'access-denied': return 'access-denied';
		case 'dangling-symlink': return 'dangling-symlink';
		case 'empty-uri':
		case 'missing':
		case 'not-file':
		case 'system-error':
			return 'missing';
	}
}

/** Adapter from the provider's `DriftStatus` (which carries a per-doc
 *  generation counter) to the pure save-decision module's narrower
 *  status type. Strips fields irrelevant to the decision. */
function driftStatusForSave(s: DriftStatus): import('../../qviz/saveDecision').DriftStatusForSave {
	switch (s.kind) {
		case 'idle': return { kind: 'idle' };
		case 'in-flight': return { kind: 'in-flight' };
		case 'detected': return {
			kind: 'detected', result: s.result, liveSchema: s.liveSchema,
		};
		case 'failed': return { kind: 'failed', error: s.error };
	}
}

// ---------------------------------------------------------------------------
// Phase 6 (6.D.3): inspector-filter translation
// ---------------------------------------------------------------------------

/** Translate the webview's `InspectorFilter` union into the daemon's
 *  `FilterTransform` list. The two shapes diverge:
 *
 *    - `range` → 1 or 2 FilterTransforms (`>=`, `<=`); empty bounds skip.
 *    - `text`  → 1 FilterTransform with `op: 'contains'`.
 *    - `set`   → 1 FilterTransform with `op: 'in'`; empty includes
 *                short-circuits to a filter that matches nothing.
 *
 *  Empty filters (e.g. `text.contains === ''`) are dropped so the daemon
 *  sees a clean payload and the cache key stays stable across no-op
 *  filter edits.
 */
/** Phase 6 (6.D.3): exported for direct unit testing. The function is
 *  pure (no vscode/IO) so the regression suite can pin every translation
 *  edge case without spinning up the full provider. */
export function inspectorFiltersToFilterTransforms(
	filters: readonly import('../../qviz/messageProtocol').InspectorFilter[],
): import('../../qviz/daemon-client').InspectorFilterDTO[] {
	const out: import('../../qviz/daemon-client').InspectorFilterDTO[] = [];
	for (const f of filters) {
		if (f.kind === 'range') {
			if (f.min !== null && f.min !== undefined) {
				out.push({ kind: 'filter', column: f.column, op: '>=', value: f.min });
			}
			if (f.max !== null && f.max !== undefined) {
				out.push({ kind: 'filter', column: f.column, op: '<=', value: f.max });
			}
		} else if (f.kind === 'text') {
			if (f.contains.length > 0) {
				out.push({ kind: 'filter', column: f.column, op: 'contains', value: f.contains });
			}
		} else if (f.kind === 'set') {
			// Empty `includes` semantically means "no rows match". We
			// emit `{op:'in', value:[]}` -- the daemon's compiler
			// short-circuits empty IN to a FALSE predicate (see
			// python/qviz/daemon.py:_compile_inspector_filters_to_sql).
			// Audit M-G (2026-05-11): a prior version emitted a `==
			// '__qviz_empty_set_sentinel__'` literal, which would
			// incorrectly match rows whose data contained that exact
			// string. The empty-`in` path keeps the semantics inside
			// the daemon where they belong.
			out.push({
				kind: 'filter', column: f.column, op: 'in',
				value: f.includes as unknown,
			});
		}
	}
	return out;
}

/** Detect whether the spec's pipeline should reach the inspector
 *  through `applySpecTransforms` (i.e., the inspector should show
 *  post-pipeline rows, not raw parquet).
 *
 *  This fires for two reasons:
 *
 *    1. The pipeline aggregates (`groupby` + `aggregate`). The raw rows
 *       no longer match the chart's row shape; the inspector MUST run
 *       through `compile_spec` to mirror the chart. (Megaudit B-10.)
 *
 *    2. The pipeline produces a new column (`expr`, `window`, `math`,
 *       `bin`, `date_trunc`, `tz_convert` with `as`, `resample` with
 *       `as_time`). The user expects to see / filter / inspect that
 *       column. The raw parquet doesn't have it. (Megaudit 2026-05-12
 *       H3: previously `specHasAggregateTransforms` returned false for
 *       these and the inspector lost the calculated column.)
 *
 *  Filter, sort, limit are pure row-set operations: they neither
 *  collapse the schema nor add columns. They still benefit from
 *  applySpecTransforms when combined with anything above, but in
 *  isolation they don't need it.
 *
 *  Exported for unit testing.
 */
export function specRequiresAppliedTransformsForInspector(spec: QvizSpec): boolean {
	const transforms = spec.transforms ?? [];
	for (const t of transforms) {
		switch (t.kind) {
			case 'aggregate':
			case 'groupby':
			case 'expr':
			case 'window':
			case 'math':
			case 'bin':
			case 'date_trunc':
				return true;
			case 'tz_convert':
				if (t.as !== undefined) { return true; }
				continue;
			case 'resample':
				return true;
			case 'filter':
			case 'sort':
			case 'limit':
				continue;
		}
	}
	return false;
}

/** @deprecated Use `specRequiresAppliedTransformsForInspector`. Kept as
 *  a name-stable alias so callers that grep for the B-10 name still
 *  find the intent. */
export const specHasAggregateTransforms = specRequiresAppliedTransformsForInspector;

/** Tiny shim around `client.preview` that lifts the response shape so
 *  the provider doesn't care whether the daemon returned the JSON or
 *  Arrow envelope. Inspector consumers always want Arrow + total.
 *
 *  `applySpecTransforms` (when set) makes the daemon route the preview
 *  through `compile_spec(spec)` so the inspector matches an aggregate
 *  chart's shape rather than showing raw pre-aggregate rows.
 */
async function previewWithFilters(
	client: import('../../qviz/daemon-lifecycle').LifecycleClient,
	path: string,
	n: number,
	offset: number,
	inspectorFilters: import('../../qviz/daemon-client').InspectorFilterDTO[] | undefined,
	applySpecTransforms?: QvizSpec,
): Promise<{ arrow: Uint8Array; n: number; total?: number; elapsedMs: number }> {
	const raw = await client.preview(path, n, offset, {
		inspectorFilters,
		...(applySpecTransforms ? { applySpecTransforms } : {}),
	});
	if ('arrow' in raw) {
		const data = raw.meta as { n?: number; total?: number };
		return {
			arrow: raw.arrow,
			n: data.n ?? 0,
			...(data.total !== undefined ? { total: data.total } : {}),
			elapsedMs: raw.elapsedMs,
		};
	}
	// Audit M-35 (2026-05-11): small filtered (or unfiltered) preview
	// windows can legitimately come back as inline JSON when the
	// payload is under the daemon's JSON-vs-Arrow threshold. The prior
	// version threw, breaking the inspector for small datasets. We
	// convert the JSON rows to an Arrow IPC frame here so the webview's
	// `extractColumnsFromArrowIpc` path stays uniform.
	const data = (raw as unknown as { data: { rows: readonly Record<string, unknown>[]; n: number; total?: number } }).data;
	const arrow = await jsonRowsToArrowIpc(data.rows);
	return {
		arrow,
		n: data.n,
		...(data.total !== undefined ? { total: data.total } : {}),
		elapsedMs: raw.elapsedMs,
	};
}

/** Audit M-35 (2026-05-11): build an Arrow IPC stream from an array of
 *  row records. Used only on the inline-JSON preview fallback path. The
 *  resulting bytes match the daemon's Arrow encoding so downstream
 *  consumers (the webview's extractor) handle both paths identically. */
async function jsonRowsToArrowIpc(rows: readonly Record<string, unknown>[]): Promise<Uint8Array> {
	const arrow = await import('apache-arrow');
	if (rows.length === 0) {
		// Build an empty record batch with no columns; downstream will
		// render the placeholder.
		const empty = arrow.tableFromArrays({});
		return arrow.tableToIPC(empty, 'stream');
	}
	// Collect the union of column names across rows (rows from the
	// daemon's preview path are uniform, but we don't assume).
	const colNames: string[] = [];
	const colSeen = new Set<string>();
	for (const row of rows) {
		for (const k of Object.keys(row)) {
			if (!colSeen.has(k)) {
				colSeen.add(k);
				colNames.push(k);
			}
		}
	}
	const columns: Record<string, unknown[]> = {};
	for (const name of colNames) {
		const out: unknown[] = new Array(rows.length);
		for (let i = 0; i < rows.length; i++) {
			out[i] = rows[i][name] ?? null;
		}
		columns[name] = out;
	}
	// tableFromArrays expects per-column arrays in a structurally
	// compatible shape; row values are heterogeneous so we cast through
	// unknown to bypass the strict signature.
	const table = arrow.tableFromArrays(columns as unknown as Parameters<typeof arrow.tableFromArrays>[0]);
	return arrow.tableToIPC(table, 'stream');
}
