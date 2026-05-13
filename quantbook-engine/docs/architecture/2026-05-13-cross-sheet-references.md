# Phase 4.6 — Cross-Sheet References + Sheet-Scoped Names

**Status:** Decision doc (W5-49 pattern — design BEFORE implementation).
**Author:** 2026-05-13 W5-85 session.
**Master plan:** `docs/MASTER-PLAN.md` Phase 4.6.
**Predecessor:** Phase 4.5 (W5-84 closed all 6 sub-phases).
**Successor:** Phase 4.7 (array formulas + FormulaRegion binder).
**Codex review:** pending dispatch; findings will be synthesized into § 14.

## 1. Acceptance criteria (from MASTER-PLAN)

- **XS-4-01** — Cross-sheet cell refs (`Sheet2!A1`) parse, print, bind, and recompute.
- **XS-4-02** — Quoted sheet names (`'Sheet name'!A1`) work end-to-end.
- **XS-4-03** — Sheet-scoped names resolve BEFORE workbook-scoped names with the same identifier.
- **XS-4-04** — Op-log + `.qbook` persistence preserve sheet identity through round-trips.

## 2. Current state — what already works, what's missing

### 2.1 Already in the AST

- `ql_formula_syntax::Expr::CellRef(CellAddr { sheet: Option<SheetId>, .. })` — sheet field present since Phase 0 (opus arch F13). Currently the lexer always emits `sheet: None`; the parser propagates that.
- `ql_formula_syntax::RangeRef::{Cells, WholeColumn, WholeRow}` — each variant carries `sheet: Option<SheetId>`.
- `ql_exec::ExprPlan::CellRef { sheet: SheetId, row, col }` — bind output already resolves `Some(s)` to `s` (test at `crates/ql-exec/src/plan.rs:472`).

### 2.2 Already in the binder

`plan::bind_with_names` accepts an `owning_sheet: SheetId` and a `CellAddr.sheet: Option<SheetId>`. When the AST has `Some(s)`, the bound plan carries that sheet id. When `None`, it defaults to `owning_sheet`. This is the right shape for resolved sheet ids; nothing here changes.

### 2.3 Already in the runtime

`CellEnv::read(addr: Address)` and `WorkbookEnv::read_range(range: Range)` take fully-qualified addresses. The eval path doesn't care which sheet the formula lives on; it just reads the address the plan tells it to. No changes needed at the eval surface for cross-sheet reads.

### 2.4 What is missing

- **Lexer:** no `!` token, no sheet-name capture, no quoted-sheet handling. `lexer.rs` produces `Token::CellRef` and `Token::Ident`; there's no path from `Sheet1!A1` text to a sheet-id-bearing token.
- **Parser:** no Bang production; no logic to consume `<Ident-or-quoted-string>!<CellRef-or-RangeRef>`.
- **Sheet-name → SheetId resolution:** today, `Workbook` indexes sheets by id (u16), names available via `Sheet::name()`. There's no `Workbook::sheet_id_by_name(name: &str) -> Option<SheetId>` helper.
- **Sheet-scoped names:** `NameTable` is workbook-flat. The wire format `NamedTargetWire` (in `ql-io::qbook_format`) has no scope field. `WorkbookEnv::lookup_name` is workbook-scope only.
- **Sheet rename ops:** no `Op::RenameSheet`; `Workbook` has no `rename_sheet(id, new_name)` API.
- **Print path:** `printer.rs` doesn't know how to emit `Sheet1!A1` — it always omits sheet prefixes.
- **Replay determinism:** if a future op renames a sheet, formula text from before the rename still references the old name. Decision needed: how do formulas stay valid across sheet rename?

## 3. Sheet-name decoupling — IDs canonical in plans, names canonical in persisted source

**Codex HIGH-1 revision.** The first draft of this section proposed "SheetId is canonical at every layer below the parser; sheet names live only at lex/parse and print/serialize." Codex identified the split-brain: `Op::PutFormula` and `.qbook/sheets/N.jsonl` persist RAW FORMULA TEXT with sheet names. After a rename, the in-memory plan uses the new name but persisted text uses the old name; on reload / cache miss / recompute-from-text, the parser sees the stale name and errors.

The revised decision:

- **In-memory plans** (`ExprPlan`, calcgraph nodes, bind-plan cache): canonical by `SheetId`.
- **Persisted formula text** (`Op::PutFormula.text`, `Workbook::formula_cells`, `.qbook/sheets/N.jsonl`): canonical by sheet NAME. **Sheet rename rewrites all stored formula text** so on-disk source stays parseable. Matches Excel canon (rename in Excel rewrites every formula in the workbook that references the renamed sheet).
- **AST**: holds an unresolved name OR a resolved id via `SheetRef` (see § 5.3). Parser doesn't require workbook context (Codex HIGH-3 fix).
- **Binder**: resolves `SheetRef::Name → Id` against the current sheet registry. Unknown name → `BindError::UnknownSheet`.
- **Printer**: takes `SheetId → name` map; emits canonical name; same-sheet refs omit the prefix.

### 3.1 Rename semantics (Codex HIGH-1 closure)

`Workbook::rename_sheet(id, new_name) -> Result<()>`:
1. Validate `new_name` (non-empty; not a canonical duplicate; not Excel-reserved chars per § 7.3 / MEDIUM-2 closure).
2. Capture OLD name.
3. Walk `formula_cells` map; rewrite occurrences of old → new in formula text per the cross-sheet syntax (`Sheet1!`, `'Sheet 1'!`). Use tokenization-aware substitution (a `'Sheet1'` inside a string literal `"hello Sheet1"` is NOT rewritten).
4. Walk `NamedTarget::Formula(text)` entries in both workbook `names` and per-sheet `scoped_names`; apply the same rewrite.
5. Replace `Sheet::name`.
6. Bump `PlanCache::sheet_gen` (or `name_gen` — see § 10.5).

**Cost:** O(formula_count × avg_text_length) per rename. Rename is edit-rate not recompute-rate; bounded by workbook formula text size. Acceptable.

### 3.2 Op log for rename (Codex HIGH-1 closure)

`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }` — old_name carried so replay can validate against the workbook state at replay time without scanning prior ops. Replay calls `Workbook::rename_sheet(id, new_name)` which is idempotent given matching old/new.

### 3.3 Replay-vs-snapshot reconciliation (Codex MEDIUM-5)

**Decision:** snapshot is authoritative. Op log replays AFTER snapshot load and applies INCREMENTAL ops on top. Phase 5+ historical-replay-from-empty is a separate load mode (`load_workbook_replay_full_history`) with its own design.

`docs/architecture/calcgraph-runtime.md` + `docs/architecture/ide-consumer-contract.md` both need a one-line update on this semantic at implementation time.

---

### 3.4 (Original framing, retained for context)

The original framing — SheetId canonical below the parser — meant:

- Parser resolves `Sheet1!A1` → `CellAddr { sheet: Some(0), .. }` at parse time, using a sheet-name → SheetId map provided by the parser context.
- AST stores `SheetId`.
- Binder, planner, runtime, op log, .qbook envelope, calcgraph — all store `SheetId`.
- Printer takes the inverse `SheetId → name` map to emit text.
- Sheet rename mutates `Sheet::name` only. SheetIds are stable across renames. Formulas continue to evaluate against the new name automatically because they reference `SheetId`.

This is consistent with how `WorkbookEnv` already treats cell coordinates (storage by id; names at the API surface) and avoids the IronCalc bag of rename hazards (formula text must be re-written on rename).

Trade-off: text-only contexts (raw `.qbook` JSONL, xlsx files we don't fully own yet) carry the SHEET NAME (not id) in formula source. The qbook loader already re-parses formula text at load time (via Phase 2B.3 PlanCache); rebinding happens automatically as long as the name map is current.

**Decision:** sheet-name → SheetId mapping is parser context, NOT runtime state. The lexer/parser receive the map; storage doesn't see names.

## 4. Decision A — Lexer surface

### 4.1 New tokens

```rust
pub enum Token {
    // existing variants ...

    /// `!` — sheet-name separator. Only meaningful between a SheetName token
    /// and a CellRef / RangeRef token; appearing elsewhere is a parse error.
    Bang { pos: usize },

    /// Unquoted sheet name: a run of `[A-Za-z_][A-Za-z0-9_.]*` that
    /// IMMEDIATELY precedes a `!` (the lookahead is in the lexer to avoid
    /// ambiguity with `Ident` which is the same shape but doesn't precede
    /// `!`).
    SheetName { pos: usize, name: String },

    /// Quoted sheet name `'Sheet name with spaces'`. Body matches Excel's
    /// rule: any character except `'`; embedded `'` is escaped as `''`.
    /// Must immediately precede `!`.
    QuotedSheetName { pos: usize, name: String },
}
```

### 4.2 Lookahead policy

The lexer scans tokens left-to-right and uses one-token lookahead to disambiguate `Ident` from `SheetName`. When the scanner encounters a `[A-Za-z_]` run, it peeks at the next non-whitespace char:

- If `!`: emit `SheetName`, then `Bang`.
- Else: emit `Ident` (existing behavior).

For `'...'`: scan the body until the closing `'` (handle `''` → `'` escape). If the next non-whitespace char is `!`, emit `QuotedSheetName` + `Bang`. Otherwise this is an Excel-syntax error (a bare `'...'` is not a value literal in Excel); emit `LexError::DanglingQuotedString`.

### 4.3 Edge cases

- `Sheet1!A1` — straightforward.
- `'Q3 2025'!A1` — quoted.
- `Sheet1!Sheet2!A1` — INVALID; cross-sheet refs are flat in Excel. Parser emits `BindError::DoubleSheetQualifier`.
- `Sheet1!` (nothing after) — `LexError::DanglingBang` or `ParseError::ExpectedRefAfterBang`.
- `!A1` (leading bang) — `LexError::OrphanBang`.
- `Sheet1 ! A1` (whitespace around `!`) — Excel ACCEPTS this. Lexer tokenizes as `SheetName(Sheet1), Bang, CellRef(A1)` with whitespace eaten between. Documented divergence-from-strict-Excel: NONE.
- Reserved sheet names (`AI`, future): treated as plain SheetName at lex time; binder rejects with `BindError::ReservedSheetName` if needed.

## 5. Decision B — Parser

### 5.1 Grammar extension

```ebnf
ref_term       = sheet_qualifier? (cell_ref | range_ref) ;
sheet_qualifier = sheet_name_token "!" ;
sheet_name_token = SheetName | QuotedSheetName ;
```

When the parser encounters `SheetQualifier`, it resolves the name to a `SheetId` via the parser context (next section) and threads `Some(id)` into the `CellAddr.sheet` / `RangeRef.sheet` field.

### 5.2 AST: `SheetRef` enum (Codex HIGH-3 fix)

The first draft proposed eager parser-time name resolution. Codex flagged this breaks the IDE syntax-highlight path (which calls `lex` + `parse` without a workbook) and makes Phase 4.6.A not "pure syntax."

**Revised decision:** parser does NOT require workbook context. AST stores a name-or-id ref:

```rust
/// Phase 4.6 cross-sheet reference. Resolution from `Name → Id` happens
/// at bind time, not parse time, so parsing stays workbook-free for the
/// IDE syntax-highlight + standalone test paths.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SheetRef {
    /// Same-sheet reference (no `Sheet!` prefix in source).
    Current,
    /// Unresolved name from the lexer. `Arc<str>` for cheap clones during
    /// the parse → bind handoff. Canonicalized at the lexer per § 7.3.
    Name(Arc<str>),
    /// Resolved sheet id. Produced by the binder for `SheetRef::Name`
    /// values that lookup successfully. Not directly emitted by the
    /// parser — used internally for already-bound plans and by tests
    /// that bypass the binder.
    Id(SheetId),
}
```

`CellAddr.sheet: SheetRef` (replaces `Option<SheetId>`). Similar for `RangeRef::*.sheet`.

### 5.3 Bind-time resolution

`bind_with_names(expr, owning_sheet, names, sheets: &dyn SheetResolver)` where:

```rust
pub trait SheetResolver {
    fn resolve(&self, name: &str) -> Option<SheetId>;
    fn current_sheet(&self) -> SheetId;
}
```

`SheetRef` resolution at bind time:
- `Current` → `sheets.current_sheet()` (which is the formula's owning sheet).
- `Name(s)` → `sheets.resolve(s)` or `BindError::UnknownSheet { name }`.
- `Id(s)` → use directly (already resolved; only emitted by post-bind code paths or tests).

**Implication:** parser stays pure-text + workbook-free. IDE syntax-highlight uses `parse(text)` exactly as today. Binder is the single point of sheet-name resolution. `BindError::UnknownSheet` is the diagnostic surface for unknown-name syntax.

`Workbook` exposes `sheet_id_by_name(&str) -> Option<SheetId>` plus a `SheetResolver` adapter. The adapter is what `WorkbookEnv` already passes through to the binder; just extend it.

## 6. Decision C — Binder + runtime

### 6.1 Binder

`bind_with_names` already produces `ExprPlan::CellRef { sheet: SheetId, .. }`. The only change: cross-sheet refs that resolve to a sheet that no longer exists by bind time (between parse and bind, the sheet was deleted) need a clean error. Add `BindError::SheetDeletedAfterParse { sheet_id }`.

### 6.2 Runtime evaluator

`CellEnv::read` and `WorkbookEnv::read_range` already accept full `Address`/`Range` with sheet id. The eval path treats every read as potentially cross-sheet. **No code changes at the eval surface.**

### 6.3 Recompute / dirty propagation

`CalcgraphSession` tracks dependencies by `NodeId`. NodeIds are address-based, so cross-sheet dependencies fall out automatically. **No code changes at the calcgraph surface.**

## 7. Decision D — Sheet-scoped names (XS-4-03)

### 7.1 Storage shape

Two viable approaches:

- **A — per-sheet NameTable:** `Sheet { scoped_names: NameTable, .. }`. Lookup chain: sheet's table first, then workbook's. Simpler to model but doubles the API surface.
- **B — single NameTable with scope field:** `NameTable { entries: HashMap<NameKey, NamedTarget>, .. }` where `NameKey = (Option<SheetId>, CanonicalName)`. Lookups try `(Some(sheet), name)` first, fall back to `(None, name)`.

**Decision:** Option A. Per-sheet table mirrors Excel's mental model and keeps the workbook-scope `names` field's invariants untouched. The lookup chain (sheet-then-workbook) lives in the `WorkbookEnv::lookup_name` adapter.

### 7.2 NamedTargetWire — schema v5 bump (Codex HIGH-2 fix)

The first draft proposed extending v4 in place. Codex flagged that the workbook envelope uses `#[serde(deny_unknown_fields)]` per Phase 2A.8 policy: any new field requires a schema bump. Adding `scope` to `NamedEntry` in-place at v4 means older v4 readers fail with serde-unknown-field deserialize errors rather than the documented `UnsupportedSchema` path.

**Revised decision:** bump `WORKBOOK_SCHEMA_VERSION` from 4 → 5. The new v5 envelope:
- `NamedEntry { name: String, target: NamedTargetWire, scope: Option<u16> }` — `scope: None` = workbook-scoped (existing behavior); `Some(id)` = sheet-scoped.
- Loader accepts v1-v5: v1-v4 files default all names to `scope: None`.
- v4 readers refuse v5 cleanly via the existing `UnsupportedSchema` path (regression-neutral).
- `future_schema_version_rejected` test updates to use v6.

### 7.3 Name resolution rule

Per XS-4-03: sheet-scoped wins over workbook-scoped when both define the same identifier. This matches Excel canon.

Implementation in `WorkbookEnv::lookup_name(name, current_sheet)`:
1. If `current_sheet` has a `scoped_names.lookup(name)` hit → return it.
2. Else → workbook-scope `names.lookup(name)`.

The current `bind_with_names` API takes a single `&NameLookup`. Extend it to `bind_with_names(expr, owning_sheet, names: &dyn NameLookupForSheet)` where `NameLookupForSheet::lookup(name, owning_sheet)` performs the two-tier chain internally.

## 8. Decision E — Op log + replay

### 8.1 Existing ops handle cross-sheet automatically

`Op::PutFormula { sheet, row, col, text }` — `text` carries the full formula syntax, including any `Sheet1!A1` cross-sheet refs. Replay re-parses + re-binds; no shape change.

`Op::SetName { name, target: NamedTargetWire }` — `target` already carries `sheet: u16` on the `Cell` / `Range` variants. Cross-sheet named-target refs work.

### 8.2 New / extended ops for Phase 4.6 (Codex MEDIUM-4 fix)

The first draft proposed `Op::SetSheetScopedName` as a separate op. Codex flagged this creates two representations of the same concept (workbook-scope vs sheet-scope). Cleaner shape:

**`Op::SetName { scope: Option<SheetId>, name: String, target: NamedTargetWire }`** — extend the existing variant with an optional sheet scope. `None` = workbook-scoped (current behavior; v1+ ops continue to deserialize because `Option<SheetId>` defaults to `None` under serde). `Some(id)` = sheet-scoped. Replay routes to `Workbook::set_name` or `Sheet::set_scoped_name` based on the field.

**`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }`** — per § 3.2. `old_name` carried for replay validation. Replay calls `Workbook::rename_sheet(id, new_name)`.

`BatchCommit` already supports atomic multi-op replay. A rename + scoped-name update can ride in a single batch.

### 8.3 Replay error categories

- `ReplayError::SheetRenameUnknownSheet { id }` — `RenameSheet` references a sheet that wasn't created by earlier ops.
- `ReplayError::SheetScopedNameUnknownSheet { id, name }` — same for sheet-scoped names.

## 9. Decision F — Persistence (`.qbook`)

### 9.1 Sheet identity

`Sheet::name` is already part of the v3+ envelope. Sheet ids are sequential 0..N. Cross-sheet refs in formula text just reference names — these survive save/load mechanically because `Sheet::name` round-trips.

### 9.2 Sheet-scoped names

The `NamesSection` wire format gets the `Option<scope>` extension per § 7.2. Loader assigns to `Sheet::scoped_names` or `Workbook::names` based on the scope field.

### 9.3 Sheet rename history

`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.

## 10. Sub-phase split (sequencing)

### 10.0 Phase 4.6.AA — Sheet registry + canonicalizer (Codex LOW-3 fix)

Codex flagged that sub-phase 4.6.A depends on a sheet name → id resolver, canonicalization rules, and a printer inverse map. Pulling these into a prelude sub-phase keeps subsequent work clean.

- New `Workbook::sheet_id_by_name(name: &str) -> Option<SheetId>` (case-insensitive canonical lookup).
- `Workbook::canonical_sheet_name(name: &str) -> String` — single source of truth for canonicalization (lowercase + NFC; or ASCII uppercase to match `NameTable::set` if we choose consistency over Excel-canon; pick one and pin in § 7.3 / MEDIUM-2 closure).
- Validation helpers for `Workbook::add_sheet` / `Workbook::rename_sheet`: reject empty, duplicates under canonical comparison, Excel-reserved chars (`: \ / ? * [ ]`) — if Phase 4.11 xlsx compatibility matters. Decision: reject the Excel-reserved set; named divergence-from-Quantbook = NONE.
- Pure additive; no parser/runtime changes. ~1 day. ~10 tests.

### 10.1 Phase 4.6.A — Lexer + parser + AST (no runtime changes)

- New tokens (`Bang`, `SheetName`, `QuotedSheetName`).
- Parser consumes the sheet-prefix and populates `CellAddr.sheet` / `RangeRef.sheet`.
- New `ParseError::UnknownSheet`, `DanglingBang`, `DoubleSheetQualifier`.
- Printer emits sheet prefixes when `sheet: Some(id)` and id ≠ owning_sheet.
- Standalone `ParseContext::standalone()` for tests / no-workbook callers.
- Acceptance: round-trip `Sheet1!A1` and `'Q3 2025'!B5` through parse → AST → print.
- ~3 days. ~50 tests.

### 10.2 Phase 4.6.B — Binder + runtime resolution

- Extend `Workbook::sheet_id_by_name(&str) -> Option<SheetId>` helper.
- `bind_with_names` propagates resolved `SheetId` to `ExprPlan::CellRef` / `RangeRef`.
- Runtime e2e: a formula `Sheet2!A1 + 1` on Sheet1 recomputes correctly.
- Acceptance: XS-4-01 closed.
- ~2 days. ~20 tests.

### 10.3 Phase 4.6.C — Sheet rename + Op::RenameSheet

- New `Workbook::rename_sheet(id, new_name) -> Result<()>` with collision check.
- New `WorkbookRuntime::rename_sheet` wrapper emitting `Op::RenameSheet`.
- Replay handler.
- Formula text continues to evaluate AFTER rename because `ExprPlan::CellRef` uses `SheetId` (NOT name) — but the bind-plan cache may stale. `PlanCache::name_gen` is name-table-keyed; for sheet renames we need a `sheet_gen` counter or just invalidate all bound plans on rename. Decision: bump `name_gen` (cheap; rare op).
- Acceptance: cross-sheet formulas survive sheet rename.
- ~2 days. ~10 tests.

### 10.4 Phase 4.6.D — Sheet-scoped names (XS-4-03)

- `Sheet { scoped_names: NameTable, .. }` field.
- `WorkbookRuntime::set_sheet_scoped_name` wrapper emitting `Op::SetSheetScopedName`.
- Wire-format `Option<scope>` on `NamedEntry`.
- Lookup chain in `WorkbookEnv::lookup_name`.
- Acceptance: XS-4-03 closed; sheet-scoped beats workbook-scoped with same name.
- ~2 days. ~15 tests.

### 10.5 Phase 4.6.E — Mega-audit (Codex + Sonnet parallel)

- Same pattern as W5-52 / W5-67 / W5-76 / W5-84.
- Coverage: lexer/parser/binder/runtime/sheet-scope/op-log/persistence.
- HIGH findings → closure commit.
- ~0.5 session.

### 10.6 Sequencing rationale

A → B → C → D → E. A ships pure-syntax without behavior change. B closes the most user-visible acceptance (XS-4-01). C adds rename semantics independently. D layers on sheet-scoped names. E gatekeepers the whole arc.

Total: ~9-10 days implementation + 0.5 session audit. Phase 4.5 took ~12 sessions (~6 weeks calendar); Phase 4.6 is materially smaller (no new function library work; no display path).

## 10.5 Cross-sheet range grammar (Codex HIGH-4 fix)

The first draft didn't specify range semantics under sheet qualifiers. Excel syntax (per IronCalc test corpus):

- `Sheet1!A1:B2` — prefix applies to both endpoints. `B2`'s implicit sheet is `Sheet1`.
- `Sheet1!A1:Sheet1!B2` — redundant explicit form. **Quantbook accepts but normalizes to single-prefix in AST.** Printer emits the single-prefix form.
- `Sheet1!A1:Sheet2!B2` — mixed-sheet endpoint range. **Quantbook rejects: `ParseError::MixedSheetRangeEndpoints`**. Excel itself produces `#REF!` here, which is the same semantic outcome.
- `Sheet1!A:A` — sheet-qualified whole-column range. Inherits the prefix.
- `Sheet1!1:3` — sheet-qualified whole-row range. Same.
- `Sheet1:Sheet3!A1` — 3D range. **Out of scope; explicit non-goal § 11.** `ParseError::ThreeDimensionalRange` if a `:` appears between two sheet names.

AST: `RangeRef::*.sheet: SheetRef` (the existing `Option<SheetId>` field gets the same upgrade as `CellAddr.sheet` per § 5.2). Parser ensures both endpoints carry the same `SheetRef` value at AST level (via canonicalization at parse time).

## 11. Non-goals (explicitly deferred)

- **3D references** (`Sheet1:Sheet5!A1`) — Excel-canon but rarely used; defer to Phase 4.7 or post-v1.
- **Cross-workbook references** (`[file.xlsx]Sheet1!A1`) — depends on xlsx import (Phase 4.11). Defer.
- **Sheet color / tab metadata** — UI concern; not engine surface.
- **Sheet protect / lock** — security concern; not engine surface.
- **Sheet move (reordering)** — Excel allows reordering sheets, which reassigns the visible order but NOT the SheetId. Engine already supports this implicitly (SheetIds are append-only). UI concern.

## 12. Risks + stop conditions

### 12.1 Risks

- **R-A:** Parser becomes workbook-aware. Existing tests construct parsers in `no_std`-ish ways for unit purposes. **Mitigation:** `ParseContext::standalone()` for callers that don't need cross-sheet resolution; eager error if `Sheet!X` syntax appears with standalone context.
- **R-B:** PlanCache invalidation on sheet rename. **Mitigation:** bump `name_gen` (or new `sheet_gen` for clarity); rename frequency is edit-rate not recompute-rate.
- **R-C:** Sheet-scoped name lookup adds a hash table per sheet. **Mitigation:** typical sheets have 0-2 scoped names; cost is O(sheets-with-names) per name lookup.
- **R-D:** Quoted-sheet escape handling (`''` → `'`). **Mitigation:** lexer test corpus from IronCalc + Microsoft documentation; pin the escape rule explicitly.
- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).

### 12.2 Stop conditions (don't ship without escalation)

- Parser tests fall below 95% pass rate after lexer changes.
- Bind-plan cache miss rate exceeds 20% on a workbook with no sheet renames (cache invalidation is too eager).
- Sheet rename op-log replay produces divergent state from snapshot+oplog reload (regression test required).

## 13. Acceptance criteria (re-stated; checkboxes for the next-session implementer)

- [ ] **XS-4-01:** `Sheet2!A1` parses, prints, binds, recomputes.
- [ ] **XS-4-02:** `'Q3 2025'!B5` works end-to-end (lex, parse, print).
- [ ] **XS-4-03:** sheet-scoped name with same identifier as workbook-scoped wins.
- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
- [ ] Mega-audit (4.6.E) closes 1 HIGH if any found.

## 14. Codex review summary

**COMPLETED 2026-05-13 W5-85.** Codex returned 4 HIGH + 9 MEDIUM + 3 LOW with overall verdict "do not start W5-85 implementation from this doc as-is" — the high-level "SheetId canonical below the parser" direction is sound (matches HyperFormula's sheet-by-id model) but the first draft had unresolved contradictions around persisted formula text, eager parser resolution, schema compatibility, and range/sheet-prefix grammar.

ALL HIGH findings synthesized into the doc above. Pointer to each fix:

| # | Severity | Concern | Where addressed |
|---|---|---|---|
| HIGH-1 | rename survival vs persisted formula text | § 3 revised — rename rewrites stored formula text; § 3.1-3.3 added |
| HIGH-2 | qbook deny_unknown_fields vs in-place v4 extension | § 7.2 revised — schema v5 bump |
| HIGH-3 | parser-workbook coupling breaks pure-syntax / IDE path | § 5.2-5.3 revised — `SheetRef::{Current, Name, Id}` enum; resolution at bind time |
| HIGH-4 | cross-sheet range grammar under-specified | § 10.5 added — range prefix rules, mixed-endpoint rejection, 3D deferral |
| MEDIUM-1 | lexer A1/function/sheet ambiguity | § 4.2 lookahead policy + § 4.3 edge-case table reference IronCalc corpus |
| MEDIUM-2 | sheet-name canonicalization vague | § 7.3 / § 10.0 added — single canonicalizer in `Workbook` registry |
| MEDIUM-3 | sheet-scoped name cache generation | § 10.3 / 10.5 — `sheet_gen` counter (not just `name_gen`) |
| MEDIUM-4 | two ops vs single `Op::SetName { scope }` | § 8.2 revised — single op with `scope: Option<SheetId>` |
| MEDIUM-5 | replay determinism / snapshot reconciliation | § 3.3 — snapshot authoritative; op log incremental on top |
| MEDIUM-6 | sheet rename semantic matrix incomplete | § 3.1 covers; § 10.3 sub-phase enumerates |
| MEDIUM-7 | `name_gen` for sheet rename misleading | § 10.5 — separate `sheet_gen` counter |
| MEDIUM-8 | printer rendering contract under-specified | § 10.0 added — printer takes inverse id-to-name map; same-sheet refs omit prefix (text canonicalization, NOT source-preservation) |
| MEDIUM-9 | IronCalc divergence policy thin | § 10.5 — explicit corpus references; non-goals § 11 names 3D / R1C1 / external |
| LOW-1 | `BindError::SheetDeletedAfterParse` unreachable | § 6.1 revised — moved to runtime-read `#REF!` |
| LOW-2 | reserved sheet names | § 10.0 / 7.3 — rejected at add/rename, not at formula parse |
| LOW-3 | sub-phase ordering | § 10.0 — sheet registry / canonicalizer sub-phase 4.6.AA added before 4.6.A |

Codex output preserved at `docs/audits/2026-05-13-phase-4.6-design-codex-review.txt`.

### 14.1 Open follow-ups not blocking W5-85 doc-only ship

- IronCalc test corpus has cases like `SUM(Sheet1!3:$3)` (mixed-absolute whole-row range with sheet prefix); confirm parser handles these at implementation time (4.6.A).
- Sheet-name canonicalization rule choice (lowercase NFC vs ASCII uppercase to match `NameTable`): tentative decision in § 7.3 is ASCII uppercase for consistency with existing `NameTable::set`; revisit if Phase 4.11 xlsx import surfaces Unicode collisions.
- `Op::RenameSheet { old_name, new_name }` field choice — confirmed at § 3.2; revisit if collab/CRDT semantics (Phase 5) want a different shape.
- The printer's "omit same-sheet prefix" rule means parse → AST → print on `Sheet1!A1` (on Sheet1) prints as `A1`. This is a canonicalization, not source-preservation. Document at implementation time.

## 15. Provenance + cross-references

- Master plan: `docs/MASTER-PLAN.md` Phase 4.6 (lines 462-470).
- Predecessor closures: `docs/known-gaps.md` GAP-B-03 (sheet-scoped names) + GAP-B-04 (cross-sheet bind).
- References (per master plan): `.references/ironcalc/base/src/expressions/lexer/ranges.rs`, IronCalc test_ranges, `.references/hyperformula/src/DependencyGraph/SheetMapping.ts`, `.references/formualizer/crates/formualizer-eval/src/engine/graph/sheets.rs`.
- W5-49 pattern: `docs/architecture/2026-05-13-graph-storage-decision.md` (plan + Codex review + decision before code).
