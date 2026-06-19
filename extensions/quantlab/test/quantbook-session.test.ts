/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 6.1B inc.2d (2026-05-28) -- IDE-side Node smoke migration.
 *
 * Drives the engine's new owning `WorkbookSession` (the `Session` napi class)
 * through the REAL IDE load path (`loadQuantbookEngine()` -> `createWorkbookSession()`),
 * proving edit -> recalc -> snapshot in the IDE harness (decision-lock 6.1 item 3 +
 * risk-mit #1: migrate the Node path early to catch missing commands).
 *
 * ALSO carries the two source-only `CollabSession` fixes whose `.node` was never
 * rebuilt until this increment:
 *   - B#1  (ff09a5e17a7): exportSnapshot must hide a tombstoned sheet's cells.
 *   - S2-01 (7e536fc07b2): workbookSnapshotDelta must not leak a changedCells
 *     entry for a sheet tombstoned in a PRIOR delta window (cross-window leak).
 * Both fix commits explicitly deferred their integration test to "the next
 * `.node` rebuild" -- this is it.
 *
 * **Prerequisite**: the engine cdylib must be rebuilt so it carries the `Session`
 * class + the two fixes:
 *   cd <ide-workspace-root>/quantlab-quantbook/quantbook-engine
 *   cargo build -p ql-bindings-node --release --features test-fixtures
 * Skips loudly (once per process) if the binary is absent (mirrors
 * quantbook-roundtrip.test.ts).
 */

import * as assert from 'assert';
import * as fs from 'fs';

import {
	_resetQuantbookEngineCacheForTests,
	loadQuantbookEngine,
	resolveEnginePath,
} from '../src/quantbook/loader';
import {
	addSheet,
	appendPutValueValidated,
	createSession,
	createWorkbookSession,
	deleteSheet,
	exportCellSnapshot,
	getHiddenRowsChecked,
	setRowsHiddenValidated,
} from '../src/quantbook/session';
import type { SessionCellValueInput } from '../src/quantbook/types';

function shouldSkip(): { skip: boolean; reason?: string } {
	const enginePath = resolveEnginePath();
	if (!fs.existsSync(enginePath)) {
		const reason =
			`engine binary not found at ${enginePath} -- build with: ` +
			`cd ../quantlab-quantbook/quantbook-engine && ` +
			`cargo build -p ql-bindings-node --release --features test-fixtures`;
		const seen = global as unknown as { __quantbookSessionSkipLogged?: boolean };
		if (!seen.__quantbookSessionSkipLogged) {
			seen.__quantbookSessionSkipLogged = true;
			console.warn(`[quantbook-session.test] SKIPPING: ${reason}`);
		}
		return { skip: true, reason };
	}
	return { skip: false };
}

suite('quantbook owning Session migration -- Phase 6.1B inc.2d', () => {

	suiteSetup(function () {
		if (shouldSkip().skip) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		// Cold dlopen of the ~8MB cdylib can take 10-30s (symbol resolution +
		// Loro init). Preload here so the first test body doesn't hit the 10s
		// default timeout. (Same amortization the roundtrip suite uses.)
		this.timeout(60000);
		loadQuantbookEngine();
	});

	// ------------------------------------------------------------------------
	// 1. Owning Session -- napi smoke through the IDE loader.
	//    Ports crates/ql-bindings-node/tests/smoke_session.mjs to run through
	//    loadQuantbookEngine()/createWorkbookSession() (the real IDE path).
	// ------------------------------------------------------------------------
	suite('owning Session -- napi smoke through the IDE loader', () => {

		test('loader exposes the Session constructor', () => {
			const engine = loadQuantbookEngine();
			assert.strictEqual(typeof engine.Session, 'function',
				'the loaded module exports the Session class');
		});

		test('edit -> recalc -> snapshot loop (A1=10, B1=A1+1 => 11)', () => {
			const s = createWorkbookSession();

			const sheetId = s.addSheet('Sheet1', 1000);
			assert.strictEqual(typeof sheetId, 'number',
				'addSheet returns a numeric SheetId (NOT void like CollabSession)');

			// A1 = 10 (literal); B1 = A1+1 (formula BODY, no leading "=").
			s.setValue(sheetId, 0, 0, { kind: 'number', number: 10 });
			s.setFormula(sheetId, 0, 1, 'A1+1');
			s.recalcDirty();

			// Single-cell read of the computed value.
			const b1 = s.cell(sheetId, 0, 1);
			assert.ok(b1, 'B1 must exist after setFormula + recalc');
			assert.ok(b1.value, 'B1 carries a computed value');
			assert.strictEqual(b1.value.kind, 'number', 'B1 value kind is number');
			assert.strictEqual(b1.value.number, 11, 'B1 = A1 + 1 = 11');
			// The engine canonicalizes formula text ("A1+1" -> "A1 + 1") and
			// stores it with NO leading "=" -- compare whitespace-insensitively.
			assert.strictEqual(
				(b1.formula ?? '').replace(/\s+/g, ''),
				'A1+1',
				'B1 formula round-trips (canonicalized, no leading "=")',
			);
		});

		test('snapshot agrees with the single-cell read + carries an opaque version', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			s.setValue(sheetId, 0, 0, { kind: 'number', number: 10 });
			s.setFormula(sheetId, 0, 1, 'A1+1');
			s.recalcDirty();

			const snap = s.snapshot();
			assert.strictEqual(snap.sheets.length, 1, 'one sheet in snapshot');
			assert.ok(snap.version && snap.version.length > 0,
				'opaque version token present');
			const sheet = snap.sheets[0];
			assert.strictEqual(sheet.id, sheetId, 'snapshot sheet id matches addSheet');
			const snapB1 = sheet.cells.find(c => c.row === 0 && c.col === 1);
			assert.ok(snapB1 && snapB1.value && snapB1.value.number === 11,
				'snapshot agrees: B1 == 11');
		});

		test('listSheets returns rich {id,name} (NOT bare number[])', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			const sheets = s.listSheets();
			assert.strictEqual(sheets.length, 1, 'one live sheet');
			assert.strictEqual(sheets[0].id, sheetId, 'listSheets id matches');
			assert.strictEqual(sheets[0].name, 'Sheet1', 'listSheets name preserved');
		});

		test('clear is convert-to-literal: drops formula, preserves value', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			s.setValue(sheetId, 0, 0, { kind: 'number', number: 10 });
			s.setFormula(sheetId, 0, 1, 'A1+1');
			s.recalcDirty();

			s.clear(sheetId, 0, 1);
			const cleared = s.cell(sheetId, 0, 1);
			assert.ok(cleared, 'B1 still present (value preserved)');
			assert.ok(cleared.value && cleared.value.number === 11,
				'clear preserves the last computed value');
			assert.ok(!cleared.formula, 'clear removes the formula (convert-to-literal)');
		});

		test('setValue({kind:"blank"}) clears the value', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			s.setValue(sheetId, 0, 0, { kind: 'number', number: 10 });
			s.setValue(sheetId, 0, 0, { kind: 'blank' });
			const blanked = s.cell(sheetId, 0, 0);
			assert.ok(!blanked || !blanked.value, 'setValue(blank) clears the value');
		});

		test('unknown value kind is rejected fail-loud ([bad_argument])', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			assert.throws(
				() => s.setValue(sheetId, 0, 2, { kind: 'bogus' } as unknown as SessionCellValueInput),
				/\[bad_argument\]/,
				'unknown value kind surfaces a structured [bad_argument] error',
			);
		});
	});

	// ------------------------------------------------------------------------
	// Wave G3a / R4 (2026-06-19) -- per-sheet ROW VISIBILITY through the real
	// dylib: setRowsHidden/getHiddenRows round-trip, SUBTOTAL(101-111) skip,
	// undo, and the IDE-side validators' [bad_argument] discipline. This also
	// proves the loaded .node carries the Wave G2 methods (the loader presence
	// check requires them, so createWorkbookSession would have thrown otherwise).
	// ------------------------------------------------------------------------
	suite('owning Session -- Wave G3a row visibility (set/get/SUBTOTAL/undo)', () => {

		test('setRowsHidden -> getHiddenRows round-trip (sorted; unhide subset; unhide all)', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			// Hide rows 4 then 2 (out of order) -- getHiddenRows returns them ASCENDING.
			setRowsHiddenValidated(s, sheetId, [4, 2], true);
			assert.deepStrictEqual(getHiddenRowsChecked(s, sheetId), [2, 4], 'hidden set is sorted ascending');
			// Unhide just row 2 -> [4] remains.
			setRowsHiddenValidated(s, sheetId, [2], false);
			assert.deepStrictEqual(getHiddenRowsChecked(s, sheetId), [4], 'unhiding a subset leaves the rest hidden');
			// Unhide all currently-hidden rows -> [].
			setRowsHiddenValidated(s, sheetId, getHiddenRowsChecked(s, sheetId), false);
			assert.deepStrictEqual(getHiddenRowsChecked(s, sheetId), [], 'unhide-all clears the set');
		});

		test('SUBTOTAL(109) SKIPS a hidden row; SUBTOTAL(9) ignores visibility', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			// A1..A5 = 1..5 (rows 0..4).
			for (let r = 0; r < 5; r += 1) {
				s.setValue(sheetId, r, 0, { kind: 'number', number: r + 1 });
			}
			s.setFormula(sheetId, 0, 1, 'SUBTOTAL(109,A1:A5)'); // B1: skip-hidden SUM
			s.setFormula(sheetId, 1, 1, 'SUBTOTAL(9,A1:A5)');   // B2: plain SUM (visibility-agnostic)
			s.recalcDirty();
			assert.strictEqual(s.cell(sheetId, 0, 1)?.value?.number, 15, 'B1 = 1+2+3+4+5 = 15 with nothing hidden');

			// Hide row 2 (A3 = 3), recompute (the host calls recalcDirty after setRowsHidden).
			setRowsHiddenValidated(s, sheetId, [2], true);
			s.recalcDirty();
			assert.strictEqual(s.cell(sheetId, 0, 1)?.value?.number, 12, 'SUBTOTAL(109) skips the hidden A3 -> 1+2+4+5 = 12');
			assert.strictEqual(s.cell(sheetId, 1, 1)?.value?.number, 15, 'SUBTOTAL(9) ignores visibility -> still 15');
		});

		test('hide is undoable (one Op::SetRowsHidden = one undo step)', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			setRowsHiddenValidated(s, sheetId, [1, 3], true);
			assert.deepStrictEqual(getHiddenRowsChecked(s, sheetId), [1, 3], 'rows hidden');
			assert.strictEqual(s.canUndo(), true, 'the hide is on the undo stack');
			s.undo(); // returns {consumed, version}, not a bool -- assert the OUTCOME, not the shape.
			assert.deepStrictEqual(getHiddenRowsChecked(s, sheetId), [], 'undo restores full visibility');
		});

		test('validators reject malformed input fail-loud ([bad_argument]) BEFORE the FFI boundary', () => {
			const s = createWorkbookSession();
			const sheetId = s.addSheet('Sheet1', 1000);
			assert.throws(() => setRowsHiddenValidated(s, -1, [0], true), /\[bad_argument\]/, 'negative sheet');
			assert.throws(() => setRowsHiddenValidated(s, 0x1_0000, [0], true), /\[bad_argument\]/, 'sheet over u16');
			assert.throws(() => setRowsHiddenValidated(s, sheetId, [2.5], true), /\[bad_argument\]/, 'fractional row');
			assert.throws(() => setRowsHiddenValidated(s, sheetId, [-1], true), /\[bad_argument\]/, 'negative row');
			assert.throws(
				() => setRowsHiddenValidated(s, sheetId, 5 as unknown as number[], true),
				/\[bad_argument\]/,
				'non-array rows',
			);
			assert.throws(() => getHiddenRowsChecked(s, -1), /\[bad_argument\]/, 'getHiddenRows negative sheet');
		});
	});

	// ------------------------------------------------------------------------
	// 2. CollabSession B#1 -- exportSnapshot must hide a tombstoned sheet's
	//    cells (ff09a5e17a7). Validates the rebuilt .node.
	// ------------------------------------------------------------------------
	suite('CollabSession B#1 -- exportSnapshot hides tombstoned-sheet cells', () => {

		test('local: exportSnapshot of a tombstoned sheet returns no cells', () => {
			const s = createSession(8801n);
			addSheet(s, 'Doomed');           // id 0
			appendPutValueValidated(s, 0, 0, 0, 42);
			appendPutValueValidated(s, 0, 1, 0, 99);
			// Cells are visible BEFORE the delete.
			assert.strictEqual(exportCellSnapshot(s, 0).entries.length, 2,
				'pre-delete: both cells exported');

			deleteSheet(s, 0);
			// B#1: after tombstoning, exportSnapshot hides the sheet's cells
			// (the cache PRESERVES them -- R-V3.6-19 no-prune -- so the
			// visibility consumer must filter; pre-fix this leaked).
			assert.strictEqual(exportCellSnapshot(s, 0).entries.length, 0,
				'B#1: tombstoned sheet exports zero cells');
		});

		test('cross-peer: B exports no cells for a sheet A tombstoned', () => {
			const sessA = createSession(8802n);
			addSheet(sessA, 'S0');           // id 0
			addSheet(sessA, 'S1');           // id 1
			appendPutValueValidated(sessA, 1, 0, 0, 7);  // a cell on sheet 1
			deleteSheet(sessA, 1);

			const sessB = createSession(8803n);
			sessB.mergeBytes(sessA.exportBytes());

			assert.strictEqual(exportCellSnapshot(sessB, 1).entries.length, 0,
				'B#1 cross-peer: B exports zero cells for the tombstoned sheet 1');
		});
	});

	// ------------------------------------------------------------------------
	// 3. CollabSession S2-01 -- workbookSnapshotDelta must not leak a
	//    changedCells entry for a sheet tombstoned in a PRIOR delta window
	//    then written by a later PutValue (7e536fc07b2). The abnormal flow:
	//    appendPutValue on a deleted sheet. Validates the rebuilt .node.
	// ------------------------------------------------------------------------
	suite('CollabSession S2-01 -- workbookSnapshotDelta no prior-window tombstone leak', () => {

		test('local: delta after a prior-window tombstone + later write hides the dead cell', () => {
			const s = createSession(8804n);
			addSheet(s, 'S0');               // id 0
			addSheet(s, 'S1');               // id 1
			appendPutValueValidated(s, 0, 0, 0, 1);  // live cell on sheet 0
			deleteSheet(s, 1);               // tombstone sheet 1 -- PRIOR window

			// Populate the delta cache (workbookSnapshot) AFTER the delete, then
			// capture the current VV as the baseline via the empty-version probe
			// -- the exact two-step the existing delta tests use. The RemoveSheet
			// is now behind the baseline (the PRIOR window).
			s.workbookSnapshot();
			const v0 = s.workbookSnapshotDelta(Buffer.alloc(0)).version;

			// Current window: an ABNORMAL write to the tombstoned sheet 1, plus a
			// legit write to live sheet 0.
			appendPutValueValidated(s, 1, 5, 5, 99);   // abnormal -> dead cell
			appendPutValueValidated(s, 0, 2, 2, 2);    // legit live write

			const delta = s.workbookSnapshotDelta(v0);
			assert.strictEqual(delta.fullRebuildRequired, false,
				'a real delta (not a full rebuild) -- no structural op in this window');
			// S2-01: no changedCells entry for the prior-window-tombstoned sheet 1.
			assert.ok(delta.changedCells.every(c => c.sheet !== 1),
				'S2-01: changedCells does NOT leak the dead sheet-1 cell');
			// Sanity: the legit sheet-0 write IS surfaced.
			assert.ok(
				delta.changedCells.some(c => c.sheet === 0 && c.cell.row === 2 && c.cell.col === 2),
				'the live sheet-0 write surfaces in the delta',
			);
		});

		test('cross-peer: a merge delivering a tombstone + abnormal write full-rebuilds (leak-free end-to-end)', () => {
			// NOTE: this is NOT the S2-01 changedCells-filter regression -- the
			// LOCAL test above is (the filter is only reachable on the delta
			// FAST path). A cross-PEER scenario cannot exercise the filter:
			// `mergeBytes` force-invalidates B's workbook cache (the same
			// contract the existing "pollRemote merge force-clears the cache"
			// test pins), so the next `workbookSnapshotDelta` DETERMINISTICALLY
			// returns fullRebuildRequired=true and never reaches the filter.
			// This test instead pins the end-to-end guarantee: after B merges a
			// tombstone + an abnormal write to the dead sheet, B NEVER surfaces
			// the dead cell -- here via the full-rebuild fallback, whose full
			// snapshot filters tombstoned sheets (B#1).
			const sessA = createSession(8805n);
			addSheet(sessA, 'S0');           // id 0
			addSheet(sessA, 'S1');           // id 1
			appendPutValueValidated(sessA, 0, 0, 0, 1);
			deleteSheet(sessA, 1);

			const sessB = createSession(8806n);
			sessB.mergeBytes(sessA.exportBytes());   // B learns sheet 1 is tombstoned
			sessB.workbookSnapshot();                // populate B's cache
			const vB = sessB.workbookSnapshotDelta(Buffer.alloc(0)).version;

			// A's later ops; B merges them (invalidating B's delta cache):
			appendPutValueValidated(sessA, 1, 5, 5, 99);   // abnormal write to dead sheet
			appendPutValueValidated(sessA, 0, 2, 2, 2);    // legit live write
			sessB.mergeBytes(sessA.exportBytes());

			const deltaB = sessB.workbookSnapshotDelta(vB);
			assert.strictEqual(deltaB.fullRebuildRequired, true,
				'a cross-peer merge invalidates B\'s delta cache -> full-rebuild fallback');
			assert.strictEqual(deltaB.changedCells.length, 0,
				'full-rebuild carries no changedCells (so trivially no dead-cell leak)');
			// The full snapshot B falls back to omits the tombstoned sheet 1
			// entirely -- the dead cell never surfaces end-to-end.
			const snapB = sessB.workbookSnapshot();
			assert.ok(snapB.sheets.every(s => s.id !== 1),
				'B\'s full snapshot omits the tombstoned sheet 1');
		});
	});

	// ------------------------------------------------------------------------
	// Wave C (2026-06-18) -- decimal nudge through the REAL dylib, the IDE host
	// path: `nudgeDecimalsPreview` per cell (read-only) -> registerFormat ->
	// ONE `batch` of setFormat ops. The single batch makes a multi-cell decimal
	// nudge a SINGLE undo unit (the whole point of the preview+batch design over
	// per-cell apply `nudgeDecimals`, which is one Loro commit each).
	// ------------------------------------------------------------------------
	suite('Wave C -- decimal nudge preview + batch (the IDE host path)', () => {

		test('preview is read-only; one undo reverts the whole multi-cell nudge (cell edits are one batch)', () => {
			const s = createWorkbookSession();
			const sheet = s.addSheet('S', 1000);
			s.setValue(sheet, 0, 0, { kind: 'number', number: 1.5 });
			s.setValue(sheet, 1, 0, { kind: 'number', number: 2.5 });
			const fmt = s.registerFormat('0.00');
			s.setFormat(sheet, 0, 0, fmt);
			s.setFormat(sheet, 1, 0, fmt);
			s.recalcDirty();
			assert.strictEqual(s.cell(sheet, 0, 0)!.rendered, '1.50');
			assert.strictEqual(s.cell(sheet, 1, 0)!.rendered, '2.50');

			// PREVIEW each cell (read-only): returns the nudged STRING, mutates nothing.
			const p00 = s.nudgeDecimalsPreview(sheet, 0, 0, 1);
			const p10 = s.nudgeDecimalsPreview(sheet, 1, 0, 1);
			assert.strictEqual(p00, '0.000');
			assert.strictEqual(p10, '0.000');
			// Read-only invariant: the cells are UNCHANGED after previewing.
			assert.strictEqual(s.cell(sheet, 0, 0)!.rendered, '1.50', 'preview did not mutate A1');
			assert.strictEqual(s.cell(sheet, 1, 0)!.rendered, '2.50', 'preview did not mutate A2');

			// APPLY exactly as the IDE host does: register the (deduped) string once + ONE batch.
			const nudgedFmt = s.registerFormat(p00!);
			s.batch(
				[
					{ kind: 'setFormat', sheet, row: 0, col: 0, format: nudgedFmt },
					{ kind: 'setFormat', sheet, row: 1, col: 0, format: nudgedFmt },
				],
				{ undoLabel: 'Increase decimals' },
			);
			s.recalcDirty();
			assert.strictEqual(s.cell(sheet, 0, 0)!.rendered, '1.500');
			assert.strictEqual(s.cell(sheet, 1, 0)!.rendered, '2.500');

			// THE HEADLINE: ONE undo reverts BOTH cells' visible change (the cell edits are one batch
			// commit). (A first-seen custom-format registration is a separate, invisible trailing undo
			// step -- inherited from the number-format presets -- but it reverts nothing visible, so the
			// user's single Ctrl+Z fully undoes the nudge.)
			const r = s.undo();
			assert.ok(r.consumed, 'undo consumed the nudge batch');
			s.recalcDirty();
			assert.strictEqual(s.cell(sheet, 0, 0)!.rendered, '1.50', 'one undo reverts A1');
			assert.strictEqual(s.cell(sheet, 1, 0)!.rendered, '2.50', 'one undo reverts A2');
		});

		test('preview no-op returns null (decrease already at zero decimals)', () => {
			const s = createWorkbookSession();
			const sheet = s.addSheet('S', 1000);
			s.setValue(sheet, 0, 0, { kind: 'number', number: 3 });
			const zero = s.registerFormat('0');
			s.setFormat(sheet, 0, 0, zero);
			s.recalcDirty();
			// Decrease past zero decimals ⇒ no-op ⇒ null (the host skips the cell, no op emitted).
			assert.strictEqual(s.nudgeDecimalsPreview(sheet, 0, 0, -1), null);
			// Increasing it DOES nudge ⇒ "0.0".
			assert.strictEqual(s.nudgeDecimalsPreview(sheet, 0, 0, 1), '0.0');
		});

		test('preview on an unmodellable [Red] format throws -- the trigger for the two-phase host', () => {
			// Codex audit MED: the host (applyToolbarDecimalNudge) previews ALL cells BEFORE registering any
			// format, so this throw aborts phase 1 having registered nothing (no partial side effect). Here we
			// pin the engine-level trigger: a [Red] color-coded format the engine cannot model surfaces a loud
			// error from nudgeDecimalsPreview (No-Fallbacks -- never silently mangled). registerFormat stores
			// the string (grammar is parsed at nudge/render time, not at intern time), so the setup is real.
			const s = createWorkbookSession();
			const sheet = s.addSheet('S', 1000);
			s.setValue(sheet, 0, 0, { kind: 'number', number: 1 });
			const red = s.registerFormat('[Red]0.00');
			s.setFormat(sheet, 0, 0, red);
			s.recalcDirty();
			assert.throws(() => s.nudgeDecimalsPreview(sheet, 0, 0, 1), /invalid_format|format/i);
		});
	});
});
