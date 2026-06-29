# Phase 4.4 Coercion + Error Semantics Matrix — Design Decision

**Date:** 2026-05-13 (W5-63)
**Branch:** `feat/quantbook-engine`
**Status:** DESIGN (pre-implementation, Codex-reviewed). Implementation in subsequent session.
**Pattern:** W5-49 architectural-decision pattern (Plan + Codex review BEFORE code). Codex review complete; this doc incorporates the 3 HIGH + 4 MEDIUM + 3 LOW findings. Full review at `docs/audits/2026-05-13-w5-63-codex-coercion-review.txt`.

**Rule labels used throughout this doc:**
- `[CANON]` — Excel canon. Must match Excel's documented behavior.
- `[CURRENT]` — Current Quantbook behavior. Verified in code as of W5-62. May be CANON or DIVERGENCE.
- `[V1-DIV]` — Intentional V1 divergence from Excel canon. Documented in `excel-matrix.md`; tests pin it.
- `[FUTURE]` — Aspirational behavior; not implemented yet. Gated on a named gap (e.g. GAP-F-06 COUNT provenance). _(FN4-03 lazy IF/IFERROR — the former example here — landed in w142.)_

---

## 1. Why this phase

`docs/MASTER-PLAN.md` Phase 4.4 is "Coercion + Error Semantics Matrix". The recommendation in the W5-62 handoff lists it as the immediately-next architectural beat. Two observations from auditing W5-49 → W5-62 motivate the scope:

1. **Existing coercion code is well-built but ad-hoc helpers have proliferated.** `ql-types::coercion` centralizes 5 public functions (`to_number_strict`, `to_number_lenient`, `to_logical`, `to_text_for_display`, `to_text_for_formula`, plus the `sanitize_f64` overflow leaf). However, three private helpers (`scalar_fns::coerce_numeric` (×2 — duplicated across `scalar_fns.rs` and `range_fns.rs`), `scalar_fns::coerce_text`, `scalar_fns::coerce_int_arg`) wrap the centralized fns to support function-arg patterns that the central module doesn't directly express (Blank-skip in aggregates, position/length integer extraction, text-result fallback). These helpers are correct individually but have drifted slightly between callers — e.g. the W5-60 audit caught that not all 2D-shape-aware fns handled `FnArg::Range` vs `FnArg::Scalar` consistently.

2. **No compatibility matrix for error semantics.** The Excel canon for "which error wins when X happens" is implicit in our code and split across function bodies. `docs/compat/excel-matrix.md` covers per-function semantics but not the cross-cutting error-precedence rules (e.g., does a divide-by-zero inside a `#REF!` arg propagate the `#REF!` or short-circuit to `#DIV/0!`?). The W5-52, W5-60, W5-62 audits each surfaced at least one error-handling miss that a matrix would have caught earlier.

The phase **NOT in scope for v1** is: dates / number formats / locale (Phase 4.5). The matrix's coercion rows assume invariant ASCII, no locale.

## 2. Current state — what we have today

### 2.1 Centralized in `ql-types::coercion` (754 lines)

```rust
pub fn to_number_strict(v: &Value) -> Result<f64, ErrorValue>;   // Text → #VALUE!
pub fn to_number_lenient(v: &Value) -> Result<f64, ErrorValue>;  // Text → parse, else #VALUE!
pub fn to_logical(v: &Value) -> Result<bool, ErrorValue>;        // Text "TRUE"/"FALSE" only
pub fn to_text_for_display(v: &Value) -> String;                 // infallible; Error→sigil
pub fn to_text_for_formula(v: &Value) -> Result<String, ErrorValue>;  // Error propagates
pub fn sanitize_f64(n: f64) -> Result<f64, ErrorValue>;          // overflow/NaN → #NUM!
```

These are tested at 47 unit-test sites in `coercion::tests`. The contract is solid: Blank→0/false/"", Number passthrough (NaN/Inf→#NUM!), Bool→1/0 or TRUE/FALSE, Text strict/lenient as documented, Error propagates uniformly.

### 2.2 Private helpers in `ql-functions::scalar_fns` (3 helpers)

- `coerce_numeric(v: &Value) -> NumericArg` — wraps `to_number_strict` with `NumericArg::{Number, Skip, Error}` to distinguish Blank-skip in aggregates from Error.
- `coerce_text(v: &Value) -> Result<String, ErrorValue>` — like `to_text_for_formula` but Number renders via `format_number_for_text` (custom integer-rendering rule: no trailing `.0`, but matches Display for non-integers).
- `coerce_int_arg(v: &Value) -> Result<i64, ErrorValue>` — for position/length args: Number truncates toward zero, Bool→0/1, Blank→0, Text→lenient-parse-truncate-or-#VALUE!, Error propagates.

### 2.3 Private helper in `ql-functions::range_fns` (1 helper, DUPLICATE of `scalar_fns::coerce_numeric`)

Bytewise identical implementation; lives separately because `range_fns.rs` is a separate module. This is the most obvious cleanup target.

### 2.4 Context-specific coercion patterns scattered across fns

- **`Predicate::matches`** (range_fns): does its own per-type matching against Value variants. Touches the coercion contract indirectly through `apply_text_cmp` (uppercase folding).
- **`format_number_for_text`** (scalar_fns:1361): converts Number to text via integer-rendering-without-trailing-.0 rule. Used by CONCATENATE / CONCAT / FIND/SEARCH coercion paths.
- **`value_to_concat_text`** (range_fns:1411, W5-61): CONCAT-specific text coercion. Functionally equivalent to `coerce_text` but reimplemented inside range_fns to avoid cross-crate private import.

## 3. Cross-cutting rules — the matrix

### 3.1 Type-pair coercion matrix

`Value` has 5 variants (`value.rs:29`). The matrix expands them to **9 input cases** by splitting finite vs non-finite Number and parseable vs unparseable Text — the input cases that actually drive distinct coercion outcomes:

| Input variant     | strict numeric | lenient numeric | logical                       | display text  | formula text |
|-------------------|----------------|------------------|-------------------------------|---------------|--------------|
| `Blank`           | `0.0`          | `0.0`            | `false`                       | `""`          | `Ok("")`     |
| `Number(n)` finite| `Ok(n)`        | `Ok(n)`          | `Ok(n != 0.0)`                | `"n"`         | `Ok("n")`    |
| `Number(NaN)`     | `Err(#NUM!)`   | `Err(#NUM!)`     | `Err(#NUM!)`                  | `"NaN"`*      | `Ok("NaN")`* |
| `Number(±Inf)`    | `Err(#NUM!)`   | `Err(#NUM!)`     | `Err(#NUM!)`                  | `"inf"/"-inf"`*| `Ok(same)`* |
| `Boolean(true)`   | `Ok(1.0)`      | `Ok(1.0)`        | `Ok(true)`                    | `"TRUE"`      | `Ok("TRUE")` |
| `Boolean(false)`  | `Ok(0.0)`      | `Ok(0.0)`        | `Ok(false)`                   | `"FALSE"`     | `Ok("FALSE")`|
| `Text(s)` parseable| `Err(#VALUE!)`| `Ok(parsed)`    | `Ok(s=="TRUE"/"FALSE")` else `#VALUE!`| `s`   | `Ok(s)`      |
| `Text(s)` other   | `Err(#VALUE!)` | `Err(#VALUE!)`   | `Err(#VALUE!)`                | `s`           | `Ok(s)`      |
| `Error(e)`        | `Err(e)`       | `Err(e)`         | `Err(e)`                      | `"#sigil!"`   | `Err(e)`     |

`*` — NaN/Inf-rendering by `Display` for `Value::Number` is a latent gap. The `Value::number(n)` safe constructor sanitizes (`value.rs:47`), but the enum variant `Value::Number(f64)` is **public**, so direct construction with `f64::NAN` or `f64::INFINITY` bypasses sanitization. Tests already do this (`value.rs:231`). Numeric and logical coercions handle it (`coercion.rs:29, 53`); text display/formula paths do NOT.

**Policy decision (W5-63 design, post-Codex MEDIUM 1):** During Phase 4.4 implementation, `to_text_for_display` and `to_text_for_formula` will gain an explicit NaN/Inf check. NaN/Inf reaching either path returns `"#NUM!"` (the sigil for `to_text_for_display`) or `Err(ErrorValue::Num)` (for `to_text_for_formula`). This treats raw non-finite numbers as "should never happen, but if it does, surface as `#NUM!` rather than render as `NaN` / `inf`." Pinned by tests under sub-phase 4.4.B.

### 3.2 Per-context behavior

A function's choice of coercion depends on **context**:

| Context              | Numeric coercion | Blank handling | Text handling                  | Error handling |
|----------------------|------------------|----------------|--------------------------------|----------------|
| Strict-scalar arg    | strict           | →0             | →#VALUE!                       | propagate      |
| Lenient-scalar arg (operators) | lenient | →0             | parse or #VALUE!               | propagate      |
| Logical arg          | strict           | →false         | "TRUE"/"FALSE" only            | propagate      |
| Range-aggregate cell | strict           | **skip**       | →#VALUE! (Quantbook strict; Excel skips) | propagate      |
| Position/length      | strict-int       | →0             | lenient-parse-truncate or #VALUE!| propagate    |
| Text-formula arg     | n/a              | →""            | passthrough                    | propagate      |
| Concat arg           | strict           | →""            | passthrough                    | propagate      |
| Criteria value (IFS) | (custom)         | special-blank-match | (custom predicates)       | propagate      |

The **Range-aggregate cell** row is the documented Quantbook divergence from Excel (matrix item 4). Excel's SUM(A1:A10) SKIPS text cells; Quantbook returns #VALUE!. This is intentional V1 behavior pinned by tests.

### 3.3 Error-precedence matrix

When multiple error sources combine in one expression, the precedence rule is **first-encountered wins** (left-to-right argument evaluation). The current code generally implements this correctly via Rust's `?` operator on `Result<T, ErrorValue>`, but we have no doc pinning the rule:

| Scenario                                    | Result                | Label    |
|---------------------------------------------|-----------------------|----------|
| `=SUM(A1, B1)` where A1=`#REF!`, B1=`#NUM!` | `#REF!` (first arg)   | [CURRENT][CANON] |
| `="x" + #REF!`                              | `#REF!`               | [CURRENT][CANON] — `eval_binary` (`scalar.rs:240-247`) propagates errors on EITHER operand BEFORE arithmetic coercion. So `Text("x")` never reaches `to_number_lenient`; the `#REF!` on the right wins directly. |
| `=#NUM! + #REF!`                            | `#NUM!` (left-error)  | [CURRENT][CANON] |
| `=A1+B1` where A1=`#DIV/0!`, B1 valid       | `#DIV/0!` propagates  | [CURRENT][CANON] |
| `=IF(#REF!, 1, 2)`                          | `#REF!` (cond error short-circuits) | [CURRENT][CANON] |
| `=IFERROR(#REF!, 0)`                        | `0` (IFERROR catches) | [CURRENT][CANON] — value errored, so the fallback is evaluated and returned. FN4-03 (w142) made this LAZY (the fallback is evaluated ONLY because the value errored; a non-error value returns without evaluating the fallback). Result unchanged. |
| `=ISERROR(#REF!)`                           | `TRUE` (introspection) | [CURRENT][CANON] |
| `=A1/0` where A1=`#REF!`                    | `#REF!` (arg-error beats div-zero) | [CURRENT][CANON] — same `eval_binary` rule. |

The "first arg" rule is consistent with Excel's left-to-right argument evaluation and matches what our binder + dispatcher implement.

### 3.4 Per-function override matrix (Excel-canon-aware)

A small set of functions deliberately deviate from default error propagation:

| Function             | Override                                                            | Label    |
|----------------------|---------------------------------------------------------------------|----------|
| `IF(cond, t, f)`     | Lazy: cond evaluated, then ONLY the selected branch (f skipped if cond=true; t skipped if cond=false). Cond error short-circuits. Result-identical to the prior eager eval. | [CURRENT FN4-03 ✅ w142] |
| `IFERROR(v, on_err)` / `IFNA(v, on_err)` | If v matches (any error / `#N/A`), evaluate & return on_err; else return v WITHOUT evaluating on_err. Result-identical to the prior post-eval introspection. | [CURRENT FN4-03 ✅ w142] |
| `ISERROR(v)`         | Returns TRUE for any error; never propagates.                       | [CURRENT][CANON] |
| `ISNA(v)`            | TRUE only for `#N/A`; other errors → FALSE.                         | [CURRENT][CANON] |
| `ISERR(v)`           | TRUE for any error EXCEPT `#N/A`.                                   | [CURRENT][CANON] |
| `ISNUMBER(v)`        | TRUE for Number, FALSE for everything else INCLUDING errors (Error cells return FALSE, not propagate). | [CURRENT][CANON] |
| `ISTEXT(v)`          | TRUE for Text, FALSE everything else including errors. | [CURRENT][CANON] |
| `ISBLANK(v)`         | TRUE for Blank, FALSE everything else including errors. | [CURRENT][CANON] |
| `ISLOGICAL(v)`       | TRUE for Boolean, FALSE everything else including errors. | [CURRENT][CANON] |
| `COUNT(args...)`     | Counts NUMBER cells; SKIPS errors, blanks, text, bools. Errors do NOT propagate. | [CURRENT][CANON] — verified `scalar_fns.rs::count`. |
| `COUNTA(args...)`    | Counts non-blank cells. **Errors ARE counted** (Excel canon). Diverges from COUNT in this row. | [CURRENT][CANON] — verified `scalar_fns.rs::counta`. |
| `COUNTIF / COUNTIFS` | Error cells in range → NOT counted (Excel canon — does not propagate). | [CURRENT][CANON] |
| `AVERAGE` on empty/all-blank range | `#DIV/0!`                                              | [CURRENT][CANON] |
| `MIN / MAX` on empty/all-blank range | `0` (Excel canon for empty; documented).             | [CURRENT][CANON] |
| `MEDIAN` on empty range | `#NUM!`                                                          | [CURRENT][CANON] |
| `MODE` on no-repeat range | `#N/A`                                                         | [CURRENT][CANON] |
| `MATCH`              | Not found → `#N/A` (not propagation of arg error).                  | [CURRENT][CANON] |
| `VLOOKUP/HLOOKUP`    | Not found → `#N/A`; col_index<1 → #VALUE!; col_index>cols → #REF!.  | [CURRENT][CANON] |
| `INDEX`              | row=0 / col=0 (array spill) → #REF! pending Phase 4.7 array formulas. Out-of-bounds → #REF!. | [CURRENT][V1-DIV — array via #REF!] |
| `CHOOSE`             | Returns the SELECTED scalar arg's value (any error → propagates as that error; non-selected args' errors are ignored due to pre-eval... wait, ARGS are pre-eval, so any error in any arg propagates first). **Verify in implementation.** | [CURRENT] under-pinned |
| `LARGE / SMALL`      | Range-aware. Strict numeric — text in range → `#VALUE!`. k out of bounds → `#NUM!`. | [CURRENT][V1-DIV] |
| `RANK / RANK.EQ`     | Range-aware. Value not in ref → `#N/A`. Empty ref → `#N/A`.         | [CURRENT][CANON] |
| `RANK.AVG`           | Same as RANK but average-of-tied-ranks (W5-61).                     | [CURRENT][CANON] |
| `TYPE(v)` (Excel)    | Returns 1/2/4/8/16/64 for type identification. **NOT REGISTERED** in Quantbook V1. | [FUTURE] |
| `NA()` (Excel)       | Returns `#N/A`. **NOT REGISTERED** in Quantbook V1.                 | [FUTURE] |
| `ERROR.TYPE(v)` (Excel) | Returns 1-7 for error type. **NOT REGISTERED** in Quantbook V1.  | [FUTURE] |
| `AGGREGATE/SUBTOTAL` | Ignore-errors options. **NOT REGISTERED** in Quantbook V1.          | [FUTURE Phase 4.10] |

## 4. Decision — proposed structure

### 4.1 Goal

Make the existing centralized coercion module sufficient for every function-arg pattern, eliminate duplication, and **pin the matrix as enforceable tests**.

### 4.2 Migration plan (3 sub-phases, each shippable independently)

**Sub-phase 4.4.A — Promote private helpers to `ql-types::coercion`:**

1. Move `coerce_text` (Number-as-integer-or-Display-text variant) to `ql-types::coercion` as `to_text_for_arg`. Distinct from `to_text_for_formula`: this variant propagates errors AND uses the integer-rendering rule (`format_number_for_text`'s `< 1e15` guard).
2. Move `coerce_int_arg` to `ql-types::coercion` as `to_int_arg`.
3. **(Codex MEDIUM 3 fix)** Move `NumericArg` + `coerce_numeric` (the aggregate-with-skip variant) to `ql-types::coercion` as a **neutral** API: `pub fn to_number_strict_skip_blank(v: &Value) -> Result<Option<f64>, ErrorValue>`. `Ok(Some(n))` = Number, `Ok(None)` = Blank-skip, `Err(e)` = Error. This avoids leaking "aggregate" terminology into `ql-types` (which should remain function-agnostic). The function-specific `NumericArg` enum stays out of `ql-types`; if a caller still wants the match-friendly shape, it can `match` on the Result.
4. Update `scalar_fns.rs` + `range_fns.rs` to import from the central module. **DELETE** the duplicate `coerce_numeric` in `range_fns.rs`.
5. Audit each call site after migration: verify behavior preservation. Workspace tests must remain byte-for-byte identical (1297+).

**Sub-phase 4.4.B — Build the cross-cutting matrix as test cases:**

1. New test file: `crates/ql-types/tests/coercion_matrix.rs`. Each row of the §3.1 type-pair table (across the 5 input cases × 5 coercion contexts) becomes a test assertion, ~80 with edge variants. Tests are tagged by name: `*_canon_*` for Excel-canon-aligned rows, `*_v1_divergence_*` for known divergences.
2. New test file: `crates/ql-exec/tests/error_precedence.rs`. Each row of §3.3 becomes an end-to-end formula test through `WorkbookRuntime`.
3. New test file: `crates/ql-functions/tests/per_function_overrides.rs`. Each row of §3.4 — drives the function and asserts the documented override behavior.
4. **(Codex MEDIUM 4 fix)** Coverage check: `crates/ql-functions/tests/coverage.rs` walks the registry's BOTH tables (scalar `fns` AND `range_aware_fns`) and asserts every registered name has at least one matrix-test entry. `FunctionRegistry::names()` currently exposes only scalar names (`registry.rs:115`); the coverage script either uses an extended API (`fn names_all()`) or directly inspects both tables. Without this, new fns landing in `range_aware_fns` (MATCH, VLOOKUP, COUNTIF, RANK, CONCAT, etc.) can slip through without matrix coverage.

**Sub-phase 4.4.C — Add an error-matrix doc:**

1. New doc `docs/compat/error-matrix.md` cross-linked from `excel-matrix.md`. Documents the error-precedence rules + per-function overrides. Replaces the implicit knowledge currently spread across function bodies + commit messages.
2. Update `excel-matrix.md` rows to point at the error-matrix doc for the propagation column where relevant.

### 4.3 Non-goals (deferred)

- **Locale-aware coercion** (thousand separators, decimal comma, currency parsing). Phase 4.5.
- **Date / time coercion** (Excel epoch serials). Phase 4.5.
- **UTF-16 char counting** for text functions. Phase 4.9.
- **Excel's "skip text and blanks in range" canon for SUM/AVERAGE/MIN/MAX**. Documented Quantbook V1 divergence — current behavior propagates `#VALUE!` for any text cell in a range arg (via `coerce_numeric` → `to_number_strict`), while Excel SILENTLY SKIPS text cells in range positions. ERROR cells in range correctly propagate in BOTH Excel and Quantbook — that's not the divergence. Codex review flagged the previous wording in this section was misframed; corrected. Defending V1 behavior: strict-text-in-range is easier for users to debug (no silent type-confusion bug masking), at the cost of one-step-extra to use `=SUMIF(A:A, ">0")` instead of `=SUM(A:A)` over text-bearing ranges.
- ~~**Lazy eval for IF / IFERROR** (FN4-03).~~ ✅ DONE (w142): `scalar.rs::eval_lazy_logical` (IF/IFERROR/IFNA/IFS lazy branch eval). Result-identical; dep discovery unchanged.

### 4.4 What gets shipped THIS session (W5-63 doc-only)

Just this design doc plus:
- Cross-link in `docs/MASTER-PLAN.md` — Phase 4.4 entry references this doc.
- Cross-link in `docs/known-gaps.md` — any active GAP-F entries (lazy eval FN4-03) reference the matrix.
- Cross-link in the handoff doc.

**No code in this session.** Implementation in subsequent session(s).

## 5. Effort estimate

- Sub-phase 4.4.A (helper migration): ~1 session. Mechanical refactor; risk is mostly missed callers + behavior drift.
- Sub-phase 4.4.B (matrix tests): ~1 session. 100+ test assertions; the matrix itself is the test data.
- Sub-phase 4.4.C (error-matrix doc): ~0.5 session. Doc plus the cross-link sweep.

Total: ~2.5 sessions for Phase 4.4 implementation, then Phase 4.4 mega-audit (~0.5 session) per the protocol.

## 6. Risks + stop conditions

| Risk                                                                    | Mitigation                                                     |
|-------------------------------------------------------------------------|----------------------------------------------------------------|
| Promoting helpers breaks subtle behavior (e.g. integer-rendering rule)  | Audit-by-audit migration; workspace test count must hold.      |
| Matrix tests over-pin Quantbook-specific divergences as canon           | Each divergence is doc-tagged; test name includes "divergence". |
| Per-function overrides drift over time                                  | The override test file pins behavior; matrix-coverage report flags new fns missing entries. |
| Lazy eval (FN4-03) interacts with the migration                         | Resolved (w142): lazy eval landed as a separate change (`eval_lazy_logical`); the helper migration was untouched.|

**Stop conditions** — fold this phase if:

1. Codex review identifies a structural error in the matrix (e.g., a coercion rule we got wrong).
2. The helper migration in 4.4.A surfaces a behavior divergence we can't reconcile in <0.5 session (i.e., real semantic difference between the central module + a private helper).
3. The matrix test file (4.4.B) reaches a state where the test grouping no longer reads as a "matrix" — i.e., new rows can't be added without per-function special cases bleeding into the shared helpers. At that point, switch to per-Value-variant batching or split the file.

## 7. Acceptance criteria

For Phase 4.4 implementation to be declared closed:

- [ ] All 4 private helpers (`coerce_numeric` ×2, `coerce_text`, `coerce_int_arg`) consolidated under `ql-types::coercion`.
- [ ] `range_fns.rs` `coerce_numeric` duplicate removed.
- [ ] Workspace test count grew by at least +70 (matrix tests) without regression.
- [ ] `docs/compat/error-matrix.md` exists with §3.3 + §3.4 content.
- [ ] All 7 gates green at every commit in the phase.
- [ ] Phase 4.4 mega-audit (Codex + Sonnet parallel) closure commit.

## 8. Future contexts the matrix should accommodate

The matrix in this doc is **scalar-cell-only**. Several upcoming phases will introduce new coercion contexts. The implementation in 4.4.A/B/C should be structured so these contexts can be added later without re-architecting the centralized module:

- **Array context (Phase 4.7)** — array-formula args produce `Vec<Value>` or 2D `(values, rows, cols)` shapes. Coercion happens cell-by-cell, but error short-circuit semantics differ: one error in an array cell may NOT propagate the whole result if downstream is array-aware (`MULTI-CELL` array formulas).
- **Cross-sheet references (Phase 4.6)** — refs to `Sheet2!A1` should coerce through the same paths as local cells. Today this works because resolution flattens to `Value` before coercion; the matrix doesn't need a new context but the tests should include cross-sheet rows.
- **Python/AI() boundary (Phase 6.4-6.6)** — Python UDF results map back to `Value` via a yet-to-be-defined boundary. The matrix should be the authority for "how a Python `None` / `numpy.nan` / `pandas.NA` becomes a Value." Pre-pin: `None` → `Blank`; `nan` → `Value::Error(#NUM!)`; `pd.NA` → `Blank` (TBD by Phase 6 entry).
- **CRDT replay determinism (Phase 5)** — replaying an op log must produce byte-identical Values. Any coercion path that depends on floating-point fuzzy comparison would break replay. The matrix's `sanitize_f64` + `to_number_*` paths are deterministic today; the test suite should pin replay equivalence as a contract.

## 9. Codex review

**COMPLETED 2026-05-13 W5-63.** Codex returned 3 HIGH + 4 MEDIUM + 3 LOW findings; all incorporated above. Key edits driven by the review:

- **HIGH 1 fix**: `="x" + #REF!` row corrected to deterministic `#REF!` (was ambiguous). `eval_binary` (`scalar.rs:240-247`) propagates errors on EITHER operand before arithmetic coercion.
- **HIGH 2 fix**: SUM/AVERAGE non-goal wording corrected — the divergence is TEXT-in-range, not errors-in-range. Errors propagate correctly in both Excel and Quantbook for range args.
- **HIGH 3 fix**: §3.4 override matrix expanded with COUNT, COUNTA (these diverge from each other on error handling), ISNUMBER/ISTEXT/ISBLANK/ISLOGICAL, CHOOSE, AVERAGE/MIN/MAX/MEDIAN/MODE empty-range cases, LARGE/SMALL strict-range, RANK/RANK.EQ/RANK.AVG. Marked TYPE/NA/ERROR.TYPE as NOT REGISTERED.
- **MEDIUM 1 fix**: NaN/Inf policy decided — text/display paths will map non-finite to `"#NUM!"` / `Err(#NUM!)`.
- **MEDIUM 2 fix**: clarified that `IFERROR(#REF!, 0)` → `0` is CURRENT behavior (introspection works post-eval); FN4-03 is about lazy second-arg eval, NOT this case.
- **MEDIUM 3 fix**: `NumericForAggregate` renamed to neutral `to_number_strict_skip_blank(v) -> Result<Option<f64>, ErrorValue>`. Preserves `ql-types` as function-agnostic.
- **MEDIUM 4 fix**: coverage check covers BOTH `fns` AND `range_aware_fns` tables, not just `FunctionRegistry::names()` (scalar-only).
- **LOW 1 fix**: "seven Value variants" → "9 input cases" (Value has 5 variants; 9 cases after splitting finite/non-finite + parseable/unparseable).
- **LOW 3 fix**: 500-line stop condition replaced with maintainability criterion.

Codex review preserved at `docs/audits/2026-05-13-w5-63-codex-coercion-review.txt`. All 3 HIGH + 4 MEDIUM + 3 LOW findings synthesized into the body of this doc above; W5-63 design ready for implementation.

---

**Provenance:** Authored 2026-05-13 W5-63 session as the immediately-next architectural beat after Phase 4.3 polish wave 1 close. Builds on the W5-62 handoff doc § Next phase recommendation.
