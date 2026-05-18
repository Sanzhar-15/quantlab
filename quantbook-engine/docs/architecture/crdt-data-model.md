---
title: Phase 5.1 — CRDT Data Model Decision (Loro Container Shape)
status: DRAFT — design awaiting audit checkpoint + user sign-off
phase: 5.1
date: 2026-05-18
predecessor: docs/phase5/entry-plan.md
master_plan: docs/MASTER-PLAN.md § Phase 5 § 5.1
audit_required: parallel Codex + separate-Opus design review BEFORE 5.2 code
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
applies them in that order → final value = 7 (later in causal
order).

This **is** last-writer-wins on Lamport timestamps. It is the
canonical CRDT-list semantic. We get it for free from Loro.

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

New for Phase 5.6. Holds the per-peer cursor + selection +
typing indicator. Keys are peer-IDs (UUIDs); values are JSON
blobs with `{sheet, row, col, selection_end_row,
selection_end_col, typing: bool}`.

```
LoroDoc
├── LoroList "ops"
└── LoroMap "presence"
    ├── "peer-uuid-A": "{\"sheet\":0,\"row\":3,\"col\":2,...}"
    └── "peer-uuid-B": "{\"sheet\":1,\"row\":0,\"col\":0,...}"
```

**Why MOM (Map of Maps) is wrong for cells but right for presence**:
- Cells need ordering-aware merge (Tier C1 cycle detection
  depends on op-log order; spill-anchor invariants depend on
  set_formula-before-set_value-at-target ordering). Op-log
  preserves this.
- Presence is ephemeral and unordered — each peer overwrites
  its own key. LoroMap LWW merge gives "last position update
  wins per peer," which is exactly the desired semantic.

Presence updates do NOT persist across `.qbook` save/load.
Phase 5.6 wires the in-memory presence map; `.qbook` envelope
v8 may or may not persist it depending on whether the use case
demands "rejoin a session and see where teammates were" — out
of 5.1 scope.

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

The 5.1 design picks Option A → conflict semantics are entirely
LWW by Lamport-timestamp at the op-log level. Phase 5.3
formalizes this with these defaults:

| Concurrent op pair | Resolution |
|---|---|
| `PutValue { A1, v_a }` × `PutValue { A1, v_b }` | LWW |
| `PutFormula { A1, f_a }` × `PutFormula { A1, f_b }` | LWW |
| `PutValue { A1, v_a }` × `PutFormula { A1, f_b }` | LWW (op-log replay-order natural) |
| `ClearFormula { A1 }` × `PutFormula { A1, f }` | LWW |
| `SetName { foo, t_a }` × `SetName { foo, t_b }` | LWW |
| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |

The 5.3 audit checkpoint validates these defaults against the
Phase 4.12 megaudit's cycle-detection / spill / drop-table
invariants — every Phase 4 edge case must survive the CRDT
merge.

## Undo/redo (Phase 5.4 preview)

Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
peer has its own undo stack tracking THEIR appends only.
Undoing a peer's op removes that op from the log (semantically;
implementation may use tombstones).

This is local-undo, NOT collaborative-undo. Two users editing
the same cell + one user undoing their edit produces a sane
result: their edit is removed from the log; the other user's
edit (if later in causal order) stays.

Phase 5.4 wires this; 5.1 just confirms Loro provides the
primitive.

## Transport (Phase 5.5 preview)

Loro's wire format:
- `LoroDoc::export(ExportMode::Updates(version_vector))` →
  bytes carrying only ops new-to-the-peer-since-version-vector.
- `LoroDoc::import(bytes)` → merge into local doc.

Phase 5.5 wraps these with a WebSocket transport (or any
bidirectional byte channel). Each peer pushes version-vector
updates to the server; server fan-outs to other peers; each
peer imports.

5.1 does NOT pick a transport (WS vs Server-Sent Events vs
custom protocol) — that's 5.5's call. 5.1 just confirms the
substrate works regardless.

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

Currently empty (`crates/ql-collab/src/lib.rs` is a 17-line
placeholder).

Phase 5.2 populates it with:

```rust
// crates/ql-collab/src/lib.rs

pub mod session;     // CollabSession: per-peer state holder
pub mod transport;   // trait Transport: send/recv update bytes
pub mod presence;    // Presence map updates
pub mod undo;        // peer-local undo via Loro UndoManager
```

Each module is small (~200-400 LOC). Total Phase 5.2 crate
LOC estimate: ~1,500-2,500 LOC + tests.

The crate depends on:
- `ql-oplog` (for the LoroDoc + Op vocabulary)
- `ql-storage` (to apply replay)
- `ql-exec` (for `WorkbookRuntime` integration)

It does NOT depend on `ql-io` or `ql-io-xlsx` — Phase 4.12
Opus-C HIGH-3 (`ql-oplog → ql-io` cleanup, Tier D2 in v2
backlog) is a separate pre-5.2 item. Phase 5.1 design assumes
Tier D2 closes before 5.2.

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

## Open questions for the audit checkpoint

1. **Op-log compaction policy**: at what version-vector age do
   we trim old ops? Master plan § 5.5 says
   `ShallowSnapshot` is the answer; 5.1 design defers the
   when-to-snapshot policy to 5.5.

2. **Per-peer peer-IDs**: how are peer IDs assigned? Loro's
   default is per-doc random `u64`; for collaboration we likely
   want stable user-derived IDs. 5.2 picks.

3. **`Op::BatchCommit` atomicity under merge**: today's replay
   applies a batch's inner ops sequentially. With concurrent
   peer appends, the inner ops are STILL contiguous in the
   merged log (Loro preserves list-push contiguity per
   peer). Verify this with Loro docs + a probe test.

4. **Sheet-rename cross-peer correctness**: peer A renames
   sheet "S" → "X" while peer B writes a cell with
   `=S!A1+1`. After merge:
   - If A's RenameSheet op is causally-before B's PutFormula:
     B's formula text references "S" which no longer exists →
     bind fails → `#NAME?`. Correct.
   - If B's PutFormula is causally-before A's RenameSheet: A's
     producer-side rewrite should catch B's text and emit a
     PutFormula correcting it. But A doesn't see B's op until
     merge → A's BatchCommit may not include the rewrite for
     B's text. Bug? Phase 5.3 must address.

5. **Format id collision**: two peers each call
   `intern_format("X")` concurrently → both emit
   `RegisterFormat { id: N, string: "X" }` with the SAME
   predicted id. On merge, replay sees two register ops at the
   same id with the same string → idempotent OK. But what
   about `intern_format("X")` × `intern_format("Y")` predicting
   id N? Two different strings at the same id → replay's
   `FormatTable::register_at` rejects the second with
   `FormatRejectedSource::IdCollision`. Phase 5.3 must
   resolve.

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
