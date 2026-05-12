# Deep audit closure — Codex Phase 3 + Phase 4 review

**Date:** 2026-05-13 (W5-48).
**Auditor:** Codex (gpt-5-codex via `codex exec`, read-only sandbox).
**Trigger:** User asked **"is EVERYTHING OPTIMAL AND COMPLETE?"** —
explicit invocation of the CLAUDE.md "Don't Be Lazy" rule.
**Companion:** `docs/audits/2026-05-13-session-handoff.md` (the
session-close handoff document this audit revisits).

## Up-front honest answer

**No — and the session handoff said as much already.** 8 deferred
gaps, 40% Excel matrix coverage, 22 of 100 function library, V1
SIMD profile is observability-only, FN4-03 lazy IF deferred,
test count below 2x Phase 2B exit target. The session was
transparent about these.

This audit asked: **did the session ALSO ship issues it wasn't
transparent about?** Codex found 3 HIGH + 5 MEDIUM + 3 LOW issues
on top of the session's own self-assessment. The high-priority
ones got fixed in this commit; the rest are documented and pinned.

## Codex findings (full)

### NEW HIGH (correctness / honesty)

**H5 — FN4-02 acceptance overstated.**
The MASTER-PLAN entry for Phase 4.3 claimed "✅ each function has
positive + error + coercion + arity tests." In reality, of the 22
V1-batch functions, only SUM/IF/ROUNDUP/LOG and a few others had
the full quartet. ROUNDDOWN/TRUNC/SIGN/EXP/LOG10/DEGREES/RADIANS/
UPPER/LOWER/TRIM had positive-case tests only.

**STATUS: FIXED W5-48.** Added 9 dedicated H5-backfill tests in
`crates/ql-functions/src/scalar_fns.rs` covering arity rejection,
error propagation, lenient text coercion, and known divergences
(German ß → SS for UPPER; emoji ZWJ count for LEN; non-breaking
space preservation for TRIM). FN4-02 in MASTER-PLAN now correctly
shows "✅ (after W5-48 backfill)" with the prior gap acknowledged.

**H6 — ROUNDUP/ROUNDDOWN binary-float edges not pinned.**
Standard Excel rounds based on the 15-digit displayed
representation, not the literal IEEE 754 binary value. So
`ROUNDUP(0.1 + 0.2, 1)` should be `0.3` per Excel canon but
Quantbook returns `0.4` (because `0.1 + 0.2 == 0.30000000000000004`
in binary). Our matrix listed ROUNDUP as ✅ with no caveat.

**STATUS: DOWNGRADED + DOCUMENTED.** ROUNDUP and ROUNDDOWN
reclassified to ⚠️ partial in `docs/compat/excel-matrix.md`. Notes
column explains the binary-float gap and pins decimal-aware
rounding to Phase 4.5 (number formats). The functions still
return the correct binary-truncation answer; they're just not
match-Excel-canon at the display layer.

**H7 — ECM-4-02 acceptance overstated.**
The matrix preamble claimed "each function row carries Status,
Tests, Category, Excel parity notes." Actual table schema:
`Function | Status | Tests | Phase | Notes` — no Category column.
Category is encoded via `###` section headers. Also ~52 function
rows had empty Notes cells.

**STATUS: DOWNGRADED + REWORDED.** Preamble rewritten to state
the schema accurately (categories are section headers, not
columns). ECM-4-02 in MASTER-PLAN reclassified ⚠️ partial.
Per-row Notes expansion is a documented Phase 4.3+ follow-up.

### NEW MEDIUM

**M5 — IronCalc parser gap matrix had count inaccuracies.**
Doc said IronCalc TokenType had 27 variants and Node had 26.
Actual counts (verified via `.references/ironcalc/base/src/
expressions/token.rs:218-263` and `parser/mod.rs:120-233`): 29
tokens, 27 Nodes. Also missed `NamedFunctionKind` in the AST gap
table.

**STATUS: FIXED W5-48.** Counts corrected; `NamedFunctionKind`
added to the gap table with target phases (4.3 registration + 6.4
Python UDFs).

**M6 — Parser sequencing recommendation incomplete.**
Recommendation said collapse 4.6+4.7+4.8 lexer work; underplays
4.9's lexer-coupled features (R1C1 mode, backslash, decimal/arg
separator). Implicit intersection (4.9) IS post-parse, but the
lexer-mode plumbing for 4.9 should be considered as part of the
same token-set expansion.

**STATUS: DOCUMENTED (not fully reworded).** The sequencing
recommendation in `docs/parser/ironcalc-deep-read.md` stands as
"collapse 4.6+4.7+4.8" but the next-session entry point should
broaden to include 4.9's lexer plumbing. Captured in the audit
closure recommendation list.

**M7 — DEGREES/RADIANS could produce unsanitized non-finite Values.**
`f64::to_degrees` / `to_radians` can produce ±Inf for extreme
inputs; our impls returned `Value::Number(n.to_degrees())`
directly, bypassing `sanitize_f64`. Other math fns (EXP/LN/LOG/
LOG10) correctly sanitize.

**STATUS: FIXED W5-48.** Both functions now route through
`sanitize_f64`; Inf becomes `#NUM!`. Verified by new H5 test
`h5_degrees_radians_arity_error_overflow` which asserts
`degrees(f64::MAX) == #NUM!`.

**M8 — Coverage script mechanical-honest but semantically weak.**
`scripts/report-compat-coverage.sh` counts ✅ + ⚠️ + 🔄 as "has
something" toward 40% coverage. ⚠️ rows have known limitations
and ✅ rows can have thin tests (H5). The 40% number is
defensible mechanically but doesn't represent "40% of Excel
parity."

**STATUS: KNOWN LIMITATION — not changing.** The script is a
mechanical reporter; it's not the parity gate. Phase 4.12
megaudit will add semantic gates (per-function-test-count
threshold, IronCalc test corpus parity, etc.).

**M9 — Volatile-test TLS RNG leak on panic.**
`set_test_rng_seed` is thread-local; tests manually call
`clear_test_overrides()`. If a test panics before clearing,
later tests on the same thread inherit the seed. Could cause
flakes in stress / random-order test runs.

**STATUS: KNOWN LIMITATION — small follow-up filed.** Guard-RAII
pattern would close this. Not blocking; current tests use
absolute seed values so the leak is observable only if a panic
happens AND a subsequent test asserts on default-RNG behavior.

### NEW LOW

**L4 — `ql-exec/src/lib.rs` module map stale.**
Header said "Phase 0 → Phase 2B"; lib.rs claimed
`AggregateNameRef` returns `#CALC!` pending Phase 3.6 despite
3.6 having shipped.

**STATUS: FIXED W5-48.** Rewrote module map header through Phase
3.10 + Phase 4.3 V1; added `aggregate_cache.rs` entry; updated
`scalar.rs` and `env.rs` descriptions to reflect shipped state.

**L5 — `WorkbookRuntime` preamble stale.**
Preamble said "Phase 4+ deferred: Dependency-tracking incremental
recompute (calcgraph integration); Computed-overlay separation
(CORR-25)" — both shipped in Phase 3.

**STATUS: FIXED W5-48.** Rewrote preamble to document the actual
shipped surface (set_formula routing to computed lane, set_value
cascading clear_formula, recompute_dirty Tarjan + agg cache + VEQ +
SIMD-classified, validate_formula). Phase 4+ deferred list now
reflects the GAP-G-01/G-02/G-03 + FN4-03 + cross-sheet
carryovers.

**L6 — IronCalc provenance path off.**
Doc pointed to `/Users/sanzhar/.../quantbook-engine/.references/
ironcalc/` but the `.references/` directory lives at the PARENT
repo root, not inside the engine crate.

**STATUS: FIXED W5-48.** Path corrected with explicit relative-
vs-absolute disambiguation.

### Codex assessment of session honesty

> "Was the session honest about what's deferred? Mostly yes.
> The handoff clearly says 22/100 functions, 40% matrix
> coverage, no lazy IF/IFERROR, no GAP-G-01/G-03 fix. It
> under-reports the FN4-02 test weakness and ECM-4-02
> schema/notes incompleteness."

> "Were the architectural deferrals justified? Yes. GAP-G-01
> and GAP-G-03 are real correctness issues and need a graph/
> storage decision, not a rushed local patch."

This audit closure addresses the "under-reported" pieces (H5/H7
reclassifications + FN4-02 backfill tests + matrix prose
rewrite). The architectural deferrals stand.

## My own findings (Codex missed these)

While Codex audited, I ran an empirical edge-case test on the
new functions. Found three divergences Codex didn't explicitly
flag:

**My-F1 — UPPER("ß") returns "SS"; Excel returns "ß".**
Rust's `to_uppercase` uses Unicode-default mapping; Excel uses
ASCII-locale-only mapping by default. Status: ⚠️ partial in
matrix; documented; pinned Phase 4.9. New test
`h5_upper_lower_arity` pins our observed behavior.

**My-F2 — LEN(emoji ZWJ family) = 5; Excel = 8 (UTF-16 units).**
Our impl uses `.chars().count()` (Unicode scalars); Excel uses
UTF-16 code unit count. Matches for ASCII / BMP plane; diverges
for emoji ZWJ sequences. Status: documented in matrix with the
divergence detail; pinned Phase 4.9. New test
`h5_len_known_unicode_divergence` pins our behavior.

**My-F3 — ROUNDDOWN(-0.001, 2) = Number(-0.0).**
Negative zero. PartialEq says `0.0 == -0.0` so tests pass; UI
display may show `-0`. Cosmetic only. Documented in matrix.

## What this commit does

Code fixes:
- `crates/ql-functions/src/scalar_fns.rs`: M7 sanitize DEGREES +
  RADIANS; H5 add 9 new arity/error/coercion/divergence tests
  (h5_rounddown_*, h5_trunc_*, h5_sign_*, h5_exp_*, h5_log10_*,
  h5_degrees_radians_*, h5_upper_lower_*, h5_trim_*, h5_len_*).

Doc fixes:
- `crates/ql-exec/src/lib.rs`: L4 rewrote module map (Phase 0 →
  Phase 3.10 + Phase 4.3 V1); added `aggregate_cache.rs` entry.
- `crates/ql-exec/src/workbook_runtime.rs`: L5 rewrote preamble
  to reflect shipped recompute_dirty surface + Phase 4 carryovers.
- `docs/parser/ironcalc-deep-read.md`: M5 fixed token (27→29) +
  Node (26→27) counts; added `NamedFunctionKind` to AST gap; L6
  fixed provenance path.
- `docs/compat/excel-matrix.md`: H7 rewrote preamble (categories
  are section headers, not row columns); My-F1/F2 documented
  divergences for UPPER/LOWER/LEN; H6 reclassified ROUNDUP/
  ROUNDDOWN as ⚠️ partial with binary-float gotcha note.
- `docs/MASTER-PLAN.md`: H5/H7 acceptance reclassified
  honestly; FN4-02 now ✅ (after W5-48 backfill); ECM-4-02
  documented as ⚠️ partial.

What's intentionally NOT changed:
- The architectural decision for GAP-G-01/G-03 (Phase 4 entry).
- Lazy IF/IFERROR (FN4-03 deferred).
- The 22-of-100 function library state.
- The 40% matrix coverage state.
- M8 (script semantic gate; Phase 4.12 megaudit problem).
- M9 (TLS RNG guard pattern; small follow-up).

## Updated workspace numbers

- ql-exec: 282 tests (unchanged).
- ql-functions: 106 tests (was 97; +9 H5 backfill tests).
- ql-storage: 70 tests (unchanged).
- ql-types: 89 tests (unchanged).
- **Workspace: 981 tests, 0 failed.** (Was 972 pre-W5-48.)
- All 7 gates green.

## Is everything optimal and complete NOW?

**Still no, and the honest reasons remain:**

1. 8 gaps deferred to Phase 4 (GAP-G-01, G-02, G-03, R-07, R-08,
   S-06, plus 2 doc gaps closed in handoff).
2. Phase 4.3 still at 22/100 (V2 batch needs ~78 more functions).
3. Excel matrix 40% (notes coverage uneven; many cells still
   have empty Notes).
4. SIMD V1 is observability-only (bulk dispatch Phase 4.7+).
5. FN4-03 lazy IF/IFERROR still deferred.
6. Test count below A3-04 2x target (981 vs ~1724); documented
   exception holds.
7. Three known function-level divergences from Excel
   (UPPER/LOWER Unicode-default, LEN scalar-vs-UTF-16,
   ROUNDUP/ROUNDDOWN binary-float).

**What this audit DID make optimal/complete:**

- The Phase 4.3 V1 batch now genuinely meets FN4-02 (was
  overstated).
- The Excel compat matrix is mechanically accurate (categories
  encoded honestly; ROUNDUP/UPPER divergences captured).
- The parser deep-read counts are correct.
- Stale module preambles fixed.
- DEGREES/RADIANS no longer produces non-finite Values silently.

The session is paused at a CLEAN inflection point. The architectural
decision for GAP-G-01/G-03 remains the right gate for Phase 4.3 V2.
