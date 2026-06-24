/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-BEYOND B1 -- the vscode-free core of the read-only Quantbook MCP server.
//
// An AI agent reads the LIVE per-panel workbook Session through the read-only tools. The risky,
// pure parts -- A1 parsing, sheet-name resolution, session selection across multiple open grids,
// and the per-tool read shaping -- live HERE and are unit-tested directly over a small port
// interface ({@link McpSessionPort}) with NO vscode/napi coupling (the established cellGridLogic /
// bindVariableLogic split). The host shell (mcpServer.ts) is a thin adapter: it injects the live
// CellGridPanel accessors + the engine SessionInstance + the reactive kernel manager, and wires the
// official @modelcontextprotocol/sdk transport.
//
// No-Fallbacks: every resolution failure (no grid open, ambiguous grid, unknown sheet, malformed A1,
// snapshot over the cell cap) throws a loud structured error -- never an empty-default read. The MCP
// SDK turns a thrown error into an in-band protocol error result (isError), so the agent SEES it.

import type {
	CellRangeJson,
	CellSnapshotJson,
	CellValueJson,
	DiagnosticJson,
	FunctionMetadataJson,
	NamedRangeJson,
	RangeResultJson,
	SheetInfoJson,
	TableSnapshotJson,
	UsedRangeJson,
	WorkbookSnapshotJson,
} from '../types';

/**
 * The minimal read-only surface the MCP tools need from a live napi {@link SessionInstance}. A subset
 * interface (not the full SessionInstance) so the pure handlers unit-test with a hand-built fake and
 * carry NO write methods -- the type itself enforces "read-only v1" (a tool physically cannot call
 * setValue/batch/etc. through this port). The host passes the real SessionInstance, which is
 * structurally assignable to this.
 */
export interface McpSessionPort {
	listSheets(): SheetInfoJson[];
	cell(sheet: number, row: number, col: number): CellSnapshotJson | null;
	queryRange(range: CellRangeJson, options: { includeFormulas: boolean; includeFormats: boolean; includeRendered: boolean }): RangeResultJson;
	snapshot(): WorkbookSnapshotJson;
	listFunctions(): FunctionMetadataJson[];
	/**
	 * **FE-6 M (2026-06-12)**: parse + bind a formula WITHOUT mutating (the keystroke-validation path). A
	 * malformed formula returns a non-empty {@link DiagnosticJson}`[]` as DATA (NOT a thrown error); an
	 * empty array means valid. `text` is the formula BODY with NO leading `=` (engine convention). Backs
	 * the read-only `validate_formula` tool so an agent can dry-run a formula before writing it.
	 */
	validateFormula(sheet: number, row: number, col: number, text: string): DiagnosticJson[];
	/**
	 * **Wave L (2026-06-24)**: every defined name in the workbook -- BOTH workbook-scoped and
	 * sheet-scoped names ({@link NamedRangeJson.scope} = the sheet id) -- as the engine returns them
	 * (sorted by the engine). Backs the read-only `list_named_ranges` tool. A cheap dedicated getter
	 * (NOT the full {@link snapshot}, which materializes every cell) so it is safe on a 1M-cell workbook.
	 */
	listNames(): NamedRangeJson[];
	/**
	 * **Wave L3 (R24, 2026-06-24)**: the effective VALUE extent of one sheet -- the inclusive bounding
	 * box (anchored at A1) of its non-blank value cells -- or `null` for an empty / all-blank sheet.
	 * Backs the read-only `get_used_range` tool. A cheap bounds read (NOT the full {@link snapshot},
	 * which materializes every cell), so it is safe on a 1M-cell sheet.
	 */
	usedRange(sheet: number): UsedRangeJson | null;
	/**
	 * **Wave L3 (R24, 2026-06-24)**: every structured table in the workbook (canonical + display name,
	 * anchor sheet, footprint, header/totals flags), sorted by `(sheet, name)`. Backs the read-only
	 * `list_tables` tool. A cheap dedicated getter (NOT {@link snapshot}), so it is safe on a 1M-cell
	 * workbook -- this is the getter `list_tables` was held back at Wave L1 for the lack of.
	 */
	listTables(): TableSnapshotJson[];
}

/**
 * A live grid the MCP server can target: the owning Session port + the focused sheet id + a stable id
 * the agent can name to disambiguate when several grids are open. Built by the host from
 * {@link CellGridPanel.activeLocalPanels} (one entry per open panel).
 */
export interface McpTargetGrid {
	/** A stable per-call identifier the agent passes back as `sessionId` to pick this exact grid. */
	readonly id: string;
	readonly session: McpSessionPort;
	/** The sheet this panel is showing (its "focused" sheet) -- used as the default for get_cell etc. */
	readonly sheet: number;
}

/**
 * What the host hands the tool layer on every call (resolved FRESH per request -- panels open/close).
 * `grids` is every open Cell Grid; `focusedId` is the id of the focused one (or undefined if none is
 * focused / a different editor has focus). `publishedVariables` enumerates the reactive kernel's
 * currently-published variables for a given session (empty when no kernel is bound -- a true empty,
 * not an error mask).
 */
export interface McpHostContext {
	readonly grids: readonly McpTargetGrid[];
	readonly focusedId: string | undefined;
	/** The cells each published variable currently drives on `session`, across all its live sheets. */
	publishedVariables(session: McpSessionPort): PublishedVariableTargets[];
}

/** One published reactive variable and the range it drives (already resolved to a sheet id). */
export interface PublishedVariableTargets {
	readonly name: string;
	readonly range: CellRangeJson;
}

/**
 * Cap on the number of cells {@link getSnapshot} will serialize. `snapshot()` is the FULL workbook and
 * sheets target 1M cells (FE-2); an uncapped snapshot would blow up the agent's context and the host's
 * memory. Above this, the tool FAILS LOUD (No-Fallbacks) and points the agent at `query_range`, which
 * is the primary, paged read. Chosen generously enough for real inspection (~a 200x250 block) yet far
 * below the 1M ceiling.
 */
export const SNAPSHOT_CELL_CAP = 50000;

/** A structured, agent-readable error. The `code` is a bracketed tag (mirrors the engine convention). */
export class McpToolError extends Error {
	constructor(public readonly code: string, message: string) {
		super(`[${code}] ${message}`);
		this.name = 'McpToolError';
	}
}

// --- A1 parsing (pure) -------------------------------------------------------------------------

/**
 * Bijective base-26 column letters -> 0-based column index ("A" -> 0, "Z" -> 25, "AA" -> 26). Mirrors
 * the engine/`colLetters` semantics in reactiveKernelCommands.ts. Letters are upper-cased; a non-letter
 * is rejected by the caller's regex before this runs.
 */
export function colLettersToIndex(letters: string): number {
	let col = 0;
	for (const ch of letters.toUpperCase()) {
		col = col * 26 + (ch.charCodeAt(0) - 64);
	}
	return col - 1;
}

/** One parsed A1 cell as 0-based grid coordinates. */
export interface ParsedA1Cell {
	row: number;
	col: number;
}

/**
 * The A1 grid extent. A host-local pin mirroring `A1_MAX_ROWS`/`A1_MAX_COLS` in cellGridLogic.ts (kept
 * local rather than cross-imported, the same discipline that file uses). An A1 ref outside this is
 * rejected loud -- without this cap, `get_cell` on an off-grid ref (`A1048577`) reads `cell() === null`
 * and would MASK the invalid target as an "empty cell" (a No-Fallbacks violation Codex flagged).
 */
export const A1_MAX_ROWS = 1_048_576;
export const A1_MAX_COLS = 16_384;

/**
 * Parse a bare A1 cell reference ("B1", "AA10") into 0-based {row,col}. No-Fallbacks: a malformed ref
 * (lowercase ok, but empty / wrong shape / row 0) OR a ref outside the grid extent throws
 * {@link McpToolError} `[bad_a1]`. Mirrors the `a1Cell` parser in reactiveKernelCommands.ts (1-based
 * input row -> 0-based). Rejects a `$`-anchored ref (`$A$1`) -- those are formula refs, not addressing
 * targets, so the agent must pass a plain A1. Rejecting off-grid coords here means an out-of-extent
 * `get_cell` fails loud instead of masquerading as an empty cell.
 */
export function parseA1Cell(ref: string): ParsedA1Cell {
	const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
	if (m === null) {
		throw new McpToolError('bad_a1', `malformed A1 cell reference: "${ref}" (expected e.g. B1)`);
	}
	const row = parseInt(m[2], 10);
	if (row < 1) {
		throw new McpToolError('bad_a1', `A1 row must be >= 1: "${ref}"`);
	}
	const row0 = row - 1;
	const col0 = colLettersToIndex(m[1]);
	if (row0 >= A1_MAX_ROWS) {
		throw new McpToolError('bad_a1', `A1 row out of grid extent (max ${A1_MAX_ROWS}): "${ref}"`);
	}
	if (col0 >= A1_MAX_COLS) {
		throw new McpToolError('bad_a1', `A1 column out of grid extent (max ${A1_MAX_COLS} columns): "${ref}"`);
	}
	return { row: row0, col: col0 };
}

/** A parsed A1 range as 0-based, normalized (start <= end on both axes), INCLUSIVE coordinates. */
export interface ParsedA1Range {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
}

/**
 * Parse a bare A1 range ("B1:D3") or a single cell ("B1", treated as a 1x1 range) into normalized
 * 0-based inclusive coordinates. No-Fallbacks: a malformed range (more than one `:`, a bad endpoint)
 * throws `[bad_a1]`. The result is normalized (start <= end) so an inverted "D3:B1" still yields a
 * valid rectangle (Excel/Sheets range semantics) -- the engine's queryRange rejects inverted ranges,
 * so normalizing here is the agent-friendly contract while staying loud on truly malformed input.
 */
export function parseA1Range(ref: string): ParsedA1Range {
	if (!ref.includes(':')) {
		const c = parseA1Cell(ref);
		return { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col };
	}
	const parts = ref.split(':');
	if (parts.length !== 2) {
		throw new McpToolError('bad_a1', `malformed A1 range (expected exactly one ':'): "${ref}"`);
	}
	const a = parseA1Cell(parts[0]);
	const b = parseA1Cell(parts[1]);
	return {
		startRow: Math.min(a.row, b.row),
		startCol: Math.min(a.col, b.col),
		endRow: Math.max(a.row, b.row),
		endCol: Math.max(a.col, b.col),
	};
}

/**
 * A target reference that is EITHER sheet-qualified ("S0!B1:D3") or bare ("B1:D3"), plus an optional
 * separate `sheet` selector (id or name). Resolves the (sheetId, range) against the session's live
 * sheets. Precedence + No-Fallbacks rules:
 *   - A `!` in `ref` carries the sheet name; it MUST match `sheet` if `sheet` was also given (loud
 *     `[ambiguous_sheet]` on conflict) -- never silently prefer one.
 *   - With no `!` in `ref`, `sheet` is required (id number or name string); absent -> `[no_sheet]`.
 *   - An unknown sheet (name or id) -> `[unknown_sheet]`.
 * The FIRST `!` splits sheet from ref (mirrors resolveA1OnSession); a sheet name containing `!` is not
 * resolvable this way and yields `[unknown_sheet]` (the engine forbids quoting here too).
 */
export function resolveRangeTarget(sheets: SheetInfoJson[], ref: string, sheet?: number | string): CellRangeJson {
	let sheetSelector: number | string | undefined = sheet;
	let bareRef = ref;
	const bang = ref.indexOf('!');
	if (bang >= 0) {
		const namePart = ref.slice(0, bang);
		bareRef = ref.slice(bang + 1);
		if (sheet !== undefined && !sheetSelectorMatchesName(sheets, sheet, namePart)) {
			throw new McpToolError(
				'ambiguous_sheet',
				`the range "${ref}" names sheet "${namePart}" but the sheet argument selects a different sheet`,
			);
		}
		sheetSelector = namePart;
	}
	if (sheetSelector === undefined) {
		throw new McpToolError('no_sheet', `no sheet specified for "${ref}" -- pass a sheet argument or a sheet-qualified ref like S0!B1`);
	}
	const sheetId = resolveSheetId(sheets, sheetSelector);
	const range = parseA1Range(bareRef);
	return { sheet: sheetId, startRow: range.startRow, startCol: range.startCol, endRow: range.endRow, endCol: range.endCol };
}

/** Whether a sheet selector (id or name) refers to the same live sheet as `name`. */
function sheetSelectorMatchesName(sheets: SheetInfoJson[], selector: number | string, name: string): boolean {
	const byName = sheets.find((s) => s.name === name);
	if (byName === undefined) {
		return false;
	}
	if (typeof selector === 'number') {
		return selector === byName.id;
	}
	return selector === byName.name;
}

/**
 * Resolve a sheet selector (numeric id OR exact name) to a live sheet id. No-Fallbacks: an unknown id
 * or name throws `[unknown_sheet]` (never defaults to sheet 0). Name match is exact + case-sensitive
 * (engine sheet names are case-sensitive).
 */
export function resolveSheetId(sheets: SheetInfoJson[], selector: number | string): number {
	if (typeof selector === 'number') {
		const byId = sheets.find((s) => s.id === selector);
		if (byId === undefined) {
			throw new McpToolError('unknown_sheet', `no live sheet with id ${selector}`);
		}
		return byId.id;
	}
	const byName = sheets.find((s) => s.name === selector);
	if (byName === undefined) {
		throw new McpToolError('unknown_sheet', `no live sheet named "${selector}"`);
	}
	return byName.id;
}

// --- session resolution across open grids (pure) -----------------------------------------------

/**
 * Pick the grid the tool should read. Resolution (No-Fallbacks, mirrors resolveCommandTargetPanel):
 *   - explicit `sessionId`: that exact grid, or `[unknown_session]` if it is not open.
 *   - else the focused grid if one is focused.
 *   - else, if exactly one grid is open, that one.
 *   - else `[no_grid]` (none open) or `[ambiguous_grid]` (several open, none focused).
 * Never silently picks an arbitrary grid -- an agent that does not name a session and has no focused
 * grid among many gets a loud error telling it to pass `sessionId`.
 */
export function resolveTargetGrid(ctx: McpHostContext, sessionId?: string): McpTargetGrid {
	if (sessionId !== undefined) {
		const named = ctx.grids.find((g) => g.id === sessionId);
		if (named === undefined) {
			throw new McpToolError('unknown_session', `no open Cell Grid with sessionId "${sessionId}" (call list_sheets without one, or open the grid)`);
		}
		return named;
	}
	if (ctx.grids.length === 0) {
		throw new McpToolError('no_grid', 'no Cell Grid is open -- open a Quantbook Cell Grid first');
	}
	if (ctx.focusedId !== undefined) {
		const focused = ctx.grids.find((g) => g.id === ctx.focusedId);
		if (focused !== undefined) {
			return focused;
		}
	}
	if (ctx.grids.length === 1) {
		return ctx.grids[0];
	}
	throw new McpToolError(
		'ambiguous_grid',
		`${ctx.grids.length} Cell Grids are open and none is focused -- pass a sessionId (one of: ${ctx.grids.map((g) => g.id).join(', ')})`,
	);
}

// --- tool result shapes ------------------------------------------------------------------------

export interface ListSheetsResult {
	sessionId: string;
	sheets: SheetInfoJson[];
}

export interface GetCellResult {
	sessionId: string;
	sheet: number;
	row: number;
	col: number;
	/** Absent when the cell is empty (no value, no formula). */
	value?: CellValueJson;
	formula?: string;
	rendered?: string;
}

export interface QueryRangeResult {
	sessionId: string;
	range: CellRangeJson;
	nRows: number;
	nCols: number;
	/** Column-major: `columns[c].values[r]` is the cell at (startRow+r, startCol+c). */
	columns: { values: CellValueJson[] }[];
}

export interface GetSnapshotResult {
	sessionId: string;
	cellCount: number;
	sheets: WorkbookSnapshotJson['sheets'];
}

export interface ListFunctionsResult {
	sessionId: string;
	count: number;
	functions: FunctionMetadataJson[];
}

export interface ListNamedRangesResult {
	sessionId: string;
	count: number;
	names: NamedRangeJson[];
}

export interface ListTablesResult {
	sessionId: string;
	count: number;
	tables: TableSnapshotJson[];
}

export interface GetUsedRangeResult {
	sessionId: string;
	sheet: number;
	/** The used range, or `null` when the sheet has no value cell (empty / all-blank). */
	usedRange: UsedRangeJson | null;
	/** A sheet-qualified A1 string for display -- present ONLY when `usedRange` is non-null. */
	a1Range?: string;
}

export interface PublishedVariableResult {
	name: string;
	sheet: number;
	/** The sheet-qualified A1 range the variable drives, e.g. "S0!B1:D3" (or "S0!B1" for a single cell). */
	a1Range: string;
	range: CellRangeJson;
}

export interface GetPublishedVariablesResult {
	sessionId: string;
	variables: PublishedVariableResult[];
}

/**
 * **FE-6 M (2026-06-12)**: result of `validate_formula` -- the engine diagnostics for a dry-run parse+bind.
 * `valid` is `diagnostics.length === 0` (a convenience the agent can branch on). `sheet`/`row`/`col` echo
 * the position the formula was validated at (relative refs bind relative to it). An empty `diagnostics`
 * means the formula is well-formed + binds; a non-empty list carries each parse/bind problem.
 */
export interface ValidateFormulaResult {
	sessionId: string;
	sheet: number;
	row: number;
	col: number;
	valid: boolean;
	diagnostics: DiagnosticJson[];
}

// --- the six read-only tool handlers (pure) ----------------------------------------------------

/** list_sheets: every live (non-tombstoned) sheet of the target grid's workbook. */
export function toolListSheets(ctx: McpHostContext, args: { sessionId?: string }): ListSheetsResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	return { sessionId: grid.id, sheets: grid.session.listSheets() };
}

/**
 * get_cell: read one cell by A1. The cell may be addressed sheet-qualified ("S0!B1") or with a separate
 * `sheet` arg; with neither, the grid's focused sheet is used. An empty cell yields a result with no
 * value/formula (the cell genuinely has none -- NOT an error).
 */
export function toolGetCell(ctx: McpHostContext, args: { sessionId?: string; a1: string; sheet?: number | string }): GetCellResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const range = resolveCellTarget(grid, sheets, args.a1, args.sheet);
	const snap = grid.session.cell(range.sheet, range.startRow, range.startCol);
	const result: GetCellResult = { sessionId: grid.id, sheet: range.sheet, row: range.startRow, col: range.startCol };
	if (snap !== null) {
		if (snap.value !== undefined) {
			result.value = snap.value;
		}
		if (snap.formula !== undefined) {
			result.formula = snap.formula;
		}
		if (snap.rendered !== undefined) {
			result.rendered = snap.rendered;
		}
	}
	return result;
}

/**
 * Resolve a single-cell A1 target for get_cell: like {@link resolveRangeTarget} but the ref must be a
 * single cell (a range "B1:D3" is rejected loud), and a bare ref with no `sheet` arg falls back to the
 * grid's FOCUSED sheet (get_cell's convenience -- query_range requires an explicit sheet).
 */
function resolveCellTarget(grid: McpTargetGrid, sheets: SheetInfoJson[], a1: string, sheet?: number | string): CellRangeJson {
	const effectiveSheet = sheet === undefined && !a1.includes('!') ? grid.sheet : sheet;
	const range = resolveRangeTarget(sheets, a1, effectiveSheet);
	if (range.startRow !== range.endRow || range.startCol !== range.endCol) {
		throw new McpToolError('bad_a1', `get_cell expects a single cell, got a range: "${a1}" (use query_range for ranges)`);
	}
	return range;
}

/**
 * query_range (PRIMARY read): a columnar value read of a rectangular range. The range is sheet-qualified
 * ("S0!B1:D3") or bare with a `sheet` arg. All include* options are false (the v1 engine surface);
 * out-of-extent / inverted ranges fail loud inside the engine's queryRange and surface to the agent.
 */
export function toolQueryRange(ctx: McpHostContext, args: { sessionId?: string; range: string; sheet?: number | string }): QueryRangeResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const range = resolveRangeTarget(sheets, args.range, args.sheet);
	const result = grid.session.queryRange(range, { includeFormulas: false, includeFormats: false, includeRendered: false });
	return {
		sessionId: grid.id,
		range: result.range,
		nRows: result.nRows,
		nCols: result.nCols,
		columns: result.columns.map((c) => ({ values: c.values })),
	};
}

/**
 * get_snapshot: the full workbook (or one sheet) as snapshot cells. CAPPED at {@link SNAPSHOT_CELL_CAP}
 * -- over the cap it FAILS LOUD pointing the agent at query_range (No-Fallbacks: never silently
 * truncate). An optional `sheet` scopes to a single sheet (count + cap apply to just that sheet).
 */
export function toolGetSnapshot(ctx: McpHostContext, args: { sessionId?: string; sheet?: number | string }): GetSnapshotResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const snapshot = grid.session.snapshot();
	let sheets = snapshot.sheets;
	if (args.sheet !== undefined) {
		const sheetId = resolveSheetId(grid.session.listSheets(), args.sheet);
		sheets = sheets.filter((s) => s.id === sheetId);
	}
	const cellCount = sheets.reduce((sum, s) => sum + s.cells.length, 0);
	if (cellCount > SNAPSHOT_CELL_CAP) {
		throw new McpToolError(
			'snapshot_too_large',
			`snapshot has ${cellCount} cells, over the ${SNAPSHOT_CELL_CAP} cap -- read a bounded region with query_range instead`,
		);
	}
	return { sessionId: grid.id, cellCount, sheets };
}

/** list_functions: every registered engine function + UDF, sorted by canonical name (engine order). */
export function toolListFunctions(ctx: McpHostContext, args: { sessionId?: string }): ListFunctionsResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const functions = grid.session.listFunctions();
	return { sessionId: grid.id, count: functions.length, functions };
}

/**
 * list_named_ranges: every defined name in the target grid's workbook (workbook- + sheet-scoped) and
 * its target (cell / range / constant / formula), as the engine returns them. Empty when no names are
 * defined (a true empty -- NOT an error). Reads the cheap {@link McpSessionPort.listNames} getter, so it
 * never materializes the full workbook (safe on a 1M-cell sheet).
 */
export function toolListNamedRanges(ctx: McpHostContext, args: { sessionId?: string }): ListNamedRangesResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const names = grid.session.listNames();
	return { sessionId: grid.id, count: names.length, names };
}

/**
 * list_tables: every structured table in the target grid's workbook (canonical + display name, anchor
 * sheet, footprint, header/totals flags), sorted by (sheet, name). Empty when no tables are defined (a
 * true empty -- NOT an error). Reads the cheap {@link McpSessionPort.listTables} getter, so it never
 * materializes the full workbook (safe on a 1M-cell sheet). This is the read tool L1 deferred for the
 * lack of a non-snapshot table getter.
 */
export function toolListTables(ctx: McpHostContext, args: { sessionId?: string }): ListTablesResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const tables = grid.session.listTables();
	return { sessionId: grid.id, count: tables.length, tables };
}

/**
 * get_used_range: the effective VALUE extent (the inclusive bounding box, anchored at A1, of the
 * non-blank value cells) of one sheet -- the focused sheet by default, or the `sheet` arg (name or id).
 * `usedRange` is `null` when the sheet has no value cell (an empty / all-blank sheet -- a true empty,
 * NOT an error); otherwise an `a1Range` display string is included. This is the range to feed to
 * query_range to read every datum on the sheet. An unknown sheet selector throws `[unknown_sheet]`
 * (never silently defaults).
 */
export function toolGetUsedRange(ctx: McpHostContext, args: { sessionId?: string; sheet?: number | string }): GetUsedRangeResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const sheetId = args.sheet === undefined ? grid.sheet : resolveSheetId(sheets, args.sheet);
	const usedRange = grid.session.usedRange(sheetId);
	const result: GetUsedRangeResult = { sessionId: grid.id, sheet: sheetId, usedRange };
	if (usedRange !== null) {
		const sheetName = sheets.find((s) => s.id === sheetId)?.name;
		result.a1Range = formatA1Range(sheetName, usedRange);
	}
	return result;
}

/**
 * get_published_variables: the reactive-kernel variables currently published into the target grid's
 * workbook and the cells each drives. Empty when no reactive notebook is bound (a true empty -- the
 * grid simply has no published variables, NOT an error). Each entry carries both a sheet-qualified A1
 * string (for display) and the structured range.
 */
export function toolGetPublishedVariables(ctx: McpHostContext, args: { sessionId?: string }): GetPublishedVariablesResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	const sheets = grid.session.listSheets();
	const sheetNameById = new Map(sheets.map((s) => [s.id, s.name]));
	const published = ctx.publishedVariables(grid.session);
	const variables: PublishedVariableResult[] = published.map((p) => ({
		name: p.name,
		sheet: p.range.sheet,
		a1Range: formatA1Range(sheetNameById.get(p.range.sheet), p.range),
		range: p.range,
	}));
	return { sessionId: grid.id, variables };
}

/**
 * validate_formula: dry-run a formula through the engine's parse+bind WITHOUT mutating. Returns the
 * {@link DiagnosticJson}`[]` (empty = valid) so an agent can check a formula before a `set_cell`/`write_cells`
 * write. The formula is validated AT a position (relative refs bind relative to it): `a1` gives that
 * position (sheet-qualified or with a `sheet` arg / the grid's focused sheet); with no `a1`, A1 of the
 * resolved sheet is used. A leading "=" in `formula` is stripped (the engine expects the BODY). The engine
 * returns diagnostics as DATA -- a malformed formula does NOT throw here; only a resolution failure (bad
 * sheet / bad a1) throws loud (No-Fallbacks).
 */
export function toolValidateFormula(ctx: McpHostContext, args: { sessionId?: string; formula: string; sheet?: number | string; a1?: string }): ValidateFormulaResult {
	const grid = resolveTargetGrid(ctx, args.sessionId);
	if (typeof args.formula !== 'string') {
		throw new McpToolError('bad_argument', 'validate_formula: `formula` must be a string');
	}
	const sheets = grid.session.listSheets();
	// Resolve the validation position. With an a1, reuse the get_cell single-cell resolution (sheet-
	// qualified or sheet-arg or focused-sheet fallback). With no a1, validate at A1 of the resolved sheet
	// (the sheet arg, else the focused sheet) -- a stable default position for relative-ref binding.
	let sheetId: number;
	let row: number;
	let col: number;
	if (args.a1 !== undefined) {
		const range = resolveCellTarget(grid, sheets, args.a1, args.sheet);
		sheetId = range.sheet;
		row = range.startRow;
		col = range.startCol;
	} else {
		sheetId = resolveSheetId(sheets, args.sheet ?? grid.sheet);
		row = 0;
		col = 0;
	}
	// The engine expects the formula BODY (no leading "="). trimStart FIRST, then strip ONE optional
	// leading "=", and validate THAT trimmed body in BOTH branches (Opus LOW: the no-"=" branch
	// previously validated the UN-trimmed original -- inconsistent leading-whitespace handling). So an
	// agent may pass "=SUM(A1:A9)", "SUM(A1:A9)", or a leading-whitespace variant and get the same body.
	const trimmed = args.formula.trimStart();
	const body = trimmed.startsWith('=') ? trimmed.slice(1) : trimmed;
	const diagnostics = grid.session.validateFormula(sheetId, row, col, body);
	return { sessionId: grid.id, sheet: sheetId, row, col, valid: diagnostics.length === 0, diagnostics };
}

/**
 * Format a structured range back to a sheet-qualified A1 string ("S0!B1:D3", or "S0!B1" for a single
 * cell). An unknown sheet id (the variable's sheet was deleted under it) renders as `#REF!<id>` rather
 * than throwing -- this is a display string in a list result, and failing the whole enumeration because
 * one variable's sheet vanished would be a worse contract than surfacing the dangling ref visibly.
 */
function formatA1Range(sheetName: string | undefined, range: CellRangeJson): string {
	const name = sheetName ?? `#REF!${range.sheet}`;
	const tl = `${columnIndexToLetters(range.startCol)}${range.startRow + 1}`;
	if (range.startRow === range.endRow && range.startCol === range.endCol) {
		return `${name}!${tl}`;
	}
	const br = `${columnIndexToLetters(range.endCol)}${range.endRow + 1}`;
	return `${name}!${tl}:${br}`;
}

/** 0-based column index -> bijective base-26 letters (0 -> "A", 26 -> "AA"). Inverse of {@link colLettersToIndex}. */
export function columnIndexToLetters(col: number): string {
	let n = Math.floor(col);
	if (n < 0) {
		return '';
	}
	let label = '';
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return label;
}
