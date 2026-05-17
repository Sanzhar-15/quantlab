# Wave 3 — Reference-tier mini-phase

**Status: SHIPPED** (2026-05-17). Mini-phase RT-V1-01 closed in 10 commits (W5-RT-1 through W5-RT-4.1 + cross-cutting + closure docs) on `feat/quantbook-engine`. Final state: 7 reference-tier fns registered (200 total in default_registry); 3276+ tests passing (+194 from 3082 baseline); 5 audit cycles complete (pre-review + Steps 1-4); 21 HIGH findings closed across cycles + audit transcripts preserved at `docs/audits/2026-05-17-rt-step-{1,2,3,4}-{codex,opus}.md`.

**Status history:**
- **2026-05-17, v1**: design draft 1; parallel Codex + Opus pre-review (44 findings: 8 HIGH + 11 MEDIUM + 13 LOW after reconciliation).
- **2026-05-17, v2**: design rewritten incorporating all HIGH+MEDIUM closures (see `docs/audits/2026-05-17-reference-tier-pre-review-summary.md` + raw transcripts at `2026-05-17-reference-tier-design-codex.md` + `2026-05-17-reference-tier-design-opus.md`).
- **2026-05-17, Shipped**: Steps 1-4 implementation + Step 5 cross-cutting + Step 6 closure docs landed.

**Spec ID:** RT-V1-01 (reference-tier wave 1, spec doc 01).
**Mini-phase ID:** RT-1.
**Branch:** `feat/quantbook-engine`. Baseline HEAD `8f9b37b5d6d`, 3082 tests, 193 fns.
**Effort:** 3-5 days incl. design pre-review (DONE) + parallel-Codex+Opus post-audit per ship commit.
**Scope:** 7 functions (ROW, COLUMN, ROWS, COLUMNS, ISREF, ISFORMULA, FORMULATEXT).

---

## 0. Context

The Phase 4.10 Wave 2 design doc (2026-05-16) explicitly deferred this work as "Codex HIGH-2: needs a new `FunctionArg::Reference { sheet, row, col }` tier." This doc closes that defer.

Every today-supported function consumes **pre-evaluated values**. The four registered dispatch tiers — `Scalar(ScalarFn)`, `RangeAware(RangeAwareFn)`, `ContextAware(ContextAwareFn)`, `Unified(FunctionFn)` — all receive args after `eval_scalar_with_cache` has converted `ExprPlan::CellRef` → `Value` (via `env.read_cell`). The reference itself (sheet/row/col) and the syntactic *shape* of the source expression are **lost** at the dispatch boundary.

Reference-tier functions need both preserved:

- `ROW(A1)` wants `1`, not value-at-A1.
- `ROW()` with no arg wants the **calling cell**'s row.
- `ROWS(A1:B3)` wants `3` from the range *dimensions*, not by iterating its values.
- `COLUMN(A1)`, `COLUMNS(A1:E1)` — symmetric.
- `ISREF(A1)` wants `TRUE` from the argument's *syntactic shape* — **without evaluating it** (so `ISREF(1/0)` returns FALSE, not `#DIV/0!`).
- `ISFORMULA(A1)` wants to inspect cell A1's *storage* — formula vs literal vs blank.
- `FORMULATEXT(A1)` wants to recover the **canonical source text** of A1's formula (e.g. `"=SUM(B1:B3)"`, with leading `=`).

None of these is expressible against the current dispatch contract.

## 1. Scope

### In scope (7 functions)

| Fn | Excel semantics | IronCalc ref |
|----|-----------------|-------------|
| `ROW([ref])` | 1-based row index of `ref`, or of the calling cell if omitted. `ROW(A1:B3)` returns `1` (top-left row) in scalar context; multi-cell in cell-boundary array context returns `#CALC!` (spill deferred). | `.references/ironcalc/base/src/functions/lookup_and_reference/mod.rs:608` |
| `COLUMN([ref])` | 1-based column index, with same calling-cell-default semantics. Same multi-cell behavior. | `.../mod.rs:636` |
| `ROWS(arg)` | Row count of the arg. `arg` may be a Range, single Reference, OR an array literal (`ROWS({1,2,3;4,5,6}) = 2`). Required arg. | `.../mod.rs:623` |
| `COLUMNS(arg)` | Column count; symmetric. | `.../mod.rs:675` |
| `ISREF(arg)` | `TRUE` iff `arg`'s expression shape is a reference / range / reference-returning fn (none in v1). **Does NOT evaluate `arg`.** | `.references/ironcalc/base/src/functions/information.rs:119` |
| `ISFORMULA(ref)` | `TRUE` iff the cell at `ref` stores a formula (vs literal / blank). Multi-cell range arg → `#N/A`. | `.../information.rs:155` |
| `FORMULATEXT(ref)` | Canonical formula text at `ref` with leading `=`; `#N/A` if no formula OR multi-cell range OR non-reference arg. | `.../mod.rs:850` |

### Out of scope (explicit defer)

- **OFFSET / INDIRECT** — runtime-resolved deps; calcgraph dep extractor needs extension (Phase 4.10 Wave 2 doc Codex HIGH-3 also deferred). Reference-tier infrastructure does not unblock these alone — they additionally need a `walk_plan_for_deps` extension.
- **ADDRESS** — covered by 4.10.G (XLOOKUP/XMATCH+ADDRESS batch), not reference-tier.
- **Array-spilling ROW / COLUMN.** `ROW(A1:A5)` in Excel-365 array context returns a 5-row spill `{1;2;3;4;5}`. Our 4.7 array-eval path is partially wired but ROW/COLUMN spill is not part of v1. **Concrete v1 stance:** ROW/COLUMN with a multi-cell range/array arg returns `#CALC!` at the cell-boundary entry (`eval_at_cell_boundary`), NOT the top-left index. Silent top-left would be wrong-result in modern Excel-compatible workbooks. Scalar-context calls (`=ROW(A1:A5)+0`) still return top-left per Excel pre-365 semantics.
- **CELL / INFO / SHEET / SHEETS / N / TYPE** (info-function neighbors). Some are scalar-tier already; ones needing workbook state land in follow-ups.
- **Reference-returning fns** (OFFSET-class). v1 ABI returns `FunctionReturn::Scalar` only — no new `FunctionReturn::Reference` variant. ISREF on a function call always returns `FALSE` in v1.

## 2. Target functions — semantic detail

### 2.1 ROW / COLUMN

```
ROW()                  → calling-cell row (1-indexed)
ROW(A1)                → 1
ROW($A$1:$B$3)         → 1 in scalar context; #CALC! in cell-boundary array context
ROW(SomeNamedCell)     → row of resolved cell
ROW("text")            → #VALUE!
ROW(1+2)               → #VALUE!
ROW(#REF!)             → #REF!  (error propagation)
ROW(SUM(A1:A3))        → #VALUE!  (no reference-returning fns in v1)
```

COLUMN symmetric. Both take `[ref]` (single optional reference / range). Arity > 1 → `#N/A`.

**Internal vs Excel indexing:** `RowId` and `ColId` are `u32` type aliases, 0-indexed internally (`RowId = 0` means Excel row 1, per `address.rs:21,28`). ROW/COLUMN add `+1` at the function boundary to convert to 1-indexed Excel output.

### 2.2 ROWS / COLUMNS

```
ROWS(A1)                  → 1
ROWS(A1:B3)               → 3
ROWS({1,2,3;4,5,6})       → 2     (array literal — HIGH-C closure)
ROWS(A:A)                 → 1_048_576   (workbook row limit)
ROWS("text")              → #VALUE!
ROWS()                    → #N/A
```

**Whole-column / whole-row math.** Once HIGH-A's binder fix lands, `RangeRef::WholeColumn` resolves in function-arg context to a `Range` with `start_row=0, end_row=MAX_ROW=1_048_575`. The count is `end_row - start_row + 1 = 1_048_576` (inclusive count, not 0→1 offset). Same calc for `COLUMNS(1:1) = 16_384` (`MAX_COLUMN+1 = 16_384`). Pin both as explicit tests.

**Whole-column read-cost avoidance:** `WorkbookEnv::read_range_with_shape` clamps open-ended ranges to populated bounds for aggregates (env.rs:222). For ROWS/COLUMNS we **must NOT** call `read_range_with_shape` — we want the **authored** range, not the clamped one. The materializer for reference-tier fns takes a coordinate-only path: it reads the resolved `Range` from the `ExprPlan::AggregateNameRef.range` or the new `ExprPlan::RangeRef.range` and constructs a `RefArg::Range { range, values: vec![] }` without iterating. ROWS/COLUMNS read `range.end_row - range.start_row + 1` / `range.end_col - range.start_col + 1` directly.

### 2.3 ISREF

```
ISREF(A1)                 → TRUE      (ExprPlan::CellRef)
ISREF(A1:B3)              → TRUE      (ExprPlan::RangeRef OR AggregateNameRef)
ISREF(NamedCell)          → TRUE      (resolves to CellRef-like plan)
ISREF(SUM(A1:A3))         → FALSE     (Function — SUM does not return a reference)
ISREF(1+2)                → FALSE
ISREF(123)                → FALSE
ISREF("text")             → FALSE
ISREF(1/0)                → FALSE     (does NOT evaluate; HIGH-B closure)
ISREF(#REF!)              → FALSE     (#REF! literal is not a reference)
```

**Critical:** ISREF does NOT evaluate its arg. The dispatcher hands ISREF a `RefArg::Shape(plan_kind)` carrying only the plan's variant tag — no `eval_scalar_with_cache` call, no aggregate cache hits, no volatile-fn re-firing. Per HIGH-B closure / Opus Option C two-materializer pattern.

### 2.4 ISFORMULA

```
ISFORMULA(A1)             → TRUE iff A1 contains a formula
ISFORMULA(BlankCell)      → FALSE
ISFORMULA(LiteralCell)    → FALSE
ISFORMULA(A1:B3)          → #N/A   (multi-cell range; per Microsoft canon)
ISFORMULA("text")         → #N/A
ISFORMULA(123)            → #N/A
ISFORMULA(#REF!)          → #REF!  (error propagation)
ISFORMULA(SUM(A1:A3))     → #N/A   (no reference-returning fns in v1)
```

ISFORMULA needs read access to the workbook's storage to query "does cell at (sheet, row, col) hold a formula?". `ReferenceQuery::is_formula_at` provides this (see § 5.5). Today's `CellEnv::read_cell` returns the *evaluated* Value; it does not expose formula-vs-literal distinction.

**Note:** ISFORMULA evaluates value-deps for its arg in v1. A formula-status-only dep kind is a follow-up (see § 8 R8). Acceptable v1 cost: ISFORMULA(A1) recomputes when A1's value changes, even though only A1's *formula-status* matters. Result is still correct.

### 2.5 FORMULATEXT

```
FORMULATEXT(A1)              → "=SUM(B1:B3)" (canonical OR raw printer output + leading `=`; see canonicalization note below)
FORMULATEXT(BlankCell)       → #N/A
FORMULATEXT(LiteralCell)     → #N/A   (no formula)
FORMULATEXT(A1:B3)           → #N/A   (multi-cell; per Microsoft canon; v1 takes IronCalc divergence)
FORMULATEXT("text")          → #N/A
FORMULATEXT(123)             → #N/A
FORMULATEXT(#REF!)           → #REF!  (error propagation)
FORMULATEXT(SUM(A1:A3))      → BIND-FAIL (v1 scope per S1-MED-γ AggregateArg defer; pinned by `formulatext_of_sum_literal_range_bind_fails_v1_scope`)
FORMULATEXT(SUM(NamedRange)) → #N/A    (named-range form works; SUM evaluates eagerly to Scalar; not a reference)
```

**Source-text retention — RESOLVED (HIGH-D closure).** `crates/ql-storage/src/workbook.rs:874` exposes `Workbook::formula_at(sheet, row, col) -> Option<&Arc<str>>` returning the stored formula text. FORMULATEXT prepends `=` at the function boundary and returns the result as `Value::Text`.

**Documented divergence — canonicalization-per-producer-API (S4-HIGH-1 closure):** TWO public producer APIs write formulas and the stored text shape differs:

- **`WorkbookRuntime::set_formula(...)`** canonicalizes via `parse → print_with(...EnUs...)` at `workbook_runtime.rs:573`. FORMULATEXT returns the canonical A1/EnUs printer output with leading `=`.
- **`WorkbookTransaction::put_formula(...)`** (used for paste-block / batch writes per `transaction.rs:5-78`) stores raw user-typed text verbatim. FORMULATEXT returns the raw text with leading `=`.

Both APIs satisfy the leading-`=` invariant. v1 acceptance: this is a known divergence. Both forms parse to the same AST, so the divergence is purely cosmetic (spacing/case in formula text). Alignment is post-RT-V1 work (Opus pre-review S4-HIGH-1 Option 1 or 2 path: canonicalize at FORMULATEXT boundary OR at Transaction).

**Documented divergence from Excel:** we return printer output (canonical or raw, per above), not necessarily the exact user-typed source text. IronCalc also returns canonicalized (English, no spaces). Acceptable v1; not a correctness issue.

**Documented divergence from Excel-365 spill:** Excel-365 dynamic-array FORMULATEXT spills over multi-cell ranges, one formula per cell. v1 stance: multi-cell → `#N/A`, matching IronCalc's divergence. Spill-form FORMULATEXT is a follow-up.

**Producer/replay self-reference divergence (S4-HIGH-2 / parallel to S3-HIGH-5):** `=FORMULATEXT(A1)` typed at A1 returns `#N/A` producer-side (set_formula evaluates BEFORE installing formula text) but the full text replay-side (op-log restores formula_cells BEFORE recompute). Real producer/replay invariant break. Fix is workbook_runtime restructure (pending-formula overlay OR atomic pre-install with rollback); v1 accepts the divergence with explicit pinning tests in `reference_fns_step4_e2e.rs`.

## 3. Current tier architecture (verified 2026-05-17)

`crates/ql-functions/src/registry.rs` holds:

```rust
pub enum RegisteredFn {
    Scalar(ScalarFn),           // fn(&[Value]) -> Value
    RangeAware(RangeAwareFn),   // fn(&[FnArg]) -> Value
    ContextAware(ContextAwareFn), // fn(&[Value], &EvalContext) -> Value
    Unified(FunctionFn),        // fn(&[FunctionArg], &FunctionContext) -> FunctionReturn
}
```

The eval-site dispatcher (`crates/ql-exec/src/scalar.rs:159–317`) walks `ExprPlan::Function { name, args }`, looks up the fn in the registry, then materializes args:

- `RangeAware` path: `AggregateNameRef` / `StructuredRef` → `FnArg::Range { values, rows, cols }`; everything else → `FnArg::Scalar(eval)`.
- `ContextAware` path: every arg → `Value` via `eval`; called with `&EvalContext`.
- `Unified` path: `AggregateNameRef` / `StructuredRef` → `FunctionArg::Range`; `Array` → `FunctionArg::Array`; everything else → `FunctionArg::Scalar(eval)`.
- `Scalar` path: every arg → `Value` via `eval`.

Two pieces of plumbing matter beyond the registry + dispatcher:

- **`crates/ql-exec/src/plan.rs:377` `is_aggregate_function`** — hardcoded list. Its own comment says: *"When Engine Phase 4.3 expands the function library, the metadata moves to per-function FunctionRegistry attributes and this hardcoded matcher goes away entirely."* Reference-tier triggers this migration — but only PARTIALLY (per HIGH-G + MEDIUM-θ): we add the 7 fns to the list AND rename the matcher to reflect its load-bearing role across multiple tiers; full ParamSchema migration is deferred.
- **`ExprPlan::CellRef { sheet, row, col, abs_col, abs_row }`** — already carries everything ROW/COLUMN need for single-cell refs.
- **`ExprPlan::RangeRef { range }`** — **NEW (HIGH-A closure)**: a literal range arg lowered from `Expr::RangeRef` in `BindContext::AggregateArg` OR the new `BindContext::ReferenceArg`. Carries a resolved `ql_types::Range` directly, without requiring a name.

## 4. Design decision (Option D4, post-pre-review)

v1 considered D1 (full ParamSchema), D2 (parallel ReferenceAware tier), D3 (FunctionArg::Reference in Unified). Codex pre-review (MEDIUM-4) proposed **Option D4**: narrow `ArgContract` metadata only for the 7 reference-tier fns. Reconciliation: **adopt D4.**

### D4 — narrow `ArgContract` for the 7 fns

- Add `RegisteredFn::ReferenceAware(ReferenceAwareFn)` variant.
- Each reference-tier fn registers via `register_reference_aware(name, fn, contract)` where `contract: ArgContract` specifies the per-arg materialization shape: `Eager(Value | Range | Reference | Array | Error)` vs `Lazy(Shape)`.
- The 7 fns explicitly enumerate their `ArgContract`:
  - ROW/COLUMN/ROWS/COLUMNS: eager; arg accepts Value | Range | Reference | Array | Error.
  - ISREF: **lazy** — arg accepts Shape (no evaluation).
  - ISFORMULA/FORMULATEXT: eager; arg accepts Reference | Range | Array | Error (Value collapses to `#N/A`).
- `is_aggregate_function` extends to include the 7 fns (per HIGH-A), with the bound invariant test extended to recognize the new tier (HIGH-G).
- Full D1 ParamSchema migration deferred. See § 4.A for triggers.

**Why D4 over D2 (v1's recommendation):** Codex pre-review caught (MEDIUM-4) that pure D2 leaves `is_aggregate_function` as a hardcoded side table — the W5-96 trigger has *already* fired. D4 captures the per-arg-shape metadata that the design fundamentally needs (eager vs lazy is per-fn, not per-tier), without forcing a 193-fn migration. The W5-96 architectural problem ("tier proliferation") is contained: D4 adds ONE tier (ReferenceAware) PLUS one new metadata mechanism (ArgContract) which is itself a partial step toward D1.

**Why D4 over D1:** full D1 is 3-5 days of cross-fn audit (193 fns × verify-schema-matches-actual-behavior) — same effort as the reference-tier mini-phase itself. The D1 migration becomes its own deliberate cycle after we have D4 in production and can learn from it.

### 4.A — D1 migration plan (deferred)

**Triggers (any one fires the migration):**
1. A 6th dispatch tier is proposed (LAMBDA / user-defined fns / fn-as-arg). Adding to the existing 5-tier `RegisteredFn` would push tier-proliferation past the W5-96 threshold.
2. `is_aggregate_function` hardcoded list crosses 50 entries. Today's 35 + reference-tier's 7 = 42. Wave 3 distributions + percentile + correlation/regression remainder + financial follow-ups land at ~70-80.
3. Per-arg position semantics emerge (e.g., XLOOKUP arg 2 is range, args 1/3/4 are scalar, args 5/6 are mode flags). The current all-args-or-none-args treatment doesn't scale.

**Estimated effort:** 3-5 days for the registry restructure + 1-2 days for the cross-fn audit. Total similar to reference-tier itself.

**Scope:**
- Rewrite registry storage to `HashMap<name, (RegisteredFn, ParamSchema)>`.
- Rewrite dispatcher's per-fn arm into one schema-driven loop.
- Migrate `is_aggregate_function` away — the binder consults ParamSchema per-fn.

## 5. ABI (v2 — post-reconciliation)

### 5.1 `RefArg` enum — 6 variants

```rust
/// Argument to a reference-aware function. Materialized by the
/// dispatcher per the fn's `ArgContract` (eager vs lazy).
#[derive(Clone, Debug, PartialEq)]
pub enum RefArg {
    /// A pre-evaluated literal (non-reference, non-error).
    /// Producers: arithmetic exprs, function calls, string literals,
    /// number literals.
    Scalar(Value),
    /// A range argument carrying a resolved `ql_types::Range` directly.
    /// `values` may be empty when the consumer only needs metadata
    /// (ROWS/COLUMNS coordinate-only path).
    Range {
        range: ql_types::Range,
        values: Vec<Value>,
    },
    /// A single-cell reference with both coordinates AND its
    /// dereferenced value. The `Address` carries sheet+row+col.
    Reference {
        address: ql_types::Address,
        value: Value,
    },
    /// An array literal (`{1,2,3;4,5,6}`) — supports ROWS/COLUMNS over arrays.
    Array(ArrayValue),
    /// An error propagated from eager evaluation (e.g., `#REF!` from
    /// a deleted-cell ref). Per-fn impls propagate as the first match arm.
    Error(ErrorValue),
    /// **Lazy:** the plan's syntactic shape, no evaluation done. Only
    /// ISREF uses this variant. `kind` carries enough information for
    /// `kind.is_reference()` to return true/false.
    Shape(PlanKind),
}

/// Tagged enum of plan kinds for ISREF. Carries enough info to
/// distinguish reference / range / function / literal / array.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanKind {
    CellRef,           // ExprPlan::CellRef
    RangeRef,          // ExprPlan::RangeRef or AggregateNameRef or StructuredRef
    Function {         // ExprPlan::Function — name carried for reference-returning-fn check
        returns_reference: bool,
    },
    Literal,           // Number / Bool / String / Array
    Error,             // ExprPlan::Error
}
```

**Rationale for 6 variants:**

- `Scalar(v)`: non-reference, non-error pre-eval'd value. Most ARG_CONTRACT::Eager paths produce this for non-ref args.
- `Range { range, values }`: carries the *resolved* `ql_types::Range`. `values` empty in the coordinate-only path (ROWS/COLUMNS); populated for fns that iterate.
- `Reference { address, value }`: single-cell ref with coordinates + dereferenced value. ROW/COLUMN read `address`; ISFORMULA/FORMULATEXT use `address` to call `ReferenceQuery::is_formula_at` / `formula_text_at`.
- `Array(ArrayValue)`: array literal. ROWS/COLUMNS consume via `shape()`. (HIGH-C closure.)
- `Error(ErrorValue)`: error propagation. (HIGH-F closure.)
- `Shape(PlanKind)`: lazy — only ISREF uses. (HIGH-B closure.)

`v1`'s `Literal` variant is dropped (collapsed into `Scalar` + `Error`). `Scalar` is now the single "non-reference, non-error" variant.

### 5.2 `ReferenceAwareFn` + `ArgContract` + `RefContext`

```rust
pub type ReferenceAwareFn = fn(&[RefArg], &RefContext) -> Value;

/// Per-fn ABI metadata. Today: just the materialization mode.
/// Extended later (per § 4.A trigger 3) for per-arg-position contracts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgContract {
    /// All args eager-evaluated; non-reference args become `Scalar` or
    /// `Error`. Used by ROW, COLUMN, ROWS, COLUMNS, ISFORMULA, FORMULATEXT.
    Eager,
    /// Single-arg fns whose arg is NOT evaluated. The arg becomes
    /// `Shape(PlanKind)`. Used by ISREF.
    LazyShape,
}

/// Call-time context. `formula_cell` reuses the existing
/// `CellEnv::formula_cell_for_sref()` rather than introducing a new
/// `CallSite` type (MEDIUM-β closure).
pub struct RefContext<'a> {
    pub eval_ctx: &'a EvalContext,
    pub formula_cell: Option<ql_types::Address>,  // None in non-cell contexts
    pub workbook: &'a dyn ReferenceQuery,
}
```

### 5.3 Eval-site dispatcher

Inside `eval_scalar_with_cache`'s `ExprPlan::Function { name, args }` arm (scalar.rs:159+), after the existing `match registry.lookup_any(name)` arms:

```rust
Some(RegisteredFn::ReferenceAware(rf)) => {
    let contract = registry.contract_of(name).expect("ReferenceAware fns must have ArgContract");
    let mut ref_args: Vec<RefArg> = Vec::with_capacity(args.len());
    for a in args {
        ref_args.push(match contract {
            ArgContract::Eager => materialize_ref_arg_eager(a, env, registry, cache),
            ArgContract::LazyShape => materialize_ref_arg_lazy(a),
        });
    }
    let ctx = RefContext {
        eval_ctx: env.eval_context(),
        formula_cell: env.formula_cell_for_sref(),
        workbook: env.reference_query(),
    };
    rf(&ref_args, &ctx)
}
```

The two materializers:

```rust
fn materialize_ref_arg_eager<E: CellEnv>(
    plan: &ExprPlan,
    env: &E,
    registry: &FunctionRegistry,
    cache: &dyn AggregateCache,
) -> RefArg {
    match plan {
        ExprPlan::CellRef { sheet, row, col, .. } => {
            let value = env.read_cell(*sheet, *row, *col);
            RefArg::Reference {
                address: ql_types::Address::new(*sheet, *row, *col),
                value,
            }
        }
        // **Coordinate-only** path for ROWS/COLUMNS/ROW/COLUMN — no values read.
        ExprPlan::AggregateNameRef { range, .. } => RefArg::Range {
            range: *range,
            values: vec![],  // ROWS/COLUMNS don't iterate; future iterating fns can re-read.
        },
        ExprPlan::RangeRef { range } => RefArg::Range {
            range: *range,
            values: vec![],
        },
        ExprPlan::StructuredRef { resolved, is_this_row, .. } => {
            match narrow_structured_ref(*resolved, *is_this_row, env) {
                Ok(range) => RefArg::Range { range, values: vec![] },
                Err(ev) => RefArg::Error(ev),
            }
        }
        ExprPlan::Array(rows) => {
            // Materialize cells into an ArrayValue (mirrors Unified-tier path).
            let row_count = rows.len() as u32;
            let col_count = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
            let mut cells: Vec<Value> = Vec::with_capacity((row_count * col_count) as usize);
            for row in rows {
                for cell in row {
                    cells.push(eval_scalar_with_cache(cell, env, registry, cache));
                }
            }
            let av = ql_types::ArrayValue::new(row_count, col_count, cells)
                .expect("ExprPlan::Array passed binder validation");
            RefArg::Array(av)
        }
        ExprPlan::Error(ev) => RefArg::Error(*ev),
        other => {
            let v = eval_scalar_with_cache(other, env, registry, cache);
            match v {
                Value::Error(ev) => RefArg::Error(ev),
                other_value => RefArg::Scalar(other_value),
            }
        }
    }
}

fn materialize_ref_arg_lazy(plan: &ExprPlan) -> RefArg {
    let kind = match plan {
        ExprPlan::CellRef { .. } => PlanKind::CellRef,
        ExprPlan::AggregateNameRef { .. }
        | ExprPlan::RangeRef { .. }
        | ExprPlan::StructuredRef { .. } => PlanKind::RangeRef,
        ExprPlan::Function { .. } => PlanKind::Function {
            returns_reference: false,  // No reference-returning fns in v1.
        },
        ExprPlan::Array(_)
        | ExprPlan::Number(_)
        | ExprPlan::Bool(_)
        | ExprPlan::String(_) => PlanKind::Literal,
        ExprPlan::Binary { .. } | ExprPlan::Unary { .. } => PlanKind::Literal,
        ExprPlan::Error(_) => PlanKind::Error,
    };
    RefArg::Shape(kind)
}
```

**Dep-tracking policy (HIGH-H closure).** `calcgraph_session.rs:walk_plan_for_deps` gets a per-fn-name policy table:

- **ROW / COLUMN / ROWS / COLUMNS / ISREF**: dep-SUPPRESS. The walker recognizes these fn names and does NOT recurse into their args. No value-deps registered. The result depends only on the address/syntactic-shape — neither changes without an explicit structural event (insert row/col), which is a separate dirty trigger out of scope here.
- **ISFORMULA / FORMULATEXT**: dep-NORMAL (v1 cost). Value-deps registered; the formula recomputes on every value change in the referenced cell. Per § 8 R8, a follow-up `formula_status_deps` kind would fix this — out of v1 scope. Documented as known over-recompute.

### 5.4 Binder changes

**Status post-Step 1.1:** *Implementation deviated from this section as originally written; deviations documented inline below. Step 1.1 closures applied. See `docs/audits/2026-05-17-reference-tier-audit-summary.md` cycle 2 for the post-Step-1 audit reconciliation.*

**HIGH-A closure.** Today, `crates/ql-exec/src/plan.rs:636` unconditionally rejects `Expr::RangeRef(_)` outside the `@` implicit-intersection context. Add a new `ExprPlan::RangeRef { range: ql_types::Range }` variant; extend the `Expr::RangeRef` binder arm to lower to it when:

- **`BindContext::AggregateArg`** — supports `SUM(A1:B3)` literal-range. **DEFERRED (S1-MED-γ closure)**: enabling AggregateArg-side `Expr::RangeRef` lowering would also require new `ExprPlan::RangeRef` consumer arms in the Scalar / RangeAware / Unified dispatcher paths (today they expect `AggregateNameRef` for ranges). That cross-tier change is out of scope for the reference-tier mini-phase. Step 1 (and 1.1) accepts literal RangeRef ONLY in `ReferenceArg` context; AggregateArg keeps rejecting per status quo. Tracked as a follow-up post-RT-V1 phase.
- **`BindContext::ReferenceArg`** (NEW context flag) — used inside reference-tier fn arg positions. *Shipped in Step 1.*

The reference-tier-fn binder path:

```rust
// inside Expr::Function binding:
let is_reference_arg = REFERENCE_AWARE_FN_NAMES.contains(&name.as_ref());
let arg_ctx = if is_reference_arg {
    BindContext::ReferenceArg
} else if is_aggregate_function(name) {
    BindContext::AggregateArg
} else {
    BindContext::Scalar
};
for arg in args {
    bound_args.push(bind_with_context_v2(arg, /* …,*/ arg_ctx)?);
}
```

The `REFERENCE_AWARE_FN_NAMES` constant is the 7-name list. Aliased / renamed away from `is_aggregate_function` per HIGH-G — see § 5.4.A.

**Whole-column resolution.** `RangeRef::WholeColumn` in `BindContext::ReferenceArg` resolves to a `Range` with `start_row=0, end_row=MAX_ROW=1_048_575`. `RangeRef::WholeRow` to `start_col=0, end_col=MAX_COLUMN=16_383`. Both AS-AUTHORED, not clamped to populated bounds — see § 2.2.

### 5.4.A `is_aggregate_function` + reference-aware classifier (HIGH-G closure — Step 1.1 revision)

**Status post-Step 1.1:** the design v1's "rename + extend" plan was revised during implementation in favor of a parallel-matcher approach. Documented here as the canonical post-revision design.

The original design v2 § 5.4.A specified: *rename `is_aggregate_function` → `accepts_special_arg_at_bind`, add 7 reference-tier names to the merged list, extend the invariant test with a third loop*. Step 1's Codex+Opus parallel audit (S1-HIGH-D) caught that this rename did not ship; the implementation instead added a **parallel matcher** `is_reference_aware_function(name) -> bool` containing only the 7 reference-tier names, leaving `is_aggregate_function` unchanged.

**Step 1.1 revision (this update):** keep the parallel-matcher approach. Rationale:

1. The three concepts the matcher is load-bearing for — scalar aggregates, range-aware fns, reference-aware fns — have *distinct* binder semantics (AggregateArg vs ReferenceArg context), not just "both accept range args". A merged matcher would need to also expose which-context-applies per name, which is what the parallel-matcher approach already does cleanly via two separate fns.
2. The existing 35-entry invariant test (`is_aggregate_function_lists_only_registered_aggregates`) keeps working unchanged. A parallel test (`accepts_special_arg_lists_only_registered_reference_aware_matcher_pin`) was added in Step 1.1 for the reference-aware tier.
3. Future per-arg-position contracts (XLOOKUP-class — design § 4.A trigger 3) would migrate either matcher to ParamSchema. Doing the rename + merge would just be deleted at that point.

**Shipped in Step 1.1:**

- `is_reference_aware_function(name) -> bool` in `crates/ql-exec/src/plan.rs:501` lists ROW/COLUMN/ROWS/COLUMNS/ISREF/ISFORMULA/FORMULATEXT.
- `accepts_special_arg_lists_only_registered_reference_aware_matcher_pin` invariant test in `crates/ql-exec/src/plan.rs` (test module) — pins matcher contents at Step 1 (matcher-only direction; registry-side direction empty until Step 2 registers the first fn).
- `dep_suppressed_reference_fns_match_design` test in `crates/ql-exec/src/calcgraph_session.rs` (test module) — pins `is_address_only_reference_fn`'s 5-name list.

**Pre-Step-2 closure required:** when Step 2 registers ROW/COLUMN/ROWS/COLUMNS, extend the matcher-pin test with a `reg.lookup_reference_aware(name).is_some()` loop for the registered names. Disjointness (`reg.lookup(name).is_none()` etc.) follows the W5-107 pattern.

### 5.5 `CellEnv` extension — `reference_query()` accessor

```rust
pub trait CellEnv {
    // existing methods…

    /// **W5-NEW (RT-1):** workbook-introspection accessor for
    /// reference-aware fns. Default returns a no-op singleton; only
    /// `WorkbookEnv` overrides with a real `&Workbook`.
    fn reference_query(&self) -> &dyn ReferenceQuery {
        &NoOpReferenceQuery
    }
}

pub trait ReferenceQuery {
    fn is_formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> bool;
    /// Returns the canonical formula text WITH leading `=`, e.g. `"=SUM(B1:B3)"`.
    /// Caller does not prepend `=`; the trait impl does.
    fn formula_text_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<String>;
}

struct NoOpReferenceQuery;
impl ReferenceQuery for NoOpReferenceQuery {
    fn is_formula_at(&self, _: SheetId, _: RowId, _: ColId) -> bool { false }
    fn formula_text_at(&self, _: SheetId, _: RowId, _: ColId) -> Option<String> { None }
}

// **Step 1.1 (S1-MED-ε closure):** the impl lives on `WorkbookEnv` (in
// `ql-exec/src/env.rs`), NOT on `ql_storage::Workbook` directly. Rationale:
// `ReferenceQuery` is defined in `ql-functions`. Impl-ing it on
// `ql_storage::Workbook` would force `ql-storage` to depend on
// `ql-functions` (currently `ql-storage` depends only on `ql-types`).
// Adding that edge wouldn't create a cycle but would couple two
// previously-independent crates. Putting the impl on `WorkbookEnv` (which
// already lives in `ql-exec`, where both `ql-storage` and `ql-functions`
// are already deps) avoids the new graph edge cleanly.

impl<'w> ReferenceQuery for WorkbookEnv<'w> {
    fn is_formula_at(&self, s: SheetId, r: RowId, c: ColId) -> bool {
        self.workbook.formula_at(s, r, c).is_some()
    }
    fn formula_text_at(&self, s: SheetId, r: RowId, c: ColId) -> Option<String> {
        self.workbook.formula_at(s, r, c).map(|arc| {
            let mut out = String::with_capacity(arc.len() + 1);
            out.push('=');
            out.push_str(arc.as_ref());
            out
        })
    }
}

impl<'w> CellEnv for WorkbookEnv<'w> {
    fn reference_query(&self) -> &dyn ReferenceQuery {
        self  // WorkbookEnv impls ReferenceQuery; returned as &dyn.
    }
}
```

`MapEnv` and other test envs inherit the no-op default. Tests that exercise ISFORMULA / FORMULATEXT must use `WorkbookEnv` (already standard for cell-boundary tests).

### 5.6 Per-fn impls (post-pre-review pseudo-code)

All identifiers verified against actual API (LOW/MEDIUM closures): `RowId`/`ColId` are `u32` (no `.0`), `Value::Error(...)` not `Value::error(...)`, `ErrorValue::NA` not `NotApplicable`, `ql_types::Range::start_row` / `end_row` etc.

```rust
fn row(args: &[RefArg], ctx: &RefContext) -> Value {
    match args.len() {
        0 => match ctx.formula_cell {
            Some(addr) => Value::number(addr.row as f64 + 1.0),
            None => Value::Error(ErrorValue::Ref),  // No calling cell available.
        },
        1 => match &args[0] {
            RefArg::Error(ev) => Value::Error(*ev),                       // propagate
            RefArg::Reference { address, .. } => Value::number(address.row as f64 + 1.0),
            RefArg::Range { range, .. } => Value::number(range.start_row as f64 + 1.0),
            RefArg::Array(_) => Value::Error(ErrorValue::Value),          // Excel: arrays aren't refs for ROW
            RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value),
        },
        _ => Value::Error(ErrorValue::NA),
    }
}

fn rows(args: &[RefArg], _: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Range { range, .. }] =>
            Value::number((range.end_row - range.start_row + 1) as f64),
        [RefArg::Reference { .. }] => Value::number(1.0),
        [RefArg::Array(av)] => Value::number(av.shape().0 as f64),   // HIGH-C closure
        [RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::Value),
        _ => Value::Error(ErrorValue::NA),
    }
}

// COLUMN / COLUMNS symmetric — substitute col/start_col/end_col/.1 for row/start_row/end_row/.0.

fn isref(args: &[RefArg], _: &RefContext) -> Value {
    match args {
        [RefArg::Shape(PlanKind::CellRef | PlanKind::RangeRef)] => Value::Boolean(true),
        [RefArg::Shape(PlanKind::Function { returns_reference: true })] => Value::Boolean(true),
        [RefArg::Shape(_)] => Value::Boolean(false),
        _ => Value::Error(ErrorValue::NA),  // arity error
    }
}

fn isformula(args: &[RefArg], ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Reference { address, .. }] =>
            Value::Boolean(ctx.workbook.is_formula_at(address.sheet, address.row, address.col)),
        // Range-as-single-cell — accept if it's a 1×1 range.
        [RefArg::Range { range, .. }] if range.start_row == range.end_row && range.start_col == range.end_col =>
            Value::Boolean(ctx.workbook.is_formula_at(range.sheet, range.start_row, range.start_col)),
        [RefArg::Range { .. }] => Value::Error(ErrorValue::NA),  // multi-cell → #N/A
        [RefArg::Array(_) | RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::NA),
        _ => Value::Error(ErrorValue::NA),
    }
}

fn formulatext(args: &[RefArg], ctx: &RefContext) -> Value {
    match args {
        [RefArg::Error(ev)] => Value::Error(*ev),
        [RefArg::Reference { address, .. }] => {
            match ctx.workbook.formula_text_at(address.sheet, address.row, address.col) {
                Some(text) => Value::Text(text.into()),
                None => Value::Error(ErrorValue::NA),
            }
        }
        [RefArg::Range { range, .. }] if range.start_row == range.end_row && range.start_col == range.end_col => {
            match ctx.workbook.formula_text_at(range.sheet, range.start_row, range.start_col) {
                Some(text) => Value::Text(text.into()),
                None => Value::Error(ErrorValue::NA),
            }
        }
        [RefArg::Range { .. }] => Value::Error(ErrorValue::NA),
        [RefArg::Array(_) | RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::NA),
        _ => Value::Error(ErrorValue::NA),
    }
}
```

**Cell-boundary multi-cell handling** (HIGH-E closure). `eval_at_cell_boundary` for ROW/COLUMN with a multi-cell Range/Array arg returns `Value::Error(ErrorValue::Calc)` (`#CALC!`) BEFORE calling the per-fn impl. Implemented as a dispatcher-side check: if the fn is ROW/COLUMN and the arg materializes to `Range { range, .. }` with `range.start_row != range.end_row OR range.start_col != range.end_col`, OR to `Array(av)` with shape != (1,1), return `#CALC!` at the boundary. Per-fn impl never sees the multi-cell case at the boundary.

In scalar context (`=ROW(A1:A5)+0` as a sub-expression), the per-fn impl runs normally and returns top-left (`1`) — matches Excel pre-365 implicit-intersection semantics.

## 6. Implementation plan

### Step 1 — Infrastructure (one commit)

- Add `RefArg`, `ReferenceAwareFn`, `RefContext`, `ArgContract`, `ReferenceQuery`, `PlanKind`, `NoOpReferenceQuery` in `ql-functions`.
- Add `RegisteredFn::ReferenceAware(ReferenceAwareFn)` variant + `register_reference_aware` (taking name + fn + `ArgContract`) + `lookup_reference_aware` + `contract_of(name)` + `reference_aware_names()` (per MEDIUM-η).
- Add `ExprPlan::RangeRef { range: ql_types::Range }` variant. Extend the `Expr::RangeRef` binder arm to accept `BindContext::AggregateArg | BindContext::ReferenceArg`. Add `BindContext::ReferenceArg` enum variant.
- **Revised per Step 1.1 (S1-HIGH-D):** keep `is_aggregate_function` unchanged; add a **parallel matcher** `is_reference_aware_function` for the 7 names (rationale: § 5.4.A). Add `accepts_special_arg_lists_only_registered_reference_aware_matcher_pin` invariant test (matcher-only direction at Step 1; registry-side direction added in Step 2).
- Add `WorkbookRuntime` / `Workbook` `impl ReferenceQuery`. Extend `CellEnv` with `reference_query()` default no-op + `WorkbookEnv` override.
- Eval-site dispatcher: new arm in `eval_scalar_with_cache` for `ReferenceAware` per § 5.3; `materialize_ref_arg_eager` + `materialize_ref_arg_lazy` helpers.
- Add `walk_plan_for_deps` per-fn-name policy table (dep-suppress for ROW/COLUMN/ROWS/COLUMNS/ISREF). Per HIGH-H.
- Cell-boundary multi-cell `#CALC!` guard at `eval_at_cell_boundary` for ROW/COLUMN. Per HIGH-E.
- No new fns registered yet. Gates green.

### Step 1.A — Parallel Codex + Opus audit of infrastructure commit

The highest-architectural-risk commit. **Mandatory audit BEFORE any user-facing fn registers.** Per MEDIUM-ι.

Prompts go in `docs/audits/.codex-rt-step-1-prompt.md` / Opus brief inline. Outputs: `docs/audits/2026-05-17-rt-step-1-{codex,opus}.md`. Cumulative reconciliation in `docs/audits/2026-05-17-reference-tier-audit-summary.md`.

### Step 2 — Implement ROW + COLUMN + ROWS + COLUMNS (one commit)

- 4 fns. Register through `register_reference_aware(name, fn, ArgContract::Eager)`.
- Each fn: 8+ tests per fn (per MEDIUM-δ) including:
  1. Anchor (e.g., `ROW(B5) = 5`).
  2. Range arg (`ROWS(A1:B3) = 3`).
  3. Named-range arg.
  4. Cross-sheet ref.
  5. Array literal (for ROWS/COLUMNS: `ROWS({1,2,3;4,5,6}) = 2`).
  6. Non-reference (literal / arithmetic).
  7. `#REF!` error propagation.
  8. LibreOffice cross-check.
- Bump `default_registry_has_expected_count` (193 → 197). Per LOW/MEDIUM-9 (math: 193+4=197).
- Add EXPLICITLY_DEFERRED → registered transitions in `coverage.rs`. Per MEDIUM-η.
- Add e2e dispatch tests for each fn in `crates/ql-exec/tests/region_mul2_e2e.rs`.
- Update `docs/compat/excel-matrix.md`.

### Step 2.A — Parallel Codex + Opus audit of range-fn batch

### Step 3 — Implement ISREF + ISFORMULA (one commit)

- ISREF: register with `ArgContract::LazyShape`; receives `RefArg::Shape(_)` only.
- ISFORMULA: register with `ArgContract::Eager`; uses `RefContext::workbook.is_formula_at`.
- 8+ tests per fn including:
  - ISREF: `ISREF(A1)`, `ISREF(A1:B3)`, `ISREF(NamedCell)`, `ISREF(SUM(...))`, `ISREF(1/0)` (no-eval test — per HIGH-B), `ISREF(123)`, `ISREF("text")`, LibreOffice cross-check.
  - ISFORMULA: literal cell, formula cell, blank cell, multi-cell range (→ `#N/A`), cross-sheet, `#REF!` propagation, `ISFORMULA(SUM(A1:A3))` → `#N/A`, LibreOffice cross-check.
- 197 → 199. Matrix.

### Step 3.A — Parallel Codex + Opus audit of info-fn batch

### Step 4 — Implement FORMULATEXT (one commit)

- Register with `ArgContract::Eager`; uses `RefContext::workbook.formula_text_at` (which prepends `=`).
- 8+ tests including:
  - Formula cell (returns `"=SUM(B1:B3)"`).
  - Blank cell (→ `#N/A`).
  - Literal cell (→ `#N/A`).
  - Multi-cell range (→ `#N/A`, IronCalc divergence documented).
  - Cross-sheet.
  - `#REF!` propagation.
  - Leading-`=` verification (test the actual returned string starts with `=`).
  - LibreOffice cross-check.
- 199 → 200.
- Matrix.

### Step 4.A — Parallel Codex + Opus audit of FORMULATEXT

Separated from Step 3.A per MEDIUM-ι — distinct architectural surface (source-text retention).

### Step 5 — Cross-cutting test suite (one commit)

Per MEDIUM-δ: tests that span fn boundaries.

- Structured-ref args: `ROWS(Sales[Qty])` / `ROW(Sales[@Qty])`.
- Implicit-intersection: `=@ROW(A1:A10)`.
- Workbook row-limit: `ROWS(A:A) = 1_048_576`, `COLUMNS(1:1) = 16_384`.
- ISREF no-eval: instrumented test verifying volatile fn is NOT called.
- ISFORMULA on blank cell.
- FORMULATEXT leading-`=` verification.

### Step 6 — Doc + memory + handoff updates

- `docs/audits/2026-05-17-reference-tier-audit-summary.md` → final.
- This design doc status → "Shipped".
- MEMORY.md pointer to new handoff.
- Engine handoff doc updated with W5-RT commit table + closure.

## 7. Test plan

Each function ships with **8+ tests** (per MEDIUM-δ); cross-cutting suite of **6 tests** per Step 5. LibreOffice cross-checks: **2 per fn** (top-left case + edge case).

### Per-fn anchor values (LibreOffice 7.6 default config) — per LOW-4

| Fn | Anchor | Expected |
|----|--------|----------|
| ROW(A1) | — | 1 |
| COLUMN(A1) | — | 1 |
| ROWS(A1:A5) | — | 5 |
| COLUMNS(A1:E1) | — | 5 |
| ISREF(A1) | — | TRUE |
| ISFORMULA(A1) | A1 = `=1+2` | TRUE |
| FORMULATEXT(A1) | A1 = `=1+2` | `"=1+2"` |

### Cross-fn coverage matrix

| Class | Coverage |
|-------|----------|
| Single cell | ROW(A1), COLUMN(A1), ISREF(A1), ISFORMULA(A1), FORMULATEXT(A1) |
| Multi-cell range | ROWS(A1:B3), COLUMNS(A1:B3), ROW(A1:B3) (top-left), COLUMN(A1:B3) (top-left), ISFORMULA(A1:B3) (→ #N/A), FORMULATEXT(A1:B3) (→ #N/A) |
| Whole column/row | ROWS(A:A) = 1_048_576, COLUMNS(1:1) = 16_384 |
| Array literal | ROWS({1,2,3;4,5,6}) = 2, COLUMNS({1,2,3;4,5,6}) = 3 |
| Named-range arg | ROWS(NamedRange), ROW(NamedCell) |
| Structured-ref arg | ROWS(Sales[Qty]), ROW(Sales[@Qty]) |
| Cross-sheet | ISFORMULA(Sheet2!A1), FORMULATEXT(Sheet2!A1), ROW(Sheet2!A1) |
| Implicit-intersection | =@ROW(A1:A10) |
| Error propagation | ROW(#REF!) → #REF!, FORMULATEXT(#REF!) → #REF! |
| ISREF non-eval | ISREF(1/0) returns FALSE without evaluating |
| Cell-boundary spill defer | =ROW(A1:A5) at cell-boundary returns #CALC! |
| Calling-cell | ROW() with formula cell; ROW() without (#REF!) |

E2E dispatch tests in `crates/ql-exec/tests/region_mul2_e2e.rs` — one per fn.

## 8. Risks & open items

### R1 — `ExprPlan::RangeRef` is a new plan variant

Cross-cutting changes:
- `ExprPlan` enum addition (Plan-cache key includes plan tree; same shape change as W5-99's Array addition).
- Binder lowering path.
- Dep extractor: `walk_plan_for_deps` handles the new variant (treat as range dep).
- Plan-cache: `=ROW()` plans are cell-INDEPENDENT (the plan tree is `Function { name: "ROW", args: [] }` regardless of cell). Cell-specific result comes from `env.formula_cell_for_sref()` at evaluation time. No `plan_cache.rs` changes required.
- IDE diagnostic surface `validate_formula` for `=ROW()` zero-arg: per § 7 cross-cutting suite.

### R2 — `is_aggregate_function` rename ripple

The rename touches every call site. Verified call-site count via `grep -rn "is_aggregate_function" crates/` at design time before Step 1.

### R3 — RESOLVED (was: source-text retention)

`Workbook::formula_at` retains canonicalized formula text. FORMULATEXT prepends `=` via `ReferenceQuery::formula_text_at`. No round-trip needed.

### R4 — Documented divergences from Excel canon

- **FORMULATEXT canonicalization**: we return EnUs A1-printed canonical text, not raw user input. Same as IronCalc.
- **FORMULATEXT/ISFORMULA multi-cell**: → `#N/A`. Excel-365 spills; pre-365 implicit-intersects. v1 takes IronCalc's stance.
- **ROW/COLUMN spill**: returns top-left in scalar context (pre-365 Excel); `#CALC!` at cell-boundary array context. Excel-365 spills; v1 defers.

All three documented in `docs/compat/excel-matrix.md`.

### R5 — Calling-cell context lifetime

`RefContext::formula_cell` is `Option<Address>` from `env.formula_cell_for_sref()`. Per MEDIUM-β. Test mocks without formula cells: `ROW()` returns `#REF!`. Already standard for the structured-ref `[@Col]` test pattern.

### R6 — RESOLVED (was: parser zero-arg ROW/COLUMN)

Codex pre-review ran `cargo test -p ql-formula-syntax function_no_args`, passed. The parser accepts zero-arg fns generically (`NOW()` already covers).

### R7 — Op-log replay correctness

`WorkbookRuntime::recompute_dirty` uses `WorkbookEnv::with_formula_cell` (workbook_runtime.rs:3637 per Opus verification). Reference-tier fns work correctly under op-log replay.

### R8 — Formula-status dep kind deferred

ISFORMULA/FORMULATEXT v1 take value-deps as a cost. A new `formula_status_deps: Vec<(SheetId, RowId, ColId)>` dep kind (workbook fires on `on_set_formula` / `on_clear_formula`, NOT on `set_value`) is a follow-up. Pre-condition: a Phase-4.7-tier refactor of the dep-tracking surface. Tracked but out of v1 scope.

### R9 — Dispatcher match-order is style-only

`FunctionRegistry::insert_or_panic` enforces disjointness at registration time. The dispatcher's `match RegisteredFn` arm order is purely readability. Adding `ReferenceAware` before `Scalar` keeps the pattern (RangeAware → ContextAware → Unified → ReferenceAware → Scalar).

## 9. Acceptance criteria

- ROW / COLUMN / ROWS / COLUMNS / ISREF / ISFORMULA / FORMULATEXT all registered, all gates green.
- **193 → 200 registered functions** (+7 new) per LOW/MEDIUM-9 closure.
- Test count up by ≥56 (8 per fn × 7) + 6 cross-cutting = **≥62 new tests**.
- 2 LibreOffice cross-checks per fn (14 total).
- `docs/compat/excel-matrix.md` updated with 7 new rows + documented divergences.
- Cumulative reconciliation summary `docs/audits/2026-05-17-reference-tier-audit-summary.md` published.
- Parallel-Codex+Opus audit applied to **each ship commit** (Steps 1, 2, 3, 4).
- No regressions in existing 193 fns.
- Parallel matcher `is_reference_aware_function` added (Step 1.1 revision: § 5.4.A); invariant test pin shipped at Step 1 (matcher-only); registry-side extension in Step 2.
- Cell-boundary multi-cell `#CALC!` guard for ROW/COLUMN documented + tested.
- Dep-suppress policy for ROW/COLUMN/ROWS/COLUMNS/ISREF documented + tested (recompute-suppression).

## 10. Pre-review closures applied (cross-reference)

See `docs/audits/2026-05-17-reference-tier-pre-review-summary.md` for the full reconciliation. Summary:

| ID | Subject | v2 Section |
|----|---------|-----------|
| HIGH-A | Binder rejects literal `Expr::RangeRef` unconditionally | § 3, § 5.4 |
| HIGH-B | Eager arg evaluation breaks ISREF lazy semantics | § 2.3, § 5.2, § 5.3 |
| HIGH-C | `ROWS`/`COLUMNS` must accept array literals | § 2.2, § 5.1, § 5.6 |
| HIGH-D | FORMULATEXT source-text retention solved | § 2.5, § 5.5, § 8 R3 |
| HIGH-E | ROW/COLUMN multi-cell silent truncation | § 1, § 2.1, § 5.6, § 8 R4 |
| HIGH-F | Error class collapse (`#REF!` → `#VALUE!`) | § 5.1, § 5.6 |
| HIGH-G | `is_aggregate_function` invariant test break | § 5.4.A, § 6 Step 1 |
| HIGH-H | Dep extractor over-tracking | § 5.3, § 8 R8 |
| MEDIUM-α | `RefArg::Literal` collapsed | § 5.1 |
| MEDIUM-β | Reuse `formula_cell_for_sref()` | § 5.2, § 5.5 |
| MEDIUM-γ | Coordinate-only materialization | § 5.3 |
| MEDIUM-δ | Test plan expanded | § 7 |
| MEDIUM-ε | `RefArg::Range` carries `ql_types::Range` | § 5.1 |
| MEDIUM-ζ | `ReferenceQuery` plumbing specified | § 5.5 |
| MEDIUM-η | Per-tier registry iterator + coverage walk | § 6 Step 1 |
| MEDIUM-θ | Option D4 adopted; D1 migration plan | § 4, § 4.A |
| MEDIUM-ι | Audit per-ship-commit | § 6 Step 1.A / 2.A / 3.A / 4.A |
| MEDIUM-1 | FORMULATEXT/ISFORMULA → `#N/A` | § 5.6 |
| LOW-1 to LOW-9 | Pseudo-code identifiers + doc clarity + step naming | § 5.6 + § 6 + § 0 |

---

**Next action:** begin Step 1 (infrastructure commit).
