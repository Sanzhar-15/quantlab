"""FE-1-0/FE-1-1 latency shootout — shared workload + reporting contract (Python legs).

Imported by latency_pyo3.py, latency_service.py, latency_stdio.py so all three drive
the IDENTICAL workload and emit comparable report JSON. The napi leg
(latency_napi.mjs) mirrors these same constants inline (it is the only JS leg).

The kill-gate (docs/fe/.../fe-1 §FE-1): an edit round-trips Python<->engine in
<100ms median / 1000 edits (Workload A); a 1000-cell batch paste in <200ms
median (Workload B). MEASURED, not assumed.

No third-party deps (stdlib only) so it runs under the Mac host's system python.
"""

import json
import platform
import statistics
import sys
import time
from pathlib import Path

# --- Workload contract (identical across all four legs) ----------------------
WARMUP_A = 100          # untimed warmup iterations (JIT/alloc/cache settle)
ITERS_A = 1000          # timed single-edit round-trips
BATCH_ROWS = 100        # Workload B range geometry: 100 x 10 = 1000 cells
BATCH_COLS = 10
BATCH_CELLS = BATCH_ROWS * BATCH_COLS
WARMUP_B = 5
ITERS_B = 50            # timed batch-paste round-trips
BATCH_BASE_ROW = 10     # batch region starts at row 10 (keeps A1/B1 dependent clear)

GATE_A_MS = 100.0       # Workload A p50 must be under this
GATE_B_MS = 200.0       # Workload B p50 must be under this


def now_ms() -> float:
    """High-resolution wall clock in milliseconds (perf_counter_ns / 1e6)."""
    return time.perf_counter_ns() / 1e6


def summarize(samples_ms):
    """p50/p95/p99/max/mean/min over a list of per-iteration totals (ms)."""
    s = sorted(samples_ms)
    n = len(s)

    def pct(p):
        # nearest-rank percentile (no interpolation) — stable for small n
        idx = min(n - 1, max(0, int(round(p / 100.0 * (n - 1)))))
        return s[idx]

    return {
        "n": n,
        "p50": round(pct(50), 4),
        "p95": round(pct(95), 4),
        "p99": round(pct(99), 4),
        "max": round(s[-1], 4),
        "min": round(s[0], 4),
        "mean": round(statistics.fmean(s), 4),
    }


def stage_medians(stage_samples):
    """stage_samples: dict[name -> list[ms]] -> dict[name -> median ms]."""
    return {k: round(statistics.median(v), 4) for k, v in stage_samples.items()}


def host_info():
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or platform.machine(),
        "python": platform.python_version(),
        "node": None,
    }


def build_report(leg, topology, a_totals, a_stages, b_totals, b_stages):
    a = summarize(a_totals)
    b = summarize(b_totals)
    report = {
        "leg": leg,
        "topology": topology,
        "host": host_info(),
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "workloadA": {**a, "iters": ITERS_A, "stage_medians": stage_medians(a_stages)},
        "workloadB": {**b, "iters": ITERS_B, "cells": BATCH_CELLS,
                      "stage_medians": stage_medians(b_stages)},
        "gates": {
            "A_p50_lt_100ms": a["p50"] < GATE_A_MS,
            "B_p50_lt_200ms": b["p50"] < GATE_B_MS,
        },
    }
    return report


def emit(report):
    """Print the report JSON to stdout AND persist to bench/results/<leg>.json."""
    text = json.dumps(report, indent=2)
    print(text)
    results_dir = Path(__file__).resolve().parent / "results"
    results_dir.mkdir(exist_ok=True)
    (results_dir / f"{report['leg']}.json").write_text(text + "\n")
    # A one-line human verdict to stderr so it shows even when stdout is captured.
    g = report["gates"]
    a = report["workloadA"]
    b = report["workloadB"]
    verdict = "PASS" if (g["A_p50_lt_100ms"] and g["B_p50_lt_200ms"]) else "MISS"
    print(
        f"[{report['leg']}] {verdict}  A.p50={a['p50']}ms (gate<{GATE_A_MS}) "
        f"A.p99={a['p99']}ms  B.p50={b['p50']}ms (gate<{GATE_B_MS})",
        file=sys.stderr,
    )
