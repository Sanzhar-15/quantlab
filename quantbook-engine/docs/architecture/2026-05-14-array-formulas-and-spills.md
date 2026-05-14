# Phase 4.7 — Array Formulas And Dynamic Spills (design)

**Date:** 2026-05-14
**Phase:** 4.7 (per `docs/MASTER-PLAN.md` §7)
**Status:** APPROVED post-Codex review (W5-94). Codex review at `docs/audits/2026-05-14-phase-4.7-design-codex-review.txt`: 5 HIGH + 4 MEDIUM + 3 LOW design findings, all folded into this doc.
**Pattern:** mirrors Phase 4.6 design doc (`2026-05-13-cross-sheet-references.md`).

## Codex review changelog

The original draft was substantively wrong on five HIGH points. This revision encodes the corrected design:

- **HIGH (§ 6.3):** "scalar context returns first cell" was not Excel canon. **Revised:** v1 returns `#CALC!` for array-in-scalar-context; proper implicit intersection / `@` deferred to Phase 4.9.
- **HIGH (§ 6 + § 6.2):** `ArrayFn` over `EvalResult` (defined in `ql-exec`) created a `ql-functions` → `ql-exec` reverse-dependency cycle. **Revised:** array value type moves to `ql-types`; function ABI unifies the four tiers into one dispatch shape.
- **HIGH (§ 10):** parallel `outgoing_spill_targets` adjacency + eager CellNode creation conflicts with the existing calcgraph scheduler. **Revised:** spill targets are PRODUCER ALIASES — at dependency-extraction time, a `CellRef` to a cell with `spill_target_anchor(c) == Some(anchor)` becomes an edge to the anchor's formula node, lazy and graph-shape-preserving.
- **HIGH (§ 8.3):** missing "always unregister old spill before re-eval" step. **Revised:** explicit unregister-then-eval invariant; even blocked re-eval clears the old footprint first.
- **HIGH (§ 12):** "no schema bump because computed overlay round-trips" was false — current save emits non-formula non-blank cells as user-overlay records, so spill targets reload as user blockers. **Revised:** save side SKIPS cells inside an active spill range (lookup via `spill_target_anchor`); load → recompute_all re-derives. No schema bump needed.
- **MEDIUM:** `SpillAnchorTable` map-only; overlay clearing in `Workbook` API. Binder returns `BindError`, not panic. Sub-phase order moved graph before runtime.
- **LOW:** `ErrorValue::Spill` already exists at `crates/ql-types/src/error.rs:38` — moved to "already in place." Terminology: anchor vs target vs Excel's `A1#` spill-range-ref syntax (Phase 4.9). Blocking example fixed.

## 1. Acceptance criteria (from MASTER-PLAN)

- **ARR-4-01** array literals parse and evaluate.
- **ARR-4-02** spill writes computed overlay only.
- **ARR-4-03** blocked spills return the right error (`#SPILL!`).
- **ARR-4-04** dynamic spill resizing invalidates dependents.

## 2. Current state — what already works, what's missing

### 2.1 Already in place

- **AST:** `Expr::Array(Vec<Vec<Expr>>)` shape-locked in `crates/ql-formula-syntax/src/ast.rs:63`. `Expr::Spill(Box<Expr>)` shape-locked at line 67 but is RESERVED for Excel's `A1#` spill-range-ref syntax (Phase 4.9), NOT for the runtime spill anchor. Parser doesn't construct either; binder rejects with `BindError::UnsupportedVariant`.
- **`ErrorValue::Spill`** at `crates/ql-types/src/error.rs:38` with canonical `"#SPILL!"` sigil. Round-trips through `CellWireValue::Error` wire format (verified by W5-93 sigil round-trip tests).
- **Storage:** `ColumnStore::computed_overlays: Vec<SparseOverlay>` already exists (Phase 3.5, W5-38). `Sheet::put_computed` / `clear_computed` API in place. Read cascade is `user → computed → base`.
- **Calcgraph:** `Node::Spill(SpillNode { anchor, shape_rows, shape_cols })` shape-locked in `ql-calcgraph/src/node.rs:107`. `add_spill_node` panics with "Phase 3+ feature" message. **NB: post-revision this node may not be needed at all** — spill targets aren't graph nodes (see § 10).
- **Functions:** registry has `ScalarFn` / `RangeAwareFn` / `ContextAwareFn` tiers in `crates/ql-functions/src/registry.rs`. **Will unify, not extend** (see § 6.2).
- **Op log + persistence:** stable. No new variants planned. NO schema bump.

### 2.2 Crate dependency map (relevant for § 6)

```
ql-types          (leaf)
  ↑
ql-functions      (depends on ql-types)
  ↑
ql-storage / ql-formula-syntax / ql-io / ql-oplog / ql-calcgraph
  ↑
ql-exec           (depends on all of the above)
```

`ql-functions` CANNOT import from `ql-exec` — that would close a cycle. Any type referenced by the function ABI must live in `ql-types` or `ql-functions` itself. **This is why the original draft's `ArrayFn(args: &[EvalResult])` design was wrong.**

### 2.3 Missing

- Lexer: `{` and `}` tokens; `,` and `;` as array-context separators.
- Parser: array-literal parsing rules.
- Printer: round-trip for `Expr::Array`.
- Binder: `Expr::Array` → `ExprPlan::Array` lowering with element-arity validation.
- Array value type in `ql-types` (so `ql-functions` can reference it).
- Unified function ABI in `ql-functions` (collapse `ScalarFn` / `RangeAwareFn` / `ContextAwareFn` into one dispatch shape; gain array support).
- Storage: spill-anchor table (anchor → shape lookup; target → anchor reverse).
- Workbook-layer `clear_spill_at(anchor)` (clears both the table entries AND the computed overlays at every target).
- Runtime: spill writeback (clear-old-first → eval → block-check → register-and-write).
- Calcgraph: producer-alias edges for spill targets (lazy, at dep-extraction time).
- Persistence: save-side skip for cells that are spill targets (lookup via `spill_target_anchor`).
- First array-returning functions: SEQUENCE, FILTER, TRANSPOSE.

## 3. Grammar

### 3.1 Array literal syntax

ASCII-only separators. Match Excel's en-US canonical syntax (deferred locale support is Phase 4.9):

```
array_literal := '{' array_row (';' array_row)* '}'
array_row    := array_cell (',' array_cell)*
array_cell   := literal | unary literal     // see § 3.3 for constraints
literal      := NUMBER | STRING | BOOL      // no nested refs in Phase 4.7
```

Horizontal: `{1, 2, 3}` → 1×3.
Vertical: `{1; 2; 3}` → 3×1.
2D: `{1, 2; 3, 4}` → 2×2.

### 3.2 Element-arity rule

All rows must have the same number of cells. Mismatched-row literals (e.g. `{1, 2; 3}`) error at parse time with `ParseError::ArrayRowArityMismatch { expected, found, row }`. **This is a Quantbook v1 subset** — Excel pads with `#N/A` for missing cells, and `{1,2;3}` evaluates as `{1,2;3,#N/A}`. Quantbook v1 chooses loud rejection over silent padding; the pad-with-`#N/A` variant is a Phase 4.10 polish item gated on test-corpus completeness.

### 3.3 Element kinds restricted in v1

Array cells in v1 — the allowed `array_cell` subset:

- `NUMBER` (positive or negative literal)
- `STRING` literal
- `BOOL` literal (`TRUE` / `FALSE`)
- `error literal` — `#NULL!`, `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#NUM!`, `#N/A`, `#SPILL!`, `#CALC!` — the nine Excel-canon error sigils available as `ErrorValue::ALL` entries in `ql-types`. Needed for `FILTER(_, _, #N/A)` etc. (W5-97 closure / Sonnet M2: `#GETTING_DATA` was listed in the original draft but is not in `ErrorValue::ALL` — it's an Excel-Online-specific volatile data-wait state that we don't model in v1; lifting it would require adding the variant alongside `Disconnected`/`Timeout`. Deferred to Phase 4.10 or whenever a real use case appears.)

NO nested CellRef / RangeRef / Function calls / Unary operators (other than the implicit sign on numeric literals). Codex MEDIUM finding: explicitly document this as a Quantbook v1 subset.

Phase 4.10 lifts to allow refs (`{A1, B1; A2, B2}`) once the array evaluator and dependency extraction prove stable.

**Rationale:** array literals with refs would require shape determination at bind/eval time, not parse time, AND would entangle the array-literal grammar with the dependency graph. Restricting v1 to constants keeps the parser simple and the test corpus closed.

## 4. AST

`Expr::Array(Vec<Vec<Expr>>)` is already shape-locked. The parser populates it directly. Each inner `Expr` is constrained to the kinds in § 3.3.

**`Expr::Spill(Box<Expr>)` terminology note** (Codex LOW): the existing shape-lock at `ast.rs:67` is RESERVED for Excel's `A1#` spill-range-ref SYNTAX (Phase 4.9), NOT the runtime spill anchor. Excel's `A1#` means "the spill range anchored at A1" — it's a reference operator, not an anchor marker. The runtime spill anchor (the formula cell at the top-left of a spilled range) lives in `Workbook::spill_anchors` (§ 7), not in the AST. Phase 4.7 does not construct `Expr::Spill`; that's Phase 4.9's job alongside `@`.

## 5. Binder — `ExprPlan::Array`

New variant:

```rust
ExprPlan::Array(Vec<Vec<ExprPlan>>)
```

Binder rule: `Expr::Array` → `ExprPlan::Array` element-wise. Each element binds to a `Number` / `Bool` / `String` / `Error` plan (no `Unary` — the lexer folds signs into literals).

**Codex MEDIUM:** `Expr::Array` is a PUBLIC AST variant. Tests + tools can construct invalid ASTs (e.g. ragged shapes via `Vec::push`). The binder MUST reject ragged ASTs with a clean error, not panic:

```rust
BindError::ArrayRowArityMismatch { expected: u32, found: u32, row: u32 }
```

This shadows the equivalent `ParseError` for the case where the AST was constructed directly. No `BindError::UnsupportedVariant` for `Expr::Array` itself — it's now supported.

## 6. Evaluator — REDESIGN per Codex HIGH

### 6.1 `ArrayValue` type — lives in `ql-types`

Codex HIGH: `EvalResult` in `ql-exec` cannot be referenced by `ql-functions` without closing a dependency cycle (`ql-functions` → `ql-types` only; `ql-exec` → `ql-functions`).

**Revised placement:** `ArrayValue` lives in `ql-types` alongside `Value` and `ErrorValue`:

```rust
// crates/ql-types/src/array.rs (new module)
#[derive(Clone, Debug, PartialEq)]
pub struct ArrayValue {
    pub rows: u32,
    pub cols: u32,
    pub cells: Vec<Value>,  // row-major, length = rows * cols
}

impl ArrayValue {
    pub fn at(&self, row: u32, col: u32) -> &Value { ... }
    pub fn first(&self) -> &Value { &self.cells[0] }
    pub fn is_degenerate(&self) -> bool { self.rows == 0 || self.cols == 0 }
}
```

`Value` itself stays scalar (no `Value::Array(...)` variant). Storage cells remain scalar by Excel canon — spilling MATERIALIZES arrays into per-cell scalars in the computed overlay. The array vs scalar distinction lives at the EVAL boundary via `EvalResult` (still in `ql-exec`).

### 6.2 Function ABI — UNIFY STORAGE, tagged dispatch

Codex HIGH: adding `ArrayFn` as a 4th parallel tier compounds the dispatch sprawl. The right move is to collapse the three parallel HashMaps in `FunctionRegistry` into **one storage map** keyed by name, valued by a tagged enum that distinguishes the tier of the underlying fn pointer.

**As-shipped dispatch shape** in `ql-functions` (W5-96 / Phase 4.7.B):

```rust
// crates/ql-functions/src/registry.rs (shipped W5-96)
pub enum FunctionArg {
    Scalar(Value),
    Range { values: Vec<Value>, rows: usize, cols: usize },  // matches existing FnArg::Range
    Array(ArrayValue),                                       // new — from Expr::Array or another fn return
}

pub enum FunctionReturn {
    Scalar(Value),
    Array(ArrayValue),  // new — for SEQUENCE / FILTER / TRANSPOSE
}

pub struct FunctionContext<'a> {
    pub eval_ctx: &'a EvalContext,
    // Additive shape — fields can land later without changing the FunctionFn alias.
    // Workbook access threads through eval-site env in W5-101 (Phase 4.7.G), not here.
}

pub type FunctionFn = fn(&[FunctionArg], &FunctionContext) -> FunctionReturn;

/// Tagged union — one variant per supported callable shape.
pub enum RegisteredFn {
    Scalar(ScalarFn),               // legacy `fn(&[Value]) -> Value`
    RangeAware(RangeAwareFn),       // legacy `fn(&[FnArg]) -> Value`
    ContextAware(ContextAwareFn),   // legacy `fn(&[Value], &EvalContext) -> Value`
    Unified(FunctionFn),            // new array-returning ABI
}

pub struct FunctionRegistry {
    fns: HashMap<&'static str, RegisteredFn>,
}
```

**Migration:**
- Existing `register` / `register_range_aware` / `register_context_aware` keep their public signatures; they store the appropriate `RegisteredFn::*` variant. The ~130 `r.register("SUM", scalar_fns::sum)` lines in `default_registry` work unchanged.
- New array-returning functions register via `register_unified(name, FunctionFn)`.
- The `lookup_*` filter views (`lookup`, `lookup_range_aware`, `lookup_context_aware`, `lookup_unified`) match on the enum variant and return the tier-specific fn pointer or `None`.
- `lookup_any(name) -> Option<&RegisteredFn>` is the eval-site entry point that returns the tagged enum directly — one HashMap lookup, one match arm per tier.

**Why tagged dispatch, not adapter-wrapping:** the alternative ("every register_* shim-wraps the legacy fn into a `FunctionFn`") would require boxing fn pointers (`Box<dyn Fn>`) because a bare `fn` pointer can't capture the wrapped legacy fn pointer. Tagged dispatch keeps fn pointers as plain `fn` values (Copy, no allocation) and pushes the per-tier match into the single eval-site dispatch instead of into per-call adapter calls. Net effect: same single-storage-map win Codex wanted, lower runtime overhead, simpler implementation. Full adapter normalization remains available as a future polish if the eval-site arms grow unwieldy.

**Caller-side dispatch** in `ql-exec::eval` (W5-101 / Phase 4.7.G migration target):

```rust
match registry.lookup_any(name) {
    Some(RegisteredFn::Scalar(f)) => /* materialize Vec<Value>, call f */ ,
    Some(RegisteredFn::RangeAware(f)) => /* materialize Vec<FnArg>, call f */ ,
    Some(RegisteredFn::ContextAware(f)) => /* materialize Vec<Value> + EvalContext, call f */ ,
    Some(RegisteredFn::Unified(f)) => {
        // Materialize Vec<FunctionArg> + FunctionContext; route the return:
        let ret: FunctionReturn = f(&args, &ctx);
        let eval_result: EvalResult = match ret {
            FunctionReturn::Scalar(v) => EvalResult::Scalar(v),
            FunctionReturn::Array(a)  => EvalResult::Array(a),
        };
    }
    None => /* unresolved function name */ ,
}
```

`EvalResult` (still in `ql-exec`) wraps the ABI-side return at the eval boundary. No cycle.

### 6.3 Eval contexts — REDESIGN per Codex HIGH

The original "scalar context returns first cell" rule was **NOT Excel canon**. Excel's behavior:
- **Dynamic-array Excel (365+):** array-in-scalar-context spills. `@` explicitly opts back into legacy implicit-intersection.
- **Legacy Excel:** implicit intersection takes the cell at the row/col INTERSECTION of the calling formula's row/col with the array's row/col span. "First cell" is wrong in both modes.

**Revised v1 rule:** array-in-scalar-context produces `Value::Error(ErrorValue::Calc)`. Specifically:

- **Cell-boundary context** (the formula expression at a cell's root): array result → spill (§ 8).
- **Sub-expression scalar context** (binary operand, scalar function arg): array result → `#CALC!`.
- **Aggregate-arg context** (existing `BindContext::AggregateArg` from Phase 2B.4): array result is consumed as a 2D range of values, NOT as a single scalar. This already works for `RangeRef` and named ranges; extending to literal arrays just feeds the cells.

Test:
- `=SEQUENCE(3) + 1` (no spill — wrapped in `+1` binary op) → `#CALC!`. The `+1` operand context is scalar.
- `=SUM(SEQUENCE(3))` → 6. The SUM arg context is aggregate; SEQUENCE's 3×1 result feeds as 3 cells.
- `=SEQUENCE(3)` at cell A1 → spills to A1, A2, A3.

Implicit intersection / `@` / xlsx-canon scalarization is **Phase 4.9 work**. Documented at § 14.5.

## 7. Spill anchor data model (storage)

### 7.1 New `SpillAnchorTable` in `ql-storage`

```rust
pub struct SpillAnchorTable {
    /// Anchor (sheet, row, col) → shape (rows, cols).
    /// One entry per spilling formula.
    anchors: HashMap<(SheetId, RowId, ColId), SpillShape>,
    /// Reverse map: each spilled-into cell → its anchor.
    /// Used for fast "is this cell part of a spill?" lookup
    /// at user-write time.
    targets: HashMap<(SheetId, RowId, ColId), (SheetId, RowId, ColId)>,
}

pub struct SpillShape {
    pub rows: u32,
    pub cols: u32,
}
```

**Invariant:** `targets[(s, r, c)] = (anchor_s, anchor_r, anchor_c)` iff `(anchor_s, anchor_r, anchor_c)` exists in `anchors` AND `(r, c)` is inside the rectangle `(anchor_r..anchor_r+shape.rows, anchor_c..anchor_c+shape.cols)`.

The anchor cell itself is BOTH an anchor AND its own target (the (0,0) of the spill range). Both maps include it.

### 7.2 Workbook integration — MAP-ONLY `SpillAnchorTable`

Codex MEDIUM: keep `SpillAnchorTable` map-only; overlay clearing lives in `Workbook` (which owns sheet/overlay access).

```rust
// crates/ql-storage/src/workbook.rs
impl Workbook {
    pub fn spill_anchors(&self) -> &SpillAnchorTable { &self.spill_anchors }
    pub fn spill_anchor_at(&self, sheet, row, col) -> Option<&SpillShape> { ... }
    pub fn spill_target_anchor(&self, sheet, row, col) -> Option<(SheetId, RowId, ColId)> { ... }

    /// Map-only mutator. Errors on rectangle collision; does NOT touch
    /// computed overlays. Production callers (runtime) couple this with
    /// `put_computed_at` for each target cell.
    pub fn register_spill(&mut self, anchor, shape) -> Result<(), SpillBlockError> { ... }

    /// Workbook-layer convenience: unregister anchor + clear computed
    /// overlays at every target cell. Used by runtime when re-evaluating
    /// a spill (§ 8.3) and when clearing a formula at a spill anchor.
    pub fn clear_spill_at(&mut self, anchor) -> Result<(), SpillNotFoundError> { ... }
}
```

`clear_spill_at` is the named workbook-layer operation that owns the overlay sweep. `SpillAnchorTable` itself just tracks the table state.

### 7.3 Persistence

`Workbook::spill_anchors` is RUNTIME-DERIVED state. NOT persisted. On `.qbook` load, `recompute_all` re-derives the table by re-evaluating each formula.

**No schema bump for Phase 4.7.** This is a property of the design — the computed overlay already round-trips correctly via the v4 envelope's per-sheet overlay; spill anchors are re-derived from formulas.

## 8. Spill writeback (runtime) — REDESIGN per Codex HIGH

### 8.1 `WorkbookRuntime::set_formula` extension

Pre-Phase 4.7 flow: parse → bind → eval (scalar context) → `put_computed` at the cell.

**New flow (Phase 4.7):**

1. Parse + bind formula.
2. **Clear any prior spill anchored at this cell.** If `workbook.spill_anchor_at(s, r, c).is_some()`, call `workbook.clear_spill_at(...)`. This is mandatory EVERY re-evaluation — even if the new result will be blocked or change shape. Codex HIGH: the original draft missed this, which would cause the old footprint to block the new spill or itself.
3. Evaluate at cell-boundary context. Result is `EvalResult::Scalar(v)` or `EvalResult::Array(a)`.
4. **Scalar path:** existing path. `put_computed` at the cell.
5. **Array path:**
   a. Compute spill target rectangle `(row..row+a.rows, col..col+a.cols)`.
   b. **Bounds check:** range must fit within `MAX_ROW` / `MAX_COLUMN`. Out-of-bounds → `Value::Error(ErrorValue::Spill)` at anchor; no targets registered, no overlays written.
   c. **Degenerate check:** `a.is_degenerate()` (rows=0 or cols=0) → `Value::Error(ErrorValue::Calc)` at anchor. Degenerate-array origin is a function-eval contract (e.g. `FILTER` with all-false mask without `if_empty`); the runtime DOES NOT convert this to `#SPILL!`.
   d. **Blocking check (§ 9):** scan target range; any non-anchor cell occupied → `Value::Error(ErrorValue::Spill)` at anchor; no targets registered, no overlays written.
   e. **Register + write:** `workbook.register_spill(anchor, shape)?` then `put_computed_at` for each cell in the rectangle.
6. Op log: emit `Op::PutFormula { text }` only. The spill range is re-derived at replay time via recompute.

### 8.2 Anchor formula uniqueness

Per Excel canon: only the anchor cell has a formula. The other cells in the spill range have NO formula entry. `iter_formulas()` returns only the anchor. Step (5e) above writes ONLY to computed overlays at the target cells — no `put_formula` for non-anchor cells.

When the user types into a cell within a spill range, the spill is invalidated (§ 10).

### 8.3 Re-eval invariant

Step (2) is the heart of correct re-evaluation. The invariant is: **before any cell-boundary eval, the OLD spill state at that anchor MUST be cleared.** This guarantees:

- Shape changes (`=SEQUENCE(5)` → `=SEQUENCE(3)`) work: old A4/A5 entries cleared before new shape evaluates.
- Self-blocking is impossible: the new eval can't see its own old footprint as occupied.
- Blocked re-evaluation also clears the old footprint, so `=SEQUENCE(5)` followed by typing into A3 (which blocks the spill, anchor → `#SPILL!`) doesn't leave stale A1, A2 entries.

If the formula is removed entirely (`clear_formula`), step (2) still runs — the spill is cleared. The formula text removal then leaves the anchor cell blank.

## 9. Spill blocking + `#SPILL!`

### 9.1 Blocking conditions (precedence order)

The anchor evaluates to `Value::Error(ErrorValue::Spill)` when ANY of, in checked order:

1. **Bounds:** spill range extends beyond `MAX_ROW` / `MAX_COLUMN`. (§ 8.1 step b.)
2. **Occupied target cells:** for each non-anchor cell `(s, r, c)` in the target rectangle, ANY of:
   - User overlay non-blank (user-typed value).
   - Computed overlay non-blank AND the cell is NOT a current target of this same anchor (since step 8.1(2) cleared the old footprint, this means another formula's computed output OR another spill anchor's target lives there).
   - Anchor for another spill (`workbook.spill_anchor_at(s, r, c).is_some()`).

Degenerate arrays (rows=0 or cols=0) are NOT a blocking case — they're `#CALC!` per § 8.1 step c. This distinction matters because degenerate-shape origins are function-eval contracts (`FILTER` with all-false mask) and should surface that contract's error, not `#SPILL!`.

### 9.2 What happens at the anchor

When blocked: anchor cell gets `Value::Error(ErrorValue::Spill)` in computed overlay. NO entries added to `spill_anchors`. NO target overlays written. The formula text stays at the anchor (so re-eval after the blocker clears can spill correctly).

### 9.3 `ErrorValue::Spill` — ALREADY IN PLACE

`ErrorValue::Spill` at `crates/ql-types/src/error.rs:38` exists with canonical `"#SPILL!"` sigil + round-trip through `CellWireValue::Error`. Phase 4.7 does NOT add this variant — it consumes it. Codex LOW: original draft incorrectly listed this as new work.

### 9.4 Test surface

- `{1,2;3,4}` at A1 with `B2 = 5` typed → blocked → `A1 = #SPILL!`. **NB:** the 2×2 spill from A1 covers A1:B2 (columns 0-1, rows 0-1); `B2` is in-range. Codex LOW fixed: original draft used `D1` as the blocker, but D1 (column 3) is outside the 2×2 footprint.
- `=SEQUENCE(2,2)` at A1 (clear range) → spills 2×2 → A1=1, B1=2, A2=3, B2=4.
- After spilling, the user types `5` at B2 → spill invalidated → A1 re-evaluates → step 8.1(2) clears A1..B2 → step 8.1(5d) detects B2 has user `5` → A1 = `#SPILL!`.
- After the blocker clears (B2 cleared) → re-recompute → spill restored.
- `FILTER({1;2;3}, {FALSE;FALSE;FALSE})` (degenerate result) without `if_empty` → `#CALC!`, NOT `#SPILL!`.
- `=SEQUENCE(3)` at row `MAX_ROW - 1` → out-of-bounds spill → `#SPILL!`.

## 10. Spill invalidation (calcgraph) — REDESIGN per Codex HIGH

### 10.1 Producer-alias model (LAZY, no parallel adjacency)

Codex HIGH: the original draft's "parallel `outgoing_spill_targets` adjacency + eager `CellNode` creation" plan was incompatible with the existing calcgraph scheduler. `outgoing` edges mean "formula DEPENDS ON producer." Adding spill-target CellNodes as eager nodes that mimic formula nodes would either lose ordering or schedule non-formula targets through Tarjan.

**Revised model:** spill targets are PRODUCER ALIASES at dep-extraction time.

```
Spill anchor at A1: SEQUENCE(3) → produces A1, A2, A3.
Reader formula at B1: =A2 + 1.

Old (wrong) model:
  CellNode(A2) added to graph; outgoing edge from CellNode(A2) → FormulaNode(A1).
  B1 depends on CellNode(A2), which dirties on CellNode(A2)-touch.

New (right) model:
  No CellNode for A2 created on spill. A2 lives only in the computed overlay.
  When B1's deps are extracted: B1 references A2.
    Check workbook.spill_target_anchor(A2) → Some(A1).
    Resolve the dep target to FormulaNode(A1).
    Edge: FormulaNode(B1) → FormulaNode(A1).
  Now B1 is downstream of A1; A1 dirties → B1 dirties; correct.
```

The CHANGE is in dep extraction (called from `extract_and_register_deps` in `calcgraph_session.rs`). Code path:

```rust
// In dep extraction:
fn resolve_cell_dep(workbook: &Workbook, cell: (SheetId, RowId, ColId)) -> CellOrFormulaNode {
    if let Some(anchor) = workbook.spill_target_anchor(cell.0, cell.1, cell.2) {
        // Cell is a spill target — depend on the anchor's formula node.
        CellOrFormulaNode::Formula(anchor_to_node_id(anchor))
    } else {
        // Regular cell.
        CellOrFormulaNode::Cell(cell)
    }
}
```

No new node types. No parallel adjacency. No eager CellNode creation. Lazy — only readers of spill targets get the rerouted edge.

### 10.2 When a user writes into a spill target

`WorkbookRuntime::set_value(s, r, c, v)`:

1. Check `workbook.spill_target_anchor(s, r, c)`. If `Some(anchor)`:
   a. Mark the anchor's formula node dirty.
   b. DO NOT unregister yet — the next `recompute_dirty` will re-evaluate the anchor, see the user value at this cell as a blocker (§ 9.1), and emit `#SPILL!` (which calls `clear_spill_at` per step 8.1(2)).
2. Apply the user write normally (clears computed overlay at this cell, writes user overlay).

### 10.3 When a spill anchor's formula is cleared

`WorkbookRuntime::clear_formula(s, r, c)` on an anchor cell:

1. If `workbook.spill_anchor_at(s, r, c).is_some()`:
   a. `workbook.clear_spill_at((s, r, c))` — clears target computed overlays AND removes anchor + target map entries.
2. Apply the formula clear normally.

### 10.4 PlanCache invalidation

Spill-anchor changes don't affect plan binding (the formula text + sheet + name generation determine the plan). The producer-alias rewiring happens at dep-extraction time, AFTER binding. Existing W5-91/W5-93 invalidation rules suffice.

### 10.5 Re-extraction trigger

When a spill anchor's footprint CHANGES (shape resize), readers whose extracted deps were rerouted via the OLD footprint must re-extract. Two options:

- **Option a:** invalidate ALL readers transitively. Big hammer; correct but pessimistic.
- **Option b:** maintain a reverse map `cell → readers` so we can target invalidation.

**Decision:** Option a for v1 (matches the existing `name_gen` invalidation cadence at edit-rate). Per-spill reverse mapping is a future polish item.

## 11. Sub-phase split — REORDERED per Codex MEDIUM

Codex MEDIUM: settle graph + function ABI BEFORE runtime work. Revised order moves the function-ABI unification and calcgraph producer-alias logic ahead of runtime spill writeback. Each sub-phase ships independently (1 commit + 7 gates green) with self-audit; Codex pull-ups at major milestones; Sonnet at most ships.

| # | Sub-phase | Subject | Audit |
|---|---|---|---|
| 0 | **4.7.AA** (W5-94) | This design doc + Codex review (doc-only) | Codex review (done) |
| 1 | **4.7.A** (W5-95) | `ArrayValue` in `ql-types` + module wiring | Self + Sonnet |
| 2 | **4.7.B** (W5-96) | Unified `FunctionFn` ABI in `ql-functions`; legacy tier adapters | Self + Sonnet + **Codex pull-up** |
| 3 | **4.7.C** (W5-97) | Lexer: `{`, `}` tokens; array-context `,` / `;`; error-literal token | Self + Sonnet |
| 4 | **4.7.D** (W5-98) | Parser: `Expr::Array` construction with arity check + `ParseError::ArrayRowArityMismatch` | Self + Sonnet |
| 5 | **4.7.E** (W5-99) | Printer: `Expr::Array` round-trip | Self only |
| 6 | **4.7.F** (W5-100) | Binder: `Expr::Array` → `ExprPlan::Array` lowering + `BindError::ArrayRowArityMismatch` (NOT panic) | Self + Sonnet |
| 7 | **4.7.G** (W5-101) | Evaluator: `EvalResult::Array(ArrayValue)`; array-in-scalar-context → `#CALC!`; array-in-aggregate-context feeds cells | Self + Sonnet |
| 8 | **4.7.H** (W5-102) | `SpillAnchorTable` storage (map-only) + `Workbook::clear_spill_at` (overlay-aware) | Self + Sonnet |
| 9 | **4.7.I** (W5-103) | Calcgraph: producer-alias dep extraction (lazy, no new nodes) | Self + Sonnet + **Codex pull-up** |
| 10 | **4.7.J** (W5-104) | Runtime `set_formula` array path: clear-old → eval → bounds → degenerate → block → register-and-write | Self + Sonnet |
| 11 | **4.7.K** (W5-105) | Runtime `set_value` + `clear_formula` spill invalidation | Self + Sonnet |
| 12 | **4.7.L** (W5-106) | Persistence save-side: skip cells inside an active spill range; round-trip via recompute | Self + Sonnet |
| 13 | **4.7.M** (W5-107) | First dynamic-array function: `SEQUENCE` | Self only |
| 14 | **4.7.N** (W5-108) | Second + third dynamic-array functions: `FILTER`, `TRANSPOSE` | Self only |
| 15 | **4.7.O** (W5-109) | Closing mega-audit (Codex + Sonnet parallel) | **Codex + Sonnet** |

16 sub-phases (15 implementation + 1 design). Estimated 2-3 weeks at prior pace.

**Stop conditions** (defer remaining to a Phase 4.7 polish wave):
- If 4.7.B function-ABI unification surfaces a deeper API problem, halt and re-design.
- If 4.7.H storage model proves wrong at runtime time, revisit before 4.7.J.
- If 4.7.I producer-alias model surfaces a graph-correctness regression, revisit § 10.

## 12. Op log + persistence — REDESIGN per Codex HIGH

### 12.1 Op log impact

NO new variants. Array formulas use existing `Op::PutFormula { text }`. Re-evaluation at replay time produces the correct spill state because spill anchors are runtime-derived.

### 12.2 .qbook persistence — save-side spill-target skip

Codex HIGH: the original "no schema bump because computed overlay round-trips" claim was false. Current `.qbook` save emits non-formula non-blank cells as user-overlay records (see `qbook_format.rs` save loop). If a spill produces values at A2..A5 (from `=SEQUENCE(5)` at A1), those cells currently have no formula but have computed-overlay values. On reload (without spill anchor awareness), each non-formula cell record gets routed to USER overlay, which would then BLOCK the anchor at re-recompute time.

**Revised save path (no schema bump):**

For each cell `(s, r, c)`:
- If the cell is the anchor (`workbook.spill_anchor_at(s, r, c).is_some()`): emit the formula record normally (anchor has the formula).
- If the cell is a spill TARGET but not the anchor (`spill_target_anchor(s, r, c).is_some()` AND not anchor): **SKIP the cell entirely**. Reload will re-derive via `recompute_all`.
- Else: existing user-overlay save path.

This requires the saver to consult `spill_target_anchor` per cell — cheap (one HashMap lookup per cell).

`WORKBOOK_SCHEMA_VERSION` stays at 5. The skip is a behavioral fix, not a wire-format change.

**Edge case:** a `.qbook` saved by a pre-W5-107 reader (no skip logic) WOULD include the spill-target cells as user records. On load, recompute_all re-evaluates the formula, sees the user blocker(s), and emits `#SPILL!` at the anchor. This is a regression for "saved-before-fix files loaded after-fix" — documented as a known transitional gap, not a closure-blocker.

### 12.3 Round-trip semantics

Load → recompute → check: the spill anchor + targets + computed overlays match the pre-save state. This is a Phase 4.7.L acceptance test.

### 12.4 Future polish: explicit spill metadata

A future v6 schema bump COULD persist `SpillAnchorTable` directly so reload doesn't need to recompute. Benefits: load-without-recompute scenarios (Phase 5 read-only viewers). Defer until the use case is real.

## 13. Function library — first wave

Each function specifies argument validation + output shape + error precedence per Codex MEDIUM.

### 13.1 SEQUENCE

`SEQUENCE(rows, [cols], [start], [step])` — generates a `rows × cols` array of arithmetic-progression numbers.

**Arguments:**
- `rows` (required, number, coerced to positive integer floor): if `< 1` → `Value::Error(ErrorValue::Num)`. Excel canon: `SEQUENCE(0)` is `#NUM!`.
- `cols` (optional, default 1, same validation as `rows`).
- `start` (optional, default 1, any number).
- `step` (optional, default 1, any number).

**Argument-error precedence (left-to-right):** `#VALUE!` if any arg fails coercion; `#NUM!` if `rows < 1` or `cols < 1`. Otherwise produces an array.

**Examples:**
- `SEQUENCE(5)` → 5×1 of `[1, 2, 3, 4, 5]`.
- `SEQUENCE(2, 3)` → 2×3: `[[1, 2, 3], [4, 5, 6]]` (row-major fill).
- `SEQUENCE(2, 3, 10, 5)` → 2×3 starting at 10, step 5: `[[10, 15, 20], [25, 30, 35]]`.
- `SEQUENCE(0)` → `#NUM!`.

### 13.2 FILTER

`FILTER(array, include, [if_empty])` — applies a boolean mask along the first axis.

**Arguments:**
- `array` (required, FunctionArg::Array or ::Range — both 2D shapes).
- `include` (required, same shape OR 1D matching one axis of `array`):
  - If `array` is N×M and `include` is N×1: filter rows where include[i]=TRUE.
  - If `array` is N×M and `include` is 1×M: filter columns where include[j]=TRUE.
  - If `include` is N×M (same shape as array): cell-wise filter — Phase 4.10 (out of scope for 4.7).
- `if_empty` (optional, scalar): returned if no `include` cell is TRUE; default is `#CALC!`.

**Argument-error precedence:** `#VALUE!` on shape mismatch (include axis doesn't match either array axis); `#CALC!` if no TRUE values AND no `if_empty` provided; result with `if_empty` value as a 1×1 array if all-FALSE AND `if_empty` provided.

**Mask orientation:** if `include` is 1D (vector), match by length. `FILTER({1;2;3;4;5}, {TRUE;FALSE;TRUE;FALSE;TRUE})` → 3×1 `[1; 3; 5]`. Horizontal mask `{TRUE,FALSE,...}` matches column-count.

**Examples:**
- `FILTER({1,2,3,4,5}, {TRUE,FALSE,TRUE,FALSE,TRUE})` → 1×3 `[1, 3, 5]`.
- `FILTER({1;2;3;4;5}, {TRUE;FALSE;TRUE;FALSE;TRUE})` → 3×1 `[1; 3; 5]`.
- `FILTER({1;2;3}, {FALSE;FALSE;FALSE})` → `#CALC!`.
- `FILTER({1;2;3}, {FALSE;FALSE;FALSE}, "none")` → 1×1 `["none"]`.

### 13.3 TRANSPOSE

`TRANSPOSE(array)` — swaps rows/cols. Closes the array-eval surface symmetrically.

**Arguments:**
- `array` (required, FunctionArg::Array or ::Range).

**Output shape:** input N×M → output M×N. Cell `(i, j)` in input maps to `(j, i)` in output.

**Argument-error precedence:** `#VALUE!` on non-array input (e.g. a scalar `Number`). No error for degenerate inputs (transpose of 0×N is N×0).

**Examples:**
- `TRANSPOSE({1,2,3})` (1×3) → 3×1 `[1; 2; 3]`.
- `TRANSPOSE({1,2;3,4})` (2×2) → 2×2 `[1, 3; 2, 4]`.

### 13.4 Deferred for Phase 4.10

UNIQUE, SORT, SORTBY, RANDARRAY — straightforward extensions once the array dispatch ABI proves itself in Phase 4.7.M + N.

## 14. Risks + known unknowns (post-Codex)

### 14.1 Storage layer Result-vs-Panic

`Workbook::register_spill` returns `Result<(), SpillBlockError>`. Runtime pre-validates + maps to `RuntimeError::Spill`. No silent failures. Pattern matches W5-93 sheet-name validation.

### 14.2 Calcgraph nodes for spill targets — DECIDED LAZY

Per § 10.1 producer-alias model: spill targets do NOT get CellNodes. The graph stays formula-node-heavy. Codex HIGH closed the original "eager" decision.

### 14.3 Iteration order at recompute

The producer-alias model makes the dependency chain explicit: `B3 (reads A3) → A1_FormulaNode (spill anchor)`. Tarjan walks this normally. The chain pretends A3's value is "owned" by the anchor's formula node — symmetric to a range read (`B3 reads A1:A10`) which also depends on each individual cell-or-formula in the range.

**Verified analogy:** existing range deps work this way. `StripeIndex` tracks "which formulas depend on which (sheet, row/col)" — when A3 is touched, B3 (a reader of A3) gets dirtied via the stripe index. The new behavior: when A3 becomes a spill target, B3's NEXT dep-extraction reroutes A3 → A1. Until B3's deps are re-extracted, the stripe-based dirty propagation still works (touching A3 dirties B3, which then re-extracts and finds the rerouted edge).

### 14.4 Function ABI — DECIDED UNIFIED STORAGE + TAGGED DISPATCH

Per § 6.2 (and W5-96 implementation): collapse the three parallel HashMaps in `FunctionRegistry` into one storage map keyed by name and valued by the `RegisteredFn` tagged enum. Legacy `register` / `register_range_aware` / `register_context_aware` helpers preserved and store the appropriate `RegisteredFn::*` variant; new array-returning functions register via `register_unified`. Eval site dispatches via `lookup_any` and a single match-on-tier (target: W5-101 / Phase 4.7.G).

Codex pull-up review of W5-96 confirmed the storage-unification win, flagged the doc-vs-impl drift (the original draft said "shim adapters" but the implementation uses tagged dispatch instead — back-ported here), and accepted "full adapter normalization" as a future polish item if the eval-site arms grow unwieldy.

### 14.5 Implicit intersection (Phase 4.9)

Excel 365+ dynamic arrays canonicalize "array in non-array context → spill or `@`". Legacy Excel canonicalizes "array in scalar context → implicit intersection with caller's row/col". Quantbook v1 Phase 4.7 chooses neither: array-in-scalar-context → `#CALC!` (§ 6.3). This is a defensible safe default; Phase 4.9 lights up `@` syntax + an `xls_calc` mode toggle.

### 14.6 Re-extraction on spill shape change

Per § 10.5: invalidate ALL readers transitively when a spill anchor's footprint changes. Big hammer at edit rate; acceptable per the existing W5-91 rename invalidation pattern. Per-spill reverse mapping deferred.

### 14.7 Pre-W5-107 saved files

A `.qbook` saved by pre-W5-107 code (no skip logic per § 12.2) contains spill-target cells as user-overlay records. Post-W5-107 load → recompute_all sees user blockers → emits `#SPILL!` at the anchor. Documented transitional gap; not a closure-blocker.

## 15. What's NOT in scope

- Array constants with cell refs inside: `{A1, B1; A2, B2}` (Phase 4.10).
- Implicit intersection / `@` operator (Phase 4.9).
- Array operators (`A1:A10 + 1` broadcasting) (Phase 4.10 — needs separate "scalar broadcast across array" semantics).
- UNIQUE / SORT / SORTBY / RANDARRAY (Phase 4.10).
- xlsx import / export of array formulas (Phase 4.11).
- Cross-sheet spill ranges (rare in Excel; Phase 4.7 stays single-sheet).
- N/A padding for arity-mismatched literals (Phase 4.10 polish).

## 16. Decisions made post-Codex review (formerly "open questions")

All five open questions from the original draft were RESOLVED by Codex's review. Documented here for posterity:

1. **Q (graph):** parallel `outgoing_spill_targets` adjacency vs combined `outgoing`?
   **A:** NEITHER. Producer-alias model in dep extraction (§ 10.1) — no new adjacency, no new node types.

2. **Q (function ABI):** new `ArrayFn` tier vs unify?
   **A:** UNIFY. Single `FunctionFn` ABI in `ql-functions` (§ 6.2). Legacy tier helpers preserved as adapters.

3. **Q (cellnodes):** eager vs lazy?
   **A:** LAZY (§ 14.2). No CellNode creation for spill targets.

4. **Q (dep extraction):** binder + dirty propagator strong enough already?
   **A:** NO — dep extraction needs the producer-alias rewrite (§ 10.1). Adding `spill_target_anchor` lookup to extraction is the key change.

5. **Q (array literal cells):** constants-only vs allow refs?
   **A:** Constants + error literals only in v1. Refs deferred to Phase 4.10 (§ 3.3).

## 17. Approval status

This revision incorporates all 5 HIGH + 4 MEDIUM + 3 LOW Codex findings. Doc-only ship as W5-94. Sub-phase 4.7.A (W5-95) — `ArrayValue` in `ql-types` — opens the implementation arc.
