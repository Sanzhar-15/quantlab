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

import type { CollabSessionInstance, QuantbookErrorCode } from '../types';
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
