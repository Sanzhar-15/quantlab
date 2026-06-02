/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cell-grid webview panel.
 *
 * Render-then-edit panel that displays a sheet from the owning single-writer
 * `Session` and commits edits back to it. The user clicks a cell, types a
 * number / text / `=formula`, and commits via Enter; the host parses +
 * validates + writes via `Session.setValue`/`setFormula`, runs an incremental
 * recalc, and re-renders. Failures post a structured `errorReply` back to the
 * webview which decorates the offending cell.
 *
 * **FE-0a Part B / B1 (2026-06-02) -- migrated off `CollabSession`.** This panel
 * previously bound the collaborative `CollabSession` (op-log append + transport
 * sync + peer presence + a pollRemote loop + a mid-edit-render watchdog). The
 * product is single-writer/local-first for v1; real-time collab is v1.5-deferred
 * ("CRDT built, transport unwired"). So the transport/presence/pollRemote glue
 * was removed here and the panel now binds the owning `Session`
 * (`createWorkbookSession`), which also exposes the ENG-FUSION fusion primitives
 * (publishDataset/bindRange/recalcDirty) FE-1.5 builds on. The reusable collab
 * primitives (`CollabSession`/`Transport`/`LoopbackPair`, the `session.ts`
 * collab helpers, `classifyPollTick`, `multiWindowDemo`) remain in the codebase,
 * dormant, for the v1.5 re-enable; the `quantbookCellGridCollab` command is
 * disabled for v1.
 *
 * The vscode-free pure helpers live in companion files so unit tests can
 * exercise them without a vscode shim:
 * - {@link buildHtml} / `formatCellValue` in `cellGridHtml.ts`.
 * - {@link dispatchIncomingMessage} / {@link classifyCellInput} / envelope types
 *   in `cellGridLogic.ts`.
 */

import * as vscode from 'vscode';

import type { QuantbookCellSnapshot, SessionInstance, WorkbookSnapshotJson } from '../types';
import { buildHtml } from './cellGridHtml';
import { acquireWorkbookSnapshotViaDelta, dispatchIncomingMessage, extractSheetSnapshot, getSharedDeltaCache } from './cellGridLogic';

const VIEW_TYPE = 'quantlab.quantbookCellGrid';

/**
 * Module-level registry of live panels keyed by sheet number. Lets the
 * `quantlab.quantbookCellGridRefresh` command find the active panel(s) without
 * the user having to remember which window spawned them. Removed on dispose.
 *
 * **B1**: a single map (was a local/collab dual map before the collab path was
 * disabled) -- one panel per sheet, single-tab-per-sheet (reveal + refresh an
 * existing panel rather than spawn a duplicate).
 */
const panels: Map<number, CellGridPanel> = new Map();

/**
 * Render-then-edit webview panel for the given session's sheet. The panel binds
 * the session for its lifetime -- the dispatcher commits via this session,
 * `render()` reads via this session.
 */
export class CellGridPanel {
	static show(
		context: vscode.ExtensionContext,
		session: SessionInstance,
		sheet: number,
	): CellGridPanel {
		// Single-tab-per-sheet: reveal + refresh an existing panel for this sheet
		// rather than spawning a duplicate.
		const existing = panels.get(sheet);
		if (existing !== undefined) {
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			existing.render();
			return existing;
		}
		// Initial title; render() (below) immediately corrects the count via
		// `snapshot.sheets.length`. listSheets() is ONE napi roundtrip per show()
		// (bounded by user action). Per CLAUDE.md No-Fallbacks, a failure here
		// propagates -- the command caller surfaces it via showErrorMessage rather
		// than showing a healthy-looking title on a broken session.
		const totalSheets = session.listSheets().length;
		const titleSuffix = totalSheets > 1 ? ` of ${totalSheets}` : '';
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			`Cell Grid (Sheet ${sheet}${titleSuffix})`,
			vscode.ViewColumn.Active,
			{
				// Scripts ON for the click-to-edit flow. CSP + nonce enforce that
				// only the host-emitted inline script can execute; no remote
				// `<script src=>` and no localResourceRoots widen beyond the
				// extension root.
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [context.extensionUri],
			},
		);
		const instance = new CellGridPanel(panel, session, sheet);
		// Attach the message handler BEFORE the first render(). It survives across
		// `webview.html = ...` rebuilds because it's attached to the PANEL, not
		// the document.
		panel.webview.onDidReceiveMessage(
			(raw: unknown) => instance.handleIncoming(raw),
			undefined,
			context.subscriptions,
		);
		instance.render();
		panels.set(sheet, instance);
		panel.onDidDispose(() => {
			// Set _disposed BEFORE anything else so a postMessage racing with
			// disposal early-returns from the onError guard.
			instance._disposed = true;
			// Only clear the cache entry if we still own it (a fresh open for the
			// same sheet may have replaced us).
			if (panels.get(sheet) === instance) {
				panels.delete(sheet);
			}
		});
		context.subscriptions.push(panel);
		return instance;
	}

	/**
	 * Refresh ALL currently-open cell-grid panels. Called by
	 * `quantlab.quantbookCellGridRefresh` + the B2 sheet-management commands.
	 * Returns `{ refreshed, failed }` so callers can surface a render failure LOUD
	 * (No-Fallbacks): a panel whose `render()` throws is NOT counted as refreshed
	 * (it does not silently masquerade as success). `safeRender` still isolates the
	 * failure so one bad panel does not abort the refresh of its siblings.
	 */
	static refreshAll(): { refreshed: number; failed: number } {
		let refreshed = 0;
		let failed = 0;
		for (const instance of panels.values()) {
			if (instance.safeRender()) {
				refreshed += 1;
			} else {
				failed += 1;
			}
		}
		return { refreshed, failed };
	}

	/**
	 * Dispose ALL live cell-grid panels. Used by the Open command (FE-0a Part B2):
	 * opening a `.qbook` REPLACES the current workbook, so any panel still bound to
	 * the previous session must be torn down BEFORE the new session is shown.
	 * Otherwise {@link show} -- which reveals an existing panel keyed by the same
	 * sheet id before binding the new session -- would surface the stale panel and
	 * leave the newly-opened workbook inaccessible (reviewer HIGH). Calling
	 * `panel.dispose()` fires `onDidDispose`, which clears the registry entry; we
	 * snapshot `panels.values()` first so the dispose-time mutation is safe.
	 * Returns the number of panels disposed.
	 */
	static disposeAll(): number {
		const live = Array.from(panels.values());
		for (const instance of live) {
			instance.panel.dispose();
		}
		return live.length;
	}

	/**
	 * Render wrapper that never throws into the caller (refreshAll iterates many
	 * panels). Returns `true` on success, `false` if `render()` threw -- the caller
	 * (refreshAll) aggregates the failure count so the command layer can surface it
	 * LOUD (No-Fallbacks); `console.warn` keeps the per-panel detail. A failure does
	 * not abort the refresh of sibling panels. A disposed panel is a no-op success.
	 */
	private safeRender(): boolean {
		if (this._disposed) {
			return true;
		}
		try {
			this.render();
			return true;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.warn(`[quantbook] cell-grid safeRender failed: ${detail}`);
			return false;
		}
	}

	/**
	 * Enumerate active panels for the switch-sheet / save commands. The returned
	 * `session` references are live; callers must NOT cache the array across event
	 * loop ticks (panels can dispose at any time).
	 */
	static activeLocalPanels(): Array<{ session: SessionInstance; sheet: number }> {
		const result: Array<{ session: SessionInstance; sheet: number }> = [];
		for (const instance of panels.values()) {
			result.push({ session: instance.session, sheet: instance.sheet });
		}
		return result;
	}

	/**
	 * Tracks whether `panel.dispose()` has fired. `webview.postMessage` to a
	 * disposed panel is silently dropped; the errorReply path checks this flag and
	 * falls back to `showWarningMessage` so a late validation error stays visible.
	 * Public-readonly so the dispose handler + tests can set/inspect it.
	 */
	_disposed: boolean = false;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly session: SessionInstance,
		private readonly sheet: number,
	) { }

	/**
	 * Acquire the workbook snapshot via the incremental delta protocol
	 * (OPUS-PT-B10), seeding once via a full `snapshot()` then merging
	 * `snapshotDelta()` results. The cache is shared per session (mutated in
	 * place) so multiple panels on one session ride the delta fast path.
	 * `fullRebuildRequired` is an explicit designed protocol signal handled in
	 * {@link acquireWorkbookSnapshotViaDelta}, not a swallowed error.
	 */
	private acquireWorkbookSnapshot(): WorkbookSnapshotJson {
		return acquireWorkbookSnapshotViaDelta(this.session, getSharedDeltaCache(this.session));
	}

	/**
	 * Compute the snapshot, generate a fresh nonce, and set the webview HTML.
	 * Re-rendering blows away the prior webview script; the host's
	 * `onDidReceiveMessage` handler survives (attached to the panel, not the
	 * document). The title is reactive (sheet count + name from the snapshot).
	 *
	 * **Tombstone race**: if the active sheet was deleted while the panel is open,
	 * `extractSheetSnapshot` returns null; we render an empty grid + log a warning
	 * (visible per No-Fallbacks) rather than throwing on every render forever.
	 */
	render(): void {
		const wbSnapshot = this.acquireWorkbookSnapshot();
		const sheetSnapshot: QuantbookCellSnapshot | null = extractSheetSnapshot(wbSnapshot, this.sheet);
		const snapshot: QuantbookCellSnapshot = sheetSnapshot ?? {
			snapshot_format_version: 1,
			sheet: this.sheet,
			entries: [],
		};
		if (sheetSnapshot === null) {
			console.warn(
				`[cellGrid] active sheet ${this.sheet} not found in snapshot ` +
				`(likely deleted via quantbookSheetDelete). Rendering empty cell grid; close the panel.`,
			);
		}
		const totalSheets = wbSnapshot.sheets.length;
		const titleSuffix = totalSheets > 1 ? ` of ${totalSheets}` : '';
		const sheetName = sheetSnapshot !== null
			? wbSnapshot.sheets.find(s => s.id === this.sheet)?.name
			: undefined;
		const sheetLabel = sheetName !== undefined
			? `Sheet ${this.sheet} "${sheetName}"`
			: `Sheet ${this.sheet}`;
		this.panel.title = `Cell Grid (${sheetLabel}${titleSuffix})`;
		const nonce = buildPanelNonce();
		this.panel.webview.html = buildHtml(snapshot, { nonce });
	}

	/**
	 * Thin wrapper around the vscode-free {@link dispatchIncomingMessage}. Lives
	 * here (not in cellGridLogic.ts) because it captures `this`. The dispatcher
	 * handles `putValue` (number/text/formula -> write -> recalc -> render),
	 * `undo`/`redo`, and silently drops the dormant collab `presenceUpdate`/
	 * `typing_stroke` envelopes.
	 */
	private handleIncoming(raw: unknown): void {
		dispatchIncomingMessage(raw, {
			session: this.session,
			sheet: this.sheet,
			onCommit: () => this.render(),
			onError: reply => {
				// If the panel is disposed (or hidden with
				// retainContextWhenHidden:false), `webview.postMessage` is silently
				// dropped -- fall back to showWarningMessage so the user sees the
				// error.
				if (this._disposed) {
					void vscode.window.showWarningMessage(
						`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
					);
					return;
				}
				void this.panel.webview.postMessage(reply);
			},
		});
	}
}

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const NONCE_LENGTH = 32;

/**
 * 32-char alphanumeric nonce for the webview CSP + inline `<script nonce=...>`.
 * `Math.random()` is adequate: the threat model is "prevent inline script
 * injection via snapshot data leaking past escapeHtml", not crypto-grade brute
 * force. 62^32 ~= 10^57 possibilities.
 */
function buildPanelNonce(): string {
	let out = '';
	for (let i = 0; i < NONCE_LENGTH; i += 1) {
		out += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)];
	}
	return out;
}
