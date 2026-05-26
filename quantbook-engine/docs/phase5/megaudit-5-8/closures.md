# 5.8 Phase 5 Megaudit — Synthesis (Lane E) + Closures

**Status:** SYNTHESIS COMPLETE. Verdict carries ONE pending disposition decision (table Exit-Criterion #2) — see §6.
**Synthesized:** 2026-05-26 by the orchestrating assistant (Lane E per PLAN.md §3/§4).
**Audited at:** engine source `1465b1db4c4` (V3.6 PHASE CLEAN); the 4 lanes ran against working-tree `dfa3d113c90` (3 docs-only commits atop the source — confirmed no engine-source delta, so the audited source is correct). IDE `d028568b53b`.
**Inputs:** `lane-a.md` (Codex), `lane-b.md` (Opus), `lane-c.md` (Opus), `lane-d.md` (Opus). Raw Codex console log: `lane-a.out` (≈54k lines, local only — not committed). Codex final message: `lane-a-last.md`.

---

## 1. Headline verdict

**ZERO reachable HIGH findings across all four lanes.** Every HIGH and every MED is *latent* — gated on a producer or consumer that does not exist on the shipped collaborative surface.

| Lane | Verdict | HIGH | MED | LOW | INFO |
|---|---|---|---|---|---|
| A — Codex (empirical/convergence) | **FAIL** | 3 | 2 | 0 | 1 |
| B — Opus (risk-register/invariants) | PASS-WITH-FINDINGS | 0 | 1 | 0 | 3 |
| C — Opus (cross-sub-phase interaction) | PASS | 0 | 2 | 1 | 8 |
| D — Opus (contract/binding/deferred) | PASS-WITH-FINDINGS | 0 | 1 | 5 | 3 |

Lane A is the sole FAIL, and its FAIL rests **entirely** on the three table-convergence HIGHs (A#2/#3/#4). Those are **proven** replay-layer aborts but are **not reachable through the Phase 5 collaborative surface** (verified independently — see §3). The other three lanes — the ones that assessed reachability and scope — returned PASS / PASS-WITH-FINDINGS with 0 HIGH.

**Risk register: 38/38 entries confirmed in their claimed state (Lane B), 0 falsely-closed.**

---

## 2. Full finding inventory (every finding, no compression)

### Lane A (Codex) — adversarial empirical + CRDT convergence
- **A#1 — INFO** — Audited at working-tree `dfa3d113c90` (docs-only) not source `1465b1db4c4`. Benign: `git show` confirmed docs-only delta; audited source is correct.
- **A#2 — HIGH (LATENT)** — Concurrent same-name `CreateTable` (two peers each create table `T`): logs+caches converge, but **both** `rebuild_workbook` abort with `TableCreateRejected`. `replay.rs:1451` (`apply_create_table`). → §3: no collaborative table producer ⇒ unreachable.
- **A#3 — HIGH (LATENT)** — Concurrent `RenameTable` of different sources to same target (`A→X`, `B→X`): converge, both `rebuild_workbook` abort. `replay.rs:1030,1121`. Source comment: **"V1 LIMITATION - hard-fail."** → §3 unreachable.
- **A#4 — HIGH (LATENT)** — Concurrent `RenameColumn` of different columns to same target (`A→Z`, `B→Z`): converge, both abort with `TableColumnRejected`. `replay.rs:1227,1237`. Source comment: **"HARD-FAIL - V1 limitation."** → §3 unreachable.
- **A#5 — MED (CONVERGENT)** — Top-level `Op::Unknown(String)` forward-compat **does not exist**; `Op` uses `#[serde(deny_unknown_fields, tag="kind")]`, so unknown op kinds reject at decode (only wire *sub*-enums have `Unknown`). `op.rs:47,493`. Converges with B#4, D5-1. → §6 decision (add mechanism vs. amend contract).
- **A#6 — MED (LATENT)** — Concurrent same custom-format-id `RegisterFormat` with different strings: converge, both `rebuild_workbook` abort (`FormatRejected{IdCollision}`). `replay.rs:837,840`. → §3: no `appendRegisterFormat` producer ⇒ unreachable.

### Lane B (Opus) — risk-register + invariants
- **B#1 — MED (CONFIRMED, on shipped code)** — `export_snapshot` napi (`lib.rs:1734`, calls `snapshot_cells` at `:1757`) does **not** filter tombstoned sheets, while `workbook_snapshot` does (`is_sheet_removed` at `:2226`). Introduced by the R-V3.6-19 closure (RemoveSheet stopped pruning cells); the closure updated `workbook_snapshot` + `list_sheets_from_cache` + the delta builder but **missed `export_snapshot` and the raw `snapshot_cells` accessor**. Latent: live render path migrated to `workbookSnapshot` at V3.5.0.4b (the `exportSnapshot` TS wrapper in `session.ts:425` is legacy). Independently confirmed in §by orchestrator. → §5 cheap closure.
- **B#2 — INFO** — R-V3.6-15 `debug_assert` cited at `lib.rs:2604`; actual `2609-2617`. Doc cite drift.
- **B#3 — INFO** — R-V3.6-1 title says "on_pop" but code uses `set_on_push` + `top_undo_meta`. Doc drift.
- **B#4 — INFO (CONVERGENT)** — PLAN §2.3 lists a top-level `Op::Unknown(String)` that doesn't exist. Converges with A#5, D5-1.
- Risk register: **all 38 walked, 0 falsely-closed**; every CLOSED risk's closure code + named regression test located. 4 exit criteria verified engine-side. All engine suites pass (ql-collab 158+101, ql-oplog 67, ql-storage 199; napi clean compile ⇒ Send+Sync proven).

### Lane C (Opus) — cross-sub-phase interaction matrix (C1–C11 all traced)
- **C#1 — MED (LATENT, CONVERGENT)** — Standalone local `Op::ClearFormula`/`Op::SetCellFormat{None}` that empties a cache entry emits an **empty delta** (changedCells skips the now-`None` cell; `removed_cells` hardcoded `[]` at `lib.rs:2804`), so the IDE shared cache keeps the **stale cell**. Repro in lane-c.md. → §3: no `appendClearFormula`/`appendSetCellFormat` producer ⇒ unreachable today; **becomes a live HIGH** when V3.7+ adds a local clear/set-format write-path. Converges with D's B9 (`removedCells` always `[]`) — same code location; B9's engine-side population is the closure for C#1.
- **C#2 — MED (UX)** — Render-error misattribution (a render-time error attributed to the wrong cause in the IDE). Non-correctness; UX clarity. See lane-c.md.
- **C#5 — LOW** — Multi-sheet shared-cache test gap (V3.6.1.2 shared cache lacks a cross-sheet sibling-panel test).
- **C#3 — INFO** — Tables/names not surfaced in `workbookSnapshot` (consistent with "no producer"; lib.rs:2121-2123 documents the omission).
- **C#4 — INFO** — Release-only `debug_assert` (VV/op_count monotonicity) — not active in release builds.
- **C#6/#7/#8/#9/#10/#11 — INFO** — Confirmations: CONVERGENT-HIGH-1 closed (C3 area); format-cache×undo uses full-rebuild fallback; BatchCommit cache-walker atomic; SetDateSystem re-render; cell_op_index×undo retract via `rebuild_op_indices_only`; IDE end-to-end flow coherent.

### Lane D (Opus) — contract/binding/deferred-item/coverage
- **D5-1 — MED (CONVERGENT)** — `Op::Unknown` has no positive encode→decode→replay round-trip test. Convergent truth (with A#5/B#4): the top-level variant **does not exist** — the PLAN named it wrongly. → §6 decision.
- **D2-1 — LOW** — `CellValueJson` is a loose bag (`kind` + 4 independent `Option` payloads), not the discriminated union its docs claim, in **both** Rust and TS. Disposition: **CLOSE-NOW** (pure TS retype, zero engine change). → §5.
- **D5-2 — LOW** — No collab `merge_bytes` convergence test for MoveSheet/AddSheet/RemoveSheet/RenameSheet/PutFormula/ClearFormula (replay-level covered, but not at the collab merge layer).
- **D5-3 — LOW** — No concurrent CreateTable/ResizeTable convergence test; SetName convergence tested only at the WorkbookRuntime layer (one layer removed from the collab CRDT path).
- **D6-3 — INFO** — Stray scratch `megaudit_lane_a_tmp.rs` (Lane A's probe) — **cleaned by Codex** (verified absent post-run).
- **D3 — CLEAN** — Producer/replay validation symmetry consistent + intentional across all sheet/cell ops (producers reject out-of-range `[bad_argument]`, replay permissive no-op). No producer permissive where it should guard.
- **D6 — CLEAN** — Error taxonomy surfaces conflict/argument diagnostics via structured `errorReply` + output-channel logging; only one justified boundary swallow (format-render parse failure → `rendered=None`, documented). No improper No-Fallbacks violations in the Phase 5 surface.
- Deferred-item disposition: all STILL-VALIDLY-DEFERRED except **CellValueJson = CLOSE-NOW**. (CODEX-MED-1 malformed-only re-verified true; D7 #REF! ordering note accurate; B9/K4/sheet-tabs/DOM-patching/stable-op-ID all still validly deferred.)

---

## 3. The decisive reconciliation — why Lane A's HIGHs are LATENT, not blocking

Lane A reads Exit Criterion #2 ("tables merge deterministically") strictly: a `rebuild_workbook` that aborts is not a deterministic merge → FAIL. Lane D reads it pragmatically: no v1 table producer → not exit-blocking. **The orchestrator resolved this against the code directly** (verify-don't-trust; note: an initial `rg`-based pass returned false-empties because `rg` is not installed on the host — re-done with `grep`):

- **No collaborative table producer exists.** No `#[napi]` table method (`ql-bindings-node/src/lib.rs` mentions tables only in `classify_delta_op` + a doc note that snapshot "does NOT surface tables"). The napi append-path is only `appendPutValue`/`appendPutFormula` + sheet ops.
- **No `Op::CreateTable/RenameTable/RenameColumn/...` construction anywhere in `ql-collab` or `ql-bindings-node` source** — only in tests (repair_tables.rs/repair_columns.rs exercise the rebuild *repair* path).
- The **only** table producers are `pub fn create_table/rename_table/rename_column/...` in `ql-exec/src/workbook_runtime/tables.rs` — the **single-writer `WorkbookRuntime`**, a separate crate **not composed into `CollabSession`** (every `WorkbookRuntime` mention in `ql-collab`/`ql-bindings-node` source is a comment, never a call). Single-writer cannot author a conflicting log (the producer rejects duplicate names *before* emitting), and there is no concurrency in single-writer mode.
- Therefore a concurrent conflicting table log is only producible by **hand-constructing raw `Op` values** (exactly what Codex's probe did) — the "malformed-logs-only" class, analogous to CODEX-MED-1.

Same logic applies to **A#6** (no `appendRegisterFormat`) and **C#1** (no `appendClearFormula`/`appendSetCellFormat`). **Convergent theme: latent replay-conflict aborts / empty-deltas, each gated on a producer that doesn't exist yet.**

---

## 4. Phase 5 Exit Criteria (§1 of PLAN) — evidence

1. **`ql-collab` is real (not a stub).** ✅ 10.7k LOC, 158+101 passing tests, real Loro CRDT merge. (Lane B.)
2. **Cells, formulas, names, sheets, AND tables merge deterministically under concurrency.** ⚠️ **Cells/formulas/sheets: ✅** (Lane C traced; existing convergence tests; CONVERGENT-HIGH-1 closed). **Names: ✅ at the WorkbookRuntime layer** (Lane D — one layer removed from collab; no collab `SetName` producer conflict path). **Tables: ✗ at replay (documented V1 hard-fail), but UNREACHABLE (no collaborative producer).** ← the one criterion not literally met; see §6.
3. **Offline sync + conflict diagnostics work.** ✅ 8 offline tests pass (Lane A A3); error taxonomy surfaces diagnostics (Lane D D6).
4. **Single-writer op log not confused with collaboration.** ✅ The single-writer `WorkbookRuntime` (ql-exec) is architecturally separate from the collaborative `CollabSession` (ql-collab); the megaudit's central finding (§3) literally turns on this separation holding.

---

## 5. Closure plan (confirmed, low-risk; NOT exit-blocking; respect ≤2 code-cycles/session)

| # | Item | Severity | Fix | Cost |
|---|---|---|---|---|
| 1 | B#1 export_snapshot tombstone leak | MED | Push `is_sheet_removed` filter into `snapshot_cells` (covers both `export_snapshot` + the raw accessor) OR filter in `export_snapshot`; + regression test. Completes the R-V3.6-19 closure. | small (engine) |
| 2 | D2-1 CellValueJson union | LOW | Retype as a real TS discriminated union (+ Rust mirror if cheap); keep the IDE defensive runtime guards. | small (TS) |
| 3 | D5-1 / D5-2 / D5-3 coverage | MED/LOW | Add: `Op::Unknown`-equivalent wire round-trip (or remove from spec, §6); collab `merge_bytes` multi-peer convergence tests for the uncovered ops; promote Codex's CODEX-MED-1 probe. | small (tests) |
| 4 | B#2/B#3/C#3/A#1 doc drift | INFO | Sweep cite/title drift in the contract + PLAN. | trivial (docs) |
| — | C#1/A#6/A#2-4 latent aborts | MED/HIGH-latent | **Do not fix now** (no producer). Log a single tracking item so the future clear/set-format/table/format collaborative producer lands its conflict-resolution + `removedCells` emission in the same change. | n/a |

---

## 6. ⚠️ The one disposition decision (gate-defining — needs product judgment)

Two findings amend a **stated Phase 5 exit criterion**, so they are not unilateral closures:

**(a) Tables — Exit Criterion #2.** Tables hard-fail concurrent merge at replay by documented "V1 LIMITATION" design, but no collaborative table producer exists (§3). Options:
- **DEFER (recommended):** amend Criterion #2 to scope collaborative table-merge as deferred to "when a collaborative table producer exists (Engine Phase 6+ / Product Phase 9 collab = v1.5-deferred)"; record single-writer table ops (WorkbookRuntime) as correct + tested; log a tracking risk. → unblocks Phase 5 COMPLETE.
- **BLOCK:** treat as a Phase 5 blocker; design stable-table-ID + non-aborting conflict resolution now (multi-day; no consumer today).

**(b) `Op::Unknown` top-level forward-compat.** The PLAN/checklist named a mechanism that doesn't exist (3-lane convergent: A#5/B#4/D5-1). Options:
- **AMEND (recommended):** document that top-level unknown ops intentionally reject at decode; forward-compat is via wire sub-enums + `.qbook` `snapshot_format_version`. (Cross-version op-log forward-compat is a V3.7+ stable-op-ID concern per existing INFO items.)
- **BUILD:** add an opaque catch-all `Op::Unknown` arm preserved through export/import now.

**Verdict pending (a):** with DEFER+AMEND → **PASS-WITH-FINDINGS** (Phase 5 COMPLETE; closures §5 are post-exit polish). With BLOCK → **FAIL until table conflict resolution ships.**

---

## 7. Scope-coverage attestation (PLAN §5)

- **Crates (§2.2):** ql-collab (B/C), ql-oplog (A/B), ql-collab-ws (A offline/transport), ql-bindings-node (B/D), ql-storage (B), IDE TS (C/D). ✅ all touched.
- **Op variants (§2.3):** all ~20 + 3 wire enums covered by A's wire round-trip; table/format/clear conflict variants probed by A; `Op::Unknown` non-existence confirmed by A/B/D. ✅
- **CacheEffect (§2.4):** all 7 arms by B (cache-walker invariants) + C (interaction). ✅
- **Risk register (§2.6):** 38/38 by B. ✅
- **Deferred items (§2.7):** all dispositioned by D. ✅
