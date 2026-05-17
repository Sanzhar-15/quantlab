# Phase 4.10 V1-260 Megaudit — Integration Pass (self)

**Auditor:** Implementing Opus 4.7 (this conversation's primary agent).
**Date:** 2026-05-17.
**Scope:** Whole-phase integration audit complementing parallel Codex + separate-Opus megaudits.
**HEAD:** `5d117724f27` on `feat/quantbook-engine`.

This pass focuses on cross-batch integration issues only visible at the whole-arc level — not numerical correctness of individual fns (Codex + Opus agents cover that with compiled probes).

## Summary

**4 HIGH / 1 MEDIUM / 1 LOW. The per-batch audits had blind spots.**

## HIGH

### HIGH-001 — 28 Phase 4.10 range-aware fns NOT admitted to `is_aggregate_function`

**Subject:** Cross-cutting binder admission gap. Same root cause as W5-D-12 Codex HIGH-001, but the closure only patched SUBTOTAL; the systemic issue affects 27 OTHER range-aware fns registered through W5-D-1..W5-D-11.

**Where:**
- `crates/ql-exec/src/plan.rs:421-488` (`is_aggregate_function`).
- `crates/ql-functions/src/registry.rs:813-843` (range-aware registrations).
- Empirically confirmed by the Opus megaudit probe at `crates/ql-exec/tests/zzz_megaudit_probe.rs::megaudit_admission_gap_audit` — 18 named-range bind attempts all FAILED with `NamedRangeInScalarContext`.

**Detail:** The Codex W5-D-12 HIGH-001 audit caught that SUBTOTAL wasn't in `is_aggregate_function`. The closure added it. But the SAME bug applies to every range-aware fn that takes a range arg and isn't already admitted. Concretely, set-difference between registered range-aware fns and `is_aggregate_function` admissions:

```
CORREL, COUNTBLANK, COVARIANCE.P, COVARIANCE.S, INTERCEPT, IRR,
MAXIFS, MINIFS, MIRR, NPV, PEARSON, PERCENTILE, PERCENTILE.EXC,
PERCENTILE.INC, QUARTILE, QUARTILE.EXC, QUARTILE.INC, RSQ, SLOPE,
STEYX, SUMX2MY2, SUMX2PY2, SUMXMY2, TEXTJOIN, XIRR, XLOOKUP,
XMATCH, XNPV
```

28 fns. Each would surface `NamedRangeInScalarContext` when used with a named range argument (e.g., `=PERCENTILE.INC(SalesData, 0.5)` where `SalesData` is a named range).

The per-batch audits missed this because the unit tests use `FnArg::Range` directly (bypassing the binder) and the e2e tests either use scalar args (avoiding the bind issue) or registry-only smoke checks.

**Recommendation:** Add all 28 fns to `is_aggregate_function`. Extend the `is_aggregate_function_lists_only_registered_aggregates` invariant test to include them. Consider deeper fix: replace the hardcoded matcher with per-function metadata in the registry (the W5-58 follow-up that's been deferred multiple times).

**Severity rationale:** Real bind-time correctness bug. 28 user-facing fns silently broken for named-range usage. Same severity as the W5-D-12 closure that warranted HIGH-001 at that batch level.

### HIGH-002 — 3 registered fns UNREACHABLE from source text (lex bug)

**Subject:** `ATAN2`, `DAYS360`, `SUMXMY2` cannot be invoked from formula source. Lexer errors with `ColumnTooLarge` before parser can disambiguate function-call vs cell-ref.

**Where:**
- `crates/ql-formula-syntax/src/lexer.rs:835-844` (`classify_letter_prefix_simple`).
- `crates/ql-formula-syntax/src/lexer.rs:619-670` (digit-handling block).
- Empirically confirmed: `lex("SUMXMY2(1,2)")` returns `Err(ColumnTooLarge("SUMXMY"))`.

**Detail:** For function names matching the pattern `letters{>3} + digit{1+}` WITHOUT trailing letters, the lexer:
1. Reads letters into the `letters` buffer.
2. Sees digits, enters digit-handling block (line 620).
3. The W5-D-9 letters-digits-letters extension (line 651) requires `chars.peek().is_some_and(|c| c.is_ascii_alphabetic())` — i.e., another letter after the digits.
4. Without trailing letter, falls through to the CellRef path (line 672).
5. `column_letters_to_index("SUMXMY")` errors because 6 letters > 3 max column letters.

The W5-D-9.1 LOG10 regression test acknowledges this for ATAN2 with the comment "ATAN2 has a 4-letter prefix which exceeds the column-letter limit, so it can't lex standalone as a CellRef regardless; it only works as `ATAN2(...)` via the parser's fn-name override" — but **this is incorrect**: the parser never sees the tokens because the lexer errors first. The comment encodes a misunderstanding of the lex/parse interaction.

Affected fns identified via `grep -E "^[A-Z]{4,}[0-9]+$"` against the registry:
- **ATAN2** (W5-51, Phase 4.3): registered, unit-tested via direct call, matrix says ✅ 13 tests.
- **DAYS360** (W5-75 V2 wave, Phase 4.5): registered, has coverage entry — but matrix INCORRECTLY says ❌ (see MEDIUM-001).
- **SUMXMY2** (W5-166, Phase 4.10.D): registered, has unit tests via direct call, matrix says ✅ in combo row.

For all three: typing `=ATAN2(1, 0)` / `=DAYS360(A1, B1)` / `=SUMXMY2(X, Y)` into the formula bar would lex-error.

**Recommendation:** Extend the digit-handling block in `lex_ident_or_ref` to fall back to Ident when letters.len() > 3 (clearly cannot be a column ref). Add direct lexer unit tests for each affected fn (pin `lex("ATAN2(1,1)")` returns Ident tokens, NOT CellRef + parser-disambiguates).

**Severity rationale:** Three user-facing fns completely unreachable from formula source. Matrix lies (marks 2 of them ✅). Real correctness/completeness gap. Equivalent to fns not being implemented at all from the user's perspective.

### HIGH-004 — SYSTEMIC matrix-registry drift across Date/Time + Lookup categories: 21 fns registered but matrix marks ❌

**Subject:** Beyond DAYS360 (HIGH-003), 21 registered fns are marked ❌ in the matrix. This is a category-wide breakdown, not isolated drift.

**Where:** `docs/compat/excel-matrix.md` — primarily the Date/Time and Lookup sections.

**Detail:** Cross-checking the registry (315 register calls, 271 unique symbols, 260 registry entries by `r.len()`) against matrix ❌ rows surfaces 21 mismatches:

```
DATE TIME DATEVALUE TIMEVALUE
YEAR MONTH DAY HOUR MINUTE SECOND
WEEKDAY WEEKNUM ISOWEEKNUM
DAYS360 NETWORKDAYS WORKDAY
EDATE EOMONTH DATEDIF YEARFRAC
TRANSPOSE
```

Each is a registered fn (verified by `grep -E 'r\.register' crates/ql-functions/src/registry.rs`) but the matrix says it's NOT yet shipped. This means:
1. The 80% matrix coverage figure in the master plan ship marker is **understated** — actual implemented count is significantly higher than 210 ✅ rows.
2. Users reading the matrix would believe these 21 fns are unavailable and not even try them.
3. The matrix is no longer a reliable source-of-truth for what's shipped.

The Phase 4.10 acceptance criterion FN4-260-02 ("every implemented function has matrix-backed tests") is — strictly interpreted — VIOLATED: 21 fns lack a ✅ row tying them to their test count + parity notes.

**Recommendation:**
1. Audit every ❌ row in the matrix against the registry. Update each registered fn's row to ✅ / ⚠️ with actual test counts and Phase tag.
2. Re-run `scripts/report-compat-coverage.sh` post-fix; expect coverage to rise from 80% to ~87-88%.
3. Update the master plan ship marker's coverage figure.
4. Add an invariant test that asserts "every registered fn has a matrix entry with status ≠ ❌" — would have caught this immediately.

**Severity rationale:** Massive doc-correctness failure that affects the user contract. The matrix is the documented compatibility surface; 21 stale entries means 21 functional regressions in documentation. Equivalent severity to HIGH-003 but scaled up — same class of bug, much larger blast radius.

### HIGH-003 — Matrix-registry drift: DAYS360 marked ❌ but registered

**Subject:** Matrix entry says `DAYS / DAYS360 / NETWORKDAYS / NETWORKDAYS.INTL | ❌ | 0` but DAYS360 is registered in `registry.rs:694` (W5-75 V2 wave) with a coverage entry at `coverage.rs:638`.

**Where:**
- `docs/compat/excel-matrix.md:234` (matrix entry).
- `crates/ql-functions/src/registry.rs:694` (registration).
- `crates/ql-functions/tests/coverage.rs:638` (coverage entry).

**Detail:** The matrix is the user-facing contract for what V1 ships. A ❌ row means "not yet implemented." But DAYS360 IS implemented + registered + coverage-pinned. Either the matrix is wrong (most likely), or the registration is wrong, or there's a partial implementation that should be ⚠️.

This is the kind of drift the per-batch audits couldn't catch because they don't audit historical batches. Spotting it required walking the full registry and cross-checking.

**Recommendation:** Audit every ❌ row in the matrix against the actual registry. Update DAYS360 + any others to ✅ / ⚠️ with the actual test count. Also verify NETWORKDAYS, NETWORKDAYS.INTL, DAYS in the same row.

**Severity rationale:** User-facing documentation contract violation. A user reading the matrix would assume DAYS360 isn't available; they wouldn't try to use it. Conversely, partial-ship documentation prevents users from filing bug reports about missing fns that are actually present.

## MEDIUM

### MEDIUM-001 — `parse_places_arg` / `collect_dec_input` NaN guard is implicit

**Subject:** W5-D-9 base-conversion helpers convert f64 → i64 via `n.trunc() as i64` without explicit `is_nan()` guard. The NaN safety relies on the upstream `to_number_strict` rejecting NaN via `sanitize_f64`.

**Where:**
- `crates/ql-functions/src/scalar_fns.rs:3476-3488` (`parse_places_arg`).
- `crates/ql-functions/src/scalar_fns.rs:3493-3500` (`collect_dec_input`).

**Detail:** The current path:
1. `to_number_strict(arg)` calls `sanitize_f64` which rejects NaN → returns `Err(ErrorValue::Num)`.
2. NaN never reaches the `n.trunc() as i64` cast.

So today, NaN input correctly produces `#NUM!`. BUT:
- The guard is implicit (depends on an upstream contract).
- A future refactor that swaps `to_number_strict` for a different coercion (e.g., `to_number_lenient`, which DOES allow NaN through parsing edge cases) would silently leak NaN to the integer cast, where it saturates to 0 in safe-cast Rust ≥1.45.
- For `collect_dec_input(arg, lo=-512, hi=511)`: NaN→0 IS in [-512, 511] → silent DEC2BIN(NaN) = "0" instead of #NUM!.
- For `parse_places_arg`: NaN→0 NOT in [1, 10] → returns Err(Num). OK by accident.

The W5-D-11.1 / W5-D-12.1 closures added explicit `is_nan()` guards in `extract_quartile_q` and SUBTOTAL function_num extraction. The Phase 4.10 should apply the SAME defensive pattern consistently — add `is_nan()` guards in the W5-D-9 helpers for consistency and forward-defense.

**Recommendation:** Add explicit `is_nan()` guards to `parse_places_arg` and `collect_dec_input` returning `Err(ErrorValue::Num)`. Pin via unit tests with `f64::NAN` inputs.

**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.

## LOW

### LOW-001 — Master plan ship marker says "12 transcripts" but 24 audit files exist

**Subject:** Phase 4.10 ship marker in `docs/MASTER-PLAN.md` claims "Full audit trail in `docs/audits/2026-05-17-w5-d-*.md` (12 transcripts)" — but `ls docs/audits/2026-05-17-w5-d-*.md | wc -l` returns 24 (1 Codex + 1 Opus per batch × 12 batches).

**Where:** `docs/MASTER-PLAN.md` — the W5-D-12.1 ship marker paragraph.

**Detail:** Ambiguous wording. "12 transcripts" could mean "12 transcript-pairs" (correct count of audit cycles) or "12 transcript files" (wrong; actually 24). The phrasing reads as the latter.

The same paragraph also says "12 ship+audit commit pairs" which is correct (each batch has 1 impl commit + 1 audit-transcript commit = 12 pairs).

**Recommendation:** Clarify to "24 audit transcripts across 12 batch cycles" or "12 audit-pair cycles (24 transcripts: 1 Codex + 1 Opus per batch)".

**Severity rationale:** Documentation precision. No functional impact. Worth fixing for honesty + future-audit clarity.

## Findings from Codex megaudit (incorporated by reference)

After Codex megaudit completed at `docs/audits/2026-05-17-phase-4-10-megaudit-codex.md`:

- **Codex HIGH-001 (28 fns missing from is_aggregate_function)** = **my HIGH-001**. Independent confirmation.
- **Codex HIGH-002 (SUMXMY2 + ATAN2 unreachable from source)** ≈ **my HIGH-002**. Codex caught the same two; I additionally identified DAYS360 via the same letters>3+digit pattern.
- **Codex HIGH-003 (NEW — GAMMA.INV STILL panics on subnormal scale)**: critical finding I did NOT catch. The W5-D-5.1 closure rejected non-finite rate, but `f64::MIN_POSITIVE / 2.0` (subnormal scale) yields a finite-but-enormous rate (~8.98e307) that passes the `is_finite()` guard and then crashes statrs's `inverse_cdf` with `Result::unwrap() on Err value: XInvalid`. **Real panic in shipped code from finite domain-valid input.** Codex verified via compile probe. This is a SHIP-QUALITY HIGH.
- **Codex MEDIUM-001 (matrix overstates literal-RangeRef range support, only SUBTOTAL has the divergence note)**: real finding, applies to all 28 range-aware fns in HIGH-001. I did not include this as a separate finding but it's a consequence of HIGH-001.
- **Codex MEDIUM-002 (NEW — matrix coercion notes contradict actual strict aggregate path)**: SUM/AVERAGE/MIN/MAX tracker rows say "skip non-numeric" but `coerce_numeric` → `to_number_strict_skip_blank` actually rejects text as #VALUE!. Documentation-vs-impl contract conflict.
- **Codex MEDIUM-003 (NEW — `is_aggregate_function_lists_only_registered_aggregates` is one-sided)**: the invariant test only checks "admitted → registered", not "range-aware-needing-admission → admitted". This is the **systemic process gap** that allowed my HIGH-001 to ship across 28 fns. Tracking-test improvement is the durable fix.
- **Codex LOW-001 (master plan stale)**: confirms + extends my LOW-001 — adds the HEAD-commit drift (`517bcab08b7` claimed, audited at `5d117724f27`) and the issue-count math discrepancy.

## What this pass did NOT cover (deferred to Codex + Opus megaudits)

- Statrs corner-case re-audit for every distribution fn (compiled probes).
- Numerical anchor verification for every fn (compiled probes).
- Coverage-script accuracy validation.
- Test-quality (load-bearing vs shallow) assessment.
- W5-D-9 two's-complement boundary correctness.
- W5-D-8 BIT* f64 mantissa precision boundary.
- PERCENTILE.EXC bound check exact float-representable boundary.

Those are the Codex + Opus megaudits' scope; this self-pass focused on integration issues only visible across the whole arc.

## Pattern signal

The per-batch audit-discipline rule (parallel Codex + Opus per batch) is excellent at finding numerical correctness and per-fn divergences, but has a structural blind spot for CROSS-CUTTING / WHOLE-PHASE issues:

1. **Cross-cutting registry/binder gaps** like the `is_aggregate_function` admission: only the LAST batch (W5-D-12) flagged it, and only for the single fn the batch was about. The systemic issue across 27 earlier-shipped fns went unflagged for the entire arc.

2. **Cross-cutting lexer gaps** like the SUMXMY2 letters>3+digit bug: per-batch audits look at the batch's lexer extension, not whether OTHER fns in the registry exercise the SAME pattern.

3. **Matrix-registry drift**: per-batch audits check matrix consistency for the batch's fns, not the whole matrix.

Forward lesson for future phase closeouts: ALWAYS run a whole-phase megaudit AFTER the last per-batch audit, with explicit prompts to look for cross-batch issues. The per-batch audits are necessary but not sufficient. Once Codex + Opus megaudits land, expect more findings of this shape.
