/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2 BAKEOFF (2026-06-09) -- synthetic dataset generators for the render benchmark.**
 *
 * The bakeoff drives the REAL paint path (`RenderOrchestrator` + `CanvasGridRenderer`) against
 * synthetic `QuantbookCellSnapshot`s standing in for the engine's `queryRange` result -- so we can
 * measure scroll / damage / input frame timings without the engine. These generators are the
 * SYNTHETIC `queryRange`: a snapshot is the populated-cells set for a window; a `snapshotDelta`
 * (below) mutates a few cells to model a commit / recompute. They are PURE (no DOM, no vscode), so
 * they are unit-testable AND the bench's `HOST_RUNTIME_FILTER` never fires.
 *
 * Why windowed (not the whole 50k x 20): the live grid only ever paints the visible window + its
 * lookup map is keyed by (row,col); the bench must measure that same path. So `queryRange` returns
 * ONLY the cells inside the requested row/col window (plus a small overscan), exactly as a real
 * `queryRange` against a sparse sheet would -- a full 1M-cell array would measure JS array
 * allocation, not the renderer. The "logical" extent (rows x cols) is reported separately so the
 * spacer / scrollbars size to the full dataset.
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../../src/quantbook/types';

/** A bakeoff dataset descriptor: the logical extent + how a cell at (row,col) is valued. */
export interface BenchDataset {
	readonly id: string;
	readonly label: string;
	/** Logical row count (drives the spacer height + scroll range). */
	readonly rows: number;
	/** Logical col count (drives the spacer width). */
	readonly cols: number;
	/** Fraction of cells that are POPULATED (0..1). A blank-extent dataset is ~0; dense is 1. */
	readonly density: number;
	/** Value for a populated cell at (row,col). `null` = this cell is blank (unpopulated). */
	valueAt(row: number, col: number): QuantbookCellValue | null;
}

const SHEET = 0;

/** A deterministic pseudo-random in [0,1) from two ints (no Math.random -> reproducible benches). */
function hash01(a: number, b: number): number {
	let h = (a * 73856093) ^ (b * 19349663);
	h = (h ^ (h >>> 13)) >>> 0;
	return (h % 100000) / 100000;
}

/** Build a {@link QuantbookCellSnapshot} for the populated cells inside the [r0,r1) x [c0,c1) window
 * of a dataset (the synthetic `queryRange`). Clamped to the dataset extent. A blank cell (valueAt
 * returns null) contributes no entry -- exactly the sparse shape a real queryRange produces. */
export function queryRange(
	ds: BenchDataset,
	r0: number,
	r1: number,
	c0: number,
	c1: number,
): QuantbookCellSnapshot {
	const rowStart = Math.max(0, Math.min(ds.rows, r0));
	const rowEnd = Math.max(rowStart, Math.min(ds.rows, r1));
	const colStart = Math.max(0, Math.min(ds.cols, c0));
	const colEnd = Math.max(colStart, Math.min(ds.cols, c1));
	const entries: { row: number; col: number; value: QuantbookCellValue }[] = [];
	for (let row = rowStart; row < rowEnd; row += 1) {
		for (let col = colStart; col < colEnd; col += 1) {
			const v = ds.valueAt(row, col);
			if (v !== null) {
				entries.push({ row, col, value: v });
			}
		}
	}
	return { snapshot_format_version: 1, sheet: SHEET, entries };
}

/**
 * Produce a `snapshotDelta`: a copy of `base` with the given cells' values replaced (models a commit
 * or a recompute touching specific cells). Cells outside `base`'s entry set are APPENDED (a newly
 * populated cell). Returns a NEW snapshot (the orchestrator's `diffSnapshotsA1` compares prev vs next
 * by value, so the two snapshots must be distinct objects with the changed values). Pure.
 */
export function snapshotDelta(
	base: QuantbookCellSnapshot,
	changes: readonly { row: number; col: number; value: QuantbookCellValue }[],
): QuantbookCellSnapshot {
	const byKey = new Map<string, { row: number; col: number; value: QuantbookCellValue }>();
	for (const e of base.entries) {
		byKey.set(e.row + ',' + e.col, { row: e.row, col: e.col, value: e.value });
	}
	for (const c of changes) {
		byKey.set(c.row + ',' + c.col, { row: c.row, col: c.col, value: c.value });
	}
	return { snapshot_format_version: 1, sheet: base.sheet, entries: [...byKey.values()] };
}

// --- the bakeoff dataset catalogue (matches the brief's FE-2 list) ---

function numV(value: number): QuantbookCellValue {
	return { kind: 'number', value };
}
function textV(value: string): QuantbookCellValue {
	return { kind: 'text', value };
}

/** Dense 50k x 20 = 1M logical cells, every cell populated with a number. The headline scroll/heap test. */
export const DENSE_50K_20: BenchDataset = {
	id: 'dense-50k-20',
	label: 'Dense 50k x 20 (1M cells, all populated, numeric)',
	rows: 50000,
	cols: 20,
	density: 1,
	valueAt: (row, col) => numV(row * 20 + col),
};

/** Wide 10k x 100 -- tests horizontal scroll + a wide column band. */
export const WIDE_10K_100: BenchDataset = {
	id: 'wide-10k-100',
	label: 'Wide 10k x 100 (1M cells, all populated, numeric)',
	rows: 10000,
	cols: 100,
	density: 1,
	valueAt: (row, col) => numV(row * 100 + col),
};

/** A blank sheet at the full Excel extent -- the empty-grid scroll path (no entries, just gridlines). */
export const BLANK_EXCEL_EXTENT: BenchDataset = {
	id: 'blank-excel-extent',
	label: 'Blank Excel extent (1,048,576 x 16,384, no populated cells)',
	rows: 1048576,
	cols: 16384,
	density: 0,
	valueAt: () => null,
};

/** Text stress -- long strings in every cell (measureText + clamp cost dominates paint). */
export const TEXT_STRESS: BenchDataset = {
	id: 'text-stress',
	label: 'Text stress 20k x 20 (long strings, all populated)',
	rows: 20000,
	cols: 20,
	density: 1,
	valueAt: (row, col) =>
		textV('Lorem ipsum dolor sit amet ' + row + ':' + col + ' consectetur adipiscing elit sed do'),
};

/** Damage stream -- 1k visible populated + 10k offscreen; the bench mutates a random visible cell per
 * frame (models a live recompute). Sparse-ish so the entry set stays realistic. */
export const DAMAGE_STREAM: BenchDataset = {
	id: 'damage-stream',
	label: 'Damage stream 11k x 20 (1k visible + 10k offscreen, mutate per frame)',
	rows: 11000,
	cols: 20,
	density: 0.5,
	valueAt: (row, col) => (hash01(row, col) < 0.5 ? numV(row + col) : null),
};

/** The full catalogue, in the brief's order. */
export const BENCH_DATASETS: readonly BenchDataset[] = [
	DENSE_50K_20,
	WIDE_10K_100,
	BLANK_EXCEL_EXTENT,
	TEXT_STRESS,
	DAMAGE_STREAM,
];
