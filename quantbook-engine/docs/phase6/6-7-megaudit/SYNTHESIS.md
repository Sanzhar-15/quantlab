# Phase 6.7 — Phase-6 Closure Megaudit — SYNTHESIS

**Date:** 2026-06-01
**Engine HEAD audited:** `feat/quantbook-engine` @ `1e91723c9fa` (6.5 doc-sync) ← `1b50f7d7d30` (6.5 feat).
**IDE consumer:** `feat/visualise-v1` @ `552d32796d3` (pre-6.5, unchanged).
**Method:** 5 independent lanes run in parallel by hand (NOT the Cockpit), per the established phase-closure
discipline. 3 Codex lanes (`codex exec -s read-only`, `reasoning_effort=high`) + 2 fresh Opus lanes
(`general-purpose`). Raw lane output: `lane-{a,b,c}.out` (Codex, untracked) + the two Opus reports captured
below. **Every HIGH was independently verified at source by the orchestrator before any fold** — reproduced,
refuted, or reclassified. Verifications recorded inline.

## Scope decision (resolved with operator before the audit)
- **WASM/C bindings (`ql-bindings-wasm`, `ql-bindings-c`)** = v1.5 deferral (17-LOC empty placeholders; no v1
  consumer — IDE uses napi, service uses HTTP). Confirmed honest stubs (Lane E §10).
- **AI / `ql-ai`** = v2 deferral (decision-lock D3; `=AI()` is v2-aligned). No AI code written.

## Lane verdicts

| Lane | Focus | Verdict (lane) | Verdict (after orchestrator verification) |
|------|-------|----------------|-------------------------------------------|
| A (Codex) | FFI correctness (napi + pyo3) | DO-NOT-SHIP | **SHIP** — both HIGHs over-rated; reclassified LOW |
| B (Codex) | service-security (RPC/IPC) | DO-NOT-SHIP | **SHIP-WITH-FIXES** — HIGH over-rated→LOW; 1 real MED (No-Fallbacks) folded |
| C (Codex) | SQL / connectors / UDF isolation | DO-NOT-SHIP | **SHIP-WITH-FIXES** — 1 real reachable HIGH (C-H1) folded; rest unreachable/threat-model-bounded → filed |
| D (Opus) | binding-consistency + cross-repo seam | SHIP-WITH-FIXES | **SHIP-WITH-FIXES** — engine parity sound; 2 HIGH are IDE-side (filed) + engine docs folded |
| E (Opus) | docs coherence Phase 0→6 | SHIP-WITH-FIXES | **SHIP-WITH-FIXES** — no code defect; docs folded (Appendix A, exit-packet, MASTER-PLAN) |

**Overall closure verdict: SHIP-WITH-FIXES.** The shipped Phase-6 code surface is correct and secure under the
v1 threat model after ONE genuinely-reachable fix (C-H1). The engine-internal cross-transport parity
(napi/pyo3/service) is sound and the golden parity matrix is rigorous + non-vacuous (Lane D). The remaining
findings are (a) the cross-repo IDE error-code seam (filed, the 6.1C-H1 class), (b) docs drift (folded), and
(c) hardening items in surfaces that are either unreachable in v1 (connectors) or threat-model-bounded (UDF
resource isolation under self-authored-UDF + single-client-localhost) — all filed with rationale.

---

## HIGH findings — independent verification + disposition

### C-H1 — SQL `generate_series`/`range` table functions enable unbounded-compute DoS. **VERIFIED REAL (probe). FOLDED.**
`ql-sql` builds its `SessionContext` via `SessionContext::new_with_config`, which registers DataFusion's
default table functions (`generate_series`, `range`). `SQLOptions{ddl:false,dml:false,statements:false}`
blocks COPY/DDL/SET but NOT a `FROM generate_series(...)`. The workbook-input cap (`MAX_SQL_INPUT_CELLS`) only
counts registered workbook tables/sheets, and the target-aware output row cap is defeated by an aggregate
(collapses to one row).
**Verification (runtime probe, the gold standard):** a throwaway test
(`crates/ql-sql/tests/_probe_ch1.rs`, since removed) proved on the Mac host:
`SELECT COUNT(*) FROM generate_series(1,1000)` → REACHABLE (1 row); `FROM range(1,1000)` → REACHABLE;
`SELECT SUM(value) FROM generate_series(1, 5_000_000)` with row cap = 10 → **EXECUTED TO COMPLETION, cap NOT
tripped**. Scaled to `generate_series(1, 9e18)` this is unbounded CPU. Reachable via `materialize_query` over
the HTTP service AND napi/pyo3 with a trivially low barrier (a single SQL string).
**Fold:** in `run_sql_async`, after context creation, enumerate `ctx.state().table_functions()` and
`deregister_udtf` every one (robust against future DataFusion additions; ql-sql only queries the registered
in-memory workbook tables, so no table function is ever needed). + regression test asserting
`generate_series`/`range` now error.

### A-HIGH-1 — `pollEvents(u64::MAX)` returns empty page `dropped=false`. **VERIFIED OVER-RATED → LOW.**
`WorkbookSession::poll_events` (`session.rs:3138`): a cursor `>= events.len()` returns an empty page with
`next_cursor = events.len()` and `dropped=false`. This is honest for the v1 unbounded ring (nothing is ever
dropped, so `dropped=false` is correct; `next_cursor` resets so a follow-up poll recovers). `u64::MAX` is
never a cursor the engine issued; a client passing it gets an empty page — no corruption, no silent data loss.
**Disposition:** LOW consistency item — reject the obvious `u64::MAX` sentinel like other u64 ids do. **Filed**
(not a ship-blocker).

### A-HIGH-2 — `registerFunction(FunctionImplHandle(u64::MAX))` accepted + dispatched. **VERIFIED OVER-RATED → LOW.**
`FunctionRegistry.udf_handles` (`registry.rs:494`) stores the handle opaquely and dispatch forwards `handle.0`
to the worker. **Verification:** `u64::MAX` is NOT a reserved sentinel anywhere in the registry/dispatch path
(the `u64::MAX` at `payload.rs:136` is an unrelated `call_id`; `registry.rs:233`'s `u64::MAX` is a different
exhaustion-counter boundary). A large opaque handle reaching the worker is benign — if the worker has no
function under it, the call fails loud. No demonstrated harm.
**Disposition:** LOW consistency item (reject `u64::MAX` for uniformity). **Filed.**

### B-01 — body caps "bypassable" on bodyless routes (chunked/no-Content-Length). **VERIFIED OVER-RATED → LOW.**
Bodyless routes (`recalc`, `begin-transaction`, `undo`, `redo`, `start-recalc`, …) receive `Limited::new(body,
limit)` but never poll it. **Verification (source):** the byte cap bounds *our* allocations on routes that READ
the body; bodyless routes never read it, so there is nothing to bound — no memory-exhaustion vector. The
Content-Length preflight (`router.rs:173`) already rejects declared-large bodies on EVERY route; the only
uncovered case is a chunked body to a bodyless route, which is simply ignored (hyper closes an undrained
keep-alive connection rather than reusing it — no smuggling, no unbounded buffering by our code).
**Disposition:** LOW hardening/doc-accuracy (optionally reject `Transfer-Encoding` on bodyless routes; the
comment at `router.rs:168-172` overstates "the cap must bind EVERY route"). **Filed.**

### C-H2 / C-H3 — connector path traversal + CSV read-before-cap OOM. **VERIFIED LATENT (unreachable in v1) → v1.5.**
**Verification (source + grep):** `ql-connectors` has ZERO consumers — no `.rs` file anywhere imports
`ql_connectors`; no crate (ql-exec / bindings / service) depends on it; `refresh_source` re-runs the stored
**SQL query** (provenance `data`), not a connector. The CSV/Parquet `DataSource` connectors are a standalone
library awaiting a consumer. Independently corroborated by Lane E (E-1). Therefore the raw-`PathBuf` traversal
(C-H2) and CSV `fs::read`-before-limit OOM (C-H3) are not reachable from any untrusted boundary in v1.
**Disposition:** **v1.5 must-fix-before-wiring** (when the connector surface is wired + network connectors
land). Filed with that gate. Also a docs finding (the exit-packet over-claims connector integration — folded).

### C-H4 — UDF timeout kill reaps only the direct child, not grandchildren. **VERIFIED REAL; threat-model-bounded → v1.5/pre-multi-client.**
`process.rs` kills only the direct `python -m quantbook.worker` child; a grandchild it spawned (e.g.
`subprocess.Popen`) is reparented and survives. **Verification (source):** confirmed at `process.rs:110-114`
(reparenting note) + the kill path. **Threat model:** in v1 the UDF is the user's OWN Python (the wedge:
user-authored signal), and the service is single-client localhost. A user's UDF leaking a grandchild is a
resource-cleanup gap affecting the user's own host, not cross-tenant escalation. **Disposition:** MED
hardening — file for v1.5/pre-multi-client (process-group/job-object kill of the whole tree).

### C-H5 — UDF worker output: unbounded `mpsc` channel + 64 MiB-per-frame allows a hostile worker to flood memory. **VERIFIED REAL; threat-model-bounded → v1.5/pre-multi-client.**
**Verification (source):** `MAX_FRAME_LEN = 64 MiB` (`frame.rs:88`), unbounded `mpsc::channel()`
(`process.rs:210`); a worker streaming repeated max-size LOG frames is buffered into unbounded memory.
**Threat model:** same as C-H4 (self-authored worker, single-client localhost). **Disposition:** MED hardening
— file for v1.5/pre-multi-client (bounded channel + per-call aggregate byte budget + smaller LOG cap).

### D-H1 — engine emits `sql_error`/`sql_table_build`/`source_not_found` that the stale IDE allowlist buckets as `'unknown'`. **VERIFIED REAL (cross-repo seam, the 6.1C-H1 class). Engine side folded; IDE side FILED.**
**Verification:** the three codes are emitted at `session.rs:3409/4072/3281`; the IDE `parseQuantbookError`
allowlist (`session.ts`) lacks them → silent `'unknown'` bucketing, defeating the discriminant. This is exactly
the seam the 5-way pattern exists to catch (only a both-repos lane sees it).
**Disposition:** the ENGINE half is folded — Appendix A (`session-api.md`) gains the three codes (+ the other
emitted-but-undocumented codes, E-2). The IDE half (add to `KNOWN_QUANTBOOK_ERROR_CODE_RECORD` +
`QuantbookErrorCode` union) is a cross-repo commit on `feat/visualise-v1` — **FILED** (per the 6.1C-H1
precedent; IDE-side feature work is out of this session's engine-closure scope).

### D-H2 — IDE `types.ts` types `writeRange`/`refreshSource`/`materializeQuery` as `void` + "always 501". **VERIFIED REAL (IDE-side). FILED.**
Post-6.5 these return real DTOs and never throw `not_implemented_in_v1_core`. IDE-side fix on
`feat/visualise-v1` — **FILED** with D-H1.

---

## MED / LOW / INFO — disposition

| ID | Sev | Disposition |
|----|-----|-------------|
| B-02 | MED | **FOLDED** — `QL_SERVICE_PORT` silently defaults on `NotUnicode` (`Err(_)=>7321`); a real No-Fallbacks violation (the other 3 env readers in the same file split NotPresent vs NotUnicode). Verified at source. |
| B-03 | MED→INFO | `ct_eq` length-timing leak — already documented in-source (`auth.rs:97-99`) as an accepted stub-grade tradeoff (length is not token material). Not over-stated. **Filed (INFO).** |
| C-M1 | MED | **FOLDED** — `Credentials` derives `Debug` with `pub token` → latent secret-disclosure-via-Debug. Even though connectors are unwired, a redacted `Debug` is correct hygiene + prevents the leak when wiring lands. Verified at source. |
| C-M2 | MED | `FunctionImplHandle` is a public tuple over `u64` (not opaque at the type boundary). Design nit. **Filed.** |
| A-MED-1 | MED | Node FFI validation errors are legacy `[bad_argument]` strings vs Python's structured errors. Real binding-consistency gap; touches many Node boundary call sites. **Filed** (focused pass). |
| A-MED-2 | MED | explicit `null`/`None` for optional `undoLabel` treated as omitted. Minor. **Filed.** |
| A-LOW-1 | LOW | `handshakeTimeoutMs` fractional truncation. **Filed.** |
| D-M1 | MED | **FOLDED (docs)** — Appendix A missing `sql_error`/`sql_table_build`/`source_not_found` (= part of E-2). |
| D-M2 | MED | **FOLDED (docs)** — `session-api.md` §11/§13/header stale ("always 501", "22-step", Python "Capability-errors the 5 bulk"). Reconciled with §3.5. |
| D-M3 | MED | `ql-service` `error.rs:78` masks a `details` serialize failure with placeholder text (transport-asymmetric No-Fallbacks; latent — `BTreeMap` serialize can't fail). **Filed** (propagate as 500). |
| D-L1 / E-6 | LOW | **FOLDED (docs)** — `router.rs:45-46` module doc claims all 5 bulk routes 501 (handlers correct). |
| D-L2 | LOW | **FOLDED (docs)** — napi `materializeQuery` doc-comment omits `[sql_error]`/`[sql_table_build]`. |
| E-2 | HIGH(docs) | **FOLDED (docs)** — Appendix A incomplete vs the real emitted-code set (≥14 codes). Completed under a 6.5/6.7 amendment note. |
| E-3 | MED | **FOLDED (docs)** — exit-packet rewritten to full Phase 6 (was 6.5-only + stale `cockpit/6.5` / "ratification pending"). |
| E-4 | MED | **FOLDED (docs)** — MASTER-PLAN 6.2 header "IN PROGRESS" → COMPLETE (contradicted its own body + 3 other docs). |
| E-5 | MED | **FOLDED (docs)** — added a diagnostic-`code` vocabulary table to session-api §9 (10 `udf_*` + 4 xlsx/recompute codes are wire-observable but were unenumerated). |
| E-7 | LOW | **FOLDED (docs)** — Appendix A note that the service adapter emits transport-boundary codes (`route_not_found`, `method_not_allowed`, `payload_too_large`, `unauthorized`, `forbidden`, `session_not_found`, `operation_not_found`). |
| E-8 | LOW | **FOLDED (docs)** — MASTER-PLAN 6.6 acceptance marked v2-aligned/superseded (decision-lock D3). |
| E-9 | LOW | **FOLDED (docs)** — wasm/c stub doc comments reference the ratified v1.5 deferral. |
| E-10 | LOW | stale "NEXT = 6.2" historical markers. **Filed** (low value). |
| D-INFO-1/2 | INFO | UDF diagnostic-code comment count (8→10); Appendix A lists 3 never-emitted codes. **Folded into the E-2/E-5 doc pass.** |

## Verified-clean (positive findings, no defect)
- napi + pyo3: every public method is `catch_unwind`-guarded; release profile is `unwind` (boundary
  meaningful); DTO returns owned; Send/Sync compile-asserted (Lane A non-findings).
- ql-sql security: `sql_with_options(ddl/dml/statements=false)` confirmed (Lane C); OS-thread isolation +
  panic→`Panicked`; target-aware row cap; the COPY/CREATE-EXTERNAL/SET regression tests pass.
- ql-service: no bearer-secret leak (no `Debug` on `BearerToken`; `ServiceConfig` redacts; rejection bodies
  generic; non-Unicode env path redacted) — Lane B explicit non-finding. CSPRNG ids; idle-TTL in-use skip;
  WeakSessionStore reaper; RFC-7807 status map.
- Engine-internal cross-transport parity sound; golden parity matrix anti-vacuity-guarded + byte-gate
  non-vacuous (Lane D).
- ql-connectors: errors carry only `source_id` (never the token); Parquet schema pre-validation fails loud on
  unsupported types incl. the all-null edge; engine-limit guards before `put_at`; checked downcasts.

## Cycle accounting
Cycle 1 = this megaudit (lane briefs + parallel run + verification). Cycle 2 = the fold below + a focused Codex
re-audit of the C-H1 fix. Within the ≤2-cycle/session budget.
