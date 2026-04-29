/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Render-side types for the qviz module.
 *
 * The @charts-plus library is the underlying renderer, but we deliberately
 * keep our render types decoupled so we can also target Vega-Lite (general
 * family) without leaking @charts-plus types into the spec layer.
 *
 * The flow is:
 *
 *   QvizSpec (validated) + ColumnData (extracted from Arrow IPC)
 *        |
 *        v   compileTimeseriesPlan(spec, columns, theme)
 *        |
 *   TimeseriesPlan (pure description; no DOM, no Chart instance)
 *        |
 *        v   applyTimeseriesPlan(container, plan)
 *        |
 *   Chart (running on canvas, ready to interact)
 *
 * compileTimeseriesPlan is pure -> trivially unit-testable without a DOM.
 */

/**
 * Time in milliseconds since Unix epoch -- the unit @charts-plus consumes.
 * Different from the ns timestamps the daemon returns; we convert in the
 * column extractor.
 */
export type TimeMs = number;

/**
 * One entry in the data dict passed to compileTimeseriesPlan.
 * Keys are column names; values are typed arrays or plain arrays of values.
 *
 * For temporal columns: must be milliseconds-since-epoch (number) -- the
 * extractor handles the unit conversion.
 */
export type ColumnData = Record<string, ArrayLike<number | null> | ArrayLike<string>>;

// --- @charts-plus-shaped result types ---

export interface DataPointMs {
	readonly t: TimeMs;
	readonly v: number | null;
}

export interface OhlcDataPointMs {
	readonly t: TimeMs;
	readonly o: number;
	readonly h: number;
	readonly l: number;
	readonly c: number;
}

// --- the plan ---

export type TimeseriesSeriesPlan =
	| LinePlan
	| AreaPlan
	| BarPlan
	| HistogramPlan
	| BaselinePlan
	| CandlestickPlan;

export interface LinePlan {
	readonly kind: 'line';
	readonly id: string;
	readonly title?: string;
	readonly color?: string;
	readonly data: readonly DataPointMs[];
}

export interface AreaPlan {
	readonly kind: 'area';
	readonly id: string;
	readonly title?: string;
	readonly color?: string;
	readonly data: readonly DataPointMs[];
}

export interface BarPlan {
	readonly kind: 'bar';
	readonly id: string;
	readonly title?: string;
	readonly color?: string;
	readonly data: readonly DataPointMs[];
}

export interface HistogramPlan {
	readonly kind: 'histogram';
	readonly id: string;
	readonly title?: string;
	readonly color?: string;
	readonly data: readonly DataPointMs[];
}

export interface BaselinePlan {
	readonly kind: 'baseline';
	readonly id: string;
	readonly title?: string;
	readonly color?: string;
	readonly baseValue?: number;
	readonly data: readonly DataPointMs[];
}

export interface CandlestickPlan {
	readonly kind: 'candlestick';
	readonly id: string;
	readonly title?: string;
	readonly data: readonly OhlcDataPointMs[];
}

/**
 * Theme tokens -- minimal subset of @charts-plus's `ThemeTokens`. We don't
 * import directly to keep the spec layer free of charts-plus dependencies.
 */
export interface QvizTheme {
	readonly background: string;
	readonly foreground: string;
	readonly grid: string;
	readonly axisText: string;
	readonly seriesPalette: readonly string[];
	readonly upColor?: string;
	readonly downColor?: string;
}

export interface TimeseriesChartOptions {
	readonly timezone?: string;
	readonly autoSize?: boolean;
	readonly width?: number;
	readonly height?: number;
	readonly showGrid?: boolean;
	readonly theme?: QvizTheme;
}

export interface TimeseriesPlan {
	readonly chart: TimeseriesChartOptions;
	readonly series: readonly TimeseriesSeriesPlan[];
	/** Diagnostics for the caller to inspect / log. Not consumed by Chart. */
	readonly diagnostics: readonly string[];
}
