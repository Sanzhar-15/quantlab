/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 (MCP writes) -- the vscode-free core of the WRITE half of the Quantbook MCP server.
//
// Wave 1 shipped a read-only MCP server. This adds WRITE tools (set_cell, write_cells) so an AI agent
// can modify the live workbook. Writing to a live FINANCIAL workbook demands REAL safety, not just a
// consent prompt -- so the risky, pure parts live HERE and are unit-tested directly with NO vscode/napi
// coupling (the established mcpToolLogic / cellGridLogic split):
//   - op building: parse the agent's A1 + value/formula into validated {@link SessionOpJson}[] (the SAME
//     classification the live grid edit uses, via {@link classifyCellInput}),
//   - risk classification: decide whether a batch needs a modal confirmation (large / destructive-clear
//     / formula-overwrite) BEFORE it touches the engine,
//   - the per-session write QUEUE: serialize concurrent agent writes so ordering + atomicity are
//     deterministic (see {@link WriteQueue} for the napi Arc<Mutex> invariant),
//   - audit-line formatting: a structured, stable record of every write attempt + outcome.
//
// The host shell (mcpServer.ts) is the thin adapter: it injects the live Session, runs the trust gate +
// the modal confirmation + the engine write (batch -> recalc -> refresh), and appends the audit line to
// the MCP output channel.
//
// No-Fallbacks: every op-building / risk failure throws a loud {@link McpToolError}; a write that needs
// confirmation but is declined is reported as a declined outcome (the agent SEES it), never silently
// applied or silently dropped.

import { classifyCellInput } from '../cellGrid/cellGridLogic';
import type {
	BorderEdgeJson,
	CellSnapshotJson,
	FormatIdJson,
	RgbJson,
	SessionOpJson,
	SheetInfoJson,
	StyleIdJson,
	StyleJson,
	WorkbookSnapshotJson,
} from '../types';
import {
	A1_MAX_COLS,
	A1_MAX_ROWS,
	columnIndexToLetters,
	McpToolError,
	parseA1Cell,
	resolveRangeTarget,
	resolveSheetId,
	resolveTargetGrid,
	type McpHostContext,
	type McpSessionPort,
	type McpTargetGrid,
} from './mcpToolLogic';

// --- the write port ----------------------------------------------------------------------------

/**
 * The minimal WRITE surface the MCP write tools need from a live napi `SessionInstance`, layered on the
 * read-only {@link McpSessionPort}. A subset interface (not the full SessionInstance) so the pure
 * handlers unit-test with a hand-built fake; the host passes the real SessionInstance, which is
 * structurally assignable to this. `batch` is the ONLY mutation path the write tools use -- a single
 * undo unit, all-or-nothing -- mirroring `SessionInstance.batch(ops, { undoLabel })`. `setValue` /
 * `setFormula` are declared for completeness (the engine surface the brief names) but the discipline is
 * batch-only so every agent write round is one atomic, named, undoable step.
 */
export interface McpWriteSessionPort extends McpSessionPort {
	setValue(sheet: number, row: number, col: number, value: { kind: 'number' | 'boolean' | 'text' | 'blank'; number?: number; boolean?: boolean; text?: string }): void;
	setFormula(sheet: number, row: number, col: number, text: string): void;
	batch(ops: SessionOpJson[], options: { undoLabel?: string }): { applied: number; version: Uint8Array };
	/**
	 * **FE-6 M (2026-06-12)**: the engine surfaces the MCP write tools below `batch` need. Styles + number
	 * formats are interned via `registerStyle` / `registerFormat` (napi, at apply time -- so the prepared
	 * ops carry a placeholder id and the real id is interned in {@link PreparedWrite.commit}) then committed
	 * via a `setStyle` / `setFormat` BATCH op (one undo unit, same discipline as set_cell). The structural
	 * methods are DIRECT napi calls (NOT batch ops -- the engine has no `insertRows` op kind); the commit
	 * strategy invokes them inside the write queue. `registerStyle` is idempotent (an identical style
	 * returns the same id). `deleteRows` / `deleteColumns` take INCLUSIVE `[start, end]`.
	 */
	registerStyle(style: StyleJson): StyleIdJson;
	registerFormat(formatString: string): FormatIdJson;
	insertRows(sheet: number, row: number, count: number): void;
	deleteRows(sheet: number, start: number, end: number): void;
	insertColumns(sheet: number, col: number, count: number): void;
	deleteColumns(sheet: number, start: number, end: number): void;
}

// --- limits ------------------------------------------------------------------------------------

/**
 * Maximum accepted length of a single cell's raw input (value or formula) at the MCP boundary, BEFORE
 * the synchronous napi parse. Mirrors `cellGridLogic.MAX_RAW_INPUT_LENGTH` (Excel caps a formula at 8192
 * chars). A larger input is rejected loud (DoS defense-in-depth: the napi setValue/setFormula parse the
 * whole string synchronously and would stall the host).
 */
export const MCP_MAX_RAW_INPUT_LENGTH = 8192;

/**
 * Upper bound on the number of cells in one MCP `write_cells` batch. A multi-op agent write over this is
 * rejected loud (the engine parses every op synchronously; an unbounded batch would stall the host).
 * Far above a realistic agent write yet a hard ceiling. Distinct from {@link RISK_LARGE_CELL_COUNT},
 * which is the (much smaller) threshold that merely triggers a confirmation, not a rejection.
 */
export const MCP_MAX_BATCH_CELLS = 100_000;

// --- op building (pure) ------------------------------------------------------------------------

/** One cell the agent asks to write: a bare or sheet-qualified A1 plus the raw literal/formula text. */
export interface McpWriteCell {
	/** The A1 cell, e.g. "B1" or sheet-qualified "S0!B1". A range is rejected loud (write one cell per entry). */
	readonly a1: string;
	/**
	 * The raw text to write, classified EXACTLY like a live grid edit: a leading "=" -> a formula
	 * (`setFormula` with the body); an empty / whitespace-only string -> a `clear` (destructive); any
	 * other literal -> a typed value (`setValue` via {@link classifyCellInput}).
	 */
	readonly text: string;
}

/** A built op plus the resolved 0-based target, retained so risk classification can read the prior cell. */
export interface BuiltWriteOp {
	readonly op: SessionOpJson;
	readonly sheet: number;
	readonly row: number;
	readonly col: number;
	/** The agent-supplied raw text (for the audit line + formula-overwrite classification). */
	readonly text: string;
	/** True when this op is a `clear` (empty input) -- a destructive write. */
	readonly isClear: boolean;
	/** True when this op is a `setFormula`. */
	readonly isFormula: boolean;
	/**
	 * **FE-6 M (2026-06-12)**: true for a `setStyle` / `setFormat` op -- a VISUAL-ONLY write that paints a
	 * cell's style / number-format but does NOT touch its value or formula. Styling over a formula cell is
	 * NOT a `formula_overwrite` (the formula survives) and is never a `destructive_clear`; the
	 * formula-overwrite / destructive-clear predicates in {@link classifyWriteRisk} SKIP these ops. They
	 * still count toward the `large` cell-count threshold.
	 */
	readonly isStyleOrFormat: boolean;
}

/**
 * Resolve one {@link McpWriteCell}'s A1 (sheet-qualified or with a fallback sheet) to a 0-based
 * (sheet,row,col). No-Fallbacks: a malformed A1, a range, an unknown sheet, or a missing sheet (bare ref
 * with no fallback) throws {@link McpToolError}. Mirrors mcpToolLogic's resolveCellTarget but inlined
 * here so the write path carries no read-tool coupling. The FIRST `!` splits sheet from ref.
 */
export function resolveWriteCellTarget(sheets: SheetInfoJson[], a1: string, fallbackSheet: number | string | undefined): { sheet: number; row: number; col: number } {
	let sheetSelector: number | string | undefined = fallbackSheet;
	let bareRef = a1;
	const bang = a1.indexOf('!');
	if (bang >= 0) {
		const namePart = a1.slice(0, bang);
		bareRef = a1.slice(bang + 1);
		// A qualified ref's sheet name wins; if a fallback sheet was ALSO given it must match (loud on
		// conflict -- never silently prefer one over the other).
		if (fallbackSheet !== undefined && !sheetSelectorMatchesName(sheets, fallbackSheet, namePart)) {
			throw new McpToolError('ambiguous_sheet', `the cell "${a1}" names sheet "${namePart}" but the sheet argument selects a different sheet`);
		}
		sheetSelector = namePart;
	}
	if (sheetSelector === undefined) {
		throw new McpToolError('no_sheet', `no sheet specified for "${a1}" -- pass a sheet argument or a sheet-qualified ref like S0!B1`);
	}
	if (bareRef.includes(':')) {
		throw new McpToolError('bad_a1', `set_cell/write_cells expect a single cell, got a range: "${a1}"`);
	}
	const sheetId = resolveSheetId(sheets, sheetSelector);
	const cell = parseA1Cell(bareRef);
	return { sheet: sheetId, row: cell.row, col: cell.col };
}

/** Whether a sheet selector (id or name) refers to the same live sheet as `name` (mirror mcpToolLogic). */
function sheetSelectorMatchesName(sheets: SheetInfoJson[], selector: number | string, name: string): boolean {
	const byName = sheets.find((s) => s.name === name);
	if (byName === undefined) {
		return false;
	}
	return typeof selector === 'number' ? selector === byName.id : selector === byName.name;
}

/**
 * Build the validated ops for an MCP write batch. Each cell's `text` is classified like a single live
 * `putValue`: a leading "=" -> `setFormula` (body after the "="), empty/whitespace -> `clear`, else a
 * typed `setValue` via {@link classifyCellInput}. No-Fallbacks: an empty batch, an over-cap count, an
 * over-length input, a malformed/range A1, or an unknown sheet throws {@link McpToolError} BEFORE any op
 * is built -- the caller rejects the WHOLE batch (engine `batch` is atomic; a partial write never
 * happens). Two ops targeting the SAME cell are rejected (the engine's `batch` rejects
 * `conflicting_batch_ops`, but failing here gives the agent a clearer message + a cheaper round-trip).
 */
export function buildWriteOps(sheets: SheetInfoJson[], cells: readonly McpWriteCell[], fallbackSheet: number | string | undefined): BuiltWriteOp[] {
	if (cells.length === 0) {
		throw new McpToolError('empty_batch', 'the write batch is empty -- pass at least one cell');
	}
	if (cells.length > MCP_MAX_BATCH_CELLS) {
		throw new McpToolError('batch_too_large', `${cells.length} cells exceeds the ${MCP_MAX_BATCH_CELLS}-cell write batch limit`);
	}
	const built: BuiltWriteOp[] = [];
	const seen = new Set<string>();
	for (const cell of cells) {
		if (typeof cell.text !== 'string') {
			throw new McpToolError('bad_argument', `cell "${cell.a1}" text must be a string, got ${typeof cell.text}`);
		}
		if (cell.text.length > MCP_MAX_RAW_INPUT_LENGTH) {
			throw new McpToolError('bad_argument', `cell "${cell.a1}" text is ${cell.text.length} chars, over the ${MCP_MAX_RAW_INPUT_LENGTH}-char limit`);
		}
		const target = resolveWriteCellTarget(sheets, cell.a1, fallbackSheet);
		// Defense-in-depth: parseA1Cell already caps to the A1 extent, but assert against the shared
		// constants so a future selector path cannot smuggle an off-extent coord into the engine.
		if (target.row < 0 || target.row >= A1_MAX_ROWS || target.col < 0 || target.col >= A1_MAX_COLS) {
			throw new McpToolError('bad_a1', `cell "${cell.a1}" is outside the A1 grid extent`);
		}
		const key = `${target.sheet}:${target.row}:${target.col}`;
		if (seen.has(key)) {
			throw new McpToolError('conflicting_batch_ops', `cell "${cell.a1}" (sheet ${target.sheet}, row ${target.row}, col ${target.col}) is written twice in one batch`);
		}
		seen.add(key);
		const trimmedStart = cell.text.trimStart();
		if (trimmedStart.startsWith('=')) {
			built.push({
				op: { kind: 'setFormula', sheet: target.sheet, row: target.row, col: target.col, text: trimmedStart.slice(1) },
				sheet: target.sheet, row: target.row, col: target.col, text: cell.text, isClear: false, isFormula: true, isStyleOrFormat: false,
			});
			continue;
		}
		const value = classifyCellInput(cell.text);
		if (value.kind === 'blank') {
			built.push({
				op: { kind: 'clear', sheet: target.sheet, row: target.row, col: target.col },
				sheet: target.sheet, row: target.row, col: target.col, text: cell.text, isClear: true, isFormula: false, isStyleOrFormat: false,
			});
		} else {
			built.push({
				op: { kind: 'setValue', sheet: target.sheet, row: target.row, col: target.col, value },
				sheet: target.sheet, row: target.row, col: target.col, text: cell.text, isClear: false, isFormula: false, isStyleOrFormat: false,
			});
		}
	}
	return built;
}

// --- risk classification (pure) ----------------------------------------------------------------

/**
 * The number of cells at/above which a write batch requires a modal confirmation (NOT a rejection -- a
 * large legitimate paste is allowed once the operator confirms). Deliberately small: an agent writing
 * many cells at once is exactly the case the operator wants to eyeball. Far below {@link MCP_MAX_BATCH_CELLS}.
 */
export const RISK_LARGE_CELL_COUNT = 50;

/**
 * A reason a batch is flagged risky. An empty list means the batch may proceed under the standing trust
 * grant. **FE-6 M (2026-06-12)**: `structural` is the SILENT-DATA-CORRUPTION reason -- it ALWAYS fires for
 * a structural edit (insert/delete rows/columns), which can re-point or drop formulas across the whole
 * sheet, so the operator ALWAYS sees the risk modal + the axis/range is recorded in the audit line.
 */
export type WriteRiskReason = 'large' | 'destructive_clear' | 'formula_overwrite' | 'structural';

/** The risk verdict for a built batch: the reasons + whether a modal confirmation is required. */
export interface WriteRiskVerdict {
	readonly reasons: WriteRiskReason[];
	readonly requiresConfirmation: boolean;
	/** A one-line human summary for the confirmation modal + the audit line. */
	readonly summary: string;
}

/**
 * Read the prior content of a target cell -- the hook risk classification uses to detect a
 * formula-overwrite. The host backs this with `session.cell(sheet,row,col)`; a test passes a fake. A
 * `null` (or a cell with no formula) means no formula is being overwritten.
 */
export type PriorCellReader = (sheet: number, row: number, col: number) => CellSnapshotJson | null;

/**
 * Classify a built batch's risk. A confirmation is required when the batch is LARGE (>=
 * {@link RISK_LARGE_CELL_COUNT} cells), DESTRUCTIVE (any `clear` op -- wiping existing cells), a
 * FORMULA-OVERWRITE (any op that writes over a cell that currently holds a formula -- clobbering a live
 * computation an agent could destroy invisibly), or STRUCTURAL (`opts.structural` -- an insert/delete
 * rows/columns edit, which ALWAYS requires the modal because it can re-point or drop formulas sheet-wide).
 * A small batch of value-only writes into empty/literal cells proceeds under the standing trust grant (no
 * modal). Pure: the prior-cell lookups come through {@link PriorCellReader}.
 *
 * **FE-6 M (2026-06-12)**: a `setStyle` / `setFormat` op (`isStyleOrFormat`) is VISUAL-ONLY -- it neither
 * clears nor clobbers a formula, so it is SKIPPED by the `destructive_clear` + `formula_overwrite`
 * predicates (it still counts toward `large`). `opts.structural` forces the `structural` reason for the
 * structural tools, whose `ops` list is empty (the edit is a direct napi call, not a cell-keyed batch).
 */
export function classifyWriteRisk(
	ops: readonly BuiltWriteOp[],
	readPrior: PriorCellReader,
	opts?: { structural?: boolean },
): WriteRiskVerdict {
	const reasons: WriteRiskReason[] = [];
	if (opts?.structural === true) {
		// SILENT-DATA-CORRUPTION class: ALWAYS prompt + record, regardless of op count (there are no
		// cell-keyed ops for a structural edit). Pushed FIRST so the summary leads with it.
		reasons.push('structural');
	}
	if (ops.length >= RISK_LARGE_CELL_COUNT) {
		reasons.push('large');
	}
	// destructive_clear + formula_overwrite consider VALUE/FORMULA/CLEAR ops only -- a style/format op
	// paints the cell without touching its value or formula (No-Fallbacks: never over-prompt a benign
	// re-style, never UNDER-prompt a real value clobber).
	if (ops.some((o) => o.isClear && !o.isStyleOrFormat)) {
		reasons.push('destructive_clear');
	}
	const overwritesFormula = ops.some((o) => {
		if (o.isStyleOrFormat) {
			return false;
		}
		const prior = readPrior(o.sheet, o.row, o.col);
		// Codex MED: a formula-backed cell can carry an EMPTY body (the live edit path accepts input "=" ->
		// setFormula with ""). Treat the PRESENCE of the formula property as formula state, not its length,
		// so overwriting a `=`-only cell still prompts (No-Fallbacks: never skip the confirmation).
		return prior !== null && prior.formula !== undefined;
	});
	if (overwritesFormula) {
		reasons.push('formula_overwrite');
	}
	const requiresConfirmation = reasons.length > 0;
	return { reasons, requiresConfirmation, summary: summarizeRisk(ops.length, reasons, opts?.structural === true) };
}

/**
 * A stable one-line risk summary for the confirmation modal + audit. **FE-6 M (2026-06-12)**: a
 * structural edit has NO cell-keyed ops (`cellCount === 0`), so `structural` formats as a standalone
 * "structural edit (insert/delete rows or columns)" lead rather than the misleading "0 cell(s)".
 */
export function summarizeRisk(cellCount: number, reasons: readonly WriteRiskReason[], structural = false): string {
	const parts: string[] = [];
	if (reasons.includes('structural')) {
		parts.push('structural edit (insert/delete rows or columns)');
	}
	if (reasons.includes('large')) {
		parts.push('large batch');
	}
	if (reasons.includes('destructive_clear')) {
		parts.push('clears existing cells');
	}
	if (reasons.includes('formula_overwrite')) {
		parts.push('overwrites existing formula(s)');
	}
	if (structural) {
		// A structural edit is described by the axis/range in the audit target, not a cell count.
		return reasons.length === 0 ? 'structural edit, no elevated risk' : parts.join(', ');
	}
	if (reasons.length === 0) {
		return `${cellCount} cell(s), no elevated risk`;
	}
	return `${cellCount} cell(s): ${parts.join(', ')}`;
}

// --- audit-line formatting (pure) --------------------------------------------------------------

/** The outcome of an attempted MCP write, recorded in the audit line. */
export type WriteOutcome = 'applied' | 'declined' | 'failed';

/** One structured audit record for a write attempt. The host fills `timestamp` from an arg or a counter. */
export interface WriteAuditRecord {
	/** An ISO-8601 timestamp or a monotonic counter string -- the host supplies it (pure code takes no clock). */
	readonly timestamp: string;
	/** The MCP tool that requested the write (e.g. "set_cell", "write_cells"). */
	readonly tool: string;
	/** The grid the write targeted (the MCP sessionId), for cross-referencing the read tools. */
	readonly sessionId: string;
	/** The undo label the write was grouped under (the one Ctrl+Z step). */
	readonly undoLabel: string;
	/** The number of ops in the batch. */
	readonly opCount: number;
	/** A compact target description, e.g. "S0!B1" or "S0!B1..B10 (10 cells)". */
	readonly target: string;
	/** The risk summary from {@link classifyWriteRisk}. */
	readonly risk: string;
	/** The terminal outcome. */
	readonly outcome: WriteOutcome;
	/** A failure / decline detail (the engine error message or "operator declined"); absent on `applied`. */
	readonly detail?: string;
}

/**
 * Encode an arbitrary free-form string into a single-line, ASCII-only, quoted token for the audit line
 * (Codex MED). Audit fields carry attacker/operator-influenced text: a SHEET NAME (-> `target`) can hold
 * non-ASCII, spaces, or even a newline; the agent supplies `undoLabel`; the engine error fills `detail`.
 * Without escaping, a newline could forge a second audit line and a non-ASCII byte would break the
 * ASCII-only hygiene rule. We JSON.stringify (quotes + escapes `"`, `\`, control chars) THEN escape every
 * remaining non-ASCII code unit as `\uXXXX`, so the result is always one ASCII line a log scraper can
 * parse and a forged-newline injection is impossible.
 */
export function auditField(value: string): string {
	const jsonQuoted = JSON.stringify(value);
	let out = '';
	// Iterate by UTF-16 CODE UNIT (not code point): a non-BMP char is two surrogate code units, and BOTH
	// must be \u-escaped -- a `for...of` code-point walk would emit one charCodeAt() and drop the low
	// surrogate (Codex LOW). Index iteration escapes every unit, so an emoji / non-BMP sheet name round-trips
	// as a pair of \uXXXX escapes and the output is strictly ASCII.
	for (let i = 0; i < jsonQuoted.length; i++) {
		const code = jsonQuoted.charCodeAt(i);
		// JSON.stringify already escaped " \ and C0 control chars; escape any remaining non-ASCII (> 0x7E)
		// so the line is strictly ASCII (0x20-0x7E plus the JSON escapes already present).
		out += code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : jsonQuoted[i];
	}
	return out;
}

/**
 * Format one audit record as a single stable, parseable line for the MCP output channel. ASCII-only,
 * space-delimited key=value so a human + a log scraper can both read it. Every free-form field
 * (tool/session/undoLabel/target/risk/detail) is run through {@link auditField} so a hostile sheet name
 * or label cannot forge a newline or smuggle a non-ASCII byte. No-Fallbacks: the line always carries the
 * outcome + (for non-applied) the detail, so a declined/failed write is never invisible.
 */
export function formatAuditLine(record: WriteAuditRecord): string {
	const base =
		`[mcp-write] ${auditField(record.timestamp)} tool=${auditField(record.tool)} session=${auditField(record.sessionId)} ` +
		`undoLabel=${auditField(record.undoLabel)} ops=${record.opCount} target=${auditField(record.target)} ` +
		`risk=${auditField(record.risk)} outcome=${record.outcome}`;
	return record.detail === undefined ? base : `${base} detail=${auditField(record.detail)}`;
}

/**
 * A compact target description for the audit line: a single cell renders as "S0!B1"; a multi-cell batch
 * renders as "S0!B1 + 9 more (10 cells)" using the first op's A1 plus the count. Pure (no session). An
 * unknown sheet id renders its number (the sheets list may have changed; the audit must still produce a
 * line). `sheetNameById` maps the resolved sheet id back to its name.
 */
export function describeTarget(ops: readonly BuiltWriteOp[], sheetNameById: ReadonlyMap<number, string>): string {
	if (ops.length === 0) {
		return '(empty)';
	}
	const first = ops[0];
	const name = sheetNameById.get(first.sheet) ?? `#${first.sheet}`;
	const firstA1 = `${name}!${columnIndexToLetters(first.col)}${first.row + 1}`;
	if (ops.length === 1) {
		return firstA1;
	}
	return `${firstA1} + ${ops.length - 1} more (${ops.length} cells)`;
}

// --- write-tool preparation (pure) -------------------------------------------------------------

/** Arguments to the `set_cell` tool: one cell by A1 + the value/formula text. */
export interface SetCellArgs {
	readonly sessionId?: string;
	readonly a1: string;
	readonly sheet?: number | string;
	readonly text: string;
}

/** Arguments to the `write_cells` tool: a batch of {a1, text} writes (one undo unit). */
export interface WriteCellsArgs {
	readonly sessionId?: string;
	readonly sheet?: number | string;
	readonly cells: readonly McpWriteCell[];
	/** Optional caller-supplied label for the single undo unit; the host defaults a descriptive one. */
	readonly undoLabel?: string;
}

/**
 * A fully-prepared write, ready for the host to (gate -> confirm -> apply -> audit). PURE: resolving the
 * grid, building the ops, and classifying risk all happen with NO vscode/napi side effect, so the host
 * shell only does the trust gate, the modal, the engine write, and the audit append. The host MUST map
 * `grid` back to the real SessionInstance to apply (`grid.session` is the read port).
 *
 * **FE-6 M (2026-06-12)**: two additive fields generalize the apply step beyond the original cell-`batch`:
 *  - `structural` -- when true, the host RE-classifies risk with `{ structural: true }` so the
 *    SILENT-DATA-CORRUPTION `structural` reason always fires (the modal always shows). Set by the
 *    insert/delete-rows/columns prepares, whose `ops` is empty.
 *  - `commit` -- the apply STRATEGY. When present, the host calls it (inside the write queue, after the
 *    modal + the live re-checks) INSTEAD of the default `batch(ops)`. It runs the napi side effect (a
 *    `registerStyle`/`registerFormat` intern + a `setStyle`/`setFormat` batch, or a direct structural
 *    napi call) and returns the applied count. When absent the host applies `batch(ops, { undoLabel })`
 *    as before. No-Fallbacks: a `commit` throw propagates -- the queue round rejects, the engine reverts.
 */
export interface PreparedWrite {
	readonly grid: McpTargetGrid;
	readonly ops: BuiltWriteOp[];
	readonly risk: WriteRiskVerdict;
	/** The single undo label this write round will be grouped under. */
	readonly undoLabel: string;
	/** A compact target description for the audit line. */
	readonly target: string;
	/** **FE-6 M**: forces the `structural` risk reason on the host's live re-classify (insert/delete). */
	readonly structural?: boolean;
	/** **FE-6 M**: the napi apply strategy; when absent the host uses the default `batch(ops)` path. */
	readonly commit?: (session: McpWriteSessionPort) => { applied: number };
}

/**
 * Prepare a `set_cell` write: resolve the grid, build the single op, classify risk. No-Fallbacks -- any
 * resolution / op-building failure throws {@link McpToolError}. The undo label is descriptive (the cell)
 * so a Ctrl+Z names the agent's edit.
 */
export function prepareSetCell(ctx: McpHostContext, args: SetCellArgs): PreparedWrite {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const fallbackSheet = args.sheet === undefined && !args.a1.includes('!') ? grid.sheet : args.sheet;
	const ops = buildWriteOps(sheets, [{ a1: args.a1, text: args.text }], fallbackSheet);
	const sheetNameById = new Map(sheets.map((s) => [s.id, s.name]));
	const target = describeTarget(ops, sheetNameById);
	const risk = classifyWriteRisk(ops, (sheet, row, col) => grid.session.cell(sheet, row, col));
	return { grid, ops, risk, undoLabel: `MCP: set ${target}`, target };
}

/**
 * Prepare a `write_cells` batch: resolve the grid, build every op (atomic -- one bad cell rejects the
 * batch), classify risk. No-Fallbacks. The undo label defaults to a descriptive one (overridable) so the
 * whole batch is ONE Ctrl+Z step.
 */
export function prepareWriteCells(ctx: McpHostContext, args: WriteCellsArgs): PreparedWrite {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	if (!Array.isArray(args.cells)) {
		throw new McpToolError('bad_argument', 'write_cells: `cells` must be an array of { a1, text }');
	}
	const ops = buildWriteOps(sheets, args.cells, args.sheet);
	const sheetNameById = new Map(sheets.map((s) => [s.id, s.name]));
	const target = describeTarget(ops, sheetNameById);
	const undoLabel = typeof args.undoLabel === 'string' && args.undoLabel.trim().length > 0
		? `MCP: ${args.undoLabel.trim()}`
		: `MCP: write ${target}`;
	const risk = classifyWriteRisk(ops, (sheet, row, col) => grid.session.cell(sheet, row, col));
	return { grid, ops, risk, undoLabel, target };
}

// --- FE-6 M (2026-06-12): set_style ------------------------------------------------------------
//
// An agent paints a cell VISUAL style (fill / bold / italic / align / per-edge borders) over a range.
// The engine `setStyle` is a WHOLE-CELL-STYLE replace (each cell's `styleId` points to one complete
// StyleJson), so a partial patch (e.g. "just set bold") must read each cell's CURRENT style and MERGE the
// patch onto it -- else styling a bold cell red would silently drop the bold. That read-modify-write is
// done at apply time (it needs the live workbook snapshot via napi); the prepared `commit` strategy
// interns each DISTINCT merged style via `registerStyle` and commits ONE `setStyle` batch (a single undo
// unit). No engine/cellGridLogic import -- the merge + dedup live here (the brief's disjoint-ownership rule).

/** The agent-supplied partial style patch for `set_style`. Every field is OPTIONAL -- an absent field
 *  leaves that attribute unchanged on each target cell; a present field overwrites it. `borders` patches
 *  per edge (an absent edge is unchanged; a present edge sets that border). */
export interface StylePatchJson {
	readonly fill?: RgbJson;
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly align?: string;
	readonly borders?: {
		readonly top?: BorderEdgeJson;
		readonly bottom?: BorderEdgeJson;
		readonly left?: BorderEdgeJson;
		readonly right?: BorderEdgeJson;
	};
}

/** Arguments to `set_style`: a single cell (`a1`) OR a range, plus the partial style patch. */
export interface SetStyleArgs {
	readonly sessionId?: string;
	readonly a1?: string;
	readonly range?: string;
	readonly sheet?: number | string;
	readonly style: StylePatchJson;
}

/** The valid `align` values (mirror the engine `StyleJson.align` domain). */
const ALIGN_VALUES = new Set(['general', 'left', 'center', 'right']);
/** The valid border-edge `style` values (mirror the engine `BorderEdgeJson.style` domain). */
const BORDER_STYLES = new Set(['none', 'thin', 'medium', 'thick', 'dashed', 'dotted', 'double']);

/** Validate one RGB channel triple from the UNTRUSTED agent payload: each of r/g/b an integer 0..=255.
 *  No-Fallbacks: a malformed color throws (never silently clamps). */
function validateRgbJson(v: unknown, where: string): RgbJson {
	if (typeof v !== 'object' || v === null) {
		throw new McpToolError('bad_argument', `${where} must be an { r, g, b } object`);
	}
	const c = v as { r?: unknown; g?: unknown; b?: unknown };
	const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;
	if (!ok(c.r) || !ok(c.g) || !ok(c.b)) {
		throw new McpToolError('bad_argument', `${where} r/g/b must each be an integer in 0..=255`);
	}
	return { r: c.r, g: c.g, b: c.b };
}

/** Validate one border-edge patch from the UNTRUSTED agent payload (a {style, color}). */
function validateBorderEdge(v: unknown, where: string): BorderEdgeJson {
	if (typeof v !== 'object' || v === null) {
		throw new McpToolError('bad_argument', `${where} must be a { style, color } object`);
	}
	const e = v as { style?: unknown; color?: unknown };
	if (typeof e.style !== 'string' || !BORDER_STYLES.has(e.style)) {
		throw new McpToolError('bad_argument', `${where} style must be one of ${[...BORDER_STYLES].join('|')}`);
	}
	return { style: e.style, color: validateRgbJson(e.color, `${where} color`) };
}

/**
 * Validate the UNTRUSTED {@link StylePatchJson} and return a normalized patch. No-Fallbacks: a malformed
 * field (non-boolean bold/italic, bad align/border-style, out-of-domain color) throws `[bad_argument]`.
 * An EMPTY patch (no field set) is rejected (an agent must change at least one attribute).
 */
export function validateStylePatch(raw: unknown): StylePatchJson {
	if (typeof raw !== 'object' || raw === null) {
		throw new McpToolError('bad_argument', 'set_style: `style` must be an object');
	}
	const s = raw as Record<string, unknown>;
	const patch: {
		fill?: RgbJson; bold?: boolean; italic?: boolean; align?: string;
		borders?: { top?: BorderEdgeJson; bottom?: BorderEdgeJson; left?: BorderEdgeJson; right?: BorderEdgeJson };
	} = {};
	let any = false;
	if (s.fill !== undefined) { patch.fill = validateRgbJson(s.fill, 'set_style: fill'); any = true; }
	if (s.bold !== undefined) {
		if (typeof s.bold !== 'boolean') { throw new McpToolError('bad_argument', 'set_style: bold must be a boolean'); }
		patch.bold = s.bold; any = true;
	}
	if (s.italic !== undefined) {
		if (typeof s.italic !== 'boolean') { throw new McpToolError('bad_argument', 'set_style: italic must be a boolean'); }
		patch.italic = s.italic; any = true;
	}
	if (s.align !== undefined) {
		if (typeof s.align !== 'string' || !ALIGN_VALUES.has(s.align)) {
			throw new McpToolError('bad_argument', `set_style: align must be one of ${[...ALIGN_VALUES].join('|')}`);
		}
		patch.align = s.align; any = true;
	}
	if (s.borders !== undefined) {
		if (typeof s.borders !== 'object' || s.borders === null) {
			throw new McpToolError('bad_argument', 'set_style: borders must be an object of { top?, bottom?, left?, right? }');
		}
		const b = s.borders as Record<string, unknown>;
		const out: { top?: BorderEdgeJson; bottom?: BorderEdgeJson; left?: BorderEdgeJson; right?: BorderEdgeJson } = {};
		if (b.top !== undefined) { out.top = validateBorderEdge(b.top, 'set_style: borders.top'); any = true; }
		if (b.bottom !== undefined) { out.bottom = validateBorderEdge(b.bottom, 'set_style: borders.bottom'); any = true; }
		if (b.left !== undefined) { out.left = validateBorderEdge(b.left, 'set_style: borders.left'); any = true; }
		if (b.right !== undefined) { out.right = validateBorderEdge(b.right, 'set_style: borders.right'); any = true; }
		patch.borders = out;
	}
	if (!any) {
		throw new McpToolError('bad_argument', 'set_style: `style` patch is empty -- set at least one of fill/bold/italic/align/borders');
	}
	return patch;
}

/** An all-default {@link StyleJson} (the base a patch merges onto when a cell carries no style yet). */
function defaultStyleJson(): StyleJson {
	return { bold: false, italic: false };
}

/**
 * Read a cell's CURRENT {@link StyleJson} from a workbook snapshot by resolving `cells[].styleId` against
 * `snapshot.styles[]`. Returns a fresh all-default style when the cell has no style. ALWAYS a copy (never
 * an alias into the snapshot) so the caller can patch freely. No-Fallbacks: a `styleId` that does NOT
 * resolve against `styles[]` is a contract violation -> throw `[invalid_state]` (the engine registers
 * every referenced style; a mutation must never start from a wrong default base). Self-contained mirror
 * of the cellGridLogic `currentCellStyle` (no cross-import; disjoint ownership).
 */
export function currentCellStyleFromSnapshot(snapshot: WorkbookSnapshotJson, sheet: number, row: number, col: number): StyleJson {
	const sheetSnap = snapshot.sheets.find((s) => s.id === sheet);
	const cell = sheetSnap?.cells.find((c) => c.row === row && c.col === col);
	if (cell === undefined || cell.styleId === undefined) {
		return defaultStyleJson();
	}
	const styles = snapshot.styles ?? [];
	const def = styles.find((d) => d.id.peer === cell.styleId!.peer && d.id.counter === cell.styleId!.counter);
	if (def === undefined) {
		throw new McpToolError(
			'invalid_state',
			`cell (sheet=${sheet}, row=${row}, col=${col}) carries a styleId {peer:${cell.styleId.peer}, counter:${cell.styleId.counter}} not present in snapshot.styles[] (${styles.length} styles) -- the style binding is out of sync`,
		);
	}
	const copy: StyleJson = { bold: def.style.bold === true, italic: def.style.italic === true };
	if (def.style.fill !== undefined) { copy.fill = { ...def.style.fill }; }
	if (def.style.align !== undefined) { copy.align = def.style.align; }
	if (def.style.borderTop !== undefined) { copy.borderTop = { style: def.style.borderTop.style, color: { ...def.style.borderTop.color } }; }
	if (def.style.borderBottom !== undefined) { copy.borderBottom = { style: def.style.borderBottom.style, color: { ...def.style.borderBottom.color } }; }
	if (def.style.borderLeft !== undefined) { copy.borderLeft = { style: def.style.borderLeft.style, color: { ...def.style.borderLeft.color } }; }
	if (def.style.borderRight !== undefined) { copy.borderRight = { style: def.style.borderRight.style, color: { ...def.style.borderRight.color } }; }
	return copy;
}

/** Merge a {@link StylePatchJson} onto a base {@link StyleJson}, returning a NEW style. A present patch
 *  field overwrites; an absent field is preserved. `borders` patches per edge. Pure. */
export function mergeStylePatch(base: StyleJson, patch: StylePatchJson): StyleJson {
	const out: StyleJson = { bold: base.bold === true, italic: base.italic === true };
	if (base.fill !== undefined) { out.fill = { ...base.fill }; }
	if (base.align !== undefined) { out.align = base.align; }
	if (base.borderTop !== undefined) { out.borderTop = { style: base.borderTop.style, color: { ...base.borderTop.color } }; }
	if (base.borderBottom !== undefined) { out.borderBottom = { style: base.borderBottom.style, color: { ...base.borderBottom.color } }; }
	if (base.borderLeft !== undefined) { out.borderLeft = { style: base.borderLeft.style, color: { ...base.borderLeft.color } }; }
	if (base.borderRight !== undefined) { out.borderRight = { style: base.borderRight.style, color: { ...base.borderRight.color } }; }
	if (patch.fill !== undefined) { out.fill = { ...patch.fill }; }
	if (patch.bold !== undefined) { out.bold = patch.bold; }
	if (patch.italic !== undefined) { out.italic = patch.italic; }
	if (patch.align !== undefined) { out.align = patch.align; }
	if (patch.borders !== undefined) {
		if (patch.borders.top !== undefined) { out.borderTop = { style: patch.borders.top.style, color: { ...patch.borders.top.color } }; }
		if (patch.borders.bottom !== undefined) { out.borderBottom = { style: patch.borders.bottom.style, color: { ...patch.borders.bottom.color } }; }
		if (patch.borders.left !== undefined) { out.borderLeft = { style: patch.borders.left.style, color: { ...patch.borders.left.color } }; }
		if (patch.borders.right !== undefined) { out.borderRight = { style: patch.borders.right.style, color: { ...patch.borders.right.color } }; }
	}
	return out;
}

/** Canonical dedup key for a {@link StyleJson} so the commit interns each DISTINCT merged style once
 *  (registerStyle is idempotent; deduping avoids N redundant napi calls for a uniform selection). */
export function styleJsonKey(s: StyleJson): string {
	const edge = (e: BorderEdgeJson | undefined): string => (e === undefined ? '' : `${e.style}@${e.color.r},${e.color.g},${e.color.b}`);
	const fill = s.fill === undefined ? '' : `${s.fill.r},${s.fill.g},${s.fill.b}`;
	return [
		s.bold === true ? 'b' : '',
		s.italic === true ? 'i' : '',
		`f:${fill}`,
		`a:${s.align ?? ''}`,
		`t:${edge(s.borderTop)}`,
		`bo:${edge(s.borderBottom)}`,
		`l:${edge(s.borderLeft)}`,
		`r:${edge(s.borderRight)}`,
	].join('|');
}

/**
 * Resolve the cells a `set_style` / `set_number_format` targets: a single `a1` cell OR a `range`, against
 * the live sheets. Returns the resolved (sheet, rect) + the flat list of (row, col) targets. No-Fallbacks:
 * exactly one of `a1`/`range` must be given (both/neither -> `[bad_argument]`); an over-cap cell count is
 * rejected loud (the engine parses every op synchronously). The sheet fallback mirrors get_cell:
 * a bare ref with no `sheet` arg falls back to the grid's focused sheet.
 */
function resolveStyleTargets(
	grid: McpTargetGrid,
	sheets: SheetInfoJson[],
	a1: string | undefined,
	range: string | undefined,
	sheet: number | string | undefined,
): { sheet: number; cells: { row: number; col: number }[]; firstA1: string; cellCount: number } {
	if ((a1 === undefined) === (range === undefined)) {
		throw new McpToolError('bad_argument', 'pass EXACTLY one of `a1` (single cell) or `range` (rectangle)');
	}
	const ref = (a1 ?? range) as string;
	const fallbackSheet = sheet === undefined && !ref.includes('!') ? grid.sheet : sheet;
	const resolved = resolveRangeTarget(sheets, ref, fallbackSheet);
	const rows = resolved.endRow - resolved.startRow + 1;
	const cols = resolved.endCol - resolved.startCol + 1;
	const count = rows * cols;
	if (count > MCP_MAX_BATCH_CELLS) {
		throw new McpToolError('batch_too_large', `${count} cells exceeds the ${MCP_MAX_BATCH_CELLS}-cell write batch limit`);
	}
	const cells: { row: number; col: number }[] = [];
	for (let r = resolved.startRow; r <= resolved.endRow; r += 1) {
		for (let c = resolved.startCol; c <= resolved.endCol; c += 1) {
			cells.push({ row: r, col: c });
		}
	}
	const sheetNameById = new Map(sheets.map((s) => [s.id, s.name]));
	const name = sheetNameById.get(resolved.sheet) ?? `#${resolved.sheet}`;
	const firstA1 = `${name}!${columnIndexToLetters(resolved.startCol)}${resolved.startRow + 1}`;
	return { sheet: resolved.sheet, cells, firstA1, cellCount: count };
}

/** A compact target description for a style/format/structural write (no per-cell `BuiltWriteOp` list). */
function describeRectTarget(firstA1: string, cellCount: number): string {
	return cellCount === 1 ? firstA1 : `${firstA1} + ${cellCount - 1} more (${cellCount} cells)`;
}

/**
 * Prepare a `set_style` write. Resolves the target cells + validates the patch (PURE). The merge +
 * intern + batch run in the `commit` strategy (they need the live napi snapshot + registerStyle). Risk:
 * `large` applies (>= {@link RISK_LARGE_CELL_COUNT} cells); a style op is never `destructive_clear` /
 * `formula_overwrite` (it leaves value/formula intact -- the `isStyleOrFormat` ops carry that). The
 * commit builds the FINAL `setStyle` batch ops from the freshly-interned ids.
 */
export function prepareSetStyle(ctx: McpHostContext, args: SetStyleArgs): PreparedWrite {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const patch = validateStylePatch(args.style);
	const { sheet, cells, firstA1, cellCount } = resolveStyleTargets(grid, sheets, args.a1, args.range, args.sheet);
	const target = describeRectTarget(firstA1, cellCount);
	// Placeholder ops carry the targets + isStyleOrFormat for risk (`large`) + audit count; the REAL
	// styleId is interned in commit (the placeholder id is never sent to the engine).
	const placeholder: StyleIdJson = { peer: 0n, counter: 0 };
	const ops: BuiltWriteOp[] = cells.map((c) => ({
		op: { kind: 'setStyle' as const, sheet, row: c.row, col: c.col, style: placeholder },
		sheet, row: c.row, col: c.col, text: '', isClear: false, isFormula: false, isStyleOrFormat: true,
	}));
	const risk = classifyWriteRisk(ops, (s, r, c) => grid.session.cell(s, r, c));
	const undoLabel = `MCP: style ${target}`;
	const commit = (session: McpWriteSessionPort): { applied: number } => {
		// Read the LIVE snapshot, merge the patch onto each cell's current style, intern DISTINCT styles
		// once (registerStyle idempotent + dedup), build the setStyle batch, commit as one undo unit.
		const snapshot = session.snapshot();
		const idByKey = new Map<string, StyleIdJson>();
		const batchOps: SessionOpJson[] = cells.map((c) => {
			const merged = mergeStylePatch(currentCellStyleFromSnapshot(snapshot, sheet, c.row, c.col), patch);
			const key = styleJsonKey(merged);
			let id = idByKey.get(key);
			if (id === undefined) {
				id = session.registerStyle(merged);
				idByKey.set(key, id);
			}
			return { kind: 'setStyle', sheet, row: c.row, col: c.col, style: id };
		});
		const result = session.batch(batchOps, { undoLabel });
		return { applied: result.applied };
	};
	return { grid, ops, risk, undoLabel, target, commit };
}

// --- FE-6 M (2026-06-12): set_number_format ----------------------------------------------------

/** Arguments to `set_number_format`: a single cell (`a1`) OR a range, plus the format string. */
export interface SetNumberFormatArgs {
	readonly sessionId?: string;
	readonly a1?: string;
	readonly range?: string;
	readonly sheet?: number | string;
	/** A number-format string, e.g. "0.00%" (percent), "$#,##0.00" (currency), "0.00" (number). */
	readonly format: string;
}

/** Maximum accepted length of a number-format string (defense in depth -- the engine parses it). */
export const MCP_MAX_FORMAT_LENGTH = 512;

/**
 * Prepare a `set_number_format` write. Resolves the target cells + validates the format string (PURE).
 * The `registerFormat` intern + `setFormat` batch run in `commit`. Risk: `large` only (a format op is
 * never destructive / formula-overwrite -- it leaves value/formula intact).
 */
export function prepareSetNumberFormat(ctx: McpHostContext, args: SetNumberFormatArgs): PreparedWrite {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	if (typeof args.format !== 'string' || args.format.length === 0) {
		throw new McpToolError('bad_argument', 'set_number_format: `format` must be a non-empty format string (e.g. "0.00%")');
	}
	if (args.format.length > MCP_MAX_FORMAT_LENGTH) {
		throw new McpToolError('bad_argument', `set_number_format: \`format\` is ${args.format.length} chars, over the ${MCP_MAX_FORMAT_LENGTH}-char limit`);
	}
	const format = args.format;
	const { sheet, cells, firstA1, cellCount } = resolveStyleTargets(grid, sheets, args.a1, args.range, args.sheet);
	const target = describeRectTarget(firstA1, cellCount);
	const placeholder: FormatIdJson = { kind: 'builtin', builtin: 0 };
	const ops: BuiltWriteOp[] = cells.map((c) => ({
		op: { kind: 'setFormat' as const, sheet, row: c.row, col: c.col, format: placeholder },
		sheet, row: c.row, col: c.col, text: '', isClear: false, isFormula: false, isStyleOrFormat: true,
	}));
	const risk = classifyWriteRisk(ops, (s, r, c) => grid.session.cell(s, r, c));
	const undoLabel = `MCP: format ${target}`;
	const commit = (session: McpWriteSessionPort): { applied: number } => {
		// Intern the format ONCE (engine may dedup to a builtin), then commit the setFormat batch.
		const formatId = session.registerFormat(format);
		const batchOps: SessionOpJson[] = cells.map((c) => ({ kind: 'setFormat', sheet, row: c.row, col: c.col, format: formatId }));
		const result = session.batch(batchOps, { undoLabel });
		return { applied: result.applied };
	};
	return { grid, ops, risk, undoLabel, target, commit };
}

// --- FE-6 M (2026-06-12): structural edits (insert/delete rows/columns) -------------------------
//
// SILENT-DATA-CORRUPTION class. The engine has NO `insertRows` BATCH op kind -- these are DIRECT napi
// methods that re-point relative formula refs across the whole sheet (insert) or re-bind refs into the
// deleted band to #REF! (delete). So they route through the SAME pipeline (trust + queue + modal + audit)
// via the `commit` strategy, and ALWAYS carry the `structural` risk reason so the operator ALWAYS sees
// the modal and the axis/range lands in the audit line. `ops` is empty (no cell-keyed ops); `target`
// carries the axis + range (e.g. "Data: insert 3 row(s) at row 5").

/** The structural axis + operation a `structural` write performs. */
export type StructuralKind = 'insert_rows' | 'delete_rows' | 'insert_columns' | 'delete_columns';

/** Arguments to insert_rows / insert_columns: `{ sheet?, index, count }` (0-based index, count >= 1). */
export interface InsertStructuralArgs {
	readonly sessionId?: string;
	readonly sheet?: number | string;
	readonly index: number;
	readonly count: number;
}

/** Arguments to delete_rows / delete_columns: `{ sheet?, start, end }` (0-based, INCLUSIVE -- matches the napi). */
export interface DeleteStructuralArgs {
	readonly sessionId?: string;
	readonly sheet?: number | string;
	readonly start: number;
	readonly end: number;
}

/** Resolve the sheet for a structural edit: the `sheet` arg, else the grid's focused sheet. No-Fallbacks:
 *  an unknown sheet throws via {@link resolveSheetId}. */
function resolveStructuralSheet(grid: McpTargetGrid, sheets: SheetInfoJson[], sheet: number | string | undefined): { sheetId: number; sheetName: string } {
	const selector = sheet ?? grid.sheet;
	const sheetId = resolveSheetId(sheets, selector);
	const sheetName = sheets.find((s) => s.id === sheetId)?.name ?? `#${sheetId}`;
	return { sheetId, sheetName };
}

/**
 * Assert a 0-based index is a SAFE non-negative integer within the A1 extent for the given axis.
 * `axisMax` is the axis COUNT ({@link A1_MAX_ROWS} = 1,048,576 / {@link A1_MAX_COLS} = 16,384 -- the
 * shared IDE grid-extent constants imported from mcpToolLogic), so the valid 0-based index range is
 * `[0, axisMax)` (the last row index is 1,048,575). No-Fallbacks: the `Number.isSafeInteger` guard is
 * load-bearing -- without it a value above 2^53 (or a non-integer / `NaN`) would slip past a bare
 * `Number.isInteger` (which IS true for e.g. `2**53`) or coerce to the wrong u32 at the napi boundary.
 * Codex MED: every numeric structural input must be safe-integer-checked, not just integer-checked.
 */
function assertStructuralIndex(value: number, label: string, axisMax: number): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new McpToolError('bad_argument', `${label} must be a non-negative safe integer, got ${value}`);
	}
	if (value >= axisMax) {
		throw new McpToolError('bad_argument', `${label} ${value} is outside the sheet extent (max index ${axisMax - 1})`);
	}
}

/**
 * Prepare an INSERT rows/columns write (`{ index, count }`). Validates the index/count + resolves the
 * sheet (PURE). The direct napi call (`insertRows`/`insertColumns`) runs in `commit`. ALWAYS structural
 * risk. No-Fallbacks: a non-integer/negative index, a `count < 1`, or an unknown sheet throws.
 */
export function prepareInsertStructural(ctx: McpHostContext, kind: 'insert_rows' | 'insert_columns', args: InsertStructuralArgs): PreparedWrite {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const { sheetId, sheetName } = resolveStructuralSheet(grid, sheets, args.sheet);
	const isRows = kind === 'insert_rows';
	const axisMax = isRows ? A1_MAX_ROWS : A1_MAX_COLS;
	assertStructuralIndex(args.index, 'index', axisMax);
	// No-Fallbacks (Codex MED): `count` must be a SAFE integer >= 1. Without the `Number.isSafeInteger`
	// guard a value like 2^32+1 (4,294,967,297) passes a bare integer check and reaches the napi `count`
	// (a u32) where it OVERFLOWS / coerces silently -- the same numeric-boundary class the cell wrappers guard.
	if (typeof args.count !== 'number' || !Number.isSafeInteger(args.count) || args.count < 1) {
		throw new McpToolError('bad_argument', `count must be a safe integer >= 1, got ${args.count}`);
	}
	// An insert cannot push existing content PAST the axis: the inserted band [index, index+count) must
	// fit within the [0, axisMax) extent, i.e. count <= axisMax - index. Reject loud BEFORE preparing the
	// write (the engine caps the axis; an over-extent count would otherwise reach the napi).
	if (args.count > axisMax - args.index) {
		throw new McpToolError(
			'bad_argument',
			`count ${args.count} at index ${args.index} would push past the sheet extent (max ${axisMax - args.index} ${isRows ? 'row' : 'column'}(s) insertable at this index)`,
		);
	}
	const axis = isRows ? 'row' : 'column';
	const target = `${sheetName}: insert ${args.count} ${axis}(s) at ${axis} ${args.index}`;
	const undoLabel = `MCP: ${target}`;
	const ops: BuiltWriteOp[] = [];
	const risk = classifyWriteRisk(ops, () => null, { structural: true });
	const commit = (session: McpWriteSessionPort): { applied: number } => {
		if (isRows) {
			session.insertRows(sheetId, args.index, args.count);
		} else {
			session.insertColumns(sheetId, args.index, args.count);
		}
		// A structural edit applies a single logical unit; report 1 (it is not cell-counted).
		return { applied: 1 };
	};
	return { grid, ops, risk, undoLabel, target, structural: true, commit };
}

/**
 * Prepare a DELETE rows/columns write (`{ start, end }`, INCLUSIVE -- matches the napi). Validates the
 * range + resolves the sheet (PURE). The direct napi call (`deleteRows`/`deleteColumns`) runs in `commit`.
 * ALWAYS structural risk. No-Fallbacks: a non-integer/negative bound, an inverted range (`end < start`),
 * or an unknown sheet throws.
 */
export function prepareDeleteStructural(ctx: McpHostContext, kind: 'delete_rows' | 'delete_columns', args: DeleteStructuralArgs): PreparedWrite {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const { sheetId, sheetName } = resolveStructuralSheet(grid, sheets, args.sheet);
	const isRows = kind === 'delete_rows';
	const axisMax = isRows ? A1_MAX_ROWS : A1_MAX_COLS;
	assertStructuralIndex(args.start, 'start', axisMax);
	assertStructuralIndex(args.end, 'end', axisMax);
	if (args.end < args.start) {
		throw new McpToolError('bad_argument', `end ${args.end} is before start ${args.start} (the range is INCLUSIVE)`);
	}
	const axis = isRows ? 'row' : 'column';
	const span = args.end - args.start + 1;
	const target = `${sheetName}: delete ${span} ${axis}(s) [${args.start}..${args.end}]`;
	const undoLabel = `MCP: ${target}`;
	const ops: BuiltWriteOp[] = [];
	const risk = classifyWriteRisk(ops, () => null, { structural: true });
	const commit = (session: McpWriteSessionPort): { applied: number } => {
		if (isRows) {
			session.deleteRows(sheetId, args.start, args.end);
		} else {
			session.deleteColumns(sheetId, args.start, args.end);
		}
		return { applied: 1 };
	};
	return { grid, ops, risk, undoLabel, target, structural: true, commit };
}

// --- per-session write queue (pure async) ------------------------------------------------------

/**
 * A per-session serializing write queue. The MCP HTTP server is STATELESS-per-POST, so concurrent agent
 * tool calls arrive on independent requests with no shared ordering. This queue runs each session's
 * writes ONE AT A TIME, in FIFO enqueue order, so a multi-op agent write round is atomic w.r.t. OTHER
 * agent write rounds and ordering is deterministic.
 *
 * THE CONCURRENCY INVARIANT (verified against the napi surface):
 *   - The engine `Session` is an `Arc<Mutex<...>>`: every napi call (a live grid edit's `setValue`, the
 *     reactive kernel's republish `batch`, and this queue's `batch`) takes the SAME lock, so individual
 *     calls never INTERLEAVE at the engine level -- that is CORRECTNESS-safe regardless of this queue.
 *   - What the engine lock does NOT give us is ATOMICITY ACROSS the host-side three-step write discipline
 *     (`batch` -> `recalcDirtyChecked` -> `refreshSession`) when two agent rounds race: without this
 *     queue, round A's `batch` could land, then round B's `batch` + recalc, then round A's recalc -- a
 *     non-deterministic ordering the agent cannot reason about. The queue makes each round's three steps
 *     run to completion before the next round starts.
 *   - The queue is per-Session (keyed by Session identity). Different sessions run in parallel (their
 *     engines are independent locks); the SAME session serializes. A live grid keystroke is NOT in this
 *     queue (it is a different code path), but it serializes at the engine lock, so it can only land
 *     BETWEEN two queued rounds, never INSIDE one round's batch -- the engine lock guarantees that.
 *
 * The runner is an async function returning the round's result; a thrown error rejects ONLY that round's
 * promise and the queue advances (No-Fallbacks: one failed write does not stall the session forever).
 */
export class WriteQueue<S> {
	private readonly tails = new WeakMap<S & object, Promise<unknown>>();

	/**
	 * Enqueue `run` for `session`. Returns a promise that resolves/rejects with `run`'s result, AFTER all
	 * previously-enqueued runs for the SAME session have settled. Concurrency: at most one `run` per
	 * session executes at a time; the per-session chain is a strict FIFO. A run that throws rejects its
	 * own promise but does NOT poison the chain -- the next run still starts.
	 */
	enqueue<T>(session: S & object, run: () => Promise<T>): Promise<T> {
		const prior = this.tails.get(session) ?? Promise.resolve();
		// Chain off the prior tail's SETTLEMENT (success or failure) so a failed round does not block the
		// next. `.then(run, run)` runs `run` whether the prior settled fulfilled or rejected.
		const next = prior.then(run, run);
		// The new tail is `next` settled (never rejected) so a future enqueue chains cleanly off it.
		this.tails.set(session, next.then(() => undefined, () => undefined));
		return next;
	}

	/** Whether `session` currently has a chain (a write is in flight or recently ran). Test/diagnostic only. */
	hasChain(session: S & object): boolean {
		return this.tails.has(session);
	}
}
