"""Quantlab Visualise query daemon — main entry point.

Single long-lived Python process per workspace. Reads length-prefixed framed
requests from stdin, writes responses to stdout. Stderr is for human logs.

Lifecycle:
  - Spawned by the VS Code extension on workspace open with WORKSPACE_ROOT
    env var set to the workspace folder.
  - Single-threaded request handler. One operation at a time per workspace
    (DuckDB connection is reused across ops for warm-cache benefit).
  - Graceful shutdown on stdin EOF.

Ops:
  ping       sanity check
  schema     file_uri -> {row_count, columns:[{name,dtype,nullable}], schema_hash, mtime_ns}
  preview    file_uri, n -> Arrow IPC of first N rows (or JSON if small)
  aggregate  spec -> Arrow IPC of compiled-and-executed query result
  decimate   file_uri, x_col, y_col, n -> JSON of LTTB-decimated points
  cancel     v1: ignored (use timeout); v2: cooperative interrupt

Wire format (per ipc.py):
  request:  JSON frame {"id": int, "op": str, ...}
  response: JSON frame {"id": int, "ok": bool, "data": ..., "error": str?,
                        "elapsed_ms": float, "encoding": "json"|"arrow"}
            optionally followed by an Arrow IPC frame if encoding == "arrow"
"""

from __future__ import annotations

import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa

from . import reader
from .cache import LRUCache, make_cache_key
from .compiler import CompileError, compile_spec
from .ipc import (
    FRAME_JSON,
    IPCError,
    read_frame,
    write_arrow,
    write_json,
)
from .security import (
    DEFAULT_PEAK_RSS_MB,
    DEFAULT_TIMEOUT_S,
    MemoryLimitError,
    SecurityError,
    TimeoutError_,
    query_budget,
    resolve_workspace_path,
)


# Threshold below which we return data inline as JSON; above which we use the
# Arrow IPC frame. 256 KB is roughly where JSON serialization starts to cost
# more than the framing overhead.
INLINE_JSON_THRESHOLD_BYTES = 256 * 1024


class Daemon:
    """One daemon instance per workspace.

    Public methods are individual op handlers (testable in isolation).
    `run()` drives the IPC loop.
    """

    def __init__(self, workspace_root: str | Path):
        self.workspace_root = Path(workspace_root).resolve(strict=True)
        # Single shared DuckDB connection — pyarrow integration is cheap to
        # reuse, and the connection holds compiled-statement cache.
        self.conn = duckdb.connect(":memory:")
        # Reduce DuckDB's thread footprint inside an extension host that is
        # already running multiple workers.
        self.conn.execute("SET threads = 4")
        # Cache aggregate results keyed by (path, mtime, plan_hash).
        self.cache: LRUCache[bytes] = LRUCache(max_entries=128, max_bytes=128 * 1024 * 1024)
        # For schema reads — separate cache so heavy aggregate evictions
        # don't kick out cheap schemas.
        self.schema_cache: LRUCache[dict] = LRUCache(max_entries=512, max_bytes=4 * 1024 * 1024)

    # -----------------------------------------------------------------------
    # Op handlers
    # -----------------------------------------------------------------------

    def op_ping(self, req: dict) -> dict:
        return {"data": {"pong": True, "workspace": str(self.workspace_root)}, "encoding": "json"}

    def op_schema(self, req: dict) -> dict:
        path_str = req["path"]
        path = resolve_workspace_path(self.workspace_root, path_str)
        mtime = reader.file_mtime_ns(path)
        cache_key = make_cache_key(file_path=str(path), mtime_ns=mtime, plan="schema")
        cached = self.schema_cache.get(cache_key)
        if cached is not None:
            return {"data": {**cached, "cached": True}, "encoding": "json"}

        schema = reader.read_schema(path)
        row_count = reader.file_row_count(path) if path.suffix.lower() == ".parquet" else None
        columns = [
            {"name": schema.field(i).name, "dtype": str(schema.field(i).type),
             "nullable": schema.field(i).nullable}
            for i in range(len(schema.names))
        ]
        result = {
            "uri": path_str,
            "schema_hash": reader.hash_schema(schema),
            "mtime_ns": mtime,
            "row_count": row_count,
            "columns": columns,
            "cached": False,
        }
        self.schema_cache.put(cache_key, {k: v for k, v in result.items() if k != "cached"},
                              bytes_estimate=2048)
        return {"data": result, "encoding": "json"}

    def op_preview(self, req: dict) -> dict:
        path_str = req["path"]
        n = int(req.get("n", 100))
        path = resolve_workspace_path(self.workspace_root, path_str)
        with query_budget(
            timeout_s=float(req.get("timeout_s", DEFAULT_TIMEOUT_S)),
            peak_rss_mb=int(req.get("peak_rss_mb", DEFAULT_PEAK_RSS_MB)),
        ):
            table = reader.read_preview(path, n=n)
        return self._wrap_arrow_or_json(table)

    def op_aggregate(self, req: dict) -> dict:
        spec = req["spec"]
        # The spec's dataset.uri is the canonical reference. The validator
        # has already enforced workspace-relative; we re-validate here.
        dataset = spec.get("dataset", {})
        path_str = dataset.get("uri")
        if not path_str:
            raise ValueError("spec.dataset.uri is required")
        path = resolve_workspace_path(self.workspace_root, path_str)
        mtime = reader.file_mtime_ns(path)

        cache_key = make_cache_key(file_path=str(path), mtime_ns=mtime, plan=spec)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {
                "binary": cached,
                "data": {"cached": True, "n": _arrow_row_count(cached), "bytes": len(cached)},
                "encoding": "arrow",
            }

        schema = reader.read_schema(path)
        compiled = compile_spec(spec, schema, str(path))

        with query_budget(
            timeout_s=float(req.get("timeout_s", DEFAULT_TIMEOUT_S)),
            peak_rss_mb=int(req.get("peak_rss_mb", DEFAULT_PEAK_RSS_MB)),
        ):
            # .arrow() returns RecordBatchReader; we want a Table.
            # to_arrow_table() is the modern API (fetch_arrow_table deprecated).
            cursor = self.conn.execute(compiled.sql, compiled.params)
            if hasattr(cursor, "to_arrow_table"):
                arrow_table = cursor.to_arrow_table()
            else:
                arrow_table = cursor.fetch_arrow_table()

        arrow_bytes = reader.table_to_arrow_ipc(arrow_table)
        self.cache.put(cache_key, arrow_bytes, bytes_estimate=len(arrow_bytes))
        return {
            "binary": arrow_bytes,
            "data": {
                "cached": False,
                "n": arrow_table.num_rows,
                "bytes": len(arrow_bytes),
                "columns": arrow_table.column_names,
            },
            "encoding": "arrow",
        }

    def op_decimate(self, req: dict) -> dict:
        from .decimate import lttb
        import pyarrow.parquet as pq
        import numpy as np

        path_str = req["path"]
        x_col = req["x_col"]; y_col = req["y_col"]
        n_visible = int(req.get("n_visible", 3000))
        path = resolve_workspace_path(self.workspace_root, path_str)
        # Validate column names against the file schema BEFORE handing them
        # to pyarrow. Without this, an attacker can send arbitrary column
        # references and trigger uncontrolled errors. (Audit finding #3)
        schema = reader.read_schema(path)
        schema_names = set(schema.names)
        if x_col not in schema_names:
            raise SecurityError(
                f"decimate: x_col {x_col!r} not in file schema "
                f"(available: {sorted(schema_names)})"
            )
        if y_col not in schema_names:
            raise SecurityError(
                f"decimate: y_col {y_col!r} not in file schema "
                f"(available: {sorted(schema_names)})"
            )
        mtime = reader.file_mtime_ns(path)
        cache_key = make_cache_key(
            file_path=str(path), mtime_ns=mtime,
            plan=f"decimate:{x_col},{y_col},{n_visible}",
        )
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {"binary": cached, "data": {"cached": True}, "encoding": "arrow"}

        with query_budget(
            timeout_s=float(req.get("timeout_s", DEFAULT_TIMEOUT_S)),
            peak_rss_mb=int(req.get("peak_rss_mb", DEFAULT_PEAK_RSS_MB)),
        ):
            t = pq.read_table(str(path), columns=[x_col, y_col])
            xs = t.column(x_col).to_numpy(zero_copy_only=False)
            ys = t.column(y_col).to_numpy(zero_copy_only=False)
            if np.issubdtype(xs.dtype, np.datetime64):
                xs = xs.astype("datetime64[ms]").astype(np.int64)
            # Pre-filter NaN/null rows before LTTB. LTTB can pick a NaN point
            # from an all-NaN bucket, which then renders as a gap; filtering
            # upstream gives the renderer a clean, contiguous series.
            # (Audit finding #8.)
            if ys.dtype.kind == "f":
                mask = ~np.isnan(ys)
                if mask.sum() < ys.shape[0]:
                    xs = xs[mask]
                    ys = ys[mask]
            out_xs, out_ys = lttb(xs, ys, n_visible)

        arrow_table = pa.table({"t": out_xs, "v": out_ys})
        arrow_bytes = reader.table_to_arrow_ipc(arrow_table)
        self.cache.put(cache_key, arrow_bytes, bytes_estimate=len(arrow_bytes))
        return {
            "binary": arrow_bytes,
            "data": {"cached": False, "n_input": int(t.num_rows), "n_output": len(out_xs),
                     "bytes": len(arrow_bytes)},
            "encoding": "arrow",
        }

    def op_stats(self, req: dict) -> dict:
        return {
            "data": {
                "result_cache": self.cache.stats(),
                "schema_cache": self.schema_cache.stats(),
            },
            "encoding": "json",
        }

    # -----------------------------------------------------------------------
    # Dispatch + IPC loop
    # -----------------------------------------------------------------------

    OPS: dict[str, str] = {
        "ping": "op_ping",
        "schema": "op_schema",
        "preview": "op_preview",
        "aggregate": "op_aggregate",
        "decimate": "op_decimate",
        "stats": "op_stats",
    }

    def handle(self, req: dict) -> tuple[dict, bytes | None]:
        """Dispatch one request. Returns (json_response, optional_arrow_payload)."""
        op_name = req.get("op")
        method_name = self.OPS.get(op_name) if isinstance(op_name, str) else None
        if not method_name:
            return ({"id": req.get("id"), "ok": False,
                     "error": f"unknown op: {op_name!r}", "elapsed_ms": 0.0}, None)
        handler = getattr(self, method_name)

        t0 = time.perf_counter()
        try:
            result = handler(req)
        except (SecurityError, CompileError) as e:
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}",
                     "elapsed_ms": elapsed}, None)
        except (TimeoutError_, MemoryLimitError) as e:
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}",
                     "elapsed_ms": elapsed}, None)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False,
                     "error": f"InternalError: {type(e).__name__}: {e}",
                     "elapsed_ms": elapsed}, None)

        elapsed = (time.perf_counter() - t0) * 1000
        json_response = {
            "id": req.get("id"),
            "ok": True,
            "data": result.get("data"),
            "encoding": result.get("encoding", "json"),
            "elapsed_ms": elapsed,
        }
        return (json_response, result.get("binary"))

    def run(self) -> None:
        # Use unbuffered binary streams.
        in_ = sys.stdin.buffer
        out = sys.stdout.buffer

        # Banner
        write_json(out, {"daemon": "qviz", "version": 1, "ops": list(self.OPS.keys())})
        out.flush()

        while True:
            try:
                tag, payload = read_frame(in_)
            except EOFError:
                return
            except IPCError as e:
                # Send a protocol-level error and continue. Without a request
                # id, we can't correlate; client should treat this as fatal.
                write_json(out, {"ok": False, "error": f"IPCError: {e}"})
                out.flush()
                return

            if tag != FRAME_JSON:
                write_json(out, {"ok": False, "error": f"unexpected frame type: {tag}"})
                out.flush()
                continue

            try:
                import json as _json
                req = _json.loads(payload.decode("utf-8"))
            except Exception as e:
                write_json(out, {"ok": False, "error": f"BadJSON: {e}"})
                out.flush()
                continue

            response, binary = self.handle(req)
            write_json(out, response)
            if binary is not None:
                write_arrow(out, binary)
            out.flush()

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _wrap_arrow_or_json(table: pa.Table) -> dict:
        """Decide whether to send a small table inline as JSON or as Arrow IPC.

        Threshold: ~256 KB of estimated Arrow size. Below that, JSON is fine
        and avoids the Arrow IPC overhead. Above, Arrow IPC saves bandwidth
        and parse time.
        """
        if table.nbytes < INLINE_JSON_THRESHOLD_BYTES:
            rows: list[dict] = []
            for batch in table.to_batches():
                rows.extend(batch.to_pylist())
            return {"data": {"rows": rows, "n": len(rows)}, "encoding": "json"}
        arrow_bytes = reader.table_to_arrow_ipc(table)
        return {
            "binary": arrow_bytes,
            "data": {"n": table.num_rows, "bytes": len(arrow_bytes),
                     "columns": table.column_names},
            "encoding": "arrow",
        }


def _arrow_row_count(arrow_bytes: bytes) -> int:
    """Cheap row count for cached Arrow IPC bytes."""
    return reader.arrow_ipc_to_table(arrow_bytes).num_rows


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    workspace_root = os.environ.get("QUANTLAB_WORKSPACE_ROOT")
    if not workspace_root:
        sys.stderr.write("ERROR: QUANTLAB_WORKSPACE_ROOT env var is required\n")
        sys.exit(2)
    daemon = Daemon(workspace_root)
    daemon.run()


if __name__ == "__main__":
    main()
