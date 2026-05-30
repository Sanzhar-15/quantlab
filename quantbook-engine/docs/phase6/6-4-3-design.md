# Phase 6.4-3 — Python worker + Arrow exchange + debugpy · DESIGN

> **6.4-3c IMPLEMENTATION NOTE (2026-05-29) — two §10 open questions resolved AGAINST this doc's
> first guess; do not let an audit revert them:**
> - **§4 steps 1-2 / §10 Q?: dispatch is Option B, NOT a `RegisteredFn::Udf` variant in `fns`.**
>   `FunctionRegistry::fns` is keyed `&'static str`; UDF names are runtime `String`s, so inserting
>   a `RegisteredFn::Udf` into `fns` would require leaking each name (`Box::leak`, unbounded under
>   register/unregister churn) or retyping the map (~130 builtin sites). 6.4-3c instead dispatches
>   UDFs from the `scalar.rs` `None` arm via `registry.udf_handle(name)` (the 6.4-2 table) +
>   a mandatory parallel guard in `eval_at_cell_boundary` for array spill. `register_udf` stays a
>   **2-way** atomic (metadata + handle) — no third dispatch table to keep in sync.
> - **§10 Q5: the worker lives on `CellEnv` (interior mutability), NOT on `EvalContext`.**
>   `EvalContext` is `Copy`; a `&mut`-needed worker cannot hang there. The eval stack threads
>   `&E: CellEnv` (shared), so `CellEnv::udf_worker() -> Option<&RefCell<Box<dyn UdfWorker + Send>>>`
>   bridges to `UdfWorker::call(&mut self)`. The session owns the `RefCell`; `WorkbookRuntime`
>   borrows it through the two `with_session_state*` constructors. `+ Send` keeps
>   `WorkbookSession: Send` (asserted by the napi bindings).
> - **v1 scope cuts (user-confirmed 2026-05-29):** (1) arg marshalling packs N scalars → 1×N row,
>   a single range/array arg → its grid, mixed/≥2-range → `#VALUE!` (one-grid wire limit; a richer
>   list-of-grids protocol is deferred); (2) failures map to deterministic cell error VALUES now
>   (`Timeout`→`#TIMEOUT!`, all else→`#CALC!`) — the structured `CellDiagnostic` sink (exit test 7's
>   target) is a focused follow-up; (3) one session-wide `UDF_CALL_DEADLINE = 30s`.

> **STATUS (2026-05-29): D, C, G are CLOSED in the 6.4-3d engine + napi increment and 3-way-audited**
> (`06c06d4a407`; synthesis `docs/audits/2026-05-29-6-4-3d-audit/`). **G** = CellDiagnostic sink shipped
> (defaulted `CellEnv::push_udf_diagnostic` + collector drained to `Event::CellDiagnostic`). **C** = C1
> "make it work" — literal multi-cell range deps via `FormulaDeps.literal_ranges` (the audit-offered
> fail-loud C2 is the recorded fallback). **D** = D1 worker preserved across `open`/import + D2 saved-value
> preserve on the LOAD path ONLY (`recompute_all_preserving_saved_udf`, used only by `open`; recalc_all /
> rematerialize recompute honestly). napi `set_udf_worker` injection is shipped + lifecycle-gated
> (`set_udf_worker_checked`). **H/I CLOSED in 6.4B code cycle 1 (`fee55b8c719`)** (op-level recalc budget + per-call cancel; grid
> caps). Remaining 6.4-3d work = the **IDE side** (Step 5) + a `pollEvents` napi binding for CellDiagnostic.
> **6.4B FULLY CLOSED 2026-05-30** (UDF-6-02..04 phase gate): FF-1 + H + I + FF-2 +
> UDF-6-03 type matrix (`crates/ql-exec/tests/udf_type_matrix.rs`) + UDF-6-04 security doc
> (`docs/security/udf-ai-connectors.md`) shipped, then a multi-lane closure audit
> (`docs/audits/2026-05-30-6-4b-udf-closure/`) fixed 1 HIGH (arrow `bodyLength` unbounded
> alloc on decode → `precheck_ipc_message_bounds`) + 2 MED (op-budget now armed on
> undo/redo `rematerialize` + `open` via `udf_op_deadline_for_pass`; doc worker-persistence)
> + 3 LOW. HEAD `66f9b77b46d`.
> Original blocker text kept below for provenance — these are NO LONGER open:
>
> **6.4-3c 5-way MEGAUDIT (2026-05-29) — were the 6.4-3d-gating blockers (now CLOSED — see STATUS above):**
> - **D (data-loss):** `open`/`import`/load recompute UDF cells with `udf_worker: None` (the session
>   is replaced wholesale in `open`, resetting the worker), overwriting saved computed UDF values
>   with `#CALC!` and collapsing saved spills. NOT reachable in the product at 6.4-3c (no napi
>   injection path), but the moment 6.4-3d exposes `set_udf_worker` over napi this becomes invisible
>   data-loss on reopen. 6.4-3d MUST preserve/inject the worker on open (trusted-workspace-gated —
>   reusing a live worker across opening an untrusted workbook is itself a trust decision) OR
>   preserve cached UDF values when no worker is present, then `recalc_all`.
> - **C:** multi-cell LITERAL `RangeRef` args of a Reference-context UDF (`=MYUDF(A1:A2)` with
>   `ArgContext::Reference`) read the range VALUES (via `marshal_udf_args`) but `walk_plan_for_deps`
>   records NO dep for a multi-cell literal `RangeRef` (the "multi-cell → `#N/A`, value-independent"
>   assumption held only for reference-aware builtins, NOT value-consuming UDFs) → editing the range
>   does not recompute. Needs a literal-range value-dep mechanism (none exists). The common
>   Aggregate-context + named-range path IS tracked. Either build the dep mechanism or reject literal
>   multi-cell range args for value-consuming UDFs at bind (fail-loud).
> - **G:** `#CALC!` conflates no-worker / Python-raised / worker-died — wire the `CellDiagnostic`
>   sink (exit test 7) so these are distinguishable.
> - **H/I:** op-level recalc budget + per-call cancel (the N×30s mutex stall); grid cell/byte caps
>   before read/encode (huge range args / produced grids).
>
> Full reconciliation + the 5 preserved lanes: `docs/audits/2026-05-29-6-4-3c-MEGAUDIT/`. The
> megaudit also FIXED (this cycle, in 6.4-3c) two real bugs it found: a `StructuredRef`
> materialization gap in `eval_at_cell_boundary`'s Unified arm (broke `=TRANSPOSE(Table[Col])`,
> widened by the 6.4-3c audit-fix routing UDF args through it) and `mark_volatiles_dirty` bypassing
> dependent-fanout (stale dependents of volatile UDFs / RAND / NOW).

**Status:** ✅ DESIGNED 2026-05-28. **6.4-3a/b/c SHIPPED**; **6.4-3d engine blockers C1/D/G + napi
`setUdfWorker` SHIPPED + 3-way-audited 2026-05-29** (see STATUS box above). **Step 5 (IDE + the
`pollEvents` napi binding) SHIPPED + 3-way-audited 2026-05-29 — 6.4-3d is now FULLY SHIPPED.** Engine
`pollEvents` + Event/Diagnostic DTOs + worker.py no-stderr robustness (`1e182a2fad3`, audit-fix
`01541cd1b7e`); IDE trust-gated `injectUdfWorker` (double-gated on `vscode.workspace.isTrusted` +
QuantLab `TrustManager`) + the 5 error codes (`worker_spawn_failed` / `worker_handshake` /
`worker_untrusted_workspace` / now-reachable `invalid_state` / `session_busy`) + CellDiagnostic→`title=`
tooltip + the `quantlab.pythonPath` cascade (IDE `9d5ca7b75fa`, audit-fix `9df6b5c820f` on
`feat/visualise-v1`). 3-way audit (Codex xhigh + 2 Opus) — 2 HIGH (VS-Code-Restricted-Mode trust gate;
client-repaint tooltip drop) + 3 MED fixed; synthesis `docs/audits/2026-05-29-6-4-3d-step5-audit/`.
**FILED-FORWARD (NOT 6.4-3d):** the live `cellGridPanel`→owning-`Session` migration + a live `pollEvents`
loop (the Step-5 Option-A scope boundary — the contract/helper/renderer surface ships, but the live panel
still runs on `CollabSession` so nothing drives the tooltip end-to-end yet); the synchronous-blocking
`setUdfWorker` → async-napi `AsyncTask`; worker.py pyarrow-import-before-fd1-redirect. **debugpy deferred
to a focused `6.4-3d-debug` follow-up** (`ProcessWorker::pid()` is ready for it).

> **STATUS (2026-05-29): 6.4-4 exit tests SHIPPED + 5-way-closure-megaudited — the 6.4-3 Python-UDF
> arc is CLOSED.** `crates/ql-exec/tests/udf_exit_tests.rs` proves §10.4 tests 1-8 (6 positive exits
> 1/2/3/6/7/8 + 2 reserved-capability guards 4/5 = `publish_dataset`/`bind_range` asserting
> `not_implemented_in_v1_core`). No production behavior changed (two doc-only notes). 5-way megaudit
> (2 Codex gpt-5.5 xhigh + 3 fresh Opus): 0 HIGH / 0 DO-NOT-SHIP; test-hardening applied (test-8
> register→dirty→recalc made airtight; test-7 widened to all 8 diagnostic codes incl. the 5
> previously-untested; test-3 isolates volatility; test-6 citation honesty). Synthesis+lanes
> `docs/audits/2026-05-29-6-4-4-exit-tests-megaudit/`. Engine commit `6b1fdb36578`.
>
> **6.4B (UDF hardening) STARTED 2026-05-29 — FF-1 CLOSED (`57bfc434850`):**
> `validate_canonical_function_name` now gates on CALLABILITY via the engine's own
> lexer+parser (the probe `NAME(1)` must parse to exactly an `Expr::Function` whose name matches) —
> rejects `MY UDF`/`MY-UDF`/non-ASCII/trailing-dot/digit-led while accepting dotted Excel canon
> (`T.DIST.2T`) and CellRef-lexed-but-callable names (`LOG10`). Using the parser as the single source
> of truth (not a hand grammar) is regression-proof — the parser-fidelity trap the megaudit warned of
> (a hand grammar would wrongly reject `LOG10`/dotted) is avoided by construction.
>
> **6.4B CODE CYCLE 1 SHIPPED 2026-05-30 (`fee55b8c719`) -- H + I + FF-2 CLOSED:** (H) op-level UDF recalc budget -- session-wide `UDF_OP_BUDGET` (120s) armed once per recalc pass by `run_recalc` (worker-attached only), threaded runtime->env->dispatch; `effective_udf_deadline` clamps each call to `min(per-call 30s, remaining)` and SKIPS the worker once spent (`#TIMEOUT!` + new `udf_budget_exhausted` diagnostic) -- bounds the N x 30s mutex stall; worker-kill stays the only honest cancel under GIL-only Python; `#[cfg(test)] set_udf_op_budget` knob (not yet napi-bound). (I) grid cell/byte caps in `ql-udf` codec -- `MAX_GRID_CELLS` (5M) + `MAX_GRID_BYTES` (=64MiB frame cap) checked in `encode_grid`/`decode_grid` BEFORE alloc -> `GridTooManyCells`/`GridTooManyBytes` -> `#VALUE!` + new `udf_grid_too_large`. (FF-2) the `WorkbookTransaction` commit path now threads the diagnostic collector (no longer drops UDF failure diagnostics). Verified: ql-udf 43/0, ql-exec lib 784/0 (default+xlsx-write), udf_exit_tests 8/8, udf_e2e 1/1 real-python, clippy no-new (26 pre-existing), workspace clean. **H/I are now CLOSED.** **Still open in 6.4B
> (fresh session):** FF-2 `WorkbookTransaction` diagnostics sink (not live); `docs/security/udf-ai-connectors.md`
> sandbox-limitations doc (decision-lock §2 item 7); op-level UDF recalc budget + per-call deadlines (the
> N×30s stall, design §H/I); UDF-6-02..04 security-audit closure. **NEXT = finish 6.4B, then the
> locked sequence (6.3 bindings → 6.2 service → 6.5 SQL).**
**Predecessor:** 6.4-2 trait wiring + napi DTO surface FULLY SHIPPED (engine HEAD `a9992a32e67`).
The dispatch substrate is in place: `FunctionRegistry::udf_handles: HashMap<String,
FunctionImplHandle>` + `udf_handle(name)` reader (6.4-2 cycle 1), `register_function` /
`unregister_function` / `list_functions` over napi, `fn_gen` cache invalidation (6.4-1 H3),
`ArgContext` binder migration (6.4-1 H1). **Missing:** the actual dispatch — there is no
`RegisteredFn::Udf` variant; `scalar.rs:463` returns `#NAME?` for any name without a dispatch
entry, including registered UDFs.

**Mandate:** Decision-lock §2 item 6 — the wedge. A user registers a Python function; it
participates correctly in the graph (deps, volatility, dirty fanout — all already wired by
6.4-0/6.4-1/6.4-2); 6.4-3 makes it actually *compute* by routing the call to an out-of-process
Python worker and returning the result as an Arrow batch.

## 0. Current ground truth (verified at source 2026-05-28)

- `crates/quantbook-py/` exists but is a **20-line stub** (`src/lib.rs` + a stub
  `python/quantbook/__init__.py`), NOT a workspace member, referenced by nothing. Greenfield.
- `RegisteredFn` (`ql-functions/src/registry.rs:172`) is a tagged-union dispatch enum:
  `Scalar` / `RangeAware` / `ContextAware` / `Unified` / `ReferenceAware`. **No `Udf` variant.**
- Eval dispatch is a `match` on `RegisteredFn` in `ql-exec/src/scalar.rs:165-463`; the `None`
  arm (`:463`) returns `Value::Error(ErrorValue::Name)` (#NAME?). A registered-but-undispatchable
  UDF currently hits this arm (proven by the 6.4-2 `register_function_dirties_dependent_formulas`
  test: `MYUDF(A1)` stays #NAME? after registration).
- `FunctionReturn` = `Scalar(Value) | Array(ArrayValue)` (`registry.rs`); the cell-boundary spill
  path already consumes `Array`. A UDF return maps onto this same enum.
- `FunctionImplHandle(u64)` is opaque (`ql-session`); 6.4-2 stores it per-UDF in `udf_handles`.

## 1. The central design decision — sync recalc vs out-of-process call

The engine's recalc is **synchronous**: scalar eval returns a `Value` inline; `recompute_*`
walks the graph topologically and evaluates each dirty node. An out-of-process Python call is
inherently blocking I/O. Two models:

### Model A — inline blocking call (per-cell, timeout-guarded) — RECOMMENDED for v1
At the `RegisteredFn::Udf` dispatch arm, marshal args → send one request to the worker →
**block the recalc thread** on the response (with a deadline) → map the Arrow batch back to
`FunctionReturn`. Worker-kill on timeout/cancel.
- **Pros:** fits the existing sync eval path with zero changes to the recompute scheduler;
  smallest blast radius; correct dep/dirty semantics are already wired upstream.
- **Cons:** one IPC round-trip per UDF cell (N cells calling the UDF = N round-trips). Arrow
  framing amortizes the *payload* cost but not the round-trip count. Acceptable for v1 (the wedge
  is "does it work + debug correctly," not "10⁶ UDF cells").
- **Mitigation path (defer):** the `BatchShape::ArrayBatch` metadata axis (6.4-1) exists precisely
  so a future increment can switch array-shaped UDFs to a **batched** pass (collect all calls to
  one UDF in a recompute pass → one Arrow batch → one round-trip). Design the protocol so this is
  additive (a `call_batch` frame alongside `call`).

### Model B — batched pass (collect-then-dispatch) — DEFER to 6.4.x
A pre-pass collects every dirty UDF call into per-function Arrow batches, dispatches them, then
the eval pass reads cached results. Correct and fast but requires a new recompute phase + a
results cache keyed by (node, fn_gen). Too invasive for the wedge.

**Decision: Model A for 6.4-3.** Design the wire protocol batch-ready (see §3) so Model B is a
later, additive optimization, not a rewrite.

## 2. Process & crate architecture

```
ql-exec (eval)  ──RegisteredFn::Udf(handle)──▶  WorkerHandle (in ql-exec or a new ql-udf crate)
                                                      │ length-prefixed Arrow IPC over a duplex pipe
                                                      ▼
                                          Python worker process (spawned, managed)
                                                      │ imports user module in a trusted workspace
                                                      ▼
                                          quantbook (Python pkg): register_formula_function,
                                                      qb.show / qb.publish / qb.bind
```

- **New crate `ql-udf`** (Rust): owns the `WorkerHandle` — spawn / handshake / request-response /
  timeout / kill / drain. Pure process+IPC mechanics; depends on `arrow` + `ql-types` (+ a small
  protocol module). NOT on `ql-exec` (leaf, dependency-inversion like `ql-io-csv`/`ql-io-xlsx`).
  `ql-exec` depends on `ql-udf` and injects a `WorkerHandle` into the eval context.
  - *Alternative:* put the worker handle directly in `ql-exec`. Rejected — keeps `ql-exec` from
    growing a subprocess+IPC concern and matches the established leaf-crate + inversion pattern.
- **`crates/quantbook-py`** (the existing stub): the worker entrypoint (a `python -m quantbook.worker`
  loop) + the user-facing `quantbook` Python package (`register_formula_function`, `qb.*`). The
  Rust `src/lib.rs` may host a PyO3 bridge later; for v1 the worker is a **plain Python process**
  speaking the Arrow-IPC protocol over stdio — no PyO3 in the hot path (simpler, debugpy-friendly,
  no GIL-in-Rust complications). Promote `quantbook-py` to a workspace member.
- **`FunctionImplHandle(u64)`** indexes a worker-side registry of user functions (the handle is
  minted IDE-side when the user calls `register_formula_function`, passed to `registerFunction`
  over napi, stored in `udf_handles`, and echoed in each dispatch request so the worker knows which
  Python callable to invoke).

## 3. Wire protocol (length-prefixed Arrow IPC over a duplex pipe)

Framing: `[u32 LE length][u8 frame-type][payload]`. Frame types:
- `HELLO` / `HELLO_ACK` — handshake: protocol version, worker pid (for debugpy), capability flags.
- `CALL { handle: u64, call_id: u64, args: Arrow RecordBatch }` — one UDF invocation. Args encoded
  as an Arrow batch (scalars = 1-row; ranges/columns = N-row; the `ArgContext`/`BatchShape`
  metadata determines the schema). `call_id` correlates the response + supports cancel.
- `RETURN { call_id, result: Arrow RecordBatch }` — success; maps to `FunctionReturn::Scalar`
  (1×1) or `Array` (N×M).
- `RAISE { call_id, exc_type, message, traceback }` — Python raised; maps to a deterministic
  `CellDiagnostic` + the cell value `#CALC!`/`#VALUE!` per contract (exit test 7).
- `CANCEL { call_id }` — cooperative cancel request (best-effort; hard cancel is process kill).
- `LOG { level, message }` — worker stdout/stderr surfaced as diagnostics (never silently dropped).

**Arrow ↔ engine `Value` mapping** (the fiddly part — its own cycle):
- engine `Value::{Number, Text, Boolean, Error, Blank}` ↔ Arrow `Float64 / Utf8 / Boolean / (error
  as a sentinel union or a separate error column) / null`. `ArrayValue` ↔ a 2-D batch (row-major).
  Error values need an explicit encoding (Arrow has no native spreadsheet-error type) — a tagged
  struct column `{ kind: Utf8 ("number"|"text"|"bool"|"error"|"blank"), num, str, bool, err }` is
  the safe v1 encoding (verbose but unambiguous; optimize later).

## 4. Eval-path wiring (`RegisteredFn::Udf`)

1. Add `RegisteredFn::Udf(FunctionImplHandle)` to the enum (`registry.rs:172`).
2. `register_udf` (6.4-2) currently stores metadata + handle but registers NO `RegisteredFn`.
   6.4-3: also insert `RegisteredFn::Udf(handle)` into the dispatch table (`fns`) so the
   `scalar.rs` match finds it instead of falling to the `None` #NAME? arm. (Re-examine the
   6.4-2 atomicity invariant — `register_udf` becomes a 3-way atomic: metadata + handle + dispatch.)
3. New match arm in `scalar.rs` (~before `:463`): `Some(RegisteredFn::Udf(handle)) => { … }` —
   marshal the evaluated args to an Arrow batch, call `ctx.worker.call(handle, batch, deadline)`,
   map `RETURN`→`FunctionReturn`, `RAISE`→error value + diagnostic, timeout→worker-kill + `#CALC!`.
4. The `FunctionContext` / `EvalContext` gains access to the `WorkerHandle` (a new optional field;
   `None` when no worker is configured → registered UDF with no worker = deterministic
   `#CALC!`/diagnostic, NOT a panic — No-Fallbacks-honest).

## 5. Cancellation / worker-kill (contract §6.2 — hard cancel)

- `CancelPolicy::WorkerKill` (already a `FunctionMetadata` axis, 6.4-1) → cancel/timeout kills the
  worker process. The engine must survive a killed worker: the `WorkerHandle` respawns lazily on
  the next call; in-flight `call_id`s resolve to a deterministic cancel diagnostic.
- Exit test 6: a canceled/timed-out UDF must NOT commit a late result — `call_id` correlation
  drops any `RETURN` arriving after the deadline/kill.
- FaultGuard discipline (6.1C M3 / 6.4-2): a worker round-trip happening inside recompute must not,
  on worker death, leave the session torn. The worker call is I/O at the leaf; failures map to a
  cell error, not an engine fault.

## 6. debugpy

- Worker spawned with an env/flag that, in trusted-workspace mode, starts `debugpy` listening on a
  port (surfaced in `HELLO_ACK` → IDE can attach). Off by default; opt-in per the trusted-workspace
  gate. No effect on the protocol hot path.

## 7. Security (trusted-workspace gating — exit tests)

- The worker imports + executes user Python. This is **trusted-workspace only** (the IDE gates it;
  the engine never auto-spawns a worker for an untrusted workbook). Exit tests: trusted-workspace
  gating, no untrusted-Python file write, worker-kill leaves the engine usable.

## 8. Python user API (`quantbook` package)

- `register_formula_function(fn, *, name, volatility=…, …)` → returns/registers a handle; the IDE
  bridges this to `Session.registerFunction(metadata, implHandle)` over napi.
- `qb.show` / `qb.publish` / `qb.bind` — the authoring surface (the basic `register_formula_function`
  flow is the 6.4-3 core; `qb.show`-only rendering is deferred to 6.4.5 per the entry plan §4).

## 9. Cycle decomposition (each its own audit; 6.4-3 spans multiple sessions)

- **6.4-3a — protocol + `ql-udf` crate (Rust-only, no Python):** framing, frame types, the
  Arrow↔`Value` codec with round-trip property tests, `WorkerHandle` against a **mock in-process
  responder** (no subprocess yet). Audit: 2-way. *This is the clean cycle-1 sliver.*
- **6.4-3b — real Python worker + spawn/handshake/kill:** `quantbook-py` worker loop, process
  lifecycle, timeout→kill, respawn. Audit: 2-way (engine) + smoke against a real `python`.
- **6.4-3c — eval wiring (`RegisteredFn::Udf` + scalar.rs arm + EvalContext worker):** end-to-end
  `=MYUDF(A1)` computes. Audit: 3-way (engine + Opus + IDE, per the cross-repo lesson).
- **6.4-3d — debugpy + trusted-workspace gating + IDE bridge** (cross-repo). Audit: 3-way.
- Then **6.4-4** exit-tests + closure megaudit (5-way).

## 10. Open questions to resolve at implementation start

1. **Transport:** stdio duplex vs a unix-domain socket / named pipe. Stdio is simplest + debugpy
   coexists (debugpy uses its own port); a socket decouples logging from the protocol. Lean stdio
   for v1 with stderr reserved for LOG passthrough.
2. **`python` discovery:** which interpreter? (workspace venv vs system). Trusted-workspace config
   provides the path; fail loud if absent (No-Fallbacks).
3. **Arrow dependency:** `arrow` crate version + feature surface; keep `ql-udf` lean.
4. **Re-examine 6.4-2 `register_udf` atomicity** once it also inserts a `RegisteredFn::Udf`
   dispatch entry (3-way atomic; the cycle-2 audit's atomicity invariant must extend).
5. **`FunctionContext` worker access** — threading a `&WorkerHandle` through the eval context
   touches every dispatch arm's signature; scope the churn (likely an `Option<&WorkerHandle>` on
   `EvalContext`).

## 11. Reading list (start-of-implementation)
1. This doc + `docs/phase6/6-4-entry-plan.md` §3.6.4-3/§3.6.4-4.
2. `docs/api/session-api.md` §6.2 (cancellation) + §10.4 (UDF exit tests 1-8).
3. `crates/ql-functions/src/registry.rs` (`RegisteredFn`, `FunctionReturn`, `udf_handle`,
   `register_udf`).
4. `crates/ql-exec/src/scalar.rs:165-463` (the dispatch match — where the `Udf` arm goes).
5. `crates/ql-io-csv` / `ql-io-xlsx` (the leaf-crate + dependency-inversion pattern for `ql-udf`).
