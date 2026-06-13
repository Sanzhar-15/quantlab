/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V3.2.b.3 (2026-05-22) -- vscode-free host logic for the
 * cell-grid panel's message-passing flow.
 *
 * Split from `cellGridPanel.ts` so unit tests can import these
 * functions without pulling the `vscode` host module.  Same pattern
 * as `cellGridHtml.ts`.
 *
 * What lives here:
 * - Message envelope types ({@link PutValueRequest},
 *   {@link ErrorReplyMessage}) per V3.2.b.1 decision B1.
 * - {@link parseCellRawInput} -- pure parser; throws with
 *   `[bad_argument]` prefix on rejection.
 * - {@link dispatchIncomingMessage} -- the host-side dispatcher; takes
 *   `DispatchDeps` (session + sheet + onCommit + onError callbacks) so
 *   it has no vscode dependency.
 *
 * What stays in `cellGridPanel.ts`:
 * - `vscode.WebviewPanel` lifecycle + `enableScripts` + nonce gen.
 * - `panel.webview.onDidReceiveMessage` -> calls
 *   {@link dispatchIncomingMessage}.
 * - `panel.webview.postMessage` -> wired as `DispatchDeps.onError`.
 */

import type { CellSnapshotJson, CollabSessionInstance, DiagnosticJson, EventJson, FormatIdJson, FunctionMetadataJson, QuantbookCellSnapshot, QuantbookCellValue, QuantbookErrorCode, RgbJson, SessionCellValueInput, SessionInstance, SessionOpJson, SheetSnapshotJson, StyleDefJson, StyleIdJson, StyleJson, TableSnapshotJson, WorkbookSnapshotDeltaJson, WorkbookSnapshotJson } from '../types';
import { assertSupportedSchemaVersion, parseQuantbookError, recalcDirtyChecked, setFormulaValidated, setValueValidated } from '../session';
// Demo-prep toolbar (2026-06-10): type-only imports so the toolbar-command parser's whitelists stay
// pinned to the canonical unions (a preset added to FormatPreset / an op added to StructuralOp forces
// an explicit decision in the Record whitelists below). Type-only -- no runtime coupling, no cycle
// (neither module imports cellGridLogic).
import type { FormatPreset } from './formatPickerLogic';
import type { StructuralOp } from './contextMenuLogic';

/**
 * V3.2.c.3 / V3.2.c.5 (2026-05-22) -- classification of a single
 * `session.pollRemote()` call's outcome.  Exported so the panel's
 * `tickPollRemote` (vscode-side) can delegate the decision tree to
 * this vscode-free helper, AND so mocha can exercise the four
 * branches without instantiating a real CellGridPanel.
 */
export type PollTickResult =
	| { kind: 'idle' }
	| { kind: 'merged'; count: number }
	| { kind: 'transportClosed' }
	| { kind: 'error'; code: QuantbookErrorCode; message: string };

/**
 * Call `session.pollRemote()` once and classify the result.  No side
 * effects beyond the pollRemote itself; the caller decides what to do
 * with the verdict (render / reconnect / log + skip).
 *
 * Branches:
 * - `pollRemote()` returns 0 -> `{kind:'idle'}`.
 * - `pollRemote()` returns > 0 -> `{kind:'merged', count: n}`.
 * - `pollRemote()` throws + `parseQuantbookError(err).code === 'transport_closed'`
 *   -> `{kind:'transportClosed'}` (V3.1.c reconnect cue).
 * - Any other throw -> `{kind:'error', code, message}` (log + skip).
 */
/**
 * **DORMANT (FE megaudit S6, 2026-06-03)** -- DEAD in v1. `pollRemote` is a
 * CollabSession (real-time collab) primitive; the v1 grid runs on the owning
 * single-writer `Session` and never polls a transport. Retained, exported, and
 * unit-tested for the v1.5 collab re-enable. No live caller today.
 */
export function classifyPollTick(session: CollabSessionInstance): PollTickResult {
	try {
		const n = session.pollRemote();
		if (n > 0) {
			return { kind: 'merged', count: n };
		}
		return { kind: 'idle' };
	} catch (err) {
		const info = parseQuantbookError(err);
		if (info.code === 'transport_closed') {
			return { kind: 'transportClosed' };
		}
		return { kind: 'error', code: info.code, message: info.message };
	}
}

/**
 * V3.2.b.1 decision B1 envelope: outgoing (webview -> extension host).
 *
 * `rawInput` is the literal user-typed string; the host's
 * {@link parseCellRawInput} does the parsing + validation.
 */
export interface PutValueRequest {
	type: 'putValue';
	sheet: number;
	row: number;
	col: number;
	rawInput: string;
	/**
	 * **FE-2-0 Phase 2 (commit-token, 2026-06-04)** -- a per-commit id minted by the
	 * webview (`index.ts` monotonic counter). Echoed back in the success
	 * {@link CommitResultMessage} and the failure {@link ErrorReplyMessage} so the
	 * webview resolves THIS edit and only this edit -- replacing the old "any render
	 * acks the pending commit" rule (which let a sibling-panel/refresh render falsely
	 * close an unrelated panel's editor). Optional for backward compat with the
	 * pre-token wire + tests that post bare envelopes.
	 */
	commitId?: number;
	/**
	 * **megaudit (webview-instance token, 2026-06-09)** -- the originating webview's instance token
	 * (minted ONCE per load; a fresh value after every reload). Echoed in the {@link CommitResultMessage}
	 * success ack and the {@link ErrorReplyMessage} failure so the webview can DROP a stale reply from a
	 * PRE-reload edit: the numeric `commitId` resets to 0 on reload and would otherwise collide with a fresh
	 * edit's token, letting a stale ack resolve/tint the wrong edit. Optional for back-compat / tests.
	 */
	webviewId?: string;
}

/**
 * **FE-1.5 W-G copy/paste + fill (2026-06-08)** -- a MULTI-cell write (webview -> host). No open editor
 * backs it, so unlike {@link PutValueRequest} there is no pending-commit dance: the host writes every cell
 * atomically via `Session.batch` (one undo unit), recalcs, and re-renders. `undoLabel` names the undo step
 * ("Paste" / "Fill"); each cell's `rawInput` is classified exactly like a single `putValue` (`=`-prefix ->
 * formula, else literal, empty -> clear). The batch is ALL-OR-NOTHING: any invalid cell rejects the whole
 * op loudly (No-Fallbacks). `webviewId` (megaudit, 2026-06-09) is the originating webview's instance token:
 * on success the dispatcher posts a {@link CellsWrittenMessage} echoing it + the written coords, letting the
 * webview clear those cells' error tints even when the write did NOT change stored content (a content-changed
 * render wouldn't). A FAILED putCells posts nothing, so a stale tint correctly stays (No-Fallbacks). The
 * host echoes the REQUEST's `webviewId`, so a stale post-reload ack cannot clear a fresh webview's tint.
 */
export interface PutCellsRequest {
	type: 'putCells';
	sheet: number;
	cells: { row: number; col: number; rawInput: string }[];
	undoLabel?: string;
	webviewId?: string;
}

/**
 * **FE-5 W-R (2026-06-12)** -- a cell-STYLE mutation over a rectangle (webview -> host). The engine
 * is the SOLE style source (the retired session `cellStyleModel` is gone), so the toolbar's
 * style controls POST this; the host applies it via the engine `registerStyle`/`setStyle` napi as
 * ONE `Session.batch` (a single undo unit), recalcs, and re-renders.
 *
 * **Why a small MUTATION descriptor (not a per-cell full StyleJson):** the toolbar mutations are
 * uniform deltas over the selection (toggle bold everywhere / set align everywhere / set-or-clear
 * fill everywhere). Each cell's RESULTING style depends on its CURRENT style, which the host already
 * has (it reads the workbook snapshot every render). Sending the descriptor (a few bytes) instead of
 * up to {@link MAX_STYLE_CELLS} full StyleJson objects keeps the wire bounded AND keeps the engine
 * read-modify-write in ONE authority (the host), with no webview/host style-schema duplication.
 *
 * The rect is INCLUSIVE 0-based. The batch is ALL-OR-NOTHING (No-Fallbacks: a single invalid cell or
 * a malformed style rejects the whole op loudly via {@link DispatchDeps.onOperationError}).
 */
export interface SetStyleRequest {
	type: 'setStyle';
	sheet: number;
	rect: { minRow: number; maxRow: number; minCol: number; maxCol: number };
	mutation: StyleMutation;
	undoLabel?: string;
	webviewId?: string;
}

/**
 * **FE-5 W-R (2026-06-12) / FE-FONT (2026-06-13)** -- a single uniform style mutation a
 * {@link SetStyleRequest} carries. The engine-schema attributes (the SOLE style source): bold/italic/
 * underline/strike toggles, horizontal align, fill color, text color, and per-edge BORDERS.
 *
 * FE-FONT (2026-06-13) added `underline`/`strike` (folded into the `toggle` prop union), `textColor`,
 * and `border` -- the four formerly preview-only toolbar buttons. Builder G's engine bump adds
 * `StyleJson.underline`/`.strike`/`.textColor` (camelCase) + bumps the snapshot schema 3->4; borders
 * already existed in the engine schema (FE-4 W4), so the `border` variant is FE-only.
 *
 * - `toggle`: flip a boolean style (`bold`/`italic`/`underline`/`strike`) over the rect with Excel/Sheets
 *   semantics -- if EVERY cell in the rect already has it on, the whole rect is turned OFF, else ON.
 * - `align`: set the horizontal align over the rect, or clear it back to `general` with `null`.
 * - `fill`: set the fill color over the rect, or clear it (no fill) with `null`.
 * - `textColor`: set the glyph color over the rect, or clear it (renderer default) with `null`.
 * - `border`: set or clear cell borders over the rect. `edges` selects which edges the op touches:
 *   `all` = the 4 edges of every cell; `outer` = only the rect's OUTER box (top row's top, bottom row's
 *   bottom, left col's left, right col's right); `top`/`bottom`/`left`/`right` = that single edge on every
 *   cell; `none` = CLEAR all 4 edges of every cell (`style`/`color` are ignored). For the non-`none`
 *   variants, a `style` of `'none'` CLEARS the named edges (so the picker's "no border" line maps to it).
 */
export type BorderStyleName = 'none' | 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
export type BorderEdgeSet = 'all' | 'outer' | 'top' | 'bottom' | 'left' | 'right' | 'none';
export type StyleMutation =
	| { kind: 'toggle'; prop: 'bold' | 'italic' | 'underline' | 'strike' }
	| { kind: 'align'; value: 'left' | 'center' | 'right' | null }
	| { kind: 'fill'; value: RgbJson | null }
	| { kind: 'textColor'; value: RgbJson | null }
	| { kind: 'border'; edges: BorderEdgeSet; style: BorderStyleName; color: RgbJson };

/**
 * V3.2.b.1 decision B1 envelope: incoming (extension host -> webview)
 * on the failure path.  `refresh` is implemented as a full HTML
 * rebuild and does NOT use this channel.
 */
export interface ErrorReplyMessage {
	type: 'errorReply';
	sheet: number;
	row: number;
	col: number;
	code: QuantbookErrorCode;
	message: string;
	/** **FE-2-0 Phase 2** -- the {@link PutValueRequest.commitId} of the failed commit, when the
	 * failure is for a tokened putValue. Lets the webview un-stick + decorate exactly the originating
	 * edit. Absent for non-commit errors (e.g. a pre-token envelope). */
	commitId?: number;
	/** **megaudit (webview-instance token, 2026-06-09)** -- the {@link PutValueRequest.webviewId} of the
	 * failed commit, echoed so a stale post-reload errorReply cannot un-stick/tint a fresh webview. */
	webviewId?: string;
}

/**
 * **FE-2-0 Phase 2 (commit-token, 2026-06-04)** -- incoming (extension host -> the ORIGINATING
 * webview only) success ack for a tokened {@link PutValueRequest}. The host posts this to the panel
 * that sent the putValue (NOT a session-wide fan-out -- that is the separate `render` push), so the
 * webview can close its editor + apply its post-commit nav + clear that cell's error tint with the
 * certainty that the engine accepted THIS commit. A bare `render` no longer resolves a pending edit.
 */
export interface CommitResultMessage {
	type: 'commitResult';
	commitId: number;
	ok: true;
	/** **megaudit (webview-instance token, 2026-06-09)** -- the {@link PutValueRequest.webviewId} of the
	 * acked commit, echoed so a stale post-reload commitResult cannot resolve a fresh webview's editor. */
	webviewId?: string;
}

/**
 * **megaudit (webview-instance token, 2026-06-09)** -- incoming (extension host -> the ORIGINATING webview
 * only) report of the cells a {@link PutCellsRequest} (paste/fill) actually WROTE, posted ONLY on success
 * (after `Session.batch` + recalc). The webview clears each listed cell's error tint -- even when stored
 * content did not change (so the content-changed render-clear would miss it) -- guarded by `webviewId` ===
 * its own instance token AND `sheet` === its current sheet. This is the authoritative, host-driven
 * replacement for the prior webview-side pending-ack Map (which reset its numeric token on reload and was
 * not sheet-scoped). A FAILED putCells posts NOTHING, so a stale tint correctly stays (No-Fallbacks).
 */
export interface CellsWrittenMessage {
	type: 'cellsWritten';
	sheet: number;
	cells: { row: number; col: number }[];
	webviewId?: string;
}

/**
 * **FE-1.5 W-G-2b (selection, 2026-06-08)** -- incoming (webview -> extension host) report of the
 * grid's current selection: the rectangular range spanning `anchor`..`focus` (single-cell when the
 * two endpoints coincide). Posted by the webview on every selection change (deduped). Purely
 * INFORMATIONAL -- it never touches the engine, carries no `commitId`, and has no editor to un-stick;
 * an invalid/mismatched envelope is DROPPED with a warning (like the dormant `presenceUpdate`), NOT
 * answered with an {@link ErrorReplyMessage}. The host stores the latest valid one per panel
 * ({@link DispatchDeps.onSelectionChange}) so the focused grid's selection is queryable
 * (`CellGridPanel.focusedGridSelection()`) -- the hook the reactive-notebook "bind variable to
 * selected cell" flow consumes.
 */
export interface SelectionMessage {
	type: 'selection';
	sheet: number;
	anchorRow: number;
	anchorCol: number;
	focusRow: number;
	focusCol: number;
}

/**
 * **FE-1.5 W-G-2b** -- the VALIDATED selection payload handed to the host via
 * {@link DispatchDeps.onSelectionChange}. Same shape as {@link SelectionMessage} minus the `type`
 * wire tag: a clean domain type for the host + downstream consumers (vs the raw envelope). The
 * dispatcher guarantees `sheet === deps.sheet` and all four coords are integers in the A1 extent
 * before constructing this, so consumers can rely on those invariants.
 */
export interface GridSelection {
	sheet: number;
	anchorRow: number;
	anchorCol: number;
	focusRow: number;
	focusCol: number;
}

/**
 * **W2 formula intelligence (2026-06-09)** -- incoming (webview -> host) request to validate a formula
 * body WITHOUT mutating, for the formula-bar inline error hint. The webview debounces keystrokes and posts
 * this with the formula BODY (no leading `=` -- engine convention; the webview strips it). `reqId` is a
 * per-webview monotonic token echoed in the reply so a stale (superseded) debounced response is dropped.
 * `webviewId` is this webview's instance token, echoed so a stale post-reload reply is dropped. The host
 * answers with a {@link ValidateFormulaResultMessage}; an engine THROW is surfaced as `ok:false`, never
 * swallowed into "no diagnostics" (No-Fallbacks).
 */
export interface ValidateFormulaRequest {
	type: 'validateFormula';
	sheet: number;
	row: number;
	col: number;
	text: string;
	reqId: number;
	webviewId?: string;
}

/** **W2** -- host -> originating webview: the result of a {@link ValidateFormulaRequest}. */
export interface ValidateFormulaResultMessage {
	type: 'validateFormulaResult';
	reqId: number;
	/** True when the engine ran the validate (diagnostics may be empty = valid); false when it THREW. */
	ok: boolean;
	/** The engine diagnostics (empty = valid). Present iff `ok`. */
	diagnostics?: DiagnosticJson[];
	/** A structured `[code] message` when `ok:false` (the engine threw running validateFormula). */
	error?: string;
	webviewId?: string;
}

/**
 * **W2 formula intelligence (2026-06-09)** -- incoming (webview -> host) request for the function catalog
 * (built-ins + UDFs), for the completion dropdown. The webview requests it ONCE after the handshake (the
 * catalog is session-stable in v1) and caches it. `reqId`/`webviewId` are echoed for the same dedupe /
 * reload-race discipline as the validate request. The host answers with a {@link FunctionListMessage};
 * an engine THROW surfaces as `ok:false` (No-Fallbacks -- no fabricated list).
 */
export interface ListFunctionsRequest {
	type: 'listFunctions';
	reqId: number;
	webviewId?: string;
}

/** **W2** -- host -> originating webview: the function catalog answering a {@link ListFunctionsRequest}. */
export interface FunctionListMessage {
	type: 'functionList';
	reqId: number;
	ok: boolean;
	/** The function metadata (sorted ascending by canonicalName per the engine). Present iff `ok`. */
	functions?: FunctionMetadataJson[];
	error?: string;
	webviewId?: string;
}

/**
 * Parse + validate the raw user-typed string into a finite number.
 *
 * V3.2.b ONLY supports numeric cells -- the V1 napi `appendPutValue`
 * binding takes a `f64` and there is no text/boolean variant yet.
 * Non-numeric input is rejected with the `[bad_argument]` bracketed
 * prefix so {@link parseQuantbookError} routes it to the structured
 * `'bad_argument'` code.
 *
 * @returns the parsed finite number on success.
 * @throws Error with `[bad_argument]` prefix on rejection.
 */
/**
 * **Phase 5.7 V3.4.0.X MEDIUM-3 closure (2026-05-24, single-lane Codex)** --
 * presence numeric-field validator.
 *
 * Returns `null` when the state's numeric fields all fit their engine-side
 * domains: `sheet` in `[0, 65535]` (u16), `row/col/selectionEndRow/
 * selectionEndCol` in `[0, 4294967295]` (u32), all finite + integer.  Returns
 * a non-null error-message string otherwise (caller wraps in errorReply with
 * `code: 'bad_argument'`).
 *
 * Mirrors the `appendPutValueValidated` numeric discipline established at
 * V3.2.d HIGH-2 closure.  Pre-V3.4.0.X this dispatcher arm shipped with
 * typeof-only checks; NaN/Infinity/negative/fractional/out-of-range values
 * passed through to napi's ToUint32 coercion which would either silently
 * coerce (negative -> very-large u32) or panic on the engine side.
 *
 * Exported for direct mocha coverage.
 */
export function validatePresenceNumeric(s: {
	sheet: number;
	row: number;
	col: number;
	selectionEndRow: number;
	selectionEndCol: number;
}): string | null {
	const fields: Array<{ name: string; value: number; max: number }> = [
		{ name: 'sheet', value: s.sheet, max: 65535 },
		{ name: 'row', value: s.row, max: 4294967295 },
		{ name: 'col', value: s.col, max: 4294967295 },
		{ name: 'selectionEndRow', value: s.selectionEndRow, max: 4294967295 },
		{ name: 'selectionEndCol', value: s.selectionEndCol, max: 4294967295 },
	];
	for (const f of fields) {
		if (!Number.isFinite(f.value)) {
			return `${f.name} must be a finite non-negative integer, got ${f.value}`;
		}
		if (f.value < 0) {
			return `${f.name} must be a non-negative integer, got ${f.value}`;
		}
		if (!Number.isInteger(f.value)) {
			return `${f.name} must be an integer, got ${f.value}`;
		}
		if (f.value > f.max) {
			return `${f.name} must be in [0, ${f.max}], got ${f.value}`;
		}
	}
	return null;
}

/**
 * **DORMANT (FE megaudit S6, 2026-06-03)** -- DEAD in v1. The live cell-input path
 * is {@link classifyCellInput} (number/text/blank for the owning `Session`); this
 * numeric-only parser predates the text-cell fix and has no live caller. Retained +
 * unit-tested for reference. Do not wire into the dispatch path (it throws on text).
 */
export function parseCellRawInput(raw: string): number {
	const trimmed = raw.trim();
	if (trimmed === '') {
		throw new Error('[bad_argument] cell value cannot be empty');
	}
	// `Number()` accepts hex (0xFF), scientific (1e3), Infinity, NaN.
	// Reject Infinity / NaN explicitly via Number.isFinite so the
	// engine never receives a non-finite f64 (its validator would
	// reject too, but failing at the TS layer gives a clearer message
	// + cheaper round-trip).
	const n = Number(trimmed);
	if (!Number.isFinite(n)) {
		throw new Error(`[bad_argument] cell value must be a finite number, got "${trimmed}"`);
	}
	return n;
}

/**
 * **FE-0a Part B (B1, 2026-06-02)** -- classify a raw user-typed literal into a
 * {@link SessionCellValueInput} for the owning `Session.setValue` path. This is
 * the text-cell fix: unlike {@link parseCellRawInput} (numeric-only, throws on a
 * string), a non-numeric literal now becomes a `text` cell instead of a
 * `[bad_argument]` rejection -- string columns finally round-trip into the grid.
 *
 * Classification (formula `=...` is handled by the caller BEFORE this):
 * - empty / whitespace-only -> `{ kind: 'blank' }` (clears the cell -- friendlier
 *   than the old "cell value cannot be empty" throw),
 * - a finite `Number(trimmed)` (hex / scientific accepted; Infinity / NaN are NOT
 *   finite so they fall through) -> `{ kind: 'number', number }`,
 * - anything else -> `{ kind: 'text', text }` preserving the literal verbatim.
 *
 * Boolean parsing ("TRUE"/"FALSE") and Excel's leading-apostrophe force-text are
 * deliberate v1.x refinements, not B1.
 */
export function classifyCellInput(raw: string): SessionCellValueInput {
	const trimmed = raw.trim();
	if (trimmed === '') {
		return { kind: 'blank' };
	}
	const n = Number(trimmed);
	if (Number.isFinite(n)) {
		return { kind: 'number', number: n };
	}
	// **FE megaudit S2-M3 (2026-06-03)**: return the TRIMMED literal for consistency
	// with the number branch (which classifies on `trimmed`). Returning the un-trimmed
	// `raw` here meant `"  hi  "` round-tripped as a text cell with surrounding
	// whitespace while `"  5  "` became the clean number 5 -- an inconsistency.
	return { kind: 'text', text: trimmed };
}

/**
 * **FE-1.5 W-G copy/paste + fill** -- upper bound on a single {@link PutCellsRequest} batch (a paste/fill
 * is bounded by the selection size; this caps a tampered/runaway bundle before the engine parses every
 * op synchronously). A 1000-row x 100-col region is well under it.
 */
export const MAX_BATCH_CELLS = 100_000;

/**
 * **FE-1.5 W-G copy/paste + fill** -- map a multi-cell `putCells` request to validated `Session.batch`
 * ops, classifying each cell's `rawInput` exactly like a single `putValue` (`=`-prefix -> `setFormula`
 * with the body; empty/whitespace -> `clear`; else a literal `setValue` via {@link classifyCellInput}).
 * Pure (no session) so it is unit-tested headlessly. THROWS a structured `[bad_argument]` error on the
 * FIRST invalid cell (empty batch, over-cap count, non-string/over-length input, or an out-of-extent
 * coord) -- the caller rejects the whole batch, never a partial write (No-Fallbacks + batch atomicity).
 */
export function buildBatchOps(sheet: number, cells: readonly { row: number; col: number; rawInput: string }[]): SessionOpJson[] {
	// Parity with setValueValidated (megaudit LOW): bound the sheet id to u16 like the single-cell path,
	// rather than relying on the engine to reject an out-of-range sheet.
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 0xFFFF) {
		throw new Error(`[bad_argument] putCells: sheet must be an integer in [0, 65535], got ${sheet}.`);
	}
	if (cells.length === 0) {
		throw new Error('[bad_argument] putCells: the batch is empty.');
	}
	if (cells.length > MAX_BATCH_CELLS) {
		throw new Error(`[bad_argument] putCells: ${cells.length} cells exceeds the ${MAX_BATCH_CELLS}-cell batch limit.`);
	}
	const ops: SessionOpJson[] = [];
	for (const c of cells) {
		if (typeof c.rawInput !== 'string') {
			throw new Error(`[bad_argument] putCells: cell (row ${c.row}, col ${c.col}) rawInput must be a string, got ${typeof c.rawInput}.`);
		}
		if (c.rawInput.length > MAX_RAW_INPUT_LENGTH) {
			throw new Error(`[bad_argument] putCells: cell (row ${c.row}, col ${c.col}) rawInput is ${c.rawInput.length} chars, exceeding the ${MAX_RAW_INPUT_LENGTH}-char limit.`);
		}
		if (!Number.isInteger(c.row) || c.row < 0 || c.row >= A1_MAX_ROWS || !Number.isInteger(c.col) || c.col < 0 || c.col >= A1_MAX_COLS) {
			throw new Error(`[bad_argument] putCells: cell (row ${c.row}, col ${c.col}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}).`);
		}
		if (c.rawInput.trimStart().startsWith('=')) {
			ops.push({ kind: 'setFormula', sheet, row: c.row, col: c.col, text: c.rawInput.trimStart().slice(1) });
		} else {
			const value = classifyCellInput(c.rawInput);
			if (value.kind === 'blank') {
				ops.push({ kind: 'clear', sheet, row: c.row, col: c.col });
			} else {
				ops.push({ kind: 'setValue', sheet, row: c.row, col: c.col, value });
			}
		}
	}
	return ops;
}

// ============================================================================
// FE-5 W-R (2026-06-12) -- cell-STYLE mutation -> engine setStyle batch.
// The engine is the SOLE style source (the session `cellStyleModel` is retired). The toolbar's
// style controls POST a SetStyleRequest; the host applies the uniform mutation over the rect by
// reading each cell's CURRENT style from the workbook snapshot, computing the target StyleJson,
// registering distinct styles, and committing a single setStyle batch. Pure helpers below
// (`computeStyleTargets`, `styleJsonKey`) are mocha-testable; the napi-touching interning + batch
// lives in the dispatcher's `setStyle` arm.
// ============================================================================

/**
 * **FE-5 W-R (2026-06-12)** -- upper bound on cells a single {@link SetStyleRequest} may touch (the
 * rect can span the whole Excel extent). Mirrors {@link MAX_BATCH_CELLS} + the retired webview
 * `MAX_STYLE_CELLS` so a pathological whole-sheet style op is rejected loud rather than building an
 * unbounded batch. A normal styling target is far under this.
 */
export const MAX_STYLE_CELLS = 100_000;

/** All-default {@link StyleJson} (no visible style). The base a mutation patches when a cell carries
 *  no style yet; also the result of clearing every attribute. `underline`/`strike` (FE-FONT, optional like
 *  the engine's default-false bools) + `textColor` are left ABSENT here -- absent reads as off everywhere
 *  (`=== true` / `styleJsonKey` collapse), matching the existing `fill`/`align`-absent convention. A toggle
 *  ON sets the field explicitly; a toggle OFF sets it to `false` (which `styleJsonKey` still collapses). */
function defaultStyleJson(): StyleJson {
	return { bold: false, italic: false };
}

/**
 * **FE-5 W-R (2026-06-12)** -- read a cell's CURRENT {@link StyleJson} from a workbook snapshot:
 * resolve `cells[].styleId` against `snapshot.styles[]`. Returns a fresh all-default StyleJson when
 * the cell has no style (or the sheet/cell is absent). The returned object is always a COPY (never an
 * alias into the snapshot) so the caller can patch it freely.
 *
 * No-Fallbacks: a cell whose `styleId` does NOT resolve against `styles[]` is a contract violation
 * (the engine registers every referenced style); THROW `[invalid_state]` rather than silently
 * treating it as unstyled -- a mutation must never start from a wrong (default) base and overwrite a
 * real-but-unresolvable style. (In practice unreachable: the snapshot carries both together.)
 */
export function currentCellStyle(
	snapshot: WorkbookSnapshotJson,
	sheet: number,
	row: number,
	col: number,
): StyleJson {
	const sheetSnap = snapshot.sheets.find(s => s.id === sheet);
	const cell = sheetSnap?.cells.find(c => c.row === row && c.col === col);
	if (cell === undefined || cell.styleId === undefined) {
		return defaultStyleJson();
	}
	const styles = snapshot.styles ?? [];
	const def = styles.find(
		d => d.id.peer === cell.styleId!.peer && d.id.counter === cell.styleId!.counter,
	);
	if (def === undefined) {
		throw new Error(
			`[invalid_state] currentCellStyle: cell (sheet=${sheet}, row=${row}, col=${col}) carries a styleId ` +
			`{peer:${cell.styleId.peer}, counter:${cell.styleId.counter}} not present in snapshot.styles[] ` +
			`(${styles.length} styles). The engine must register every referenced style; the binding may be out of sync.`,
		);
	}
	// Deep-ish copy: the top-level scalars + a fresh copy of each present sub-object so a patch
	// (e.g. setting fill) cannot mutate the snapshot's shared StyleDefJson. FE-FONT (2026-06-13):
	// carry underline/strike ONLY when on (optional, like fill/align -- an absent field reads as off
	// everywhere) + textColor (engine Option, absent = renderer-default glyph color).
	const copy: StyleJson = { bold: def.style.bold === true, italic: def.style.italic === true };
	if (def.style.underline === true) { copy.underline = true; }
	if (def.style.strike === true) { copy.strike = true; }
	if (def.style.fill !== undefined) { copy.fill = { ...def.style.fill }; }
	if (def.style.textColor !== undefined) { copy.textColor = { ...def.style.textColor }; }
	if (def.style.align !== undefined) { copy.align = def.style.align; }
	if (def.style.borderTop !== undefined) { copy.borderTop = { style: def.style.borderTop.style, color: { ...def.style.borderTop.color } }; }
	if (def.style.borderBottom !== undefined) { copy.borderBottom = { style: def.style.borderBottom.style, color: { ...def.style.borderBottom.color } }; }
	if (def.style.borderLeft !== undefined) { copy.borderLeft = { style: def.style.borderLeft.style, color: { ...def.style.borderLeft.color } }; }
	if (def.style.borderRight !== undefined) { copy.borderRight = { style: def.style.borderRight.style, color: { ...def.style.borderRight.color } }; }
	return copy;
}

/**
 * **FE-5 W-R (2026-06-12)** -- compute the per-cell TARGET {@link StyleJson} for a uniform
 * {@link StyleMutation} over `rect`, reading each cell's current style from `snapshot`. Pure (no
 * session / napi) so it is mocha-testable; the caller interns the distinct results + batches.
 *
 * Excel/Sheets toggle semantics: a `toggle` (bold/italic/underline/strike) flips to OFF iff EVERY cell in
 * the rect already has the prop on, else ON (so a partially-bold selection becomes fully bold). `align`/
 * `fill`/`textColor` set (or clear with `null`) uniformly. `border` sets/clears the edges named by
 * `mutation.edges` (FE-FONT: `outer` touches only the rect's perimeter; `all`/single-edge touch every cell;
 * `none` clears all 4 edges of every cell; a `style:'none'` clears the named edges). Every OTHER attribute
 * a cell already carries is PRESERVED -- a mutation patches its target attribute, never resets the cell.
 *
 * THROWS `[bad_argument]` for an empty/inverted rect or an over-{@link MAX_STYLE_CELLS} cell count,
 * and propagates `currentCellStyle`'s `[invalid_state]` for an unresolvable styleId (No-Fallbacks).
 */
export function computeStyleTargets(
	snapshot: WorkbookSnapshotJson,
	sheet: number,
	rect: { minRow: number; maxRow: number; minCol: number; maxCol: number },
	mutation: StyleMutation,
): { row: number; col: number; style: StyleJson }[] {
	if (
		!Number.isInteger(rect.minRow) || !Number.isInteger(rect.maxRow) ||
		!Number.isInteger(rect.minCol) || !Number.isInteger(rect.maxCol) ||
		rect.minRow < 0 || rect.minCol < 0 ||
		rect.maxRow < rect.minRow || rect.maxCol < rect.minCol ||
		rect.maxRow >= A1_MAX_ROWS || rect.maxCol >= A1_MAX_COLS
	) {
		throw new Error(
			`[bad_argument] setStyle: rect {minRow:${rect.minRow}, maxRow:${rect.maxRow}, minCol:${rect.minCol}, ` +
			`maxCol:${rect.maxCol}} is empty/inverted or outside the A1 extent (${A1_MAX_ROWS}x${A1_MAX_COLS}).`,
		);
	}
	const rows = rect.maxRow - rect.minRow + 1;
	const cols = rect.maxCol - rect.minCol + 1;
	const count = rows * cols;
	if (count > MAX_STYLE_CELLS) {
		throw new Error(`[bad_argument] setStyle: ${count} cells exceeds the ${MAX_STYLE_CELLS}-cell style limit.`);
	}
	// For a toggle, first determine the uniform target value (off iff ALL cells already on).
	let toggleTo = false;
	if (mutation.kind === 'toggle') {
		let allOn = true;
		for (let r = rect.minRow; r <= rect.maxRow && allOn; r += 1) {
			for (let c = rect.minCol; c <= rect.maxCol; c += 1) {
				if (currentCellStyle(snapshot, sheet, r, c)[mutation.prop] !== true) {
					allOn = false;
					break;
				}
			}
		}
		toggleTo = !allOn;
	}
	const out: { row: number; col: number; style: StyleJson }[] = [];
	for (let r = rect.minRow; r <= rect.maxRow; r += 1) {
		for (let c = rect.minCol; c <= rect.maxCol; c += 1) {
			const style = currentCellStyle(snapshot, sheet, r, c);
			if (mutation.kind === 'toggle') {
				style[mutation.prop] = toggleTo;
			} else if (mutation.kind === 'align') {
				if (mutation.value === null) {
					delete style.align;
				} else {
					style.align = mutation.value;
				}
			} else if (mutation.kind === 'fill') {
				if (mutation.value === null) {
					delete style.fill;
				} else {
					style.fill = { r: mutation.value.r, g: mutation.value.g, b: mutation.value.b };
				}
			} else if (mutation.kind === 'textColor') {
				if (mutation.value === null) {
					delete style.textColor;
				} else {
					style.textColor = { r: mutation.value.r, g: mutation.value.g, b: mutation.value.b };
				}
			} else {
				// border. Decide which of THIS cell's 4 edges the mutation touches given `edges`, then set
				// each touched edge to {style, color} -- or DELETE it when the requested style is 'none' (or
				// the whole `edges:'none'` clear-all). `outer` touches only the rect-perimeter edges of a cell
				// that sits on that side of the rect (so a 1x1 rect's 4 perimeter edges all apply).
				applyBorderEdges(style, mutation, r, c, rect);
			}
			out.push({ row: r, col: c, style });
		}
	}
	return out;
}

/** The four cell-edge keys on a {@link StyleJson}, in a fixed order. */
const BORDER_EDGE_KEYS = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] as const;
type BorderEdgeKey = typeof BORDER_EDGE_KEYS[number];

/**
 * **FE-FONT (2026-06-13)** -- mutate `style`'s border edges in place for a `border` mutation over one cell
 * at (r, c) within `rect`. Pure helper of {@link computeStyleTargets}. Maps the {@link BorderEdgeSet} to the
 * concrete edges this cell touches, then for each touched edge: DELETE it when clearing (`edges:'none'` or
 * `style:'none'`), else set it to `{style, color}` (a fresh color copy -- never alias the mutation's RGB).
 *
 * `outer`: a cell on the rect's top row gets its top edge; on the bottom row its bottom; on the left col its
 * left; on the right col its right (a 1x1 rect's single cell is on all four sides -> all four edges).
 */
function applyBorderEdges(
	style: StyleJson,
	mutation: { edges: BorderEdgeSet; style: BorderStyleName; color: RgbJson },
	r: number,
	c: number,
	rect: { minRow: number; maxRow: number; minCol: number; maxCol: number },
): void {
	const touched = new Set<BorderEdgeKey>();
	switch (mutation.edges) {
		case 'all':
		case 'none':
			BORDER_EDGE_KEYS.forEach(k => touched.add(k));
			break;
		case 'top': touched.add('borderTop'); break;
		case 'bottom': touched.add('borderBottom'); break;
		case 'left': touched.add('borderLeft'); break;
		case 'right': touched.add('borderRight'); break;
		case 'outer':
			if (r === rect.minRow) { touched.add('borderTop'); }
			if (r === rect.maxRow) { touched.add('borderBottom'); }
			if (c === rect.minCol) { touched.add('borderLeft'); }
			if (c === rect.maxCol) { touched.add('borderRight'); }
			break;
	}
	const clear = mutation.edges === 'none' || mutation.style === 'none';
	for (const key of touched) {
		if (clear) {
			delete style[key];
		} else {
			style[key] = { style: mutation.style, color: { r: mutation.color.r, g: mutation.color.g, b: mutation.color.b } };
		}
	}
}

/** **FE-5 W-R (2026-06-12)** -- validate one RGB channel triple from an UNTRUSTED webview payload:
 *  each of r/g/b an integer in 0..=255. `what` names the field for the error message (fill / text color /
 *  border color). Returns an error string or null. */
function validateRgb(v: unknown, what = 'color'): string | null {
	if (typeof v !== 'object' || v === null) {
		return `${what} must be an {r,g,b} object`;
	}
	const c = v as { r?: unknown; g?: unknown; b?: unknown };
	const ok = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;
	if (!ok(c.r) || !ok(c.g) || !ok(c.b)) {
		return `${what} r/g/b must each be an integer in 0..=255`;
	}
	return null;
}

/** **FE-FONT (2026-06-13)** -- the border-edge sets + style names a `border` mutation may carry (the
 *  untrusted-validation allowlists). MUST match {@link BorderEdgeSet} / {@link BorderStyleName}. */
const BORDER_EDGE_SETS: ReadonlySet<string> = new Set(['all', 'outer', 'top', 'bottom', 'left', 'right', 'none']);
const BORDER_STYLE_NAMES: ReadonlySet<string> = new Set(['none', 'thin', 'medium', 'thick', 'dashed', 'dotted', 'double']);

/**
 * **FE-5 W-R (2026-06-12)** -- validate an UNTRUSTED {@link StyleMutation} from the webview (defense in
 * depth -- a tampered bundle could post a malformed mutation). Returns an error message string, or null
 * when valid. Strict tagged-union check on `kind` + the per-kind payload domain.
 */
export function validateStyleMutation(m: unknown): string | null {
	if (typeof m !== 'object' || m === null) {
		return 'mutation must be an object';
	}
	const mut = m as { kind?: unknown; prop?: unknown; value?: unknown; edges?: unknown; style?: unknown; color?: unknown };
	if (mut.kind === 'toggle') {
		// FE-FONT (2026-06-13): underline/strike join bold/italic as engine boolean toggles.
		if (mut.prop !== 'bold' && mut.prop !== 'italic' && mut.prop !== 'underline' && mut.prop !== 'strike') {
			return `toggle prop must be 'bold'|'italic'|'underline'|'strike', got ${String(mut.prop)}`;
		}
		return null;
	}
	if (mut.kind === 'align') {
		if (mut.value !== null && mut.value !== 'left' && mut.value !== 'center' && mut.value !== 'right') {
			return `align value must be 'left'|'center'|'right'|null, got ${String(mut.value)}`;
		}
		return null;
	}
	if (mut.kind === 'fill') {
		if (mut.value === null) {
			return null;
		}
		return validateRgb(mut.value, 'fill');
	}
	if (mut.kind === 'textColor') {
		// FE-FONT (2026-06-13): null clears the glyph color (renderer default); else a valid RGB.
		if (mut.value === null) {
			return null;
		}
		return validateRgb(mut.value, 'text color');
	}
	if (mut.kind === 'border') {
		// FE-FONT (2026-06-13): reject an unknown edge set or border-style name LOUDLY (No-Fallbacks). The
		// color is required + validated even for a clear op (style:'none') -- the wire shape always carries it
		// and a malformed color signals a tampered/buggy payload we must surface rather than silently accept.
		if (typeof mut.edges !== 'string' || !BORDER_EDGE_SETS.has(mut.edges)) {
			return `border edges must be 'all'|'outer'|'top'|'bottom'|'left'|'right'|'none', got ${String(mut.edges)}`;
		}
		if (typeof mut.style !== 'string' || !BORDER_STYLE_NAMES.has(mut.style)) {
			return `border style must be 'none'|'thin'|'medium'|'thick'|'dashed'|'dotted'|'double', got ${String(mut.style)}`;
		}
		return validateRgb(mut.color, 'border color');
	}
	return `unknown mutation kind ${String(mut.kind)}`;
}

/**
 * **FE-5 W-R (2026-06-12) / FE-FONT (2026-06-13)** -- canonical dedup key for a {@link StyleJson}, so the
 * `setStyle` handler interns each DISTINCT style once (registerStyle is idempotent, but deduping avoids N
 * redundant napi calls for a uniform selection). A border edge / color serializes as `style@r,g,b` / `r,g,b`;
 * absent fields collapse to "". Order is fixed so equal StyleJsons produce equal keys. Every render-visible
 * attribute MUST appear here (FE-FONT added underline/strike/textColor) -- else two cells differing only in,
 * e.g., text color would collide to one styleId and the second would render with the first's color.
 */
export function styleJsonKey(s: StyleJson): string {
	const edge = (e: { style: string; color: RgbJson } | undefined): string =>
		e === undefined ? '' : `${e.style}@${e.color.r},${e.color.g},${e.color.b}`;
	const rgb = (c: RgbJson | undefined): string => c === undefined ? '' : `${c.r},${c.g},${c.b}`;
	return [
		s.bold === true ? 'b' : '',
		s.italic === true ? 'i' : '',
		s.underline === true ? 'u' : '',
		s.strike === true ? 's' : '',
		`f:${rgb(s.fill)}`,
		`tc:${rgb(s.textColor)}`,
		`a:${s.align ?? ''}`,
		`t:${edge(s.borderTop)}`,
		`bo:${edge(s.borderBottom)}`,
		`l:${edge(s.borderLeft)}`,
		`r:${edge(s.borderRight)}`,
	].join('|');
}

/**
 * Wiring contract for {@link dispatchIncomingMessage}.  The real panel
 * passes `(session, sheet, () => this.render(), reply => panel.webview.
 * postMessage(reply))`; the test passes spies.
 */
export interface DispatchDeps {
	readonly session: SessionInstance;
	readonly sheet: number;
	readonly onCommit: () => void;
	readonly onError: (reply: ErrorReplyMessage) => void;
	/**
	 * **Phase 5.7 V3.5.0.7 (2026-05-24)** -- mid-edit-render guard
	 * callback.  Fired on `presenceUpdate` arm IFF the envelope passes
	 * runtime validation (shape + numeric) AND the engine's
	 * `updatePresence` succeeds.  `typing: true` -> host sets the
	 * `_presenceRepaintInFlight` flag (skips merged-tick renders
	 * until typing:false); `typing: false` -> host clears the flag
	 * (renders resume).  Optional for backward compat with tests that
	 * don't care about the guard (V3.4.0.X tests + V3.5.0.5 tests
	 * predate the field); when omitted, the dispatcher just doesn't
	 * fire it.
	 */
	readonly onLocalTyping?: (typing: boolean) => void;
	/**
	 * **Phase 5.7 V3.6.0.11 D9 (2026-05-26)** -- mid-edit-render guard
	 * typing-stroke watchdog reset.  Fired on the `'typing_stroke'`
	 * envelope arm (no payload).  The webview emits one `typing_stroke`
	 * per text-change input event while the active edit input is open;
	 * the host resets the {@link CellGridPanel.PRESENCE_TYPING_WATCHDOG_MS}
	 * timer IFF `_presenceRepaintInFlight === true` (no-op otherwise).
	 * Closes R-V3.5-7 "long formula entry hits 30s" false-negative case
	 * documented in the V3.6.0.1 D9 design lock.
	 *
	 * Optional for backward compat with tests that don't care about the
	 * watchdog (the pre-V3.6.0.11 mocha suite predates this field); when
	 * omitted, the dispatcher just doesn't fire it.
	 */
	readonly onTypingStroke?: () => void;
	/**
	 * **FE-2-0 Phase 2 (commit-token, 2026-06-04)** -- success ack for a tokened
	 * `putValue`. Fired (in addition to {@link onCommit}'s session-wide render) ONLY
	 * when the committing envelope carried a `commitId`; the panel posts a
	 * {@link CommitResultMessage} to the ORIGINATING webview so it resolves exactly
	 * this edit. `webviewId` (megaudit 2026-06-09) is the request's instance token, echoed in
	 * the ack so a stale post-reload commitResult cannot resolve a fresh webview's editor.
	 * Optional for backward compat with tests + pre-token envelopes.
	 */
	readonly onAck?: (commitId: number, webviewId?: string) => void;
	/**
	 * **megaudit (webview-instance token, 2026-06-09)** -- fired on a SUCCESSFUL
	 * {@link PutCellsRequest} (after `Session.batch` + recalc) so the panel posts a
	 * {@link CellsWrittenMessage} to the ORIGINATING webview, which clears the written
	 * cells' error tints even when stored content did not change. `webviewId` is the
	 * request's instance token (echoed); a FAILED putCells does NOT fire this. Optional
	 * for backward compat with tests + pre-token envelopes.
	 */
	readonly onCellsWritten?: (sheet: number, cells: { row: number; col: number }[], webviewId?: string) => void;
	/**
	 * **W2 error-surface (2026-06-09)** -- fired on a SUCCESSFUL single `putValue` commit (after recalc),
	 * carrying the written cell so the host can clear that cell's sticky `errorReply` diagnostic from the
	 * Problems panel (a cell that committed cleanly no longer has a pending input rejection). Distinct from
	 * {@link onAck} (which carries only the commitId for the webview-editor handshake, not the cell) and
	 * {@link onCellsWritten} (the paste/fill batch). Optional for backward compat; when omitted the
	 * Problems-clear simply relies on the next render's stored-error reconciliation.
	 */
	readonly onCellCommitted?: (sheet: number, row: number, col: number) => void;
	/**
	 * **FE-2-0 Phase 2 (S2-MED1, 2026-06-04)** -- a SESSION-WIDE operation failure
	 * (undo/redo throw) that is NOT tied to a cell. Previously routed through
	 * {@link onError} with `row=0,col=0` sentinels, which mis-decorated cell A1 as
	 * errored. The panel now surfaces this as a plain warning toast (no cell tint, no
	 * commitId). Optional for backward compat; when omitted the failure is dropped
	 * (tests that don't wire it don't exercise the undo/redo-throw path).
	 */
	readonly onOperationError?: (message: string) => void;
	/**
	 * **FE-1.5 W-G-2b (2026-06-08)** -- the webview reported a new grid selection
	 * ({@link SelectionMessage}). Fired ONLY after the dispatcher validates the envelope (sheet match +
	 * all four coords integer + in the A1 extent); the panel stores it for
	 * {@link CellGridPanel.focusedGridSelection}. Purely informational -- no engine call, no render.
	 * Optional for backward compat (tests + the pre-W-G-2b webview that never posts `selection`); when
	 * omitted the `selection` arm is a safe no-op.
	 */
	readonly onSelectionChange?: (selection: GridSelection) => void;
	/**
	 * **W2 formula intelligence (2026-06-09)** -- the webview requested a non-mutating formula validation
	 * ({@link ValidateFormulaRequest}). The panel posts a {@link ValidateFormulaResultMessage} back to the
	 * originating webview. Fired ONLY after the dispatcher validates the envelope (sheet match + coords in
	 * the A1 extent + a string `text`). Optional for backward compat (tests + the pre-W2 webview that never
	 * posts `validateFormula`); when omitted the arm is a safe no-op.
	 */
	readonly onValidateFormula?: (result: ValidateFormulaResultMessage) => void;
	/**
	 * **W2 formula intelligence (2026-06-09)** -- the webview requested the function catalog
	 * ({@link ListFunctionsRequest}). The panel posts a {@link FunctionListMessage} back. Optional for
	 * backward compat; when omitted the arm is a safe no-op.
	 */
	readonly onListFunctions?: (result: FunctionListMessage) => void;
}

/**
 * **FE-2-0 Phase 2 (C1-MED5, 2026-06-04)** -- the A1 renderable extent the grid panel accepts. The
 * engine validates coordinates to u32 (`4294967295`), but the A1 grid only renders `[0,A1_MAX_ROWS) x
 * [0,A1_MAX_COLS)`; a putValue outside it (only reachable from a tampered webview bundle -- the live
 * webview clamps nav to this extent) would commit an INVISIBLE cell. The dispatcher rejects it with a
 * `bad_argument` errorReply instead. **These MUST match `webview/sheets-webview/gridLayoutA1.ts`'s
 * `MAX_ROWS`/`MAX_COLS`** (kept as a host-local pin rather than a cross-bundle import, since the
 * webview module is esbuild-isolated from the host runtime). */
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

/**
 * **FE megaudit M9 (2026-06-03)** -- maximum accepted length of a single
 * `putValue.rawInput` at the host dispatch boundary. Excel caps a formula at 8192
 * chars; a literal cell value is far shorter. Anything larger is rejected with a
 * `bad_argument` errorReply before it reaches the synchronous napi parse (DoS
 * defense-in-depth against a tampered local webview bundle). The engine should
 * mirror this cap at the napi boundary.
 */
const MAX_RAW_INPUT_LENGTH = 8192;

/**
 * **FE megaudit L-k (2026-06-03)** -- sanitize a coordinate echoed back in an
 * `errorReply`. The reply's row/col flow to the webview (a Map key) and to the
 * host's warning toast; a tampered bundle could post a non-finite / fractional /
 * negative coord. Number-coerce to a finite non-negative integer, defaulting to 0
 * for anything that does not coerce cleanly, so the echoed envelope never carries
 * garbage. (This is defense-in-depth -- the engine validators already reject bad
 * coords on the write path; this only sanitizes the ECHO.)
 */
function sanitizeCoord(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) {
		return 0;
	}
	return Math.floor(n);
}

/**
 * V3.2.b.3 host-side message dispatcher.
 *
 * Discriminates on `type`:
 * - `putValue` -> parse + validate + commit via
 *   {@link appendPutValueValidated}.  Success: `onCommit()`.  Failure:
 *   `onError(errorReply)` with the structured code from
 *   {@link parseQuantbookError}.
 * - Anything else -> logged + dropped (per V3.2.b.1 decision B1
 *   "unknown types logged + ignored both directions").
 *
 * Sheet-mismatched `putValue` requests are dropped with a warning
 * (defense: the webview script bakes its sheet as a const but a future
 * multi-sheet panel might multiplex).
 */
export function dispatchIncomingMessage(raw: unknown, deps: DispatchDeps): void {
	if (typeof raw !== 'object' || raw === null) {
		console.warn('[cellGrid] dropped non-object incoming message:', raw);
		return;
	}
	const msg = raw as { type?: unknown };
	if (typeof msg.type !== 'string') {
		console.warn('[cellGrid] dropped incoming message with no string type field:', msg);
		return;
	}
	// V3.4.0.3 (2026-05-23): handle undo / redo before the putValue
	// branch.  Both envelopes have no payload (the engine action is
	// session-wide, not cell-specific).  On consumed=true call
	// deps.onCommit() to trigger panel re-render via the V3.3.0.3
	// cache.  On consumed=false (empty undo/redo stack) silent no-op
	// -- the user pressed Cmd-Z with nothing to undo, no UX feedback
	// needed.  On engine throw: FE-2-0 Phase 2 (S2-MED1) routes through
	// deps.onOperationError -- a SESSION-WIDE failure with no cell, so a
	// plain warning toast (NOT an errorReply with row=0/col=0 sentinels,
	// which mis-decorated cell A1 as errored). Message prefixed with
	// [undo]/[redo] so the user sees which action failed.
	if (msg.type === 'undo' || msg.type === 'redo') {
		try {
			// FE-0a Part B (B1): the owning Session's undo/redo return
			// `UndoRedoResultJson { consumed, version }` (vs CollabSession's bare
			// boolean). consumed=false is an empty stack -> silent no-op.
			const result = msg.type === 'undo' ? deps.session.undo() : deps.session.redo();
			if (result.consumed) {
				deps.onCommit();
			}
			return;
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onOperationError?.(`[${msg.type}] [${info.code}] ${info.message}`);
			return;
		}
	}
	// FE-0a Part B (B1, 2026-06-02): presence + the typing-watchdog are
	// COLLAB-ONLY (the owning single-writer `Session` has no presence channel;
	// `updatePresence` does not exist on it). Real-time collab is v1.5-deferred
	// ("CRDT built, transport unwired"), so silently DROP these envelopes if the
	// dormant webview still emits them -- no engine call, no error. The full
	// presence logic (validatePresenceNumeric, classifyPollTick, onLocalTyping/
	// onTypingStroke) is preserved exported/dormant for the v1.5 collab re-enable.
	if (msg.type === 'presenceUpdate' || msg.type === 'typing_stroke') {
		return;
	}
	// **FE-1.5 W-G-2b (2026-06-08)**: the webview's selection report. INFORMATIONAL -- it never
	// touches the engine and has no editor to un-stick, so an invalid/mismatched envelope is DROPPED
	// with a warning (like presenceUpdate), NOT answered with an errorReply. Validate strictly (sheet
	// match + all four coords finite integers in the A1 extent) and store the clean payload via
	// onSelectionChange; the panel then exposes it for the "bind variable to selected cell" flow.
	if (msg.type === 'selection') {
		const sel = raw as SelectionMessage;
		const coordOk = (v: unknown, max: number): boolean =>
			typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max;
		if (
			sel.sheet !== deps.sheet ||
			!coordOk(sel.anchorRow, A1_MAX_ROWS) ||
			!coordOk(sel.focusRow, A1_MAX_ROWS) ||
			!coordOk(sel.anchorCol, A1_MAX_COLS) ||
			!coordOk(sel.focusCol, A1_MAX_COLS)
		) {
			console.warn('[cellGrid] dropped invalid selection message:', sel);
			return;
		}
		deps.onSelectionChange?.({
			sheet: sel.sheet,
			anchorRow: sel.anchorRow,
			anchorCol: sel.anchorCol,
			focusRow: sel.focusRow,
			focusCol: sel.focusCol,
		});
		return;
	}
	// **W2 formula intelligence (2026-06-09)**: a non-mutating formula validation request from the formula
	// bar (debounced keystroke-validation). It does NOT touch persisted state -- `session.validateFormula`
	// parses + binds WITHOUT applying -- so this is REQUEST/REPLY, not a write: validate the envelope, call
	// the engine, and post the diagnostics (or the engine error) back to the originating webview. A bad
	// envelope (wrong sheet, off-extent coord, non-string text) is answered with `ok:true, diagnostics:[]`
	// only if it is well-formed; otherwise it is DROPPED with a warning (there is no cell to decorate and no
	// editor to un-stick -- this is an advisory read). No-Fallbacks: an engine THROW is reported as
	// `ok:false` with the structured error, never swallowed into an empty (falsely-valid) diagnostics list.
	if (msg.type === 'validateFormula') {
		const req = raw as ValidateFormulaRequest;
		if (typeof req.reqId !== 'number' || !Number.isInteger(req.reqId)) {
			console.warn('[cellGrid] dropped validateFormula with a non-integer reqId:', req);
			return;
		}
		if (
			req.sheet !== deps.sheet ||
			typeof req.row !== 'number' || !Number.isInteger(req.row) || req.row < 0 || req.row >= A1_MAX_ROWS ||
			typeof req.col !== 'number' || !Number.isInteger(req.col) || req.col < 0 || req.col >= A1_MAX_COLS ||
			typeof req.text !== 'string'
		) {
			console.warn('[cellGrid] dropped invalid validateFormula request:', req);
			return;
		}
		// Mirror the putValue cap (engine DoS defense-in-depth): the validate path also parses synchronously.
		if (req.text.length > MAX_RAW_INPUT_LENGTH) {
			deps.onValidateFormula?.({
				type: 'validateFormulaResult',
				reqId: req.reqId,
				ok: false,
				error: `[bad_argument] formula is ${req.text.length} chars, over the ${MAX_RAW_INPUT_LENGTH}-char limit`,
				webviewId: req.webviewId,
			});
			return;
		}
		try {
			const diagnostics = deps.session.validateFormula(req.sheet, req.row, req.col, req.text);
			deps.onValidateFormula?.({
				type: 'validateFormulaResult',
				reqId: req.reqId,
				ok: true,
				diagnostics,
				webviewId: req.webviewId,
			});
		} catch (err) {
			// No-Fallbacks: surface the engine failure (do NOT report "valid"). The webview shows the error
			// hint reason; the user is not misled into thinking a broken formula validated.
			const info = parseQuantbookError(err);
			deps.onValidateFormula?.({
				type: 'validateFormulaResult',
				reqId: req.reqId,
				ok: false,
				error: `[${info.code}] ${info.message}`,
				webviewId: req.webviewId,
			});
		}
		return;
	}
	// **W2 formula intelligence (2026-06-09)**: the function-catalog request for the completion dropdown.
	// Read-only (`session.listFunctions` lists built-ins + UDFs). REQUEST/REPLY like validateFormula. The
	// webview requests it once after the handshake and caches it. No-Fallbacks: an engine THROW is reported
	// as `ok:false`, never an empty list that would silently disable completions with no explanation.
	if (msg.type === 'listFunctions') {
		const req = raw as ListFunctionsRequest;
		if (typeof req.reqId !== 'number' || !Number.isInteger(req.reqId)) {
			console.warn('[cellGrid] dropped listFunctions with a non-integer reqId:', req);
			return;
		}
		try {
			const functions = deps.session.listFunctions();
			deps.onListFunctions?.({
				type: 'functionList',
				reqId: req.reqId,
				ok: true,
				functions,
				webviewId: req.webviewId,
			});
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onListFunctions?.({
				type: 'functionList',
				reqId: req.reqId,
				ok: false,
				error: `[${info.code}] ${info.message}`,
				webviewId: req.webviewId,
			});
		}
		return;
	}
	// **FE-1.5 W-G copy/paste + fill (2026-06-08)**: a multi-cell atomic write (paste / fill). No open
	// editor backs it, so there is no pending-commit to resolve -- the host writes every cell in ONE
	// `Session.batch` (a single undo unit), recalcs, and re-renders via onCommit. An OPTIONAL `commitId`
	// only drives the success tint-ack below (deep-audit MED). A failure (bad envelope, an off-extent /
	// over-length cell, or an engine batch reject) is surfaced via onOperationError (a toast -- there is no
	// cell editor to un-stick), never silently dropped (No-Fallbacks). The batch is all-or-nothing, so a
	// single bad cell applies NOTHING.
	if (msg.type === 'putCells') {
		const req = raw as PutCellsRequest;
		const label = typeof req.undoLabel === 'string' && req.undoLabel.length > 0 ? req.undoLabel : 'Edit cells';
		if (req.sheet !== deps.sheet) {
			deps.onOperationError?.(`[${label}] [bad_argument] putCells sheet ${req.sheet} does not match this panel's sheet ${deps.sheet}; nothing was applied.`);
			return;
		}
		if (!Array.isArray(req.cells)) {
			deps.onOperationError?.(`[${label}] [bad_argument] putCells: cells must be an array; nothing was applied.`);
			return;
		}
		let ops: SessionOpJson[];
		try {
			ops = buildBatchOps(req.sheet, req.cells);
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onOperationError?.(`[${label}] [${info.code}] ${info.message}`);
			return;
		}
		try {
			deps.session.batch(ops, { undoLabel: label });
			recalcDirtyChecked(deps.session);
			deps.onCommit();
			// megaudit (webview-instance token, 2026-06-09): report the WRITTEN cells to the originating webview
			// so it clears their error tints even when the write did not change stored content (a
			// content-identical render would miss them). Echoes the request's webviewId so a stale post-reload
			// report can't clear a fresh webview's tint, and carries the sheet so a cross-sheet ack is dropped.
			// Reached ONLY on success (after batch + recalc); a FAILED putCells (catch below) reports nothing,
			// so a stale tint correctly stays (No-Fallbacks).
			deps.onCellsWritten?.(req.sheet, req.cells.map(c => ({ row: c.row, col: c.col })), req.webviewId);
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onOperationError?.(`[${label}] [${info.code}] ${info.message}`);
		}
		return;
	}
	// **FE-5 W-R (2026-06-12)**: a cell-STYLE mutation over a rect. The engine is the SOLE style source,
	// so the toolbar's style controls POST this; the host reads each cell's current style from the
	// workbook snapshot, computes the per-cell target StyleJson for the uniform mutation, interns the
	// DISTINCT styles via `registerStyle`, and commits ONE `setStyle` batch (a single undo unit), then
	// recalcs + re-renders via onCommit (the render carries the new styles[] + per-cell styleIds, so the
	// style appears). Like putCells, no open editor backs it; a failure (bad envelope / malformed style /
	// engine reject) surfaces via onOperationError (a toast), never silently dropped (No-Fallbacks).
	if (msg.type === 'setStyle') {
		const req = raw as SetStyleRequest;
		const label = typeof req.undoLabel === 'string' && req.undoLabel.length > 0 ? req.undoLabel : 'Format cells';
		if (req.sheet !== deps.sheet) {
			deps.onOperationError?.(`[${label}] [bad_argument] setStyle sheet ${req.sheet} does not match this panel's sheet ${deps.sheet}; nothing was applied.`);
			return;
		}
		if (typeof req.rect !== 'object' || req.rect === null) {
			deps.onOperationError?.(`[${label}] [bad_argument] setStyle: rect must be an object; nothing was applied.`);
			return;
		}
		const mutationError = validateStyleMutation(req.mutation);
		if (mutationError !== null) {
			deps.onOperationError?.(`[${label}] [bad_argument] setStyle: ${mutationError}; nothing was applied.`);
			return;
		}
		let targets: { row: number; col: number; style: StyleJson }[];
		try {
			// Read a fresh full snapshot so the read-modify-write starts from the engine's CURRENT styles
			// (a user style action, not a keystroke -- the O(N) snapshot cost is fine here).
			const snapshot = deps.session.snapshot();
			targets = computeStyleTargets(snapshot, req.sheet, req.rect, req.mutation);
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onOperationError?.(`[${label}] [${info.code}] ${info.message}`);
			return;
		}
		try {
			// Intern each DISTINCT StyleJson once (registerStyle is idempotent + interning avoids N
			// redundant napi calls for a uniform selection), then build one setStyle op per cell.
			const idByKey = new Map<string, StyleIdJson>();
			const ops: SessionOpJson[] = [];
			for (const t of targets) {
				const key = styleJsonKey(t.style);
				let id = idByKey.get(key);
				if (id === undefined) {
					id = deps.session.registerStyle(t.style);
					idByKey.set(key, id);
				}
				ops.push({ kind: 'setStyle', sheet: req.sheet, row: t.row, col: t.col, style: id });
			}
			deps.session.batch(ops, { undoLabel: label });
			recalcDirtyChecked(deps.session);
			deps.onCommit();
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onOperationError?.(`[${label}] [${info.code}] ${info.message}`);
		}
		return;
	}
	if (msg.type !== 'putValue') {
		console.warn(`[cellGrid] unknown outbound message type: ${msg.type}`);
		return;
	}
	const req = raw as PutValueRequest;
	// V3.2.d HIGH-2 closure (2026-05-22, dispatcher-side defense in
	// depth): runtime-check the inner envelope fields BEFORE calling
	// parseCellRawInput / appendPutValueValidated.  Pre-V3.2.d the
	// dispatcher trusted the type assertion + a malformed envelope
	// like `{type:'putValue', rawInput:null}` produced `parseCellRawInput(null)`
	// -> `null.trim()` -> TypeError -> errorReply with code `'unknown'`
	// (TypeError has no bracket prefix).  Now: pre-validate field
	// types + emit a structured `bad_argument` errorReply so webview
	// consumers can `switch (info.code)` cleanly.
	if (typeof req.rawInput !== 'string') {
		deps.onError({
			type: 'errorReply',
			sheet: typeof req.sheet === 'number' ? req.sheet : deps.sheet,
			row: sanitizeCoord(req.row),
			col: sanitizeCoord(req.col),
			code: 'bad_argument',
			message: `rawInput must be a string, got ${typeof req.rawInput}`,
			commitId: req.commitId, // FE-2-0 Phase 2: echo so the originating edit un-sticks
			webviewId: req.webviewId, // megaudit: echo so a stale post-reload reply is dropped
		});
		return;
	}
	// **FE megaudit M9 (2026-06-03)**: cap cell-input length at the host boundary
	// BEFORE parsing/formula-binding (engine DoS defense-in-depth). The napi
	// setValue/setFormula parse the whole string synchronously; a hostile/tampered
	// local webview bundle could post a multi-MB rawInput and stall the extension
	// host on the parse. A real cell value / formula is far under this bound
	// (Excel's own formula limit is 8192 chars), so reject over-limit loud rather
	// than feed it to the engine. NOTE: the engine should mirror this cap at the
	// napi boundary (it is the ultimate trust boundary; this TS guard only protects
	// the in-process host path).
	if (req.rawInput.length > MAX_RAW_INPUT_LENGTH) {
		deps.onError({
			type: 'errorReply',
			sheet: typeof req.sheet === 'number' ? req.sheet : deps.sheet,
			row: sanitizeCoord(req.row),
			col: sanitizeCoord(req.col),
			code: 'bad_argument',
			message: `rawInput is ${req.rawInput.length} chars, exceeding the ${MAX_RAW_INPUT_LENGTH}-char limit; the edit was not applied.`,
			commitId: req.commitId,
			webviewId: req.webviewId, // megaudit: echo so a stale post-reload reply is dropped
		});
		return;
	}
	if (req.sheet !== deps.sheet) {
		// **FE megaudit L-g (2026-06-03)**: do NOT drop a sheet-mismatched putValue with
		// only a console.warn -- the webview editor stays in its pessimistic
		// `pendingCommit` state forever (no render, no errorReply), so the user's
		// edit input is stuck. Send a `bad_argument` errorReply so the editor un-sticks
		// (re-arms blur-cancel + surfaces the reason). This is a defense path: the
		// webview bakes its sheet as a const today, but a future multi-sheet panel
		// could multiplex.
		console.warn(`[cellGrid] putValue sheet mismatch: req.sheet=${req.sheet} deps.sheet=${deps.sheet}`);
		deps.onError({
			type: 'errorReply',
			sheet: req.sheet,
			row: sanitizeCoord(req.row),
			col: sanitizeCoord(req.col),
			code: 'bad_argument',
			message: `putValue sheet ${req.sheet} does not match this panel's sheet ${deps.sheet}; the edit was not applied.`,
			commitId: req.commitId,
			webviewId: req.webviewId, // megaudit: echo so a stale post-reload reply is dropped
		});
		return;
	}
	// **FE-2-0 Phase 2 (C1-MED5)**: reject a putValue whose coordinate is outside the A1 renderable
	// EXTENT. The engine accepts any u32 coord and would store an INVISIBLE cell; the live webview clamps
	// nav to this extent, so an off-extent coord is only reachable from a tampered bundle. Range-only --
	// integrality/NaN/finiteness are left to the engine validator (its "row must be an integer" message
	// is clearer); this only adds the extent bound the engine lacks. Echo commitId so the editor un-sticks.
	if (req.row < 0 || req.row >= A1_MAX_ROWS || req.col < 0 || req.col >= A1_MAX_COLS) {
		deps.onError({
			type: 'errorReply',
			sheet: req.sheet,
			row: sanitizeCoord(req.row),
			col: sanitizeCoord(req.col),
			code: 'bad_argument',
			message: `cell (row ${req.row}, col ${req.col}) is outside the A1 grid extent (${A1_MAX_ROWS}x${A1_MAX_COLS}); the edit was not applied.`,
			commitId: req.commitId,
			webviewId: req.webviewId, // megaudit: echo so a stale post-reload reply is dropped
		});
		return;
	}
	try {
		// **Phase 5.7 V3.6.0.X audit-of-D5 OPUS-HIGH-1 closure (2026-05-24)**:
		// route inputs starting with `=` to appendPutFormulaValidated.
		// Mirrors Excel convention -- `=...` is a formula; anything else
		// is a literal value.  Pre-closure ALL inputs (including
		// `=SUM(A1:B10)` or `=A1+B1`) went through parseCellRawInput,
		// which did Number("=A1+B1".trim()) -> NaN -> [bad_argument]
		// errorReply.  The user could not enter formulas from the IDE
		// even though the V3.6.0.6 D5 napi `appendPutFormula` existed.
		// Post-closure: server-side prefix detection routes formula
		// entry to the formula napi.  The webview-side endEdit envelope
		// is UNCHANGED (still `{type:'putValue', rawInput}`); the host
		// dispatcher does the classification.
		//
		// Trim before checking -- whitespace-then-`=` is still a formula
		// per Excel.  But pass the ORIGINAL (un-trimmed-prefix) text to
		// the engine so the formula source the user typed survives
		// verbatim (the engine stores the text as-is and only trims at
		// evaluation time).  Empty `=` alone is a malformed formula;
		// the engine surfaces it via `#NAME?` evaluation, not a JS
		// throw -- matches the appendPutFormulaValidated docstring's
		// "any string is a valid formula at the wire level" semantic.
		// FE-0a Part B (B1): write via the owning Session. `=`-prefix ->
		// setFormula; else classify the literal as number/text/blank
		// (classifyCellInput -- the text-cell fix) and setValue. Unlike
		// CollabSession's appendPut* (which recomputed during op-apply),
		// Session.setValue/setFormula only mark dependents dirty, so we MUST
		// recalc before the re-snapshot or formulas stay stale.
		if (req.rawInput.trimStart().startsWith('=')) {
			// Session.setFormula takes the formula BODY without the leading `=`
			// (the `=` is the spreadsheet-UI convention; the engine parser rejects
			// it: `parse error: unexpected token in prefix: Op(Eq)`). Strip the
			// leading whitespace + `=`; the engine eagerly parses+binds and stores
			// a normalized form (e.g. `A1*2` -> `A1 * 2`). Unlike CollabSession's
			// lazy appendPutFormula, an invalid/unsupported formula throws
			// [formula_parse]/[formula_bind] here and surfaces as a loud errorReply
			// (No-Fallbacks) instead of a deferred #ERROR cell value.
			const formula = req.rawInput.trimStart().slice(1);
			setFormulaValidated(deps.session, req.sheet, req.row, req.col, formula);
		} else {
			setValueValidated(deps.session, req.sheet, req.row, req.col, classifyCellInput(req.rawInput));
		}
		recalcDirtyChecked(deps.session);
		deps.onCommit();
		// W2 error-surface: this cell committed cleanly -> clear any sticky `errorReply` diagnostic it had
		// in the Problems panel (the prior input rejection no longer applies). Fired unconditionally on
		// success (no commitId gate -- the diagnostic clear is independent of the webview-editor handshake).
		deps.onCellCommitted?.(req.sheet, req.row, req.col);
		// FE-2-0 Phase 2 (commit-token): ack THIS commit to the originating panel (in addition to the
		// session-wide render `onCommit` triggers), so its webview resolves exactly this edit. Only when
		// the envelope carried a commitId (the live webview always stamps one; pre-token/tests may not).
		if (typeof req.commitId === 'number') {
			deps.onAck?.(req.commitId, req.webviewId);
		}
	} catch (err) {
		const info = parseQuantbookError(err);
		deps.onError({
			type: 'errorReply',
			sheet: req.sheet,
			// FE megaudit L-k: sanitize the echoed coords (defense-in-depth).
			row: sanitizeCoord(req.row),
			col: sanitizeCoord(req.col),
			code: info.code,
			message: info.message,
			commitId: req.commitId, // FE-2-0 Phase 2: echo so the originating edit un-sticks + decorates
			webviewId: req.webviewId, // megaudit: echo so a stale post-reload reply is dropped
		});
	}
}

// ============================================================================
// Phase 5.7 V3.3.0.4 (2026-05-22) -- virtualization pure helpers
// ============================================================================

/**
 * **DORMANT / DEAD (FE megaudit S6 + L-f, 2026-06-03)** -- this HOST-side
 * `computeVisibleRange` has NO live caller. The live virtualization math is the
 * webview's `cellRender.computeVisibleRowRange` (which the Canvas2D renderer drives);
 * this host copy was for the retired DOM-table path. **L-f**: unlike the live
 * `computeVisibleRowRange`, this copy LACKS the shrink-clamp on `firstVisible`, so a
 * stale large `scrollTop` after the data shrinks could return an empty window -- do
 * NOT re-wire it without porting that clamp. Retained + unit-tested for reference.
 *
 * V3.3.0.4 -- compute the visible-row index range given scroll geometry.
 *
 * Per V3.3.0.1 decision D1 (custom-inline virtualization; no library).
 * Pure function -- no vscode, no `this`, no side effects.  Mocha-
 * driveable in isolation.
 *
 * Returns the half-open range `[startIdx, endIdx)` of snapshot
 * entries that should be in the DOM.  The caller renders those rows
 * + sandwiches them between top/bottom spacer rows whose heights
 * preserve the viewport's scroll geometry.
 *
 * @param scrollTop      pixels scrolled from the top of the viewport.
 *                       Webview reads from `viewport.scrollTop`.
 * @param rowHeight      pixel height of one rendered row.  V3.3.0.4
 *                       uses a constant `ROW_HEIGHT = 25` (matches
 *                       the V3.2.b `<td>` padding `4px 12px` + ~17px
 *                       text).  V3.x may make this measurement-based.
 * @param viewportHeight pixel height of the scrolling viewport.
 *                       Webview reads from `viewport.clientHeight`.
 * @param totalRows      total snapshot entries (the number of rows
 *                       the table WOULD have without virtualization).
 * @param overscan       extra rows rendered above + below the visible
 *                       window for smooth scrolling.  Default 5.
 * @returns `{ startIdx, endIdx }` -- half-open; `startIdx == endIdx == 0`
 *           when `totalRows === 0`.  Both indices are clamped to
 *           `[0, totalRows]`.
 */
export function computeVisibleRange(
	scrollTop: number,
	rowHeight: number,
	viewportHeight: number,
	totalRows: number,
	overscan: number = 5,
): { startIdx: number; endIdx: number } {
	if (totalRows === 0) {
		return { startIdx: 0, endIdx: 0 };
	}
	if (rowHeight <= 0) {
		// Defensive: a zero or negative rowHeight would div-by-zero or
		// produce negative counts.  Render everything; the caller can
		// still display the table (just without virtualization).
		return { startIdx: 0, endIdx: totalRows };
	}
	const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
	const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
	const startIdx = Math.max(0, firstVisible - overscan);
	const endIdx = Math.min(totalRows, firstVisible + visibleCount + overscan);
	return { startIdx, endIdx };
}

/**
 * **DORMANT / DEAD (FE megaudit S6, 2026-06-03)** -- NO live caller. This fed the
 * retired DOM-table `cellGridHtml.ts::buildHtml` slice path; the Canvas2D renderer
 * windows rows itself (it draws directly from `snapshot.entries`, no host-side
 * pre-slice). The `data-row`/`data-original-*` attributes named below belong to the
 * dead DOM table, NOT the live canvas. Retained + unit-tested for reference.
 *
 * V3.3.0.4 -- slice a snapshot's entries to the index range
 * `[startIdx, endIdx)`.
 *
 * Pure function over snapshot data.  (Historically verified that the slice
 * preserved the V3.2.a/b/c data-row + data-col + data-original-text +
 * data-original-kind invariants the retired `cellGridHtml.ts::buildHtml` consumed.)
 *
 * Returns the sliced sub-array (NOT mutating the input).
 *
 * @param entries  the full sorted ascending `snapshot.entries`.
 * @param startIdx inclusive start index; clamped to `[0, entries.length]`.
 * @param endIdx   exclusive end index; clamped to `[startIdx, entries.length]`.
 * @returns the sub-array `entries[startIdx..endIdx)`.
 */
export function buildVirtualRows<T>(
	entries: ReadonlyArray<T>,
	startIdx: number,
	endIdx: number,
): T[] {
	const len = entries.length;
	const clampedStart = Math.max(0, Math.min(startIdx, len));
	const clampedEnd = Math.max(clampedStart, Math.min(endIdx, len));
	return entries.slice(clampedStart, clampedEnd);
}

// ============================================================================
// Phase 5.7 V3.3.0.5 (2026-05-22) -- multi-sheet UX helpers
// ============================================================================

/**
 * V3.3.0.5 -- shape of one row in the switch-sheet QuickPick.
 *
 * Stays vscode-agnostic: just `label` + `description` + `sheet` so
 * mocha can pin the structure without pulling in `vscode.QuickPickItem`.
 * The command site wraps these in real `vscode.QuickPickItem`s.
 */
export interface SheetQuickPickItem {
	readonly label: string;
	readonly description: string;
	readonly sheet: number;
}

/**
 * V3.3.0.5 -- build the QuickPick items for the switch-sheet command.
 *
 * Pure function over sheet IDs.  Mocha-testable without vscode.
 *
 * - The `description` field labels the CURRENT sheet so the user can
 *   see which one they're switching FROM.  Other entries get empty
 *   description (avoids visual noise).
 * - Sheets are presented in the input order (caller is expected to
 *   pass them sorted ascending; `listSheets` already returns sorted).
 *
 * @param sheets       sheet IDs to offer.  Caller-sorted (typically
 *                     the result of `listSheets(session)`).
 * @param currentSheet sheet ID of the panel from which the user
 *                     invoked the switch command.  Annotated as
 *                     "(current)" in its description.
 * @returns one item per input sheet.  Empty if `sheets` is empty.
 */
export function buildSheetQuickPickItems(
	sheets: ReadonlyArray<number>,
	currentSheet: number,
): SheetQuickPickItem[] {
	return sheets.map(s => ({
		label: `Sheet ${s}`,
		description: s === currentSheet ? '(current)' : '',
		sheet: s,
	}));
}

/**
 * **Phase 5.7 V3.5.0.4a (2026-05-24) -- shape of one row in the
 * sheet-management QuickPick** (rename / delete / move source selectors).
 *
 * Like {@link SheetQuickPickItem} but carries the sheet's NAME alongside
 * the id, since V3.5.0.3 sheet ops are name-relevant to the user (the
 * user wants to know "rename WHICH sheet") and the ids alone aren't
 * meaningful for the user.
 *
 * Stays vscode-agnostic for direct mocha coverage; command site wraps
 * in real `vscode.QuickPickItem`s.
 */
export interface SheetManagementQuickPickItem {
	readonly label: string;
	readonly description: string;
	readonly sheet: number;
	readonly name: string;
}

/**
 * **Phase 5.7 V3.5.0.4a (2026-05-24) -- build QuickPick items for the
 * sheet-management commands (rename / delete / move source pickers).**
 *
 * Reads sheets from a {@link WorkbookSnapshotJson} so we get display-
 * order ordering (V3.5.0.3c) + tombstone filtering (V3.5.0.3b) for
 * free -- the engine napi already applies both at the snapshot layer,
 * so we just iterate `snapshot.sheets` in order.
 *
 * - `label` = `"Sheet N -- Name"` (id + name combined; the id is shown
 *   so the user can verify which underlying sheet they're acting on,
 *   the name is shown so they recognize it).
 * - `description` carries `(current)` for the panel's current sheet so
 *   the user knows which sheet they were viewing when they invoked
 *   the command.  Other entries get empty description (visual quiet).
 *
 * Pure function: no vscode dependency.  Mocha-testable in isolation.
 *
 * @param sheets       snapshot.sheets array from {@link workbookSnapshot}.
 *                     Iteration order is the engine's display-order
 *                     overlay (V3.5.0.3c) post-tombstone-filter (V3.5.0.3b).
 * @param currentSheet sheet ID of the panel from which the user invoked
 *                     the command.  Annotated as "(current)".  Pass any
 *                     non-existent id (e.g., `-1`) to suppress the
 *                     current-marker (e.g., for `add` flow which has no
 *                     source-sheet concept).
 * @returns one item per input sheet.  Empty if `sheets` is empty.
 */
export function buildSheetManagementQuickPickItems(
	sheets: ReadonlyArray<{ id: number; name: string }>,
	currentSheet: number,
): SheetManagementQuickPickItem[] {
	return sheets.map(s => ({
		label: `Sheet ${s.id} -- ${s.name}`,
		description: s.id === currentSheet ? '(current)' : '',
		sheet: s.id,
		name: s.name,
	}));
}

/**
 * **Phase 5.7 V3.5.0.4a (2026-05-24) -- build QuickPick items for the
 * sheet-MOVE target-position picker.**
 *
 * For `quantlab.quantbookSheetMove`, after the user picks the source
 * sheet via {@link buildSheetManagementQuickPickItems}, they then pick
 * the target display-order position.  Positions are 0-based; the picker
 * shows `"Position 0 (first)"` / `"Position 1 (between Sheet X and Sheet Y)"` /
 * etc. so users can see what's adjacent.
 *
 * Pure function.  Mocha-testable.
 *
 * @param sheets        post-move-source display-order list (i.e., the
 *                      snapshot.sheets BEFORE the move).  Each entry's
 *                      `id` + `name` is used for adjacency labels.
 * @param sourceSheetId the sheet being moved -- excluded from the
 *                      adjacency labels (since after the move it would
 *                      be at the target position itself).
 * @returns one item per valid target position `[0, sheets.length - 1]`
 *          (after removing the source sheet, the new max position is
 *          `len - 1`).  The source sheet's CURRENT position gets a
 *          `"(current)"` description.
 */
export function buildSheetMovePositionItems(
	sheets: ReadonlyArray<{ id: number; name: string }>,
	sourceSheetId: number,
): SheetManagementQuickPickItem[] {
	const currentSourcePos = sheets.findIndex(s => s.id === sourceSheetId);
	// After removing the source, the remaining display has length-1 entries;
	// valid target positions are [0, length-1] inclusive (insert anywhere).
	const remaining = sheets.filter(s => s.id !== sourceSheetId);
	const items: SheetManagementQuickPickItem[] = [];
	for (let pos = 0; pos < sheets.length; pos += 1) {
		let label = `Position ${pos}`;
		if (pos === 0) {
			label += ' (first)';
		} else if (pos === sheets.length - 1) {
			label += ' (last)';
		} else {
			// pos is between remaining[pos - 1] and remaining[pos].
			const before = remaining[pos - 1];
			const after = remaining[pos];
			if (before !== undefined && after !== undefined) {
				label += ` (between Sheet ${before.id} and Sheet ${after.id})`;
			}
		}
		items.push({
			label,
			description: pos === currentSourcePos ? '(current)' : '',
			sheet: pos,  // re-using sheet field as target position; semantically the "pick value"
			name: '',
		});
	}
	return items;
}

// ============================================================================
// Smoke-megaudit host batch (2026-06-05) -- pure command-target selection helpers.
// These back the sheet-management / Save-As commands in `quantbookCommands.ts`.
// Extracted as pure functions so the targeting + deleted-active-sheet recovery
// logic (previously inline in the vscode command closures) is unit-testable.
// ============================================================================

/**
 * The panel a sheet-management / Save-As command should act on.
 *
 * - `target`: an unambiguous (session, sheet) to operate on.
 * - `ambiguous`: more than one DISTINCT workbook (session) is open and none is
 *   focused -- there is no safe automatic pick, so the command must ask the user
 *   to focus the grid they mean (rather than silently mutating an arbitrary one).
 */
export type CommandTargetResolution =
	| { kind: 'target'; session: SessionInstance; sheet: number }
	| { kind: 'ambiguous' };

/**
 * **Smoke-megaudit host MED (2026-06-05) -- centralized command target selection.**
 *
 * Replaces the per-command `focusedLocalPanel() ?? localPanels[0]` fallback, which
 * silently targeted an ARBITRARY (oldest) workbook when no panel was focused and
 * several workbooks were open -- so a sheet add/rename/delete/move/save could land
 * on the WRONG workbook. Now:
 *
 * - a focused panel always wins (the grid the user is looking at);
 * - with no focus, a pick is unambiguous ONLY if every open panel belongs to the
 *   SAME session (one workbook, possibly several sheet tabs) -- then any of its
 *   panels is the same workbook, so `panels[0]` is safe;
 * - with no focus AND two or more distinct sessions open, the result is `ambiguous`
 *   and the caller must prompt the user to focus a grid (No-Fallbacks: never guess
 *   which workbook to mutate).
 *
 * Pure: identity-compares `SessionInstance` references; no vscode, mocha-testable.
 *
 * @param panels  the currently-open panels' (session, sheet) pairs
 *                (`CellGridPanel.activeLocalPanels()`); MUST be non-empty (callers
 *                handle the no-panel case before calling).
 * @param focused the focused panel's (session, sheet), or `undefined`
 *                (`CellGridPanel.focusedLocalPanel()`).
 */
export function resolveCommandTargetPanel(
	panels: ReadonlyArray<{ session: SessionInstance; sheet: number }>,
	focused: { session: SessionInstance; sheet: number } | undefined,
): CommandTargetResolution {
	if (focused !== undefined) {
		return { kind: 'target', session: focused.session, sheet: focused.sheet };
	}
	const distinctSessions = new Set<SessionInstance>(panels.map(p => p.session));
	if (distinctSessions.size === 1 && panels.length > 0) {
		return { kind: 'target', session: panels[0].session, sheet: panels[0].sheet };
	}
	// Zero panels (precondition violated) or 2+ distinct workbooks with no focus.
	return { kind: 'ambiguous' };
}

/**
 * The plan for the "Switch Cell Grid Sheet" command given the session's LIVE sheet
 * ids and the panel's current sheet.
 *
 * - `no-sheets`: the session has no live sheets at all.
 * - `only-current`: exactly one live sheet and it is the one already shown -- there
 *   is nothing to switch to.
 * - `auto`: exactly one live sheet and it is NOT the current one -- the active sheet
 *   was deleted out from under the panel; switch straight to the sole survivor.
 * - `pick`: two or more live sheets -- show the quick-pick.
 */
export type SwitchSheetPlan =
	| { kind: 'no-sheets' }
	| { kind: 'only-current' }
	| { kind: 'auto'; sheet: number }
	| { kind: 'pick' };

/**
 * **Smoke-megaudit host MED (2026-06-05) -- Switch Sheet recovers from a deleted
 * active sheet.**
 *
 * The prior command blocked on `sheetInfos.length === 1` with "nothing to switch to"
 * even when that sole live sheet was NOT the current one -- i.e. when the active
 * sheet had been tombstoned via "Delete Sheet" and the panel was stranded on an
 * empty grid. Now a single live sheet that differs from `currentSheet` yields an
 * `auto` switch to it; `only-current` is reserved for the genuinely-nothing-to-do
 * case (the one live sheet IS the current one).
 *
 * Pure: no vscode, mocha-testable.
 *
 * @param sheetIds    live sheet ids for the session (tombstones already filtered by
 *                    the engine; order as returned by `listSheets`).
 * @param currentSheet the sheet the panel is currently showing (may be a tombstone,
 *                    i.e. absent from `sheetIds`).
 */
export function classifySwitchSheetTarget(
	sheetIds: ReadonlyArray<number>,
	currentSheet: number,
): SwitchSheetPlan {
	if (sheetIds.length === 0) {
		return { kind: 'no-sheets' };
	}
	if (sheetIds.length === 1) {
		return sheetIds[0] === currentSheet
			? { kind: 'only-current' }
			: { kind: 'auto', sheet: sheetIds[0] };
	}
	return { kind: 'pick' };
}

// ============================================================================
// Phase 5.7 V3.5.0.4b (2026-05-24) -- WorkbookSnapshot -> single-sheet
// QuantbookCellSnapshot transformer
// ============================================================================

/**
 * **FE-5 W-R (2026-06-12)** -- the mutable build-shape of a single {@link QuantbookCellSnapshot}
 * entry, used by {@link extractSheetSnapshot} as it projects engine cells. Mirrors the (readonly)
 * entry element of {@link QuantbookCellSnapshot.entries} with the W-R `styleId` field. Pulled into a
 * named alias (was three inline-repeated annotations) so the `styleId` addition lands in one place.
 */
type SnapshotEntry = {
	row: number;
	col: number;
	value: QuantbookCellValue;
	rendered?: string;
	formula?: string;
	styleId?: StyleIdJson;
};

/**
 * **FE-5 W-R hotfix (2026-06-12) -- BigInt is NOT `webview.postMessage`-serializable.** The engine widens
 * `StyleId.peer` (u64) to a JS **bigint** ({@link StyleIdJson}). vscode's `webview.postMessage` serializes
 * via JSON, and JSON cannot serialize a bigint (`TypeError: Do not know how to serialize a BigInt`) -- so
 * EVERY render carrying a styleId was REJECTED at the host->webview boundary and the grid never repainted.
 * The whole headline style feature silently did nothing in the live app; the in-process tests never crossed
 * the postMessage boundary, so they stayed green (operator smoke caught it).
 *
 * The WIRE projection downcasts `peer` to a JS **number**: lossless for any real session (peer ids are
 * tiny), and a value beyond `MAX_SAFE_INTEGER` throws LOUD (No-Fallbacks -- never silently lose precision).
 * Every webview consumer compares a styleId structurally (`peer === peer`, `resolveCellStyle`/`styleIdEqual`)
 * or via `String(peer)` (the damage digest), so the number representation is transparent to them -- BUT the
 * cell `styleId` AND `styles[].id` must be converted the SAME way (both are, below) or the `===` lookup
 * would mismatch. Follow-up (tracked): formalize a distinct `WireStyleId` type instead of the contained cast.
 */
function styleIdToWire(id: StyleIdJson): StyleIdJson {
	if (id.peer > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(
			`[invalid_state] styleId.peer ${id.peer} exceeds Number.MAX_SAFE_INTEGER; cannot project it to the ` +
			`webview without precision loss (StyleId peers are normally tiny -- this indicates engine corruption).`,
		);
	}
	// Runtime: `peer` becomes a number (postMessage-safe). Typed StyleIdJson for the consumers, which only
	// compare it structurally / stringify it -- the bigint-vs-number distinction is invisible to them.
	return { peer: Number(id.peer) as unknown as bigint, counter: id.counter };
}

/**
 * **Phase 5.7 V3.5.0.4b (2026-05-24) -- extract one sheet's
 * QuantbookCellSnapshot from a WorkbookSnapshotJson.**
 *
 * Bridges the V3.5.0.2 `WorkbookSnapshotJson` shape (multi-sheet, with
 * optional value/formula per cell) into the V3.2.a `QuantbookCellSnapshot`
 * shape (single-sheet, required-value entries) that the renderer consumes.
 *
 * **LIVE function** (drift note, FE megaudit S6 2026-06-03): this is called by
 * `cellGridPanel.ts::render()`. The CURRENT consumer of the returned snapshot is the
 * FE-0b Canvas2D renderer (pushed via postMessage), NOT the retired
 * `cellGridHtml.ts::buildHtml`/`renderRows` DOM-table layer some comments below still
 * name. The `rendered`/`formula` passthrough fields feed the canvas value display +
 * the overlay editor's formula source (the old `data-raw-*` DOM attributes are gone).
 *
 * **Sheet-not-found**: returns `null` when `sheetId` is absent from
 * `snapshot.sheets` -- happens if the active sheet was tombstoned
 * (V3.5.0.3b) via `quantlab.quantbookSheetDelete` while the panel
 * was open.  Callers should render an empty / warning view for null.
 *
 * **Formula-only cells**: V3.5.0.2 CellSnapshotJson can have
 * `value: undefined` (formula-only cells per the V3.4.0.X MEDIUM-1
 * closure -- formula text but no cached literal).  This transformer
 * SKIPS such cells, matching the V3.4.0.2 engine `export_snapshot`'s
 * `filter_map` over `state.value` -- preserves exact behavior for
 * `buildHtml` consumers.  Once V3.6+ adds formula rendering in the
 * cell-grid, this filter can be relaxed.
 *
 * **CellValueJson -> QuantbookCellValue conversion**: V3.5.0.2's
 * CellValueJson has optional payload fields (napi-rs Option::None ->
 * absent JS property); QuantbookCellValue uses a strict discriminated
 * union with the payload always present.  The transformer maps:
 * - kind='number'  -> `{ kind: 'number',  value: cell.value.number }`
 * - kind='boolean' -> `{ kind: 'boolean', value: cell.value.boolean }`
 * - kind='text'    -> `{ kind: 'text',    value: cell.value.text }`
 * - kind='error'   -> `{ kind: 'error',   value: cell.value.error }`
 * - kind='pending' -> `{ kind: 'pending' }`
 * - unknown kind   -> throw (binding-drift signal; matches the
 *                     `snapshot_format_version !== 1` throw pattern
 *                     in {@link exportCellSnapshot}).
 *
 * Pure function: no vscode + no session dependency.  Mocha-testable.
 *
 * @param snapshot full workbook snapshot from {@link workbookSnapshot}.
 *                 Already display-order-sorted + tombstone-filtered by
 *                 the napi layer (V3.5.0.3b + V3.5.0.3c).
 * @param sheetId  the sheet to extract.  Looked up by id; absent ids
 *                 (deleted/never-added/out-of-range) return null.
 * @returns the single-sheet snapshot for `buildHtml` consumption,
 *          or `null` if `sheetId` is not in `snapshot.sheets`.
 */
export function extractSheetSnapshot(
	snapshot: WorkbookSnapshotJson,
	sheetId: number,
): QuantbookCellSnapshot | null {
	// **Phase 6.3-1c M5 (2026-05-30):** the snapshot-ingest boundary -- fail loud
	// if the engine DTO's schema version drifted from this IDE build's mirrors
	// (gives `unsupported_schema_version` a producer; no-op when absent).
	assertSupportedSchemaVersion(snapshot.schemaVersion);
	const sheet: SheetSnapshotJson | undefined = snapshot.sheets.find(s => s.id === sheetId);
	if (sheet === undefined) {
		return null;
	}
	const entries: SnapshotEntry[] = [];
	for (const cell of sheet.cells) {
		if (cell.value === undefined) {
			// **Phase 5.7 V3.6.0.X audit-of-D5 OPUS-HIGH-2 closure (2026-05-24)**:
			// formula-only cell (Op::PutFormula without a coexisting
			// Op::PutValue at the same coord -- the most natural shape
			// produced by the V3.6.0.6 D5 appendPutFormula napi).  Pre-
			// closure this branch `continue`d, silently DROPPING the
			// cell from the entries array; the V3.6.0.6 D5
			// data-raw-formula attribute therefore never emitted for
			// such cells (the renderer never saw them).  Post-closure:
			// pass through with value = { kind: 'pending' } so
			// formatCellValue's existing pending case renders "(pending)"
			// AND the formula text surfaces via data-raw-formula on
			// click-to-edit (when present).  Mirrors the V3.6.0.X
			// audit-of-D4 CONVERGENT-HIGH-3 pending-render strategy
			// (engine-side pending values short-circuit pre-render so
			// the IDE fallback fires).
			//
			// **FE-5 W-R (2026-06-12) -- STYLE-ONLY blank cell.** A cell with
			// value=undefined AND formula=undefined is ALSO emitted by the engine when it
			// carries ONLY a style (a fill / border set on an otherwise-empty cell --
			// EMPIRICALLY VERIFIED: `setStyle` on an empty cell produces a snapshot cell
			// with keys {row, col, styleId}, no value/formula). Pre-W-R this branch
			// `continue`d such a cell, DROPPING it -> the fill/border on a blank cell never
			// reached the webview, so it never rendered. Post-W-R: KEEP it (emit a pending
			// entry that carries the styleId) so the engine-backed fill/border on a blank
			// cell renders. A cell with NONE of value/formula/styleId is genuinely empty and
			// is still dropped (nothing to render).
			if (cell.formula === undefined && cell.styleId === undefined) {
				continue;
			}
			const entry: SnapshotEntry = {
				row: cell.row,
				col: cell.col,
				value: { kind: 'pending' },
			};
			if (cell.formula !== undefined) {
				entry.formula = cell.formula;
			}
			if (cell.rendered !== undefined) {
				entry.rendered = cell.rendered;
			}
			if (cell.styleId !== undefined) {
				entry.styleId = styleIdToWire(cell.styleId);
			}
			entries.push(entry);
			continue;
		}
		const v = cell.value;
		let typed: QuantbookCellValue;
		switch (v.kind) {
			case 'number':
				if (typeof v.number !== 'number') {
					throw new Error(
						`[bad_argument] extractSheetSnapshot: kind='number' but number payload missing/non-numeric for cell ` +
						`(sheet=${sheetId}, row=${cell.row}, col=${cell.col}).  Engine + IDE binding may be out of sync.`,
					);
				}
				typed = { kind: 'number', value: v.number };
				break;
			case 'boolean':
				if (typeof v.boolean !== 'boolean') {
					throw new Error(
						`[bad_argument] extractSheetSnapshot: kind='boolean' but boolean payload missing for cell ` +
						`(sheet=${sheetId}, row=${cell.row}, col=${cell.col}).`,
					);
				}
				typed = { kind: 'boolean', value: v.boolean };
				break;
			case 'text':
				if (typeof v.text !== 'string') {
					throw new Error(
						`[bad_argument] extractSheetSnapshot: kind='text' but text payload missing for cell ` +
						`(sheet=${sheetId}, row=${cell.row}, col=${cell.col}).`,
					);
				}
				typed = { kind: 'text', value: v.text };
				break;
			case 'error':
				if (typeof v.error !== 'string') {
					throw new Error(
						`[bad_argument] extractSheetSnapshot: kind='error' but error payload missing for cell ` +
						`(sheet=${sheetId}, row=${cell.row}, col=${cell.col}).`,
					);
				}
				typed = { kind: 'error', value: v.error };
				break;
			case 'pending':
				typed = { kind: 'pending' };
				break;
			case 'blank':
				// Phase 6.3-1c (2026-05-30): 'blank' is a KNOWN engine CellValue
				// kind, but a workbook SNAPSHOT never carries blank cells -- the
				// engine omits empty cells (CellSnapshot.value absent). A blank
				// surfaces only via a columnar query_range read (reserved for
				// v1.5). Seeing one in a snapshot entry is anomalous, so fail loud
				// with an accurate message (No-Fallbacks: do not silently coerce a
				// blank into pending/empty).
				throw new Error(
					`[bad_argument] extractSheetSnapshot: kind='blank' is unexpected in a ` +
					`snapshot (the engine omits blank cells; blank surfaces only via ` +
					`query_range) for cell (sheet=${sheetId}, row=${cell.row}, col=${cell.col}).`,
				);
			default:
				throw new Error(
					`[bad_argument] extractSheetSnapshot: unknown CellValueJson kind ` +
					`"${(v as { kind: string }).kind}" for cell (sheet=${sheetId}, row=${cell.row}, col=${cell.col}). ` +
					`Engine + IDE binding may be out of sync -- rebuild together.`,
				);
		}
		// **Phase 5.7 V3.6.0.5 D4 (2026-05-23)**: pass through engine-
		// pre-rendered formatted string when present.  When the
		// engine omits `rendered` (no format / no value / parse
		// error / etc.), DO NOT add a `rendered: undefined` key on
		// the entry -- existing V3.5.0.4b shape-stability tests
		// assert exact key sets via deepStrictEqual.  buildHtml's
		// renderRows uses `entry.rendered ?? formatCellValue(entry.value)`
		// either way (absent property is treated the same as
		// undefined by `??`).
		//
		// **Phase 5.7 V3.6.0.6 D5 (2026-05-24)**: pass through engine-
		// repaired formula text when present (post Phase 5.3
		// repair_sheet_rename_chain).  Same conditional-key
		// discipline as `rendered` -- absent property when the
		// engine omits, set otherwise.  buildHtml emits
		// `data-raw-formula` from this field so click-to-edit
		// surfaces formula source instead of the cached literal.
		const entry: SnapshotEntry = {
			row: cell.row,
			col: cell.col,
			value: typed,
		};
		if (cell.rendered !== undefined) {
			entry.rendered = cell.rendered;
		}
		if (cell.formula !== undefined) {
			entry.formula = cell.formula;
		}
		// **FE-5 W-R (2026-06-12)**: project the cell's engine style id so the webview can
		// resolve it against the snapshot-level styles[] table (added below). Conditional-key
		// discipline (absent when the cell has no style) -- the shape-stability deepStrictEqual
		// tests assert exact key sets, so a styleId:undefined key would break them.
		if (cell.styleId !== undefined) {
			entry.styleId = styleIdToWire(cell.styleId);
		}
		entries.push(entry);
	}
	const result: {
		snapshot_format_version: 1;
		sheet: number;
		entries: SnapshotEntry[];
		styles?: StyleDefJson[];
		tables?: TableSnapshotJson[];
	} = {
		snapshot_format_version: 1,
		sheet: sheetId,
		entries,
	};
	// **FE-5 W-R (2026-06-12) -- ATOMICITY:** carry the workbook-level styles[] table on the
	// SAME projection as the per-cell styleIds above, so a styleId always resolves against a
	// table from the same engine snapshot (never a stale one). Conditional key (absent when the
	// source snapshot has no styles -- the common pre-style-edit case) keeps the shape-stability
	// tests' exact-key-set assertions intact. The webview reads `snapshot.styles` defensively and
	// treats absent as "no engine styles" (correct semantics, not a fallback).
	//
	// **FE-5 W-R hotfix (2026-06-12):** project styles[] with each `id.peer` downcast bigint->number (see
	// `styleIdToWire` -- BigInt is NOT `webview.postMessage`-serializable; an un-converted styleId rejected
	// the whole render). The `.map` builds a FRESH array, which ALSO resolves the former CLOSURE-D4 aliasing
	// hazard: the projection no longer references `cached.styles`, so a later in-place `mergeWorkbookDelta`
	// mutation cannot change it out from under a retained projection. The per-cell styleIds above are
	// converted the SAME way, so a cell's id still `===`-matches its styles[] entry on the webview side.
	if (snapshot.styles !== undefined && snapshot.styles.length > 0) {
		result.styles = snapshot.styles.map(d => ({ id: styleIdToWire(d.id), style: d.style }));
	}
	// **Tables wave (2026-06-13)**: project the workbook-level tables FILTERED to this sheet onto the render
	// snapshot, so the webview paints each table's header band + banding + outer border. Filtered by
	// `t.sheet === sheetId` -- a table belongs to exactly one sheet; painting another sheet's tables here
	// would bleed bands onto the wrong grid. The engine `TableSnapshotJson` carries `sheet` for this. If the
	// engine omits it, `t.sheet` is `undefined`, the filter matches nothing, and NO tables paint on this
	// sheet -- a SAFE no-paint (never a wrong-sheet bleed), surfaced LOUD here (No-Fallbacks) so the gap is
	// visible rather than silently mis-rendering. Fresh `.map` (decoupled from the cached snapshot, mirroring
	// the styles projection's aliasing fix). Conditional key (absent when this sheet has no tables) keeps the
	// shape-stability deepStrictEqual key-set tests intact.
	if (Array.isArray(snapshot.tables) && snapshot.tables.length > 0) {
		const onSheet: TableSnapshotJson[] = [];
		let sawTableMissingSheet = false;
		for (const t of snapshot.tables) {
			if (typeof t.sheet !== 'number') {
				sawTableMissingSheet = true;
				continue; // cannot attribute it to a sheet -> drop it (safe no-paint), flagged below
			}
			if (t.sheet === sheetId) {
				onSheet.push({
					name: t.name,
					displayName: t.displayName,
					sheet: t.sheet,
					topRow: t.topRow,
					topCol: t.topCol,
					rows: t.rows,
					cols: t.cols,
					hasHeader: t.hasHeader,
					hasTotals: t.hasTotals,
				});
			}
		}
		if (sawTableMissingSheet) {
			// No-Fallbacks: a table whose `sheet` the engine did not stamp cannot be placed; make the
			// engine/IDE contract gap VISIBLE rather than guessing the sheet.
			console.warn(
				`[cellGrid] extractSheetSnapshot: a TableSpec is missing its 'sheet' field; it cannot be ` +
				`attributed to a sheet and was NOT painted. The engine must stamp TableSpec.sheet (schema v3 ` +
				`contract). sheetId=${sheetId}.`,
			);
		}
		if (onSheet.length > 0) {
			result.tables = onSheet;
		}
	}
	return result;
}

// ---------------------------------------------------------------------
// Phase 6.4-3d Step 5 (2026-05-29) -- CellDiagnostic -> cell tooltip.
//
// `Event::CellDiagnostic` (the UDF no-worker/raised/timeout/died sink) arrives
// via `SessionInstance.pollEvents`, NOT in the value snapshot. These two pure
// helpers bridge the gap: fold the event page into a per-cell message map, then
// merge it onto a `QuantbookCellSnapshot` so `renderRows` can show a `title=`
// tooltip explaining WHY a cell is `#CALC!`/`#TIMEOUT!`.
// ---------------------------------------------------------------------

/** Map key for a cell within a sheet. */
function diagKey(row: number, col: number): string {
	return `${row},${col}`;
}

/**
 * **Phase 6.4-3d Step 5**: fold the `cell_diagnostic` events of `events` for
 * `sheetId` into a `Map` keyed by `"row,col"` whose value is the diagnostic
 * MESSAGE. Last-wins (a later diagnostic for the same cell supersedes an earlier
 * one, e.g. a re-eval that fails differently). Events for other sheets, events
 * without a `cell_diagnostic` kind, and workbook-level diagnostics (no `addr`)
 * are ignored. Pure -- no I/O.
 *
 * Note: the engine ring is append-only with no "diagnostic cleared" event; a
 * cell that later recomputes to a real value keeps a stale entry HERE, but
 * {@link attachCellDiagnostics} only surfaces a message on a cell whose CURRENT
 * value is an error, so a recovered cell naturally drops its tooltip.
 */
export function buildCellDiagnosticMessages(
	events: readonly EventJson[],
	sheetId: number,
): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of events) {
		if (e.kind !== 'cell_diagnostic') {
			continue;
		}
		const d = e.diagnostic;
		if (d === undefined || d.addr === undefined || d.addr.sheet !== sheetId) {
			continue;
		}
		out.set(diagKey(d.addr.row, d.addr.col), d.message);
	}
	return out;
}

/**
 * **Phase 6.4-3d Step 5**: return a COPY of `snapshot` whose `diagnostic` fields
 * reflect EXACTLY the current `messages` on current ERROR-valued cells:
 * - an error cell with a current message gets `diagnostic = message`;
 * - every other cell has NO `diagnostic` -- any stale one carried on the input
 *   is STRIPPED.
 *
 * The strip makes the function IDEMPOTENT and reattachment-safe (6.4-3d Step 5
 * audit-fix, Codex/Opus): a cell that recovered to a real value, or whose
 * message changed, can never keep a stale tooltip even if the caller passes a
 * previously-attached snapshot. (In the intended flow the input is always a
 * fresh `extractSheetSnapshot` with no diagnostics, so the strip is defensive.)
 * Pure -- does not mutate the input. Fast-path: returns the input unchanged when
 * there is nothing to attach AND nothing to strip.
 */
export function attachCellDiagnostics(
	snapshot: QuantbookCellSnapshot,
	messages: Map<string, string>,
): QuantbookCellSnapshot {
	const hasStale = snapshot.entries.some(e => e.diagnostic !== undefined);
	if (messages.size === 0 && !hasStale) {
		return snapshot;
	}
	const entries = snapshot.entries.map(entry => {
		const msg = entry.value.kind === 'error'
			? messages.get(diagKey(entry.row, entry.col))
			: undefined;
		// Rebuild without any pre-existing `diagnostic`, re-adding the optional
		// keys per the conditional-key discipline + only the CURRENT message.
		const rebuilt: {
			row: number;
			col: number;
			value: QuantbookCellValue;
			rendered?: string;
			formula?: string;
			diagnostic?: string;
			styleId?: StyleIdJson;
		} = { row: entry.row, col: entry.col, value: entry.value };
		if (entry.rendered !== undefined) {
			rebuilt.rendered = entry.rendered;
		}
		if (entry.formula !== undefined) {
			rebuilt.formula = entry.formula;
		}
		if (msg !== undefined) {
			rebuilt.diagnostic = msg;
		}
		// **FE-5 W-R (2026-06-12)**: carry the engine styleId FORWARD. `render()` runs every
		// snapshot through this BEFORE postMessage, so without re-adding styleId here the
		// diagnostic-decoration step would STRIP it from every cell -> styles would never reach
		// the webview (a silent style-render-miss). Conditional key (absent when unstyled) keeps
		// the shape-stability deepStrictEqual tests' exact-key-set assertions intact.
		if (entry.styleId !== undefined) {
			rebuilt.styleId = entry.styleId;
		}
		return rebuilt;
	});
	return { ...snapshot, entries };
}

// ---------------------------------------------------------------------
// Phase 5.7 V3.6.1 (2026-05-26) -- incremental snapshot delta merge
// (OPUS-PT-B10).  Realizes the V3.6.0.8 D6 engine win (228x faster than
// a full snapshot at 100 new cells) by letting CellGridPanel acquire its
// snapshot via the two-call delta protocol instead of a full O(N)
// workbookSnapshot() on every repaint.  The orchestration (full-fetch vs
// delta, version-token threading, fullRebuildRequired re-fetch) lives in
// CellGridPanel.acquireWorkbookSnapshot; the PURE merge below is split
// out here so its invariants are mocha-testable with hand-built fixtures.
// ---------------------------------------------------------------------

/**
 * Stable key for a {@link FormatIdJson}, covering BOTH discriminants.
 *
 * Custom ids carry a `customPeer` bigint -- merging by `kind` alone (or
 * even `kind`+`builtin`) would collide all customs.  The full key is
 * `kind:builtin:customPeer:customCounter` (absent fields collapse to "").
 */
function formatIdKey(id: FormatIdJson): string {
	return `${id.kind}:${id.builtin ?? ''}:${id.customPeer?.toString() ?? ''}:${id.customCounter ?? ''}`;
}

/**
 * **FE-5 W-R (2026-06-12)** -- stable key for a {@link StyleIdJson} (`{peer, counter}`),
 * the visual-style analog of {@link formatIdKey}. Styles have no builtin variant -- every id
 * is peer-allocated -- so the key is `peer:counter` (peer is a bigint widened from engine u64).
 */
function styleIdKey(id: StyleIdJson): string {
	return `${id.peer.toString()}:${id.counter}`;
}

/**
 * Insert `cell` into `cells` (sorted (row, col) ascending per the engine
 * `snapshot_cells` contract) at its sorted position, OR replace the
 * existing entry at the same (row, col).  Keeping the array sorted is
 * what makes a delta-merged snapshot structurally identical to a fresh
 * `workbookSnapshot()` -- see the shape-equivalence invariant on
 * {@link mergeWorkbookDelta}.  Binary search: O(log n) locate + O(n)
 * splice.
 */
function upsertCellSorted(cells: CellSnapshotJson[], cell: CellSnapshotJson): void {
	let lo = 0;
	let hi = cells.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const probe = cells[mid];
		const cmp = probe.row !== cell.row ? probe.row - cell.row : probe.col - cell.col;
		if (cmp === 0) {
			cells[mid] = cell; // replace existing cell at (row, col)
			return;
		}
		if (cmp < 0) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	cells.splice(lo, 0, cell); // insert in sorted position
}

/**
 * **Phase 5.7 V3.6.1 (2026-05-26) -- merge a `workbookSnapshotDelta`
 * reply into an accumulated {@link WorkbookSnapshotJson} (OPUS-PT-B10).**
 *
 * Pure (no vscode, no engine calls) so the merge invariants are
 * mocha-testable with hand-built fixtures.  The caller
 * (`CellGridPanel.acquireWorkbookSnapshot`) decides full-fetch-vs-delta,
 * caches the result, and threads the version token.
 *
 * **Precondition**: the caller MUST have checked
 * `delta.fullRebuildRequired === false`.  On a fullRebuild the caller
 * re-fetches via `workbookSnapshot()` and never calls this.
 *
 * **Shape-equivalence invariant**: the merged snapshot is structurally
 * identical to a fresh `workbookSnapshot()` at the delta's version --
 * cells stay sorted (row, col) ascending (so changed/new cells are
 * inserted in sorted position, not appended), and `version` is advanced
 * to `delta.version` (which encodes the same current VV a fresh
 * `workbookSnapshot()` would capture).  The
 * `quantbook V3.6.1 -- delta-merge shape equivalence` mocha suite pins
 * `deepStrictEqual(merged, fresh)` across IDE-reachable op sequences
 * (puts / deleteSheet / renameSheet / undo).
 *
 * **Delta surface handled** (see {@link WorkbookSnapshotDeltaJson}):
 * - `changedCells`: upsert by (sheet, row, col).
 * - `sheetsRemoved`: drop the sheet entry.  **LIVE path today** --
 *   `deleteSheet` (`Op::RemoveSheet`) arrives as a delta, not a
 *   fullRebuild (`classify_delta_op` treats it as cell-compatible).
 * - `formatsAdded`: merge into `formats` by the FULL FormatId.  Appended
 *   (not sorted-inserted): the engine emits only CUSTOM ids here, and no
 *   IDE API can emit `Op::RegisterFormat` today (appendRegisterFormat is
 *   V3.7+), so this path is exercised only by the pure-helper fixture
 *   test, never by the real-session shape-equivalence test.  If V3.7+
 *   adds an IDE register-format write-path, switch this to a sorted
 *   insert matching the engine's FormatId `Ord`.
 * - `removedCells`: drop the cell.  **Forward-compat only** -- the engine
 *   emits `[]` at this version (true cell removals trip
 *   `fullRebuildRequired` instead).  Implemented + fixture-tested so a
 *   future engine that starts emitting removedCells cannot silently
 *   diverge the cache.
 * - `sheetsChanged`: replace/insert the sheet entry by id.
 *   **Forward-compat only** -- always `[]` in the cell-only path
 *   (sheet-metadata changes trip `fullRebuildRequired`).
 *
 * Mutates + returns `cached` in place.  The napi reply is a fresh JS
 * object graph each call (no aliasing with engine memory), so in-place
 * mutation is safe and avoids a deep clone.
 */
export function mergeWorkbookDelta(
	cached: WorkbookSnapshotJson,
	delta: WorkbookSnapshotDeltaJson,
): WorkbookSnapshotJson {
	// sheetsChanged (forward-compat; engine emits [] today): replace the
	// sheet entry by id, or append.
	for (const sheet of delta.sheetsChanged) {
		const idx = cached.sheets.findIndex(s => s.id === sheet.id);
		if (idx >= 0) {
			cached.sheets[idx] = sheet;
		} else {
			cached.sheets.push(sheet);
		}
	}

	// changedCells: upsert by (sheet, row, col) in sorted position.
	for (const changed of delta.changedCells) {
		const sheet = cached.sheets.find(s => s.id === changed.sheet);
		// **FE megaudit M3 (2026-06-03)**: a changedCell for a sheet absent from the
		// cache must NOT be skipped-then-version-advanced. AddSheet trips
		// fullRebuildRequired, so on the current engine any sheet a delta references
		// is already in the cache; an unknown sheet here is an engine-contract
		// violation/drift. The prior `continue` DROPPED the cell yet still let
		// `cached.version` advance below -- the next delta would start AFTER the lost
		// update, so the cache could stay PERMANENTLY divergent from a fresh
		// snapshot() with no signal. Fail loud (No-Fallbacks) so the producerless
		// divergence becomes a recognized `[invalid_state]` the caller can re-seed on,
		// rather than a silent corruption.
		if (sheet === undefined) {
			throw new Error(
				`[invalid_state] mergeWorkbookDelta: changedCell references unknown sheet ${changed.sheet} ` +
				`(not in the cached snapshot). AddSheet trips fullRebuildRequired, so a delta should never ` +
				`reference an uncached sheet -- the engine + IDE binding may be out of sync; full-resync required.`,
			);
		}
		upsertCellSorted(sheet.cells, changed.cell);
	}

	// removedCells (forward-compat; engine emits [] today): drop the cell.
	for (const removed of delta.removedCells) {
		const sheet = cached.sheets.find(s => s.id === removed.sheet);
		// **FE megaudit M3 (2026-06-03)**: same as changedCells -- an unknown sheet on
		// a removedCell is contract drift, not a benign skip. Throw rather than
		// skip-then-advance-version (silent permanent divergence).
		if (sheet === undefined) {
			throw new Error(
				`[invalid_state] mergeWorkbookDelta: removedCell references unknown sheet ${removed.sheet} ` +
				`(not in the cached snapshot). The engine + IDE binding may be out of sync; full-resync required.`,
			);
		}
		const idx = sheet.cells.findIndex(c => c.row === removed.row && c.col === removed.col);
		if (idx >= 0) {
			sheet.cells.splice(idx, 1);
		}
	}

	// formatsAdded: merge by FULL FormatId (replace-or-append).
	for (const fmt of delta.formatsAdded) {
		const key = formatIdKey(fmt.id);
		const idx = cached.formats.findIndex(f => formatIdKey(f.id) === key);
		if (idx >= 0) {
			cached.formats[idx] = fmt;
		} else {
			cached.formats.push(fmt);
		}
	}

	// **FE-5 W-R (2026-06-12) -- stylesAdded: merge the newly-registered styles into the cached
	// styles[] table by FULL StyleId (replace-or-append, the visual-style analog of formatsAdded).**
	// EMPIRICALLY VERIFIED (2026-06-12): a `registerStyle`/`setStyle` arrives as a REAL delta
	// (fullRebuildRequired:false) -- the new style in `stylesAdded`, the cell's new styleId in
	// `changedCells`. Without this merge the cached styles[] stays empty while cells carry styleIds
	// pointing at it -> the webview resolver fails LOUD ('unresolved') and every styled cell renders
	// unstyled after the FIRST incremental style edit (the common case). So this is a real
	// correctness fix, not forward-compat. Sorted by StyleId (peer asc, counter asc -- the engine's
	// derived Ord) AFTER merging so the cached table stays structurally identical to a fresh
	// `workbookSnapshot()` (the mergeWorkbookDelta shape-equivalence invariant). The mirror field is
	// declared OPTIONAL, so seed it to [] on first style if the seed snapshot had none.
	//
	// **CLOSURE D4 (2026-06-12)**: this mutates `cached.styles` IN PLACE (push/replace then sort). The array
	// `extractSheetSnapshot` aliases BY-REFERENCE into a projection is THIS same array, so a projection built
	// from this cached snapshot will observe these edits if it is retained past this merge. Safe today
	// (projections are consumed + structured-cloned synchronously before the next merge runs); see the
	// matching note at `extractSheetSnapshot`'s `result.styles = snapshot.styles` assignment.
	const stylesAdded = delta.stylesAdded ?? [];
	if (stylesAdded.length > 0) {
		const styles: StyleDefJson[] = cached.styles ?? [];
		for (const def of stylesAdded) {
			const key = styleIdKey(def.id);
			const idx = styles.findIndex(s => styleIdKey(s.id) === key);
			if (idx >= 0) {
				styles[idx] = def;
			} else {
				styles.push(def);
			}
		}
		styles.sort((a, b) => {
			if (a.id.peer !== b.id.peer) {
				return a.id.peer < b.id.peer ? -1 : 1;
			}
			return a.id.counter - b.id.counter;
		});
		cached.styles = styles;
	}

	// sheetsRemoved: drop sheet entries.  Applied LAST so a changedCell in
	// the same delta window cannot resurrect a removed sheet (the engine
	// already pre-filters changedCells for removed sheets; this is
	// defense-in-depth).
	if (delta.sheetsRemoved.length > 0) {
		const removedSet = new Set(delta.sheetsRemoved);
		cached.sheets = cached.sheets.filter(s => !removedSet.has(s.id));
	}

	// Advance the snapshot's version to the delta's: the merged snapshot
	// now represents the state at `delta.version` (the current VV), so a
	// fresh workbookSnapshot() at this point would carry the same token.
	cached.version = delta.version;

	return cached;
}

/**
 * **Phase 5.7 V3.6.1 (2026-05-26)** -- mutable client-side delta cache
 * for one snapshot consumer (one {@link CellGridPanel}).
 *
 * Held by the consumer across repaints + threaded into
 * {@link acquireWorkbookSnapshotViaDelta}.  `snapshot`/`version` are
 * both `undefined` before the first acquisition (forces a full seed);
 * `version === undefined` ALWAYS forces the full-fetch branch (never
 * thread an absent token into the delta wrapper).
 */
export interface DeltaSnapshotCache {
	snapshot: WorkbookSnapshotJson | undefined;
	version: Buffer | undefined;
}

/**
 * **Phase 5.7 V3.6.1 (2026-05-26) -- acquire a workbook snapshot via the
 * incremental delta protocol, mutating `cache` (OPUS-PT-B10).**
 *
 * Pure (no vscode) so the two-call protocol is mocha-testable with a
 * real session but no panel.  {@link CellGridPanel.acquireWorkbookSnapshot}
 * delegates here with its per-panel {@link DeltaSnapshotCache}.
 *
 * Protocol (see {@link workbookSnapshotDelta} + the panel docstring for
 * where the win lands + the multi-consumer caveat):
 * 1. No cached version -> full `workbookSnapshot()` (seed); capture
 *    `version` (left undefined if the reply lacks one, so the next call
 *    re-seeds rather than threading undefined into the delta wrapper).
 * 2. Else -> `workbookSnapshotDelta(version)`.  `fullRebuildRequired`
 *    (an explicit designed signal, NOT a swallowed error) -> full
 *    `workbookSnapshot()` re-fetch.  Otherwise -> {@link mergeWorkbookDelta}.
 *
 * Returns the snapshot to render (always a structurally-complete
 * {@link WorkbookSnapshotJson}, identical in shape to a full fetch).
 */
export function acquireWorkbookSnapshotViaDelta(
	session: SessionInstance,
	cache: DeltaSnapshotCache,
): WorkbookSnapshotJson {
	const cachedSnapshot = cache.snapshot;
	const cachedVersion = cache.version;
	if (cachedVersion === undefined || cachedSnapshot === undefined) {
		const seed = session.snapshot();
		cache.snapshot = seed;
		cache.version = seed.version;
		return seed;
	}
	const delta = session.snapshotDelta(cachedVersion);
	// **Phase 6.3-1c closure-audit (Opus MED-1):** assert the delta DTO's schema
	// version at the delta ingest too -- not just the full-snapshot path. Without
	// this a drifted DELTA would surface as a downstream mergeWorkbookDelta shape
	// mismatch rather than a clean fail-loud unsupported_schema_version.
	assertSupportedSchemaVersion(delta.schemaVersion);
	if (delta.fullRebuildRequired) {
		const full = session.snapshot();
		cache.snapshot = full;
		cache.version = full.version;
		return full;
	}
	const merged = mergeWorkbookDelta(cachedSnapshot, delta);
	cache.snapshot = merged;
	cache.version = delta.version;
	return merged;
}

/**
 * **Phase 5.7 V3.6.1 (2026-05-26) -- per-session shared delta cache
 * registry (OPUS-PT-B10 multi-panel completion).**
 *
 * One {@link DeltaSnapshotCache} per `CollabSession`, shared across every
 * `CellGridPanel` bound to that session.  The engine's snapshot cache is
 * itself per-session (one `last_snapshot_*` triple on the napi
 * `CollabSession`, advanced by every `workbookSnapshotDelta` call), so a
 * PER-PANEL client cache mismatches the engine model: after any change
 * only the first panel to poll hits the same-VV fast path and siblings
 * observe staleness -> full rebuild.  Sharing ONE client cache per session
 * mirrors the engine model so all panels ride the delta fast path.
 *
 * Safe as shared mutable state: VS Code extension-host JS is
 * single-threaded, and `CellGridPanel.render()` reads the returned
 * snapshot synchronously (never retains it across renders), so panel
 * renders that share a cache are strictly sequential -- no races.  The
 * `WeakMap` auto-GCs the cache when the session is collected; no explicit
 * teardown.  A panel created later piggybacks on the already-seeded shared
 * snapshot (skips its own full seed).
 */
const SESSION_DELTA_CACHES = new WeakMap<SessionInstance, DeltaSnapshotCache>();

/**
 * Get (or lazily create) the shared {@link DeltaSnapshotCache} for
 * `session`.  See {@link SESSION_DELTA_CACHES}.
 */
export function getSharedDeltaCache(session: SessionInstance): DeltaSnapshotCache {
	let cache = SESSION_DELTA_CACHES.get(session);
	if (cache === undefined) {
		cache = { snapshot: undefined, version: undefined };
		SESSION_DELTA_CACHES.set(session, cache);
	}
	return cache;
}

// ============================================================================
// Demo-prep toolbar (2026-06-10) -- the webview toolbar's command bridge.
//
// The sheets webview gains a toolbar whose buttons post
// `{type:'toolbarCommand', command, preset?}` to the host. The panel intercepts
// it in `handleIncoming` (alongside switchSheet/sheetCommand) and routes each
// VALIDATED command to an existing host command (freeze/unfreeze, the six W3
// structural insert/delete commands, Save As / Open) or applies a number-format
// preset directly to the panel's selection.
//
// SECURITY: the webview is UNTRUSTED input. NOTHING outside the explicit
// whitelists below may reach `vscode.commands.executeCommand` -- the parser is
// the single chokepoint, pure + unit-tested (mirrors parseContextMenuArg). An
// unknown command / malformed preset returns `undefined` and the panel surfaces
// it LOUD (a warning toast + a console line, No-Fallbacks), never executes it.
// ============================================================================

/**
 * The toolbar commands that map 1:1 to an ARGUMENT-LESS host command (freeze
 * panes act on the focused panel; Save As / Open resolve their own target).
 * `showDepGraph`/`showLivePython` (menu breadth, 2026-06-10) reveal the wave-3
 * sidebars from the webview's Data menu -- see the id-map note below.
 */
export type ToolbarSimpleCommand =
	| 'freezePanes'
	| 'unfreezePanes'
	| 'saveAs'
	| 'openWorkbook'
	| 'showDepGraph'
	| 'showLivePython';

/**
 * The number-format presets the toolbar may apply: every {@link FormatPreset}
 * EXCEPT `Custom` (which needs a free-text input box -- the QuickPick command
 * path owns that; the toolbar rejects it like any unknown preset).
 */
export type ToolbarFormatPreset = Exclude<FormatPreset, 'Custom'>;

/**
 * A validated toolbar command, discriminated by how the panel executes it:
 * - `simple`: fire `commandId` with NO argument.
 * - `structural`: fire `commandId` with the W3 context-menu argument
 *   (`{panelToken, selection}`) built from the panel's token + latest selection.
 * - `setNumberFormat`: apply the preset directly to the panel's session/sheet
 *   over its latest selection (no QuickPick).
 */
export type ParsedToolbarCommand =
	| { kind: 'simple'; command: ToolbarSimpleCommand; commandId: string }
	| { kind: 'structural'; command: StructuralOp; commandId: string }
	| { kind: 'setNumberFormat'; preset: ToolbarFormatPreset };

/**
 * Whitelist: toolbar command -> argument-less host command id. A `Record` over
 * the union so adding a member without a mapping is a compile error (never a
 * silent drop). Wrapped in {@link hasOwnKey} lookups at parse time so an
 * untrusted string like `"constructor"` can never resolve via the prototype
 * chain.
 */
const TOOLBAR_SIMPLE_COMMAND_IDS: Record<ToolbarSimpleCommand, string> = {
	freezePanes: 'quantlab.quantbookFreezePanes',
	unfreezePanes: 'quantlab.quantbookUnfreezePanes',
	saveAs: 'quantlab.quantbookSaveAs',
	openWorkbook: 'quantlab.quantbookOpen',
	// Menu breadth (2026-06-10): the webview Data menu's sidebar-reveal entries. The wave-3
	// Dependencies + Live Python features are contributed as VIEWS (package.json contributes.views,
	// `quantlab.depGraphView` / `quantlab.livePythonView`, gated `quantbook.hasOpenGrid`), NOT as
	// commands -- so the ids here are the `<viewId>.focus` commands VS Code itself auto-registers for
	// every contributed view (the standard programmatic reveal; there is no quantlab.quantbook*
	// command for either). The views' `when` gate is true whenever this bridge can receive a message
	// (a grid panel exists -- quantbookShell drives the key off CellGridPanel.hasAnyPanel()); if the
	// command nonetheless fails, the panel's execute() rejection handler surfaces it as a LOUD toast
	// (No-Fallbacks), never a silent dead menu item.
	showDepGraph: 'quantlab.depGraphView.focus',
	showLivePython: 'quantlab.livePythonView.focus',
};

/**
 * Whitelist: toolbar structural command -> the W3 context-menu host command id
 * (each takes the `{panelToken, selection}` argument `parseContextMenuArg`
 * validates). Pinned to {@link StructuralOp} so the toolbar and the context
 * menu can never drift apart silently.
 */
const TOOLBAR_STRUCTURAL_COMMAND_IDS: Record<StructuralOp, string> = {
	insertRowAbove: 'quantlab.quantbookInsertRowAbove',
	insertRowBelow: 'quantlab.quantbookInsertRowBelow',
	insertColumnLeft: 'quantlab.quantbookInsertColumnLeft',
	insertColumnRight: 'quantlab.quantbookInsertColumnRight',
	deleteRow: 'quantlab.quantbookDeleteRow',
	deleteColumn: 'quantlab.quantbookDeleteColumn',
};

/**
 * Whitelist of the format presets the toolbar may send. A `Record` (not an
 * array) so a future {@link FormatPreset} member forces an explicit
 * include/exclude decision here at compile time. `Custom` is structurally
 * excluded by {@link ToolbarFormatPreset}.
 */
const TOOLBAR_FORMAT_PRESETS: Record<ToolbarFormatPreset, true> = {
	General: true,
	Number: true,
	NumberThousands: true,
	Currency: true,
	Percent: true,
	Date: true,
};

/** Own-property membership test that narrows `key` to the record's key type (prototype-chain-safe). */
function hasOwnKey<K extends string>(record: Record<K, unknown>, key: string): key is K {
	return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Validate a raw webview `toolbarCommand` message into a {@link ParsedToolbarCommand},
 * or `undefined` if anything about it is off-whitelist (No-Fallbacks: the panel
 * surfaces the rejection loud; it NEVER guesses a command). Exhaustive rules:
 * - must be an object with `type === 'toolbarCommand'` and a string `command`;
 * - `setNumberFormat` additionally requires a string `preset` in
 *   {@link TOOLBAR_FORMAT_PRESETS} (so `Custom`, unknown strings, and a missing
 *   preset are all rejected);
 * - every other `command` must be a key of one of the two command-id whitelists.
 * Extraneous fields are TOLERATED (ignored) -- consistent with the other webview
 * envelopes (which carry e.g. `webviewId` the dispatcher ignores); the security
 * boundary is the whitelisted `command`/`preset` values, not field absence.
 * Pure; no vscode.
 */
export function parseToolbarCommandMessage(raw: unknown): ParsedToolbarCommand | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const m = raw as { type?: unknown; command?: unknown; preset?: unknown };
	if (m.type !== 'toolbarCommand' || typeof m.command !== 'string') {
		return undefined;
	}
	if (m.command === 'setNumberFormat') {
		if (typeof m.preset !== 'string' || !hasOwnKey(TOOLBAR_FORMAT_PRESETS, m.preset)) {
			return undefined;
		}
		return { kind: 'setNumberFormat', preset: m.preset };
	}
	if (hasOwnKey(TOOLBAR_SIMPLE_COMMAND_IDS, m.command)) {
		return { kind: 'simple', command: m.command, commandId: TOOLBAR_SIMPLE_COMMAND_IDS[m.command] };
	}
	if (hasOwnKey(TOOLBAR_STRUCTURAL_COMMAND_IDS, m.command)) {
		return { kind: 'structural', command: m.command, commandId: TOOLBAR_STRUCTURAL_COMMAND_IDS[m.command] };
	}
	return undefined;
}
