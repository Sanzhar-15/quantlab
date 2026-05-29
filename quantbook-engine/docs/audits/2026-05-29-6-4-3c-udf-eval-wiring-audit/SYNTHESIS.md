# Phase 6.4-3c — UDF eval wiring · 3-way audit SYNTHESIS

**Date:** 2026-05-29 · **Audited diff:** `git diff 88c0dc5836a..88406c32b70` (6.4-3c CODE
`88406c32b70` + doc-sync `4ec19775058`) · **Branch:** `feat/quantbook-engine`.

Code-then-audit per the 6.4-3a/b precedent. Three independent lanes (full reports preserved
alongside this file):

| Lane | Reviewer | Verdict | H / M / L |
|------|----------|---------|-----------|
| 1 | Codex `gpt-5.5` `xhigh` (`lane-codex-gpt55-xhigh.md`) | **DO-NOT-SHIP** | 2 / 2 / 0 |
| 2 | Opus fresh-context, engine-internal (`lane-opus-engine-internal.md`) | SHIP-WITH-FIXES | 0 / 3 / 3 |
| 3 | Opus, cross-repo / IDE lens (`lane-opus-ide-crossrepo.md`) | **SHIP** | 0 / 0 / 0 |

The four hardest dimensions — RefCell re-entrancy, FaultGuard panic-freedom, Send/`!Sync`
soundness, and builtin↔UDF dispatch mutual-exclusivity — were rated **CLEAN by both engine
lanes independently**. No soundness hole, no panic path, no wrong-render at the boundary.

## Net-new finding (the value of the multi-way discipline)

**Codex HIGH-1 was caught by Codex ONLY** — the Opus engine lane explicitly rated dimension 4
(arg marshalling) CLEAN. Codex saw that `is_range_like` sniffs **plan shape**, so an
array-*producing* function arg (`=MYUDF(SEQUENCE(2,2))`, an `ExprPlan::Function`) bypasses it,
gets scalar-evaluated, and an array-in-scalar-context collapses to `#CALC!` — Python silently
receives a 1×1 error grid instead of the 2×2 the user wrote. The Opus lane reasoned only about
range *references* being binder-constrained, missing array-*returning* Unified-tier functions.
This mirrors (inverted) the 6.1C lesson that one lane sees what another structurally cannot.

## Reconciliation & disposition

| # | Finding | Codex | Opus-eng | Disposition |
|---|---------|-------|----------|-------------|
| HIGH-1 | Array-producing function arg silently scalarized to `#CALC!` | HIGH | (missed) | **FIXED** — runtime-shape marshalling |
| HIGH-2 | Standalone `WorkbookTransaction` commits UDF with no worker, no self-heal | HIGH | MED (latent) | **FIXED** — worker threaded; latent (test-only callers today) |
| MED | Per-call 30s deadline → unbounded N×30s recalc stall under session mutex | MED | MED | **DOCUMENTED** + filed-forward (6.4-3d op-level budget) |
| MED | `set_udf_worker` leaves clean `#CALC!`; `recalc_dirty` won't heal | MED | LOW | **DOC FIXED** (recalc_all, not recalc_dirty) + **test pinned** |
| MED | Error-valued args forwarded to worker, not short-circuited | — | MED | **DOCUMENTED as intentional** (Excel UDFs receive errors) |
| LOW | `unwrap_or(Value::Blank)` silent fallback on 1×1 result | — | LOW | **FIXED** → visible `#CALC!` (No-Fallbacks) |
| LOW | Non-default-registry could populate both `fns` and `udf_handles` | — | LOW | **DOCUMENTED** (construction-dependent; no wrong result) |

Codex's DO-NOT-SHIP was driven by HIGH-1 (real, now fixed) and HIGH-2 (real but latent — no
production path; the live `commit_transaction` routes through `batch`→`with_runtime_no_oplog`
which already threads the worker). With HIGH-1 fixed and HIGH-2 closed cheaply, the increment
ships.

## Fixes applied (this audit-fix cycle)

1. **HIGH-1** — `scalar.rs::marshal_udf_args` rewritten to classify args by **runtime shape**:
   a "grid" arg is a range ref, a literal array, OR a function that actually produces an array
   (Unified-tier built-in — the only built-in tier that can return `FunctionReturn::Array` — or
   a nested UDF). Those function args are evaluated through `eval_at_cell_boundary` so an `Array`
   return is preserved; plain scalars (incl. `ROW`/`COLUMN`, which are `ReferenceAware`) stay on
   `eval_scalar_with_cache` (no behavior change). Result: `=MYUDF(SEQUENCE(2,2))` passes the full
   2×2 grid; `=MYUDF(SEQUENCE(2,2), 5)` is a VISIBLE `#VALUE!` (single-grid protocol limit),
   never a silent scalarization.
2. **HIGH-2** — `WorkbookTransaction` gains a `udf_worker` field, threaded in via
   `with_optional_oplog` from `WorkbookRuntime::transaction()` (`self.udf_worker`); commit pass-2
   uses `with_formula_cell_and_worker`. `new`/`with_oplog` default to `None`. A UDF committed
   through the primitive now computes (scalar) instead of writing a permanent `#CALC!`.
3. **LOW-1** — `dispatch_udf` 1×1 extraction maps a (contract-violating) `None` to a visible
   `#CALC!`, not `Value::Blank`.
4. **Docs** — `set_udf_worker` (recalc_all, auto-dirty filed-forward), `UDF_CALL_DEADLINE`
   (aggregate-stall caveat), `marshal_udf_args` (runtime-shape rule + error-args forwarded),
   boundary guard (LOW-3 construction-dependence note).

## Tests added (5)

- `udf_array_producing_function_arg_passes_full_grid` — `=MYUDF(SEQUENCE(2,2))` → MYUDF receives
  2×2 (shape-echo mock returns 22; a scalarized 1×1 would return 11). **Directly proves HIGH-1.**
- `udf_array_producing_function_arg_with_extra_scalar_is_value_error` — `#VALUE!`.
- `udf_nested_array_returning_udf_arg_passes_grid` — `OUTER(INNER())`, INNER returns 2×3 → OUTER
  receives 2×3 (returns 23).
- `udf_set_worker_after_formula_needs_recalc_all` — pins the documented staleness: `recalc_dirty`
  leaves `#CALC!`, `recalc_all` heals → 42.
- `transaction::tests::commit_dispatches_udf_through_worker` — (a) worker → 42, (b) no worker →
  honest `#CALC!`. **Proves HIGH-2 fix.**

## Verification

- `cargo test -p ql-exec --lib` → **768/0** (763 prior + 5 new).
- `cargo test -p ql-exec --test udf_e2e` → **1/1** real-python (`=MYUDF(A1)`→42 via live
  `python -m quantbook.worker`).
- `cargo clippy -p ql-exec --all-targets` → **no new warnings** (4 lib + 7 test all pre-existing
  6.4-2 doc/complex-type warnings at session.rs:3074-3077/4074-4076; none in edited regions).
- `cargo check --workspace` → clean, incl. `ql-bindings-node`'s `assert_send::<CoreWorkbookSession>()`
  (the `+ Send` bound holds on the threaded worker).
- `Cargo.lock` → single legitimate line: the `ql-exec → ql-udf` edge (the lockfile catching up
  to the prior 6.4-3c commit's `Cargo.toml`; no new external crate).

**Verdict: SHIP** (after the above fixes). 2 HIGH closed (1 net-new from Codex), 4 MED + 3 LOW
dispositioned (2 fixed, rest documented/pinned/filed-forward).

## Filed-forward to 6.4-3d / later

- CellDiagnostic sink (Python `exc_type`/`message`/`traceback` → IDE; exit test 7).
- Op-level UDF recalc budget / cancel check + per-function deadlines (the N×30s stall).
- Auto-dirty UDF-using cells on `set_udf_worker` (via the 6.4-0 `functions_used` reverse index).
- Richer args protocol (list-of-grids) for mixed / multi-range / array+scalar UDF args.
- napi/IDE worker-injection bridge (trusted-workspace + debugpy).
