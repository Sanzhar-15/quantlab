---
title: Phase 5.2 D-1 — fresh-session starting checklist (FormatId tagged tuple)
status: DRAFT — entry point for the multi-day D-1 implementation arc
date: 2026-05-19
predecessor: docs/phase5/v1-exit-packet.md
design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
---

# Phase 5.2 D-1 — fresh-session starting checklist

D-1 is the **next major Phase 5.2 item** — multi-day, schema-breaking. After D-1, Phase 5 still has 5.3 (conflict resolution), 5.5 V2 V2/V3 (production transport), 5.7 (IDE vertical slice), and 5.8 (megaudit) ahead. This doc is a runway for the next session — assumes you've read `v1-exit-packet.md` for context.

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
  - `Op::RegisterFormat { id: u32, string: String }` → `Op::RegisterFormat { id: FormatIdWire, string: String }`. Since FormatId is owned by `ql-storage` and `ql-oplog` already depends on `ql-storage` (verified 2026-05-19; the doc previously claimed otherwise), introduce a wire-format type:
    - Option A (clean): add `ql-oplog::FormatIdWire` that mirrors the tagged tuple, with `from_storage`/`to_storage` conversions at the boundary. Matches the pattern of `CellWireValue` / `NamedTargetWire` already in `ql_oplog::wire`. **Recommended.**
    - Option B (direct re-use): `Op::RegisterFormat { id: ql_storage::FormatId, ... }`. Simpler but couples wire shape to storage shape — diverges from existing `CellWireValue` pattern.
  - `Op::SetCellFormat { sheet, row, col, id: FormatId }` (currently has `id: FormatId` per the audit doc) — sync to new shape.
  - `PeerId` for `FormatIdWire::Custom(PeerId, u32)`: **shipped at step 1.1 in `ql_types::PeerId`** (✅ commit pending — was briefly at `ql_oplog::PeerId` in step 1 `aaa54d32f4d` but the step-1 audit caught a forthcoming Cargo cycle for step 3's `ql_storage::FormatId::Custom(PeerId, _)`; ql-storage can't depend on ql-oplog). `ql-oplog` + `ql-collab` re-export `ql_types::PeerId` for back-compat.

### `ql-io` (persistence envelope)

- `crates/ql-io/src/qbook_format.rs`:
  - Cell-format-id encoding in the envelope JSON. Old: bare u32 number. New: tagged variant (e.g. `{"Builtin": 14}` or `{"Custom": [peer_hex, counter]}`).
  - **Schema bump:** `WORKBOOK_SCHEMA_VERSION` increments.
  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LEGACY_PEER, n - 164)`.
  - **Sentinel `LEGACY_PEER` constant: ✅ shipped at step 1.1** as `pub const LEGACY_PEER: PeerId = PeerId::new(0)` in `ql_types::peer`. PeerId(0) is a reserved sentinel — Loro accepts it as a valid peer-id but Phase 5.2.b documents that "two concurrent sessions MUST use distinct peer ids," so production callers will avoid 0; LegacyPeer claiming 0 is safe. (Alternative `PeerId(u64::MAX - 1)` was considered but `0` is the more obvious sentinel.)

### `ql-io-xlsx` (xlsx interop)

- `crates/ql-io-xlsx/src/read/styles_import.rs` + `read/cell_styles_xml.rs` + `read/styles_xml.rs` — read xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`. Also `ql-io-xlsx/src/lib.rs:231-275` for the top-level import wiring.
- `crates/ql-io-xlsx/src/write/umya_export.rs` — emit xlsx `cellXfs` from `FormatId`. Need a flattening function `FormatId → u32` for xlsx round-trip. Custom format ids need a stable mapping: probably `id_to_xlsx_numFmtId(format_id) = FIRST_XLSX_CUSTOM_NUMFMT + sequence_of_appearance`. (Note: there is NO `write/cell_styles_xml.rs`; the cell-styles XML is generated by `umya_export.rs` post-processing — checked 2026-05-19.)

### `ql-exec` (runtime + replay)

- `crates/ql-exec/src/workbook_runtime/formats.rs` — `intern_format(s: &str) -> FormatId` and `set_cell_format(sheet, row, col, format_id: FormatId)`. Both methods need peer-id context (from the runtime's attached OpLog → CollabSession). Update signatures or make peer-id implicit via a field.
- `crates/ql-exec/src/workbook_runtime/error.rs` — `RuntimeError::FormatRejected` already exists; may need new variants for cross-peer FormatId collisions (shouldn't happen by construction, but defensive).

### Tests

- `crates/ql-exec/tests/oplog_e2e.rs` + `phase_5_2_d4_spill_2peer_probe.rs` — wire-format round-trip tests; update for new FormatId shape.
- `crates/ql-io-xlsx/tests/opus_a_*.rs` — many tests reference FormatId; should still pass with the new shape since they don't observe the wire format directly.

## Step-by-step execution plan (recommended order)

This is the suggested order to keep the codebase in a compile-clean intermediate state after each step:

### Step 1: Introduce `PeerId` at ql-types layer (1-2 hours) — ✅ SHIPPED 2026-05-19

- ✅ Step 1 (commit `aaa54d32f4d`): moved `ql_collab::peer::PeerId` to
  `ql_oplog::peer::PeerId`. `ql_collab` re-exports `ql_oplog::PeerId`.
- ✅ Step 1.1 (commit pending after Codex audit): moved PeerId AGAIN
  to `ql_types::peer::PeerId` after the step-1 audit caught a
  forthcoming Cargo cycle. `ql-oplog` already depends on `ql-storage`;
  step 3's `ql_storage::FormatId::Custom(PeerId, _)` referencing a
  type living in `ql-oplog` would loop. `ql-types` is the true
  dependency floor — both `ql-storage` and `ql-oplog` depend on it.
  Also adds `#[serde(transparent)]` derives + `LEGACY_PEER` constant
  (= `PeerId(0)`) for step 5's qbook migration.
- `ql-oplog` + `ql-collab` re-export `ql_types::PeerId` for back-compat.
- Verify gates green.
- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`
  + `Phase 5.2 D-1 step 1.1 — move PeerId to ql-types + serde + LEGACY_PEER`.

### Step 2: Introduce `FormatIdWire` in ql-oplog (1-2 hours) — ✅ SHIPPED 2026-05-19

- ✅ Added `ql_oplog::wire::FormatIdWire` enum mirroring the planned tagged tuple. Two variants: `Builtin { id: u32 }` + `Custom { peer: PeerId, counter: u32 }`. Tagged-struct serde shape (`#[serde(tag = "kind", rename_all = "lowercase")]`) matches `NamedTargetWire`'s pattern.
- ✅ Did NOT change `Op::RegisterFormat.id` — that's step 4.
- ✅ Added `FormatIdWire::from_u32_legacy(n: u32) -> FormatIdWire` migration helper using `LEGACY_PEER` from step 1.1. Maps `0..=163` → `Builtin`, `>=164` → `Custom { peer: LEGACY_PEER, counter: n - 164 }`.
- ✅ Tests: 9 unit tests pinning serde JSON round-trips for both variants, `from_u32_legacy` boundaries (0 / 163 / 164 / large), equality + hash consistency, distinct-peer collision-freedom.
- ✅ Re-exported as `ql_oplog::FormatIdWire`.
- ✅ Codex+Opus 2-way audit closure (commit `<step-2 audit closure>`) added `#[serde(deny_unknown_fields)]` + 4 rejection tests + renamed misleading test (`round_trips_through_loro_value_bincode` → `round_trips_worst_case_through_serde_json`).
- Commits: `135bbb99f75` (initial ship) + audit closure commit (see audit transcripts at `docs/audits/2026-05-19-phase-5-2-d-1-step-2-*`).

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

- [ ] HEAD is at the most recent commit on `feat/quantbook-engine` (`2e945454cb5` as of 2026-05-19 session-end — `93210e43567` is the D1.a closure preceding the doc-refresh commit).
- [ ] `cargo test --workspace` reports **4222** passed.
- [ ] `cargo fmt --all -- --check` clean.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] No uncommitted source files (`git status --short | grep -v '^??'` empty).
- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).

**Cargo invocation pattern (Linux VM → Mac host):** cargo is NOT on PATH on the Linux VM where Claude runs. ALL cargo commands MUST go through the `mac` bridge:

```bash
mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && cargo <command>'
```

See user memory `orbstack_mac_bridge.md`. Direct `cargo` invocations from the Linux side will fail with command-not-found.

## Forward gotchas

- **Index-padding race:** struck **3 times** this session (2 truncation incidents on `session.rs` + 1+ pre-commit `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on doc commits — see `v1-exit-packet.md` § Index-padding race incidents). Mitigation: never `--no-verify`; re-stage + retry. Large-file edits (`cells.rs` at 5,217 LOC, `session.rs` at 1,768 LOC) trigger it most reliably. **Verify every commit's HEAD blob matches disk** via `git -C . show HEAD:path | wc -l` — the 2 truncation incidents would have shipped silently otherwise.
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
