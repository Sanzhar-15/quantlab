/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-2 BAKEOFF (2026-06-09) -- golden tests for the extracted render orchestration
 * (`webview/sheets-webview/renderOrchestrator.ts`). The decision logic (scroll-blit vs damage vs
 * full redraw, the `prevPaint` write points, the damage/error-flip gates) was lifted VERBATIM out
 * of `index.ts`; these pin it against a FAKE `GridRenderer` that records every draw/drawScroll/
 * drawDamage call (a real 2D context is not available headlessly -- it is covered by the renderer's
 * `DEBUG_BLIT_VERIFY` self-check + operator smoke). The fake also lets us simulate `painted`,
 * `backingScaleStale`, and dpr without a canvas, exercising the exact branch conditions.
 *
 * Behavior-preservation focus: these assert the SAME paint path the old in-place functions took, so
 * a refactor regression (e.g. a damage paint that should have been a full redraw, or a prevPaint
 * write on the damage path) fails here.
 *
 * Pure -- no vscode, no DOM -- so it runs under plain mocha.
 */

import * as assert from 'assert';

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../src/quantbook/types';
import type { ActiveCell, PublishedRange, RefHighlightRect } from '../webview/sheets-webview/canvasGrid';
import type { SelectionRect } from '../webview/sheets-webview/gridLayoutA1';
import { RenderOrchestrator, type GridRenderer, type RenderHost, type Viewport } from '../webview/sheets-webview/renderOrchestrator';

// --- a recording fake renderer ---

type DrawCall = { kind: 'draw' | 'drawScroll' | 'drawDamage'; scrollTop: number; scrollLeft: number; rows?: readonly number[]; hasBlit?: boolean };

class FakeRenderer implements GridRenderer {
	calls: DrawCall[] = [];
	resizeCalls: { cssWidth: number; cssHeight: number }[] = [];
	// Mutable so a test can model the renderer's post-paint state machine.
	private _painted = false;
	backingScale = 1;
	backingScaleStale = false;
	gutterWidthPx = 50;

	get painted(): boolean {
		return this._painted;
	}
	setPainted(v: boolean): void {
		this._painted = v;
	}

	resize(cssWidth: number, cssHeight: number): void {
		this.resizeCalls.push({ cssWidth, cssHeight });
	}
	draw(_cssW: number, _cssH: number, scrollTop: number, scrollLeft: number): void {
		this.calls.push({ kind: 'draw', scrollTop, scrollLeft });
		this._painted = true;
	}
	// The blit param is opaque to the orchestrator's decision (it only checks null vs non-null), so the
	// fake just records that a blit was supplied -- the geometry is golden-tested in gridBlitA1.
	drawScroll(_blit: unknown, _cssW: number, _cssH: number, scrollTop: number, scrollLeft: number): void {
		this.calls.push({ kind: 'drawScroll', scrollTop, scrollLeft, hasBlit: true });
		this._painted = true;
	}
	drawDamage(rows: readonly number[], _cssW: number, _cssH: number, scrollTop: number, scrollLeft: number): void {
		this.calls.push({ kind: 'drawDamage', scrollTop, scrollLeft, rows });
		this._painted = true;
	}
}

// --- a host whose live inputs are settable fields ---

class FakeHost implements RenderHost {
	readonly renderer: FakeRenderer;
	readonly errorCells: Map<string, string> = new Map();
	vp: Viewport = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
	activeCell: ActiveCell | null = { row: 0, col: 0 };
	sel: SelectionRect | null = null;
	published: PublishedRange[] = [];
	fill: SelectionRect | null = null;
	frozenRows = 0; // W3 frozen panes: settable so a test can drive the frozen-aware blit gate
	frozenCols = 0;
	splitActive = false; // Wave F window split: settable so a test can drive the split-forces-full gate
	transforms: { scrollTop: number; scrollLeft: number }[] = [];
	afterFull = 0;
	afterScroll = 0;
	afterDamage = 0;

	constructor(renderer: FakeRenderer) {
		this.renderer = renderer;
	}
	viewport(): Viewport {
		return this.vp;
	}
	active(): ActiveCell | null {
		return this.activeCell;
	}
	selection(): SelectionRect | null {
		return this.sel;
	}
	publishedRanges(): readonly PublishedRange[] {
		return this.published;
	}
	fillPreview(): SelectionRect | null {
		return this.fill;
	}
	pointPreview(): SelectionRect | null {
		return null;
	}
	activeRefHighlights(): readonly RefHighlightRect[] {
		return [];
	}
	frozenRowCount(): number {
		return this.frozenRows;
	}
	frozenColCount(): number {
		return this.frozenCols;
	}
	isSplitActive(): boolean {
		return this.splitActive;
	}
	applyCanvasTransform(scrollTop: number, scrollLeft: number): void {
		this.transforms.push({ scrollTop, scrollLeft });
	}
	onAfterFullRedraw(): void {
		this.afterFull += 1;
	}
	onAfterScroll(): void {
		this.afterScroll += 1;
	}
	onAfterDamage(): void {
		this.afterDamage += 1;
	}
}

// --- snapshot fixtures (mirror the gridBlit test helpers) ---

type Entry = QuantbookCellSnapshot['entries'][number];
function num(value: number): QuantbookCellValue {
	return { kind: 'number', value };
}
function entry(row: number, col: number, value: QuantbookCellValue): Entry {
	return { row, col, value };
}
function snap(entries: Entry[], sheet = 0): QuantbookCellSnapshot {
	return { snapshot_format_version: 1, sheet, entries };
}

function make(): { host: FakeHost; renderer: FakeRenderer; orch: RenderOrchestrator } {
	const renderer = new FakeRenderer();
	const host = new FakeHost(renderer);
	const orch = new RenderOrchestrator(host);
	return { host, renderer, orch };
}

suite('FE-2 render orchestrator -- redraw (full path)', function () {
	test('full draw resizes, transforms, draws, writes prevPaint, fires onAfterFullRedraw', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 30, scrollLeft: 40, cssW: 800, cssH: 600 };
		orch.redraw();
		assert.deepStrictEqual(renderer.resizeCalls, [{ cssWidth: 800, cssHeight: 600 }]);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
		assert.deepStrictEqual(host.transforms, [{ scrollTop: 30, scrollLeft: 40 }]);
		assert.strictEqual(host.afterFull, 1);
		assert.strictEqual(host.afterScroll, 0);
		assert.strictEqual(host.afterDamage, 0);
		// prevPaint now reflects the painted frame (drives the next damage/blit gate).
		assert.deepStrictEqual(orch.lastPaintState, { scrollTop: 30, scrollLeft: 40, cssW: 800, cssH: 600, dpr: 1 });
	});
});

suite('FE-2 render orchestrator -- scrollRedraw (blit fast path)', function () {
	test('first scroll with no prior frame -> full draw (blit declines), prevPaint updated', () => {
		const { host, renderer, orch } = make();
		// painted=false -> the orchestrator does NOT even call computeScrollBlitA1 -> a full draw.
		host.vp = { scrollTop: 100, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.scrollRedraw();
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
		assert.strictEqual(host.afterScroll, 1);
		assert.deepStrictEqual(orch.lastPaintState, { scrollTop: 100, scrollLeft: 0, cssW: 800, cssH: 600, dpr: 1 });
	});

	test('a clean vertical scroll after a paint takes the blit path (drawScroll)', () => {
		const { host, renderer, orch } = make();
		// Establish a painted frame at (0,0).
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw();
		renderer.calls.length = 0;
		// A whole-device-pixel vertical scroll big enough to keep a reusable region -> a non-null blit.
		host.vp = { scrollTop: 120, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.scrollRedraw();
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'drawScroll');
		assert.strictEqual(renderer.calls[0].hasBlit, true);
		assert.deepStrictEqual(orch.lastPaintState, { scrollTop: 120, scrollLeft: 0, cssW: 800, cssH: 600, dpr: 1 });
	});

	test('Wave F: while a split is active, the SAME clean scroll declines the blit -> full draw', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw();
		renderer.calls.length = 0;
		// Identical clean vertical scroll to the blit test above -- the ONLY difference is split is active.
		host.splitActive = true;
		host.vp = { scrollTop: 120, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.scrollRedraw();
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw', 'split forces the full (split) paint, never a blit');
	});

	test('a resize (cssH change) during scroll declines the blit -> full draw', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw();
		renderer.calls.length = 0;
		host.vp = { scrollTop: 120, scrollLeft: 0, cssW: 800, cssH: 640 }; // height changed
		orch.scrollRedraw();
		assert.strictEqual(renderer.calls[0].kind, 'draw');
	});
});

suite('FE-2 render orchestrator -- commitSnapshot (damage decision)', function () {
	test('first render (no prior frame, not painted) -> full redraw', () => {
		const { host, renderer, orch } = make();
		const s = snap([entry(0, 0, num(1))]);
		// renderer.painted is false initially -> the gate fails -> full redraw.
		orch.commitSnapshot(null, s, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
		assert.strictEqual(host.afterFull, 1);
		assert.strictEqual(host.afterDamage, 0);
	});

	test('unchanged scroll + a single-cell value change -> drawDamage on exactly that row', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(0, 0, num(1)), entry(5, 2, num(9))]);
		// Paint the prior frame so painted=true + prevPaint matches the (unchanged) scroll.
		orch.commitSnapshot(null, prev, false); // first -> full redraw, sets prevPaint + painted
		renderer.calls.length = 0;
		host.afterFull = 0;
		const next = snap([entry(0, 0, num(1)), entry(5, 2, num(42))]); // row 5 changed
		orch.commitSnapshot(prev, next, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'drawDamage');
		assert.deepStrictEqual(renderer.calls[0].rows, [5]);
		assert.strictEqual(host.afterDamage, 1, 'damage path fires onAfterDamage (formula-bar follow)');
		assert.strictEqual(host.afterFull, 0, 'damage path does NOT fire onAfterFullRedraw');
		// The damage path must NOT rewrite prevPaint -- it stays the prior frame's state.
		assert.deepStrictEqual(orch.lastPaintState, { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600, dpr: 1 });
	});

	test('Wave F: while a split is active, the same single-cell change forces a full redraw (no damage)', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(0, 0, num(1)), entry(5, 2, num(9))]);
		orch.commitSnapshot(null, prev, false);
		renderer.calls.length = 0;
		host.afterFull = 0;
		host.splitActive = true; // the only difference from the damage test above
		const next = snap([entry(0, 0, num(1)), entry(5, 2, num(42))]);
		orch.commitSnapshot(prev, next, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw', 'split forces the full (split) paint, never a damage clip');
		assert.strictEqual(host.afterFull, 1);
	});

	test('publishedChanged forces a full redraw even at the same scroll with a tiny diff', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(0, 0, num(1))]);
		orch.commitSnapshot(null, prev, false);
		renderer.calls.length = 0;
		host.afterFull = 0;
		const next = snap([entry(0, 0, num(2))]);
		orch.commitSnapshot(prev, next, true); // publishedChanged=true -> full path
		assert.strictEqual(renderer.calls[0].kind, 'draw');
		assert.strictEqual(host.afterFull, 1);
	});

	test('A4: a STRUCTURAL render (insert/delete) forces a full redraw -- the moved styled row repaints', () => {
		// A4 (2026-06-13): `index.ts::applyRender` ORs its `structuralChanged` flag into `commitSnapshot`'s
		// first boolean (the same gate `publishedChanged` rides). On a row insert a styled cell shifts row
		// 5->6; the absolute-A1 damage diff can mis-repaint the move, so a structural render MUST take the
		// always-correct full-redraw path. Here we drive the orchestrator the way `applyRender` does for a
		// structural render: first boolean = `publishedChanged(false) || structuralChanged(true)` = true.
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		// Establish a painted prior frame at the same scroll (so ONLY the structural gate could force full).
		const prev = snap([entry(5, 2, num(9))]);
		orch.commitSnapshot(null, prev, false); // first -> full redraw, sets painted + prevPaint
		renderer.calls.length = 0;
		host.afterFull = 0;
		host.afterDamage = 0;
		// The structural render: the styled cell moved 5->6. A tiny diff at the SAME scroll would normally take
		// the damage fast path; the structural flag (folded into the first boolean) forces a full redraw.
		const next = snap([entry(6, 2, num(9))]);
		const structuralChanged = true;
		orch.commitSnapshot(prev, next, /* publishedChanged */ false || structuralChanged);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw', 'structural render takes the FULL redraw path (never drawDamage)');
		assert.strictEqual(host.afterFull, 1, 'full-redraw path fires onAfterFullRedraw');
		assert.strictEqual(host.afterDamage, 0, 'structural render does NOT take the damage diff path');
	});

	test('Tables wave: a TABLE-ONLY render (identical entries) forces a full redraw -- the band repaints', () => {
		// Tables wave (2026-06-13): `index.ts::applyRender` ORs its `tablesChanged` flag into `commitSnapshot`'s
		// first boolean (the same gate `publishedChanged`/`structuralChanged` ride). A table create/drop/move/
		// resize touches NO per-cell `entry`, so `diffSnapshotsA1` returns `[]` and `drawDamage([])` no-ops --
		// the table band/border would stay STALE until a later full redraw. Here the entries are IDENTICAL
		// between prev and next (the only thing that changed is the table list, detected host-side and folded
		// into the first boolean), so the ONLY thing that can force a full redraw is the tables gate. Mirrors
		// the A4 structural test's assertion style.
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		// Establish a painted prior frame at the same scroll (so ONLY the tables gate could force full).
		const prev = snap([entry(0, 0, num(1))]);
		orch.commitSnapshot(null, prev, false); // first -> full redraw, sets painted + prevPaint
		renderer.calls.length = 0;
		host.afterFull = 0;
		host.afterDamage = 0;
		// IDENTICAL entries: a table-only change produces no value diff at all. Drive the orchestrator the way
		// `applyRender` does for a tables render: first boolean = publishedChanged(false) || structuralChanged(false)
		// || tablesChanged(true) = true.
		const next = snap([entry(0, 0, num(1))]);
		const tablesChanged = true;
		orch.commitSnapshot(prev, next, /* publishedChanged */ false || /* structuralChanged */ false || tablesChanged);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw', 'a table-only render takes the FULL redraw path (never drawDamage)');
		assert.strictEqual(host.afterFull, 1, 'full-redraw path fires onAfterFullRedraw');
		assert.strictEqual(host.afterDamage, 0, 'a table-only render does NOT take the damage diff path (which would no-op on []) ');
	});

	test('a scroll change since the last paint forces a full redraw (damage pixels would be stale)', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(2, 0, num(1))]);
		orch.commitSnapshot(null, prev, false);
		renderer.calls.length = 0;
		// The viewport scrolled since the last paint -> scrollUnchangedSince is false -> full redraw.
		host.vp = { scrollTop: 200, scrollLeft: 0, cssW: 800, cssH: 600 };
		const next = snap([entry(2, 0, num(5))]);
		orch.commitSnapshot(prev, next, false);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
	});

	test('a sheet switch (prevSnapshot.sheet != snapshot.sheet) -> diff returns null -> full redraw', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(0, 0, num(1))], 0);
		orch.commitSnapshot(null, prev, false);
		renderer.calls.length = 0;
		const next = snap([entry(0, 0, num(1))], 1); // different sheet
		orch.commitSnapshot(prev, next, false);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
	});

	test('backingScaleStale forces a full redraw (a dpr change with no resize)', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(3, 0, num(1))]);
		orch.commitSnapshot(null, prev, false);
		renderer.calls.length = 0;
		renderer.backingScaleStale = true;
		const next = snap([entry(3, 0, num(2))]);
		orch.commitSnapshot(prev, next, false);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
	});

	test('an empty diff (no value change) at the same scroll is a no-op drawDamage (no full repaint)', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		const prev = snap([entry(0, 0, num(1))]);
		orch.commitSnapshot(null, prev, false);
		renderer.calls.length = 0;
		host.afterFull = 0;
		const next = snap([entry(0, 0, num(1))]); // identical
		orch.commitSnapshot(prev, next, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'drawDamage');
		assert.deepStrictEqual(renderer.calls[0].rows, [], 'an unchanged snapshot damages no rows');
		assert.strictEqual(host.afterFull, 0);
	});
});

suite('FE-2 render orchestrator -- commitErrorDamage (error-tint flip decision)', function () {
	test('a newly-tinted cell at the same scroll damages exactly its row', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw(); // establish painted + prevPaint
		renderer.calls.length = 0;
		const prevKeys = new Set(host.errorCells.keys()); // empty
		host.errorCells.set('7,3', '[#ERR] boom'); // tint row 7 AFTER capturing prevKeys
		orch.commitErrorDamage(prevKeys, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'drawDamage');
		assert.deepStrictEqual(renderer.calls[0].rows, [7]);
	});

	test('Wave F: while a split is active, the same tint flip forces a full redraw (no damage)', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw();
		renderer.calls.length = 0;
		host.splitActive = true; // the only difference from the damage test above
		const prevKeys = new Set(host.errorCells.keys());
		host.errorCells.set('7,3', '[#ERR] boom');
		orch.commitErrorDamage(prevKeys, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'draw', 'split forces the full (split) paint, never a tint-flip damage');
	});

	test('forceFullRedraw (selection realign) -> full redraw, never a tint-flip damage', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw();
		renderer.calls.length = 0;
		host.afterFull = 0; // the establishing redraw above already fired it once
		const prevKeys = new Set(host.errorCells.keys());
		host.errorCells.set('7,3', '[#ERR] boom');
		orch.commitErrorDamage(prevKeys, true);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
		assert.strictEqual(host.afterFull, 1, 'the full-redraw branch fires onAfterFullRedraw');
	});

	test('a scroll change since the last paint forces a full redraw', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		orch.redraw();
		renderer.calls.length = 0;
		host.vp = { scrollTop: 150, scrollLeft: 0, cssW: 800, cssH: 600 }; // scrolled
		const prevKeys = new Set(host.errorCells.keys());
		host.errorCells.set('7,3', '[#ERR] boom');
		orch.commitErrorDamage(prevKeys, false);
		assert.strictEqual(renderer.calls[0].kind, 'draw');
	});

	test('re-erroring an already-tinted cell flips nothing -> a no-op drawDamage', () => {
		const { host, renderer, orch } = make();
		host.vp = { scrollTop: 0, scrollLeft: 0, cssW: 800, cssH: 600 };
		host.errorCells.set('7,3', '[#ERR] old');
		orch.redraw();
		renderer.calls.length = 0;
		const prevKeys = new Set(host.errorCells.keys()); // already contains 7,3
		host.errorCells.set('7,3', '[#ERR] new'); // same key -> no flip
		orch.commitErrorDamage(prevKeys, false);
		assert.strictEqual(renderer.calls.length, 1);
		assert.strictEqual(renderer.calls[0].kind, 'drawDamage');
		assert.deepStrictEqual(renderer.calls[0].rows, []);
	});
});
