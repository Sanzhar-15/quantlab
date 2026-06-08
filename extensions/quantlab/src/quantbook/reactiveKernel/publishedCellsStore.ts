/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G -- the vscode-free core of the "bound-cell indicator".
//
// A cell is BOUND iff it is the current target of a live reactive publish, as last asserted by the
// kernel. The ReactiveKernelClient applies every republish frame at one chokepoint (applyRepublish),
// where it knows the published variable NAME and the resolved target RANGE -- so the host can track
// which cells a published variable drives with NO engine change. This store holds that mapping and
// hands the per-sheet ranges to a CellGridPanel, which forwards them to its Canvas2D webview to paint
// a small corner badge.
//
// Correctness model (latest-wins by variable name):
//   - recordPublish(name, range): the variable now drives `range` (a moved target relocates the badge).
//   - markStale(name): the kernel marked the variable stale (deleted/undefined) -> it drives nothing.
//   - clear(): used on teardown; a fresh client/reseed repopulates as cells re-run.
// A G3-refused republish (the host declined to overwrite a user FORMULA) is never recorded -- the
// client only calls recordPublish AFTER a publish actually lands. Owner notebook-cell attribution is
// deferred (the republish frame drops owner_cell_id); the badge means "reactively driven", keyed by
// the variable name.
//
// vscode-free (type-only import) so it compiles in the extension AND is unit-tested headlessly.

import type { CellRangeJson } from '../types';

/**
 * One published target on a single sheet, in the host->webview wire shape. Coordinates are 0-based and
 * INCLUSIVE (mirroring CellRangeJson); v1 publishes are single cells (start === end). `name` is the
 * driving variable, carried for a future hover/name surface (v1 paints a marker only).
 */
export interface PublishedRange {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
	name: string;
}

/**
 * Tracks, per reactive session, which cells each published variable currently drives. One instance is
 * owned by each {@link ReactiveKernelClient} (the manager keys clients by session), so the store's
 * lifetime is exactly the kernel's: it dies with the client on dispose and a reseed repopulates it.
 */
export class PublishedCellsStore {
	// variable name -> its current published target range (latest-wins). A range carries its sheet.
	private readonly byName = new Map<string, CellRangeJson>();

	/**
	 * Record (or relocate) the target a published variable drives. Latest-wins: re-publishing `name` to a
	 * new range replaces the old one, so a moved target clears the old cell's badge and marks the new one.
	 * Stores a shallow copy so a later mutation of the caller's range object cannot corrupt the store.
	 */
	recordPublish(name: string, range: CellRangeJson): void {
		this.byName.set(name, {
			sheet: range.sheet,
			startRow: range.startRow,
			startCol: range.startCol,
			endRow: range.endRow,
			endCol: range.endCol,
		});
	}

	/**
	 * Drop a variable that the kernel marked STALE (deleted/undefined -- it no longer publishes). Returns
	 * `true` iff an entry was actually removed, so the caller can decide whether a repaint is needed (a
	 * stale-only op changes no cell data but must still clear the badge).
	 */
	markStale(name: string): boolean {
		return this.byName.delete(name);
	}

	/** Drop all tracked publishes (teardown / explicit reset). */
	clear(): void {
		this.byName.clear();
	}

	/** Number of distinct published variables tracked (test/diagnostic aid). */
	get size(): number {
		return this.byName.size;
	}

	/**
	 * The published ranges that fall on `sheet`, in wire shape. A CellGridPanel renders ONE sheet, so it
	 * asks only for its own sheet's ranges (a two-sheet workbook shows each sheet's own badges). Iteration
	 * order follows Map insertion order; callers treat the result as an unordered set.
	 */
	rangesForSheet(sheet: number): PublishedRange[] {
		const out: PublishedRange[] = [];
		for (const [name, range] of this.byName) {
			if (range.sheet === sheet) {
				out.push({
					startRow: range.startRow,
					startCol: range.startCol,
					endRow: range.endRow,
					endCol: range.endCol,
					name,
				});
			}
		}
		return out;
	}
}
