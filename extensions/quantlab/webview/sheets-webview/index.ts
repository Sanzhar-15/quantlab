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
import { type ScrollState, computeScrollBlit, diffSnapshots, errorRowsFlipped } from './gridBlit';
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
	// FE megaudit M8: the (sheet,row,col) IDENTITY of the cell whose commit is in
	// flight, captured at commit time. The errorReply handler only clears
	// pendingCommit / leaves the editor open when the reply matches THIS cell, so a
	// late reply for a PREVIOUS edit (cell A) can't mutate the state of a current
	// edit (cell B). Undefined until commitEdit() fires.
	commitSheet?: number;
	commitRow?: number;
	commitCol?: number;
}
let editState: EditState | null = null;

// --- FE-0b-4 partial-redraw state ---
// `prevScroll` = the scroll/size/dpr of the last painted frame (the blit baseline); `prevSnapshot`
// + `prevErrorKeys` = the damage-diff baseline. All are refreshed by every paint.
let prevScroll: ScrollState | null = null;
let prevSnapshot: QuantbookCellSnapshot | null = null;
let prevErrorKeys = new Set<string>();

// Above this many changed rows a full redraw beats N clipped row paints (e.g. a bulk write_range /
// SQL materialize). An interactive edit changes a handful, so it stays on the damage path.
const DAMAGE_FULL_THRESHOLD = 64;

// Compile-time-false debug self-check: when true, every partial paint is followed by a full redraw
// + a pixel compare. No-Fallbacks -- it SHOUTS on mismatch (console.error + a magenta marker),
// never silently masks it. esbuild constant-folds the `false` so the body is dropped (zero prod cost).
const DEBUG_BLIT_VERIFY = false;

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
function scrollStateOf(v: Viewport): ScrollState {
	return { scrollTop: v.scrollTop, scrollLeft: v.scrollLeft, cssW: v.cssW, cssH: v.cssH, dpr: renderer.backingScale };
}

/**
 * True iff the last painted frame (`prevScroll`) was at EXACTLY the viewport's current scroll/size/dpr.
 * This is the precondition for a DAMAGE paint (FE-0b-5 Codex H3): damage repaints only changed rows on
 * top of the existing backing store, so that store must already be a full render at the current scroll.
 * Scroll repaints are rAF-coalesced, so a `render`/`errorReply` arriving between a scroll and its pending
 * rAF would otherwise damage-paint changed rows at the new offset while unchanged rows still show the old
 * one. When this returns false (the user scrolled since the last paint), the caller full-draws instead.
 */
function scrollUnchanged(prev: ScrollState | null, v: Viewport): boolean {
	return (
		prev !== null &&
		prev.scrollTop === v.scrollTop &&
		prev.scrollLeft === v.scrollLeft &&
		prev.cssW === v.cssW &&
		prev.cssH === v.cssH &&
		prev.dpr === renderer.backingScale
	);
}

/** Union two ascending index lists into one ascending, de-duplicated list. */
function unionSortedUnique(a: readonly number[], b: readonly number[]): number[] {
	if (b.length === 0) {
		return a.slice();
	}
	if (a.length === 0) {
		return b.slice();
	}
	const set = new Set<number>(a);
	for (const x of b) {
		set.add(x);
	}
	return Array.from(set).sort((p, q) => p - q);
}

/** Full redraw at the current viewport; refreshes the blit baseline. The snapshot/error baselines
 * are left to the caller (a scroll/resize/theme repaint does not change them). */
function fullDraw(): void {
	const v = currentViewport();
	renderer.resize(v.cssW, v.cssH);
	applyCanvasTransform(v.scrollTop, v.scrollLeft);
	renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
	prevScroll = scrollStateOf(v);
}

/** DEBUG_BLIT_VERIFY: redraw fully + compare to the partial paint; SHOUT on any mismatch. The full
 * redraw leaves the canvas in its always-correct state (so the marker, if any, sits over truth). */
function verifyPartialAgainstFull(v: Viewport): void {
	if (!DEBUG_BLIT_VERIFY) {
		return;
	}
	const ctx = canvasEl.getContext('2d');
	if (ctx === null) {
		return;
	}
	const before = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
	renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
	const after = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
	let mismatch = 0;
	for (let i = 0; i < before.data.length; i += 1) {
		if (before.data[i] !== after.data[i]) {
			mismatch += 1;
		}
	}
	if (mismatch > 0) {
		console.error('[sheets-webview] DEBUG_BLIT_VERIFY: partial paint differs from full redraw by ' + mismatch + ' byte(s)');
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = 'magenta';
		ctx.fillRect(0, 0, 16, 16);
		ctx.restore();
	}
}

/** Scroll repaint: reuse painted pixels via a blit when possible, else a full redraw. */
function scrollRedraw(): void {
	const v = currentViewport();
	renderer.resize(v.cssW, v.cssH); // updates dpr; resets `painted` if the size changed
	applyCanvasTransform(v.scrollTop, v.scrollLeft);
	const next = scrollStateOf(v);
	// FE-0b-5 (Codex H1): never blit an EMPTY sheet -- `paintWindow`'s placeholder is drawn at a FIXED
	// viewport x (NOT content-anchored), so a horizontal blit would shift/duplicate it instead of
	// leaving it pinned the way a full redraw does. Full-draw empty sheets (they are tiny anyway).
	const blit = renderer.painted && renderer.entryCount > 0 ? computeScrollBlit(prevScroll, next) : null;
	if (blit !== null) {
		renderer.drawScroll(blit, v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
	} else {
		renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
	}
	prevScroll = next;
	if (blit !== null) {
		verifyPartialAgainstFull(v);
	}
}

// FE megaudit L-b: coalesce high-frequency scroll events to ONE repaint per animation frame. A fast
// scroll fires many `scroll` events per frame; scrollRedraw() reads the LATEST scroll offset inside
// the rAF callback, so no intermediate frame is lost.
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

/**
 * Apply a fresh snapshot: update title/meta + spacer, clear edit/error state, then paint. Paints via
 * the damage path (only changed rows) when possible, else a full redraw. `renderer.painted` is the
 * OUTER gate: a webview reload zeroes the backing store, so an identical re-sent snapshot (empty
 * diff) must STILL full-draw rather than trust stale pixels (FE-0b-4 R3).
 */
function applyRender(snapshot: QuantbookCellSnapshot): void {
	const prevSnap = prevSnapshot;
	const prevErr = prevErrorKeys;

	fullSnapshot = snapshot;
	renderer.setSnapshot(snapshot);
	// FE re-audit MED-1 (regression from M1's session-wide refresh): a render that is NOT the
	// ack of THIS panel's own pending commit -- e.g. a SIBLING panel committing on another sheet
	// triggered a session-wide refreshSession -- must NOT destroy an in-progress edit (the user
	// may be mid-typing uncommitted text). Only clear the editor + this panel's error decorations
	// when we have a pending commit (our own commit's repaint) or there is no active edit. A
	// surviving editor keeps its content-anchored position; the canvas repaints underneath it.
	if (editState === null || editState.pendingCommit) {
		cancelEdit();
		errorCells.clear();
	}
	renderer.refreshTheme();
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent = 'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	spacerEl.style.height = totalContentHeight(snapshot.entries.length) + 'px';
	spacerEl.style.width = totalContentWidth() + 'px';

	const v = currentViewport();
	renderer.resize(v.cssW, v.cssH); // resets `painted` if the viewport resized since the last paint
	applyCanvasTransform(v.scrollTop, v.scrollLeft);

	let didPartial = false;
	// FE-0b-5 (Codex H3): the damage path only repaints CHANGED rows on top of the existing backing
	// store, so that store must already be a full render at the CURRENT scroll. If the user scrolled
	// since the last paint (a coalesced scroll rAF is still pending), `scrollUnchanged` is false and we
	// full-draw -- otherwise unchanged rows would be left at the stale pre-scroll offset.
	if (renderer.painted && scrollUnchanged(prevScroll, v)) {
		const diff = diffSnapshots(prevSnap, snapshot);
		if (diff !== null) {
			// errorCells may have been cleared above -> union the rows whose tint flipped.
			const nextErrKeys = new Set<string>(errorCells.keys());
			const union = unionSortedUnique(diff, errorRowsFlipped(prevErr, nextErrKeys, snapshot.entries));
			if (union.length === 0) {
				didPartial = true; // structurally identical + no error flip: pixels already valid
			} else if (union.length <= DAMAGE_FULL_THRESHOLD) {
				renderer.drawDamage(union, v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
				verifyPartialAgainstFull(v);
				didPartial = true;
			}
		}
	}
	if (!didPartial) {
		renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
	}
	prevScroll = scrollStateOf(v);
	prevSnapshot = snapshot;
	prevErrorKeys = new Set<string>(errorCells.keys());
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
	// FE megaudit M8: do NOT start a new edit while a commit is in flight. The prior
	// behavior cancelled the pending edit and opened a fresh one, which could (a) lose
	// edit B if A's reply then cleared B's pendingCommit, or (b) let A's reply decorate
	// B's cell. Block the new edit until the host responds (a success `render` clears
	// the pending edit via applyRender; an `errorReply` re-arms it for correction).
	if (editState !== null && editState.pendingCommit) {
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
	// FE-0b-1 data-raw-formula > data-raw-value chain. The stored `entry.formula` is the engine's
	// NORMALIZED BODY (no leading `=`), so we MUST re-add the `=`: the host dispatch only routes
	// input back to `setFormula` when it starts with `=`. Without the prefix, a no-op re-submit of a
	// formula cell is classified as TEXT and silently destroys the formula (megaudit F1, data loss).
	inputEl.value = typeof entry.formula === 'string' ? '=' + entry.formula : formatCellValue(entry.value);
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
	const sheet = fullSnapshot.sheet;
	const row = Number(entry.row);
	const col = Number(entry.col);
	editState.pendingCommit = true;
	// FE megaudit M8: stamp the in-flight cell identity so a returning errorReply can
	// be matched to THIS edit (and a stale reply for a prior cell ignored).
	editState.commitSheet = sheet;
	editState.commitRow = row;
	editState.commitCol = col;
	// Pessimistic: keep the input visible/focused until the host responds. A success `render`
	// hides it (applyRender -> cancelEdit); an `errorReply` decorates the cell + leaves it for
	// correction. row/col are the ENTRY's sheet coordinates (NOT the display index).
	vscode.postMessage({
		type: 'putValue',
		sheet,
		row,
		col,
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
//
// FE megaudit L-b: coalesce the mousemove hit-test to ONE evaluation per animation
// frame. mousemove fires many times per frame; we stash the latest coords and run a
// single hit-test in the rAF callback (the resolved title is what the user sees).
let lastHoverTitle = '';
let hoverClientX = 0;
let hoverClientY = 0;
let hoverScheduled = false;
function updateHoverTitle(): void {
	hoverScheduled = false;
	let title = '';
	if (fullSnapshot !== null) {
		const rect = canvasEl.getBoundingClientRect();
		const hit = hitTestViewport(hoverClientX - rect.left, hoverClientY - rect.top, viewportEl.scrollLeft, viewportEl.scrollTop, fullSnapshot.entries.length);
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
		// FE megaudit M8: only clear pendingCommit when the reply matches the CURRENT
		// in-flight edit's cell identity. A late reply for a PREVIOUS edit (different
		// cell) must NOT un-stick / re-arm the current edit -- otherwise A's failure
		// could clear B's pending flag (losing the duplicate-suppression on B) or vice
		// versa. The matched edit stays open for correction + re-commit; a non-matching
		// reply only decorates the cell (errorCells above) and repaints.
		if (
			editState !== null &&
			editState.pendingCommit &&
			editState.commitSheet === Number(er.sheet) &&
			editState.commitRow === Number(er.row) &&
			editState.commitCol === Number(er.col)
		) {
			// The commit failed, so the edit is no longer "pending": re-arm blur-cancel (a
			// click away now dismisses) while the input stays for correction + re-commit.
			editState.pendingCommit = false;
		}
		// FE-0b-4: an errorReply only flips ONE cell's tint (and carries no new snapshot), so damage
		// just that row when we can locate it + have painted; else full-draw. prevSnapshot is left
		// unchanged; prevErrorKeys is refreshed (the new key participates in the next diff's union).
		const v = currentViewport();
		renderer.resize(v.cssW, v.cssH);
		applyCanvasTransform(v.scrollTop, v.scrollLeft);
		const idx = fullSnapshot
			? fullSnapshot.entries.findIndex(e => Number(e.row) === Number(er.row) && Number(e.col) === Number(er.col))
			: -1;
		// FE-0b-5 (Codex H3): same scroll-match precondition as applyRender -- only damage-paint when the
		// backing store is already a full render at the current scroll; else full-draw.
		if (renderer.painted && idx >= 0 && scrollUnchanged(prevScroll, v)) {
			renderer.drawDamage([idx], v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
			verifyPartialAgainstFull(v);
		} else {
			renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, errorCells);
		}
		prevScroll = scrollStateOf(v);
		prevErrorKeys = new Set<string>(errorCells.keys());
		return;
	}
	console.warn('[sheets-webview] unknown inbound message type:', msg.type);
});

// Repaint on scroll (blit-reuse + re-transform the canvas). The content-anchored input scrolls with
// the content automatically. FE megaudit L-b: rAF-coalesced to one repaint per frame.
viewportEl.addEventListener('scroll', scheduleRedraw);

// Full redraw on viewport resize: the backing store is re-sized + cleared inside fullDraw()->resize()
// (which resets `painted`), so a blit/damage over the stale pixels is impossible here.
if (typeof ResizeObserver !== 'undefined') {
	new ResizeObserver(() => fullDraw()).observe(viewportEl);
}

// Full redraw on theme change: VS Code re-classes <body>; refresh the cached palette/fonts then
// repaint everything (every cell's colour may have changed -- not a partial-paintable delta).
new MutationObserver(() => {
	renderer.refreshTheme();
	fullDraw();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Handshake: announce the channel is live so the host (re)sends the snapshot. Sent AFTER all
// listeners are wired so the host's reply is never missed.
vscode.postMessage({ type: 'webviewReady' });
