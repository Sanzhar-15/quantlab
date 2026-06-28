/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-BEYOND B1 -- the VS Code host shell for the read-only Quantbook MCP server.
//
// Runs an MCP server IN the extension host so its tools read the SAME live per-panel napi `Session`
// the grid renders -- that shared-state requirement is why this is in-host and NOT the separate
// ql-service HTTP engine (which does not see the live in-host workbook). It is the thin adapter over
// the vscode-free tool layer (mcpToolLogic.ts): it resolves the live grids FRESH on every tool call
// via the CellGridPanel accessors + the reactive kernel manager, and wires the official
// @modelcontextprotocol/sdk over a localhost Streamable-HTTP transport.
//
// Transport: localhost (127.0.0.1) Streamable HTTP in STATELESS JSON mode -- a fresh McpServer +
// StreamableHTTPServerTransport per POST, torn down on response close. Stateless suits a read-only,
// no-subscription tool surface and keeps zero cross-request state (the isolation the brief calls for;
// MCP is kept off the panel's single delta cursor for performance + isolation, reading via the shared
// snapshot/queryRange cache instead).
//
// ESM/CJS seam: the SDK is ESM-only and this extension compiles to CommonJS. It is loaded via a
// dynamic import() that TypeScript must NOT down-compile to require() -- the `new Function('s','return
// import(s)')` hatch preserves a real ESM import at runtime (verified on the Node 22 host). zod (v3)
// builds the tool input schemas.
//
// No-Fallbacks: a tool whose pure handler throws (no grid / ambiguous grid / unknown sheet / bad A1 /
// snapshot over cap) returns an MCP in-band error result (isError) carrying the thrown message
// verbatim -- the agent SEES the failure; nothing is masked or defaulted. A bind/listen failure on
// start rejects loud.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { ReactiveKernelManager } from '../reactiveKernel/reactiveKernelManager';
import { recalcDirtyChecked } from '../session';
import { TrustManager } from '../../core/trust/TrustManager';
import type { SessionInstance } from '../types';
import {
	McpToolError,
	toolGetCell,
	toolGetPublishedVariables,
	toolGetSnapshot,
	toolGetUsedRange,
	toolListFunctions,
	toolListNamedRanges,
	toolListSheets,
	toolListTables,
	toolQueryRange,
	toolValidateFormula,
	type McpHostContext,
	type McpSessionPort,
	type McpTargetGrid,
	type PublishedVariableTargets,
} from './mcpToolLogic';
import {
	classifyWriteRisk,
	formatAuditLine,
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
	WriteQueue,
	type AddSheetArgs,
	type DefineNamedRangeArgs,
	type DefineTableArgs,
	type DeleteNamedRangeArgs,
	type DeleteSheetArgs,
	type DeleteStructuralArgs,
	type DeleteTableArgs,
	type InsertStructuralArgs,
	type McpWriteSessionPort,
	type PreparedWrite,
	type RenameSheetArgs,
	type SetCellArgs,
	type SetNumberFormatArgs,
	type SetStyleArgs,
	type UndoRedoArgs,
	type WriteAuditRecord,
	type WriteCellsArgs,
	type WriteOutcome,
} from './mcpWriteLogic';

// The ESM-import hatch: a Function-constructed dynamic import so the TypeScript CommonJS emit does NOT
// rewrite it to require() (which would throw on the ESM-only SDK). Resolves bare specifiers relative to
// this compiled module, so the package-root node_modules is found. The Function ctor is the documented,
// intentional CJS->ESM bridge here (not arbitrary code-eval); the argument is a fixed literal.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

// Minimal structural types for the dynamically-imported SDK surface (we cannot `import type` from an
// ESM-only package under CommonJS module resolution without NodeNext; these mirror the verified v1.29
// .d.ts shapes we use).
interface McpToolContent {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
}
interface McpServerLike {
	registerTool(
		name: string,
		config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
		cb: (args: Record<string, unknown>) => McpToolContent | Promise<McpToolContent>,
	): unknown;
	connect(transport: unknown): Promise<void>;
	close(): Promise<void>;
}
interface McpServerCtor {
	new(info: { name: string; version: string }): McpServerLike;
}
interface StreamableTransportLike {
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: unknown): Promise<void>;
	close(): Promise<void>;
}
interface StreamableTransportCtor {
	new(options: { sessionIdGenerator: undefined; enableJsonResponse: boolean }): StreamableTransportLike;
}
/** A chainable zod schema stub: the subset of the builder API the tool schemas use. */
interface ZodSchemaLike {
	optional(): ZodSchemaLike;
	describe(description: string): ZodSchemaLike;
}
interface ZodLike {
	string(): ZodSchemaLike;
	number(): ZodSchemaLike;
	boolean(): ZodSchemaLike;
	union(options: ZodSchemaLike[]): ZodSchemaLike;
	array(element: ZodSchemaLike): ZodSchemaLike;
	object(shape: Record<string, ZodSchemaLike>): ZodSchemaLike;
}

interface LoadedSdk {
	McpServer: McpServerCtor;
	StreamableHTTPServerTransport: StreamableTransportCtor;
	z: ZodLike;
}

let sdkPromise: Promise<LoadedSdk> | undefined;
/** Load (once, memoized) the ESM-only SDK + zod. A failure here is fatal to THIS start attempt, but the
 *  memoized promise is CLEARED on failure (Codex LOW) so a later Start retries the load rather than
 *  replaying a permanently-rejected promise. The memoization holds only a SUCCESSFUL load. */
async function loadSdk(): Promise<LoadedSdk> {
	if (sdkPromise === undefined) {
		sdkPromise = (async (): Promise<LoadedSdk> => {
			const mcpMod = (await importEsm('@modelcontextprotocol/sdk/server/mcp.js')) as { McpServer: McpServerCtor };
			const trMod = (await importEsm('@modelcontextprotocol/sdk/server/streamableHttp.js')) as { StreamableHTTPServerTransport: StreamableTransportCtor };
			const zodMod = (await importEsm('zod')) as { z?: ZodLike; default?: ZodLike };
			const z = zodMod.z ?? zodMod.default;
			if (z === undefined) {
				throw new Error('[mcp_sdk_load] zod did not export a usable `z` -- check the installed zod version (v3 expected)');
			}
			return { McpServer: mcpMod.McpServer, StreamableHTTPServerTransport: trMod.StreamableHTTPServerTransport, z };
		})();
		sdkPromise.catch(() => {
			sdkPromise = undefined;
		});
	}
	return sdkPromise;
}

/** The MCP server binds to loopback only -- it must never be reachable off-host. */
const MCP_HOST = '127.0.0.1';
/** The HTTP path the MCP endpoint serves. */
const MCP_PATH = '/mcp';

/**
 * STABLE per-Session id assignment (Codex HIGH fold). A grid id MUST identify the SAME workbook for the
 * life of the host, never recycling a closed session's number onto a new one -- else a client reusing a
 * stale `sessionId` would silently read a DIFFERENT workbook (a No-Fallbacks "silent retarget"). The id
 * is derived from the napi Session IDENTITY via a WeakMap + a monotonic counter that never reuses a
 * value; the WeakMap lets a closed Session's entry be GC'd without ever re-minting its ordinal.
 */
const sessionIdByInstance = new WeakMap<SessionInstance, number>();
let nextSessionOrdinal = 0;
function stableSessionOrdinal(session: SessionInstance): number {
	let ordinal = sessionIdByInstance.get(session);
	if (ordinal === undefined) {
		ordinal = nextSessionOrdinal++;
		sessionIdByInstance.set(session, ordinal);
	}
	return ordinal;
}

/**
 * Build the per-call host context from the LIVE CellGridPanel registry + the reactive kernel manager.
 * Resolved fresh on every tool invocation (panels open/close between calls). The grid `id` is a
 * monotonic per-Session ordinal (never recycled -- see {@link stableSessionOrdinal}) plus the sheet, so
 * two workbooks showing the same sheet get distinct ids and a stale id never resolves to a new workbook.
 */
function buildHostContext(kernelManager: ReactiveKernelManager<SessionInstance>): McpHostContext {
	const panels = CellGridPanel.activeLocalPanels();
	const grids: McpTargetGrid[] = panels.map((p) => ({
		id: `grid-${stableSessionOrdinal(p.session)}-sheet-${p.sheet}`,
		session: p.session as McpSessionPort,
		sheet: p.sheet,
	}));
	const focused = CellGridPanel.focusedLocalPanel();
	let focusedId: string | undefined;
	if (focused !== undefined) {
		const match = grids.find((g) => g.session === (focused.session as McpSessionPort) && g.sheet === focused.sheet);
		focusedId = match?.id;
	}
	// Map the McpSessionPort back to the real SessionInstance to query the kernel manager. The port IS
	// the SessionInstance (structural), so the identity match holds.
	const portToSession = new Map<McpSessionPort, SessionInstance>(panels.map((p) => [p.session as McpSessionPort, p.session]));
	return {
		grids,
		focusedId,
		publishedVariables(session: McpSessionPort): PublishedVariableTargets[] {
			const real = portToSession.get(session);
			if (real === undefined) {
				return [];
			}
			// Enumerate the COMPLETE published set (every sheet, incl. a now-deleted one -- Codex MED:
			// the prior per-live-sheet walk silently dropped a variable on a tombstoned sheet, which the
			// pure formatter's #REF! path then never saw). The accessor carries each range's sheet id.
			return kernelManager.publishedCellsForAllSheets(real).map((e) => ({
				name: e.range.name,
				range: { sheet: e.sheet, startRow: e.range.startRow, startCol: e.range.startCol, endRow: e.range.endRow, endCol: e.range.endCol },
				// TE1: false for a structurally-invalidated binding (the tool flags it rather than presenting
				// a dead binding as a live published variable).
				alive: e.alive,
			}));
		},
	};
}

/** Wrap a pure tool handler: run it, JSON-serialize the result, convert a thrown error to an MCP
 *  in-band error result (isError) carrying the message verbatim (No-Fallbacks -- the agent sees it). */
function runTool<A>(handler: (ctx: McpHostContext, args: A) => unknown, ctx: McpHostContext, args: A): McpToolContent {
	try {
		const result = handler(ctx, args);
		return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
	} catch (err) {
		const message = err instanceof McpToolError ? err.message : err instanceof Error ? err.message : String(err);
		return { content: [{ type: 'text', text: message }], isError: true };
	}
}

/** Register the read-only tools on a fresh McpServer, each resolving the live host context on call. */
function registerReadOnlyTools(server: McpServerLike, sdk: LoadedSdk, kernelManager: ReactiveKernelManager<SessionInstance>): void {
	const { z } = sdk;
	const sessionIdArg = { sessionId: z.string().describe('Optional Cell Grid id to target when several are open (from a prior tool result).').optional() };
	const ctx = (): McpHostContext => buildHostContext(kernelManager);

	server.registerTool(
		'list_sheets',
		{ title: 'List sheets', description: 'List the live sheets (id + name) of the focused (or named) Quantbook Cell Grid workbook.', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolListSheets, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'get_cell',
		{
			title: 'Get cell',
			description: 'Read one cell by A1 reference. Address it sheet-qualified ("S0!B1") or pass a separate sheet arg; with neither, the grid\'s focused sheet is used. Returns value, formula, and rendered display string (any may be absent for an empty cell).',
			inputSchema: { a1: z.string().describe('The A1 cell, e.g. "B1" or sheet-qualified "S0!B1".'), sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id (ignored if the A1 is sheet-qualified).').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolGetCell, ctx(), args as { sessionId?: string; a1: string; sheet?: number | string }),
	);

	server.registerTool(
		'query_range',
		{
			title: 'Query range (primary read)',
			description: 'Read a rectangular range as columnar values -- the PRIMARY, efficient read. Range is sheet-qualified ("S0!B1:D3") or bare with a sheet arg. Returns nRows, nCols, and column-major values. Prefer this over get_snapshot.',
			inputSchema: { range: z.string().describe('The A1 range, e.g. "S0!B1:D3" (sheet-qualified) or "B1:D3" with a sheet arg.'), sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id (ignored if the range is sheet-qualified).').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolQueryRange, ctx(), args as { sessionId?: string; range: string; sheet?: number | string }),
	);

	server.registerTool(
		'get_snapshot',
		{
			title: 'Get snapshot (capped)',
			description: 'Read the full workbook (or one sheet) as snapshot cells. CAPPED -- a workbook over the cell cap fails loud; use query_range for large or 1M-cell sheets. Optionally scope to one sheet.',
			inputSchema: { sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id to scope the snapshot to a single sheet.').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolGetSnapshot, ctx(), args as { sessionId?: string; sheet?: number | string }),
	);

	server.registerTool(
		'list_functions',
		{ title: 'List functions', description: 'List every registered engine function and user-defined function (canonical name, arity, volatility, ...), sorted by name.', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolListFunctions, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'list_named_ranges',
		{ title: 'List named ranges', description: 'List every defined name in the workbook -- BOTH workbook-scoped and sheet-scoped -- and the target each resolves to (a cell, range, constant, or formula). Empty when no names are defined (a true empty, NOT an error).', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolListNamedRanges, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'list_tables',
		{ title: 'List tables', description: 'List every structured table in the workbook -- canonical + display name, anchor sheet, footprint (rows x cols), and header/totals flags -- sorted by (sheet, name). Empty when no tables are defined (a true empty, NOT an error). A cheap read that does NOT materialize cells.', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolListTables, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'get_used_range',
		{
			title: 'Get used range',
			description: 'The effective VALUE extent of a sheet -- the inclusive bounding box (anchored at A1) of its non-blank value cells -- as both a structured range and a sheet-qualified A1 string. Returns usedRange = null when the sheet is empty / all-blank (a true empty, NOT an error). Defaults to the focused sheet; pass a sheet name or id to target another. Feed the result to query_range to read all data. NB a format-only cell or a blank-valued formula does NOT widen the extent.',
			inputSchema: { sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id; defaults to the grid\'s focused sheet.').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolGetUsedRange, ctx(), args as { sessionId?: string; sheet?: number | string }),
	);

	server.registerTool(
		'get_published_variables',
		{ title: 'Get published variables', description: 'List the reactive-kernel variables currently published into the grid and the A1 cells each drives (empty if no reactive notebook is bound).', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolGetPublishedVariables, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'validate_formula',
		{
			title: 'Validate formula (dry-run)',
			description: 'Parse + bind a formula WITHOUT writing it -- returns engine diagnostics so an agent can dry-run a formula before set_cell/write_cells. `formula` may carry a leading "=" or not. Relative refs bind relative to the validation position: pass `a1` (sheet-qualified "S0!B1" or bare with a sheet arg) -- with none, A1 of the resolved sheet is used. Returns `{ valid, diagnostics[] }`: an empty diagnostics list means the formula is well-formed and binds; otherwise each parse/bind problem is listed (this is DATA, not an error).',
			inputSchema: {
				formula: z.string().describe('The formula to validate, e.g. "=SUM(A1:A9)" or "SUM(A1:A9)" (a leading "=" is optional).'),
				a1: z.string().describe('Optional A1 position the formula is validated at (relative refs bind relative to it), e.g. "B1" or "S0!B1".').optional(),
				sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id (ignored if the a1 is sheet-qualified).').optional(),
				...sessionIdArg,
			},
		},
		(args) => runTool(toolValidateFormula, ctx(), args as { sessionId?: string; formula: string; sheet?: number | string; a1?: string }),
	);
}

// --- WRITE tools (W3) --------------------------------------------------------------------------

/**
 * The ONE per-host write queue: every MCP write serializes per Session through this. Module-level (not
 * per-POST) because the stateless transport mints a fresh server per request -- only a host-lifetime
 * singleton can serialize writes that arrive on independent POSTs. Keyed by the live SessionInstance
 * identity (a WeakMap inside, so a closed session's chain is GC'd). See {@link WriteQueue} for the
 * Arc<Mutex> concurrency invariant.
 */
const mcpWriteQueue = new WriteQueue<SessionInstance>();

/**
 * Trust gate for WRITES (gate-first; mirrors `reactiveKernelCommands.assertReactiveTrusted`). A write
 * mutates the live, possibly-unsaved financial workbook, so it requires BOTH VS Code Restricted-Mode
 * trust AND QuantLab's own {@link TrustManager} grant for the workspace folder -- the SAME mechanism the
 * reactive kernel uses (the grant persists in `context.globalState` per-workspace; verified -- NOT
 * SecureStorage). Reuses TrustManager rather than forking a parallel consent store (no split-brain).
 * Reads stay ungated. No-Fallbacks: an untrusted workspace throws a loud, agent-visible error.
 */
function assertMcpWriteTrusted(): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) {
		throw new McpToolError('mcp_write_untrusted_workspace', 'open a workspace folder and trust it to enable MCP writes');
	}
	const uri = folder.uri.toString();
	if (!(vscode.workspace.isTrusted && TrustManager.getInstance().isWorkspaceTrusted(uri))) {
		throw new McpToolError(
			'mcp_write_untrusted_workspace',
			'an MCP write mutates the live workbook -- trust the workspace (Quantbook: Trust Workspace for MCP Writes) to enable it',
		);
	}
}

/** A monotonic counter that backs the audit timestamp when the host has no wall clock to trust (it does;
 *  the ISO time is primary). Kept as a tie-breaker so two writes in the same millisecond stay ordered. */
let auditSeq = 0;

/** Whether `session` is STILL a live open Cell Grid panel (mirror reactiveNotebookController.isLiveGridSession).
 *  A write is `prepare()`d on the request tick but applied later inside the queue (after the modal await);
 *  in that window the panel can close. Re-checking here means a write to a since-closed grid fails LOUD
 *  (No-Fallbacks) instead of mutating an orphaned, no-longer-rendered workbook handle invisibly. */
function isLiveGridSession(session: SessionInstance): boolean {
	return CellGridPanel.activeLocalPanels().some((p) => p.session === session);
}

/** Append one structured audit line to the MCP output channel (No-Fallbacks: every attempt is recorded). */
function appendAudit(output: vscode.OutputChannel, record: WriteAuditRecord): void {
	output.appendLine(formatAuditLine(record));
}

/**
 * Apply a prepared write end-to-end ON the queue: re-validate trust + re-classify risk LIVE (the grid
 * state can change between prepare() at request time and apply() here, behind the modal + other queued
 * rounds) -> (optional) modal confirmation -> the LIVE write discipline (`batch(ops, { undoLabel })` ->
 * {@link recalcDirtyChecked} -> {@link CellGridPanel.refreshSession}) -> audit. Runs inside
 * {@link WriteQueue.enqueue} so concurrent agent rounds serialize per session. Returns the agent result;
 * a declined confirmation returns a declined result (not an error -- the operator's choice is a normal
 * outcome the agent sees); a failed batch / lost-trust / closed-grid throws (No-Fallbacks; the engine
 * reverts atomically). EVERY terminal outcome (applied / declined / failed) is audited.
 */
async function applyPreparedWrite(
	prepared: PreparedWrite,
	tool: string,
	output: vscode.OutputChannel,
): Promise<{ applied: number; declined: boolean; risk: string }> {
	// The real SessionInstance: buildHostContext set `grid.session = p.session` (the napi SessionInstance),
	// narrowed to the read port. It satisfies McpWriteSessionPort structurally; the cast restores `batch`.
	const writeSession = prepared.grid.session as unknown as McpWriteSessionPort;
	const realSession = prepared.grid.session as unknown as SessionInstance;
	// FE-6 M: thread `prepared.structural` so a structural edit (insert/delete rows/columns) ALWAYS
	// re-classifies with the SILENT-DATA-CORRUPTION `structural` reason (the modal always shows).
	const reclassify = (): ReturnType<typeof classifyWriteRisk> =>
		classifyWriteRisk(prepared.ops, (sheet, row, col) => prepared.grid.session.cell(sheet, row, col), { structural: prepared.structural === true, metadata: prepared.metadataRisk });
	const recordFor = (risk: string): Omit<WriteAuditRecord, 'outcome' | 'detail'> => ({
		timestamp: `${new Date().toISOString()}#${auditSeq++}`,
		tool,
		sessionId: prepared.grid.id,
		undoLabel: prepared.undoLabel,
		opCount: prepared.ops.length,
		target: prepared.target,
		risk,
	});

	// Codex HIGH-1: RE-CLASSIFY risk against the CURRENT cell state, not the request-time snapshot, so the
	// modal shows the live risk. An earlier queued write / live grid edit / reactive publish could have
	// turned a target into a formula AFTER prepare(); the stale verdict would skip the modal.
	const preModalRisk = reclassify();

	// Codex HIGH-2 (pre-modal): fail-fast if trust was already lost before we even prompt.
	try {
		assertMcpWriteTrusted();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		appendAudit(output, { ...recordFor(preModalRisk.summary), outcome: 'failed' satisfies WriteOutcome, detail: `trust lost before apply: ${detail}` });
		throw err;
	}

	// Risk-based confirmation: a large / destructive / formula-overwrite batch needs an explicit modal OK.
	// This await runs INSIDE the per-session queue, so while the modal is open the SAME session's later
	// write rounds STALL behind it (the documented queue stall) -- exactly what we want: we never apply a
	// queued round B's batch while round A is still awaiting operator consent. (Other sessions proceed.)
	// The SPECIFIC risk reasons the operator actually saw + OK'd in the modal (empty if no modal was shown).
	// We compare the FINAL reasons against THIS set, not a coarse boolean -- see the uncovered-reason check.
	let confirmedReasons: ReadonlySet<string> = new Set();
	if (preModalRisk.requiresConfirmation) {
		const choice = await vscode.window.showWarningMessage(
			`An AI agent wants to write to the live workbook: ${preModalRisk.summary}.\n\nUndo label: "${prepared.undoLabel}".\n\nAllow this write?`,
			{ modal: true },
			'Allow Write',
		);
		if (choice !== 'Allow Write') {
			appendAudit(output, { ...recordFor(preModalRisk.summary), outcome: 'declined' satisfies WriteOutcome, detail: 'operator declined the confirmation' });
			return { applied: 0, declined: true, risk: preModalRisk.summary };
		}
		confirmedReasons = new Set(preModalRisk.reasons);
	}

	// Codex re-audit HIGH/MED: the modal await reopened the TOCTOU window. Re-validate trust AND re-classify
	// risk a SECOND time, immediately before the engine write -- this is the AUTHORITATIVE check. Anything
	// granted/computed before the await may now be stale (trust revoked while the dialog was open; a formula
	// appeared under a target during the dialog). This recompute + re-check happens with NO further await
	// before batch(), so it cannot itself go stale (the engine lock + the per-session queue keep other
	// writes out until this round's batch lands).
	try {
		assertMcpWriteTrusted();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		appendAudit(output, { ...recordFor(preModalRisk.summary), outcome: 'failed' satisfies WriteOutcome, detail: `trust lost before apply: ${detail}` });
		throw err;
	}
	const finalRisk = reclassify();
	// Codex re-audit2 HIGH: refuse if the FINAL risk carries ANY reason the shown modal did NOT cover -- a
	// coarse `requiresConfirmation && !confirmed` would let, say, a `formula_overwrite` that appeared during
	// a modal shown only for `large` slip through. Compare the specific reason SETS: any final reason not in
	// `confirmedReasons` is an unconfirmed elevated write -> refuse LOUD (No-Fallbacks). The agent retries;
	// the next round prompts on the now-current state. (When no modal was shown, confirmedReasons is empty,
	// so ANY final reason refuses -- the original "risk appeared from nothing" case.)
	const uncovered = finalRisk.reasons.filter((r) => !confirmedReasons.has(r));
	if (uncovered.length > 0) {
		const detail = `risk changed during the confirmation step (uncovered: ${uncovered.join(', ')}; now: ${finalRisk.summary}); refused unconfirmed -- retry the write`;
		appendAudit(output, { ...recordFor(finalRisk.summary), outcome: 'failed' satisfies WriteOutcome, detail });
		throw new McpToolError('risk_escalated', detail);
	}

	// TOCTOU guard: the grid was resolved at request time but we apply here (possibly after the modal
	// await + behind other queued rounds). If its panel closed in that window, refuse LOUD rather than
	// mutate an orphaned workbook no panel renders (No-Fallbacks).
	if (!isLiveGridSession(realSession)) {
		const detail = 'the target Cell Grid was closed before the write could be applied';
		appendAudit(output, { ...recordFor(finalRisk.summary), outcome: 'failed' satisfies WriteOutcome, detail });
		throw new McpToolError('grid_closed', detail);
	}

	// The LIVE write discipline (mirror cellGridLogic.ts:620-623): ONE atomic write (a single undo unit),
	// then recalc dirty (throws loud on a failed recompute), then re-render every panel of the session.
	// A failed write throws -> the queued round rejects -> the tool returns an MCP error (No-Fallbacks;
	// the engine's batch is all-or-nothing, so NOTHING is partially applied).
	//
	// FE-6 M: the APPLY STRATEGY. `prepared.commit` (when present) runs the napi side effect -- a
	// registerStyle/registerFormat intern + a setStyle/setFormat batch, or a DIRECT structural napi call
	// (insertRows/deleteColumns/...; the engine has no structural batch-op kind). When absent the default
	// is the cell-`batch(ops)` path (set_cell / write_cells). Either lands as ONE undo unit; either throw
	// propagates (the engine reverts atomically). The post-write recalc + refresh are identical for both.
	try {
		const result = prepared.commit !== undefined
			? prepared.commit(writeSession)
			: writeSession.batch(prepared.ops.map((o) => o.op), { undoLabel: prepared.undoLabel });
		recalcDirtyChecked(realSession);
		// Codex MED-2: refreshSession reports a per-panel render failure count; the live edit path surfaces
		// it LOUD (No-Fallbacks). The engine write already landed atomically (it cannot be un-applied), so
		// a render failure is an applied-but-stale-view outcome: warn the operator + audit it, never silently
		// report a clean success.
		const { failed } = CellGridPanel.refreshSession(realSession);
		if (failed > 0) {
			const detail = `applied, but ${failed} cell-grid panel(s) failed to re-render -- run "Quantbook: Refresh Cell Grid"`;
			appendAudit(output, { ...recordFor(finalRisk.summary), outcome: 'applied' satisfies WriteOutcome, detail });
			void vscode.window.showWarningMessage(`Quantbook MCP: ${detail}.`);
		} else {
			appendAudit(output, { ...recordFor(finalRisk.summary), outcome: 'applied' satisfies WriteOutcome });
		}
		return { applied: result.applied, declined: false, risk: finalRisk.summary };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		appendAudit(output, { ...recordFor(finalRisk.summary), outcome: 'failed' satisfies WriteOutcome, detail });
		throw err;
	}
}

/** Audit a write that was REJECTED before it could be prepared/applied (Codex MED-1): a trust-gate
 *  failure, or a prepare/op-build failure (bad A1, unknown sheet, duplicate cell, over-cap batch, no grid
 *  open). These return `isError` to the agent; without this line they would be invisible in the audit
 *  channel, violating "EVERY write attempt is recorded". The target/session may be unresolved, so the
 *  record carries `(unresolved)` placeholders -- the detail names the actual failure. */
function auditRejected(output: vscode.OutputChannel, tool: string, detail: string): void {
	appendAudit(output, {
		timestamp: `${new Date().toISOString()}#${auditSeq++}`,
		tool,
		sessionId: '(unresolved)',
		undoLabel: '(none)',
		opCount: 0,
		target: '(unresolved)',
		risk: '(not classified -- rejected before apply)',
		outcome: 'failed' satisfies WriteOutcome,
		detail,
	});
}

/**
 * Run a prepared-write tool: gate trust (sync, before enqueue), prepare (pure), then enqueue the apply on
 * the per-session queue. The trust gate + the pure `prepare` run on the calling tick so an untrusted /
 * malformed write fails fast WITHOUT taking a queue slot. A pre-enqueue failure is AUDITED (Codex MED-1)
 * then returned as an MCP in-band error result (the agent sees it). The post-enqueue path audits its own
 * terminal outcome inside {@link applyPreparedWrite} (so it is not double-logged here). A declined
 * confirmation -> a non-error text result stating the operator declined.
 */
async function runWriteTool(
	prepare: (ctx: McpHostContext) => PreparedWrite,
	tool: string,
	kernelManager: ReactiveKernelManager<SessionInstance>,
	output: vscode.OutputChannel,
): Promise<McpToolContent> {
	let prepared: PreparedWrite;
	try {
		// Pre-enqueue (trust gate + pure prepare). A failure here is audited as a rejected attempt, since
		// applyPreparedWrite (which owns the post-enqueue audit) never runs for it.
		assertMcpWriteTrusted();
		prepared = prepare(buildHostContext(kernelManager));
	} catch (err) {
		const message = err instanceof McpToolError ? err.message : err instanceof Error ? err.message : String(err);
		auditRejected(output, tool, message);
		return { content: [{ type: 'text', text: message }], isError: true };
	}
	try {
		const realSession = prepared.grid.session as unknown as SessionInstance;
		// `risk` is the LIVE verdict computed inside the queue (Codex LOW: NOT prepared.risk, which was the
		// stale request-time snapshot) -- so the agent's response mirrors what the modal/audit actually used.
		const { applied, declined, risk } = await mcpWriteQueue.enqueue(realSession, () => applyPreparedWrite(prepared, tool, output));
		if (declined) {
			return { content: [{ type: 'text', text: JSON.stringify({ ok: false, declined: true, reason: 'operator declined the write confirmation', risk }, null, 2) }] };
		}
		return { content: [{ type: 'text', text: JSON.stringify({ ok: true, sessionId: prepared.grid.id, applied, target: prepared.target, undoLabel: prepared.undoLabel, risk }, null, 2) }] };
	} catch (err) {
		// applyPreparedWrite already audited this terminal failure; just surface it to the agent.
		const message = err instanceof McpToolError ? err.message : err instanceof Error ? err.message : String(err);
		return { content: [{ type: 'text', text: message }], isError: true };
	}
}

/** Register the WRITE tools (set_cell, write_cells) on a fresh McpServer. Each gates trust + serializes
 *  on the per-session write queue. The kernel manager is captured so the host context (grids) resolves. */
function registerWriteTools(server: McpServerLike, sdk: LoadedSdk, kernelManager: ReactiveKernelManager<SessionInstance>, output: vscode.OutputChannel): void {
	const { z } = sdk;
	const sessionIdArg = { sessionId: z.string().describe('Optional Cell Grid id to target when several are open (from a prior tool result).').optional() };
	const sheetArg = { sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id (ignored if the A1 is sheet-qualified).').optional() };

	server.registerTool(
		'set_cell',
		{
			title: 'Set cell (write)',
			description: 'Write ONE cell of the live workbook. `text` is classified like a grid edit: a leading "=" is a FORMULA (e.g. "=SUM(A1:A9)"); an empty string CLEARS the cell; any other text is a literal value (number if numeric, else text). Address it sheet-qualified ("S0!B1") or pass a sheet arg; with neither, the grid\'s focused sheet is used. Requires a trusted workspace. A large/destructive/formula-overwrite write prompts the operator. The edit is one Ctrl+Z undo step.',
			inputSchema: {
				a1: z.string().describe('The A1 cell to write, e.g. "B1" or sheet-qualified "S0!B1".'),
				text: z.string().describe('The value or formula. "=..." is a formula; "" clears the cell; else a literal value.'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareSetCell(ctx, args as unknown as SetCellArgs), 'set_cell', kernelManager, output),
	);

	server.registerTool(
		'write_cells',
		{
			title: 'Write cells (batch write)',
			description: 'Write MANY cells atomically in ONE undo step. `cells` is an array of { a1, text } where each `text` is classified like set_cell ("=..." formula / "" clear / literal). Cells may be bare A1 (with a sheet arg) or sheet-qualified. The whole batch applies all-or-nothing: one bad cell rejects everything. Requires a trusted workspace; a large/destructive/formula-overwrite batch prompts the operator.',
			inputSchema: {
				cells: z.array(z.object({
					a1: z.string().describe('The A1 cell, e.g. "B1" or "S0!B1".'),
					text: z.string().describe('The value or formula for this cell.'),
				})).describe('The cells to write (each { a1, text }).'),
				undoLabel: z.string().describe('Optional short label for the single undo unit (e.g. "fill returns column").').optional(),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareWriteCells(ctx, args as unknown as WriteCellsArgs), 'write_cells', kernelManager, output),
	);

	// FE-6 M: STYLE + NUMBER-FORMAT writes. A single `a1` cell OR a `range`; the visual style / number
	// format is applied as ONE setStyle/setFormat batch (one undo unit). A style/format op never clears or
	// clobbers a formula, so only a `large` (>= 50-cell) target prompts the operator.
	const cellOrRangeArg = {
		a1: z.string().describe('A single A1 cell, e.g. "B1" or sheet-qualified "S0!B1". Pass EITHER a1 OR range (not both).').optional(),
		range: z.string().describe('An A1 range, e.g. "B1:D3" or "S0!B1:D3". Pass EITHER a1 OR range (not both).').optional(),
	};
	const borderEdgeSchema = z.object({
		style: z.string().describe('Border style: none|thin|medium|thick|dashed|dotted|double.'),
		color: z.object({ r: z.number(), g: z.number(), b: z.number() }).describe('RGB color, each channel 0..=255.'),
	});

	server.registerTool(
		'set_style',
		{
			title: 'Set cell style (write)',
			description: 'Set the VISUAL style (fill / bold / italic / align / per-edge borders) of a cell or range. Every `style` field is OPTIONAL and PATCHES that one attribute -- an absent field leaves it unchanged on each cell (e.g. setting bold on a red cell keeps the red). `align` is general|left|center|right. `borders` patches per edge {top?,bottom?,left?,right?}, each { style, color }. Does NOT touch cell values or formulas (never a formula-overwrite). Requires a trusted workspace; a large (>= 50-cell) target prompts the operator. One Ctrl+Z undo step.',
			inputSchema: {
				...cellOrRangeArg,
				style: z.object({
					fill: z.object({ r: z.number(), g: z.number(), b: z.number() }).describe('Fill RGB color, each channel 0..=255.').optional(),
					bold: z.boolean().describe('true/false to set bold.').optional(),
					italic: z.boolean().describe('true/false to set italic.').optional(),
					align: z.string().describe('Horizontal align: general|left|center|right.').optional(),
					borders: z.object({
						top: borderEdgeSchema.optional(),
						bottom: borderEdgeSchema.optional(),
						left: borderEdgeSchema.optional(),
						right: borderEdgeSchema.optional(),
					}).describe('Per-edge border patch.').optional(),
				}).describe('The partial style patch (set at least one field).'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareSetStyle(ctx, args as unknown as SetStyleArgs), 'set_style', kernelManager, output),
	);

	server.registerTool(
		'set_number_format',
		{
			title: 'Set number format (write)',
			description: 'Set the NUMBER FORMAT of a cell or range to a format string, e.g. "0.00%" (percent), "$#,##0.00" (currency), "0.00" (fixed). Applied as ONE setFormat batch (the format is interned once via registerFormat). Does NOT touch cell values or formulas. Requires a trusted workspace; a large (>= 50-cell) target prompts the operator. One Ctrl+Z undo step.',
			inputSchema: {
				...cellOrRangeArg,
				format: z.string().describe('The number-format string, e.g. "0.00%", "$#,##0.00", "0.00", "yyyy-mm-dd".'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareSetNumberFormat(ctx, args as unknown as SetNumberFormatArgs), 'set_number_format', kernelManager, output),
	);

	// FE-6 M: STRUCTURAL edits (insert/delete rows/columns). SILENT-DATA-CORRUPTION class -- the operator
	// ALWAYS sees the risk modal (the `structural` reason always fires) and the axis/range is audited.
	// insert takes { index, count }; delete takes { start, end } INCLUSIVE (matches the engine napi).
	server.registerTool(
		'insert_rows',
		{
			title: 'Insert rows (structural write)',
			description: 'Insert `count` blank rows at 0-based `index`; rows at/below shift down and relative formula refs adjust (Excel canon). SILENT-DATA-CORRUPTION class: the operator ALWAYS confirms via a modal. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				index: z.number().describe('0-based row index at which to insert.'),
				count: z.number().describe('Number of rows to insert (>= 1).'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareInsertStructural(ctx, 'insert_rows', args as unknown as InsertStructuralArgs), 'insert_rows', kernelManager, output),
	);

	server.registerTool(
		'delete_rows',
		{
			title: 'Delete rows (structural write)',
			description: 'Delete rows [start, end] (0-based, INCLUSIVE); rows below shift up and refs into the deleted band re-bind to #REF! (Excel canon). SILENT-DATA-CORRUPTION class: the operator ALWAYS confirms via a modal. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				start: z.number().describe('0-based first row to delete (inclusive).'),
				end: z.number().describe('0-based last row to delete (inclusive).'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDeleteStructural(ctx, 'delete_rows', args as unknown as DeleteStructuralArgs), 'delete_rows', kernelManager, output),
	);

	server.registerTool(
		'insert_columns',
		{
			title: 'Insert columns (structural write)',
			description: 'Insert `count` blank columns at 0-based `index`; columns at/right shift right and relative formula refs adjust (Excel canon). SILENT-DATA-CORRUPTION class: the operator ALWAYS confirms via a modal. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				index: z.number().describe('0-based column index at which to insert.'),
				count: z.number().describe('Number of columns to insert (>= 1).'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareInsertStructural(ctx, 'insert_columns', args as unknown as InsertStructuralArgs), 'insert_columns', kernelManager, output),
	);

	server.registerTool(
		'delete_columns',
		{
			title: 'Delete columns (structural write)',
			description: 'Delete columns [start, end] (0-based, INCLUSIVE); columns to the right shift left and refs into the deleted band re-bind to #REF! (Excel canon). SILENT-DATA-CORRUPTION class: the operator ALWAYS confirms via a modal. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				start: z.number().describe('0-based first column to delete (inclusive).'),
				end: z.number().describe('0-based last column to delete (inclusive).'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDeleteStructural(ctx, 'delete_columns', args as unknown as DeleteStructuralArgs), 'delete_columns', kernelManager, output),
	);

	// Wave L (FE-6.1): METADATA writes -- named ranges, sheet management, tables, undo/redo. Each routes
	// through the SAME trust + queue + modal + audit pipeline as the structural tools (a direct napi call
	// via the prepared `commit`). DELETES (delete_named_range / delete_sheet / delete_table) ALWAYS prompt
	// the operator; a define_named_range that REPLACES an existing name prompts; the additive ops + undo/
	// redo apply under the standing trust grant (audited). Every op is one Ctrl+Z undo step.
	server.registerTool(
		'define_named_range',
		{
			title: 'Define named range (write)',
			description: 'Define (or redefine) a WORKBOOK-scoped name that points at an A1 range, e.g. name "returns" -> "S0!B2:B100". `range` is sheet-qualified ("S0!B2:B100") or bare with a `sheet` arg. Redefining an EXISTING name re-points every formula that resolves through it, so it prompts the operator; a fresh name applies under the standing trust grant. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				name: z.string().describe('The name to define, e.g. "returns" (canonicalized upper-case by the engine).'),
				range: z.string().describe('The A1 range the name targets, e.g. "B2:B100" or sheet-qualified "S0!B2:B100".'),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDefineNamedRange(ctx, args as unknown as DefineNamedRangeArgs), 'define_named_range', kernelManager, output),
	);

	server.registerTool(
		'delete_named_range',
		{
			title: 'Delete named range (write)',
			description: 'Delete a defined name. Workbook-scoped by default; pass `scope` (a sheet id) to delete a sheet-scoped name. Formulas that referenced the name resolve to #NAME? afterward, so the operator ALWAYS confirms via a modal. A name that does not exist fails loud. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				name: z.string().describe('The defined name to delete.'),
				scope: z.number().describe('Optional sheet id for a sheet-scoped name (omit for a workbook-scoped name).').optional(),
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDeleteNamedRange(ctx, args as unknown as DeleteNamedRangeArgs), 'delete_named_range', kernelManager, output),
	);

	server.registerTool(
		'add_sheet',
		{
			title: 'Add sheet (write)',
			description: 'Append a new, empty sheet with the given name. Additive (no existing data touched), so it applies under the standing trust grant. A duplicate or invalid sheet name fails loud. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				name: z.string().describe('The new sheet name, e.g. "Returns".'),
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareAddSheet(ctx, args as unknown as AddSheetArgs), 'add_sheet', kernelManager, output),
	);

	server.registerTool(
		'rename_sheet',
		{
			title: 'Rename sheet (write)',
			description: 'Rename a sheet (by id or current name) to `newName`. Within-workbook references are preserved by the engine, so it applies under the standing trust grant. A name collision fails loud. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				sheet: z.union([z.string(), z.number()]).describe('The sheet to rename, by id (number) or current name (string).'),
				newName: z.string().describe('The new sheet name.'),
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareRenameSheet(ctx, args as unknown as RenameSheetArgs), 'rename_sheet', kernelManager, output),
	);

	server.registerTool(
		'delete_sheet',
		{
			title: 'Delete sheet (write)',
			description: 'Delete a sheet (by id or name). This tombstones the WHOLE sheet -- all its cells, charts, and tables -- and references to it resolve to #REF!, so the operator ALWAYS confirms via a modal. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				sheet: z.union([z.string(), z.number()]).describe('The sheet to delete, by id (number) or name (string).'),
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDeleteSheet(ctx, args as unknown as DeleteSheetArgs), 'delete_sheet', kernelManager, output),
	);

	server.registerTool(
		'define_table',
		{
			title: 'Define table (write)',
			description: 'Define a table over a rectangular region: anchored at 0-based (`topRow`, `topCol`) on the given sheet (or the focused sheet), spanning `rows` x `cols`, with `columnNames` (length must equal `cols`). `hasHeader`/`hasTotals` default false. Additive, so it applies under the standing trust grant; an overlapping or invalid table fails loud. Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				name: z.string().describe('The table name, e.g. "Trades".'),
				topRow: z.number().describe('0-based top row of the table region.'),
				topCol: z.number().describe('0-based left column of the table region.'),
				rows: z.number().describe('Number of rows the table spans (>= 1, includes the header row if hasHeader).'),
				cols: z.number().describe('Number of columns the table spans (>= 1).'),
				columnNames: z.array(z.string()).describe('The column names; the array length MUST equal `cols`.'),
				hasHeader: z.boolean().describe('Whether the top row is a header row (default false).').optional(),
				hasTotals: z.boolean().describe('Whether the bottom row is a totals row (default false).').optional(),
				...sheetArg,
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDefineTable(ctx, args as unknown as DefineTableArgs), 'define_table', kernelManager, output),
	);

	server.registerTool(
		'delete_table',
		{
			title: 'Delete table (write)',
			description: 'Drop a table definition by name (the underlying cell values are NOT cleared -- only the table structure is removed). The operator ALWAYS confirms via a modal. An unknown table name fails loud at commit (after the confirmation). Requires a trusted workspace. One Ctrl+Z undo step.',
			inputSchema: {
				name: z.string().describe('The table name to drop.'),
				...sessionIdArg,
			},
		},
		(args) => runWriteTool((ctx) => prepareDeleteTable(ctx, args as unknown as DeleteTableArgs), 'delete_table', kernelManager, output),
	);

	server.registerTool(
		'undo',
		{
			title: 'Undo (write)',
			description: 'Undo the workbook\'s last change. This drives the SHARED undo stack -- it may revert a recent USER edit, not just an agent write -- so the operator ALWAYS confirms via a modal. Reversible via `redo`; audited. Returns `applied: 0` when there is nothing to undo (a normal outcome, not an error). Requires a trusted workspace.',
			inputSchema: { ...sessionIdArg },
		},
		(args) => runWriteTool((ctx) => prepareUndoRedo(ctx, 'undo', args as unknown as UndoRedoArgs), 'undo', kernelManager, output),
	);

	server.registerTool(
		'redo',
		{
			title: 'Redo (write)',
			description: 'Redo the workbook\'s last undone change on the SHARED undo stack. The operator ALWAYS confirms via a modal; audited. Returns `applied: 0` when there is nothing to redo (a normal outcome, not an error). Requires a trusted workspace.',
			inputSchema: { ...sessionIdArg },
		},
		(args) => runWriteTool((ctx) => prepareUndoRedo(ctx, 'redo', args as unknown as UndoRedoArgs), 'redo', kernelManager, output),
	);
}

/**
 * A running MCP HTTP server instance. Closing it stops the listener and is idempotent.
 */
interface RunningMcpServer {
	readonly url: string;
	readonly port: number;
	/** The per-start bearer token every request must present (`Authorization: Bearer <token>`). */
	readonly token: string;
	close(): Promise<void>;
}

/** Max request body the server will buffer. The MCP JSON-RPC payloads are tiny (a tool call is a few
 *  hundred bytes); cap well above that and reject larger bodies loud (Codex LOW: no unbounded buffer). */
const MAX_REQUEST_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Start the localhost MCP HTTP server. Stateless: each POST gets a fresh McpServer + transport,
 * connected, handled, and torn down on response close. `port: 0` lets the OS pick a free port (the
 * resolved URL is returned + logged). Mints a per-start random bearer `token` REQUIRED on every request
 * (Codex HIGH: a localhost port is otherwise readable by any local process -- the token gates access to
 * live, possibly-unsaved workbook data). Rejects loud on a bind/listen failure (No-Fallbacks).
 */
async function startMcpHttpServer(
	kernelManager: ReactiveKernelManager<SessionInstance>,
	output: vscode.OutputChannel,
	port: number,
): Promise<RunningMcpServer> {
	const sdk = await loadSdk();
	const token = randomBytes(32).toString('hex');
	const httpServer = http.createServer((req, res) => {
		void handleHttpRequest(req, res, sdk, kernelManager, output, token);
	});
	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => {
			reject(new Error(`[mcp_listen_failed] could not bind ${MCP_HOST}:${port}: ${err.message}`));
		};
		httpServer.once('error', onError);
		httpServer.listen(port, MCP_HOST, () => {
			httpServer.removeListener('error', onError);
			resolve();
		});
	});
	const address = httpServer.address() as AddressInfo;
	const resolvedPort = address.port;
	const url = `http://${MCP_HOST}:${resolvedPort}${MCP_PATH}`;
	return {
		url,
		port: resolvedPort,
		token,
		close: (): Promise<void> => new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
		}),
	};
}

/** Per-request handler: validate Host + method + path + bearer token, parse the JSON body (size-capped),
 *  drive a fresh stateless McpServer/transport, and tear it down when the response closes. */
async function handleHttpRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sdk: LoadedSdk,
	kernelManager: ReactiveKernelManager<SessionInstance>,
	output: vscode.OutputChannel,
	token: string,
): Promise<void> {
	// Loopback + Host-header guard: the StreamableHTTP DNS-rebinding option is deprecated in favor of
	// external middleware, so we enforce it here -- reject any request whose Host header is not a
	// loopback literal. This defends a browser-based DNS-rebinding attack against a localhost server.
	if (!isLoopbackHost(req.headers.host)) {
		res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden: non-loopback Host header');
		return;
	}
	// Bearer-token auth (Codex HIGH): any local process can reach the loopback port, so require the
	// per-start token. Constant-time compare so a wrong token cannot be timing-probed.
	if (!hasValidBearerToken(req.headers.authorization, token)) {
		res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' }).end('unauthorized: missing or invalid bearer token');
		return;
	}
	// POST-only (Codex MED): the stateless JSON contract is POST. Reject GET/DELETE so a client cannot
	// open a long-lived SSE stream / session-delete against a server that holds none.
	if (req.method !== 'POST') {
		res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' }).end('method not allowed: POST only');
		return;
	}
	const url = req.url ?? '';
	const pathOnly = url.split('?')[0];
	if (pathOnly !== MCP_PATH) {
		res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
		return;
	}
	let body: string | undefined;
	try {
		body = await readBodyCapped(req);
	} catch (err) {
		// A stream error or an over-cap body is a loud reject (Codex LOW: do NOT resolve as if the
		// request ended normally; do NOT buffer unbounded). Send the status, and destroy the request
		// ONLY AFTER the response has flushed (re-audit LOW: an immediate req.destroy() could reset the
		// socket before the 413 reaches the client). `Connection: close` since we abandon the body.
		const tooLarge = err instanceof Error && err.message === 'body_too_large';
		if (!res.headersSent) {
			res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'text/plain', connection: 'close' });
			res.once('finish', () => req.destroy());
			res.end(tooLarge ? 'payload too large' : 'bad request: stream error');
		} else {
			req.destroy();
		}
		return;
	}
	let parsedBody: unknown;
	if (body.length > 0) {
		try {
			parsedBody = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request: malformed JSON body');
			return;
		}
	}
	const server = new sdk.McpServer({ name: 'quantbook-mcp', version: '0.1.0' });
	registerReadOnlyTools(server, sdk, kernelManager);
	// W3: the WRITE tools share the SAME per-host write queue (module-level) so writes across independent
	// stateless POSTs still serialize per session. The trust gate runs per-call inside each tool.
	registerWriteTools(server, sdk, kernelManager, output);
	const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	const teardown = (): void => {
		void transport.close();
		void server.close();
	};
	res.on('close', teardown);
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, parsedBody);
	} catch (err) {
		output.appendLine(`[mcp] request handling failed: ${err instanceof Error ? err.message : String(err)}`);
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error');
		}
		teardown();
	}
}

/** Read the request body as a string, rejecting (loud) over {@link MAX_REQUEST_BODY_BYTES} or on a
 *  stream error -- never resolving as if a truncated/errored stream ended normally. */
function readBodyCapped(req: http.IncomingMessage): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BODY_BYTES) {
				// Stop reading + reject; the handler sends the 413 THEN destroys the request (so the
				// status line reaches the client before the socket tears down).
				req.pause();
				reject(new Error('body_too_large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', (err) => reject(err));
	});
}

/** Constant-time check that the Authorization header carries the expected `Bearer <token>`. */
function hasValidBearerToken(authorization: string | undefined, token: string): boolean {
	if (authorization === undefined) {
		return false;
	}
	const match = /^Bearer\s+(.+)$/.exec(authorization);
	if (match === null) {
		return false;
	}
	const presented = Buffer.from(match[1], 'utf8');
	const expected = Buffer.from(token, 'utf8');
	if (presented.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(presented, expected);
}

/** Whether a Host header names a loopback address (no DNS-rebinding host). Accepts an optional :port. */
function isLoopbackHost(host: string | undefined): boolean {
	if (host === undefined) {
		return false;
	}
	const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * Register the `quantlab.quantbookStartMcpServer` command + a lifecycle disposable. Idempotent: a second
 * Start restarts the server (closing the prior one first). The disposable stops the server on
 * deactivate. The kernel manager is captured so get_published_variables can read the live publish state.
 */
export function registerQuantbookMcpServer(
	context: vscode.ExtensionContext,
	kernelManager: ReactiveKernelManager<SessionInstance>,
): void {
	const output = vscode.window.createOutputChannel('Quantbook MCP Server');
	context.subscriptions.push(output);

	let running: RunningMcpServer | undefined;
	const stop = async (): Promise<void> => {
		if (running !== undefined) {
			const toClose = running;
			running = undefined;
			await toClose.close();
			output.appendLine('[mcp] server stopped.');
		}
	};
	// The lifecycle disposable: close the listener on deactivate (No-Fallbacks -- no orphaned socket).
	context.subscriptions.push({ dispose: () => void stop() });

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookStartMcpServer', async () => {
			try {
				await stop();
				// Default to an OS-picked free port; the operator can pin one via quantlab.quantbookMcpPort.
				const configuredPort = vscode.workspace.getConfiguration('quantlab').get<number>('quantbookMcpPort');
				const port = typeof configuredPort === 'number' && Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 0;
				running = await startMcpHttpServer(kernelManager, output, port);
				output.appendLine(`[mcp] Quantbook MCP server listening at ${running.url}`);
				output.appendLine('[mcp] connect an MCP client over Streamable HTTP (stateless JSON). EVERY request must send the bearer token below.');
				output.appendLine(`[mcp]   URL:    ${running.url}`);
				output.appendLine(`[mcp]   Header: Authorization: Bearer ${running.token}`);
				output.appendLine('[mcp] read tools:  list_sheets, get_cell, query_range, get_snapshot, list_functions, get_published_variables, validate_formula.');
				output.appendLine('[mcp] write tools: set_cell, write_cells, set_style, set_number_format, insert_rows, delete_rows, insert_columns, delete_columns (REQUIRE a trusted workspace -- run "Quantbook: Trust Workspace for MCP Writes"; large/destructive/formula-overwrite writes AND every structural insert/delete prompt for confirmation; each write is one undo step; every write is audited to this channel).');
				output.show(true);
				const action = await vscode.window.showInformationMessage(
					`Quantbook MCP server running at ${running.url} (bearer token printed to the Quantbook MCP Server output).`,
					'Copy URL',
					'Copy Token',
				);
				if (running !== undefined) {
					if (action === 'Copy URL') {
						await vscode.env.clipboard.writeText(running.url);
					} else if (action === 'Copy Token') {
						await vscode.env.clipboard.writeText(running.token);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				output.appendLine(`[mcp] start failed: ${message}`);
				void vscode.window.showErrorMessage(`Quantbook MCP server failed to start: ${message}`);
			}
		}),
	);

	// W3: trust + revoke entry points for MCP writes. They DELEGATE to the SAME TrustManager the reactive
	// kernel uses (per-workspace grant in context.globalState) -- NOT a parallel consent store. "Trust"
	// prompts the workspace-trust modal; "Revoke" clears the grant so subsequent writes fail the gate.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookTrustWorkspaceForMcpWrites', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder === undefined) {
				void vscode.window.showWarningMessage('Open a workspace folder first, then trust it to enable MCP writes.');
				return;
			}
			if (!vscode.workspace.isTrusted) {
				void vscode.window.showWarningMessage('This window is in Restricted Mode. Trust the workspace in VS Code (Manage Workspace Trust) first, then re-run this command.');
				return;
			}
			const granted = await TrustManager.getInstance().promptWorkspaceTrust(folder.uri.toString());
			output.appendLine(`[mcp] workspace trust for writes ${granted ? 'GRANTED' : 'declined'}: ${folder.uri.toString()}`);
		}),
		vscode.commands.registerCommand('quantlab.quantbookRevokeMcpWriteTrust', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder === undefined) {
				void vscode.window.showWarningMessage('No workspace folder is open.');
				return;
			}
			await TrustManager.getInstance().revokeWorkspaceTrust(folder.uri.toString());
			output.appendLine(`[mcp] workspace trust REVOKED (MCP writes now require re-granting): ${folder.uri.toString()}`);
			void vscode.window.showInformationMessage('Quantbook MCP write trust revoked. Reads still work; writes now require re-granting trust.');
		}),
	);
}
