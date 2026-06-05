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

import type { CellSnapshotJson, CollabSessionInstance, EventJson, FormatIdJson, QuantbookCellSnapshot, QuantbookCellValue, QuantbookErrorCode, SessionCellValueInput, SessionInstance, SheetSnapshotJson, WorkbookSnapshotDeltaJson, WorkbookSnapshotJson } from '../types';
import { assertSupportedSchemaVersion, parseQuantbookError, recalcDirtyChecked, setFormulaValidated, setValueValidated } from '../session';

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
}

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
	 * this edit. Optional for backward compat with tests + pre-token envelopes.
	 */
	readonly onAck?: (commitId: number) => void;
	/**
	 * **FE-2-0 Phase 2 (S2-MED1, 2026-06-04)** -- a SESSION-WIDE operation failure
	 * (undo/redo throw) that is NOT tied to a cell. Previously routed through
	 * {@link onError} with `row=0,col=0` sentinels, which mis-decorated cell A1 as
	 * errored. The panel now surfaces this as a plain warning toast (no cell tint, no
	 * commitId). Optional for backward compat; when omitted the failure is dropped
	 * (tests that don't wire it don't exercise the undo/redo-throw path).
	 */
	readonly onOperationError?: (message: string) => void;
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
		// FE-2-0 Phase 2 (commit-token): ack THIS commit to the originating panel (in addition to the
		// session-wide render `onCommit` triggers), so its webview resolves exactly this edit. Only when
		// the envelope carried a commitId (the live webview always stamps one; pre-token/tests may not).
		if (typeof req.commitId === 'number') {
			deps.onAck?.(req.commitId);
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
	const entries: { row: number; col: number; value: QuantbookCellValue; rendered?: string; formula?: string }[] = [];
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
			// Cells with value=undefined AND formula=undefined would be
			// fully-empty CellState entries; V3.4.0.X MEDIUM-1 closure
			// removes those at the engine layer (extended V3.5.0.5 to
			// format), so this branch only fires when formula is set.
			if (cell.formula === undefined) {
				continue;
			}
			const entry: { row: number; col: number; value: QuantbookCellValue; rendered?: string; formula?: string } = {
				row: cell.row,
				col: cell.col,
				value: { kind: 'pending' },
				formula: cell.formula,
			};
			if (cell.rendered !== undefined) {
				entry.rendered = cell.rendered;
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
		const entry: { row: number; col: number; value: QuantbookCellValue; rendered?: string; formula?: string } = {
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
		entries.push(entry);
	}
	return {
		snapshot_format_version: 1,
		sheet: sheetId,
		entries,
	};
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
