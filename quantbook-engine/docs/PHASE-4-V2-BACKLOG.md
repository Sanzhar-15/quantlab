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

## Tier A — SHIP BEFORE 0.2.0 RELEASE (API stability commitments) — ✅ SHIPPED 2026-05-18 at commit `40bb584a25b`

A1–A4 all closed in a single Tier A commit. Selective marker
discipline: applied to growth-likely enums (errors, options, `Op`)
where consumers aren't exhaustive data-dispatchers; skipped for
pervasively-matched stable enums (`Value`, `Locale`, `Expr`,
parser AST, registry dispatch) where `_ => unreachable!()` arms
would conflict with the no-fallbacks rule. Each crate's lib.rs
now carries a `# Stability` section documenting which enums carry
the marker and which are exhaustive by design.

### ~~A1.~~ `#[non_exhaustive]` pass — DONE (selective)

- **Source:** Phase 4.12 Opus-C HIGH-1.
- **Applied to:** `ErrorValue`, `ArrayShapeError`, `NowProvider`
  (ql-types); `FormatTableError`, `SpillBlockError`,
  `NameTableError`, `SheetNameError` (ql-storage); `LexError`,
  `ParseError`, `PrintError` (ql-formula-syntax); `FormatParseError`
  (ql-functions); `BindError`, `RuntimeError`, `SimdShape`
  (ql-exec); `XlsxError`, `UnsupportedFeatureKind`, `RecomputeMode`,
  `UnsupportedPolicy`, `ExportMode`, `FormulaCachePolicy` +
  `XlsxPreservation` struct (ql-io-xlsx); `OpLogError`,
  `PersistenceError`, `ReplayError`, `FormatRejectedSource`, `Op`
  (ql-oplog — `Op` is critical for Phase 5 prep); `QbookError`
  (ql-io).
- **Skipped (exhaustive by design):** `Value`, `Locale`, `DateSystem`,
  `ReferenceMode`, `NamedTarget`, `TotalsFunction`, parser AST
  primitives, registry dispatch types, `ExprPlan`, `ResolvedName`,
  `EvalResult`, wire enums, `Node`, `StripeType`, `NodeKind`.

### ~~A2.~~ Removed `XlsxPreservation.known_parts` — DONE

Field removed; 3 internal + 3 external test sites updated.
`XlsxPreservation::new(bytes)` constructor added for external
struct-literal callers (struct is now `#[non_exhaustive]`).

### ~~A3.~~ Removed `XlsxError::Reconciliation` — DONE

### ~~A4.~~ Per-crate stability docs — DONE

`# Stability` sections added to 10 crate lib.rs files: ql-types,
ql-storage, ql-formula-syntax, ql-functions, ql-exec, ql-io-xlsx,
ql-oplog, ql-io, ql-calcgraph, ql-profile.

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

### ~~C1.~~ Cycle detection in `recompute_all` — ✅ SHIPPED 2026-05-18 at `3451d90a03f` (+ audit closures)

- **Source:** Phase 4.12 Opus-B H-2.
- **Impact (pre-fix):** `=A1+1` in cell A1 returned 1, then 2, then 3
  on successive `recompute_all` calls (silent value mutation, no
  `#CIRC!`). Affected the `.qbook` load + replay path.
- **Fix:** before the HashMap-order eval loop, build an ephemeral
  `CalcgraphSession` via `rebuild_from_workbook`, mark every formula
  dirty, run Tarjan SCC via `schedule_dirty`, and short-circuit
  cycled cells to `Value::Error(ErrorValue::Circ)`. Acyclic
  formulas evaluate through the existing HashMap path unchanged.
- **Post-audit closures (parallel Codex + Opus pass):** pre-pass
  cycled writes BEFORE main loop so dependents propagate `#CIRC!`
  (Codex H-1); `clear_spill_if_present` for cycled cells so stale
  spill bodies are unwound (Codex H-2); bind-failed-node safety
  documented (Opus H-1); doc-comment polish (Codex L-1, Opus L-1).
  See `docs/audits/2026-05-18-tier-c1-consolidated.md` +
  `tier-c1-codex.md` + `tier-c1-opus.md`.
- **Regression tests:** 6 in `crates/ql-exec/src/workbook_runtime.rs::tests`:
  4 originals (`recompute_all_emits_circ_for_self_referential_a1_plus_one`,
  `recompute_all_emits_circ_for_two_cycle_a1_b1`,
  `recompute_all_isolates_cycle_from_acyclic_formulas`,
  `recompute_all_repeated_calls_are_idempotent_on_cycle`) + 2 audit
  closures (`recompute_all_dependent_of_cycle_propagates_circ_error`,
  `recompute_all_clears_stale_spill_when_anchor_becomes_circular`).

### C1.a (perf) — share parsed plans between rebuild + eval

- **Source:** Tier C1 audit Codex M-4 / Opus M-2.
- **Impact:** 2× lex+parse cost on cold `.qbook` load. Measurable on
  10K-formula workbooks.
- **Scope:** thread `rebuild_from_workbook`'s bound plans forward
  into the runtime's `PlanCache` so the eval loop reuses the
  binds. Or change `rebuild_from_workbook` to optionally return
  `HashMap<NodeId, ExprPlan>`.
- **Effort:** 1-2 days. Trigger: bench shows > 5% of cold-load time
  is double-parse cost.

### C1.b (perf) — full-dirty supplemental adjacency

- **Source:** Tier C1 audit Codex M-3.
- **Impact:** `build_range_supplemental` is `O(|dirty|² × avg_ranges)`.
  When every formula is marked dirty (cold-load path), this
  dominates for 10K+ formula workbooks with range/named-range/
  table refs.
- **Scope:** add a full-dirty optimized scheduler path using per-
  sheet row/col stripe-bucket lookups for dirty formulas inside
  ranges.
- **Effort:** 2-4 days.

### C1.c (coverage) — richer cycle topology tests for `recompute_all`

- **Source:** Tier C1 audit Codex L-1 / Opus M-1.
- **Impact:** missing direct test coverage for 3-cycle, `SUM(A:A)`
  range self-loop, named-range cycle, cross-sheet cycle, table-
  column cycle.
- **Scope:** add 5-6 regression tests in
  `crates/ql-exec/src/workbook_runtime.rs::tests`.
- **Effort:** ~half a day.

### C1.d (replay) — `replay_into` → `recompute_all` integration

- **Source:** Tier C1 audit Codex M-2.
- **Impact:** `ql-oplog::replay::replay_into` does not call
  `recompute_all` at end of replay. Phase 5 callers that read
  workbook values immediately after replay will see stale formula
  outputs (no cycle detection yet ran).
- **Scope:** add `replay_into_and_recompute` entry point that
  composes the existing replay with a `recompute_all` call. Or
  document a contract for Phase 5 replay wrappers.
- **Effort:** half-day with tests.

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

### ~~D1.~~ `WorkbookRuntime` monolith split — ✅ SHIPPED 2026-05-18

- **Source:** Phase 4.12 Opus-C HIGH-2.
- **Design:** `docs/architecture/workbook-runtime-split-design.md`
  (committed `2e8566e35f0`).
- **Mechanical extractions (8 commits):**
  - Step 1 (`79c1ebeefa7`): `error.rs` (RuntimeError, RecomputeFailure, RecomputeResult).
  - Step 3.1 (`2761e1f88cf`): `formats.rs` (intern_format, set_cell_format, read_display).
  - Step 3.2 (`be154f4918d`): `config.rs` (set_reference_mode, set_locale).
  - Step 3.3 (`c37c556dd0f`): `sheets.rs` (add_sheet, rename_sheet, rewrite helper).
  - Step 3.4 (`a48e985c5ec`): `names.rs` (set_name, set_sheet_scoped_name).
  - Step 3.5 (`aa6e37800ff`): `tables.rs` (6 methods + reextract_table_readers).
  - Step 3.6 (`c8d4cf95f70`): `recompute.rs` (recompute_all + recompute_dirty + 3 helpers).
  - Step 3.7 (`de7f87c5334`): `cells.rs` (set_formula + set_value + clear_formula + 3 spill helpers).
  - Step 3.8 (`69ede106a61`): `validate.rs` (validate_formula + transaction).
- **Step 4 final cleanup:** Phase 2A.1 named-range tests partitioned
  to `names.rs::tests`; lib.rs `# Stability` section updated; this
  backlog entry marked done.
- **Result:** `mod.rs` trimmed from 12,725 → 299 LOC
  (**97.6% reduction**). 9 sibling submodules under
  `crate::workbook_runtime`, average ~1,484 LOC each (heavily
  skewed: cells.rs 5,131, recompute.rs 3,152, tables.rs 2,199;
  rest under 800 LOC each).
- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
  re-exported types resolve from `crate::workbook_runtime` as before.
- **Gates:** 4141 / 4141 tests passing across every commit (zero
  drift). cargo fmt + clippy `--workspace --all-targets -D warnings`
  + doc all clean.
- **Side-effect fixes:** two pre-existing doc-comment
  misattachments (rename_table doc → set_reference_mode in Step 3.2,
  validate_cell doc → rewrite_formula_text helper in Step 3.3)
  corrected by the moves.
- **Audit:** parallel Codex + separate-Opus pass per the engine
  audit-discipline rule — see `docs/audits/2026-05-18-tier-d1-*.md`.
  2 MEDIUMs + 1 LOW closed in the closure commit; 4 LOWs deferred
  to D1.a below.

### D1.a (polish) — Tier D1 test-cluster re-partitioning

- **Source:** Tier D1 audit Codex L-2 through L-5.
- **Impact:** zero behavioral / semantic / gate impact. Pure
  organizational cleanup.
- **Scope:** move 4 misplaced test clusters to their semantically
  correct owning-submodule:
  1. `add_sheet_rejects_*` tests in `validate.rs::tests` →
     `sheets.rs::tests`.
  2. `clear_formula_rejects_invalid_*` tests in
     `validate.rs::tests` → `cells.rs::tests`.
  3. W5-147 `set_formula` canonicalization tests in
     `tables.rs::tests` → `cells.rs::tests`;
     `set_reference_mode_op_round_trips_through_replay` in
     `tables.rs::tests` → `config.rs::tests`.
  4. Pure table-API tests in `cells.rs::tests`
     (`drop_table_removes_metadata...`,
     `drop_table_missing_errors`) → `tables.rs::tests`.
- **Effort:** ~1-2 hours mechanical.
- **Risk:** none — tests are byte-identical, just relocated.
- **Why deferred:** bundling came from the natural Phase-2B.7 /
  W5-147 / W5-148-149 banner cluster boundaries during the
  D1 extraction. Re-partitioning is appropriate polish but not
  worth holding D1 closure for.

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
