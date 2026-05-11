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
	/**
	 * When true, the price-scale range is extended to include zero so the
	 * baseline reads naturally on metrics that should anchor to zero
	 * (volumes, PnL, etc). When false (default), the scale auto-fits to
	 * the data range. Mirrors `spec.chart.options.y_axis_zero`.
	 */
	readonly yAxisZero?: boolean;
	readonly theme?: QvizTheme;
}

export interface TimeseriesPlan {
	readonly chart: TimeseriesChartOptions;
	readonly series: readonly TimeseriesSeriesPlan[];
	/** Diagnostics for the caller to inspect / log. Not consumed by Chart. */
	readonly diagnostics: readonly string[];
}

// ---------------------------------------------------------------------------
// general family (Vega-Lite render target)
// ---------------------------------------------------------------------------

/**
 * Hand-rolled subset of the Vega-Lite top-level-spec shape we emit. We do NOT
 * import vega-lite's types directly so that:
 *
 *   1. compileGeneralPlan is pure and has zero npm deps -- testable without
 *      vega-lite installed
 *   2. the spec layer is renderer-agnostic: a future Plotly / observable-plot
 *      adaptor could consume the same plan
 *
 * This is a deliberately narrow shape -- only the fields we actually emit.
 * Vega-Lite ignores unknown top-level fields, and our config block uses
 * Record<string, unknown> for the rich theme/title/legend/axis sub-trees.
 */
export type VegaLiteMarkType =
	| 'line' | 'bar' | 'circle' | 'point' | 'rect' | 'arc' | 'area' | 'square';

export interface VegaLiteMarkObject {
	readonly type: VegaLiteMarkType;
	readonly tooltip?: boolean;
	readonly opacity?: number;
	readonly binSpacing?: number;
}

export type VegaLiteMark = VegaLiteMarkType | VegaLiteMarkObject;

export type VegaLiteEncodingType = 'quantitative' | 'temporal' | 'nominal' | 'ordinal';

export interface VegaLiteFieldDef {
	readonly field: string;
	readonly type: VegaLiteEncodingType;
	readonly title?: string;
	readonly bin?: boolean | { readonly maxbins: number };
	readonly aggregate?: 'count' | 'sum' | 'mean' | 'min' | 'max';
	readonly axis?: { readonly format?: string; readonly title?: string | null } | null;
	readonly scale?: {
		readonly type?: 'linear' | 'log' | 'pow';
		readonly zero?: boolean;
		readonly scheme?: string;
	};
	readonly sort?: 'ascending' | 'descending';
	readonly legend?: null | { readonly title?: string };
	readonly format?: string;
}

export interface VegaLiteEncoding {
	readonly x?: VegaLiteFieldDef;
	readonly y?: VegaLiteFieldDef;
	readonly color?: VegaLiteFieldDef;
	readonly size?: VegaLiteFieldDef;
	readonly shape?: VegaLiteFieldDef;
	readonly row?: VegaLiteFieldDef;
	readonly column?: VegaLiteFieldDef;
	readonly theta?: VegaLiteFieldDef;
	readonly tooltip?: readonly VegaLiteFieldDef[];
}

export interface VegaLiteSpec {
	readonly $schema: string;
	readonly title?: string;
	readonly description?: string;
	readonly width: number | 'container';
	readonly height: number | 'container';
	readonly background?: string;
	readonly autosize?: 'fit' | 'pad' | 'none';
	readonly data: { readonly values: readonly Record<string, unknown>[] };
	readonly mark: VegaLiteMark;
	readonly encoding: VegaLiteEncoding;
	readonly config?: Record<string, unknown>;
}

/** Subset of qviz ChartType valid for the general family. */
export type GeneralChartType = 'line' | 'bar' | 'scatter' | 'heatmap' | 'pie' | 'histogram';

export interface GeneralPlan {
	readonly spec: VegaLiteSpec;
	/** Diagnostics for the caller to inspect / log. Not consumed by Vega. */
	readonly diagnostics: readonly string[];
}
