/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-2 BAKEOFF (2026-06-09) -- unit tests for the render-bench's PURE logic: the synthetic dataset
 * generators (`webview/render-bench/datasets.ts`: queryRange windowing + snapshotDelta) and the
 * metric/gate math (`webview/render-bench/metrics.ts`: percentile, fps, worst-1s, gate evaluation).
 * These are the load-bearing, non-DOM half of the bench; the actual rAF/canvas timing loop is not
 * headlessly testable (operator runs the bench panel).
 *
 * Pure -- no vscode, no DOM -- so it runs under plain mocha.
 */

import * as assert from 'assert';

import {
	BENCH_DATASETS,
	BLANK_EXCEL_EXTENT,
	DENSE_50K_20,
	queryRange,
	snapshotDelta,
} from '../webview/render-bench/datasets';
import {
	damageGates,
	heapGate,
	inputGate,
	msToFps,
	percentile,
	reduceScenario,
	scrollGates,
	worstOneSecondFps,
} from '../webview/render-bench/metrics';

suite('FE-2 bench datasets -- queryRange windowing', function () {
	test('a window returns only the populated cells inside it (sparse shape)', () => {
		// dense dataset: every cell populated -> a 2x3 window has 6 entries.
		const snap = queryRange(DENSE_50K_20, 10, 12, 5, 8);
		assert.strictEqual(snap.entries.length, 6);
		for (const e of snap.entries) {
			assert.ok(e.row >= 10 && e.row < 12, 'row in window');
			assert.ok(e.col >= 5 && e.col < 8, 'col in window');
			assert.strictEqual(e.value.kind, 'number');
		}
		assert.strictEqual(snap.snapshot_format_version, 1);
	});

	test('the window clamps to the dataset extent (no out-of-range entries)', () => {
		// Request past the bottom-right corner -> clamped, no entries beyond the extent.
		const snap = queryRange(DENSE_50K_20, 49998, 50010, 18, 40);
		assert.ok(snap.entries.every(e => e.row < 50000 && e.col < 20), 'clamped to 50000x20');
		assert.strictEqual(snap.entries.length, 2 * 2, '2 rows (49998,49999) x 2 cols (18,19)');
	});

	test('a blank-extent dataset yields ZERO entries for any window (just gridlines live)', () => {
		const snap = queryRange(BLANK_EXCEL_EXTENT, 0, 100, 0, 100);
		assert.strictEqual(snap.entries.length, 0);
	});

	test('an inverted / empty window yields no entries (no negative loop)', () => {
		assert.strictEqual(queryRange(DENSE_50K_20, 20, 10, 0, 5).entries.length, 0);
		assert.strictEqual(queryRange(DENSE_50K_20, 0, 5, 8, 8).entries.length, 0);
	});
});

suite('FE-2 bench datasets -- snapshotDelta', function () {
	test('a delta replaces a cell value + leaves the rest untouched (a fresh object)', () => {
		const base = queryRange(DENSE_50K_20, 0, 3, 0, 3); // 9 entries
		const next = snapshotDelta(base, [{ row: 1, col: 1, value: { kind: 'number', value: 999 } }]);
		assert.notStrictEqual(next, base, 'a NEW snapshot object (diffSnapshotsA1 compares prev vs next)');
		assert.strictEqual(next.entries.length, 9, 'same cell count (an existing cell was replaced)');
		const changed = next.entries.find(e => e.row === 1 && e.col === 1);
		assert.ok(changed && changed.value.kind === 'number' && changed.value.value === 999);
	});

	test('a delta APPENDS a newly-populated cell that was not in the base', () => {
		const base = queryRange(BLANK_EXCEL_EXTENT, 0, 10, 0, 10); // empty
		const next = snapshotDelta(base, [{ row: 5, col: 5, value: { kind: 'number', value: 1 } }]);
		assert.strictEqual(next.entries.length, 1);
		assert.strictEqual(next.entries[0].row, 5);
	});

	test('the delta preserves the base sheet number', () => {
		const base = queryRange(DENSE_50K_20, 0, 2, 0, 2);
		const next = snapshotDelta(base, []);
		assert.strictEqual(next.sheet, base.sheet);
	});
});

suite('FE-2 bench datasets -- catalogue', function () {
	test('all five bakeoff datasets are present in the brief order', () => {
		assert.deepStrictEqual(
			BENCH_DATASETS.map(d => d.id),
			['dense-50k-20', 'wide-10k-100', 'blank-excel-extent', 'text-stress', 'damage-stream'],
		);
	});
});

suite('FE-2 bench metrics -- percentile + fps', function () {
	test('percentile interpolates linearly', () => {
		assert.strictEqual(percentile([10, 20, 30, 40, 50], 50), 30);
		assert.strictEqual(percentile([10, 20, 30, 40], 50), 25); // between 20 and 30
		assert.strictEqual(percentile([10], 95), 10);
		assert.ok(Number.isNaN(percentile([], 50)));
	});

	test('p95 picks the near-top sample', () => {
		const s = [];
		for (let i = 1; i <= 100; i += 1) {
			s.push(i);
		}
		// p95 of 1..100 (linear interp on indices 0..99) = 95.05.
		assert.ok(Math.abs(percentile(s, 95) - 95.05) < 0.01);
	});

	test('msToFps converts; a sub-ms / zero frame clamps to Infinity (no divide-by-zero)', () => {
		assert.ok(Math.abs(msToFps(16.666) - 60) < 0.1);
		assert.strictEqual(msToFps(0), Number.POSITIVE_INFINITY);
		assert.strictEqual(msToFps(-1), Number.POSITIVE_INFINITY);
	});
});

suite('FE-2 bench metrics -- worstOneSecondFps', function () {
	test('a steady 60fps stream (16.67ms frames) reports ~60 worst-1s', () => {
		const frames = new Array(120).fill(1000 / 60);
		assert.ok(Math.abs(worstOneSecondFps(frames) - 60) < 0.5);
	});

	test('a single janky frame drags the worst-1s window down', () => {
		// 119 good frames + one 200ms stall: the window containing the stall has the lowest fps.
		const frames = new Array(119).fill(1000 / 60);
		frames.splice(60, 0, 200);
		const worst = worstOneSecondFps(frames);
		assert.ok(worst < 60, 'the stall window is slower than 60fps');
		assert.ok(worst > 0, 'still positive');
	});

	test('fewer than 1s of frames -> the whole-run fps (documented short-run behavior)', () => {
		const frames = [10, 10, 10]; // 30ms total, < 1000ms
		assert.ok(Math.abs(worstOneSecondFps(frames) - 100) < 0.1); // 1000/(30/3)=100
	});

	test('empty -> NaN', () => {
		assert.ok(Number.isNaN(worstOneSecondFps([])));
	});
});

suite('FE-2 bench metrics -- gate evaluation', function () {
	test('scroll gates PASS at 60fps / 16ms / 58fps-worst', () => {
		const frames = new Array(120).fill(1000 / 60);
		const m = reduceScenario('scroll', 'dense', frames, 200);
		const gates = scrollGates(m);
		assert.ok(gates.every(g => g.pass), 'all scroll gates pass for a healthy 60fps run');
		assert.strictEqual(gates.find(g => g.name === 'scroll p95 frame')?.comparator, '<=');
		assert.strictEqual(gates.find(g => g.name === 'scroll p50 fps')?.comparator, '>=');
	});

	test('scroll gates FAIL when p95 frame blows past 24ms', () => {
		const frames = new Array(120).fill(40); // 25fps, 40ms frames
		const m = reduceScenario('scroll', 'dense', frames, 200);
		const gates = scrollGates(m);
		assert.ok(!gates.find(g => g.name === 'scroll p95 frame')?.pass, 'a 40ms p95 fails the <=24ms gate');
		assert.ok(!gates.find(g => g.name === 'scroll p50 fps')?.pass, '25fps fails the >=58fps gate');
	});

	test('input gate is <=32ms; damage gates are <=16ms / <=50ms; heap gate is <=350MB', () => {
		assert.ok(inputGate(20).pass);
		assert.ok(!inputGate(40).pass);
		const [oneCell, thousand] = damageGates(10, 45);
		assert.ok(oneCell.pass && thousand.pass);
		assert.ok(!damageGates(20, 45)[0].pass, '20ms fails the 1-cell <=16ms gate');
		assert.ok(!damageGates(10, 60)[1].pass, '60ms fails the 1k-cell <=50ms gate');
		assert.ok(heapGate(300).pass);
		assert.ok(!heapGate(400).pass);
	});

	test('an unmeasurable heap (NaN) is reported, never a pass', () => {
		const g = heapGate(NaN);
		assert.strictEqual(g.pass, false, 'NaN <= 350 is false -> not a pass (No-Fallbacks: surfaced, not assumed-good)');
	});

	test('reduceScenario carries the real sample count + a heap-unavailable note', () => {
		const m = reduceScenario('scroll', 'dense', [16, 16, 17], NaN, 'performance.memory unavailable; heap not measured');
		assert.strictEqual(m.samples, 3, 'the exact sample count (no silent cap)');
		assert.ok(Number.isNaN(m.heapMb));
		assert.ok(m.note && m.note.includes('unavailable'));
	});
});
