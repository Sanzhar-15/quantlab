# Phase 4.10 V1-260 Megaudit - Codex

Date: 2026-05-17
Branch: `feat/quantbook-engine`
HEAD audited: `5d117724f27`
Scope: Phase 4.10 V1-260 closeout plus Wave 3 distribution arc, with emphasis on cross-batch drift missed by per-batch audits.

Verification signals:

- `cargo test -p ql-functions default_registry_has_expected_count` passed; the registry count pin is `assert_eq!(r.len(), 260)` at `crates/ql-functions/src/registry.rs:1096`.
- `cargo test -p ql-functions coverage` passed.
- `bash scripts/report-compat-coverage.sh` reports `coverage=80%` with 210 implemented, 38 partial, 1 reserved, 62 missing, 311 rows.
- `cargo test --workspace` passed in this checkout after the temporary probe file was removed from the test tree.
- `cargo test --workspace -- --list` reports `tests=4018 benches=0`.
- `find docs/audits -maxdepth 1 -name '2026-05-17-w5-d-*.md'` reports 24 audit markdown files: Codex + Opus for 12 W5-D batches.

## HIGH

### HIGH-001

- ID: HIGH-001
- Subject: Most Phase 4.10 range-aware functions are registered but not admitted by the binder's range/name gate.
- Where: `crates/ql-exec/src/plan.rs:405`, `crates/ql-exec/src/plan.rs:738`, `crates/ql-exec/src/plan.rs:850`, `crates/ql-functions/src/registry.rs:745`, `crates/ql-functions/src/registry.rs:750`, `crates/ql-functions/src/registry.rs:755`, `crates/ql-functions/src/registry.rs:758`, `crates/ql-functions/src/registry.rs:767`, `crates/ql-functions/src/registry.rs:776`, `crates/ql-functions/src/registry.rs:796`, `crates/ql-functions/src/registry.rs:805`, `crates/ql-functions/src/registry.rs:823`, `crates/ql-exec/src/scalar.rs:174`
- Detail: `is_aggregate_function` is the bind-time admission gate for named ranges. Function args bind under `BindContext::AggregateArg` only if `is_aggregate_function(name)` returns true; otherwise named ranges hit `BindError::NamedRangeInScalarContext` at `plan.rs:857`. The registry has 50 `register_range_aware` functions, but only 22 are admitted. The missing 28 are: `CORREL`, `COUNTBLANK`, `COVARIANCE.P`, `COVARIANCE.S`, `INTERCEPT`, `IRR`, `MAXIFS`, `MINIFS`, `MIRR`, `NPV`, `PEARSON`, `PERCENTILE`, `PERCENTILE.EXC`, `PERCENTILE.INC`, `QUARTILE`, `QUARTILE.EXC`, `QUARTILE.INC`, `RSQ`, `SLOPE`, `STEYX`, `SUMX2MY2`, `SUMX2PY2`, `SUMXMY2`, `TEXTJOIN`, `XIRR`, `XLOOKUP`, `XMATCH`, `XNPV`. This includes every Phase 4.10 closeout range-aware function the megaudit prompt called out except `SUBTOTAL`, which was added in W5-D-12.1.
- Recommendation: Replace or extend `is_aggregate_function` so every registered range-aware function that accepts range args is admitted. Prefer deriving this from registry metadata rather than maintaining another hardcoded matcher. Add named-range e2e tests for each Phase 4.10 range-aware family: COVARIANCE, XNPV/XIRR, PERCENTILE/QUARTILE, MINIFS/MAXIFS/COUNTBLANK, SUMX*, TEXTJOIN, NPV/IRR/MIRR, CORREL/SLOPE/INTERCEPT/PEARSON/RSQ/STEYX, XLOOKUP/XMATCH.
- Severity rationale: These functions are counted as shipped and matrix-covered, but normal formulas using named ranges cannot bind. That is a user-visible execution gap, not just a documentation issue.

### HIGH-002

- ID: HIGH-002
- Subject: Registered function names ending in digits can be unlexable when the letter prefix is not a valid Excel column.
- Where: `crates/ql-formula-syntax/src/lexer.rs:619`, `crates/ql-formula-syntax/src/lexer.rs:631`, `crates/ql-formula-syntax/src/lexer.rs:672`, `crates/ql-formula-syntax/src/lexer.rs:709`, `crates/ql-formula-syntax/src/parser.rs:317`, `crates/ql-functions/src/registry.rs:642`, `crates/ql-functions/src/registry.rs:753`, `docs/compat/excel-matrix.md:177`, `docs/compat/excel-matrix.md:191`
- Detail: The W5-D-9 lexer extension only handles `letters + digits + letters` names such as `DEC2BIN`. It does not handle `letters + digits` names when the letter prefix is too large to be a column. `SUMXMY2` reaches the cell-ref path, parses `SUMXMY` as a column, and errors with `ColumnTooLarge("SUMXMY")` before the parser can apply the function-call disambiguation used for `LOG10(...)`. The same pre-existing pattern breaks `ATAN2`, which is registered and marked implemented in the matrix: `ATAN2` reaches `ColumnTooLarge("ATAN")`. Parser recovery only works if the lexer successfully emits a `CellRef` token with preserved text, as described at `parser.rs:317`.
- Recommendation: In the lexer, when a `letters + digits` candidate is followed by `(` and the letter prefix cannot be a valid column, emit `Token::Ident(raw)` instead of returning `ColumnTooLarge`. Add direct lexer and parser tests for `SUMXMY2(A1:A3,B1:B3)` and `ATAN2(1,2)`. Keep existing `LOG10` behavior pinned because valid-column-prefix function names still rely on parser disambiguation.
- Severity rationale: At least one Phase 4.10 registered function (`SUMXMY2`) and one earlier registered function (`ATAN2`) are unreachable from formulas despite registry, coverage, and matrix entries saying they ship.

### HIGH-003

- ID: HIGH-003
- Subject: `GAMMA.INV` can still panic for finite subnormal/small scale values.
- Where: `crates/ql-functions/src/distribution_fns.rs:1440`, `crates/ql-functions/src/distribution_fns.rs:1546`, `crates/ql-functions/src/distribution_fns.rs:1550`
- Detail: W5-D-5.1 added `gamma_dist_with` to reject non-finite `rate = 1.0 / beta_scale`. That prevents the infinite-rate hang, but it still accepts finite enormous rates. A compile probe against the local crates showed `gamma_inv([0.5, 1.0, f64::MIN_POSITIVE / 2.0])` panics inside `statrs` with `called Result::unwrap() on Err value: XInvalid`, while nearby tiny scales return `#NUM!`. This is a domain-valid finite `Value::Number` input path: `beta_scale > 0` passes at `distribution_fns.rs:1539`, `gamma_dist_with` returns `Some`, and the panic occurs at `dist.inverse_cdf(p)`.
- Recommendation: Add a lower bound for `beta_scale` or upper bound for converted `rate` that rejects the finite-huge-rate region before calling statrs `inverse_cdf`. Add a regression test that uses a finite subnormal scale and asserts `Value::Error(ErrorValue::Num)` without panic. Consider applying the same protective bound to `GAMMA.DIST` if returning `1.0` for subnormal scale is not intended.
- Severity rationale: A finite numeric input can unwind the engine from a shipped distribution function. This matches the prior Wave 3 iterative-kernel availability class and should be treated as a ship-quality blocker.

## MEDIUM

### MEDIUM-001

- ID: MEDIUM-001
- Subject: Matrix rows overstate range support because the literal `RangeRef` binder gap is documented only for `SUBTOTAL`.
- Where: `crates/ql-exec/src/plan.rs:706`, `docs/compat/excel-matrix.md:78`, `docs/compat/excel-matrix.md:86`, `docs/compat/excel-matrix.md:92`, `docs/compat/excel-matrix.md:93`, `docs/compat/excel-matrix.md:191`, `docs/compat/excel-matrix.md:208`, `docs/compat/excel-matrix.md:247`, `docs/compat/excel-matrix.md:298`, `docs/compat/excel-matrix.md:193`
- Detail: `Expr::RangeRef` binds only in `BindContext::ReferenceArg`; the comment at `plan.rs:713` explicitly defers AggregateArg-side literal ranges. `SUBTOTAL` is marked partial and documents that `SUBTOTAL(9, A1:A10)` does not bind. Other Phase 4.10 range-aware rows remain marked implemented and describe range arguments without this limitation: MINIFS/MAXIFS/COUNTBLANK, PERCENTILE/QUARTILE, CORREL/COVARIANCE/SLOPE/INTERCEPT/PEARSON/RSQ/STEYX, SUMX*, TEXTJOIN, XLOOKUP/XMATCH, NPV/IRR/MIRR/XNPV/XIRR. Some currently have the HIGH-001 named-range admission bug as well, but even after that fix, literal range calls will remain unsupported until the AggregateArg RangeRef lift lands.
- Recommendation: Add a global matrix note for range-aware `AggregateArg` literal-range deferral, or mark each affected row partial until literal `A1:A3` arguments bind. Keep named-range support and literal-range support separate in the notes, because they fail in different layers.
- Severity rationale: This is a documentation/honesty gap, but it materially affects how users read `implemented` status for ordinary spreadsheet formulas.

### MEDIUM-002

- ID: MEDIUM-002
- Subject: Aggregate coercion notes conflict with the actual strict aggregate path.
- Where: `docs/compat/excel-matrix.md:56`, `docs/compat/excel-matrix.md:57`, `docs/compat/excel-matrix.md:62`, `docs/compat/excel-matrix.md:100`, `docs/compat/excel-matrix.md:377`, `docs/compat/excel-matrix.md:379`, `crates/ql-functions/src/range_aware_fns.rs:61`, `crates/ql-types/src/coercion.rs:203`, `crates/ql-types/src/coercion.rs:29`, `crates/ql-functions/src/scalar_fns.rs:3762`, `crates/ql-functions/src/scalar_fns.rs:3776`, `crates/ql-functions/src/scalar_fns.rs:3867`
- Detail: The matrix still has tracker rows saying `SUM/AVERAGE skip non-numeric`, `PRODUCT skip non-numeric`, and the AVERAGEA row says base AVERAGE/MAX/MIN skip text and bool entirely. The implementation does not do that. `coerce_numeric` delegates to `to_number_strict_skip_blank`; blanks skip, booleans coerce through `to_number_strict` to 1/0, and text returns `#VALUE!`. Unit tests pin `SUM(TRUE,1)=2` and `SUM(1,"hi")=#VALUE!`. `PRODUCT` does document empty -> 0 at the function row, but the tracker row still says it skips non-numeric, which hides the W5-58 strict text-rejection convention.
- Recommendation: Update the SUM/AVERAGE/MIN/MAX/PRODUCT and coverage-tracking notes to state the actual rule: blanks skip, errors propagate, booleans coerce 1/0, text rejects with `#VALUE!` for the strict aggregate path. Keep SUMPRODUCT and paired-array functions separate because they intentionally use more lenient non-numeric handling.
- Severity rationale: The implementation may be intentional, but the compatibility matrix currently communicates a different contract. That makes downstream audits of SUBTOTAL and aggregate inheritance unreliable.

### MEDIUM-003

- ID: MEDIUM-003
- Subject: The `is_aggregate_function` invariant test is one-sided and cannot catch missing range-aware admissions.
- Where: `crates/ql-exec/src/workbook_runtime.rs:5158`, `crates/ql-exec/src/workbook_runtime.rs:5175`, `crates/ql-exec/src/workbook_runtime.rs:5208`
- Detail: The invariant test checks that every hardcoded name listed in `is_aggregate_function` is registered. It does not check the inverse: every registered range-aware function requiring range args must be admitted. That is why HIGH-001 can exist while the invariant still passes. The process docs describe this matcher as a sync point, but the current test only prevents stale extra names, not missing names.
- Recommendation: Add a registry-derived completeness assertion. If the registry cannot distinguish range-aware functions that require range args from those that accept scalars, add metadata or an explicit expected set in the test and fail on omissions. Rename the test or split it into `admitted_names_are_registered` and `range_aware_names_are_admitted` so the invariant matches the real contract.
- Severity rationale: This is a test-system gap that allowed a broad binder regression across many shipped functions. It is not itself the runtime failure, but it prevents the suite from guarding the runtime failure.

## LOW

### LOW-001

- ID: LOW-001
- Subject: The Phase 4.10 MASTER-PLAN ship marker is stale/incomplete.
- Where: `docs/MASTER-PLAN.md:503`
- Detail: The status line says Phase 4.10 shipped through HEAD `517bcab08b7`, but the audited HEAD and the user-provided ship marker are `5d117724f27`. The same line says the closeout audits caught `5 HIGH + 10 MEDIUM + 20 LOW`; the prompt's closeout rollup is Codex `1H/2M/7L` plus Opus `5H/10M/20L`, which totals `6H/12M/27L` if both streams are being summarized. It also says the W5-D glob has 12 transcripts, but the actual `docs/audits/2026-05-17-w5-d-*.md` count is 24 files because each of the 12 batches has Codex and Opus transcripts.
- Recommendation: Update the status marker to `5d117724f27`, clarify whether issue totals are Opus-only or combined Codex+Opus, and change the audit-trail count to 24 transcript files or 12 batch pairs.
- Severity rationale: Planning documentation is stale, but the registry count, matrix coverage, and git log shape are otherwise verifiable.

## Verified Non-Findings

- Registry/matrix/coverage three-way drift: no drift found for registered Phase 4.10 functions. `default_registry_has_expected_count` and `coverage` pass, and a registry-vs-matrix scan found no registered function missing from `docs/compat/excel-matrix.md`.
- Coverage script: `scripts/report-compat-coverage.sh` confirms the claimed 80% matrix coverage.
- W5-D audit trail: git log shows W5-D-1 through W5-D-12 ship/audit commit pairs, and the audit docs glob contains Codex + Opus files for all 12 batches.
- Cross-cutting lexer tests requested in the prompt now exist for the exact W5-D-2 and W5-D-9 extensions: dotted digit-leading names around `crates/ql-formula-syntax/src/lexer.rs:1907` and letters-digits-letters names around `crates/ql-formula-syntax/src/lexer.rs:2030`. HIGH-002 is a different trailing-digit pattern not covered by those tests.
- NaN-to-integer casts in the W5-D-9/W5-D-11/W5-D-12 hot spots look safe: percentile kernels reject NaN through range `contains` before `as usize` at `crates/ql-functions/src/range_fns.rs:1707` and `crates/ql-functions/src/range_fns.rs:1732`; `extract_quartile_q` has an explicit NaN guard at `crates/ql-functions/src/range_fns.rs:1771`; `SUBTOTAL` guards NaN before `as i64` at `crates/ql-functions/src/range_fns.rs:1982`; `parse_places_arg` and DEC2 input collection go through `to_number_strict` before casts at `crates/ql-functions/src/scalar_fns.rs:3480` and `crates/ql-functions/src/scalar_fns.rs:3494`; discrete distribution indexes explicitly reject NaN at `crates/ql-functions/src/distribution_fns.rs:338`.
- Distribution corner probes outside HIGH-003 did not reveal additional panics/hangs: BINOM, NEGBINOM, POISSON, LOGNORM, BETA, F, T, and CHISQ boundary cases returned finite values or defensible `#NUM!` errors.
