"""Tests for QvizSpec → DuckDB SQL compiler.

We test correctness (the SQL we emit), security (column quoting + parameter
binding), and end-to-end (run the SQL via duckdb against real parquet data).
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from qviz.compiler import (
    CompileError,
    TransformAttribution,
    compile_spec,
    quote_ident,
)

from qviz.tests._fixture_helpers import require_fixture


@pytest.fixture
def parquet_1m() -> str:
    p = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
    require_fixture(p, "spike OHLCV parquet")
    return str(p)


@pytest.fixture
def schema_1m(parquet_1m: str) -> pa.Schema:
    return pq.read_schema(parquet_1m)


# ---------------------------------------------------------------------------
# quote_ident
# ---------------------------------------------------------------------------


def test_quote_ident_basic() -> None:
    assert quote_ident("foo") == '"foo"'


def test_quote_ident_with_quote_in_name() -> None:
    assert quote_ident('foo"bar') == '"foo""bar"'


def test_quote_ident_rejects_empty() -> None:
    with pytest.raises(CompileError):
        quote_ident("")


# ---------------------------------------------------------------------------
# Filter compilation
# ---------------------------------------------------------------------------


def test_filter_eq(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "volume", "op": ">", "value": 100},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '"volume" > ?' in cq.sql
    assert cq.params == [parquet_1m, 100]


def test_filter_in(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "volume", "op": "in", "value": [100, 200, 300]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "IN (?, ?, ?)" in cq.sql
    assert cq.params == [parquet_1m, 100, 200, 300]


def test_filter_is_null(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "returns", "op": "is_null"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '"returns" IS NULL' in cq.sql
    # Only the file path, no value param for is_null
    assert cq.params == [parquet_1m]


def test_filter_unknown_column_rejected(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "ghost", "op": ">", "value": 0},
    ])
    with pytest.raises(CompileError, match="ghost"):
        compile_spec(spec, schema_1m, parquet_1m)


# ---------------------------------------------------------------------------
# date_trunc + groupby + aggregate (the canonical pipeline)
# ---------------------------------------------------------------------------


def test_groupby_aggregate_pipeline(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
        {"kind": "groupby", "columns": ["day"]},
        {"kind": "aggregate", "aggs": [
            {"column": "volume", "fn": "sum", "as": "vol_sum"},
            {"column": "close", "fn": "mean", "as": "close_avg"},
        ]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "date_trunc('day'" in cq.sql
    assert 'sum("volume")' in cq.sql
    assert 'avg("close")' in cq.sql
    assert "GROUP BY" in cq.sql
    assert set(cq.final_columns) == {"day", "vol_sum", "close_avg"}


def test_aggregate_unknown_fn(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "groupby", "columns": ["volume"]},
        {"kind": "aggregate", "aggs": [
            {"column": "close", "fn": "weird_fn", "as": "x"},
        ]},
    ])
    with pytest.raises(CompileError, match="unknown agg fn"):
        compile_spec(spec, schema_1m, parquet_1m)


# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------


def test_rolling_mean(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "rolling_mean", "window": 20,
         "order_by": "timestamp", "as": "ma20"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert 'avg("close") OVER (ORDER BY "timestamp" ROWS BETWEEN 19 PRECEDING' in cq.sql


def test_rolling_requires_window(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "rolling_mean",
         "order_by": "timestamp", "as": "ma"},
    ])
    with pytest.raises(CompileError, match="window >= 1"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_window_requires_order_by(schema_1m: pa.Schema, parquet_1m: str) -> None:
    """Theme A A1: window fns are order-dependent. Compiler refuses missing order_by."""
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "rolling_mean", "window": 5, "as": "ma"},
    ])
    with pytest.raises(CompileError, match="order_by"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_ema_not_implemented_v1(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "ema", "window": 20,
         "order_by": "timestamp", "as": "ema20"},
    ])
    with pytest.raises(CompileError, match="ema"):
        compile_spec(spec, schema_1m, parquet_1m)


# ---------------------------------------------------------------------------
# Math
# ---------------------------------------------------------------------------


def test_log_returns(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "math", "column": "close", "fn": "log_returns",
         "order_by": "timestamp", "as": "logret"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "ln(" in cq.sql
    assert "lag(" in cq.sql
    assert 'ORDER BY "timestamp"' in cq.sql


def test_math_log_returns_requires_order_by(schema_1m: pa.Schema, parquet_1m: str) -> None:
    """Theme A A2: log_returns/pct_change/drawdown require order_by."""
    spec = _spec_with_transforms([
        {"kind": "math", "column": "close", "fn": "log_returns", "as": "logret"},
    ])
    with pytest.raises(CompileError, match="order_by"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_drawdown(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "math", "column": "close", "fn": "drawdown",
         "order_by": "timestamp", "as": "dd"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "max(" in cq.sql
    assert "ROWS BETWEEN UNBOUNDED PRECEDING" in cq.sql
    assert 'ORDER BY "timestamp"' in cq.sql


# ---------------------------------------------------------------------------
# Limit + sort
# ---------------------------------------------------------------------------


def test_limit_caps_final_select(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([{"kind": "limit", "n": 500}])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "LIMIT 500" in cq.sql


def test_sort(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "sort", "columns": [{"column": "timestamp", "desc": True}]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert 'ORDER BY "timestamp" DESC' in cq.sql


# ---------------------------------------------------------------------------
# Encoding column-existence check
# ---------------------------------------------------------------------------


def test_rejects_encoding_field_not_in_pipeline(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = {
        "qviz_version": 1,
        "transforms": [],
        "chart": {
            "family": "general",
            "type": "scatter",
            "encodings": {
                "x": {"field": "ghost", "type": "quantitative"},
                "y": {"field": "close", "type": "quantitative"},
            },
        },
    }
    with pytest.raises(CompileError, match="ghost"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_rejects_ohlcv_field_not_in_pipeline(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = {
        "qviz_version": 1,
        "transforms": [],
        "chart": {
            "family": "timeseries",
            "type": "candlestick",
            "encodings": {
                "ohlcv": {
                    "time": "timestamp", "open": "open", "high": "high",
                    "low": "low", "close": "ghost", "volume": "volume",
                },
            },
        },
    }
    with pytest.raises(CompileError, match="ghost"):
        compile_spec(spec, schema_1m, parquet_1m)


# ---------------------------------------------------------------------------
# End-to-end execution against DuckDB
# ---------------------------------------------------------------------------


def test_end_to_end_groupby(schema_1m: pa.Schema, parquet_1m: str) -> None:
    """Compile + execute. Confirms the generated SQL is real DuckDB SQL."""
    spec = _spec_with_transforms([
        {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
        {"kind": "groupby", "columns": ["day"]},
        {"kind": "aggregate", "aggs": [
            {"column": "volume", "fn": "sum", "as": "vol_sum"},
        ]},
        {"kind": "sort", "columns": [{"column": "day"}]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        assert result.num_rows >= 1
        assert "day" in result.column_names
        assert "vol_sum" in result.column_names
    finally:
        conn.close()


def test_end_to_end_filter_then_limit(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "volume", "op": ">", "value": 0},
        {"kind": "limit", "n": 100},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        assert result.num_rows == 100
    finally:
        conn.close()


def test_end_to_end_log_returns_runs(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "math", "column": "close", "fn": "log_returns",
         "order_by": "timestamp", "as": "logret"},
        {"kind": "limit", "n": 10},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        assert "logret" in result.column_names
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Megaudit Theme F — date_trunc compilation unit (F2)
# ---------------------------------------------------------------------------


def test_date_trunc_emits_canonical_sql(tmp_path: Path) -> None:
    """F2: pin the compiled date_trunc SQL shape so a DuckDB version
    bump that changes the function name surfaces here, not in a
    confused user report."""
    table = pa.table({
        "ts": pa.array([], type=pa.timestamp("ns")),
        "x": pa.array([], type=pa.float64()),
    })
    p = tmp_path / "ts.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "date_trunc", "column": "ts", "unit": "day", "as": "d"},
    ])
    cq = compile_spec(spec, schema, str(p))
    assert "date_trunc('day', \"ts\")" in cq.sql
    assert 'AS "d"' in cq.sql


def test_date_trunc_units_lock(tmp_path: Path) -> None:
    """F9: pin the set of accepted units to the TS-side validator."""
    from qviz.compiler import _DATE_TRUNC_UNITS
    expected = {"second", "minute", "hour", "day", "week", "month", "quarter", "year"}
    assert _DATE_TRUNC_UNITS == expected, (
        f"_DATE_TRUNC_UNITS drift: {_DATE_TRUNC_UNITS} vs expected {expected}. "
        "Update src/qviz/validate.ts in lockstep."
    )


# ---------------------------------------------------------------------------
# Megaudit Theme A — tz_convert source-type-aware (A3)
# ---------------------------------------------------------------------------


def test_tz_convert_naive_timestamp_anchored_at_utc(tmp_path: Path) -> None:
    """A3: a naive TIMESTAMP column converted to NY should produce the
    UTC-instant interpretation, not double-encode. We test the compiled
    SQL shape: it MUST wrap the column in timezone('UTC', col) before
    the outer timezone() call."""
    import datetime as _dt
    table = pa.table({
        "ts": pa.array([_dt.datetime(2024, 1, 1, 12, 0, 0)], type=pa.timestamp("ns")),
    })
    p = tmp_path / "naive.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "tz_convert", "column": "ts", "to_tz": "America/New_York", "as": "ts_ny"},
    ])
    cq = compile_spec(spec, schema, str(p))
    # The compiled SQL MUST anchor naive at UTC first.
    assert "timezone('UTC'" in cq.sql, f"naive timestamps must anchor at UTC; got: {cq.sql}"
    # to_tz is parameter-bound (?), not interpolated literal.
    assert "'America/New_York'" not in cq.sql, "to_tz must be parameter-bound"
    assert "America/New_York" in cq.params, "to_tz must appear in params"


def test_tz_convert_tz_aware_timestamp_no_double_wrap(tmp_path: Path) -> None:
    """A3: a TIMESTAMPTZ column should NOT be wrapped in
    timezone('UTC', ...) — it's already an absolute instant."""
    import datetime as _dt
    table = pa.table({
        "ts": pa.array(
            [_dt.datetime(2024, 1, 1, 12, 0, 0, tzinfo=_dt.timezone.utc)],
            type=pa.timestamp("ns", tz="UTC"),
        ),
    })
    p = tmp_path / "tzaware.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "tz_convert", "column": "ts", "to_tz": "America/New_York", "as": "ts_ny"},
    ])
    cq = compile_spec(spec, schema, str(p))
    # No nested timezone('UTC', ...) wrap.
    assert "timezone('UTC'" not in cq.sql, f"tz-aware should not double-wrap; got: {cq.sql}"
    # The outer timezone(?, col) IS still present.
    assert "timezone(?" in cq.sql


def test_tz_convert_rejects_non_timestamp_column(tmp_path: Path) -> None:
    """A3: tz_convert on a string/numeric column raises CompileError
    instead of producing an opaque DuckDB type error."""
    table = pa.table({"label": ["a", "b"]})
    p = tmp_path / "string.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "tz_convert", "column": "label", "to_tz": "UTC", "as": "x"},
    ])
    with pytest.raises(CompileError, match="requires TIMESTAMP"):
        compile_spec(spec, schema, str(p))


# ---------------------------------------------------------------------------
# Megaudit Theme A — aggregate type-aware cast (A4)
# ---------------------------------------------------------------------------


def test_aggregate_min_on_string_column_preserves_dtype(tmp_path: Path) -> None:
    """A4: min(symbol) on a string column previously cast to DOUBLE,
    yielding an opaque DuckDB type-conversion error. Now: preserve
    source dtype on non-numeric min/max."""
    table = pa.table({"symbol": ["AAPL", "MSFT", "GOOG"], "v": [1.0, 2.0, 3.0]})
    p = tmp_path / "mixed.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "aggregate", "aggs": [
            {"column": "symbol", "fn": "min", "as": "sym_min"},
            {"column": "v", "fn": "sum", "as": "v_sum"},
        ]},
    ])
    cq = compile_spec(spec, schema, str(p))
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        # min on string returns the lexicographically smallest string.
        assert result.column("sym_min").to_pylist() == ["AAPL"]
        # sum on numeric is still cast to DOUBLE.
        assert result.column("v_sum").to_pylist() == [6.0]
    finally:
        conn.close()


def test_aggregate_sum_on_string_column_raises_compile_error(tmp_path: Path) -> None:
    """A4: sum(symbol) is nonsensical; daemon now refuses with a
    structured CompileError instead of an opaque DuckDB error."""
    table = pa.table({"symbol": ["AAPL", "MSFT"]})
    p = tmp_path / "strings.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "aggregate", "aggs": [
            {"column": "symbol", "fn": "sum", "as": "bad"},
        ]},
    ])
    with pytest.raises(CompileError, match="requires numeric column"):
        compile_spec(spec, schema, str(p))


def test_aggregate_mean_median_std_on_string_rejected(tmp_path: Path) -> None:
    """A4: every aggregate that produces a real number rejects strings."""
    table = pa.table({"symbol": ["AAPL", "MSFT"]})
    p = tmp_path / "strings.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    for fn in ("mean", "median", "std"):
        spec = _spec_with_transforms([
            {"kind": "aggregate", "aggs": [
                {"column": "symbol", "fn": fn, "as": "bad"},
            ]},
        ])
        with pytest.raises(CompileError, match="requires numeric column"):
            compile_spec(spec, schema, str(p))


# ---------------------------------------------------------------------------
# Megaudit Theme A — bin all-equal CASE wrapper (A5)
# ---------------------------------------------------------------------------


def test_bin_all_equal_value_returns_zero_not_null(tmp_path: Path) -> None:
    """Theme A A5: when min(col) == max(col), the denominator NULLIF
    used to make every bin NULL, silently dropping every chart point.
    The outer CASE now lands them all in bucket 0."""
    table = pa.table({"v": [5.0, 5.0, 5.0, 5.0]})
    p = tmp_path / "all_equal.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "bin", "column": "v", "n_bins": 10, "as": "vb"},
        {"kind": "limit", "n": 10},
    ])
    cq = compile_spec(spec, schema, str(p))
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        bins = result.column("vb").to_pylist()
        assert bins == [0, 0, 0, 0], f"expected all zeros, got {bins}"
    finally:
        conn.close()


def test_bin_normal_range_still_works(tmp_path: Path) -> None:
    """Sanity: the CASE wrapper must not break the standard equal-width path."""
    table = pa.table({"v": [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]})
    p = tmp_path / "range.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "bin", "column": "v", "n_bins": 5, "as": "vb"},
        {"kind": "limit", "n": 100},
    ])
    cq = compile_spec(spec, schema, str(p))
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        bins = result.column("vb").to_pylist()
        # 10 values across range 0..9 with 5 bins: expect bins 0..4 distributed.
        assert set(bins) == {0, 1, 2, 3, 4}, f"unexpected bin set: {set(bins)}"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Security: column-name SQL injection
# ---------------------------------------------------------------------------


def test_column_with_quote_in_name_safely_quoted(tmp_path: Path) -> None:
    """If a parquet has a column named e.g. `foo"); DROP TABLE x; --`, our
    quoting must escape it so SQL stays well-formed and can't be hijacked."""
    weird_col = 'foo"; DROP TABLE x; --'
    table = pa.table({weird_col: [1, 2, 3], "ok": [4, 5, 6]})
    p = tmp_path / "weird.parquet"
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = _spec_with_transforms([
        {"kind": "filter", "column": weird_col, "op": ">", "value": 0},
        {"kind": "limit", "n": 10},
    ])
    cq = compile_spec(spec, schema, str(p))

    # Doubled the embedded quote — DROP TABLE is now string content, not SQL.
    expected = '"foo""; DROP TABLE x; --"'
    assert expected in cq.sql

    # Also verify it actually runs — DuckDB accepts the quoted name.
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        assert result.num_rows == 3
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _spec_with_transforms(transforms: list[dict], encodings: dict | None = None) -> dict:
    """Build a minimal spec for compiler tests.

    By default, leaves `chart.encodings` empty so the compiler's
    encoding-references-real-columns check doesn't fire. Tests that exercise
    that check pass their own `encodings`.
    """
    return {
        "qviz_version": 1,
        "transforms": transforms,
        "chart": {
            "family": "timeseries",
            "type": "line",
            "encodings": encodings if encodings is not None else {},
        },
    }


# ---------------------------------------------------------------------------
# expr transform (Visualise v2)
# ---------------------------------------------------------------------------


def _expr(*, as_: str, expression: dict, references: list[str]) -> dict:
    return {"kind": "expr", "as": as_, "expression": expression, "references": references}


def test_expr_arithmetic_emits_parameterised_sql(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="mid",
            expression={
                "kind": "binary", "op": "/",
                "left": {
                    "kind": "binary", "op": "+",
                    "left": {"kind": "col", "name": "high"},
                    "right": {"kind": "col", "name": "low"},
                },
                "right": {"kind": "num", "value": 2},
            },
            references=["high", "low"],
        ),
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '("high" + "low")' in cq.sql
    assert ') / ?)' in cq.sql
    # First param is the file path; the literal `2` follows it.
    assert cq.params == [parquet_1m, 2]


def test_expr_case_when_emits_if(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="direction",
            expression={
                "kind": "if",
                "cond": {
                    "kind": "binary", "op": ">",
                    "left": {"kind": "col", "name": "close"},
                    "right": {"kind": "col", "name": "open"},
                },
                "then_": {"kind": "num", "value": 1},
                "else_": {"kind": "unary", "op": "-", "operand": {"kind": "num", "value": 1}},
            },
            references=["close", "open"],
        ),
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "CASE WHEN" in cq.sql
    assert '"close" > "open"' in cq.sql


def test_expr_string_literal_parameterised(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="ticker_marker",
            expression={
                "kind": "binary", "op": "==",
                "left": {"kind": "col", "name": "ticker"},
                "right": {"kind": "str", "value": "AAPL"},
            },
            references=["ticker"],
        ),
    ])
    # NOTE (megaudit F5, 2026-05-13): NOT a fixture-presence skip. The
    # synthetic spike parquet deliberately omits 'ticker' — this skip is
    # schema-shape capability gating and must remain a soft skip even
    # under QUANTLAB_REQUIRE_FIXTURES=1.
    if "ticker" not in schema_1m.names:
        pytest.skip("schema fixture lacks 'ticker' column")
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '"ticker" = ?' in cq.sql
    assert "AAPL" in cq.params


def test_expr_min_max_compile_to_least_greatest(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="clamped",
            expression={
                "kind": "call", "fn": "min",
                "args": [{"kind": "col", "name": "high"}, {"kind": "col", "name": "low"}],
            },
            references=["high", "low"],
        ),
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "least(" in cq.sql
    assert "min(" not in cq.sql.split("AS \"clamped\"")[0].split("least")[-1]


def test_expr_collision_with_existing_column_rejected(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="close",  # collision with original schema column
            expression={
                "kind": "binary", "op": "+",
                "left": {"kind": "col", "name": "high"},
                "right": {"kind": "col", "name": "low"},
            },
            references=["high", "low"],
        ),
    ])
    with pytest.raises(CompileError, match="collides with an existing column"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_expr_unknown_column_rejected(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="ghost_diff",
            expression={
                "kind": "binary", "op": "-",
                "left": {"kind": "col", "name": "ghost"},
                "right": {"kind": "col", "name": "low"},
            },
            references=["ghost", "low"],
        ),
    ])
    with pytest.raises(CompileError, match="ghost"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_expr_references_mismatch_rejected(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="mid",
            expression={
                "kind": "binary", "op": "+",
                "left": {"kind": "col", "name": "high"},
                "right": {"kind": "col", "name": "low"},
            },
            # Wrong order vs AST traversal: AST yields ["high", "low"].
            references=["low", "high"],
        ),
    ])
    with pytest.raises(CompileError, match="does not match AST-derived refs"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_expr_unknown_function_rejected(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    spec = _spec_with_transforms([
        _expr(
            as_="evil",
            expression={
                "kind": "call", "fn": "exec",
                "args": [{"kind": "str", "value": "DROP TABLE foo"}],
            },
            references=[],
        ),
    ])
    with pytest.raises(CompileError, match="unknown function"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_expr_references_upstream_produced_column(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    """`expr` composes with `window`: the produced column from window
    becomes available to a downstream expr's column reference."""
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "rolling_mean",
         "window": 20, "order_by": "timestamp", "as": "sma20"},
        _expr(
            as_="above_sma",
            expression={
                "kind": "binary", "op": "-",
                "left": {"kind": "col", "name": "close"},
                "right": {"kind": "col", "name": "sma20"},
            },
            references=["close", "sma20"],
        ),
        {"kind": "limit", "n": 25},
    ], encodings={
        "y": {"field": "above_sma", "type": "quantitative"},
    })
    cq = compile_spec(spec, schema_1m, parquet_1m)
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        assert "above_sma" in result.column_names
        assert result.num_rows == 25
    finally:
        conn.close()


def test_expr_as_collision_with_upstream_produced_rejected(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    """The `as` collision check fires against produced columns, not just
    raw schema columns: defining `expr.as=sma20` after a `window(...).as=sma20`
    must be rejected."""
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "rolling_mean",
         "window": 20, "order_by": "timestamp", "as": "sma20"},
        _expr(
            as_="sma20",  # collision with the window output above.
            expression={
                "kind": "binary", "op": "+",
                "left": {"kind": "col", "name": "high"},
                "right": {"kind": "col", "name": "low"},
            },
            references=["high", "low"],
        ),
    ])
    with pytest.raises(CompileError, match="collides with an existing column"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_expr_depth_cap_defense_in_depth(
    schema_1m: pa.Schema, parquet_1m: str,
) -> None:
    """Hand-crafted AST that bypasses the TS parser cap must still be
    rejected by the compiler."""
    # Build a right-deep binary chain that exceeds maxAstDepth.
    node: dict = {"kind": "num", "value": 1}
    for _ in range(20):  # well past the 16 cap
        node = {
            "kind": "binary", "op": "+",
            "left": {"kind": "num", "value": 1},
            "right": node,
        }
    spec = _spec_with_transforms([
        _expr(as_="x", expression=node, references=[]),
    ])
    with pytest.raises(CompileError, match="depth"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_expr_end_to_end_runs(schema_1m: pa.Schema, parquet_1m: str) -> None:
    """Execute the compiled SQL against DuckDB to confirm validity."""
    spec = _spec_with_transforms(
        [
            _expr(
                as_="mid",
                expression={
                    "kind": "binary", "op": "/",
                    "left": {
                        "kind": "binary", "op": "+",
                        "left": {"kind": "col", "name": "high"},
                        "right": {"kind": "col", "name": "low"},
                    },
                    "right": {"kind": "num", "value": 2},
                },
                references=["high", "low"],
            ),
            {"kind": "limit", "n": 5},
        ],
        encodings={
            "x": {"field": "ts", "type": "temporal"} if "ts" in schema_1m.names else {"field": "high", "type": "quantitative"},
            "y": {"field": "mid", "type": "quantitative"},
        },
    )
    cq = compile_spec(spec, schema_1m, parquet_1m)
    conn = duckdb.connect(":memory:")
    try:
        result = conn.execute(cq.sql, cq.params).fetch_arrow_table()
        assert "mid" in result.column_names
        assert result.num_rows == 5
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Megaudit G1 (2026-05-13): _safe_int_literal helper
# ---------------------------------------------------------------------------


def test_safe_int_literal_accepts_in_range() -> None:
    from qviz.compiler import _safe_int_literal

    assert _safe_int_literal("x", 0, lo=0, hi=10) == "0"
    assert _safe_int_literal("x", 10, lo=0, hi=10) == "10"
    assert _safe_int_literal("x", 5) == "5"


def test_safe_int_literal_rejects_float() -> None:
    from qviz.compiler import _safe_int_literal

    with pytest.raises(CompileError, match="expected int, got float"):
        _safe_int_literal("x", 3.5)


def test_safe_int_literal_rejects_str() -> None:
    from qviz.compiler import _safe_int_literal

    with pytest.raises(CompileError, match="expected int, got str"):
        _safe_int_literal("x", "10")


def test_safe_int_literal_rejects_bool() -> None:
    """bool subclasses int in Python; without the explicit check ``True``
    would coerce to "1" and silently land in SQL. Pin the rejection."""
    from qviz.compiler import _safe_int_literal

    with pytest.raises(CompileError, match="expected int, got bool"):
        _safe_int_literal("x", True)
    with pytest.raises(CompileError, match="expected int, got bool"):
        _safe_int_literal("x", False)


def test_safe_int_literal_rejects_out_of_range() -> None:
    from qviz.compiler import _safe_int_literal

    with pytest.raises(CompileError, match=r"x=99 out of range \[0, 10\]"):
        _safe_int_literal("x", 99, lo=0, hi=10)
    with pytest.raises(CompileError, match=r"x=-1 out of range \[0, 10\]"):
        _safe_int_literal("x", -1, lo=0, hi=10)


def test_safe_int_literal_boundaries_inclusive() -> None:
    from qviz.compiler import _safe_int_literal

    # lo and hi are both inclusive.
    assert _safe_int_literal("x", 0, lo=0, hi=0) == "0"
    with pytest.raises(CompileError):
        _safe_int_literal("x", 1, lo=0, hi=0)


@pytest.mark.parametrize("transform, match", [
    # Validator-bypass cases — spec arrives directly at the compiler
    # without going through the TS validator (e.g., a Python preset
    # generated the spec, or an internal caller). The helper must
    # still reject by type, not silently coerce.
    ({"kind": "limit", "n": True},
     r"limit n: expected int, got bool"),
    ({"kind": "limit", "n": 100, "offset": True},
     r"limit offset: expected int, got bool"),
    ({"kind": "limit", "n": "5"},
     r"limit n: expected int, got str"),
    ({"kind": "limit", "n": 5.9},
     r"limit n: expected int, got float"),
    ({"kind": "bin", "column": "high", "n_bins": "10", "as": "b"},
     r"bin n_bins: expected int, got str"),
    ({"kind": "bin", "column": "high", "n_bins": 10.9, "as": "b"},
     r"bin n_bins: expected int, got float"),
    ({"kind": "bin", "column": "high", "n_bins": True, "as": "b"},
     r"bin n_bins: expected int, got bool"),
    # Original range/format cases:
    ({"kind": "limit", "n": 0}, r"limit n=0 out of range \[1, 10000000\]"),
    ({"kind": "limit", "n": 10_000_001},
     r"limit n=10000001 out of range \[1, 10000000\]"),
    ({"kind": "limit", "n": 100, "offset": -1},
     r"limit offset=-1 out of range \[0, "),
    ({"kind": "limit", "n": 5.0},
     r"limit n: expected int, got float"),
    ({"kind": "bin", "column": "high", "n_bins": 1, "as": "b"},
     r"bin n_bins=1 out of range \[2, 1000\]"),
    ({"kind": "bin", "column": "high", "n_bins": 1001, "as": "b"},
     r"bin n_bins=1001 out of range \[2, 1000\]"),
    ({"kind": "math", "column": "close", "fn": "pct_change",
      "order_by": "timestamp", "periods": 0, "as": "r"},
     r"pct_change periods=0 out of range \[1, 1000000\]"),
    ({"kind": "window", "column": "close", "fn": "rolling_mean",
      "window": 0, "order_by": "timestamp", "as": "w"},
     # window=0 trips the human-facing N>=1 check before hitting the
     # helper; both messages classify as `compile`.
     r"(requires window >= 1|rolling fn .* window=0 out of range)"),
    ({"kind": "window", "column": "close", "fn": "rolling_mean",
      "window": 1_000_001, "order_by": "timestamp", "as": "w"},
     r"rolling fn 'rolling_mean' window=1000001 out of range \[1, 1000000\]"),
])
def test_helper_surfaces_through_compile_spec(
    schema_1m: pa.Schema, parquet_1m: str, transform: dict, match: str
) -> None:
    """Megaudit G1 (2026-05-13): integration test confirming that
    invalid int literals in user-facing transforms surface the
    `_safe_int_literal` CompileError through the full `compile_spec`
    path, so the daemon's error-kind classifier tags them as
    ``compile`` (not ``internal``)."""

    def spec(transform: dict) -> dict:
        return {
            "chart": {
                "family": "general", "type": "scatter",
                "encodings": {
                    "x": {"field": "high", "type": "quantitative"},
                    "y": {"field": "low", "type": "quantitative"},
                },
                "options": {},
            },
            "dataset": {"uri": parquet_1m, "schema_version": 1},
            "transforms": [transform],
        }

    with pytest.raises(CompileError, match=match):
        compile_spec(spec(transform), schema_1m, parquet_1m)


# ---------------------------------------------------------------------------
# Megaudit D8 (2026-05-13): NULL set-filter compiles to `IS NULL`
# ---------------------------------------------------------------------------


def test_d8_filter_in_with_null_emits_is_null_or_in(
    schema_1m: pa.Schema, parquet_1m: str
) -> None:
    """A set filter that includes literal `None` must compile to
    `(col IS NULL OR col IN (...))`, NOT `col IN (NULL, ...)` which
    would silently exclude NULL rows under DuckDB's trivalent logic.
    """
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "returns", "op": "in",
         "value": [None, 0.0, 1.0]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '"returns" IS NULL' in cq.sql, cq.sql
    assert '"returns" IN (?, ?)' in cq.sql, cq.sql
    # Only the two non-null values are parameterized; None is lifted
    # into the SQL itself.
    assert cq.params == [parquet_1m, 0.0, 1.0]


def test_d8_filter_in_null_only_collapses_to_is_null(
    schema_1m: pa.Schema, parquet_1m: str
) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "returns", "op": "in", "value": [None]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '"returns" IS NULL' in cq.sql, cq.sql
    assert "IN (" not in cq.sql, cq.sql
    assert cq.params == [parquet_1m]


def test_d8_filter_not_in_with_null_emits_is_not_null(
    schema_1m: pa.Schema, parquet_1m: str
) -> None:
    spec = _spec_with_transforms([
        {"kind": "filter", "column": "returns", "op": "not_in",
         "value": [None, 0.0]},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert '"returns" IS NOT NULL' in cq.sql, cq.sql
    assert '"returns" NOT IN (?)' in cq.sql, cq.sql
    assert cq.params == [parquet_1m, 0.0]


def test_d8_end_to_end_null_filter_does_not_match_literal_null_string(
    tmp_path
) -> None:
    """Bug-witness test: a column containing both SQL NULL and the
    literal string `"null"`, filtered by `[None]`, must return ONLY
    the SQL-NULL rows. The pre-D8 String(v) coercion would have
    matched both."""
    import duckdb
    import pyarrow as pa
    import pyarrow.parquet as pq
    p = tmp_path / "data" / "mixed.parquet"
    p.parent.mkdir(parents=True, exist_ok=True)
    # Mixed column: 'a', 'null' (literal string), 'b', None, 'null', None.
    table = pa.table({"label": pa.array(["a", "null", "b", None, "null", None])})
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))

    spec = {
        "chart": {
            "family": "general", "type": "scatter",
            "encodings": {
                "x": {"field": "label", "type": "nominal"},
                "y": {"field": "label", "type": "nominal"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "filter", "column": "label", "op": "in", "value": [None]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    conn = duckdb.connect(":memory:")
    try:
        rows = conn.execute(cq.sql, cq.params).fetch_arrow_table()
    finally:
        conn.close()
    labels = rows.column("label").to_pylist()
    # Only the two None rows; the literal string "null" must NOT appear.
    assert labels == [None, None], labels


# ---------------------------------------------------------------------------
# Megaudit G5 (2026-05-13): aggregate precision-loss warnings
# ---------------------------------------------------------------------------


def test_g5_warning_on_sum_of_int64(tmp_path) -> None:
    """`sum(int64_col)` casts to DOUBLE, which silently loses ones-place
    precision above 2^53. The compiler must emit a warning so the
    webview can surface it in the diagnostics readout."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    p = tmp_path / "data" / "ints.parquet"
    p.parent.mkdir(parents=True)
    table = pa.table({"n": pa.array([1, 2, 3], type=pa.int64())})
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "total", "type": "quantitative"},
                "y": {"field": "total", "type": "quantitative"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "n", "fn": "sum", "as": "total"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.warnings) == 1, cq.warnings
    assert "64-bit integer" in cq.warnings[0]
    assert "n" in cq.warnings[0] and "total" in cq.warnings[0]
    # SQL still casts to DOUBLE (Option A: keep cast, warn).
    assert "CAST(sum(\"n\") AS DOUBLE)" in cq.sql


def test_g5_warning_on_mean_of_decimal(tmp_path) -> None:
    """`mean(DECIMAL_col)` casts to DOUBLE, losing cents at large
    magnitudes. Pin the warning."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    p = tmp_path / "data" / "decimals.parquet"
    p.parent.mkdir(parents=True)
    from decimal import Decimal
    dec = pa.decimal128(38, 8)
    table = pa.table({"price": pa.array(
        [Decimal("100.12300000"), Decimal("200.45600000"), Decimal("300.78900000")],
        type=dec,
    )})
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "avg_price", "type": "quantitative"},
                "y": {"field": "avg_price", "type": "quantitative"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "price", "fn": "mean", "as": "avg_price"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.warnings) == 1, cq.warnings
    assert "DECIMAL" in cq.warnings[0]
    assert "price" in cq.warnings[0]


def test_g5_no_warning_on_float_aggregates(parquet_1m: str, schema_1m: pa.Schema) -> None:
    """Aggregates over float32/float64 columns don't lose precision via
    the DOUBLE cast; no warning. Regression pin so we don't add
    over-eager warnings."""
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "avg_close", "type": "quantitative"},
                "y": {"field": "avg_close", "type": "quantitative"},
            },
        },
        "dataset": {"uri": parquet_1m, "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "mean", "as": "avg_close"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert cq.warnings == [], cq.warnings


def test_g5_warning_on_max_of_int64(tmp_path) -> None:
    """`max(int64)` preserves the EXTREME value; if that value is past
    2^53, the DOUBLE cast loses precision. Pin the warning for
    min/max scope too."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    p = tmp_path / "data" / "ints.parquet"
    p.parent.mkdir(parents=True)
    table = pa.table({"n": pa.array([1, 2, 3], type=pa.int64())})
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "biggest", "type": "quantitative"},
                "y": {"field": "biggest", "type": "quantitative"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "n", "fn": "max", "as": "biggest"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.warnings) == 1, cq.warnings
    assert "max" in cq.warnings[0]


def test_g5_multiple_warnings_accumulate(tmp_path) -> None:
    """Two aggregates over precision-losing columns must produce TWO
    warnings, both surfaced on CompiledQuery.warnings."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from decimal import Decimal
    p = tmp_path / "data" / "mixed.parquet"
    p.parent.mkdir(parents=True)
    table = pa.table({
        "n": pa.array([1, 2, 3], type=pa.int64()),
        "price": pa.array(
            [Decimal("1.00000000"), Decimal("2.00000000"), Decimal("3.00000000")],
            type=pa.decimal128(38, 8),
        ),
    })
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "ns", "type": "quantitative"},
                "y": {"field": "pmean", "type": "quantitative"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "n", "fn": "sum", "as": "ns"},
                {"column": "price", "fn": "mean", "as": "pmean"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.warnings) == 2, cq.warnings


def test_g5_daemon_aggregate_response_carries_warnings(tmp_path) -> None:
    """End-to-end pin: a real `aggregate` op against a parquet with an
    int64 column surfaces the precision-loss warning on the response's
    `data.warnings` field."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "ints.parquet"
    table = pa.table({"n": pa.array([1, 2, 3], type=pa.int64())})
    pq.write_table(table, str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "total", "type": "quantitative"},
                "y": {"field": "total", "type": "quantitative"},
            },
        },
        "dataset": {"uri": "data/ints.parquet", "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "n", "fn": "sum", "as": "total"},
            ]},
        ],
    }
    d = Daemon(tmp_path)
    resp, _ = d.handle({"op": "aggregate", "id": 1, "spec": spec})
    assert resp["ok"] is True, resp
    warnings = resp["data"].get("warnings")
    assert warnings is not None and len(warnings) == 1, resp["data"]
    assert "64-bit integer" in warnings[0]


def test_g5_no_warnings_field_when_clean(tmp_path) -> None:
    """Regression pin: when no aggregates lose precision, the response
    must NOT include a `warnings` key (rather than an empty list).
    Saves wire bytes on the common case + keeps the webview's
    diagnostics readout silent when nothing's wrong."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "floats.parquet"
    table = pa.table({"x": pa.array([1.0, 2.0, 3.0], type=pa.float64())})
    pq.write_table(table, str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "avg", "type": "quantitative"},
                "y": {"field": "avg", "type": "quantitative"},
            },
        },
        "dataset": {"uri": "data/floats.parquet", "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "x", "fn": "mean", "as": "avg"},
            ]},
        ],
    }
    d = Daemon(tmp_path)
    resp, _ = d.handle({"op": "aggregate", "id": 1, "spec": spec})
    assert resp["ok"] is True, resp
    assert "warnings" not in resp["data"], resp["data"]


def test_g5_cache_hit_preserves_warnings(tmp_path) -> None:
    """Opus G5 audit (2026-05-13): the daemon's Arrow cache stores
    only the binary payload; warnings are compile-time metadata. The
    cache-hit code path must re-derive warnings via a (cheap) re-run
    of compile_spec, otherwise the second call (same spec, same
    parquet) silently drops the warning the first call surfaced —
    defeating G5's entire premise for the common case (chart
    re-rendered on tab switch / undo / inspector toggle)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "ints.parquet"
    table = pa.table({"n": pa.array([1, 2, 3], type=pa.int64())})
    pq.write_table(table, str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "total", "type": "quantitative"},
                "y": {"field": "total", "type": "quantitative"},
            },
        },
        "dataset": {"uri": "data/ints.parquet", "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "n", "fn": "sum", "as": "total"},
            ]},
        ],
    }
    d = Daemon(tmp_path)
    first, _ = d.handle({"op": "aggregate", "id": 1, "spec": spec})
    assert first["ok"] is True, first
    first_warnings = first["data"].get("warnings")
    assert first_warnings is not None and len(first_warnings) == 1

    # Same spec, same daemon → cache hit.
    second, _ = d.handle({"op": "aggregate", "id": 2, "spec": spec})
    assert second["ok"] is True, second
    assert second["data"]["cached"] is True, "second call must be a cache hit"
    second_warnings = second["data"].get("warnings")
    assert second_warnings is not None and len(second_warnings) == 1, second["data"]
    assert second_warnings == first_warnings, (
        f"cache-hit warnings must match cold: {first_warnings} vs {second_warnings}"
    )


def test_g5_warning_on_sum_of_int32(tmp_path) -> None:
    """Codex G5 audit (2026-05-13): `sum(int32)` can still exceed 2^53
    over very large row counts; warn so the precision risk is visible
    even though the daemon's default 1M-row cap keeps it safe in
    practice."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    p = tmp_path / "data" / "ints32.parquet"
    p.parent.mkdir(parents=True)
    table = pa.table({"v": pa.array([1, 2, 3], type=pa.int32())})
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "total", "type": "quantitative"},
                "y": {"field": "total", "type": "quantitative"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "v", "fn": "sum", "as": "total"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.warnings) == 1, cq.warnings
    assert "32-bit integer" in cq.warnings[0]


def test_g5_no_warning_on_mean_of_int32(tmp_path) -> None:
    """Regression pin: `mean(int32)` produces a value near source
    magnitudes — well under 2^53. No warning expected (only `sum`
    can drift past the safe-int boundary)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    p = tmp_path / "data" / "ints32.parquet"
    p.parent.mkdir(parents=True)
    table = pa.table({"v": pa.array([1, 2, 3], type=pa.int32())})
    pq.write_table(table, str(p))
    schema = pq.read_schema(str(p))
    spec = {
        "chart": {
            "family": "general", "type": "bar",
            "encodings": {
                "x": {"field": "avg", "type": "quantitative"},
                "y": {"field": "avg", "type": "quantitative"},
            },
        },
        "dataset": {"uri": str(p), "schema_version": 1},
        "transforms": [
            {"kind": "aggregate", "aggs": [
                {"column": "v", "fn": "mean", "as": "avg"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert cq.warnings == [], cq.warnings


# ---------------------------------------------------------------------------
# Front 2 (2026-05-14) -- per-transform schema-snapshot attribution
# ---------------------------------------------------------------------------


def _ohlcv_schema(tmp_path) -> tuple[Path, pa.Schema]:
    """Common helper: emit a BTC-shaped OHLCV parquet + return (path, schema)."""
    p = tmp_path / "data" / "ohlcv.parquet"
    p.parent.mkdir(parents=True)
    table = pa.table({
        "date": pa.array([1700000000000, 1700086400000, 1700172800000], type=pa.timestamp("ms")),
        "open": [100.0, 101.0, 102.0],
        "high": [101.5, 102.5, 103.5],
        "low": [99.5, 100.5, 101.5],
        "close": [101.0, 102.0, 103.0],
        "volume": [1000, 1100, 1200],
    })
    pq.write_table(table, str(p))
    return p, pq.read_schema(str(p))


def test_attribution_empty_for_spec_with_no_transforms(tmp_path) -> None:
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "scatter", "encodings": {
            "x": {"field": "open", "type": "quantitative"},
            "y": {"field": "close", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [],
    }
    cq = compile_spec(spec, schema, str(p))
    assert cq.attribution == []


def test_attribution_filter_neither_produces_nor_drops(tmp_path) -> None:
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "scatter", "encodings": {
            "x": {"field": "open", "type": "quantitative"},
            "y": {"field": "close", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "filter", "column": "close", "op": ">", "value": 100},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.attribution) == 1
    r = cq.attribution[0]
    assert r.index == 0
    assert r.kind == "filter"
    assert r.produces == []
    assert r.drops == []
    # All source columns survive.
    assert set(r.available_after) == {"date", "open", "high", "low", "close", "volume"}


def test_attribution_aggregate_drops_non_grouped_columns(tmp_path) -> None:
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "bar", "encodings": {
            "x": {"field": "date", "type": "temporal"},
            "y": {"field": "mean_close", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "groupby", "columns": ["date"]},
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "mean", "as": "mean_close"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.attribution) == 2
    # groupby is pass-through.
    gb = cq.attribution[0]
    assert gb.kind == "groupby"
    assert gb.produces == []
    assert gb.drops == []
    # aggregate keeps groupby cols + aggregate aliases; drops everything else.
    agg = cq.attribution[1]
    assert agg.kind == "aggregate"
    assert agg.index == 1
    assert agg.produces == ["mean_close"]
    assert set(agg.drops) == {"open", "high", "low", "close", "volume"}
    assert set(agg.available_after) == {"date", "mean_close"}


def test_attribution_window_produces_alias(tmp_path) -> None:
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "line", "encodings": {
            "x": {"field": "date", "type": "temporal"},
            "y": {"field": "sma", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "window", "column": "close", "fn": "rolling_mean",
             "window": 3, "order_by": "date", "as": "sma"},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.attribution) == 1
    r = cq.attribution[0]
    assert r.kind == "window"
    assert r.produces == ["sma"]
    assert r.drops == []
    assert "sma" in r.available_after


def test_attribution_window_then_aggregate_drops_alias(tmp_path) -> None:
    """First-drop-wins test: window produces 'sma'; aggregate drops it."""
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "bar", "encodings": {
            "x": {"field": "date", "type": "temporal"},
            "y": {"field": "mean_close", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "window", "column": "close", "fn": "rolling_mean",
             "window": 3, "order_by": "date", "as": "sma"},
            {"kind": "groupby", "columns": ["date"]},
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "mean", "as": "mean_close"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.attribution) == 3
    assert cq.attribution[0].produces == ["sma"]
    # aggregate at index 2 drops sma + others.
    agg = cq.attribution[2]
    assert "sma" in agg.drops
    # No reintroduction; available_after lacks sma.
    assert "sma" not in agg.available_after


def test_attribution_enriches_encoding_error_message(tmp_path) -> None:
    """Core Front 2 user-facing fix: when an encoding references a column
    that an upstream transform dropped, the CompileError message names
    the responsible transform."""
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "bar", "encodings": {
            "x": {"field": "date", "type": "temporal"},
            # Encoding references 'close' but aggregate at index 1 drops it.
            "y": {"field": "close", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "groupby", "columns": ["date"]},
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "mean", "as": "mean_close"},
            ]},
        ],
    }
    with pytest.raises(CompileError) as exc_info:
        compile_spec(spec, schema, str(p))
    msg = str(exc_info.value)
    assert "chart.encodings.y.field='close' not in pipeline columns" in msg
    assert "dropped by transform #1 (aggregate)" in msg


def test_attribution_error_without_attribution_has_no_suffix(tmp_path) -> None:
    """When a column is referenced that was NEVER in the pipeline (typo
    case), no `dropped by transform` suffix is added — that suffix is
    reserved for the specific 'a transform dropped it' diagnosis."""
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "scatter", "encodings": {
            "x": {"field": "open", "type": "quantitative"},
            "y": {"field": "closeprice_typo", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [],
    }
    with pytest.raises(CompileError) as exc_info:
        compile_spec(spec, schema, str(p))
    msg = str(exc_info.value)
    assert "not in pipeline columns" in msg
    assert "dropped by transform" not in msg


def test_attribution_ohlcv_encoding_error_enriched(tmp_path) -> None:
    """Same enrichment for candlestick OHLCV cluster references."""
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {
            "family": "timeseries", "type": "candlestick",
            "encodings": {"ohlcv": {
                "time": "date", "open": "open", "high": "high",
                # 'low' was dropped by aggregate below.
                "low": "low", "close": "close",
            }},
        },
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "groupby", "columns": ["date"]},
            {"kind": "aggregate", "aggs": [
                {"column": "open", "fn": "first", "as": "open"},
                {"column": "high", "fn": "max", "as": "high"},
                {"column": "close", "fn": "last", "as": "close"},
            ]},
        ],
    }
    with pytest.raises(CompileError) as exc_info:
        compile_spec(spec, schema, str(p))
    msg = str(exc_info.value)
    assert "chart.encodings.ohlcv.low='low' not in pipeline columns" in msg
    assert "dropped by transform #1 (aggregate)" in msg


def test_attribution_bin_then_groupby_aggregate_keeps_bin(tmp_path) -> None:
    """bin produces the bin column; aggregate over a groupby that includes
    the bin keeps it; chain attribution is per-transform correct."""
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "bar", "encodings": {
            "x": {"field": "close_bin", "type": "ordinal"},
            "y": {"field": "n", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "bin", "column": "close", "n_bins": 5, "as": "close_bin"},
            {"kind": "groupby", "columns": ["close_bin"]},
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "count", "as": "n"},
            ]},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert len(cq.attribution) == 3
    assert cq.attribution[0].produces == ["close_bin"]
    # aggregate keeps the binned grouping column + count alias.
    agg = cq.attribution[2]
    assert set(agg.available_after) == {"close_bin", "n"}


def test_attribution_dataclass_field_types(tmp_path) -> None:
    """Defensive shape pin: attribution records are TransformAttribution
    dataclass instances with the expected fields."""
    p, schema = _ohlcv_schema(tmp_path)
    spec = {
        "chart": {"family": "general", "type": "scatter", "encodings": {
            "x": {"field": "open", "type": "quantitative"},
            "y": {"field": "close", "type": "quantitative"},
        }},
        "dataset": {"uri": str(p)},
        "transforms": [
            {"kind": "filter", "column": "close", "op": ">", "value": 100},
        ],
    }
    cq = compile_spec(spec, schema, str(p))
    assert isinstance(cq.attribution[0], TransformAttribution)
    r = cq.attribution[0]
    assert isinstance(r.index, int)
    assert isinstance(r.kind, str)
    assert isinstance(r.produces, list)
    assert isinstance(r.drops, list)
    assert isinstance(r.available_after, list)
