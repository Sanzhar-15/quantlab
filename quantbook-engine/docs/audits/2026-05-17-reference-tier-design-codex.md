# Codex Pre-Review: Reference-Tier Mini-Phase Design

Reviewed `docs/architecture/2026-05-17-reference-tier-design.md` against the current registry, binder, evaluator, workbook storage, IronCalc port sources, Microsoft support docs, LibreOffice help, and the 2026-05-17 audit-discipline memory.

## HIGH

### HIGH-1 — B1 does not make literal ranges bind

**Where:** design §5.4; `crates/ql-exec/src/plan.rs:636`, `crates/ql-exec/src/plan.rs:643`, `crates/ql-exec/src/plan.rs:751`

**Detail:** The recommended binder strategy says adding ROW/COLUMN/ROWS/COLUMNS/etc. to `is_aggregate_function` is enough for range args. It is not. `Expr::RangeRef(_)` is unconditionally rejected before the function-name context matters (`plan.rs:636`). The aggregate context only affects `Expr::NameRef` that resolves to `ResolvedName::Range` (`plan.rs:751`). Therefore core formulas from the design and Microsoft/LibreOffice canon, including `ROWS(A1:B3)`, `ROW(A1:B3)`, `COLUMNS(C1:E4)`, `ROWS(A:A)`, and cross-sheet literal ranges, would fail at bind time.

**Recommendation:** Do not ship B1 as written. Add a real reference/range bind context or a minimal per-function argument contract so `Expr::RangeRef` can lower to a new coordinate-carrying `ExprPlan` variant in argument positions for these functions. `AggregateNameRef` can remain for named ranges, but literal ranges need their own bind path.

**Severity rationale:** This would make several target functions unusable for their primary syntax, producing bind errors instead of Excel outputs.

### HIGH-2 — ISREF cannot be implemented through the proposed materializer

**Where:** design §2.3, §5.3, §5.6; `crates/ql-exec/src/scalar.rs:325`; `.references/ironcalc/base/src/functions/information.rs:119`; `crates/ql-exec/src/calcgraph_session.rs:230`

**Detail:** The design correctly states that `ISREF` must not evaluate its argument, but the dispatcher sketch still evaluates every non-`CellRef`/`Range` arg via `eval_scalar_with_cache` and wraps it as `RefArg::Literal`. That means `ISREF(SUM(...))`, `ISREF(1/0)`, volatile functions, and future reference-returning functions are all evaluated even though IronCalc shape-checks the AST directly and does not evaluate (`information.rs:119`). The calcgraph walker also descends all function args (`calcgraph_session.rs:230`), so `ISREF(A1)` and `ISREF(RAND())` would get value/volatile dependencies even though their result is syntactic.

**Recommendation:** Treat `ISREF` as a non-evaluating special form in binder/eval, or add argument-contract metadata that can request an unevaluated plan shape. Also add dependency-walker policy so `ISREF` does not register value deps or volatility for its inspected argument.

**Severity rationale:** This changes observable behavior for errors/volatility and creates wrong dependency semantics before OFFSET/INDIRECT even exist.

### HIGH-3 — ROWS/COLUMNS are array functions too

**Where:** design §2.2, §5.1, §5.3, §5.6; `crates/ql-functions/src/registry.rs:63`; Microsoft ROWS/COLUMNS docs; LibreOffice ROWS docs

**Detail:** The design models ROWS/COLUMNS as reference-only. Excel and LibreOffice both define them over references and arrays. Microsoft examples include `ROWS({1,2,3;4,5,6}) = 2` and `COLUMNS({1,2,3;4,5,6}) = 3`; the current engine already has `FunctionArg::Array` for Unified functions (`registry.rs:63`). The proposed `RefArg` has no `Array` variant, and the materializer fallback would evaluate `ExprPlan::Array` in scalar context to `#CALC!`, then ROWS/COLUMNS would likely turn that into `#VALUE!`.

**Recommendation:** Add `RefArg::Array(ArrayValue)` or use a ParamSchema/Unified-derived shape that can preserve array literals. Tests must pin `ROWS({1,2,3;4,5,6})` and `COLUMNS({1,2,3;4,5,6})`.

**Severity rationale:** This is a documented target-function input class, not an edge case.

### HIGH-4 — FORMULATEXT source-text investigation is already answered, but the planned return is wrong

**Where:** design §2.5, §5.5, §5.6, §8 R3; `crates/ql-storage/src/workbook.rs:221`, `crates/ql-storage/src/workbook.rs:253`, `crates/ql-storage/src/workbook.rs:873`; `crates/ql-exec/src/workbook_runtime.rs:571`, `crates/ql-exec/src/workbook_runtime.rs:573`, `crates/ql-exec/src/workbook_runtime.rs:775`

**Detail:** `Workbook` already retains formula text in `formula_cells`; this is not open. `WorkbookRuntime::set_formula` canonicalizes raw text through `parse -> print_with` and stores the canonical body without a leading `=`. `Workbook::formula_at` returns that stored body. FORMULATEXT, however, must return what Excel displays in the formula bar, including the leading `=`. The design sketch returns `formula_text_at` directly, so a stored `SUM(B1:B3)` would likely return `"SUM(B1:B3)"`, not `"=SUM(B1:B3)"`.

**Recommendation:** Define `ReferenceQuery::formula_text_at` as an Excel-facing API that returns the canonical formula with leading `=`, or have `FORMULATEXT` prepend `=` at the function boundary. Document that Quantbook returns canonical A1/En-US printer text, not the exact raw user input.

**Severity rationale:** This would produce visibly incorrect FORMULATEXT output for every formula cell.

### HIGH-5 — FORMULATEXT multi-cell range semantics are wrong against Excel

**Where:** design §2.5, §5.6, §10 question 8; Microsoft FORMULATEXT docs; `.references/ironcalc/base/src/functions/lookup_and_reference/mod.rs:850`

**Detail:** The design says `FORMULATEXT(A1:B3)` errors and states "Excel rules likewise." Microsoft says a row, column, range, or defined name with more than one cell returns the upper-left cell's formula text/value. IronCalc currently errors for multi-cell ranges, but its own comment calls out differences with Excel and has a FIXME around implicit intersection/dynamic arrays (`mod.rs:863`). Following IronCalc here is a known Excel divergence, not canon.

**Recommendation:** Close the divergence for FORMULATEXT now: for multi-cell references, inspect the upper-left cell and return its formula text or `#N/A` if it has no formula. Keep ISFORMULA single-cell-only if desired, but document that separately and test it.

**Severity rationale:** The design's proposed output is wrong for a Microsoft-documented case.

### HIGH-6 — ROW/COLUMN spill defer would silently return the wrong result

**Where:** design §1 out-of-scope, §2.1, §8 R5; `crates/ql-exec/src/scalar.rs:557`; Microsoft ROW/COLUMN docs; LibreOffice ROW/COLUMN help

**Detail:** The design defers array-spilling ROW/COLUMN and says multi-cell ranges return the top-left index. That matches old scalar-context behavior, but the engine already has a cell-boundary spill path (`eval_at_cell_boundary`) and Microsoft 365 / LibreOffice array semantics for `ROW(A1:A5)` and `COLUMN(A1:C1)` return arrays. If the new tier only returns `Value`, top-level `=ROW(A1:A5)` will silently compute `1` instead of spilling `{1;2;3;4;5}` or at least surfacing an explicit unsupported-array error.

**Recommendation:** Either implement ROW/COLUMN as array-returning at the cell boundary for multi-row/multi-column references, or explicitly return `#CALC!` for multi-cell ROW/COLUMN until spill support is added. Do not silently top-left in dynamic-array contexts.

**Severity rationale:** Silent scalar truncation is likely incorrect output in modern Excel-compatible workbooks.

### HIGH-7 — Error arguments are collapsed to `#VALUE!`

**Where:** design §5.3, §5.6; `crates/ql-exec/src/plan.rs:722`; `.references/ironcalc/base/src/cast.rs:310`

**Detail:** Error literals and error-producing expressions fall through to `RefArg::Literal(eval_scalar_with_cache(...))`; the per-function sketches then map `Literal(_)` to `#VALUE!` for ROW/COLUMN/ROWS/COLUMNS/ISFORMULA/FORMULATEXT. IronCalc's `get_reference` propagates evaluated errors before returning "Expected reference", so `ROW(#REF!)` should not become `#VALUE!`. This also matters for stale or invalid references that currently lower to `ExprPlan::Error` (`plan.rs:722`).

**Recommendation:** Split "not a reference" from "evaluated to an error": add `RefArg::Error(ErrorValue)` or preserve `Value::Error` propagation in each function before applying type-mismatch `#VALUE!` rules. Add tests for `ROW(#REF!)`, `ROWS(#REF!)`, and `FORMULATEXT(#REF!)`.

**Severity rationale:** Error-class preservation is user-visible and explicitly called out by the design-review prompt.

## MEDIUM

### MEDIUM-1 — `RefArg::Scalar` is dead weight, while `Literal` is underspecified

**Where:** design §5.1, §5.3, §5.6

**Detail:** In the D2 design, every argument to a ReferenceAware function is materialized by source-plan shape. The sketch never creates `RefArg::Scalar`; non-reference expressions become `Literal`. So `Scalar` is effectively unused for this mini-phase. Meanwhile `Literal(Value)` is overloaded: it means non-reference literal, arithmetic expression, function result, and error result. That overloading causes HIGH-2 and HIGH-7.

**Recommendation:** Replace `Scalar/Literal` with sharper variants, such as `NonReference`, `Value(Value)`, and `Error(ErrorValue)`, or move to per-arg metadata where value-shaped slots are explicit. If the only reference-aware functions are the seven listed, omit `Scalar` until a real caller needs it.

### MEDIUM-2 — `ReferenceQuery` is assigned to the wrong owner

**Where:** design §5.1, §5.5, §6 Step 1; `crates/ql-exec/src/env.rs:23`, `crates/ql-exec/src/env.rs:79`, `crates/ql-exec/src/env.rs:103`, `crates/ql-exec/src/env.rs:281`

**Detail:** The design says `ReferenceQuery` can be implemented by `WorkbookRuntime`, but the dispatcher only receives `env: &E` where `E: CellEnv`; it does not have a `WorkbookRuntime`. The concrete production object at eval time is `WorkbookEnv`, which already wraps `&Workbook` and carries an optional formula cell. `MapEnv` and other test envs currently default only `read_cell`/`eval_context`/`formula_cell_for_sref`. A required `call_site() -> CallSite` also conflicts with non-cell evaluation paths.

**Recommendation:** Put formula query methods on `CellEnv` with safe defaults (`None`/`false`) and override them in `WorkbookEnv`, or make `WorkbookEnv` implement a query trait reachable through `CellEnv`. Reuse/rename `formula_cell_for_sref()` for call-site access instead of adding a second required call-site path.

### MEDIUM-3 — Whole-row/whole-column ranges must avoid value materialization

**Where:** design §2.2, §5.1, §5.3; `crates/ql-exec/src/env.rs:218`

**Detail:** The design says `ROWS(A:A)` should return the workbook row limit, but the materializer sketch calls `read_range_with_shape` for every range. `WorkbookEnv::read_range_with_shape` intentionally clamps open-ended ranges to populated bounds for aggregate scans (`env.rs:222`). The coordinate fields can still produce the right answer if copied from the original `Range`, but materializing values is unnecessary and can be expensive for large populated ranges. It also risks later implementers using the clamped `rows/cols` instead of the authored range bounds.

**Recommendation:** For this mini-phase, make range reference materialization coordinate-only by default. Add values lazily only for a function that actually iterates. Pin `ROWS(A:A) = 1_048_576` and `COLUMNS(1:1) = 16_384` independent of populated sheet bounds.

### MEDIUM-4 — D2 -> D1 migration plan is not concrete enough; use an Option D4

**Where:** design §4, §5.4, §8 R4; `crates/ql-functions/src/context_aware_fns.rs:27`; `crates/ql-functions/src/registry.rs:6`

**Detail:** The codebase already documented that "another tier" was the trigger to refactor, and W5-96 unified registry storage precisely because tier proliferation was a problem. D2 adds a fifth tier and still leaves `is_aggregate_function` as a hardcoded side table. The proposed "migrate later" has no trigger or effort estimate. Full D1 is probably too wide for this mini-phase, but D2 alone is too weak for B1/literal-range/non-evaluating issues.

**Recommendation:** Add Option D4: a narrow `ArgContract`/`ParamSchema` metadata path only for the seven new functions, without migrating all 193 existing functions. It should cover `Reference`, `RangeRef`, `Array`, `UnevaluatedShape`, and `Value`. Trigger full D1 when a second wave needs reference-returning functions or per-arg array/reference behavior beyond these seven. Estimated effort: D4 about 1-2 days; full D1 about 3-5 days plus broad regression tests.

### MEDIUM-5 — Calcgraph dependency policy is missing for reference-inspection functions

**Where:** design §5.3, §8 R1/R5; `crates/ql-exec/src/calcgraph_session.rs:213`

**Detail:** The current dependency walker is value-oriented: any `CellRef` arg registers a cell dependency, any `AggregateNameRef` registers a range dependency, and any function recursively walks all args. For `ROW(A1)` and `COLUMN(A1)`, the value in A1 is irrelevant. For `ISREF(A1)`, even the formula/value in A1 is irrelevant. For `ISFORMULA(A1)` and `FORMULATEXT(A1)`, the dependency is on formula metadata, not just the computed value. The design only mentions OFFSET/INDIRECT dep extraction, but these seven functions already need dependency decisions.

**Recommendation:** Extend the plan walker with function-specific dependency policy. At minimum, skip value deps for `ROW`, `COLUMN`, and `ISREF`; keep conservative deps for `ISFORMULA`/`FORMULATEXT` until formula-metadata invalidation exists; and document that writes which only change formula text must dirty FORMULATEXT/ISFORMULA readers.

### MEDIUM-6 — Test plan is too thin for an architectural tier

**Where:** design §7

**Detail:** Six tests per function is not enough for a new binder/eval/storage tier. The plan bundles cross-sheet, named range, and range variants into one slot, and does not require structured refs, implicit intersection, array constants, error propagation, formula text canonicalization, or whole-row/whole-column bounds.

**Recommendation:** Add a tier-level matrix: literal ranges, named ranges, cross-sheet refs, structured refs (`Sales[Qty]` and `[@Qty]`), `@` implicit intersection, array constants for ROWS/COLUMNS, max bounds, #REF propagation, formula text with leading `=`, non-formula `#N/A`, and recompute/dirty behavior for ISFORMULA/FORMULATEXT.

### MEDIUM-7 — Audit-discipline rule is not applied to each ship commit

**Where:** design §6 Step 3, §6 Step 6; audit memory `quantbook_engine_audit_discipline.md`

**Detail:** The audit rule says run Codex and separate Opus after each coherent unit of work and reconcile HIGH/MEDIUM findings, taking the higher severity on conflicts. The design audits after Step 2 and then combines Steps 4+5. Step 1 is infrastructure-only but is the highest architectural-risk commit; Step 4 and Step 5 are separate semantic surfaces and should not wait for a combined phase-end audit.

**Recommendation:** Require parallel Codex+Opus after Step 1, Step 2, Step 4, and Step 5, or explicitly combine implementation commits before auditing. The status line should also say that each ship commit follows the parallel-audit rule, not only the phase closure.

## LOW

### LOW-1 — Several implementation-sketch identifiers do not match the codebase

**Where:** design §5.3, §5.6; `crates/ql-types/src/address.rs:59`; `crates/ql-types/src/error.rs:22`; `crates/ql-types/src/value.rs:45`

**Detail:** The sketch uses `range.top`, `range.left`, `range.bottom`, `range.right`, but `Range` exposes `start_row`, `start_col`, `end_row`, `end_col` plus `top_left()`/`bottom_right()`. It also uses `Value::error`, `ErrorValue::NotApplicable`, and `ErrorValue::Na`, but the real API is `Value::Error(...)` and `ErrorValue::NA`.

**Recommendation:** Fix the code sketches before implementation so the doc can be followed mechanically.

### LOW-2 — Function-count arithmetic is inconsistent

**Where:** design §6 Step 2, §6 Step 4, §9; `docs/architecture/2026-05-17-reference-tier-design.md:6`

**Detail:** The baseline says 193 functions. Step 2 says 193 -> 197, Step 4 says 197 -> 199, Step 5 says 199 -> 200. The acceptance section says "197 -> 200 registered fns (+7 new)", which drops the actual baseline and makes the +7 arithmetic unclear.

**Recommendation:** State the acceptance as `193 -> 200 registered functions`.

### LOW-3 — Parser zero-arg ROW/COLUMN risk can be closed in the doc

**Where:** design §5.4, §8 R6; `crates/ql-formula-syntax/src/parser.rs:643`; `crates/ql-formula-syntax/src/parser.rs:1749`; `crates/ql-formula-syntax/src/printer.rs:1111`

**Detail:** The parser already accepts zero-argument function calls: `parse_call_args` returns an empty args vector on immediate `)`, and existing tests cover `NOW()`. I also ran `cargo test -p ql-formula-syntax function_no_args`, which passed.

**Recommendation:** Remove R6 as an open risk and replace it with a simple ROW()/COLUMN() regression test requirement.

