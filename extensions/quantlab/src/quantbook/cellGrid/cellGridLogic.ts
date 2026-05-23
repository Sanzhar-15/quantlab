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

import type { CollabSessionInstance, QuantbookCellSnapshot, QuantbookCellValue, QuantbookErrorCode, SheetSnapshotJson, WorkbookSnapshotJson } from '../types';
import { appendPutValueValidated, parseQuantbookError } from '../session';

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
 * Wiring contract for {@link dispatchIncomingMessage}.  The real panel
 * passes `(session, sheet, () => this.render(), reply => panel.webview.
 * postMessage(reply))`; the test passes spies.
 */
export interface DispatchDeps {
	readonly session: CollabSessionInstance;
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
	// needed.  On engine throw route through deps.onError with
	// structured code; sheet=deps.sheet/row=0/col=0 sentinels because
	// undo/redo is session-wide and the errorReply schema requires
	// cell coordinates (V3.2.b.1 B1 envelope contract).  Message
	// prefixed with [undo]/[redo] so the user sees which action
	// failed.
	if (msg.type === 'undo' || msg.type === 'redo') {
		try {
			const consumed = msg.type === 'undo' ? deps.session.undo() : deps.session.redo();
			if (consumed) {
				deps.onCommit();
			}
			// consumed === false: silent no-op (empty stack).
			return;
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onError({
				type: 'errorReply',
				sheet: deps.sheet,
				row: 0,
				col: 0,
				code: info.code,
				message: `[${msg.type}] ${info.message}`,
			});
			return;
		}
	}
	// V3.4.0.5b (2026-05-23): presenceUpdate envelope.  Webview posts on
	// every beginEdit/endEdit; payload carries the full PresenceStateJson
	// (sheet, row, col, selectionEnd*, typing).  Route to
	// session.updatePresence (auto-flush per policy if attached).
	//
	// **No onCommit on success**: presence updates don't affect the cell
	// snapshot, so re-rendering the panel on every cursor move would
	// thrash.  Remote peers see this peer's presence on their next
	// pollRemote tick + V3.2.c-integrated render (cache invalidation
	// fires render via the dispatcher's existing onCommit path for the
	// REMOTE side's cell ops, not this side's presence write).
	//
	// **Defensive runtime validation** (V3.2.d HIGH-2 + V3.4.0.3
	// pattern): trust the webview script's payload but check the shape
	// before calling the engine.  Missing/malformed state -> bad_argument
	// errorReply.
	if (msg.type === 'presenceUpdate') {
		const presenceReq = raw as { type: 'presenceUpdate'; state?: unknown };
		const state = presenceReq.state;
		// V3.4.0.X MEDIUM-3 closure (2026-05-24, single-lane Codex):
		// runtime type-shape check (was here pre-closure) + numeric-range
		// validation (added in this closure).  V3.4.0.5b shipped with
		// typeof-only checks, which let NaN/Infinity/negative/fractional/
		// out-of-u16-or-u32-range values through to napi's ToUint32
		// coercion path.  This is the same boundary class V3.2.d closed
		// for cell writes (HIGH-2); extending it here for symmetry.
		if (
			typeof state !== 'object'
			|| state === null
			|| typeof (state as { sheet?: unknown }).sheet !== 'number'
			|| typeof (state as { row?: unknown }).row !== 'number'
			|| typeof (state as { col?: unknown }).col !== 'number'
			|| typeof (state as { selectionEndRow?: unknown }).selectionEndRow !== 'number'
			|| typeof (state as { selectionEndCol?: unknown }).selectionEndCol !== 'number'
			|| typeof (state as { typing?: unknown }).typing !== 'boolean'
		) {
			deps.onError({
				type: 'errorReply',
				sheet: deps.sheet,
				row: 0,
				col: 0,
				code: 'bad_argument',
				message: '[presenceUpdate] state must be a PresenceStateJson object with all 6 fields',
			});
			return;
		}
		const s = state as {
			sheet: number;
			row: number;
			col: number;
			selectionEndRow: number;
			selectionEndCol: number;
			typing: boolean;
		};
		// V3.4.0.X MEDIUM-3 numeric validators -- mirror appendPutValueValidated:
		// sheet must fit in u16 [0, 65535]; row/col/selectionEnd* must fit
		// in u32 [0, 4294967295]; all integers + finite.
		const numericInvalid = validatePresenceNumeric(s);
		if (numericInvalid !== null) {
			deps.onError({
				type: 'errorReply',
				sheet: deps.sheet,
				row: 0,
				col: 0,
				code: 'bad_argument',
				message: `[presenceUpdate] ${numericInvalid}`,
			});
			return;
		}
		try {
			deps.session.updatePresence(s);
			// **Phase 5.7 V3.5.0.7 (2026-05-24)** -- D5 / R-V3.4-3
			// closure: fire onLocalTyping AFTER updatePresence succeeds
			// so the host-side `_presenceRepaintInFlight` flag stays in
			// sync with the engine's presence state.  If updatePresence
			// throws (engine-level failure), we DON'T toggle the host
			// flag (the engine never received the state; the webview
			// would see the stale prior presence; the host should
			// match).  Validation failures above ALSO bypass this fire.
			//
			// Only the LOCAL peer's presenceUpdate (typing field) maps
			// to the host flag.  Remote peers' typing state is observed
			// via the per-cell `data-peer` decoration in the webview
			// (V3.4.0.5b) -- their typing does NOT block this panel's
			// merged-tick render.
			deps.onLocalTyping?.(s.typing);
			// Intentional: no onCommit().  See block comment above.
			return;
		} catch (err) {
			const info = parseQuantbookError(err);
			deps.onError({
				type: 'errorReply',
				sheet: deps.sheet,
				row: 0,
				col: 0,
				code: info.code,
				message: `[presenceUpdate] ${info.message}`,
			});
			return;
		}
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
			row: typeof req.row === 'number' ? req.row : 0,
			col: typeof req.col === 'number' ? req.col : 0,
			code: 'bad_argument',
			message: `rawInput must be a string, got ${typeof req.rawInput}`,
		});
		return;
	}
	if (req.sheet !== deps.sheet) {
		console.warn(`[cellGrid] putValue sheet mismatch: req.sheet=${req.sheet} deps.sheet=${deps.sheet}`);
		return;
	}
	try {
		const parsed = parseCellRawInput(req.rawInput);
		appendPutValueValidated(deps.session, req.sheet, req.row, req.col, parsed);
		deps.onCommit();
	} catch (err) {
		const info = parseQuantbookError(err);
		deps.onError({
			type: 'errorReply',
			sheet: req.sheet,
			row: req.row,
			col: req.col,
			code: info.code,
			message: info.message,
		});
	}
}

// ============================================================================
// Phase 5.7 V3.3.0.4 (2026-05-22) -- virtualization pure helpers
// ============================================================================

/**
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
 * V3.3.0.4 -- slice a snapshot's entries to the index range
 * `[startIdx, endIdx)`.
 *
 * Pure function over snapshot data.  Mocha tests use this to verify
 * that virtualization preserves the V3.2.a/b/c data-row + data-col +
 * data-original-text + data-original-kind invariants on the rendered
 * subset (which is what `cellGridHtml.ts::buildHtml` consumes).
 *
 * Returns the sliced sub-array (NOT mutating the input).  The HTML
 * builder downstream renders these as `<tr>` rows; top + bottom
 * spacer rows sandwich them.
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
// Phase 5.7 V3.5.0.4b (2026-05-24) -- WorkbookSnapshot -> single-sheet
// QuantbookCellSnapshot transformer
// ============================================================================

/**
 * **Phase 5.7 V3.5.0.4b (2026-05-24) -- extract one sheet's
 * QuantbookCellSnapshot from a WorkbookSnapshotJson.**
 *
 * Bridges the V3.5.0.2 `WorkbookSnapshotJson` shape (multi-sheet, with
 * optional value/formula per cell) into the V3.2.a `QuantbookCellSnapshot`
 * shape (single-sheet, required-value entries) that {@link buildHtml}
 * has consumed since V3.2.a.  Lets `cellGridPanel.ts::render()` switch
 * from `exportSnapshot(sheet)` to `workbookSnapshot()` WITHOUT changing
 * the html-building layer (which is a much larger surface).
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
	const sheet: SheetSnapshotJson | undefined = snapshot.sheets.find(s => s.id === sheetId);
	if (sheet === undefined) {
		return null;
	}
	const entries: { row: number; col: number; value: QuantbookCellValue; rendered?: string }[] = [];
	for (const cell of sheet.cells) {
		if (cell.value === undefined) {
			// Formula-only cell.  Matches V3.4.0.2 export_snapshot's
			// filter_map(state.value) behavior -- skip cells with no
			// cached literal value.  V3.6+ can surface formulas here.
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
		const entry: { row: number; col: number; value: QuantbookCellValue; rendered?: string } = {
			row: cell.row,
			col: cell.col,
			value: typed,
		};
		if (cell.rendered !== undefined) {
			entry.rendered = cell.rendered;
		}
		entries.push(entry);
	}
	return {
		snapshot_format_version: 1,
		sheet: sheetId,
		entries,
	};
}
