# Phase 6.4-1 substrate-completion — audit synthesis (2026-05-28)

**Decision-lock §2 item 6 (entry).** The substrate-completion delivery that closes the 6.4-0 block-on-entry HIGHs (H1 binder whitelists + H3 PlanCache re-extraction) and the five filed substrate-completion items (M1, M3, M5, I1, I2). Lands the prerequisites for 6.4-2 trait wiring (`register_function` / `unregister_function` / `list_functions`).

**Audit format:** parallel Codex (`gpt-5.5 xhigh`, `codex exec -s read-only`) + Opus reviewer (fresh-context general-purpose agent), per audit-discipline memory rule 2. 2-way chosen (not 5-way megaudit) because the substrate-completion is self-contained: no Send/Sync changes, no FFI surface beyond a closed-enum mapper (gated `#[allow(dead_code)]` until 6.4-2 wires it), no IO, no cross-repo. The 6.4-0 session re-confirmed the 2-way pattern's structural value (Opus caught 2 net-new HIGHs Codex missed); this audit repeats that pattern.

**Engine HEAD at audit:** `1a7dfee12b0` (parent `fdbccb704f7` — 6.4-0 doc-sync). Cycle 1 (substrate-completion code): +1095/-348 across 21 files in 3 crates. Cycle 2 (audit-fix): in the audit-fix commit.

## Lane outputs

- **Codex lane:** `lane-codex.out` (10732 lines; verdict SHIP-WITH-FIXES; **no HIGH**; 2 MED + 2 LOW + 1 INFO).
- **Opus lane:** `lane-opus.md` (verdict SHIP-WITH-FIXES; **2 HIGH** + 4 MED + 3 LOW + 3 INFO). The Opus lane surfaced **2 net-new HIGH findings** that the Codex lane's repo-scoped review didn't catch:
  1. **H1-OPUS** — silent registry divergence at `WorkbookSession::from_workbook` (`session.rs:304`) + `WorkbookSession::rematerialize` (`session.rs:739`). The exact 6.4-0 H2 pattern at TWO MORE production call sites that the 6.4-0 audit-fix did NOT close.
  2. **H2-OPUS** — the I2 module-header docstring (`function_meta.rs:41-43`) claims `Volatility::Dynamic` during the transient unregister→register window, but the substrate's `is_volatile_function` (`calcgraph_session.rs:202-207`) returns `false` for unknown names. The doc describes the contract §10.3 desired behavior, not the substrate's actual behavior.

The audit-discipline pattern is now re-confirmed for the third audit in a row (6.1C → 6.4-0 → 6.4-1): the Opus lane's structural / cross-cutting / claim-vs-behavior heuristic catches what a single Codex source-anchored review misses.

## Convergence + divergence

| # | Codex | Opus | Disposition |
|---|---|---|---|
| H1 byte-for-byte (66/66 aggregate names) | "VERIFIED, identical order" | "VERIFIED, 66/66 match" | ✅ verified by both at source |
| Binder registry threading complete | VERIFIED through `bind_with_context_v2` + `bind_implicit_intersection` | VERIFIED | ✅ |
| H3 bump-on-success-only invariant | VERIFIED at register/unregister; Conflict/NotFound/builtin-guard return before bump | VERIFIED + `Hash+Eq+PartialEq` derived for fn_gen | ✅ |
| H3 production cache keys thread `self.registry.fn_generation()` | VERIFIED at cells.rs:116/524, recompute.rs:547/756, tables.rs:825 | VERIFIED (5/5 sites) | ✅ |
| M1 widened gate covers all 6 fields | VERIFIED behavior-equivalent | VERIFIED (incl. `usize::from(is_volatile)`) | ✅ |
| M3 `sorted_metadata` ascending + call-stable | VERIFIED | VERIFIED | ✅ |
| M5 closed-enum exhaustive (no `_ =>` arm) | VERIFIED two-variant match | VERIFIED | ✅ |
| I1 LazyShape walker order (LazyShape before AddressOnly) | VERIFIED ISREF skip + ROW etc. AddressOnly + ISFORMULA/FORMULATEXT ValueDeps | VERIFIED | ✅ |
| I2 docstring "Volatility::Dynamic" claim | MED (M1) — doc bug | HIGH (H2-OPUS) — claim-vs-behavior drift | **FIXED in audit-fix** (severity reconciled: HIGH, per Opus structural reasoning — substrate explicitly defers honoring this part of §10.3 and the doc claims it's honored) |
| `from_workbook` + `rematerialize` silent registry divergence | (not surfaced — same 6.4-0 H2 production-coverage-gap pattern) | HIGH (H1-OPUS) | **FIXED in audit-fix** |
| PlanCache cache-miss test (`fn_gen` proves miss) | MED (M2) | MED (M1-OPUS) | **FIXED in audit-fix** (cheap unit test) |
| 66-name `arg_context_overrides_…` enumeration | LOW (L1) | MED (M2-OPUS) | **FIXED in audit-fix** (severity reconciled: cheap one-pass enumeration) |
| Stale source comments (ISREF still listed as AddressOnly in some docstrings; H1/H3 framed as open) | LOW (L2) | (not enumerated) | **FIXED in audit-fix** |
| Appendix A `function_exists` / `function_not_found` rows | INFO (I1) | (covered via doc-sync notes) | **FIXED in doc-sync (separate commit)** |
| Reference + ArrayBatch forward-compat | (not surfaced) | MED (M3-OPUS) | **FILED for 6.4** |
| UDF-style binder integration test | (not surfaced) | MED (M4-OPUS) | **FILED for 6.4-2** |
| LazyShape wire-compat alias | (not surfaced) | LOW (L2-OPUS) | **FILED for 6.4-2** (not externally visible until 6.4-2) |
| Walker hot-path 2x HashMap lookup | (covered by 6.4-0 L1 backlog) | LOW (L3-OPUS) | **FILED — joint with 6.4-0 L1 perf** |
| Cache-invalidation rationale in `session-api.md §10.3` | (not surfaced) | INFO (I1-OPUS) | **FIXED in doc-sync** |
| Phase 1.5 overlap silent no-bump | (not surfaced) | INFO (I2-OPUS) | **FILED for 6.4-2** |
| `saturating_add` at u64::MAX failure mode | (not surfaced) | INFO (I3-OPUS) | **VERIFIED + DOC-HONESTY-CORRECT** (defensible choice, documented) |

## Findings — full inventory with anchors

### HIGH (correctness / contract-doc honesty)

**# H1**
**Sev: HIGH**
**Lane: Opus (net-new; Codex repo-scope didn't reach)**
**Finding:** `WorkbookSession::from_workbook` (`session.rs:304`) and `WorkbookSession::rematerialize` (`session.rs:739`) call the zero-arg `CalcgraphSession::rebuild_from_workbook(&workbook)` which internally constructs `let registry = ql_functions::default_registry()` at `calcgraph_session.rs:1110` for the dep walk. The session's own `self.registry: Arc<FunctionRegistry>` is constructed independently at `session.rs:326`. After cycle 1 ships H1+H3, the two registries are functionally interchangeable while there are zero UDFs registered (substrate phase). But once 6.4-2 wires `EngineSession::register_function`, `rematerialize` (called on every undo/redo) will rebuild against a UDF-free `default_registry()` — formulas referencing a UDF will get re-extracted deps with `arg_context=Scalar`, `dep_shape=ValueDeps`, `volatility=Pure` (the unknown-fn defaults of the migration shims), not the real registered metadata. This is EXACTLY the 6.4-0 H2 silent-registry-divergence pattern at TWO more production call sites; 6.4-0's audit-fix closed `recompute_all`'s instance at `recompute.rs:125` but missed these two. Verified at source (see Cycle 2 source grep at the synthesis foot).
**Anchors:** `crates/ql-exec/src/session.rs:304` (`from_workbook` body), `:739` (`rematerialize` body), `:326` (`self.registry` construction); migration-shim already in place at `crates/ql-exec/src/calcgraph_session.rs:1099-1116` (`rebuild_from_workbook` zero-arg) + `1121-1195` (`rebuild_from_workbook_with_registry` registry-threading).
**Disposition: FIXED in audit-fix.** `rematerialize` at line 739 is the surgical one-line swap (`self.registry` already exists). `from_workbook` at line 304 has a small construction-order rearrangement (registry constructed before graph). The L1-OPUS chicken-egg ordering hazard is the same finding; closure is bundled into this fix.

────────────────────────────────────────

**# H2**
**Sev: HIGH (doc-honesty)**
**Lane: Both lanes converged (Codex M1 + Opus H2-OPUS)**
**Finding:** The I2 module-header docstring at `crates/ql-session/src/function_meta.rs:41-43` claims that during the transient unregister→register window, formulas "bind / re-bind with `Volatility::Dynamic` (the conservative default in contract §10.3), so the engine never serves a result computed against stale metadata." Both audit lanes verified at source that this is factually wrong against the substrate's actual behavior. The migration shim `is_volatile_function(registry, name)` at `crates/ql-exec/src/calcgraph_session.rs:202-207` returns `Some(Volatile) | Some(Dynamic)` for names with those metadata variants and `false` otherwise — including the `None` case for unknown names. Its own docstring at `:191-197` explicitly documents this deliberate deferral: "**Unknown-function policy (substrate v1):** returns `false`. … Contract §10.3 specifies 'Unknown = graph-visible / treated Volatile-or-Dynamic'; the substrate keeps today's behavior because the call site only registers volatility (the formula stays graph-visible regardless via the normal cell-dep + name-dep paths). 6.4 will tighten this when UDF metadata becomes session-scoped." So during the transient gap (a) the formula re-binds as NOT volatile; (b) the contract §10.3 unknown-fn policy is NOT honored at substrate v1; (c) the engine CAN serve a result computed against the unknown-fn fallback. The doc describes the DESIRED contract §10.3 behavior, not the actual current behavior. The `BindError::NamedRangeInScalarContext` part of the I2 doc IS correct (verified at `plan.rs:419-424` + `:723-729`); only the volatility claim is wrong.
**Anchors:** `crates/ql-session/src/function_meta.rs:35-51` (the I2 docstring), `crates/ql-exec/src/calcgraph_session.rs:191-207` (the actual unknown-fn behavior + the deliberate deferral note).
**Severity reconciliation:** Codex graded MED (doc bug); Opus graded HIGH (doc misrepresents contract §10.3 compliance status; users relying on the doc would assume volatile-pass coverage that the substrate explicitly defers). **Adopted Opus's HIGH grading** — the doc isn't merely imprecise; it asserts the substrate honors a contract clause that the substrate explicitly defers honoring, with downstream behavior implications.
**Disposition: FIXED in audit-fix.** Rewrite the I2 paragraph to reflect what the substrate actually does ("unknown name → not volatile + Scalar arg_ctx for the gap") and explicitly call out the deferral of contract §10.3's "unknown = Volatile-or-Dynamic" tightening to 6.4 — matches the discipline `is_volatile_function`'s own docstring uses.

### MED (should-ship improvements)

**# M1**
**Sev: MED**
**Lane: Both lanes converged (Codex M2 + Opus M1-OPUS)**
**Finding:** H3's runtime wiring is correct, but no test today exercises the cache-MISS invariant — i.e., bind plan P at `fn_gen=N`, simulate a registry mutation that bumps `fn_gen` to `N+1`, prove that the cache lookup for the same `text + sheet + name_gen` with old `fn_gen` misses. `fn_gen_ticks_on_successful_register_and_unregister` at `registry.rs:2505-2572` proves the BUMP. The PlanCacheKey `Hash + Eq + PartialEq` derive at `plan_cache.rs:79-88` proves `fn_gen` participates in equality (different `fn_gen` → different hash → miss). The `PlanCache` unit tests still hardcode `fn_gen: 0` and only vary `name_gen`. A future edit could accidentally drop or normalize `fn_gen` without a focused unit test catching it.
**Anchors:** `crates/ql-exec/src/plan_cache.rs:79-88` (derive), `:202-213` (`key()` helper hardcoding fn_gen=0), `:262-273` (test region).
**Disposition: FIXED in audit-fix.** Add `different_function_generation_misses` unit test that constructs two `PlanCacheKey` values differing only in `fn_gen` and proves they don't compare equal + don't hash-collide via insert + lookup against `PlanCache`.

────────────────────────────────────────

**# M2**
**Sev: MED (severity reconciled — Codex L1 + Opus M2-OPUS)**
**Lane: Both lanes converged**
**Finding:** The new `arg_context_overrides_match_pre_6_4_1_whitelists` test at `registry.rs:2462-2496` enumerates all 7 Reference names (complete) but only a 13-name SAMPLE of the ~66 Phase-1.5 Aggregate names. The two pre-existing `workbook_runtime/validate.rs` invariants (`is_aggregate_function_lists_only_registered_aggregates` + `every_range_aware_fn_is_admitted_to_is_aggregate_function`) now flow through metadata after H1 and DO catch direction-A drifts (a name registered as RangeAware but missing from arg_context::Aggregate). They do NOT catch direction-B drifts: a future contributor adding a name to Phase 1.5's source list but forgetting to register the dispatch entry, OR adding a dispatch entry without adding to Phase 1.5, would slip through the 13-name sample. The byte-for-byte cross-check was performed manually in the cycle-2 audit (66/66 names matched); the test should enforce that going forward.
**Anchors:** `crates/ql-functions/src/registry.rs:2455-2486` (sample test), `crates/ql-exec/src/workbook_runtime/validate.rs:242-362` + `:545-565` (the two existing invariants).
**Severity reconciliation:** Codex graded LOW, Opus graded MED. Adopted MED — the byte-for-byte invariant is the load-bearing claim of cycle 1; not pinning it directly leaves a regression surface open.
**Disposition: FIXED in audit-fix.** Extend `arg_context_overrides_match_pre_6_4_1_whitelists` (or add a sibling test) that enumerates all 66 Phase-1.5 names directly against `r.metadata(name).arg_context == ArgContext::Aggregate`. The Phase-1.5 source list itself becomes the test fixture — either fold the list into a `pub(crate) const PHASE_1_5_AGGREGATE_NAMES: &[&str]` exposed to the test, OR copy-paste the 66 names into the test body matching the 6.4-0 audit-fix pattern at `builtin_metadata_pins_prior_address_only_whitelist`.

### LOW (polish)

**# L1**
**Sev: LOW**
**Lane: Codex L2 (net-new)**
**Finding:** Several source comments still describe pre-I1 / pre-H3 state even though behavior is correct. Concrete drift sites:
- `is_address_only_reference_fn` docstring (`calcgraph_session.rs:245-248`) still lists ISREF in its example set even though I1 moved ISREF to LazyShape.
- `walk_plan_for_address_only_deps` docstring (`calcgraph_session.rs:522-524`) lists ISREF in its "delegates from" examples.
- Registry comment at `registry.rs:1309-1310` claims the address-only shim "accepts BOTH AddressOnly and LazyShape" but the shim's actual match arm at `calcgraph_session.rs:217` only checks `Some(DepShape::AddressOnly)`. The shim does NOT accept LazyShape; the walker checks LazyShape via a separate `is_lazy_shape_reference_fn` shim BEFORE the AddressOnly branch.
- `calcgraph_session.rs:85-92` (module header) still frames H1+H3 as "6.4 entry-plan must close" carryover work — but those ARE the items cycle 1 ships.
- Hook docstrings at `calcgraph_session.rs:1399-1408` still frame H3 as open with two closure options listed — H3 cycle 1 has shipped option A; the docstring needs reflection.
**Anchors:** see Finding.
**Disposition: FIXED in audit-fix.** Mechanical doc updates — straightforward sweep.

### INFO (scope / forward-compat / docs)

**# I1**
**Sev: INFO**
**Lane: Opus I1-OPUS**
**Finding:** Cycle 1's commit message says the H3 closure is "the cache invalidation, not a per-dependent `reextract_deps` call" — correct, but the contract §10.3 wording implies the substrate would call `reextract_deps` per dependent. The architectural decision (cache-invalidation route over per-dependent walk) is sound (one bump invalidates every plan in one HashMap lookup vs. N walks of the dependent set), but the doc trail explaining WHY this is the chosen closure should be in `session-api.md §10.3` for future-developer context.
**Disposition: FIXED in doc-sync (cycle 3).**

────────────────────────────────────────

**# I2**
**Sev: INFO**
**Lane: Opus I2-OPUS**
**Finding:** The Phase 1.5 override loop at `registry.rs:1353-1455` uses an `if let Some(existing) = r.metadata.get_mut(name) { existing.arg_context = ArgContext::Aggregate; } else { … register_metadata(m).expect(…) }` pattern. The patch path bypasses `register_metadata` AND therefore does NOT bump `fn_gen`. Today the overlap with Phase 1 is empty by design (no name appears in both batches), so the patch path is dead code. But if a future Phase-1 entry duplicates to Phase 1.5 (e.g., a name needing both `Volatility::Volatile` AND `ArgContext::Aggregate`), the silent patch leaves `fn_gen` unbumped. Today this is invariant-safe because `default_registry()` is called once at session construction before any cache key is minted.
**Disposition: FILED for 6.4-2.** Add a `debug_assert!` at the Phase-1.5 entry that no overlap exists, OR document the no-bump-on-patch carve-out at the override path.

────────────────────────────────────────

**# I3 (Opus VERIFIED + DOC-HONESTY-CORRECT)**
**Sev: INFO**
**Finding:** The H3 closure's `saturating_add(1)` rationale at `registry.rs:230-235` argues against `checked_add + expect` (panic the user can't act on) and `wrapping_add` (re-collide with prior cache keys). All correct. At `u64::MAX`, every subsequent successful `register_metadata` / `unregister_metadata` SILENTLY reads as a no-op for the cache (counter stuck at `MAX`). 10^19 mutations is unreachable per session, but the failure mode is "silent stale-cache" not "loud panic". The docstring honestly notes "saturation is fine". **Verified as defensible cycle-1 intent.**

### Appendix A row addition (Codex I1 + 6.4-1 cycle-3 doc-sync)

**Finding:** `docs/api/session-api.md` Appendix A does not yet list `function_exists` / `function_not_found` rows for `FunctionRegistryError` mapping. Safe today because `register_function` / `unregister_function` / `list_functions` remain `not_implemented` (`session.rs:2396-2409`) and `map_function_registry_err` is `#[allow(dead_code)]` until 6.4-2 wires the trait methods; the IDE `parseQuantbookError` allowlist (the 6.1C carryover H1) does not need new codes until then.
**Disposition: FIXED in doc-sync (cycle 3) — add the two Appendix A rows and a forward-pointer in `session-api.md §10`.**

### FILED for 6.4 / 6.4-2 (broader UDF surface)

- **6.4-2 M3-OPUS** — `Reference + ArrayBatch` forward-compat smoke for UDFs that take a literal `RangeRef` and emit Array results. Substrate accepts the combination at the type level but eval-tier dispatch hasn't been verified to route it.
- **6.4-2 M4-OPUS** — UDF-flow binder integration test: register a stub UDF with `arg_context: Aggregate + BatchShape::ArrayBatch + dep_shape: ValueDeps`, bind `=MYUDF(MyRange)`, assert `BindContext::AggregateArg` was used (no `NamedRangeInScalarContext`).
- **6.4-2 L2-OPUS** — `DepShape::LazyShape` wire-compat `#[serde(alias)]` if needed (not externally visible until 6.4-2 trait wiring).
- **6.4-2 I2-OPUS** — `debug_assert!` at Phase-1.5 entry to catch Phase-1 / Phase-1.5 overlap silently bypassing `fn_gen` bump (today the overlap is empty by design).
- **6.4 perf backlog L3-OPUS (joint with 6.4-0 L1)** — walker hot-path `to_ascii_uppercase` + 2x HashMap lookups; collapse to a single `match registry.metadata(name).map(|m| m.dep_shape)` block.

## Verification (focused re-verify of audit-fix scope)

Audit-fix changes will touch:
- `crates/ql-exec/src/session.rs:304` (`from_workbook` registry construction reorder + `_with_registry` swap).
- `crates/ql-exec/src/session.rs:739` (`rematerialize` one-line swap to `_with_registry`).
- `crates/ql-session/src/function_meta.rs:35-51` (I2 docstring rewrite).
- `crates/ql-exec/src/plan_cache.rs::tests` (new `different_function_generation_misses` unit test).
- `crates/ql-functions/src/registry.rs::tests` (extend `arg_context_overrides_…` to all 66 Phase-1.5 names).
- `crates/ql-exec/src/calcgraph_session.rs:245-248, :522-524, :85-92, :1399-1408` (L1 stale-docstring sweep).
- `crates/ql-functions/src/registry.rs:1309-1310` (L1 stale-comment fix).

Expected verification post-fix (cycle 2):
- `cargo test -p ql-exec --lib`: 742/0 + 1 new = 743/0 (different_function_generation_misses).
- `cargo test -p ql-functions --lib`: 1819/0 + 0 (extending the existing arg_context test, not adding a new one) OR 1820/0 if a sibling test is added.
- `cargo check --workspace`: clean.
- `cargo clippy -p ql-functions -p ql-exec -p ql-session --all-targets`: clean for edits.
- `node crates/ql-bindings-node/tests/smoke_session.mjs`: PASS through fresh-built cdylib.

## Verdict: SHIP-WITH-FIXES

The substrate-completion's core promise — H1 metadata-derived binder admission, H3 cache invalidation via `fn_gen` counter, M1 honest `FormulaDeps::is_empty/len`, M3 deterministic `sorted_metadata`, M5 closed-enum exhaustive mapper, I1 LazyShape walker routing, I2 atomicity policy — is structurally sound. Two-way audit ratified the load-bearing claims:
- H1 byte-for-byte (66/66 aggregate names match pre-6.4-1; 7/7 reference names match) ✓
- Binder registry threading complete through every entry + recursive descent ✓
- H3 bump-on-success-only invariant (3 no-bump branches confirmed) ✓
- H3 production cache-key threading at all 5 sites ✓
- M1 widening covers all 6 fields including `usize::from(is_volatile)` ✓
- M5 closed-enum exhaustive (no `_ =>` arm) ✓
- I1 walker LazyShape-before-AddressOnly ordering ✓

Cycle-2 audit-fix closes:
1. **H1** — `from_workbook` + `rematerialize` silent registry divergence (2 more sites of the 6.4-0 H2 pattern).
2. **H2** — I2 docstring rewrite (was claiming `Volatility::Dynamic`; substrate explicitly defers honoring contract §10.3's unknown-fn policy).
3. **M1** — `different_function_generation_misses` plan-cache unit test.
4. **M2** — extend `arg_context_overrides_…` to byte-for-byte all 66 Phase-1.5 Aggregate names.
5. **L1** — stale-docstring sweep (ISREF still listed as AddressOnly in some places; H1/H3 framed as open).

**Tracked block-on-6.4-2-entry:** none — the audit-fix closes both HIGHs in cycle 2; FILED items are non-blocking polish + perf for 6.4-2 / 6.4 wedge spec / 6.4 perf backlog.

**Filed for 6.4-2 (non-blocking):**
- M3-OPUS (`Reference + ArrayBatch` forward-compat smoke).
- M4-OPUS (UDF-flow binder integration test).
- L2-OPUS (`DepShape::LazyShape` wire-compat alias).
- I2-OPUS (Phase 1.5 overlap debug_assert).
- Codex I1 + Appendix A doc-sync addition.

**Filed for 6.4 perf backlog (joint with 6.4-0 L1):**
- L3-OPUS (walker hot-path collapse).

**Filed for doc-sync (cycle 3):**
- Opus I1-OPUS (cache-invalidation rationale in `session-api.md §10.3`).
- `session-api.md §10` Appendix A `function_exists` / `function_not_found` rows.

**Cycle budget honored.** Cycle 1 = code (commit `1a7dfee12b0`); cycle 2 = audit + audit-fix; doc-sync as its own commit. ≤2 plan-implement-audit cycles per session per CLAUDE.md.

**NEXT (decision-lock §2 item 6 continued):** 6.4-2 engine trait wiring — `WorkbookSession::register_function` / `unregister_function` / `list_functions` over napi. The cycle-2 audit-fix + doc-sync make this a clean entry: both HIGHs closed, the substrate-completion items all landed, and the M5 mapper + sorted_metadata view are ready to wire.

## Source-grep confirmations (verification pass for both HIGHs)

```bash
# H1 confirmation
$ grep -n "rebuild_from_workbook" crates/ql-exec/src/session.rs
304:        let graph = CalcgraphSession::rebuild_from_workbook(&workbook).session;
739:        self.graph = CalcgraphSession::rebuild_from_workbook(&self.workbook).session;
# both zero-arg; both fix to _with_registry in audit-fix.

# H2 confirmation
$ sed -n '40,43p' crates/ql-session/src/function_meta.rs
//! in the "unknown" state — formulas referencing it bind / re-bind with
//! `Volatility::Dynamic` (the conservative default in contract §10.3), so
$ sed -n '202,207p' crates/ql-exec/src/calcgraph_session.rs
pub(crate) fn is_volatile_function(registry: &FunctionRegistry, name: &str) -> bool {
    matches!(
        registry.metadata(name).map(|m| m.volatility),
        Some(Volatility::Volatile) | Some(Volatility::Dynamic)
    )
}
# returns false for unknown names; the I2 doc claim is wrong.
```
