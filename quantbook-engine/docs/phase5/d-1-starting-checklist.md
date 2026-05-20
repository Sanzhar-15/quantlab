---
title: Phase 5.2 D-1 — fresh-session starting checklist (FormatId tagged tuple)
status: DRAFT — entry point for the multi-day D-1 implementation arc
date: 2026-05-19
predecessor: docs/phase5/v1-exit-packet.md
design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
---

# Phase 5.2 D-1 — fresh-session starting checklist

D-1 is the **active Phase 5.2 item** — multi-day, schema-breaking. **Steps 1-4 of 8 shipped + audited 2026-05-19/20; steps 5-8 pending.** After D-1, Phase 5 still has 5.3 (conflict resolution), 5.5 V2 V2/V3 (production transport), 5.7 (IDE vertical slice), and 5.8 (megaudit) ahead. This doc is the D-1 execution plan + status — fresh sessions reading this should start at the first unchecked step (currently step 5). Per-step audit transcripts: `docs/audits/2026-05-{19,20}-phase-5-2-d-1-step-{1..4}-{codex,opus,consolidated}.md`.

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
  - `PeerId` for `FormatIdWire::Custom(PeerId, u32)`: **✅ shipped at step 1.1 in `ql_types::PeerId`** (`1e383dc9eeb`) — was briefly at `ql_oplog::PeerId` in step 1 (`aaa54d32f4d`) but the step-1 audit caught a forthcoming Cargo cycle for step 3's `ql_storage::FormatId::Custom(PeerId, _)` (ql-storage can't depend on ql-oplog). `ql-oplog` + `ql-collab` re-export `ql_types::PeerId` for back-compat.

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

### Step 3: Change `ql-storage::FormatId` to the tagged tuple — ✅ SHIPPED 2026-05-19 (`af803f1a3f2`)

**Scope expansion vs original plan:** Original plan was "ql-storage change, downstream breaks, fix in steps 4-6." But the project's gates-clean-every-commit discipline made that untenable — `cargo test --workspace` failing for 3+ commits would break CI bisection. Step 3 ships the schema change + ALL 241 downstream callsites in 6 crates as a single gates-clean commit.

- ✅ FormatId enum: `Builtin(u32)` + `Custom(PeerId, u32)`. Accessors: `is_builtin()`, `is_custom()`, `GENERAL`.
- ✅ Migration helpers: `FormatId::legacy_from_u32(n)` + `FormatId::to_legacy_u32() -> Option<u32>` (None for non-LEGACY peer Customs).
- ✅ FormatTable carries `local_peer: PeerId` (default LEGACY_PEER); `with_peer(peer)` constructor + `set_local_peer(peer)` setter for step 4 CollabSession integration.
- ✅ `next_custom_id() -> u32` renamed to `next_custom_counter() -> u32`.
- ✅ 8 new format.rs tests pin peer-aware allocation + cross-peer collision-freedom + legacy round-trip.
- ✅ Downstream cascades:
  - ql-oplog: `FormatRejectedSource::id` u32 → FormatId. Replay converts Op u32 via `legacy_from_u32` (step 4 will drop this when Op carries FormatIdWire).
  - ql-io: qbook envelope save/load uses `to_legacy_u32().expect(...)` + `is_custom()`. Pre-step-5 envelope still u32-shaped.
  - ql-io-xlsx: xlsx import/export uses `legacy_from_u32` / `to_legacy_u32().expect(...)`. Pre-step-6 xlsx sees only LEGACY_PEER.
  - ql-exec: `RuntimeError::UnknownFormatId(u32)` → `UnknownFormatId(FormatId)`. `intern_format` allocates `Custom(local_peer, counter)`.
- ✅ Verified: 4244 workspace tests passing (+7 from new tests); fmt + clippy clean; no truncation.
- ⚠️ **2-way audit DEFERRED to fresh session** per CLAUDE.md max-2-cycles rule. Cycle 3 of session was an explicit override; audit awaits step 4 cycle.
- Commit: `af803f1a3f2`.

### Step 4: Update `Op::RegisterFormat` / `Op::SetCellFormat` to use FormatIdWire — ✅ SHIPPED 2026-05-20 (`6a4b8b0922f` + audit `e97e646270a`)

**Scope expanded from original 1-2h to 2-3h:** step 3's audit caught the cross-peer same-string KNOWN LIMITATION, which was deferred to step 4's by_string restructure. Step 4 deliverables:

- ✅ `Op::RegisterFormat { id: u32 → FormatIdWire }` + `Op::SetCellFormat { id: Option<u32> → Option<FormatIdWire> }`.
- ✅ `ReplayError::FormatNotRegistered { id: u32 → ql_storage::FormatId }`.
- ✅ `FormatIdWire::from_storage(FormatId) → Self` + `to_storage(self) → FormatId` conversions in `ql-oplog::wire`.
- ✅ Producer (`ql-exec::workbook_runtime::formats`) + replay (`ql-oplog::replay`) drop the legacy_from_u32/to_legacy_u32 expects.
- ✅ `FormatTable::by_string` restructured: `by_builtin_string: HashMap<String, FormatId>` (global) + `by_custom_string: HashMap<(PeerId, String), FormatId>` (peer-scoped). Closes step-3 KNOWN LIMITATION.
- ✅ Tests updated across 9 files; new tests pin the new structure.
- ✅ `debug_assert_ne!(peer, 0)` added to `CollabSession::new` + `from_snapshot` (Opus L4 closure).

**Step 4 audit (`e97e646270a`) — 2nd consecutive DIVERGENT-HIGH cycle**. Codex H1: `WorkbookRuntime::intern_format` global `iter().find()` bypasses peer scoping; closed via new `FormatTable::lookup_string(s)` helper. Codex M1: counter overflow at 3 sites; closed with `checked_add(1).expect(...)`. Codex M2: `from_snapshot` missing peer-id guard; closed. 6 new tests; +6 net workspace tests (4251 → 4257). Full transcripts at `docs/audits/2026-05-20-phase-5-2-d-1-step-4-{codex,opus,consolidated}.md`.

### Step 5: Backwards-compat in `qbook_format` — ✅ SHIPPED 2026-05-20 (`2ae5bfcab28` + audit `30ef2637d6f`)

Foundation step 4 + step 4 audit substrate is clean:

- ✅ Producer/replay symmetry verified (step 4 audit Codex H1 closure).
- ✅ FormatIdWire round-trip-tested both directions (Codex L1 + Opus L1 closures).
- ✅ Counter overflow safe (Codex M1 closure).
- ✅ PeerId(0) guard at both CollabSession constructors (Codex M2 closure).
- ✅ by_string peer-scope structurally correct + test-pinned.

Step 5 shipped:
- ✅ Bumped `WORKBOOK_SCHEMA_VERSION` 7 → 8.
- ✅ New `FormatEntryId` untagged enum: `Wire(FormatIdWire)` for v8 envelopes, `LegacyU32(u32)` for v1-v7. `to_storage()` dispatches per variant; `from_storage(fid)` always emits `Wire`. Migration is transparent at the deserialization boundary.
- ✅ `FormatEntry.id` + `FormatOverlayEntry.id` types `u32 → FormatEntryId`.
- ✅ Save path emits `FormatEntryId::from_storage(fid)` directly. Dropped `to_legacy_u32().expect()` panics at 2 sites — v8 envelopes express non-LEGACY peer Custom ids losslessly.
- ✅ `QbookError::MalformedFormat.id` `u32 → ql_storage::FormatId` (mirrors step-4 ReplayError change).
- ✅ 5 new tests at ship: v7-legacy-migration, v8-multi-peer-round-trip, on-disk-shape inspection, untagged dispatch unambiguity, from_storage Wire-emission.

**Step 5 audit (`30ef2637d6f`) — 3rd consecutive DIVERGENT-HIGH cycle**. Codex caught 2 HIGH (counter-overflow panic on load with `Custom(LEGACY_PEER, u32::MAX)`; `Builtin(>163)` load+resave drops entry) + 1 MEDIUM (v<8 envelopes accepting v8 wire-shaped ids). Opus PASSED structurally, caught 1 MEDIUM (docstring claims inline TOML shape but `to_string_pretty` emits section-header form) + 2 LOW. All 6 findings closed:
- ✅ HIGH-1: `FormatTableError::CounterOverflow { peer }` + `register_at` pre-validates before mutation. Load surfaces `MalformedFormat(CounterOverflow)`.
- ✅ HIGH-2: `FormatTableError::BuiltinOutOfRange { id }` + `register_at` pre-validates. Load surfaces `MalformedFormat(BuiltinOutOfRange)`.
- ✅ MEDIUM-1: post-deserialize loader guard rejects `FormatEntryId::Wire(_)` in v<8 envelopes.
- ✅ Opus MEDIUM: docstring updated to describe section-header form honestly.
- ✅ Opus LOWs: strengthened on-disk-shape test assertion + added two-peer round-trip + sort-determinism test.

8 new tests at audit closure (+3 ql-storage, +5 ql-io qbook_format). Workspace tests: 4257 → 4262 (step 5 ship) → 4270 (audit closure). Full transcripts at `docs/audits/2026-05-20-phase-5-2-d-1-step-5-{codex,opus,consolidated}.md`.

### Step 6: xlsx export / import (1-2 hours) — ⏳ NEXT

- Flatten `FormatId` → xlsx `numFmtId` on export.
- Inflate xlsx `numFmtId` → `FormatId::Builtin(n)` on import.
- Tests: existing xlsx round-trip tests should pass.
- Commit: `Phase 5.2 D-1 step 6 — xlsx numFmtId ↔ FormatId mapping`.

### Step 7: Tier D3 — oplog.bin magic bytes + version header (1 hour)

- Bundle with D-1 per the entry plan. Add a 4-byte magic header + u32 schema version to `oplog.bin`.
- This is the discriminator the loader uses to know whether to apply legacy FormatId migration.
- Commit: `Tier D3 — oplog.bin magic bytes + schema version header`.

### Step 8: Full-arc megaudit (mandatory per discipline rule)

**Per-step audits (steps 1-5) already shipped** — 5 cycles, 3 consecutive DIVERGENT-HIGH cycles (steps 3, 4, 5) caught forward-activating bugs that the alternative (defer all audits to step 8) would have shipped. Transcripts at `docs/audits/2026-05-{19,20}-phase-5-2-d-1-step-{1..5}-{codex,opus,consolidated}.md`.

Step 8 scope (after steps 6-7 ship):
- Per-step audits for steps 6, 7 same as 1-5 pattern.
- Then a **full-arc megaudit**: cross-step invariants (schema round-trip end-to-end, old `.qbook` → new envelope → old format export — does the value survive?), workspace-wide grep for any remaining `to_legacy_u32().expect()` or pre-D-1 patterns, fixture coverage gap analysis.
- Verify clean-checkout `cargo check` (don't trust pre-commit hook gates alone — the index-padding race struck 3 times in the V1 session; 0 times in D-1 so far).

**Estimated total: ~14 hours spent on steps 1-5 + 5 audits (2026-05-19/20); ~2-5h remaining for steps 6-8.** All schema-breaking work is complete (steps 1-5); steps 6-7 are surface-level format-id mapping work.

## Pre-flight checklist

Before resuming D-1 at step 6, verify:

- [ ] HEAD is at the most recent commit on `feat/quantbook-engine` (`30ef2637d6f` as of 2026-05-20 session-end — step 5 audit closures; preceded by `2ae5bfcab28` step 5 ship + `d5c6b2ae11c` step 4 doc refresh).
- [ ] `cargo test --workspace` reports **4270** passed.
- [ ] `cargo fmt --all -- --check` clean.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] No uncommitted source files (`git status --short | grep -v '^??'` empty).
- [ ] You've read this doc's Step 4 + Step 5 sections (most-recent + next), `docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md` (most-recent audit), and `crdt-data-model.md` § "Format id collision" (overall design status). `v1-exit-packet.md` is broader Phase 5 V1 context if needed.

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
