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
 * A snapshot of a copied (or cut) grid rectangle. `sheet` is the source sheet (so a cross-sheet CUT does
 * not clear the wrong sheet -- megaudit HIGH); `top`/`left` are the 0-based source origin (needed to
 * compute the paste offset for ref translation); `cells[i][j]` is the cell at source (`top+i`, `left+j`).
 * `isCut` requests move semantics: a paste also clears the source cells it did not overwrite.
 */
export interface GridClipboard {
	readonly sheet: number;
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
 * Cases (Excel-faithful):
 * - a SINGLE copied cell into a MULTI-cell selection (COPY only) -> fill every selected cell, each with the
 *   copied content offset by that cell's distance from the source (a relative formula increments down/across);
 * - a multi-cell COPY into a selection that is an EXACT MULTIPLE of the block (and larger) -> TILE the block
 *   to fill the selection, each tile offset by its own (selectionOrigin + tileOffset - source);
 * - otherwise (equal/smaller selection, a single target cell, or any CUT) -> paste the block once, top-left
 *   at the selection origin, every cell offset by the SAME (selTop-top, selLeft-left). A CUT is a MOVE: the
 *   selection size is ignored (it always lands once at the origin), never filled or tiled.
 * - a multi-cell COPY into a LARGER selection that is NOT an exact multiple is a size mismatch: the caller
 *   must check {@link pasteAreaMismatch} and refuse loudly BEFORE calling this (Excel "areas not the same
 *   size"); No-Fallbacks -- never silently paste a partial block.
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
	if (single && !clip.isCut && (selRows > 1 || selCols > 1)) {
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
		// TILE a COPY across an exact-multiple, larger selection (each axis independently); otherwise a single
		// tile (= paste once at the origin). A CUT is always a single tile (move semantics, selection ignored).
		const tile = !clip.isCut;
		const tilesDown = tile && selRows > clip.rows && selRows % clip.rows === 0 ? selRows / clip.rows : 1;
		const tilesRight = tile && selCols > clip.cols && selCols % clip.cols === 0 ? selCols / clip.cols : 1;
		for (let td = 0; td < tilesDown; td += 1) {
			for (let tc2 = 0; tc2 < tilesRight; tc2 += 1) {
				const baseRow = selTop + td * clip.rows;
				const baseCol = selLeft + tc2 * clip.cols;
				const dRow = baseRow - clip.top;
				const dCol = baseCol - clip.left;
				for (let i = 0; i < clip.rows; i += 1) {
					for (let j = 0; j < clip.cols; j += 1) {
						const tr = baseRow + i;
						const tc = baseCol + j;
						planned.push({ row: tr, col: tc, rawInput: retargetRawInput(clip.cells[i][j].rawInput, dRow, dCol) });
						written.add(tr + ',' + tc);
					}
				}
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

/**
 * True when pasting `clip` into a `selRows` x `selCols` selection is a size MISMATCH that must be refused
 * loudly (Excel: "The copy and paste areas are not the same size"). This is exactly the case where a
 * multi-cell COPY is pasted into a selection that is LARGER in some axis but NOT an exact multiple of the
 * block, so it can neither tile cleanly nor be a single block paste. A CUT (move -- selection ignored), a
 * single-cell clip (fills any selection), and a selection that fits the block (<= in both axes, or an exact
 * multiple) are all NOT mismatches. The caller checks this BEFORE {@link planPaste} and shows a visible error
 * instead of silently pasting a partial block (No-Fallbacks).
 */
export function pasteAreaMismatch(clip: GridClipboard, selRows: number, selCols: number): boolean {
	if (clip.isCut) {
		return false; // a CUT is a move: it always lands once at the origin, selection size ignored
	}
	if (clip.rows === 1 && clip.cols === 1) {
		return false; // a single copied cell fills any selection
	}
	const largerR = selRows > clip.rows;
	const largerC = selCols > clip.cols;
	if (!largerR && !largerC) {
		return false; // selection fits within the block in both axes -> paste once at the origin
	}
	const exactR = selRows % clip.rows === 0;
	const exactC = selCols % clip.cols === 0;
	return !(exactR && exactC); // larger in some axis but not an exact tiling -> mismatch
}

/**
 * **W-G fill handle** -- plan the cell writes for extending a source rectangle (`clip`) to fill a larger
 * `fillRows` x `fillCols` rect anchored at the same top-left (the user dragged the fill handle down or
 * right). Returns ONLY the EXTENSION cells (those outside the source); each repeats the source by modular
 * position and offsets a formula's relative refs by its distance from the cell it repeats (Excel COPY-fill:
 * `=A1` filled down becomes `=A2`, `=A3`, ...). A multi-row/col source TILES (the pattern repeats), each
 * tile offset by its cycle distance. v1 cuts (documented): COPY-fill only -- no numeric/date SERIES
 * detection (a single "1" fills "1,1,1", not "1,2,3"); the caller constrains the drag to one axis.
 */
export function planFill(clip: GridClipboard, fillRows: number, fillCols: number): PlannedCell[] {
	const planned: PlannedCell[] = [];
	for (let r = 0; r < fillRows; r += 1) {
		for (let c = 0; c < fillCols; c += 1) {
			if (r < clip.rows && c < clip.cols) {
				continue; // inside the source -- left as-is, not rewritten
			}
			const srcI = r % clip.rows;
			const srcJ = c % clip.cols;
			const srcRow = clip.top + srcI;
			const srcCol = clip.left + srcJ;
			const targetRow = clip.top + r;
			const targetCol = clip.left + c;
			planned.push({
				row: targetRow,
				col: targetCol,
				rawInput: retargetRawInput(clip.cells[srcI][srcJ].rawInput, targetRow - srcRow, targetCol - srcCol),
			});
		}
	}
	return planned;
}
