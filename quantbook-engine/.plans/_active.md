---
name: 2026-05-20_phase-5-3-conflict-resolution
date: 2026-05-20
status: STEPS-1-4-SHIPPED-AUDIT-CLOSED — steps 5 (3-way megaudit) + 6 (exit packet) remain
arc_estimate: 4-5 days (4 cycles spent; ~1 cycle remaining for step 5+6)
current_head: 6752ca2545c on feat/quantbook-engine (step 4 audit closures)
workspace_tests: 4334 / 0 with --test-threads=1
predecessor: docs/phase5/d-1-exit-packet.md (D-1 SHIPPED 2026-05-20 at HEAD 6289c4f3d4a)
audit_discipline: parallel Codex+Opus per ship + 3-way megaudit at closure (per D-1 precedent)
audit_cycles_in_phase_5_3: 8 (4 per-step + 4 closure), 6 consecutive divergent-HIGH
audit_transcripts: docs/audits/2026-05-20-phase-5-3-step-{1,2,3,4}-{codex,opus,consolidated}.md (12 files)
---

# Phase 5.3 — Conflict Resolution Semantics

## Background

Phase 5.1 audit-locked the conflict-matrix table at `crdt-data-model.md:311-334` and explicitly deferred two items to 5.3:

1. **Conflict-matrix formalization** — 7 op-pair rows whose default behavior is "last-in-causal-order wins" (Loro's Fugue/origin-based merge, NOT Lamport LWW). Most are correct by Loro's design; 5.3 makes them load-bearing via test pins.
2. **Causality-aware rename-repair pass** — the actual hard work. Concurrent edits authored against an old sheet name produce `BindError::UnknownSheet → #NAME?` after merge (V1 limitation, D-3 shipped the mapping). 5.3 makes those formulas RESOLVE by rewriting their text post-merge.

## Critical finding from code survey (replay.rs:486-532)

**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**

## Audit-locked design decisions (will be documented in 5-3-exit-packet.md)

### D-5.3-1 — Repair pass invocation
**Decision: caller-driven, NOT hooked into merge_bytes.** Standalone function `repair_sheet_rename_chain(workbook, log) -> RepairReport`. Caller invokes after `merge_bytes` + `replay_into` + before `recompute_all`. Matches existing pattern (replay + recompute are caller-driven; no magic in merge_bytes).

**Alternative considered**: hook into `CollabSession::merge_bytes_with_repair`. Rejected because it couples merge to repair (callers may want manual control for batch-merge scenarios).

### D-5.3-2 — Repair algorithm
**Decision: chain-based, NOT causality-aware.** Build `(old_canonical → new_name)` chain by sheet_id from `Op::RenameSheet` ops in the log; walk all formulas; rewrite text via the existing `rewrite_formula_text_for_sheet_rename` helper (sheets.rs:37-60).

**Why chain-based over causality-aware**:
- Helper returns `None` on no-change → idempotent. A formula already-referencing the new name won't be rewritten.
- Doesn't require exposing Loro causality types (frontiers, OpIds) in our public API. The survey confirmed `OpLog` exposes no causality query surface; adding one is a significant architectural change.
- Covers the user-visible case: formula authored against old name post-merge gets rewritten.
- Edge cases: rename-then-drop produces #NAME? (sheet gone) — correct. Rename-back (S1→S2→S1) produces identity chain — helper no-ops via canonical comparison.

### D-5.3-3 — Concurrent RenameSheet policy (step 2 fix)
**Decision: last-in-causal-order wins; second rename targets the current sheet name.** Replay case 3 (current ≠ old ≠ new) currently errors. New behavior:
- Sheet still exists at id → apply rename to whatever the sheet currently is (peer's `old_name` is "what they thought was current"; if reality has moved on, rename current to new).
- Sheet was dropped → existing `InvalidSheet` error (genuine corruption case).

**Rationale**: matches the "last-in-causal-order wins" rule already documented for SetName. Avoids hard-failing replay on a policy decision. The sheet name converges deterministically because Loro's causal order is deterministic across peers.

### D-5.3-4 — Repair pass module location
**Decision: `crates/ql-collab/src/repair.rs` (NEW)**, re-exported as `ql_collab::repair_sheet_rename_chain`. Lives in ql-collab because:
- Repair is a CRDT-merge concern, not a workbook concern. ql-storage shouldn't depend on it.
- ql-collab is the natural orchestration layer that callers already use for merge.
- Keeps ql-exec out of merge semantics (ql-exec is the producer-side runtime).

### D-5.3-5 — Repair report shape
**Decision**:
```rust
pub struct RepairReport {
    pub formulas_rewritten: usize,
    pub sheets_with_renames: Vec<(SheetId, Vec<(String, String)>)>, // (sheet, chain of old→new pairs)
    pub unresolved: Vec<UnresolvedRepair>, // e.g., formula references sheet that was renamed AND dropped
}
```
Surfaces what was done (for caller logging) + what couldn't be repaired (analogous to `XlsxExportReport.dropped_features`'s explicit-loss pattern). Per the no-fallbacks rule.

### D-5.3-6 — Scope of repair
**In scope**: `Op::RenameSheet` chains.
**Out of scope (V1 → defer to 5.3 step 4 or later)**: `Op::RenameTable`, `Op::RenameColumn`. Same problem shape, but step 4 will determine if replay already handles them (DropTable currently → bind fails → #NAME? per D-3) or needs the same fix.
**Permanently out of scope**: drop-table repair. There's no "old → new" mapping for the repair to follow; #NAME? is the correct outcome.

### D-5.3-7 — Schema impact
**Decision: NONE.** 5.3 is purely additive — runtime correctness fix. No `WORKBOOK_SCHEMA_VERSION` or `OPLOG_SCHEMA_VERSION` bump. Old workbooks load identically; repair is a new caller-invoked function with no on-disk format implications.

## Phased plan

### Step 1 — Conflict matrix test pinning ✅ SHIPPED 2026-05-20
- Ship: `5595d8dcfb0` + fmt-reconcile `a6babc65b51`
- Audit closure: `03408fa17bd` (3rd consecutive divergent-HIGH cycle)
- Tests: 9 (added new row 7 RenameSheet pre-fix during audit closure)
- KEY DISCOVERY: CRDT convergence requires STABLE non-zero peer-ids. `fork_with_peer(base, peer_id)` helper. Documented in `crdt-data-model.md` § "Peer-id stability is a precondition for CRDT convergence".
- Audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-1-{codex,opus,consolidated}.md`

### Step 2 — Concurrent RenameSheet replay fix ✅ SHIPPED 2026-05-20
- Ship: `1ed2bbba78a`
- Audit closure: `f426683fee0` (4th consecutive divergent-HIGH cycle — both auditors caught HIGH-1: cross-sheet target collision still hard-failed pre-closure)
- Tests: 7 (added 2 audit-closure regressions: cross-sheet auto-disambig + case-only rename)
- Replay handler: unified case 2+3 logic; D-2-style auto-disambig for cross-sheet target collision; case-only renames apply via display equality check
- Variant deprecation: `ReplayError::SheetRenameNameMismatch` `#[deprecated]`
- Audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-2-{codex,opus,consolidated}.md`

### Step 3 — Rename-repair pass ✅ SHIPPED 2026-05-20 (CORE 5.3 WORK)
- Ship: `e76a9ce5499` + lockfile `4222d11fe7b`
- Audit closure: `6bb76e3ade3` (5th consecutive divergent-HIGH cycle — both auditors caught HIGH: cascade corruption from rule iteration)
- Tests: 13 (10 original + 3 audit closures)
- NEW MODULE: `ql_collab::repair_sheet_rename_chain` + `RepairReport` + `SheetRewriteSummary` + `AmbiguousSkip`
- Algorithm: chain-based + safety guard (skip rules where `old_canonical` is currently held by ANY sheet — closes cascade + reused-name corruption)
- Row 7 of conflict matrix: MODIFIED to assert post-repair behavior (resolves to correct value instead of #NAME?)
- Audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-3-{codex,opus,consolidated}.md`
- Deferred (V2): helper unification (now 3 call sites; would prevent step-4 expansion to 5+); production wiring (caller-driven by design)

### Step 4 — RenameTable/RenameColumn extension ✅ SHIPPED 2026-05-20
- Ship: `7126eb44396`
- Audit closure: `6752ca2545c` (6th consecutive divergent-HIGH cycle — both auditors caught 2 HIGHs: (a) auto-disambig + repair mismatch corrupts cross-table formulas; (b) column repair pass missing)
- Tests: 14 (6 replay + 8 table repair; 2 reframed for hard-fail post-revert; 2 new for transitive chain + BatchCommit)
- Replay: `apply_rename_table` + `apply_rename_column` — advisory-skip for missing source (concurrent rename); hard-reject on cross-source target collision (audit-CLOSURE revert)
- NEW: `repair_table_rename_chain` + `TableRepairReport` + `TableRewriteSummary` + `TableAmbiguousSkip`
- Audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-4-{codex,opus,consolidated}.md`

**Step 4 audit REVERT** (Codex+Opus HIGH × 2):
- Pre-closure: replay auto-disambig'd target collision via X → X(2) suffix walk (mirroring step 2). Repair pass keyed history by op's wire `new_name="X"` → mis-mapped to actual canonical X(2) → silent cross-table reference corruption.
- Post-closure: REVERTED auto-disambig. Cross-source target collision now hard-fails with `TableCreateRejected` / `TableColumnRejected`. V1 limitation documented.
- Preserved: advisory-skip for missing-source (the original Opus step-1-audit M-2 closure).

**V1 limitations stack from step 4 audit closure** (deferred to V2 / step 5 megaudit assessment):
- Cross-source target collision hard-fails (tables, columns)
- Column repair pass missing
- DropTable hard-fails on concurrent RenameTable (Opus M-1)
- Case-only rename policy inconsistency across sheet/table/column (Opus M-3)
- Helper duplication (5+ call sites; Opus step-3 M-1 deferred from step 3 audit)
- Production wiring missing (Opus step-3 M-3)

### Step 5 — 3-way megaudit (~0.5 day) ⏳ NEXT
Codex (cross-step + grep) + Opus-A (empirical 2-peer + adversarial randomized interleavings + production wiring check) + Opus-B (doc completeness + helper duplication + cross-crate consistency).

**Megaudit MUST re-examine the V1 limitations stack** from step 4 audit closure (above) for V2 prioritization. Specifically:
- Is the cross-source target collision hard-fail acceptable as V1? Or should V2 thread a disambig-trace through replay→repair?
- Should column repair pass land in V1, or is the gap acceptable?
- Audit-prompt the auditors to construct ADVERSARIAL probes attempting to break the safety guard via odd scenarios (e.g., 3+ chained renames + cross-sheet ambiguity + concurrent edits)

Per D-1 step-8 megaudit pattern: dispatch all 3 lanes IN PARALLEL (not sequential) to avoid anchoring.

### Step 6 — Exit packet + handoff refresh (~0.5 day)
Write `docs/phase5/5-3-exit-packet.md` mirroring `d-1-exit-packet.md` structure. Refresh:
- `docs/MASTER-PLAN.md` § Phase 5.2 sub-items
- `docs/phase5/v1-exit-packet.md` (5.3 status row → ✅)
- `docs/phase5/entry-plan.md` (5.3 table row)
- `docs/architecture/crdt-data-model.md` (final V1 state + audit-locked limitations)
- `docs/architecture/ide-consumer-contract.md` (5.3-introduced API: `repair_sheet_rename_chain`, `repair_table_rename_chain`, etc.)
- `MEMORY.md` + `current_work.md` (handoff)

Final commit. Verify clean checkout + 3-fold gates.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Step 1 probe tests reveal hidden gaps beyond the matrix | M | Triage on discovery: small gaps → close in step 1; large → file follow-up tasks |
| Step 2's policy change breaks existing rename tests | L | Existing rename tests use single-writer paths (no concurrent renames); the change only affects case 3 which is currently unreachable in single-writer |
| Step 3's repair pass has cross-sheet interaction with names/tables | M | Defined out of scope (D-5.3-6); 5.3.b can extend if needed |
| Loro's causal-order is non-deterministic for byte-tied concurrent ops | L (verified by D-4 probes) | Reuse D-4's order-independence assertion pattern (test both merge directions) |
| Repair-pass idempotency assumption breaks on edge case | L | Helper's `None`-on-no-change is the safety net; test-pin idempotency explicitly |
| Index-padding race during commits | L | 4 incidents total (3 V1 + 1 D-1 step 7); mitigation pattern (re-stage + verify) is reliable |

## Open questions for the user (sign-off needed)

ALL CLOSED:
1. ~~Priority confirmation (5.3 vs 5.5 V2 V2/V3 vs other)~~ → user said "Proceed with 5.3 as planned" (AskUserQuestion at session start). After 5.3 ships, the recommended sequence is **5.5 V2 V2/V3 (production transport) → 5.7 IDE slice → 5.8 Phase 5 megaudit** per D-1 exit packet priority guidance.
2. ~~D-5.3-3 policy~~ → user said "Last-in-causal-order wins; apply to current". Shipped in step 2.
3. ~~D-5.3-4 module location~~ → engineered's-discretion call: `ql-collab/src/repair.rs` shipped.
4. ~~Step 4 scope~~ → shipped + audit-closure REVERTED auto-disambig (V1 limitation). Column repair pass deferred to V2.

## Audit-cycle observations (steps 1-4)

Each step's parallel Codex+Opus audit found at least one HIGH that the engineer's confirmation bias missed. The 6-consecutive divergent-HIGH pattern is **structurally validated**:

| Step | Codex HIGHs | Opus HIGHs | Convergent | Notable |
|---|---|---|---|---|
| 1 | 1 (row 3 degenerate) | 1 (same) | YES | Tests were tautological — same value for both winners |
| 2 | 1 (cross-sheet target collision still hard-fails) | 1 (same) | YES | My step-2 fix was incomplete |
| 3 | 2 (cascade + reused-name) | 1 (same root cause) | YES | Single safety guard closed both scenarios |
| 4 | 2 (auto-disambig + repair mismatch + column repair gap) | 2 (same) | YES | Closure REQUIRED revert; can't fix in-place without API change |

In every cycle, the audit closure surfaced V1 limitations to document. Step 5 megaudit should consolidate all V1 limitations into a single section of the exit packet, and surface helper-unification + production-wiring as actionable V2 follow-ups.

## Exit criteria

- All 6 step tasks marked complete. **CURRENT: 4/6 complete (steps 1-4); steps 5-6 remain.**
- Workspace tests at 4291 + N. **CURRENT: 4334** (+43 net across 5.3).
- fmt + clippy clean.
- 5.3 exit packet shipped.
- 5+ audit cycles run (one per shipped step + megaudit).
- All audit findings closed or explicitly V2-deferred with rationale.
- Memory + current_work.md updated.

## Cross-references

- Design doc preview: `quantbook-engine/docs/architecture/crdt-data-model.md` § 311-334 (Conflict resolution semantics)
- D-3 V1 limitation note: `crdt-data-model.md` § 615-648
- D-1 closure record (precedent for arc structure): `docs/phase5/d-1-exit-packet.md`
- D-4 2-peer test pattern (template): `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs`
- Producer-side rename machinery: `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60, 146-224`
- Replay's RenameSheet handler (the bug + fix site): `crates/ql-oplog/src/replay.rs:486-532`
