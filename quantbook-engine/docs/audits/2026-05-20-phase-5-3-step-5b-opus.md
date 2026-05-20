---
title: Phase 5.3 step 5b audit — Opus subagent verdict (holistic + adversarial lane)
date: 2026-05-20
audit_target: commit `815ecf0589e` (5b ship)
auditor: Opus subagent (independent of engineer; parallel with Codex)
tokens_used: 131646
tool_uses: 53
duration_ms: 753516
verdict: PASS-WITH-FINDINGS (4 HIGH + 4 MEDIUM + 4 LOW)
lane: holistic + adversarial probe synthesis + commit-claim verification
---

# Phase 5.3 step 5 sub-cycle 5b — Opus auditor verdict (holistic + adversarial lane)

## Executive summary

**5b correctly ships the wrapper that the megaudit demanded.** The implementation is small, the signature is the right shape, the docstrings reference the right audit-locked decisions, and the 5 integration tests cover the happy paths plus one error case. The commit message claim about the `OpLog::new()` random-peer-id bug is empirically validated (10/10 deterministic D-2 fire in the bad pattern).

However, **the closure of Opus-A Scenario E HIGH is partial in three load-bearing ways**:

1. **The "production-wiring" claim is overstated.** The wrapper exists, but **no production code path calls `sync_workbook`.** Grep verifies that the only callers are the 5 integration tests + the doc example. The IDE / qbook loader / runtime do not invoke it. Closer to "scaffolding for the production wiring" than "production wiring closure" — Phase 5.7 IDE binding is when the user-visible bug actually closes.

2. **`sync_workbook` is non-idempotent and has no guard against the most obvious misuse paths.** Empirical probes show silent-corruption shapes for double-invocation, stale-workbook-from-other-log, and double-invocation-with-repair. The wrapper enforces the SEQUENCE (replay → repair) but not the PRECONDITION (clean / fresh workbook).

3. **Test coverage is thin for a 'production wiring closure' commit.** Empirical probe P4 added the missing recompute step and confirms formulas RESOLVE post-repair via `Number(42.0)` — the existing 5b tests only assert text rewrites. A future regression in `WorkbookRuntime`'s binding pass could re-introduce `#NAME?` and these 5 tests would still pass.

**Verdict: PASS-WITH-FINDINGS** — ship 5b as is for step-7 enablement; defer the gap-closure to step 6 (doc-level pitfall expansion) and step 7 (real production wiring). Two of the four HIGH findings are V2-deferrable.

---

## Findings

### HIGH-1 — `sync_workbook` has no production caller; the megaudit HIGH it closes remains user-visible

**File**: `crates/ql-collab/src/session.rs:383-399`; grep evidence below.

Grep result for `sync_workbook` outside `ql-collab/src/` + `tests/`: **zero matches**. The only non-test, non-definition reference is the docstring example at `session.rs:330`.

The commit message frames the closure as "the wrapper closes the gap." Strictly, the gap from end-user perspective is NOT closed by 5b — only the API piece is. A future caller (Phase 5.7 IDE binding) needs to actually call `sync_workbook`. Until then, the user-visible bug exists.

**Proposed closure**:
- Phase 5.7 IDE binding work MUST grep for `merge_bytes` callers in the IDE code (when those land) and route through `sync_workbook`.
- The step-6 exit packet should explicitly state "`sync_workbook` is shipped as an API for step 7 to wire; the user-visible D-3 closure happens at step 7, not 5b."
- Add `#[must_use]` to nudge callers.

**Severity**: HIGH-on-rhetoric, MEDIUM-on-mechanics.

---

### HIGH-2 — Non-idempotent double-invocation produces silent workbook corruption

**File**: `crates/ql-collab/src/session.rs:383-399`.

**Reproducer (P1)**:
```
P1 first call: ops_replayed=2
P1 sheet_count after 1st call = 1
P1 second call OK: ops_replayed=2; sheet_count=2  ← D-2 auto-rename fired
```

**Reproducer (P9, worse — D-3 scenario double-sync)**:
```
P9 first sync: ops=4, sheet_repair.rewritten=1
P9 second sync: Ok((4, 0))
P9 sheet_count after double-sync = 2 (one named S2, one named S)
P9 formula_at(0,1,0) = Some("S!A1")  ← REVERTED + points at wrong sheet
```

Second sync: `AddSheet { name: "S" }` no longer conflicts because sheet 0 is now `S2` — so D-2 picks `S` (not `S(2)`) as a free name, creating sheet 1 = `S`. The replayed `PutFormula(0,1,0)="S!A1"` overwrites the previously-repaired `S2!A1`. Repair pass then ambiguous-skips the rule (per step-3 audit closure). Final: 2 sheets, formula references wrong sheet. **No Err signal.**

**Proposed closure**:
- Expand docstring "Caller pitfalls" to explicitly cover same-log double-replay.
- Either rename API to `rebuild_workbook` (constructs `Workbook::new()` internally), OR add a pristine-workbook precondition `assert!` at top of `sync_workbook`.

**Severity**: HIGH. The docstring claim "caller-contract violations are impossible from the wrapped path" (at `repair.rs:222`) is empirically false for double-invocation.

---

### HIGH-3 — Empty-log fast path silently reuses prior workbook state

**File**: `crates/ql-collab/src/session.rs:388-390`.

**Reproducer (P10)**:
```
P10 after populated sync: sheet_count=1, A1=Number(42.0)
P10 after empty-log sync: ops_replayed=0, sheet_count=1, A1=Number(42.0)
```

For a populated session "rebuild from log" works. For an empty session, "rebuild from log" should mean "empty workbook," but the fast path is `return SyncReport::default()` — the workbook is untouched.

**Proposed closure**:
- Either: clear the workbook on empty-log path (`workbook.clear()` or similar).
- Or: document explicitly "empty-log fast path leaves workbook untouched."
- Or: remove the fast path entirely. Replay is cheap on an empty log.

**Severity**: HIGH (same caller-contract-silent-corruption category as HIGH-2).

---

### HIGH-4 — Existing 5b tests do not verify end-to-end resolution (only text rewrites)

**File**: `crates/ql-collab/tests/sync_workbook.rs:107-163`.

The tests assert `formula_at(...) == Some("S2!A1")`. Necessary but not sufficient. The actual D-3 user-visible bug is `#NAME?` at recompute time. A future bug in `WorkbookRuntime`'s binding could re-introduce `#NAME?` while leaving the text-level rewrite intact. The 5b suite would still pass.

**Reproducer (P4)** added the missing recompute step:
```
P4 sheet_repair.formulas_rewritten = 1
P4 formula text post-repair = Some("S2!A1")
P4 recomputed value at (0,1,0) = Number(42.0)
```

**Proposed closure**: add one integration test in `crates/ql-exec/tests/` that calls `WorkbookRuntime::recompute_all` after `sync_workbook` and asserts `Value::Number(42.0)`. (ql-exec already has ql-collab dev-dep.)

**Severity**: HIGH for "production-wiring closure" framing; MEDIUM for "ships the wrapper API."

---

### MEDIUM-1 — `CollabSessionError::Replay` vs `CollabSessionError::OpLog` are not orthogonal

The same underlying corruption could surface as either variant depending on when (replay vs repair) it's observed. Both wrap `OpLogError::Deserialize` indirectly.

**Proposed closure**: document the failure-stage convention in the variant docs, OR merge variants.

**Severity**: MEDIUM (API ergonomics).

---

### MEDIUM-2 — `SyncReport` lacks `Display` impl / `summary()` method for log-line diagnostic use

**File**: `crates/ql-collab/src/session.rs:135-145`.

The docstring tells callers to "log report.ops_replayed / report.sheet_repair / report.table_repair" but there's no `Display` impl. Debug surface is verbose (24 lines for one log call).

**Proposed closure**: add `impl Display for SyncReport` (one-line) or `summary(&self) -> String`. Mirror for `RepairReport` + `TableRepairReport`.

**Severity**: MEDIUM (ergonomics + diagnostic-coherence with no-fallback rule).

---

### MEDIUM-3 — Degenerate empty-log states indistinguishable in SyncReport

If callers call `sync_workbook` on (a) empty session, (b) populated session pre-replayed, (c) 0-op log, all three return identical `SyncReport::default()`. Caller cannot distinguish.

**Proposed closure**: add `fast_path_skipped: bool` field to indicate empty-log early return.

**Severity**: MEDIUM-LOW.

---

### MEDIUM-4 — Error-propagation test declines to assert partial workbook state

**File**: `crates/ql-collab/tests/sync_workbook.rs:303-309`.

Test comment says "we don't assert anything about wb's state here — that would lock in the partial-state contract." But probe P7 shows the partial state IS observable:
```
P7 wb.sheet_count() after err = 1
P7 wb.tables().lookup("X").is_some() = true   ← peer A's T1→X succeeded
P7 wb.tables().lookup("T1").is_some() = false
P7 wb.tables().lookup("T3").is_some() = true  ← peer B's never applied
```

**Proposed closure**: add follow-up assertion that the workbook is NON-EMPTY on Err to validate that the corruption is real.

**Severity**: MEDIUM (test discipline).

---

### LOW-1 — `op_count()` docstring claim "Cheap (cached)" is stale post 5.4 V1

**File**: `crates/ql-collab/src/session.rs:401-404`; cross-ref `crates/ql-oplog/src/log.rs:142-150`.

```rust
/// Current number of ops in the log. Cheap (cached).
```

But `OpLog::len()` queries Loro directly each call (was cached pre-5.4; cache became stale per Codex audit HIGH).

**Proposed closure**: "Wraps `OpLog::len()` — queries Loro on each call; O(1) but not a free local read."

---

### LOW-2 — `sync_workbook` docstring `op_count() == 0` vs code `is_empty()`

**File**: `crates/ql-collab/src/session.rs:369` vs `:388`.

Both query `OpLog::len() == 0`. Cosmetic inconsistency.

---

### LOW-3 — Commit-message "non-deterministic" understates the deterministic nature of the bug

Probe P6 ran 10 trials of the bad pattern and got **D-2 auto-rename fire in 10/10 (100%)**. The bug is fully deterministic.

---

### LOW-4 — `sync_workbook` lacks `#[must_use]`

A caller can write `let _ = session.sync_workbook(...)` and silently drop the SyncReport. Violates no-fallback rule.

**Proposed closure**: `#[must_use = "..."]` annotation.

---

## Summary table of findings

| # | Severity | Category | Findings location |
|---|---|---|---|
| 1 | HIGH (rhetoric) | Production wiring still missing in practice | session.rs:383-399 + grep evidence |
| 2 | HIGH | Non-idempotent double-invocation silent corruption | session.rs:383-399 (P1 + P9 empirical) |
| 3 | HIGH | Empty-log fast path silently reuses prior workbook | session.rs:388-390 (P10 empirical) |
| 4 | HIGH | 5b tests miss end-to-end recompute resolution check | tests/sync_workbook.rs:107-163 (P4 empirical) |
| 5 | MEDIUM | `Replay` vs `OpLog` variants non-orthogonal | session.rs:81-128 |
| 6 | MEDIUM | `SyncReport` lacks Display / summary | session.rs:135-145 (P12 empirical) |
| 7 | MEDIUM-LOW | Degenerate empty-log states indistinguishable | session.rs:135-145 |
| 8 | MEDIUM | Error-propagation test doesn't validate partial-state existence | tests/sync_workbook.rs:303-309 (P7 empirical) |
| 9 | LOW | `op_count()` "cached" claim stale | session.rs:401-404 + log.rs:142-150 |
| 10 | LOW | Docstring `self.op_count() == 0` vs code `is_empty()` | session.rs:369 vs 388 |
| 11 | LOW | Commit-message "non-deterministic" overstated | commit `815ecf0589e` (P6 empirical 10/10) |
| 12 | LOW | `sync_workbook` lacks `#[must_use]` | session.rs:383 |

---

## Empirical probe summary (13 probes, all passed; probe file deleted post-audit)

| # | Claim probed | Outcome |
|---|---|---|
| P1 | Double `sync_workbook` on same workbook is idempotent | **FALSE** — sheet_count doubles via D-2 |
| P2 | Stale-workbook detection on caller error | **FAILS SILENTLY** |
| P3 | 3-peer concurrent rename + writes — both formulas rewritten | **PASS** |
| P4 | Canonical D-3 post-repair formula RESOLVES via recompute | **PASS** — `Number(42.0)` |
| P5 | Chain rename S→S2→S3 + concurrent =S!A1 rewrites to S3 | **PASS** — `S3!A1` + resolves to 42.0 |
| P6 | Random peer-id pattern reliably fires D-2 auto-rename | **CONFIRMED 10/10 trials** |
| P7 | Error-propagation: partial workbook state observable | **CONFIRMED** |
| P8 | Single-peer chain rename only → repair pass is no-op | **PASS** |
| P9 | Double sync_workbook with D-3 scenario | **SILENT CORRUPTION** |
| P10 | Empty-log fast path clears workbook | **DOES NOT** |
| P11 | `ops_replayed` excludes repair-induced put_formula updates | **CORRECT** |
| P12 | SyncReport's diagnostic surface (Display? summary?) | Debug only; no Display |
| P13 | `ambiguous_rules_skipped` surfaces via SyncReport | **CORRECT** |

---

## VERDICT: PASS-WITH-FINDINGS

**Ship 5b as is.** Wrapper API is correctly designed for step-7 integration.

**Close before Phase 5.3 step 6 exit packet**:
- HIGH-1 (production wiring framing): update step-6 exit packet to state user-visible D-3 closure happens at step 7.
- HIGH-2 (double-invocation): expand docstring + add pristine-workbook assert.
- HIGH-3 (empty-log fast path): document or eliminate inconsistency.
- HIGH-4 (no end-to-end recompute test): add one integration test in `ql-exec/tests/`.

**V2 candidates** (post-Phase 5): `try_sync_workbook_into_fresh()`, merge `Replay` + `OpLog` variants, `Display` on `SyncReport`.

**Step-7 dependency**: IDE binding must grep for `merge_bytes` callers and route through `sync_workbook`. Without this, HIGH-1 remains user-visible.
