/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I (R13 + R14, 2026-06-19) -- the vscode-free core of the "Errors" diagnostics sidebar.
//
// The B3/W2 error surface already mirrors Quantbook cell errors into VS Code's Problems panel
// (`quantbookDiagnostics.ts`). This sidebar is the DEDICATED tree view over the SAME data (R14's
// "dedicated panel"): for the FOCUSED workbook it lists every current error grouped by sheet, plus a
// workbook-level reactive-kernel error when present, each classified by error CLASS so the provider can
// render a distinct icon (R14's "distinct #PYTHON!/#BINDING! markers") and a full `[code] message`
// tooltip (R14's "traceback hover"). Clicking a cell error reveals the cell in the focused grid.
//
// This module is PURE + vscode-free (the {@link DiagnosticsTreeProvider} is a thin shell that adapts these
// nodes to TreeItems, mirroring the depGraphModel / livePythonModel split), so the grouping + ordering +
// classification are unit-tested headlessly.
//
// No-Fallbacks: nothing is fabricated. Zero errors yields an explicit `noErrors` node (never a blank tree
// masquerading as healthy); no focused grid yields an explicit `noGrid` node (the view is normally hidden
// by the `quantbook.hasOpenGrid` context key, but the model is honest if ever rendered).

import { formatCellA1, type CellDiagnostic } from './diagnosticsLogic';

/**
 * The error CLASS of a diagnostic, derived from its `code`. Drives the tree icon (R14 distinct markers).
 * `python` = a Python UDF fault (`#PYTHON!` or an engine `udf_*` code); `binding` = a reactive binding
 * fault (`#BINDING!`); `calc` = a spreadsheet compute error (`#CALC!`/`#DIV/0!`/`#NUM!`/`#VALUE!`/`#REF!`);
 * `name` = an unresolved name (`#NAME?`); `parse` = an input-rejection (formula parse/bind / bad argument);
 * `generic` = anything else (surfaced honestly, never dropped).
 */
export type DiagnosticErrorClass = 'python' | 'binding' | 'calc' | 'name' | 'parse' | 'generic';

/**
 * Classify a diagnostic `code` into a {@link DiagnosticErrorClass}. Pure + total. The match is on the
 * SHORT code token surfaced as the cell value (`#PYTHON!`, `#CALC!`, ...) OR the structured input-rejection
 * code (`formula_parse`, `bad_argument`, the engine `udf_*` codes). Unknown codes fall to `generic` (the
 * error is still shown -- classification only chooses the icon, never gates visibility).
 */
export function classifyErrorCode(code: string): DiagnosticErrorClass {
	if (code === '#PYTHON!' || code.startsWith('udf_')) {
		return 'python';
	}
	if (code === '#BINDING!') {
		return 'binding';
	}
	if (code === '#CALC!' || code === '#DIV/0!' || code === '#NUM!' || code === '#VALUE!' || code === '#REF!') {
		return 'calc';
	}
	if (code === '#NAME?') {
		return 'name';
	}
	if (code === 'formula_parse' || code === 'formula_bind' || code.startsWith('bad_')) {
		return 'parse';
	}
	return 'generic';
}

/** One sheet's current errors, as handed to {@link buildDiagnosticsNodes} (the provider resolves the
 *  sheet NAME from the live session; `sheetName` is `undefined` for a tombstoned/unknown sheet). */
export interface DiagnosticsSheetInput {
	readonly sheet: number;
	readonly sheetName: string | undefined;
	readonly diagnostics: readonly CellDiagnostic[];
}

/**
 * A snapshot of the focused workbook's current diagnostics, assembled by the vscode shell. Plain data so the
 * model is pure + testable: the shell reads {@link QuantbookDiagnostics.currentDiagnostics} + the live sheet
 * names + the reactive error and arranges them here; the model only groups, orders, classifies, and labels.
 */
export interface DiagnosticsInput {
	/** False when no Cell Grid is focused (no open/focused workbook) -> a single `noGrid` node. */
	readonly hasFocusedGrid: boolean;
	/** Per-sheet current cell diagnostics (only sheets that HAVE errors; order is normalized by the model). */
	readonly sheets: readonly DiagnosticsSheetInput[];
	/** The workbook-level reactive-kernel error, or `undefined` if none / no kernel fault. */
	readonly reactiveError: string | undefined;
}

/** Discriminated render node. The provider maps each to a TreeItem (icon + label + description + tooltip).
 *  `sheetGroup` is the only collapsible node: its `children` are the cell-error leaves. */
export type DiagnosticsNode =
	| { readonly kind: 'noGrid'; readonly id: string; readonly label: string }
	| { readonly kind: 'noErrors'; readonly id: string; readonly label: string }
	| { readonly kind: 'reactiveError'; readonly id: string; readonly label: string; readonly message: string }
	| {
		readonly kind: 'sheetGroup';
		readonly id: string;
		readonly label: string;
		readonly sheet: number;
		readonly errorCount: number;
		readonly children: readonly DiagnosticsNode[];
	}
	| {
		readonly kind: 'cellError';
		readonly id: string;
		readonly label: string;
		readonly sheet: number;
		readonly row: number;
		readonly col: number;
		readonly code: string;
		readonly message: string;
		readonly errorClass: DiagnosticErrorClass;
	};

/** A sheet's display label: its live name when known, else the stable `Sheet <id>` anchor (tombstoned/unknown). */
function sheetLabel(input: DiagnosticsSheetInput): string {
	return input.sheetName !== undefined ? input.sheetName : `Sheet ${input.sheet}`;
}

/**
 * Build the diagnostics tree's ROOT nodes for the focused workbook. Pure + total (never throws). The
 * `sheetGroup` nodes carry their `cellError` children inline (the provider returns them from
 * `getChildren(group)`); every other node is a leaf.
 *
 * - No focused grid (`hasFocusedGrid === false`) -> a single `noGrid` node.
 * - Otherwise: one `reactiveError` node first (when present -- it is workbook-level, so it leads), then one
 *   `sheetGroup` per sheet that has errors (sorted by sheet id ascending), each grouping its cell errors
 *   (sorted by row then col ascending) as `cellError` leaves classified for the icon.
 * - If, after the above, there are NO cell errors AND no reactive error -> an explicit `noErrors` node
 *   (No-Fallbacks: an empty tree must say "no errors", never render blank).
 */
export function buildDiagnosticsNodes(input: DiagnosticsInput): DiagnosticsNode[] {
	if (!input.hasFocusedGrid) {
		return [{ kind: 'noGrid', id: 'diag.noGrid', label: 'No workbook is focused' }];
	}

	const nodes: DiagnosticsNode[] = [];

	// Workbook-level reactive error leads (it is not scoped to a sheet/cell).
	if (input.reactiveError !== undefined) {
		nodes.push({
			kind: 'reactiveError',
			id: 'diag.reactiveError',
			label: 'Reactive kernel error',
			message: input.reactiveError,
		});
	}

	// Per-sheet groups, sheet id ascending; within each, cell errors row- then col-ascending.
	const sheetsWithErrors = input.sheets
		.filter((s) => s.diagnostics.length > 0)
		.slice()
		.sort((a, b) => a.sheet - b.sheet);

	for (const s of sheetsWithErrors) {
		const ordered = s.diagnostics.slice().sort((a, b) => (a.row - b.row) || (a.col - b.col));
		const children: DiagnosticsNode[] = ordered.map((d) => ({
			kind: 'cellError',
			// (sheet, row, col) is unique within a sheet group -> a stable node id.
			id: `diag.cell.${s.sheet}.${d.row}.${d.col}`,
			label: `${formatCellA1(d.row, d.col)}: ${d.code}`,
			sheet: s.sheet,
			row: d.row,
			col: d.col,
			code: d.code,
			message: d.message,
			errorClass: classifyErrorCode(d.code),
		}));
		nodes.push({
			kind: 'sheetGroup',
			id: `diag.sheet.${s.sheet}`,
			label: sheetLabel(s),
			sheet: s.sheet,
			errorCount: children.length,
			children,
		});
	}

	if (input.reactiveError === undefined && sheetsWithErrors.length === 0) {
		nodes.push({ kind: 'noErrors', id: 'diag.noErrors', label: 'No errors in this workbook' });
	}

	return nodes;
}
