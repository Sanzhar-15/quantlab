# Phase 6.4-1 cycle 1 substrate-completion audit — Opus reviewer lane

**Date:** 2026-05-28
**Reviewer:** Opus reviewer (general-purpose agent, 1M-context)
**Engine HEAD at audit:** `1a7dfee12b0` (cycle 1 — code)
**Parent (pre-6.4-1):** `fdbccb704f7`
**Cycle:** 2 (audit + audit-fix). Cycle 1 was the code ship at `1a7dfee12b0` (+1095/-348 across 21 files in 3 crates).
**Audit pattern:** parallel 2-way (Codex `gpt-5.5 xhigh` + this Opus reviewer lane). 2-way is the right size for substrate-completion work — no Send/Sync changes, no FFI surface beyond a closed-enum mapper, no IO, no cross-repo.

## Verdict: **SHIP-WITH-FIXES**

Cycle 1 is structurally sound. The H1 byte-for-byte migration is verified at source (66/66 names match). H3 invariants hold: bump-on-success-only at both registration paths, all 5 production `PlanCacheKey` constructors thread `self.registry.fn_generation()`, `PlanCacheKey` derives `Hash + Eq + PartialEq` which include the new `fn_gen` field. M1, M3, M5, I1 all verified at source.

**1 net-new HIGH surfaced (H1-OPUS):** `WorkbookSession::from_workbook` (line 304) and `WorkbookSession::rematerialize` (line 739) call the zero-arg `CalcgraphSession::rebuild_from_workbook(&workbook)` which constructs a fresh `default_registry()` internally — silently divergent from `self.registry`. This is the SAME 6.4-0 H2 silent-registry-divergence pattern, at two DIFFERENT call sites that 6.4-0's audit-fix did NOT close. Latent today (no UDFs yet), corrupts dep extraction the moment 6.4 wires `register_function`. Codex's `recompute.rs:125` fix closed one such site; these two remain.

**1 doc-honesty HIGH (H2-OPUS):** the I2 module-header docstring at `function_meta.rs:41-43` claims that during the transient unregister→register window, formulas "bind / re-bind with `Volatility::Dynamic` (the conservative default in contract §10.3)". This is factually wrong: the substrate's migration shim `is_volatile_function` at `calcgraph_session.rs:202-207` returns `false` for any unknown name (its own docstring at `:191-197` explicitly says so — "substrate keeps today's behavior … 6.4 will tighten this when UDF metadata becomes session-scoped"). So during the gap, formulas re-bind as NOT volatile — not "Dynamic-conservative". The transient window can serve stale results until the new metadata lands. The doc CLAIMS the contract §10.3 unknown-fn policy is honored; the substrate explicitly defers honoring it.

Both surfaced via the same heuristic as the 6.4-0 Opus net-new HIGHs — Codex's repo-scoped, source-anchored review tends to verify the claim that was MADE (and the H1 byte-for-byte claim verifies CLEAN); it doesn't reliably catch claims that QUIETLY OMIT a call site or describe a desired behavior that the substrate hasn't actually shipped yet.

---

## Per-finding inventory

### HIGH

**# H1-OPUS — HIGH — Lane: Opus reviewer**
`WorkbookSession::from_workbook` and `WorkbookSession::rematerialize` call the zero-arg `CalcgraphSession::rebuild_from_workbook(&workbook)` which internally constructs `let registry = ql_functions::default_registry()` (at `calcgraph_session.rs:1110`) for the dep walk. The session's own `self.registry: Arc<FunctionRegistry>` is constructed independently at session.rs:326. After cycle 1 ships H1+H3, the two registries are functionally interchangeable while there are zero UDFs registered (substrate phase). But once 6.4 wires `EngineSession::register_function`, `rematerialize` will rebuild against a UDF-free `default_registry()` — formulas referencing a UDF will get re-extracted deps with `arg_context=Scalar`, `dep_shape=ValueDeps`, `volatility=Pure` (the unknown-fn defaults of the migration shims), not the real registered metadata. This is EXACTLY the 6.4-0 H2 silent-registry-divergence pattern; 6.4-0's audit-fix closed `recompute_all`'s instance at `recompute.rs:125` but missed these two. The fix is mechanical: replace both call sites with `rebuild_from_workbook_with_registry(&self.workbook, &self.registry)`.
**Anchors:** `crates/ql-exec/src/session.rs:304` (`from_workbook`) + `:739` (`rematerialize`); migration-shim already exists at `crates/ql-exec/src/calcgraph_session.rs:1121-1195`.
**Proposed disposition: FIXED in audit-fix.**

**# H2-OPUS — HIGH (doc-honesty) — Lane: Opus reviewer**
The I2 module-header docstring at `crates/ql-session/src/function_meta.rs:41-43` claims "formulas referencing it bind / re-bind with `Volatility::Dynamic` (the conservative default in contract §10.3), so the engine never serves a result computed against stale metadata." This is factually wrong against the substrate's behavior. The migration shim `is_volatile_function(registry, name)` at `crates/ql-exec/src/calcgraph_session.rs:202-207` returns `Some(Volatile) | Some(Dynamic)` for names that have those metadata variants and `false` otherwise — including the `None` case for unknown names. Its own docstring at `:191-197` explicitly documents this: "**Unknown-function policy (substrate v1):** returns `false`. Today's hardcoded whitelist had the same effect … 6.4 will tighten this when UDF metadata becomes session-scoped." So during the transient gap (a) the formula re-binds as NOT volatile, not "Dynamic"; (b) the contract §10.3 unknown-fn policy is NOT honored at substrate v1; (c) the engine CAN serve a result computed against the unknown-fn fallback (which is essentially the OLD result for any dep-stable formula). The doc describes the DESIRED contract behavior, not the actual current behavior. The `BindError::NamedRangeInScalarContext` part of the I2 doc IS correct (verified at `plan.rs:419-424` + `:723-729`); only the volatility claim is wrong.
**Anchors:** `crates/ql-session/src/function_meta.rs:35-51` (the I2 docstring) vs. `crates/ql-exec/src/calcgraph_session.rs:191-207` (the actual unknown-fn behavior).
**Proposed disposition: FIXED in audit-fix (rewrite the I2 paragraph to reflect what the substrate actually does, and call out the deliberately-deferred contract §10.3 unknown-fn tightening — same as `is_volatile_function`'s own docstring does).**

### MED

**# M1-OPUS — MED — Lane: Opus reviewer**
`PlanCache` unit tests (`crates/ql-exec/src/plan_cache.rs:202-215`) construct a `key()` helper that pins `fn_gen: 0` with a docstring saying the cross-tier integration tests at `WorkbookSession::register_function` (6.4) exercise the cache-invalidation pathway end-to-end. **But there is no test today (substrate-completion phase) that proves the CACHE-MISS invariant** — i.e., bind plan P at `fn_gen=N`, register a UDF (bumps to `N+1`), prove that the cache lookup for the same `text + sheet + name_gen` with old `fn_gen` misses. `fn_gen_ticks_on_successful_register_and_unregister` at `registry.rs:2505-2572` proves the BUMP. The PlanCacheKey `Hash + Eq + PartialEq` derive at `plan_cache.rs:79-88` proves that `fn_gen` participates in equality (different `fn_gen` → different hash → miss). So the invariant IS true by construction; the gap is testability, not correctness.
**Proposed disposition: FIXED in audit-fix (add a focused unit test in `plan_cache.rs::tests` that constructs two keys differing only in `fn_gen` and proves they miss against each other; can use the existing `dummy_plan()` helper). Low-risk to add in cycle 2.**

**# M2-OPUS — MED — Lane: Opus reviewer**
`arg_context_overrides_match_pre_6_4_1_whitelists` test at `registry.rs:2462-2496` enumerates only a 13-name SAMPLE of the ~66 Phase-1.5 names. The byte-for-byte cross-check is enforced by `is_aggregate_function_lists_only_registered_aggregates` at `validate.rs:242-329` (matcher → registry) + `every_range_aware_fn_is_admitted_to_is_aggregate_function` at `validate.rs:545-565` (registry → matcher) + (manually, this audit) the `git show fdbccb704f7^:.../plan.rs | grep -oE '"[A-Z][A-Z0-9.]*"' | sort -u` vs Phase-1.5 list diff (66/66 names matched at audit time). The two `validate.rs` invariants now flow through metadata after H1, so they do serve as runtime byte-for-byte cross-checks — but they only catch ADDITIONS to the registered set (a name registered but NOT in Phase 1.5) and check membership against a hardcoded list inside the test (not against the Phase-1.5 source). A future contributor who adds a name to Phase 1.5 but FORGETS to register it dispatch-side would silently regress (no test catches it).
**Proposed disposition: FIXED in audit-fix (extend the test to enumerate all 66 Phase-1.5 names against the registry's metadata table, OR fold the Phase-1.5 list into a `pub(crate) const PHASE_1_5_AGGREGATE_NAMES: &[&str]` exposed to the test). Cycle-1's coverage is acceptable; the 6.4-0 audit-fix added a similar `builtin_metadata_pins_prior_address_only_whitelist` test that pins the address-only batch byte-for-byte — extending that pattern to Phase 1.5 is the natural next step.**

**# M3-OPUS — MED (forward-compat hazard) — Lane: Opus reviewer**
The new `ArgContext` enum (`Scalar | Aggregate | Reference`) at `function_meta.rs:164-186` has a closed taxonomy. The 6.4 Python UDF wedge will need UDFs that take BOTH a Range arg AND emit Array results — e.g., a UDF doing `qb.signal(range)` returning a 2-D Series. Such a UDF declares `BatchShape::ArrayBatch` (Arrow IPC) AND needs `ArgContext::Aggregate` (binder admits range args). The cycle-1 docstring at `function_meta.rs:141-186` explicitly addresses this orthogonality. But the SECOND case — a UDF that takes BOTH a literal `RangeRef` (like ISFORMULA) AND emits Array results — would need `ArgContext::Reference + BatchShape::ArrayBatch`, which the substrate accepts at the type level but the eval-tier dispatch (`scalar.rs` + `eval_scalar_with_cache`) hasn't been verified to route correctly. The H1 closure does NOT make any claim about this case; the brief just asks orthogonality holds, and per the 13-name sample, no builtin currently has this combination. The orthogonality CLAIM is technically fine — neither axis silently flips the other.
**Proposed disposition: FILED for 6.4-2 / 6.4 wedge spec — add a smoke test (or design note in the wedge plan) for the `Reference + ArrayBatch` combination once a real UDF needs it.**

**# M4-OPUS — MED — Lane: Opus reviewer**
The `arg_context_overrides_match_pre_6_4_1_whitelists` test passes the registry by value (constructs `default_registry()` then `r.metadata(name)`). But the load-bearing `is_aggregate_function` / `is_reference_aware_function` shims now take `&FunctionRegistry`. There is **no production-style integration test** that exercises a UDF-style metadata entry (`BatchShape::ArrayBatch + arg_context: Aggregate + dep_shape: ValueDeps`) flowing through the binder's `is_aggregate_function` and admitting a range arg. The `fn_gen_ticks_on_successful_register_and_unregister` test does `register_metadata` for `MYUDF1` but only inspects `fn_generation()`; it does not bind a formula `=MYUDF1(MyRange)` through the actual binder. The H1 production path's "any UDF registering `ArgContext::Aggregate` becomes a first-class binder admission" claim is therefore tested only through the BUILTINS' Phase-1.5 overrides, not through the UDF registration path.
**Proposed disposition: FILED for 6.4-2 (add an integration test in `plan.rs::tests` that registers a UDF stub with `arg_context: Aggregate`, attempts to bind `=MYUDF(MyRange)`, and asserts `BindContext::AggregateArg` was used — i.e., no `NamedRangeInScalarContext` surfaces). The fn_gen + sorted_metadata tests are valuable but the H1 "UDF registration flows through binder" claim deserves direct coverage too.**

### LOW

**# L1-OPUS — LOW — Lane: Opus reviewer**
The `WorkbookSession::from_workbook` zero-arg call at `session.rs:304` is technically harmless at substrate v1 because session construction is the ONE moment where `self.registry` equals `default_registry()` BY CONSTRUCTION (the session has no UDF registrations yet). Even if H1-OPUS gets fixed by passing `&self.registry`, there's a chicken-and-egg ordering hazard: the `from_workbook` body constructs `graph` BEFORE `registry`. The fix needs to restructure the construction so `let registry = Arc::new(default_registry()); let graph = rebuild_from_workbook_with_registry(&workbook, &registry).session;` (or similar). The change is mechanical but invites a small re-order.
**Proposed disposition: FIXED in audit-fix alongside H1-OPUS (mention the restructuring).**

**# L2-OPUS — LOW — Lane: Opus reviewer**
The new `DepShape::LazyShape` variant at `function_meta.rs:106-115` has a `#[serde(rename_all = "snake_case")]` enum-level attribute (inherited from `DepShape`). This is good for the wire-DTO. But the new variant has no explicit `#[serde(alias = "...")]` for forward-compat with versions of consumers that might serialize the engine-internal name. Today it's not externally visible (M5 mapper marks the EngineSession trait wiring dead_code), and the `#[serde(default)]` for the `arg_context` field provides v0-compat. But if a tooling sidecar (e.g., qprofile JSON export) snapshot-serializes a `FunctionMetadata` with `dep_shape: LazyShape` before 6.4-2 wires the trait methods, an older consumer reading the wire bytes would see the unknown variant and fail.
**Proposed disposition: FILED for 6.4-2 (acceptable v1 — the variant isn't externally visible until `list_functions` ships, and the cycle-1 commit confirms M5 is `#[allow(dead_code)]` until 6.4-2 wires it).**

**# L3-OPUS — LOW — Lane: Opus reviewer**
The walker's branch ordering at `crates/ql-exec/src/calcgraph_session.rs:436-456` is correct (LazyShape first, then AddressOnly, then normal). But the implementation uses three sequential `if … else if … else` blocks, each calling a separate function-registry lookup (`is_lazy_shape_reference_fn` + `is_address_only_reference_fn`) — both hit the same HashMap. Hot-path cost: 2x HashMap lookups + 2x `to_ascii_uppercase` (since `metadata()` uppercases the name internally) per `ExprPlan::Function` node walked. For deep nested calls or large rebuilds this compounds. The 6.4-0 substrate audit filed `L1` for the same pattern (`to_ascii_uppercase` hot-path allocation). The natural fix is one `match registry.metadata(name).map(|m| m.dep_shape)` block returning a routing decision.
**Proposed disposition: FILED for 6.4 perf backlog (joint closure with 6.4-0 L1).**

### INFO

**# I1-OPUS — INFO — Lane: Opus reviewer**
Cycle 1's commit message says the H3 closure is "the cache invalidation, not a per-dependent `reextract_deps` call" — which is correct, but the contract §10.3 wording implies the substrate would call `reextract_deps` per dependent. The architectural decision (cache-invalidation route over per-dependent walk) is sound (one bump invalidates EVERY plan in one HashMap lookup vs. N walks of the dependent set), but the doc trail explaining WHY this is the chosen closure should be in `session-api.md §10.3` for future-developer context. The 6.4-0 SYNTHESIS doc captures this; the contract spec itself does not yet.
**Proposed disposition: FIXED in doc-sync (when cycle 3 lands `session-api.md §10` updates).**

**# I2-OPUS — INFO — Lane: Opus reviewer**
The Phase 1.5 override loop at `registry.rs:1353-1455` uses an `if let Some(existing) = r.metadata.get_mut(name) { existing.arg_context = ArgContext::Aggregate; } else { … register_metadata(m).expect(…) }` pattern. The cycle-1 commit message notes that "Some of these names overlap Phase-1 overrides (none currently)" but the code defensively handles the overlap case. Today the overlap is empty (verified — no name in Phase 1.5 appears in Phase 1 because the two batches are disjoint by design). But the patch path (`existing.arg_context = ArgContext::Aggregate`) bypasses `register_metadata` AND therefore does NOT bump `fn_gen`. If a future Phase-1 entry ever gets duplicated to Phase 1.5 (e.g., a name that needs both `Volatility::Volatile` AND `ArgContext::Aggregate`), the silent patch would leave `fn_gen` unbumped. Today this is invariant-safe because `default_registry()` is called once at session-construction time before any cache key is minted (so `fn_gen` value is "whatever it is" by the time the first bind happens).
**Proposed disposition: FILED for 6.4-2 (add a `debug_assert!` at the Phase-1.5 entry that no overlap exists, OR document the no-bump-on-patch carve-out at the override path).**

**# I3-OPUS — INFO — Lane: Opus reviewer**
The H3 closure has a `saturating_add(1)` rationale in the docstring at `registry.rs:230-235` arguing against `checked_add + expect` (panic the user can't act on) and `wrapping_add` (re-collide with prior cache keys). All correct. But the chosen `saturating_add` is also slightly subtle: at `u64::MAX`, every subsequent successful `register_metadata` / `unregister_metadata` SILENTLY reads as a no-op for the cache (counter stuck at `MAX`, no new cache key, cache hits continue against stale metadata). 10^19 mutations is unreachable per session, but the failure mode is "silent stale-cache" not "loud panic". The docstring honestly notes "saturation is fine"; whether "fine" matches the No-Fallbacks rule is judgment-call territory.
**Proposed disposition: VERIFIED as cycle-1 intent + DOC-HONESTY-CORRECT — the choice is defensible and documented; record it as a known invariant on the H3 closure.**

---

## Net-new findings (the Opus structural contribution)

The 6.4-0 SYNTHESIS records "the Opus lane surfaced 2 net-new HIGH findings (H1 cross-cutting `plan.rs` whitelists + H2 production `recompute_all` using `default_registry()`) that the Codex lane's scope didn't reach." Cycle 2's Opus lane surfaces the SAME PATTERN at TWO MORE production call sites:

1. **H1-OPUS (`from_workbook` line 304 + `rematerialize` line 739):** the exact 6.4-0 H2 silent-registry-divergence pattern, NOT closed by the 6.4-0 audit-fix. Cycle 2's audit-fix should close these.
2. **H2-OPUS (I2 docstring claim):** doc-honesty issue catching a claim about contract §10.3 behavior that the substrate hasn't shipped yet. Codex's source-anchored review would verify the cited contract section exists; the structural lane verifies the actual behavior matches the claim.

Plus M3-OPUS (forward-compat for `Reference + ArrayBatch` UDFs) and M4-OPUS (no production-style UDF integration test for the H1 metadata path) — both are cycle-1-acceptable filings for 6.4-2.

---

## Dispositions summary

- **FIXED in audit-fix (cycle 2):** H1-OPUS (thread `&self.registry` through both `from_workbook` + `rematerialize`), H2-OPUS (rewrite I2 docstring to match actual substrate behavior + flag the deliberately-deferred §10.3 tightening), L1-OPUS (folded into H1-OPUS fix), M1-OPUS (cache-miss test).
- **FILED for 6.4-2:** M2-OPUS (extend `arg_context_overrides_match_pre_6_4_1_whitelists` to byte-for-byte all 66 names — OR FIXED in audit-fix if cheap), M3-OPUS (Reference + ArrayBatch UDF combination smoke), M4-OPUS (UDF-flow binder integration test), L2-OPUS (LazyShape wire-compat alias if needed), I2-OPUS (Phase 1.5 overlap debug_assert), L3-OPUS (joint with 6.4-0 L1 perf backlog).
- **FIXED in doc-sync (cycle 3):** I1-OPUS (cache-invalidation rationale in `session-api.md §10.3`).
- **VERIFIED + DOC-HONESTY-CORRECT:** I3-OPUS (saturating_add at u64::MAX rationale).

H1 byte-for-byte verified at source (66/66 names match). M5 closed-enum exhaustive verified. fn_gen production-call-site threading verified at all 5 sites. Walker LazyShape-before-AddressOnly ordering verified. ISREF metadata moved from AddressOnly to LazyShape verified. FormulaDeps widening verified covers all 6 fields including `usize::from(self.is_volatile)`.
