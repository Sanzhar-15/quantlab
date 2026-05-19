---
title: Phase 5.2.b audit synthesis (PeerId → LoroDoc wiring)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, 278k tokens) — full transcript: `2026-05-19-phase-5-2-b-codex.md`
  - Opus subagent (135k tokens) — full transcript: `2026-05-19-phase-5-2-b-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `ef056f50bee` (Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id)
---

## Scope

Parallel 2-way audit per audit-discipline rule, triggered by a
behavioral change (Phase 5.2.a scaffold limitation closed). Both
auditors verified:
- Loro semantics (set_peer_id only affects FUTURE appends; imported ops keep their origin).
- API ergonomics (Result return type defensible for pre-0.2.0).
- Test coverage gaps.
- Doc drift across `crdt-data-model.md` / `entry-plan.md` / `known-gaps.md`.
- Test count: BOTH auditors reported **4164** (not the 4162 my own awk script produced — my script undercounted by 2; corrected).

## Convergent findings (caught by BOTH auditors)

| ID | Finding | Codex | Opus | Disposition |
|---|---|---|---|---|
| CONV-1 | `OpLog::set_peer_id` docstring claim "Idempotent — no-op" overstates Loro behavior (Loro always re-stores + emits notification; only the observable peer_id is unchanged) | Codex LOW#1 | Opus MED-1 | ✅ FIXED — docstring softened to "leaves peer id unchanged but NOT a strict no-op"; warns against hot-path repeats |
| CONV-2 | Import tests don't actually import committed ops (origin was empty in both `set_peer_id_after_import_works` and `from_snapshot_overrides_imported_peer_id`), so the "imported ops retain origin" promise was never exercised | Codex LOW#3 | Opus MED-2 | ✅ FIXED — both tests now append before export; assert imported op survives the peer-id swap; assert further appends use the new peer id |
| CONV-3 | `CollabSession::new` / `from_snapshot` docstrings don't surface both Loro pitfalls (only duplicate-id; missing fixed-user-device-locking AND u64::MAX-reserved) | Codex LOW#2 | Opus MED-3 (partial) | ✅ FIXED — both constructors now list all 3 pitfalls inline |

## Codex-only findings

| ID | Finding | Disposition |
|---|---|---|
| Codex LOW#4 | `known-gaps.md` GAP-C-03 says "ql-collab is a 15-line stub" + GAP-C-05 references "Stub crate ql-collab empty" — both stale | ✅ FIXED — GAP-C-03 marked CLOSED at 5.2.a/5.2.b with cross-refs; GAP-C-05 reproduce text updated to reflect Transport trait shipped but only NoopTransport impl exists |
| Codex C2 | Phase 5.2 D-4 spill probe (`phase_5_2_d4_spill_2peer_probe.rs:64`) uses bare `OpLog` defaults — doesn't exercise the new stable PeerId path | DEFERRED — leave as-is. Codex confirmed all 4 D-4 tests still pass. The probe exercises Loro merge-determinism (its purpose), not peer-id-attribution. A CollabSession-backed D-4 variant is forward-work; not blocking. |

## Opus-only findings

| ID | Finding | Disposition |
|---|---|---|
| Opus MED-3 (u64::MAX) | `u64::MAX` rejection undocumented + untested at OpLog/CollabSession boundary | ✅ FIXED — pitfall #4 added to `OpLog::set_peer_id` docstring + `CollabSession` docstrings; 2 new tests pinned: `set_peer_id_max_is_rejected_as_loro_sentinel` (oplog) + `peer_id_max_is_rejected_by_constructors` (collab) |
| Opus MED-4 (duplicate-peer-id pitfall unguarded) | No debug-assert / test catches in-process duplicate PeerId use | DEFERRED — Codex also flagged but recommended enforcement at the future allocator/transport layer rather than at OpLog/CollabSession. Documented loudly in both docstrings; revisit at Phase 5.5 transport handshake design |
| Opus MED-5 | Test count off-by-2: commit msg + memory said 4162 vs actual 4164 | ✅ FIXED — memory files updated; root cause was awk parsing of "test result" lines undercounted; commit msg itself is immutable but noted in this audit doc |
| Opus MED-6 | `docs/phase5/entry-plan.md` sub-item table row + `shipped_commits` frontmatter missing 5.2.b | ✅ FIXED — `ef056f50bee` added to both |
| Opus MED-7 | `docs/phase5/entry-plan.md` status frontmatter missing 5.2.b mention | ✅ FIXED — appended "5.2.b PeerId → LoroDoc wiring SHIPPED (ef056f50bee)" |
| Opus LOW-1 | 2^-64 theoretical flake in `set_peer_id_changes_doc_peer_id` | KEPT — astronomical probability; LOW signal; removing the `assert_ne!` would reduce safety net |
| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
| Opus LOW-3 | Stability section missing one-line note about 5.2.b API shift | ✅ FIXED — `ql-collab/src/lib.rs` Stability section now logs the pre-stability API change |
| Opus LOW-4 | Awkward "5.2.a (5.2.b update)" heading in session.rs module doc | DEFERRED — minor style; not load-bearing |
| Opus LOW-5 | `&self` vs `&mut self` API surprise (`OpLog::set_peer_id`) | DEFERRED — Loro-imposed shape (`LoroDoc::set_peer_id` takes `&self`); changing it would require artificial `&mut` borrow with no semantic value |

## Forward implications (Opus + Codex both noted)

**Phase 5 D-1 (FormatId tagged tuple) gets a small simplification.**
With 5.2.b in place, the FormatId allocator can read `log.peer_id()` instead of taking PeerId as a parameter — the OpLog now authoritatively knows its own peer id. Implementation detail, not a design change. The D-1 author should know `OpLog::peer_id()` is reliable.

## Gates (post-closure)

- `cargo test --workspace`: 4166 passed, 0 failed, 167 ignored (4164 + 2 new u64::MAX tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean (cleared the doc_lazy_continuation warning during initial commit).
- `cargo doc --no-deps -p ql-oplog -p ql-collab`: 2 pre-existing intra-doc-link warnings (`presence`, `undo` reserved modules from 5.2.a, not introduced by 5.2.b).

## Verdict

**Phase 5.2.b is ship-clean post-closure.** Both auditors verified no MUST-FIX correctness issues; all convergent findings + 5 of 7 Opus-only MEDIUMs closed. Two MEDIUM deferrals are documented + forward-tracked (D-4 CollabSession variant, duplicate-peer-id enforcement at allocator/transport layer).

## Discipline meta-note

This is the **3rd consecutive cycle** this session where the 2-way Codex+Opus discipline caught what each alone would have missed:
- Phase 5.1 design audit (`918d7efdd91`): Codex caught the Loro merge-rule misstatement (Lamport → Fugue/origin); Opus caught the AddSheet UX critique.
- Phase 5.2.b PeerId wiring (this audit): Codex + Opus independently converged on idempotence-claim + test-strength + u64::MAX-rejection — 3 high-signal items that would have been silently shipped under self-audit alone.
- Handoff completeness audit (commit `687e5dd3995`): Codex caught the `peer.rs` set_peer_id docstring lie which CASCADED into this 5.2.b cycle.

The rule "audit after each phase/wave/implementation" is paying compound dividends. The 2-way discipline is borderline for trivial doc edits but load-bearing for behavioral changes (even small ones like a 2-method addition).
