"""Self-tests for `conftest.require_fixture` (megaudit F5).

Pin both branches: under default mode, missing fixtures soft-skip; under
QUANTLAB_REQUIRE_FIXTURES=1, missing or zero-byte fixtures hard-fail.
Without these tests the helper itself could regress and we'd lose the
strict-mode safety net.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from qviz.tests._fixture_helpers import QUANTLAB_REQUIRE_FIXTURES, require_fixture


def test_present_fixture_is_noop(tmp_path: Path) -> None:
    p = tmp_path / "data.bin"
    p.write_bytes(b"x" * 2048)
    require_fixture(p, "data")  # neither raises nor skips


def test_missing_fixture_skips_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv(QUANTLAB_REQUIRE_FIXTURES, raising=False)
    with pytest.raises(pytest.skip.Exception):
        require_fixture(tmp_path / "missing.parquet", "missing fixture")


def test_missing_fixture_fails_in_strict_mode(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(QUANTLAB_REQUIRE_FIXTURES, "1")
    with pytest.raises(pytest.fail.Exception, match="required fixture missing"):
        require_fixture(tmp_path / "missing.parquet", "missing fixture")


def test_strict_mode_off_when_var_not_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(QUANTLAB_REQUIRE_FIXTURES, "0")
    with pytest.raises(pytest.skip.Exception):
        require_fixture(tmp_path / "missing.parquet", "missing fixture")


def test_zero_byte_file_treated_as_missing_in_strict_mode(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    p = tmp_path / "stub.parquet"
    p.write_bytes(b"")
    monkeypatch.setenv(QUANTLAB_REQUIRE_FIXTURES, "1")
    with pytest.raises(pytest.fail.Exception, match="required fixture missing"):
        require_fixture(p, "stub")


def test_undersized_file_treated_as_missing_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The 1024-byte threshold mirrors the autouse generator's regen
    # heuristic; a sub-1KB parquet is almost certainly a truncated/empty
    # stub, not a real fixture.
    p = tmp_path / "tiny.parquet"
    p.write_bytes(b"x" * 512)
    monkeypatch.delenv(QUANTLAB_REQUIRE_FIXTURES, raising=False)
    with pytest.raises(pytest.skip.Exception):
        require_fixture(p, "tiny")


def test_threshold_boundary_exact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Pin the 1024-byte threshold against accidental constant drift.
    1023 bytes is below threshold (skip); 1024 bytes is the inclusive
    floor (noop)."""
    monkeypatch.delenv(QUANTLAB_REQUIRE_FIXTURES, raising=False)

    just_under = tmp_path / "1023.bin"
    just_under.write_bytes(b"x" * 1023)
    with pytest.raises(pytest.skip.Exception):
        require_fixture(just_under, "just-under")

    at_threshold = tmp_path / "1024.bin"
    at_threshold.write_bytes(b"x" * 1024)
    require_fixture(at_threshold, "at-threshold")  # must not raise


def test_undersized_file_fails_in_strict_mode(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A truncated fixture is just as fatal as a missing one under strict
    mode — silently skipping the suite because a parquet write was cut
    short is exactly the silence F5 prevents."""
    p = tmp_path / "tiny.parquet"
    p.write_bytes(b"x" * 512)
    monkeypatch.setenv(QUANTLAB_REQUIRE_FIXTURES, "1")
    with pytest.raises(pytest.fail.Exception, match="required fixture missing"):
        require_fixture(p, "tiny")


def test_unreadable_path_does_not_crash_helper(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A path whose stat() raises OSError (e.g. unlinked between
    invocation steps, or an unreadable directory) must produce a clean
    skip/fail, never a propagated FileNotFoundError. Pins the TOCTOU
    handling in `require_fixture`."""
    monkeypatch.delenv(QUANTLAB_REQUIRE_FIXTURES, raising=False)
    with pytest.raises(pytest.skip.Exception):
        require_fixture(tmp_path / "does" / "not" / "exist.parquet", "deep-miss")
