# Parser & semantics — Phase 4 architecture index

**Status:** ACTIVE — Phase 4.12 megaudit deliverable (2026-05-18).
**Purpose:** master plan Phase 4 Documentation Deliverables list
this file. The actual content of "parser and semantics" lives across
9 architecture docs written as each sub-phase shipped. This document
is a thin INDEX pointing at them with a one-line summary each.

Read these in this order for a top-down understanding of Quantbook's
formula semantics layer.

## 1. Foundation: types + values

- **[`docs/architecture/2026-05-13-coercion-matrix.md`](2026-05-13-coercion-matrix.md)**
  — `Value::{Number, Boolean, Text, Error, Blank}` semantics. How
  each operator + function coerces between types. The error matrix
  companion lives at `docs/compat/error-matrix.md`.

## 2. Parser

- **(no dedicated parser-grammar doc — parser code is the spec)**
  Look at `crates/ql-formula-parser/src/` for the lexer (`lexer.rs`)
  + AST (`ast.rs`) + parser (`parser.rs`). The lexer accepts dotted
  identifiers (`VAR.S`, `STDEV.P`) per Phase 2A.5; the parser
  supports operator precedence, R1C1 mode (Phase 4.9), and locale-
  aware number literals (Phase 4.9).

## 3. References (single-cell, range, cross-sheet, structured)

- **[`2026-05-13-cross-sheet-references.md`](2026-05-13-cross-sheet-references.md)**
  — `Sheet1!A1` parsing + binding + recompute. Cross-sheet name
  resolution. Phase 4.6 closing megaudit W5-93.

- **[`2026-05-14-structured-references-and-tables.md`](2026-05-14-structured-references-and-tables.md)**
  — `Sales[Qty]`, `[@Col]`, `Sales[#Headers]`. Table footprint
  + column metadata. Phase 4.8 + 4.8.G.3 calcgraph hooks.

- **[`2026-05-15-r1c1-locales-implicit-intersection.md`](2026-05-15-r1c1-locales-implicit-intersection.md)**
  — R1C1 mode, locale (de-DE / fr-FR / etc.) decimal separators,
  implicit intersection. Phase 4.9.

- **[`2026-05-17-reference-tier-design.md`](2026-05-17-reference-tier-design.md)**
  — RT-V1 mini-phase: `ROW/COLUMN/ROWS/COLUMNS/ISREF/ISFORMULA/FORMULATEXT`
  reference-aware function tier.

## 4. Dates, times, formats

- **[`2026-05-13-dates-times-formats.md`](2026-05-13-dates-times-formats.md)**
  — Excel 1900 + 1904 date systems, serial number model, leap-year
  bug compatibility (Excel's 1900 bug). Phase 4.5.

- **[`2026-05-13-format-string-grammar.md`](2026-05-13-format-string-grammar.md)**
  — Format string parser (e.g., `"#,##0.00"`, `"yyyy-mm-dd"`,
  `"[Red]0;-0"`). FormatTable + CellFormatOverlay. Phase 4.5.D.

## 5. Arrays + spills

- **[`2026-05-14-array-formulas-and-spills.md`](2026-05-14-array-formulas-and-spills.md)**
  — Array formulas, spill anchors, spill block table. Phase 4.7.

## 6. Function library + Wave architecture

- **[`2026-05-16-phase-4.10-function-library-wave-2.md`](2026-05-16-phase-4.10-function-library-wave-2.md)**
  — Wave 2 closing notes on the 260-fn library. See also
  `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`
  for the phase-level megaudit findings.

## 7. Calcgraph + runtime

- **[`calcgraph-runtime.md`](calcgraph-runtime.md)** — dependency
  graph, dirty tracking, recompute ordering. Lives in `ql-exec`.

- **[`2026-05-13-graph-storage-decision.md`](2026-05-13-graph-storage-decision.md)**
  — design decision for graph data structure.

## 8. I/O + IDE consumer contract

- **[`ide-consumer-contract.md`](ide-consumer-contract.md)** — what
  the IDE layer (Phase 6) can expect from the engine.

- Phase 4.11 (XLSX I/O) docs live separately in `crates/ql-io-xlsx/`
  module-level docs + `docs/audits/2026-05-18-phase-4-11-megaudit-*`.

## Audit history

For per-sub-phase audit transcripts see `docs/audits/`. 127 audit
docs span the full Phase 4 closure cycle. The two megaudits
specifically of interest:

- **Phase 4.10 V1-260 megaudit** (2026-05-17): caught 6 HIGHs
  invisible at per-batch level. `2026-05-17-phase-4-10-megaudit-*`.

- **Phase 4.11 XLSX megaudit** (2026-05-18): 5-way parallel pass
  closing 17 of 20 HIGHs across `ql-io-xlsx`.
  `2026-05-18-phase-4-11-megaudit-*`.

- **Phase 4.12 overall megaudit** (2026-05-18): in flight at the
  time this doc was written. See
  `docs/phase4/exit-packet.md` for closure status.

## Forward work

Items deferred to Phase 5+ per the Phase 4 exit packet:

- Real `parser-and-semantics.md` content (not just index) — could
  be expanded as a self-contained reference, but the 9 underlying
  docs already cover everything.
- Localized parsing test corpus — currently spot-checked.
- Implicit intersection edge cases — partially deferred per the
  R1C1 doc's "v2" markers.
