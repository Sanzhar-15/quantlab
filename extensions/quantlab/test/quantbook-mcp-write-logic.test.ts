/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 (MCP writes) -- unit tests for the vscode-free WRITE core. The host shell (mcpServer.ts) is
// operator-smoke (no headless ext-host), so the pure write logic carries the real coverage: op
// building (formula / clear / value classification + No-Fallbacks rejects), risk classification
// (large / destructive / formula-overwrite), the audit-line formatting, the target description, and
// the per-session serializing write QUEUE (FIFO ordering + failure isolation).

import * as assert from 'assert';

import type {
	CellRangeJson,
	CellSnapshotJson,
	DiagnosticJson,
	FormatIdJson,
	FunctionMetadataJson,
	NamedRangeJson,
	RangeResultJson,
	SessionOpJson,
	SheetInfoJson,
	StyleDefJson,
	StyleIdJson,
	StyleJson,
	TableSnapshotJson,
	TableSpecJson,
	UndoRedoResultJson,
	UsedRangeJson,
	WorkbookSnapshotJson,
} from '../src/quantbook/types';
import { A1_MAX_COLS, A1_MAX_ROWS, McpToolError, type McpHostContext, type McpSessionPort, type McpTargetGrid } from '../src/quantbook/mcp/mcpToolLogic';
import {
	auditField,
	buildWriteOps,
	classifyWriteRisk,
	currentCellStyleFromSnapshot,
	describeTarget,
	formatAuditLine,
	MCP_MAX_BATCH_CELLS,
	MCP_MAX_RAW_INPUT_LENGTH,
	mergeStylePatch,
	prepareAddSheet,
	prepareDefineNamedRange,
	prepareDefineTable,
	prepareDeleteNamedRange,
	prepareDeleteSheet,
	prepareDeleteStructural,
	prepareDeleteTable,
	prepareInsertStructural,
	prepareRenameSheet,
	prepareSetCell,
	prepareSetNumberFormat,
	prepareSetStyle,
	prepareUndoRedo,
	prepareWriteCells,
	resolveWriteCellTarget,
	RISK_LARGE_CELL_COUNT,
	styleJsonKey,
	summarizeRisk,
	validateStylePatch,
	WriteQueue,
	type BuiltWriteOp,
	type McpWriteSessionPort,
	type WriteAuditRecord,
} from '../src/quantbook/mcp/mcpWriteLogic';

// --- fakes ------------------------------------------------------------------------------------

interface FakeSheet {
	id: number;
	name: string;
	cells: CellSnapshotJson[];
}

/**
 * A minimal in-memory fake session implementing the FULL write port {@link McpWriteSessionPort}. Records
 * every batch + napi side effect (registerStyle / registerFormat / insert+delete rows/columns) so the
 * `commit` strategies (FE-6 M) are testable without vscode/napi. `registerStyle` mints monotonic ids and
 * is idempotent (an identical {@link StyleJson} -- by dedup key -- returns the same id). `styles` is
 * exposed in the snapshot so the style read-modify-write merge has a live registry to resolve cell
 * `styleId`s against.
 */
class FakeWriteSession implements McpWriteSessionPort {
	readonly batched: Array<{ ops: SessionOpJson[]; undoLabel?: string }> = [];
	readonly registeredStyles: StyleJson[] = [];
	readonly registeredFormats: string[] = [];
	readonly structuralCalls: Array<{ kind: string; sheet: number; a: number; b: number }> = [];
	private readonly styleDefs: StyleDefJson[] = [];
	private readonly styleIdByKey = new Map<string, StyleIdJson>();
	private nextStyleCounter = 1;
	private nextFormatCounter = 200;

	constructor(private readonly sheets: FakeSheet[]) { }

	listSheets(): SheetInfoJson[] {
		return this.sheets.map((s) => ({ id: s.id, name: s.name }));
	}

	cell(sheet: number, row: number, col: number): CellSnapshotJson | null {
		const sh = this.sheets.find((s) => s.id === sheet);
		if (sh === undefined) {
			return null;
		}
		return sh.cells.find((c) => c.row === row && c.col === col) ?? null;
	}

	queryRange(): RangeResultJson {
		throw new Error('not used in write tests');
	}

	snapshot(): WorkbookSnapshotJson {
		return {
			sheets: this.sheets.map((s) => ({ id: s.id, name: s.name, cells: s.cells })),
			formats: [],
			styles: this.styleDefs.map((d) => ({ id: { ...d.id }, style: d.style })),
			dateSystem: 'Excel1900',
		};
	}

	listFunctions(): FunctionMetadataJson[] {
		return [];
	}

	validateFormula(): DiagnosticJson[] {
		throw new Error('not used in write tests');
	}

	setValue(): void {
		throw new Error('not used (batch-only discipline)');
	}

	setFormula(): void {
		throw new Error('not used (batch-only discipline)');
	}

	batch(ops: SessionOpJson[], options: { undoLabel?: string }): { applied: number; version: Uint8Array } {
		this.batched.push({ ops, undoLabel: options.undoLabel });
		return { applied: ops.length, version: new Uint8Array() };
	}

	registerStyle(style: StyleJson): StyleIdJson {
		this.registeredStyles.push(style);
		const key = styleJsonKey(style);
		const existing = this.styleIdByKey.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const id: StyleIdJson = { peer: 1n, counter: this.nextStyleCounter++ };
		this.styleIdByKey.set(key, id);
		this.styleDefs.push({ id, style });
		return id;
	}

	registerFormat(formatString: string): FormatIdJson {
		this.registeredFormats.push(formatString);
		return { kind: 'custom', customPeer: 1n, customCounter: this.nextFormatCounter++ };
	}

	insertRows(sheet: number, row: number, count: number): void {
		this.structuralCalls.push({ kind: 'insertRows', sheet, a: row, b: count });
	}

	deleteRows(sheet: number, start: number, end: number): void {
		this.structuralCalls.push({ kind: 'deleteRows', sheet, a: start, b: end });
	}

	insertColumns(sheet: number, col: number, count: number): void {
		this.structuralCalls.push({ kind: 'insertColumns', sheet, a: col, b: count });
	}

	deleteColumns(sheet: number, start: number, end: number): void {
		this.structuralCalls.push({ kind: 'deleteColumns', sheet, a: start, b: end });
	}

	// --- Wave L: metadata-write side effects (named ranges / sheets / tables / undo-redo) -------
	/** Every metadata napi call, recorded as { op, detail } so the `commit` strategies are testable. */
	readonly metadataCalls: Array<{ op: string; detail: string }> = [];
	/** The defined names listNames() returns (tests seed this for the replace / exists checks). */
	names: NamedRangeJson[] = [];
	/** What undo() / redo() report as consumed (tests flip these to simulate an empty stack). */
	undoConsumed = true;
	redoConsumed = true;

	listNames(): NamedRangeJson[] {
		return this.names;
	}

	usedRange(): UsedRangeJson | null {
		throw new Error('not used in write tests');
	}

	listTables(): TableSnapshotJson[] {
		throw new Error('not used in write tests');
	}

	setName(name: string, target: CellRangeJson): void {
		this.metadataCalls.push({ op: 'setName', detail: `${name}@s${target.sheet}:${target.startRow},${target.startCol}-${target.endRow},${target.endCol}` });
	}

	deleteName(name: string, scope?: number): void {
		this.metadataCalls.push({ op: 'deleteName', detail: scope === undefined ? name : `${name}#${scope}` });
	}

	addSheet(name: string, chunkRows: number): void {
		this.metadataCalls.push({ op: 'addSheet', detail: `${name}:${chunkRows}` });
	}

	renameSheet(id: number, newName: string): void {
		this.metadataCalls.push({ op: 'renameSheet', detail: `${id}->${newName}` });
	}

	deleteSheet(id: number): void {
		this.metadataCalls.push({ op: 'deleteSheet', detail: `${id}` });
	}

	createTable(spec: TableSpecJson): void {
		this.metadataCalls.push({ op: 'createTable', detail: `${spec.name}@s${spec.sheet}:${spec.topRow},${spec.topCol} ${spec.rows}x${spec.cols} cols=${spec.columnNames.join('|')}` });
	}

	dropTable(name: string): void {
		this.metadataCalls.push({ op: 'dropTable', detail: name });
	}

	undo(): UndoRedoResultJson {
		this.metadataCalls.push({ op: 'undo', detail: '' });
		return { consumed: this.undoConsumed, version: new Uint8Array() };
	}

	redo(): UndoRedoResultJson {
		this.metadataCalls.push({ op: 'redo', detail: '' });
		return { consumed: this.redoConsumed, version: new Uint8Array() };
	}
}

const SHEETS: SheetInfoJson[] = [{ id: 0, name: 'S0' }, { id: 1, name: 'S1' }, { id: 7, name: 'Data' }];

function makeCtx(grids: McpTargetGrid[], focusedId: string | undefined): McpHostContext {
	return { grids, focusedId, publishedVariables: () => [] };
}

function grid(session: McpSessionPort, sheet = 0, id = 'grid-0-sheet-0'): McpTargetGrid {
	return { id, session, sheet };
}

const noPrior = (): CellSnapshotJson | null => null;

// --- op building ------------------------------------------------------------------------------

suite('W3 MCP writes -- op building', () => {
	test('resolveWriteCellTarget: qualified, bare+fallback, and loud failures', () => {
		assert.deepStrictEqual(resolveWriteCellTarget(SHEETS, 'S0!B1', undefined), { sheet: 0, row: 0, col: 1 });
		assert.deepStrictEqual(resolveWriteCellTarget(SHEETS, 'B2', 'Data'), { sheet: 7, row: 1, col: 1 });
		assert.deepStrictEqual(resolveWriteCellTarget(SHEETS, 'B2', 1), { sheet: 1, row: 1, col: 1 });
		assert.throws(() => resolveWriteCellTarget(SHEETS, 'B2', undefined), McpToolError, 'no sheet');
		assert.throws(() => resolveWriteCellTarget(SHEETS, 'Nope!A1', undefined), McpToolError, 'unknown sheet');
		assert.throws(() => resolveWriteCellTarget(SHEETS, 'S0!A1', 'S1'), McpToolError, 'ambiguous');
		assert.throws(() => resolveWriteCellTarget(SHEETS, 'S0!A1:B2', undefined), McpToolError, 'range rejected');
		assert.throws(() => resolveWriteCellTarget(SHEETS, 'S0!ZZ0', undefined), McpToolError, 'row 0');
	});

	test('buildWriteOps classifies value / formula / clear like a grid edit', () => {
		const ops = buildWriteOps(SHEETS, [
			{ a1: 'S0!A1', text: '42' },
			{ a1: 'S0!A2', text: 'hi' },
			{ a1: 'S0!A3', text: '=SUM(A1:A2)' },
			{ a1: 'S0!A4', text: '' },
			{ a1: 'S0!A5', text: '  =B1  ' },
		], undefined);
		assert.deepStrictEqual(ops[0].op, { kind: 'setValue', sheet: 0, row: 0, col: 0, value: { kind: 'number', number: 42 } });
		assert.deepStrictEqual(ops[1].op, { kind: 'setValue', sheet: 0, row: 1, col: 0, value: { kind: 'text', text: 'hi' } });
		assert.deepStrictEqual(ops[2].op, { kind: 'setFormula', sheet: 0, row: 2, col: 0, text: 'SUM(A1:A2)' });
		assert.strictEqual(ops[2].isFormula, true);
		assert.deepStrictEqual(ops[3].op, { kind: 'clear', sheet: 0, row: 3, col: 0 });
		assert.strictEqual(ops[3].isClear, true);
		// Leading whitespace before "=" is still a formula (trimStart), body has no "=".
		assert.deepStrictEqual(ops[4].op, { kind: 'setFormula', sheet: 0, row: 4, col: 0, text: 'B1  ' });
	});

	test('buildWriteOps rejects empty / over-cap / over-length / non-string / duplicate loud', () => {
		assert.throws(() => buildWriteOps(SHEETS, [], undefined), (e: unknown) => e instanceof McpToolError && /empty_batch/.test(e.message));
		const big = Array.from({ length: MCP_MAX_BATCH_CELLS + 1 }, (_v, i) => ({ a1: `S0!A${i + 1}`, text: 'x' }));
		assert.throws(() => buildWriteOps(SHEETS, big, undefined), (e: unknown) => e instanceof McpToolError && /batch_too_large/.test(e.message));
		const long = 'x'.repeat(MCP_MAX_RAW_INPUT_LENGTH + 1);
		assert.throws(() => buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: long }], undefined), (e: unknown) => e instanceof McpToolError && /over the/.test(e.message));
		assert.throws(() => buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: 5 as unknown as string }], undefined), (e: unknown) => e instanceof McpToolError && /must be a string/.test(e.message));
		assert.throws(() => buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: '1' }, { a1: 'A1', text: '2' }], 0), (e: unknown) => e instanceof McpToolError && /conflicting_batch_ops/.test(e.message), 'same cell twice');
	});

	test('buildWriteOps is atomic: a bad cell mid-batch rejects the WHOLE batch (No-Fallbacks)', () => {
		assert.throws(
			() => buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: '1' }, { a1: 'Ghost!A2', text: '2' }], undefined),
			McpToolError,
			'unknown sheet on the 2nd cell rejects everything',
		);
	});
});

// --- risk classification ----------------------------------------------------------------------

suite('W3 MCP writes -- risk classification', () => {
	function valueOps(n: number): BuiltWriteOp[] {
		return buildWriteOps(SHEETS, Array.from({ length: n }, (_v, i) => ({ a1: `S0!A${i + 1}`, text: String(i) })), undefined);
	}

	test('small value-only writes into empty cells need NO confirmation', () => {
		const verdict = classifyWriteRisk(valueOps(3), noPrior);
		assert.deepStrictEqual(verdict.reasons, []);
		assert.strictEqual(verdict.requiresConfirmation, false);
	});

	test('a large batch (>= threshold) requires confirmation', () => {
		const verdict = classifyWriteRisk(valueOps(RISK_LARGE_CELL_COUNT), noPrior);
		assert.ok(verdict.reasons.includes('large'));
		assert.strictEqual(verdict.requiresConfirmation, true);
		// One below the threshold is NOT large.
		assert.strictEqual(classifyWriteRisk(valueOps(RISK_LARGE_CELL_COUNT - 1), noPrior).reasons.includes('large'), false);
	});

	test('a clear (empty input) is destructive -> confirmation', () => {
		const ops = buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: '' }], undefined);
		const verdict = classifyWriteRisk(ops, noPrior);
		assert.deepStrictEqual(verdict.reasons, ['destructive_clear']);
		assert.strictEqual(verdict.requiresConfirmation, true);
	});

	test('overwriting a cell that holds a formula -> confirmation', () => {
		const ops = buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: '42' }], undefined);
		const readPrior = (sheet: number, row: number, col: number): CellSnapshotJson | null =>
			sheet === 0 && row === 0 && col === 0 ? { row: 0, col: 0, value: { kind: 'number', number: 1 }, formula: 'B1+1' } : null;
		const verdict = classifyWriteRisk(ops, readPrior);
		assert.deepStrictEqual(verdict.reasons, ['formula_overwrite']);
		assert.strictEqual(verdict.requiresConfirmation, true);
	});

	test('overwriting a cell that holds only a LITERAL value is not flagged', () => {
		const ops = buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: '42' }], undefined);
		const readPrior = (): CellSnapshotJson | null => ({ row: 0, col: 0, value: { kind: 'number', number: 1 } });
		assert.deepStrictEqual(classifyWriteRisk(ops, readPrior).reasons, []);
	});

	test('overwriting a cell with an EMPTY formula body still flags formula_overwrite (Codex MED)', () => {
		// The live edit path accepts input "=" -> setFormula with body "". Such a cell is still formula-
		// backed; overwriting it must prompt, so detection keys on the PRESENCE of the formula property.
		const ops = buildWriteOps(SHEETS, [{ a1: 'S0!A1', text: '42' }], undefined);
		const readPrior = (): CellSnapshotJson | null => ({ row: 0, col: 0, value: { kind: 'number', number: 0 }, formula: '' });
		assert.deepStrictEqual(classifyWriteRisk(ops, readPrior).reasons, ['formula_overwrite']);
	});

	test('multiple reasons combine', () => {
		const cells = Array.from({ length: RISK_LARGE_CELL_COUNT }, (_v, i) => ({ a1: `S0!A${i + 1}`, text: i === 0 ? '' : String(i) }));
		const verdict = classifyWriteRisk(buildWriteOps(SHEETS, cells, undefined), noPrior);
		assert.ok(verdict.reasons.includes('large'));
		assert.ok(verdict.reasons.includes('destructive_clear'));
		assert.strictEqual(verdict.requiresConfirmation, true);
	});

	test('summarizeRisk text', () => {
		assert.strictEqual(summarizeRisk(3, []), '3 cell(s), no elevated risk');
		assert.strictEqual(summarizeRisk(60, ['large', 'destructive_clear', 'formula_overwrite']), '60 cell(s): large batch, clears existing cells, overwrites existing formula(s)');
	});
});

// --- audit + target description ---------------------------------------------------------------

suite('W3 MCP writes -- audit + target description', () => {
	const sheetNameById = new Map(SHEETS.map((s) => [s.id, s.name]));

	test('describeTarget renders single + multi-cell', () => {
		const one = buildWriteOps(SHEETS, [{ a1: 'S0!B1', text: '1' }], undefined);
		assert.strictEqual(describeTarget(one, sheetNameById), 'S0!B1');
		const many = buildWriteOps(SHEETS, [{ a1: 'S0!B1', text: '1' }, { a1: 'S0!B2', text: '2' }, { a1: 'S0!B3', text: '3' }], undefined);
		assert.strictEqual(describeTarget(many, sheetNameById), 'S0!B1 + 2 more (3 cells)');
		// Unknown sheet id still renders (the audit must always produce a line).
		const orphan: BuiltWriteOp[] = [{ op: { kind: 'clear', sheet: 99, row: 0, col: 0 }, sheet: 99, row: 0, col: 0, text: '', isClear: true, isFormula: false, isStyleOrFormat: false }];
		assert.strictEqual(describeTarget(orphan, sheetNameById), '#99!A1');
	});

	test('formatAuditLine is stable, ASCII, and always carries outcome; detail only when present', () => {
		const base: WriteAuditRecord = {
			timestamp: '2026-06-09T00:00:00.000Z#1', tool: 'set_cell', sessionId: 'grid-0-sheet-0',
			undoLabel: 'MCP: set S0!B1', opCount: 1, target: 'S0!B1', risk: '1 cell(s), no elevated risk', outcome: 'applied',
		};
		const applied = formatAuditLine(base);
		assert.ok(applied.startsWith('[mcp-write] "2026-06-09T00:00:00.000Z#1" tool="set_cell" session="grid-0-sheet-0"'));
		assert.ok(applied.includes('ops=1'));
		assert.ok(applied.includes('outcome=applied'));
		assert.ok(!applied.includes('detail='), 'no detail on applied');
		assert.ok(!/[^\x00-\x7F]/.test(applied), 'ASCII only');
		const failed = formatAuditLine({ ...base, outcome: 'failed', detail: '[formula_parse] bad' });
		assert.ok(failed.includes('outcome=failed'));
		assert.ok(failed.includes('detail="[formula_parse] bad"'));
	});

	test('auditField escapes non-ASCII + newlines so a hostile sheet name cannot forge a line (Codex MED)', () => {
		// A newline must NOT split the audit line; non-ASCII must be \uXXXX-escaped (ASCII-only hygiene).
		const escaped = auditField('Sheet\ninjected\u00e9\u4e2d');
		assert.ok(!escaped.includes('\n'), 'no raw newline');
		assert.ok(!/[^\x00-\x7F]/.test(escaped), 'ASCII only');
		assert.ok(escaped.includes('\\n'), 'newline escaped');
		assert.ok(escaped.includes('\\u00e9'), 'accented char escaped');
		assert.ok(escaped.includes('\\u4e2d'), 'CJK char escaped');
		// A full audit line built from a hostile sheet-name target stays single-line + ASCII.
		const line = formatAuditLine({
			timestamp: 't', tool: 'write_cells', sessionId: 's', undoLabel: 'MCP: \u00e9vil', opCount: 1,
			target: 'Bad\nName!A1', risk: 'r', outcome: 'failed', detail: 'boom\u0007',
		});
		assert.strictEqual(line.split('\n').length, 1, 'single line');
		assert.ok(!/[^\x00-\x7F]/.test(line), 'whole line ASCII');
	});

	test('auditField escapes a non-BMP (surrogate-pair) char as TWO \\uXXXX units (Codex LOW)', () => {
		// U+1F600 (grinning face) is a surrogate pair D83D DE00 in UTF-16; BOTH units must be escaped so
		// the output is ASCII -- a code-point walk would drop the low surrogate.
		const escaped = auditField('x\u{1F600}y');
		assert.ok(!/[^\x00-\x7F]/.test(escaped), 'ASCII only');
		assert.ok(escaped.includes('\\ud83d'), 'high surrogate escaped');
		assert.ok(escaped.includes('\\ude00'), 'low surrogate escaped');
	});
});

// --- prepare (grid resolution + risk wiring) --------------------------------------------------

suite('W3 MCP writes -- prepareSetCell / prepareWriteCells', () => {
	test('prepareSetCell resolves the focused sheet for a bare ref + builds the op', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }, { id: 1, name: 'S1', cells: [] }]);
		const ctx = makeCtx([grid(s, 1, 'grid-0-sheet-1')], 'grid-0-sheet-1');
		const prepared = prepareSetCell(ctx, { a1: 'B2', text: '9' });
		assert.strictEqual(prepared.ops.length, 1);
		assert.deepStrictEqual(prepared.ops[0].op, { kind: 'setValue', sheet: 1, row: 1, col: 1, value: { kind: 'number', number: 9 } });
		assert.strictEqual(prepared.undoLabel, 'MCP: set S1!B2');
		assert.strictEqual(prepared.risk.requiresConfirmation, false);
	});

	test('prepareSetCell flags a formula-overwrite via the live prior-cell read', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 }, formula: 'B1+1' }] }]);
		const ctx = makeCtx([grid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetCell(ctx, { a1: 'S0!A1', text: '5' });
		assert.ok(prepared.risk.reasons.includes('formula_overwrite'));
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
	});

	test('prepareWriteCells builds an atomic batch with a default + custom undo label', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([grid(s)], 'grid-0-sheet-0');
		const def = prepareWriteCells(ctx, { cells: [{ a1: 'S0!A1', text: '1' }, { a1: 'S0!A2', text: '2' }] });
		assert.strictEqual(def.ops.length, 2);
		assert.strictEqual(def.undoLabel, 'MCP: write S0!A1 + 1 more (2 cells)');
		const custom = prepareWriteCells(ctx, { cells: [{ a1: 'S0!A1', text: '1' }], undoLabel: 'seed returns' });
		assert.strictEqual(custom.undoLabel, 'MCP: seed returns');
	});

	test('prepareWriteCells rejects a non-array cells loud', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([grid(s)], 'grid-0-sheet-0');
		assert.throws(() => prepareWriteCells(ctx, { cells: 'nope' as unknown as never }), McpToolError);
	});

	test('prepare surfaces grid-resolution errors loud (no grid open)', () => {
		const ctx = makeCtx([], undefined);
		assert.throws(() => prepareSetCell(ctx, { a1: 'A1', text: '1' }), McpToolError);
		assert.throws(() => prepareWriteCells(ctx, { cells: [{ a1: 'A1', text: '1' }] }), McpToolError);
	});
});

// --- the write queue --------------------------------------------------------------------------

suite('W3 MCP writes -- per-session write queue', () => {
	test('serializes writes for the SAME session in FIFO order (no interleave)', async () => {
		const q = new WriteQueue<object>();
		const session = {};
		const order: string[] = [];
		const make = (label: string, delayMs: number) => async (): Promise<string> => {
			order.push(`${label}-start`);
			await new Promise((r) => setTimeout(r, delayMs));
			order.push(`${label}-end`);
			return label;
		};
		// Enqueue A (slow) before B (fast). B must NOT start until A ends.
		const a = q.enqueue(session, make('A', 30));
		const b = q.enqueue(session, make('B', 1));
		const [ra, rb] = await Promise.all([a, b]);
		assert.strictEqual(ra, 'A');
		assert.strictEqual(rb, 'B');
		assert.deepStrictEqual(order, ['A-start', 'A-end', 'B-start', 'B-end'], 'strict FIFO, no interleave');
	});

	test('different sessions run in parallel', async () => {
		const q = new WriteQueue<object>();
		const s1 = {};
		const s2 = {};
		const order: string[] = [];
		const make = (label: string, delayMs: number) => async (): Promise<void> => {
			order.push(`${label}-start`);
			await new Promise((r) => setTimeout(r, delayMs));
			order.push(`${label}-end`);
		};
		// s1 slow, s2 fast: s2 should finish while s1 is still running (interleaved starts).
		const p1 = q.enqueue(s1, make('S1', 30));
		const p2 = q.enqueue(s2, make('S2', 1));
		await Promise.all([p1, p2]);
		assert.strictEqual(order[0], 'S1-start');
		assert.ok(order.indexOf('S2-end') < order.indexOf('S1-end'), 'fast session finished first despite enqueuing second');
	});

	test('a failing run rejects ONLY its own promise and the chain advances', async () => {
		const q = new WriteQueue<object>();
		const session = {};
		const ran: string[] = [];
		const failing = q.enqueue(session, async () => { ran.push('fail'); throw new Error('boom'); });
		const after = q.enqueue(session, async () => { ran.push('after'); return 'ok'; });
		await assert.rejects(failing, /boom/);
		assert.strictEqual(await after, 'ok', 'the next run still executes after a failure (No-Fallbacks: not poisoned)');
		assert.deepStrictEqual(ran, ['fail', 'after']);
	});
});

// =================================================================================================
// FE-6 M (2026-06-12) -- new MCP write tools: set_style, set_number_format, structural insert/delete.
// =================================================================================================

function styleGrid(session: McpSessionPort, sheet = 0, id = 'grid-0-sheet-0'): McpTargetGrid {
	return { id, session, sheet };
}

// --- set_style: patch validation --------------------------------------------------------------

suite('FE-6 M -- set_style: validateStylePatch', () => {
	test('accepts a valid multi-field patch (fill/bold/align/borders)', () => {
		const patch = validateStylePatch({ fill: { r: 255, g: 0, b: 0 }, bold: true, align: 'center', borders: { top: { style: 'thin', color: { r: 0, g: 0, b: 0 } } } });
		assert.deepStrictEqual(patch.fill, { r: 255, g: 0, b: 0 });
		assert.strictEqual(patch.bold, true);
		assert.strictEqual(patch.align, 'center');
		assert.deepStrictEqual(patch.borders?.top, { style: 'thin', color: { r: 0, g: 0, b: 0 } });
	});

	test('rejects an EMPTY patch loud (must set at least one attribute)', () => {
		assert.throws(() => validateStylePatch({}), (e: unknown) => e instanceof McpToolError && /empty/.test(e.message));
	});

	test('rejects a malformed color / align / border-style loud (No-Fallbacks)', () => {
		assert.throws(() => validateStylePatch({ fill: { r: 300, g: 0, b: 0 } }), (e: unknown) => e instanceof McpToolError && /0\.\.=255/.test(e.message), 'channel over 255');
		assert.throws(() => validateStylePatch({ fill: { r: 1, g: 2 } }), McpToolError, 'missing channel');
		assert.throws(() => validateStylePatch({ align: 'middle' }), (e: unknown) => e instanceof McpToolError && /align must be/.test(e.message));
		assert.throws(() => validateStylePatch({ bold: 'yes' as unknown as boolean }), (e: unknown) => e instanceof McpToolError && /bold must be a boolean/.test(e.message));
		assert.throws(() => validateStylePatch({ borders: { top: { style: 'wiggly', color: { r: 0, g: 0, b: 0 } } } }), (e: unknown) => e instanceof McpToolError && /style must be one of/.test(e.message));
	});

	test('rejects a non-object patch loud', () => {
		assert.throws(() => validateStylePatch(null), McpToolError);
		assert.throws(() => validateStylePatch('bold'), McpToolError);
	});
});

// --- set_style: merge semantics ---------------------------------------------------------------

suite('FE-6 M -- set_style: currentCellStyleFromSnapshot + mergeStylePatch', () => {
	test('currentCellStyleFromSnapshot returns default for an unstyled cell', () => {
		const snap: WorkbookSnapshotJson = { sheets: [{ id: 0, name: 'S0', cells: [] }], formats: [], styles: [], dateSystem: 'Excel1900' };
		assert.deepStrictEqual(currentCellStyleFromSnapshot(snap, 0, 0, 0), { bold: false, italic: false });
	});

	test('currentCellStyleFromSnapshot resolves a cell styleId against snapshot.styles (a COPY)', () => {
		const id: StyleIdJson = { peer: 1n, counter: 5 };
		const snap: WorkbookSnapshotJson = {
			sheets: [{ id: 0, name: 'S0', cells: [{ row: 1, col: 2, value: { kind: 'number', number: 9 }, styleId: id }] }],
			formats: [],
			styles: [{ id, style: { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 } } }],
			dateSystem: 'Excel1900',
		};
		const style = currentCellStyleFromSnapshot(snap, 0, 1, 2);
		assert.strictEqual(style.bold, true);
		assert.deepStrictEqual(style.fill, { r: 1, g: 2, b: 3 });
		// Mutating the returned copy must NOT change the snapshot's StyleDef.
		style.fill!.r = 99;
		assert.strictEqual(snap.styles![0].style.fill!.r, 1, 'returned style is a deep-ish copy');
	});

	test('currentCellStyleFromSnapshot throws [invalid_state] for an unresolvable styleId (No-Fallbacks)', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{ id: 0, name: 'S0', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 }, styleId: { peer: 9n, counter: 9 } }] }],
			formats: [], styles: [], dateSystem: 'Excel1900',
		};
		assert.throws(() => currentCellStyleFromSnapshot(snap, 0, 0, 0), (e: unknown) => e instanceof McpToolError && /invalid_state/.test(e.message));
	});

	test('mergeStylePatch overwrites set fields + PRESERVES untouched ones', () => {
		const base: StyleJson = { bold: true, italic: false, fill: { r: 10, g: 20, b: 30 }, align: 'left' };
		// Patch only the fill: bold + align must survive (a partial patch never resets the cell).
		const merged = mergeStylePatch(base, { fill: { r: 255, g: 255, b: 255 } });
		assert.strictEqual(merged.bold, true, 'bold preserved');
		assert.strictEqual(merged.align, 'left', 'align preserved');
		assert.deepStrictEqual(merged.fill, { r: 255, g: 255, b: 255 }, 'fill overwritten');
	});

	test('styleJsonKey: equal styles -> equal keys; differing styles -> differing keys', () => {
		const a: StyleJson = { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 } };
		const b: StyleJson = { bold: true, italic: false, fill: { r: 1, g: 2, b: 3 } };
		const c: StyleJson = { bold: false, italic: false, fill: { r: 1, g: 2, b: 3 } };
		assert.strictEqual(styleJsonKey(a), styleJsonKey(b));
		assert.notStrictEqual(styleJsonKey(a), styleJsonKey(c));
	});

	// FE-7 (2026-06-13) regression: the toolbar can now set underline/strike/text-color. An MCP set_style
	// read-modify-write MUST preserve those (the patch shape does not set them yet -- FE-7.1 -- but it must
	// never STRIP them). Caught by the FE-7 re-audit (silent data-loss class).
	test('FE-7: mergeStylePatch PRESERVES base underline/strike/textColor through a fill-only patch', () => {
		const base: StyleJson = { bold: false, italic: false, underline: true, strike: true, textColor: { r: 9, g: 8, b: 7 }, fill: { r: 1, g: 1, b: 1 } };
		const merged = mergeStylePatch(base, { fill: { r: 255, g: 255, b: 255 } });
		assert.strictEqual(merged.underline, true, 'underline survives an MCP fill patch');
		assert.strictEqual(merged.strike, true, 'strike survives');
		assert.deepStrictEqual(merged.textColor, { r: 9, g: 8, b: 7 }, 'text color survives');
		assert.deepStrictEqual(merged.fill, { r: 255, g: 255, b: 255 }, 'fill overwritten');
	});

	test('FE-7: currentCellStyleFromSnapshot carries underline/strike/textColor out of the snapshot (a copy)', () => {
		const id: StyleIdJson = { peer: 2n, counter: 7 };
		const snap: WorkbookSnapshotJson = {
			sheets: [{ id: 0, name: 'S0', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 }, styleId: id }] }],
			formats: [],
			styles: [{ id, style: { bold: false, italic: false, underline: true, strike: true, textColor: { r: 4, g: 5, b: 6 } } }],
			dateSystem: 'Excel1900',
		};
		const style = currentCellStyleFromSnapshot(snap, 0, 0, 0);
		assert.strictEqual(style.underline, true);
		assert.strictEqual(style.strike, true);
		assert.deepStrictEqual(style.textColor, { r: 4, g: 5, b: 6 });
		style.textColor!.r = 99;
		assert.strictEqual(snap.styles![0].style.textColor!.r, 4, 'textColor is a copy, not an alias');
	});

	test('FE-7: styleJsonKey distinguishes underline/strike/textColor (no wrong-render collision)', () => {
		const base: StyleJson = { bold: false, italic: false };
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: false, italic: false, underline: true }));
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: false, italic: false, strike: true }));
		assert.notStrictEqual(styleJsonKey(base), styleJsonKey({ bold: false, italic: false, textColor: { r: 1, g: 1, b: 1 } }));
		assert.notStrictEqual(
			styleJsonKey({ bold: false, italic: false, textColor: { r: 1, g: 2, b: 3 } }),
			styleJsonKey({ bold: false, italic: false, textColor: { r: 3, g: 2, b: 1 } }),
		);
	});
});

// --- set_style: prepare + commit (op-building + interning) -------------------------------------

suite('FE-6 M -- set_style: prepareSetStyle', () => {
	test('builds setStyle placeholder ops over a range + a large target flags `large` only', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		// 5x10 = 50 cells -> the large threshold fires (and ONLY large, never formula_overwrite/clear).
		const prepared = prepareSetStyle(ctx, { range: 'S0!A1:E10', style: { bold: true } });
		assert.strictEqual(prepared.ops.length, 50);
		assert.ok(prepared.ops.every((o) => o.op.kind === 'setStyle' && o.isStyleOrFormat === true));
		assert.deepStrictEqual(prepared.risk.reasons, ['large']);
		assert.strictEqual(prepared.target, 'S0!A1 + 49 more (50 cells)');
		assert.strictEqual(prepared.undoLabel, 'MCP: style S0!A1 + 49 more (50 cells)');
	});

	test('styling a cell that holds a FORMULA is NOT flagged formula_overwrite (style is visual-only)', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 }, formula: 'B1+1' }] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetStyle(ctx, { a1: 'S0!A1', style: { fill: { r: 255, g: 0, b: 0 } } });
		assert.deepStrictEqual(prepared.risk.reasons, [], 'a 1-cell style over a formula cell carries NO risk reason');
		assert.strictEqual(prepared.risk.requiresConfirmation, false);
	});

	test('commit interns the merged style + emits a setStyle batch carrying the real interned id', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetStyle(ctx, { a1: 'S0!A1', style: { bold: true } });
		const out = prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 1);
		assert.strictEqual(s.registeredStyles.length, 1);
		assert.strictEqual(s.registeredStyles[0].bold, true);
		assert.strictEqual(s.batched.length, 1);
		const op = s.batched[0].ops[0];
		assert.strictEqual(op.kind, 'setStyle');
		assert.ok(op.style !== undefined && op.style.counter >= 1, 'the batch op carries the real interned styleId, not the placeholder');
		assert.notStrictEqual(op.style!.counter, 0, 'NOT the {peer:0,counter:0} placeholder');
	});

	test('commit DEDUPES identical merged styles -> registerStyle called ONCE for a uniform selection', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetStyle(ctx, { range: 'S0!A1:A4', style: { italic: true } });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		// 4 cells, all start unstyled -> all merge to the SAME style -> ONE registerStyle, 4 setStyle ops.
		assert.strictEqual(s.registeredStyles.length, 1, 'deduped to one intern');
		assert.strictEqual(s.batched[0].ops.length, 4);
	});

	test('commit MERGE preserves an existing attribute when patching another (read-modify-write)', () => {
		// A1 already bold (styleId resolvable in the snapshot); patching fill must keep bold.
		const id: StyleIdJson = { peer: 1n, counter: 1 };
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 }, styleId: id }] }]);
		// Seed the registry so the snapshot resolves A1's styleId to a bold style.
		s.registerStyle({ bold: true, italic: false });
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetStyle(ctx, { a1: 'S0!A1', style: { fill: { r: 9, g: 9, b: 9 } } });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		const last = s.registeredStyles[s.registeredStyles.length - 1];
		assert.strictEqual(last.bold, true, 'bold preserved through the fill patch');
		assert.deepStrictEqual(last.fill, { r: 9, g: 9, b: 9 }, 'fill applied');
	});

	test('rejects passing both a1 AND range (or neither) loud', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		assert.throws(() => prepareSetStyle(ctx, { a1: 'A1', range: 'A1:B2', style: { bold: true } }), (e: unknown) => e instanceof McpToolError && /EXACTLY one/.test(e.message));
		assert.throws(() => prepareSetStyle(ctx, { style: { bold: true } }), (e: unknown) => e instanceof McpToolError && /EXACTLY one/.test(e.message));
	});
});

// --- set_number_format: prepare + commit ------------------------------------------------------

suite('FE-6 M -- set_number_format: prepareSetNumberFormat', () => {
	test('builds setFormat placeholder ops + risk is `large` only', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetNumberFormat(ctx, { range: 'S0!A1:A60', format: '0.00%' });
		assert.strictEqual(prepared.ops.length, 60);
		assert.ok(prepared.ops.every((o) => o.op.kind === 'setFormat' && o.isStyleOrFormat === true));
		assert.deepStrictEqual(prepared.risk.reasons, ['large']);
	});

	test('formatting a FORMULA cell is NOT flagged formula_overwrite', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 }, formula: 'B1+1' }] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetNumberFormat(ctx, { a1: 'S0!A1', format: '0.00' });
		assert.deepStrictEqual(prepared.risk.reasons, []);
	});

	test('commit registers the format ONCE + emits a setFormat batch with the interned id', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		const prepared = prepareSetNumberFormat(ctx, { range: 'S0!A1:A3', format: '$#,##0.00' });
		const out = prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 3);
		assert.deepStrictEqual(s.registeredFormats, ['$#,##0.00'], 'format interned exactly once');
		assert.strictEqual(s.batched[0].ops.length, 3);
		assert.ok(s.batched[0].ops.every((o) => o.kind === 'setFormat' && o.format !== undefined));
	});

	test('rejects an empty / over-length format string loud', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }]);
		const ctx = makeCtx([styleGrid(s)], 'grid-0-sheet-0');
		assert.throws(() => prepareSetNumberFormat(ctx, { a1: 'S0!A1', format: '' }), (e: unknown) => e instanceof McpToolError && /non-empty/.test(e.message));
		assert.throws(() => prepareSetNumberFormat(ctx, { a1: 'S0!A1', format: 'x'.repeat(600) }), (e: unknown) => e instanceof McpToolError && /over the/.test(e.message));
	});
});

// --- structural edits: the `structural` risk ALWAYS fires + commit calls the direct napi --------

suite('FE-6 M -- structural risk reason', () => {
	test('classifyWriteRisk with { structural: true } ALWAYS includes `structural` (empty ops)', () => {
		const verdict = classifyWriteRisk([], noPrior, { structural: true });
		assert.deepStrictEqual(verdict.reasons, ['structural']);
		assert.strictEqual(verdict.requiresConfirmation, true);
		assert.strictEqual(verdict.summary, 'structural edit (insert/delete rows or columns)');
	});

	test('without the structural flag, empty ops carry no risk (the non-structural baseline)', () => {
		assert.deepStrictEqual(classifyWriteRisk([], noPrior).reasons, []);
	});

	test('summarizeRisk renders a structural-only edit without a misleading "0 cell(s)"', () => {
		assert.strictEqual(summarizeRisk(0, ['structural'], true), 'structural edit (insert/delete rows or columns)');
		assert.strictEqual(summarizeRisk(0, [], true), 'structural edit, no elevated risk');
	});
});

suite('FE-6 M -- prepareInsertStructural / prepareDeleteStructural', () => {
	function ctxOf(): { s: FakeWriteSession; ctx: McpHostContext } {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }, { id: 7, name: 'Data', cells: [] }]);
		return { s, ctx: makeCtx([styleGrid(s, 7, 'grid-0-sheet-7')], 'grid-0-sheet-7') };
	}

	test('insert_rows ALWAYS carries the structural risk + empty ops + an axis/range target', () => {
		const { ctx } = ctxOf();
		const prepared = prepareInsertStructural(ctx, 'insert_rows', { index: 5, count: 3 });
		assert.deepStrictEqual(prepared.ops, []);
		assert.strictEqual(prepared.structural, true);
		assert.deepStrictEqual(prepared.risk.reasons, ['structural']);
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		assert.strictEqual(prepared.target, 'Data: insert 3 row(s) at row 5');
	});

	test('insert_rows commit calls insertRows on the resolved sheet (direct napi, not a batch)', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareInsertStructural(ctx, 'insert_rows', { index: 5, count: 3 });
		const out = prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 1);
		assert.deepStrictEqual(s.structuralCalls, [{ kind: 'insertRows', sheet: 7, a: 5, b: 3 }]);
		assert.strictEqual(s.batched.length, 0, 'structural edits do NOT go through batch');
	});

	test('insert_columns commit calls insertColumns', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareInsertStructural(ctx, 'insert_columns', { index: 2, count: 1 });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.structuralCalls, [{ kind: 'insertColumns', sheet: 7, a: 2, b: 1 }]);
		assert.strictEqual(prepared.target, 'Data: insert 1 column(s) at column 2');
	});

	test('delete_rows uses INCLUSIVE [start,end] + commit calls deleteRows', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareDeleteStructural(ctx, 'delete_rows', { start: 4, end: 6 });
		assert.deepStrictEqual(prepared.risk.reasons, ['structural']);
		assert.strictEqual(prepared.target, 'Data: delete 3 row(s) [4..6]');
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.structuralCalls, [{ kind: 'deleteRows', sheet: 7, a: 4, b: 6 }]);
	});

	test('delete_columns commit calls deleteColumns with inclusive bounds', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareDeleteStructural(ctx, 'delete_columns', { start: 1, end: 1 });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.structuralCalls, [{ kind: 'deleteColumns', sheet: 7, a: 1, b: 1 }]);
		assert.strictEqual(prepared.target, 'Data: delete 1 column(s) [1..1]');
	});

	test('insert rejects a non-integer/negative index or count < 1 loud (No-Fallbacks)', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareInsertStructural(ctx, 'insert_rows', { index: -1, count: 1 }), (e: unknown) => e instanceof McpToolError && /non-negative safe integer/.test(e.message));
		assert.throws(() => prepareInsertStructural(ctx, 'insert_rows', { index: 0, count: 0 }), (e: unknown) => e instanceof McpToolError && />= 1/.test(e.message));
		assert.throws(() => prepareInsertStructural(ctx, 'insert_rows', { index: 1.5, count: 1 }), McpToolError, 'non-integer index');
	});

	test('delete rejects an inverted [start,end] loud', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDeleteStructural(ctx, 'delete_rows', { start: 6, end: 4 }), (e: unknown) => e instanceof McpToolError && /before start/.test(e.message));
	});

	// --- Codex MED: structural count/range numeric-boundary guards ----------------------------
	// `count`/`index`/`start`/`end` must be SAFE integers within the axis extent. Without these the
	// 2^32+1 case (4,294,967,297) reaches the napi `count` (a u32) and overflows/coerces silently.

	test('insert rejects an UNSAFE count (2^32+1) loud (No-Fallbacks, numeric boundary)', () => {
		const { ctx } = ctxOf();
		// 2^32 + 1 = 4,294,967,297 -- a SAFE integer but FAR over the axis extent; it must be rejected
		// (it is also over the per-index push-past-the-axis bound, so the upper-bound branch fires).
		assert.throws(
			() => prepareInsertStructural(ctx, 'insert_rows', { index: 0, count: 2 ** 32 + 1 }),
			(e: unknown) => e instanceof McpToolError && /push past the sheet extent/.test(e.message),
		);
		// A genuinely NON-safe integer count (> 2^53) is rejected by the safe-integer guard itself.
		assert.throws(
			() => prepareInsertStructural(ctx, 'insert_rows', { index: 0, count: 2 ** 53 + 2 }),
			(e: unknown) => e instanceof McpToolError && /safe integer/.test(e.message),
		);
	});

	test('insert rejects count > axisMax - index (cannot push existing content past the axis)', () => {
		const { ctx } = ctxOf();
		// Rows: axisMax = A1_MAX_ROWS (count; valid indices [0, A1_MAX_ROWS)). At index 10 the max
		// insertable is A1_MAX_ROWS - 10; one more pushes past the axis -> rejected.
		assert.throws(
			() => prepareInsertStructural(ctx, 'insert_rows', { index: 10, count: A1_MAX_ROWS - 10 + 1 }),
			(e: unknown) => e instanceof McpToolError && /push past the sheet extent/.test(e.message),
		);
		// Columns axis uses the smaller A1_MAX_COLS bound.
		assert.throws(
			() => prepareInsertStructural(ctx, 'insert_columns', { index: 5, count: A1_MAX_COLS - 5 + 1 }),
			(e: unknown) => e instanceof McpToolError && /push past the sheet extent/.test(e.message),
		);
	});

	test('insert at the EXACT boundary (count === axisMax - index) still prepares (in-bounds)', () => {
		const { s, ctx } = ctxOf();
		// count = A1_MAX_ROWS - index exactly fills the [index, axisMax) band -> the largest legal insert.
		const prepared = prepareInsertStructural(ctx, 'insert_rows', { index: 10, count: A1_MAX_ROWS - 10 });
		assert.deepStrictEqual(prepared.risk.reasons, ['structural']);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.structuralCalls, [{ kind: 'insertRows', sheet: 7, a: 10, b: A1_MAX_ROWS - 10 }]);
	});

	test('a small in-bounds insert still prepares + commits (the happy path is unaffected)', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareInsertStructural(ctx, 'insert_rows', { index: 5, count: 3 });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.structuralCalls, [{ kind: 'insertRows', sheet: 7, a: 5, b: 3 }]);
	});

	test('delete rejects end >= axisMax (out of extent), a negative start, and an UNSAFE bound loud', () => {
		const { ctx } = ctxOf();
		// end at A1_MAX_ROWS is index A1_MAX_ROWS (one past the last valid index A1_MAX_ROWS-1) -> rejected.
		assert.throws(
			() => prepareDeleteStructural(ctx, 'delete_rows', { start: 0, end: A1_MAX_ROWS }),
			(e: unknown) => e instanceof McpToolError && /outside the sheet extent/.test(e.message),
		);
		// A negative start is rejected by the non-negative safe-integer guard.
		assert.throws(
			() => prepareDeleteStructural(ctx, 'delete_rows', { start: -1, end: 5 }),
			(e: unknown) => e instanceof McpToolError && /non-negative safe integer/.test(e.message),
		);
		// A non-safe-integer bound is rejected (2^53+1 loses precision as a JS number).
		assert.throws(
			() => prepareDeleteStructural(ctx, 'delete_rows', { start: 0, end: 2 ** 53 + 1 }),
			(e: unknown) => e instanceof McpToolError && /non-negative safe integer/.test(e.message),
		);
		// Columns: end at A1_MAX_COLS is out of the (smaller) column extent.
		assert.throws(
			() => prepareDeleteStructural(ctx, 'delete_columns', { start: 0, end: A1_MAX_COLS }),
			(e: unknown) => e instanceof McpToolError && /outside the sheet extent/.test(e.message),
		);
	});

	test('insert rejects an UNSAFE / out-of-extent index loud (the index guard, not just count)', () => {
		const { ctx } = ctxOf();
		// index at A1_MAX_ROWS is one past the last valid index -> rejected by the extent guard.
		assert.throws(
			() => prepareInsertStructural(ctx, 'insert_rows', { index: A1_MAX_ROWS, count: 1 }),
			(e: unknown) => e instanceof McpToolError && /outside the sheet extent/.test(e.message),
		);
	});

	test('structural resolves the sheet arg over the focused sheet + rejects an unknown sheet loud', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareInsertStructural(ctx, 'insert_rows', { sheet: 'S0', index: 0, count: 1 });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(s.structuralCalls[0].sheet, 0, 'sheet arg "S0" used over the focused Data sheet');
		assert.throws(() => prepareInsertStructural(ctx, 'insert_rows', { sheet: 'Ghost', index: 0, count: 1 }), McpToolError);
	});

	test('structural surfaces a no-grid-open error loud', () => {
		const ctx = makeCtx([], undefined);
		assert.throws(() => prepareInsertStructural(ctx, 'insert_rows', { index: 0, count: 1 }), McpToolError);
		assert.throws(() => prepareDeleteStructural(ctx, 'delete_columns', { start: 0, end: 0 }), McpToolError);
	});
});

// --- the uncovered-reason refuse interplay with `structural` -----------------------------------

suite('FE-6 M -- structural risk is confirmable (uncovered-reason set)', () => {
	test('a confirmed `structural` reason leaves NO uncovered reason (the modal covers it)', () => {
		// Mirrors the host: the modal is shown for { structural }, the operator OKs, confirmedReasons =
		// {structural}; the final re-classify also yields {structural}; nothing is uncovered -> the write
		// proceeds (the structural reason is in the confirmable set, not a hard refuse).
		const finalReasons = classifyWriteRisk([], noPrior, { structural: true }).reasons;
		const confirmed = new Set(finalReasons);
		const uncovered = finalReasons.filter((r) => !confirmed.has(r));
		assert.deepStrictEqual(uncovered, [], 'structural is covered by the modal it always triggers');
	});
});

// --- Wave L: metadata writes (named ranges / sheets / tables / undo-redo) ----------------------

suite('Wave L -- prepare metadata writes', () => {
	function ctxOf(names: NamedRangeJson[] = []): { s: FakeWriteSession; ctx: McpHostContext } {
		const s = new FakeWriteSession([{ id: 0, name: 'S0', cells: [] }, { id: 7, name: 'Data', cells: [] }]);
		s.names = names;
		return { s, ctx: makeCtx([styleGrid(s, 7, 'grid-0-sheet-7')], 'grid-0-sheet-7') };
	}

	// --- define_named_range ---
	test('define_named_range: a FRESH name carries NO risk (no modal) + commit calls setName (not batch)', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareDefineNamedRange(ctx, { name: 'returns', range: 'B2:B100' });
		assert.deepStrictEqual(prepared.ops, []);
		assert.deepStrictEqual(prepared.risk.reasons, []);
		assert.strictEqual(prepared.risk.requiresConfirmation, false);
		const out = prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 1);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'setName', detail: 'returns@s7:1,1-99,1' }], 'range resolves against the focused sheet 7');
		assert.strictEqual(s.batched.length, 0, 'a name define is NOT a cell batch');
	});

	test('define_named_range: REPLACING an existing workbook-scoped name -> rebind_name risk + modal', () => {
		const existing: NamedRangeJson[] = [{ name: 'RETURNS', target: { kind: 'range', range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } } }];
		const { ctx } = ctxOf(existing);
		const prepared = prepareDefineNamedRange(ctx, { name: 'returns', range: 'S0!B2:B100' });
		assert.deepStrictEqual(prepared.risk.reasons, ['rebind_name'], 'case-insensitive name match (engine canonicalizes upper-case)');
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		assert.ok(/redefines existing name "returns"/.test(prepared.risk.summary), prepared.risk.summary);
	});

	test('define_named_range: a purely SHEET-scoped collision is NOT a workbook rebind (no modal)', () => {
		const sheetScoped: NamedRangeJson[] = [{ name: 'RETURNS', target: { kind: 'range', range: { sheet: 7, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }, scope: 7 }];
		const { ctx } = ctxOf(sheetScoped);
		const prepared = prepareDefineNamedRange(ctx, { name: 'returns', range: 'S0!B2:B100' });
		assert.deepStrictEqual(prepared.risk.reasons, [], 'a workbook-scoped define over a sheet-scoped name is additive');
	});

	test('define_named_range: empty name / empty range reject loud (No-Fallbacks)', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineNamedRange(ctx, { name: '   ', range: 'B2:B100' }), (e: unknown) => e instanceof McpToolError && /non-empty/.test(e.message));
		assert.throws(() => prepareDefineNamedRange(ctx, { name: 'ret', range: '' }), (e: unknown) => e instanceof McpToolError && /non-empty A1 range/.test(e.message));
	});

	// --- delete_named_range ---
	test('delete_named_range: DESTRUCTIVE (always modal) + commit calls deleteName with the agent name', () => {
		const existing: NamedRangeJson[] = [{ name: 'RET', target: { kind: 'range', range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } } }];
		const { s, ctx } = ctxOf(existing);
		const prepared = prepareDeleteNamedRange(ctx, { name: 'ret' });
		assert.deepStrictEqual(prepared.risk.reasons, ['destructive_metadata']);
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'deleteName', detail: 'ret' }]);
	});

	test('delete_named_range: a name absent at the given scope -> loud [unknown_name] (not a no-op modal)', () => {
		const { ctx } = ctxOf([]);
		assert.throws(() => prepareDeleteNamedRange(ctx, { name: 'ghost' }), (e: unknown) => e instanceof McpToolError && /unknown_name/.test(e.message));
	});

	test('delete_named_range: a sheet-scoped delete validates the scope sheet + that exact scope', () => {
		const sheetScoped: NamedRangeJson[] = [{ name: 'LOCAL', target: { kind: 'range', range: { sheet: 7, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }, scope: 7 }];
		const { s, ctx } = ctxOf(sheetScoped);
		const prepared = prepareDeleteNamedRange(ctx, { name: 'local', scope: 7 });
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'deleteName', detail: 'local#7' }]);
		assert.throws(() => prepareDeleteNamedRange(ctx, { name: 'local', scope: 99 }), (e: unknown) => e instanceof McpToolError && /unknown_sheet/.test(e.message));
		assert.throws(() => prepareDeleteNamedRange(ctx, { name: 'local' }), (e: unknown) => e instanceof McpToolError && /unknown_name/.test(e.message), 'a workbook-scoped delete does NOT match a sheet-scoped name');
		assert.throws(() => prepareDeleteNamedRange(ctx, { name: 'local', scope: -1 }), (e: unknown) => e instanceof McpToolError && /non-negative safe-integer/.test(e.message));
	});

	// --- add_sheet ---
	test('add_sheet: additive (no modal) + commit calls addSheet with the IDE default chunk size', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareAddSheet(ctx, { name: 'Returns' });
		assert.deepStrictEqual(prepared.risk.reasons, []);
		assert.strictEqual(prepared.risk.requiresConfirmation, false);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'addSheet', detail: 'Returns:1000' }]);
		assert.ok(/adds sheet "Returns", no elevated risk/.test(prepared.risk.summary), prepared.risk.summary);
	});

	test('add_sheet: an empty name rejects loud', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareAddSheet(ctx, { name: '' }), (e: unknown) => e instanceof McpToolError && /non-empty/.test(e.message));
	});

	// --- rename_sheet ---
	test('rename_sheet: no modal + commit calls renameSheet by resolved id', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareRenameSheet(ctx, { sheet: 'Data', newName: 'Trades' });
		assert.deepStrictEqual(prepared.risk.reasons, []);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'renameSheet', detail: '7->Trades' }]);
		assert.ok(/renames sheet "Data" to "Trades"/.test(prepared.target));
	});

	test('rename_sheet: a missing sheet / unknown sheet / empty newName reject loud', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareRenameSheet(ctx, { sheet: undefined as unknown as number, newName: 'X' }), (e: unknown) => e instanceof McpToolError && /required/.test(e.message));
		assert.throws(() => prepareRenameSheet(ctx, { sheet: 'Ghost', newName: 'X' }), (e: unknown) => e instanceof McpToolError && /unknown_sheet/.test(e.message));
		assert.throws(() => prepareRenameSheet(ctx, { sheet: 'Data', newName: '  ' }), (e: unknown) => e instanceof McpToolError && /non-empty/.test(e.message));
	});

	// --- delete_sheet ---
	test('delete_sheet: DESTRUCTIVE (always modal) + commit tombstones by id', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareDeleteSheet(ctx, { sheet: 7 });
		assert.deepStrictEqual(prepared.risk.reasons, ['destructive_metadata']);
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		assert.ok(/deletes sheet "Data"/.test(prepared.risk.summary) && !/0 cell/.test(prepared.risk.summary), prepared.risk.summary);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'deleteSheet', detail: '7' }]);
	});

	test('delete_sheet: a missing / unknown sheet rejects loud', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDeleteSheet(ctx, { sheet: undefined as unknown as number }), (e: unknown) => e instanceof McpToolError && /required/.test(e.message));
		assert.throws(() => prepareDeleteSheet(ctx, { sheet: 'Ghost' }), (e: unknown) => e instanceof McpToolError && /unknown_sheet/.test(e.message));
	});

	// --- define_table ---
	test('define_table: additive (no modal) + commit calls createTable with the validated spec', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareDefineTable(ctx, { name: 'Trades', sheet: 'Data', topRow: 0, topCol: 0, rows: 10, cols: 2, hasHeader: true, columnNames: ['Date', 'Px'] });
		assert.deepStrictEqual(prepared.risk.reasons, []);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'createTable', detail: 'Trades@s7:0,0 10x2 cols=Date|Px' }]);
	});

	test('define_table: columnNames length MUST equal cols', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 5, cols: 2, columnNames: ['only one'] }), (e: unknown) => e instanceof McpToolError && /must match/.test(e.message));
	});

	test('define_table: bad geometry rejects loud (rows < 1, negative anchor, non-array columnNames, non-boolean flag)', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 0, cols: 1, columnNames: ['c'] }), (e: unknown) => e instanceof McpToolError && />= 1/.test(e.message));
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: -1, topCol: 0, rows: 1, cols: 1, columnNames: ['c'] }), (e: unknown) => e instanceof McpToolError && /non-negative/.test(e.message));
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 1, cols: 1, columnNames: 'nope' as unknown as string[] }), (e: unknown) => e instanceof McpToolError && /array of strings/.test(e.message));
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 1, cols: 1, hasHeader: 'yes' as unknown as boolean, columnNames: ['c'] }), (e: unknown) => e instanceof McpToolError && /hasHeader must be a boolean/.test(e.message));
	});

	// --- delete_table ---
	test('delete_table: DESTRUCTIVE (always modal) + commit calls dropTable', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareDeleteTable(ctx, { name: 'Trades' });
		assert.deepStrictEqual(prepared.risk.reasons, ['destructive_metadata']);
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'dropTable', detail: 'Trades' }]);
	});

	// --- undo / redo (audit fold: ALWAYS confirm the shared stack; real UndoRedoResultJson return shape) ---
	test('undo: ALWAYS confirms (shared stack may revert user work) + commit calls undo; consumed -> applied 1', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareUndoRedo(ctx, 'undo', {});
		assert.deepStrictEqual(prepared.risk.reasons, ['destructive_metadata']);
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		const out = prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 1);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'undo', detail: '' }]);
	});

	test('undo: an EMPTY stack returns applied 0 -- reads UndoRedoResultJson.consumed (the object is always truthy)', () => {
		const { s, ctx } = ctxOf();
		s.undoConsumed = false; // the fake returns { consumed: false, version } -- a bare `obj ? 1 : 0` would wrongly be 1
		const out = prepareUndoRedo(ctx, 'undo', {}).commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 0);
	});

	test('redo: confirms + commit calls redo; the consumed flag drives applied', () => {
		const { s, ctx } = ctxOf();
		const prepared = prepareUndoRedo(ctx, 'redo', {});
		assert.strictEqual(prepared.risk.requiresConfirmation, true);
		const out = prepared.commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(out.applied, 1);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'redo', detail: '' }]);
	});

	// --- audit folds: TOCTOU rebind re-check / ambiguous-sheet / last-sheet / table+column validation ---
	test('define_named_range: commit RE-CHECKS live names -> a fresh define that became a rebind refuses LOUD', () => {
		const { s, ctx } = ctxOf(); // no names at prepare -> fresh, no modal
		const prepared = prepareDefineNamedRange(ctx, { name: 'returns', range: 'B2:B100' });
		assert.deepStrictEqual(prepared.risk.reasons, [], 'fresh at prepare -> no modal');
		// the name is created (workbook-scoped) BETWEEN prepare and commit:
		s.names = [{ name: 'RETURNS', target: { kind: 'range', range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 } } }];
		assert.throws(() => prepared.commit!(s as unknown as McpWriteSessionPort), (e: unknown) => e instanceof McpToolError && /risk_escalated/.test(e.message));
		assert.strictEqual(s.metadataCalls.length, 0, 'setName is NOT called when the rebind escalated');
	});

	test('define_named_range: a still-fresh name at commit applies normally (no escalation)', () => {
		const { s, ctx } = ctxOf();
		prepareDefineNamedRange(ctx, { name: 'returns', range: 'B2:B100' }).commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'setName', detail: 'returns@s7:1,1-99,1' }]);
	});

	test('define_named_range: a sheet-qualified range conflicting with the sheet arg -> loud [ambiguous_sheet]', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineNamedRange(ctx, { name: 'x', range: 'S0!B2:B100', sheet: 'Data' }), (e: unknown) => e instanceof McpToolError && /ambiguous_sheet/.test(e.message));
	});

	test('delete_sheet: refuses to delete the LAST live sheet (D4 invariant) -> loud [last_sheet]', () => {
		const s = new FakeWriteSession([{ id: 0, name: 'Only', cells: [] }]);
		const ctx = makeCtx([styleGrid(s, 0, 'grid-0-sheet-0')], 'grid-0-sheet-0');
		assert.throws(() => prepareDeleteSheet(ctx, { sheet: 0 }), (e: unknown) => e instanceof McpToolError && /last_sheet/.test(e.message));
	});

	test('delete_sheet: commit RE-CHECKS live sheets -> a delete that would strand the workbook (sheets removed during the modal) refuses LOUD', () => {
		const sheetsArr = [{ id: 0, name: 'S0', cells: [] }, { id: 7, name: 'Data', cells: [] }];
		const s = new FakeWriteSession(sheetsArr);
		const ctx = makeCtx([styleGrid(s, 7, 'grid-0-sheet-7')], 'grid-0-sheet-7');
		const prepared = prepareDeleteSheet(ctx, { sheet: 7 }); // 2 sheets -> passes the prepare-time guard
		sheetsArr.splice(0, 1); // a GUI delete of S0 during the modal -> only sheet 7 remains live
		assert.throws(() => prepared.commit!(s as unknown as McpWriteSessionPort), (e: unknown) => e instanceof McpToolError && /last_sheet/.test(e.message));
		assert.strictEqual(s.metadataCalls.length, 0, 'deleteSheet is NOT called when it would strand the workbook');
	});

	test('delete_sheet: commit refuses LOUD if the TARGET sheet vanished since prepare', () => {
		const sheetsArr = [{ id: 0, name: 'S0', cells: [] }, { id: 7, name: 'Data', cells: [] }, { id: 8, name: 'X', cells: [] }];
		const s = new FakeWriteSession(sheetsArr);
		const ctx = makeCtx([styleGrid(s, 7, 'grid-0-sheet-7')], 'grid-0-sheet-7');
		const prepared = prepareDeleteSheet(ctx, { sheet: 7 });
		sheetsArr.splice(1, 1); // sheet 7 (the target) deleted during the modal -> [0, 8] remain (2 sheets)
		assert.throws(() => prepared.commit!(s as unknown as McpWriteSessionPort), (e: unknown) => e instanceof McpToolError && /unknown_sheet/.test(e.message));
	});

	test('define_table: a cell-ref-shaped TABLE name is rejected (table-identifier rule)', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineTable(ctx, { name: 'Q3', topRow: 0, topCol: 0, rows: 2, cols: 1, columnNames: ['c'] }), (e: unknown) => e instanceof McpToolError && /invalid table name/.test(e.message));
	});

	test('define_table: a column name with edge-whitespace / control char is rejected (structured-ref safety)', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 2, cols: 1, columnNames: [' Padded'] }), (e: unknown) => e instanceof McpToolError && /columnNames\[0\] invalid/.test(e.message));
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 2, cols: 1, columnNames: ['a\u0001b'] }), (e: unknown) => e instanceof McpToolError && /columnNames\[0\] invalid/.test(e.message));
	});

	test('define_table: ASCII-case-variant columns ("Px"/"px") reject; non-ASCII case pairs ("\u00c5"/"\u00e5") PASS (no over-reject)', () => {
		const { ctx } = ctxOf();
		assert.throws(() => prepareDefineTable(ctx, { name: 'T', topRow: 0, topCol: 0, rows: 2, cols: 2, columnNames: ['Px', 'px'] }), (e: unknown) => e instanceof McpToolError && /duplicate column name/.test(e.message));
		// the engine folds ASCII case ONLY -> "\u00c5" and "\u00e5" are DISTINCT columns -> a valid table (no over-reject):
		const { s, ctx: ctx2 } = ctxOf();
		prepareDefineTable(ctx2, { name: 'Tbl', sheet: 'Data', topRow: 0, topCol: 0, rows: 2, cols: 2, columnNames: ['\u00c5', '\u00e5'] }).commit!(s as unknown as McpWriteSessionPort);
		assert.strictEqual(s.metadataCalls.length, 1, '\u00c5 and \u00e5 are distinct under the engine ASCII fold -> table created');
	});

	test('define_table: OOXML-parity column names (internal space, digit-leading) still pass', () => {
		const { s, ctx } = ctxOf();
		prepareDefineTable(ctx, { name: 'Trades', sheet: 'Data', topRow: 0, topCol: 0, rows: 10, cols: 2, columnNames: ['Order Date', '2026 PnL'] }).commit!(s as unknown as McpWriteSessionPort);
		assert.deepStrictEqual(s.metadataCalls, [{ op: 'createTable', detail: 'Trades@s7:0,0 10x2 cols=Order Date|2026 PnL' }]);
	});

	// --- the metadata risk is confirmable (mirrors the host uncovered-reason interplay) ---
	test('a confirmed metadata reason leaves NO uncovered reason (the modal covers the destructive write)', () => {
		const final = classifyWriteRisk([], noPrior, { metadata: { destructive: true, label: 'deletes sheet "Data"' } }).reasons;
		const confirmed = new Set(final);
		const uncovered = final.filter((r) => !confirmed.has(r));
		assert.deepStrictEqual(final, ['destructive_metadata']);
		assert.deepStrictEqual(uncovered, [], 'destructive_metadata is covered by the modal it always triggers');
	});

	test('the metadata summary never reads a misleading "0 cell(s)"', () => {
		assert.ok(!/cell/.test(summarizeRisk(0, ['destructive_metadata'], false, 'deletes sheet "Data"')));
		assert.ok(!/cell/.test(summarizeRisk(0, [], false, 'adds sheet "X"')));
		// rebind_name carries its label and no cell count
		const rebind = summarizeRisk(0, ['rebind_name'], false, 'redefines existing name "ret"');
		assert.ok(/redefines existing name "ret"/.test(rebind) && !/cell/.test(rebind), rebind);
		// hardening: a metadata reason with NO label (raw direct call) never yields an empty "0 cell(s): "
		assert.ok(/metadata change/.test(summarizeRisk(0, ['destructive_metadata'], false, undefined)));
	});
});
