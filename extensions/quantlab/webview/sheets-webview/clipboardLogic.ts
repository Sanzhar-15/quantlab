/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G copy/paste -- the vscode-free core of an internal grid clipboard. A copy snapshots the
// source rectangle's UNDERLYING content (each cell's formula-with-`=` or literal); a paste re-targets it
// at the active cell, translating each FORMULA's relative refs by the move offset (literals are copied
// verbatim -- a text cell "A1" must stay "A1"). `planPaste` is pure (no DOM, no engine) so the offset
// math, the single-cell-fill-into-a-selection case, and cut-move source clears are unit-tested headlessly.
// v1 cuts (documented): no OS-clipboard interop (internal copy/paste only); a block is NOT tiled to fill
// a larger selection (pasted once at the active cell).

import { translateFormulaRefs } from './a1FormulaRefs';

/** One copied cell's underlying content: a formula (leading `=`) or a literal; `''` = an empty cell. */
export interface ClipboardCell {
	readonly rawInput: string;
}

/**
 * A snapshot of a copied (or cut) grid rectangle. `top`/`left` are the 0-based source origin (needed to
 * compute the paste offset for ref translation); `cells[i][j]` is the cell at source (`top+i`, `left+j`).
 * `isCut` requests move semantics: a paste also clears the source cells it did not overwrite.
 */
export interface GridClipboard {
	readonly top: number;
	readonly left: number;
	readonly rows: number;
	readonly cols: number;
	readonly cells: readonly (readonly ClipboardCell[])[];
	readonly isCut: boolean;
}

/** A planned target write: the cell coordinate + the (ref-translated) raw input (`''` clears the cell). */
export interface PlannedCell {
	readonly row: number;
	readonly col: number;
	readonly rawInput: string;
}

/** Translate a copied cell's content by (dRow, dCol): only a FORMULA's refs move; a literal is verbatim. */
function retargetRawInput(rawInput: string, dRow: number, dCol: number): string {
	return rawInput.trimStart().startsWith('=') ? translateFormulaRefs(rawInput, dRow, dCol) : rawInput;
}

/**
 * Plan the cell writes for pasting `clip` into the target selection rect (`selTop`/`selLeft` is the paste
 * origin -- the selection's top-left; `selRows`/`selCols` is its size). Returns the `{row, col, rawInput}`
 * writes for a `putCells` batch; the caller posts them (the host validates extent + applies them
 * atomically). Empty results are possible only for a degenerate clipboard (0 cells).
 *
 * Cases (Excel-faithful for v1):
 * - a SINGLE copied cell into a MULTI-cell selection -> fill every selected cell, each with the copied
 *   content offset by that cell's distance from the source (a relative formula increments down/across);
 * - otherwise -> paste the block once, top-left at the selection origin, every cell offset by the SAME
 *   (selTop-top, selLeft-left);
 * - `isCut` -> additionally clear each source cell the paste did not overwrite (move semantics); a source
 *   cell that is also a target keeps the pasted value (no clear), so no cell is written twice (the host
 *   batch rejects same-cell conflicts).
 */
export function planPaste(
	clip: GridClipboard,
	selTop: number,
	selLeft: number,
	selRows: number,
	selCols: number,
): PlannedCell[] {
	const planned: PlannedCell[] = [];
	const written = new Set<string>();
	const single = clip.rows === 1 && clip.cols === 1;
	if (single && (selRows > 1 || selCols > 1)) {
		const src = clip.cells[0][0].rawInput;
		for (let r = 0; r < selRows; r += 1) {
			for (let c = 0; c < selCols; c += 1) {
				const tr = selTop + r;
				const tc = selLeft + c;
				planned.push({ row: tr, col: tc, rawInput: retargetRawInput(src, tr - clip.top, tc - clip.left) });
				written.add(tr + ',' + tc);
			}
		}
	} else {
		const dRow = selTop - clip.top;
		const dCol = selLeft - clip.left;
		for (let i = 0; i < clip.rows; i += 1) {
			for (let j = 0; j < clip.cols; j += 1) {
				const tr = selTop + i;
				const tc = selLeft + j;
				planned.push({ row: tr, col: tc, rawInput: retargetRawInput(clip.cells[i][j].rawInput, dRow, dCol) });
				written.add(tr + ',' + tc);
			}
		}
	}
	if (clip.isCut) {
		for (let i = 0; i < clip.rows; i += 1) {
			for (let j = 0; j < clip.cols; j += 1) {
				const sr = clip.top + i;
				const sc = clip.left + j;
				// Only clear a NON-empty source cell the paste did not overwrite (avoids a same-cell
				// clear+write conflict, and avoids a pointless clear of an already-empty cell).
				if (!written.has(sr + ',' + sc) && clip.cells[i][j].rawInput !== '') {
					planned.push({ row: sr, col: sc, rawInput: '' });
				}
			}
		}
	}
	return planned;
}
