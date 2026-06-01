# Phase 6.5 Exit Packet — SQL surface + connectors (POINT X)

**Status:** SHIPPED — Phase 6.5 closure (increments 6.5-0 … 6.5-5).
**Date:** 2026-06-01
**Branch:** `cockpit/6.5` (off `feat/quantbook-engine` @ `5778ac276dd`); promote/integrate to `feat/quantbook-engine` after sign-off.

## Scope delivered

| Increment | Deliverable | Acceptance | Where |
|-----------|-------------|------------|-------|
| 6.5-0 | `write_range` bulk-write substrate | one `Op::BatchCommit`/undo unit | shipped pre-run (`feat/quantbook-engine`) |
| 6.5-1 | `ql-sql` (DataFusion) + `materialize_query` | SQL-6-01, SQL-6-02 | shipped pre-run |
| **6.5-2** | provenance reverse-index + `refresh_source` | **SQL-6-03** | this run (`ql-exec/session.rs` +709) |
| **6.5-3** | `ql-connectors` CSV + Parquet `DataSource` | **CONN-6-01, CONN-6-02** | this run (`ql-connectors/lib.rs` +708) |
| **6.5-4** | bindings: napi + pyo3 + ql-service + golden parity | byte-identical across transports | this run (3 binding files) |
| **6.5-5** | closure megaudit + this exit packet | full-stack green | this run |

6.5-2 … 6.5-4 were implemented and promoted autonomously through the Window-1 Cockpit
(`ql65-engine` run), each gated by `code_strict` (codex_forensic + claude_sonnet_breadth) strict
audit on real `cargo test` acceptance via the Mac bridge.

## Provability

Every implementation phase is PROVABLE from its receipts (`plan receipts <run> <phase>`):
- 6.5-2 PROMOTED `c038b7044d31 → 33830c559901`, audit APPROVE (cycle 1).
- 6.5-3 PROMOTED `33830c559901 → 5c76f104d49a`, audit APPROVE (cycle 0).
- 6.5-4 PROMOTED `5c76f104d49a → 4e7e1a7cb468`, audit APPROVE (cycle 0).
- 6.5-5 closure at `cockpit/6.5` HEAD (this packet + the closure fix below).

## Forensic findings caught + closed (codex_forensic)

The strict audit caught and the run repaired several real correctness bugs:
- 6.5-2: per-cell provenance (`cell → {source_id, revision}`) was missing; `refresh_source`
  dirty-ordering mutated before success; undo/redo left refresh provenance outside the
  rematerialized session state; per-cell ownership could go stale / clobber another source's
  last-writer. **All fixed.**
- 6.5-3: unsupported Parquet/arrow column types (Date32/Timestamp/Decimal/Binary/Dictionary)
  were silently imported as the *type name* string (incl. the all-null-column edge case), violating
  CONN-6-02 No-Fallbacks. **Fixed — unsupported types fail loud (`ConnectorError`).**

## Closure validation + fix (6.5-5)

Full-stack validation at the integration head (`4e7e1a7cb468`) surfaced one latent defect that
6.5-4's build-only acceptance had missed:
- `crates/ql-service/tests/cluster_e_http.rs::cluster_e_reserved_bulk_all_501` asserted all five
  §3.5 reserved bulk methods return 501, but 6.5-4 exposed three over HTTP. **Fixed** (renamed
  `cluster_e_reserved_bulk_methods_v1`): write-range → 200, materialize-query (no `sql`) → 400
  `bad_argument`, refresh-source (unknown source) → 404 `source_not_found`, publish-dataset /
  bind-range → 501 `not_implemented_in_v1_core`. `cargo test -p ql-service` green (40+ tests).
- The 6.5-stack packages (`ql-exec`, `ql-sql`, `ql-connectors`, `ql-bindings-node`, `quantbook-py`,
  `ql-service`) all pass on the integrated head.

**Caveat (pre-existing, not a 6.5 regression):** `cargo test --workspace` shows 11 `ql-io-xlsx`
`calamine_smoke` failures of kind "No such file or directory" — fixture files absent in a fresh
worktree (present in the canonical checkout). Orthogonal to Phase 6.5; flagged for the test-fixture
provisioning backlog.

## Sign-off

POINT X (6.5-5) reached. Phase 6.5 SQL-surface + connectors is functionally complete and
provable; the remaining product-side connectors (DuckDB-attach / Postgres) are the locked v1.5
deferral. Operator ratification pending before integration to `feat/quantbook-engine`.
