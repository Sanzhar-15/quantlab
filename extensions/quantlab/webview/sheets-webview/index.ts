/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 (2026-06-03) -- bundled sheets webview entry: A1 spreadsheet grid.**
 *
 * Supersedes the FE-0b cell-LIST. The sheet snapshot (sparse populated cells) is painted as a real
 * A1 grid by {@link CanvasGridRenderer} (column-letter band, row-number gutter, corner, gridlines,
 * values, selection box); geometry comes from the pure `gridLayoutA1.ts`. ANY cell -- populated or
 * empty -- is selectable + editable (the host write path is coordinate-addressed, so editing an
 * empty cell creates it). Editing uses a DOM-overlay `<input>` positioned over the active cell.
 * Keyboard: arrows / Tab move the selection; type / F2 / Enter-while-editing drive editing.
 *
 * Layout: a scroller (`#sheets-viewport`, overflow:auto) holds an in-flow `#sheets-spacer` sized to
 * the FULL Excel extent (drives the native scrollbars), an absolute `<canvas>` transformed by the
 * scroll offset to overlay the viewport (redrawn on scroll), and an absolute `#sheets-edit-input` in
 * the scroller's CONTENT layer (so it tracks scroll naturally).
 *
 * **Paint paths** (FE-2-0 Phase 3): a scroll takes the blit fast path ({@link scrollRedraw} -> the
 * renderer's `drawScroll`); a commit `render` / failed `errorReply` damages only the changed A1 rows
 * (`diffSnapshotsA1` / `errorRowsFlippedA1` -> the renderer's `drawDamage`); nav / type / resize / theme
 * full-`redraw()`. The pure blit + damage math lives in `gridBlitA1.ts`; a full redraw is always the
 * correct fallback (taken whenever the pure math declines, or the scroll/size changed since last paint).
 *
 * Wire protocol (**FE-2-0 Phase 2 commit-token** added a per-commit ack; the host `cellGridPanel.ts` +
 * `cellGridLogic.ts` changed to match -- the webview's local message interfaces here MUST stay in sync):
 *   host -> webview: `{type:'render', snapshot}`,
 *                    `{type:'errorReply', sheet,row,col,code,message, commitId?, webviewId?}`,
 *                    `{type:'commitResult', commitId, ok:true, webviewId?}` (Phase 2 -- success ack to THIS panel).
 *   webview -> host: `{type:'putValue', sheet,row,col,rawInput, commitId?, webviewId?}` (Phase 2 -- the token),
 *                    `{type:'undo'}`, `{type:'redo'}`, `{type:'webviewReady'}` (once on load).
 *   `webviewId` (megaudit 2026-06-09) is this webview's per-load instance id, echoed by the host so a stale
 *   PRE-reload `commitResult`/`errorReply` is dropped (its reused commitId would otherwise hit a fresh edit).
 *   Resolution: a pending edit closes ONLY on a matching `commitResult`/`errorReply` (by commitId, same
 *   `webviewId`) or the commit-watchdog timeout -- NEVER on a bare `render` (so a sibling render can't false-ack).
 *
 * Side-effecting entry (no top-level exports) so the esm bundle loads via a classic `<script>`.
 */

import type { DiagnosticJson, FunctionMetadataJson, QuantbookCellSnapshot } from '../../src/quantbook/types';
import { clampDisplayString, formatCellValue } from './cellRender';
import {
	buildSignatureLabel,
	extractCompletionPrefix,
	filterFunctions,
	findSignatureContext,
	moveActiveIndex,
	type CompletionFunction,
	type CompletionItem,
} from './formulaIntel';
import { CanvasGridRenderer, type ActiveCell, type PublishedRange } from './canvasGrid';
import { staleTintKeysA1 } from './gridBlitA1';
import { pasteAreaMismatch, planFill, planPaste, type GridClipboard } from './clipboardLogic';
import { RenderOrchestrator, type RenderHost, type Viewport } from './renderOrchestrator';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	ROW_HEIGHT,
	cellContentRect,
	cellRefA1,
	colX,
	frozenColsWidth,
	frozenRowsHeight,
	hitTestViewportFrozen,
	isInExtent,
	publishedNameAt,
	type SelectionRect,
	rowY,
	scrollToReveal,
	selectionRect,
	totalContentHeight,
	totalContentWidth,
} from './gridLayoutA1';

/**
 * **FE-2-0 Phase 1 (C1-MED6, 2026-06-03)** -- client mirror of the host's `MAX_RAW_INPUT_LENGTH`
 * (`cellGrid/cellGridLogic.ts`, kept in sync). The host rejects an over-length `putValue.rawInput`,
 * but we block it BEFORE `postMessage` so a multi-MB payload is never serialized across the bridge
 * (a tampered/buggy editor). On hit we surface a visible error and keep the editor open for the user
 * to shorten -- No-Fallbacks: the bad input is rejected loudly, never silently truncated or dropped.
 */
const MAX_RAW_INPUT_LENGTH = 8192;

/** Minimal VS Code webview API surface (mirrors qviz-spec/index.ts). */
interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;

// host -> webview: `{ type: 'render', snapshot }` (the snapshot is validated by `isValidSnapshot`
// at the message boundary before it is applied -- see the message handler below).

/** host -> webview: a failed edit; decorate the offending cell. */
interface ErrorReplyMessage {
	readonly type: 'errorReply';
	readonly sheet: number;
	readonly row: number;
	readonly col: number;
	readonly code: string;
	readonly message: string;
	/** FE-2-0 Phase 2: the commitId of the failed putValue (echoed by the host), so we un-stick exactly
	 * the originating edit. Absent for a non-tokened error. */
	readonly commitId?: number;
	/** megaudit (webview-instance token, 2026-06-09): the originating webview's instance id (echoed by the
	 * host). A reply whose id is present-but != this webview's WEBVIEW_ID is a stale PRE-reload reply and is
	 * dropped before un-stick/tint (the numeric commitId resets on reload and could otherwise collide). */
	readonly webviewId?: string;
}

/** host -> the originating webview: success ack for a tokened commit (FE-2-0 Phase 2 commit-token). */
interface CommitResultMessage {
	readonly type: 'commitResult';
	readonly commitId: number;
	readonly ok: true;
	/** megaudit (webview-instance token, 2026-06-09): the originating webview's instance id (echoed); a
	 * present-but-mismatched id is a stale PRE-reload ack and is dropped before resolvePendingCommit. */
	readonly webviewId?: string;
}

/**
 * host -> the originating webview: the cells a SUCCESSFUL putCells (paste/fill) wrote (megaudit
 * webview-instance token, 2026-06-09). The webview clears each cell's error tint even when stored content
 * did not change. `webviewId` is echoed from the request so a stale post-reload report is dropped; `sheet`
 * scopes the clear to the current sheet. Only success produces this -- a failed putCells reports nothing.
 */
interface CellsWrittenMessage {
	readonly type: 'cellsWritten';
	readonly sheet: number;
	readonly cells: readonly { readonly row: number; readonly col: number }[];
	readonly webviewId?: string;
}

// Cache the VS Code API handle on `window`: acquireVsCodeApi() may be called at most ONCE per
// webview context and throws on a second call (the persistent webview could re-evaluate this bundle).
type SheetsWindow = Window & { __sheetsVscodeApi?: VSCodeApi };
const vscode: VSCodeApi = (window as SheetsWindow).__sheetsVscodeApi ?? acquireVsCodeApi();
(window as SheetsWindow).__sheetsVscodeApi = vscode;

// --- Persistent skeleton (built once). ---
const root = document.getElementById('sheets-root');
if (root === null) {
	throw new Error('sheets-webview: #sheets-root missing from DOM');
}
root.innerHTML =
	'<h2 id="sheets-title">Quantbook Cell Grid</h2>' +
	'<div class="meta" id="sheets-meta"></div>' +
	'<div class="sheets-error" id="sheets-error" role="alert" hidden></div>' +
	// W-G formula bar: a name box (the active cell's A1 ref) + a field showing that cell's UNDERLYING
	// content (a formula with its leading '=', or the raw literal) -- so selecting a computed cell reveals
	// its formula. W-G-1b: the field is EDITABLE -- focusing it enters an edit (the `readonly` attr is the
	// display-mode default; `beginEditFormula` clears it). Enter commits through the SAME commit machinery
	// as the in-cell editor (single writer); Esc reverts.
	'<div class="cell-grid-formula-bar" id="sheets-formula-bar">' +
	'<span class="cell-grid-name-box" id="sheets-name-box" title="Selected cell"></span>' +
	// W-G bound-cell name display: an always-visible chip naming the reactive variable that drives the
	// active cell (shown only when the active cell is a published target; `hidden` otherwise).
	'<span class="cell-grid-published-chip" id="sheets-published-chip" hidden></span>' +
	'<input id="sheets-formula-input" class="cell-grid-formula-input" type="text" readonly ' +
	'aria-label="Formula bar (selected cell contents)" spellcheck="false" autocomplete="off" ' +
	'autocorrect="off" autocapitalize="off" aria-autocomplete="list" aria-expanded="false" ' +
	'aria-controls="sheets-formula-suggest" />' +
	// W2 formula intelligence: the function-completion dropdown (populated + positioned in JS; hidden by
	// default). A listbox of candidate function names, keyboard-navigable; Enter/Tab inserts the name + '('.
	'<ul id="sheets-formula-suggest" class="cell-grid-formula-suggest" role="listbox" ' +
	'aria-label="Function suggestions" hidden></ul>' +
	'</div>' +
	// W2 formula intelligence: a subtle line UNDER the bar that shows either the inline validation error
	// (parse/bind diagnostic from the engine) or the signature hint (the function's parameter list when the
	// caret is inside FN(...) ). Hidden when there is nothing to show. role=status so a screen reader
	// announces a new validation message without stealing focus.
	'<div id="sheets-formula-hint" class="cell-grid-formula-hint" role="status" hidden></div>' +
	'<div class="cell-grid-viewport" id="sheets-viewport" tabindex="0">' +
	'<div id="sheets-spacer"></div>' +
	'<canvas id="sheets-canvas"></canvas>' +
	'<input id="sheets-edit-input" class="cell-edit-input" type="text" aria-label="Edit cell value" ' +
	'spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" hidden />' +
	'</div>';

const titleEl = document.getElementById('sheets-title') as HTMLElement;
const metaEl = document.getElementById('sheets-meta') as HTMLElement;
const errorEl = document.getElementById('sheets-error') as HTMLElement;
const nameBoxEl = document.getElementById('sheets-name-box') as HTMLElement;
const publishedChipEl = document.getElementById('sheets-published-chip') as HTMLElement;
const formulaInputEl = document.getElementById('sheets-formula-input') as HTMLInputElement;
const viewportEl = document.getElementById('sheets-viewport') as HTMLElement;
const spacerEl = document.getElementById('sheets-spacer') as HTMLElement;
const canvasEl = document.getElementById('sheets-canvas') as HTMLCanvasElement;
const inputEl = document.getElementById('sheets-edit-input') as HTMLInputElement;
// W2 formula intelligence: the completion dropdown (a <ul> listbox) + the hint line (validation error /
// signature). Both are part of the formula bar; populated + toggled by the formula-assist logic below.
const suggestEl = document.getElementById('sheets-formula-suggest') as HTMLUListElement;
const hintEl = document.getElementById('sheets-formula-hint') as HTMLElement;

/**
 * **FE-2-0 Phase 1 (C1-MED3 / C1-MED6, 2026-06-03; re-audit MED-4)** -- the visible in-webview error
 * banner. No-Fallbacks: a bad render / rejected edit is surfaced here (and `console.error`-ed for the
 * render case) -- never silently dropped, never an opaque throw that freezes the grid with no message.
 *
 * The banner has a SOURCE so a valid render cannot HIDE an active edit-validation error (re-audit
 * MED-4): a `'transient'` error (malformed render, un-editable oversize cell) is cleared by the next
 * valid render; an `'edit'` error (the open editor holds an over-length value) is cleared ONLY when
 * that editor resolves -- shortened below the cap, cancelled, or committed -- so a sibling render
 * repainting underneath the editor never masks the still-invalid pending input.
 */
type ErrorSource = 'transient' | 'edit';
let errorSource: ErrorSource | null = null;
function showError(message: string, source: ErrorSource): void {
	// Re-audit finding 4: an active 'edit' banner (the open editor holds an over-length value the user
	// must fix) outranks a 'transient' notice. A malformed render still gets `console.error`-ed at its
	// call site, but it must NOT overwrite the edit banner -- otherwise a later valid render's
	// `clearTransientError()` would clear it and hide the still-invalid pending edit (the MED-4 class).
	if (source === 'transient' && errorSource === 'edit') {
		return;
	}
	errorEl.textContent = message;
	errorEl.hidden = false;
	errorSource = source;
}
function clearError(): void {
	if (!errorEl.hidden) {
		errorEl.hidden = true;
		errorEl.textContent = '';
	}
	errorSource = null;
}
/** Clear only a `'transient'` banner (a valid render supersedes it); preserve an `'edit'` banner. */
function clearTransientError(): void {
	if (errorSource === 'transient') {
		clearError();
	}
}

const renderer = new CanvasGridRenderer(canvasEl);

let fullSnapshot: QuantbookCellSnapshot | null = null;
// "row,col" -> "[code] message" for cells whose last edit failed (errorReply). Map preserves the
// structured error text for the hover tooltip.
const errorCells = new Map<string, string>();
// **W-G bound-cell indicator**: the published-target ranges for THIS sheet (host->webview, on every
// `render`). Rebuilt + validated wholesale per render (the host sends the authoritative set), so a sheet
// switch or retraction is reflected without incremental bookkeeping. `publishedRangesKey` is a canonical
// digest used to detect a change between renders -- a change forces a FULL redraw (the damage fast path
// only repaints rows whose VALUE changed, so a stale-only retraction with no value move would otherwise
// not clear the badge). Threaded into every `renderer.draw*` call alongside `errorCells`.
let publishedRanges: PublishedRange[] = [];
let publishedRangesKey = '';
// **W-G copy/paste**: the internal grid clipboard (a copied/cut rectangle's underlying content). Set by
// Ctrl/Cmd+C (isCut=false) / Ctrl/Cmd+X (isCut=true), consumed by Ctrl/Cmd+V. `null` = nothing copied.
// Internal-only for v1 (no OS-clipboard interop); persists across renders + sheet switches like Excel.
let gridClipboard: GridClipboard | null = null;
// **W-G fill handle**: drag-to-fill state. `fillSource` is the selection rect captured at the start of a
// fill-handle drag (null = not dragging); `fillPreview` is the rect the fill will cover (source extended
// down/right under the pointer), painted as a dashed outline and passed to every renderer draw call.
// `fillSuppressClick` swallows the click that fires after a fill-drag pointerup (so it doesn't re-select).
let fillSource: SelectionRect | null = null;
let fillPreview: SelectionRect | null = null;
let fillSuppressClick = false;
// Click tolerance (CSS px) for grabbing the fill-handle square at the selection's bottom-right corner.
const FILL_HANDLE_HIT_PX = 5;
// The active (selected) cell -- the FOCUS of the selection. Starts at A1 (like Excel) so the grid
// always shows a selection. `active` is the editable/formula-bar cell; all single-cell logic keys off it.
let active: ActiveCell | null = { row: 0, col: 0 };
// **W-G-2a**: the selection ANCHOR -- the fixed corner of a multi-cell range (shift-click / shift-arrow
// set it; `active` is the moving focus). `null` means the selection is just the single `active` cell
// (today's behavior, unchanged). The range is `selectionRect(anchor, active)`. Edits/Delete/plain-click
// collapse it back to a single cell (range-aware editing is a later increment).
let anchor: ActiveCell | null = null;
// **W-G-2b**: the last selection envelope posted to the host (a `sheet:anchor:focus` key), or `null`
// before the first post. `postSelectionIfChanged` dedupes against this so content-only redraws (an
// `errorReply` realign onto the same cell, a render push that did not move the selection) don't spam
// the host. `null` initial value is read only inside `postSelectionIfChanged`, which is called from
// `redraw()` (well after module load), so there is no pre-init hazard (the W-G-1b lesson).
let lastPostedSelectionKey: string | null = null;

interface EditState {
	// **W-G-1b**: the live editor input + which surface it is. Editing runs in EITHER the in-cell overlay
	// (`inputEl`, positioned over the cell) OR the formula bar (`formulaInputEl`, the always-visible bar) --
	// never both (single-active-editor model). The shared commit machinery (`commitEdit`, the watchdog,
	// `resolvePendingCommit`, the `errorReply` un-stick) operates on `editEl` so there is ONE writer; only the
	// presentation (position/clip/hide vs readOnly-toggle) branches on `surface`.
	readonly editEl: HTMLInputElement;
	readonly surface: 'overlay' | 'formula';
	// **Audit MED-2 (2026-06-05)**: the sheet captured at edit-start. `commitEdit` posts to THIS sheet, not
	// the live `fullSnapshot.sheet`, so an edit can never be mis-targeted if the snapshot's sheet changes
	// while the editor is open (defensive -- a panel's sheet is fixed today, but this removes the coupling).
	readonly sheet: number;
	row: number;
	col: number;
	// The populated entry under the cell at edit-start (formula/value pre-fill); undefined for an empty cell.
	readonly entry?: QuantbookCellSnapshot['entries'][number];
	// **FE-2-0 polish (2026-06-05)**: the cell's PRE-edit content -- the baseline `blur` compares against to
	// commit (changed) vs cancel (unchanged). For F2/click this equals the prefill; for type-to-edit it is the
	// PRIOR content (NOT the injected char -- megaudit MED-1), or the {@link OVERSIZE_BASELINE} sentinel when
	// the prior content is over the editable cap (so it is never built/held).
	readonly initialValue: string;
	pendingCommit: boolean;
	// FE-2-0 Phase 2 (commit-token): the unique id of THIS in-flight commit, stamped by commitEdit and
	// echoed by the host in `commitResult` (success) / `errorReply` (failure). Replaces the FE megaudit
	// M8 (sheet,row,col) match -- a monotonic token can't collide, and (the HIGH this kills) a bare
	// `render` no longer resolves a pending edit, so a sibling-panel/refresh render can't falsely close
	// this editor. Undefined until commitEdit() fires.
	commitId?: number;
	// Where to move the selection once THIS commit's matching commitResult arrives (Enter=down, Tab=right).
	navAfterCommit?: { dr: number; dc: number };
	// **Megaudit (B2, 2026-06-04)**: the rawInput value of the LAST commit that FAILED (set on a matching
	// `errorReply`). While the editor still holds exactly this string (the user hasn't edited it), a nav key
	// (arrow / Tab / Enter) ABANDONS the edit + navigates instead of re-posting the same failing value --
	// so the user can leave a known-bad cell with the keys they reach for, and Tab can never re-fail-loop.
	// Cleared on any real input edit (so "edited then typed back to the same string" still commits).
	lastFailedRawInput?: string;
	// **Megaudit re-audit (HIGH, 2026-06-04)**: the rawInput posted by the in-flight commit. After the
	// watchdog (or a malformed render) recovers a stalled commit and the user types a correction, a
	// genuinely-LATE success ack must NOT close the editor + discard that typing -- `resolvePendingCommit`
	// only honors a late ack when `editEl.value` still equals this submitted value.
	submittedRawInput?: string;
}
let editState: EditState | null = null;
// Seed the formula bar with the initial selection (A1, empty content) before the first render arrives.
// **W-G-1b**: this MUST run AFTER `editState` is initialized -- `updateFormulaBar` now reads `editState`,
// and esbuild down-levels the module-level `let` to a hoisted `var` (undefined until this point), so calling
// it earlier would hit `undefined.surface` (the `!== null` guard does not catch `undefined`).
updateFormulaBar();
// FE-2-0 Phase 2: monotonic source of per-commit ids for the single-cell editor commit token (never reused
// within a webview lifetime). Used ONLY by the editor `putValue` commit path; paste/fill (`putCells`) use the
// host-driven `cellsWritten` report below, not a commit token.
let nextCommitId = 0;
// megaudit (webview-instance token, 2026-06-09): a token minted ONCE per webview load (a NEW value after
// every reload). Stamped on `putCells` (paste/fill) AND `putValue` (the editor commit + the Delete-clear),
// and echoed back by the host in `cellsWritten` / `commitResult` / `errorReply`, so a stale reply from a
// PRE-reload op cannot clear a tint or resolve/un-stick a freshly-reloaded webview's editor (the numeric
// commitId / pending-ack token resets on reload and would otherwise collide with a fresh op). For putCells
// this REPLACES the prior webview-side pending-ack Map (which reset its numeric token on reload and was not
// sheet-scoped): the HOST now authoritatively lists the written cells + sheet on success. A FAILED op
// produces no success message, so a stale tint correctly stays (No-Fallbacks). Uniqueness (not
// cryptographic strength) is the only requirement.
const WEBVIEW_ID = 'wv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
// FE-2-0 Phase 2 (re-audit HIGH): a pending edit now resolves ONLY on a matching commitResult/errorReply
// -- a bare render no longer releases it. So a LOST/dropped/malformed completion would strand the editor
// forever (Escape/blur inert). This watchdog is the recovery net: if neither reply arrives in time, it
// surfaces the unknown status LOUD + un-sticks pendingCommit so Escape/blur/re-edit work again. Generous
// (10s >> any real local-engine round-trip) so it never false-fires on a slow-but-valid commit.
const COMMIT_WATCHDOG_MS = 10000;
let commitWatchdog: ReturnType<typeof setTimeout> | undefined;
function clearCommitWatchdog(): void {
	if (commitWatchdog !== undefined) {
		clearTimeout(commitWatchdog);
		commitWatchdog = undefined;
	}
}
function armCommitWatchdog(commitId: number): void {
	clearCommitWatchdog();
	commitWatchdog = setTimeout(() => {
		commitWatchdog = undefined;
		// Only fire if THIS commit is still unresolved (a late reply may have already resolved it).
		if (editState !== null && editState.pendingCommit && editState.commitId === commitId) {
			editState.pendingCommit = false; // un-stick: re-arm Escape / blur / re-edit
			editState.navAfterCommit = undefined;
			editState.editEl.readOnly = false; // megaudit H1/MED: unlock + refocus so the user can act on the un-stuck editor
			editState.editEl.focus();
			showError(
				'The edit could not be confirmed by the host (no response). It may or may not have been ' +
				'saved -- check the cell value, then press Escape or re-enter it.',
				'transient',
			);
			redraw();
		}
	}, COMMIT_WATCHDOG_MS);
}

// --- Viewport / draw ---

// FE-2 BAKEOFF (2026-06-09): the scroll/damage/full-redraw decision is now in the DOM-free shared
// `RenderOrchestrator` (so a benchmark can drive the REAL paint path + a unit test can drive it with a
// fake renderer). `Viewport` + the `prevPaint`/`scrollStateNow`/`scrollUnchangedSince` machinery moved
// THERE; this file keeps only the live DOM seam below (the `RenderHost`). Behavior is byte-identical.
function currentViewport(): Viewport {
	return {
		scrollTop: viewportEl.scrollTop,
		scrollLeft: viewportEl.scrollLeft,
		cssW: viewportEl.clientWidth,
		cssH: viewportEl.clientHeight,
	};
}
/** Pin the absolute canvas over the viewport at the current scroll (the content scrolls under it). */
function applyCanvasTransform(scrollTop: number, scrollLeft: number): void {
	canvasEl.style.transform = 'translate(' + scrollLeft + 'px, ' + scrollTop + 'px)';
}

// FE-2 BAKEOFF: the shared orchestrator instance for THIS webview. It OWNS `prevPaint` (the only paint
// state both fast paths read+write); every other input arrives live through the `RenderHost` getters
// below + the DOM side effects through its callbacks, so the module-level `let` bindings (fullSnapshot,
// active, anchor, publishedRanges, errorCells, fillPreview) stay owned HERE. The host is built once;
// its getters/callbacks close over those bindings, so each call sees the current value -- identical to
// the old in-place closures. `redraw`/`scrollRedraw` below are thin shims onto the orchestrator (kept so
// the ~30 existing call sites in this file are untouched).
const renderHost: RenderHost = {
	renderer,
	errorCells,
	viewport: currentViewport,
	active: () => active,
	selection: currentSelection,
	publishedRanges: () => publishedRanges,
	fillPreview: () => fillPreview,
	// W3 frozen panes: the renderer is the single source of truth for the (clamped) frozen counts; the
	// orchestrator's blit gate reads them through here. `setFrozen` clamped them, so these are always sane.
	frozenRowCount: () => renderer.frozenRows,
	frozenColCount: () => renderer.frozenCols,
	applyCanvasTransform,
	onAfterFullRedraw: () => {
		updateFormulaBar(); // selection/content changed -> reflect the active cell in the formula bar
		postSelectionIfChanged(); // W-G-2b: report the selection to the host (deduped)
		scheduleHoverTitle(); // W-G name display: a publish retraction repaints here -> refresh the stale hover title
	},
	onAfterScroll: () => {
		scheduleHoverTitle(); // W-G name display: a scroll moves a new cell under a stationary pointer -> refresh the hover title
	},
	onAfterDamage: () => {
		updateFormulaBar();
	},
};
const orchestrator = new RenderOrchestrator(renderHost);

/** Size the in-flow spacer to the full Excel extent (drives the native scrollbars). */
function updateSpacer(): void {
	spacerEl.style.height = totalContentHeight() + 'px';
	spacerEl.style.width = totalContentWidth(renderer.gutterWidthPx) + 'px';
}

/** Full redraw at the current viewport -- the always-correct paint path AND the fallback for both fast
 * paths (nav / type / resize / theme / first paint / any declined fast path route here). FE-2 BAKEOFF:
 * a thin shim onto the shared {@link RenderOrchestrator}, which paints + writes prevPaint and fires the
 * `onAfterFullRedraw` host callback (the formula-bar / selection-post / hover-title triplet). */
function redraw(): void {
	orchestrator.redraw();
}

/**
 * **W-G-2b** -- report the current selection to the host as a `{type:'selection',...}` envelope so the
 * host can track the focused grid's selection (the hook the "bind variable to selected cell" flow
 * consumes). `redraw()` is the single funnel for every focus/anchor change, so calling this there
 * catches them all; the dedupe (against {@link lastPostedSelectionKey}) makes content-only redraws
 * (e.g. an `errorReply` realign onto the same cell) no-ops. The anchor coords collapse to the focus
 * when there is no range, so the host always receives a well-formed rect. No-op until the first
 * snapshot + an active cell exist.
 */
function postSelectionIfChanged(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	const anc = anchor ?? active;
	const key = `${fullSnapshot.sheet}:${anc.row},${anc.col}:${active.row},${active.col}`;
	if (key === lastPostedSelectionKey) {
		return;
	}
	lastPostedSelectionKey = key;
	vscode.postMessage({
		type: 'selection',
		sheet: fullSnapshot.sheet,
		anchorRow: anc.row,
		anchorCol: anc.col,
		focusRow: active.row,
		focusCol: active.col,
	});
}

/**
 * **FE-2-0 Phase 3** -- the scroll fast path: blit the overlap of a pure-axis scroll + repaint only the
 * exposed strip, falling back to a full {@link redraw} whenever the pure math declines (no prior frame,
 * resize/dpr change, diagonal or sub-device-pixel move, or too little reusable area). ONLY the scroll
 * handler calls this: a scroll changes neither the snapshot nor the active cell nor errorCells, so the
 * blitted (shifted) pixels stay correct -- any path that changes content/selection must full-`redraw()`.
 * FE-2 BAKEOFF: a thin shim onto the shared {@link RenderOrchestrator} (the blit/draw decision + the
 * prevPaint write + the `onAfterScroll` hover-title refresh live there now).
 */
function scrollRedraw(): void {
	orchestrator.scrollRedraw();
}

// FE megaudit L-b: coalesce high-frequency scroll events to ONE repaint per animation frame.
let redrawScheduled = false;
function scheduleRedraw(): void {
	if (redrawScheduled) {
		return;
	}
	redrawScheduled = true;
	requestAnimationFrame(() => {
		redrawScheduled = false;
		scrollRedraw();
	});
}

// --- Selection / navigation ---

function clampRow(r: number): number {
	return Math.max(0, Math.min(MAX_ROWS - 1, r));
}
function clampCol(c: number): number {
	return Math.max(0, Math.min(MAX_COLS - 1, c));
}

/** Scroll so the active cell is fully visible below the header band + right of the row gutter.
 * Audit C2-MED2: the tiny-viewport clamp (a viewport narrower/shorter than one cell would otherwise
 * park the cell under the sticky band) lives in the pure {@link scrollToReveal}.
 * **W3 frozen panes**: a cell INSIDE a frozen band is always on screen (pinned) -- never scroll that axis.
 * For a BODY cell, the effective band size = sticky band + the frozen-band pixels, so the cell reveals
 * BELOW/RIGHT of the frozen strip (not under it). With 0 frozen rows/cols this is the pre-W3 behaviour. */
function ensureActiveVisible(): void {
	if (active === null) {
		return;
	}
	const gutterW = renderer.gutterWidthPx;
	const fRows = renderer.frozenRows;
	const fCols = renderer.frozenCols;
	// Only scroll the column axis for a BODY column (a frozen column is always visible at its pinned X).
	if (active.col >= fCols) {
		viewportEl.scrollLeft = scrollToReveal(
			colX(active.col, gutterW),
			COL_WIDTH,
			gutterW + frozenColsWidth(fCols),
			viewportEl.scrollLeft,
			viewportEl.clientWidth,
		);
	}
	if (active.row >= fRows) {
		viewportEl.scrollTop = scrollToReveal(
			rowY(active.row),
			ROW_HEIGHT,
			HEADER_HEIGHT + frozenRowsHeight(fRows),
			viewportEl.scrollTop,
			viewportEl.clientHeight,
		);
	}
}

/** Move the selection by (dr,dc), scroll it into view, repaint. No-op while editing. A plain (non-shift)
 *  move COLLAPSES any range back to the single focus cell (W-G-2a). */
function moveActive(dr: number, dc: number): void {
	const base = active ?? { row: 0, col: 0 };
	anchor = null; // a plain move clears the range
	active = { row: clampRow(base.row + dr), col: clampCol(base.col + dc) };
	ensureActiveVisible();
	redraw();
}

/** Set the selection to an absolute (clamped) SINGLE cell + scroll it into view (used after a commit nav
 *  or a known-bad arrow-discard). W-G-2a: clears any anchor -- this is a single-cell landing, and a stale
 *  anchor set by a shift-click during a pending edit would otherwise resurrect as a range on the next
 *  redraw (Codex W-G-2a re-audit LOW). */
function setActiveClamped(row: number, col: number): void {
	anchor = null;
	active = { row: clampRow(row), col: clampCol(col) };
	ensureActiveVisible();
}

/** **Excel nav keys** -- jump the selection to an absolute (clamped) SINGLE cell, scroll it into view, and
 *  repaint. The absolute-landing counterpart of {@link moveActive} (which moves by a delta): Home / End /
 *  Ctrl+Home / Ctrl+End all land on a known cell rather than stepping. Collapses any range (clears the
 *  anchor, via {@link setActiveClamped}) -- these are single-cell landings, matching a plain arrow move. */
function jumpActive(row: number, col: number): void {
	setActiveClamped(row, col);
	redraw();
}

/** **Excel nav keys** -- the last USED cell from the current snapshot's extent: the intersection of the
 *  greatest populated row and the greatest populated column (Excel's Ctrl+End target). An empty / absent
 *  snapshot has no used cells, so this returns A1 `{row:0,col:0}`. Coordinates are clamped to the grid by
 *  the caller's {@link jumpActive}. Computed lazily on keypress (not cached) -- the snapshot can change on
 *  any render, and a stale extent would jump to the wrong cell. */
function usedExtent(): { row: number; col: number } {
	if (fullSnapshot === null || fullSnapshot.entries.length === 0) {
		return { row: 0, col: 0 };
	}
	let maxRow = 0;
	let maxCol = 0;
	for (const e of fullSnapshot.entries) {
		if (e.row > maxRow) {
			maxRow = e.row;
		}
		if (e.col > maxCol) {
			maxCol = e.col;
		}
	}
	return { row: maxRow, col: maxCol };
}

/** **Excel nav keys** -- the number of whole data rows currently visible below the sticky header, for
 *  PageUp / PageDown (which move the active cell by one screenful). At least 1 so a tiny viewport still
 *  advances by a cell rather than stalling. */
function visibleRowSpan(): number {
	const usable = viewportEl.clientHeight - HEADER_HEIGHT;
	return Math.max(1, Math.floor(usable / ROW_HEIGHT));
}

/** **W-G-2a** -- collapse any multi-cell range back to the single focus cell (clear the anchor). */
function collapseSelection(): void {
	anchor = null;
}

/** **W-G-2a** -- extend the selection by moving the FOCUS by (dr,dc), keeping (or establishing) the anchor
 *  at the cell the focus started from. Shift+Arrow drives this; the range is anchor..focus. */
function extendActive(dr: number, dc: number): void {
	const base = active ?? { row: 0, col: 0 };
	if (anchor === null) {
		anchor = base; // the focus's current cell becomes the fixed corner
	}
	active = { row: clampRow(base.row + dr), col: clampCol(base.col + dc) };
	ensureActiveVisible();
	redraw();
}

/** **W-G-2a** -- the current selection rect, or `null` for a single-cell selection. Passed to every
 *  renderer draw call; `null` keeps the single-cell paint path byte-identical to pre-W-G-2a. Returns
 *  `null` for a DEGENERATE range too (anchor === focus -- reachable via shift-click on the current cell
 *  or shift-arrow at a clamped boundary), so a no-op shift gesture never paints a 1-cell "range" box
 *  (Codex W-G-2a LOW). The anchor stays set, so a subsequent shift-extend still grows from it. */
function currentSelection(): SelectionRect | null {
	if (anchor === null || active === null) {
		return null;
	}
	if (anchor.row === active.row && anchor.col === active.col) {
		return null;
	}
	return selectionRect(anchor, active);
}

/**
 * **W-G copy/paste + fill** -- snapshot a grid rectangle's UNDERLYING content into a {@link GridClipboard}
 * (each cell's formula-with-`=` or literal, via {@link priorCellContent}). Shared by copy/cut (the
 * selection) and the fill handle (the drag source). Returns `null` if ANY cell is OVERSIZE: such a cell's
 * value is never materialized, so it cannot be copied -- and silently storing `''` would CLEAR the paste
 * target (No-Fallbacks: the caller surfaces a visible error instead, megaudit HIGH). `sheet` is recorded
 * so a cross-sheet cut clears the correct sheet.
 */
function readRectClipboard(top: number, left: number, rows: number, cols: number, isCut: boolean): GridClipboard | null {
	if (fullSnapshot === null) {
		return null;
	}
	const cells: { rawInput: string }[][] = [];
	for (let r = 0; r < rows; r += 1) {
		const rowCells: { rawInput: string }[] = [];
		for (let c = 0; c < cols; c += 1) {
			const pc = priorCellContent(renderer.entryAt(top + r, left + c));
			if (pc.oversize) {
				return null; // cannot copy an over-cap value (would otherwise silently clear the target)
			}
			rowCells.push({ rawInput: pc.text });
		}
		cells.push(rowCells);
	}
	return { sheet: fullSnapshot.sheet, top, left, rows, cols, cells, isCut };
}

function copyGridSelection(isCut: boolean): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	// A new copy/cut REPLACES whatever was on the internal clipboard, so clear it up front. Otherwise a
	// FAILED copy/cut (an over-cap cell -> readRectClipboard null) would leave a stale prior CUT live, and a
	// later paste would silently move that old source despite the "nothing was copied" message just shown --
	// data loss (No-Fallbacks: a failed op must not leave actionable stale state). (deep-audit HIGH)
	gridClipboard = null;
	const sel = currentSelection();
	const top = sel === null ? active.row : sel.minRow;
	const left = sel === null ? active.col : sel.minCol;
	const rows = sel === null ? 1 : sel.maxRow - sel.minRow + 1;
	const cols = sel === null ? 1 : sel.maxCol - sel.minCol + 1;
	const clip = readRectClipboard(top, left, rows, cols, isCut);
	if (clip === null) {
		showError('A cell in this selection is too large to copy; nothing was copied.', 'transient');
		return;
	}
	gridClipboard = clip;
}

/**
 * **W-G fill handle** -- the rect a fill drag will cover: the source extended in the DOMINANT axis (down
 * or right) to the dragged cell, growth-only (v1 does not fill up/left). A pure helper of the drag.
 */
function computeFillPreview(source: SelectionRect, dragRow: number, dragCol: number): SelectionRect {
	const downDist = Math.max(0, dragRow - source.maxRow);
	const rightDist = Math.max(0, dragCol - source.maxCol);
	if (downDist >= rightDist) {
		return { minRow: source.minRow, maxRow: source.maxRow + downDist, minCol: source.minCol, maxCol: source.maxCol };
	}
	return { minRow: source.minRow, maxRow: source.maxRow, minCol: source.minCol, maxCol: source.maxCol + rightDist };
}

/**
 * **W-G fill handle** -- on drag end, fill the extension cells (source replicated with relative-ref offset)
 * as ONE atomic `putCells` batch, then select the filled rect (Excel selects the result). No-op when the
 * preview did not extend past the source.
 */
// Returns true iff a fill was actually committed (a real extension). The caller suppresses the post-drag
// click ONLY when true, so a no-op handle tap (no extension) still selects the clicked cell (Lane C).
function applyFill(): boolean {
	if (fullSnapshot === null || fillSource === null || fillPreview === null) {
		return false;
	}
	const src = fillSource;
	const srcRows = src.maxRow - src.minRow + 1;
	const srcCols = src.maxCol - src.minCol + 1;
	const fillRows = fillPreview.maxRow - src.minRow + 1;
	const fillCols = fillPreview.maxCol - src.minCol + 1;
	if (fillRows <= srcRows && fillCols <= srcCols) {
		return false; // no extension
	}
	const clip = readRectClipboard(src.minRow, src.minCol, srcRows, srcCols, false);
	if (clip === null) {
		showError('A cell in the fill source is too large to fill; nothing was filled.', 'transient');
		return false;
	}
	const cells = planFill(clip, fillRows, fillCols);
	if (cells.length === 0) {
		return false;
	}
	vscode.postMessage({ type: 'putCells', sheet: fullSnapshot.sheet, cells, undoLabel: 'Fill', webviewId: WEBVIEW_ID });
	// Select the filled rect (anchor at the source top-left, focus at the extension's bottom-right).
	anchor = { row: src.minRow, col: src.minCol };
	active = { row: fillPreview.maxRow, col: fillPreview.maxCol };
	ensureActiveVisible();
	return true;
}

/**
 * **W-G copy/paste** -- paste {@link gridClipboard} into the current selection: {@link planPaste} computes
 * the (ref-translated) target writes, which are sent as ONE atomic `putCells` batch (a single undo unit;
 * the host validates extent + applies). A cut is consumed by its paste (move): the clipboard is cleared so
 * a second paste does not re-clear the -- now moved -- source. No-op when nothing is on the clipboard.
 */
function pasteGridClipboard(): void {
	if (fullSnapshot === null || active === null || gridClipboard === null) {
		return;
	}
	// megaudit HIGH: a CUT moves cells, clearing the SOURCE. The source clears are posted to the current
	// sheet's putCells, so a cross-sheet cut would clear the wrong sheet. Refuse it loudly (No-Fallbacks)
	// rather than corrupt the active sheet; a cross-sheet COPY is fine (it never clears the source).
	if (gridClipboard.isCut && gridClipboard.sheet !== fullSnapshot.sheet) {
		showError('Cut-paste across sheets is not supported yet -- copy instead, or paste on the source sheet.', 'transient');
		return;
	}
	const sel = currentSelection();
	const selTop = sel === null ? active.row : sel.minRow;
	const selLeft = sel === null ? active.col : sel.minCol;
	const selRows = sel === null ? 1 : sel.maxRow - sel.minRow + 1;
	const selCols = sel === null ? 1 : sel.maxCol - sel.minCol + 1;
	// megaudit Lane C: refuse a size-mismatched paste (a multi-cell block into a LARGER selection that is not a
	// whole multiple) instead of silently pasting a partial block (No-Fallbacks; Excel "areas not same size").
	if (pasteAreaMismatch(gridClipboard, selRows, selCols)) {
		showError('Cannot paste: the copy and paste areas are not the same size. Select a single cell, or a selection that is a whole multiple of the copied block.', 'transient');
		return;
	}
	const cells = planPaste(gridClipboard, selTop, selLeft, selRows, selCols);
	if (cells.length === 0) {
		return;
	}
	const undoLabel = gridClipboard.isCut ? 'Cut' : 'Paste';
	vscode.postMessage({ type: 'putCells', sheet: fullSnapshot.sheet, cells, undoLabel, webviewId: WEBVIEW_ID });
	if (gridClipboard.isCut) {
		gridClipboard = null;
	}
}

/** **Megaudit (B2)** -- the selection delta for a commit/nav key, or `null` for any other key. Enter and
 * Tab always carry a vector (they commit+move); the arrow keys carry one too, but the editor only ACTS on
 * an arrow when leaving a known-bad cell (see the input keydown handler) -- a normal edit keeps arrows as
 * text-caret movement. Escape is handled separately (cancel). */
function navVector(key: string, shift: boolean): { dr: number; dc: number } | null {
	switch (key) {
		case 'Enter':
			return { dr: 1, dc: 0 }; // Excel: Enter commits + moves down
		case 'Tab':
			return { dr: 0, dc: shift ? -1 : 1 }; // Tab right, Shift+Tab left
		case 'ArrowUp':
			return { dr: -1, dc: 0 };
		case 'ArrowDown':
			return { dr: 1, dc: 0 };
		case 'ArrowLeft':
			return { dr: 0, dc: -1 };
		case 'ArrowRight':
			return { dr: 0, dc: 1 };
		default:
			return null;
	}
}

/** Audit O2-MED3: clear the active cell (Delete/Backspace when NOT editing). The host classifies an
 * empty `rawInput` as `{ kind: 'blank' }` = clear (`cellGridLogic.classifyCellInput`), so this reuses
 * the coordinate-addressed putValue path -- no editState involved (we are not in an edit). */
function clearActiveCell(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	// FE-2-0 Phase 2: optimistically drop this cell's error tint. The blanket `errorCells.clear()` on
	// render is gone (errors are now per-cell), and a Delete carries no editor/commit-token to resolve --
	// so without this a Delete'd cell would keep a stale error tint. Clearing to blank is essentially
	// always valid; if it DOES fail, the host's `errorReply` re-decorates the cell (No-Fallbacks).
	// W-G-2a: Delete clears only the FOCUS cell this increment (range-aware clear is a later increment);
	// collapse any range so the UI doesn't imply a multi-cell clear happened.
	collapseSelection();
	errorCells.delete(active.row + ',' + active.col);
	// megaudit (webview-instance token): stamp WEBVIEW_ID so a stale post-reload errorReply for this Delete
	// (which carries no commitId, only a tint) is dropped by the errorReply guard instead of tinting a fresh cell.
	vscode.postMessage({ type: 'putValue', sheet: fullSnapshot.sheet, row: active.row, col: active.col, rawInput: '', webviewId: WEBVIEW_ID });
	redraw();
}

// --- Overlay editor ---

/** A sentinel `blur` baseline for an over-cap cell reached via type-to-edit. Its runtime value begins with a
 * NUL char (a `\u0000` escape in source, so the file stays plain text) -- a char an `<input>` cannot
 * produce -- so blur always treats the typed value as a CHANGE (and commits it). Used INSTEAD of the real
 * (possibly multi-MB) prior content so that string is never built or held (megaudit MED: keep the oversize
 * defense on the type-to-edit path). Worst case if somehow matched, blur reads "unchanged" and abandons --
 * benign. */
const OVERSIZE_BASELINE = '\u0000-oversize-prior-value';

/**
 * The cell's pre-edit content for {@link beginEdit}: the F2/click prefill AND the `blur` baseline.
 *
 * Returns `oversize:true` (with empty `text`) when the prior value exceeds {@link MAX_RAW_INPUT_LENGTH},
 * determined from the RAW formula/text length BEFORE concatenating/formatting -- so a multi-MB value is
 * NEVER materialized (re-audit HIGH-2 + megaudit MED: the editor cannot host such a value, and we must not
 * build or hold it). Pure; no DOM.
 */
function priorCellContent(entry: QuantbookCellSnapshot['entries'][number] | undefined): { text: string; oversize: boolean } {
	if (entry === undefined) {
		return { text: '', oversize: false };
	}
	if (typeof entry.formula === 'string') {
		// The engine stores formula text VERBATIM, which may or may not carry the leading '=' (the napi
		// putFormula example is "=SUM(...)"; a snapshot may also carry a bare "A1+1"). Emit exactly one '='
		// so neither the editor prefill nor the formula bar double-prefixes (Codex W-G MED). Measure the
		// DISPLAYED length first (startsWith is O(1)) so an over-cap formula is still flagged WITHOUT building
		// the concatenation.
		const hasEq = entry.formula.startsWith('=');
		const displayLen = hasEq ? entry.formula.length : entry.formula.length + 1;
		if (displayLen > MAX_RAW_INPUT_LENGTH) {
			return { text: '', oversize: true };
		}
		return { text: hasEq ? entry.formula : '=' + entry.formula, oversize: false };
	}
	// Only a `text` value can realistically be multi-MB; check its raw length before `formatCellValue` builds it.
	if (entry.value.kind === 'text' && entry.value.value.length > MAX_RAW_INPUT_LENGTH) {
		return { text: '', oversize: true };
	}
	const lit = formatCellValue(entry.value);
	if (lit.length > MAX_RAW_INPUT_LENGTH) {
		return { text: '', oversize: true }; // defensive: a pathological number/error projection
	}
	return { text: lit, oversize: false };
}

/**
 * **W-G bound-cell name display** -- show/hide the formula-bar chip naming the reactive variable that
 * drives the active cell. The driving name is read from {@link publishedRanges} (the host->webview
 * published set already carries it) via the pure {@link publishedNameAt}; `null` (no active cell, or the
 * active cell is not a published target) hides the chip. The displayed name + the explanatory title are
 * clamped (C1-HIGH2 cap discipline) so a pathological variable name can neither blow the chip layout nor
 * the native title. Called UNCONDITIONALLY from {@link updateFormulaBar} -- BEFORE its formula-edit /
 * null-active guards -- so the chip never goes stale (e.g. a render that retracts the active cell's
 * publish mid formula-edit still clears it; the chip is metadata, separate from the editable input).
 */
function refreshPublishedChip(): void {
	const name = active === null ? null : publishedNameAt(publishedRanges, active.row, active.col);
	if (name === null) {
		publishedChipEl.hidden = true;
		publishedChipEl.textContent = '';
		publishedChipEl.removeAttribute('title');
		publishedChipEl.removeAttribute('aria-label');
		return;
	}
	const label = clampDisplayString('Driven by reactive variable "' + name + '"');
	publishedChipEl.textContent = clampDisplayString(name);
	publishedChipEl.title = label;
	publishedChipEl.setAttribute('aria-label', label);
	publishedChipEl.hidden = false;
}

/**
 * W-G -- refresh the formula bar from the active cell: its A1 ref in the name box and its UNDERLYING
 * content (a formula with its leading '=' or the raw literal) in the read-only field, so a computed cell
 * reveals its formula. An over-cap value is shown as a placeholder, never materialized (the same oversize
 * discipline as {@link priorCellContent}). Called on every content/selection repaint (`redraw` + the damage
 * fast path); a pure scroll changes neither selection nor content, so the scroll path deliberately omits it.
 *
 * **W-G-1b**: while the formula bar IS the live editor, this is a no-op -- a `redraw()` mid-typing (e.g. an
 * `errorReply` realign) must NOT overwrite the value the user is editing. The active cell is fixed during a
 * formula edit, so the name box need not update either. On edit close, `cancelEdit` nulls `editState` first,
 * then calls this to restore the committed display value. The published-cell chip ({@link refreshPublishedChip})
 * is refreshed first, unconditionally -- it is metadata next to the bar, not the edited value, so it stays
 * correct even while the bar is the live editor.
 */
function updateFormulaBar(): void {
	refreshPublishedChip();
	if (editState !== null && editState.surface === 'formula') {
		return;
	}
	if (active === null) {
		nameBoxEl.textContent = '';
		formulaInputEl.value = '';
		return;
	}
	nameBoxEl.textContent = cellRefA1(active.row, active.col);
	const entry = fullSnapshot === null ? undefined : renderer.entryAt(active.row, active.col);
	const content = priorCellContent(entry);
	formulaInputEl.value = content.oversize ? '(value too large to display)' : content.text;
}

/** Open the editor over (row,col). `initialChar` (type-to-edit) replaces the cell content. */
function beginEdit(row: number, col: number, initialChar?: string): void {
	if (fullSnapshot === null) {
		return;
	}
	// FE megaudit M8: do NOT start a new edit while a commit is in flight.
	if (editState !== null && editState.pendingCommit) {
		return;
	}
	if (editState !== null) {
		cancelEdit();
	}
	// Select + reveal the cell on ANY entry point (click / F2 / type-to-edit). Megaudit MED-1 (re-audit):
	// this MUST happen BEFORE the oversize bail below -- a CLICK on an over-length cell still SELECTS it (the
	// editor just doesn't open). For F2/type the cell is already active, so this is a no-op there.
	// W-G-2a: editing is single-cell, so collapse any selection range to this focus cell.
	collapseSelection();
	active = { row, col };
	// Audit O2-MED2: F2 / type-to-edit on a scrolled-away active cell must bring it into view first,
	// otherwise the overlay editor opens off-screen (content-layer child positioned at the cell rect).
	ensureActiveVisible();
	const entry = renderer.entryAt(row, col);
	// The cell's content BEFORE this edit -- both the F2/click prefill AND the `blur` baseline.
	// Re-audit HIGH-2 + megaudit MED: a malformed/drifted snapshot can carry a multi-MB value/formula;
	// {@link priorCellContent} returns `oversize:true` WITHOUT building (or holding) that string -- it checks
	// the raw formula/text length first. F2/click on an oversize cell refuses to open the editor + surfaces a
	// visible error (No-Fallbacks); type-to-edit shows just the injected char with a sentinel blur baseline.
	const prior = priorCellContent(entry);
	if (initialChar === undefined && prior.oversize) {
		// F2 / click on an over-cap cell: refuse to OPEN the editor (the cell stays selected + revealed) and
		// surface a visible error -- No-Fallbacks: we never silently truncate the value.
		showError(
			`This cell's value is over the ${MAX_RAW_INPUT_LENGTH}-character editable limit, so it cannot be edited here.`,
			'transient',
		);
		return; // do NOT open the editor (the cell is selected + scrolled into view)
	}
	const prefill: string = initialChar !== undefined ? initialChar : prior.text;
	// The blur baseline. For an over-cap cell reached via type-to-edit we use a sentinel (the prior value is
	// never built/held); it can't equal any in-cap editor value, so blur correctly sees the typed char as a
	// change. Otherwise it is the real prior content (megaudit MED-1: NOT the injected char).
	const initialValue: string = prior.oversize ? OVERSIZE_BASELINE : prior.text;
	// W3 frozen panes (Codex HIGH-2): pin a frozen cell's editor (add back the frozen-axis scroll) so it stays
	// over its pinned cell; a body cell gets the plain content position (unchanged).
	const pos = overlayCellContentPos(row, col);
	inputEl.style.left = pos.left + 'px';
	inputEl.style.top = pos.top + 'px';
	inputEl.style.width = pos.width + 'px';
	inputEl.style.height = pos.height + 'px';
	inputEl.readOnly = false; // megaudit H1: a fresh editor is editable (a prior pending edit set readOnly)
	inputEl.value = prefill;
	inputEl.hidden = false;
	inputEl.style.clipPath = ''; // FE-2-0 polish: start unclipped; updateEditClip below sets it for this cell
	editState = { editEl: inputEl, surface: 'overlay', sheet: fullSnapshot.sheet, row, col, entry, initialValue, pendingCommit: false };
	updateEditClip(); // FE-2-0 polish: clip to the body pane (the cell may open partly under a sticky band)
	inputEl.focus();
	if (initialChar === undefined) {
		inputEl.select();
	}
	// NOTE: the call sites (click / F2 / type-to-edit) redraw() right after beginEdit to move the
	// selection box; beginEdit itself does not, to avoid a double paint.
}

function cancelEdit(): void {
	if (editState === null) {
		return;
	}
	const surface = editState.surface; // capture before nulling -- the teardown branch depends on it
	editState = null;
	if (surface === 'overlay') {
		inputEl.hidden = true;
		inputEl.value = '';
		inputEl.readOnly = false; // megaudit H1: clear the pending-commit lock so the next editor is editable
		inputEl.style.clipPath = ''; // FE-2-0 polish: drop any body-pane clip so a future editor starts clean
	} else {
		// W-G-1b formula bar: it is always visible (never hidden). Return it to display mode (readOnly) and
		// restore the committed content via updateFormulaBar -- editState is already null, so its
		// surface guard lets this write through. Do NOT clear/hide it.
		formulaInputEl.readOnly = true;
		// W2 formula intelligence: tear down the dropdown + hint + any pending validate (editState is already
		// nulled, so the assist functions' formulaBarIsEditing() guard reads false -- this is the explicit
		// cleanup). Done before updateFormulaBar so the bar returns to a clean display state.
		teardownFormulaAssist();
		updateFormulaBar();
	}
	clearCommitWatchdog(); // the editor is gone -- no pending commit to recover (re-audit HIGH)
	clearError(); // closing the editor resolves any 'edit'-source banner (re-audit MED-4)
}

/**
 * **W-G-1b** -- enter an edit in the FORMULA BAR (the single-active-editor model: the in-cell overlay stays
 * closed). Mirrors {@link beginEdit}'s FE-megaudit-M8 pending guard + the oversize refusal, but the bar is
 * always-visible, so there is no positioning / show -- it just flips `readOnly` off and becomes the live
 * `editEl`. The bar already shows the active cell's content (via {@link updateFormulaBar}), which is the blur
 * baseline. Triggered by focusing the bar (Excel: focusing the formula bar enters edit).
 */
function beginEditFormula(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	if (editState !== null && editState.surface === 'formula') {
		return; // already the live formula editor (a focus that never left)
	}
	if (editState !== null && editState.pendingCommit) {
		return; // FE megaudit M8: never start a new edit while a commit is in flight
	}
	if (editState !== null) {
		cancelEdit(); // an unchanged overlay edit still open -- close it before the bar takes over
	}
	// W-G-2a: editing the focus cell is single-cell; collapse any range first (repaint to clear the range
	// paint before the edit begins). A no-op when there is no range.
	if (anchor !== null) {
		collapseSelection();
		redraw();
	}
	const entry = renderer.entryAt(active.row, active.col);
	const prior = priorCellContent(entry);
	if (prior.oversize) {
		// Refuse to edit an over-cap value in the bar (No-Fallbacks: never silently truncate). The bar keeps
		// showing the '(value too large...)' placeholder and stays readOnly; the user can still copy it out.
		showError(
			`This cell's value is over the ${MAX_RAW_INPUT_LENGTH}-character editable limit, so it cannot be edited here.`,
			'transient',
		);
		return;
	}
	formulaInputEl.readOnly = false;
	editState = {
		editEl: formulaInputEl,
		surface: 'formula',
		sheet: fullSnapshot.sheet,
		row: active.row,
		col: active.col,
		entry,
		initialValue: prior.text, // the displayed content == the blur baseline (megaudit MED-1: the prior value)
		pendingCommit: false,
	};
	// W2 formula intelligence: the formula bar is now the live editor. Fetch the function catalog (once) for
	// the completion dropdown, and seed the validation + signature hint off the current content (e.g. opening
	// the bar on an already-invalid formula shows its diagnostic). No dropdown opens until the user types.
	ensureFunctionListRequested();
	scheduleValidate();
	updateSignatureHint();
}

// ============================================================================
// W2 formula intelligence (2026-06-09) -- lightweight assist on the formula bar.
//
// Three affordances, all driven by the pure `formulaIntel.ts` core, all scoped to the FORMULA BAR editor
// (`editState.surface === 'formula'`) so they never interfere with the in-cell overlay edit path:
//   1. an inline validation HINT (debounced `validateFormula` -> the engine's parse/bind diagnostics);
//   2. a function-completion DROPDOWN (`listFunctions` -> a prefix-filtered listbox; Enter/Tab inserts);
//   3. a signature HINT (the function's parameter list when the caret is inside `FN(`).
//
// The dropdown's keyboard handling is interleaved with the SHARED `onEditKeydown` (see the guard at the top
// of that handler): when the dropdown is OPEN, Up/Down/Enter/Tab/Esc drive the LIST (and are swallowed
// before the grid-nav / commit logic); when CLOSED, every key falls through to the existing edit machinery
// unchanged. This preserves Enter-commit-and-move, Esc-revert, Tab-nav, the single-active-editor model, the
// oversize refusal, and the reload-race guards.
// ============================================================================

/** The function catalog (built-ins + UDFs) fetched once from the host after the handshake; null until it
 * arrives. The completion dropdown shows NOTHING until this is populated (No-Fallbacks: no fabricated list). */
let functionCatalog: CompletionFunction[] | null = null;
/** Canonical-name -> metadata, for the signature hint (built alongside `functionCatalog`). */
let functionMetaByName: Map<string, FunctionMetadataJson> = new Map();
/** Set once so we don't spam `listFunctions` requests (one fetch is enough -- the catalog is session-stable). */
let functionListRequested = false;

/** The open completion dropdown's state, or null when closed. `items` is the filtered candidate list;
 * `activeIndex` is the highlighted row (-1 = none); `replaceStart`/`replaceEnd` are the [start,end) offsets
 * in the input value that an accepted completion REPLACES (the typed prefix). */
interface CompletionState {
	items: CompletionItem[];
	activeIndex: number;
	replaceStart: number;
	replaceEnd: number;
}
let completion: CompletionState | null = null;

/** How many completion candidates to render at once (an empty-prefix "show all" is capped to this). */
const MAX_COMPLETION_ITEMS = 50;

/** Debounce (ms) before a formula-bar keystroke triggers `validateFormula` -- keeps the engine off the
 * per-keystroke hot path while staying responsive. */
const VALIDATE_DEBOUNCE_MS = 250;
let validateTimer: ReturnType<typeof setTimeout> | undefined;
/** Monotonic per-request token: a debounced validate stamps the next id; only the reply whose id equals
 * `latestValidateReqId` is applied (a superseded in-flight validate is dropped -- the user kept typing). */
let nextValidateReqId = 0;
let latestValidateReqId = -1;
/** Monotonic token for the one-shot `listFunctions` request (matched in the reply to drop a stale answer). */
let nextFuncReqId = 0;
let latestFuncReqId = -1;

/** Is the formula bar the LIVE editor right now? All assist affordances are gated on this. */
function formulaBarIsEditing(): boolean {
	return editState !== null && editState.surface === 'formula';
}

/** Request the function catalog from the host (once). Called when the formula bar first enters edit -- by
 * then the channel + session are live. Idempotent. */
function ensureFunctionListRequested(): void {
	if (functionListRequested) {
		return;
	}
	functionListRequested = true;
	const reqId = ++nextFuncReqId;
	latestFuncReqId = reqId;
	vscode.postMessage({ type: 'listFunctions', reqId, webviewId: WEBVIEW_ID });
}

/** Close the completion dropdown (state + DOM + ARIA). Safe to call when already closed. */
function closeCompletion(): void {
	if (completion === null && suggestEl.hidden) {
		return;
	}
	completion = null;
	suggestEl.hidden = true;
	suggestEl.replaceChildren();
	formulaInputEl.setAttribute('aria-expanded', 'false');
	formulaInputEl.removeAttribute('aria-activedescendant');
}

/** Paint the dropdown from `completion` (assumed non-null). Renders each candidate as an <li role=option>;
 * the active row gets the `is-active` class + aria-selected. Positions the listbox under the input. */
function renderCompletion(): void {
	if (completion === null) {
		return;
	}
	suggestEl.replaceChildren();
	completion.items.forEach((item, idx) => {
		const li = document.createElement('li');
		li.className = 'cell-grid-suggest-item' + (idx === completion!.activeIndex ? ' is-active' : '');
		li.id = 'sheets-suggest-opt-' + idx;
		li.setAttribute('role', 'option');
		li.setAttribute('aria-selected', idx === completion!.activeIndex ? 'true' : 'false');
		// The matched name (canonical or the alias the user typed toward). A via-alias hit annotates the
		// canonical name so the user knows what it resolves to.
		const nameSpan = document.createElement('span');
		nameSpan.className = 'cell-grid-suggest-name';
		nameSpan.textContent = clampDisplayString(item.matchedName);
		li.appendChild(nameSpan);
		if (item.viaAlias) {
			const aliasNote = document.createElement('span');
			aliasNote.className = 'cell-grid-suggest-note';
			aliasNote.textContent = '= ' + clampDisplayString(item.fn.canonicalName);
			li.appendChild(aliasNote);
		}
		// mousedown (NOT click): fire BEFORE the input's blur so accepting a suggestion does not first
		// commit/cancel the edit via the blur handler. preventDefault keeps focus in the input.
		li.addEventListener('mousedown', ev => {
			ev.preventDefault();
			acceptCompletion(idx);
		});
		suggestEl.appendChild(li);
	});
	suggestEl.hidden = false;
	formulaInputEl.setAttribute('aria-expanded', 'true');
	if (completion.activeIndex >= 0) {
		formulaInputEl.setAttribute('aria-activedescendant', 'sheets-suggest-opt-' + completion.activeIndex);
	} else {
		formulaInputEl.removeAttribute('aria-activedescendant');
	}
}

/**
 * Recompute the completion dropdown from the live input value + caret. Opens/updates it when the caret is on
 * a function-name prefix (non-empty) AND the catalog has candidates; closes it otherwise. Pure decisions
 * (prefix extraction, filtering) come from `formulaIntel.ts`; this only does the DOM + state plumbing.
 *
 * `allowEmptyPrefix` (the explicit Ctrl+Space trigger) shows the full list right after `=`/`(`; the default
 * (typing) requires a >=1-char prefix so the dropdown does not pop on every `=`.
 */
function updateCompletion(allowEmptyPrefix: boolean): void {
	if (!formulaBarIsEditing() || functionCatalog === null) {
		closeCompletion();
		return;
	}
	const value = formulaInputEl.value;
	const caret = formulaInputEl.selectionStart ?? value.length;
	const ctx = extractCompletionPrefix(value, caret);
	if (ctx === null || (ctx.prefix.length === 0 && !allowEmptyPrefix)) {
		closeCompletion();
		return;
	}
	const items = filterFunctions(functionCatalog, ctx.prefix, MAX_COMPLETION_ITEMS);
	if (items.length === 0) {
		closeCompletion();
		return;
	}
	// Preserve the highlighted name across a filter narrowing when it survives; otherwise default to the
	// first item (the closest prefix match), matching editor type-ahead.
	let activeIndex = 0;
	if (completion !== null && completion.activeIndex >= 0 && completion.activeIndex < completion.items.length) {
		const prevName = completion.items[completion.activeIndex].matchedName;
		const found = items.findIndex(it => it.matchedName === prevName);
		if (found >= 0) {
			activeIndex = found;
		}
	}
	completion = { items, activeIndex, replaceStart: ctx.start, replaceEnd: ctx.end };
	renderCompletion();
}

/** Accept the completion at `idx`: replace the typed prefix with the function name + `(`, move the caret
 * inside the parens, close the dropdown, and refresh the validation + signature hint. */
function acceptCompletion(idx: number): void {
	if (completion === null || idx < 0 || idx >= completion.items.length || !formulaBarIsEditing()) {
		return;
	}
	const item = completion.items[idx];
	const value = formulaInputEl.value;
	const insert = item.matchedName + '(';
	const before = value.slice(0, completion.replaceStart);
	const after = value.slice(completion.replaceEnd);
	const next = before + insert + after;
	formulaInputEl.value = next;
	// Caret goes right after the inserted '(' so the user types args next (and the signature hint shows).
	const caret = before.length + insert.length;
	formulaInputEl.setSelectionRange(caret, caret);
	closeCompletion();
	formulaInputEl.focus();
	// The value changed structurally -> re-validate (debounced) + recompute the signature hint.
	scheduleValidate();
	updateSignatureHint();
}

/** Step the dropdown highlight (delta = -1 up / +1 down), wrapping. Re-renders only the affected rows' state
 * via a full repaint (the list is short). No-op when closed. */
function moveCompletion(delta: number): void {
	if (completion === null || completion.items.length === 0) {
		return;
	}
	completion.activeIndex = moveActiveIndex(completion.activeIndex, delta, completion.items.length);
	renderCompletion();
	scrollActiveCompletionIntoView();
}

/** Keep the highlighted dropdown row visible when navigating a long list. */
function scrollActiveCompletionIntoView(): void {
	if (completion === null || completion.activeIndex < 0) {
		return;
	}
	const el = document.getElementById('sheets-suggest-opt-' + completion.activeIndex);
	el?.scrollIntoView({ block: 'nearest' });
}

// --- The validation + signature hint line (shared #sheets-formula-hint, error takes priority) ---

/** The current inline validation message (engine diagnostic), or '' when valid / not validated. */
let validationMessage = '';
/** Is the current hint an ERROR (vs the neutral signature)? Drives the styling + priority. */
let validationIsError = false;

/** Render the hint line: the validation error (if any) takes priority; otherwise the signature hint (if the
 * caret is inside a known FN(). Hidden when there is nothing to show. */
function renderHint(): void {
	if (!formulaBarIsEditing()) {
		hintEl.hidden = true;
		hintEl.textContent = '';
		hintEl.classList.remove('is-error');
		return;
	}
	if (validationMessage.length > 0) {
		hintEl.textContent = clampDisplayString(validationMessage);
		hintEl.classList.toggle('is-error', validationIsError);
		hintEl.hidden = false;
		return;
	}
	const sig = currentSignatureText();
	if (sig.length > 0) {
		hintEl.textContent = clampDisplayString(sig);
		hintEl.classList.remove('is-error');
		hintEl.hidden = false;
		return;
	}
	hintEl.hidden = true;
	hintEl.textContent = '';
	hintEl.classList.remove('is-error');
}

/** Build the signature hint text for the caret's enclosing FN(, or '' when there is none / the function is
 * unknown to the catalog. The current argument (by comma index) is wrapped in brackets for emphasis. */
function currentSignatureText(): string {
	if (functionCatalog === null) {
		return '';
	}
	const value = formulaInputEl.value;
	const caret = formulaInputEl.selectionStart ?? value.length;
	const ctx = findSignatureContext(value, caret);
	if (ctx === null) {
		return '';
	}
	const meta = functionMetaByName.get(ctx.name.toUpperCase());
	if (meta === undefined) {
		return ''; // an unknown name (typo / a name not yet typed in full) -- no signature to show
	}
	const label = buildSignatureLabel(meta.canonicalName, meta.arity);
	const parts = label.params.map((p, i) => (i === ctx.argIndex ? '[' + p + ']' : p));
	if (label.unbounded) {
		// Mark the variadic tail; if the caret is past the listed params, emphasize the trailing '...'.
		const tail = ctx.argIndex >= label.params.length ? '[...]' : '...';
		parts.push(tail);
	}
	return label.name + '(' + parts.join(', ') + ')';
}

/** Recompute + render the signature hint (only meaningful while the formula bar is editing). */
function updateSignatureHint(): void {
	renderHint();
}

/**
 * **Codex HIGH fold**: invalidate any IN-FLIGHT validate request. `latestValidateReqId` is the ONLY id a
 * reply may match (the message arm drops `reqId !== latestValidateReqId`); resetting it to a sentinel that
 * no real reqId equals (-1, while all minted ids are >= 0) means a reply for superseded text is dropped on
 * arrival. Previously the id only advanced inside the debounce timer, so an already-SENT request's reply
 * could still apply after the user edited to a literal / committed / switched sheets before the next
 * keystroke re-scheduled. Also clears the pending timer so a queued send never fires for stale text.
 */
function invalidateValidate(): void {
	if (validateTimer !== undefined) {
		clearTimeout(validateTimer);
		validateTimer = undefined;
	}
	latestValidateReqId = -1;
}

/** Schedule a debounced `validateFormula`. Only fires while the formula bar is the live editor and the
 * value is a formula (`=`-prefixed); a literal value has nothing to validate -> clear any prior message.
 * Codex HIGH fold: every entry point first INVALIDATES any in-flight validate (so a superseded reply is
 * dropped), then re-schedules only when the value is a formula. */
function scheduleValidate(): void {
	invalidateValidate();
	if (!formulaBarIsEditing()) {
		return;
	}
	const value = formulaInputEl.value;
	if (!value.trimStart().startsWith('=')) {
		// A literal value: no formula to validate. Clear any stale error so the hint reflects reality.
		clearValidation();
		return;
	}
	validateTimer = setTimeout(() => {
		validateTimer = undefined;
		if (!formulaBarIsEditing() || editState === null) {
			return;
		}
		const text = formulaInputEl.value;
		if (!text.trimStart().startsWith('=')) {
			clearValidation();
			return;
		}
		// The engine wants the formula BODY without the leading '=' (engine convention). Strip leading
		// whitespace + the '=' (matches the host putValue formula path).
		const body = text.trimStart().slice(1);
		const reqId = ++nextValidateReqId;
		latestValidateReqId = reqId;
		vscode.postMessage({
			type: 'validateFormula',
			sheet: editState.sheet,
			row: editState.row,
			col: editState.col,
			text: body,
			reqId,
			webviewId: WEBVIEW_ID,
		});
	}, VALIDATE_DEBOUNCE_MS);
}

/** Clear the validation message + re-render the hint (the signature may still show). Codex HIGH fold: also
 * invalidate any in-flight validate so a reply for the now-cleared text can't reapply a stale message. */
function clearValidation(): void {
	invalidateValidate();
	if (validationMessage.length === 0 && !validationIsError) {
		renderHint();
		return;
	}
	validationMessage = '';
	validationIsError = false;
	renderHint();
}

/**
 * Apply a `validateFormulaResult` from the host: pick the worst diagnostic as the inline message (or clear
 * on a clean validate). A `ok:false` (the engine threw) is surfaced as an error (No-Fallbacks). Stale
 * (superseded) replies are dropped by the reqId match before this is called.
 *
 * **Codex MED fold (No-Fallbacks at the webview boundary)**: `diagnostics` is taken as `unknown`. When
 * `ok === true` the host contract REQUIRES a `DiagnosticJson[]` (an empty array means valid). A reply that
 * claims `ok:true` but carries a missing / non-array `diagnostics` is a PROTOCOL violation (version skew /
 * tamper) -- it is surfaced as a validation error, NOT silently coerced to `[]` (which would falsely show
 * the formula as valid).
 */
function applyValidationResult(ok: boolean, diagnostics: unknown, error: string | undefined): void {
	if (!formulaBarIsEditing()) {
		// The edit closed while the validate was in flight -- nothing to show.
		clearValidation();
		return;
	}
	if (!ok) {
		validationMessage = error !== undefined && error.length > 0 ? error : 'The formula could not be validated.';
		validationIsError = true;
		renderHint();
		return;
	}
	if (!Array.isArray(diagnostics)) {
		// ok:true MUST carry a diagnostics array. A malformed reply is surfaced, not treated as valid.
		validationMessage = 'The validation reply was malformed (no diagnostics); the formula could not be validated.';
		validationIsError = true;
		renderHint();
		return;
	}
	const list = diagnostics as DiagnosticJson[];
	// Show the first error; else the first warning; else clear (valid). The engine returns diagnostics as
	// DATA (an empty array means valid) -- we never fabricate a problem.
	const err = list.find(d => d !== null && typeof d === 'object' && d.severity === 'error');
	const warn = list.find(d => d !== null && typeof d === 'object' && d.severity === 'warning');
	const pick = err ?? warn;
	if (pick === undefined) {
		clearValidation();
		return;
	}
	validationMessage = '[' + String(pick.code) + '] ' + String(pick.message);
	validationIsError = pick.severity === 'error';
	renderHint();
}

/** Tear down all formula-assist UI (dropdown + hint + pending validate). Called from `cancelEdit` when a
 * formula-bar edit closes so no stale dropdown/hint lingers over a non-editing bar. Codex HIGH fold:
 * `invalidateValidate` resets the validate token so a reply in flight when the edit closed is dropped. */
function teardownFormulaAssist(): void {
	invalidateValidate();
	closeCompletion();
	validationMessage = '';
	validationIsError = false;
	hintEl.hidden = true;
	hintEl.textContent = '';
	hintEl.classList.remove('is-error');
}

/**
 * **W3 frozen panes (Codex HIGH-2)** -- the CONTENT-layer position of the overlay editor for cell
 * `(row, col)`. The overlay `<input>` is a child of the content layer, so an element at content `top=Y`
 * renders at viewport `Y - scrollTop`. A BODY cell wants to scroll with the grid, so its content position
 * IS `cellContentRect` (the pre-W3 behaviour). A FROZEN cell must stay PINNED at its viewport position
 * (`rowY(r)` / `colX(c)`), so we ADD BACK the live scroll on the frozen axis (`+ scrollTop` / `+ scrollLeft`),
 * cancelling the content layer's scroll -- the cell then appears fixed below the header / right of the gutter
 * just like its painted pane. Re-evaluated on every scroll (the `scroll` handler calls `repositionEdit`),
 * so a frozen-cell editor tracks its pinned cell as the body scrolls. With no freeze this returns the bare
 * `cellContentRect` position (byte-identical to the pre-W3 path).
 */
function overlayCellContentPos(row: number, col: number): { left: number; top: number; width: number; height: number } {
	const rect = cellContentRect(row, col, renderer.gutterWidthPx);
	const pinLeft = col < renderer.frozenCols ? viewportEl.scrollLeft : 0;
	const pinTop = row < renderer.frozenRows ? viewportEl.scrollTop : 0;
	return { left: rect.x + pinLeft, top: rect.y + pinTop, width: rect.width, height: rect.height };
}

/** Re-position the open editor over its cell. Audit LOW-7: the gutter width can change on a theme/font
 * change, which shifts every cell's x -- a preserved editor must follow or it misaligns.
 * W-G-1b: only the OVERLAY editor is positioned over a cell; a formula-bar edit is a no-op here.
 * W3 frozen panes: a frozen cell's editor is pinned (see {@link overlayCellContentPos}), so this is also
 * called on every scroll so the pin tracks the live scroll. */
function repositionEdit(): void {
	if (editState === null || editState.surface !== 'overlay') {
		return;
	}
	const pos = overlayCellContentPos(editState.row, editState.col);
	inputEl.style.left = pos.left + 'px';
	inputEl.style.top = pos.top + 'px';
	inputEl.style.width = pos.width + 'px';
	inputEl.style.height = pos.height + 'px';
	updateEditClip(); // a gutter-width change shifts the cell -> recompute the body-pane clip too
}

/**
 * **FE-2-0 polish (2026-06-05) -- clip the open editor to the BODY pane (MED-5).**
 *
 * The overlay `<input>` is a content-layer child positioned at CONTENT coordinates, so it scrolls with the
 * grid; the sticky header (top `HEADER_HEIGHT`) + row gutter (left `gutterWidthPx`) are painted on the
 * pinned canvas. Without clipping, an editor scrolled under a band slides visibly ON TOP of it. A
 * `clip-path` inset hides exactly the portion overlapping the bands -- and unlike hiding the element
 * (`hidden`/`display:none`, which would blur the input and fire the cancel/commit path), `clip-path`
 * PRESERVES focus + the live edit. Only the top/left bands occlude; a cell fully in the body pane gets a
 * zero inset (no-op). Pointer events over a clipped region pass through to the band, as desired.
 *
 * **W3 frozen panes**: the occluding band on each axis = sticky band + the frozen-band pixels. A BODY-cell
 * editor scrolled up/left under the FROZEN strip is clipped at the frozen-band edge (not just the
 * header/gutter), so it never slides visibly over the pinned rows/cols. A FROZEN-cell editor is PINNED
 * (see {@link overlayCellContentPos}), so its on-screen position is `rowY(r)` / `colX(c)` -- above/left of
 * the body-pane band edge, so it is clipped only at the sticky gutter/header edge (clipLeft/clipTop clamp
 * to 0). The on-screen position is derived from the PINNED content position so it stays correct as the body
 * scrolls under a frozen-cell editor.
 */
function updateEditClip(): void {
	// W-G-1b: only the overlay editor is a content-layer child that can slide under a sticky band; a
	// formula-bar edit lives in the fixed bar above the grid and never needs clipping.
	if (editState === null || editState.surface !== 'overlay') {
		return;
	}
	const gutterW = renderer.gutterWidthPx;
	// The input's on-screen position = its CONTENT position - scroll. For a frozen cell the content position
	// adds back the frozen-axis scroll (overlayCellContentPos), so on-screen it lands at the pinned rowY/colX.
	const pos = overlayCellContentPos(editState.row, editState.col);
	const viewX = pos.left - viewportEl.scrollLeft;
	const viewY = pos.top - viewportEl.scrollTop;
	// W3: the occluding band edge depends on which pane the edited cell is in. A BODY cell (col >= fCols /
	// row >= fRows) can scroll under the frozen strip, so it is clipped at `band + frozen-band pixels`. A
	// FROZEN cell lives IN the frozen strip (left of `leftBand` / above `topBand`); clipping it there would
	// wrongly hide a pinned cell, so it is clipped only at the sticky gutter/header edge.
	const leftBand = editState.col < renderer.frozenCols ? gutterW : gutterW + frozenColsWidth(renderer.frozenCols);
	const topBand = editState.row < renderer.frozenRows ? HEADER_HEIGHT : HEADER_HEIGHT + frozenRowsHeight(renderer.frozenRows);
	// Hide the part of the input that lies under the occluding band on each axis (clamped to the input box).
	const clipLeft = Math.max(0, Math.min(pos.width, leftBand - viewX));
	const clipTop = Math.max(0, Math.min(pos.height, topBand - viewY));
	inputEl.style.clipPath = 'inset(' + clipTop + 'px 0px 0px ' + clipLeft + 'px)';
}

/**
 * Commit the edit; `nav` (optional) moves the selection once the matching `commitResult` arrives.
 * **Audit MED-B (2026-06-05)**: returns `true` iff the edit was POSTED (now pending), `false` on a LOCAL
 * reject (no editState/snapshot, already pending, or over-limit). Callers that fire on focus-out (`blur`)
 * use this to fall back to `cancelEdit` -- otherwise a locally-rejected blur would leave a non-pending
 * editor open+blurred and strand the keyboard (the document keyhandler is inert while `editState` is set).
 * The Enter/Tab callers ignore the return: an over-limit value keeps the editor OPEN with the banner so the
 * user can shorten it in place.
 */
function commitEdit(nav?: { dr: number; dc: number }): boolean {
	if (editState === null || fullSnapshot === null) {
		return false;
	}
	if (editState.pendingCommit) {
		return false; // a commit is already in flight
	}
	// Audit C1-MED6: reject an over-length input HERE (visible error, editor stays open for the user to
	// shorten) rather than serialize a multi-MB payload across the bridge for the host to reject anyway.
	// W-G-1b: read from the live editor (`editEl` -- overlay or formula bar), the single committed source.
	const editEl = editState.editEl;
	if (editEl.value.length > MAX_RAW_INPUT_LENGTH) {
		showError(
			`Cell value is ${editEl.value.length} characters, over the ${MAX_RAW_INPUT_LENGTH}-character limit. ` +
			`Shorten it and commit again.`,
			'edit',
		);
		return false;
	}
	clearError();
	// Audit MED-2: post to the sheet captured at edit-start (not the live `fullSnapshot.sheet`).
	const sheet = editState.sheet;
	const row = editState.row;
	const col = editState.col;
	const commitId = ++nextCommitId; // FE-2-0 Phase 2: stamp a unique token for THIS commit
	editState.pendingCommit = true;
	editState.commitId = commitId;
	editState.navAfterCommit = nav;
	editState.lastFailedRawInput = undefined; // megaudit B2: this is a fresh attempt, not the known-bad value
	editState.submittedRawInput = editEl.value; // re-audit HIGH: the value posted (for the late-ack guard)
	// Megaudit H1: lock the input while the commit is in flight, so a keystroke before the ack can't be
	// silently discarded when `resolvePendingCommit` closes the editor. Unlocked on resolve/error/cancel/watchdog.
	editEl.readOnly = true;
	// W2 formula intelligence: a commit is now in flight -- close the dropdown, invalidate any pending/in-flight
	// validate (Codex HIGH: drop a reply that returns after the commit), AND hide the already-rendered
	// validation/signature hint (re-audit LOW: a stale hint should not linger over the pending edit). A
	// successful commit's resolvePendingCommit -> cancelEdit re-establishes a clean bar. teardownFormulaAssist
	// does all three (it invalidates the validate token, closes completion, and hides the hint).
	if (editState.surface === 'formula') {
		teardownFormulaAssist();
	}
	armCommitWatchdog(commitId); // re-audit HIGH: recover the editor if no commitResult/errorReply arrives
	// Pessimistic: keep the input visible/focused until the host responds. FE-2-0 Phase 2: resolution is
	// now driven ONLY by a matching `commitResult` (success -> resolvePendingCommit hides the editor +
	// applies `nav`) or `errorReply` (failure -> decorate the cell + leave the editor open). A bare
	// `render` no longer resolves -- so a sibling-panel render can't falsely close this editor.
	// megaudit (webview-instance token): stamp WEBVIEW_ID so the host echoes it in the commitResult/errorReply
	// and a stale PRE-reload reply (whose reused low commitId could collide -- the counter resets on reload) is
	// dropped instead of resolving this edit.
	vscode.postMessage({ type: 'putValue', sheet, row, col, rawInput: editEl.value, commitId, webviewId: WEBVIEW_ID });
	return true; // posted -> the editor is now pending
}

// **W-G-1b**: the three edit listeners below are SHARED by both edit surfaces -- the in-cell overlay
// (`inputEl`) and the formula bar (`formulaInputEl`) -- and attached to both at the bottom of this block.
// Each early-returns unless the event came from the CURRENTLY-LIVE editor (`ev.target === editState.editEl`),
// so the inactive input is inert. This is what gives the formula bar the full commit/nav/known-bad/late-ack
// behavior through the SAME code (the single-writer requirement) with no second putValue path.

// Re-audit MED-4: clear the over-length ('edit') banner as soon as the user shortens the value back to
// the cap, so the guidance disappears the moment it no longer applies (instead of lingering until the
// next commit/cancel).
function onEditInput(ev: Event): void {
	if (editState === null || ev.target !== editState.editEl) {
		return;
	}
	if (errorSource === 'edit' && editState.editEl.value.length <= MAX_RAW_INPUT_LENGTH) {
		clearError();
	}
	// Megaudit re-audit LOW: ANY real edit clears the "known-bad" marker, so a value the user changed (even
	// if changed back to the exact failed string) commits normally on Enter/Tab instead of being treated as
	// "still bad" and abandoned. The arrow/Tab "leave a bad cell" affordance only applies to an UNTOUCHED
	// failure (the moment after it fails); once you start correcting, arrows are caret + Enter commits.
	editState.lastFailedRawInput = undefined;
	// W2 formula intelligence: drive the completion dropdown + debounced validation + signature hint on every
	// keystroke, but ONLY for the formula-bar editor (the in-cell overlay has no assist UI). A 1+ char prefix
	// is required to open the dropdown (allowEmptyPrefix=false) so it does not pop on a bare '='.
	if (editState.surface === 'formula') {
		updateCompletion(false);
		scheduleValidate();
		updateSignatureHint();
	}
}
function onEditKeydown(ev: KeyboardEvent): void {
	// Audit MED-4: while an IME composition is active, Enter/Tab ACCEPT the candidate -- they must not
	// commit/move the cell. Let the input handle composition natively until it completes.
	if (ev.isComposing || ev.keyCode === 229) {
		return;
	}
	if (editState === null || ev.target !== editState.editEl) {
		return;
	}
	// **W2 formula intelligence -- dropdown keyboard interception (CRITICAL).** When the completion dropdown
	// is OPEN (only possible on the formula-bar editor), Up/Down/Enter/Tab/Esc drive the LIST and are
	// swallowed BEFORE the shared edit machinery below (so Enter picks an item instead of committing+moving,
	// Esc closes the list instead of reverting the edit, Tab inserts instead of nav). A non-pending guard:
	// while a commit is in flight the dropdown is force-closed elsewhere, but be defensive and only intercept
	// when not pending. Any key NOT handled here (typing, Home/End, etc.) falls through to the existing logic
	// unchanged, and the dropdown is closed/refreshed by the `input` handler. When the dropdown is CLOSED
	// this whole block is skipped and the edit core behaves exactly as before.
	if (completion !== null && editState.surface === 'formula' && !editState.pendingCommit) {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			moveCompletion(1);
			return;
		}
		if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			moveCompletion(-1);
			return;
		}
		if (ev.key === 'Enter' || ev.key === 'Tab') {
			// Accept the highlighted item. There is always a highlighted item while open (activeIndex defaults
			// to 0), so Enter/Tab here NEVER commits the cell -- the list wins. If somehow nothing is
			// highlighted, fall through to the normal commit/nav path.
			if (completion.activeIndex >= 0) {
				ev.preventDefault();
				acceptCompletion(completion.activeIndex);
				return;
			}
		}
		if (ev.key === 'Escape') {
			// Close the dropdown WITHOUT cancelling the edit (Excel: Esc dismisses the suggestion list first;
			// a second Esc reverts the edit). preventDefault + stop so the edit-Escape below does not also run.
			ev.preventDefault();
			closeCompletion();
			return;
		}
		// Other keys (printable, Backspace, Home/End, Left/Right caret moves) fall through: the input edits
		// natively, then the `input`/`keyup` handlers recompute or close the dropdown.
	}
	if (ev.key === 'Escape') {
		ev.preventDefault();
		// Audit O2-MED1: Escape is inert while a commit is in flight (matches commitEdit/blur). Cancelling
		// here would NOT recall the already-posted putValue but WOULD wipe editState -- enabling a
		// same-cell double-put and dropping the host's pending reply on the floor.
		if (editState.pendingCommit) {
			return;
		}
		cancelEdit();
		redraw();
		viewportEl.focus();
		return;
	}
	if (editState.pendingCommit) {
		// A commit is in flight: the input is readOnly. Megaudit re-audit MED: SWALLOW nav/commit keys so
		// Tab can't tab-order focus OUT of the readOnly input (blur is ignored while pending + the document
		// handler is dead while editing -> the keyboard would be stranded). Inert until the host replies.
		if (navVector(ev.key, ev.shiftKey) !== null) {
			ev.preventDefault();
		}
		return;
	}
	const vec = navVector(ev.key, ev.shiftKey);
	if (vec === null) {
		return; // a normal editing key -- let the <input> handle it
	}
	// **Megaudit B2**: if the editor still holds exactly the value that just FAILED to commit, the user is
	// trying to leave a known-bad cell. ABANDON the edit + navigate on ANY nav key (arrow / Tab / Enter) --
	// never re-post the same failing value (that was the Tab re-fail loop). A CHANGED value falls through
	// and commits (the user fixed it). This is what lets arrows AND Tab "get you out" of a bad formula.
	if (editState.lastFailedRawInput !== undefined && editState.editEl.value === editState.lastFailedRawInput) {
		ev.preventDefault();
		const { row, col } = editState;
		cancelEdit();
		setActiveClamped(row + vec.dr, col + vec.dc);
		redraw();
		viewportEl.focus();
		return;
	}
	if (ev.key.startsWith('Arrow')) {
		// A normal (not-known-bad) edit: arrows move the text caret inside the <input>. (Excel's
		// "enter-mode" arrows-commit-and-move is a deliberate follow-up -- it changes how every edit feels
		// and warrants its own behavioral smoke; not folded into this fix.)
		return;
	}
	ev.preventDefault();
	commitEdit(vec); // Enter = commit + down; Tab = commit + right (Shift+Tab left)
}
function onEditBlur(ev: FocusEvent): void {
	// **FE-2-0 polish (2026-06-05)**: blur COMMITS a changed value (Excel: clicking / Tabbing away saves
	// your edit) but CANCELS an unchanged one. A pending commit is left to resolve on the host reply (as
	// before). NOTE: cancelEdit()/resolvePendingCommit() null `editState` BEFORE hiding the input, so the
	// blur THEY trigger early-returns here (editState === null) -- this only fires on a genuine focus-out.
	if (editState === null || editState.pendingCommit || ev.target !== editState.editEl) {
		return;
	}
	const value = editState.editEl.value;
	const changed = value !== editState.initialValue;
	// Still EXACTLY the value that just failed to commit (untouched since the errorReply): committing would
	// re-post the same rejected value (the B2 re-fail loop). Abandon instead -- mirrors the B2 nav affordance.
	const knownBad = editState.lastFailedRawInput !== undefined && value === editState.lastFailedRawInput;
	if (changed && !knownBad) {
		// Commit a genuine change with NO nav (blur doesn't move the selection).
		if (commitEdit()) {
			return; // posted -> editor is now pending
		}
		// **Audit MED (2026-06-05)**: commitEdit LOCALLY rejected (an over-limit value). We must NOT keep the
		// editor open+blurred (the document keyhandler is inert while editState is set -> stranded keyboard),
		// so we abandon it -- but NOT silently (No-Fallbacks): commitEdit's own 'edit' banner is cleared by
		// cancelEdit below, so re-surface the discard as a 'transient' notice that survives to the next render.
		const len = value.length;
		cancelEdit();
		showError(
			'Edit discarded: the value was ' + len + ' characters, over the ' + MAX_RAW_INPUT_LENGTH +
			'-character limit. Re-open the cell to shorten it.',
			'transient',
		);
		redraw();
		return;
	}
	// Unchanged or known-bad -> abandon the edit outright.
	cancelEdit();
	redraw();
}

// W-G-1b: attach the shared edit listeners to BOTH surfaces. The overlay (`inputEl`) and the formula bar
// (`formulaInputEl`) run the same commit/nav/blur logic; each handler keys off `editState.editEl`, so only
// the live editor acts. Focusing the formula bar enters an edit (Excel: the formula bar is an edit surface).
inputEl.addEventListener('input', onEditInput);
inputEl.addEventListener('keydown', onEditKeydown);
inputEl.addEventListener('blur', onEditBlur);
formulaInputEl.addEventListener('input', onEditInput);
formulaInputEl.addEventListener('keydown', onEditKeydown);
formulaInputEl.addEventListener('blur', onEditBlur);
formulaInputEl.addEventListener('focus', () => {
	beginEditFormula();
});
// W2 formula intelligence -- explicit trigger + caret-tracking + focus-out cleanup on the FORMULA BAR only.
// Ctrl/Cmd+Space opens the dropdown with the full list (the empty-prefix affordance) at the caret. This is a
// keydown (it must preventDefault before the browser inserts a space) and runs BEFORE onEditKeydown's
// dropdown block on the same target, so it's registered first below.
formulaInputEl.addEventListener('keydown', ev => {
	if ((ev.ctrlKey || ev.metaKey) && (ev.key === ' ' || ev.code === 'Space') && formulaBarIsEditing()) {
		ev.preventDefault();
		updateCompletion(true); // allowEmptyPrefix -> show all functions at the caret
	}
});
// A caret move via arrow keys / Home / End / a mouse click inside the input does NOT fire `input`, so refresh
// the signature hint (and re-evaluate the dropdown, which closes if the caret left a name token) on keyup +
// click. Guarded to the formula-bar editor. The dropdown's own Up/Down are already handled (and returned) in
// onEditKeydown, so a keyup for those arrives with the dropdown still open -- updateCompletion preserves it.
function refreshAssistOnCaretMove(): void {
	if (!formulaBarIsEditing()) {
		return;
	}
	updateSignatureHint();
	// Only RE-EVALUATE the dropdown for caret moves while it is already open (so a Left/Right that leaves the
	// name token closes it). Do NOT auto-open on a bare caret move -- opening is driven by typing / Ctrl+Space.
	if (completion !== null) {
		updateCompletion(false);
	}
}
formulaInputEl.addEventListener('keyup', ev => {
	if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
		refreshAssistOnCaretMove();
	}
});
formulaInputEl.addEventListener('click', () => {
	refreshAssistOnCaretMove();
});
// Focus-out: close the dropdown (and cancel any pending validate) so it never lingers over a non-focused
// bar. A click ON a suggestion preventDefaults its mousedown so focus never leaves -> this does not fire for
// an accept. The shared onEditBlur (registered above) still runs to commit/cancel the edit itself; this only
// tears down the assist OVERLAY. Use a capture-phase-safe ordering: this listener is added AFTER onEditBlur,
// but both fire on the same blur; closing the dropdown here is independent of the commit/cancel decision.
formulaInputEl.addEventListener('blur', () => {
	closeCompletion();
});

// --- Canvas pointer: single click SELECTS, double click EDITS (FE-2-0 polish 2026-06-05) ---

/** Hit-test a pointer event against the body grid; returns the (row,col) or null (band / gutter / empty). */
function hitTestCanvas(ev: MouseEvent): { row: number; col: number } | null {
	if (fullSnapshot === null) {
		return null;
	}
	const rect = canvasEl.getBoundingClientRect();
	// W3 frozen panes: thread the pinned counts so a click in a frozen band maps to the pinned cell (no
	// scroll added on that axis); 0/0 reduces to the pre-W3 hit-test.
	return hitTestViewportFrozen(
		ev.clientX - rect.left,
		ev.clientY - rect.top,
		viewportEl.scrollLeft,
		viewportEl.scrollTop,
		renderer.gutterWidthPx,
		renderer.frozenRows,
		renderer.frozenCols,
	);
}

/**
 * **W-G fill handle** -- is `ev` over the fill-handle square (the selection's bottom-right corner)? The
 * handle is painted at the bottom-right pixel corner of the selection (or the active cell); a press within
 * {@link FILL_HANDLE_HIT_PX} of it starts a fill drag instead of a selection click.
 */
function isOnFillHandle(ev: MouseEvent): boolean {
	if (active === null) {
		return false;
	}
	const sel = currentSelection();
	const brRow = sel === null ? active.row : sel.maxRow;
	const brCol = sel === null ? active.col : sel.maxCol;
	const rect = canvasEl.getBoundingClientRect();
	// W3 frozen panes: the handle is painted at the bottom-right corner of (brRow, brCol). A FROZEN corner
	// cell paints at its pinned position (no scroll on the frozen axis), so the hit-test must use the SAME
	// effective scroll the paint used, or the handle would be unreachable when the corner cell is frozen.
	const effScrollLeft = brCol < renderer.frozenCols ? 0 : viewportEl.scrollLeft;
	const effScrollTop = brRow < renderer.frozenRows ? 0 : viewportEl.scrollTop;
	const cornerX = colX(brCol + 1, renderer.gutterWidthPx) - effScrollLeft;
	const cornerY = rowY(brRow + 1) - effScrollTop;
	return Math.abs(ev.clientX - rect.left - cornerX) <= FILL_HANDLE_HIT_PX
		&& Math.abs(ev.clientY - rect.top - cornerY) <= FILL_HANDLE_HIT_PX;
}

// W-G fill handle: a pointer press on the handle starts a drag-to-fill (pointer events so setPointerCapture
// keeps move/up firing if the pointer leaves the canvas). A press elsewhere is left to the click handler.
canvasEl.addEventListener('pointerdown', ev => {
	// megaudit Lane C: ignore a re-entrant pointerdown while a drag is already in flight (a second touch /
	// stylus). It must not reset the suppress flag, restart the drag, or rebind `fillSource` to a different
	// rect -- the first pointer owns the drag until its pointerup/pointercancel.
	if (fillSource !== null) {
		return;
	}
	// megaudit MED: clear any leftover suppress flag at the START of every interaction so it can never
	// linger to swallow a later legitimate click (on platforms where preventDefault below already
	// suppresses the drag's own synthetic click, the flag would otherwise never be consumed).
	fillSuppressClick = false;
	if (editState !== null || active === null || !isOnFillHandle(ev)) {
		return;
	}
	ev.preventDefault();
	const sel = currentSelection();
	fillSource = sel ?? { minRow: active.row, maxRow: active.row, minCol: active.col, maxCol: active.col };
	fillPreview = fillSource;
	canvasEl.setPointerCapture(ev.pointerId);
});
canvasEl.addEventListener('pointermove', ev => {
	if (fillSource === null) {
		return;
	}
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		// megaudit Lane C: the pointer left the grid into a header/gutter band -- snap the preview back to the
		// source so RELEASING here is a visible no-op (a cancel), not a commit of the last in-grid extent.
		if (
			fillPreview === null ||
			fillPreview.minRow !== fillSource.minRow || fillPreview.maxRow !== fillSource.maxRow ||
			fillPreview.minCol !== fillSource.minCol || fillPreview.maxCol !== fillSource.maxCol
		) {
			fillPreview = fillSource;
			redraw();
		}
		return;
	}
	const next = computeFillPreview(fillSource, hit.row, hit.col);
	if (fillPreview === null || next.minRow !== fillPreview.minRow || next.maxRow !== fillPreview.maxRow || next.minCol !== fillPreview.minCol || next.maxCol !== fillPreview.maxCol) {
		fillPreview = next;
		redraw();
	}
});
canvasEl.addEventListener('pointerup', ev => {
	if (fillSource === null) {
		return;
	}
	canvasEl.releasePointerCapture?.(ev.pointerId);
	// Lane C final audit: a pointerup can fire over a header/gutter band (or at a position the last
	// pointermove never reported), so re-evaluate the RELEASE position here -- it is authoritative for what
	// commits. A release outside the grid snaps back to the source (cancel, no extension); an in-grid release
	// recomputes the extent from the actual release cell. Closes the "release-over-band commits a stale
	// preview" hole that the pointermove snap-back alone did not cover.
	const releaseHit = hitTestCanvas(ev);
	fillPreview = releaseHit === null ? fillSource : computeFillPreview(fillSource, releaseHit.row, releaseHit.col);
	const filled = applyFill();
	fillSource = null;
	fillPreview = null;
	// Lane C: suppress the synthesized post-drag click ONLY when a fill actually committed; a no-op handle
	// tap must let its click through to select the cell.
	fillSuppressClick = filled;
	redraw();
});
// megaudit MED: if the drag is CANCELED (pointercancel -- a touch/pen hijack, a system overlay), there is
// no pointerup, so clear the drag state here too. Otherwise `fillSource`/`fillPreview` stay set (a frozen
// preview, and a later unrelated pointerup would apply an unintended fill). No fill is committed on a
// cancel. (Only pointercancel, NOT lostpointercapture -- the latter also fires on the normal post-pointerup
// release and could race applyFill.)
canvasEl.addEventListener('pointercancel', () => {
	if (fillSource === null) {
		return;
	}
	fillSource = null;
	fillPreview = null;
	redraw();
});

// Single click SELECTS the cell (Excel). It does NOT open the editor -- double-click / F2 / type-to-edit do.
// If an editor was open, the focus-out it caused already committed/cancelled it via the blur handler above;
// here we only move the selection. (A pending commit keeps its editor; the click still just reselects.)
canvasEl.addEventListener('click', ev => {
	if (fillSuppressClick) {
		fillSuppressClick = false; // W-G fill handle: swallow the click synthesized after a fill drag
		return;
	}
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		return;
	}
	// W-G-2a: Shift+click EXTENDS the selection -- the click cell becomes the focus, the anchor stays (or is
	// established at the prior focus). A plain click COLLAPSES to the single clicked cell.
	if (ev.shiftKey) {
		if (anchor === null) {
			anchor = active ?? { row: hit.row, col: hit.col };
		}
	} else {
		anchor = null;
	}
	active = { row: hit.row, col: hit.col };
	redraw();
});

// Double click opens the editor on the cell (Excel). beginEdit re-asserts the selection + reveal; it bails
// if a commit is still in flight (M8), consistent with every other edit entry point.
canvasEl.addEventListener('dblclick', ev => {
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		return;
	}
	beginEdit(hit.row, hit.col);
	redraw();
});

// Hover tooltip: surface a cell's errorReply message or its engine diagnostic via the native `title`.
// FE megaudit L-b: coalesce mousemove to ONE hit-test per animation frame.
let lastHoverTitle = '';
let hoverClientX = 0;
let hoverClientY = 0;
let hoverScheduled = false;
function updateHoverTitle(): void {
	hoverScheduled = false;
	let title = '';
	if (fullSnapshot !== null) {
		const rect = canvasEl.getBoundingClientRect();
		const hit = hitTestViewportFrozen(
			hoverClientX - rect.left,
			hoverClientY - rect.top,
			viewportEl.scrollLeft,
			viewportEl.scrollTop,
			renderer.gutterWidthPx,
			renderer.frozenRows,
			renderer.frozenCols,
		);
		if (hit !== null) {
			const entry = renderer.entryAt(hit.row, hit.col);
			const key = hit.row + ',' + hit.col;
			// Audit C1-HIGH2: cap the tooltip string (a pathological diagnostic/error message shouldn't
			// stall the native `title` rendering).
			const errPart = clampDisplayString(
				errorCells.get(key) ?? (entry && typeof entry.diagnostic === 'string' ? entry.diagnostic : ''),
			);
			// W-G bound-cell name display: if this cell is a published target, add a line naming the reactive
			// variable that drives it. Each part is clamped first (so a pathological diagnostic/name never
			// builds a huge join), then the COMPOSED title is clamped once more so the whole string still
			// honors the single C1-HIGH2 cap (Codex LOW) -- realistic short errors keep both lines intact.
			const drivenBy = publishedNameAt(publishedRanges, hit.row, hit.col);
			const pubPart = drivenBy === null ? '' : clampDisplayString('Driven by reactive variable "' + drivenBy + '"');
			title = clampDisplayString([errPart, pubPart].filter(part => part.length > 0).join('\n'));
		}
	}
	if (title !== lastHoverTitle) {
		canvasEl.title = title;
		lastHoverTitle = title;
	}
}
// Coalesce a native-title recompute to ONE hit-test per animation frame. Called on pointer move AND
// (W-G bound-cell name display, Codex MED) after any repaint -- a publish retraction (-> redraw) or a
// scroll (-> scrollRedraw) can move a different cell, or a now-unpublished cell, under a STATIONARY
// pointer, so the title must be recomputed from the last pointer position, not only on the next move.
// Safe to call from redraw()/scrollRedraw(): both run well after module load, so `hoverScheduled` (a
// module `let` initialized above) is always defined by then (the W-G-1b init-order lesson).
function scheduleHoverTitle(): void {
	if (hoverScheduled) {
		return;
	}
	hoverScheduled = true;
	requestAnimationFrame(updateHoverTitle);
}
canvasEl.addEventListener('mousemove', ev => {
	hoverClientX = ev.clientX;
	hoverClientY = ev.clientY;
	scheduleHoverTitle();
});

// --- Keyboard: navigation + type-to-edit + undo/redo (only when NOT editing) ---

document.addEventListener('keydown', ev => {
	// W-G: the formula bar input is focusable (read-only, but selectable so a formula can be copied out).
	// Its keystrokes bubble to this document handler -- ignore them, or arrows/Delete/printable keys would
	// drive grid navigation / clear / type-to-edit on the active cell while the user is in the formula bar
	// (Codex W-G HIGH). Copy (Ctrl+C of a selected formula) still works: the browser handles it natively.
	if (ev.target === formulaInputEl) {
		return;
	}
	if (editState !== null) {
		return; // the editor has its own handler
	}
	// W1 formula-intel: if the completion dropdown is showing, it owns the keyboard (its keys are intercepted
	// on the editor's own handler). `completion` is only non-null during a formula edit, so `editState !== null`
	// above already covers this -- but guard explicitly so a future change that can leave `completion` set
	// outside an edit never lets a nav key fire underneath an open dropdown.
	if (completion !== null) {
		return;
	}
	// megaudit Lane C: ignore document shortcuts (undo/redo, copy/cut/paste, nav, type-to-edit) WHILE a
	// fill-handle drag is in flight. A Ctrl+X mid-drag would replace the clipboard and silently discard a
	// pending CUT; arrow/nav keys would move the selection under the drag. The drag owns input until
	// pointerup/pointercancel clears `fillSource`.
	if (fillSource !== null) {
		return;
	}
	// Audit MED-1: ignore IME composition / dead-key keystrokes (keyCode 229 or `isComposing`). Without
	// this, the FIRST composition keystroke would open the editor pre-filled with a raw intermediate char
	// and `preventDefault()` would suppress the real composed text -- breaking CJK/accented type-to-edit.
	if (ev.isComposing || ev.keyCode === 229) {
		return;
	}
	const isMeta = ev.metaKey || ev.ctrlKey;
	// Undo / redo.
	if (isMeta) {
		const k = ev.key.toLowerCase();
		if (k === 'z' && !ev.shiftKey) {
			ev.preventDefault();
			vscode.postMessage({ type: 'undo' });
			return;
		}
		if ((k === 'z' && ev.shiftKey) || k === 'y') {
			ev.preventDefault();
			vscode.postMessage({ type: 'redo' });
			return;
		}
		// W-G copy/paste: Ctrl/Cmd + C (copy) / X (cut) / V (paste) on the grid selection. Reached only when
		// NOT editing and NOT focused in the formula bar (both guarded at the top of this handler), so a
		// native text copy/paste inside an input is unaffected.
		if (k === 'c') {
			ev.preventDefault();
			copyGridSelection(false);
			return;
		}
		if (k === 'x') {
			ev.preventDefault();
			copyGridSelection(true);
			return;
		}
		if (k === 'v') {
			ev.preventDefault();
			pasteGridClipboard();
			return;
		}
		// Excel nav keys (meta variants). Ctrl/Cmd+Home -> A1; Ctrl/Cmd+End -> the last used cell (snapshot
		// extent). Mirror the arrow path's setActive/clamp/scroll-into-view via jumpActive (no new movement
		// mechanism). `ev.key` for these is 'Home' / 'End' regardless of the meta modifier.
		if (ev.key === 'Home') {
			ev.preventDefault();
			jumpActive(0, 0);
			return;
		}
		if (ev.key === 'End') {
			ev.preventDefault();
			const end = usedExtent();
			jumpActive(end.row, end.col);
			return;
		}
		return; // leave other meta combos alone
	}
	if (ev.altKey) {
		return;
	}
	// Navigation. W-G-2a: Shift+Arrow EXTENDS the selection range (anchor stays, focus moves); a plain
	// arrow COLLAPSES the range and moves. Tab/Enter always move a single cell (collapse) -- Shift+Tab is
	// reverse-Tab (move left), NOT range extension, matching Excel.
	switch (ev.key) {
		case 'ArrowUp':
			ev.preventDefault();
			(ev.shiftKey ? extendActive : moveActive)(-1, 0);
			return;
		case 'ArrowDown':
			ev.preventDefault();
			(ev.shiftKey ? extendActive : moveActive)(1, 0);
			return;
		case 'Enter': // Excel: Enter on a selected cell moves down (typing/F2 edits)
			ev.preventDefault();
			moveActive(1, 0);
			return;
		case 'ArrowLeft':
			ev.preventDefault();
			(ev.shiftKey ? extendActive : moveActive)(0, -1);
			return;
		case 'ArrowRight':
			ev.preventDefault();
			(ev.shiftKey ? extendActive : moveActive)(0, 1);
			return;
		case 'Home':
			// Excel: Home -> column A of the current row (plain; the Ctrl/Cmd+Home -> A1 variant is handled in
			// the isMeta block above).
			ev.preventDefault();
			jumpActive(active === null ? 0 : active.row, 0);
			return;
		case 'End':
			// Excel: End / Ctrl+End -> the last used cell (snapshot extent). The plain-End variant lands here;
			// the meta variant is handled above. Both target the same cell per the spec.
			ev.preventDefault();
			{
				const end = usedExtent();
				jumpActive(end.row, end.col);
			}
			return;
		case 'PageUp':
			// Move the active cell UP by one screenful of rows (+ scroll into view, via moveActive's
			// ensureActiveVisible). Mirrors the arrow path; clamps at row 0.
			ev.preventDefault();
			moveActive(-visibleRowSpan(), 0);
			return;
		case 'PageDown':
			// Move the active cell DOWN by one screenful of rows (+ scroll into view). Mirrors the arrow path.
			ev.preventDefault();
			moveActive(visibleRowSpan(), 0);
			return;
		case 'Tab':
			ev.preventDefault();
			moveActive(0, ev.shiftKey ? -1 : 1);
			return;
		case 'Escape':
			// W-G-2a: collapse a multi-cell range back to the focus cell (no-op when already single-cell).
			if (anchor !== null) {
				ev.preventDefault();
				collapseSelection();
				redraw();
			}
			return;
		case 'F2':
			ev.preventDefault();
			if (active !== null) {
				beginEdit(active.row, active.col);
				redraw();
			}
			return;
		case 'Delete':
		case 'Backspace':
			// Audit O2-MED3: clear the selected cell. preventDefault is load-bearing for Backspace --
			// otherwise it triggers webview history-back navigation.
			ev.preventDefault();
			clearActiveCell();
			return;
		default:
			break;
	}
	// Type-to-edit: a single printable character opens the editor pre-filled with it.
	if (ev.key.length === 1 && active !== null) {
		ev.preventDefault();
		beginEdit(active.row, active.col, ev.key);
		redraw();
	}
});

// --- Inbound host messages ---

/**
 * Audit C1-MED3: validate a host `render` payload before applying it. The host is trusted, but a
 * binding/version drift or a tampered bundle could deliver a non-conforming object; `applyRender`
 * would then throw opaquely (e.g. `snapshot.entries.length` on undefined) and leave the grid frozen
 * with no explanation. We accept only the pinned shape (`snapshot_format_version === 1`, numeric
 * sheet, array entries) and otherwise surface a visible error (No-Fallbacks -- not a silent return).
 */
function isValidSnapshot(snapshot: unknown): snapshot is QuantbookCellSnapshot {
	if (typeof snapshot !== 'object' || snapshot === null) {
		return false;
	}
	const s = snapshot as { snapshot_format_version?: unknown; sheet?: unknown; entries?: unknown };
	// `sheet` threads into `commitEdit`'s putValue, so require a finite non-negative integer (a NaN/string
	// would post garbage to the host). Per-entry coord/value validation happens in `renderer.setSnapshot`
	// (Codex HIGH-1) -- it skip+warns malformed entries rather than dropping the whole render.
	return (
		s.snapshot_format_version === 1 &&
		typeof s.sheet === 'number' &&
		Number.isInteger(s.sheet) &&
		s.sheet >= 0 &&
		Array.isArray(s.entries)
	);
}

/**
 * Apply a fresh snapshot: update title/meta + spacer, then full-redraw. **FE-2-0 Phase 2 (commit-token):
 * a bare `render` NO LONGER resolves a pending commit** -- it only refreshes the snapshot + repaints; an
 * open editor (pending or not) is PRESERVED and the canvas repaints underneath it. Pending edits resolve
 * ONLY on a matching `commitResult` (success -> {@link resolvePendingCommit}) / `errorReply` (failure),
 * keyed by the unique commitId. This kills the sibling-render false-ack HIGH (a render from a sibling
 * panel / session refresh can't close or mis-resolve this editor) AND the errorCells-clear-on-idle-render
 * + (sheet,row,col) false-match items -- errorCells is now mutated only by a matching reply.
 */
/**
 * **W-G bound-cell indicator** -- rebuild {@link publishedRanges} from a `render` message's `publishedCells`
 * field, validating each item at the trust boundary (mirrors the host selection-drop discipline: a
 * malformed / out-of-extent / mis-ordered item is DROPPED with a `console.warn`, never blanking the grid
 * or throwing). The host sends the authoritative set for this sheet on every render, so we rebuild
 * wholesale. Returns whether the validated set CHANGED since the last render -- the caller forces a FULL
 * redraw on a change, because the damage fast path repaints only rows whose VALUE moved and a stale-only
 * retraction (badge clears, no value change) would otherwise leave the marker on screen.
 */
function rebuildPublishedRanges(raw: unknown): boolean {
	const coordOk = (v: unknown, max: number): v is number =>
		typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max;
	const next: PublishedRange[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (item === null || typeof item !== 'object') {
				console.warn('[sheets-webview] dropped a non-object publishedCells item:', item);
				continue;
			}
			const pr = item as { startRow?: unknown; startCol?: unknown; endRow?: unknown; endCol?: unknown; name?: unknown };
			if (
				coordOk(pr.startRow, MAX_ROWS) && coordOk(pr.endRow, MAX_ROWS) &&
				coordOk(pr.startCol, MAX_COLS) && coordOk(pr.endCol, MAX_COLS) &&
				pr.startRow <= pr.endRow && pr.startCol <= pr.endCol &&
				typeof pr.name === 'string' && pr.name.length > 0
			) {
				next.push({ startRow: pr.startRow, startCol: pr.startCol, endRow: pr.endRow, endCol: pr.endCol, name: pr.name });
			} else {
				console.warn('[sheets-webview] dropped a malformed publishedCells item:', item);
			}
		}
	} else if (raw !== undefined) {
		console.warn('[sheets-webview] render.publishedCells was not an array; ignoring:', raw);
	}
	const key = next.map(r => r.startRow + ':' + r.startCol + ':' + r.endRow + ':' + r.endCol + ':' + r.name).join('|');
	const changed = key !== publishedRangesKey;
	publishedRanges = next;
	publishedRangesKey = key;
	return changed;
}

function applyRender(snapshot: QuantbookCellSnapshot, publishedChanged: boolean): void {
	// Re-audit MED-4: a valid render supersedes a TRANSIENT banner (malformed-render / un-editable cell)
	// but must NOT hide an active 'edit' banner -- a sibling render repaints under an open editor whose
	// over-length value is still invalid; clearing it would mask the bad pending state until next commit.
	clearTransientError();
	const prevSnapshot = fullSnapshot; // captured BEFORE replacement for the Phase 3 damage diff
	fullSnapshot = snapshot;
	renderer.setSnapshot(snapshot);

	// Megaudit MED: `errorCells` is keyed by (row,col) for the CURRENT sheet only. Clear it when the
	// snapshot's sheet changes (a Switch Sheet), else a failed A1 on sheet 0 would keep tinting A1 after
	// switching to sheet 1. (A sheet change also makes `diffSnapshotsA1` return null -> full redraw below.)
	if (prevSnapshot !== null && prevSnapshot.sheet !== snapshot.sheet) {
		errorCells.clear();
		// **Codex MED fold (+ re-audit MED)**: a Switch Sheet re-renders THIS panel onto a different sheet. An
		// open formula-bar edit's dropdown/hint targeted the OLD sheet's cell; `updateFormulaBar` is a no-op
		// while editing, so without this the dropdown/hint (and an in-flight validate keyed to the old coords)
		// would survive onto the new sheet. Tear down the ASSIST UI + invalidate the validate token always.
		// But do NOT cancel a PENDING commit (re-audit MED): cancelEdit would clear `editState` + the watchdog,
		// so a late matching `commitResult`/`errorReply` would be dropped (the reload-race / pending-commit
		// invariant). When pending, leave the edit alive for the normal ack/error/watchdog path; only the
		// assist overlay is torn down. When NOT pending we can safely cancel the (now cross-sheet) edit.
		if (formulaBarIsEditing() && editState !== null && !editState.pendingCommit) {
			cancelEdit();
		} else {
			teardownFormulaAssist();
		}
	} else if (errorCells.size > 0) {
		// FE-2-0 polish (2026-06-05): clear a STALE tint when the cell's STORED content changed between
		// renders -- i.e. a real write landed (a sibling panel / a recompute FIXED the cell this panel had
		// tinted from a rejected edit). This is the ONLY errorCells mutation a render performs, and it touches
		// neither the editor nor the commit resolution (it only deletes a red tint) -- so the Phase 2 "a bare
		// render never resolves a pending commit / can't false-ack a sibling" invariant holds. The open-editor
		// cell is deliberately NOT exempt: a sibling fixing the cell you're editing SHOULD drop its tint
		// (audit MED-A: exempting it left the tint permanent, and the editor covers the cell anyway).
		for (const key of staleTintKeysA1(prevSnapshot, snapshot, errorCells.keys())) {
			errorCells.delete(key);
		}
	}

	// Audit LOW-3: do NOT refreshTheme() here -- a render is not a theme change. Theme/font changes are
	// handled by the body-class MutationObserver (and the initial read is in the renderer constructor);
	// refreshing per render needlessly cleared the measure cache + recomputed the gutter every snapshot.
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent =
		'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	updateSpacer();

	// **FE-2-0 Phase 3 / FE-2 BAKEOFF** -- the paint decision now lives in the shared orchestrator:
	// damage fast path (a prior frame at the SAME scroll, dpr fresh, published set unchanged -> repaint
	// ONLY the A1 rows whose paint changed via `diffSnapshotsA1`); else a full `redraw()` (the
	// always-correct fallback, taken on the first render, a sheet switch, or any scroll/size change since
	// the last paint). The non-paint prep above (set fullSnapshot, clear/stale-tint errorCells, title/meta,
	// spacer) stays here -- those are DOM/binding writes this file owns. `commitSnapshot` fires the
	// `onAfterDamage` host callback (the formula-bar follow) on the damage path.
	orchestrator.commitSnapshot(prevSnapshot, snapshot, publishedChanged);
}

/**
 * **FE-2-0 Phase 2 (commit-token)** -- resolve the in-flight edit whose token matches a host
 * `commitResult` success ack: clear that cell's error tint (the commit succeeded), close the editor, and
 * apply the queued post-commit nav. The host posts the session-wide `render` (snapshot updated) BEFORE
 * this ack on the SAME FIFO channel, so in the normal path the committed value is already on screen when
 * the editor closes. **Re-audit MED:** if THIS panel's render failed (threw -> `onCommit`'s failed-count
 * "run Refresh" toast; or non-delivered -> `postRenderIfReady`'s non-delivery toast), the canvas is
 * briefly stale after the editor closes -- but the host has ALREADY surfaced a visible "refresh" warning
 * in both those cases, so the staleness is explained + recoverable (it is not silent). Ignores a
 * non-matching id (a stale ack / an ack for a different in-flight edit).
 */
function resolvePendingCommit(commitId: number): void {
	// Megaudit MED: match on commitId EVEN IF `pendingCommit` was already cleared by the 10s watchdog -- a
	// genuinely-late success ack must still close the editor + apply the nav (the prior `!pendingCommit`
	// guard dropped it on the floor, leaving the editor open under a false "could not confirm" banner).
	if (editState === null || editState.commitId !== commitId) {
		return;
	}
	// Re-audit HIGH: if the watchdog (or a malformed-render) already recovered this edit (`pendingCommit`
	// cleared) and the user has since typed a correction, a genuinely-LATE success ack must NOT close the
	// editor + discard that typing. Only honor a late ack when the editor still shows the submitted value.
	// (On the normal fast path `pendingCommit` is still true, so this is skipped.)
	if (!editState.pendingCommit && editState.editEl.value !== editState.submittedRawInput) {
		return;
	}
	clearCommitWatchdog(); // resolved -- cancel the recovery net (cancelEdit below also clears it)
	const row = editState.row;
	const col = editState.col;
	const nav = editState.navAfterCommit;
	errorCells.delete(row + ',' + col); // success -> this cell is no longer errored (per-cell, not blanket)
	cancelEdit();
	if (nav !== undefined) {
		setActiveClamped(row + nav.dr, col + nav.dc);
	}
	redraw();
	viewportEl.focus(); // megaudit LOW: keep keyboard focus on the grid so arrow-nav continues after a commit
}

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data as { type?: unknown } | null;
	if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
		return;
	}
	if (msg.type === 'render') {
		const snapshot = (msg as { snapshot?: unknown }).snapshot;
		if (!isValidSnapshot(snapshot)) {
			const detail =
				snapshot && typeof snapshot === 'object'
					? 'snapshot_format_version=' + String((snapshot as { snapshot_format_version?: unknown }).snapshot_format_version)
					: typeof snapshot;
			console.error('[sheets-webview] dropped a malformed render snapshot:', snapshot);
			showError('The host sent a cell-grid snapshot this view cannot render (' + detail + '). The grid was not updated.', 'transient');
			// Re-audit MED-3: a malformed render must not strand an in-flight commit. We can't apply the
			// snapshot, but we MUST release the editor from `pendingCommit` so Escape/blur/re-edit work
			// again (otherwise the editor is permanently uncancellable). The commit's true fate is unknown
			// -- the banner says the update was dropped; the user can re-check + re-commit.
			if (editState !== null) {
				// Re-audit #2/#3 MED: a malformed render means the grid is STALE (this snapshot was dropped),
				// unlike the watchdog case (where the valid render already arrived). CLEAR the commit token
				// UNCONDITIONALLY -- whether the commit is still pending OR was already recovered by the
				// watchdog (pendingCommit already false) -- so NO genuinely-late `commitResult`/`errorReply`
				// can auto-close the editor (which would clear this "grid was not updated" warning + mask the
				// stale grid). The editor stays open with the warning; the user re-commits (fresh commitId)
				// or Escapes. The pending-specific un-stick stays conditional on `pendingCommit`.
				editState.commitId = undefined;
				editState.submittedRawInput = undefined;
				if (editState.pendingCommit) {
					editState.pendingCommit = false;
					editState.navAfterCommit = undefined;
					editState.editEl.readOnly = false; // megaudit H1: unlock the editor we just un-stuck
					// W-G-1b (Codex MED): refocus the un-stuck editor, mirroring the watchdog + errorReply
					// recovery paths. The document keyhandler is inert while `editState !== null`, so without
					// this an editor un-stuck after a blur-commit (focus already left the input) would strand
					// the keyboard until a mouse click. Matters most for the formula bar (a bare bar gives no
					// visual "still editing" cue); also closes the same latent gap for the overlay.
					editState.editEl.focus();
					clearCommitWatchdog(); // we un-stuck manually -- the watchdog is no longer needed
				}
			}
			return;
		}
		// W-G bound-cell indicator: validate + rebuild the published-cell badges for this sheet BEFORE
		// applying the snapshot, so the same render paints both. A change in the set forces a full redraw.
		const publishedChanged = rebuildPublishedRanges((msg as { publishedCells?: unknown }).publishedCells);
		applyRender(snapshot, publishedChanged);
		return;
	}
	if (msg.type === 'commitResult') {
		// FE-2-0 Phase 2: the host's success ack for a tokened commit -- resolve exactly that edit.
		// Megaudit MED: require `ok === true` AND an integer commitId -- a `{ ok:false }` or NaN-id ack must
		// NOT resolve an edit as successful (it would close the editor + nav as if the write landed).
		const cr = msg as CommitResultMessage;
		// megaudit (webview-instance token, 2026-06-09) -- reload-race guard: a commitResult from a PRE-reload
		// generation carries the OLD instance id, and its numeric commitId (reset to 0 on reload) could collide
		// with a fresh edit's token -> drop it so a stale ack can't resolve/close the wrong edit. Present-but-
		// mismatched only; absent webviewId = the pre-token wire / tests, processed as before (back-compat).
		if (cr.webviewId !== undefined && cr.webviewId !== WEBVIEW_ID) {
			return;
		}
		if (cr.ok === true && typeof cr.commitId === 'number' && Number.isInteger(cr.commitId)) {
			resolvePendingCommit(cr.commitId);
		} else {
			// A malformed ack (version skew / tamper) must NOT be silently dropped -- surface it (No-Fallbacks).
			// The editor stays pending until the watchdog recovers it.
			console.warn('[sheets-webview] ignored a malformed commitResult (need ok:true + integer commitId):', cr);
		}
		return;
	}
	if (msg.type === 'cellsWritten') {
		// megaudit (webview-instance token, 2026-06-09): the host's report of the cells a SUCCESSFUL putCells
		// (paste/fill) wrote. Clear each listed cell's error tint even when stored content did not change (a
		// content-identical render would miss it). Drop the report unless it carries THIS webview's instance id
		// (a stale post-reload report carries the old id) AND the CURRENT sheet (a cross-sheet report would
		// clear the wrong sheet's tint -- errorCells is keyed row,col only). Only a SUCCESS produces this
		// message, so clearing here can never mask a failed write (No-Fallbacks).
		const cw = msg as CellsWrittenMessage;
		if (cw.webviewId !== WEBVIEW_ID || fullSnapshot === null || cw.sheet !== fullSnapshot.sheet || !Array.isArray(cw.cells)) {
			return;
		}
		let cleared = false;
		for (const cell of cw.cells) {
			if (cell && typeof cell.row === 'number' && typeof cell.col === 'number' && errorCells.delete(cell.row + ',' + cell.col)) {
				cleared = true;
			}
		}
		if (cleared) {
			redraw();
		}
		return;
	}
	if (msg.type === 'validateFormulaResult') {
		// W2 formula intelligence: the host's reply to a debounced validateFormula. Drop a stale reply (a
		// later keystroke already superseded it -> its reqId != the latest we sent) or a reply from a PRE-
		// reload generation (webviewId mismatch) so an outdated diagnostic can't flash. Present-but-mismatched
		// webviewId only; absent = pre-token wire / tests.
		const vr = msg as {
			reqId?: unknown; ok?: unknown; diagnostics?: unknown; error?: unknown; webviewId?: unknown;
		};
		if (typeof vr.webviewId === 'string' && vr.webviewId !== WEBVIEW_ID) {
			return;
		}
		if (typeof vr.reqId !== 'number' || vr.reqId !== latestValidateReqId) {
			return; // a superseded (stale) validate -- the user kept typing
		}
		// Codex MED: pass `diagnostics` RAW (unknown) so applyValidationResult can No-Fallbacks-reject an
		// `ok:true` reply that lacks a real array (rather than this pre-coercing a bad value to []/valid).
		applyValidationResult(
			vr.ok === true,
			vr.diagnostics,
			typeof vr.error === 'string' ? vr.error : undefined,
		);
		return;
	}
	if (msg.type === 'functionList') {
		// W2 formula intelligence: the host's reply with the function catalog for completions. Drop a stale /
		// pre-reload reply. On `ok:false` (the engine threw), leave the catalog null so no dropdown ever opens
		// (No-Fallbacks: no fabricated list); surface the reason on the console.
		const fl = msg as {
			reqId?: unknown; ok?: unknown; functions?: unknown; error?: unknown; webviewId?: unknown;
		};
		if (typeof fl.webviewId === 'string' && fl.webviewId !== WEBVIEW_ID) {
			return;
		}
		if (typeof fl.reqId !== 'number' || fl.reqId !== latestFuncReqId) {
			return;
		}
		if (fl.ok !== true || !Array.isArray(fl.functions)) {
			console.warn('[sheets-webview] listFunctions failed; completions disabled:', fl.error);
			// Allow a future re-request (e.g. the next time the bar is focused) by re-arming the flag.
			functionListRequested = false;
			return;
		}
		const metas = fl.functions as FunctionMetadataJson[];
		// Build the lean completion list + the by-name metadata map for the signature hint. Defensive: skip a
		// malformed entry rather than throw on the whole catalog.
		const catalog: CompletionFunction[] = [];
		const byName = new Map<string, FunctionMetadataJson>();
		const wellFormed: { meta: FunctionMetadataJson; aliases: string[] }[] = [];
		for (const meta of metas) {
			if (meta === null || typeof meta !== 'object' || typeof meta.canonicalName !== 'string' || meta.canonicalName.length === 0) {
				continue;
			}
			const aliases = Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === 'string') : [];
			catalog.push({
				canonicalName: meta.canonicalName,
				displayName: typeof meta.displayName === 'string' ? meta.displayName : undefined,
				aliases,
			});
			wellFormed.push({ meta, aliases });
		}
		// **Codex LOW fold**: index canonical names FIRST (a canonical name always wins), THEN aliases (so the
		// signature hint resolves when a completion inserted an alias, e.g. `AVG(` -> AVERAGE's signature).
		// Two-pass so a canonical name that collides with another function's alias is never shadowed; an
		// alias-vs-alias collision is first-wins (deterministic given the engine sorts ascending by name).
		for (const { meta } of wellFormed) {
			byName.set(meta.canonicalName.toUpperCase(), meta);
		}
		for (const { meta, aliases } of wellFormed) {
			for (const alias of aliases) {
				const key = alias.toUpperCase();
				if (!byName.has(key)) {
					byName.set(key, meta);
				}
			}
		}
		functionCatalog = catalog;
		functionMetaByName = byName;
		// If the bar is already editing, refresh the affordances now that the catalog is live (the user may
		// have typed a prefix before the catalog arrived).
		if (formulaBarIsEditing()) {
			updateCompletion(false);
			updateSignatureHint();
		}
		return;
	}
	if (msg.type === 'errorReply') {
		const er = msg as ErrorReplyMessage;
		// megaudit (webview-instance token, 2026-06-09) -- reload-race guard: a stale PRE-reload errorReply
		// carries the OLD instance id; its commitId (reset on reload) could un-stick a fresh edit, and its
		// (sheet,row,col) could tint a live cell. Drop it before BOTH the tint and the un-stick below.
		// Present-but-mismatched only; absent = the pre-token wire / tests (processed as before).
		if (er.webviewId !== undefined && er.webviewId !== WEBVIEW_ID) {
			return;
		}
		const prevErrorKeys = new Set(errorCells.keys()); // Phase 3: for the error-tint flip diff
		let activeMoved = false; // re-audit LOW: a selection realign below needs a FULL redraw, not a tint-flip damage
		// Megaudit MED + re-audit LOW: only tint when sheet/row/col are REAL integers (NOT `Number()`-coerced
		// -- `''`/`null` would coerce to 0 and wrongly tint A1) AND the sheet is the CURRENT one AND the coord
		// is in the A1 extent. A stale/cross-sheet/malformed reply must never tint. The un-stick below is
		// independent of whether we tint (it keys only on commitId).
		const tintable =
			fullSnapshot !== null &&
			typeof er.sheet === 'number' && er.sheet === fullSnapshot.sheet &&
			typeof er.row === 'number' && typeof er.col === 'number' &&
			isInExtent(er.row, er.col);
		if (tintable) {
			errorCells.set(er.row + ',' + er.col, '[' + String(er.code) + '] ' + String(er.message));
		}
		// FE-2-0 Phase 2: un-stick the in-flight edit ONLY when the reply's commitId matches THIS edit's
		// token (replaces the M8 (sheet,row,col) match -- a unique token can't collide). The matched edit
		// stays OPEN for correction + re-commit; the cell is decorated above regardless of the match.
		// Match the normal in-flight case (pendingCommit) OR a genuinely-LATE failure after the watchdog
		// recovered the edit, but ONLY if the user hasn't edited since submit (re-audit #2 LOW -- mirrors
		// the success-ack guard in resolvePendingCommit). A late error on an edited value just tints; an
		// edit recovered via a MALFORMED render cleared its commitId above, so it won't match here either.
		if (
			editState !== null &&
			typeof er.commitId === 'number' &&
			editState.commitId === er.commitId &&
			(editState.pendingCommit || editState.editEl.value === editState.submittedRawInput)
		) {
			editState.pendingCommit = false;
			editState.navAfterCommit = undefined; // the commit failed -- do not advance the selection
			editState.lastFailedRawInput = editState.editEl.value; // megaudit B2: a nav key may now leave the bad cell
			editState.editEl.readOnly = false; // H1: unlock for correction
			clearCommitWatchdog(); // the host responded (with a failure) -- no recovery needed
			// **Audit LOW (2026-06-05)**: realign the selection with the editor demanding attention. A
			// blur-commit can fail AFTER a click moved `active` to another cell -- without this, the editor
			// refocuses on the failed cell while the selection box paints the clicked one (keyboard edits would
			// apply to the editor's cell, not the painted selection). Put `active` back on the edited cell.
			// re-audit LOW: if this actually MOVES the selection, the tint-flip damage path below is
			// insufficient (it wouldn't clear the old selection box / draw the new one), so force a full redraw.
			if (active === null || active.row !== editState.row || active.col !== editState.col) {
				activeMoved = true;
			}
			// W-G-2a: this is a single-cell realign onto the failed edit cell; clear any anchor a shift-click
			// set while the commit was pending, else it would resurrect as a range on the redraw below
			// (Codex W-G-2a re-audit LOW). Edits are single-cell, so collapsing here is always correct.
			// Codex re-audit #3: clearing the anchor REMOVES a painted range -- but the row-only `drawDamage`
			// fast path below clips to the error rows and can't erase range fill on other rows. So if a range
			// was visible, force the full-redraw path (treat it like an `activeMoved`).
			if (currentSelection() !== null) {
				activeMoved = true;
			}
			anchor = null;
			active = { row: editState.row, col: editState.col };
			ensureActiveVisible();
			updateEditClip(); // megaudit LOW: ensureActiveVisible may have scrolled -- re-clip the still-open editor
			// Megaudit B2: refocus + select so a retype REPLACES the bad value, and surface the way out
			// (the user reflexively tries arrows/Tab -- those now leave the cell; spell it out anyway).
			editState.editEl.focus();
			editState.editEl.select();
			showError(
				'Cell rejected -- [' + String(er.code) + '] ' + String(er.message) +
				'. Fix it and press Enter, or press Esc / an arrow key to discard.',
				'edit',
			);
		}
		// **FE-2-0 Phase 3 / FE-2 BAKEOFF** -- damage only the rows whose error tint FLIPPED (the rare
		// failed-edit path), at the same scroll; else a full `redraw()`. Re-erroring an already-tinted cell
		// flips nothing -> [] -> a no-op (the tint + the tooltip-on-hover are already correct). The gate +
		// the `errorRowsFlippedA1` diff live in the orchestrator now; `activeMoved` (the selection-realign
		// decision, computed above from this file's edit/selection state) forces the full path.
		orchestrator.commitErrorDamage(prevErrorKeys, activeMoved);
		return;
	}
	if (msg.type === 'freeze') {
		// **W3 frozen panes** -- the host's "Freeze Panes at Selection" / "Unfreeze" command. Set the pinned
		// row/col counts and FULL-redraw (the geometry changed; the damage/blit fast paths assume a stable
		// freeze). `renderer.setFrozen` CLAMPS to sane integers in `[0, MAX-1]` (defence in depth at the trust
		// boundary). **Codex MED-1 (No-Fallbacks)**: a MALFORMED envelope (rows/cols not finite numbers) is a
		// host/webview WIRING bug, not a freeze of 0 -- so surface it LOUD and leave the CURRENT freeze state
		// UNCHANGED rather than silently unfreezing (which would mask the bug + lose the user's freeze).
		// **Codex MED-4**: require non-negative INTEGERS, not merely finite numbers. The host always sends
		// `Math.floor`-ed counts, so a fractional value (e.g. 1.5) is a wiring bug -- `clampFrozenCount` would
		// silently coerce it to 0 (a stealth unfreeze). Reject it LOUD + leave the freeze unchanged, same as
		// a non-finite value (No-Fallbacks: surface the bad wire, don't mask it as "freeze 0").
		const fz = msg as { rows?: unknown; cols?: unknown };
		if (
			typeof fz.rows !== 'number' || !Number.isInteger(fz.rows) || fz.rows < 0 ||
			typeof fz.cols !== 'number' || !Number.isInteger(fz.cols) || fz.cols < 0
		) {
			console.warn('[sheets-webview] dropped a malformed freeze message (rows/cols must be non-negative integers):', msg);
			showError('The host sent a malformed Freeze Panes command; the freeze was not changed.', 'transient');
			return;
		}
		renderer.setFrozen(fz.rows, fz.cols);
		// A freeze shifts every cell's pane, so an open overlay editor must be re-pinned + its clip recomputed
		// (a frozen cell's editor pins; a cell now under a frozen band clips there). repositionEdit handles both.
		repositionEdit();
		redraw();
		return;
	}
	console.warn('[sheets-webview] unknown inbound message type:', msg.type);
});

// **Megaudit B1**: pin the canvas to the viewport SYNCHRONOUSLY on every scroll event. The canvas is an
// absolutely-positioned child of the scroller, so it scrolls natively with the content; the compensating
// `translate(scrollLeft, scrollTop)` MUST be written in the scroll event, not deferred to the rAF -- else
// the sticky header/gutter (painted at canvas-local 0) lag the native scroll by up to one frame and visibly
// shake. The expensive blit/redraw stays rAF-coalesced via scheduleRedraw (the body's <=1-frame latency is
// imperceptible; a jittering sticky band is not). The content-anchored `<input>` scrolls with the content,
// so {@link updateEditClip} is called SYNCHRONOUSLY below (FE-2-0 polish 2026-06-05, resolving the former
// MED-5) to clip the open editor to the body pane as it scrolls under the sticky header/gutter bands.
viewportEl.addEventListener('scroll', () => {
	applyCanvasTransform(viewportEl.scrollTop, viewportEl.scrollLeft);
	// FE-2-0 polish: keep the open editor's body-pane clip in lockstep with the scroll (SYNCHRONOUSLY, like
	// the canvas pin above) so the editor never momentarily slides un-clipped over the sticky bands.
	// W3 frozen panes (Codex HIGH-2): repositionEdit re-PINS a frozen-cell editor as the body scrolls (it adds
	// back the live frozen-axis scroll); for a body-cell editor it writes the same content position (a no-op)
	// and re-clips. So this both pins the frozen case and keeps the body-pane clip in lockstep.
	if (editState !== null) {
		repositionEdit();
	}
	scheduleRedraw();
});

// Repaint on viewport resize. Megaudit (Opus-1): route through the SAME coalescing scheduler as scroll so a
// simultaneous resize+scroll is ONE rAF, not two competing repaints. `scrollRedraw` resize()s first and
// falls back to a full draw whenever the backing store changed (it does on a real resize), so a pure resize
// still fully repaints; a same-size "resize" with no scroll delta cleanly no-ops to a full draw.
if (typeof ResizeObserver !== 'undefined') {
	new ResizeObserver(() => scheduleRedraw()).observe(viewportEl);
}

// Full redraw on theme change: refresh the cached palette/fonts/gutter, reposition an open editor (the
// gutter width may have changed -> every cell's x shifts, Audit LOW-7), re-size the spacer, repaint.
new MutationObserver(() => {
	renderer.refreshTheme();
	repositionEdit();
	updateSpacer();
	redraw();
	// Audit re-audit LOW: watch the theme-id/kind attributes too, not just `class`. VS Code switches
	// between themes of the SAME kind (e.g. Dark+ -> another dark theme) by changing `data-vscode-theme-id`
	// + the CSS vars WITHOUT changing the `vscode-dark` body class; a `class`-only observer would miss it
	// and (now that applyRender no longer refreshes per render) leave the palette/fonts stale.
}).observe(document.body, {
	attributes: true,
	attributeFilter: ['class', 'data-vscode-theme-id', 'data-vscode-theme-kind', 'data-vscode-theme-name'],
});

// Initial spacer sizing (before the first render).
updateSpacer();

// Handshake: announce the channel is live so the host (re)sends the snapshot.
vscode.postMessage({ type: 'webviewReady' });
