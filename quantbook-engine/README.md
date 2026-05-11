# quantbook-engine

The Rust + Arrow reactive workbook engine for Quantbook (the Excel alternative built into Quantlab).

This is **Phase 0** of the 11-phase plan — a 4-week engine viability spike. The acceptance gate is in
`../.plans/_QUANTBOOK-v1-SPECIFICATION.md` (Part V §1). 13 binding items. If we hit them, we commit
to Phases 1-10 (9-12 months to v1 ship-candidate).

## Layout

```
quantbook-engine/
├── Cargo.toml                  # workspace root (24 member crates)
├── Cargo.lock                  # pinned; committed
├── rust-toolchain.toml         # stable 1.95.0 (MSRV floor 1.85 for edition2024)
├── .cargo/config.toml          # per-target SIMD floors; NEVER target-cpu=native
├── scripts/
│   ├── check-build-flags.sh    # Amendment A3 — CI gate for target-cpu=native
│   ├── bench_phase0.sh         # acceptance run wrapper (Phase 0 Week 4)
│   └── profile_phase0.sh       # perf collection
├── docs/
│   ├── phase0/                 # acceptance results, exit packet, decisions
│   └── legal/                  # provenance log (gitignored until ship-prep per CORR-10)
└── crates/
    ├── ql-types/               # Value, ErrorValue, coercion (Phase 0)
    ├── ql-storage/             # Workbook, Sheet, ColumnStore, SparseOverlay (Phase 0)
    ├── ql-formula-syntax/      # Lexer, Pratt Parser, AST (Phase 0)
    ├── ql-formula-semantics/   # Binding, resolution, dep extraction (Phase 3+)
    ├── ql-functions/           # Function registry; ~38 Phase 0 fns incl. Welford VAR/STDEV
    ├── ql-calcgraph/           # CellNode/RangeNode/FormulaRegionNode, dirty, topo, stripe (Phase 0)
    ├── ql-exec/                # ExprPlan, kernel dispatch, multiversion wrappers (Phase 0)
    ├── ql-bench/               # Synthetic gen, machine introspection, chunk-size sweep
    ├── ql-profile/             # graph-profile.json export, perf instrumentation
    ├── ql-oplog/               # Loro-backed op log + undo/redo (scaffolding in v1)
    ├── ql-terminal/            # terminal:// connector trait + mock (Phase 0)
    ├── ql-udf/                 # Python/R/SQL UDF registry (Phase 5+)
    ├── ql-sql/                 # DuckDB/DataFusion integration (Phase 8)
    ├── ql-collab/              # Loro CRDT collab manager (full Phase 9 → v1.5)
    ├── ql-connectors/          # DataSource trait + builtins (Phase 8)
    ├── ql-io/                  # Import/export traits (Phase 4)
    ├── ql-io-xlsx/             # OOXML one-way importer via calamine + quick-xml (Phase 4)
    ├── ql-io-ods/              # ODS importer (Phase 4)
    ├── ql-service/             # Daemon API: IPC, lifecycle, trust gates (Phase 6)
    ├── ql-ai/                  # AI inline + chat sidebar + eval corpus (Phase 7)
    ├── ql-bindings-wasm/       # wasm-bindgen → ES module
    ├── ql-bindings-node/       # Node-API for Electron / VS Code host
    ├── ql-bindings-c/          # cbindgen → C header for Go (Terminal connector reuse)
    └── quantbook-py/           # PyO3 binding (maturin build); INSIDE workspace
```

## Build

```bash
# Rust toolchain pinned via rust-toolchain.toml (1.95.0; MSRV floor 1.85).
cargo metadata                                  # workspace must validate
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo bench -p ql-bench --bench phase0_vector_25m -- --profile-time 1
```

## Phase 0 acceptance

13 items. See `../.plans/_QUANTBOOK-v1-SPECIFICATION.md` Part V §1. The headline:

- 25M-cell fused arithmetic hot path **≤100ms on reference target** (M3 Pro 36GB equivalent).
- Region split/merge falsifier (A1) <50ms for 10K edits.
- Arrow kernel multiversion wrapper (A2) verified by disassembly.
- `-C target-cpu=native` CI guard (A3).
- Structural graph-dump assertions (A4).
- Range-node prefix-SUM near-linear edge growth (A5).
- Welford VAR/STDEV passes NIST StRD numacc3 (A6).
- Chunk-size sweep (A7) — default change conditional on >5% win.

## Reference reads

`.references/` (gitignored) holds local clones of peer projects to read (NOT vendor):
Formualizer, IronCalc, HyperFormula, Quadratic, LibreOffice `sc/`, Gnumeric, ONLYOFFICE sdkjs.

Methodology: multi-source deep code reading per subsystem; extract load-bearing patterns; adapt to
Rust+Arrow+ipykernel+`.qbook/` stack; write our own from scratch.

## License posture

Deferred to ship-readiness. See `../.plans/_ship-readiness-legal-checklist.md`.
