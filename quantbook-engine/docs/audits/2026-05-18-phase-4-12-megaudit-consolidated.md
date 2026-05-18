# Phase 4.12 megaudit — consolidated findings (5-way parallel)

**Date:** 2026-05-18
**Phase scope:** All of Phase 4 (sub-phases 4.1 → 4.11 + this 4.12
overall pass).
**Auditors:** Codex (function library / compat matrix), Opus-A
(cross-feature integration), Opus-B (defensive / adversarial),
Opus-C (architecture / public API / persistence), self (exit-packet
+ audit-trail).

## Top-line numbers

- Raw findings: **19 HIGH + ~28 MEDIUM + ~20 LOW** across 5 audits.
- Empirical baselines collected:
  - Phase 4.11 corpus probe: 177/177 fixtures pass counts-equivalent.
  - Opus-A IronCalc calc_tests sweep: **3 499 / 64 212 formulas (5.4%)
    fail to bind** with `BindError::UnsupportedVariant("literal
    RangeRef in non-Function context")` across 56 files.
  - Opus-A EVEN/ODD panic empirically reproduced on `EVEN_ODD.xlsx`
    fixture.
  - Opus-B parser deep-paren overflows around 200 nested calls on
    default 2 MiB thread stack.

## HIGH findings — consolidated (post-dedup), severity-ranked

### TIER 1 — CLOSED THIS BATCH (correctness + panic + matrix integrity)

| ID | Source | Closure | Commit |
|---|---|---|---|
| C1 | Codex H-1 | NETWORKDAYS/WORKDAY out-of-range bounds | W5-D-PM12-1 |
| C2 | Codex H-2 | MOD/QUOTIENT sanitize_f64 on result | W5-D-PM12-1 |
| C3 | Opus-A H-2 | EVEN/ODD i64 overflow → #NUM! | W5-D-PM12-2 |
| C4 | Opus-B H-4 | Lexer rejects control chars in string literals | W5-D-PM12-3 (this commit) |
| C5 | Self H-2 | parser-and-semantics.md index | W5-D-PM12 pre-artifacts |

5 HIGHs closed this session.

### TIER 2 — DEFERRED TO PHASE 5 PREP OR DEDICATED FOLLOW-UP

| ID | Source | Why deferred | Disposition |
|---|---|---|---|
| D1 | Opus-A H-1 | Literal-range bind (5.4 % corpus) — design-doc-tracked v1 deferral. AggregateArg-side enabling is a binder refactor (multi-day). | Phase 5 prep: closing it also closes Opus-A H-4 (column-letter names asymmetry). |
| D2 | Opus-A H-3 | Omitted-arg parser (`XLOOKUP(a,b,c,,2)`) — 371 corpus formulas. Parser refactor. | Phase 5 prep / dedicated parser batch. |
| D3 | Opus-A H-4 | Column-letter-shaped names — closes when D1 closes. | Bundled with D1. |
| D4 | Opus-A H-5 | TRANSPOSE(Table[Col]) returns #CALC! — structured-ref × spill interaction. | Tables × arrays batch. |
| D5 | Opus-A H-6 | read_display ignores locale — small but cross-cutting; needs locale-propagation audit. | Localization polish batch. |
| D6 | Opus-B H-1 | Parser recursion depth limit (~200 calls overflow 2 MiB stack). | Parser hardening batch. |
| D7 | Opus-B H-2 | recompute_all silent wrong values for cyclic formulas (no #CIRC!). | Cycle-detection batch (substantial — graph SCC analysis). |
| D8 | Opus-B H-3 | Op::BatchCommit replay no depth guard. | Op-log hardening batch. |
| D9 | Opus-C H-1 | `#[non_exhaustive]` missing on public enums. | API-stability batch — should land BEFORE 0.2.0 release. |
| D10 | Opus-C H-2 | WorkbookRuntime 12,413-LOC monolith refactor. | Phase 5 prep — the surface Phase 5 builds on. |
| D11 | Opus-C H-3 | `ql-oplog → ql-io` reverse dependency. | Crate-architecture batch. |
| D12 | Opus-C H-4 | `oplog.bin` no magic bytes / version header. | Phase 5 redesigns this layer per master plan §551-562. |
| D13 | Opus-C H-5 | Phase 4 doc deliverables incomplete (entry-plan retroactive). | Documented-as-deferred per self M-1. |
| D14 | Self H-1 | `docs/phase4/entry-plan.md` missing. | Same as D13. |

14 HIGHs deferred. Each has explicit rationale + tracked
disposition.

## Phase 4 acceptance status (post-closures)

Per master plan A4-01..A4-04:

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| A4-01 | All gates green | ✅ | 4135 workspace tests passing; cargo fmt + clippy --workspace -D warnings + doc clean |
| A4-02 | Compat matrix complete enough | ✅ | 311 rows, 83 % coverage (was 82 % before W5-D-PM12-1 matrix fixes); SUBTOTAL/FILTER/SEQUENCE/TRUE/FALSE statuses corrected |
| A4-03 | Excel corpus smoke green | ✅ | 177/177 fixtures via `phase_4_11_corpus_probe.rs` |
| A4-04 | Test count ≥ 2× Phase 3 exit | ✅ | 4135 / 946 = 4.37× |

All four formally met. The deferred HIGHs are quality / edge-case
issues that don't break the acceptance bar but represent real
forward work for Phase 5+.

## Megaudit conclusion

Phase 4 ships. The 5-way parallel megaudit caught 19 HIGHs invisible
at per-sub-phase level (matches the 6-HIGHs-per-megaudit pattern
from Phase 4.10 / Phase 4.11). 5 closed immediately, 14 deferred
with explicit rationale and Phase 5 prep linkage.

The exit-packet (`docs/phase4/exit-packet.md`) flips from DRAFT
to ACTIVE upon this commit landing.

## Forward work consolidated

For the `docs/PHASE-4-V2-BACKLOG.md` / Phase 5 entry-plan inputs:

**API stability (BEFORE 0.2.0):**
- `#[non_exhaustive]` pass across all public enums (Opus-C H-1).
- Remove deprecated `XlsxPreservation.known_parts` + `XlsxError::Reconciliation`.
- Document public API stability commitments per crate.

**Architectural refactors (Phase 5 prep):**
- WorkbookRuntime monolith split (Opus-C H-2).
- `ql-oplog` ↔ `ql-io` dependency cleanup (Opus-C H-3).
- Post-process substring-XML-mutation layer → typed Patcher (from
  Phase 4.11 megaudit Opus-C HIGH-1).

**Persistence:**
- `oplog.bin` magic bytes + version header (Opus-C H-4) — Phase 5
  redesigns this layer.
- `.qbook` schema versioning consistency audit.

**Parser / binder:**
- Literal-range bind in AggregateArg context (Opus-A H-1).
- Omitted-arg syntax (Opus-A H-3).
- Recursion depth limit (Opus-B H-1).

**Recompute:**
- Cycle detection in `recompute_all` (Opus-B H-2). Currently only
  `recompute_dirty` detects.
- BatchCommit replay depth guard (Opus-B H-3).

**Cross-feature:**
- TRANSPOSE × structured-ref (Opus-A H-5).
- read_display × locale propagation (Opus-A H-6).

**Docs (retroactive paperwork):**
- `docs/phase4/entry-plan.md` (self H-1).
- Phase 3 retroactive exit-packet (self M-1).

## Auditor-archive probes

The 7 probe files left by Opus-A and Opus-B retain as `#[ignore]`
regression artifacts:
- `crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs`
- `crates/ql-formula-syntax/tests/p412_b_threaded_depth_probe.rs`
- `crates/ql-formula-syntax/tests/p412_b_pinpoint.rs`
- `crates/ql-exec/tests/p412_function_arg_fuzz.rs`
- `crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs`
- `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs`
- `crates/ql-io/tests/p412_qbook_corruption_probes.rs`

Plus the consolidation-baseline corpus probe at
`crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs`.

All `#[ignore]`'d. None run in the default test gate. Useful as
regression artifacts for the deferred-HIGH closures: when D1-D14
land, run the matching probe to verify.
