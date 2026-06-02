/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b-2+3 (2026-06-02) -- bundled sheets webview entry: Canvas2D renderer + overlay editor.**
 *
 * Supersedes the FE-0b-1 DOM table. The sheet snapshot (a list of populated cells) is painted onto
 * a `<canvas>` by {@link CanvasGridRenderer}; geometry comes from the pure `gridLayout.ts`. Editing
 * uses a DOM-overlay `<input>` positioned over the clicked Value cell (folds in FE-0b-3 so editing
 * never regresses).
 *
 * Layout: a scroller (`#sheets-viewport`, overflow:auto) holds an in-flow `#sheets-spacer` sized to
 * the total content (drives the native scrollbar), an absolute `<canvas>` transformed by the scroll
 * offset to overlay the viewport (redrawn on scroll), and an absolute `#sheets-edit-input` in the
 * scroller's CONTENT layer (so it tracks scroll naturally -- no manual reposition).
 *
 * Wire protocol UNCHANGED from FE-0b-1 (host `cellGridPanel.ts` is untouched):
 *   host -> webview: `{type:'render', snapshot}`, `{type:'errorReply', sheet,row,col,code,message}`
 *   webview -> host: `{type:'putValue', sheet,row,col,rawInput}`, `{type:'undo'}`, `{type:'redo'}`,
 *                    `{type:'webviewReady'}` (once on load).
 *
 * Side-effecting entry (no top-level exports) so the esm bundle loads via a classic `<script>`.
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { formatCellValue } from './cellRender';
import { CanvasGridRenderer } from './canvasGrid';
import { cellContentRect, hitTestViewport, totalContentHeight, totalContentWidth } from './gridLayout';

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

const VALUE_COL_INDEX = 2; // only the Value column is editable

// Cache the VS Code API handle on `window`: acquireVsCodeApi() may be called at most ONCE per
// webview context and throws on a second call (the persistent webview could re-evaluate this
// bundle, e.g. "Developer: Reload Webviews"). Mirrors the FE-0b-1 guard.
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
	'<div class="cell-grid-viewport" id="sheets-viewport">' +
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
// "row,col" -> "[code] message" for cells whose last edit failed (errorReply). Map (not Set) so the
// structured error text is preserved + surfaced on hover (parity with the FE-0b-1 DOM title tooltip).
const errorCells = new Map<string, string>();

interface EditState {
	readonly entryIndex: number;
	readonly entry: QuantbookCellSnapshot['entries'][number];
	pendingCommit: boolean;
}
let editState: EditState | null = null;

/** Re-transform the canvas to overlay the viewport at the current scroll, then repaint. */
function redraw(): void {
	const scrollTop = viewportEl.scrollTop;
	const scrollLeft = viewportEl.scrollLeft;
	renderer.resize(viewportEl.clientWidth, viewportEl.clientHeight);
	canvasEl.style.transform = 'translate(' + scrollLeft + 'px, ' + scrollTop + 'px)';
	renderer.draw(viewportEl.clientWidth, viewportEl.clientHeight, scrollTop, scrollLeft, errorCells);
}

/** Apply a fresh snapshot: update title/meta + spacer, clear edit/error state, repaint. */
function applyRender(snapshot: QuantbookCellSnapshot): void {
	fullSnapshot = snapshot;
	renderer.setSnapshot(snapshot);
	// A render is a committed state change (or first paint): drop any in-flight edit + errors.
	cancelEdit();
	errorCells.clear();
	renderer.refreshTheme();
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent = 'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	spacerEl.style.height = totalContentHeight(snapshot.entries.length) + 'px';
	spacerEl.style.width = totalContentWidth() + 'px';
	redraw();
}

// --- Overlay editor ---

function beginEdit(entryIndex: number): void {
	if (fullSnapshot === null) {
		return;
	}
	const entry = fullSnapshot.entries[entryIndex];
	if (entry === undefined) {
		return;
	}
	if (editState !== null) {
		cancelEdit();
	}
	// Position the input over the Value cell in CONTENT coords (it is an absolute child of the
	// scroller, so it scrolls with the grid -- no manual tracking needed).
	const rect = cellContentRect(entryIndex, VALUE_COL_INDEX);
	inputEl.style.left = rect.x + 'px';
	inputEl.style.top = rect.y + 'px';
	inputEl.style.width = rect.width + 'px';
	inputEl.style.height = rect.height + 'px';
	// Edit source precedence: formula text (if any) over the value-default literal -- matches the
	// FE-0b-1 data-raw-formula > data-raw-value chain.
	inputEl.value = typeof entry.formula === 'string' ? entry.formula : formatCellValue(entry.value);
	inputEl.hidden = false;
	editState = { entryIndex, entry, pendingCommit: false };
	inputEl.focus();
	inputEl.select();
}

function cancelEdit(): void {
	if (editState === null) {
		return;
	}
	editState = null;
	inputEl.hidden = true;
	inputEl.value = '';
}

function commitEdit(): void {
	if (editState === null || fullSnapshot === null) {
		return;
	}
	if (editState.pendingCommit) {
		return; // a commit is already in flight -- don't send a duplicate putValue on repeated Enter
	}
	const entry = editState.entry;
	editState.pendingCommit = true;
	// Pessimistic: keep the input visible/focused until the host responds. A success `render`
	// hides it (applyRender -> cancelEdit); an `errorReply` decorates the cell + leaves it for
	// correction. row/col are the ENTRY's sheet coordinates (NOT the display index).
	vscode.postMessage({
		type: 'putValue',
		sheet: fullSnapshot.sheet,
		row: Number(entry.row),
		col: Number(entry.col),
		rawInput: inputEl.value,
	});
}

inputEl.addEventListener('keydown', ev => {
	if (ev.key === 'Enter') {
		ev.preventDefault();
		commitEdit();
	} else if (ev.key === 'Escape') {
		ev.preventDefault();
		cancelEdit();
	}
});
inputEl.addEventListener('blur', () => {
	// Conservative: blur cancels an UNcommitted edit. A pending commit waits for the host's
	// render/errorReply rather than cancelling (the user may have clicked away after Enter).
	if (editState !== null && !editState.pendingCommit) {
		cancelEdit();
	}
});

// --- Canvas click -> hit-test -> edit ---

canvasEl.addEventListener('click', ev => {
	if (fullSnapshot === null) {
		return;
	}
	const rect = canvasEl.getBoundingClientRect();
	// The canvas overlays the viewport (transformed), so client-minus-canvasRect = viewport-LOCAL.
	// hitTestViewport rejects the sticky-header band in local coords BEFORE adding scroll (a header
	// click must never map to a body row), then converts to content coords.
	const localX = ev.clientX - rect.left;
	const localY = ev.clientY - rect.top;
	const hit = hitTestViewport(localX, localY, viewportEl.scrollLeft, viewportEl.scrollTop, fullSnapshot.entries.length);
	if (hit !== null && hit.colIndex === VALUE_COL_INDEX) {
		beginEdit(hit.entryIndex);
	}
});

// Hover tooltip: surface a cell's errorReply message or its engine diagnostic via the native
// `title` (canvas has no per-cell tooltip) -- restores the FE-0b-1 DOM `title=` behavior for both
// the `#CALC!`/`#TIMEOUT!` diagnostic and a failed-edit error.
let lastHoverTitle = '';
canvasEl.addEventListener('mousemove', ev => {
	let title = '';
	if (fullSnapshot !== null) {
		const rect = canvasEl.getBoundingClientRect();
		const hit = hitTestViewport(ev.clientX - rect.left, ev.clientY - rect.top, viewportEl.scrollLeft, viewportEl.scrollTop, fullSnapshot.entries.length);
		if (hit !== null) {
			const entry = fullSnapshot.entries[hit.entryIndex];
			const key = Number(entry.row) + ',' + Number(entry.col);
			title = errorCells.get(key) ?? (typeof entry.diagnostic === 'string' ? entry.diagnostic : '');
		}
	}
	if (title !== lastHoverTitle) {
		canvasEl.title = title;
		lastHoverTitle = title;
	}
});

// --- Undo / redo (webview-scoped; mid-edit lets the browser handle text-undo) ---

document.addEventListener('keydown', ev => {
	if (editState !== null) {
		return;
	}
	const isMeta = ev.metaKey || ev.ctrlKey;
	if (!isMeta) {
		return;
	}
	const key = ev.key.toLowerCase();
	if (key === 'z' && !ev.shiftKey) {
		ev.preventDefault();
		vscode.postMessage({ type: 'undo' });
		return;
	}
	if ((key === 'z' && ev.shiftKey) || key === 'y') {
		ev.preventDefault();
		vscode.postMessage({ type: 'redo' });
		return;
	}
});

// --- Inbound host messages ---

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
		// The commit failed, so the edit is no longer "pending": re-arm blur-cancel (a click away
		// now dismisses) while the input stays for correction + re-commit.
		if (editState !== null) {
			editState.pendingCommit = false;
		}
		redraw();
		return;
	}
	console.warn('[sheets-webview] unknown inbound message type:', msg.type);
});

// Redraw on scroll (re-transform the canvas + repaint the new window). The content-anchored input
// scrolls with the content automatically.
viewportEl.addEventListener('scroll', redraw);

// Redraw on viewport resize (HiDPI backing-store resize happens inside redraw()).
if (typeof ResizeObserver !== 'undefined') {
	new ResizeObserver(() => redraw()).observe(viewportEl);
}

// Repaint on theme change: VS Code re-classes <body>; refresh the cached palette/fonts.
new MutationObserver(() => {
	renderer.refreshTheme();
	redraw();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Handshake: announce the channel is live so the host (re)sends the snapshot. Sent AFTER all
// listeners are wired so the host's reply is never missed.
vscode.postMessage({ type: 'webviewReady' });
