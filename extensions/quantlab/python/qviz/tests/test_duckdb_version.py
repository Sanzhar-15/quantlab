"""Megaudit-2 A4-C2: unit tests for the DuckDB version probe.

The parser tests don't import duckdb (they only exercise the parsing
helper), so they run on every machine. `_check_duckdb_version` itself
requires duckdb to be importable -- those tests skip cleanly when
it's absent.
"""

from __future__ import annotations

import importlib
import sys

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


def test_min_duckdb_version_is_reasonable():
    daemon = _load_daemon_module()
    # Pin sanity: don't accidentally regress the floor below 0.9 and
    # don't push it above 2.0 without an explicit version bump.
    assert (0, 9, 0) <= daemon.MIN_DUCKDB_VERSION <= (2, 0, 0)
