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
