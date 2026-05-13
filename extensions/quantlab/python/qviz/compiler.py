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
    warnings: list[str] = field(default_factory=list)
    """Megaudit G5 (2026-05-13): structured warnings surfaced from the
    compile pass. Today populated by `_compile_aggregate` when a
    numeric aggregate (`sum`/`mean`/`median`/`std`) over a
    DECIMAL or 64-bit-integer source column casts to DOUBLE, which
    loses precision above 2^53. The daemon forwards these to the
    aggregate response's `data.warnings` so the webview can surface
    them in the diagnostics readout. Empty list = no warnings."""

    def __repr__(self) -> str:
        return f"CompiledQuery(sql={self.sql!r}, params={self.params!r})"


class CompileError(Exception):
    """Raised when a spec is structurally valid but cannot be compiled to SQL,
    e.g., references a column not present in the file schema."""


def _safe_int_literal(
    name: str, v: object, *, lo: int = 0, hi: int = 10_000_000
) -> str:
    """Validate and stringify an int destined for f-string SQL interpolation.

    Defensive funnel: every existing call site already range-checks, but
    routing all int interpolation through one helper prevents drift if a
    new transform adds an interpolation site and forgets the check
    (audit G1, 2026-05-13). Out-of-range / non-int inputs raise
    CompileError so the daemon's error-kind classifier tags them as
    ``compile`` (not ``internal``).

    ``isinstance(v, bool)`` is the explicit-rejection clause: bool is a
    subclass of int in Python, so without it ``True`` would silently
    coerce to ``"1"`` and ``False`` to ``"0"``.
    """
    if isinstance(v, bool) or not isinstance(v, int):
        raise CompileError(
            f"{name}: expected int, got {type(v).__name__}"
        )
    if v < lo or v > hi:
        raise CompileError(f"{name}={v} out of range [{lo}, {hi}]")
    return str(v)


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

# Visualise v2 `expr` transform: closed-grammar expression language.
# Each AST binary op maps to a single DuckDB SQL operator; `==` and `!=`
# normalize to SQL `=` / `<>` and `&&` / `||` normalize to keyword logical
# operators. Operators are validated against this map BEFORE emission so
# an attacker who tampers with the spec cannot inject arbitrary text.
_EXPR_BINARY_OP_MAP: dict[str, str] = {
    "+": "+", "-": "-", "*": "*", "/": "/", "%": "%",
    "==": "=", "!=": "<>",
    "<": "<", "<=": "<=", ">": ">", ">=": ">=",
    "&&": "AND", "||": "OR",
}

# Whitelisted scalar functions for the `expr` transform. Note `min` /
# `max` map to DuckDB's `least` / `greatest` (the scalar pairwise forms;
# `min` and `max` are aggregate-only in standard SQL). `log` and `ln`
# both map to `ln` to match `MathTransform`'s historical convention
# (natural log).
_EXPR_FN_MAP: dict[str, str] = {
    "abs": "abs",
    "log": "ln",
    "ln": "ln",
    "log10": "log10",
    "exp": "exp",
    "sqrt": "sqrt",
    "min": "least",
    "max": "greatest",
    "coalesce": "coalesce",
    "nullif": "nullif",
}

# Arity bounds parallel to `extensions/quantlab/src/qviz/exprAst.ts:FN_ARITY`.
# The TS validator already enforces these; the compiler re-checks at the
# wire boundary so a hand-crafted spec cannot bypass them.
_EXPR_FN_ARITY: dict[str, tuple[int, int]] = {
    "abs": (1, 1), "log": (1, 1), "log10": (1, 1), "ln": (1, 1),
    "exp": (1, 1), "sqrt": (1, 1),
    "min": (2, 2), "max": (2, 2),
    "coalesce": (1, 32), "nullif": (2, 2),
}

# Caps that mirror `EXPR_LIMITS` in TS-side `exprAst.ts`. Defense in
# depth -- the parser + validator already enforce, but a daemon that
# accepts directly-injected AST JSON (e.g. via a corrupt cache file or a
# malicious extension) must still be bounded.
_EXPR_MAX_AST_DEPTH = 16
_EXPR_MAX_AST_NODES = 256


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


def compile_spec(
    spec: dict,
    schema: pa.Schema,
    file_path: str,
    *,
    implicit_final_limit: bool = True,
) -> CompiledQuery:
    """Compile a validated QvizSpec dict to DuckDB SQL.

    Args:
      spec: dict matching QvizSpec (already validated by the TS validator;
            this compiler does additional column-existence checks).
      schema: pyarrow schema of the source file.
      file_path: path to the parquet/csv file. Bound as the first parameter.
      implicit_final_limit: when True (default), append `LIMIT {ctx.cap}`
        to the final SELECT. The inspector's pagination path
        (`_preview_via_compile`) wraps the compiled SQL with its own
        outer `LIMIT n OFFSET offset` + `COUNT(*) AS total`. If the inner
        SQL also carries an implicit cap, the reported `total` would top
        out at `min(ctx.cap, true_total)` — wrong for huge aggregates.
        Pass `False` from that path; outer caps remain authoritative.
        (Megaudit Theme A A10, 2026-05-13.)

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

    # Megaudit Theme G (G7, 2026-05-13): a trailing `groupby` with no
    # following `aggregate` leaves state on the context forever. The
    # validator already rejects this orphan pattern; mirror the gate
    # here as defense in depth so a hand-crafted spec that bypasses
    # the validator can't silently no-op.
    if getattr(ctx, "_pending_groupby", None) is not None:
        raise CompileError(
            "groupby must be immediately followed by aggregate; "
            "trailing groupby with no aggregate is invalid"
        )

    # Validate encodings reference real columns in the final state.
    encodings = chart.get("encodings", {})
    _validate_encodings_reference_columns(encodings, available)

    chart_options = chart.get("options") or {}
    final_columns = _final_columns_for(spec, available)
    select_clause = ", ".join(quote_ident(c) for c in final_columns) if final_columns else "*"
    if implicit_final_limit:
        cap_lit = _safe_int_literal(
            "final limit cap", ctx.cap, lo=1, hi=1_000_000
        )
        final_sql = f"SELECT {select_clause} FROM {cte_name} LIMIT {cap_lit}"
    else:
        final_sql = f"SELECT {select_clause} FROM {cte_name}"

    sql = "WITH " + ",\n     ".join(ctx.ctes) + "\n" + final_sql

    return CompiledQuery(
        sql=sql, params=ctx.params, final_columns=final_columns,
        warnings=list(ctx.warnings),
    )


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
    warnings: list[str] = field(default_factory=list)
    """Megaudit G5 (2026-05-13): structured warnings emitted during
    compile (e.g. precision-loss on aggregate-to-DOUBLE casts).
    Copied to `CompiledQuery.warnings` at the end of `compile_spec`."""


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
    if kind == "expr":
        return _compile_expr(prev_cte, next_cte, t, available, ctx)
    if kind == "resample":
        # Megaudit Theme G (G6, 2026-05-13): standardized format for
        # unsupported variants — daemon_version + supported list + hint.
        raise CompileError(
            "transform 'resample' is not supported by this daemon "
            "(daemon_version=1). Use date_trunc + groupby + aggregate "
            "for grouped aggregation by time bucket. Implementation "
            "deferred to pandas v2 integration."
        )
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
            # Megaudit D8 (2026-05-13) -- codex audit caught this path:
            # `compile_spec` is invoked from BOTH the chart aggregate
            # pipeline (when inspector filters are prepended) AND the
            # `_preview_via_compile` inspector route. Both paths must
            # agree with `_compile_inspector_filters_to_sql` in
            # daemon.py — lift None into an `IS NULL` clause so the
            # trivalent-logic trap of `col IN (NULL, ...)` excluding
            # NULL rows is avoided.
            qcol = quote_ident(col)
            has_null = any(v is None for v in value)
            non_null = [v for v in value if v is not None]
            if op == "in":
                clauses: list[str] = []
                if has_null:
                    clauses.append(f"{qcol} IS NULL")
                if non_null:
                    placeholders = ", ".join("?" for _ in non_null)
                    clauses.append(f"{qcol} IN ({placeholders})")
                    ctx.params.extend(non_null)
                where = " OR ".join(clauses) if clauses else "FALSE"
            else:
                clauses_n: list[str] = []
                if has_null:
                    clauses_n.append(f"{qcol} IS NOT NULL")
                if non_null:
                    placeholders = ", ".join("?" for _ in non_null)
                    clauses_n.append(f"{qcol} NOT IN ({placeholders})")
                    ctx.params.extend(non_null)
                where = " AND ".join(clauses_n) if clauses_n else "TRUE"
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
    col = t["column"]; alias = t["as"]
    _require_column(col, available)
    # Megaudit G1 (2026-05-13): the helper validates int-ness strictly
    # (rejects bool / float / str). Dropping the upstream `int(...)`
    # pre-cast keeps validation consistent with _compile_window /
    # _compile_math, which already let the helper be the single
    # contract.
    n_bins = t["n_bins"]
    n_bins_lit = _safe_int_literal("bin n_bins", n_bins, lo=2, hi=1000)
    n_bins_minus_one_lit = _safe_int_literal(
        "bin n_bins-1", n_bins - 1, lo=1, hi=999
    )
    qcol = quote_ident(col)
    qalias = quote_ident(alias)
    # Equal-width binning. Compute (col - min) / ((max - min) / N) and clamp to [0, N-1].
    # Megaudit Theme A (A5, 2026-05-13): outer CASE protects against
    # all-equal columns (max == min). Without it, NULLIF turns the
    # denominator into NULL and every row's bin becomes NULL — chart
    # silently drops every point with no error. With the CASE, an
    # all-equal column legitimately bins to a single bucket (0).
    min_expr = f"(SELECT min({qcol}) FROM {prev})"
    max_expr = f"(SELECT max({qcol}) FROM {prev})"
    bucket = (
        f"CAST(LEAST({n_bins_minus_one_lit}, GREATEST(0, FLOOR("
        f"({qcol} - {min_expr}) / NULLIF(({max_expr} - {min_expr}) / {n_bins_lit}, 0)"
        f"))) AS INTEGER)"
    )
    expr = f"CASE WHEN {max_expr} = {min_expr} THEN 0 ELSE {bucket} END"
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
        # Megaudit Theme A (A4, 2026-05-13): type-aware aggregate cast.
        # Previously all numeric aggregates (sum/mean/median/min/max/std)
        # were blanket-cast to DOUBLE. Applied to a string/temporal column
        # (a legitimate aggregate like `min(symbol)`) DuckDB raised an
        # opaque type-conversion error rather than a structured
        # CompileError. Now: cast to DOUBLE only when the source is
        # numeric; for sum/mean/median/std on non-numeric, raise
        # CompileError; for min/max on non-numeric, preserve source dtype.
        col_field = ctx.available_columns.get(col)
        is_numeric = col_field is not None and (
            pa.types.is_integer(col_field.type)
            or pa.types.is_floating(col_field.type)
            or pa.types.is_decimal(col_field.type)
        )
        if fn in ("sum", "mean", "median", "std"):
            if not is_numeric:
                col_type = str(col_field.type) if col_field else "unknown"
                raise CompileError(
                    f"aggregate fn {fn!r} requires numeric column; "
                    f"{col!r} is {col_type}"
                )
            expr = f"CAST({sql_fn}({quote_ident(col)}) AS DOUBLE)"
            # Megaudit G5 (2026-05-13): emit a precision-loss warning
            # when the source column is DECIMAL or a 64-bit integer.
            # DOUBLE has 53 bits of mantissa; `sum(BIGINT)` past 2^53
            # silently loses ones-place precision, and `mean/sum` over
            # `DECIMAL(p,s)` loses cents at large magnitudes. The
            # extractor on the TS side (`extract-arrow.ts`) currently
            # rejects Arrow Decimal columns, so REMOVING the cast
            # would break the chart pipeline entirely. Option B
            # (preserve types end-to-end + teach the extractor +
            # renderer contract for exact decimals) is tracked as a
            # follow-up; this warning makes the precision loss
            # VISIBLE rather than silent.
            if col_field is not None:
                ct = col_field.type
                if pa.types.is_decimal(ct):
                    ctx.warnings.append(
                        f"aggregate {fn!r} on DECIMAL column {col!r} "
                        f"casts to DOUBLE; fractional precision may be "
                        f"lost at large magnitudes (alias {alias!r})"
                    )
                elif pa.types.is_int64(ct) or pa.types.is_uint64(ct):
                    ctx.warnings.append(
                        f"aggregate {fn!r} on 64-bit integer column "
                        f"{col!r} casts to DOUBLE; values past 2^53 "
                        f"(~9e15) lose ones-place precision "
                        f"(alias {alias!r})"
                    )
                elif fn == "sum" and (
                    pa.types.is_int32(ct) or pa.types.is_uint32(ct)
                ):
                    # Codex G5 audit (2026-05-13): `sum(int32)` over many
                    # rows can exceed 2^53. With a 1M-row cap each value
                    # at int32 max ~2.1e9, the sum reaches ~2.1e15 — under
                    # 2^53 (~9e15), so safe in practice. But the cap can
                    # be raised by callers; warn so the precision risk is
                    # visible if/when it materialises. mean/median/std/
                    # min/max on int32 are NOT warned: those produce
                    # values near the source magnitudes, well under 2^53.
                    ctx.warnings.append(
                        f"aggregate 'sum' on 32-bit integer column "
                        f"{col!r} casts to DOUBLE; running totals past "
                        f"2^53 (~9e15) would lose ones-place precision "
                        f"(alias {alias!r})"
                    )
        elif fn in ("min", "max"):
            # Preserve source dtype on non-numeric; cast only when numeric
            # so the wire format stays renderer-friendly (extract-arrow.ts).
            if is_numeric:
                expr = f"CAST({sql_fn}({quote_ident(col)}) AS DOUBLE)"
                # min/max preserve the EXTREME value (not a sum), so
                # the BIGINT > 2^53 case still applies if the extreme
                # itself is past safe-int. Emit the same warning class
                # but mark min/max scope.
                if col_field is not None:
                    ct = col_field.type
                    if pa.types.is_decimal(ct):
                        ctx.warnings.append(
                            f"aggregate {fn!r} on DECIMAL column {col!r} "
                            f"casts to DOUBLE; fractional precision may "
                            f"be lost at large magnitudes (alias {alias!r})"
                        )
                    elif pa.types.is_int64(ct) or pa.types.is_uint64(ct):
                        ctx.warnings.append(
                            f"aggregate {fn!r} on 64-bit integer column "
                            f"{col!r} casts to DOUBLE; values past 2^53 "
                            f"(~9e15) lose ones-place precision "
                            f"(alias {alias!r})"
                        )
            else:
                expr = f"{sql_fn}({quote_ident(col)})"
        else:
            # count, first, last
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
        # Megaudit Theme G (G6, 2026-05-13): standardized message.
        raise CompileError(
            "window.fn 'ema' is not supported by this daemon "
            "(daemon_version=1). Supported window fns: rolling_mean, "
            "rolling_std, rolling_max, rolling_min, cumsum, cumprod, "
            "cummax, cummin. Use rolling_mean as an approximation, or "
            "wait for the recursive-CTE implementation in v2."
        )
    if fn not in _WINDOW_FN_MAP:
        raise CompileError(f"unknown window fn: {fn!r}")

    sql_fn = _WINDOW_FN_MAP[fn]
    qcol = quote_ident(col)
    qalias = quote_ident(alias)

    # Megaudit Theme A (A1, 2026-05-13): window functions are order-
    # dependent. The validator now requires `order_by`; the compiler
    # mirrors the requirement (defense-in-depth) and emits ORDER BY in
    # the window frame. Without ORDER BY, DuckDB iterates rows in scan
    # order (parquet row-group order), silently mixing time periods.
    order_by = t.get("order_by")
    if not isinstance(order_by, str) or not order_by:
        raise CompileError(
            f"window fn {fn!r} requires order_by column "
            "(ROWS frames are order-dependent)"
        )
    _require_column(order_by, available)
    qorder = quote_ident(order_by)

    if fn.startswith("rolling_"):
        window = t.get("window")
        if window is None:
            raise CompileError(f"rolling fn {fn!r} requires window >= 1")
        # _safe_int_literal validates window in [1, 1_000_000]; the
        # human-facing "requires window >= 1" message is preserved by
        # the upstream None check above so users hit a friendly error
        # rather than the helper's range message.
        w_lit = _safe_int_literal(
            f"rolling fn {fn!r} window", window, lo=1, hi=1_000_000
        )
        # The helper already verified `window` is a real int; passing
        # `window - 1` directly avoids round-tripping through str() and
        # back to int().
        w_minus_one_lit = _safe_int_literal(
            "rolling frame preceding", window - 1, lo=0, hi=999_999
        )
        # Frame: ROWS BETWEEN (w-1) PRECEDING AND CURRENT ROW
        expr = (
            f"{sql_fn}({qcol}) OVER "
            f"(ORDER BY {qorder} ROWS BETWEEN {w_minus_one_lit} PRECEDING AND CURRENT ROW)"
        )
    else:
        # cumulative: ROWS UNBOUNDED PRECEDING AND CURRENT ROW
        expr = (
            f"{sql_fn}({qcol}) OVER "
            f"(ORDER BY {qorder} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"
        )

    sql = f"{nxt} AS (SELECT *, {expr} AS {qalias} FROM {prev})"
    return sql, available | {alias}


def _compile_math(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    col = t["column"]; fn = t["fn"]; alias = t["as"]
    _require_column(col, available)
    qcol = quote_ident(col)
    qalias = quote_ident(alias)

    # Megaudit Theme A (A2, 2026-05-13): the three lag/cummax-using math
    # fns are order-dependent. Validator requires `order_by`; mirror
    # the requirement here as defense-in-depth and use it in the OVER
    # clauses.
    ORDER_REQUIRED = {"log_returns", "pct_change", "drawdown"}
    qorder: str | None = None
    if fn in ORDER_REQUIRED:
        order_by = t.get("order_by")
        if not isinstance(order_by, str) or not order_by:
            raise CompileError(
                f"math fn {fn!r} requires order_by column"
            )
        _require_column(order_by, available)
        qorder = quote_ident(order_by)

    if fn in _MATH_FN_MAP:
        expr = f"{_MATH_FN_MAP[fn]}({qcol})"
    elif fn == "log_returns":
        # ln(x / lag(x))
        expr = f"ln({qcol} / lag({qcol}, 1) OVER (ORDER BY {qorder}))"
    elif fn == "pct_change":
        periods_lit = _safe_int_literal(
            "pct_change periods", t.get("periods", 1), lo=1, hi=1_000_000
        )
        expr = f"({qcol} / lag({qcol}, {periods_lit}) OVER (ORDER BY {qorder})) - 1"
    elif fn == "drawdown":
        # (equity - cummax(equity)) / cummax(equity)
        max_window = (
            f"max({qcol}) OVER "
            f"(ORDER BY {qorder} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"
        )
        expr = f"({qcol} - {max_window}) / NULLIF({max_window}, 0)"
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
    # Megaudit Theme A (A3, 2026-05-13): tz_convert source-type aware.
    # DuckDB's timezone(zone, ts) has TWO opposite semantics: on naive
    # TIMESTAMP it treats the timestamp as wall time in `zone` and
    # returns TIMESTAMPTZ; on TIMESTAMPTZ it converts the instant to
    # wall time in `zone`. The previous code emitted the same SQL for
    # both → naive UTC parquet "converted" to NY became NY-encoded-as-
    # if-NY-then-stored-as-UTC. We now branch on source type:
    #   - naive TIMESTAMP: treat as UTC, then convert
    #     timezone(<to>, timezone('UTC', col))
    #   - TIMESTAMP[tz=...]: convert directly
    #     timezone(<to>, col)
    #   - non-timestamp: reject with CompileError.
    col_field = ctx.available_columns.get(col)
    if col_field is None or not pa.types.is_timestamp(col_field.type):
        col_type = str(col_field.type) if col_field else "unknown"
        raise CompileError(
            f"tz_convert requires TIMESTAMP column; {col!r} is {col_type}"
        )
    qcol = quote_ident(col)
    qalias = quote_ident(alias)
    # Bind to_tz as parameter (defense-in-depth, even though _is_safe_tz
    # has already whitelisted the character set).
    ctx.params.append(to_tz)
    if col_field.type.tz is None:
        # Naive timestamp: anchor at UTC, then convert.
        expr = f"timezone(?, timezone('UTC', {qcol}))"
    else:
        # Already TZ-aware: convert directly.
        expr = f"timezone(?, {qcol})"
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
    # Megaudit G1 (2026-05-13): drop the upstream `int(...)` defensive
    # cast so the helper alone enforces strict int-ness (rejecting
    # bool / float / str). Consistent with _compile_window /
    # _compile_math.
    n = t["n"]
    offset = t.get("offset", 0)
    n_lit = _safe_int_literal("limit n", n, lo=1, hi=10_000_000)
    # Offset upper bound mirrors JS Number.MAX_SAFE_INTEGER so the
    # bound matches the TS validator's safe-integer contract instead of
    # imposing a separate 10M cap that would silently truncate large
    # offsets crossing the type boundary.
    offset_lit = _safe_int_literal(
        "limit offset", offset, lo=0, hi=9_007_199_254_740_991
    )
    # Tighten the global cap if the user-specified limit is smaller.
    ctx.cap = min(ctx.cap, n)
    if offset > 0:
        sql = f"{nxt} AS (SELECT * FROM {prev} LIMIT {n_lit} OFFSET {offset_lit})"
    else:
        sql = f"{nxt} AS (SELECT * FROM {prev} LIMIT {n_lit})"
    return sql, available


# ---------------------------------------------------------------------------
# expr transform (Visualise v2)
# ---------------------------------------------------------------------------


def _compile_expr(
    prev: str, nxt: str, t: dict, available: set[str], ctx: _CompileCtx
) -> tuple[str, set[str]]:
    """Compile an `expr` transform (Visualise v2 calculated field).

    The expression is a structured AST (already validated by the TS
    validator). We re-check at the wire boundary (defense in depth):

      - depth/node-count bounded by EXPR_MAX_AST_*
      - every kind, op, fn in its respective allow-list
      - every column reference resolves in `available`
      - the spec's `references` field matches collected refs exactly
      - the output column `as` does not collide with an existing column

    Then we walk the AST emitting parameterized SQL: identifiers via
    `quote_ident`, literals as `?` placeholders with values bound through
    `ctx.params`.
    """
    alias = t.get("as")
    if not isinstance(alias, str) or not alias:
        raise CompileError("expr.as must be a non-empty string")
    if alias in available:
        raise CompileError(
            f"expr.as={alias!r} collides with an existing column "
            f"(available: {sorted(available)})"
        )

    expression = t.get("expression")
    if not isinstance(expression, dict):
        raise CompileError(f"expr.expression must be an object, got {type(expression).__name__}")

    depth, nodes = _expr_ast_metrics(expression)
    if depth > _EXPR_MAX_AST_DEPTH:
        raise CompileError(f"expr AST depth {depth} exceeds cap {_EXPR_MAX_AST_DEPTH}")
    if nodes > _EXPR_MAX_AST_NODES:
        raise CompileError(f"expr AST node count {nodes} exceeds cap {_EXPR_MAX_AST_NODES}")

    declared_refs = t.get("references", [])
    if not isinstance(declared_refs, list) or any(not isinstance(r, str) for r in declared_refs):
        raise CompileError("expr.references must be a list of strings")
    collected_refs = _expr_collect_refs(expression)
    if list(declared_refs) != collected_refs:
        raise CompileError(
            f"expr.references {declared_refs!r} does not match AST-derived refs {collected_refs!r}"
        )
    for ref in collected_refs:
        _require_column(ref, available)

    expr_sql = _walk_expr_ast(expression, ctx)
    sql = f"{nxt} AS (SELECT *, {expr_sql} AS {quote_ident(alias)} FROM {prev})"
    return sql, available | {alias}


def _walk_expr_ast(node: Any, ctx: _CompileCtx) -> str:
    """Recursively emit DuckDB SQL for an ExprAst node. Adds bound
    parameters to `ctx.params` for every literal."""
    if not isinstance(node, dict):
        raise CompileError(f"expr AST node must be object, got {type(node).__name__}")
    kind = node.get("kind")

    if kind == "col":
        name = node.get("name")
        if not isinstance(name, str) or not name:
            raise CompileError("expr col node missing/invalid 'name'")
        return quote_ident(name)

    if kind == "num":
        v = node.get("value")
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise CompileError(f"expr num literal must be number, got {type(v).__name__}")
        if v != v or v == float("inf") or v == float("-inf"):  # NaN/inf check
            raise CompileError(f"expr num literal must be finite, got {v!r}")
        ctx.params.append(v)
        return "?"

    if kind == "str":
        v = node.get("value")
        if not isinstance(v, str):
            raise CompileError(f"expr str literal must be string, got {type(v).__name__}")
        if "\x00" in v:
            raise CompileError("expr str literal contains NUL byte")
        ctx.params.append(v)
        return "?"

    if kind == "bool":
        v = node.get("value")
        if not isinstance(v, bool):
            raise CompileError(f"expr bool literal must be boolean, got {type(v).__name__}")
        return "TRUE" if v else "FALSE"

    if kind == "null":
        return "NULL"

    if kind == "unary":
        op = node.get("op")
        if op == "-":
            inner = _walk_expr_ast(node.get("operand"), ctx)
            return f"(-{inner})"
        if op == "!":
            inner = _walk_expr_ast(node.get("operand"), ctx)
            return f"(NOT {inner})"
        raise CompileError(f"expr unknown unary op: {op!r}")

    if kind == "binary":
        op = node.get("op")
        sql_op = _EXPR_BINARY_OP_MAP.get(op)
        if sql_op is None:
            raise CompileError(f"expr unknown binary op: {op!r}")
        left = _walk_expr_ast(node.get("left"), ctx)
        right = _walk_expr_ast(node.get("right"), ctx)
        return f"({left} {sql_op} {right})"

    if kind == "call":
        fn = node.get("fn")
        sql_fn = _EXPR_FN_MAP.get(fn)
        if sql_fn is None:
            raise CompileError(f"expr unknown function: {fn!r}")
        args = node.get("args")
        if not isinstance(args, list):
            raise CompileError(f"expr call args must be list, got {type(args).__name__}")
        # M4 (megaudit): explicit .get() with structured CompileError so
        # a future drift between _EXPR_FN_MAP and _EXPR_FN_ARITY raises a
        # user-facing error, not a KeyError that crashes the request.
        arity = _EXPR_FN_ARITY.get(fn)
        if arity is None:
            raise CompileError(
                f"expr function {fn!r} has no arity entry "
                f"(internal: _EXPR_FN_MAP and _EXPR_FN_ARITY have drifted)"
            )
        arity_min, arity_max = arity
        if not (arity_min <= len(args) <= arity_max):
            raise CompileError(
                f"expr function {fn!r} expects "
                f"{arity_min}..{arity_max} args, got {len(args)}"
            )
        arg_sql = [_walk_expr_ast(a, ctx) for a in args]
        return f"{sql_fn}({', '.join(arg_sql)})"

    if kind == "if":
        cond = _walk_expr_ast(node.get("cond"), ctx)
        then_ = _walk_expr_ast(node.get("then_"), ctx)
        else_ = _walk_expr_ast(node.get("else_"), ctx)
        return f"(CASE WHEN {cond} THEN {then_} ELSE {else_} END)"

    raise CompileError(f"expr unknown AST kind: {kind!r}")


def _expr_ast_metrics(node: Any, depth: int = 1) -> tuple[int, int]:
    """Return (max_depth, total_nodes) for the AST rooted at `node`."""
    if not isinstance(node, dict):
        return depth, 1
    kind = node.get("kind")
    if kind in ("col", "num", "str", "bool", "null"):
        return depth, 1
    if kind == "unary":
        d, n = _expr_ast_metrics(node.get("operand"), depth + 1)
        return d, n + 1
    if kind == "binary":
        d_l, n_l = _expr_ast_metrics(node.get("left"), depth + 1)
        d_r, n_r = _expr_ast_metrics(node.get("right"), depth + 1)
        return max(d_l, d_r), n_l + n_r + 1
    if kind == "call":
        args = node.get("args") or []
        if not isinstance(args, list):
            return depth, 1
        max_d = depth
        total = 1
        for a in args:
            d, n = _expr_ast_metrics(a, depth + 1)
            max_d = max(max_d, d)
            total += n
        return max_d, total
    if kind == "if":
        d_c, n_c = _expr_ast_metrics(node.get("cond"), depth + 1)
        d_t, n_t = _expr_ast_metrics(node.get("then_"), depth + 1)
        d_e, n_e = _expr_ast_metrics(node.get("else_"), depth + 1)
        return max(d_c, d_t, d_e), n_c + n_t + n_e + 1
    return depth, 1


def _expr_collect_refs(node: Any) -> list[str]:
    """Walk the AST and return the deduplicated, source-order list of
    column references. Parallel to `collectColumnRefs` in TS."""
    seen: set[str] = set()
    out: list[str] = []

    def visit(n: Any) -> None:
        if not isinstance(n, dict):
            return
        k = n.get("kind")
        if k == "col":
            name = n.get("name")
            if isinstance(name, str) and name not in seen:
                seen.add(name)
                out.append(name)
            return
        if k == "unary":
            visit(n.get("operand"))
            return
        if k == "binary":
            visit(n.get("left"))
            visit(n.get("right"))
            return
        if k == "call":
            for a in n.get("args") or []:
                visit(a)
            return
        if k == "if":
            visit(n.get("cond"))
            visit(n.get("then_"))
            visit(n.get("else_"))
            return

    visit(node)
    return out


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
