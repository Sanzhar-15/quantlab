# Phase 5 Megaudit (5.8) — LANE B (Opus): per-sub-phase invariants + risk-register verification

**Auditor:** Opus Agent (Lane B). **Mode:** read-only static correctness. No source modified.
**Audit target:** engine source HEAD `1465b1db4c4` (V3.6 PHASE CLEAN). Repo at `git HEAD = dfa3d113c90` (docs-only commit on top; `git diff --stat 1465b1db4c4 HEAD -- crates/` shows **zero** source changes — confirmed I am auditing the locked source).
**Verification method:** read actual code at current HEAD + compiled `ql-bindings-node` (7m46s, 0 errors / 0 warnings — transitively proves every `assert_send`/`assert_sync` const-fn) + ran `ql-collab` (158 lib + 101 integration, all green), `ql-oplog` (67), `ql-storage` (199) test suites on the Mac host. **All test suites pass, 0 failures.**

---

## Findings

### Finding 1
**Finding:** `export_snapshot(sheet)` napi does NOT filter tombstoned (`Op::RemoveSheet`'d) sheets, so post-R-V3.6-19 (cache no-prune) it now surfaces cells for a removed sheet.
**Severity:** MED
**Files:** `crates/ql-bindings-node/src/lib.rs:1756-1757` (`export_snapshot`); contrast `crates/ql-bindings-node/src/lib.rs:2226` (`workbook_snapshot` filters via `is_sheet_removed`) and `crates/ql-collab/src/session.rs:1791-1797` (`list_sheets_from_cache` filters via `removed_sheets`).
**Evidence:**
```rust
// export_snapshot — NO tombstone filter between lock and read:
let inner = self.inner.lock();
let entries_vec = inner.snapshot_cells(sheet);   // returns preserved cells even for tombstoned sheet
```
The R-V3.6-19 phase-termination closure deliberately made `apply_cache_effect`'s `RemoveSheet` arm STOP pruning cells (`session.rs:1611-1617`), so `snapshot_cells(s)` now returns the pre-tombstone cells for a removed sheet `s`. The closure correctly updated `list_sheets_from_cache` (added `removed_sheets.contains` filter) and `workbook_snapshot` (`is_sheet_removed` `continue` BEFORE `snapshot_cells(sheet_id)` at lib.rs:2226→2263), and the delta builder filters via `removed_sheet_set` (lib.rs:2698-2706). But `export_snapshot` — a still-`#[napi]`-exported public method — calls `snapshot_cells(sheet)` with no filter. The same gap applies to the raw `CollabSession::snapshot_cells` accessor (`session.rs:2071`), whose docstring (2043-2070) never mentions tombstones. **Mitigation that lowers severity to MED, not HIGH:** the production IDE migrated cell-grid rendering to `workbookSnapshot` at V3.5.0.4b; grep finds NO `exportSnapshot` consumer in the IDE TS, no JS/mocha test calls it, and no Rust caller of `snapshot_cells` other than the two napi methods. So the gap is **latent / currently-unreachable by the shipped IDE path**, but it is a live public-API correctness hazard and a contract-vs-impl drift the R-V3.6-19 closure introduced and missed (the field docstring at `session.rs:706-708` even names `snapshot_cells` as a pre-closure leak surface).
**Recommendation:** filter `removed_sheets` inside `export_snapshot` (return empty for a tombstoned sheet, mirroring `workbook_snapshot`) OR push the filter into `snapshot_cells` itself (one fix covers both consumers). Add a regression test (`export_snapshot_on_tombstoned_sheet_is_empty`) and update the `snapshot_cells` docstring to state the tombstone contract. Not blocking Phase 6 entry given unreachability, but should be closed before any consumer re-adopts `exportSnapshot`.

### Finding 2
**Finding:** R-V3.6-15 debug_assert line citation drift in the risk register and §4.1.z6.
**Severity:** INFO
**Files:** doc `docs/architecture/ide-consumer-contract.md:2218` + the megaudit lane instruction cite `lib.rs:2604-2613`; actual location is `crates/ql-bindings-node/src/lib.rs:2609-2617`.
**Evidence:** `grep -n "debug_assert_eq!" lib.rs` → only hit is line 2609. The assert body spans 2609-2617. The cited `2604-2613` is ~5 lines off (the comment block precedes the macro). The assert ITSELF is correct and present (see Finding-state R-V3.6-15 below).
**Recommendation:** correct the citation to `2609-2617` in the contract doc on the next docs sweep. Cosmetic only.

### Finding 3
**Finding:** R-V3.6-1 risk-register title says "Loro on_pop callback re-entrancy" but the implemented mechanism is `set_on_push` + `top_undo_meta()`/`top_redo_meta()` read; there is no `on_pop` callback in the code.
**Severity:** INFO
**Files:** `docs/architecture/ide-consumer-contract.md:2204` (risk title); code at `crates/ql-collab/src/session.rs:4231` (`undo.set_on_push(...)`), `session.rs:3783` / `3889` (`top_undo_meta` / `top_redo_meta`).
**Evidence:** Loro's public `UndoManager` exposes `set_on_push` (fires on every stack push, including the synthetic inverse) — there is no `on_pop`. The closure (4231-4246) reads `pending_undo_cells` via `.take()`. The re-entrancy mitigation the risk register describes (Mutex owned by the closure's Arc clone, NOT `&mut self`, so no double-borrow during the synchronous `LoroDoc::commit()` inside `OpLog::append`) is correctly implemented and matches the `pending_undo_cells` field docstring (session.rs:757-762). The risk is genuinely closed; only the title verb ("on_pop") is imprecise.
**Recommendation:** rename the risk title to "Loro on_push callback re-entrancy" for accuracy. No code change.

### Finding 4
**Finding:** PLAN §2.3 scope inventory lists `Unknown(String)` as a top-level `Op` forward-compat variant; the actual `Op` enum has no top-level `Unknown` variant — only the three wire enums do — and `Op` uses `#[serde(deny_unknown_fields, tag = "kind")]`, so an unknown op `kind` FAILS to deserialize rather than degrading gracefully.
**Severity:** INFO
**Files:** `crates/ql-oplog/src/op.rs:46-49` (`Op` derives + `#[non_exhaustive]` + `deny_unknown_fields`); `op.rs:511,570,636` (`Unknown(String)` on ReferenceModeWire / LocaleWire / DateSystemWire only).
**Evidence:** `grep "    Unknown" op.rs` shows Unknown only inside the three wire enums; the top-level `Op` (line 49) has 22 concrete variants and no `Unknown`. `Op` is `#[non_exhaustive]` (good for additive variants) but `deny_unknown_fields` means a future peer emitting an op kind this version doesn't know would error at `OpLog::iter`/`get` decode, not silently skip. This is the known V3.7+ "stable-op-ID / forward-compat" gap (Codex INFO-3/INFO-5 in the scope §2.7). Not a Phase 5 regression — the wire enums DO have graceful `Unknown` fallback for their bounded value spaces, which is where cross-version skew is most likely.
**Recommendation:** correct PLAN §2.3 to not claim a top-level `Op::Unknown(String)`. Track op-kind forward-compat as the existing V3.7+ item. No Phase-5 action.

### Finding 5
**Finding:** B2 cache-walker invariants — all 7 CacheEffect arms verified correct, including the load-bearing R-V3.6-19 no-prune, RegisterFormat first-write-wins, atomic-swap invalidate_cell, and append_op-does-not-invalidate-workbook-cache. No defects.
**Severity:** INFO (positive confirmation)
**Files:** `crates/ql-collab/src/session.rs` — `collect_cache_effects:1353-1429`, `apply_cache_effect:1458-1657`, `rebuild_snapshot_cache:2148-2224`, `rebuild_op_indices_only:2263-2315`, `invalidate_cell:2359-2491`, `append_op:1233-1340`, `force_clear_workbook_cache:1975-1981`.
**Evidence:** Detailed per-arm verification below (B2 section). Both the `target_sheet` (1466-1474) and `cell_key_for_index` (1490-1498) matches enumerate all 7 variants exhaustively. `RemoveSheet` arm (1611-1617) ONLY inserts the tombstone — does NOT prune cells/index (R-V3.6-19). `RegisterFormat` arm uses `entry().or_insert` (1654, first-write-wins). `invalidate_cell` removes the target key (2486) ONLY after the full fallible `OpLog::get` walk succeeds (2423-2475); `Some(Err)` (2433) / `None` (2435) early-return before any `self.last_snapshot` mutation (atomic-swap, D3 CONVERGENT-HIGH-1). `append_op` (1233-1340) has no `force_clear_workbook_cache` call — the delta fast-path precondition holds. The 5 production `force_clear_workbook_cache()` sites are exactly: `merge_bytes:1699`, `discard_pending_ops:3249`, `poll_remote_with_limit:3644`, `undo:3808`, `redo:3902` (line 7700 is a test). `cell_op_index ∪ sheet_op_index` BatchCommit dedup via `last().copied() != Some(op_log_index)` (1501,1507).
**Recommendation:** none — invariants hold.

### Finding 6
**Finding:** B3 Rule-4 Send+Sync — every Phase-5 type added is positively Send+Sync by field composition; all compile-time assertions hold (build clean). No `!Send`/`!Sync` regression.
**Severity:** INFO (positive confirmation)
**Files:** core `crates/ql-collab/src/session.rs:295-298` (`_ASSERT_COLLAB_SESSION_SEND`), binding `crates/ql-bindings-node/src/lib.rs:3887-3892` (`assert_send + assert_sync` on binding `CollabSession`), `lib.rs:3914-3964` (Transport / LoopbackPair / BlockingTransportFixture asserts). napi structs `lib.rs:581/660/719/809/843/949/968/981/1018`.
**Evidence:** `cargo build -p ql-bindings-node` finished with 0 errors / 0 warnings → all const-fn assertions compiled. Per-field walk of every type: all napi JSON structs (`CellValueJson`, `FormatIdJson`, `CellSnapshotJson`, `SheetSnapshotJson`, `WorkbookSnapshotJson`, `FormatDefJson`, `ChangedCellJson`, `RemovedCellJson`, `WorkbookSnapshotDeltaJson`) are `#[napi(object)]` plain data composed of `String`/`Option<f64|bool|u32|String|BigInt>`/`Vec<NestedJson>`/`Buffer` — all Send+Sync. Core `CollabSession` new fields (`pending_undo_cells: Arc<Mutex<Option<Vec<(u16,u32,u32)>>>>`, `inside_group: bool`, `undo_merge_interval_ms: i64`, `format_table_cache: HashMap<FormatId, Arc<str>>`, `cell_op_index`/`sheet_op_index: HashMap<.., Vec<usize>>`, `last_snapshot_workbook: Option<Arc<Workbook>>`, `last_snapshot_oplog_vv: Option<VersionVector>`, `last_snapshot_op_count: Option<usize>`) — each has a positive per-field walk docstring and each composes Send+Sync. Core `CollabSession` is correctly Send + **!Sync** (the `Option<Box<dyn Transport + Send>>` trait object carries no Sync bound — documented at `session.rs:300-314` with a commented probe pattern); binding wraps it in `Arc<parking_lot::Mutex<_>>` (lib.rs:1136) which restores Sync (`parking_lot::Mutex<T>: Sync` iff `T: Send`). `CacheEffect` (7 variants) + `CacheBuckets<'a>` (5 `&mut HashMap` refs) compose Send+Sync. `Op` (22 variants) + wire enums (ReferenceModeWire/LocaleWire/DateSystemWire) are serde-derived primitive/String enums — Send+Sync.
**Recommendation:** none. The discipline (negative trait claim → commented compile-probe; positive claim → enforced assert) is intact. Arc terminus stays at 6.

### Finding 7
**Finding:** B4 VV/op_count drift — the `(VersionVector, op_count)` cache pair is structurally drift-proof (set-together / clear-together + monotonicity debug_assert) and the always-clone Workbook pattern + 692µs@100k cost claim are grounded.
**Severity:** INFO (positive confirmation)
**Files:** `crates/ql-collab/src/session.rs:1911-1919` (`set_workbook_cache` sets all 3), `session.rs:1975-1981` (`force_clear_workbook_cache` clears all 3); `crates/ql-bindings-node/src/lib.rs:2609-2617` (R-V3.6-15 debug_assert), `lib.rs:2658` (`(*cached_arc).clone()` always-clone).
**Evidence:** `last_snapshot_workbook` / `last_snapshot_oplog_vv` / `last_snapshot_op_count` are mutated ONLY in `set_workbook_cache` (all three → Some together, line 1912-1918) and `force_clear_workbook_cache` (all three → None together, 1976-1980) + the test seam `force_clear_snapshot_cache` (2038-2040, all three). No code path sets one without the others. The delta path destructures via a single `match (Some, Some, Some) => .. | _ => full_rebuild` (lib.rs:2503-2514), so a partial-None state can never be used. The monotonicity assert `debug_assert_eq!(new_ops.len(), current_op_count - cached_op_count, ...)` (lib.rs:2609) fires if the V3.6.0.8.2 invalidation discipline is ever broken (a merge/undo/discard between cache populate and delta read would have cleared the cache, so the only growth path is `append_op`). Clone is `(*cached_arc).clone()` always-clone (NOT `Arc::make_mut`) — correct, because `cached_arc = Arc::clone(arc)` has strong_count ≥ 2 by construction (OPUS-MED-3 closure). `Workbook` auto-derives Send+Sync; `bench_workbook_clone` (R-V3.6-17) measured 692µs@100k, well under the 20ms threshold.
**Recommendation:** none. Drift is impossible by construction.

### Finding 8
**Finding:** B5 undo/redo — Loro on_push/top-meta wiring, grouped-undo conservative fallback (inside_group ∥ undo_merge_interval_ms>0), and pure_local_frontier removal all correct and complete.
**Severity:** INFO (positive confirmation)
**Files:** `crates/ql-collab/src/session.rs` — `undo:3748-3855`, `redo:3866-3931`, `make_undo_manager:4225-4248`, `encode_cells_to_loro_value:4273-4288`, `decode_cells_from_loro_value:4308-4325`, `append_op` staging gate `1308-1314`, `start_undo_group:3991-4004`, `end_undo_group:4014-4021`, `set_undo_merge_interval:4038-4045`, `discard_pending_ops:3238-3264`.
**Evidence:** `undo()` reads `top_undo_meta().value` → `decode_cells_from_loro_value` (3781-3784) BEFORE Loro's undo; pre-stages cells into `pending_undo_cells` for the synthetic inverse-op's on_push (3791-3793); calls `force_clear_workbook_cache()` BEFORE `self.undo.undo()` (R-V3.6-14, line 3808); on `consumed`, dispatches partial-invalidate (non-empty cells → `rebuild_op_indices_only()` at 3829 then per-cell `invalidate_cell`) vs full `rebuild_snapshot_cache()` fallback (empty/decode-fail at 3840); auto-flush gated on `consumed` (Codex M2, 3817/3843). `redo()` mirrors exactly (3887-3930). Grouped-undo fallback: `append_op` stages EMPTY cells when `self.inside_group || self.undo_merge_interval_ms > 0` (1308) → meta encodes empty → undo decodes empty → full rebuild (matches Loro `push_with_merge` meta-discard pathology). `inside_group` set after `group_start()` succeeds (4002), cleared in `end_undo_group` (4020) + `discard_pending_ops` (3257); `set_undo_merge_interval` mirrors to the session field (4044) and `discard_pending_ops` reapplies it to the recreated UndoManager (3262-3264). **`pure_local_frontier` is fully removed**: `grep` finds 6 mentions in session.rs, ALL inside comments/docstrings (lines 770, 6484 etc.); zero live field declaration, zero assignment, zero read. The V3.6.0.2 D1 mechanism (top-meta) fully replaced it.
**Recommendation:** none.

---

## Risk-register table (B1)

For every risk: opened the cited closure code at current HEAD, confirmed it exists + is correct + has a regression test where claimed. Legend: **CC** = CONFIRMED-CLOSED, **DA** = DEFERRED-APPROPRIATELY, **IDE** = closure lives in the IDE worktree (not in this engine repo — engine-side prerequisites confirmed).

| Risk | State | Evidence |
|---|---|---|
| **R-V3.3-1** Virtualization integration | DA (MITIGATED) | IDE-side custom-inline design; no engine surface. Not an engine-code risk. |
| **R-V3.3-2** exportSnapshot cache invariants under undo | CC | undo/redo call `rebuild_snapshot_cache()` on consumed (session.rs:3840/3921); cache invariant pinned by `undo_invalidates_snapshot_cache` test (5856) + the partial-invalidate suite (6756-6968). |
| **R-V3.3-3** listSheets enumeration consistency | CC | `list_sheets_from_cache` (session.rs:1780) derives from cache keys + filters `removed_sheets`; cross-peer convergence via shared cache rebuild. |
| **R-V3.3-4** Persistence schema versioning | DA | Tier D3 envelope established; v2 schema sufficient per V3.4.0.1 D3 (contract §1013). No engine regression. |
| **R-V3.3-5** PeerId reuse under restart | CC (→R-V3.4-4) | Superseded by fresh-UUID-per-session (D5 deviation); UUID 2^64 keyspace. IDE `generateUuidPeerId`; engine `assert_ne!(peer_id,0)` (session.rs:1080,1150). |
| **R-V3.3-6** Virtualization + reconnect race | DA (MITIGATED) | IDE mid-edit `activeInput` guard + dispose teardown. IDE-side. |
| **R-V3.4-1** Hybrid cache shape migration | CC (MITIGATED) | `snapshot_cells` signature `CellWireValue→CellState` (session.rs:2071); napi JSON shape preserved (`export_snapshot` extracts `.value`, lib.rs:1760). |
| **R-V3.4-2** Undo/redo across persistence load | DA (DOCUMENTED) | `from_snapshot` resets Loro UndoManager (correct CRDT behavior); `make_undo_manager` fresh (session.rs:1166). |
| **R-V3.4-3** Presence + 2-window collab race | IDE (CLOSED-at-V3.5.0.7) | `_presenceRepaintInFlight` + watchdog + tickPollRemote skip — all IDE TS (`CellGridPanel`). Engine has no presence-render path; engine `onLocalTyping`/presence APIs present. Out of engine-lane scope. |
| **R-V3.4-4** PeerId reuse across save/load | CC | Fresh-UUID-per-session (D5); engine rejects PeerId(0) at both constructors (session.rs:1080/1150). |
| **R-V3.4-5** Undo across remote-op merge | CC (DOCUMENTED) | Loro UndoManager undoes only LOCAL ops; remote-merged ops not on the undo stack (correct CRDT). `undo_after_remote_interleave_*` tests (6612). |
| **R-V3.4-6** .qbook save during pending-flush | CC | `toQbook` saves `op_log()` directly (orthogonal to transport flush); lib.rs `to_qbook` reads full local log. |
| **R-V3.4-7** Presence sweep frequency | DA (VOIDED) | Premise was wrong (`sweepPresence` has no threshold param); sweep only on lifecycle events. Engine `sweep_presence` (session.rs:4108) sweeps all unconditionally — matches the voided-risk reality. |
| **R-V3.5-1** WorkbookSnapshot O(N) per-call cost | DA (DOCUMENTED) | `workbook_snapshot` routes through `rebuild_workbook` (O(N)); D6 delta path (R-V3.6-5) added as the optimization. Callers batch. |
| **R-V3.5-2** Partial-invalidate per-cell-op-index | CC | `cell_op_index`/`sheet_op_index` (session.rs:914/943); `invalidate_cell` indexed walk (2391-2406) via `OpLog::get` (log.rs:183, O(log N)); 6 regression tests (6756-6968). |
| **R-V3.5-3** Sheet-tabs UX gap | DA (ACCEPTED) | Command-palette + reactive title cover it; not a correctness gap. IDE-side. |
| **R-V3.5-4** Format-aware rendering | CC | `workbook_snapshot` populates `rendered` via `format::render` with workbook date_system+locale EvalContext (lib.rs:2677-2747); pending short-circuit (2730). |
| **R-V3.5-5** Session-wide format registry | CC | `format_table_cache` (session.rs:870) + `CacheEffect::RegisterFormat` first-write-wins (1654); `WorkbookSnapshotJson.formats` (lib.rs:879); test `..first_write_wins_on_same_id_diff_string` (4970). |
| **R-V3.5-6** Cross-restart PeerId reuse | CC (→R-V3.4-4) | Fresh-UUID-per-session. |
| **R-V3.5-7** Mid-edit watchdog correctness | IDE (CLOSED-at-V3.6.0.11) | `typing_stroke` re-arm — pure IDE/TS (D9 "no engine changes" per contract §2196). Engine has no watchdog. Out of engine-lane scope. |
| **R-V3.6-1** Loro on_pop re-entrancy | CC (title imprecise — Finding 3) | `set_on_push` closure owns the Mutex Arc (not `&mut self`); no double-borrow during synchronous commit (session.rs:4231-4246; field doc 757-762). Mechanism is on_push, not on_pop. |
| **R-V3.6-2** FormatTable cache invariant | CC | First-write-wins `entry().or_insert` (session.rs:1654) mirrors `FormatTable::register_at` IdCollision (replay test `replay_register_format_id_collision_errors`, replay.rs:1892); atomic-swap rebuild (2190-2220). |
| **R-V3.6-3** cell_op_index sync invariant | CC | Per-effect push + dedup (session.rs:1499-1510); rebuilt in `rebuild_snapshot_cache` (2197-2222) + `rebuild_op_indices_only` (2294-2313) via the canonical walker. |
| **R-V3.6-4** Format-render locale/date propagation | CC | `Op::SetDateSystem` + `Op::SetLocale` replay (replay.rs:980-1001); EvalContext from workbook (lib.rs:2677-2681). |
| **R-V3.6-5** Incremental snapshot delta freshness | CC | Staleness fallback: `caller_vv != cached_vv → fullRebuildRequired` (lib.rs:2530-2531); rename → full rebuild (2642-2643); same-VV fast-path (2535). |
| **R-V3.6-6** OnPush DiffEvent inspection cost | CC | Closure ignores `_diff` entirely (session.rs:4231 `move |_source, _span, _diff|`) — only drains `pending_undo_cells`. Zero DiffEvent walk cost. |
| **R-V3.6-7** pure_local_frontier removal regression | CC | Field fully removed — 6 comment-only mentions, 0 live decl/assign/read (Finding 8). V3.5.0.X tests rewritten (`undo_after_remote_interleave_uses_partial_invalidate_correctly`, 6612). |
| **R-V3.6-8** napi struct evolution | CC | All additive: `formats`/`dateSystem`/`version` on WorkbookSnapshotJson (lib.rs:879/900/932), `rendered` on CellSnapshotJson (786). No shape break. |
| **R-V3.6-9** #REF! + RestoreSheet interaction | DA (PARTIAL-CLOSED) | D8 RestoreSheet ships standalone (replay.rs:795); D7 (#REF!) unshipped → interaction moot. Replay order verified (RestoreSheet before repair on rebuild_workbook). Appropriately deferred, not broken. |
| **R-V3.6-10** cell_op_index positional fragility | CC | `rebuild_op_indices_only()` called by undo/redo BEFORE per-cell invalidate (session.rs:3829/3915); `OpLog::get` "visible-counter caveat" documented (log.rs:175-182). |
| **R-V3.6-11** dateSystem needs Op::SetDateSystem | CC | `Op::SetDateSystem`+`DateSystemWire` (op.rs:493/633); replay handler (replay.rs:995-1001); tests `..set_date_system_replay_updates_workbook` (5594) + `..unknown_wire_errors` (5624). |
| **R-V3.6-12** click-to-edit broken for rendered strings | IDE | `data-raw-value` attribute — IDE TS (`cellGridHtml`). Engine emits the parseable raw via `CellSnapshotJson.value`. Out of engine-lane scope. |
| **R-V3.6-13** pending+format renders as zero | CC | Short-circuit `!wire_value.is_pending()` in both `workbook_snapshot` (lib.rs:2730) + delta builder (2730). `rendered=None` when pending. |
| **R-V3.6-14** cached Workbook stale after retract | CC | `force_clear_workbook_cache()` BEFORE Loro undo/redo (session.rs:3808/3902); 5th site `poll_remote_with_limit` (3644). Tests `v3_6_0_8_2_undo/redo_invalidates_workbook_cache` (7755/7777). |
| **R-V3.6-15** VV vs op_count drift | CC (citation off — Finding 2) | `debug_assert_eq!` at lib.rs:**2609** (doc cites 2604-2613); set/clear-together invariant (Finding 7). FxHashMap doc-correction accurate (version.rs:29). |
| **R-V3.6-16** multi-peer rename + cell | CC | `merge_bytes` invalidates both caches (session.rs:1690/1699); test `v3_6_0_8_2_merge_bytes_invalidates_workbook_cache` (7706); napi staleness → fullRebuild (lib.rs:2530). |
| **R-V3.6-17** Workbook clone cost | CC | always-clone `(*cached_arc).clone()` (lib.rs:2658); 692µs@100k measured well under 20ms threshold (`bench_workbook_clone`). |
| **R-V3.6-18** apply_op private | CC | `pub fn apply_ops_in_range` (replay.rs:449); `log.get(i)` random-access (470); empty/inverted = O(1) (456-458); oversized stops at end (472). 4 tests `v3_6_0_8_2_apply_ops_in_range_*` (7830-7908). |
| **R-V3.6-19** RestoreSheet preserved-cells gap | CC | Walker `RemoveSheet` arm no-prune (session.rs:1611-1617); `restore_sheet` un-tombstone (workbook.rs:781); 3 visibility filters (`is_sheet_removed` lib.rs:2226, `removed_sheet_set` 2698, `removed_sheets` in `list_sheets_from_cache` session.rs:1792). Tests `..restore_sheet_resurfaces_preserved_cells_in_snapshot_cache` (8081) + `..post_restore_writes_stack_atop_preserved_cells` (8185). **NOTE: the export_snapshot gap (Finding 1) is a SIDE-EFFECT of this closure's no-prune change that the closure missed.** |

**Risk-register summary:** 38 entries walked. **0 risks found in a FALSE claimed state.** Every CLOSED risk's closure code exists at current HEAD and (where claimed) has a named regression test that I located by name. Conditional/deferred risks (R-V3.6-9, R-V3.5-1/3, R-V3.3-1/4/6, R-V3.4-2/7) are appropriately deferred, not silently broken. The one real defect (Finding 1, MED) is a latent side-effect of R-V3.6-19, NOT a falsely-closed risk — R-V3.6-19's own stated scope (cache + the 3 named filters) is correctly closed.

---

## Phase 5 exit criteria (PLAN §1) — engine-lane evidence

1. **`ql-collab` is real (not a stub):** CONFIRMED — 8210 LOC `session.rs` with full CollabSession (cache walker, undo, presence, snapshot/delta), 158 lib + 101 integration tests pass.
2. **Cells/formulas/names/sheets/tables merge deterministically:** CONFIRMED for cells/formulas/sheets/format (cache walker + replay + LWW via Loro causal-merge order). Names + tables merge via `rebuild_workbook` repair passes (`repair_{sheet,table,column}_rename_chain`, integration tests `repair_renames`/`repair_tables`/`repair_columns*` all pass). The under-exercised surfaces (names/tables) have passing repair test suites.
3. **Offline sync + conflict diagnostics:** CONFIRMED — Loro op log IS the offline queue; `has_pending_flush`/`pending_op_count`/`discard_pending_ops`; `transport_last_error`; `SyncReport` Display.
4. **Single-writer op log not confused with collaboration:** CONFIRMED — `PeerId(0)=LEGACY_PEER` rejected at both constructors (release-firing `assert_ne!`); the op-log scaffolding vs CRDT distinction holds.

---

## VERDICT: **PASS-WITH-FINDINGS**

- **HIGH findings: 0.** No open HIGH; no risk in a false claimed state; all four Phase 5 exit criteria verified with engine-side evidence; all engine test suites green (ql-collab 158+101, ql-oplog 67, ql-storage 199); binding compiles clean (transitive Send+Sync proof).
- **MED: 1** (Finding 1 — `export_snapshot`/`snapshot_cells` tombstone-filter gap; latent/unreachable by shipped IDE path but a live public-API correctness hazard + R-V3.6-19 closure-completeness drift). Recommend closing before Phase 6 entry as low-cost hygiene; not a Phase-6-blocking HIGH given unreachability.
- **INFO: 3** (Findings 2,3,4 — doc citation/title/scope-inventory drift, all cosmetic).
- **Positive-confirmation findings: 4** (Findings 5,6,7,8 — B2/B3/B4/B5 all verified correct).

Per PLAN §1 ("PASS = all 4 verified + zero open HIGH + every closed risk confirmed-closed"), Lane B's deep static pass meets the PASS bar with one MED to fold into the cross-lane synthesis (Lane E).

---

## Coverage note (B1–B5)

- **B1 RISK-REGISTER WALK — COMPLETE.** All 38 risks (R-V3.3-1..6, R-V3.4-1..7, R-V3.5-1..7, R-V3.6-1..19) opened against current-HEAD code; table above. IDE-only closures (R-V3.4-3, R-V3.5-7, R-V3.6-12) verified to have their engine-side prerequisites present; their TS closure code lives in the `extensions/quantlab/` worktree NOT in this engine repo, so the final TS verification belongs to Lane D / the IDE-facing lane — flagged explicitly, not silently skipped.
- **B2 CACHE-WALKER INVARIANTS — COMPLETE.** All 7 CacheEffect arms + tombstone preservation (R-V3.6-19) + RegisterFormat first-write-wins + cell∪sheet index sync + invalidate_cell atomic-swap + append_op-no-invalidate + the 5 force_clear sites all verified at file:line. (Finding 1 surfaced as a consumer-side gap in `export_snapshot`, downstream of the walker.)
- **B3 RULE-4 Send+Sync — COMPLETE.** Per-field walk of every Phase-5 type; build-clean transitively proves all asserts; core !Sync correctly held + documented; no regression. Arc terminus = 6.
- **B4 VV/op_count + clone-cost — COMPLETE.** Drift impossible by set/clear-together + debug_assert; always-clone confirmed as the pattern; 692µs@100k grounded.
- **B5 UNDO/REDO — COMPLETE.** on_push/top-meta wiring, encode/decode, grouped-undo fallback (inside_group ∥ merge_interval), and pure_local_frontier removal (zero live references) all verified.
