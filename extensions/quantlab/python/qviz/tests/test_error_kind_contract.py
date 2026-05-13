"""Pin the daemon's error_kind classification ladder (megaudit F3).

The daemon's handle() catch ladder maps Python exception types to wire
`error_kind` values. A rename like ``compile -> compiler`` would silently
downgrade every compile error to the TS-side default ``'compile'``
(post-F3 it would fire as DaemonProtocolError instead — also tested on
the TS side). Without these tests the contract is invisible.

Tests run handle() in-process to avoid the subprocess flake surface;
realistic exception sources (e.g. monkeypatched op handlers) drive each
branch deterministically.
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from qviz.compiler import CompileError
from qviz.daemon import Daemon
from qviz.security import MemoryLimitError, SecurityError, TimeoutError_


def _tiny_parquet(tmp_path: Path) -> Path:
    """Self-contained 3-row parquet so this test file doesn't depend on
    /tmp/quantlab-spike-data (which has its own strict-mode policy)."""
    out = tmp_path / "data" / "tiny.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    table = pa.table({
        "ts": pa.array([1, 2, 3], type=pa.int64()),
        "x": pa.array([10.0, 20.0, 30.0], type=pa.float64()),
    })
    pq.write_table(table, str(out))
    return out


def _spec(uri: str, transforms: list[dict] | None = None) -> dict:
    return {
        "chart": {
            "family": "general", "type": "scatter",
            "encodings": {
                "x": {"field": "ts", "type": "quantitative"},
                "y": {"field": "x", "type": "quantitative"},
            },
        },
        "dataset": {"uri": uri, "schema_version": 1},
        "transforms": transforms or [],
    }


# ---------------------------------------------------------------------
# F3 Python-side: one test per kind, plus the inspect-source sentinel.
# ---------------------------------------------------------------------


def test_kind_security_path_escape(tmp_path: Path) -> None:
    d = Daemon(tmp_path)
    resp, _ = d.handle(
        {"op": "schema", "id": 1, "path": "../etc/passwd"}
    )
    assert resp["ok"] is False
    assert resp["error_kind"] == "security", resp


def test_kind_compile_unknown_column(tmp_path: Path) -> None:
    _tiny_parquet(tmp_path)
    d = Daemon(tmp_path)
    spec = _spec(
        "data/tiny.parquet",
        transforms=[{"kind": "filter", "column": "ghost", "op": ">", "value": 0}],
    )
    resp, _ = d.handle({"op": "aggregate", "id": 2, "spec": spec})
    assert resp["ok"] is False
    assert resp["error_kind"] == "compile", resp


def test_kind_timeout_from_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The catch ladder must tag TimeoutError_ as `timeout`. We don't
    care here whether the watchdog actually fired (security.py's tests
    own that); only that the classification is correct when it does."""
    d = Daemon(tmp_path)

    def boom(_self: Daemon, _req: dict) -> dict:
        raise TimeoutError_("synthetic")

    monkeypatch.setattr(Daemon, "op_ping", boom, raising=False)
    resp, _ = d.handle({"op": "ping", "id": 3})
    assert resp["error_kind"] == "timeout", resp


def test_kind_memory_from_handler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d = Daemon(tmp_path)

    def boom(_self: Daemon, _req: dict) -> dict:
        raise MemoryLimitError("synthetic 1024 MB")

    monkeypatch.setattr(Daemon, "op_ping", boom, raising=False)
    resp, _ = d.handle({"op": "ping", "id": 4})
    assert resp["error_kind"] == "memory", resp


def test_kind_memory_from_builtin_memory_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Megaudit-2 A4-C1: built-in MemoryError must also classify as
    `memory`, not fall through to `internal`. Pin the second branch."""
    d = Daemon(tmp_path)

    def boom(_self: Daemon, _req: dict) -> dict:
        raise MemoryError("alloc fail")

    monkeypatch.setattr(Daemon, "op_ping", boom, raising=False)
    resp, _ = d.handle({"op": "ping", "id": 5})
    assert resp["error_kind"] == "memory", resp


def test_kind_internal_runtime_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    d = Daemon(tmp_path)

    def boom(_self: Daemon, _req: dict) -> dict:
        raise RuntimeError("synthetic bug")

    monkeypatch.setattr(Daemon, "op_ping", boom, raising=False)
    resp, _ = d.handle({"op": "ping", "id": 6})
    assert resp["error_kind"] == "internal", resp
    assert "InternalError" in resp["error"]


def test_kind_protocol_non_dict_frame(tmp_path: Path) -> None:
    """A frame that decodes to a non-object (list, string, number)
    must surface as `protocol`. Pinned previously by test_theme_c.py;
    duplicated here for the contract sentinel."""
    d = Daemon(tmp_path)
    resp, _ = d.handle([1, 2, 3])  # type: ignore[arg-type]
    assert resp["error_kind"] == "protocol", resp


def test_kind_protocol_unknown_op(tmp_path: Path) -> None:
    d = Daemon(tmp_path)
    resp, _ = d.handle({"op": "nope", "id": 7})
    assert resp["error_kind"] == "protocol", resp


def test_kind_protocol_non_string_op(tmp_path: Path) -> None:
    d = Daemon(tmp_path)
    resp, _ = d.handle({"op": 42, "id": 8})
    assert resp["error_kind"] == "protocol", resp


# ---------------------------------------------------------------------
# Sentinel: every advertised kind appears in the source of `handle()`.
# A `compile -> compiler` rename would fail this test instantly. Cheap
# to maintain (`handle()` is a single short method) and very high
# signal.
# ---------------------------------------------------------------------


def test_kind_set_matches_catch_ladder_source() -> None:
    """Closure megaudit (2026-05-13): widened from `Daemon.handle` to
    the whole `Daemon` class. The run() loop's IPC-oversized-frame
    branch at `daemon.py:1037` also emits `"error_kind": "internal"`;
    a sentinel scoped to handle() alone would miss a rename there.
    The TS-side cross-side guard greps the WHOLE daemon.py via regex,
    so both sides now cover the full Daemon surface."""
    src = inspect.getsource(Daemon)
    for kind in (
        "security", "compile", "timeout", "memory", "internal", "protocol",
    ):
        needle = f'"error_kind": "{kind}"'
        assert needle in src, (
            f"qviz.daemon.Daemon no longer emits {kind!r} — a rename / "
            f"removal would silently break the TS-side classifier. "
            f"Source must contain {needle!r}."
        )
