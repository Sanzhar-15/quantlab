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
import { frozenColsWidth, frozenRowsHeight, type SelectionRect } from './gridLayoutA1';

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
	/**
	 * **W3 frozen panes** -- the number of PINNED leading rows / cols. The blit decision reads these to
	 * exclude the frozen bands from the scroll copy + repaint them as part of the exposed strip; `0/0` keeps
	 * the pre-W3 blit byte-identical. In `index.ts` these mirror `renderer.frozenRows`/`renderer.frozenCols`
	 * (one source of truth -- the host setter writes both); the bench supplies `0/0`.
	 */
	frozenRowCount(): number;
	frozenColCount(): number;
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
		// W3 frozen panes: thread the pinned-band sizes (CSS px) so the blit excludes the frozen row band
		// (vertical scroll) / frozen col band (horizontal scroll) from the copy + repaints them in the strip,
		// instead of falling back to a full redraw on every scroll (which would undo the wave-1 bench gates).
		// `0/0` => the pre-W3 byte-identical blit.
		const frozenRowsCssH = frozenRowsHeight(host.frozenRowCount());
		const frozenColsCssW = frozenColsWidth(host.frozenColCount());
		const blit = renderer.painted
			? computeScrollBlitA1(this.prevPaint, next, renderer.gutterWidthPx, frozenRowsCssH, frozenColsCssW)
			: null;
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
	 *   change needs a full redraw). **A4 (2026-06-13)**: `index.ts::applyRender` also ORs its
	 *   `structuralChanged` flag (an insert/delete-rows/cols render) into this argument, since a structural
	 *   op shifts cell A1 coordinates and the absolute-keyed damage diff can mis-repaint a MOVED styled cell
	 *   -- the same "force full redraw" need as a published-set change, so it rides the same gate.
	 *   **Tables wave (2026-06-13)**: `applyRender` ALSO ORs its `tablesChanged` flag (a create/drop/move/
	 *   resize/header-totals-toggle render) into this argument. A table is RANGE-level paint metadata that
	 *   touches no per-cell `entry`, so the `entries`-only damage diff returns `[]` and `drawDamage([])`
	 *   no-ops -- the band/border would stay stale until a later full redraw. Same "force full redraw" need.
	 * @param stylesChanged **FE-5 W-R (2026-06-12)**: whether the engine STYLE TABLE (`snapshot.styles[]`)
	 *   changed since the last commit -- forces the full path. The per-cell `styleId` term in
	 *   `entryVisualEqual` catches a cell REPOINTED to a different style, but a style DEFINITION change (an
	 *   existing `styleId`'s fill/bold/border re-edited, every cell carrying it unchanged) moves no cell's
	 *   `styleId`, so the row diff would miss it and the re-colored cells would not repaint until scroll.
	 *   The table-level analog of `publishedChanged`. `false` whenever the IDE build's render snapshot does
	 *   not yet carry `styles[]` (the conductor cross-boundary field) -> byte-identical to the pre-W-R gate.
	 */
	commitSnapshot(
		prevSnapshot: QuantbookCellSnapshot | null,
		snapshot: QuantbookCellSnapshot,
		publishedChanged: boolean,
		// Defaulted to `false` ONLY so the pre-W-R callers that legitimately have no engine style table (the
		// render bench + the orchestrator golden tests, neither of which carries `styles[]`) need no edit --
		// `false` is the CORRECT value there, not a masked-missing-argument fallback. The LIVE caller
		// (`index.ts::applyRender`) ALWAYS passes the real derived flag explicitly, so the production path is
		// never silently defaulted (No-Fallbacks: this is a correct-default for genuinely-style-free callers,
		// not a swallowed required arg).
		stylesChanged: boolean = false,
	): void {
		const host = this.host;
		const renderer = host.renderer;
		const v = host.viewport();
		// `backingScaleStale` (Opus LOW-1): a dpr change with no CSS-size change skips resize() -> full
		// redraw. W-G: a change in the published set forces the full path (`null`) -- the damage diff only
		// covers rows whose value moved, so a badge that appears/clears/relocates without a value change
		// needs a full redraw. W-R (2026-06-12): a style-TABLE change does likewise.
		// **CLOSURE D3 (2026-06-12) -- NB `stylesChanged` is DEFENSIVE-ONLY and OVER-FIRES.** `registerStyle`
		// is CONTENT-ADDRESSED (idempotent only for an identical style): editing an existing style's
		// fill/bold/border yields a NEW StyleId, so the affected cells' `styleId` MOVES to that new id -- which
		// the per-cell `styleId` term in `entryVisualEqual` already treats as damage. So a real style edit is
		// already caught by the damage diff; this table-level gate just forces a (redundant) full redraw on top.
		// Kept as belt-and-braces (cheap, correct), not because the damage diff would otherwise miss it.
		const damageRows =
			renderer.painted && !renderer.backingScaleStale && this.scrollUnchangedSince(v) && !publishedChanged && !stylesChanged
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
