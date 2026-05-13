"""Theme C megaudit tests — daemon stack/resource/framing.

C2: enforce_spec_caps refuses oversized specs before compile
C4: op_decimate caps n_visible + carry_cols
C5: handle() returns protocol error on non-dict frame
C7: schema cache TOCTOU detection
C8: filtered preview uses positional binding for path
"""

from __future__ import annotations

import pytest

from qviz.security import (
    SPEC_CAPS,
    SecurityError,
    enforce_spec_caps,
)


# ---------------------------------------------------------------------------
# C2: enforce_spec_caps
# ---------------------------------------------------------------------------


def test_c2_enforce_spec_caps_accepts_small_spec() -> None:
    spec = {
        "transforms": [
            {"kind": "filter", "column": "x", "op": ">", "value": 0},
            {"kind": "limit", "n": 100},
        ],
    }
    enforce_spec_caps(spec)  # no raise


def test_c2_too_many_transforms_rejected() -> None:
    spec = {"transforms": [{"kind": "filter", "column": "x", "op": ">", "value": 0}]
            * (SPEC_CAPS["max_transforms"] + 1)}
    with pytest.raises(SecurityError, match="transforms length"):
        enforce_spec_caps(spec)


def test_c2_too_long_in_list_rejected() -> None:
    spec = {"transforms": [
        {"kind": "filter", "column": "x", "op": "in",
         "value": list(range(SPEC_CAPS["max_filter_in_values"] + 1))},
    ]}
    with pytest.raises(SecurityError, match="IN-list length"):
        enforce_spec_caps(spec)


def test_c2_too_many_aggregates_rejected() -> None:
    spec = {"transforms": [{
        "kind": "aggregate",
        "aggs": [{"column": "x", "fn": "count", "as": f"c{i}"}
                 for i in range(SPEC_CAPS["max_aggregates_per_transform"] + 1)],
    }]}
    with pytest.raises(SecurityError, match="aggs length"):
        enforce_spec_caps(spec)


def test_c2_too_many_sort_columns_rejected() -> None:
    spec = {"transforms": [{
        "kind": "sort",
        "columns": [{"column": f"c{i}"} for i in range(SPEC_CAPS["max_sort_columns"] + 1)],
    }]}
    with pytest.raises(SecurityError, match="columns length"):
        enforce_spec_caps(spec)


def test_c2_too_many_groupby_columns_rejected() -> None:
    spec = {"transforms": [
        {"kind": "groupby", "columns": [f"c{i}"
                                        for i in range(SPEC_CAPS["max_groupby_columns"] + 1)]},
    ]}
    with pytest.raises(SecurityError, match="columns length"):
        enforce_spec_caps(spec)


# ---------------------------------------------------------------------------
# C5: handle() defends against non-dict frames
# ---------------------------------------------------------------------------


def test_c5_handle_list_frame_returns_protocol_error(tmp_path) -> None:
    from qviz.daemon import Daemon
    daemon = Daemon(tmp_path)
    resp, payload = daemon.handle(["ping"])
    assert resp["ok"] is False
    assert resp["error_kind"] == "protocol"
    assert "JSON object" in resp["error"]
    assert payload is None


def test_c5_handle_string_frame_returns_protocol_error(tmp_path) -> None:
    from qviz.daemon import Daemon
    daemon = Daemon(tmp_path)
    resp, _ = daemon.handle("ping")
    assert resp["ok"] is False
    assert resp["error_kind"] == "protocol"


def test_c5_handle_number_frame_returns_protocol_error(tmp_path) -> None:
    from qviz.daemon import Daemon
    daemon = Daemon(tmp_path)
    resp, _ = daemon.handle(42)  # type: ignore[arg-type]
    assert resp["ok"] is False
    assert resp["error_kind"] == "protocol"


def test_c5_handle_unknown_op_carries_protocol_error_kind(tmp_path) -> None:
    """C5 second-order: 'unknown op' is now classified as protocol, not generic compile."""
    from qviz.daemon import Daemon
    daemon = Daemon(tmp_path)
    resp, _ = daemon.handle({"op": "bogus_op", "id": "x"})
    assert resp["ok"] is False
    assert resp["error_kind"] == "protocol"


# ---------------------------------------------------------------------------
# C6: path validation hard caps
# ---------------------------------------------------------------------------


def test_c6_oversize_path_rejected(tmp_path) -> None:
    from qviz.security import resolve_workspace_path
    long_path = "a" * 5000  # exceeds MAX_PATH_BYTES = 4096
    with pytest.raises(SecurityError, match="byte length"):
        resolve_workspace_path(tmp_path, long_path)


def test_c6_oversize_segment_rejected(tmp_path) -> None:
    from qviz.security import resolve_workspace_path
    long_segment = "x" * 300  # exceeds MAX_SEGMENT_BYTES = 255
    requested = f"sub/{long_segment}/file.parquet"
    with pytest.raises(SecurityError, match="segment .* byte length"):
        resolve_workspace_path(tmp_path, requested)


# ---------------------------------------------------------------------------
# C3: query_budget conn.interrupt wiring (behavior, not call-time)
# ---------------------------------------------------------------------------


def test_c3_query_budget_accepts_conn_kwarg() -> None:
    """Smoke: the new signature accepts conn=... without exploding on a
    no-op block. Behavioral correctness (conn.interrupt() called on
    timeout) is hard to test deterministically in a unit; we pin the
    smoke + signature here."""
    from qviz.security import query_budget

    class _FakeConn:
        def __init__(self) -> None:
            self.interrupted = False

        def interrupt(self) -> None:
            self.interrupted = True

    conn = _FakeConn()
    with query_budget(timeout_s=1.0, peak_rss_mb=128, conn=conn) as _state:
        pass
    # No timeout fired, so interrupt should NOT have been called.
    assert conn.interrupted is False
