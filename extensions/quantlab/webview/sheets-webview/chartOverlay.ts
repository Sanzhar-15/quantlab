/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Wave Q2a (2026-06-24) -- chart overlay objects on the sheets grid.**
 *
 * A {@link ChartOverlayManager} owns a set of floating chart DOM containers, one per persistent chart
 * object (engine `ChartObject`, surfaced on each `render` message's `charts[]`). Each container is an
 * absolutely-positioned child of the scroller's CONTENT layer (a sibling of the cell-editor `<input>`),
 * so it tracks scroll naturally; positioning + frozen-pinning + sticky-band clipping are injected by the
 * host webview (mirroring its editor-overlay maths) via {@link ChartOverlayDeps}.
 *
 * Rendering reuses the qviz GENERAL family directly (`compileGeneralPlan` + `applyGeneralPlan` -> lazy
 * Vega-Lite) -- this covers line / bar / scatter and deliberately AVOIDS `@charts-plus` (the timeseries
 * path) so the sheets bundle pulls no Charts-repo coupling. Data is re-pulled from the snapshot on every
 * sync (the live-update: a recalc re-posts `render`, the chart re-reads its source range), with a coarse
 * data-signature memo so an UNRELATED edit elsewhere does not re-embed every chart.
 *
 * No-Fallbacks discipline: a compile/render failure is shown IN the chart box (loud) + logged, never a
 * silent blank; a chart whose source lives on another sheet (not in the active snapshot) shows an explicit
 * note rather than fabricating empty data.
 *
 * **Wave Q2b (2026-06-24) -- move + resize.** The header is a move grab (drag -> the chart follows the
 * pointer; on drop the new anchor CELL is hit-tested from the dropped top-left and persisted via the engine
 * `updateChart`). A bottom-right corner grip resizes (drag -> the box grows/shrinks; on drop the new px size
 * is persisted + the Vega view re-embedded to refit). Both are OPTIMISTIC: the container is updated live and
 * the local {@link ChartJson} patched on drop, then the authoritative `updateChart -> refreshSession ->
 * render -> sync` round-trip re-positions from the persisted truth (so a CELL-snap on move, or the engine's
 * size cap, settles the final geometry). A live drag SUPPRESSES {@link ChartOverlayManager.positionEntry} for
 * its entry so a concurrent scroll/render cannot stomp the gesture, and is CANCELLED if its chart is destroyed
 * mid-drag (a sheet switch). The grab/grip use the SAME pointer-capture pattern as the grid's col/row resize.
 */

import { compileGeneralPlan, CompileGeneralPlanError } from '../../src/qviz/render/general';
import { applyGeneralPlan, disposeView, type VegaEmbedHandle } from '../../src/qviz/render/general-applier';
import type { QvizTheme } from '../../src/qviz/render/types';
import type { ChartJson, QuantbookCellValue } from '../../src/quantbook/types';
import { buildChartData } from './chartDataLogic';

/** Smallest on-grid chart box (px). A resize drag clamps to this floor so the header + a usable plot area
 *  always remain; the engine separately rejects a zero dimension and the host caps the ceiling at 10000. */
export const MIN_CHART_WIDTH_PX = 160;
export const MIN_CHART_HEIGHT_PX = 110;
/** The host's upper bound (mirrors `cellGridPanel` `isPx`): keep the optimistic local box in the same window
 *  the engine will accept, so the pre-round-trip view never disagrees with the persisted one. */
export const MAX_CHART_DIM_PX = 10000;
/** Pointer travel (px) before a header/grip press becomes a drag -- a smaller move is a click (e.g. focus),
 *  not a move/resize, so it never posts a spurious geometry update. */
const DRAG_THRESHOLD_PX = 3;

/** Clamp a dragged chart dimension into the engine-accepted window `[MIN, MAX]` and round to an integer px
 *  (the engine validates a `u32` -- a fractional/!finite value would throw `[bad_argument]`). Pure: unit-tested. */
export function clampChartDim(px: number, min: number): number {
	if (!Number.isFinite(px)) {
		return min;
	}
	return Math.max(min, Math.min(MAX_CHART_DIM_PX, Math.round(px)));
}

/** The webview-supplied hooks the manager needs (all the grid-geometry/state it must not reach for itself). */
export interface ChartOverlayDeps {
	/** The scroller's CONTENT layer to mount chart containers into (the same parent as the cell editor). */
	readonly mount: HTMLElement;
	/** Post a message to the extension host (`vscode.postMessage`). */
	readonly post: (msg: unknown) => void;
	/** The anchor cell's CONTENT-coordinate top-left (frozen-pinned), mirroring the editor overlay. */
	readonly anchorPos: (row: number, col: number) => { left: number; top: number };
	/** Clip insets (top,left, px) so a container scrolled under the sticky header/gutter is hidden there. */
	readonly clipInsets: (left: number, top: number, width: number, height: number) => { top: number; left: number };
	/** Read a cell's COMPUTED value on the ACTIVE sheet (the only sheet the current snapshot carries). */
	readonly readCell: (row: number, col: number) => QuantbookCellValue | undefined;
	/** A column's A1 letter label (synthesised series/axis names when there is no header row). */
	readonly columnLabel: (col: number) => string;
	/** The current chart theme (read from the webview's VS Code CSS variables). */
	readonly theme: () => QvizTheme;
	/** Wave Q2b: the {row,col} under a CLIENT-space point (the dropped chart top-left on a move), or `null`
	 *  when that point is over the header/gutter or off-grid. The webview implements it via the SAME selection
	 *  hit-test as a mouse click (so it honours frozen rows/cols + a window split); the manager owns no grid
	 *  geometry itself. A `null` drop is a no-op (the chart snaps back to its persisted anchor). */
	readonly cellAtClientPoint: (clientX: number, clientY: number) => { row: number; col: number } | null;
}

interface ChartEntry {
	chart: ChartJson;
	readonly root: HTMLElement;
	readonly body: HTMLElement;
	readonly titleEl: HTMLElement;
	handle: VegaEmbedHandle | undefined;
	/** Signature of the last data+type successfully (or attemptedly) embedded -- skip re-embed when unchanged. */
	lastSig: string | undefined;
	/** Serialises async embeds on this container so overlapping renders never race the same DOM node. */
	chain: Promise<void>;
	/** Set by {@link ChartOverlayManager.destroyEntry} so an embed that resolves AFTER teardown disposes its
	 *  late-created Vega view instead of leaking it on a detached DOM node (the use-after-free guard). */
	destroyed: boolean;
}

/** A live header-move or grip-resize gesture (at most one at a time across all charts). The geometry is taken
 *  from a SNAPSHOT at pointerdown (the container's inline box), so a concurrent `entry.chart` swap from a render
 *  cannot corrupt the in-flight drag; the commit reads the FINAL box back off the DOM. */
interface DragState {
	readonly kind: 'move' | 'resize';
	readonly entry: ChartEntry;
	readonly pointerId: number;
	/** The element that captured the pointer + carries the move/up/cancel listeners (the head or the grip). */
	readonly grabEl: HTMLElement;
	readonly startClientX: number;
	readonly startClientY: number;
	/** Container box at pointerdown (content px): left/top for a move, width/height for a resize. */
	readonly startLeft: number;
	readonly startTop: number;
	readonly startWidth: number;
	readonly startHeight: number;
	/** Latest resized dimensions written during the gesture (read on commit). */
	width: number;
	height: number;
	/** Crossed {@link DRAG_THRESHOLD_PX} -> this is a real drag (commit on up), not a click. */
	moved: boolean;
	readonly onMove: (ev: PointerEvent) => void;
	readonly onUp: (ev: PointerEvent) => void;
	readonly onCancel: (ev: PointerEvent) => void;
}

export class ChartOverlayManager {
	private readonly deps: ChartOverlayDeps;
	private readonly entries = new Map<number, ChartEntry>();
	private activeSheet: number | null = null;
	/** The in-flight move/resize gesture, or `null` when idle (only one drag at a time). */
	private drag: DragState | null = null;

	constructor(deps: ChartOverlayDeps) {
		this.deps = deps;
	}

	/**
	 * Reconcile the overlay set with the workbook's charts for the active sheet, then position + (re)render
	 * each. Charts on OTHER sheets are not shown (their data is not in this snapshot); switching sheets fires a
	 * fresh `render` whose `charts[]` + active sheet drive the swap. `charts` is the trusted host->webview
	 * `listCharts()` payload (same channel as `names[]`/`tables[]`).
	 */
	sync(charts: readonly ChartJson[], activeSheet: number): void {
		this.activeSheet = activeSheet;
		const visible = charts.filter(c => c.sheet === activeSheet);
		const visibleIds = new Set<number>(visible.map(c => c.id));
		for (const [id, entry] of this.entries) {
			if (!visibleIds.has(id)) {
				this.destroyEntry(entry);
				this.entries.delete(id);
			}
		}
		for (const chart of visible) {
			let entry = this.entries.get(chart.id);
			if (entry === undefined) {
				entry = this.createEntry(chart);
				this.entries.set(chart.id, entry);
			} else {
				entry.chart = chart;
			}
			this.positionEntry(entry);
			this.renderEntry(entry);
		}
	}

	/** Re-position (+ re-clip) every visible container. Called on scroll (frozen-pin + clip track the scroll). */
	reposition(): void {
		for (const entry of this.entries.values()) {
			this.positionEntry(entry);
		}
	}

	/** Tear down every container + Vega view (dispose / full reset). */
	clear(): void {
		for (const entry of this.entries.values()) {
			this.destroyEntry(entry);
		}
		this.entries.clear();
	}

	/** Re-embed every visible chart from the CURRENT theme. The data is unchanged on a VS Code theme switch, so
	 *  the {@link renderEntry} signature memo would otherwise skip the re-embed and leave the chart in the old
	 *  palette -- invalidate each signature so the next {@link renderEntry} re-embeds from the fresh `theme()`. */
	retheme(): void {
		for (const entry of this.entries.values()) {
			entry.lastSig = undefined;
			this.renderEntry(entry);
		}
	}

	private createEntry(chart: ChartJson): ChartEntry {
		const root = document.createElement('div');
		root.className = 'qb-chart-overlay';
		root.setAttribute('data-chart-id', String(chart.id));
		const head = document.createElement('div');
		head.className = 'qb-chart-head';
		const titleEl = document.createElement('span');
		titleEl.className = 'qb-chart-title';
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'qb-chart-close';
		close.title = 'Delete chart';
		close.setAttribute('aria-label', 'Delete chart');
		close.textContent = '×';
		// The host validates the id + surfaces a [chart_not_found] LOUD (No-Fallbacks); the overlay drops on
		// the next render's charts[]. mousedown preventDefault keeps grid focus stable through the click.
		close.addEventListener('mousedown', ev => ev.preventDefault());
		close.addEventListener('click', () => {
			this.deps.post({ type: 'chartDeleted', id: chart.id });
		});
		head.appendChild(titleEl);
		head.appendChild(close);
		const body = document.createElement('div');
		body.className = 'qb-chart-body';
		// Wave Q2b: a bottom-right grip resizes the chart. A separate absolutely-positioned element (NOT a CSS
		// `resize` corner, which we cannot observe on drop) so we own the drag + persist on release.
		const grip = document.createElement('div');
		grip.className = 'qb-chart-resize';
		grip.setAttribute('aria-hidden', 'true');
		root.appendChild(head);
		root.appendChild(body);
		root.appendChild(grip);
		this.deps.mount.appendChild(root);
		const entry: ChartEntry = { chart, root, body, titleEl, handle: undefined, lastSig: undefined, chain: Promise.resolve(), destroyed: false };
		// Wave Q2b: the header is the move grab. A press on the close button is NOT a move (it deletes); guard so
		// the × keeps working. The grip is the resize grab. Both run the shared pointer-capture drag.
		head.addEventListener('pointerdown', ev => {
			if (ev.target instanceof HTMLElement && ev.target.closest('.qb-chart-close') !== null) {
				return;
			}
			this.beginDrag('move', entry, head, ev);
		});
		grip.addEventListener('pointerdown', ev => this.beginDrag('resize', entry, grip, ev));
		return entry;
	}

	private destroyEntry(entry: ChartEntry): void {
		// Wave Q2b: a chart torn down mid-drag (e.g. a sheet switch hides it) cancels the gesture so a later
		// pointerup cannot post a geometry update for a detached/removed chart.
		if (this.drag !== null && this.drag.entry === entry) {
			this.endDrag();
		}
		// Mark destroyed FIRST so an embed still in flight on this entry's chain disposes its late-created Vega
		// view (see renderEntry) instead of leaking it on the now-detached DOM node.
		entry.destroyed = true;
		if (entry.handle !== undefined) {
			disposeView(entry.handle, entry.body);
			entry.handle = undefined;
		}
		entry.root.remove();
	}

	private positionEntry(entry: ChartEntry): void {
		// Wave Q2b: while THIS entry is being dragged, its inline box is owned by the gesture -- a concurrent
		// scroll (`reposition`) or render (`sync`) must not stomp the live drag. The post-commit round-trip
		// re-positions it from the persisted geometry once the drag is over.
		if (this.drag !== null && this.drag.entry === entry) {
			return;
		}
		const c = entry.chart;
		const pos = this.deps.anchorPos(c.anchorRow, c.anchorCol);
		entry.root.style.left = pos.left + 'px';
		entry.root.style.top = pos.top + 'px';
		entry.root.style.width = c.widthPx + 'px';
		entry.root.style.height = c.heightPx + 'px';
		const clip = this.deps.clipInsets(pos.left, pos.top, c.widthPx, c.heightPx);
		entry.root.style.clipPath = 'inset(' + clip.top + 'px 0px 0px ' + clip.left + 'px)';
	}

	private renderEntry(entry: ChartEntry): void {
		const c = entry.chart;
		entry.titleEl.textContent = c.title !== undefined && c.title.length > 0 ? c.title : c.name;
		const built = buildChartData(c, this.activeSheet, this.deps.readCell, this.deps.columnLabel);
		if (!built.ok) {
			entry.lastSig = undefined;
			if (entry.handle !== undefined) {
				disposeView(entry.handle, entry.body);
				entry.handle = undefined;
			}
			entry.body.textContent = built.error;
			entry.body.classList.add('qb-chart-error');
			return;
		}
		// Wave Q2b (Codex HIGH-1): the box size is render-affecting (the Vega view fits its CONTAINER) but is NOT
		// part of buildChartData's DATA signature -> fold it into the memo key. Without this, a resize that arrives
		// via the authoritative `sync()` on a SIBLING panel (or any render where only the size changed) would
		// resize the container but SKIP the re-embed, leaving the Vega view mis-fitted. Now any size change
		// re-embeds (refits) on EVERY panel deterministically, not only the panel that did the optimistic resize.
		const sig = built.sig + '|' + c.widthPx + 'x' + c.heightPx;
		if (sig === entry.lastSig) {
			// Data + type + size unchanged since the last embed -> skip the Vega re-embed (a memo, not a fallback:
			// an identical signature means an identical chart). An UNRELATED edit elsewhere thus costs nothing.
			return;
		}
		entry.lastSig = sig;
		const theme = this.deps.theme();
		entry.chain = entry.chain.then(async () => {
			// The entry may have been torn down (sheet switch / delete) between scheduling this embed and its
			// turn on the chain -> do not embed into a detached node.
			if (entry.destroyed) {
				return;
			}
			try {
				const plan = compileGeneralPlan(built.spec, built.columns, theme);
				// Wave Q2b (Codex HIGH-2): hand the OLD handle to applyGeneralPlan (which finalizes it exactly once)
				// and CLEAR entry.handle BEFORE the await. Otherwise entry.handle still points at the old, now-being-
				// disposed view during the await, so a concurrent destroyEntry (sheet switch) or the catch below
				// would dispose the SAME handle a second time. Resize re-embeds make this race easy to hit.
				const previous = entry.handle;
				entry.handle = undefined;
				const handle = await applyGeneralPlan(entry.body, plan, previous);
				if (entry.destroyed) {
					// Torn down DURING the await -> dispose the view we just created rather than leak it on a
					// detached node (the use-after-free / leak guard). `previous` was already finalized inside
					// applyGeneralPlan and entry.handle is undefined, so destroyEntry did not double-dispose it.
					disposeView(handle, entry.body);
					return;
				}
				entry.handle = handle;
				entry.body.classList.remove('qb-chart-error');
			} catch (err) {
				if (entry.destroyed) {
					return; // torn down mid-embed -> nothing to surface
				}
				const detail = err instanceof CompileGeneralPlanError || err instanceof Error ? err.message : String(err);
				console.error('[sheets-webview] chart render failed (id ' + c.id + '):', err);
				if (entry.handle !== undefined) {
					disposeView(entry.handle, entry.body);
					entry.handle = undefined;
				}
				entry.body.textContent = 'Chart error: ' + detail;
				entry.body.classList.add('qb-chart-error');
				entry.lastSig = undefined; // a later identical-data render should retry rather than skip
			}
		});
	}

	// ====================================================================================================
	// Wave Q2b: move + resize drag. One gesture at a time; the geometry is snapshotted at pointerdown and the
	// final box read back on drop, so a concurrent render's `entry.chart` swap can never corrupt an in-flight
	// drag. Commit is optimistic (patch the local ChartJson + reposition) then authoritative (engine round-trip).
	// ====================================================================================================

	/** Start a header-move or grip-resize gesture. Ignores a secondary press while another drag is live, a
	 *  non-primary button, or a destroyed entry. Refuses LOUD (No-Fallbacks) if the container was never
	 *  positioned -- `positionEntry` is its sole writer and always runs first, so a missing box is a real bug. */
	private beginDrag(kind: 'move' | 'resize', entry: ChartEntry, grabEl: HTMLElement, ev: PointerEvent): void {
		if (this.drag !== null || entry.destroyed || ev.button !== 0) {
			return;
		}
		const startLeft = parseFloat(entry.root.style.left);
		const startTop = parseFloat(entry.root.style.top);
		const startWidth = parseFloat(entry.root.style.width);
		const startHeight = parseFloat(entry.root.style.height);
		if (!Number.isFinite(startLeft) || !Number.isFinite(startTop) || !Number.isFinite(startWidth) || !Number.isFinite(startHeight)) {
			console.error('[sheets-webview] chart drag aborted: container box not positioned (id ' + entry.chart.id + ')');
			return;
		}
		// A move/resize is a chart-scoped gesture: keep it off the grid (selection / text-select).
		ev.preventDefault();
		ev.stopPropagation();
		const drag: DragState = {
			kind,
			entry,
			grabEl,
			pointerId: ev.pointerId,
			startClientX: ev.clientX,
			startClientY: ev.clientY,
			startLeft,
			startTop,
			startWidth,
			startHeight,
			width: startWidth,
			height: startHeight,
			moved: false,
			onMove: e => this.onDragMove(e),
			onUp: e => this.onDragUp(e),
			onCancel: e => this.onDragCancel(e),
		};
		this.drag = drag;
		// Pointer capture keeps move/up firing if the pointer leaves the grab element (same as the grid's col/row
		// resize). Capability-guarded for non-browser hosts (jsdom) -- the listeners below still receive events
		// dispatched on grabEl directly, so this is a capability check, not a swallowed failure.
		if (typeof grabEl.setPointerCapture === 'function') {
			grabEl.setPointerCapture(ev.pointerId);
		}
		// Listen on `window` (not the grab element) so the drag keeps tracking the pointer as it leaves the small
		// header/grip -- the SAME pattern as the qviz inspector resize handle (pointer capture is best-effort;
		// the window listeners are the guarantee). endDrag removes them.
		window.addEventListener('pointermove', drag.onMove);
		window.addEventListener('pointerup', drag.onUp);
		window.addEventListener('pointercancel', drag.onCancel);
	}

	private onDragMove(ev: PointerEvent): void {
		const drag = this.drag;
		if (drag === null || ev.pointerId !== drag.pointerId) {
			return;
		}
		const dx = ev.clientX - drag.startClientX;
		const dy = ev.clientY - drag.startClientY;
		if (!drag.moved) {
			if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
				return; // sub-threshold: still a click, not yet a drag
			}
			drag.moved = true;
		}
		const root = drag.entry.root;
		if (drag.kind === 'move') {
			root.style.left = drag.startLeft + dx + 'px';
			root.style.top = drag.startTop + dy + 'px';
		} else {
			drag.width = clampChartDim(drag.startWidth + dx, MIN_CHART_WIDTH_PX);
			drag.height = clampChartDim(drag.startHeight + dy, MIN_CHART_HEIGHT_PX);
			root.style.width = drag.width + 'px';
			root.style.height = drag.height + 'px';
		}
	}

	private onDragUp(ev: PointerEvent): void {
		const drag = this.drag;
		if (drag === null || ev.pointerId !== drag.pointerId) {
			return;
		}
		const entry = drag.entry;
		const moved = drag.moved;
		const kind = drag.kind;
		const width = drag.width;
		const height = drag.height;
		this.endDrag(); // release capture + listeners + clear this.drag BEFORE positionEntry can run again
		if (entry.destroyed) {
			return; // torn down mid-gesture (sheet switch) -> nothing to persist or restore
		}
		if (!moved) {
			this.positionEntry(entry); // a click (or sub-threshold nudge) -> re-assert the persisted box
			return;
		}
		if (kind === 'move') {
			this.commitMove(entry);
		} else {
			this.commitResize(entry, width, height);
		}
	}

	private onDragCancel(ev: PointerEvent): void {
		const drag = this.drag;
		if (drag === null || ev.pointerId !== drag.pointerId) {
			return;
		}
		const entry = drag.entry;
		this.endDrag();
		if (!entry.destroyed) {
			this.positionEntry(entry); // discard the visual drag -> restore the persisted box
		}
	}

	/** Resolve a move drop: the dropped top-left (client space) -> the anchor CELL underneath (frozen/split-aware
	 *  via the webview hit-test). A drop over the header/gutter or off-grid, or back onto the same cell, is a
	 *  no-op (snap back). Otherwise patch the local anchor optimistically + persist via `chartMoved`. */
	private commitMove(entry: ChartEntry): void {
		const rect = entry.root.getBoundingClientRect();
		const hit = this.deps.cellAtClientPoint(rect.left, rect.top);
		const c = entry.chart;
		if (hit === null || (hit.row === c.anchorRow && hit.col === c.anchorCol)) {
			this.positionEntry(entry);
			return;
		}
		entry.chart = { ...c, anchorRow: hit.row, anchorCol: hit.col };
		this.positionEntry(entry);
		this.deps.post({ type: 'chartMoved', id: c.id, sheet: c.sheet, anchorRow: hit.row, anchorCol: hit.col });
	}

	/** Resolve a resize drop: patch the local size optimistically, reposition the box, and refit the Vega view.
	 *  The box size is part of the {@link renderEntry} memo (Codex HIGH-1 fix), so `renderEntry` re-embeds at the
	 *  new size with no manual signature reset -- and the authoritative `sync()` refits every other panel the same
	 *  way. Persist via `chartResized`. A no-op when the size is unchanged. */
	private commitResize(entry: ChartEntry, width: number, height: number): void {
		const c = entry.chart;
		if (width === c.widthPx && height === c.heightPx) {
			this.positionEntry(entry);
			return;
		}
		entry.chart = { ...c, widthPx: width, heightPx: height };
		this.positionEntry(entry);
		this.renderEntry(entry);
		this.deps.post({ type: 'chartResized', id: c.id, sheet: c.sheet, widthPx: width, heightPx: height });
	}

	/** Tear down the active gesture: drop listeners, release capture (only if still held), clear `this.drag`. */
	private endDrag(): void {
		const drag = this.drag;
		if (drag === null) {
			return;
		}
		this.drag = null;
		window.removeEventListener('pointermove', drag.onMove);
		window.removeEventListener('pointerup', drag.onUp);
		window.removeEventListener('pointercancel', drag.onCancel);
		const el = drag.grabEl;
		// Release only a capture we still hold: a `pointercancel` already releases it, and re-releasing throws
		// `InvalidPointerId`. `hasPointerCapture` is the clean state check (capability-guarded for jsdom).
		if (
			typeof el.releasePointerCapture === 'function' &&
			typeof el.hasPointerCapture === 'function' &&
			el.hasPointerCapture(drag.pointerId)
		) {
			el.releasePointerCapture(drag.pointerId);
		}
	}
}
