---
title: Phase 5 V1 exit packet (5.1 → 5.6 V1+V2 + 5.4 V2 V1+V1.1 + 5.5 V2 V1 + D1.a)
status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 steps 1+2+3 SHIPPED 2026-05-21** (version-vector delta flush + poll_remote auto-flush + offline-write contract). See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 4-6 (WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
date: 2026-05-19
updated: 2026-05-20 (post-exit-packet additions: 5.6 V2 sweep_presence + D1.a 4-cluster closure + D-1 ALL STEPS SHIPPED)
predecessor: docs/phase4/exit-packet.md + docs/phase5/entry-plan.md
successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
supersedes_pointer: docs/phase5/entry-plan.md (entry-plan stays as historical scope reference; this packet is the closeout)
---

# Phase 5 V1 exit packet — multi-user CRDT collaboration substrate

This packet closes the Phase 5 **V1 surface** of the Quantbook
engine. V1 shipped the engine-side collaboration data model end-to-
end: CRDT data model decision (5.1), op-log semantic decisions
(5.2 D-2/D-3/D-4 + 5.2.a scaffold + 5.2.b set_peer_id), peer-local
undo (5.4 V1 + V2 V1 + V2 V1.1), in-process transport (5.5 V1 +
V2 V1), and ephemeral presence (5.6 V1).

Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
✅ SHIPPED 2026-05-20 — see `docs/phase5/5-3-exit-packet.md`.
Phase 5.5 V2 V2 (auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5 V2 V3
steps 1+2+3 ✅ SHIPPED 2026-05-21 (version-vector delta flush +
poll_remote auto-flush + offline-write contract). Phase 5.5 V2 V3
steps 4-6 (WebSocket transport + megaudit + exit packet) + Phase 5.7
IDE vertical slice remain ahead of the 5.8 megaudit.

## Acceptance criteria status (Phase 5 V1)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| A5V1-01 | All workspace gates green | ✅ | 4222 workspace tests passing; fmt + clippy clean workspace-wide |
| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
| A5V1-03 | `ql-collab` substantively populated | ✅ | 5 modules (peer / session / transport / presence / undo) + ~30 public methods + 67 unit tests + 1 integration test |
| A5V1-04 | Op-log + Loro merge semantics verified for multi-peer | ✅ | `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` (4 tests) + 8 paired LoopbackTransport tests + 2-peer round-trip via attached transport |
| A5V1-05 | Audit discipline preserved | ✅ | 2-way Codex + Opus audit dispatched after every substantive cycle; 7 of 10 cycles caught HIGH/MEDIUM findings convergently |

All five acceptance criteria empirically met.

## Sub-phase shipped tally

| Sub-phase | Theme | Status | Commit(s) |
|---|---|---|---|
| 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
| Tier D2 | `ql-oplog → ql-io` dependency inversion | ✅ SHIPPED | `e15e8908742` |
| 5.2 D-2 | AddSheet auto-rename on duplicate | ✅ SHIPPED | `1ca19e2fa37` |
| 5.2 D-3 | BindError::UnknownSheet → ErrorValue::Name | ✅ SHIPPED | `e71312d4bcd` |
| 5.2 D-4 | OpLog::merge_bytes + 2-peer spill probe | ✅ SHIPPED | `2f217a2067a` |
| 5.2.a | `ql-collab` scaffold (PeerId + CollabSession + Transport) | ✅ SHIPPED | `66a571b30af` |
| 5.2.b | PeerId → LoroDoc::set_peer_id wiring | ✅ SHIPPED | `ef056f50bee` + `524b5a8c231` (audit closures) |
| 5.6 V1 | Presence map (per-peer cursor + selection) | ✅ SHIPPED | `c677e244704` + `43f20abc887` (audit closures) |
| 5.4 V1 | Peer-local undo/redo via Loro UndoManager | ✅ SHIPPED | `89c02b9d83e` + `e2ba052a626` (audit closures) |
| 5.5 V1 | LoopbackTransport for 2-peer round-trip tests | ✅ SHIPPED | `3590aa6d89e` + `924750819bc` (truncation fix) + `bfa8401e1b5` (audit closures) |
| 5.5 V2 V1 | CollabSession transport wrappers (attach/detach/flush/poll) | ✅ SHIPPED | `ffd8f6e5f05` + `ad9b18fe133` (audit closures) |
| 5.4 V2 V1 | Undo grouping + merge-interval | ✅ SHIPPED | `6138a7203f6` + `e199a5fda5a` (truncation fix + audit closures) |
| 5.4 V2 V1.1 | RAII UndoGroupGuard (panic/Err-safe grouping) | ✅ SHIPPED | `7cbdc689ea9` + `d49e873f237` (Codex audit PASS) |
| **Phase 5 V1 exit packet** (this doc) | ✅ shipped | `b8b2e04e0d7` |
| 5.6 V2 (sweep_presence — closes V1 persistence known-limitation) | ✅ shipped | `d4b3cdb2dc2` |
| D1.a cluster 1 (add_sheet_rejects test → sheets.rs) | ✅ shipped | `06252f2b638` |
| D1.a cluster 2 (clear_formula_rejects_* → cells.rs) | ✅ shipped | `9b45ee656eb` + `4528dc62c3b` (backlog status) |
| D1.a clusters 3+4 (set_formula canonicalization + drop_table) — **D1.a COMPLETE** | ✅ shipped | `93210e43567` |

**23 commits to exit-packet ship + 7 post-exit-packet commits = 30 commits total** in the Phase 5 V1 arc.

Post-exit-packet adds (2026-05-19 session-end additions):
- Phase 5.6 V2 sweep_presence (+3 tests; closes V1 persistence known-limitation).
- D1.a re-partitioning across 4 clusters (9 tests relocated; net 0 workspace test count change since these are byte-identical relocations).

## Final API surface (ql-collab)

```rust
// Identity
pub struct PeerId(pub u64);  // 16-hex Display; matches Loro's u64 peer id

// Per-peer session
pub struct CollabSession {
    peer_id: PeerId,
    log: OpLog,
    undo: loro::UndoManager,
    transport: Option<Box<dyn Transport + Send>>,
}

impl CollabSession {
    // Construction
    pub fn new(peer_id: PeerId) -> Result<Self, _>;
    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, _>;

    // State access
    pub fn peer_id(&self) -> PeerId;
    pub fn op_log(&self) -> &OpLog;
    pub fn op_count(&self) -> usize;
    pub fn is_empty(&self) -> bool;

    // Op log + merge
    pub fn append_op(&mut self, op: Op) -> Result<(), _>;
    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, _>;
    pub fn export_bytes(&self) -> Result<Vec<u8>, _>;

    // Undo / redo (5.4 V1)
    pub fn undo(&mut self) -> Result<bool, _>;
    pub fn redo(&mut self) -> Result<bool, _>;
    pub fn can_undo(&self) -> bool;
    pub fn can_redo(&self) -> bool;
    pub fn undo_count(&self) -> usize;
    pub fn redo_count(&self) -> usize;
    pub fn clear_undo_stack(&self);

    // Undo grouping (5.4 V2 V1 + V1.1)
    pub fn start_undo_group(&mut self) -> Result<(), _>;
    pub fn end_undo_group(&mut self);
    pub fn set_undo_merge_interval(&mut self, ms: i64);
    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, _>;

    // Transport (5.5 V2 V1)
    pub fn attach_transport<T: Transport + Send + 'static>(&mut self, t: T) -> Option<Box<...>>;
    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>>;
    pub fn has_transport(&self) -> bool;
    pub fn flush_to_transport(&mut self) -> Result<bool, _>;
    pub fn poll_remote(&mut self) -> Result<usize, _>;
    pub fn poll_remote_with_limit(&mut self, max: usize) -> Result<usize, _>;

    // Presence (5.6 V1 + V2)
    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), _>;
    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, _>;
    pub fn clear_presence(&mut self) -> Result<(), _>;
    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, _>;
    pub fn sweep_presence(&mut self) -> Result<usize, _>;  // V2: clear all, return count
}

// Transport
pub trait Transport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
}
pub struct NoopTransport { ... }
pub struct LoopbackTransport { ... }  // pair() returns 2 endpoints

// Presence (5.6 V1)
pub struct PresenceState {
    pub sheet: u16,
    pub row: u32, pub col: u32,
    pub selection_end_row: u32, pub selection_end_col: u32,
    pub typing: bool,
}

// Undo RAII (5.4 V2 V1.1)
pub struct UndoGroupGuard<'a> { ... }  // Drop calls end_undo_group
impl Deref<Target = CollabSession> + DerefMut for UndoGroupGuard
```

Total: **~31 public methods + 5 types** on `ql-collab` (was 30 at exit-packet; +1 sweep_presence in V2 follow-up).

## Audit-locked decisions (Phase 5.1)

| ID | Decision | Status |
|---|---|---|
| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit. See `docs/phase5/d-1-exit-packet.md`. |
| D-2 | AddSheet auto-rename on duplicate canonical | ✅ SHIPPED `1ca19e2fa37` |
| D-3 | `BindError::UnknownSheet → ErrorValue::Name` mapping | ✅ SHIPPED `e71312d4bcd` |
| D-4 | Spill semantics: replay defers to recompute, not per-op | ✅ SHIPPED `2f217a2067a` |

## Audit discipline performance

The 2-way Codex + Opus audit rule was applied to **9 of 10** substantive cycles (5.6 V1 ran Codex-only due to Anthropic 529 outage × 3 Opus retries; 5.4 V2 V1.1 ran Codex-only as a documented follow-up to a pre-audited design).

| Cycle | Codex finding | Opus finding | Convergent? |
|---|---|---|---|
| 5.2.b set_peer_id | MEDIUM: API exposure of set_peer_id | HIGH: silent undo-stack-clear footgun | Same root cause, different framing |
| 5.6 V1 presence | MEDIUM: persistence contract drift | (529 unavailable) | N/A — Codex-only this cycle |
| 5.4 V1 undo | HIGH: cached_len stale after undo | HIGH: silent set_peer_id footgun (different angle) | Both unique correctness HIGHs |
| 5.5 V1 LoopbackTransport | MEDIUM: drain-before-Closed contract violation | HIGH: same finding, different framing | Yes |
| 5.5 V2 V1 transport wrappers | MEDIUM: poll_remote unbounded + partial-merge ambiguity | HIGH: same | Yes |
| 5.4 V2 V1 undo grouping | HIGH: TRUNCATION (commit blob broken) | HIGH: same TRUNCATION | Yes |
| 5.4 V2 V1.1 RAII guard | (Codex-only) PASS | (skipped — pre-audited design) | N/A |

**8 of 9 cycles that ran 2-way caught real correctness/contract bugs.**
**5 of 9 cycles caught convergent findings from both auditors.**

The 2-way audit-discipline rule is validated as load-bearing —
without either auditor, real bugs would have shipped (cached_len
stale, drain-before-Closed contract violation, truncation race
twice, etc.).

## Index-padding race incidents

The `cargo fmt --all` × `git add` race noted in user memory
(`git_index_padding_race.md`) recurred **3 times** this session:
1. Phase 5.5 V1 (`3590aa6d89e`, truncated `session.rs` + `transport.rs`) — caught by self-audit reading git diff; repaired in `924750819bc`.
2. Phase 5.4 V2 V1 (`6138a7203f6`, truncated `session.rs`) — caught by BOTH Codex + Opus 2-way audit via clean-checkout verification; repaired in `e199a5fda5a`.
3. Phase 5.4 V2 V1.1 audit-closure commit + 5.4 V2 V1 audit-closure commit + D1.a cluster 2 commit each hit `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` in the pre-commit hook (recovered via re-stage + retry; no truncation made it into the blob those times — different failure mode than incidents 1+2 but same root cause: cargo fmt × git add timing on large files).

The recurring pre-commit-hook `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
error pattern is well-documented; mitigation (re-stage + commit
fix) works reliably. Root-cause investigation of the husky
precommit hook's stdio handling is forward work for a separate
session.

## Test count evolution

| Phase milestone | Workspace test count |
|---|---|
| Phase 4 exit | 4131 |
| Phase 5.1 audit-closed | (no change; design-only) |
| Phase 5.2.b ship | 4164 (+33 across 5.2 D-2/D-3/D-4 + 5.2.a + 5.2.b) |
| Phase 5.6 V1 ship + audit | 4180 (+16) |
| Phase 5.4 V1 ship + audit | 4187 (+7) |
| Phase 5.5 V1 ship + audit | 4196 (+9) |
| Phase 5.5 V2 V1 ship + audit | 4209 (+13) |
| Phase 5.4 V2 V1 ship + audit | 4215 (+6) |
| Phase 5.4 V2 V1.1 ship | 4219 (+4) |
| Phase 5.6 V2 sweep_presence | 4222 (+3) |
| D1.a clusters 1-4 (relocations) | **4222** (0 net; byte-identical) |

Phase 5 V1 added **91 net tests** to the engine.

## What's deferred (forward work for next session(s))

### Major (multi-day)

- **Phase 5.2 D-1 — FormatId tagged tuple.** ✅ **SHIPPED 2026-05-20.**
  All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit
  complete. See `docs/phase5/d-1-exit-packet.md` for the closure
  record (final HEAD `6e32c269c22`; workspace tests 4222 → 4291;
  16/16 audit cycles caught real bugs). Touched `ql-types::peer`,
  `ql-storage::format`, `ql-oplog::wire` + `op` + `replay`,
  `ql-io::qbook_format` (v7→v8) + `oplog_persistence` (Tier D3
  header), `ql-io-xlsx::write::umya_export` (XlsxNumFmtTranslation).

- **Phase 5.3 — Conflict resolution semantics.** ✅ **SHIPPED
  2026-05-20** (4 days actual vs 4-7 day estimate; HEAD
  `24e9a775c98` post-step-6 exit packet). 6 steps + 14 audit cycles
  (14/14 caught real bugs). Causality-aware rename-repair pass at
  merge time for sheets + tables + columns:
  `ql_collab::repair_{sheet,table,column}_rename_chain` +
  `CollabSession::rebuild_workbook` production-wiring wrapper. The
  D-3 `#NAME?` simple-case from Phase 5.2 still ships as the
  raw-replay-without-repair fallback; production callers route
  through `rebuild_workbook` which atomically replays + repairs.
  See `docs/phase5/5-3-exit-packet.md` + 20 audit transcripts at
  `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked
  at `docs/PHASE-4-V2-BACKLOG.md` Tier H.

- **Phase 5.5 V2 V2 — auto-flush on append.** ✅ **SHIPPED
  2026-05-21**. `AutoFlushPolicy::{Disabled, OnAppend}` enum on
  `CollabSession` (default `Disabled` preserves V2 V1 behavior).
  `OnAppend` triggers flush after every mutator (delta path in
  V2 V3 step 1); partial-state contract documented for transport-
  failure case. 19 integration tests (14 ship + 5 audit-closure)
  at `crates/ql-collab/tests/auto_flush.rs`. No new external deps;
  no breaking changes to V2 V1 API.

- **Phase 5.5 V2 V3 step 1 — version-vector delta flush.** ✅
  **SHIPPED 2026-05-21** (`603bdc9aa6c` + `e5ff11d549a`
  audit-closure). New `CollabSession::flush_delta_to_transport`
  + `last_flushed_vv: Option<VersionVector>` field. Auto-flush
  reroutes through delta path. Idempotency short-circuit closes
  V2 V2 audit echo-loop class. New `OpLog` helpers: `oplog_vv()`
  + `export_delta_bytes(&VersionVector)`. 12 new integration tests
  (9 ship + 3 audit-closure). No new external deps.

- **Phase 5.5 V2 V3 step 2 — poll_remote auto-flush.** ✅
  **SHIPPED 2026-05-21** (`e4e1ce282b1` + `fc3de6f99c7`
  audit-closure). Wires `poll_remote*` into auto-flush (one flush
  per drain batch). V2 V3 step 1's idempotency guard prevents
  echo loops; reverses the V2 V2 audit-locked "receive-side
  excluded" exclusion. 3-peer hub fanout works automatically
  under `OnAppend`. 4 new integration tests (3 ship + 1 closure
  for partial-state contract). Partial-state contract on flush
  Err documented + test-pinned.

- **Phase 5.5 V2 V3 step 3 — offline-write story.** ✅
  **SHIPPED 2026-05-21**. Investigation: NO explicit queue needed.
  Loro's CRDT op log IS the implicit offline queue. Append while
  no transport attached → `append_op` returns `Ok(())` and commits
  locally (`maybe_auto_flush` silently no-ops). On reattach,
  `attach_transport` resets `last_flushed_vv = None`; next mutator
  or explicit `flush_delta_to_transport` sends delta from empty VV
  (= ALL accumulated ops including offline ones). NEW ergonomic
  helper `CollabSession::has_pending_flush() -> bool` for IDE
  status indicators + reconnect handshake. 7 new integration tests
  pin the contract. No code change to the wire path.

- **Phase 5.5 V2 V3 step 4 — WebSocket transport impl.** ✅
  **SHIPPED 2026-05-21**. New crate `ql-collab-ws` housing
  `WebSocketTransport`. Bridges async tokio-tungstenite (`=0.29.0`)
  to the sync `Transport` trait via `tokio::sync::mpsc` channels +
  2 spawned background tasks (reader + writer). MVP scope locked at
  plan time: client-only, plain `ws://`, NO TLS, NO auto-reconnect
  (caller drives via detach + new connect + attach — V2 V3 step 1
  baseline-reset contract delivers offline ops on reconnect),
  unbounded outbound mpsc queue. 13 integration tests against an
  in-process tokio-tungstenite echo server, including 3 that
  verify the V2 V2 + V2 V3 step 1-3 contracts hold over a real
  WebSocket (auto-flush round-trip, offline-reattach delivery,
  partial-state on server close). V1 limitations deferred to V2 V4
  (TLS via rustls feature, bounded backpressure, `ReconnectingWebSocketTransport`
  wrapper, server-side `ql-collab-ws-server` sibling crate, inbound
  text/ping/pong frame dropping). Crate NOT added to `default-members`
  — keeps `cargo build` lean; tests still run via `--workspace`.

- **Phase 5.5 V2 V3 steps 5-6 — Megaudit + exit packet.** Step 5:
  full-arc 3-way megaudit (Codex + Opus-A + Opus-B per Phase 5.3
  step 5 precedent) covering V2 V3 steps 1-4 end-to-end. Step 6:
  V2 V3 exit packet. 1-1.5 days estimated.

- **Phase 5.7 — IDE vertical slice.** Two-window editing demo.
  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2 (✅) + V2 V3.

- **Phase 5.8 — Megaudit.** Randomized peer-merge tests +
  transport failure modes. 4-6 days.

### Minor (V2 V2 polish)

- **Phase 5.4 V2 V2 — UndoManager push/pop listeners** (lower
  priority; UndoManager already exposed via `pub use loro::UndoManager`;
  Loro's API surface is complex — couples to `UndoOrRedo`,
  `CounterSpan`, `DiffEvent`, `UndoItemMeta`; defer until Phase 5.7
  IDE surfaces a concrete consumer need).
- ~~**Phase 5.6 V2 — Presence eviction sweep**~~ — ✅ SHIPPED
  `d4b3cdb2dc2` as `CollabSession::sweep_presence` (caller-opt-in).

### Infrastructure

- **Tier D3 — `oplog.bin` magic bytes + version header.** Bundle
  with D-1 schema work (it's the discriminator the loader uses to
  detect old envelope schemas for migration).
- **Tier C2 — BatchCommit depth guard.** Low priority.
- ~~**Tier D1.a — test-cluster re-partitioning**~~ — ✅ SHIPPED
  across 4 commits (`06252f2b638`, `9b45ee656eb`, `4528dc62c3b`,
  `93210e43567`). 9 tests relocated to their semantically correct
  owning submodules. Pure mechanical, net 0 test count change.
- **Index-padding race root-cause** in husky precommit hook —
  recurring `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on large-file edits
  + cargo fmt × git add race. 3 incidents this session; mitigation
  (re-stage + retry) reliable but root cause is forward work.

## Cross-references

- `docs/phase5/entry-plan.md` — Phase 5 entry plan (still active for scope).
- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
- `docs/known-gaps.md` — GAP-C-03 / C-04 / C-05 closed at V1; remaining items.
- `docs/MASTER-PLAN.md` §541-621 — Phase 5 sub-items + acceptance.
- `docs/audits/2026-05-19-*.md` — 23 audit transcripts across 11 audit cycles (each cycle produced 2-3 docs: Codex + Opus + Consolidated, with 5.6 V1 missing Opus due to Anthropic 529 × 3 retries and 5.4 V2 V1.1 Codex-only per documented justification).

## Verdict

**Phase 5 V1 is COMPLETE.** The engine-side collaboration substrate
ships as a usable surface for Phase 5.7 IDE integration. D-1 is the
natural fresh-session starting point for the next Phase 5 push.
