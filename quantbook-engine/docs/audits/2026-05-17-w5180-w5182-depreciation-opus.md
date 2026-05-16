# W5-180 / W5-181 / W5-182 Depreciation Batch — Opus Audit

**Scope:** Three commits on `feat/quantbook-engine` ending at HEAD `c8f54fca645`:
- `ce3d689b8dd` (W5-180) — SLN + SYD
- `4c591e1df1b` (W5-181) — DDB
- `c8f54fca645` (W5-182) — DB

**Reviewer:** Claude Opus (parallel to Codex audit).

**Approach:** Critical-only. Findings categorized HIGH / MEDIUM / LOW. Skipped items
that work correctly.

---

## Findings

### HIGH-1: `db_full_year_period_equals_life_succeeds` does not pin the numeric value

**File:** `crates/ql-functions/src/financial_fns.rs:2083-2091`

**Issue:**
```rust
fn db_full_year_period_equals_life_succeeds() {
    let result = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(6.0)]);
    matches!(result, Value::Number(_))
        .then_some(())
        .expect("expected Number");
}
```

**Why it's wrong:** This is the only test that exercises the `period == life` branch
with the default `month = 12`. It only asserts the result is a `Value::Number(_)`,
not the actual numeric value. A regression that returns a wildly wrong but finite
number (e.g. `0.0` always, `cost` always, or `accumulated` instead of
`rate*(cost - accumulated)`) would pass silently. The neighbouring tests
(`db_microsoft_first_period_partial`, `db_microsoft_second_period`,
`db_microsoft_last_partial_period`) all pin numeric values; this test is the
only laggard in the batch and it sits on the most-error-prone code path
(loop-then-final-period-formula).

Hand-tracing `DB(1_000_000, 100_000, 6, 6)` with `month = 12`:
- rate = 0.319
- accumulated after period 1 = 319_000.00
- loop iterations (periods 2..5):
  - p2: acc = 319_000 + 681_000 * 0.319 = 536_239.00
  - p3: acc = 536_239 + 463_761 * 0.319 = 684_178.759
  - p4: acc ≈ 784_925.730
  - p5: acc ≈ 853_534.405
- Return = 0.319 * (1_000_000 - 853_534.405) ≈ **46_722.504**

**Fix:** Replace the `matches!` check with a value assertion:

```rust
let rate = db_microsoft_rate();
let mut acc = 1_000_000.0 * rate; // month=12, period 1
for _ in 0..4 { // periods 2..5
    acc += (1_000_000.0 - acc) * rate;
}
let expected = rate * (1_000_000.0 - acc);
approx(
    db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(6.0)]),
    expected,
    1e-6,
);
```

---

### MEDIUM-1: Excel-matrix DDB test count is wrong (off by one)

**File:** `docs/compat/excel-matrix.md:263`

**Issue:** The DDB row's "Tests" column says `15`. Actual `#[test]` count in
`crates/ql-functions/src/financial_fns.rs` under DDB:

```
ddb_microsoft_example_first_year
ddb_microsoft_example_final_year
ddb_life_in_months
ddb_explicit_factor_one_single_declining
ddb_rate_clamps_to_one_when_factor_exceeds_life
ddb_rate_one_zero_after_first_period
ddb_salvage_floor_clamps_to_zero
ddb_period_exceeds_life_is_num
ddb_zero_period_is_num
ddb_negative_period_is_num
ddb_negative_cost_is_num
ddb_negative_salvage_is_num
ddb_zero_factor_is_num
ddb_negative_factor_is_num
ddb_wrong_arity
ddb_error_in_arg_propagates
```

That's **16**, not 15. (Verified by `grep -B1 "    fn ddb_" ... | grep -c "#\[test\]"`.)

**Why it's wrong:** The matrix doc is auditable evidence of test discipline; an
off-by-one is small but it's a "spec lies" situation. Easy to fix.

**Fix:** Change `| DDB | ✅ | 15 |` → `| DDB | ✅ | 16 |` in
`docs/compat/excel-matrix.md:263`.

---

### MEDIUM-2: Doc-comment + matrix overstate Microsoft's role in the SYD `life=0 → #NUM!` asymmetry

**File:** `crates/ql-functions/src/financial_fns.rs:511-513`, `docs/compat/excel-matrix.md:262`

**Issue:** The `compute_syd` doc says:

> Per Microsoft canon (`life <= 0` or `per > life` or `per <= 0` → `#NUM!`) —
> distinct from SLN's `#DIV/0!` for the same degenerate `life = 0` case.
> We mirror Microsoft + IronCalc here.

And the matrix says:

> SYD `life = 0` → `#NUM!` (NOT `#DIV/0!`) per Microsoft + IronCalc

**Why it's wrong:** The Microsoft SYD doc
(https://support.microsoft.com/en-us/office/syd-function-069f8106-b60b-4ca2-98e0-2a0f206bdb27)
contains **no Remarks section documenting `#NUM!` for `life=0`** — confirmed by
WebFetch read. The asymmetry (`SLN(life=0)→#DIV/0!` vs `SYD(life=0)→#NUM!`) is
purely an **IronCalc convention** that we inherited. Microsoft's docs are silent
on which error code applies, so the "per Microsoft + IronCalc" claim is at best
unverifiable and at worst false. The actual canon source for this asymmetry is
IronCalc alone (until/unless we test a real Excel install and document the
result).

**Fix:** Soften the attribution in both the doc-comment and the matrix entry.
Suggested wording:

```
SYD `life = 0` → `#NUM!` per IronCalc convention (Excel's docs don't document
the error code; verified against IronCalc `fn_syd`). Distinct from SLN's
`#DIV/0!` for the structurally identical degenerate case.
```

---

### MEDIUM-3: DDB doc claims sole Boolean-arg divergence vs IronCalc, but DB's `month` arg has the same divergence

**File:** `crates/ql-functions/src/financial_fns.rs:588-592`, `docs/compat/excel-matrix.md:263`

**Issue:** The `compute_ddb` doc says:

> **Engine convention note:** IronCalc uses `get_number_no_bools` for the
> `factor` arg only (rejects Boolean); our `arg_num` allows Boolean coercion
> uniformly across all args. Deliberate divergence for consistency with the
> rest of the financial family.

The matrix DDB row echoes this. But IronCalc's `fn_db`
(`.references/ironcalc/base/src/functions/financial.rs:1789`) ALSO uses
`get_number_no_bools` — for `month`:

```rust
let month = if arg_count > 4 {
    match self.get_number_no_bools(&args[4], cell) {
        Ok(f) => f.trunc(),
        Err(s) => return s,
    }
} else { 12.0 };
```

Our `db()` wrapper uses `arg_num` for `month` (line 717), which accepts Boolean
(`TRUE → 1.0`, `FALSE → 0.0`). So a user formula like `=DB(1000, 100, 5, 1, TRUE)`
returns a real number in our engine (month=1 partial-year depreciation) but
`#VALUE!` in IronCalc.

**Why it's wrong:** The matrix + doc only flag DDB's `factor` divergence; the
identical-shape divergence on DB's `month` is undocumented. A future reviewer
auditing "do we match IronCalc?" will find one undeclared divergence.

**Fix:** Extend the doc-comment on `compute_db` (around line 645) and the DB
matrix row to add:

> **Engine convention note:** IronCalc uses `get_number_no_bools` for the
> `month` arg (rejects Boolean); our `arg_num` allows Boolean. Same family-wide
> convention as the DDB `factor` divergence.

---

### MEDIUM-4: DB rate uses raw `life`, but iteration uses `life.floor()` — silent precision mismatch

**File:** `crates/ql-functions/src/financial_fns.rs:668, 673`

**Issue:** Lines 668 and 673:
```rust
let rate = ((1.0 - (salvage / cost).powf(1.0 / life)) * 1000.0).round() / 1000.0;
// ...
let period_int = period.floor() as i32;
let life_int = life.floor() as i32;
```

The `rate` is computed with the **fractional** `life`, but the iteration count
and last-period detection use `life.floor() as i32`. For `DB(1000, 100, 5.99, 6, 6)`:
- rate = round((1 - 0.1^(1/5.99)) * 1000) / 1000 (uses life=5.99)
- life_int = 5 (uses life=5)
- period_int=6 == life_int+1=6 → last-partial branch triggers, treating life as 5

**Why it's wrong:** The rate is a 5.99-year rate but the iteration is a 5-year
schedule. The model is internally inconsistent. This matches IronCalc's
behaviour exactly, so it's not a port bug — it's an upstream IronCalc
quirk we inherited.

In practice fractional `life` is rare in spreadsheet usage; Excel docs imply
life is an integer count of periods. Real Excel probably either floors `life`
uniformly or rejects fractional life. Without an Excel testbed we can't tell.

**Fix:** Either:
1. Document this as a known IronCalc-inherited divergence in the matrix + doc-comment, OR
2. Floor `life` once before rate computation (a one-line change) and accept the
   tiny divergence from IronCalc as a correctness fix.

Recommend (1) for now (matches IronCalc) but pin a test that demonstrates the
observed behavior so any future fix is intentional, not accidental.

---

### MEDIUM-5: DB validation gap — `life = 0` with `month < 12` slips past the upfront check

**File:** `crates/ql-functions/src/financial_fns.rs:652-660`

**Issue:** The validation chain at the top of `compute_db`:

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

There's no `life <= 0` check. With `life = 0` and `month = 12`, the `period > life`
sub-check catches it (assuming `period > 0`). But with `life = 0` and `month < 12`:
- `month == 12 && period > life` → false (month ≠ 12)
- `period > life + 1` → `period > 1` (caught only for period ≥ 2)
- `period <= 0` → caught for period ≤ 0

So `DB(1000, 100, 0, 1, 6)` (life=0, period=1, month=6) **slips past validation**:
- rate = round((1 - 0.1^(1/0))*1000)/1000 = round((1 - 0.1^inf)*1000)/1000 = round(1 * 1000)/1000 = 1.0 (since 0.1^inf = 0)
- accumulated = 1000 * 1.0 * 6/12 = 500
- period_int=1 → returns 500

Similarly `DB(1000, 100, -1, 1, 6)`: `period > life+1 = 0` → 1 > 0 → caught. OK.

But `DB(1000, 100, 0.5, 1, 6)`: life=0.5
- `month==12 && period>life`: false (month=6)
- `period > life+1 = 1.5`: 1 > 1.5 → false
- All other checks pass
- rate = round((1 - 0.1^2)*1000)/1000 = round(0.99 * 1000)/1000 = 0.99
- accumulated = 1000 * 0.99 * 6/12 = 495
- period_int=1 → returns 495

**Why it's wrong:** Microsoft DB doc lists `life` as "the number of periods over
which the asset is depreciated" — implicitly ≥ 1. Excel almost certainly rejects
`life ≤ 0` regardless of `month`. Our impl returns nonsensical values for
`life ∈ (0, 1)` with `month < 12`.

This is also an IronCalc-shared gap (same validation chain). But it's a real
divergence from Excel's likely behavior.

**Fix:** Add `|| life <= 0.0` to the validation chain. The same fix should be
considered for IronCalc but that's their concern. For us, this is a clear
correctness gain. Add tests:

```rust
#[test] fn db_zero_life_is_num() {
    assert_eq!(db(&[n(1000.0), n(100.0), n(0.0), n(1.0), n(6.0)]), Value::Error(ErrorValue::Num));
}
#[test] fn db_negative_life_is_num() {
    assert_eq!(db(&[n(1000.0), n(100.0), n(-1.0), n(1.0), n(6.0)]), Value::Error(ErrorValue::Num));
}
#[test] fn db_fractional_sub_one_life_is_num() {
    assert_eq!(db(&[n(1000.0), n(100.0), n(0.5), n(1.0), n(6.0)]), Value::Error(ErrorValue::Num));
}
```

If we want to match IronCalc strictly, document this as a deliberate
divergence (recommended) and add the tests anyway to pin the new behavior.

---

### MEDIUM-6: DB period truncation accepts fractional `period < 1` silently

**File:** `crates/ql-functions/src/financial_fns.rs:656, 672`

**Issue:** Validation rejects `period <= 0.0` (line 656). But fractional period
in `(0, 1)` passes:
- `period = 0.5`: passes validation.
- `period_int = 0.5.floor() as i32 = 0`.
- `period_int == 1` is false.
- Loop runs `0..-2` (range start > end, empty).
- `period_int == life_int + 1` — usually false for life ≥ 1.
- Returns `rate * (cost - accumulated)` — but `accumulated` was computed assuming
  this IS period 1, so the return value semantically represents period 2's full-year
  depreciation against a period-1-truncated book value.

So `DB(1000, 100, 5, 0.5, 12)`:
- rate = 0.369 (approx)
- accumulated = 1000 * 0.369 * 12/12 = 369
- period_int = 0
- Returns 0.369 * (1000 - 369) = 232.74

That's the period-2 dep value, returned for input `period=0.5`. **Off-by-period
semantic bug for fractional period < 1.**

**Why it's wrong:** Excel's DB likely either floors `period` uniformly
(so period=0.5 → period=0 → likely error or zero) or rejects fractional period
with `#NUM!`. Returning the next period's depreciation is clearly wrong.

This is shared with IronCalc.

**Fix:** Either reject fractional period (`if period.fract() != 0.0`) — strictest;
or floor period uniformly at the top before validation:

```rust
let period_floor = period.floor();
if period_floor < 1.0 || period_floor > life.floor() + 1.0 { /* #NUM! */ }
```

Recommend documenting current behavior + adding a pinned test that proves it,
so a future fix is deliberate.

---

### MEDIUM-7: `compute_db` infinite-loop / i32-overflow on huge `period`/`life`

**File:** `crates/ql-functions/src/financial_fns.rs:672-689`

**Issue:**
```rust
let period_int = period.floor() as i32;
let life_int = life.floor() as i32;
// ...
for _ in 0..(period_int - 2) {
    accumulated += (cost - accumulated) * rate;
}
// ...
if period_int == life_int + 1 { ... }
```

With `life = 1e15, period = 5`: `period > life + 1.0` is false (since 5 < 1e15+1).
Then `life_int = i32::MAX` (saturation from `1e15 as i32`). The check `period_int
== life_int + 1` performs `i32::MAX + 1`:
- **Debug build:** panic ("arithmetic overflow").
- **Release build:** wraps to `i32::MIN`, then `5 == i32::MIN` is false, falls through to `rate * (cost - accumulated)`.

With `life = 5, period = 1e15`: `period > life + 1.0` is true → `#NUM!`. ✓ Caught.

With `life = 1e15, period = 1e15` (both huge): `period > life + 1` is false (f64
precision loss makes `life + 1 == life`). `period_int = i32::MAX`. Loop runs
`i32::MAX - 2` ≈ 2.1 billion iterations. **Minutes of CPU per cell.**

**Why it's wrong:** DoS-class behavior for adversarial input. Not Excel-canon
realistic (Excel never has periods that large) but a malicious workbook could
trigger it. Shared with IronCalc, which has the same cast.

**Fix:** Reject `life > 1e8` (or similar) at validation, OR clamp `period_int` /
`life_int` to a sane max (e.g., 1_000_000 — far beyond any realistic
depreciation schedule). Even just:

```rust
if life > i32::MAX as f64 || period > i32::MAX as f64 {
    return Err(ErrorValue::Num);
}
```

would close the saturation door.

---

### MEDIUM-8: DDB doc claims salvage floor "stops depreciation before
over-depreciating" but doesn't note the equivalence proof

**File:** `crates/ql-functions/src/financial_fns.rs:582-585`

**Issue:** The doc says:

> `result = max(value − max(salvage, new_value), 0)`.
>   The `max(salvage, new_value)` floor ensures depreciation stops
>   once the asset reaches salvage (Excel canon — diverges from
>   pure DDB which can over-depreciate).

This implies the closed-form matches Microsoft's iterative formula
(`min((book * factor/life), (book - salvage))`) only "approximately". In fact
the closed-form IS mathematically equivalent to Microsoft's iterative
per-period formula — **provided** the salvage floor hasn't been triggered
in any prior period. The proof:

- `period_dep = min(book * rate, book - salvage) = book - max(book - book*rate, salvage) = book - max(book*(1-rate), salvage)`
- For period k (no prior floor trigger): `book = cost*(1-rate)^(k-1) = value`,
  `book*(1-rate) = cost*(1-rate)^k = new_value`.
- So `period_dep = value - max(new_value, salvage)`. ✓

When the floor HAS triggered in a prior period, Microsoft's iterative `book` no
longer equals `cost*(1-rate)^(k-1)`. But the result is still 0 in both
formulations because once `book = salvage`, `min(salvage*rate, 0) = 0`, and
our closed-form gives `max(value - max(salvage, new_value), 0)` where `value`
has decayed below salvage too → `max(negative, 0) = 0`. ✓

So **the closed-form is exact, not approximate**. The doc's hedging "Excel
canon — diverges from pure DDB which can over-depreciate" is correct but
incomplete: a one-line proof sketch would prevent future readers from
suspecting the closed-form vs iterative form might drift.

**Fix:** LOW priority. Add a brief sketch:

> The `value - max(new_value, salvage)` form is provably equivalent to
> Microsoft's per-period `min(book*rate, book - salvage)`: when the salvage
> floor hasn't triggered yet, `book = value` and `book*(1-rate) = new_value`;
> once the floor triggers, both formulas yield `0`.

---

### MEDIUM-9: Microsoft's DDB doc says "All five arguments must be positive numbers" — our impl accepts cost=0 and salvage=0

**File:** `crates/ql-functions/src/financial_fns.rs:600`

**Issue:**
```rust
if period > life || cost < 0.0 || salvage < 0.0 || period <= 0.0 || factor <= 0.0 {
    return Err(ErrorValue::Num);
}
```

Microsoft DDB doc explicitly states "All five arguments must be positive numbers"
(verified by WebFetch on
https://support.microsoft.com/en-us/office/ddb-function-519a7a37-8772-4c96-85c0-ed2c209717a5).

Our impl rejects `cost < 0` and `salvage < 0` but accepts `cost = 0` and `salvage = 0`.
With cost=0, the closed-form returns 0 (degenerate but not nonsense). With
salvage=0, the asset depreciates to zero (a perfectly valid scenario).

**Why it's wrong:** Strict Microsoft canon rejects `cost = 0`. Our impl follows
IronCalc's slightly looser interpretation. Whether real Excel actually rejects
`cost = 0` (vs returning 0) is something we can only confirm by testing in
Excel itself. The pattern "Microsoft says > 0 but Excel accepts ≥ 0" is common.

**Fix:** Document the divergence explicitly in the doc-comment and matrix.
Suggested addition to `compute_ddb` doc:

> **Microsoft-canon divergence (matches IronCalc):** Microsoft's doc says
> "All five arguments must be positive numbers." We follow IronCalc in
> accepting `cost == 0` and `salvage == 0` (both produce sensible results:
> `cost=0` returns 0; `salvage=0` allows full depreciation to zero).

---

### LOW-1: `ddb_microsoft_example_final_year` test computes expected from impl's own formula

**File:** `crates/ql-functions/src/financial_fns.rs:1842-1852`

**Issue:**
```rust
fn ddb_microsoft_example_final_year() {
    let expected = 2400.0 * 0.8_f64.powi(9) - 300.0;
    approx(ddb(&[n(2400.0), n(300.0), n(10.0), n(10.0)]), expected, 1e-9);
}
```

`expected = 2400 * 0.8^9 - 300` is exactly the formula the impl computes for
this case (rate=0.2, value=cost*0.8^9, new_value=cost*0.8^10 < salvage=300 so
floor kicks in, result = value - salvage). So the test is tautological — it
verifies the impl computes its own formula.

**Why it's wrong:** Microsoft's documented value for `DDB(2400, 300, 10, 10)` is
**$22.12**. The computed expected is `2400 * 0.134217728 - 300 = 22.122547...`,
which rounds to $22.12. To independently pin the Microsoft display value, the
assertion should be `approx(..., 22.12, 0.005)` — that catches regressions
that drift by more than half a cent.

**Fix:** Either:
1. Add a separate assertion: `assert!((result - 22.12).abs() < 0.005, ...);`
2. Or add a comment clarifying the test pins the formula, not the
   independently-derived Microsoft display.

`ddb_microsoft_example_first_year` (line 1835) does pin $480 hard-coded, which
IS independently verified against Microsoft's documented value — that test
is fine. Only the final-year version has this tautology issue.

---

### LOW-2: `db_microsoft_first_period_partial` and related DB Microsoft tests use the formula to compute expected

**File:** `crates/ql-functions/src/financial_fns.rs:2027-2080`

**Issue:** All three DB "Microsoft" tests compute the expected value from the
canonical formula:

```rust
let expected = 1_000_000.0 * db_microsoft_rate() * 7.0 / 12.0;
```

If the impl applied the same wrong formula to compute the result, the test
would pass. Microsoft's documented value for `DB(1M, 100k, 6, 1, 7)` is
**$186,083.33**. The tests don't pin that rounded display.

**Why it's wrong:** Same tautology issue as LOW-1. Lower severity because the
formula is straightforward and unlikely to drift; but it weakens the
"Microsoft fixture" framing in the matrix.

**Fix:** Add at minimum one anchor test that pins the actual Microsoft display
values:

```rust
#[test] fn db_microsoft_display_values_pinned() {
    // Microsoft docs report these exact values for DB(1M, 100k, 6, k, 7):
    // p1: $186,083.33; p2: $259,639.42; p3: $176,814.44; ...
    let r = |p: f64| match db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(p), n(7.0)]) {
        Value::Number(x) => x,
        v => panic!("expected Number, got {v:?}"),
    };
    assert!((r(1.0) - 186_083.33).abs() < 0.01);
    // ... etc
}
```

Requires fetching the full Microsoft-documented period series.

---

### LOW-3: SLN doc-comment misses a Microsoft remark — salvage > cost is implicitly disallowed

**File:** `crates/ql-functions/src/financial_fns.rs:494-504`

**Issue:** Some Excel guides (e.g., ablebits.com, thebricks.com) state Excel's
SLN returns `#NUM!` when salvage > cost. Microsoft's official SLN doc does NOT
document this (verified by WebFetch). Our impl returns a **negative number** in
this case, matching IronCalc:

```rust
sln_negative_life_passes_through // analogous test exists; no salvage > cost test
```

Test `sln_basic` exercises salvage < cost; no test for salvage > cost.

**Why it's wrong:** If real Excel does reject salvage > cost, we're returning
the wrong value. If Excel doesn't reject (just returns negative), we're fine.
The current test suite doesn't pin the behavior either way for salvage > cost.

**Fix:** Add a test that pins our actual behavior so any future Excel-canon fix
is deliberate:

```rust
#[test] fn sln_salvage_exceeds_cost_returns_negative() {
    // IronCalc-canon: no upfront check; formula passes through.
    // If we later discover Excel rejects with #NUM!, this test is
    // an intentional canary.
    approx(sln(&[n(100.0), n(200.0), n(5.0)]), -20.0, 1e-9);
}
```

Same for SYD.

---

### LOW-4: DB `db_month_fractional_truncates` only tests positive fraction

**File:** `crates/ql-functions/src/financial_fns.rs:2159-2164`

**Issue:**
```rust
fn db_month_fractional_truncates() {
    let r1 = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(7.7)]);
    let r2 = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(7.0)]);
    assert_eq!(r1, r2);
}
```

`trunc()` rounds toward zero, so `-7.7.trunc() = -7.0` (positive direction).
A test like `month = -0.5` would trunc to `0.0` and trigger `month <= 0` →
#NUM!. A test like `month = 12.9` would trunc to `12.0` → behaves like
month=12. Neither of these edge cases is covered.

**Why it's wrong:** Small test-coverage gap. Trunc behavior is subtle on
boundary cases (12.0001, -0.0001, 12.999) and warrants a pinning test.

**Fix:** Add:

```rust
#[test] fn db_month_above_12_fractional_truncates_to_12() {
    // month=12.9 → trunc → 12 → behaves as full-year first period.
    let r1 = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(12.9)]);
    let r2 = db(&[n(1_000_000.0), n(100_000.0), n(6.0), n(1.0), n(12.0)]);
    assert_eq!(r1, r2);
}

#[test] fn db_month_fractional_just_above_zero_rejected() {
    // month=0.5 → trunc → 0 → month <= 0 → #NUM!.
    assert_eq!(
        db(&[n(1000.0), n(100.0), n(5.0), n(1.0), n(0.5)]),
        Value::Error(ErrorValue::Num)
    );
}
```

---

### LOW-5: Coverage-entry "Microsoft example fixture" claim is overstated for SYD

**File:** `crates/ql-functions/tests/coverage.rs:315`

**Issue:**
```rust
(
    "SYD",
    "W5-180; unit tests pin (cost-salvage)·(life-per+1)·2/(life·(life+1)) + per>life / per<=0 / life=0 → #NUM! + Microsoft example fixture (SYD(30k,7.5k,10,1)≈4090.91)",
),
```

The test `syd_microsoft_example_first_year` computes expected as
`22500.0 * 10.0 * 2.0 / (10.0 * 11.0)` — that's the formula, not the
Microsoft display value 4090.91. Same tautology pattern as LOW-1 / LOW-2.

**Why it's wrong:** Coverage entry over-claims independent verification.

**Fix:** Either add an anchor `assert!((result - 4090.91).abs() < 0.01)` in
the test, or soften the coverage-entry wording from "Microsoft example
fixture" to "formula identity at the Microsoft example point".

---

### LOW-6: `ddb_microsoft_example_first_year` succinctly pins 480 — but for DDB(2400, 300, 10, 10) the test bypasses Microsoft's third example

**File:** `crates/ql-functions/src/financial_fns.rs:1835-1839`

**Issue:** Microsoft's DDB doc lists five examples (verified by WebFetch):
- `=DDB(A2,A3,A4*365,1)` → $1.32
- `=DDB(A2,A3,A4*12,1,2)` → $40.00
- `=DDB(A2,A3,A4,1,2)` → $480.00
- `=DDB(A2,A3,A4,2,1.5)` → $306.00
- `=DDB(A2,A3,A4,10)` → $22.12

We pin $1.32 (indirectly via `ddb_microsoft_example_first_year` with the daily
factor? Actually no — we only pin $480 and $40 and $22.12). The $306 example
with `factor=1.5` is not tested.

**Why it's wrong:** Test gap on a documented Microsoft fixture. `factor=1.5`
exercises the non-integer-factor path, which is distinct from integer factor.

**Fix:** Add:

```rust
#[test] fn ddb_microsoft_example_factor_1_5_period_2() {
    // Microsoft docs: DDB(2400, 300, 10, 2, 1.5) = $306.00.
    // rate=1.5/10=0.15; value=2400*0.85=2040; new_value=2400*0.85^2=1734;
    // max(300, 1734)=1734; result=2040-1734=306.
    approx(ddb(&[n(2400.0), n(300.0), n(10.0), n(2.0), n(1.5)]), 306.0, 1e-9);
}

#[test] fn ddb_microsoft_example_daily_factor() {
    // Microsoft docs: DDB(2400, 300, 10*365, 1) = $1.32.
    approx(ddb(&[n(2400.0), n(300.0), n(3650.0), n(1.0)]), 1.315068...let_me_compute, 0.005);
}
```

---

### LOW-7: SYD per is allowed fractional but the matrix description doesn't note it

**File:** `docs/compat/excel-matrix.md:262`

**Issue:** The SYD matrix entry says:

> `per <= 0` or `per > life` → `#NUM!`. `per = life` boundary is valid (the
> rule is `>`, not `>=`).

Doesn't mention that fractional `per` (e.g., `per = 0.5`) is accepted and
returns a valid numeric result. Likely intentional (matches Excel's loose
fractional acceptance) but undocumented.

**Why it's wrong:** Minor matrix-doc gap. Low impact.

**Fix:** Add a note: "Fractional `per` accepted (no integer enforcement)."

---

### LOW-8: DDB closed-form `(1.0 - rate).powf(period - 1.0)` may compute `0.0_f64.powf(0.0) = 1.0` for an edge case

**File:** `crates/ql-functions/src/financial_fns.rs:614`

**Issue:** When `rate = 1.0` and `period = 1.0`, the code takes the `rate == 1.0`
branch (line 607), returning `cost`. So the `.powf(period - 1.0)` path is NOT
taken — no `0.powf(0)` evaluation. Safe.

When `rate < 1.0` and `period = 1.0`: `(1-rate).powf(0.0) = 1.0`. ✓
When `rate = 0.999...` and `period = 1.0`: `0.001.powf(0.0) = 1.0`. ✓

No actual bug — but the comment-level claim "closed-form despite the name" deserves
a one-line guard about why `rate == 1.0` is handled separately (the
`0.0_f64.powf(0)` IEEE result would be `1.0` which would happen to be correct,
but the explicit branch is clearer).

**Why it's wrong:** Not wrong — just under-documented. The `rate == 1.0` branch
exists ONLY to handle `period > 1.0` cleanly (avoiding `0.0.powf(positive) = 0.0`,
which gives `value = 0` correctly). For `period == 1.0` the branch returns
`cost`, but the else-branch would have given the same answer (`cost * (0).powf(0) = cost * 1 = cost`). The branch is structural insurance.

**Fix:** Trivial LOW. Either:
1. Comment the branch with: "Separates period=1 (returns cost) from period>1
   (would compute `cost * 0.powf(0) = cost` incorrectly — IEEE quirk — so we
   return 0 explicitly)."
2. Or do nothing — current code is correct.

---

### LOW-9: SYD invariant test tolerance 1e-6 is conservative but worth noting headroom

**File:** `crates/ql-functions/src/financial_fns.rs:1811-1830`

**Issue:** The invariant `Σ SYD(k) for k=1..life == cost - salvage` is tested
with tolerance 1e-6 at $22,500 scale. Mathematically the sum is exact:
`Σ k * 2 / (n(n+1)) = 1` for k=1..n. Floating-point accumulation over 10 terms
at this scale gives error ≤ a few ULPs ≈ 1e-12. The 1e-6 tolerance has 6
orders of magnitude of headroom.

**Why it's wrong:** Not wrong; just unnecessarily loose. A tighter tolerance
(1e-9 or 1e-10) would catch subtler regressions (e.g., if someone changed
the formula to use `(life - per) + 1.0` instead of `(life - per + 1.0)` —
mathematically identical but with different float rounding).

**Fix:** Tighten to 1e-9:

```rust
assert!(
    (total - (cost - salvage)).abs() < 1e-9,
    ...
);
```

---

## Summary

- **1 HIGH** — `db_full_year_period_equals_life_succeeds` doesn't pin the numeric
  value, masking potential regressions on the loop+final-period code path.
- **9 MEDIUM** — Mostly documentation accuracy (over-attribution to "Microsoft"
  for IronCalc conventions); a real validation gap on `DB life ≤ 0` with
  `month < 12`; a real semantic bug on `DB` with fractional `period < 1`;
  potential DoS on huge `period`/`life`; undocumented Boolean-rejection
  divergence on DB's `month`.
- **9 LOW** — Test count off-by-one in matrix; tautological "Microsoft fixture"
  tests; missing fractional-month edge tests; missing `factor=1.5` Microsoft
  fixture for DDB; tolerance headroom in invariant test.

### Things I checked and found correct

- DDB closed-form math is provably equivalent to Microsoft's per-period
  `min(book*rate, book-salvage)` formula (proof in MEDIUM-8).
- DB loop iteration count `0..period_int - 2` correctly produces "cumulative
  through period (k-1)" after the loop. Verified for period=1, 2, 7, life+1.
- `f64::powf(0.0, 0.0)` returns 1.0 (IEEE), so the closed-form is safe at
  the `period=1, rate=1` boundary even without the explicit branch.
- NaN/Inf input handling: `arg_num` → `to_number_strict_skip_blank` →
  `to_number_strict` rejects NaN/Inf with `#NUM!` at the coercion layer
  before any arithmetic.
- All four functions registered in `registry.rs:436-450`.
- E2E tests (`region_mul2_e2e.rs:449-496`) cover SLN/SYD/DDB/DB through the
  full evaluator path with at least one fixture per function.
- Validation of `life <= 0` for DDB happens **indirectly** via `period > life`
  (since `period > 0` is validated, `life ≤ 0` makes `period > life` true).
  ✓ Correctly closed.
- Validation of `life <= 0` for SYD happens via the explicit `if life == 0.0`
  + the `per > life` check (for life < 0). ✓ Correctly closed.
- DB's `cost == 0` short-circuit correctly avoids `(salvage/0)` NaN.
- DB's three-decimal rate rounding `round((1 − (salvage/cost)^(1/life)) * 1000) / 1000`
  matches IronCalc byte-for-byte (`f64::round` matches `f64::round`).
- DDB rate-clamp `rate = 1.0` when `factor > life` matches IronCalc.

### What I did NOT check

- Actual Excel behavior (no Excel testbed). All "Microsoft canon" claims are
  based on the Support docs and IronCalc convention. Where the docs are silent
  (most error-code asymmetries), the only true canon is "what real Excel does"
  — which we should test directly in a follow-up.
- Codex audit findings — this is the parallel Opus audit, written without
  reading Codex's output, per the prompt.
