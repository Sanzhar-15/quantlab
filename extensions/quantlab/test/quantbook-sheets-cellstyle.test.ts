/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-5 W-R (2026-06-12) -- engine-backed cell-style RENDER.**
 *
 * The engine is the SOLE cell-style source: styles register (`registerStyle`) + assign (`setStyle`) on the
 * workbook session and ride the snapshot as a per-cell `styleId` + a workbook-level `styles[]` table; the
 * webview resolves that into the canvas paint shape ({@link ResolvedCellStyle}). The retired session
 * `CellStyleStore` (round 5) + its tests are GONE.
 *
 * These tests pin the correctness-critical PURE logic the engine-backed render depends on:
 *   - `resolveCellStyle` (engine StyleDefJson -> ResolvedCellStyle, incl. per-edge borders);
 *   - `bordersToPaint` (the shared-edge dedup: own-top+left, cede-bottom+right);
 *   - `diffSnapshotsA1` STYLE-AWARENESS (HIGH#1: a style-only change MUST damage its row -- the
 *     silent-render-miss guard);
 *   - the HOST read/write plumbing: `extractSheetSnapshot` projecting styleId + styles[] (incl. keeping a
 *     style-only blank cell), `mergeWorkbookDelta` merging `stylesAdded` (the incremental-edit fix),
 *     `computeStyleTargets` (read-modify-write for a uniform mutation);
 *   - the END-TO-END engine round-trip (D8): apply fill+bold+border via the real engine `setStyle` path ->
 *     `snapshot()` carries the styleId + a matching styles[] entry -> the resolver produces the expected
 *     ResolvedCellStyle INCLUDING the border. (Engine test is skip-guarded on the cdylib.)
 */

import * as assert from 'assert';
import * as fs from 'fs';

import { resolveEnginePath } from '../src/quantbook/loader';
import { createWorkbookSession, recalcDirtyChecked } from '../src/quantbook/session';
import {
	computeStyleTargets,
	currentCellStyle,
	extractSheetSnapshot,
	mergeWorkbookDelta,
	styleJsonKey,
	validateStyleMutation,
	type DeltaSnapshotCache,
	acquireWorkbookSnapshotViaDelta,
} from '../src/quantbook/cellGrid/cellGridLogic';
import type {
	CellSnapshotJson,
	QuantbookCellSnapshot,
	QuantbookCellValue,
	SheetSnapshotJson,
	StyleDefJson,
	StyleIdJson,
	StyleJson,
	TableSnapshotJson,
	WorkbookSnapshotDeltaJson,
	WorkbookSnapshotJson,
} from '../src/quantbook/types';
import {
	bordersToPaint,
	borderWidthPx,
	resolveCellStyle,
	type ResolvedBorders,
} from '../webview/sheets-webview/cellStyleModel';
import { diffSnapshotsA1 } from '../webview/sheets-webview/gridBlitA1';

const styleId = (peer: number, counter: number): StyleIdJson => ({ peer: BigInt(peer), counter });
const def = (peer: number, counter: number, style: StyleDefJson['style']): StyleDefJson => ({ id: styleId(peer, counter), style });
// WIRE form: what `extractSheetSnapshot` PROJECTS toward the webview -- `peer` is downcast bigint->number
// for `postMessage`-safety (`styleIdToWire`; BigInt is not JSON-serializable). Tests asserting the
// PROJECTION OUTPUT compare against these; tests on the engine INPUT / host cache use `styleId`/`def`.
const wireStyleId = (peer: number, counter: number): StyleIdJson => ({ peer: peer as unknown as bigint, counter });
const wireDef = (peer: number, counter: number, style: StyleDefJson['style']): StyleDefJson => ({ id: wireStyleId(peer, counter), style });

// =============================================================================================
// resolveCellStyle -- engine StyleDefJson -> ResolvedCellStyle (the render paint shape)
// =============================================================================================

suite('FE-5 W-R resolveCellStyle -- engine StyleDefJson -> ResolvedCellStyle', function () {
	const styles: StyleDefJson[] = [
		def(1, 0, { bold: true, italic: false, fill: { r: 255, g: 115, b: 49 }, align: 'right' }),
		def(1, 1, {
			bold: false, italic: true,
			borderTop: { style: 'thin', color: { r: 0, g: 0, b: 0 } },
			borderBottom: { style: 'thick', color: { r: 10, g: 20, b: 30 } },
			borderLeft: { style: 'none', color: { r: 0, g: 0, b: 0 } },
		}),
	];

	test('an absent styleId resolves to undefined (no style on the cell)', () => {
		assert.strictEqual(resolveCellStyle(undefined, styles), undefined);
	});

	test('a registered styleId resolves bold/italic/fill/align', () => {
		const r = resolveCellStyle(styleId(1, 0), styles);
		assert.notStrictEqual(r, 'unresolved');
		assert.notStrictEqual(r, undefined);
		const rs = r as Exclude<typeof r, 'unresolved' | undefined>;
		assert.strictEqual(rs.bold, true);
		assert.strictEqual(rs.italic, undefined, 'italic:false must not be stored as a set field');
		assert.strictEqual(rs.fillColor, 'rgb(255,115,49)');
		assert.strictEqual(rs.halign, 'right');
		assert.strictEqual(rs.borders, undefined, 'no border edges -> no borders object');
	});

	test('per-edge borders resolve; a none/absent edge is dropped', () => {
		const r = resolveCellStyle(styleId(1, 1), styles);
		const rs = r as Exclude<typeof r, 'unresolved' | undefined>;
		assert.strictEqual(rs.italic, true);
		assert.ok(rs.borders !== undefined);
		assert.deepStrictEqual(rs.borders?.top, { style: 'thin', color: 'rgb(0,0,0)' });
		assert.deepStrictEqual(rs.borders?.bottom, { style: 'thick', color: 'rgb(10,20,30)' });
		assert.strictEqual(rs.borders?.left, undefined, 'a none edge must not produce a left border');
		assert.strictEqual(rs.borders?.right, undefined, 'an absent edge must not produce a right border');
	});

	test('FE-FONT: underline/strike/textColor populate from a StyleJson that carries them', () => {
		const fontStyles: StyleDefJson[] = [
			def(3, 0, { bold: false, italic: false, underline: true, strike: true, textColor: { r: 12, g: 34, b: 56 } }),
			def(3, 1, { bold: false, italic: false, underline: false, strike: false }),
		];
		const r = resolveCellStyle(styleId(3, 0), fontStyles);
		const rs = r as Exclude<typeof r, 'unresolved' | undefined>;
		assert.strictEqual(rs.underline, true, 'underline resolves');
		assert.strictEqual(rs.strike, true, 'strike resolves');
		assert.strictEqual(rs.textColor, 'rgb(12,34,56)', 'textColor resolves to a CSS color');
		// underline/strike:false must NOT be stored as set fields (mirrors bold/italic:false discipline).
		const off = resolveCellStyle(styleId(3, 1), fontStyles);
		const offs = off as Exclude<typeof off, 'unresolved' | undefined>;
		assert.strictEqual(offs.underline, undefined, 'underline:false is not a set field');
		assert.strictEqual(offs.strike, undefined, 'strike:false is not a set field');
		assert.strictEqual(offs.textColor, undefined, 'absent textColor is not a set field');
	});

	test('FE-FONT: a malformed textColor channel drops the textColor (no silent default), other attrs survive', () => {
		const bad: StyleDefJson[] = [def(4, 0, { bold: true, italic: false, textColor: { r: 999, g: 0, b: 0 } })];
		const r = resolveCellStyle(styleId(4, 0), bad);
		const rs = r as Exclude<typeof r, 'unresolved' | undefined>;
		assert.strictEqual(rs.textColor, undefined, 'a bad-channel textColor is dropped');
		assert.strictEqual(rs.bold, true, 'the rest of the style still resolves');
	});

	test('a styleId present but NOT in styles[] returns the LOUD "unresolved" sentinel (No-Fallbacks)', () => {
		assert.strictEqual(resolveCellStyle(styleId(9, 9), styles), 'unresolved');
	});

	test('a styleId with no styles[] table at all is unresolved (a threading contract miss)', () => {
		assert.strictEqual(resolveCellStyle(styleId(1, 0), undefined), 'unresolved');
	});

	test('a malformed border color (out-of-domain channel) drops that edge, never a silent default color', () => {
		const bad: StyleDefJson[] = [def(2, 0, {
			bold: false, italic: false,
			borderTop: { style: 'thin', color: { r: 300, g: 0, b: 0 } }, // 300 > 255
		})];
		const r = resolveCellStyle(styleId(2, 0), bad);
		const rs = r as Exclude<typeof r, 'unresolved' | undefined>;
		assert.strictEqual(rs.borders, undefined, 'a bad-color edge is dropped, leaving no borders');
	});

	test('borderWidthPx: thin=1, medium=2, thick/double=3, dashed/dotted=1', () => {
		assert.strictEqual(borderWidthPx('thin'), 1);
		assert.strictEqual(borderWidthPx('medium'), 2);
		assert.strictEqual(borderWidthPx('thick'), 3);
		assert.strictEqual(borderWidthPx('double'), 3);
		assert.strictEqual(borderWidthPx('dashed'), 1);
		assert.strictEqual(borderWidthPx('dotted'), 1);
	});
});

// =============================================================================================
// bordersToPaint -- shared-edge dedup (own top+left, cede bottom+right)
// =============================================================================================

suite('FE-5 W-R bordersToPaint -- shared-edge dedup (own top+left, cede bottom+right)', function () {
	const thin = { style: 'thin' as const, color: 'rgb(0,0,0)' };
	const full: ResolvedBorders = { top: thin, bottom: thin, left: thin, right: thin };

	test('a lone cell paints all four of its edges', () => {
		const p = bordersToPaint(full, undefined, undefined);
		assert.deepStrictEqual(p, { top: thin, bottom: thin, left: thin, right: thin });
	});

	test('own top+left always painted', () => {
		const p = bordersToPaint({ top: thin, left: thin }, undefined, undefined);
		assert.deepStrictEqual(p.top, thin);
		assert.deepStrictEqual(p.left, thin);
		assert.strictEqual(p.bottom, undefined);
		assert.strictEqual(p.right, undefined);
	});

	test('a contested bottom seam is CEDED to the cell below (which owns its top)', () => {
		const p = bordersToPaint({ bottom: thin }, { top: thin }, undefined);
		assert.strictEqual(p.bottom, undefined, 'the neighbor below owns the shared seam');
	});

	test('an UNcontested bottom (neighbor below has no top) is painted by self', () => {
		const p = bordersToPaint({ bottom: thin }, { left: thin }, undefined);
		assert.deepStrictEqual(p.bottom, thin, 'only self declares the seam -> self paints it');
	});

	test('a contested right seam is CEDED to the cell to the right (which owns its left)', () => {
		const p = bordersToPaint({ right: thin }, undefined, { left: thin });
		assert.strictEqual(p.right, undefined, 'the neighbor to the right owns the shared seam');
	});

	test('an UNcontested right (neighbor right has no left) is painted by self', () => {
		const p = bordersToPaint({ right: thin }, undefined, { top: thin });
		assert.deepStrictEqual(p.right, thin);
	});

	test('no double-draw: two adjacent cells both fully-bordered -> the shared seam is painted by exactly one', () => {
		const aPaint = bordersToPaint(full, undefined, full); // B is A's right neighbor
		const bPaint = bordersToPaint(full, undefined, undefined); // B has no right neighbor here
		assert.strictEqual(aPaint.right, undefined, 'A cedes the shared seam');
		assert.deepStrictEqual(bPaint.left, thin, 'B owns + paints the shared seam exactly once');
	});
});

// =============================================================================================
// HIGH#1 -- diffSnapshotsA1 is STYLE-AWARE (the silent-render-miss guard)
// =============================================================================================

type Entry = QuantbookCellSnapshot['entries'][number];
const num = (value: number): QuantbookCellValue => ({ kind: 'number', value });
const entryWithStyle = (row: number, col: number, value: QuantbookCellValue, sid?: StyleIdJson): Entry =>
	(sid !== undefined ? { row, col, value, styleId: sid } : { row, col, value });
const snap = (entries: Entry[], sheet = 0): QuantbookCellSnapshot => ({ snapshot_format_version: 1, sheet, entries });

suite('FE-5 W-R HIGH#1 -- diffSnapshotsA1 is STYLE-AWARE (the silent-render-miss guard)', function () {
	test('REGRESSION PROOF: same value + NEW styleId damages the cell\'s row', () => {
		// A cell with text but no style -> the SAME cell with the SAME value but a styleId (e.g. user hit Bold).
		// Value/rendered/formula/diagnostic are all unchanged; ONLY styleId differs.
		const prev = snap([entryWithStyle(3, 2, num(42))]);
		const next = snap([entryWithStyle(3, 2, num(42), styleId(1, 0))]);
		// PRE-FIX BEHAVIOUR (documented): without the styleId term in entryVisualEqual, the two entries were
		// judged "equal" and diffSnapshotsA1 returned [] -> the row never repainted until scroll. POST-FIX:
		assert.deepStrictEqual(diffSnapshotsA1(prev, next), [3], 'a style-only change MUST damage its row');
	});

	test('a styleId REPOINT (one id -> another) damages the row', () => {
		const prev = snap([entryWithStyle(5, 1, num(7), styleId(1, 0))]);
		const next = snap([entryWithStyle(5, 1, num(7), styleId(1, 9))]); // same peer, new counter
		assert.deepStrictEqual(diffSnapshotsA1(prev, next), [5]);
	});

	test('CLEARING a style (styleId present -> absent) damages the row', () => {
		const prev = snap([entryWithStyle(2, 0, num(1), styleId(1, 0))]);
		const next = snap([entryWithStyle(2, 0, num(1))]);
		assert.deepStrictEqual(diffSnapshotsA1(prev, next), [2]);
	});

	test('no style change + no value change -> NO damage (the fast path still elides a true no-op)', () => {
		const prev = snap([entryWithStyle(4, 4, num(9), styleId(1, 0))]);
		const next = snap([entryWithStyle(4, 4, num(9), styleId(1, 0))]);
		assert.deepStrictEqual(diffSnapshotsA1(prev, next), [], 'identical style + value must not over-damage');
	});

	test('BACK-COMPAT: entries with NO styleId on either side behave exactly as before (both undefined -> equal)', () => {
		const prev = snap([entryWithStyle(1, 1, num(3))]);
		const next = snap([entryWithStyle(1, 1, num(3))]);
		assert.deepStrictEqual(diffSnapshotsA1(prev, next), [], 'the styleId term is inert when no styles are threaded');
	});
});

// =============================================================================================
// HOST read path -- extractSheetSnapshot projects styleId + styles[] (incl. style-only blank cells)
// =============================================================================================

function wbCell(row: number, col: number, value: CellSnapshotJson['value'], styleIdOf?: StyleIdJson, formula?: string): CellSnapshotJson {
	const c: CellSnapshotJson = { row, col, value };
	if (styleIdOf !== undefined) { c.styleId = styleIdOf; }
	if (formula !== undefined) { c.formula = formula; }
	return c;
}
function wb(cells: CellSnapshotJson[], styles?: StyleDefJson[]): WorkbookSnapshotJson {
	const sheet: SheetSnapshotJson = { id: 0, name: 'S', cells };
	const out: WorkbookSnapshotJson = { sheets: [sheet], formats: [], dateSystem: 'Excel1900' };
	if (styles !== undefined) { out.styles = styles; }
	return out;
}

suite('FE-5 W-R extractSheetSnapshot -- projects styleId + styles[] (atomically)', function () {
	const styles = [def(0, 0, { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 } })];

	test('a valued+styled cell projects its styleId; the snapshot carries the styles[] table', () => {
		const snapshot = wb([wbCell(0, 0, { kind: 'number', number: 42 }, styleId(0, 0))], styles);
		const out = extractSheetSnapshot(snapshot, 0)!;
		assert.ok(out !== null);
		assert.strictEqual(out.entries.length, 1);
		assert.deepStrictEqual(out.entries[0].styleId, wireStyleId(0, 0));
		assert.deepStrictEqual(out.styles, [wireDef(0, 0, { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 } })], 'the styles table travels WITH the per-cell styleId (atomicity), in wire form');
	});

	test('a STYLE-ONLY blank cell (no value, no formula, has styleId) is KEPT (not dropped) -- fill-on-blank renders', () => {
		// The engine emits such a cell (verified): {row, col, styleId}, value undefined.
		const snapshot = wb([wbCell(5, 5, undefined as unknown as CellSnapshotJson['value'], styleId(0, 0))], styles);
		const out = extractSheetSnapshot(snapshot, 0)!;
		assert.strictEqual(out.entries.length, 1, 'the style-only blank cell must NOT be dropped');
		assert.deepStrictEqual(out.entries[0].styleId, wireStyleId(0, 0));
		assert.strictEqual(out.entries[0].value.kind, 'pending', 'a style-only cell renders as a pending (blank) entry');
	});

	test('a truly-empty cell (no value, no formula, NO styleId) is still dropped (nothing to render)', () => {
		const snapshot = wb([wbCell(7, 7, undefined as unknown as CellSnapshotJson['value'])]);
		const out = extractSheetSnapshot(snapshot, 0)!;
		assert.strictEqual(out.entries.length, 0, 'an empty cell with no style is dropped');
	});

	test('a snapshot with no styles registered omits the styles field + cells carry no styleId (the common case)', () => {
		const snapshot = wb([wbCell(0, 0, { kind: 'number', number: 1 })]);
		const out = extractSheetSnapshot(snapshot, 0)!;
		assert.strictEqual(out.styles, undefined, 'no styles -> no styles field (absent, conditional-key discipline)');
		assert.strictEqual(out.entries[0].styleId, undefined);
	});
});

// =============================================================================================
// Tables wave (2026-06-13) -- extractSheetSnapshot per-sheet TABLE filter (the wrong-sheet-bleed guard)
// =============================================================================================

// A camelCase TableSnapshotJson fixture (the engine's outbound snapshot shape). `sheet` carries the owning
// sheet id; extractSheetSnapshot filters the workbook-level tables[] to the active sheet by `t.sheet === id`.
function mkTable(over: Partial<TableSnapshotJson> = {}): TableSnapshotJson {
	return {
		name: 'Table1',
		displayName: 'Table 1',
		sheet: 0,
		topRow: 0,
		topCol: 0,
		rows: 3,
		cols: 2,
		hasHeader: true,
		hasTotals: false,
		...over,
	};
}
// A workbook with TWO sheets (ids 0 and 1) and a hand-made tables[] list. Both sheets exist in `sheets` so
// extractSheetSnapshot does not tombstone-return null; the tables[] is the workbook-level list it filters.
function wbWithTables(tables: TableSnapshotJson[]): WorkbookSnapshotJson {
	const sheetA: SheetSnapshotJson = { id: 0, name: 'A', cells: [] };
	const sheetB: SheetSnapshotJson = { id: 1, name: 'B', cells: [] };
	return { sheets: [sheetA, sheetB], formats: [], dateSystem: 'Excel1900', tables };
}

suite('Tables wave (2026-06-13) extractSheetSnapshot -- per-sheet table filter (no wrong-sheet bleed)', function () {
	test('two tables on two sheets -> the projection for sheet A carries ONLY sheet A\'s table', () => {
		const tableA = mkTable({ name: 'TblA', displayName: 'Table A', sheet: 0, topRow: 0 });
		const tableB = mkTable({ name: 'TblB', displayName: 'Table B', sheet: 1, topRow: 5 });
		const snapshot = wbWithTables([tableA, tableB]);

		const outA = extractSheetSnapshot(snapshot, 0)!;
		assert.ok(outA !== null, 'sheet 0 exists -> a projection is returned');
		assert.ok(outA.tables !== undefined, 'sheet A has a table -> the tables field is present');
		assert.strictEqual(outA.tables!.length, 1, 'ONLY sheet A\'s table projects (sheet B\'s does not bleed in)');
		assert.strictEqual(outA.tables![0].name, 'TblA');
		assert.strictEqual(outA.tables![0].sheet, 0);

		// And the symmetric case: sheet B carries ONLY sheet B's table.
		const outB = extractSheetSnapshot(snapshot, 1)!;
		assert.strictEqual(outB.tables!.length, 1, 'ONLY sheet B\'s table projects');
		assert.strictEqual(outB.tables![0].name, 'TblB');
		assert.strictEqual(outB.tables![0].sheet, 1);
	});

	test('a sheet with NO tables of its own omits the tables field entirely (conditional-key discipline)', () => {
		// Both tables live on sheet 1; the projection for sheet 0 must have NO tables field (absent, not []).
		const snapshot = wbWithTables([mkTable({ sheet: 1, name: 'OnlyB1' }), mkTable({ sheet: 1, name: 'OnlyB2', topRow: 10 })]);
		const outA = extractSheetSnapshot(snapshot, 0)!;
		assert.strictEqual(outA.tables, undefined, 'a sheet with no tables of its own -> tables field absent (not an empty array)');
	});

	test('a table whose `sheet` is undefined is DROPPED (sawTableMissingSheet path -- safe no-paint, not a wrong-sheet bleed)', () => {
		// A TableSnapshotJson the engine failed to stamp with `sheet`. extractSheetSnapshot cannot attribute it
		// to any sheet, so it is dropped from EVERY sheet's projection (No-Fallbacks: it console.warns rather
		// than guessing a sheet). Build the missing-sheet via a cast (the typed shape requires `sheet`).
		const noSheet = { ...mkTable(), name: 'Orphan' } as TableSnapshotJson;
		delete (noSheet as { sheet?: number }).sheet;
		const snapshot = wbWithTables([noSheet]);

		const outA = extractSheetSnapshot(snapshot, 0)!;
		assert.strictEqual(outA.tables, undefined, 'a table with no `sheet` is not attributed to sheet 0 -> no table projected');
		const outB = extractSheetSnapshot(snapshot, 1)!;
		assert.strictEqual(outB.tables, undefined, 'a table with no `sheet` is not attributed to sheet 1 either (dropped everywhere)');
	});

	test('an orphan (missing-sheet) table does NOT suppress a VALID sibling table on the same sheet', () => {
		// One orphan + one well-formed table on sheet 0: the orphan drops (warn), the valid one still projects.
		const orphan = { ...mkTable({ name: 'Orphan' }) } as TableSnapshotJson;
		delete (orphan as { sheet?: number }).sheet;
		const valid = mkTable({ name: 'Good', sheet: 0, topRow: 4 });
		const snapshot = wbWithTables([orphan, valid]);
		const outA = extractSheetSnapshot(snapshot, 0)!;
		assert.ok(outA.tables !== undefined, 'the valid sibling still projects');
		assert.strictEqual(outA.tables!.length, 1, 'the orphan dropped; the valid table remained');
		assert.strictEqual(outA.tables![0].name, 'Good');
	});
});

// =============================================================================================
// HOST delta path -- mergeWorkbookDelta merges stylesAdded (the incremental-edit correctness fix)
// =============================================================================================

function mkDelta(partial: Partial<WorkbookSnapshotDeltaJson>): WorkbookSnapshotDeltaJson {
	return {
		changedCells: partial.changedCells ?? [],
		removedCells: partial.removedCells ?? [],
		sheetsChanged: partial.sheetsChanged ?? [],
		sheetsRemoved: partial.sheetsRemoved ?? [],
		formatsAdded: partial.formatsAdded ?? [],
		stylesAdded: partial.stylesAdded,
		version: partial.version ?? Buffer.from([0xAB]),
		fullRebuildRequired: partial.fullRebuildRequired ?? false,
	};
}

suite('FE-5 W-R mergeWorkbookDelta -- stylesAdded merges into styles[] (incremental edit)', function () {
	test('stylesAdded seeds the styles[] table when the cached snapshot had none', () => {
		const cached = wb([wbCell(0, 0, { kind: 'number', number: 1 }, styleId(0, 0))]);
		assert.strictEqual(cached.styles, undefined);
		const newStyle = def(0, 0, { bold: true, italic: false });
		const merged = mergeWorkbookDelta(cached, mkDelta({ stylesAdded: [newStyle] }));
		assert.deepStrictEqual(merged.styles, [newStyle], 'the new style is now present so the cell styleId resolves');
	});

	test('a second stylesAdded merges + stays sorted by StyleId (peer asc, counter asc)', () => {
		const cached = wb([wbCell(0, 0, { kind: 'number', number: 1 })], [def(0, 1, { bold: true, italic: false })]);
		const merged = mergeWorkbookDelta(cached, mkDelta({ stylesAdded: [def(0, 0, { bold: false, italic: true })] }));
		assert.deepStrictEqual(merged.styles!.map(s => [Number(s.id.peer), s.id.counter]), [[0, 0], [0, 1]], 'sorted by (peer, counter)');
	});

	test('re-adding an existing StyleId REPLACES it (no duplicate)', () => {
		const cached = wb([], [def(0, 0, { bold: true, italic: false })]);
		const merged = mergeWorkbookDelta(cached, mkDelta({ stylesAdded: [def(0, 0, { bold: false, italic: true, fill: { r: 9, g: 9, b: 9 } })] }));
		assert.strictEqual(merged.styles!.length, 1, 'replaced, not duplicated');
		assert.strictEqual(merged.styles![0].style.fill?.r, 9);
	});

	test('an empty/absent stylesAdded leaves styles[] untouched', () => {
		const existing = [def(0, 0, { bold: true, italic: false })];
		const cached = wb([], existing);
		const merged = mergeWorkbookDelta(cached, mkDelta({}));
		assert.deepStrictEqual(merged.styles, existing);
	});
});

// =============================================================================================
// HOST write path -- computeStyleTargets / currentCellStyle / validateStyleMutation / styleJsonKey
// =============================================================================================

suite('FE-5 W-R computeStyleTargets -- read-modify-write for a uniform mutation', function () {
	const styles = [
		def(0, 0, { bold: true, italic: false, borderTop: { style: 'thin', color: { r: 0, g: 0, b: 0 } } }),
		def(0, 1, { bold: false, italic: false, fill: { r: 5, g: 6, b: 7 } }),
	];
	// A1 styled bold+top-border (id 0,0); B1 styled fill (id 0,1); C1 unstyled.
	const snapshot = wb([
		wbCell(0, 0, { kind: 'number', number: 1 }, styleId(0, 0)),
		wbCell(0, 1, { kind: 'number', number: 2 }, styleId(0, 1)),
		wbCell(0, 2, { kind: 'number', number: 3 }),
	], styles);
	const r1 = { minRow: 0, maxRow: 0, minCol: 0, maxCol: 2 }; // A1:C1

	test('currentCellStyle resolves a styled cell + returns a fresh COPY (no snapshot aliasing)', () => {
		const s = currentCellStyle(snapshot, 0, 0, 0);
		assert.strictEqual(s.bold, true);
		assert.deepStrictEqual(s.borderTop, { style: 'thin', color: { r: 0, g: 0, b: 0 } });
		s.bold = false; // mutate the copy
		assert.strictEqual(snapshot.styles![0].style.bold, true, 'mutating the copy must not touch the snapshot');
	});

	test('currentCellStyle of an unstyled cell is all-default', () => {
		assert.deepStrictEqual(currentCellStyle(snapshot, 0, 0, 2), { bold: false, italic: false });
	});

	test('currentCellStyle THROWS for an unresolvable styleId (No-Fallbacks, never a wrong default base)', () => {
		const broken = wb([wbCell(0, 0, { kind: 'number', number: 1 }, styleId(9, 9))], styles);
		assert.throws(() => currentCellStyle(broken, 0, 0, 0), /\[invalid_state\].*styleId/);
	});

	test('toggle bold over a PARTIALLY-bold selection turns the WHOLE selection bold (Excel semantics), preserving other attrs', () => {
		const targets = computeStyleTargets(snapshot, 0, r1, { kind: 'toggle', prop: 'bold' });
		assert.strictEqual(targets.length, 3);
		assert.ok(targets.every(t => t.style.bold === true), 'partial -> all on');
		// A1 keeps its border; B1 keeps its fill.
		assert.deepStrictEqual(targets[0].style.borderTop, { style: 'thin', color: { r: 0, g: 0, b: 0 } }, 'toggle preserves the border');
		assert.deepStrictEqual(targets[1].style.fill, { r: 5, g: 6, b: 7 }, 'toggle preserves the fill');
	});

	test('toggle bold over a FULLY-bold selection turns it OFF', () => {
		// A range where every cell is already bold (just A1).
		const oneBold = { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 };
		const targets = computeStyleTargets(snapshot, 0, oneBold, { kind: 'toggle', prop: 'bold' });
		assert.strictEqual(targets[0].style.bold, false, 'all-on -> off');
		assert.deepStrictEqual(targets[0].style.borderTop, { style: 'thin', color: { r: 0, g: 0, b: 0 } }, 'still preserves the border');
	});

	test('align set + clear', () => {
		const setC = computeStyleTargets(snapshot, 0, r1, { kind: 'align', value: 'center' });
		assert.ok(setC.every(t => t.style.align === 'center'));
		// Now clear align on a snapshot where A1 has align.
		const withAlign = wb([wbCell(0, 0, { kind: 'number', number: 1 }, styleId(0, 0))],
			[def(0, 0, { bold: false, italic: false, align: 'center' })]);
		const cleared = computeStyleTargets(withAlign, 0, { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 }, { kind: 'align', value: null });
		assert.strictEqual(cleared[0].style.align, undefined, 'align cleared');
	});

	test('fill set + clear', () => {
		const setF = computeStyleTargets(snapshot, 0, r1, { kind: 'fill', value: { r: 100, g: 110, b: 120 } });
		assert.ok(setF.every(t => t.style.fill?.r === 100 && t.style.fill?.g === 110 && t.style.fill?.b === 120));
		// Clear fill on B1 (which had a fill); its other attrs survive.
		const cleared = computeStyleTargets(snapshot, 0, { minRow: 0, maxRow: 0, minCol: 1, maxCol: 1 }, { kind: 'fill', value: null });
		assert.strictEqual(cleared[0].style.fill, undefined, 'fill cleared');
	});

	test('an inverted / over-cap rect THROWS [bad_argument]', () => {
		assert.throws(() => computeStyleTargets(snapshot, 0, { minRow: 5, maxRow: 0, minCol: 0, maxCol: 0 }, { kind: 'toggle', prop: 'bold' }), /\[bad_argument\]/);
		assert.throws(() => computeStyleTargets(snapshot, 0, { minRow: 0, maxRow: 1_048_575, minCol: 0, maxCol: 99 }, { kind: 'toggle', prop: 'bold' }), /exceeds the .* style limit/);
	});
});

// =============================================================================================
// FE-FONT (2026-06-13) -- computeStyleTargets for the NEW mutations: underline/strike toggle,
// textColor set/clear, and the border variants (all / outer / single edge / clear-all).
// =============================================================================================

suite('FE-FONT (2026-06-13) computeStyleTargets -- underline/strike/textColor/border', function () {
	// A1 bold+thin-top-border (0,0); B1 underline (0,1); C1 unstyled.
	const styles = [
		def(0, 0, { bold: true, italic: false, borderTop: { style: 'thin', color: { r: 0, g: 0, b: 0 } } }),
		def(0, 1, { bold: false, italic: false, underline: true }),
	];
	const snapshot = wb([
		wbCell(0, 0, { kind: 'number', number: 1 }, styleId(0, 0)),
		wbCell(0, 1, { kind: 'text', text: 'x' }, styleId(0, 1)),
		wbCell(0, 2, { kind: 'number', number: 3 }),
	], styles);
	const r1 = { minRow: 0, maxRow: 0, minCol: 0, maxCol: 2 }; // A1:C1

	test('underline toggle over a PARTIALLY-underlined selection turns the WHOLE selection underlined', () => {
		const t = computeStyleTargets(snapshot, 0, r1, { kind: 'toggle', prop: 'underline' });
		assert.strictEqual(t.length, 3);
		assert.ok(t.every(x => x.style.underline === true), 'partial -> all on');
		// A1 keeps its bold + border (toggle patches one attr only).
		assert.strictEqual(t[0].style.bold, true, 'bold preserved');
		assert.deepStrictEqual(t[0].style.borderTop, { style: 'thin', color: { r: 0, g: 0, b: 0 } }, 'border preserved');
	});

	test('underline toggle over a FULLY-underlined selection turns it OFF', () => {
		const onlyB = { minRow: 0, maxRow: 0, minCol: 1, maxCol: 1 }; // B1 is the only underlined cell
		const t = computeStyleTargets(snapshot, 0, onlyB, { kind: 'toggle', prop: 'underline' });
		assert.strictEqual(t[0].style.underline, false, 'all-on -> off');
	});

	test('strike toggle ON when none are struck (mixed/off -> on)', () => {
		const t = computeStyleTargets(snapshot, 0, r1, { kind: 'toggle', prop: 'strike' });
		assert.ok(t.every(x => x.style.strike === true), 'no cell struck -> all on');
	});

	test('textColor set over the selection; clear on a cell that had it', () => {
		const setT = computeStyleTargets(snapshot, 0, r1, { kind: 'textColor', value: { r: 200, g: 10, b: 20 } });
		assert.ok(setT.every(x => x.style.textColor?.r === 200 && x.style.textColor?.g === 10 && x.style.textColor?.b === 20));
		// Now clear textColor on a snapshot where A1 has a textColor.
		const withTc = wb([wbCell(0, 0, { kind: 'number', number: 1 }, styleId(0, 0))],
			[def(0, 0, { bold: false, italic: false, textColor: { r: 5, g: 5, b: 5 } })]);
		const cleared = computeStyleTargets(withTc, 0, { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 }, { kind: 'textColor', value: null });
		assert.strictEqual(cleared[0].style.textColor, undefined, 'textColor cleared');
	});

	test('border edges:all sets all 4 edges of every cell to {style,color}', () => {
		const t = computeStyleTargets(snapshot, 0, r1, { kind: 'border', edges: 'all', style: 'medium', color: { r: 3, g: 4, b: 5 } });
		const edge = { style: 'medium', color: { r: 3, g: 4, b: 5 } };
		for (const x of t) {
			assert.deepStrictEqual(x.style.borderTop, edge);
			assert.deepStrictEqual(x.style.borderBottom, edge);
			assert.deepStrictEqual(x.style.borderLeft, edge);
			assert.deepStrictEqual(x.style.borderRight, edge);
		}
		// A1 keeps its bold (border patch preserves other attrs).
		assert.strictEqual(t[0].style.bold, true, 'bold preserved through a border op');
	});

	test('border edges:outer sets ONLY the rect-perimeter edges (a 1-row rect: every cell top+bottom; ends get the side)', () => {
		const t = computeStyleTargets(snapshot, 0, r1, { kind: 'border', edges: 'outer', style: 'thin', color: { r: 0, g: 0, b: 0 } });
		const e = { style: 'thin', color: { r: 0, g: 0, b: 0 } };
		// A1 (left end, top row, bottom row): top+bottom+left, NOT right.
		assert.deepStrictEqual(t[0].style.borderTop, e);
		assert.deepStrictEqual(t[0].style.borderBottom, e);
		assert.deepStrictEqual(t[0].style.borderLeft, e);
		assert.strictEqual(t[0].style.borderRight, undefined, 'A1 is not on the rect right edge');
		// B1 (middle): top+bottom only (no left/right -- it is interior horizontally).
		assert.deepStrictEqual(t[1].style.borderTop, e);
		assert.deepStrictEqual(t[1].style.borderBottom, e);
		assert.strictEqual(t[1].style.borderLeft, undefined, 'B1 is interior -> no left');
		assert.strictEqual(t[1].style.borderRight, undefined, 'B1 is interior -> no right');
		// C1 (right end): top+bottom+right, NOT left.
		assert.deepStrictEqual(t[2].style.borderRight, e);
		assert.strictEqual(t[2].style.borderLeft, undefined, 'C1 is not on the rect left edge');
	});

	test('border edges:top sets only the top edge of every cell', () => {
		const t = computeStyleTargets(snapshot, 0, r1, { kind: 'border', edges: 'top', style: 'thick', color: { r: 1, g: 1, b: 1 } });
		for (const x of t) {
			assert.deepStrictEqual(x.style.borderTop, { style: 'thick', color: { r: 1, g: 1, b: 1 } });
			assert.strictEqual(x.style.borderBottom, undefined);
			assert.strictEqual(x.style.borderLeft, undefined);
			assert.strictEqual(x.style.borderRight, undefined);
		}
		// A1 retains its PRE-EXISTING thin top border? No -- a top op OVERWRITES it with thick.
		assert.deepStrictEqual(t[0].style.borderTop, { style: 'thick', color: { r: 1, g: 1, b: 1 } }, 'top op overwrites the prior thin top');
	});

	test('border edges:none clears all 4 edges of every cell (style/color ignored)', () => {
		// Start from a snapshot where A1 has a top border; edges:none clears it.
		const t = computeStyleTargets(snapshot, 0, { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 }, { kind: 'border', edges: 'none', style: 'none', color: { r: 0, g: 0, b: 0 } });
		assert.strictEqual(t[0].style.borderTop, undefined, 'the prior top border is cleared');
		assert.strictEqual(t[0].style.borderBottom, undefined);
		assert.strictEqual(t[0].style.bold, true, 'clearing borders preserves non-border attrs');
	});

	test('border with style:none on a named edge CLEARS that edge (the picker "no border" path)', () => {
		const t = computeStyleTargets(snapshot, 0, { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 }, { kind: 'border', edges: 'top', style: 'none', color: { r: 0, g: 0, b: 0 } });
		assert.strictEqual(t[0].style.borderTop, undefined, 'style:none on the top edge clears it');
	});
});

suite('FE-5 W-R validateStyleMutation -- untrusted-payload guard', function () {
	test('valid mutations pass', () => {
		assert.strictEqual(validateStyleMutation({ kind: 'toggle', prop: 'bold' }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'toggle', prop: 'italic' }), null);
		// FE-FONT (2026-06-13): underline/strike are now engine toggles too.
		assert.strictEqual(validateStyleMutation({ kind: 'toggle', prop: 'underline' }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'toggle', prop: 'strike' }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'align', value: 'center' }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'align', value: null }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'fill', value: { r: 1, g: 2, b: 3 } }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'fill', value: null }), null);
		// FE-FONT: textColor (set + clear) + border (each edge set + a clear) are valid.
		assert.strictEqual(validateStyleMutation({ kind: 'textColor', value: { r: 1, g: 2, b: 3 } }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'textColor', value: null }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'border', edges: 'all', style: 'thin', color: { r: 0, g: 0, b: 0 } }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'border', edges: 'outer', style: 'medium', color: { r: 1, g: 2, b: 3 } }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'border', edges: 'top', style: 'double', color: { r: 9, g: 9, b: 9 } }), null);
		assert.strictEqual(validateStyleMutation({ kind: 'border', edges: 'none', style: 'none', color: { r: 0, g: 0, b: 0 } }), null, 'clear-all is valid');
	});
	test('malformed mutations are rejected with a reason', () => {
		assert.ok(validateStyleMutation(null) !== null);
		// FE-FONT: 'big' is not a toggle prop (underline/strike ARE now -- covered in the valid-pass test).
		assert.ok(validateStyleMutation({ kind: 'toggle', prop: 'big' }) !== null, 'big is not an engine toggle');
		assert.ok(validateStyleMutation({ kind: 'align', value: 'diagonal' }) !== null);
		assert.ok(validateStyleMutation({ kind: 'fill', value: { r: 300, g: 0, b: 0 } }) !== null, 'out-of-domain channel');
		// FE-FONT: bad textColor / border-edge / border-style / border-color rejections.
		assert.ok(validateStyleMutation({ kind: 'textColor', value: { r: -1, g: 0, b: 0 } }) !== null, 'out-of-domain text color channel');
		assert.ok(validateStyleMutation({ kind: 'border', edges: 'diagonal', style: 'thin', color: { r: 0, g: 0, b: 0 } }) !== null, 'unknown edge set');
		assert.ok(validateStyleMutation({ kind: 'border', edges: 'all', style: 'wiggly', color: { r: 0, g: 0, b: 0 } }) !== null, 'unknown border style');
		assert.ok(validateStyleMutation({ kind: 'border', edges: 'all', style: 'thin', color: { r: 256, g: 0, b: 0 } }) !== null, 'out-of-domain border color');
		assert.ok(validateStyleMutation({ kind: 'bogus' }) !== null);
	});
});

suite('FE-5 W-R styleJsonKey -- distinct styles intern distinctly; equal styles collide', function () {
	test('equal StyleJsons produce equal keys', () => {
		const a: StyleJson = { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 }, align: 'left' };
		const b: StyleJson = { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 }, align: 'left' };
		assert.strictEqual(styleJsonKey(a), styleJsonKey(b));
	});
	test('a differing attribute produces a differing key', () => {
		const base: StyleJson = { bold: true, italic: false };
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: true, italic: true }));
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: true, italic: false, fill: { r: 1, g: 1, b: 1 } }));
		assert.notStrictEqual(
			styleJsonKey({ bold: false, italic: false, borderTop: { style: 'thin', color: { r: 0, g: 0, b: 0 } } }),
			styleJsonKey({ bold: false, italic: false, borderTop: { style: 'thick', color: { r: 0, g: 0, b: 0 } } }),
		);
	});
	test('FE-FONT: underline/strike/textColor each shift the key (no collision -> no wrong-color render)', () => {
		const base: StyleJson = { bold: false, italic: false };
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: false, italic: false, underline: true }));
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: false, italic: false, strike: true }));
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: false, italic: false, textColor: { r: 1, g: 1, b: 1 } }));
		// underline:false collapses to the same key as absent (mirrors bold:false discipline).
		assert.strictEqual(styleJsonKey({ bold: false, italic: false, underline: false }), styleJsonKey(base));
		// Two distinct text colors must NOT collide.
		assert.notStrictEqual(
			styleJsonKey({ bold: false, italic: false, textColor: { r: 1, g: 2, b: 3 } }),
			styleJsonKey({ bold: false, italic: false, textColor: { r: 3, g: 2, b: 1 } }),
		);
	});
});

// =============================================================================================
// D8 -- END-TO-END engine round-trip: apply fill+bold+border via the engine setStyle path, then
// project + resolve -> the ResolvedCellStyle (incl. the border) matches. Skip-guarded on the cdylib.
// =============================================================================================

function engineSkip(): boolean {
	try {
		return !fs.existsSync(resolveEnginePath());
	} catch {
		return true;
	}
}

suite('FE-5 W-R D8 -- END-TO-END engine style round-trip (fill + bold + border render)', function () {
	suiteSetup(function () {
		if (engineSkip()) {
			this.skip();
		}
		this.timeout(60000);
	});

	test('setStyle (fill+bold+thin-top-border) -> snapshot carries styleId + a matching styles[] entry -> resolver yields the expected style INCLUDING the border', () => {
		const s = createWorkbookSession();
		try {
			const sheet = s.addSheet('S', 1000);
			s.setValue(sheet, 0, 0, { kind: 'number', number: 42 });
			// The exact StyleJson the host's computeStyleTargets would build for "fill + bold + top border".
			const targetStyle: StyleJson = {
				bold: true,
				italic: false,
				fill: { r: 255, g: 115, b: 49 },
				borderTop: { style: 'thin', color: { r: 0, g: 0, b: 0 } },
			};
			const id = s.registerStyle(targetStyle);
			s.batch([{ kind: 'setStyle', sheet, row: 0, col: 0, style: id }], { undoLabel: 'Format cells' });
			recalcDirtyChecked(s);

			// HOST read path: project the engine snapshot the way render() does.
			const wbSnap = s.snapshot();
			const projected = extractSheetSnapshot(wbSnap, sheet)!;
			assert.ok(projected.styles !== undefined && projected.styles.length >= 1, 'projection carries the styles[] table');
			const entry = projected.entries.find(e => e.row === 0 && e.col === 0)!;
			assert.ok(entry.styleId !== undefined, 'the cell projects its styleId');

			// WEBVIEW render path: resolve the styleId against the projected styles[] table.
			const resolved = resolveCellStyle(entry.styleId, projected.styles);
			assert.notStrictEqual(resolved, 'unresolved', 'the styleId MUST resolve against the styles[] the same projection carried');
			const rs = resolved as Exclude<typeof resolved, 'unresolved' | undefined>;
			assert.strictEqual(rs.bold, true, 'bold renders');
			assert.strictEqual(rs.fillColor, 'rgb(255,115,49)', 'fill renders as a CSS color');
			assert.ok(rs.borders !== undefined, 'the BORDER renders (the engine-only attribute, end to end)');
			assert.deepStrictEqual(rs.borders?.top, { style: 'thin', color: 'rgb(0,0,0)' });
		} finally {
			s.close();
		}
	});

	test('STYLE-ONLY BLANK CELL: setStyle on an EMPTY cell (no value/formula) -> the engine EMITS a {row,col,styleId} cell -> fill renders on the blank', () => {
		// Lane-A HIGH-1 settle: the "fill/border on a blank cell" deliverable depends on the engine
		// emitting a snapshot cell whose ONLY payload is a styleId (value + formula both undefined).
		// The CellSnapshotJson doc historically said "all three undefined cannot occur"; this proves
		// the post-FE-5 reality on the REAL engine (not a mock), so a silent render-miss can't hide.
		const s = createWorkbookSession();
		try {
			const sheet = s.addSheet('S', 1000);
			// Fill on a TRULY EMPTY cell: no setValue, no formula -- only a style.
			const id = s.registerStyle({ bold: false, italic: false, fill: { r: 200, g: 50, b: 50 } });
			s.batch([{ kind: 'setStyle', sheet, row: 5, col: 5, style: id }], { undoLabel: 'Format cells' });
			recalcDirtyChecked(s);

			// (1) THE ENGINE-EMIT CONTRACT: the raw snapshot must carry the style-only cell.
			const wbSnap = s.snapshot();
			const sheetSnap = wbSnap.sheets.find(sh => sh.id === sheet)!;
			const rawCell = sheetSnap.cells.find(c => c.row === 5 && c.col === 5);
			assert.ok(rawCell !== undefined, 'ENGINE must emit a snapshot cell for a style-only (value+formula undefined) cell -- else fill/border on a blank renders nothing');
			assert.strictEqual(rawCell!.value, undefined, 'the style-only cell has no value');
			assert.strictEqual(rawCell!.formula, undefined, 'the style-only cell has no formula');
			assert.ok(rawCell!.styleId !== undefined, 'the style-only cell carries its styleId');

			// (2) the host projection KEEPS it (does not drop at the value+formula-undefined branch).
			const projected = extractSheetSnapshot(wbSnap, sheet)!;
			const entry = projected.entries.find(e => e.row === 5 && e.col === 5);
			assert.ok(entry !== undefined && entry.styleId !== undefined, 'the projection keeps the style-only cell with its styleId');

			// (3) the resolver yields the fill -> the blank cell renders its fill end to end.
			const resolved = resolveCellStyle(entry!.styleId, projected.styles);
			assert.notStrictEqual(resolved, 'unresolved');
			const rs = resolved as Exclude<typeof resolved, 'unresolved' | undefined>;
			assert.strictEqual(rs.fillColor, 'rgb(200,50,50)', 'fill renders on the blank cell');
		} finally {
			s.close();
		}
	});

	test('SERIALIZABLE: a projected snapshot carrying a styleId is postMessage-safe (no BigInt) -- the live-app regression', () => {
		// THE BUG THIS PINS: `StyleId.peer` is an engine u64 -> a JS bigint. vscode `webview.postMessage`
		// JSON-serializes and THROWS on a bigint ("Do not know how to serialize a BigInt"), so every render
		// carrying a styleId was rejected and the grid never repainted -- the headline style feature did
		// nothing in the live app while every in-process test stayed green (they never crossed postMessage).
		// `extractSheetSnapshot` now downcasts `peer` bigint->number (styleIdToWire). Assert the projection is
		// genuinely serializable + carries number peers on BOTH the cell styleId and the styles[] entry.
		const s = createWorkbookSession();
		try {
			const sheet = s.addSheet('S', 1000);
			s.setValue(sheet, 0, 0, { kind: 'text', text: 'hi' });
			const id = s.registerStyle({ bold: true, italic: false, fill: { r: 1, g: 2, b: 3 } });
			s.batch([{ kind: 'setStyle', sheet, row: 0, col: 0, style: id }], { undoLabel: 'Format cells' });
			recalcDirtyChecked(s);
			const projected = extractSheetSnapshot(s.snapshot(), sheet)!;
			// The exact live failure mode: JSON.stringify throws on a bigint. This MUST not throw.
			assert.doesNotThrow(() => JSON.stringify(projected), 'projected snapshot must be JSON/postMessage-serializable (no bigint)');
			const entry = projected.entries.find(e => e.row === 0 && e.col === 0)!;
			assert.strictEqual(typeof entry.styleId!.peer, 'number', 'cell styleId.peer must be a number on the wire');
			assert.ok(projected.styles !== undefined && projected.styles.length >= 1);
			assert.strictEqual(typeof projected.styles![0].id.peer, 'number', 'styles[].id.peer must be a number on the wire');
			// And the wire form still resolves (number === number on both sides).
			assert.notStrictEqual(resolveCellStyle(entry.styleId, projected.styles), 'unresolved');
		} finally {
			s.close();
		}
	});

	test('INCREMENTAL: a style applied AFTER a seed render still resolves via the delta path (stylesAdded merge)', () => {
		const s = createWorkbookSession();
		try {
			const sheet = s.addSheet('S', 1000);
			s.setValue(sheet, 0, 0, { kind: 'number', number: 1 });
			recalcDirtyChecked(s);
			// Seed the shared delta cache (render #1).
			const cache: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
			acquireWorkbookSnapshotViaDelta(s, cache);
			// Now apply a style (the common case: edit AFTER the grid is already showing).
			const id = s.registerStyle({ bold: true, italic: false, fill: { r: 10, g: 20, b: 30 } });
			s.batch([{ kind: 'setStyle', sheet, row: 0, col: 0, style: id }], { undoLabel: 'Format cells' });
			recalcDirtyChecked(s);
			// Render #2 acquires via the DELTA path -> the merged snapshot must carry the new style (else the
			// cell's styleId would be unresolvable -> render unstyled -- the bug the stylesAdded merge fixes).
			const merged = acquireWorkbookSnapshotViaDelta(s, cache);
			const projected = extractSheetSnapshot(merged, sheet)!;
			const entry = projected.entries.find(e => e.row === 0 && e.col === 0)!;
			const resolved = resolveCellStyle(entry.styleId, projected.styles);
			assert.notStrictEqual(resolved, 'unresolved', 'after an INCREMENTAL style edit the styleId still resolves (delta stylesAdded merge)');
			const rs = resolved as Exclude<typeof resolved, 'unresolved' | undefined>;
			assert.strictEqual(rs.bold, true);
			assert.strictEqual(rs.fillColor, 'rgb(10,20,30)');
		} finally {
			s.close();
		}
	});
});
