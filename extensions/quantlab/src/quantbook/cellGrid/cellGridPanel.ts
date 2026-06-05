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
import { acquireWorkbookSnapshotViaDelta, attachCellDiagnostics, buildCellDiagnosticMessages, dispatchIncomingMessage, extractSheetSnapshot, getSharedDeltaCache, type CommitResultMessage } from './cellGridLogic';
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
 * Registries of live panels.
 *
 * **FE megaudit F2 (2026-06-03)**: keyed by SESSION IDENTITY, not sheet number
 * alone. The prior `Map<number, CellGridPanel>` revealed a *different* session's
 * panel when a second workbook opened on the same sheet id -- leaking the new
 * session (never shown/closed) and showing the wrong workbook, breaking the
 * single-writer model the FE-0a migration established.
 *
 * - `allPanels`: every live panel, iterable -- for refreshAll / enumerate.
 * - `bySession`: `session -> (sheet -> panel)`, for single-tab-per-(session,sheet)
 *   reveal. ONE session may own SEVERAL panels (different sheets via switch-sheet),
 *   so the owning napi `Session` is closed only when its LAST panel disposes (F4).
 * - `focusedPanel`: the last-activated panel -- the target for sheet-management /
 *   Save-As commands when multiple sessions are open (replaces the old arbitrary
 *   "oldest open panel" pick that could mutate the wrong workbook).
 */
const allPanels: Set<CellGridPanel> = new Set();
const bySession: Map<SessionInstance, Map<number, CellGridPanel>> = new Map();
let focusedPanel: CellGridPanel | undefined;

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
		// Single-tab-per-(session,sheet): reveal + refresh an EXISTING panel only when
		// it belongs to THIS session (F2 -- never reveal a different session's panel
		// just because it shares a sheet id).
		const existing = bySession.get(session)?.get(sheet);
		if (existing !== undefined) {
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			existing.render();
			focusedPanel = existing;
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
		// F4: PANEL-SCOPED disposables. The message + view-state listeners MUST NOT
		// outlive the panel -- registering them on `context.subscriptions` (extension
		// lifetime) lets a late buffered webview message reach `handleIncoming` on a
		// disposed panel / closed session. These are disposed in `onDidDispose`.
		// Attached BEFORE mounting the shell so the `webviewReady` handshake (posted
		// on bundle load) is never missed.
		const panelDisposables: vscode.Disposable[] = [];
		panel.webview.onDidReceiveMessage((raw: unknown) => instance.handleIncoming(raw), undefined, panelDisposables);
		panel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				focusedPanel = instance;
			}
		}, undefined, panelDisposables);
		// Mount the persistent bundle shell ONCE. Snapshots are pushed via
		// postMessage in render() (gated on the webviewReady handshake), NOT by
		// rebuilding webview.html.
		panel.webview.html = buildShellHtml(panel.webview, context.extensionUri);
		// FE re-audit MED-2: register the panel in the lifecycle structures + its dispose
		// handler BEFORE the first render. If the initial render() throws, the dispose path
		// must still run (dispose listeners + ref-counted session.close) -- otherwise the
		// webview + message listener + napi Session orphan outside the registry.
		allPanels.add(instance);
		let sheetMap = bySession.get(session);
		if (sheetMap === undefined) {
			sheetMap = new Map();
			bySession.set(session, sheetMap);
		}
		sheetMap.set(sheet, instance);
		focusedPanel = instance;
		panel.onDidDispose(() => {
			// Set _disposed BEFORE anything else so a postMessage racing with
			// disposal early-returns from the onError guard.
			instance._disposed = true;
			instance.clearReadyWatchdog();
			// F4: dispose the panel-scoped listeners so they cannot fire after the
			// panel is gone.
			for (const d of panelDisposables) {
				d.dispose();
			}
			allPanels.delete(instance);
			if (focusedPanel === instance) {
				focusedPanel = undefined;
			}
			// Only clear the registry entry if we still own it (a fresh open for the
			// same (session,sheet) may have replaced us).
			const sheetMapNow = bySession.get(session);
			if (sheetMapNow !== undefined && sheetMapNow.get(sheet) === instance) {
				sheetMapNow.delete(sheet);
				if (sheetMapNow.size === 0) {
					bySession.delete(session);
					// F4: the LAST panel for this session has closed -> close the
					// owning napi Session to release the engine handle (ref-counted:
					// sibling panels on other sheets keep it alive). This fires when the
					// user closes the last tab of a workbook (Open is additive as of the
					// 2026-06-05 host fix -- it never disposes other workbooks). Log on
					// failure (No-Fallbacks -- never swallow); do not rethrow from a
					// dispose callback.
					try {
						session.close();
					} catch (err) {
						console.error('[cellGrid] session.close() on last-panel dispose failed:', err);
					}
				}
			}
		});
		context.subscriptions.push(panel);
		// First paint + the webviewReady watchdog (surfaces a loud error if the bundle never
		// loads). If the initial render throws, dispose the panel -- which runs the cleanup
		// above (registry + ref-counted session.close) -- then rethrow so the command surfaces
		// the error rather than leaving an orphaned panel/session (FE re-audit MED-2).
		try {
			instance.render();
			instance.armReadyWatchdog();
		} catch (err) {
			panel.dispose();
			throw err;
		}
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
	static refreshAll(): { refreshed: number; failed: number; skipped: number } {
		return CellGridPanel.refreshIterable(allPanels);
	}

	/**
	 * Refresh every live panel bound to `session` (FE megaudit M1). undo/redo and
	 * any commit are session-wide (and a formula edit can change dependents on a
	 * SIBLING sheet), so the post-commit re-render must cover all of the session's
	 * panels, not just the one that dispatched. Same honest `{refreshed,failed,skipped}`.
	 */
	static refreshSession(session: SessionInstance): { refreshed: number; failed: number; skipped: number } {
		const sheetMap = bySession.get(session);
		return CellGridPanel.refreshIterable(sheetMap !== undefined ? sheetMap.values() : []);
	}

	private static refreshIterable(it: Iterable<CellGridPanel>): { refreshed: number; failed: number; skipped: number } {
		let refreshed = 0;
		let failed = 0;
		let skipped = 0;
		for (const instance of it) {
			const outcome = instance.safeRender();
			if (outcome === 'ok') {
				refreshed += 1;
			} else if (outcome === 'failed') {
				failed += 1;
			} else {
				skipped += 1;
			}
		}
		return { refreshed, failed, skipped };
	}

	/**
	 * Render wrapper that never throws into the caller (refreshAll iterates many
	 * panels). Returns `true` on success, `false` if `render()` threw -- the caller
	 * (refreshAll) aggregates the failure count so the command layer can surface it
	 * LOUD (No-Fallbacks); `console.warn` keeps the per-panel detail. A failure does
	 * not abort the refresh of sibling panels.
	 *
	 * Returns `'ok'` on success, `'failed'` if `render()` threw, and `'skipped'` for
	 * a disposed panel (FE megaudit M6: a disposed panel did NOT re-render, so it
	 * must not be counted as `refreshed` -- the count would over-report success).
	 */
	private safeRender(): 'ok' | 'failed' | 'skipped' {
		if (this._disposed) {
			return 'skipped';
		}
		try {
			this.render();
			return 'ok';
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.warn(`[quantbook] cell-grid safeRender failed: ${detail}`);
			return 'failed';
		}
	}

	/**
	 * Enumerate active panels for the switch-sheet / save commands. The returned
	 * `session` references are live; callers must NOT cache the array across event
	 * loop ticks (panels can dispose at any time).
	 */
	static activeLocalPanels(): Array<{ session: SessionInstance; sheet: number }> {
		const result: Array<{ session: SessionInstance; sheet: number }> = [];
		for (const instance of allPanels) {
			result.push({ session: instance.session, sheet: instance.sheet });
		}
		return result;
	}

	/**
	 * The last-focused panel's `(session, sheet)`, or `undefined` if none is focused.
	 * **FE megaudit F2**: sheet-management / Save-As commands must target the panel
	 * the user is actually looking at, NOT an arbitrary "oldest open panel" -- with
	 * multiple sessions open the old pick could rename/save the WRONG workbook.
	 */
	static focusedLocalPanel(): { session: SessionInstance; sheet: number } | undefined {
		if (focusedPanel === undefined || focusedPanel._disposed) {
			return undefined;
		}
		return { session: focusedPanel.session, sheet: focusedPanel.sheet };
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

	/**
	 * **FE megaudit F3 (2026-06-03)** -- per-panel cursor into the session's event
	 * ring (contract section 9). `render()` drains `session.pollEvents(cursor)` each
	 * paint to surface `cell_diagnostic` events (the UDF no-worker/raised/timeout/
	 * died sink) as cell tooltips. Reading does NOT drain the ring -- we advance this
	 * cursor by the returned `nextCursor` so each render only sees NEW events.
	 *
	 * The cursor is PER PANEL (not shared via the session delta cache): two panels on
	 * one session each maintain their own ring position, so neither double-drains nor
	 * starves the other (the engine ring is append-only + cursor-addressed, not
	 * consume-on-read). Starts at `0n` (read from the ring start on first render).
	 */
	private eventCursor: bigint = 0n;

	/**
	 * **FE megaudit F3 (2026-06-03)** -- accumulated per-cell diagnostic messages
	 * keyed `"row,col"`, folded across renders. `pollEvents` only returns events SINCE
	 * the cursor, so a diagnostic emitted on an earlier render's page would be lost if
	 * we rebuilt the map from only the latest page; instead we fold each page's
	 * messages onto this persistent map (last-wins). {@link attachCellDiagnostics}
	 * then surfaces a message ONLY on a cell whose CURRENT value is an error, so a
	 * cell that later recomputes to a real value naturally drops its (stale) tooltip.
	 */
	private readonly accumulatedDiagnostics: Map<string, string> = new Map();

	/**
	 * **FE megaudit M4 (2026-06-03)** -- guards the one-time deleted-sheet warning.
	 * A tombstoned active sheet (`extractSheetSnapshot === null`) must surface a
	 * VISIBLE warning (not just `console.warn`), but render() runs on every commit /
	 * refresh, so this flag suppresses the toast after the first so the user is not
	 * spammed once per paint. Reset to `false` if the sheet ever reappears (e.g. a
	 * future restore), so a re-delete warns again.
	 */
	private deletedSheetWarned: boolean = false;

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
	 * **Tombstone race (M4)**: if the active sheet was deleted while the panel is
	 * open, `extractSheetSnapshot` returns null; we render an empty grid + surface a
	 * ONE-TIME visible warning (No-Fallbacks) rather than throwing on every render
	 * forever or masking the tombstone as a benign empty sheet.
	 *
	 * **Diagnostics (F3)**: each render drains the session event ring and attaches
	 * `cell_diagnostic` messages so the webview hover tooltip explains `#CALC!`/
	 * `#TIMEOUT!` cells.
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
			// FE megaudit M4: a deleted active sheet previously rendered as an
			// ordinary empty grid with only a console.warn -- the user could not tell
			// a tombstoned sheet from a genuinely empty one. Surface a VISIBLE warning
			// ONCE (the guard avoids one toast per paint), telling them to switch or
			// close.
			if (!this.deletedSheetWarned) {
				this.deletedSheetWarned = true;
				void vscode.window.showWarningMessage(
					`Quantbook: sheet ${this.sheet} was deleted; this Cell Grid is now empty. ` +
					`Switch sheets ("Quantbook: Switch Cell Grid Sheet") or close this panel.`,
				);
			}
		} else {
			// The sheet exists again (or never was deleted) -- re-arm the M4 warning so
			// a future delete of this sheet warns afresh.
			this.deletedSheetWarned = false;
		}
		// FE megaudit F3: drain the session's event ring for cell_diagnostic events
		// and attach them to the snapshot so the webview's hover tooltip explains WHY
		// a cell is `#CALC!`/`#TIMEOUT!` (the apparatus existed end-to-end but was
		// never fed). pollEvents does NOT drain the ring; advance the per-panel cursor
		// by nextCursor so each render only folds NEW events into the accumulated map.
		const decorated = this.drainAndAttachDiagnostics(snapshot);
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
		// webview.html rebuild). Store the DIAGNOSTIC-DECORATED snapshot (F3) first so
		// the webviewReady handshake can (re)send the latest snapshot once the
		// bundle's channel is live.
		this.latestSnapshot = decorated;
		this.postRenderIfReady();
	}

	/**
	 * **FE megaudit F3 (2026-06-03)** -- drain new `cell_diagnostic` events from the
	 * session's event ring and return a copy of `snapshot` with the per-cell
	 * diagnostic tooltips attached.
	 *
	 * Reads `session.pollEvents(this.eventCursor)` (a non-draining cursor read),
	 * folds this sheet's `cell_diagnostic` messages into {@link accumulatedDiagnostics}
	 * (last-wins, persisted across renders so an earlier page's diagnostic is not
	 * lost), advances {@link eventCursor} to the page's `nextCursor`, then attaches
	 * the accumulated messages via {@link attachCellDiagnostics} (which surfaces a
	 * message ONLY on a CURRENTLY error-valued cell, so recovered cells drop their
	 * tooltip). A `dropped` page (consumer fell behind -- v1's ring is unbounded so
	 * this never fires) is logged loud (No-Fallbacks) since a missed diagnostic could
	 * leave a stale tooltip; the snapshot still renders.
	 */
	private drainAndAttachDiagnostics(snapshot: QuantbookCellSnapshot): QuantbookCellSnapshot {
		const page = this.session.pollEvents(this.eventCursor);
		if (page.dropped) {
			console.warn(
				`[cellGrid] pollEvents reported a dropped event page (sheet ${this.sheet}); ` +
				`some cell diagnostics may be missing until the next recompute.`,
			);
		}
		const pageMessages = buildCellDiagnosticMessages(page.events, this.sheet);
		for (const [key, message] of pageMessages) {
			this.accumulatedDiagnostics.set(key, message);
		}
		this.eventCursor = page.nextCursor;
		return attachCellDiagnostics(snapshot, this.accumulatedDiagnostics);
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
		// FE megaudit M5 (2026-06-03): a dropped post-commit render must surface a
		// VISIBLE signal, not just console.warn -- the asymmetry with the errorReply
		// path (which already toasts on non-delivery) meant a committed edit whose
		// repaint was dropped left STALE values on screen with no user cue. Treat a
		// dropped render like a dropped errorReply: a warning that the grid may be
		// stale + how to recover (No-Fallbacks). postMessage resolves false / rejects
		// when the channel can't accept the message.
		this.panel.webview.postMessage({ type: 'render', snapshot: this.latestSnapshot }).then(
			delivered => {
				if (!delivered && !this._disposed) {
					console.warn('[cellGrid] render postMessage was not delivered to the webview.');
					void vscode.window.showWarningMessage(
						'Quantbook: the cell grid may be showing stale values (a repaint was not delivered). ' +
						'Run "Quantbook: Refresh Cell Grid".',
					);
				}
			},
			err => {
				console.error('[cellGrid] render postMessage rejected:', err);
				if (!this._disposed) {
					void vscode.window.showWarningMessage(
						'Quantbook: the cell grid may be showing stale values (a repaint failed). ' +
						'Run "Quantbook: Refresh Cell Grid".',
					);
				}
			},
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
			// FE megaudit M1: re-render EVERY panel of this session, not just this one.
			// undo/redo is session-wide, and a formula edit can change dependents on a
			// SIBLING sheet -- a panel-local render would leave those stale. A render
			// failure is surfaced LOUD (No-Fallbacks) rather than swallowed.
			onCommit: () => {
				const { failed } = CellGridPanel.refreshSession(this.session);
				if (failed > 0) {
					void vscode.window.showWarningMessage(
						`Quantbook: the edit committed but ${failed} cell-grid panel(s) failed to re-render. Run "Quantbook: Refresh Cell Grid".`,
					);
				}
			},
			// **FE-2-0 Phase 2 (commit-token)**: ack a successful tokened commit to THIS panel only
			// (the originating webview), NOT a session fan-out -- `onCommit` above already pushed the
			// session-wide render. The webview resolves exactly this edit on the matching commitId; a
			// bare `render` no longer closes a pending editor (kills the sibling-render false-ack HIGH).
			onAck: commitId => {
				if (this._disposed) {
					return; // the editor is gone with the panel -- nothing to resolve
				}
				const ack: CommitResultMessage = { type: 'commitResult', commitId, ok: true };
				this.panel.webview.postMessage(ack).then(
					delivered => {
						if (!delivered && !this._disposed) {
							// The commit DID land (data is correct); only the ack didn't reach the editor, so
							// it stays pending until reload. Surface it (No-Fallbacks) rather than hide it.
							console.warn(`[cellGrid] commitResult (commitId ${commitId}) was not delivered; the editor may stay pending.`);
						}
					},
					err => console.error('[cellGrid] commitResult postMessage rejected:', err),
				);
			},
			// **FE-2-0 Phase 2 (S2-MED1)**: a session-wide op failure (undo/redo throw) with no cell --
			// a plain warning toast, NOT a cell-decorating errorReply (which mis-tinted A1).
			onOperationError: message => {
				if (this._disposed) {
					return;
				}
				void vscode.window.showWarningMessage(`Quantbook cell grid: ${message}`);
			},
			onError: reply => {
				// If the panel is disposed, `webview.postMessage` is silently dropped
				// -- fall back to showWarningMessage so the user sees the error. (The
				// panel uses retainContextWhenHidden:true, so a HIDDEN panel still
				// retains its channel; non-delivery is therefore rare but still
				// handled below.)
				if (this._disposed) {
					void vscode.window.showWarningMessage(
						`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
					);
					return;
				}
				// Post the cell decoration. If delivery fails (channel busy /
				// transient) OR the promise rejects, fall back to a visible warning so
				// the validation error is never silently lost (No-Fallbacks). FE
				// megaudit M5: the rejection arm previously only console.error'd --
				// asymmetric with the non-delivery arm; now both toast.
				this.panel.webview.postMessage(reply).then(
					delivered => {
						if (!delivered && !this._disposed) {
							void vscode.window.showWarningMessage(
								`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
							);
						}
					},
					err => {
						console.error('[cellGrid] errorReply postMessage rejected:', err);
						if (!this._disposed) {
							void vscode.window.showWarningMessage(
								`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
							);
						}
					},
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
 * (base64url `[A-Za-z0-9_-]`, CSPRNG, from {@link getNonce}) and the webview's own
 * resource URIs.
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
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
