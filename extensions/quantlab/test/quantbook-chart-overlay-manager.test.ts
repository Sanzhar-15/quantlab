/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

// Wave Q2b (2026-06-24) -- jsdom coverage for the ChartOverlayManager lifecycle + the move/resize drag (the
// deferred Q2a "DOM-lifecycle tests" item, now landed alongside move+resize). Covers:
//   - the pure clampChartDim helper (floor / ceiling / round / non-finite);
//   - sync() creates a positioned container (head + body + resize grip) and reconciles it away when the chart
//     leaves the active sheet's set;
//   - a header drag past the threshold posts `chartMoved` with the hit-tested cell + optimistically repositions;
//   - a sub-threshold press (a click) and a drop back onto the same cell post NOTHING;
//   - a corner-grip drag posts `chartResized` with the new px size, clamped to the minimum;
//   - a live drag is NOT stomped by a concurrent reposition() OR a sync() (render mid-drag);
//   - pointercancel mid-drag snaps the box back and posts nothing;
//   - a second pointerdown on another chart during a live drag is ignored (one drag at a time);
//   - a chart destroyed mid-drag (sheet switch) cancels the gesture so a late pointerup posts nothing;
//   - a press on the × (close) does NOT start a move.
// NOTE (GUI-smoke, not unit-testable here): jsdom has no layout (getBoundingClientRect is 0,0) and the tests
// stub cellAtClientPoint + force the no-Vega error branch (off-active srcSheet), so the move drop-pixel ->
// cell coordinate mapping (index.ts cellAtClientPoint) and the resize Vega re-embed/refit are covered by the
// deferred GATE-V GUI smoke, not by this suite.
// The charts use an OFF-active srcSheet so buildChartData returns !ok and renderEntry takes the error branch --
// the DOM/lifecycle/drag logic under test never reaches the async Vega embed (kept out of the unit env).

// DOM globals installed by `out/test/helpers/mocha-setup.js` via mocha --require.
import { resetDom } from './helpers/jsdom-shim';

import * as assert from 'assert';

import { ChartOverlayManager, clampChartDim, MIN_CHART_WIDTH_PX, MIN_CHART_HEIGHT_PX, MAX_CHART_DIM_PX } from '../webview/sheets-webview/chartOverlay';
import type { ChartJson } from '../src/quantbook/types';
import type { QvizTheme } from '../src/qviz/render/types';

const THEME: QvizTheme = {
	background: '#1e1e1e',
	foreground: '#cccccc',
	grid: '#333333',
	axisText: '#aaaaaa',
	seriesPalette: ['#4e79a7', '#59a14f'],
};

// srcSheet 5 != the test's active sheet 0 -> buildChartData !ok -> renderEntry error branch -> no Vega embed.
function makeChart(over: Partial<ChartJson> = {}): ChartJson {
	return {
		id: 1,
		name: 'Chart 1',
		chartType: 'line',
		sheet: 0,
		anchorRow: 2,
		anchorCol: 3,
		widthPx: 480,
		heightPx: 300,
		srcSheet: 5,
		srcStartRow: 0,
		srcStartCol: 0,
		srcEndRow: 9,
		srcEndCol: 1,
		...over,
	};
}

interface Harness {
	readonly mgr: ChartOverlayManager;
	readonly mount: HTMLElement;
	readonly posts: unknown[];
}

// anchorPos maps (row,col) -> deterministic content px (col*100, row*20) so the inline box is predictable.
function makeHarness(cellAt?: (x: number, y: number) => { row: number; col: number } | null): Harness {
	const mount = document.createElement('div');
	document.body.appendChild(mount);
	const posts: unknown[] = [];
	const mgr = new ChartOverlayManager({
		mount,
		post: (m: unknown) => posts.push(m),
		anchorPos: (row: number, col: number) => ({ left: col * 100, top: row * 20 }),
		clipInsets: () => ({ top: 0, left: 0 }),
		readCell: () => undefined,
		columnLabel: (col: number) => 'C' + col,
		theme: () => THEME,
		cellAtClientPoint: cellAt ?? (() => ({ row: 10, col: 7 })),
	});
	return { mgr, mount, posts };
}

// Construct from the jsdom WINDOW realm (matching the qviz inspector resize-handle tests) so the event is the
// same realm as the document it is dispatched into; jsdom 21 ships a MouseEvent-backed PointerEvent shim.
function pointer(type: string, clientX: number, clientY: number, pointerId: number): PointerEvent {
	const Ctor = (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
	return new Ctor(type, { clientX, clientY, pointerId, button: 0, bubbles: true });
}

function overlay(mount: HTMLElement): HTMLElement {
	const el = mount.querySelector('.qb-chart-overlay');
	assert.ok(el instanceof HTMLElement, 'expected a .qb-chart-overlay');
	return el;
}

function postsOfType(posts: readonly unknown[], type: string): Array<Record<string, unknown>> {
	return posts.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && (p as { type?: unknown }).type === type);
}

suite('Quantbook chart overlay manager -- lifecycle + move/resize drag (Wave Q2b)', () => {
	setup(() => { resetDom(); });

	suite('clampChartDim', () => {
		test('floors below the minimum', () => {
			assert.strictEqual(clampChartDim(50, MIN_CHART_WIDTH_PX), MIN_CHART_WIDTH_PX);
			assert.strictEqual(clampChartDim(0, MIN_CHART_HEIGHT_PX), MIN_CHART_HEIGHT_PX);
		});
		test('passes a value inside the window through (rounded to an integer px)', () => {
			assert.strictEqual(clampChartDim(500, MIN_CHART_WIDTH_PX), 500);
			assert.strictEqual(clampChartDim(300.7, MIN_CHART_HEIGHT_PX), 301);
		});
		test('caps at the maximum', () => {
			assert.strictEqual(clampChartDim(20000, MIN_CHART_WIDTH_PX), MAX_CHART_DIM_PX);
		});
		test('non-finite -> the minimum (never NaN/Infinity onto the wire)', () => {
			assert.strictEqual(clampChartDim(NaN, MIN_CHART_WIDTH_PX), MIN_CHART_WIDTH_PX);
			assert.strictEqual(clampChartDim(Infinity, MIN_CHART_HEIGHT_PX), MIN_CHART_HEIGHT_PX);
		});
	});

	test('sync creates a positioned container with head, body, and resize grip', () => {
		const { mgr, mount } = makeHarness();
		mgr.sync([makeChart()], 0);
		assert.strictEqual(mount.querySelectorAll('.qb-chart-overlay').length, 1);
		const root = overlay(mount);
		assert.strictEqual(root.style.left, '300px'); // anchorCol 3 * 100
		assert.strictEqual(root.style.top, '40px'); // anchorRow 2 * 20
		assert.strictEqual(root.style.width, '480px');
		assert.strictEqual(root.style.height, '300px');
		assert.ok(root.querySelector('.qb-chart-head'), 'has a header');
		assert.ok(root.querySelector('.qb-chart-body'), 'has a body');
		assert.ok(root.querySelector('.qb-chart-resize'), 'has a resize grip');
	});

	test('sync reconciles away a chart no longer in the active sheet set', () => {
		const { mgr, mount } = makeHarness();
		mgr.sync([makeChart()], 0);
		assert.strictEqual(mount.querySelectorAll('.qb-chart-overlay').length, 1);
		mgr.sync([], 0);
		assert.strictEqual(mount.querySelectorAll('.qb-chart-overlay').length, 0);
	});

	test('a header drag past the threshold posts chartMoved with the hit-tested cell + repositions optimistically', () => {
		const { mgr, mount, posts } = makeHarness(() => ({ row: 10, col: 7 }));
		mgr.sync([makeChart({ id: 42 })], 0);
		const root = overlay(mount);
		const head = root.querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 450, 130, 1)); // dx 50, dy 30 -> past the 3px threshold
		window.dispatchEvent(pointer('pointerup', 450, 130, 1));
		const moved = postsOfType(posts, 'chartMoved');
		assert.strictEqual(moved.length, 1);
		assert.deepStrictEqual(moved[0], { type: 'chartMoved', id: 42, sheet: 0, anchorRow: 10, anchorCol: 7 });
		// Optimistic reposition to the new anchor (col 7 * 100, row 10 * 20).
		assert.strictEqual(root.style.left, '700px');
		assert.strictEqual(root.style.top, '200px');
	});

	test('a sub-threshold press (a click) posts nothing', () => {
		const { mgr, mount, posts } = makeHarness();
		mgr.sync([makeChart()], 0);
		const head = overlay(mount).querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 401, 100, 1)); // dx 1 -> below threshold
		window.dispatchEvent(pointer('pointerup', 401, 100, 1));
		assert.strictEqual(posts.length, 0);
	});

	test('a move drop back onto the same anchor cell posts nothing', () => {
		const { mgr, mount, posts } = makeHarness(() => ({ row: 2, col: 3 })); // == the chart's current anchor
		mgr.sync([makeChart()], 0);
		const head = overlay(mount).querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 460, 140, 1));
		window.dispatchEvent(pointer('pointerup', 460, 140, 1));
		assert.strictEqual(postsOfType(posts, 'chartMoved').length, 0);
	});

	test('a move drop over a null target (header/gutter/off-grid) posts nothing and snaps back', () => {
		const { mgr, mount, posts } = makeHarness(() => null);
		mgr.sync([makeChart()], 0);
		const root = overlay(mount);
		const head = root.querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 460, 140, 1));
		window.dispatchEvent(pointer('pointerup', 460, 140, 1));
		assert.strictEqual(postsOfType(posts, 'chartMoved').length, 0);
		assert.strictEqual(root.style.left, '300px'); // snapped back to the persisted anchor
		assert.strictEqual(root.style.top, '40px');
	});

	test('a corner-grip drag posts chartResized with the new px size', () => {
		const { mgr, mount, posts } = makeHarness();
		mgr.sync([makeChart({ id: 7 })], 0);
		const root = overlay(mount);
		const grip = root.querySelector('.qb-chart-resize') as HTMLElement;
		grip.dispatchEvent(pointer('pointerdown', 800, 400, 2));
		window.dispatchEvent(pointer('pointermove', 900, 460, 2)); // dx 100, dy 60 -> 580 x 360
		window.dispatchEvent(pointer('pointerup', 900, 460, 2));
		const resized = postsOfType(posts, 'chartResized');
		assert.strictEqual(resized.length, 1);
		assert.deepStrictEqual(resized[0], { type: 'chartResized', id: 7, sheet: 0, widthPx: 580, heightPx: 360 });
		assert.strictEqual(root.style.width, '580px');
		assert.strictEqual(root.style.height, '360px');
	});

	test('a resize drag below the minimum clamps to the floor', () => {
		const { mgr, mount, posts } = makeHarness();
		mgr.sync([makeChart()], 0);
		const grip = overlay(mount).querySelector('.qb-chart-resize') as HTMLElement;
		grip.dispatchEvent(pointer('pointerdown', 800, 400, 2));
		window.dispatchEvent(pointer('pointermove', 300, 420, 2)); // dx -500 -> 480-500 < min; dy 20 -> 320
		window.dispatchEvent(pointer('pointerup', 300, 420, 2));
		const resized = postsOfType(posts, 'chartResized');
		assert.strictEqual(resized.length, 1);
		assert.strictEqual(resized[0].widthPx, MIN_CHART_WIDTH_PX);
		assert.strictEqual(resized[0].heightPx, 320);
	});

	test('a live drag is not stomped by a concurrent reposition()', () => {
		const { mgr, mount } = makeHarness();
		mgr.sync([makeChart()], 0);
		const root = overlay(mount);
		const head = root.querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 450, 130, 1)); // root.left now 350px (start 300 + dx 50)
		assert.strictEqual(root.style.left, '350px');
		mgr.reposition(); // must NOT reset the dragged entry to its persisted box
		assert.strictEqual(root.style.left, '350px');
		window.dispatchEvent(pointer('pointerup', 450, 130, 1)); // ends the drag cleanly
	});

	test('a sync (render) during a live drag does not stomp the dragged entry', () => {
		const { mgr, mount } = makeHarness();
		const chart = makeChart();
		mgr.sync([chart], 0);
		const root = overlay(mount);
		const head = root.querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 450, 130, 1)); // root.left -> 350px
		assert.strictEqual(root.style.left, '350px');
		// A render arrives mid-drag (e.g. a recalc on another cell re-posts charts[]) -> sync must leave the
		// dragged box alone (positionEntry is suppressed for the dragged entry), not snap it to the anchor.
		mgr.sync([chart], 0);
		assert.strictEqual(root.style.left, '350px');
		window.dispatchEvent(pointer('pointerup', 450, 130, 1));
	});

	test('pointercancel mid-drag snaps the chart back and posts nothing', () => {
		const { mgr, mount, posts } = makeHarness();
		mgr.sync([makeChart()], 0);
		const root = overlay(mount);
		const head = root.querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 460, 140, 1)); // root.left -> 360px
		assert.strictEqual(root.style.left, '360px');
		window.dispatchEvent(pointer('pointercancel', 460, 140, 1));
		assert.strictEqual(root.style.left, '300px'); // discarded -> snapped back to the persisted anchor
		assert.strictEqual(postsOfType(posts, 'chartMoved').length, 0);
	});

	test('a second pointerdown on another chart during a live drag is ignored (one drag at a time)', () => {
		const { mgr, mount } = makeHarness();
		mgr.sync([makeChart({ id: 1, anchorCol: 3 }), makeChart({ id: 2, anchorCol: 8 })], 0);
		const roots = mount.querySelectorAll('.qb-chart-overlay');
		const root2 = roots[1] as HTMLElement;
		assert.strictEqual(root2.style.left, '800px'); // chart 2 anchorCol 8 * 100
		const head1 = (roots[0] as HTMLElement).querySelector('.qb-chart-head') as HTMLElement;
		const head2 = root2.querySelector('.qb-chart-head') as HTMLElement;
		head1.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 450, 130, 1)); // drag chart 1
		head2.dispatchEvent(pointer('pointerdown', 900, 100, 2)); // ignored: a drag is already live
		window.dispatchEvent(pointer('pointermove', 950, 130, 2)); // filtered out by pointerId mismatch
		assert.strictEqual(root2.style.left, '800px'); // chart 2 never moved
		window.dispatchEvent(pointer('pointerup', 450, 130, 1)); // finish chart 1
	});

	test('a chart destroyed mid-drag cancels the gesture: a late pointerup posts nothing', () => {
		const { mgr, mount, posts } = makeHarness();
		mgr.sync([makeChart()], 0);
		const head = overlay(mount).querySelector('.qb-chart-head') as HTMLElement;
		head.dispatchEvent(pointer('pointerdown', 400, 100, 1));
		window.dispatchEvent(pointer('pointermove', 450, 130, 1));
		mgr.sync([], 0); // sheet switch hides the chart -> destroyEntry cancels the drag + removes the container
		assert.strictEqual(mount.querySelectorAll('.qb-chart-overlay').length, 0);
		window.dispatchEvent(pointer('pointerup', 450, 130, 1)); // listener already removed -> no-op
		assert.strictEqual(postsOfType(posts, 'chartMoved').length, 0);
	});

	test('a press on the close button does not start a move drag', () => {
		const { mgr, mount, posts } = makeHarness();
		mgr.sync([makeChart()], 0);
		const root = overlay(mount);
		const close = root.querySelector('.qb-chart-close') as HTMLElement;
		// pointerdown bubbles from the × up to the header; the header guard sees the close target and bails.
		close.dispatchEvent(pointer('pointerdown', 300, 40, 1));
		window.dispatchEvent(pointer('pointermove', 360, 80, 1));
		window.dispatchEvent(pointer('pointerup', 360, 80, 1));
		assert.strictEqual(postsOfType(posts, 'chartMoved').length, 0);
	});
});
