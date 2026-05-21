---
title: Phase 5 entry plan — Multi-User CRDT Collaboration
status: SUPERSEDED-BY-EXIT-PACKETS — Phase 5 V1 COMPLETE 2026-05-19. **D-1 SHIPPED 2026-05-20** + **5.3 SHIPPED 2026-05-20**. See `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure) + `docs/phase5/v1-exit-packet.md` (canonical V1 record) + `docs/phase5/d-1-starting-checklist.md` (D-1 execution-trace history). 5.5 V2 V2/V3, 5.7, and 5.8 remain.
date: 2026-05-19
predecessor: docs/phase4/exit-packet.md
successor: docs/phase5/v1-exit-packet.md (closeout) + docs/phase5/d-1-starting-checklist.md (D-1 entry)
master_plan: docs/MASTER-PLAN.md §541-621
shipped_commits:
  - 918d7efdd91  # Phase 5.1 design — CRDT Data Model Decision (Loro container shape)
  - df52cb44ad2  # Phase 5.1 audit closures — design corrections + 4 decisions locked
  - e15e8908742  # Tier D2 — ql-oplog → ql-io reverse dep cleanup (Phase 4.12 Opus-C HIGH-3 closure)
  - e71312d4bcd  # Phase 5.2 D-3 closure — map BindError::UnknownSheet to #NAME?
  - 1ca19e2fa37  # Phase 5.2 D-2 closure — AddSheet auto-rename on duplicate-canonical
  - 2f217a2067a  # Phase 5.2 D-4 closure — 2-peer spill probe + OpLog::merge_bytes
  - 66a571b30af  # Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
  - ef056f50bee  # Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id (closes handoff-audit M-8)
  - c677e244704  # Phase 5.6 V1 — presence map (per-peer cursor + selection LoroMap LWW)
  - 89c02b9d83e  # Phase 5.4 V1 — peer-local undo/redo via Loro UndoManager
  - 924750819bc  # Phase 5.5 V1 — LoopbackTransport for 2-peer round-trip tests
  - ffd8f6e5f05  # Phase 5.5 V2 V1 — CollabSession transport wrappers (attach/detach/flush/poll)
  - 6138a7203f6  # Phase 5.4 V2 V1 — undo grouping + merge-interval
  - 7cbdc689ea9  # Phase 5.4 V2 V1.1 — RAII UndoGroupGuard
  - b8b2e04e0d7  # Phase 5 V1 exit packet
  - d4b3cdb2dc2  # Phase 5.6 V2 — sweep_presence (caller-opt-in clean rejoin)
  - 93210e43567  # D1.a complete (Tier D1 test-cluster re-partitioning, 9 tests relocated)
---

# Phase 5 entry plan — CRDT collaboration

This plan kicks off Phase 5 (Multi-User CRDT Collaboration) per
master plan §541. It documents what Phase 5 will build, what entry
state is verified, what dependencies / risks exist, and what work
queues up before each sub-item.

## Purpose

Turn collaboration from a single-writer op log into real multi-user
CRDT state for sheets, cells, names, tables, presence, undo/redo,
and offline sync.

## Entry state verification

Verified against `docs/phase4/exit-packet.md`:

| Entry requirement | Status |
|---|---|
| Phase 3 graph runtime exists | ✅ (`crates/ql-exec` + `crates/ql-calcgraph`) |
| Phase 4 semantics broad enough (value / formula / name / table / format models stable) | ✅ (4160 workspace tests, 260 fns, xlsx I/O, structured refs, locale, dates) |
| Stable operation vocabulary from `ql-oplog` | ✅ (Phase 4.12 Opus-C HIGH-3 dependency-direction issue closed at Tier D2, `e15e8908742` — `ql-oplog` is now the dependency floor; `CellWireValue` + `NamedTargetWire` moved to `ql_oplog::wire`) |
| Storage semantics for computed vs user state | ✅ (per `docs/architecture/calcgraph-runtime.md` — computed overlay separated) |
| IDE proof surface | Phase 6 work; Phase 5 produces the engine-side data model. |

## Phase 5 prep — work to land BEFORE 5.1

> **2026-05-19 status update:** Most Phase 5 prep is SHIPPED.
> - Tier A (`#[non_exhaustive]` pass + deprecated removals): ✅ shipped pre-session.
> - Tier C1 (cycle detection in recompute_all): ✅ shipped this session.
> - Tier D1 (WorkbookRuntime monolith → 9-submodule split): ✅ shipped this session.
> - Tier D2 (ql-oplog → ql-io reverse dep cleanup): ✅ shipped this session at `e15e8908742`.
> - Tier D3 (oplog.bin magic bytes + version header): ✅ SHIPPED via D-1 step 7 (`0ccc859958f` + audit `0ad835f6060`).
> - Tier B (parser/binder gaps): deferred (Phase 6 IDE work).
> - Tier C2 (BatchCommit depth guard): pending — low priority.
>
> Phase 5.1 design + audit closed; Phase 5.2 D-2 / D-3 / D-4 shipped;
> 5.2.a scaffold shipped. The list below is kept for historical record.

Per `docs/PHASE-4-V2-BACKLOG.md` Tier A + D (and select B/C/D from
the Phase 4.12 megaudit), these items should land before Phase 5
sub-items begin:

### Tier A — API stability (mechanical, ship-before-0.2.0)

- **A1.** `#[non_exhaustive]` pass across public enums.
- **A2.** Remove deprecated `XlsxPreservation.known_parts`.
- **A3.** Remove deprecated `XlsxError::Reconciliation`.
- **A4.** Per-crate stability docs.

Total: ~4-6 hours mechanical work. Schedule as one closure cycle.

### Tier D — Phase 5 prep architectural

- **D2.** `ql-oplog → ql-io` reverse dependency cleanup. Phase 5
  CRDT integration wants `ql-oplog` to be the dependency floor.
- **D3.** `oplog.bin` magic bytes + version header. Bundle into
  Phase 5.1 / 5.2 design.

D1 (WorkbookRuntime monolith split) is HIGH-impact but multi-day
refactor. Recommendation: SCHEDULE A SEPARATE CYCLE for D1 between
A* and 5.1. Phase 5 will add CRDT-aware mutation paths on top of
WorkbookRuntime; doing the split FIRST avoids re-doing the work
post-merge.

### Tier B — parser/binder gaps (defer or close opportunistically)

- **B1.** Literal-range bind (5.4 % corpus break) — affects Phase
  6 IDE acceptance but doesn't block Phase 5 data-model decisions.
  Can defer.
- **B2.** Omitted-arg syntax — same: Phase 6 IDE acceptance.
- **B3.** Parser recursion depth — security hardening, can ship in
  parallel with Phase 5.

### Tier C — recompute / op-log correctness

- **C1.** Cycle detection in `recompute_all`. Critical for `.qbook`
  load path. Affects Phase 5 because replay uses
  `recompute_all` per `ql-oplog::replay::replay_into`.
  **Recommendation: close C1 before 5.2.**
- **C2.** BatchCommit depth guard. Pair with C1.

## Phase 5 sub-items (per master plan)

| ID | Item | Effort | Notes |
|---|---|---|---|
| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold; D-2/D-3/D-4; 5.2.b; **D-1 ✅ SHIPPED 2026-05-20** (all 8 steps + 7 per-step audits + 1 megaudit; see `docs/phase5/d-1-exit-packet.md`). |
| 5.3 | Conflict Resolution Semantics | ✅ SHIPPED 2026-05-20 (4 days actual) | Causality-aware rename-repair pass for sheets + tables + columns. `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See `docs/phase5/5-3-exit-packet.md`. |
| 5.4 | Undo/Redo + Operation Grouping | 1 week | **🟢 V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19** — V1 `89c02b9d83e`: 7 undo/redo methods, presence-origin excluded. V2 V1 `6138a7203f6` + `e199a5fda5a`: grouping + merge-interval. V2 V1.1: `start_undo_group_scoped` returns `UndoGroupGuard` (RAII, panic/Err-safe). V2 V2 follow-up: push/pop listeners. |
| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | **🟡 V1 + V2 V1 + V2 V2 + V2 V3 steps 1-3 SHIPPED** — V1 `924750819bc`: `Transport` trait + `NoopTransport` + `LoopbackTransport`. V2 V1 `ffd8f6e5f05`: explicit-drive `attach/detach/has_transport` + `flush_to_transport` + `poll_remote`. V2 V2 ✅ 2026-05-21 (`51748b02944` + `b7aa4cb7bb9`): `AutoFlushPolicy::{Disabled, OnAppend}`. V2 V3 step 1 (`603bdc9aa6c` + `e5ff11d549a`): `flush_delta_to_transport` + `last_flushed_vv` + `OpLog::{oplog_vv, export_delta_bytes}` helpers; delta-path auto-flush + idempotency short-circuit. V2 V3 step 2 (`e4e1ce282b1` + `fc3de6f99c7`): `poll_remote*` auto-flush; 3-peer hub fanout. **V2 V3 step 3 ✅ 2026-05-21**: offline-write story — no explicit queue needed (Loro op log IS the implicit queue); adds `has_pending_flush()` ergonomic helper. V2 V3 steps 4-6 pending: WebSocket impl + megaudit + exit packet. |
| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 + V2 SHIPPED** — V1 `c677e244704`: `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 `d4b3cdb2dc2`: `sweep_presence` (caller-opt-in clean-slate; closes V1 persistence known-limitation). Remaining V2 V2: presence-changed callbacks (lower priority). |
| 5.7 | IDE Vertical Slice | 1 week | Two-window editing. |
| 5.8 | Phase 5 Megaudit | 4-6 days | Randomized peer-merge tests + transport failure modes. |

Total Phase 5 effort estimate: **~7-12 weeks**.

## Risks at entry

> **2026-05-19 update:** risks 1, 3, 4, 5 are CLOSED. Only risk 2
> (oplog.bin schema versioning) remains open — bundle into D-1 schema
> work.

1. ~~**Loro container shape uncertain**~~ — ✅ CLOSED. 5.1 design
   audit-closed at `918d7efdd91` + `df52cb44ad2`. Option A
   (op-log preservation on top of Loro `LoroList`) locked.
2. **`oplog.bin` schema versioning is non-existent** — Phase 5
   needs magic bytes + version header (Tier D3). Bundle into D-1
   tagged-tuple FormatId schema work (next session).
3. ~~**`WorkbookRuntime` monolith**~~ — ✅ CLOSED. Tier D1 split
   shipped this session: 12,725-LOC `workbook_runtime.rs` → 9
   sibling submodules + 247-LOC `mod.rs`. Public API surface
   byte-for-byte identical; 4160 tests passing.
4. ~~**Cycle-detection gap in `recompute_all`**~~ — ✅ CLOSED.
   Tier C1 shipped at `3451d90a03f` + audit closures
   `8137697b5fc`. Replay paths now inherit cycle detection via
   ephemeral `CalcgraphSession`.
5. ~~**API stability**~~ — ✅ CLOSED. Tier A
   `#[non_exhaustive]` pass + deprecated removals + per-crate
   stability docs shipped at `40bb584a25b`. Phase 5 additions
   to `Op`, error types, etc. won't break 0.2.0 consumers.
6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
   2026-05-19 at Phase 5.2.b. `OpLog::set_peer_id` added; called
   from `CollabSession::new` + `from_snapshot`. PeerId now wired
   through to Loro's merge metadata. Caller pitfall (concurrent
   sessions MUST use distinct peer ids) documented in
   `crates/ql-collab/src/peer.rs` + `crates/ql-oplog/src/log.rs`.

## Audit checkpoints

Per master plan Phase 5:
- **Design audit after 5.1 before implementation** — Codex + Opus
  parallel review of the Loro data model decision.
- **Megaudit after 5.7** — Phase 5.8 covers this.

## Exit criteria (forward target)

- `ql-collab` is real.
- Cells, formulas, names, sheets, and tables merge deterministically.
- Offline sync and conflict diagnostics work.
- Single-writer op log is no longer confused with collaboration.

## Cross-references

- `docs/MASTER-PLAN.md` §541-621 — Phase 5 sub-items + acceptance.
- `docs/phase4/exit-packet.md` — Phase 4 closure summary.
- `docs/PHASE-4-V2-BACKLOG.md` — deferred Phase 4 items, Tier A+D
  are Phase 5 blockers.
- `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` —
  Phase 4 final megaudit findings.
- `docs/architecture/calcgraph-runtime.md` — graph runtime contract
  Phase 5 builds on.

## Documentation deliverables (Phase 5)

- `docs/phase5/entry-plan.md` ✅ THIS DOC.
- `docs/phase5/exit-packet.md` — at Phase 5 close.
- `docs/architecture/crdt-data-model.md` — at 5.1 close.
- ~~`docs/architecture/conflict-resolution.md` — at 5.3 close.~~ **Superseded**: the conflict-resolution semantics live in `docs/architecture/crdt-data-model.md` § "Conflict resolution semantics" (lines 311+) — a separate file was never created. Phase 5.3 step 5 megaudit Opus-B LOW-2 closure (2026-05-20).
- Loro upgrade-path notes.
