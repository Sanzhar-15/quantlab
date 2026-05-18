# Phase 4.12 megaudit — self (exit packet + audit-trail)

**Date:** 2026-05-18
**Auditor:** This conversation's primary agent (Opus 4.7).
**Phase scope:** All of Phase 4 (sub-phases 4.1 → 4.11 + this 4.12
overall pass).
**Method:** Audit-doc inventory + acceptance criteria verification +
exit-packet authorship + cross-reference with master plan.

## HIGH findings

### H-1: Phase 4 entry plan never written

- File: `docs/phase4/entry-plan.md` does NOT exist.
- What's wrong: master plan Phase 4 says one of the Documentation
  Deliverables is `docs/phase4/entry-plan.md`. Phases 0, 1, 2 each
  have an `entry-plan.md` companion to their `exit-packet.md`.
  Phase 3 also lacks one.
- Why it matters: not blocking ship, but the master plan acceptance
  is partial. Future contributors lose the "what we set out to
  achieve" record.
- Severity: HIGH for paperwork; cosmetic for runtime correctness.
  Document as v2-deferred (writing it retroactively from memory is
  worse than not writing at all).

### H-2: `docs/architecture/parser-and-semantics.md` does NOT exist as a single doc

- File: master plan deliverable.
- What's wrong: master plan Phase 4 deliverable
  `docs/architecture/parser-and-semantics.md` is missing. Content
  is split across:
  - `docs/architecture/2026-05-13-format-string-grammar.md`
  - `docs/architecture/2026-05-13-cross-sheet-references.md`
  - `docs/architecture/2026-05-13-dates-times-formats.md`
  - `docs/architecture/2026-05-13-coercion-matrix.md`
  - `docs/architecture/2026-05-14-array-formulas-and-spills.md`
  - `docs/architecture/2026-05-14-structured-references-and-tables.md`
  - `docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md`
  - `docs/architecture/2026-05-17-reference-tier-design.md`
  - `docs/architecture/calcgraph-runtime.md`
- Why it matters: a future contributor looking for "the parser doc"
  finds 9 separate documents and has to figure out which is current.
- Suggested fix: write a thin `docs/architecture/parser-and-semantics.md`
  that's an INDEX pointing at the 9 docs above with a one-line
  summary of each. ~50 lines, half an hour. Closes the deliverable
  without rewriting content.

## MEDIUM findings

### M-1: Phase 3 also lacked an exit packet — pattern of dropped paperwork at phase boundaries

- File: `docs/phase3/` does NOT exist.
- What's wrong: Phase 3 closure was documented via
  `docs/audits/2026-05-12-phase-3-megaudit.md` (a single audit doc)
  rather than a proper exit packet. Phase 4 was about to repeat the
  pattern.
- Suggested fix: this self-audit doc + the new
  `docs/phase4/exit-packet.md` close the Phase 4 paperwork. Phase 3
  retroactive packet would be best-effort but low-priority.

### M-2: Cycle discipline — 10+ cycles this session

- File: process — `~/.claude/CLAUDE.md` rule.
- What's wrong: CLAUDE.md says ≤2 plan-implement-audit cycles per
  session. This session executed 10+. User explicitly authorized
  ("I pushed you to reach completeness"); not a discipline
  violation in spirit, but the audit-trail should note it for
  retrospectives.
- Suggested fix: note in the exit packet that Phase 4.11 + 4.12
  pushed through normal cycle budget by user direction.

### M-3: Compat matrix coverage at 82% — 18% gap

- File: `docs/compat/excel-matrix.md`.
- What's wrong: 53 ❌ (missing) + 40 ⚠️ (partial) entries. The
  master plan A4-02 says "complete enough to guide users" which is
  subjective. At 82% we PROBABLY clear that bar but a user looking
  for IRR_HCALC or some specific fn might miss it.
- Suggested fix: document Phase 4 coverage explicitly in the exit
  packet (done). Forward work: track the gap as part of Phase 5
  or post-MVP polish.

### M-4: Audit-doc taxonomy is inconsistent

- File: `docs/audits/` (127 docs).
- Filename patterns vary:
  - `2026-05-12-megaudit.md`
  - `2026-05-13-phase-4.4-megaudit-codex.txt`
  - `2026-05-18-w5-d-15-codex.md`
  - `2026-05-17-w5183-vdb-codex.md`
  - `2026-05-18-phase-4-11-megaudit-self.md`
- Suggested fix: post-Phase 4, standardize on
  `YYYY-MM-DD-<phase>-<sub-batch>-<auditor>.<ext>` for new docs.
  Not retroactive.

## LOW findings

### L-1: Test count multiplier visualization

- `docs/phase4/exit-packet.md` includes a test-count growth table
  but doesn't visualize the trajectory. A CSV or chart would help
  for retrospectives. Future work.

### L-2: Legal / provenance notes

- Master plan mentions "Updated legal / provenance notes" as a
  deliverable. Per-source NOTICE files exist in `.references/` but
  no top-level summary at e.g. `docs/legal/`.

### L-3: Phase 4.10 audit doc says "260 registered fns" but compat matrix has 311 rows

- The discrepancy is expected: matrix rows include non-implemented
  (❌) and reserved (🔄) functions. Per-row coverage check matches.
  Just worth a note.

## What looked right

- All 4 Phase 4.12 acceptance criteria empirically met before this
  audit even ran. The acceptance bar was met by accumulated
  per-sub-phase work, not by Phase 4.12 closure activities.
- 127 audit docs span all Phase 4 sub-phases including pre-discipline
  early work (4.4, 4.5, 4.6). Per-sub-phase audit hygiene is
  consistently strong.
- Phase 4.11 megaudit (5-way parallel) caught and closed 17 HIGHs
  invisible at per-batch level — a strong proof point that the
  megaudit pattern works.
- Exit-packet structure mirrors Phase 0/1/2 packets; readable for
  retrospective reviewers.
- Cycle discipline note (M-2) is the only paperwork debt;
  everything else (entry plan, parser doc) is master-plan-listed
  but never blocking actual code work.

## Risk-stack assessment

Items most likely to surface in Phase 5+:

1. **`.qbook` persistence format versioning** (carried from Phase
   4.11 megaudit Opus-C concerns) — Phase 5 CRDT integration may
   force schema changes; need version + migration story.
2. **Public API stability commitments** — what 0.1.x → 0.2.0 breaks?
3. **Post-process XML-mutation layer** in `ql-io-xlsx` (Phase 4.11
   Opus-C HIGH-1) — v2 UpdateOriginal work blocks on it.
4. **Compat matrix gaps** — IDE users will surface specific missing
   functions; need a triage process.
5. **Float-precision drift** — Phase 4.12 Codex audit will quantify.

## Final note

This self-audit was performed in PARALLEL with the 4 other Phase
4.12 megaudit auditors (Codex / Opus-A / Opus-B / Opus-C). Findings
will be consolidated at
`docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` after
all auditors complete. The exit-packet at
`docs/phase4/exit-packet.md` is currently DRAFT pending the
consolidated findings.
