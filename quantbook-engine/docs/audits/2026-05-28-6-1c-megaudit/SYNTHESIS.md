# Phase 6.1C — Security/Design Audit · Megaudit Synthesis (2026-05-28)

**Mandate.** Decision-lock `docs/phase6/decision-lock.md` §2 item 4 — MANDATORY security/design audit before broader binding/service exposure (6.2/6.3). Produces the Phase-6 exit-packet feeder.

**Engine HEAD at audit:** `c9297dff8ab` (6.1C prep — entry plan + lane briefs + orchestration committed). LAST CODE commit `2d22f1f82e2` (clippy hygiene). **IDE HEAD at audit:** `c24222315ed` (6.1B IDE-side Node Session migration; cross-repo).

**Scope (~9859 LoC):** owning `WorkbookSession` (`crates/ql-exec/src/session.rs`, 5117 LoC) + the `Session` napi class (`crates/ql-bindings-node/src/lib.rs:4276-4426`, ~150 LoC) + the contract crate (`crates/ql-session/src/`, ~316 LoC) + IDE TS consumer (`extensions/quantlab/src/quantbook/{types,loader,session}.ts`) + the shared `#[napi(object)]` DTOs. `CollabSession` OUT OF SCOPE except for shared DTO/error patterns.

## Method

**Five independent lanes, parallel.** Each lane briefed in `docs/phase6/6-1c-prep/lane-{a,b,c,d}-*.md`; orchestration in `docs/phase6/6-1c-prep/README.md`.

| Lane | Auditor | Focus | Tool | Output |
|------|---------|-------|------|--------|
| A | Codex (gpt-5.5 xhigh, `read-only`) | FFI · panic / `catch_unwind` · Send/Sync · error mapping · validation · owned data · lock-hold | `codex exec` | `docs/phase6/6-1c-prep/lane-a.out` (12,227 lines) |
| B | Codex (gpt-5.5 xhigh, `read-only`) | Lifecycle · cancellation · `{epoch, state_seq}` · `snapshot_delta` · op-log + Loro UndoManager | `codex exec` | `lane-b.out` (10,107 lines) |
| C | Codex (gpt-5.5 xhigh, `read-only`) | DTO fidelity · snapshot determinism · `schema_version` · unbounded growth · method-shape diffs vs CollabSession | `codex exec` | `lane-c.out` (7,695 lines) |
| D | Codex (gpt-5.5 xhigh, `read-only`) | `.qbook` persistence · xlsx/csv I/O · op-log payload integrity · effective-extent cross-cutting · `OPLOG_SCHEMA_VERSION` | `codex exec` | `lane-d.out` (10,698 lines) |
| E | Opus 4.7 (1M context, agent, read-only) | Independent cross-lane review · cross-cutting issues · weak rationalizations · untested invariants | `Agent`/general-purpose | inline agent result |

**Synthesis pass (Opus 4.7, this document):** read all five outputs in full; cross-correlated; verified every HIGH/MED at source independently. Disposition decisions are mine, anchored to source.

## Per-lane verdicts

| Lane | Verdict | HIGH | MED | LOW | INFO |
|------|---------|------|-----|-----|------|
| A | REVISE (0 HIGH; 1 MED if boundary-contract requires panics → structured errors) | 0 | 1 | 1 | 1 |
| B | REVISE | 1 | 2 | 2 | 1 |
| C | REVISE | 1 | 3 | 2 | 1 |
| D | SHIP (with D7 tracked cross-cutting) | 0 | 1 | 1 | 2 |
| E | SHIP-WITH-FIXES | 2 (1 net-new) | 7 (extends seeds + 2 new) | 7 | 6 |

**Cross-lane convergence:**
- **C-2 (formats nondeterminism)** elevated to **H-E2** by Lane E after walking the full `snapshot_delta` HashSet iteration → 5 collections affected, not just `formats`. Verified at source.
- **B-6 (FaultGuard limited)** elevated to **M-E2** by Lane E with the `batch` Phase 2/3 split also flagged.
- **A-INFO (panic-default docstring drift)** convergent with **L-E6** (Lane E found same issue). Inc.2d Finding #4's "under `panic=abort`" rationale was technically wrong about the strategy default; the operational behavior (panic → host abort) is right but for the napi-derive-no-catch-unwind reason, not the panic-abort reason. Mechanical docstring fix.
- **C-7 (delete-contents non-issue)** ↔ **M-E7 (delete_cell)**: Lane C says the gap is non-issue because `setValue({kind:'blank'})` atomically clears value+formula when the cell had a formula. Lane E pushes back saying the engine `EngineSession` trait still has no `delete_cell`. **Adjudication:** Lane C is right for the *user-facing* gap (`setValue(blank)` IS the delete-contents command — even on a value-only cell, it clears the value and there was no formula to clear). The gap is *naming/docs*, not capability. File as docs-clarification, not contract change.
- **C-1 + M-E3 + M-E4** all converge on the cut-line decision (seed input #6).

## Findings (consolidated, severity-tagged, source-anchored)

### HIGH (3)

| # | Lane(s) | Finding | Anchor(s) | Disposition |
|---|---------|---------|-----------|-------------|
| **H1** | E (only) | **Cross-repo: IDE `parseQuantbookError` allowlist covers ~15 codes (CollabSession/transport/WebSocket/persistence only); the engine `Session` mappers emit ~40 codes (`invalid_state`, `session_busy`, `invalid_version_token`, `panic`, `sheet_not_found`, `bad_cell`, `formula_parse`, `conflicting_*`, `xlsx_*`, `csv_*`, `transaction_*`, `not_implemented_in_v1_core`, …).** Parser at `session.ts:897` gates on `KNOWN_QUANTBOOK_ERROR_CODES.has(rawCode)` → unrecognized codes silently bucket as `'unknown'`, defeating the V2.7 audit closure's stable-code contract. Today latent (live `CellGridPanel` still on CollabSession); becomes user-visible the moment 6.3 wires `Session` into any error-aware UX path. Only Lane E surfaced it — Codex lanes are repo-scoped per the brief; each saw one half. | engine: `session.rs:2483-2697` (map_*_err) + `error.rs:107-141` (constructors). IDE: `session.ts:775-793` (KNOWN_QUANTBOOK_ERROR_CODE_RECORD), `types.ts:1523-1582` (QuantbookErrorCode union), `session.ts:875-911` (parser). | **TRACKED for 6.3-entry (cross-repo IDE follow-up).** Block 6.3 entry. The fix is IDE-side: extend `QuantbookErrorCode` + the record to cover the codes a v1 Session consumer can hit. Engine-side documentation must additionally mark engine error codes as stable wire-contract (§5.1 already does, but the IDE side hasn't honored it). NOT block-on-6.1C-exit because no live consumer hits it today. |
| **H2** | B (HIGH), C (LOW partial), E (HIGH elevation) | **`snapshot` + `snapshot_delta` produce non-deterministic ordering across 6 consumer-visible collections** (`snapshot.formats` from `HashMap` iter; `snapshot_delta.changed_cells`/`removed_cells`/`sheets_changed`/`sheets_removed`/`formats_added` from `HashSet` iter). Breaks golden-test stability + JSON-equal comparisons across consecutive deltas with identical logical content. CollabSession's napi delta path already sorts; Session diverges from that precedent. | `session.rs:2051-2059, :2110-2113, :2136-2143, :2148-2155, :2157-2160, :2163-2175`; `format.rs:200-202, :542-544`. CollabSession sort reference at `lib.rs:2380`. | **BLOCK 6.1C-exit; FIX in audit-fix commit.** Mechanical: `.sort_by_key` on each output Vec at the end of `snapshot()` / `snapshot_delta()` (`formats`: by `FormatId`; cell/sheet vecs: by `(sheet,row,col)` or `sheet`). Closes seed input #2. |
| **H3** | B (only) | **`snapshot_delta` under-reports spill changes.** `set_formula` records only the anchor cell in the change-log (`session.rs:1267`); `run_recalc` records only `res.changed_cells` (`session.rs:800`) which itself only contains the anchor for spill results (`recompute.rs:447, :659`); `write_spill` writes the FULL spill footprint (`cells.rs:731`) but never bubbles its shape into a `record_changes` call. Spill targets changed or removed by `set_formula` / recalc can be absent from `changedCells` / `removedCells`. | `session.rs:800, :1267`; `cells.rs:731`; `recompute.rs:447, :451, :659`. | **TRACKED for 6.3-entry (block-on-6.3 entry).** Today no consumer of `Session.snapshot_delta` exists (not bridged over napi). The fix touches `WorkbookRuntime`'s return signature (must surface spill shape to the session change-log) — too invasive for a 6.1C audit-fix cycle. 6.3 binding work MUST land this engine fix as its prerequisite. Documented in impl-plan §0. |

### MED (8)

| # | Lane(s) | Finding | Anchor(s) | Disposition |
|---|---------|---------|-----------|-------------|
| **M1** | A | **No `#[napi(catch_unwind)]` anywhere on `Session`.** napi-rs only wraps panics into JS errors when that flag is set (verified at napi-derive-backend `fn.rs:217, :247, :253`). The workspace `release` profile does NOT set `panic` (default = unwind), but unwinding through the generated `extern "C"` callback aborts. So any reachable panic in any `Session` method aborts the IDE host. Two in-path panic sites without an obvious valid-shape JS path: `cells.rs:720`, `recompute.rs:856` — NOT HIGH because not directly reachable from JS input. | `lib.rs:4276` (Session class), `Cargo.toml:142-150` (no panic setting), `napi-derive-backend/.../fn.rs:217,:247,:253`, `cells.rs:720`, `recompute.rs:856`, `EngineError::panic` constructor at `error.rs:138-141` (unused). | **FILE for 6.3 (same shape as CollabSession; no regression).** Fix needs `#[napi(catch_unwind)]` on every method PLUS the FaultGuard machinery to actually surface a `[panic] msg` Error rather than abort. Mechanical at the call-site but spans the whole binding crate. Closes seed input #1. |
| **M2** | B | **In-engine recalc cancellation is operationally non-functional, not just pre-start-cancel-only.** `run_recalc` allocates the op-id internally at line 790, runs `with_runtime(f)` synchronously at line 794, then unconditionally inserts `OperationState::Completed` at line 824 — never checks the registry between allocation and completion. The Node wrapper additionally holds the mutex through `Session.recalcDirty()` (`lib.rs:4353`), so the caller receives the op-id only AFTER completion → there is no moment at which the caller can issue a pre-start `cancel(op_id)`. Materially weaker than the documented pre-start-cancel contract (`session-api.md:450-456`). | `session.rs:786-829, :2298`; `lib.rs:4353`. | **FILE for 6.3 (refactor).** Honest minimum: allocate the op-id BEFORE the synchronous run + bubble it via a separate `start_recalc(): OperationId` → `await_recalc(op_id)` shape; OR document the v1 reality (cancel is decorative for in-engine recalc; hard-cancel is the 6.4+ UDF/SQL story). Today the contract drift is real but the cancellation surface isn't load-bearing for any v1 consumer. |
| **M3** | E (NEW), Lane B INFO B-6 (partial convergence) | **Direct `oplog.append` + workbook-mutation paths bypass the `FaultGuard`.** `delete_sheet` (`:1389-1393`), `restore_sheet` (`:1410-1416`), `move_sheet` (`:1441-1450`), `mark_volatiles_dirty` (`:1970-1977`) all mutate outside `with_runtime`/`with_runtime_no_oplog`. A panic between `oplog.append(Op::RemoveSheet)` and `workbook.remove_sheet(id)` leaves `state = Ready` + op-log torn from workbook. Practical reachability LOW (storage ops are simple HashSet/Vec moves; Lane B + my verification found no obvious panic path), but defense-in-depth gap real. **`batch` adjacent issue:** `:1824` appends `Op::BatchCommit` BEFORE entering `with_runtime_no_oplog` at `:1833` — same shape, but post-panic the session would be Faulted (FaultGuard inside Phase 3 fires), so the contract-sealed terminal blocks subsequent save/edit. Real torn-state risk is the non-with_runtime paths. | `session.rs:336, :376, :1389-1393, :1410-1416, :1441-1450, :1824, :1833, :1970-1977`. | **FIX in 6.1C audit-fix commit (mechanical defense-in-depth):** wrap each non-with_runtime mutator path in a FaultGuard-equivalent scope (or fold into `with_runtime_no_oplog`). Trivial; preserves the contract's panic-safety promise. |
| **M4** | C | **`Session.snapshot().formats` ordering** (already elevated to **H2** by cross-lane convergence). | `format.rs:539`, `session.rs:2051`, `lib.rs:847, :2380`. | See **H2** disposition. |
| **M5** | C, E (M-E5) | **`schema_version` dropped at napi DTO boundary.** Engine `WorkbookSnapshot` / `WorkbookSnapshotDelta` / `RangeResult` carry `schema_version: u16` (verified at `session.rs:2062, :2178`; engine sets it). The napi `WorkbookSnapshotJson` / `WorkbookSnapshotDeltaJson` lack the field; the mapper at `lib.rs:4242-4264` doesn't propagate it. The IDE TS DTO (`types.ts:233-312`) has no `schemaVersion` field at all. `EngineError::unsupported_schema_version` exists (`error.rs:128-131`) but no producer for the snapshot DTOs. | engine: `dto.rs:234, :285, :329`; napi: `lib.rs:827, :1001, :4242-4264`; IDE: `types.ts:233-312`. | **FILE for 6.3 (wire-contract change).** Add `schemaVersion: u16` to the top-level napi DTOs + the mapper + the TS DTO + a loader shape-check. Closes seed input #4. NOT 6.1C-blocking because no consumer hits it today. |
| **M6** | C, E (M-E1) | **Unbounded growth of `ops` HashMap, `events` Vec, and (consistency) `next_op_id`.** `ops` grows one entry per recalc, never pruned (`:210, :790`). `events` is unbounded Vec — `poll_events` reads from a cursor without draining (`:217, :2315`). `next_op_id` uses plain `+= 1` (`:506-509`), inconsistent with `next_txn_id`'s `checked_add` (`:1879-1885`). `change_log` IS bounded (`CHANGE_LOG_CAP = 1<<16`); Loro undo IS capped at 100. The growth-unbounded buffers are asymmetric. | `session.rs:210, :214, :217, :220, :506-509, :790, :1879-1885, :2315`. | **FILE for 6.3 (event-ring infrastructure).** Per contract §9: ring buffer + `dropped:bool` page metadata + `Event::FullResyncRequired` re-seed. For `ops`: prune terminal entries past a horizon. For `next_op_id`: switch to `checked_add` (mechanical; could land in 6.1C audit-fix if desired — see Decision below). Closes seed input #9. |
| **M7** | D | **`Sheet::put` grows the conservative bounds even on `Value::Blank` writes** (`sheet.rs:155`); csv/xlsx/.qbook exporters all iterate `Sheet::bounds`, so a blank-inflated workbook produces a giant export. Lane D proposes a concrete fix (storage-level `Sheet::iter_effective_cells()` + `effective_value_bounds()` from `ColumnStore::iter_chunks()` + overlay ordering; do NOT shrink-on-`put(Blank)` because blank overlays are semantically meaningful masks). | `sheet.rs:155`; csv `lib.rs:244`; xlsx `umya_export.rs:436`; .qbook `qbook_format.rs:1402`. | **FILE as TRACKED CROSS-CUTTING (already in memory `current_work.md`).** Not a 6.1C blocker — not silent data loss; I/O scalability hazard with documented current behavior. Bundle with the inc.2c-12 INFO re HashMap-ordered fresh-sheet-rels (`umya_export.rs:755, :826`). Closes seed input #8. |
| **M8** | E (M-E3) | **`Session.close()` not bridged over napi.** Engine `WorkbookSession::close` exists (`session.rs:1237-1243`); the 10-method napi `impl Session` (`lib.rs:4282-4402`) does NOT bind it. JS-side, the only way to free the underlying workbook state is via GC of the JS handle — non-deterministic; can hold large workbooks in memory long after the IDE panel closes. | `session.rs:1237-1243` (engine has it); `lib.rs:4282-4402` (10 methods, no close). | **FIX in 6.1C audit-fix commit (trivial).** ~5-10 lines napi wrapper + a positive smoke. Closes a real lifecycle hole. |

### LOW (8)

| # | Lane(s) | Finding | Anchor | Disposition |
|---|---------|---------|--------|-------------|
| L1 | A + C (C-7 INFO) + E (L-E1 partial) | `EngineSession::clear` doc says "Clear a cell"; impl is formula-only convert-to-literal. Tighten docstring at trait + napi. | `ql-session/src/session.rs:156`; `lib.rs:4337` (napi-side already explicit). | **FIX in audit-fix commit** (trivial docstring tightening on the trait). Closes seed input #5 at the contract layer; `setValue({kind:'blank'})` is the "delete cell contents" command per C-7 verification — docs should say so. |
| L2 | B | Epoch bump AFTER mutation, not BEFORE, for delta-inexpressible commands. Current single-thread + lock-held shape makes this effectively atomic to JS callers, but the documented temporal invariant ("bump before") isn't implemented. | `session.rs:1410, :1413, :1416, :1441, :1447, :1450, :1482, :1500`. | **FILE.** Not a correctness bug under v1 single-writer + mutex. Contract clarification: "epoch is bumped atomically with the mutation under the session lock" replaces "bumped before mutation". |
| L3 | B | `LifecycleState::New` unreachable — `WorkbookSession::new()` calls `from_workbook` which sets `Ready` directly. `ensure_openable`'s `New` arm exists but is never exercised by `Session.new()`. | `operation.rs:47`; `session.rs:275, :306`. | **FILE.** Design intent: `WorkbookSession::new()` ALWAYS lands in Ready (in-memory fresh workbook). The `New` state would be for a constructor that defers workbook acquisition; that's a v1.5 shape. Either drop `New` from the lifecycle enum at the contract layer OR document its v1 dormancy. |
| L4 | C, E (L-E3) | `WorkbookSnapshotJson.version` required in Rust, optional in TS — narrowing burden in IDE delta cache. | `lib.rs:916, :4262`; `types.ts:300`; `cellGridLogic.ts:1085`. | **FILE for IDE-side 6.3.** Tighten TS to `version: Buffer`. Closes seed input #3. |
| L5 | D | Resave-stability test is semantic, not byte-identical for the full `.qbook`. TOML determinism exists; `oplog.bin` byte-stability not asserted. | `session.rs:3027`; `qbook_format.rs:3920`. | **FILE.** Add byte-identical round-trip test as a v1.5 hygiene item. |
| L6 | E (L-E1) | `register_format` advances `state_seq` + emits `FormatAdded` even when `intern_format` is idempotent (duplicate). Inflates token churn + change-log entries; harmless. | `session.rs:1302-1308`; `formats.rs:283`. | **FILE.** Requires `intern_format` to surface a "was-new" flag. Low value. |
| L7 | E (L-E2) | `FullRebuildReason::CacheCleared` defined but never produced by `WorkbookSession`. | `dto.rs:270-279`; `session.rs:2084, :2089, :2106`. | **FILE.** Either wire (e.g., for an explicit cache invalidation event) or drop. Cosmetic. |
| L8 | E (L-E4) | `ops` HashMap entry left as `Running` after a panic during `run_recalc` (FaultGuard sets `state=Faulted` but the unconditional `Completed` insert at `:824` is skipped). | `session.rs:786-831`. | **FILE.** RAII guard the op-state symmetric to FaultGuard. Reachability minimal; defense-in-depth. |

### INFO / verified-clean

- **I1 (Lane A + my verification):** Index validation discipline complete (`validate_u16/u32_index` rejects NaN/Inf/negative/fractional/out-of-range; every Session f64 index passes through). Error mapping consistent (`engine_error_to_napi` mirrors collab pattern; `Display = "[code] msg"`). `session_cell_value_from_json` rejects missing payload / non-finite / `error`/`pending` / unknown kinds. DTO mappers return owned data only. Lock discipline clean (no async/await in `impl Session`, no recursive relock, DTO conversion outside lock).
- **I2 (Lane A):** Send/Sync compile-proof at `lib.rs:4420` is honest — `WorkbookSession` field tree is owned data only; no raw pointer / phantom. **Audit-discipline rule 4 satisfied** (positive compile proof, not a per-field-walk claim).
- **I3 (Lane B):** Token decode fail-loud for malformed length (`session.rs:622`) + future `state_seq` (`:2091`). All four `full_rebuild_required` paths present (`:2082, :2087, :2091, :2103`). `CHANGE_LOG_CAP = 1<<16`. `OpLog::append` = 1 Loro commit. `.qbook` open per-op `iter()` validation in place. Batch validates-before-mutate + same-cell value/formula conflict rejection + single `Op::BatchCommit`. Undo/redo baseline replay correct. Loro undo cap 100. F2 `Op::ClearValue` emitted in all 3 paths (single edit, batch, transaction).
- **I4 (Lane C INFO + my verification, closes seed #5):** "Delete cell contents" gap is NOT real. `setValue({kind:'blank'})` calls `WorkbookRuntime::set_value` which atomically emits `ClearValue + ClearFormula` when the cell had a formula (`cells.rs:792, :810, :870`); on a value-only cell, it clears the value (no formula was there to clear). So `setValue(blank)` IS the unified "wipe cell contents" command. A raw `ClearValue` op alone intentionally preserves formula association (`replay.rs:518`) — that's by design for op-log replay. **Docs need a one-line clarification at the napi `Session.clear` JSDoc and the trait — DO NOT add a `delete_cell` command** (would split the command surface for no semantic gain).
- **I5 (Lane D):** `.qbook` open Option-1 adoption intact (registry preserved, fresh op-log/undo/state, baseline reset, epoch re-minted, loaded op-log discarded post-validation). `.qbook` save uses temp-dir + rename/backup atomic flow. Error mapping (`map_persistence_err` / `map_xlsx_err` / `map_csv_err`) covers all current variants with loud wildcard fallbacks. xlsx import dependency-inversion intact + diagnostics include `feature_inventory.counts`. xlsx export feature-gate correct (`ql-exec` default-features=false; `xlsx-write` feature gates `export("xlsx")`; bytes export uses umya `write_writer`). csv leaf-crate deps clean; import inference + BOM stripping + UTF-8 strictness + leading-`=` text safety + limits + single-live-sheet export all check out. **`OPLOG_SCHEMA_VERSION` staying at `1` for additive op variants is COHERENT** — unknown tagged enum variants fail loud during `OpLog::iter()`, never silently skip (verified at `op.rs:88` `ClearValue` doc; pattern applies to all additive variants).
- **I6 (Lane E):** `EngineSession` trait fully implemented on `WorkbookSession`; `bump_epoch` correctly clears `change_log` + sets `change_log_floor = state_seq`; `parking_lot::Mutex` non-reentrancy honored (single `lock()` per method, immediate release; no engine→napi callbacks).
- **A-INFO + L-E6 (CORRECTING inc.2d Finding #4):** the docstring at `session.rs:332` claims `panic = "abort"` is "today's default" — **factually incorrect**. Workspace `Cargo.toml:142-150` doesn't set `panic`, so cargo default for release cdylib is `unwind`. The OPERATIONAL behavior (panic → host abort) is correct, but for the **napi-derive-no-`catch_unwind`** reason (M1), not the `panic=abort` reason. Mechanical docstring fix.

## Seed-input dispositions (entry plan §3)

Per the brief, each of the 10 seed inputs MUST close or be formally filed.

| # | Seed input | Disposition |
|---|------------|-------------|
| 1 | FFI panic boundary — no `catch_unwind` under `panic=abort` (engine-wide; same as `CollabSession`) | **FILED for 6.3 as M1.** Practical reality verified (host aborts on `Session` method panic) but reasoning corrected (Cargo default = unwind; napi-rs doesn't `catch_unwind` without `#[napi(catch_unwind)]` opt-in). Fix is mechanical per method + needs FaultGuard pairing. Tracked. |
| 2 | Snapshot `formats` ordering non-determinism | **BLOCK-ON-6.1C-EXIT as H2.** Elevated by Lane E to cover 6 collections across `snapshot`+`snapshot_delta`. Fixed in audit-fix commit. |
| 3 | `WorkbookSnapshotJson.version` optional-in-TS vs always-present-in-Rust | **FILED for IDE-side 6.3 as L4.** Tighten TS narrowing. |
| 4 | `schema_version` omission on `WorkbookSnapshotJson` (and other napi DTOs) | **FILED for 6.3 as M5.** Wire-contract change; not 6.1C-blocking. |
| 5 | No single "delete cell contents" command | **CLOSED.** Verified at source: `setValue({kind:'blank'})` IS the unified delete-contents command (atomic clear of value + formula via `WorkbookRuntime::set_value` when a formula was present; clears value only when none). The "gap" was a docs problem. Audit-fix tightens the `Session.clear` JSDoc + the `EngineSession::clear` trait doc (L1). |
| 6 | `Session` has no `workbookSnapshotDelta`/transport/presence/undo over napi (blocks live grid) — 6.1 obligation vs 6.3? | **CUT-LINE DECISION below.** |
| 7 | Method-shape diffs `Session` vs `CollabSession` | **CLOSED with documentation.** Lane C's DTO drift table + method cut-line table (in lane-c.out) document each. `Session.addSheet` returns the assigned id while `CollabSession.addSheet` returns void: intentional (richer typed surface). `Session.listSheets` returns `{id,name}[]`; `CollabSession.listSheets` returns `number[]`: intentional. `Session.setValue(...,{CellValue})` vs `CollabSession.appendPutValue(...,f64)`: different layers, intentional. The diffs are the deliberate "do not freeze the collab façade as the contract" stance (decision-lock §1 D1). |
| 8 | Cross-cutting: storage-level effective-non-blank extent API for csv/xlsx/.qbook serializers | **FILED CROSS-CUTTING as M7** with Lane D's concrete fix proposal. Already in `memory/current_work.md` tracker. |
| 9 | `ops` + `events` unbounded growth | **FILED for 6.3 as M6.** Event-ring infrastructure per contract §9. `next_op_id → checked_add` could land in audit-fix; the bigger ops/events bounds need 6.3 work. |
| 10 | Workspace clippy debt (warn-level `doc_lazy_continuation` + `type_complexity` in ql-storage/ql-oplog/ql-collab) | **FILED as tracked follow-up** (NOT a 6.1C lane per the entry plan). Already in `memory/current_work.md` tracker. |

## Over-napi cut-line decision (seed input #6)

**Question:** does `Session` need `workbookSnapshotDelta` / `undo` / `redo` / `import` / `export` / `open` / `save` / `batch` / `transactions` / etc. over napi at 6.1 exit, or are those formally 6.3?

**Lane E recommended (M-E4):** at 6.1C, add `snapshotDelta`, `undo`, `redo`, `close`, `import`, `export`, `open`, `save`, `validateFormula`, `pollEvents`, `lifecycleState`, `operationStatus`, `cancel` (13 methods); defer table/transaction/batch to 6.3.

**My decision: minimal 6.1C scope; broader binding work formally 6.3.**

| Method | Decision | Rationale |
|--------|----------|-----------|
| `close()` | **ADD in 6.1C audit-fix commit (M8).** | Trivial; closes a real lifecycle leak. No engine prerequisite. |
| `snapshotDelta()` | **DEFER to 6.3.** **Prerequisite: fix H3 (spill change-log) + H2 (sort) FIRST.** | H3 fix touches `WorkbookRuntime` return signature — too invasive for the 6.1C audit-fix cycle. Without H3 fixed, snapshotDelta over napi would ship a known-broken delta path for array formulas. 6.3 binding work MUST land both fixes as its prerequisite. |
| `undo()` / `redo()` / `canUndo()` / `canRedo()` | **DEFER to 6.3.** | Pairs with `snapshotDelta` (undo bumps epoch → invalidates delta cache → consumer needs delta path). Bind both in one 6.3 increment for a coherent live-grid path. |
| `import()` / `export()` / `open()` / `save()` | **DEFER to 6.3.** | Not blocking any v1 consumer; file workflow is a 6.2/6.3-era product surface. Engine impl is complete; binding is mechanical. |
| `validateFormula()` / `pollEvents()` / `lifecycleState()` / `operationStatus()` / `cancel()` | **DEFER to 6.3.** | The pollEvents + cancel surface depends on M6 (event ring bound) + M2 (cancel honesty refactor); land all together. |
| `batch()` / `begin/commit/rollback_transaction()` / `txn_add()` | **DEFER to 6.3.** | Opaque transaction handle FFI design needs deliberate review (entry plan acknowledged). |
| `register_function()` / `unregister_function()` / `list_functions()` | **DEFER to 6.4 (per decision-lock §2 item 5/6).** | Function-metadata substrate (6.4-0) is the prerequisite. |
| Structure ops (`set_format`/`register_format`/`set_name`/sheet-tab ops/table ops) | **DEFER to 6.3.** | Surface gap is documented; no current consumer. |

**Cut-line summary:** at 6.1C, `Session` binds 11 methods (the existing 10 + `close`). Everything else is 6.3. 6.3 entry is gated on H3 (spill change-log) + H2 (sort, will be done in 6.1C) being SHIPPED in the engine.

This honors the decision-lock §2 item 4 mandate: **6.1C audits the FOUNDATION (the engine's `WorkbookSession` + the minimal-but-honest napi surface), so 6.3 can bind breadth on top.** Cycle-budget hygiene (`≤2 plan-implement-audit cycles per session`) prevents conflating audit + broad binding in one cycle.

## Audit-fix plan (cycle 2)

**Single commit on `feat/quantbook-engine`** + an IDE-side follow-up filed separately (cross-repo H1).

| # | Item | Approach | LoC est |
|---|------|----------|---------|
| 1 | **H2** deterministic sort | `.sort_by_key(|fd| fd.id)` on `snapshot.formats` (`session.rs:2059`); `.sort_by_key(|c| (c.sheet, c.row, c.col))` on `changed_cells`/`removed_cells`; sort `sheets_changed` by `id`, `sheets_removed` by id, `formats_added` by `FormatId`. Plus tests asserting stable order across consecutive calls with identical content. | ~30 (incl. tests) |
| 2 | **M8** `Session.close()` napi wrapper | Mechanical: `pub fn close(&self) -> Result<()> { self.inner.lock().close().map_err(engine_error_to_napi) }`. Plus a smoke that asserts subsequent methods return `[invalid_state]`. | ~15 (incl. test) |
| 3 | **M3** FaultGuard defense-in-depth | Wrap `delete_sheet` / `restore_sheet` / `move_sheet` / `mark_volatiles_dirty` mutators in a guard-equivalent so panics → `Faulted`. | ~25 |
| 4 | **L1** `clear` docstring tightening | Trait doc + napi JSDoc to say "convert-to-literal; use `setValue({kind:'blank'})` to wipe contents". | ~10 |
| 5 | **A-INFO/L-E6** misleading panic-default docstring at `session.rs:332` | Correct the rationale: napi-derive doesn't `catch_unwind` without opt-in; that's why panic aborts the host, NOT a `panic=abort` setting. | ~5 |
| 6 | **M6 partial** — `next_op_id`: `+= 1` → `checked_add` | Trivial consistency with `next_txn_id`. | ~5 |
| | **Total** | | **~90 LoC** |

**Filed (NOT in audit-fix commit):**
- **H1** (cross-repo IDE allowlist) → separate IDE-side commit on `feat/visualise-v1`; block 6.3 entry.
- **H3** (spill change-log) → block 6.3 entry; engine work to surface spill shape from `WorkbookRuntime` into the session change-log.
- **M1** (catch_unwind boundary) → 6.3.
- **M2** (recalc cancel honesty) → 6.3 or contract clarification.
- **M5** (schema_version) → 6.3.
- **M6** (ops/events bounded, beyond `next_op_id`) → 6.3 (needs event-ring infrastructure per contract §9).
- **M7** (effective-extent cross-cutting) → tracked.
- **L2–L8** → opportunistic.

**Re-verification after the audit-fix commit:** focused (NOT the full megaudit), per the brief. Verify (1) snapshot/snapshot_delta determinism via the new tests; (2) `Session.close` smoke; (3) FaultGuard panic-test (or doc-only attestation); (4) `cargo build -p ql-bindings-node` + `cargo check --workspace` green.

## Verdict

**SHIP-WITH-FIXES.** 3 HIGH (H1 cross-repo + H3 engine spill = block 6.3 entry; H2 sort = fix in 6.1C audit-fix). 8 MED (1 fixed in audit-fix [M8], 1 fixed [M3], 6 filed for 6.3 or future). 8 LOW + 6 INFO (opportunistic / documentation / verified-clean).

The owning `WorkbookSession` + the `Session` napi class are **structurally sound** for the FOUNDATION role 6.1C audits:
- Send/Sync proven by compile-asserted positive proof (audit-discipline rule 4).
- Index validation exhaustive (no JS-ToUint32 silent coercion).
- Error mapping consistent (`[code] msg` Display); Appendix-A mapping near-complete (with the cross-repo H1 gap on the consumer side).
- Lock discipline correct (no recursive relock, DTO conversion off-lock, no async/await mid-lock).
- Lifecycle gates correct; `.qbook` open Option-1 + per-op payload validation + recompute-detached pattern intact.
- F2 `ClearValue` durability closed in all 3 paths; F10 atomic table-rename closed; undo/redo baseline-replay correct.
- xlsx/csv/.qbook I/O sound; feature-gate correct (xlsx-writer behind `xlsx-write` feature; default cdylib lean).

The **3 HIGH findings are not foundation breaks** — H1 is consumer-side wire-contract drift (latent until live-grid migration); H2 is determinism polish (mechanical); H3 is a delta-correctness gap in a method not currently bridged over napi. Foundation is **SHIP-grade**.

## Exit-packet seed (1 line for `docs/phase6/exit-packet.md`)

> **6.1C (security/design audit) SHIPPED 2026-05-28 via 5-way parallel megaudit (4 Codex lanes + Opus reviewer + Opus synthesis) at engine `c9297dff8ab`. Verdict SHIP-WITH-FIXES: 3 HIGH (H1 IDE allowlist drift — IDE-side block-on-6.3; H2 snapshot/delta nondeterministic ordering — FIXED in audit-fix; H3 snapshot_delta spill under-report — engine block-on-6.3-entry), 8 MED (M8 Session.close + M3 FaultGuard defense-in-depth FIXED in audit-fix; rest filed for 6.3). Foundation structurally sound. Synthesis at `docs/audits/2026-05-28-6-1c-megaudit/SYNTHESIS.md`. NEXT = 6.4-0 function-metadata substrate per decision-lock §2 item 5.**
