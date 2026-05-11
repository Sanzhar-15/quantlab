"""Compile a canonical QvizSpec into a single DuckDB SQL query.

Strategy: build a CTE chain, one CTE per transform, ending in a final SELECT.
DuckDB's optimizer handles the resulting plan globally.

Security model:
  - Column names come from the *schema* of the file, never the spec text. The
    spec references columns by name; we validate they exist in the schema and
    quote them as SQL identifiers using DuckDB's quoting rules. This means an
    attacker cannot inject SQL via column references.
  - Literal *values* in filters are parameterized — bound through DuckDB's
    parameter API, never inlined into the SQL string.
  - Transform "kind" is a closed set; unknown kinds are rejected at validation
    time. The compiler never has to handle untrusted operator strings.
  - Aggregation/window function names are mapped through a whitelist.
  - There is NO eval. There is NO user-authored expression language in v1.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pyarrow as pa


# ---------------------------------------------------------------------------
# Result of a compile pass
# ---------------------------------------------------------------------------


@dataclass
class CompiledQuery:
    sql: str
    params: list
    final_columns: list[str]
    """Names of columns in the final SELECT (in order)."""

    def __repr__(self) -> str:
        return f"CompiledQuery(sql={self.sql!r}, params={self.params!r})"


class CompileError(Exception):
    """Raised when a spec is structurally valid but cannot be compiled to SQL,
    e.g., references a column not present in the file schema."""


# ---------------------------------------------------------------------------
# Whitelisted SQL fragments
# ---------------------------------------------------------------------------

# pyarrow → SQL not always 1:1. Keep maps small and explicit.
_AGG_FN_MAP = {
    "sum": "sum",
    "mean": "avg",
    "median": "median",
    "min": "min",
    "max": "max",
    "count": "count",
    "std": "stddev_samp",
    "first": "first",
    "last": "last",
}

_DATE_TRUNC_UNITS = {
    "second", "minute", "hour", "day", "week", "month", "quarter", "year"
}

_WINDOW_FN_MAP = {
    "rolling_mean": "avg",
    "rolling_std": "stddev_samp",
    "rolling_min": "min",
    "rolling_max": "max",
    "cumsum": "sum",
    "cumprod": "product",
    "cummax": "max",
    "cummin": "min",
    # ema handled specially — recursive CTE (v2). For now, raise.
}

_MATH_FN_MAP = {
    "log": "ln",
    "log10": "log10",
    "exp": "exp",
    "abs": "abs",
    "sqrt": "sqrt",
}

_FILL_MAP = {"forward": "ffill", "backward": "bfill", "zero": "zero", "null": "null"}


# ---------------------------------------------------------------------------
# Identifier quoting (DuckDB)
# ---------------------------------------------------------------------------


def quote_ident(name: str) -> str:
    """Quote a column or table name as a DuckDB identifier.

    DuckDB uses double quotes; embedded double-quotes are escaped by doubling.
    This is the ONLY way user-supplied names enter SQL — they're never
    interpolated raw.
    """
    if not isinstance(name, str) or not name:
        raise CompileError(f"identifier must be non-empty string: {name!r}")
    return '"' + name.replace('"', '""') + '"'


# ---------------------------------------------------------------------------
# Compile entry point
# ---------------------------------------------------------------------------


def compile_spec(spec: dict, schema: pa.Schema, file_path: str) -> CompiledQuery:
    """Compile a validated QvizSpec dict to DuckDB SQL.

    Args:
      spec: dict matching QvizSpec (already validated by the TS validator;
            this compiler does additional column-existence checks).
      schema: pyarrow schema of the source file.
      file_path: path to the parquet/csv file. Bound as the first parameter.

    Returns:
      CompiledQuery with .sql (CTE chain) and .params (positional bindings).
    """
    available_columns = {schema.names[i]: schema.field(i) for i in range(len(schema.names))}

    ctx = _CompileCtx(available_columns=available_columns)

    transforms = list(spec.get("transforms", []))
    chart = spec.get("chart") or {}

    # Build CTE chain. Start with reading the file.
    cte_idx = 0
    cte_name = f"t{cte_idx}"
    ctx.ctes.append(_make_source_cte(cte_name, file_path, ctx))
    available = set(available_columns.keys())

    for t in transforms:
        cte_idx += 1
        next_cte_name = f"t{cte_idx}"
        cte_sql, available = _compile_transform(cte_name, next_cte_name, t, available, ctx)
        ctx.ctes.append(cte_sql)
        cte_name = next_cte_name

    # Validate encodings reference real columns in the final state.
    encodings = chart.get("encodings", {})
    _validate_encodings_reference_columns(encodings, available)

    # Final select with explicit limit cap.
    chart_options = chart.get("options") or {}
    final_limit = ctx.cap

    final_columns = _final_columns_for(spec, available)
    select_clause = ", ".join(quote_ident(c) for c in final_columns) if final_columns else "*"
    final_sql = f"SELECT {select_clause} FROM {cte_name} LIMIT {final_limit}"

    sql = "WITH " + ",\n     ".join(ctx.ctes) + "\n" + final_sql

    return CompiledQuery(sql=sql, params=ctx.params, final_columns=final_columns)


def _final_columns_for(spec: dict, available: set[str]) -> list[str]:
    """Project only columns the chart actually consumes (audit finding #6).

    Avoids leaking intermediate columns (e.g. a 'day' alias from date_trunc
    plus the original 'timestamp') to the renderer, which would change the
    response shape and confuse encoding lookup.

    Falls back to all available columns when no encodings are present (rare,
    only happens in tests or pure-data export use cases).
    """
    chart = spec.get("chart") or {}
    encodings = chart.get("encodings") or {}
    referenced: set[str] = set()
    for enc_name, enc in encodings.items():
        if not enc:
            continue
        if enc_name == "ohlcv":
            for f in ("time", "open", "high", "low", "close", "volume"):
                v = enc.get(f)
                if isinstance(v, str) and v in available:
                    referenced.add(v)
        else:
            f = enc.get("field") if isinstance(enc, dict) else None
            if isinstance(f, str) and f in available:
                referenced.add(f)
    if not referenced:
        return sorted(available)
    # Stable order: encoding-referenced columns first, alphabetised.
    return sorted(referenced)


# ---------------------------------------------------------------------------
# Compilation context (mutable)
# ---------------------------------------------------------------------------


@dataclass
class _CompileCtx:
    available_columns: dict[str, pa.Field]
    """Original schema — used for type-aware compilation choices."""
    ctes: list[str] = field(default_factory=list)
    params: list = field(default_factory=list)
    cap: int = 1_000_000
    """Final SELECT row cap. Hard ceiling unless overridden by an explicit
    Limit transform that lowers it further."""


# ---------------------------------------------------------------------------
# Source CTE
# ---------------------------------------------------------------------------


def _make_source_cte(name: str, file_path: str, ctx: _CompileCtx) -> str:
    """Build the t0 CTE that reads from the source file.

    DuckDB has read_parquet, read_csv_auto, etc. We pick by extension. The
    file path is parameterized — never interpolated into SQL text.
    """
    suffix = file_path.lower().rsplit(".", 1)[-1] if "." in file_path else ""
    if suffix == "parquet":
        ctx.params.insert(0, file_path)
        return f"{name} AS (SELECT * FROM read_parquet(?))"
    if suffix in ("csv", "tsv"):
        ctx.params.insert(0, file_path)
        delim = "\\t" if suffix == "tsv" else ","
        return (
            f"{name} AS (SELECT * FROM read_csv_auto(?, "
            f"delim='{delim}', header=true, sample_size=-1))"
        )
    raise CompileError(f"unsupported file extension for SQL source: {suffix!r}")


# ---------------------------------------------------------------------------
# Per-transform compilation
# ---------------------------------------------------------------------------


def _compile_transform(
    prev_cte: str, next_cte: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    """Returns (cte_sql, new_available_columns)."""
    kind = t.get("kind")
    if kind == "filter":
        return _compile_filter(prev_cte, next_cte, t, available, ctx)
    if kind == "date_trunc":
        return _compile_date_trunc(prev_cte, next_cte, t, available, ctx)
    if kind == "bin":
        return _compile_bin(prev_cte, next_cte, t, available, ctx)
    if kind == "groupby":
        # groupby alone is a no-op; it must be followed by aggregate.
        # The pattern we accept is groupby+aggregate as adjacent transforms.
        # We compile them together by looking ahead — but our pipeline is
        # dict-by-dict, so we encode it as: groupby buffers state on ctx,
        # the next aggregate consumes it.
        ctx_attach = getattr(ctx, "_pending_groupby", None)
        if ctx_attach is not None:
            raise CompileError("two consecutive groupby transforms (forgot aggregate?)")
        ctx._pending_groupby = list(t.get("columns", []))  # type: ignore[attr-defined]
        # Pass-through CTE so the chain stays linear.
        return f"{next_cte} AS (SELECT * FROM {prev_cte})", available
    if kind == "aggregate":
        return _compile_aggregate(prev_cte, next_cte, t, available, ctx)
    if kind == "window":
        return _compile_window(prev_cte, next_cte, t, available, ctx)
    if kind == "math":
        return _compile_math(prev_cte, next_cte, t, available, ctx)
    if kind == "tz_convert":
        return _compile_tz_convert(prev_cte, next_cte, t, available, ctx)
    if kind == "sort":
        return _compile_sort(prev_cte, next_cte, t, available, ctx)
    if kind == "limit":
        return _compile_limit(prev_cte, next_cte, t, available, ctx)
    if kind == "resample":
        raise CompileError("resample transform: not implemented in v1 (uses pandas in v2)")
    raise CompileError(f"unknown transform kind: {kind!r}")


def _compile_filter(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]
    _require_column(col, available)
    op = t["op"]
    value = t.get("value")

    if op in ("is_null", "not_null"):
        sql_op = "IS NULL" if op == "is_null" else "IS NOT NULL"
        where = f"{quote_ident(col)} {sql_op}"
    elif op in ("in", "not_in"):
        if not isinstance(value, list):
            raise CompileError(f"filter op {op!r} requires a list value")
        if len(value) == 0:
            # Audit M-G (2026-05-11): empty `in` is a legitimate empty-set
            # filter coming from the inspector's "uncheck-all" widget.
            # Match daemon.py:_compile_inspector_filters_to_sql semantics
            # so the chart-aggregate path agrees with the table-preview
            # path. Emit a constant FALSE/TRUE predicate via the WHERE
            # clause; no params are bound.
            where = "FALSE" if op == "in" else "TRUE"
        else:
            placeholders = ", ".join("?" for _ in value)
            ctx.params.extend(value)
            sql_op = "IN" if op == "in" else "NOT IN"
            where = f"{quote_ident(col)} {sql_op} ({placeholders})"
    elif op in ("==", "!=", "<", "<=", ">", ">="):
        sql_op = {"==": "=", "!=": "<>"}.get(op, op)
        ctx.params.append(value)
        where = f"{quote_ident(col)} {sql_op} ?"
    elif op == "contains":
        # Phase 6: case-insensitive substring match for the inspector's
        # text filter widget. Compiles to:
        #   lower(CAST(col AS VARCHAR)) LIKE lower(?) ESCAPE '\'
        # so DuckDB's ICU `lower()` runs on BOTH the column value AND
        # the bound parameter, avoiding the Python-vs-DuckDB case-fold
        # divergence (audit M-16: Python's `"İ".lower()` = `"i̇"` but
        # DuckDB's `lower("İ")` = `"i"` under ICU; pre-lowering in
        # Python silently misses Turkish, German `ß`, etc.). Also
        # escapes `%`/`_`/`\` (audit M-H) so user input is treated as
        # literal text, not SQL wildcards.
        if not isinstance(value, str):
            raise CompileError(f"filter op 'contains' requires a string value")
        escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        ctx.params.append(f"%{escaped}%")
        where = f"lower(CAST({quote_ident(col)} AS VARCHAR)) LIKE lower(?) ESCAPE '\\'"
    else:
        raise CompileError(f"unknown filter op: {op!r}")

    return f"{nxt} AS (SELECT * FROM {prev} WHERE {where})", available


def _compile_date_trunc(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]; unit = t["unit"]; alias = t["as"]
    _require_column(col, available)
    if unit not in _DATE_TRUNC_UNITS:
        raise CompileError(f"unknown date_trunc unit: {unit!r}")
    expr = f"date_trunc('{unit}', {quote_ident(col)})"
    sql = f"{nxt} AS (SELECT *, {expr} AS {quote_ident(alias)} FROM {prev})"
    return sql, available | {alias}


def _compile_bin(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]; n_bins = int(t["n_bins"]); alias = t["as"]
    _require_column(col, available)
    if n_bins < 2 or n_bins > 1000:
        raise CompileError(f"bin n_bins out of range: {n_bins}")
    qcol = quote_ident(col)
    qalias = quote_ident(alias)
    # Equal-width binning. Compute (col - min) / ((max - min) / N) and clamp to [0, N-1].
    expr = (
        f"CAST(LEAST({n_bins} - 1, GREATEST(0, FLOOR("
        f"({qcol} - (SELECT min({qcol}) FROM {prev})) "
        f"/ NULLIF(((SELECT max({qcol}) FROM {prev}) - (SELECT min({qcol}) FROM {prev})) / {n_bins}, 0)"
        f"))) AS INTEGER)"
    )
    sql = f"{nxt} AS (SELECT *, {expr} AS {qalias} FROM {prev})"
    return sql, available | {alias}


def _compile_aggregate(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    aggs = t["aggs"]
    if not aggs:
        raise CompileError("aggregate must have at least one agg")
    pending_gb: list[str] | None = getattr(ctx, "_pending_groupby", None)
    if pending_gb is not None:
        for c in pending_gb:
            _require_column(c, available)
        delattr(ctx, "_pending_groupby")
        gb_select = ", ".join(quote_ident(c) for c in pending_gb)
        gb_clause = f"GROUP BY {gb_select}"
        out_cols = set(pending_gb)
    else:
        # Aggregate without preceding groupby: produces a single row.
        gb_select = ""
        gb_clause = ""
        out_cols = set()

    agg_parts = []
    for a in aggs:
        col = a["column"]; fn = a["fn"]; alias = a["as"]
        # 'count' may be applied to nullable columns; everywhere else we still
        # require the column to exist in the input.
        _require_column(col, available)
        if fn not in _AGG_FN_MAP:
            raise CompileError(f"unknown agg fn: {fn!r}")
        sql_fn = _AGG_FN_MAP[fn]
        # Audit-fix slate: DuckDB returns HUGEINT for SUM(BIGINT) and Decimal
        # for SUM(DECIMAL). pyarrow then serializes those as Arrow Decimal,
        # which the TS extractor (extract-arrow.ts) rejects loudly because
        # Arrow Decimal needs scale-aware extraction. To keep the wire
        # format renderer-friendly, cast the aggregate result to DOUBLE for
        # numeric-summable functions. `count` returns BIGINT and stays
        # exact; `first`/`last` preserve the source dtype (no cast needed).
        if fn in ("sum", "mean", "median", "min", "max", "std"):
            expr = f"CAST({sql_fn}({quote_ident(col)}) AS DOUBLE)"
        else:
            expr = f"{sql_fn}({quote_ident(col)})"
        agg_parts.append(f"{expr} AS {quote_ident(alias)}")
        out_cols.add(alias)

    select_clause = ", ".join(filter(None, [gb_select, ", ".join(agg_parts)]))
    sql = f"{nxt} AS (SELECT {select_clause} FROM {prev} {gb_clause})"
    return sql, out_cols


def _compile_window(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]; fn = t["fn"]; alias = t["as"]
    _require_column(col, available)

    if fn == "ema":
        raise CompileError("ema window: not implemented in v1 (recursive CTE in v2)")
    if fn not in _WINDOW_FN_MAP:
        raise CompileError(f"unknown window fn: {fn!r}")

    sql_fn = _WINDOW_FN_MAP[fn]
    qcol = quote_ident(col)
    qalias = quote_ident(alias)

    if fn.startswith("rolling_"):
        window = t.get("window")
        if window is None or int(window) < 1:
            raise CompileError(f"rolling fn {fn!r} requires window >= 1")
        w = int(window)
        # Frame: ROWS BETWEEN (w-1) PRECEDING AND CURRENT ROW
        expr = f"{sql_fn}({qcol}) OVER (ROWS BETWEEN {w - 1} PRECEDING AND CURRENT ROW)"
    else:
        # cumulative: ROWS UNBOUNDED PRECEDING AND CURRENT ROW
        expr = f"{sql_fn}({qcol}) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"

    sql = f"{nxt} AS (SELECT *, {expr} AS {qalias} FROM {prev})"
    return sql, available | {alias}


def _compile_math(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]; fn = t["fn"]; alias = t["as"]
    _require_column(col, available)
    qcol = quote_ident(col)
    qalias = quote_ident(alias)

    if fn in _MATH_FN_MAP:
        expr = f"{_MATH_FN_MAP[fn]}({qcol})"
    elif fn == "log_returns":
        # ln(x / lag(x))
        expr = f"ln({qcol} / lag({qcol}, 1) OVER ())"
    elif fn == "pct_change":
        periods = int(t.get("periods", 1))
        if periods < 1 or periods > 1_000_000:
            raise CompileError(f"pct_change periods out of range: {periods}")
        expr = f"({qcol} / lag({qcol}, {periods}) OVER ()) - 1"
    elif fn == "drawdown":
        # (equity - cummax(equity)) / cummax(equity)
        expr = (
            f"({qcol} - max({qcol}) OVER (ROWS UNBOUNDED PRECEDING)) "
            f"/ NULLIF(max({qcol}) OVER (ROWS UNBOUNDED PRECEDING), 0)"
        )
    else:
        raise CompileError(f"unknown math fn: {fn!r}")

    sql = f"{nxt} AS (SELECT *, {expr} AS {qalias} FROM {prev})"
    return sql, available | {alias}


def _compile_tz_convert(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]; to_tz = t["to_tz"]; alias = t.get("as", col)
    _require_column(col, available)
    # Validate timezone string contains only safe chars; bind as parameter to
    # prevent injection via the AT TIME ZONE clause.
    if not isinstance(to_tz, str) or not _is_safe_tz(to_tz):
        raise CompileError(f"invalid timezone: {to_tz!r}")
    qcol = quote_ident(col)
    qalias = quote_ident(alias)
    # NB: tz strings are an enum-like set; quoting as literal is fine here
    # because we whitelisted the character set above.
    expr = f"timezone('{to_tz}', {qcol})"
    if alias == col:
        # Replace column in-place via SELECT * EXCLUDE ... + new col
        sql = (
            f"{nxt} AS (SELECT * EXCLUDE ({qcol}), {expr} AS {qcol} FROM {prev})"
        )
        return sql, available
    sql = f"{nxt} AS (SELECT *, {expr} AS {qalias} FROM {prev})"
    return sql, available | {alias}


def _compile_sort(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    cols = t["columns"]
    if not cols:
        raise CompileError("sort requires at least one column")
    parts = []
    for c in cols:
        col = c["column"]
        desc = c.get("desc") is True
        _require_column(col, available)
        parts.append(f"{quote_ident(col)} {'DESC' if desc else 'ASC'}")
    sql = f"{nxt} AS (SELECT * FROM {prev} ORDER BY {', '.join(parts)})"
    return sql, available


def _compile_limit(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    n = int(t["n"])
    offset = int(t.get("offset", 0))
    if n < 1 or n > 10_000_000:
        raise CompileError(f"limit n out of range: {n}")
    if offset < 0:
        raise CompileError(f"limit offset must be >= 0: {offset}")
    # Tighten the global cap if the user-specified limit is smaller.
    ctx.cap = min(ctx.cap, n)
    if offset > 0:
        sql = f"{nxt} AS (SELECT * FROM {prev} LIMIT {n} OFFSET {offset})"
    else:
        sql = f"{nxt} AS (SELECT * FROM {prev} LIMIT {n})"
    return sql, available


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_column(col: str, available: set[str]) -> None:
    if col not in available:
        raise CompileError(
            f"column {col!r} not in pipeline output (available: {sorted(available)})"
        )


def _validate_encodings_reference_columns(encodings: dict, available: set[str]) -> None:
    """Each encoding's `field` must be in the final pipeline columns."""
    for enc_name, enc in encodings.items():
        if not enc:
            continue
        if enc_name == "ohlcv":
            for ohlcv_field in ("time", "open", "high", "low", "close", "volume"):
                v = enc.get(ohlcv_field)
                if v is not None and v not in available:
                    raise CompileError(
                        f"chart.encodings.ohlcv.{ohlcv_field}={v!r} not in pipeline columns"
                    )
        else:
            f = enc.get("field")
            if f is not None and f not in available:
                raise CompileError(
                    f"chart.encodings.{enc_name}.field={f!r} not in pipeline columns"
                )


_TZ_CHARS = set(
    "abcdefghijklmnopqrstuvwxyz" "ABCDEFGHIJKLMNOPQRSTUVWXYZ" "0123456789" "/_-+"
)


def _is_safe_tz(tz: str) -> bool:
    """Allowlist: IANA tz names only contain alphanum, /, _, -, +."""
    return bool(tz) and all(ch in _TZ_CHARS for ch in tz)
