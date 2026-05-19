---
title: Phase 5.4 V1 audit synthesis (peer-local undo)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, 219k tokens) — full transcript: `2026-05-19-phase-5-4-v1-codex.md`
  - Opus subagent (95k tokens) — full transcript: `2026-05-19-phase-5-4-v1-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `89c02b9d83e` (Phase 5.4 V1 — peer-local undo/redo via Loro UndoManager)
---

## Scope

Behavioral change wrapping `loro::UndoManager` into
`CollabSession`. Per audit-discipline rule, parallel Codex +
Opus dispatched. Both auditors returned successfully (Opus
finally got past the 3-cycle 529 streak from earlier in the
session). Independent verification of Loro internals at:
- `loro-internal/src/undo.rs:166,654-662,615-643,601`
- `loro-internal/src/lib.rs:3719`

## Convergent findings (BOTH auditors caught)

Both auditors flagged the **API exposure of `OpLog::set_peer_id`
through `op_log()`** as a real issue:

| Aspect | Codex | Opus | Disposition |
|---|---|---|---|
| Issue | "MEDIUM A3: `op_log()` exposes set_peer_id; allows post-construction peer-id changes while undo is live" | "HIGH H1: silent undo-stack-clear footgun" | ✅ **CLOSED** — `OpLog::set_peer_id` changed from `&self` to `&mut self`. Now unreachable through `CollabSession::op_log()` (`&OpLog`). Docstring updated with pitfall #5 documenting Loro's silent-clear behavior. |

Both auditors also flagged the **doc drift across 4 files** (same
findings, different numbering). Closed in this commit.

Both flagged the **C2/M6 multi-peer-merge undo test gap**. Closed
with `local_undo_after_remote_merge_preserves_remote_ops`.

Both flagged the **C3/L4 reborn-session undoability gap**. Closed
with `reborn_session_has_empty_undo_stack`.

## Codex-only findings

### HIGH — `cached_len` stale after undo/redo

**Codex C1/HIGH:** Loro's `UndoManager` retracts the original op
from the visible `"ops"` list when undoing; my `OpLog::cached_len`
field was only updated on `append` + `import_bytes`, so after
undo, `op_count()` reported stale 2 while `iter().count()`
correctly reported 1. Opus missed this — would have shipped a
real correctness bug.

**CLOSURE:** removed the `cached_len` field entirely. `OpLog::len()`
now queries `self.doc.get_list(OPS_CONTAINER).len()` directly.
Correct by construction; per-call cost is one container handle
lookup + a length read (cheap). Updated docstring + Debug field.
Added regression test `undo_retracts_visible_op_from_op_log_len`
that asserts `op_count() == iter().count()` pre/post undo+redo.

### LOW — drop-order doc bug

**Codex A2 LOW:** my comment claimed `undo` drops FIRST because
"Rust drops fields in REVERSE declaration order." That's wrong —
Rust drops fields in DECLARATION order, so `undo` (declared last)
drops LAST. The runtime behavior is safe anyway because Loro's
`UndoManager` owns a `LoroDoc.clone()`, not a borrow. Opus didn't
catch this docstring error.

**CLOSURE:** comment rewritten to accurately describe declaration-
order drop AND the fact that UndoManager owns a doc clone, so
drop order isn't load-bearing.

## Opus-only findings

### MEDIUM — `PRESENCE_COMMIT_ORIGIN` prefix-match overreach

**Opus M5:** Loro's `add_exclude_origin_prefix` is a `starts_with`
match (`loro-internal/undo.rs:601`). With `"presence"` as the
prefix, any future origin starting with `"presence"` would be
silently excluded. Codex flagged the same prefix-match semantics
(A4) but only as a caveat, not actionable.

**CLOSURE:** changed `PRESENCE_COMMIT_ORIGIN` from `"presence"`
to `"presence:"`. Trailing `":"` makes the prefix a deliberate
namespace (e.g. `"presence:typing"` would also be excluded; an
independent `"presence-foo"` would NOT). Docstring updated.

### MEDIUM — Stability section missing `loro::LoroError` leakage note

**Opus H2:** `CollabSessionError::Undo(#[from] loro::LoroError)`
exposes loro's error type publicly. Pre-0.2.0 acceptable but
needs a Stability log entry.

**CLOSURE:** added a bullet to `ql-collab/src/lib.rs` `###
Pre-stability API changes` documenting the leakage + commitment
to re-type before 0.2.0. Also added the `OpLog::set_peer_id`
`&self → &mut self` change as a separate bullet.

## Deferred (intentionally not closed)

- Opus L1 (clear_undo_stack &self vs undo/redo &mut self inconsistency) — acceptable per Loro's API shape; L2 / L3 / L5 also deferred per stated rationale.
- Codex C4 / Opus L3 (no `Undo(LoroError)` test) — unreachable from V1's public surface; documented instead.
- Loro grouping / merge-interval / push-pop listeners — explicit V2 work per design doc.

## Gates (post-closure)

- `cargo test --workspace`: **4187 passed** (4184 ship → +3 audit-closure tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean per pre-closure Codex run.

## Verdict

**Phase 5.4 V1 is ship-clean post-closure.** Both auditors'
HIGHs closed. Both auditors' MEDIUMs closed (excluding the
deferred-with-rationale items). Convergent agreement on the
set_peer_id footgun (Opus H1 + Codex MEDIUM) and doc drift +
test gaps validates the 2-way audit-discipline rule.

## Discipline meta-note

This cycle is the **clearest evidence yet** that 2-way audit
is load-bearing:
- Codex caught the cached_len HIGH (would have silently shipped
  a correctness bug — wrong op_count after undo).
- Opus caught the set_peer_id footgun framing as HIGH (Codex
  also caught it but labeled MEDIUM — Opus's HIGH framing was
  more accurate given the silent-clear behavior).
- Codex caught the drop-order doc bug (would have silently
  shipped misleading documentation).
- Opus caught the PRESENCE_COMMIT_ORIGIN prefix-match overreach
  (Codex flagged the semantics but didn't recommend the
  `":"` fix).

If either auditor had been unavailable this cycle, we'd have
shipped real bugs. The earlier `5.6 V1` cycle ran with
Codex-only coverage (Opus 529'd × 3) — that was acceptable for
the smaller surface, but this 5.4 V1 cycle would have been a
real regression.
