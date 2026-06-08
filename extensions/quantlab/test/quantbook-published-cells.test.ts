/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G -- unit tests for the vscode-free core of the bound-cell indicator: PublishedCellsStore.
// The ReactiveKernelClient owns one of these and records/retracts publishes at its protocol seams; a
// CellGridPanel reads rangesForSheet to forward badges to its webview. The logic that decides which
// cells are bound (latest-wins by name, stale removal, per-sheet filtering) lives HERE and is tested
// directly. Runs in the normal mocha suite (no ipykernel / no vscode).

import * as assert from 'assert';

import type { CellRangeJson } from '../src/quantbook/types';
import { PublishedCellsStore } from '../src/quantbook/reactiveKernel/publishedCellsStore';

function range(sheet: number, startRow: number, startCol: number, endRow = startRow, endCol = startCol): CellRangeJson {
	return { sheet, startRow, startCol, endRow, endCol };
}

suite('W-G publishedCellsStore -- record + query', () => {
	test('an empty store reports no ranges and size 0', () => {
		const store = new PublishedCellsStore();
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.strictEqual(store.size, 0);
	});

	test('a recorded single-cell publish round-trips in wire shape', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('x', range(0, 0, 1)); // S0!B1
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' },
		]);
		assert.strictEqual(store.size, 1);
	});

	test('a multi-cell range round-trips inclusively', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('df', range(2, 0, 0, 9, 2));
		assert.deepStrictEqual(store.rangesForSheet(2), [
			{ startRow: 0, startCol: 0, endRow: 9, endCol: 2, name: 'df' },
		]);
	});

	test('multiple variables on one sheet are all returned', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('a', range(0, 0, 0));
		store.recordPublish('b', range(0, 5, 5));
		const got = store.rangesForSheet(0);
		assert.strictEqual(got.length, 2);
		assert.deepStrictEqual(new Set(got.map(r => r.name)), new Set(['a', 'b']));
		assert.strictEqual(store.size, 2);
	});
});

suite('W-G publishedCellsStore -- latest-wins relocation', () => {
	test('re-publishing a name to a new cell relocates the badge (old cell clears)', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('x', range(0, 0, 1)); // B1
		store.recordPublish('x', range(0, 0, 2)); // C1
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 2, endRow: 0, endCol: 2, name: 'x' },
		]);
		assert.strictEqual(store.size, 1); // still one variable, not two
	});

	test('re-publishing a name to a different sheet moves it off the old sheet', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('x', range(0, 0, 1)); // S0
		store.recordPublish('x', range(1, 0, 1)); // S1
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.deepStrictEqual(store.rangesForSheet(1), [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' },
		]);
	});
});

suite('W-G publishedCellsStore -- stale retraction', () => {
	test('markStale removes the variable and reports the change', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('x', range(0, 0, 1));
		assert.strictEqual(store.markStale('x'), true);
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.strictEqual(store.size, 0);
	});

	test('markStale of an untracked variable reports no change (drives no repaint)', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('x', range(0, 0, 1));
		assert.strictEqual(store.markStale('y'), false);
		assert.strictEqual(store.rangesForSheet(0).length, 1); // x untouched
	});
});

suite('W-G publishedCellsStore -- per-sheet filtering + isolation', () => {
	test('rangesForSheet returns only the requested sheet', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('a', range(0, 0, 0));
		store.recordPublish('b', range(1, 0, 0));
		assert.deepStrictEqual(store.rangesForSheet(0).map(r => r.name), ['a']);
		assert.deepStrictEqual(store.rangesForSheet(1).map(r => r.name), ['b']);
		assert.deepStrictEqual(store.rangesForSheet(2), []);
	});

	test('clear() drops everything', () => {
		const store = new PublishedCellsStore();
		store.recordPublish('a', range(0, 0, 0));
		store.recordPublish('b', range(1, 0, 0));
		store.clear();
		assert.strictEqual(store.size, 0);
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.deepStrictEqual(store.rangesForSheet(1), []);
	});

	test('recordPublish stores a copy -- mutating the caller range does not corrupt the store', () => {
		const store = new PublishedCellsStore();
		const r = range(0, 0, 1);
		store.recordPublish('x', r);
		r.startCol = 99;
		r.sheet = 7;
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' },
		]);
		assert.deepStrictEqual(store.rangesForSheet(7), []);
	});
});
