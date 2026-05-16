# Wave 3 depreciation batch audit — reconciliation summary

**Audit date:** 2026-05-17
**HEAD at audit launch:** `c8f54fca645` (W5-182)
**Closure commit:** W5-182.1 (this commit)
**Audit tools:** parallel Codex + separate Opus (new audit-discipline rule from 2026-05-17)

## Codex audit

**Output:** `2026-05-17-w5180-w5182-depreciation-codex.md` (130 lines)
**Findings:** 1 HIGH + 1 MEDIUM + 2 LOW

## Opus audit

**Output:** `2026-05-17-w5180-w5182-depreciation-opus.md` (782 lines)
**Findings:** 1 HIGH + 9 MEDIUM + 9 LOW

## Convergence

Both audits independently flagged:

| Item | Codex | Opus | Severity (reconciled) |
|------|-------|------|----------------------|
| DB `life ≤ 0` validation gap | HIGH-1 | MEDIUM-5 | **HIGH** — concrete repro `DB(1000,100,0,1,7)=583.33` instead of #NUM! |
| DB `month` Boolean-coercion divergence undocumented | MEDIUM-1 | MEDIUM-3 | **MEDIUM** |
| `db_full_year_period_equals_life_succeeds` only typechecks | LOW-1 | HIGH-1 | **HIGH** — Opus elevated because the path is the most-error-prone loop+final-period branch |

## Opus-only findings

- **MEDIUM-1**: DDB matrix says 15 tests, actually 16.
- **MEDIUM-2**: SYD `life=0 → #NUM!` over-attributed to "Microsoft canon" when actually IronCalc convention.
- **MEDIUM-4**: DB rate uses raw fractional `life` but iteration uses `life.floor()` — internally inconsistent for fractional life. Inherited from IronCalc.
- **MEDIUM-6**: DB fractional `period < 1` (e.g., 0.5) silently returns period-2's value.
- **MEDIUM-7**: DB i32 overflow / DoS on huge `life`/`period` — `1e15` saturates `i32::MAX`, `life_int + 1` panics in debug.
- **MEDIUM-8**: DDB doc could include closed-form ↔ iterative equivalence proof. LOW priority (impl is correct).
- **MEDIUM-9**: Microsoft DDB says "all five args must be positive"; we accept `cost=0` and `salvage=0` per IronCalc convention.
- **LOW-1..LOW-9**: tautological "Microsoft fixture" tests (compute expected from impl formula), missing `factor=1.5` DDB fixture, missing salvage>cost canary tests, conservative tolerance headroom, etc.

## Codex-only findings

- **LOW-2**: DB matrix says `month > 12` rejected on raw input, but truncation happens first. Doc inaccuracy.

## Dispositions

### Fixed in W5-182.1

| Finding | Action |
|---------|--------|
| Codex HIGH-1 / Opus MEDIUM-5 (DB life≤0) | Validation tightened to `life < 1.0` — catches both `life=0` and fractional `life ∈ (0, 1)`. 3 new tests pin the boundary. |
| Opus HIGH-1 / Codex LOW-1 (db_full_year value-pin) | Test renamed to `db_full_year_period_equals_life_pins_value`. Now computes expected via canonical formula and asserts via `approx` instead of `matches!`. |
| Opus MEDIUM-6 (DB period<1) | Validation tightened `period <= 0.0` → `period < 1.0`. New test pins boundary. |
| Opus MEDIUM-7 (DB i32 overflow / DoS) | Validation rejects `life > i32::MAX as f64 \|\| period > i32::MAX as f64`. New test pins both. Deliberate divergence from IronCalc which has the same overflow — soundness > IronCalc fidelity. |
| Codex MEDIUM-1 / Opus MEDIUM-3 (DB month Boolean undocumented) | Doc-comment + matrix updated. New test pins divergence behavior. |
| Opus MEDIUM-1 (DDB matrix test count 15→16) | Matrix fixed; also reflects new test additions. |
| Opus MEDIUM-2 (SYD over-attribution to Microsoft) | Doc-comment + matrix softened: "per IronCalc convention" instead of "per Microsoft canon" for the `life=0 → #NUM!` asymmetry. |
| Opus MEDIUM-4 (DB fractional-life internal inconsistency) | Documented in doc-comment + matrix as IronCalc-inherited quirk; not fixed without verified Excel behavior. |
| Opus MEDIUM-9 (DDB Microsoft "all positive" divergence) | Doc-comment + matrix updated with explicit divergence flag. |
| Codex LOW-2 (DB matrix month-truncation order) | Matrix wording updated to clarify "truncated **before** validation". |

### Deferred (documented, not fixed)

| Finding | Reason for deferral |
|---------|---------------------|
| Opus MEDIUM-8 (DDB equivalence proof in doc) | Impl is correct; adding the proof is doc-only quality improvement. Not a correctness item. |
| Opus LOW-1, LOW-2, LOW-5 (tautological Microsoft-fixture tests) | Real but lower-priority. Adding anchor tests against Microsoft display values (e.g., $186,083.33 for `DB(1M,100k,6,1,7)`) requires fetching the full series. Bundle with the next depreciation cycle. |
| Opus LOW-3 (SLN/SYD salvage>cost canary) | Real but speculative without verified Excel behavior. Bundle with a future "verify against real Excel" pass. |
| Opus LOW-4 (DB month-negative-fraction tests) | Trunc-toward-zero behavior on negative-fraction inputs (`-0.5 → -0 → caught`) is correct but uncovered. Defer; current month<=0 check covers the practical cases. |
| Opus LOW-6 (DDB factor=1.5 Microsoft fixture) | New fixture worth adding. Bundle with the next DDB-touching cycle. |
| Opus LOW-7 (SYD fractional per note) | Minor matrix doc gap. Defer. |
| Opus LOW-8 (DDB rate=1 branch comment) | Impl is correct; doc nit. |
| Opus LOW-9 (SYD invariant tolerance tighten 1e-6 → 1e-9) | Real improvement but current tolerance has 6 orders of magnitude headroom. Defer. |

## Pattern signals for future audits

1. **Both Codex and Opus independently caught the DB `life` validation gap** but disagreed on severity (HIGH vs MEDIUM). Severity calibration matters: a value-producing path that disagrees with Excel canon is HIGH regardless of how "obscure" the input looks.

2. **Both caught the typecheck-only test** but with different framings — Codex flagged as a test-gap LOW, Opus elevated to HIGH because the path is the most-error-prone code path in the entire DB implementation. Lesson: tests that exercise high-risk code paths deserve value-pinning regardless of how "obvious" the result feels.

3. **Opus found 7 more MEDIUMs that Codex missed** — including the DoS-class i32 overflow and the fractional-period off-by-one. Parallel-audit-with-distinct-models pays off; the two reviewers find non-overlapping issues.

4. **Documentation over-attribution to "Microsoft" is a recurring pattern** in this codebase — SYD `life=0 → #NUM!` was attributed to Microsoft when it's IronCalc-only; the "per Microsoft canon" phrasing should be reserved for verified Microsoft-documented behavior.

5. **i32 saturating-cast from f64** is a latent soundness issue across the codebase. The fix in W5-182.1 (`life > i32::MAX as f64`) is local; a sweep for similar patterns in other functions is worth scheduling.

## Status

- 5 HIGH/MEDIUM closures shipped in code.
- 5 MEDIUM closures shipped in docs.
- 1 LOW closure shipped (DB month-truncation matrix wording).
- 9 LOW + 1 MEDIUM-8 deferred with written reasons.
- 6 new tests covering the validation closures (3048 passing, +6 net from 3042).
- All 4 gates clean at the closure commit.
