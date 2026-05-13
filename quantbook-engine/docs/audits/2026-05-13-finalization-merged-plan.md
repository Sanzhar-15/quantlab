# Finalization — merged Claude + Codex plan

**Date:** 2026-05-13 (W5-59 session)
**Inputs:** Codex's planning verdict at `2026-05-13-finalization-planning-codex.txt`; Claude's draft at `2026-05-13-finalization-planning-claude.md`; the planning brief at `2026-05-13-finalization-planning-prompt.md`.

## Where Codex agreed with Claude

- **Artifact list:** comprehensive handoff doc + audit-protocol doc + memory update + preserved Codex/Sonnet artifacts.
- **Audit cadence:** per-commit (7 gates) + per-phase (Codex+Sonnet parallel) + per-architectural-decision (W5-49 pattern with Plan mode + Codex review + decision doc).
- **Cycle discipline:** ≤2 per CLAUDE.md, handoff at cycle 3.
- **Next-phase sequencing:** finalization → 4.3 polish → 4.4 architectural decision → 4.5 dates → 4.6 cross-sheet → 4.7 arrays → 4.8 tables → 4.9 R1C1+localization → 4.10 wave 2 → 4.11 xlsx → 4.12 megaudit.
- **The biggest risk:** silent doc/code divergence becoming the next window's starting premise. The W5-52 audit found `on_clear_formula` because both auditors agreed; without the parallel pattern, the bug would have shipped.

## Where Codex strengthened Claude's draft

1. **Real doc drift Codex caught that Claude missed.** Six pieces of stale text were live in the repo:
   - `docs/MASTER-PLAN.md:3-5` — date `2026-05-12`, HEAD `fc977815cd2`. Fixed in W5-59.
   - `docs/known-gaps.md:69` — GAP-F-01 said "22 of ~260 (8.4%)". Fixed to "Wave 1 ✅ CLOSED at 102 entries".
   - `docs/architecture/2026-05-13-graph-storage-decision.md:3` — said "NOT shipped" with amended sections later. Fixed in W5-59 with full status timeline.
   - `crates/ql-exec/src/calcgraph_session.rs:486-488` — append-only-is-performance-not-correctness comment, stale after W5-50. Fixed.
   - `crates/ql-exec/src/scalar.rs:72-78` — legacy `eval_scalar` `#CALC!` comment without "legacy no-registry path only" caveat. Fixed.
   - `crates/ql-exec/src/plan.rs:159-183` — "replaced in Phase 4.3" comment that's now stale. Retargeted to Phase 4.7/4.10.

2. **MANDATORY/RECOMMENDED/FORBIDDEN labels** in the audit-protocol doc. Claude's draft was prescriptive but Codex's framing makes the protocol more enforceable.

3. **Additional gotchas:**
   - `FunctionRegistry::names()` only returns scalar names (registry has two tables since W5-53)
   - Range-aware dispatch checks `lookup_range_aware` FIRST; mis-registering as scalar silently loses shape
   - `FnArg::Range` shape is row-major; shape bugs pass SUMIF/COUNTIF tests but fail VLOOKUP/INDEX
   - `is_aggregate_function` is misleadingly named — really "allows named/range args in binder"
   - macOS `/tmp/xcrun_db` warnings under Codex sandbox — not failures
   - `Graph::clear_outgoing` / `clear_range_deps_for_formula` bump revision even on no-op (low-risk, documented)
   - Cross-sheet refs Phase 4.6 will need to re-audit graph supplemental logic
   - `docs/process/` did not exist (correct — creation is part of W5-59 finalization)

4. **A separate post-finalization mega-audit dispatch** for W5-53..W5-58 was Codex's recommendation. The W5-52 audit only covered W5-49..W5-51, so W5-53 through W5-58 (RangeAwareFn infra + 50+ new functions) has not yet been independently audited. The merged plan defers this audit to after W5-59 ships, then triggers it as the immediate next step.

## Merged execution plan (this session)

1. **Fix doc drift** Codex flagged (6 items). ✅ DONE.
2. **Move planning artifacts** from worktree root to `docs/audits/`. ✅ DONE.
3. **Write comprehensive handoff doc** at `docs/audits/2026-05-13-engine-session-final-handoff.md`. ✅ DONE.
4. **Write audit-protocol doc** at `docs/process/audit-protocol.md` (NEW directory). ✅ DONE.
5. **Update memory `current_work.md`**. ✅ DONE.
6. **Write THIS merged-plan doc.** ✅ DONE.
7. **Commit W5-59** as session finalization. ⏳ NEXT.
8. **Mega-audit W5-53..W5-58** via Codex + Sonnet parallel. Same brief template as W5-52. ⏳ AFTER COMMIT.
9. **Apply mega-audit findings + W5-60 closure** if HIGH issues surface. ⏳

## Plan for the next Claude Code window

Per the merged plan, the next window's first action is to run the mega-audit IF this session deferred it (likely). If the mega-audit landed in W5-60 already, the next window's first work item is Phase 4.3 polish — wildcards in SUMIF/COUNTIF/SEARCH + PROPER + CLEAN + CONCAT (range-aware) + RANK.AVG + CEILING.MATH / FLOOR.MATH. Keep MODE.MULT deferred (needs Phase 4.7 spill).

## Critical risk if audit-protocol is skipped

Quoting Codex: "The failure mode is not just bugs. It is false confidence: commit messages say 'all green,' docs say 'unblocked,' and the next engineer skips the adversarial read. The protocol forces every phase to leave an auditable trail: what changed, what was checked, what remains unsafe, and what the next window must not assume."

The W5-50 → W5-52 arc is the case study. W5-50 shipped under "GAP-G-01 closed" framing. The `on_clear_formula` clear-path bug shipped silently. W5-52 mega-audit (Codex + Sonnet) caught it because both auditors independently flagged the same staleness class on the clear path. Without the parallel pattern, a future regression in this surface would have been the first time the bug surfaced — much later, in user code.

## Sign-off

— Claude Opus 4.7 (1M context), W5-59 finalization session, 2026-05-13. Companion: Codex (gpt-5.5 read-only sandbox, 5668-line planning verdict at `2026-05-13-finalization-planning-codex.txt`).
