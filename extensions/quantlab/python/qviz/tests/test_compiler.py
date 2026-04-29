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
    compile_spec,
    quote_ident,
)


@pytest.fixture
def parquet_1m() -> str:
    p = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
    if not p.exists():
        pytest.skip("spike test data not present")
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
        {"kind": "window", "column": "close", "fn": "rolling_mean", "window": 20, "as": "ma20"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert 'avg("close") OVER (ROWS BETWEEN 19 PRECEDING' in cq.sql


def test_rolling_requires_window(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "rolling_mean", "as": "ma"},
    ])
    with pytest.raises(CompileError, match="window >= 1"):
        compile_spec(spec, schema_1m, parquet_1m)


def test_ema_not_implemented_v1(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "window", "column": "close", "fn": "ema", "window": 20, "as": "ema20"},
    ])
    with pytest.raises(CompileError, match="ema"):
        compile_spec(spec, schema_1m, parquet_1m)


# ---------------------------------------------------------------------------
# Math
# ---------------------------------------------------------------------------


def test_log_returns(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "math", "column": "close", "fn": "log_returns", "as": "logret"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "ln(" in cq.sql
    assert "lag(" in cq.sql


def test_drawdown(schema_1m: pa.Schema, parquet_1m: str) -> None:
    spec = _spec_with_transforms([
        {"kind": "math", "column": "close", "fn": "drawdown", "as": "dd"},
    ])
    cq = compile_spec(spec, schema_1m, parquet_1m)
    assert "max(" in cq.sql
    assert "ROWS UNBOUNDED PRECEDING" in cq.sql


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
        {"kind": "math", "column": "close", "fn": "log_returns", "as": "logret"},
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
