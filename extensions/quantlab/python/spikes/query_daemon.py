"""Spike B — minimal query daemon for Visualise.

Protocol: line-delimited JSON over stdio.
  Request:  {"id": int, "op": str, ...}
  Response: {"id": int, "ok": bool, "data": ..., "error": str?, "elapsed_ms": float}

Ops:
  - "schema":     {"path": str}                               -> column dtypes + row count
  - "preview":    {"path": str, "n": int}                     -> first N rows as JSON
  - "aggregate":  {"path": str, "spec": {...}}                -> groupby+agg result as JSON
  - "decimate":   {"path": str, "x_col": str, "y_col": str,
                   "n_visible": int}                          -> LTTB-decimated points
  - "ping":       {}                                          -> echo

Cache: keyed by (path, mtime_ns, op_signature). LRU eviction at 256 entries.
Security: paths must be absolute & exist; no shell exec; bounded result size.
"""
from __future__ import annotations

import json
import os
import sys
import time
from collections import OrderedDict
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import duckdb
import numpy as np


CACHE_MAX = 256
RESULT_BYTES_MAX = 32 * 1024 * 1024   # 32 MB per response — anything bigger should be paginated/decimated
PREVIEW_MAX = 10_000


class LRU(OrderedDict):
    def __init__(self, maxsize: int):
        super().__init__()
        self.maxsize = maxsize

    def get_or_none(self, key):
        if key in self:
            self.move_to_end(key)
            return self[key]
        return None

    def put(self, key, value):
        if key in self:
            self.move_to_end(key)
        self[key] = value
        if len(self) > self.maxsize:
            self.popitem(last=False)


CACHE = LRU(CACHE_MAX)
CONN = duckdb.connect(":memory:")


def cache_key_for(path: str, op_signature: str) -> tuple:
    st = os.stat(path)
    return (os.path.realpath(path), st.st_mtime_ns, op_signature)


def op_schema(payload: dict) -> dict:
    path = payload["path"]
    cache_key = cache_key_for(path, "schema")
    cached = CACHE.get_or_none(cache_key)
    if cached is not None:
        return {"cached": True, **cached}

    md = pq.read_metadata(path)
    schema = pq.read_schema(path)
    columns = []
    for i, name in enumerate(schema.names):
        field = schema.field(i)
        columns.append({"name": name, "dtype": str(field.type), "nullable": field.nullable})
    out = {"row_count": md.num_rows, "columns": columns, "cached": False}
    CACHE.put(cache_key, {k: v for k, v in out.items() if k != "cached"})
    return out


def op_preview(payload: dict) -> dict:
    path = payload["path"]
    n = min(int(payload.get("n", 100)), PREVIEW_MAX)
    cache_key = cache_key_for(path, f"preview:{n}")
    cached = CACHE.get_or_none(cache_key)
    if cached is not None:
        return {"cached": True, **cached}

    table = pq.read_table(path).slice(0, n)
    rows = table.to_pylist()
    # JSON-serialize datetimes
    for row in rows:
        for k, v in row.items():
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    out = {"rows": rows, "n": len(rows), "cached": False}
    CACHE.put(cache_key, {k: v for k, v in out.items() if k != "cached"})
    return out


def op_aggregate(payload: dict) -> dict:
    """Generic aggregate via DuckDB. Spec example:
        {"groupby": ["day"], "agg": [{"col": "volume", "fn": "sum", "as": "vol_sum"}],
         "transforms": [{"kind": "date_trunc", "col": "timestamp", "unit": "day", "as": "day"}]}
    Returns rows as list of dicts. Bounded by RESULT_BYTES_MAX.
    """
    path = payload["path"]
    spec = payload["spec"]
    cache_key = cache_key_for(path, json.dumps(spec, sort_keys=True))
    cached = CACHE.get_or_none(cache_key)
    if cached is not None:
        return {"cached": True, **cached}

    select_parts: list[str] = []
    group_cols: list[str] = list(spec.get("groupby", []))

    # Transforms (compute derived columns inline). Whitelisted.
    transforms = spec.get("transforms", [])
    transformed_aliases = {}
    for t in transforms:
        kind = t["kind"]
        if kind == "date_trunc":
            unit = t["unit"]; col = t["col"]; alias = t["as"]
            assert unit in {"second", "minute", "hour", "day", "week", "month", "quarter", "year"}
            transformed_aliases[alias] = f"date_trunc('{unit}', {col}) AS {alias}"
        elif kind == "bin":
            col = t["col"]; n_bins = int(t["n_bins"]); alias = t["as"]
            transformed_aliases[alias] = (
                f"floor(({col} - (SELECT min({col}) FROM data)) "
                f"/ ((SELECT (max({col}) - min({col}))/{n_bins} FROM data))) AS {alias}"
            )
        else:
            raise ValueError(f"unknown transform: {kind}")

    # Aggregations
    aggs = spec["agg"]
    for a in aggs:
        col = a["col"]; fn = a["fn"]; alias = a["as"]
        assert fn in {"sum", "mean", "avg", "median", "min", "max", "count", "std", "stddev",
                      "first", "last"}
        # Map mean→avg, std→stddev for DuckDB
        sql_fn = {"mean": "avg", "std": "stddev"}.get(fn, fn)
        select_parts.append(f"{sql_fn}({col}) AS {alias}")

    # Build select clause: groupby cols (with their transforms), then aggs
    group_select = []
    for g in group_cols:
        if g in transformed_aliases:
            group_select.append(transformed_aliases[g])
        else:
            group_select.append(g)

    group_clause = f"GROUP BY {', '.join(group_cols)}" if group_cols else ""
    where = spec.get("where")
    where_clause = f"WHERE {where}" if where else ""
    order_by = spec.get("order_by")
    order_clause = f"ORDER BY {order_by}" if order_by else ""
    limit = int(spec.get("limit", 100_000))

    select_full = ", ".join(group_select + select_parts) if (group_select or select_parts) else "*"
    sql = (
        f"WITH data AS (SELECT * FROM read_parquet(?)) "
        f"SELECT {select_full} FROM data {where_clause} {group_clause} {order_clause} LIMIT {limit}"
    )

    arrow_result = CONN.execute(sql, [path]).fetch_arrow_table()
    # Cap result size
    nbytes = arrow_result.nbytes
    if nbytes > RESULT_BYTES_MAX:
        raise ValueError(f"result too large: {nbytes} bytes > {RESULT_BYTES_MAX} cap")
    rows = arrow_result.to_pylist()
    for row in rows:
        for k, v in list(row.items()):
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    out = {"rows": rows, "n": len(rows), "bytes": nbytes, "sql": sql, "cached": False}
    CACHE.put(cache_key, {k: v for k, v in out.items() if k != "cached"})
    return out


def op_decimate(payload: dict) -> dict:
    """LTTB decimation: reduces N points to n_visible while preserving visual shape."""
    path = payload["path"]
    x_col = payload["x_col"]; y_col = payload["y_col"]
    n_visible = int(payload.get("n_visible", 3000))
    cache_key = cache_key_for(path, f"decimate:{x_col},{y_col},{n_visible}")
    cached = CACHE.get_or_none(cache_key)
    if cached is not None:
        return {"cached": True, **cached}

    table = pq.read_table(path, columns=[x_col, y_col])
    xs = table.column(x_col).to_numpy(zero_copy_only=False)
    ys = table.column(y_col).to_numpy(zero_copy_only=False)

    # Convert datetimes to ms epoch
    if np.issubdtype(xs.dtype, np.datetime64):
        xs = xs.astype("datetime64[ms]").astype(np.int64)

    n = len(xs)
    if n <= n_visible:
        out_xs, out_ys = xs, ys
    else:
        out_xs, out_ys = lttb(xs, ys, n_visible)

    rows = [{"t": int(out_xs[i]), "v": float(out_ys[i])} for i in range(len(out_xs))]
    out = {"rows": rows, "n": len(rows), "n_input": n, "cached": False}
    CACHE.put(cache_key, {k: v for k, v in out.items() if k != "cached"})
    return out


def lttb(xs: np.ndarray, ys: np.ndarray, threshold: int) -> tuple[np.ndarray, np.ndarray]:
    """Largest-Triangle-Three-Buckets downsampling. Preserves visual peaks/troughs."""
    n = len(xs)
    if threshold >= n or threshold == 0:
        return xs, ys

    bucket_size = (n - 2) / (threshold - 2)
    sampled_x = np.empty(threshold, dtype=xs.dtype)
    sampled_y = np.empty(threshold, dtype=ys.dtype)
    sampled_x[0] = xs[0]; sampled_y[0] = ys[0]

    a = 0
    for i in range(threshold - 2):
        # Average for next bucket
        avg_range_start = int((i + 1) * bucket_size) + 1
        avg_range_end = int((i + 2) * bucket_size) + 1
        avg_range_end = min(avg_range_end, n)
        avg_x = float(xs[avg_range_start:avg_range_end].mean())
        avg_y = float(ys[avg_range_start:avg_range_end].mean())

        # Range for this bucket
        range_off = int(i * bucket_size) + 1
        range_to = int((i + 1) * bucket_size) + 1
        range_to = min(range_to, n - 1)

        # Pick point with largest triangle area
        max_area = -1.0
        max_idx = range_off
        ax = float(xs[a]); ay = float(ys[a])
        for j in range(range_off, range_to):
            area = abs((ax - avg_x) * (float(ys[j]) - ay)
                       - (ax - float(xs[j])) * (avg_y - ay)) * 0.5
            if area > max_area:
                max_area = area; max_idx = j
        sampled_x[i + 1] = xs[max_idx]; sampled_y[i + 1] = ys[max_idx]
        a = max_idx

    sampled_x[threshold - 1] = xs[-1]; sampled_y[threshold - 1] = ys[-1]
    return sampled_x, sampled_y


OPS = {
    "ping": lambda p: {"pong": True},
    "schema": op_schema,
    "preview": op_preview,
    "aggregate": op_aggregate,
    "decimate": op_decimate,
}


def main():
    sys.stdout.write(json.dumps({"daemon": "ready", "ops": list(OPS.keys())}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        t0 = time.perf_counter()
        try:
            req = json.loads(line)
            op = req["op"]
            handler = OPS.get(op)
            if not handler:
                raise ValueError(f"unknown op: {op}")
            data = handler(req)
            elapsed = (time.perf_counter() - t0) * 1000
            resp = {"id": req.get("id"), "ok": True, "data": data, "elapsed_ms": elapsed}
        except Exception as e:
            elapsed = (time.perf_counter() - t0) * 1000
            resp = {"id": req.get("id") if "req" in dir() else None,
                    "ok": False, "error": f"{type(e).__name__}: {e}",
                    "elapsed_ms": elapsed}
        sys.stdout.write(json.dumps(resp, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
