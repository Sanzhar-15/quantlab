---
title: Phase 5.7 V1 exit packet
date: 2026-05-22
status: ACTIVE — Phase 5.7 V1 SHIPPED via cross-repo ship + per-step closure + 3-way megaudit closure + docs finalize
ship_commit_range_engine: 677ee03ee8b (V1 ship) → 6003db4ce2c (V1 audit closure) → c47bc0816b5 (V1 megaudit closure) → c7406aa82cd (docs finalize — audit transcripts committed)
ship_commit_range_ide: 1a7fc8bbe3f (V1 ship) → a517d7c5f71 (V1 audit closure) → 97e0513d134 (V1 megaudit closure)
predecessor_exit_packet: docs/phase5/v2-v4-v1-exit-packet.md (V2 V4 V1)
audit_cycle_total: 1 ship + 1 per-step closure + 1 three-way megaudit closure = 3 cycles, 5 audit transcripts (Codex per-step + Opus per-step + Codex megaudit + Opus-A docs megaudit + Opus-B V2-readiness megaudit)
test_count_at_v1_exit: workspace 4461 / 0; ql-bindings-node 2 unit tests; IDE quantbook 26 mocha tests (10 at V1 ship → 20 after per-step closure → 26 after megaudit closure)
phase_5_8_readiness: UNBLOCKED — full Phase 5 surface (V1, D-1, 5.3, 5.5 V2 V2/V3/V4 V1, 5.6, 5.7 V1) now in scope for megaudit. **Recommended to defer until after 5.7 V2 (Transport binding) ships, because V1 binding is too thin for megaudit to catch interesting cross-cutting state — V2 multiplies the FFI surface area and gives the megaudit real material to work on.**
---

# Phase 5.7 V1 — First IDE Binding to the Quantbook Engine

## Summary

Phase 5.7 V1 is the FIRST IDE binding to the quantbook engine since the engine has existed. Cross-repo ship across two repos:

- **Engine** (`quantlab-quantbook/quantbook-engine`, `feat/quantbook-engine`): new `crates/ql-bindings-node/` crate using napi-rs 3.x to expose `CollabSession` as a JS class. cdylib output, V1 surface is the minimum coherent round-trip.
- **IDE** (`quantlab/quantlab`, `feat/visualise-v1`): new `extensions/quantlab/src/quantbook/` (loader + types + TS wrapper) + `extensions/quantlab/src/commands/quantbookCommands.ts` (demo command) + `extensions/quantlab/test/quantbook-roundtrip.test.ts` (26 mocha tests: 10 V1 ship + 10 per-step closure + 6 megaudit closure).

V1 deliberately scoped to a MINIMUM vertical slice: napi-rs cdylib exposing `CollabSession` for a TS round-trip. NO Transport binding, NO multi-window IPC, NO real cell-grid UI. V2 picks up Transport. V3 picks up cell grid + persistence.

V1 went through THREE audit cycles (per-step audit + 3-way megaudit + docs finalize). The megaudit's V2-readiness lane (Opus-B at `docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md`) is the canonical V2 design reference — V2 planning MUST read it.

## Architectural decisions locked

### Decision 1: napi-rs over WASM or subprocess

| Option | Tokio | Memory | Maturity | V1 pick? |
|--------|-------|--------|----------|----------|
| **napi-rs** | full multi-threaded | direct shared | Prisma / Rspack / Turbopack | **YES** |
| WASM (browser) | no threads | serialize | mature but no tokio | NO — would force engine async rewrite |
| subprocess + JSON-RPC | own runtime | serialize+IPC | trivial | NO — UX cost on hot paths |

napi-rs is the only option preserving the engine's tokio runtime AND giving the IDE direct memory access for hot paths.

### Decision 2: Pre-validate at FFI boundary instead of `#[napi(catch_unwind)]`

The V1 smoke test caught a critical Rule 4 / FFI panic-safety hazard: `PeerId(0) → CollabSession::new`'s `assert_ne!` → Node process abort with "failed to initiate panic, error 5, aborting". Per V1 audit (Codex H1 + Opus H3 convergent): napi-rs 3.x does NOT wrap entry points in `catch_unwind` by default — it's opt-in via `#[napi(catch_unwind)]`.

V1 design: **pre-validate inputs in the FFI helper** (`peer_id_from_bigint`) rather than using `catch_unwind`. Rationale:
- Pre-validation surfaces precise, actionable error messages.
- `catch_unwind` would swallow the engine's panic into a generic JS error, hiding the engine bug.
- Pre-validation prevents the FFI boundary from being a safety crutch — engine code stays panic-free as a CONTRACT, not because the boundary catches.

V2+ each new `#[napi]` method MUST sweep the engine for FFI-reachable `assert_*!`, `panic!`, `unwrap`, `expect` AND pre-validate the same way (see V2 backlog).

### Decision 3: Engine `.dylib` dev-path resolution (V2 publish pipeline deferred)

V1 IDE loader resolves the engine binary via:
1. `QUANTBOOK_ENGINE_PATH` env var (primary, documented).
2. Walk-up discovery: find `extensions/quantlab/package.json` (anchored by `name: "quantlab"` AND path-ending), then `..` thrice to the parent workspace dir containing both `quantlab/` (IDE repo) and `quantlab-quantbook/` (engine worktree).

V1 audit closure (Opus M2 + Codex M3) corrected the anchor from `code-oss-dev` (root IDE package.json) to `quantlab` (extension package.json) because the engine worktree at `quantlab-quantbook/` shares the same root `code-oss-dev` package.json — a collision that would resolve to the wrong directory in some checkout layouts.

V2 publish pipeline (deferred): use `@napi-rs/cli publish` to ship the `.node` file as part of the extension package, eliminating the walk-up entirely. Loader switches to `require.resolve('@quantlab/engine-bindings/native.node')`.

### Decision 4: Single Op variant (PutValue) at V1

V1 binding exposes ONE convenience method `appendPutValue(sheet, row, col, value)` rather than the full Op enum. Rationale:
- Demonstrates the round-trip with minimum surface area
- Full Op enum binding requires careful FFI shape for ~12 variants
- Engine's underlying `append_op(Op)` is what V2 will bind directly

### Decision 5: `BigInt` for PeerId (matches u64 domain)

PeerId is `u64` Rust-side. JS BigInt is the only JS type that represents u64 losslessly. V1 binding uses `BigInt` for `peerId` parameters + return values. Failure modes (negative, >u64, =0, =u64::MAX) are explicitly rejected by `peer_id_from_bigint` with distinct error messages.

## V1 API surface shipped

### Engine `ql-bindings-node` (napi exports)

```typescript
// Free function
function version(): string;

// Class
class CollabSession {
    constructor(peerId: bigint);
    static fromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSession;
    // Megaudit closure (Codex HIGH): row/col are f64 at Rust level (raw JS Number,
    // not ToUint32-coerced), validated finite/non-negative/integer/in-u32 inside.
    // TS sees `number, number` either way. Direct callers bypassing
    // `appendPutValueValidated` now get proper rejection instead of silent wrap.
    appendPutValue(sheet: number, row: number, col: number, value: number): void;
    exportBytes(): Uint8Array;
    mergeBytes(bytes: Uint8Array): number;  // returns post-merge opCount, NOT delta
    opCount(): number;                       // u32 clamped, V2 will switch to BigInt
    pendingOpCount(): number;                // u32 clamped
    hasPendingFlush(): boolean;
    peerId(): bigint;
}
```

### IDE `extensions/quantlab/src/quantbook/` (TS wrappers)

```typescript
// From loader.ts
function resolveEnginePath(): string;
function loadQuantbookEngine(): QuantbookNativeModule;
function quantbookHostInfo(): string;
function _resetQuantbookEngineCacheForTests(): void;  // @internal

// From session.ts
function createSession(peerId: bigint): CollabSessionInstance;
function sessionFromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSessionInstance;
function appendPutValueValidated(  // JS-side input validation (Opus H2 closure)
    session: CollabSessionInstance,
    sheet: number, row: number, col: number, value: number,
): void;
function quantbookEngineVersion(): string;
```

### IDE command

- `quantlab.quantbookDemo` ("Quantbook: Demo Round-Trip") — interactive modal + OutputChannel demo

## V1 audit cycle — findings closed

**Audit verdicts** (cross-repo, parallel lanes):

| Lane | Verdict | HIGH | MEDIUM | LOW | OBS |
|------|---------|------|--------|-----|-----|
| Codex (protocol / correctness) | PASS-WITH-FINDINGS | 3 | 4 | 4 | 4 |
| Opus (adversarial / edge cases) | PASS-WITH-FINDINGS | 3 | 8 | 6 | 7 |

**Convergent findings closed in cycle** (both lanes agree):

1. **`catch_unwind` docstring claim was FALSE** (Codex H1 + Opus H3): doc claimed napi-rs auto-wraps in catch_unwind; verified opt-in only via napi-derive-backend 5.0.4 source walk. Closure: corrected docstring to document the pre-validate strategy + V2 sweep requirement.

2. **u32 ToUint32 silent coercion** (Codex H3 + Opus H2): JS `-1` becomes `u32::MAX` via ECMAScript ToUint32; NaN/Infinity become 0; 2.5 becomes 2. Verified by reading napi-rs 3.9.0 number.rs source. Closure: added `appendPutValueValidated` TS wrapper that pre-validates row/col/value with `Number.isInteger` + `Number.isFinite`. Engine binding ALSO rejects non-finite `value` at FFI boundary (defense in depth). Wired demo command to use validating wrapper. 6 new tests pin the rejection paths.

3. **Cache poisoning in loader** (Codex M1 + Opus H1): `cachedModule` was set BEFORE validation. If validation threw, the bad module stayed cached and subsequent calls returned the poisoned module. Closure: validate FIRST, cache after. Regression test with monkey-patched `process.dlopen`.

4. **`mergeBytes` return semantics doc lied** (Codex M2): docstring said "merged count" implying delta; binding returns post-merge `op_count`. Closure: corrected docstring in `types.ts` to match actual semantics; added test that calls `mergeBytes` twice with same snapshot to verify return is post-merge total, not delta.

5. **Loader worktree namespace collision** (Codex M3 + Opus M2): walk-up anchor on `code-oss-dev` collided because `quantlab-quantbook/` is a worktree with same root package.json. Closure: changed anchor to `extensions/quantlab/package.json` (`name: "quantlab"`) plus path-ending check.

6. **Send/Sync docstring rationale was wrong** (Opus M1, Rule 4 trigger): claimed "napi's internal locking" enforces non-concurrent calls. Verified false by reading napi-rs callback_info.rs — no lock. Real safety is JS event-loop single-threadedness + `napi::Reference<T>: !Send`. Closure: corrected docstring with verified rationale + source citation.

7. **u32::MAX silent clamp on op-count** (Opus M5): three methods clamp `usize → u32`. Closure: docstring discloses the clamp + V2 BigInt plan.

8. **IDE test coupled to Loro empty-merge specifics** (Opus M6): test asserted `assert.throws`; engine contract is "no panic + no partial state" (either Ok-or-Err valid). Closure: loosened test to verify `opCount` unchanged regardless of Ok/Err outcome.

9. **Module doc clone-on-write claim wrong** (Codex L1): napi-rs externalizes/moves the `Vec<u8>` into JS-owned memory, not clone-on-write. Closure: corrected docstring.

10. **NaN/Infinity passthrough** (Opus M4 + Codex H3 sub-finding): `appendPutValue` accepted non-finite f64 values. Closure: FFI-side rejection + TS-side validation + 2 tests.

### Closure-cycle BONUS finding (Rule 4)

The new `BigInt boundary -- u64::MAX accepted, 2^64 rejected` test (Codex L3 closure) DISCOVERED a SECOND Loro sentinel: Loro reserves `PeerID::MAX` in addition to `PeerID(0)`. Surfaced cleanly as `Err` (no panic — FFI boundary intact), but pre-rejected in `peer_id_from_bigint` for symmetry + consistent error messaging. This is Rule 4 paying off: the boundary test caught a constraint the original implementation didn't know about.

## V1 MEGAUDIT cycle — findings closed

After per-step audit closure shipped (commits `6003db4ce2c` engine + `a517d7c5f71` IDE), a deep 3-way megaudit ran in parallel lanes per the audit-discipline memory's phase-level closure pattern. Megaudit commits: engine `c47bc0816b5` + IDE `97e0513d134`.

**Audit verdicts** (3-way, all PASS-WITH-FINDINGS):

| Lane | Focus | HIGH | MEDIUM | LOW | OBS | Transcript |
|------|-------|------|--------|-----|-----|------------|
| Codex | protocol + correctness | 1 | 4 | 4 | 4 | `docs/audits/2026-05-22-phase-5-7-v1-megaudit-codex.md` |
| Opus-A | docs completeness | 2 | 9 | 11 | 5 | `docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-a-docs.md` |
| Opus-B | V2-readiness / forward-leaning | 2 | 7 | 6 | 5 | `docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md` |

**5 HIGHs all closed in cycle**:

1. **Codex HIGH (convergent w/ original Opus H2)**: engine `appendPutValue` still ToUint32-unchecked for direct callers. The per-step closure pushed validation into the TS wrapper `appendPutValueValidated`, but the wrapper was OPTIONAL — direct callers bypassed it and still hit ECMAScript ToUint32 (`-1 → u32::MAX`, NaN → 0, 2.5 → 2). **Closure**: changed Rust signature from `row: u32, col: u32` to `row: f64, col: f64` at the napi boundary + new `validate_u32_index` helper that rejects non-finite / negative / fractional / out-of-u32-range. 6 new direct-call rejection tests (mocha 20 → 26).

2. **Opus-A HIGH-1**: per-step closure left 4 uncommitted doc fixes — closed via the megaudit closure commit itself.

3. **Opus-A HIGH-2**: `session.rs:609-612` future-tense `rebuild_workbook` claim ("for Phase 5.7 IDE binding to wire"). V1 SHIPPED WITHOUT wiring `rebuild_workbook`. **Closure**: docstring replaced with explicit "Phase 5.7 V1 SHIPPED 2026-05-22 WITHOUT wiring rebuild_workbook — V3 wires" + cross-reference to `PHASE-4-V2-BACKLOG.md` H9.

4. **Opus-B HIGH-1 (Rule 4 violation, AGAIN)**: false `PeerId::new` sentinel claim at `session.rs:1067-1071` ("`PeerId::new` rejects the only sentinel Loro would reject"). Verified FALSE by reading `ql-types/src/peer.rs:57-61` — `PeerId::new` is `const fn new(raw: u64) -> Self { Self(raw) }`, no validation. Actual rejection lives one layer up (in `peer_id_from_bigint` for the FFI path, and `assert_ne!(peer_id.as_u64(), 0)` in `CollabSession::new`). **Closure**: docstring rewritten to attribute rejection to the correct layer + V2+ caveat for any future path that constructs `CollabSession` without going through these guards. This is the THIRD Rule 4 trigger in 5.7 V1 — survived V1 ship + V1 per-step closure; only the megaudit's per-field walk caught it.

5. **Opus-B HIGH-2 (V2 design hazard, NOT a V1 bug)**: V1's `attach_transport<T>` engine method is generic, and napi-rs cannot bind generics. V2 needs `attach_transport_boxed(&mut self, Box<dyn Transport + Send>)` as a sibling Rust method that the napi layer can wrap. Documented in Opus-B megaudit report; deferred to V2 design.

**Convergent MEDIUMs closed**:

- **Opus-A MEDIUM-1 (Rule 4 application)**: binding `CollabSession: !Sync` claim lacked compile proof per audit-discipline Rule 4. **Closure**: added `const _ASSERT_BINDING_COLLAB_SESSION_SEND` positive Send assert + probe-then-commented-out `!Sync` proof (per V2 V4 V1 step 3 pattern).
- **Opus-A MEDIUM-2/3 (stale module docs)**: `transport.rs` + `session.rs` module docs claimed V2 V3 step 5+6 "pending" / V2 V2+V3 "pending". **Closure**: replaced with actual ship history through V2 V4 V1 + V1 IDE binding state.
- **Opus-A MEDIUM-4**: `ide-consumer-contract.md` heading still said "(preview — for Phase 5.7 IDE vertical slice)". **Closure**: rewrote to "Phase 5.7 V1 binds this; V2 + V3 will extend" + status block.
- **Opus-A MEDIUM-5/6/7/8/9**: 5 exit packet docs (this packet, v2-v4-v1, v2-v3, v1, d-1, 5-3) treated 5.7 as future. **Closure**: added status update blocks.
- **Codex MEDIUM (no-fallback violation)**: IDE loader had a 6-hop coarse fallback after `console.warn` when anchor not found — silent failure mode if a stale `.dylib` sat at the coarse path. **Closure**: replaced with explicit `throw` directing caller to set `QUANTBOOK_ENGINE_PATH`.

### 8 V2-readiness items DOCUMENTED for V2 planner (NOT V1 fixes)

These are NOT bugs — they're V2 design constraints the megaudit identified. All in the Opus-B megaudit report, which is the canonical V2-readiness reference. **V2 planning MUST read `docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md` before starting.**

1. **WebSocketTransport's async `connect()`** — V2 napi binding shape decision (napi-rs `AsyncTask` vs `block_on` vs `block_in_place`). Each cascades to IDE loader pattern. Megaudit recommends `#[napi(async)]` / `AsyncTask` (returns JS `Promise`); sync would freeze V8.
2. **`flush_pending` sync `Condvar::wait_timeout`** — V2 must bind via `#[napi(async)]` or freeze V8. JS event loop has no `block_in_place` equivalent.
3. **Full Op enum** binding — 3 options laid out (JSON pass-through / per-variant methods / `#[napi(object)]` mapping). `BatchCommit { ops: Vec<Op> }` recursion is the hard case.
4. **UndoGroupGuard RAII** vs JS Drop — bind via `close()` + `try/finally` pattern (JS has no Drop for arbitrary objects; ES2024 `using` requires Node 22+ which VS Code's electron may not yet meet).
5. **PresenceState binding** — add `#[non_exhaustive]` to `PresenceState` BEFORE V2 ships, to allow non-breaking field additions on the JS side too.
6. **`rebuild_workbook`'s `FunctionRegistry`** — V3 needs `defaultRegistry()` factory only (no JS-side UDF extensibility until Phase 6+).
7. **Multi-window cache pattern** — confirmed safe via OS-process boundary (each VS Code window = separate extension host process = separate `.dylib` load).
8. **`attach_transport<T>` generic** — see HIGH-2 above. V2 needs `attach_transport_boxed` sibling.

## V1 deferred to V2

| Item | Reason |
|------|--------|
| Transport binding (Loopback, WebSocket) | Needs full enum + lifecycle JS-side |
| Multi-window IDE demo | Depends on Transport binding |
| Real cell-grid UI | Own arc — needs paste-fill-down, formula UI, rendering |
| `.qbook` persistence | Needs file-format binding + import/export |
| Undo/redo binding | UndoGroupGuard RAII translation across FFI |
| Presence binding | PresenceState shape binding |
| Format / D-1 binding | FormatId enum needs careful FFI shape |
| `rebuild_workbook` (D-3 production-visible) | Needs FunctionRegistry binding |
| Full Op enum (beyond PutValue) | V1 single-variant convenience |
| Engine assertion sweep | V2: each new `#[napi]` method sweeps engine for FFI-reachable asserts |
| `#[napi(catch_unwind)]` opt-in for defense in depth | V2 option; V1 chose pre-validate |
| SharedArrayBuffer defensive copy | V2: clone bytes at FFI boundary OR detect SAB via `napi_get_arraybuffer_info` |
| BigInt return for opCount / pendingOpCount / mergeBytes | V2: replace u32 clamp |
| `mergeBytesDelta` for "newly merged" count | V2 if use case materializes |
| `@napi-rs/cli` publish pipeline → `.node` artifact | V2: eliminates `process.dlopen` cast |
| CI `QUANTBOOK_REQUIRE_ENGINE=1` enforcement | V2: ensure missing-engine doesn't silently pass CI |
| Loader `console.warn` on default-discovery path | V2: nudge users to set `QUANTBOOK_ENGINE_PATH` explicitly |
| Windows-specific `.dll` naming (no `lib` prefix) | V2: Cargo cdylib convention differs on Windows |

## V1 capability reference

For V2+ work, the engine substrate available through the V1 binding:

| Substrate feature | Engine API | V1 IDE access | V2+ needs |
|-------------------|-----------|---------------|-----------|
| Op log append | `CollabSession::append_op` | `appendPutValue` (single-variant) | full Op enum |
| Snapshot export | `CollabSession::export_bytes` | `exportBytes()` | — |
| Snapshot/delta import | `CollabSession::merge_bytes` | `mergeBytes()` | — |
| `from_snapshot` | `CollabSession::from_snapshot` | `fromSnapshot` static | — |
| Op count | `CollabSession::op_count` | `opCount()` | BigInt return |
| Pending-op count (V2 V4 V1 step 2) | `CollabSession::pending_op_count` | `pendingOpCount()` | — |
| Has-pending-flush (V2 V3 step 3) | `CollabSession::has_pending_flush` | `hasPendingFlush()` | — |
| Discard pending (V2 V4 V1 step 5) | `CollabSession::discard_pending_ops` | — | V2 |
| Transport (any variant) | `CollabSession::attach_transport` etc. | — | V2 (Transport binding) |
| Flush variants | `flush_to_transport` etc. | — | V2 |
| Undo/redo | `CollabSession::undo` etc. | — | V2 |
| Presence | `CollabSession::update_presence` etc. | — | V2 |
| Rename repair (5.3) | `CollabSession::rebuild_workbook` | — | V3 (D-3 production visibility) |
| Format ID (D-1) | `Op::SetCellFormat` etc. | — | V2 / V3 |

## Verification at V1 exit (post-megaudit)

- **Engine workspace tests**: 4461 / 0 (workspace, `--test-threads=1`)
- **ql-bindings-node Rust tests**: 2 / 2 (`version_smoke`, `collab_session_roundtrip_via_rust`)
- **IDE quantbook mocha tests**: **26 / 26** (was 10/10 at V1 ship; 20/20 after per-step closure; 26/26 after megaudit closure added 6 direct-engine-call rejection tests)
- **fmt + clippy**: clean on both repos
- **VS Code interactive smoke**: deferred to V2 explicit verification cycle (per CLAUDE.md "if you can't test the UI, say so explicitly")
- **Audit transcripts tracked**: 5 in `docs/audits/2026-05-22-phase-5-7-v1-*` (Codex per-step + Opus per-step + Codex megaudit + Opus-A docs megaudit + Opus-B V2-readiness megaudit). Codex transcripts pulled from parent worktree's `.codex-*` artifacts into engine `docs/audits/` at the docs-finalize commit (`c7406aa82cd`).

## Cross-repo coordination notes for V2

**Status update (2026-05-22, post-V2.4)**: V2.1 + V2.2 + V2.3 + V2.4 SHIPPED (4-of-8 cycles done). See `.plans/_active.md` for full V2 multi-cycle plan + V2.5+ backlog. The V2 conventions from V1 (below) held through all 4 cycles; V2.3 audit FAIL + V2.4 sound reintroduction validated the "ship → audit → close" discipline. **V2 exit packet pending** — lands at V2.8 with the 3-way megaudit. V2 audit transcripts in `docs/audits/2026-05-22-phase-5-7-v2-{1,2,3,4}-{codex,opus}.md`.

V2 work will continue across both repos. Conventions established at V1:

1. **Ship pairs**: every binding surface change has TWO commits — one per repo. Reference each other in commit messages.
2. **Audit lane parity**: Codex + Opus run in parallel per audit cycle, cross-repo prompts.
3. **Closure commits**: same pattern — two commits, one per repo, audit-driven.
4. **Test infrastructure**: IDE-side tests can use `_resetQuantbookEngineCacheForTests()` + monkey-patched `process.dlopen` for failure-mode regression tests. Engine-side tests go in `#[cfg(test)]` mod within `ql-bindings-node`.
5. **Plan files**: keep in engine `.plans/_active.md` (engine drives the binding surface design).
6. **Audit-discipline Rule 4 still load-bearing**: this cycle discovered TWO new findings (catch_unwind doc + PeerID::MAX sentinel) that only positive proof / boundary tests would catch. V2 must continue this discipline.

## Reading order for V2 / next session

1. **`memory/current_work.md`** — deep handoff (this is the new-session entry point).
2. **This V1 exit packet** — architectural decisions + deferred items + megaudit findings.
3. **Opus-B megaudit V2-readiness report** (`docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md`) — **CANONICAL V2 DESIGN REFERENCE.** Eight V2 hazards already analyzed with recommended approaches.
4. **Engine module docs**: `crates/ql-bindings-node/src/lib.rs` head (architecture + V1 surface + Send+Sync rationale with source citations + V1 deferred sections).
5. **IDE loader contract**: `extensions/quantlab/src/quantbook/loader.ts` module doc (path resolution + cache + failure modes).
6. **IDE types.ts**: full surface mirror.
7. **Per-step audit transcripts** (if needed for context on what V1 ship already covered):
   - `docs/audits/2026-05-22-phase-5-7-v1-codex.md` — V1 ship Codex protocol audit
   - `docs/audits/2026-05-22-phase-5-7-v1-opus.md` — V1 ship Opus adversarial audit
8. **Megaudit transcripts** (already incorporated into closure; read if disagreement with findings or for V2 hazard depth):
   - `docs/audits/2026-05-22-phase-5-7-v1-megaudit-codex.md` — Codex megaudit lane
   - `docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-a-docs.md` — Opus-A docs lane

## Phase 5.8 readiness

With Phase 5.7 V1 SHIPPED + audit-closed + megaudited + docs-finalized, the full Phase 5 surface is in scope for the Phase 5.8 megaudit:

- Phase 5.1 collaboration data model
- Phase 5.2 `ql-collab` core + D-1 (FormatId)
- Phase 5.3 conflict resolution + `rebuild_workbook`
- Phase 5.4 undo/redo + UndoGroupGuard
- Phase 5.5 V2 V2 + V2 V3 + V2 V4 V1 transport layer
- Phase 5.6 presence + sweep_presence
- Phase 5.7 V1 IDE binding ← this packet

**Recommended ordering**: Phase 5.7 V2 (Transport binding, ~3-5d) FIRST, then Phase 5.8 megaudit. Rationale:

- V1 binding is too thin (just `appendPutValue` + observability). A megaudit would mostly re-cover the V1 megaudit's findings.
- V2 multiplies the FFI surface area (Transport trait + ~10 new methods + async lifecycle). Megaudit then has real cross-cutting state to find issues in.
- V2 itself benefits from Phase 5.7 V1 megaudit's findings (8 V2-readiness items already analyzed) — that's the closest thing to a "V2 preview megaudit" and reduces V2 risk.

Phase 5.8 estimated ~4-6 days as a separate cycle.

**Status update (2026-05-22, post-V2.4)**: V2 is 4-of-8 cycles done (V2.1, V2.2, V2.3, V2.4 SHIPPED). Remaining V2.5 (engine refactor for V8-block) → V2.6 (test fixture) → V2.7 (multi-window demo) → V2.8 (megaudit + V2 exit packet). Phase 5.8 still gated on V2 completing.
