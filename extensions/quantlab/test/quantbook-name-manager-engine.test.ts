/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-5 W-N (2026-06-12) -- ENGINE-BACKED tests for the Name Manager surface against the REAL owning
 * `WorkbookSession` on the schema-2 dylib (the `listNames` / `deleteName` napi reads land ONLY here).
 *
 * Proves the contract the Name-Manager UI relies on:
 *  1. `setName` -> `listNames()` reports the new name (sheet-qualified Range target, canonical-cased name).
 *  2. **The token-invisible refresh contract**: after `setName`, a `snapshotDelta(token)` is EMPTY with an
 *     UNCHANGED token -- so the ONLY way to see the new name is `listNames()` / a full `snapshot()`. This is
 *     the load-bearing reason the manager re-reads explicitly and never waits on a delta.
 *  3. `snapshot().names` agrees with `listNames()` (same data, two surfaces) + the schema is 2.
 *  4. `deleteName(name)` removes it; deleting an unknown name FAILS LOUD (`[name_not_found]`), never a no-op.
 *  5. The Go-To anchor resolves from a real Range target (goToAnchor -> the target's top-left cell).
 *
 * **Prerequisite**: the schema-2 engine cdylib (carries `listNames`/`deleteName` + `WorkbookSnapshotJson.names`).
 * Skips loudly (once per process) if the binary is absent (mirrors quantbook-session.test.ts).
 */

import * as assert from 'assert';
import * as fs from 'fs';

import {
	_resetQuantbookEngineCacheForTests,
	loadQuantbookEngine,
	resolveEnginePath,
} from '../src/quantbook/loader';
import { QUANTBOOK_SCHEMA_VERSION, createWorkbookSession, recalcDirtyChecked } from '../src/quantbook/session';
import { goToAnchor } from '../src/quantbook/cellGrid/nameManagerLogic';
import type { CellRangeJson } from '../src/quantbook/types';

function shouldSkip(): boolean {
	const enginePath = resolveEnginePath();
	if (!fs.existsSync(enginePath)) {
		const seen = global as unknown as { __quantbookNameMgrSkipLogged?: boolean };
		if (!seen.__quantbookNameMgrSkipLogged) {
			seen.__quantbookNameMgrSkipLogged = true;
			console.warn(`[quantbook-name-manager-engine.test] SKIPPING: engine binary not found at ${enginePath}`);
		}
		return true;
	}
	return false;
}

// A 0-based inclusive range on sheet `sheetId`.
const range = (sheet: number, startRow: number, startCol: number, endRow: number, endCol: number): CellRangeJson =>
	({ sheet, startRow, startCol, endRow, endCol });

suite('FE-5 W-N -- Name Manager engine contract (schema-2 dylib)', () => {

	suiteSetup(function () {
		if (shouldSkip()) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		this.timeout(60000);
		loadQuantbookEngine();
	});

	test('the IDE schema-version mirror was bumped to 3', () => {
		assert.strictEqual(QUANTBOOK_SCHEMA_VERSION, 3, 'IDE QUANTBOOK_SCHEMA_VERSION must be 3 for the tables-carrying dylib');
	});

	test('setName -> listNames() reports the new Range name (canonical-cased)', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('Returns', 1000);
		s.setName('returns', range(sheetId, 1, 1, 12, 1)); // B2:B13
		const names = s.listNames();
		assert.strictEqual(names.length, 1, 'exactly one defined name after setName');
		const nr = names[0];
		// The engine canonicalizes (upper-cases) the stored name.
		assert.strictEqual(nr.name.toUpperCase(), 'RETURNS', 'the name round-trips (canonical-cased)');
		assert.strictEqual(nr.target.kind, 'range', 'a setName target is a Range');
		assert.ok(nr.target.range, 'the range payload is present');
		assert.strictEqual(nr.target.range!.sheet, sheetId);
		assert.strictEqual(nr.target.range!.startRow, 1);
		assert.strictEqual(nr.target.range!.startCol, 1);
		assert.strictEqual(nr.target.range!.endRow, 12);
		assert.strictEqual(nr.target.range!.endCol, 1);
		assert.strictEqual(nr.scope, undefined, 'setName creates a workbook-scoped name (scope absent)');
	});

	test('TOKEN-INVISIBLE REFRESH CONTRACT: setName is delta-empty + token-unchanged; only listNames() sees it', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('Sheet1', 1000);
		s.setValue(sheetId, 0, 0, { kind: 'number', number: 10 });
		s.recalcDirty();

		// Capture the version token BEFORE defining the name.
		const before = s.snapshot();
		assert.ok(before.version && before.version.length > 0, 'a version token exists pre-define');
		assert.strictEqual((before.names ?? []).length, 0, 'no names before setName');
		const tokenBefore = before.version!;

		// Define a name. Per the engine contract this advances NOTHING delta-visible.
		s.setName('myrange', range(sheetId, 0, 0, 0, 0));

		// A delta against the pre-define token must be EMPTY (no changed/removed cells, no rebuild required).
		const delta = s.snapshotDelta(tokenBefore);
		assert.strictEqual((delta.changedCells ?? []).length, 0, 'the snapshotDelta carries NO changed cells for a name define');
		assert.strictEqual((delta.removedCells ?? []).length, 0, 'the snapshotDelta carries NO removed cells for a name define');
		assert.notStrictEqual(delta.fullRebuildRequired, true, 'a name define does not force a full rebuild');

		// The ONLY surfaces that see the new name are listNames() + a fresh full snapshot().
		const listed = s.listNames();
		assert.strictEqual(listed.length, 1, 'listNames() sees the new name (the refresh path the manager uses)');
		assert.strictEqual(listed[0].name.toUpperCase(), 'MYRANGE');
		const after = s.snapshot();
		assert.strictEqual((after.names ?? []).length, 1, 'a full snapshot().names also sees the new name');
	});

	test('snapshot().names agrees with listNames() and the schema is 2', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		s.setName('alpha', range(sheetId, 0, 0, 2, 0));
		s.setName('beta', range(sheetId, 0, 1, 0, 1));

		const snap = s.snapshot();
		assert.strictEqual(snap.schemaVersion, 3, 'a real napi snapshot stamps schemaVersion 3');
		const fromSnap = (snap.names ?? []).map((n) => n.name.toUpperCase()).sort();
		const fromList = s.listNames().map((n) => n.name.toUpperCase()).sort();
		assert.deepStrictEqual(fromSnap, fromList, 'snapshot().names and listNames() report the SAME names');
		assert.deepStrictEqual(fromList, ['ALPHA', 'BETA'], 'both names present');
	});

	test('deleteName removes the name; listNames() reflects it (refresh-after-delete)', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		s.setName('keep', range(sheetId, 0, 0, 0, 0));
		s.setName('drop', range(sheetId, 1, 0, 1, 0));
		assert.strictEqual(s.listNames().length, 2, 'two names defined');

		s.deleteName('drop'); // workbook-scoped -> scope undefined
		const remaining = s.listNames().map((n) => n.name.toUpperCase());
		assert.deepStrictEqual(remaining, ['KEEP'], 'only the un-deleted name remains');
	});

	test('deleteName on an unknown name FAILS LOUD (name_not_found) -- never a silent no-op', () => {
		const s = createWorkbookSession();
		s.addSheet('S', 1000);
		// The engine throws a structured error: the human `.message` is "defined name ... not found", and
		// the contract-stable `.code` is "name_not_found" (NotFound class). Assert on the structured code.
		assert.throws(
			() => s.deleteName('does_not_exist'),
			(err: unknown) => err instanceof Error && (err as { code?: string }).code === 'name_not_found',
			'deleting an unknown name must throw a name_not_found-coded error',
		);
	});

	test('Go-To anchor resolves from a real listNames() Range target -> its top-left cell', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('Returns', 1000);
		s.setName('block', range(sheetId, 3, 2, 9, 5)); // C4:F10
		const nr = s.listNames()[0];
		const anchor = goToAnchor(nr.target);
		assert.ok(anchor, 'a range name has a Go-To anchor');
		assert.deepStrictEqual(anchor, { sheet: sheetId, row: 3, col: 2 }, 'anchor is the top-left (C4) corner');
	});

	// **CLOSURE F1 (2026-06-12) -- ENGINE GROUND TRUTH for recalc-after-name-delete, PINNED.**
	// The F1 fix adds `recalcDirtyChecked` + `refreshSession` after a name delete/rename/table-create so the
	// panel reseeds from a fresh snapshot (mirroring the dropTable path). This test PINS what the engine
	// actually does so the IDE behaviour and the tracked engine follow-up are both anchored to reality:
	//
	//  - A formula's NAME reference is bound + resolved at `setFormula` time and the resolved value is cached.
	//  - `deleteName` does NOT dirty the dependent: a `recalcDirty()` (and even `recalcAll()`) leaves the
	//    dependent at its pre-delete value -- the engine does NOT re-bind a deleted name to #NAME?. So the
	//    recalc the command now runs is correct + harmless but, on THIS engine, does NOT change the dependent
	//    (the stale-name-binding is an ENGINE limitation tracked for the conductor; the IDE cannot heal it).
	//  - A formula over a name that does NOT resolve is REJECTED at `setFormula` time (`formula_bind`), so a
	//    "#NAME? until a name/table is created" state is UNREACHABLE via the IDE write path.
	//
	// The test asserts the pinned (stale) behaviour, NOT a fictional #NAME?, so it stays green + documents the
	// limitation; if a future engine starts re-binding on name delete, this test fails LOUD and is updated.
	test('ENGINE GROUND TRUTH: a name-bound formula is resolved-at-write + NOT re-bound by deleteName+recalc', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('Sales', 1000);
		// B2:B4 = 10, 20, 30; D1 = SUM(SALES).
		s.setValue(sheetId, 1, 1, { kind: 'number', number: 10 });
		s.setValue(sheetId, 2, 1, { kind: 'number', number: 20 });
		s.setValue(sheetId, 3, 1, { kind: 'number', number: 30 });
		s.setName('SALES', range(sheetId, 1, 1, 3, 1)); // B2:B4
		s.setFormula(sheetId, 0, 3, 'SUM(SALES)'); // D1
		recalcDirtyChecked(s);

		// Helper: read cell (row,col) of `sheetId` from a fresh full snapshot.
		const cellAt = (row: number, col: number) => {
			const sheet = s.snapshot().sheets.find((sh) => sh.id === sheetId);
			assert.ok(sheet, 'the sheet is present in the snapshot');
			return sheet!.cells.find((c) => c.row === row && c.col === col);
		};

		// D1 evaluated to the sum of the named range.
		const d1Before = cellAt(0, 3);
		assert.ok(d1Before?.value, 'D1 has a value after the initial recalc');
		assert.strictEqual(d1Before!.value!.kind, 'number', 'D1 = SUM(SALES) is a number');
		assert.strictEqual(d1Before!.value!.number, 60, 'D1 = 10+20+30 = 60');

		// Delete the name, then recalc -- exactly what the Name-Manager delete command now does. The engine
		// does NOT re-bind the deleted name, so D1 keeps its cached 60 (the pinned engine limitation).
		s.deleteName('SALES'); // workbook-scoped
		recalcDirtyChecked(s);
		const d1After = cellAt(0, 3);
		assert.strictEqual(d1After!.value!.kind, 'number', 'the engine does NOT turn D1 into #NAME? on name delete');
		assert.strictEqual(d1After!.value!.number, 60, 'D1 stays at its resolved-at-write value (engine stale-name-binding)');
	});

	// **CLOSURE F1 companion -- a formula over an UNRESOLVED name is rejected at WRITE time.** This is why the
	// "create a table/name to heal a #NAME? formula" scenario cannot arise through the IDE: you cannot store
	// such a formula in the first place (the engine binds eagerly + throws `formula_bind`).
	test('ENGINE GROUND TRUTH: setFormula over an undefined name throws formula_bind (no stored #NAME?)', () => {
		const s = createWorkbookSession();
		const sheetId = s.addSheet('S', 1000);
		assert.throws(
			() => s.setFormula(sheetId, 0, 3, 'SUM(NOT_A_NAME)'),
			(err: unknown) => err instanceof Error && (err as { code?: string }).code === 'formula_bind',
			'a formula referencing an undefined name is rejected at setFormula time (formula_bind)',
		);
	});
});
