"""Pytest coverage for the qviz preset API.

Covers happy paths, validation guards (string hygiene, dtype enforcement,
overwrite refusal), math correctness on adversarial drawdown inputs,
aggregation pipeline correctness via DuckDB execution, and end-to-end
parity against the daemon's `security.resolve_workspace_path` resolver.

Megaudit cure regression tests are tagged with their finding id (B-N
BLOCKERs, M-N MAJORs).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import pytest

import qviz
from qviz import reader, security
from qviz.compiler import compile_spec
from qviz.presets._common import (
    MAX_LIMIT_N,
    MAX_STRING_LENGTH,
    PRESET_QUERY_HASH,
)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Each test gets a fresh tmp dir set as CWD (workspace root)."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def ohlcv_df() -> pd.DataFrame:
    return pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=8, freq="D", tz="UTC"),
        "open":   [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0],
        "high":   [101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0],
        "low":    [99.0,  100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0],
        "close":  [101.0, 102.0, 103.0, 104.0, 105.0, 106.0, 107.0, 108.0],
        "volume": [10,    20,    30,    40,    50,    60,    70,    80],
    })


@pytest.fixture
def equity_df() -> pd.DataFrame:
    return pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=10, freq="D", tz="UTC"),
        "equity": [100_000.0 + i * 50.0 for i in range(10)],
    })


@pytest.fixture
def pnl_df() -> pd.DataFrame:
    return pd.DataFrame({
        "strategy": ["alpha", "beta", "alpha", "gamma", "beta"],
        "pnl":      [100.0, -50.0, 25.0, 75.0, 30.0],
    })


@pytest.fixture
def factor_df() -> pd.DataFrame:
    return pd.DataFrame({
        "factor":   ["mom", "mom", "val", "size", "qual"],
        "exposure": [0.45, 0.50, -0.10, 0.20, 0.30],
    })


# ---------------------------------------------------------------------------
# Validator parity (Python port of src/qviz/validate.ts key rules)
# ---------------------------------------------------------------------------


_HEX64 = re.compile(r"^sha256:[0-9a-f]{64}$")
_ISO8601 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)
_ALLOWED_FAMILY_TYPES = {
    "timeseries": {"line", "area", "bar", "histogram", "candlestick", "baseline"},
    "general":    {"scatter", "heatmap", "bar", "pie", "histogram", "line"},
}
_ALLOWED_DECIMATION = {"auto", "lttb", "minmax", "none"}
_ALLOWED_TRANSFORM_KINDS = {
    "filter", "date_trunc", "bin", "groupby", "aggregate",
    "window", "math", "resample", "tz_convert", "sort", "limit",
}
_REQUIRED_TOP_KEYS = {"qviz_version", "dataset", "transforms", "chart", "provenance"}
_ALLOWED_TOP_KEYS = _REQUIRED_TOP_KEYS | {"$schema", "title", "description", "trading_options"}
_REQUIRED_DATASET_KEYS = {"uri", "schema_hash", "mtime_ns"}
_REQUIRED_PROVENANCE_KEYS = {"generated_at", "generator", "query_hash", "tool_versions"}


def _assert_string_acceptable(s: str, field_label: str) -> None:
    assert isinstance(s, str), f"{field_label} must be str"
    assert len(s) <= MAX_STRING_LENGTH, f"{field_label} > {MAX_STRING_LENGTH} chars"
    for ch in s:
        assert ch != "\x00", f"{field_label} contains NUL"
        code = ord(ch)
        assert code >= 0x20 or ch in ("\t", "\n", "\r"), (
            f"{field_label} contains C0 0x{code:02x}"
        )


def _walk_strings(node: object, label: str = "spec") -> None:
    """Walk every str leaf in the spec and apply isAcceptableString."""
    if isinstance(node, str):
        _assert_string_acceptable(node, label)
    elif isinstance(node, dict):
        for k, v in node.items():
            _walk_strings(v, f"{label}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk_strings(v, f"{label}[{i}]")


def assert_spec_validator_compliant(spec: dict) -> None:
    """Replicate the TS validator's structural + string rules.

    Catches preset bugs that would later fail the TS validator at editor
    load time. Wider than the original Phase 7 parity helper — now also
    checks string hygiene on every leaf, decimation enum, transform-kind
    enum, pipeline ordering (aggregate must follow groupby).
    """
    extra = set(spec.keys()) - _ALLOWED_TOP_KEYS
    assert not extra, f"unknown top-level keys: {extra}"
    missing = _REQUIRED_TOP_KEYS - set(spec.keys())
    assert not missing, f"missing required top-level keys: {missing}"
    assert spec["qviz_version"] == 1

    ds = spec["dataset"]
    assert _REQUIRED_DATASET_KEYS <= set(ds.keys())
    assert _HEX64.match(ds["schema_hash"])
    assert isinstance(ds["mtime_ns"], int) and 0 <= ds["mtime_ns"] <= 7e18
    assert isinstance(ds["uri"], str) and ds["uri"]
    assert not ds["uri"].startswith("/")
    assert ".." not in Path(ds["uri"]).parts

    chart = spec["chart"]
    assert chart["family"] in _ALLOWED_FAMILY_TYPES
    assert chart["type"] in _ALLOWED_FAMILY_TYPES[chart["family"]]
    opts = chart.get("options", {})
    if "decimation" in opts:
        assert opts["decimation"] in _ALLOWED_DECIMATION, (
            f"chart.options.decimation {opts['decimation']!r} not in allowed enum"
        )

    transforms = spec["transforms"]
    assert isinstance(transforms, list)
    for i, t in enumerate(transforms):
        assert isinstance(t, dict) and "kind" in t
        assert t["kind"] in _ALLOWED_TRANSFORM_KINDS, f"transform[{i}] kind {t['kind']!r}"
        # Pipeline ordering: aggregate must be immediately preceded by groupby
        # (matches validate.ts pipelineValidate rule).
        if t["kind"] == "aggregate":
            assert i > 0 and transforms[i - 1]["kind"] == "groupby", (
                f"aggregate at index {i} must follow a groupby"
            )

    prov = spec["provenance"]
    missing_prov = _REQUIRED_PROVENANCE_KEYS - set(prov.keys())
    assert not missing_prov
    assert _ISO8601.match(prov["generated_at"])
    assert _HEX64.match(prov["query_hash"])
    assert prov["tool_versions"].get("qviz_schema") == 1
    if "source" in prov:
        assert prov["source"] in {"engine-emitted", "user-built", "imported"}

    _walk_strings(spec)


def _load_compile_and_resolve(spec_path: Path, workspace: Path) -> dict:
    """Read the spec JSON, resolve its dataset.uri via security.py
    (NOT by deriving from the spec filename), and round-trip through
    the daemon compiler. Returns the spec for per-preset assertions."""
    spec = json.loads(spec_path.read_text())
    assert_spec_validator_compliant(spec)
    # Resolve via the SAME path the daemon would take on file open.
    resolved = security.resolve_workspace_path(workspace, spec["dataset"]["uri"])
    assert resolved.exists()
    schema = reader.read_schema(resolved)
    compile_spec(spec, schema, str(resolved))
    return spec


def _execute_aggregate(spec_path: Path, workspace: Path) -> pd.DataFrame:
    """Compile the spec to SQL and execute it through DuckDB to verify
    aggregate math, not just structural validity."""
    spec = json.loads(spec_path.read_text())
    parquet = security.resolve_workspace_path(workspace, spec["dataset"]["uri"])
    schema = reader.read_schema(parquet)
    cq = compile_spec(spec, schema, str(parquet))
    conn = duckdb.connect()
    rows = conn.execute(cq.sql, cq.params).fetchdf()
    conn.close()
    return rows


# ---------------------------------------------------------------------------
# candlestick
# ---------------------------------------------------------------------------


def test_candlestick_happy_path(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    out = qviz.candlestick(ohlcv_df, "out/btc", title="BTC daily")
    assert out == workspace / "out" / "btc.qviz.json"
    assert (workspace / "out" / "btc.parquet").exists()
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["chart"]["family"] == "timeseries"
    assert spec["chart"]["type"] == "candlestick"
    enc = spec["chart"]["encodings"]["ohlcv"]
    assert enc == {
        "time": "time", "open": "open", "high": "high",
        "low": "low", "close": "close", "volume": "volume",
    }
    assert spec["title"] == "BTC daily"


def test_candlestick_without_volume(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    df = ohlcv_df.drop(columns=["volume"])
    out = qviz.candlestick(df, "out/btc")
    spec = _load_compile_and_resolve(out, workspace)
    assert "volume" not in spec["chart"]["encodings"]["ohlcv"]


def test_candlestick_emits_implicit_sort_before_limit(
    workspace: Path, ohlcv_df: pd.DataFrame,
) -> None:
    """M-16/M-17 cure: candlestick MUST emit `sort time asc` before `limit`."""
    out = qviz.candlestick(ohlcv_df, "out/btc", limit=4)
    spec = _load_compile_and_resolve(out, workspace)
    kinds = [t["kind"] for t in spec["transforms"]]
    assert kinds == ["sort", "limit"], f"got {kinds}"
    assert spec["transforms"][0]["columns"] == [{"column": "time", "desc": False}]
    assert spec["transforms"][1]["n"] == 4


def test_candlestick_missing_required_column(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    df = ohlcv_df.drop(columns=["high"])
    with pytest.raises(KeyError, match="high"):
        qviz.candlestick(df, "out/btc")


def test_candlestick_string_time_rejected(workspace: Path) -> None:
    """B-9 cure: string-typed time column must be rejected at the preset."""
    df = pd.DataFrame({
        "time":   ["2026-01-01", "2026-01-02"],
        "open":   [100.0, 101.0],
        "high":   [101.0, 102.0],
        "low":    [99.0,  100.0],
        "close":  [101.0, 102.0],
    })
    with pytest.raises(TypeError, match="datetime"):
        qviz.candlestick(df, "out/btc")


def test_candlestick_rejects_invalid_limit(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match=r"\[1, 10000000\]"):
        qviz.candlestick(ohlcv_df, "out/btc", limit=0)
    with pytest.raises(ValueError, match=r"\[1, 10000000\]"):
        qviz.candlestick(ohlcv_df, "out/btc", limit=10_000_001)


def test_candlestick_rejects_limit_bool(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    """M-9 cure: limit=True is bool, must be rejected (not silently coerced to 1)."""
    with pytest.raises(TypeError, match="bool"):
        qviz.candlestick(ohlcv_df, "out/btc", limit=True)


def test_candlestick_rejects_invalid_decimation(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    """B-6 cure: decimation outside the allowed enum must be rejected."""
    with pytest.raises(ValueError, match="decimation"):
        qviz.candlestick(ohlcv_df, "out/btc", decimation="bogus")


# ---------------------------------------------------------------------------
# equity_curve
# ---------------------------------------------------------------------------


def test_equity_curve_happy_path(workspace: Path, equity_df: pd.DataFrame) -> None:
    out = qviz.equity_curve(equity_df, "out/eq")
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["chart"]["family"] == "timeseries"
    assert spec["chart"]["type"] == "line"
    assert spec["chart"]["encodings"]["x"]["field"] == "time"
    assert spec["chart"]["encodings"]["y"]["field"] == "equity"


def test_equity_curve_custom_columns(workspace: Path) -> None:
    df = pd.DataFrame({
        "ts":  pd.date_range("2026-01-01", periods=5, freq="D", tz="UTC"),
        "nav": [100.0, 101.0, 99.5, 100.2, 101.5],
    })
    out = qviz.equity_curve(df, "out/eq", time_col="ts", equity_col="nav")
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["chart"]["encodings"]["x"]["field"] == "ts"
    assert spec["chart"]["encodings"]["y"]["field"] == "nav"


def test_equity_curve_missing_required_column(workspace: Path) -> None:
    df = pd.DataFrame({"time": pd.date_range("2026-01-01", periods=3, freq="D")})
    with pytest.raises(KeyError, match="equity"):
        qviz.equity_curve(df, "out/eq")


def test_equity_curve_normalizes_inf(workspace: Path) -> None:
    """M-15 cure: inf/-inf in equity must be normalized to NaN before write."""
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC"),
        "equity": [100.0, math.inf, -math.inf],
    })
    out = qviz.equity_curve(df, "out/eq")
    parquet = (workspace / "out" / "eq.parquet")
    values = pq.read_table(parquet).column("equity").to_pylist()
    assert values[0] == 100.0
    # pyarrow may serialize NaN as None on to_pylist; either form is fine
    # as long as the value is non-finite.
    assert values[1] is None or math.isnan(values[1])
    assert values[2] is None or math.isnan(values[2])


def test_equity_curve_rejects_string_time(workspace: Path) -> None:
    """B-9 cure: string time column rejected."""
    df = pd.DataFrame({
        "time":   ["2026-01-01", "2026-01-02"],
        "equity": [100.0, 110.0],
    })
    with pytest.raises(TypeError, match="datetime"):
        qviz.equity_curve(df, "out/eq")


def test_equity_curve_rejects_collision(workspace: Path) -> None:
    df = pd.DataFrame({"x": pd.date_range("2026-01-01", periods=2, freq="D")})
    with pytest.raises(ValueError, match="time_col and equity_col must differ"):
        qviz.equity_curve(df, "out/eq", time_col="x", equity_col="x")


# ---------------------------------------------------------------------------
# pnl_by_strategy
# ---------------------------------------------------------------------------


def test_pnl_by_strategy_aggregated(workspace: Path, pnl_df: pd.DataFrame) -> None:
    out = qviz.pnl_by_strategy(pnl_df, "out/pnl")
    spec = _load_compile_and_resolve(out, workspace)
    kinds = [t["kind"] for t in spec["transforms"]]
    assert kinds == ["groupby", "aggregate", "sort"]
    assert spec["chart"]["encodings"]["y"]["field"] == "pnl_sum"


def test_pnl_by_strategy_sort_has_tiebreak(workspace: Path, pnl_df: pd.DataFrame) -> None:
    """M-25 cure: sort transform must include a secondary key on strategy_col asc."""
    out = qviz.pnl_by_strategy(pnl_df, "out/pnl")
    spec = json.loads(out.read_text())
    sort = next(t for t in spec["transforms"] if t["kind"] == "sort")
    assert sort["columns"] == [
        {"column": "pnl_sum", "desc": True},
        {"column": "strategy", "desc": False},
    ]


def test_pnl_by_strategy_aggregation_correctness(
    workspace: Path, pnl_df: pd.DataFrame,
) -> None:
    """M-30 cure: execute the compiled SQL and verify aggregate values."""
    out = qviz.pnl_by_strategy(pnl_df, "out/pnl")
    rows = _execute_aggregate(out, workspace)
    expected = {"alpha": 125.0, "beta": -20.0, "gamma": 75.0}
    actual = dict(zip(rows["strategy"], rows["pnl_sum"]))
    assert actual == expected
    # Descending sort: largest first.
    assert list(rows["strategy"]) == ["alpha", "gamma", "beta"]


def test_pnl_by_strategy_raw(workspace: Path, pnl_df: pd.DataFrame) -> None:
    out = qviz.pnl_by_strategy(pnl_df, "out/pnl", aggregate=False)
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["transforms"] == []
    assert spec["chart"]["encodings"]["y"]["field"] == "pnl"


def test_pnl_by_strategy_rejects_aggregate_string(workspace: Path, pnl_df: pd.DataFrame) -> None:
    """M-10 cure: aggregate='False' (truthy str) must be rejected."""
    with pytest.raises(TypeError, match="aggregate"):
        qviz.pnl_by_strategy(pnl_df, "out/pnl", aggregate="False")  # type: ignore[arg-type]


def test_pnl_by_strategy_rejects_non_numeric_pnl(workspace: Path) -> None:
    """M-12 cure: non-numeric pnl_col rejected at preset."""
    df = pd.DataFrame({"strategy": ["a", "b"], "pnl": ["1.0", "2.0"]})
    with pytest.raises(TypeError, match="numeric"):
        qviz.pnl_by_strategy(df, "out/pnl")


def test_pnl_by_strategy_rejects_alias_collision(workspace: Path) -> None:
    """M-11 cure: strategy_col == 'pnl_sum' (derived alias) rejected."""
    df = pd.DataFrame({"pnl_sum": ["a"], "pnl": [1.0]})
    with pytest.raises(ValueError, match="alias"):
        qviz.pnl_by_strategy(df, "out/pnl", strategy_col="pnl_sum")


def test_pnl_by_strategy_missing_required_column(workspace: Path) -> None:
    df = pd.DataFrame({"strategy": ["a", "b"]})
    with pytest.raises(KeyError, match="pnl"):
        qviz.pnl_by_strategy(df, "out/pnl")


# ---------------------------------------------------------------------------
# drawdown — math correctness on adversarial inputs (M-29 cure)
# ---------------------------------------------------------------------------


def test_drawdown_happy_path(workspace: Path, equity_df: pd.DataFrame) -> None:
    out = qviz.drawdown(equity_df, "out/dd")
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["chart"]["family"] == "timeseries"
    assert spec["chart"]["type"] == "area"
    assert spec["chart"]["encodings"]["y"]["field"] == "drawdown"
    cols = pq.read_schema(workspace / "out" / "dd.parquet").names
    assert set(cols) == {"time", "drawdown"}


def test_drawdown_positive_equity_running_max_diverges(workspace: Path) -> None:
    """Running-max ≠ global-max fixture (M-29 cure: avoids spurious-pass risk)."""
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=6, freq="D", tz="UTC"),
        "equity": [100.0, 110.0, 105.0, 120.0, 90.0, 95.0],
    })
    out = qviz.drawdown(df, "out/dd")
    values = pq.read_table(workspace / "out" / "dd.parquet").column("drawdown").to_pylist()
    # running_max trajectory: 100, 110, 110, 120, 120, 120
    # drawdowns:              0,   0,   -1/22, 0, -0.25, -25/120
    assert values[0] == pytest.approx(0.0, abs=1e-9)
    assert values[1] == pytest.approx(0.0, abs=1e-9)
    assert values[2] == pytest.approx(105.0 / 110.0 - 1.0, abs=1e-9)
    assert values[3] == pytest.approx(0.0, abs=1e-9)
    assert values[4] == pytest.approx(-0.25, abs=1e-9)
    assert values[5] == pytest.approx(95.0 / 120.0 - 1.0, abs=1e-9)


def test_drawdown_negative_equity_emits_nan_not_positive(workspace: Path) -> None:
    """B-4 cure: negative equity must NOT produce positive drawdown values."""
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=4, freq="D", tz="UTC"),
        "equity": [-100.0, -200.0, -50.0, -300.0],
    })
    out = qviz.drawdown(df, "out/dd")
    values = pq.read_table(workspace / "out" / "dd.parquet").column("drawdown").to_pylist()
    # All values undefined (running_max ≤ 0 throughout) → all None/NaN.
    assert all(v is None or math.isnan(v) for v in values), f"got {values}"


def test_drawdown_zero_crossing_partial_nan(workspace: Path) -> None:
    """B-5 cure: equity starting at 0 yields NULL at row 0 (running_max=0)."""
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC"),
        "equity": [0.0, 100.0, 50.0],
    })
    out = qviz.drawdown(df, "out/dd")
    values = pq.read_table(workspace / "out" / "dd.parquet").column("drawdown").to_pylist()
    assert values[0] is None or math.isnan(values[0])  # 0/0 undefined
    assert values[1] == pytest.approx(0.0, abs=1e-9)
    assert values[2] == pytest.approx(-0.5, abs=1e-9)


def test_drawdown_all_zero_equity_all_nan(workspace: Path) -> None:
    """B-5 cure: all-zero equity → all-NULL drawdown (never positive/inf)."""
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC"),
        "equity": [0.0, 0.0, 0.0],
    })
    out = qviz.drawdown(df, "out/dd")
    values = pq.read_table(workspace / "out" / "dd.parquet").column("drawdown").to_pylist()
    assert all(v is None or math.isnan(v) for v in values)


def test_drawdown_single_row(workspace: Path) -> None:
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=1, freq="D", tz="UTC"),
        "equity": [100.0],
    })
    out = qviz.drawdown(df, "out/dd")
    values = pq.read_table(workspace / "out" / "dd.parquet").column("drawdown").to_pylist()
    assert values == [pytest.approx(0.0, abs=1e-9)]


def test_drawdown_nan_in_equity(workspace: Path) -> None:
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=4, freq="D", tz="UTC"),
        "equity": [100.0, math.nan, 110.0, 90.0],
    })
    out = qviz.drawdown(df, "out/dd")
    values = pq.read_table(workspace / "out" / "dd.parquet").column("drawdown").to_pylist()
    # NaN row stays NaN; subsequent rows use running_max from finite history.
    assert values[0] == pytest.approx(0.0, abs=1e-9)
    assert values[1] is None or math.isnan(values[1])
    assert values[2] == pytest.approx(0.0, abs=1e-9)
    assert values[3] == pytest.approx(90.0 / 110.0 - 1.0, abs=1e-9)


def test_drawdown_float32_equity_writes_float64(workspace: Path) -> None:
    """M-14 cure: float32 input casts to float64 for schema_hash stability."""
    df = pd.DataFrame({
        "time":   pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC"),
        "equity": np.array([100.0, 110.0, 90.0], dtype="float32"),
    })
    out = qviz.drawdown(df, "out/dd")
    schema = pq.read_schema(workspace / "out" / "dd.parquet")
    assert str(schema.field("drawdown").type) == "double"


def test_drawdown_rejects_time_col_equals_drawdown(workspace: Path) -> None:
    """B-8 cure: time_col='drawdown' would collide with the derived column."""
    df = pd.DataFrame({
        "drawdown": pd.date_range("2026-01-01", periods=2, freq="D", tz="UTC"),
        "equity":   [100.0, 110.0],
    })
    with pytest.raises(ValueError, match="drawdown"):
        qviz.drawdown(df, "out/dd", time_col="drawdown")


def test_drawdown_rejects_time_equals_equity(workspace: Path) -> None:
    df = pd.DataFrame({"x": pd.date_range("2026-01-01", periods=2, freq="D")})
    with pytest.raises(ValueError, match="time_col and equity_col must differ"):
        qviz.drawdown(df, "out/dd", time_col="x", equity_col="x")


# ---------------------------------------------------------------------------
# factor_exposure
# ---------------------------------------------------------------------------


def test_factor_exposure_aggregated(workspace: Path, factor_df: pd.DataFrame) -> None:
    out = qviz.factor_exposure(factor_df, "out/fx")
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["chart"]["family"] == "general"
    assert spec["chart"]["type"] == "bar"
    assert spec["chart"]["encodings"]["y"]["field"] == "exposure_mean"


def test_factor_exposure_aggregation_correctness(
    workspace: Path, factor_df: pd.DataFrame,
) -> None:
    """M-30 cure: verify mean values via DuckDB execution."""
    out = qviz.factor_exposure(factor_df, "out/fx")
    rows = _execute_aggregate(out, workspace)
    actual = dict(zip(rows["factor"], rows["exposure_mean"]))
    assert actual["mom"] == pytest.approx(0.475, abs=1e-9)
    assert actual["val"] == pytest.approx(-0.10, abs=1e-9)
    assert actual["qual"] == pytest.approx(0.30, abs=1e-9)
    assert actual["size"] == pytest.approx(0.20, abs=1e-9)


def test_factor_exposure_sort_has_tiebreak(workspace: Path, factor_df: pd.DataFrame) -> None:
    """M-25 cure: tie-break sort key on factor_col asc."""
    out = qviz.factor_exposure(factor_df, "out/fx")
    spec = json.loads(out.read_text())
    sort = next(t for t in spec["transforms"] if t["kind"] == "sort")
    assert sort["columns"] == [
        {"column": "exposure_mean", "desc": True},
        {"column": "factor", "desc": False},
    ]


def test_factor_exposure_raw(workspace: Path, factor_df: pd.DataFrame) -> None:
    out = qviz.factor_exposure(factor_df, "out/fx", aggregate=False)
    spec = _load_compile_and_resolve(out, workspace)
    assert spec["transforms"] == []
    assert spec["chart"]["encodings"]["y"]["field"] == "exposure"


def test_factor_exposure_missing_required_column(workspace: Path) -> None:
    df = pd.DataFrame({"factor": ["a", "b"]})
    with pytest.raises(KeyError, match="exposure"):
        qviz.factor_exposure(df, "out/fx")


# ---------------------------------------------------------------------------
# Output path rejection (BLOCKERs B-1, B-2, B-3, plus MAJOR M-4, M-5, M-7)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_output,err_match", [
    pytest.param("", "empty string", id="empty"),
    pytest.param("a\x00b", "NUL", id="nul"),
    pytest.param("\x01ctrl", "control", id="ctrl"),
    pytest.param("../escape", r"'\.\.'", id="dotdot"),
    pytest.param("out/", "separator", id="trailing-slash"),
    pytest.param(".", "basename", id="dot-only"),
    pytest.param("..", r"'\.\.'", id="dotdot-only"),
    pytest.param("out/btc.usdt", "basename must not contain", id="dot-in-basename"),
    pytest.param("out/btc.parquet", "basename must not contain", id="parquet-extension"),
    pytest.param("out/v0.1", "basename must not contain", id="version-stem"),
    pytest.param("out/2026-Q1.v1", "basename must not contain", id="date-stem"),
])
def test_output_rejection_paths(
    workspace: Path, ohlcv_df: pd.DataFrame, bad_output: str, err_match: str,
) -> None:
    with pytest.raises((ValueError, TypeError), match=err_match):
        qviz.candlestick(ohlcv_df, bad_output)


def test_output_absolute_path_rejected(workspace: Path, ohlcv_df: pd.DataFrame) -> None:
    """M-5 cure: absolute paths rejected outright (workspace-relative only)."""
    with pytest.raises(ValueError, match="absolute"):
        qviz.candlestick(ohlcv_df, str(workspace / "out" / "btc"))


def test_output_outside_cwd_rejected(
    workspace: Path, tmp_path_factory: pytest.TempPathFactory, ohlcv_df: pd.DataFrame,
) -> None:
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    with pytest.raises(ValueError, match="absolute"):
        qviz.candlestick(ohlcv_df, str(elsewhere / "x"))


def test_output_dot_does_not_write_outside_cwd(
    workspace: Path, ohlcv_df: pd.DataFrame,
) -> None:
    """B-3 cure: `output='.'` must be rejected (was a path-traversal hole)."""
    with pytest.raises(ValueError, match="basename"):
        qviz.candlestick(ohlcv_df, ".")
    # And nothing should land outside the workspace:
    parent = workspace.parent
    cwd_name = workspace.name
    siblings = [p for p in parent.iterdir() if p.name.startswith(cwd_name + ".")]
    assert siblings == [], f"sibling files leaked outside CWD: {siblings}"


# ---------------------------------------------------------------------------
# String hygiene on user-supplied kwargs (B-7 cure)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kwarg,value", [
    pytest.param("title", "a\x00b", id="title-nul"),
    pytest.param("title", "a" * (MAX_STRING_LENGTH + 1), id="title-oversized"),
    pytest.param("description", "\x01ctrl", id="description-ctrl"),
    pytest.param("timezone", "a\x00b", id="timezone-nul"),
    pytest.param("timezone", "", id="timezone-empty"),
])
def test_string_hygiene_rejected(
    workspace: Path, equity_df: pd.DataFrame, kwarg: str, value: str,
) -> None:
    with pytest.raises((ValueError, TypeError)):
        qviz.equity_curve(equity_df, "out/eq", **{kwarg: value})


def test_column_name_with_nul_rejected(workspace: Path) -> None:
    """B-7 cure: user-supplied column-name kwarg with NUL is rejected."""
    df = pd.DataFrame({
        "x\x00y":  pd.date_range("2026-01-01", periods=2, freq="D"),
        "equity": [100.0, 110.0],
    })
    with pytest.raises(ValueError, match="NUL"):
        qviz.equity_curve(df, "out/eq", time_col="x\x00y")


# ---------------------------------------------------------------------------
# Overwrite guard (M-3 cure)
# ---------------------------------------------------------------------------


def test_overwrite_refused_by_default(workspace: Path, equity_df: pd.DataFrame) -> None:
    qviz.equity_curve(equity_df, "out/eq")
    with pytest.raises(FileExistsError, match="overwrite"):
        qviz.equity_curve(equity_df, "out/eq")


def test_overwrite_true_replaces(workspace: Path, equity_df: pd.DataFrame) -> None:
    qviz.equity_curve(equity_df, "out/eq")
    qviz.equity_curve(equity_df, "out/eq", overwrite=True)


def test_overwrite_rejects_non_bool(workspace: Path, equity_df: pd.DataFrame) -> None:
    with pytest.raises(TypeError, match="overwrite"):
        qviz.equity_curve(equity_df, "out/eq", overwrite="yes")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Schema hash + provenance + atomicity
# ---------------------------------------------------------------------------


def test_schema_hash_matches_daemon_reader(workspace: Path, equity_df: pd.DataFrame) -> None:
    """B-12 cure: schema_hash must come from reader.read_schema (daemon parity)."""
    out = qviz.equity_curve(equity_df, "out/eq")
    spec = json.loads(out.read_text())
    parquet = workspace / "out" / "eq.parquet"
    expected = reader.hash_schema(reader.read_schema(parquet))
    assert spec["dataset"]["schema_hash"] == expected


def test_provenance_query_hash_is_zero_sentinel(workspace: Path, equity_df: pd.DataFrame) -> None:
    out = qviz.equity_curve(equity_df, "out/eq")
    spec = json.loads(out.read_text())
    assert spec["provenance"]["query_hash"] == PRESET_QUERY_HASH


def test_provenance_generated_at_has_microseconds(workspace: Path, equity_df: pd.DataFrame) -> None:
    """N-2 cure: timestamp now has microsecond precision so two same-second
    presets don't share generated_at."""
    out = qviz.equity_curve(equity_df, "out/eq")
    spec = json.loads(out.read_text())
    ts = spec["provenance"]["generated_at"]
    assert "." in ts, f"expected microsecond resolution, got {ts!r}"


def test_provenance_generator_per_preset(
    workspace: Path,
    ohlcv_df: pd.DataFrame, equity_df: pd.DataFrame,
    pnl_df: pd.DataFrame, factor_df: pd.DataFrame,
) -> None:
    cases = [
        (qviz.candlestick, ohlcv_df, "out/a", "qviz.candlestick/"),
        (qviz.equity_curve, equity_df, "out/b", "qviz.equity_curve/"),
        (qviz.pnl_by_strategy, pnl_df, "out/c", "qviz.pnl_by_strategy/"),
        (qviz.drawdown, equity_df, "out/d", "qviz.drawdown/"),
        (qviz.factor_exposure, factor_df, "out/e", "qviz.factor_exposure/"),
    ]
    for fn, df, stem, expected_prefix in cases:
        out = fn(df, stem)
        spec = json.loads(out.read_text())
        assert spec["provenance"]["generator"].startswith(expected_prefix)
        assert spec["provenance"]["source"] == "engine-emitted"


def test_dataset_row_count_matches_parquet(workspace: Path, equity_df: pd.DataFrame) -> None:
    out = qviz.equity_curve(equity_df, "out/eq")
    spec = json.loads(out.read_text())
    parquet = workspace / "out" / "eq.parquet"
    actual_rows = pq.ParquetFile(parquet).metadata.num_rows
    assert spec["dataset"]["row_count"] == actual_rows == len(equity_df)


def test_atomic_write_no_stray_tmp_files(workspace: Path, equity_df: pd.DataFrame) -> None:
    """M-2 cure: temp files must not linger after a successful write."""
    qviz.equity_curve(equity_df, "out/eq")
    stray = [p for p in (workspace / "out").iterdir() if ".tmp." in p.name]
    assert stray == [], f"stray tmp files: {stray}"


def test_toctou_safe_parent_symlink_rejected(
    workspace: Path, tmp_path_factory: pytest.TempPathFactory, equity_df: pd.DataFrame,
) -> None:
    """M-1 cure: parent dir replaced by a symlink after resolve is rejected
    by the dir_fd + O_NOFOLLOW open.

    Simulates the TOCTOU race deterministically: resolve_output_under_cwd
    has already accepted `out/eq`; an attacker swaps `out/` for a symlink
    pointing elsewhere before write_parquet_atomic opens the parent dir.
    The cured write opens parent with O_NOFOLLOW so the symlink is
    rejected with ELOOP / OSError.
    """
    import os as _os
    from qviz.presets._common import write_parquet_atomic
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    parent_symlink = workspace / "out"
    parent_symlink.symlink_to(elsewhere)
    parquet_path = parent_symlink / "eq.parquet"
    # write_parquet_atomic must refuse to write through the symlink.
    with pytest.raises(OSError):
        write_parquet_atomic(equity_df, parquet_path)
    # And nothing should have landed at the symlink target either.
    assert not (elsewhere / "eq.parquet").exists()
    _os.unlink(parent_symlink)


# ---------------------------------------------------------------------------
# Path types
# ---------------------------------------------------------------------------


def test_output_accepts_path_object(workspace: Path, equity_df: pd.DataFrame) -> None:
    out = qviz.equity_curve(equity_df, Path("out") / "eq")
    assert out.exists()


# ---------------------------------------------------------------------------
# Duplicate columns
# ---------------------------------------------------------------------------


def test_empty_dataframe_rejected(workspace: Path) -> None:
    """N-20 cure: empty DataFrame must be rejected at preset call time."""
    df = pd.DataFrame({"time": pd.array([], dtype="datetime64[ns, UTC]"),
                       "equity": pd.array([], dtype="float64")})
    with pytest.raises(ValueError, match="empty"):
        qviz.equity_curve(df, "out/eq")


def test_empty_title_treated_as_omit(workspace: Path, equity_df: pd.DataFrame) -> None:
    """N-1 cure: title='' is treated as 'omit', not 'set to empty string'."""
    out = qviz.equity_curve(equity_df, "out/eq", title="")
    spec = json.loads(out.read_text())
    assert "title" not in spec


def test_duplicate_columns_preset_error(workspace: Path) -> None:
    """M-22 cure: duplicate DataFrame columns must produce a preset-named error."""
    df = pd.DataFrame(
        [[pd.Timestamp("2026-01-01", tz="UTC"), 100.0, 200.0]],
        columns=["time", "equity", "equity"],
    )
    with pytest.raises(ValueError, match="duplicate"):
        qviz.equity_curve(df, "out/eq")


# ---------------------------------------------------------------------------
# Cross-cutting parity
# ---------------------------------------------------------------------------


def test_all_presets_emit_validator_parity_compliant_specs(
    workspace: Path,
    ohlcv_df: pd.DataFrame, equity_df: pd.DataFrame,
    pnl_df: pd.DataFrame, factor_df: pd.DataFrame,
) -> None:
    paths = [
        qviz.candlestick(ohlcv_df, "out/a"),
        qviz.equity_curve(equity_df, "out/b"),
        qviz.pnl_by_strategy(pnl_df, "out/c"),
        qviz.drawdown(equity_df, "out/d"),
        qviz.factor_exposure(factor_df, "out/e"),
    ]
    for p in paths:
        _load_compile_and_resolve(p, workspace)
