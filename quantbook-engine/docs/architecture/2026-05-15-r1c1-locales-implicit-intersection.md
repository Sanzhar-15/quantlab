# Phase 4.9 — R1C1, Locales, Implicit Intersection

**Status:** 4.9.AA design REVISED post-Codex + Sonnet pass-1 review. Mirrors the 4.7.AA / 4.8.AA pattern.

**Phase 4.8 SHIPPED at HEAD `403fabd286e` (W5-130).** Phase 4.9 begins from a clean megaudit-verified base.

## 0. Mapping to product/master plans

Engine MASTER-PLAN.md § 4.9 lists Phase 4.9 as **R1C1, Localization, Implicit Intersection**. Acceptance:

- **LOC-4-01** R1C1 parser/printer round-trips.
- **LOC-4-02** localized separators covered.
- **LOC-4-03** implicit intersection added where Excel requires it.
- **LOC-4-04** IDE can toggle formula display mode.

Effort: 1-2 weeks. Closed sub-concerns per Codex + Sonnet pass-1:

## 1. Goals (Quantbook UX preferences, not Excel file semantics)

Three orthogonal concerns share enough infrastructure to merit a single phase:

1. **R1C1 reference syntax** as an alternative display + input mode. Toggleable per workbook (a Quantbook UX preference — not stored in Excel files, which are mode-neutral). Storage canon stays A1.
2. **Locale-aware separators** — argument separator, decimal separator, AND array literal separators (Phase 4.7 ships array literals; locale must cover them). Quantbook UX preference; storage stays canonical English.
3. **Implicit intersection operator `@`** — Excel-365 explicit narrowing operator. **Storage NOT canonical** — `@` is a semantic operator that must round-trip through stored formula text (see § 4.2).

## 2. Non-goals (deferred)

- **Function-name localization** (`SUMME` for `SUM`). OOXML stores formulas with English function names; localized names are UI-only. Out of scope for Phase 4.9. (Confirmed by Codex Q4 + Sonnet L-4.)
- **Pre-365 implicit intersection on bare ranges** (`=A1:A10` in `B5` → `A5`). Spill (Phase 4.7) replaces it. Only the explicit `@` operator triggers narrowing.
- **Locale data beyond en / de / fr** in v1. Add more once parameterization ships.
- **R1C1 mixed-relativity range endpoints** (`R[1]C:R10C5`). Parser MUST reject cleanly with a dedicated error (no silent miscompute).
- **CLDR/ICU integration.** Hardcoded locale tables in Rust for v1; known-gap noted.

## 3. Spec primer

### 3.1 R1C1

- Absolute: `R1C1` → row 1, col 1 (== `A1`).
- Relative: `R[-1]C` → one row above current cell, same column. `R[2]C[3]` → 2 down, 3 right.
- Range: `R1C1:R10C5` → A1:E10.
- Mixed (absolute + relative endpoints) → REJECTED in v1 (parse error). Documented in § 8.

**Resolution timing (closes § 6 q2):** bind-time. Parser emits an intermediate `Expr::CellRef` shape carrying signed `row_offset` / `col_offset` + `abs_row` / `abs_col`; binder lowers to absolute coords using `BindSite::at_cell` (matches the existing 4.8.E plumbing). Printer takes a `FormulaSite` arg and emits relative form when applicable.

### 3.2 Locales

Locales we ship:
- `en` — `,` arg, `.` decimal, `;` array row, `,` array col (matches Phase 4.7 default `{1,2;3,4}`).
- `de` — `;` arg, `,` decimal, `.` array row, `\\` array col (per IronCalc CLDR; tentative — pin during 4.9.E).
- `fr` — `;` arg, `,` decimal, `.` array row, `\\` array col.

Each `Locale` value carries: `arg_separator: char`, `decimal_separator: char`, `array_row_separator: char`, `array_col_separator: char`. **No `intersection_operator` field** — `@` is invariant across locales (it's also the structured-ref escape sentinel; locale-configuring `@` would break OOXML compat per Sonnet H-5).

**Decimal/list collision (DE example, closes Codex MEDIUM + Sonnet M-1):**
- `SUM(2,34;5)` in DE locale = `SUM(2.34, 5)` (one literal `2.34`, two args). The lexer is context-free: `,` inside a number-literal is the decimal separator in DE; `;` is the arg separator.
- `SUM(2,34, 5)` in DE locale is **INVALID** (the second `,` is an arg separator in EN, but DE rejects bare `,` outside number literals → parse error).
- Test vectors land at 4.9.E.

### 3.3 Implicit intersection `@` (revised post-Codex H-1)

The `@` operator narrows / passes through its operand based on the operand's value-level shape. Eval rules:

1. **Scalar / single value** → pass through unchanged. `@5` = `5`. `@SUM(A1:A10)` = `SUM(A1:A10)`.
2. **Bounded range, single column** (e.g. `A1:A10` in cell `B5`):
   - If formula row IS within range row span → pick that row's cell in that column.
   - Else → `#VALUE!`.
3. **Bounded range, single row** (e.g. `A1:E1` in cell `B5`):
   - If formula col IS within range col span → pick that col's cell in that row.
   - Else → `#VALUE!`.
4. **Bounded range, 2-D (multi-row AND multi-column)** → ALWAYS `#VALUE!` regardless of whether formula cell is geometrically inside. (IronCalc-canonical, closes Codex MEDIUM + Sonnet M-6.)
5. **Single-cell range** (`A1:A1`) → return the single cell (idempotent).
6. **WholeColumn / WholeRow** (`A:A`, `1:1`) — narrow to formula's row/col in that column/row. `@A:A` in `B5` = `A5`. `@1:1` in `B5` = `B1`. (Closes Sonnet M-4.)
7. **Array result** (Phase 4.7 array literal or array-returning function) → return array's top-left. (Codex H-1 extension.)
8. **Named range** → resolve, then apply the rules above to the underlying value.
9. **Structured ref** — the `@` INSIDE `Sales[@Col]` is unrelated (different parser context; absorbed by `Token::StructuredRef`). The `@` BEFORE a structured ref like `=@Sales[Qty]` IS this operator: it narrows the column to the formula's row.
10. **Different sheet** — if range is on a different sheet than the formula cell, narrowing rules apply against the formula cell's row/col coordinates against the OTHER sheet's range. (IronCalc reference confirms this is canon.)

**`Sheet1!@A1` (closes § 6 q8 + Sonnet L-7 + Codex MEDIUM):** parsed as sheet-prefix applied to an `@`-wrapped reference. Grammar production extended in 4.9.G; not an edge-case test.

## 4. Data model changes

### 4.1 New types — layering across crates (closes Codex HIGH-3)

**Refinement during 4.9.A implementation (W5-133):** the original draft proposed all three types (`ReferenceMode`, `LocaleId`, `LocaleData`) in `ql-formula-syntax`. Codex flagged this as too narrow — `ql-storage::Workbook` needs to hold instances, which would force a new `ql-storage → ql-formula-syntax` dependency. Resolution: split by responsibility:

```rust
// crates/ql-types/src/eval_context.rs  -- marker enums (no logic)
pub enum ReferenceMode { A1, R1C1 }          // default A1
pub enum Locale { EnUs, De, Fr }              // default EnUs; extends pre-existing single-variant enum

// crates/ql-formula-syntax/src/locale.rs -- syntax-layer data + impl
pub struct LocaleData {
    pub arg_separator: char,
    pub decimal_separator: char,
    pub array_row_separator: char,
    pub array_col_separator: char,
    // NO intersection_operator — `@` is invariant.
}

pub fn locale_data(locale: ql_types::Locale) -> &'static LocaleData {
    /* hardcoded tables for EnUs / De / Fr */
}
```

`ql-storage::Workbook` holds `reference_mode: ReferenceMode` + `locale: Locale` with accessor pairs (`reference_mode()` / `set_reference_mode()` / `locale()` / `set_locale()`); no new dep edge needed. This matches the `DateSystem` precedent.

Naming note: kept the pre-existing `Locale` enum (not `LocaleId`) to extend rather than parallel; the W5-68 docstring on `Locale` was scaffolded for exactly this Phase 4.9 extension.

### 4.2 `ql-formula-syntax::ast::Expr::ImplicitIntersection` (revised)

```rust
pub enum Expr {
    // ... existing variants ...
    /// `@expr` — Excel-365 implicit intersection. The operator
    /// narrows/passes-through its operand per the rules in § 3.3.
    /// **NOT surface-only** — preserved in storage; printer emits
    /// `@<inner>` so round-trip through formula text is lossless.
    ImplicitIntersection(Box<Expr>),
}
```

**Sub-phase 4.9.G touchpoints** (closes Sonnet H-1) — every AST walker + printer + helper must add a match arm:

- `ast::rewrite_sheet_name_in_expr` — recurse into inner Expr.
- `ast::rewrite_table_ref` — recurse into inner Expr.
- `ast::rewrite_column_ref` — recurse into inner Expr.
- `printer::print_expr` — emit `@<inner>`.
- `plan::variant_kind` — return `"ImplicitIntersection"`.
- Future walkers added in Phase 4.9.G's commit must include this arm.

### 4.3 Anchor-aware lex + parse + print API (closes Codex H-2 + Sonnet H-3/H-4)

```rust
pub struct FormulaSite {
    pub cell: ql_types::Address,  // formula's owning cell
}

pub fn lex_with(text: &str, mode: ReferenceMode, locale: LocaleId)
    -> Result<Vec<Token>, LexError>;

pub fn parse_with(tokens: Vec<Token>, mode: ReferenceMode, site: Option<FormulaSite>)
    -> Result<Expr, ParseError>;

pub fn print_with(expr: &Expr, mode: ReferenceMode, locale: LocaleId,
                  site: Option<FormulaSite>) -> Result<String, PrintError>;
```

- `site` required when `mode == R1C1` for relative R1C1 input AND output. If `mode == A1`, `site` is `None`-OK.
- `print_with(.., R1C1, _, None)` for a formula containing relative refs → `Err(PrintError::R1C1RequiresAnchor)`. NO FALLBACK.
- Backward-compat shims: `lex(text)` = `lex_with(text, A1, En)`; `print(expr)` = `print_with(expr, A1, En, None)`.

### 4.4 Storage canonicalization contract (closes Codex HIGH-6)

The op log + persistence ALWAYS store formula text in canonical form: A1 references, EN locale separators, `@` operator preserved verbatim. User input is parsed in the current `(mode, locale)`, canonicalized BEFORE op-log append:

- `WorkbookRuntime::set_formula(sheet, row, col, user_text)`:
  1. Read `wb.reference_mode()` + `wb.locale()`.
  2. `lex_with(user_text, mode, locale)` → tokens.
  3. `parse_with(tokens, mode, Some(FormulaSite { cell: ... }))` → Expr.
  4. `print_with(&expr, A1, En, None)` → canonical text. (Always succeeds — `site` only needed for R1C1 OUTPUT.)
  5. Op-log append `Op::PutFormula { text: canonical_text }`.

This means `Op::PutFormula::text` invariantly carries A1+EN+(operator-preserving) text. A `SetLocale(En)` then replay of an earlier `PutFormula` produces the SAME stored text — no re-parse needed. Same for `SetReferenceMode`.

## 5. Sub-phase split

Each sub-phase: 1 commit + 7 gates green + self-audit. Codex pull-ups at major milestones; closing megaudit at 4.9.O.

| # | Sub-phase | Subject |
|---|---|---|
| 0 | **4.9.AA** | This design doc + Codex + Sonnet pass-1 review (doc only) |
| 1 | **4.9.A** (W5-133, shipped) | `ReferenceMode` + `Locale {EnUs, De, Fr}` in `ql-types::eval_context`; `LocaleData` + `locale_data()` in `ql-formula-syntax::locale`; `Workbook::reference_mode` / `locale` accessors in `ql-storage`. Layering refined during implementation — enums in `ql-types`, separator data in `ql-formula-syntax`, no new dep-graph edge. |
| 2a | **4.9.B.1** (W5-134, shipped) | `lex_with(input, mode, locale)` signature scaffolding. `lex(input)` becomes a backward-compat shim. No behavior change. |
| 2b | **4.9.B.2** (W5-135, shipped) | Locale-aware decimal separator in `lex_number`. DE `2,34` → `Number(2.34)`. EN unchanged. Subsumed the original 4.9.E "locale-aware number lexer" row below. |
| 2c | **4.9.B.3** (W5-136, shipped) | Locale-aware arg + array separators via pre-dispatch. EN keeps `,`→`Comma`+`;`→`Semicolon`; DE/FR remap source glyphs to canonical role-tokens. Parser sees the SAME token vocab regardless of locale. |
| 2d | **4.9.B.4** (W5-138, shipped) | Lexer R1C1 mode — new `Token::R1C1Ref { row_axis: AxisSpec, col_axis: AxisSpec }` where `AxisSpec` is a flat enum `Abs(u32) \| Rel(i32)` (flattened from the original `{ kind: Abs \| Rel }` wrapper — single-field struct added no value at the implementation surface). `mode == R1C1` triggers R1C1-token emission via mode-gated dispatch BEFORE the main lex match; A1 mode is byte-identical to pre-W5-138. Commit rule: peek the char after `R`/`r` — if `[`, ASCII digit, or `C`/`c`, COMMIT (post-commit malformation surfaces as `MalformedR1C1` / `RowTooLarge` / `ColumnTooLarge`); otherwise back off to identifier lex. |
| 3 | **4.9.C parser** (W5-139, shipped) + **4.9.C binder** (W5-140, shipped) | **Parser (W5-139):** `Token::R1C1Ref` → intermediate `Expr::R1C1Ref { sheet, row_axis, col_axis }` (new variant) + `RangeRef::R1C1Cells` for ranges. Per-axis mixed-relativity check rejects with `ParseError::R1C1MixedRelativity`. Refined the design wording "Expr::CellRef with intermediate markers" to a new variant — keeps the 50+ `CellAddr` construction sites untouched. **Binder (W5-140):** `bind_with_context_v2` lowers `Expr::R1C1Ref` → `ExprPlan::CellRef { sheet, row, col, abs_col, abs_row }` using `BindSite::at_cell` for relative axes. Absolute axes drop straight in as `n - 1` (0-indexed). Relative axes resolve against `site.cell` (None → `BindError::R1C1RequiresAnchor`). Out-of-grid resolution → `BindError::R1C1OutOfBounds { resolved_row, resolved_col }`. The `abs_col` / `abs_row` flags on the emitted `ExprPlan::CellRef` are derived per-axis from the `AxisSpec` variant — preserves the abs/rel distinction the printer needs at 4.9.D. **Range lowering deferred** — `RangeRef::R1C1Cells` still surfaces via the existing `Expr::RangeRef(_)` `UnsupportedVariant` path (same as absolute `RangeRef::Cells`); range binding is handled by the existing aggregate-function dispatch and will fold R1C1Cells when that wave touches it. Calcgraph + printer `unreachable!()` stubs unchanged: storage canon (§ 4.4) lowers R1C1 → A1 text before fingerprint / stripe registration. |
| 4 | **4.9.D** (W5-141, shipped) | Printer: `print_with(expr, mode, locale, site) -> Result<String, PrintError>` plus new `FormulaSite { cell: Address }` struct + `PrintError { R1C1RequiresAnchor, R1C1AxisOutOfRange { context } }`. `print(expr)` becomes a back-compat shim over `print_with(.., A1, EnUs, None)` that `.expect`s success (panic message points to print_with for R1C1 cases). All printer functions refactored to thread `&PrintCtx` (mode/locale/site) and return `Result<(), PrintError>`. Four (mode × source-form) combinations handled: A1+CellRef (existing), A1+R1C1Ref (resolve via axis_spec_to_absolute_coord → A1 with per-axis `$`), R1C1+CellRef (emit_r1c1_axis with mode-aware `R<n>`/`R[offset]`/bare-R), R1C1+R1C1Ref (emit_r1c1_axis_from_spec — verbatim, no site lookup). Range variants (Cells, R1C1Cells, WholeColumn, WholeRow) all mode-dispatched. **Locale parameter accepted today but unused** — locale-aware separators on the print side land in 4.9.F. |
| 5 | **4.9.E** | ~~Locale-aware lexer for numbers~~ — SHIPPED EARLY as 4.9.B.2. Row retained for numbering continuity. (Originally planned here; folded into the B micro-split during implementation.) |
| 6 | **4.9.F** (W5-142, shipped) | Locale-aware printer for numbers + arrays + arg lists. Wires `PrintCtx.locale` through `locale_data()` to three print sites: (1) `print_number_with_locale` swaps `.` → locale's decimal glyph in Rust's f64 Display output (hot-path EN takes byte-identical fast path); (2) `Expr::Function` arm emits `<arg_sep> ` instead of hardcoded `, `; (3) `Expr::Array` arm emits `<row_sep> ` / `<col_sep> ` instead of `; ` / `, `. Mirrors W5-138's lex-side role-token dispatch in reverse — EN keeps `,` arg / `;` array-row / `.` decimal byte-identical; DE/FR emit `;` arg / `.` array-row / `,` decimal / `\\` array-col. The original infallible `print_number` was deleted (locale-aware replacement only). Locale parameter is no longer `#[allow(dead_code)]`. |
| 7 | **4.9.G** (W5-143, shipped, parser+printer-only) | `Token::At` (standalone `@`) + `Expr::ImplicitIntersection(Box<Expr>)` AST variant. Parser treats `@` as a prefix unary at bp 70 — looser than range `:` (so `@A:A` parses as `@(A:A)`, the Excel canon), tighter than every binary operator. Sheet-prefix interaction: `apply_sheet_to_term` gets a new arm that recurses INTO `ImplicitIntersection` to stamp the sheet onto the inner ref (so `Sheet1!@A1` and `@Sheet1!A1` produce identical ASTs). Walker touchpoints closed per Sonnet H-1: arms added to `rewrite_sheet_name_in_expr`, `rewrite_table_ref`, `rewrite_column_ref`, `print_expr_ctx`, `plan::variant_kind`, and `ql-calcgraph::fingerprint::hash_expr` (tag byte 13). **Binder stub** returns `BindError::UnsupportedVariant` pointing to 4.9.H (mirrors the 4.9.C pre-binder pattern). The in-bracket `@` inside `Sales[@Col]` stays inside `Token::StructuredRef.bracket_content` per OOXML escape rules — never reaches the new `Token::At` arm. Two prior tests assuming `@foo` was a lex error were updated to use backtick instead. |
| 8 | **4.9.H** (W5-144, shipped, binder-only — no ExprPlan variant) | Binder narrows `@expr` at BIND TIME per design § 3.3 (rules 1-9). Strategy refined during implementation: NO `ExprPlan::ImplicitIntersection` variant — every reachable case collapses to an existing ExprPlan shape, so the wrapper is dropped at bind. Mapping: rule 1 (scalar) → pass-through; rule 5 (single cell / `A1:A1`) → CellRef; rules 2/3 (single col/row range with anchor in span) → narrowed CellRef; rule 4 (2-D range) → `ExprPlan::Error(#VALUE!)`; rule 6 (WholeColumn/WholeRow) → narrowed CellRef (multi-col `A:C` → `#VALUE!`); rule 7 (array literal) → top-left literal; rule 8 (function) → bind inner as-is (scalar return passes through; array return is `#CALC!` per existing 4.7.G limit, known gap); rule 9 (StructuredRef) → bind via `resolve_structured_ref` then patch `is_this_row: true` so eval narrows to formula row (makes `@Sales[Qty]` ≡ `Sales[@Qty]`). Nested `@@expr` collapses at bind via recursion. New `BindError::ImplicitIntersectionRequiresAnchor` fires for range narrowing without `site.cell`. **AST round-trip preserved** — printer still emits `@<inner>` per W5-143; only the eval plan drops the wrapper. **Known gaps** documented for cell-boundary spill rewiring (4.9.L): rule 7 for function-returned arrays, full rule-8 narrowing of array-returning functions, named-range narrowing for `Range`-resolving names. |
| 9 | **4.9.I** (W5-145, shipped) | Persistence v6 → v7. `WORKBOOK_SCHEMA_VERSION = 7`. **Two-phase load** (closes Sonnet H-2): new `SchemaVersionProbe { schema_version: u32 }` deserializes first (no `deny_unknown_fields`); the version-range check runs BEFORE the full `WorkbookEnvelope` deserialization, so a vN reader rejects vN+1 files cleanly without `deny_unknown_fields` confusion. New v7 fields `reference_mode: Option<ReferenceModeWire>` + `locale: Option<LocaleWire>` use `#[serde(default, skip_serializing_if = "Option::is_none")]`; loader maps `None` → A1 / EnUs. **Custom `LocaleWire` deserializer** (closes Sonnet M-2): unknown strings deserialize to `LocaleWire::Unknown(captured_string)`; loader surfaces `QbookError::UnknownLocale { found }`. **Post-deserialize forward-compat assertion** (closes Codex HIGH-5): if `schema_version < 7` AND either v7 field is set, return new `QbookError::ForwardCompatFieldOnOldVersion { schema_version, field }`. **Save-side minimal-TOML**: default A1/EnUs writes neither field. |
| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
| 12 | **4.9.L** | Round-trip + edge cases: A1↔R1C1, EN↔DE, `@A:A`, `@1:1`, `@scalar`, `@function_result`, `Sheet1!@A1`, mixed-relativity rejection, `Sales[@Col]` vs `@Sales[Qty]` parser disambiguation |
| 13 | **4.9.M** | Coverage matrix tests — `(mode, locale, @-presence)` combinations |
| 14 | **4.9.N** | Polish + deferred-style edge cases |
| 15 | **4.9.O** | Closing megaudit (Codex + Sonnet parallel) |

16 sub-phases. 4.9.J + 4.9.K were previously inverted (Sonnet L-9 flagged); now ops land in J before IDE wiring in K.

## 6. Open questions — CLOSED per Codex + Sonnet pass-1

| Q | Closure |
|---|---|
| Q1 R1C1 tokenization | Option (a): new `Token::R1C1Ref` variant. Reuses `:` for range assembly. Codex + Sonnet agree. |
| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
| Q3 `@` precedence vs `[@Col]` | No ambiguity. Lexer absorbs internal `@` into `Token::StructuredRef`; top-level `@` is `Token::At`. Codex + Sonnet agree. |
| Q4 Function-name localization | OUT. OOXML stores English. Codex + Sonnet agree. |
| Q5 Locale data source | Hardcoded en/de/fr in Rust. CLDR deferred to known-gap doc. Codex + Sonnet agree. |
| Q6 Unknown locale forward-compat | Reject loudly via `QbookError::UnknownLocale`. Codex + Sonnet agree. |
| Q7 R1C1 in names + tables | Mode-agnostic. `NameRef` + `StructuredRef` pass through unchanged in R1C1 mode. Codex + Sonnet agree. |
| Q8 `Sheet1!@A1` | First-class in 4.9.G/H grammar production (NOT edge-case test). Codex + Sonnet agree. |

## 7. Compat with shipped phases

- **Phase 4.7 (arrays + spills)** — `@` is the Excel-365 explicit operator. Bare ranges in single-cell contexts spill (no implicit pre-365 fallback). Array literals' separator parameterization is in scope (Codex HIGH-4); v1 doesn't change array semantics.
- **Phase 4.8 (structured refs + tables)** — `@` inside `[@Col]` is a different production. Parser tests cover both paths in 4.9.L.
- **Persistence v6 → v7** — additive envelope fields + two-phase load. v6 reader rejects v7 via version check (not via `deny_unknown_fields`).

## 8. Out of scope (explicit fail-loud)

- R1C1 mixed-relativity range endpoints (`R[1]C:R10C5`) → `ParseError::R1C1MixedRelativity` (closes Sonnet M-equivalent).
- IDE mode/locale toggle UI. Engine-side support only.
- Sheet-scoped locale or R1C1 mode. Workbook-level only.
- Locale function-name translation (see § 2).

## 9. Stop conditions

- If 4.9.B token redesign cascades through the parser broadly, halt and re-design.
- If `@` disambiguation breaks 4.8.D structured-ref grammar, halt — regression non-negotiable.
- If two-phase persistence load breaks v6 round-trip, halt — backward compat non-negotiable.

## 10. Next step

**Ready for 4.9.A implementation.** Both Codex and Sonnet returned NEEDS-REVISION on the v1 draft; this revision applies all 8 HIGH + 8 MEDIUM findings. Closure-verify Codex pass on this revised doc is recommended before 4.9.A lands (mirror 4.7.AA's verify pattern).

Implementation prompt template: write `.codex/prompts/2026-05-15-phase-4.9-revised-design-verify.md` pointing at this doc + the closed open questions + the two original audit transcripts (`docs/audits/2026-05-15-phase-4.9-design-review-{codex,sonnet}.md`).
