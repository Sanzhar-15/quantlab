/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime validation for .qviz.json files.
 *
 * Hand-rolled (no dep on ajv) for:
 *   - clear error messages with paths (e.g. "transforms[2].column: expected string")
 *   - small bundle (this validator is shipped to the webview)
 *   - type-narrowed return: `validate(x)` returns `QvizSpec` if ok
 *
 * Security: this is the gate between untrusted .qviz.json on disk and the
 * application. It MUST reject:
 *   - non-workspace-relative paths
 *   - paths escaping workspace via "../"
 *   - unknown transform kinds (defense against forward-rolled specs we can't run)
 *   - missing provenance (auditability invariant)
 *   - missing or wrong `qviz_version`
 */

import {
	type AggregateTransform, type AggregationOp, type BinTransform, type ChartConfig,
	type ChartFamily, type ChartOptions, type ChartType, type DatasetRef, type DateTruncTransform,
	type Encoding, type EncodingType, type Encodings, type FilterTransform,
	type GroupByTransform, type LimitTransform, type MathTransform, type OhlcvEncoding,
	type Provenance, type QvizSpec, type ResampleTransform, type SortTransform,
	type TradingOptions, type Transform, type TzConvertTransform, type WindowTransform,
	QVIZ_SCHEMA_VERSION
} from './spec';

export interface ValidationOk {
	readonly ok: true;
	readonly value: QvizSpec;
}

export interface ValidationError {
	readonly ok: false;
	readonly issues: readonly Issue[];
}

export interface Issue {
	readonly path: string;
	readonly message: string;
}

export type ValidationResult = ValidationOk | ValidationError;

// --- entry point -------------------------------------------------------------

export function validate(input: unknown): ValidationResult {
	const ctx = new Ctx();
	const spec = parseQvizSpec(ctx, '$', input);
	if (ctx.issues.length > 0) {
		return { ok: false, issues: ctx.issues };
	}
	return { ok: true, value: spec! };
}

/** Throws on invalid input; for use in trusted contexts (engine-emitted specs, tests). */
export function validateOrThrow(input: unknown): QvizSpec {
	const r = validate(input);
	if (!r.ok) {
		const summary = r.issues.map(i => `  ${i.path}: ${i.message}`).join('\n');
		throw new Error(`invalid qviz spec:\n${summary}`);
	}
	return r.value;
}

// --- parsers ------------------------------------------------------------------

class Ctx {
	readonly issues: Issue[] = [];
	error(path: string, message: string): void {
		this.issues.push({ path, message });
	}
}

function parseQvizSpec(ctx: Ctx, path: string, x: unknown): QvizSpec | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }

	const version = obj.qviz_version;
	if (version !== QVIZ_SCHEMA_VERSION) {
		ctx.error(`${path}.qviz_version`, `expected ${QVIZ_SCHEMA_VERSION}, got ${JSON.stringify(version)}`);
	}

	const dataset = parseDatasetRef(ctx, `${path}.dataset`, obj.dataset);
	const transforms = parseTransforms(ctx, `${path}.transforms`, obj.transforms);
	const chart = parseChartConfig(ctx, `${path}.chart`, obj.chart);
	const provenance = parseProvenance(ctx, `${path}.provenance`, obj.provenance);
	const tradingOptions = obj.trading_options !== undefined
		? parseTradingOptions(ctx, `${path}.trading_options`, obj.trading_options)
		: undefined;

	if (!dataset || !chart || !provenance || !transforms) { return null; }

	return {
		$schema: optString(obj.$schema),
		qviz_version: QVIZ_SCHEMA_VERSION,
		title: optString(obj.title),
		description: optString(obj.description),
		dataset,
		transforms,
		chart,
		trading_options: tradingOptions ?? undefined,
		provenance,
	};
}

function parseDatasetRef(ctx: Ctx, path: string, x: unknown): DatasetRef | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }

	const uri = expectString(ctx, `${path}.uri`, obj.uri);
	if (uri !== null) {
		// Workspace-relative invariant: must not start with / nor contain ".." segments.
		if (uri.startsWith('/') || uri.startsWith('\\')) {
			ctx.error(`${path}.uri`, `must be workspace-relative, not absolute: ${uri}`);
		}
		const segments = uri.split(/[/\\]/);
		if (segments.includes('..')) {
			ctx.error(`${path}.uri`, `must not escape workspace via "..": ${uri}`);
		}
		if (uri.length === 0) {
			ctx.error(`${path}.uri`, 'must not be empty');
		}
	}

	const schemaHash = expectString(ctx, `${path}.schema_hash`, obj.schema_hash);
	if (schemaHash !== null && !/^sha256:[0-9a-f]{64}$/.test(schemaHash)) {
		ctx.error(`${path}.schema_hash`, `expected "sha256:<64 hex>", got: ${schemaHash}`);
	}
	const mtimeNs = expectNumber(ctx, `${path}.mtime_ns`, obj.mtime_ns);
	const rowCount = obj.row_count !== undefined ? expectNumber(ctx, `${path}.row_count`, obj.row_count) ?? undefined : undefined;

	if (uri === null || schemaHash === null || mtimeNs === null) { return null; }
	return { uri, schema_hash: schemaHash, mtime_ns: mtimeNs, row_count: rowCount };
}

function parseTransforms(ctx: Ctx, path: string, x: unknown): readonly Transform[] | null {
	if (!Array.isArray(x)) {
		ctx.error(path, `expected array, got ${typeofValue(x)}`);
		return null;
	}
	const out: Transform[] = [];
	for (let i = 0; i < x.length; i++) {
		const t = parseTransform(ctx, `${path}[${i}]`, x[i]);
		if (t) { out.push(t); }
	}
	return out;
}

function parseTransform(ctx: Ctx, path: string, x: unknown): Transform | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const kind = obj.kind;
	switch (kind) {
		case 'filter': return parseFilter(ctx, path, obj);
		case 'date_trunc': return parseDateTrunc(ctx, path, obj);
		case 'bin': return parseBin(ctx, path, obj);
		case 'groupby': return parseGroupBy(ctx, path, obj);
		case 'aggregate': return parseAggregate(ctx, path, obj);
		case 'window': return parseWindow(ctx, path, obj);
		case 'math': return parseMath(ctx, path, obj);
		case 'resample': return parseResample(ctx, path, obj);
		case 'tz_convert': return parseTzConvert(ctx, path, obj);
		case 'sort': return parseSort(ctx, path, obj);
		case 'limit': return parseLimit(ctx, path, obj);
		default:
			ctx.error(`${path}.kind`, `unknown transform kind: ${JSON.stringify(kind)}`);
			return null;
	}
}

const FILTER_OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not_in', 'is_null', 'not_null'] as const;
function parseFilter(ctx: Ctx, path: string, obj: Record<string, unknown>): FilterTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const op = expectEnum(ctx, `${path}.op`, obj.op, FILTER_OPS);
	const needsValue = op !== null && op !== 'is_null' && op !== 'not_null';
	if (column === null || op === null) { return null; }
	const value = needsValue ? obj.value as FilterTransform['value'] : undefined;
	if (needsValue && value === undefined) {
		ctx.error(`${path}.value`, `required for op "${op}"`);
		return null;
	}
	return { kind: 'filter', column, op, value };
}

function parseDateTrunc(ctx: Ctx, path: string, obj: Record<string, unknown>): DateTruncTransform | null {
	const units = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
	const column = expectString(ctx, `${path}.column`, obj.column);
	const unit = expectEnum(ctx, `${path}.unit`, obj.unit, units);
	const as = expectString(ctx, `${path}.as`, obj.as);
	if (column === null || unit === null || as === null) { return null; }
	return { kind: 'date_trunc', column, unit, as };
}

function parseBin(ctx: Ctx, path: string, obj: Record<string, unknown>): BinTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const nBins = expectNumber(ctx, `${path}.n_bins`, obj.n_bins);
	const as = expectString(ctx, `${path}.as`, obj.as);
	if (column === null || nBins === null || as === null) { return null; }
	if (nBins < 2 || nBins > 1000 || !Number.isInteger(nBins)) {
		ctx.error(`${path}.n_bins`, `must be integer 2..1000, got ${nBins}`);
		return null;
	}
	const strategies = ['equal_width', 'equal_freq'] as const;
	const strategy = obj.strategy !== undefined ? expectEnum(ctx, `${path}.strategy`, obj.strategy, strategies) ?? undefined : undefined;
	return { kind: 'bin', column, n_bins: nBins, strategy, as };
}

function parseGroupBy(ctx: Ctx, path: string, obj: Record<string, unknown>): GroupByTransform | null {
	const cols = expectStringArray(ctx, `${path}.columns`, obj.columns);
	if (cols === null) { return null; }
	if (cols.length === 0) {
		ctx.error(`${path}.columns`, 'must not be empty');
		return null;
	}
	return { kind: 'groupby', columns: cols };
}

const AGG_FNS = ['sum', 'mean', 'median', 'min', 'max', 'count', 'std', 'first', 'last'] as const;
function parseAggregate(ctx: Ctx, path: string, obj: Record<string, unknown>): AggregateTransform | null {
	if (!Array.isArray(obj.aggs)) {
		ctx.error(`${path}.aggs`, `expected array, got ${typeofValue(obj.aggs)}`);
		return null;
	}
	const aggs: AggregationOp[] = [];
	for (let i = 0; i < obj.aggs.length; i++) {
		const a = expectObject(ctx, `${path}.aggs[${i}]`, obj.aggs[i]);
		if (!a) { continue; }
		const column = expectString(ctx, `${path}.aggs[${i}].column`, a.column);
		const fn = expectEnum(ctx, `${path}.aggs[${i}].fn`, a.fn, AGG_FNS);
		const as = expectString(ctx, `${path}.aggs[${i}].as`, a.as);
		if (column !== null && fn !== null && as !== null) {
			aggs.push({ column, fn, as });
		}
	}
	if (aggs.length === 0) {
		ctx.error(`${path}.aggs`, 'must have at least one aggregation');
		return null;
	}
	return { kind: 'aggregate', aggs };
}

const WINDOW_FNS = ['rolling_mean', 'rolling_std', 'rolling_max', 'rolling_min', 'ema', 'cumsum', 'cumprod', 'cummax', 'cummin'] as const;
function parseWindow(ctx: Ctx, path: string, obj: Record<string, unknown>): WindowTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const fn = expectEnum(ctx, `${path}.fn`, obj.fn, WINDOW_FNS);
	const as = expectString(ctx, `${path}.as`, obj.as);
	if (column === null || fn === null || as === null) { return null; }
	const windowVal = obj.window !== undefined ? expectNumber(ctx, `${path}.window`, obj.window) : null;
	const requiresWindow = fn.startsWith('rolling_') || fn === 'ema';
	if (requiresWindow && (windowVal === null || windowVal === undefined)) {
		ctx.error(`${path}.window`, `required for fn "${fn}"`);
		return null;
	}
	return { kind: 'window', column, fn, window: windowVal ?? undefined, as };
}

const MATH_FNS = ['log', 'log10', 'exp', 'abs', 'sqrt', 'log_returns', 'pct_change', 'drawdown'] as const;
function parseMath(ctx: Ctx, path: string, obj: Record<string, unknown>): MathTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const fn = expectEnum(ctx, `${path}.fn`, obj.fn, MATH_FNS);
	const as = expectString(ctx, `${path}.as`, obj.as);
	if (column === null || fn === null || as === null) { return null; }
	const periods = obj.periods !== undefined ? expectNumber(ctx, `${path}.periods`, obj.periods) ?? undefined : undefined;
	return { kind: 'math', column, fn, periods, as };
}

function parseResample(ctx: Ctx, path: string, obj: Record<string, unknown>): ResampleTransform | null {
	const fills = ['forward', 'backward', 'zero', 'null'] as const;
	const time = expectString(ctx, `${path}.time_column`, obj.time_column);
	const freq = expectString(ctx, `${path}.freq`, obj.freq);
	const fill = expectEnum(ctx, `${path}.fill`, obj.fill, fills);
	if (time === null || freq === null || fill === null) { return null; }
	return { kind: 'resample', time_column: time, freq, fill, as_time: optString(obj.as_time) };
}

function parseTzConvert(ctx: Ctx, path: string, obj: Record<string, unknown>): TzConvertTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const toTz = expectString(ctx, `${path}.to_tz`, obj.to_tz);
	if (column === null || toTz === null) { return null; }
	return { kind: 'tz_convert', column, to_tz: toTz, as: optString(obj.as) };
}

function parseSort(ctx: Ctx, path: string, obj: Record<string, unknown>): SortTransform | null {
	if (!Array.isArray(obj.columns)) {
		ctx.error(`${path}.columns`, `expected array, got ${typeofValue(obj.columns)}`);
		return null;
	}
	const cols: { column: string; desc?: boolean }[] = [];
	for (let i = 0; i < obj.columns.length; i++) {
		const c = expectObject(ctx, `${path}.columns[${i}]`, obj.columns[i]);
		if (!c) { continue; }
		const column = expectString(ctx, `${path}.columns[${i}].column`, c.column);
		if (column === null) { continue; }
		const desc = c.desc !== undefined ? c.desc === true : undefined;
		cols.push({ column, desc });
	}
	if (cols.length === 0) {
		ctx.error(`${path}.columns`, 'must have at least one column');
		return null;
	}
	return { kind: 'sort', columns: cols };
}

function parseLimit(ctx: Ctx, path: string, obj: Record<string, unknown>): LimitTransform | null {
	const n = expectNumber(ctx, `${path}.n`, obj.n);
	if (n === null) { return null; }
	if (n < 1 || n > 10_000_000 || !Number.isInteger(n)) {
		ctx.error(`${path}.n`, `must be integer 1..10000000, got ${n}`);
		return null;
	}
	const offset = obj.offset !== undefined ? expectNumber(ctx, `${path}.offset`, obj.offset) ?? undefined : undefined;
	return { kind: 'limit', n, offset };
}

// --- chart config -------------------------------------------------------------

const CHART_FAMILIES: readonly ChartFamily[] = ['timeseries', 'general'];
const CHART_TYPES: readonly ChartType[] = ['line', 'area', 'bar', 'histogram', 'candlestick', 'baseline', 'scatter', 'heatmap', 'pie'];

const CHART_TYPE_BY_FAMILY: Record<ChartFamily, readonly ChartType[]> = {
	timeseries: ['line', 'area', 'bar', 'histogram', 'candlestick', 'baseline'],
	general: ['scatter', 'heatmap', 'bar', 'pie', 'histogram', 'line']
};

function parseChartConfig(ctx: Ctx, path: string, x: unknown): ChartConfig | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const family = expectEnum(ctx, `${path}.family`, obj.family, CHART_FAMILIES);
	const type = expectEnum(ctx, `${path}.type`, obj.type, CHART_TYPES);
	if (family === null || type === null) { return null; }
	if (!CHART_TYPE_BY_FAMILY[family].includes(type)) {
		ctx.error(`${path}.type`, `chart type "${type}" not allowed in family "${family}"`);
		return null;
	}
	const encodings = parseEncodings(ctx, `${path}.encodings`, obj.encodings, type);
	const options = obj.options !== undefined ? parseChartOptions(ctx, `${path}.options`, obj.options) ?? undefined : undefined;
	if (encodings === null) { return null; }
	return { family, type, encodings, options };
}

function parseEncodings(ctx: Ctx, path: string, x: unknown, chartType: ChartType): Encodings | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }

	const enc = (key: string) => obj[key] !== undefined ? parseEncoding(ctx, `${path}.${key}`, obj[key]) ?? undefined : undefined;
	const result: Encodings = {
		x: enc('x'),
		y: enc('y'),
		y2: enc('y2'),
		color: enc('color'),
		size: enc('size'),
		shape: enc('shape'),
		facet_row: enc('facet_row'),
		facet_col: enc('facet_col'),
		ohlcv: obj.ohlcv !== undefined ? parseOhlcvEncoding(ctx, `${path}.ohlcv`, obj.ohlcv) ?? undefined : undefined,
	};

	// Per-chart-type required-encoding constraints.
	switch (chartType) {
		case 'candlestick':
			if (!result.ohlcv) {
				ctx.error(`${path}.ohlcv`, 'candlestick chart requires `ohlcv` encoding');
			}
			break;
		case 'histogram':
			if (!result.x) { ctx.error(`${path}.x`, 'histogram chart requires `x` encoding'); }
			break;
		case 'pie':
			if (!result.color) { ctx.error(`${path}.color`, 'pie chart requires `color` encoding'); }
			break;
		case 'line':
		case 'area':
		case 'bar':
		case 'scatter':
		case 'baseline':
			if (!result.x || !result.y) {
				ctx.error(`${path}`, `${chartType} chart requires \`x\` and \`y\` encodings`);
			}
			break;
		case 'heatmap':
			if (!result.x || !result.y || !result.color) {
				ctx.error(`${path}`, 'heatmap chart requires `x`, `y`, and `color` encodings');
			}
			break;
	}

	return result;
}

const ENCODING_TYPES: readonly EncodingType[] = ['temporal', 'quantitative', 'nominal', 'ordinal'];
function parseEncoding(ctx: Ctx, path: string, x: unknown): Encoding | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const field = expectString(ctx, `${path}.field`, obj.field);
	const type = expectEnum(ctx, `${path}.type`, obj.type, ENCODING_TYPES);
	if (field === null || type === null) { return null; }
	const scales = ['linear', 'log', 'pow'] as const;
	const sorts = ['asc', 'desc'] as const;
	return {
		field, type,
		title: optString(obj.title),
		format: optString(obj.format),
		scale: obj.scale !== undefined ? expectEnum(ctx, `${path}.scale`, obj.scale, scales) ?? undefined : undefined,
		sort: obj.sort !== undefined ? expectEnum(ctx, `${path}.sort`, obj.sort, sorts) ?? undefined : undefined,
	};
}

function parseOhlcvEncoding(ctx: Ctx, path: string, x: unknown): OhlcvEncoding | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const time = expectString(ctx, `${path}.time`, obj.time);
	const open = expectString(ctx, `${path}.open`, obj.open);
	const high = expectString(ctx, `${path}.high`, obj.high);
	const low = expectString(ctx, `${path}.low`, obj.low);
	const close = expectString(ctx, `${path}.close`, obj.close);
	if (time === null || open === null || high === null || low === null || close === null) { return null; }
	return { time, open, high, low, close, volume: optString(obj.volume) };
}

function parseChartOptions(ctx: Ctx, path: string, x: unknown): ChartOptions | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const decims = ['auto', 'lttb', 'minmax', 'none'] as const;
	const decimation = obj.decimation !== undefined ? expectEnum(ctx, `${path}.decimation`, obj.decimation, decims) ?? undefined : undefined;
	return {
		decimation,
		show_legend: optBool(obj.show_legend),
		show_grid: optBool(obj.show_grid),
		color_palette: optString(obj.color_palette),
		y_axis_zero: optBool(obj.y_axis_zero),
		// markers parsing omitted from v1 -- accept and pass through unchanged
		markers: Array.isArray(obj.markers) ? obj.markers as ChartOptions['markers'] : undefined,
	};
}

function parseTradingOptions(ctx: Ctx, path: string, x: unknown): TradingOptions | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const sessions = ['regular', 'extended', 'full24'] as const;
	const adjustments = ['none', 'split', 'dividend', 'split-dividend'] as const;
	return {
		timezone: optString(obj.timezone),
		session: obj.session !== undefined ? expectEnum(ctx, `${path}.session`, obj.session, sessions) ?? undefined : undefined,
		adjustment: obj.adjustment !== undefined ? expectEnum(ctx, `${path}.adjustment`, obj.adjustment, adjustments) ?? undefined : undefined,
		currency: optString(obj.currency),
		precision: obj.precision !== undefined ? parsePrecision(ctx, `${path}.precision`, obj.precision) ?? undefined : undefined,
	};
}

function parsePrecision(ctx: Ctx, path: string, x: unknown): { price?: number; quantity?: number } | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	return {
		price: obj.price !== undefined ? expectNumber(ctx, `${path}.price`, obj.price) ?? undefined : undefined,
		quantity: obj.quantity !== undefined ? expectNumber(ctx, `${path}.quantity`, obj.quantity) ?? undefined : undefined,
	};
}

function parseProvenance(ctx: Ctx, path: string, x: unknown): Provenance | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const generatedAt = expectString(ctx, `${path}.generated_at`, obj.generated_at);
	const generator = expectString(ctx, `${path}.generator`, obj.generator);
	const queryHash = expectString(ctx, `${path}.query_hash`, obj.query_hash);
	const tv = expectObject(ctx, `${path}.tool_versions`, obj.tool_versions);
	if (generatedAt === null || generator === null || queryHash === null || !tv) { return null; }
	if (typeof tv.qviz_schema !== 'number') {
		ctx.error(`${path}.tool_versions.qviz_schema`, `expected number, got ${typeofValue(tv.qviz_schema)}`);
		return null;
	}
	const sources = ['engine-emitted', 'user-built', 'imported'] as const;
	return {
		generated_at: generatedAt,
		generator,
		query_hash: queryHash,
		tool_versions: tv as Provenance['tool_versions'],
		source: obj.source !== undefined ? expectEnum(ctx, `${path}.source`, obj.source, sources) ?? undefined : undefined,
	};
}

// --- primitive helpers -------------------------------------------------------

function expectObject(ctx: Ctx, path: string, x: unknown): Record<string, unknown> | null {
	if (x === null || typeof x !== 'object' || Array.isArray(x)) {
		ctx.error(path, `expected object, got ${typeofValue(x)}`);
		return null;
	}
	return x as Record<string, unknown>;
}

function expectString(ctx: Ctx, path: string, x: unknown): string | null {
	if (typeof x !== 'string') {
		ctx.error(path, `expected string, got ${typeofValue(x)}`);
		return null;
	}
	return x;
}

function expectNumber(ctx: Ctx, path: string, x: unknown): number | null {
	if (typeof x !== 'number' || !Number.isFinite(x)) {
		ctx.error(path, `expected finite number, got ${typeofValue(x)}`);
		return null;
	}
	return x;
}

function expectEnum<T extends string>(ctx: Ctx, path: string, x: unknown, allowed: readonly T[]): T | null {
	if (typeof x !== 'string' || !allowed.includes(x as T)) {
		ctx.error(path, `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(x)}`);
		return null;
	}
	return x as T;
}

function expectStringArray(ctx: Ctx, path: string, x: unknown): readonly string[] | null {
	if (!Array.isArray(x)) {
		ctx.error(path, `expected array, got ${typeofValue(x)}`);
		return null;
	}
	const out: string[] = [];
	for (let i = 0; i < x.length; i++) {
		if (typeof x[i] !== 'string') {
			ctx.error(`${path}[${i}]`, `expected string, got ${typeofValue(x[i])}`);
			return null;
		}
		out.push(x[i]);
	}
	return out;
}

function optString(x: unknown): string | undefined {
	return typeof x === 'string' ? x : undefined;
}

function optBool(x: unknown): boolean | undefined {
	return typeof x === 'boolean' ? x : undefined;
}

function typeofValue(x: unknown): string {
	if (x === null) { return 'null'; }
	if (Array.isArray(x)) { return 'array'; }
	return typeof x;
}
