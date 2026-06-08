/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 N-2 -- the vscode-free core of "Bind Variable to Selected Cell".
//
// The command (in reactiveNotebookController.ts) reads the focused grid's selection
// (CellGridPanel.focusedGridSelection, W-G-2b) and appends a reactive `qb.publish(...)` code cell to
// the active reactive notebook, with the A1 target computed from the selection so the operator never
// hand-types `S0!B1`. The risky, pure parts -- A1 formatting + Python-source generation that must be
// injection-safe for any sheet name -- live HERE and are unit-tested directly (the controller is a
// thin vscode shell over them, the established N-1 split).
//
// No-Fallbacks: an invalid variable name is rejected by the command's input box via
// isValidPublishVariableName -- never coerced into a broken cell.

/**
 * 0-based column index -> bijective base-26 A1 column letters (0 -> "A", 25 -> "Z", 26 -> "AA"). Mirrors
 * the webview `columnLabel` (which is esbuild-isolated from the host, so it cannot be imported here).
 * A negative index returns "" (defensive; callers pass a validated in-extent column).
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

/** A normalized 0-based INCLUSIVE rect: `start <= end` on both axes. */
export interface NormalizedRect {
	readonly startRow: number;
	readonly startCol: number;
	readonly endRow: number;
	readonly endCol: number;
}

/**
 * Normalize a selection's two corners -- `anchor` + `focus`, in ANY order -- into a top-left ->
 * bottom-right rect (`start <= end` on both axes), so {@link formatRangeTarget} /
 * {@link buildBindPublishRangeCellSource} always receive a well-ordered rect (an un-normalized rect would
 * yield a reversed `D3:B1` target, which the kernel's `_parse_envelope` rejects). Pure + unit-tested (the
 * command in reactiveNotebookController.ts is a thin vscode shell over this); mirrors the webview
 * `selectionRect` (gridLayoutA1.ts), which is esbuild-isolated from the host and so cannot be imported here.
 */
export function normalizeSelectionRect(anchorRow: number, anchorCol: number, focusRow: number, focusCol: number): NormalizedRect {
	return {
		startRow: Math.min(anchorRow, focusRow),
		startCol: Math.min(anchorCol, focusCol),
		endRow: Math.max(anchorRow, focusRow),
		endCol: Math.max(anchorCol, focusCol),
	};
}

/**
 * Format a sheet-qualified, 1-based A1 RANGE target from a NORMALIZED 0-based rect (the caller min/maxes
 * the selection's anchor+focus first via {@link normalizeSelectionRect}) -- e.g.
 * `formatRangeTarget("S0", 0, 1, 2, 3)` -> `"S0!B1:D3"`. A
 * single-cell rect (start === end on both axes) collapses to a bare cell (`"S0!B1"`), byte-identical to the
 * N-2 single-cell target. This is the exact string shape the reactive kernel's `_parse_envelope` parses
 * back into an envelope (it splits a colon range into top-left:bottom-right). The row is rendered 1-based.
 */
export function formatRangeTarget(sheetName: string, startRow: number, startCol: number, endRow: number, endCol: number): string {
	const tl = `${columnLabelA1(startCol)}${Math.floor(startRow) + 1}`;
	if (startRow === endRow && startCol === endCol) {
		return `${sheetName}!${tl}`;
	}
	const br = `${columnLabelA1(endCol)}${Math.floor(endRow) + 1}`;
	return `${sheetName}!${tl}:${br}`;
}

/**
 * Format a sheet-qualified, 1-based A1 single-CELL target -- e.g. `formatCellTarget("S0", 0, 1)` -> `"S0!B1"`.
 * A thin single-cell specialization of {@link formatRangeTarget} (kept so single-cell call sites/tests read
 * intent-first; the output is byte-identical to N-2). `row`/`col` are 0-based grid coordinates.
 */
export function formatCellTarget(sheetName: string, row: number, col: number): string {
	return formatRangeTarget(sheetName, row, col, row, col);
}

// Python reserved words: a name equal to one of these is a syntax error as a variable, so reject it up
// front (the input box would otherwise accept e.g. "class" and the appended cell would never run).
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
	'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
	'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
	'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/**
 * Whether `name` is a usable Python variable name to publish: a plain identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`, ASCII-only) that is not a reserved word. No-Fallbacks: the command's input
 * box validates with this and refuses an invalid name rather than coercing it (the appended cell uses the
 * name BOTH as a string key and as the bare value expression, so it must be a real identifier).
 */
export function isValidPublishVariableName(name: string): boolean {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		return false;
	}
	return !PYTHON_KEYWORDS.has(name);
}

/**
 * Whether `sheetName` can be used in a `qb.publish` target. The kernel's target resolver
 * (`resolveA1OnSession`) splits on the FIRST `!` into `sheet!ref`, so a sheet name CONTAINING a `!`
 * (which the engine permits -- it only forbids `: \ / ? * [ ]`) would be mis-parsed: `A!B!C1` would
 * resolve to sheet `A`, not `A!B`. Until the resolver supports quoted sheet refs, reject such names
 * loudly (No-Fallbacks: never append a cell that silently targets the wrong sheet). Empty is also
 * rejected (a `!A1` target has no sheet).
 */
export function isPublishableSheetName(sheetName: string): boolean {
	return sheetName.length > 0 && !sheetName.includes('!');
}

/**
 * Build the Python source for the appended reactive cell: a one-line guidance comment plus the
 * `qb.publish(name, value, target)` call that, on run, writes `varName`'s current value into the target
 * RANGE (and re-runs update it -- the reactive binding). The rect is NORMALIZED (start <= end; the caller
 * min/maxes the selection's anchor+focus). A single-cell rect (start === end) yields the exact N-2
 * single-cell comment + a bare-cell target; a multi-cell rect yields a range target (`S0!B1:D3`) and a
 * comment that hints `varName` must be a 2D value (the runtime spreads a list-of-lists / numpy / DataFrame
 * across the envelope, blank-filling any shortfall).
 *
 * Injection-safety: the name-string and target-string ARGUMENTS use JSON.stringify, which produces a
 * valid Python string literal for any sheet name (quotes / backslashes are escaped; JSON has no raw
 * newline in a string). The value argument is the bare `varName`, which the caller has validated with
 * {@link isValidPublishVariableName}, so it is a safe identifier. The comment is built from the SAME
 * JSON-quoted target (never a raw sheet name) and is single-line, so a hostile sheet name cannot break
 * out of the comment either.
 */
export function buildBindPublishRangeCellSource(varName: string, sheetName: string, startRow: number, startCol: number, endRow: number, endCol: number): string {
	const target = formatRangeTarget(sheetName, startRow, startCol, endRow, endCol);
	const nameLit = JSON.stringify(varName);
	const targetLit = JSON.stringify(target);
	const isRange = startRow !== endRow || startCol !== endCol;
	const comment = isRange
		? `# Bound ${nameLit} to ${targetLit} -- define ${varName} (a 2D value: list-of-lists, numpy array, or DataFrame) above, then run to publish; re-run to update.`
		: `# Bound ${nameLit} to ${targetLit} -- define ${varName} above, then run to publish; re-run to update.`;
	return `${comment}\nqb.publish(${nameLit}, ${varName}, ${targetLit})`;
}

/**
 * Single-CELL specialization of {@link buildBindPublishRangeCellSource} (kept so single-cell call
 * sites/tests read intent-first; the output is byte-identical to N-2).
 */
export function buildBindPublishCellSource(varName: string, sheetName: string, row: number, col: number): string {
	return buildBindPublishRangeCellSource(varName, sheetName, row, col, row, col);
}
