"""Shared helpers for the qviz preset API.

Presets in this package emit a `.qviz.json` next to a freshly-written
parquet file. The helpers here cover the bits every preset does identically:

  - resolve_output_under_cwd: validate the caller's `output` stem and
    derive (absolute stem path, workspace-relative uri stem). CWD is
    treated as the workspace root (Phase 7 v1 contract). Strict — rejects
    extensions in the stem, embedded dots in the basename, absolute paths,
    `..` segments, NUL bytes, and any string failing the validator's
    isAcceptableString rules.
  - write_parquet: pandas DataFrame -> Arrow Table -> parquet file with
    atomic tempfile + os.replace semantics.
  - compute_dataset_block: read the parquet's schema VIA THE DAEMON's
    reader.read_schema (so the schema_hash byte-matches what the daemon
    later computes on open).
  - build_provenance: canonical Provenance sub-dict with the all-zeros
    query_hash sentinel for preset-emitted specs.
  - check_acceptable_string / require_columns_typed: per-field validation
    matching the TypeScript validator's string rules and the daemon's
    column-kind taxonomy.

No fallbacks. Anything unexpected raises so the caller sees the failure
rather than getting a half-built spec.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .. import reader

PRESET_API_VERSION = "0.1.0"
QVIZ_SCHEMA_VERSION = 1
PRESET_QUERY_HASH = "sha256:" + "0" * 64

# Matches src/qviz/validate.ts MAX_STRING_LENGTH. Applied to every string
# field flowing into the spec so the editor never refuses a preset-emitted
# file at open time.
MAX_STRING_LENGTH = 4096

# Allowed decimation values; runtime-checked because Literal[...] is only
# static. Mirrors src/qviz/validate.ts:540-545.
DECIMATION_VALUES: tuple[str, ...] = ("auto", "lttb", "minmax", "none")
DecimationLiteral = Literal["auto", "lttb", "minmax", "none"]

# Validator caps applied client-side so the user gets a Python traceback
# at the call site instead of an editor-side validation banner.
MAX_LIMIT_N = 10_000_000

# Column-kind taxonomy used by require_columns_typed. Mirrors the daemon's
# _classify_arrow_type at python/qviz/daemon.py.
ColumnKind = Literal["temporal", "numeric", "nominal", "any"]


# ---------------------------------------------------------------------------
# String hygiene
# ---------------------------------------------------------------------------


def check_acceptable_string(
    value: object,
    field_name: str,
    *,
    allow_empty: bool = True,
) -> str:
    """Apply the TS validator's isAcceptableString rules to a Python str.

    Mirrors src/qviz/validate.ts:694-707:
      - must be str
      - <= MAX_STRING_LENGTH (4096) characters
      - no NUL bytes
      - no C0 control characters except \\t \\n \\r

    Set allow_empty=False for fields where the empty string is meaningless
    (column names, generator strings, etc).

    Returns the value unchanged when valid; raises ValueError otherwise so
    the user gets a Python-side traceback at the call site rather than a
    silent validator banner when the editor later refuses the file.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string, got {type(value).__name__}")
    if not allow_empty and not value:
        raise ValueError(f"{field_name} must not be the empty string")
    if len(value) > MAX_STRING_LENGTH:
        raise ValueError(
            f"{field_name} exceeds {MAX_STRING_LENGTH} characters ({len(value)})"
        )
    for ch in value:
        if ch == "\x00":
            raise ValueError(f"{field_name} must not contain NUL bytes")
        code = ord(ch)
        if code < 0x20 and ch not in ("\t", "\n", "\r"):
            raise ValueError(
                f"{field_name} must not contain C0 control character 0x{code:02x}"
            )
    return value


def check_column_name(value: object, field_name: str) -> str:
    """check_acceptable_string + non-empty.

    Column names are used both in the parquet schema (via the DataFrame)
    AND in the spec's encoding fields, so they must satisfy both the
    pyarrow / DuckDB column-naming rules and the TS validator. Empty
    string is rejected explicitly.
    """
    return check_acceptable_string(value, field_name, allow_empty=False)


# ---------------------------------------------------------------------------
# Output path resolution
# ---------------------------------------------------------------------------


def resolve_output_under_cwd(output: str | Path) -> tuple[Path, str]:
    """Validate `output` (a stem with no extension) and derive disk + spec paths.

    Returns (absolute_stem_path, workspace_relative_uri_stem).

    Rules — anything else raises with a preset-named error:
      - `output` is a non-empty str or Path.
      - No NUL bytes.
      - No C0 control characters except \\t.
      - URI ≤ MAX_STRING_LENGTH (4096) chars.
      - No absolute paths (workspace root is CWD; absolute paths cannot
        be expressed as workspace-relative URIs).
      - No `..` segments in the input (rejected BEFORE resolve, matching
        security.py:resolve_workspace_path).
      - No trailing slash.
      - Resolved path is under CWD (rejects symlink-escape).
      - Basename contains no `.` (the parquet/spec extensions are added
        by string concat afterwards; allowing dots in the basename causes
        `with_suffix`-style truncation bugs in downstream code AND
        creates uri-vs-disk asymmetries).
      - Basename is not empty (rejects `output="."` and trailing slash
        edge cases that resolve to a directory).
    """
    if isinstance(output, Path):
        raw = os.fspath(output)
    elif isinstance(output, str):
        raw = output
    else:
        raise TypeError(f"output must be str or Path, got {type(output).__name__}")

    check_acceptable_string(raw, "output", allow_empty=False)

    # POSIX-style separator splitting catches both `/` (POSIX) and `\` (Windows)
    # before any resolve happens. Matches validate.ts:131-140.
    if raw.endswith("/") or raw.endswith("\\"):
        raise ValueError(f"output must not end with a path separator: {raw!r}")
    segments = raw.replace("\\", "/").split("/")
    if ".." in segments:
        raise ValueError(f"output must not contain '..' segments: {raw!r}")
    if Path(raw).is_absolute():
        raise ValueError(
            f"output must be workspace-relative (no absolute paths): {raw!r}"
        )

    candidate = Path(raw)
    basename = candidate.name
    if not basename or basename in (".", ".."):
        raise ValueError(
            f"output must end in a non-empty basename (got {basename!r} from {raw!r})"
        )
    if "." in basename:
        raise ValueError(
            f"output basename must not contain '.': {basename!r}. "
            f"Pass a stem with no extension; the preset adds .parquet / .qviz.json."
        )

    cwd = Path.cwd().resolve()
    abs_stem = (cwd / candidate).resolve()
    try:
        rel = abs_stem.relative_to(cwd)
    except ValueError as exc:
        raise ValueError(
            f"output {abs_stem} is outside the current working directory {cwd} "
            f"(symlink escape rejected)"
        ) from exc

    uri_stem = rel.as_posix()
    # Re-check the resolved URI for length (resolve can lengthen via symlink
    # expansion).
    if len(uri_stem) > MAX_STRING_LENGTH:
        raise ValueError(
            f"resolved uri_stem exceeds {MAX_STRING_LENGTH} characters ({len(uri_stem)})"
        )

    return abs_stem, uri_stem


def derive_paths(abs_stem: Path, uri_stem: str) -> tuple[Path, Path, str]:
    """Produce (parquet_path, spec_path, parquet_uri) from a validated stem.

    Uses string concat (not `Path.with_suffix`) so a stem like `out/btc`
    consistently yields `out/btc.parquet` and `out/btc.qviz.json`, with the
    spec URI built from the same string concat — eliminating the
    parquet-uri-vs-disk asymmetry that with_suffix can cause when a stem
    happens to contain a dot.
    """
    parquet_path = Path(f"{abs_stem}.parquet")
    spec_path = Path(f"{abs_stem}.qviz.json")
    parquet_uri = f"{uri_stem}.parquet"
    return parquet_path, spec_path, parquet_uri


# ---------------------------------------------------------------------------
# DataFrame validation
# ---------------------------------------------------------------------------


def make_generator_string(preset_module_name: str) -> str:
    """Single-source the generator string `qviz.<preset>/<version>`.

    Keeps every preset's `_GENERATOR` constant synced to
    PRESET_API_VERSION so a single bump propagates everywhere.
    """
    return f"qviz.{preset_module_name}/{PRESET_API_VERSION}"


def require_columns_typed(
    df: pd.DataFrame,
    expected: list[tuple[str, ColumnKind]],
    preset_name: str,
) -> None:
    """Verify each named column exists in `df` AND matches the expected kind.

    Kinds:
      - 'temporal': datetime64-like (any timezone) OR pyarrow timestamp dtype.
      - 'numeric': integer or floating point (including pandas nullable
        Int64/Float64). Object dtype with string values is rejected.
      - 'nominal': string-like, categorical, or object-dtype strings (used
        for groupby keys). Empty / NaN values are allowed and rendered as
        a null group.
      - 'any': existence-only check, no dtype enforcement.

    Raises KeyError when a column is missing; TypeError when the dtype
    fails the check. Both prefixed with the preset name so the traceback
    points at the right call site.

    Detects duplicate column names explicitly with a preset-named error
    so the caller doesn't see pyarrow's generic complaint.
    """
    if len(df) == 0:
        raise ValueError(
            f"{preset_name}: DataFrame is empty (0 rows); preset has nothing to plot"
        )
    column_counts: dict[str, int] = {}
    for col in df.columns:
        column_counts[col] = column_counts.get(col, 0) + 1
    duplicates = sorted([c for c, n in column_counts.items() if n > 1])
    if duplicates:
        raise ValueError(
            f"{preset_name}: DataFrame has duplicate column name(s) {duplicates}; "
            f"deduplicate before calling the preset"
        )

    missing = [name for name, _kind in expected if name not in df.columns]
    if missing:
        raise KeyError(
            f"{preset_name}: DataFrame is missing required column(s) {missing}; "
            f"got {list(df.columns)}"
        )

    for name, kind in expected:
        if kind == "any":
            continue
        series = df[name]
        if kind == "temporal":
            if not _is_temporal_series(series):
                raise TypeError(
                    f"{preset_name}: column '{name}' must be datetime-like "
                    f"(got dtype {series.dtype!r}; convert with pd.to_datetime)"
                )
        elif kind == "numeric":
            if not _is_numeric_series(series):
                raise TypeError(
                    f"{preset_name}: column '{name}' must be numeric "
                    f"(got dtype {series.dtype!r})"
                )
        elif kind == "nominal":
            if not _is_nominal_series(series):
                raise TypeError(
                    f"{preset_name}: column '{name}' must be string/categorical "
                    f"(got dtype {series.dtype!r})"
                )


def _is_temporal_series(series: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(series):
        return True
    # pandas extension type "timestamp[*][, tz=*]" wraps pyarrow timestamps.
    if hasattr(series.dtype, "pyarrow_dtype"):
        pat = series.dtype.pyarrow_dtype
        return pa.types.is_timestamp(pat) or pa.types.is_date(pat)
    return False


def _is_numeric_series(series: pd.Series) -> bool:
    if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
        return True
    # Nullable Int64 / Float64 from pandas extension types.
    dt = series.dtype
    if hasattr(dt, "name") and dt.name in ("Int8", "Int16", "Int32", "Int64",
                                            "UInt8", "UInt16", "UInt32", "UInt64",
                                            "Float32", "Float64"):
        return True
    if hasattr(dt, "pyarrow_dtype"):
        pat = dt.pyarrow_dtype
        return pa.types.is_integer(pat) or pa.types.is_floating(pat) or pa.types.is_decimal(pat)
    return False


def _is_nominal_series(series: pd.Series) -> bool:
    if isinstance(series.dtype, pd.CategoricalDtype):
        return True
    if pd.api.types.is_string_dtype(series):
        return True
    # Object dtype where non-null values are all strings.
    if series.dtype == object:
        non_null = series.dropna()
        if len(non_null) == 0:
            return True
        return non_null.map(lambda v: isinstance(v, str)).all()
    return False


def normalize_finite_floats(series: pd.Series) -> pd.Series:
    """Map +Inf/-Inf to NaN in a numeric series.

    The daemon's JSON-rows wire path normalizes non-finite floats to None
    (Phase 6 fix); the Arrow-IPC path passes them through unchanged. To
    keep the two transports consistent the preset normalizes inf -> NaN
    BEFORE the parquet write, so on-disk is the single source of truth.
    """
    if not _is_numeric_series(series):
        return series
    arr = series.to_numpy(dtype="float64", copy=True)
    arr[~np.isfinite(arr)] = np.nan
    return pd.Series(arr, index=series.index, name=series.name)


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------


def _atomic_write_bytes_under_parent(
    parent: Path, basename: str, payload: bytes,
) -> None:
    """Atomic-write `payload` to `parent/basename`, anchored via a dir-fd.

    M-1 cure: between resolve_output_under_cwd returning and the actual
    write, an attacker could replace `parent` with a symlink. We:

      1. Open `parent` via `O_DIRECTORY | O_NOFOLLOW` — fails if the
         post-resolve `parent` is now a symlink.
      2. Create the temp file via `os.open(..., dir_fd=parent_fd)` so
         the kernel resolves the basename against the captured fd, not
         a re-resolved path.
      3. Write the payload and fsync.
      4. `os.replace(tmp, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)`
         — atomic rename anchored to the same fd.

    Anything that swaps the parent dir, the basename, or the tmp name
    between calls is now caught at open() time with ELOOP/ENOENT.
    """
    parent.mkdir(parents=True, exist_ok=True)
    # secrets.token_hex collision-protects against parallel preset runs
    # under the same parent.
    import secrets  # noqa: PLC0415 — keep stdlib usage local for clarity
    tmp_basename = f".{basename}.tmp.{os.getpid()}.{secrets.token_hex(4)}"
    flags = os.O_RDONLY | os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    parent_fd = os.open(parent, flags)
    try:
        write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            write_flags |= os.O_NOFOLLOW
        tmp_fd = os.open(tmp_basename, write_flags, 0o644, dir_fd=parent_fd)
        try:
            try:
                offset = 0
                while offset < len(payload):
                    written = os.write(tmp_fd, payload[offset:])
                    if written <= 0:
                        raise OSError("os.write returned 0; disk full?")
                    offset += written
                os.fsync(tmp_fd)
            finally:
                os.close(tmp_fd)
            os.replace(
                tmp_basename, basename,
                src_dir_fd=parent_fd, dst_dir_fd=parent_fd,
            )
        except BaseException:
            try:
                os.unlink(tmp_basename, dir_fd=parent_fd)
            except (OSError, FileNotFoundError):
                pass
            raise
    finally:
        os.close(parent_fd)


def write_parquet_atomic(df: pd.DataFrame, parquet_path: Path) -> None:
    """Materialize a pandas DataFrame to parquet atomically + TOCTOU-safe.

    Serializes the parquet to an in-memory buffer first (via pyarrow),
    then writes that buffer to disk anchored to the resolved parent
    directory via `dir_fd` — so a post-resolve symlink swap can't
    redirect the write. Strips pandas metadata for reproducibility.
    """
    table = pa.Table.from_pandas(df, preserve_index=False)
    table = table.replace_schema_metadata(None)
    import io  # noqa: PLC0415 — local stdlib use
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="snappy")
    _atomic_write_bytes_under_parent(
        parquet_path.parent, parquet_path.name, buf.getvalue(),
    )


def write_text_atomic(text: str, path: Path) -> None:
    """Write `text` to `path` atomically + TOCTOU-safe (see
    _atomic_write_bytes_under_parent)."""
    _atomic_write_bytes_under_parent(
        path.parent, path.name, text.encode("utf-8"),
    )


# ---------------------------------------------------------------------------
# Dataset block + provenance
# ---------------------------------------------------------------------------


def compute_dataset_block(parquet_path: Path, workspace_relative_uri: str) -> dict[str, Any]:
    """Build the DatasetRef sub-dict from a freshly-written parquet.

    Reads the schema via `reader.read_schema` (the SAME function the
    daemon uses on file open) so the schema_hash byte-matches what the
    daemon will compute later. Without this parity, parquets with
    duplicate column names produce a drifted hash on first open.
    """
    schema = reader.read_schema(parquet_path)
    schema_hash = reader.hash_schema(schema)
    mtime_ns = reader.file_mtime_ns(parquet_path)
    row_count = pq.ParquetFile(parquet_path).metadata.num_rows
    # row_count > Number.MAX_SAFE_INTEGER would fail the TS validator.
    # Such files are pathological but cheap to refuse.
    if row_count > 9_007_199_254_740_991:
        raise ValueError(
            f"parquet row_count {row_count} exceeds the validator's safe-integer cap"
        )
    return {
        "uri": workspace_relative_uri,
        "schema_hash": schema_hash,
        "mtime_ns": mtime_ns,
        "row_count": row_count,
    }


def build_provenance(generator: str) -> dict[str, Any]:
    """Canonical Provenance sub-dict for preset-emitted specs.

    `query_hash` is the all-zeros sentinel — preset specs aren't tied to
    a daemon aggregate query yet. `tool_versions.qviz_schema` is required
    by the validator. Microsecond resolution on generated_at so back-to-back
    preset calls don't share an ISO timestamp.
    """
    check_acceptable_string(generator, "provenance.generator", allow_empty=False)
    now = datetime.now(timezone.utc)
    return {
        "generated_at": now.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "generator": generator,
        "query_hash": PRESET_QUERY_HASH,
        "tool_versions": {
            "qviz_schema": QVIZ_SCHEMA_VERSION,
            "python_qviz": PRESET_API_VERSION,
        },
        "source": "engine-emitted",
    }


# ---------------------------------------------------------------------------
# Overwrite guard
# ---------------------------------------------------------------------------


def check_overwrite(parquet_path: Path, spec_path: Path, overwrite: bool) -> None:
    """Raise FileExistsError if either output path exists and overwrite=False.

    Matches the CLAUDE.md "fail loudly" rule: silently clobbering existing
    files is a fallback in disguise. Default is False so the user has to
    opt in to replacement.
    """
    if overwrite:
        return
    conflicts = []
    if parquet_path.exists():
        conflicts.append(str(parquet_path))
    if spec_path.exists():
        conflicts.append(str(spec_path))
    if conflicts:
        raise FileExistsError(
            f"output paths already exist: {conflicts}. "
            f"Pass overwrite=True to replace them."
        )


# ---------------------------------------------------------------------------
# Decimation runtime guard
# ---------------------------------------------------------------------------


def check_decimation(value: object) -> str:
    """Validate decimation kwarg at the preset's call site.

    The Literal[...] type hint is only static; without this runtime check
    a typo like decimation='lttp' silently writes a spec the editor
    refuses to load at open time.
    """
    if value not in DECIMATION_VALUES:
        raise ValueError(
            f"decimation must be one of {DECIMATION_VALUES!r}, got {value!r}"
        )
    return value  # type: ignore[return-value]


def check_bool(value: object, field_name: str) -> bool:
    """Reject truthy/falsy non-bool values for boolean kwargs.

    `aggregate="False"` is a common user mistake — the string is truthy
    in Python so aggregation fires despite caller intent. Fail loudly.
    """
    if not isinstance(value, bool):
        raise TypeError(
            f"{field_name} must be bool, got {type(value).__name__} ({value!r})"
        )
    return value


def check_limit(value: object, field_name: str = "limit") -> int:
    """Validate a `limit=` kwarg: int in [1, MAX_LIMIT_N], rejecting bool.

    `bool` is a subclass of `int` so `isinstance(limit, int)` would
    accept True/False silently. The explicit bool exclusion catches that.
    """
    if isinstance(value, bool):
        raise TypeError(f"{field_name} must be int, got bool ({value!r})")
    if not isinstance(value, int):
        raise TypeError(
            f"{field_name} must be int, got {type(value).__name__} ({value!r})"
        )
    if value < 1 or value > MAX_LIMIT_N:
        raise ValueError(
            f"{field_name} must be in [1, {MAX_LIMIT_N}], got {value}"
        )
    return value
