# Phase 6.4-1 substrate-completion audit — Codex lane brief

**Date:** 2026-05-28.
**Reviewer:** Codex (`gpt-5.5 xhigh`, `codex exec -s read-only`).
**Engine HEAD at audit:** `1a7dfee12b0` (cycle 1 — code).
**Parent:** `fdbccb704f7` (6.4-0 doc-sync; pre-6.4-1 state).
**Cycle:** 2 (audit + audit-fix). Cycle 1 was the code ship at `1a7dfee12b0` (+1095/-348 across 21 files in 3 crates).
**Audit pattern:** parallel 2-way (Codex + Opus reviewer agent). 2-way (not 5-way megaudit) is the right size for substrate-completion work per audit-discipline memory rule 2 — no Send/Sync changes, no FFI surface beyond a closed-enum mapper, no IO, no cross-repo.

## 1. What 6.4-1 cycle 1 shipped (the audit subject)

Cycle 1 batched **two HIGHs (H1, H3)** from the 6.4-0 substrate audit (filed as block-on-6.4-entry must-fix) + **five filed substrate-completion items (M1, M3, M5, I1, I2)** into a single commit. See the 6.4-0 SYNTHESIS at `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md` for the dispositions that landed here.

### H1 — `plan.rs` binder whitelists → registry metadata

Pre-6.4-1 (state at parent `fdbccb704f7`):
- `crates/ql-exec/src/plan.rs::is_aggregate_function` (`:406-505`, ~66-entry hardcoded `matches!`) drove the binder's `BindContext::AggregateArg` admission.
- `crates/ql-exec/src/plan.rs::is_reference_aware_function` (`:566-571`, 7-entry hardcoded `matches!`: ROW / COLUMN / ROWS / COLUMNS / ISREF / ISFORMULA / FORMULATEXT) drove `BindContext::ReferenceArg`.

6.4-1 cycle 1 changes:
1. **New `ArgContext` axis on `FunctionMetadata`** at `crates/ql-session/src/function_meta.rs` (the docstring claims it's distinct from `BatchShape` — the eval-time call ABI — because builtin aggregates remain `BatchShape::Scalar` per-cell-called but admit range args at bind time). Three variants: `Scalar` (default) / `Aggregate` / `Reference`. `#[serde(default)]` for forward-compat with v0 wire bytes.
2. **`register_builtin_metadata` Phase 1 + Phase 1.5 in `crates/ql-functions/src/registry.rs`:**
   - Phase 1 sets `arg_context: Reference` for the 7 reference-aware names (ROW / COLUMN / ROWS / COLUMNS / ISREF / ISFORMULA / FORMULATEXT). ISREF's `dep_shape` ALSO moves to `LazyShape` (I1 closure below).
   - **Phase 1.5 (new)** sets `arg_context: Aggregate` for ~66 aggregate / range-aware / array-tier / financial / statistical / lookup / order-stats names. The claim — and this is the single load-bearing claim of cycle 1 — is that the Phase 1.5 list **mirrors the pre-6.4-1 `is_aggregate_function` `matches!` whitelist BYTE-FOR-BYTE**.
3. **`is_aggregate_function` and `is_reference_aware_function` drop their hardcoded `matches!`** and instead read `registry.metadata(name).arg_context`. Signatures change from `(name: &str)` to `(registry: &FunctionRegistry, name: &str)`.
4. **`&FunctionRegistry` threaded through every binder entry point**: `bind` / `bind_with_names` / `bind_with_names_and_sheets` / `bind_with_site` / `bind_with_site_no_tables` / internal `bind_with_context_v2` / `bind_implicit_intersection`.
5. **Production callers thread `self.registry`:** `WorkbookSession` (session.rs ~`:618`, `:1361`), `WorkbookTransaction` (transaction.rs `:225`), `WorkbookRuntime` (cells.rs `:141`, `:552`; recompute.rs `:579`, `:801`; tables.rs `:853`; validate.rs `:87`), `CalcgraphSession::bind_text` (`crates/ql-exec/src/calcgraph_session.rs:~1204-1222` + the on_set_formula caller `:1161`).
6. **Tests use a shared `LazyLock<FunctionRegistry>` via `ql_functions::default_registry`** — see `TEST_REGISTRY` static in `plan.rs::tests`, `scalar.rs::tests`, `workbook_runtime/{recompute,validate}.rs::tests`. Integration tests in `crates/ql-exec/tests/*.rs` use a per-test `let reg = default_registry();` (~50+ test sites updated).

### H3 — PlanCache `fn_gen` counter (option A from 6.4-0 entry plan)

Pre-6.4-1: PlanCache was invalidated only by `name_gen` (the `NameTable` generation counter at `crates/ql-storage`); UDF metadata mutations had no cache-invalidation channel.

6.4-1 cycle 1 changes:
1. **`FunctionRegistry` gains `fn_gen: u64`** field + `fn_generation()` reader at `crates/ql-functions/src/registry.rs`.
2. **`register_metadata` + `unregister_metadata` bump on success-only** via `saturating_add(1)`. **Conflict** (duplicate canonical name; OR the 6.4-0 audit-fix's builtin-guard "you can't unregister a built-in" sense) **and NotFound** failures leave the counter untouched (metadata table unchanged → cache stays valid).
3. **`PlanCacheKey` gains `fn_gen: u64`** between `name_gen` and `cell_anchor` at `crates/ql-exec/src/plan_cache.rs`.
4. **Five production call sites read `self.registry.fn_generation()` alongside `self.workbook.names().generation()`:** `cells.rs:116`, `cells.rs:521`, `recompute.rs:547`, `recompute.rs:753`, `tables.rs:825`. (Approximate line numbers from current_work.md; verify at source.)
5. The H3 closure means: 6.4-0 hooks `on_function_registered` / `on_function_unregistered` dirty + reschedule; H3 invalidates the bind cache → next eval re-binds with current metadata → fresh `FormulaDeps` populates `volatile_formulas` / `functions_used` correctly. This closes contract §10.3's "re-extract deps" half (the substrate had the "dirty + reschedule" halves).

### I1 — `DepShape::LazyShape` for ISREF

Pre-6.4-1: `crates/ql-exec/src/calcgraph_session.rs` walker carried a hardcoded `name.as_ref() == "ISREF"` short-circuit at the `ExprPlan::Function` arm — ISREF's metadata was `DepShape::AddressOnly`, but the walker treated it specially (skip arg walking entirely, no value-deps, no volatility propagation, no nested-fn recording).

6.4-1 cycle 1 changes:
1. **New `DepShape::LazyShape` variant** in `crates/ql-session/src/function_meta.rs`. Docstring claims: "the function never evaluates its arg — it inspects the syntactic shape via `materialize_ref_arg_lazy`. The walker MUST NOT recurse: `ISREF(NOW())` must not mark the formula volatile; `ISREF(A1+1)` must not register `A1` as a dep."
2. **ISREF's Phase 1 override** in `register_builtin_metadata` moves from `AddressOnly` to `LazyShape`. The other four address-only names (ROW / COLUMN / ROWS / COLUMNS) stay `AddressOnly`.
3. **New `is_lazy_shape_reference_fn(registry, name)` migration shim** in `calcgraph_session.rs`, parallel to the existing `is_address_only_reference_fn`. Walker's hardcoded short-circuit becomes `if is_lazy_shape_reference_fn(registry, name) { /* skip arg walk */ }` before the address-only branch.
4. **Behavior preservation** is the claim. Both `dep_suppressed_reference_fns_match_design` (in calcgraph_session.rs tests) and `builtin_metadata_pins_prior_address_only_whitelist` (in registry.rs tests) updated for the ISREF move.

### I2 — Metadata-update atomicity policy docs

`crates/ql-session/src/function_meta.rs` module header documents the two-step v1 policy: clients MUST call `unregister_metadata(name)` then `register_metadata(new_meta)`. During the transient gap formulas referencing the UDF bind with `Volatility::Dynamic` (conservative default per contract §10.3); the binder's `arg_ctx` falls back to `Scalar` (range-arg calls surface `BindError::NamedRangeInScalarContext`). 6.4 may add `update_metadata` as a non-breaking superset.

### M1 — `FormulaDeps::is_empty/len` API widening

Pre-6.4-1: `FormulaDeps::is_empty/len` (`crates/ql-exec/src/calcgraph_session.rs`) only checked `cells + named_ranges` (2 of 6 tracked-dep fields). The 6.4-0 substrate audit-fix had widened the storage gate at `extract_and_register_deps` to a 5-clause `||`-chain papering over this.

6.4-1 cycle 1 changes:
1. **`FormulaDeps::is_empty/len` now span all 6 fields**: `cells + named_ranges + names + tables + functions_used + (1 if is_volatile)`.
2. **The 5-clause `||`-chain at `extract_and_register_deps` collapses to a single `!deps.is_empty()`** — see `calcgraph_session.rs:~1009-1014`.
3. Behavior preservation: the 6 widened fields exactly cover the 5 `||` clauses + the original `cells`/`named_ranges` pair.

### M3 — `sorted_metadata` view

New `FunctionRegistry::sorted_metadata()` returning `Vec<&FunctionMetadata>` sorted ascending by `canonical_name`. Mirrors the 6.1C H2 deterministic-ordering discipline (Vec wire-DTOs MUST be call-stable). The (forthcoming, 6.4-2) `EngineSession::list_functions` mapper reads it at the DTO seam. Existing `iter_metadata` retained (HashMap-arbitrary order — appropriate for internal invariant tests + the registry's own debug-build invariant test).

### M5 — `FunctionRegistryError → EngineError` mapper

New `map_function_registry_err` in `crates/ql-exec/src/session.rs` alongside `map_runtime_err` / `map_persistence_err` / `map_xlsx_err` / `map_csv_err`. Translates:
- `Conflict { name }` → `EngineError(Conflict, "function_exists")`
- `NotFound { name }` → `EngineError(NotFound, "function_not_found")`

Closed-enum exhaustive match (no `_ => unmapped_*` arm) — `FunctionRegistryError` is a 2-variant enum owned by us; adding a variant without a mapping should surface as a compile error. Marked `#[allow(dead_code)]` until 6.4-2 wires the trait methods.

### Tests

**4 new ql-functions tests in `crates/ql-functions/src/registry.rs::tests`:**
1. `sorted_metadata_is_deterministic_across_calls` (M3)
2. `isref_carries_lazy_shape_others_carry_address_only` (I1)
3. `arg_context_overrides_match_pre_6_4_1_whitelists` (H1 — pins all 7 Reference + 13-name Aggregate sample + 5 Scalar typo-guards)
4. `fn_gen_ticks_on_successful_register_and_unregister` (H3 — 4-step invariant: initial > 0 from boot, success bumps, Conflict no-bump, NotFound no-bump, builtin-guard Conflict no-bump)

**Extended tests:**
- `dep_suppressed_reference_fns_match_design` (calcgraph_session.rs) — pins LazyShape ≠ AddressOnly + ISREF specifically as LazyShape + the typo-guard NOT-LazyShape arm.
- `builtin_metadata_pins_prior_address_only_whitelist` (registry.rs) — updated for the ISREF → LazyShape move.

## 2. Test counts at audit

- `cargo test -p ql-exec --lib`: **742/0** (default + `--features xlsx-write`).
- `cargo test -p ql-exec --tests`: all integration suites green.
- `cargo test -p ql-functions --lib`: **1819/0** (1815 pre-6.4-1 + 4 new substrate-completion).
- `cargo check --workspace`: clean.
- `cargo clippy -p ql-functions -p ql-exec -p ql-session --all-targets`: clean for edits.
- `node crates/ql-bindings-node/tests/smoke_session.mjs`: PASS through a fresh-built 6.4-1 cdylib.

## 3. Audit asks — what to verify and pushback on

This is the focused list — every item has a load-bearing claim that the audit needs to either ratify at source OR catch as a defect.

### H1 verification (most critical — the byte-for-byte migration claim)

The single highest-risk claim is: **"Phase 1.5 (`register_builtin_metadata` in `crates/ql-functions/src/registry.rs`) covers every name that pre-6.4-1's `is_aggregate_function` `matches!` returned true for — byte-for-byte, no drift."**

Verify by:
1. Reading the pre-6.4-1 `is_aggregate_function` body at `fdbccb704f7^:crates/ql-exec/src/plan.rs:422-536` (the `matches!` arm list).
2. Reading the Phase 1.5 override loop at the current HEAD's `crates/ql-functions/src/registry.rs` (the `for name in [ ... ]` block that sets `arg_context: Aggregate`).
3. Diffing the two name sets. **Any drift is a HIGH finding** — silently dropping a name means the binder rejects range args for it (`BindError::NamedRangeInScalarContext` for `=DROPPED_FN(MyRange)`); silently adding a name relaxes the binder for an unintended fn.
4. Cross-check against the parallel `range_aware_names()` set (if one exists at `registry.rs`) — every range-aware name should also be in Phase 1.5 (range args required to bind).
5. Cross-check against the array-returning fn set (TRANSPOSE/FILTER) — these were in the pre-6.4-1 list because they accept range args (`W5-107 Phase 4.7.N` closure).

Other H1 verification:
- **`ArgContext` distinct-from-`BatchShape` rationale.** The cycle-1 docstring claims they're orthogonal (builtin aggregate SUM is `ArgContext::Aggregate` + `BatchShape::Scalar`; Python UDF taking a range is `ArgContext::Aggregate` + `BatchShape::ArrayBatch`). Verify this axis-orthogonality holds for every Phase 1.5 name + the existing `BatchShape` overrides — no name should silently flip `BatchShape` as a consequence.
- **Default for unknown names matches pre-6.4-1.** `ArgContext` default is `Scalar`. Pre-6.4-1 `is_aggregate_function` returned `false` for unknown names → `BindContext::Scalar`. Verify the migration: `registry.metadata(name).map_or(false, |m| m.arg_context == ArgContext::Aggregate)` for a NAME-NOT-IN-METADATA case behaves identically to the pre-6.4-1 `matches!` false case. This is what makes the migration safe for unknown UDF names that haven't yet registered.
- **`#[serde(default)]` on `arg_context` field.** Verify the wire-compat claim — a v0 wire byte with no `arg_context` key deserializes to `ArgContext::Scalar` (the conservative default).
- **Every binder entry-point propagates `registry`.** Read `bind_with_context_v2` and verify every recursive descent (binary lhs/rhs, unary, function args, array elements, structured refs, implicit-intersection unwrapping) carries `registry` forward — a single missed propagation breaks the metadata-derived path for some sub-expression.

### H3 verification

- **Bump-on-success-only invariant.** Verify at source: `register_metadata` returns Err BEFORE the `self.fn_gen = self.fn_gen.saturating_add(1)` line on Conflict; `unregister_metadata` returns Err BEFORE the bump on NotFound. Verify the builtin-guard Conflict path also returns BEFORE the bump (this is the most subtle of the three — the 6.4-0 audit-fix added the builtin-guard with its own early-return; the 6.4-1 cycle-1 bump must come AFTER both guards). The `fn_gen_ticks_on_successful_register_and_unregister` test claims to cover all 3 no-bump branches; verify at source.
- **PlanCacheKey ordering.** `fn_gen` lands between `name_gen` and `cell_anchor` in the struct definition. Verify the `Hash + Eq + PartialEq` derive picks it up; verify a Rust struct-equality semantic that requires all 5 fields to match for a cache hit; verify no other site silently strips `fn_gen` (e.g., a `Display` impl or a serde-flatten override that drops it).
- **Five production call sites — verify the registry-source.** The claim is `cells.rs:116, :521`, `recompute.rs:547, :753`, `tables.rs:825` all use `self.registry.fn_generation()`. **Verify the EXACT line numbers at source** (commit message line numbers can drift) and verify NONE of them silently fall back to a default registry. Also verify there are no OTHER `PlanCacheKey` construction sites you're missing — search for every `PlanCacheKey { text:` / `PlanCacheKey::new(` site in production code.
- **Cache-miss semantics on fn_gen bump.** Verify a unit test or design rationale that proves: bind plan P with `fn_gen=N`, register UDF (bumps to N+1), the cache lookup for the same text+sheet+name_gen MUST miss → re-bind → fresh deps. If there's no such test, file as MED.

### M1 verification

- **The 6 widened fields exactly cover the 5 `||` clauses + original (cells, named_ranges).** Read the pre-collapse storage gate at `fdbccb704f7^:calcgraph_session.rs` and the post-collapse `!deps.is_empty()` at current HEAD. Verify the 6 fields = `cells, named_ranges, names, tables, functions_used, is_volatile`. The volatile case is the subtle one — `usize::from(self.is_volatile)` is 1 if volatile, 0 if not. Verify this is correctly counted in `len()` AND `is_empty()` returns `false` when only `is_volatile` is true.
- **`is_empty()` honestly false for every non-trivial deps shape.** Construct mentally: `FormulaDeps { cells: empty, named_ranges: empty, names: ["X"], tables: empty, functions_used: empty, is_volatile: false }` — is_empty must return false; len must return 1.
- **No other `is_empty/len` callers exist.** Search the codebase for `FormulaDeps::is_empty` / `FormulaDeps::len` / `deps.is_empty()` / `deps.len()` and verify none of them have semantics that broke under the widening (e.g., a caller that previously meant "cells+named_ranges only" and now misbehaves with the wider semantic).
- **Storage-gate behavior parity.** For every shape `FormulaDeps` can take (cell-only, name-only, table-only, fn-only, volatile-only, mixed), verify the new `!deps.is_empty()` gate triggers storage insertion. The 6.4-0 substrate audit-fix's 5-clause chain was the source of truth; the 6.4-1 collapse must be behavior-identical.

### M3 verification

- **`sorted_metadata` sort is by `canonical_name` ascending.** Read source; verify the `sort_by(|a, b| a.canonical_name.cmp(&b.canonical_name))` semantic (no surprise reverse, no locale-aware Unicode collation that could be platform-dependent).
- **Determinism across calls.** Verify the test `sorted_metadata_is_deterministic_across_calls` actually asserts cross-call determinism (not just one call returning sorted output once).

### M5 verification

- **Closed-enum exhaustive match.** Verify `FunctionRegistryError` is a 2-variant enum (Conflict, NotFound) and the mapper handles both with NO `_ =>` fallback. Adding a 3rd variant later WITHOUT updating the mapper MUST be a compile error.
- **Appendix A wording.** Verify the EngineError codes are exactly `function_exists` and `function_not_found` (not `function_already_exists` / `function_missing` etc.). Cross-reference `docs/api/session-api.md` Appendix A for the established naming convention.
- **`#[allow(dead_code)]` justification.** The mapper is unused until 6.4-2 wires the trait methods. Verify the allow-attr is narrowly scoped (just the mapper function, not the whole module) and includes a comment pointing to its planned consumer.

### I1 verification

- **Walker behavior: `ISREF(NOW())`.** Verify at source that the walker's `ExprPlan::Function` arm now routes ISREF through `is_lazy_shape_reference_fn` BEFORE the address-only branch. Trace through what happens: ISREF's `is_lazy_shape_reference_fn` returns true → skip arg walk entirely → `NOW()` is NOT visited → `deps.is_volatile` stays false. **This is the critical behavior-preservation claim — pre-6.4-1 the hardcoded `name == "ISREF"` short-circuit had exactly this effect.**
- **Walker behavior: `ISREF(A1+1)`.** Same trace: LazyShape skip → `A1` is NOT visited → no value-dep on A1. Pre-6.4-1: identical behavior via the name short-circuit.
- **Walker behavior: `ISREF(A1)`.** Same trace: LazyShape skip → no value-dep on A1; ISREF's caller in scalar.rs handles the syntactic-shape inspection via `materialize_ref_arg_lazy`. Verify ISREF still evaluates correctly at eval time (the walker's dep-extraction is orthogonal to eval).
- **AddressOnly batch preservation: ROW / COLUMN / ROWS / COLUMNS.** Verify each is `arg_context: Reference` AND `dep_shape: AddressOnly`. Verify the walker still treats them via the AddressOnly branch (not LazyShape) — they DO visit Binary / Unary / Function sub-trees per the `walk_plan_for_address_only_deps` semantic. `ROW(A1+1)` must keep A1's value-dep (the `+1` triggers eager materialization).
- **ISFORMULA / FORMULATEXT preservation.** These are `arg_context: Reference` AND `dep_shape: ValueDeps` (the default). Walker treats them with normal `ValueDeps` semantics — they DO record value-deps on their reference args (per design § 8 R8 — Eager + workbook query).
- **Migration-shim symmetry.** The 6.4-0 substrate's `is_address_only_reference_fn` migration shim still exists; the new `is_lazy_shape_reference_fn` is parallel. Verify the walker checks LazyShape FIRST, then AddressOnly — order matters because ISREF used to be in the AddressOnly set and is no longer. A mis-ordered check (AddressOnly first) would route ISREF to the wrong branch if ISREF were still in AddressOnly metadata; the I1 closure moves ISREF OUT of AddressOnly, so AddressOnly-first happens to also work, but LazyShape-first is the safer guard.

### I2 verification

- **Two-step policy is honestly documented.** Read the module-header documentation in `function_meta.rs`; verify the transient-window behavior is correctly described:
  - During the gap, the function name is unknown.
  - Formulas binding during the gap get `Volatility::Dynamic` (conservative; the metadata-derived `is_volatile_function` returns false for unknown names → BUT this is the BIND result; the EVAL of an unknown UDF surfaces `#NAME?`; the doc claim is about the GRAPH-VISIBILITY half).

Wait — read the docstring carefully. The claim is "formulas rebind with `Volatility::Dynamic`" — but `is_volatile_function(registry, name)` returns FALSE for an unknown name (no metadata), which is the OPPOSITE of Dynamic-conservative. Audit: is this a doc bug, or is "Volatility::Dynamic" the correct fallback at some other layer? If the binder's volatility decision for an unknown name is actually "not volatile" (matching the BindContext::Scalar conservative-rejection path), the doc needs correcting. Either way, surface this — file as either I2 fix or I2 doc-honesty correction.

### Tests verification

- **`arg_context_overrides_match_pre_6_4_1_whitelists`** — does the test enumerate EVERY name in Phase 1.5, or only a 13-name sample? A sample is acceptable IF the test rationale calls out that the byte-for-byte cross-check is enforced elsewhere (e.g., by the `is_aggregate_function_lists_only_registered_aggregates` invariant test that pre-6.4-1 existed in `workbook_runtime/validate.rs`). Verify what that pre-existing invariant test does and whether it still serves as the byte-for-byte cross-check.
- **`fn_gen_ticks_on_successful_register_and_unregister`** — verify the 4 no-bump branches it claims to cover:
  1. Successful `register_metadata` bumps.
  2. Successful `unregister_metadata` bumps.
  3. Failed `register_metadata` (Conflict) does NOT bump.
  4. Failed `unregister_metadata` (NotFound) does NOT bump.
  5. Failed `unregister_metadata` (builtin-guard Conflict) does NOT bump.
- **`isref_carries_lazy_shape_others_carry_address_only`** — pins the partition. Verify it covers the disjointness in BOTH directions (ROW/etc. NOT LazyShape; ISREF NOT AddressOnly).
- **`sorted_metadata_is_deterministic_across_calls`** — call it twice in a fresh process; assert identical sequences. Run-to-run determinism (across processes) is not testable in a single unit test; cycle-2 should call this out if the test only proves call-to-call.

### Cross-cutting / forward-compat

- **`bind` is the public bind entrypoint.** Its signature changed from `(expr, owning_sheet)` to `(expr, owning_sheet, registry: &FunctionRegistry)`. Verify:
  - Every IN-REPO caller of `bind` has been updated (benches/og04_scalar_1m.rs is one such caller per the commit message).
  - No CROSS-REPO caller depends on the old signature (IDE-side ql-bindings-node consumers; the IDE-side TypeScript callers).
  - Public API breakage is accepted because the engine is pre-1.0 + this is a substrate-completion change; flag if any external consumer was missed.
- **`EngineSession` trait surface.** The trait method `register_function` / `unregister_function` / `list_functions` was filed for 6.4-2. Verify the 6.4-1 cycle-1 commit does NOT accidentally start wiring them — substrate-completion scope means the mapper exists (as `dead_code`) but the trait methods stay `not_implemented`. Confirm no surprise activation.
- **No napi-visible surface change.** Verify the IDE's `parseQuantbookError` allowlist (the 6.1C carryover H1) is unaffected — no new error codes need to land at the IDE side for cycle 1's M5 mapper to be safe (because the mapper is dead-code until 6.4-2 wires the trait).
- **Send/Sync of new types.** `ArgContext` is `Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize` — verify Send + Sync hold (likely auto-derived; pin in test if not already). `DepShape::LazyShape` (new variant) — same. `FunctionRegistry.fn_gen: u64` — trivially Send + Sync. Per audit-discipline rule 4 (negative trait claims need positive proof), if the cycle-1 commit makes ANY negative trait claim, flag.
- **Cycle-1 commit message accuracy.** The cycle-1 commit message claims "ql-exec lib **742/0** (same count as 6.4-0 baseline because the I1 test reframing left the count steady)." Verify at source — the 6.4-0 baseline was 742, and 6.4-1 cycle 1 still reports 742 (not 743 or 744). Either the test framing did keep count steady, or new tests were added and old tests removed in equal measure. Verify which.

## 4. Verdict format

Issue a verdict matching the 6.4-0 SYNTHESIS template:

- **SHIP-WITH-FIXES** — cycle 1 is structurally sound; HIGH findings (if any) get FIXED in audit-fix OR FILED for 6.4-2 with explicit dispositions.
- **HOLD** — cycle 1 has a HIGH that requires the substrate-completion to be reworked, not just patched.

Include per-finding:
- # (e.g., H1, M2, L3, I1)
- Severity (HIGH / MED / LOW / INFO)
- Lane (Codex)
- Finding (concrete; one paragraph)
- Anchors (file:line)
- Proposed disposition (FIXED in audit-fix / FILED for 6.4-2 / VERIFIED / etc.)

Lane-output filename suggestion: `lane-codex.out` in this dir.

## 5. Working files

- `docs/audits/2026-05-28-6-4-1-substrate-completion-audit/codex-brief.md` (this file)
- `docs/audits/2026-05-28-6-4-1-substrate-completion-audit/lane-codex.out` (your output; write here)
- The 6.4-0 SYNTHESIS template: `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md`
- The 6.4-1 cycle-1 commit: `1a7dfee12b0`
- The pre-6.4-1 state: `fdbccb704f7^`

## 6. Reading list

1. `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md` — the audit format + the dispositions cycle 1 closes.
2. `docs/phase6/6-4-entry-plan.md` §2-3 — the entry-plan H1/H3 dispositions cycle 1 implements.
3. `crates/ql-session/src/function_meta.rs` — the new ArgContext + LazyShape + I2 docs.
4. `crates/ql-functions/src/registry.rs` — Phase 1 + Phase 1.5 overrides + fn_gen + sorted_metadata + 4 new tests.
5. `crates/ql-exec/src/plan.rs` — the migrated is_aggregate_function + is_reference_aware_function + binder threading.
6. `crates/ql-exec/src/calcgraph_session.rs` — walker LazyShape + is_lazy_shape_reference_fn + FormulaDeps API widening + storage-gate collapse.
7. `crates/ql-exec/src/plan_cache.rs` — PlanCacheKey.fn_gen.
8. `crates/ql-exec/src/session.rs` — map_function_registry_err.
9. Pre-6.4-1 state for diffing: `git show fdbccb704f7^:crates/ql-exec/src/plan.rs | sed -n '400,540p'` for the old is_aggregate_function body.

## 7. Don't-be-lazy reminder

This audit's #1 highest-value claim to attack is the H1 byte-for-byte migration. Don't accept the commit message's claim — diff the two lists by hand at source and surface any drift. The 6.4-0 audit's lesson was that Opus surfaced 2 net-new HIGHs the Codex lane missed because Codex's repo-scope didn't reach cross-cutting structural issues. **Cycle 2's Codex lane has an opportunity to make the reverse contribution** — close, deep, line-by-line examination of the binder migration that an LLM general-context review may miss.
