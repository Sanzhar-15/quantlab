/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-BEYOND B1 -- unit tests for the vscode-free MCP tool layer. The host shell (mcpServer.ts) is
// operator-smoke (no headless ext-host), so the pure tool logic carries the real coverage: A1
// parsing, sheet + session resolution (No-Fallbacks loud errors), the six read-only tool handlers
// over a hand-built fake session port, and the snapshot cell cap.

import * as assert from 'assert';

import type {
	CellRangeJson,
	CellSnapshotJson,
	DiagnosticJson,
	FunctionMetadataJson,
	NamedRangeJson,
	RangeResultJson,
	SheetInfoJson,
	WorkbookSnapshotJson,
} from '../src/quantbook/types';
import {
	colLettersToIndex,
	columnIndexToLetters,
	McpToolError,
	parseA1Cell,
	parseA1Range,
	resolveRangeTarget,
	resolveSheetId,
	resolveTargetGrid,
	SNAPSHOT_CELL_CAP,
	toolGetCell,
	toolGetPublishedVariables,
	toolGetSnapshot,
	toolListFunctions,
	toolListNamedRanges,
	toolListSheets,
	toolQueryRange,
	toolValidateFormula,
	type McpHostContext,
	type McpSessionPort,
	type McpTargetGrid,
	type PublishedVariableTargets,
} from '../src/quantbook/mcp/mcpToolLogic';

// --- fakes ------------------------------------------------------------------------------------

interface FakeSheet {
	id: number;
	name: string;
	cells: CellSnapshotJson[];
}

/** A minimal in-memory fake implementing McpSessionPort for the tool handlers. */
class FakeSession implements McpSessionPort {
	/** FE-6 M: every validateFormula call is recorded so the handler's coordinate/body resolution is testable. */
	readonly validateCalls: Array<{ sheet: number; row: number; col: number; text: string }> = [];
	/** FE-6 M: the canned diagnostics validateFormula returns (default empty = valid). */
	validateResponse: DiagnosticJson[] = [];
	/** Wave L: the defined names listNames() returns (default empty). */
	names: NamedRangeJson[] = [];

	constructor(private readonly sheets: FakeSheet[], private readonly functions: FunctionMetadataJson[] = []) { }

	listSheets(): SheetInfoJson[] {
		return this.sheets.map((s) => ({ id: s.id, name: s.name }));
	}

	listNames(): NamedRangeJson[] {
		return this.names;
	}

	validateFormula(sheet: number, row: number, col: number, text: string): DiagnosticJson[] {
		this.validateCalls.push({ sheet, row, col, text });
		return this.validateResponse;
	}

	cell(sheet: number, row: number, col: number): CellSnapshotJson | null {
		const sh = this.sheets.find((s) => s.id === sheet);
		if (sh === undefined) {
			return null;
		}
		return sh.cells.find((c) => c.row === row && c.col === col) ?? null;
	}

	queryRange(range: CellRangeJson, options: { includeFormulas: boolean; includeFormats: boolean; includeRendered: boolean }): RangeResultJson {
		// Reject the v1-illegal include* + inverted ranges the way the engine does (fail loud).
		if (options.includeFormulas || options.includeFormats || options.includeRendered) {
			throw new Error('[not_implemented_in_v1_core]');
		}
		if (range.endRow < range.startRow || range.endCol < range.startCol) {
			throw new Error('[bad_argument] inverted range');
		}
		const sh = this.sheets.find((s) => s.id === range.sheet);
		if (sh === undefined) {
			throw new Error('[bad_argument] unknown sheet');
		}
		const nRows = range.endRow - range.startRow + 1;
		const nCols = range.endCol - range.startCol + 1;
		const columns = [];
		for (let c = 0; c < nCols; c++) {
			const values = [];
			for (let r = 0; r < nRows; r++) {
				const cell = sh.cells.find((x) => x.row === range.startRow + r && x.col === range.startCol + c);
				values.push(cell?.value ?? { kind: 'blank' as const });
			}
			columns.push({ values });
		}
		return { range, nRows, nCols, columns };
	}

	snapshot(): WorkbookSnapshotJson {
		return { sheets: this.sheets.map((s) => ({ id: s.id, name: s.name, cells: s.cells })), formats: [], dateSystem: 'Excel1900' };
	}

	listFunctions(): FunctionMetadataJson[] {
		return this.functions;
	}
}

function fn(name: string): FunctionMetadataJson {
	return { canonicalName: name, aliases: [], arity: { kind: 'fixed', n: 1 }, volatility: 'pure', determinism: true, depShape: 'value_deps', batchShape: 'scalar', argPolicy: 'strict', cancellation: 'none', argContext: 'value', provenanceTags: [] };
}

function makeCtx(grids: McpTargetGrid[], focusedId: string | undefined, published: Map<McpSessionPort, PublishedVariableTargets[]> = new Map()): McpHostContext {
	return {
		grids,
		focusedId,
		publishedVariables: (session) => published.get(session) ?? [],
	};
}

function singleGrid(session: McpSessionPort, sheet = 0, id = 'grid-0-sheet-0'): McpTargetGrid {
	return { id, session, sheet };
}

// --- A1 parsing -------------------------------------------------------------------------------

suite('B1 MCP -- A1 parsing', () => {
	test('colLettersToIndex / columnIndexToLetters round-trip', () => {
		assert.strictEqual(colLettersToIndex('A'), 0);
		assert.strictEqual(colLettersToIndex('Z'), 25);
		assert.strictEqual(colLettersToIndex('AA'), 26);
		assert.strictEqual(colLettersToIndex('AB'), 27);
		assert.strictEqual(columnIndexToLetters(0), 'A');
		assert.strictEqual(columnIndexToLetters(25), 'Z');
		assert.strictEqual(columnIndexToLetters(26), 'AA');
		for (let i = 0; i < 1000; i++) {
			assert.strictEqual(colLettersToIndex(columnIndexToLetters(i)), i, `round-trip at ${i}`);
		}
	});

	test('parseA1Cell parses valid refs to 0-based coords', () => {
		assert.deepStrictEqual(parseA1Cell('A1'), { row: 0, col: 0 });
		assert.deepStrictEqual(parseA1Cell('B1'), { row: 0, col: 1 });
		assert.deepStrictEqual(parseA1Cell('A2'), { row: 1, col: 0 });
		assert.deepStrictEqual(parseA1Cell('AA10'), { row: 9, col: 26 });
		assert.deepStrictEqual(parseA1Cell('b3'), { row: 2, col: 1 }, 'lowercase ok');
	});

	test('parseA1Cell rejects malformed refs loud', () => {
		assert.throws(() => parseA1Cell(''), McpToolError);
		assert.throws(() => parseA1Cell('A0'), McpToolError, 'row 0 rejected');
		assert.throws(() => parseA1Cell('1A'), McpToolError);
		assert.throws(() => parseA1Cell('A'), McpToolError);
		assert.throws(() => parseA1Cell('$A$1'), McpToolError, '$-anchored rejected');
		assert.throws(() => parseA1Cell('A1:B2'), McpToolError, 'a range is not a cell');
	});

	test('parseA1Range parses single + range + normalizes inverted', () => {
		assert.deepStrictEqual(parseA1Range('B1'), { startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
		assert.deepStrictEqual(parseA1Range('B1:D3'), { startRow: 0, startCol: 1, endRow: 2, endCol: 3 });
		assert.deepStrictEqual(parseA1Range('D3:B1'), { startRow: 0, startCol: 1, endRow: 2, endCol: 3 }, 'inverted normalized');
	});

	test('parseA1Range rejects multi-colon ranges loud', () => {
		assert.throws(() => parseA1Range('A1:B2:C3'), McpToolError);
		assert.throws(() => parseA1Range('A1:'), McpToolError);
	});

	test('parseA1Cell accepts the grid bounds and rejects off-grid refs loud (No-Fallbacks)', () => {
		// Bottom-right corner of the A1 grid (1,048,576 rows x 16,384 cols = XFD1048576) is in-extent.
		assert.deepStrictEqual(parseA1Cell('XFD1048576'), { row: 1048575, col: 16383 });
		assert.throws(() => parseA1Cell('A1048577'), McpToolError, 'row past the extent');
		assert.throws(() => parseA1Cell('XFE1'), McpToolError, 'column past the extent');
	});
});

// --- sheet resolution -------------------------------------------------------------------------

suite('B1 MCP -- sheet + range resolution', () => {
	const sheets: SheetInfoJson[] = [{ id: 0, name: 'S0' }, { id: 1, name: 'S1' }, { id: 7, name: 'Data' }];

	test('resolveSheetId by id and by name', () => {
		assert.strictEqual(resolveSheetId(sheets, 0), 0);
		assert.strictEqual(resolveSheetId(sheets, 7), 7);
		assert.strictEqual(resolveSheetId(sheets, 'S1'), 1);
		assert.strictEqual(resolveSheetId(sheets, 'Data'), 7);
	});

	test('resolveSheetId rejects unknown id/name loud (No-Fallbacks)', () => {
		assert.throws(() => resolveSheetId(sheets, 99), McpToolError);
		assert.throws(() => resolveSheetId(sheets, 'Nope'), McpToolError);
		assert.throws(() => resolveSheetId(sheets, 's0'), McpToolError, 'case-sensitive');
	});

	test('resolveRangeTarget: sheet-qualified ref', () => {
		assert.deepStrictEqual(resolveRangeTarget(sheets, 'S0!B1:D3'), { sheet: 0, startRow: 0, startCol: 1, endRow: 2, endCol: 3 });
		assert.deepStrictEqual(resolveRangeTarget(sheets, 'Data!A1'), { sheet: 7, startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
	});

	test('resolveRangeTarget: bare ref + sheet arg', () => {
		assert.deepStrictEqual(resolveRangeTarget(sheets, 'B1:D3', 'S1'), { sheet: 1, startRow: 0, startCol: 1, endRow: 2, endCol: 3 });
		assert.deepStrictEqual(resolveRangeTarget(sheets, 'B1', 1), { sheet: 1, startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
	});

	test('resolveRangeTarget: bare ref with no sheet is loud', () => {
		assert.throws(() => resolveRangeTarget(sheets, 'B1:D3'), McpToolError, 'no_sheet');
	});

	test('resolveRangeTarget: qualified ref conflicting with sheet arg is loud', () => {
		assert.throws(() => resolveRangeTarget(sheets, 'S0!B1', 'S1'), McpToolError, 'ambiguous_sheet');
		assert.throws(() => resolveRangeTarget(sheets, 'S0!B1', 1), McpToolError, 'ambiguous by id');
	});

	test('resolveRangeTarget: qualified ref matching sheet arg is allowed', () => {
		assert.deepStrictEqual(resolveRangeTarget(sheets, 'S0!B1', 'S0'), { sheet: 0, startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
		assert.deepStrictEqual(resolveRangeTarget(sheets, 'S0!B1', 0), { sheet: 0, startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
	});

	test('resolveRangeTarget: unknown qualified sheet is loud', () => {
		assert.throws(() => resolveRangeTarget(sheets, 'Nope!B1'), McpToolError, 'unknown_sheet');
	});
});

// --- session resolution -----------------------------------------------------------------------

suite('B1 MCP -- session (grid) resolution', () => {
	const sA = new FakeSession([{ id: 0, name: 'S0', cells: [] }]);
	const sB = new FakeSession([{ id: 0, name: 'S0', cells: [] }]);

	test('explicit sessionId selects that grid', () => {
		const ctx = makeCtx([singleGrid(sA, 0, 'grid-0-sheet-0'), singleGrid(sB, 0, 'grid-1-sheet-0')], undefined);
		assert.strictEqual(resolveTargetGrid(ctx, 'grid-1-sheet-0').session, sB);
	});

	test('unknown sessionId is loud', () => {
		const ctx = makeCtx([singleGrid(sA, 0, 'grid-0-sheet-0')], undefined);
		assert.throws(() => resolveTargetGrid(ctx, 'grid-9'), McpToolError, 'unknown_session');
	});

	test('no grids open is loud', () => {
		const ctx = makeCtx([], undefined);
		assert.throws(() => resolveTargetGrid(ctx), McpToolError, 'no_grid');
	});

	test('focused grid wins when present', () => {
		const ctx = makeCtx([singleGrid(sA, 0, 'grid-0-sheet-0'), singleGrid(sB, 0, 'grid-1-sheet-0')], 'grid-1-sheet-0');
		assert.strictEqual(resolveTargetGrid(ctx).session, sB);
	});

	test('single grid is auto-selected when none focused', () => {
		const ctx = makeCtx([singleGrid(sA, 0, 'grid-0-sheet-0')], undefined);
		assert.strictEqual(resolveTargetGrid(ctx).session, sA);
	});

	test('multiple grids, none focused, no sessionId is loud (No-Fallbacks)', () => {
		const ctx = makeCtx([singleGrid(sA, 0, 'grid-0-sheet-0'), singleGrid(sB, 0, 'grid-1-sheet-0')], undefined);
		assert.throws(() => resolveTargetGrid(ctx), McpToolError, 'ambiguous_grid');
	});
});

// --- tool handlers ----------------------------------------------------------------------------

suite('B1 MCP -- tool handlers', () => {
	function fixtureSession(): FakeSession {
		return new FakeSession(
			[
				{
					id: 0,
					name: 'S0',
					cells: [
						{ row: 0, col: 1, value: { kind: 'number', number: 42 }, rendered: '42' },
						{ row: 0, col: 2, value: { kind: 'number', number: 43 }, formula: 'B1+1', rendered: '43' },
						{ row: 1, col: 1, value: { kind: 'text', text: 'hi' } },
					],
				},
				{ id: 1, name: 'S1', cells: [{ row: 0, col: 0, value: { kind: 'boolean', boolean: true } }] },
			],
			[fn('SUM'), fn('SHARPE')],
		);
	}

	test('toolListSheets returns the live sheets', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolListSheets(ctx, {});
		assert.strictEqual(out.sessionId, 'grid-0-sheet-0');
		assert.deepStrictEqual(out.sheets, [{ id: 0, name: 'S0' }, { id: 1, name: 'S1' }]);
	});

	test('toolGetCell reads a populated cell with value/formula/rendered', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolGetCell(ctx, { a1: 'S0!C1' });
		assert.deepStrictEqual(out.value, { kind: 'number', number: 43 });
		assert.strictEqual(out.formula, 'B1+1');
		assert.strictEqual(out.rendered, '43');
		assert.strictEqual(out.row, 0);
		assert.strictEqual(out.col, 2);
	});

	test('toolGetCell on an empty cell returns no value/formula (not an error)', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolGetCell(ctx, { a1: 'S0!Z9' });
		assert.strictEqual(out.value, undefined);
		assert.strictEqual(out.formula, undefined);
		assert.strictEqual(out.rendered, undefined);
	});

	test('toolGetCell defaults to the grid focused sheet for a bare ref', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s, 1)], 'grid-0-sheet-1');
		// grid.sheet = 1; bare A1 -> sheet 1.
		const out = toolGetCell(ctx, { a1: 'A1', sessionId: undefined });
		assert.strictEqual(out.sheet, 1);
		assert.deepStrictEqual(out.value, { kind: 'boolean', boolean: true });
	});

	test('toolGetCell rejects a range loud', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		assert.throws(() => toolGetCell(ctx, { a1: 'S0!B1:D3' }), McpToolError);
	});

	test('toolQueryRange returns columnar values', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolQueryRange(ctx, { range: 'S0!B1:C1' });
		assert.strictEqual(out.nRows, 1);
		assert.strictEqual(out.nCols, 2);
		assert.deepStrictEqual(out.columns[0].values[0], { kind: 'number', number: 42 });
		assert.deepStrictEqual(out.columns[1].values[0], { kind: 'number', number: 43 });
	});

	test('toolQueryRange surfaces an engine error (e.g. unknown sheet) loud', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		assert.throws(() => toolQueryRange(ctx, { range: 'Ghost!A1:B2' }), McpToolError, 'unknown sheet -> resolveRangeTarget throws');
	});

	test('toolGetSnapshot returns capped cells with a count', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolGetSnapshot(ctx, {});
		assert.strictEqual(out.cellCount, 4);
		assert.strictEqual(out.sheets.length, 2);
	});

	test('toolGetSnapshot can scope to one sheet', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolGetSnapshot(ctx, { sheet: 'S1' });
		assert.strictEqual(out.sheets.length, 1);
		assert.strictEqual(out.sheets[0].id, 1);
		assert.strictEqual(out.cellCount, 1);
	});

	test('toolGetSnapshot fails loud over the cell cap (No-Fallbacks)', () => {
		const bigCells: CellSnapshotJson[] = [];
		for (let i = 0; i <= SNAPSHOT_CELL_CAP; i++) {
			bigCells.push({ row: i, col: 0, value: { kind: 'number', number: i } });
		}
		const s = new FakeSession([{ id: 0, name: 'S0', cells: bigCells }]);
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		assert.throws(() => toolGetSnapshot(ctx, {}), (e: unknown) => e instanceof McpToolError && /snapshot_too_large/.test(e.message));
	});

	test('toolListFunctions returns the registered functions', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolListFunctions(ctx, {});
		assert.strictEqual(out.count, 2);
		assert.deepStrictEqual(out.functions.map((f) => f.canonicalName), ['SUM', 'SHARPE']);
	});

	test('toolGetPublishedVariables maps published ranges to A1 strings', () => {
		const s = fixtureSession();
		const published = new Map<McpSessionPort, PublishedVariableTargets[]>();
		published.set(s, [
			{ name: 'returns', range: { sheet: 0, startRow: 0, startCol: 1, endRow: 2, endCol: 1 } },
			{ name: 'pi', range: { sheet: 1, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } },
		]);
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0', published);
		const out = toolGetPublishedVariables(ctx, {});
		assert.strictEqual(out.variables.length, 2);
		assert.deepStrictEqual(out.variables[0], { name: 'returns', sheet: 0, a1Range: 'S0!B1:B3', range: { sheet: 0, startRow: 0, startCol: 1, endRow: 2, endCol: 1 } });
		assert.deepStrictEqual(out.variables[1], { name: 'pi', sheet: 1, a1Range: 'S1!A1', range: { sheet: 1, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } });
	});

	test('toolGetPublishedVariables is empty (not an error) with no kernel', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0');
		const out = toolGetPublishedVariables(ctx, {});
		assert.deepStrictEqual(out.variables, []);
	});

	test('toolGetPublishedVariables surfaces a dangling (deleted-sheet) variable as #REF!', () => {
		const s = fixtureSession();
		const published = new Map<McpSessionPort, PublishedVariableTargets[]>();
		// sheet 9 is NOT a live sheet of the fixture (only 0 and 1) -- a variable left tracked on a
		// since-deleted sheet must still surface, visibly, not be silently omitted.
		published.set(s, [{ name: 'ghost', range: { sheet: 9, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }]);
		const ctx = makeCtx([singleGrid(s)], 'grid-0-sheet-0', published);
		const out = toolGetPublishedVariables(ctx, {});
		assert.strictEqual(out.variables.length, 1);
		assert.strictEqual(out.variables[0].name, 'ghost');
		assert.strictEqual(out.variables[0].a1Range, '#REF!9!A1');
	});

	test('every tool rejects loud when no grid is open', () => {
		const ctx = makeCtx([], undefined);
		assert.throws(() => toolListSheets(ctx, {}), McpToolError);
		assert.throws(() => toolGetCell(ctx, { a1: 'A1' }), McpToolError);
		assert.throws(() => toolQueryRange(ctx, { range: 'S0!A1:B2' }), McpToolError);
		assert.throws(() => toolGetSnapshot(ctx, {}), McpToolError);
		assert.throws(() => toolListFunctions(ctx, {}), McpToolError);
		assert.throws(() => toolGetPublishedVariables(ctx, {}), McpToolError);
		assert.throws(() => toolValidateFormula(ctx, { formula: '=1' }), McpToolError);
	});
});

// --- FE-6 M (2026-06-12): validate_formula (read-only dry-run) ---------------------------------

suite('FE-6 M -- validate_formula', () => {
	function fixtureSession(): FakeSession {
		return new FakeSession([{ id: 0, name: 'S0', cells: [] }, { id: 1, name: 'S1', cells: [] }], [fn('SUM')]);
	}

	test('valid formula -> empty diagnostics + valid=true; the engine got the BODY (no leading "=")', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		const out = toolValidateFormula(ctx, { formula: '=SUM(A1:A9)', a1: 'S0!B2' });
		assert.strictEqual(out.valid, true);
		assert.deepStrictEqual(out.diagnostics, []);
		assert.strictEqual(out.sheet, 0);
		assert.strictEqual(out.row, 1);
		assert.strictEqual(out.col, 1);
		// The leading "=" is stripped to the engine BODY; the position is the resolved a1.
		assert.deepStrictEqual(s.validateCalls, [{ sheet: 0, row: 1, col: 1, text: 'SUM(A1:A9)' }]);
	});

	test('a formula WITHOUT a leading "=" is passed through unchanged', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		toolValidateFormula(ctx, { formula: 'SUM(A1:A9)', a1: 'S0!A1' });
		assert.strictEqual(s.validateCalls[0].text, 'SUM(A1:A9)');
	});

	test('leading whitespace is stripped CONSISTENTLY in BOTH the "=" and no-"=" branches (Opus LOW)', () => {
		// The "=" branch already validated `trimmed.slice(1)`; the no-"=" branch previously validated the
		// UN-trimmed original. Both branches now validate the trimmed body, so a leading-whitespace formula
		// reaches the engine with NO leading whitespace whether or not it carries a "=".
		const s1 = fixtureSession();
		const ctx1 = makeCtx([singleGrid(s1, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		toolValidateFormula(ctx1, { formula: '   SUM(A1:A9)', a1: 'S0!A1' });
		assert.strictEqual(s1.validateCalls[0].text, 'SUM(A1:A9)', 'no-"=" branch trims leading whitespace');

		const s2 = fixtureSession();
		const ctx2 = makeCtx([singleGrid(s2, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		toolValidateFormula(ctx2, { formula: '   =SUM(A1:A9)', a1: 'S0!A1' });
		assert.strictEqual(s2.validateCalls[0].text, 'SUM(A1:A9)', '"=" branch also trims leading whitespace');
	});

	test('invalid formula -> diagnostics returned as DATA (not thrown), valid=false', () => {
		const s = fixtureSession();
		s.validateResponse = [{ severity: 'error', code: 'formula_parse', message: 'unexpected token' }];
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		const out = toolValidateFormula(ctx, { formula: '=SUM(', a1: 'S0!A1' });
		assert.strictEqual(out.valid, false);
		assert.strictEqual(out.diagnostics.length, 1);
		assert.strictEqual(out.diagnostics[0].code, 'formula_parse');
	});

	test('with no a1, validates at A1 of the resolved (focused) sheet', () => {
		const s = fixtureSession();
		// Focused sheet is 1 -> the default validation position is sheet 1, A1.
		const ctx = makeCtx([singleGrid(s, 1, 'grid-0-sheet-1')], 'grid-0-sheet-1');
		const out = toolValidateFormula(ctx, { formula: '=A1+1' });
		assert.strictEqual(out.sheet, 1);
		assert.strictEqual(out.row, 0);
		assert.strictEqual(out.col, 0);
		assert.deepStrictEqual(s.validateCalls[0], { sheet: 1, row: 0, col: 0, text: 'A1+1' });
	});

	test('with no a1 but an explicit sheet arg, validates at A1 of that sheet', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		const out = toolValidateFormula(ctx, { formula: '=1', sheet: 'S1' });
		assert.strictEqual(out.sheet, 1);
	});

	test('rejects an unknown sheet / a range a1 loud (No-Fallbacks)', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		assert.throws(() => toolValidateFormula(ctx, { formula: '=1', sheet: 'Ghost' }), McpToolError);
		assert.throws(() => toolValidateFormula(ctx, { formula: '=1', a1: 'S0!A1:B2' }), McpToolError, 'a range is not a single position');
	});

	test('rejects a non-string formula loud', () => {
		const s = fixtureSession();
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		assert.throws(() => toolValidateFormula(ctx, { formula: 5 as unknown as string }), (e: unknown) => e instanceof McpToolError && /must be a string/.test(e.message));
	});
});

// --- Wave L: list_named_ranges ----------------------------------------------------------------

suite('Wave L MCP -- list_named_ranges', () => {
	test('returns every workbook + sheet-scoped name with a count', () => {
		const s = new FakeSession([{ id: 0, name: 'S0', cells: [] }]);
		s.names = [
			{ name: 'RETURNS', target: { kind: 'range', range: { sheet: 0, startRow: 1, startCol: 1, endRow: 99, endCol: 1 } } },
			{ name: 'TAXRATE', target: { kind: 'constant', value: { kind: 'number', number: 0.2 } }, scope: 0 },
		];
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		const out = toolListNamedRanges(ctx, {});
		assert.strictEqual(out.sessionId, 'grid-0-sheet-0');
		assert.strictEqual(out.count, 2);
		assert.strictEqual(out.names[0].name, 'RETURNS');
		assert.strictEqual(out.names[1].scope, 0, 'a sheet-scoped name carries its scope');
	});

	test('empty when no names are defined (a true empty, not an error)', () => {
		const s = new FakeSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		const out = toolListNamedRanges(ctx, {});
		assert.strictEqual(out.count, 0);
		assert.deepStrictEqual(out.names, []);
	});

	test('no grid open -> loud [no_grid] (No-Fallbacks)', () => {
		const ctx = makeCtx([], undefined);
		assert.throws(() => toolListNamedRanges(ctx, {}), (e: unknown) => e instanceof McpToolError && /no_grid/.test(e.message));
	});

	test('an unknown sessionId -> loud [unknown_session]', () => {
		const s = new FakeSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([singleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		assert.throws(() => toolListNamedRanges(ctx, { sessionId: 'grid-9-sheet-9' }), (e: unknown) => e instanceof McpToolError && /unknown_session/.test(e.message));
	});
});
