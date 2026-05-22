---
title: Phase 5.2 D-1 exit packet — FormatId tagged tuple, multi-peer-aware persistence
status: SHIPPED 2026-05-20
date: 2026-05-20
predecessor: docs/phase5/d-1-starting-checklist.md (execution plan)
audit_transcripts: docs/audits/2026-05-{19,20}-phase-5-2-d-1-step-{1..7}-{codex,opus,consolidated}.md + step-8-megaudit-{codex,opus-a,opus-b,consolidated}.md
---

# Phase 5.2 D-1 — FormatId tagged tuple — EXIT PACKET

## Status

**SHIPPED.** All 8 steps + 7 per-step audits + 1 full-arc megaudit closed.

- **Final HEAD:** `6e32c269c22` on `feat/quantbook-engine` (D-1 exit packet + 7 surface refreshes commit; preceded by `8fc8376ff93` megaudit closures).
- **Workspace tests:** 4291 passing / 0 failed (+69 net from pre-D-1 baseline of 4222).
- **fmt + clippy:** clean workspace-wide.
- **Audit cycles:** 16 (7 per-step + 7 per-step closures + 1 megaudit + 1 megaudit closure) — all 16 caught real bugs (per-step audits captured forward-activating bugs that the alternative "defer all to megaudit" would have shipped).

## What D-1 delivered

**Goal:** make Quantbook's `FormatId` collision-free under multi-peer CRDT collaboration. The pre-D-1 `FormatId(u32)` (single namespace) couldn't survive concurrent peers each interning custom formats — they'd allocate identical u32 ids and collide at merge.

**Solution:** tagged-tuple FormatId carrying peer-id discrimination.

```rust
// Pre-D-1:
pub struct FormatId(pub u32);

// Post-D-1:
pub enum FormatId {
    Builtin(u32),                // Excel-canonical 0..=163
    Custom(PeerId, u32),         // peer-allocated (collision-free)
}
```

## Architecture at a glance

| Layer | Type | Location | Role |
|---|---|---|---|
| Identity | `PeerId(u64)` | `ql_types::peer` | Canonical peer id; serde-transparent u64 |
| Sentinel | `LEGACY_PEER: PeerId = PeerId::new(0)` | `ql_types::peer` | Single-writer / qbook envelope migration peer |
| Storage | `FormatId::{Builtin(u32), Custom(PeerId, u32)}` | `ql_storage::format` | Workbook FormatTable's id |
| Wire | `FormatIdWire::{Builtin{id}, Custom{peer,counter}}` | `ql_oplog::wire` | Op::RegisterFormat + Op::SetCellFormat payload |
| Envelope | `FormatEntryId::{Wire(FormatIdWire), LegacyU32(u32)}` | `ql_io::qbook_format` | qbook envelope `id` field (untagged enum, auto-migrates v<8) |
| xlsx | `XlsxNumFmtTranslation` | `ql_io_xlsx::write::umya_export` | Flatten multi-peer ids → single xlsx numFmtId namespace |
| oplog file | Tier D3 header (`b"QLOL"` + BE u32 version) | `ql_io::oplog_persistence` | Format-identify oplog.bin + forward-rejection |

## Schema-version namespaces (3 independent)

| Constant | Current | Bumped by | Purpose |
|---|---|---|---|
| `qbook_format::WORKBOOK_SCHEMA_VERSION` | 8 | Step 5 | qbook envelope shape (v8 = FormatEntryId tagged tuple) |
| `oplog_persistence::OPLOG_SCHEMA_VERSION` | 1 | Step 7 | oplog.bin wrapper version |
| `FormatIdWire` serde shape | (no version) | Step 4 | Op wire format (changes invalidate all wire-bytes consumers) |

`OPLOG_MIN_SUPPORTED_SCHEMA_VERSION = 1` rejects v0 + future versions; `MIN_SUPPORTED_SCHEMA_VERSION = 1` for qbook envelopes likewise.

## Step-by-step commit map

| Step | Commit | Audit closure | What |
|---|---|---|---|
| 1 + 1.1 | `aaa54d32f4d` + `1e383dc9eeb` | `11765c5c48e` | PeerId moved to ql_types + serde + LEGACY_PEER + Cargo cycle fix |
| 2 | `135bbb99f75` | `1f83fd5f9a4` | FormatIdWire in ql_oplog::wire (tagged struct + deny_unknown_fields + from_u32_legacy) |
| 3 | `af803f1a3f2` + `36d580aa723` (doc) | `9f34eb96a93` | FormatId enum in ql_storage::format + 241 callsite cascade across 6 crates |
| 4 | `6a4b8b0922f` | `e97e646270a` | Op::* uses FormatIdWire + by_string peer-scope restructure |
| 5 | `2ae5bfcab28` | `30ef2637d6f` | qbook envelope v7→v8 + FormatEntryId untagged enum |
| 6 | `19f6aa1b008` | `2ba66ee3710` | xlsx FormatId↔numFmtId (dedup-by-code + LEGACY counter preservation + Strict policy) |
| 7 | `0ccc859958f` | `0ad835f6060` | Tier D3 oplog.bin magic + version header |
| 8 (megaudit) | (3-way audits) | `8fc8376ff93` + `6e32c269c22` (exit packet) | Cross-step closure: import/export unresolved overlay reports + release-build guard + 5 NEW adversarial tests |

Plus 4 doc-refresh commits (one per cycle that shipped through cycles 2, 5, 6, 7).

## What D-1 enables

1. **Multi-peer custom formats coexist** without collision (Phase 5.1 D-1 audit-locked design).
2. **`.qbook` round-trip preserves multi-peer ids** byte-stably (v8 envelope + FormatEntryId).
3. **xlsx export flattens multi-peer ids to single-namespace** with dedup-by-code + explicit reporting per the no-fallback rule.
4. **xlsx round-trip preserves format CODES** (peer-ids collapse to LEGACY_PEER on reimport — intrinsic to xlsx's single-namespace; reported via `XlsxExportReport.dropped_features`).
5. **Pre-D-1 `oplog.bin` files load via legacy path** for current Op shapes (per-op shape mismatches fail loud at iter()).
6. **Forward-rejection on future schema versions** (qbook v9+, oplog.bin v2+).
7. **All known bad-input paths surface loudly** (Builtin out-of-range, counter overflow, malformed envelope, version mismatch, unregistered overlay).
8. **Strict-mode xlsx export removes lossy file on failure** (no half-written artifacts).
9. **CollabSession PeerId(0) usage rejected at runtime** (release-firing assert).

## Audit-discipline metrics

| Metric | Value |
|---|---|
| Cycles run | 16 (per-step ship + per-step audit closure × 7, plus megaudit + closure) |
| Cycles that caught real bugs | 16/16 (100%) |
| Divergent-HIGH cycles | 5 consecutive (steps 3-7) + 1 megaudit (3-way divergent) |
| HIGH findings caught + closed | 9 (steps 3-7) + 3 (megaudit) = 12 |
| MEDIUM findings caught + closed | ~25 across all cycles |
| Forward-activating bugs caught BEFORE next step shipped | 9+ (would have shipped if audits deferred to step 8 megaudit) |

The discipline rule of mandatory parallel 2-way (per-step) + 3-way (megaudit) audit is reaffirmed as structurally load-bearing. Codex's tactical adversarial framing surfaces production-reachable bugs; Opus's holistic analysis surfaces design smells + doc-vs-code drift + missing API symmetry + test gaps. Neither lane alone would have closed the full set.

## Test count evolution

| Milestone | Tests |
|---|---|
| Pre-D-1 (V1 exit) | 4222 |
| Step 1 ship | 4222 |
| Step 1.1 ship | 4224 |
| Step 2 ship + audit | 4237 |
| Step 3 ship + audit | 4249 |
| Step 4 ship + audit | 4257 |
| Step 5 ship + audit | 4270 |
| Step 6 ship + audit | 4277 |
| Step 7 ship + audit | 4284 |
| **Step 8 megaudit closure** | **4291** |

**+69 net tests across the D-1 arc.**

## Deferred items (V2 backlog)

- **Codex LOW (step 7 + step 8 megaudit):** cross-test for version coupling (WORKBOOK_SCHEMA_VERSION + FormatIdWire serde shape + OPLOG_SCHEMA_VERSION). Currently independent; no enforcement that all three bump together on op-shape changes.
- **Opus-B MEDIUM-4 (step 8 megaudit):** real xlsx fixture coverage gap (mortgage_calculator.xlsx with sparse {167, 168, 170, 171, 174, 176, 179, 181, 184} not exercised). Synthetic step-6 test covers the property; fixture coverage is quality-improvement only.
- **Opus-B LOW-3 (step 8 megaudit):** `read_display` silent General fallback (`ql-exec::workbook_runtime::formats`). Pre-D-1 issue; out of D-1 scope.

## Cross-references

- Execution plan: `docs/phase5/d-1-starting-checklist.md` (kept for historical execution trace)
- Architecture: `docs/architecture/crdt-data-model.md` § D-1
- IDE contract: `docs/architecture/ide-consumer-contract.md`
- Master plan: `docs/MASTER-PLAN.md` § Phase 5.2 D-1
- V1 exit (Phase 5 V1 surface): `docs/phase5/v1-exit-packet.md`
- Per-step audit transcripts: `docs/audits/2026-05-{19,20}-phase-5-2-d-1-step-{1..7}-{codex,opus,consolidated}.md`
- Step 8 megaudit transcripts: `docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-{codex,opus-a,opus-b,consolidated}.md`

## What's next for Phase 5

After D-1, Phase 5 still has 4 sub-items. **Recommended priority order** (closure megaudit Codex MEDIUM):

1. **5.3** Conflict resolution (causality-aware rename-repair). **START HERE unless the user overrides.** 4-7 days, contained scope, completes the V1 merge-correctness story. V1 currently emits `BindError::UnknownSheet → #NAME?` as the simple case (D-3 shipped); 5.3 is the full causality story.
2. **5.5 V2 V2/V3** Production transport (WebSocket + reconnect + offline sync + auto-flush on append). Largest remaining scope (1-2 weeks). Unblocks the IDE.
3. **5.7** IDE vertical slice (two-window editing demo with multi-peer presence + format collaboration). **Depends on D-1 + 5.3 + 5.5 V2 V2** — don't start until all three are done.
4. **5.8** Phase 5 megaudit (separate from D-1 step 8 megaudit). 4-6 days; randomized peer-merge tests + transport failure modes. Run AFTER 5.3 + 5.5 stabilize.

**Recommended trade-off framing:** D-1 + D-2/D-3/D-4 + 5.4 + 5.6 already give the V1 + a multi-peer-aware FormatId architecture. 5.3 closes the most user-visible correctness gap (concurrent rename + merge); 5.5 V2 V2/V3 closes the transport gap; 5.7 closes the demo gap. 5.8 is the final megaudit before Phase 5 graduation. Going in order (5.3 → 5.5 → 5.7 → 5.8) is the default; the user may reorder if they have transport pressure or demo deadlines.

## Status update (2026-05-22 post-Phase-5.7-V1)

The forecast above DID hold: 5.3 → 5.5 → 5.7 was the actual ship order. As of 2026-05-22:

- **D-1** ✅ SHIPPED 2026-05-20 (this doc).
- **5.3** ✅ SHIPPED 2026-05-20 (`docs/phase5/5-3-exit-packet.md`).
- **5.5 V2 V2 + V2 V3 V1** ✅ SHIPPED 2026-05-21 (`docs/phase5/v2-v3-exit-packet.md`).
- **5.5 V2 V4 V1** ✅ SHIPPED 2026-05-21 (`docs/phase5/v2-v4-v1-exit-packet.md`; 12/13 Tier items closed, K4 deferred).
- **5.7 V1** ✅ SHIPPED 2026-05-22 (`docs/phase5/5-7-v1-exit-packet.md`; first IDE binding via napi-rs; V2 Transport binding + V3 cell-grid UI deferred).
- **5.8 megaudit** still future; depends on 5.7 V2+ being in scope.

The forward-options list above is HISTORICAL — check `memory/current_work.md` for live forward direction.
