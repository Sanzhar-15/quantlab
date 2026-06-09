/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 B3 dependency-graph sidebar -- the vscode-free core of the "Dependencies" view.
//
// For the FOCUSED Cell Grid cell, this builds a flat, render-ready node list answering "what does this
// cell depend on, across languages?" -- the reactive-fusion MOAT "made legible". Two edge kinds:
//   (a) FORMULA precedents: the direct A1 references the focused cell's formula reads (extracted by the
//       shared extractFormulaRefs over the workbook snapshot). A literal cell (no formula) has none.
//   (b) PYTHON -> cell: the reactive variable a kernel publishes ONTO the focused cell -- the cross-
//       language edge. This is the reverse of the Live-Python sidebar (which lists var -> cell); here we
//       ask "is THIS cell driven by a published variable?" and name it.
//   SQL -> cell edges are DEFERRED (no target-tracking napi) and surfaced as an explicit "not tracked"
//   note ONLY when a kernel is running (so the user knows it is a real gap, not a fabricated absence).
//
// No-Fallbacks discipline: this model NEVER fabricates an edge. A cell with no formula precedents AND no
// published owner yields an EXPLICIT "no dependencies" node, not an empty/placeholder edge. A malformed
// formula is surfaced as a `formulaError` node (the caller passes the parse failure here rather than
// dropping it). A missing focused cell yields a single "no selection" node (the view is normally hidden by
// the `quantbook.hasOpenGrid` context key, but the model is honest if it is ever rendered).
//
// vscode-free + pure, so it is unit-tested headlessly; the DepGraphTreeProvider is a thin vscode shell
// that adapts these nodes to TreeItems (mirroring the LivePythonTreeProvider split).

/** One resolved formula precedent of the focused cell, already formatted as a sheet-qualified A1 target. */
export interface PrecedentEdge {
	/** The precedent's sheet-qualified A1 target, e.g. `S0!A1` or `Sheet2!$C$3` (display + node id). */
	readonly target: string;
	/** True if the precedent lives on a DIFFERENT sheet than the focused cell (a cross-sheet edge). */
	readonly crossSheet: boolean;
	/**
	 * True if this precedent IS the focused cell itself (the formula reads its own cell -- a self/circular
	 * reference). Kept + flagged rather than silently dropped: a self-reference is a real dependency/cycle
	 * signal the user should see (No-Fallbacks: surface, do not omit).
	 */
	readonly self: boolean;
}

/**
 * A snapshot description of the focused cell's dependency context, assembled by the vscode shell and handed
 * to {@link buildDepGraphNodes}. Deliberately plain data so the model is pure + testable. All A1 formatting
 * + ref extraction happens in the shell BEFORE this (the model only arranges + labels).
 */
export interface DepGraphInput {
	/**
	 * The focused cell's own sheet-qualified A1 address, e.g. `S0!B2`. `undefined` means NO cell is focused
	 * (no open/focused grid, or the grid has reported no selection yet) -> the model returns a single
	 * "no selection" node.
	 */
	readonly focusedCellLabel: string | undefined;
	/**
	 * True if the focused sheet is no longer in the workbook (it was deleted out from under the open grid --
	 * a real race). When set, the model returns a single explicit `focusedSheetMissing` node INSTEAD of a
	 * normal focused-cell view: rendering "no dependencies" over a tombstoned sheet would make a broken
	 * focused state look healthy (No-Fallbacks: surface the inconsistency, do not mask it). The shell still
	 * fills the other fields with safe defaults, but they are ignored when this is `true`.
	 */
	readonly focusedSheetMissing: boolean;
	/**
	 * The focused cell's formula body (no leading `=`), or `undefined` for a literal / empty cell. Used only
	 * to distinguish "literal cell (0 precedents is correct)" from "formula cell with 0 precedents" in the
	 * empty-state copy; the precedents themselves arrive pre-extracted in {@link precedents}.
	 */
	readonly focusedFormula: string | undefined;
	/**
	 * A formula-extraction error message, or `undefined` if extraction succeeded. When set, the model emits a
	 * `formulaError` node (No-Fallbacks: a malformed formula is surfaced, never silently dropped) INSTEAD of
	 * precedent nodes. (extractFormulaRefs is total, so this is reserved for a snapshot/parse failure upstream.)
	 */
	readonly formulaError: string | undefined;
	/**
	 * The focused cell's direct formula precedents, pre-extracted + A1-formatted + de-duplicated by the shell,
	 * in source order. Empty for a literal cell or a formula that reads no cells (`=TODAY()`, `=1+2`).
	 */
	readonly precedents: readonly PrecedentEdge[];
	/**
	 * Whether a reactive kernel is currently RUNNING for the focused workbook. Gates the Python-edge section:
	 * when `false`, no Python owner can exist and the SQL "not tracked" note is suppressed (there is no
	 * cross-language runtime to attribute to). When `true`, {@link pythonOwner} names the driver (or is
	 * `undefined` for "this cell is not reactively driven").
	 */
	readonly kernelRunning: boolean;
	/**
	 * The reactive variable that publishes ONTO the focused cell, or `undefined` if no published variable
	 * drives it. Read by the shell from the per-session published-cells set (the reverse of the Live-Python
	 * var -> cell map). Ignored when {@link kernelRunning} is `false`.
	 */
	readonly pythonOwner: string | undefined;
}

/** Discriminated render node. The provider maps each to a TreeItem (icon + label + description). */
export type DepGraphNode =
	| { readonly kind: 'noSelection'; readonly id: string; readonly label: string }
	| { readonly kind: 'focusedSheetMissing'; readonly id: string; readonly label: string }
	| { readonly kind: 'focusedCell'; readonly id: string; readonly label: string; readonly cellLabel: string }
	| { readonly kind: 'sectionHeader'; readonly id: string; readonly label: string }
	| { readonly kind: 'precedent'; readonly id: string; readonly label: string; readonly crossSheet: boolean; readonly self: boolean }
	| { readonly kind: 'pythonOwner'; readonly id: string; readonly label: string; readonly variableName: string }
	| { readonly kind: 'noDependencies'; readonly id: string; readonly label: string }
	| { readonly kind: 'formulaError'; readonly id: string; readonly label: string; readonly detail: string }
	| { readonly kind: 'sqlDeferred'; readonly id: string; readonly label: string };

/**
 * Build the flat dependency-graph node list for the focused cell. Pure + total (never throws):
 *
 * - No focused cell (`focusedCellLabel === undefined`) -> a single `noSelection` node.
 * - Otherwise the first node is always a `focusedCell` header naming the cell.
 * - FORMULA precedents: if `formulaError` is set -> a `formulaError` node (No-Fallbacks). Else one
 *   `precedent` node per pre-extracted precedent (under a "Formula precedents" section header when any
 *   exist). Cross-sheet precedents carry a flag the provider renders distinctly.
 * - PYTHON edge: when a kernel runs AND a `pythonOwner` is set -> a `pythonOwner` node (under a "Driven by"
 *   section). A running kernel with SQL un-tracked also emits a single `sqlDeferred` note (explicit gap).
 * - If, after all of the above, the cell has NO precedents AND NO python owner AND no formula error ->
 *   an explicit `noDependencies` node (never an invented edge). The empty-state copy distinguishes a
 *   literal cell from a formula cell that simply reads nothing.
 */
export function buildDepGraphNodes(input: DepGraphInput): DepGraphNode[] {
	if (input.focusedCellLabel === undefined) {
		return [{ kind: 'noSelection', id: 'depGraph.noSelection', label: 'No cell is selected' }];
	}

	// The focused sheet was deleted out from under the open grid -> surface that EXPLICITLY rather than show
	// a normal "no dependencies" view over a tombstoned sheet (No-Fallbacks: a broken focus must look broken).
	if (input.focusedSheetMissing) {
		return [{
			kind: 'focusedSheetMissing',
			id: 'depGraph.focusedSheetMissing',
			label: 'Focused sheet was deleted',
		}];
	}

	const nodes: DepGraphNode[] = [
		{
			kind: 'focusedCell',
			id: 'depGraph.focusedCell',
			label: input.focusedCellLabel,
			cellLabel: input.focusedCellLabel,
		},
	];

	let hasFormulaSection = false;

	// --- (a) Formula precedents ---
	if (input.formulaError !== undefined) {
		nodes.push({
			kind: 'formulaError',
			id: 'depGraph.formulaError',
			label: 'Could not read formula precedents',
			detail: input.formulaError,
		});
		hasFormulaSection = true;
	} else if (input.precedents.length > 0) {
		nodes.push({ kind: 'sectionHeader', id: 'depGraph.section.precedents', label: 'Formula precedents' });
		for (const p of input.precedents) {
			nodes.push({
				kind: 'precedent',
				// The target is unique per precedent (the shell de-dupes), so it keys the node stably.
				id: `depGraph.precedent.${p.target}`,
				// A self-reference is annotated so the cycle is visible (the provider also marks it distinctly).
				label: p.self ? `${p.target} (self / circular)` : p.target,
				crossSheet: p.crossSheet,
				self: p.self,
			});
		}
		hasFormulaSection = true;
	}

	// --- (b) Python -> cell (the cross-language edge) ---
	let hasPythonSection = false;
	if (input.kernelRunning && input.pythonOwner !== undefined) {
		nodes.push({ kind: 'sectionHeader', id: 'depGraph.section.driver', label: 'Driven by' });
		nodes.push({
			kind: 'pythonOwner',
			id: `depGraph.pythonOwner.${input.pythonOwner}`,
			label: `Reactive variable "${input.pythonOwner}"`,
			variableName: input.pythonOwner,
		});
		hasPythonSection = true;
	}

	// --- SQL edges DEFERRED (explicit gap, only when a runtime exists to attribute to) ---
	// Surfaced ONLY when a kernel is running: otherwise there is no cross-language runtime and the note
	// would be noise. Never a fabricated SQL edge -- just an honest "not tracked yet" marker.
	if (input.kernelRunning) {
		nodes.push({
			kind: 'sqlDeferred',
			id: 'depGraph.sqlDeferred',
			label: 'SQL lineage: not tracked yet',
		});
	}

	// --- No-Fallbacks empty state ---
	if (!hasFormulaSection && !hasPythonSection) {
		nodes.push({
			kind: 'noDependencies',
			id: 'depGraph.noDependencies',
			label: input.focusedFormula === undefined
				? 'No dependencies (literal cell)'
				: 'No dependencies (formula reads no cells)',
		});
	}

	return nodes;
}
