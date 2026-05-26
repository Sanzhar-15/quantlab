# Phase 5 — Multi-User CRDT Collaboration — EXIT PACKET

**Status:** ✅ **PHASE 5 COMPLETE** (2026-05-26).
**Gate:** 5.8 Phase 5 Megaudit (the "Megaudit after 5.7" checkpoint, `MASTER-PLAN §684`) — **PASS-WITH-FINDINGS**.
**Audited source:** engine `1465b1db4c4` (V3.6 PHASE CLEAN). IDE `d028568b53b`.
**Canonical synthesis:** `docs/phase5/megaudit-5-8/closures.md` (+ 4 lane transcripts `docs/phase5/megaudit-5-8/lane-{a,b,c,d}.md`).

---

## 1. Verdict

**PASS-WITH-FINDINGS.** The 5.8 megaudit ran 5-way (Codex Lane A empirical/convergence + Opus Lanes B/C/D invariants/interaction/contract + claude-self synthesis). Result:

- **ZERO reachable HIGH findings** across all four lanes.
- **Risk register 39/39 confirmed** in its claimed state (Lane B), 0 falsely-closed. (39 = R-V3.3-1..6 + R-V3.4-1..7 + R-V3.5-1..7 + R-V3.6-1..19; "38" was a count error.)
- The only FAIL vote (Lane A, Codex) rested entirely on **table-convergence aborts proven UNREACHABLE** — there is no collaborative table producer (tables are single-writer `WorkbookRuntime`-only, not composed into `CollabSession`).

## 2. Exit criteria (`MASTER-PLAN §690`) — disposition

| # | Criterion | Status |
|---|---|---|
| 1 | `ql-collab` is real | ✅ 10.7k LOC, real Loro CRDT, 154 lib + 101 integration = 255 tests |
| 2 | Cells, formulas, names, sheets **+ tables** merge deterministically | ✅ cells/formulas/sheets (CONVERGENT-HIGH-1 closed); names at WorkbookRuntime layer. **Tables: collaborative merge DEFERRED** (amended — see §3) |
| 3 | Offline sync + conflict diagnostics work | ✅ 8 offline tests; structured `errorReply` diagnostics |
| 4 | Single-writer op log not confused with collaboration | ✅ `WorkbookRuntime` (ql-exec) architecturally separate from `CollabSession` (ql-collab) |

## 3. The one amended criterion — tables (decided 2026-05-26)

Concurrent table create/rename/rename-column ops converge at the op-log/cache layer but make `rebuild_workbook` **abort** (`TableCreateRejected`/`TableColumnRejected`; source-documented "V1 LIMITATION - hard-fail"). **This is unreachable**: no `#[napi]` table method, no `Op::CreateTable/...` construction in `ql-collab`/`ql-bindings-node` source, and the single-writer `WorkbookRuntime` producers reject duplicate names *before* emitting (and have no concurrency). A conflicting table log is only producible by hand-constructing raw `Op` values (the "malformed-logs-only" class).

**Decision (DEFER + amend):** Exit Criterion #2 is amended to scope **collaborative** table-merge as deferred until a collaborative table producer exists (Engine Phase 6+ / collab = Product Phase 9 = v1.5-deferred). That producer MUST land conflict-resolution (stable table/column IDs, non-aborting merge) **+ `removedCells` emission** in the same change. Same disposition applies to the latent format-id (`A#6`) and ClearFormula (`C#1`) aborts — all gated on producers that don't exist yet.

## 4. Op::Unknown (decided 2026-05-26)

The PLAN/checklist named a top-level `Op::Unknown(String)` forward-compat mechanism that **does not exist** (3-lane convergent: A#5/B#4/D5-1); unknown op kinds reject at decode (`deny_unknown_fields`). **Decision (AMEND contract):** top-level unknown ops intentionally reject at decode; forward-compat is via the wire sub-enums (`LocaleWire`/`ReferenceModeWire`/`DateSystemWire` Unknown arms) + `.qbook` `snapshot_format_version`. Cross-version op-log forward-compat remains a V3.7+ stable-op-ID concern (Codex INFO-3/5, R-V3.6-10).

## 5. Post-exit polish (confirmed-but-latent; next session; NOT Phase-6-blocking)

1. ✅ **DONE 2026-05-26 (`ff09a5e17a7`)** — **`export_snapshot` tombstone filter** (Lane B#1, MED). Added `CollabSession::is_sheet_removed_in_cache`; `export_snapshot` now returns empty entries for a tombstoned sheet (mirrors `workbook_snapshot`'s `is_sheet_removed` skip). `snapshot_cells` deliberately kept tombstone-agnostic (its R-V3.6-19 invariant tests depend on it — pushing the filter there would break them). +1 ql-collab regression test (255 pass / 0 fail; napi lib `cargo check` clean). Latent → the `.node` rebuild that makes it live happens with the next IDE build.
2. **`CellValueJson` discriminated-union retype** (Lane D2-1, LOW) — TS-only; keep defensive runtime guards.
3. **Coverage gaps** (D5-1/2/3) — collab `merge_bytes` multi-peer convergence tests for uncovered ops; promote Codex's CODEX-MED-1 probe.
4. **Doc-drift sweep** (B#2 debug_assert cite, B#3 on_pop title, C#2 render-error misattribution UX).

## 6. Phase 6 entry

Phase 6 (Product Surfaces) entry gate (`docs/phase6/entry-plan.md` §3) is **CLOSED** by this exit. Phase 5 collaboration is stable enough to expose; the upstream foundations (Phase 2B/3/4) were already verified. Next: Phase 6 decision-lock → 6.1 Stable Session API → 6.4 Python UDFs (the v1-critical wedge).
