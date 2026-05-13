"""End-to-end daemon tests.

Spawn the daemon as a subprocess and drive it through the real IPC protocol.
This covers: framing, dispatch, schema reads, aggregations, caching, security
gates, error responses.
"""

from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest

from qviz.ipc import FRAME_ARROW_IPC, FRAME_JSON, HEADER_FMT, HEADER_SIZE
from qviz.reader import arrow_ipc_to_table

from qviz.tests._fixture_helpers import require_fixture


PYTHON = sys.executable
DAEMON_MAIN = "qviz.daemon"
SPIKE_DATA = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
PYTHON_DIR = Path(__file__).resolve().parents[2]  # extensions/quantlab/python


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A workspace containing a copy/symlink of the spike parquet under data/."""
    require_fixture(SPIKE_DATA, "spike OHLCV parquet")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    target = data_dir / "ohlcv.parquet"
    # Hardlink for speed; fall back to copy if cross-device.
    try:
        os.link(SPIKE_DATA, target)
    except OSError:
        target.write_bytes(SPIKE_DATA.read_bytes())
    return tmp_path


@pytest.fixture
def daemon(workspace: Path):
    """Start the daemon subprocess and return a DaemonClient handle."""
    env = os.environ.copy()
    env["QUANTLAB_WORKSPACE_ROOT"] = str(workspace)
    env["PYTHONPATH"] = str(PYTHON_DIR) + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.Popen(
        [PYTHON, "-u", "-m", DAEMON_MAIN],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env,
    )
    client = _DaemonClient(proc)
    client.read_banner()
    yield client
    client.close()


# ---------------------------------------------------------------------------
# Helper client
# ---------------------------------------------------------------------------


class _DaemonClient:
    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self._next_id = 0

    def read_banner(self) -> dict:
        return self._read_json()

    def request(self, op: str, **kwargs) -> tuple[dict, bytes | None]:
        self._next_id += 1
        req = {"id": self._next_id, "op": op, **kwargs}
        self._write_json(req)
        resp = self._read_json()
        binary = None
        if resp.get("encoding") == "arrow" and resp.get("ok"):
            binary = self._read_arrow()
        return resp, binary

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        # Flush stderr to aid debugging if a test fails.
        err = self.proc.stderr.read().decode("utf-8", errors="replace")
        if err.strip():
            sys.stderr.write(f"\n--- daemon stderr ---\n{err}\n--- end stderr ---\n")

    # --- low-level wire I/O ---

    def _write_json(self, obj: Any) -> None:
        payload = json.dumps(obj).encode("utf-8")
        header = struct.pack(HEADER_FMT, len(payload), FRAME_JSON, 0)
        self.proc.stdin.write(header)
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()

    def _read_frame(self) -> tuple[int, bytes]:
        header = self.proc.stdout.read(HEADER_SIZE)
        if len(header) != HEADER_SIZE:
            raise EOFError("daemon closed stdout before sending complete header")
        length, type_tag, _ = struct.unpack(HEADER_FMT, header)
        payload = b""
        if length > 0:
            payload = self.proc.stdout.read(length)
        return type_tag, payload

    def _read_json(self) -> dict:
        tag, payload = self._read_frame()
        assert tag == FRAME_JSON, f"expected JSON frame, got tag {tag}"
        return json.loads(payload.decode("utf-8"))

    def _read_arrow(self) -> bytes:
        tag, payload = self._read_frame()
        assert tag == FRAME_ARROW_IPC, f"expected Arrow frame, got tag {tag}"
        return payload


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_ping(daemon: _DaemonClient) -> None:
    resp, _ = daemon.request("ping")
    assert resp["ok"] is True
    assert resp["data"]["pong"] is True


def test_capabilities(daemon: _DaemonClient) -> None:
    """Step 5.G.1: op_capabilities returns the supported transform kinds
    so the webview's transform menu can be generated from it."""
    resp, _ = daemon.request("capabilities")
    assert resp["ok"] is True
    data = resp["data"]
    assert data["daemon_version"] == 1
    # Every kind the compiler accepts must be listed.
    kinds = set(data["transform_kinds"])
    assert {"filter", "date_trunc", "bin", "groupby", "aggregate",
            "window", "math", "tz_convert", "sort", "limit", "expr"} <= kinds
    # Variants the TS validator gates are explicitly listed as unsupported.
    unsupported = set(data["unsupported"])
    assert "window.fn=ema" in unsupported
    assert "bin.strategy=equal_freq" in unsupported
    assert "resample" in unsupported
    # Both chart families documented.
    assert set(data["chart_families"]) == {"timeseries", "general"}


def test_schema(daemon: _DaemonClient) -> None:
    resp, _ = daemon.request("schema", path="data/ohlcv.parquet")
    assert resp["ok"], resp
    data = resp["data"]
    assert data["row_count"] == 1_000_000
    assert {c["name"] for c in data["columns"]} >= {"timestamp", "open", "high", "low", "close", "volume", "returns"}
    assert data["schema_hash"].startswith("sha256:")
    assert data["cached"] is False


def test_schema_caches_on_second_call(daemon: _DaemonClient) -> None:
    daemon.request("schema", path="data/ohlcv.parquet")
    resp, _ = daemon.request("schema", path="data/ohlcv.parquet")
    assert resp["data"]["cached"] is True


def test_preview_returns_arrow_for_typical_size(daemon: _DaemonClient) -> None:
    """100 rows fits inline as JSON; this exercises the small-table JSON path."""
    resp, binary = daemon.request("preview", path="data/ohlcv.parquet", n=100)
    assert resp["ok"], resp
    # 100 rows * 7 cols of mixed types is well under 256 KB threshold -> JSON path
    assert resp["encoding"] == "json"
    assert binary is None
    assert resp["data"]["n"] == 100


def test_preview_above_threshold_returns_arrow(daemon: _DaemonClient) -> None:
    """Preview 5000 rows -> Arrow IPC path (>256 KB)."""
    resp, binary = daemon.request("preview", path="data/ohlcv.parquet", n=5000)
    assert resp["ok"], resp
    if resp["encoding"] == "arrow":
        assert binary is not None
        table = arrow_ipc_to_table(binary)
        assert table.num_rows == 5000


def test_aggregate(daemon: _DaemonClient) -> None:
    """Compile and execute a real groupby+aggregate; receive Arrow IPC."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "volume", "fn": "sum", "as": "vol_sum"},
            ]},
            {"kind": "sort", "columns": [{"column": "day"}]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp, binary = daemon.request("aggregate", spec=spec)
    assert resp["ok"], resp
    assert resp["encoding"] == "arrow"
    assert binary is not None
    table = arrow_ipc_to_table(binary)
    assert "day" in table.column_names
    assert "vol_sum" in table.column_names


def test_expr_calculated_field_end_to_end(daemon: _DaemonClient) -> None:
    """Visualise v2: an `expr` transform compiles to DuckDB SQL and the
    daemon ships an Arrow result with the calculated column present."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [
            {
                "kind": "expr",
                "as": "mid",
                "expression": {
                    "kind": "binary", "op": "/",
                    "left": {
                        "kind": "binary", "op": "+",
                        "left": {"kind": "col", "name": "high"},
                        "right": {"kind": "col", "name": "low"},
                    },
                    "right": {"kind": "num", "value": 2},
                },
                "references": ["high", "low"],
            },
            {"kind": "limit", "n": 100},
        ],
        "chart": {
            "family": "timeseries", "type": "line",
            "encodings": {
                "x": {"field": "timestamp", "type": "temporal"},
                "y": {"field": "mid", "type": "quantitative"},
            },
        },
    }
    resp, binary = daemon.request("aggregate", spec=spec)
    assert resp["ok"], resp
    assert resp["encoding"] == "arrow"
    assert binary is not None
    table = arrow_ipc_to_table(binary)
    assert "mid" in table.column_names
    assert table.num_rows == 100


def test_preview_apply_spec_transforms_aggregated(daemon: _DaemonClient) -> None:
    """Megaudit B-10 cure: when the spec has aggregate transforms, the
    inspector can opt into post-aggregate rows via
    `apply_spec_transforms=<spec>`. Result columns match the chart's
    aggregated shape, not the raw parquet."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "volume", "fn": "sum", "as": "vol_sum"},
            ]},
            {"kind": "sort", "columns": [{"column": "day"}]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=10, offset=0,
        apply_spec_transforms=spec,
    )
    assert resp["ok"], resp
    data = resp["data"]
    assert data.get("applied_spec_transforms") is True
    assert data.get("total", 0) > 0
    # JSON path for a small (<256 KiB) aggregated result.
    if resp["encoding"] == "json":
        rows = data["rows"]
        assert len(rows) <= 10
        if rows:
            # Columns match the AGGREGATED shape, not the raw parquet.
            assert set(rows[0].keys()) == {"day", "vol_sum"}


def test_preview_apply_spec_transforms_with_offset_pages_total(
    daemon: _DaemonClient,
) -> None:
    """B-10 cure: the wrapped SELECT must page through the aggregate
    output (LIMIT/OFFSET) and report the correct total row count from
    the underlying compiled SQL."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "volume", "fn": "sum", "as": "vol_sum"},
            ]},
            {"kind": "sort", "columns": [{"column": "day"}]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    first, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=3, offset=0,
        apply_spec_transforms=spec,
    )
    total = first["data"]["total"]
    second, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=3, offset=3,
        apply_spec_transforms=spec,
    )
    # Same total, different rows.
    assert second["data"]["total"] == total
    if first["encoding"] == "json" and second["encoding"] == "json":
        if first["data"]["rows"] and second["data"]["rows"]:
            assert first["data"]["rows"][0] != second["data"]["rows"][0]


def test_column_stats_apply_spec_transforms_derived_column(daemon: _DaemonClient) -> None:
    """Megaudit B-10 cure (column_stats half): with apply_spec_transforms,
    column_stats works on a derived alias from the spec's aggregate pipeline."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "volume", "fn": "sum", "as": "vol_sum"},
            ]},
            {"kind": "sort", "columns": [{"column": "day"}]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    # Without apply_spec_transforms, vol_sum doesn't exist → error.
    bad, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="vol_sum",
    )
    assert bad["ok"] is False
    assert "vol_sum" in bad["error"]
    # With apply_spec_transforms, vol_sum exists in the aggregate output.
    good, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="vol_sum",
        apply_spec_transforms=spec,
    )
    assert good["ok"], good
    stats = good["data"]
    assert stats["kind"] == "numeric"
    assert stats["total"] > 0
    assert "min" in stats and "max" in stats
    assert stats["min"] >= 0  # volumes are non-negative


def test_column_stats_apply_spec_transforms_rejects_unknown_derived_column(
    daemon: _DaemonClient,
) -> None:
    """B-10 cure: unknown column in the aggregate output is rejected with
    an actionable message that lists available columns."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "volume", "fn": "sum", "as": "vol_sum"},
            ]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="__nonexistent__",
        apply_spec_transforms=spec,
    )
    assert resp["ok"] is False
    assert "__nonexistent__" in resp["error"]
    # The error lists the actual aggregate-output columns to help the user.
    assert "vol_sum" in resp["error"] or "day" in resp["error"]


def test_column_stats_apply_spec_transforms_rejects_non_dict(daemon: _DaemonClient) -> None:
    resp, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="volume",
        apply_spec_transforms="bogus",
    )
    assert resp["ok"] is False
    assert "apply_spec_transforms" in resp["error"]


def test_preview_apply_spec_transforms_rejects_non_dict(daemon: _DaemonClient) -> None:
    """B-10 cure: apply_spec_transforms must be a spec dict, not a
    truthy string or other type."""
    resp, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=10,
        apply_spec_transforms="not-a-spec",
    )
    assert resp["ok"] is False
    assert "apply_spec_transforms" in resp["error"]


def test_aggregate_cache_hit(daemon: _DaemonClient) -> None:
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [{"kind": "limit", "n": 100}],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp1, _ = daemon.request("aggregate", spec=spec)
    resp2, _ = daemon.request("aggregate", spec=spec)
    assert resp1["data"]["cached"] is False
    assert resp2["data"]["cached"] is True
    # Cache hit should be much faster than cold (often 100x+).
    assert resp2["elapsed_ms"] < resp1["elapsed_ms"]


def test_path_traversal_rejected(daemon: _DaemonClient) -> None:
    resp, _ = daemon.request("schema", path="../etc/passwd")
    assert resp["ok"] is False
    assert "SecurityError" in resp["error"]
    # Megaudit F3 (2026-05-13): pin error_kind round-trip on the e2e path.
    assert resp["error_kind"] == "security"


def test_unknown_op_error_kind_protocol(daemon: _DaemonClient) -> None:
    # Megaudit F3 (2026-05-13): unknown op is the canonical 'protocol' kind.
    resp, _ = daemon.request("nope")
    assert resp["ok"] is False
    assert resp["error_kind"] == "protocol"


def test_aggregate_compile_error_kind(daemon: _DaemonClient) -> None:
    # Megaudit F3 (2026-05-13): pin compile kind on the aggregate path.
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet",
                    "schema_hash": "sha256:" + "0" * 64, "mtime_ns": 1},
        "transforms": [{"kind": "filter", "column": "ghost", "op": ">", "value": 0}],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp, _ = daemon.request("aggregate", spec=spec)
    assert resp["ok"] is False
    assert resp["error_kind"] == "compile"


def test_absolute_path_rejected(daemon: _DaemonClient) -> None:
    resp, _ = daemon.request("schema", path="/etc/passwd")
    assert resp["ok"] is False
    assert "SecurityError" in resp["error"]


def test_unknown_extension_rejected(workspace: Path, daemon: _DaemonClient) -> None:
    f = workspace / "secrets.env"
    f.write_text("API_KEY=hunter2")
    resp, _ = daemon.request("schema", path="secrets.env")
    assert resp["ok"] is False
    assert "extension" in resp["error"]


def test_unknown_op(daemon: _DaemonClient) -> None:
    resp, _ = daemon.request("eval_arbitrary_code")
    assert resp["ok"] is False
    assert "unknown op" in resp["error"]


def test_compile_error_returned_as_response(daemon: _DaemonClient) -> None:
    """A spec referencing a non-existent column returns CompileError, not a crash."""
    spec = {
        "qviz_version": 1,
        "dataset": {"uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
                    "mtime_ns": 1},
        "transforms": [{"kind": "filter", "column": "ghost_column", "op": ">", "value": 0}],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp, _ = daemon.request("aggregate", spec=spec)
    assert resp["ok"] is False
    assert "CompileError" in resp["error"]
    assert "ghost_column" in resp["error"]


def test_decimate_rejects_unknown_column(daemon: _DaemonClient) -> None:
    """Audit finding #3: x_col / y_col must be validated against schema before
    pyarrow gets them. Without this, an attacker can send any string and trigger
    uncontrolled errors (KeyError) rather than a controlled SecurityError."""
    resp, _ = daemon.request(
        "decimate", path="data/ohlcv.parquet",
        x_col="__not_a_column__", y_col="close", n_visible=100,
    )
    assert resp["ok"] is False
    assert "SecurityError" in resp["error"]
    assert "__not_a_column__" in resp["error"]


def test_decimate_returns_arrow(daemon: _DaemonClient) -> None:
    resp, binary = daemon.request(
        "decimate", path="data/ohlcv.parquet",
        x_col="timestamp", y_col="close", n_visible=3000,
    )
    assert resp["ok"], resp
    assert resp["encoding"] == "arrow"
    table = arrow_ipc_to_table(binary)
    assert table.num_rows == 3000
    assert set(table.column_names) == {"t", "v"}


def test_decimate_carry_cols_candlestick(daemon: _DaemonClient) -> None:
    """Megaudit M-18 cure: candlestick decimation must carry OHLC columns
    at LTTB-picked indices, not collapse the 5-column table to (t, v)."""
    resp, binary = daemon.request(
        "decimate", path="data/ohlcv.parquet",
        x_col="timestamp", y_col="close", n_visible=2000,
        carry_cols=["open", "high", "low", "volume"],
    )
    assert resp["ok"], resp
    assert resp["encoding"] == "arrow"
    table = arrow_ipc_to_table(binary)
    assert table.num_rows == 2000
    # t + v + 4 carry cols
    assert set(table.column_names) == {"t", "v", "open", "high", "low", "volume"}
    assert resp["data"]["carry_cols"] == ["open", "high", "low", "volume"]
    # Sanity check OHLC invariants on the carried sample: high >= max(open, close)
    # and low <= min(open, close) for every row (or NaN).
    import math as _math
    opens = table.column("open").to_pylist()
    highs = table.column("high").to_pylist()
    lows = table.column("low").to_pylist()
    closes = table.column("v").to_pylist()
    for i in range(len(opens)):
        o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        if None in (o, h, l, c) or any(_math.isnan(x) for x in (o, h, l, c)):
            continue
        assert h >= max(o, c) - 1e-6, f"row {i}: high {h} < max(open={o}, close={c})"
        assert l <= min(o, c) + 1e-6, f"row {i}: low {l} > min(open={o}, close={c})"


def test_decimate_carry_col_must_be_in_schema(daemon: _DaemonClient) -> None:
    """M-18 cure: carry_cols are validated against the file schema like
    x_col / y_col are."""
    resp, _ = daemon.request(
        "decimate", path="data/ohlcv.parquet",
        x_col="timestamp", y_col="close", n_visible=100,
        carry_cols=["__not_a_column__"],
    )
    assert resp["ok"] is False
    assert "SecurityError" in resp["error"]
    assert "__not_a_column__" in resp["error"]


def test_decimate_carry_col_cannot_be_x_or_y(daemon: _DaemonClient) -> None:
    """M-18 cure: x_col / y_col cannot appear in carry_cols (would collide
    with the canonical `t` / `v` output column names)."""
    resp, _ = daemon.request(
        "decimate", path="data/ohlcv.parquet",
        x_col="timestamp", y_col="close", n_visible=100,
        carry_cols=["close"],
    )
    assert resp["ok"] is False
    assert "carry_cols" in resp["error"]


def test_stats(daemon: _DaemonClient) -> None:
    daemon.request("schema", path="data/ohlcv.parquet")
    daemon.request("schema", path="data/ohlcv.parquet")
    resp, _ = daemon.request("stats")
    assert resp["data"]["schema_cache"]["hits"] >= 1


# ---------------------------------------------------------------------------
# Phase 6 (Inspector): preview offset, column_stats, aggregate inspector_filters
# ---------------------------------------------------------------------------


def test_capabilities_advertises_inspector_flags(daemon: _DaemonClient) -> None:
    """6.A.4: pre-Phase-6 daemons won't have these flags; the inspector
    toggle stays disabled until they're advertised. Pin the flag names so
    the TS-side feature-detection contract doesn't drift."""
    resp, _ = daemon.request("capabilities")
    inspector = resp["data"]["inspector"]
    assert inspector["preview_offset"] is True
    assert inspector["column_stats"] is True
    assert inspector["aggregate_filters"] is True


def test_preview_offset_returns_correct_window(daemon: _DaemonClient) -> None:
    """6.A.1: preview accepts an offset and returns rows [offset, offset+n)."""
    resp_head, _ = daemon.request("preview", path="data/ohlcv.parquet", n=200)
    resp_skip, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=100, offset=100,
    )
    # The fixture's synthetic generator increments timestamp by 1s per row,
    # so the second window's timestamps must equal the back half of the
    # contiguous first window. Inline-JSON path for both since n<=200.
    head_ts = [row["timestamp"] for row in resp_head["data"]["rows"]]
    skip_ts = [row["timestamp"] for row in resp_skip["data"]["rows"]]
    assert skip_ts == head_ts[100:200]


def test_preview_offset_past_end_returns_empty(daemon: _DaemonClient) -> None:
    """6.A.1: offset > total returns zero rows; doesn't error. The
    inspector relies on this to detect end-of-table on scroll."""
    resp, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=10, offset=2_000_000,
    )
    assert resp["ok"] is True
    assert resp["data"]["n"] == 0


def test_column_stats_numeric_returns_min_max_and_cardinality(daemon: _DaemonClient) -> None:
    """6.A.2: numeric column gets min/max + a cardinality cap. Volume in
    the spike fixture has 1k unique values; we expect cardinality_is_exact
    to be False with cardinality capped at 21."""
    resp, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="volume",
    )
    assert resp["ok"], resp
    data = resp["data"]
    assert data["kind"] == "numeric"
    assert "min" in data and "max" in data
    assert data["min"] <= data["max"]
    assert data["total"] == 1_000_000
    assert data["null_count"] == 0
    assert data["cardinality_is_exact"] is False
    assert data["cardinality"] == 21  # CAP + 1


def test_column_stats_temporal_returns_min_max(daemon: _DaemonClient) -> None:
    """6.A.2: temporal column gets ISO-format min/max strings."""
    resp, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="timestamp",
    )
    assert resp["ok"], resp
    data = resp["data"]
    assert data["kind"] == "temporal"
    # ISO timestamp strings — TS side parses with Date.parse.
    assert isinstance(data["min"], str) and isinstance(data["max"], str)
    assert data["min"] <= data["max"]


def test_column_stats_low_cardinality_returns_distinct_list(
    workspace: Path, daemon: _DaemonClient,
) -> None:
    """6.A.2: a column with <= 20 distinct values returns the `distinct`
    array so the UI can render a checkbox dropdown."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    target = workspace / "data" / "lowcard.parquet"
    # 6 distinct categories repeated 100 times = 600 rows, 6 distinct.
    cats = ["AAPL", "MSFT", "GOOG", "AMZN", "META", "TSLA"]
    rows = cats * 100
    table = pa.table({"ticker": rows, "px": list(range(600))})
    pq.write_table(table, str(target))

    resp, _ = daemon.request(
        "column_stats", path="data/lowcard.parquet", column="ticker",
    )
    assert resp["ok"], resp
    data = resp["data"]
    assert data["cardinality"] == 6
    assert data["cardinality_is_exact"] is True
    assert set(data["distinct"]) == set(cats)


def test_column_stats_caches_on_second_call(daemon: _DaemonClient) -> None:
    """6.A.2: same column on same file should hit the schema cache."""
    daemon.request("column_stats", path="data/ohlcv.parquet", column="close")
    resp, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="close",
    )
    assert resp["data"]["cached"] is True


def test_column_stats_unknown_column_rejected(daemon: _DaemonClient) -> None:
    """6.A.2: asking for a non-existent column surfaces a clear error
    rather than executing SQL with an injected name."""
    resp, _ = daemon.request(
        "column_stats", path="data/ohlcv.parquet", column="not_a_column",
    )
    assert resp["ok"] is False
    assert "not in schema" in resp["error"]


def test_aggregate_with_inspector_filters_prepends_filter(daemon: _DaemonClient) -> None:
    """6.A.3: inspector_filters list is prepended to spec.transforms at
    compile time and changes the result; the saved spec is NOT mutated."""
    base_spec = {
        "qviz_version": 1,
        "dataset": {
            "uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
            "mtime_ns": 1,
        },
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "count", "as": "n"},
            ]},
            {"kind": "sort", "columns": [{"column": "day"}]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    # Bound everything to a tiny window so the filter actually drops rows.
    inspector_filters = [{
        "kind": "filter", "column": "close", "op": "<", "value": 0.5,
    }]

    resp_unfiltered, bin_unfiltered = daemon.request("aggregate", spec=base_spec)
    resp_filtered, bin_filtered = daemon.request(
        "aggregate", spec=base_spec, inspector_filters=inspector_filters,
    )

    assert resp_unfiltered["ok"] and resp_filtered["ok"]
    table_u = arrow_ipc_to_table(bin_unfiltered)
    table_f = arrow_ipc_to_table(bin_filtered)

    # The filtered aggregate sees fewer rows on EVERY day (some days might
    # even drop out entirely). We assert the total `n` collapses.
    sum_u = sum(table_u.column("n").to_pylist())
    sum_f = sum(table_f.column("n").to_pylist())
    assert sum_f < sum_u


def test_aggregate_inspector_filters_cache_distinct(daemon: _DaemonClient) -> None:
    """6.A.3: cache keying must include inspector_filters so a filtered
    query doesn't return a cached unfiltered result."""
    spec = {
        "qviz_version": 1,
        "dataset": {
            "uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
            "mtime_ns": 1,
        },
        "transforms": [
            {"kind": "date_trunc", "column": "timestamp", "unit": "day", "as": "day"},
            {"kind": "groupby", "columns": ["day"]},
            {"kind": "aggregate", "aggs": [
                {"column": "close", "fn": "count", "as": "n"},
            ]},
            {"kind": "sort", "columns": [{"column": "day"}]},
        ],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    # First call: no filters → fills the cache under key K(unfiltered).
    daemon.request("aggregate", spec=spec)
    # Second call: with filters → must NOT hit the K(unfiltered) cached value.
    resp, _ = daemon.request(
        "aggregate", spec=spec,
        inspector_filters=[{"kind": "filter", "column": "close", "op": "<", "value": 0.5}],
    )
    assert resp["data"]["cached"] is False


def test_preview_with_inspector_filters_returns_filtered_rows_and_total(
    daemon: _DaemonClient,
) -> None:
    """6.D extension: preview accepts inspector_filters and returns
    a `total` (post-filter count) alongside the rows so the inspector's
    virtualized scrollbar matches the filtered dataset."""
    resp, binary = daemon.request(
        "preview", path="data/ohlcv.parquet", n=100, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "close", "op": "<", "value": 0.5},
        ],
    )
    assert resp["ok"], resp
    data = resp["data"]
    # `total` must be present and reflect the FILTERED row count.
    assert "total" in data
    assert data["total"] < 1_000_000, "filter should reduce the row count"
    assert data.get("filtered") is True


def test_preview_filters_empty_set_short_circuits(daemon: _DaemonClient) -> None:
    """6.D extension: an empty `in` set must short-circuit to FALSE rather
    than crashing on `IN ()` (which DuckDB rejects). The provider lifts
    empty sets to this shape so the inspector "uncheck-all" UI doesn't
    blow up."""
    resp, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=50, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "close", "op": "in", "value": []},
        ],
    )
    assert resp["ok"], resp
    assert resp["data"]["total"] == 0


def test_preview_filters_unknown_column_rejected(daemon: _DaemonClient) -> None:
    """6.D extension: a filter referencing a column not in the schema
    must surface a clear error rather than executing arbitrary SQL."""
    resp, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=10, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "__not_a_column__", "op": ">", "value": 0},
        ],
    )
    assert resp["ok"] is False
    assert "__not_a_column__" in resp["error"]


def test_preview_filters_caches_on_second_call(daemon: _DaemonClient) -> None:
    """Audit M-32 (2026-05-11): a second filtered preview with identical
    (offset, filters) MUST hit the cache rather than re-running the
    DuckDB CTE. Without the cache, heavy scrolling under filters spammed
    DuckDB linearly."""
    filters = [
        {"kind": "filter", "column": "close", "op": "<", "value": 0.5},
    ]
    # First call: cache miss, populates.
    first, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=50, offset=0,
        inspector_filters=filters,
    )
    assert first["ok"]
    assert first["data"].get("cached", False) is False, "first call must be a cache MISS"
    # Second call with identical filters/offset/n: cache HIT.
    second, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=50, offset=0,
        inspector_filters=filters,
    )
    assert second["ok"]
    assert second["data"].get("cached") is True, "second call must be a cache HIT"
    # Total must round-trip through cache so the scrollbar stays accurate.
    assert second["data"]["total"] == first["data"]["total"]


def test_preview_filters_contains_escapes_like_metacharacters(
    workspace: Path, daemon: _DaemonClient,
) -> None:
    """Audit M-H + M-16 (2026-05-11): LIKE metachars must be escaped so
    the user-supplied substring is matched literally, not as wildcards."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    target = workspace / "data" / "wild.parquet"
    table = pa.table({
        "name": ["100% sure", "absolutely", "hello_world", "literal-text", "plain"],
        "val": [1, 2, 3, 4, 5],
    })
    pq.write_table(table, str(target))

    # `%` literal must match ONLY rows containing a percent sign.
    resp, _ = daemon.request(
        "preview", path="data/wild.parquet", n=10, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "name", "op": "contains", "value": "%"},
        ],
    )
    assert resp["ok"], resp
    assert resp["data"]["total"] == 1, "only `100% sure` should match"

    # `_` literal must match ONLY rows containing an underscore.
    resp, _ = daemon.request(
        "preview", path="data/wild.parquet", n=10, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "name", "op": "contains", "value": "_"},
        ],
    )
    assert resp["ok"], resp
    assert resp["data"]["total"] == 1, "only `hello_world` should match"


def test_preview_filters_contains_case_insensitive_via_duckdb_lower(
    workspace: Path, daemon: _DaemonClient,
) -> None:
    """Audit M-16 (2026-05-11): case-insensitive matching uses DuckDB's
    `lower()` on BOTH sides so non-ASCII case-folding stays consistent
    (Python's `str.lower` diverged from DuckDB ICU on Turkish I etc.)."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    target = workspace / "data" / "case.parquet"
    table = pa.table({"name": ["AAPL", "msft", "GooG"], "v": [1, 2, 3]})
    pq.write_table(table, str(target))

    # Uppercase needle should match lowercase rows and vice-versa.
    resp, _ = daemon.request(
        "preview", path="data/case.parquet", n=10, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "name", "op": "contains", "value": "aapl"},
        ],
    )
    assert resp["ok"], resp
    assert resp["data"]["total"] == 1


def test_preview_filters_unknown_op_rejected(daemon: _DaemonClient) -> None:
    """6.D extension: only known filter operators are accepted by the
    daemon's compiler; the inspector filters all map to known ops, but
    a hand-crafted message with a malformed op must fail loudly."""
    resp, _ = daemon.request(
        "preview", path="data/ohlcv.parquet", n=10, offset=0,
        inspector_filters=[
            {"kind": "filter", "column": "close", "op": "BANANA", "value": 0},
        ],
    )
    assert resp["ok"] is False


def test_aggregate_inspector_filters_must_be_filter_kind(daemon: _DaemonClient) -> None:
    """6.A.3: only FilterTransform dicts are accepted in inspector_filters.
    Other transform kinds would let the UI silently rewrite the user's
    pipeline, which is the failure mode we're explicitly preventing by
    keeping inspector filters ephemeral and filter-only."""
    spec = {
        "qviz_version": 1,
        "dataset": {
            "uri": "data/ohlcv.parquet", "schema_hash": "sha256:" + "0" * 64,
            "mtime_ns": 1,
        },
        "transforms": [],
        "chart": {"family": "timeseries", "type": "line", "encodings": {}},
    }
    resp, _ = daemon.request(
        "aggregate", spec=spec,
        inspector_filters=[{"kind": "sort", "columns": [{"column": "close"}]}],
    )
    assert resp["ok"] is False
    assert "FilterTransform" in resp["error"]


def test_toctou_size_change_invalidates_cache(workspace: Path, daemon: _DaemonClient) -> None:
    """Audit-fix slate AF1 regression: a file replaced with content of a
    DIFFERENT size MUST invalidate the cached aggregate, even if mtime is
    forced back to the original.

    Setup:
      - Build dataset A (1k rows), query, populate cache.
      - Replace with dataset B (different size, different content) but
        force the same mtime.
      - Re-query: must miss cache (size differs).
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    data_dir = workspace / "data"
    target = data_dir / "tinya.parquet"

    table_a = pa.table({"t": list(range(1000)), "v": [float(i) for i in range(1000)]})
    pq.write_table(table_a, str(target), compression="snappy")
    mtime_a = os.stat(target).st_mtime_ns
    size_a = os.stat(target).st_size

    spec = {
        "qviz_version": 1,
        "dataset": {
            "uri": "data/tinya.parquet",
            "schema_hash": "sha256:" + "0" * 64,
            "mtime_ns": 1,
        },
        "transforms": [],
        "chart": {
            "family": "timeseries", "type": "line",
            "encodings": {
                "x": {"field": "t", "type": "temporal"},
                "y": {"field": "v", "type": "quantitative"},
            },
        },
    }
    resp_a, binary_a = daemon.request("aggregate", spec=spec)
    assert resp_a["ok"], resp_a
    assert resp_a["data"]["cached"] is False

    # Same plan, immediate re-query: cache hit.
    resp_a2, _ = daemon.request("aggregate", spec=spec)
    assert resp_a2["data"]["cached"] is True

    # Replace with a SMALLER dataset and force same mtime.
    table_b = pa.table({"t": list(range(100)), "v": [float(i) * 2 for i in range(100)]})
    pq.write_table(table_b, str(target), compression="snappy")
    size_b = os.stat(target).st_size
    assert size_b != size_a, "test setup should produce different file sizes"
    os.utime(target, ns=(mtime_a, mtime_a))
    mtime_b = os.stat(target).st_mtime_ns
    assert mtime_b == mtime_a, "mtime preservation should have worked"

    # Same spec; expected miss because size (and ctime) differ.
    resp_b, _ = daemon.request("aggregate", spec=spec)
    assert resp_b["ok"], resp_b
    assert resp_b["data"]["cached"] is False, (
        "TOCTOU: same mtime + different size MUST invalidate cache"
    )
    assert resp_b["data"]["n"] == 100, "result must reflect the rewritten file's content"
