---
title: Phase 4 exit packet (4.1 → 4.11 + 4.12 megaudit close)
status: DRAFT (Phase 4.12 megaudit in flight 2026-05-18; will mark ACTIVE once closures land)
date: 2026-05-18
supersedes_pointer: docs/MASTER-PLAN.md
---

# Phase 4 exit packet — engine semantics complete

This packet closes Phase 4 of the Quantbook engine. Phase 4 shipped
the formula semantics layer end-to-end: parser, error model, date /
time, cross-sheet references, arrays + spills, tables + structured
refs, localization, the 260-function library, XLSX I/O, and the
Phase 4.12 megaudit + compatibility freeze.

## Acceptance criteria status

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| A4-01 | All gates green | ✅ | 4131 workspace tests pass; cargo fmt + clippy --workspace -D warnings + doc clean |
| A4-02 | Compat matrix complete enough to guide users | ✅ | `docs/compat/excel-matrix.md`: 311 rows, 82 % implemented (217 ✅ + 40 ⚠️ + 1 🔄 + 53 ❌). `bash scripts/report-compat-coverage.sh` reports coverage. |
| A4-03 | Excel corpus smoke suite green | ✅ | `crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs`: 177/177 fixtures pass counts-equivalent round-trip |
| A4-04 | Test count ≥ 2× Phase 3 exit count | ✅ | 4131 / 946 = 4.37× (Phase 3 exit was 946 per `docs/audits/2026-05-12-phase-3-megaudit.md`) |

All four acceptance criteria empirically met.

## Sub-phase shipped tally (4.1 → 4.11)

| Sub-phase | Theme | Status | Notes |
|---|---|---|---|
| 4.1 | Formula parser foundations | ✅ | Lexer, AST, basic operators |
| 4.2 | Formula parser advanced | ✅ | Cross-sheet refs, structured refs, R1C1, localized number literals |
| 4.3 | Error matrix | ✅ | `docs/compat/error-matrix.md` |
| 4.4 | Error recovery & error model | ✅ | `2026-05-13-phase-4.4-megaudit-{codex,sonnet}` audit closure |
| 4.5 | Date / time system | ✅ | 1900 + 1904 systems, format string grammar (`docs/architecture/2026-05-13-format-string-grammar.md`) |
| 4.6 | Cross-sheet references | ✅ | W5-93 closing megaudit shipped; Phase 4.6.E FULLY CLOSED |
| 4.7 | Array formulas + spills | ✅ | Multi-letter sub-phases B/C/D/F/G/H all audit-closed |
| 4.8 | Tables (structured refs) | ✅ | 4.8.G.3 calc-graph hooks shipped (W5-159); `Sales[Qty]` round-trips |
| 4.9 | Localization | ✅ | de-DE / fr-FR / etc. number literals; R1C1 mode |
| 4.10 | Function library (260 fns) | ✅ | V1-260 hit at `5d117724f27`; `W5-D-13.1` phase megaudit caught 6 HIGHs |
| 4.11 | XLSX I/O | ✅ | 11 commits W5-D-14a → W5-D-15.2; 5-way parallel megaudit closed 17/20 HIGHs |
| **4.12** | **Phase 4 megaudit + compatibility freeze** | **THIS PACKET** | See below |

## Phase 4.12 megaudit

Dispatched 2026-05-18 as a 5-way parallel pass spanning the whole
engine surface area:

- **Codex** — function library correctness + compat matrix integrity
- **Opus-A** — cross-feature integration (arrays × tables × cross-sheet × names × locale × xlsx)
- **Opus-B** — phase-wide defensive (parser fuzz, function-arg fuzz, recursion, op-log corruption, .qbook persistence)
- **Opus-C** — architecture / public API / persistence across all crates
- **Self** — exit-packet integrity + audit-trail (this doc)

Audit transcripts:
- Design: `docs/audits/2026-05-18-phase-4-12-megaudit-design.md`
- Per-auditor: `docs/audits/2026-05-18-phase-4-12-megaudit-{codex,opus-a,opus-b,opus-c,self}.md`
- Consolidated: `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md`
- Closure commits: tagged `W5-D-PM12-N`

## Compatibility freeze

Per master plan: Phase 4 closes with a compatibility freeze on the
public API surface that downstream consumers (Phase 5 collaboration,
Phase 6 IDE, Phase 7 UX) will build against. The frozen surface:

### Stable public API (committed)

- `ql-types::{Address, Range, ColId, RowId, SheetId, Value, ErrorValue, DateSystem, MAX_ROW, MAX_COLUMN}`
- `ql-storage::{Workbook, Sheet, FormatTable, FormatId, NameTable, NamedTarget, TableTable, TableMetadata, CellFormatOverlay, FIRST_CUSTOM_FORMAT_ID}`
- `ql-functions::FunctionRegistry` + `default_registry()` returning all 260 fns
- `ql-io-xlsx::{import_xlsx_path, export_xlsx_path, XlsxImportOptions, XlsxExportOptions, XlsxImportResult, XlsxImportReport, XlsxExportReport, RecomputeMode, ExportMode, FormulaCachePolicy, UnsupportedPolicy, UnsupportedFeatureKind, XlsxError, XlsxWarning, FeatureInventory}`

### Deprecated for removal in 0.2.0 (Phase 4.11 megaudit closure)

- `ql-io-xlsx::XlsxPreservation::known_parts` — always empty; `UpdateOriginal` reads `original_bytes` directly.
- `ql-io-xlsx::XlsxError::Reconciliation` — never constructed; reconciliation pass was never implemented.

### v2 deferrals (tracked for Phase 5+)

From the Phase 4.11 megaudit consolidated doc:
- Rels-graph merge in `UpdateOriginal` (preserves drawings / charts / comments / media reachability).
- Sheet-inline-anchor merge (CF / DV / mergeCells / hyperlinks under `UpdateOriginal`).
- Per-cell font / fill / border / alignment.
- `xfId` cascade via `cellStyleXfs`.
- Custom-style-name preservation in tables.
- Table-id stability across round-trips.
- `''`-escaped single quotes in sheet names (edge case).
- Post-process substring-XML-mutation layer → typed `Patcher` (architectural — Opus-C HIGH-1).
- A1 parser consolidation across 3 modules.
- `Event::Start` vs `Event::Empty` handling consolidation across read modules.
- `umya_export.rs` split (1495 LOC, mixed concerns).

(Phase 4.12 may add to this list per the megaudit findings.)

## Test count growth

| Phase exit | Workspace tests | Multiplier vs Phase 3 |
|---|---|---|
| Phase 2A exit (2026-05-12) | ~862 | 0.91× |
| Phase 3 exit (2026-05-12) | 946 | 1.00× (baseline) |
| Phase 4.6 close (2026-05-?) | 1984 | 2.10× |
| Phase 4.10 V1-260 ship (2026-05-17) | ~3082 | 3.26× |
| Phase 4.11 ship (2026-05-18) | 4119 | 4.36× |
| Phase 4.11 megaudit close (2026-05-18) | 4131 | 4.37× |

A4-04 target (≥ 1892) cleared by 2.18×.

## Forward work for Phase 5 (CRDT collaboration)

Per master plan Phase 5: "Turn collaboration from a single-writer op
log into real multi-user CRDT state for sheets, cells, names,
tables, presence, undo/redo, and offline sync."

Entry-state requirements per master plan (verified by this exit
packet):
- ✅ Phase 3 graph runtime exists (calcgraph in `ql-exec`).
- ✅ Phase 4 semantics are broad enough — value, formula, name,
  table, format models all stable.

Phase 5 dependencies:
- Stable operation vocabulary from `ql-oplog` ✅
- Storage semantics for computed vs user state ✅ (per `docs/architecture/calcgraph-runtime.md`)
- IDE proof surface for multi-user presence — Phase 6 work.

## Documentation deliverables status

Per master plan Phase 4 closing requirements:

| Deliverable | Status | Path |
|---|---|---|
| `docs/phase4/entry-plan.md` | ⚠️ NOT WRITTEN (Phase 4 was opportunistic; no formal entry plan) | — |
| `docs/phase4/exit-packet.md` | ✅ THIS DOC | `docs/phase4/exit-packet.md` |
| `docs/compat/excel-matrix.md` | ✅ | 311 rows, 82 % coverage |
| `docs/architecture/parser-and-semantics.md` | ⚠️ SPLIT — content lives in multiple architecture docs (`format-string-grammar.md`, `cross-sheet-references.md`, `array-formulas-and-spills.md`, `structured-references-and-tables.md`, `r1c1-locales-implicit-intersection.md`, `coercion-matrix.md`, `reference-tier-design.md`). | — |
| Updated legal / provenance notes | ⚠️ EXISTS via `.references/` per-source NOTICE files but no top-level summary | — |

The two ⚠️ gaps are documented as forward work; not blocking ship.

## Risk register (carryover to Phase 5)

1. **`.qbook` persistence format** — needs versioning + forward/backward compat strategy. Phase 5 CRDT integration may demand schema changes. Audit Opus-C should surface specifics.

2. **Public API stability** — deprecation warnings landed in
   W5-D-PM-4+5 for `known_parts` + `Reconciliation`. Next major bump
   (0.2.0) removes them. Any other deprecation candidates surfaced
   by Phase 4.12 megaudit should land BEFORE 0.2.0.

3. **Post-process XML-mutation layer** in `ql-io-xlsx` (Opus-C
   HIGH-1) — load-bearing for v2 UpdateOriginal work. Needs
   refactor before Phase 5/6 IDE-driven export workflows.

4. **Float-precision drift** — function-library correctness across
   real Excel corpus is verified by Phase 4.12 Codex audit. Any
   divergences surfaced should be ranked + closed before 0.2.0.

## Closure status

This packet is DRAFT pending Phase 4.12 megaudit closures. Will
flip to ACTIVE once:
- All HIGH findings from Phase 4.12 megaudit are either closed or
  explicitly deferred with rationale.
- Master plan Phase 4 is marked COMPLETE.
- Memory `current_work.md` is updated with the Phase 4 → Phase 5
  handoff.

Co-author: Claude Opus 4.7 (1M context) per the session-long
collaboration on Phase 4 implementation.
