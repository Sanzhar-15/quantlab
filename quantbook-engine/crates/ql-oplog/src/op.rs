//! The `Op` enum — the engine's mutation vocabulary for the op log.
//!
//! Phase 2A.3.a (2026-05-12): minimum producer set covering everything
//! `WorkbookRuntime` and `WorkbookTransaction` can mutate through their
//! public API. Future variants (sheet renames, sheet deletes, formatting
//! changes) land alongside the API additions that produce them.
//!
//! Each variant mirrors a `Workbook` mutation method one-to-one:
//!
//! | `Op` variant         | Replays to                                       |
//! |----------------------|--------------------------------------------------|
//! | `PutValue`           | `Workbook::put_at`                               |
//! | `ClearValue`         | `Workbook::put_at(.., Value::Blank)` (F2 closure)|
//! | `PutFormula`         | `Workbook::put_formula`                          |
//! | `ClearFormula`       | `Workbook::clear_formula`                        |
//! | `SetName`            | `Workbook::set_name`                             |
//! | `AddSheet`           | `Workbook::add_sheet_with_chunk_rows`            |
//! | `RegisterFormat`     | `FormatTable::register_at` (W5-80)               |
//! | `SetCellFormat`      | `CellFormatOverlay::set` / `::clear` (W5-80)     |
//! | `BatchCommit`        | (recursive — applies each inner op in order)     |
//! | `RenameSheet`        | `Workbook::rename_sheet` (Phase 4.6.C / 5.3 step 3) |
//! | `RemoveSheet`        | `Workbook::remove_sheet` (V3.5.0.3b tombstone)   |
//! | `MoveSheet`          | `Workbook::move_sheet` (V3.5.0.3c display-order overlay) |
//! | `SetReferenceMode`   | `Workbook::set_reference_mode` (W5-146 Phase 4.9.J) |
//! | `SetLocale`          | `Workbook::set_locale` (W5-146 Phase 4.9.J)      |
//! | `SetDateSystem`      | `Workbook::set_date_system` (V3.6.0.X audit-of-D4 CONVERGENT-HIGH-1 closure) |
//!
//! ## Wire format choices
//!
//! - `Arc<str>` is NOT used in wire fields. `serde` without the `rc`
//!   feature can't deserialize `Arc<str>` directly. We store `String` on
//!   the wire and convert at the replay boundary. Cleaner separation: the
//!   wire format owns its strings; the runtime types share via Arc once
//!   inside the workbook.
//! - `ValueWire` and `NamedTargetWire` are reused from
//!   `ql_io::qbook_format` (Phase 2A.8 shipped them). Sharing the
//!   serialization vocabulary across the engine's three persistence
//!   surfaces (qbook envelope, qbook JSONL, op log) prevents wire-format
//!   drift.

use serde::{Deserialize, Serialize};

use crate::wire::{CellWireValue, NamedTargetWire};
use ql_types::{ColId, RowId, SheetId};

/// A mutation operation recordable in the op log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
#[non_exhaustive]
pub enum Op {
    /// Single literal cell write. Mirrors `WorkbookRuntime::set_value`.
    PutValue {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: CellWireValue,
    },

    /// **F2 Blank-durability closure (2026-05-27):** clear a cell's
    /// literal VALUE (set it to `Value::Blank`) WITHOUT touching its
    /// formula association. Replays to `Workbook::put_at(.., Value::Blank)`
    /// — the SAME storage mechanism `WorkbookRuntime::set_value` uses
    /// when handed `Value::Blank` (it clears the user overlay by writing
    /// Blank, which the read cascade reports identically to an absent
    /// entry).
    ///
    /// **Why a dedicated op**: `CellWireValue::from_value(&Value::Blank)`
    /// returns `None` (Blank is the storage default, encoded as the
    /// ABSENCE of a `CellRecord`), so a Blank `set_value` previously
    /// emitted NO op at all. The workbook was cleared live, but the
    /// clear was invisible to the op log — replaying the log into a
    /// fresh workbook (the canonical rebuild path, `replay_into`) did
    /// NOT reproduce the clear: a cell that was `5` then Blank-cleared
    /// replayed back to `5`. That broke save/load durability AND undo
    /// correctness (which re-materializes via replay). `ClearValue`
    /// closes the gap: every value-clearing path now logs a replayable
    /// op.
    ///
    /// **Tombstoned-sheet semantics** (mirrors `PutValue` /
    /// `ClearFormula`, V3.5.0.3b): replay onto a tombstoned sheet is a
    /// silent no-op. `apply_op` checks `workbook.is_sheet_removed(sheet)`
    /// after `validate_cell` and returns `Ok(())` without writing.
    /// Concurrent {ClearValue, RemoveSheet}: ClearValue-first clears the
    /// cell then RemoveSheet tombstones (cell unreachable via snapshot);
    /// RemoveSheet-first silently drops the ClearValue. Deterministic
    /// causal-merge order resolves; all peers converge.
    ///
    /// **Wire format compatibility**: additive new variant on the serde-
    /// tagged enum; **`OPLOG_SCHEMA_VERSION` NOT bumped** (consistent
    /// with every prior variant addition — RenameSheet / RemoveSheet /
    /// RestoreSheet / MoveSheet). **Backward-compat**: new binaries read
    /// pre-F2 .qbook files cleanly (no `Op::ClearValue` instances).
    /// **Forward-compat caveat**: pre-F2 binaries reading a post-F2
    /// saved .qbook with `Op::ClearValue` instances WILL fail
    /// deserialization with `OpLogError::Deserialize` (serde `tag =
    /// "kind"` rejects unknown variant tags). Same forward-compat
    /// property as every historical `Op` variant addition; see the
    /// `Op::RemoveSheet` docstring for the V3.x maintainer guidance on
    /// schema bumps.
    ClearValue {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Single formula write (text only — replay re-evaluates via the
    /// caller's `WorkbookRuntime::recompute_all`, not via replay itself).
    /// Mirrors `WorkbookRuntime::set_formula` for the persistence side.
    PutFormula {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        text: String,
    },

    /// Remove formula association at a cell (cell becomes literal-only).
    /// Mirrors `Workbook::clear_formula`.
    ClearFormula {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Register a defined name. Mirrors `Workbook::set_name` when
    /// `scope` is `None`, and `Sheet::set_scoped_name` when `scope` is
    /// `Some(sheet_id)`. **W5-92 (Phase 4.6.D)** added the optional
    /// `scope` field per design doc § 8.2 / Codex MEDIUM-4: a single
    /// op variant covers both scopes rather than two separate ops.
    ///
    /// Wire compat: `#[serde(default, skip_serializing_if = "Option::is_none")]`
    /// keeps v3+old ops deserializing unchanged (missing field → `None`
    /// = workbook scope, the historical behavior). Sheet-scoped names
    /// emit the field; workbook-scoped names omit it.
    ///
    /// Replay: routes to `Workbook::set_name` (scope `None`) or
    /// `Sheet::set_scoped_name` (scope `Some`); reserved-name refusal
    /// surfaces as `ReplayError::NameRejected` in either path. A
    /// `scope: Some(id)` referencing an unknown sheet surfaces as
    /// `ReplayError::InvalidSheet`.
    SetName {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<SheetId>,
        name: String,
        target: NamedTargetWire,
    },

    /// Create a new sheet. Mirrors `Workbook::add_sheet_with_chunk_rows`.
    /// Sheet IDs are deterministic (the workbook assigns them in append
    /// order); the producer doesn't pin the ID in the op, since replay
    /// against an empty workbook produces the same sequence.
    AddSheet { name: String, chunk_rows: u32 },

    /// **W5-91 (Phase 4.6.C):** rename an existing sheet by id. Mirrors
    /// `Workbook::rename_sheet`. Per design doc § 3.1, the producer-side
    /// runtime rewrites all stored formula text BEFORE emitting this op
    /// (and emits `Op::PutFormula` ops for each rewritten cell in the
    /// same `BatchCommit`), so replay-on-top-of-snapshot OR replay-from-
    /// empty both produce correct state.
    ///
    /// **Phase 5.3 step 2 audit closure (Codex MEDIUM-2, 2026-05-20):**
    /// `old_name` is now ADVISORY at replay time, not validated. Pre-
    /// step-2 the replay handler rejected ops whose `old_name` didn't
    /// match the current sheet name (`SheetRenameNameMismatch`); under
    /// CRDT merge of concurrent renames the second op's `old_name`
    /// legitimately fails to match, so the validation was wrong. Post-
    /// step-2 the replay handler unconditionally renames the sheet at
    /// `id` to `new_name` (with D-2-style auto-disambiguation on
    /// duplicate targets). `old_name` is retained on the wire for:
    ///   - diagnostics in `ReplayError::SheetRenameRejected.old_name`
    ///   - producer-side single-writer log debuggability (the op records
    ///     what the producer's local state was at write time)
    ///   - future re-introduction of strict-mode replay if needed
    ///
    /// **Trade-off**: single-writer malformed logs (`old="Wrong",
    /// new="X"` against current "S") now silently rename "S" → "X"
    /// rather than erroring. The CRDT use case requires this; we
    /// accept the single-writer trade-off because the producer-side
    /// `WorkbookRuntime::rename_sheet` validates locally before
    /// emitting, so a malformed op indicates corruption or a custom
    /// op-log producer that bypassed the runtime.
    RenameSheet {
        id: SheetId,
        old_name: String,
        new_name: String,
    },

    /// **Phase 5.7 V3.5.0.3b (2026-05-24):** mark an existing sheet as
    /// REMOVED (tombstone) without shifting subsequent sheet ids.  CRDT
    /// semantic per V3.5.0.3b decision lock:
    ///
    /// - **Why tombstone, not hard delete**: hard-deleting (removing
    ///   from `Workbook.sheets` and shifting subsequent ids) would
    ///   break every post-delete `Op::PutValue { sheet: 5, ... }` that
    ///   references the sheet by id.  Tombstone preserves id stability
    ///   so all subsequent ops keep their referent.
    ///
    /// - **Idempotent under concurrent delete**: two peers concurrently
    ///   removing the same sheet is a no-op for the second op (the
    ///   sheet is already in `removed_sheets`).  Apply_op silently
    ///   succeeds; cross-peer convergence preserved.
    ///
    /// - **Write to tombstoned sheet -> silent no-op**: `Op::PutValue`
    ///   / `Op::PutFormula` / `Op::ClearFormula` apply_op handlers check
    ///   `workbook.is_sheet_removed(sheet)` after `validate_cell` and
    ///   return `Ok(())` without writing.  Concurrent {PutValue, RemoveSheet}
    ///   with PutValue replaying FIRST writes the cell then tombstones
    ///   the sheet (cell unreachable via snapshot); with RemoveSheet
    ///   FIRST silently drops the PutValue.  Deterministic causal-merge
    ///   order resolves; all peers converge to the same final state.
    ///
    /// - **Formula references to tombstoned sheets**: V3.5.0.3b ship
    ///   leaves formula text intact (no `#REF!` substitution).  V3.6+
    ///   may extend `repair_sheet_rename_chain` to rewrite cross-sheet
    ///   formula references as `#REF!` per xlsx/Sheets convention.
    ///
    /// - **Restore / un-delete**: not supported at V3.5.0.3b.  Cell
    ///   data for tombstoned sheets remains in storage but is not
    ///   user-accessible.  V3.6+ may add `Op::RestoreSheet` if a
    ///   user-facing undo-delete flow is justified.
    ///
    /// **Wire format compatibility**: additive new variant on the serde-
    /// tagged enum; **`OPLOG_SCHEMA_VERSION` NOT bumped** (consistent
    /// with W5-91 Op::RenameSheet addition + every prior variant
    /// addition's convention).  **Backward-compat**: V3.5.0.3b+ binaries
    /// read pre-V3.5.0.3b .qbook files cleanly (no Op::RemoveSheet
    /// instances; nothing to deserialize).
    /// **Forward-compat caveat**: pre-V3.5.0.3b binaries reading a
    /// V3.5.0.3b+ saved .qbook with `Op::RemoveSheet` instances WILL
    /// fail deserialization with `OpLogError::Deserialize` (serde
    /// `tag = "kind"` rejects unknown variant tags; no `#[serde(other)]`
    /// catch-all on this enum).  Same forward-compat property as every
    /// historical Op variant addition.  V3.x maintainers: if forward-
    /// compat for older readers becomes a product concern, ship a
    /// schema-version bump + migrator AS A SEPARATE PHASE; do NOT
    /// retrofit individual Op additions.
    RemoveSheet { id: SheetId },

    /// **Phase 5.7 V3.6.0.10 D8 (2026-05-25):** un-tombstone a sheet
    /// previously marked via `Op::RemoveSheet`.  Reverses the
    /// V3.5.0.3b tombstone effect.  CRDT semantic:
    ///
    /// - **Cell preservation**: the V3.5.0.3b tombstone semantic
    ///   preserves the underlying `Sheet` storage at `sheets[id]`,
    ///   so cells written BEFORE the tombstone reappear when
    ///   restored.  Cells that callers attempted to write WHILE
    ///   tombstoned were silent-no-op'd at the apply_op layer and
    ///   never reached the underlying storage -- those do NOT
    ///   reappear on restore.  This is the consistent semantic for
    ///   the V3.5.0.3b silent-no-op contract.
    ///
    /// - **Idempotent under concurrent restore**: two peers
    ///   concurrently restoring the same sheet is a no-op for the
    ///   second op (the sheet is already absent from
    ///   `removed_sheets`).  `HashSet::remove` on absent is a no-op;
    ///   cross-peer convergence preserved.
    ///
    /// - **Cross-peer {RemoveSheet, RestoreSheet} ordering**: Loro's
    ///   causal-merge iteration order resolves; whichever op replays
    ///   second wins.  Restore-then-remove leaves the sheet
    ///   tombstoned; Remove-then-restore leaves it visible.
    ///
    /// - **Out-of-range ids**: silently dropped (matches
    ///   `Op::RemoveSheet`'s permissive contract).
    ///
    /// - **Formula refs to (previously-tombstoned, now-restored)
    ///   sheets**: V3.6.0.10 ships leaves formula text intact.
    ///   Pre-tombstone formula text is preserved across the
    ///   tombstone-restore round-trip because the V3.5.0.3b
    ///   tombstone is a flag, not a destructive op.  V3.6+ #REF!
    ///   substitution (D7, conditional) would interact with this
    ///   variant if shipped.
    ///
    /// **Wire format compatibility**: additive new variant on the
    /// serde-tagged enum; **`OPLOG_SCHEMA_VERSION` NOT bumped**
    /// (consistent with every prior V3.5.x / V3.6.x variant addition).
    /// **Backward-compat**: V3.6.0.10+ binaries read pre-V3.6.0.10
    /// .qbook files cleanly (no Op::RestoreSheet instances).
    /// **Forward-compat caveat**: pre-V3.6.0.10 binaries reading
    /// a V3.6.0.10+ saved .qbook with `Op::RestoreSheet` instances
    /// WILL fail deserialization with `OpLogError::Deserialize`
    /// (same serde `tag = "kind"` reject-unknown-variant behavior
    /// as Op::RemoveSheet / Op::MoveSheet; see V3.5.0.3b docstring
    /// for the V3.x maintainer schema-bump guidance).
    RestoreSheet { id: SheetId },

    /// **Phase 5.7 V3.5.0.3c (2026-05-24):** reorder sheets in the
    /// workbook's display order without shifting underlying sheet ids.
    /// CRDT semantic per V3.5.0.3c decision lock (display-order overlay
    /// recommended approach, mirroring V3.5.0.3b tombstone's id-stability
    /// strategy):
    ///
    /// - **id stays stable**: subsequent ops referencing the moved
    ///   sheet by id (`Op::PutValue { sheet: id, .. }` etc.) keep
    ///   landing on the correct sheet.  The "move" only affects
    ///   `Workbook.sheet_display_order` -- a separate
    ///   `Vec<SheetId>` that records the user's preferred
    ///   rendering order.
    ///
    /// - **new_index semantics**: 0-based position in the post-move
    ///   `sheet_display_order` vec.  The handler:
    ///     1. Finds the current display position of `id` (linear
    ///        search; sheet counts are small per CRDT contract).
    ///     2. Removes `id` from its current position.
    ///     3. Inserts `id` at `new_index` (clamped to
    ///        `[0, display_order.len()]` -- out-of-range silently
    ///        clamps to the end for CRDT idempotency under racing
    ///        ops).
    ///
    /// - **Idempotent under concurrent move-same-sheet**: two peers
    ///   concurrently moving sheet 5 to different positions resolve
    ///   via deterministic Loro causal-merge order: whichever replays
    ///   second wins on display position.  Cross-peer convergence
    ///   preserved.
    ///
    /// - **Move-tombstoned-sheet**: silently applies (display order
    ///   updates even though the sheet is tombstoned + filtered from
    ///   `workbookSnapshot`).  Reasoning: display order is metadata,
    ///   not content; the user's "intent to reorder" is preserved
    ///   even if the sheet is later un-deleted (V3.6+).  Snapshot
    ///   skip-filter on `is_sheet_removed` happens at the
    ///   `workbookSnapshot` napi layer, NOT the display-order layer.
    ///
    /// - **Move-non-existent-sheet** (id not in `display_order`):
    ///   silently no-op.  Mirrors `Op::RemoveSheet`'s out-of-range
    ///   tolerance + matches CRDT cross-peer causal-merge friendliness
    ///   (a peer might see a Move before the corresponding AddSheet
    ///   has replayed locally; eventual causal order rectifies, but
    ///   the strict-error path would break the merge).
    ///
    /// - **Backward compat**: `Workbook` initializes
    ///   `sheet_display_order` to `[]`; each `add_sheet` appends the
    ///   new id.  Sessions that never call `Op::MoveSheet` see
    ///   identical iteration order to V3.5.0.3b (`0..sheet_count()`).
    ///
    /// **Wire format compatibility**: additive new variant on the serde-
    /// tagged enum; **`OPLOG_SCHEMA_VERSION` NOT bumped** (consistent
    /// with W5-91 Op::RenameSheet addition + V3.5.0.3b Op::RemoveSheet
    /// addition).  **Backward-compat**: V3.5.0.3c+ binaries read
    /// pre-V3.5.0.3c .qbook files cleanly -- no `Op::MoveSheet`
    /// instances exist + `sheet_display_order` rebuilds fresh in
    /// append order during `replay_into` -> `add_sheet` calls.
    /// **Forward-compat caveat**: pre-V3.5.0.3c binaries reading a
    /// V3.5.0.3c+ saved .qbook with `Op::MoveSheet` instances WILL
    /// fail deserialization with `OpLogError::Deserialize` (same
    /// serde `tag = "kind"` reject-unknown-variant behavior as
    /// `Op::RemoveSheet` -- see that variant's docstring for the V3.x
    /// maintainer guidance on schema bumps).
    MoveSheet {
        id: SheetId,
        /// 0-based target position in the post-move display order
        /// (clamped to `[0, display_order.len()]` at apply_op time).
        new_index: u32,
    },

    /// Register a format string at a specific id. Mirrors
    /// `FormatTable::register_at`. Emitted when
    /// `WorkbookRuntime::intern_format` allocates a NEW id; idempotent
    /// on replay (re-registering an existing id with the same string
    /// is a no-op). Re-registering at the same id with a DIFFERENT
    /// string fails at `FormatTable::register_at` and surfaces as
    /// `ReplayError::FormatRejected`. Shipped W5-80 (Phase 4.5.D part 4).
    ///
    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from `u32`
    /// to [`crate::wire::FormatIdWire`] (tagged tuple `Builtin(u32)` /
    /// `Custom(PeerId, u32)`). The `from_u32_legacy` migration helper
    /// converts pre-5.2 saves to the new shape at envelope-load time
    /// (step 5).
    RegisterFormat {
        id: crate::wire::FormatIdWire,
        string: String,
    },

    /// Set or clear a cell's format id. Mirrors
    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
    /// (when `id` is `None`). The id MUST resolve in the workbook's
    /// `FormatTable` at replay time; an unknown id surfaces as
    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
    ///
    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from
    /// `Option<u32>` to `Option<FormatIdWire>`.
    SetCellFormat {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        /// `None` ⇒ clear the overlay entry (cell falls back to General).
        /// `Some(id)` ⇒ bind the cell to that format id.
        id: Option<crate::wire::FormatIdWire>,
    },

    /// **W3 (insert/delete rows & columns):** insert `count` blank rows at
    /// row index `at` on `sheet` (0-indexed; `at` is the row that the new
    /// blank rows push DOWN). Replays to `Workbook::insert_rows`, which
    /// performs the POSITIONAL shift only: cell storage, format overlay,
    /// `formula_cells` KEYS, named-range targets + table footprints all move.
    ///
    /// The formula-TEXT rewrite (so `=A5` becomes `=A6`) rides as separate
    /// `Op::PutFormula` ops emitted by the producer in the SAME `BatchCommit`
    /// as this op (the `RenameSheet` model). Replay applies this op first
    /// (shifting the formula cell's KEY) then the `PutFormula` (writing the
    /// rewritten TEXT at the new key); the two are complementary.
    ///
    /// Tombstoned sheet → silent no-op (mirrors `PutValue`). A table-footprint
    /// split or off-grid overflow surfaces as `ReplayError::StructuralEdit`.
    ///
    /// **Wire format compatibility**: additive new variant on the serde-tagged
    /// enum; `OPLOG_SCHEMA_VERSION` NOT bumped (consistent with every prior
    /// variant addition). Forward-compat caveat per the `RemoveSheet` docstring.
    InsertRows {
        sheet: SheetId,
        at: RowId,
        count: u32,
    },

    /// **W3 (insert/delete rows & columns):** delete the INCLUSIVE row block
    /// `[start, end]` on `sheet`. Rows below `end` shift up; refs into the
    /// deleted block become `#REF!` (via the accompanying `PutFormula` text
    /// rewrites). Replays to `Workbook::delete_rows`. See `InsertRows`.
    DeleteRows {
        sheet: SheetId,
        start: RowId,
        end: RowId,
    },

    /// **W3 (insert/delete rows & columns):** insert `count` blank columns at
    /// column index `at` on `sheet`. Replays to `Workbook::insert_columns`.
    /// See `InsertRows`.
    InsertColumns {
        sheet: SheetId,
        at: ColId,
        count: u32,
    },

    /// **W3 (insert/delete rows & columns):** delete the INCLUSIVE column
    /// block `[start, end]` on `sheet`. Replays to `Workbook::delete_columns`.
    /// See `InsertRows` / `DeleteRows`.
    DeleteColumns {
        sheet: SheetId,
        start: ColId,
        end: ColId,
    },

    /// One transaction's ops applied atomically at replay time. Produced
    /// by `WorkbookTransaction::commit` in 2A.3.b. Replay applies each
    /// inner op in order; on failure, replay reports the inner op's
    /// index relative to the BatchCommit's parent index.
    ///
    /// **MED-1 (megaudit, Codex) closure — rollback-atomic.** Replay applies
    /// the whole batch to a CLONE of the workbook and swaps it in only if
    /// EVERY inner op succeeds; a mid-batch failure returns the error with the
    /// workbook unchanged (no half-applied structural edit / no torn cell
    /// state). The clone is shallow over Arrow chunk Arcs and all id / counter
    /// state lives inside the workbook, so the swap is deterministic. (Replay
    /// as a whole remains non-transactional ACROSS top-level ops — only each
    /// BatchCommit is atomic over its own clone.) The previous "no implicit
    /// rollback at replay" contract is retired.
    ///
    /// Nested BatchCommits are permitted by the schema but produced
    /// nowhere in production; replay handles them via recursion (each nested
    /// commit is itself atomic over its own clone).
    BatchCommit { ops: Vec<Op> },

    /// **W5-118 (Phase 4.8.H):** create a workbook-scoped table.
    /// Mirrors `WorkbookRuntime::create_table`. Replay inserts the
    /// table into `Workbook::tables_mut()` after validating the same
    /// invariants as the producer-side (non-overlapping footprint,
    /// non-empty unique column names, table-name uniqueness against
    /// both `TableTable` and `NameTable`).
    ///
    /// Column ids are NOT serialized — replay allocates fresh ids from
    /// the workbook's `next_column_id` counter, matching producer-side
    /// allocation order (deterministic if the op log is replayed in
    /// order).
    CreateTable {
        name: String,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    },

    /// **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
    /// the table footprint are untouched. Formulas referencing the
    /// dropped table re-bind to `BindError::UnknownTable` on next
    /// recompute. Mirrors `WorkbookRuntime::drop_table`.
    DropTable { name: String },

    /// **W5-119 (Phase 4.8.I):** rename a table.
    ///
    /// Producer side ALSO rewrites stored formula text (Excel canon —
    /// per design § 12.2). The op carries `old_name` so replay can
    /// re-key the `TableTable` entry; producer-side formula-text
    /// rewrites land as accompanying `Op::PutFormula` entries. **As of the
    /// F10 fix (2026-05-27), `WorkbookSession`/`WorkbookRuntime::rename_table`
    /// wraps `[RenameTable, PutFormula × N]` in a single `Op::BatchCommit`**
    /// (append-before-mutate atomicity, mirroring `rename_sheet`); replay
    /// applies the inner ops in order (re-key, then rewrite text — complementary,
    /// since `apply_rename_table` only re-keys metadata).
    ///
    /// Replay validates: target name available (NameTable + TableTable),
    /// source name exists. Sheet-scoped names use the workbook's
    /// shared canonical namespace.
    RenameTable { old_name: String, new_name: String },

    /// **W5-121 (Phase 4.8.I.2):** rename a single column within a table.
    ///
    /// Producer side ALSO rewrites stored formula text in every cell
    /// referencing the renamed column (Excel canon — same semantic as
    /// `RenameTable`). The op carries `table` (canonical uppercase) so
    /// replay can locate the table; `old_name` and `new_name` are case-
    /// preserving identifiers (replay matches `old_name` case-
    /// insensitively against `TableColumn::name`, which is stored
    /// lowercase-canonical). Producer-side formula-text rewrites land as
    /// accompanying `Op::PutFormula` entries in the same op-log sequence.
    ///
    /// Replay validates: target table exists, source column exists,
    /// target column name available within the table (case-insensitive).
    /// Same-canonical rename is rejected at producer side (returns
    /// `Ok(0)` no-op without emitting); replay treats receipt of a
    /// same-canonical op as a divergence and rejects.
    RenameColumn {
        table: String,
        old_name: String,
        new_name: String,
    },

    /// **W5-122 (Phase 4.8.J):** resize a table's footprint.
    ///
    /// Three scenarios (per design § 12.3):
    /// - Grow/shrink rows: change `new_rows`; `added_columns` and
    ///   `removed_columns` both empty.
    /// - Append column(s) at the END: list each in `added_columns`.
    /// - Truncate trailing column(s): list each in `removed_columns`
    ///   in current left-to-right order.
    ///
    /// Inserting / removing a column in the MIDDLE is NOT supported in
    /// 4.8 (Phase 5 structural edits — requires physical cell move).
    ///
    /// **Arithmetic invariant**: `new_cols == old_cols +
    /// added_columns.len() - removed_columns.len()`. Producer + replay
    /// both validate.
    ///
    /// **Column ids are NOT serialized** (same pattern as `CreateTable`)
    /// — replay allocates fresh ids from the workbook's
    /// `next_column_id` counter for each entry in `added_columns`,
    /// matching producer-side allocation order.
    ///
    /// Replay validates: target table exists; arithmetic matches;
    /// `removed_columns` exactly match trailing columns case-
    /// insensitively; final column roster has unique canonical names;
    /// new footprint cells outside the old footprint don't overlap
    /// other tables.
    ResizeTable {
        name: String,
        new_rows: u32,
        new_cols: u32,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    },

    /// **W5-146 (Phase 4.9.J):** workbook-scope reference-mode change.
    /// Serialized as a string `"A1"` or `"R1C1"`. The runtime appends
    /// this op via `WorkbookRuntime::set_reference_mode`; replay calls
    /// `Workbook::set_reference_mode(mode)` (a pure metadata update —
    /// no cell mutations, no formula re-bind).
    ///
    /// Unknown wire values (forward-compat) → `ReplayError::UnknownReferenceMode`
    /// per design § 4.9.J. The serde representation rejects unknowns at
    /// deserialize time via the standard enum-of-unit-variants path.
    SetReferenceMode { mode: ReferenceModeWire },

    /// **W5-146 (Phase 4.9.J):** workbook-scope locale change.
    /// Serialized as a short string `"en"` / `"de"` / `"fr"`. Mirrors
    /// the qbook envelope's `LocaleWire` (W5-145 / qbook v7). Unknown
    /// wire values surface `ReplayError::UnknownLocale` per design
    /// § 4.9.J + Sonnet L-10 closure.
    SetLocale { locale: LocaleWire },

    /// **Phase 5.7 V3.6.0.X audit-of-D4 CONVERGENT-HIGH-1 closure
    /// (2026-05-24):** workbook-scope date-system change.  Serialized
    /// as a short string `"Excel1900"` / `"Excel1904"`.  Mirrors the
    /// qbook envelope's `date_system` field.
    ///
    /// **Why it exists**: V3.6.0.5 D4 surfaces `workbook.date_system()`
    /// via napi `WorkbookSnapshotJson.dateSystem` for format-aware
    /// date rendering.  But pre-closure, op-log replay never touched
    /// `Workbook::date_system` -- replay always produced
    /// `DateSystem::Excel1900` (the `Workbook::default()` value),
    /// regardless of the loaded `.qbook` envelope.  Excel1904
    /// workbooks rendered date-formatted cells off by 1462 days.
    /// Codex Lane A HIGH-1 + Opus Lane B HIGH-1 both empirically
    /// demonstrated.
    ///
    /// **Closure**: `from_qbook` now emits `Op::SetDateSystem` as the
    /// first op (prefix) when the loaded workbook's date_system
    /// differs from `Workbook::default()`'s.  Replay calls
    /// `workbook.set_date_system(_)`.  napi
    /// `WorkbookSnapshotJson.dateSystem` then surfaces the correct
    /// value.
    ///
    /// Unknown wire values surface `ReplayError::UnknownDateSystem`
    /// per the LocaleWire / ReferenceModeWire pattern.
    SetDateSystem { date_system: DateSystemWire },
}

/// **W5-146 (Phase 4.9.J):** op-log wire form of `ReferenceMode`.
/// Kept separate from `ql-formula-syntax::ReferenceMode` so the
/// wire shape is stable across engine versions (the runtime enum
/// could be renamed without breaking on-disk op-log files).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReferenceModeWire {
    A1,
    R1C1,
    /// **W5-151 (Phase 4.9.O MEDIUM-2 closure):** unknown wire value
    /// from a forward-compat op-log file (e.g. a future engine
    /// emits `Op::SetReferenceMode { mode: "Mixed" }`). The custom
    /// `Deserialize` captures the original string; replay surfaces
    /// `ReplayError::UnknownReferenceMode { index, found }` per
    /// design § 4.9.J. Save-side `from_runtime` never produces this.
    /// Mirrors the `LocaleWire::Unknown` pattern (W5-146).
    Unknown(String),
}

impl ReferenceModeWire {
    pub fn from_runtime(mode: ql_types::ReferenceMode) -> Self {
        match mode {
            ql_types::ReferenceMode::A1 => Self::A1,
            ql_types::ReferenceMode::R1C1 => Self::R1C1,
        }
    }

    /// Convert to runtime `ReferenceMode`. Returns `Err(unknown_value)`
    /// if the wire was `Unknown(_)`; the replay path maps that to
    /// `ReplayError::UnknownReferenceMode`.
    pub fn to_runtime(self) -> Result<ql_types::ReferenceMode, String> {
        match self {
            Self::A1 => Ok(ql_types::ReferenceMode::A1),
            Self::R1C1 => Ok(ql_types::ReferenceMode::R1C1),
            Self::Unknown(s) => Err(s),
        }
    }
}

impl serde::Serialize for ReferenceModeWire {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = match self {
            Self::A1 => "A1",
            Self::R1C1 => "R1C1",
            // Save-side never produces Unknown from runtime; the
            // defensive emit preserves whatever string came in.
            Self::Unknown(s) => s.as_str(),
        };
        ser.serialize_str(s)
    }
}

impl<'de> serde::Deserialize<'de> for ReferenceModeWire {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        Ok(match s.as_str() {
            "A1" => Self::A1,
            "R1C1" => Self::R1C1,
            _ => Self::Unknown(s),
        })
    }
}

/// **W5-146 (Phase 4.9.J):** op-log wire form of `Locale`. Unknown
/// strings deserialize to `LocaleWire::Unknown(String)` so the replay
/// path can surface `ReplayError::UnknownLocale` with the captured
/// value (closes Sonnet L-10).
///
/// Save-side `from_runtime` only emits canonical variants; the
/// `Unknown` form is read-side only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocaleWire {
    En,
    De,
    Fr,
    Unknown(String),
}

impl LocaleWire {
    pub fn from_runtime(locale: ql_types::Locale) -> Self {
        match locale {
            ql_types::Locale::EnUs => Self::En,
            ql_types::Locale::De => Self::De,
            ql_types::Locale::Fr => Self::Fr,
        }
    }

    pub fn to_runtime(self) -> Result<ql_types::Locale, String> {
        match self {
            Self::En => Ok(ql_types::Locale::EnUs),
            Self::De => Ok(ql_types::Locale::De),
            Self::Fr => Ok(ql_types::Locale::Fr),
            Self::Unknown(s) => Err(s),
        }
    }
}

impl serde::Serialize for LocaleWire {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = match self {
            Self::En => "en",
            Self::De => "de",
            Self::Fr => "fr",
            Self::Unknown(s) => s.as_str(),
        };
        ser.serialize_str(s)
    }
}

impl<'de> serde::Deserialize<'de> for LocaleWire {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        Ok(match s.as_str() {
            "en" => Self::En,
            "de" => Self::De,
            "fr" => Self::Fr,
            _ => Self::Unknown(s),
        })
    }
}

/// **Phase 5.7 V3.6.0.X audit-of-D4 CONVERGENT-HIGH-1 closure
/// (2026-05-24):** op-log wire form of `ql_types::DateSystem`.
/// Unknown strings deserialize to `DateSystemWire::Unknown(String)`
/// so the replay path can surface `ReplayError::UnknownDateSystem`
/// with the captured value (mirrors LocaleWire / ReferenceModeWire
/// pattern).
///
/// Save-side `from_runtime` only emits canonical variants; the
/// `Unknown` form is read-side only.
///
/// **Rule 4 per-field walk** (per V2 V4 V1 step 3 audit-discipline
/// + V3.6.0.X audit-of-D4 doc-audit MED-5 closure): variants are
/// `Excel1900` + `Excel1904` (unit variants; trivially Send + Sync)
/// + `Unknown(String)` (composition over `String`, which is
/// `Send + Sync` per stdlib).  All three variants positive
/// Send + Sync.  Arc terminus stays at 6; 0 new triggers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DateSystemWire {
    Excel1900,
    Excel1904,
    Unknown(String),
}

impl DateSystemWire {
    pub fn from_runtime(date_system: ql_types::DateSystem) -> Self {
        match date_system {
            ql_types::DateSystem::Excel1900 => Self::Excel1900,
            ql_types::DateSystem::Excel1904 => Self::Excel1904,
        }
    }

    pub fn to_runtime(self) -> Result<ql_types::DateSystem, String> {
        match self {
            Self::Excel1900 => Ok(ql_types::DateSystem::Excel1900),
            Self::Excel1904 => Ok(ql_types::DateSystem::Excel1904),
            Self::Unknown(s) => Err(s),
        }
    }
}

impl serde::Serialize for DateSystemWire {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let s = match self {
            Self::Excel1900 => "Excel1900",
            Self::Excel1904 => "Excel1904",
            Self::Unknown(s) => s.as_str(),
        };
        ser.serialize_str(s)
    }
}

impl<'de> serde::Deserialize<'de> for DateSystemWire {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        Ok(match s.as_str() {
            "Excel1900" => Self::Excel1900,
            "Excel1904" => Self::Excel1904,
            _ => Self::Unknown(s),
        })
    }
}
