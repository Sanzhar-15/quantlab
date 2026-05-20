---
name: 2026-05-20_phase-5-3-conflict-resolution
date: 2026-05-20
status: AWAITING-USER-SIGNOFF
arc_estimate: 4-5 days (matches design-doc estimate of 4-7 days)
predecessor: docs/phase5/d-1-exit-packet.md (D-1 SHIPPED 2026-05-20 at HEAD 6289c4f3d4a)
audit_discipline: parallel Codex+Opus per ship + 3-way megaudit at closure (per D-1 precedent — 17/17 audit cycles caught real bugs)
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

### Step 1 — Conflict matrix test pinning (~1 day)
NEW: `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`. 7 probe tests following the D-4 pattern. Most should PASS already (Loro CRDT handles last-in-causal-order). Failures = real gaps that become step 1.5 work.

**Per-step audit (Codex + Opus parallel)** — discipline rule.

### Step 2 — Concurrent RenameSheet replay fix (~0.5 day)
Edit `crates/ql-oplog/src/replay.rs:486-532`. Change case 3 from error to "apply rename to current name." Add 2-peer probe test pinning convergence.

**Per-step audit** — auditors typically find policy edges (e.g., what if sheet was BOTH renamed AND dropped concurrently? Step 2 needs a clear answer).

### Step 3 — Rename-repair pass (~1.5-2 days, CORE 5.3 WORK)
- NEW: `crates/ql-collab/src/repair.rs` — `repair_sheet_rename_chain` + `RepairReport` + `UnresolvedRepair` (~150 LOC).
- Edit `crates/ql-collab/src/lib.rs` — re-export.
- NEW: `crates/ql-collab/tests/repair_renames.rs` (~300 LOC) — 2-peer probes covering:
  - Concurrent rename + concurrent edit (the canonical case)
  - Transitive rename chain (S1→S2→S3 across multiple peers)
  - Rename-back (S1→S2→S1; chain collapses)
  - Rename-then-drop (formula gets rewritten to dropped sheet → #NAME?)
  - No-op case (formula references unrenamed sheet)

**Per-step audit** — highest-impact step; audit thoroughly.

### Step 4 — RenameTable/RenameColumn investigation (~0.5-1 day)
Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.

**May be ~0 work or up to 1 day** depending on what replay does.

**Per-step audit if non-trivial.**

### Step 5 — 3-way megaudit (~0.5 day)
Codex (cross-step + grep) + Opus-A (empirical 2-peer + adversarial randomized interleavings) + Opus-B (doc completeness + cross-crate). Per D-1 precedent.

### Step 6 — Exit packet + handoff refresh (~0.5 day)
Write `docs/phase5/5-3-exit-packet.md` mirroring D-1 structure. Refresh 6 surfaces (MASTER-PLAN, v1-exit-packet, entry-plan, crdt-data-model, ide-consumer-contract, MEMORY). Final commit. Verify gates.

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

1. **Priority confirmation**: D-1 exit packet recommended 5.3 next. You said "take off from wherever is optimal." Is 5.3 the right call vs. 5.5 V2 V2/V3 production transport (larger scope, unblocks IDE) or 5.7 IDE slice (depends on 5.3 + 5.5)?
2. **D-5.3-3 policy on concurrent renames**: "last-in-causal-order wins; rename current to new" vs. alternative ("first wins; second becomes auto-rename like D-2 AddSheet"). I've recommended the former (matches SetName); flagging in case you prefer the AddSheet-style auto-rename for consistency.
3. **D-5.3-4 module location**: `ql-collab/src/repair.rs` vs. `ql-exec/src/repair.rs`. I picked ql-collab (CRDT concern). Flagging in case you have a different read of the layering.
4. **Step 4 scope**: should RenameTable/RenameColumn repair be IN scope for 5.3, or deferred to a follow-up? My read: investigate in step 4, extend if cheap, defer if not. Acceptable?

## Exit criteria

- All 6 step tasks marked complete.
- Workspace tests at 4291 + N (≥ 4310 expected from probe tests + repair tests).
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
