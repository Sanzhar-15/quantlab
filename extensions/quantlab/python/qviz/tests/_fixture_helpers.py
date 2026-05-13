"""Helpers shared by conftest.py and individual test modules.

conftest.py is discovered automatically by pytest but is NOT importable
as a regular module (pytest does not add the tests directory to
sys.path). Anything tests need to `from X import ...` must live in a
plain sibling module — this one — and conftest can re-export.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


QUANTLAB_REQUIRE_FIXTURES = "QUANTLAB_REQUIRE_FIXTURES"

# 1024 bytes is the same threshold the autouse generator in conftest.py
# uses to decide whether to regenerate the spike parquet, so the two
# stay in lockstep: anything the generator would replace is also
# anything `require_fixture` should refuse.
MIN_FIXTURE_BYTES = 1024


def require_fixture(path: Path, label: str) -> None:
    """Skip locally / fail in strict mode when a fixture is missing or
    is a zero-byte / truncated stub.

    Strict mode is enabled by setting QUANTLAB_REQUIRE_FIXTURES=1 (CI
    must do so) — silent skips would otherwise turn a green-board run
    into one where the entire suite was dark.
    """
    # Single stat() avoids the exists()/stat() TOCTOU race: if the file
    # is unlinked between the two calls we'd raise FileNotFoundError
    # mid-helper and surface as a test error rather than a clean
    # skip/fail. (Audit F5 codex pass, 2026-05-13.)
    try:
        size = path.stat().st_size
    except OSError:
        size = -1  # missing or unreadable → treated as missing
    if size >= MIN_FIXTURE_BYTES:
        return
    if os.environ.get(QUANTLAB_REQUIRE_FIXTURES) == "1":
        pytest.fail(
            f"required fixture missing: {label} at {path} "
            f"(QUANTLAB_REQUIRE_FIXTURES=1 enforces hard failure)"
        )
    pytest.skip(
        f"{label} not present at {path} "
        f"(set QUANTLAB_REQUIRE_FIXTURES=1 to enforce)"
    )
