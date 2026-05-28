# Phase 6.4-0 function-metadata substrate — audit synthesis (2026-05-28)

**Decision-lock §2 item 5.** The prerequisite for 6.4 Python UDFs and for
contract §10.3 registration-invalidation. Replaces the two hardcoded
whitelists in `ql-exec::calcgraph_session` (`is_volatile_function`
`:149-164`, `is_address_only_reference_fn` `:201-203`) with first-class
metadata stored on `FunctionRegistry`, and adds the `functions_used`
reverse index for register/unregister dirty-fanout.

**Audit format:** parallel Codex (gpt-5.5 xhigh) + Opus reviewer
(general-purpose agent), per the audit-discipline memory rule 2. 2-way
chosen (not 5-way megaudit) because the substrate is self-contained: no
Send/Sync changes, no FFI surface, no IO, no cross-repo. The 6.1C
session demonstrated the 5-way megaudit catches 22 HIGHs invisible
per-batch on phase-closure work; 6.4-0 is a single-component substrate
where 2-way is the right size.

**Engine HEAD at audit:** `ac20a432c63` (parent `aed5c8230ec` — Phase
6.1C doc-sync). Cycle 1 (substrate code): +1071/-117 across 8 files.
Cycle 2 (audit-fix): in this commit.

## Lane outputs

- **Codex lane:** `.codex-6-4-0-substrate-audit.out` (43 lines; verdict
  SHIP-WITH-FIXES; 1 MED + 4 LOWs + 3 INFOs).
- **Opus lane:** Agent transcript (verdict SHIP-WITH-FIXES; 3 HIGH +
  5 MED + 3 LOWs + 5 INFOs). The Opus lane surfaced **2 net-new HIGH
  findings** (H1 cross-cutting `plan.rs` whitelists + H2 production
  recompute_all using `default_registry()`) that the Codex lane's
  scope didn't reach. **The 2-way pattern's structural value held:**
  parallel independent reviews catch what a single lane misses.

## Convergence + divergence

| # | Codex | Opus | Disposition |
|---|---|---|---|
| Walker correctness | "no correctness issue" | "no correctness issue" | ✅ verified by both |
| Storage gate widening fixes ROW(MyName) | "verified" | "verified" | ✅ both verified at source |
| Phase 1 overrides match parent whitelist | "verified, parent at HEAD^:149-163/:201-203" | "verified byte-for-byte" | ✅ |
| Hooks dirty-only, no re-extract | MED-C | HIGH-H3 | **FILED for 6.4 (cycle-2 doc-honesty fix here)** |
| Net-new HIGH-1 (plan.rs whitelists) | (not surfaced — repo scope) | HIGH-H1 | **FILED for 6.4** |
| Net-new HIGH-2 (recompute_all uses default_registry) | (not surfaced — production-path coverage gap) | HIGH-H2 | **FIXED in audit-fix** |
| unregister_metadata can remove builtins | A-LOW | (not surfaced) | **FIXED in audit-fix** |
| HookCounts parity for new hooks | (not surfaced) | L3 | **FIXED in audit-fix** |
| debug_assert!→assert! for migration-shim invariant | (not surfaced) | L2 | **FIXED in audit-fix** |
| Missing tests (ROW / ISREF / nested / transitive / ROW(MyName)) | D-LOW (subset) | M4 | **FIXED in audit-fix (5 new tests)** |
| `to_ascii_uppercase` hot-path allocation | E-LOW | L1 | **FILED as 6.4 perf backlog** |
| iter_metadata HashMap-order | (not surfaced) | M3 | **FILED for 6.4 list_functions** |
| FunctionRegistryError → EngineError mapper | (not surfaced) | M5 | **FILED for 6.4 trait wiring** |
| FormulaDeps::is_empty / len() lie post-substrate | (not surfaced) | M1 | **FILED for 6.4** |
| DepShape::LazyShape for ISREF | (not surfaced) | I1 | **FILED for 6.4** |
| Metadata-update atomicity policy | (not surfaced) | I2 | **FILED for 6.4 docs** |
| Docs lag (function_meta.rs / session-api.md / module headers) | F-INFO | F-INFO | **FIXED in doc-sync (separate commit)** |
| Commit message says "7 new ql-functions tests"; source has 8 | D-INFO | (not surfaced) | **FIXED in doc-sync** |

## Findings — full inventory with anchors

### HIGH (correctness / contract violation)

**#: H1**
**Sev: HIGH**
**Lane: Opus**
**Finding:** Two more hardcoded `matches!` whitelists in `ql-exec::plan`
survive the substrate. `is_aggregate_function` (`plan.rs:406-505`,
~100 entries) and `is_reference_aware_function` (`plan.rs:566-571`,
7 entries) drive the binder's `arg_ctx` decision at `plan.rs:786-792`.
A UDF declared with `BatchShape::ArrayBatch` (every Python UDF per
`function_meta.rs:64-67`) taking a range arg cannot bind until these
also become registry-derived — the binder routes UDF names to
`BindContext::Scalar`, which produces `BindError::NamedRangeInScalarContext`
for `=MYUDF(MyNamedRange)`. The substrate is therefore "two-thirds of
the UDF prerequisite," not the full one.
**Anchors:** `crates/ql-exec/src/plan.rs:406-505`, `:566-571`, `:786-792`,
`:411-413`, `:559-565`.
**Disposition: FILED for 6.4 entry-plan (block-on-entry).** Migration
strategy: pass `&FunctionRegistry` into the binder (already threaded
into the walker — same approach), have `is_aggregate_function` /
`is_reference_aware_function` consult `metadata.dep_shape` /
`metadata.batch_shape`. The substrate doesn't claim to close these
whitelists; the commit message + master-plan entry now explicitly
acknowledge the gap.

────────────────────────────────────────

**#: H2**
**Sev: HIGH (one-line fix)**
**Lane: Opus**
**Finding:** `WorkbookRuntime::recompute_all`'s cycle pre-pass at
`workbook_runtime/recompute.rs:111` builds an ephemeral
`CalcgraphSession` via the zero-arg `rebuild_from_workbook(wb)`,
silently falling back to `default_registry()` and ignoring
`self.registry`. Benign today (both registries are builtin-equivalent)
but at 6.4 with UDFs the production recompute_all path will walk
against a UDF-free registry while live `set_formula` paths see the
session-scoped one — silent divergence between load/replay and live
editing.
**Anchors:** `crates/ql-exec/src/workbook_runtime/recompute.rs:109-128`.
**Disposition: FIXED in audit-fix.** Swapped to
`rebuild_from_workbook_with_registry(self.workbook, self.registry)`.
One-line change; behavior-preserving today; prevents future silent
divergence. (`recompute.rs:1738`, `:1879`, `:2150`, `:3300` remain on
the zero-arg form but they're `#[test]` paths — not production.)

────────────────────────────────────────

**#: H3**
**Sev: HIGH (cross-cutting, 6.4-scope)**
**Lane: Opus (Codex flagged as MED — same gap, different severity)**
**Finding:** `on_function_registered` / `on_function_unregistered`
hooks dirty + fan transitively but DO NOT re-extract deps. The
contract §10.3 says: "register_function / unregister_function /
metadata-update dirties every formula referencing that canonical
name (**re-extract deps** + reschedule)." The substrate satisfies
"dirty every formula" + "reschedule" halves; "re-extract deps" lands
at the 6.4 orchestrator level.
**Concrete scenario:** formula `=MYUDF(A1)` binds while MYUDF is
unknown → `deps.is_volatile = false` → NOT inserted into
`volatile_formulas`. Then `register_metadata(MYUDF{volatility:
Volatile})` succeeds, `on_function_registered("MYUDF")` dirties +
fans. `recompute_dirty` re-evaluates from the cached `ExprPlan` +
cached `FormulaDeps`. Result is recorded; dirty cleared. User
presses F9 → `mark_volatile_dirty()` walks `self.volatile_formulas`
→ MYUDF caller is NOT there → not recomputed.
**Anchors:** `crates/ql-exec/src/calcgraph_session.rs:~1255-1315` (the
hook + shared body), `:859` (the populate site that builds stale
`is_volatile`), `crates/ql-exec/src/workbook_runtime/recompute.rs:806`
(volatile-pass site that reads stale set), `docs/api/session-api.md:542`
(contract requirement).
**Disposition: FILED for 6.4 entry-plan (block-on-entry) +
DOC-honesty correction in audit-fix.** Cycle 2 tightens the hook
docstrings to be honest: substrate hook is dirty-only, re-extraction
is the orchestrator's responsibility at the 6.4 layer. Two closure
options for 6.4:
  1. Add `fn_gen: u64` counter on `crates/ql-exec/src/plan_cache.rs`
     (mirror `name_gen` at `:69-74`); bump per
     `register_function`/`unregister_function`. Plan-cache misses
     then re-bind + re-extract on next eval — same pattern the v1
     engine already uses for `set_name`.
  2. Per-dependent `reextract_deps(node, &cached_plan, &workbook,
     &registry)` calls in the `WorkbookSession::register_function`
     orchestrator AFTER `register_metadata` succeeds, BEFORE this
     hook fires.

Option (1) is the cleanest "mirror `name_gen` pattern" choice and
preserves the hook's simple shape.

### MED (should-ship improvement)

**#: M1**
**Sev: MED**
**Lane: Opus**
**Finding:** `FormulaDeps::is_empty()` / `len()` only check `cells`
and `named_ranges` (`calcgraph_session.rs:270-272`), missing the
other four payload fields (`names`, `tables`, `is_volatile`,
`functions_used`). The substrate's storage gate at `:899-904` papers
over this with an explicit 5-clause `||`-chain. Any future caller
using `deps.is_empty()` / `deps.len()` silently gets wrong answers.
**Anchors:** `calcgraph_session.rs:270-272`, `:899-904`.
**Disposition: FILED for 6.4.** Either widen `is_empty()` / `len()`
to cover all fields, or rename them to
`cell_and_range_deps_is_empty()` / `_len()` so miscalls become
compile errors. Per No-Fallbacks spirit; not blocking but should
land before broader UDF surface.

────────────────────────────────────────

**#: M2 (resolved by H3 disposition)**
**Sev: MED**
**Lane: Opus**
**Finding:** `on_function_registered` and `on_function_unregistered`
delegate to identical bodies (`calcgraph_session.rs:1275-1315`) but
the docstrings claim different semantics (register: re-extract;
unregister: re-evaluate).
**Disposition: FIXED in audit-fix.** Docstrings now honest:
substrate is dirty-only for both; H3 disposition covers the
asymmetry at the 6.4 orchestrator level.

────────────────────────────────────────

**#: M3**
**Sev: MED**
**Lane: Opus**
**Finding:** `iter_metadata` returns HashMap-arbitrary order
(`registry.rs:337-344`). The (6.4) `list_functions` mapper MUST sort
at the DTO seam (matching the 6.1C H2 ordering discipline). No
compile-time guard against forgetting.
**Anchors:** `crates/ql-functions/src/registry.rs:337-344`.
**Disposition: FILED for 6.4.** Add a `sorted_metadata()` view that
returns `Vec<&FunctionMetadata>` sorted by `canonical_name`; document
the bare `iter_metadata` as "HashMap-order; for DTO consumers use
`sorted_metadata`." 6.4's `list_functions` will then have the safe
API at hand. (6.1C lesson: this exact shape-of-bug bit
`snapshot.formats` + 5 `snapshot_delta` Vecs — fix the pattern, not
the symptom.)

────────────────────────────────────────

**#: M4**
**Sev: MED**
**Lane: Opus (Codex D LOW had a subset)**
**Finding:** Cycle-1 substrate tests cover `NOW()`, `NOW() + NOW()`,
`MYUDF(A2)`, unrelated formula — but NOT: `=ROW(A1)` (address-only
walker path), `=ISREF(A1)` (LazyShape short-circuit path),
`=ROW(NOW())` (nested-fn-in-address-only case), transitive fanout
for the function hook, and the widened storage gate's
`ROW(MyName)` cleanup regression.
**Disposition: FIXED in audit-fix.** 5 new tests added:
  - `functions_used_records_address_only_fns` — ROW + ISREF land in
    the reverse index.
  - `functions_used_records_nested_functions_through_address_only_delegation`
    — `ROW(NOW())` records both names; the address-only walker's
    `_ =>` delegation passes `registry` through.
  - `on_function_registered_fans_dirty_transitively` — chain
    `A1=NOW(), B1=A1+1, C1=B1+1` all dirty on `on_function_registered("NOW")`.
  - `name_to_formulas_cleaned_for_address_only_named_dep_on_rebind`
    — `ROW(MyName)` rebind cleanup, pinning the widened-storage-gate fix.
  - (`unregister_metadata` builtin-guard test was rewritten under M5
    coverage.)

────────────────────────────────────────

**#: M5**
**Sev: MED**
**Lane: Opus**
**Finding:** No mapping from `FunctionRegistryError` to `EngineError`
exists yet, but the docstring at `registry.rs:53-57` claims it. The
contract Appendix A also lacks `function_exists` / `function_not_found`
rows.
**Anchors:** `crates/ql-functions/src/registry.rs:53-57`,
`crates/ql-exec/src/session.rs` (no `map_function_registry_err`).
**Disposition: FILED for 6.4 trait wiring.** Substrate scope ends
at the registry-level error enum; the trait method is `not_implemented`.
6.4's `WorkbookSession::register_function` impl adds
`map_function_registry_err` alongside the existing `map_runtime_err` /
`map_oplog_err` / `map_persistence_err` / `map_xlsx_err` / `map_csv_err`,
and Appendix A grows two rows.

### LOW (polish)

**#: L1**
**Sev: LOW**
**Lane: Opus (Codex E-LOW)**
**Finding:** Metadata lookup at `registry.rs:269-272` calls
`name.to_ascii_uppercase()` which allocates a `String` per query.
The walker fires `metadata()` twice per `ExprPlan::Function` arm
(once for volatility at `:312`, once for dep-shape at `:347`). For
a nested formula `=SUM(IF(A1, MAX(B:B), MIN(C:C)))` that's 4 Function
arms → 8 String allocations per dep extraction. Pre-substrate the
checks were zero-alloc `matches!` macros.
**Anchors:** `registry.rs:269-272`, `calcgraph_session.rs:312`, `:347`.
**Disposition: FILED for 6.4+ perf backlog.** Honest perf
regression on the dep-extract hot path. The parser canonicalizes
function names upstream (`parser.rs:1085-1090`) → the walker sees
already-uppercase `Arc<str>`. Two future options:
  - Add `metadata_canonical(&str)` that skips the uppercase step
    (caller-asserts uppercase). Mechanical.
  - Cache `Volatility` + `DepShape` directly on `RegisteredFn` at
    registration time; walker reads from `RegisteredFn` enum
    variant. More invasive; full perf gain.
  - Or interner-ize the registry key as `Arc<str>` so the walker
    can probe by reference. Largest change.

Acceptable v1 substrate cost; flag for 6.4 review when the perf
budget is set.

────────────────────────────────────────

**#: L2**
**Sev: LOW**
**Lane: Opus**
**Finding:** The migration-shim invariant `r.fns.keys().all(|name|
r.metadata.contains_key(*name))` was `debug_assert!` only —
release builds would silently ship with broken walker invariants if
a future contributor added an `r.register*` call without a matching
metadata override.
**Anchors:** `registry.rs:1232-1240`.
**Disposition: FIXED in audit-fix.** Upgraded to plain `assert!`.
Cost is one O(n=260) walk at registry construction (~µs at boot);
the alternative is silent unknown-fn fallback in production. Boot-
time fail-loud matches the No-Fallbacks rule.

────────────────────────────────────────

**#: L3**
**Sev: LOW**
**Lane: Opus**
**Finding:** The two new function hooks don't increment
`HookCounts` — observability parity gap vs. every other mutation
hook (`set_value`, `set_formula`, `clear_formula`, `set_name`,
`add_sheet`, the 4 table hooks).
**Anchors:** `calcgraph_session.rs:586-608` (HookCounts),
`:1275-1292` (hooks).
**Disposition: FIXED in audit-fix.** Added `function_registered: u64`
+ `function_unregistered: u64` to `HookCounts`; hooks bump via
`saturating_add(1)` matching the existing pattern.

────────────────────────────────────────

**#: Codex A-LOW (resolved separately from Opus inventory)**
**Sev: LOW**
**Lane: Codex**
**Finding:** `unregister_metadata` could remove builtin metadata
(the prior cycle-1 test even locked this in by removing SUM).
That leaves dispatch present + metadata absent — a state the
migration-shim invariant forbids, silently regressing the dep
walker for that builtin (unknown-fn semantics).
**Anchors:** `crates/ql-functions/src/registry.rs:323` (the prior
unregister body), `:2017` (the test).
**Disposition: FIXED in audit-fix.** `unregister_metadata` now
checks `self.fns.contains_key(upper)` and returns
`FunctionRegistryError::Conflict` if the name is a dispatched
builtin. The (6.4) `WorkbookSession::unregister_function` trait
method should only ever target UDF names by construction; this
guard catches a programmer error rather than corrupting the
metadata invariant. Test rewritten to use a UDF-style metadata
entry for the happy path and explicitly verify the builtin guard.

────────────────────────────────────────

**#: Codex D-LOW (transitive fanout test)**
**Sev: LOW**
**Lane: Codex**
**Finding:** The function-hook tests prove direct dirtying but not
the Phase 3.10 H2 transitive fanout.
**Disposition: FIXED** as part of M4 (`on_function_registered_fans_dirty_transitively`).

────────────────────────────────────────

**#: Codex D-LOW (ROW(MyName) regression)**
**Sev: LOW**
**Lane: Codex**
**Finding:** No regression test for the widened-storage-gate fix on
`ROW(MyName)`-style address-only named deps.
**Disposition: FIXED** as part of M4 (`name_to_formulas_cleaned_for_address_only_named_dep_on_rebind`).

### INFO (scope / forward-compat / docs)

**#: I1**
**Sev: INFO**
**Lane: Opus**
**Finding:** `DepShape::LazyShape` is missing from the DTO; ISREF
gets `AddressOnly` + a hardcoded `name == "ISREF"` short-circuit at
the walker (`calcgraph_session.rs:343-346`). The DTO doesn't capture
all three behavioral axes the walker actually distinguishes
(ValueDeps / AddressOnly / LazyShape).
**Disposition: FILED for 6.4 polish.** Add `DepShape::LazyShape`
variant; register ISREF with that variant; walker consults
`metadata.dep_shape == DepShape::LazyShape` instead of the name string.

────────────────────────────────────────

**#: I2**
**Sev: INFO**
**Lane: Opus**
**Finding:** `register_metadata` returns `Conflict` on duplicate —
no atomic `update_metadata` or `register_or_replace_metadata`. IDE
flow to change a UDF's signature is `unregister_metadata` →
`register_metadata`; during that gap every formula calling the UDF
transiently shows `#NAME?`.
**Disposition: FILED for 6.4 docs.** Document the policy:
either "atomic update is out of scope; clients accept the transient
gap" or "future `update_metadata` would land as a single hook +
re-extract."

────────────────────────────────────────

**#: I3 (Opus verified)**
**Sev: INFO**
**Finding:** Trait surface `EngineSession::register_function` /
`unregister_function` / `list_functions` still returns
`not_implemented` (`session.rs:2392-2408`). Substrate doesn't
accidentally pretend to wire it. ✓

────────────────────────────────────────

**#: I4 (Opus verified)**
**Sev: INFO**
**Finding:** No napi-visible surface change. The IDE's existing
`parseQuantbookError` allowlist (the 6.1C H1 carryover) is
unaffected. ✓

────────────────────────────────────────

**#: I5 (Opus verified)**
**Sev: INFO**
**Finding:** Dispatch-deferred names (RANDARRAY / INDIRECT / OFFSET /
INFO / CELL) carry metadata WITHOUT dispatch entries — intentional
per the registry's `:647-648` comment + the substrate's documented
subset invariant. ✓

────────────────────────────────────────

**#: Codex D-INFO**
**Sev: INFO**
**Finding:** Commit message says "7 new ql-functions metadata tests";
source has 8.
**Disposition: FIXED in doc-sync.** Commit-message count will be
corrected in the audit-fix amend OR the doc-sync follow-up (whichever
ships first).

────────────────────────────────────────

**#: Codex F-INFO + Opus F**
**Sev: INFO**
**Finding:** Docs lag the substrate. `function_meta.rs:3` and
`session-api.md:510` still describe the registry as "dispatch only"
and say there's "no functions_used index." `calcgraph_session.rs:20+:41`
module docs are stale around dependency fields + dirty propagation.
**Disposition: FIXED in doc-sync (separate commit).** Standard
post-implementation sweep.

## Verification (focused re-verify of affected lanes)

Audit-fix changes touch 3 files (recompute.rs +14, registry.rs +30,
calcgraph_session.rs +~110 — hooks docstrings + HookCounts fields +
5 new tests). Verified:

- `cargo test -p ql-exec --lib`: **742/0** (738 cycle-1 baseline + 4
  new audit-fix tests).
- `cargo test -p ql-functions --lib`: **1815/0** (unchanged count — the
  rewritten `unregister_metadata_removes_*` test replaced the prior
  one, net zero).
- `cargo build -p ql-bindings-node`: clean (re-link).
- `node crates/ql-bindings-node/tests/smoke_session.mjs`: PASS.

## Verdict: SHIP-WITH-FIXES

The substrate's core promise — `FunctionMetadata` on the registry,
`functions_used` reverse index, `on_function_(un)registered` hooks —
is structurally sound and locks the right shape for 6.4. Two-way
audit ratified the structural soundness (walker correctness, populate/
cleanup symmetry, builtin-metadata pinning, latent-ROW(MyName)-bug
fix). Cycle-2 audit-fix closes one HIGH (H2 production-path
divergence) + 4 polish items + adds 5 missing tests.

**Tracked block-on-6.4-entry:**
- H1 — `plan.rs` `is_aggregate_function` + `is_reference_aware_function`
  whitelists must derive from registry metadata before UDFs with
  range args can bind. Substrate is "two-thirds of UDF prerequisite";
  this is the missing third.
- H3 — hooks dirty-only; PlanCache needs an `fn_gen` counter (mirror
  `name_gen`) OR the `WorkbookSession::register_function` orchestrator
  must call `reextract_deps` per dependent. Required for
  `Volatility::Volatile` UDFs to enter `volatile_formulas` correctly.

**Filed for 6.4 (non-blocking but should land before broader UDF surface):**
- M1 — `FormulaDeps::is_empty/len()` API consistency.
- M3 — `iter_metadata` sort discipline (add `sorted_metadata()` view).
- M5 — `FunctionRegistryError → EngineError` mapper + Appendix A.
- I1 — `DepShape::LazyShape` for ISREF.
- I2 — metadata-update atomicity policy docs.
- L1 — walker hot-path `to_ascii_uppercase` allocation.

**Cycle budget honored.** Cycle 1 = code (commit `ac20a432c63`);
cycle 2 = audit-fix; doc-sync as its own commit. ≤2 plan-implement-
audit cycles per session (CLAUDE.md rule).

**NEXT (canonical decision-lock §2 item 6):** 6.4 Python UDFs (the
wedge function). Block-on-entry: close H1 + H3 in the 6.4 entry
plan; ship the substrate-blocked findings (M1/M3/M5/I1/I2) as
substrate-completion sub-increments at 6.4 entry; perf items
(L1) on the 6.4 backlog list.
