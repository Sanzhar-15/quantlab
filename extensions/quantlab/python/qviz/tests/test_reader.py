"""Tests for the file reader: schema hashing, preview perf, mtime, Arrow IPC."""

from __future__ import annotations

import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from qviz.reader import (
    PREVIEW_MAX,
    arrow_ipc_to_table,
    file_mtime_ns,
    file_row_count,
    file_schema_hash,
    hash_schema,
    read_preview,
    read_schema,
    table_to_arrow_ipc,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def parquet_1m(tmp_path: Path) -> Path:
    """Reuse the spike data if available, else generate fresh."""
    spike_path = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
    if spike_path.exists():
        return spike_path
    # Fallback: generate fresh
    import numpy as np
    n = 1_000_000
    rng = np.random.default_rng(42)
    table = pa.table({
        "timestamp": pa.array(
            [pa.scalar(i * 1_000_000_000, type=pa.timestamp("ns")) for i in range(n)],
            type=pa.timestamp("ns"),
        ),
        "close": rng.standard_normal(n).astype("float32"),
        "volume": rng.integers(0, 1000, n, dtype="int64"),
    })
    out = tmp_path / "test.parquet"
    pq.write_table(table, str(out))
    return out


@pytest.fixture
def csv_small(tmp_path: Path) -> Path:
    csv = tmp_path / "data.csv"
    csv.write_text("a,b,c\n1,2,3\n4,5,6\n7,8,9\n")
    return csv


# ---------------------------------------------------------------------------
# hash_schema
# ---------------------------------------------------------------------------


def test_schema_hash_is_stable() -> None:
    s = pa.schema([
        ("name", pa.string()),
        ("age", pa.int32()),
    ])
    h1 = hash_schema(s)
    h2 = hash_schema(s)
    assert h1 == h2
    assert h1.startswith("sha256:")
    assert len(h1) == 64 + len("sha256:")


def test_schema_hash_changes_on_column_added() -> None:
    s1 = pa.schema([("a", pa.int32())])
    s2 = pa.schema([("a", pa.int32()), ("b", pa.int32())])
    assert hash_schema(s1) != hash_schema(s2)


def test_schema_hash_changes_on_column_renamed() -> None:
    s1 = pa.schema([("a", pa.int32())])
    s2 = pa.schema([("z", pa.int32())])
    assert hash_schema(s1) != hash_schema(s2)


def test_schema_hash_changes_on_dtype_change() -> None:
    s1 = pa.schema([("a", pa.int32())])
    s2 = pa.schema([("a", pa.int64())])
    assert hash_schema(s1) != hash_schema(s2)


def test_schema_hash_changes_on_reorder() -> None:
    s1 = pa.schema([("a", pa.int32()), ("b", pa.int32())])
    s2 = pa.schema([("b", pa.int32()), ("a", pa.int32())])
    assert hash_schema(s1) != hash_schema(s2)


def test_schema_hash_independent_of_nullability() -> None:
    s1 = pa.schema([pa.field("a", pa.int32(), nullable=True)])
    s2 = pa.schema([pa.field("a", pa.int32(), nullable=False)])
    # Nullability deliberately ignored to avoid spurious cache invalidation.
    assert hash_schema(s1) == hash_schema(s2)


# ---------------------------------------------------------------------------
# read_schema + file_schema_hash + file_row_count
# ---------------------------------------------------------------------------


def test_parquet_schema_read(parquet_1m: Path) -> None:
    s = read_schema(parquet_1m)
    assert "timestamp" in s.names
    h = file_schema_hash(parquet_1m)
    assert h.startswith("sha256:")


def test_csv_schema_read(csv_small: Path) -> None:
    s = read_schema(csv_small)
    assert s.names == ["a", "b", "c"]


def test_unsupported_extension(tmp_path: Path) -> None:
    f = tmp_path / "x.xml"
    f.write_text("<root/>")
    with pytest.raises(ValueError, match="unsupported"):
        read_schema(f)


def test_xlsx_raises_not_implemented(tmp_path: Path) -> None:
    f = tmp_path / "x.xlsx"
    f.write_bytes(b"PK\x03\x04")  # zip header; doesn't matter, fails at xlsx logic
    with pytest.raises(NotImplementedError):
        read_schema(f)


def test_parquet_row_count(parquet_1m: Path) -> None:
    n = file_row_count(parquet_1m)
    assert n >= 1_000_000


# ---------------------------------------------------------------------------
# read_preview perf — the spike fix
# ---------------------------------------------------------------------------


def test_preview_returns_correct_size(parquet_1m: Path) -> None:
    table = read_preview(parquet_1m, n=100)
    assert table.num_rows == 100


def test_preview_large_n_capped(parquet_1m: Path) -> None:
    with pytest.raises(ValueError, match="exceeds PREVIEW_MAX"):
        read_preview(parquet_1m, n=PREVIEW_MAX + 1)


def test_preview_zero_or_negative_rejected(parquet_1m: Path) -> None:
    with pytest.raises(ValueError, match="positive"):
        read_preview(parquet_1m, n=0)
    with pytest.raises(ValueError, match="positive"):
        read_preview(parquet_1m, n=-5)


def test_preview_is_fast_on_1m_rows(parquet_1m: Path) -> None:
    """The whole point of iter_batches: stop after first batch.

    Spike measured ~1.3s with read_table().slice(); production target is <100ms.
    Allowing 200ms for headroom (CI runners, cold caches).
    """
    t0 = time.perf_counter()
    table = read_preview(parquet_1m, n=100)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert table.num_rows == 100
    assert elapsed_ms < 200, f"preview too slow: {elapsed_ms:.0f}ms (target <200ms)"


def test_preview_csv(csv_small: Path) -> None:
    t = read_preview(csv_small, n=10)
    assert t.num_rows == 3
    assert t.column_names == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# mtime + Arrow IPC round-trip
# ---------------------------------------------------------------------------


def test_mtime_ns(parquet_1m: Path) -> None:
    m = file_mtime_ns(parquet_1m)
    assert isinstance(m, int)
    assert m > 0


def test_arrow_ipc_round_trip() -> None:
    table = pa.table({"x": [1, 2, 3], "y": ["a", "b", "c"]})
    buf = table_to_arrow_ipc(table)
    assert isinstance(buf, bytes)
    assert len(buf) > 0
    restored = arrow_ipc_to_table(buf)
    assert restored.equals(table)


def test_arrow_ipc_preserves_dtypes() -> None:
    table = pa.table({
        "ts": pa.array([1_700_000_000_000_000_000], type=pa.timestamp("ns", tz="UTC")),
        "f": pa.array([1.5], type=pa.float32()),
        "i": pa.array([42], type=pa.int64()),
    })
    restored = arrow_ipc_to_table(table_to_arrow_ipc(table))
    assert restored.schema == table.schema
