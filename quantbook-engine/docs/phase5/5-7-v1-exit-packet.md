---
title: Phase 5.7 V1 exit packet
date: 2026-05-22
status: ACTIVE — Phase 5.7 V1 SHIPPED via cross-repo ship + closure cycle
ship_commit_range_engine: 677ee03ee8b (V1 ship) → [closure commit] (V1 audit closure)
ship_commit_range_ide: 1a7fc8bbe3f (V1 ship) → [closure commit] (V1 audit closure)
predecessor_exit_packet: docs/phase5/v2-v4-v1-exit-packet.md (V2 V4 V1)
audit_cycle_total: 1 ship + 1 closure = 2 cycles, 2 audit transcripts (Codex + Opus)
test_count_at_v1_exit: workspace 4461+ / 0; ql-bindings-node 2 unit tests; IDE quantbook 20 mocha tests (up from 10 at V1 ship after closure additions)
phase_5_8_readiness: UNBLOCKED — full Phase 5 surface (V1, D-1, 5.3, 5.5 V2 V2/V3/V4 V1, 5.6, 5.7 V1) now in scope for megaudit
---

# Phase 5.7 V1 — First IDE Binding to the Quantbook Engine

## Summary

Phase 5.7 V1 is the FIRST IDE binding to the quantbook engine since the engine has existed. Cross-repo ship across two repos:

- **Engine** (`quantlab-quantbook/quantbook-engine`, `feat/quantbook-engine`): new `crates/ql-bindings-node/` crate using napi-rs 3.x to expose `CollabSession` as a JS class. cdylib output, V1 surface is the minimum coherent round-trip.
- **IDE** (`quantlab/quantlab`, `feat/visualise-v1`): new `extensions/quantlab/src/quantbook/` (loader + types + TS wrapper) + `extensions/quantlab/src/commands/quantbookCommands.ts` (demo command) + `extensions/quantlab/test/quantbook-roundtrip.test.ts` (20 mocha tests).

V1 deliberately scoped to a MINIMUM vertical slice: napi-rs cdylib exposing `CollabSession` for a TS round-trip. NO Transport binding, NO multi-window IPC, NO real cell-grid UI. V2 picks up Transport. V3 picks up cell grid + persistence.

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

## Verification at V1 exit

- **Engine workspace tests**: 4461 / 0 (workspace, `--test-threads=1`)
- **ql-bindings-node Rust tests**: 2 / 2 (`version_smoke`, `collab_session_roundtrip_via_rust`)
- **IDE quantbook mocha tests**: 20 / 20 (was 10/10 at V1 ship; +10 closure tests)
- **fmt + clippy**: clean on both repos
- **VS Code interactive smoke**: deferred to V2 explicit verification cycle (per CLAUDE.md "if you can't test the UI, say so explicitly")

## Cross-repo coordination notes for V2

V2 work will continue across both repos. Conventions established at V1:

1. **Ship pairs**: every binding surface change has TWO commits — one per repo. Reference each other in commit messages.
2. **Audit lane parity**: Codex + Opus run in parallel per audit cycle, cross-repo prompts.
3. **Closure commits**: same pattern — two commits, one per repo, audit-driven.
4. **Test infrastructure**: IDE-side tests can use `_resetQuantbookEngineCacheForTests()` + monkey-patched `process.dlopen` for failure-mode regression tests. Engine-side tests go in `#[cfg(test)]` mod within `ql-bindings-node`.
5. **Plan files**: keep in engine `.plans/_active.md` (engine drives the binding surface design).
6. **Audit-discipline Rule 4 still load-bearing**: this cycle discovered TWO new findings (catch_unwind doc + PeerID::MAX sentinel) that only positive proof / boundary tests would catch. V2 must continue this discipline.

## Reading order for V2 / next session

1. **Engine module docs**: `crates/ql-bindings-node/src/lib.rs` head (architecture + V1 surface + Send+Sync + V1 deferred sections)
2. **IDE loader contract**: `extensions/quantlab/src/quantbook/loader.ts` module doc (path resolution + cache + failure modes)
3. **IDE types.ts**: full surface mirror
4. **This V1 exit packet**: architectural decisions + deferred items
5. **V1 audit transcripts**: `docs/audits/2026-05-22-phase-5-7-v1-{codex,opus}.md`

## Phase 5.8 readiness

With Phase 5.7 V1 SHIPPED + audit-closed, the full Phase 5 surface is in scope for the Phase 5.8 megaudit:

- Phase 5.1 collaboration data model
- Phase 5.2 `ql-collab` core + D-1 (FormatId)
- Phase 5.3 conflict resolution + `rebuild_workbook`
- Phase 5.4 undo/redo + UndoGroupGuard
- Phase 5.5 V2 V2 + V2 V3 + V2 V4 V1 transport layer
- Phase 5.6 presence + sweep_presence
- Phase 5.7 V1 IDE binding ← this packet

Phase 5.8 (separate cycle, ~4-6d) is the recommended next architectural milestone.
