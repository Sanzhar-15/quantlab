"""Session-scoped fixtures shared across all qviz test modules.

The Phase 0 spike produced a 1M-row OHLCV+returns parquet at
``/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet``. Several test
modules reference this path directly and skip when missing. /tmp is
periodically pruned (Mac launchd, CI ephemeral runners), so a stale skip
is the default rather than the exception.

This conftest regenerates the file on session startup if it is absent,
making the spike data effectively part of the suite. Generation is
deterministic (fixed RNG seed) and takes <1 s; subsequent sessions reuse
the existing file.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from qviz.tests._spike_data import generate_spike_data


SPIKE_DIR = Path("/tmp/quantlab-spike-data")
SPIKE_DATA = SPIKE_DIR / "synthetic_ohlcv_1m.parquet"

# Strict-mode fixture-presence helper lives in `_fixture_helpers.py`
# (sibling module — pytest will not let test files `import conftest`,
# so test modules import directly from `_fixture_helpers`). The
# constant is hard-coded here too rather than imported so conftest stays
# importable in environments where `qviz.tests` isn't yet on sys.path.
QUANTLAB_REQUIRE_FIXTURES = "QUANTLAB_REQUIRE_FIXTURES"


@pytest.fixture(scope="session", autouse=True)
def ensure_spike_data() -> Path:
    """Ensure the 1M-row spike parquet exists before any test runs.

    Other modules' fixtures still reference SPIKE_DATA directly via
    ``Path("/tmp/quantlab-spike-data/...")``; this autouse fixture just
    guarantees the file is there. autouse=True means it runs even for
    tests that don't request it explicitly.

    Megaudit F5 (2026-05-13): under ``QUANTLAB_REQUIRE_FIXTURES=1`` we
    must NOT silently regenerate. Strict mode means "this fixture must
    already exist as provisioned by CI/ops"; auto-regenerating would
    repair the very condition strict mode exists to surface. In strict
    mode we leave the file alone and let `require_fixture` hard-fail
    at the per-test fixture layer.
    """
    needs_regen = (
        not SPIKE_DATA.exists() or os.path.getsize(SPIKE_DATA) < 1024
    )
    if needs_regen and os.environ.get(QUANTLAB_REQUIRE_FIXTURES) != "1":
        generate_spike_data(SPIKE_DATA)
    return SPIKE_DATA
