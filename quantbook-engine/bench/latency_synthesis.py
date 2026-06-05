#!/usr/bin/env python3
"""FE-1 / FE-1.5-0 latency shootout — synthesis.

Collects every bench/results/<leg>.json report and renders comparison tables
(Workload A single round-trip + Workload B 1000-cell batch, p50/p95/p99 + per-stage,
with gate pass/fail). Stdlib only.

Two PATHS, two table groups, because they measure different things and must not be
conflated:
  - EDIT path     (FE-1):     set_value/write_range -> recalc -> delta.
  - REACTIVE path (FE-1.5-0): publish_dataset -> dirty dependents -> recalc -> delta.
A leg is REACTIVE iff its leg name starts with "reactive-".

Run: python3 bench/latency_synthesis.py
"""

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
# canonical display order within each path (legs that haven't run yet are skipped)
ORDER = ["napi", "pyo3", "nodehost", "stdio", "service",
         "reactive-pyo3", "reactive-nodehost", "reactive-service", "reactive-stdio"]
GATE_A, GATE_B = 100.0, 200.0
W = [18, 34, 9, 9, 9, 28, 7]
HDR = ["leg", "topology", "p50", "p95", "p99", "stages(write/recalc/delta)", "gate"]


def load():
    out = {}
    for f in RESULTS.glob("*.json"):
        r = json.loads(f.read_text())
        out[r["leg"]] = r
    return out


def row(label, *cells):
    return "  ".join(str(c).ljust(w) for c, w in zip((label, *cells), W))


def _ordered(legs):
    return [l for l in ORDER if l in legs] + [l for l in legs if l not in ORDER]


def _workload_table(title, key, gate_ms, legs, reports):
    print(title)
    print(row(*HDR))
    print("-" * (sum(W) + 2 * len(W)))
    for leg in legs:
        wl = reports[leg][key]
        sm = wl["stage_medians"]
        stages = f"{sm['write']}/{sm['recalc']}/{sm['delta']}"
        verdict = "PASS" if wl["p50"] < gate_ms else "MISS"
        print(row(leg, reports[leg]["topology"], wl["p50"], wl["p95"], wl["p99"], stages, verdict))


def _path_group(heading, legs, reports, floor_leg):
    if not legs:
        return
    print(f"\n========== {heading} ==========\n")
    _workload_table("WORKLOAD A — single round-trip x1000 (ms)", "workloadA", GATE_A, legs, reports)
    print()
    _workload_table("WORKLOAD B — 1000-cell batch x50 (ms)", "workloadB", GATE_B, legs, reports)
    # overhead view: each leg's A.p50 minus this path's in-process floor.
    if floor_leg in reports:
        floor = reports[floor_leg]["workloadA"]["p50"]
        print(f"\noverhead over the in-process floor ({floor_leg} A.p50={floor}ms):")
        for leg in legs:
            d = reports[leg]["workloadA"]["p50"] - floor
            print(f"  {leg:18} +{round(d, 4)}ms")


def main():
    reports = load()
    if not reports:
        raise SystemExit(f"no results found in {RESULTS} — run the leg scripts first.")

    print("Quantbook latency shootout — Python<->engine round-trip (gate: A.p50<100ms, B.p50<200ms)\n")
    host = next(iter(reports.values()))["host"]
    print(f"host: {host.get('platform')}  {host.get('processor')}  "
          f"py={host.get('python')} node={host.get('node')}")

    edit_legs = _ordered([l for l in reports if not l.startswith("reactive-")])
    reactive_legs = _ordered([l for l in reports if l.startswith("reactive-")])

    _path_group("EDIT PATH (FE-1): set_value/write_range -> recalc -> delta",
                edit_legs, reports, "pyo3")
    _path_group("REACTIVE PATH (FE-1.5-0): publish_dataset -> dirty dependents -> recalc -> delta",
                reactive_legs, reports, "reactive-pyo3")

    all_pass = all(
        r["workloadA"]["p50"] < GATE_A and r["workloadB"]["p50"] < GATE_B
        for r in reports.values()
    )
    print(f"\nVERDICT: {'GREENLIGHT — all measured legs clear both gates' if all_pass else 'MIXED/KILL — see misses above'}")


if __name__ == "__main__":
    main()
