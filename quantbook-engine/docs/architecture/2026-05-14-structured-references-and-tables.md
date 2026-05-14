# Engine Phase 4.8 — Structured References and Tables

**Status:** Design doc (sub-phase 4.8.AA / W5-109). Pre-implementation. **Codex review pass 1 closed 2026-05-14 (7 HIGH + 8 MEDIUM + 4 LOW); revisions inline below.**
**Authored:** Claude Opus 4.7, 2026-05-14
**Predecessor:** Phase 4.7 (array formulas + dynamic spills) shipped + closure-verified clean at HEAD `f00cb321e33`.
**References:** `.references/ironcalc/base/src/expressions/lexer/structured_references.rs`; `.references/ironcalc/base/src/expressions/parser/tests/test_tables.rs`; `.references/ironcalc/base/src/types.rs` (Table); `.references/formualizer/crates/formualizer-parse/src/structured_ref.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/tables.rs`; `.references/formualizer/tests/corpus/tables/structured_refs_pending/`.

## 0. Mapping to product/master plans

Master plan §4.8: "Add table metadata to storage, parser/binder support for `Table[Column]`, totals/special specifiers, and graph dependencies for table ranges. Acceptance: TBL-4-01 table refs parse/print; TBL-4-02 column insert/delete updates refs; TBL-4-03 table aggregate dependencies use range graph; TBL-4-04 xlsx import creates tables." Effort: 1-2 weeks.

This doc covers TBL-4-01 through TBL-4-03. **TBL-4-04 (xlsx import creates tables)** lives in Phase 4.11 (xlsx I/O); 4.8 ships table create/edit/destroy through the engine API + op log, and 4.11 lights up xlsx round-trip.

## 1. Goals

1. **Table metadata** — workbook-level table registry: name, range, column headers, totals row presence. Mirrors the existing `NameTable` pattern (Phase 2A.1).
2. **Structured-reference lexer + parser** — `Table[Col]`, `Table[[#Headers], [Col]]`, `Table[[Col1]:[Col2]]`, `Table[[#This Row], [Col]]`, `[@Col]` (inside table rows). 5 special-row specifiers: `#All`, `#Headers`, `#Data`, `#Totals`, `#This Row`.
3. **Binder** — resolve `StructuredRef` to a concrete `RangeRef` using current table metadata. `[@Col]` is bind-time resolved relative to the owning formula's cell address.
4. **Calcgraph deps** — table refs register as range deps (existing stripe machinery from Phase 3). Edits inside a table dirty all dependents through the same path as a literal range ref.
5. **Mutation API** — `WorkbookRuntime::create_table`, `rename_table`, `rename_column`, `resize_table`, `drop_table`. Each emits a corresponding op-log entry.
6. **Op log + persistence** — new `Op::CreateTable / RenameTable / RenameColumn / ResizeTable / DropTable` variants. `.qbook` schema bump (v5 → v6) to persist `TableTable` alongside `NameTable`.
7. **Function library** — `SUM(Table[Col])`, `AVERAGE(Table[Col])`, `COUNT(Table[Col])` etc. work via the existing range-aware aggregate path. No new function entries needed — the structured ref resolves to a range before the function sees it.

## 2. Non-goals (deferred)

- **`Table[Col]` outside the workbook's own sheets** (cross-workbook). Phase 4.11+ if it ever lands.
- **3D table refs** (across sheets). Excel canonical syntax is fuzzy here; defer.
- **Calculated columns** (`=[@Price] * [@Qty]` in a table column propagating to every row automatically). Phase 4.10 / function library wave 2.
- **Totals-row auto-functions** (the per-column `totals_row_function: SUM | AVERAGE | ...`). 4.8 stores the metadata but does NOT auto-populate the totals row's formulas; users write them. Auto-population is Phase 4.10.
- **Slicers / filtered ranges**. Phase 5+.
- **xlsx round-trip** of `<table>` XML. Phase 4.11 (XLSX I/O).
- **Column insert/delete that rewrites STORAGE** (move cells). 4.8 manipulates the table's column roster + range; it does not insert/delete physical workbook columns. That's a Phase 5 "structural edit" operation.
- **R1C1-style refs to tables**. Phase 4.9.

## 3. Spec primer (Excel canon)

Given a table `Sales` at A1:D10 with header row at A1:D1 = `[Region, Product, Qty, Price]` and a totals row at A10:D10:

| Syntax | Resolves to | Notes |
|---|---|---|
| `Sales[Qty]` | C2:C9 | Data-only by default; excludes header + totals. |
| `Sales[[#Data], [Qty]]` | C2:C9 | Explicit form of the default. |
| `Sales[[#Headers], [Qty]]` | C1 | Just the header cell. |
| `Sales[[#Totals], [Qty]]` | C10 | Just the totals cell. |
| `Sales[[#All]]` | A1:D10 | Entire range including header + totals. |
| `Sales[[#Headers]]` | A1:D1 | Header row only (all columns). |
| `Sales[[#Totals]]` | A10:D10 | Totals row only. |
| `Sales[[#Data]]` | A2:D9 | Data region only (all columns). |
| `Sales[[Qty]:[Price]]` | C2:D9 | Column range; data-only. |
| `Sales[[#Headers], [Qty]:[Price]]` | C1:D1 | Combination: specifier + column range. |
| `Sales[[#This Row], [Qty]]` | only valid for formulas INSIDE the table; resolves to the Qty cell on the formula's own row. | |
| `[@Qty]` | same as `Sales[[#This Row], [Qty]]` when formula is in `Sales`. | Bare-`@` shorthand only inside table. |

**Edge cases:**
- Tables WITHOUT a totals row: `Sales[[#Totals]]` → `#REF!`.
- Tables WITHOUT a header row: `Sales[[#Headers]]` → `#REF!`. Default `Sales[Qty]` still works if columns have implicit Column1/Column2/... names.
- Empty data range (header-only table): `Sales[[#Data]]` is a degenerate 0-row range; Phase 4.7 semantics map degenerate to `#CALC!` in scalar context, or accept as empty in aggregate context (consistent with our existing range handling).

## 4. Data model

### 4.1 `TableMetadata` (in `ql-storage`)

```rust
pub struct TableMetadata {
    /// Canonical name (uppercase). Mirrors NameTable's canonicalization.
    name: Arc<str>,
    /// Display name (case-preserving). Optional; defaults to `name`.
    display_name: Arc<str>,
    /// Anchor range. Top-left cell + dimensions (rows × cols). NOT a
    /// `Range` because we need to track header + totals row presence
    /// as distinct fields; `Range` is "any rectangle" which loses
    /// semantic structure.
    sheet: SheetId,
    top_row: RowId,
    top_col: ColId,
    rows: u32,  // total rows INCLUDING header + totals
    cols: u32,
    /// Header row present at `top_row` if true. (Header is the FIRST row.)
    has_header: bool,
    /// Totals row present at `top_row + rows - 1` if true. (Last row.)
    has_totals: bool,
    /// Ordered list of columns. Length == `cols`. Canonical name is
    /// lowercase; display preserves case; column_id is a stable
    /// per-column u32 that persists across renames within the table
    /// (allocated monotonically; never reused). totals_function is
    /// metadata for Phase 4.10 auto-populate (4.8 stores only).
    columns: Vec<TableColumn>,
}

pub struct TableColumn {
    /// Stable id, monotonically allocated. NOT the index in `columns` —
    /// removing a column does NOT renumber subsequent ids.
    id: u32,
    /// Lowercase canonical name.
    name: Arc<str>,
    /// Case-preserving display name.
    display: Arc<str>,
    /// Phase 4.10 will auto-populate the totals row when this is Some;
    /// 4.8 just stores the metadata.
    totals_function: Option<TotalsFunction>,
}

pub enum TotalsFunction {
    None,
    Average,
    Count,
    CountNums,
    Max,
    Min,
    StdDev,
    Sum,
    Variance,
    Custom,  // user-typed formula in the totals row
}
```

**Stable column ID** decision: post-Codex MEDIUM-1. The id field enables future formula-text-rewrite-on-column-rename to disambiguate columns even when names collide ephemerally (e.g., rename A→B while B exists). 4.8 doesn't load-bear on the id beyond serialization; later phases (4.10 calculated columns, Phase 5 column move) consume it.

**Data-range computation** (helper methods):
- `header_range()` — `(top_row, top_col)..(top_row, top_col+cols-1)` if `has_header` else None.
- `totals_range()` — bottom row if `has_totals` else None.
- `data_range()` — rows excluding header + totals.
- `all_range()` — entire footprint.
- `column_data_range(col_idx)` — single column's data rows.

These are stateless functions over `TableMetadata`; no separate cache.

### 4.2 `TableTable` (storage container)

Mirrors `NameTable`:

```rust
pub struct TableTable {
    tables: HashMap<Arc<str>, TableMetadata>,
    /// Generation counter for invalidation (parallels `NameTable::generation`).
    generation: u64,
}
```

Mounted on `Workbook` alongside `names`:

```rust
pub struct Workbook {
    sheets: Vec<Sheet>,
    names: NameTable,
    tables: TableTable,  // NEW
    spill_anchors: SpillAnchorTable,
    formats: FormatTable,
}
```

### 4.3 Invariants

1. **Names + tables share a flat namespace.** A name `Sales` and a table `Sales` cannot coexist (Excel canon: defined names + table names live in one namespace). Validation hook at create-time.
2. **Column names within a table are unique** (case-insensitive). Excel requires this; if loaded data violates it, columns get auto-disambiguated as `Col1`, `Col2`, ... at load time.
3. **Table footprint cannot overlap another table's footprint.** Validated at create / resize time.
4. **Table footprint can overlap user-overlay cells.** Inserting a table over existing data is fine; the user's values remain visible but are now interpreted via table semantics for `Table[Col]` refs.
5. **Tables block ALL spill anchors inside their footprint** — REVISED post-Codex (HIGH-3). Original draft allowed within-table spills if they fit; Excel canon DOES NOT allow array formulas inside Tables. `=SEQUENCE(3)` typed into ANY cell inside a table footprint produces `#SPILL!` at the anchor (even if the resulting array would fit). Scalar formulas inside tables remain allowed. Validation: `write_spill` consults `Workbook::table_at(anchor)` before registering; a Some-result blocks.

### 4.4 `TableId` vs `Arc<str>` names — REVISED post-Codex (HIGH-1)

Decision: use `Arc<str>` (uppercase canonical) as the primary key, matching `NameTable`. A separate `TableId(u32)` is tempting for the graph (stable across renames) but adds complexity. **Renames REWRITE formula text** (Excel canon, see § 12.2). The plan-cache-invalidation alternative (the original draft's approach) was broken: cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence. Rewrite-on-rename is the simpler correct path.

**Defer numeric IDs to a future polish wave** if formula-text rewrite ever proves too expensive at scale.

### 4.5 Table-to-formulas dep index — NEW post-Codex (HIGH-2)

Mirrors `name_to_formulas` (existing in `CalcgraphSession`). Every formula's `extract_and_register_deps` pass discovers `StructuredRef` references and registers them in `table_to_formulas: HashMap<Arc<str>, HashSet<NodeId>>`. The runtime fires `on_table_create / on_table_rename / on_column_rename / on_table_resize / on_table_drop` hooks against this index when table metadata mutates. These hooks dirty the indexed formulas + transitively propagate dirty downstream (matching the W5-91 / `on_set_name` BFS fanout pattern). Without this index, `resize_table` growth would NOT dirty formulas reading the new rows.

## 5. Lexer changes

### 5.1 New token — REVISED post-Codex (HIGH-5) + post-4.8.D-impl

```rust
Token::StructuredRef {
    table_name: Arc<str>,         // case-preserving
    /// Bracket content preserving OOXML `'`-prefix escapes. The lexer
    /// uses escape-aware bracket balancing (an escaped `]` doesn't
    /// close the bracket), but it preserves the `'` markers in the
    /// output so the parser can distinguish syntactic from literal
    /// occurrences of `[`, `]`, `#`, `@`, `'`. Without this, the parser
    /// cannot tell `Tbl['[a]` (BareColumn named `[a`) from `Tbl[[a]]`
    /// (Combination of Column `a`) — both would yield the same
    /// unescaped string `[a]`.
    bracket_content: Arc<str>,
}
```

`bracket_content` retains the `'` escape markers; the parser's structured-ref sub-grammar (§ 6.3) resolves them as it walks. The original design draft proposed full unescape at lex time — 4.8.D implementation surfaced the ambiguity; design pivoted to preserve-escapes.

### 5.4 Bracket escape rules — NEW post-Codex (HIGH-5)

Per OOXML / Excel structured-reference grammar, the bracket content has 5 escape-prefixed characters:

| Source | Resolves to |
|---|---|
| `'[` | literal `[` in identifier (e.g., column name with `[`) |
| `']` | literal `]` |
| `'#` | literal `#` (so a column literally named `#Foo` stays distinct from `#Foo` specifier) |
| `'@` | literal `@` |
| `''` | literal `'` |

A naive bracket balancer would mis-nest on `Table[[Header'[X']]]` (a table whose column is named `Header[X]`). The lexer must consume the escape pair as a single character.

The lexer's bracket-balancer pseudocode:
```
content = ""
depth = 1            // we've consumed the opening [
while depth > 0:
    c = next char
    if c == "'":
        c2 = next char (must exist or LexError::UnterminatedStructuredRef)
        content.push(c2)  // unescape: consume the pair as just c2
    elif c == "[":
        depth += 1
        content.push(c)
    elif c == "]":
        depth -= 1
        if depth > 0: content.push(c)
    else:
        content.push(c)
emit Token::StructuredRef { table_name, bracket_content: content }
```

Test surface: headers containing `[`, `]`, `#`, `@`, and `'`.

### 5.2 Recognition rule — REVISED post-Codex (MEDIUM-2, MEDIUM-3)

After lexing an Ident, peek for `[`. If present, consume the bracket-balanced content (per § 5.4 escape rules) and emit `Token::StructuredRef`. **No function-name exclusion at the lexer level**: `SUM[Qty]` lexes as a structured ref (functions distinguish by `(`, not `[`); table-name validity is enforced by `create_table` (§ 12.1 + § 5.3).

**Bare-column collision (Phase 4.7.N gap #148):** an Ident that matches a column letter pattern (`A`, `XFD`, etc.) lexes as `BareColumn` BEFORE checking for `[`. To resolve `Src[Col]` correctly, Ident classification must check for `[` lookahead FIRST, then fall back to BareColumn. **This is the close-out for #148** — Phase 4.8 lexer changes pre-empt the bare-column shadowing trap.

### 5.3 Table-name validity — NEW post-Codex (MEDIUM-3)

Excel table-name rules (enforced at `create_table` validation, NOT at the lexer):

- Length ≥ 1, ≤ 255 (Excel limit).
- Starts with letter, `_`, or backslash. Subsequent chars: letters, digits, `_`, `.`, `?`.
- **NOT a cell reference pattern**: `A1`, `XFD1048576`, `R1C1`, `$A$1`, etc. — would shadow regular refs.
- **NOT a column-letter pattern**: `A`, `XFD`, `BB`, ... (1–3 letters that lex as `BareColumn`). Excel rejects these for tables.
- **NOT a reserved word**: `TRUE`, `FALSE`, `Print_Area`, `Print_Titles`, etc.
- Unique case-insensitively across both `NameTable` AND `TableTable` (shared namespace; § 4.3 invariant #1).

`A[0]` will lex as `Token::StructuredRef { table_name: "A", bracket_content: "0" }`. `create_table("A", ...)` will REJECT the name. So `A[0]` would emit `BindError::UnknownTable("A")` — which is acceptable: no table named `A` can exist. The lexer doesn't reject; the binder surfaces a precise error.

### 5.3 Tokens NOT introduced

- `#Headers`, `#All`, etc. — these are bracket-content tokens, parsed by the spec sub-grammar, not lexer-level tokens.
- `@` — bracket-content only (inside `[@Col]`). The lexer treats `@` outside `[]` as a syntax error (Phase 4.9 implicit-intersection might reclaim it).

## 6. Parser + AST representation

### 6.1 `Expr::StructuredRef`

```rust
Expr::StructuredRef {
    table_name: Arc<str>,
    spec: TableSpecSubtree,
}
```

### 6.2 `TableSpecSubtree` — REVISED post-Codex (HIGH-4)

Original draft used a fixed enum with `SpecialColumn(item, col)`-style flat variants. Excel allows arbitrary multi-item combinations: `Table[[#Data],[#Totals],[Col]]`, `Table[[#Headers],[Col1],[Col2]]`, etc. Formualizer's `Combination(Vec<...>)` is the right representation; we adopt it.

```rust
pub enum TableSpecItem {
    /// `#All`, `#Headers`, `#Data`, `#Totals`, `#This Row`.
    Special(SpecialItem),
    /// `[Col]` — single column.
    Column(Arc<str>),
    /// `[Col1]:[Col2]` — column range (order-independent).
    ColumnRange(Arc<str>, Arc<str>),
}

pub enum SpecialItem {
    Headers,
    Totals,
    Data,
    All,
    ThisRow,
}

pub enum TableSpecSubtree {
    /// `Table[Col]` — bare column shorthand. Single-item, no bracket pair.
    /// Parser normalizes to `Combination(vec![Column(col)])` at bind time;
    /// kept distinct here for printer round-trip.
    BareColumn(Arc<str>),
    /// `Table[[Col]]`, `Table[[#Headers]]`, `Table[[#Data], [Col]:[Col2]]`,
    /// etc. The vec carries items in source order; the binder normalizes.
    Combination(Vec<TableSpecItem>),
    /// `[@Col]` shorthand — current row, single column. Distinct from
    /// `Combination(vec![Special(ThisRow), Column(col)])` because the
    /// `@`-form has different printer canon. Resolution requires the
    /// binder to know the formula's cell address.
    ThisRowColumn(Arc<str>),
    /// `[@[Col1]:[Col2]]` shorthand.
    ThisRowColumnRange(Arc<str>, Arc<str>),
}
```

**Normalization at bind time:** the binder collapses `Combination` items to a single `RowSelector` (which rows are addressed) + a `ColumnSelector` (which columns are addressed), then intersects them to produce a `Range`. Multiple `Special` items combine as set-union over rows (e.g., `[#Headers],[#Data]` = headers ∪ data rows). Multiple `Column` items combine as ordered list of columns (which the binder validates as adjacent, since structured refs can't express a "gappy" range — Excel canon).

**`ThisRow` in `Combination` vs `ThisRowColumn`:** `Table[[#This Row], [Col]]` parses to `Combination(vec![Special(ThisRow), Column(col)])`; `[@Col]` parses to `ThisRowColumn(col)`. Both bind to the same resolved single cell, but printer round-trip preserves the source syntax.

### 6.3 `Expr::StructuredRef` parsing path

The parser maintains a small recursive-descent sub-grammar over `bracket_content`:

```
spec        := "[" inner "]" | bare-col
inner       := special "," column_or_range
            | special
            | column_or_range
            | "@" column_or_range          (shorthand)
special     := "#Headers" | "#Totals" | "#Data" | "#All" | "#This Row"
column_or_range := "[" col "]" (":" "[" col "]")?
                 | col (":" col)?
bare-col    := col  // when bracket_content is just "Col"
```

Result is a `TableSpecSubtree`. Errors surface as `ParseError::StructuredRefMalformed { table_name, bracket_content, reason }`.

### 6.4 Printer (round-trip)

`Expr::StructuredRef` prints back to canonical form: `Sales[Qty]`, `Sales[[#Headers], [Qty]]`, etc. The printer uses the `display_name` form of the table name if available (round-trip preserves case via the workbook's TableTable lookup).

## 7. Binder changes

### 7.1 `ExprPlan::StructuredRef`

The binder resolves `Expr::StructuredRef` to a concrete `RangeRef` (or `Address` for single-cell cases like `Sales[[#Headers], [Qty]]` resolving to a 1×1 region).

```rust
ExprPlan::StructuredRef {
    /// The original parsed reference (for printer, error msgs).
    source: Arc<TableSpecSubtree>,
    /// The resolved range. For `Sales[[#Headers], [Qty]]` this is C1:C1.
    /// For `Sales[[Qty]:[Price]]` this is C2:D9.
    resolved: Range,
    /// True if this was a `[@Col]` form that resolved relative to the
    /// formula's own cell. Used by the dep extractor to register a
    /// single-cell dep instead of a range stripe.
    is_this_row: bool,
}
```

**Why carry the source spec:** error messages, printer round-trip, and the ability to re-bind on table mutation (`name_gen`-style invalidation).

### 7.2 Resolution rules

For `Expr::StructuredRef { table_name, spec }`:

1. **Lookup** the table in `Workbook::tables` by case-insensitive `table_name`. Missing → `BindError::UnknownTable(table_name)`.
2. **Decompose** `spec` against the table's metadata:
   - `Column(col)` → look up column index by `col`. Missing → `BindError::UnknownTableColumn { table, col }`. Resolve to the column's data range.
   - `ColumnRange(c1, c2)` → both columns must exist; resolve to the union of data-range columns. Order-independent (Excel canon).
   - `SpecialAll(Headers)` → header range (if `has_header` else error).
   - `SpecialAll(Totals)` → totals range (if `has_totals` else error).
   - `SpecialAll(Data)` → data range (rows excluding header + totals).
   - `SpecialAll(All)` → full table footprint.
   - `SpecialColumn(item, col)` → intersection of special row(s) + named column.
   - `ThisRowColumn(col)` — requires bind context to know the formula's cell address. If the formula's cell IS inside the table's data region, resolve to the single cell at `(formula_row, col_offset)`. Otherwise → `BindError::ThisRowOutsideTable`.

3. **Error variants** (new):
   - `BindError::UnknownTable(Arc<str>)`
   - `BindError::UnknownTableColumn { table, column }`
   - `BindError::TableHasNoHeader(Arc<str>)`
   - `BindError::TableHasNoTotals(Arc<str>)`
   - `BindError::ThisRowOutsideTable { table, formula_cell }`
   - `BindError::StructuredRefDegenerateRange(Arc<str>)` (e.g., `#Data` on a header-only table)

### 7.3 Context plumbing — REVISED post-Codex (MEDIUM-4)

The binder already takes `owning_sheet: SheetId` for resolving `Expr::CellRef`. Phase 4.8 introduces a `BindSite` struct to bundle context:

```rust
pub struct BindSite {
    pub sheet: SheetId,
    /// The full cell address of the formula being bound. Required
    /// for `ThisRowColumn` resolution. `None` allowed for dry-run
    /// parse+bind (syntax validation, plan-cache pre-warm, etc.);
    /// `ThisRowColumn` binds with `cell: None` surface
    /// `BindError::ThisRowRequiresOwningCell`.
    pub cell: Option<Address>,
}
```

Every call site of `bind_with_names_and_sheets` updates to take `&BindSite`. Call sites and the cell they should supply:
- `WorkbookRuntime::set_formula(sheet, row, col, text)` → `cell: Some(Address)`.
- `WorkbookRuntime::recompute_dirty / recompute_all` → reuse the formula's own cell address (always known).
- `WorkbookRuntime::validate_formula(sheet, row, col, text)` → `cell: Some(Address)`.
- `CalcgraphSession::bind_text` (used by `rebuild_from_workbook`) → `cell: Some(Address)` from the formula's location.
- `CalcgraphSession::reextract_deps` → `cell: Some(Address)` from the reader node's location.
- Pure syntax tests / parse fuzzers → `cell: None`.

This is a multi-call-site change but mechanical. Sub-phase 4.8.E does the plumbing.

### 7.4 Error-to-value mapping — NEW post-Codex (HIGH-7)

Current bind failures surface as `RuntimeError::Bind(BindError)` from `set_formula`, which REJECTS the call. For recompute paths, the formula's cell value is left unchanged (W5-103 contract). This is too strict for table refs: a user typing `=SUM(Sales[Qty])` BEFORE `Sales` exists should land an error cell value, not refuse the formula.

**Decision:** `set_formula` retains its REJECT-on-bind-error contract for SYNTACTIC errors (lex/parse). For SEMANTIC bind errors arising from table refs (unknown table, unknown column, this-row outside table, etc.), the formula text is ACCEPTED, the cell stores `Value::Error(...)`, and a future bind retry can succeed once the table exists.

Mapping table:

| `BindError` variant | Cell value at anchor |
|---|---|
| `UnknownTable` | `Value::Error(#NAME?)` |
| `UnknownTableColumn` | `Value::Error(#REF!)` |
| `TableHasNoHeader` | `Value::Error(#REF!)` |
| `TableHasNoTotals` | `Value::Error(#REF!)` |
| `ThisRowOutsideTable` | `Value::Error(#VALUE!)` |
| `ThisRowRequiresOwningCell` | (internal — never reaches cell value) |
| `StructuredRefDegenerateRange` | `Value::Error(#CALC!)` (consistent with 4.7) |

Implementation: introduce a `BindError::is_table_related(&self) -> bool` and route table-related bind errors through a soft-fail path in `set_formula`. Recompute path naturally re-binds via plan cache invalidation when the table appears, so `on_table_create` dirties the formula and the next eval succeeds.

### 7.5 Plan cache invalidation — REVISED post-Codex (HIGH-1 spillover)

The original draft proposed a `table_gen: u64` field in `PlanCacheKey`. Per HIGH-1 closure (§ 12.2 — formula text is rewritten on rename), `table_gen` is no longer needed for renames. It IS needed for non-rename mutations: `resize_table` (range changes; cached plans hold the OLD resolved range), `column_rename` (column index changes), `drop_table` (cached plans hold a now-invalid range). Add `table_gen` for these cases:

```rust
struct PlanCacheKey {
    text: Arc<str>,
    sheet: SheetId,
    name_gen: u64,
    table_gen: u64,  // NEW
}
```

Mutations that bump `table_gen`: resize, column_rename, drop. (Create + rename rewrite formula text → text-keyed cache misses anyway.) `table_gen` bumps PLUS `on_table_*` dirty-propagation hooks together ensure dependent formulas re-evaluate against the new metadata.

## 8. Calcgraph dep extraction

### 8.1 Table refs register as range deps

`ExprPlan::StructuredRef { resolved, .. }` walks identically to `ExprPlan::AggregateNameRef`: the `resolved` `Range` is registered as a range dep via `range_to_rangeref` + `register_range_dependency` (existing 4.6 stripe machinery).

**Decision: no dedicated `VertexKind::Table` graph vertex.** Formualizer creates a per-table vertex; IronCalc treats it as a regular range. We follow IronCalc: a table ref is just a range ref, period. The cell-edits-inside-table → dependent-formula propagation already works through the stripe index. A per-table vertex would add a layer of indirection for no clear correctness win.

**Trade-off:** When a table is renamed or columns reshuffled, every formula referencing it must re-extract. With a dedicated vertex, only the vertex's range mapping changes. Our approach uses `table_gen` to invalidate the plan cache and re-bind on next eval — same end-state, simpler graph.

### 8.2 `[@Col]` `ThisRowColumn` deps — REVISED post-Codex (MEDIUM-5)

The `is_this_row: bool` flag in `ExprPlan::StructuredRef` lets the dep extractor register a single CELL dep (not a range stripe), matching the runtime semantic of `@Col` resolving to a specific cell. Different from `Table[Col]` which is a column-wide range dep.

**Walker behavior** (`walk_plan_for_deps` in `calcgraph_session.rs`) — NEW match arm:

```rust
ExprPlan::StructuredRef { resolved, is_this_row, table_name, .. } => {
    if is_this_row {
        // Single cell dep — the resolved Range is 1x1.
        let (s, r, c) = resolved.top_left();
        deps.cells.push((s, r, c));
    } else {
        // Range dep via stripe index (matches AggregateNameRef).
        deps.range_refs.push(*resolved);
    }
    // Always register the table name dep so on_table_* hooks find us.
    deps.tables.push(Arc::clone(table_name));
}
```

`deps.tables: Vec<Arc<str>>` is NEW; populated alongside `deps.cells` / `deps.range_refs` / `deps.named_ranges`. Registered in `CalcgraphSession::table_to_formulas` (§ 4.5) at dep-extraction time.

### 8.3 Producer-alias rewrite interaction (4.7.I)

### 8.4 Producer-alias rewrite interaction (4.7.I)

If a `Table[Col]` resolves to a range that overlaps a spill footprint, the producer-alias rewrite (Phase 4.7.I) applies cell-by-cell. The same `spill_target_anchor` lookup runs for each cell in the resolved range. This is automatic — the resolved range goes through `walk_plan_for_deps` like any other range.

In practice this is a narrow case (per § 4.3 invariant #5, tables BLOCK spill anchors inside their footprint, so the overlap scenario is "table data feeds a SUM that gets spilled into ELSEWHERE"). The rewrite stays general.

## 9. Storage layout

### 9.1 `Workbook::tables` (new)

```rust
impl Workbook {
    pub fn tables(&self) -> &TableTable;
    pub fn tables_mut(&mut self) -> &mut TableTable;
    pub fn lookup_table(&self, name: &str) -> Option<&TableMetadata>;
    pub fn table_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&TableMetadata>;
}
```

`table_at` is the reverse lookup: "is this cell inside any table's footprint?" — needed by the binder for `[@Col]` resolution and by validation hooks (table footprints can't overlap).

### 9.2 No new graph state

Tables don't touch `SpillAnchorTable` or the calcgraph's stripe index directly. They're a binder-level concept.

## 10. Op log + persistence

### 10.1 New `Op` variants

```rust
pub enum Op {
    // ... existing variants ...

    /// Create a table at the given range.
    CreateTable {
        name: String,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    },
    /// Rename a table.
    RenameTable { old_name: String, new_name: String },
    /// Rename a column within a table.
    RenameColumn {
        table: String,
        old_col: String,
        new_col: String,
    },
    /// Resize a table (e.g., to include newly-added data rows).
    ResizeTable {
        name: String,
        new_rows: u32,
        new_cols: u32,
        // Column additions / removals are recorded as
        // explicit Vec deltas to keep replay deterministic.
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    },
    /// Drop a table (metadata only — cells are untouched).
    DropTable { name: String },
}
```

### 10.2 Replay semantics

- `CreateTable` calls `Workbook::tables_mut().create(...)`.
- `RenameTable` / `RenameColumn` / `ResizeTable` mutate the existing entry.
- `DropTable` removes the entry.

Replay validates each op against current state; collisions (e.g., `CreateTable` for a name that already exists) surface as `ReplayError::TableCollision` (no silent overwrite). Op log atomicity per the Phase 4.7.J HIGH-3 pattern: append BEFORE mutation; failed append leaves workbook unchanged.

### 10.3 `.qbook` schema bump v5 → v6 — REVISED post-Codex (MEDIUM-7)

The 4.7 wave kept the schema at v5 (the save-side spill-target skip was behavioral). Adding `TableTable` persistence requires v6.

```
schema v6:
  + tables: Vec<TableMetadataRecord>
```

**Backward compat (forward-vs-back, per Codex):**
- **v6 reader loading v1–v5 file**: tables field absent → `TableTable::default()` (empty). Safe.
- **v5 reader loading v6 file**: the existing reader bound `v4..=WORKBOOK_SCHEMA_VERSION` REFUSES v6. **This is correct**: silently dropping table metadata would break formulas (a formula referencing `Sales[Qty]` would surface `BindError::UnknownTable` after load → cell renders `#NAME?` when pre-save it was a valid SUM). Loud refusal preserves semantic integrity.
- **v6 reader writing v5-compat**: not supported in 4.8. If the file is read by a v5-only reader, it fails loud. (Downgrade-on-save would be a Phase 5 export option.)

### 10.4 `MIN_SUPPORTED_SCHEMA_VERSION`

Stays at 4 (v6 writer + v4/v5/v6 reader for read; write always v6).

## 11. Function library interactions

No new function entries. The binder resolves `SUM(Table[Col])` to `SUM(<resolved range>)`, which then routes through the existing `is_aggregate_function("SUM")` + range-aware dispatch path (Phase 4.3 V2 / W5-53).

The plan cache stores both the resolved range AND the `table_gen` it was bound under. A column rename bumps `table_gen` → next bind re-resolves through the new column-name map.

### 11.1 `is_aggregate_function` extension

Tables can land as args to any function. The structured ref resolves to a `Range` BEFORE the binder decides arg context, so no changes to `is_aggregate_function` are needed — the resolution is upstream of the matcher.

**Exception:** `[@Col]` resolves to a single cell. Functions that expect a range (e.g., `INDEX(Table[Col], row, col)`) get a 1×1 range when fed `[@Col]` — same as any literal cell ref upgraded to a range. The aggregate path handles this trivially.

## 12. Mutation semantics

### 12.1 `WorkbookRuntime::create_table`

```rust
pub fn create_table(
    &mut self,
    name: String,
    sheet: SheetId,
    top_row: RowId,
    top_col: ColId,
    rows: u32,
    cols: u32,
    has_header: bool,
    has_totals: bool,
    column_names: Vec<String>,
) -> Result<(), RuntimeError>;
```

Validates:
- Name not already taken (TableTable AND NameTable — shared namespace).
- Footprint doesn't overlap another table.
- Footprint fits in the sheet (validate_range pattern from Phase 2A.7).
- Column count matches `cols`.
- Column names unique within the table (case-insensitive).
- Column names are non-empty.

Emits `Op::CreateTable`. Bumps `TableTable::generation`.

### 12.2 `rename_table` / `rename_column` — REVISED post-Codex (HIGH-1)

**Formula text IS rewritten on rename** (Excel canon). The original draft proposed plan-cache invalidation + no rewrite — Codex correctly noted that cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence.

**Implementation flow** for `rename_table(old, new)`:
1. Validate: `new` is a valid table name (§ 5.3), not already taken in NameTable or TableTable.
2. Op log append `Op::RenameTable { old, new }` (before any mutation; W5-103 atomicity pattern).
3. Walk every formula in `table_to_formulas[old]` (the dep index from § 4.5):
   - Rewrite formula text via `ql-formula-syntax::ast::rewrite_table_ref(old, new)` — produces new text.
   - `Workbook::put_formula(sheet, row, col, new_text)`.
   - Mark the cell dirty in `CalcgraphSession`.
4. Update `TableTable`: rekey from `old` to `new`.
5. Update `table_to_formulas[new] = table_to_formulas.remove(old)`.

`rename_column` follows the same pattern but rewrites column references INSIDE bracket content rather than the table name itself.

**ast::rewrite_table_ref** is a tree-walk pass (mirrors `rewrite_sheet_ref` from Phase 4.6 sheet rename). Phase 4.6 already established this pattern; we extend it for `Expr::StructuredRef`.

**Cells with formula text referencing tables that didn't exist at bind time** are listed in a `pending_table_refs: HashSet<(Arc<str>, NodeId)>` map (populated when bind surfaces `UnknownTable`). `on_table_create` queries this map + dirties the matching formulas so the next eval re-binds with the new table in scope.

### 12.3 `resize_table` — REVISED post-Codex (LOW-3, HIGH-2)

Three scenarios:
- **Grow rows:** common case (user added rows below the table). Update `rows`. Bump `table_gen`. Walk `table_to_formulas[name]` and mark every dependent dirty so they re-extract against the new range.
- **Add column at end:** append a column to the roster. Same dirty/re-extract pass. Allocates a new `column_id`.
- **Remove last column:** truncate the roster. Same dirty/re-extract pass. `ResizeTable { removed_columns: vec![last_col] }`.

Inserting / removing a column in the MIDDLE is NOT supported in 4.8 (deferred to Phase 5 structural edits — requires physical cell move).

Op log encoding: one `Op::ResizeTable { name, new_rows, new_cols, added_columns: Vec<TableColumnRecord>, removed_columns: Vec<String> }`. Single atomic op (Codex open-question 6 closure). Replay sees missing-table → `ReplayError::TableNotFound`.

### 12.4 `drop_table`

Removes metadata. Formula text referencing the dropped table re-binds to `BindError::UnknownTable` → emits `#NAME?` (matching defined-name removal precedent).

## 13. Cross-cutting decisions

1. **No fallbacks** — unknown table / column / specifier surfaces a specific bind error (per CLAUDE.md "errors must be visible"). Table-related bind errors map to cell error values per § 7.4 (so a formula referencing a not-yet-created table is accepted with an error cell value; later `create_table` dirties + re-binds).
2. **Case-insensitive name lookups** — match Excel canon. Canonical = uppercase for lookups; case-preserving for display.
3. **Shared name/table namespace** — registration validates against both; collisions reject. **Sheet-scoped names** (4.6.D existing feature): a sheet-scoped name AND a workbook-scoped table collide on the canonical key — hard collision, both refuse (Codex LOW-1 closure).
4. **Plan cache key extension** — `table_gen` joins `name_gen` and `sheet` in `PlanCacheKey` (only for resize/column_rename/drop; create+rename rewrite formula text so text-keyed cache misses anyway).
5. **Op log is the source of truth for replay** — `Workbook::tables_mut().create(...)` direct calls bypass the op log (low-level path); runtime calls always emit the op. Direct calls are reserved for the qbook loader.
6. **Persistence schema bump** — v5 → v6. v6 reader loads v4–v6; v5 reader REFUSES v6 (loud-fail per § 10.3).
7. **`[@Col]` requires owning_cell context** — bind without context fails precisely with `BindError::ThisRowRequiresOwningCell`.
8. **Tables can't overlap** — validated at create + resize.
9. **No dedicated graph vertex per table** — table refs are range refs; `table_to_formulas` dep index + `on_table_*` hooks handle metadata-change invalidation directly (§ 4.5).
10. **Renames rewrite formula text** — `ast::rewrite_table_ref(old, new)` tree-walk per § 12.2; matches Phase 4.6 sheet-rename precedent.
11. **Spills inside tables blocked** — § 4.3 invariant #5 (Codex HIGH-3 closure).
12. **Table-related bind errors are soft** — accepted formula text + error cell value (§ 7.4); non-table bind errors stay hard.
13. **Phase 4.8 closes #148** — bare-column shadowing — by re-ordering the lexer's Ident-with-lookahead check.

## 14. Sub-phase split — REVISED post-Codex (MEDIUM-8, LOW-4)

Each sub-phase ships independently (1 commit + 7 gates green) with self-audit; Codex pull-ups at major milestones; closing megaudit at 4.8.O.

**Codex MEDIUM-8 fix**: first E2E test moves earlier — to 4.8.H (after create + binder + walker land). Codex correctly noted that 4.8.M (the prior position) was too late.

**Estimate revision (Codex LOW-4)**: 1-2 weeks was optimistic. Realistic: 2-3 weeks, matching 4.7 complexity once rename rewriting, dirty hooks, parser combinations, escape rules, and persistence are accounted for.

| # | Sub-phase | Subject | Status |
|---|---|---|---|
| 0 | **4.8.AA** (W5-109) | This design doc + Codex review (doc-only) | ✅ shipped `d3db4a65f13` |
| 1 | **4.8.A** (W5-110) | `TableMetadata` + `TableColumn` + `TableTable` in `ql-storage` + module wiring | ✅ shipped `03b90ec3f13` (14 tests) |
| 2 | **4.8.B** (W5-111) | Lexer: `Token::StructuredRef` + bracket-escape rules (§ 5.4); Ident-with-`[`-lookahead pre-empts BareColumn (closes #148) | ✅ shipped `f8a7cd8fa14` (12 tests; #148 closed) |
| 3 | **4.8.C** (W5-112) | Parser: `Expr::StructuredRef` + `TableSpecSubtree::Combination` sub-grammar (multi-item per § 6.2) | ✅ shipped `7080db0b5f1` (13 tests) |
| 4 | **4.8.D** (W5-113) | Printer: `Expr::StructuredRef` escape-aware round-trip + lexer/parser refactor (preserve `'`-escapes) | ✅ shipped `1c9894e34af` (14 tests; § 5.1 design pivot) |
| 5 | **4.8.E** (W5-114) | `BindSite` struct + plumb owning_cell through every bind call site | ✅ shipped `f35d9307d9d` (no test delta; infra) |
| 6 | **4.8.F** (W5-115) | Binder: `ExprPlan::StructuredRef` resolution + new `BindError` variants + `TableLookup` trait + `walk_plan_for_deps` arm | ✅ shipped `54bc253aea8` (9 binder tests) |
| 7a | **4.8.G** (W5-116) | scalar.rs aggregate dispatch arms for StructuredRef (4 arms mirror AggregateNameRef) | ✅ shipped `4c47595d6bd` (2 e2e tests; `SUM(Sales[Qty])`) |
| 7b | **4.8.G.2** (W5-117) | `WorkbookEnv::with_formula_cell` + `CellEnv::formula_cell_for_sref` + `narrow_structured_ref` helper for `[@Col]` row narrowing at eval time | ✅ shipped `05f86c56e2c` (2 e2e tests; `[@Qty]*2`) |
| 7c | **4.8.G.3** (deferred) | `table_to_formulas` reverse dep index + `on_table_create/rename/drop/resize/rename_column` hooks + plan cache `table_gen` field | ⏳ DEFERRED — current impl uses formula-text rewrite (rename) + name_gen + plan_cache.clear() (rename); targeted invalidation deferred until needed |
| 8 | **4.8.H** (W5-118) | Workbook runtime: `create_table` / `drop_table` + `Op::CreateTable` / `Op::DropTable` + replay arms + W5-103 atomicity | ✅ shipped `ec3e9cc960a` (9 tests incl. producer→replay e2e) |
| 9a | **4.8.I** (W5-119) | Workbook runtime: `rename_table` + `ast::rewrite_table_ref` tree-walk + formula text rewrite + `Op::RenameTable` | ✅ shipped `e2d80eee653` (4 tests) |
| 9b | **4.8.I.2** (W5-121) | `rename_column` + `Op::RenameColumn` (same pattern as rename_table but rewrites column refs inside `StructuredRef` specs) | ✅ shipped (11 tests: 10 unit + 1 e2e replay) |
| 10 | **4.8.J** (W5-122) | `resize_table` (grow rows + add/remove last column) + `Op::ResizeTable`. NOTE: spill-anchor check intentionally omitted to mirror `create_table` (which doesn't check either); uniform fix is a separate follow-up. | ✅ shipped (13 tests: 12 unit + 1 e2e replay) |
| 11 | **4.8.K** (W5-NNN) | Op log: additional replay coverage + atomicity edge cases (currently `Op::CreateTable / DropTable / RenameTable` all replay-tested; `RenameColumn / ResizeTable` arrive with 9b + 10) | ⏳ DEFERRED |
| 12 | **4.8.L** (W5-123) | Persistence: schema v5 → v6 + `TableTable` save/load + v5-reader loud-fails on v6 (already enforced by version range check). NEW: `TableTable::insert` auto-bumps `next_column_id` past loaded ids. | ✅ shipped (12 tests: 8 qbook + 3 storage + 1 e2e) |
| 13 | **4.8.M** (W5-NNN) | Specifier coverage tests: `#Headers`, `#Totals`, `#All`, `#Data`, `#This Row` + `[@Col]` + column ranges + combinations | ⏳ PARTIAL — covered by binder tests (4.8.F) + e2e (4.8.G/G.2/H/I); explicit coverage matrix deferred |
| 14 | **4.8.N** (W5-NNN) | Edge cases: header-only table (empty-data bind error), `A[0]`-style collisions, escape-prefix headers, dropped-table re-binding, soft-fail integration | ⏳ DEFERRED |
| 15 | **4.8.O** (W5-NNN) | Closing mega-audit (Codex + Sonnet parallel) | ⏳ DEFERRED |

16 sub-phases (15 implementation + 1 design). **12 / 15 implementation sub-phases shipped** (4.8.A→I plus 4.8.I.2, 4.8.J, 4.8.L; plus the design doc).

### Renumbering note

The W5-NNN ids in commits diverged from the design's W5-NNN plan starting at 4.8.G (design said W5-116, shipped as W5-116; but 4.8.G.2 introduced a new sub-phase id that shifted everything by 1). Mapping:

| Design said | Shipped as |
|---|---|
| 4.8.G = W5-116 | 4.8.G = W5-116 ✓ |
| 4.8.H = W5-117 | 4.8.G.2 = W5-117 |
| 4.8.I = W5-118 | 4.8.H = W5-118 |
| 4.8.J = W5-119 | 4.8.I = W5-119 |

W5-NNN ids are convention, not load-bearing. Treat the **subphase letter** (G, H, I) as the canonical identifier; the W5-NNN is just the SHA-line tag in commit messages.

### Deferred work — what a fresh session should pick up

In rough priority order:

1. ~~**4.8.I.2 rename_column**~~ — ✅ shipped W5-121.
2. ~~**4.8.J resize_table**~~ — ✅ shipped W5-122.
3. ~~**4.8.L persistence v5→v6**~~ — ✅ shipped W5-123.
4. **4.8.G.3 calcgraph hooks** — optional (current rename impl uses formula-text rewrite which works correctly without `table_to_formulas`; the index becomes a perf optimization when tables grow large or rename rate is high).
5. **4.8.N error-to-cell-value soft-fail** — table-related `BindError`s currently hard-reject at `set_formula`; design § 7.4 wants soft-fail so formulas typed BEFORE the table exists land an error cell value, then re-bind on `on_table_create`.
6. **4.8.O closing megaudit** — Codex + Sonnet parallel review on the cumulative 4.8 wave.

**Stop conditions** (defer remaining to a Phase 4.8 polish wave):
- If 4.8.B Ident-with-`[`-lookahead surfaces unforeseen tokenizer regressions, halt and re-design.
- If 4.8.E owning_cell plumbing balloons (Codex MEDIUM-4 flagged 5+ call sites; if more emerge, refactor `bind_with_names_and_sheets` signature first).
- If 4.8.F error-to-cell-value mapping breaks the existing `set_formula` REJECT contract for non-table errors, halt — backwards compat for existing bind errors is non-negotiable.
- If schema bump in 4.8.L breaks load-recompute round-trip for v5 files, halt — backward compat is non-negotiable.

## 15. What's NOT in scope

- Calculated columns (`=[@Price]*[@Qty]` auto-propagating). Phase 4.10.
- Totals-row auto-functions (per-column SUM/AVERAGE). Phase 4.10.
- Insert/delete physical column (storage move). Phase 5.
- xlsx import/export of `<table>` XML. Phase 4.11.
- R1C1-style table refs. Phase 4.9.
- 3D refs across sheets. Likely never.
- Slicers / filtered views. Phase 5+.
- Phase 4.10 polish: dynamic column index refs (`Table[INDEX(headers, 2)]`).

## 16. Open questions — CLOSED post-Codex pass 1

All 8 open questions resolved by Codex's pass-1 review. Decisions adopted into the design:

1. **Spec sub-grammar normalization** — semantically normalize at bind time (collapse `Sales[[Col]]` and `Sales[Col]` to the same RowSelector + ColumnSelector); the AST keeps distinct `BareColumn` vs `Combination(vec![Column(c)])` variants for printer round-trip. Codex agreed; documented in § 6.2.
2. **`[@Col]` outside owning row** — `BindError::ThisRowOutsideTable` at bind time; mapped to `Value::Error(#VALUE!)` cell value per § 7.4 error mapping. Codex agreed.
3. **Name/table collision** — hard collision (set_name AND create_table both refuse). Sheet-scoped names included. Codex LOW-1 closure.
4. **Header-only table** — `ql_types::Range` (inclusive) can't represent zero rows. v1 choice: `BindError::StructuredRefDegenerateRange` at bind time → `Value::Error(#CALC!)` cell value. Defer "EmptyRange" type to a future polish wave. Codex HIGH-6 closure.
5. **Cross-sheet table refs** — Codex pushed back: table names are workbook-scoped; `Sales[Qty]` is reachable from any sheet via the unqualified `Sales` lookup. `Sheet1.Sales[Qty]` requires lexer/parser proof, deferred to Phase 4.9 alongside other sheet-qualified work. The unqualified form works in v1.
6. **`ResizeTable` op atomicity** — one atomic op carrying both new dims AND column deltas; replay sees missing-table → `ReplayError::TableNotFound` (fail-loud). Codex agreed.
7. **Per-table graph vertex** — no dedicated vertex; `table_to_formulas` dep index (§ 4.5) + `on_table_*` hooks handle metadata-change invalidation directly. Codex agreed conditionally on the dep index existing (which it now does in § 4.5).
8. **#148 closure folded into 4.8.B** — yes, with regression tests for `Src[Col]`, `A:A`, `A[0]` (table-name validation rejects), `SUM[X]` (table-name validation rejects). Codex confirmed.

## 17. Codex pass-1 review summary

Codex's pass-1 review (7 HIGH + 8 MEDIUM + 4 LOW) drove the revisions above:

- **HIGH-1 (rename semantics)** → § 4.4 + § 12.2: rewrite formula text on rename.
- **HIGH-2 (dirty hooks)** → § 4.5: `table_to_formulas` dep index + `on_table_*` hooks.
- **HIGH-3 (spills inside tables)** → § 4.3 invariant #5: block ALL spill anchors.
- **HIGH-4 (AST combinations)** → § 6.2: `TableSpecSubtree::Combination(Vec<TableSpecItem>)`.
- **HIGH-5 (escape rules)** → § 5.4: OOXML escape pseudocode + test surface.
- **HIGH-6 (empty ranges)** → § 16 q4: header-only is bind error in v1.
- **HIGH-7 (error rendering)** → § 7.4: error-to-cell-value mapping.
- **MEDIUM-1 (column IDs + totals function)** → § 4.1 revised.
- **MEDIUM-2 (function-name exclusion)** → § 5.2 revised: no lexer-side filter.
- **MEDIUM-3 (table-name validation)** → § 5.3: explicit Excel-ish rules.
- **MEDIUM-4 (BindSite)** → § 7.3: struct + call-site enumeration.
- **MEDIUM-5 (walker changes)** → § 8.2: explicit StructuredRef arm.
- **MEDIUM-6 (printer separation)** → § 14 sub-phase 4.8.D note: syntax-only printer.
- **MEDIUM-7 (schema compat)** → § 10.3: v5 reader fails loud on v6.
- **MEDIUM-8 (sub-phase ordering)** → § 14: first E2E at 4.8.H.
- **LOW-1 (sheet-scoped names)** → § 13 decision #3.
- **LOW-2 (header/totals row [@Col])** → § 13 decision #7 + § 7.4.
- **LOW-3 (remove last column)** → § 12.3.
- **LOW-4 (estimate)** → § 14: 2-3 weeks.

**Ready for implementation pass.** Optional Codex pass-2 verification possible before 4.8.A; not blocking.
