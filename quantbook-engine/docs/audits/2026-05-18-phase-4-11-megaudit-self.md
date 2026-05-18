# Phase 4.11 megaudit — self (meta-audit + audit-trail integrity)

**Date:** 2026-05-18
**Auditor:** This conversation's primary agent (Opus 4.7).
**Phase scope:** 11 commits `c0a496e3627` → `f941195608b` (W5-D-14 →
W5-D-15.2).
**Method:** Re-read every commit message; cross-check against `git show`;
verify v2-deferral integrity; verify test-exercise-the-bug.

This is the SELF angle of the parallel megaudit. The other 4 auditors
(Codex schema + Opus-A round-trip + Opus-B defensive + Opus-C
architecture) run in parallel. Findings dedupe at the consolidation
step.

## HIGH findings

### H-1: Documentation drift — multiple module docs reference work as "not yet shipped" that HAS shipped

- File: `crates/ql-io-xlsx/src/write/umya_export.rs:1-15` (module doc).
- What's wrong: the module doc still says **"NOT in this commit
  (W5-D-14e follow-ups): Tables / styles / named ranges round-trip.
  `ExportMode::UpdateOriginal`. Conditional formatting / data
  validation preservation."** This was true at the W5-D-14e ship.
  After W5-D-14.2 (tables, styles, names, UpdateOriginal all shipped)
  and W5-D-15 (per-cell formats), only CF/DV preservation remains
  deferred. The doc reads as if NONE of those have landed — actively
  misleading to anyone reading the file fresh.
- Why it matters: this is the FIRST module a contributor opens to
  understand the writer's surface area. Reading it gives a wrong
  mental model. Future contributors will reinvent existing code or
  add duplicate paths.
- Suggested fix: rewrite the module doc to reflect post-W5-D-15.2
  reality. List what IS shipped + what remains deferred.

Similar staleness:
- `crates/ql-io-xlsx/src/lib.rs:171-173` ("Per-cell application ...
  is deferred to the worksheet-XML pass in a follow-up commit") — shipped
  in W5-D-15.
- `crates/ql-io-xlsx/src/read/styles_xml.rs:35-38` ("cellXfs convention
  ... per-cell application (W5-D-14 follow-up via worksheet XML
  scan) can map cell.s → cellXf → numFmtId → format code") —
  parenthetical follow-up shipped.
- `crates/ql-io-xlsx/src/write/mod.rs:8-11` ("Future: `ExportMode::
  UpdateOriginal` ... Lands as a follow-up.") — shipped.

### H-2: `UnsupportedPolicy::Strict` does NOT fire for inline-in-sheet features (CF, DV, mergeCells, hyperlinks) on UpdateOriginal export

- File: `crates/ql-io-xlsx/src/write/update_original.rs` (entire flow).
- What's wrong: a workbook imported from an xlsx containing
  `<conditionalFormatting>` or `<dataValidations>` inside its
  worksheet xml exists in the engine's `feature_inventory` (per the
  import-side scan). When the user exports via `UpdateOriginal` mode
  with `UnsupportedPolicy::Strict`, the shadow's worksheet xml
  REPLACES the original's — so CF/DV are silently dropped. But
  Strict mode never fires because:
  1. CF/DV are inline content in worksheet xml, not standalone parts.
  2. `classify_part` only sees zip-entry-level paths, never inline
     content.
  3. The `dropped` Vec only contains `PartAction::DropAsUnsupported`
     entries — no inline-content drops are ever added.
  4. Strict policy enforcement (`update_original.rs:155-174`) only
     checks `dropped.is_empty()`.

  Net effect: Strict mode is sold as "no-loss round-trip" but
  silently permits CF/DV loss.
- Why it matters: a Strict-mode user importing a financial template
  with conditional formatting (color scales, data bars, custom CF
  rules) and exporting back via UpdateOriginal will lose all of that
  WITHOUT an error and without a `dropped_features` entry. The
  "Strict means no-loss" contract is violated.
- Suggested fix: add a Strict-mode pre-check at the start of
  `export_update_original` that inspects the original zip for the
  inline-feature signatures (`<conditionalFormatting>`,
  `<dataValidations>`, `<mergeCells>`, `<hyperlinks>`,
  `<sheetProtection>`) and short-circuits with an error if present
  + Strict. Permissive mode: add corresponding entries to
  `report.dropped_features`. This is the W5-D-13.1-style "audit
  discipline systemic blind spot" finding — the inline drops were
  never wired to either policy.

### H-3: The corpus probe asserts COUNT equality but doesn't compare cell VALUES — major silent-divergence surface

- File: `crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs:101-118`
  (`semantic_equivalent` check).
- What's wrong: the corpus probe's "semantic equivalent" check
  compares: sheet count, formula count, names count, tables count,
  overlay total, custom-format count. It does NOT compare:
  - Cell values (any cell value could change and the probe wouldn't
    notice).
  - Formula text (formulas could be mangled).
  - Format code strings (a custom format code at id 164 could be
    silently rewritten).
  - Overlay (row, col) → FormatId mapping (the COUNT matches but the
    cells with formats could be different cells).
  - Table column metadata.
  - Names → NamedTarget mapping.

  177/177 PASS the probe — but the probe is too shallow to catch the
  bugs the megaudit cares about.
- Why it matters: the probe gives a false sense of confidence. Future
  drift could land silently. Per the no-fallback rule (CLAUDE.md):
  "if something fails, it MUST fail loudly and visibly" — a probe
  that misses 80% of failure modes is the worst kind of fallback.
- Suggested fix: extend the probe to do cell-by-cell value
  comparison, formula text comparison, overlay mapping comparison.
  Make it bounded (skip fixtures with >100k cells) for runtime.
  Possibly split into a "fast" probe (counts) + a "deep" probe
  (values), with the deep probe also #[ignore]'d.

## MEDIUM findings

### M-1: Audit-discipline gap — W5-D-14a..e (commits `c0a496e3627` through `13b64488dc0`) have no per-batch audit docs

- File: `docs/audits/` (gap).
- What's wrong: the per-batch audit discipline was established 2026-05-17
  ([[quantbook-engine-audit-discipline]] memory). Phase 4.11 started
  2026-05-18 with W5-D-14a. Per the rule, each W5-D-14X commit
  should have its own 3-way audit. Instead, the W5-D-14a..e batches
  were rolled up into a single `w5-d-14-*.md` audit AFTER W5-D-14e
  shipped (which caught 9 HIGHs — confirming the rule's value).
- Why it matters: per-batch audits catch issues earlier (when they're
  cheaper to fix). The 9 HIGHs found after W5-D-14e would have been
  found progressively across 14a..e if each had its own audit. Not a
  correctness bug; a process-discipline gap.
- Suggested fix: for future phases, audit AT EACH SHIP (per the
  rule's letter). The rollup strategy is acceptable when the
  individual commits are scaffolding (no behavior changes) but the
  threshold should be explicit.

### M-2: Several v2-deferred items lack a tracked v2 backlog doc

- File: `docs/MASTER-PLAN.md` (silent).
- What's wrong: the commit messages list many "deferred to v2" items:
  - Sheet-rels + inline-anchor merge in UpdateOriginal
  - CF/DV/mergeCells/hyperlinks preservation
  - Per-cell font/fill/border/alignment
  - cellStyleXfs cascade inheritance
  - Custom-style-name preservation in tables
  - Table-id stability across round-trips
  - Sheet-name `''`-escape edge case
  - applyFont/Border/etc. flag round-trip

  But no single doc enumerates this v2 backlog. If a future
  contributor wants to start v2 work, where do they look? The audit
  docs partially capture this but they're scattered.
- Suggested fix: create `docs/PHASE-4-11-V2-BACKLOG.md` (or section
  in `docs/MASTER-PLAN.md` Phase 4.11) that aggregates every v2
  deferred item with a one-line description, severity, and an
  expected effort. This becomes the entry point for Phase 4.12+
  follow-up planning.

### M-3: `XlsxPreservation.known_parts` is pub but never populated

- File: `crates/ql-io-xlsx/src/model.rs:25-28`.
- What's wrong: `XlsxPreservation { original_bytes, known_parts:
  HashMap<String, Vec<u8>> }`. The `known_parts` field is exposed
  in the public API. The doc says "Map from OOXML part path →
  content for parts the importer recognized. The exporter patches
  these; unknown parts stay as-is in `original_bytes`." But the
  importer NEVER populates `known_parts` — it's always
  `HashMap::new()` (see `lib.rs:233-234`).
- Why it matters: a public field that's always empty is a misleading
  API. Either we wire it (would be useful for UpdateOriginal to skip
  re-parsing known parts) or remove from public.
- Suggested fix: either remove (breaking but cleaner), or document
  as "reserved for future use" (less clean).

### M-4: Each W5-D-14.X audit closure DELETED prior probe code without a doc record of what the probe asserted

- File: per the W5-D-14-self.md description: "Built a self-audit probe
  (`crates/ql-io-xlsx/tests/zzz_self_audit_probe.rs`, deleted
  post-audit) that constructs a Quantbook workbook with EVERY
  claimed-supported feature, exports via `ExportMode::NewWorkbook`,
  re-imports, and compares."
- What's wrong: the probe was DELETED. Its assertions live only in
  the audit-doc summary. Future regressions in those features could
  re-introduce the bugs without warning because there's no
  regenerable test artifact.
- Why it matters: the audit found 5 HIGHs via the probe. A future
  refactor could regress to "5 HIGHs again" if the same probe isn't
  rerun. Cuckoo's-nest style: "the bug came back".
- Suggested fix: keep audit probes as `#[ignore]` tests in the test
  suite — the same convention already used for
  `phase_4_11_corpus_probe.rs`. They become regression artifacts.

## LOW findings

### L-1: Multiple `**W5-D-X.Y (audit HIGH-Z closure):**` annotations in code are essentially commit-history bytes living in source

- File: throughout `crates/ql-io-xlsx/src/`.
- These annotations were useful at commit-time as audit-trail. After
  multiple revisions, some are still accurate; some are stale. They
  form a partial-history layer of accumulating noise.
- Suggested fix: as part of a v2 architecture pass, prune to leave
  ONLY the annotations that document non-obvious WHY (where the
  hidden constraint comes from). Per CLAUDE.md "Don't reference the
  current task, fix, or callers ... those belong in the PR
  description".

### L-2: Audit-doc taxonomy doesn't include severity in filename

- `docs/audits/2026-05-18-w5-d-15-codex.md` etc.
- Future readers can't tell from the filename whether the audit found
  HIGHs or was clean. A `2026-05-18-w5-d-15-codex-3H-2M-1L.md`
  convention would help.

### L-3: The corpus probe runs in ~3-4 minutes — too slow for CI but currently #[ignore]'d

- File: `tests/phase_4_11_corpus_probe.rs`.
- Should it run nightly? Pre-release? The current absence of guidance
  means it'll likely never run.

## What looked right (audit-trail integrity)

Verified by re-reading commit messages and cross-checking:

- Every Phase 4.11 commit has a clear scope sentence in its first line.
- Every audit closure commit lists the closures specifically
  (e.g., "W5-D-15.2 / closures (H-1 blank-cell + H-5 formula-blank +
  M-4 cross-sheet order)").
- Every closure commit has a corresponding test that exercises the
  bug (verified per-test review):
  - `w5_d_14_2_round_trip_preserves_table` exercises table export
  - `w5_d_14_2_round_trip_preserves_workbook_scoped_name_cell/range`
    exercises name export
  - `w5_d_14_2_round_trip_preserves_custom_format_codes` exercises
    custom format code export
  - `w5_d_14_2_update_original_round_trip_preserves_opaque_theme`
    exercises UpdateOriginal preservation
  - `w5_d_14_2_3_update_original_preserves_original_theme_bytes`
    asserts byte-for-byte (catches H-1 theme clobber)
  - `w5_d_14_2_2_strict_update_original_does_not_overwrite_output_on_drop`
    asserts Strict path doesn't write
  - `w5_d_15_*` tests cover the per-cell format closures
  - `w5_d_15_1_empty_sheet_before_styled_sheet_preserves_alignment`
    pins the index misalignment
  - `w5_d_15_2_cross_sheet_roster_byte_deterministic` inspects
    styles.xml bytes for sort order

- Each audit doc (`*-codex.md`, `*-opus.md`, `*-self.md`) lists
  HIGH/MEDIUM/LOW with file:line. Cross-references between docs are
  accurate (no broken refs).
- Per-batch audit cycles followed the parallel Codex+Opus+self
  discipline from W5-D-14 onward.

## Risk-stack assessment

Items most likely to bite us in production, ranked:

1. **H-2 (Strict policy gap on inline features)** — high probability
   of user impact + low fix effort. Should close before declaring
   Phase 4.11 ship-ready.
2. **H-3 (shallow corpus probe)** — masks future regressions. Should
   extend the probe before Phase 4.12 megaudit.
3. **H-1 (doc drift)** — slow burn; affects contributor onboarding.
   Cheap to fix.
4. **M-2 (no v2 backlog doc)** — affects Phase 4.12 planning. Should
   land before Phase 4.12 starts.
5. (Lower) the other items.

## Reproducibility

To regenerate the self-audit findings:
```bash
cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
git log --oneline c0a496e3627..f941195608b
grep -rn "TODO\|FIXME\|XXX\|v2\|deferred\|follow-up" crates/ql-io-xlsx/src/
ls docs/audits/2026-05-18-w5-d-1*
```

The H-2 + H-3 findings require manual reasoning past the grep. The
docs-drift findings are direct reads.

## Final note

This self-audit was performed in PARALLEL with Codex + Opus-A +
Opus-B + Opus-C megaudits. Findings will be consolidated at
`docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md` after
all auditors complete. Items above may be confirmed, refuted, or
superseded by the parallel auditors' findings.
