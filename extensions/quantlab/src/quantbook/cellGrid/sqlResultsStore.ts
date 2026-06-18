/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-6 / R18 Wave E (2026-06-18) -- the vscode-free, headlessly-testable store for the SQL-query
// sidebar's result badge.
//
// WHY A SEPARATE STORE (R1): the reactive-Python publish badge ({@link PublishedCellsStore}) is owned
// per {@link ReactiveKernelClient}, so the reactive-kernel manager returns `[]` for any session with NO
// live Python kernel (`reactiveKernelManager.ts` `publishedCellsForSheet`). Routing the SQL badge through
// that store would make SQL results badge-able ONLY when a Python kernel happens to be running. The SQL
// cell must work standalone, so it gets its own per-session store, unioned into the render's
// `publishedCells` set in `cellGridPanel.ts` exactly where the kernel store is. The webview already
// paints ANY {@link PublishedRange} rect as a corner badge -- no webview change.
//
// Correctness model (latest-wins by query id): the SQL sidebar uses ONE stable `queryId` per session, so
// `recordPublish(queryId, range)` RELOCATES the single badge when a re-run targets a new range (and a
// re-run to a new sheet moves it off the old sheet -- exactly `PublishedCellsStore`'s model). `rangeFor`
// (which `PublishedCellsStore` lacks) lets the materialise path read the PRIOR target so it can clear the
// orphan cells a moved/shrunk re-run would otherwise leave behind.

import type { CellRangeJson } from '../types';
import type { PublishedRange } from '../reactiveKernel/publishedCellsStore';

/**
 * Tracks, per grid session, the cell range each SQL query currently materialises into (latest-wins by
 * `queryId`). One instance is owned per `SessionInstance` by `cellGridPanel.ts` and cleared when the
 * session closes. vscode-free + napi-free so it unit-tests headlessly.
 */
export class SqlResultsStore {
	// queryId -> its current materialised target range (latest-wins). A range carries its sheet.
	private readonly byId = new Map<string, CellRangeJson>();

	/**
	 * Record (or relocate) the range a query materialised into. Latest-wins: re-running `id` into a new
	 * range replaces the old one, so a moved target clears the old cell's badge and marks the new one.
	 * Stores a shallow copy so a later mutation of the caller's range cannot corrupt the store.
	 */
	recordPublish(id: string, range: CellRangeJson): void {
		this.byId.set(id, {
			sheet: range.sheet,
			startRow: range.startRow,
			startCol: range.startCol,
			endRow: range.endRow,
			endCol: range.endCol,
		});
	}

	/**
	 * The range `id` currently materialises into, or `undefined` if it has never run. Returns a COPY so a
	 * caller (the orphan-clear path reading the PRIOR target before re-recording) cannot mutate the store.
	 */
	rangeFor(id: string): CellRangeJson | undefined {
		const r = this.byId.get(id);
		return r === undefined
			? undefined
			: { sheet: r.sheet, startRow: r.startRow, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol };
	}

	/** Drop a query (the "Clear results" gesture). Returns `true` iff an entry was removed (drives a repaint). */
	remove(id: string): boolean {
		return this.byId.delete(id);
	}

	/** Drop everything (teardown / explicit reset). */
	clear(): void {
		this.byId.clear();
	}

	/** Number of distinct queries tracked (test/diagnostic aid). */
	get size(): number {
		return this.byId.size;
	}

	/**
	 * The materialised ranges that fall on `sheet`, in the host->webview {@link PublishedRange} wire shape
	 * (so they union directly with the reactive-kernel badge set at the render point). The `name` carried
	 * is the `queryId`. Iteration follows Map insertion order; callers treat the result as an unordered set.
	 */
	rangesForSheet(sheet: number): PublishedRange[] {
		const out: PublishedRange[] = [];
		for (const [id, range] of this.byId) {
			if (range.sheet === sheet) {
				out.push({
					startRow: range.startRow,
					startCol: range.startCol,
					endRow: range.endRow,
					endCol: range.endCol,
					name: id,
				});
			}
		}
		return out;
	}
}
