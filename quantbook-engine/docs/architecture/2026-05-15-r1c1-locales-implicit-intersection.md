# Phase 4.9 — R1C1, Locales, Implicit Intersection

**Status:** 4.9.AA design draft, pre-Codex review. Mirrors the 4.7.AA / 4.8.AA pattern.

**Phase 4.8 SHIPPED at HEAD `403fabd286e` (W5-130).** This phase's design begins from a clean megaudit-verified base.

## 0. Mapping to product/master plans

Engine MASTER-PLAN.md § 4.9 lists Phase 4.9 as **R1C1, Localization, Implicit Intersection**. Acceptance criteria:

- **LOC-4-01** R1C1 parser/printer round-trips.
- **LOC-4-02** localized separators covered.
- **LOC-4-03** implicit intersection added where Excel requires it.
- **LOC-4-04** IDE can toggle formula display mode.

Effort estimate: 1-2 weeks (master plan).

## 1. Goals

Three orthogonal concerns share enough infrastructure (lexer mode parameter, workbook settings, printer surface) to merit a single phase:

1. **R1C1 reference syntax** as an alternative display + input mode. `R1C1`, `R[-1]C`, `R[1]C[2]:R3C[2]`. Toggleable per workbook (Excel canon). Storage canon remains A1 — R1C1 is parser+printer surface only.

2. **Locale-aware separators**. Argument separator (`,` en vs `;` de/fr), decimal separator (`.` en vs `,` de). Locale-toggleable per workbook. Storage canon remains EN — locale transforms at edit time.

3. **Implicit intersection operator `@`**. Excel-365 explicit form: `=@A1:A10` in cell `B5` narrows to `A5` (same row). Replaces the pre-365 implicit `=A1:A10` shrink-to-scalar legacy (which our engine intentionally doesn't have — spill takes its place per Phase 4.7).

## 2. Non-goals (deferred)

- **Function-name localization** (`SUMME` for `SUM` in de locale). Out of scope; canonical English-only function names. Deferred to a later polish wave if user demand emerges.
- **Pre-365 implicit intersection on bare ranges in single-cell contexts** (`=A1:A10` in `B5` → `A5`). Excel-365 replaced this with spill; we follow 365. Only the explicit `@` operator triggers implicit intersection.
- **Locale data beyond en / de / fr** in v1. Add more locales in a later wave once the parameterization is shipped.
- **R1C1 absolute/relative semantics in formulas typed into the IDE.** R1C1 is a display mode — when the user types `R[1]C` in cell `B5`, we parse it relative to `B5` and store as `A1`-relative (matching Excel's storage canon).

## 3. Spec primer

### 3.1 R1C1

- Absolute: `R1C1` → row 1, col 1 (== `A1`).
- Relative: `R[-1]C` → one row above current, same column. `R[2]C[3]` → 2 rows down, 3 cols right.
- Range: `R1C1:R10C5` → A1:E10.
- Mixed: `R[1]C1` → next row, column 1 (absolute col).

### 3.2 Locales

Locales we ship:
- `en` (English) — default, current behavior.
- `de` (German) — `;` arg separator, `,` decimal.
- `fr` (French) — `;` arg separator, `,` decimal.

Each locale carries: `arg_separator: char`, `decimal_separator: char`, `range_separator: char` (always `:`), `intersection_operator: char` (always `@`).

### 3.3 Implicit intersection

Excel 365 model:
- `=@RANGE` → narrow `RANGE` to a single cell using the formula's own row/col context.
- Rules (from IronCalc reference, validated by Excel canon):
  - If formula row is within RANGE's row span AND RANGE is a single column → pick that column at formula row.
  - If formula col is within RANGE's col span AND RANGE is a single row → pick that row at formula col.
  - If RANGE is a single cell → return that cell (idempotent).
  - Else → `#VALUE!`.

## 4. Data model changes

### 4.1 `ql-storage::Workbook` additions

```rust
pub enum ReferenceMode { A1, R1C1 }   // Phase 4.9.A
pub enum LocaleId { En, De, Fr }       // Phase 4.9.A

impl Workbook {
    pub fn reference_mode(&self) -> ReferenceMode;
    pub fn set_reference_mode(&mut self, mode: ReferenceMode);
    pub fn locale(&self) -> LocaleId;
    pub fn set_locale(&mut self, locale: LocaleId);
}
```

Defaults: `ReferenceMode::A1`, `LocaleId::En`. Workbook-level settings (not per-sheet). Mode/locale changes do NOT rewrite stored formulas — storage stays canonical (A1 + EN).

### 4.2 `ql-formula-syntax::ast`

NEW variant for implicit intersection:

```rust
pub enum Expr {
    // ... existing variants ...
    /// `@RANGE` — Excel-365 implicit intersection. Wraps a
    /// RangeRef-yielding expression; binder lowers to a single-cell
    /// `ExprPlan::CellRef` using `BindSite::owning_cell` for
    /// row/col context.
    ImplicitIntersection(Box<Expr>),
}
```

No AST changes for R1C1 (storage canon is A1) or locales (storage canon is EN). Both are surface-only.

### 4.3 `LexerMode` + `LexerLocale` parameters

Current `lex(text: &str) -> Result<Vec<Token>, LexError>`. Add overloads:

```rust
pub fn lex_with(
    text: &str,
    mode: ReferenceMode,
    locale: LocaleId,
) -> Result<Vec<Token>, LexError>;
```

`lex(text)` becomes `lex_with(text, ReferenceMode::A1, LocaleId::En)` for backward compat.

Same for `print(expr)` → `print_with(expr, mode, locale) -> String`.

## 5. Sub-phase split

Each sub-phase ships 1 commit + 7 gates green + self-audit. Codex pull-up at major milestones; closing megaudit at 4.9.O.

| # | Sub-phase | Subject |
|---|---|---|
| 0 | **4.9.AA** | This design doc + Codex review (doc only) |
| 1 | **4.9.A** | `Workbook::reference_mode` + `locale` accessors + `ReferenceMode` / `LocaleId` enums in ql-storage |
| 2 | **4.9.B** | Lexer R1C1 mode — accept `R1C1`, `R[-1]C`, `R[1]C[2]`, range forms. New `Token::R1C1Cell` / `R1C1Range` variants OR parameterize existing Cell/Range tokens by mode |
| 3 | **4.9.C** | Parser R1C1 — accepts R1C1 tokens, emits A1-canonical `Expr::CellRef` / `RangeRef`. Relative R1C1 (`R[-1]C`) needs owning-cell context; lift `BindSite` use to parse-time OR resolve at bind-time |
| 4 | **4.9.D** | Printer R1C1 — `print_with(expr, ReferenceMode::R1C1, ...)` emits R1C1 form. Round-trip: A1-stored → R1C1-printed → R1C1-lexed → A1-parsed → equality holds |
| 5 | **4.9.E** | Locale lexer — argument separator + decimal separator parameterization. Number-literal lex rules locale-dependent |
| 6 | **4.9.F** | Locale printer — emit with locale's separators |
| 7 | **4.9.G** | Implicit intersection lexer + parser — `@` as a unary prefix operator; `Expr::ImplicitIntersection(Box<Expr>)` wrapping a RangeRef expression. Disambiguate vs structured-ref `Sales[@Col]` (different parser context — inside `[`) |
| 8 | **4.9.H** | Implicit intersection binder + eval — `ExprPlan::ImplicitIntersection(Box<ExprPlan>)`; eval narrows RangeRef to single cell using `BindSite::owning_cell` per § 3.3 rules; OUT-OF-RANGE → `#VALUE!` |
| 9 | **4.9.I** | Persistence schema v6 → v7 — envelope fields `reference_mode: Option<ReferenceModeWire>`, `locale: Option<LocaleIdWire>`; absent → defaults (A1, En). v6 reader rejects v7 via existing range check. Formulas remain canonical-A1 + canonical-EN on disk |
| 10 | **4.9.J** | IDE integration — `WorkbookRuntime::set_reference_mode` / `set_locale` (op-log: `SetReferenceMode`, `SetLocale`); IDE reads to determine display + input mode |
| 11 | **4.9.K** | Op log + replay — new `Op` variants `SetReferenceMode`, `SetLocale`; replay arms apply to `Workbook::set_*` |
| 12 | **4.9.L** | Round-trip + edge cases — A1↔R1C1, EN↔DE locale, `@A1:A10` in various contexts, `Sales[@Col]` vs `=@SUM(...)` parser disambiguation |
| 13 | **4.9.M** | Coverage matrix tests — locale × mode × `@`-presence combinations |
| 14 | **4.9.N** | Polish + deferred-style edge cases (mirror 4.8.N as a polish-wave bucket) |
| 15 | **4.9.O** | Closing megaudit (Codex + Sonnet parallel) |

15 implementation sub-phases + 1 design = 16 total. Matches Phase 4.8 structure.

## 6. Open questions (need Codex pass-1 + user decisions)

These need resolution BEFORE 4.9.A:

1. **R1C1 tokenization** — option (a) new `Token::R1C1Cell` / `R1C1Range` variants vs option (b) reuse existing `Cell` / `Range` tokens but parameterize the lexer. (b) keeps the parser unchanged. Codex preference?

2. **Relative R1C1 resolution timing** — `R[-1]C` is relative to the formula's owning cell. Resolve at parse-time (parser needs owning-cell context, breaking parser purity) OR bind-time (parser emits a `Relative` marker the binder resolves). Phase 4.8.E shipped `BindSite` plumbing — bind-time resolution matches that pattern.

3. **`@` operator precedence + disambiguation** — `=@SUM(...)` (implicit intersection of function result) vs `=Sales[@Col]` (structured-ref `@`). The parser context matters: inside `[...]` of a structured ref, `@` means "this row"; outside, `@` means implicit intersection. How to teach the parser this without breaking the existing structured-ref escape rules from 4.8.D?

4. **Locale: function name translation** — IN or OUT? Master plan acceptance LOC-4-02 says "localized separators covered" — implying function names are NOT required. Confirm OUT-of-scope.

5. **Locale data source** — hardcode en/de/fr tables in Rust, OR pull from CLDR / ICU at build time. IronCalc uses a `locales.bin` blob (CLDR-derived). For v1 hardcoded is simpler.

6. **Persistence: forward-compat for locales** — if a future v8 adds `LocaleId::Ja`, current v7 reader sees an unknown locale string and... rejects? Falls back to En? Per CLAUDE.md "no fallbacks" — rejects loud.

7. **R1C1 in named ranges + table refs** — does `NamedRange("Rate")` print/lex differently in R1C1 mode? Probably not (names are mode-agnostic). What about `Sales[Qty]`? Likely also unchanged (table refs don't carry cell addresses). Confirm.

8. **`@` outside a formula context (e.g. `Sheet1!@A1`)** — Excel allows this; binder narrows after sheet resolution. Edge case; pin in 4.9.L.

## 7. Compat with shipped phases

- **Phase 4.7 (arrays + spills)** — implicit intersection (`@`) is the Excel-365 form. Bare ranges in single-cell contexts already spill per 4.7; we don't add a pre-365 implicit-intersection fallback. Codex 4.7.O closure-verified clean.
- **Phase 4.8 (structured refs + tables)** — the `@` inside `[@Col]` is a different production rule from `@`-prefix outside. Parser already handles `[@Col]` at the structured-ref sub-grammar level. The new `@`-prefix operator outside `[...]` is a new production. Parser tests need both paths.
- **Persistence v6 → v7** — additive (two optional envelope fields); v6 reader rejects v7 via existing schema-version range check.

## 8. Out of scope (explicit)

- R1C1 in cell-range syntax `R1C1:R10C5` parsing nuances around partial relative (`R[1]C:R10C5` — mixed relative/absolute endpoints). Phase 4.9 supports both fully-absolute and fully-relative range endpoints; mixed-relativity is a polish wave.
- IDE rendering of mode/locale toggle UI. Engine-side support only.
- Sheet-scoped locale (different locales per sheet). Workbook-level only.

## 9. Stop conditions

- If 4.9.B (lexer mode) requires deep token-set restructuring, halt and re-design.
- If `@` parser disambiguation against `[@Col]` breaks the 4.8 structured-ref grammar, halt — that's a regression we cannot ship.
- If persistence v7 breaks v6 round-trip, halt — backward compat is non-negotiable.

## 10. Next step

Dispatch Codex pass-1 review on this draft (mirrors 4.7.AA / 4.8.AA review pattern). Codex feedback drives a revision before 4.9.A.

Prompt template: `.codex/prompts/2026-05-15-phase-4.9-design-review.md` (to be written in fresh session — this doc itself is the scope of the review).
