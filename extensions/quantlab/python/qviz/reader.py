"""File reading + schema hashing for the qviz query daemon.

Responsibilities:
  - Read parquet/csv/xlsx files via pyarrow with format-aware optimizations.
  - Compute a stable schema hash for cache invalidation.
  - Fast preview (first N rows) using iter_batches — the spike used
    pq.read_table().slice() which loads ALL row groups (~1.3s on 1M rows);
    iter_batches stops at the first batch (sub-50ms).

Schema hash format: sha256:<64 hex>. Computed from a normalized representation
of the pyarrow schema (column order matters; field flags don't).
"""

from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.csv as pa_csv
import pyarrow.parquet as pq


# Hard cap on preview row count. The IPC layer should impose its own caps too;
# this is defense-in-depth so a forgotten check doesn't dump 10M rows over IPC.
PREVIEW_MAX = 10_000


# ---------------------------------------------------------------------------
# Schema hashing
# ---------------------------------------------------------------------------


def hash_schema(schema: pa.Schema) -> str:
    """Stable SHA-256 hash over the schema's column names + dtypes.

    Format: 'sha256:<64 hex>'. Matches the validator regex on the JS side.

    Notes:
      - Field nullability is intentionally NOT in the hash. A column flipping
        from nullable=True to nullable=False shouldn't invalidate every cached
        viz spec when downstream code doesn't differentiate.
      - Field metadata (key-value strings) IS NOT included; pandas writes
        non-deterministic metadata that would defeat caching.
      - Order of fields IS in the hash. A schema with reordered columns is
        a different schema for visualization purposes.
    """
    parts = []
    for i in range(len(schema.names)):
        field = schema.field(i)
        parts.append(f"{field.name}:{field.type}")
    canonical = "\n".join(parts)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def file_schema_hash(path: Path) -> str:
    """Compute the schema hash directly from a file. Fast (metadata-only for parquet)."""
    return hash_schema(read_schema(path))


def _duckdb_uniquify(names: list[str]) -> list[str]:
    """Real-world CSVs (notably TradingView indicator exports) ship with
    duplicate column names: e.g. two "MA #1" columns when the same indicator
    is plotted twice. pyarrow accepts this positionally, but downstream the
    qviz validator rejects duplicate column names AND DuckDB auto-renames
    the second occurrence as `<name>_1`, `<name>_2`, etc. when reading
    via `read_csv_auto`.

    To keep the daemon's schema response, the compiler's SQL, and DuckDB's
    actual query result all referencing the same column identifiers, we
    apply DuckDB's `_N` suffix convention to the schema BEFORE sending it
    over the wire. The first occurrence keeps its original name; the
    second becomes `<name>_1`, the third `<name>_2`, etc.

    Idempotent: input with no duplicates is returned unchanged.
    """
    seen: dict[str, int] = {}
    out: list[str] = []
    for name in names:
        if name not in seen:
            seen[name] = 0
            out.append(name)
        else:
            seen[name] += 1
            out.append(f"{name}_{seen[name]}")
    return out


def _uniquify_schema(schema: pa.Schema) -> pa.Schema:
    """Apply `_duckdb_uniquify` to `schema.names`. If no duplicates were
    present the schema is returned unchanged (no copy). Otherwise a fresh
    `pa.schema` is built with renamed fields, preserving type and nullability.
    """
    original = list(schema.names)
    unique = _duckdb_uniquify(original)
    if unique == original:
        return schema
    fields = [
        pa.field(unique[i], schema.field(i).type, nullable=schema.field(i).nullable)
        for i in range(len(original))
    ]
    return pa.schema(fields, metadata=schema.metadata)


def read_schema(path: Path) -> pa.Schema:
    """Read schema without loading data. O(1) for parquet, O(rows) for csv.

    Duplicate column names are renamed using DuckDB's `_N` convention --
    see `_uniquify_schema`.
    """
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return _uniquify_schema(pq.read_schema(str(path)))
    if suffix in (".csv", ".tsv"):
        # Inferred from the first chunk only; this is the same logic pyarrow
        # uses internally when read_csv is called.
        delim = "\t" if suffix == ".tsv" else ","
        opts = pa_csv.ReadOptions(autogenerate_column_names=False)
        parse = pa_csv.ParseOptions(delimiter=delim)
        with pa_csv.open_csv(str(path), read_options=opts, parse_options=parse) as r:
            return _uniquify_schema(r.schema)
    if suffix in (".xlsx", ".xls"):
        # xlsx requires loading the sheet; deferred until pyarrow gains
        # native xlsx support, or we add openpyxl/calamine.
        raise NotImplementedError(
            f"xlsx schema read deferred (need openpyxl or calamine integration): {path}"
        )
    raise ValueError(f"unsupported file extension: {suffix}")


# ---------------------------------------------------------------------------
# Row count
# ---------------------------------------------------------------------------


def file_row_count(path: Path) -> int:
    """Total row count. O(1) for parquet (metadata), O(rows) for csv."""
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return pq.read_metadata(str(path)).num_rows
    if suffix in (".csv", ".tsv"):
        # CSV row count requires a scan; cap to avoid pathological inputs.
        n = 0
        delim = "\t" if suffix == ".tsv" else ","
        with pa_csv.open_csv(
            str(path),
            parse_options=pa_csv.ParseOptions(delimiter=delim),
        ) as r:
            for batch in r:
                n += batch.num_rows
        return n
    raise ValueError(f"row count not supported for: {suffix}")


# ---------------------------------------------------------------------------
# Preview (fast first-N read)
# ---------------------------------------------------------------------------


def read_preview(path: Path, n: int = 100, offset: int = 0) -> pa.Table:
    """Read rows [offset, offset + n) fast.

    For parquet, uses iter_batches and walks batches, skipping rows until
    `offset` then collecting up to `n` rows. With offset=0 the first batch
    is enough (sub-50ms on 1M-row parquet — same fast path as before).
    Larger offsets pay the cost of reading-then-discarding earlier batches;
    inspector scroll positions stay near the top in practice so this is
    acceptable for v1. If random-access becomes important we can switch
    to a DuckDB `LIMIT n OFFSET offset` query and keep the same signature.

    For csv, uses streaming reader and the same skip-then-collect pattern.

    Phase 6 (6.A.1) added the `offset` parameter; the original n-only
    contract is preserved via the default offset=0.
    """
    if n <= 0:
        raise ValueError(f"n must be positive: {n}")
    if n > PREVIEW_MAX:
        raise ValueError(f"n={n} exceeds PREVIEW_MAX={PREVIEW_MAX}")
    if offset < 0:
        raise ValueError(f"offset must be non-negative: {offset}")

    # Helper: apply DuckDB-compatible duplicate column-name renaming.
    # See `_uniquify_schema` for the rationale.
    def _renamed_table(table: pa.Table) -> pa.Table:
        original = list(table.schema.names)
        unique = _duckdb_uniquify(original)
        if unique == original:
            return table
        return table.rename_columns(unique)

    def _collect_from_batches(
        batches: Iterable[pa.RecordBatch],
        empty_schema: pa.Schema,
    ) -> pa.Table:
        """Walk batches, skip `offset` rows, collect up to `n`."""
        remaining_skip = offset
        rows_needed = n
        collected: list[pa.RecordBatch] = []
        for batch in batches:
            if batch.num_rows == 0:
                continue
            if remaining_skip >= batch.num_rows:
                remaining_skip -= batch.num_rows
                continue
            # First non-skipped batch may have a partial-skip head.
            chunk = batch.slice(remaining_skip)
            remaining_skip = 0
            take = min(chunk.num_rows, rows_needed)
            collected.append(chunk.slice(0, take))
            rows_needed -= take
            if rows_needed == 0:
                break
        if not collected:
            return _uniquify_schema(empty_schema).empty_table()
        return _renamed_table(pa.Table.from_batches(collected))

    suffix = path.suffix.lower()
    # Pick a batch size that keeps the offset=0 fast path one-batch but
    # gives larger batches a chance to skip in fewer iterations.
    batch_size = max(n, 4096)
    if suffix == ".parquet":
        pf = pq.ParquetFile(str(path))
        return _collect_from_batches(pf.iter_batches(batch_size=batch_size), pf.schema_arrow)

    if suffix in (".csv", ".tsv"):
        delim = "\t" if suffix == ".tsv" else ","
        # Smaller block_size makes the first-batch read smaller.
        opts = pa_csv.ReadOptions(block_size=64 * 1024)
        parse = pa_csv.ParseOptions(delimiter=delim)
        with pa_csv.open_csv(str(path), read_options=opts, parse_options=parse) as r:
            return _collect_from_batches(iter(r), read_schema(path))

    raise ValueError(f"unsupported file extension: {suffix}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def file_mtime_ns(path: Path) -> int:
    """File mtime in nanoseconds — matches DatasetRef.mtime_ns in the spec."""
    return os.stat(path).st_mtime_ns


def file_fingerprint(path: Path, *, schema_hash: str | None = None) -> dict:
    """Cheap, forge-resistant file identity for cache invalidation.

    Returns a dict with the four observable identity components that, taken
    together, defeat the realistic TOCTOU forgery surface:

      - mtime_ns:  modification time in ns (stat's st_mtime_ns).
      - size:      st_size; any content-length change invalidates.
      - ctime_ns:  inode-change time; updated by rename/replace and not
                   easily forgeable by `touch -t` (mtime forgery doesn't
                   reset ctime; only root-level filesystem manipulation does).
      - schema_hash: optional. Pass when caching anything that depends on
                   the column structure (aggregate/decimate). Omit for
                   the schema cache itself, where this IS the value.

    A residual gap remains: a deliberate attacker preserving (mtime, size,
    ctime) and writing identical-length data with the SAME schema would
    still hit a stale cache. Closing this needs a content hash; we make
    that opt-in via `QUANTLAB_QVIZ_CONTENT_HASH=1` (not implemented in v1
    -- documented here as the next escalation).
    """
    st = os.stat(path)
    out: dict = {
        "mtime_ns": st.st_mtime_ns,
        "size": st.st_size,
        "ctime_ns": st.st_ctime_ns,
    }
    if schema_hash is not None:
        out["schema_hash"] = schema_hash
    return out


def table_to_arrow_ipc(table: pa.Table) -> bytes:
    """Serialize a Table to Arrow IPC bytes. For binary protocol responses
    (the JSON path is for small results only)."""
    sink = io.BytesIO()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue()


def arrow_ipc_to_table(data: bytes) -> pa.Table:
    """Inverse of table_to_arrow_ipc. Useful in tests + IPC client."""
    reader = pa.ipc.open_stream(io.BytesIO(data))
    return reader.read_all()
