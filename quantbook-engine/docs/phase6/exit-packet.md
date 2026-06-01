# Phase 6 (Product Surfaces) — Exit Packet

**Status:** SHIPPED — Phase 6 functionally complete (6.1 … 6.5; 6.6 deferred to v2).
**Date:** 2026-06-01
**Branch:** `feat/quantbook-engine` @ `1e91723c9fa` (6.5 doc-sync) ← `1b50f7d7d30` (6.5-2..6.5-5 feat).
**Closure audit:** the Phase-6.7 by-hand closure megaudit (5 lanes; `docs/phase6/6-7-megaudit/SYNTHESIS.md`)
returned **SHIP-WITH-FIXES**; the verified findings are folded (below) or filed (Known follow-ups).
**Consumer:** IDE `feat/visualise-v1` @ `552d32796d3` (pre-6.5; the cross-repo sync items below are filed
against it).

Phase 6 took the frozen-v1 engine and exposed it as a product across multiple transports. One engine contract
(`EngineSession`, 53 methods), many consumers.

## Scope delivered (per sub-phase)

| Sub-phase | Deliverable | Acceptance | Verdict |
|-----------|-------------|------------|---------|
| **6.1** | Stable session API + owning `WorkbookSession` + napi `Session` | API6-01/02/03; 6.1C 5-way security megaudit | COMPLETE |
| **6.2** | `ql-service` — engine-as-service over HTTP/1.1 + SSE (hyper) | SVC-6-01..04; all 53 methods reachable byte-identical to napi/pyo3 | COMPLETE |
| **6.3** | Bindings — Node (napi) + Python (pyo3 thin facade); **contract FROZEN v1** | golden parity matrix byte-identical on ≥2 rows | COMPLETE (WASM/C = v1.5) |
| **6.4** | Python UDFs — `register/unregister/list_function` + out-of-process worker | UDF-6-01..04; type matrix; sandbox doc | COMPLETE |
| **6.5** | SQL surface (`ql-sql`/DataFusion) + connectors (`ql-connectors`) + provenance/`refresh_source` | SQL-6-01/02/03; CONN-6-01/02 (see caveat) | COMPLETE (connector-wiring caveat) |
| **6.6** | AI (`=AI()`) | — | **DEFERRED to v2** (decision-lock D3) |

### 6.1 — Stable Session API
`docs/api/session-api.md` (API6-01/02/03; Codex-reviewed). Owning `WorkbookSession`
(`crates/ql-exec/src/session.rs`) owns Workbook + OpLog + CalcgraphSession + PlanCache + FunctionRegistry +
cancel registry + event queue; all 53 `EngineSession` trait methods. napi `Session` class. 6.1C decision-lock
mandatory 5-way security megaudit (SHIP-WITH-FIXES, folded). Lifecycle New→Ready→Busy→Closed/Faulted;
`{epoch,state_seq}` version token; FaultGuard panic-seal.

### 6.2 — `ql-service` (HTTP + SSE)
Member-only crate (not `default-members`). All 53 contract methods over `/v1` on hyper; SSE event stream;
op-id cancel/operationStatus; ECMAScript number serializer (`ryu-js` → `6` not `6.0`); pluggable auth
(`NoAuth` default localhost / `BearerToken` constant-time); CSPRNG session ids; idle-TTL reaper (in-use skip,
Weak reaper); request-body caps + schema-version echo; `guarded` panic boundary incl. the SSE loop. 3rd
"service" golden-parity row drives the canonical flow over real HTTP and asserts byte-identical-to-Node.

### 6.3 — Bindings + frozen contract
Node napi `Session` (broad surface) + a deliberately THIN pyo3 `quantbook-py` facade (golden-flow methods
only) over the SAME contract. Golden parity matrix (`crates/quantbook-py/tests/parity_matrix.py`) drives one
canonical flow through Node + Python + Service: structural parity (all three) + byte parity (Node vs Service;
Python excluded by design — pyo3 emits float `6.0`). Contract declared **FROZEN v1** at 6.3-5 on ≥2 passing
rows. **WASM + C bindings = v1.5 deferral** (decision-lock §2.8, ratified 2026-05-30): `ql-bindings-wasm` /
`ql-bindings-c` are empty reserved placeholder crates (workspace-graph fixity only); no v1 consumer (IDE uses
napi, service uses HTTP).

### 6.4 — Python UDFs (the wedge)
`register_function` / `unregister_function` / `list_function` over the §10 function-metadata substrate
(registry-driven volatility + dep-shape + `functions_used` reverse index). UDFs execute in an **out-of-process**
`python -m quantbook.worker` subprocess (`ql-udf`): Arrow-IPC codec trust boundary on worker bytes, framed
protocol, timeout/kill, panic containment at the crate boundary. `ql-udf` wired into `ql-exec` +
`default-members`. UDF-6-01..04 met; type matrix `crates/ql-exec/tests/udf_type_matrix.rs`; sandbox/threat
model `docs/security/udf-ai-connectors.md`.

### 6.5 — SQL surface + connectors + provenance
- **6.5-0** `write_range` — bulk rectangular literal write substrate (one `Op::BatchCommit`/undo unit).
- **6.5-1** `ql-sql` (PURE Arrow-in→SQL→Arrow-out via DataFusion; read-only `sql_with_options`
  ddl/dml/statements=false; dedicated-OS-thread isolation + panic→`Panicked`; target-aware row cap;
  **all default table functions deregistered — 6.7 C-H1 fix**) + `materialize_query` (SQL-6-01/02; input
  `MAX_SQL_INPUT_CELLS` aggregate cap).
- **6.5-2** dual provenance reverse-index (per-cell `{source_id,revision}` + `source→cells`) + revision-gated
  `refresh_source` re-running the stored producer query (SQL-6-03).
- **6.5-3** `ql-connectors` CSV + Parquet `DataSource` (CONN-6-01/02). **CAVEAT (6.7 E-1, verified):**
  `ql-connectors` ships as a **standalone crate with NO consumer** — it is NOT wired into the session,
  bindings, or service, and `refresh_source` re-runs an SQL query, not a connector. CONN-6-01/02 are satisfied
  at the **crate-internal unit-test level** (16 tests). Product wiring (a `load_source` command + a
  connector-backed `refresh_source`) is explicit follow-up; the path-jail / read-before-cap / credential
  hardening (6.7 C-H2/C-H3/C-M1) MUST land before that wiring (C-M1 redacted-`Debug` already folded).
- **6.5-4** binding exposure of `write_range` / `materialize_query` / `refresh_source` (NOT connectors) over
  napi + pyo3 + service + golden parity.

### 6.6 — AI: deferred to v2
`=AI()` is v2-aligned (decision-lock D3). `ql-ai` is an empty reserved crate; the `AINotAvailable` sentinel is
live in `ql-functions`. No v1 AI code. (MASTER-PLAN 6.6's AI-6-0x acceptance is superseded by D3.)

## 6.7 closure megaudit — verified findings folded this cycle

The 5-lane megaudit (3 Codex + 2 Opus) returned SHIP-WITH-FIXES. Every HIGH was independently verified at
source before action (full record + verifications in `docs/phase6/6-7-megaudit/SYNTHESIS.md`):

- **C-H1 (HIGH, verified by runtime probe) — FOLDED.** `ql-sql`'s `SessionContext` registered DataFusion's
  default table functions (`generate_series`/`range`); a `SELECT SUM(value) FROM generate_series(1, 9e18)`
  synthesizes unbounded rows outside the input cap and an aggregate defeats the row cap — an unbounded-compute
  DoS from a single SQL string, reachable via `materialize_query` over the service and napi/pyo3. Fix:
  enumerate + `deregister_udtf` every default table function (ql-sql only queries registered workbook tables).
  + 3 regression tests.
- **B-02 (MED, No-Fallbacks) — FOLDED.** `QL_SERVICE_PORT` silently defaulted on a non-Unicode value; now
  loud, matching the other three env readers.
- **C-M1 (MED, secret hygiene) — FOLDED.** `Credentials` derived `Debug` would leak the `token`; replaced with
  a redacted manual `Debug`.
- **Docs (D-M1/M2, E-2..E-9, D-L1/L2) — FOLDED in the doc-sync.** Appendix A completed against the real
  emitted-code set (+ `sql_error`/`sql_table_build`/`source_not_found` + the runtime/oplog/table codes, under
  a 6.5/6.7 amendment note); §9 diagnostic-`code` vocabulary table added; transport-boundary codes noted;
  session-api §11/§13 reconciled (refresh/materialize are live, 22→26 steps); MASTER-PLAN 6.2 header
  IN-PROGRESS→COMPLETE; 6.6 marked v2-aligned; `router.rs` + napi `materializeQuery` doc-comments + wasm/c stub
  docs corrected; this exit-packet rewritten to full phase.

## Known follow-ups (filed, with rationale — NOT v1 ship-blockers)

- **Cross-repo IDE sync (D-H1, D-H2 — the 6.1C-H1 seam class).** The engine emits
  `sql_error`/`sql_table_build`/`source_not_found` (now in Appendix A); the IDE `parseQuantbookError`
  allowlist (`session.ts` on `feat/visualise-v1`) lacks them → silently buckets as `'unknown'`. And IDE
  `types.ts` still types `writeRange`/`refreshSource`/`materializeQuery` as `void` + "always 501" (stale
  post-6.5). **Fix on `feat/visualise-v1`:** add the 3 codes to `KNOWN_QUANTBOOK_ERROR_CODE_RECORD` + the
  `QuantbookErrorCode` union; retype the 3 methods to their real DTOs. (Engine side is correct; this is an
  IDE-repo commit, out of this session's engine-closure scope per the 6.1C precedent.)
- **Connector wiring + hardening (C-H2, C-H3 → v1.5).** When the `ql-connectors` `DataSource` surface is wired
  to a consumer (and network connectors land): path-jail/canonicalize + reject symlinks/devices/absolute-escape
  (C-H2); stream/byte-cap CSV before allocation + reject non-regular files (C-H3). Latent today (no consumer).
- **UDF resource isolation (C-H4, C-H5 → v1.5 / pre-multi-client).** Kill the whole worker process tree on
  timeout (grandchildren survive today); bound the worker-output channel + per-call byte budget + smaller LOG
  cap. MED under the v1 threat model (self-authored UDF + single-client localhost); HIGH if the service is
  exposed multi-client.
- **Consistency/polish (filed):** reject `u64::MAX` sentinel for cursor/impl-handle (A-HIGH-1/A-HIGH-2,
  reclassified LOW); Node FFI validation errors → structured like Python (A-MED-1); reject explicit
  null/None-as-omitted (A-MED-2); `handshakeTimeoutMs` fractional truncation (A-LOW-1); `ql-service`
  `error.rs:78` propagate the `details`-serialize failure loudly (D-M3); make `FunctionImplHandle` opaque at
  the type boundary (C-M2); reject `Transfer-Encoding` on bodyless service routes (B-01, LOW).

## Test state (post-fold)

- ql-exec `--lib` **836/0** (default; + `--features xlsx-write`).
- ql-sql **19/0** (16 prior + 3 new C-H1 regression tests).
- ql-connectors **17/0** (16 prior + 1 new C-M1 redaction test).
- ql-service **40+/0** (member-only `-p`), incl. `cluster_e_reserved_bulk_methods_v1`.
- Golden parity matrix (python3.12): PARITY OK (Node==Python==Service structural; Node==Service byte).
- clippy: 0 new on all touched crates.

**Known pre-existing caveat (orthogonal, not a Phase-6 regression):** `cargo test --workspace` shows 11
`ql-io-xlsx` `calamine_smoke` "No such file or directory" failures — fixture files absent in a fresh worktree.
Flagged for the test-fixture-provisioning backlog.

## Phase-6 deliverables checklist (MASTER-PLAN)

`entry-plan.md` ✅ · `decision-lock.md` ✅ · `session-api.md` ✅ (frozen + 6.5/6.7 amendments) ·
`docs/security/udf-ai-connectors.md` ✅ · `6-7-megaudit/SYNTHESIS.md` ✅ · `exit-packet.md` ✅ (this).
