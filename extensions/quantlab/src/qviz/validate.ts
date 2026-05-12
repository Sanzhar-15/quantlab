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
import { validatePipeline } from './pipelineValidate';

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

	// Megaudit M-30: run pipeline-order validation here so it applies
	// uniformly at every validator entry (parseSpecBytes, message
	// protocol validators). Previously this only ran in the webview
	// builder UI; orphan `groupby`/`aggregate` could slip through via
	// a crafted webview message bypassing the UI.
	const pipelineErrors = validatePipeline(transforms);
	let hasPipelineErrors = false;
	for (const idxKey of Object.keys(pipelineErrors)) {
		const idx = Number(idxKey);
		ctx.error(`${path}.transforms[${idx}]`, pipelineErrors[idx]);
		hasPipelineErrors = true;
	}
	if (hasPipelineErrors) { return null; }

	return {
		$schema: optString(ctx, `${path}.$schema`, obj.$schema),
		qviz_version: QVIZ_SCHEMA_VERSION,
		title: optString(ctx, `${path}.title`, obj.title),
		description: optString(ctx, `${path}.description`, obj.description),
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
	// Megaudit-2 A3-mtime_ns (corrected): bound mtime_ns at 7e18 ns
	// (~year 2192). NOTE: this DOES exceed Number.MAX_SAFE_INTEGER
	// (~9e15 ns ≈ year 1970). Realistic epoch-ns values for current
	// datasets are ~1.7e18 (today) and MUST be accepted. Precision
	// loss above 2^53 is unavoidable in JS Number; the cache
	// invalidation layer (Python daemon) uses the integer mtime_ns
	// from the OS directly (not via the JS validator), so the
	// fingerprint is precise on the daemon side. The validator only
	// records the value for round-trip; precision loss here is
	// acceptable for the use case.
	if (mtimeNs !== null && (!Number.isFinite(mtimeNs) || mtimeNs < 0 || mtimeNs > 7e18)) {
		ctx.error(`${path}.mtime_ns`, `out of plausible epoch-ns range [0..7e18], got ${mtimeNs}`);
	}
	const rowCount = obj.row_count !== undefined ? expectNumber(ctx, `${path}.row_count`, obj.row_count) ?? undefined : undefined;
	if (rowCount !== undefined && (!Number.isSafeInteger(rowCount) || rowCount < 0)) {
		ctx.error(`${path}.row_count`, `expected non-negative safe integer, got ${rowCount}`);
	}

	if (uri === null || schemaHash === null || mtimeNs === null) { return null; }
	return { uri, schema_hash: schemaHash, mtime_ns: mtimeNs, row_count: rowCount };
}

// Megaudit defense-in-depth: cap transforms array to prevent unbounded
// CPU/memory work in downstream compile/validate. 256 is well above
// any realistic pipeline (typical specs have 0-10 transforms).
const MAX_TRANSFORMS = 256;
function parseTransforms(ctx: Ctx, path: string, x: unknown): readonly Transform[] | null {
	if (!Array.isArray(x)) {
		ctx.error(path, `expected array, got ${typeofValue(x)}`);
		return null;
	}
	if (x.length > MAX_TRANSFORMS) {
		ctx.error(path, `transforms array length ${x.length} exceeds cap ${MAX_TRANSFORMS}`);
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

const FILTER_OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not_in', 'is_null', 'not_null', 'contains'] as const;
function parseFilter(ctx: Ctx, path: string, obj: Record<string, unknown>): FilterTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const op = expectEnum(ctx, `${path}.op`, obj.op, FILTER_OPS);
	const needsValue = op !== null && op !== 'is_null' && op !== 'not_null';
	if (column === null || op === null) { return null; }
	if (!needsValue) {
		return { kind: 'filter', column, op, value: undefined };
	}
	if (obj.value === undefined) {
		ctx.error(`${path}.value`, `required for op "${op}"`);
		return null;
	}
	// Megaudit M-38 + Megaudit-2 A3-CRITICAL-1: tagged result so
	// `value: null` (legitimate primitive for == comparisons) is not
	// confused with a parse error.
	const result = validateFilterValue(ctx, path, op, obj.value);
	if (!result.ok) { return null; }
	return { kind: 'filter', column, op, value: result.value as FilterTransform['value'] };
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
	// Validator-compiler coordination (Step C megaudit follow-up): the
	// daemon's compiler only implements equal_width. A spec with
	// strategy='equal_freq' would validate here but the daemon would
	// silently apply equal_width -- a "save a spec the daemon will
	// quietly miscompile" pattern. Reject until the compiler catches up.
	// When equal_freq lands in `python/qviz/compiler.py`, remove this gate.
	if (strategy === 'equal_freq') {
		ctx.error(
			`${path}.strategy`,
			"'equal_freq' is not yet implemented by the daemon compiler "
			+ '(see python/qviz/compiler.py). Use \'equal_width\' or omit the field.',
		);
		return null;
	}
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
	// Validator-compiler coordination: `ema` is in the WindowTransform
	// type (it's documented in the spec) but the daemon's compiler
	// (`python/qviz/compiler.py`) rejects it with `NotImplementedError`
	// because recursive CTE in DuckDB is the implementation gap. The
	// validator must NOT accept a spec the daemon will reject at first
	// aggregate. When ema lands in the compiler, remove this gate.
	//
	// Ordering: this gate runs BEFORE the `window` field check so the
	// actionable "ema is not implemented" message always wins (even if
	// the user forgot `window` too -- they'd still need to pick a
	// different fn first).
	if (fn === 'ema') {
		ctx.error(
			`${path}.fn`,
			"'ema' is not yet implemented by the daemon compiler "
			+ '(needs recursive CTE; see python/qviz/compiler.py). '
			+ 'Use a rolling_mean approximation or wait for the implementation.',
		);
		return null;
	}
	const windowVal = obj.window !== undefined ? expectNumber(ctx, `${path}.window`, obj.window) : null;
	const requiresWindow = fn.startsWith('rolling_');
	if (requiresWindow && (windowVal === null || windowVal === undefined)) {
		ctx.error(`${path}.window`, `required for fn "${fn}"`);
		return null;
	}
	// Megaudit-2 A3-MINOR-9: window must be a positive safe integer
	// when present. Negative / fractional / unsafe-large windows are
	// nonsensical and the daemon would reject them at compile time;
	// catch at the validator boundary.
	if (windowVal !== null && windowVal !== undefined
		&& (!Number.isSafeInteger(windowVal) || windowVal < 1 || windowVal > 1_000_000)) {
		ctx.error(`${path}.window`, `must be a safe integer 1..1000000, got ${windowVal}`);
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
	// Megaudit-2 A3-MINOR-9: periods must be a positive safe integer
	// when present (used by pct_change, log_returns, drawdown).
	if (periods !== undefined
		&& (!Number.isSafeInteger(periods) || periods < 1 || periods > 1_000_000)) {
		ctx.error(`${path}.periods`, `must be a safe integer 1..1000000, got ${periods}`);
		return null;
	}
	return { kind: 'math', column, fn, periods, as };
}

function parseResample(ctx: Ctx, path: string, obj: Record<string, unknown>): ResampleTransform | null {
	const fills = ['forward', 'backward', 'zero', 'null'] as const;
	const time = expectString(ctx, `${path}.time_column`, obj.time_column);
	const freq = expectString(ctx, `${path}.freq`, obj.freq);
	const fill = expectEnum(ctx, `${path}.fill`, obj.fill, fills);
	if (time === null || freq === null || fill === null) { return null; }
	// Validator-compiler coordination: the daemon compiler rejects
	// `resample` (deferred to pandas v2 integration; see
	// `python/qviz/compiler.py`). Reject here so saves don't ship
	// specs the daemon will reject. When pandas integration lands,
	// remove this gate.
	ctx.error(
		path,
		"'resample' transform is not yet implemented by the daemon compiler "
		+ '(deferred to pandas v2 integration; see python/qviz/compiler.py). '
		+ 'Use `date_trunc + groupby + aggregate` for grouped aggregation by time bucket.',
	);
	return null;
}

function parseTzConvert(ctx: Ctx, path: string, obj: Record<string, unknown>): TzConvertTransform | null {
	const column = expectString(ctx, `${path}.column`, obj.column);
	const toTz = expectString(ctx, `${path}.to_tz`, obj.to_tz);
	if (column === null || toTz === null) { return null; }
	return { kind: 'tz_convert', column, to_tz: toTz, as: optString(ctx, `${path}.as`, obj.as) };
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
	// Megaudit-2 A3-MINOR-9: offset must be a non-negative safe
	// integer when present.
	if (offset !== undefined
		&& (!Number.isSafeInteger(offset) || offset < 0)) {
		ctx.error(`${path}.offset`, `must be a non-negative safe integer, got ${offset}`);
		return null;
	}
	return { kind: 'limit', n, offset };
}

// --- chart config -------------------------------------------------------------

const CHART_FAMILIES: readonly ChartFamily[] = ['timeseries', 'general'];
const CHART_TYPES: readonly ChartType[] = ['line', 'area', 'bar', 'histogram', 'candlestick', 'baseline', 'scatter', 'heatmap', 'pie'];

export const CHART_TYPE_BY_FAMILY: Record<ChartFamily, readonly ChartType[]> = {
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
	const encodings = parseEncodings(ctx, `${path}.encodings`, obj.encodings);
	const options = obj.options !== undefined ? parseChartOptions(ctx, `${path}.options`, obj.options) ?? undefined : undefined;
	if (encodings === null) { return null; }
	return { family, type, encodings, options };
}

function parseEncodings(ctx: Ctx, path: string, x: unknown): Encodings | null {
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

	// Per-chart-type required-encoding constraints USED to live here.
	//
	// Smoke-test fix (2026-05-11): removed. These checks were a UX hazard
	// because the protocol validator runs on EVERY webview->provider
	// message -- so as the user dragged columns onto shelves one at a
	// time, every intermediate state (e.g. line chart with x but not yet
	// y) triggered "$.chart.encodings: line chart requires `x` and `y`
	// encodings", which the provider toasted as a user-facing error.
	// Result: a flood of error popups during normal chart building.
	//
	// The completeness checks belong at the COMPILE step (where the
	// daemon generates SQL/Vega-Lite from a spec). They're already
	// enforced there:
	//   - candlestick missing ohlcv: `applyTimeseriesPlan` raises
	//     CompilePlanError before construction.
	//   - heatmap missing x/y/color: `applyGeneralPlan` raises
	//     CompileGeneralPlanError.
	//   - histogram, line/area/bar/scatter/baseline missing x/y: the
	//     compiler / renderer surface the gap as a render error which
	//     flows back to the diagnostics readout.
	//
	// The protocol-level validator now keeps the STRUCTURAL invariants
	// (right shape, allowed chart types per family, valid encoding
	// field/type, no duplicate column names, NUL/control-char-free
	// strings, etc.) but defers SEMANTIC completeness to render time.
	// Tests covering the compile-time checks live in
	// `qviz-render-{timeseries,general}.test.ts`; the previous
	// validator-level cases in `qviz-spec-core.test.ts` were removed.

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
		title: optString(ctx, `${path}.title`, obj.title),
		format: optString(ctx, `${path}.format`, obj.format),
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
	return { time, open, high, low, close, volume: optString(ctx, `${path}.volume`, obj.volume) };
}

function parseChartOptions(ctx: Ctx, path: string, x: unknown): ChartOptions | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const decims = ['auto', 'lttb', 'minmax', 'none'] as const;
	const decimation = obj.decimation !== undefined ? expectEnum(ctx, `${path}.decimation`, obj.decimation, decims) ?? undefined : undefined;
	// Megaudit-2 A3-MAJOR-5: markers can no longer pass through
	// unchecked. Each entry is validated; arrays > 256 are rejected.
	// String fields go through isAcceptableString.
	let markers: ChartOptions['markers'] = undefined;
	if (obj.markers !== undefined) {
		markers = parseMarkers(ctx, `${path}.markers`, obj.markers) ?? undefined;
	}
	return {
		decimation,
		show_legend: optBool(ctx, `${path}.show_legend`, obj.show_legend),
		show_grid: optBool(ctx, `${path}.show_grid`, obj.show_grid),
		color_palette: optString(ctx, `${path}.color_palette`, obj.color_palette),
		y_axis_zero: optBool(ctx, `${path}.y_axis_zero`, obj.y_axis_zero),
		markers,
	};
}

const MAX_MARKERS = 256;
const MARKER_SHAPES = ['arrowUp', 'arrowDown', 'circle', 'square', 'diamond', 'triangle'] as const;
function parseMarkers(ctx: Ctx, path: string, x: unknown): ChartOptions['markers'] | null {
	if (!Array.isArray(x)) {
		ctx.error(path, `expected array, got ${typeofValue(x)}`);
		return null;
	}
	if (x.length > MAX_MARKERS) {
		ctx.error(path, `markers array length ${x.length} exceeds cap ${MAX_MARKERS}`);
		return null;
	}
	const out: NonNullable<ChartOptions['markers']>[number][] = [];
	for (let i = 0; i < x.length; i++) {
		const m = expectObject(ctx, `${path}[${i}]`, x[i]);
		if (!m) { return null; }
		// Each field optional but type-validated when present.
		const time = m.time !== undefined ? expectString(ctx, `${path}[${i}].time`, m.time) : undefined;
		const label = m.label !== undefined ? expectString(ctx, `${path}[${i}].label`, m.label) : undefined;
		const color = m.color !== undefined ? expectString(ctx, `${path}[${i}].color`, m.color) : undefined;
		const shape = m.shape !== undefined
			? expectEnum(ctx, `${path}[${i}].shape`, m.shape, MARKER_SHAPES)
			: undefined;
		// time has runtime null if expectString failed; we already
		// emitted ctx.error in that case, so bail.
		if (m.time !== undefined && time === null) { return null; }
		if (m.label !== undefined && label === null) { return null; }
		if (m.color !== undefined && color === null) { return null; }
		if (m.shape !== undefined && shape === null) { return null; }
		out.push({
			time: time ?? '',
			label: label ?? undefined,
			color: color ?? undefined,
			shape: (shape ?? undefined) as NonNullable<ChartOptions['markers']>[number]['shape'],
		});
	}
	return out;
}

function parseTradingOptions(ctx: Ctx, path: string, x: unknown): TradingOptions | null {
	const obj = expectObject(ctx, path, x);
	if (!obj) { return null; }
	const sessions = ['regular', 'extended', 'full24'] as const;
	const adjustments = ['none', 'split', 'dividend', 'split-dividend'] as const;
	return {
		timezone: optString(ctx, `${path}.timezone`, obj.timezone),
		session: obj.session !== undefined ? expectEnum(ctx, `${path}.session`, obj.session, sessions) ?? undefined : undefined,
		adjustment: obj.adjustment !== undefined ? expectEnum(ctx, `${path}.adjustment`, obj.adjustment, adjustments) ?? undefined : undefined,
		currency: optString(ctx, `${path}.currency`, obj.currency),
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
	// Megaudit-2 A3-MINOR-10: tool_versions extra keys must be
	// `string | number` per the type contract; the previous cast
	// accepted arbitrary nested values. Cap key count to bound
	// per-spec memory.
	const MAX_TOOL_VERSIONS_KEYS = 64;
	const tvKeys = Object.keys(tv);
	if (tvKeys.length > MAX_TOOL_VERSIONS_KEYS) {
		ctx.error(`${path}.tool_versions`, `key count ${tvKeys.length} exceeds cap ${MAX_TOOL_VERSIONS_KEYS}`);
		return null;
	}
	for (const k of tvKeys) {
		if (k === 'qviz_schema') { continue; }
		const v = tv[k];
		if (typeof v !== 'string' && typeof v !== 'number') {
			ctx.error(`${path}.tool_versions.${k}`, `expected string or number, got ${typeofValue(v)}`);
			return null;
		}
		if (typeof v === 'string' && !isAcceptableString(v)) {
			ctx.error(`${path}.tool_versions.${k}`, 'string contains NUL/control char or exceeds length cap');
			return null;
		}
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
	// Megaudit defense-in-depth: reject prototype-pollution-bait keys
	// at the validator boundary. Modern JSON.parse treats these as
	// plain own keys (no setter triggered), but downstream code that
	// iterates via `for...in` or `Object.assign` could surface them.
	// Refuse loudly rather than silently strip -- the caller learns
	// their input is malformed.
	for (const k of ['__proto__', 'constructor', 'prototype']) {
		if (Object.prototype.hasOwnProperty.call(x, k)) {
			ctx.error(`${path}.${k}`, `forbidden own-key '${k}' on object payload`);
			return null;
		}
	}
	return x as Record<string, unknown>;
}

/** Megaudit M-39: cap string length and reject NUL bytes / disallowed
 *  control chars at the validator boundary. NUL bytes in identifiers
 *  break SQL identifier quoting; unbounded lengths cause O(n^2)
 *  serialization later in the pipeline. The cap is intentionally
 *  generous (4 KiB) -- column names that long are themselves a smell. */
const MAX_STRING_LENGTH = 4 * 1024;
function isAcceptableString(s: string): boolean {
	if (s.length > MAX_STRING_LENGTH) { return false; }
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		// Disallow NUL (0x00) and most C0 control chars.
		// Permit \t (0x09), \n (0x0A), \r (0x0D) -- common in titles.
		if (code === 0x00) { return false; }
		if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
			return false;
		}
	}
	return true;
}

function expectString(ctx: Ctx, path: string, x: unknown): string | null {
	if (typeof x !== 'string') {
		ctx.error(path, `expected string, got ${typeofValue(x)}`);
		return null;
	}
	if (!isAcceptableString(x)) {
		ctx.error(path, `string contains NUL/control char or exceeds ${MAX_STRING_LENGTH} chars`);
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
		// Megaudit-2 A3-MAJOR-2: route array elements through the
		// same NUL/control-char/length filter as `expectString`. Was:
		// `groupby.columns: ['col ']` slipped through and reached
		// the daemon's SQL identifier-quoting unsanitized.
		if (!isAcceptableString(x[i])) {
			ctx.error(`${path}[${i}]`, `string contains NUL/control char or exceeds ${MAX_STRING_LENGTH} chars`);
			return null;
		}
		out.push(x[i]);
	}
	return out;
}

/** Megaudit M-19 + Megaudit-2 A3-MAJOR-6: optional fields are silently
 *  dropped when absent, but a present-but-wrong-type value records a
 *  ctx.error AND returns undefined. Previously the helpers silently
 *  swallowed wrong types -- e.g. `title: 123` validated as `undefined`
 *  with no diagnostic and the user's intent was lost on round-trip. */
function optString(ctx: Ctx, path: string, x: unknown): string | undefined {
	if (x === undefined) { return undefined; }
	if (typeof x !== 'string') {
		ctx.error(path, `expected string or omitted, got ${typeofValue(x)}`);
		return undefined;
	}
	if (!isAcceptableString(x)) {
		ctx.error(path, `string contains NUL/control char or exceeds ${MAX_STRING_LENGTH} chars`);
		return undefined;
	}
	return x;
}

function optBool(ctx: Ctx, path: string, x: unknown): boolean | undefined {
	if (x === undefined) { return undefined; }
	if (typeof x !== 'boolean') {
		ctx.error(path, `expected boolean or omitted, got ${typeofValue(x)}`);
		return undefined;
	}
	return x;
}

/** Megaudit M-38 + Megaudit-2 A3-CRITICAL-1: runtime type check for
 *  FilterTransform.value. Caps array length at 1024 (DuckDB parameter
 *  binding bound) and disallows nested objects / non-primitive elements.
 *  Also: rejects non-finite numbers (NaN, Infinity).
 *
 *  Returns a tagged result so a legitimate `value: null` (used by `==`/
 *  `!=` comparisons against null columns) is not confused with the
 *  error sentinel. The previous `return value` / `if (value === null)`
 *  pattern at the call site silently dropped any `column == null`
 *  filter. */
const MAX_FILTER_VALUE_ARRAY = 1024;
type FilterValueResult = { ok: true; value: unknown } | { ok: false };
function validateFilterValue(
	ctx: Ctx, path: string, op: typeof FILTER_OPS[number], value: unknown,
): FilterValueResult {
	const isPrimitive = (v: unknown): boolean => {
		if (v === null) { return true; }
		if (typeof v === 'string' || typeof v === 'boolean') { return true; }
		// Megaudit-2 A3-MINOR/CODEX-9: require finite numbers -- NaN
		// and Infinity break DuckDB parameter binding semantics and
		// should never appear in a stored spec.
		if (typeof v === 'number') { return Number.isFinite(v); }
		return false;
	};
	if (op === 'in' || op === 'not_in') {
		if (!Array.isArray(value)) {
			ctx.error(`${path}.value`, `op '${op}' requires array, got ${typeofValue(value)}`);
			return { ok: false };
		}
		if (value.length > MAX_FILTER_VALUE_ARRAY) {
			ctx.error(`${path}.value`, `op '${op}' array length ${value.length} exceeds cap ${MAX_FILTER_VALUE_ARRAY}`);
			return { ok: false };
		}
		for (let i = 0; i < value.length; i++) {
			if (!isPrimitive(value[i])) {
				ctx.error(`${path}.value[${i}]`, `op '${op}' array element must be primitive finite (string/number/boolean/null), got ${typeofValue(value[i])}`);
				return { ok: false };
			}
			if (typeof value[i] === 'string' && !isAcceptableString(value[i] as string)) {
				ctx.error(`${path}.value[${i}]`, 'string contains NUL/control char or exceeds length cap');
				return { ok: false };
			}
		}
		return { ok: true, value };
	}
	// Phase 6: 'contains' requires a non-null string (case-insensitive
	// substring match). Allowing null/number/bool would silently compile
	// to `lower(CAST(col AS VARCHAR)) LIKE %null%` which is nonsense.
	if (op === 'contains') {
		if (typeof value !== 'string') {
			ctx.error(`${path}.value`, `op 'contains' requires a non-empty string, got ${typeofValue(value)}`);
			return { ok: false };
		}
		if (!isAcceptableString(value)) {
			ctx.error(`${path}.value`, 'string contains NUL/control char or exceeds length cap');
			return { ok: false };
		}
		return { ok: true, value };
	}
	// Comparison ops: scalar primitive only.
	if (!isPrimitive(value)) {
		ctx.error(`${path}.value`, `op '${op}' requires primitive finite (string/number/boolean/null), got ${typeofValue(value)}`);
		return { ok: false };
	}
	if (typeof value === 'string' && !isAcceptableString(value)) {
		ctx.error(`${path}.value`, 'string contains NUL/control char or exceeds length cap');
		return { ok: false };
	}
	return { ok: true, value };
}

function typeofValue(x: unknown): string {
	if (x === null) { return 'null'; }
	if (Array.isArray(x)) { return 'array'; }
	return typeof x;
}
