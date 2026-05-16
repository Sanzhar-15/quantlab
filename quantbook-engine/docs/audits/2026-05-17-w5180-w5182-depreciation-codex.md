# W5-180 -> W5-182 Depreciation Audit - Codex

## HIGH

### HIGH 1 - `DB` accepts `life = 0` for partial-month first periods and returns a finite depreciation

- Path: `crates/ql-functions/src/financial_fns.rs:652`
- Snippet:

```rust
if (month == 12.0 && period > life)
    || period > life + 1.0
    || month <= 0.0
    || month > 12.0
    || period <= 0.0
    || cost < 0.0
{
    return Err(ErrorValue::Num);
}
```

- Path: `crates/ql-functions/src/financial_fns.rs:668`
- Snippet:

```rust
let rate = ((1.0 - (salvage / cost).powf(1.0 / life)) * 1000.0).round() / 1000.0;
```

`DB(1000, 100, 0, 1, 7)` passes validation because `month == 12.0` is false and `period > life + 1.0` is `1 > 1`, also false. It then evaluates the canonical rate expression with `1.0 / life`. For ordinary `salvage < cost`, Rust computes `(salvage / cost)^inf` as `0`, so the rate becomes `1` and the function returns `1000 * 1 * 7 / 12 = 583.3333333333334` instead of an error.

Microsoft's DB formula defines the rate using `1 / life`; a zero useful life is not a valid depreciation domain. This bug is inherited from IronCalc rather than introduced by the port: `.references/ironcalc/base/src/functions/financial.rs:1796` has the same validation and `.references/ironcalc/base/src/functions/financial.rs:1810` evaluates the same rate expression.

Fix: add an explicit `life <= 0.0` guard before the rate calculation, and keep it before the `cost == 0.0` short-circuit so `DB(0, 0, 0, 1, 7)` cannot hide the invalid life. Add tests for at least `DB(1000,100,0,1,7) -> #NUM!`, `DB(0,0,0,1,7) -> #NUM!`, and the existing valid `cost == 0, life > 0` case.

## MEDIUM

### MEDIUM 1 - `DB` has the same optional-argument Boolean divergence as `DDB`, but only `DDB` documents it

- Path: `crates/ql-functions/src/financial_fns.rs:716`
- Snippet:

```rust
let month = if args.len() == 5 {
    match arg_num(&args[4]) {
        Ok(n) => n.trunc(),
        Err(e) => return Value::Error(e),
    }
} else {
    12.0
};
```

- Path: `.references/ironcalc/base/src/functions/financial.rs:1788`
- Snippet:

```rust
let month = if arg_count > 4 {
    match self.get_number_no_bools(&args[4], cell) {
        Ok(f) => f.trunc(),
        Err(s) => return s,
    }
} else {
    12.0
};
```

The local `arg_num` path coerces Booleans through the shared numeric coercion path (`crates/ql-functions/src/financial_fns.rs:34`, `crates/ql-types/src/coercion.rs:32`). IronCalc explicitly rejects Booleans for DB's optional `month`. This means `DB(1000,100,6,1,TRUE())` returns a one-month depreciation locally, while the IronCalc port target errors before calculation. `DDB` has the same kind of optional-argument divergence for `factor`, and that is called out in `docs/compat/excel-matrix.md:263`; the DB row at `docs/compat/excel-matrix.md:264` does not call out the `month` divergence and the wrapper comment says only "per Microsoft + IronCalc" at `crates/ql-functions/src/financial_fns.rs:694`.

Fix: either introduce a no-Boolean numeric helper for DB's optional `month` if strict IronCalc parity is desired, or explicitly document the DB `month` Boolean coercion as the same engine-convention divergence already documented for DDB `factor`. Add a test for `Value::Boolean(true)` and `Value::Boolean(false)` in the fifth argument so the intended behavior is pinned.

## LOW

### LOW 1 - DB coverage text claims Microsoft fixtures for `k = 1..7`, but tests only pin periods 1, 2, and 7

- Path: `crates/ql-functions/tests/coverage.rs:331`
- Snippet:

```rust
(
    "DB",
    "W5-182; unit tests pin Microsoft fixtures (DB(1M,100k,6,k,7) for k=1..7) + partial first/last period semantics + validation #NUM! paths",
),
```

- Path: `crates/ql-functions/src/financial_fns.rs:2083`
- Snippet:

```rust
fn db_full_year_period_equals_life_succeeds() {
    let result = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(6.0)]);
    matches!(result, Value::Number(_))
        .then_some(())
        .expect("expected Number");
}
```

The DB unit tests pin the Microsoft series for periods 1, 2, and 7 (`db_microsoft_first_period_partial`, `db_microsoft_second_period`, `db_microsoft_last_partial_period`). They do not pin periods 3, 4, 5, or 6. The only period-equals-life test checks that the result is a number, not that the period-6 depreciation is correct, so a regression in the middle-period accumulation loop could still pass.

Fix: either reduce the coverage wording to match the actual tests, or add value-pinning tests for periods 3 through 6. Replace `db_full_year_period_equals_life_succeeds` with an exact expected-value assertion computed from the same 3-decimal rate and accumulated-through-period-5 formula.

### LOW 2 - DB matrix describes raw `month > 12` rejection, but the implementation truncates before validation

- Path: `crates/ql-functions/src/financial_fns.rs:716`
- Snippet:

```rust
match arg_num(&args[4]) {
    Ok(n) => n.trunc(),
    Err(e) => return Value::Error(e),
}
```

- Path: `crates/ql-functions/src/financial_fns.rs:654`
- Snippet:

```rust
|| month <= 0.0
|| month > 12.0
```

- Path: `docs/compat/excel-matrix.md:264`
- Snippet:

```text
Validation: `month == 12 && period > life`, `period > life + 1`, `month <= 0`, `month > 12`, ...
```

Because truncation happens in the wrapper before `compute_db`, the validation is against the truncated month, not the raw argument. For example, `month = 12.9` is truncated to `12` and accepted; it is not rejected by the documented `month > 12` rule. The test `db_month_fractional_truncates` at `crates/ql-functions/src/financial_fns.rs:2159` pins this truncation behavior for `7.7`, but the matrix wording still reads like raw input validation.

Fix: rewrite the matrix row to say that `month` is truncated first, then the truncated value must be in `1..=12`. Add boundary tests for `12.9` and `0.9` if that behavior is intentional.
