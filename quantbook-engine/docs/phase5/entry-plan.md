---
title: Phase 5 entry plan — Multi-User CRDT Collaboration
status: DRAFT (entry plan; Phase 5 not yet started)
date: 2026-05-18
predecessor: docs/phase4/exit-packet.md
master_plan: docs/MASTER-PLAN.md §541-621
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
| Phase 4 semantics broad enough (value / formula / name / table / format models stable) | ✅ (4131+ workspace tests, 260 fns, xlsx I/O, structured refs, locale, dates) |
| Stable operation vocabulary from `ql-oplog` | ⚠️ exists but Phase 4.12 Opus-C HIGH-3 flagged a dependency-direction issue (`ql-oplog::Op` reaches into `ql-io::CellWireValue`) — see Phase 5 prep below |
| Storage semantics for computed vs user state | ✅ (per `docs/architecture/calcgraph-runtime.md` — computed overlay separated) |
| IDE proof surface | Phase 6 work; Phase 5 produces the engine-side data model. |

## Phase 5 prep — work to land BEFORE 5.1

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
| 5.1 | Collaboration Data Model Decision | 3-5 days | Loro container shape decision. Audit checkpoint AFTER 5.1 (design audit). |
| 5.2 | `ql-collab` Core Documents | 1-2 weeks | Two-peer merge for cells/names/sheets. |
| 5.3 | Conflict Resolution Semantics | 4-7 days | Last-writer / multi-value / delete-vs-update. |
| 5.4 | Undo/Redo + Operation Grouping | 1 week | Local undo over collaborative ops. |
| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | WebSocket + reconnect merge. |
| 5.6 | Presence + Awareness | 3-5 days | Ephemeral state; must not dirty workbook graph. |
| 5.7 | IDE Vertical Slice | 1 week | Two-window editing. |
| 5.8 | Phase 5 Megaudit | 4-6 days | Randomized peer-merge tests + transport failure modes. |

Total Phase 5 effort estimate: **~7-12 weeks**.

## Risks at entry

1. **Loro container shape uncertain** — 5.1 is mostly design work.
   Codex + Opus design review recommended before any code.
2. **`oplog.bin` schema versioning is non-existent** — Phase 5 needs
   to land magic bytes + version up-front (D3 above).
3. **`WorkbookRuntime` monolith** (Phase 4.12 Opus-C HIGH-2) — if
   not split before 5.2, the CRDT-aware mutation paths will live
   in a 13K+ LOC file alongside existing single-writer paths. Hard
   to review, hard to test boundaries.
4. **Cycle-detection gap in `recompute_all`** (Phase 4.12 Opus-B H-2)
   — Phase 5 replay paths inherit this bug if not closed first.
5. **API stability** — Phase 5 will expose `ql-collab` types into
   the public API. The Tier A `#[non_exhaustive]` pass should
   precede Phase 5 to avoid 0.2.0-breaking churn on Phase-5-added
   variants.

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
