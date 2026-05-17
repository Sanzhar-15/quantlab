# VDB audit — reconciliation summary

**Audit date:** 2026-05-17
**HEAD at audit launch:** `f81965a0a9c` (W5-183)
**Closure commit:** W5-183.1 (this commit)
**Audit tools:** parallel Codex + separate Opus (2nd application of 2026-05-17 audit-discipline rule)

## Audit risk profile

**Higher than the W5-180→W5-182 batch audit** because:
- IronCalc has VDB in docs nav but NO Rust implementation — algorithm derived from Microsoft's 6 documented examples + canonical period-iteration form (no IronCalc-port reference).
- Algorithm combines: period range (with fractional start/end), DDB-to-SLN crossover (locked-in SLN amount), `no_switch` flag.
- Microsoft docs are sparse — 6 examples but no Remarks section with error codes.

## Codex audit

**Output:** `2026-05-17-w5183-vdb-codex.md` (132 lines)
**Findings:** 1 HIGH + 2 MEDIUM + 2 LOW
**Independent verification:** Codex hand-traced all 6 Microsoft examples + provided 5 additional LibreOffice / OpenFormula reference values:
- VDB(1000,100,10,5,7) = 117.9648
- VDB(1000,100,10,5,10) = 227.68
- VDB(1000,100,10,5,10,2,TRUE) = 220.3058176
- VDB(1000,100,10,0.5,1.5) = 180
- VDB(1000,100,10,2.3,4.7) = 249.344

## Opus audit

**Output:** `2026-05-17-w5183-vdb-opus.md` (extensive)
**Findings:** 1 HIGH + 10 MEDIUM + 8 LOW
**Independent verification:** Opus reproduced all 6 Microsoft fixtures in Python, verified locked-vs-recomputed SLN crossover equivalence, confirmed full-book-depletion model (alternative gives 438.36 instead of 396.31 for the 6→18 fixture).

**Algorithm verdict from both audits: no HIGH bugs in the core math.** Both audits explicitly stated the period-iteration, fractional-overlap, full-book-depletion, and crossover semantics are correct against Microsoft + independent references.

## Convergence

| Item | Codex | Opus | Severity (reconciled) |
|------|-------|------|----------------------|
| DoS guard off-by-one (`>` allows exact `i32::MAX`) | MEDIUM-1 | HIGH-1 | **HIGH** — soundness DoS. Same bug in DB too (Opus caught). |
| Matrix VDB test count wrong | LOW-2 | MEDIUM-7 | **MEDIUM** |
| `arg_type` "Boolean-strict" wording wrong | LOW-2 | MEDIUM-2 | **MEDIUM** |
| Crossover/fractional tests assert inequality only | MEDIUM-2 | MEDIUM-4 | **MEDIUM** |

## Codex-unique findings

- **HIGH-1**: `salvage > cost` silently returns 0. LibreOffice / OpenFormula reject with `#NUM!`. We didn't validate; our impl returns 0 because `book - salvage < 0` clamps DDB to 0 and the negative SLN check never switches.
- **LOW-1**: `vdb_no_switch_keeps_ddb_throughout` test comment claims a false invariant — `cost - salvage = 2100` is fixture-specific to (2400/300/10) where DDB hits the salvage cap by the last period. For (1000/100/10) the same logic gives 892.6258176 ≠ 900.

## Opus-unique findings

- **MEDIUM-1**: Doc-comment §Algorithm step 2 says `(book − salvage) / (life − i)` but impl uses `.max(1.0)` floor. The inline comment falsely claims the floor is redundant ("validation ensures period ≤ life - 1 hence life - period ≥ 1") — only true for integer life. For fractional life (e.g., 4.5), the floor does real work.
- **MEDIUM-3**: `vdb_boolean_no_switch_coerces` doesn't actually test coercion — the fixture (period 1, factor=2) produces $480 regardless of `no_switch` because DDB > SLN in period 1.
- **MEDIUM-5**: `vdb_no_switch_keeps_ddb_throughout` doesn't test what its name claims. For (2400/300/10), the default form ALSO never switches (salvage cap drives both forms to 2100). The 2100 is a salvage-cap invariant, not a `no_switch` invariant.
- **MEDIUM-6**: `vdb_huge_life_rejected` only pins `1e15`; doesn't test exact `i32::MAX as f64` boundary (which slipped past the `>` guard). Also missing end_period-side guard test.
- **MEDIUM-8**: Microsoft "all args must be positive" divergence — we accept `cost=0` / `salvage=0`. DDB matrix flagged this; VDB matrix did not.
- **MEDIUM-9, MEDIUM-10**: Missing `negative factor`, `negative life`, `start=0 boundary` tests.
- **LOW-1**: `cost==0` doc framing implies a NaN-safety motive that doesn't apply to VDB (unlike DB, VDB doesn't divide by cost).
- **LOW-2, LOW-3, LOW-4**: Missing `start=end=0`, additivity invariant, fractional-life crossover tests.
- **LOW-5**: All 6 anchor tests are exactly the Microsoft examples — no independent cross-check. (Addressed by Codex's LibreOffice fixtures.)
- **LOW-6, LOW-7, LOW-8**: Comment claims, float drift on `end > life`, wording nits.

## Dispositions

### Fixed in W5-183.1 (HIGH + MEDIUM)

| Finding | Action |
|---------|--------|
| Convergent HIGH (DoS off-by-one) | Both VDB and DB: validation `>` → `>=` for `life`/`period`/`end_period`. New boundary tests pinning `i32::MAX as f64` exactly + the end_period side. |
| Codex HIGH-1 (`salvage > cost`) | New validation `\|\| salvage > cost`. `salvage == cost` keeps returning 0 (zero depreciation possible). New test pinning both branches. |
| Codex MEDIUM-2 / Opus MEDIUM-4 (inequality tests) | Replaced inequality assertions with exact-value assertions from Codex's LibreOffice reference fixtures. |
| Opus MEDIUM-1 (doc-comment + inline comment wrong about `.max(1.0)`) | Corrected: explained fractional-life case. Doc §Algorithm step 2 now reads `(book − salvage) / max(life − i, 1)`. |
| Codex LOW-2 / Opus MEDIUM-2 ("Boolean-strict" wording) | Matrix + doc-comment corrected: `arg_type` extends `arg_num` with logical coercion, NOT Boolean-strict. Pinned via new `vdb_no_switch_numeric_coerces_to_bool` test. |
| Opus MEDIUM-3 (Boolean-coercion test inert) | Replaced fixture with `(1000, 100, 10, 5, 10)` where the flag genuinely diverges TRUE=220.31 vs FALSE=227.68. Asserts both exact values + meaningful divergence (`abs > 5`). |
| Opus MEDIUM-5 (test name false invariant) | Replaced `vdb_no_switch_keeps_ddb_throughout` with two clearly-named fixtures: `vdb_no_switch_full_life_salvage_cap_fixture` (the 2100 case) and `vdb_no_switch_full_life_below_cost_salvage_when_cap_not_reached` (the 892.63 case). Both pinned exactly. |
| Opus MEDIUM-6 (i32 boundary tests incomplete) | Added end_period-side test + exact-i32::MAX test. Same fix applied to DB's existing test. |
| Opus MEDIUM-7 (matrix test count) | Matrix updated 19 → 33. |
| Opus MEDIUM-8 (Microsoft "all positive" divergence) | Doc-comment + matrix updated with explicit flag (matches DDB pattern). |
| Opus MEDIUM-9, MEDIUM-10 (validation tests gap) | New tests: `vdb_negative_factor_is_num`, `vdb_negative_life_is_num`, `vdb_start_period_zero_returns_full_first_period`. |
| Opus LOW-2 (start=end=0 test) | Added `vdb_start_zero_equals_end_zero_returns_zero`. |
| Opus LOW-3 (additivity invariant) | Added `vdb_additivity_invariant` pinning `VDB(start, k) + VDB(k, end) = VDB(start, end)` for one partition. |
| Codex MEDIUM-2 (LibreOffice cross-checks) | Added 3 new tests using Codex's LibreOffice reference values: `vdb_libreoffice_periods_5_to_7`, `vdb_libreoffice_fractional_overlap_half_period_boundary`, `vdb_libreoffice_fractional_overlap_mid_life`. The other 2 LibreOffice values are now embedded in the upgraded coercion + crossover tests. |
| Codex LOW-1 (false invariant comment) | Resolved as part of MEDIUM-5 — the misleading test was replaced entirely. |
| Opus LOW-1 (cost==0 doc framing) | Doc-comment updated to clarify motive is "no depreciation possible from a zero-cost asset", not NaN-safety. |

### Deferred (documented, not fixed)

| Finding | Reason |
|---------|--------|
| Opus LOW-4 (fractional-life crossover test) | Marginal — Opus could not construct a case where the `.max(1.0)` floor changes the value. Doc-comment fix and existing tests already cover the floor's existence; building a test that specifically demonstrates a non-redundant floor would require constructing inputs where book < salvage before life completes, which we can't make happen given the salvage cap. Defer. |
| Opus LOW-5 (Microsoft-only anchors) | Resolved — Codex provided independent LibreOffice references, now pinned. |
| Opus LOW-6, LOW-7, LOW-8 (comment claims, float drift, wording nits) | Doc-only polish; bundle with the next VDB-touching cycle. |

## Pattern signals captured

1. **Off-by-one in DoS guards is a recurring class of bug.** W5-182.1 closed it for DB but introduced VDB with the same `>` guard. Both fixed in this commit. **Action item**: when introducing any new function with a `cap as i32` cast, lift the boundary check from the sister function rather than retyping.

2. **Tests that compute expected via the same formula as the impl don't catch algorithm regressions** — only LibreOffice / Python independent verification did. The 5 LibreOffice fixtures are now pinned; future statistical/financial batches should include at least one independent cross-check fixture per function.

3. **Test names should describe the invariant being tested, not the fixture being used.** `vdb_no_switch_keeps_ddb_throughout` describes the algorithm intent but the test actually proved the salvage-cap invariant — misleading by name. Renamed to fixture-specific names.

4. **"Boolean-strict" was wrong nomenclature** for our `arg_type` helper. Use "logical coercion" (or just describe the actual behavior: non-zero numeric → TRUE, blank → FALSE, errors propagate).

5. **Parallel audits with distinct models continue to find non-overlapping issues.** Codex found `salvage > cost` (HIGH); Opus found the `.max(1.0)` doc-comment mismatch and several test-quality issues. Neither would have surfaced the same set alone.

## Status

- 2 HIGH closures shipped in code (DoS off-by-one + salvage>cost).
- 8 MEDIUM closures shipped in code/docs.
- 4 LOW closures shipped (mostly absorbed into MEDIUM fixes).
- 4 LOWs deferred with written reasons.
- VDB tests: 22 → 33 (+11 net), all green.
- DB `db_huge_life_rejected` upgraded to also pin `i32::MAX as f64` boundary.
- All 4 gates clean at the closure commit. 3082 workspace tests passing (+12 from W5-183's 3070).
