/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Wave H2 (R10 part 2/2, 2026-06-19) -- `CustomEditorProvider` for `*.qbook`.**
 *
 * Registering this provider makes a double-clicked `.qbook` in the Explorer open the live
 * spreadsheet grid as a real editor with a dirty tab, Ctrl+S, Save As, revert, and hot-exit
 * (backup) -- the lifecycle the command-driven {@link CellGridPanel} cannot offer. It mirrors
 * `VisualiseSpecProvider` but is much thinner: the workbook model lives in the engine
 * `Session` (owned by {@link QbookDocument}), not in the host.
 *
 * Each open `.qbook` is one {@link QbookDocument} (owning one napi `Session`) bound to one
 * adopted `CellGridPanel`. The grid panel registries are keyed by session identity, so two
 * open `.qbook` tabs are fully independent (multi-document safe).
 *
 * Dirty tracking uses a `CustomDocumentContentChangeEvent` (dirty-only) -- NOT a
 * `CustomDocumentEditEvent` -- because the engine owns Ctrl+Z/Y; see {@link QbookDocument}.
 *
 * The engine + panel interactions are injected as {@link QbookEditorProviderDeps} (mirroring the
 * document's own deps) so the lifecycle -- including the revert sequence -- is unit-testable
 * without a live engine or a real webview host.
 */

import * as vscode from 'vscode';

import { getSharedDeltaCache } from './cellGridLogic';
import { CellGridPanel } from './cellGridPanel';
import { QbookDocument, type ContentSignature, type QbookDocumentDeps } from './qbookDocument';
import { openWorkbookFromQbook, saveSessionToQbook } from '../session';
import type { SessionInstance } from '../types';

/**
 * The engine + grid-panel operations the provider performs, injected for testability. The
 * defaults ({@link realProviderDeps}) wire the real engine helpers + `CellGridPanel` statics;
 * tests pass stubs to assert the lifecycle (e.g. the revert ordering) without a live engine or
 * webview host.
 */
export interface QbookEditorProviderDeps {
	openWorkbook(path: string): SessionInstance;
	saveSession(session: SessionInstance, path: string): void;
	readSignature(session: SessionInstance): ContentSignature;
	closeSession(session: SessionInstance): void;
	/** Adopt a VS Code-provided panel as a grid bound to `session` (the document owns the
	 *  session, so `ownsSession:false`). */
	adoptPanel(
		context: vscode.ExtensionContext,
		panel: vscode.WebviewPanel,
		session: SessionInstance,
		sheet: number,
		opts: { ownsSession: boolean; onMutate?: () => void; onRenderError?: () => void },
	): void;
	/** Detach the live panel bound to `session` (close the old session) WITHOUT disposing the
	 *  shared WebviewPanel -- used by revert to reuse the same panel. */
	detachForRevert(session: SessionInstance): void;
}

/** The production deps: the real engine helpers + `CellGridPanel` statics. */
export function realProviderDeps(): QbookEditorProviderDeps {
	return {
		openWorkbook: openWorkbookFromQbook,
		saveSession: saveSessionToQbook,
		readSignature: (session) => ({
			version: getSharedDeltaCache(session).version,
			// setName/deleteName are token-invisible (do NOT advance the version token; see types.ts),
			// so include a stable key over the defined names as a SEPARATE dirty axis. The engine
			// returns listNames() in a stable sorted order, so JSON.stringify is a stable key.
			namesKey: JSON.stringify(session.listNames()),
		}),
		closeSession: (session) => CellGridPanel.closeOwnedSession(session),
		adoptPanel: (context, panel, session, sheet, opts) => {
			CellGridPanel.adopt(context, panel, session, sheet, opts);
		},
		detachForRevert: (session) => CellGridPanel.detachForRevert(session),
	};
}

/** Per-document host-side tracking: the adopted webview panel (set in `resolveCustomEditor`)
 *  and the document-scoped subscriptions (the content-change relay). */
interface DocumentEntry {
	panel: vscode.WebviewPanel | undefined;
	subs: vscode.Disposable[];
}

/** The adopt options that wire a panel's dirty pulses to `document`: the precise per-render
 *  recompute, and the failsafe when a render's snapshot acquire throws (conservative mark-dirty).
 *  Shared by `resolveCustomEditor` and `revertCustomDocument`. */
function adoptOptsFor(document: QbookDocument): { ownsSession: boolean; onMutate: () => void; onRenderError: () => void } {
	return {
		ownsSession: false,
		onMutate: () => document.recomputeDirty(),
		onRenderError: () => document.markDirtyConservatively(),
	};
}

export class QbookEditorProvider implements vscode.CustomEditorProvider<QbookDocument> {
	public static readonly viewType = 'quantlab.quantbookCellGridEditor';

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new QbookEditorProvider(context, realProviderDeps());
		return vscode.window.registerCustomEditorProvider(
			QbookEditorProvider.viewType,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	private readonly _onDidChangeCustomDocument =
		new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<QbookDocument>>();
	readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	private readonly byDocument = new Map<QbookDocument, DocumentEntry>();
	private readonly documentDeps: QbookDocumentDeps;

	/** Public so unit tests can construct a provider with stub deps. Production goes through
	 *  {@link register}, which supplies {@link realProviderDeps}. */
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly deps: QbookEditorProviderDeps,
	) {
		this.documentDeps = {
			openWorkbook: deps.openWorkbook,
			readSignature: deps.readSignature,
			closeSession: deps.closeSession,
		};
	}

	// -----------------------------------------------------------------------
	// CustomEditorProvider lifecycle
	// -----------------------------------------------------------------------

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken,
	): Promise<QbookDocument> {
		// Opens the owning session from disk (or the backup path for hot-exit). A bad/missing
		// file throws here and propagates so VS Code surfaces "failed to open" (No-Fallbacks).
		const document = QbookDocument.create(uri, openContext, this.documentDeps);
		const entry: DocumentEntry = { panel: undefined, subs: [] };
		this.byDocument.set(document, entry);
		entry.subs.push(
			document.onDidChangeContent(() => this._onDidChangeCustomDocument.fire({ document })),
		);
		// onDidDispose is intentionally NOT pushed to entry.subs (it cleans up entry.subs and
		// would dispose the subscription currently firing). Tracked fire-and-forget.
		document.onDidDispose(() => this.onDocumentDispose(document));
		return document;
	}

	async resolveCustomEditor(
		document: QbookDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const entry = this.byDocument.get(document);
		if (entry === undefined) {
			throw new Error('[invalid_state] resolveCustomEditor called for an unknown QbookDocument');
		}
		entry.panel = webviewPanel;
		// Adopt the VS Code-provided panel as a grid bound to this document's session. ownsSession
		// is false -- the document closes the session in its own dispose. The onMutate pulse drives
		// dirty tracking off the per-render content signature; onRenderError is the failsafe when a
		// render's snapshot acquire throws.
		this.deps.adoptPanel(this.context, webviewPanel, document.session, document.firstSheet, adoptOptsFor(document));
		// adopt's first render (synchronous) seeded the delta cache -> establish the clean baseline
		// so a freshly-opened file is NOT marked dirty. ensureInitialBaseline (NOT markSavedNow) is
		// a no-op on a webview recreate (tab moved to another group), so a pending dirty state is
		// preserved across the re-resolve rather than silently cleared.
		document.ensureInitialBaseline();
	}

	// -----------------------------------------------------------------------
	// Save / Save As / revert / backup
	// -----------------------------------------------------------------------

	async saveCustomDocument(
		document: QbookDocument,
		_token: vscode.CancellationToken,
	): Promise<void> {
		// Engine save is atomic (temp + rename), so a throw means disk is untouched -> let it
		// propagate so VS Code keeps the tab dirty and surfaces the error (No-Fallbacks).
		// markSavedNow (clean baseline) only runs on success.
		this.deps.saveSession(document.session, document.uri.fsPath);
		document.markSavedNow();
	}

	async saveCustomDocumentAs(
		document: QbookDocument,
		target: vscode.Uri,
		_token: vscode.CancellationToken,
	): Promise<void> {
		// Write the current workbook to `target`. Intentionally does NOT reset the source document's
		// baseline: VS Code does not switch the editor to `target`, and for a content-change custom
		// editor the workbench does not clear the source's dirty flag on Save As (it only updates the
		// edit-stack save point -- see mainThreadCustomEditors `saveCustomEditorAs`). The source
		// file's own edits genuinely remain unsaved, so the source tab staying dirty is CORRECT
		// (Ctrl+S persists the source; this Save As wrote a copy elsewhere).
		this.deps.saveSession(document.session, target.fsPath);
	}

	async revertCustomDocument(
		document: QbookDocument,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const entry = this.byDocument.get(document);
		const panel = entry?.panel;
		if (panel === undefined) {
			throw new Error('[invalid_state] revert: no live panel for this .qbook document');
		}
		const oldSession = document.session;
		// Open a fresh session from disk. On failure (deleted/corrupt), the old session+panel+document
		// are untouched -- but the workbench has ALREADY cleared the tab's dirty state (synchronously,
		// fire-and-forget, ignoring this throw -- see mainThreadCustomEditors `revert`), so re-assert
		// dirty before surfacing the error or the unsaved edits in the still-live old session would be
		// silently dropped on close.
		let fresh: SessionInstance;
		try {
			fresh = this.deps.openWorkbook(document.uri.fsPath);
		} catch (err) {
			document.reassertDirty();
			throw err;
		}
		// `fresh` is open. Every failure from here keeps `document.session` on the OPEN old session
		// (the swap happens only on success), so the catch must: (1) re-assert dirty FIRST -- so a
		// cleanup throw can never skip the critical re-mark after the workbench cleared dirty; (2) close
		// the orphan fresh session (throw-safe); and (3) if the old panel was already detached, re-bind
		// the still-open old session onto the panel so the grid is not left blank.
		let detached = false;
		try {
			const sheets = fresh.listSheets();
			if (sheets.length === 0) {
				throw new Error(`[persistence] revert: "${document.uri.fsPath}" has no live sheets.`);
			}
			const firstSheet = sheets[0].id;
			// Detach the old panel instance (does NOT close the old session) so the fresh session can
			// re-mount on the SAME panel. adopt re-assigns webview.html -> fresh `webviewReady` (gap #5).
			// Keeping the old session OPEN means a debounced backup mid-revert hits a LIVE session
			// (gap #7) and an adopt failure leaves the unsaved data intact.
			this.deps.detachForRevert(oldSession);
			detached = true;
			this.deps.adoptPanel(this.context, panel, fresh, firstSheet, adoptOptsFor(document));
		} catch (err) {
			document.reassertDirty();
			this.closeQuietly(fresh, 'revert: orphan fresh session');
			if (detached) {
				this.readoptQuietly(panel, oldSession, document);
			}
			throw err;
		}
		// Fresh bound successfully -> COMMIT the revert: switch the document to the fresh session, close
		// the old session (its data was intentionally discarded), and re-baseline clean on fresh. The
		// old-session close is throw-safe so a cleanup hiccup cannot fail the (already-succeeded) revert
		// or skip the final clean baseline.
		document.swapSession(fresh);
		this.closeQuietly(oldSession, 'revert: old session after a successful re-adopt');
		document.markSavedNow();
	}

	/** Close a session, logging (not throwing) any cleanup error so it can neither mask the primary
	 *  error in a failure path nor fail a revert that has already succeeded (No-Fallbacks: the error
	 *  is surfaced loud via console.error, not swallowed). */
	private closeQuietly(session: SessionInstance, label: string): void {
		try {
			this.deps.closeSession(session);
		} catch (err) {
			console.error(`[qbook] ${label}: closeSession failed:`, err);
		}
	}

	/** Best-effort recovery re-adopt: re-bind `session` onto `panel`, logging (not throwing) a failure
	 *  -- the unsaved data is safe in the (still-open) session regardless, and a VS Code re-resolve
	 *  recovers the view. Used when a revert's fresh re-adopt fails after the old panel was detached. */
	private readoptQuietly(panel: vscode.WebviewPanel, session: SessionInstance, document: QbookDocument): void {
		try {
			// Recover onto the old session's CURRENT first LIVE sheet -- NOT document.firstSheet, which
			// may have been deleted since open (a tombstoned sheet would re-trigger the blank-grid path).
			const sheets = session.listSheets();
			if (sheets.length === 0) {
				throw new Error('the old session has no live sheets to recover onto');
			}
			this.deps.adoptPanel(this.context, panel, session, sheets[0].id, adoptOptsFor(document));
		} catch (err) {
			console.error('[qbook] revert: re-binding the old session after a failed re-adopt also failed:', err);
		}
	}

	async backupCustomDocument(
		document: QbookDocument,
		context: vscode.CustomDocumentBackupContext,
		_token: vscode.CancellationToken,
	): Promise<vscode.CustomDocumentBackup> {
		// VS Code's backup destination parent directory may not exist yet (e.g. the first hot-exit
		// in a fresh workspace). The engine's atomic save renames a temp file INTO the parent dir,
		// so ensure the parent exists first (createDirectory is idempotent) -- otherwise the save
		// ENOENTs and hot-exit is silently unavailable.
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(context.destination, '..'));
		// Save the live workbook to the backup destination (any path; the engine writes a single-
		// file container discriminated by its sentinel, not the extension -> the hashed backup file
		// round-trips through open). Backup does NOT touch the saved baseline (the doc stays dirty).
		this.deps.saveSession(document.session, context.destination.fsPath);
		return {
			id: context.destination.toString(),
			delete: (): void => {
				// No-Fallbacks: log a delete failure rather than swallow it.
				vscode.workspace.fs.delete(context.destination).then(undefined, (err) => {
					console.warn(
						`[qbook] backup delete failed for ${context.destination.toString()}:`,
						err,
					);
				});
			},
		};
	}

	private onDocumentDispose(document: QbookDocument): void {
		const entry = this.byDocument.get(document);
		if (entry !== undefined) {
			for (const s of entry.subs) {
				s.dispose();
			}
			this.byDocument.delete(document);
		}
	}
}
