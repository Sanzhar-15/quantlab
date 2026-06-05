# FE-1 latency shootout harness

Headless benchmark of the Python↔engine per-edit round-trip — the **FE-1 latency kill-gate**
(`<100ms` median single edit, `<200ms` median 1000-cell batch). Result + analysis:
`quantlab/quantlab/docs/fe/2026-06-05-fe-1-latency-shootout.md` (**GATE CLEARED, 2026-06-05**).

## Legs

| Script | Transport / topology | Build needed |
|---|---|---|
| `crates/ql-bindings-node/tests/latency_napi.mjs` | napi, engine-in-Node (baseline floor) | `cargo build -p ql-bindings-node --release` |
| `crates/quantbook-py/tests/latency_pyo3.py` | in-process PyO3, engine-in-Python (lower bound) | `cargo build -p quantbook-py --release` |
| `crates/quantbook-py/tests/latency_service.py` | ql-service HTTP, standalone | `cargo build -p ql-service --release` |
| `crates/quantbook-py/tests/latency_nodehost.py` (+ `…/tests/latency_node_host.mjs`) | **the shipped path**: Python client → Node host owning the napi Session | `cargo build -p ql-bindings-node --release` |
| _(deferred)_ stdio-frames leg (Rust) | standalone over length-prefixed frames | not built — confirmatory only, see the doc |

`bench/latency_common.py` holds the shared workload constants + report format (the napi leg mirrors them inline).
`bench/latency_synthesis.py` tabulates every `bench/results/<leg>.json`.

## Run (Mac host — artifacts are arm64 Mach-O)

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo build -p ql-bindings-node -p quantbook-py -p ql-service --release

node crates/ql-bindings-node/tests/latency_napi.mjs          # any Node
python3.12 crates/quantbook-py/tests/latency_pyo3.py         # needs Python >= 3.10 (PyO3 abi3)
python3.12 crates/quantbook-py/tests/latency_service.py
python3.12 crates/quantbook-py/tests/latency_nodehost.py     # shipped path (spawns the node host)
python3.12 bench/latency_synthesis.py                        # comparison table
```

> The PyO3 extension needs Python ≥ 3.10 (`_Py_NewRef`); the macOS system `python3` is 3.9 — use `python3.12`.
> Overrides: `QL_NODE_CDYLIB`, `QL_PY_CDYLIB`, `QL_SERVICE_BIN`.
