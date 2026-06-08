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

/**
 * Format a sheet-qualified, 1-based A1 cell target -- e.g. `formatCellTarget("S0", 0, 1)` -> `"S0!B1"`.
 * This is the exact string shape the reactive kernel's `resolveTarget` (resolveA1OnSession) parses back
 * into a range. `row`/`col` are 0-based grid coordinates (the selection's focus cell); the row is
 * rendered 1-based.
 */
export function formatCellTarget(sheetName: string, row: number, col: number): string {
	return `${sheetName}!${columnLabelA1(col)}${Math.floor(row) + 1}`;
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
 * cell (and re-runs update it -- the reactive binding).
 *
 * Injection-safety: the name-string and target-string ARGUMENTS use JSON.stringify, which produces a
 * valid Python string literal for any sheet name (quotes / backslashes are escaped; JSON has no raw
 * newline in a string). The value argument is the bare `varName`, which the caller has validated with
 * {@link isValidPublishVariableName}, so it is a safe identifier. The comment is built from the SAME
 * JSON-quoted target (never a raw sheet name) and is single-line, so a hostile sheet name cannot break
 * out of the comment either.
 */
export function buildBindPublishCellSource(varName: string, sheetName: string, row: number, col: number): string {
	const target = formatCellTarget(sheetName, row, col);
	const nameLit = JSON.stringify(varName);
	const targetLit = JSON.stringify(target);
	const comment = `# Bound ${nameLit} to ${targetLit} -- define ${varName} above, then run to publish; re-run to update.`;
	return `${comment}\nqb.publish(${nameLit}, ${varName}, ${targetLit})`;
}
