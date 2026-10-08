"""Megaudit-2 A4-C2: unit tests for the DuckDB version probe.

The parser tests don't import duckdb (they only exercise the parsing
helper), so they run on every machine. `_check_duckdb_version` itself
requires duckdb to be importable -- those tests skip cleanly when
it's absent.
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
from pathlib import Path

import pytest


def _load_daemon_module():
    """Import daemon, faking out duckdb if missing. We only call the
    pure parse function, so a stub `duckdb` with the right __version__
    is enough to satisfy the top-level `import duckdb`."""
    try:
        import duckdb  # noqa: F401  -- exists, normal import below
    except ImportError:
        # Insert a stub so `from qviz.daemon import _parse_duckdb_version`
        # succeeds even without a real duckdb wheel installed.
        import types
        stub = types.ModuleType("duckdb")
        stub.__version__ = "999.0.0"
        sys.modules["duckdb"] = stub
        # pyarrow is also imported at module top-level; ensure it exists
        # or stub it too.
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            sys.modules["pyarrow"] = types.ModuleType("pyarrow")
    return importlib.import_module("qviz.daemon")


def test_parse_duckdb_version_simple():
    daemon = _load_daemon_module()
    assert daemon._parse_duckdb_version("0.9.0") == (0, 9, 0)
    assert daemon._parse_duckdb_version("1.1.0") == (1, 1, 0)
    assert daemon._parse_duckdb_version("0.9.2") == (0, 9, 2)


def test_parse_duckdb_version_two_components_padded():
    daemon = _load_daemon_module()
    # Some pre-1.0 wheels reported just "0.9" -- pad to (0, 9, 0).
    assert daemon._parse_duckdb_version("0.9") == (0, 9, 0)


def test_parse_duckdb_version_dev_suffix_stripped():
    daemon = _load_daemon_module()
    # Dev / nightly builds carry suffixes like "-dev123" or "+sha".
    assert daemon._parse_duckdb_version("0.9.2-dev123") == (0, 9, 2)
    assert daemon._parse_duckdb_version("1.1.0+abc.def") == (1, 1, 0)


def test_parse_duckdb_version_ignores_fourth_component():
    daemon = _load_daemon_module()
    # PEP 440 patch+sub releases: 0.9.2.1 -> (0, 9, 2) is fine since
    # the minimum check only inspects major.minor.patch.
    assert daemon._parse_duckdb_version("0.9.2.1") == (0, 9, 2)


def test_parse_duckdb_version_rejects_malformed():
    daemon = _load_daemon_module()
    with pytest.raises(ValueError):
        daemon._parse_duckdb_version("not-a-version")
    with pytest.raises(ValueError):
        daemon._parse_duckdb_version("garbage.value")
    with pytest.raises(ValueError):
        daemon._parse_duckdb_version("")
    with pytest.raises(ValueError):
        # Only one component -- ambiguous, refuse.
        daemon._parse_duckdb_version("1")


def test_min_duckdb_version_is_the_first_usable_release():
    daemon = _load_daemon_module()
    # F-FEAT-QVIZ-REQ-1: every result is fetched with `to_arrow_table`
    # (first in 1.5.0), and 1.5.0 aborts at the daemon's start.
    assert daemon.MIN_DUCKDB_VERSION == (1, 5, 1)


def test_requirements_floor_matches_the_startup_check():
    daemon = _load_daemon_module()
    req = (Path(__file__).resolve().parent.parent / "requirements.txt").read_text(encoding="utf-8")
    lines = [line.strip() for line in req.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    floor = ".".join(str(x) for x in daemon.MIN_DUCKDB_VERSION)
    assert f"duckdb>={floor}" in lines
    # The daemon imports these at start (qviz.presets, qviz.decimate).
    assert "pandas" in lines and "numpy" in lines


def _check_with_version(version: str, stub_dir: Path) -> subprocess.CompletedProcess:
    """Run `_check_duckdb_version` in a fresh interpreter whose `duckdb` is a
    stub reporting `version`, so no real wheel of that release is needed."""
    (stub_dir / "duckdb.py").write_text(f"__version__ = {version!r}\n", encoding="utf-8")
    package_root = Path(__file__).resolve().parent.parent.parent
    code = "from qviz.daemon import _check_duckdb_version; _check_duckdb_version(); print('accepted')"
    return subprocess.run(
        [sys.executable, "-c", code],
        env={**os.environ, "PYTHONPATH": os.pathsep.join([str(stub_dir), str(package_root)])},
        capture_output=True, text=True, timeout=60,
    )


def test_check_refuses_the_release_below_the_floor_by_name(tmp_path):
    result = _check_with_version("1.5.0", tmp_path)
    assert result.returncode == 3, result
    assert "duckdb 1.5.0 is too old; minimum required is 1.5.1" in result.stderr


def test_check_accepts_the_floor(tmp_path):
    result = _check_with_version("1.5.1", tmp_path)
    assert result.returncode == 0, result
    assert result.stdout.strip() == "accepted"
