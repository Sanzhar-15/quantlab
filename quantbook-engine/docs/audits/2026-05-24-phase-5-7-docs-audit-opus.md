# Opus Lane B docs audit -- Phase 5.7 V3.6 documentation

**Auditor:** Opus 4.7 (Claude Code Agent, 1M context)
**Date:** 2026-05-24
**Scope:** documentation surfaces touched by the 8-cycle V3.6 session
  (V3.6.0.X audit-of-D2 + closures + V3.6.0.4 D3 + V3.6.0.X audit-of-D3 + closures
  + V3.6.0.5 D4 + V3.6.0.X audit-of-D4 + closures)
**Adversarial discipline:** the user asked "is everything optimal and complete?" --
  bar is "ready for a fresh engineer onboarding without confusion", NOT
  "did anything regress?"
**Ground-truth verification:** every test count / HEAD commit / cross-reference
  was reproduced against source before being scored.

## § A Summary + Verdict

**Verdict: PASS-WITH-FINDINGS.**

The substantive engineering documentation (engine source docstrings, audit
transcript content, master plan V3.6 detail paragraph, ide-consumer-contract.md
risk register closures) is correct, traceable, and reflects the V3.6.0.X
audit-of-D4 ship at engine `e7931a74d0d` + IDE `b76b8266beb`. Every D-decision
status flag (D1-D5 SHIPPED, D6-D9 conditional/deferred) is consistent across
plan body, master plan, and consumer contract. All 9 cited commit hashes
exist in git and the predecessor chain traces correctly. The 7 V3.6 audit
transcripts (V3.6.0.2 Codex + V3.6.0.3 Codex+Opus + V3.6.0.4 Codex+Opus +
V3.6.0.5 Codex+Opus) all exist; the missing V3.6.0.2 Opus side-by-side file
is explicitly documented as "inline in commit" at plan body line 273.
Engine source docstrings on the 8 new CollabSession fields, CacheBuckets,
apply_cache_effect, Op::SetDateSystem, and DateSystemWire are all present.

**However**, the session's 8-cycle bloat (6 over CLAUDE.md ≤2 guideline) has
left specific drift in the handoff surfaces -- specifically the in-memory
handoff files (`MEMORY.md`, `current_work.md`) and a small number of stale
"deferred to V3.6.0.5 D4" markers inside the consumer contract. The
**single most critical onboarding-blocking issue** is `current_work.md`'s
status table at lines 21-23 displaying HEAD commits, ql-collab test counts,
and ql-collab-ws test counts THREE COMMITS BEHIND actual state. A fresh
engineer following the file's prescribed "first three commands" would see
a `git log` that contradicts the file's own table and reasonably conclude
their checkout is broken. There are no source code bugs; this is purely
documentation drift.

**Counts**: 3 HIGH (all in handoff surfaces), 5 MEDIUM (drift in contract +
plan body), 4 LOW (cosmetic / archive hygiene), 4 INFO. The HIGH bar here
matches the user's stated bar -- "worthy of a fresh engineer onboarding"
-- not "engineering bug". For engineering-bug bar, the verdict would be
PASS.

## § B HIGH findings

### B.1 -- `current_work.md` status table is THREE commits stale

**Scope:** `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` lines 21-23.

**Description:**

The fresh-engineer's prescribed READ FIRST file shows:

| Row | Field | File claim | Ground truth |
|---|---|---|---|
| L21 Engine | HEAD | `5b3017c70d2` (V3.6.0.5 D4) | `e7931a74d0d` (V3.6.0.X audit-of-D4) |
| L21 Engine | ql-collab | `134/134` | **136/136** |
| L21 Engine | ql-collab-ws | `40/40` | **42/42** |
| L22 IDE | HEAD | `d7cb01557d4` (V3.6.0.5 D4 IDE) | `b76b8266beb` (V3.6.0.X audit-of-D4 IDE) |
| L23 IDE | (duplicate row) | `21fe6a73ec6` (V3.6.0.X audit-of-D2 typedoc sweep) | should not be present |

Line 23 is a leftover SECOND IDE row (from a prior session's snapshot
that was never collapsed) showing an even-older HEAD. The table is also
*structurally* wrong: line 22 + 23 both claim "| IDE | ... | feat/visualise-v1 |"
giving two competing IDE entries that contradict each other.

**Why HIGH:** the file's own § "First three commands (next session)" at line 133
says "POST-V3.6.0.5-D4-SHIPPED" and the first `git log` command at line 150
would surface the ACTUAL HEAD `e7931a74d0d` (audit-of-D4) -- contradicting
the table 30 lines above. A fresh engineer would reasonably ask "did I check
out the wrong commit?" and waste 10-30 minutes reconciling.

**Compounded by:** the description front-matter (line 3) embeds the FULL
V3.6.0.5 D4 narrative as "current state" with cycle budget = 6, but the
session ended at cycle budget = 8 (audit-of-D4 added 2 more cycles). The
description's "Predecessor:" chain stops at V3.6.0.X audit-of-D3, but
audit-of-D4 has shipped on top.

**ql-collab-ws "40/40" claim is FLAT WRONG:** my fresh run of
`cargo test -p ql-collab-ws` reports 10 (lib) + 2 (relay) + 30 (transport) =
**42 passing**, matching the plan body's `current_ql_collab_ws_tests: 42/42`
line. The "40" number in `current_work.md` + MASTER-PLAN.md final line
appears to be a transcription error that propagated across multiple sessions.

**Suggested closure:**

1. Replace L21-23 with a single Engine row + single IDE row reflecting
   `e7931a74d0d` + `b76b8266beb` + 136/354/42.
2. Update front-matter description to reflect cycle 8 final state
   (audit-of-D4 closures shipped at engine `e7931a74d0d` + IDE `b76b8266beb`;
   3 HIGH + 3 MED closed in-cycle for the FAIL-verdict V3.6.0.5 D4 audit).
3. Update the "First three commands" instructions to point at the actual
   HEAD with the actual expected test counts.
4. Header line 8 ("Current work -- handoff for next session (2026-05-23,
   V3.4.0.1 decision lock shipped)") is STALE BY 2 PHASES -- should be
   "2026-05-24, V3.6.0.X audit-of-D4 closures shipped".

### B.2 -- MEMORY.md current_work pointer is the worst kind of accreted-history sprawl

**Scope:** `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/MEMORY.md` line 2.

**Description:**

Line 2 (the "READ FIRST" current-work pointer) is **a single 30,000+
character paragraph** that re-narrates V3.5 + V3.6.0.1 + V3.6.0.2 +
V3.6.0.X audit-closure + V3.6.0.3 + V3.6.0.X audit-of-D2 + V3.6.0.4 +
V3.6.0.X audit-of-D3 + V3.6.0.5 + V3.6.0.X audit-of-D4 in chronological
order with full closure-detail.

Within the same paragraph the test count claim drifts:
- "Tests: ql-collab **136/136** + IDE mocha **354/354** + ql-collab-ws 40/40"
  (top, current state)
- "Tests: ql-collab **134/134** + IDE mocha **354/354** + ql-collab-ws 40/40"
  (middle, V3.6.0.5 D4 snapshot)
- "ql-collab-ws 42/42 unchanged" (later, V3.5.0.X snapshot)

The same paragraph cites ql-collab-ws as BOTH 40 AND 42 in different places.
This is impossible -- it's two different snapshots concatenated without
reconciliation. A fresh engineer searching for "ql-collab-ws test count"
will hit whichever they grep first.

The line also re-cites every commit hash in the predecessor chain
(`5b3017c70d2`, `f6ef41ad732`, `84cb5c9d169`, `119df9b3826`,
`08964962cf8`, `89f5a5f9e0b`, `4fd816ded43`, ...) twice -- once in
"Old V3.5 chain ←" and again in "at engine 5b3017c70d2 (...)" inline
narrative. The structural overlap is impossible to follow on a fresh read.

**Why HIGH:** MEMORY.md is the user's per-project memory file the harness
auto-injects at session start. If the FIRST entry in that file is unreadable,
the entire memory benefit is lost.

**Compounded by:** the MEMORY.md `[Quantbook master plan pointer]` line 1
correctly summarizes the two-plan structure, demonstrating that concise
pointer-style entries are achievable. The current_work pointer fails the
same standard.

**Suggested closure:** rewrite line 2 to a 3-5-sentence pointer at the
current state (V3.6.0.X audit-of-D4 SHIPPED at engine `e7931a74d0d` + IDE
`b76b8266beb`; tests 136/354/42; next sub-step V3.6.0.6 D5 IDE
appendPutFormula napi; see `current_work.md` for handoff narrative; see
`.plans/_active.md` for V3.6 plan body). Move the full history into
`current_work.md` (which is the proper home for narrative) and let
MEMORY.md be a pointer.

### B.3 -- ide-consumer-contract.md missing § 4.1.z6 V3.6 surface spec

**Scope:** `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/ide-consumer-contract.md` end of file (after § 4.1.z5).

**Description:**

The plan body line 28 explicitly says:

> "Sister-section to `docs/architecture/ide-consumer-contract.md § 4.1.z6`
> (V3.6.0.X docs will land it; mirrors V3.5.0.9 § 4.1.z5 template)."

Searching the file for "z6" returns **zero matches** as a section header.
The file embeds V3.6 surface details in OTHER places:
- Inline in § 4.1.z5 V3.5 (D1/D2 deferral note line 1312)
- Inline in § "Drift hazards (V3.6+ maintainers)" line 1527
- Inline in `R-V3.5-2 / R-V3.5-4 / R-V3.5-5 CLOSED` markers lines 1540-1543

The V3.6.0.3 docs sweep commit `0c3cbef8cea` explicitly deferred § 4.1.z6
to "V3.6.0.5 D4 ship OR V3.6 phase termination". V3.6.0.5 D4 HAS shipped;
V3.6.0.X audit-of-D4 HAS shipped on top with non-trivial new surface
(`Op::SetDateSystem` + `DateSystemWire` enum + IDE `data-raw-value` attribute).
The § 4.1.z6 sister-section is therefore overdue.

The current inline-everywhere approach has a real cost: a fresh engineer
asking "what does the V3.6 napi surface look like?" must read § 4.1.z5
(V3.5 spec) PLUS the drift hazards section PLUS the risk register closures
to reconstruct the V3.6 surface. There's no single section to point them at.

**Why HIGH (not MEDIUM):** the file is the user-facing consumer contract.
If the contract doesn't have a V3.6 section, IDE consumers literally have
no spec to read for the new fields (`rendered`, `dateSystem`, `formats`,
the `data-raw-value` IDE attribute). The plan body PROMISES a § 4.1.z6
that doesn't exist.

**Acceptable alternative:** explicitly defer § 4.1.z6 to V3.6 phase
termination and ANNOTATE that deferral in the plan body line 28 (currently
phrased as if it should already exist). My recommendation is to ship
§ 4.1.z6 now since V3.6.0.5 D4 is the last user-visible D-decision
expected to land at IDE-shape level (D5 is a thin napi wrapper without
new structs; D6-D9 are conditional / deferred).

**Suggested closure:** ship § 4.1.z6 in a V3.6.0.X docs-only commit
(mirrors V3.5.0.9 pattern that landed § 4.1.z5). Required content per
the V3.5.0.9 template:
- napi shape additions (`CellSnapshotJson.rendered?`, `WorkbookSnapshotJson.dateSystem`, `WorkbookSnapshotJson.formats[]`, `FormatDefJson`)
- new wire variant (`Op::SetDateSystem` + `DateSystemWire` enum + replay handler)
- new IDE-side attribute (`data-raw-value`) + `beginEdit` read-order
- new CollabSession fields (8 caches now)
- 13 risks (R-V3.6-1..13)
- live smoke procedure addendum
- V3.5→V3.6 surface diff section

OR explicitly defer with a "§ 4.1.z6 deferred to V3.6 phase termination
(post-V3.6.0.10 conditional ship + V3.6.0.X parallel megaudit)" note in
plan body line 28 + a stub `## § 4.1.z6 (deferred to V3.6 phase termination)`
heading in the contract so search-by-anchor finds it.

## § C MEDIUM findings

### C.1 -- ide-consumer-contract.md R-V3.5-5 closure narrative stale ("deferred to V3.6.0.5 D4")

**Scope:** ide-consumer-contract.md line 1543.

**Description:**

Line 1543 (R-V3.5-5 closure):

> "**R-V3.5-5 Session-wide format registry deferral** -- CLOSED at V3.6.0.3 D2 ...
> Format-aware buildHtml rendering **still deferred to V3.6.0.5 D4**."

The "still deferred to V3.6.0.5 D4" tail is STALE -- V3.6.0.5 D4 has shipped
(engine `5b3017c70d2` + IDE `d7cb01557d4`) AND its audit-of-D4 closures
(engine `e7931a74d0d` + IDE `b76b8266beb`). The deferral is no longer accurate.

The same passage at R-V3.5-4 (line 1542) correctly says CLOSED at V3.6.0.5 D4.
The cross-reference inconsistency suggests the V3.6.0.X audit-of-D2 docs
sweep updated R-V3.5-4 but missed updating R-V3.5-5's deferral marker.

**Suggested closure:** replace "still deferred to V3.6.0.5 D4" with "now
SHIPPED at V3.6.0.5 D4 (engine `5b3017c70d2` + IDE `d7cb01557d4`); see
R-V3.5-4 for full closure narrative". Sweep is 1 line edit.

### C.2 -- ide-consumer-contract.md line 1744 R-V3.5-2 narrative refers to removed field

**Scope:** ide-consumer-contract.md line 1744.

**Description:**

Line 1744 (R-V3.5-* reclassifications):

> "R-V3.5-2 (partial-invalidate undo correctness under causal reorder) was
> the conceptual basis for the convergent-HIGH closure and is now
> **operationalized via the `pure_local_frontier` gate** + regression test."

The `pure_local_frontier: bool` field was REMOVED in V3.6.0.2 D1 (engine
`89f5a5f9e0b`) per the plan body line 91 + line 272. The "operationalized
via the pure_local_frontier gate" narrative is correct in HISTORICAL
context (V3.5.0.X timestamp) but misleading at current-HEAD reading.

Line 1742 in the same section lists `CollabSession.pure_local_frontier:
bool (Copy+Send+Sync trivially)` in the V3.5.0.X "new types" enumeration.
This historical narrative is also locally accurate (V3.5.0.X did add the
field) but the file lacks a forward-pointer noting the V3.6.0.2 removal.

Line 1723 (A-HIGH-1 + Opus-H2 closure narrative) explicitly describes the
`pure_local_frontier` field and its gate logic in present tense.

**Why MEDIUM (not HIGH):** the section is correctly titled "V3.5.0.X
audit-closures (Phase 5.7 V3.5 phase-termination audit, 2026-05-24)" so
historical context is clear. The risk is a fresh engineer searching for
`pure_local_frontier` (it doesn't compile in current source) and getting
confused.

Compounded: the actual current field is `pending_undo_cells: Arc<Mutex<Option<Vec<(u16, u32, u32)>>>>`
per session.rs:757 + plan body line 272. The contract document does not
mention `pending_undo_cells` anywhere by name.

**Suggested closure:** add a forward-pointer note at line 1723 + line 1742
+ line 1744: "(V3.6.0.2 superseded this field with `pending_undo_cells:
Arc<Mutex<...>>` per § 4.1.z6 -- see plan body D1 detail)". Or do nothing
if § 4.1.z6 ships and clearly notes the supersession.

### C.3 -- MASTER-PLAN.md line "ql-collab-ws 40/40" drift (same root as B.1)

**Scope:** `quantbook-engine/docs/MASTER-PLAN.md` line 2 (long V3.6 detail
paragraph, near the end).

**Description:**

The terminal status line in the long V3.6 paragraph says:

> "Baselines tracked: ql-collab **136/136** + IDE mocha **354/354** +
> ql-collab-ws **40/40** + engine workspace all 30 suites pass."

Same drift as B.1 -- actual is 42/42 per fresh-run verification. Different
file, same wrong number. Suggests the "40" number was once correct (pre-V3.1.a
relay test addition, perhaps) and has been transcribed forward without
re-verification.

**Suggested closure:** sweep all docs mentioning "ql-collab-ws 40/40" and
update to "42/42 (10 lib + 30 transport + 2 V3.1.a relay)". Specific sites:
- `MASTER-PLAN.md` long V3.6 paragraph terminal line
- `current_work.md` line 21 ("40/40")
- `MEMORY.md` line 2 multiple occurrences
- Any V3.6.0.X audit transcript that cites the count (verify via grep)

### C.4 -- `.plans/_active.md` "Pending audits" section lists V3.6.0.X audit-of-D4 as pending despite it having shipped

**Scope:** `quantbook-engine/.plans/_active.md` lines 337-339.

**Description:**

Lines 337-339:

> "**Pending audits** (per Opus § H.5 recommended sequencing):
> - V3.6.0.X audit of D4 (V3.6.0.5 ship): format_value semantics + date_system propagation + locale defaults.
> - V3.6.0.X audit of D5 (V3.6.0.6 ship): IDE PutFormula end-to-end + repaired-formula integration.
> - V3.6.0.X phase termination audit at V3.6.0.10 ship (parallel Codex+Opus; broad scope)."

The first bullet is STALE -- V3.6.0.X audit of D4 SHIPPED at engine
`e7931a74d0d` + IDE `b76b8266beb` and the closures are already listed in
the "Shipped audits" section above (lines 332-335 -- last bullet for
V3.6.0.5 D4).

The frontmatter `status:` line correctly reflects the audit-of-D4 ship,
and the "Shipped audits" section at line 335 correctly lists it. The
"Pending audits" section just wasn't swept.

**Suggested closure:** remove the first bullet from "Pending audits"; the
remaining 2 (V3.6.0.X audit of D5 + phase-termination audit) are accurate.

### C.5 -- Plan body frontmatter `status:` line is multi-paragraph prose (not a status)

**Scope:** `quantbook-engine/.plans/_active.md` line 3.

**Description:**

Line 3 (the frontmatter `status:` field) is **a 12,000+ character single-line
paragraph** containing the entire V3.6 ship narrative from V3.6.0.1 lock
through V3.6.0.X audit-of-D4 closures, including test counts, closure
details, Rule 4 walks, cycle budget notes, deferrals, and convergent finding
descriptions.

YAML frontmatter `status:` is conventionally a short tag: `in-progress`,
`done`, `blocked`, etc. The plan files in `.plans/_archive/` (per memory
references) use the short-tag convention. The current state is a mini-version
of the entire plan body inside the frontmatter.

**Why MEDIUM:** doesn't break anything mechanically (YAML parses); makes
frontmatter unusable for any tooling that expects short-tag status. The
narrative content is also DUPLICATED in the plan body itself (in the
"Predecessor closure" + "V3.6 sub-step rollout" sections) -- single source
of truth violated.

**Suggested closure:** truncate `status:` to a short tag (e.g.,
`in-progress (V3.6.0.X audit-of-D4 closures shipped; V3.6.0.6 D5 next)`).
Move the narrative into a new `## V3.6 ship narrative` section near the
top of the body OR delete it since the per-sub-step bullets at lines
271-296 already cover the same ground.

## § D LOW findings

### D.1 -- 7 V3.6 audit transcripts; date inconsistency across sessions

**Scope:** `docs/audits/2026-05-2{3,4}-phase-5-7-v3-6-0-*.md`.

**Description:**

V3.6.0.2 (Codex only) + V3.6.0.5 (Codex+Opus) dated **2026-05-24**.
V3.6.0.3 + V3.6.0.4 (both Codex+Opus pairs) dated **2026-05-23**.

The session arc shipped:
- V3.6.0.1 lock: engine `4fd816ded43` (commit date in current_engine_head trail)
- V3.6.0.2 D1: engine `89f5a5f9e0b` (with audit-closure at `08964962cf8` cited as 2026-05-24 in plan)
- V3.6.0.3 D2: engine `ffa598a1c15` (2026-05-23 per audit transcripts)
- V3.6.0.X audit-of-D2: engine `8480f247aea` (2026-05-23)
- V3.6.0.4 D3: engine `119df9b3826` (2026-05-23)
- V3.6.0.X audit-of-D3: engine `f6ef41ad732` (2026-05-23)
- V3.6.0.5 D4: engine `5b3017c70d2` (2026-05-24)
- V3.6.0.X audit-of-D4: engine `e7931a74d0d` (2026-05-24)

The transcript dates appear to reflect SESSION DATE not necessarily
COMMIT DATE -- this is consistent if V3.6.0.3 + V3.6.0.4 + their audits
were all in a single 2026-05-23 session, and V3.6.0.2 + V3.6.0.5 + their
audits in a 2026-05-24 session. The session ledger in `current_work.md`
doesn't explicitly distinguish, so this is presumed consistent. The user
task description called out the date inconsistency as something to flag.

**Why LOW:** doesn't impact correctness; just slightly confusing for an
engineer scanning the audit directory chronologically. The transcripts'
internal content correctly cites their own audit-target commit so
traceability is preserved.

**Suggested closure:** none; convention is "transcript date = session date"
which is sensible. Optionally add a brief note in plan body explaining the
convention.

### D.2 -- MASTER-PLAN.md V3.6 status header marker says SHIPPED but headline still uses 🚧 emoji

**Scope:** `quantbook-engine/docs/MASTER-PLAN.md` line 547.

**Description:**

Line 547 opens with:

> "🚧 **5.7 V3.6 (Loro UndoManager on_push + format registry + format-aware
> rendering + per-cell op-index + IDE PutFormula; V3.6.0.1 LOCK + V3.6.0.2
> D1 + V3.6.0.X AUDIT-CLOSURE + V3.6.0.3 D2 + V3.6.0.X AUDIT-OF-D2 + V3.6.0.4
> D3 + V3.6.0.X AUDIT-OF-D3 + V3.6.0.5 D4 + V3.6.0.X AUDIT-OF-D4 SHIPPED
> 2026-05-23/24)**"

The 🚧 emoji conventionally means "in progress / under construction" but the
content explicitly says "SHIPPED" for D1 through D4 + audit-of-D4. V3.6 is
correctly STILL in progress (D5 D6 D9 D10 + phase-termination audit pending)
so the emoji isn't wrong, but reading "🚧 ... SHIPPED" creates cognitive
friction. The V3.5 line above uses ✅ for the fully-complete phase, which
is the correct contrast.

**Why LOW:** prose is technically accurate; emoji is mild stylistic noise.

**Suggested closure:** change 🚧 to a mixed-state marker like
"🚧/✅ V3.6 (D1-D4 SHIPPED; D5-D9 pending)" OR leave as 🚧 since V3.6 is
indeed in-progress overall.

### D.3 -- `current_work.md` recent-ship-sequence table stops at V3.3.0.X

**Scope:** `current_work.md` lines 55-73 (recent ship sequence table).

**Description:**

The "Recent ship sequence" table lists commits from V3.3.0 only. It is
**3 phases stale** (V3.4, V3.5, V3.6.0.X audit-of-D4 all missed).

For a fresh engineer the table reads as if V3.3.0.X is the most recent
work, which contradicts the front-matter description that correctly says
V3.6.0.X audit-of-D4 SHIPPED.

**Why LOW (not HIGH):** the front-matter description IS up-to-date (modulo
B.2 issues). A fresh engineer reading top-to-bottom will see the
description before the table. But the table's existence with stale data
is still misleading.

**Suggested closure:** extend the table with V3.4 + V3.5 + V3.6 ship rows,
OR delete the table since the description already narrates the ship sequence.

### D.4 -- Plan body has 356 lines; "Shipped audits" section unwieldy

**Scope:** `quantbook-engine/.plans/_active.md` lines 331-336 (Shipped
audits enumeration).

**Description:**

The "Shipped audits" section now lists 4 audit cycles in serial bullets,
each with 200-700 character closure summaries. The bullets duplicate
content that's also in the per-sub-step rollout section above and the
master plan V3.6 paragraph below. The plan body has grown to 356 lines
and risks becoming unreadable.

The user task description explicitly raises this concern (item F.20).

**Why LOW:** the duplication is annotation-richness, not contradiction.
A skimmer can grep for specific closure summaries and find them in one
of three places. But re-reading from top is increasingly painful.

**Suggested closure:** condense "Shipped audits" bullets to one-line
references (e.g., "V3.6.0.X audit-of-D4 (engine `e7931a74d0d` + IDE
`b76b8266beb`): 3 HIGH + 3 MED closed; see `docs/audits/2026-05-24-phase-5-7-v3-6-0-5-{codex,opus}.md`")
and link out to the transcripts for detail. Saves ~150 lines.

## § E INFO findings

### E.1 -- Cycle count consistency: 8 cycles correctly recorded in plan body + audit-of-D4 commit message

The session ran 8 plan-implement-audit cycles per the audit-of-D4 commit
message ("this session counted **8 plan-implement-audit cycles**"). The
plan body status line correctly states the same. Earlier docs (V3.6.0.3
D2 sweep) said 4 cycles, then V3.6.0.4 D3 said 5, then V3.6.0.X audit-of-D3
said 5, V3.6.0.5 D4 said 6, V3.6.0.X audit-of-D4 said 8 -- the monotonic
progression is correct.

`current_work.md` line 3 description still says "Cycle budget: **6 cycles
this session**" which is the V3.6.0.5 D4 snapshot, not the final 8. This
is part of B.1 / B.2 staleness.

### E.2 -- Engine source docstrings on the 8 CollabSession cache fields are present

Verified via grep:

| Field | session.rs line |
|---|---|
| `last_snapshot` | 676 |
| `removed_sheets` | 713 |
| `pending_undo_cells` | 757 |
| `inside_group` | 781 |
| `undo_merge_interval_ms` | 802 |
| `format_table_cache` | 854 |
| `cell_op_index` | 898 |
| `sheet_op_index` | 927 |

All 8 fields present + each has a doc comment in the immediate preceding
lines (per docstring pass at V3.6.0.3 D2 + V3.6.0.X audit-of-D3 sweeps).
The CacheBuckets struct at line 258 is also present with doc comment.
`Op::SetDateSystem` variant at op.rs:430 + `DateSystemWire` enum at
op.rs:572 both present with doc comments. IDE `data-raw-value` attribute
at `cellGridHtml.ts:268` present with surrounding comment.

### E.3 -- All cited commit hashes resolve

9 engine + 4 IDE commits cited in plan body / contract / current_work all
resolve via `git cat-file -e`:
- Engine: `4fd816ded43`, `89f5a5f9e0b`, `08964962cf8`, `ffa598a1c15`,
  `8480f247aea`, `119df9b3826`, `f6ef41ad732`, `5b3017c70d2`, `e7931a74d0d` -- all exist.
- IDE: `b159c899359`, `21fe6a73ec6`, `d7cb01557d4`, `b76b8266beb` -- all exist.

### E.4 -- 13 R-V3.6-* risks fully documented in plan body

Plan body lines 302-314 enumerate R-V3.6-1 through R-V3.6-13. R-V3.6-10
(positional-index fragility, discovered V3.6.0.4) + R-V3.6-11/12/13
(discovered V3.6.0.X audit-of-D4) are all newly documented with discovery
context + mitigation. The contract doc (ide-consumer-contract.md) does
NOT independently list R-V3.6-* risks (only references R-V3.6-10 inline
on line 1532) -- this is per the V3.6.0.3 docs sweep's deferral of § 4.1.z6
where the V3.6 risk register would naturally land. Once § 4.1.z6 ships
(per B.3) the contract should mirror the plan body's R-V3.6-1..13 register.

## § F Cross-reference integrity

**Commit hashes**: 13/13 verified existent (E.3).

**Audit transcript paths cited in plan**: 7/7 verified existent.
- `docs/audits/2026-05-24-phase-5-7-v3-6-0-2-codex.md` ✓
- `docs/audits/2026-05-23-phase-5-7-v3-6-0-3-codex.md` ✓
- `docs/audits/2026-05-23-phase-5-7-v3-6-0-3-opus.md` ✓
- `docs/audits/2026-05-23-phase-5-7-v3-6-0-4-codex.md` ✓
- `docs/audits/2026-05-23-phase-5-7-v3-6-0-4-opus.md` ✓
- `docs/audits/2026-05-24-phase-5-7-v3-6-0-5-codex.md` ✓
- `docs/audits/2026-05-24-phase-5-7-v3-6-0-5-opus.md` ✓

V3.6.0.2 Opus side-by-side file intentionally absent ("Opus Lane B inline
audit" per plan body line 273 + master plan line 547); the asymmetry is
documented.

**Plan-to-contract sister-section pointer**: plan body line 28 promises
"sister-section to `docs/architecture/ide-consumer-contract.md § 4.1.z6`"
but that section does not exist (B.3 finding).

**Contract-to-plan pointers**: contract line 1542 says "post V3.6.0.X
audit-of-D4 OPUS-HIGH-2 closure" without explicit pointer to plan body
R-V3.6-12. Adequate but could be tighter.

**Test count cross-references**: plan body claims `ql-collab 136/136 +
IDE mocha 354/354 + ql-collab-ws 42/42`. Master plan claims `136/354/40/40`.
Current_work claims `134/354/40/40`. MEMORY.md mixes 136 + 40 + 42.
**Cross-doc inconsistency** -- B.1/B.2/C.3 findings.

**Predecessor chain in plan body**: trace from `e7931a74d0d` ←
`5b3017c70d2` ← `f6ef41ad732` ← `84cb5c9d169` ← `119df9b3826` ← `9d6bae96100`
← `8480f247aea` ← `0c3cbef8cea` ← `ffa598a1c15` ← `08964962cf8` ← `89f5a5f9e0b`
← `4fd816ded43`. Verified via `git log --oneline` in chronological match.

## § G Onboarding-fresh-engineer perspective

**Scenario:** new engineer opens the session, harness loads MEMORY.md +
current_work.md, then they explore the engine + IDE worktrees.

### G.1 -- What state is the project in?

**Possible answers** depending on which file they read:
- MEMORY.md line 2 (first thing in memory): "V3.5 + V3.6.0.1..V3.6.0.5 D4
  + V3.6.0.X audit-of-D4 SHIPPED at engine `e7931a74d0d`..." -- CORRECT
  but buried in 30K-char paragraph.
- current_work.md front-matter description: "V3.6.0.5 D4 SHIPPED..." -- one
  cycle stale (audit-of-D4 missed in description).
- current_work.md status table L21: HEAD `5b3017c70d2` -- THREE commits
  stale.
- current_work.md heading: "V3.4.0.1 decision lock shipped" -- TWO PHASES
  stale.
- `.plans/_active.md` frontmatter: correct (V3.6.0.X audit-of-D4 closures
  SHIPPED).
- `MASTER-PLAN.md` V3.6 paragraph: correct (cycle 8 documented).
- `ide-consumer-contract.md`: V3.6 surface details scattered across §4.1.z5
  inline notes + drift hazards + R-V3.5-* closure markers; no § 4.1.z6.

**Verdict**: 4 of 7 sources give the wrong or stale answer. **Not optimal**.

### G.2 -- What just shipped vs what's pending?

The plan body sub-step rollout (lines 271-296) is the BEST source. It
correctly marks D1-D4 ✅ SHIPPED and D5+ pending. The "Pending audits"
section (line 337) is one bullet stale per C.4.

**Verdict**: adequate. A fresh engineer who reads the plan body will get
the right picture.

### G.3 -- What's the next recommended sub-step + why?

Plan body line 296: "**V3.6.0.6 -- IDE-facing appendPutFormula napi (D5)**.
Thin napi wrapper + IDE typed wrapper + end-to-end repaired-formula mocha
test (closes V3.5.0.X A-HIGH-2 IDE-level verification gap). Estimated 1
session."

Master plan line 547 confirms: "**V3.6.0.6 D5 IDE-facing appendPutFormula
napi** (Opus § F.5, ~1 session) is the next recommended sub-step."

current_work.md "First three commands" section line 198: "(B) V3.6.0.6 D5
IDE-facing appendPutFormula napi ship (~1 session)" -- CORRECT.

**Verdict**: consistent and clear. The strongest cross-doc agreement.

### G.4 -- Where to find audit transcripts?

Plan body lines 332-335 (Shipped audits) + master plan line 547 inline
references give exact paths. Contract document line 1742-1796 has the
V3.5.0.X transcript paths + V3.5.0.X follow-up. All paths verify.

**Verdict**: good.

### G.5 -- Where to find the V3.6 entry-readiness packet?

Plan body line 6 (frontmatter): "opus_v3_5_packet: docs/audits/2026-05-24-phase-5-7-v3-5-0-x-opus.md § F"

current_work.md line 172 prescribes: "cat .../2026-05-24-phase-5-7-v3-5-0-x-opus.md
| sed -n '588,860p'  # § F V3.6 ENTRY READINESS packet"

**Verdict**: precise pointer with line range. Good discoverability.

### G.6 -- Can they figure out the V3.6 napi surface today?

**Problem.** With § 4.1.z6 absent (B.3), a fresh engineer must read:
- engine source `crates/ql-bindings-node/src/lib.rs` to understand the napi shape
- engine source `crates/ql-collab/src/session.rs` to understand the 8 cache fields
- IDE `extensions/quantlab/src/quantbook/types.ts` to understand the TS shape
- IDE `cellGrid/cellGridHtml.ts` for the data-raw-value attribute
- plan body D-decisions + R-V3.6 risk register
- ide-consumer-contract.md § 4.1.z5 V3.5 spec (for the foundation)
- ide-consumer-contract.md drift hazards section (for V3.6 deltas)
- ide-consumer-contract.md R-V3.5-* closure markers (for what each V3.6.0.x ships)

Eight sources to reconstruct what a single § 4.1.z6 section should contain.

**Verdict**: significant friction. This is the primary motivation for B.3.

### G.7 -- Onboarding overall assessment

**Score: 6/10.** The engineering substrate (commits, tests, source
docstrings, plan body sub-step rollout, master plan V3.6 paragraph) is in
good shape. The handoff layer (MEMORY.md + current_work.md table) is
visibly degraded by the 8-cycle bloat -- the staleness in those two files
alone could waste an engineer's first 30-60 minutes reconciling stale
HEAD commits / test counts. The absence of § 4.1.z6 is a second-order
friction point (engineers can reconstruct from source, but the contract
doc promised the section exists).

**Time-to-orient estimate at current state**: 1.5-2 hours for a careful
engineer following the file's prescribed order. Could be 30-45 min with
the B.1/B.2 closures shipped.

## § H Suggested closure scope

The user asked "is everything optimal and complete?" implying a finishing
sweep. Recommended scope:

### Close in-cycle (this session if the user directs)

1. **B.1** -- current_work.md status table refresh. **Highest priority.**
   ~15 min: replace lines 21-23 with single Engine + IDE rows at actual
   HEAD; update front-matter description to reflect cycle 8 final state;
   correct heading line 8; sweep ql-collab-ws 40 -> 42.

2. **B.2** -- MEMORY.md line 2 rewrite. ~15 min: collapse the 30K-char
   accreted paragraph to a 3-5-sentence pointer at current state.

3. **C.1** -- ide-consumer-contract.md R-V3.5-5 closure update ("still
   deferred" -> "SHIPPED"). 1-line edit.

4. **C.3** -- ql-collab-ws "40" -> "42" sweep across MASTER-PLAN.md +
   current_work.md + MEMORY.md (all referenced sites). ~5 min.

5. **C.4** -- remove stale V3.6.0.X audit-of-D4 bullet from plan body
   "Pending audits" section. 1-line delete.

Total: ~40 min in-cycle for high-value closures.

### Defer to a fresh session (cycle 9 would be excessive)

6. **B.3** -- ship § 4.1.z6 (~2-3 hours; meaningful new content; appropriate
   for a fresh session as the V3.6.0.6 D5 prerequisite OR an explicit
   V3.6.0.X docs sub-step). Could alternatively be folded into V3.6.0.6 D5
   ship since D5 surface is small enough that docs+ship can co-ship.

7. **C.2** -- pure_local_frontier forward-pointer notes in contract.
   Trivial but fold into B.3 ship.

8. **C.5** -- plan body frontmatter `status:` truncation. Fold into B.3
   ship session.

9. **D.1, D.2, D.3, D.4** -- LOW findings. Defer indefinitely; revisit at
   V3.6 phase-termination audit. None are user-facing.

### Honest tally

The substantive engineering is sound. The handoff hygiene degraded under
the 8-cycle pressure. Closing B.1+B.2+C.1+C.3+C.4 (~40 min) restores
fresh-engineer onboarding to a 7-8/10 quality. Closing B.3 in a fresh
session restores it to 9/10. The user's bar of "ready for a fresh engineer
without confusion" is reachable with the in-cycle closures alone.

**Phase-level verdict**: do not let cycle 9 happen in this session even
for the in-cycle closures -- the CLAUDE.md guideline is ≤2, current count
is 8, the user has implicitly invoked their "exception" budget repeatedly.
A fresh session can close B.1+B.2+C.1+C.3+C.4 in 40 min with full attention,
then ship V3.6.0.6 D5 + § 4.1.z6 together.

---

**End of Opus Lane B docs audit transcript.**
