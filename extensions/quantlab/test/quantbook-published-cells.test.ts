/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G / TE1 -- unit tests for the vscode-free core of the bound-cell indicator:
// PublishedCellsStore. Since TE1 (var<->cell moat, 2026-06-27) the store is a DERIVED MIRROR of the
// engine's binding registry (`session.bindings()`): the ReactiveKernelClient rebuilds it at each op
// boundary via `syncFromBindings`. A CellGridPanel reads `rangesForSheet` (alive only) for badges; the
// MCP `get_published_variables` tool reads `allRangesWithSheet` (the complete set, incl. dead bindings
// surfaced as `#REF!`). The projection logic (alive filtering, per-sheet filtering, the repaint-change
// signal, the MCP complete-set view) lives HERE and is tested directly. Runs in the normal mocha suite
// (no ipykernel / no vscode / no napi).

import * as assert from 'assert';

import type { BindingInfoJson, CellRangeJson } from '../src/quantbook/types';
import { PublishedCellsStore } from '../src/quantbook/reactiveKernel/publishedCellsStore';

function range(sheet: number, startRow: number, startCol: number, endRow = startRow, endCol = startCol): CellRangeJson {
	return { sheet, startRow, startCol, endRow, endCol };
}

/** Build an engine binding record in the shape `session.bindings()` returns (bindingId == var name). */
function binding(id: string, target: CellRangeJson, alive = true): BindingInfoJson {
	return { bindingId: id, target, direction: 'forward', sourceId: id, generation: 0n, alive, forceCheck: false };
}

suite('W-G/TE1 publishedCellsStore -- mirror + query', () => {
	test('an empty store reports no ranges and size 0', () => {
		const store = new PublishedCellsStore();
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.deepStrictEqual(store.allRangesWithSheet(), []);
		assert.strictEqual(store.size, 0);
	});

	test('a synced single-cell binding round-trips in wire shape', () => {
		const store = new PublishedCellsStore();
		const changed = store.syncFromBindings([binding('x', range(0, 0, 1))]); // S0!B1
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' },
		]);
		assert.deepStrictEqual(store.allRangesWithSheet(), [
			{ sheet: 0, range: { startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' }, alive: true },
		]);
		assert.strictEqual(store.size, 1);
	});

	test('a multi-cell range round-trips inclusively', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('df', range(2, 0, 0, 9, 2))]);
		assert.deepStrictEqual(store.rangesForSheet(2), [
			{ startRow: 0, startCol: 0, endRow: 9, endCol: 2, name: 'df' },
		]);
	});

	test('multiple variables on one sheet are all returned', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('a', range(0, 0, 0)), binding('b', range(0, 5, 5))]);
		const got = store.rangesForSheet(0);
		assert.strictEqual(got.length, 2);
		assert.deepStrictEqual(new Set(got.map(r => r.name)), new Set(['a', 'b']));
		assert.strictEqual(store.size, 2);
	});

	test('syncFromBindings throws LOUD on a duplicate bindingId (engine uniqueness invariant)', () => {
		const store = new PublishedCellsStore();
		// session.bindings() is unique by construction (HashMap keyed by id); a duplicate signals an engine
		// bug and must fail visibly, never silently shrink the mirror via last-write-wins (No-Fallbacks).
		assert.throws(
			() => store.syncFromBindings([binding('x', range(0, 0, 1)), binding('x', range(0, 0, 2))]),
			/duplicate bindingId/,
		);
	});
});

suite('W-G/TE1 publishedCellsStore -- wholesale rebuild (latest-wins via the engine)', () => {
	test('re-syncing a name to a new cell relocates the badge (old cell clears)', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1))]); // B1
		const changed = store.syncFromBindings([binding('x', range(0, 0, 2))]); // C1
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 2, endRow: 0, endCol: 2, name: 'x' },
		]);
		assert.strictEqual(store.size, 1); // still one variable, not two
	});

	test('re-syncing a name to a different sheet moves it off the old sheet', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1))]); // S0
		store.syncFromBindings([binding('x', range(1, 0, 1))]); // S1
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.deepStrictEqual(store.rangesForSheet(1), [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' },
		]);
	});

	test('a name dropped from session.bindings() (unbind) clears its badge', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1))]);
		const changed = store.syncFromBindings([]); // engine unbound x
		assert.strictEqual(changed, true);
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.deepStrictEqual(store.allRangesWithSheet(), []);
		assert.strictEqual(store.size, 0);
	});
});

suite('W-G/TE1 publishedCellsStore -- dead (structurally-invalidated) bindings', () => {
	test('a dead binding is suppressed from the badge but kept for the MCP complete set', () => {
		const store = new PublishedCellsStore();
		const changed = store.syncFromBindings([binding('x', range(0, 0, 1), /*alive*/ false)]);
		// Never alive in this store, so the badge-visible signature did not change.
		assert.strictEqual(changed, false);
		assert.deepStrictEqual(store.rangesForSheet(0), [], 'badge suppresses a dead binding');
		assert.deepStrictEqual(store.allRangesWithSheet(), [
			{ sheet: 0, range: { startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' }, alive: false },
		], 'MCP still surfaces it (flagged alive:false), never silently omitted');
		assert.strictEqual(store.size, 1);
	});

	test('a structural edit (alive -> dead) clears the badge and reports the change', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1), true)]);
		assert.strictEqual(store.rangesForSheet(0).length, 1);
		const changed = store.syncFromBindings([binding('x', range(0, 0, 1), false)]);
		assert.strictEqual(changed, true, 'a binding going dead is a badge change (must repaint)');
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		// Still present for MCP (the var is published but its cells were disturbed).
		assert.strictEqual(store.allRangesWithSheet().length, 1);
	});
});

suite('W-G/TE1 publishedCellsStore -- repaint-change signal', () => {
	test('an identical resync reports no change (drives no repaint)', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1)), binding('y', range(1, 2, 3))]);
		const changed = store.syncFromBindings([binding('y', range(1, 2, 3)), binding('x', range(0, 0, 1))]);
		assert.strictEqual(changed, false, 'same alive set in a different order is not a change');
	});

	test('adding an alive binding reports a change', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1))]);
		const changed = store.syncFromBindings([binding('x', range(0, 0, 1)), binding('y', range(0, 0, 2))]);
		assert.strictEqual(changed, true);
	});

	test('a value-only republish to the same range reports no badge change', () => {
		// The cell DATA changed (the client repaints on republishCount), but the badge geometry did not,
		// so the store's badge-change signal is false -- it must not be the thing that forces the repaint.
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('x', range(0, 0, 1))]);
		const changed = store.syncFromBindings([binding('x', range(0, 0, 1))]);
		assert.strictEqual(changed, false);
	});
});

suite('W-G/TE1 publishedCellsStore -- per-sheet filtering + isolation', () => {
	test('rangesForSheet returns only the requested sheet (alive)', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('a', range(0, 0, 0)), binding('b', range(1, 0, 0))]);
		assert.deepStrictEqual(store.rangesForSheet(0).map(r => r.name), ['a']);
		assert.deepStrictEqual(store.rangesForSheet(1).map(r => r.name), ['b']);
		assert.deepStrictEqual(store.rangesForSheet(2), []);
	});

	test('clear() drops everything', () => {
		const store = new PublishedCellsStore();
		store.syncFromBindings([binding('a', range(0, 0, 0)), binding('b', range(1, 0, 0))]);
		store.clear();
		assert.strictEqual(store.size, 0);
		assert.deepStrictEqual(store.rangesForSheet(0), []);
		assert.deepStrictEqual(store.rangesForSheet(1), []);
	});

	test('syncFromBindings stores a copy -- mutating the source binding target does not corrupt the store', () => {
		const store = new PublishedCellsStore();
		const t = range(0, 0, 1);
		const b = binding('x', t);
		store.syncFromBindings([b]);
		// Mutate both the shared target object and the binding record after the sync.
		t.startCol = 99;
		t.sheet = 7;
		b.target.endRow = 42;
		assert.deepStrictEqual(store.rangesForSheet(0), [
			{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' },
		]);
		assert.deepStrictEqual(store.rangesForSheet(7), []);
	});
});
