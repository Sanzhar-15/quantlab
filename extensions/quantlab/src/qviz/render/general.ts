/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compile a validated QvizSpec (chart.family === 'general') + extracted column
 * data into a renderer-agnostic GeneralPlan whose `.spec` is a Vega-Lite spec
 * object. Pure: no DOM, no vega-embed import, no side effects.
 *
 * Routes by chart.type:
 *   line        -> mark: 'line'
 *   bar         -> mark: 'bar'
 *   scatter     -> mark: 'circle'
 *   heatmap     -> mark: 'rect'
 *   pie         -> mark: 'arc' with theta from y (required) and color slices
 *   histogram   -> mark: { type: 'bar', binSpacing: 0 }  (data already binned by transforms)
 *
 * Encoding mapping is direct: spec.chart.encodings.{x,y,color,size,shape}
 * become Vega-Lite encoding.{x,y,color,size,shape}; facet_row/facet_col
 * become row/column. Encoding type strings line up 1:1 with Vega-Lite's.
 *
 * Theme is mapped to a Vega-Lite `config` block. show_grid / show_legend /
 * y_axis_zero / scale come from spec.chart.options + per-encoding hints.
 *
 * The applyGeneralPlan function (separate, side-effecting) takes this plan
 * plus a container element, dynamically imports vega-embed, and renders.
 */

import type {
	ChartOptions, ChartType, Encoding, Encodings, QvizSpec
} from '../spec';
import type {
	ColumnData, GeneralChartType, GeneralPlan, QvizTheme,
	VegaLiteEncoding, VegaLiteEncodingType, VegaLiteFieldDef, VegaLiteMark, VegaLiteSpec
} from './types';

const VEGA_LITE_SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json';

const DEFAULT_PALETTE = [
	'#4fc3f7', '#81c784', '#ffb74d', '#f06292',
	'#ba68c8', '#4dd0e1', '#aed581', '#ff8a65',
];

const DEFAULT_THEME: QvizTheme = {
	background: '#0a0f18',
	foreground: '#e7e9ee',
	grid: 'rgba(255, 255, 255, 0.06)',
	axisText: 'rgba(231, 233, 238, 0.7)',
	seriesPalette: DEFAULT_PALETTE,
	upColor: '#26a69a',
	downColor: '#ef5350',
};

export class CompileGeneralPlanError extends Error {
	constructor(message: string) { super(message); this.name = 'CompileGeneralPlanError'; }
}

const GENERAL_CHART_TYPES: readonly GeneralChartType[] =
	['line', 'bar', 'scatter', 'heatmap', 'pie', 'histogram'];

/**
 * Compile a spec + columnar data into a GeneralPlan.
 */
export function compileGeneralPlan(
	spec: QvizSpec,
	columns: ColumnData,
	theme: QvizTheme = DEFAULT_THEME
): GeneralPlan {
	if (spec.chart.family !== 'general') {
		throw new CompileGeneralPlanError(
			`compileGeneralPlan only handles family='general' (got '${spec.chart.family}')`
		);
	}

	if (!isGeneralChartType(spec.chart.type)) {
		throw new CompileGeneralPlanError(
			`chart.type='${spec.chart.type}' not supported by general renderer`
		);
	}

	const diagnostics: string[] = [];
	const chartType = spec.chart.type;

	validateEncodingFields(spec.chart.encodings, columns);

	const rows = columnsToRows(columns, spec.chart.encodings);
	const mark = buildMark(chartType);
	const encoding = buildEncoding(chartType, spec.chart.encodings, spec.chart.options, columns);
	const config = buildConfig(theme, spec.chart.options);

	const out: VegaLiteSpec = {
		$schema: VEGA_LITE_SCHEMA,
		title: spec.title,
		description: spec.description,
		width: 'container',
		height: 'container',
		background: theme.background,
		autosize: 'fit',
		data: { values: rows },
		mark,
		encoding,
		config,
	};

	if (rows.length === 0) {
		// Audit-style "loud diagnostic" parallel to timeseries.ts: never let
		// the user see a silent empty chart without a hint that data is empty.
		diagnostics.push(`general/${chartType}: 0 rows after extraction -- chart will render empty`);
	}

	return { spec: out, diagnostics };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isGeneralChartType(t: ChartType): t is GeneralChartType {
	return (GENERAL_CHART_TYPES as readonly string[]).includes(t);
}

/**
 * Build the mark definition for each chart type. Histogram is bar with zero
 * bin spacing -- the binning happens upstream in the transform pipeline, so
 * the chart renders pre-aggregated counts. Tooltip is enabled by default for
 * all marks; users get hover-readable values without extra config.
 */
function buildMark(chartType: GeneralChartType): VegaLiteMark {
	switch (chartType) {
		case 'line':
			return { type: 'line', tooltip: true };
		case 'bar':
			return { type: 'bar', tooltip: true };
		case 'scatter':
			return { type: 'circle', tooltip: true, opacity: 0.6 };
		case 'heatmap':
			return { type: 'rect', tooltip: true };
		case 'pie':
			return { type: 'arc', tooltip: true };
		case 'histogram':
			return { type: 'bar', tooltip: true, binSpacing: 0 };
	}
}

function buildEncoding(
	chartType: GeneralChartType,
	encodings: Encodings,
	chartOptions: ChartOptions | undefined,
	columns: ColumnData
): VegaLiteEncoding {
	switch (chartType) {
		case 'pie':
			return buildPieEncoding(encodings, columns);
		case 'heatmap':
			return buildHeatmapEncoding(encodings);
		default: {
			// Audit fix (2026-05-11): the cartesian path used to emit
			// whatever encodings were present and let Vega-Lite error at
			// render time when x or y was missing. That produced a noisy
			// Vega-Lite stack trace instead of the actionable channel
			// message users see for pie/heatmap. Mirror the timeseries-side
			// gate (src/qviz/render/timeseries.ts:compileScalarSeries) so
			// the UI's channel table (chartChannels.ts) is the single
			// source of truth: every chart type whose `required` list
			// contains x/y rejects loudly here when either is absent.
			if (!encodings.x || !encodings.y) {
				throw new CompileGeneralPlanError(
					`${chartType} chart requires encodings.x and encodings.y`
				);
			}
			return buildCartesianEncoding(encodings, chartOptions);
		}
	}
}

/**
 * x/y/color/size/shape encoding for line, bar, scatter, histogram.
 * y2 is also emitted (audit-fix AF24: previously collected into row data
 * but never threaded into Vega-Lite encoding -- dead code).
 * Facets are wired here when present.
 *
 * Color scheme adaptation (AF26): for ordinal/temporal color encodings we
 * set an explicit Vega-Lite scheme so the theme's range.category palette
 * isn't silently overridden. Nominal color uses range.category from the
 * theme.
 */
function buildCartesianEncoding(
	encodings: Encodings,
	chartOptions: ChartOptions | undefined
): VegaLiteEncoding {
	// Build an intermediate that's narrowed to the channels we set, then
	// cast to VegaLiteEncoding (which has the same channel names by
	// design). Audit-fix M6: the cast is explicit, not over a generic
	// Record.
	const out: {
		x?: VegaLiteFieldDef; y?: VegaLiteFieldDef;
		// VegaLiteEncoding doesn't expose y2 yet; we assert into a
		// permissive shape here via Record-cast below.
		color?: VegaLiteFieldDef; size?: VegaLiteFieldDef; shape?: VegaLiteFieldDef;
		row?: VegaLiteFieldDef; column?: VegaLiteFieldDef;
	} & Record<string, VegaLiteFieldDef> = {};

	if (encodings.x) {
		out.x = mapFieldDef(encodings.x, { yAxisZero: false });
	}
	if (encodings.y) {
		out.y = mapFieldDef(encodings.y, { yAxisZero: chartOptions?.y_axis_zero === true });
	}
	// Audit-fix AF24: y2 (previously collected into rows but never emitted).
	// Vega-Lite uses y2 alongside y for range marks (errorband, area-range).
	if (encodings.y2) {
		(out as Record<string, VegaLiteFieldDef>).y2 = mapFieldDef(encodings.y2, {});
	}
	if (encodings.color) {
		out.color = mapColorFieldDef(encodings.color);
	}
	if (encodings.size) {
		out.size = mapFieldDef(encodings.size, {});
	}
	if (encodings.shape) {
		out.shape = mapFieldDef(encodings.shape, {});
	}
	if (encodings.facet_row) {
		out.row = mapFieldDef(encodings.facet_row, {});
	}
	if (encodings.facet_col) {
		out.column = mapFieldDef(encodings.facet_col, {});
	}
	return out as VegaLiteEncoding;
}

/**
 * Color encoding mapping with scheme adaptation (audit-fix AF26).
 *
 *   nominal     -> use range.category from the theme (set in buildConfig).
 *                  No scheme override here.
 *   ordinal     -> 'tableau10' (categorical-with-order).
 *   quantitative-> 'viridis' (sequential).
 *   temporal    -> 'viridis' (treated as ordered/sequential).
 *
 * Without this, ordinal/temporal color silently fell back to Vega-Lite's
 * defaults, bypassing theme intent.
 */
function mapColorFieldDef(enc: Encoding): VegaLiteFieldDef {
	const base = mapFieldDef(enc, {});
	if (enc.type === 'nominal') {
		return base;
	}
	const scheme = enc.type === 'ordinal' ? 'tableau10' : 'viridis';
	const baseScale = base.scale ?? {};
	return {
		...base,
		scale: { ...baseScale, ...{ scheme } as { scheme: string } },
	};
}

/**
 * Pie chart: color encodes slice category (required), y encodes the slice
 * angle (required). Both are mandatory -- previously `y` was optional with
 * a count-aggregate fallback, which CLAUDE.md flags as a hidden default.
 * If a user wants count-of-rows pie semantics they should add an explicit
 * `groupby + aggregate(count)` to their transform pipeline; the resulting
 * spec then has a real `y` encoding pointing at the count column.
 *
 * Audit-fix AF21 + AF22 (negative-y guard).
 */
function buildPieEncoding(
	encodings: Encodings, columns: ColumnData
): VegaLiteEncoding {
	if (!encodings.color) {
		throw new CompileGeneralPlanError('pie chart requires encodings.color (slice category)');
	}
	if (!encodings.y) {
		throw new CompileGeneralPlanError(
			'pie chart requires encodings.y for slice angle. To make a count-of-rows ' +
			'pie, add a groupby + aggregate(count) transform and reference the count column.'
		);
	}
	// Audit-fix AF22: Vega-Lite's pie distorts when theta has negative
	// values (slices wrap around). Validate at compile time and reject
	// loudly so the user fixes the data, not the chart.
	const yField = encodings.y.field;
	const yCol = columns[yField];
	if (yCol !== undefined) {
		for (let i = 0; i < yCol.length; i++) {
			const v = (yCol as ArrayLike<number | null>)[i];
			if (typeof v === 'number' && v < 0) {
				throw new CompileGeneralPlanError(
					`pie chart requires non-negative y values; column '${yField}' ` +
					`has a negative value (${v}) at row ${i}.`
				);
			}
		}
	}
	return {
		color: mapFieldDef(encodings.color, {}),
		theta: mapFieldDef(encodings.y, {}),
	};
}

/**
 * Heatmap: x and y are the binned axes (typically temporal/ordinal), color
 * encodes the value. All three are required -- the validator already
 * enforces this, but we double-check here so the compiler is defensive
 * against a hand-built spec that bypassed validation.
 */
function buildHeatmapEncoding(encodings: Encodings): VegaLiteEncoding {
	if (!encodings.x || !encodings.y || !encodings.color) {
		throw new CompileGeneralPlanError(
			'heatmap chart requires encodings.x, encodings.y, and encodings.color'
		);
	}
	return {
		x: mapFieldDef(encodings.x, {}),
		y: mapFieldDef(encodings.y, {}),
		color: mapFieldDef(encodings.color, {}),
	};
}

interface MapFieldDefOpts {
	readonly yAxisZero?: boolean;
}

function mapFieldDef(enc: Encoding, opts: MapFieldDefOpts): VegaLiteFieldDef {
	const out: Record<string, unknown> = {
		field: enc.field,
		type: enc.type as VegaLiteEncodingType,
	};
	if (enc.title !== undefined) { out.title = enc.title; }
	if (enc.format !== undefined) { out.format = enc.format; }
	// Audit-fix AF25: build the scale object only with fields that are
	// actually set, so we never emit `scale: { type: undefined, zero: true }`.
	const scale: Record<string, unknown> = {};
	if (enc.scale !== undefined) { scale.type = enc.scale; }
	if (opts.yAxisZero === true) { scale.zero = true; }
	if (Object.keys(scale).length > 0) { out.scale = scale; }
	if (enc.sort !== undefined) {
		out.sort = enc.sort === 'asc' ? 'ascending' : 'descending';
	}
	// Cast through `unknown` because TypeScript can't track that the
	// Record<string, unknown> includes the required `field` + `type` keys
	// after dynamic assignment. Both fields are set unconditionally above.
	return out as unknown as VegaLiteFieldDef;
}

/**
 * Build a Vega-Lite config object from the QvizTheme + chart options. This
 * is where dark/light theming hooks in -- the renderer applies these without
 * requiring per-encoding theme overrides.
 *
 * show_legend === false disables legends globally (Vega-Lite has no per-
 * channel disable in the config; we set legend.disable instead).
 */
function buildConfig(
	theme: QvizTheme,
	chartOptions: ChartOptions | undefined
): Record<string, unknown> {
	const showGrid = chartOptions?.show_grid ?? true;
	const showLegend = chartOptions?.show_legend ?? true;
	// Megaudit M-21: an empty palette is a theme-config bug. Don't
	// silently substitute the hardcoded default -- that would mask the
	// theme issue and the user sees foreign colors with no signal.
	if (theme.seriesPalette.length === 0) {
		throw new Error(
			'general renderer: theme.seriesPalette is empty. The webview must '
			+ 'provide non-empty palette colors (typically read from VS Code '
			+ '`--vscode-charts-*` CSS variables).',
		);
	}
	const palette = theme.seriesPalette;

	const config: Record<string, unknown> = {
		background: theme.background,
		view: { stroke: theme.grid, fill: theme.background },
		axis: {
			domainColor: theme.grid,
			gridColor: theme.grid,
			tickColor: theme.grid,
			labelColor: theme.axisText,
			titleColor: theme.foreground,
			grid: showGrid,
		},
		title: { color: theme.foreground, anchor: 'start' },
		legend: showLegend
			? { labelColor: theme.foreground, titleColor: theme.foreground }
			: { disable: true },
		range: { category: palette },
	};
	return config;
}

/**
 * Convert ColumnData to Vega-Lite row-oriented values. Only encoding-
 * referenced columns are included so the embedded `data.values` payload
 * stays tight (the daemon already projects to encoding columns at the SQL
 * layer per audit fix #6, but a hand-built columns dict may include extras).
 *
 * Throws CompileGeneralPlanError on column-length mismatch (mirrors
 * timeseries compileScalarSeries behaviour) and on empty-encoding sets
 * (audit-fix AF23: previously this returned an empty chart with a
 * diagnostic, which CLAUDE.md flags as a fallback pattern).
 */
function columnsToRows(
	columns: ColumnData,
	encodings: Encodings
): Record<string, unknown>[] {
	const referenced = collectReferencedFields(encodings);
	if (referenced.length === 0) {
		throw new CompileGeneralPlanError(
			'general chart has no encoding fields; an encoding (x/y/color/size/shape/' +
			'facet/y2 or ohlcv) must reference at least one column'
		);
	}

	const usable: string[] = [];
	for (const name of referenced) {
		if (columns[name] === undefined) {
			throw new CompileGeneralPlanError(
				`encoding references field '${name}' but no such column in data`
			);
		}
		usable.push(name);
	}

	const n = columns[usable[0]].length;
	for (const name of usable) {
		if (columns[name].length !== n) {
			throw new CompileGeneralPlanError(
				`columns have mismatched lengths: ${usable[0]}=${n} ${name}=${columns[name].length}`
			);
		}
	}

	const rows: Record<string, unknown>[] = new Array(n);
	for (let i = 0; i < n; i++) {
		const row: Record<string, unknown> = {};
		for (const name of usable) {
			row[name] = columns[name][i];
		}
		rows[i] = row;
	}
	return rows;
}

function collectReferencedFields(encodings: Encodings): string[] {
	const fields = new Set<string>();
	const channels: readonly (keyof Encodings)[] =
		['x', 'y', 'y2', 'color', 'size', 'shape', 'facet_row', 'facet_col'];
	for (const ch of channels) {
		const enc = encodings[ch] as Encoding | undefined;
		if (enc !== undefined) { fields.add(enc.field); }
	}
	if (encodings.ohlcv !== undefined) {
		// Defensive: validator should reject ohlcv on general family, but if
		// it slips through we still want the field references collected so
		// the row-builder doesn't throw a "no encoding fields" diagnostic.
		fields.add(encodings.ohlcv.time);
		fields.add(encodings.ohlcv.open);
		fields.add(encodings.ohlcv.high);
		fields.add(encodings.ohlcv.low);
		fields.add(encodings.ohlcv.close);
		if (encodings.ohlcv.volume !== undefined) { fields.add(encodings.ohlcv.volume); }
	}
	return Array.from(fields);
}

/**
 * Eagerly check that every encoding field has a matching column. Mirrors
 * the timeseries compileScalarSeries "encodings.x.field='ghost' not in
 * column data" check, but for the channel-rich general family.
 *
 * This runs before columnsToRows so the error message names the channel
 * (more useful than just the field name) when something is off.
 */
function validateEncodingFields(encodings: Encodings, columns: ColumnData): void {
	const channels: readonly (keyof Encodings)[] =
		['x', 'y', 'color', 'size', 'shape', 'facet_row', 'facet_col'];
	for (const ch of channels) {
		const enc = encodings[ch] as Encoding | undefined;
		if (enc !== undefined && columns[enc.field] === undefined) {
			throw new CompileGeneralPlanError(
				`encodings.${String(ch)}.field='${enc.field}' not in column data`
			);
		}
	}
}
