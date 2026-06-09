/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 error-surface -- the vscode-free core of the Quantbook DiagnosticCollection bridge.
//
// The host bridge (quantbookDiagnostics.ts) is a thin vscode shell over these pure helpers: it maps a
// CellDiagnostic to a `vscode.Diagnostic` over a single-cell `vscode.Range`, sets it into the
// `quantbook` DiagnosticCollection keyed by a deterministic `quantbook://` uri, and registers a
// TextDocumentContentProvider that renders the same list as a readable virtual doc so a Problems-panel
// click navigates. The risky, testable parts -- extracting the CURRENTLY error-valued cells from a
// render snapshot, the A1 formatting, the deterministic uri/key strings, and the message formatting --
// live HERE and are unit-tested directly (no vscode, no engine).
//
// No-Fallbacks: the snapshot is the AUTHORITATIVE source of stored cell errors. A cell that recovered
// to a real value is no longer `kind:'error'`, so it is absent from the extracted list -- the bridge
// then replaces that sheet's uri with the shorter list and the recovered cell's diagnostic disappears.
// Nothing is fabricated; an empty extraction means "no errors", which clears the sheet's diagnostics.

import type { QuantbookCellSnapshot } from '../types';

/**
 * 0-based column index -> bijective base-26 A1 column letters (0 -> "A", 25 -> "Z", 26 -> "AA"). A
 * negative index returns "" (defensive; callers pass an in-extent column from a real snapshot entry).
 * Duplicated from `bindVariableLogic.columnLabelA1` rather than imported so this leaf module owns its
 * formatting (the two are pinned identical by tests in both suites).
 */
export function columnLabelA1(col: number): string {
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

/** 0-based (row, col) -> 1-based A1 cell label (row 0, col 0 -> "A1"). */
export function formatCellA1(row: number, col: number): string {
	return `${columnLabelA1(col)}${Math.floor(row) + 1}`;
}

/**
 * One cell-scoped Quantbook diagnostic extracted from a render snapshot or an input-rejection.
 * `code` is the short error token surfaced as the cell value (e.g. `#CALC!` / `#PYTHON!`, or a
 * structured `errorReply` code); `message` is the human-readable reason. `row`/`col` are 0-based.
 */
export interface CellDiagnostic {
	readonly row: number;
	readonly col: number;
	readonly code: string;
	readonly message: string;
}

/**
 * Extract the CURRENTLY error-valued cells from a (diagnostic-decorated) render snapshot. For each
 * `value.kind==='error'` entry: `code` = the error string (`value.value`, e.g. `#CALC!`); `message` =
 * the cell's attached `.diagnostic` (the human reason from `cell_diagnostic`) when present, else the
 * error string itself (so a stored error with no diagnostic still surfaces a non-empty message). Pure.
 *
 * This is the single source of truth for STORED cell errors -- a recovered cell is no longer an error
 * entry, so it is absent here, and the bridge replacing the sheet's uri list clears it (No-Fallbacks).
 * The returned list preserves the snapshot's (row, col)-ascending order.
 */
export function buildCellDiagnosticsFromSnapshot(snapshot: QuantbookCellSnapshot): CellDiagnostic[] {
	const out: CellDiagnostic[] = [];
	for (const entry of snapshot.entries) {
		if (entry.value.kind !== 'error') {
			continue;
		}
		const code = entry.value.value;
		const message = entry.diagnostic !== undefined && entry.diagnostic.length > 0 ? entry.diagnostic : code;
		out.push({ row: entry.row, col: entry.col, code, message });
	}
	return out;
}

/**
 * Deterministic `quantbook://` authority/path for one sheet's cell diagnostics. The host wraps this in a
 * `vscode.Uri` (one uri per (session,sheet)); a `set(uri, diags)` replaces that sheet's list. Includes
 * a per-session tag so two open workbooks on the same sheet id never collide on one uri.
 *
 * Shape: `quantbook://workbook/<sessionTag>/sheet/<sheet>`. `sessionTag` is an opaque, stable,
 * already-sanitized token the host derives per session (see `quantbookDiagnostics.sessionTag`).
 */
export function cellDiagnosticsUriPath(sessionTag: string, sheet: number): { authority: string; path: string } {
	return { authority: 'workbook', path: `/${sessionTag}/sheet/${sheet}` };
}

/**
 * Deterministic `quantbook://` authority/path for one session's WORKBOOK-LEVEL reactive errors (a
 * reactive `onError` carries no cell address). One uri per session; cleared when the kernel recovers or
 * stops. Shape: `quantbook://workbook/<sessionTag>/reactive`.
 */
export function reactiveDiagnosticsUriPath(sessionTag: string): { authority: string; path: string } {
	return { authority: 'workbook', path: `/${sessionTag}/reactive` };
}

/**
 * Human label for a cell-diagnostic source line in the virtual doc + the diagnostic message prefix:
 * `Sheet <sheet> <A1>`. The sheet NAME is not always available at extraction time (a workbook-level
 * cell_diagnostic, a deleted sheet), so the numeric sheet id is the stable anchor.
 */
export function formatCellLocationLabel(sheet: number, row: number, col: number): string {
	return `Sheet ${sheet} ${formatCellA1(row, col)}`;
}

/**
 * Render the readable virtual-doc body the `quantbook://.../sheet/<n>` content provider serves so a
 * Problems-panel click opens a real document. Lists each current error cell with its A1 address, code,
 * and message. Pure (no vscode). An empty list yields a "no current errors" body (the diagnostic that
 * pointed here just cleared -- the doc is still openable from history).
 */
export function renderCellDiagnosticsDoc(sheet: number, diagnostics: readonly CellDiagnostic[]): string {
	const header = `Quantbook errors -- Sheet ${sheet}`;
	if (diagnostics.length === 0) {
		return `${header}\n\nNo current errors on this sheet.\n`;
	}
	const lines = diagnostics.map(d => `${formatCellA1(d.row, d.col)}\t[${d.code}] ${d.message}`);
	return `${header}\n\n${lines.join('\n')}\n`;
}

/**
 * Render the readable virtual-doc body for a session's workbook-level reactive errors. `messages` is the
 * ordered list of active reactive error strings (typically one -- the latest). Pure.
 */
export function renderReactiveDiagnosticsDoc(messages: readonly string[]): string {
	const header = 'Quantbook errors -- reactive kernel (workbook-level)';
	if (messages.length === 0) {
		return `${header}\n\nNo current reactive errors.\n`;
	}
	return `${header}\n\n${messages.map(m => `* ${m}`).join('\n')}\n`;
}
