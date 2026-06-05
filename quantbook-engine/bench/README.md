# Quantbook latency shootout harness

Headless benchmark of the Python↔engine round-trip. Two **paths**, two kill-gates
(`<100ms` median single round-trip, `<200ms` median 1000-cell batch):

- **EDIT path** (FE-1): `set_value`/`write_range` → `recalc` → `snapshot_delta`.
  Result: `quantlab/quantlab/docs/fe/2026-06-05-fe-1-latency-shootout.md` (**GATE CLEARED, 2026-06-05**).
- **REACTIVE path** (FE-1.5-0): `publish_dataset` → engine dirties the dependent formula cells →
  `recalc` → `snapshot_delta`. This is the moat's reactive-invalidation cost. Each iteration
  asserts the *dependent* cell (which `publish_dataset` never wrote) is in the delta — the reactive
  proof. Result: `quantlab/quantlab/docs/fe/2026-06-05-fe-1.5-0-reactive-recalc.md`.

## Legs

| Script | Path | Transport / topology | Build needed |
|---|---|---|---|
| `crates/ql-bindings-node/tests/latency_napi.mjs` | edit | napi, engine-in-Node (baseline floor) | `cargo build -p ql-bindings-node --release` |
| `crates/quantbook-py/tests/latency_pyo3.py` | edit | in-process PyO3, engine-in-Python (lower bound) | `cargo build -p quantbook-py --release` |
| `crates/quantbook-py/tests/latency_service.py` | edit | ql-service HTTP, standalone | `cargo build -p ql-service --release` |
| `crates/quantbook-py/tests/latency_nodehost.py` (+ `…/tests/latency_node_host.mjs`) | edit | **the shipped path**: Python client → Node host owning the napi Session | `cargo build -p ql-bindings-node --release` |
| `crates/quantbook-py/tests/latency_reactive_pyo3.py` | reactive | in-process PyO3 (lower bound) | `cargo build -p quantbook-py --release` |
| `crates/quantbook-py/tests/latency_reactive_nodehost.py` (+ the `publishDataset` op in `latency_node_host.mjs`) | reactive | **the shipped path** (Python → Node host → napi Session) | `cargo build -p ql-bindings-node --release` |
| _(deferred)_ stdio-frames leg (Rust) | edit | standalone over length-prefixed frames | not built — confirmatory only, see the doc |

`bench/latency_common.py` holds the shared workload constants + report format (the napi leg mirrors them inline).
`bench/latency_synthesis.py` tabulates every `bench/results/<leg>.json` into an EDIT table and a REACTIVE table
(a leg is reactive iff its name starts with `reactive-`).

## Run (Mac host — artifacts are arm64 Mach-O)

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo build -p ql-bindings-node -p quantbook-py -p ql-service --release

node crates/ql-bindings-node/tests/latency_napi.mjs                # edit · any Node
python3.12 crates/quantbook-py/tests/latency_pyo3.py               # edit · needs Python >= 3.10 (PyO3 abi3)
python3.12 crates/quantbook-py/tests/latency_service.py            # edit
python3.12 crates/quantbook-py/tests/latency_nodehost.py           # edit · shipped path (spawns the node host)
python3.12 crates/quantbook-py/tests/latency_reactive_pyo3.py      # reactive · lower bound
python3.12 crates/quantbook-py/tests/latency_reactive_nodehost.py  # reactive · shipped path
python3.12 bench/latency_synthesis.py                              # EDIT + REACTIVE tables
```

> The PyO3 extension needs Python ≥ 3.10 (`_Py_NewRef`); the macOS system `python3` is 3.9 — use `python3.12`.
> Overrides: `QL_NODE_CDYLIB`, `QL_PY_CDYLIB`, `QL_SERVICE_BIN`.
