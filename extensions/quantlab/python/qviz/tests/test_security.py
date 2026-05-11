"""Tests for path validation + query budget."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from qviz.security import (
    ALLOWED_EXTENSIONS,
    MemoryLimitError,
    SecurityError,
    TimeoutError_,
    query_budget,
    resolve_workspace_path,
)


# ---------- resolve_workspace_path ----------


def test_resolves_relative_path_inside_workspace(tmp_path: Path) -> None:
    f = tmp_path / "data.parquet"
    f.write_bytes(b"")
    resolved = resolve_workspace_path(tmp_path, "data.parquet")
    assert resolved == f.resolve()


def test_resolves_nested_path(tmp_path: Path) -> None:
    sub = tmp_path / "subdir"
    sub.mkdir()
    f = sub / "data.parquet"
    f.write_bytes(b"")
    resolved = resolve_workspace_path(tmp_path, "subdir/data.parquet")
    assert resolved == f.resolve()


def test_rejects_empty_path(tmp_path: Path) -> None:
    with pytest.raises(SecurityError, match="empty"):
        resolve_workspace_path(tmp_path, "")


def test_rejects_absolute_path(tmp_path: Path) -> None:
    f = tmp_path / "data.parquet"
    f.write_bytes(b"")
    with pytest.raises(SecurityError, match="absolute"):
        resolve_workspace_path(tmp_path, str(f))


def test_rejects_dotdot_traversal(tmp_path: Path) -> None:
    with pytest.raises(SecurityError, match=r"\.\."):
        resolve_workspace_path(tmp_path, "../etc/passwd")


def test_rejects_dotdot_in_middle(tmp_path: Path) -> None:
    with pytest.raises(SecurityError, match=r"\.\."):
        resolve_workspace_path(tmp_path, "subdir/../../etc/passwd")


def test_rejects_symlink_pointing_outside(tmp_path: Path) -> None:
    outside = tmp_path.parent / "_outside.parquet"
    outside.write_bytes(b"")
    try:
        link = tmp_path / "link.parquet"
        link.symlink_to(outside)
        with pytest.raises(SecurityError, match="outside workspace"):
            resolve_workspace_path(tmp_path, "link.parquet")
    finally:
        outside.unlink(missing_ok=True)


def test_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(SecurityError, match="does not exist"):
        resolve_workspace_path(tmp_path, "ghost.parquet")


def test_rejects_directory(tmp_path: Path) -> None:
    sub = tmp_path / "subdir"
    sub.mkdir()
    with pytest.raises(SecurityError, match="not a regular file"):
        resolve_workspace_path(tmp_path, "subdir")


def test_rejects_disallowed_extension(tmp_path: Path) -> None:
    f = tmp_path / "secrets.env"
    f.write_text("API_KEY=hunter2")
    with pytest.raises(SecurityError, match="extension"):
        resolve_workspace_path(tmp_path, "secrets.env")


def test_allowlist_matches_reader_dispatch() -> None:
    """Megaudit CRITICAL-3: extension allowlist MUST match the reader's
    actual dispatch (parquet/csv/tsv). xlsx/xls were previously
    accepted by the security gate and rejected by the reader, causing
    confusing errors AND a threat-model gap (the gate said "OK" for
    files the reader couldn't actually read)."""
    assert ".parquet" in ALLOWED_EXTENSIONS
    assert ".csv" in ALLOWED_EXTENSIONS
    assert ".tsv" in ALLOWED_EXTENSIONS
    # Excluded: xlsx/xls (reader raises NotImplementedError for them).
    assert ".xlsx" not in ALLOWED_EXTENSIONS
    assert ".xls" not in ALLOWED_EXTENSIONS
    assert ".env" not in ALLOWED_EXTENSIONS
    assert ".py" not in ALLOWED_EXTENSIONS


# ---------- query_budget ----------


def test_budget_allows_fast_query() -> None:
    with query_budget(timeout_s=2.0, peak_rss_mb=4096):
        pass  # finished instantly


def test_budget_rejects_zero_timeout() -> None:
    with pytest.raises(SecurityError, match="timeout_s out of range"):
        with query_budget(timeout_s=0):
            pass


def test_budget_rejects_excessive_timeout() -> None:
    with pytest.raises(SecurityError, match="timeout_s out of range"):
        with query_budget(timeout_s=601):
            pass


def test_budget_aborts_long_query() -> None:
    started = time.perf_counter()
    with pytest.raises(TimeoutError_, match="exceeded"):
        with query_budget(timeout_s=0.1):
            time.sleep(2.0)
    # ensure we returned promptly, not after the full sleep
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, f"watchdog did not interrupt promptly (took {elapsed:.2f}s)"


def test_budget_caps_memory(monkeypatch) -> None:
    # ru_maxrss is monotonic across the process; a real allocation test is
    # flaky when other tests in the suite have already pushed maxrss high.
    # Drive the comparison deterministically by injecting before/after values.
    from qviz import security
    values = iter([100.0, 250.0])  # before, after — delta 150 MB
    monkeypatch.setattr(security, "_peak_rss_mb", lambda: next(values))
    with pytest.raises(MemoryLimitError, match="peak"):
        with query_budget(timeout_s=10.0, peak_rss_mb=1):
            pass


def test_budget_state_dict_visible() -> None:
    with query_budget(timeout_s=1.0) as state:
        assert isinstance(state, dict)
        assert state["cancelled"] is False
        state["custom"] = "value"
        # caller can mutate state mid-query (used for cancellation in production)
