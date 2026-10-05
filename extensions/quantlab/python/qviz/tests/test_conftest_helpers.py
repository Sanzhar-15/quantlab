"""Self-tests for `_fixture_helpers` (megaudit F5).

Fixtures are required: missing, unreadable, zero-byte and undersized
fixtures FAIL, and an unset or wrong QUANTLAB_TEST_SPIKE_DATA fails by
name. Without these tests the helper itself could regress into a skip.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from qviz.tests._fixture_helpers import SPIKE_DATA_VAR, require_fixture, spike_data_path


def test_present_fixture_is_noop(tmp_path: Path) -> None:
    p = tmp_path / "data.bin"
    p.write_bytes(b"x" * 2048)
    require_fixture(p, "data")  # neither raises nor skips


def test_missing_fixture_fails(tmp_path: Path) -> None:
    with pytest.raises(pytest.fail.Exception, match="required fixture missing"):
        require_fixture(tmp_path / "missing.parquet", "missing fixture")


def test_zero_byte_file_fails(tmp_path: Path) -> None:
    p = tmp_path / "stub.parquet"
    p.write_bytes(b"")
    with pytest.raises(pytest.fail.Exception, match="required fixture missing"):
        require_fixture(p, "stub")


def test_threshold_boundary_exact(tmp_path: Path) -> None:
    """Pin the 1024-byte threshold against accidental constant drift.
    1023 bytes is below threshold (fail); 1024 bytes is the inclusive
    floor (noop)."""
    just_under = tmp_path / "1023.bin"
    just_under.write_bytes(b"x" * 1023)
    with pytest.raises(pytest.fail.Exception, match="required fixture missing"):
        require_fixture(just_under, "just-under")

    at_threshold = tmp_path / "1024.bin"
    at_threshold.write_bytes(b"x" * 1024)
    require_fixture(at_threshold, "at-threshold")  # must not raise


def test_unreadable_path_fails_by_name(tmp_path: Path) -> None:
    """A path whose stat() raises OSError must produce a failure naming
    the fixture, never a propagated FileNotFoundError. Pins the TOCTOU
    handling in `require_fixture`."""
    with pytest.raises(pytest.fail.Exception, match="deep-miss"):
        require_fixture(tmp_path / "does" / "not" / "exist.parquet", "deep-miss")


def test_spike_data_unset_fails_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SPIKE_DATA_VAR, raising=False)
    with pytest.raises(pytest.fail.Exception, match=f"{SPIKE_DATA_VAR} is not set"):
        spike_data_path()


def test_spike_data_missing_file_fails_by_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(SPIKE_DATA_VAR, str(tmp_path / "absent.parquet"))
    with pytest.raises(pytest.fail.Exception, match=SPIKE_DATA_VAR):
        spike_data_path()


def test_spike_data_present_returns_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    p = tmp_path / "spike.parquet"
    p.write_bytes(b"x" * 2048)
    monkeypatch.setenv(SPIKE_DATA_VAR, str(p))
    assert spike_data_path() == p
