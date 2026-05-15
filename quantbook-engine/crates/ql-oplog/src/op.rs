//! The `Op` enum — the engine's mutation vocabulary for the op log.
//!
//! Phase 2A.3.a (2026-05-12): minimum producer set covering everything
//! `WorkbookRuntime` and `WorkbookTransaction` can mutate through their
//! public API. Future variants (sheet renames, sheet deletes, formatting
//! changes) land alongside the API additions that produce them.
//!
//! Each variant mirrors a `Workbook` mutation method one-to-one:
//!
//! | `Op` variant       | Replays to                                       |
//! |--------------------|--------------------------------------------------|
//! | `PutValue`         | `Workbook::put_at`                               |
//! | `PutFormula`       | `Workbook::put_formula`                          |
//! | `ClearFormula`     | `Workbook::clear_formula`                        |
//! | `SetName`          | `Workbook::set_name`                             |
//! | `AddSheet`         | `Workbook::add_sheet_with_chunk_rows`            |
//! | `RegisterFormat`   | `FormatTable::register_at` (W5-80)               |
//! | `SetCellFormat`    | `CellFormatOverlay::set` / `::clear` (W5-80)     |
//! | `BatchCommit`      | (recursive — applies each inner op in order)     |
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

use ql_io::{CellWireValue, NamedTargetWire};
use ql_types::{ColId, RowId, SheetId};

/// A mutation operation recordable in the op log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
pub enum Op {
    /// Single literal cell write. Mirrors `WorkbookRuntime::set_value`.
    PutValue {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: CellWireValue,
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
    /// `Workbook::rename_sheet`. Carries `old_name` for replay-time
    /// validation (snapshot-vs-replay reconciliation: if the snapshot
    /// already has the new name, replay no-ops gracefully when current
    /// canonical matches the new name). Per design doc § 3.1, the
    /// producer-side runtime rewrites all stored formula text BEFORE
    /// emitting this op (and emits `Op::PutFormula` ops for each
    /// rewritten cell in the same BatchCommit), so replay-on-top-of-
    /// snapshot OR replay-from-empty both produce correct state.
    RenameSheet {
        id: SheetId,
        old_name: String,
        new_name: String,
    },

    /// Register a format string at a specific id. Mirrors
    /// `FormatTable::register_at`. Emitted when
    /// `WorkbookRuntime::intern_format` allocates a NEW id; idempotent
    /// on replay (re-registering an existing id with the same string
    /// is a no-op). Re-registering at the same id with a DIFFERENT
    /// string fails at `FormatTable::register_at` and surfaces as
    /// `ReplayError::FormatRejected`. Shipped W5-80 (Phase 4.5.D part 4).
    RegisterFormat { id: u32, string: String },

    /// Set or clear a cell's format id. Mirrors
    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
    /// (when `id` is `None`). The id MUST resolve in the workbook's
    /// `FormatTable` at replay time; an unknown id surfaces as
    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
    SetCellFormat {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        /// `None` ⇒ clear the overlay entry (cell falls back to General).
        /// `Some(id)` ⇒ bind the cell to that format id.
        id: Option<u32>,
    },

    /// One transaction's ops applied atomically at replay time. Produced
    /// by `WorkbookTransaction::commit` in 2A.3.b. Replay applies each
    /// inner op in order; on failure, replay reports the inner op's
    /// index relative to the BatchCommit's parent index. No implicit
    /// rollback at replay (commits are committed).
    ///
    /// Nested BatchCommits are permitted by the schema but produced
    /// nowhere in production; replay handles them via recursion.
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
    /// rewrites land as accompanying `Op::PutFormula` entries in the
    /// same op-log sequence (no `BatchCommit` wrapper today; relies on
    /// replay-order determinism).
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
}

/// **W5-146 (Phase 4.9.J):** op-log wire form of `ReferenceMode`.
/// Kept separate from `ql-formula-syntax::ReferenceMode` so the
/// wire shape is stable across engine versions (the runtime enum
/// could be renamed without breaking on-disk op-log files).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ReferenceModeWire {
    A1,
    R1C1,
}

impl ReferenceModeWire {
    pub fn from_runtime(mode: ql_types::ReferenceMode) -> Self {
        match mode {
            ql_types::ReferenceMode::A1 => Self::A1,
            ql_types::ReferenceMode::R1C1 => Self::R1C1,
        }
    }

    pub fn to_runtime(self) -> ql_types::ReferenceMode {
        match self {
            Self::A1 => ql_types::ReferenceMode::A1,
            Self::R1C1 => ql_types::ReferenceMode::R1C1,
        }
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
