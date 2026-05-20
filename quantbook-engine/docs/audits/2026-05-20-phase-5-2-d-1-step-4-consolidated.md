---
title: Phase 5.2 D-1 step 4 audit synthesis (Op wire + by_string restructure)
status: CLOSED
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~155k tokens) — full transcript: `2026-05-20-phase-5-2-d-1-step-4-codex.md`
  - Opus subagent (148k tokens, 366s) — full transcript: `2026-05-20-phase-5-2-d-1-step-4-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `6a4b8b0922f` (Phase 5.2 D-1 step 4 — Op carries FormatIdWire + by_string peer-scope restructure)
closure_commit: (this commit — audit closures)
---

# Phase 5.2 D-1 step 4 audit synthesis

## Headline

**Second DIVERGENT-HIGH cycle of the session** (after step 3 audit). Codex found 1 HIGH; Opus PASSED with 0 HIGH. As at step 3, the divergence WAS the finding — Codex's HIGH was a forward-activating bug that Opus's "passes for now" framing would have shipped to step 5.

- Codex: 1 HIGH + 2 MEDIUM + 1 LOW.
- Opus: 0 HIGH + 1 MEDIUM + 5 LOW.

The HIGH (intern_format global iter().find() bypassing peer scoping) matches the step-3 audit pattern exactly: dormant today (no multi-peer producer exists), live once step 7 IDE wires CollabSession to a Workbook. Codex's forward-looking framing won again.

## Findings + closures

### HIGH (Codex; closed this cycle)

**H1 — `WorkbookRuntime::intern_format` global iter().find() bypasses peer scoping.**
- Source: `crates/ql-exec/src/workbook_runtime/formats.rs:45`.
- The dedup check `self.workbook.formats().iter().find(|(_, t)| *t == s)` iterates the WHOLE by_id map and returns ANY id matching the string. Post-step-4, multiple ids can map to the same string (cross-peer Custom + Builtin coexistence). Scenario: peer A's runtime sees a replayed `Custom(B, 0) = "yyyy-mm-dd"` in by_id. `intern_format("yyyy-mm-dd")` returns Custom(B, 0) — WRONG. Producer/replay symmetry violated: no Op::RegisterFormat emitted, but a separate peer with the same workbook state would allocate Custom(A, 0).
- Codex also flagged HashMap iteration order: short-circuiting on the first iter().find() hit could bypass Builtin-first precedence (e.g. if Custom(LEGACY_PEER, 0) = "General" is iterated before Builtin(0) = "General").
- **Closure (this commit):** new method `FormatTable::lookup_string(s: &str) -> Option<FormatId>` mirrors `intern()`'s lookup order without allocating: by_builtin_string first, then by_custom_string[(local_peer, s)], else None. `WorkbookRuntime::intern_format` updated to use it. 2 new ql-storage tests (lookup_string peer-scoped + Builtin-precedence-after-Custom-registered).

### MEDIUM (Codex; closed this cycle)

**M1 — Counter overflow at 3 sites in FormatTable.**
- Source: `crates/ql-storage/src/format.rs:310, 347, 429`.
- `next_custom_counter = counter + 1` overflows when counter = u32::MAX. Wraps to 0 in release; panics in debug. Release wrap can overwrite Custom(peer, 0). Reachable through `FormatIdWire::Custom { counter: u32 }` replay payload.
- **Closure (this commit):** all 3 sites use `checked_add(1).expect("FormatTable: custom counter exhausted (u32::MAX per-peer custom formats)")`. Loud panic with clear message instead of silent wrap.

**M2 — `debug_assert_ne!(peer, 0)` missing from `CollabSession::from_snapshot`.**
- Source: `crates/ql-collab/src/session.rs:204`.
- `CollabSession::new` has the LEGACY_PEER guard from step 4 (Opus step-2 L4 closure); `from_snapshot` is also an active-session constructor but lacks the same guard. Step 7 IDE snapshot-join callers would bypass the guard.
- **Closure (this commit):** added the same `debug_assert_ne!` to from_snapshot with updated docstring.

### MEDIUM (Opus; deferred with rationale)

**M3 (Opus) — Commit msg/checklist doesn't call out oplog.bin wire-format break.**
- Opus correctly notes the step-4 commit doesn't say "pre-step-4 oplog.bin files won't deserialize anymore." Mitigation already exists: no `.bin` fixtures in repo; failure mode is loud (`OpLogError::Deserialize`); step 7 magic-bytes/version-header lands the migration framing.
- **Deferred to step 7 commit message** per Opus's own recommendation.

### LOW (closed this cycle)

**L1 (Codex) — LibreOffice test missing `intern("General") == Builtin(0)` assertion.**
- Source: `crates/ql-io-xlsx/src/read/styles_import.rs:203`.
- **Closure (this commit):** added the missing assertion to `libreoffice_general_at_custom_id_registers_under_custom_namespace`. Pins the Builtin-first precedence at the xlsx-import boundary.

**L1 (Opus) — No direct `from_storage`/`to_storage` round-trip test.**
- **Closure (this commit):** 3 new ql-oplog tests: `from_storage_to_storage_round_trip_for_builtin` (5 boundary values), `from_storage_to_storage_round_trip_for_custom` (5 cross-peer/counter combos), `to_storage_from_storage_round_trip` (reverse direction).

**L5 (Opus) — Builtin-vs-Builtin string collision case not directly tested.**
- **Closure (this commit):** new ql-storage test `register_at_builtin_vs_builtin_same_string_collision_rejects`.

### LOW (deferred with rationale)

**L2 (Opus) — `intern` String allocation per lookup.** Performance optimization (HashMap raw_entry / Borrow trick). Defer to step 8 megaudit. The audit's perf budget for D-1 was not the structural-correctness budget; if profiling surfaces this as hot, fix then.

**L3 (Opus) — xlsx redundant numFmt bloats FormatTable.** Forward concern for xlsx export (step 6). Memory + bytes overhead is small; user-visible behavior unchanged. Defer.

**L4 (Opus) — `debug_assert_ne!(peer, 0)` not at `OpLog::set_peer_id`.** The step-2 LOW recommended the lower-layer placement; step 4 chose the higher-level `CollabSession::new` + (this audit) `from_snapshot` placement, catching all production callers. The OpLog API is low-level and tests legitimately use PeerId(0) (LEGACY_PEER). Defer with documented justification.

## Convergence summary

| Finding | Codex | Opus | Both? |
|---|---|---|---|
| H1 (intern_format global iter() bug) | HIGH | (didn't flag) | DIVERGENT |
| M1 (counter overflow at 3 sites) | MEDIUM | (didn't flag) | DIVERGENT |
| M2 (from_snapshot missing debug_assert) | MEDIUM | (didn't flag) | DIVERGENT |
| M3 (commit msg + checklist wire-break note) | (didn't flag) | MEDIUM | DIVERGENT |
| L1a (LibreOffice intern("General") assertion) | LOW | (didn't flag) | DIVERGENT |
| L1b (from_storage round-trip test) | (didn't flag) | LOW | DIVERGENT |
| L2 (intern String allocation) | (didn't flag) | LOW | DIVERGENT |
| L3 (xlsx bloat) | (didn't flag) | LOW | DIVERGENT |
| L4 (set_peer_id debug_assert placement) | (didn't flag) | LOW | DIVERGENT |
| L5 (Builtin-vs-Builtin collision test) | (didn't flag) | LOW | DIVERGENT |

**Zero convergent findings out of 10.** The auditors viewed the commit from completely different angles. Codex focused on producer/replay symmetry + soundness (overflow, peer guards). Opus focused on documentation + performance + completeness. Both found real issues; neither found what the other found.

## Discipline meta-note

**12th-cycle data point.** This is the SECOND consecutive divergent-HIGH cycle (step 3 audit was the first; both involved Codex flagging forward-activating bugs that Opus marked as dormant-and-fine).

Pattern emerging: when the code change is structurally large (step 3: 241 callsites; step 4: by_string restructure + wire format), each auditor sees the elephant differently. Codex tends toward "this won't work when X happens in step N+1" framings; Opus tends toward "this is correct as-is and well-documented." Both are right under their framing; the divergence is load-bearing — Codex's forward catches save step-N+1 bugs, Opus's pass-with-followups catches documentation/polish gaps.

**12 of 12 audit cycles** this session caught real load-bearing issues. The HIGH-rate audit pattern continues to be the single most expensive but valuable discipline of the session.

## Gates re-verified post-closure

- `cargo test -p ql-storage --lib format::tests`: **31 passed** (was 28 + 3 new: lookup_string-peer-scoped, lookup_string-Builtin-precedence, Builtin-vs-Builtin collision).
- `cargo test -p ql-oplog --lib wire::`: **20 passed** (was 17 + 3 new: from_storage/to_storage round-trips).
- `cargo test --workspace`: **4257** passed / 0 failed (was 4251 + 6 net new).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.

## Forward note

Step 5 (qbook envelope schema bump + legacy loader) starts on solid foundation:
- producer/replay symmetry verified.
- by_string peer-scope structurally correct + test-pinned.
- Counter overflow safe in all 3 increment sites.
- PeerId(0) guard at both CollabSession constructors.
- FormatId ↔ FormatIdWire conversions round-trip-tested.
- LEGACY_PEER migration path (`legacy_from_u32` + `to_legacy_u32`) audited and clean.

Step 5 scope:
1. Bump `qbook_format::WORKBOOK_SCHEMA_VERSION` (7 → 8).
2. Add legacy loader: read old u32-shaped `FormatEntry.id` + `FormatOverlayEntry.id`, migrate via `FormatId::legacy_from_u32`.
3. Drop the `to_legacy_u32().expect()` sites in qbook_format save path (envelope now carries FormatIdWire directly).
4. Fixture tests: load a saved-at-schema-7 .qbook fixture, verify migration produces correct Custom(LEGACY_PEER, _) ids.
5. Update `MIN_SUPPORTED_SCHEMA_VERSION` reasoning + UnsupportedSchema error path.
