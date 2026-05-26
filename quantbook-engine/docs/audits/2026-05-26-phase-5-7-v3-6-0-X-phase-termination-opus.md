# Phase 5.7 V3.6 phase-termination audit -- Opus Lane B

**Date**: 2026-05-26
**Engine HEAD**: 7e3a8bc53ec (Phase 5.7 V3.6.0.11 D9 typing-stroke watchdog doc sweep)
**IDE HEAD**: aa9d0448bb1 (Phase 5.7 V3.6.0.11 D9 typing-stroke watchdog IDE)
**Lane**: B (Opus) -- independent of Lane A (Codex) which already shipped at engine `c1da1a92bd6`
**Verdict**: **FAIL** (1 HIGH; convergent with Lane A's CODEX-PT-A1)
**Probes**: 5 written; 4 ran (3 failed as predicted = bug confirmed; 1 passed = no bug)
**Source edits**: none (audit-only per prompt constraints)
**Tests at audit start**: ql-collab 154/154 + IDE mocha 413/413 (both baselines hold)

---

## Findings summary

| Severity | Count |
|---------|-------|
| HIGH    | 1     |
| MED     | 4     |
| LOW     | 5     |
| INFO    | 5     |

## Findings table

| ID | Sev | Finding (one line) |
|---|---|---|
| OPUS-PT-B1-HIGH | HIGH | RestoreSheet does NOT recover pre-tombstone cells through napi `workbookSnapshot` (cache walker dropped them; rebuild paths leave cache empty for restored sheets) |
| OPUS-PT-B2-MED | MED | Inline comment at `lib.rs:2646-2652` still describes `Arc::make_mut` semantics; code is `(*cached_arc).clone()` always-clone (V3.6.0.8.4 OPUS-MED-3 missed this site) |
| OPUS-PT-B3-MED | MED | IDE `restoreSheet` JSDoc + engine napi `restore_sheet` docstring + op.rs `Op::RestoreSheet` docstring + ide-consumer-contract.md `.z6 V3.6.0.10` all promise "cells reappear via workbookSnapshot full rebuild" -- this is contract-vs-implementation drift, severity propagated by OPUS-PT-B1-HIGH |
| OPUS-PT-B4-MED | MED | Engine-level test gap: ql-collab has no `(PutValue, RemoveSheet, RestoreSheet, snapshot_cells)` regression; the existing `v3_6_0_10_restore_sheet_cache_drops_tombstone` test only verifies NEW (post-restore) cells land in cache, not that PRE-tombstone cells survive |
| OPUS-PT-B5-MED | MED | IDE-level test gap: the `restoreSheet brings sheet back into workbookSnapshot.sheets` mocha asserts sheet appears + name preserved, NOT that the contract-promised "Cells written BEFORE the original `deleteSheet` ... reappear on restore" holds |
| OPUS-PT-B6-LOW | LOW | `current_work.md` § "Next recommended sub-step" lists "V3.6.0.11 D9 typing-stroke watchdog" as next step, but it shipped at IDE `aa9d0448bb1` (referenced 4 lines up in same file); also lists "First three commands → expect 406 passing" but actual baseline is 413 |
| OPUS-PT-B7-LOW | LOW | `current_work.md` § "Cycle budget" says "Next session MUST start at 0 cycles" but we are in that next session running Lane A + Lane B audits within it |
| OPUS-PT-B8-LOW | LOW | Engine `restore_sheet` napi validates `sheet_id >= workbook.sheet_count()` as `[bad_argument]`, but `Op::RestoreSheet` replay is permissive (silently no-ops out-of-range ids per CRDT idempotency). Producer-side strictness vs replay-side permissiveness asymmetric -- documented at `op.rs:214` for Op::RestoreSheet ("Out-of-range ids: silently dropped (matches Op::RemoveSheet's permissive contract)") but the napi guard at `lib.rs:1485-1490` blocks the out-of-range path the wire variant allows. Same asymmetry exists in `delete_sheet` for symmetry; documented behavior, but tension between layers |
| OPUS-PT-B9-LOW | LOW | `WorkbookSnapshotDelta.removed_cells` is always empty (documented at `lib.rs:2466-2468` as "V3.7+ feature"); the field exists on the wire but carries no data. Either remove (breaking) or surface the limitation more prominently in `types.ts`; today the IDE consumer would compile against the field and silently get an empty array |
| OPUS-PT-B10-LOW | LOW | IDE does NOT consume `workbookSnapshotDelta` in any production code (verified via `grep -rn workbookSnapshotDelta\\( src/`); the type is exported and tested via mocha shape pins, but `cellGridPanel.render()` calls `workbookSnapshot()` unconditionally. Documented in plan body but not surfaced as a "shipped engine surface with zero IDE consumers" follow-up. Result: D6 perf contract delivered but no observable IDE perf improvement until consumer wires it |
| OPUS-PT-B11-INFO | INFO | V3.6.0.7 spike measured "251 ms median at 100k cells / 50% format / 1 sheet"; V3.6.0.8.4 bench measured "246 ms" same workload. Both replicate `workbook_snapshot` body via `snapshot_equivalent` in pure Rust (mirrors napi); the 5 ms gap is within Criterion noise and confirms the V3.6.0.8.4 delta numbers ARE the right comparison baseline (R-V3.6 perf-contract verification holds) |
| OPUS-PT-B12-INFO | INFO | `OPLOG_SCHEMA_VERSION = 1` unchanged across V3.6; new variants `Op::SetDateSystem` (V3.6.0.X audit-of-D4) and `Op::RestoreSheet` (V3.6.0.10) are additive on the `tag = "kind"` serde-tagged enum. Forward-compat caveat: pre-V3.6 readers reject unknown variants (`OpLogError::Deserialize`). Documented at both `Op::RemoveSheet` and `Op::RestoreSheet` docstrings as the V3.x convention; backward-compat clean (pre-V3.6 files have no new variants to decode) |
| OPUS-PT-B13-INFO | INFO | 6 invalidation callsites for `force_clear_workbook_cache()` in `session.rs` (5 production: merge_bytes, discard_pending_ops, poll_remote_with_limit, undo, redo; 1 test fixture). Matches the V3.6.0.8.4 CODEX-HIGH-1 closure's "5 production callsites" claim. The `force_clear_snapshot_cache` (cache for last_snapshot, different field) is a separate test-only seam |
| OPUS-PT-B14-INFO | INFO | Rule 4 arc terminus held at 6 across V3.6: per-field walks present on every new field (`pending_undo_cells: Arc<Mutex<Option<Vec<(u16,u32,u32)>>>>` at session.rs:764-772; `inside_group: bool` at :795-796; `undo_merge_interval_ms: i64` at :817-819; `format_table_cache: HashMap<FormatId, Arc<str>>` at :864-869; `cell_op_index` + `sheet_op_index` at :908-913 + :938-942; `last_snapshot_workbook: Option<Arc<Workbook>>` at :984-990; `last_snapshot_oplog_vv: Option<VersionVector>` at :1006-1014; `last_snapshot_op_count: Option<usize>` at :1045). New `CacheBuckets<'a>` struct walk at :261-267. All compositions of Send+Sync primitives. **0 new triggers; arc terminus confirmed at 6 by structural inspection.** The Send-assert + the Sync-non-assert pattern from V2 V4 V1 step 3 still compiles (verified by `cargo test -p ql-collab` passing) |
| OPUS-PT-B15-INFO | INFO | R-V3.5-1..7 + R-V3.6-1..18 status closures cross-verified against architecture doc. **CLOSED-AT markers match reality for all V3.5 risks + R-V3.6-1..8/10..18.** R-V3.6-9 documented as PARTIAL-CLOSED (D7 still conditional). The only contract-violating gap surfaces NOT in the R-* register but in the `Op::RestoreSheet` cells-reappear claim that drives OPUS-PT-B1-HIGH |

---

## HIGH findings (detail)

### OPUS-PT-B1-HIGH -- RestoreSheet does NOT recover pre-tombstone cells through napi workbookSnapshot

**Severity**: HIGH (correctness; contract violation affecting users).

**Surface**: `ql-bindings-node::CollabSession::workbook_snapshot` (full-rebuild path) + `ql-collab::CollabSession::snapshot_cells`.

**Finding**: The V3.6.0.10 D8 contract documented at three independent sites promises "Cells written BEFORE the original `deleteSheet` ... reappear on restore":

1. `crates/ql-oplog/src/op.rs:194-201` (Op::RestoreSheet wire docstring, "Cell preservation"):
   > "the V3.5.0.3b tombstone semantic preserves the underlying `Sheet` storage at `sheets[id]`, so cells written BEFORE the tombstone reappear when restored."

2. `crates/ql-bindings-node/src/lib.rs:1442-1445` (napi `restore_sheet` docstring):
   > "Cells written BEFORE the original `deleteSheet` are preserved by the tombstone semantic and reappear on restore."

3. `crates/ql-bindings-node/src/lib.rs:1457-1465` (napi `restore_sheet` "Cache + delta interaction" docstring):
   > "full rebuild is the cheapest way to get them back into the snapshot reply. The underlying Workbook storage retained the cells (V3.5.0.3b preservation invariant), so the full rebuild has them available."

4. `extensions/quantlab/src/quantbook/types.ts:544-547` (IDE consumer JSDoc for `restoreSheet`):
   > "Cells written BEFORE the original `deleteSheet` are preserved by the tombstone semantic and reappear on restore."

5. `extensions/quantlab/src/quantbook/types.ts:558-560`:
   > "the IDE should call `workbookSnapshot()` to get the un-tombstoned sheet's cells back."

6. `docs/architecture/ide-consumer-contract.md § 4.1.z6 V3.6.0.10 D8` line 2135:
   > "Cache dropped pre-tombstone cells at `CacheEffect::RemoveSheet` apply; Workbook preserved them; fullRebuild is the cheapest path to get them back into the snapshot reply."

**Reality**: The napi `workbook_snapshot` full-rebuild path (`crates/ql-bindings-node/src/lib.rs:2131-2414`) builds a fresh Workbook via `inner.rebuild_workbook(&registry)` — that Workbook does contain pre-tombstone cells in `sheets[id]` storage (Probe 1 confirmed: `workbook.sheet(0).read(0,0) == Number(42.0)`). BUT cells are then iterated for each visible sheet via `inner.snapshot_cells(sheet_id)` (line 2262-2263), which reads from `CollabSession.last_snapshot` (the CACHE) — not from the rebuilt Workbook. The cache walker (`apply_cache_effect`, `CacheEffect::RemoveSheet` arm at `session.rs:1582-1585`) DROPS all cache entries for the tombstoned sheet at the moment `Op::RemoveSheet` is processed (`buckets.snapshot.retain(|k, _| k.0 != id)`). The `CacheEffect::RestoreSheet` arm (`session.rs:1597-1609`) explicitly does NOT re-add cells, documented inline:
> "we do NOT walk `cell_op_index` to re-add the dropped snapshot entries -- those are recovered ONLY via the full snapshot rebuild paths (`rebuild_op_indices_only` + `rebuild_snapshot_cache`); to do it here would require walking the op log to find pre-tombstone cell-keyed ops, which is what the full rebuild does."

But `rebuild_snapshot_cache` (`session.rs:2113-2189`) ALSO does not re-add the cells: it walks the op log in order; `Op::PutValue` at index `i` lands in the fresh cache, then `Op::RemoveSheet` at index `j > i` drops it via `CacheEffect::RemoveSheet`, then `Op::RestoreSheet` at index `k > j` only un-flags the tombstone. **The cache walker's drop-then-restore semantic is a one-way trip.**

**Probes**:

- **Probe 1** (engine-level): pre-tombstone PutValue cells → RemoveSheet → RestoreSheet → `snapshot_cells(0)` returns `[]` while `workbook.sheet(0).read(0,0) == Number(42.0)`. **FAILED as predicted**.
- **Probe 4** (user-flow): PutValue → RemoveSheet → RestoreSheet → `snapshot_cells(0)` returns `[]`. **FAILED as predicted**.
- **Probe 5** (rebuild path): same op sequence + `export_bytes` + `from_snapshot` (forces `rebuild_snapshot_cache`) → reborn session's `snapshot_cells(0)` returns `[]`. **FAILED as predicted**.

All 3 probes confirm: the `workbookSnapshot()` napi will return `sheets[0]` with `cells: []` even though the Workbook side preserved the data. The user issues "undo delete" → sees their sheet reappear empty.

**User impact**: medium-to-high. The IDE wrapper `restoreSheet(session, id)` (`extensions/quantlab/src/quantbook/session.ts:259-261`) is now in production at IDE HEAD `aa9d0448bb1`. Any consumer that wires up an "undo delete" UX (and no such UX exists yet in `quantlab.quantbook*` commands as of `aa9d0448bb1` — `grep -rn restoreSheet src/` returns only the wrapper + types + no command palette registration) will surface the bug as soon as they expose it. Today the gap is silent because no UX consumes the napi; tomorrow a "Sheet → Restore deleted sheets" menu entry would surface empty restored sheets.

**Fix sketch** (not implementing per audit-only constraint):
- **Option A**: in the napi `workbook_snapshot` full-rebuild path, iterate the rebuilt Workbook's `sheets[id]` storage directly for the cell list instead of reading from `inner.snapshot_cells`. This sidesteps the cache for the cell-list query (formats/formulas can still go through the cache for cells the cache does have).
- **Option B**: extend `rebuild_snapshot_cache` to detect "tombstone-then-restore" sequences during the walk and skip the drop semantic for cells that are followed by RestoreSheet for the same sheet. Requires a two-pass walk OR carrying a "will-restore" lookup table.
- **Option C**: add a `recover_cells_from_workbook(sheet_id)` step in the `Op::RestoreSheet` apply_op or `CacheEffect::RestoreSheet` apply that walks `workbook.sheet(id)`'s column store and re-populates `last_snapshot` for cells the cache dropped. Most surgical.

**Convergent with Lane A**: per the prompt header, Lane A (Codex) reported "FAIL with 1 HIGH" and `current_work.md` describes it as "CODEX-PT-A1: RestoreSheet full-rebuild path returns restored sheet without preserved cells (cache-vs-Workbook desync; workbookSnapshot reads cells from pruned CollabSession.last_snapshot instead of rebuilt Workbook)." Same finding, independently surfaced.

**R-V3.6-X register update needed**: add a new R-V3.6-19 entry "RestoreSheet napi cell-recovery gap (V3.6.0.10 D8)" with status OPEN pending closure.

---

## MED findings (detail)

### OPUS-PT-B2-MED -- Inline Arc::make_mut docstring drift (V3.6.0.8.4 OPUS-MED-3 not fully closed)

`crates/ql-bindings-node/src/lib.rs:2646-2652`:

```
// Step 8: cell-only fast-path.  Clone the cached Workbook via
// `Arc::make_mut` (forks on write; if the IDE is holding
// another Arc clone, this returns a fresh clone, otherwise
// mutates in place -- both safe).  Apply [cached_op_count,
// current_op_count) forward via apply_ops_in_range -- no
// repair walks needed because we confirmed no rename ops in
// the range.
let registry = default_registry();
let mut next_workbook = (*cached_arc).clone();
```

The code says `(*cached_arc).clone()` (always-clone); the inline comment still describes the `Arc::make_mut` semantics. The big docstring at `lib.rs:2452-2458` was updated by V3.6.0.10 megaudit-docs sweep + V3.6.0.8.4 OPUS-MED-3 closure, but this inline comment was missed (same site, different comment block). The comment is misleading: under the actual code, `(*cached_arc).clone()` always clones the Workbook regardless of refcount, NOT "mutates in place if alone."

**Fix**: rewrite the inline comment to match `lib.rs:2452-2458`'s authoritative description (always-clone IS the right pattern per V3.6.0.8.4 OPUS-MED-3 closure + R-V3.6-17 measurement).

**Reproducibility**: `grep -n "Arc::make_mut" crates/ql-bindings-node/src/lib.rs`.

### OPUS-PT-B3-MED -- Contract docstring drift propagated from HIGH

Five independent docstrings (op.rs Op::RestoreSheet, napi restore_sheet 2-blocks, IDE types.ts restoreSheet, ide-consumer-contract.md § 4.1.z6 V3.6.0.10) ALL claim "cells reappear via workbookSnapshot." OPUS-PT-B1-HIGH proves this is false. Either fix the implementation (preferred per HIGH closure) OR update all 5 docstrings to document the gap as a known limitation pending V3.7+ work.

**Reproducibility**: see OPUS-PT-B1-HIGH probes 1/4/5.

### OPUS-PT-B4-MED -- ql-collab engine-level test gap

The existing `v3_6_0_10_restore_sheet_cache_drops_tombstone` test (`session.rs:7918-7939`) asserts:
- pre-RemoveSheet cache has the cells
- post-RemoveSheet cache drops them
- post-RestoreSheet + NEW cell write → NEW cell lands in cache

It does NOT assert pre-tombstone cells are recovered. The other 4 V3.6.0.10 tests verify un-tombstone, idempotency, out-of-range, remote-merge — none probe the cells-reappear contract. Add a regression matching Probe 1.

**Reproducibility**: `grep -A 30 "v3_6_0_10_restore_sheet_cache_drops_tombstone" crates/ql-collab/src/session.rs`.

### OPUS-PT-B5-MED -- IDE mocha test gap

The `restoreSheet brings sheet back into workbookSnapshot.sheets` test (`test/quantbook-roundtrip.test.ts:6928-6940`) checks `snap.sheets.length == 1` + `snap.sheets[0].name == 'S'`. It does NOT inspect `snap.sheets[0].cells`. If cells were preserved (per contract), the test should assert `snap.sheets[0].cells.length == 1` AND `snap.sheets[0].cells[0].value.number == 42`. Add this regression.

The `workbookSnapshotDelta fullRebuild on RestoreSheet` test (`:6953-6981`) only verifies the delta returns `fullRebuildRequired=true`. It does not call `workbookSnapshot` AFTER the delta to verify cells reappear.

**Reproducibility**: read the test bodies at the line numbers above.

---

## LOW findings (detail)

### OPUS-PT-B6-LOW -- current_work.md tail-section drift

`/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md`:

- Line 71: "V3.6.0.11 D9 typing-stroke watchdog (mid-edit-render guard; conditional; ~0.5 cycle)" listed as a "Next recommended sub-step" — but D9 SHIPPED at IDE `aa9d0448bb1` per line 19 of the same file.
- Line 85: "expect: 406 passing" for IDE mocha — actual baseline is **413/413** (the file's head section line 3 + line 19 both confirm 413; line 85 is stale from before V3.6.0.11's +7 tests).

**Fix**: rewrite §"Next recommended sub-step" + §"First three commands" to reflect post-V3.6.0.11 state.

### OPUS-PT-B7-LOW -- current_work.md cycle-budget self-contradiction

Line 66: "Next session MUST start at 0 cycles to recover discipline." But the head section line 3 already says "Current session (2 cycles, within CLAUDE.md ≤2)" and this Lane A + Lane B audit cycle is the THIRD post-handoff cycle. The "MUST start at 0" guidance has been already crossed; doc state is inconsistent with reality. Either update or surface as a deliberate exception.

### OPUS-PT-B8-LOW -- producer-side strictness vs replay-side permissiveness asymmetry

`lib.rs:1485-1490` rejects out-of-range `sheet_id` as `[bad_argument]`:
```
if (sheet_id as usize) >= workbook.sheet_count() {
    return Err(bad_argument_error(format!(
        "restoreSheet: id {id} does not exist ...",
    )));
}
```

But `Op::RestoreSheet` replay at `replay.rs:795-825` is permissive (`workbook.restore_sheet` checks `(id as usize) < self.sheets.len()` internally + silently no-ops). Same asymmetry exists in `delete_sheet`. The wire variant accepts what the producer rejects. In a multi-peer scenario, a peer might receive `Op::RestoreSheet { id: 5 }` from another peer (via merge_bytes → replay) for an `id=5` that hasn't been AddSheet-replayed locally yet. Replay silently drops it. But the local napi caller can never emit such an op.

Documented at op.rs:214 ("Out-of-range ids: silently dropped (matches Op::RemoveSheet's permissive contract)"); the producer-side guard in the napi is correct per the documented "id validation" semantic, but creates a producer/replay asymmetry worth surfacing in the architecture doc.

### OPUS-PT-B9-LOW -- WorkbookSnapshotDelta.removed_cells unused

`lib.rs:2466-2468` documents `removed_cells` as "always empty (V3.7+ feature)." The field is in `WorkbookSnapshotDeltaJson`; the IDE-side types include it. A consumer that hopes to use it would silently get empty arrays. Either remove (breaking; defer) OR add a NOTE comment in IDE `types.ts` that the field is reserved.

### OPUS-PT-B10-LOW -- IDE has no workbookSnapshotDelta consumer

`grep -rn "workbookSnapshotDelta(" extensions/quantlab/src/` returns only the types.ts type declaration. The `cellGridPanel.render()` calls `workbookSnapshot()` unconditionally. D6 shipped at the napi surface (engine `2dbce5ee2a5` through `82ed0d37d85`) but no IDE consumer yet. The 228× delta-vs-full speedup is "potential, unrealized."

This is documented in plan body but worth surfacing as a follow-up item in the IDE backlog: wire `workbookSnapshotDelta` into `cellGridPanel.render()` with the `lastSeenVersion` token round-trip per the contract.

---

## INFO observations

### OPUS-PT-B11-INFO -- V3.6.0.7 spike vs V3.6.0.8.4 bench are semantically the same workload

Both use `build_session(1000, 100, 1, 50)` (100k cells, 50% format, 1 sheet). Both call `snapshot_equivalent` (pure-Rust replica of napi `workbook_snapshot` body). Spike measured 251 ms; bench measured 246 ms. The 2% gap is Criterion noise. The delta numbers (1.08 ms at 100 new cells) are correct comparisons; the 228× speedup + 46× under threshold claims are accurate.

### OPUS-PT-B12-INFO -- OPLOG_SCHEMA_VERSION = 1 unchanged

`crates/ql-io/src/oplog_persistence.rs:129`: `pub const OPLOG_SCHEMA_VERSION: u32 = 1;` — unchanged across V3.6. Both new variants in V3.6 (`Op::SetDateSystem` from V3.6.0.X audit-of-D4 + `Op::RestoreSheet` from V3.6.0.10) are additive on `tag = "kind"` serde-tagged enum. Backward-compat clean. Forward-compat caveat: pre-V3.6 readers reject unknown variants via `OpLogError::Deserialize` (no `#[serde(other)]` catch-all). Documented at both new-variant docstrings.

### OPUS-PT-B13-INFO -- 5 production invalidation callsites confirmed

`session.rs` `force_clear_workbook_cache()` callsites:
- `:1676` merge_bytes
- `:3214` discard_pending_ops
- `:3609` poll_remote_with_limit
- `:3773` undo (BEFORE Loro's undo per R-V3.6-14)
- `:3867` redo (BEFORE Loro's redo per R-V3.6-14 mirror)
- `:7623` test fixture (`v3_6_0_8_2_force_clear_workbook_cache_resets_both_fields`)

V3.6.0.8.4 CODEX-HIGH-1 closure added the poll_remote_with_limit callsite to bring production count from 4 to 5. Confirmed at HEAD.

### OPUS-PT-B14-INFO -- Rule 4 arc terminus confirmed at 6

Per-field walks present + correct on every new V3.6 field (see findings table for line numbers). `CacheBuckets<'a>` walk at `session.rs:261-267`. The Send-assert + Sync-non-assert pattern from V2 V4 V1 step 3 still compiles (verified by `cargo test -p ql-collab --release --features test-fixtures --lib` → 154/154 passing). Arc terminus held at 6 across V3.6.

### OPUS-PT-B15-INFO -- R-V3.5 + R-V3.6 register CLOSED-AT markers match reality

Walked R-V3.5-1..7 + R-V3.6-1..18 in `docs/architecture/ide-consumer-contract.md`:
- R-V3.5-1..6: status accurate.
- R-V3.5-7: marked CLOSED-AT-V3.6.0.11 — confirmed by IDE shipping the typing_stroke envelope + resetTypingWatchdog method + cellGridHtml input listener at IDE `aa9d0448bb1`.
- R-V3.6-1..8: all CLOSED, status accurate.
- R-V3.6-9: PARTIAL-CLOSED, D7 conditional, accurate.
- R-V3.6-10..18: all CLOSED, status accurate.

NONE of the register entries cover OPUS-PT-B1-HIGH. Recommend adding **R-V3.6-19** "RestoreSheet napi cell-recovery gap (V3.6.0.10 D8)" with status OPEN.

---

## Cross-feature interaction map

| Scenario | Status | Notes |
|---|---|---|
| D6 + D8 (delta + RestoreSheet) | **BROKEN** | classify_delta_op forces fullRebuild=true on Op::RestoreSheet → IDE falls back to workbookSnapshot → which returns empty cells. OPUS-PT-B1-HIGH. |
| D6 + D1 + D2 (delta + undo + RegisterFormat cache) | OK | Probe 3 confirmed: undo of RegisterFormat → rebuild_snapshot_cache fires (fallback branch since captured_cells is empty) → format_table_cache rebuilt without the retracted entry. Cache-Workbook agree. |
| D4 + D6 + D8 (format::render + delta + RestoreSheet) | **BROKEN** | Inherits OPUS-PT-B1-HIGH: workbookSnapshot returns empty sheet, so format::render has no cells to render. The format itself survives in format_table_cache (D2) + Workbook formats; only cell-level rendering is broken. |
| D9 + D6 (typing_stroke + delta) | MOOT | No IDE consumer wires workbookSnapshotDelta (OPUS-PT-B10-LOW). D9 only affects IDE-side render() which uses workbookSnapshot. |
| V3.5.0.3b tombstone + D6 + D8 | **BROKEN** | Probe 4 confirmed: user-flow PutValue → RemoveSheet → RestoreSheet → cells gone. Same root cause as OPUS-PT-B1-HIGH. |
| V3.6.0.8.2 merge_bytes invalidation + D9 typing-flag | OK | merge_bytes clears workbook_cache (incl. forced fullRebuild on next delta). IDE typing flag defers render() until typing:false / watchdog. Watchdog fires render() which calls workbookSnapshot() (which re-builds the cache + returns snapshot). Render path correct under combination. (Modulo OPUS-PT-B1-HIGH if a RestoreSheet was in the merged bytes, which is the same root cause not a separate bug.) |
| poll_remote_with_limit + D6 (V3.6.0.8.4 CODEX-HIGH-1) | OK | force_clear_workbook_cache called on every successful drain; verified at session.rs:3609 + reachable by the test fixture pattern. |
| V3.6.0.8.4 OPUS-MED-3 always-clone vs Arc::make_mut | INFO | Code is always-clone; large docstring updated at lib.rs:2452-2458 but inline comment at :2646-2652 still says "Arc::make_mut" (OPUS-PT-B2-MED). |

---

## Lane B unique vs convergent

Without reading Lane A's transcript:

**Convergent with Lane A (per current_work.md description of CODEX-PT-A1)**:
- OPUS-PT-B1-HIGH (RestoreSheet cells gap)

**Lane B unique (not yet known whether Lane A surfaced these)**:
- OPUS-PT-B2-MED (inline Arc::make_mut comment drift)
- OPUS-PT-B3-MED (5-site contract drift)
- OPUS-PT-B4-MED (ql-collab regression gap)
- OPUS-PT-B5-MED (IDE mocha gap on cells-reappear)
- OPUS-PT-B6-LOW (current_work.md tail drift)
- OPUS-PT-B7-LOW (cycle-budget contradiction)
- OPUS-PT-B8-LOW (producer/replay asymmetry)
- OPUS-PT-B9-LOW (removed_cells always empty)
- OPUS-PT-B10-LOW (no IDE delta consumer)

Lane A's transcript may have additional LOW/INFO findings; cross-pollination on closure is recommended.

---

## Verdict + recommendation

**Verdict**: **FAIL** (1 HIGH; convergent with Lane A).

V3.6 ships in a state where:
- D1 (UndoManager on_push) is correct.
- D2 (RegisterFormat cache) is correct.
- D3 (per-cell op-index) is correct.
- D4 (format::render) is correct.
- D5 (appendPutFormula napi) is correct.
- D6 (delta surface) is correct at the engine boundary, but unused by IDE.
- **D8 (RestoreSheet) ships with a contract-violating gap** in the cells-recovery semantic.
- D9 (typing_stroke) is correct.

**Recommended closure for next cycle**:
1. **PRIORITY**: close OPUS-PT-B1-HIGH (and convergent CODEX-PT-A1) by routing napi `workbook_snapshot` cell iteration through Workbook storage for sheets that were restored (Option A from the fix sketch). Alternatively patch `CacheEffect::RestoreSheet` to recover cells from `workbook.sheet(id)` storage (Option C).
2. Close OPUS-PT-B2-MED (rewrite the inline comment at `lib.rs:2646-2652`).
3. Close OPUS-PT-B3-MED + OPUS-PT-B4-MED + OPUS-PT-B5-MED together via the HIGH closure (cells now reappear; docstrings + tests match reality).
4. Sweep `current_work.md` tail sections (OPUS-PT-B6 + OPUS-PT-B7).
5. Defer OPUS-PT-B8/B9/B10 to V3.6.1+ backlog or V3.7+ scope; document in the V3.6 risk register if not addressed.

**Recommendation for the V3.6 phase exit**: do NOT mark V3.6 as PHASE-COMPLETE until OPUS-PT-B1-HIGH closes. The convergent finding across Codex + Opus + the user-facing contract drift make this a hard-gate; phase-termination audits exist precisely to catch this class of cross-feature bug.

**Test baselines at audit end**: ql-collab 154/154 + IDE mocha 413/413 (unchanged; audit-only).
