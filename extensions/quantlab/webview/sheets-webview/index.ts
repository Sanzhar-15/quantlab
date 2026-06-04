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
 * **Full redraw only** (FE-2-0): every scroll / commit / nav repaints the whole visible window. The
 * FE-0b-4/5 blit + damage-clip machinery is entry-index-keyed and returns as a `gridBlitA1.ts`
 * fast-follow.
 *
 * Wire protocol (**FE-2-0 Phase 2 commit-token** added a per-commit ack; the host `cellGridPanel.ts` +
 * `cellGridLogic.ts` changed to match -- the webview's local message interfaces here MUST stay in sync):
 *   host -> webview: `{type:'render', snapshot}`,
 *                    `{type:'errorReply', sheet,row,col,code,message, commitId?}`,
 *                    `{type:'commitResult', commitId, ok:true}` (Phase 2 -- success ack to THIS panel).
 *   webview -> host: `{type:'putValue', sheet,row,col,rawInput, commitId?}` (Phase 2 -- the token),
 *                    `{type:'undo'}`, `{type:'redo'}`, `{type:'webviewReady'}` (once on load).
 *   Resolution: a pending edit closes ONLY on a matching `commitResult`/`errorReply` (by commitId) or the
 *   commit-watchdog timeout -- NEVER on a bare `render` (which is why a sibling render can't false-ack).
 *
 * Side-effecting entry (no top-level exports) so the esm bundle loads via a classic `<script>`.
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { clampDisplayString, formatCellValue } from './cellRender';
import { CanvasGridRenderer, type ActiveCell } from './canvasGrid';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	ROW_HEIGHT,
	cellContentRect,
	colX,
	hitTestViewport,
	rowY,
	scrollToReveal,
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
}

/** host -> the originating webview: success ack for a tokened commit (FE-2-0 Phase 2 commit-token). */
interface CommitResultMessage {
	readonly type: 'commitResult';
	readonly commitId: number;
	readonly ok: true;
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
	'<div class="cell-grid-viewport" id="sheets-viewport" tabindex="0">' +
	'<div id="sheets-spacer"></div>' +
	'<canvas id="sheets-canvas"></canvas>' +
	'<input id="sheets-edit-input" class="cell-edit-input" type="text" aria-label="Edit cell value" hidden />' +
	'</div>';

const titleEl = document.getElementById('sheets-title') as HTMLElement;
const metaEl = document.getElementById('sheets-meta') as HTMLElement;
const errorEl = document.getElementById('sheets-error') as HTMLElement;
const viewportEl = document.getElementById('sheets-viewport') as HTMLElement;
const spacerEl = document.getElementById('sheets-spacer') as HTMLElement;
const canvasEl = document.getElementById('sheets-canvas') as HTMLCanvasElement;
const inputEl = document.getElementById('sheets-edit-input') as HTMLInputElement;

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
// The active (selected) cell. Starts at A1 (like Excel) so the grid always shows a selection.
let active: ActiveCell | null = { row: 0, col: 0 };

interface EditState {
	row: number;
	col: number;
	// The populated entry under the cell at edit-start (formula/value pre-fill); undefined for an empty cell.
	readonly entry?: QuantbookCellSnapshot['entries'][number];
	pendingCommit: boolean;
	// FE-2-0 Phase 2 (commit-token): the unique id of THIS in-flight commit, stamped by commitEdit and
	// echoed by the host in `commitResult` (success) / `errorReply` (failure). Replaces the FE megaudit
	// M8 (sheet,row,col) match -- a monotonic token can't collide, and (the HIGH this kills) a bare
	// `render` no longer resolves a pending edit, so a sibling-panel/refresh render can't falsely close
	// this editor. Undefined until commitEdit() fires.
	commitId?: number;
	// Where to move the selection once THIS commit's matching commitResult arrives (Enter=down, Tab=right).
	navAfterCommit?: { dr: number; dc: number };
}
let editState: EditState | null = null;
// FE-2-0 Phase 2: monotonic source of per-commit ids (never reused within a webview lifetime).
let nextCommitId = 0;
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

interface Viewport {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly cssW: number;
	readonly cssH: number;
}
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

/** Size the in-flow spacer to the full Excel extent (drives the native scrollbars). */
function updateSpacer(): void {
	spacerEl.style.height = totalContentHeight() + 'px';
	spacerEl.style.width = totalContentWidth(renderer.gutterWidthPx) + 'px';
}

/** Full redraw at the current viewport (the only paint path in FE-2-0). */
function redraw(): void {
	const v = currentViewport();
	renderer.resize(v.cssW, v.cssH);
	applyCanvasTransform(v.scrollTop, v.scrollLeft);
	renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells, active);
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
		redraw();
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
 * park the cell under the sticky band) lives in the pure {@link scrollToReveal}. */
function ensureActiveVisible(): void {
	if (active === null) {
		return;
	}
	const gutterW = renderer.gutterWidthPx;
	viewportEl.scrollLeft = scrollToReveal(
		colX(active.col, gutterW),
		COL_WIDTH,
		gutterW,
		viewportEl.scrollLeft,
		viewportEl.clientWidth,
	);
	viewportEl.scrollTop = scrollToReveal(
		rowY(active.row),
		ROW_HEIGHT,
		HEADER_HEIGHT,
		viewportEl.scrollTop,
		viewportEl.clientHeight,
	);
}

/** Move the selection by (dr,dc), scroll it into view, repaint. No-op while editing. */
function moveActive(dr: number, dc: number): void {
	const base = active ?? { row: 0, col: 0 };
	active = { row: clampRow(base.row + dr), col: clampCol(base.col + dc) };
	ensureActiveVisible();
	redraw();
}

/** Set the selection to an absolute (clamped) cell + scroll it into view (used after a commit nav). */
function setActiveClamped(row: number, col: number): void {
	active = { row: clampRow(row), col: clampCol(col) };
	ensureActiveVisible();
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
	errorCells.delete(active.row + ',' + active.col);
	vscode.postMessage({ type: 'putValue', sheet: fullSnapshot.sheet, row: active.row, col: active.col, rawInput: '' });
	redraw();
}

// --- Overlay editor ---

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
	active = { row, col };
	// Audit O2-MED2: F2 / type-to-edit on a scrolled-away active cell must bring it into view first,
	// otherwise the overlay editor opens off-screen (content-layer child positioned at the cell rect).
	ensureActiveVisible();
	const entry = renderer.entryAt(row, col);
	// Compute the pre-fill BEFORE touching the DOM. Re-audit HIGH-2: a malformed/drifted snapshot can
	// carry a multi-MB value/formula; assigning it to `inputEl.value` + `select()` would freeze the
	// webview (the canvas measure path is capped, but the editor is a real <input>). Such a value also
	// could never be committed (the host + client cap rawInput at MAX_RAW_INPUT_LENGTH). So we refuse to
	// open the editor and surface a visible error -- No-Fallbacks: we do NOT silently truncate the value.
	let prefill: string;
	if (initialChar !== undefined) {
		prefill = initialChar; // type-to-edit: a single char, never oversize
	} else if (entry !== undefined) {
		// Formula text (re-add the leading `=` the host dispatch keys on) over the value-default literal.
		prefill = typeof entry.formula === 'string' ? '=' + entry.formula : formatCellValue(entry.value);
	} else {
		prefill = ''; // empty cell
	}
	if (prefill.length > MAX_RAW_INPUT_LENGTH) {
		showError(
			`This cell's value is ${prefill.length} characters, over the ${MAX_RAW_INPUT_LENGTH}-character ` +
			`editable limit, so it cannot be edited here. (The cell selection is unchanged.)`,
			'transient',
		);
		redraw();
		return; // leave the cell selected (active set above) but do NOT open the editor
	}
	const rect = cellContentRect(row, col, renderer.gutterWidthPx);
	inputEl.style.left = rect.x + 'px';
	inputEl.style.top = rect.y + 'px';
	inputEl.style.width = rect.width + 'px';
	inputEl.style.height = rect.height + 'px';
	inputEl.value = prefill;
	inputEl.hidden = false;
	editState = { row, col, entry, pendingCommit: false };
	inputEl.focus();
	if (initialChar === undefined) {
		inputEl.select();
	}
}

function cancelEdit(): void {
	if (editState === null) {
		return;
	}
	editState = null;
	inputEl.hidden = true;
	inputEl.value = '';
	clearCommitWatchdog(); // the editor is gone -- no pending commit to recover (re-audit HIGH)
	clearError(); // closing the editor resolves any 'edit'-source banner (re-audit MED-4)
}

/** Re-position the open editor over its cell. Audit LOW-7: the gutter width can change on a theme/font
 * change, which shifts every cell's x -- a preserved editor must follow or it misaligns. */
function repositionEdit(): void {
	if (editState === null) {
		return;
	}
	const rect = cellContentRect(editState.row, editState.col, renderer.gutterWidthPx);
	inputEl.style.left = rect.x + 'px';
	inputEl.style.top = rect.y + 'px';
	inputEl.style.width = rect.width + 'px';
	inputEl.style.height = rect.height + 'px';
}

/** Commit the edit; `nav` (optional) moves the selection once the matching `commitResult` arrives. */
function commitEdit(nav?: { dr: number; dc: number }): void {
	if (editState === null || fullSnapshot === null) {
		return;
	}
	if (editState.pendingCommit) {
		return; // a commit is already in flight
	}
	// Audit C1-MED6: reject an over-length input HERE (visible error, editor stays open for the user to
	// shorten) rather than serialize a multi-MB payload across the bridge for the host to reject anyway.
	if (inputEl.value.length > MAX_RAW_INPUT_LENGTH) {
		showError(
			`Cell value is ${inputEl.value.length} characters, over the ${MAX_RAW_INPUT_LENGTH}-character limit. ` +
			`Shorten it and commit again.`,
			'edit',
		);
		return;
	}
	clearError();
	const sheet = fullSnapshot.sheet;
	const row = editState.row;
	const col = editState.col;
	const commitId = ++nextCommitId; // FE-2-0 Phase 2: stamp a unique token for THIS commit
	editState.pendingCommit = true;
	editState.commitId = commitId;
	editState.navAfterCommit = nav;
	armCommitWatchdog(commitId); // re-audit HIGH: recover the editor if no commitResult/errorReply arrives
	// Pessimistic: keep the input visible/focused until the host responds. FE-2-0 Phase 2: resolution is
	// now driven ONLY by a matching `commitResult` (success -> resolvePendingCommit hides the editor +
	// applies `nav`) or `errorReply` (failure -> decorate the cell + leave the editor open). A bare
	// `render` no longer resolves -- so a sibling-panel render can't falsely close this editor.
	vscode.postMessage({ type: 'putValue', sheet, row, col, rawInput: inputEl.value, commitId });
}

// Re-audit MED-4: clear the over-length ('edit') banner as soon as the user shortens the value back to
// the cap, so the guidance disappears the moment it no longer applies (instead of lingering until the
// next commit/cancel).
inputEl.addEventListener('input', () => {
	if (errorSource === 'edit' && inputEl.value.length <= MAX_RAW_INPUT_LENGTH) {
		clearError();
	}
});
inputEl.addEventListener('keydown', ev => {
	// Audit MED-4: while an IME composition is active, Enter/Tab ACCEPT the candidate -- they must not
	// commit/move the cell. Let the input handle composition natively until it completes.
	if (ev.isComposing || ev.keyCode === 229) {
		return;
	}
	if (ev.key === 'Enter') {
		ev.preventDefault();
		commitEdit({ dr: 1, dc: 0 }); // Excel: Enter commits + moves down
	} else if (ev.key === 'Tab') {
		ev.preventDefault();
		commitEdit({ dr: 0, dc: ev.shiftKey ? -1 : 1 }); // Tab commits + moves right (Shift+Tab left)
	} else if (ev.key === 'Escape') {
		ev.preventDefault();
		// Audit O2-MED1: Escape is inert while a commit is in flight (matches commitEdit/blur). Cancelling
		// here would NOT recall the already-posted putValue but WOULD wipe editState -- enabling a
		// same-cell double-put and dropping the host's pending reply on the floor.
		if (editState !== null && editState.pendingCommit) {
			return;
		}
		cancelEdit();
		redraw();
		viewportEl.focus();
	}
});
inputEl.addEventListener('blur', () => {
	// Conservative: blur cancels an UNcommitted edit; a pending commit waits for the host's reply.
	if (editState !== null && !editState.pendingCommit) {
		cancelEdit();
		redraw();
	}
});

// --- Canvas click -> hit-test -> select + edit ---

canvasEl.addEventListener('click', ev => {
	if (fullSnapshot === null) {
		return;
	}
	const rect = canvasEl.getBoundingClientRect();
	const localX = ev.clientX - rect.left;
	const localY = ev.clientY - rect.top;
	const hit = hitTestViewport(localX, localY, viewportEl.scrollLeft, viewportEl.scrollTop, renderer.gutterWidthPx);
	if (hit !== null) {
		beginEdit(hit.row, hit.col);
		redraw();
	}
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
		const hit = hitTestViewport(
			hoverClientX - rect.left,
			hoverClientY - rect.top,
			viewportEl.scrollLeft,
			viewportEl.scrollTop,
			renderer.gutterWidthPx,
		);
		if (hit !== null) {
			const entry = renderer.entryAt(hit.row, hit.col);
			const key = hit.row + ',' + hit.col;
			// Audit C1-HIGH2: cap the tooltip string (a pathological diagnostic/error message shouldn't
			// stall the native `title` rendering).
			title = clampDisplayString(
				errorCells.get(key) ?? (entry && typeof entry.diagnostic === 'string' ? entry.diagnostic : ''),
			);
		}
	}
	if (title !== lastHoverTitle) {
		canvasEl.title = title;
		lastHoverTitle = title;
	}
}
canvasEl.addEventListener('mousemove', ev => {
	hoverClientX = ev.clientX;
	hoverClientY = ev.clientY;
	if (hoverScheduled) {
		return;
	}
	hoverScheduled = true;
	requestAnimationFrame(updateHoverTitle);
});

// --- Keyboard: navigation + type-to-edit + undo/redo (only when NOT editing) ---

document.addEventListener('keydown', ev => {
	if (editState !== null) {
		return; // the editor has its own handler
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
		return; // leave other meta combos (copy, etc.) alone
	}
	if (ev.altKey) {
		return;
	}
	// Navigation.
	switch (ev.key) {
		case 'ArrowUp':
			ev.preventDefault();
			moveActive(-1, 0);
			return;
		case 'ArrowDown':
		case 'Enter': // Excel: Enter on a selected cell moves down (typing/F2 edits)
			ev.preventDefault();
			moveActive(1, 0);
			return;
		case 'ArrowLeft':
			ev.preventDefault();
			moveActive(0, -1);
			return;
		case 'ArrowRight':
			ev.preventDefault();
			moveActive(0, 1);
			return;
		case 'Tab':
			ev.preventDefault();
			moveActive(0, ev.shiftKey ? -1 : 1);
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
function applyRender(snapshot: QuantbookCellSnapshot): void {
	// Re-audit MED-4: a valid render supersedes a TRANSIENT banner (malformed-render / un-editable cell)
	// but must NOT hide an active 'edit' banner -- a sibling render repaints under an open editor whose
	// over-length value is still invalid; clearing it would mask the bad pending state until next commit.
	clearTransientError();
	fullSnapshot = snapshot;
	renderer.setSnapshot(snapshot);

	// Audit LOW-3: do NOT refreshTheme() here -- a render is not a theme change. Theme/font changes are
	// handled by the body-class MutationObserver (and the initial read is in the renderer constructor);
	// refreshing per render needlessly cleared the measure cache + recomputed the gutter every snapshot.
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent =
		'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	updateSpacer();
	redraw();
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
	if (editState === null || !editState.pendingCommit || editState.commitId !== commitId) {
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
			if (editState !== null && editState.pendingCommit) {
				editState.pendingCommit = false;
				editState.navAfterCommit = undefined;
				clearCommitWatchdog(); // we un-stuck manually -- the watchdog is no longer needed
			}
			return;
		}
		applyRender(snapshot);
		return;
	}
	if (msg.type === 'commitResult') {
		// FE-2-0 Phase 2: the host's success ack for a tokened commit -- resolve exactly that edit.
		const cr = msg as CommitResultMessage;
		if (typeof cr.commitId === 'number') {
			resolvePendingCommit(cr.commitId);
		} else {
			// Re-audit HIGH: a malformed ack (version skew / tamper) must NOT be silently dropped -- it
			// would leave the editor pending until the watchdog fires. Surface it (No-Fallbacks).
			console.warn('[sheets-webview] commitResult with non-numeric commitId ignored:', cr);
		}
		return;
	}
	if (msg.type === 'errorReply') {
		const er = msg as ErrorReplyMessage;
		errorCells.set(Number(er.row) + ',' + Number(er.col), '[' + String(er.code) + '] ' + String(er.message));
		// FE-2-0 Phase 2: un-stick the in-flight edit ONLY when the reply's commitId matches THIS edit's
		// token (replaces the M8 (sheet,row,col) match -- a unique token can't collide). The matched edit
		// stays OPEN for correction + re-commit; the cell is decorated above regardless of the match.
		if (
			editState !== null &&
			editState.pendingCommit &&
			typeof er.commitId === 'number' &&
			editState.commitId === er.commitId
		) {
			editState.pendingCommit = false;
			editState.navAfterCommit = undefined; // the commit failed -- do not advance the selection
			clearCommitWatchdog(); // the host responded (with a failure) -- no recovery needed
		}
		redraw();
		return;
	}
	console.warn('[sheets-webview] unknown inbound message type:', msg.type);
});

// Repaint on scroll (full redraw; rAF-coalesced). The content-anchored input scrolls with the content.
// Audit MED-5 (known FE-2-0 limitation): the overlay `<input>` is a content-layer child, so scrolling
// WHILE editing can slide it visually over the sticky header/gutter (it commits to the right cell -- not
// data-losing -- it just overlaps the bands). The proper fix (clip the editor to the body pane / hide it
// when its cell moves under a band) is FE-2-proper; editing normally pins the view (you clicked the cell).
viewportEl.addEventListener('scroll', scheduleRedraw);

// Full redraw on viewport resize.
if (typeof ResizeObserver !== 'undefined') {
	new ResizeObserver(() => redraw()).observe(viewportEl);
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
