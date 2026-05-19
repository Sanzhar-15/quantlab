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

V2 may add the eviction sweep (`docs/PHASE-4-V2-BACKLOG.md` or
a 5.6 V2 plan, TBD). Until then, callers expecting "clean
slate on reopen" must call `CollabSession::clear_presence`
after `from_snapshot` and re-`update_presence` with current
state.

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
| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |

The 5.3 audit checkpoint validates these defaults against the
Phase 4.12 megaudit's cycle-detection / spill / drop-table
invariants — every Phase 4 edge case must survive the CRDT
merge.

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

### V1 wired surface

`ql_collab::CollabSession` exposes 7 typed methods:
- `undo() -> Result<bool, _>` / `redo() -> Result<bool, _>`
- `can_undo() -> bool` / `can_redo() -> bool`
- `undo_count() -> usize` / `redo_count() -> usize`
- `clear_undo_stack()`

Plus `pub use loro::UndoManager` in `ql_collab::undo` for
callers wanting raw access. Presence-origin commits
(`PRESENCE_COMMIT_ORIGIN = "presence:"`) are auto-excluded so
cursor movement doesn't pollute the undo stack.

### V1 limitations / V2 follow-ups

- No grouping API (`group_start` / `group_end`) — defer to V2.
- No merge-interval tuning (Loro's default 0 ms) — defer to V2.
- No push/pop listeners — defer to V2.
- `set_peer_id` after construction silently CLEARS the undo
  stack per Loro's internal subscription. V1 made
  `OpLog::set_peer_id` `&mut self` so the footgun isn't
  reachable from a shared `&OpLog` (Codex+Opus 5.4 V1 audit
  closure).

## Transport (Phase 5.5 — V1 partially shipped)

**V1 ✅ shipped at `924750819bc` (2026-05-19):** `Transport`
trait + `NoopTransport` (5.2.a) + `LoopbackTransport` (5.5 V1)
— in-process paired endpoints for 2-peer tests. The
`LoopbackTransport::pair()` constructor returns two endpoints
whose sends route to each other's recv queues; `Send + Sync`
so multi-threaded test patterns work too. Drain-before-Closed
semantic per the trait contract.

Loro's wire format:
- `LoroDoc::export(ExportMode::Updates(version_vector))` →
  bytes carrying only ops new-to-the-peer-since-version-vector.
- `LoroDoc::import(bytes)` → merge into local doc.

**V2 pending:** WebSocket transport (or any bidirectional byte
channel) for production. Each peer pushes version-vector
updates to the server; server fan-outs to other peers; each
peer imports. V2 also adds auto-flush wiring on `CollabSession`
(append a local op → push via attached `Transport`). V1's
`LoopbackTransport` is sufficient for engine-side tests.

5.1 does NOT pick a production transport (WS vs Server-Sent
Events vs custom protocol) — that's 5.5 V2's call. 5.1 just
confirms the substrate works regardless; 5.5 V1 proves it via
LoopbackTransport.

## Backwards compatibility with `.qbook` envelope

The current persistence layer (`crates/ql-io`) saves the
workbook as a `.qbook/` directory with JSON manifests +
parquet cell data. Op log persistence (`ql-oplog::persistence`)
saves the LoroDoc snapshot as `oplog.bin`.

Phase 5 preserves both. The CRDT additions are purely additive:
- `.qbook/oplog.bin` remains the same Loro snapshot blob.
- Loading a `.qbook` still produces a single-writer-equivalent
  workbook (no peer IDs, no presence).
- Joining a session = load `.qbook` locally + receive Loro
  updates from teammates + merge into the local doc.

The pre-existing replay path handles the single-writer case;
the new transport path handles the multi-peer case. Both call
the same `replay_into` internally.

## `ql-collab` crate scope

**Phase 5.2.a (2026-05-19, ✅ shipped at `66a571b30af`):** scaffold
ships with the following module surface:

```rust
// crates/ql-collab/src/lib.rs (current state)

pub mod peer;        // PeerId newtype (u64 wrapper)
pub mod session;     // CollabSession: per-peer state holder
pub mod transport;   // trait Transport + NoopTransport test impl

pub use peer::PeerId;
pub use session::{CollabSession, CollabSessionError};
pub use transport::{NoopTransport, Transport, TransportError};
```

Reserved (not yet populated, named in `docs/MASTER-PLAN.md` §541):
- `presence` — Phase 5.6 cursor + selection map.
- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.

Phase 5.2.a totals ~11 unit tests + ~600 LOC of scaffold. Phase
5.2.b onward populates richer behavior; full Phase 5.2 crate LOC
estimate remains 1,500-2,500 LOC + tests.

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

5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
   `FormatId` switches from `u32` to a tagged tuple
   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
   bump documented; backwards-compat migration path defined.

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
- `docs/audits/2026-05-19-phase-5-1-codex.md` — pending.
- `docs/audits/2026-05-19-phase-5-1-opus.md` — pending.
- `docs/audits/2026-05-19-phase-5-1-consolidated.md` — pending.
- `docs/MASTER-PLAN.md` § Phase 5.1 update marking design
  shipped + audit pending — pending.
