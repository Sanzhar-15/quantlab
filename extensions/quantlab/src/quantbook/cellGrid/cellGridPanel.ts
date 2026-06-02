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
 * - {@link dispatchIncomingMessage} / {@link classifyCellInput} / envelope types
 *   in `cellGridLogic.ts`.
 *
 * **FE-0b (2026-06-02)**: the webview is now a PERSISTENT bundled (esbuild)
 * module at `dist/webview/quantbook/sheets-webview.js` (source:
 * `webview/sheets-webview/`), loaded ONCE via a thin shell ({@link buildShellHtml}).
 * The host pushes the sheet snapshot to it via `postMessage({type:'render', ...})`
 * after each commit instead of rebuilding `webview.html`. The old host-built
 * inline HTML in `cellGridHtml.ts` (`buildHtml`) is no longer called by the panel
 * (retired in FE-0b-2 when the DOM table is replaced by the Canvas2D renderer).
 */

import * as vscode from 'vscode';

import type { QuantbookCellSnapshot, SessionInstance, WorkbookSnapshotJson } from '../types';
import { acquireWorkbookSnapshotViaDelta, dispatchIncomingMessage, extractSheetSnapshot, getSharedDeltaCache } from './cellGridLogic';
import { getNonce, getWebviewUri } from '../../utils/webview';

const VIEW_TYPE = 'quantlab.quantbookCellGrid';

/**
 * How long to wait for the bundled webview's `webviewReady` handshake before
 * surfacing a loud initialization error. The bundle is a local file (load +
 * script-exec is sub-second), so a generous 6s avoids false positives on a slow
 * machine while still failing VISIBLY if the bundle is missing/broken (a blank
 * grid with no error would violate No-Fallbacks).
 */
const READY_WATCHDOG_MS = 6000;

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
				// only the bundled `<script src=>` carrying the matching nonce can
				// execute. FE-0b: the webview is a PERSISTENT bundled module loaded
				// once from `dist/webview/quantbook` -- so `retainContextWhenHidden`
				// keeps its DOM + scroll state across tab switches (no reload flash;
				// this is the point of the persistent model) and `localResourceRoots`
				// is narrowed to the bundle directory.
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'quantbook')],
			},
		);
		const instance = new CellGridPanel(panel, session, sheet);
		// Attach the message handler BEFORE mounting the shell so the webview's
		// `webviewReady` handshake (posted on bundle load) is never missed. It
		// survives for the panel's lifetime (attached to the PANEL, not the doc).
		panel.webview.onDidReceiveMessage(
			(raw: unknown) => instance.handleIncoming(raw),
			undefined,
			context.subscriptions,
		);
		// Mount the persistent bundle shell ONCE. Snapshots are pushed via
		// postMessage in render() (gated on the webviewReady handshake), NOT by
		// rebuilding webview.html.
		panel.webview.html = buildShellHtml(panel.webview, context.extensionUri);
		instance.render();
		// Watch for the webviewReady handshake; surface a loud error if the bundle
		// never loads (else render() silently withholds every paint -> blank grid).
		instance.armReadyWatchdog();
		panels.set(sheet, instance);
		panel.onDidDispose(() => {
			// Set _disposed BEFORE anything else so a postMessage racing with
			// disposal early-returns from the onError guard.
			instance._disposed = true;
			instance.clearReadyWatchdog();
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

	/**
	 * Latest computed sheet snapshot. Stored so the FE-0b `webviewReady`
	 * handshake can (re)send the current state once the bundle's message channel
	 * is live (render() may run before the bundle has loaded).
	 */
	private latestSnapshot: QuantbookCellSnapshot | undefined;

	/**
	 * True once the bundled webview has posted `{type:'webviewReady'}`. Before
	 * the handshake, `postMessage` is dropped (the bundle's `message` listener
	 * isn't wired yet), so render() defers the push.
	 */
	private webviewReady: boolean = false;

	/**
	 * Watchdog timer that fires if the bundled webview never completes its
	 * `webviewReady` handshake (missing/broken bundle, CSP error, or
	 * `acquireVsCodeApi` failure). Without it, render() silently withholds every
	 * paint and the user sees a blank panel with no error -- a No-Fallbacks
	 * violation. On timeout we surface a loud `showErrorMessage`. Cleared on the
	 * handshake + on dispose.
	 */
	private readyWatchdog: ReturnType<typeof setTimeout> | undefined;

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
	 * Compute the snapshot and PUSH it to the persistent bundled webview via
	 * `postMessage({type:'render', snapshot})` (FE-0b -- no `webview.html`
	 * rebuild; the bundle + the `onDidReceiveMessage` handler persist). The push
	 * is gated on the `webviewReady` handshake: the snapshot is always stored in
	 * {@link latestSnapshot}, and {@link postRenderIfReady} sends it now if the
	 * channel is live or the handshake sends it on bundle load. The title is
	 * reactive (sheet count + name from the snapshot).
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
		// FE-0b: push the snapshot to the persistent bundle via postMessage (no
		// webview.html rebuild). Store it first so the webviewReady handshake can
		// (re)send the latest snapshot once the bundle's channel is live.
		this.latestSnapshot = snapshot;
		this.postRenderIfReady();
	}

	/**
	 * Post {@link latestSnapshot} to the bundled webview as a `render` message,
	 * IFF the webview has completed its `webviewReady` handshake (and the panel
	 * is live + a snapshot exists). Before the handshake, `postMessage` would be
	 * silently dropped; render() defers and the handshake re-sends.
	 */
	private postRenderIfReady(): void {
		if (!this.webviewReady || this.latestSnapshot === undefined || this._disposed) {
			return;
		}
		// Log a non-delivered render (No-Fallbacks): postMessage resolves false /
		// rejects when the channel can't accept the message; a dropped paint must
		// not pass silently.
		this.panel.webview.postMessage({ type: 'render', snapshot: this.latestSnapshot }).then(
			delivered => {
				if (!delivered && !this._disposed) {
					console.warn('[cellGrid] render postMessage was not delivered to the webview.');
				}
			},
			err => console.error('[cellGrid] render postMessage rejected:', err),
		);
	}

	/**
	 * Start the {@link readyWatchdog}. Called once from `show()` after the shell
	 * is mounted; on timeout (no `webviewReady`) it surfaces a loud error rather
	 * than leaving a silently-blank grid.
	 */
	private armReadyWatchdog(): void {
		this.readyWatchdog = setTimeout(() => {
			if (this.webviewReady || this._disposed) {
				return;
			}
			const detail = 'Quantbook cell grid failed to initialize: the webview bundle did not load. '
				+ 'Rebuild it with "npm run build:webviews:quantbook" (in extensions/quantlab) and reopen the grid.';
			console.error(`[cellGrid] ${detail}`);
			void vscode.window.showErrorMessage(detail);
		}, READY_WATCHDOG_MS);
	}

	/** Cancel the {@link readyWatchdog} (handshake arrived, or panel disposed). */
	private clearReadyWatchdog(): void {
		if (this.readyWatchdog !== undefined) {
			clearTimeout(this.readyWatchdog);
			this.readyWatchdog = undefined;
		}
	}

	/**
	 * Thin wrapper around the vscode-free {@link dispatchIncomingMessage}. Lives
	 * here (not in cellGridLogic.ts) because it captures `this`. The dispatcher
	 * handles `putValue` (number/text/formula -> write -> recalc -> render),
	 * `undo`/`redo`, and silently drops the dormant collab `presenceUpdate`/
	 * `typing_stroke` envelopes.
	 */
	private handleIncoming(raw: unknown): void {
		// FE-0b handshake: the bundled webview posts `{type:'webviewReady'}` once
		// on load. Mark the channel live + (re)send the latest snapshot. Intercept
		// BEFORE delegating -- dispatchIncomingMessage would log it as an unknown
		// outbound type.
		if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'webviewReady') {
			this.webviewReady = true;
			this.clearReadyWatchdog();
			this.postRenderIfReady();
			return;
		}
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
				// Post the cell decoration. If delivery fails (channel busy /
				// transient) fall back to a visible warning so the validation error
				// is never silently lost (No-Fallbacks).
				this.panel.webview.postMessage(reply).then(
					delivered => {
						if (!delivered && !this._disposed) {
							void vscode.window.showWarningMessage(
								`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
							);
						}
					},
					err => console.error('[cellGrid] errorReply postMessage rejected:', err),
				);
			},
		});
	}
}

/**
 * **FE-0b (2026-06-02)** -- build the one-time shell HTML that loads the
 * persistent bundled sheets webview. Mirrors the established bundled-webview
 * pattern (qviz-spec via `VisualiseSpecProvider`): a fresh nonce, the bundle
 * `<script nonce src>` + `<link>` loaded via `asWebviewUri`, and a nonce-based
 * CSP. Snapshot DATA never appears in this HTML (it arrives via postMessage), so
 * there is no user-controlled content in the shell -- only the nonce
 * (alphanumeric, from {@link getNonce}) and the webview's own resource URIs.
 *
 * CSP: `default-src 'none'` (deny by default); `style-src ${cspSource}
 * 'unsafe-inline'` (the bundled stylesheet is served from the webview's resource
 * origin; `'unsafe-inline'` is retained for VS Code theme-variable styles);
 * `script-src 'nonce-${nonce}'` (only the nonce-tagged bundle script runs);
 * `img-src ${cspSource}`.
 */
function buildShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	const scriptUri = getWebviewUri(webview, extensionUri, ['dist', 'webview', 'quantbook', 'sheets-webview.js']);
	const styleUri = getWebviewUri(webview, extensionUri, ['dist', 'webview', 'quantbook', 'sheets-webview-style.css']);
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link href="${styleUri}" rel="stylesheet">
<title>Quantbook Cell Grid</title>
</head>
<body>
<div id="sheets-root">Loading Quantbook cell grid&hellip;</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
