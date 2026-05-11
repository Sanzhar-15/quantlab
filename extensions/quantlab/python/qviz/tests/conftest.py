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

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest


SPIKE_DIR = Path("/tmp/quantlab-spike-data")
SPIKE_DATA = SPIKE_DIR / "synthetic_ohlcv_1m.parquet"
SPIKE_ROWS = 1_000_000


def _generate_spike_data(out: Path, n: int = SPIKE_ROWS) -> None:
    """Write a deterministic OHLCV+returns parquet to `out`.

    Schema: timestamp (ns), open/high/low/close (float32), volume (int64),
    returns (float32). Layout chosen to satisfy every consumer in
    qviz/tests/.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)

    start_ns = 1_735_689_600_000_000_000  # 2026-01-01T00:00:00Z
    ts_ns = np.arange(n, dtype=np.int64) * 1_000_000_000 + start_ns

    log_steps = rng.standard_normal(n) * 0.0005
    log_price = np.cumsum(log_steps) + np.log(50000.0)
    close = np.exp(log_price).astype(np.float32)

    open_ = np.empty(n, dtype=np.float32)
    open_[0] = close[0]
    open_[1:] = close[:-1]
    jitter_h = (np.abs(rng.standard_normal(n) * 0.0008) * close).astype(np.float32)
    jitter_l = (np.abs(rng.standard_normal(n) * 0.0008) * close).astype(np.float32)
    high = np.maximum(open_, close) + jitter_h
    low = np.minimum(open_, close) - jitter_l

    volume = rng.integers(0, 10_000, n, dtype=np.int64)

    returns = np.empty(n, dtype=np.float32)
    returns[0] = 0.0
    returns[1:] = (close[1:] / close[:-1] - 1.0).astype(np.float32)

    table = pa.table({
        "timestamp": pa.array(ts_ns, type=pa.timestamp("ns")),
        "open": pa.array(open_),
        "high": pa.array(high),
        "low": pa.array(low),
        "close": pa.array(close),
        "volume": pa.array(volume),
        "returns": pa.array(returns),
    })
    pq.write_table(table, str(out), compression="snappy")


@pytest.fixture(scope="session", autouse=True)
def ensure_spike_data() -> Path:
    """Ensure the 1M-row spike parquet exists before any test runs.

    Other modules' fixtures still reference SPIKE_DATA directly via
    ``Path("/tmp/quantlab-spike-data/...")``; this autouse fixture just
    guarantees the file is there. autouse=True means it runs even for
    tests that don't request it explicitly.
    """
    if not SPIKE_DATA.exists() or os.path.getsize(SPIKE_DATA) < 1024:
        _generate_spike_data(SPIKE_DATA)
    return SPIKE_DATA
