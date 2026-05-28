# Phase 6.4 — Python UDFs (the wedge) · Entry Plan

**Status:** ✅ SCOPED 2026-05-28. Ready to launch in a fresh session.
**Predecessor:** 6.4-0 function-metadata substrate SHIPPED (engine commits `ac20a432c63` substrate + `63592126afe` audit-fix + `ba9278bc85f` doc-sync). Synthesis `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md`.
**Mandate:** Decision-lock §2 item 6 — the wedge feature for Phase 6 (and for Quantbook as a product). UDFs prove out the binding-neutral session contract under a real out-of-process workload, validate the function-metadata substrate end-to-end, and let users register Python functions that participate **correctly in the graph** (i.e., not bypassing it).

## 1. Why a dedicated session

6.4 introduces a new out-of-process runtime (Python worker), a new dispatch tier (`FunctionImplHandle`), and the first user-facing UDF API (`qb.register_formula_function` / `qb.show` / `qb.publish` / `qb.bind`). The cross-cutting surface is **substantial** — engine (`ql-functions` + `ql-exec` + `ql-session` + `ql-bindings-node`) + the new `quantbook-py` crate + worker-process lifecycle + Arrow exchange + debugpy + the IDE-side trusted-workspace flow. Auditor independence + a clean context are load-bearing.

6.4 is the **first** Phase-6 increment that:
- Adds a new EngineSession trait method that actually does work over napi (`register_function` / `unregister_function` / `list_functions`).
- Introduces hard-cancel semantics (worker-kill; contract §6.2).
- Exchanges Arrow batches across the FFI boundary.
- Touches both repos (engine + IDE) for a single end-to-end feature.

Expect 2-3 sub-increments + a closing megaudit (3-way: Codex + Opus + IDE-aware Opus lane, per the 6.1C lesson that cross-repo features need a dedicated cross-cutting reviewer).

## 2. Block-on-entry must-fix (carryover from 6.4-0 audit)

These are the two HIGH findings from the 6.4-0 substrate audit that were **filed** rather than closed; they MUST be closed before 6.4 ships UDFs.

### H1 — Migrate `plan.rs` binder whitelists to registry metadata

**Why:** the substrate replaced the two hardcoded whitelists in `calcgraph_session.rs` (`is_volatile_function` `:149-164`, `is_address_only_reference_fn` `:201-203`). But `ql-exec::plan` carries **two more** hardcoded `matches!` whitelists that drive the binder's `arg_ctx` decision:

- `is_aggregate_function` (`plan.rs:406-505`, ~100 entries)
- `is_reference_aware_function` (`plan.rs:566-571`, 7 entries)

UDFs with range args (every `BatchShape::ArrayBatch` UDF per `function_meta.rs:64-67` — i.e., every Python UDF taking a column / range argument) won't bind until the binder consults registry metadata instead of the hardcoded matchers. The substrate is honestly "two-thirds of the UDF prerequisite"; H1 is the missing third.

**Closure shape:**
1. Thread `&FunctionRegistry` into `bind_with_site` / `bind_with_context_v2` (already trivial — `Workbook` is already threaded; add the registry as a sibling parameter).
2. Replace `is_aggregate_function(name)` with `registry.metadata(name).map_or(false, |m| matches!(m.batch_shape, BatchShape::ArrayBatch | …))`. (Or introduce a derived `is_aggregate` predicate on `FunctionMetadata`; the precise shape is a design call — `BatchShape::ArrayBatch` covers UDFs cleanly but the prior whitelist's specific names like `SUMIF`/`VLOOKUP`/etc. straddle range-aware + array tiers.)
3. Replace `is_reference_aware_function(name)` with `registry.metadata(name).map_or(false, |m| matches!(m.dep_shape, DepShape::AddressOnly | DepShape::LazyShape))` — pairs with I1 below.
4. Keep the prior `matches!` constants temporarily as a **fall-back lookup** for unknown names (every dispatched builtin already has metadata per the migration-shim invariant; this fall-back is dead code for builtins but documents the migration), OR remove them entirely and trust the registry. Document the choice.
5. Tests: pin a UDF-style metadata entry that registers as `BatchShape::ArrayBatch + DepShape::ValueDeps` (or `AddressOnly`) and verify the binder routes its args correctly.

**Estimate:** 1-2 hours straight code + clippy clean + audit. Doable in cycle 1.

### H3 — Close the re-extraction gap (PlanCache `fn_gen` OR orchestrator `reextract_deps`)

**Why:** the 6.4-0 substrate `on_function_registered` / `on_function_unregistered` hooks dirty + transitive-fan but DO NOT re-extract deps. The contract §10.3 says register / unregister "dirties every formula referencing that canonical name (**re-extract deps** + reschedule)." The substrate satisfies the "dirty + reschedule" halves; "re-extract deps" lands at the 6.4 layer.

Concrete failure mode: formula `=MYUDF(A1)` binds while MYUDF is unknown → `deps.is_volatile = false` (cached). `register_metadata(MYUDF { volatility: Volatile })` succeeds; `on_function_registered("MYUDF")` dirties. `recompute_dirty` re-evaluates from the cached `ExprPlan` + cached `FormulaDeps`. Result is recorded; dirty cleared. User presses F9 → `mark_volatile_dirty()` walks `self.volatile_formulas` → MYUDF caller is NOT there → not recomputed. **Silent volatility miss.**

**Closure option A (recommended — `fn_gen` counter on PlanCache):**
- Add `fn_gen: u64` to `PlanCacheKey` (mirror `name_gen` at `crates/ql-exec/src/plan_cache.rs:69-74`).
- `FunctionRegistry::register_metadata` / `unregister_metadata` bump a generation counter; `WorkbookSession` reads it when computing the cache key.
- Plan-cache misses on `(text, sheet, name_gen, fn_gen, cell_anchor)` trigger re-bind → re-extract → fresh `FormulaDeps` with current registry metadata.
- Pros: zero changes to `CalcgraphSession` hooks; mirrors the proven `name_gen` pattern; single new field.
- Cons: invalidates the WHOLE plan cache on every UDF register / unregister (coarse; matches `name_gen` though). The 5 call sites that pass `name_gen` to `PlanCacheKey` (`recompute.rs:532,738`, `cells.rs:116,521`, `tables.rs:825`) each gain a `fn_gen` argument.

**Closure option B (more invasive — orchestrator `reextract_deps`):**
- `WorkbookSession::register_function(meta, handle)` flow:
  1. `self.registry.register_metadata(meta)?`.
  2. Look up dependents via `self.graph.functions_used_for(&meta.canonical_name)`.
  3. For each dependent NodeId, look up its cached `ExprPlan` from `self.plan_cache`, then call `self.graph.reextract_deps(node, &cached_plan, &self.workbook, &self.registry)`.
  4. `self.graph.on_function_registered(&meta.canonical_name)` to dirty + fan.
- Pros: surgical (only affected formulas re-extract).
- Cons: requires PlanCache integration in the orchestrator; threads more refs.

**Recommendation:** Option A. Simpler, mirrors an established pattern, makes the next iteration easier to reason about.

**Estimate:** 1-2 hours code + clippy clean + audit. Doable in cycle 1.

## 3. Sub-increment sequence

Recommended order (each its own audit cycle if substantial):

### 6.4-1 — Block-on-entry closures (H1 + H3)

Lands the two HIGHs above + the substrate-completion items from the synthesis: **M1** (`FormulaDeps::is_empty/len` API fix), **M3** (`iter_metadata` sort discipline), **M5** (`FunctionRegistryError → EngineError` mapper + Appendix A rows), **I1** (`DepShape::LazyShape` for ISREF; pairs with H1's reference-aware migration), **I2** (metadata-update atomicity docs). Optional: **L1** (walker hot-path `to_ascii_uppercase` allocation — add a `metadata_canonical(&str)` skip-uppercase variant).

Audit: 2-way Codex + Opus, same shape as 6.4-0.

### 6.4-2 — Engine trait wiring: `register_function` / `unregister_function` / `list_functions`

- Implement the three trait methods on `WorkbookSession` (currently `not_implemented_in_v1_core` per `crates/ql-exec/src/session.rs:~2392-2408`).
- Each method calls the substrate building blocks: registry's `register_metadata` / `unregister_metadata` / `iter_metadata` + calcgraph's `on_function_(un)registered` + plan cache's `fn_gen` bump (option A from H3).
- `register_function` accepts `(FunctionMetadata, FunctionImplHandle)`. `FunctionImplHandle(u64)` is opaque; the storage shape is TBD — likely a `HashMap<String, FunctionImplHandle>` on `FunctionRegistry` parallel to `metadata`, populated only for UDFs (built-ins have no handle).
- Surface the methods over napi (extends the Session class beyond its 11-method 6.1C surface).
- Update IDE `parseQuantbookError` allowlist to recognize `function_exists` / `function_not_found` codes.

### 6.4-3 — Python worker + Arrow exchange + debugpy

The most substantial sub-increment. New `quantbook-py` crate; managed Python WORKER process (separate-process so kill is hard-cancel per contract §6.2); Arrow batch IPC; debugpy attach. UDF dispatch routes from `RegisteredFn::Udf(FunctionImplHandle)` → worker call → Arrow batch return → `FunctionReturn::Scalar | Array`.

Audit: 3-way (Codex + Opus engine + Opus IDE/cross-repo). 6.4-3 is the first cross-repo feature in Phase 6; the IDE-aware lane is the 6.1C-confirmed pattern for catching cross-cutting issues.

### 6.4-4 — Exit-tests + closure megaudit

Contract §10.4 exit tests (1–8) must pass. Tests:
1. Pure UDF recomputes on referenced-input change.
2. Pure UDF does NOT recompute on unrelated edit.
3. Volatile UDF recomputes on recalc / volatile pass.
4. `publish` dirties dependents.
5. `BoundFrame` overlay edit dirties bound-range formulas.
6. Canceled / timed-out UDF does not commit a late result.
7. Failed UDF → deterministic `CellDiagnostic`.
8. (Substrate-foundation-level test already passing in 6.4-0; this is the end-to-end version through the trait method.)

Plus security exit tests: trusted-workspace gating, no untrusted-Python file write, worker kill leaves the engine in a usable state (FaultGuard discipline preserved). Audit: 5-way megaudit (4 Codex + Opus orchestration). 6.4 is a phase-level closure for the UDF wedge.

## 4. Out of scope (defer)

- **`qb.show`-only-rendering path** beyond the basic `register_formula_function` flow — `qb.show` decoration without registration lands as polish in 6.4.5.
- **SQL surface** — Phase 6.5.
- **`=AI()` cell function** — Phase 6.6.
- **Service mode (HTTP/gRPC) UDF wire-protocol** — Phase 6.2 (post-6.4).
- **WASM binding of `register_function`** — Phase 6.3 (the broader binding work; UDF support in WASM may itself be Phase 6.3+ since browser sandboxing changes the worker model).

## 5. Dependencies

- ✅ 6.4-0 substrate (this prereq landed at engine commit `ac20a432c63` + audit-fix `63592126afe`).
- ✅ 6.1A session contract `docs/api/session-api.md` v2.
- ✅ 6.1B owning WorkbookSession over napi (`Session` class + Node-side migration).
- ✅ 6.1C foundation audit (SHIP-WITH-FIXES; 11-method napi surface verified clean).

## 6. Sequencing notes

- Cycle budget: each sub-increment runs ≤2 plan-implement-audit cycles per session (CLAUDE.md). 6.4-1 + 6.4-2 can each ship in one session; 6.4-3 will likely take 2-3 sessions.
- Audit pattern: 2-way (Codex + Opus) for steps; 3-way for cross-repo features; 5-way megaudit at phase closure. 6.4-0 confirmed the 2-way pattern catches HIGH findings invisible to a single lane (Opus surfaced 3 net-new HIGH findings the Codex lane missed).
- Doc-sync as a separate commit per increment (matches the 6.1C + 6.4-0 pattern).

## 7. Reading list (start-of-session)

1. `docs/api/session-api.md` §10 (function metadata & graph-invalidation contract — fully).
2. `docs/audits/2026-05-28-6-4-0-substrate-audit/SYNTHESIS.md` (the substrate audit + the H1/H3 dispositions in detail).
3. `crates/ql-functions/src/registry.rs` (the metadata API — `register_metadata` / `metadata` / `iter_metadata`; `register_builtin_metadata` for the boot-time pattern).
4. `crates/ql-exec/src/calcgraph_session.rs:~440-490` (the `CalcgraphSession` reverse-index pattern — for H3 orchestrator if option B) and `:~1238-1340` (the hooks themselves).
5. `crates/ql-exec/src/plan.rs:~406-505 + :~566-571` (the H1 whitelists to migrate).
6. `crates/ql-exec/src/plan_cache.rs:~69-74` (the `name_gen` pattern for H3 option A).
7. `crates/ql-session/src/session.rs:~279-287` (the trait method signatures for 6.4-2).
8. The IDE side: `extensions/quantlab/src/quantbook/session.ts` (where `parseQuantbookError`'s allowlist lives — see the 6.1C carryover H1).

## 8. First commands

```sh
# Confirm engine + IDE HEAD
mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && git log --oneline -3'
# expect: ba9278bc85f (6.4-0 doc-sync) ← 63592126afe (6.4-0 audit-fix) ← ac20a432c63 (6.4-0 substrate)
mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab && git log --oneline -1'
# expect: c24222315ed (6.1B IDE Node migration; unchanged since)

# Sanity: substrate tests still green
mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  $HOME/.cargo/bin/cargo test -p ql-exec --lib && \
  $HOME/.cargo/bin/cargo test -p ql-functions --lib && \
  node crates/ql-bindings-node/tests/smoke_session.mjs'

# Then START 6.4-1 (H1 + H3 + the M/I substrate-completion items).
```
