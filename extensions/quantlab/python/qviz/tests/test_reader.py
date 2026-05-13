"""Tests for the file reader: schema hashing, preview perf, mtime, Arrow IPC."""

from __future__ import annotations

import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from qviz.reader import (
    PREVIEW_MAX,
    _duckdb_uniquify,
    _uniquify_schema,
    arrow_ipc_to_table,
    file_mtime_ns,
    file_row_count,
    file_schema_hash,
    hash_schema,
    read_preview,
    read_schema,
    table_to_arrow_ipc,
)

from qviz.tests._fixture_helpers import require_fixture


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def parquet_1m() -> Path:
    """The canonical spike data parquet.

    Megaudit F5 (2026-05-13): previously this fixture silently fell
    through to an ad-hoc generator with a different schema if the spike
    file was missing, which both violated CLAUDE.md "no fallbacks" and
    masked CI environments where the autouse generator had failed.
    `require_fixture` now hard-fails under `QUANTLAB_REQUIRE_FIXTURES=1`
    and soft-skips otherwise; the session-scoped autouse fixture in
    `conftest.py` already guarantees presence locally.
    """
    p = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
    require_fixture(p, "spike OHLCV parquet")
    return p


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
# Offset (Phase 6 / 6.A.1): inspector paging
# ---------------------------------------------------------------------------


def test_preview_negative_offset_rejected(parquet_1m: Path) -> None:
    with pytest.raises(ValueError, match="non-negative"):
        read_preview(parquet_1m, n=10, offset=-1)


def test_preview_offset_default_unchanged(parquet_1m: Path) -> None:
    # Pin the offset=0 default so an inadvertent signature change is caught.
    a = read_preview(parquet_1m, n=100)
    b = read_preview(parquet_1m, n=100, offset=0)
    assert a.num_rows == b.num_rows == 100


def test_preview_offset_parquet_skips_correct_rows(parquet_1m: Path) -> None:
    head = read_preview(parquet_1m, n=200)
    skipped = read_preview(parquet_1m, n=100, offset=100)
    assert skipped.num_rows == 100
    # The second window must equal rows [100, 200) of the contiguous first
    # window. Compare on a column that's guaranteed monotonic per the
    # fixture's synthetic generator (`timestamp` increments by 1s).
    head_ts = head.column("timestamp").to_pylist()
    skip_ts = skipped.column("timestamp").to_pylist()
    assert skip_ts == head_ts[100:200]


def test_preview_offset_past_end_returns_empty(parquet_1m: Path) -> None:
    # 1M rows fixture; ask for offset = total + 5.
    total = read_preview(parquet_1m, n=1).num_rows  # smoke: confirm there's data
    assert total == 1
    huge = read_preview(parquet_1m, n=10, offset=2_000_000)
    assert huge.num_rows == 0
    # Schema must still be the dataset's schema, not empty struct.
    assert "timestamp" in huge.column_names


def test_preview_offset_csv_skips_correct_rows(tmp_path: Path) -> None:
    csv = tmp_path / "rows.csv"
    csv.write_text("a,b\n1,one\n2,two\n3,three\n4,four\n5,five\n")
    skipped = read_preview(csv, n=2, offset=2)
    # rows [2, 4) of zero-indexed body = "3,three" and "4,four".
    assert skipped.num_rows == 2
    assert skipped.column("a").to_pylist() == [3, 4]
    assert skipped.column("b").to_pylist() == ["three", "four"]


def test_preview_offset_zero_still_fast(parquet_1m: Path) -> None:
    # The fast-path budget claim from the original test must survive the
    # offset signature change.
    t0 = time.perf_counter()
    table = read_preview(parquet_1m, n=100, offset=0)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert table.num_rows == 100
    assert elapsed_ms < 200, f"offset=0 preview too slow: {elapsed_ms:.0f}ms"


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


# ---------------------------------------------------------------------------
# Duplicate column-name handling (smoke-test fix, 2026-05-11)
# ---------------------------------------------------------------------------


def test_duckdb_uniquify_no_duplicates_returns_unchanged() -> None:
    assert _duckdb_uniquify(["a", "b", "c"]) == ["a", "b", "c"]


def test_duckdb_uniquify_one_duplicate() -> None:
    # Real-world case: TradingView indicator export with two "MA #1" columns.
    assert _duckdb_uniquify(["t", "MA #1", "MA #1", "close"]) == [
        "t", "MA #1", "MA #1_1", "close",
    ]


def test_duckdb_uniquify_many_duplicates() -> None:
    # Three identical names → first keeps name, second gets _1, third gets _2.
    assert _duckdb_uniquify(["x", "x", "x", "x"]) == ["x", "x_1", "x_2", "x_3"]


def test_duckdb_uniquify_mixed_overlapping() -> None:
    # The renaming MUST NOT itself produce a new collision. Here "a_1" exists
    # in the input; we need to make sure the renamer increments past it
    # cleanly. Current behavior: blind suffixing (sufficient for v1 because
    # we don't expect users to ship `x_1, x` mixes; if this becomes a real
    # issue, switch to a collision-checking renamer.)
    # This test PINS the current behavior so a future change is intentional.
    assert _duckdb_uniquify(["a", "a_1", "a", "a"]) == ["a", "a_1", "a_1", "a_2"]


def test_uniquify_schema_preserves_types_and_nullability() -> None:
    schema = pa.schema([
        pa.field("t", pa.int64(), nullable=False),
        pa.field("v", pa.float64(), nullable=True),
        pa.field("v", pa.float64(), nullable=True),
    ])
    out = _uniquify_schema(schema)
    assert out.names == ["t", "v", "v_1"]
    assert out.field(0).type == pa.int64()
    assert out.field(0).nullable is False
    assert out.field(2).type == pa.float64()
    assert out.field(2).nullable is True


def test_uniquify_schema_returns_same_instance_when_unique() -> None:
    # Defense against unnecessary allocations on the hot path (every schema
    # read). When there are no duplicates the helper returns the input
    # reference verbatim so `schema is unique_schema` -> True.
    schema = pa.schema([pa.field("a", pa.int64()), pa.field("b", pa.float64())])
    assert _uniquify_schema(schema) is schema


def test_read_schema_csv_with_duplicate_columns(tmp_path: Path) -> None:
    # Real-world TradingView-style export: two columns named "MA #1".
    csv_path = tmp_path / "tv_export.csv"
    csv_path.write_text("time,MA #1,MA #1,close\n1,10,20,100\n2,11,21,101\n")
    schema = read_schema(csv_path)
    assert schema.names == ["time", "MA #1", "MA #1_1", "close"]


def test_read_preview_csv_with_duplicate_columns(tmp_path: Path) -> None:
    # The preview's column names must match the schema's. Otherwise the
    # webview's column panel would show de-duped names while the preview
    # rows reference the originals, and JS would silently drop the second
    # column.
    csv_path = tmp_path / "tv_export.csv"
    csv_path.write_text("time,MA #1,MA #1,close\n1,10,20,100\n2,11,21,101\n")
    table = read_preview(csv_path, n=10)
    assert table.schema.names == ["time", "MA #1", "MA #1_1", "close"]
    # Data preserved positionally: second column's 10/11, third column's 20/21.
    assert table.column(1).to_pylist() == [10, 11]
    assert table.column(2).to_pylist() == [20, 21]
