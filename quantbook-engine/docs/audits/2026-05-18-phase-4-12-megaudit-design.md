# Phase 4.12 megaudit — design + scope

## Context

Phase 4.11 just closed with a 5-way parallel megaudit (`a66db12ba85`
→ `947326824af`) that shipped 17 of 20 HIGH closures. Phase 4.12 per
master plan: "Phase 4 Megaudit And Compatibility Freeze. Audit
parser, functions, arrays, tables, xlsx, and compatibility matrix."

This is the PHASE-LEVEL audit across the entire Phase 4 (sub-phases
4.1 through 4.11). Differentiator from 4.11's focused-on-XLSX
megaudit: 4.12 spans the whole engine surface area.

## Acceptance criteria — baseline state

| ID | Criterion | Status |
|---|---|---|
| A4-01 | All gates green | ✅ 4131 tests, fmt+clippy+doc clean |
| A4-02 | Compat matrix complete enough to guide users | ✅ 311 rows, 82% coverage; needs audit verification |
| A4-03 | Excel corpus smoke suite green | ✅ 177/177 fixtures via `phase_4_11_corpus_probe.rs` |
| A4-04 | Test count ≥ 2× Phase 3 exit count | ✅ 4131 / 946 = 4.37× (Phase 3 exit was 946 per `2026-05-12-phase-3-megaudit.md`) |

Acceptance is empirically met. The megaudit verifies it ACTUALLY holds.

## Phase 4 sub-phase audit history (127 audit docs)

- 4.1-4.2 Parser foundations + advanced: covered in earlier audits.
- 4.4 Error recovery: `2026-05-13-phase-4.4-megaudit-*`.
- 4.5 Date/time: `2026-05-13-phase-4.5-*`.
- 4.6 Cross-sheet: `2026-05-13-phase-4.6-design-*` + many W5-XX docs.
- 4.7 Arrays + spills: 4.7.B/C/D/F/G/H sub-letter audits.
- 4.8 Tables: `phase-4.8-*` + 4.8.G.3 calc-graph hooks.
- 4.9 Localization: `phase-4.9-*`.
- 4.10 Function library 260 fns: extensive per-batch audits, plus
  `2026-05-17-phase-4-10-megaudit-*`.
- 4.11 XLSX I/O: `2026-05-18-phase-4-11-megaudit-*` (just shipped).

## Five non-overlapping auditor angles

### Auditor 1: Codex — function-library correctness + compat matrix integrity

Scope:
- Run IronCalc's `.references/ironcalc/xlsx/tests/calc_tests/` and
  `statistical/` against our engine. Identify per-function
  divergences.
- Verify the 311-row compat matrix: every "implemented (✅)" row
  has an actual registered function; every "missing (❌)" row is
  genuinely missing.
- Look for "compat matrix says supported but actually broken under
  X edge case" findings.
- Numerical precision: test edge cases (NaN, Inf, near-zero,
  MAX/MIN_F64) on every implemented function.

Out: `/tmp/codex-phase-4-12-megaudit-findings.md`.

### Auditor 2: Opus-A — Phase 4 cross-feature integration

Scope:
- Build synthetic workbooks combining multiple Phase 4 features
  simultaneously: arrays × tables × cross-sheet × names × formats
  × recompute.
- Trace each integration point. Find bugs that span sub-phases
  (e.g., a structured ref inside an array formula inside a
  cross-sheet name target).
- Verify the recompute graph correctly invalidates on each kind
  of mutation (add cell, rename sheet, resize table, register
  name, change format).
- IDE proof points per master plan:
  - "IDE must open imported xlsx, show formulas, edit formulas,
    save .qbook, export xlsx"
  - "Formula bar must handle cross-sheet refs, arrays/spills,
    and localized/R1C1 modes if enabled"

Out: `/tmp/opus-a-phase-4-12-findings.md`.

### Auditor 3: Opus-B — Phase-wide defensive + fuzzing

Scope:
- **Parser fuzz**: malformed formulas, deeply nested expressions
  (1000+ deep parens), unicode in identifiers, control chars in
  string literals, very long formulas (10 KB+), incomplete
  expressions, mixed locale conventions.
- **Function-arg fuzz**: every implemented function called with
  NaN, Inf, -Inf, subnormal floats, empty ranges, zero-row ranges,
  huge ranges (1M+ cells), recursive ranges, ranges spanning the
  whole grid.
- **Recursion + stack**: formulas that recurse through names,
  array formulas with self-referential ranges, deep dependency
  chains (1000+ levels).
- **Op-log replay corruption**: malformed op-log entries, out-of-
  order operations, missing dependencies.
- **`.qbook` persistence corruption**: truncated/corrupted bytes
  on load; partial writes.

Out: `/tmp/opus-b-phase-4-12-findings.md`.

### Auditor 4: Opus-C — Phase 4 architectural coherence + public API + persistence

Scope:
- Cross-crate dependency map. Are abstractions consistent across
  ql-types, ql-storage, ql-functions, ql-exec, ql-formula-* crates,
  ql-io-xlsx, ql-oplog?
- Public API stability commitments per crate. What's `pub use`-d
  vs internal? Any leakage?
- `.qbook` persistence: is it versioned? Forward/backward compat
  strategy? Migration path?
- Error taxonomy: do error types compose cleanly across crates?
  Any duplication (e.g., multiple "MalformedX" variants)?
- Test architecture: are tests organized consistently across
  crates? Any orphan test patterns?

Out: `/tmp/opus-c-phase-4-12-findings.md`.

### Auditor 5: Self — Phase 4 exit-packet integrity + audit-trail

Scope:
- Verify 127 audit docs span all Phase 4 sub-phases. Document
  per-batch gaps if any.
- Cross-check master plan Phase 4 claims against actual code
  state.
- Verify documentation deliverables exist:
  - `docs/phase4/entry-plan.md` (does it exist?)
  - `docs/phase4/exit-packet.md` (need to create)
  - `docs/compat/excel-matrix.md` ✅ (verify currency)
  - `docs/architecture/parser-and-semantics.md` (does it exist?)
  - Legal/provenance notes (where?)
- Identify forward-work items deferred from prior Phase 4 sub-phase
  closures that are still open.

Out: `docs/audits/2026-05-18-phase-4-12-megaudit-self.md`.

## Pre-audit work (this commit)

- Run all gates: ✅ 4131 tests, fmt+clippy+doc clean.
- Run compat coverage report: 82% (217/311 implemented).
- Run corpus probe: 177/177 fixtures pass.

## Deliverables

- `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` —
  consolidated findings post-dedup.
- `docs/phase4/exit-packet.md` — Phase 4 exit packet per master plan.
- HIGH closures in W5-D-PM12-N commits.
- Update master plan to mark Phase 4 COMPLETE.

## Cycle discipline note

The user has explicitly pushed through ≥10 plan-implement-audit
cycles this session. Per CLAUDE.md the limit is 2. The user has
authorized the over-cycling explicitly ("I pushed you to reach
completeness"). The megaudit closure batches are expected to be
ship-now-not-later per that direction. The exit-packet doc + Phase 4
completion mark are the natural closure points.
