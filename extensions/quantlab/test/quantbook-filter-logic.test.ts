/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// **Wave G3b / R4 (2026-06-19)** -- unit tests for the vscode-free core of the Cell Grid AutoFilter:
// usedRangeFromEntries, distinctValuesInColumn, computeFilterHidden (cross-column AND, header excluded),
// reconcileHidden (the filter-vs-manual-hide diff), and pruneToLive (the render-time self-heal). The #1
// correctness target -- the filter NEVER unhides a manual Hide, and the partition stays honest across
// undo/redo -- is pinned FIRST as a deterministic unit suite (the leaf-first payoff), before any host wiring.
// Runs in the normal mocha suite (no engine, no vscode).

import * as assert from 'assert';

import {
	computeFilterHidden,
	displayStringOf,
	distinctValuesInColumn,
	nextFilterHidden,
	pruneToLive,
	reconcileHidden,
	usedRangeFromEntries,
	type FilterCellEntry,
	type FilterRange,
} from '../src/quantbook/cellGrid/filterLogic';

/** A number-valued cell entry. */
function num(row: number, col: number, value: number, rendered?: string): FilterCellEntry {
	return rendered === undefined
		? { row, col, value: { kind: 'number', value } }
		: { row, col, value: { kind: 'number', value }, rendered };
}

/** A text-valued cell entry. */
function txt(row: number, col: number, value: string): FilterCellEntry {
	return { row, col, value: { kind: 'text', value } };
}

/** A criteria map from a plain object of col -> excluded display values. */
function criteria(spec: Record<number, string[]>): Map<number, Set<string>> {
	const m = new Map<number, Set<string>>();
	for (const [col, vals] of Object.entries(spec)) {
		m.set(Number(col), new Set(vals));
	}
	return m;
}

const sorted = (s: ReadonlySet<number>): number[] => Array.from(s).sort((a, b) => a - b);

// ---------------------------------------------------------------------------------------------------------
// THE #1 MEGAUDIT TARGET -- filter vs manual hide, across undo/redo (pinned first).
// ---------------------------------------------------------------------------------------------------------
suite('G3b filterLogic -- #1: filter vs manual-hide reconciliation', () => {
	test('(a) a manual Hide survives a filter change -- the filter never unhides a row it did not hide', () => {
		// Manual hide of row 9 (M = {9}); the filter previously hid {3,4} (fOld). The engine live set is the
		// UNION the host can observe: {3,4,9}. The user changes the filter so it now hides {4,5} (fNew).
		const fOld = new Set([3, 4]);
		const fNew = new Set([4, 5]);
		const live = [3, 4, 9];
		const { toHide, toUnhide } = reconcileHidden(fOld, fNew, live);
		assert.deepStrictEqual(toHide, [5], 'newly filter-hidden row');
		assert.deepStrictEqual(toUnhide, [3], 'row the filter dropped (3); NOT the manual row 9');
		assert.ok(!toUnhide.includes(9), 'the manual hide 9 is structurally untouched (9 not in fOld)');
	});

	test('(b) filter -> undo -> filter leaves no phantom (undo revealed a filter row without a callback)', () => {
		// The filter hid {3,4} (fOld). An undo reverts that engine op: live no longer contains 3 or 4.
		// pruneToLive must drop the phantoms so a later reconcile cannot mis-attribute them.
		const fOldStale = new Set([3, 4]);
		const liveAfterUndo: number[] = []; // engine reverted the hide
		const healed = pruneToLive(fOldStale, liveAfterUndo);
		assert.deepStrictEqual(sorted(healed), [], 'phantoms dropped: filterHidden <- filterHidden intersect live');
		// Re-applying the SAME criteria now re-hides cleanly from the healed base (no spurious unhide).
		const fNew = new Set([3, 4]);
		const { toHide, toUnhide } = reconcileHidden(healed, fNew, liveAfterUndo);
		assert.deepStrictEqual(toHide, [3, 4], 're-hide both');
		assert.deepStrictEqual(toUnhide, [], 'nothing spuriously unhidden');
	});

	test('(c) cross-column AND under a partial clear -- clearing col A preserves col B hides', () => {
		// Col 0 excludes "x" (hides rows 2,5); col 1 excludes "y" (hides rows 5,7). F = {2,5,7}.
		const entries: FilterCellEntry[] = [
			txt(0, 0, 'hdr0'), txt(0, 1, 'hdr1'),
			txt(2, 0, 'x'), txt(2, 1, 'ok'),
			txt(5, 0, 'x'), txt(5, 1, 'y'),
			txt(7, 0, 'ok'), txt(7, 1, 'y'),
		];
		const range: FilterRange = { minRow: 0, maxRow: 7, minCol: 0, maxCol: 1 };
		const fBoth = computeFilterHidden(entries, range, criteria({ 0: ['x'], 1: ['y'] }));
		assert.deepStrictEqual(sorted(fBoth), [2, 5, 7], 'union of both columns failures');
		// Clear col 0 -> only col 1 criteria remain. Rows 5,7 (the "y" rows) stay hidden; row 2 reappears.
		const fAfterClearA = computeFilterHidden(entries, range, criteria({ 1: ['y'] }));
		assert.deepStrictEqual(sorted(fAfterClearA), [5, 7], 'col B hides preserved; col A row 2 dropped');
		const live = [2, 5, 7];
		const { toHide, toUnhide } = reconcileHidden(fBoth, fAfterClearA, live);
		assert.deepStrictEqual(toHide, [], 'nothing new to hide');
		assert.deepStrictEqual(toUnhide, [2], 'only row 2 (lost its sole reason) unhidden');
	});

	test('(a2) THE 5-LANE-AUDIT HIGH: an excluded value that ALSO matches a manually-hidden row must not let the filter claim it', () => {
		// Manual Hide row 9 (live={9}); the filter is freshly enabled (fOld={}). The user unchecks a value that
		// row 9 happens to have, so fNew={9}. reconcile: nothing to hide (9 already live-hidden) -> the filter did
		// NOT cause 9 to be hidden. nextFilterHidden must therefore NOT record 9 (recording fNew would claim it).
		const fOld = new Set<number>();
		const fNew = new Set([9]);
		const live = [9];
		const { toHide, toUnhide } = reconcileHidden(fOld, fNew, live);
		assert.deepStrictEqual(toHide, [], 'row 9 already hidden -> no engine hide');
		assert.deepStrictEqual(toUnhide, []);
		const filterHidden = nextFilterHidden(fOld, fNew, live, toHide);
		assert.deepStrictEqual(sorted(filterHidden), [], 'the filter must NOT own row 9 (it never hid it)');
		// Now toggle the filter OFF: fNew={}. With the CORRECT filterHidden ({}), nothing is unhidden -> the
		// manual hide survives. (With the BUGGY filterHidden={9}, toUnhide would be [9] -> manual hide destroyed.)
		const off = reconcileHidden(filterHidden, new Set<number>(), live);
		assert.deepStrictEqual(off.toUnhide, [], 'toggle-off must NOT unhide the manual row 9');
	});

	test('(a3) nextFilterHidden collapses to fNew when there are NO manual hides (the common case)', () => {
		// No manual hides: every fNew row the filter wants is one it actually hid -> filterHidden tracks fNew.
		assert.deepStrictEqual(sorted(nextFilterHidden(new Set<number>(), new Set([3, 4]), [], [3, 4])), [3, 4]);
		// Tighten from {3,4} to {3,4,5}: previously-owned {3,4} stay; new {5} added.
		assert.deepStrictEqual(sorted(nextFilterHidden(new Set([3, 4]), new Set([3, 4, 5]), [3, 4], [5])), [3, 4, 5]);
		// Relax from {3,4,5} to {3,4}: 5 is unhidden -> dropped from ownership.
		assert.deepStrictEqual(sorted(nextFilterHidden(new Set([3, 4, 5]), new Set([3, 4]), [3, 4, 5], [])), [3, 4]);
	});

	test('(a4) nextFilterHidden drops a phantom (a row no longer in live) without relying on pruneToLive', () => {
		// fOld claims {3,5} but the engine reverted 5 (live={3}); even if fNew still wants 5, it is not live -> not owned.
		assert.deepStrictEqual(sorted(nextFilterHidden(new Set([3, 5]), new Set([3, 5]), [3], [])), [3]);
	});

	test('(d) one-call vs two-call emission -- the host branches on which arrays are empty', () => {
		// Tightening only (toUnhide empty) -> one setRowsHidden call.
		const tighten = reconcileHidden(new Set([3]), new Set([3, 6]), [3]);
		assert.deepStrictEqual(tighten.toHide, [6]);
		assert.deepStrictEqual(tighten.toUnhide, [], 'one-call: only hide');
		// Relaxing only (toHide empty) -> one call.
		const relax = reconcileHidden(new Set([3, 6]), new Set([3]), [3, 6]);
		assert.deepStrictEqual(relax.toHide, []);
		assert.deepStrictEqual(relax.toUnhide, [6], 'one-call: only unhide');
		// Both directions in a single Apply -> two calls.
		const both = reconcileHidden(new Set([3, 6]), new Set([6, 9]), [3, 6]);
		assert.deepStrictEqual(both.toHide, [9]);
		assert.deepStrictEqual(both.toUnhide, [3], 'two-call: hide AND unhide');
	});
});

// ---------------------------------------------------------------------------------------------------------
// reconcileHidden -- structural invariants.
// ---------------------------------------------------------------------------------------------------------
suite('G3b filterLogic -- reconcileHidden invariants', () => {
	test('toUnhide is always a subset of fOld (manual hides never unhidden)', () => {
		const fOld = new Set([1, 2, 3]);
		const fNew = new Set([2, 10, 11]);
		const live = [1, 2, 3, 50, 51]; // 50,51 are manual hides outside fOld
		const { toUnhide } = reconcileHidden(fOld, fNew, live);
		for (const r of toUnhide) {
			assert.ok(fOld.has(r), `toUnhide ${r} must be in fOld`);
		}
		assert.ok(!toUnhide.includes(50) && !toUnhide.includes(51), 'manual hides untouched');
	});

	test('toHide excludes rows already hidden in live (no redundant re-hide)', () => {
		const { toHide } = reconcileHidden(new Set<number>(), new Set([4, 5]), [4]);
		assert.deepStrictEqual(toHide, [5], '4 already hidden in live, only 5 needs hiding');
	});

	test('empty fNew with empty fOld is a total no-op', () => {
		const { toHide, toUnhide } = reconcileHidden(new Set<number>(), new Set<number>(), [7, 8]);
		assert.deepStrictEqual(toHide, []);
		assert.deepStrictEqual(toUnhide, []);
	});

	test('toggle-OFF shape: fNew empty unhides exactly fOld intersect live', () => {
		const { toHide, toUnhide } = reconcileHidden(new Set([2, 4, 6]), new Set<number>(), [2, 6, 99]);
		assert.deepStrictEqual(toHide, []);
		assert.deepStrictEqual(toUnhide, [2, 6], '4 already revealed in live is skipped; 99 (manual) untouched');
	});
});

// ---------------------------------------------------------------------------------------------------------
// computeFilterHidden -- cross-column AND, header exclusion, blanks pass.
// ---------------------------------------------------------------------------------------------------------
suite('G3b filterLogic -- computeFilterHidden', () => {
	const entries: FilterCellEntry[] = [
		txt(0, 0, 'Region'), txt(0, 1, 'Year'),
		txt(1, 0, 'East'), num(1, 1, 2024),
		txt(2, 0, 'West'), num(2, 1, 2024),
		txt(3, 0, 'East'), num(3, 1, 2025),
		// row 4 col 0 is BLANK (no entry); col 1 present
		num(4, 1, 2025),
	];
	const range: FilterRange = { minRow: 0, maxRow: 4, minCol: 0, maxCol: 1 };

	test('a single excluded value hides its data rows; the header row is never hidden', () => {
		const hidden = computeFilterHidden(entries, range, criteria({ 0: ['East'] }));
		assert.deepStrictEqual(sorted(hidden), [1, 3], 'rows with Region=East');
		assert.ok(!hidden.has(0), 'header row 0 never filter-hidden');
	});

	test('cross-column AND: a row hidden iff it fails ANY filtered column', () => {
		// Exclude Region=West (row 2) AND Year=2025 (rows 3,4) -> union {2,3,4}.
		const hidden = computeFilterHidden(entries, range, criteria({ 0: ['West'], 1: ['2025'] }));
		assert.deepStrictEqual(sorted(hidden), [2, 3, 4]);
	});

	test('a blank-in-column row passes that column (MVP "(Blanks)" deferral)', () => {
		// Row 4 is blank in col 0; excluding everything present in col 0 must not hide row 4.
		const hidden = computeFilterHidden(entries, range, criteria({ 0: ['East', 'West'] }));
		assert.ok(!hidden.has(4), 'blank-in-col-0 row 4 is not hidden by col 0');
		assert.deepStrictEqual(sorted(hidden), [1, 2, 3]);
	});

	test('an empty excluded set for a column is treated as unfiltered', () => {
		const hidden = computeFilterHidden(entries, range, criteria({ 0: [] }));
		assert.deepStrictEqual(sorted(hidden), []);
	});

	test('the rendered display string (not the raw value) is what matches', () => {
		// A number 1234.5 rendered as "$1,234.50" -- excluding the rendered string hides it.
		const e2: FilterCellEntry[] = [txt(0, 0, 'Amt'), num(1, 0, 1234.5, '$1,234.50'), num(2, 0, 10)];
		const r2: FilterRange = { minRow: 0, maxRow: 2, minCol: 0, maxCol: 0 };
		const hidden = computeFilterHidden(e2, r2, criteria({ 0: ['$1,234.50'] }));
		assert.deepStrictEqual(sorted(hidden), [1]);
	});
});

// ---------------------------------------------------------------------------------------------------------
// distinctValuesInColumn / usedRangeFromEntries / displayStringOf.
// ---------------------------------------------------------------------------------------------------------
suite('G3b filterLogic -- enumeration + range', () => {
	test('distinct values dedupe, exclude the header row, and sort numeric-before-text', () => {
		const entries: FilterCellEntry[] = [
			txt(0, 0, 'Header'),
			txt(1, 0, 'banana'), num(2, 0, 10), txt(3, 0, 'apple'), num(4, 0, 2), txt(5, 0, 'banana'),
		];
		// data rows [1..5]
		const vals = distinctValuesInColumn(entries, 0, 1, 5);
		assert.deepStrictEqual(vals, ['2', '10', 'apple', 'banana'], 'numbers first (numeric order), then text, deduped');
	});

	test('distinct values ignore other columns and out-of-band rows', () => {
		const entries: FilterCellEntry[] = [txt(1, 0, 'a'), txt(1, 1, 'OTHER'), txt(9, 0, 'OUT')];
		assert.deepStrictEqual(distinctValuesInColumn(entries, 0, 1, 5), ['a']);
	});

	test('usedRangeFromEntries is the bounding box; null on an empty sheet', () => {
		assert.strictEqual(usedRangeFromEntries([]), null);
		const r = usedRangeFromEntries([num(2, 1, 0), num(7, 4, 0), num(3, 0, 0)]);
		assert.deepStrictEqual(r, { minRow: 2, maxRow: 7, minCol: 0, maxCol: 4 });
	});

	test('displayStringOf prefers rendered, else formats the value', () => {
		assert.strictEqual(displayStringOf(num(1, 0, 5, 'five')), 'five');
		assert.strictEqual(displayStringOf(num(1, 0, 5)), '5');
		assert.strictEqual(displayStringOf(txt(1, 0, 'hi')), 'hi');
		assert.strictEqual(displayStringOf({ row: 1, col: 0, value: { kind: 'boolean', value: true } }), 'TRUE');
	});
});

// ---------------------------------------------------------------------------------------------------------
// pruneToLive -- the render-time self-heal.
// ---------------------------------------------------------------------------------------------------------
suite('G3b filterLogic -- pruneToLive', () => {
	test('keeps only rows the engine still hides', () => {
		assert.deepStrictEqual(sorted(pruneToLive(new Set([1, 2, 3]), [2, 3, 9])), [2, 3], 'drops 1 (revealed); ignores 9 (manual)');
	});
	test('empty live prunes everything', () => {
		assert.deepStrictEqual(sorted(pruneToLive(new Set([1, 2]), [])), []);
	});
});
