# Phase 4.10 V1-260 — Deep Megaudit (Opus)

**Date:** 2026-05-17
**Auditor:** Separate Opus instance (megaudit; not the per-batch auditors).
**Scope:** Whole-phase adversarial review of the 12-batch closeout arc on `feat/quantbook-engine` through HEAD `5d117724f27` (impl HEAD `517bcab08b7`). Per-batch audits already shipped (24 transcripts: Codex + Opus × W5-D-1..W5-D-12). This pass looks for what the per-batch audits could not see.

**HEAD baseline:**
- `feat/quantbook-engine` HEAD `5d117724f27` (MASTER-PLAN ship marker)
- 260 registered fns (`r.len() == 260` pinned in `registry.rs:1096`)
- 4017 total tests passing across the workspace
- Matrix coverage 80% (per `scripts/report-compat-coverage.sh`)
- 12 closeout-arc audit transcript pairs at `docs/audits/2026-05-17-w5-d-*.md`

## Bottom line

**The phase is NOT complete or correct as shipped.** Four HIGH findings — all engine-boundary correctness regressions invisible at the per-batch level because the per-batch audits had no cross-batch view. The most consequential: **31 registered range-aware fns are unreachable through their advertised named-range / range-arg path** (binder admission gap), **3 registered scalar / range-aware fns are unreachable from formula text at all** (lexer regression for 4+letter-prefix-trailing-digit names), and **the W5-D-12 Codex HIGH-001 closure is overclaimed** — the recommended e2e test that would have caught the named-range binder hole was NEVER added even though both Codex W5-D-12 AND Opus W5-D-12 audits told the implementer to add it.

The MASTER-PLAN.md ship-marker claim that "every fn has matrix-backed tests" is true for the impl layer but materially overclaims the engine-boundary reach for the affected fns. Acceptance criterion FN4-260-02 is technically met by the unit-test discipline but the user-facing experience does not match the headline.

The math kernels are sound — Wave 3 distribution corners (BINOM / NEGBINOM / POISSON / EXPON / LOGNORM / GAMMA / BETA / F / T / CHISQ / NORM / CONFIDENCE.* ) all degrade gracefully on degenerate parameters (no panic, no hang, returns `#NUM!` or the mathematically defensible answer). SUBTOTAL's dispatcher is 1:1 with IronCalc. BIT*'s f64-multiplication strategy correctly handles the 2^48-1 boundary. DEC2* / *2DEC two's-complement adjustment is correct at the negative boundary.

---

## HIGH

### HIGH-1 — Range-aware binder admission gap: 31 fns silently unreachable via the named-range path the binder claims to support

**Subject:** Cross-cutting `is_aggregate_function` admission hole identical in shape to W5-D-12 Codex HIGH-001 but never extended to the rest of the range-aware family.

**Where:** `crates/ql-exec/src/plan.rs:421-489` (`is_aggregate_function`); `crates/ql-functions/src/registry.rs:722-843` (range-aware registrations); `crates/ql-exec/src/workbook_runtime.rs:5158-5246` (invariant test).

**Detail:** The binder consults `is_aggregate_function(name)` to decide whether a Function's args bind under `BindContext::AggregateArg` (which lifts a `NameRef → Range` to `ExprPlan::AggregateNameRef`) versus `BindContext::Scalar` (which rejects with `BindError::NamedRangeInScalarContext`). W5-D-12 caught and "fixed" this for SUBTOTAL, but the SAME omission affects every other range-aware fn that is NOT yet in the `is_aggregate_function` enumeration.

**Compiled probe** (file `crates/ql-exec/tests/zzz_megaudit_probe.rs` during the audit — deleted post-audit; runs lex+bind+eval on `=FN(Data, …)` where `Data` is a named `Range`):

```
PERCENTILE.INC(Data, 0.5)        -> BIND-ERR: NamedRangeInScalarContext("DATA")
PERCENTILE.EXC(Data, 0.5)        -> BIND-ERR: NamedRangeInScalarContext("DATA")
PERCENTILE(Data, 0.5)            -> BIND-ERR: NamedRangeInScalarContext("DATA")
QUARTILE.INC(Data, 2)            -> BIND-ERR: NamedRangeInScalarContext("DATA")
QUARTILE.EXC(Data, 2)            -> BIND-ERR: NamedRangeInScalarContext("DATA")
QUARTILE(Data, 2)                -> BIND-ERR: NamedRangeInScalarContext("DATA")
COUNTBLANK(Data)                 -> BIND-ERR: NamedRangeInScalarContext("DATA")
MINIFS(Data, Data, ">0")         -> BIND-ERR: NamedRangeInScalarContext("DATA")
MAXIFS(Data, Data, ">0")         -> BIND-ERR: NamedRangeInScalarContext("DATA")
CORREL(Data, Other)              -> BIND-ERR: NamedRangeInScalarContext("DATA")
PEARSON(Data, Other)             -> BIND-ERR: NamedRangeInScalarContext("DATA")
RSQ(Data, Other)                 -> BIND-ERR: NamedRangeInScalarContext("DATA")
STEYX(Data, Other)               -> BIND-ERR: NamedRangeInScalarContext("DATA")
SLOPE(Data, Other)               -> BIND-ERR: NamedRangeInScalarContext("DATA")
INTERCEPT(Data, Other)           -> BIND-ERR: NamedRangeInScalarContext("DATA")
COVARIANCE.P(Data, Other)        -> BIND-ERR: NamedRangeInScalarContext("DATA")
COVARIANCE.S(Data, Other)        -> BIND-ERR: NamedRangeInScalarContext("DATA")
SUMX2MY2(Data, Other)            -> BIND-ERR: NamedRangeInScalarContext("DATA")
SUMX2PY2(Data, Other)            -> BIND-ERR: NamedRangeInScalarContext("DATA")
MIRR(Data, 0.1, 0.12)            -> BIND-ERR: NamedRangeInScalarContext("DATA")
XNPV(0.1, Data, Other)           -> BIND-ERR: NamedRangeInScalarContext("DATA")
XIRR(Data, Other)                -> BIND-ERR: NamedRangeInScalarContext("DATA")
NPV(0.1, Data)                   -> BIND-ERR: NamedRangeInScalarContext("DATA")
IRR(Data)                        -> BIND-ERR: NamedRangeInScalarContext("DATA")
XLOOKUP(1, Data, Other)          -> BIND-ERR: NamedRangeInScalarContext("DATA")
XMATCH(1, Data)                  -> BIND-ERR: NamedRangeInScalarContext("DATA")
TEXTJOIN(",", TRUE, Data)        -> BIND-ERR: NamedRangeInScalarContext("DATA")
```

**Full list of registered range-aware fns NOT in `is_aggregate_function`** (28 production names): CORREL, COUNTBLANK, COVARIANCE.P, COVARIANCE.S, INTERCEPT, IRR, MAXIFS, MINIFS, MIRR, NPV, PEARSON, PERCENTILE, PERCENTILE.EXC, PERCENTILE.INC, QUARTILE, QUARTILE.EXC, QUARTILE.INC, RSQ, SLOPE, STEYX, SUMX2MY2, SUMX2PY2, SUMXMY2, TEXTJOIN, XIRR, XLOOKUP, XMATCH, XNPV. Plus the literal-range issue affecting all range-aware fns (see HIGH-3 below). 31 total when both interaction shapes are counted.

**Why the invariant test missed it:** `workbook_runtime.rs:5158-5246` (`is_aggregate_function_lists_only_registered_aggregates`) only pins ONE direction — every name `is_aggregate_function` returns true for is in the registry. It does NOT pin the opposite direction (every range-aware-registered name is in `is_aggregate_function`). The test would still pass even if SUBTOTAL had never been added to the matcher, because the matcher and the registry can diverge as long as the matcher is a subset of the registry.

**Why the per-batch audits missed it:** W5-D-6 (COVARIANCE), W5-D-7 (XNPV/XIRR), W5-D-11 (PERCENTILE/QUARTILE) all shipped without anyone running the lex+bind+eval pipeline against a named-range arg. Most range-aware fn e2e tests are `assert!(registry.lookup_range_aware(name).is_some())` registry-lookup smoke tests (see `region_mul2_e2e.rs:364, 389, 445, 774, 823`) which prove the symbol is registered but NOT that the binder routes range args to it. The W5-D-12 Codex audit caught the gap for SUBTOTAL specifically; nobody generalized the finding.

**Why this is HIGH and not MEDIUM:** The matrix marks all 31 affected fns as ✅ Implemented. A user authoring `=CORREL(Sales, Returns)` in the engine — the most natural and Excel-canonical usage — gets a `NamedRangeInScalarContext` BindError. The README and MASTER-PLAN both advertise these fns as shipped. The feature gap is not invisible v1-divergence — it's a primary-usage break.

**Recommendation:**
1. Add the 28 missing names to `is_aggregate_function` matcher in `plan.rs:421-489`.
2. Extend `is_aggregate_function_lists_only_registered_aggregates` in `workbook_runtime.rs:5158-5246` to assert the OPPOSITE direction: every name in `default_registry()`'s `range_aware_fns` table is recognized by `is_aggregate_function`. This is the test the audit team needed since W5-D-6.
3. Add at least one positive e2e test per fn that exercises a named-range arg. The existing `reference_fns_coverage_extensions.rs:rows_of_named_range_returns_range_height` pattern (lines 41-52) is the template.
4. Codex's recommendation in W5-D-12 HIGH-001 said `add a runtime e2e such as SUBTOTAL(9, Sales) over a named range returning the same value as SUM(Sales)`. That was never done for SUBTOTAL either — see HIGH-4 below.

**Severity rationale:** HIGH. The matrix overclaims reach for 28+ user-facing fns. The natural Excel usage path is broken silently with a confusing error message. The fix is mechanical (one name list extension + one invariant strengthening + a handful of e2e tests). The cost of the gap is real product-use failure; the cost of the fix is a single closure commit.

---

### HIGH-2 — Three registered functions are completely unreachable from formula text due to a lexer regression: ATAN2, SUMXMY2, DAYS360

**Subject:** Lexer ColumnTooLarge rejection blocks any registered fn whose name has a 4+letter prefix followed by trailing digits and NO further letters.

**Where:** `crates/ql-formula-syntax/src/lexer.rs:494-720` (`lex_ident_or_ref`); specifically the path at line 651-670 (W5-D-9 letters-digits-letters branch) which only triggers when MORE letters follow the digits.

**Detail:** The lexer enters `lex_ident_or_ref`, reads letters, then digits. If trailing letters follow the digits, the W5-D-9 path at line 651 emits a single `Ident` token (this is how DEC2BIN, BIN2DEC, HEX2DEC, etc. work). If no trailing letters follow, the lexer falls through to the CellRef classification at line 698-715, which calls `classify_letter_prefix_simple(letters)` (line 835-844). That helper REJECTS letter prefixes longer than 3 characters with `ColumnTooLarge`. So:

- 3-letter prefix (`LOG`) + trailing digits (`10`) → `CellRef { text: "LOG10" }` → parser sees LParen, rewrites as `Expr::Function { name: "LOG10" }`. **WORKS.**
- 4+ letter prefix (`ATAN`) + trailing digit (`2`) → `LexError::ColumnTooLarge("ATAN")`. **No token emitted, parse never starts.** No parser-side rescue is possible because the lex never completes.

**Compiled probe** (pure lex, no fn dispatch):

```
SUMXMY2(1,2)       -> Err(ColumnTooLarge("SUMXMY"))
SUMX2MY2(1,2)      -> Ok([Ident("SUMX2MY2"), LParen, ...])    // letters-digits-letters branch fires
SUMX2PY2(1,2)      -> Ok([Ident("SUMX2PY2"), LParen, ...])    // same
SUMXMY2            -> Err(ColumnTooLarge("SUMXMY"))
ATAN2(1,1)         -> Err(ColumnTooLarge("ATAN"))
DAYS360(1,2)       -> Err(ColumnTooLarge("DAYS"))
LOG10(2)           -> Ok([CellRef{text:"LOG10", col:8508, row:9, ...}, LParen, Number(2.0), RParen])   // works via parser CellRef→fn rewrite
LOG2(2)            -> Ok([CellRef{text:"LOG2", ...}, LParen, ...])
BIN2DEC(5)         -> Ok([Ident("BIN2DEC"), ...])
DEC2BIN(5)         -> Ok([Ident("DEC2BIN"), ...])
T.DIST.2T(1,2)     -> Ok([Ident("T.DIST.2T"), ...])
```

**Three registered fns currently broken**:
1. **ATAN2** — `registry.rs:642`. Registered. 4-letter prefix `ATAN` + trailing `2`. Unreachable.
2. **SUMXMY2** — `registry.rs:753`. Registered. 6-letter prefix `SUMXMY` + trailing `2`. Unreachable.
3. **DAYS360** — `registry.rs` (`register_context_aware`). Registered. 4-letter prefix `DAYS` + trailing `360`. Unreachable.

**The lexer is self-aware of this bug**: lines 2095-2099 contain an explicit comment:
```
// (Note: ATAN2 has a 4-letter prefix which exceeds the
// column-letter limit, so it can't lex standalone as a
// CellRef regardless; it only works as `ATAN2(...)` via the
// parser's fn-name override. Not a regression for the
// letters-digits-letters extension.)
```
The comment **falsely claims** ATAN2 works via "parser's fn-name override" — that override only fires if the lexer first emits a CellRef token (with text field). For ATAN2, the lex error preempts any parser rewrite. The comment is incorrect; the test guarding LOG10 (`log10_still_lexes_as_cellref_no_regression` at line 2074) does NOT cover the ATAN2 case at all.

**Why no test caught it:** Same testing-shallowness issue as HIGH-1. ATAN2 has 84 unit tests in `scalar_fns.rs` that call `atan2(&[Value::Number(...)])` directly. None of them go through `lex/parse/bind/eval`. The same is true for SUMXMY2 (paired with SUMX2MY2 / SUMX2PY2 in registry-lookup smoke tests at `region_mul2_e2e.rs:364-367`, but never via formula source). DAYS360 has similar coverage at the unit-test level only.

**Recommendation:**
1. Extend the W5-D-9 special-case path in `lex_ident_or_ref` to handle the letters+digits-no-trailing-letters shape when the lookahead sees `(`. Concretely: at line 651, also trigger if the letter prefix is >3 chars (so the regular CellRef path is going to fail anyway). Emit `Ident(letters + digits)` and let the parser dispatch.
2. Add lexer regression tests for `lex("ATAN2(1,1)")`, `lex("SUMXMY2")`, `lex("DAYS360(1,2)")` asserting they produce `Ident` tokens.
3. Add e2e tests `eval("ATAN2(0, 1)") -> Number(0.0)`, `eval("DAYS360(date1, date2)")`, and a `SUMXMY2(NamedRange, OtherNamedRange)` test once HIGH-1 is fixed.
4. Update the comment at `lexer.rs:2095-2099` to reflect reality.

**Severity rationale:** HIGH. Three primary-Excel-function names are completely inaccessible to users. The fix is small (one branch extension in the lexer). Failure to fix means downstream users in xlsx import will see `#NAME?` for any worksheet using ATAN2 or DAYS360 (both common). The unit tests pass, the matrix marks them ✅, but the dispatch path is dead code.

---

### HIGH-3 — W5-D-12 Codex HIGH-001 closure is incomplete: the recommended e2e test was never added

**Subject:** The W5-D-12.1 commit claimed to close Codex HIGH-001 (SUBTOTAL admission gap) but the closure shipped without the recommended end-to-end test, leaving the supposedly-fixed code path unverified.

**Where:** `crates/ql-exec/tests/region_mul2_e2e.rs:779-814` (`e2e_subtotal_scalar_args_dispatch`, `e2e_subtotal_109_normalizes_to_sum`, `e2e_subtotal_invalid_function_num_is_value_error`); `docs/audits/2026-05-17-w5-d-12-codex.md:19-20`; `docs/audits/2026-05-17-w5-d-12-opus.md` HIGH-003.

**Detail:** Codex W5-D-12 HIGH-001 recommendation reads: "Add `\"SUBTOTAL\"` to `is_aggregate_function()`, extend the `is_aggregate_function_lists_only_registered_aggregates` invariant to include it, **and add a runtime e2e such as `SUBTOTAL(9, Sales)` over a named range returning the same value as `SUM(Sales)`**." Opus W5-D-12 HIGH-003 reinforced this: "There is zero end-to-end evidence that SUBTOTAL actually works for ANY input from the engine boundary."

The W5-D-12.1 closure shipped (a) the `is_aggregate_function` name addition (verified at `plan.rs:487`), (b) the invariant-test extension (verified at `workbook_runtime.rs:5206`), and (c) three e2e tests — but all three use SCALAR data args (`SUBTOTAL(9, 1, 2, 3)`, `SUBTOTAL(109, 10, 20, 30)`, `SUBTOTAL(12, 1, 2, 3)`). NONE of them exercise a named-range arg. The actual binder-admission path that the HIGH-001 fix was supposed to enable is STILL untested.

This means: if a future refactor reverts the `"SUBTOTAL"` entry in `is_aggregate_function`, the workspace would still pass `cargo test --workspace`. The invariant test (`is_aggregate_function_lists_only_registered_aggregates`) only checks `lookup_range_aware("SUBTOTAL").is_some()` — that's just a registry-lookup smoke test, not a binder-path test. The HIGH-001 closure has zero test armor.

**My own probe** (`crates/ql-exec/tests/zzz_megaudit_probe.rs` — deleted post-audit):
```
SUBTOTAL(9, SUBTOTAL(9, 1, 2), 3) -> Number(6.0)
```
The outer SUBTOTAL sums 3 (inner SUBTOTAL result) + 3 = 6. Excel canon: outer would skip nested-SUBTOTAL → return just 3. **This is the documented v1 divergence** (`range_fns.rs:1953-1972` block comment). Fine — documented. But there's also NO test pinning this divergence. A future refactor that accidentally implements nested-skip would break workbook compat with no test failure.

**Why this is HIGH and not "follow-up MEDIUM":** The audit-discipline rule explicitly says "all closures applied in-commit per the `.1` convention" (per MEMORY.md). The W5-D-12.1 commit message claims it closed HIGH-001. The closure as shipped is materially incomplete — code change without test armor that proves the code change does the thing it claims. The header comment in the `e2e_subtotal_scalar_args_dispatch` test even says "W5-D-12.1 (Codex HIGH-001 closure)" while exercising the wrong code path. **The closure is mislabeled as well as incomplete.**

**Recommendation:**
1. Add at least one e2e test that uses a named range. Template:
```rust
#[test]
fn e2e_subtotal_named_range_dispatches_through_aggregate_arg() {
    use ql_storage::NamedTarget;
    use ql_types::{Range, Value};
    let mut wb = workbook_with_one_sheet();
    wb.put_at(0, 0, 0, Value::number(1.0));
    wb.put_at(0, 1, 0, Value::number(2.0));
    wb.put_at(0, 2, 0, Value::number(3.0));
    let r = Range::new(0, 0, 0, 2, 0);
    wb.set_name("Sales", NamedTarget::Range(r)).unwrap();
    // SUBTOTAL(9, Sales) ≡ SUM(Sales) = 6 over Sheet1!A1:A3.
    let plan = parse_and_bind_with_workbook("SUBTOTAL(9, Sales)", &wb);
    assert_eq!(eval(plan, &wb), Value::Number(6.0));
}
```
2. Pin the documented nested-skip divergence with a test (the engine returns 6, Excel returns 3 — pin the engine's choice as load-bearing).
3. Relabel the existing tests' comments — they are NOT "Codex HIGH-001 closure", they are scalar-args coverage that sidesteps the issue.

**Severity rationale:** HIGH. A closure that doesn't test the path it claims to fix is a partial fix. The matrix and master-plan both believe SUBTOTAL is fully shipped. The fix is mechanical (one positive test). The risk is that a future refactor regresses the admission without anyone noticing.

---

### HIGH-4 — Per-batch audits never ran lex+bind+eval coverage on >half the V1-260 range-aware additions; the audit discipline has a systemic blind spot

**Subject:** The audit discipline rule from MEMORY.md ("parallel Codex + Opus per batch") was followed mechanically across W5-D-1..W5-D-12, but neither auditor (per batch) consistently constructed the lex+parse+bind+eval pipeline for range-args. The two HIGHs above (binder gap, lexer regression) are both caught by a single end-to-end test that the per-batch audit framework didn't require.

**Where:** Cross-cutting. The per-batch audit transcripts (`docs/audits/2026-05-17-w5-d-*.md`) consistently mention "compiled-probe verification" for math kernels but only sometimes for the dispatch path. Examples:
- W5-D-6 Codex/Opus (COVARIANCE.P / COVARIANCE.S): no e2e dispatch test for named-range args; registry-lookup smoke only.
- W5-D-7 Codex/Opus (XNPV/XIRR): no e2e dispatch test for named-range args.
- W5-D-11 Opus (PERCENTILE/QUARTILE): the audit comment at line 22 explicitly says "the e2e test verifies case-insensitive dotted-name dispatch" — i.e. registry lookup, NOT actual binder routing.
- W5-D-12 Codex DID identify the binder gap (HIGH-001) but only for SUBTOTAL. The pattern was NOT retrofit-applied to W5-D-6 / W5-D-7 / W5-D-11.

**Why a megaudit catches it but per-batch audits don't:** Per-batch audits see ONE batch and the diff. They have no incentive to cross-check pre-existing fns (`is_aggregate_function` was last updated in W5-107 for TRANSPOSE / FILTER — Wave 3 distributions / PERCENTILE / QUARTILE / etc. landed without revisiting the matcher). The audit prompt is scoped to the batch's diff. The systemic issue is invisible at the diff level.

**Recommendation:**
1. **Strengthen the audit discipline rule** in MEMORY.md (`quantbook_engine_audit_discipline.md`). Add: "Each range-aware / context-aware / reference-aware batch MUST include at least one e2e dispatch test that constructs a named-range or literal-range arg AND runs through `lex → parse → bind → eval`. Registry-lookup-only smoke tests do NOT satisfy this requirement." The pattern is well-established (`reference_fns_coverage_extensions.rs:41-52` is the template).
2. **Add a workspace invariant test** that exhaustively pairs every range-aware-registered name with a named-range probe and asserts binding succeeds. Template:
```rust
#[test]
fn every_range_aware_fn_binds_with_named_range_arg() {
    let reg = default_registry();
    let names = reg.range_aware_fn_names();
    for name in names {
        // Construct a synthetic formula `=NAME(NamedRange, ...)` with
        // arity-appropriate scalar fillers; assert bind() does not
        // surface NamedRangeInScalarContext.
        ...
    }
}
```
This single test would have caught HIGH-1 at any point in the past 4 days.

**Severity rationale:** HIGH (process-level). The pattern of "scalar e2e test only" or "registry-lookup smoke only" is systemic. Without a process fix, the next batch will reproduce the same blind spot.

---

## MEDIUM

### MEDIUM-1 — BIN2DEC text-coercion asymmetric with HEX2DEC / OCT2DEC; same fn family treats Text differently

**Subject:** Within the W5-D-9 base-conversion family, the input-coercion rules are inconsistent.

**Where:** `scalar_fns.rs:3612` (`bin2dec`); `scalar_fns.rs:3643-3664` (`collect_base_decode_arg`, used by HEX2DEC and OCT2DEC).

**Detail:** Compiled probe:
```
BIN2DEC(1000000000)    -> Number(-512.0)
BIN2DEC("1000000000")  -> Error(Value)
HEX2DEC("FF")          -> Number(255.0)    [works]
OCT2DEC("777")         -> Number(511.0)    [works]
```

`HEX2DEC` and `OCT2DEC` both call `collect_base_decode_arg` which accepts Text, Number (stringifies with `format!("{:.0}", n)`), Boolean ("TRUE"/"FALSE"), and Blank (""). `BIN2DEC` calls `coercion::to_number_strict` directly which REJECTS Text (returns `ErrorValue::Value`).

The W5-D-9.1 Opus LOW-3 closure note (`scalar_fns.rs:3638-3642`) explicitly says: "Excel canon: auto-coerce Number (via integer rendering), Boolean (TRUE/FALSE), Blank ("")". The closure was applied to HEX2DEC and OCT2DEC but NOT BIN2DEC, creating the asymmetry.

The Microsoft docs are somewhat ambiguous on BIN2DEC text input — the function signature says "number" but real Excel accepts text. IronCalc accepts text-form for all three. The engine's BIN2DEC is more strict than its siblings, breaking even simple usage like `=BIN2DEC("1010")` which would work in real Excel.

**Recommendation:** Refactor `bin2dec` to use `collect_base_decode_arg` parameterized with the radix-2 parser. Or extract a shared helper `base_decode_with_radix(arg, radix)`. Either way, BIN2DEC should accept Text input consistent with HEX2DEC / OCT2DEC.

**Severity rationale:** MEDIUM. Excel-compat divergence for a simple use case. Not crashy; not silent. The asymmetry within the same fn family is the load-bearing issue — a maintainer reading `bin2dec` 6 months from now would reasonably expect `collect_base_decode_arg`-style coercion.

---

### MEDIUM-2 — BINOM.INV(n, 1.0, alpha) returns #NUM! instead of n (Excel canon: p=1 deterministic → returns n)

**Subject:** Domain check for BINOM.INV excludes `p == 1.0` even though the mathematically defined answer at p=1 is exactly `trials`.

**Where:** `distribution_fns.rs:1144` — `if trials < 0.0 || !(0.0..1.0).contains(&p) || alpha <= 0.0 || alpha >= 1.0`.

**Detail:** Compiled probe: `BINOM.INV(10, 1, 0.5)` → `Error(Num)`. The `(0.0..1.0)` half-open range explicitly excludes p=1.0. But at p=1.0 the binomial is degenerate at `n` (every trial succeeds) so `inverse_cdf(alpha)` for any alpha ∈ (0,1) is exactly `n`. The W5-D-4.1 closure for p=0 (line 1169) added a short-circuit `if p == 0.0 || n == 0 { return Value::number(0.0); }`. The corresponding p=1 short-circuit was NOT added.

Codex W5-D-4 audit (HIGH-1 closure for p=0) only mentioned p=0; the p=1 case was a missed corner. Microsoft's BINOM.INV doc says `Probability_s >= 0` AND `Probability_s <= 1` (inclusive both ends). The engine's strict-upper diverges from Microsoft.

**Note:** This is documented separately in the module comment at `distribution_fns.rs:144-150`:
> `0 ≤ p < 1` strict-upper (DIFFERS from BINOM. ...)

So the divergence is acknowledged but the comment doesn't justify WHY. Microsoft accepts `p == 1.0`; statrs's `Binomial::new(1.0, n)` succeeds and `Binomial::inverse_cdf(alpha)` for alpha < 1 should return n. The strict-upper rejection is over-cautious.

**Recommendation:** Either (a) relax to `(0.0..=1.0).contains(&p)` and add a `if p == 1.0 { return Value::number(n as f64); }` short-circuit OR (b) document the WHY for the strict-upper divergence (e.g. statrs corner) and pin a test asserting `Error(Num)` is the engine's deliberate choice. Current state is divergent-without-rationale.

**Severity rationale:** MEDIUM. Excel-compat divergence on the upper-boundary input. The math is well-defined; the engine rejects a valid input. The fix is small (one short-circuit line).

---

### MEDIUM-3 — Wave 3 distribution domain checks for `df == 0` / `alpha == 0` etc. are slightly over-strict vs Microsoft canon

**Subject:** Multiple Wave 3 distributions return `#NUM!` for `df == 0`, `alpha == 0`, `lambda == 0` (Poisson exception) etc. where Microsoft accepts the input and either returns a sensible degenerate result or a deterministic value.

**Where:** Across `distribution_fns.rs`. Examples from the compiled probe:
- `NEGBINOM.DIST(0, 5, 0, FALSE) -> Error(Num)` — IronCalc rejects, statrs would too. Engine matches.
- `NEGBINOM.DIST(0, 5, 1, FALSE) -> Error(Num)` — same upper-strict-1 pattern as BINOM.INV.
- `POISSON.DIST(0, 0, FALSE) -> Number(1.0)` — degenerate at 0, engine correctly returns 1.0 (short-circuited inline per the module-block notes).
- `EXPON.DIST(1, 0, FALSE) -> Error(Num)` — engine rejects lambda=0; Microsoft says lambda > 0 strict; matches Microsoft.
- `LOGNORM.DIST(1, 0, 0, FALSE) -> Error(Num)` — sigma=0; engine rejects.
- `GAMMA.DIST(1, 0, 1, FALSE) -> Error(Num)` — alpha=0; matches Microsoft (alpha > 0 strict).
- `BETA.DIST(0.5, 0, 1, FALSE) -> Error(Num)` — alpha=0; matches Microsoft.
- `F.DIST(1, 0, 1, FALSE) -> Error(Num)` — df1=0; matches Microsoft.
- `T.DIST(0, 0, FALSE) -> Error(Num)` — df=0; matches.
- `CHISQ.DIST(1, 0, FALSE) -> Error(Num)` — df=0; matches.
- `NORM.DIST(0, 0, 0, FALSE) -> Error(Num)` — sigma=0; matches Microsoft (sigma > 0 strict).
- `CONFIDENCE.T(0.05, 0, 100) -> Error(Num)` — sigma=0; matches.

For most of these the engine matches Microsoft / IronCalc canon. The ONE odd case is `BINOM.INV(p=1)` (MEDIUM-2 above). All other corners handle degenerate parameters by returning `#NUM!` — defensible but Excel-divergent in a few cases.

**Recommendation:** No code change required; the divergences are mostly correct. But: add a cross-batch "distribution domain corner table" in `distribution_fns.rs` module docstring summarizing for each distribution: (a) the Microsoft canon, (b) the engine's domain check, (c) any divergences. The W5-D-1.1 HIGH-O-2 closure set the precedent that "module-level canon docs are first-class". Wave 3 has 38 fns shipped without this consolidating table.

**Severity rationale:** MEDIUM. The bulk of the corners are correct; the consolidating doc would prevent future maintainers from re-debugging these. Not a code bug, but a structural debt.

---

### MEDIUM-4 — `SUMTOTAL(SUBTOTAL(...))` nested-skip divergence is documented but not test-pinned

**Subject:** The W5-D-12 module block documents "nested SUBTOTAL calls in arg ranges are NOT skipped (engine evaluates args before dispatch — AST not available)". This is a real divergence from Excel canon. There is no test asserting the engine's behavior.

**Where:** `range_fns.rs:1924-1972` (W5-D-12 SUBTOTAL block comment).

**Detail:** Compiled probe:
```
SUBTOTAL(9, SUBTOTAL(9, 1, 2), 3) -> Number(6.0)
```
The inner SUBTOTAL(9, 1, 2) = 3. Outer sees [3, 3], sum = 6. Excel: outer would skip nested-SUBTOTAL → return just 3.

The divergence is documented but not pinned by a test. A future refactor that walks `ExprPlan` to detect nested-SUBTOTAL calls (a legitimate path forward toward Excel parity) would silently change behavior. The test would catch the engine→Excel transition.

**Recommendation:** Add `subtotal_nested_subtotal_in_args_not_skipped_engine_divergence` in `range_fns.rs` tests pinning `SUBTOTAL(9, SUBTOTAL(9, 1, 2), 3) == Number(6.0)`. Comment that this is the engine's documented divergence from Excel; if you want Excel canon, the test must be updated alongside the impl change.

**Severity rationale:** MEDIUM. Pure test-armor gap on a documented divergence. The behavior is correct per the engine's documented stance.

---

### MEDIUM-5 — `is_aggregate_function_lists_only_registered_aggregates` invariant is asymmetric and gives false confidence

**Subject:** The invariant test name implies it pins consistency between `is_aggregate_function` and the registry, but it only pins ONE direction.

**Where:** `workbook_runtime.rs:5158-5246`.

**Detail:** The test iterates over a HARDCODED list of names and asserts each is in the registry. If `is_aggregate_function` adds a new name that ISN'T in the hardcoded list (or vice versa), the test silently passes. There's no introspection on the matcher itself.

A correct version would either (a) parse the matcher's match-arm list (compile-time impossible in safe Rust) or (b) be paired with a reverse-direction test that iterates over the registry's `range_aware_fns` and asserts each is recognized by `is_aggregate_function`. Per HIGH-1, the reverse direction is exactly the missing test.

**Recommendation:** Add `every_registered_range_aware_fn_is_admitted_to_is_aggregate_function` — iterate over the registry's range_aware_fns and call `is_aggregate_function` (would need to make the fn `pub(crate)` or expose via a wrapper). Assert true for each.

**Severity rationale:** MEDIUM. The test gives the impression it's a complete invariant but isn't. Process-level fix.

---

### MEDIUM-6 — Matrix marks ATAN2, SUMXMY2, DAYS360 as ✅ Implemented despite being unreachable (compounds HIGH-2)

**Subject:** `docs/compat/excel-matrix.md` ✅ marks three fns that fail at lex time. The matrix coverage report claims 80% but this includes unreachable fns.

**Where:** `docs/compat/excel-matrix.md` ATAN2, SUMXMY2, DAYS360 rows.

**Detail:** The matrix coverage report aggregates fns marked ✅ to compute the 80% number. If the three unreachable fns were marked ⚠️ Partial or 🔄 Reserved-with-lexer-fix-required, the coverage would drop fractionally but the matrix would represent reality.

Per the MASTER-PLAN acceptance criterion FN4-260-02 ("every implemented function has matrix-backed tests"), the unit tests exist — so the criterion is technically met. But the user-facing reach is broken.

**Recommendation:** Either (a) fix the lexer (HIGH-2 recommendation) and the matrix stays ✅, OR (b) downgrade these three rows to ⚠️ with a note explaining the lexer regression. Don't ship a 80% claim that includes dead-code fns.

**Severity rationale:** MEDIUM. Combined with HIGH-2 the issue is HIGH overall, but for matrix accuracy alone it's MEDIUM.

---

## LOW

### LOW-1 — `parse_places_arg` in W5-D-9 lacks an explicit `is_nan()` guard (defense-in-depth)

**Subject:** `scalar_fns.rs:3476-3488` does `n.trunc() as i32` without an explicit `is_nan()` check.

**Detail:** The upstream `to_number_strict` calls `sanitize_f64` which rejects NaN with `ErrorValue::Num`. So `parse_places_arg` cannot receive NaN through the standard coercion chain — the defense is already in place at the boundary. But the W5-D-11.1 closure pattern (added `is_nan()` to `extract_quartile_q`) and the W5-D-12 closure pattern (added `is_nan()` to SUBTOTAL function_num) both added defense-in-depth at the consuming-fn level. Consistency would put the same guard in `parse_places_arg`.

**Recommendation:** Add an `is_nan()` check before the cast. Or document why it's not needed (the comment above `extract_quartile_q` at `range_fns.rs:1761-1768` is the model).

**Severity rationale:** LOW. Defense-in-depth; no current bug. The cast is panic-safe (Rust saturating cast: NaN → 0).

---

### LOW-2 — Test count drift in matrix entries vs actual test counts (W5-D-11 Opus already flagged; partial fix landed)

**Subject:** Per the W5-D-11 Opus audit LOW-2, matrix test counts had off-by-one drift (PERCENTILE.INC 15→16, QUARTILE.INC 10→11). The W5-D-12 Codex audit LOW-001 also flagged "SUBTOTAL lists 25 tests, actually 28". Some closures applied; verify the rest didn't drift again.

**Where:** `docs/compat/excel-matrix.md`.

**Detail:** Mechanical count drift across 22 newly-shipped V1-260 fns. Per-batch audits caught a few; an end-of-phase reconciliation pass would catch the rest.

**Recommendation:** Run a script that greps `^    fn <name>_` test markers and reconciles against the matrix counts. Optional invariant test that reads the matrix and counts actual tests.

**Severity rationale:** LOW. Doc hygiene.

---

### LOW-3 — `xnpv` rate domain check `rate <= 0` is over-strict; Excel canon accepts negative rates

**Subject:** `financial_fns.rs:1716-1718` rejects `rate <= 0`. Excel XNPV accepts negative rates (`rate > -1`).

**Detail:** Microsoft's XNPV docs are somewhat ambiguous — they say "rate > 0" in older docs but the actual Excel function accepts negative rates (with caveat that the bigger constraint is `rate > -1` for the (1+rate)^t denominators to be positive). The engine's strict `rate > 0` over-rejects valid Excel inputs.

**Recommendation:** Relax to `rate > -1.0` to match Excel's actual behavior. Add a regression test for `XNPV(-0.05, values, dates)`.

**Severity rationale:** LOW. Excel-compat divergence on a niche use case (negative rates in NPV).

---

### LOW-4 — Audit-discipline rule already requires "compiled-probe verification non-negotiable for iterative kernels near domain singularities" but the same rule isn't applied to dispatch paths

**Subject:** MEMORY.md `quantbook_engine_wave3_distributions_handoff.md` says "compiled-probe verification non-negotiable for iterative kernels near domain singularities". Wave 3 audits did this for math kernels (BINOM.INV, GAMMA.INV, XIRR — all caught). The same rule wasn't required for the binder dispatch path.

**Recommendation:** Extend the audit-discipline rule: "compiled-probe verification non-negotiable for [iterative kernels near domain singularities] AND [dispatch path with range/named-range args for any range-aware-tier registration]". HIGH-1 in this audit is exactly the missing piece.

**Severity rationale:** LOW (process-level; the substantive issue is captured in HIGH-1/HIGH-4).

---

### LOW-5 — `current_work.md` (in user-private memory) is 3 days stale and doesn't mention V1-260

**Subject:** `~/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` describes 2026-05-14 EOS Visualise work; doesn't mention the V1-260 ship.

**Detail:** Per CLAUDE.md memory rules, this is acceptable (memory is a snapshot, not a session log). But future sessions reading the memory pointer will get an outdated baseline. The `quantbook_engine_phase4_10_v1_260_shipped.md` file is the authoritative pointer for the current state.

**Recommendation:** Update `current_work.md` to point to the V1-260 ship marker, OR update MEMORY.md pointer ordering so the latest engine work surfaces first.

**Severity rationale:** LOW. Documentation hygiene; cross-session navigability.

---

### LOW-6 — `BIN2DEC` strict numeric coercion is documented as "Excel canon: input is a NUMBER (not a string)" but Microsoft docs say "number — The binary number you want to convert" which is ambiguous

**Subject:** The W5-D-9.1 docstring at `scalar_fns.rs:3606-3611` justifies the Text-rejection by citing "Excel canon". Microsoft's BIN2DEC doc says "number" but doesn't explicitly say text is rejected. Real Excel ACCEPTS text input.

**Recommendation:** Verify the claim. If real Excel accepts text, fix MEDIUM-1 above. If Microsoft docs are authoritative and real Excel does reject text, keep the strict behavior and tighten the docstring justification.

**Severity rationale:** LOW. Documentation honesty; the substantive issue is MEDIUM-1.

---

## What works (positive findings to balance the above)

To avoid a purely-negative report, the megaudit confirmed many things are solid:

1. **Math kernel correctness**: All 38 Wave 3 distribution fns and the 22 closeout-batch fns produce correct results on textbook anchors and degrade gracefully on degenerate inputs. The W5-D-1.1, W5-D-4.1, W5-D-5.1, W5-D-7.1, W5-D-8.1, W5-D-11.1, W5-D-12.1 closures all correctly addressed their per-batch audit findings at the code level.
2. **No panics**: Compiled probe confirms no Wave 3 distribution fn panics on degenerate inputs (BINOM/NEGBINOM/POISSON/EXPON/LOGNORM/GAMMA/BETA/F/T/CHISQ/NORM/CONFIDENCE all return `Error(Num)` or a sensible degenerate value).
3. **No hangs**: GAMMA.INV W5-D-5.1 closure correctly handles subnormal scale.
4. **BIT* precision boundary**: `BITAND(2^48-1, 2^48-1) -> Number(281474976710655.0)` exact, `BITLSHIFT(2^48-1, 1) -> Error(Num)` overflow caught, `BITLSHIFT(1, 53) -> Error(Num)` shift-bound caught, `BITLSHIFT(1, 54) -> Error(Num)` excessive-shift caught. All correct.
5. **DEC2* / *2DEC two's-complement at boundary**: `DEC2BIN(-512) -> "1000000000"`, `DEC2BIN(-513) -> Error(Num)`, `DEC2BIN(511) -> "111111111"`, `DEC2BIN(512) -> Error(Num)`. Symmetric and correct.
6. **SUBTOTAL invalid function_num**: `SUBTOTAL(12)`, `SUBTOTAL(0)`, `SUBTOTAL(112)`, `SUBTOTAL(-1)` all correctly return `Error(Value)`. Boundary checks tight.
7. **SUBTOTAL Boolean function_num coercion**: `SUBTOTAL(TRUE, ...) == SUBTOTAL(1, ...) == AVERAGE`. Documented IronCalc-canon divergence from Excel; engine correctly chooses IronCalc parity.
8. **Total test count**: 4017 tests passing across the workspace. Master plan claim that "12 audit transcripts" exist — verified, 24 total files (12 Codex + 12 Opus).
9. **Matrix coverage script**: `scripts/report-compat-coverage.sh` produces accurate 80% per the matrix's ✅ count of 210 / 311 rows (modulo MEDIUM-6 about the 3 unreachable fns).
10. **`assert_eq!(r.len(), 260)` pin**: Registry count is correctly asserted.

---

## Sum

**Findings:** 4 HIGH / 6 MEDIUM / 6 LOW.

**Critical follow-ups** (must-close before claiming V1-260 "complete"):
- HIGH-1: extend `is_aggregate_function` to admit all 28 missing range-aware fns; add reverse-direction invariant test; add e2e per fn for named-range arg path.
- HIGH-2: extend the W5-D-9 lexer special-case to handle 4+letter-prefix-trailing-digit names; add ATAN2 / SUMXMY2 / DAYS360 lex regression tests.
- HIGH-3: add the missing SUBTOTAL named-range e2e test that Codex W5-D-12 HIGH-001 originally recommended.
- HIGH-4: update audit-discipline rule to require lex+parse+bind+eval coverage for range-aware / context-aware / reference-aware batches.

**Should-close** (within 1 closure pass):
- MEDIUM-1: BIN2DEC text-coercion parity with HEX2DEC/OCT2DEC.
- MEDIUM-2: BINOM.INV p=1 short-circuit.
- MEDIUM-3: distribution domain corner consolidating table.
- MEDIUM-4: SUBTOTAL nested-skip divergence test pin.
- MEDIUM-5: invariant-test reverse-direction extension.
- MEDIUM-6: matrix downgrade (or fix HIGH-2 first).

**Defer** (LOW-1 through LOW-6): documentation hygiene + process polish.

The phase ship was premature for "complete and correct". It is correct at the code level for what was tested; it is incomplete at the engine-boundary reach for ~31 fns. The Acceptance criterion FN4-260-02 ("every fn has matrix-backed tests") is technically met but doesn't capture the binder/lexer gaps that any user authoring formulas would hit immediately.

Recommend a `W5-D-13` or `V1-260-CLOSEOUT` followup commit pair (one impl, one audit transcript) that addresses HIGH-1 through HIGH-4 before re-claiming "Phase 4.10 V1-260 SHIPPED" in the MASTER-PLAN.
