---
audit: Phase 5.1 — CRDT Data Model Decision (consolidated)
auditors: Codex + Opus subagent (parallel 2-way pass)
date: 2026-05-19
design_under_review: docs/architecture/crdt-data-model.md @ 918d7efdd91
closures_landed_at: <head-after-this-commit>
companion_docs:
  - docs/audits/2026-05-19-phase-5-1-codex.md
  - docs/audits/2026-05-19-phase-5-1-opus.md
---

# Phase 5.1 design audit — consolidated findings + closure summary

Parallel 2-way audit on the pre-audit draft. Codex's first
attempt ran out of context window during broad alternative-CRDT
web research; retry with tighter scope (5 specific verification
tasks) completed cleanly. Opus ran in parallel with focused
critique on UX + effort estimates + container-shape choices.

## Verdict

- **Codex:** 4 HIGH + 1 verified-clean.
- **Opus:** 3 HIGH + 5 MEDIUM + 2 LOW + 4 OK confirmations.

This is by far the most substantive audit yet — the design's
two technically-wrong claims (Loro merge semantic, spill
mechanism) would have flowed into 5.2 implementation if only
the Opus pass had run. The 2-way discipline is the load-
bearing safety net.

## Unique HIGHs (combined)

### Format-id wire format (Opus H-1, Codex V4)

Both auditors independently confirmed: concurrent
`intern_format("X")` and `intern_format("Y")` from two peers
both predict id N (`formats.rs:51` predicts via
`next_custom_id()`); both emit `Op::RegisterFormat` at id N
with different strings; replay's
`FormatTable::register_at` rejects with `IdCollision`. Real
bug at the data-model level.

**Closure (design D-1):** `FormatId` switches to
`Builtin(u32) | Custom(PeerId, u32)` tagged tuple. Wire-
format bump in Phase 5.2; backwards-compat migration path
defined. Locked in 5.1 (not deferred to 5.3).

### RenameSheet × concurrent edit (Opus H-2, Codex V5)

Both auditors confirmed the bug. Codex provided the exact bug
shape (`BindError::UnknownSheet`, NOT `UnresolvedName` as the
pre-audit design said) and the specific gap:
`recompute_all`/`recompute_dirty` don't map `UnknownSheet` to
`Value::Error(ErrorValue::Name)` — only `UnknownTable` and
`UnknownTableColumn` get that treatment in the current Phase 4
code. Worst-case result: cell retains stale pre-recompute
value AND surfaces as `RecomputeFailure`.

**Closure (design D-3):** Phase 5.2 adds the missing
`BindError::UnknownSheet → ErrorValue::Name` mapping. Phase
5.3 adds the causality-aware rename-repair pass that rewrites
concurrent-edit formula text in-place at merge time.
Documented as a Phase 5.2 V1 known limitation.

### AddSheet name collision (Opus H-3, Codex did not cover)

Pre-audit design said "AddSheet S × AddSheet S → first wins;
second errors via NameRejected." Opus flagged this as
undesirable UX vs Google Sheets / Excel Online which auto-
rename to S(2).

**Closure (design D-2):** Phase 5.2 acceptance criterion adds
auto-rename in deterministic merge order. `Op::AddSheet { name }`
wire format is unchanged; replay disambiguates at apply time.

### Loro merge semantic claim WRONG (Codex V1, Opus M-1)

Codex deep-read the Loro crate source. The pre-audit design
claimed "LWW by Lamport timestamp." Loro actually uses
**Fugue/origin-based ordering with peer-id tiebreaker**
(`loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163,192`).
Both concurrent pushes are preserved (not overwritten); merge
order is deterministic and receive-order-independent given
unique peer IDs.

The SEMANTIC LWW outcome at the engine level still holds —
deterministic replay applies both ops in causal order;
whichever is later wins. But the pre-audit wording attributed
the LWW to Loro's merge picking one push, which is WRONG.

**Closure:** Design doc wording corrected in this revision.
Now describes the Loro merge as "Fugue/origin-based" and
attributes the LWW outcome to deterministic replay.

### Spill semantic claim WRONG (Codex V3, Opus M-2)

Codex verified that the pre-audit description of spill
semantics doesn't match the actual replay code path. Replay's
`PutFormula` handler stores formula text but does NOT
evaluate or materialize spills (`replay.rs:328`). Spills are
derived from final replay state by `recompute_all` AFTER
replay completes. The `write_spill` blocking check
(`cells.rs:669`) runs at recompute time.

The CRDT correctness story holds, but for a different reason
than claimed. Concurrent `PutFormula(A1, "SEQUENCE(3)")` +
`PutValue(A2, 5)` produces the same recompute outcome
regardless of merge order because recompute_all is called
once post-replay.

**Closure:** Design doc wording corrected in this revision
(D-4). Now describes the deferred-to-recompute_all behavior
accurately.

## MEDIUMs deferred to v2 backlog

- **Opus M-3:** Effort estimate (5.2 = 1-2 weeks) assumes
  Tier D2 closure. Should be tracked.
- **Opus M-4:** ql-collab module-level LOC breakdown not
  specified. Phase 5.2 will produce a more detailed
  pre-implementation plan.
- **Opus L-1:** ShallowSnapshot policy guard — add Phase 5.2
  acceptance criterion test exercising 1M-op log.
- **Opus L-2:** Presence container persistence — clarify
  whether `.qbook/oplog.bin` saves the `"presence"` LoroMap;
  if no, add export-filter logic.

These are tracked in the updated `docs/PHASE-4-V2-BACKLOG.md`
as Phase 5 prep items.

## OK confirmations

- **Codex V2:** `Op::BatchCommit` is one LoroList entry; can't
  be interleaved by concurrent peer ops. Atomicity holds.
- **Opus OK-1 to OK-4:** Cycle detection invariant, format-
  registration idempotence, BatchCommit nesting via recursion,
  Phase 4 invariant preservation under Option A — all
  verified.

## Audit-discipline meta-note

The 2-way pattern (Codex + Opus) was load-bearing here. Each
auditor caught issues the other missed:

- Opus would have shipped the design with the wrong Loro merge
  semantic claim (which Codex caught by reading the actual
  Loro source).
- Codex would have shipped without the AddSheet UX critique
  (Opus's H-3, framed in terms of Google Sheets user
  expectations rather than code correctness).
- Both independently caught the format-id and rename-sheet
  bugs.

Codex's first attempt (broad-CRDT-survey prompt) ran out of
context window doing web research. The retry with 5 tight
verification tasks completed cleanly and produced the
deepest technical findings of any audit so far. Lesson for
future design audits: keep web-research-heavy alternative-tool
surveys to a separate context if at all possible.

## Closures landing in this commit

1. Design doc (`docs/architecture/crdt-data-model.md`):
   - Loro merge semantic claim corrected (Fugue/origin, not
     LWW Lamport).
   - Spill mechanism description corrected (defers to
     recompute_all post-replay).
   - 4 post-audit decisions added (D-1 format-id, D-2 add-
     sheet rename, D-3 rename-sheet known limitation, D-4
     spill semantics).
   - 5 pre-audit open questions resolved or formally
     deferred.
   - Status: AUDIT-CLOSED.
2. Audit transcripts:
   - `docs/audits/2026-05-19-phase-5-1-codex.md` (11k lines
     including Codex's full exploration trace).
   - `docs/audits/2026-05-19-phase-5-1-opus.md` (concise OK
     + finding list).
   - `docs/audits/2026-05-19-phase-5-1-consolidated.md`
     (THIS DOC).

## Next: Phase 5.2 unblocked

The design's gating audit checkpoint is now closed. Phase 5.2
(ql-collab core documents) can start. Pre-5.2 prerequisites:

1. Tier D2 (ql-oplog → ql-io dependency cleanup) must close
   first — flagged in Opus M-3.
2. The 4 audit-locked design decisions (D-1 through D-4) must
   be reflected in 5.2's wire-format + acceptance criteria.
3. Probe tests for spill-invariant + ShallowSnapshot must be
   in 5.2's test plan before any production wire goes out.
