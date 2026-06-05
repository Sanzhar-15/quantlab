#!/usr/bin/env python3
"""FE-1-0/FE-1-1 latency shootout — synthesis.

Collects every bench/results/<leg>.json report and renders one comparison table
(Workload A single-edit + Workload B 1000-cell batch, p50/p95/p99 + per-stage,
with gate pass/fail). Stdlib only.

Run: python3 bench/latency_synthesis.py
"""

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
# canonical display order (legs that haven't run yet are simply skipped)
ORDER = ["napi", "pyo3", "nodehost", "stdio", "service"]
GATE_A, GATE_B = 100.0, 200.0


def load():
    out = {}
    for f in RESULTS.glob("*.json"):
        r = json.loads(f.read_text())
        out[r["leg"]] = r
    return out


def row(label, *cells, widths=None):
    return "  ".join(str(c).ljust(w) for c, w in zip((label, *cells), widths))


def main():
    reports = load()
    if not reports:
        raise SystemExit(f"no results found in {RESULTS} — run the leg scripts first.")

    legs = [l for l in ORDER if l in reports] + [l for l in reports if l not in ORDER]
    w = [10, 18, 9, 9, 9, 28, 7]

    print("FE-1 latency shootout — Python<->engine round-trip (gate: A.p50<100ms, B.p50<200ms)\n")
    host = next(iter(reports.values()))["host"]
    print(f"host: {host.get('platform')}  {host.get('processor')}  "
          f"py={host.get('python')} node={host.get('node')}\n")

    hdr = ["leg", "topology", "p50", "p95", "p99", "stages(write/recalc/delta)", "gate"]
    print("WORKLOAD A — single-edit round-trip x1000 (ms)")
    print(row(*hdr, widths=w))
    print("-" * (sum(w) + 2 * len(w)))
    for leg in legs:
        a = reports[leg]["workloadA"]
        sm = a["stage_medians"]
        stages = f"{sm['write']}/{sm['recalc']}/{sm['delta']}"
        gate = "PASS" if a["p50"] < GATE_A else "MISS"
        print(row(leg, reports[leg]["topology"], a["p50"], a["p95"], a["p99"], stages, gate, widths=w))

    print("\nWORKLOAD B — 1000-cell batch paste x50 (ms)")
    print(row(*hdr, widths=w))
    print("-" * (sum(w) + 2 * len(w)))
    for leg in legs:
        b = reports[leg]["workloadB"]
        sm = b["stage_medians"]
        stages = f"{sm['write']}/{sm['recalc']}/{sm['delta']}"
        gate = "PASS" if b["p50"] < GATE_B else "MISS"
        print(row(leg, reports[leg]["topology"], b["p50"], b["p95"], b["p99"], stages, gate, widths=w))

    # transport-overhead view: each transport's A.p50 minus the in-process floor.
    if "pyo3" in reports:
        floor = reports["pyo3"]["workloadA"]["p50"]
        print(f"\ntransport overhead over the in-process floor (pyo3 A.p50={floor}ms):")
        for leg in legs:
            d = reports[leg]["workloadA"]["p50"] - floor
            print(f"  {leg:8} +{round(d, 4)}ms")

    all_pass = all(
        r["workloadA"]["p50"] < GATE_A and r["workloadB"]["p50"] < GATE_B
        for r in reports.values()
    )
    print(f"\nVERDICT: {'GREENLIGHT — all measured transports clear both gates' if all_pass else 'MIXED/KILL — see misses above'}")


if __name__ == "__main__":
    main()
