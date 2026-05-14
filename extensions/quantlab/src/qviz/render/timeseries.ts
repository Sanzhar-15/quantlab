/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compile a validated QvizSpec + extracted column data into a renderer-agnostic
 * TimeseriesPlan. Pure: no DOM, no Chart instance, no side effects. Trivially
 * unit-testable.
 *
 * Routes by chart.type:
 *   line / area / bar / histogram / baseline -> a single series of DataPointMs
 *   candlestick                              -> a single series of OhlcDataPointMs
 *
 * Chart options are pulled from spec.chart.options + spec.trading_options.
 *
 * The applyTimeseriesPlan function (separate, side-effecting) takes this plan
 * plus a container element and creates an actual @charts-plus Chart.
 */

import type { ChartType, QvizSpec } from '../spec';
import type { TransformAttribution } from '../messageProtocol';
import { describeColumnDrop } from './attribution';
import type {
	AreaPlan, BarPlan, BaselinePlan, CandlestickPlan, ColumnData, DataPointMs, HistogramPlan,
	LinePlan, OhlcDataPointMs, QvizTheme, TimeseriesChartOptions, TimeseriesPlan,
	TimeseriesSeriesPlan
} from './types';

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

export class CompilePlanError extends Error {
	constructor(message: string) { super(message); this.name = 'CompilePlanError'; }
}

/**
 * Compile a spec + columnar data into a TimeseriesPlan.
 *
 * Front 2 (2026-05-14): `attribution` optionally carries per-transform
 * schema snapshots from the daemon. When present, "encoding references
 * missing column" errors are enriched to name the responsible
 * transform.
 */
export function compileTimeseriesPlan(
	spec: QvizSpec,
	columns: ColumnData,
	theme: QvizTheme = DEFAULT_THEME,
	attribution?: readonly TransformAttribution[] | null,
): TimeseriesPlan {
	if (spec.chart.family !== 'timeseries') {
		throw new CompilePlanError(
			`compileTimeseriesPlan only handles family='timeseries' (got '${spec.chart.family}')`
		);
	}

	// Front 4 + Cycle 2 audit HIGH-3 (Codex, 2026-05-14): when the
	// user hasn't set `chart.options.y_axis_zero` explicitly, apply
	// the chart-type's canonical zero-baseline default. Bars and
	// histograms anchor at zero (Tufte canon for length-from-zero);
	// line / area / baseline / candlestick auto-fit (Vega-Lite-side
	// equivalent: scale.zero=false). Without this branch, timeseries
	// bar/histogram silently inherited Vega-Lite's quantitative
	// implicit `zero=true` only when the explicit option was set,
	// while the general-family renderer applied the same canon
	// automatically — an unintentional divergence between the two
	// renderer paths.
	const yAxisZeroDefault = (spec.chart.type === 'bar' || spec.chart.type === 'histogram')
		? true
		: false;
	const yAxisZero = spec.chart.options?.y_axis_zero !== undefined
		? spec.chart.options.y_axis_zero
		: yAxisZeroDefault;
	const chartOptions: TimeseriesChartOptions = {
		timezone: spec.trading_options?.timezone,
		autoSize: true,
		showGrid: spec.chart.options?.show_grid ?? true,
		yAxisZero,
		theme,
	};

	const diagnostics: string[] = [];
	const palette = theme.seriesPalette.length > 0 ? theme.seriesPalette : DEFAULT_PALETTE;

	const chartType = spec.chart.type;
	const series: TimeseriesSeriesPlan[] = [];

	switch (chartType) {
		case 'candlestick': {
			series.push(compileCandlestick(spec, columns, diagnostics, attribution));
			break;
		}
		case 'line':
		case 'area':
		case 'bar':
		case 'histogram':
		case 'baseline': {
			series.push(compileScalarSeries(spec, columns, palette[0], chartType, diagnostics, attribution));
			break;
		}
		default: {
			throw new CompilePlanError(
				`chart.type='${chartType as string}' not supported by timeseries renderer`
			);
		}
	}

	return { chart: chartOptions, series, diagnostics };
}

// ---------------------------------------------------------------------------
// Per-chart-type compilers
// ---------------------------------------------------------------------------

function compileCandlestick(
	spec: QvizSpec,
	columns: ColumnData,
	diagnostics: string[],
	attribution?: readonly TransformAttribution[] | null,
): CandlestickPlan {
	const ohlcv = spec.chart.encodings.ohlcv;
	if (!ohlcv) {
		throw new CompilePlanError('candlestick chart requires encodings.ohlcv');
	}
	for (const fieldName of ['time', 'open', 'high', 'low', 'close'] as const) {
		const colName = ohlcv[fieldName];
		if (columns[colName] === undefined) {
			// Front 2 (2026-05-14): enrich with the responsible transform.
			const suffix = describeColumnDrop(colName, attribution);
			throw new CompilePlanError(
				`encodings.ohlcv.${fieldName}='${colName}' not in column data${suffix}`
			);
		}
	}

	const tCol = columns[ohlcv.time] as ArrayLike<number>;
	const oCol = columns[ohlcv.open] as ArrayLike<number>;
	const hCol = columns[ohlcv.high] as ArrayLike<number>;
	const lCol = columns[ohlcv.low] as ArrayLike<number>;
	const cCol = columns[ohlcv.close] as ArrayLike<number>;

	const n = tCol.length;
	if (oCol.length !== n || hCol.length !== n || lCol.length !== n || cCol.length !== n) {
		throw new CompilePlanError(
			`OHLCV columns have mismatched lengths: t=${n} o=${oCol.length} h=${hCol.length} l=${lCol.length} c=${cCol.length}`
		);
	}

	const data: OhlcDataPointMs[] = new Array(n);
	let droppedNanRows = 0;
	let droppedInvalidRows = 0;
	let outIdx = 0;
	for (let i = 0; i < n; i++) {
		const t = tCol[i];
		const o = oCol[i];
		const h = hCol[i];
		const l = lCol[i];
		const c = cCol[i];
		if (
			t === null || o === null || h === null || l === null || c === null ||
			!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) ||
			!Number.isFinite(l) || !Number.isFinite(c)
		) {
			droppedNanRows++;
			continue;
		}
		// Audit finding #9: validate OHLC structural invariants. h must be the
		// max and l the min; o/c must lie between l and h. Bad data here
		// renders as a glitched candle and pollutes downstream analysis.
		if (h < l || o > h || o < l || c > h || c < l) {
			droppedInvalidRows++;
			continue;
		}
		data[outIdx++] = { t, o, h, l, c };
	}
	data.length = outIdx;

	if (droppedNanRows > 0) {
		diagnostics.push(`candlestick: dropped ${droppedNanRows} rows with null/NaN OHLCV`);
	}
	if (droppedInvalidRows > 0) {
		diagnostics.push(`candlestick: dropped ${droppedInvalidRows} rows violating OHLC invariants (h<l or o/c outside [l,h])`);
	}

	return {
		kind: 'candlestick',
		id: 'candles',
		title: spec.title,
		data,
	};
}

function compileScalarSeries(
	spec: QvizSpec,
	columns: ColumnData,
	defaultColor: string,
	chartType: Exclude<ChartType, 'candlestick' | 'scatter' | 'heatmap' | 'pie'>,
	diagnostics: string[],
	attribution?: readonly TransformAttribution[] | null,
): LinePlan | AreaPlan | BarPlan | HistogramPlan | BaselinePlan {
	const xEnc = spec.chart.encodings.x;
	const yEnc = spec.chart.encodings.y;
	if (!xEnc || !yEnc) {
		throw new CompilePlanError(`${chartType} chart requires encodings.x and encodings.y`);
	}
	if (columns[xEnc.field] === undefined) {
		// Front 2 (2026-05-14): enrich with the responsible transform.
		const suffix = describeColumnDrop(xEnc.field, attribution);
		throw new CompilePlanError(
			`encodings.x.field='${xEnc.field}' not in column data${suffix}`
		);
	}
	if (columns[yEnc.field] === undefined) {
		const suffix = describeColumnDrop(yEnc.field, attribution);
		throw new CompilePlanError(
			`encodings.y.field='${yEnc.field}' not in column data${suffix}`
		);
	}

	const xCol = columns[xEnc.field] as ArrayLike<number>;
	const yCol = columns[yEnc.field] as ArrayLike<number | null>;
	const n = xCol.length;
	if (yCol.length !== n) {
		throw new CompilePlanError(
			`x and y columns have mismatched lengths: x=${n} y=${yCol.length}`
		);
	}

	const data: DataPointMs[] = new Array(n);
	let nullCount = 0;
	for (let i = 0; i < n; i++) {
		const t = xCol[i];
		const v = yCol[i];
		if (t === null || !Number.isFinite(t)) {
			// Skip rows with null/invalid time. Without a time we can't
			// position the point, so it's dropped.
			data[i] = { t: 0, v: null };
			nullCount++;
			continue;
		}
		if (v === null || (typeof v === 'number' && !Number.isFinite(v))) {
			// Null y is fine -- chart-core renders gaps for null v.
			data[i] = { t, v: null };
			nullCount++;
			continue;
		}
		data[i] = { t, v: typeof v === 'number' ? v : Number(v) };
	}

	if (nullCount > 0) {
		diagnostics.push(`${chartType}: ${nullCount} of ${n} rows have null/invalid values`);
	}
	if (n > 0 && nullCount === n) {
		// Audit finding #11: silent empty chart confuses the user. Surface a
		// loud diagnostic so the renderer / UI can show "no data" copy
		// instead of an unexplained blank canvas.
		diagnostics.push(`${chartType}: ALL ${n} rows are null/invalid -- chart will render empty`);
	}

	const id = chartType;
	const title = yEnc.title ?? yEnc.field;
	const color = defaultColor;

	if (chartType === 'line') { return { kind: 'line', id, title, color, data }; }
	if (chartType === 'area') { return { kind: 'area', id, title, color, data }; }
	if (chartType === 'bar') { return { kind: 'bar', id, title, color, data }; }
	if (chartType === 'histogram') { return { kind: 'histogram', id, title, color, data }; }
	if (chartType === 'baseline') {
		return { kind: 'baseline', id, title, color, baseValue: 0, data };
	}
	// Should be unreachable; the switch above guards it.
	throw new CompilePlanError(`unsupported chart type for scalar series: ${chartType as string}`);
}
