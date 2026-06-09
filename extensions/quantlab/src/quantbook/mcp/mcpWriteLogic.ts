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
import type { CellSnapshotJson, SessionOpJson, SheetInfoJson } from '../types';
import {
	A1_MAX_COLS,
	A1_MAX_ROWS,
	columnIndexToLetters,
	McpToolError,
	parseA1Cell,
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
				sheet: target.sheet, row: target.row, col: target.col, text: cell.text, isClear: false, isFormula: true,
			});
			continue;
		}
		const value = classifyCellInput(cell.text);
		if (value.kind === 'blank') {
			built.push({
				op: { kind: 'clear', sheet: target.sheet, row: target.row, col: target.col },
				sheet: target.sheet, row: target.row, col: target.col, text: cell.text, isClear: true, isFormula: false,
			});
		} else {
			built.push({
				op: { kind: 'setValue', sheet: target.sheet, row: target.row, col: target.col, value },
				sheet: target.sheet, row: target.row, col: target.col, text: cell.text, isClear: false, isFormula: false,
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

/** A reason a batch is flagged risky. An empty list means the batch may proceed under the standing trust grant. */
export type WriteRiskReason = 'large' | 'destructive_clear' | 'formula_overwrite';

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
 * {@link RISK_LARGE_CELL_COUNT} cells), DESTRUCTIVE (any `clear` op -- wiping existing cells), or a
 * FORMULA-OVERWRITE (any op that writes over a cell that currently holds a formula -- clobbering a live
 * computation an agent could destroy invisibly). A small batch of value-only writes into empty/literal
 * cells proceeds under the standing trust grant (no modal). Pure: the prior-cell lookups come through
 * {@link PriorCellReader}.
 */
export function classifyWriteRisk(ops: readonly BuiltWriteOp[], readPrior: PriorCellReader): WriteRiskVerdict {
	const reasons: WriteRiskReason[] = [];
	if (ops.length >= RISK_LARGE_CELL_COUNT) {
		reasons.push('large');
	}
	if (ops.some((o) => o.isClear)) {
		reasons.push('destructive_clear');
	}
	const overwritesFormula = ops.some((o) => {
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
	return { reasons, requiresConfirmation, summary: summarizeRisk(ops.length, reasons) };
}

/** A stable one-line risk summary for the confirmation modal + audit. */
export function summarizeRisk(cellCount: number, reasons: readonly WriteRiskReason[]): string {
	if (reasons.length === 0) {
		return `${cellCount} cell(s), no elevated risk`;
	}
	const parts: string[] = [];
	if (reasons.includes('large')) {
		parts.push('large batch');
	}
	if (reasons.includes('destructive_clear')) {
		parts.push('clears existing cells');
	}
	if (reasons.includes('formula_overwrite')) {
		parts.push('overwrites existing formula(s)');
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
 * shell only does the trust gate, the modal, the engine `batch`, and the audit append. The host MUST map
 * `grid` back to the real SessionInstance to apply (`grid.session` is the read port).
 */
export interface PreparedWrite {
	readonly grid: McpTargetGrid;
	readonly ops: BuiltWriteOp[];
	readonly risk: WriteRiskVerdict;
	/** The single undo label this write round will be grouped under. */
	readonly undoLabel: string;
	/** A compact target description for the audit line. */
	readonly target: string;
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
