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
import { acquireWorkbookSnapshotViaDelta, attachCellDiagnostics, buildCellDiagnosticMessages, dispatchIncomingMessage, extractSheetSnapshot, getSharedDeltaCache, parseToolbarCommandMessage, type CellsWrittenMessage, type CommitResultMessage, type FunctionListMessage, type GridSelection, type ToolbarFormatPreset, type ValidateFormulaResultMessage } from './cellGridLogic';
import { getNonce, getWebviewUri } from '../../utils/webview';
import type { PublishedRange } from '../reactiveKernel/publishedCellsStore';
// Demo-prep toolbar (2026-06-10): the webview toolbar's `setNumberFormat` applies a preset directly to
// this panel's selection -- the same registerFormat -> buildSetFormatOps -> batch -> recalc -> refresh
// core as the `quantlab.quantbookSetFormat` command (which keeps the QuickPick/Custom path).
import { buildFormatUndoLabel, buildSetFormatOps, formatStringForPreset, presetLabel } from './formatPickerLogic';
// fe/sheet-tabs (2026-06-10; Codex HIGH): "Freeze Panes Here" carries the right-click-time
// `{panelToken, selection}` like the structural commands -- the pure planFreezeAtSelection pins the
// focus-cell -> freeze-counts math shared by the palette and the context-menu freeze paths.
import { planFreezeAtSelection, type GridSelectionInput } from './contextMenuLogic';
import { formatRangeTarget, normalizeSelectionRect } from '../reactiveNotebook/bindVariableLogic';
import { recalcDirtyChecked } from '../session';

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
 * - `bySession`: `session -> panel`. **Sheet-tabs refactor (2026-06-10): ONE panel per
 *   WORKBOOK (session), not per (session, sheet).** A workbook now opens as a single
 *   editor whose active sheet is switched IN PLACE by the bottom tab strip (`switchToSheet`),
 *   so a session owns exactly one panel and disposing it closes the owning napi `Session`.
 *   (Prior model: `session -> (sheet -> panel)` -- each sheet was its own editor tab.)
 * - `focusedPanel`: the last-activated panel -- the target for sheet-management /
 *   Save-As commands when multiple sessions are open (replaces the old arbitrary
 *   "oldest open panel" pick that could mutate the wrong workbook).
 */
const allPanels: Set<CellGridPanel> = new Set();
const bySession: Map<SessionInstance, CellGridPanel> = new Map();
let focusedPanel: CellGridPanel | undefined;

/**
 * **W3 (Wave 3, 2026-06-09; Codex HIGH-2)** -- maps a webview instance token (`WEBVIEW_ID`, reported in
 * the `webviewReady` handshake) to its {@link CellGridPanel}. The native right-click context menu carries
 * the raising webview's token in `data-vscode-context`; the host commands resolve the EXACT panel via this
 * map (NOT merely the focused one -- which can differ in split editors / focus edge cases, hitting the
 * wrong grid). An entry is set on `webviewReady` and cleared on dispose; a stale pre-reload token never
 * resolves (the reloaded webview re-handshakes with a fresh token, last-wins).
 */
const byWebviewToken: Map<string, CellGridPanel> = new Map();

/**
 * **FE-1.5 W-G** -- a panel pulls the cells its session's published variables drive (the bound-cell
 * badge) via this provider, registered by the reactive-kernel layer at activation. `undefined` (no
 * reactive kernel wired, or post-deactivate) means "no badges" -- the render path stays unconditional.
 */
type PublishedCellsProvider = (session: SessionInstance, sheet: number) => PublishedRange[];
let publishedCellsProvider: PublishedCellsProvider | undefined;

/**
 * **W2 error-surface** -- the host-side sink a panel reports its cell errors to so they surface in VS
 * Code's Problems panel via the `quantbook` DiagnosticCollection. Injected at activation (mirrors
 * {@link publishedCellsProvider}); `undefined` (no bridge wired, or post-deactivate) makes every report
 * a no-op so the render/edit paths stay unconditional. Only the methods a panel needs are declared --
 * the concrete bridge (`QuantbookDiagnostics`) implements more (reactive errors, session-wide clears).
 */
interface CellDiagnosticsSink {
	setSheetCellDiagnostics(session: SessionInstance, sheet: number, snapshot: QuantbookCellSnapshot): void;
	setCellErrorReply(session: SessionInstance, sheet: number, row: number, col: number, code: string, message: string): void;
	clearCellErrorReply(session: SessionInstance, sheet: number, row: number, col: number): void;
	clearSheet(session: SessionInstance, sheet: number): void;
	clearSessionAll(session: SessionInstance): void;
}
let diagnosticsSink: CellDiagnosticsSink | undefined;

// FE-1.5-1d-1: listeners fired right before a session's LAST panel closes + the owning Session is
// closed. Lets a bound reactive kernel tear down (dispose) BEFORE session.close(), so no republish
// can write to a closing Session and no ipykernel is orphaned.
const sessionClosingListeners: Array<(session: SessionInstance) => void> = [];
function fireSessionClosing(session: SessionInstance): void {
	for (const listener of sessionClosingListeners) {
		try {
			listener(session);
		} catch (err) {
			console.error('[cellGrid] sessionClosing listener threw:', err);
		}
	}
}

// FE-5 (W4 product shell, SHARED EDIT): listeners fired whenever the live-panel landscape changes --
// a panel opens, a panel disposes, or the focused panel changes. The Live-Python sidebar consults
// `focusedLocalPanel()` + the reactive kernel for the focused workbook, and the shell drives the
// `quantbook.hasOpenGrid` context key off `hasAnyPanel()`; both need a pull signal when that state
// changes (there is no VS Code event for "a quantbook grid opened/focused"). Plain listener array +
// try/guard (mirrors `sessionClosingListeners`) -- vscode-free, fires synchronously after the
// registry mutation so a listener reading `focusedLocalPanel()`/`hasAnyPanel()` sees the new state.
const gridsChangedListeners: Array<() => void> = [];
function fireGridsChanged(): void {
	for (const listener of gridsChangedListeners) {
		try {
			listener();
		} catch (err) {
			console.error('[cellGrid] gridsChanged listener threw:', err);
		}
	}
}

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
		// Sheet-tabs refactor (2026-06-10): ONE panel per workbook (session). If this session
		// already has a panel, reveal it and SWITCH IT to the requested sheet IN PLACE (the
		// bottom tab strip's model) rather than opening a second editor tab. F2 still holds --
		// the lookup is by session identity, never another workbook's panel.
		const existing = bySession.get(session);
		if (existing !== undefined) {
			existing.panel.reveal(vscode.ViewColumn.Active, false);
			// switchToSheet is a no-op when already on `sheet` (it still re-renders only if it
			// changed); a fresh reveal of the same sheet must still repaint, so render() when unchanged.
			if (existing.sheet === sheet) {
				existing.render();
			} else {
				existing.switchToSheet(sheet);
			}
			focusedPanel = existing;
			// FE-5: re-opening an existing grid changes the focused workbook -> tell the shell.
			fireGridsChanged();
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
			} else if (focusedPanel === instance) {
				// Megaudit (2026-06-05) MED: clear the focus pointer when THIS panel stops being active (the
				// user clicked a source file / another editor). Otherwise `focusedLocalPanel()` keeps returning
				// this no-longer-focused panel, and a sheet-management / Save-As command with multiple workbooks
				// open would silently target it instead of hitting the intended ambiguous-abort (resolveTargetOrWarn).
				// Switching grid B -> grid A still ends with focusedPanel === A regardless of the activate/
				// deactivate event order (A's activate sets it; B's deactivate only clears it if it is still B).
				focusedPanel = undefined;
			}
			// FE-5: the focused workbook may have changed -> the Live-Python sidebar re-reads focus + its
			// kernel's published variables. (A no-op activate that does not move focus still fires, which is
			// harmless -- the listener recomputes idempotently.)
			fireGridsChanged();
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
		// Sheet-tabs refactor: one panel per session (the workbook), keyed by session identity.
		bySession.set(session, instance);
		focusedPanel = instance;
		// FE-5: a new grid is now open + focused -> drive the `quantbook.hasOpenGrid` context key and
		// refresh the Live-Python sidebar. Fired AFTER the registry mutation so a listener that reads
		// `hasAnyPanel()`/`focusedLocalPanel()` sees this panel.
		fireGridsChanged();
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
			// W3 (Codex HIGH-2): drop this panel's webview-token map entry so a context-menu command can never
			// resolve a disposed panel. Guard on identity (a fresh panel may have re-used the string after a
			// reload) so we only clear our own.
			if (instance.webviewToken !== undefined && byWebviewToken.get(instance.webviewToken) === instance) {
				byWebviewToken.delete(instance.webviewToken);
			}
			if (focusedPanel === instance) {
				focusedPanel = undefined;
			}
			// Sheet-tabs refactor: one panel per session. Only clear the registry entry if we
			// still own it (a fresh open for the same session may have replaced us -- e.g. close
			// racing a reopen). Closing this panel closes the whole workbook (no sibling sheet
			// panels exist anymore), so dispose == close, unconditionally.
			if (bySession.get(session) === instance) {
				bySession.delete(session);
				// W2 error-surface: the workbook's panel closed -> drop ALL its diagnostics (every
				// sheet's cell errors + the workbook-level reactive error, which is session-scoped).
				diagnosticsSink?.clearSessionAll(session);
				// 1d-1: tear down a reactive kernel bound to this Session BEFORE closing it, so an
				// in-flight republish cannot write to a closing Session and the ipykernel is not orphaned.
				fireSessionClosing(session);
				// The workbook's panel has closed -> close the owning napi Session to release the
				// engine handle. Open is additive (2026-06-05) -- it never disposes other workbooks.
				// Log on failure (No-Fallbacks -- never swallow); do not rethrow from a dispose callback.
				try {
					session.close();
				} catch (err) {
					console.error('[cellGrid] session.close() on panel dispose failed:', err);
				}
			}
			// FE-5: a grid closed (and possibly the focused one / the last one) -> re-evaluate
			// `quantbook.hasOpenGrid` + refresh the sidebar. Fired AFTER the registry mutation so a
			// listener sees the post-close `hasAnyPanel()`/`focusedLocalPanel()` state.
			fireGridsChanged();
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
	 * Refresh ALL currently-open cell-grid panels. Called by the explicit
	 * `quantlab.quantbookCellGridRefresh` command. (The B2 sheet-management commands use the
	 * session-scoped {@link refreshSession} instead -- megaudit M1, 2026-06-05.)
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
		const panel = bySession.get(session);
		return CellGridPanel.refreshIterable(panel !== undefined ? [panel] : []);
	}

	/** Register a listener fired before a session's LAST panel closes (1d-1: tear down its kernel).
	 *  Returns a disposable that unregisters it (push into context.subscriptions to avoid a stale
	 *  listener across a same-host re-activation). */
	static onSessionClosing(listener: (session: SessionInstance) => void): { dispose(): void } {
		sessionClosingListeners.push(listener);
		return {
			dispose: (): void => {
				const i = sessionClosingListeners.indexOf(listener);
				if (i >= 0) {
					sessionClosingListeners.splice(i, 1);
				}
			},
		};
	}

	/**
	 * **FE-5 (W4 product shell)** -- register a listener fired whenever the live-grid landscape changes:
	 * a panel opens, a panel disposes, or the focused panel changes. The shell drives the
	 * `quantbook.hasOpenGrid` context key off {@link hasAnyPanel} and the Live-Python sidebar re-reads
	 * {@link focusedLocalPanel} + its reactive kernel on this signal. Returns a disposable that
	 * unregisters it (push into context.subscriptions to avoid a stale listener across a same-host
	 * re-activation). The listener fires AFTER the registry mutation, so it observes the new state.
	 */
	static onDidChangeGrids(listener: () => void): { dispose(): void } {
		gridsChangedListeners.push(listener);
		return {
			dispose: (): void => {
				const i = gridsChangedListeners.indexOf(listener);
				if (i >= 0) {
					gridsChangedListeners.splice(i, 1);
				}
			},
		};
	}

	/** **FE-5** -- whether ANY Cell Grid panel is currently open (drives `quantbook.hasOpenGrid`). */
	static hasAnyPanel(): boolean {
		return allPanels.size > 0;
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
	 * **FE-1.5 W-G-2b (2026-06-08)** -- the last-focused panel's reported grid SELECTION
	 * (`session`, `sheet`, and the {@link GridSelection} range), or `undefined` if no panel is focused,
	 * the focused panel is disposed, OR it has not reported a selection yet (no interaction since open).
	 * Mirrors {@link focusedLocalPanel} -- the parallel hook the reactive-notebook "bind variable to
	 * selected cell" flow will consume. The dispatcher guarantees `selection.sheet === sheet`.
	 */
	static focusedGridSelection(): { session: SessionInstance; sheet: number; selection: GridSelection } | undefined {
		if (focusedPanel === undefined || focusedPanel._disposed || focusedPanel.latestSelection === undefined) {
			return undefined;
		}
		return { session: focusedPanel.session, sheet: focusedPanel.sheet, selection: focusedPanel.latestSelection };
	}

	/**
	 * **W3 frozen panes (2026-06-09)** -- freeze the focused Cell Grid AT its current selection's FOCUS cell
	 * (Excel "Freeze Panes"): pin rows `[0, focusRow)` + cols `[0, focusCol)` so everything above/left of the
	 * active cell stays visible on scroll. Returns the applied `{rows, cols}` for the command's toast, or a
	 * `reason` the command surfaces (no focused panel, or no selection reported yet). The focus cell becomes
	 * the top-left of the scrollable body; selecting A1 (`0,0`) freezes nothing (the natural Unfreeze gesture,
	 * matching Excel). The webview re-clamps, so an out-of-range count can never corrupt the paint.
	 */
	static freezeFocusedPanesAtSelection(): { ok: true; rows: number; cols: number } | { ok: false; reason: 'no-panel' | 'no-selection' } {
		if (focusedPanel === undefined || focusedPanel._disposed) {
			return { ok: false, reason: 'no-panel' };
		}
		if (focusedPanel.latestSelection === undefined) {
			return { ok: false, reason: 'no-selection' };
		}
		const sel = focusedPanel.latestSelection;
		// Freeze above+left of the FOCUS cell (the pure planFreezeAtSelection -- shared with the context
		// menu's "Freeze Panes Here" so the two paths cannot drift). The dispatcher validated focusRow/
		// focusCol are integers in the A1 extent, so these are already sane; the webview clamps again
		// (defence in depth).
		const { rows, cols } = planFreezeAtSelection(sel);
		focusedPanel.setFrozenPanes(rows, cols);
		return { ok: true, rows, cols };
	}

	/**
	 * **fe/sheet-tabs (2026-06-10; Codex HIGH)** -- freeze the panel that RAISED the context menu
	 * (resolved by its `panelToken`) at the CARRIED right-click-time selection's focus cell: the
	 * "Freeze Panes Here" path. Same semantics as {@link freezeFocusedPanesAtSelection} (rows above +
	 * cols left of the focus cell via the shared {@link planFreezeAtSelection}; a focus of A1 applies
	 * `0/0` = Unfreeze, matching Excel) but over the authoritative `{panelToken, selection}` payload --
	 * NOT the focused panel's async-updated `latestSelection`, which would reintroduce the
	 * stale-selection + wrong-grid races the structural commands eliminated (Codex HIGH-1 + HIGH-2).
	 * Applies through the same {@link setFrozenPanes} -> postFreezeIfReady path. Returns the applied
	 * `{rows, cols}` for the command's toast, or `'no-panel'` for an unknown/disposed token so the
	 * command surfaces a clear toast (No-Fallbacks).
	 */
	static freezePanesAtContextSelection(token: string, selection: GridSelectionInput): { ok: true; rows: number; cols: number } | { ok: false; reason: 'no-panel' } {
		const panel = CellGridPanel.panelByToken(token);
		if (panel === undefined) {
			return { ok: false, reason: 'no-panel' };
		}
		const { rows, cols } = planFreezeAtSelection(selection);
		panel.setFrozenPanes(rows, cols);
		return { ok: true, rows, cols };
	}

	/**
	 * **W3 frozen panes** -- Unfreeze the focused Cell Grid (clear all pinned rows/cols). Returns `false` when
	 * no panel is focused (the command surfaces it), else applies `0/0` and returns `true`.
	 */
	static unfreezeFocusedPanes(): boolean {
		if (focusedPanel === undefined || focusedPanel._disposed) {
			return false;
		}
		focusedPanel.setFrozenPanes(0, 0);
		return true;
	}

	/**
	 * **W3 (Wave 3, 2026-06-09; Codex HIGH-2)** -- resolve the live panel that raised a context menu by the
	 * `panelToken` its `data-vscode-context` carried. Returns `undefined` for an unknown / disposed token so
	 * the command surfaces a clear toast (No-Fallbacks). This is the EXACT panel that raised the menu, not
	 * merely the focused one -- the structural insert/delete commands act on it + the selection the payload
	 * carried, eliminating both the wrong-grid and the stale-selection races.
	 */
	static panelByToken(token: string): CellGridPanel | undefined {
		const panel = byWebviewToken.get(token);
		if (panel === undefined || panel._disposed) {
			return undefined;
		}
		return panel;
	}

	/** This panel's owning session + active sheet (for the token-resolved structural commands). */
	get target(): { session: SessionInstance; sheet: number } {
		return { session: this.session, sheet: this.sheet };
	}

	/**
	 * **W3 (Wave 3, 2026-06-09; Codex HIGH-2 + MED-1)** -- post a context-menu clipboard action
	 * (`cut`/`copy`/`paste`/`clear`) to the panel identified by `token` (the webview that raised the menu),
	 * where the grid clipboard + active-cell state live. Cut/Copy/Paste/Clear Contents thus route to the
	 * SAME webview functions as the Ctrl/Cmd+C/X/V/Delete keystrokes (the host never owns the clipboard).
	 *
	 * AWAITS delivery (No-Fallbacks, MED-1): returns `'no-panel'` when the token is unknown/disposed,
	 * `'undelivered'` when `postMessage` resolved false or rejected (the channel could not accept it), and
	 * `'ok'` on a delivered post -- so the caller can surface a precise toast rather than silently assuming
	 * success. A context menu can only have been raised over a fully-loaded grid, so the ready webview makes
	 * `'undelivered'` rare, but a panel torn down between the right-click and the menu click is handled.
	 */
	static async postContextMenuAction(token: string, action: 'cut' | 'copy' | 'paste' | 'clear'): Promise<'ok' | 'no-panel' | 'undelivered'> {
		const panel = CellGridPanel.panelByToken(token);
		if (panel === undefined) {
			return 'no-panel';
		}
		try {
			const delivered = await panel.panel.webview.postMessage({ type: 'contextMenuAction', action });
			if (!delivered) {
				console.warn('[cellGrid] contextMenuAction postMessage was not delivered to the webview.');
				return 'undelivered';
			}
			return 'ok';
		} catch (err) {
			console.error('[cellGrid] contextMenuAction postMessage rejected:', err);
			return 'undelivered';
		}
	}

	/**
	 * **FE-1.5 W-G (2026-06-08)** -- register (or clear with `undefined`) the provider every panel consults
	 * at render time for the cells its session's published variables drive (the bound-cell badge). The
	 * reactive-kernel layer wires this to {@link ReactiveKernelManager.publishedCellsForSheet} at activation
	 * and clears it on deactivate. A provider hook (not a direct manager import) keeps the panel decoupled
	 * from the reactive layer, mirroring how that layer already calls {@link CellGridPanel.refreshSession}.
	 */
	static setPublishedCellsProvider(provider: PublishedCellsProvider | undefined): void {
		publishedCellsProvider = provider;
	}

	/**
	 * **W2 error-surface (2026-06-09)** -- register (or clear with `undefined`) the sink every panel
	 * reports its cell errors to so they surface in the Problems panel via the `quantbook`
	 * DiagnosticCollection. Wired at activation to the `QuantbookDiagnostics` bridge and cleared on
	 * deactivate. A sink hook (not a direct bridge import) keeps the panel decoupled from the diagnostics
	 * layer, mirroring {@link setPublishedCellsProvider}. When unset, every report is a no-op (the
	 * render/edit paths are unconditional).
	 */
	static setDiagnosticsSink(sink: CellDiagnosticsSink | undefined): void {
		diagnosticsSink = sink;
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
	 * **Sheet-tabs (2026-06-10)** -- the workbook's live sheet list `{id,name}` in display order,
	 * captured from the workbook snapshot on each `render()` and pushed to the webview's bottom tab
	 * strip in the `render` message (alongside the active sheet id). `undefined` before the first
	 * render. The `webviewReady` re-send reuses it so the strip repaints on a reload.
	 */
	private latestSheets: Array<{ id: number; name: string }> | undefined;

	/**
	 * **FE-1.5 W-G-2b (2026-06-08)** -- the latest grid selection the webview reported, or `undefined`
	 * until the first `selection` message. Stored (last-wins) by the {@link DispatchDeps.onSelectionChange}
	 * arm; surfaced via the static {@link CellGridPanel.focusedGridSelection}. The dispatcher validated
	 * `selection.sheet === this.sheet` + integer/in-extent coords before this is set.
	 */
	private latestSelection: GridSelection | undefined;

	/**
	 * **W3 frozen panes (2026-06-09)** -- the session-local freeze state (N pinned leading rows + cols) this
	 * panel last applied, mirrored host-side ONLY so a webview reload re-applies it (the bundle's freeze is
	 * cleared on reload). The webview is the authority for the PAINT (it clamps these to `[0, MAX-1]`); the
	 * host just remembers + re-posts. DISK persistence of the freeze is deferred (a `.qbook` sidecar later) --
	 * this is the in-memory session-local v1 the brief scopes. `0/0` = no freeze (the default).
	 */
	private frozenRowCount: number = 0;
	private frozenColCount: number = 0;

	/**
	 * **W3 (Wave 3, 2026-06-09; Codex HIGH-2)** -- this panel's current webview instance token, learned from
	 * the `webviewReady` handshake. Used to maintain the module {@link byWebviewToken} map (set on handshake,
	 * cleared on dispose / re-handshake) so the context menu's host commands route to THIS exact panel.
	 * `undefined` before the first handshake.
	 */
	private webviewToken: string | undefined;

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
		// Sheet-tabs refactor (2026-06-10): MUTABLE -- the bottom tab strip switches the active
		// sheet in place via `switchToSheet`. Every reader (render, the dispatch deps, the `target`
		// getter, focusedGridSelection) reads it fresh, so they always reflect the active sheet.
		private sheet: number,
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
		// Sheet-tabs (2026-06-10): capture the workbook's live sheet list (display order, {id,name})
		// for the bottom tab strip. `wbSnapshot.sheets` is already in `sheet_display_order` and
		// excludes tombstoned sheets, so the strip renders exactly the live tabs in order.
		this.latestSheets = wbSnapshot.sheets.map(s => ({ id: s.id, name: s.name }));
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
		// W2 error-surface: mirror this sheet's CURRENT stored cell errors (the diagnostic-decorated
		// snapshot's `kind:'error'` cells) into the Problems panel. Authoritative + auto-clearing: a cell
		// that recovered to a real value is no longer an error entry, so the bridge replaces this sheet's
		// diagnostics without it (No-Fallbacks -- no stale Problems entry). A no-op when no bridge is wired.
		diagnosticsSink?.setSheetCellDiagnostics(this.session, this.sheet, decorated);
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
		// W-G bound-cell indicator: query the cells this session's published variables drive on THIS sheet
		// fresh on every post (covers both render() and the webviewReady re-send -- no stale-on-reload
		// issue, unlike the webview->host selection). `[]` when no reactive kernel is wired to the session.
		const publishedCells = publishedCellsProvider?.(this.session, this.sheet) ?? [];
		// Sheet-tabs (2026-06-10): carry the live sheet list + the active sheet id so the webview's
		// bottom tab strip can render the tabs and highlight the active one. The snapshot already
		// determines "sheet changed" (the webview resets on `snapshot.sheet` change); these fields
		// are purely for the strip. `?? []` keeps the payload well-formed before the first render.
		this.panel.webview.postMessage({
			type: 'render',
			snapshot: this.latestSnapshot,
			publishedCells,
			sheets: this.latestSheets ?? [],
			activeSheet: this.sheet,
		}).then(
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
	 * **W3 frozen panes (2026-06-09)** -- set this panel's freeze (N pinned leading rows + cols) and push it
	 * to the bundled webview. Stores the counts session-locally (mirrored so a reload re-applies them via
	 * `postFreezeIfReady` in the `webviewReady` handshake) and posts a `{type:'freeze', rows, cols}` message.
	 * The webview clamps the counts to `[0, MAX-1]` and full-redraws. `setFrozenPanes(0,0)` is Unfreeze.
	 * Throws on a non-finite count (the caller validates first; this is a defensive No-Fallbacks guard).
	 */
	setFrozenPanes(rows: number, cols: number): void {
		if (!Number.isFinite(rows) || !Number.isFinite(cols)) {
			throw new Error(`setFrozenPanes requires finite counts (got rows=${rows}, cols=${cols})`);
		}
		this.frozenRowCount = Math.max(0, Math.floor(rows));
		this.frozenColCount = Math.max(0, Math.floor(cols));
		this.postFreezeIfReady();
	}

	/**
	 * Post the stored freeze state to the bundled webview IFF the `webviewReady` handshake completed and the
	 * panel is live. Called by {@link setFrozenPanes} and on the `webviewReady` handshake (so a reload
	 * re-applies the session-local freeze). A non-delivery is surfaced LOUD (No-Fallbacks): the grid would
	 * show the wrong freeze otherwise. A no-op `0/0` re-send on a fresh load is harmless (the webview starts
	 * unfrozen anyway).
	 */
	private postFreezeIfReady(): void {
		if (!this.webviewReady || this._disposed) {
			return;
		}
		this.panel.webview.postMessage({ type: 'freeze', rows: this.frozenRowCount, cols: this.frozenColCount }).then(
			delivered => {
				if (!delivered && !this._disposed) {
					console.warn('[cellGrid] freeze postMessage was not delivered to the webview.');
					void vscode.window.showWarningMessage(
						'Quantbook: the cell grid freeze may not have applied (a message was not delivered). '
						+ 'Re-run "Quantbook: Freeze Panes at Selection" or reopen the grid.',
					);
				}
			},
			err => console.error('[cellGrid] freeze postMessage rejected:', err),
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
	 * **Sheet-tabs (2026-06-10)** -- switch this panel's ACTIVE sheet IN PLACE (the bottom tab strip
	 * / the Switch-Sheet command, via {@link show}). No-op if already on `sheetId`. Validates the id
	 * is a LIVE sheet of this workbook (No-Fallbacks -- a stale click on a just-deleted tab throws
	 * rather than stranding the panel on a tombstone), resets the per-sheet transient host state, then
	 * re-renders. The webview detects `snapshot.sheet` changed and resets its own selection/scroll to A1.
	 *
	 * `eventCursor` is INTENTIONALLY kept: the session event ring is workbook-scoped + append-only, so
	 * rewinding it would re-fold old diagnostics. `accumulatedDiagnostics` (the per-render fold) is what
	 * clears so the new sheet starts clean. Freeze resets on switch (v1; per-sheet freeze memory -> v2).
	 */
	switchToSheet(sheetId: number): void {
		if (sheetId === this.sheet) {
			return;
		}
		const live = this.session.listSheets();
		if (!live.some(s => s.id === sheetId)) {
			throw new Error(`Cannot switch to sheet ${sheetId}: it is not a live sheet of this workbook.`);
		}
		this.sheet = sheetId;
		// Reset per-sheet transient host state so the new sheet starts clean (no stale-state leak --
		// the UI-state analog of the corruption class: diagnostics fold, reported selection, the
		// one-time deleted-sheet warning, and the frozen panes).
		this.accumulatedDiagnostics.clear();
		this.latestSelection = undefined;
		this.deletedSheetWarned = false;
		this.frozenRowCount = 0;
		this.frozenColCount = 0;
		this.render();
		// Re-post the (now-cleared) freeze so the webview unfreezes for the new sheet.
		this.postFreezeIfReady();
		// The focused workbook's active sheet changed -> the dep-graph / Live-Python sidebars re-read.
		if (focusedPanel === this) {
			fireGridsChanged();
		}
	}

	/**
	 * **Sheet-tabs (2026-06-10)** -- handle a sheet-management action raised from the bottom tab strip:
	 * `+` (add), or right-click / double-click `rename` / `delete` / `moveLeft` / `moveRight` on a
	 * specific tab. Acts on the SPECIFIED `sheet` directly (the strip already identified it -- no
	 * QuickPick), reusing the owning Session's sheet napi + the palette commands' validation rules.
	 * Errors surface LOUD (No-Fallbacks). The QuickPick-based palette commands remain for keyboard access.
	 */
	private async handleSheetCommand(command: string, sheet: number | undefined): Promise<void> {
		try {
			if (command === 'add') {
				const name = await vscode.window.showInputBox({
					title: 'Add Quantbook Sheet',
					prompt: 'Enter a name for the new sheet',
					placeHolder: 'e.g., "Q4 Returns" or "Sheet3"',
					validateInput: (value) => (value.trim() === '' ? 'Sheet name cannot be empty' : null),
				});
				if (name === undefined) {
					return;
				}
				const newId = this.session.addSheet(name.trim(), 1000);
				this.switchToSheet(newId); // D6: adding a sheet switches to it (Excel behavior).
				return;
			}
			if (command !== 'rename' && command !== 'delete' && command !== 'moveLeft' && command !== 'moveRight') {
				// No-Fallbacks: an off-whitelist command string from the strip is surfaced (console + toast),
				// never a silent fall-through -- mirroring handleToolbarCommand's off-whitelist rejection.
				// Checked BEFORE the sheet guard so an unknown command without a sheet is loud too.
				console.warn(`[cellGrid] Quantbook sheet command ignored: unsupported command "${command}"`);
				void vscode.window.showWarningMessage(`Quantbook sheet command ignored: unsupported command "${command}".`);
				return;
			}
			if (sheet === undefined) {
				return;
			}
			if (command === 'rename') {
				const current = this.latestSheets?.find(s => s.id === sheet)?.name ?? '';
				const newName = await vscode.window.showInputBox({
					title: `Rename Sheet ${sheet}`,
					prompt: `Enter a new name for sheet ${sheet}`,
					value: current,
					validateInput: (value) => {
						if (value.trim() === '') {
							return 'Sheet name cannot be empty';
						}
						if (value.trim() === current) {
							return 'New name is the same as the current name';
						}
						return null;
					},
				});
				if (newName === undefined) {
					return;
				}
				this.session.renameSheet(sheet, newName.trim());
				CellGridPanel.refreshSession(this.session);
				return;
			}
			if (command === 'delete') {
				const live = this.session.listSheets();
				if (live.length <= 1) {
					void vscode.window.showInformationMessage('Cannot delete the last sheet of a workbook.'); // D4
					return;
				}
				const name = live.find(s => s.id === sheet)?.name ?? String(sheet);
				const confirm = await vscode.window.showWarningMessage(
					`Delete sheet ${sheet} ("${name}")? It is tombstoned (cells preserved internally) but disappears from the grid.`,
					{ modal: true },
					'Delete',
				);
				if (confirm !== 'Delete') {
					return;
				}
				this.session.deleteSheet(sheet);
				if (sheet === this.sheet) {
					// Deleted the active sheet -> switch to the first survivor (the empty-tombstone render
					// path is the safety net if none remain, which the D4 guard above already prevents).
					const survivors = this.session.listSheets();
					if (survivors.length > 0) {
						this.switchToSheet(survivors[0].id);
						return;
					}
				}
				CellGridPanel.refreshSession(this.session);
				return;
			}
			if (command === 'moveLeft' || command === 'moveRight') {
				const order = this.session.listSheets().map(s => s.id);
				const idx = order.indexOf(sheet);
				if (idx < 0) {
					return;
				}
				// moveSheet(id, newIndex) removes the source then inserts at newIndex in the remaining
				// array, so one step left = idx-1, one step right = idx+1 (skip at the ends).
				const newIndex = command === 'moveLeft' ? idx - 1 : idx + 1;
				if (newIndex < 0 || newIndex >= order.length) {
					return;
				}
				this.session.moveSheet(sheet, newIndex);
				CellGridPanel.refreshSession(this.session);
				return;
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			void vscode.window.showErrorMessage(`Quantbook sheet ${command} failed: ${detail}`);
		}
	}

	/**
	 * **Demo-prep toolbar (2026-06-10)** -- handle a `{type:'toolbarCommand', command, preset?}` message
	 * from this panel's webview toolbar. The webview is UNTRUSTED input: the message is validated against
	 * the pure {@link parseToolbarCommandMessage} whitelists FIRST -- nothing off-whitelist reaches
	 * `executeCommand` (it is rejected LOUD: a console line + a warning toast, never silent, never
	 * executed). Three execution shapes:
	 * - `simple` (freeze/unfreeze, Save As, Open): fire the host command with NO argument. The freeze
	 *   commands act on the FOCUSED panel -- a toolbar click just focused this webview's panel, so they
	 *   target this grid; Save As / Open resolve their own target panel.
	 * - `structural` (the six insert/delete commands): fire the W3 context-menu host command with the
	 *   `{panelToken, selection}` argument it validates via `parseContextMenuArg`, built from THIS panel's
	 *   webview token + latest reported selection -- so the toolbar routes to this exact panel like the
	 *   right-click menu does (never the merely-focused one).
	 * - `setNumberFormat`: apply the preset directly via {@link applyToolbarNumberFormat} (no QuickPick).
	 * A missing token/selection (no interaction since open / mid-reload) is a clear "select a cell first"
	 * information message (loud, not silent), mirroring the palette commands' no-selection path.
	 */
	private handleToolbarCommand(raw: unknown): void {
		const parsed = parseToolbarCommandMessage(raw);
		if (parsed === undefined) {
			// No-Fallbacks: an off-whitelist command / malformed preset is surfaced, never dropped silently
			// (and never executed). JSON.stringify is safe here -- postMessage payloads are structured-clonable.
			console.warn(`[cellGrid] rejected toolbarCommand from the webview (off-whitelist command or malformed preset): ${JSON.stringify(raw)}`);
			void vscode.window.showWarningMessage('Quantbook: the grid toolbar sent an unrecognized command -- it was not executed.');
			return;
		}
		// executeCommand failures surface loud (No-Fallbacks). The target commands toast their own
		// engine/validation errors; this rejection handler catches the command-level failures they cannot
		// (an unregistered command id, a throw before their own try).
		const execute = (commandId: string, arg?: unknown): void => {
			const thenable = arg === undefined ? vscode.commands.executeCommand(commandId) : vscode.commands.executeCommand(commandId, arg);
			thenable.then(undefined, (err: unknown) => {
				const detail = err instanceof Error ? err.message : String(err);
				console.error(`[cellGrid] toolbar command ${commandId} failed: ${detail}`);
				void vscode.window.showErrorMessage(`Quantbook toolbar action failed: ${detail}`);
			});
		};
		if (parsed.kind === 'simple') {
			execute(parsed.commandId);
			return;
		}
		if (parsed.kind === 'structural') {
			if (this.webviewToken === undefined || this.latestSelection === undefined) {
				// No token (handshake not completed) or no selection reported yet -- the structural commands
				// need both to build the validated `{panelToken, selection}` argument. Loud, not silent.
				void vscode.window.showInformationMessage(
					'Select a cell in the Cell Grid first -- the toolbar insert/delete acts on the current selection.',
				);
				return;
			}
			const sel = this.latestSelection;
			// The exact ContextMenuArg shape parseContextMenuArg validates host-side (panelToken + the four
			// selection corners). Built from the dispatcher-validated latestSelection, so it always passes.
			execute(parsed.commandId, {
				panelToken: this.webviewToken,
				selection: { anchorRow: sel.anchorRow, anchorCol: sel.anchorCol, focusRow: sel.focusRow, focusCol: sel.focusCol },
			});
			return;
		}
		// parsed.kind === 'setNumberFormat'
		if (this.latestSelection === undefined) {
			void vscode.window.showInformationMessage(
				'Select one or more cells in the Cell Grid first -- the toolbar format applies to the current selection.',
			);
			return;
		}
		this.applyToolbarNumberFormat(parsed.preset, this.latestSelection);
	}

	/**
	 * **Demo-prep toolbar (2026-06-10)** -- apply a (non-Custom) number-format preset to THIS panel's
	 * session/sheet over the given selection rect: the core of the `quantlab.quantbookSetFormat` command
	 * without its QuickPick/Custom UI. Same discipline: registerFormat -> normalizeSelectionRect ->
	 * buildSetFormatOps -> ONE `session.batch` (one undo unit) -> recalcDirtyChecked -> refreshSession.
	 * `General` interns to the engine's built-in id 0 (clears the explicit format). Every throw surfaces
	 * as a toast (No-Fallbacks); a post-apply repaint failure warns that the grid may be STALE (the
	 * mutation landed), mirroring the structural commands' stale-render warning.
	 */
	private applyToolbarNumberFormat(preset: ToolbarFormatPreset, sel: GridSelection): void {
		const formatString = formatStringForPreset(preset);
		const appliedLabel = presetLabel(preset);
		// Best-effort context for the undo label / toast: the sheet NAME + A1 range. Throws loud if the
		// active sheet id is gone (a tombstoned-sheet race) -- surfacing the failure rather than silently
		// mis-labelling (same contract as the command's sheet-name resolve).
		let target: string;
		try {
			const found = this.session.listSheets().find(s => s.id === this.sheet);
			if (found === undefined) {
				throw new Error(`this grid has no live sheet with id ${this.sheet}`);
			}
			const labelRect = normalizeSelectionRect(sel.anchorRow, sel.anchorCol, sel.focusRow, sel.focusCol);
			target = formatRangeTarget(found.name, labelRect.startRow, labelRect.startCol, labelRect.endRow, labelRect.endCol);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[cellGrid] toolbar setNumberFormat sheet-name resolve failed: ${detail}`);
			void vscode.window.showErrorMessage(`Quantbook set format failed: ${detail}`);
			return;
		}
		const undoLabel = buildFormatUndoLabel(appliedLabel, target);
		let opSucceeded = false;
		try {
			const formatId = this.session.registerFormat(formatString);
			const rect = normalizeSelectionRect(sel.anchorRow, sel.anchorCol, sel.focusRow, sel.focusCol);
			const ops = buildSetFormatOps(this.sheet, rect, formatId);
			this.session.batch(ops, { undoLabel });
			recalcDirtyChecked(this.session);
			opSucceeded = true;
			void vscode.window.showInformationMessage(`${undoLabel}.`);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[cellGrid] toolbar setNumberFormat failed: ${detail}`);
			void vscode.window.showErrorMessage(`Quantbook set format failed: ${detail}`);
		}
		if (opSucceeded) {
			// Repaint in a SEPARATE try so a render failure is not misreported as a format failure: the
			// format DID apply; the on-screen grid may be stale (same split as the command path).
			try {
				const { failed } = CellGridPanel.refreshSession(this.session);
				if (failed > 0) {
					void vscode.window.showWarningMessage(`Quantbook: the format applied, but ${failed} panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid" or check the Quantbook output for details.`);
				}
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				console.error(`[cellGrid] refreshSession after toolbar setNumberFormat failed: ${detail}`);
				void vscode.window.showWarningMessage('Quantbook: the format applied, but the grid may be showing stale values (a repaint failed) -- run "Quantbook: Refresh Cell Grid".');
			}
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
			// **FE-1.5 W-G-2b (Codex MED)**: a reload re-inits the webview's selection to A1 and re-posts it
			// on the first redraw -- but until that arrives, a STALE pre-reload `latestSelection` would let
			// `focusedGridSelection()` return the wrong cell (binding the wrong cell for the N-2 flow). Clear
			// it on every `webviewReady` so the gap returns `undefined` (no selection yet) rather than a stale
			// one. No-op on the initial load (already undefined). The webview's `lastPostedSelectionKey` resets
			// on reload too, so the fresh A1 post is never deduped away.
			this.latestSelection = undefined;
			// W3 (Codex HIGH-2): record this webview's instance token so the context menu's host commands can
			// route to THIS exact panel. A reload re-handshakes with a fresh token: drop our PRIOR token's map
			// entry if it still points at us (a different panel may have already claimed the old string -- only
			// clear our own), then claim the new one. Validated to a non-empty string (No-Fallbacks: a missing
			// token leaves the map untouched rather than inserting an `undefined` key).
			const incomingToken = (raw as { webviewId?: unknown }).webviewId;
			if (typeof incomingToken === 'string' && incomingToken.length > 0) {
				if (this.webviewToken !== undefined && this.webviewToken !== incomingToken && byWebviewToken.get(this.webviewToken) === this) {
					byWebviewToken.delete(this.webviewToken);
				}
				this.webviewToken = incomingToken;
				byWebviewToken.set(incomingToken, this);
			}
			this.clearReadyWatchdog();
			this.postRenderIfReady();
			// W3 frozen panes: a reload re-inits the webview unfrozen; re-apply the session-local freeze so a
			// reload does not silently lose it. A no-op when nothing is frozen (0/0).
			this.postFreezeIfReady();
			return;
		}
		// Sheet-tabs (2026-06-10): intercept the bottom tab strip's messages BEFORE delegating --
		// `dispatchIncomingMessage` would log them as unknown types. `switchSheet` switches the active
		// sheet in place; `sheetCommand` runs an add/rename/delete/move-left/move-right on a tab.
		if (typeof raw === 'object' && raw !== null) {
			const m = raw as { type?: unknown; sheet?: unknown; command?: unknown };
			if (m.type === 'switchSheet' && typeof m.sheet === 'number') {
				try {
					this.switchToSheet(m.sheet);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					void vscode.window.showErrorMessage(`Quantbook switch sheet failed: ${detail}`);
				}
				return;
			}
			if (m.type === 'sheetCommand' && typeof m.command === 'string') {
				void this.handleSheetCommand(m.command, typeof m.sheet === 'number' ? m.sheet : undefined);
				return;
			}
			// Demo-prep toolbar (2026-06-10): intercept the webview toolbar's commands BEFORE delegating --
			// dispatchIncomingMessage would log them as unknown types. handleToolbarCommand validates the
			// UNTRUSTED payload against the pure parseToolbarCommandMessage whitelists; anything
			// off-whitelist is rejected LOUD (toast + console), never executed.
			if (m.type === 'toolbarCommand') {
				this.handleToolbarCommand(raw);
				return;
			}
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
			onAck: (commitId, webviewId) => {
				if (this._disposed) {
					return; // the editor is gone with the panel -- nothing to resolve
				}
				// megaudit (webview-instance token): echo the REQUEST's webviewId so a stale post-reload ack
				// (whose numeric commitId reset to 0 and could collide) can't resolve a fresh webview's editor.
				const ack: CommitResultMessage = { type: 'commitResult', commitId, ok: true, webviewId };
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
			// megaudit (webview-instance token, 2026-06-09): report a successful putCells (paste/fill)'s WRITTEN
			// cells to THIS panel's webview so it clears their error tints even when stored content did not
			// change. Echo the REQUEST's webviewId (a stale post-reload report can't clear a fresh webview) and
			// the sheet (a cross-sheet report is dropped). Panel-targeted only -- NOT a session fan-out.
			onCellsWritten: (sheet, cells, webviewId) => {
				// W2 error-surface: a paste/fill batch committed cleanly -> clear each written cell's sticky
				// `errorReply` diagnostic from the Problems panel. Done host-side regardless of `_disposed`
				// (the diagnostic is not webview-bound) and BEFORE the disposed early-return below.
				for (const c of cells) {
					diagnosticsSink?.clearCellErrorReply(this.session, sheet, c.row, c.col);
				}
				if (this._disposed) {
					return;
				}
				const msg: CellsWrittenMessage = { type: 'cellsWritten', sheet, cells, webviewId };
				this.panel.webview.postMessage(msg).then(
					delivered => {
						if (!delivered && !this._disposed) {
							// The write DID land (data is correct); only the tint-clear report didn't reach the
							// webview, so a stale error tint may linger until the next edit/render. Surface it
							// (No-Fallbacks) rather than hide it.
							console.warn('[cellGrid] cellsWritten was not delivered; a stale error tint may linger.');
						}
					},
					err => console.error('[cellGrid] cellsWritten postMessage rejected:', err),
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
			// **FE-1.5 W-G-2b**: store the validated selection (last-wins). Pure store -- no engine call,
			// no render; the dispatcher already guaranteed `sel.sheet === this.sheet`. Surfaced via the
			// static `focusedGridSelection()` for the "bind variable to selected cell" flow.
			//
			// **W3 B3 dep-graph**: a selection move on the FOCUSED panel changes the "focused cell" the
			// Dependencies sidebar reads, so fire the grids-changed signal too (its single "focused state may
			// have changed" pull event). Fire ONLY when (a) this is the focused panel and (b) the focus cell
			// actually moved -- so a redundant re-report (same cell) or a background panel's echo does not
			// churn the focused-cell view. The Live-Python sidebar keys off (session, sheet) which is
			// unchanged here, so its rebuild is idempotent (same nodes, a harmless re-render).
			onSelectionChange: sel => {
				const prev = this.latestSelection;
				this.latestSelection = sel;
				const focusMoved = prev === undefined || prev.focusRow !== sel.focusRow || prev.focusCol !== sel.focusCol;
				if (focusMoved && focusedPanel === this) {
					fireGridsChanged();
				}
			},
			// W2 error-surface: a single putValue committed cleanly -> clear that cell's sticky `errorReply`
			// diagnostic from the Problems panel. Host-side; the imminent onCommit render reconciles the
			// stored-error set. A no-op when no diagnostics bridge is wired.
			onCellCommitted: (sheet, row, col) => {
				diagnosticsSink?.clearCellErrorReply(this.session, sheet, row, col);
			},
			// **W2 formula intelligence (2026-06-09)**: post a formula-validation result back to THIS panel's
			// webview (the formula-bar inline error hint). Panel-targeted (NOT a session fan-out) -- it answers
			// exactly the requesting webview's debounced keystroke. A non-delivery is logged (the hint just
			// won't update); No-Fallbacks -- the result already carries `ok:false` + the engine error when the
			// validate threw, so a failed validate is surfaced in the webview, never hidden here.
			onValidateFormula: (result: ValidateFormulaResultMessage) => {
				if (this._disposed) {
					return;
				}
				this.panel.webview.postMessage(result).then(
					delivered => {
						if (!delivered && !this._disposed) {
							console.warn('[cellGrid] validateFormulaResult was not delivered to the webview.');
						}
					},
					err => console.error('[cellGrid] validateFormulaResult postMessage rejected:', err),
				);
			},
			// **W2 formula intelligence (2026-06-09)**: post the function catalog back for the completion
			// dropdown. Panel-targeted. A non-delivery means the dropdown stays empty (logged, not hidden).
			onListFunctions: (result: FunctionListMessage) => {
				if (this._disposed) {
					return;
				}
				this.panel.webview.postMessage(result).then(
					delivered => {
						if (!delivered && !this._disposed) {
							console.warn('[cellGrid] functionList was not delivered to the webview.');
						}
					},
					err => console.error('[cellGrid] functionList postMessage rejected:', err),
				);
			},
			onError: reply => {
				// W2 error-surface: an `errorReply` is an INPUT REJECTION (a putValue/formula that failed to
				// parse/bind) -- the cell was NOT written, so it is ABSENT from the snapshot and would never
				// surface via the render path. Record it as a STICKY cell diagnostic in the Problems panel
				// (cleared when the cell next commits cleanly via onCellCommitted/onCellsWritten, or its panel
				// disposes). Done on BOTH the live and disposed paths (the diagnostic is host-side, not
				// webview-bound). Codex MED: ONLY persist when the reply targets THIS panel's sheet -- a
				// defensive cross-sheet/malformed reply (the dispatcher already validates, but No-Fallbacks
				// keeps the guard) would otherwise create a Problems entry under a sheet no panel owns, which
				// `clearSheet(this.sheet)` could never clear. Such a reply still surfaces below as a toast.
				if (reply.sheet === this.sheet) {
					diagnosticsSink?.setCellErrorReply(this.session, reply.sheet, reply.row, reply.col, reply.code, reply.message);
				} else {
					// Codex re-audit MED: a cross-sheet reply is NOT persisted as a diagnostic (no panel owns
					// that sheet here), and the webview decoration below targets THIS sheet -- so the cross-sheet
					// error could be silently lost if the post is accepted but ignored. Surface it as a toast now
					// so it is never swallowed (No-Fallbacks), then RETURN: the decoration/ack path below is for
					// THIS sheet only, so there is nothing more to do for a cross-sheet reply (the return also
					// avoids the disposed-path double-toast Codex flagged). This is a defensive path (the
					// dispatcher already drops sheet-mismatched putValue requests before they reach onError).
					void vscode.window.showWarningMessage(
						`Cell Grid (sheet ${reply.sheet}, row ${reply.row}, col ${reply.col}): [${reply.code}] ${reply.message}`,
					);
					return;
				}
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
