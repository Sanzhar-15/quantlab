/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2 BAKEOFF (2026-06-09) -- render-orchestration extraction.**
 *
 * The scroll + damage + full-redraw decision logic, lifted VERBATIM out of `index.ts` so the
 * REAL paint path can be driven by a benchmark (`webview/render-bench/`) AND golden-unit-tested
 * with a fake renderer -- not just exercised through the full DOM webview. Behavior is preserved
 * byte-for-byte: the same gates (`renderer.painted && !backingScaleStale && scrollUnchangedSince
 * && !publishedChanged`), the same `prevPaint` write points (full redraw + scroll, NEVER damage),
 * the same `computeScrollBlitA1` / `diffSnapshotsA1` / `errorRowsFlippedA1` calls.
 *
 * **DOM/vscode-free.** It imports only the pure webview modules (`gridBlitA1` for the blit/damage
 * math, `gridLayoutA1` for `SelectionRect`) and TYPES from `canvasGrid`. The live DOM-derived
 * inputs (viewport scroll/size, active cell, selection, published ranges, fill preview) arrive
 * through the {@link RenderHost} getters; the DOM side effects (canvas transform, formula bar,
 * selection post, hover title) arrive as {@link RenderHost} callbacks. So `index.ts` keeps owning
 * the DOM + the module-level `let` bindings; this module owns ONLY `prevPaint` (the one piece of
 * state both fast paths read+write) and the paint decision. The esbuild `HOST_RUNTIME_FILTER`
 * never fires here (no `session`/`loader`/`src/quantbook/` import, no native binary).
 *
 * Why a class (not free functions): `prevPaint` is read by `scrollUnchangedSince`/`scrollRedraw`
 * and written by `redraw`/`scrollRedraw`. Owning it as one instance field keeps the read+write
 * contract in one place (no return-value juggling at every call site, which would be the only
 * alternative for module-level mutable state read by ~20 other index.ts functions).
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import type { ActiveCell, PublishedRange } from './canvasGrid';
import { computeScrollBlitA1, diffSnapshotsA1, errorRowsFlippedA1, type ScrollBlit, type ScrollState } from './gridBlitA1';
import type { SelectionRect } from './gridLayoutA1';

/** The viewport scroll/size the paint reads. Mirrors `index.ts`'s `Viewport` (CSS px). */
export interface Viewport {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly cssW: number;
	readonly cssH: number;
}

/**
 * The structural subset of `CanvasGridRenderer` the orchestration calls. A structural interface
 * (not the concrete class) is what lets a unit test / the bench supply a real OR fake renderer
 * without dragging a live `<canvas>` into the unit-testable surface. `CanvasGridRenderer`
 * satisfies this by construction (its public signatures match).
 */
export interface GridRenderer {
	readonly painted: boolean;
	readonly backingScale: number;
	readonly backingScaleStale: boolean;
	readonly gutterWidthPx: number;
	resize(cssWidth: number, cssHeight: number): void;
	draw(
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
	): void;
	drawScroll(
		blit: ScrollBlit,
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
	): void;
	drawDamage(
		rows: readonly number[],
		cssWidth: number,
		cssHeight: number,
		scrollTop: number,
		scrollLeft: number,
		errorCells: ReadonlyMap<string, string>,
		active: ActiveCell | null,
		selection: SelectionRect | null,
		publishedRanges: readonly PublishedRange[],
		fillPreview: SelectionRect | null,
	): void;
}

/**
 * The seam between the extracted orchestration and the host (`index.ts` for real, the bench for
 * synthetic). Reference-stable collaborators (`renderer`, `errorCells`) are fields; live
 * DOM-derived inputs are GETTERS (evaluated at the exact point the original closure read them);
 * DOM side effects are CALLBACKS (fired at the exact point the original code fired them).
 */
export interface RenderHost {
	/** The (real or fake) renderer the orchestration drives. */
	readonly renderer: GridRenderer;
	/** The per-(row,col) error tint map. Reference-stable; the orchestration only READS it. */
	readonly errorCells: ReadonlyMap<string, string>;
	/** The current viewport scroll/size (CSS px). In `index.ts` this reads `viewportEl`. */
	viewport(): Viewport;
	/** The active (focus) cell, or null. */
	active(): ActiveCell | null;
	/** The current multi-cell selection rect, or null for a single cell. */
	selection(): SelectionRect | null;
	/** The published-target ranges for this sheet (bound-cell badges). */
	publishedRanges(): readonly PublishedRange[];
	/** The fill-handle drag preview rect, or null. */
	fillPreview(): SelectionRect | null;
	/** Pin the absolute canvas over the viewport at the given scroll. */
	applyCanvasTransform(scrollTop: number, scrollLeft: number): void;
	/** Fired at the END of a full {@link RenderOrchestrator.redraw} (formula bar + selection post + hover). */
	onAfterFullRedraw(): void;
	/** Fired at the END of {@link RenderOrchestrator.scrollRedraw} (hover title only). */
	onAfterScroll(): void;
	/** Fired after a damage paint that bypassed the full redraw (formula bar follow). */
	onAfterDamage(): void;
}

/**
 * Owns `prevPaint` (the scroll/size/dpr of the LAST painted frame) and the scroll/damage/full
 * paint decision. One instance per webview. Construct with the {@link RenderHost} seam.
 */
export class RenderOrchestrator {
	private readonly host: RenderHost;
	/**
	 * The scroll/size/dpr state of the LAST painted frame -- the basis for the blit delta
	 * (`scrollRedraw`) and the damage-path scroll-equality gate. `null` until the first paint and
	 * after any backing-store resize (which clears `renderer.painted`, forcing a full draw before
	 * the next fast path). WRITTEN only by `redraw` + `scrollRedraw` (NEVER a damage path).
	 */
	private prevPaint: ScrollState | null = null;

	constructor(host: RenderHost) {
		this.host = host;
	}

	/** Test/diagnostic accessor: the last painted frame's scroll state (read-only). */
	get lastPaintState(): ScrollState | null {
		return this.prevPaint;
	}

	/** Snapshot the current paint state. `renderer.backingScale` is read here, so callers that may
	 * resize MUST `renderer.resize()` first (resize is what changes the dpr). */
	private scrollStateNow(v: Viewport): ScrollState {
		return { scrollTop: v.scrollTop, scrollLeft: v.scrollLeft, cssW: v.cssW, cssH: v.cssH, dpr: this.host.renderer.backingScale };
	}

	/** True iff the viewport scroll/size/dpr is identical to the last painted frame -- the
	 * precondition for a damage paint (the UN-damaged pixels are only valid if nothing
	 * scrolled/resized since last paint). */
	private scrollUnchangedSince(v: Viewport): boolean {
		const p = this.prevPaint;
		return (
			p !== null &&
			p.scrollTop === v.scrollTop &&
			p.scrollLeft === v.scrollLeft &&
			p.cssW === v.cssW &&
			p.cssH === v.cssH &&
			p.dpr === this.host.renderer.backingScale
		);
	}

	/**
	 * Full redraw at the current viewport -- the always-correct paint path AND the fallback for both
	 * fast paths (nav / type / resize / theme / first paint / any declined fast path route here).
	 */
	redraw(): void {
		const host = this.host;
		const renderer = host.renderer;
		const v = host.viewport();
		renderer.resize(v.cssW, v.cssH);
		host.applyCanvasTransform(v.scrollTop, v.scrollLeft);
		renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, host.errorCells, host.active(), host.selection(), host.publishedRanges(), host.fillPreview());
		this.prevPaint = this.scrollStateNow(v);
		host.onAfterFullRedraw();
	}

	/**
	 * **FE-2-0 Phase 3** -- the scroll fast path: blit the overlap of a pure-axis scroll + repaint
	 * only the exposed strip, falling back to a full {@link redraw} whenever the pure math declines
	 * (no prior frame, resize/dpr change, diagonal or sub-device-pixel move, or too little reusable
	 * area). ONLY a scroll calls this: a scroll changes neither the snapshot nor the active cell nor
	 * errorCells, so the blitted (shifted) pixels stay correct -- any path that changes
	 * content/selection must full-`redraw()`.
	 */
	scrollRedraw(): void {
		const host = this.host;
		const renderer = host.renderer;
		const v = host.viewport();
		renderer.resize(v.cssW, v.cssH); // a coalesced frame may straddle a resize -> resize first (clears `painted`)
		host.applyCanvasTransform(v.scrollTop, v.scrollLeft);
		const next = this.scrollStateNow(v);
		const blit = renderer.painted ? computeScrollBlitA1(this.prevPaint, next, renderer.gutterWidthPx) : null;
		// W-G-2a: a pure scroll changes neither selection nor content, but the renderer still needs the
		// current selection to paint the range in the exposed strip / full-fallback.
		const sel = host.selection();
		const active = host.active();
		const published = host.publishedRanges();
		const fill = host.fillPreview();
		if (blit === null) {
			renderer.draw(v.cssW, v.cssH, v.scrollTop, v.scrollLeft, host.errorCells, active, sel, published, fill);
		} else {
			renderer.drawScroll(blit, v.cssW, v.cssH, v.scrollTop, v.scrollLeft, host.errorCells, active, sel, published, fill);
		}
		this.prevPaint = next;
		host.onAfterScroll();
	}

	/**
	 * **FE-2-0 Phase 3** -- the snapshot-commit damage decision (the back half of the old
	 * `applyRender`). The host (index.ts) has ALREADY applied the non-paint state (set fullSnapshot,
	 * clear/stale-tint errorCells, update title/meta + spacer) and passes the PRE-replacement
	 * snapshot for the diff. Here we ONLY decide: damage the changed rows (a prior frame at the SAME
	 * scroll, the dpr fresh, the published set unchanged) vs full `redraw()` (the always-correct
	 * fallback). A commit re-renders the whole session snapshot but only the edited cell's row
	 * repaints.
	 *
	 * @param prevSnapshot the snapshot BEFORE this commit (null on the first render / sheet switch ->
	 *   `diffSnapshotsA1` returns null -> full redraw).
	 * @param snapshot the just-applied snapshot.
	 * @param publishedChanged whether the published-cell set changed (forces the full path -- the
	 *   damage diff only covers rows whose value moved, so a badge appear/clear/move without a value
	 *   change needs a full redraw).
	 */
	commitSnapshot(
		prevSnapshot: QuantbookCellSnapshot | null,
		snapshot: QuantbookCellSnapshot,
		publishedChanged: boolean,
	): void {
		const host = this.host;
		const renderer = host.renderer;
		const v = host.viewport();
		// `backingScaleStale` (Opus LOW-1): a dpr change with no CSS-size change skips resize() -> full
		// redraw. W-G: a change in the published set forces the full path (`null`) -- the damage diff only
		// covers rows whose value moved, so a badge that appears/clears/relocates without a value change
		// needs a full redraw.
		const damageRows =
			renderer.painted && !renderer.backingScaleStale && this.scrollUnchangedSince(v) && !publishedChanged
				? diffSnapshotsA1(prevSnapshot, snapshot)
				: null;
		if (damageRows === null) {
			this.redraw();
			return;
		}
		// Scroll is unchanged (gated above), so the canvas transform + prevPaint stay valid; drawDamage is
		// a no-op for an empty row set (nothing painted changed).
		host.applyCanvasTransform(v.scrollTop, v.scrollLeft);
		renderer.drawDamage(damageRows, v.cssW, v.cssH, v.scrollTop, v.scrollLeft, host.errorCells, host.active(), host.selection(), host.publishedRanges(), host.fillPreview());
		// The damage path bypasses redraw(); if the active cell's content changed (e.g. a commit
		// re-render), the formula bar must still follow it.
		host.onAfterDamage();
	}

	/**
	 * **FE-2-0 Phase 3** -- the error-tint damage decision (the back half of the old `errorReply`
	 * handler). Damages only the rows whose error tint FLIPPED, at the same scroll; else a full
	 * `redraw()`. The host computes the selection-realign decision (`forceFullRedraw`) -- a selection
	 * move repaints both old + new selection rows and so must take the full path; this method only
	 * owns the tint-flip damage gate.
	 *
	 * @param prevErrorKeys the errorCells keys captured BEFORE the host applied this errorReply's tint.
	 * @param forceFullRedraw the host's "the selection realigned / a range was visible" decision.
	 */
	commitErrorDamage(prevErrorKeys: ReadonlySet<string>, forceFullRedraw: boolean): void {
		const host = this.host;
		const renderer = host.renderer;
		const v = host.viewport();
		if (!forceFullRedraw && renderer.painted && !renderer.backingScaleStale && this.scrollUnchangedSince(v)) {
			const rows = errorRowsFlippedA1(prevErrorKeys, new Set(host.errorCells.keys()));
			host.applyCanvasTransform(v.scrollTop, v.scrollLeft);
			renderer.drawDamage(rows, v.cssW, v.cssH, v.scrollTop, v.scrollLeft, host.errorCells, host.active(), host.selection(), host.publishedRanges(), host.fillPreview());
		} else {
			// A selection realign (forceFullRedraw) repaints both the old + new selection rows -> full redraw.
			this.redraw();
		}
	}
}
