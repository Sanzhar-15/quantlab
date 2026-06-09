/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-5 (W4 product shell) -- the vscode-free core of the "Live Python" sidebar.
//
// The sidebar visualizes the reactive-fusion MOAT: for the FOCUSED Cell Grid's workbook, it lists the
// Python variables a reactive kernel is publishing into the grid (name -> driving cell/range) plus the
// kernel's run state. This file is the PURE model: it takes a plain description of the focused workbook
// (does a grid have focus? is a kernel running? what published ranges exist, per sheet?) and produces a
// flat, render-ready node list. No VS Code coupling, so it is unit-tested headlessly; the
// LivePythonTreeProvider is a thin vscode shell that adapts these nodes to TreeItems.
//
// No-Fallbacks discipline: this model never fabricates a variable. When no kernel is running, or a
// running kernel has published nothing, it returns an EXPLICIT status/empty node -- never a placeholder
// "x -> A1" row. A missing focused grid yields a single "no grid" node (the view is normally hidden by
// the `quantbook.hasOpenGrid` context key, but the model is honest if it is ever rendered).

import { formatRangeTarget } from '../reactiveNotebook/bindVariableLogic';
import type { PublishedRange } from '../reactiveKernel/publishedCellsStore';

/** One published variable on a single sheet, paired with the human sheet name for A1 formatting. */
export interface PublishedVariableOnSheet {
	/** The published reactive variable name (the kernel-asserted driver of the cells). */
	readonly name: string;
	/** Display name of the sheet the range lives on (e.g. "S0"); used to build the A1 target. */
	readonly sheetName: string;
	/** The driven range (0-based, inclusive), in published-cell wire shape. */
	readonly range: PublishedRange;
}

/** Minimal `{ id, name }` sheet handle the model needs (a structural subset of the engine SheetInfoJson). */
export interface SheetHandle {
	readonly id: number;
	readonly name: string;
}

/**
 * The label for the focused workbook's status node: the focused sheet's own name. If the focused sheet id
 * is no longer in `sheets` (it was deleted out from under the open grid -- a real race), the label is made
 * EXPLICIT about that (`Sheet <id> (deleted)`) rather than fabricating a plausible-looking normal name --
 * the user must be able to tell a live sheet from a tombstoned one (No-Fallbacks: surface the state, don't
 * mask it).
 */
export function focusedWorkbookLabel(sheets: readonly SheetHandle[], focusedSheetId: number): string {
	const focused = sheets.find((s) => s.id === focusedSheetId);
	return focused !== undefined ? focused.name : `Sheet ${focusedSheetId} (deleted)`;
}

/**
 * Assemble the focused workbook's published variables across ALL its live sheets. A published variable can
 * drive cells on any sheet, so this walks every sheet, asks `getRangesForSheet` for that sheet's published
 * ranges, and pairs each with the sheet's OWN name (`s.name`) for A1 formatting -- no by-id map + no
 * fallback label (the name is read straight from the sheet handle being iterated). A sheet with no
 * published ranges contributes nothing. Pure + total; unit-tested directly.
 */
export function assemblePublishedVariables(
	sheets: readonly SheetHandle[],
	getRangesForSheet: (sheetId: number) => readonly PublishedRange[],
): PublishedVariableOnSheet[] {
	const out: PublishedVariableOnSheet[] = [];
	for (const s of sheets) {
		for (const range of getRangesForSheet(s.id)) {
			out.push({ name: range.name, sheetName: s.name, range });
		}
	}
	return out;
}

/**
 * A snapshot description of the focused workbook, assembled by the vscode shell and handed to
 * {@link buildLivePythonNodes}. Deliberately plain data so the model is pure + testable.
 */
export interface LivePythonInput {
	/**
	 * The focused workbook's display label (e.g. its sheet name or workbook title), shown on the kernel
	 * status node. `undefined` means NO Cell Grid is focused -- the model returns a single "no grid" node.
	 */
	readonly focusedWorkbookLabel: string | undefined;
	/**
	 * Whether a reactive kernel is currently RUNNING for the focused workbook's session. `false` when no
	 * grid is focused, or the focused workbook has no kernel (not started / stopped / crashed). When
	 * `false`, {@link publishedVariables} is ignored (an absent kernel publishes nothing).
	 */
	readonly kernelRunning: boolean;
	/**
	 * The variables the focused workbook's running kernel currently publishes, across all its sheets.
	 * Order is preserved from the caller; the model sorts deterministically (see below). Ignored when
	 * {@link kernelRunning} is `false`.
	 */
	readonly publishedVariables: readonly PublishedVariableOnSheet[];
}

/** Discriminated render node. The provider maps each to a TreeItem (icon + label + description). */
export type LivePythonNode =
	| { readonly kind: 'noGrid'; readonly id: string; readonly label: string }
	| { readonly kind: 'kernelStatus'; readonly id: string; readonly label: string; readonly running: boolean; readonly workbookLabel: string }
	| { readonly kind: 'emptyPublished'; readonly id: string; readonly label: string }
	| {
		readonly kind: 'variable';
		readonly id: string;
		/** The variable name (the tree label). */
		readonly name: string;
		/** The sheet-qualified A1 target it drives, e.g. `S0!B1` or `S0!B1:D3` (the tree description). */
		readonly target: string;
	};

/**
 * Build the flat Live-Python node list for the focused workbook. Pure + total (never throws):
 *
 * - No focused grid (`focusedWorkbookLabel === undefined`) -> a single `noGrid` node.
 * - A focused grid with NO running kernel -> a single `kernelStatus` node (running:false). No variables.
 * - A focused grid with a running kernel but ZERO published variables -> the `kernelStatus` node
 *   (running:true) + one `emptyPublished` node (explicit empty state -- No-Fallbacks).
 * - A focused grid with a running kernel + published variables -> the `kernelStatus` node + one
 *   `variable` node per published variable, sorted by (target, name) for a stable, scannable order.
 */
export function buildLivePythonNodes(input: LivePythonInput): LivePythonNode[] {
	if (input.focusedWorkbookLabel === undefined) {
		return [{ kind: 'noGrid', id: 'livePython.noGrid', label: 'No Cell Grid is open' }];
	}

	const statusNode: LivePythonNode = {
		kind: 'kernelStatus',
		id: 'livePython.kernelStatus',
		label: input.kernelRunning ? 'Reactive kernel: running' : 'Reactive kernel: not started',
		running: input.kernelRunning,
		workbookLabel: input.focusedWorkbookLabel,
	};

	if (!input.kernelRunning) {
		return [statusNode];
	}

	if (input.publishedVariables.length === 0) {
		return [
			statusNode,
			{ kind: 'emptyPublished', id: 'livePython.emptyPublished', label: 'No variables published yet' },
		];
	}

	const variableNodes: LivePythonNode[] = input.publishedVariables.map((v) => {
		const target = formatRangeTarget(
			v.sheetName,
			v.range.startRow,
			v.range.startCol,
			v.range.endRow,
			v.range.endCol,
		);
		return {
			kind: 'variable' as const,
			// The id pairs name + target so two variables (or the same name relocated) stay distinct and a
			// tree refresh re-keys cleanly.
			id: `livePython.var.${v.name}.${target}`,
			name: v.name,
			target,
		};
	});

	// Deterministic, scannable order: by A1 target first (top-left cells group together), then name.
	variableNodes.sort((a, b) => {
		if (a.kind !== 'variable' || b.kind !== 'variable') {
			return 0;
		}
		if (a.target !== b.target) {
			return a.target < b.target ? -1 : 1;
		}
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});

	return [statusNode, ...variableNodes];
}
