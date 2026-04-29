"""Spike B benchmark — drives query_daemon.py over stdio and measures latencies."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

DAEMON = Path(__file__).parent / "query_daemon.py"
PARQUET = Path("/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet")
PYTHON = "/Users/sanzhar/.quantlab/venv/bin/python"


def round_trip(proc, request: dict) -> dict:
    line = json.dumps(request) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    response = proc.stdout.readline()
    return json.loads(response)


def bench():
    cold_start_t0 = time.perf_counter()
    proc = subprocess.Popen(
        [PYTHON, str(DAEMON)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )
    # Read ready banner
    banner = json.loads(proc.stdout.readline())
    cold_start_ms = (time.perf_counter() - cold_start_t0) * 1000
    print(f"COLD START: {cold_start_ms:.1f} ms (banner: {banner})")

    nxt_id = [0]
    def request(op, **kwargs):
        nxt_id[0] += 1
        return {"id": nxt_id[0], "op": op, **kwargs}

    # 1. Ping (sanity)
    r = round_trip(proc, request("ping"))
    print(f"\nPING:        {r['elapsed_ms']:.2f} ms (server-side)")

    # 2. Schema (cold)
    r = round_trip(proc, request("schema", path=str(PARQUET)))
    print(f"\nSCHEMA cold: {r['elapsed_ms']:.2f} ms (server-side)  rows={r['data']['row_count']:,}")
    assert r["data"]["columns"][0]["name"] == "timestamp"

    # 3. Schema (warm — should hit cache)
    r = round_trip(proc, request("schema", path=str(PARQUET)))
    print(f"SCHEMA warm: {r['elapsed_ms']:.2f} ms  cached={r['data']['cached']}")

    # 4. Preview 100 rows
    r = round_trip(proc, request("preview", path=str(PARQUET), n=100))
    print(f"\nPREVIEW 100: {r['elapsed_ms']:.2f} ms  rows={r['data']['n']}")

    # 5. Aggregate: groupby day, sum volume
    spec = {
        "transforms": [{"kind": "date_trunc", "col": "timestamp", "unit": "day", "as": "day"}],
        "groupby": ["day"],
        "agg": [{"col": "volume", "fn": "sum", "as": "vol_sum"},
                {"col": "close", "fn": "mean", "as": "close_avg"},
                {"col": "returns", "fn": "std", "as": "ret_std"}],
        "order_by": "day",
    }
    r = round_trip(proc, request("aggregate", path=str(PARQUET), spec=spec))
    print(f"\nAGG cold:    {r['elapsed_ms']:.2f} ms  rows_out={r['data']['n']}  bytes={r['data']['bytes']:,}")

    # 6. Same aggregate (cache hit)
    r = round_trip(proc, request("aggregate", path=str(PARQUET), spec=spec))
    print(f"AGG warm:    {r['elapsed_ms']:.2f} ms  cached={r['data']['cached']}")

    # 7. Histogram: bin returns into 50 buckets, count
    hist_spec = {
        "transforms": [{"kind": "bin", "col": "returns", "n_bins": 50, "as": "bin_idx"}],
        "groupby": ["bin_idx"],
        "agg": [{"col": "returns", "fn": "count", "as": "cnt"}],
        "order_by": "bin_idx",
    }
    r = round_trip(proc, request("aggregate", path=str(PARQUET), spec=hist_spec))
    print(f"\nHISTOGRAM:   {r['elapsed_ms']:.2f} ms  bins={r['data']['n']}")

    # 8. Decimate 1M points → 3000 visible (LTTB)
    r = round_trip(proc, request("decimate", path=str(PARQUET), x_col="timestamp", y_col="close", n_visible=3000))
    print(f"\nDECIMATE LTTB: {r['elapsed_ms']:.2f} ms  in={r['data']['n_input']:,}  out={r['data']['n']}")

    # 9. Decimate (warm)
    r = round_trip(proc, request("decimate", path=str(PARQUET), x_col="timestamp", y_col="close", n_visible=3000))
    print(f"DECIMATE warm: {r['elapsed_ms']:.2f} ms  cached={r['data']['cached']}")

    # 10. Bytes summary — what's the total transfer cost for a typical interactive session?
    # An aggregated histogram bin response is tiny vs. raw 1M rows.
    print("\nMessage size sanity:")
    print(f"  raw 1M-row close column ~ 8 MB binary, JSON ~ 25-30 MB")
    print(f"  histogram 50 bins        ~ 1.5 KB JSON")
    print(f"  decimated 3000 points    ~ 90 KB JSON")

    proc.stdin.close()
    proc.wait(timeout=2)
    print("\nDONE")


if __name__ == "__main__":
    bench()
