"""Writes the deterministic spike OHLCV parquet that the qviz tests read.

The pytest suite and the extension's mocha daemon tests both take the file through the
required QUANTLAB_TEST_SPIKE_DATA, written once by:

    python python/qviz/tests/_spike_data.py <out path>

The out path is a required argument; an existing file is refused by name, never overwritten.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


SPIKE_ROWS = 1_000_000


def generate_spike_data(out: Path, n: int = SPIKE_ROWS) -> None:
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


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        raise SystemExit("usage: _spike_data.py <out path>: the path of the spike parquet to write")
    out = Path(argv[1])
    if out.exists():
        raise SystemExit(f"_spike_data.py: {out} exists; refusing to overwrite it")
    generate_spike_data(out)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
