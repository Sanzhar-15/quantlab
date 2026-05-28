# Cycle-2 Adversarial Audit — Phase 6.4-2 — OPUS LANE (fresh-context general-purpose)

Engine commit `f8eeaaeadfe`, IDE `739b625b4fd`. Verdict: **SHIP-WITH-FIXES**.
Severity: HIGH 1 (H1) + 1 HIGH doc-honesty (H2, same root) · MED 3 (M1/M2/M3) · LOW 2 (L1/L2).

## H1 — HIGH · Scope 7+12 · registry.rs:357,361 / session.rs:296-333 / lib.rs:4747-4759
Lowercase or empty `canonical_name` to `Session.registerFunction` PANICS across the napi/FFI
boundary instead of returning `[bad_argument]`. `register_function` does not normalize/validate;
it calls `register_udf`→`register_metadata`, which `assert!`s non-empty (357) + ASCII-uppercase
(361). EMPIRICALLY CONFIRMED via catch_unwind probe: `register_function(lc_meta("mylowerudf"))`
and `(lc_meta(""))` both PANIC, not Err. Why it matters: (1) docstring lib.rs:4747-4751 FALSELY
claims this surfaces `[bad_argument]` — napi wraps the panic into a generic JS Error WITHOUT the
`[code]` prefix, so the IDE `parseQuantbookError` classifies it as `unknown`, breaking the wire
contract; (2) the panic fires while the FaultGuard is ARMED (before guard.armed=false) → Drop
seals the session Faulted (permanent) — one bad input bricks the session; (3) wholly untested
(smoke fixture uses only uppercase "MYUDF"). Fix: validate/normalize canonical_name at the trait
boundary, return bad_argument for empty/non-canonical; make the registry asserts the
unreachable-invariant they're documented as; add Rust + smoke tests; fix the docstring.

## H2 — HIGH (doc-honesty) · Scope 12 · lib.rs:4747-4751
Same root as H1, called out separately: the 6.4-1 audit graded exactly this class (docstring
overclaiming) HIGH. Doc asserts the panic is "wrapped" into `[bad_argument]`; it is not.

## M1 — MED · Scope 9 · session.rs register_function_dirties_dependent_formulas
False-positive test: asserts `#NAME?` before AND after + recalc Completed. A no-op recalc also
returns Completed and the value is identical by design. No assertion that B1 was dirtied. Would
pass even if register_function never called the graph hook. Mitigant: the property IS covered at
unit level by calcgraph_session.rs on_function_registered_dirties_formulas_that_named_the_function
(count==1, specific node dirty); only the TRAIT wire is unproven. Fix: assert observable dirtying
(dirty count ≥1, or fn_generation bumped through the trait, or a value that would differ).

## M2 — MED · Scope 9 · session.rs register_function_with_aggregate_arg_context_admits_named_range_args
Pre-registration `pre_rejected` accepts ANY error as proof of "rejected for unknown-function." Does
not assert the specific NamedRangeInScalarContext cause. Mitigant: the POSITIVE half (post-register
set_formula succeeds) is load-bearing and sound. Fix: assert the pre-registration error
specifically.

## M3 — MED (test-honesty) · session.rs register_function_duplicate_returns_conflict_function_exists
Inline comment claims the unregister→re-register-handle-2 dance "ensures the new (2) lands," but
the only assertion is one MYUDF metadata entry exists. list_functions returns METADATA, not
handles. Fix: expose a test accessor / assert s.registry.udf_handle("MYUDF")==Some(1) then Some(2).
Handle-landing IS covered at registry level (register_udf_inserts_metadata_and_handle_atomically),
so this is honesty not coverage.

## L1 — LOW · Scope 10 · no trait-level fn_gen bump-count test
Registry-level single-bump pinned; trait-level proxy weak per M1. Production H3 wire sound: all 5
key-mint sites read fn_generation() fresh; register bumps via register_udf→register_metadata
(success-only); NotFound/Conflict leave it untouched. Optional: fold into M1 fix.

## L2 — LOW · Scope 8 · lib.rs:4327-4365 arity_from_json
Not a strict tagged union: `{kind:"fixed",n:3,min:5}` ignores min; `{kind:"variadic",n:7}` ignores
n. No corruption (mapped value correct) but lenient where the rest is strict. Fix: reject
extraneous fields per kind. Low priority.

## Verified CLEAN
- Scope 2 (Arc::make_mut): CalcgraphSession holds NO Arc<FunctionRegistry> clone (takes
  &FunctionRegistry per-call); the 3 Arc::clone sites are short-lived locals in open/import
  consumed before return; &mut self + single-thread → strong_count==1 → no deep clone. Sound.
  [NOTE: Opus did NOT catch the F2 graph/registry-divergence at the open/import adoption sites —
  Codex caught that separately.]
- Scope 1 (case consistency): metadata, udf_handles, and the graph hook all key by the
  asserted-uppercase name; agree given valid input (invalid path = H1).
- Scope 3 (register_udf atomicity): Conflict short-circuits before udf_handles.insert; &mut self;
  register_udf_conflict_does_not_insert_handle pins it.
- Scope 4 (FaultGuard): disarms on Ok+Err; Drop seals only when armed; covers registry+graph
  window. (Panic-path interaction = H1.)
- Scope 5 (lifecycle gates): ensure_ready rejects Busy/New/Closed/Faulted; ensure_readable allows
  Ready/Busy. function_methods_respect_lifecycle_gate covers Closed.
- Scope 6 (symmetric handle clearing): udf_handles.remove(upper) on success branch only, after
  builtin-guard, same key. Pinned.
- Scope 7 (enum mappers): all 6 pairs exhaustive + inverse vs engine enums + snake_case serde;
  unknown→bad_argument; aliases in DTO+both mappers.
- Scope 8 (ArityJson): u32→u8 fails loud >255; u8→u32 lossless; Range{max:None} round-trips;
  missing n/min rejected; BigInt sign+lossless checks fire.
- Scope 11 (No-Fallbacks): no swallowing; the one ignored Option (udf_handles.remove return) is
  documented-intentional and sound.
- IDE cross-repo: both codes in QuantbookErrorCode union (types.ts:1586-1587) AND
  KNOWN_QUANTBOOK_ERROR_CODE_RECORD (session.ts:799-800); ALL_QUANTBOOK_ERROR_CODES derives from
  the Record (no drift); engine emits `[function_exists]`/`[function_not_found]` via EngineError
  Display (`[{code}] {message}`); IDE regex matches; tsc --noEmit clean; map_function_registry_err
  exhaustive over the closed enum.
- Build/tests GREEN: cargo test -p ql-exec --lib function → 45 passed.
