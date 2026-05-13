/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canonical Quantlab Visualisation Spec (.qviz.json) -- schema v1.
 *
 * Designed as Quantlab-owned (NOT Vega-Lite). Compiled to one of two renderers
 * at load time based on `chart.family`:
 *   - timeseries → @charts-plus
 *   - general    → Vega-Lite (lazy-loaded)
 *
 * Persistence rules:
 *   - Always workspace-relative paths (never absolute, never outside workspace)
 *   - Always include provenance (dataset/query/tool hashes for auditability)
 *   - Forward-compatible: unknown optional fields preserved on round-trip
 *
 * See `examples/` for concrete specs and `validate.ts` for runtime validation.
 */

import type { ExprAst } from './exprAst';

// --- top-level ----------------------------------------------------------------

export const QVIZ_SCHEMA_VERSION = 1 as const;

export interface QvizSpec {
	readonly $schema?: string;
	readonly qviz_version: typeof QVIZ_SCHEMA_VERSION;
	readonly title?: string;
	readonly description?: string;

	readonly dataset: DatasetRef;
	readonly transforms: readonly Transform[];
	readonly chart: ChartConfig;
	readonly trading_options?: TradingOptions;
	readonly provenance: Provenance;
}

// --- dataset -------------------------------------------------------------------

export interface DatasetRef {
	/** Workspace-relative POSIX path. Validated to be inside workspace at load time. */
	readonly uri: string;
	/** SHA-256 of pyarrow schema string. Used to invalidate caches when columns change. */
	readonly schema_hash: string;
	/** File mtime in nanoseconds. Fast pre-check before re-hashing schema. */
	readonly mtime_ns: number;
	/** Hint only; not authoritative. Renderer may use for routing decisions. */
	readonly row_count?: number;
}

// --- transforms (ordered pipeline) -------------------------------------------

export type Transform =
	| FilterTransform
	| DateTruncTransform
	| BinTransform
	| GroupByTransform
	| AggregateTransform
	| WindowTransform
	| MathTransform
	| ResampleTransform
	| TzConvertTransform
	| SortTransform
	| LimitTransform
	| ExprTransform;

export type TransformKind = Transform['kind'];

export interface FilterTransform {
	readonly kind: 'filter';
	readonly column: string;
	/** Phase 6 added `contains` for the inspector's text-filter widget;
	 *  it compiles to a case-insensitive LIKE on `lower(CAST(col AS VARCHAR))`. */
	readonly op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not_in' | 'is_null' | 'not_null' | 'contains';
	/** Megaudit D8 (2026-05-13): the IN/NOT_IN value array can now
	 *  carry `null` so set filters over nullable columns correctly
	 *  include SQL NULL rows. Daemon splits null out of the array
	 *  and emits `IS NULL OR col IN (...)`. Strings widened to
	 *  include null too (boolean already implied by other filter
	 *  kinds; here we keep them aligned). */
	readonly value?:
		| string | number | boolean
		| readonly (string | number | boolean | null)[]
		| null;
}

export interface DateTruncTransform {
	readonly kind: 'date_trunc';
	readonly column: string;
	readonly unit: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
	readonly as: string;
}

export interface BinTransform {
	readonly kind: 'bin';
	readonly column: string;
	readonly n_bins: number;
	readonly strategy?: 'equal_width' | 'equal_freq';
	readonly as: string;
}

export interface GroupByTransform {
	readonly kind: 'groupby';
	readonly columns: readonly string[];
}

export interface AggregateTransform {
	readonly kind: 'aggregate';
	readonly aggs: readonly AggregationOp[];
}

export interface AggregationOp {
	readonly column: string;
	readonly fn: 'sum' | 'mean' | 'median' | 'min' | 'max' | 'count' | 'std' | 'first' | 'last';
	readonly as: string;
}

export interface WindowTransform {
	readonly kind: 'window';
	readonly column: string;
	readonly fn: 'rolling_mean' | 'rolling_std' | 'rolling_max' | 'rolling_min' | 'ema' | 'cumsum' | 'cumprod' | 'cummax' | 'cummin';
	readonly window?: number;
	/** Column to ORDER BY in the window frame. REQUIRED — every window
	 *  function is order-dependent, and the previous "no ORDER BY"
	 *  compilation silently mixed rows in parquet scan order. (Megaudit
	 *  Theme A A1, 2026-05-13.) */
	readonly order_by: string;
	readonly as: string;
}

export interface MathTransform {
	readonly kind: 'math';
	readonly column: string;
	readonly fn: 'log' | 'log10' | 'exp' | 'abs' | 'sqrt' | 'log_returns' | 'pct_change' | 'drawdown';
	readonly periods?: number;
	/** Required when `fn` ∈ {log_returns, pct_change, drawdown} — those
	 *  three emit window/lag SQL and need an explicit ordering column.
	 *  Other fns are row-local and ignore this field. (Megaudit Theme A
	 *  A2, 2026-05-13.) */
	readonly order_by?: string;
	readonly as: string;
}

export interface ResampleTransform {
	readonly kind: 'resample';
	readonly time_column: string;
	readonly freq: string;
	readonly fill: 'forward' | 'backward' | 'zero' | 'null';
	readonly as_time?: string;
}

export interface TzConvertTransform {
	readonly kind: 'tz_convert';
	readonly column: string;
	readonly to_tz: string;
	readonly as?: string;
}

export interface SortTransform {
	readonly kind: 'sort';
	readonly columns: readonly { readonly column: string; readonly desc?: boolean }[];
}

export interface LimitTransform {
	readonly kind: 'limit';
	readonly n: number;
	readonly offset?: number;
}

/**
 * Visualise v2 -- calculated field via a closed-grammar expression.
 *
 * The `expression` field is a structured AST (see `exprAst.ts`), NOT
 * raw SQL or a string. The webview parses user-typed text in the
 * transform editor and emits the AST; the daemon walks it to produce
 * parameterized DuckDB SQL.
 *
 * The `references` field lists every column the AST reads. It's a
 * defense-in-depth duplicate of what `collectColumnRefs(expression)`
 * would compute, so the validator can refuse a spec whose `references`
 * disagrees with its AST.
 */
export interface ExprTransform {
	readonly kind: 'expr';
	readonly as: string;
	readonly expression: ExprAst;
	readonly references: readonly string[];
}

// --- chart configuration ------------------------------------------------------

export type ChartFamily = 'timeseries' | 'general';

export type ChartType =
	| 'line'
	| 'area'
	| 'bar'
	| 'histogram'
	| 'candlestick'
	| 'baseline'
	| 'scatter'
	| 'heatmap'
	| 'pie';

export interface ChartConfig {
	readonly family: ChartFamily;
	readonly type: ChartType;
	readonly encodings: Encodings;
	readonly options?: ChartOptions;
}

export interface Encodings {
	readonly x?: Encoding;
	readonly y?: Encoding;
	readonly y2?: Encoding;
	readonly color?: Encoding;
	readonly size?: Encoding;
	readonly shape?: Encoding;
	readonly facet_row?: Encoding;
	readonly facet_col?: Encoding;
	/** OHLCV encoding cluster -- used by candlestick. */
	readonly ohlcv?: OhlcvEncoding;
}

export type EncodingType = 'temporal' | 'quantitative' | 'nominal' | 'ordinal';

export interface Encoding {
	readonly field: string;
	readonly type: EncodingType;
	readonly title?: string;
	readonly format?: string;
	readonly scale?: 'linear' | 'log' | 'pow';
	readonly sort?: 'asc' | 'desc';
}

export interface OhlcvEncoding {
	readonly time: string;
	readonly open: string;
	readonly high: string;
	readonly low: string;
	readonly close: string;
	readonly volume?: string;
}

export interface ChartOptions {
	/**
	 * Decimation strategy for high-cardinality time-series data.
	 * 'auto' lets the renderer pick (LTTB on >5k rows).
	 */
	readonly decimation?: 'auto' | 'lttb' | 'minmax' | 'none';
	readonly show_legend?: boolean;
	readonly show_grid?: boolean;
	readonly color_palette?: string;
	readonly y_axis_zero?: boolean;
	readonly markers?: readonly Marker[];
}

export interface Marker {
	readonly time: string | number;
	readonly label?: string;
	readonly color?: string;
	readonly shape?: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
}

// --- trading-domain options ---------------------------------------------------

export interface TradingOptions {
	readonly timezone?: string;
	readonly session?: 'regular' | 'extended' | 'full24';
	readonly adjustment?: 'none' | 'split' | 'dividend' | 'split-dividend';
	readonly currency?: string;
	readonly precision?: { readonly price?: number; readonly quantity?: number };
}

// --- provenance (mandatory) ---------------------------------------------------

export interface Provenance {
	readonly generated_at: string;
	readonly generator: string;
	readonly query_hash: string;
	readonly tool_versions: { readonly qviz_schema: number;[key: string]: number | string };
	readonly source?: 'engine-emitted' | 'user-built' | 'imported';
}

// --- exhaustiveness helper ----------------------------------------------------

export function assertNeverTransform(t: never): never {
	throw new Error(`unhandled transform kind: ${JSON.stringify(t)}`);
}
