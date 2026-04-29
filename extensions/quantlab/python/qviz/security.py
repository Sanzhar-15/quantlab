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


# Allowlisted file extensions. CSV/XLSX/parquet are the data formats Visualise
# accepts. Adding others requires a deliberate change here AND an entry in the
# reader dispatch.
ALLOWED_EXTENSIONS = frozenset({".parquet", ".csv", ".tsv", ".xlsx", ".xls"})


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
    """
    if not requested:
        raise SecurityError("path: must not be empty")

    if requested.startswith("/") or requested.startswith("\\") or (len(requested) >= 2 and requested[1] == ":"):
        raise SecurityError(f"path: must be workspace-relative, not absolute: {requested!r}")

    parts = requested.replace("\\", "/").split("/")
    if ".." in parts:
        raise SecurityError(f"path: must not contain '..' segments: {requested!r}")

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

    Yields a dict where the executor can place metadata (e.g., 'cancelled': True
    if a cancel was received via another channel).
    """
    if timeout_s <= 0 or timeout_s > 600:
        raise SecurityError(f"timeout_s out of range (0, 600]: {timeout_s}")
    if peak_rss_mb <= 0 or peak_rss_mb > 16384:
        raise SecurityError(f"peak_rss_mb out of range (0, 16384]: {peak_rss_mb}")

    rss_before = _peak_rss_mb()
    state = {"cancelled": False}

    timer = threading.Timer(timeout_s, _interrupt_main_thread)
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
