/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Wave G window sizing (R1, 2026-06-18)** -- the pure, axis-generic sizing model behind variable
 * row heights / column widths. A grid axis (the columns, or -- in the row follow-up wave -- the rows)
 * is UNIFORM by default: every index is `defaultSize` px. A handful of indices may be RESIZED; those
 * carry an entry in {@link AxisSizing.overrides}. The model stores ONLY the resized indices (sparse),
 * so an axis with no resize is byte-identical to the old `index * defaultSize` arithmetic -- the
 * keystone invariant the golden tests pin (mirrors how `splitBarY === 0` is byte-identical to the
 * single-pane path). All forward (index -> px) and inverse (px -> index) math is a prefix-sum +
 * binary search over the sorted override keys, so both directions are O(log k) in the override count
 * `k` (tiny -- a user drags a few borders, never a million).
 *
 * This module is PURE and DOM/vscode-free (the doctrine: all viewport math is unit-reasoned). It is
 * axis-GENERIC -- it operates on a passed {@link AxisSizing} that carries its own `defaultSize`/`count`/
 * `minSize`/`maxSize`, so a column value can never be confused for a row value (each axis owns its own
 * immutable model). The axis-SPECIFIC entry points (`colX` vs `rowY`, etc.) live in `gridLayoutA1.ts`,
 * which binds the right model per axis -- honouring the anti-transposition doctrine there.
 */

/**
 * An immutable, sparse, per-axis sizing model: a uniform `defaultSize` with a small set of resized
 * indices in {@link overrides}. `sortedKeys` + `prefixExtra` are the precomputed acceleration structure
 * (built once at construction, never mutated): `sortedKeys` is the override indices ascending, and
 * `prefixExtra[i]` is the cumulative `(size - defaultSize)` "extra" contributed by the first `i` sorted
 * override keys (so `prefixExtra[0] === 0`, length is `sortedKeys.length + 1`). Construct via
 * {@link emptyAxisSizing} and evolve via {@link withOverride} -- never assemble the fields by hand.
 */
export interface AxisSizing {
	/** Uniform size of a non-overridden index (e.g. `COL_WIDTH`). */
	readonly defaultSize: number;
	/** Number of indices on the axis (e.g. `MAX_COLS`); valid indices are `[0, count)`. */
	readonly count: number;
	/** Inclusive lower clamp for an override size (e.g. `MIN_COL_WIDTH`); a smaller override throws. */
	readonly minSize: number;
	/** Inclusive upper clamp for an override size (e.g. `MAX_COL_WIDTH`); a larger override throws. */
	readonly maxSize: number;
	/** Resized indices only (`index -> px size`); a non-overridden index is `defaultSize`. Canonical:
	 *  an entry equal to `defaultSize` is never stored (so `overrides.size === 0` <=> uniform). */
	readonly overrides: ReadonlyMap<number, number>;
	/** {@link overrides} keys, ascending. The binary-search domain for both directions. */
	readonly sortedKeys: readonly number[];
	/** Prefix sums of `(override - defaultSize)`: `prefixExtra[i]` is the extra from `sortedKeys[0..i-1]`.
	 *  `prefixExtra[0] === 0`; length `sortedKeys.length + 1`. */
	readonly prefixExtra: readonly number[];
}

/** Count of elements in the ascending `arr` strictly less than `target` (= first index `i` with
 *  `arr[i] >= target`). Plain lower-bound binary search; the cumulative-extra lookups key off it. */
function lowerBound(arr: readonly number[], target: number): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/** Build the immutable model + its acceleration structure from a (already-validated) override map.
 *  Internal: callers go through {@link emptyAxisSizing} / {@link withOverride}. */
function build(
	defaultSize: number,
	count: number,
	minSize: number,
	maxSize: number,
	overrides: Map<number, number>,
): AxisSizing {
	const sortedKeys = Array.from(overrides.keys()).sort((a, b) => a - b);
	const prefixExtra: number[] = new Array(sortedKeys.length + 1);
	prefixExtra[0] = 0;
	for (let i = 0; i < sortedKeys.length; i += 1) {
		// Non-null: every sortedKey came from `overrides`.
		const size = overrides.get(sortedKeys[i]) as number;
		prefixExtra[i + 1] = prefixExtra[i] + (size - defaultSize);
	}
	return { defaultSize, count, minSize, maxSize, overrides, sortedKeys, prefixExtra };
}

/**
 * The UNIFORM model for an axis: no overrides, every index is `defaultSize`. Byte-identical to the old
 * scalar arithmetic (`emptyAxisSizing(COL_WIDTH, MAX_COLS, ...)` makes `offsetBefore` reduce to
 * `index * COL_WIDTH`, etc.). Throws (No-Fallbacks) on a nonsensical config -- a corrupt default must
 * fail loud, not silently paint a broken grid.
 */
export function emptyAxisSizing(
	defaultSize: number,
	count: number,
	minSize: number,
	maxSize: number,
): AxisSizing {
	if (!Number.isFinite(defaultSize) || defaultSize <= 0) {
		throw new Error(`AxisSizing: defaultSize must be a positive finite number, got ${defaultSize}`);
	}
	if (!Number.isInteger(count) || count <= 0) {
		throw new Error(`AxisSizing: count must be a positive integer, got ${count}`);
	}
	if (!Number.isFinite(minSize) || !Number.isFinite(maxSize) || minSize <= 0 || maxSize < minSize) {
		throw new Error(`AxisSizing: invalid clamp bounds [${minSize}, ${maxSize}]`);
	}
	if (defaultSize < minSize || defaultSize > maxSize) {
		throw new Error(`AxisSizing: defaultSize ${defaultSize} outside clamp bounds [${minSize}, ${maxSize}]`);
	}
	return build(defaultSize, count, minSize, maxSize, new Map());
}

/**
 * Return a NEW model with index `index` set to `size` px (the old model is untouched -- value
 * semantics). Setting `size === defaultSize` REMOVES the override (canonical form: uniform <=>
 * `overrides.size === 0`), so a drag back to the default width clears the entry. Throws (No-Fallbacks)
 * on a malformed index or an out-of-clamp size: a bad value crossing the host->webview wire must never
 * silently corrupt the geometry (unlike a frozen count, a 0/negative size has no safe sentinel).
 */
export function withOverride(s: AxisSizing, index: number, size: number): AxisSizing {
	if (!Number.isInteger(index) || index < 0 || index >= s.count) {
		throw new Error(`AxisSizing.withOverride: index ${index} out of extent [0, ${s.count})`);
	}
	const next = new Map(s.overrides);
	if (size === s.defaultSize) {
		next.delete(index);
	} else {
		if (!Number.isFinite(size) || size < s.minSize || size > s.maxSize) {
			throw new Error(`AxisSizing.withOverride: size ${size} outside clamp bounds [${s.minSize}, ${s.maxSize}]`);
		}
		next.set(index, size);
	}
	return build(s.defaultSize, s.count, s.minSize, s.maxSize, next);
}

/** The px size of one index: its override, or `defaultSize`. O(1). */
export function sizeAt(s: AxisSizing, index: number): number {
	return s.overrides.get(index) ?? s.defaultSize;
}

/**
 * The cumulative px offset of the LEADING edge of `index` -- i.e. the summed sizes of indices
 * `[0, index)`. The band/gutter offset is NOT included (the caller adds `HEADER_HEIGHT` / `gutterW`,
 * exactly as the legacy `rowY`/`colX` do). `offsetBefore(s, count)` is the total extent. Valid for
 * `index` in `[0, count]`. O(log k): `index * defaultSize` plus the cumulative extra of every override
 * key `< index` (a `prefixExtra` lookup at the lower-bound of `index`). Empty model => `index * defaultSize`.
 */
export function offsetBefore(s: AxisSizing, index: number): number {
	return index * s.defaultSize + s.prefixExtra[lowerBound(s.sortedKeys, index)];
}

/** Total scrollable extent of the axis = summed sizes of all `count` indices. Empty => `count * defaultSize`. */
export function totalExtent(s: AxisSizing): number {
	return offsetBefore(s, s.count);
}

/**
 * The inverse of {@link offsetBefore}: the index whose cell CONTAINS the content offset `offsetPx`
 * (the caller has already subtracted the band/gutter). Returns the largest `index` in `[0, count)` whose
 * leading edge is `<= offsetPx` for an in-range `offsetPx`, and EXTRAPOLATES with `defaultSize` outside
 * `[0, totalExtent)` so an out-of-grid pixel yields an out-of-extent index (`< 0` or `>= count`) that the
 * caller's `isInExtent` rejects -- exactly the legacy `Math.floor((px) / size)` behaviour. Empty model =>
 * `Math.floor(offsetPx / defaultSize)` for every `offsetPx`. O(log count * log k).
 */
export function indexAtOffset(s: AxisSizing, offsetPx: number): number {
	if (offsetPx < 0) {
		// Negative: extrapolate below row 0 (caller's isInExtent rejects). Matches floor(neg/size).
		return Math.floor(offsetPx / s.defaultSize);
	}
	const total = totalExtent(s);
	if (offsetPx >= total) {
		// Past the last cell: uniform default spacing resumes, so extrapolate (>= count -> out of extent).
		return s.count + Math.floor((offsetPx - total) / s.defaultSize);
	}
	// In [0, total): binary-search the largest index whose leading edge is <= offsetPx.
	let lo = 0;
	let hi = s.count - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offsetBefore(s, mid) <= offsetPx) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}
