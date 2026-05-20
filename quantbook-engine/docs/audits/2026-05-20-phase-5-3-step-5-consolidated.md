---
title: Phase 5.3 step 5 megaudit synthesis (3-way full-arc megaudit)
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~223k tokens) — full transcript: `2026-05-20-phase-5-3-step-5-codex.md`
  - Opus-A subagent (117k tokens, 716s) — full transcript: `2026-05-20-phase-5-3-step-5-opus-a.md`
  - Opus-B subagent (156k tokens, 542s) — full transcript: `2026-05-20-phase-5-3-step-5-opus-b.md`
audit_target: full Phase 5.3 arc at HEAD `18ad97d5725` (4 ship + 4 audit closure commits below it)
closure_commit: (TBD — depends on user-selected closure scope)
phase: Phase 5.3 step 5 (3-way megaudit — final pre-exit-packet audit)
audit_cycle_count: 7th consecutive divergent-HIGH cycle in Phase 5.3 (8 per-step + this megaudit = 9 cycles total)
---

## Engagement headline

Three parallel lanes (Codex tactical, Opus-A adversarial empirical, Opus-B doc completeness) ran independently against the full 5.3 arc. All three converged on findings the per-step audits missed. **Combined verdict: FAIL** (Codex framing — the documented V1 limitation set is empirically incomplete + the ship is "in-principle but not in-practice" for real users).

The findings split into two categories:
- **System-integration HIGHs** the per-step audits missed because they only saw one step's scope: production wiring missing, `replay_into` non-atomicity, column repair pass missing, DropTable × RenameTable order-dependence.
- **Doc-completeness HIGHs** that step 6 is supposed to close but step 6 hasn't started: IDE consumer contract omits 5.3 surface, V1 limitations have no durable home, 5 user-facing surfaces are stale.

The 6 consecutive divergent-HIGH per-step audit cycles validate the discipline structurally; this 7th megaudit validates that **the per-step audit pattern has a blind spot for cross-step + cross-handler invariants + production-wiring** — exactly what the megaudit format is supposed to catch.

## Consolidated findings (all 3 lanes deduplicated)

### HIGH — system-integration (4 unique + 1 latent + 1 inferred = 6)

#### H-S1. Production wiring missing — `CollabSession::merge_bytes` does not call replay+repair
- **Sources**: Opus-A Scenario E HIGH; Opus-B MEDIUM-4 (severity disagreement; Opus-A's HIGH stands because Opus-A actually grep-verified zero non-test callers).
- **Evidence**: grep for `repair_sheet_rename_chain|repair_table_rename_chain` in production paths returns zero callers. `CollabSession::merge_bytes` (session.rs:252-254) is a thin wrapper around `OpLog::merge_bytes`; no replay, no repair invocation.
- **Production impact**: real users running `CollabSession::merge_bytes` + downstream `replay_into` + `recompute` will STILL see `#NAME?` for concurrent-rename formulas. The 5.3 ship is correct in-principle but does not close the D-3 V1 limitation in-practice.
- **Closure options**:
  1. **(Preferred)** Add `CollabSession::sync_workbook(&mut self, &mut Workbook, &FunctionRegistry) -> Result<RepairReport+TableRepairReport>` that does `replay_into` → `repair_sheet_rename_chain` → `repair_table_rename_chain`. Estimated ~2-4h.
  2. **(Minimal)** Extend `op_log` docstring example at `session.rs:281` with the repair call sequence + add an integration test that exercises `merge_bytes → replay_into → repair → recompute` end-to-end. Estimated ~1h.

#### H-S2. Column repair pass missing — `repair_column_rename_chain` does not exist
- **Sources**: Opus-A V1 LIM #3 HIGH; Opus-B MEDIUM-5.
- **Evidence**: peer A renames column `T.A→C`; peer B writes `=T[A]+1` concurrent; after merge + `repair_table_rename_chain`, formula still references `T[A]` → recompute surfaces `#REF?`/`#NAME?`.
- **Production impact**: column renames are the most common rename target. Every concurrent column-rename-plus-formula scenario silently breaks.
- **Closure**: ship `repair_column_rename_chain` (~1d implement + 2 audit cycles per Opus-A's estimate). `ql_formula_syntax::rewrite_column_ref` already exists. Chain-walker needs to be table-aware (key by `(table_canonical, old_col_canonical) → new_col_display`). Safety guard mirrors table version.

#### H-S3. `replay_into` non-atomic on cross-source collision hard-fail (V1 LIM #1)
- **Sources**: Opus-A HIGH-1 (unique to that lane).
- **Evidence**: peer A `T1→X` + `PutFormula`; peer B `T2→X` + `PutFormula`; merge + replay. Result: peer A's rename + PutFormula APPLIED before the hard-fail; peer B's rename rejected; peer B's PutFormula never attempted; caller gets `Err(TableCreateRejected)` but workbook is in a half-merged corrupt state.
- **Root cause**: `replay_into` at `replay.rs:351-363` is a simple for-loop with `?` short-circuit. No transactional rollback. Caller contract is undocumented.
- **Closure options**:
  1. **(Cheapest)** Document on `replay_into` docstring: "On Err, workbook is in a partially-replayed state. Caller MUST discard the workbook." ~30min.
  2. Snapshot/restore via workbook clone before replay; restore on error. Memory cost.
  3. Two-phase replay (dry-run validate, then apply). Compute cost.
  4. (V2) Soft-fail with synthesized correction op + advisory skip.

#### H-S4. DropTable × concurrent RenameTable order-dependent failure (V1 LIM #4)
- **Sources**: Codex HIGH-1; Opus-A V1 LIM #4 MEDIUM (severity disagreement; Codex's HIGH stands because the documented V1 limitation is empirically WRONG).
- **Evidence** (Codex empirical probe + Opus-A confirmation):
  - `drop(T)` then `rename(T→T2)` causal merge: replay Ok, table absent ✓
  - `rename(T→T2)` then `drop(T)` causal merge: `Err(TableNotFound { index: 5, name: "T" })` ✗
- **Root cause**: `Op::DropTable` at `replay.rs:682-691` hard-fails on missing source; `apply_rename_table` at `replay.rs:809-822` advisory-skips. Same bug class as step 4 audit M-1 (Opus, not closed).
- **Closure**: extend `Op::DropTable` handler with the same "if not found, idempotent OK" pattern. Trivial: `if workbook.tables().lookup(&canonical).is_none() { return Ok(()); }`. ~30min implement + permanent two-order regression test ~30min. **Total ~1h**.

#### H-S5. Mismatched workbook ↔ log silent formula corruption (HIGH-latent)
- **Sources**: Opus-A Probe X.
- **Evidence**: calling `repair_sheet_rename_chain(&mut wb, &log)` where `wb` has sheet 0 named "OtherSheet" and `log` says sheet 0 was renamed S→S2 produces `=S!A1 → Some("OtherSheet!A1")` — silent formula corruption.
- **Mitigation already in place**: docstring caller contract at `repair.rs:14-31` mandates `replay_into → repair`. But without production wiring (H-S1), the docstring is the only contract.
- **Closure**: depends on H-S1. If H-S1 closes via wrapper (Option 1), latent risk eliminated. If H-S1 closes via docstring (Option 2), add debug-assert to repair that historic_by_sheet sheet_ids correspond to live workbook sheets with expected post-replay names.

#### H-S6. Cross-source column collision (V1 LIM #2) — inferred parallel to H-S3
- **Sources**: Opus-A inferred HIGH.
- **Evidence**: not directly probed; parallel to H-S3 (`apply_rename_column` also uses simple for-loop with `?`).
- **Closure**: same closure as H-S3 (docstring on `replay_into` covers it).

### HIGH — doc-completeness (3 unique = 3)

#### H-D1. IDE consumer contract omits all 8 of 5.3's public surface; conflict matrix omits step-4 table/column rows
- **Source**: Opus-B HIGH-1.
- **Evidence**: `ide-consumer-contract.md` § "Phase 5 collaboration surface" (lines 198-209) does NOT mention `repair_sheet_rename_chain`, `repair_table_rename_chain`, `RepairReport`, `SheetRewriteSummary`, `AmbiguousSkip`, `TableRepairReport`, `TableRewriteSummary`, `TableAmbiguousSkip`. The conflict matrix at `crdt-data-model.md:320-332` has 11 rows: 4 RenameSheet, 0 RenameTable, 0 RenameColumn; DropTable row doesn't mention concurrent RenameTable.
- **Closure (step 6)**: insert "Post-merge rename-repair (Phase 5.3 step 3+4)" section in IDE contract with the API list + caller-driven design rationale. Add 4+ new rows to crdt-data-model.md conflict matrix.

#### H-D2. V1 limitations stack documented only in gitignored `.plans/_active.md`; will vaporize at step 6 archival
- **Source**: Opus-B HIGH-2.
- **Evidence**: `docs/PHASE-4-V2-BACKLOG.md` has NO 5.3 / Phase-5 tier. The plan file (gitignored) is the only durable home for items H-S1, H-S2, H-S3, H-S4 (the system-integration V1 limitations).
- **Closure (step 6, MUST happen before `_active.md` archives)**: add `## Tier H — PHASE 5.3 V1 LIMITATIONS (deferred to V2)` section to `PHASE-4-V2-BACKLOG.md` enumerating: H1 helper unification, H2 column repair pass, H3 cross-source target collision policy, H4 DropTable+RenameTable, H5 case-only rename consistency, H6 production wiring docs, H7 lookup_column doc inversion, H8 `replay_into` atomicity.

#### H-D3. All 5 user-facing 5.3-mention doc surfaces are stale (forward-tense)
- **Source**: Opus-B HIGH-3; Codex LOW-2 (same finding, different severity — Opus-B's HIGH stands).
- **Evidence**: `MASTER-PLAN.md:573` ("5.3 ... — future"); `v1-exit-packet.md:21, 226` ("5.3 ... remain ahead"); `entry-plan.md:116`; `crdt-data-model.md:645, 676` ("until 5.3 ships"); `ide-consumer-contract.md:195` ("deferred to Phase 5.3"). All STALE post-step-4-ship.
- **Closure (step 6)**: already in `_active.md:135-140` step 6 list — confirmed covers all 5 sites.

### MEDIUM (4 unique)

#### M1. Helper duplication confirmed at 5 sites — convergent across ALL 3 lanes
- **Sources**: Codex MEDIUM-1; Opus-A Scenario F discussion; Opus-B MEDIUM-1.
- **Evidence**: 5 call sites:
  1. `ql-collab/src/repair.rs:354-361` (`rewrite_formula_with_rename`)
  2. `ql-collab/src/repair.rs:547-554` (`rewrite_formula_with_table_rename`)
  3. `ql-exec/src/workbook_runtime/sheets.rs:42-58` (`rewrite_formula_text_for_sheet_rename`)
  4. `ql-exec/src/workbook_runtime/tables.rs:323-336` (inline in `rename_table`)
  5. `ql-exec/src/workbook_runtime/tables.rs:467-484` (inline in `rename_column`)
- **Closure (V2 backlog)**: single public `rewrite_formula_text(text, NameRewrite)` in `ql-formula-syntax` (~50 LOC add, ~52 LOC remove, net -2 LOC). Detailed unification plan in Opus-B transcript.

#### M2. `lookup_column` doc says "uppercases" but code lowercases (step 4 L-3 still open)
- **Source**: Opus-B MEDIUM-2.
- **Evidence**: `crates/ql-storage/src/tables.rs:199-210` — doc line 201 says "uppercases the query first"; code line 204 calls `to_ascii_lowercase()`.
- **Closure**: 1-line doc fix; can ship in step 5 or step 6.

#### M3. Case-only rename policy inconsistency across sheet/table/column (V1 LIM #5)
- **Sources**: Opus-A V1 LIM #5; Opus-B MEDIUM-3.
- **Evidence** (3-way inconsistency):
  - Sheet `S→s`: APPLIED (display equality post-step-2)
  - Table `T→t`: silent NO-OP (same-canonical check)
  - Column `A→a`: REJECTED (`TableColumnRejected`)
- **Closure**: V2 backlog Tier H entry. Document the policy difference in `crdt-data-model.md`. Long-term: align all three on "case-only changes mutate display."

#### M4. Safety guard misroutes peer B formula intent (Scenario D-2)
- **Source**: Opus-A Scenario D-2.
- **Evidence**: safety guard correctly prevents cascade-corruption HIGH from step 3 audit, but the trade-off is peer B's formula intent (originally referencing peer A's sheet 0 with name S) gets silently rebound to peer B's NEW sheet 1 (named S). `ambiguous_rules_skipped` reports this but no production caller reads it.
- **Closure**: V2 — causality-aware repair via Loro op-ids. For V1, surface in `crdt-data-model.md` D-3-V1-limitations section as "name resurrection → silent reference reroute."

### LOW (6 unique)

- **L1.** Whitespace canonicalization side effect (Opus-A Scenario F): repair-touched formulas get parse/print-normalized whitespace + function case. Document in `repair.rs` module docstring.
- **L2.** `repair.rs:91-97` docstring overstates risk (Opus-A V1 LIM #6): chain walker captures intermediates correctly via `old_name`. Reframe.
- **L3.** `repair.rs:84-88` docstring says "rule-iteration order picks" but real mechanism is "first rewrite consumes the source token" (Opus-A LOW). Clarify.
- **L4.** `docs/known-gaps.md:113` GAP-C-02 target phase 5.3 needs ✅ marker (Opus-B LOW-1).
- **L5.** `entry-plan.md:186` cross-refs phantom `conflict-resolution.md` (Opus-B LOW-2). Delete or redirect.
- **L6.** Naming asymmetry `RepairReport` vs `TableRepairReport` (Opus-B LOW-3). Stylistic; consider `SheetRepairReport` for symmetry.
- **L7.** Stale prose in 5.3 test files (Codex LOW-1):
  - `phase_5_3_conflict_matrix_probe.rs:27` still says row 7 is PRE-FIX
  - `phase_5_3_step4_table_column_concurrent.rs:11` still claims auto-disambig
  - `repair.rs:99` still says step 4 adds column repair
  - `crdt-data-model.md:645` still says 5.3 will add rename repair

## Convergence pattern (audit-discipline observation)

| Finding | Codex | Opus-A | Opus-B | Convergent? |
|---|---|---|---|---|
| Helper duplication = 5 sites | YES (M) | YES (mentioned) | YES (HIGH-2 via V2 backlog gap) | **3-way** |
| Production wiring missing | (didn't probe) | YES (HIGH) | YES (MEDIUM-4) | 2-way |
| DropTable × RenameTable order-dependent | YES (HIGH) | YES (MEDIUM) | (didn't probe) | 2-way |
| Doc rot on 5 surfaces | YES (LOW) | (out-of-scope) | YES (HIGH-3) | 2-way |
| Column repair missing | (mentioned LOW) | YES (HIGH) | YES (MEDIUM-5) | 2-way |
| `replay_into` atomicity | (didn't probe) | YES (HIGH) | (out-of-scope) | 1-way |
| Mismatched workbook latent | (didn't probe) | YES (HIGH-latent) | (out-of-scope) | 1-way |
| IDE contract omits 5.3 surface | (didn't probe) | (out-of-scope) | YES (HIGH-1) | 1-way |
| V1 limits no durable doc home | (mentioned) | (out-of-scope) | YES (HIGH-2) | 1-way |

**Audit-discipline conclusion**: 3-way megaudits add value beyond per-step audits PRECISELY because each lane finds different things:
- Opus-A's empirical adversarial lane found 4 HIGHs invisible to per-step audits (system-integration view)
- Opus-B's doc-completeness lane found 3 HIGHs invisible to system-integration view
- Codex's tactical lane validated the system-integration view + caught a HIGH severity escalation on a V1 limitation

The 6 consecutive divergent-HIGH per-step cycles plus this 7th megaudit-divergence pattern is structurally load-bearing.

## Closure scope decision (USER SIGN-OFF NEEDED)

Step 5 megaudit closure work splits into 3 tiers by user-budget cost:

### Tier MINIMAL (~3h work + 1 audit cycle): close trivial HIGHs + doc HIGHs in step 6
- **H-S4** DropTable advisory-skip (~1h: implement + 2-order regression test)
- **H-S3** `replay_into` atomicity docstring (~30min)
- **H-S5** repair-debug-assert added (~30min)
- **M2** `lookup_column` doc fix (~5min)
- **L1, L2, L3, L7** docstring + test-prose cleanups (~30min)
- All H-Dx + V1-limitation doc work rolls into step 6 (~0.5d)

Total: ~3h step 5 closure + ~0.5d step 6 exit packet.

### Tier MEDIUM (~6-8h work + 2 audit cycles): + minimal production wiring closure
- All of MINIMAL, PLUS:
- **H-S1 (minimal)** docstring example update + integration test for `merge_bytes → replay → repair → recompute` (~1h + 1 audit cycle)

Total: ~5h step 5 closure + ~0.5d step 6 exit packet.

### Tier FULL (~2 days work + 3 audit cycles): + column repair + production wiring wrapper
- All of MEDIUM, PLUS:
- **H-S1 (preferred)** add `CollabSession::sync_workbook` wrapper (~3h + 1 audit cycle)
- **H-S2** ship `repair_column_rename_chain` (~1d + 2 audit cycles per Opus-A's estimate)

Total: ~2 days step 5 work + ~0.5d step 6 exit packet.

## Recommended closure (engineer's-judgment)

**Tier MINIMAL** is the right scope. Rationale:
- H-S1 (production wiring) is audit-locked as caller-driven by D-5.3-1. Adding the wrapper doesn't change correctness; just ergonomics. Docstring example update + integration test (Opus-A's Option 2) achieves equivalent correctness lock without API churn.
- H-S2 (column repair) is the LARGEST single V1 limitation. Shipping it would essentially be Phase 5.3 step 7. Phase 5.3 was scoped as 4-7 days at start; we're now at 4-5 days actual. Adding step 7 takes us to 5-6 days — over budget. Better V2 with a Tier H1 entry in the backlog so it's not lost.
- H-S4 (DropTable) is empirically wrong V1 documentation that's CHEAP to fix (~1h). Closing it now removes a permanent gotcha.
- Step 6 doc HIGHs (H-D1, H-D2, H-D3) all roll into the planned step 6 work; no extra cycle.

The 6-consecutive-divergent-HIGH pattern + this megaudit's findings argue for closing H-S4 + H-S3 + the trivial MEDIUMs/LOWs now, then crisp step-6 exit packet. The H-S1 + H-S2 work goes to V2 with strong rationale.

## Forward implications

- After step 5 closure: workspace test count expected at ~4338-4342 (depending on Tier choice).
- Step 6 work scope: 6-surface refresh + V2 backlog Tier H + crdt-data-model row additions + IDE contract API surface insertion + `lookup_column` doc fix + the H-D doc surfaces.
- After Phase 5.3 SHIPPED: V2 follow-up work (Tier H1-H8) becomes ~3-5 days of post-graduation polish. 5.5 V2 V2/V3 (production transport) is next per `d-1-exit-packet.md`.

## Cross-references

- Full audit transcripts:
  - Codex: `docs/audits/2026-05-20-phase-5-3-step-5-codex.md` (844 KB; raw `codex exec` output)
  - Opus-A: `docs/audits/2026-05-20-phase-5-3-step-5-opus-a.md`
  - Opus-B: `docs/audits/2026-05-20-phase-5-3-step-5-opus-b.md`
- Per-step audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-{1,2,3,4}-{codex,opus,consolidated}.md`
- Source-of-truth plan: `.plans/_active.md` (gitignored — see HIGH H-D2)
- Phase 5.3 design doc context: `docs/architecture/crdt-data-model.md` § 311-360
