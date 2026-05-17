# Codex Audit: RT-V1-01 Step 4 FORMULATEXT

Scope: Step 4 working-tree implementation of FORMULATEXT.

Verification run:

- `cargo test -p ql-exec --test reference_fns_step4_e2e` -> 16 passed
- `cargo test -p ql-functions formulatext` -> 9 passed

## Findings

### HIGH-S4-1

Subject: FORMULATEXT self-reference has the same producer/replay divergence as ISFORMULA, but Step 4 does not pin or document it

Where:

- `crates/ql-exec/src/workbook_runtime.rs:735`
- `crates/ql-exec/src/workbook_runtime.rs:775`
- `crates/ql-oplog/src/replay.rs:323`
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:51`

Detail:

All Step 4 happy-path tests install formula metadata up front via `Workbook::put_formula`, so they exercise the replay/storage shape, not the user-facing producer ordering. `WorkbookRuntime::set_formula` evaluates the new formula at `workbook_runtime.rs:735` before it installs the new formula text at `workbook_runtime.rs:775`. Therefore `set_formula(A1, "FORMULATEXT(A1)")` evaluates against a workbook where A1's new formula text is not yet visible: `ReferenceQuery::formula_text_at(A1)` returns `None` and FORMULATEXT returns `#N/A` (or the old formula text on rewrites).

Replay does the opposite. `Op::PutFormula` installs formula text directly at `ql-oplog/src/replay.rs:323`, and post-replay recompute evaluates with formula metadata already present. The same formula then returns `=FORMULATEXT(A1)`. Step 3 pinned this class for ISFORMULA only, and even that pin documents that the replay half is still missing. Step 4 has no FORMULATEXT analogue.

Recommendation:

Either fix `set_formula` evaluation ordering with a pending-formula overlay / pre-install-with-rollback model, or explicitly accept this as a v1 divergence and add FORMULATEXT pinning tests for both producer-side and replay-side behavior. The Step 4 audit prompt specifically called out that the S3-HIGH-5 lesson applies here; it should be captured before the mini-phase ships.

Severity rationale:

HIGH because this is likely incorrect user-visible output and a producer/replay equivalence break for a valid FORMULATEXT formula. It is not just a missing edge-case test; the current production path and replay path can persist different computed values.

### MEDIUM-S4-1

Subject: Design still says `FORMULATEXT(SUM(A1:A3))` returns `#N/A`, while the shipped v1 behavior bind-fails

Where:

- `docs/architecture/2026-05-17-reference-tier-design.md:130`
- `crates/ql-functions/src/reference_fns.rs:292`
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:279`

Detail:

The implementation and Step 4 e2e test correctly pin the v1 scope: `FORMULATEXT(SUM(A1:A3))` bind-fails because AggregateArg-side literal `RangeRef` lowering remains deferred. The architecture doc still lists the case under FORMULATEXT canon as `#N/A`. The cumulative audit summary already warned that the S2-HIGH-3 binder gap affects the Step 4 example too, but the design doc was not updated for FORMULATEXT.

Recommendation:

Update design §2.5 (and any related coverage/canon table if intended) to say the literal-range nested `SUM(A1:A3)` form bind-fails in RT-V1, while the named-range form (`SUM(NamedRange)`) evaluates eagerly and reaches FORMULATEXT as a scalar, returning `#N/A`.

Severity rationale:

MEDIUM because the implementation is intentionally pinned, but the design remains a false contract for a named FORMULATEXT case. This is exactly the class of design/implementation drift that prior audit cycles required closing before ship.

### LOW-S4-1

Subject: Excel matrix undercounts Step 4 e2e coverage

Where:

- `docs/compat/excel-matrix.md:243`
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:51`

Detail:

The matrix says FORMULATEXT has `9+14 e2e` tests, but the focused test run reports 16 tests in `reference_fns_step4_e2e.rs`. Together with the 9 ql-functions unit tests, the Step 4 delta is 25, matching the stated repository count increase.

Recommendation:

Change the matrix count to `9+16 e2e`.

Severity rationale:

LOW because behavior is unaffected, but the compatibility matrix is meant to be an audit-facing source of truth.

### LOW-S4-2

Subject: `reference_fns.rs` module docs are stale after Step 4

Where:

- `crates/ql-functions/src/reference_fns.rs:8`
- `crates/ql-functions/src/reference_fns.rs:20`
- `crates/ql-functions/src/reference_fns.rs:23`
- `crates/ql-functions/src/reference_fns.rs:292`
- `crates/ql-functions/src/reference_fns.rs:938`

Detail:

The file header says Step 4 FORMULATEXT is "Pending" even though it is implemented and registered. The v1 recap says only ISFORMULA returns `#N/A` for non-reference args and omits FORMULATEXT from the arity-mismatch bullet. The FORMULATEXT doc-comment also says the `SUM(A1:A3)` bind-fail is pinned in `reference_fns_step3_e2e`, while the actual Step 4 pin is in `reference_fns_step4_e2e.rs`.

Recommendation:

Refresh the module header and recap bullets to include FORMULATEXT as shipped, and fix the stale test-file reference.

Severity rationale:

LOW because the implementation is correct in these spots, but the module-level docs are the first place future maintainers will look when extending this tier.

### LOW-S4-3

Subject: Step 4 e2e comments overclaim canonicalization and misdescribe the error literal

Where:

- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:78`
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:91`
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:205`
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs:209`

Detail:

`formulatext_of_complex_formula_returns_canonical_text` uses low-level `Workbook::put_formula`, and the test comment correctly admits storage does not canonicalize. The test name and assertion only prove "stored text + leading `=`", not runtime canonicalization. Separately, the cell-with-error test comment says the cell holds literal `#N/A`, but the code writes `ErrorValue::DivZero`; the behavior being tested is still useful (`#DIV/0!` must not propagate), but the comment is inaccurate.

Recommendation:

Rename or reword the complex-formula test to avoid implying runtime canonicalization coverage, and update the error-value comment to match `ErrorValue::DivZero`.

Severity rationale:

LOW because these are test-documentation issues, not behavioral failures.

### LOW-S4-4

Subject: Active plan still shows Phase 4 incomplete

Where:

- `.plans/_active.md:104`
- `.plans/_active.md:108`

Detail:

The active plan's Phase 4 checklist still has FORMULATEXT implementation, tests, count bump, e2e, matrix, and audit unchecked even though the working tree implements and tests them. Since this is the final implementation audit cycle before shipping the mini-phase, stale plan state makes closure status ambiguous.

Recommendation:

After addressing audit findings, update the Phase 4 checklist to reflect the implemented items and leave only audit/closure items open if that is the intended state.

Severity rationale:

LOW because code behavior is unaffected, but this is process/documentation drift in the plan the audit was asked to read.

### LOW-S4-5

Subject: Architecture ABI text still describes `RefArg::Reference` as carrying a value

Where:

- `docs/architecture/2026-05-17-reference-tier-design.md:253`
- `crates/ql-functions/src/reference_aware_fns.rs:53`

Detail:

The design still says `Reference { address, value }`, but the Step 3.1 closure removed the value field so the CellRef materializer no longer reads cell values. The code-side ABI documentation is now correct and explicitly says `Reference { address }` only; the architecture doc is stale.

Recommendation:

Update the design ABI section to match the post-S3-HIGH-1 shape and mention that ISFORMULA/FORMULATEXT query storage through `ReferenceQuery` rather than relying on a carried value.

Severity rationale:

LOW because the shipped code has the correct ABI, but the architecture doc is now misleading for future reference-tier work.
