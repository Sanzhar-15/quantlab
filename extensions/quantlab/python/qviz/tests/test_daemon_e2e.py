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


PYTHON = sys.executable
DAEMON_MAIN = "qviz.daemon"
SPIKE_DATA = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
PYTHON_DIR = Path(__file__).resolve().parents[2]  # extensions/quantlab/python


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A workspace containing a copy/symlink of the spike parquet under data/."""
    if not SPIKE_DATA.exists():
        pytest.skip("spike data not present")
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


def test_stats(daemon: _DaemonClient) -> None:
    daemon.request("schema", path="data/ohlcv.parquet")
    daemon.request("schema", path="data/ohlcv.parquet")
    resp, _ = daemon.request("stats")
    assert resp["data"]["schema_cache"]["hits"] >= 1
