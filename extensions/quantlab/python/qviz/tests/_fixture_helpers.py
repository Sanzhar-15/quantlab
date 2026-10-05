"""Helpers shared by the qviz test modules.

conftest.py is discovered automatically by pytest but is NOT importable
as a regular module (pytest does not add the tests directory to
sys.path). Anything tests need to `from X import ...` must live in a
plain sibling module — this one.

Fixtures are required inputs: a missing or truncated one FAILS the test
by name. There is no skip mode: a skipped fixture test is a check NOT RUN
that reads as green.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


SPIKE_DATA_VAR = "QUANTLAB_TEST_SPIKE_DATA"

# A sub-1 KB file is a truncated or empty stub, never a real fixture.
MIN_FIXTURE_BYTES = 1024


def require_fixture(path: Path, label: str) -> None:
    """Fail the test when a fixture is missing, unreadable, or a
    zero-byte / truncated stub."""
    # Single stat() avoids the exists()/stat() TOCTOU race: if the file
    # is unlinked between the two calls we'd raise FileNotFoundError
    # mid-helper rather than a failure naming the fixture. (Audit F5
    # codex pass, 2026-05-13.)
    try:
        size = path.stat().st_size
    except OSError as e:
        pytest.fail(f"required fixture missing: {label} at {path} ({e})")
    if size < MIN_FIXTURE_BYTES:
        pytest.fail(
            f"required fixture missing: {label} at {path} is {size} bytes "
            f"(< {MIN_FIXTURE_BYTES}: a truncated or empty stub)"
        )


def spike_data_path() -> Path:
    """The spike OHLCV parquet, from the required QUANTLAB_TEST_SPIKE_DATA.

    Write it once with `python python/qviz/tests/_spike_data.py <path>`.
    """
    value = os.environ.get(SPIKE_DATA_VAR)
    if not value:
        pytest.fail(
            f"{SPIKE_DATA_VAR} is not set: the qviz tests need the path of the "
            f"spike OHLCV parquet (python/qviz/tests/_spike_data.py writes it)"
        )
    path = Path(value)
    require_fixture(path, f"spike OHLCV parquet ({SPIKE_DATA_VAR})")
    return path
