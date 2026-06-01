# Phase 6.5 — SQL surface + connectors (`ql-sql`, `ql-connectors`) — entry plan

**Status:** STARTED 2026-06-01. 6.5-0 (`write_range` substrate) + 6.5-1 (`ql-sql` DataFusion +
`materialize_query`, SQL-6-01/02) SHIPPED. NEXT = 6.5-2 (provenance reverse-index + `refresh_source`).

Master plan §6.5 (`docs/MASTER-PLAN.md`): SQL over sheets/tables, external refresh, credentials
boundary, Arrow interop, explicit dependency invalidation. Acceptance: **SQL-6-01** query table/sheet ·
**SQL-6-02** materialize result to sheet · **SQL-6-03** refresh dirties dependents · **CONN-6-01**
CSV/local connector · **CONN-6-02** errors visible. Effort 1–2 wk.

The contract froze at 6.3-5; the reserved §3.5 bulk methods (`write_range`, `publish_dataset`,
`bind_range`, `refresh_source`, `materialize_query`) and their DTOs (`WriteRangeResult`, `PublishedRef`,
`BoundRange`, `DirtyResult`) already exist with locked signatures (`ql-session/src/{session,dto}.rs`).
6.5 flips the `not_implemented` stubs (`ql-exec/src/session.rs`) to real impls **without changing any
signature** — no contract re-freeze.

## Locked decisions (2026-06-01, with the user)
- **SQL engine = DataFusion** (`datafusion =53.1.0`, workspace-pinned). Requires arrow `^58.0.0` = exact
  match to the workspace `arrow =58.3.0` pin → sheet/table Arrow columns feed straight into `MemTable`s,
  no second arrow version, no pin-guard break. Pure Rust. Off-hot-path (T1-D03 keeps Arrow kernels on
  the hot path; SQL is not the hot path). Matches the `ql-sql` stub's "planned path".
- **Connector scope (v1) = CSV + Parquet local-file connectors** behind a uniform credentials-aware
  `DataSource` trait. CSV reuses `ql-io-csv`; Parquet via arrow/parquet (no new heavy dep). **DuckDB-attach
  / Postgres (network + bundled C++) deferred to v1.5 behind the same trait** (adding bundled DuckDB would
  reintroduce the C++ build DataFusion was chosen to avoid; a network credentials boundary is a far larger
  security surface). Terminal connector is product-side (GAP-PS-08).
- **Refresh = full provenance reverse-index** — typed per-cell provenance (`source_id` + `revision`) +
  a `source_id → produced cells` index, wiring the reserved `Event::Provenance{addr,source}` into a typed
  structure. `refresh_source` is revision-gated and dirties exactly the dependents of a source's produced
  cells.

## Decomposition
- **6.5-0 — `write_range` substrate.** SHIPPED 2026-06-01. The bulk rectangular literal write every
  materialize path builds on. Validates the rectangle (inverted / out-of-grid / `1<<20` cap / exact shape,
  loud `bad_argument` pre-mutation) then lowers to one `SetValue` op per cell and applies via `batch` →
  ONE `Op::BatchCommit` (one undo unit), one version bump, dirties dependents. `Blank` clears. 10 tests
  (`write_range_*` in `ql-exec/src/session.rs`). No new deps/crates. ql-exec 812/0 (default + xlsx-write).
  **Audit lesson:** the first impl looped `rt.set_value` under `with_runtime` (op-log attached) → N
  per-cell commits / N undo units — a Codex HIGH (the Opus lane under-rated it as "pre-existing"). Fixed by
  delegating to `batch`. The regression guard is `write_range_is_one_batch_commit_and_undo_reverts_whole_range`.
- **6.5-1 — `ql-sql` (DataFusion) + `materialize_query`.** SHIPPED 2026-06-01. New `ql-sql` crate
  (member-only; PURE deps `datafusion`(features=["sql"]) + `arrow-array/schema/select` + `tokio` +
  `thiserror` — **NO** ql-session/ql-storage/ql-exec, so reusable + acyclic): `run_sql(tables, sql,
  max_rows)` registers each named RecordBatch as a MemTable, runs the SQL on a DEDICATED OS thread
  (current-thread tokio `block_on` there), case-preserving identifiers, returns one concatenated
  RecordBatch. `materialize_query` (ql-exec): parse `data={"sql":..}`, `build_sql_tables` (tables by
  display name + sheets by A1-letter columns over effective bounds, per-column type inference
  Float64/Boolean/Utf8), run, `record_batch_to_cell_values`, write the result block at target top-left
  via the 6.5-0 `write_range` substrate. SQL-6-01 + SQL-6-02. ql-sql 12 tests + 10 materialize/write
  tests; ql-exec 822/0. **Deep 3-lane megaudit (Codex + 2 Opus): 4 HIGHs folded** — (H1) DataFusion's
  default `SQLOptions` allow `COPY ... TO`/DDL/SET = arbitrary file write (Opus-B reproduced it) ->
  `sql_with_options` with ddl/dml/statements=false; (H2) `run_sql`'s `block_on` panics inside the
  ql-service async runtime -> dedicated OS thread (also isolates DataFusion panics -> `SqlError::Panicked`);
  (H3) unbounded result -> `df.limit(max+1)` + `MAX_SQL_RESULT_ROWS`; (H4) unbounded input -> per-source
  `MAX_SQL_INPUT_CELLS` pre-build cap. MEDIUM: table/sheet name collision -> loud `bad_argument` (was
  silent shadow). **Provenance is NOT recorded in 6.5-1 (deferred fully to 6.5-2)** — the earlier "begin
  provenance recording" note was dropped; 6.5-2 designs recording into materialize_query. Cargo.lock
  staged WITH the feat (datafusion + arrow-shared tree; arrow stays single-version 58.3.0).
- **6.5-2 — provenance reverse-index + `refresh_source`.** Typed provenance + `source_id→cells` index;
  typed `Event::Provenance`; revision-gated `refresh_source` re-runs the producer, re-materializes via the
  substrate, dirties dependents → `DirtyResult`. SQL-6-03.
- **6.5-3 — `ql-connectors` (CSV + Parquet).** Uniform credentials-aware `DataSource` trait (pattern ref:
  `.references/formualizer/.../backends/csv.rs`); CSV wraps `ql-io-csv`; Parquet via arrow/parquet.
  Connectors register as refreshable sources. CONN-6-01 + CONN-6-02 (loud errors; No-Fallbacks).
- **6.5-4 — binding exposure + golden parity.** Bind `writeRange`/`materializeQuery`/`refreshSource` over
  napi + pyo3 + ql-service (flip the Capability stubs); extend the golden parity matrix.
- **6.5-5 — closure megaudit + 6.5 exit.** 3-lane megaudit; MASTER-PLAN / this doc / session-api sync.

`publish_dataset` + `bind_range` are the **6.4** Python `qb.publish()`/`qb.bind()` surface — out of 6.5
scope; they stay Capability stubs (revisit in a 6.4 follow-up). They share the 6.5-0 `write_range`
substrate, so they remain cleanly implementable later.

## Standing process
Builds/tests/commits on the Mac host via `mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH && cd <engine> && …'`
(login shell starts at $HOME; cargo is not on the default login PATH). ql-exec must keep its prior tests
passing (was 802; 6.5-0 → 812). ql-service/quantbook-py are member-only. Parity under
`/opt/homebrew/bin/python3.12`. Pre-commit formats only staged files. Codex (high, read-only) + fresh Opus
per increment; independently verify any HIGH before acting.
