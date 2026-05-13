"""Security gates for the qviz query daemon.

The daemon executes queries against user files referenced by .qviz.json specs.
.qviz.json files may have been authored by anyone (workspace-trust threat model).
This module enforces invariants the rest of the daemon relies on:

  - Paths are workspace-relative and stay inside the workspace root after
    realpath resolution (no symlink escape).
  - File extensions are on the allowlist (parquet/csv/xlsx today).
  - Query execution is bounded by wallclock + peak RSS.

If any invariant fails, raise SecurityError with a clear reason. The daemon
turns SecurityError into a structured error response — never a crash.
"""

from __future__ import annotations

import os
import resource
import signal
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class SecurityError(Exception):
    """Raised when a request violates a security invariant.

    Distinct from generic ValueError so the IPC layer can return a specific
    response code.
    """


# Allowlisted file extensions. MUST match the reader's actual dispatch
# in `python/qviz/reader.py` — the reader supports parquet/csv/tsv only;
# xlsx/xls raise NotImplementedError. Megaudit CRITICAL-3: the prior
# list included xlsx/xls (mismatching the reader AND the TS-side
# `src/qviz/persist.ts` allowlist). A spec referencing xlsx would pass
# this gate and fail confusingly inside the reader. One source of truth:
# extension/daemon must agree, AND only formats the reader actually
# implements. Adding a new format requires a deliberate change here
# AND a reader implementation AND an entry in the TS allowlist.
ALLOWED_EXTENSIONS = frozenset({".parquet", ".csv", ".tsv"})


def resolve_workspace_path(workspace_root: str | Path, requested: str) -> Path:
    """Resolve a workspace-relative path and verify it stays inside the workspace.

    Steps:
      1. Reject absolute paths up-front (defensive — validator should have caught).
      2. Reject any path containing ".." segments (defensive — same reason).
      3. Realpath-resolve both workspace_root and the joined path.
      4. Confirm the resolved file is a descendant of resolved workspace_root.
         This catches symlinks pointing outside.
      5. Confirm the file exists and has an allowlisted extension.

    Raises SecurityError on any violation.

    Megaudit Theme C (C6, 2026-05-13): caller MUST treat this as a
    POINT-IN-TIME check. Path can change between this resolution and a
    later open (TOCTOU). Where security matters (read_parquet, schema
    fetch), call `verify_path_identity(path)` immediately before each
    open to confirm the path's inode/dev hasn't been swapped under us.
    """
    if not requested:
        raise SecurityError("path: must not be empty")

    # C6 (megaudit): hard byte caps on the requested path and its
    # segments. The realpath call below tolerates long inputs but
    # downstream filesystem APIs differ by OS.
    MAX_PATH_BYTES = 4096
    MAX_SEGMENT_BYTES = 255
    encoded = requested.encode("utf-8", errors="strict")
    if len(encoded) > MAX_PATH_BYTES:
        raise SecurityError(f"path: byte length {len(encoded)} exceeds cap {MAX_PATH_BYTES}")

    if requested.startswith("/") or requested.startswith("\\") or (len(requested) >= 2 and requested[1] == ":"):
        raise SecurityError(f"path: must be workspace-relative, not absolute: {requested!r}")

    parts = requested.replace("\\", "/").split("/")
    if ".." in parts:
        raise SecurityError(f"path: must not contain '..' segments: {requested!r}")
    for seg in parts:
        if len(seg.encode("utf-8", errors="strict")) > MAX_SEGMENT_BYTES:
            raise SecurityError(
                f"path: segment {seg!r} byte length exceeds cap {MAX_SEGMENT_BYTES}"
            )

    root_resolved = Path(workspace_root).resolve(strict=True)
    candidate = (root_resolved / requested).resolve(strict=False)

    # is_relative_to was added in 3.9; fall back to startswith on the str form
    # if not available. Python 3.12 has it, so simple call.
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        raise SecurityError(
            f"path: resolves outside workspace via symlink: {requested!r} -> {candidate}"
        )

    if not candidate.exists():
        raise SecurityError(f"path: does not exist: {requested!r}")

    if not candidate.is_file():
        raise SecurityError(f"path: not a regular file: {requested!r}")

    suffix = candidate.suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise SecurityError(
            f"path: extension {suffix!r} not allowed (allowed: "
            f"{sorted(ALLOWED_EXTENSIONS)})"
        )

    return candidate


# ---------------------------------------------------------------------------
# Resource bounds
# ---------------------------------------------------------------------------

# Defaults. The IPC layer can lower these per-request but never raise.
DEFAULT_TIMEOUT_S = 30.0
DEFAULT_PEAK_RSS_MB = 2048


class TimeoutError_(Exception):
    """Wallclock budget exceeded. Distinct from python's stdlib TimeoutError to
    avoid accidentally catching unrelated upstream timeouts."""


class MemoryLimitError(Exception):
    """Peak RSS budget exceeded for this request."""


@contextmanager
def query_budget(
    timeout_s: float = DEFAULT_TIMEOUT_S,
    peak_rss_mb: int = DEFAULT_PEAK_RSS_MB,
    *,
    conn: object | None = None,
) -> Iterator[dict]:
    """Bound a query's wallclock and peak RSS.

    Wallclock: a watchdog thread raises an interrupt in the main thread when
    timeout expires. Caller code is expected to be running pyarrow/duckdb
    operations that are interruptible (DuckDB checks interrupts cooperatively).

    Peak RSS: snapshot before, snapshot after on context exit. If the delta
    exceeds peak_rss_mb, raise MemoryLimitError. This is post-hoc detection —
    we cannot abort mid-query on memory alone without OS-level limits, but
    we can refuse to return enormous results.

    Note: macOS getrusage returns ru_maxrss in BYTES; Linux returns KILOBYTES.
    We normalize to MB.

    Megaudit Theme C (C3, 2026-05-13): the optional `conn` parameter is
    the active DuckDB connection for this request. When supplied, the
    watchdog ALSO calls `conn.interrupt()` on timeout, which terminates
    DuckDB queries that are blocked inside C-level code where Python's
    KeyboardInterrupt-via-SIGINT can't reach. We do NOT use
    `SET memory_limit` because that's connection-global, and the
    daemon's `self.conn` is shared across all requests; mid-query
    interrupt is the correct lever.

    Yields a dict where the executor can place metadata (e.g., 'cancelled': True
    if a cancel was received via another channel).
    """
    if timeout_s <= 0 or timeout_s > 600:
        raise SecurityError(f"timeout_s out of range (0, 600]: {timeout_s}")
    if peak_rss_mb <= 0 or peak_rss_mb > 16384:
        raise SecurityError(f"peak_rss_mb out of range (0, 16384]: {peak_rss_mb}")

    rss_before = _peak_rss_mb()
    state = {"cancelled": False}

    def _on_timeout() -> None:
        # C3 (megaudit): DuckDB-level cancel runs FIRST so blocked
        # C-level queries get cut; SIGINT runs second to interrupt the
        # Python main thread at the next bytecode boundary.
        if conn is not None:
            try:
                conn.interrupt()  # type: ignore[attr-defined]
            except Exception as e:
                # The conn may not support interrupt() (test stubs, etc.)
                # — surface the failure but proceed to SIGINT path.
                import sys
                print(f"[qviz security] conn.interrupt() raised: {e!r}", file=sys.stderr)
        _interrupt_main_thread()

    timer = threading.Timer(timeout_s, _on_timeout)
    timer.daemon = True
    timer.start()
    started_at = time.perf_counter()

    try:
        yield state
    except KeyboardInterrupt:
        # The watchdog uses SIGINT for cooperative interruption. Re-raise as
        # our explicit timeout error so callers can distinguish.
        elapsed = time.perf_counter() - started_at
        raise TimeoutError_(f"query exceeded {timeout_s}s budget (ran for {elapsed:.1f}s)")
    finally:
        timer.cancel()

    rss_after = _peak_rss_mb()
    delta = rss_after - rss_before
    if delta > peak_rss_mb:
        raise MemoryLimitError(
            f"query allocated {delta:.0f}MB peak (cap {peak_rss_mb}MB)"
        )


def _peak_rss_mb() -> float:
    """Peak resident set size in megabytes. Cross-platform for Linux + macOS."""
    rss_raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS: bytes. Linux: KiB.
    import sys
    if sys.platform == "darwin":
        return rss_raw / (1024 * 1024)
    return rss_raw / 1024


def _interrupt_main_thread() -> None:
    """Send SIGINT to the process to cooperatively interrupt a long query.

    Reliable interruption of blocking syscalls (read, sleep) requires the
    OS signal path, not just _thread.interrupt_main(). On Unix, os.kill(pid,
    SIGINT) interrupts syscalls; the kernel returns EINTR and Python raises
    KeyboardInterrupt at the next bytecode boundary in the main thread.

    DuckDB connections separately expose interrupt() — production code
    holds a reference to the active connection and calls it as well, so
    even non-Python-level operations terminate.
    """
    if os.name == "posix":
        os.kill(os.getpid(), signal.SIGINT)
    else:
        import _thread
        _thread.interrupt_main()


# ---------------------------------------------------------------------------
# Spec-level caps (Megaudit Theme C C2, 2026-05-13)
# ---------------------------------------------------------------------------
#
# Enforced BEFORE `compile_spec` so a hostile spec with an enormous IN
# list / 1000 transforms can't generate huge SQL strings + param arrays
# outside the query_budget timeout/memory accounting.

SPEC_CAPS = {
    "max_transforms": 64,           # 5-10 is typical; 64 is generous
    "max_aggregates_per_transform": 32,
    "max_sort_columns": 8,
    "max_filter_in_values": 1024,   # matches FilterTransform IN-list bound
    "max_groupby_columns": 16,
}


def enforce_spec_caps(spec: dict) -> None:
    """Reject specs that would generate huge SQL/params before any
    compile work runs. Raises SecurityError with a structured message
    naming the offending field.
    """
    if not isinstance(spec, dict):
        raise SecurityError(f"spec must be dict, got {type(spec).__name__}")
    transforms = spec.get("transforms", []) or []
    if not isinstance(transforms, list):
        raise SecurityError("spec.transforms must be a list")
    if len(transforms) > SPEC_CAPS["max_transforms"]:
        raise SecurityError(
            f"spec.transforms length {len(transforms)} exceeds cap "
            f"{SPEC_CAPS['max_transforms']}"
        )
    for i, t in enumerate(transforms):
        if not isinstance(t, dict):
            continue  # validator + compiler will reject
        kind = t.get("kind")
        if kind == "filter" and t.get("op") in ("in", "not_in"):
            value = t.get("value")
            if isinstance(value, list) and len(value) > SPEC_CAPS["max_filter_in_values"]:
                raise SecurityError(
                    f"transforms[{i}].value IN-list length {len(value)} "
                    f"exceeds cap {SPEC_CAPS['max_filter_in_values']}"
                )
        elif kind == "aggregate":
            aggs = t.get("aggs", [])
            if isinstance(aggs, list) and len(aggs) > SPEC_CAPS["max_aggregates_per_transform"]:
                raise SecurityError(
                    f"transforms[{i}].aggs length {len(aggs)} "
                    f"exceeds cap {SPEC_CAPS['max_aggregates_per_transform']}"
                )
        elif kind == "sort":
            cols = t.get("columns", [])
            if isinstance(cols, list) and len(cols) > SPEC_CAPS["max_sort_columns"]:
                raise SecurityError(
                    f"transforms[{i}].columns length {len(cols)} "
                    f"exceeds cap {SPEC_CAPS['max_sort_columns']}"
                )
        elif kind == "groupby":
            cols = t.get("columns", [])
            if isinstance(cols, list) and len(cols) > SPEC_CAPS["max_groupby_columns"]:
                raise SecurityError(
                    f"transforms[{i}].columns length {len(cols)} "
                    f"exceeds cap {SPEC_CAPS['max_groupby_columns']}"
                )
