# Engine Phase 4.8 — Structured References and Tables

**Status:** Design doc (sub-phase 4.8.AA / W5-109). Pre-implementation. Codex review pending.
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
    /// Ordered list of column names. Length == `cols`. Stable IDs are
    /// the indices into this Vec. Canonicalized to lowercase for
    /// case-insensitive lookup; case-preserving display version stored
    /// alongside (parallel Vec).
    column_names: Vec<Arc<str>>,         // lowercase canonical
    column_display: Vec<Arc<str>>,       // original case
}
```

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
5. **Tables cannot anchor spills** (4.7 interaction). If a `SEQUENCE(N)` formula lives inside a table's footprint and the spill would extend beyond the table boundary, the spill is blocked with `#SPILL!`. Within-table spills are allowed if they fit entirely.

### 4.4 `TableId` vs `Arc<str>` names

Decision: use `Arc<str>` (uppercase canonical) as the primary key, matching `NameTable`. A separate `TableId(u32)` is tempting for the graph (stable across renames) but adds complexity. The graph indexes tables by name; a rename triggers a re-extract pass on every formula that references the old name. This matches our existing `NameTable::generation` invalidation cadence and is consistent with how Excel itself behaves (renames cascade through formula text).

**Defer numeric IDs to a future polish wave** if the rename overhead proves real.

## 5. Lexer changes

### 5.1 New token

```rust
Token::StructuredRef {
    table_name: Arc<str>,         // case-preserving
    bracket_content: Arc<str>,    // verbatim from `[` to matching `]`
}
```

`bracket_content` is the unparsed bracket text; the parser runs the spec sub-grammar on it (parallel to how IronCalc separates lexer-stage capture from parser-stage interpretation).

### 5.2 Recognition rule

After lexing an Ident, peek for `[`. If present AND the Ident is NOT a function name (we know the function name set), consume the bracket-balanced content as `bracket_content`. Emit `Token::StructuredRef`.

**Function name collision:** `SUM[...]` is NOT a structured ref — it's a syntax error (functions use parens). The Ident-vs-FunctionRef discrimination happens at the lexer level via the function-name table.

**Bare-column collision (Phase 4.7.N gap #148):** an Ident that matches a column letter pattern (`A`, `XFD`, etc.) lexes as `BareColumn` BEFORE checking for `[`. To resolve `Src[Col]` correctly, Ident classification must check for `[` lookahead FIRST, then fall back to BareColumn. **This is the close-out for #148** — Phase 4.8 lexer changes pre-empt the bare-column shadowing trap.

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

### 6.2 `TableSpecSubtree`

```rust
pub enum TableSpecSubtree {
    /// `Table[Col]` or `Table[[Col]]` — default data-column.
    Column(Arc<str>),
    /// `Table[[Col1]:[Col2]]` — column range, data rows.
    ColumnRange(Arc<str>, Arc<str>),
    /// `Table[[#Headers]]`, `Table[[#Totals]]`, `Table[[#All]]`,
    /// `Table[[#Data]]` — whole-row specifier without a column scope.
    SpecialAll(SpecialItem),
    /// `Table[[#Headers], [Col]]` or `Table[[#Totals], [Col]]` etc.
    SpecialColumn(SpecialItem, Arc<str>),
    /// `Table[[#Headers], [Col1]:[Col2]]`.
    SpecialColumnRange(SpecialItem, Arc<str>, Arc<str>),
    /// `[@Col]` shorthand — current row, single column. Resolution
    /// requires the binder to know the formula's cell address.
    ThisRowColumn(Arc<str>),
    /// `[@[Col1]:[Col2]]` shorthand — current row, column range.
    ThisRowColumnRange(Arc<str>, Arc<str>),
}

pub enum SpecialItem {
    Headers,
    Totals,
    Data,
    All,
    ThisRow,  // for `Table[[#This Row], [Col]]` form
}
```

**Note:** `ThisRow` as a `SpecialItem` (e.g., `Table[[#This Row], [Col]]`) and `ThisRowColumn(col)` (the `[@Col]` shorthand) are TWO distinct paths. The parser normalizes `Table[[#This Row], [Col]]` to `SpecialColumn(ThisRow, col)`; the `@`-prefixed form stays in `ThisRowColumn` until bind time.

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

### 7.3 Context plumbing

The binder already takes `owning_sheet: SheetId` for resolving `Expr::CellRef`. Phase 4.8 extends to optionally take `owning_cell: Option<Address>` so the `ThisRowColumn` resolution has the formula's full cell address. Existing call sites that don't have a cell address (e.g., dry-run parse + bind for syntax validation) pass `None`; this causes `ThisRowColumn` binds to error precisely.

### 7.4 `TableTable::generation` invalidation

Plan cache key already includes `name_gen`. Add `table_gen`:

```rust
struct PlanCacheKey {
    text: Arc<str>,
    sheet: SheetId,
    name_gen: u64,
    table_gen: u64,  // NEW
}
```

Any table mutation bumps `table_gen`; the next bind of any formula misses the cache and re-resolves against the new metadata.

## 8. Calcgraph dep extraction

### 8.1 Table refs register as range deps

`ExprPlan::StructuredRef { resolved, .. }` walks identically to `ExprPlan::AggregateNameRef`: the `resolved` `Range` is registered as a range dep via `range_to_rangeref` + `register_range_dependency` (existing 4.6 stripe machinery).

**Decision: no dedicated `VertexKind::Table` graph vertex.** Formualizer creates a per-table vertex; IronCalc treats it as a regular range. We follow IronCalc: a table ref is just a range ref, period. The cell-edits-inside-table → dependent-formula propagation already works through the stripe index. A per-table vertex would add a layer of indirection for no clear correctness win.

**Trade-off:** When a table is renamed or columns reshuffled, every formula referencing it must re-extract. With a dedicated vertex, only the vertex's range mapping changes. Our approach uses `table_gen` to invalidate the plan cache and re-bind on next eval — same end-state, simpler graph.

### 8.2 `[@Col]` `ThisRowColumn` deps

The `is_this_row: bool` flag in `ExprPlan::StructuredRef` lets the dep extractor register a single CELL dep (not a range stripe), matching the runtime semantic of `@Col` resolving to a specific cell. Different from `Table[Col]` which is a column-wide range dep.

### 8.3 Producer-alias rewrite interaction (4.7.I)

If a `Table[Col]` resolves to a range that overlaps a spill footprint, the producer-alias rewrite (Phase 4.7.I) applies cell-by-cell. The same `spill_target_anchor` lookup runs for each cell in the resolved range. This is automatic — the resolved range goes through `walk_plan_for_deps` like any other range.

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

### 10.3 `.qbook` schema bump v5 → v6

The 4.7 wave kept the schema at v5 (the save-side spill-target skip was behavioral). Adding `TableTable` persistence requires v6.

```
schema v6:
  + tables: Vec<TableMetadataRecord>
```

Backward compat: v5 files load with `TableTable::default()` (empty); the loader records this in the bookkeeping. v6-savers warn on load of a v5 file (the warning surfaces in `LoadResult` per CLAUDE.md "errors must be visible"). v5 files saved by a v6-writer get upgraded silently (no-op for empty TableTable).

### 10.4 `MIN_SUPPORTED_SCHEMA_VERSION`

Stays at 4 (no need to drop v5 support). v6 writer + v4/v5/v6 reader.

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

### 12.2 `rename_table` / `rename_column`

Both fire the `table_gen` bump → next bind re-resolves formula text against the new name. **Formula text in cells is NOT rewritten** (Excel canon: formula text references resolve at bind time; the printer renders the current name). The Phase 4.6 sheet-rename pattern is the precedent.

**Edge case:** if formula text was authored before the table existed (when `Table[Col]` would have failed to bind as `UnknownTable`), creating the table NOW must dirty those formulas so they re-bind successfully. → `Workbook::tables_mut().create(...)` calls `CalcgraphSession::on_table_create(name)` which dirties every formula text-matching `name` (similar to `on_set_name`).

### 12.3 `resize_table`

Two scenarios:
- **Grow rows:** common case (user added rows below the table). Update `rows`. No graph mutations needed; deps registered against the OLD range still cover the new region only if the binder re-extracted them. → bump `table_gen`, mark all dependents dirty via existing range-stripe machinery, force re-extract on next recompute.
- **Add column:** append a column name to the roster. Same dirty/re-extract pass. Inserting a column in the MIDDLE is NOT supported in 4.8 (deferred to Phase 5 structural edits).

### 12.4 `drop_table`

Removes metadata. Formula text referencing the dropped table re-binds to `BindError::UnknownTable` → emits `#NAME?` (matching defined-name removal precedent).

## 13. Cross-cutting decisions

1. **No fallbacks** — unknown table / column / specifier surfaces a specific bind error (per CLAUDE.md "errors must be visible"). No "graceful fallback to A1 notation."
2. **Case-insensitive name lookups** — match Excel canon. Canonical = uppercase for lookups; case-preserving for display.
3. **Shared name/table namespace** — registration validates against both; collisions reject.
4. **Plan cache key extension** — `table_gen` joins `name_gen` and `sheet` in `PlanCacheKey`.
5. **Op log is the source of truth for replay** — `Workbook::tables_mut().create(...)` direct calls bypass the op log (low-level path); runtime calls always emit the op.
6. **Persistence schema bump** — v5 → v6. Backward-compat with v5 (empty tables on load).
7. **`[@Col]` requires owning_cell context** — bind without context fails precisely.
8. **Tables can't overlap** — validated at create + resize.
9. **No dedicated graph vertex per table** — table refs are range refs; the stripe index already handles invalidation.
10. **Phase 4.8 closes #148** — bare-column shadowing — by re-ordering the lexer's Ident-with-lookahead check.

## 14. Sub-phase split

Each sub-phase ships independently (1 commit + 7 gates green) with self-audit; Codex pull-up at major milestones; closing megaudit at 4.8.O.

| # | Sub-phase | Subject | Audit |
|---|---|---|---|
| 0 | **4.8.AA** (W5-109) | This design doc + Codex review (doc-only) | Codex review (this commit) |
| 1 | **4.8.A** (W5-110) | `TableMetadata` + `TableTable` in `ql-storage` + module wiring | Self + Sonnet |
| 2 | **4.8.B** (W5-111) | Lexer: `Token::StructuredRef`; Ident-with-`[`-lookahead pre-empts BareColumn (closes #148) | Self + Sonnet + Codex pull-up |
| 3 | **4.8.C** (W5-112) | Parser: `Expr::StructuredRef` + `TableSpecSubtree` sub-grammar | Self + Sonnet |
| 4 | **4.8.D** (W5-113) | Printer: `Expr::StructuredRef` round-trip + display-name preservation | Self only |
| 5 | **4.8.E** (W5-114) | Binder: `ExprPlan::StructuredRef` resolution + `BindError::Unknown{Table,TableColumn}` variants | Self + Sonnet |
| 6 | **4.8.F** (W5-115) | Binder: `[@Col]` `owning_cell` context plumbing + `BindError::ThisRowOutsideTable` | Self + Sonnet |
| 7 | **4.8.G** (W5-116) | Plan cache extension: `table_gen` in `PlanCacheKey` | Self only |
| 8 | **4.8.H** (W5-117) | Workbook runtime: `create_table` / `drop_table` + op log emission | Self + Sonnet + Codex pull-up |
| 9 | **4.8.I** (W5-118) | Workbook runtime: `rename_table` / `rename_column` + calcgraph dirty propagation | Self + Sonnet |
| 10 | **4.8.J** (W5-119) | Workbook runtime: `resize_table` (grow rows + add column) | Self + Sonnet |
| 11 | **4.8.K** (W5-120) | Op log: `CreateTable / RenameTable / RenameColumn / ResizeTable / DropTable` replay | Self + Sonnet |
| 12 | **4.8.L** (W5-121) | Persistence: schema v5 → v6 + `TableTable` save/load + load-side v5 compat | Self + Sonnet |
| 13 | **4.8.M** (W5-122) | First end-to-end test: `SUM(Sales[Qty])` round-trip through aggregate cache | Self only |
| 14 | **4.8.N** (W5-123) | Specifier coverage: `#Headers`, `#Totals`, `#All`, `#Data`, `#This Row` + column ranges | Self only |
| 15 | **4.8.O** (W5-124) | Closing mega-audit (Codex + Sonnet parallel) | **Codex + Sonnet** |

16 sub-phases (15 implementation + 1 design). Estimated 1-2 weeks at prior pace.

**Stop conditions** (defer remaining to a Phase 4.8 polish wave):
- If 4.8.B Ident-with-`[`-lookahead surfaces unforeseen tokenizer regressions, halt and re-design (#148 was assumed cheap).
- If 4.8.E `[@Col]` resolution proves hard to plumb without major binder refactor, defer the shorthand to 4.9 and ship the explicit form only.
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

## 16. Open questions for Codex review

1. **Spec sub-grammar normalization** — should `Sales[[Col]]` and `Sales[Col]` be the SAME AST node (normalize at parse time) or remain distinct for printer round-trip? I propose normalize; Codex weigh in.
2. **`[@Col]` outside a table's owning row** — Excel surfaces `#VALUE!`; I propose `BindError::ThisRowOutsideTable` at bind time (precise) rather than runtime `#VALUE!`. Codex preference?
3. **Table name as defined-name interaction** — if a user runs `set_name("Sales", Constant(5))` AFTER `create_table("Sales", ...)`, should it (a) fail at set_name with `NameTableError::CollidesWithTable`, (b) succeed and shadow the table for scalar-context references, or (c) something else? I propose (a) — hard collision.
4. **Header-row-only table** (header but no data rows) — design § 13.2 of 4.7 ships degenerate spills as `#CALC!`; should `Sales[Qty]` on a zero-data-row table surface `#CALC!` or `#REF!`? I propose `#CALC!` (consistent with 4.7).
5. **Cross-sheet table refs** — Excel supports `Sheet1.Sales[Qty]`. I propose v1 supports it via the existing sheet-qualified-ref machinery, but defer 3D ranges. Codex confirm?
6. **Op log atomicity for `ResizeTable`** — adding a column changes both `cols` AND `column_names`. Should this be one op or two? I propose one (`ResizeTable` carries both new dims AND column deltas) to avoid mid-replay inconsistent state.
7. **Per-table graph vertex** — I argue against (§ 8.1); Codex push back if Formualizer's approach has wins I'm missing.
8. **`#148` closure as part of 4.8.B** — bare-column shadowing fix lands as a side-effect. Codex confirm this is the right sub-phase to fold it in.

Codex: review this doc end-to-end. Flag missing acceptance criteria, mis-categorized sub-phases, incorrect Excel-canon claims, missing op-log variants, schema-compat risks. Treat the open questions above as starting points; surface anything else you'd push back on.
