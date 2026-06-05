# FE-1 latency kill-gate — transport shootout RESULT

**Date:** 2026-06-05 (window #44). **Status:** ✅ **GATE CLEARED — GREENLIGHT.**
**Authority:** `.plans/2026-06-03_fe-1-entry-plan.md` · `.plans/2026-06-01_quantbook-fe-engineering-plan.md` §FE-1 · `docs/fe/2026-06-02-fe-megaudit-SYNTHESIS.md`.
**Harness (engine repo, `feat/quantbook-engine`):** `bench/latency_common.py`, `bench/latency_synthesis.py`,
`crates/ql-bindings-node/tests/latency_napi.mjs`, `crates/ql-bindings-node/tests/latency_node_host.mjs`,
`crates/quantbook-py/tests/latency_{pyo3,service,nodehost}.py`. Raw reports: `bench/results/*.json`.

## Why this existed

The locked "fusion-first" strategy gates *all* heavy FE investment behind the **Month-6 latency kill-gate**: an edit
must round-trip Python↔engine in **<100ms median / 1000 edits** (Workload A), and a **1000-cell batch paste** in
**<200ms median** (Workload B). Below threshold, v1 collapses to a one-way `qb.show()` viewer. The number was unproven,
and the 7-lane "beyond Excel" megaudit specifically flagged the Arrow-IPC → transport → JSON → napi → `Vec<Vec<CellValue>>`
chain as the suspected bottleneck (Codex C1-A3). This shootout MEASURES it, fail-cheap, before committing weeks to FE-1/FE-2.

## Method

One identical workload driven through each candidate transport, headless (no webview/Electron). Workload A: warmup 100,
then 1000× `{ write one cell (A1, dependent B1=A1+1 so recalc does real work) → recalc_dirty → snapshot_delta(version) }`.
Workload B: 50× `{ write_range(100×10 = 1000 cells) → recalc_dirty → snapshot_delta }`. Per-stage breakdown captured
(write / recalc / delta). **Correctness-guarded** (so the numbers can't be a fast no-op): each leg asserts every timed
delta carried ≥1 changed cell AND reads back `B1 == A1+1` end-to-end + the batch corner cell — fail-loud otherwise.
The per-edit path marshals **plain dicts/JSON, not Arrow** — Arrow is for bulk `qb.show(df)`
transfer (a throughput concern for FE-1-2), not the per-edit gate. Host: **Apple M4 Max**, macOS 26.5 arm64, Node v22.21.1,
Python 3.12.13.

## Results

**Four legs measured** — including `nodehost`, the **actual shipped topology** (Python client → Node extension host that
owns the napi Session → engine), so the verdict is not an extrapolation.

```
WORKLOAD A — single-edit round-trip ×1000 (ms)            gate: p50 < 100
leg       topology            p50      p95      p99      stages w/r/d (ms)
napi      engine-in-node      0.0082   0.0096   0.0147   0.0033 / 0.0009 / 0.0038   PASS
pyo3      engine-in-python    0.0105   0.0124   0.0148   0.0053 / 0.0016 / 0.0034   PASS
nodehost  python→node-napi    0.0654   0.0789   0.1237   0.0237 / 0.0190 / 0.0227   PASS  ← the shipped path
service   standalone-http     0.1755   0.1892   0.2140   0.0617 / 0.0529 / 0.0607   PASS

WORKLOAD B — 1000-cell batch paste ×50 (ms)               gate: p50 < 200
leg       topology            p50      p95      p99      stages w/r/d (ms)
napi      engine-in-node      1.419    1.535    1.614    0.580 / 0.0005 / 0.840     PASS
pyo3      engine-in-python    0.945    1.179    1.255    0.416 / 0.0004 / 0.527     PASS
nodehost  python→node-napi    2.300    2.456    2.563    0.885 / 0.0164 / 1.396     PASS  ← the shipped path
service   standalone-http     1.367    1.469    2.402    0.492 / 0.0581 / 0.808     PASS
```

Transport overhead over the in-process floor (pyo3 A.p50 = 0.0105ms): napi ≈ 0ms · pyo3 0ms · **nodehost +0.055ms** · **service +0.165ms**.

## Verdict

**The kill-gate is cleared by ~3–4 orders of magnitude.** The engine round-trip is ~10µs; the Python language boundary
(PyO3 vs napi) adds nothing measurable; the **actual shipped path** (Python → Node-hosted napi Session, `nodehost`) is
**0.065ms** (p99 0.12ms); even a fully-decoupled **HTTP transport** over TCP loopback (3 requests/edit, keep-alive) adds
only **~0.16ms**. The feared serialization/transport chain is a **non-issue** at per-edit granularity.

**Consequence for the plan:** the transport choice is **no longer a latency decision** — all three candidates are
negligible against the budget. It becomes a pure software-engineering decision (decoupling, packaging, platform matrix,
where the single owning Session should live) to be made when FE-1.5 needs it, on engineering grounds rather than speed.

## Caveats (stated honestly)

1. **Hardware:** M4 Max is fast. Even assuming a 5× slower low-end laptop, Workload A is ~0.05–0.9ms — still ~100–1000× under budget. Not a concern.
2. **Per-edit, not bulk:** this measures the per-edit round-trip *mechanics* (the gate). Bulk `qb.show(df)` of a large
   DataFrame is an **Arrow throughput** question (FE-1-2), not measured here and not what the <100ms gate is about.
3. **Recalc is trivial here** (one dependent, B1=A1+1). A real model with thousands of dependent formulas adds **engine
   recalc compute** — that is engine recalc performance (separately benchmarked), orthogonal to the transport mechanics this gate covers.
4. **Topology now measured (was extrapolated):** the `nodehost` leg measures the *actual shipped path* (Python client →
   Node host owning the napi Session → engine) at 0.065ms — not just the clean in-process/HTTP topologies. The **choice**
   of topology (engine in Node vs Python vs standalone) remains an open *engineering* decision (see below), but all
   measured options clear the gate by ≥500×, so it is not latency-bound.

## Decisions & deferrals

- **M2 stdio-frames leg: DEFERRED (not built).** It would land between the in-process floor (0.01ms) and HTTP (0.17ms)
  and change no decision. The greenfield `ql-stdio` frame server (reusing `ql-service` `wire.rs`/`guarded.rs`) is the
  natural build *if and when* a decoupled-without-HTTP topology is chosen for FE-1.5 — defer to that point.
- **Transport/topology: OPEN engineering decision for FE-1.5**, not blocked on latency. Today's shipped topology is
  engine-in-Node (napi, the FE-2-0 grid). PyO3 (engine-in-Python) and ql-service (standalone) are both viable and fast.
- **Regression guard (follow-up):** the leg scripts already print PASS/MISS and persist `bench/results/*.json`; a thin
  CI check that exits non-zero on a gate miss would keep the gate cleared as the engine evolves. Cheap; not built yet.

## Next

FE-1's latency risk is retired. The remaining FE-1 risk lives in **FE-1.5 — reactive Python↔grid fusion** (recalc-on-var-change,
debug-from-cell, file-watch dirtying) — the actual category-definer. Per its entry plan it is HIGH-risk / multi-week /
by-hand and warrants a **fresh, deep-planned session**. This doc is the prove-or-kill artifact closing FE-1-0/FE-1-1.
