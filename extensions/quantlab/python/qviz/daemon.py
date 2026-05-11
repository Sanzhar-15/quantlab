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

import json
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

# Megaudit-2 A4-C2: pin a minimum DuckDB version. The qviz daemon relies on
# `connection.execute(...).arrow()` and the Arrow integration shape that has
# been stable since DuckDB 0.9.0. Older releases either lacked the method
# (≤0.8) or used a different chunking layout (early 0.9 betas) that produced
# malformed IPC. We compare against this minimum at startup so a misconfigured
# venv fails LOUDLY with an actionable message instead of crashing mid-query
# with a confusing AttributeError or arrow extraction failure on the webview
# side.
MIN_DUCKDB_VERSION = (0, 9, 0)


def _parse_duckdb_version(version_str: str) -> tuple[int, ...]:
    """Parse a DuckDB version string like '0.9.2' or '1.1.0-dev123' into a tuple.

    Strips any suffix after the third numeric component so we tolerate dev
    snapshots / git-built wheels. Raises ValueError on completely malformed
    strings -- callers translate that into a clean startup error.
    """
    head = version_str.split("-", 1)[0].split("+", 1)[0]
    parts = head.split(".")
    if len(parts) < 2:
        raise ValueError(f"unparseable DuckDB version: {version_str!r}")
    nums: list[int] = []
    for p in parts[:3]:
        nums.append(int(p))
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def _check_duckdb_version() -> None:
    """Megaudit-2 A4-C2: verify DuckDB ≥ MIN_DUCKDB_VERSION at startup.

    Fails the daemon with a clear, actionable error if the installed wheel
    is too old. The extension host's lifecycle manager surfaces the stderr
    line as `daemonStatus: unavailable` with the message intact.
    """
    raw = getattr(duckdb, "__version__", None)
    if raw is None:
        sys.stderr.write(
            "ERROR: duckdb module has no __version__ attribute; "
            "cannot verify minimum version. Reinstall duckdb >= "
            f"{'.'.join(str(x) for x in MIN_DUCKDB_VERSION)}.\n"
        )
        sys.exit(3)
    try:
        actual = _parse_duckdb_version(raw)
    except ValueError as exc:
        sys.stderr.write(f"ERROR: {exc}\n")
        sys.exit(3)
    if actual < MIN_DUCKDB_VERSION:
        sys.stderr.write(
            f"ERROR: duckdb {raw} is too old; minimum required is "
            f"{'.'.join(str(x) for x in MIN_DUCKDB_VERSION)}. "
            "Upgrade with: pip install --upgrade 'duckdb>="
            f"{'.'.join(str(x) for x in MIN_DUCKDB_VERSION)}'\n"
        )
        sys.exit(3)


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
        # Stores Arrow IPC bytes for aggregates / decimates AND, for
        # filtered previews under the inline-JSON threshold, the JSON
        # rows dict (so M-32 cache fires even for small windows).
        self.cache: LRUCache[bytes | dict] = LRUCache(max_entries=128, max_bytes=128 * 1024 * 1024)
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
        # Schema cache fingerprint omits schema_hash (it IS the value);
        # mtime+size+ctime is enough to detect any rewrite of the file
        # (audit finding #5: TOCTOU was previously narrowed-not-closed).
        fp = reader.file_fingerprint(path)
        cache_key = make_cache_key(
            file_path=str(path), fingerprint=fp, plan="schema",
        )
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
            "mtime_ns": fp["mtime_ns"],
            "row_count": row_count,
            "columns": columns,
            "cached": False,
        }
        self.schema_cache.put(cache_key, {k: v for k, v in result.items() if k != "cached"},
                              bytes_estimate=2048)
        return {"data": result, "encoding": "json"}

    # ---- internal helper for AF-Daemon-Python AF29 ----
    def _resolve_schema_with_hash(self, path: Path) -> tuple[pa.Schema, str, dict]:
        """Get (schema, schema_hash, full_fingerprint) reusing the schema cache.

        Without this, op_aggregate / op_decimate would call read_schema +
        hash_schema on every cache lookup, even on hits. By routing through
        the schema cache (which is already keyed on the size+ctime+mtime
        fingerprint), repeat calls against the same file are sub-millisecond.
        """
        fp_no_schema = reader.file_fingerprint(path)
        sch_key = make_cache_key(
            file_path=str(path), fingerprint=fp_no_schema, plan="schema",
        )
        cached = self.schema_cache.get(sch_key)
        if cached is not None:
            schema_hash = cached["schema_hash"]
            schema = reader.read_schema(path)  # cheap: pq metadata read
            full_fp = {**fp_no_schema, "schema_hash": schema_hash}
            return schema, schema_hash, full_fp
        schema = reader.read_schema(path)
        schema_hash = reader.hash_schema(schema)
        # Pre-warm the schema cache so the next op_aggregate/decimate hits.
        row_count = reader.file_row_count(path) if path.suffix.lower() == ".parquet" else None
        columns = [
            {"name": schema.field(i).name, "dtype": str(schema.field(i).type),
             "nullable": schema.field(i).nullable}
            for i in range(len(schema.names))
        ]
        self.schema_cache.put(sch_key, {
            "uri": str(path),
            "schema_hash": schema_hash,
            "mtime_ns": fp_no_schema["mtime_ns"],
            "row_count": row_count,
            "columns": columns,
        }, bytes_estimate=2048)
        full_fp = {**fp_no_schema, "schema_hash": schema_hash}
        return schema, schema_hash, full_fp

    def op_preview(self, req: dict) -> dict:
        path_str = req["path"]
        n = int(req.get("n", 100))
        # Phase 6 (6.A.1): optional offset lets the inspector page rows
        # by re-asking with offset advanced past the loaded window. Default
        # 0 preserves the original "first n rows" contract.
        offset = int(req.get("offset", 0))
        # Phase 6 (6.D extension): optional inspector_filters thread the
        # webview's ephemeral filter set through to the daemon. When
        # present, the preview goes through DuckDB so the table window
        # matches the filtered chart aggregate. When absent, the fast
        # iter_batches path is preserved (current behavior).
        inspector_filters = req.get("inspector_filters") or []
        if inspector_filters and not isinstance(inspector_filters, list):
            raise ValueError("inspector_filters must be a list")
        path = resolve_workspace_path(self.workspace_root, path_str)
        with query_budget(
            timeout_s=float(req.get("timeout_s", DEFAULT_TIMEOUT_S)),
            peak_rss_mb=int(req.get("peak_rss_mb", DEFAULT_PEAK_RSS_MB)),
        ):
            if inspector_filters:
                # Compile each filter into a SQL WHERE fragment using the
                # SAME compiler the aggregate path uses, so the semantics
                # of e.g. `>=` / `contains` stay consistent between the
                # chart and the table.
                schema, schema_hash, full_fp = self._resolve_schema_with_hash(path)
                # Audit M-32 (2026-05-11): cache filtered previews so
                # scrolling under the same filter set doesn't re-scan
                # parquet on every page-flip. Key includes filters
                # (sorted-canonical) + offset + n so different windows
                # don't collide.
                prev_cache_key = make_cache_key(
                    file_path=str(path), fingerprint=full_fp,
                    plan={
                        "op": "preview_filtered",
                        "inspector_filters": inspector_filters,
                        "offset": int(offset),
                        "n": int(n),
                    },
                )
                # Cache stores Arrow bytes (large windows) OR JSON rows
                # (small windows < 256KB Arrow). The auxiliary total entry
                # is keyed only on (path, filters) so the scrollbar total
                # survives across pages of the same filter set.
                total_key = make_cache_key(
                    file_path=str(path), fingerprint=full_fp,
                    plan={"op": "preview_filtered_total",
                          "inspector_filters": inspector_filters},
                )
                cached_payload = self.cache.get(prev_cache_key)
                if cached_payload is not None:
                    cached_total = self.schema_cache.get(total_key)
                    total = int(cached_total["total"]) if cached_total else 0
                    if isinstance(cached_payload, bytes):
                        return {
                            "binary": cached_payload,
                            "data": {
                                "cached": True, "filtered": True,
                                "n": _arrow_row_count(cached_payload),
                                "bytes": len(cached_payload),
                                "total": total,
                            },
                            "encoding": "arrow",
                        }
                    # JSON path: cached_payload is the serialized rows dict.
                    return {
                        "data": {
                            "cached": True, "filtered": True,
                            "rows": cached_payload["rows"],
                            "n": cached_payload["n"],
                            "total": total,
                        },
                        "encoding": "json",
                    }
                ddb_path = str(path).replace("'", "''")
                if path.suffix.lower() == ".parquet":
                    from_clause = f"parquet_scan('{ddb_path}')"
                elif path.suffix.lower() in (".csv", ".tsv"):
                    from_clause = f"read_csv_auto('{ddb_path}')"
                else:
                    raise ValueError(f"unsupported file extension: {path.suffix}")
                where_sql, where_params = _compile_inspector_filters_to_sql(
                    inspector_filters, schema,
                )
                # COUNT(*) for the virtualized scrollbar total + the
                # paged rows in a single round-trip via a CTE.
                total_sql = (
                    f"WITH filtered AS (SELECT * FROM {from_clause}{where_sql}) "
                    f"SELECT (SELECT COUNT(*) FROM filtered) AS total, * "
                    f"FROM filtered LIMIT {int(n)} OFFSET {int(offset)}"
                )
                cursor = self.conn.execute(total_sql, where_params)
                arrow_table = cursor.to_arrow_table()
                if arrow_table.num_rows > 0:
                    total = int(arrow_table.column("total")[0].as_py())
                    table = arrow_table.drop_columns(["total"])
                else:
                    # Past-EOF: total is still needed for the scrollbar.
                    count_only = self.conn.execute(
                        f"SELECT COUNT(*) FROM {from_clause}{where_sql}",
                        where_params,
                    ).fetchone()
                    total = int(count_only[0]) if count_only else 0
                    # Need schema columns for an empty table — pull from
                    # the unfiltered preview which is cheap.
                    table = reader.read_preview(path, n=1, offset=0).schema.empty_table()
                resp = self._wrap_arrow_or_json(table)
                resp.setdefault("data", {})["total"] = total
                resp["data"]["filtered"] = True
                # M-32 (2026-05-11): persist to cache so a second page-flip
                # under the same filter set hits memory instead of DuckDB.
                # Both Arrow (large) and JSON (small) encodings cache.
                if resp.get("encoding") == "arrow":
                    self.cache.put(prev_cache_key, resp["binary"],
                                   bytes_estimate=len(resp["binary"]))
                else:
                    # JSON path: cache just the rows + n. Estimate size from
                    # serialized length so the cache eviction stays honest.
                    rows = resp["data"].get("rows", [])
                    payload = {"rows": rows, "n": resp["data"].get("n", len(rows))}
                    size_estimate = len(json.dumps(payload, default=str))
                    self.cache.put(prev_cache_key, payload,
                                   bytes_estimate=size_estimate)
                self.schema_cache.put(total_key, {"total": total},
                                      bytes_estimate=64)
                return resp
            # Unfiltered fast path.
            table = reader.read_preview(path, n=n, offset=offset)
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

        # Phase 6 (6.A.3): inspector-side ephemeral filters arrive in
        # `inspector_filters` and are prepended to `spec.transforms` at
        # compile time. They are NOT merged into the saved spec — the
        # webview state owns them, and they evaporate on close. Sending
        # them through the same compile path means the daemon's existing
        # filter handling does all the work and the cache key still
        # invalidates correctly (the prepended filters become part of
        # the planned spec we hash on).
        inspector_filters = req.get("inspector_filters") or []
        if inspector_filters:
            if not isinstance(inspector_filters, list):
                raise ValueError("inspector_filters must be a list")
            # Audit M-19 (2026-05-11): validate the filter shape AND
            # column-presence in the spec's dataset BEFORE splicing
            # into transforms. The prior code only checked
            # `kind == 'filter'`; bad columns surfaced later inside
            # `_compile_filter` with confusing "column not in available
            # set" errors. Resolve the schema here so the column-name
            # gate uses the AUTHORITATIVE schema, not a transform-
            # intermediate column set.
            schema_for_validate, _h, _fp = self._resolve_schema_with_hash(path)
            known_cols = set(schema_for_validate.names)
            for f in inspector_filters:
                if not isinstance(f, dict) or f.get("kind") != "filter":
                    raise ValueError(
                        "inspector_filters entries must be FilterTransform dicts"
                    )
                col = f.get("column")
                if not isinstance(col, str) or col not in known_cols:
                    raise ValueError(
                        f"inspector_filters column={col!r} not in dataset schema"
                    )
            effective_spec = {
                **spec,
                "transforms": [*inspector_filters, *spec.get("transforms", [])],
            }
        else:
            effective_spec = spec

        # Audit finding #5 (TOCTOU): cache key uses the full fingerprint
        # (mtime + size + ctime + schema_hash). A file replaced with same
        # mtime but different size or ctime invalidates the cache. Schema
        # is fetched via _resolve_schema_with_hash so repeat hits don't
        # re-read parquet metadata (AF29).
        schema, schema_hash, full_fp = self._resolve_schema_with_hash(path)
        cache_key = make_cache_key(
            file_path=str(path), fingerprint=full_fp, plan=effective_spec,
        )
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {
                "binary": cached,
                "data": {"cached": True, "n": _arrow_row_count(cached), "bytes": len(cached)},
                "encoding": "arrow",
            }

        compiled = compile_spec(effective_spec, schema, str(path))

        with query_budget(
            timeout_s=float(req.get("timeout_s", DEFAULT_TIMEOUT_S)),
            peak_rss_mb=int(req.get("peak_rss_mb", DEFAULT_PEAK_RSS_MB)),
        ):
            # Megaudit MAJOR-11: drop the silent `hasattr` fallback to
            # the deprecated `fetch_arrow_table`. We pin DuckDB to a
            # version that supports `to_arrow_table` (modern API);
            # missing the method means the dependency is too old and
            # we'd rather fail loudly than silently use deprecated
            # behavior whose semantics may diverge.
            cursor = self.conn.execute(compiled.sql, compiled.params)
            arrow_table = cursor.to_arrow_table()

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
        schema, _schema_hash, full_fp = self._resolve_schema_with_hash(path)
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
        # Audit finding #5 (TOCTOU): cache key uses the full fingerprint
        # (mtime + size + ctime + schema_hash). See op_aggregate for rationale.
        cache_key = make_cache_key(
            file_path=str(path), fingerprint=full_fp,
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

    def op_column_stats(self, req: dict) -> dict:
        """Phase 6 (6.A.2): summary stats for one column, used by the
        inspector's filter widgets.

        Returns a JSON envelope with shape:
          {
            "kind": "numeric" | "temporal" | "string" | "bool" | "nominal",
            "cardinality": int,         # distinct value count, capped
            "min": <value>?,            # numeric/temporal only
            "max": <value>?,            # numeric/temporal only
            "distinct": [...]?,         # low-cardinality (<=20) only
            "null_count": int,
          }

        `cardinality` is computed via `COUNT(DISTINCT col) LIMIT 21`-style
        capping; if more than `DISTINCT_CAP` distinct values exist, the
        UI should fall back to a text-contains filter rather than the
        dropdown checkbox list.

        Cached by `(file fingerprint, column)` so a second open of the
        same widget on the same file is free.
        """
        path_str = req["path"]
        column = req["column"]
        if not isinstance(column, str) or not column:
            raise ValueError("column must be a non-empty string")
        path = resolve_workspace_path(self.workspace_root, path_str)
        schema, schema_hash, full_fp = self._resolve_schema_with_hash(path)
        if column not in schema.names:
            # Use a structured kind so the TS side can surface a typed error.
            raise ValueError(f"column '{column}' not in schema for {path.name}")

        cache_key = make_cache_key(
            file_path=str(path),
            fingerprint=full_fp,
            plan={"op": "column_stats", "column": column},
        )
        cached = self.schema_cache.get(cache_key)
        if cached is not None:
            return {"data": {**cached, "cached": True}, "encoding": "json"}

        field = schema.field(column)
        kind = _classify_arrow_type(field.type)
        DISTINCT_CAP = 20

        # DuckDB reads parquet/csv directly; quote the column to handle
        # spaces / special chars / duplicate-suffix names.
        ddb_path = str(path).replace("'", "''")
        col_q = '"' + column.replace('"', '""') + '"'
        if path.suffix.lower() == ".parquet":
            from_clause = f"parquet_scan('{ddb_path}')"
        elif path.suffix.lower() in (".csv", ".tsv"):
            from_clause = f"read_csv_auto('{ddb_path}')"
        else:
            raise ValueError(f"unsupported file extension: {path.suffix}")

        with query_budget(
            timeout_s=float(req.get("timeout_s", DEFAULT_TIMEOUT_S)),
            peak_rss_mb=int(req.get("peak_rss_mb", DEFAULT_PEAK_RSS_MB)),
        ):
            # Null count + distinct cardinality (capped) in one round-trip.
            row = self.conn.execute(
                f"SELECT COUNT(*) AS total, "
                f"SUM(CASE WHEN {col_q} IS NULL THEN 1 ELSE 0 END) AS nulls "
                f"FROM {from_clause}"
            ).fetchone()
            total = int(row[0])
            null_count = int(row[1] or 0)

            distinct_rows = self.conn.execute(
                f"SELECT {col_q} FROM {from_clause} "
                f"WHERE {col_q} IS NOT NULL "
                f"GROUP BY {col_q} ORDER BY {col_q} LIMIT {DISTINCT_CAP + 1}"
            ).fetchall()
            distinct_values = [r[0] for r in distinct_rows]
            cardinality_capped = len(distinct_values)
            # If we got CAP+1 back, the true cardinality is just "> CAP".
            cardinality_is_exact = cardinality_capped <= DISTINCT_CAP

            stats: dict = {
                "kind": kind,
                "cardinality": cardinality_capped,
                "cardinality_is_exact": cardinality_is_exact,
                "null_count": null_count,
                "total": total,
            }
            if cardinality_is_exact:
                stats["distinct"] = [_jsonify_scalar(v) for v in distinct_values]

            if kind in ("numeric", "temporal") and total - null_count > 0:
                mn, mx = self.conn.execute(
                    f"SELECT MIN({col_q}), MAX({col_q}) FROM {from_clause} "
                    f"WHERE {col_q} IS NOT NULL"
                ).fetchone()
                stats["min"] = _jsonify_scalar(mn)
                stats["max"] = _jsonify_scalar(mx)

        self.schema_cache.put(cache_key, stats, bytes_estimate=512)
        return {"data": {**stats, "cached": False}, "encoding": "json"}

    def op_capabilities(self, req: dict) -> dict:
        """
        Report the daemon's capabilities. Step 5.G.1: the webview's
        transform menu MUST be generated from this list so unsupported
        variants are never offered. Mirrors `compiler.py`'s actual
        accept set; if the compiler grows to accept new kinds, this
        list must be updated in lockstep.

        Returns:
          {
            "daemon_version": 1,
            "transform_kinds": [...],     # what the compiler accepts
            "unsupported": [...],         # documented gaps the TS
                                          # validator already gates,
                                          # listed here so the UI can
                                          # show explanatory tooltips
            "chart_families": [...],
          }
        """
        return {
            "data": {
                "daemon_version": 1,
                "transform_kinds": [
                    "filter",
                    "date_trunc",
                    "bin",
                    "groupby",
                    "aggregate",
                    "window",
                    "math",
                    "tz_convert",
                    "sort",
                    "limit",
                ],
                "unsupported": [
                    # Variants the TS validator rejects; listed for
                    # documentation so the UI can show "(not yet
                    # implemented)" tooltips next to the relevant menu
                    # items.
                    "window.fn=ema",
                    "bin.strategy=equal_freq",
                    "resample",
                ],
                "chart_families": ["timeseries", "general"],
                # Phase 6 (6.A.4): feature flags so the inspector UI can
                # detect whether the daemon is new enough to support the
                # ops it depends on. Old daemons (pre-Phase 6) won't
                # advertise these and the inspector toggle stays disabled.
                "inspector": {
                    "preview_offset": True,
                    "column_stats": True,
                    "aggregate_filters": True,
                },
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
        "capabilities": "op_capabilities",
        # Phase 6 (6.A.2): column-stats op for inspector filter widgets.
        "column_stats": "op_column_stats",
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
        except SecurityError as e:
            elapsed = (time.perf_counter() - t0) * 1000
            # Megaudit MAJOR-34: include structured `error_kind` so the
            # extension can map to the protocol's typed errorKind
            # ('security' / 'compile' / 'timeout' / 'memory') without
            # parsing the message string.
            return ({"id": req.get("id"), "ok": False,
                     "error": f"SecurityError: {e}",
                     "error_kind": "security",
                     "elapsed_ms": elapsed}, None)
        except CompileError as e:
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False,
                     "error": f"CompileError: {e}",
                     "error_kind": "compile",
                     "elapsed_ms": elapsed}, None)
        except TimeoutError_ as e:
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False,
                     "error": f"TimeoutError: {e}",
                     "error_kind": "timeout",
                     "elapsed_ms": elapsed}, None)
        except MemoryLimitError as e:
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False,
                     "error": f"MemoryLimitError: {e}",
                     "error_kind": "memory",
                     "elapsed_ms": elapsed}, None)
        except MemoryError as e:
            # Megaudit-2 A4-C1: Python's built-in MemoryError (raised
            # by the interpreter when an allocation fails — e.g.
            # arrow/duckdb cannot grow a result table) inherits from
            # Exception. Without this branch it falls into the generic
            # 'internal' handler and the user sees "InternalError:
            # MemoryError" with a stack trace, conflating real bugs
            # with capacity issues.
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False,
                     "error": f"MemoryError: {e}",
                     "error_kind": "memory",
                     "elapsed_ms": elapsed}, None)
        except (KeyboardInterrupt, SystemExit):
            # Megaudit MAJOR-10: never swallow these — they MUST
            # propagate so the daemon shuts down cleanly.
            raise
        except Exception as e:
            # Megaudit MAJOR-10: previously a broad `except Exception`
            # converted programming bugs (NameError, AttributeError)
            # into "InternalError" responses, allowing the daemon to
            # limp along instead of crashing and triggering a clean
            # respawn. Still catch (we promised the lifecycle a
            # response per request), but log the full traceback to
            # stderr AND flag with `error_kind: 'internal'` so the
            # extension can distinguish from user-fixable errors.
            traceback.print_exc(file=sys.stderr)
            elapsed = (time.perf_counter() - t0) * 1000
            return ({"id": req.get("id"), "ok": False,
                     "error": f"InternalError: {type(e).__name__}: {e}",
                     "error_kind": "internal",
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
            # Audit-fix AF28: an outbound payload exceeding MAX_FRAME_BYTES
            # would otherwise crash the daemon mid-loop. Catch IPCError so
            # the per-request error is delivered as a normal op failure
            # and the daemon continues serving subsequent requests.
            try:
                write_json(out, response)
                if binary is not None:
                    write_arrow(out, binary)
                out.flush()
            except IPCError as e:
                # Build an error-shaped JSON response that fits.
                err_resp = {
                    "id": response.get("id"),
                    "ok": False,
                    "error": f"IPCError: outbound frame failed: {e}",
                    "elapsed_ms": response.get("elapsed_ms", 0.0),
                }
                try:
                    write_json(out, err_resp)
                    out.flush()
                except IPCError:
                    # If even the error response is too big (impossible but
                    # defensive): we have no way to inform the client, so
                    # close the connection -- the caller's pending promise
                    # will reject with DaemonClosedError.
                    return

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


def _classify_arrow_type(t: pa.DataType) -> str:
    """Phase 6 (6.A.2): map a pyarrow DataType to the inspector's
    column-kind taxonomy so the UI can pick the right filter widget.

       numeric  — int*/uint*/float*/decimal
       temporal — timestamp*/date32/date64/time*
       bool     — bool
       string   — utf8/large_utf8/string/binary
       nominal  — dictionary, regardless of value type (low-cardinality by
                  construction; the UI treats it like a checkbox set even
                  when the dictionary values are numeric)

    Unknown / nested types fall back to "string" so the widget still
    renders something; the filter just becomes inert until we add
    explicit support.
    """
    if pa.types.is_dictionary(t):
        return "nominal"
    if (
        pa.types.is_integer(t)
        or pa.types.is_floating(t)
        or pa.types.is_decimal(t)
    ):
        return "numeric"
    if (
        pa.types.is_timestamp(t)
        or pa.types.is_date(t)
        or pa.types.is_time(t)
    ):
        return "temporal"
    if pa.types.is_boolean(t):
        return "bool"
    return "string"


def _compile_inspector_filters_to_sql(
    filters: list[dict], schema: "pa.Schema",
) -> tuple[str, list]:
    """Phase 6 (6.D extension): compile a list of `FilterTransform` dicts
    into a DuckDB WHERE clause + positional params.

    Input shape matches `op_aggregate`'s `inspector_filters` AND what the
    TS provider's `inspectorFiltersToFilterTransforms` emits:

      {kind: 'filter', column, op, value}

    Supported ops mirror `compiler._compile_filter`:

      ==, !=, <, <=, >, >=   — comparison (value is scalar)
      in, not_in             — set membership (value is non-empty list)
      is_null, not_null      — null check (no value)
      contains               — case-insensitive substring (value is string)
                               Phase 6 addition; the inspector's text
                               filter widget compiles to this op.

    The filter `column` is validated against the schema's known names
    before quoting; a typo can't become an arbitrary SQL identifier.

    Returns ('', []) when no filters present.
    """
    if not filters:
        return "", []
    known = {f.name for f in schema}
    parts: list[str] = []
    params: list = []
    for i, f in enumerate(filters):
        if not isinstance(f, dict):
            raise ValueError(f"inspector_filters[{i}] must be an object")
        if f.get("kind") != "filter":
            raise ValueError(
                f"inspector_filters[{i}].kind must be 'filter' (got {f.get('kind')!r})"
            )
        col = f.get("column")
        if not isinstance(col, str) or col == "" or col not in known:
            raise ValueError(
                f"inspector_filters[{i}].column='{col}' not in schema"
            )
        col_q = '"' + col.replace('"', '""') + '"'
        op = f.get("op")
        value = f.get("value", None)
        if op in ("is_null", "not_null"):
            parts.append(f"{col_q} IS {'NULL' if op == 'is_null' else 'NOT NULL'}")
        elif op in ("in", "not_in"):
            if not isinstance(value, list) or len(value) == 0:
                # Empty `in` matches nothing; empty `not_in` matches
                # everything. Empty-set shape is short-circuited up at
                # the provider, but defensively handle it here too.
                parts.append("FALSE" if op == "in" else "TRUE")
                continue
            placeholders = ",".join(["?"] * len(value))
            sql_op = "IN" if op == "in" else "NOT IN"
            parts.append(f"{col_q} {sql_op} ({placeholders})")
            params.extend(value)
        elif op in ("==", "!=", "<", "<=", ">", ">="):
            sql_op = {"==": "=", "!=": "<>"}.get(op, op)
            parts.append(f"{col_q} {sql_op} ?")
            params.append(value)
        elif op == "contains":
            if not isinstance(value, str):
                raise ValueError(
                    f"inspector_filters[{i}].value must be a string for op=contains"
                )
            if value == "":
                continue
            # Audit M-H + M-16 (2026-05-11): escape LIKE metacharacters
            # (`%`, `_`, `\`) so user input is literal, then let DuckDB
            # `lower()` case-fold BOTH sides to avoid Python/DuckDB ICU
            # divergence on non-ASCII (Turkish I, German ß, etc.).
            escaped = (
                value
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            parts.append(f"lower(CAST({col_q} AS VARCHAR)) LIKE lower(?) ESCAPE '\\'")
            params.append(f"%{escaped}%")
        else:
            raise ValueError(f"inspector_filters[{i}].op={op!r} not supported")
    if not parts:
        return "", []
    return " WHERE " + " AND ".join(f"({p})" for p in parts), params


def _jsonify_scalar(v: Any) -> Any:
    """Coerce a DuckDB-returned scalar to a JSON-serializable value.

    DuckDB returns native Python types for most columns, but timestamps
    come back as `datetime.datetime`. JSON can't carry datetime, so we
    isoformat them; the TS side parses with `Date.parse`. Bytes-typed
    columns (rare for inspector filters) coerce to repr.

    Audit M-22 (2026-05-11): Python's json module emits `NaN`/`Infinity`
    as literal `NaN`/`Infinity` tokens which strict JSON parsers (incl.
    JavaScript's `JSON.parse`) reject. Coerce non-finite floats to None
    before they reach the wire; the column-stats consumer treats null
    min/max as "no usable bound" and degrades the widget gracefully.
    """
    import datetime as _dt
    import math
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, str)):
        return v
    if isinstance(v, float):
        if not math.isfinite(v):
            return None
        return v
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.hex()
    # Decimal etc. — DuckDB hands these back; str() preserves precision.
    return str(v)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _set_address_space_cap_mb(cap_mb: int) -> None:
    """Megaudit M-9 defense-in-depth: hard-cap the daemon's virtual
    address space at startup so a memory-bomb query that bypasses the
    post-hoc peak-RSS check is killed by the kernel before consuming
    arbitrary memory. Only available on POSIX (resource module). The
    cap is generous (16 GB by default) — well above any realistic
    qviz workload but bounded.

    Megaudit-2 A4-m8: on Darwin (macOS), RLIMIT_AS is supported by the
    `resource` module but the kernel does NOT enforce it for many
    allocation paths -- mmap'd files (pyarrow's primary IO) and JIT
    allocations slip through. We still set the limit (it catches naive
    `malloc()` storms in C extensions) but log a one-line note on
    macOS so operators don't assume the cap is authoritative there.
    The watchdog (peak-RSS check via `resource.getrusage`) is the
    actual guarantee on Darwin.
    """
    try:
        import resource  # POSIX only
    except ImportError:
        return  # Windows: rely on watchdog only
    if sys.platform == "darwin":
        sys.stderr.write(
            "INFO: RLIMIT_AS on macOS does not cover mmap/JIT allocations; "
            "the peak-RSS watchdog is the authoritative memory guard here.\n"
        )
    cap_bytes = cap_mb * 1024 * 1024
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        # Don't widen an existing tighter limit; only ratchet down to
        # cap_bytes if the current limit is unlimited or higher.
        if hard == resource.RLIM_INFINITY or hard > cap_bytes:
            resource.setrlimit(resource.RLIMIT_AS, (cap_bytes, cap_bytes))
        elif soft < hard and soft < cap_bytes:
            resource.setrlimit(resource.RLIMIT_AS, (cap_bytes, hard))
    except (ValueError, OSError) as e:
        sys.stderr.write(
            f"WARN: could not set RLIMIT_AS to {cap_mb}MB: {e}\n"
        )


def main() -> None:
    # Megaudit-2 A4-C2: verify DuckDB version BEFORE doing anything else so
    # the failure mode (bad wheel) is reported by the very first stderr line.
    _check_duckdb_version()
    workspace_root = os.environ.get("QUANTLAB_WORKSPACE_ROOT")
    if not workspace_root:
        sys.stderr.write("ERROR: QUANTLAB_WORKSPACE_ROOT env var is required\n")
        sys.exit(2)
    cap_mb_str = os.environ.get("QUANTLAB_DAEMON_RLIMIT_MB", "16384")
    try:
        cap_mb = int(cap_mb_str)
        if cap_mb > 0:
            _set_address_space_cap_mb(cap_mb)
    except ValueError:
        sys.stderr.write(
            f"WARN: QUANTLAB_DAEMON_RLIMIT_MB={cap_mb_str!r} not an int; skipping cap\n",
        )
    daemon = Daemon(workspace_root)
    daemon.run()


if __name__ == "__main__":
    main()
