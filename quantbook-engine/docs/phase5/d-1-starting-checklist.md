---
title: Phase 5.2 D-1 — fresh-session starting checklist (FormatId tagged tuple)
status: DRAFT — entry point for the multi-day D-1 implementation arc
date: 2026-05-19
predecessor: docs/phase5/v1-exit-packet.md
design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
---

# Phase 5.2 D-1 — fresh-session starting checklist

D-1 is the last major Phase 5 item before the 5.8 megaudit. Multi-day, schema-breaking. This doc is a runway for the next session — assumes you've read `v1-exit-packet.md` for context.

## TL;DR

Change `FormatId` from `pub struct FormatId(pub u32)` to a tagged tuple:

```rust
pub enum FormatId {
    Builtin(u32),            // Excel-canonical ids 0–163
    Custom(PeerId, u32),     // peer-allocated custom format ids
}
```

Each peer's allocator increments only its own `Custom` counter; concurrent peers can't collide. Bumps the `.qbook` envelope schema. Backwards-compat: old files with `u32` ids load as `Builtin(n)` if `n ≤ 163`, else `Custom(LegacyPeer, n - 164)`.

## Audit-locked design (do not re-litigate)

Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.

**DO NOT** debate the design choice. The schema shape is locked. Implementation is the next session's job.

## Touchpoint inventory (verified 2026-05-19)

Sites that need updating, grouped by crate:

### `ql-storage` (the heart of the change)

- `crates/ql-storage/src/format.rs`:
  - `pub struct FormatId(pub u32)` → `pub enum FormatId { Builtin(u32), Custom(PeerId, u32) }`
  - `pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164` → either remove or repurpose.
  - `FormatTable::register_at(&mut self, id: FormatId, s: &str)` signature stays; logic updates to handle both variants.
  - `FormatTable::intern(&mut self, s: &str) -> FormatId` — needs peer-id context. Either: (a) add `intern_with_peer(peer: PeerId, s: &str)`; or (b) make FormatTable peer-aware via a `peer_id: PeerId` field set at construction.
  - `FormatTable::next_custom_id(&self) -> u32` becomes `next_custom_id(&self, peer: PeerId) -> u32` (per-peer counter).
  - `FormatTable::iter()` — iterator over `(FormatId, &str)`. Signature stays.

- `crates/ql-storage/src/lib.rs` — re-exports `FormatId`. Stays.
- `crates/ql-storage/src/sheet.rs` — `format_overlay: CellFormatOverlay`. CellFormatOverlay stores `FormatId` directly. Update its `set(row, col, FormatId)` value type (already `FormatId`, but underlying serde / Hash etc. needs reverification).
- `crates/ql-storage/src/format_overlay.rs` (if exists) — same as above.

### `ql-oplog` (wire format)

- `crates/ql-oplog/src/op.rs`:
  - `Op::RegisterFormat { id: u32, string: String }` → `Op::RegisterFormat { id: FormatId, string: String }`. Since FormatId is not currently in ql-oplog (it lives in ql-storage), need to introduce a wire-format type:
    - Option A (clean): add `ql-oplog::FormatIdWire` that mirrors the tagged tuple, with `from_storage`/`to_storage` conversions at the boundary.
    - Option B (couple): make ql-oplog depend on ql-storage. Currently doesn't — Tier D2 made ql-oplog the dependency floor.
    - **Recommend Option A.** Matches the pattern of `CellWireValue` / `NamedTargetWire` already in `ql_oplog::wire`.
  - `Op::SetCellFormat { sheet, row, col, id: FormatId }` (currently has `id: FormatId` per the audit doc) — sync to new shape.
  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.

### `ql-io` (persistence envelope)

- `crates/ql-io/src/qbook_format.rs`:
  - Cell-format-id encoding in the envelope JSON. Old: bare u32 number. New: tagged variant (e.g. `{"Builtin": 14}` or `{"Custom": [peer_hex, counter]}`).
  - **Schema bump:** `WORKBOOK_SCHEMA_VERSION` increments.
  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LegacyPeer, n - 164)`. Need a sentinel `LegacyPeer` constant.

### `ql-io-xlsx` (xlsx interop)

- `crates/ql-io-xlsx/src/read/styles_import.rs` — reads xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`.
- `crates/ql-io-xlsx/src/write/umya_export.rs` + `cell_styles_xml.rs` — emit xlsx numFmtId from `FormatId`. Need a flattening function `FormatId → u32` for xlsx round-trip. Custom format ids need a stable mapping: probably `id_to_xlsx_numFmtId(format_id) = FIRST_XLSX_CUSTOM_NUMFMT + sequence_of_appearance`.

### `ql-exec` (runtime + replay)

- `crates/ql-exec/src/workbook_runtime/formats.rs` — `intern_format(s: &str) -> FormatId` and `set_cell_format(sheet, row, col, format_id: FormatId)`. Both methods need peer-id context (from the runtime's attached OpLog → CollabSession). Update signatures or make peer-id implicit via a field.
- `crates/ql-exec/src/workbook_runtime/error.rs` — `RuntimeError::FormatRejected` already exists; may need new variants for cross-peer FormatId collisions (shouldn't happen by construction, but defensive).

### Tests

- `crates/ql-exec/tests/oplog_e2e.rs` + `phase_5_2_d4_spill_2peer_probe.rs` — wire-format round-trip tests; update for new FormatId shape.
- `crates/ql-io-xlsx/tests/opus_a_*.rs` — many tests reference FormatId; should still pass with the new shape since they don't observe the wire format directly.

## Step-by-step execution plan (recommended order)

This is the suggested order to keep the codebase in a compile-clean intermediate state after each step:

### Step 1: Introduce `PeerId` at ql-oplog layer (1-2 hours)

- Move `ql-collab::peer::PeerId` to `ql-oplog::peer::PeerId` (or copy-then-re-export to avoid breaking ql-collab callers).
- `ql-collab` re-exports `ql_oplog::PeerId` to keep its public surface stable.
- Verify gates green.
- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`.

### Step 2: Introduce `FormatIdWire` in ql-oplog (1-2 hours)

- Add `ql-oplog::wire::FormatIdWire` enum mirroring the planned tagged tuple. This is the "destination shape" for Op variants.
- Do NOT yet change `Op::RegisterFormat.id` — keep as u32 for compilation.
- Add `FormatIdWire::from_u32_legacy(n: u32) -> FormatIdWire` (the migration helper).
- Tests: round-trip FormatIdWire through serde JSON.
- Commit: `Phase 5.2 D-1 step 2 — introduce FormatIdWire in ql-oplog::wire`.

### Step 3: Change `ql-storage::FormatId` to the tagged tuple (2-3 hours)

- Update `format.rs` enum definition + all internal logic (`register_at`, `intern`, `lookup`, etc.).
- `FormatTable` may need a `peer_id: PeerId` field set at construction.
- All ql-storage tests pass.
- ql-exec / ql-io / ql-io-xlsx will likely fail to compile at this point — that's expected, fix in subsequent steps.
- Commit: `Phase 5.2 D-1 step 3 — FormatId enum in ql-storage (breaks downstream)`.

### Step 4: Update `Op::RegisterFormat` / `Op::SetCellFormat` to use FormatIdWire (1-2 hours)

- Wire-format bump in Op enum.
- Update producer (`ql-exec::workbook_runtime::formats`) + replay (`ql-oplog::replay`) to use the new shape.
- Tests update.
- Commit: `Phase 5.2 D-1 step 4 — Op wire format uses FormatIdWire`.

### Step 5: Backwards-compat in `qbook_format` (2-3 hours)

- Schema version bump.
- Old-format loader: detect schema version, migrate `u32` → `FormatId` via legacy mapping.
- Tests: load a fixture saved at the old schema, verify successful migration.
- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.

### Step 6: xlsx export / import (1-2 hours)

- Flatten `FormatId` → xlsx `numFmtId` on export.
- Inflate xlsx `numFmtId` → `FormatId::Builtin(n)` on import.
- Tests: existing xlsx round-trip tests should pass.
- Commit: `Phase 5.2 D-1 step 6 — xlsx numFmtId ↔ FormatId mapping`.

### Step 7: Tier D3 — oplog.bin magic bytes + version header (1 hour)

- Bundle with D-1 per the entry plan. Add a 4-byte magic header + u32 schema version to `oplog.bin`.
- This is the discriminator the loader uses to know whether to apply legacy FormatId migration.
- Commit: `Tier D3 — oplog.bin magic bytes + schema version header`.

### Step 8: Audit (mandatory per discipline rule)

- 2-way Codex + Opus audit of the full D-1 arc. Multi-step schema change is exactly the kind of cycle the audit-discipline rule was written for.
- Verify clean-checkout `cargo check` (don't trust pre-commit hook gates alone — the index-padding race struck twice this session).

**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.

## Pre-flight checklist

Before starting D-1, verify:

- [ ] HEAD is at the most recent commit on `feat/quantbook-engine` (`93210e43567` as of 2026-05-19 session-end).
- [ ] `cargo test --workspace` reports **4222** passed.
- [ ] `cargo fmt --all -- --check` clean.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] No uncommitted source files (`git status --short | grep -v '^??'` empty).
- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).

## Forward gotchas

- **Index-padding race:** struck 3 times this session. Mitigation: never `--no-verify`; re-stage + retry on `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Large-file edits trigger it most.
- **Loro UndoManager peer-id binding:** if D-1 changes how `FormatTable::peer_id` is set after construction, may interact with the 5.4 V1 audit's set_peer_id silent-clear footgun. The fix at 5.4 V1 made `OpLog::set_peer_id` `&mut self`; if D-1 needs to bump format-allocator peer-id mid-session, plan for the undo-stack clear as a documented side-effect.
- **Tier C2 (BatchCommit depth guard)**: still pending but low priority. Not blocking D-1.

## Definition of done

D-1 ships when:

1. `FormatId` is the tagged tuple in `ql-storage`.
2. `Op::RegisterFormat` + `Op::SetCellFormat` use the new wire format.
3. `.qbook` envelope schema bumped + old-schema files load via legacy migration.
4. xlsx round-trip preserves all FormatId variants correctly.
5. All 4222+ workspace tests pass; fmt + clippy clean.
6. 2-way Codex + Opus audit run + closures committed.
7. `v1-exit-packet.md` updated to reflect D-1 ✅ shipped, leaving 5.3 + 5.5 V2 V2/V3 + 5.7 + 5.8 as remaining Phase 5 items.

After D-1 ships, Phase 5 is **~80% complete** (5.1 + 5.2 + 5.4 + 5.5 V1 + 5.5 V2 V1 + 5.6 + 5.6 V2 + Tier D3). Remaining: 5.3 conflict resolution, 5.5 V2 V2/V3 WebSocket transport, 5.7 IDE vertical slice, 5.8 megaudit.
