---
title: Phase 5.1 — CRDT Data Model Decision (Loro Container Shape)
status: AUDIT-CLOSED — Codex + Opus design review complete; revisions applied
phase: 5.1
date: 2026-05-18
revised: 2026-05-19 (post-audit corrections)
predecessor: docs/phase5/entry-plan.md
master_plan: docs/MASTER-PLAN.md § Phase 5 § 5.1
audit_transcripts:
  - docs/audits/2026-05-19-phase-5-1-codex.md
  - docs/audits/2026-05-19-phase-5-1-opus.md
  - docs/audits/2026-05-19-phase-5-1-consolidated.md
---

# Phase 5.1 — CRDT Data Model Decision

## Purpose

Lock the Loro container-shape decision for Phase 5 collaborative
editing. The output is this design doc + a parallel Codex + Opus
audit checkpoint. No code lands until both auditors sign off.

## The question

**How does Quantbook represent collaborative workbook state on
top of Loro CRDTs so that 2+ peers can edit concurrently and the
result merges deterministically?**

The pre-existing single-writer `ql-oplog` already wraps a
`LoroDoc`. The narrow question for 5.1 is whether to:

- **(A) Keep the op-log shape.** Op-list-in-Loro is already a
  CRDT under concurrent peer appends. Phase 5 adds transport +
  snapshot + presence + undo without changing the state-on-Loro
  representation.
- **(B) Re-shape state as typed Loro containers per feature.**
  Cells, names, sheets, tables, formats become LoroMap /
  LoroList / LoroText containers directly. Merge semantics are
  per-container-CRDT-native.
- **(C) Hybrid — op-log for ordering-sensitive ops + typed
  containers for grow-only sets.** E.g. cells stay in the op
  log; sheets list becomes a LoroMovableList; names become a
  LoroMap.

## Recommendation

**Adopt Option A (op-log preservation) as Phase 5 V1 with a
narrow Option C extension for presence.**

Rationale below. Option B is a Phase 5 V2 / Phase 6 candidate;
the design doc explicitly defers it.

## State of the existing `ql-oplog`

What's there today (`crates/ql-oplog/src/log.rs`):

```rust
pub struct OpLog {
    doc: LoroDoc,
    cached_len: usize,
}
```

- One `LoroDoc` per workbook.
- All ops live in a single `LoroList` named `"ops"`.
- Each op is JSON-serialized via `serde_json` and pushed as a
  `LoroValue::String` into the list.
- `OpLog::append` = serialize + push + commit.
- `OpLog::iter` = list iterator → JSON-deserialize → `Op`.
- Replay reconstructs `Workbook` state via
  `ql_oplog::replay::replay_into`.

The op vocabulary (13 variants in `Op` enum) covers every
mutation the engine supports:
- Cells: `PutValue`, `PutFormula`, `ClearFormula`
- Names: `SetName` (workbook + sheet-scoped)
- Sheets: `AddSheet`, `RenameSheet`
- Formats: `RegisterFormat`, `SetCellFormat`
- Tables: `CreateTable`, `DropTable`, `RenameTable`,
  `RenameColumn`, `ResizeTable`
- Workbook config: `SetReferenceMode`, `SetLocale`
- Atomicity: `BatchCommit { ops: Vec<Op> }`

## How Loro behavior changes when peers exchange updates

Today's `OpLog` is single-writer (one runtime appends; replay is
deterministic). The CRDT machinery is dormant. Phase 5 turns it
on by:

1. Each peer holds a `LoroDoc` representing the workbook.
2. Peers exchange `LoroDoc` updates via Loro's
   `export_from(version_vector)` + `import` API.
3. Loro merges concurrent `LoroList::push` operations by
   Lamport timestamp; concurrent pushes are PRESERVED, ordered
   causally.

The result: if peer A pushes `Op::PutValue { A1, 5 }` and peer B
pushes `Op::PutValue { A1, 7 }` concurrently, the merged log
contains BOTH ops in causal order. Deterministic replay then
applies them in that order → final value = whichever op came
later in the deterministic merge order.

**Post-audit correction (2026-05-19, Codex V1):** the pre-audit
draft of this section claimed Loro's merge rule is "Lamport
timestamp" and the resulting semantic is "LWW on Lamport
timestamps." Both descriptions were imprecise. The actual Loro
merge rule (verified against `loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163,192`)
is **Fugue/origin-based ordering with peer-id tiebreaker** for
concurrent inserts at the same origin position. Both pushes
are preserved (not overwritten); the merged order is
deterministic and receive-order-independent given unique peer
IDs. The SEMANTIC LWW outcome at the engine level — "whichever
peer's PutValue ran last wins the cell value" — emerges
because deterministic replay applies both ops in causal/origin
order and the second write overwrites the first. We get this
for free from Loro + the engine's deterministic replay path
(Phase 4); we do NOT get it from Loro alone choosing one push
over the other.

## Why Option A is the right Phase 5 V1

### Pro: reuses ~12 months of Phase 2-4 invariants

Replay is a load-bearing path. Phase 4 closed dozens of edge
cases (W5-156 dropped-table bind, W5-103 spill writeback, Tier
C1 cycle detection, W5-91 rename-sheet formula rewrite, etc.).
The replay path that Phase 5 inherits is the SAME path used by
`.qbook` cold-load. Every Phase 4 fix carries forward.

Container-shape (Option B) would require re-implementing those
edge cases at the container level. We'd lose months of audit
coverage.

### Pro: 5.1 → 5.2 → 5.5 ships faster

Per master plan estimates:
- 5.1 (this doc): 3-5 days.
- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
  3-4 weeks under Option B.
- 5.5 (transport layer): same effort either way.

Option A gets Phase 5 to a "two peers editing one workbook"
demo in ~3-4 weeks. Option B is closer to 8-10 weeks for the
same demo.

### Pro: the JSON-string layer is opaque to merge semantics

Loro's `LoroList` doesn't try to merge string contents. It
treats each op as an opaque blob. Concurrent edits → both blobs
preserved. This is EXACTLY the merge semantic we want for
op-log-driven CRDT.

If we used typed containers, we'd inherit Loro's
per-container merge semantics — useful in some cases (LoroText
for rich-text editing of formula text could enable
character-level concurrent edits) and harmful in others
(LoroMap merge for `name_table: LoroMap<String, NamedTarget>`
would silently let two peers register the same name with
different targets, picking one by LWW — but the engine's
no-duplicate-name invariant might be violated mid-replay).

### Pro: snapshots remain straightforward

`LoroDoc::export(ExportMode::Snapshot)` already produces a
full-history blob. New peers import the snapshot and resume.
Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
to compact old history. The mechanism is built-in.

### Con: cell-level conflict diagnostics are coarse

If peer A writes `=A1+1` to cell B1 and peer B writes `=A1*2`
to cell B1 concurrently, the merged log has both ops. Replay
applies them in causal order; the final formula is whichever
op came last. We do NOT show the user "two concurrent edits;
choose one" — we silently pick LWW.

For Phase 5 V1 this is acceptable per master plan § 5.3
(Conflict Resolution Semantics) which explicitly cites LWW as
the V1 default. V2 work can add a "concurrent-edit detected"
diagnostic by inspecting the Loro version vector at the LWW
write site — but it's out of scope for 5.1.

### Con: cell-level granularity is sub-optimal for very-large workbooks

Every op carries a `sheet, row, col` address even when peers
edit non-overlapping ranges. Loro merges the op list in O(n) on
peer-count. For a workbook with 100k cells and 10 peers each
making 1k edits, that's 10M list entries to merge. Performance
testing post-5.2 will tell whether this is acceptable.

Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
prunes old history. The op log is append-only-with-trim, not
strictly append-only.

## Recommended container shape

### One `LoroDoc` per workbook

Carry through from `ql-oplog`. Each workbook = one `LoroDoc`.
Per-peer state lives in separate containers within the same doc
(presence below).

### Persistent state container: `"ops"` LoroList

Unchanged from `ql-oplog`. JSON-string blobs of `Op` variants,
appended in causal order, replayed deterministically.

```
LoroDoc
└── LoroList "ops"
    ├── 0: "{\"kind\":\"PutValue\",\"sheet\":0,...}"
    ├── 1: "{\"kind\":\"PutFormula\",...}"
    └── ...
```

### Presence container: `"presence"` LoroMap (per-peer ephemeral)

**Phase 5.6 V1 ✅ shipped at `c677e244704` (2026-05-19).**
Holds the per-peer cursor + selection + typing indicator. Keys
are `ql_collab::PeerId` in 16-hex `Display` form (the audit
during 5.6 V1 deviated from the pre-implementation "UUIDs"
language since PeerId is u64-native to match Loro's PeerID type);
values are JSON blobs with `{sheet, row, col, selection_end_row,
selection_end_col, typing: bool}`.

```
LoroDoc
├── LoroList "ops"
└── LoroMap "presence"
    ├── "0000000000000001": "{\"sheet\":0,\"row\":3,\"col\":2,...}"
    └── "0000000000000002": "{\"sheet\":1,\"row\":0,\"col\":0,...}"
```

**Why MOM (Map of Maps) is wrong for cells but right for presence**:
- Cells need ordering-aware merge (Tier C1 cycle detection
  depends on op-log order; spill-anchor invariants depend on
  set_formula-before-set_value-at-target ordering). Op-log
  preserves this.
- Presence is ephemeral and unordered — each peer overwrites
  its own key. LoroMap LWW merge gives "last position update
  wins per peer," which is exactly the desired semantic.

**Persistence (V1 known limitation):** the pre-implementation
design said "Presence updates do NOT persist across `.qbook`
save/load." The V1 implementation persists presence *de facto*
because it lives in the same `LoroDoc` as `"ops"`, and
`oplog_persistence::save_workbook_with_oplog` writes the
WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
restore stale presence entries.

V1 treats this as ACCEPTABLE because:
1. Presence keys are peer-ids; on reopen the rejoining peer's
   own entry is overwritten on first `update_presence` call.
2. Stale entries from peers not in the current session are
   visually distinguishable in the IDE (Phase 5.7) since they
   point at stale positions for absent peers.
3. Eviction would require either per-container export filtering
   (Loro doesn't expose this) or a load-time `presence_remove`
   sweep (forward work).

**V2 ✅ shipped 2026-05-19:** `CollabSession::sweep_presence()`
clears all presence entries (own + remote) and returns the
count. Caller-opt-in by design — sessions that WANT to see
other peers' last-known positions (e.g. an IDE rejoining a
live collab session) skip the sweep; sessions wanting a clean
slate (cold restart of a `.qbook`) call sweep after
`from_snapshot`.

Earlier `clear_presence` (V1) remains for the "leave session"
use case (removes only own peer's entry).

### Snapshot container: `"snapshot"` LoroMap (reserved, V2)

Phase 5 V2 may introduce a snapshot container that holds a
compact representation of the workbook state at a recent
version vector. Replay against a snapshot skips ops older than
that vector. Reserved name; no Phase 5 V1 implementation.

### Anti-pattern (do NOT do): one container per cell

```
LoroDoc
└── LoroMap "cells"
    ├── "0,0,0": LoroMap { value: ..., formula: ..., format_id: ... }
    ├── "0,0,1": LoroMap { ... }
    └── ...  // 100k+ inner containers
```

This is the textbook CRDT spreadsheet design (Google Wave, Y.js
spreadsheet demos). It's wrong for Quantbook because:
1. We lose op ordering. The spill-anchor / spill-target
   invariant from Phase 4.7 depends on set_formula(anchor)
   completing BEFORE set_value(target). Loro's per-container
   merge doesn't preserve cross-container ordering.
2. We lose the cycle-detection prerequisites. Tier C1 builds an
   ephemeral calcgraph from the formula text; the formula text
   needs to be coherent at every snapshot. Per-cell containers
   could land mid-cycle.
3. Loro overhead per container is non-trivial. 100k containers
   for a 100k-cell workbook is the worst-case memory profile.
4. Re-binding formula text after a sheet rename is op-log-aware
   (W5-91 emits a `BatchCommit` containing PutFormula entries
   for every rewritten cell + the RenameSheet op). Per-cell
   containers can't express atomic batches.

Option B / per-cell-container is Phase 5 V2 work at the
earliest, and only if we discover specific use cases (e.g.
character-level concurrent editing of one long formula) that
benefit from it.

## Conflict resolution semantics (Phase 5.3 preview)

The 5.1 design picks Option A → conflicts resolve by Loro's
underlying merge order: **Fugue/origin-based with peer-id
tiebreaker** (per `loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163,192`),
NOT Lamport timestamps. The op-log replay path observes the
final causal order; the LAST op in that order wins for each
target. Phase 5.3 formalizes this with these defaults:

| Concurrent op pair | Resolution |
|---|---|
| `PutValue { A1, v_a }` × `PutValue { A1, v_b }` | Last-in-causal-order wins (Fugue/origin) |
| `PutFormula { A1, f_a }` × `PutFormula { A1, f_b }` | Last-in-causal-order wins |
| `PutValue { A1, v_a }` × `PutFormula { A1, f_b }` | Last-in-causal-order wins; replay applies both and recompute observes final state |
| `ClearFormula { A1 }` × `PutFormula { A1, f }` | Last-in-causal-order wins |
| `SetName { foo, t_a }` × `SetName { foo, t_b }` | Last-in-causal-order wins |
| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | **Phase 5.3 step 3 ✅ shipped 2026-05-20:** post-merge `ql_collab::repair_sheet_rename_chain` rewrites the formula text from `A!...` to `B!...` (current name) before recompute. Pre-step-3 the D-3 V1 limitation produced `#NAME?`; post-step-3 the formula resolves correctly. Caller invokes the repair pass between `replay_into` and `recompute_all` (caller-driven, NOT auto-hooked into `merge_bytes`). |
| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
| `RenameSheet { 0, _, X }` × `RenameSheet { 1, _, X }` (different sheets, same target) | **Phase 5.3 step 2 audit closure ✅ shipped:** D-2-style auto-disambiguation — second rename suffixes to `X(2)`, etc. Pre-closure replay hard-failed via `SheetRenameRejected { source: Duplicate }`. |
| `RenameSheet { 0, "Sheet1", "SHEET1" }` (case-only rename) | **Phase 5.3 step 2 audit closure ✅ shipped:** replay applies the display update. Pre-closure the canonical-equality idempotency check silently dropped case-only renames. |
| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |

The 5.3 audit checkpoint validates these defaults against the
Phase 4.12 megaudit's cycle-detection / spill / drop-table
invariants — every Phase 4 edge case must survive the CRDT
merge.

### Peer-id stability is a precondition for CRDT convergence

**Phase 5.3 step 1 audit closure (2026-05-20).** Loro's
Fugue/origin-based merge uses peer-ids as a tiebreaker. Two peers
forking from the same snapshot MUST carry STABLE non-zero peer-ids
across the lifetime of their OpLogs for deterministic convergence
under bidirectional merge:

- **Production code** (`ql_collab::CollabSession::new` /
  `from_snapshot`) already enforces this — both constructors call
  `OpLog::set_peer_id(peer_id.as_u64())` with an `assert_ne!(_, 0)`
  release-firing guard (D-1 step 8 megaudit closure).
- **Test scaffolding** for 2-peer probe tests (e.g.
  `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`)
  MUST also call `set_peer_id` with distinct stable ids after
  `OpLog::import_bytes`. `LoroDoc::new()` assigns a random peer-id
  per process; without an explicit `set_peer_id` the (peer-id
  pair) differs across merge directions and bidirectional
  convergence assertions fail spuriously.
- The default `OpLog::new()` and `OpLog::import_bytes` paths
  intentionally retain randomized peer-ids — they're for
  single-writer (legacy / qbook) workflows where multi-peer
  semantics don't apply. The peer-id only matters once two ops
  with distinct peer-ids enter the same merged log.

## Undo/redo (Phase 5.4 — V1 shipped)

**Phase 5.4 V1 ✅ shipped at `89c02b9d83e` (2026-05-19).**
Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
peer has its own undo stack tracking THEIR local appends only.
Undoing APPENDS an inverse op AND retracts the original from
the visible `"ops"` LoroList — so `OpLog::len()` shrinks
post-undo. (V1 implementation correction: prior "remove from
the log (semantically; tombstones)" wording was imprecise;
Loro neither physically removes nor tombstones — it composes
a remote-event-style retraction. See `ql_collab::CollabSession::undo`.)

This is local-undo, NOT collaborative-undo. Two users editing
the same cell + one user undoing their edit produces a sane
result: their edit retracts from the visible log AND propagates
to peers via merge; the other user's edit (if later in causal
order) stays.

### Wired surface (V1 + V2 V1)

`ql_collab::CollabSession` exposes 10 typed methods:
- `undo() -> Result<bool, _>` / `redo() -> Result<bool, _>`
- `can_undo() -> bool` / `can_redo() -> bool`
- `undo_count() -> usize` / `redo_count() -> usize`
- `clear_undo_stack()`
- **V2 V1 (`6138a7203f6` + `e199a5fda5a`):**
  `start_undo_group() -> Result<(), _>` /
  `end_undo_group()` — atomic multi-op grouping for paste /
  fill-down / table-import operations.
- **V2 V1:** `set_undo_merge_interval(i64)` — auto-merge
  consecutive changes within the window (typing IDE hint).
- **V2 V1.1:** `start_undo_group_scoped() -> Result<UndoGroupGuard<'_>, _>`
  — RAII variant. `Drop` auto-closes the group on scope exit,
  including on panic-unwind and `?` propagation. Use this
  over the manual start/end pair for any code path that can
  fail mid-group.

Plus `pub use loro::UndoManager` in `ql_collab::undo` for
callers wanting raw access. Presence-origin commits
(`PRESENCE_COMMIT_ORIGIN = "presence:"`) are auto-excluded so
cursor movement doesn't pollute the undo stack.

### V1 / V2 V1 limitations / V2 V2 follow-ups

- No push/pop listeners (`UndoManager::set_on_push` / `set_on_pop`) — defer to V2 V2.
- ~~No RAII closure helper~~ — V2 V1.1 ships
  `start_undo_group_scoped` + `UndoGroupGuard`. Manual
  start/end pair still exists for ergonomic flexibility but
  the RAII variant is recommended.
- `set_peer_id` after construction silently CLEARS the undo
  stack per Loro's internal subscription. V1 made
  `OpLog::set_peer_id` `&mut self` so the footgun isn't
  reachable from a shared `&OpLog` (Codex+Opus 5.4 V1 audit
  closure).
- Nested `start_undo_group` returns
  `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
  deterministically — nesting is NOT supported.

## Transport (Phase 5.5 — V1 partially shipped)

**V1 ✅ shipped at `924750819bc` (2026-05-19):** `Transport`
trait + `NoopTransport` (5.2.a) + `LoopbackTransport` (5.5 V1)
— in-process paired endpoints for 2-peer tests. The
`LoopbackTransport::pair()` constructor returns two endpoints
whose sends route to each other's recv queues; `Send + Sync`
so multi-threaded test patterns work too. Drain-before-Closed
semantic per the trait contract.

**V2 V1 ✅ shipped at `ffd8f6e5f05` (2026-05-19):**
`CollabSession` exposes 5 typed transport methods:
`attach_transport` / `detach_transport` / `has_transport` /
`flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`
for bounded drain). Explicit-drive — caller invokes flush + poll
on a tick; V2 V2 will add auto-flush on append.

Loro's wire format:
- `LoroDoc::export(ExportMode::Updates(version_vector))` →
  bytes carrying only ops new-to-the-peer-since-version-vector.
- `LoroDoc::import(bytes)` → merge into local doc.

**V2 V2 / V3 pending:** auto-flush on append (track per-
transport version vector + send deltas, not full snapshots);
WebSocket transport for production; reconnect + offline sync.
Each peer pushes version-vector updates to the server; server
fan-outs to other peers; each peer imports. V1's
`LoopbackTransport` + V2 V1's `attach_transport`/`flush`/`poll`
wrappers are sufficient for engine-side tests.

5.1 does NOT pick a production transport (WS vs Server-Sent
Events vs custom protocol) — that's 5.5 V2 V2's call. 5.1 just
confirms the substrate works regardless; 5.5 V1 + V2 V1 prove
it via LoopbackTransport + the CollabSession wrappers.

## Backwards compatibility with `.qbook` envelope

The current persistence layer (`crates/ql-io`) saves the
workbook as a `.qbook/` directory with JSON manifests +
parquet cell data. Op log persistence (`ql-oplog::persistence`)
saves the LoroDoc snapshot as `oplog.bin`.

Phase 5 preserves both. The CRDT additions are purely additive:
- `.qbook/oplog.bin` carries the same Loro snapshot blob, now wrapped
  in a Quantlab Tier D3 header (`OPLOG_MAGIC` + version u32) added by
  step 7 (2026-05-20). The Loro snapshot body is unchanged — the header
  enables format-identification + forward-rejection of unknown versions.
- Loading a `.qbook` still produces a single-writer-equivalent
  workbook (no peer IDs, no presence).
- Joining a session = load `.qbook` locally + receive Loro
  updates from teammates + merge into the local doc.

The pre-existing replay path handles the single-writer case;
the new transport path handles the multi-peer case. Both call
the same `replay_into` internally.

## `ql-collab` crate scope

**Phase 5 V1 COMPLETE 2026-05-19. D-1 step 1.1 (2026-05-19) moved PeerId to `ql_types`.** Current 4-module surface (verified against `crates/ql-collab/src/lib.rs`):

```rust
// crates/ql-collab/src/lib.rs

pub mod presence;    // PresenceState + per-peer LoroMap (5.6 V1+V2)
pub mod session;     // CollabSession + UndoGroupGuard (5.2.a..5.5 V2 V1)
pub mod transport;   // Transport trait + NoopTransport + LoopbackTransport (5.5 V1+V2 V1)
pub mod undo;        // pub use loro::UndoManager (5.4 V1+V2 V1+V2 V1.1)

// PeerId lives in ql_types (D-1 step 1.1); re-exported through ql_oplog.
pub use ql_oplog::PeerId;

pub use presence::{PresenceError, PresenceState};
pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
pub use undo::UndoManager;
```

Full surface (~31 public methods + 5 types, 67 unit tests + 1 integration test) inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)".

Phase 5.2.a scaffold (`66a571b30af`) populated peer/session/transport. Subsequent V1 ships populated presence (`c677e244704` + `d4b3cdb2dc2`) and undo (`89c02b9d83e` + `6138a7203f6` + `7cbdc689ea9`). Presence + undo are NO LONGER "reserved" — both shipped V1+V2 V1.

Current Cargo.toml deps (verified against `crates/ql-collab/Cargo.toml`):
- `ql-oplog` — for `OpLog` + `Op` + `merge_bytes` + `import_bytes` + `export_bytes`.
- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
  (currently used only in doc examples; kept to avoid Cargo churn
  when replay wiring lands).
- `ql-functions` — same forward-looking justification (registry
  needed by replay).
- `thiserror` — `CollabSessionError` + `TransportError`.

It does NOT depend on `ql-io` or `ql-io-xlsx`. Phase 4.12 Opus-C
HIGH-3 (`ql-oplog → ql-io` cleanup, Tier D2 in v2 backlog) closed
this session at commit `e15e8908742`. `ql-oplog` is the dependency
floor.

**Peer-id wiring (Phase 5.2.b 2026-05-19, ✅ closed):** the
scaffold's known limitation — `PeerId` stored as a label only — was
closed by adding `OpLog::set_peer_id` and calling it from
`CollabSession::new` + `CollabSession::from_snapshot`. The configured
`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
merge metadata attributes each session's appends correctly. Caller
pitfall (from Loro docs): concurrent sessions MUST use distinct peer
ids — duplicate ids corrupt the document via conflicting OpIDs.

## Decision matrix summary

| Dimension | Option A (op-log) | Option B (per-feature containers) | Option C (hybrid) |
|---|---|---|---|
| 5.2 effort | 1-2 weeks | 3-4 weeks | 2-3 weeks |
| Phase 4 replay reuse | ✅ full | ❌ rewrite | partial |
| Concurrent cell merge | LWW | per-cell CRDT | per-cell CRDT |
| Cycle detection | works | needs re-design | partial |
| Spill invariants | preserved | risk | risk |
| Snapshot mechanism | `ExportMode::Snapshot` works | ditto | ditto |
| Replay determinism | proven | needs new proof | partial |
| Memory per workbook | low | high (100k containers) | medium |
| Presence | new map | new map | new map |

**Choose Option A** for Phase 5 V1. Revisit Option B/C as Phase
5 V2 / Phase 6 candidate.

## Audit checkpoint (gating 5.2)

This design doc requires a parallel Codex + separate-Opus audit
BEFORE any 5.2 code lands. Per the engine audit-discipline rule
(`memory/quantbook_engine_audit_discipline.md`), the audit
should:

1. Independently re-derive the Option A vs B vs C tradeoff and
   confirm or challenge the recommendation.
2. Test the cycle-detection / spill-invariant / drop-table-rebind
   claims against the actual Phase 4 code.
3. Survey alternative CRDT data-model designs (Yjs, Automerge,
   Diamond Types) and flag any patterns this doc misses.
4. Probe the LWW conflict semantics for cases that produce
   user-visible bugs (e.g., concurrent AddSheet "S" + edit on
   sheet 0 by someone who hasn't seen the AddSheet yet).

Audit transcripts will land at:
- `docs/audits/2026-05-19-phase-5-1-codex.md`
- `docs/audits/2026-05-19-phase-5-1-opus.md`
- `docs/audits/2026-05-19-phase-5-1-consolidated.md`

No 5.2 commits land until the consolidated audit doc is signed
off.

## Post-audit decisions (2026-05-19)

The parallel Codex + Opus audit (transcripts in `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md`)
closed the gating audit checkpoint. Decisions locked in:

### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`

**Status:** ⏳ PENDING — multi-day schema-breaking work; queued for next session.

**Source:** Opus H-1 + Codex V4 (independent confirmations).

The pre-audit design left format-id collision resolution as
open question 5 ("Phase 5.3 may switch to UUID"). Audit
verified the collision is a real bug: two peers concurrently
calling `intern_format("X")` and `intern_format("Y")` both
predict next-id N from the same workbook base, both emit
`Op::RegisterFormat { id: N, string: <different> }`. Replay's
`FormatTable::register_at` rejects the second with
`FormatRejectedSource::IdCollision`. Result: replay fails
deterministically rather than merging cleanly.

**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
tagged tuple:

```rust
pub enum FormatId {
    Builtin(u32),        // Excel-canonical ids 0–163 (unchanged)
    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
}
```

Each peer's allocator increments only its own `Custom` counter;
two peers can't collide. Built-in ids stay `u32` for round-trip
with Excel's id space.

**Schema impact:**
- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
  signature, `.qbook` envelope cell-format-id encoding, xlsx
  `cellXfs` numFmtId mapping all change.
- Wire-format bump: `WORKBOOK_SCHEMA_VERSION` increments.
- Backwards compat: old `.qbook` files with `u32` ids load as
  `FormatId::Builtin(n)` if `n ≤ 163` or
  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
  for migration. (Phase 5.2 designs the migration path.)

**Why not UUID?** UUIDs are bigger (128-bit), opaque to humans,
and don't carry the peer-of-origin information that
collaboration tooling wants. The tagged tuple gives the same
collision-freedom with better debuggability.

### D-2: AddSheet name collision — auto-rename in 5.2

**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.

**Source:** Opus H-3.

The pre-audit design said "AddSheet S × AddSheet S → first
wins; second errors via NameRejected" with auto-rename
deferred to Phase 5.3. Audit pushed back: spreadsheet users
expect Google Sheets behavior where both adds succeed with
auto-disambiguation (S and S(2)). Silent rejection of the
second is worse UX than auto-rename.

**Resolution:** Phase 5.2 acceptance criterion: AddSheet
collision auto-renames the SECOND ADD (in deterministic merge
order) to `<name>(2)`. If `<name>(2)` is also taken, escalate
to `<name>(3)`, etc.

This is a producer/replay path change, not a wire-format
change. The `Op::AddSheet { name }` op is unchanged; replay
re-resolves the final name at apply time when a collision is
detected. Producer-side emits the original name; replay-side
disambiguates.

### D-3: RenameSheet × concurrent edit — known V1 limitation

**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.

**Source:** Opus H-2 + Codex V5.

The pre-audit design described this as "edit's formula text
references the old name → bind fails → `#NAME?`." Codex
verified the actual bug shape:

- Bind error type is `BindError::UnknownSheet("S")`, NOT
  `BindError::UnresolvedName("S")` (different code path).
- `recompute_all` (post-Tier-C1) does NOT map
  `BindError::UnknownSheet` to `Value::Error(ErrorValue::Name)`
  — only `UnknownTable` and `UnknownTableColumn` get that
  treatment in `cells.rs::recompute_dirty` and `recompute_all`
  (`workbook_runtime/recompute.rs:179`).
- Result: the cell retains its stale pre-recompute value AND
  the formula appears as a `RecomputeFailure` in
  `RecomputeResult::failures`. Worse than `#NAME?` — the user
  sees the formula text but a wrong value.

**Resolution:** Phase 5.2 adds the missing
`BindError::UnknownSheet → ErrorValue::Name` mapping in
`recompute_all` and `recompute_dirty` so the cell at least
shows `#NAME?` after the merge. Phase 5.3 adds a causality-
aware rename-repair pass: at merge time, the replay sweep
walks formulas added causally-before the RenameSheet op and
rewrites their text in-place (the same way the producer-side
rename does for visible formulas).

Documented as a **known Phase 5.2 V1 limitation**: concurrent
cross-sheet formula additions may surface as `#NAME?` until
manual edit or until 5.3 ships the causality-aware repair.

### D-4: Spill semantics — replay defers to recompute, not per-op

**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.

**Source:** Codex V3.

The pre-audit design described spill semantics as "set_formula-
before-set_value-at-target ordering preserved by op log." This
described the producer-side path, but **replay does not work
that way**.

Codex's verification (`crates/ql-oplog/src/replay.rs:328`):
replay's `PutFormula` handler stores the formula text via
`workbook.put_formula(...)` but does NOT evaluate the formula
nor materialize the spill. Spills are derived from final
replay state by `recompute_all`/`recompute_dirty` AFTER replay
completes. The `write_spill` blocking check
(`cells.rs:669`) runs at recompute time, not at replay time.

**Implication for CRDT correctness:** concurrent
`PutFormula(A1, "SEQUENCE(3)")` + `PutValue(A2, 5)` from two
peers produces the same recompute outcome regardless of merge
order, because:

1. Replay applies both ops (in either order) — final workbook
   state has A1's formula text + A2's literal value.
2. `recompute_all` is called once post-replay.
3. `recompute_all` evaluates A1's formula → array result
   → `write_spill` checks A2 → A2 is occupied → spill blocked
   → A1 emits `#SPILL!`.

The CRDT correctness story holds, but for a different reason
than the pre-audit draft claimed. Updated wording in this
revision.

## Open questions — post-audit status

All 5 pre-audit open questions are resolved or formally deferred
post the 2026-05-19 audit. Status summary:

1. **Op-log compaction policy** — deferred to Phase 5.5
   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
   probe test exercising 1M ops measures export size with vs
   without `ExportMode::ShallowSnapshot` to set a baseline.

2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
   Loro's default is per-doc random `u64`; Phase 5.2 wires
   stable user-derived IDs at session-start.

3. **`Op::BatchCommit` atomicity under merge** — **VERIFIED
   correct** by Codex V2. `OpLog::append` serializes the whole
   `BatchCommit { ops: Vec<Op> }` as ONE JSON blob and pushes
   ONCE into the LoroList. A concurrent peer's op can land
   before or after the BatchCommit entry but cannot interleave
   between its nested ops. Atomicity holds.

4. **Sheet-rename cross-peer correctness** — **partially
   addressed by D-3** (above). The actual bug shape is
   `BindError::UnknownSheet` not mapped to `#NAME?` by
   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
   adds the causality-aware rename-repair pass. Documented as
   a known V1 limitation.

5. **Format id collision** — **✅ RESOLVED. D-1 SHIPPED 2026-05-20.**
   All 8 steps + 7 per-step audits + 1 full-arc megaudit complete. See
   `docs/phase5/d-1-exit-packet.md` for the closure record.
   `FormatId` now a tagged tuple `Builtin(u32) | Custom(PeerId, u32)`
   in `ql_storage::format` (step 3 `af803f1a3f2`). `FormatIdWire`
   the wire-side counterpart in `ql_oplog::wire` (step 2
   `135bbb99f75`). `Op::RegisterFormat` + `Op::SetCellFormat` carry
   `FormatIdWire` (step 4 `6a4b8b0922f`). `FormatTable::by_string`
   restructured into `by_builtin_string` (global) + `by_custom_string`
   ((peer, string)-keyed) so cross-peer same-string registrations
   succeed (step 4 + step-3-audit-closure). `lookup_string` helper
   ensures producer dedup is peer-scoped (step-4-audit-closure
   `e97e646270a`). `.qbook` envelope schema bumped v7→v8 with
   `FormatEntryId` untagged enum routing v8 Wire and v<8 LegacyU32
   shapes through `to_storage()` (step 5 `2ae5bfcab28`); save path
   emits Wire directly, dropping pre-step-5 `to_legacy_u32().expect()`
   panics. Step-5 audit closure (`30ef2637d6f`) added `FormatTableError::
   CounterOverflow` + `BuiltinOutOfRange` variants with `register_at`
   pre-validation, plus a post-deserialize guard rejecting v8-shaped
   ids in v<8 envelopes. xlsx export flattens multi-peer FormatIds via
   `XlsxNumFmtTranslation` (step 6 `19f6aa1b008`): LEGACY_PEER customs
   preserve `c + 164` for byte-stability; non-LEGACY peers dedup by
   format code into a contiguous range past LEGACY. Step-6 audit
   closure (`2ba66ee3710`) added dedup-by-code (prevents reimport
   StringCollision data loss), 2-pass translation (preserves sparse
   LEGACY counters), and Strict-policy file removal on
   `NewWorkbook`/`UpdateOriginal`. `.qbook/oplog.bin` files wrapped in
   Tier D3 magic + version header (step 7 `0ccc859958f`):
   `OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION = 1` prefix
   the Loro snapshot body. Step-7 audit closure (`0ad835f6060`) added
   `OPLOG_MIN_SUPPORTED_SCHEMA_VERSION` gate (rejects v0), refined
   legacy-path scope docs (backward-compat only for current Op enum
   shape — pre-step-4 op shapes fail at iter() loudly), and corrected
   doc drift across 5 sites. **Step 8 full-arc 3-way megaudit shipped
   (`8fc8376ff93` + `6e32c269c22`):** 3 HIGH + 6 MEDIUM + 2 LOW closed
   (release-build PeerId(0) guard, xlsx import/export unresolved-overlay
   reports, cross-crate doc drift, MIN_SUPPORTED gate, etc.). See
   `docs/phase5/d-1-exit-packet.md` for the D-1 closure record +
   `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
   Per-step audit transcripts at
   `docs/audits/2026-05-{19,20}-phase-5-2-d-1-step-{1..7}-*.md`; step 8
   megaudit transcripts at `docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-*.md`.

## Cross-references

- `docs/MASTER-PLAN.md` § Phase 5 (master spec).
- `docs/phase5/entry-plan.md` (Phase 5 entry status).
- `docs/PHASE-4-V2-BACKLOG.md` § D2 (`ql-oplog → ql-io`
  cleanup; pre-5.2 prerequisite).
- `crates/ql-oplog/src/log.rs` (the existing LoroDoc wrapper).
- `crates/ql-oplog/src/op.rs` (the 13-variant `Op` enum that
  Phase 5 inherits).
- `crates/ql-oplog/src/replay.rs` (the deterministic replay
  function that Phase 5's merge path reuses).
- `memory/quantbook_engine_audit_discipline.md` (the 2-way
  audit rule that gates this doc's sign-off).

## Documentation deliverables (Phase 5.1 closure)

- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
- `docs/audits/2026-05-19-phase-5-1-codex.md` ✅ shipped.
- `docs/audits/2026-05-19-phase-5-1-opus.md` ✅ shipped.
- `docs/audits/2026-05-19-phase-5-1-consolidated.md` ✅ shipped.
- `docs/MASTER-PLAN.md` § Phase 5.1 update — see `docs/phase5/v1-exit-packet.md` for the canonical Phase 5 V1 closeout.
