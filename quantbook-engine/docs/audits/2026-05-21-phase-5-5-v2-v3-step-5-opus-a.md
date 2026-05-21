---
title: Phase 5.5 V2 V3 step 5 megaudit — Opus-A lane (IDE consumer round-trip)
date: 2026-05-21
audit_target: HEAD `0addbb2efd0` (cumulative V2 V3 steps 1-4)
auditor: Opus-A (parallel with Codex protocol lane + Opus-B adversarial lane)
verdict: PASS-WITH-FINDINGS (2 HIGH + 4 MEDIUM + 3 LOW)
lane: IDE consumer round-trip
---

# Phase 5.5 V2 V3 step 5 megaudit — Opus-A lane (IDE consumer round-trip)

## VERDICT: PASS-WITH-FINDINGS

Walked the three IDE workflows as a fresh consumer holding only `ql-collab` + `ql-collab-ws` + `docs/architecture/ide-consumer-contract.md`. The substrate is functionally sufficient: every workflow CAN be implemented, no missing primitive forces a workaround. But the consumer experience has two HIGH gaps that bite the moment you go past loopback into real IDE code: (1) `WebSocketTransport::last_error()` is unreachable through the session API (`attach_transport` consumes the concrete type into `Box<dyn Transport + Send>`; no downcast, no session-level last-error accessor), so the very feature M1 step 4 closure added to give the IDE diagnostic causality is invisible to the IDE the moment it attaches; (2) the IDE-consumer-contract doc was last updated for Phase 2B.6 and contains zero guidance for the three workflows below — § 4.1 has a 40-line prose paragraph mentioning the new APIs but doesn't walk an IDE engineer through Synced/Unsynced indicator wiring, reconnect handshake, or offline-write recovery. Consumers will either write the wrong thing from the names alone or have to spelunk source. Both are doc/surface issues, not protocol bugs — easy closures.

Workflow 1 (indicator) works correctly once you discover the `has_pending_flush() && has_transport()` gating idiom — and the docstring for `has_pending_flush` at session.rs:752-783 actually documents this well (better than the contract doc). Workflow 2 (reconnect) is where the `last_error` unreachability bites. Workflow 3 (offline-write) works as documented IF the IDE knows to drive an explicit post-attach flush — the docstring at attach_transport mentions the idiom but the contract doc § 4.1 mentions "next mutator OR explicit flush" without making the choice prescriptive.

---

## Workflow 1: Synced / Unsynced / Offline indicator

### Findings

**L1 — `has_pending_flush()` on fresh `CollabSession::new` returns false; on `from_snapshot` returns true. Indicator semantics differ at construction.**

Walking the consumer code `if !s.has_transport() { Offline } else if s.has_pending_flush() { Unsynced } else { Synced }`:

- `CollabSession::new(peer_id)` → `current_vv = default`, `last_flushed_vv = None`. `default != default` is false → `has_pending_flush() == false`. Indicator pre-attach: **Offline** (correct).
- `CollabSession::from_snapshot(peer_id, bytes)` with non-empty imported snapshot → `current_vv ≠ default`, `last_flushed_vv = None`. `has_pending_flush() == true`. Indicator pre-attach: **Offline** (because `has_transport == false` takes precedence — correct).
- After `attach_transport(ws)` on the from_snapshot case: indicator flips to **Unsynced** even though the imported snapshot was just loaded from `.qbook` and the user did nothing. The session.rs:768-775 docstring documents this scenario but the IDE engineer reading the contract doc won't know. They'll ship a UI that says "Unsynced changes" on every `.qbook` open until the first auto-flush completes.

The session.rs:780-782 mitigation ("combine with has_transport() when the IDE status should reflect 'do we have an active sync path'") is buried in a docstring the IDE author won't read until they hit the bug. **Recommendation**: lift the `has_transport() && has_pending_flush()` idiom into the contract doc § 4.1 as the canonical Synced/Unsynced check, with a code block, and call out the from_snapshot subtlety.

**L2 — No way to distinguish "Unsynced (local-only edits, will flush)" from "Unsynced (last flush failed — retry pending)".**

After `append_op` with auto-flush enabled returns `Err(Transport(_))`, the local op is committed, `last_flushed_vv` is NOT advanced, `has_pending_flush() == true`. Same state as a normal offline append. The IDE wants to render different copy: "Saving locally — reconnecting…" vs "Saving locally — offline." No accessor distinguishes these. The IDE has to track its own `transport_error_pending: bool` flag and clear it on the next successful flush — workable, but not in the contract doc.

**M1 — The contract doc § 4.1 prose paragraph mentions `has_pending_flush()` as suitable for "IDE status indicators" but provides no example wiring.**

ide-consumer-contract.md lines 210-211 mention `has_pending_flush() -> bool` for "IDE status indicators ('Synced' vs 'Unsynced changes')" — but the doc itself never shows the indicator code, the from_snapshot caveat from session.rs:768-775, or the partial-state semantics from L2. An IDE engineer using the contract doc as a spec will write the indicator from the name alone and miss both nuances. Recommendation: add a § 4.1.1 "Synced/Unsynced indicator wiring" subsection with the recommended `Status` enum + 5-line gate function + the from_snapshot suppression idiom.

---

## Workflow 2: Reconnect handshake

### Findings

**H1 — `WebSocketTransport::last_error()` is unreachable after `attach_transport` consumes the concrete type.**

This is the workflow's central pain point. `WebSocketTransport::last_error() -> Option<WebSocketError>` exists on the concrete type (lib.rs:354) and was added in V2 V3 step 4 closure (Opus M1) specifically so IDE consumers driving reconnect handshakes can distinguish "peer reset" from "auth rejected" from "capacity exceeded." But:

1. `session.attach_transport(ws)` takes `T: Transport + Send + 'static` by value and stores it as `Box<dyn Transport + Send>` (session.rs:660-672). The concrete `WebSocketTransport` is moved into the box; the IDE no longer has a handle.
2. The `Transport` trait does NOT expose `last_error` — only `send` and `try_recv`.
3. `session.detach_transport() -> Option<Box<dyn Transport + Send>>` returns the boxed trait object. `Box<dyn Transport + Send>` does not implement `Any`; the trait has no `as_any` hook. The IDE cannot downcast.

Consequence: the IDE driving `match append_op() → Err(Transport(Closed))` has no way to learn WHY the transport closed. The recovery code `s.detach_transport(); let new_ws = rt.block_on(WebSocketTransport::connect(url))?;` proceeds blind. If the prior closure was 401-auth-rejected, the new connect will immediately fail with `HandshakeFailed("401")` — burning user time on a deterministic retry. The IDE wanted the cause BEFORE the retry to gate the auth-prompt flow.

Three remediation paths:

1. **Cheapest**: keep a parallel `Arc<...>` handle on the IDE side. Before calling `attach_transport`, clone an inner `Arc<Mutex<Option<WebSocketError>>>` or wrap the WS in `Arc<Mutex<WebSocketTransport>>` and impl `Transport` for the Arc-mutex wrapper. Doable but consumer-hostile (every IDE has to invent this) and contract doc doesn't mention it.
2. **Cleanest substrate-side**: add `Transport::last_error(&self) -> Option<String>` (default `None`) to the trait. WebSocketTransport overrides; LoopbackTransport/NoopTransport stay at default. `CollabSession::transport_last_error() -> Option<String>` proxies through. Breaking trait change but `#[non_exhaustive]` not yet applied — and Phase 5 stability disclaimer at lib.rs:38-43 explicitly allows this kind of trait shape shift pre-0.2.0.
3. **Middle ground**: `CollabSession::peek_transport<F, R>(&self, f: F) -> Option<R> where F: FnOnce(&dyn Any) -> R` + add `Any` requirement to `Transport`. Lets downcast happen.

This is a HIGH because the feature was deliberately added in V2 V3 step 4 closure for the IDE use case, and from the IDE's actual surface it's invisible. The new accessor solves a problem the IDE consumer cannot reach.

**H2 — `Err(Closed)` from `append_op` doesn't tell the IDE whether the transport is recoverable or terminal.**

Per session.rs:115-117 docstring on `CollabSessionError::Transport`: "Caller should detach + reattach a new transport instead of retrying poll." But this is for `poll_remote` Closed; for `append_op` (with auto-flush) the docstring at AutoFlushPolicy::OnAppend says "Callers MUST treat their local state as authoritative for the local UI and either retry the flush (transport recovered) or detach the transport." The IDE doesn't know which of those branches applies without inspecting `WebSocketTransport::is_closed()` — which is again unreachable (per H1). Combined with H1, the consumer is blind: they get `Err(Closed)`, they can't read the cause, and the docstring tells them to choose a branch they can't observe.

Workable in practice: the IDE always treats `Err(Closed)` as "transport is dead, detach + reconnect." That's the safe choice. But the docstring's "retry the flush" arm is unusable without H1's accessor.

**M2 — `WebSocketError::ConnectFailed` vs `HandshakeFailed` distinction is correct, but no retry-budget signal.**

`reconnect()` returns `Err(WebSocketError::ConnectFailed(...))` → IDE shows "Reconnecting…" and retries with exponential backoff. After 10 failures, the IDE wants to give up and show "Cannot connect." No substrate-side accumulator tracks repeated failures — that's correctly an IDE-side concern. But the contract doc § 4.1 doesn't mention this is the consumer's responsibility. An IDE engineer who reads the doc and notices `HandshakeFailed("401")` will correctly NOT retry that one (it's auth, not network) — but the doc doesn't say which errors are transient vs permanent. Recommendation: contract doc table mapping `WebSocketError` variant → recommended IDE action (retry-with-backoff / retry-with-auth-prompt / abort).

**M3 — `detach_transport` return value is `Option<Box<dyn Transport + Send>>` — caller must drop it for the WebSocket background tasks to abort.**

```rust
let _ = s.detach_transport();  // Box drops here → Drop runs → tasks abort
```

But the IDE that writes `s.detach_transport();` without binding gets the same behavior (temporary). And the one that writes `let prev = s.detach_transport();` and stashes it for some reason keeps the tasks alive plus the TCP socket. The session.rs:677 docstring mentions "Returns it for caller cleanup" but doesn't warn that holding the box keeps the transport's tasks running. Workable, but a `let _ = ...` lint or doc note ("drop the returned Box to release background tasks") would help.

---

## Workflow 3: Offline-write recovery

### Findings

**L3 — Post-attach, the contract doc says "next mutator OR explicit flush" but doesn't prescribe which the IDE should use.**

The ide-consumer-contract.md § 4.1 V2 V3 step 3 paragraph says:

> On reattach: `attach_transport` resets `last_flushed_vv = None`. The next mutator (or explicit `flush_delta_to_transport`) sends the delta from empty VV — delivers ALL accumulated ops including the offline ones.

The session.rs:646-655 docstring goes further and recommends the explicit-flush idiom for "callers that want the new peer to see all state immediately, rather than waiting for the next mutator." Good. But neither doc says: "if your reconnect handshake is initiated by the IDE (not by a user action), there's no 'next mutator' because the user isn't typing. You MUST drive the flush." An IDE engineer who builds reconnect-on-network-recovery (no user action) will wire `s.attach_transport(new_ws)` and then wait for the next user keystroke before any sync happens — even though the user reconnected 5 minutes ago.

Cheap closure: add a one-liner to contract doc § 4.1: "If your reconnect handshake is not user-driven, call `flush_delta_to_transport()` after attach so the new peer sees state immediately."

**M4 — `flush_delta_to_transport` on a large offline backlog (e.g. 50 ops, MBs of data) hits the unbounded mpsc with one giant blob.**

Per `WebSocketTransport::send` (lib.rs:393-412), the bytes are pushed into the unbounded `outbound_tx`. The writer task drains them. If the post-attach flush carries a 5MB blob and the peer is slow, the blob sits in mpsc memory until the writer's `ws_sink.send().await` completes. That's correct behavior but the contract doc doesn't mention any size limits, recommended op-count thresholds, or chunking strategy. An IDE that lets users edit offline for hours could accumulate a multi-MB delta and the first post-attach flush could hit memory pressure on a small device.

Loro's `export_delta_bytes` is opaque — the IDE has no way to estimate blob size before calling send. The V2 V3 step 3 narrative ("Loro's CRDT op log IS the offline queue — no separate buffer needed") is correct from a correctness standpoint but glosses over the bursty wire pattern.

Recommendation: contract doc § 4.1 should mention that the post-attach flush sends ALL accumulated ops in ONE blob and that this is fine for typical IDE-edit volumes (hundreds of ops) but warrants caution for long offline sessions. A future chunking story is V2 V4 backlog material (Tier I bounded-queue + discard APIs).

**L4 — If post-attach explicit flush returns `Err(Closed)` (e.g., the reconnected WS dies between attach and flush), the IDE state matrix gets confusing.**

Scenario walk: user edits 50 ops offline → reconnect → IDE attaches new WS → IDE calls `flush_delta_to_transport()` → flush returns `Err(Transport(Closed))` because the new WS died in-handshake or immediately after. State: `last_flushed_vv = None` (not advanced on Err per session.rs:941-944), `has_pending_flush() = true`, `has_transport() = true` (the attached WS is still attached even though it's dead — session doesn't auto-detach on send error). Indicator says "Unsynced." User reads it as "I have local changes pending — same as before reconnect." Truth: nothing changed; the reconnect failed silently from the user's perspective.

The IDE needs to handle this: on flush Err, immediately detach + go back to "show reconnecting" UI. The docstring at flush_delta_to_transport mentions "retry sends the same delta" but doesn't surface the "detach + reconnect" branch explicitly. The auto-flush partial-state contract (AutoFlushPolicy::OnAppend docstring) does say "either retry the flush (transport recovered) or detach the transport" — but this is for `append_op`, not explicit `flush_delta_to_transport`. Symmetry issue: the explicit flush docstring should reference the same partial-state contract.

---

## Cross-workflow observations

**No `Transport` trait extension hook**: every consumer-pain finding here (H1, M2, M3) reduces to "the IDE attaches a concrete transport, the session takes ownership through a trait object, and any concrete-type API the IDE wanted to use later (`last_error`, `is_closed`, future `connection_state`, future `bytes_sent`, etc.) is unreachable." The current trait is intentionally minimal but the addition of `last_error` in V2 V3 step 4 closure shows the trait IS growing. Now is the cheap moment to add an extension point — either `Transport::last_error()` (default `None`) or an `Any` hook for downcast.

**Contract doc lag**: ide-consumer-contract.md is dated 2026-05-12 (Phase 2B.6). The V2 V3 step 1-4 additions are mentioned in § 4.1 as a "preview — for Phase 5.7 IDE vertical slice" prose paragraph. That's fine for now but the doc explicitly says "Phase 6.1 will formalize this as `WorkbookSession`" and "Engine Phase 6.3 will call" — meaning the contract doc is the spec the IDE binding will be built from. The 3 workflows audited here (indicator, reconnect, offline-write) are the load-bearing IDE features and none of them have a worked example in the doc. **This is the single highest-leverage closure for Phase 5.7 readiness.**

**Send/Sync mental model**: the contract doc doesn't mention threading. The IDE engineer writing the reconnect handler in `rt.block_on(...)` on a worker thread needs to know that `CollabSession: Send` (confirmed by the compile-time assert at session.rs:74-77) and `WebSocketTransport: Send` (confirmed at lib.rs:443-446). Neither is `Sync`. The IDE that wraps the session in `Arc<Mutex<...>>` and locks per-method-call will work but pays per-lock-acquire overhead on every keystroke. The contract doc could mention the "one session per thread, channel-pass mutations across" pattern as the recommended IDE concurrency model.

---

## Suggested closure scope

Ranked cheap → impactful for V2 V3 step 5 closure (consumer-experience wins):

1. **[CHEAP, HIGH-IMPACT] L3 + M1 + M2 + cross-workflow contract-doc lag**: rewrite ide-consumer-contract.md § 4.1 to include three subsections — § 4.1.1 Synced/Unsynced wiring (closes L1/L2/M1), § 4.1.2 Reconnect handshake (closes M2 + WebSocketError variant action-mapping table), § 4.1.3 Offline-write recovery (closes L3 + M4 narrative). Each with a 10-15 line code block. **One-day doc commit. Closes 5 findings.** This is the single highest-ROI closure.

2. **[CHEAP, HIGH-IMPACT] H1 — Add `Transport::last_error(&self) -> Option<String>`** as a trait method with default impl returning `None`. WebSocketTransport overrides it. CollabSession exposes `transport_last_error() -> Option<String>` proxy. Pre-0.2.0 trait change explicitly allowed by lib.rs:38-43. ~30 LOC + 2-3 tests + contract-doc paragraph. **Closes H1 directly + unlocks M2's variant-action table.**

3. **[CHEAP] H2 + L4 docstring symmetry**: align `flush_delta_to_transport` partial-state-contract docstring with `AutoFlushPolicy::OnAppend`'s "retry OR detach" language. Add a one-paragraph clarification that `Err(Closed)` from explicit flush means the same thing as `Err(Closed)` from auto-flush — local op committed, transport dead, IDE must detach + reconnect. **Pure doc; 15-20 LOC docstring delta.**

4. **[MEDIUM] M3** drop-the-detach-result lint nudge: add a `#[must_use = "drop the returned Box to release the transport's background tasks"]` to `detach_transport`. **One-line attribute change.**

5. **[DEFER to V2 V4] M4 chunking strategy**: large-offline-blob handling. Already in V2 V4 backlog (Tier I bounded queue + discard APIs per current_work.md). Contract-doc warning is the cheap V2 V3 closure; substrate fix is V2 V4.

The top two items together unlock the full IDE consumer experience for the Phase 5.7 vertical slice — the third workflow (offline-write) is the marquee feature for the offline-resilient demo, and closing H1 + the doc gaps means a Phase 5.7 IDE engineer can implement all three workflows from the contract doc alone without spelunking session.rs.
