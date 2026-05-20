---
title: Phase 5.3 step 5 megaudit — Opus-A subagent verdict (adversarial probe synthesis + production wiring lane)
date: 2026-05-20
audit_target: full Phase 5.3 arc at HEAD `18ad97d5725` (4 ship+closure commits below it)
auditor: Opus-A subagent (independent of engineer; parallel with Codex + Opus-B)
tokens_used: 117059
tool_uses: 51
duration_ms: 715826
verdict: PASS-WITH-FINDINGS (4 HIGH including 1 latent + 1 inferred + 2 MEDIUM + 3 LOW)
lane: adversarial probe synthesis + production wiring check
---

# Phase 5.3 step 5 megaudit — Opus-A lane (adversarial probe synthesis + production wiring)

**Date**: 2026-05-20
**Auditor**: Opus-A (empirical adversarial lane)
**Repo**: `quantlab-quantbook` @ `feat/quantbook-engine` HEAD `18ad97d5725`
**Method**: 18 adversarial probes (Rust integration tests) executed against the shipped `ql-collab::repair_*` + `ql-oplog::replay` surfaces; outputs captured.

---

## Probe-by-probe findings

### Scenario A — 3-chain rename + concurrent edit
**Reproducer**: peer A appends `S→S2`, `S2→S3`, `S3→S4`; peer B writes `=S!A1`; merge + repair.

```
SCENARIO A final formula: Some("S4!A1")
SCENARIO A report: historic_canonicals: ["S", "S2", "S3"]; formulas_rewritten: 1
```

Also tested with `=S2!A1` and `=S3!A1` (intermediate-name references) → both correctly rewritten directly to `S4!A1`.

**Verdict**: PASS. `collect_rename_old_names` walks the full chain; all historic names captured. Intermediate names ARE captured because each op's `old_name` is what was current at that producer-side append. **Documentation claim in `repair.rs:90-97` is empirically validated.**

---

### Scenario B — Rename cycle S→T→S
**Reproducer**: peer A appends `S→T`, `T→S`; peer B writes `=S!A1` + `=T!A1`; merge + repair.

```
SCENARIO B sheet display = "S"
historic_canonicals: ["T"]  (S correctly filtered as matching current canonical)
=S!A1 -> Some("S!A1")  (current name UNCHANGED — guard not even needed because S is current)
=T!A1 -> Some("S!A1")  (intermediate T rewritten to current S)
```

**Verdict**: PASS. Cycle collapses cleanly — the current-canonical filter at `repair.rs:227-228` drops the self-rule, the intermediate-name rule fires correctly.

---

### Scenario C — Rename + concurrent NEW sheet same name + safety guard
**Reproducer**: peer A renames sheet 0 `S→S2`; peer B concurrently adds new sheet `S` (becomes sheet 1) and writes `=S!A1` on sheet 1.

```
sheet 0 = "S2", sheet 1 = "S"
ambiguous_rules_skipped: [AmbiguousSkip { origin_sheet: 0, historic_canonical: "S", current_holder_sheet: 1 }]
=S!A1 -> Some("S!A1")  (safety guard correctly prevented corruption)
```

**Verdict**: PASS. Codex HIGH-2 closure (the "S resurrected" case) is correctly guarded.

---

### Scenario D — Cross-sheet historic-name ambiguity (NEITHER held)
**Reproducer**: sheet 0: X→S→X1; sheet 1: Y→S→Y1; peer B writes `=S!A1`; merge + repair.

```
Sheet 0 historic_canonicals: ["S", "X"]
Sheet 1 historic_canonicals: ["S", "Y"]
=S!A1 -> Some("X1!A1")  (sheet 0 wins)
```

**Verdict**: PASS, but **documentation refinement recommended (LOW)**. The docstring at `repair.rs:84-88` says "rule-iteration order picks the winner (sorted by sheet id, so lowest sheet_id's rule fires first)." Empirically this IS what happens, BUT the real mechanism is "the substitution makes subsequent rules no-ops because the source token is gone." If a future refactor changed substitution semantics, the order would flip. Cite the implementation hazard, not just the order.

---

### Scenario D-2 — Safety guard correctness sub-probe
**Reproducer**: same as Scenario C, but peer B's formula intent was the OLD S (now S2).

```
ambiguous_rules_skipped engaged (origin 0, holder 1)
peer B's =S!A1 (originally meaning sheet 0) now binds to sheet 1 — SILENT semantic shift
```

**Severity**: MEDIUM (V1-locked behavior). The guard correctly skips to prevent the cascade-corruption HIGH from step 3 audit. But the trade-off is real: peer B's formula intent is silently misrouted to peer A's new sheet 1. **No production caller reads `ambiguous_rules_skipped`** (see Scenario E).

**Proposed closure**: V2 — causality-aware repair via Loro op-ids. For V1, surface this in the `crdt-data-model.md` D-3-V1-limitations section as "name resurrection → silent reference reroute."

---

### Scenario E — Production wiring missing **[CRITICAL HIGH]**

**Reproducer (grep, not test)**:
```
grep -rn "repair_sheet_rename_chain\|repair_table_rename_chain" \
  /Users/sanzhar/.../quantbook-engine/crates/ --include="*.rs" \
  | grep -v "tests/" | grep -v "^.*://"
```

Result — ALL non-test, non-doc references:
- `crates/ql-collab/src/lib.rs:105` (re-export only)
- `crates/ql-collab/src/repair.rs:176,385` (definitions)

**Zero callers in production paths**:
- `CollabSession::merge_bytes` at `session.rs:252-254` is a thin wrapper around `OpLog::merge_bytes`. No replay, no repair.
- `ql-exec` (WorkbookRuntime) has **no `merge_bytes` or `repair_*` invocation**.
- The only non-test caller is `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs` (test).

**Severity**: **HIGH**. Real users collaborating via `CollabSession` then calling `replay_into` + `recompute` will STILL see `#NAME?` for formulas referencing pre-rename names. The Phase 5.3 ship CLOSES the D-3 limitation IN-PRINCIPLE (the repair fn exists and works), but does NOT CLOSE IT IN PRACTICE for any production code path.

**Proposed closure** (two options for step 5 / step 6):
1. **(Preferred)** Add `CollabSession::sync_workbook(&mut self, &mut Workbook, &FunctionRegistry) -> Result<RepairReport+TableRepairReport>` that does `replay_into` → `repair_sheet_rename_chain` → `repair_table_rename_chain`.
2. **(Minimal)** Extend the existing `op_log` docstring example at `session.rs:281` with the repair call, AND add an integration test that exercises `CollabSession::merge_bytes` → external `replay_into` → repair → recompute and asserts the formula resolves.

---

### Scenario F — Multi-occurrence table-rename rewrite + whitespace mutation
**Reproducer**: peer A `RenameTable T→T2`; peer B `PutFormula =T[A]+T[B]`; merge + repair.

```
=T[A]+T[B] -> Some("T2[A] + T2[B]")   (both Ts rewritten; whitespace inserted)
```

**Verdict on rewrite**: PASS — both `T` references correctly rewritten to `T2`.

**Severity (whitespace mutation)**: **LOW-MEDIUM (regression candidate)**. The repair pass routes through `lex → parse → rewrite → print`, and `ql_formula_syntax::print` canonicalizes whitespace. So **any formula touched by repair gets normalized**, mutating user-authored whitespace.

```
PRE:  "SUM(  t[a] )    +1"
POST: "SUM(T2[a]) + 1"
```

For producer-side renames the same canonicalization happens, so this is consistent — but worth documenting that repair rewrites mutate formula source text beyond strictly the renamed identifier.

**Unrelated formulas are not affected** (verified: `"  1 + 2  "` stays `"  1 + 2  "` post-repair).

**Proposed closure**: document in `repair.rs` module docstring; long-term V2: surgical diff-only rewrite.

---

### V1 Limitation #1 — Cross-source table collision: NON-ATOMIC FAILURE **[HIGH]**

**Reproducer**: peer A `T1→X` + `PutFormula(0,10,10)=1`; peer B `T2→X` + `PutFormula(0,11,11)=2`; merge + replay.

```
V1 LIM 1 replay FAILED as expected: TableCreateRejected { index: 5, name: "X", ... }
Tables after FAILED replay (PARTIAL STATE):
  table: X      <-- peer A's rename to X SUCCEEDED before the error
  table: T2     <-- base table, untouched
formulas after failed replay:
  (0, 10, 10) = 1  <-- peer A's PutFormula SUCCEEDED
                       (peer B's (0,11,11) = 2 was NOT applied)
```

**Severity**: **HIGH**. `replay_into` at `replay.rs:351-363` is a simple `for` loop with `?` short-circuit on error. There is NO transactional rollback. When the hard-fail at the collision point fires (audit-locked V1 policy per step 4 closure), the workbook is left in a STATE where:

1. Peer A's rename has been applied (T1 is now X).
2. Peer A's follow-up `PutFormula` has been applied.
3. Peer B's rename has been REJECTED.
4. Peer B's follow-up `PutFormula` was NEVER ATTEMPTED (replay aborted).
5. Caller gets `Err(TableCreateRejected)` — but the workbook they passed by mutable reference is now corrupted with a half-merged state.

**Production blast radius**: any caller that calls `replay_into` and reuses the workbook on error WILL operate on the corrupt state. Caller-side workaround: throw away the workbook on error. But this is nowhere documented in `replay.rs:351-363` and is not validated by any test.

**Proposed closure** (at least one of):
1. **Document** in `replay_into`'s docstring: "On Err, the workbook is in a partially-replayed state. Caller MUST discard the workbook."
2. **Snapshot/restore**: clone before, restore on error.
3. **Two-phase replay**: dry-run validate, then apply.
4. (V2) **Soft-fail with skip**: turn cross-source collision into a synthesized correction op + advisory skip.

Without one of these, **V1 LIM #1 is a HIGH that the step 4 audit closure note misses**.

---

### V1 Limitation #3 — Column repair pass MISSING **[HIGH, confirmed]**

**Reproducer**: peer A `RenameColumn T A→C`; peer B `PutFormula =T[A]+1`; merge + replay + `repair_table_rename_chain`.

```
V1 LIM 3 table report: formulas_rewritten: 0  (table_repair sees no table renames)
V1 LIM 3 =T[A]+1 -> Some("T[A]+1")  (NOT REWRITTEN)
```

**Severity**: **HIGH**. After merge:
- Column A is renamed to C (replay applies it).
- Peer B's formula `T[A]+1` still references the old column name A.
- No `repair_column_rename_chain` exists.
- At recompute, formula surfaces `#REF?` or `#NAME?`.

This is the LARGEST V1 limitation surface — column renames are the most common rename target.

**Proposed closure**: ship `repair_column_rename_chain` in step 5 or step 6. Architecturally trivial — `ql_formula_syntax::rewrite_column_ref` already exists (`ast.rs:443`). The chain-walker needs to be table-aware: `(table_canonical, old_col_canonical) → new_col_display`. Safety guard mirrors the table version.

**ETA estimate**: ~1 day to implement + 2 audit cycles (mirrors the step 4 cost structure).

---

### V1 Limitation #4 — DropTable + RenameTable interaction: ORDER-DEPENDENT FAILURE **[MEDIUM]**

| Causal order (Loro-determined) | Result |
|---|---|
| Drop then Rename | OK (rename advisory-skip) |
| Rename then Drop | TableNotFound hard-fail |

**Severity**: **MEDIUM**. `Op::DropTable` at `replay.rs:682-691` does NOT have step 4's advisory-skip logic — it hard-fails on missing source. Same root cause as the step 4 audit M-1 (Opus, NOT CLOSED).

**Proposed closure**: extend `Op::DropTable` handler with the same "if not found, idempotent OK" pattern. Trivial: `if workbook.tables().lookup(&canonical).is_none() { return Ok(()); }`. Pre-condition: producer-side validates the drop locally; replay can safely no-op when a concurrent peer already removed the same table.

---

### V1 Limitation #5 — Case-only rename policy: VERIFIED INCONSISTENT **[LOW-MEDIUM]**

| Surface | Op | Pre-replay state | Post-replay outcome |
|---|---|---|---|
| Sheet | `RenameSheet S→s` | sheet 0 = "S" | sheet 0 = "s" — **APPLIED** |
| Table | `RenameTable T→t` | table T | display = "T" — **NO-OP** (silent) |
| Column | `RenameColumn T A→a` | col A in T | **REJECTED** (`TableColumnRejected`) |

**Proposed closure**: pick one canonical policy and document it WB-wide. Recommendation: align all three on "case-only changes mutate display" (sheet's current behavior).

---

### V1 Limitation #6 — Concurrent intermediate names: NOT-LOST (verified)

Empirically the chain walker captures ALL intermediate names from BOTH peers. The "concurrent rename forced second op to apply 'from' a different name" warning at `repair.rs:91-97` does NOT manifest empirically. **The V1 limitation #6 docstring overstates the risk** — should be reframed (LOW doc).

---

### Edge probes (out of scope but informative)

#### Probe X — Mismatched workbook ↔ log: **SILENT FORMULA CORRUPTION [HIGH-latent]**

**Reproducer**: call `repair_sheet_rename_chain(&mut wb, &log)` where `wb` has sheet 0 named "OtherSheet" and `log` says sheet 0 was renamed from "S" to "S2".

```
=S!A1 in mismatched workbook -> Some("OtherSheet!A1")  // CORRUPTED
```

**Severity**: **HIGH (latent — depends on whether production wires this safely)**. The repair function trusts the workbook to be in the post-replay state for the log. If a caller invokes it with a STALE / WRONG workbook, repair silently rewrites formulas to "OtherSheet!A1".

**Mitigation already in place**: the docstring caller contract at `repair.rs:14-31` mandates the call sequence. But **without production wiring (Scenario E HIGH)**, the docstring is the only contract.

**Proposed closure**: add a debug-assert that for each sheet_id in `historic_by_sheet.keys()`, the current workbook sheet at that id exists AND is the expected post-replay name. Alternatively, accept that the contract is caller-side and lock it via the production wiring fix from Scenario E.

#### Probe Y — Nested BatchCommit rename traversal: PASS

`BatchCommit { ops: [BatchCommit { ops: [RenameSheet S→S2] }, RenameSheet S2→S3] }` correctly collects `["S", "S2"]` and rewrites `=S!A1` → `=S3!A1`.

#### Probe Z — Unbounded historic-canonicals growth

200-deep rename chain produced 200 entries. O(rules × formulas) per-formula iteration. No DoS protection. This is a Phase 5 V2/transport-layer concern.

---

## Summary table

| # | Finding | Severity | Closure path |
|---|---|---|---|
| 1 | **`replay_into` non-atomic on cross-source collision (V1 LIM #1)** — partial workbook state on Err | **HIGH** | Document on `replay_into` OR snapshot-restore OR soft-fail synthesized correction op (V2). |
| 2 | **Production wiring missing** — `CollabSession::merge_bytes` does NOT call replay+repair; no production caller exists | **HIGH** | Either add `CollabSession::sync_workbook` wrapper OR ship integration test that locks the caller contract. |
| 3 | **Column repair pass MISSING (V1 LIM #3)** — `repair_column_rename_chain` does not exist | **HIGH** | Ship `repair_column_rename_chain` in step 5 or step 6 (~1d + 2 audit cycles). |
| 4 | **Mismatched workbook ↔ log silent corruption** in `repair_sheet_rename_chain` when called with stale workbook | **HIGH (latent)** | Debug-assert OR ride on the Scenario E wiring fix. |
| 5 | **DropTable + RenameTable order-dependent failure (V1 LIM #4)** — drop-first OK, rename-first hard-fails | **MEDIUM** | Add advisory-skip to `Op::DropTable` handler. |
| 6 | **Case-only rename policy inconsistency (V1 LIM #5)** across sheet/table/column | **LOW-MEDIUM** | Align all three on display-mutates policy. |
| 7 | **Scenario F whitespace canonicalization side effect** — repair-touched formulas get parse/print-normalized whitespace + function case | **LOW** | Document in `repair.rs` module docstring. |
| 8 | **V1 LIM #6 docstring overstates risk** — empirical chain captures intermediates correctly via `old_name` | **LOW (doc)** | Reframe `repair.rs:91-97`. |
| 9 | **V1 LIM #2 (cross-source column collision)** — not directly probed but parallel to #1 (replay also non-atomic) | **HIGH (inferred)** | Same closure as #1 if confirmed. |
| 10 | **V1 LIM #6 docstring** says "rule-iteration order picks" but the real mechanism is "first rewrite consumes the source token" | **LOW (doc)** | Clarify the iteration vs substitution-consumption distinction. |

---

## VERDICT: **PASS-WITH-FINDINGS**

**Executive summary**: Phase 5.3 steps 1-4 ship is functionally correct for the in-scope shipped behavior — the repair pass walks the rename chain, the safety guard prevents the two Codex HIGHs from step 3 audit, intermediate names are correctly captured, multi-occurrence rewrites work for tables, and the BatchCommit recursion is correct. The 4334-test green confirms the local invariants.

However, **three HIGH findings outside the per-step audit scope surfaced**:

1. **No production caller exists for the repair pass** — `CollabSession::merge_bytes` does not invoke replay or repair, so end-users running CRDT merge + recompute will STILL get `#NAME?` on concurrent-rename formulas. The fix is shipped IN-PRINCIPLE but NOT IN PRACTICE. **This must be closed in step 5 / step 6.**

2. **`replay_into` is non-atomic on the V1-locked cross-source collision hard-fail** — when peer A's rename to X succeeds and peer B's rename to X errors mid-log, the workbook is left in a half-merged corrupt state. The caller contract is undocumented.

3. **Column repair pass missing** — the largest practical V1 limitation. Column renames are common; without repair, every concurrent column-rename-plus-formula scenario surfaces as a recompute error.

Plus one HIGH-latent finding (mismatched workbook + log silently corrupts formulas) and four MEDIUM/LOW findings (DropTable order-dependence, case-only inconsistency, whitespace mutation side effect, docstring refinements).

Step 5's three-way megaudit should ratify these — the per-step audits did the right thing locally but missed the wider system-integration view (production wiring), the cross-handler invariant (atomicity), and the parallel-surface gap (columns). Step 6's exit packet should explicitly enumerate these as V1 limitations with V2 closure paths and confirm none of the HIGHs slip through unmentioned.
