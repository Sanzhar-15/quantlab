# Phase 4.4 design-doc review — Codex brief

You are reviewing the W5-63 Phase 4.4 architectural decision: **Coercion + Error Semantics Matrix**. This is a design doc, NOT code. No implementation has happened — your review shapes the implementation that follows.

**Be adversarial.** The W5-49 pattern caught real issues at the design phase. The W5-52, W5-60, W5-62 mega-audits caught real correctness bugs in shipped code. This design needs the same scrutiny BEFORE we land 100+ test assertions and a helper migration.

## Branch + state

- Branch: `feat/quantbook-engine`
- HEAD: `904f230e2c5` (W5-62 polish mega-audit closure)
- This W5-63 commit (when made) will be doc-only.
- 1297 workspace tests; all 7 gates green.

## Required reading (cover-to-cover, in this order)

```
docs/architecture/2026-05-13-coercion-matrix.md   # the design doc UNDER REVIEW
crates/ql-types/src/coercion.rs                    # 754 lines + 47 unit tests; the existing centralized module
crates/ql-types/src/error.rs                       # ErrorValue enum + ALL[] table
crates/ql-functions/src/scalar_fns.rs              # private helpers: coerce_numeric (line 35), coerce_text (~1349), coerce_int_arg (~1501)
crates/ql-functions/src/range_fns.rs               # private coerce_numeric (line 50; DUPLICATE of scalar_fns) + Predicate::matches
crates/ql-functions/src/scalar_fns.rs:1361        # format_number_for_text (the integer-rendering rule)
crates/ql-functions/src/range_fns.rs:~1411         # value_to_concat_text (W5-61 CONCAT-specific text)
crates/ql-exec/src/scalar.rs                       # eval_scalar_with_cache — where coercion meets dispatch
docs/compat/excel-matrix.md                        # per-function coverage status
docs/known-gaps.md                                 # GAP-F-* entries; especially GAP-F-02 (lazy IF/IFERROR)
docs/audits/2026-05-13-engine-session-final-handoff.md  # current handoff
```

## Specific review concerns

### CONCERN-A: Type-pair matrix completeness (§3.1)

The 7×5 matrix table claims:
- Blank → 0/false/""
- Number(NaN/Inf) → #NUM!
- Text strict → #VALUE!; lenient → parse-or-#VALUE!
- Error always propagates

Is anything WRONG vs Excel canon? Specifically:

1. NaN/Inf rendering by `Display` for `Value::Number` — the doc flags it as a latent gap. Is the gap real, or does the Value constructor prevent NaN/Inf from existing? Check `ql-types/src/value.rs` for `Value::number(n)` and any other path that could write a NaN.
2. Text "TRUE"/"FALSE" coercion to bool — the matrix says lenient numeric returns #VALUE! for this. But the `to_logical` test handles it. Is there an inconsistency in routing: would `=1 + "TRUE"` coerce TRUE to 1 via lenient numeric, or should it #VALUE!? What does Excel do?
3. Excel-canon edge: empty string `""` in arithmetic context. Excel: `=""+1` → #VALUE!. Our `to_number_lenient("")` returns `Err(#VALUE!)` (via parse_number_invariant returning None). Confirmed.
4. Excel-canon: `Value::Blank` in numeric context coerces to 0; in logical context to FALSE; in text context to "". Confirmed in our coercion module. But Excel ALSO treats `Value::Blank` differently in COUNT vs COUNTA (COUNT skips, COUNTA counts). The matrix doesn't capture this — should it?

### CONCERN-B: Error-precedence matrix correctness (§3.3)

The matrix asserts:
- `=SUM(A1, B1)` with both errored → first arg wins (A1)
- `=A1+B1` with A1=#DIV/0! → #DIV/0! propagates
- `=IF(#REF!, 1, 2)` → #REF! short-circuits
- `=IFERROR(#REF!, 0)` → 0
- `=ISERROR(#REF!)` → TRUE

Verify each:
1. **Argument evaluation order**: does the binder/dispatcher actually evaluate left-to-right? If `ExprPlan::Function { args }` is processed via `args.iter().map(...)`, that's left-to-right. Verify.
2. **`=A1+B1` with both errors**: does the operator code propagate the LEFT error first (matching Excel) or the RIGHT? Check `crates/ql-exec/src/scalar.rs` arithmetic operator path.
3. **`=IFERROR(#REF!, 0)` lazy eval**: GAP-F-02 (FN4-03) says IFERROR is currently eager. Does that mean IFERROR(#REF!, 0) currently returns #REF! (eager arg eval) instead of 0? If so, the matrix's claim that IFERROR catches is ASPIRATIONAL, not current. Important to distinguish.
4. **`=ISERROR` etc.**: how does the binder route these? If ISERROR is registered as scalar (not lazy), does it receive Value::Error directly (since args are pre-evaluated), and just check the type? Confirm.

### CONCERN-C: Per-function override matrix (§3.4) — missing entries?

The matrix lists IF, IFERROR, ISERROR/ISNA/ISERR, COUNTIF, MATCH, VLOOKUP. What about:

1. **AVERAGE / AVG with all-blank range** → #DIV/0!? (Excel canon: yes.)
2. **MIN/MAX with all-text range** → 0 (Excel canon) or #VALUE! (Quantbook strict)?
3. **TYPE() function** — returns 1/2/4/8/16/64 for type identification. Listed? Not in the doc. Should be.
4. **NA() function** — returns #N/A always. Same category.
5. **ERROR.TYPE() function** — Excel-canon. Not in our registry.
6. **CHOOSE with error in args**: which error wins?
7. **RANK with #N/A**: per Excel, #N/A in the ref array propagates? Or is treated as "not in array"?

Should the override matrix be exhaustive, or just call out the non-obvious ones?

### CONCERN-D: Migration plan safety (§4.2)

Sub-phase 4.4.A migrates 4 private helpers to `ql-types::coercion`. Risks:

1. **`format_number_for_text`**: the integer-rendering-without-trailing-.0 rule is a UI choice, not strictly Excel-spec. Promoting it to `ql-types::coercion` makes it the canonical rule for ALL text coercion. Is that what we want? Or should the integer rule live in a separate `ql-functions::text_format` module?
2. **`coerce_text` vs `to_text_for_formula`**: the doc says they differ in integer-rendering. But `to_text_for_formula` calls `format!("{v}")` which uses `Value`'s Display impl. What does Display do for Number? Check `crates/ql-types/src/value.rs::Display for Value`.
3. **`NumericArg` enum vs `Result<Option<f64>, ErrorValue>`**: the doc proposes promoting `NumericArg` to public API. But `Result<Option<f64>, ErrorValue>` is the more standard Rust shape (Some=Number, None=Skip, Err=Error). Worth that signature instead?

### CONCERN-E: Test surface (§4.2 sub-phase B)

The doc promises ~70 type-pair tests + end-to-end error precedence tests + per-fn override tests. Worries:

1. **Over-pinning**: if a test asserts "TEXT in numeric arg → #VALUE!" and we later decide to align with Excel's "skip text in SUM range" canon, every test needs updating. Mitigation: tests should be tagged by Excel-canon vs Quantbook-divergence.
2. **Coverage report**: should there be a script that walks `default_registry()` and verifies every fn has at least one matrix entry? Otherwise new fns slip through without coercion-test coverage.
3. **Test placement**: `crates/ql-types/tests/` (for type-pair) vs `crates/ql-functions/tests/` (for per-fn-context) vs `crates/ql-exec/tests/` (for error-precedence end-to-end). Three test files in three crates — coherent or fragmented?

### CONCERN-F: Non-goals / deferrals (§4.3)

- Locale-aware coercion deferred to Phase 4.5 — fine.
- Date / time coercion deferred — fine.
- "Excel's ignore-errors-in-range for SUM" stays as Quantbook divergence — UNDER-DEFENDED. The audit lineage has flagged this as a real Excel canon item. Worth re-litigating now, before we pin tests?

### CONCERN-G: Effort estimate (§5)

- 4.4.A migration: 1 session — is that realistic given the helper-call-site count? Hint: `grep` for usage of the private helpers across the workspace; if it's >50 sites, 1 session is tight.
- 4.4.B 100+ tests: 1 session — yes, mechanical.
- 4.4.C doc + cross-link sweep: 0.5 session — fine.

What's NOT estimated is the **mega-audit cycle**. Per the audit-protocol, every phase needs a Codex+Sonnet pass before closure. That's another 0.5-1 session.

### CONCERN-H: Stop conditions (§6) — are they real?

- "Migration surfaces a behavior divergence we can't reconcile in <0.5 session" — has this happened before? Concrete example would help.
- "Matrix test file exceeds ~500 lines" — is 500 the right ceiling, or arbitrary?

### CONCERN-I: Doc cross-links (§4.4)

The W5-63 ship is described as doc-only. Cross-link additions:
- `MASTER-PLAN.md` Phase 4.4 entry
- `known-gaps.md` GAP-F-02 reference
- handoff doc § Next phase

Is there anywhere else? `excel-matrix.md` for per-function rows that reference coercion?

### CONCERN-J: Architectural alignment — does the matrix belong in `ql-types`?

`ql-types` is the leaf crate (no deps on `ql-functions` etc.). Promoting function-arg helpers (`coerce_text`, `coerce_int_arg`, `coerce_numeric`-with-Skip) there might:

- BLUR the layer boundary — `ql-types` becomes function-aware.
- Or might be RIGHT — coercion IS a Value-level concern.

The current centralized `coercion.rs` IS in `ql-types`, so the migration extends that boundary. Is that the right architecture, or should there be a new `ql-coercion` crate above `ql-types` to house function-arg patterns?

### CONCERN-K: What's missing from the doc entirely?

Things the doc doesn't address that maybe should:

- **Array context coercion** (Phase 4.7) — does the matrix design accommodate the future shift to array-formula args?
- **Cross-sheet coercion** (Phase 4.6) — does referring to a Bool-typed cell on Sheet2 go through the same coercion path?
- **SQL / Python boundary** (Phase 6) — how does AI() result coerce into Value? How does Python UDF output map back?
- **CRDT replay coercion** (Phase 5) — does replaying an op log require deterministic coercion? Are there nondeterminism risks?

These can be deferred, but the doc should at least name them.

## What to report

```
# Phase 4.4 design doc review — verdict (one paragraph)

## NEW HIGH (design flaws that block implementation)
## NEW MEDIUM (improvements; rework recommended pre-implementation)
## NEW LOW (doc nits, naming, suggestions)

## Per-concern verdict (A–K)
A: ...
B: ...
...

## Recommended changes to the design doc (numbered, actionable)
```

Length budget: 2000-5000 words. Cite file paths + line numbers.

Save your full output where the dispatch script directs.
