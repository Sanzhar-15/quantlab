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

### ~~D1.a~~ (polish) — Tier D1 test-cluster re-partitioning — **✅ SHIPPED 2026-05-19**

- **Source:** Tier D1 audit Codex L-2 through L-5.
- **Impact:** zero behavioral / semantic / gate impact. Pure
  organizational cleanup. Workspace test count unchanged
  throughout (4222 → 4222).
- **All 4 clusters shipped 2026-05-19:**
  1. ✅ `add_sheet_rejects_zero_chunk_rows` → `sheets.rs::tests` (`06252f2b638`).
  2. ✅ `clear_formula_rejects_invalid_*` → `cells.rs::tests` (`9b45ee656eb`).
  3. ✅ W5-147 `set_formula` canonicalization tests (4) →
     `cells.rs::tests`; `set_reference_mode_op_round_trips_through_replay`
     → `config.rs::tests` (`93210e43567`).
  4. ✅ `drop_table_removes_metadata...` + `drop_table_missing_errors`
     → `tables.rs::tests` (`93210e43567`).
- **Total relocated:** 9 tests across 4 commits. Zero risk per
  D1.a's "byte-identical" framing.

### ~~D2.~~ `ql-oplog → ql-io` reverse dependency cleanup — ✅ SHIPPED 2026-05-19 at `e15e8908742`

- **Source:** Phase 4.12 Opus-C HIGH-3; Phase 5.1 audit (Opus M-3)
  established this as a Phase 5.2 hard prerequisite.
- **Resolution:**
  - Wire-vocabulary types (`CellWireValue`, `NamedTargetWire`,
    `error_to_canonical_text`, `parse_canonical_error_text`)
    moved from `ql-io::qbook_format` to new
    `ql-oplog::wire` module.
  - Persistence module (`save_workbook_with_oplog`,
    `load_workbook_with_oplog`, `PersistenceError`) moved
    from `ql-oplog::persistence` to new
    `ql-io::oplog_persistence`.
  - New `WireDecodeError` enum owned by `ql-oplog::wire`
    replaces `ql_io::QbookError` as the return type for
    `CellWireValue::to_value` and `NamedTargetWire::to_target`.
    `QbookError` gains a `#[from] WireDecodeError` variant so
    the `?` operator works at qbook-load call sites.
  - Cargo.toml: `ql-oplog` dropped its `ql-io` dep;
    `ql-io` added a `ql-oplog` dep.
- **External API compat:** `ql_io::CellWireValue` etc. preserved
  via re-export from `ql_io::lib.rs`. External callers of
  `ql_oplog::save_workbook_with_oplog` etc. must switch to
  `ql_io::...` (3 test files updated).
- **On-disk format:** unchanged. `oplog.bin` is still the same
  Loro snapshot; cell records serialize the same variant set.
- **Gates:** 4141 tests passing, fmt + clippy + doc clean.

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

## Tier H — PHASE 5.3 V1 LIMITATIONS (deferred to V2)

**Source:** Phase 5.3 step 5 three-way megaudit + per-step audits at steps 1-5c. See `docs/phase5/5-3-exit-packet.md` § "V1 limitations" + 20 audit transcripts at `docs/audits/2026-05-20-phase-5-3-*.md`.

**Added:** 2026-05-20 by Phase 5.3 step 6 exit packet (per step 5 megaudit H-D2 closure — V1 limitations MUST land in durable doc before `.plans/_active.md` archives).

### H1. Helper duplication — 6 call sites of `ql_formula_syntax::{lex, parse, print, rewrite_*}` — ✅ CLOSED 2026-05-20

- **Source:** step 5 megaudit Codex M1 + Opus-B M1 (convergent); step 5c LOW grew to 6 sites.
- **Closure:** post-5.3 single-commit refactor (`8085f42bf5b`). NEW `ql_formula_syntax::rewrite_formula_text(text, NameRewrite<'_>)` + `NameRewrite` enum with Sheet/Table/Column variants. All 6 call sites collapsed to thin wrappers (ql-collab/repair.rs 3 helpers) or direct calls (ql-exec/sheets.rs helper + 2 inline blocks in tables.rs). +6 unit tests for the helper. Workspace tests stayed clean (4361 → 4367; the +6 is from new helper unit tests). fmt + clippy clean. **No remaining work.** Done BEFORE V2 work that would have added a 7th site.

### H2. Cross-source target collision hard-fails (tables + columns)

- **Source:** step 4 audit closure (Codex+Opus convergent HIGH) — V1 limitation revert of an unsound auto-disambig.
- **Behavior:** `RenameTable { _, X } × RenameTable { _, X }` (different sources, same target) hard-fails replay via `TableCreateRejected`. Same for `RenameColumn`.
- **Why revert was right at V1:** the prior auto-disambig (X → X(2)) interacted with the repair pass's name-based chain to produce silent formula corruption.
- **Disposition:** V2 closure requires API change — replay must synthesize a "correction op" capturing the disambig outcome + thread it through to repair. Or: stable table/column IDs on wire ops (eliminates name-based chain entirely).

### H3. Concurrent table-rename × column-rename loses column intent

- **Source:** step 5c audit closure (Codex HIGH + Opus HIGH-1 convergent).
- **Behavior:** `apply_rename_column` advisory-skips when its wire table is missing (because peer A renamed it concurrently). Column rename op is silently dropped.
- **Workaround (in V1):** `repair_column_rename_chain` resolves the wire table through the table-rename chain, so formulas referencing the column by its current canonical still get rewritten where possible.
- **Disposition:** V2 — causality-aware tracking via Loro op-ids that re-targets the column op to the renamed-to table canonical.

### H4. Case-only rename policy inconsistency across sheet/table/column

- **Source:** step 5 megaudit Opus-A V1 LIM #5 + per-step audit findings.
- **Behavior:**
  - Sheet `S → s` — APPLIES (post-step-2 audit closure).
  - Table `T → t` — silent NO-OP.
  - Column `A → a` — REJECTS as `TableColumnRejected` divergence.
- **Disposition:** V2 — align all three on "case-only changes mutate display" (sheet's current behavior). Trivial code change; needs cross-handler test coverage.

### H5. Concurrent-rename intermediate names lost in edge cases

- **Source:** step 5 megaudit Opus-A V1 LIM #6 + step 3 docstring acknowledgment.
- **Behavior:** chain S1→S2→S3 captures intermediate "S2" via `old_name`. But adversarial peer interleavings where `old_name` doesn't reflect what current was at apply-time can lose the intermediate.
- **Disposition:** V2 — causality-aware tracking via Loro op-ids.

### H6. Cross-sheet historic-name ambiguity (neither historic currently held)

- **Source:** step 5 megaudit Opus-A Scenario D + step 3 docstring.
- **Behavior:** two sheets had the same canonical name at different chain points, AND neither sheet currently holds that name. Rules from both sheets land in the vec; winner determined by substitution-order consumption (sheet_id-sorted iteration). Rare.
- **Disposition:** V2 if it surfaces in practice; otherwise document + leave.

### H7. `replay_into` non-atomic on Err

- **Source:** step 5 megaudit Opus-A HIGH-1.
- **Behavior:** half-merged workbook state on replay Err. Caller MUST discard per docstring.
- **Workaround (in V1):** `CollabSession::rebuild_workbook` constructs the workbook internally and drops it on Err — caller never sees the partial state.
- **Disposition:** V2 — workbook snapshot/restore around `replay_into` OR two-phase replay (dry-run validate + apply).

### H8. API naming asymmetry — `RepairReport` vs `TableRepairReport` vs `ColumnRepairReport` — ✅ CLOSED 2026-05-20

- **Source:** step 5b LOW-3 + step 5c LOW deferred.
- **Closure:** post-5.3 single-commit mechanical refactor. Renamed `RepairReport` → `SheetRepairReport` + `AmbiguousSkip` → `SheetAmbiguousSkip` across `ql_collab` source + 2 test files + 2 docs. Workspace tests stayed at 4361 / 0; fmt + clippy clean. Closed BEFORE Phase 5.7 IDE binding consumes the API. **No remaining work.**

### H9. Production wiring delivery to IDE (Phase 5.7 work)

- **Source:** step 5b Opus HIGH-1 (rhetoric / framing).
- **Behavior:** `CollabSession::rebuild_workbook` is shipped as the API entry point but has ZERO non-test callers in the engine. The user-visible D-3 closure only happens when 5.7 IDE binding actually wires `rebuild_workbook` into the IDE's merge-then-recompute path.
- **Disposition:** Phase 5.7 work. NOT a 5.3 follow-up.

### H10. Whitespace canonicalization side effect on repair-touched formulas

- **Source:** step 5 megaudit Opus-A Scenario F.
- **Behavior:** repair pass routes through `lex → parse → rewrite → print`. Printer canonicalizes whitespace, operator spacing, function-name case. So `"SUM(  t[a] )    +1"` becomes `"SUM(T2[a]) + 1"` post-repair. Unrelated formulas (no rule applies) preserve original text.
- **Disposition:** V2 — surgical diff-only rewrite path using source spans rather than parse/print round-trip.

### H11. Mismatched workbook ↔ log silent corruption (raw API only)

- **Source:** step 5b Opus HIGH-latent.
- **Behavior:** `repair_*` functions trust the workbook is in post-replay state for the log. Calling with a stale / wrong workbook silently corrupts formulas.
- **Workaround (in V1):** `rebuild_workbook` constructs the workbook internally — eliminates the misuse class for production callers. Raw `repair_*` callers' problem.
- **Disposition:** V2 — debug-assert that for each rename in the log, the workbook's current canonical matches the post-replay expectation. Tricky to make precise without re-implementing replay; deferred.

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

## Tier I — PHASE 5.5 V2 V3 EXTENSIONS (deferred to V2 V4)

**Source:** Phase 5.5 V2 V3 step 3 audit (Codex + Opus, 2026-05-21). See `docs/audits/2026-05-21-phase-5-5-v2-v3-step-3-opus.md` § M2 for the framing.

**Context:** V2 V3 step 3's investigation finding "Loro op log IS the implicit offline queue" is correct for the "flush all accumulated ops on reattach" use case but silently defers two IDE consumer needs. Documenting here so the next IDE-side iteration knows the gap.

### I1. Bounded offline queue / pending-op inspection API

- **Source:** V2 V3 step 3 audit Opus M2.
- **Problem:** `has_pending_flush() -> bool` returns boolean only. IDE policies like "if more than N pending ops, switch to read-only mode" or "if offline for >N minutes, warn user" can't be implemented without traversing Loro's op log directly.
- **V2 V4 closure:** add `CollabSession::pending_op_count() -> usize` (cheap — `self.log.len() - last_flushed_op_count`) and/or `pending_op_summary() -> {count, oldest_timestamp}` if timestamps are tracked. Loro exposes op iteration; the helpers wrap it for the common IDE use cases.

### I2. Offline-write discard API

- **Source:** V2 V3 step 3 audit Opus M2.
- **Problem:** Loro op log doesn't support "ungrowing." An IDE with a "discard unsynced changes on window close" workflow has no clean API — they'd have to reconstruct a fresh `CollabSession` from a pre-offline snapshot.
- **V2 V4 closure:** add `CollabSession::discard_pending_ops(&mut self) -> Result<usize>` that builds a fresh session from the last-flushed snapshot (the V2 V3 step 1 `last_flushed_vv` checkpoint gives the boundary). Requires snapshot-at-VV capability from Loro 1.12+ (verify API exists).

---

## Tier J — PHASE 5.5 V2 V3 STEP 4 EXTENSIONS (deferred to V2 V4)

**Source:** Phase 5.5 V2 V3 step 4 audit (Codex + Opus, 2026-05-21). See `docs/audits/2026-05-21-phase-5-5-v2-v3-step-4-opus.md` § M3, L2, L4 and `docs/audits/2026-05-21-phase-5-5-v2-v3-step-4-codex.md` § L3.

**Context:** The WebSocket transport MVP is functional but a few rough edges in the test fixtures + the `Send`/Sync contract assert are deferred to the broader V2 V4 transport rework (TLS, bounded backpressure, reconnect wrapper).

### J1. `RejectingServer` test fixture determinism

- **Source:** V2 V3 step 4 audit Opus M3.
- **Problem:** `tests/common/mod.rs::RejectingServer` accepts a TCP connection then drops it without writing a response. The corresponding test (`connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed`) accepts EITHER `HandshakeFailed` OR `ConnectFailed` because timing + platform decides whether the client's HTTP upgrade write completes before the FIN arrives. Works today; flake-prone under future CI environments.
- **V2 V4 closure:** tighten `RejectingServer` to either (a) hold the stream open for a configured duration before dropping, OR (b) write a deliberately-malformed HTTP response then drop, forcing the `HandshakeFailed` path deterministically. Then rename the test to `connect_to_rejecting_tcp_server_returns_handshake_failed` (V2 V3 step 4 audit Opus L2).

### J2. Inbound text/ping/pong frame test pinning

- **Source:** V2 V3 step 4 audit Codex L3 + Opus L3.
- **Problem:** The reader task drops `Text`, `Ping`, `Pong`, `Frame` arms silently; this is documented but not test-pinned. A future refactor could change the silent-drop behavior (e.g., add a callback hook) without any test failing.
- **V2 V4 closure:** add a test that uses a custom server fixture sending a `Text` frame inbound (currently `EchoServer` only echoes binary). Assert `try_recv` returns `Ok(None)` for the text frame and that subsequent binary frames still deliver correctly. Also pins the auto-pong-without-app-traffic edge case once V2 V4 makes that observable.

### J3. `WebSocketTransport: !Sync` compile-time assert

- **Source:** V2 V3 step 4 audit Opus L4.
- **Problem:** `_ASSERT_WEBSOCKET_TRANSPORT_SEND` pins `Send` but not the documented `!Sync` intent. If a future refactor accidentally adds an `Arc<dyn Sync>` field making the type `Sync`, the assert passes silently — the docstring contract would be violated without a compiler signal.
- **V2 V4 closure:** add `static_assertions` workspace dep (or implement the idiom inline) and add `assert_not_impl_all!(WebSocketTransport: Sync)` next to the existing Send assert.

---

## Tier K — PHASE 5.5 V2 V3 STEP 5 MEGAUDIT EXTENSIONS (deferred to V2 V4)

**Source:** Phase 5.5 V2 V3 step 5 megaudit (Codex + Opus-A + Opus-B, 2026-05-21). See `docs/audits/2026-05-21-phase-5-5-v2-v3-step-5-{codex,opus-a,opus-b}.md`.

**Context:** the 3-way megaudit caught **cumulative-state issues** invisible at per-step level. The convergent finding (Codex M1 + Opus-B M1) — queued-vs-acked semantics — is documented in V2 V3 step 5 closure but the structural fix (an ack channel) is V2 V4 work. Other Tier K items are forward-leaning architecture/observability features the step 5 closure documented or sidelined.

### K1. Ack channel for end-to-end delivery confirmation

- **Source:** V2 V3 step 5 megaudit Codex M1 + Opus-B M1 (convergent).
- **Problem:** `last_flushed_vv` advances when `Transport::send` returns Ok (= queued to mpsc), not when bytes hit the wire. For buffered async impls (`WebSocketTransport`), this leaves a window where the consumer believes "synced" but the writer task could fail / be aborted / panic before transmission. The V2 V3 step 5 closure documents this in `Transport::send` + `flush_delta_to_transport` docs; the structural fix is deferred here.
- **V2 V4 closure:** add an explicit ack-channel API. Two shapes considered:
  1. `Transport::ack_pending(&mut self) -> impl Future<Output = Result<(), TransportError>>` — caller awaits until transport confirms delivery. Requires async-fn-in-trait or a separate trait. Breaking change.
  2. `Transport::flush_pending(&mut self) -> Result<(), TransportError>` — drains internal buffer synchronously (for WS: drain mpsc + await writer task's progress with a timeout). Backwards-compatible if added with default `Ok(())`.
- **Consumer pattern after closure:** `session.flush_delta_to_transport()?; if let Some(t) = session.transport_mut() { t.ack_pending().await?; }` — then `has_pending_flush()=false` truly means peer-acked.

### K2. Mid-drop bytes-lost test pinning

- **Source:** V2 V3 step 5 megaudit Opus-B M1.
- **Problem:** the in-flight-bytes-lost-on-drop behavior is documented but no test pins it as ACCEPTED behavior. A future refactor that accidentally "fixes" this (e.g., switches to a synchronous transport that drains on drop) would silently change observable semantics.
- **V2 V4 closure:** add a test that explicitly enqueues a send, drops the transport, attaches a fresh transport, and verifies the bytes were retransmitted on reconnect (i.e., V2 V3 step 1 baseline-reset recovers — the documented recovery path).

### K3. EchoServer tokio::sync::Mutex migration risk

- **Source:** V2 V3 step 5 megaudit Opus-B M5.
- **Problem:** `EchoServer::accept_task` pushes per-conn handles to `Arc<Mutex<Vec<JoinHandle>>>`. Current `std::sync::Mutex` is sync-acquire and benign with `accept_task.abort()`. A future migration to `tokio::sync::Mutex` (idiomatic for async) would introduce an await between spawn and push, opening a genuine race window where conn tasks land in the vec AFTER drop's drain → leaked tokio tasks past test end → runtime hang on drop.
- **V2 V4 closure:** add a comment at the accept-loop site noting `std::sync::Mutex` is load-bearing; if migrated, introduce a oneshot/Notify barrier to signal accept loop quiescence before drop's drain.

### K4. Large-blob chunking / bounded queue

- **Source:** V2 V3 step 5 megaudit Opus-A M4 (consumer concern) + Opus-B M1 (defensive).
- **Problem:** `WebSocketTransport`'s outbound mpsc is unbounded. A post-attach explicit flush of a multi-MB Loro delta sits in mpsc memory until the writer task drains it. Memory pressure on small devices; no chunking strategy.
- **V2 V4 closure:** combined with V2 V3 step 3 Tier I1 (`pending_op_count`) + V2 V4 bounded backpressure. See K1 ack channel for the related delivery-confirmation work.

### K5. WebSocketError Send+Sync compile-time assert

- **Source:** V2 V3 step 5 megaudit Opus-B L4.
- **Problem:** `_ASSERT_WEBSOCKET_TRANSPORT_SEND` pins the transport. `WebSocketError` is implicitly `Send + Sync` because all fields are `String`. A future refactor adding `Arc<dyn FnOnce>` etc. would silently break cross-thread `last_error()` consumers.
- **V2 V4 closure:** add `assert_send_sync::<WebSocketError>()` to the existing assert block. One line.

### K6. Debug includes `last_error.is_some()`

- **Source:** V2 V3 step 5 megaudit Opus-B L2.
- **Problem:** `WebSocketTransport`'s `Debug` impl shows `closed`, `writer_finished`, `reader_finished` but not `last_error.is_some()`. For diagnostics in a closed-state transport, knowing the error slot has a value matters more than the booleans.
- **V2 V4 closure:** add `.field("last_error_present", &self.last_error().is_some())` to the Debug impl.

### K7. Empty Binary frame test pinning

- **Source:** V2 V3 step 5 megaudit Opus-B L3.
- **Problem:** `Message::Binary(b"")` is forwarded to `CollabSession::merge_bytes(&[])` → `OpLog::merge_bytes(&[])` → `LoroDoc::import(&[])`. Loro's behavior on empty input is not test-pinned; a future Loro upgrade could change it.
- **V2 V4 closure:** add a unit test pinning `OpLog::merge_bytes(&[])` returns Ok with no state change.

### K8. `poll_remote_with_limit` auto-flush-on-error semantic

- **Source:** V2 V3 step 5 megaudit Codex L1.
- **Problem:** if `merge_bytes` on a later blob errors after earlier blobs merged, `current_vv` advanced but the post-loop `maybe_auto_flush` is skipped (early return on `?`). Not a false-synced state (`last_flushed_vv` unchanged → `has_pending_flush()=true`), but a contract caveat for "step 2 auto-flushes after non-empty drain."
- **V2 V4 closure:** decide whether to (a) document precisely ("after non-empty drain that reaches loop end or Closed-as-EOF break") or (b) refactor to invoke `maybe_auto_flush` in a `Drop` guard on the merged-counter so it fires even on early Err return.

### K9. Documentation of detach_transport reuse pattern

- **Source:** V2 V3 step 5 megaudit Opus-A M3.
- **Problem:** The `#[must_use]` attribute (added in step 5 closure) nudges consumers to drop the returned Box. But the docstring doesn't show the recommended reconnect-handshake pattern. Belongs in the consumer doc rewrite.
- **V2 V4 closure:** absorbed by Phase 5.5 V2 V3 step 6 exit packet's consumer doc rewrite.

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
