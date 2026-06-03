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
 * Wire protocol UNCHANGED from FE-0b (host `cellGridPanel.ts` is untouched):
 *   host -> webview: `{type:'render', snapshot}`, `{type:'errorReply', sheet,row,col,code,message}`
 *   webview -> host: `{type:'putValue', sheet,row,col,rawInput}`, `{type:'undo'}`, `{type:'redo'}`,
 *                    `{type:'webviewReady'}` (once on load).
 *
 * Side-effecting entry (no top-level exports) so the esm bundle loads via a classic `<script>`.
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { formatCellValue } from './cellRender';
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
	totalContentHeight,
	totalContentWidth,
} from './gridLayoutA1';

/** Minimal VS Code webview API surface (mirrors qviz-spec/index.ts). */
interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;

/** host -> webview: full sheet snapshot to paint. */
interface RenderMessage {
	readonly type: 'render';
	readonly snapshot: QuantbookCellSnapshot;
}
/** host -> webview: a failed edit; decorate the offending cell. */
interface ErrorReplyMessage {
	readonly type: 'errorReply';
	readonly sheet: number;
	readonly row: number;
	readonly col: number;
	readonly code: string;
	readonly message: string;
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
	'<div class="cell-grid-viewport" id="sheets-viewport" tabindex="0">' +
	'<div id="sheets-spacer"></div>' +
	'<canvas id="sheets-canvas"></canvas>' +
	'<input id="sheets-edit-input" class="cell-edit-input" type="text" aria-label="Edit cell value" hidden />' +
	'</div>';

const titleEl = document.getElementById('sheets-title') as HTMLElement;
const metaEl = document.getElementById('sheets-meta') as HTMLElement;
const viewportEl = document.getElementById('sheets-viewport') as HTMLElement;
const spacerEl = document.getElementById('sheets-spacer') as HTMLElement;
const canvasEl = document.getElementById('sheets-canvas') as HTMLCanvasElement;
const inputEl = document.getElementById('sheets-edit-input') as HTMLInputElement;

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
	// FE megaudit M8: the (sheet,row,col) identity of the in-flight commit, so a late errorReply for a
	// PREVIOUS edit can't mutate the CURRENT edit's state. Undefined until commitEdit() fires.
	commitSheet?: number;
	commitRow?: number;
	commitCol?: number;
	// Where to move the selection after THIS commit's success render acks (Enter=down, Tab=right, …).
	navAfterCommit?: { dr: number; dc: number };
}
let editState: EditState | null = null;

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

/** Scroll so the active cell is fully visible below the header band + right of the row gutter. */
function ensureActiveVisible(): void {
	if (active === null) {
		return;
	}
	const gutterW = renderer.gutterWidthPx;
	const cellLeft = colX(active.col, gutterW);
	const cellTop = rowY(active.row);
	const localLeft = cellLeft - viewportEl.scrollLeft;
	if (localLeft < gutterW) {
		viewportEl.scrollLeft = cellLeft - gutterW;
	} else if (localLeft + COL_WIDTH > viewportEl.clientWidth) {
		viewportEl.scrollLeft = cellLeft + COL_WIDTH - viewportEl.clientWidth;
	}
	const localTop = cellTop - viewportEl.scrollTop;
	if (localTop < HEADER_HEIGHT) {
		viewportEl.scrollTop = cellTop - HEADER_HEIGHT;
	} else if (localTop + ROW_HEIGHT > viewportEl.clientHeight) {
		viewportEl.scrollTop = cellTop + ROW_HEIGHT - viewportEl.clientHeight;
	}
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
	const entry = renderer.entryAt(row, col);
	const rect = cellContentRect(row, col, renderer.gutterWidthPx);
	inputEl.style.left = rect.x + 'px';
	inputEl.style.top = rect.y + 'px';
	inputEl.style.width = rect.width + 'px';
	inputEl.style.height = rect.height + 'px';
	if (initialChar !== undefined) {
		inputEl.value = initialChar; // type-to-edit: overwrite, cursor at end (no select)
	} else if (entry !== undefined) {
		// Formula text (re-add the leading `=` the host dispatch keys on) over the value-default literal.
		inputEl.value = typeof entry.formula === 'string' ? '=' + entry.formula : formatCellValue(entry.value);
	} else {
		inputEl.value = ''; // empty cell
	}
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

/** Commit the edit; `nav` (optional) moves the selection once the success render acks. */
function commitEdit(nav?: { dr: number; dc: number }): void {
	if (editState === null || fullSnapshot === null) {
		return;
	}
	if (editState.pendingCommit) {
		return; // a commit is already in flight
	}
	const sheet = fullSnapshot.sheet;
	const row = editState.row;
	const col = editState.col;
	editState.pendingCommit = true;
	editState.commitSheet = sheet;
	editState.commitRow = row;
	editState.commitCol = col;
	editState.navAfterCommit = nav;
	// Pessimistic: keep the input visible/focused until the host responds. A success `render` hides it
	// (applyRender -> cancelEdit) + applies `nav`; an `errorReply` decorates the cell + leaves it open.
	vscode.postMessage({ type: 'putValue', sheet, row, col, rawInput: inputEl.value });
}

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
			title = errorCells.get(key) ?? (entry && typeof entry.diagnostic === 'string' ? entry.diagnostic : '');
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
 * Apply a fresh snapshot: update title/meta + spacer, resolve any in-flight commit (close the editor
 * + apply its nav), then full-redraw. A SIBLING render mid-edit (no pending commit of ours) preserves
 * the open editor (FE re-audit MED-1) -- the canvas repaints underneath it.
 */
function applyRender(snapshot: QuantbookCellSnapshot): void {
	fullSnapshot = snapshot;
	renderer.setSnapshot(snapshot);

	// Audit MED-2 (known limitation, inherited from FE-0b; structural): a `render` carries NO cell
	// identity, so a SIBLING-panel commit on the same session (which re-renders every panel, M1) can
	// resolve THIS panel's in-flight commit early -- closing the editor + applying its nav before our
	// own putValue is processed. Non-data-losing (our putValue is still queued) but a premature
	// editor-close + nav glitch with multi-panel-same-session. The fix (a monotonic commit token echoed
	// by the host) needs a host wire-protocol change, deferred to the gridBlitA1.ts fast-follow.
	const wasOurCommit = editState !== null && editState.pendingCommit;
	let navRow = 0;
	let navCol = 0;
	let hasNav = false;
	if (wasOurCommit && editState !== null) {
		const nav = editState.navAfterCommit;
		if (nav !== undefined) {
			navRow = editState.row + nav.dr;
			navCol = editState.col + nav.dc;
			hasNav = true;
		}
	}
	if (editState === null || editState.pendingCommit) {
		cancelEdit();
		errorCells.clear();
	}
	if (hasNav) {
		setActiveClamped(navRow, navCol);
	}

	// Audit LOW-3: do NOT refreshTheme() here -- a render is not a theme change. Theme/font changes are
	// handled by the body-class MutationObserver (and the initial read is in the renderer constructor);
	// refreshing per render needlessly cleared the measure cache + recomputed the gutter every snapshot.
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent =
		'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	updateSpacer();
	redraw();
}

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data as { type?: unknown } | null;
	if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
		return;
	}
	if (msg.type === 'render') {
		applyRender((msg as RenderMessage).snapshot);
		return;
	}
	if (msg.type === 'errorReply') {
		const er = msg as ErrorReplyMessage;
		errorCells.set(Number(er.row) + ',' + Number(er.col), '[' + String(er.code) + '] ' + String(er.message));
		// FE megaudit M8: only clear pendingCommit when the reply matches the CURRENT in-flight edit's
		// cell identity. The matched edit stays open for correction + re-commit.
		if (
			editState !== null &&
			editState.pendingCommit &&
			editState.commitSheet === Number(er.sheet) &&
			editState.commitRow === Number(er.row) &&
			editState.commitCol === Number(er.col)
		) {
			editState.pendingCommit = false;
			editState.navAfterCommit = undefined; // the commit failed -- do not advance the selection
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
