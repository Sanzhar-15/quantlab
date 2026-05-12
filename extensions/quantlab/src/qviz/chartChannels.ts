/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chart-type → channel configuration. Phase 5 step F.1.
 *
 * Single source of truth for the UI's "which encoding shelves are
 * available for the current chart type, and which are required".
 * Mirrors the COMPILER's per-chart-type required-encoding constraints:
 *
 *   - `src/qviz/render/timeseries.ts:compileScalarSeries` enforces
 *     x AND y for line/area/bar/histogram/baseline.
 *   - `src/qviz/render/timeseries.ts:compileCandlestickPlan` enforces
 *     the OHLCV cluster.
 *   - `src/qviz/render/general.ts:buildEncoding` enforces x AND y for
 *     cartesian general charts (scatter/line/bar/histogram).
 *   - `src/qviz/render/general.ts:buildPieEncoding` enforces color
 *     AND y.
 *   - `src/qviz/render/general.ts:buildHeatmapEncoding` enforces
 *     x AND y AND color.
 *
 * Drift between this table and the compilers means the UI lets the user
 * build a spec that compiles to nothing -- exactly the worst-case failure
 * the Phase 5 plan calls out.
 *
 * Note (2026-05-11): the validator USED to enforce these completeness
 * rules too, but was relaxed to allow intermediate column-drag states
 * to round-trip through `edit.spec` without toasting users mid-build.
 * Completeness enforcement now lives entirely in the compiler layer
 * named above.
 *
 * Required vs optional:
 *   - `required`: the compiler rejects a spec missing this channel for
 *     this chart type. UI marks the shelf with an asterisk and reflects
 *     "(required)" status.
 *   - `optional`: the compiler accepts the spec without this channel.
 *     UI shows the shelf but doesn't gate on it.
 *
 * Candlestick is structurally different (uses an OHLCV cluster) and is
 * excluded from the regular-shelves table; the UI swaps to a dedicated
 * OhlcvShelf when chart.type === 'candlestick'.
 */

import type { ChartType } from './spec';

export type RegularChannel =
	| 'x' | 'y' | 'y2'
	| 'color' | 'size' | 'shape'
	| 'facet_row' | 'facet_col';

export interface ChartChannelConfig {
	readonly required: readonly RegularChannel[];
	readonly optional: readonly RegularChannel[];
}

/** Per-chart-type channel availability + requirements. Candlestick
 *  doesn't appear (it's the OHLCV cluster). */
export const CHART_CHANNELS: Record<Exclude<ChartType, 'candlestick'>, ChartChannelConfig> = {
	line: {
		required: ['x', 'y'],
		optional: ['y2', 'color', 'facet_row', 'facet_col'],
	},
	area: {
		required: ['x', 'y'],
		optional: ['y2', 'color', 'facet_row', 'facet_col'],
	},
	bar: {
		required: ['x', 'y'],
		optional: ['color', 'facet_row', 'facet_col'],
	},
	histogram: {
		// Smoke-test fix (2026-05-11): histogram MUST list `y` in required.
		// The compiler (src/qviz/render/timeseries.ts:compileScalarSeries)
		// rejects any spec without both x and y, so leaving `y` off the
		// channel table made the UI hide the y shelf -- users dropped a
		// column on x, switched chart-type to histogram, then got
		// "histogram chart requires encodings.x and encodings.y" with no
		// way to fix it from the builder. The renderer side treats
		// histogram as a bar with no gaps; users are expected to feed it
		// a pre-counted column (e.g. via a bin + groupby + count
		// transform chain) on y, same as a bar chart.
		required: ['x', 'y'],
		optional: ['color', 'facet_row', 'facet_col'],
	},
	baseline: {
		required: ['x', 'y'],
		optional: ['color'],
	},
	scatter: {
		required: ['x', 'y'],
		optional: ['color', 'size', 'shape', 'facet_row', 'facet_col'],
	},
	heatmap: {
		required: ['x', 'y', 'color'],
		optional: ['facet_row', 'facet_col'],
	},
	pie: {
		// Smoke-test fix (2026-05-11): pie MUST list `y` in required.
		// The compiler (src/qviz/render/general.ts:buildPieEncoding, ~L259)
		// hard-rejects any spec without both `color` (slice category) AND
		// `y` (slice angle / theta). Listing `y` as optional made the UI
		// hide its mandatory state -- users assigned color, watched the
		// preview throw "pie chart requires encodings.y for slice angle"
		// and had no shelf-state signal pointing them at y.
		// Same root cause as the histogram fix above.
		// Pie has no x channel (geometry doesn't need it).
		required: ['color', 'y'],
		optional: [],
	},
};

/** Channels offered for `chart.type` in the UI's "Assign to..." menu
 *  and as shelves in the encoding area. Returns empty for candlestick
 *  (its OHLCV cluster is handled separately). */
export function channelsForChartType(t: ChartType): readonly RegularChannel[] {
	if (t === 'candlestick') { return []; }
	const cfg = CHART_CHANNELS[t];
	return [...cfg.required, ...cfg.optional];
}

/** True if `channel` is a required (compiler-gated) input for `chart.type`. */
export function isChannelRequired(t: ChartType, channel: RegularChannel): boolean {
	if (t === 'candlestick') { return false; }
	return CHART_CHANNELS[t].required.includes(channel);
}

/** Display labels for the shelves and menu items. */
export const CHANNEL_LABELS: Record<RegularChannel, string> = {
	x: 'X axis',
	y: 'Y axis',
	y2: 'Y₂ axis',
	color: 'Color',
	size: 'Size',
	shape: 'Shape',
	facet_row: 'Facet (rows)',
	facet_col: 'Facet (cols)',
};
