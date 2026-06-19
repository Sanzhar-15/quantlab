/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// **Wave G3b / R4 (2026-06-19)** -- the vscode-free core of the Cell Grid AutoFilter. The IDE renders a
// header filter-triangle per column over the toggled used range; clicking it opens a checkbox value-list
// whose result drives the engine `setRowsHidden`/`getHiddenRows` substrate (Wave G2) -- the same pipe the
// Wave-G3a collapsing renderer already consumes (a hidden row paints at height 0). This module owns the four
// pure computations so WHICH rows the filter hides is unit-tested independently of the vscode shell (the host
// CellGridPanel is the thin wrapper, mirroring rowVisibilityLogic.ts for the right-click Hide/Unhide).
//
// **The crux -- filter-hidden vs manually-hidden.** The engine has ONE un-provenanced `hidden_rows` set per
// sheet: it does NOT distinguish a row hidden by the right-click Hide (G3a) from a filter-hidden row. The host
// keeps a transient `filterHidden` set = the rows the CURRENT criteria hide, and reconciles against the LIVE
// engine set via {@link reconcileHidden}: `toUnhide = (fOld \ fNew) intersect live` is `subset of fOld` by construction, so
// the filter NEVER unhides a row it did not hide -- manual hides `M = live \ fOld` are structurally untouched.
//
// **The matching invariant.** Value enumeration ({@link distinctValuesInColumn}) and the hide computation
// ({@link computeFilterHidden}) MUST key on the SAME display string, or an unchecked value silently fails to
// hide its rows. Both route through {@link displayStringOf} -- the single `rendered ?? formatCellValue(value)`
// source (the full, untruncated display text Excel filters on), reusing the host `formatCellValue` so the
// host's render and the filter agree byte-for-byte. No-Fallbacks: a blank-in-column row (no entry, MVP) is
// simply absent from the value list and is never filter-hidden by that column -- a documented MVP semantic,
// NOT a masking fallback (the "(Blanks)" checkbox is deferred to v1.5).

import type { QuantbookCellValue } from '../types';
import { formatCellValue } from './cellGridHtml';

/** The A1 grid extents (mirror gridLayoutA1; declared locally to keep this module vscode/webview-free,
 *  matching rowVisibilityLogic/sortLogic). Valid rows `[0, A1_MAX_ROWS)`, cols `[0, A1_MAX_COLS)`. */
const A1_MAX_ROWS = 1_048_576;
const A1_MAX_COLS = 16_384;

/**
 * The minimal cell shape the filter reads -- a structural subset of `QuantbookCellSnapshot.entries[]`, so the
 * host can pass `latestSnapshot.entries` directly (the extra optional fields are assignable away). Pure data.
 */
export interface FilterCellEntry {
	readonly row: number;
	readonly col: number;
	readonly value: QuantbookCellValue;
	/** The engine-pre-rendered formatted string (mirrors the snapshot's `rendered`); `undefined` => format
	 *  via {@link formatCellValue}. The filter keys on the resolved display text via {@link displayStringOf}. */
	readonly rendered?: string;
}

/** The inclusive used-range rectangle AutoFilter covers. The HEADER row is `minRow` (never filter-hideable);
 *  the DATA rows are `[minRow + 1, maxRow]`. */
export interface FilterRange {
	readonly minRow: number;
	readonly maxRow: number;
	readonly minCol: number;
	readonly maxCol: number;
}

/** Per-column EXCLUDED (unchecked) display values. A column absent from the map -- or mapped to an empty set
 *  -- is unfiltered. Keyed on the {@link displayStringOf} text. */
export type FilterCriteria = ReadonlyMap<number, ReadonlySet<string>>;

/** The diff that drives the engine: rows to hide, rows to unhide. Both ascending. */
export interface HiddenReconcile {
	readonly toHide: number[];
	readonly toUnhide: number[];
}

/**
 * The single display-string source of truth -- `rendered` if the engine pre-formatted it, else
 * {@link formatCellValue} (the SAME host formatter the render uses). Enumeration AND the hide computation key
 * on THIS so an unchecked value reliably hides its rows (the matching invariant). The full value, NOT the
 * width-truncated paint string. Pure.
 */
export function displayStringOf(entry: FilterCellEntry): string {
	return entry.rendered ?? formatCellValue(entry.value);
}

/**
 * The bounding box of all entries (the AutoFilter used range), or `null` when the sheet has no entries (an
 * empty sheet -- toggle ON must no-op). Coordinates come from the engine snapshot (already in-extent); the
 * clamp is defence-in-depth so a malformed entry can never push the range outside the A1 grid. Pure.
 */
export function usedRangeFromEntries(entries: ReadonlyArray<FilterCellEntry>): FilterRange | null {
	let minRow = Infinity;
	let maxRow = -Infinity;
	let minCol = Infinity;
	let maxCol = -Infinity;
	for (const e of entries) {
		if (e.row < minRow) { minRow = e.row; }
		if (e.row > maxRow) { maxRow = e.row; }
		if (e.col < minCol) { minCol = e.col; }
		if (e.col > maxCol) { maxCol = e.col; }
	}
	if (!Number.isFinite(minRow)) {
		return null; // no entries
	}
	return {
		minRow: Math.max(0, Math.min(minRow, A1_MAX_ROWS - 1)),
		maxRow: Math.max(0, Math.min(maxRow, A1_MAX_ROWS - 1)),
		minCol: Math.max(0, Math.min(minCol, A1_MAX_COLS - 1)),
		maxCol: Math.max(0, Math.min(maxCol, A1_MAX_COLS - 1)),
	};
}

/**
 * Numeric-aware ascending compare for the value list: parseable numbers sort numerically and BEFORE text
 * (Excel canon), text sorts lexicographically. Display strings the engine formats (e.g. `"$1,234.56"`) that
 * do not parse as a bare number fall to the text branch -- acceptable for the MVP value list. Pure.
 */
function compareDisplayValues(a: string, b: string): number {
	const na = Number(a);
	const nb = Number(b);
	const aNum = a.trim().length > 0 && Number.isFinite(na);
	const bNum = b.trim().length > 0 && Number.isFinite(nb);
	if (aNum && bNum) {
		return na - nb;
	}
	if (aNum) { return -1; }
	if (bNum) { return 1; }
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The distinct display values in `col` over the DATA rows `[dataMinRow, dataMaxRow]` (the header row is
 * excluded by the caller passing `filterRange.minRow + 1`). Deduped + numeric-aware sorted. Blank-in-column
 * rows (no entry) are NOT listed -- the "(Blanks)" checkbox is deferred to v1.5; such a row always passes this
 * column (see {@link computeFilterHidden}). Pure.
 */
export function distinctValuesInColumn(
	entries: ReadonlyArray<FilterCellEntry>,
	col: number,
	dataMinRow: number,
	dataMaxRow: number,
): string[] {
	const seen = new Set<string>();
	for (const e of entries) {
		if (e.col === col && e.row >= dataMinRow && e.row <= dataMaxRow) {
			seen.add(displayStringOf(e));
		}
	}
	return Array.from(seen).sort(compareDisplayValues);
}

/**
 * The rows the filter hides: a DATA row `[minRow + 1, maxRow]` is hidden iff it FAILS ANY filtered column --
 * i.e. its display value in that column is in the column's excluded set. (Cross-column AND for VISIBILITY: a
 * row is visible iff every filtered column's value is checked; hidden iff some filtered column's value is
 * unchecked.) The header row (`filterRange.minRow`) is never hidden. A blank-in-column row contributes no
 * entry, so it never matches an excluded value -- it passes that column (MVP "(Blanks)" deferral). Pure.
 */
export function computeFilterHidden(
	entries: ReadonlyArray<FilterCellEntry>,
	filterRange: FilterRange,
	criteria: FilterCriteria,
): Set<number> {
	const hidden = new Set<number>();
	const dataMinRow = filterRange.minRow + 1;
	for (const e of entries) {
		if (e.row < dataMinRow || e.row > filterRange.maxRow) {
			continue;
		}
		const excluded = criteria.get(e.col);
		if (excluded === undefined || excluded.size === 0) {
			continue;
		}
		if (excluded.has(displayStringOf(e))) {
			hidden.add(e.row);
		}
	}
	return hidden;
}

/**
 * The diff that drives the engine `setRowsHidden`: `toHide = fNew \ live`, `toUnhide = (fOld \ fNew) intersect live`.
 * `live` is the engine's CURRENT `getHiddenRows` (read fresh, never cached). **`toUnhide subset of fOld` by
 * construction**, so the filter never unhides a row it did not hide -- manual hides `M = live \ fOld` are
 * structurally untouched. Intersecting with `live` also drops a previously-filter-hidden row the engine
 * already revealed (e.g. via undo), so the diff is self-correcting. Both arrays ascending. Pure.
 */
export function reconcileHidden(
	fOld: ReadonlySet<number>,
	fNew: ReadonlySet<number>,
	live: ReadonlyArray<number>,
): HiddenReconcile {
	const liveSet = new Set(live);
	const toHide: number[] = [];
	for (const r of fNew) {
		if (!liveSet.has(r)) {
			toHide.push(r);
		}
	}
	const toUnhide: number[] = [];
	for (const r of fOld) {
		if (!fNew.has(r) && liveSet.has(r)) {
			toUnhide.push(r);
		}
	}
	toHide.sort((a, b) => a - b);
	toUnhide.sort((a, b) => a - b);
	return { toHide, toUnhide };
}

/**
 * The next `filterHidden` after a reconcile -- the rows the filter actually OWNS (caused to be hidden and
 * still wants hidden), NOT the rows it merely WANTS hidden (`fNew`). **This distinction is load-bearing:** if
 * the filter recorded `fNew`, it would claim a row that was ALREADY hidden (manually) and whose value happens
 * to match the criteria -- then toggling the filter off would unhide that manual row (the 5-lane-audit HIGH).
 * A row is filter-owned iff the filter JUST hid it (`toHide`), or it was already filter-owned (`fOld`), still
 * wanted (`fNew`), and still hidden (`live`). Intersecting with `live` also drops any phantom (an externally
 * revealed row) without relying on {@link pruneToLive}. Pure.
 */
export function nextFilterHidden(
	fOld: ReadonlySet<number>,
	fNew: ReadonlySet<number>,
	live: ReadonlyArray<number>,
	toHide: ReadonlyArray<number>,
): Set<number> {
	const liveSet = new Set(live);
	const next = new Set<number>(toHide); // rows this reconcile just hid -> filter-owned
	for (const r of fOld) {
		if (fNew.has(r) && liveSet.has(r)) {
			next.add(r); // previously filter-owned, still wanted + still hidden
		}
	}
	return next;
}

/**
 * Render-time self-heal for the host `filterHidden` mirror: keep only the rows the engine STILL hides
 * (`filterHidden intersect live`). Undo/redo (or collab, or a manual Unhide) can reveal a filter-hidden row without
 * calling back into filter state, leaving a phantom in `fOld` that a later reconcile could mis-attribute. The
 * host calls this every render while AutoFilter is active so the virtual partition can never drift. Pure.
 */
export function pruneToLive(filterHidden: ReadonlySet<number>, live: ReadonlyArray<number>): Set<number> {
	const liveSet = new Set(live);
	const pruned = new Set<number>();
	for (const r of filterHidden) {
		if (liveSet.has(r)) {
			pruned.add(r);
		}
	}
	return pruned;
}
