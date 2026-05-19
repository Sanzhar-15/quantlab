---
title: Phase 5 entry plan — Multi-User CRDT Collaboration
status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; Phase 5.2.b PeerId → LoroDoc wiring SHIPPED (`ef056f50bee`); D-1 (FormatId tagged tuple) pending.
date: 2026-05-19
predecessor: docs/phase4/exit-packet.md
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
> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
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
| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
| 5.3 | Conflict Resolution Semantics | 4-7 days | Causality-aware rename-repair pass; multi-value / delete-vs-update. Loro merge is Fugue/origin-based (not Lamport LWW — corrected by Phase 5.1 audit). |
| 5.4 | Undo/Redo + Operation Grouping | 1 week | Local undo over collaborative ops. |
| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | WebSocket + reconnect merge. |
| 5.6 | Presence + Awareness | 3-5 days | Ephemeral state; must not dirty workbook graph. |
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
- `docs/architecture/conflict-resolution.md` — at 5.3 close.
- Loro upgrade-path notes.
