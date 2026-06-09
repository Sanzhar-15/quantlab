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
	CellSnapshotJson,
	FunctionMetadataJson,
	RangeResultJson,
	SheetInfoJson,
	WorkbookSnapshotJson,
} from '../src/quantbook/types';
import { McpToolError, type McpHostContext, type McpSessionPort, type McpTargetGrid } from '../src/quantbook/mcp/mcpToolLogic';
import {
	auditField,
	buildWriteOps,
	classifyWriteRisk,
	describeTarget,
	formatAuditLine,
	MCP_MAX_BATCH_CELLS,
	MCP_MAX_RAW_INPUT_LENGTH,
	prepareSetCell,
	prepareWriteCells,
	resolveWriteCellTarget,
	RISK_LARGE_CELL_COUNT,
	summarizeRisk,
	WriteQueue,
	type BuiltWriteOp,
	type WriteAuditRecord,
} from '../src/quantbook/mcp/mcpWriteLogic';

// --- fakes ------------------------------------------------------------------------------------

interface FakeSheet {
	id: number;
	name: string;
	cells: CellSnapshotJson[];
}

/** A minimal in-memory fake session implementing the read+write port surface the tests exercise. */
class FakeWriteSession implements McpSessionPort {
	readonly batched: Array<{ ops: unknown[]; undoLabel?: string }> = [];

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
		return { sheets: this.sheets.map((s) => ({ id: s.id, name: s.name, cells: s.cells })), formats: [], dateSystem: 'Excel1900' };
	}

	listFunctions(): FunctionMetadataJson[] {
		return [];
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
		const orphan: BuiltWriteOp[] = [{ op: { kind: 'clear', sheet: 99, row: 0, col: 0 }, sheet: 99, row: 0, col: 0, text: '', isClear: true, isFormula: false }];
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
