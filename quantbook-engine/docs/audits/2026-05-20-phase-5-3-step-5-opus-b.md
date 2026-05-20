---
title: Phase 5.3 step 5 megaudit — Opus-B subagent verdict (doc completeness + helper duplication + cross-crate consistency lane)
date: 2026-05-20
audit_target: full Phase 5.3 arc at HEAD `18ad97d5725` (4 ship+closure commits below it)
auditor: Opus-B subagent (independent of engineer; parallel with Codex + Opus-A)
tokens_used: 156165
tool_uses: 55
duration_ms: 542225
verdict: PASS-WITH-FINDINGS (3 HIGH + 5 MEDIUM + 3 LOW)
lane: doc completeness + helper duplication + cross-crate consistency
---

# Opus-B verdict — Phase 5.3 step 5 megaudit (doc completeness + helper duplication + cross-crate consistency lane)

**Auditor:** Opus-B (parallel with Codex tactical + Opus-A adversarial lanes)
**Lane:** doc completeness + helper duplication + cross-crate consistency
**HEAD audited:** `18ad97d5725` on `feat/quantbook-engine` (4 commits behind it: step 4 audit closures `6752ca2545c`, step 4 ship `7126eb44396`, step 3 closures `6bb76e3ade3`, step 3 ship `e76a9ce5499`).
**Engine docs surveyed:** 9 files. **Source files surveyed:** 5 (repair.rs, sheets.rs, tables.rs, replay.rs, lib.rs).

## VERDICT: **PASS-WITH-FINDINGS**

The 4 shipped steps (1-4) constitute a coherent, audit-disciplined arc — the algorithm shape is sound, the public API is well-named, and the V1 limitations are openly acknowledged in the plan + inline docstrings. **However, the user-facing doc surfaces have not yet been updated to reflect the ship.** Step 6 (exit packet + handoff refresh) is the natural place to close every finding below, and the step 5 megaudit's job is to make those gaps explicit and proposal-ready. Nothing here blocks step 5 megaudit completion; everything here BLOCKS step 6 closure.

The single most consequential finding is **HIGH-1**: the entire 5.3-introduced public API (8 surfaces from `ql_collab::repair`) is invisible to the IDE consumer contract — the document the prompt explicitly named as "the authoritative API surface" — and the conflict-resolution matrix omits every table-level row that step 4 just shipped. The 5.3 docs at code-comment level are excellent; the user-facing doc surfaces are 4 days stale.

---

## Executive summary

I verified all 6 required deliverables. Findings bucket:

- **3 HIGH** (must close before step 6 ships): IDE contract omits 5.3 surface; conflict matrix omits step 4 table/column rows; the 5 docs that describe 5.3 in forward tense are stale post-ship.
- **5 MEDIUM** (close in step 6 if scope allows; else V2 backlog): helper duplication is real at 5 sites; production wiring still absent without an audit-locked "why no auto-wire" note in the IDE contract; case-only rename policy inconsistency; missing column-repair pass; `lookup_column` doc-vs-code inversion (L-3 from step 4 audit — still open).
- **2 LOW** (paperwork): GAP-C-02 target phase needs refresh; PHASE-4-V2-BACKLOG.md has no entry for the V1 limitations stack.

The V1 limitations stack in `_active.md:115-121` (6 items) is a SUBSET of the 10 the orchestrator gave me. I cross-referenced: all 10 are real and well-grounded; 6 are explicitly captured in the plan, 2 are in the `repair.rs` module docstring (items 8 + 9), 1 is a recently-discovered step-4 L-3 (item 10, `lookup_column` doc inversion — not yet anywhere in user-facing docs), 1 is `DropTable + RenameTable` (item 4 — captured in the plan as M-1 but not yet doc-published). **The plan IS the V2 backlog right now — moving it to a durable doc is step-6 work.**

---

## Deliverable 1 — Helper duplication count

**Actual count: 5 distinct call sites** of `ql_formula_syntax::{lex, parse, print, rewrite_*}` across 2 crates. Pre-step-3 estimate was 3; post-step-4 estimate was 5+. The **post-step-4 estimate is correct.**

| # | Crate | File:line range | Function/scope | Helper called | Category |
|---|---|---|---|---|---|
| 1 | ql-collab | `repair.rs:354-361` | `rewrite_formula_with_rename` (private) | `lex` + `parse` + `rewrite_sheet_name_in_expr` + `print` | sheet rename (repair-side) |
| 2 | ql-collab | `repair.rs:547-554` | `rewrite_formula_with_table_rename` (private) | `lex` + `parse` + `rewrite_table_ref` + `print` | table rename (repair-side) |
| 3 | ql-exec | `workbook_runtime/sheets.rs:42-58` | `rewrite_formula_text_for_sheet_rename` (private) | `lex` + `parse` + `rewrite_sheet_name_in_expr` + `print` | sheet rename (producer-side) |
| 4 | ql-exec | `workbook_runtime/tables.rs:323-336` | `rename_table` (public impl method, inline) | `lex` + `parse` + `rewrite_table_ref` + `print` | table rename (producer-side) |
| 5 | ql-exec | `workbook_runtime/tables.rs:467-484` | `rename_column` (public impl method, inline) | `lex` + `parse` + `rewrite_column_ref` + `print` | column rename (producer-side) |

If the missing `repair_column_rename_chain` (limitation #3) ever lands in V2, the count would become **6**.

### Proposed unification plan

Add one public helper in `ql-formula-syntax` (estimated ~30 LOC + ~5 LOC of new tests in that crate):

```rust
pub enum NameRewrite<'a> {
    Sheet { old_canonical: &'a str, new_display: &'a Arc<str> },
    Table { old_canonical: &'a str, new_display: &'a Arc<str> },
    Column { table_canonical: &'a str, old_name: &'a str, new_display: &'a Arc<str> },
}

pub fn rewrite_formula_text(text: &str, rewrite: NameRewrite<'_>) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = lex(stripped).ok()?;
    let expr = parse(tokens).ok()?;
    let rewritten = match rewrite {
        NameRewrite::Sheet { old_canonical, new_display } =>
            rewrite_sheet_name_in_expr(&expr, old_canonical, new_display),
        NameRewrite::Table { old_canonical, new_display } =>
            rewrite_table_ref(&expr, old_canonical, new_display),
        NameRewrite::Column { table_canonical, old_name, new_display } =>
            rewrite_column_ref(&expr, table_canonical, old_name, new_display),
    };
    if rewritten == expr { return None; }
    let printed = print(&rewritten);
    Some(if text.starts_with('=') { format!("={printed}") } else { printed })
}
```

**Net delta:** roughly **-2 LOC** but with much higher cohesion. **Recommended disposition:** V2 backlog (single-commit refactor, low-risk).

---

## Deliverable 2 — V1 limitation doc-surface audit (10 items)

| # | Limitation | Documented at | Status |
|---|---|---|---|
| 1 | Cross-source target collision (tables) — hard-fails | replay.rs:803-840; `.plans/_active.md:116-117` | **NOT in user-facing docs.** |
| 2 | Cross-source target collision (columns) — hard-fails | replay.rs:935-952; plan | **NOT in user-facing docs.** |
| 3 | Column repair pass MISSING | repair.rs:99-101; plan | **NOT in user-facing docs.** |
| 4 | DropTable + concurrent RenameTable — hard-fails | plan only | **NOT in any source or doc surface.** |
| 5 | Case-only rename policy inconsistency | plan only | **NOT in any source comment OR user-facing doc.** 3-way inconsistency real. |
| 6 | Helper duplication (5+ call sites) | repair.rs:335-343 TODO; plan | **NOT in V2 backlog file.** |
| 7 | Production wiring missing | repair.rs:14-32 module docstring; plan | **PARTIALLY documented** — IDE contract silent. |
| 8 | Concurrent-rename intermediate names lost | repair.rs:90-97 module docstring | **Inline doc only.** |
| 9 | Cross-sheet historic-name ambiguity | repair.rs:82-88 module docstring | **Inline doc only.** |
| 10 | `lookup_column` doc says uppercase, code lowercases | NOT documented anywhere | **OPEN — Opus step 4 L-3 not closed.** |

**Summary:** 0/10 limitations are documented in user-facing surfaces. This is exactly the gap step 6 is supposed to close — but step 6 hasn't started, so right now the gap is real.

---

## Deliverable 3 — IDE consumer contract API surface check

Verified at `docs/architecture/ide-consumer-contract.md`:

- **`repair_sheet_rename_chain`** — NOT mentioned.
- **`repair_table_rename_chain`** — NOT mentioned.
- **`RepairReport`** — NOT mentioned.
- **`SheetRewriteSummary`** — NOT mentioned.
- **`AmbiguousSkip`** — NOT mentioned.
- **`TableRepairReport`** — NOT mentioned.
- **`TableRewriteSummary`** — NOT mentioned.
- **`TableAmbiguousSkip`** — NOT mentioned.

The "Phase 5 collaboration surface" section (lines 198-209) lists CollabSession's V1 API (op log, undo, transport, presence) but the 5.3-introduced surface is **entirely missing**.

Recommended insertion:

```text
- **Post-merge rename-repair (Phase 5.3 step 3+4):** after `merge_bytes`,
  before `recompute_all`, call `repair_sheet_rename_chain` +
  `repair_table_rename_chain` to rewrite formula text that
  references pre-rename sheet / table names. Caller-driven by
  design (audit-locked D-5.3-1); see `crates/ql-collab/src/repair.rs`
  module docs. Returns `RepairReport` / `TableRepairReport` for
  diagnostic logging.
```

**HIGH** — IDE contract is named explicitly as "the authoritative API surface."

---

## Deliverable 4 — Cross-crate consistency check

Sheet: full closed loop (producer → wire → replay → repair). Table: hard-fails on cross-source target collision (V1 limitation 1+2). Column: NO repair pass exists (V1 limitation 3), plus case-only inconsistency (producer no-ops, replay rejects).

**Inconsistencies surfaced:**
1. No `repair_column_rename_chain` analog of sheet+table repair passes.
2. Producer same-canonical column rename returns `Ok(0)` no-op; replay-side errors. (Coherent design — producer won't emit; replay treats receipt as divergence. But 3-way asymmetry with sheet+table.)
3. **Type naming**: `RepairReport` (sheet) vs `TableRepairReport`; `AmbiguousSkip` vs `TableAmbiguousSkip`. Recommend `SheetRepairReport` / `SheetAmbiguousSkip` for symmetry. (LOW-3)

---

## Deliverable 5 — Exit packet readiness check

- ✅ Template `docs/phase5/d-1-exit-packet.md` exists (141 lines) — structure can be copied.
- ✅ All 6 surfaces present at expected paths:
  - `docs/MASTER-PLAN.md` (Phase 5 §540-617)
  - `docs/phase5/v1-exit-packet.md`
  - `docs/phase5/entry-plan.md`
  - `docs/architecture/crdt-data-model.md` (conflict matrix §311-332)
  - `docs/architecture/ide-consumer-contract.md`
  - MEMORY surfaces (outside repo)

**Also recommend step 6 refresh:**
- `docs/known-gaps.md:113` — GAP-C-02 target phase update (LOW-1)
- `docs/PHASE-4-V2-BACKLOG.md` — NEW Tier H section for 5.3 V1 limitations (HIGH-2)
- `docs/phase5/5-3-exit-packet.md` — NEW file (mirroring d-1-exit-packet.md)

**Step 6 effort estimate:** ~0.5 day (per plan). Bulk is conflict-matrix table refresh + IDE contract insertion + V2 backlog Tier H addition.

---

## Deliverable 6 — Stale-doc grep

**14 forward-tense or "deferred" mentions across 6 user-facing doc files** (filtered to exclude `audits/` + `_archive/`):

| File:line | Stale statement | Action |
|---|---|---|
| `MASTER-PLAN.md:573` | "5.3 ... — future. 4-7 days" | Update with ✅ |
| `MASTER-PLAN.md:545` | "Remaining: 5.3 ..." | Update |
| `crdt-data-model.md:645` | "Phase 5.3 will add the causality-aware rename-repair pass; until then ..." | Rewrite past-tense |
| `crdt-data-model.md:676` | "until 5.3 ships the causality-aware repair" | Rewrite past-tense |
| `ide-consumer-contract.md:195` | "deferred to Phase 5.3" | Update with ✅ + post-merge call sequence section |
| `phase5/v1-exit-packet.md:3, 21, 226-228` | "5.3 conflict resolution ... remain ahead" | Update with status row |
| `phase5/entry-plan.md:3, 116, 186` | Multiple stale | Update + delete phantom cross-ref (LOW-2) |
| `phase5/d-1-starting-checklist.md:266, 268` | "leaving 5.3 ... remaining" | Historical, low-priority preamble |
| `phase5/d-1-exit-packet.md:136-141` | "5.3 ... START HERE" | Add "post-5.3-ship" preamble |
| `known-gaps.md:113` | GAP-C-02 target phase 5.3 | Update with ✅ V1 closure marker (LOW-1) |

---

## Findings — HIGH

### HIGH-1: IDE consumer contract omits all 8 of 5.3's public surface; conflict matrix omits step 4's table/column rows

**Files:**
- `docs/architecture/ide-consumer-contract.md:198-209` — 5.3 surface missing
- `docs/architecture/ide-consumer-contract.md:195` — "deferred to Phase 5.3" stale
- `docs/architecture/crdt-data-model.md:320-332` — conflict matrix has 11 rows; 0 RenameTable rows; 0 RenameColumn rows; DropTable row doesn't mention concurrent RenameTable

**Why it matters:** the IDE consumer contract is named in the orchestrator's prompt as "the authoritative API surface." Step 3+4 introduced 8 public types/fns — all unmentioned. The conflict matrix is the other "where future readers will look" surface; silent on step-4 behavior.

**Closure (step 6):**
1. ide-consumer-contract.md: insert "Post-merge rename-repair (Phase 5.3 step 3+4)" item under § "Phase 5 collaboration surface" (text in deliverable 3).
2. crdt-data-model.md: add 4 new conflict-matrix rows (RenameTable × edit; RenameTable same-source different-targets; RenameTable cross-source same-target HARD-FAIL; RenameColumn cross-source same-target HARD-FAIL). Extend DropTable row with concurrent-RenameTable HARD-FAIL mention.

### HIGH-2: V1 limitations stack durably documented ONLY in gitignored `.plans/_active.md`; will vaporize at step 6 archival

**Files:**
- `.plans/_active.md:115-121` (gitignored, archived at step 6)
- repair.rs module docstring (items 8 + 9 only)
- `crates/ql-storage/src/tables.rs:199-210` (item 10, doc INVERTED)
- `docs/PHASE-4-V2-BACKLOG.md` — has NO 5.3 / Phase-5 tier

**Why it matters:** the plan file archives after step 6. Items 1, 2, 3, 4, 5, 10 from the V1 limitations stack have no durable home in user-facing tracked docs.

**Closure (step 6, must happen BEFORE `_active.md` archival):**
Add `## Tier H — PHASE 5.3 V1 LIMITATIONS (deferred to V2)` to `docs/PHASE-4-V2-BACKLOG.md` with 7 entries (H1 helper unification + H2 column repair + H3 cross-source target collision (sheet vs table asymmetry) + H4 DropTable+RenameTable + H5 case-only rename policy + H6 production wiring documentation + H7 lookup_column doc inversion).

### HIGH-3: All 5 user-facing 5.3-mention doc surfaces are stale (forward-tense)

**Files:** MASTER-PLAN.md:573; v1-exit-packet.md:21, 226; entry-plan.md:116; crdt-data-model.md:645, 676; ide-consumer-contract.md:195.

**Why it matters:** today's reader (2026-05-20, post-step-4-ship) sees "5.3 is future" / "5.3 ... remain ahead" / "until 5.3 ships" — all false.

**Closure:** the 5-surface refresh is already in `_active.md:135-140` step 6 list. Audit-confirms it covers all 5 sites.

---

## Findings — MEDIUM

### MEDIUM-1: Helper duplication confirmed at 5 sites; unification not on V2 backlog
**Closure:** add to `docs/PHASE-4-V2-BACKLOG.md` as Tier H1 entry (see HIGH-2).

### MEDIUM-2: `lookup_column` doc says "uppercases" but code lowercases (Opus step 4 audit L-3, still open)
**File:line:** `crates/ql-storage/src/tables.rs:199-210`. Doc says "uppercases the query first." Code calls `to_ascii_lowercase()`.
**Closure (step 6 or sooner, 1-line doc fix):** change "uppercases" → "lowercases".

### MEDIUM-3: Case-only rename policy inconsistency across sheet / table / column
- Sheet: applies (post-step-2 audit closure)
- Table: silently no-ops both producer + replay
- Column: producer no-ops; replay REJECTS as divergence

**Closure:** V2 backlog Tier H entry. Document the policy difference in `crdt-data-model.md` § "Case-only renames" subsection.

### MEDIUM-4: Production wiring missing without IDE-contract design-rationale note
**Closure:** as part of HIGH-1's contract update, add design-rationale paragraph explaining D-5.3-1 (caller-driven by design).

### MEDIUM-5: Missing `repair_column_rename_chain` produces silent column-name corruption under concurrent renames
**Closure:** V2 backlog Tier H entry. Worth flagging as a known correctness gap, not just a completeness gap.

---

## Findings — LOW

### LOW-1: `docs/known-gaps.md:113` GAP-C-02 still says target phase 5.3
**Closure:** update marker to "✅ V1 closure shipped Phase 5.3 steps 1-4 (2026-05-20); column repair deferred to V2 Tier H."

### LOW-2: `entry-plan.md:186` cross-refs a phantom `docs/architecture/conflict-resolution.md`
**Closure:** delete or redirect to `crdt-data-model.md § "Conflict resolution semantics"`.

### LOW-3: Naming asymmetry `RepairReport` vs `TableRepairReport`
Stylistic; consider standardizing to `SheetRepairReport` / `TableRepairReport` for symmetry. **API churn cost** small at pre-0.2.0 stage.

---

## What I deliberately DID NOT cover (other lanes)

- **Codex tactical lane**: cross-step + grep + correctness probes.
- **Opus-A adversarial lane**: empirical 2-peer + adversarial randomized interleavings + production wiring runtime probes.
- **Test coverage gaps**: confirmed test files exist; did not deep-audit.
- **Code-level correctness of repair algorithm**: extensively documented in per-step audit transcripts; did not re-derive.

---

## Recommendations for step 6 exit packet

**Pre-step-6 minimum (closes my HIGHs):**
1. Add 4 new conflict-matrix rows to `crdt-data-model.md` (HIGH-1).
2. Add post-merge rename-repair section to `ide-consumer-contract.md` (HIGH-1).
3. Refresh 5 forward-tense doc sites (HIGH-3) — already in `_active.md:135-140` step 6 list.
4. Add Tier H V1 limitations section to `PHASE-4-V2-BACKLOG.md` (HIGH-2) — before `_active.md` archives.
5. Fix `lookup_column` doc-comment inversion (MEDIUM-2 / step 4 L-3).
6. Optional: rename `RepairReport` → `SheetRepairReport` + `AmbiguousSkip` → `SheetAmbiguousSkip` for type-name symmetry (LOW-3).

**Step 5 megaudit verdict guidance for step 6:**
- Step 4's hard-fail revert is correct given API constraints, but user-visible asymmetry is real. Document openly.
- The `caller-driven` design (D-5.3-1) is correct but invisible. Make it visible.
- 5.3's algorithm shape is sound. 6 consecutive divergent-HIGH audit cycles validate the discipline; V1 limitations are durable trade-offs, not bugs.

**Status of remaining 5.3 work:** step 6 ~0.5 day per plan estimate. 5.3 closes at ~4.5-5 days actual (vs 4-7 day estimate). On budget.

**Forward work after 5.3 closes:** Tier H V2 work (~3-5 days). 5.5 V2 V2/V3 next per `d-1-exit-packet.md:137`.

---

**End of Opus-B verdict.**
