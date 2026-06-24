/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave L2 (R23 SQL->cell lineage) -- the vscode-free core of the "Show Cell Lineage" command. The
// command (in quantbookCommands.ts) reads the focused grid's session, calls
// `session.cellLineage(sheet, row, col)`, and hands the result (a {@link CellLineageJson} or `null`)
// to {@link formatCellLineage}, which shapes it into a {@link LineagePresentation}: a one-line
// `summary` (the info-message body), a multi-line `detail` (the output-channel body, carrying the full
// SQL text + block coordinates), and an optional `reveal` anchor (the top-left of the produced block,
// which the command navigates to). All shaping is pure and unit-tested directly against engine
// `cellLineage()` output; the command is a thin vscode shell.
//
// No-Fallbacks: the `null` (no-lineage) and missing-SQL cases each produce an explicit, visible
// message -- never a silent no-op and never a fabricated SQL string.

import { cellRefA1 } from '../shared/gridLayoutA1';
import type { CellLineageJson } from '../types';

/** The vscode-free presentation of a cell's lineage, consumed by the command shell. */
export interface LineagePresentation {
	/** One-line body for `showInformationMessage`. */
	readonly summary: string;
	/** Multi-line body for the "Quantbook" output channel (full SQL + block coords). */
	readonly detail: string;
	/**
	 * Top-left of the produced block to reveal, or `undefined` when there is no lineage (so the
	 * command offers no "Reveal source block" action).
	 */
	readonly reveal?: { readonly sheet: number; readonly row: number; readonly col: number };
}

/**
 * The A1 label of a lineage block: a single cell (`"C1"`) when the block is 1x1, else a range
 * (`"C1:D4"`). Pure.
 */
export function lineageBlockA1(lineage: CellLineageJson): string {
	const topLeft = cellRefA1(lineage.producedStartRow, lineage.producedStartCol);
	if (lineage.producedStartRow === lineage.producedEndRow && lineage.producedStartCol === lineage.producedEndCol) {
		return topLeft;
	}
	return `${topLeft}:${cellRefA1(lineage.producedEndRow, lineage.producedEndCol)}`;
}

/**
 * Shape an engine `cellLineage` result into a {@link LineagePresentation}. `cellA1` is the A1 label
 * of the focused cell whose lineage was read. Pure -- the command shell does the vscode I/O.
 *
 * - `null` (the cell was not produced by a tracked source) -> a clear "no lineage" message, no reveal.
 * - `kind === 'query'` -> the source query id, produced block, and the full SQL text in `detail`.
 * - `kind === 'published'` -> the source dataset id and produced block (a value matrix carries no SQL).
 */
export function formatCellLineage(lineage: CellLineageJson | null, cellA1: string): LineagePresentation {
	if (lineage === null) {
		const msg = `${cellA1} has no lineage: it was not produced by a SQL query or a published dataset.`;
		return { summary: msg, detail: msg };
	}
	const block = lineageBlockA1(lineage);
	const reveal = { sheet: lineage.producedSheet, row: lineage.producedStartRow, col: lineage.producedStartCol };
	const count = `${lineage.producedCells} cell${lineage.producedCells === 1 ? '' : 's'}`;
	if (lineage.kind === 'query') {
		const summary = `${cellA1}: SQL query "${lineage.sourceId}" -> block ${block} (${count}).`;
		// A query source always stores its SQL; if it is somehow absent, say so loudly rather than
		// printing "undefined" or silently dropping the line (No-Fallbacks).
		const sql = lineage.sql !== undefined && lineage.sql.length > 0 ? lineage.sql : '(no SQL recorded)';
		return { summary, detail: `${summary}\nSQL:\n${sql}`, reveal };
	}
	const summary = `${cellA1}: published dataset "${lineage.sourceId}" -> block ${block} (${count}).`;
	return { summary, detail: summary, reveal };
}
