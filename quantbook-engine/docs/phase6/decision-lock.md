# Phase 6 (Product Surfaces) — DECISION LOCK

**Status:** ✅ LOCKED 2026-05-26. This is the canonical Phase 6 entry decision-lock (mirrors the V3.6.0.1-style lock). It supersedes the sequencing in `entry-plan.md` §5 and is the authoritative order for Phase 6.
**Basis:** Phase 5 COMPLETE (`docs/phase5/phase-5-exit-packet.md`). Decisions delegated to the assistant ("whatever is optimal"), pressure-tested **in depth with Codex** (gpt-5.5, xhigh reasoning) — full review at `docs/phase6/codex-decision-lock-review.md` (prompt: `codex-decision-lock-prompt.md`). My three going-in decisions all held; Codex sharpened the wedge-first call in three material ways (the 6.4/6.3-Python split, GIL hard-cancel → process isolation, the `6.4-0` function-metadata prerequisite), all grounded against the canonical product plan + engine code. I reviewed each and agree.
**Engine source HEAD at lock:** `ff09a5e17a7` (docs on top to `a2722008b24`). No code-cycle budget remains this session — a fresh session implements `6.1A`.

---

## 1. Locked decisions

### D1 — Sequencing: WEDGE-FIRST, with a staged 6.4 and a minimal Python slice
- **6.1 first (non-negotiable foundation), then 6.4 immediately, before full 6.2 / 6.3 / 6.5 / 6.6.** Python UDFs are the strategic wedge ("Python-signal → pokeable-sheet") on the canonical **Month-6 Python kill gate** (debug-from-cell, `BoundFrame`, `qb.show(df)`). Engine 6 = Product Phases 5/6/7/8 = v1-critical; Engine 5 collab = Product Phase 9 = v1.5-deferred.
- **Correction (Codex, validated):** the entry-plan dependency "6.4 needs only 6.1 + fn metadata" is true for *engine-side UDF execution* but NOT for the *kill-gate product proof*. The canonical Product Phase 5 deliverable is broader (`quantbook-py` package, `qb.show/publish/bind/register_formula_function`, debugpy, Arrow batch exchange, `BoundFrame`, transaction semantics). So **6.4A pulls forward a MINIMAL 6.3-Python authoring bridge** (not "all bindings") — the smallest path that authors/registers/triggers a UDF from Python and shows a sheet in the IDE. Then **6.4B hardens.**

### D2 — 6.2 service transport (HTTP vs gRPC): DEFER the pick until 6.2
- The transport choice is canonically due *at 6.2*, not at entry. Deferring is correct **provided 6.1 locks a transport-NEUTRAL session contract** (request/operation IDs, cancellation handles, event/diagnostic DTOs, structured error envelopes, opaque snapshot/delta version tokens, lifecycle states, protocol/schema version). 6.1 must NOT bake in napi-only / HTTP-only / gRPC-only assumptions.
- **Default lean if forced:** HTTP + SSE (local VS Code/service ergonomics, browser-friendly). Judgment call, not an entry blocker.

### D3 — `AI()` (6.6): DEFER; and the cell function is v2, not v1
- Provider + product policy undecided (R-P6-6); doesn't block the wedge. Keep the `AINotAvailable` sentinel + reserve the provider boundary.
- **Refinement (Codex, validated):** the canonical product plan ships *formula-bar AI* (inline/chat/explain) in Product Phase 7 but **defers the `=AI()`/`=COPILOT()` CELL function to v2** for recalc-determinism reasons; the engine plan defers to the product plan on divergence. So lock `=AI()` cell function as **v2-aligned**, not merely v1.5. If a formal 6.6 close is needed, scope it to provider-boundary design + sentinel/no-secret invariants, not a v1 cell surface.

---

## 2. Locked sequence (authoritative)

1. **Decision lock** — this artifact. ✅
2. **6.1A — Session API contract.** Write `docs/api/session-api.md`: command set, DTOs, error taxonomy, cancellation lifecycle, event/diagnostic stream, versioning, per-binding obligations. (Design before code.)
3. **6.1B — Owning `WorkbookSession`.** Implement a single-engine owning session around `WorkbookRuntime` + `OpLog` + `CalcgraphSession` + `PlanCache` + `FunctionRegistry` (the code already anticipates this at `crates/ql-exec/src/calcgraph_session.rs:69-71`). Migrate the Node smoke path onto it far enough to prove IDE edit/recalc/snapshot. **Bottom-up:** extract the trait from the proven napi workflows, then trim to a product-neutral contract — do NOT freeze the collab `CollabSession` CRDT façade as the product API.
4. **6.1C — Security/design audit** (MANDATORY before broader binding/service exposure; required by both plans).
5. **6.4-0 — Function-metadata substrate.** Replace the hardcoded volatility whitelist (`crates/ql-exec/src/calcgraph_session.rs:139-145`) + dispatch-only `FunctionRegistry` (`crates/ql-functions/src/registry.rs:119-167`) with first-class per-function metadata: arity, volatility, determinism, batch/array shape, argument policy, cancellation policy, provenance tags. (Graph-invalidation prerequisite for UDFs.)
6. **6.4A — MVP UDF + minimal Python authoring slice.** Trusted-workspace only (no sandbox claim); managed Python **worker/kernel process** (so debugpy attaches + breakpoints in real `.py` UDFs work); `quantbook-py` minimum API (`qb.show`/`publish`/`bind`/`register_formula_function`, `BoundFrame.refresh`, explicit edit transactions); **batch-shaped call API from day one** (Arrow arrays/ranges — never per-cell); deterministic structured error mapping. Proves the Month-6 kill gate.
7. **6.4B — UDF hardening.** Timeout/cancel via process kill/restart, type-conversion matrix, resource policy, subprocess lifecycle, documented sandbox limitations (`docs/security/udf-ai-connectors.md`), graph-invalidation test matrix, security-audit closure (UDF-6-02..04).
8. **6.3 — Full bindings** (WASM/Node/C/Python) over the stable session API + parity golden matrix. The existing Node binding becomes an *adapter* to the stable session, not a separate semantic surface.
   - **AMENDMENT 2026-05-30 (ratified; Codex gpt-5.5 xhigh reviewed — `6-3-entry-plan-codex-review.out`):** v1 builds **Node + a thin Python session facade**; **WASM and C are deferred to v1.5.** Rationale: no v1 consumer needs a browser/WASM or foreign-host/C surface (the v1 product surfaces are the VS Code IDE via Node + Python authoring, the wedge); the contract-freeze risk this phase exists to retire is closed by **two structurally-different bindings** (in-process sync napi + out-of-process/PyO3 Python) running the golden matrix — they exercise the two hardest marshalling shapes. **Guardrails:** the golden harness is binding-agnostic from day one, and the contract is NOT declared frozen until ≥2 binding rows pass — so adding WASM/C later is "add a row," fully additive/reversible. This is a deliberate, low-regret deviation from the four-binding list above, recorded here rather than left implicit. Also: full `qb.publish`/`qb.bind` over the session (the deferred `publish_dataset`/`bind_range` bulk methods) move to **6.5**; the 6.4A "minimal Python authoring slice" in item 6 is in practice `register_formula_function` + `qb.show`-into-IDE, not publish/bind. See `docs/phase6/6-3-entry-plan.md`.
9. **6.2 — Full service transport.** Decide HTTP/gRPC then (default HTTP+SSE). Cancellation, streaming diagnostics, auth hooks, lifecycle, protocol versioning.
10. **6.5 — SQL surface + connectors.** After session events/cancel/provenance + graph invalidation are UDF-proven. Credentials in VS Code SecretStorage, **never in `.qbook`**.
11. **6.6 — AI boundary or explicit deferral.** Sentinel + provider-boundary design; `=AI()` cell function v2-aligned.
12. **6.7 — Phase 6 audit.** FFI / service-security / Python-exec / connector-creds / AI-data-flow / binding-consistency / no-unpinned-deps.

---

## 3. What 6.1 must lock (carry into `session-api.md`)

1. **Ownership/lifetime:** session owns workbook + optional op-log history + calcgraph + plan/cache + function registry + cancellation registry + event queue. FFI wraps **opaque session handles**; no borrowed Rust refs cross FFI; results are owned snapshots/buffers/Arrow handles with explicit release.
2. **Command surface (not collab op variants):** open/new/import/save/export; set value/formula, clear; sheet/table/name/format ops; batch/transaction (atomic error); recalc dirty/all + mark volatiles; query range / snapshot / snapshot-delta; register/unregister/list custom functions; diagnostics/events; cancel-by-operation-ID. (Matches MASTER-PLAN §725-728.)
3. **Cancellation model (acceptance item for 6.1, not an afterthought):** every long op has an operation ID, optional deadline, cancel token, terminal state. Sync FFIs expose start→poll/wait/cancel; async bindings await the same op.
4. **Structured errors:** an `EngineError` taxonomy (stable code, message, details, source class, retryability) — generalizing the napi "prefix-message-with-code" workaround (`crates/ql-bindings-node/src/lib.rs:311-340`). Bindings map it to JS/Python/C/WASM/HTTP/gRPC without per-binding invention.
5. **Sync-vs-async discipline:** locks guard state transitions, NOT arbitrary waiting (generalize the `flushPendingToTransport` detach-then-spawn_blocking lesson at `lib.rs:3418-3435`).
6. **Panic/validation boundary** in the common API layer (napi-rs doesn't catch panics; don't leave it as per-binding folklore).
7. **Versioning:** versioned DTOs for cell values, addresses, ranges, snapshots, deltas, diagnostics, errors, function metadata, operation states. Shape the event/error/provenance DTOs now so UDF/SQL/AI don't invent incompatible tracing later.

---

## 4. UDF graph-invalidation model (R-P6-4 — exit-blocking for 6.4)

The engine spine is correct (WorkbookRuntime graph hooks `mod.rs:145-151`; CalcgraphSession deps/dirty `calcgraph_session.rs:453-498`; `on_set_formula:980-1025`; `mark_dirty_from_cell_write:1384-1432` (the BFS fanout is 1396-1431; corrected from a mis-cited 1370-1395 by session mega-audit Lane S3); volatile entry `:1470-1493`). The gap is function metadata (6.4-0). Model:
- A UDF formula is a **normal graph node**; its formula args are walked + registered as deps like built-ins.
- Default Python UDFs are **volatile/dynamic** unless registered with explicit purity metadata (`register_formula_function(..., deterministic=True, volatile=False, deps=[...])`).
- `qb.publish()` / `qb.bind()` is the authoritative Python reactivity contract (explicit publish stays clean; post-run fingerprinting is secondary).
- `BoundFrame` edits dirty the **overlay** sheet/table/range nodes, not the original Python object.
- Connector/file refresh dirties dependents by **source revision**.
- **Exit tests (must exist before 6.4 closes):** pure UDF recomputes on referenced input change; pure UDF does NOT recompute on unrelated edits; volatile UDF recomputes on recalc/volatile pass; `qb.publish("returns", df)` dirties dependents; BoundFrame overlay edit dirties bound-range formulas; canceled/timed-out UDF does NOT commit a late result; failed UDF → deterministic structured cell diagnostics.

---

## 5. Top risks to actively manage

1. **Wrong 6.1 API lock → binding forks.** Freeze DTOs/error/cancel/event semantics before implementation breadth; one golden flow matrix across Node/Python/C/WASM/service; migrate the existing Node path early to catch missing commands.
2. **Python UDF cancellation/security overclaimed.** v1 = Workspace Trust + subprocess isolation only, no hard-sandbox claim. In-process PyO3 = engine smoke only; hard cancel = worker kill/restart + deterministic canceled cell.
3. **UDF/SQL/AI bypass the graph.** Every language surface is a graph-visible formula node with metadata + explicit deps + provenance + dirty triggers; enforce via the §4 exit tests.

Additional locks: security/design audit after 6.1 before exposure; collab backlog must NOT pre-empt Phase 6; connector credentials outside `.qbook`; provenance DTOs shaped in 6.1 even though AI is deferred.

---

## 6. Phase 6 lock deliverables (per MASTER-PLAN §780)
- `docs/phase6/entry-plan.md` (lock it — this decision-lock is the locking artifact).
- `docs/api/session-api.md` (written in 6.1A).
- `docs/security/udf-ai-connectors.md` (written across 6.4A/6.4B/6.5).
- `docs/phase6/exit-packet.md` (at 6.7).
