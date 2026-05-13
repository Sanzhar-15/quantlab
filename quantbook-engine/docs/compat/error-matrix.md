# Error Semantics + Coercion Matrix

**Phase:** Engine Phase 4.4 (W5-66, 2026-05-13).
**Authoritative design:** `docs/architecture/2026-05-13-coercion-matrix.md`
(the W5-63 Codex-reviewed design doc). This document is the **compat
reference** distilled from that design — one place to look up "what
does this function do when it sees an error" / "which error wins when
multiple sources combine."

**Companion enforceable tests** (W5-65 Phase 4.4.B; each row below has
a matching test):
- Type-pair matrix: `crates/ql-types/tests/coercion_matrix.rs` (46 tests).
- Error precedence E2E: `crates/ql-exec/tests/error_precedence.rs` (15 tests).
- Per-function overrides: `crates/ql-functions/tests/per_function_overrides.rs` (25 tests).
- Coverage guardrail: `crates/ql-functions/tests/coverage.rs` (3 tests; walks both registries).

If a row in this document conflicts with the test, **the test wins**.
File a doc-drift fix.

---

## 1. ErrorValue catalog

| Variant | Sigil | Trigger | Used by |
|---|---|---|---|
| `Ref` | `#REF!` | Reference invalid (deleted col, out-of-grid cell, VLOOKUP col_index > cols) | Binder + VLOOKUP/HLOOKUP/INDEX |
| `Value` | `#VALUE!` | Type-coercion failure; wrong arg count; out-of-spec arg | Coercion paths; arity checks |
| `NA` | `#N/A` | Lookup not found; explicit user-supplied `NA()` (not yet registered) | MATCH, VLOOKUP, RANK, MODE no-repeat |
| `DivZero` | `#DIV/0!` | Divisor is zero; AVERAGE over empty range | Arithmetic; AVERAGE; FLOOR(n,0) for n≠0 |
| `Null` | `#NULL!` | Range intersection empty | Reserved; not produced by V1 |
| `Num` | `#NUM!` | Numeric domain violation; overflow; NaN/Inf at boundary | ASIN/ACOS domain; MROUND signs; W5-64 NaN/Inf policy |
| `Name` | `#NAME?` | Unknown function or unresolved identifier | Binder |
| `Spill` | `#SPILL!` | Array-formula spill blocked | Reserved Phase 4.7 |
| `Calc` | `#CALC!` | Defensive fallback inside eval | Should be rare; binder is supposed to catch first |
| `Disconnected` | `#DISCONNECTED!` | Network / external data unavailable | Reserved Phase 6.5 connectors |
| `Binding` | `#BINDING!` | Late-binding failure | Reserved |
| `Timeout` | `#TIMEOUT!` | Operation cancelled / timed out | Reserved Phase 6.1 |
| `Permission` | `#PERMISSION!` | Auth / capability denied | Reserved Phase 6 |
| `AINotAvailable` | `#AI_NOT_AVAILABLE_V1` | AI() called in V1; provider not configured | `ql-functions::registry::AI` sentinel |
| `Circ` | `#CIRC!` | Circular reference detected | Calcgraph Tarjan SCC |

`ErrorValue::ALL` (in `crates/ql-types/src/error.rs:87`) lists every variant
in the order used by exhaustive `for e in ErrorValue::ALL` test loops.

---

## 2. Error-precedence rules

These rules pin **which error wins** when multiple sources combine in
one expression. All rules verified by `crates/ql-exec/tests/error_precedence.rs`.

| Rule | Result | Verifying test |
|---|---|---|
| `=SUM(A1, B1)` with both errored | First arg wins (left-to-right eval) | `precedence_sum_first_arg_error_wins_canon` |
| `=A1+B1` binary op with error on EITHER operand | Error wins BEFORE coercion (`scalar.rs::eval_binary:240-247`) | `precedence_binary_op_error_propagates_before_coercion_canon` |
| `=#NUM!+#REF!` | Left error wins | `precedence_binary_op_left_error_wins_canon` |
| `=A1+B1` with A1=`#DIV/0!`, B1 valid | A1's error propagates | `precedence_left_div_zero_error_propagates_canon` |
| `=IF(#REF!, t, f)` | Cond error short-circuits to `#REF!` | `precedence_if_cond_error_short_circuits_canon` |
| `=IFERROR(#REF!, fallback)` | Returns fallback via post-eval introspection (NOT lazy 2nd-arg eval — that's FN4-03) | `precedence_iferror_catches_via_post_eval_introspection_canon` |
| `=ISERROR(#REF!)` | TRUE (introspects, never propagates) | `precedence_iserror_introspects_canon` |
| `=A1/0` with A1=`#REF!` | A1's error beats div-zero | `precedence_arg_error_beats_div_zero_canon` |
| Text on one side, Error on other (`=A1+B1` where A1="abc", B1=`#NUM!`) | Error wins (text never reaches coercion) | `precedence_error_wins_over_text_coercion_failure_canon` |
| Lone text-coercion failure (no errors) | `#VALUE!` from coercion | `precedence_lone_text_coercion_failure_is_value_error_canon` |

---

## 3. Per-function override matrix

Each row of this table is enforced by `crates/ql-functions/tests/per_function_overrides.rs`
or — where the override is type-pair-coercion-only — by `crates/ql-types/tests/coercion_matrix.rs`.

Tags:
- 🟢 **canon** — matches Excel.
- 🟡 **divergence** — intentional Quantbook V1 divergence (documented).
- ⚪ **deferred / not registered** — function exists in Excel; not in Quantbook V1.

### 3.1 Aggregates

| Function | Override | Tag | Test |
|---|---|---|---|
| `SUM` | Default; Error propagates from first errored arg; Blank skipped | 🟢 | (coercion_matrix) |
| `AVERAGE` | Default + empty range / all-blank → `#DIV/0!` | 🟢 | `average_empty_args_is_div_zero_canon`, `average_all_blank_args_is_div_zero_canon` |
| `AVG` | Alias of AVERAGE | 🟢 | (covered transitively) |
| `COUNT` | **Skips errors**, blanks, text, bools; counts only Number cells | 🟢 | `count_skips_errors_canon`, `count_skips_text_and_blanks_canon` |
| `COUNTA` | **Counts errors** (diverges from COUNT here); skips only blanks | 🟢 | `counta_counts_errors_canon`, `counta_skips_only_blanks_canon` |
| `MIN` / `MAX` | Empty range → 0 (Excel canon) | 🟢 | — (deferred to 4.4.C completion) |
| `PRODUCT` | Default; blanks skipped | 🟢 | — |
| `VAR` / `VAR.S` / `VAR.P` / `STDEV` / `STDEV.S` / `STDEV.P` | Welford-backed; NIST numacc tests pin precision | 🟢 | (welford module tests) |

### 3.2 Information predicates

All predicates **introspect** — never propagate errors.

| Function | Override | Tag | Test |
|---|---|---|---|
| `ISERROR` | TRUE for ANY error; FALSE otherwise | 🟢 | `iserror_true_for_any_error_canon`, `precedence_iserror_introspects_canon` |
| `ISNA` | TRUE only for `#N/A`; other errors → FALSE | 🟢 | `isna_true_only_for_na_canon`, `precedence_isna_distinguishes_na_from_other_errors_canon` |
| `ISERR` | TRUE for any error EXCEPT `#N/A` | 🟢 | `iserr_true_for_all_errors_except_na_canon`, `precedence_iserr_excludes_na_canon` |
| `ISNUMBER` | TRUE only for Number; FALSE everything else INCLUDING errors | 🟢 | `isnumber_introspects_never_propagates_canon` |
| `ISTEXT` | TRUE only for Text | 🟢 | `istext_introspects_never_propagates_canon` |
| `ISBLANK` | TRUE only for Blank; empty-text `""` does NOT count | 🟢 | `isblank_introspects_never_propagates_canon` |
| `ISLOGICAL` | TRUE only for Boolean | 🟢 | `islogical_introspects_never_propagates_canon` |
| `TYPE` | Excel: returns 1/2/4/8/16/64 | ⚪ NOT REGISTERED | — |
| `NA` | Excel: returns `#N/A` | ⚪ NOT REGISTERED | — |
| `ERROR.TYPE` | Excel: returns 1-7 by error type | ⚪ NOT REGISTERED | — |

### 3.3 Logical

| Function | Override | Tag | Test |
|---|---|---|---|
| `IF(cond, t, f)` | Currently EAGER (both branches always evaluated). Cond error short-circuits. | 🟡 (FN4-03 deferred) | `precedence_if_cond_error_short_circuits_canon` |
| `IFERROR(v, on_err)` | Post-eval introspection works correctly today. Lazy second-arg eval is the FN4-03 gap (don't compute on_err when v is non-error). | 🟢 introspection / 🟡 lazy-arg-skip | `precedence_iferror_catches_via_post_eval_introspection_canon`, `precedence_iferror_passes_through_non_error_canon` |
| `AND` / `OR` / `NOT` | Default; deferred to 4.4.C polish | 🟢 (assumed) | — |

### 3.4 Lookup family

| Function | Override | Tag | Test |
|---|---|---|---|
| `MATCH` | Not found → `#N/A` (not propagation of arg error) | 🟢 | `match_not_found_is_na_canon` |
| `VLOOKUP` | col_index<1 → `#VALUE!`; col_index>cols → `#REF!`; not found → `#N/A` | 🟢 | `vlookup_col_index_less_than_one_is_value_canon`, `vlookup_col_index_greater_than_cols_is_ref_canon`, `vlookup_not_found_is_na_canon` |
| `HLOOKUP` | Mirror of VLOOKUP | 🟢 | (via VLOOKUP coverage; tests transitively) |
| `INDEX` | row_num=0 / col_num=0 (array spill) → `#REF!` pending Phase 4.7; out-of-bounds → `#REF!` | 🟡 (V1 array-via-REF) | — |
| `CHOOSE` | Out-of-bounds index → `#VALUE!`; Range arg returns `#VALUE!` (gotcha 16 in audit-protocol) | 🟢 | — |

### 3.5 Stats family

| Function | Override | Tag | Test |
|---|---|---|---|
| `RANK` / `RANK.EQ` | Value not in ref → `#N/A`; empty ref → `#N/A`; ties get same (smallest) rank | 🟢 | `rank_value_not_in_ref_is_na_canon` |
| `RANK.AVG` | Same as RANK but ties get average-of-tied-positions | 🟢 | `rank_avg_value_not_in_ref_is_na_canon` |
| `MEDIAN` | Empty range → `#NUM!`; **text in range → `#VALUE!`** | 🟢 / 🟡 (V1 strict-text) | `median_empty_range_is_num_canon`, `median_text_in_range_v1_divergence_value_error` |
| `MODE` / `MODE.SNGL` | No-repeat → `#N/A`; bit-pattern equality (exact, no epsilon) | 🟢 | `mode_no_repeat_is_na_canon` |
| `LARGE` / `SMALL` | k<1 or k>len → `#NUM!`; **text in range → `#VALUE!`** | 🟢 / 🟡 (V1 strict-text) | `large_k_too_large_is_num_canon`, `small_k_less_than_one_is_num_canon`, `large_text_in_range_v1_divergence_value_error` |

### 3.6 Range-aware aggregates

| Function | Override | Tag | Test |
|---|---|---|---|
| `SUMIF` | Wildcards (W5-61) text-cell-only; **flat-zip when sum_range ≠ range shape** (V1 divergence from Excel anchoring) | 🟢 / 🟡 anchoring | (range_fns + countif wildcard tests) |
| `COUNTIF` | Wildcards (W5-61); error cells in range NOT counted | 🟢 | (range_fns module + wildcard tests) |
| `SUMIFS` / `COUNTIFS` / `AVERAGEIFS` | **Strict 2D shape validation** (W5-60 Codex H2): all criteria_ranges and sum/avg_range must share `(rows, cols)`; mismatch → `#VALUE!` | 🟢 | (range_fns shape tests) |
| `AVERAGEIF` | Same predicate suite as SUMIF; no matches → `#DIV/0!`; flat-zip divergence shared with SUMIF | 🟢 / 🟡 anchoring | — |
| `SUMPRODUCT` | All arrays must share `(rows, cols)` (1×1 broadcast preserved); mismatch → `#VALUE!` | 🟢 | (range_fns shape tests) |

### 3.7 Math + text overrides (highlights)

| Function | Override | Tag |
|---|---|---|
| `CEILING(n, 0)` | Returns 0 (Excel canon) | 🟢 |
| `FLOOR(n, 0)` for n≠0 | Returns `#DIV/0!` (diverges from CEILING in this edge — Excel canon) | 🟢 |
| `MROUND(0, 0)` | Returns 0 | 🟢 |
| `MROUND(n, 0)` for n≠0 | Returns `#NUM!` (W5-60 Sonnet H1 fix) | 🟢 |
| `CEILING.MATH(n, 0, _)` | Returns 0 | 🟢 |
| `FLOOR.MATH(n, 0, _)` for n≠0 | Returns `#DIV/0!` (mirror of FLOOR) | 🟢 |
| `SQRT(negative)` | `#NUM!` | 🟢 |
| `LN/LOG/LOG10(non-positive)` | `#NUM!` | 🟢 |
| `ASIN/ACOS(|x| > 1)` | `#NUM!` | 🟢 |
| `ATANH(|x| ≥ 1)` | `#NUM!` (Excel canon — rejects ±1, not just ±∞) | 🟢 |
| `ATAN2(0, 0)` | `#DIV/0!` | 🟢 |
| `LEN` / `LEFT` / `RIGHT` / `MID` / `FIND` / `SEARCH` | UTF-8 char count (V1); UTF-16 deferred to Phase 4.9 | 🟡 |
| `UPPER` / `LOWER` / `PROPER` | Rust to_uppercase / to_lowercase (Unicode default); `ß → SS` divergence from Excel locale-sensitive | 🟡 |
| `ROUNDUP` / `ROUNDDOWN` | Binary-float, NOT 15-digit display rounding (`ROUNDUP(0.1+0.2, 1) = 0.4` not `0.3`) | 🟡 |
| `SEARCH` | Wildcards (W5-61) via `WildcardPattern::search_in`; Unicode case-expansion divergence in returned position | 🟢 / 🟡 (case-expansion) |
| `CONCATENATE` | Scalar args only; errors propagate; 32K cap not enforced (deferred) | 🟡 |
| `CONCAT` (range-aware) | Range args supported; **32K cap enforced** (W5-62 Codex M3 fix); blanks → "" | 🟢 |
| `REPT` | 32K cap enforced; n<0 → `#VALUE!` | 🟢 |

### 3.8 Volatile

| Function | Override | Tag |
|---|---|---|
| `NOW` / `TODAY` | Non-deterministic; volatile dependency tracking via Phase 3.7 | 🟢 |
| `RAND` / `RANDBETWEEN` | Non-deterministic; deterministic test-seed API exists (`set_test_rng_seed`) | 🟢 |
| `AI` | Returns `#AI_NOT_AVAILABLE_V1` sentinel; provider lands Phase 6.6 | 🟡 (V1 sentinel) |

---

## 4. Type-pair coercion summary (§3.1 distillation)

For function-arg / operator coercion, the central rules live in
`ql-types::coercion`. The full 9-input × 5-context matrix is pinned by
`crates/ql-types/tests/coercion_matrix.rs`. Headline rules:

- **`Blank`** → `0` (numeric), `false` (logical), `""` (text).
- **`Number(NaN/±Inf)`** → `#NUM!` in EVERY context, including text (W5-64 policy).
- **`Boolean(true/false)`** → `1/0` (numeric), passthrough (logical), `"TRUE"/"FALSE"` (text — uppercase canonical).
- **`Text` parseable as number** → `#VALUE!` strict; parses lenient; `#VALUE!` logical unless literal `"TRUE"/"FALSE"`.
- **`Text` unparseable** → `#VALUE!` strict/lenient/logical; passthrough text.
- **`Error(e)`** → propagates `e` in every context except display (which renders the sigil).

Helper API (`ql-types::coercion`):

```rust
pub fn to_number_strict(v: &Value) -> Result<f64, ErrorValue>;
pub fn to_number_lenient(v: &Value) -> Result<f64, ErrorValue>;
pub fn to_number_strict_skip_blank(v: &Value) -> Result<Option<f64>, ErrorValue>;
pub fn to_logical(v: &Value) -> Result<bool, ErrorValue>;
pub fn to_text_for_display(v: &Value) -> String;
pub fn to_text_for_formula(v: &Value) -> Result<String, ErrorValue>;
pub fn to_text_for_arg(v: &Value) -> Result<String, ErrorValue>;
pub fn to_int_arg(v: &Value) -> Result<i64, ErrorValue>;
pub fn format_number_for_arg(n: f64) -> String;
pub fn sanitize_f64(n: f64) -> Result<f64, ErrorValue>;
```

---

## 5. How to use this doc

- **Reference a row** when writing or reviewing code that produces or
  consumes a `Value::Error(_)`. The row tells you which sigil to expect.
- **Adding a new function** with non-default error semantics:
  1. Implement the override in the function body.
  2. Add a test row in `per_function_overrides.rs` tagged `_canon_` or
     `_v1_divergence_`.
  3. Add an entry in this doc under the appropriate § 3.x section.
  4. Add the function to `coverage.rs`'s `EXPECTED_COVERED` list.
- **Discovered a divergence** from Excel canon at runtime: file a row
  in `known-gaps.md` under GAP-F-* with target phase, then update the
  tag here from 🟢 to 🟡.

## 6. Cross-references

- `docs/architecture/2026-05-13-coercion-matrix.md` — authoritative design.
- `docs/compat/excel-matrix.md` — per-function compat status (Status / Tests / Phase).
- `docs/known-gaps.md` — open gaps with target phases.
- `docs/process/audit-protocol.md` § Critical gotchas — gotchas that bite at runtime.
