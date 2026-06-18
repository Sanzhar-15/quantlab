/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-6 / R18 Wave E (2026-06-18) -- unit tests for the SQL-query sidebar's pure logic (sqlPanelCore: A1
// target parsing/formatting, SQL-non-empty validation, the available-tables hint list, and the orphan-cell
// rectangle subtraction) and the standalone SqlResultsStore (the Python-independent badge store). Runs in
// the normal mocha suite (no vscode / no napi / no ipykernel).

import * as assert from 'assert';

import type { CellRangeJson } from '../src/quantbook/types';
import {
	buildAvailableTables,
	formatA1Range,
	parseA1Range,
	rectDifference,
	sqlOrphanClearRanges,
	validateSqlText,
	type RectLite,
} from '../src/quantbook/shared/sqlPanelCore';
import { SqlResultsStore } from '../src/quantbook/cellGrid/sqlResultsStore';

function rect(startRow: number, startCol: number, endRow: number, endCol: number): RectLite {
	return { startRow, startCol, endRow, endCol };
}

function range(sheet: number, startRow: number, startCol: number, endRow = startRow, endCol = startCol): CellRangeJson {
	return { sheet, startRow, startCol, endRow, endCol };
}

suite('Wave E sqlPanelCore -- parseA1Range', () => {
	test('a single cell parses to a 0-based degenerate rect', () => {
		assert.deepStrictEqual(parseA1Range('A1'), { ok: true, rect: rect(0, 0, 0, 0) });
		assert.deepStrictEqual(parseA1Range('B2'), { ok: true, rect: rect(1, 1, 1, 1) });
		assert.deepStrictEqual(parseA1Range('AA1'), { ok: true, rect: rect(0, 26, 0, 26) });
	});

	test('a two-cell range parses inclusively', () => {
		assert.deepStrictEqual(parseA1Range('A1:C10'), { ok: true, rect: rect(0, 0, 9, 2) });
	});

	test('is case-insensitive and strips $ anchors and whitespace', () => {
		assert.deepStrictEqual(parseA1Range('  $a$1 : $c$10 '), { ok: true, rect: rect(0, 0, 9, 2) });
	});

	test('normalises a reversed range (C10:A1 -> A1:C10)', () => {
		assert.deepStrictEqual(parseA1Range('C10:A1'), { ok: true, rect: rect(0, 0, 9, 2) });
	});

	test('the last legal cell XFD1048576 parses', () => {
		assert.deepStrictEqual(parseA1Range('XFD1048576'), { ok: true, rect: rect(1_048_575, 16_383, 1_048_575, 16_383) });
	});

	test('empty / whitespace input is a loud error, never a default', () => {
		assert.strictEqual(parseA1Range('').ok, false);
		assert.strictEqual(parseA1Range('   ').ok, false);
	});

	test('malformed tokens error (no row, no col, too many colons, garbage)', () => {
		assert.strictEqual(parseA1Range('A').ok, false);
		assert.strictEqual(parseA1Range('1').ok, false);
		assert.strictEqual(parseA1Range('A1:B2:C3').ok, false);
		assert.strictEqual(parseA1Range('A0').ok, false); // row is 1-based; 0 is invalid
		assert.strictEqual(parseA1Range('hello').ok, false);
		assert.strictEqual(parseA1Range('A1:Z').ok, false);
	});

	test('out-of-extent column/row error (XFE / row past the last)', () => {
		assert.strictEqual(parseA1Range('XFE1').ok, false); // one column past XFD
		assert.strictEqual(parseA1Range('A1048577').ok, false); // one row past the last
	});

	test('a sheet-qualified target is rejected with a clear message (v1 targets the focused sheet only)', () => {
		const r = parseA1Range('Sheet2!A1');
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.ok(/sheet-qualified/i.test(r.error), `expected a sheet-qualified message, got: ${r.error}`);
		}
	});
});

suite('Wave E sqlPanelCore -- formatA1Range (round-trip)', () => {
	test('formats a single cell without a colon', () => {
		assert.strictEqual(formatA1Range(rect(0, 0, 0, 0)), 'A1');
		assert.strictEqual(formatA1Range(rect(1, 26, 1, 26)), 'AA2');
	});

	test('formats a range with a colon', () => {
		assert.strictEqual(formatA1Range(rect(0, 0, 9, 2)), 'A1:C10');
	});

	test('parse -> format is stable for a normalised range', () => {
		const parsed = parseA1Range('a1:c10');
		assert.strictEqual(parsed.ok, true);
		if (parsed.ok) {
			assert.strictEqual(formatA1Range(parsed.rect), 'A1:C10');
		}
	});
});

suite('Wave E sqlPanelCore -- validateSqlText', () => {
	test('a non-empty query passes and is trimmed', () => {
		assert.deepStrictEqual(validateSqlText('  SELECT A FROM Sheet1  '), { ok: true, sql: 'SELECT A FROM Sheet1' });
	});

	test('empty / whitespace is a loud error', () => {
		assert.strictEqual(validateSqlText('').ok, false);
		assert.strictEqual(validateSqlText('   \n\t ').ok, false);
	});
});

suite('Wave E sqlPanelCore -- buildAvailableTables', () => {
	test('lists every sheet then every defined table', () => {
		const got = buildAvailableTables({
			sheets: [{ id: 0, name: 'Sheet1' }, { id: 1, name: 'Data' }],
			tables: [{ displayName: 'Sales', sheet: 1 }],
		});
		assert.deepStrictEqual(got, [
			{ name: 'Sheet1', kind: 'sheet', sheet: 0 },
			{ name: 'Data', kind: 'sheet', sheet: 1 },
			{ name: 'Sales', kind: 'table', sheet: 1 },
		]);
	});

	test('empty workbook yields an empty list', () => {
		assert.deepStrictEqual(buildAvailableTables({ sheets: [], tables: [] }), []);
	});
});

suite('Wave E sqlPanelCore -- rectDifference (orphan-cell geometry)', () => {
	test('next fully covers prev -> nothing orphaned', () => {
		assert.deepStrictEqual(rectDifference(rect(0, 0, 5, 5), rect(0, 0, 9, 9)), []);
		assert.deepStrictEqual(rectDifference(rect(2, 2, 4, 4), rect(2, 2, 4, 4)), []); // identical
	});

	test('disjoint -> the whole prev is orphaned', () => {
		assert.deepStrictEqual(rectDifference(rect(0, 0, 2, 2), rect(10, 10, 12, 12)), [rect(0, 0, 2, 2)]);
	});

	test('shrink to the top-left -> bottom band + right band, covering exactly prev - next', () => {
		// prev A1:C10 (rows 0..9, cols 0..2), next A1:B5 (rows 0..4, cols 0..1)
		const diff = rectDifference(rect(0, 0, 9, 2), rect(0, 0, 4, 1));
		// bottom band rows 5..9 cols 0..2 ; right band rows 0..4 col 2
		assert.deepStrictEqual(diff, [rect(5, 0, 9, 2), rect(0, 2, 4, 2)]);
		assertPartitions(rect(0, 0, 9, 2), rect(0, 0, 4, 1), diff);
	});

	test('next strictly inside prev -> four bands with no overlap and full coverage', () => {
		const prev = rect(0, 0, 9, 9);
		const next = rect(3, 3, 6, 6);
		const diff = rectDifference(prev, next);
		assert.strictEqual(diff.length, 4);
		assertPartitions(prev, next, diff);
	});

	test('partial overlap (next shifted down-right) -> covers exactly the uncovered cells', () => {
		const prev = rect(0, 0, 5, 5);
		const next = rect(3, 3, 8, 8);
		assertPartitions(prev, next, rectDifference(prev, next));
	});

	test('fuzz: the partition invariant holds for thousands of random inclusive rects', () => {
		// Deterministic-enough coverage without depending on a seed: many random configs over a small grid,
		// each asserting bands are pairwise-disjoint AND union == exactly prev-next. (Math.random is fine in
		// test code; the no-random rule is for workflow scripts, not mocha.)
		const N = 12;
		const randCoord = (): number => Math.floor(Math.random() * N);
		const randRect = (): RectLite => {
			const a = randCoord();
			const b = randCoord();
			const c = randCoord();
			const d = randCoord();
			return { startRow: Math.min(a, b), endRow: Math.max(a, b), startCol: Math.min(c, d), endCol: Math.max(c, d) };
		};
		for (let i = 0; i < 4000; i++) {
			const prev = randRect();
			const next = randRect();
			assertPartitions(prev, next, rectDifference(prev, next));
		}
	});
});

// Brute-force invariant: the returned bands are pairwise-disjoint AND their union is exactly the cells of
// `prev` not in `next`. This is the property the orphan-clear relies on (clear every orphan, touch nothing
// that the new result will own, never clear a cell twice).
function assertPartitions(prev: RectLite, next: RectLite, diff: RectLite[]): void {
	const seen = new Set<string>();
	for (const r of diff) {
		for (let row = r.startRow; row <= r.endRow; row++) {
			for (let col = r.startCol; col <= r.endCol; col++) {
				const key = `${row},${col}`;
				assert.ok(!seen.has(key), `band overlap at ${key}`);
				seen.add(key);
			}
		}
	}
	const expected = new Set<string>();
	for (let row = prev.startRow; row <= prev.endRow; row++) {
		for (let col = prev.startCol; col <= prev.endCol; col++) {
			const inNext = row >= next.startRow && row <= next.endRow && col >= next.startCol && col <= next.endCol;
			if (!inNext) {
				expected.add(`${row},${col}`);
			}
		}
	}
	assert.deepStrictEqual(seen, expected);
}

suite('Wave E sqlPanelCore -- sqlOrphanClearRanges (sheet-aware)', () => {
	test('first run (prev undefined) -> nothing to clear', () => {
		assert.deepStrictEqual(sqlOrphanClearRanges(undefined, range(0, 0, 0, 9, 2)), []);
	});

	test('same-sheet shrink -> prev - next, every band carrying the sheet id', () => {
		const prev = range(0, 0, 0, 9, 2);
		const next = range(0, 0, 0, 4, 1);
		const got = sqlOrphanClearRanges(prev, next);
		for (const r of got) {
			assert.strictEqual(r.sheet, 0);
		}
		assert.deepStrictEqual(
			got.map(r => ({ startRow: r.startRow, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol })),
			rectDifference(prev, next),
		);
	});

	test('same-sheet next fully covers prev -> nothing to clear', () => {
		assert.deepStrictEqual(sqlOrphanClearRanges(range(0, 2, 2, 4, 4), range(0, 0, 0, 9, 9)), []);
	});

	test('cross-sheet relocation -> clear the WHOLE prior block on its own sheet', () => {
		const prev = range(0, 0, 0, 5, 5);
		const next = range(1, 0, 0, 5, 5);
		assert.deepStrictEqual(sqlOrphanClearRanges(prev, next), [range(0, 0, 0, 5, 5)]);
	});
});

suite('Wave E SqlResultsStore -- record + query', () => {
	test('an empty store reports no ranges and size 0', () => {
		const store = new SqlResultsStore();
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.strictEqual(store.size, 0);
		assert.strictEqual(store.rangeFor('q'), undefined);
	});

	test('a recorded range round-trips in wire shape, named by queryId', () => {
		const store = new SqlResultsStore();
		store.recordPublish('q', range(0, 0, 0, 9, 2));
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 0, endRow: 9, endCol: 2, name: 'q' },
		]);
		assert.deepStrictEqual(store.rangeFor('q'), range(0, 0, 0, 9, 2));
		assert.strictEqual(store.size, 1);
	});

	test('re-running the same queryId relocates the single badge (latest-wins)', () => {
		const store = new SqlResultsStore();
		store.recordPublish('q', range(0, 0, 0, 2, 2));
		store.recordPublish('q', range(0, 5, 5, 6, 6));
		assert.strictEqual(store.size, 1);
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 5, startCol: 5, endRow: 6, endCol: 6, name: 'q' },
		]);
	});

	test('re-running to a different sheet moves the badge off the old sheet', () => {
		const store = new SqlResultsStore();
		store.recordPublish('q', range(0, 0, 0, 2, 2));
		store.recordPublish('q', range(1, 0, 0, 2, 2));
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.strictEqual(store.rangesForSheet(1).length, 1);
	});

	test('remove() drops the query and reports the change; unknown id reports false', () => {
		const store = new SqlResultsStore();
		store.recordPublish('q', range(0, 0, 0));
		assert.strictEqual(store.remove('other'), false);
		assert.strictEqual(store.remove('q'), true);
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.strictEqual(store.rangeFor('q'), undefined);
	});

	test('rangesForSheet filters by sheet; clear() drops everything', () => {
		const store = new SqlResultsStore();
		store.recordPublish('a', range(0, 0, 0));
		store.recordPublish('b', range(1, 0, 0));
		assert.deepStrictEqual(store.rangesForSheet(0).map(r => r.name), ['a']);
		assert.deepStrictEqual(store.rangesForSheet(1).map(r => r.name), ['b']);
		store.clear();
		assert.strictEqual(store.size, 0);
	});

	test('recordPublish + rangeFor store/return COPIES (caller mutation cannot corrupt the store)', () => {
		const store = new SqlResultsStore();
		const r = range(0, 0, 1);
		store.recordPublish('q', r);
		r.startCol = 99;
		r.sheet = 7;
		assert.deepStrictEqual(store.rangesForSheet(0), [{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'q' }]);
		const got = store.rangeFor('q');
		assert.ok(got);
		if (got) {
			got.startCol = 42;
			assert.deepStrictEqual(store.rangeFor('q'), range(0, 0, 1)); // internal still intact
		}
	});
});
