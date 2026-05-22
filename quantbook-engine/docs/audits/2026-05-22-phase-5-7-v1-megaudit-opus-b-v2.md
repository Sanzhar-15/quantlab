---
title: Phase 5.7 V1 megaudit - Opus-B V2-readiness lane
date: 2026-05-22
audit_target_engine: 6003db4ce2c
audit_target_ide: a517d7c5f71
lane: V2-readiness / forward-leaning hazards
verdict: PASS-WITH-FINDINGS
findings_total: HIGH=2 MEDIUM=7 LOW=6 OBSERVATIONS=5
---

# Phase 5.7 V1 megaudit - Opus-B V2-readiness lane

## Scope

This lane asks one question: **what about V1 constrains V2 in a way the V1 designers didn't notice?** Codex covers protocol/correctness; Opus-A covers doc completeness. Opus-B (this lane) catches "if V2 hits this, V1 has to change too" patterns.

## Verdict

**PASS-WITH-FINDINGS.** V1 is V2-ready in the load-bearing places (BigInt/Uint8Array/mixedCase conventions, Send+Sync compile-asserts, `peer_id_from_bigint` pre-validation pattern). Two HIGH findings should be FIXED IN-CYCLE before V2 begins because they will FORCE V1 re-work otherwise. Seven MEDIUM findings should be DOCUMENTED NOW so V2 planning sees the hazards. Six LOW + five OBS captured for completeness.

---

## HIGH (V1-blocks-V2 issues that need V1 hot-fix or in-cycle documentation)

### HIGH-1: V1 docstring claim "`PeerId::new` rejects the only sentinel Loro would reject" is FALSE — `discard_pending_ops` post-fork `set_peer_id` can in fact fire on `u64::MAX` (Rule 4)

**Repo**: engine.
**File:line**: `crates/ql-collab/src/session.rs:1067-1085` (`discard_pending_ops` docstring) + `crates/ql-types/src/peer.rs:57-61` (`PeerId::new` is `const fn` accepting any u64 unchecked) + `crates/ql-bindings-node/src/lib.rs:153-159` (FFI helper that DOES reject `u64::MAX`).

**Specific issue**: The `discard_pending_ops` docstring at `session.rs:1067-1071` says:

> In practice this is unreachable — `PeerId::new` rejects the only sentinel Loro would reject — but the partial-state shape is real.

This is FALSE. `PeerId::new` (peer.rs:59) is a `const fn` that accepts ANY u64 including `0` and `u64::MAX`:

```rust
pub const fn new(id: u64) -> Self {
    Self(id)
}
```

The rejection lives at TWO layers ABOVE: (a) `CollabSession::new`/`from_snapshot` (`assert_ne!(peer_id.as_u64(), 0)`), and (b) the napi binding's `peer_id_from_bigint` (which rejects 0 + u64::MAX). Neither one runs again inside `discard_pending_ops`'s `self.log.set_peer_id(self.peer_id.as_u64())?` at session.rs:1103 — by then the session has a stored PeerId from construction, which the FFI guaranteed wasn't 0 or u64::MAX.

So in V1 the docstring claim is "accidentally" correct: the FFI's `peer_id_from_bigint` rejects u64::MAX, and there's no path through V1 to a session with `PeerId(u64::MAX)`. But it's WRONG ABOUT WHY. Once V2 binds `discard_pending_ops` and adds `from_snapshot`-via-binding paths that may construct PeerId from other sources (e.g., reading a presence map's peer key parsed by `parse_peer_key`, which calls `PeerId::new(raw)` at `presence.rs:172` without rejecting u64::MAX), the claim breaks.

This is a Rule 4 violation by exactly the pattern the memory note describes: **negative trait claims OR negative reject claims need positive compile/runtime proof**. The claim "`PeerId::new` rejects the only sentinel" has no positive proof in code — it's an inference from the FFI's behavior at a sibling layer.

**Closure recommendation**: **FIX NOW (doc-only)** — replace the false claim with the actual rationale. The session is constructed via a path that pre-rejects u64::MAX (`peer_id_from_bigint`); the stored `self.peer_id` is therefore non-sentinel by construction. If V2 introduces a code path that constructs `CollabSession` from a `PeerId` not vetted by `peer_id_from_bigint`, this docstring becomes load-bearing. Add a `_ASSERT_PEER_ID_NEW_IS_UNCHECKED` or pin the contract in `peer.rs::PeerId::new`'s docstring.

**Likely convergent**: Codex's "negative claims need positive proof" pattern may also catch this if their Rule-4 sweep hits the FFI's PeerId::MAX docstring.

---

### HIGH-2: Transport binding shape — V1's `attach_transport<T: Transport + Send + 'static>` generic is INCOMPATIBLE with the obvious V2 napi shape (opaque type + factory pattern)

**Repo**: engine.
**File:line**: `crates/ql-collab/src/session.rs:693-705` (`attach_transport` signature).

**Specific issue**: V1's `attach_transport` is generic over `T: Transport + Send + 'static`:

```rust
pub fn attach_transport<T: Transport + Send + 'static>(
    &mut self,
    transport: T,
) -> Option<Box<dyn Transport + Send>>
```

This generic parameter is RUST-ONLY. napi-rs CANNOT generate JS bindings for generic methods — each napi method generates ONE C ABI symbol. The V2 binding will need EITHER:

**Option A (single opaque)**: A `Transport` napi class that wraps `Box<dyn Transport + Send>`, with factory functions per impl:
```rust
#[napi]
impl Transport {
    #[napi(factory)]
    pub fn loopback_pair() -> (Transport, Transport) { ... }
    #[napi(factory)]
    pub async fn websocket_connect(url: String) -> Result<Transport> { ... }
}
#[napi]
impl CollabSession {
    pub fn attach_transport(&mut self, transport: &mut Transport) -> Option<...> { ... }
}
```

But this requires the V1 `attach_transport` to accept a `Box<dyn Transport + Send>` DIRECTLY (not a generic type). The V1 signature can't be called from the binding without an unsafe transmute or a wrapper crate.

**Option B (mirror each impl)**: separate `LoopbackTransport`/`WebSocketTransport` napi classes, each with its own `CollabSession::attach_websocket_transport(...)`/`attach_loopback_transport(...)`. Forces N methods per session, ugly.

**Option C (no public binding generic)**: V2 adds a sibling sync method `attach_transport_boxed(&mut self, boxed: Box<dyn Transport + Send>)` that's the actual entry point for the napi layer; the generic stays as a Rust convenience.

Today V1 ships ONLY the generic. Adding the boxed sibling later is NON-BREAKING (it's a new method), but the V2 planner needs to know NOW because:
1. The V1 exit packet doesn't mention this generic-vs-binding tension.
2. Without it documented, a V2 audit might flag "why are there two attach methods?" as a smell.
3. The mirror choice for `Transport` opaque class is a design decision that should happen before binding code lands.

**Closure recommendation**: **DOCUMENT NOW** in the V1 exit packet's "Cross-repo coordination notes for V2" section — pick Option A as the recommended path, add a backlog item to introduce the boxed sibling in V2's first commit. Note that the V1 generic stays as the Rust-side convenience and is not deprecated.

**Likely convergent**: Codex may flag this as a protocol/cross-cutting issue. Opus-A's docs lane will see the V1 exit packet's silence here.

---

## MEDIUM (V2 needs careful design now; document the hazard so it's not re-discovered)

### MEDIUM-1: WebSocketTransport's `connect()` is async — V2 napi binding interaction with the IDE loader's sync `suiteSetup` preload is unspecified

**Repo**: engine (ql-collab-ws) + IDE (loader.ts).
**File:line**: `crates/ql-collab-ws/src/lib.rs:353` (`pub async fn connect(url: &str) -> Result<Self, WebSocketError>`) + `extensions/quantlab/test/quantbook-roundtrip.test.ts:65-80` (`suiteSetup` is sync).

**Specific issue**: WebSocketTransport's only constructor is `async fn connect(url) -> Result<Self, WebSocketError>`. The connect path involves DNS, TCP, and HTTP upgrade — all async. V2 binding has three plausible shapes:

1. **napi-rs `AsyncTask` / `#[napi(async)]`**: returns a JS `Promise<Transport>`. Caller `await`s it. Requires V2 to spawn a tokio runtime inside the binding crate (today the binding crate has NO tokio dependency).
2. **Sync wrapper via `tokio::runtime::Runtime::new()?.block_on(...)`**: V2 binding owns a runtime. Each `connect` call blocks the JS thread until handshake completes. **Will freeze the VS Code extension host for the duration**; unacceptable for IDE UX.
3. **`tokio::task::block_in_place` + ambient runtime**: requires the IDE to set up tokio runtime context FIRST. Adds bootstrapping complexity to the loader.

V1 is purely sync. The V1 exit packet doesn't say which shape V2 will take. The choice has cascading effects:
- Option 1 requires the V1 IDE loader's sync `suiteSetup(loadQuantbookEngine())` pattern to ALSO accept an async preload — currently a single sync line, would become `await loadQuantbookEngine()` if the binding goes fully async-first.
- Option 2 mandates a tokio dependency in `ql-bindings-node` that V1 deliberately avoided.
- Option 3 forces the IDE to bootstrap a tokio runtime visible to the binding — complex on Windows where `block_in_place` semantics differ.

V1 `quantbook-roundtrip.test.ts:65` uses synchronous `suiteSetup(function() { ... loadQuantbookEngine() })`. Test mocha allows async `suiteSetup` (return a Promise), so the migration path is open — but the V1 docs don't flag it.

**Closure recommendation**: **DOCUMENT NOW** — add to V1 exit packet's "V1 deferred to V2" table a row for "WebSocketTransport async-connect binding shape" with the three options. Recommend Option 1 (`AsyncTask`) as the V2 default for explicit async semantics. Document that the IDE loader's `loadQuantbookEngine()` stays sync but consumers of WebSocketTransport will use `await`.

**Likely convergent**: Codex may catch this as a runtime-layer concern.

---

### MEDIUM-2: `WebSocketTransport::flush_pending` uses `Condvar::wait_timeout` (sync blocking) — invoking it from V2's JS-bound `flushPending()` will block the V8 event loop

**Repo**: engine (ql-collab + ql-collab-ws).
**File:line**: `crates/ql-collab/src/session.rs:785-791` (`flush_pending_to_transport`) + `crates/ql-collab-ws/src/lib.rs:733-760` (`flush_pending`).

**Specific issue**: `flush_pending_to_transport` is sync — it eventually calls `WebSocketTransport::flush_pending` which uses `Condvar::wait_timeout(counter, Duration::from_millis(100))` in a loop. The docstrings (`session.rs:779-784`, `transport.rs:215-224`) say:

> Calling from inside a tokio task body will block the runtime worker. Wrap with `tokio::task::block_in_place` (multi-thread runtime) or `tokio::task::spawn_blocking`.

But the V1 binding for `flushPending()` (when V2 adds it) would inherit the SAME hazard for JS: calling `session.flushPending()` from a JS event-loop tick BLOCKS V8 until the writer task catches up. The VS Code extension host is single-threaded; a 10-second flush stalls the entire extension. There's no `block_in_place` equivalent for V8.

V1 doesn't bind `flushPending` so the hazard isn't reachable in V1. But V2 WILL bind it (it's in the V1 deferred list as "Transport binding ⇒ flush_pending_to_transport binding"). The V2 binding MUST be `#[napi(ts_args_type = "...")]` async + spawn the blocking call onto a worker thread via napi's `AsyncTask`, OR document that the JS-side caller is responsible for not calling it from a busy main thread.

**Closure recommendation**: **DOCUMENT NOW** — add a row to V1 exit packet's "V1 deferred to V2" for "flushPending() must bind via napi AsyncTask, not sync — Condvar::wait_timeout blocks V8". This is a CLAUDE.md no-fallback discipline matter: surfacing the blocking nature loudly at binding-time is right; a sync binding would silently freeze the IDE.

**Likely convergent**: Codex may catch this in the async/sync analysis.

---

### MEDIUM-3: Full Op enum binding (V2 deferred item) — `#[serde(tag = "kind")]` + `#[non_exhaustive]` Op shape is napi-incompatible

**Repo**: engine.
**File:line**: `crates/ql-oplog/src/op.rs:40-43`:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
#[non_exhaustive]
pub enum Op {
```

**Specific issue**: napi-rs cannot directly bind a non-exhaustive Rust enum with 16 variants of complex shape (struct variants with `Vec<Op>` recursion in `BatchCommit`, `Option<SheetId>` in `SetName`, etc.). The V2 binding will have to choose:

1. **Serde JSON pass-through**: V2 binds `appendOp(opJson: string)` that takes a JSON string matching `Op`'s `#[serde(tag = "kind")]` shape. Caller stringifies in JS. Loses type safety in TS; lots of room for bugs.
2. **Per-variant convenience methods**: V2 adds `appendPutFormula(...)`, `appendAddSheet(...)`, etc. — one method per Op variant. Mirrors V1's `appendPutValue` pattern, but means 16 methods. The `BatchCommit { ops: Vec<Op> }` variant is the hard one: can't be a flat method-arg list.
3. **napi enum binding via custom typedef + serde-json bridge inside the napi layer**: most ergonomic for JS, most work for V2.

V1's choice to expose ONLY `appendPutValue` was the right scope-cutting decision. But V2 audit should compare these three options EXPLICITLY before binding — and the V1 exit packet's "Full Op enum (beyond PutValue) — V1 single-variant convenience" reason is too thin.

The forward hazard: if V2 picks Option 2 (per-variant methods) and V3 wants to add a new Op variant (e.g., a hypothetical `SetCellStyle`), the binding API grows by another method without warning. JSDoc churn, but no protocol break.

If V2 picks Option 1 (JSON pass-through), the V1 method `appendPutValue` becomes redundant — V2 might remove it for orthogonality, which IS a V1 breaking change.

**Closure recommendation**: **DOCUMENT NOW** — add a paragraph to the V1 exit packet's Decision 4 ("Single Op variant at V1") explicitly listing the three V2 options and the one that preserves `appendPutValue`. Recommend Option 2 (per-variant methods) so `appendPutValue` stays valid as the "shortcut for the common case." Also note that V2 should consider exposing `appendOp(opJson: string)` as the LOW-level escape hatch + keep per-variant methods as the ergonomic surface.

**Likely convergent**: Opus-A docs lane will see the thin justification for Decision 4.

---

### MEDIUM-4: Undo group RAII (`UndoGroupGuard`) is fundamentally INCOMPATIBLE with JS — V2 binding shape needs explicit close() + try/finally pattern

**Repo**: engine.
**File:line**: `crates/ql-collab/src/session.rs:1747-1780` (`UndoGroupGuard` struct + `Drop` impl).

**Specific issue**: V1 exit packet line 156 lists "Undo/redo binding (UndoGroupGuard RAII across FFI)" as deferred to V2. The hazard is that JS has NO equivalent to Rust's `Drop` for arbitrary objects. The guard pattern across FFI requires one of:

1. **JS `using` declaration (ES2024 / Stage-3)**: requires Node 22+ and the IDE TS config to enable the syntax. VS Code extension host runs Node 20 currently (per V1 quantbook test imports). Forward-only solution.
2. **Manual `close()` + `try/finally`**:
   ```ts
   const guard = session.startUndoGroupScoped();
   try { /* ops */ } finally { guard.close(); }
   ```
   Works today. Requires V2 binding to expose `close()` (idempotent) and document the contract.
3. **Symbol.dispose (TS 5.2+)**: same as Option 1, requires runtime support for `using`.

Today V1's `UndoGroupGuard` IS the Rust API, and the JS shape is undecided. The hazard for V2 design is that the V1 docstring at `session.rs:1631-1660` documents the RAII pattern as panic-safe + ?-safe — both irrelevant to JS. The V2 binding's user-facing TS docstring will need a DIFFERENT explanation focused on the manual close() / try-finally pattern, and the engine docstring should cross-reference.

Additional sub-hazard: napi-rs's `&mut self` borrow lifetime model. The Rust guard holds `&'a mut CollabSession`. The corresponding napi-rs `&mut self` reference doesn't have a lifetime parameter — napi-rs's class instances are wrapped in `RefCell`-like state and the borrow check happens at runtime via panic-on-conflict. If V2 returns an `UndoGroupGuard` napi class that holds a reference back to the `CollabSession` instance, two parallel `session.appendOp` + `guard.appendOp` calls will napi-panic at runtime instead of compiling-fail.

**Closure recommendation**: **DOCUMENT NOW** as a sub-bullet on the V1 deferred "Undo/redo binding (UndoGroupGuard RAII across FFI)" row. Pick the manual close() + try/finally pattern as the V2 default. Document that the V2 napi `UndoGroupGuard` class is independent of the Rust struct (it holds a `Weak`/handle to the session, not a borrow), and that calling session methods directly during a guard's lifetime is safe per JS event-loop single-threadedness.

**Likely convergent**: Possibly Codex on the cross-cutting JS/Rust ownership angle.

---

### MEDIUM-5: PresenceState binding via JSON-passthrough across FFI is the obvious choice but means V2 can't directly typecheck PresenceState — type drift hazard

**Repo**: engine.
**File:line**: `crates/ql-collab/src/presence.rs:75-92` (`PresenceState` struct with 6 fields).

**Specific issue**: `PresenceState` is `serde::{Serialize, Deserialize}`. V2 binding has two options:

1. **JSON string pass-through**: `session.updatePresence(stateJson: string)` — caller serializes. Schema is implicit; TS-side can declare a matching interface but it's not checked at FFI boundary.
2. **napi-rs `Object` mapping**: napi-rs supports automatic struct-to-JS-object mapping via `#[napi(object)]`. Requires a wrapper struct because the original `PresenceState` is in `ql-collab`, not `ql-bindings-node`. The wrapper has to manually keep in sync with engine-side field changes.

The V1 exit packet says "Presence binding (PresenceState shape binding)" deferred. The hazard not flagged: PresenceState's `serde_json::to_string` path inside `update_presence` (session.rs:1442) is the canonical encoding. If V2 picks Option 1, the JS-side TS interface must EXACTLY match the serde-derived JSON shape — including any future fields added in Phase 5.7+ if `#[non_exhaustive]` is ever added. PresenceState is NOT `#[non_exhaustive]` today, so a new field added would be a binary break across peers — but the V2 binding would silently accept old JSON missing the field if any field gets `#[serde(default)]`.

Cleanest: V2 adds `#[non_exhaustive]` to `PresenceState` BEFORE binding so future field additions are non-breaking on the JS side too.

**Closure recommendation**: **V2 BACKLOG ITEM** — add a row to V1 exit packet for "make PresenceState `#[non_exhaustive]` before V2 binding ships." Pre-emptive forward-compat with low cost.

**Likely convergent**: Could be a doc-lane finding too.

---

### MEDIUM-6: `rebuild_workbook` binding (V3) — `FunctionRegistry` is unbindable as-is (HashMap of opaque fn pointers)

**Repo**: engine.
**File:line**: `crates/ql-functions/src/registry.rs:165-167` (`FunctionRegistry { fns: HashMap<&'static str, RegisteredFn> }`) + `crates/ql-collab/src/session.rs:617-638` (`rebuild_workbook(&self, registry: &FunctionRegistry)`).

**Specific issue**: `rebuild_workbook` requires `&FunctionRegistry`. The registry holds fn pointers (`RegisteredFn::Scalar(f)`, etc.) — none of which are JS-bindable. V3 (per V1 deferred) needs to bind this.

The V3 binding's only viable shape: the napi crate exposes a `defaultRegistry()` factory that returns an opaque `FunctionRegistry` napi class wrapping the engine's `default_registry()`. JS-side can't construct or extend the registry — it can only pass the opaque handle to `rebuildWorkbook`.

Hazard: if V3 wants to support JS-defined custom functions (via UDF Phase 6+), this design won't scale. JS-side fn pointers can't cross the napi boundary for evaluation (the fn would have to be called from Rust during replay, requiring the JS event loop to be reachable from Rust — `napi::Reference<Function>` does support this but has heavy per-call overhead and is `!Send`).

V1 deferred this as "Rebuild workbook (D-3 production-visible) — Needs FunctionRegistry binding." The deferral language is correct but understates the hazard: a JS-extensible registry is a Phase 6+ problem, not V3.

**Closure recommendation**: **DOCUMENT NOW** as a sub-bullet — clarify in the V1 exit packet's `rebuild_workbook` deferred row that the V3 binding will be `defaultRegistry()` factory only (no JS-side extensibility), and JS UDFs are out-of-scope until Phase 6.

**Likely convergent**: Less likely than other findings; lane-specific.

---

### MEDIUM-7: Loader cache pattern doesn't account for multi-window (each VS Code window is a separate Node.js process)

**Repo**: IDE.
**File:line**: `extensions/quantlab/src/quantbook/loader.ts:35` (`let cachedModule: QuantbookNativeModule | undefined;`).

**Specific issue**: V1 deferred list line 153 says "Multi-window IDE demo." The implicit assumption is that multi-window will Just Work because each VS Code window is a separate extension host process, so each has its own `cachedModule`. **That's true** — but the V2 design needs to confirm this for two reasons:

1. **Each process loads its own copy of the .dylib via `process.dlopen`**. Two processes loading the same `.dylib` is supported by darwin / Linux / Windows but each gets a SEPARATE address space; no shared state between them. (Standard Node.js native-module behavior.) Confirm via a manual two-window test before V2 ships.
2. **napi-rs internal state**: napi-rs registers each `#[napi]` class with N-API's instance-data registry at module init. Per-process is the granularity; safe across multi-window.
3. **Tokio runtime (V2's `WebSocketTransport`)**: if V2's binding uses a single global tokio runtime, that's PER-PROCESS — each window has its own. Fine for V2.

The hazard: today the V1 loader uses a global `cachedModule` module-level variable. That's per-process. Cargo's cdylib build emits one `.dylib` that's safe to load multiple times into different processes. No V1 issue.

But: a future V2 "Workspaces" feature (a single VS Code window with multiple workspace folders, each holding a `.qbook`) would want ONE engine load per window — which the current cache does correctly via the module-singleton pattern. Multi-window relies on the OS process boundary. The V1 exit packet doesn't explicitly confirm this expectation.

**Closure recommendation**: **DOCUMENT NOW** — add a single sentence to the V1 exit packet's loader section: "Multi-window IDE deployments use the OS-process boundary for engine instance isolation — each extension-host process loads its own `.dylib` via `process.dlopen`. V1's module-level `cachedModule` per-process is correct."

**Likely convergent**: Unlikely; lane-specific.

---

## LOW (note for V2 planner)

### LOW-1: BigInt return for `peerId()` works in V1, but `pendingOpCount()` u32 clamp will break before u32::MAX is theoretically reachable

**Repo**: engine.
**File:line**: `crates/ql-bindings-node/src/lib.rs:323-326`.

VV-math counts (`pending_op_count`) sum per-peer counter deltas; the sum is `u64`. With one 32-bit-counter overflow per peer, `pending_op_count() as u32` is mostly fine — but with a megabuilder workflow that imports a 100-peer snapshot, each peer at counter ~40M, total is `~4B` ≈ u32::MAX in worst case. Not unreachable. V2's BigInt switch is the right call; flagging that the "practically unreachable" docstring claim at lib.rs:285 should say "reachable in heavy multi-peer workflows."

**Closure recommendation**: V2 BACKLOG ITEM (already on the list as "BigInt return for opCount / pendingOpCount / mergeBytes").

---

### LOW-2: `Op::BatchCommit { ops: Vec<Op> }` recursive serde — V2 enum binding via JSON pass-through must guard against unbounded nesting

**Repo**: engine.
**File:line**: `crates/ql-oplog/src/op.rs:176` (`BatchCommit { ops: Vec<Op> }`).

If V2 picks the JSON-pass-through binding for Op (MEDIUM-3 Option 1), a malicious caller sending `{kind: "BatchCommit", ops: [{kind: "BatchCommit", ops: [...]}]}` deeply nested could blow the serde stack. The engine-side serde derive doesn't limit recursion. Same hazard as today's serde for `Op` in tests.

**Closure recommendation**: V2 BACKLOG ITEM — add a serde-side max-nesting guard if Op JSON pass-through is chosen.

---

### LOW-3: `attach_transport` returns the previous transport boxed; consumer must drop it — V2 binding must surface this "must_use" semantic somehow

**Repo**: engine.
**File:line**: `crates/ql-collab/src/session.rs:693-705` (`attach_transport`) + `session.rs:718-725` (`detach_transport` has `#[must_use]`).

`detach_transport` has `#[must_use]` (line 718) but `attach_transport` returns `Option<Box<dyn Transport + Send>>` without it. If V1 callers drop the return implicitly, fine — but the V2 binding surface will need to either:
- Drop the previous transport automatically in JS (let the napi `Box` wrapper finalize it on GC), which matches today's behavior in IDE usage.
- Explicitly return it as a `Transport` napi class and warn callers via TS docstring that `attach_transport`'s return value is the orphaned previous transport.

Today's V2 design will probably default to "drop on GC," which is fine — but the V2 audit should confirm that finalizing a `Box<dyn Transport + Send>` that contains a `WebSocketTransport` correctly aborts the tokio tasks via the `Drop` impl on ql-collab-ws/lib.rs:609. (It does, per V1 audit.)

**Closure recommendation**: V2 BACKLOG ITEM.

---

### LOW-4: `session.ts::appendPutValueValidated` row/col upper-bound check uses `> 0xFFFFFFFF` (i.e., `> 4294967295`), but Number.isInteger + the BigInt boundary already cover this — defense-in-depth is fine

**Repo**: IDE.
**File:line**: `extensions/quantlab/src/quantbook/session.ts:69-74`.

The upper-bound check `row > 0xFFFFFFFF` is unreachable in practice because `Number.isInteger(2**32)` returns true but `row > 4294967295` is what triggers — fine. The reason this is a LOW: V2's switch to BigInt for row/col would invalidate these checks (Number.isInteger on a BigInt is false). When V2 introduces BigInt-bound rows (probably never; addresses stay u32), revisit.

**Closure recommendation**: V2 BACKLOG ITEM (low-priority).

---

### LOW-5: `WebSocketTransport::Drop` aborts both tasks via `JoinHandle::abort` — V2's napi Drop must explicitly call this OR the WebSocket tasks leak per-session

**Repo**: engine.
**File:line**: `crates/ql-collab-ws/src/lib.rs:609-638` (`Drop` impl).

napi-rs class instances are dropped via `napi_finalize` when JS GC reclaims them. The Rust `Drop` impl on `WebSocketTransport` runs synchronously. This is FINE — but V2 binding code that wraps `Box<dyn Transport + Send>` in a napi class must ensure the `Drop` propagates through the `Box`. Standard Rust behavior, but worth a CI test in V2.

**Closure recommendation**: V2 BACKLOG ITEM (add finalize/drop test).

---

### LOW-6: Loader's `findExtensionDir` doesn't handle Windows path normalization for the `path.join('extensions', 'quantlab')` ending check

**Repo**: IDE.
**File:line**: `extensions/quantlab/src/quantbook/loader.ts:118` (`cur.endsWith(path.join('extensions', 'quantlab'))`).

`path.join` is platform-aware so `extensions\quantlab` on Windows, `extensions/quantlab` on POSIX. The `endsWith` should work. BUT: if a developer's checkout has the path with a trailing slash, or if the symlink resolution leaves a slightly different ending, the check fails. V2 should test on Windows (V1 exit packet flags Windows `.dll` naming but not this).

**Closure recommendation**: V2 BACKLOG ITEM (Windows-specific test in V2 publish pipeline).

---

## OBSERVATIONS (context for V2 planning, no action)

### OBS-1: V1 docstring conventions established for V2 to follow

The V1 binding establishes patterns that V2 should mechanically follow. They are not documented as conventions anywhere; just inferred from V1's code. List:

1. **mixedCase JS-side method names** (`#[napi(js_name = "...")]`). Examples: `appendPutValue`, `mergeBytes`, `opCount`, `pendingOpCount`, `hasPendingFlush`, `peerId`, `exportBytes`, `fromSnapshot`.
2. **Suffix-less getters**, no `get_` prefix (`peerId()` not `getPeerId()`).
3. **`BigInt` for u64-domain fields** (peer IDs, future op count). `number` for u32-and-below fields with explicit clamping documented.
4. **`Uint8Array` for byte buffers** in both directions (no `Buffer` to keep portable to browser bindings).
5. **Engine `Result<T, E>` errors converted via `Error::from_reason(format!("{e}"))`** — preserves the Display impl. V2 should keep this pattern when binding methods that return Result.
6. **Pre-validate at the FFI boundary** for inputs that could trigger engine-side `assert_*!` (per V1 audit Codex H1 + Opus H3). Apply mechanically to every new `#[napi]` method.
7. **TS-side wrapper for ToUint32 hazards** (`appendPutValueValidated`). Apply to every new method that takes JS-Number arguments destined for `u32`/`u16`.
8. **`#[napi(factory)]` for static constructors** (`fromSnapshot`).

V1 exit packet's "Cross-repo coordination notes for V2" mentions "ship pairs," "audit lane parity," and a few other coordination patterns, but NOT this convention list. V2 should formalize them somewhere — either by extending the V1 exit packet's conventions section, OR by adding a `docs/architecture/ide-consumer-contract.md` extension.

**Closure recommendation**: nice-to-have, NOT load-bearing. V2 can codify this in its own ship cycle.

---

### OBS-2: V1's `peer_id_from_bigint` pre-validation rejected u64::MAX via Rule 4 / closure-test discovery

The V1 audit closure-cycle BONUS finding (V1 exit packet line 146) found the PeerID::MAX sentinel via positive boundary testing. V2 binding methods that take BigInt inputs (e.g., `attachTransport`'s future config payloads, presence map iteration) should run the same closure-test pattern — write a boundary test for every distinct u64 input BEFORE the binding ships. This is Audit Discipline Rule 4 paying off; document it as the V2 process.

---

### OBS-3: WebSocketTransport is `Send + Sync` even though only `Send` is required — opens future `Arc<WebSocketTransport>` patterns

Per `crates/ql-collab-ws/src/lib.rs:781` (`assert_impl_all!(WebSocketTransport: Sync)`), the WebSocketTransport happens to be Sync. The V1 docs at `lib.rs:259-280` correct an earlier "claimed !Sync" mistake. V2 binding doesn't NEED Sync, but if a future "shared transport across V8 isolates" or "shared transport across N-API worker threads" pattern emerges, the Sync bound enables it. No-op observation for V1.

---

### OBS-4: V1 binding's `inner: CoreCollabSession` field exposure — V2 may want to add helper methods that bypass the napi layer for shared multi-method workflows

The V1 binding's `CollabSession` napi class holds `inner: CoreCollabSession`. The Rust-side methods all delegate to `self.inner.XXX()`. V2 introducing a complex method (e.g., `attachTransportAndFlush(transport, mode)`) might want to do multiple `self.inner.YYY()` calls atomically without going back through JS — easy, just write a new `#[napi]` method that calls both. No structural issue. Worth noting because a future "binding-side composite method" pattern is a clean way to add high-level UX without changing the engine surface.

---

### OBS-5: V1 binding crate is `cdylib + napi-rs`; persistence `.qbook` import/export (V2 deferred) can layer on without changes

The V1 surface (`exportBytes()` / `mergeBytes()`) operates on RAW Loro snapshot bytes, NOT on the `.qbook` envelope format. Per `session.rs:496-505` (`export_bytes` docstring) the V2 persistence story is "use `ql_io::oplog_persistence::save_workbook_with_oplog`." V2 binding for persistence can introduce a separate `Workbook` napi class that holds an envelope handle and exposes `loadFromQbookFile(path) -> Workbook` + `saveToQbookFile(workbook, path) -> void`. **The V1 `CollabSession`'s `exportBytes()` does NOT preclude this** — they operate at different layers (CollabSession = ops log, Workbook = envelope+oplog+sheets+formats). V2 layering is clean.

This is the lane's positive finding: V1's choice to expose raw Loro bytes through `exportBytes()`/`mergeBytes()` does NOT box V2 into a sub-optimal persistence path. V2/V3 can add the structured `Workbook` napi type without touching V1.

---

## Cross-reference to V1 audit cycle

This audit complements the per-step V1 audit transcripts at:
- `docs/audits/2026-05-22-phase-5-7-v1-codex.md`
- `docs/audits/2026-05-22-phase-5-7-v1-opus.md`

The V1 closure cycle caught 3 HIGH findings (cache poisoning, catch_unwind doc, u32 ToUint32 coercion). This megaudit V2-readiness lane found 2 additional HIGH-level concerns (Rule 4 docstring drift on PeerId::new sentinel logic; Transport binding shape forward-incompatibility) plus 7 MEDIUMs that should be documented in the V1 exit packet before V2 work begins.

## Recommended action — in-cycle additions before V2 begins

Three concrete deltas to the V1 exit packet `docs/phase5/5-7-v1-exit-packet.md`:

1. **HIGH-1 closure**: fix the `discard_pending_ops` docstring at `session.rs:1067-1071` to remove the false "`PeerId::new` rejects" claim and replace with the actual rationale (FFI pre-validates; PeerId::new is itself unchecked by design).

2. **HIGH-2 closure**: add a new section to V1 exit packet's "Cross-repo coordination notes for V2" titled "Transport binding shape — recommended path." Document the three options + pick Option A (opaque `Transport` napi class + factory functions per impl) as the V2 default. Note that V2's first commit should add `attach_transport_boxed(&mut self, boxed: Box<dyn Transport + Send>)` as the binding-friendly sibling.

3. **MEDIUM-1 through MEDIUM-7 closures**: extend the V1 exit packet's "V1 deferred to V2" table with sub-bullets per deferred item listing the design constraints found here. Specifically:
   - "Transport binding (Loopback, WebSocket)" → add: WebSocketTransport's `connect()` is async; bind via `#[napi(async)]` / AsyncTask, not sync wrapper.
   - "Undo/redo binding" → add: UndoGroupGuard RAII translates to JS via `close()` + try/finally; not via `using`/Drop.
   - "Presence binding" → add: make `PresenceState` `#[non_exhaustive]` before V2 binding ships.
   - "rebuild_workbook" → add: V3 binding is `defaultRegistry()` factory only; JS-extensible registry is Phase 6+.
   - "Full Op enum (beyond PutValue)" → add: V2 should keep `appendPutValue` AND add per-variant methods (Option 2) for ergonomics + future-compatibility.
   - "Multi-window IDE demo" → add: relies on OS-process boundary for engine instance isolation.
   - `flush_pending_to_transport` (deferred to V2 implicitly via Transport binding) → bind via `#[napi(async)]`, never sync — `Condvar::wait_timeout` blocks V8.

None of these require Rust code changes today. All are V1-exit-packet doc additions.

## Lane summary

V1 substrate is solid for V2. The two HIGH findings are documentation hygiene with Rule 4 implications — fix in-cycle. The seven MEDIUMs are V2 design constraints that V1's exit packet should document NOW so the V2 planning session sees them. V1 does NOT need code changes for V2-readiness.
