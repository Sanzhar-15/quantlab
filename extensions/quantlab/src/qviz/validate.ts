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
	type Encoding, type EncodingType, type Encodings, type ExprTransform, type FilterTransform,
	type GroupByTransform, type LimitTransform, type MathTransform, type OhlcvEncoding,
	type Provenance, type QvizSpec, type ResampleTransform, type SortTransform,
	type TradingOptions, type Transform, type TzConvertTransform, type WindowTransform,
	QVIZ_SCHEMA_VERSION
} from './spec';
import {
	type BinaryOp, type ExprAst, type WhitelistedFn,
	BINARY_OPS, EXPR_AST_KINDS, EXPR_LIMITS, FN_ARITY, UNARY_OPS, WHITELISTED_FNS,
	astDepth, astNodeCount, collectColumnRefs,
} from './exprAst';
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
		case 'expr': return parseExpr(ctx, path, obj);
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
	// Megaudit Theme A (A1, 2026-05-13): window functions are order-
	// dependent. Without an explicit ORDER BY in the compiled SQL, the
	// daemon used parquet scan order, silently producing wrong rolling
	// means / cumulative sums on unsorted data. order_by is now required.
	const orderBy = expectString(ctx, `${path}.order_by`, obj.order_by);
	if (orderBy === null) { return null; }
	return { kind: 'window', column, fn, window: windowVal ?? undefined, order_by: orderBy, as };
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
	// Megaudit Theme A (A2, 2026-05-13): the three lag/cummax-using math
	// fns (log_returns, pct_change, drawdown) emit window SQL and need
	// an explicit ORDER BY. Pure scalar fns (log, log10, exp, abs, sqrt)
	// are row-local and don't take order_by.
	const ORDER_REQUIRED = new Set(['log_returns', 'pct_change', 'drawdown']);
	let orderBy: string | undefined = undefined;
	if (ORDER_REQUIRED.has(fn)) {
		const ob = expectString(ctx, `${path}.order_by`, obj.order_by);
		if (ob === null) { return null; }
		orderBy = ob;
	} else if (obj.order_by !== undefined) {
		// Document but reject: order_by on row-local fns is a user error
		// (suggests they don't realize it's row-local).
		ctx.error(`${path}.order_by`, `math fn "${fn}" is row-local and does not take order_by`);
		return null;
	}
	return { kind: 'math', column, fn, periods, ...(orderBy !== undefined ? { order_by: orderBy } : {}), as };
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
		// Megaudit Theme B (B7, 2026-05-13): desc must be a real
		// boolean when present. Was: `c.desc === true` silently
		// coerced any non-true value (e.g. "yes") to false without
		// validator error. Use optBool to mirror the rest of the file.
		let desc: boolean | undefined = undefined;
		if (c.desc !== undefined) {
			const b = optBool(ctx, `${path}.columns[${i}].desc`, c.desc);
			if (b === undefined && c.desc !== undefined) {
				// optBool already pushed the error; continue collecting
				// other column errors but treat this one as unset.
				continue;
			}
			desc = b;
		}
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

// Visualise v2 -- `expr` transform validator. Walks the AST received
// over the wire, defending in depth against tampered specs: every node
// kind must be in EXPR_AST_KINDS; every binary op in BINARY_OPS; every
// unary op in UNARY_OPS; every call.fn in WHITELISTED_FNS with arity
// inside FN_ARITY; every numeric literal must be finite; every string
// literal must pass isAcceptableString; depth/node-count must be inside
// EXPR_LIMITS; and the spec's `references` field must exactly equal
// `collectColumnRefs(ast)` so the daemon-side compiler can trust it.
/** Megaudit Theme C (C1, 2026-05-13): iterative pre-flight that bounds
 *  raw-AST depth and node count BEFORE recursive validateExprAst is
 *  called. A hand-crafted JSON spec with 50k nested binary nodes would
 *  otherwise blow V8's recursion stack inside validateExprAst before
 *  the post-validation cap checks could fire. The work-stack walk is
 *  O(nodes) and bounded by EXPR_LIMITS.maxAstNodes. */
function preflightExprAstCaps(ctx: Ctx, rootPath: string, root: unknown): boolean {
	const stack: { node: unknown; path: string; depth: number }[] = [
		{ node: root, path: rootPath, depth: 1 },
	];
	let nodes = 0;
	while (stack.length > 0) {
		const { node, path, depth } = stack.pop()!;
		if (depth > EXPR_LIMITS.maxAstDepth) {
			ctx.error(path, `AST depth exceeds cap ${EXPR_LIMITS.maxAstDepth}`);
			return false;
		}
		nodes += 1;
		if (nodes > EXPR_LIMITS.maxAstNodes) {
			ctx.error(rootPath, `AST node count exceeds cap ${EXPR_LIMITS.maxAstNodes}`);
			return false;
		}
		if (node === null || typeof node !== 'object' || Array.isArray(node)) { continue; }
		const n = node as Record<string, unknown>;
		const childDepth = depth + 1;
		// Push every value that COULD be an AST sub-node. Unknown keys
		// are ignored at this layer; validateExprAst will reject any
		// node whose `kind` is not in EXPR_AST_KINDS.
		if (n.operand !== undefined) {
			stack.push({ node: n.operand, path: `${path}.operand`, depth: childDepth });
		}
		if (n.left !== undefined) {
			stack.push({ node: n.left, path: `${path}.left`, depth: childDepth });
		}
		if (n.right !== undefined) {
			stack.push({ node: n.right, path: `${path}.right`, depth: childDepth });
		}
		if (Array.isArray(n.args)) {
			for (let i = 0; i < n.args.length; i += 1) {
				stack.push({ node: n.args[i], path: `${path}.args[${i}]`, depth: childDepth });
			}
		}
		if (n.cond !== undefined) {
			stack.push({ node: n.cond, path: `${path}.cond`, depth: childDepth });
		}
		if (n.then_ !== undefined) {
			stack.push({ node: n.then_, path: `${path}.then_`, depth: childDepth });
		}
		if (n.else_ !== undefined) {
			stack.push({ node: n.else_, path: `${path}.else_`, depth: childDepth });
		}
	}
	return true;
}

function parseExpr(ctx: Ctx, path: string, obj: Record<string, unknown>): ExprTransform | null {
	const as = expectString(ctx, `${path}.as`, obj.as);
	if (as === null) { return null; }

	const exprRaw = obj.expression;
	if (exprRaw === null || typeof exprRaw !== 'object' || Array.isArray(exprRaw)) {
		ctx.error(`${path}.expression`, `expected object, got ${typeofValue(exprRaw)}`);
		return null;
	}

	// C1 (megaudit): bound depth + node count via iterative walk BEFORE
	// the recursive validateExprAst can stack-blow.
	if (!preflightExprAstCaps(ctx, `${path}.expression`, exprRaw)) {
		return null;
	}

	const ast = validateExprAst(ctx, `${path}.expression`, exprRaw);
	if (ast === null) { return null; }

	// Defense in depth: parser enforces caps too, but a hand-crafted spec
	// could ship an AST that bypasses the parser entirely. After
	// preflight we re-check the post-validation tree because the AST
	// builder may normalize some shapes.
	if (astDepth(ast) > EXPR_LIMITS.maxAstDepth) {
		ctx.error(`${path}.expression`, `AST depth exceeds cap ${EXPR_LIMITS.maxAstDepth}`);
		return null;
	}
	if (astNodeCount(ast) > EXPR_LIMITS.maxAstNodes) {
		ctx.error(`${path}.expression`, `AST node count exceeds cap ${EXPR_LIMITS.maxAstNodes}`);
		return null;
	}

	const references = expectStringArray(ctx, `${path}.references`, obj.references);
	if (references === null) { return null; }
	const computed = collectColumnRefs(ast);
	// Megaudit Theme B (B5, 2026-05-13): compare as sets (with
	// duplicate guard) rather than ordered list. Non-Quantlab spec
	// emitters (Python presets, AI codegen, hand-edits) emit
	// references in alphabetic or insertion order, NOT pre-order. The
	// daemon recomputes from the AST anyway — order isn't a security
	// property.
	const refSet = new Set(references);
	if (references.length !== refSet.size) {
		ctx.error(
			`${path}.references`,
			`duplicate references not allowed: ${JSON.stringify(references)}`,
		);
		return null;
	}
	const computedSet = new Set(computed);
	if (refSet.size !== computedSet.size
		|| [...refSet].some(r => !computedSet.has(r))) {
		ctx.error(
			`${path}.references`,
			`references ${JSON.stringify([...refSet].sort())} != AST refs ${JSON.stringify([...computedSet].sort())}`,
		);
		return null;
	}

	return { kind: 'expr', as, expression: ast, references };
}

function validateExprAst(ctx: Ctx, path: string, x: unknown): ExprAst | null {
	// M3 (megaudit): route through expectObject so the AST node walker
	// runs the same prototype-pollution own-key guard (`__proto__`,
	// `constructor`, `prototype`) as the rest of the validator. The
	// open-coded check this replaces silently allowed those keys.
	const node = expectObject(ctx, path, x);
	if (node === null) { return null; }
	const kind = node.kind;
	if (typeof kind !== 'string' || !EXPR_AST_KINDS.has(kind as ExprAst['kind'])) {
		ctx.error(`${path}.kind`, `unknown ExprAst kind: ${JSON.stringify(kind)}`);
		return null;
	}
	switch (kind as ExprAst['kind']) {
		case 'col': {
			const name = expectString(ctx, `${path}.name`, node.name);
			if (name === null) { return null; }
			return { kind: 'col', name };
		}
		case 'num': {
			const value = expectNumber(ctx, `${path}.value`, node.value);
			if (value === null) { return null; }
			// L5: optional source-form preservation.
			if (node.source === undefined) {
				return { kind: 'num', value };
			}
			const source = expectString(ctx, `${path}.source`, node.source);
			if (source === null) { return null; }
			// Codex audit HIGH (2026-05-12): the printer trusts `source`
			// and the daemon binds `value`. If they diverge — for
			// example a crafted `{ value: 1, source: 'close' }` — the
			// form would render "close" while DuckDB would receive `1`,
			// silently rewriting the user's spec on the next blur.
			// Defend at the wire boundary: `source` must match the
			// parser's numeric grammar AND round-trip to the same value.
			//
			// Codex second pass MEDIUM (2026-05-13): regex must mirror
			// the parser's numeric grammar, which accepts leading-dot
			// decimals (`.5`) via parsePrimary's lookahead. The
			// previous `^\d+(\.\d+)?(...)$` rejected legitimate
			// parser output. Allow either `digits.digits?` or `.digits`.
			if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)) {
				ctx.error(`${path}.source`, `numeric source form ${JSON.stringify(source)} is not a numeric literal`);
				return null;
			}
			if (Number(source) !== value) {
				ctx.error(
					`${path}.source`,
					`numeric source form ${JSON.stringify(source)} parses to ${Number(source)}, not ${value}`,
				);
				return null;
			}
			// Cap the source-form length AFTER format check so a
			// rejected source is reported with the better diagnostic.
			if (source.length > 64) {
				ctx.error(`${path}.source`, `numeric source form exceeds 64 chars: ${source.length}`);
				return null;
			}
			return { kind: 'num', value, source };
		}
		case 'str': {
			const value = expectString(ctx, `${path}.value`, node.value);
			if (value === null) { return null; }
			return { kind: 'str', value };
		}
		case 'bool': {
			if (typeof node.value !== 'boolean') {
				ctx.error(`${path}.value`, `expected boolean, got ${typeofValue(node.value)}`);
				return null;
			}
			return { kind: 'bool', value: node.value };
		}
		case 'null':
			return { kind: 'null' };
		case 'unary': {
			const op = node.op;
			if (typeof op !== 'string' || !UNARY_OPS.has(op as '-' | '!')) {
				ctx.error(`${path}.op`, `unknown unary op: ${JSON.stringify(op)}`);
				return null;
			}
			const operand = validateExprAst(ctx, `${path}.operand`, node.operand);
			if (operand === null) { return null; }
			return { kind: 'unary', op: op as '-' | '!', operand };
		}
		case 'binary': {
			const op = node.op;
			if (typeof op !== 'string' || !BINARY_OPS.has(op as BinaryOp)) {
				ctx.error(`${path}.op`, `unknown binary op: ${JSON.stringify(op)}`);
				return null;
			}
			const left = validateExprAst(ctx, `${path}.left`, node.left);
			const right = validateExprAst(ctx, `${path}.right`, node.right);
			if (left === null || right === null) { return null; }
			return { kind: 'binary', op: op as BinaryOp, left, right };
		}
		case 'call': {
			const fn = node.fn;
			if (typeof fn !== 'string' || !WHITELISTED_FNS.has(fn as WhitelistedFn)) {
				ctx.error(`${path}.fn`, `unknown function: ${JSON.stringify(fn)}`);
				return null;
			}
			if (!Array.isArray(node.args)) {
				ctx.error(`${path}.args`, `expected array, got ${typeofValue(node.args)}`);
				return null;
			}
			const arity = FN_ARITY[fn as WhitelistedFn];
			if (node.args.length < arity.min || node.args.length > arity.max) {
				ctx.error(
					`${path}.args`,
					`function '${fn}' expects ${arity.min === arity.max ? arity.min : `${arity.min}..${arity.max}`} arg(s), got ${node.args.length}`,
				);
				return null;
			}
			const args: ExprAst[] = [];
			for (let i = 0; i < node.args.length; i++) {
				const a = validateExprAst(ctx, `${path}.args[${i}]`, node.args[i]);
				if (a === null) { return null; }
				args.push(a);
			}
			return { kind: 'call', fn: fn as WhitelistedFn, args };
		}
		case 'if': {
			const cond = validateExprAst(ctx, `${path}.cond`, node.cond);
			const then_ = validateExprAst(ctx, `${path}.then_`, node.then_);
			const else_ = validateExprAst(ctx, `${path}.else_`, node.else_);
			if (cond === null || then_ === null || else_ === null) { return null; }
			return { kind: 'if', cond, then_, else_ };
		}
	}
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
	// Megaudit Theme B (B3, 2026-05-13): the `ohlcv` encoding cluster is
	// only meaningful for candlestick charts. The validator previously
	// accepted (a) a `line` chart with stray `ohlcv` encoding (confuses
	// compiler) and (b) a `candlestick` chart MISSING `ohlcv` (which the
	// compiler would reject downstream with a less specific message).
	// Reject both structural mistakes at the wire boundary.
	if (type === 'candlestick' && encodings.ohlcv === undefined) {
		ctx.error(`${path}.encodings.ohlcv`,
			'candlestick chart requires ohlcv encoding cluster');
		return null;
	}
	if (type !== 'candlestick' && encodings.ohlcv !== undefined) {
		ctx.error(`${path}.encodings.ohlcv`,
			`ohlcv encoding is only valid for candlestick (got ${type})`);
		return null;
	}
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
	// Megaudit Theme B (B6, 2026-05-13): optional `volume` was routed
	// through `optString` which silently returned undefined on a
	// present-but-wrong-type value (after recording the error). Mirror
	// the explicit pattern used by other transforms so a wrong type
	// hard-fails the parse.
	let volume: string | undefined = undefined;
	if (obj.volume !== undefined) {
		const v = expectString(ctx, `${path}.volume`, obj.volume);
		if (v === null) { return null; }
		volume = v;
	}
	return { time, open, high, low, close, ...(volume !== undefined ? { volume } : {}) };
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
// Megaudit Theme A (A8, 2026-05-13): tightened to match Marker.shape type
// in spec.ts. The validator previously accepted 'diamond' and 'triangle'
// which the type and renderer do not support.
const MARKER_SHAPES = ['arrowUp', 'arrowDown', 'circle', 'square'] as const;

/** A7 (megaudit): Marker.time is typed `string | number` and the renderer
 *  needs numeric epoch markers (the obvious case for timeseries). The
 *  previous validator went through expectString which rejected all
 *  numeric inputs. */
function parseMarkerTime(ctx: Ctx, path: string, x: unknown): string | number | null {
	if (typeof x === 'number') {
		if (!Number.isFinite(x)) {
			ctx.error(path, `expected finite number, got ${x}`);
			return null;
		}
		return x;
	}
	if (typeof x === 'string') {
		return expectString(ctx, path, x);
	}
	ctx.error(path, `expected string or finite number, got ${typeofValue(x)}`);
	return null;
}

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
		// A6 (megaudit): `time` is REQUIRED. The previous code padded
		// missing `time` to empty string, which silently placed markers
		// at empty-string coordinate — a real bug in the renderer.
		if (m.time === undefined || m.time === null) {
			ctx.error(`${path}[${i}].time`, 'required');
			return null;
		}
		const time = parseMarkerTime(ctx, `${path}[${i}].time`, m.time);
		if (time === null) { return null; }
		const label = m.label !== undefined ? expectString(ctx, `${path}[${i}].label`, m.label) : undefined;
		const color = m.color !== undefined ? expectString(ctx, `${path}[${i}].color`, m.color) : undefined;
		const shape = m.shape !== undefined
			? expectEnum(ctx, `${path}[${i}].shape`, m.shape, MARKER_SHAPES)
			: undefined;
		if (m.label !== undefined && label === null) { return null; }
		if (m.color !== undefined && color === null) { return null; }
		if (m.shape !== undefined && shape === null) { return null; }
		out.push({
			time,
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
	// Megaudit Theme B (B8, 2026-05-13): precision means a count of
	// decimal places — must be a non-negative integer in a sane range.
	// Was: bare expectNumber accepted -1.5, 1e9, etc.
	const checkPrecision = (label: 'price' | 'quantity'): number | undefined => {
		const v = obj[label];
		if (v === undefined) { return undefined; }
		const n = expectNumber(ctx, `${path}.${label}`, v);
		if (n === null) { return undefined; }
		if (!Number.isSafeInteger(n) || n < 0 || n > 18) {
			ctx.error(`${path}.${label}`, `must be integer in [0, 18], got ${n}`);
			return undefined;
		}
		return n;
	};
	return {
		price: checkPrecision('price'),
		quantity: checkPrecision('quantity'),
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
	// Megaudit Theme B (B4, 2026-05-13): tool_versions.qviz_schema must
	// MATCH the top-level qviz_version. The top-level was already gated
	// but its duplicate in tool_versions wasn't, so a spec could
	// silently round-trip with mismatched attribution.
	if (tv.qviz_schema !== QVIZ_SCHEMA_VERSION) {
		ctx.error(`${path}.tool_versions.qviz_schema`,
			`expected ${QVIZ_SCHEMA_VERSION}, got ${JSON.stringify(tv.qviz_schema)}`);
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
