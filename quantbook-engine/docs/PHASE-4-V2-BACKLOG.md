# Phase 4 v2 backlog (deferred from Phase 4.11 + 4.12 megaudits)

**Status:** ACTIVE — single source of truth for forward work surfaced
by the Phase 4 megaudits. Each item has explicit disposition:
ship-before-0.2.0 (API stability), Phase 5 prep (architectural),
or post-MVP polish.

**Owners:** any future contributor / agent picking up Phase 5 work
should start here for the queue of well-defined HIGH-severity items
that are documented + repro-able but were deferred due to scope.

**Source docs:**
- `docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md` (3 deferred)
- `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` (14 deferred)

---

## Tier A — SHIP BEFORE 0.2.0 RELEASE (API stability commitments)

These break public-API consumers if not landed before the next major
version bump. Each is mechanical, low-design-risk work.

### A1. `#[non_exhaustive]` pass on all public enums

- **Source:** Phase 4.12 Opus-C HIGH-1.
- **Scope:** every `pub enum` exported via `pub use` across crates
  (`ql-types`, `ql-storage`, `ql-functions`, `ql-exec`, `ql-io-xlsx`,
  `ql-oplog`). Currently only one enum has `#[non_exhaustive]`.
- **Effort:** ~2-4 hours including doc updates + a release-note entry.
- **Risk:** breaks any downstream that exhaustively matches without
  a `_ => ...` arm — intentional surfacing.
- **Test:** existing test suite catches breakage; should also add a
  doc test asserting non-exhaustive patterns work.

### A2. Remove deprecated `XlsxPreservation.known_parts`

- **Source:** Phase 4.11 megaudit Opus-C HIGH-2 (deprecated in
  W5-D-PM-4+5, slated for 0.2.0).
- **Scope:** delete the field + `#[allow(deprecated)]` shims at the
  two internal call sites + 3 test sites.
- **Effort:** ~30 minutes.

### A3. Remove deprecated `XlsxError::Reconciliation`

- **Source:** Phase 4.11 megaudit Opus-C HIGH-3 (deprecated in
  W5-D-PM-4+5, slated for 0.2.0).
- **Scope:** delete the variant + any internal references.
- **Effort:** ~30 minutes.

### A4. Public API stability docs per crate

- **Source:** Phase 4.12 Opus-C MEDIUM-11.
- **Scope:** add a top-of-`lib.rs` comment block in each public-API
  crate documenting what's stable vs internal-only. Covers
  `ql-types`, `ql-storage`, `ql-functions`, `ql-io-xlsx`.
- **Effort:** ~2 hours.

---

## Tier B — PARSER / BINDER (correctness, ship-before-IDE-ship)

These directly affect the IDE proof point per master plan
Phase 4 ("IDE must open imported xlsx, show formulas, edit formulas").

### B1. Literal-range bind in `AggregateArg` context

- **Source:** Phase 4.12 Opus-A HIGH-1.
- **Impact:** **5.4 % of IronCalc corpus formulas (3 499 / 64 212)
  fail to bind**, including the most common `=SUM(A1:A10)` pattern.
  This is the load-bearing IDE-acceptance blocker.
- **Scope:** extend `crates/ql-exec/src/plan.rs::bind_with_context_v2`
  to accept `Expr::RangeRef` in `BindContext::AggregateArg` (not
  just `ReferenceArg`). Touches `plan.rs:768-777`.
- **Design doc tracked:** "§ 5.4 deferred follow-up" in `plan.rs`.
- **Effort:** 2-5 days including binder-side cache invalidation +
  comprehensive tests.
- **Bonus close:** closing B1 also closes Phase 4.12 Opus-A HIGH-4
  (column-letter-shaped names — `K`, `XFC` work in formula context
  because the binder no longer treats single-letter ranges as
  hostile).
- **Probe regression:** `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs`.

### B2. Omitted-arg syntax (`XLOOKUP(a,b,c,,2)`)

- **Source:** Phase 4.12 Opus-A HIGH-3.
- **Impact:** 371 corpus formulas fail. XLOOKUP, UNIQUE, IFS,
  TEXTBEFORE, etc.
- **Scope:** parser `crates/ql-formula-syntax/src/parser.rs:512-516`
  — extend `parse_prefix` to accept omitted args (emit an `Arg::Omitted`
  AST node or similar).
- **Effort:** 1-2 days including binder handling of the new AST node.
- **Probe regression:** `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs::p12_prefix_comma_failure_shapes`.

### B3. Parser recursion-depth limit

- **Source:** Phase 4.12 Opus-B H-1.
- **Impact:** ~200 nested function calls overflow default 2 MiB
  thread stack. DoS surface from hostile formula input.
- **Scope:** parser `parse_expr` / `parse_call` — track recursion
  depth, return typed `ParseError::DepthExceeded` past a sane
  ceiling (e.g., 256).
- **Effort:** ~half a day including tests.
- **Probe regression:** `crates/ql-formula-syntax/tests/p412_b_pinpoint.rs`.

---

## Tier C — RECOMPUTE / OP-LOG (correctness)

### C1. Cycle detection in `recompute_all`

- **Source:** Phase 4.12 Opus-B H-2.
- **Impact:** `=A1+1` in cell A1 returns 1, then 2, then 3 on
  successive `recompute_all` calls (silent value mutation, no
  `#CIRC!` emission). Affects the `.qbook` load + replay path.
- **Scope:** `crates/ql-exec/src/workbook_runtime.rs::recompute_all`
  needs the SCC analysis that `recompute_dirty` already does.
  Either share the cycle-detection pass or have `recompute_all`
  delegate to a graph-aware path.
- **Effort:** 1-3 days. Risk: changing `recompute_all` semantics may
  affect existing replay paths — careful regression testing needed.
- **Probe regression:** `crates/ql-exec/tests/p412_function_arg_fuzz.rs::self_referential_formula_direct` + `two_cycle_a1_b1`.

### C2. `Op::BatchCommit` replay depth guard

- **Source:** Phase 4.12 Opus-B H-3.
- **Impact:** serde_json's default 128-level limit is the only thing
  preventing a stack overflow on a hostile `.qbook`.
- **Scope:** `crates/ql-oplog/src/replay.rs` — explicit depth guard
  on `apply_op` for BatchCommit recursion.
- **Effort:** ~half a day.

---

## Tier D — PHASE 5 PREP (architectural refactors)

These are Phase 5 (CRDT collaboration) prerequisites that block
clean Phase 5 work if not done first.

### D1. `WorkbookRuntime` monolith split

- **Source:** Phase 4.12 Opus-C HIGH-2.
- **Scope:** `crates/ql-exec/src/workbook_runtime.rs` is 12 413 LOC.
  Phase 5 will add CRDT-aware mutation paths on top of this surface.
  Split by concern: cell mutation, name management, table management,
  recompute pipeline, op-log integration.
- **Effort:** 5-10 days. High design risk — propose a refactor plan
  + dispatch the split as its own audit cycle.
- **Risk:** breaks every test that constructs a `WorkbookRuntime`
  by name. Use type aliases for transitional compat if needed.

### D2. `ql-oplog → ql-io` reverse dependency cleanup

- **Source:** Phase 4.12 Opus-C HIGH-3.
- **Scope:** `ql-oplog::Op` reaches into `ql-io::CellWireValue` for
  its mutation vocabulary — Phase 5 CRDT integration will want
  `ql-oplog` to be the dependency floor, not depend on I/O.
- **Effort:** 1-2 days. Define an intermediate type owned by
  `ql-oplog` (or `ql-storage`) that `ql-io::CellWireValue` converts
  to/from.

### D3. `oplog.bin` magic bytes + version header

- **Source:** Phase 4.12 Opus-C HIGH-4.
- **Scope:** Phase 5 redesigns the persistence layer for CRDT. As
  part of that, add magic bytes + version field to `oplog.bin` so
  newer / older Quantbook versions can detect schema drift.
- **Effort:** included in Phase 5.1 / 5.2 design work; not a
  standalone task.

### D4. Post-process substring-XML-mutation layer → typed `Patcher`

- **Source:** Phase 4.11 megaudit Opus-C HIGH-1.
- **Scope:** `crates/ql-io-xlsx/src/write/umya_export.rs::post_process_zip`
  has 18+ `text.find`/`replace` calls. v2 inline-anchor merge
  (CF/DV/mergeCells preservation under `UpdateOriginal`) requires
  proper XML-tree manipulation. Build a typed `Patcher` over
  quick-xml events; migrate the existing post-process calls first,
  then the v2 merge work consumes it.
- **Effort:** 2-3 days for the Patcher + migration; v2 inline-merge
  on top is another 3-5 days.

---

## Tier E — CROSS-FEATURE (edge-case correctness)

### E1. `TRANSPOSE(Table[Col])` returns `#CALC!` (structured-ref × spill)

- **Source:** Phase 4.12 Opus-A HIGH-5.
- **Scope:** binder structured-ref → array-context wiring.
  `TRANSPOSE(NamedRange)` works; `TRANSPOSE(Table[Col])` doesn't.
- **Effort:** 1-2 days investigation + fix.

### E2. `read_display` ignores workbook locale after `set_locale`

- **Source:** Phase 4.12 Opus-A HIGH-6.
- **Scope:** `crates/ql-functions/src/format/render.rs` — render
  fn signature takes `EvalContext` but ignores locale-specific
  grouping/decimal separators.
- **Effort:** 1 day.

---

## Tier F — UPDATEORIGINAL v2 (rels-graph + inline-anchor merge)

This is the largest single deferred work item — multi-week scope.

### F1. Rels-graph merge in `UpdateOriginal`

- **Source:** Phase 4.11 megaudit Opus-C / Opus-B findings.
- **Scope:** sheet-anchored OOXML parts (drawings, charts, comments,
  media, embeddings, pivot, slicers) currently `DropAsUnsupported`.
  v2 preserves them by merging the original's `xl/_rels/workbook.xml.rels`
  + `xl/worksheets/_rels/sheet*.xml.rels` with shadow's.
- **Effort:** 3-5 days for rels merge alone.

### F2. Sheet-inline-anchor merge

- **Source:** Phase 4.11 megaudit Opus-C HIGH-1 (depends on D4).
- **Scope:** preserve `<conditionalFormatting>`, `<dataValidations>`,
  `<mergeCells>`, `<hyperlinks>` from original sheet xml under
  `UpdateOriginal`. Requires the typed `Patcher` from D4 first.
- **Effort:** 3-5 days.

### F3. Per-cell font / fill / border / alignment

- **Source:** Phase 4.11 explicit scope-out.
- **Scope:** Quantbook's `FormatId` only models numFmt. v2 extends
  the format model + storage overlay + xlsx round-trip.
- **Effort:** 1-2 weeks (storage + I/O + tests).

### F4. Style inheritance via `xfId` (`cellStyleXfs` cascade)

- **Source:** Phase 4.11 explicit scope-out.
- **Scope:** OOXML's "named styles" — currently `xfId="0"` is
  hardcoded. v2 wires the cascade.
- **Effort:** 1 week.

---

## Tier G — DOCS (paperwork retroactive)

### G1. `docs/phase4/entry-plan.md` retroactive

- **Source:** Phase 4.12 megaudit self H-1.
- **Disposition:** opportunistic — best-effort retroactive write from
  memory + audit-trail is worse than no doc at all.

### G2. Phase 3 retroactive exit packet

- **Source:** Phase 4.12 megaudit self M-1.
- **Disposition:** same as G1 — opportunistic.

### G3. Top-level legal / provenance summary

- **Source:** master plan Phase 4 deliverable, partial.
- **Disposition:** create `docs/legal/provenance.md` aggregating per-source
  NOTICE files from `.references/`.

---

## Smaller items (Phase 4.12 MEDIUMs worth tracking)

From the Phase 4.12 megaudit consolidated doc, ~28 MEDIUMs total.
Worth tracking but not Tier A-F priorities:

- **Codex MEDIUM-3:** IronCalc recompute corpus comparison — needs
  to run on host (sandbox blocks cargo). Run once + document
  divergences.
- **Opus-A MEDIUMs:** op-log replay sheet pre-seeding, resize-table
  recompute via CalcgraphSession, locale post-canonicalization
  edge, date1900 serial 0 display.
- **Opus-B MEDIUMs:** parser deep-paren 10000+ hangs even with
  64 MiB stack, recompute_all vs recompute_dirty UnknownTable
  mapping asymmetry, oplog import_byte_flipped detection, qbook
  envelope_truncated[cut=len-1] succeeds.
- **Opus-C MEDIUMs:** MAX_ROW/MAX_COLUMN duplicated in two crates
  with two types, BindError::UnsupportedVariant too lossy, ql-exec
  → ql-io → ql-storage boundary, ql-oplog::replay_into FunctionRegistry
  unused, MEDIUM-12 ql-exec → ql-profile inversion, MEDIUM-13
  Workbook god-struct testability.

---

## Auditor-archive probe regression suite

8 probe files left `#[ignore]`'d for regression testing when the
deferred HIGHs land:

| File | Auditor | Coverage |
|---|---|---|
| `crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs` | shared baseline | 177 IronCalc fixtures, counts-equivalent |
| `crates/ql-io-xlsx/tests/opus_a_{cache_policy,deep_probe,dup_fmt,edge_cases,error_cell_probe,format_no_overlay,misc,text_edge}.rs` | Phase 4.11 Opus-A | per-cell-format / round-trip / error |
| `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs` | Phase 4.12 Opus-A | 16 IDE proof points (P1-P16) |
| `crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs` | Phase 4.12 Opus-A | 35 cross-feature integration tests (W1-W5, I1-I27) |
| `crates/ql-exec/tests/p412_function_arg_fuzz.rs` | Phase 4.12 Opus-B | 30+ fn-arg fuzz |
| `crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs` | Phase 4.12 Opus-B | parser fuzz |
| `crates/ql-formula-syntax/tests/p412_b_threaded_depth_probe.rs` | Phase 4.12 Opus-B | parser depth on 64 MiB stack |
| `crates/ql-formula-syntax/tests/p412_b_pinpoint.rs` | Phase 4.12 Opus-B | parser depth on default stack |
| `crates/ql-io/tests/p412_qbook_corruption_probes.rs` | Phase 4.12 Opus-B | `.qbook` corruption resistance |

All marked `#[ignore]` + blanket clippy-allow headers; don't run in
default `cargo test` gate. Invoke individually via:
```bash
mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo test -p ql-io-xlsx --test opus_a_phase_4_12_ide_proof -- --ignored --nocapture <test_name>'
```

Useful when closing deferred items — run the matching probe to
verify the fix works empirically.

---

## Cycle / discipline note

Phase 4.11 + 4.12 megaudits ran ~15 plan-implement-audit cycles
this session vs CLAUDE.md's ≤2/session guideline. User explicitly
authorized the over-run ("I pushed you to reach completeness").
The megaudits' value (22 HIGHs invisible at per-batch level)
justified the cycle cost.

**Next-session recommendation:** start with Tier A (API stability,
mechanical, ships before 0.2.0), then Tier B1 (literal-range bind,
the biggest user-facing correctness gap). Tier D + F are
multi-day-each — schedule each as its own cycle.
