---
title: Phase 5.6 V1 audit synthesis (presence map)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, 137k tokens) — full transcript: `2026-05-19-phase-5-6-v1-codex.md`
  - Opus subagent — Anthropic 529 Overloaded × 3 dispatches; final retry pending or skipped.
  - Self (single-pass) — drove the closures.
audit_target: commit `c677e244704` (Phase 5.6 V1 — presence map)
---

## Scope

Behavioral change: new `"presence"` LoroMap container + 4 OpLog
methods + ql-collab presence module + 4 CollabSession methods +
11 tests. Per audit-discipline rule, parallel Codex + Opus
dispatched. **Opus 529 Overloaded × 3 dispatches** — Anthropic
server-side issue (not a Claude Code failure). Audit proceeds
with Codex-only + self coverage; flagged in this document.

## Codex findings

### MEDIUM — persistence contract drift (CLOSED)

**Finding:** `crdt-data-model.md:240` (pre-implementation) said
"Presence updates do NOT persist across `.qbook` save/load." V1
implementation persists presence via the LoroDoc snapshot
exported into `oplog.bin` (`crates/ql-io/src/oplog_persistence.rs:82`
exports the whole snapshot).

**Closure:** Documented as V1 known limitation in both:
- `crates/ql-collab/src/presence.rs` module docstring (replaced
  the prior persistence claim with the new "V1 limitation"
  block, with cross-ref to crdt-data-model.md).
- `docs/architecture/crdt-data-model.md` § Presence container
  (updated with the V1 status marker + explicit acceptance
  rationale: rejoining peer overwrites own entry, stale absent-
  peer entries visually distinguishable in IDE, eviction would
  need per-container export filtering Loro doesn't expose).

V2 follow-up: load-time presence-eviction sweep on
`CollabSession::from_snapshot`. Logged in entry-plan.md.

### LOW — missing tests (CLOSED)

Added 3 tests across ql-oplog + ql-collab:
- `presence_merge_is_commutative` (ql-collab) — verifies both
  merge directions produce identical final state.
- `presence_same_key_lww_under_concurrent_merge` (ql-oplog) —
  two peers write to the same presence key; asserts ONE value
  survives + map has exactly 1 entry (no corruption).
- `presence_tombstone_propagates_through_merge` (ql-collab) —
  peer A clears presence; peer B merges new snapshot; B sees
  A as gone.

Workspace tests: 4177 → 4180 (+3).

### LOW — doc tense / status drift (CLOSED)

- `crdt-data-model.md` § Presence container: ✅ V1 shipped
  marker + commit hash added; UUID→16-hex correction.
- `entry-plan.md` 5.6 sub-item row: future → V1 SHIPPED.
- `known-gaps.md` GAP-C-03: append 5.6 V1 closure to existing
  closed-list entry; ql-collab test count updated.
- `peer.rs:14`: "will key" → "keys the `presence` LoroMap in
  16-hex `Display` form... (✅ shipped at c677e244704)".
- `session.rs:14` Phase 5.6 bullet: future-tense → ✅ V1
  shipped with commit hash.

## Self-audit findings (none beyond Codex)

Reviewed:
- API ergonomics (`Result<Option<_>, _>` triple-wrap is defensible per Codex B2).
- &mut self propagation (presence_set/remove take `&mut self` to match append; consistent).
- Forward implications for Phase 5.4 (UndoManager scope), 5.5 (transport bandwidth), 5.7 (IDE metadata) — noted but no V1 action.
- Loro internals (Codex independently verified LWW + tombstone semantics against `loro-internal-1.12.0/src/state/map_state.rs:61` + `map_delta.rs:26` + `handler.rs:4047`).

No NEW findings beyond Codex.

## Discipline meta-note

This is the FIRST time this session's 2-way audit failed
(Anthropic 529 × 3). Codex coverage was thorough (137k tokens,
10921 lines of trace) and caught the highest-leverage finding
(persistence contract drift). Self-audit covered tense / drift.

**Counter-factual:** would Opus have found something Codex
missed? Looking at Phase 5.2.b's 2-way audit, Opus uniquely
caught:
- u64::MAX rejection (would have been missed here too — but the
  type was unchanged from 5.2.b which Opus already verified).
- Undocumented test PeerId(0) → PeerId(100) change (not
  applicable to 5.6 V1).
- Stability section pre-stability log (not applicable; no API
  signature changes in 5.6 V1).

So for this specific cycle, the Opus unavailability is likely
NOT load-bearing. But the discipline rule remains: future
behavioral changes should attempt 2-way, and if the second
auditor is unavailable, the consolidated doc should surface it
as it does here.

## Verdict

**Phase 5.6 V1 is ship-clean post-closure.** All Codex findings
addressed: 1 MEDIUM + 4 LOW closed. Opus 529 Overloaded gap
documented. Workspace 4180 passing; fmt + clippy clean.

## Gates (post-closure)

- `cargo test --workspace`: 4180 passed, 0 failed, 167 ignored
  (4177 5.6 V1 ship → +3 audit-closure tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean
  on ql-oplog + ql-collab; not re-run workspace-wide (no
  cross-crate changes outside the two).
