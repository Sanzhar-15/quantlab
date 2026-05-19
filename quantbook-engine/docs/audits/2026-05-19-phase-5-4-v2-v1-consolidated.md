---
title: Phase 5.4 V2 V1 audit synthesis (undo grouping)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI) — full transcript: `2026-05-19-phase-5-4-v2-v1-codex.md`
  - Opus subagent (86k tokens, 583s) — full transcript: `2026-05-19-phase-5-4-v2-v1-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `6138a7203f6` (Phase 5.4 V2 V1 — undo grouping)
---

## Scope

Thin wrappers around Loro `UndoManager::group_start` /
`group_end` / `set_merge_interval` on `CollabSession`. ~50 LOC
+ 4 tests. Per audit-discipline rule, parallel Codex + Opus
dispatched.

## CRITICAL CONVERGENT FINDING — git-index-race truncation (HIGH)

**Both auditors INDEPENDENTLY caught a blocking defect:** the
commit blob at `6138a7203f6` had `crates/ql-collab/src/session.rs`
truncated mid-string at line 1436. The committed crate does NOT
compile.

- Opus checked out the commit cleanly into `/tmp/audit-5.4-v2-v1`
  and ran `cargo check -p ql-collab --tests` → `error[E0765]:
  unterminated double quote string`.
- Codex ran `cargo fmt --all -- --check` → same `E0765` error.

**Root cause:** the recurring `cargo fmt × git add` index-padding
race noted in user memory (`git_index_padding_race.md`). Same
failure mode as `3590aa6d89e` (Phase 5.5 V1) which was repaired
by `924750819bc` ("fix: restore truncated test bodies"). The
race struck for the 2nd time in this session.

**Closure:** ✅ Restored the 4 missing trailing lines via Edit;
cargo build + test now pass. The closure commit (this commit)
restores the file.

This is the **single most important catch** of the entire 9-cycle
session — without the 2-way audit discipline, we would have
shipped a broken `ql-collab` crate. Both auditors caught it from
clean-checkout verification, not from looking at the in-process
file state (which was on disk correct, just not committed correctly).

## Other CONVERGENT findings

| Aspect | Codex | Opus | Disposition |
|---|---|---|---|
| Nested `start_undo_group` deterministic Err | (not flagged) | MEDIUM-1 | ✅ docstring rewritten + test pinned |
| Doc drift across 5 files | LOW | MEDIUM-4 | ✅ all 5 closed |
| Missing nested + empty group tests | LOW-1 | LOW-1 | ✅ 2 new tests added |

## Opus-only findings

- **M2 (`&mut self` vs `&self`):** Opus argued for `&self`.
  **REJECTED** — Loro's public wrapper takes `&mut self` for these
  methods; matching is correct. `clear_undo_stack(&self)` matches
  Loro's `clear(&self)` similarly.
- **M3 (RAII helper):** Documented as a known V2 V1 limitation;
  V2 V1.1 will add `with_undo_group` closure helper.
- **M5 (negative interval undocumented):** ✅ docstring clarified.
- **LOW-2 (missing redo_count assertion):** ✅ added.
- **LOW-5 (pre-existing undo.rs drift):** ✅ closed.

## Codex-only findings

Codex confirmed Loro source semantics:
- `group_start` while open: deterministic `Err(UndoGroupAlreadyStarted)`.
- `group_end` on empty: no-op (no phantom unit pushed).
- `merge_interval` × explicit groups: groups take precedence.

## Deferred (with rationale)

- Opus M2 `&self` migration: KEPT `&mut self` matching Loro's
  wrapper signature.
- Opus M3 RAII helper: V2 V1.1 follow-up.
- LOW-1 merge-interval functional test: needs time-mocking;
  flagged in docstring as TODO.
- LOW-4 entry-plan row hash: addressed in this audit-closure
  commit message.

## Gates (post-closure)

- `cargo test --workspace`: **4215 passed** (4213 V2 V1 ship +
  2 audit-closure tests; truncation fix added no tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy -p ql-collab --all-targets -- -D warnings`: clean.

## Verdict

**Phase 5.4 V2 V1 is ship-clean post-closure.** Critical truncation
defect closed. All MEDIUMs either closed or explicitly deferred
to V2 V1.1 / V2 V2.

## Discipline meta-note

This is the **7th consecutive cycle** validating 2-way audit
discipline. This cycle's catch is the highest-value yet:

- Codex AND Opus independently ran `cargo check` against a clean
  checkout, BOTH found the truncation, BOTH refused to ship.
- Either auditor alone would have caught it. The convergence
  STRENGTHENED the verdict ("don't ship" became unambiguous).
- A self-only audit would NOT have caught this — my own
  `cargo test --workspace` ran from the (correct) working tree,
  not from the (broken) committed blob. The commit's pre-commit
  hook saw a different file state than `git show HEAD` produces.

This is the 2nd time the git-index-padding-race has struck this
session (the 1st was Phase 5.5 V1 `3590aa6d89e`). The pattern is
clear: `cargo fmt --all` × `git add` race in this repo's
pre-commit hook environment. The mitigation (re-stage + commit
fix) works reliably; the root cause (likely a stdio-maxbuffer in
the precommit hook) would require investigation in a separate
session.

After 7 substantive cycles, the 2-way audit has caught real
correctness/contract bugs in 6 of 7 — only the 5.5 V1 audit-closure
docs shipped without HIGH findings. Every implementation cycle
has had at least one HIGH catch.
