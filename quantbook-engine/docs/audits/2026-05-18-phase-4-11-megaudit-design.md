# Phase 4.11 megaudit — design + scope + parallel-auditor briefs

## Why a megaudit now

Phase 4.11 shipped over 11 commits (W5-D-14a → W5-D-15.2), with
per-batch parallel-audit closures at each step. 22 unique HIGHs were
closed across the per-batch audits. But per-batch audits have
structural blind spots:

1. **Cross-commit interaction bugs.** The empty-sheet `sheet_fixes`
   misalignment (Codex HIGH-3 in W5-D-15.1) was an interaction
   between W5-D-14.2's introduction of `sheet_fixes` and W5-D-15's
   overlay-only fixes. Each batch passed audit in isolation.
2. **Phase-level claims.** Acceptance XLSX-4-03 says "formats survive
   where supported". Is that boundary faithfully represented in
   `XlsxExportReport.dropped_features`? Per-batch never asked.
3. **v2-deferral integrity.** Multiple items were deferred to v2
   (rels-merge, inline-anchor merge, custom-style-name preservation,
   xfId/cellStyleXfs dangling refs). Are they actually deferrable, or
   do they cause user-visible silent loss today?
4. **Real-world fixture coverage.** The W5-D-13.1 megaudit precedent
   caught 6 HIGHs invisible at per-batch level by running against a
   wider fixture corpus. Same expected here.
5. **Audit-trail integrity.** Do commit-message claims match the
   code? Are deferred items tracked or forgotten?

## Empirical baseline (corpus probe)

`crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs` runs every
`.xlsx` in `.references/` (177 fixtures) through
import → export → re-import. Initial results:

- **177 / 177 import OK**
- **177 / 177 export OK**
- **177 / 177 re-import OK**
- **177 / 177 counts-equivalent** (sheets / formulas / custom_formats
  / names / tables / overlay entries match across round-trip)

Probe checks counts ONLY. It does NOT check: cell-value equality,
formula text drift, overlay `(row, col) → FormatId` preservation,
format code string preservation, table column metadata, named-target
resolution. The deeper-than-counts checks are part of the
auditor-driven phase 2 of the megaudit.

## Five non-overlapping auditor angles

The parallel-audit discipline scales by giving each auditor a
distinct concern with sharp boundaries. Overlap wastes budget; gaps
fail to surface issues.

### Auditor 1: Codex — OOXML schema compliance + real-world fixture corpus

Scope:
- ECMA-376 schema validity of every emitted XML part
  (`xl/workbook.xml`, `xl/styles.xml`, `xl/worksheets/sheet*.xml`,
  `xl/tables/table*.xml`, `[Content_Types].xml`, rels files).
- Empirical: pick 5+ fixtures, dump emitted bytes after round-trip,
  diff against the input. Identify drift.
- Real-world consumer compat: does the emitted xlsx open in
  Excel / LibreOffice / openpyxl without warnings / repair dialogs?
- Cross-feature interactions: a workbook with tables + names +
  formats + UpdateOriginal all together. Anything new break?

Method: `codex exec` with read-only sandbox + empirical zip+xml
probes via the Mac bridge.

Out: `/tmp/codex-phase-4-11-megaudit-findings.md`.

### Auditor 2: Opus-A — round-trip invariants + cross-feature consistency

Scope:
- For each feature individually (names, tables, format codes,
  per-cell overlay, date system, scoped names, UpdateOriginal
  preservation), enumerate the supported variants and trace every
  one through import → export → re-import.
- Cross-feature: does the right-side-of-XLSX-4-03 boundary
  ("where supported") match what's IN the export report's
  `dropped_features`?
- Strict policy completeness: does Strict mode fire consistently
  across all unsupported feature kinds? Where does it silently
  permit loss?
- API consistency: every importable feature is also exportable?
  Every exporter setting has a matching import option?

Method: code tracing + matrix construction of (feature, variant,
import behavior, export behavior, round-trip outcome).

Out: `/tmp/opus-a-phase-4-11-findings.md`.

### Auditor 3: Opus-B — defensive / adversarial / corruption resilience

Scope:
- Malformed inputs: truncated zips, corrupted XML, invalid UTF-8,
  oversized cell refs, recursive zip bombs, malicious xfId values.
- Edge cases: zero-row sheets, sheets with only formulas, sheets
  with 1M+ cells, extreme cell refs (XFD, 1048576), deeply nested
  table references.
- Unicode: non-ASCII sheet names, format codes with emoji, sheet
  names with combining characters, RTL text.
- Integer overflow: massive numFmt ids (u32::MAX), massive cellXf
  indices, deep row counts.
- Panic resistance: does any path panic on attacker-controlled
  input? Build adversarial xlsx fixtures and test.

Method: enumerate fuzz-style inputs + verify error paths
return XlsxError (not panic).

Out: `/tmp/opus-b-phase-4-11-findings.md`.

### Auditor 4: Opus-C — architecture + maintainability + v2 readiness

Scope:
- Module structure consistency: do `read/*` modules share idioms?
  Are responsibilities cleanly partitioned?
- Technical debt enumeration: marker comments like "TODO",
  "v2 deferred", "follow-up" — are they tracked? Do they form a
  coherent v2 backlog?
- v2 upgrade path: when we add rels-graph merge in
  `update_original::v2`, will the current `classify_part` /
  `PartAction` enum support it cleanly, or will it require breaking
  changes?
- Public API stability: are the types exposed in `pub use` blocks
  the right ones? Anything internal leaking out?
- Documentation: do module-level docs match the code? Are the
  commit-message claims consistent with the actual implementation?

Method: refactor-eye review of the full `ql-io-xlsx` crate +
dependency map of who uses what.

Out: `/tmp/opus-c-phase-4-11-findings.md`.

### Auditor 5: Self — meta-audit + audit-trail integrity

Scope:
- Re-read every Phase 4.11 commit message; cross-check claims
  against `git show`.
- For each "deferred to v2" item in commit messages and audit
  docs, verify it's actually deferred (not forgotten or
  silently shipped half-done).
- For each test added to close a HIGH, verify the test actually
  exercises the bug. Are any tests just shape-checks with no
  semantic content?
- Audit-discipline integrity: did each batch follow the parallel
  Codex+Opus+self rule? Are any audit docs missing?
- Risk-stack assessment: of the items NOT covered by the four
  parallel audits above, which are the most likely to bite us
  in production?

Method: read commits, audit docs, tests; produce a meta-doc.

Out: `docs/audits/2026-05-18-phase-4-11-megaudit-self.md`.

## Deliverable

A consolidated megaudit findings doc at
`docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md` with:

- Per-auditor findings deduplicated and severity-ranked
  (HIGH / MEDIUM / LOW)
- Reproduction steps for HIGHs
- Coverage section ("what looked right")
- v2 backlog (items not closed in this megaudit, with rationale)

Then ship HIGH closures in priority order via tight commits, each
followed by per-batch re-audit per the existing discipline.

## Out of scope for this megaudit

- Performance tuning (defer to a separate batch).
- Module re-architecture (defer until v2 rels-merge work needs it).
- Per-cell style features beyond numFmt (font, fill, border,
  alignment) — Phase 4.11 explicitly scoped these out.
- VBA macro / ActiveX preservation — security-policy decision; not
  changing.
