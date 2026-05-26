# Phase 6 Decision-Lock Review

**Status:** audit-only decision-lock review, 2026-05-26. No engine source changes.

**Repo basis:** `git log --oneline -1` reports `a2722008b24 docs(quantbook): scope CellValueJson union retype (5.8 D2-1) -- validated, deferred`. The last non-doc source change is `ff09a5e17a7 fix(quantbook): 5.8 megaudit B#1 -- export_snapshot must hide tombstoned-sheet cells`.

## Executive Verdict

Phase 6 should lock as **wedge-first, but with a precise split**:

1. **6.1 first is non-negotiable.** It is the foundation for service and all bindings, with cancellation and structured errors in acceptance (`docs/MASTER-PLAN.md:725`-`docs/MASTER-PLAN.md:728`; `docs/phase6/entry-plan.md:57`).
2. **6.4 should move immediately after 6.1, before full 6.2/6.3/6.5/6.6**, because Python is the product wedge and Month-6 kill gate (`docs/phase6/entry-plan.md:21`, `docs/phase6/entry-plan.md:73`-`docs/phase6/entry-plan.md:75`; `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:472`, `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:501`).
3. **However, 6.4 has two meanings.** Engine-side UDF execution can depend only on 6.1 + function metadata. The product kill-gate proof requires a minimal slice of 6.3 (`quantbook-py`, kernel/debugpy bridge, `qb.show`, `BoundFrame`, `register_formula_function`) because the canonical Product Phase 5 deliverable is broader than just PyO3 function calls (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:197`-`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:205`, `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:226`-`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:248`).

Strong recommendation: lock **6.1 -> 6.4A MVP UDF + minimal Python authoring slice -> 6.4B hardening**, then return to full service/binding breadth.

## Decision 1: Sequencing

**VERDICT: CHANGE-TO WEDGE-FIRST-WITH-MINIMAL-PYTHON-SLICE.**

Agree with the core sequence: **6.1 -> 6.4 before full 6.2 / full 6.3 / 6.5 / 6.6**. The entry plan already identifies 6.4 as the strategic wedge and explicitly recommends prioritizing it ahead of 6.2/6.3/6.5 (`docs/phase6/entry-plan.md:60`, `docs/phase6/entry-plan.md:74`). The engine/product mapping makes the same point: Engine 6 maps to Product Phase 5/6/7/8 and is v1-critical, while Engine 5 collaboration maps to Product Phase 9 and is v1.5-deferred (`docs/MASTER-PLAN.md:31`-`docs/MASTER-PLAN.md:35`; `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:39`).

But the dependency line in the entry plan is only true for **engine execution**: `6.4` depends on `6.1, fn metadata` (`docs/phase6/entry-plan.md:60`). That is enough to prove: “a formula can call a Python-backed function through the engine.” It is not enough to prove: “a Python user can author/register/debug it and move data through `qb.show` / `BoundFrame`.” The canonical Product Phase 5 deliverable includes `quantbook` Python package, `qb.show/publish/bind/register_formula_function`, debugpy, Arrow batch exchange, `BoundFrame`, and transaction semantics (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:472`). The kill gate explicitly names `debug-from-cell`, `BoundFrame`, and `qb.show(df)` (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:501`).

Evidence from code reinforces the split:

- `crates/ql-udf` is still an empty Phase 6.4 placeholder (`crates/ql-udf/src/lib.rs:1`-`crates/ql-udf/src/lib.rs:10`).
- `quantbook-py` is an empty Phase 6.3 placeholder (`crates/quantbook-py/src/lib.rs:1`-`crates/quantbook-py/src/lib.rs:10`), even though its `pyproject.toml` already reserves maturin/PyO3 packaging (`crates/quantbook-py/pyproject.toml:1`-`crates/quantbook-py/pyproject.toml:24`).
- `ql-bindings-node` already exposes `appendPutFormula` (`crates/ql-bindings-node/src/lib.rs:1650`-`crates/ql-bindings-node/src/lib.rs:1673`), but it is a collab `Op::PutFormula` append path, not the final stable `WorkbookSession` evaluation API.
- `ql-oplog` replay writes formula text and deliberately does **not** evaluate formulas; callers must drive recompute separately (`crates/ql-oplog/src/replay.rs:14`-`crates/ql-oplog/src/replay.rs:17`). `CollabSession::rebuild_workbook` also states callers own downstream evaluation (`crates/ql-collab/src/session.rs:2594`-`crates/ql-collab/src/session.rs:2596`, `crates/ql-collab/src/session.rs:2642`-`crates/ql-collab/src/session.rs:2647`).

Concrete lock: do not run full general 6.3 before 6.4. Do pull forward a **minimal 6.3-Python authoring bridge** into 6.4A so the kill gate is real. That bridge is not “all bindings”; it is the smallest `quantbook-py`/kernel/debugpy/BoundFrame path that can author/register/trigger a UDF from Python and show a sheet in the IDE.

## Decision 2: 6.2 Transport

**VERDICT: AGREE, DEFER HTTP-vs-gRPC UNTIL 6.2.**

The master plan says the canonical service transport decision is due by Phase 6.2, not at entry (`docs/MASTER-PLAN.md:944`-`docs/MASTER-PLAN.md:946`). The entry plan marks 6.2 as dependent on 6.1 and explicitly frames HTTP/gRPC as a deliberate local transport choice inside 6.2 (`docs/phase6/entry-plan.md:58`).

Transport should not constrain 6.1 if 6.1 locks a transport-neutral session contract:

- stable request IDs / operation IDs,
- cancellation handles,
- diagnostic/event stream DTOs,
- structured error envelopes,
- opaque snapshot/delta version tokens,
- session/workbook lifecycle states,
- protocol/schema version fields.

Default lean if forced: **HTTP + SSE** for local VS Code/service ergonomics and browser friendliness. But this is a judgment call, not a Phase 6 entry blocker. The important lock now is that 6.1 does not bake in napi-only, HTTP-only, or gRPC-only assumptions.

## Decision 3: AI() 6.6

**VERDICT: AGREE, DEFER AI() CELL FUNCTION TO LATE PHASE 6 / v1.5 UNLESS PRODUCT POLICY IS LOCKED EARLIER.**

The entry plan already flags provider/product policy as undecided and says 6.6 may defer without blocking the wedge (`docs/phase6/entry-plan.md:62`, `docs/phase6/entry-plan.md:86`). The master plan also says provider/data policy is due by 6.6 (`docs/MASTER-PLAN.md:952`-`docs/MASTER-PLAN.md:954`).

There is an explicit product-plan conflict: Product Phase 7 ships formula-bar AI inline/chat/explain, but defers the `=COPILOT()`/`=AI()` **cell function** to v2 because of recalc determinism (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:474`, `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:485`). The engine plan says the canonical product plan wins when the two diverge (`docs/MASTER-PLAN.md:46`-`docs/MASTER-PLAN.md:50`). Today `ql-ai` is still a reserved empty implementation crate (`crates/ql-ai/src/lib.rs:1`-`crates/ql-ai/src/lib.rs:12`), and `AI` is a sentinel function returning `AINotAvailable` (`crates/ql-functions/src/scalar_fns.rs:703`-`crates/ql-functions/src/scalar_fns.rs:715`).

Strong recommendation: keep the sentinel and reserve the provider boundary, but do not spend wedge time on `AI()` until Python UDF / BoundFrame proof is through. If Phase 6 still requires a formal 6.6 close, lock it as provider-boundary design + sentinel/no-secret invariants, not a v1 product surface.

## A. 6.1 Stable Session API

6.1 must not be a cleanup of the current napi class. It must create the first stable, shared engine contract. The current napi surface is valuable prior art, but it is a collaboration wrapper: `CollabSession` wraps `ql_collab::CollabSession` (`crates/ql-bindings-node/src/lib.rs:1113`-`crates/ql-bindings-node/src/lib.rs:1137`). Phase 6 needs an owning runtime session. The code already anticipated this: Phase 6.1 `WorkbookSession` should absorb `Workbook + OpLog + CalcgraphSession + PlanCache + FunctionRegistry` into one owning struct (`crates/ql-exec/src/calcgraph_session.rs:69`-`crates/ql-exec/src/calcgraph_session.rs:71`).

### What 6.1 Must Lock

**1. Ownership and lifetime model.** The session should own workbook state, optional op-log history, calcgraph state, plan/cache state, function registry, cancellation registry, and event queue. FFI surfaces must wrap opaque session handles; no borrowed Rust references cross FFI. Query results should be owned snapshots, buffers, or Arrow handles with explicit release semantics.

**2. Command surface.** Freeze operations as session commands, not as collab op variants:

- open/new/import/save/export,
- set value / set formula / clear formula,
- sheet/table/name/format operations needed by the IDE,
- batch/transaction with atomic error behavior,
- recalc dirty / recalc all / mark volatiles,
- query range / workbook snapshot / snapshot delta,
- register/unregister/list custom functions,
- diagnostics/events,
- cancel by operation ID.

This matches the master-plan API list: open, edit, batch, recalc, query range, save, import/export, subscribe diagnostics, cancel (`docs/MASTER-PLAN.md:725`-`docs/MASTER-PLAN.md:728`).

**3. Cancellation model.** Cancellation cannot be an afterthought in 6.2/6.4/6.6; it is already an acceptance item for 6.1 (`docs/MASTER-PLAN.md:725`-`docs/MASTER-PLAN.md:728`). Lock a model where every long operation has an operation ID, optional deadline, cancel token, and terminal state. Synchronous FFIs can expose “start operation -> poll/wait/cancel”; async bindings can await the same operation. The in-process API may call synchronously for cheap edits, but UDF/SQL/AI/service operations need the same cancel contract.

**4. Structured errors.** The current napi path learned this the hard way: variant discriminants are lost at the JS boundary, so it prefixes messages with stable codes (`crates/ql-bindings-node/src/lib.rs:311`-`crates/ql-bindings-node/src/lib.rs:340`). 6.1 should formalize that into an `EngineError` taxonomy with stable codes, message, details, source class, and retryability. Bindings then map it to JS errors, Python exceptions, C error structs, WASM objects, and HTTP/gRPC status without inventing per-binding behavior.

**5. Sync-vs-async discipline.** Cheap edits and snapshots can be sync under a single-writer session. Long operations must not hold the session mutex while waiting. The napi binding already fixed this for `flushPendingToTransport` by extracting a detached handle, dropping the session lock, then waiting on `spawn_blocking` (`crates/ql-bindings-node/src/lib.rs:3418`-`crates/ql-bindings-node/src/lib.rs:3435`). 6.1 should generalize that lesson: locks guard state transitions, not arbitrary waiting.

**6. Panic and input validation boundary.** napi-rs does not catch panics by default, so existing methods pre-validate FFI-reachable assertions (`crates/ql-bindings-node/src/lib.rs:19`-`crates/ql-bindings-node/src/lib.rs:31`). 6.1 should make validation part of the common API layer, not each binding’s local folklore.

**7. Versioning.** Freeze a versioned DTO layer for cell values, addresses, ranges, snapshots, deltas, diagnostics, errors, function metadata, and operation states. The `workbookSnapshotDelta` surface is evidence that version tokens and full-rebuild fallbacks are already needed (`crates/ql-bindings-node/src/lib.rs:2497`-`crates/ql-bindings-node/src/lib.rs:2560`).

### Bottom-Up vs Top-Down

Use a **bottom-up trait extracted from proven runtime and napi workflows**, then trim it into a product-neutral contract. Do not design 6.1 purely top-down, because the current binding has already exposed real FFI hazards: JS number coercion, panic safety, lock waits, error discrimination, and snapshot versioning. But do not freeze the `CollabSession` class as the product API, because full collaboration is v1.5-deferred and the Phase 6 engine surface must be a stable single-engine contract, not a CRDT façade.

### Freeze First

Strong recommendation for 6.1 implementation order:

1. `docs/api/session-api.md`: command set, DTOs, error taxonomy, cancellation lifecycle, event model, versioning.
2. Owning `WorkbookSession` in Rust, backed by `WorkbookRuntime` + `CalcgraphSession` + `OpLog` + `FunctionRegistry`.
3. Node adapter smoke path migrated to this session for local IDE edit/recalc/snapshot.
4. Security/design audit after 6.1, before broader bindings/service exposure, as required by both plans (`docs/phase6/entry-plan.md:63`-`docs/phase6/entry-plan.md:65`; `docs/MASTER-PLAN.md:766`-`docs/MASTER-PLAN.md:769`).

## B. 6.4 Python UDFs

Wedge-first is realistic only if 6.4 is staged.

The hard part is not calling Python. The repo already pins PyO3 (`Cargo.toml:97`-`Cargo.toml:99`), and `ql-udf` exists. The hard part is the product semantics: sandbox honesty, timeout/cancel, type conversion, deterministic errors, debug-from-cell, and kernel/BoundFrame integration (`docs/phase6/entry-plan.md:83`; `docs/MASTER-PLAN.md:743`-`docs/MASTER-PLAN.md:746`).

### Minimum-Viable UDF

Define **6.4A MVP-UDF** as a trusted-workspace, explicitly limited product validation slice:

- Workspace Trust required; no “secure sandbox” claim.
- Python executes in a managed Python worker/kernel process for product proof, not only in-process PyO3, so debugpy can attach and breakpoints in real `.py` UDFs work (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:242`-`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:248`).
- `quantbook-py` exposes only the minimum API: `qb.show(df)`, `qb.publish`, `qb.bind`, `qb.register_formula_function`, `BoundFrame.refresh`, and explicit edit transactions (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:197`-`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:205`, `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:226`-`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:240`).
- Formula calls can be scalar first for smoke, but the API must be batch-shaped from day one because the product plan says Python UDFs from formulas are never per-cell and should pass Arrow arrays/ranges (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:195`).
- Error mapping is deterministic and structured: Python exception class, message, traceback/provenance, formula cell, and engine error code.
- Timeout/cancel has a soft cooperative path plus a hard worker-process kill/restart path.
- Sandbox limitations are documented in `docs/security/udf-ai-connectors.md`.

Then **6.4B hardening** completes UDF-6-02..04: robust timeout/cancel tests, type-conversion matrix, resource policy, subprocess lifecycle, and security audit closure.

### Cancellation Under the GIL

For GIL-only Python, cancellation must be honest. The canonical risk says v1 ships GIL-only because free-threaded Python is blocked (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:888`; `docs/phase6/entry-plan.md:83`). A long-running Python frame holding the GIL cannot be safely preempted by dropping a Rust future. In-process PyO3 can support cooperative cancellation only when the Python code returns to a check point. It cannot guarantee UDF-6-02 for CPU-bound pure Python loops or native extensions that do not cooperate.

Therefore the only reliable hard cancel for v1 is **process isolation**: cancel marks the operation canceled, drops the pending result, kills/restarts the Python worker if it misses the deadline, and leaves the workbook cell in a deterministic canceled/timeout error state. This also matches the product security risk posture: Workspace Trust + subprocess isolation only for v1; no seccomp/AppContainer/macOS sandbox claim (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:887`).

## C. Graph Invalidation

Wedge-first 6.4 is safe only if UDFs enter through the Phase-3 graph path. The Phase 6 exit criterion explicitly says Python UDFs, SQL/connectors, and AI must not bypass graph invalidation (`docs/MASTER-PLAN.md:776`-`docs/MASTER-PLAN.md:780`; `docs/phase6/entry-plan.md:84`). The canonical product plan is even stronger: one graph for all languages, with language nodes carrying typed inputs/outputs, provenance, cache keys, security policy, deps, invalidation, and execution constraints (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:328`).

The current engine has the right spine:

- `WorkbookRuntime` owns optional graph hooks and calls them after successful mutation (`crates/ql-exec/src/workbook_runtime/mod.rs:145`-`crates/ql-exec/src/workbook_runtime/mod.rs:151`).
- `CalcgraphSession` stores per-formula dependency state and dirty sets (`crates/ql-exec/src/calcgraph_session.rs:453`-`crates/ql-exec/src/calcgraph_session.rs:498`).
- `on_set_formula` registers dependencies and dirties downstream formulas (`crates/ql-exec/src/calcgraph_session.rs:980`-`crates/ql-exec/src/calcgraph_session.rs:1025`).
- `mark_dirty_from_cell_write` fans out direct/range dependencies and invalidates aggregate caches (`crates/ql-exec/src/calcgraph_session.rs:1370`-`crates/ql-exec/src/calcgraph_session.rs:1395`).
- volatile formulas have a dirtying entry point (`crates/ql-exec/src/calcgraph_session.rs:1470`-`crates/ql-exec/src/calcgraph_session.rs:1493`).

The gap is function metadata. Volatility is still a hardcoded whitelist that says Phase 4.3 would later replace it with per-function metadata (`crates/ql-exec/src/calcgraph_session.rs:139`-`crates/ql-exec/src/calcgraph_session.rs:145`). The current `FunctionRegistry` stores dispatch variants, not a first-class metadata record (`crates/ql-functions/src/registry.rs:119`-`crates/ql-functions/src/registry.rs:149`, `crates/ql-functions/src/registry.rs:151`-`crates/ql-functions/src/registry.rs:167`).

Correct UDF invalidation model:

- A UDF formula is a normal formula graph node. Its formula arguments are walked and registered as deps exactly like built-ins.
- Default Python UDFs should be treated as **volatile/dynamic** unless registered with explicit purity metadata. This prevents stale cells when the callable reads external Python state.
- `qb.register_formula_function(..., deterministic=True, volatile=False, deps=[...])` should allow a pure path. The deps list can name published Python objects, BoundFrames, tables, ranges, or connector revisions.
- `qb.publish()` / `qb.bind()` is the authoritative Python reactivity contract; the product plan explicitly says post-run AST/object fingerprinting is secondary and explicit publish stays clean (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:217`-`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:224`).
- `BoundFrame` edits dirtify the sheet/table/range nodes they overlay, not the original Python object.
- Connector or file refresh changes dirtify dependents by source revision, matching the product acid test that changing a CSV marks dependent cells dirty (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:64`).

Exit tests that must exist before 6.4 closes:

- pure UDF recomputes on referenced input cell/range change;
- pure UDF does not recompute on unrelated edits;
- volatile UDF recomputes on explicit recalc / volatile dirty pass;
- `qb.publish("returns", df)` dirties formulas depending on `returns`;
- BoundFrame overlay edit dirties formulas over the bound table/range;
- timed-out/canceled UDF does not commit a late successful result after cancellation;
- failed UDF produces deterministic structured cell diagnostics.

## D. Whole-Phase Gaps

**Security/design audit after 6.1 is mandatory.** Both plans call this out before exposing service/bindings (`docs/phase6/entry-plan.md:63`-`docs/phase6/entry-plan.md:65`; `docs/MASTER-PLAN.md:766`-`docs/MASTER-PLAN.md:769`). Do not start broad 6.2/6.3 exposure until the 6.1 API and FFI threat model are reviewed.

**Do not let collab backlog pre-empt Phase 6.** The entry plan explicitly says remaining collab backlog is v1.5 optional and should not pre-empt Phase 6 (`docs/phase6/entry-plan.md:85`). 6.1 should use op-log history where useful, but the core product session must be a single-user runtime session with optional history/collab adapters, not a commitment to finish collaborative table producers now.

**Credential boundaries must be locked before connectors.** Product security says Python/R/connectors require Workspace Trust, connector secrets live in VS Code SecretStorage, external network calls are explicit, and untrusted workbooks open in safe mode (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md:330`). Engine 6.5 acceptance requires connector refresh and credential boundaries (`docs/MASTER-PLAN.md:749`-`docs/MASTER-PLAN.md:752`). Do not put connector credentials in `.qbook`.

**Binding parity needs a golden test matrix.** The Phase 6 risk register names binding API forks as a High risk and mitigation is a stable session API shared by all bindings (`docs/MASTER-PLAN.md:973`-`docs/MASTER-PLAN.md:975`). Every binding should run the same golden flows: open, edit, recalc, snapshot, structured error, cancel, and UDF smoke.

**AI and connector data flow need provenance.** Even if `AI()` is deferred, the same event/error/provenance DTOs should be shaped in 6.1 so UDF/SQL/AI do not invent incompatible tracing later.

## Recommended Locked Sequence

1. **Phase 6 decision lock (this artifact).** Lock wedge-first with the 6.4/6.3-Python split.
2. **6.1A Session API contract.** Write `docs/api/session-api.md`: commands, DTOs, error taxonomy, cancellation lifecycle, event stream, versioning, binding obligations.
3. **6.1B Owning `WorkbookSession`.** Implement the session around `WorkbookRuntime`, `OpLog`, `CalcgraphSession`, `PlanCache`, and `FunctionRegistry`; migrate the Node smoke path onto it far enough to prove IDE formula edit/recalc/snapshot.
4. **6.1C Security/design audit.** Mandatory before broad binding/service exposure.
5. **6.4-0 Function metadata substrate.** Add dynamic function metadata: arity, volatility, determinism, batch/array shape, argument policy, cancellation policy, provenance tags.
6. **6.4A MVP UDF + minimal Python authoring slice.** Trusted workspace, managed Python worker/kernel, `quantbook-py` minimum API, `register_formula_function`, scalar + range/batch call smoke, debugpy breakpoint proof, `qb.show(df)` opens a sheet, minimal BoundFrame explicit refresh/transaction semantics.
7. **6.4B UDF hardening.** Timeout/cancel, process restart, type-conversion matrix, deterministic error mapping, documented sandbox limitations, graph invalidation test matrix.
8. **6.3 Full bindings.** WASM, Node, C, Python over the stable session API with parity tests. The Node binding already exists, but it should become an adapter to the stable session rather than a separate semantic surface.
9. **6.2 Full service transport.** Decide HTTP/gRPC then. If undecided, default HTTP+SSE; ensure cancellation, streaming diagnostics, auth hooks, lifecycle, and protocol versioning.
10. **6.5 SQL/connectors.** Implement after session events/cancel/provenance and graph invalidation are proven by UDFs. Keep credentials outside workbooks.
11. **6.6 AI boundary or explicit deferral.** If policy is still undecided, keep sentinel + provider-boundary design and mark cell `AI()` implementation v1.5/v2-aligned.
12. **6.7 Phase audit.** FFI, service security, Python execution, connector credentials, AI data flow, binding consistency, no unpinned deps.

## Top 3 Risks To Actively Manage

**1. Wrong 6.1 API lock causes binding forks.**  
Mitigation: freeze DTOs/error/cancel/event semantics before implementation breadth; run one golden matrix across Node/Python/C/WASM/service; migrate the existing Node path early enough to catch missing commands.

**2. Python UDF cancellation/security is overclaimed.**  
Mitigation: v1 policy is Workspace Trust + subprocess isolation only; no hard sandbox claim. In-process PyO3 is acceptable for engine smoke only, not for hard-cancel guarantees. Hard cancel means worker process kill/restart and deterministic canceled cell result.

**3. UDF/SQL/AI bypass the graph.**  
Mitigation: all language surfaces register as graph-visible formula nodes with function metadata, explicit deps, provenance, and dirty triggers. Add exit tests for pure/volatile UDFs, published Python objects, BoundFrame overlays, connector refresh, and canceled late results.
