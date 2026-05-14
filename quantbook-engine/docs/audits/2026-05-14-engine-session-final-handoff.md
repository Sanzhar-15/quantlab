# Engine session final handoff — 2026-05-14 (W5-77 → W5-93)

**This document is the canonical handoff for the next engine-track Claude window.**
Read it cover-to-cover, then read `docs/process/audit-protocol.md`, then verify state.

**Last updated:** 2026-05-14 post-W5-93 ship. Original draft covered through W5-91; appended with W5-92 + W5-93 closure detail below.

---

## TL;DR (60 seconds)

Branch `feat/quantbook-engine` at HEAD `1d5f33edddd` (W5-93, Phase 4.6.E
closing mega-audit — **Phase 4.6 FULLY CLOSED**). ~20 commits shipped this
session on top of W5-76 closure. Three full phase waves landed:

- **Phase 4.5.D + 4.5.E** (number-format-string mini-language end-to-end +
  closing audit). W5-77a → W5-84.
- **Phase 4.6 — fully closed:** sheet registry + canonicalizer (W5-86),
  `SheetRef` AST migration (W5-87), lexer Bang/SheetName/QuotedSheetName
  tokens (W5-88), parser + printer round-trip (W5-89), binder + runtime
  cross-sheet resolution (W5-90), sheet rename + formula-text rewrite
  (W5-91), sheet-scoped names + schema v5 (W5-92), closing mega-audit
  (W5-93). XS-4-01 + XS-4-02 + XS-4-03 + XS-4-04 all closed.

Workspace tests: **1984 passing / 0 failing** at W5-93 ship.
All 7 gates green. Working tree clean.
Nothing pushed (per CLAUDE.md "never push unless asked").

**Phase 4.6 status:** ✅ FULLY CLOSED — AA + A + B + C + D + E all shipped.

**Next phase:** 4.7 — Array formulas + dynamic spills. Multi-week phase per
MASTER-PLAN §7. Recommended start: design doc + Codex review per the W5-49
/ W5-85 pattern, then split into ~6-8 sub-phases with audit-after-each.

---

## Verify before acting

```bash
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
git log --oneline -3                                     # expect: 083ad235d24 W5-91 ...
git rev-parse --abbrev-ref HEAD                          # feat/quantbook-engine
git status -uno                                          # clean
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cargo test --workspace 2>&1 | grep -E "^test result: ok\." | \
  awk "{for (i=1;i<=NF;i++) if (\$i==\"passed;\") sum+=\$(i-1)} END {print sum}"'
# expect: 1948
```

If anything disagrees, STOP and read the engine `git log` before acting.
Stale assumptions are the dominant risk.

---

## Session ledger

| Commit | Subject | Tests after | Notes |
|---|---|---|---|
| `05e107d6def` | W5-77a — Phase 4.5.D companion: number-format-string grammar mini-spec | 1630 baseline | Doc-only |
| `d31c4a5f507` | W5-77b — parser scaffold: lexer + AST + parser | ~1660 | V1 grammar |
| `85e4c0c3967` | W5-78 — number format renderer | ~1690 | V1 renderer + V2 stubs |
| `aef90bb1e9b` | W5-79 — `FormatTable` + sparse `CellFormatOverlay` | ~1720 | Workbook-level interning |
| `09d3bd3b250` | W5-80 — op-log `Op::RegisterFormat` + `Op::SetCellFormat` | ~1750 | Producer-replay parity |
| `b467bf6d219` | W5-81 — `.qbook` schema v3→v4 (`FormatTable` + per-sheet overlay persistence) | ~1780 | Envelope-level migration |
| `e1413b54397` | W5-82 — `WorkbookRuntime` format wrappers + `read_display` | ~1810 | Public API |
| `7a85ccdf996` | W5-83 — `TEXT(value, format_string)` formula function | ~1830 | Locale-deferred to Phase 4.5.E |
| `2c25a123ea2` | W5-84 — Phase 4.5 closing mega-audit (Codex + Sonnet 2nd pass) | ~1850 | Phase 4.5 FULLY CLOSED |
| `09b35352e61` | W5-85 — Phase 4.6 cross-sheet references design (Codex-reviewed) | ~1850 | Doc-only |
| `0177fc6c269` | W5-86 — Phase 4.6.AA: sheet registry + canonicalizer | ~1870 | Workbook side-table |
| `77b932691b7` | W5-87 — Phase 4.6.A part 1: `SheetRef` AST migration | ~1890 | Replaces `Option<SheetId>` in AST |
| `85e2864fe93` | W5-88 — Phase 4.6.A part 2: lexer Bang/SheetName/QuotedSheetName | ~1900 | One-token lookahead |
| `5b26c3662d3` | W5-89 — Phase 4.6.A part 3: parser + printer cross-sheet round-trip | ~1920 | `Sheet2!A1` lexes + parses + prints |
| `1ec3c4d4724` | W5-90 — Phase 4.6.B: binder + runtime cross-sheet resolution | ~1930 | `SheetResolver` trait, `bind_with_names_and_sheets`, `RuntimeError::Bind(UnknownSheet)` |
| `083ad235d24` | **W5-91 — Phase 4.6.C: sheet rename + formula-text rewrite + `Op::RenameSheet`** | **1948** | `WorkbookRuntime::rename_sheet`, AST walker, op-log atomic batch |

Tests grew **+318 from session start at 1630 → 1948**.

---

## What W5-91 actually shipped (last commit)

### Storage (`crates/ql-storage`)
- `Workbook::rename_sheet(id, new_name)`. Validates new name (skipping
  the duplicate check when canonical key is unchanged, so case-only
  renames `Sheet1 → SHEET1` succeed). Returns `Err(SheetNameError)` on
  rejection.
- `Sheet::set_name(new_name)` accessor.
- 5 unit tests (basic / case-only / duplicate / empty / unknown-id).

### AST (`crates/ql-formula-syntax`)
- `rewrite_sheet_name_in_expr(expr, old_canonical, new_name)`.
  Recursively rewrites every `SheetRef::Name` whose canonical form
  matches `old_canonical`. `Current` and `Id` pass through. Walks
  Number / String / Bool / NameRef / CellRef / RangeRef (all 3 shapes)
  / Binary / Unary / Function / Array / Spill. 6 unit tests.

### Op log (`crates/ql-oplog`)
- `Op::RenameSheet { id, old_name, new_name }` variant. Replay handler
  with 3-case snapshot-vs-log reconciliation per design § 3.3:
  `current == old → apply` ; `current == new → no-op (replay-on-top-
  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
  surface as `SheetRenameRejected`.
- Two new `ReplayError` variants for the above.
- 6 replay unit tests + 1 producer-replay-equivalence test (BatchCommit
  path included).

### Runtime (`crates/ql-exec`)
- `WorkbookRuntime::rename_sheet(id, new_name)` is the public entry
  point. Algorithm:
  1. Validate id + new name (case-only short-circuits dup check).
  2. Walk `iter_formulas`. For each formula whose text references the
     old sheet name, lex+parse→`rewrite_sheet_name_in_expr`→print.
     Lex/parse failures leave text untouched (no rename should break
     otherwise-recoverable workbooks).
  3. Log a single `BatchCommit { ops: [PutFormula × N, RenameSheet] }`
     — atomic for replay.
  4. Apply rewrites, swap name, `plan_cache.clear()` to invalidate
     plans bound against the old name.
- `RuntimeError::SheetName(#[from] SheetNameError)` carries validation
  failures up.
- 5 runtime tests (end-to-end rewrite + recompute, unrelated-formula
  isolation, duplicate-rejection, unknown-id, case-only rename).

---

## Phase 4.6 design reference

Read these before starting Phase 4.6.D:

- `docs/architecture/2026-05-13-cross-sheet-references.md` — full
  Phase 4.6 design with Codex review synthesis (4 HIGH + 9 MEDIUM +
  3 LOW).
- `docs/audits/2026-05-13-phase-4.6-design-codex-review.txt` — raw
  Codex findings.

Open Codex items for Phase 4.6.D:
- HIGH-2 status: schema bump v4→v5 for sheet-scoped names. The
  design doc fixes the policy at "strict `deny_unknown_fields`".
- Sheet-scoped names: `SheetId → BTreeMap<NameKey, NamedTarget>` plus
  the existing workbook-scoped table. Lookup order: sheet-scoped
  first, fall back to workbook-scoped. Resolver wiring goes through
  `bind_with_names_and_sheets`.

Phase 4.6.D scope candidate (not yet committed-to):
1. `SheetNamespacedNameTable` in `ql-storage` (or extend `NameTable`
   with a per-sheet axis).
2. New `Op::SetSheetScopedName` / `Op::ClearSheetScopedName`.
3. Schema v4→v5 migration. `deny_unknown_fields` strict — old
   readers fail loud on the new field (per design § 8.1).
4. Binder reads sheet-scoped first, workbook-scoped second.
5. Tests covering shadowing semantics + scope lookup order.

Phase 4.6.E (closing mega-audit) follows D.

---

## Known follow-ups (not blocking 4.6.D)

- **Plan-cache sheet-rename granularity.** Current `rename_sheet`
  flushes the entire `PlanCache`. The design doc § 10.5 / Codex
  MEDIUM-7 calls for a finer `sheet_gen` counter that only
  invalidates plans referencing the renamed sheet. Edit-rate not
  recompute-rate, so the full flush is acceptable; filed for a
  future polish micro-batch.
- **Phase 4.7 array-formula prereq.** `SUM(Sheet2!A1:A3)` (range
  literal as function arg) still rejects at the binder. Tracked
  through W5-90's deferred test note. Phase 4.7 (array formulas)
  is the right home for that.

---

## State (snapshot at HEAD `083ad235d24`)

- **Branch:** `feat/quantbook-engine` (worktree at
  `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/`).
- **HEAD:** `083ad235d24` (W5-91).
- **Tests:** 1948 workspace tests passing.
- **Gates (all green):** fmt | clippy `-D warnings` | workspace
  tests | check-build-flags | check-cargo-lock-pins |
  check-multiversion-clones | cargo audit (1 allowed
  `atomic-polyfill` warning, pre-existing).
- **Unpushed:** all 16 session commits + prior backlog (per CLAUDE.md
  "never push unless asked").

---

## Cycle discipline note

This session ran past the ≤2 cycle CLAUDE.md guideline (user drove with
`continue` / `proceed` directives throughout the W5-77 → W5-93 wave).
A fresh session is the right call before opening Phase 4.7.

---

## APPENDIX — W5-92 + W5-93 (Phase 4.6.D + 4.6.E)

Shipped after the initial draft above. HEAD bumped from `083ad235d24`
(W5-91) through `cce5406b2c7` (W5-92) to `1d5f33edddd` (W5-93).

### W5-92 — Phase 4.6.D (sheet-scoped names + schema v5)

Closes XS-4-03 ("sheet-scoped beats workbook-scoped at owning sheet").
Five layers wired end-to-end:

- **Storage:** `Sheet::scoped_names: NameTable` field + accessors
  `scoped_names()`, `scoped_names_mut()`, `set_scoped_name`,
  `clear_scoped_name`. Reserved-name guard (CORR-06 / `AI`) applies
  per `NameTable::set`'s rules.
- **Op log:** `Op::SetName` extended with `scope: Option<SheetId>`
  (Codex MEDIUM-4 fix — single variant, not new op). `#[serde(default,
  skip_serializing_if = "Option::is_none")]` keeps v3+old wire shape
  deserializing unchanged. Replay routes by scope; unknown id →
  `InvalidSheet`, reserved name → `NameRejected`.
- **Persistence:** `WORKBOOK_SCHEMA_VERSION` 4→5 per Codex HIGH-2 fix
  (strict `deny_unknown_fields` envelope requires version bump for new
  fields). `NamedEntry.scope: Option<u16>` with serde-default for
  v1-v4 backwards-compat. Save emits scope-sorted entries; load routes
  by scope; unknown sheet id surfaces as `MalformedName`.
- **Binder:** `NameLookup` trait extended with `owning_sheet`; new
  `NameLookup for Workbook` runs the two-tier chain. Production sites
  in `WorkbookRuntime`, `WorkbookTransaction`, `CalcgraphSession`
  switched from `wb.names()` to `wb` for the names argument.
- **Runtime:** `WorkbookRuntime::set_sheet_scoped_name(sheet, name,
  target)` wrapper emits `Op::SetName { scope: Some(sheet), .. }`.

24 new tests at W5-92 (storage 5, AST already shipped W5-91, env-impl
5, runtime 5, replay 4, persistence 5).

### W5-93 — Phase 4.6.E (closing mega-audit + fixes)

Pattern: Codex + Sonnet parallel review (W5-52 / W5-67 / W5-76 / W5-84).
Codex: 2 HIGH + 4 MEDIUM + 1 LOW. Sonnet: 0 HIGH + 4 MEDIUM + 4 LOW
(Sonnet I.3 was a false positive). Synthesis at
`docs/audits/2026-05-14-phase-4.6-closing-megaudit.md`.

**HIGH-1 — sheet-name validation at all add-sheet paths:**
- Storage: new `try_add_sheet_with_chunk_rows` returns
  `Result<SheetId, SheetNameError>`. Convenience wrappers `add_sheet`
  + `add_sheet_with_chunk_rows` panic with a clear message on bad
  input (matches existing `assert!` idiom for storage-layer invariants).
- Runtime: `WorkbookRuntime::add_sheet` pre-validates → clean error
  before op-log append (no phantom entries).
- Replay: routes through fallible variant; new
  `ReplayError::SheetNameRejected`.
- Loader: routes through fallible variant; new
  `QbookError::MalformedSheet`.

**HIGH-2 — `PlanCache` invalidation on `set_sheet_scoped_name`:**
- Added `self.plan_cache.clear()` at the end of
  `WorkbookRuntime::set_sheet_scoped_name`. Pre-W5-93 a cached plan
  bound against workbook-scoped `Rate = 0.05` kept evaluating against
  that value even after `set_sheet_scoped_name(0, "Rate", 0.21)`
  because the cache key only included workbook `NameTable::generation()`.
  Per-sheet generation counter remains a future polish item (design
  § 10.5).

**MEDIUM (shipped):**
- Printer: `SheetRef::Id` panic message + pre-bind-only contract
  documented (resolver-aware print filed as GAP-B-08).
- Producer-replay equivalence: `realistic_op_sequence` now includes
  `Op::SetName { scope: Some(_), .. }`; comparator walks each sheet's
  `scoped_names`.
- Doc rot: GAP-B-03 + GAP-B-04 marked CLOSED in `known-gaps.md`;
  `MASTER-PLAN.md` Phase 4.6 entry rewritten with sub-phase commits.

**Deferred as new known-gaps:**
- GAP-B-06 — `NamedTarget::Formula` text rewrite on rename. Both
  auditors MEDIUM; deferred to Phase 4.7 alongside named-formula
  resolution.
- GAP-B-07 — lexer accepts `A1!B2` (Excel rejects with `#NAME?`).
  Codex LOW.
- GAP-B-08 — resolver-aware printer.

**Tests at W5-93:** +12 from W5-92 (1972 → 1984). Storage 4, runtime
4, replay 2, persistence 2.

### State (snapshot at HEAD `1d5f33edddd`)

- **Branch:** `feat/quantbook-engine`.
- **HEAD:** `1d5f33edddd` (W5-93).
- **Tests:** 1984 workspace tests passing.
- **Gates (all 7 green):** fmt | clippy `-D warnings` | workspace
  tests | check-build-flags | check-cargo-lock-pins |
  check-multiversion-clones | cargo audit (1 allowed warning).
- **Unpushed:** ~20 session commits + prior backlog.

### Phase 4.7 entry guide (next phase)

Recommended approach (mirrors Phase 4.6.AA → 4.6.E):

1. **W5-94 (design)** — Write `docs/architecture/2026-05-14-array-formulas-and-spills.md` covering: array-literal grammar, dynamic-array eval semantics, spill anchor data model, spill blocking + #SPILL! error, spill invalidation on dependency change, `Expr::Array` + `Expr::Spill` ↔ binder ↔ runtime lowering, op-log + persistence implications (probably no schema bump if array values just use existing `CellWireValue` shape). Dispatch Codex review before approval.
2. **W5-95+ (implementation sub-phases)** target split, audit-after-each:
   - **4.7.A** — array-literal lexer/parser (`{1,2;3,4}` syntax).
   - **4.7.B** — bind + scalar/array context propagation.
   - **4.7.C** — spill anchor data model in storage.
   - **4.7.D** — spill writeback runtime (computed overlay only).
   - **4.7.E** — spill blocking + `#SPILL!` error.
   - **4.7.F** — first dynamic-array functions (start with SEQUENCE
     + FILTER as the smallest covering pair).
   - **4.7.G** — spill invalidation + dependency tracking through
     calcgraph.
   - **4.7.H** — closing mega-audit (Codex + Sonnet parallel).

Acceptance: ARR-4-01..ARR-4-04 per MASTER-PLAN.

Naturally pair: **GAP-B-06** (named-formula rewrite on rename).
