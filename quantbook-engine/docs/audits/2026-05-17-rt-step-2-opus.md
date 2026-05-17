# Reference-tier Step 2 — separate-Opus audit

**Date:** 2026-05-17
**Subject:** Step 2 implementation commit (working-tree, pre-commit) of the reference-tier mini-phase. Registers the first 4 user-facing reference-aware fns (ROW / COLUMN / ROWS / COLUMNS) through the Step 1 + Step 1.1 infrastructure.
**Auditor:** separate-Opus (4.7, 1M-context), independent of the parallel Codex audit running concurrently.
**HEAD baseline:** `4efabe35deb` (post-Step-1.1). Test count: 3105 → 3173 (+68, breakdown: 35 unit + 32 e2e + 1 invariant). All four gates reported green.
**Design doc:** `docs/architecture/2026-05-17-reference-tier-design.md` v2 § 5.6.
**Plan:** `.plans/_active.md` § Phase 2.
**Step 1 audit transcripts:** `docs/audits/2026-05-17-rt-step-1-{codex,opus}.md`.

## Audit scope

Files read end-to-end:

- **NEW:** `crates/ql-functions/src/reference_fns.rs` (513 lines, 4 impls + 35 unit tests).
- `crates/ql-functions/src/lib.rs` (module addition).
- `crates/ql-functions/src/registry.rs` (lines 240-330, 770-880 — `register_reference_aware` registrations + count test + comment).
- `crates/ql-functions/src/reference_aware_fns.rs` (full file 305 lines — for RefArg / RefContext / PlanKind / ArgContract semantics).
- `crates/ql-exec/src/plan.rs` (lines 100-170, 380-510, 670-740, 1620-1770 — `is_reference_aware_function`, binder arm, step_2 invariant test).
- `crates/ql-exec/src/scalar.rs` (lines 300-510, 539-875 — dispatcher arm, materializers, cell-boundary guard).
- `crates/ql-exec/src/calcgraph_session.rs` (lines 160-410, 1700-1740 — `is_address_only_reference_fn`, walker, dep-suppress invariant test).
- `crates/ql-exec/src/env.rs` (lines 154-320 — WorkbookEnv reference_query impl).
- **NEW:** `crates/ql-exec/tests/reference_fns_e2e.rs` (264 lines, 32 e2e dispatch tests).
- `crates/ql-functions/tests/coverage.rs` (lines 575-605 — 4 EXPLICITLY_DEFERRED entries).
- `docs/compat/excel-matrix.md` (lines 220-223 — 4 row updates).
- `crates/ql-types/src/address.rs` (Range normalization invariant verification).
- `crates/ql-types/src/array.rs` (ArrayValue::rows/cols/new — no `.shape()` method exists despite design pseudo-code).
- `.references/ironcalc/base/src/functions/lookup_and_reference/mod.rs:608/623/636/675` (IronCalc canon cross-check).

## Findings — final dispositions

**Tally:** 3 HIGH + 9 MEDIUM + 12 LOW = **24 findings.**

Per the audit-discipline rule ("don't stop at 2-3 findings; surface every concern"), I have included even low-impact items.

---

## HIGH

### HIGH-S2-O-1 — Plan checklist item "8+ tests per fn covering: anchor, range, named-range, cross-sheet, array literal, non-reference, #REF!, LibreOffice" is partially-completed. **Named-range AND cross-sheet coverage are completely absent from BOTH unit and e2e tests.**

**Where:** `.plans/_active.md:87` (`Phase 2` plan checklist), `crates/ql-functions/src/reference_fns.rs:130-513` (unit tests), `crates/ql-exec/tests/reference_fns_e2e.rs:1-264` (e2e tests), design § 7 cross-fn coverage matrix at `docs/architecture/2026-05-17-reference-tier-design.md:690-705`.

**Detail:** The plan explicitly lists 8 test categories per fn in Step 2:

```
- [ ] Tests: 8+ per fn covering anchor, range, named-range, cross-sheet, array literal (for ROWS/COLUMNS), non-reference, `#REF!` propagation, LibreOffice cross-check.
```

A grep across both test files for `NamedRange` / `Sheet2` / `cross.sheet` / `NameRef` / `set_name` returns **zero matches.** Both classes of coverage are completely absent:

1. **Named-range arg coverage:** zero tests. Design § 7 explicitly requires `ROWS(NamedRange)` / `ROW(NamedCell)` (line 698). The eager materializer at scalar.rs:583-586 has a dedicated `ExprPlan::AggregateNameRef` arm that produces `RefArg::Range`; the walker at calcgraph_session.rs:398-400 has a dedicated arm pushing `deps.names`. Both code paths are exercised ZERO times by Step 2's test suite. **The first time a Step-2-registered fn will see a named-range arg is at end-user time.**

2. **Cross-sheet ref coverage:** zero tests. All ROW/COLUMN/ROWS/COLUMNS unit + e2e tests use sheet `0` (or implicit sheet 0 via `eval_with_map`). The binder's cross-sheet resolution path (when `Sheet2!A1` is bound) feeds CellRef plans through to the materializer, but no test sees that path. The materializer's CellRef arm at scalar.rs:574-582 reads `env.read_cell(sheet, row, col)` — if the sheet ID is `1` instead of `0`, the path is structurally distinct (different env lookup, different bind resolution).

3. **Structured-ref arg coverage:** zero tests. The cell-boundary guard at scalar.rs:849-861 has a dedicated `ExprPlan::StructuredRef` arm using `narrow_structured_ref`. The Step 1.1 S1-HIGH-B closure added this guard EXPLICITLY for structured refs; no test in Step 2 exercises `ROW(Sales[Qty])` / `ROWS(Sales[Qty])` / `COLUMN(Sales[@Col])`. The closure is verified only by the unit `dep_suppressed_reference_fns_match_design` test that pin-checks the matcher; the actual dispatch + materialization + narrowing + guard chain has no end-to-end test.

4. **Implicit-intersection `@ROW(...)`:** zero tests. Listed in design § 7 line 701.

The plan checklist item is `- [ ]` (unchecked) in `.plans/_active.md`. If Step 2 is to be marked complete and proceed to Step 3 audit, either (a) the gaps close OR (b) the plan checklist is explicitly amended with deferral rationale (analogous to how Step 1.1 amended deferred LOWs with written reasons).

**Recommendation:** Before Step 2 ships, add at minimum:

- **Per-fn named-range unit test** using a scratch `NameTable` setup (existing pattern in `plan.rs::tests` uses `nag_05_...` for the named-range bind path; mirror that to construct a `bind_with_names` call that produces `ExprPlan::AggregateNameRef`, then dispatch through `eval_scalar_with_cache` with the appropriate env).
- **Per-fn cross-sheet e2e test** registering a 2-sheet workbook via the existing `workbook_with_formulas` helper or equivalent, then `ROW(Sheet1!A1)`, `ROWS(Sheet1!A1:A5)` etc.
- **Structured-ref test** — at minimum two: `ROW(Sales[@Col])` (narrowed single-cell, expects scalar) + `ROW(Sales[Col])` (multi-cell, expects #CALC! at boundary).
- **Single `@ROW(A1:A10)` test** to verify implicit-intersection (or document it as Step 5 cross-cutting coverage per design § Step 5 line 661, with explicit rationale this is intentionally deferred).

If deferred to Step 5 (as design § Step 5 cross-cutting suite implies for some), update the plan to amend the Phase 2 checklist to specify which categories are deferred to Step 5 and which are in scope for Step 2.

**Severity rationale:** HIGH because (a) the plan checklist enumerates these as Step 2 requirements; (b) the design's per-fn matrix § 7 ships them as core coverage; (c) the materializer + walker + binder have dedicated code paths for each that ship without test coverage; (d) the cell-boundary S1-HIGH-B Step 1.1 closure was specifically added to handle StructuredRef and is untested at the integration level. This is the same load-bearing pattern as Step 1's HIGH-O-1 (doc-promised invariant test missing): work the plan explicitly required but didn't ship.

---

### HIGH-S2-O-2 — `materialize_ref_arg_eager` `ExprPlan::CellRef` arm reads cell value unconditionally but the value is unused by ALL v1 reference-aware fn impls (ROW/COLUMN/ROWS/COLUMNS/ISFORMULA/FORMULATEXT). Result: wasted `env.read_cell` per dispatched call + the read-error pattern bypasses the eager-error propagation contract that the fallthrough arm honors.

**Where:** `crates/ql-exec/src/scalar.rs:573-582`.

```rust
ExprPlan::CellRef {
    sheet, row, col, ..
} => {
    let value = env.read_cell(*sheet, *row, *col);
    RefArg::Reference {
        address: ql_types::Address::new(*sheet, *row, *col),
        value,
    }
}
```

**Detail:** Two distinct issues bundled because they share a root cause (the CellRef arm doesn't follow the same error-mapping pattern as the fallthrough `other` arm at line 618-624).

**(1) Wasted read.** The four Step 2 fns ROW/COLUMN/ROWS/COLUMNS pattern-match `RefArg::Reference { address, .. }` — the `value` field is never used. A grep across `crates/ql-functions/src/` for `RefArg::Reference` pattern confirms only `..`-binding access; the design's ISFORMULA/FORMULATEXT pseudo-code at design § 5.6 also uses `..` (only `address` is consumed). So in v1, `value` is dead-code-loaded for every CellRef arg. For an Eager-contract fn that doesn't need the value, this is wasted CPU (a `read_cell` HashMap lookup or sheet-column-store probe per arg). For a workbook with thousands of ROW(...) formulas in a recompute cycle, this scales linearly to thousands of wasted reads.

**(2) Read errors silently coerced to non-error refs.** WorkbookEnv's `read_cell` returns `Value::Error(ErrorValue::Ref)` for out-of-bounds sheet (env.rs:178-181, Phase 2A.7 audit H6 closure). The fallthrough `other` arm in materialize_ref_arg_eager at scalar.rs:618-624 handles this case:

```rust
other => {
    let v = eval_scalar_with_cache(other, env, registry, cache);
    match v {
        Value::Error(ev) => RefArg::Error(ev),
        ok => RefArg::Scalar(ok),
    }
}
```

If the eval result is an error, the materializer wraps in `RefArg::Error` so the per-fn impl propagates via the explicit `RefArg::Error(ev) => Value::Error(*ev)` arm.

**The CellRef arm bypasses this.** It always produces `RefArg::Reference { address, value: <whatever-read_cell-returned> }` — even when `value` is `Value::Error(...)`. ROW/COLUMN/ROWS/COLUMNS then ignore the `value` and return the row/col index, suppressing the error.

**Concrete user-visible case** (low-likelihood in v1 because sheet-delete API isn't exposed in workbook_runtime — see CC note below — but reachable through scenarios where a binder mis-resolution happens at the boundary, or through any future deletion path):

- A formula `=ROW(Sheet99!A1)` where `Sheet99` was resolved at bind time but is now stale.
- WorkbookEnv::read_cell returns `Value::Error(ErrorValue::Ref)`.
- Materializer wraps in `RefArg::Reference { address: Address::new(99, 0, 0), value: Error(Ref) }`.
- ROW returns `Value::number(1.0)` — **NOT `#REF!`**.
- Excel canon: `=ROW(Sheet99!A1)` where Sheet99 doesn't exist returns `#REF!`. **Our impl returns `1`.**

The design § 5.6 pseudo-code DOES match what the impl does:

```rust
RefArg::Reference { address, .. } => Value::number(address.row as f64 + 1.0),
```

…but the design pseudo-code assumes the materializer maps read-errors to `RefArg::Error(ev)`, not to `RefArg::Reference { value: Error }`. The materializer's CellRef arm is the bridge that's misshaped.

**Reachability assessment.** Today, the workbook_runtime has no `delete_sheet` API (grep for `delete_sheet` / `remove_sheet` in workbook_runtime.rs returns 0 production paths). So the deleted-sheet case isn't exercisable from end-user formulas. BUT: any future deletion API will need to either (a) bring this in scope as a regression OR (b) ship with this materializer arm pre-fixed. Also: the WorkbookEnv's `read_cell` returns `Blank` for missing cells in an existing sheet — that's correct and not an error. The error-path is reachable only via the missing-sheet branch today.

**Recommendation:** Two paths, pick one:

1. **Lazy value.** Change `RefArg::Reference` to carry `Option<Value>` or drop the `value` field entirely (no v1 consumer uses it). Cleanest fix; ABI break but ABI is internal.
2. **Eager-error propagation.** Mirror the `other` arm's error mapping in the CellRef arm:

```rust
ExprPlan::CellRef { sheet, row, col, .. } => {
    let value = env.read_cell(*sheet, *row, *col);
    match value {
        Value::Error(ev) => RefArg::Error(ev),
        ok => RefArg::Reference {
            address: ql_types::Address::new(*sheet, *row, *col),
            value: ok,
        },
    }
}
```

This preserves the unused-`value`-load (path 2 doesn't address the wasted-CPU concern but DOES fix the error-propagation gap). Pair with a doc-comment update.

For ABI correctness AND wasted-CPU, path 1 is preferred. For minimal change in Step 2, path 2 closes the user-visible defect.

**Severity rationale:** HIGH because the error-propagation gap is a documented Excel-canon divergence (`#REF!` → `1`) that nothing in the codebase catches today. The wasted-CPU portion is MEDIUM-flavored; the error-propagation gap is HIGH-flavored. Bundled because the fix is the same code site. Note that pre-Step-2 this gap existed but was unreachable (no fns dispatched through the materializer); Step 2 makes it reachable for the first time.

---

### HIGH-S2-O-3 — `is_reference_aware_function` doc-comment is now stale; it still claims "v1 always returns false until the 7 reference-aware fns are registered in Step 2 / 3 / 4", but Step 2 has registered 4 of the 7. The doc-comment is now factually incorrect post-Step-2.

**Where:** `crates/ql-exec/src/plan.rs:496-500`.

```rust
/// Pinned via the `accepts_special_arg_lists_only_registered_reference_aware`
/// invariant test (added in this commit). v1 always returns false until the
/// 7 reference-aware fns are registered in Step 2 / 3 / 4 — that ordering
/// is intentional: Step 1 ships the infrastructure with no user-facing fn
/// dispatching through it, gates green.
```

**Detail:** Two factual errors in this doc-comment AFTER Step 2:

1. **"v1 always returns false until …"** — false. With Step 2 registering ROW/COLUMN/ROWS/COLUMNS, `is_reference_aware_function` returns `true` for those names AND the binder lowers their `RangeRef` args under `BindContext::ReferenceArg`. The matcher is no longer effectively a no-op.

2. **The doc-comment references `accepts_special_arg_lists_only_registered_reference_aware` as a test name that "[is] added in this commit"** — this comment was written in Step 1. The test actually shipped under a different name in Step 1.1: `accepts_special_arg_lists_only_registered_reference_aware_matcher_pin` (plan.rs:1696). The Step 2 invariant test is `step_2_reference_aware_names_registered_in_reference_tier` (plan.rs:1742). The doc references neither; it references a name that never existed.

Step 1 Opus audit caught the same pattern as HIGH-O-1 — doc-comment references nonexistent test name. Step 1.1 closure created the test under a renamed form but didn't update the doc-comment to point at the renamed test. Step 2 changes the surrounding factual landscape but doesn't touch this doc-comment.

**Recommendation:**

```rust
/// Pinned via two invariant tests:
/// - `accepts_special_arg_lists_only_registered_reference_aware_matcher_pin`
///   (plan.rs:1696) — every name the matcher returns true for must be in
///   the design's enumeration; typo guard.
/// - `step_2_reference_aware_names_registered_in_reference_tier`
///   (plan.rs:1742) — every Step 2 / 3 / 4 registered reference-aware fn
///   must be recognized here (currently 4 of 7; extends as Step 3/4 ship).
///
/// Before Step 2: matcher was always-stale (no fns registered yet; the
/// matcher pre-listed the names from design v2). Post-Step 2: 4 of 7
/// fns registered; ISREF / ISFORMULA / FORMULATEXT pending Step 3 / 4.
pub(crate) fn is_reference_aware_function(name: &str) -> bool {
```

**Severity rationale:** HIGH because (a) the doc-comment is a falsehood (per the "no fallbacks / fail visibly" rule, doc lies are silent state); (b) it conflates two test names (one nonexistent, one different from what was actually shipped); (c) Step 2 is the natural moment to fix it since Step 2 changes the factual state the doc-comment describes. The pattern signal from Step 1 audit ("Doc-promised invariant tests can fail to ship") strongly applies — the fix shipped under a different name, and the doc stayed pointing at the original name. Now Step 2 lands without revisiting the doc.

---

## MEDIUM

### MEDIUM-S2-O-1 — Microsoft canon claim in `row()` doc-comment ("`ROW({1,2,3})` is array-context spill; v1 returns `#VALUE!` in scalar context") is not verified by any test for the specifically-claimed shape.

**Where:** `crates/ql-functions/src/reference_fns.rs:55-58`.

**Detail:** The doc-comment for `row` says:

> ROW does NOT accept array literals (only ROWS does). Microsoft canon: `ROW({1,2,3})` is array-context spill; v1 returns `#VALUE!` in scalar context.

The only test of "ROW with array literal" is `row_of_array_literal_is_value_error` (lines 238-245) which uses a 2×2 ArrayValue:

```rust
let av = ArrayValue::new(2, 2, vec![Value::number(1.0); 4]).unwrap();
```

`{1,2,3}` would be a 1×3 ArrayValue. The shape difference matters because the materializer's Array arm at scalar.rs:602-615 builds ArrayValue with `row_count = rows.len()` and `col_count = rows.first().map(|r| r.len())` — which for `{1,2,3}` gives (1, 3), not (2, 2). The ROW fn's `RefArg::Array(_)` arm still returns `#VALUE!` because shape doesn't matter, but the **claimed-canonical shape** isn't tested.

**Recommendation:** Add a unit test `row_of_one_by_three_array_returns_value_error` using `ArrayValue::new(1, 3, vec![Value::number(1.0), Value::number(2.0), Value::number(3.0)])`. Same for column with a 3×1 array (the typewise-symmetric case). Minor coverage gap.

**Severity rationale:** MEDIUM-as-doc-promise; LOW-as-actual-impact (the impl returns #VALUE! regardless of shape via the unconditional `RefArg::Array(_)` arm). Calling it MEDIUM because the doc-comment names a specific canon case that should have at least one corresponding test, and there's a similar gap for the COLUMN side.

---

### MEDIUM-S2-O-2 — No workbook-runtime end-to-end test exists for `=ROW()` / `=COLUMN()` zero-arg behavior threaded through a real formula cell. The only zero-arg tests use `MapEnv` which always returns `None` for `formula_cell`, exercising only the `#REF!` fallback path. The 'happy path' (formula in cell B3 calls `=ROW()` → returns 3) ships **untested.**

**Where:** `crates/ql-functions/src/reference_fns.rs:204-209`, `crates/ql-exec/tests/reference_fns_e2e.rs:77-80`.

```rust
#[test]
fn row_with_zero_args_in_scalar_context_returns_ref() {
    // No formula cell wired → #REF!.
    assert_eq!(eval_with_map("ROW()"), Value::Error(ErrorValue::Ref));
}
```

```rust
#[test]
fn row_zero_arg_with_formula_cell_returns_formula_row() {
    let ctx = ctx_at(0, 6, 2);
    // Formula cell at row 6 (0-indexed) → ROW() = 7.
    assert_eq!(row(&[], &ctx), Value::number(7.0));
}
```

**Detail:** The unit test exercises the `row()` fn directly with a synthetic `RefContext` constructed via `ctx_at(0, 6, 2)`. This pins the per-fn logic in isolation. The e2e test uses MapEnv which doesn't implement `with_formula_cell`, so `env.formula_cell_for_sref()` returns the CellEnv default of `None`.

The actual production path is: `WorkbookRuntime::recompute_dirty` calls `WorkbookEnv::with_formula_cell(workbook, addr)` at workbook_runtime.rs:738-741. The `eval_at_cell_boundary` reads `env.formula_cell_for_sref()` at scalar.rs:458 → `Some(addr)` → ROW's per-fn impl returns `addr.row + 1`.

**The full chain `WorkbookRuntime → set_formula → recompute_dirty → eval_at_cell_boundary → scalar.rs:437 dispatcher arm → materialize_ref_arg_eager → row() per-fn → return Value::number(row+1)` is NOT exercised by any test in Step 2.**

A bug anywhere in this chain (e.g., `with_formula_cell` not actually setting `formula_cell` for non-StructuredRef contexts; the dispatcher arm reading from a different accessor; the `RefContext::new` call passing the wrong argument) ships without detection.

The risk is amplified by the design § 8 R7 line in design v2: "Op-log replay verified" — but the verification was that the StructuredRef path exists for `[@Col]`, not that the ROW() path also rides that infrastructure correctly. Different consumer of the same accessor; same wiring, but unverified for this consumer.

**Recommendation:** Add at least one integration test in `crates/ql-exec/tests/region_mul2_e2e.rs` (or a new file) that:

1. Constructs a `WorkbookRuntime` with a single sheet.
2. Calls `rt.set_formula(0, 5, 2, "=ROW()")`.
3. After recompute, asserts the value at (0, 5, 2) is `Value::number(6.0)` (row 5 is 0-indexed → Excel row 6).
4. Mirror for `=COLUMN()`.

This is THE integration test that proves `=ROW()` actually works in a real workbook. Without it, Step 2 ships a feature whose primary use-case (zero-arg ROW/COLUMN inside a cell) has no end-to-end coverage.

**Severity rationale:** MEDIUM. The unit + e2e tests prove the per-fn logic. The wiring through WorkbookRuntime is well-trodden ground (used by every Phase-3+ formula path). But Step 2's narrative goal is "ship ROW/COLUMN/ROWS/COLUMNS as user-facing fns"; the primary use-case for `ROW()` is inside a cell, and that path is untested. The risk of a real bug here is low but the coverage gap is real.

---

### MEDIUM-S2-O-3 — `walk_plan_for_deps`'s `ExprPlan::RangeRef` arm doc-comment is stale post-Step-2; it claims "the only v1 consumers (ISFORMULA / FORMULATEXT multi-cell → #N/A)" but Step 2 registers ROW/COLUMN/ROWS/COLUMNS which ALSO consume literal `RangeRef` args (via the address-only walker route).

**Where:** `crates/ql-exec/src/calcgraph_session.rs:302-325`.

```rust
// **W5-RT-1 / Step 1.1 (S1-MED-δ closure):** literal range refs
// bind to `ExprPlan::RangeRef { range }` inside reference-aware
// fn arg lists. In v1, this arm is only reachable when ISFORMULA
// or FORMULATEXT takes a literal range — both of which return
// `#N/A` for multi-cell ranges per Microsoft canon, so the
// result is value-independent. No deps registered.
// ...
ExprPlan::RangeRef { range: _ } => {}
```

**Detail:** Pre-Step-2, no reference-aware fn was registered, so this arm was unreachable. Step 1.1's closure preemptively wrote the dep-suppression semantics for ISFORMULA / FORMULATEXT (the only fns that go through `walk_plan_for_deps` directly — ROW/COLUMN/ROWS/COLUMNS are address-only and route through `walk_plan_for_address_only_deps`, which has its own RangeRef arm at line 395).

Post-Step-2, ROW/COLUMN/ROWS/COLUMNS DO accept `RangeRef` args; they're dispatched through the address-only walker so this arm is technically still not reached by them. But ISFORMULA / FORMULATEXT are STILL not registered (Step 3 / 4). So in actual v1 reachability:

- This arm is reached when a `RangeRef` exists somewhere outside an address-only-reference-aware fn arg. Step 2 has no such case.
- Step 3 (ISREF Lazy) won't reach this arm — ISREF's LazyShape contract bypasses dep walking entirely.
- Step 3 (ISFORMULA Eager) WILL reach this arm — ISFORMULA is reference-aware but NOT address-only.
- Step 4 (FORMULATEXT) WILL reach this arm.

So at Step 2, the comment is technically still correct ("only reachable when ISFORMULA / FORMULATEXT take a literal range") because Step 3 / 4 haven't shipped yet, but the comment doesn't enumerate which fns route through which walker — a future reader has to trace through `is_address_only_reference_fn` to understand. Combined with HIGH-S2-O-3 (the matcher doc-comment), the cross-file documentation graph has multiple stale or under-explained edges.

**Recommendation:** Extend the doc-comment to enumerate which fns reach this arm, anchored to the registry state. Example:

```
**Reachability:**
- ROW / COLUMN / ROWS / COLUMNS (address-only): NEVER reach this arm —
  they route through `walk_plan_for_address_only_deps` which has its own
  RangeRef arm at line 395.
- ISREF (address-only, LazyShape contract): NEVER reaches this arm — Lazy
  contract bypasses dep walking entirely.
- ISFORMULA / FORMULATEXT (Eager, not address-only): when ISFORMULA(A1:A5)
  or similar binds, this arm fires. Both return #N/A for multi-cell ranges,
  so result is value-independent. No deps registered.
```

**Severity rationale:** MEDIUM because the existing doc-comment is ambiguous and the registry state changes with each Step; without an explicit walker-routing table, future contributors will read the comment, see "ISFORMULA / FORMULATEXT" and wonder "what about ROW(A:A)?" The answer (different walker) isn't documented at this site.

---

### MEDIUM-S2-O-4 — Test count claimed in `docs/compat/excel-matrix.md` ("9+8 e2e" for ROW, "8+8 e2e" for ROWS) doesn't match actual test counts (10 unit + ~11 e2e for ROW, 9 unit + 8 e2e for ROWS).

**Where:** `docs/compat/excel-matrix.md:220-223`.

**Detail:** The matrix rows show "TestCount" as `9+8 e2e`, etc. Comparing to actual:

| Fn | Matrix unit | Actual unit | Matrix e2e | Actual e2e (top-level + boundary) |
|----|-------------|-------------|------------|------------------------------------|
| ROW | 9 | 10 | 8 | 8 + 3 boundary = 11 |
| COLUMN | 8 | 8 | 6 | 6 + 1 boundary = 7 |
| ROWS | 8 | 9 | 8 | 8 |
| COLUMNS | 8 | 8 | 6 | 6 |

The unit counts are off by one for ROW (10 vs 9) and ROWS (9 vs 8); the e2e counts undercount ROW (the cell-boundary tests aren't included).

Counting methodology isn't documented anywhere — is "Tests" supposed to be unit-only, e2e-only, or sum? The existing rows in the matrix use inconsistent formats ("8" for VLOOKUP; "6" for XLOOKUP; "1" for ISBLANK; "9+8 e2e" for the new ROW row). The Step 2 entries are the first to use a `X+Y e2e` notation, with no consistent prior pattern.

**Recommendation:** Either:

1. **Pick one number to surface** (e.g., total = unit + e2e) and use it consistently. ROW = 21 (or 18 if cell-boundary tests don't count).
2. **Document the convention** in a header note at the top of the matrix (e.g., "Test counts: unit-tests + integration-tests").
3. **Match actual numbers** if the X+Y convention stays — ROW = "10+11", etc.

The current numbers are wrong by 1-3 for each Step 2 fn.

**Severity rationale:** MEDIUM-as-documentation-drift; LOW-as-actual-impact. The matrix is a coverage record, not a load-bearing contract. But this is precisely the kind of small inconsistency that, accumulated, makes the matrix untrustworthy.

---

### MEDIUM-S2-O-5 — `is_reference_aware_function` includes ISFORMULA / FORMULATEXT (preempting Step 3 / 4 registration) but Step 2's invariant test `step_2_reference_aware_names_registered_in_reference_tier` only iterates 4 names. A spelling error in ISFORMULA / FORMULATEXT (only in the matcher; not yet in the registry) WILL pass through Step 2 unnoticed; the asymmetry isn't pin-checked here.

**Where:** `crates/ql-exec/src/plan.rs:501-506` (matcher) AND `crates/ql-exec/src/plan.rs:1742-1768` (Step 2 invariant test) AND `crates/ql-exec/src/plan.rs:1696-1730` (Step 1 matcher-pin test).

**Detail:** The Step 1 matcher-pin test (`accepts_special_arg_lists_only_registered_reference_aware_matcher_pin`) iterates all 7 names and confirms `is_reference_aware_function` returns true for each. The Step 2 invariant test confirms the 4 Step-2-registered names ARE in the registry AND match the matcher AND aren't in other tiers. Excellent.

But: if someone types `"FORMULATXT"` into the matcher (instead of `FORMULATEXT`), the Step 1 matcher-pin test would FAIL (the test asserts `is_reference_aware_function("FORMULATEXT")` returns true). So the typo case is caught. ✓

The OPPOSITE case: if someone removes `FORMULATEXT` from the matcher but leaves it as a sentinel non-reference-aware name (e.g., accidentally adds it to is_aggregate_function), the matcher-pin test would catch the removal but NOT a cross-tier-conflation. Cross-tier-conflation IS caught at registration time (insert_or_panic detects duplicate names), but only at Step 3/4 when FORMULATEXT actually registers.

**The actual gap I'm flagging:** The Step 2 invariant test checks **disjointness** (registered reference-aware fns must not appear in any other tier). It iterates 4 names. The matcher claims 7 names. The other 3 (ISREF, ISFORMULA, FORMULATEXT) **could already be in some OTHER tier today** (e.g., if someone accidentally registered ISFORMULA as a scalar fn pre-emptively), and the Step 2 invariant test wouldn't detect it because it only iterates the 4 Step-2-registered names.

The Step 1 matcher-pin test pins matcher-only behavior — it doesn't check registry disjointness. So registry disjointness for ISREF / ISFORMULA / FORMULATEXT isn't pinned anywhere as of Step 2.

For Step 2's narrow scope this is minor (those 3 fns aren't registered anywhere). But the design plans for Step 2's invariant test to "extend as Step 3 / 4 land" (comment at plan.rs:1735-1735). The extension is forgettable. Step 2 should already pin the **disjointness** invariant for the OTHER 3 names too — e.g., assert that ISREF, ISFORMULA, FORMULATEXT are NOT YET registered ANYWHERE (sentinel for "not yet shipped").

**Recommendation:** Extend `step_2_reference_aware_names_registered_in_reference_tier` with a second loop:

```rust
// Sentinel: these 3 are reserved for Step 3/4 — must NOT be registered
// in any tier yet. This catches accidental pre-registration AND drift
// where someone adds them to the matcher's reference-aware enumeration
// before they have a real impl.
for name in &["ISREF", "ISFORMULA", "FORMULATEXT"] {
    assert!(
        reg.lookup_any(name).is_none(),
        "{name:?} should not yet be registered (deferred to Step 3/4); \
         found a registration anyway"
    );
    // But matcher still recognizes them (pre-listed for binder context).
    assert!(
        is_reference_aware_function(name),
        "{name:?} should be matched by is_reference_aware_function \
         even though it's not registered yet"
    );
}
```

This shifts the "Step 3 / 4 extend the test" promise from "remember to extend later" to "extend by removing the sentinel, then add the same-shape assertion to the registered-loop."

**Severity rationale:** MEDIUM because the gap is "drift between matcher (pre-lists 7) and registry (4 registered, 3 deferred) not pinned." The Step 1 matcher-pin test pins matcher correctness; the Step 2 test pins disjointness for Step-2 fns. The triangulation of "matcher recognizes 7, registry has 4, none of the other 3 are leaked into other tiers" isn't pinned anywhere. A future contributor who pre-registers ISFORMULA as scalar (for testing) would not get caught by any existing test until Step 3 lands.

---

### MEDIUM-S2-O-6 — Cell-boundary `#CALC!` guard at scalar.rs:834-871 only triggers when `args.len() == 1`; an arity-error case (`=ROW(A1:B3, X)` at cell boundary) falls through to the scalar dispatcher, which returns `#N/A` per the per-fn impl. This is **correct behavior** but the boundary path for `args.len() != 1` is untested.

**Where:** `crates/ql-exec/src/scalar.rs:834-836`.

```rust
ExprPlan::Function { name, args }
    if args.len() == 1
        && matches!(name.as_ref(), "ROW" | "COLUMN")
```

**Detail:** The guard fires only on single-arg ROW/COLUMN with a multi-cell range. For `=ROW(A1:B3, X)` (arity 2), the guard skips and falls to the default arm at line 872:

```rust
_ => EvalResult::Scalar(eval_scalar_with_cache(plan, env, registry, cache)),
```

The scalar dispatcher then evaluates ROW with both args → per-fn match arm `_ => Value::Error(ErrorValue::NA)` (line 64). So the user sees `#N/A` — which is correct per Excel canon (arity error).

But what if the SCALAR evaluation has a subtle bug — e.g., the dispatcher gets confused by mixed arg shapes? No test exists for this multi-arg path at cell boundary. The unit test `row_of_arity_zero_with_extra_args_returns_na` (line 248-254) tests at the per-fn level, but the cell-boundary entry's arity-bypass-skip isn't verified.

Concrete concern: `=ROW(A1, A1:B3)` — args are (CellRef, RangeRef). Materializer produces (RefArg::Reference, RefArg::Range). ROW's match arm sees `args.len() == 2` → `#N/A`. ✓

But what about `=ROW(A1:B3, A1)`? Same shape, different order. Materializer same. ROW same. `#N/A`. ✓

Or `=COLUMN()` — `args.len() == 0` → COLUMN impl returns either calling-cell or #REF!. Cell-boundary guard skip is correct here. ✓

OK so the guard's restriction to `args.len() == 1` IS correct and the per-fn impls handle the other arities. Just no test pins this at the boundary.

**Recommendation:** Add one test:

```rust
#[test]
fn row_of_multi_cell_range_with_arity_two_returns_na_not_calc() {
    // ROW(A1:B3, A1) at cell boundary — the guard doesn't fire (arity > 1),
    // fallthrough returns #N/A from the per-fn arity-mismatch arm.
    let tokens = lex("ROW(A1:B3, A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let plan = ql_exec::bind(&ast, 0).expect("bind");
    let env = MapEnv::new();
    let reg = default_registry();
    match eval_at_cell_boundary(&plan, &env, &reg, &NoAggregateCache) {
        EvalResult::Scalar(Value::Error(ErrorValue::NA)) => {}
        other => panic!("expected #N/A, got {other:?}"),
    }
}
```

**Severity rationale:** MEDIUM. The behavior is correct; the test gap is real but the path is structurally simple.

---

### MEDIUM-S2-O-7 — The `coverage.rs` EXPLICITLY_DEFERRED entries for ROW/COLUMN/ROWS/COLUMNS keep them in the DEFERRED list (test reads "covered by reference_fns unit tests + ql-exec e2e tests"), but the function-coverage test design treats DEFERRED as "intentionally lacks matrix coverage" — these fns DO have coverage, just not in the scalar arg-coverage matrix.

**Where:** `crates/ql-functions/tests/coverage.rs:576-603` AND `coverage.rs:61-65` (the EXPLICITLY_DEFERRED docstring).

**Detail:** The EXPLICITLY_DEFERRED docstring says:

> Functions that intentionally lack matrix coverage today, with a stated reason.

The 4 new entries (ROW/COLUMN/ROWS/COLUMNS) each say "covered by reference_fns unit tests + ql-exec e2e tests; scalar arg-coverage matrix N/A". So semantically they ARE covered — just not by the SCALAR arg-coverage matrix machinery. The matrix machinery only knows about scalar args (Value pre-evaluated); reference-tier fns take RefArg shapes, so the matrix doesn't apply.

Result: these 4 fns are misfiled. They're "covered but in a different testing framework"; the DEFERRED list is for "uncovered, with reason". Conceptually a different bucket.

The practical impact is zero — the `every_registered_function_has_a_coverage_decision` test would equally accept them in either EXPECTED_COVERED or EXPLICITLY_DEFERRED. But the semantics are off; a future audit looking at "what's deferred" would include ROW/COLUMN/ROWS/COLUMNS in its scope unnecessarily.

**Recommendation:** Either:

1. Add a parallel `REFERENCE_TIER_COVERED` list with the same docstring shape, and adjust the orchestrating test to read both.
2. Extend EXPECTED_COVERED to mean "covered by some test suite, see notes" and put ROW/COLUMN/ROWS/COLUMNS there.
3. Document the convention more carefully — EXPLICITLY_DEFERRED = "the scalar matrix doesn't apply, and here's where to look instead."

Option 3 is the lowest-friction; option 1 is the cleanest.

**Severity rationale:** MEDIUM-as-semantic; LOW-as-impact. The test passes; the placement is conceptually wrong.

---

### MEDIUM-S2-O-8 — `RefArg::Range.values: Vec<Value>` is always empty for the 4 Step-2 fns (and would be for Step 3/4's ISFORMULA/FORMULATEXT, per design § 5.6 pseudo-code). The field is dead weight in v1; carrying it adds a `Vec` heap allocation slot to every materialization (zero allocation today, but every `RefArg` constructed pays the layout cost).

**Where:** `crates/ql-functions/src/reference_aware_fns.rs:42-52`.

```rust
Range { range: Range, values: Vec<Value> },
```

**Detail:** The Step 1 audit already flagged this as MEDIUM-O-3. Step 1.1 closure updated the doc-comment (to remove the "populated when consumer iterates" promise) but kept the field. Step 2 doesn't change this — none of ROW/COLUMN/ROWS/COLUMNS reads `values`. Step 3 / 4 (ISFORMULA / FORMULATEXT per design § 5.6 pseudo-code) also don't read `values` — only `range`.

So across all 7 v1 fns: `values` is dead code. Every materializer call constructs `Vec::with_capacity(0)` or `vec![]` (zero allocation, but `RefArg` enum size accommodates the `Vec` discriminant width).

**Recommendation:** Drop the field for v1. The future iterating reference-aware fn (if it ever arrives) can add it back as part of an `ArgContract::EagerWithValues` migration. Today the field exists purely as documentation of intent, which the doc-comment already covers.

Alternatively, change to `values: Option<Vec<Value>>` with the dispatcher only populating when needed — but no fn needs it yet, so the option always sits at `None`.

**Severity rationale:** MEDIUM-as-API-cleanliness; LOW-as-runtime-cost. Carry-over of Step 1's MEDIUM-O-3. Flagging again because Step 2 is the last reasonable moment to drop the field before user-facing fns start dispatching through it; once Step 2 ships, removing the field becomes more disruptive.

---

### MEDIUM-S2-O-9 — Design § 5.6 pseudo-code references `av.shape().0` for ROWS over Array, but `ArrayValue` exposes `rows()` / `cols()` not `shape()`. Impl correctly uses `av.rows()` / `av.cols()` but the design doc still has the old pseudo-code shape. Drift between design-as-written and impl-as-shipped.

**Where:** `docs/architecture/2026-05-17-reference-tier-design.md:530` AND `crates/ql-functions/src/reference_fns.rs:107,121`.

**Detail:** Design pseudo-code:

```rust
[RefArg::Array(av)] => Value::number(av.shape().0 as f64),   // HIGH-C closure
```

Impl:

```rust
[RefArg::Array(av)] => Value::number(f64::from(av.rows())),
```

Same outcome (rows count of the array). But `av.shape()` doesn't exist on `ArrayValue` (grep `pub fn shape` in `crates/ql-types/src/array.rs` returns zero results). The design pseudo-code was written against a non-existent API.

The Step 1 audit summary (line 50, Opus LOW-O-9) flagged this as "design § 5.6 per-fn pseudo-code unverified by Step 1 (Step 2/3/4 work) — flagging for tracking only." That ticket should be closed in Step 2 closure either by updating the design doc OR by adding a `shape()` method to `ArrayValue` that returns `(rows(), cols())`. Today neither happened — the design still says `av.shape().0`, the impl still uses `av.rows()`.

**Recommendation:** Update design § 5.6 to use `av.rows() as f64` and `av.cols() as f64` to match the actual API. Or, alternatively, add `pub fn shape(&self) -> (u32, u32) { (self.rows, self.cols) }` to ArrayValue and update the impl. The former is lower-impact.

**Severity rationale:** MEDIUM-as-design-drift; LOW-as-impact. The Step 1 audit closure tracker explicitly committed to closing this in Step 2 ("deferred to Step 2"); not closing it is a continuation of the design-doc drift pattern Step 1 audit signal #2 captured.

---

## LOW

### LOW-S2-O-1 — Test name `rows_with_text_arg_returns_value_error` exists in e2e but no unit-level analog of "rows with text Scalar arg". The unit test `rows_of_scalar_arg_is_value_error` (line 386) covers `Value::number(0.0)` AND `Value::Text("text")` in a single test body — preferably split into two for cleaner regression bisection.

**Where:** `crates/ql-functions/src/reference_fns.rs:386-396`.

**Detail:** Minor test organization nit. Splitting helps when a future regression breaks only one shape.

**Recommendation:** Split `rows_of_scalar_arg_is_value_error` into `rows_of_number_scalar_returns_value_error` and `rows_of_text_scalar_returns_value_error`. Same for COLUMN/ROW.

**Severity rationale:** LOW — test hygiene.

---

### LOW-S2-O-2 — Unit test naming inconsistency: `row_of_cell_a1_returns_1` vs `rows_of_range_a1_a5_returns_5` (no `range_` infix) vs `rows_of_a1_b3_returns_3` (no infix). Three different naming styles in the same module.

**Where:** `crates/ql-functions/src/reference_fns.rs:176-345`.

**Detail:** Naming patterns observed:

- ROW: `row_of_cell_X_returns_Y`, `row_of_range_X_returns_Y`, `row_zero_arg_X`.
- ROWS: `rows_of_range_X_returns_Y` (sometimes), `rows_of_a1_b3_returns_3` (sometimes — drops "range_"), `rows_of_whole_column_returns_max_row_plus_1`.
- COLUMN: mirrors ROW.
- COLUMNS: mirrors ROWS.

The cross-fn pattern split makes the test names readable in isolation but inconsistent in aggregate. A future contributor adding a test will likely match the nearest neighbor, perpetuating the inconsistency.

**Recommendation:** Adopt one convention. Most readable: `{fn_lower}_{input_shape}_{returns_value}`. E.g., `row_of_cell_a1_returns_1`, `rows_of_range_a1_a5_returns_5`, `rows_of_array_2x3_returns_2`. Two-pass cleanup at Step 6 polish.

**Severity rationale:** LOW — style.

---

### LOW-S2-O-3 — `f64::from(range.end_row - range.start_row + 1)` in ROWS impl performs u32 arithmetic before the f64 cast. For Range::new-normalized inputs this is always safe (end >= start, max difference < u32::MAX). For non-normalized direct construction (programmatic, bypassing Range::new), `end < start` could underflow. Defensive coding could use f64-space subtraction.

**Where:** `crates/ql-functions/src/reference_fns.rs:103,118`.

```rust
[RefArg::Range { range, .. }] => {
    // Inclusive count: end_row - start_row + 1. WholeColumn binds
    // to start_row=0, end_row=MAX_ROW=1_048_575 → 1_048_576.
    Value::number(f64::from(range.end_row - range.start_row + 1))
}
```

**Detail:** `Range::new` normalizes so `end >= start` (verified at `crates/ql-types/src/address.rs:73-81`). All shipped Range builders go through `Range::new` (binder at plan.rs:1666 / 1670, programmatic test fixtures). So in v1 the underflow path isn't reachable.

But: the impl trusts the normalization invariant without an assertion. A future contributor constructing a Range directly via `Range { sheet, start_row, start_col, end_row, end_col }` (the struct is `pub`) could produce an un-normalized Range. Then `range.end_row - range.start_row` underflows (u32 wrapping) and `+ 1` makes it `0`, giving a wrong-but-non-erroring result.

A defensive variant:

```rust
Value::number((f64::from(range.end_row) - f64::from(range.start_row)) + 1.0)
```

Same semantics for normalized inputs; surfaces NaN or negative numbers for un-normalized inputs (which would then be ill-formed values for downstream consumers, but at least visible).

Alternatively, add a `debug_assert!(range.end_row >= range.start_row, "Range not normalized")` to ROWS/COLUMNS impls or to Range itself.

**Recommendation:** Either (a) the f64-space arithmetic above for the four arms; OR (b) an `assert!` in Range::new's call sites OR a `debug_assert!` in ROWS/COLUMNS impls. Defensive coding for an architecturally-impossible-but-rust-unenforceable case.

**Severity rationale:** LOW — defensive; no reachable failure in v1.

---

### LOW-S2-O-4 — `is_address_only_reference_fn` and `is_reference_aware_function` are both `pub(crate)` matchers in different modules; their cross-tier consistency invariant ("every address-only name is also reference-aware") isn't pin-checked anywhere.

**Where:** `crates/ql-exec/src/calcgraph_session.rs:201-203` AND `crates/ql-exec/src/plan.rs:501-506`.

**Detail:** The two matchers list different subsets:

- `is_reference_aware_function`: ROW / COLUMN / ROWS / COLUMNS / ISREF / ISFORMULA / FORMULATEXT (all 7).
- `is_address_only_reference_fn`: ROW / COLUMN / ROWS / COLUMNS / ISREF (5; ISFORMULA / FORMULATEXT keep value-deps).

The invariant: every address-only name should also be reference-aware. (The converse is false — ISFORMULA / FORMULATEXT are reference-aware but not address-only.)

If a future contributor adds a 6th address-only name (`ROWNUMBER`?) to `is_address_only_reference_fn` but forgets to add it to `is_reference_aware_function`, the dep walker would dep-suppress for a name the binder doesn't treat as reference-aware. The dispatcher would then fall through to "unknown function" → `#NAME?`, but the dep-suppress would have happened anyway (returning empty deps).

No test pin-checks this invariant. The Step 1.1 `dep_suppressed_reference_fns_match_design` test (calcgraph_session.rs:1711-1734) checks the matcher against the design's hardcoded list but doesn't cross-check against `is_reference_aware_function`.

**Recommendation:** Extend `dep_suppressed_reference_fns_match_design` with a cross-tier loop:

```rust
// Cross-tier invariant: every address-only name must also be reference-aware.
// (The converse is false — ISFORMULA / FORMULATEXT are ref-aware but not
// address-only — so the loop is one-directional.)
for name in &["ROW", "COLUMN", "ROWS", "COLUMNS", "ISREF"] {
    assert!(
        crate::plan::is_reference_aware_function(name),
        "{name:?} is in is_address_only_reference_fn but \
         is_reference_aware_function returns false — drift!"
    );
}
```

`is_reference_aware_function` is `pub(crate)` so the test can call it (calcgraph_session.rs is in the same crate ql-exec).

**Severity rationale:** LOW — drift hazard for unreleased future fns; not a Step 2 defect.

---

### LOW-S2-O-5 — `register_reference_aware`'s doc-comment was updated in Step 1.1 (S1-LOW-1 closure) but still says "the previous doc comment referenced a `contract_of(name)` helper that doesn't exist; corrected here." This is a meta-comment about the past, not load-bearing for current readers; clutters the doc.

**Where:** `crates/ql-functions/src/registry.rs:255-256`.

**Detail:** Step 1.1 closure left the audit-trail in the doc-comment. Step 2 didn't clean it up. Future readers don't need the audit-history; they need the current API contract.

**Recommendation:** Remove the "Step 1.1 closure (S1-LOW-1)..." sentence. Move audit-trail breadcrumbs to the commit message or audit log instead.

**Severity rationale:** LOW — doc cleanup.

---

### LOW-S2-O-6 — The 4 EXPLICITLY_DEFERRED entries (lines 576-603 in coverage.rs) carry near-identical reason strings ("reference-aware fn (W5-RT-2) — covered by reference_fns unit tests + ql-exec e2e tests; scalar arg-coverage matrix N/A"). The first entry's reason is slightly longer ("...for reference-tier ABI"); the others omit that suffix. Minor inconsistency in repetition.

**Where:** `crates/ql-functions/tests/coverage.rs:582-603`.

**Detail:** ROW says "scalar arg-coverage matrix N/A for reference-tier ABI"; COLUMN/ROWS/COLUMNS say "scalar arg-coverage matrix N/A" (no suffix). All four mean the same thing; the suffix repetition is just verbosity inconsistency.

**Recommendation:** Either factor out a shared `const REFERENCE_TIER_DEFERRAL_REASON: &str = "..."` or make all four entries identical. Five-line diff.

**Severity rationale:** LOW — DRY nit.

---

### LOW-S2-O-7 — The Excel-canonical anchor table at design § 7 line 681-688 includes ISFORMULA and FORMULATEXT (rows for "A1 = `=1+2`" → TRUE / "=1+2"). These rows have not been verified vs the impl since the impls don't exist yet (Step 3 / 4). The table is informational but unverifiable until Step 3 / 4. Step 2 audit is the moment to note this.

**Where:** `docs/architecture/2026-05-17-reference-tier-design.md:687-688`.

**Detail:** Tracking-only. Step 2 hasn't shipped ISFORMULA / FORMULATEXT, so these rows aren't testable. The design's table presents them as anchor values; Step 3 / 4 should cross-check against an actual workbook setup.

**Recommendation:** No Step 2 action. Track for Step 3 / 4 audit prompts.

**Severity rationale:** LOW — tracking.

---

### LOW-S2-O-8 — The cell-boundary scalar-context test `row_in_scalar_context_with_range_returns_top_left` (e2e line 259-263) is the ONLY test verifying the Excel pre-365 implicit-intersection semantics (`=ROW(A1:A5)+0 → 1`). No analog for COLUMN, ROWS, COLUMNS.

**Where:** `crates/ql-exec/tests/reference_fns_e2e.rs:259-263`.

**Detail:** The design § 7 line 705 lists "Implicit-intersection | =@ROW(A1:A10)" — the `@` form is the modern Excel-365 syntax for forcing implicit-intersection; the pre-365 form is automatic for scalar contexts (e.g., `=ROW(A1:A5)+0` evaluates the inner ROW in scalar context). The test exists for ROW; no test for COLUMN, ROWS (would always equal range row-count regardless of context — but still), COLUMNS.

**Recommendation:** Add `column_in_scalar_context_with_range_returns_top_left` mirroring the ROW test:

```rust
#[test]
fn column_in_scalar_context_with_range_returns_top_left() {
    assert_eq!(eval_with_map("COLUMN(A1:E1)+0"), Value::number(1.0));
}
```

For ROWS/COLUMNS, the test would always pass (the per-fn doesn't change behavior by context) but is still useful as a sanity baseline.

**Severity rationale:** LOW — symmetry coverage.

---

### LOW-S2-O-9 — `rows_of_array_literal_returns_first_dim` and `columns_of_array_literal_returns_second_dim` (lines 357-374, 444-461) duplicate the 2×3 ArrayValue construction. Helper would reduce ~16 lines of repeated `vec![Value::number(1.0), ...]` to one line.

**Where:** `crates/ql-functions/src/reference_fns.rs:357-374,444-461`.

**Recommendation:** Add a helper:

```rust
fn av_2x3() -> ArrayValue {
    ArrayValue::new(2, 3, (1..=6).map(|n| Value::number(n as f64)).collect()).unwrap()
}
```

**Severity rationale:** LOW — DRY.

---

### LOW-S2-O-10 — The defensive shape arms in `row` and `rows` (`RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value)` at lines 62, 81, 108, 122) are unreachable for the Eager contract but tested anyway (`row_with_shape_arg_returns_value_error` line 494-503). The test serves as defensive pin but the impl doesn't document WHY `Shape` is in the match arm.

**Where:** `crates/ql-functions/src/reference_fns.rs:59-63,80-82,108,122`.

**Detail:** Per design, Eager contract never produces `RefArg::Shape(_)` — only LazyShape contract does. ROW/COLUMN/ROWS/COLUMNS use Eager. So the `RefArg::Shape(_)` match arm is structurally unreachable at runtime. The defensive arm is there for **exhaustiveness** — `match args[0]` over a closed enum.

The test `row_with_shape_arg_returns_value_error` (line 494-503) DOES exercise the arm — but only because the test constructs a `RefArg::Shape(...)` manually, bypassing the dispatcher. This is the "future-proofing for if Eager fns ever take Shape args" test, NOT the "this case is reachable through the pipeline" test.

**Recommendation:** Add a code comment near the arm:

```rust
// Defensive: dispatcher only produces RefArg::Shape under LazyShape contract.
// ROW uses Eager, so this arm is unreachable at runtime. The defensive
// arm + `row_with_shape_arg_returns_value_error` test pin the
// pattern-match in case a future tier change makes it reachable.
RefArg::Scalar(_) | RefArg::Shape(_) => Value::Error(ErrorValue::Value),
```

Same for the other 3 fns.

**Severity rationale:** LOW — doc clarity.

---

### LOW-S2-O-11 — Asymmetric arity coverage across the 4 fns: ROW has `row_of_arity_zero_with_extra_args_returns_na`; COLUMN has no analog. ROWS / COLUMNS have `rows_arity_errors` / `columns_arity_errors` (each tests both 0-arg and 2-arg). The 4 fns should have parallel arity-coverage.

**Where:** `crates/ql-functions/src/reference_fns.rs:248-254` (ROW only), absent from COLUMN section (lines 256-326).

**Detail:** Cross-fn coverage matrix:

| Fn | 0-arg arity test | >1-arg arity test |
|----|------------------|--------------------|
| ROW | (no-args case → calling-cell or #REF! tested via line 198-209) | `row_of_arity_zero_with_extra_args_returns_na` (line 248) |
| COLUMN | (no-args case tested line 286-297) | **MISSING** |
| ROWS | `rows_arity_errors` (line 399) | same test |
| COLUMNS | `columns_arity_errors` (line 482) | same test |

COLUMN doesn't have an analog of `row_of_arity_zero_with_extra_args_returns_na`. Either intentional or oversight.

**Recommendation:** Add `column_of_arity_two_returns_na` (using cell_ref args) for symmetry.

**Severity rationale:** LOW — coverage symmetry.

---

### LOW-S2-O-12 — `column_of_range_returns_top_left_col` test (lines 271-284) tests two ranges (`A1:B3` and `D2:F5`); the second case verifies the LibreOffice anchor mismatch but isn't separated. Splitting would clarify which is the LibreOffice anchor.

**Where:** `crates/ql-functions/src/reference_fns.rs:271-284`.

**Detail:** The test asserts two cases:
```rust
column(&[range_ref(0, 0, 0, 2, 1)], &ctx) == 1.0  // A1:B3 → 1
column(&[range_ref(0, 1, 3, 4, 5)], &ctx) == 4.0  // D2:F5 → 4
```

Neither is explicitly tagged as LibreOffice cross-check. Compare to `row_of_cell_b5_returns_5` which is explicitly tagged. For consistency, split + tag.

**Recommendation:** Optional — minor.

**Severity rationale:** LOW — naming.

---

## Cross-cutting observations (not separate findings)

### CC-S2-1 — `cargo test` not run in this audit

I did not have access to a working cargo binary in this audit environment (rustup toolchains were in `/mnt/mac/.rustup/` but `cargo` was not in PATH). Per the audit-discipline rule, I would normally re-verify the claimed "all gates green" by running `cargo test --workspace --all-targets`. Logging this as a process gap; the audit's findings are based on static analysis of the working tree.

### CC-S2-2 — Verified Range::new normalization

`crates/ql-types/src/address.rs:73-81`:

```rust
pub fn new(sheet: SheetId, row1: RowId, col1: ColId, row2: RowId, col2: ColId) -> Self {
    Self {
        sheet,
        start_row: row1.min(row2),
        start_col: col1.min(col2),
        end_row: row1.max(row2),
        end_col: col1.max(col2),
    }
}
```

`start_row <= end_row` always holds when Range::new is used. The `end_row - start_row + 1` arithmetic in ROWS/COLUMNS is safe under this invariant. See LOW-S2-O-3 for the direct-struct-construction edge case.

### CC-S2-3 — Verified `f64::from(u32)` lossless for MAX_ROW + 1

`MAX_ROW = 1_048_575 = 2^20 - 1`. `f64::from(1_048_576)` = `1_048_576.0` exactly (mantissa 52+1 bits handles up to 2^53 losslessly). The design's expected results (1_048_576 for ROWS(A:A), 16_384 for COLUMNS(1:1)) are bit-exact.

### CC-S2-4 — Verified `RefArg::Reference.value` is unused everywhere

`grep -rn "RefArg::Reference" crates/ql-functions/src/` confirms:
- `crates/ql-functions/src/reference_fns.rs:53,78,105,120,160` — all use `..` binding (value field ignored).
- `crates/ql-functions/src/reference_aware_fns.rs:56` — type definition.
- `crates/ql-functions/src/reference_aware_fns.rs:209` — single test construct, `_` binding.

No consumer reads `value` from `RefArg::Reference` in v1. See HIGH-S2-O-2 for the wasted-read concern.

### CC-S2-5 — Verified IronCalc semantics match impl (for the 4 in scope)

- IronCalc `fn_row` (`.references/ironcalc/base/src/functions/lookup_and_reference/mod.rs:608-619`): returns top-left row of reference. Our impl matches.
- IronCalc `fn_rows` (line 623-631): `(c.right.row - c.left.row + 1) as f64`. Our impl matches.
- IronCalc `fn_column` (line 636-648): top-left column. Match.
- IronCalc `fn_columns` (line 675-683): `(c.right.column - c.left.column + 1) as f64`. Match.

One subtle difference: IronCalc's `fn_row` returns `cell.row as f64` for zero-arg (where `cell` is the calling cell). Our impl returns `f64::from(addr.row) + 1.0`. IronCalc's CellReferenceIndex is **1-indexed at the call site**, so its `cell.row` is already Excel-style. Our `Address.row` is **0-indexed**, requiring the `+ 1`. The internal-representation difference is documented in design § 2.1; impl handles correctly.

### CC-S2-6 — `value` field dead-code is also true for the `RefArg::Reference` test fixture

Even the test fixture at `reference_aware_fns.rs:206-214`:

```rust
let _ = RefArg::Reference {
    address: Address::new(0, 0, 0),
    value: Value::number(1.0),
};
```

constructs the variant but doesn't exercise the `value` field. Confirms the field is never load-bearing.

### CC-S2-7 — `ROW(A:A)` at cell boundary

The cell-boundary guard fires for `ROW(A:A)` since `A:A` binds to `Range::new(sheet, 0, 0, MAX_ROW, 0)` which is multi-cell (start_row=0 != end_row=MAX_ROW). Result: `#CALC!`. **No test asserts this.** Per design § 1 this is intentional (spill defer).

Similarly `COLUMN(A:A)` at cell boundary: same range, same guard, returns `#CALC!` even though `COLUMN(A:A)` could plausibly return `1` (single-column reference, well-defined). The design's blanket "multi-cell → #CALC!" stance covers both; if a future tightening wants to allow COLUMN(A:A)=1 for the single-column case, the guard would need to know which dimension the fn cares about.

This isn't a finding (intentional per design) but worth noting that the guard's "multi-cell" definition is `start_row != end_row || start_col != end_col`, so it intercepts both meaningful-multi-cell and single-axis-multi-cell cases uniformly.

### CC-S2-8 — Test count math: +68 matches actual

Pre-Step 2: 3105. Post-Step 2: 3173. Delta: 68. Tests added: 35 unit (reference_fns.rs) + 32 e2e (reference_fns_e2e.rs) + 1 invariant (plan.rs step_2_reference_aware_names_registered_in_reference_tier) = 68. ✓ Note that the audit prompt stated "28 unit tests" — actual is 35.

### CC-S2-9 — Plan checklist completion

Per `.plans/_active.md:85-92`, the Phase 2 sub-bullets are:

| Item | Status |
|------|--------|
| Implement row/column/rows/columns per design § 5.6 | shipped |
| Register via register_reference_aware | shipped |
| Tests: 8+ per fn covering 8 categories | **PARTIAL** — see HIGH-S2-O-1 (named-range + cross-sheet missing) |
| Bump default_registry_has_expected_count 193→197 | shipped |
| EXPLICITLY_DEFERRED → registered transitions | shipped (4 entries; see MEDIUM-S2-O-7 for placement nit) |
| e2e dispatch tests per fn | shipped (32 tests; some categories missing per HIGH-S2-O-1) |
| Update excel-matrix.md | shipped (see MEDIUM-S2-O-4 for count drift) |
| Step 2.A audit | in-progress (this audit + parallel Codex) |

**Net checklist state:** 1 partial item (the "8+ tests per fn covering ..." line). All other items shipped. The partial item is HIGH-S2-O-1.

---

## Pattern signals captured

1. **Multi-category test coverage requirements can ship partially.** HIGH-S2-O-1: the plan listed 8 categories per fn; tests cover ~5-6 (named-range + cross-sheet completely absent). Pattern signal: when the plan enumerates a list, the test suite should structurally enumerate it back (one test file per category, or one test name per category). Without the structural enumeration, partial completion is invisible until audit.

2. **Materializer error mapping is asymmetric across plan arms.** HIGH-S2-O-2: the CellRef arm doesn't follow the `Value::Error → RefArg::Error` mapping that the fallthrough `other` arm does. Pattern signal: when multiple plan variants flow through a materializer, the error-mapping should be a per-arm invariant ("every arm that can produce Value::Error must convert to RefArg::Error before wrapping"). A single canonical helper `to_ref_arg_or_propagate_error(plan, value)` would express the invariant in one place.

3. **Doc-comments don't track Step transitions.** HIGH-S2-O-3 (Step 1's "v1 always returns false" doc), MEDIUM-S2-O-3 (Step 1.1's "only reachable when ISFORMULA / FORMULATEXT take a literal range"). Pattern signal: when stepwise development is sequenced, doc-comments that describe the current state need an "as of Step N" anchor OR they should describe the long-term contract, not the transient state.

4. **Plan checklist items written aspirationally don't ship-trigger.** Step 1's pre-flight items were checkbox-only and may or may not have been done (CC-1 in Step 1 audit). Step 2 inherits the same pattern. Pattern signal: each checklist item should either be a test-passing assertion ("8+ tests per fn covering named-range" → 4 named-range tests in the test file) OR explicitly noted as deferred with an SUMmary entry in `.plans/_active.md`.

5. **EXPLICITLY_DEFERRED vs EXPECTED_COVERED bucket-confusion.** MEDIUM-S2-O-7: 4 fns placed in DEFERRED because they're covered by a DIFFERENT test machinery, not because they're uncovered. Pattern signal: when a coverage taxonomy doesn't account for "covered elsewhere", the deferral bucket grows to include miscategorized entries.

---

## Recommendation for Step 2.A closure

Before Step 3 (ISREF + ISFORMULA implementation) ships, close (at minimum):

1. **HIGH-S2-O-1** — add named-range AND cross-sheet AND structured-ref tests for each of ROW/COLUMN/ROWS/COLUMNS. The structured-ref case is most important because the S1-HIGH-B Step 1.1 closure added dedicated code path that ships otherwise-untested.

2. **HIGH-S2-O-2** — at minimum, mirror the eager-error mapping in the CellRef arm so `RefArg::Reference { value: Error(_) }` is impossible. The wasted-read concern can be tracked separately as a follow-up; the error-propagation fix is the user-visible part. **Prefer dropping the `value` field entirely (combined with MEDIUM-S2-O-8) to close both gaps at once.**

3. **HIGH-S2-O-3** — update the doc-comment at plan.rs:496-500 to reference actual test names and reflect post-Step-2 registry state.

4. **MEDIUM-S2-O-2** — add at least one workbook-runtime end-to-end test for `=ROW()` zero-arg threaded through a real formula cell.

5. **MEDIUM-S2-O-5** — extend the Step 2 invariant test with the "not-yet-registered" sentinel loop for ISREF / ISFORMULA / FORMULATEXT.

The remaining MEDIUMs (S2-O-1, S2-O-3, S2-O-4, S2-O-6, S2-O-7, S2-O-8, S2-O-9) can be tracked as RT-2.1 / RT-2.2 / etc. follow-ups inside the Step 3 commit batch. The LOWs can go into a post-mini-phase polish wave.

The implementation overall is sound: the 4 fns implement the design's pseudo-code accurately, the cell-boundary guard handles ROW/COLUMN correctly, the LibreOffice cross-check values are bit-exact, the registry count math is correct, the e2e dispatch chain works for the tested categories. The audit findings are concentrated in **test coverage gaps** (HIGH-S2-O-1, MEDIUM-S2-O-2, LOW-S2-O-8), **architectural latent defects in the materializer that v1 doesn't reach but is one step away from** (HIGH-S2-O-2), and **doc / convention drift** (HIGH-S2-O-3, MEDIUM-S2-O-3, MEDIUM-S2-O-4, MEDIUM-S2-O-9, several LOWs).

---

## Counts

- HIGH: 3
- MEDIUM: 9
- LOW: 12
- **Total: 24**
