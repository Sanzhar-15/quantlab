//! Replay an `OpLog` against a `Workbook`.
//!
//! Phase 2A.3.a (2026-05-12): single entry point `replay_into(&OpLog, &mut
//! Workbook, &FunctionRegistry) -> Result<usize, ReplayError>`. Returns the
//! count of ops successfully applied; on failure, returns
//! `ReplayError::At { index, kind }` carrying the position of the failing
//! op and the underlying failure. The workbook is left in a partial state
//! on failure (callers decide whether to discard, recover, or recompute).
//!
//! ## Replay semantics
//!
//! Each `Op` variant maps to one `Workbook` mutation:
//!
//! - `PutValue` → `Workbook::put_at` (after row/col bounds check).
//! - `PutFormula` → `Workbook::put_formula` (text only; replay does NOT
//!   re-evaluate — that's a separate step the caller drives via
//!   `WorkbookRuntime::recompute_all`).
//! - `ClearFormula` → `Workbook::clear_formula`.
//! - `SetName` → `Workbook::set_name`. Reserved names (e.g. `AI`) surface
//!   as `ReplayError::NameRejected`.
//! - `AddSheet` → `Workbook::add_sheet_with_chunk_rows`.
//! - `BatchCommit` → recurse on each inner op. Index reporting flattens:
//!   a failure inside a BatchCommit reports the inner op's overall
//!   position (current outer index + offset).
//!
//! ## Idempotence
//!
//! `replay_into` is idempotent only in the trivial sense: replaying twice
//! against the same starting workbook produces the same final state IFF
//! the underlying mutation methods are themselves idempotent (and they
//! are — `put_at` / `put_formula` / `clear_formula` / `set_name` /
//! `add_sheet` all are). Callers wanting at-most-once semantics across
//! sessions track replay state themselves (Phase 5+ work).
//!
//! ## `registry` parameter
//!
//! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
//! 2A.3.a's replay doesn't use it (formula evaluation is deferred to a
//! separate `recompute_all` call), but keeping the parameter stable here
//! avoids a breaking signature change in 2A.3.b/c when the eval path
//! could land inside replay.

use ql_functions::FunctionRegistry;
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use thiserror::Error;

use crate::log::OpLog;
use crate::op::Op;

/// Errors emitted by `replay_into`.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ReplayError {
    /// An op-log entry failed to deserialize (corrupted log data).
    #[error("replay deserialize error at op index {0}: {1}")]
    Deserialize(usize, #[source] crate::error::OpLogError),

    /// The op referenced an out-of-range sheet id.
    #[error(
        "replay invalid sheet at op index {index}: sheet {sheet} (workbook has {sheet_count})"
    )]
    InvalidSheet {
        index: usize,
        sheet: SheetId,
        sheet_count: usize,
    },

    /// The op carried out-of-range row/col coordinates.
    #[error("replay invalid cell at op index {index}: row={row} col={col} ({why})")]
    InvalidCell {
        index: usize,
        row: RowId,
        col: ColId,
        why: &'static str,
    },

    /// Decoding the on-wire `CellWireValue` failed (e.g., unknown error sigil).
    ///
    /// **Tier D2 (2026-05-19):** source type changed from
    /// `ql_io::QbookError` to `crate::wire::WireDecodeError` so replay
    /// doesn't depend on `ql-io`. The on-wire variant set is identical;
    /// only the wrapping error type changed.
    #[error("replay value-decode error at op index {index}: {source}")]
    ValueDecode {
        index: usize,
        #[source]
        source: crate::wire::WireDecodeError,
    },

    /// Decoding the on-wire `NamedTargetWire` failed.
    ///
    /// **Tier D2 (2026-05-19):** source type changed from
    /// `ql_io::QbookError` to `crate::wire::WireDecodeError`.
    #[error("replay named-target decode error at op index {index}: {source}")]
    NamedTargetDecode {
        index: usize,
        #[source]
        source: crate::wire::WireDecodeError,
    },

    /// `Workbook::set_name` refused the name (reserved per CORR-06).
    #[error("replay name rejected at op index {index}: {name:?} ({source})")]
    NameRejected {
        index: usize,
        name: String,
        #[source]
        source: ql_storage::NameTableError,
    },

    /// `FormatTable::register_at` refused the registration — the id is
    /// already taken with a different string, or the string is already
    /// at a different id. **W5-80 (Phase 4.5.D part 4).**
    #[error("replay format rejected at op index {index}: {source:?}")]
    FormatRejected {
        index: usize,
        #[source]
        source: FormatRejectedSource,
    },

    /// `Op::SetCellFormat` referenced a format id that hasn't been
    /// registered yet. The producer SHOULD always emit `RegisterFormat`
    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
    /// **W5-80.**
    ///
    /// **Phase 5.2 D-1 step 4:** `id` changed from `u32` to
    /// `ql_storage::FormatId` (the converted-from-wire shape).
    #[error("replay set-cell-format references unregistered format id {id:?} at op index {index}")]
    FormatNotRegistered {
        index: usize,
        id: ql_storage::FormatId,
    },

    /// **FE-4 W4 (2026-06-10):** `StyleTable::register_at` refused a replayed
    /// `Op::RegisterStyle` — the id is already taken with a different style, or
    /// the style is already at a different id, or the counter would overflow.
    /// Mirrors [`Self::FormatRejected`].
    #[error("replay style rejected at op index {index}: {source:?}")]
    StyleRejected {
        index: usize,
        #[source]
        source: StyleRejectedSource,
    },

    /// **FE-4 W4 (2026-06-10):** `Op::SetCellStyle` referenced a style id that
    /// hasn't been registered yet. The producer SHOULD always emit
    /// `RegisterStyle` BEFORE `SetCellStyle`; replay enforces that. Mirrors
    /// [`Self::FormatNotRegistered`].
    #[error("replay set-cell-style references unregistered style id {id:?} at op index {index}")]
    StyleNotRegistered {
        index: usize,
        id: ql_storage::StyleId,
    },

    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
    /// whose current name matches neither `old_name` nor `new_name`
    /// (i.e. the replay state has diverged from what the op recorded).
    ///
    /// **Phase 5.3 step 2 (2026-05-20) — VARIANT NO LONGER EMITTED.**
    /// Under CRDT merge of concurrent renames, current name may
    /// legitimately match neither. The replay handler now applies
    /// the rename to the current sheet (last-in-causal-order wins
    /// policy). Variant kept for ABI compat — external callers that
    /// match against it will simply never see it. Marked
    /// `#[deprecated]` for IDE discoverability (Codex step-2 audit
    /// LOW closure). May be removed in a future major version.
    #[deprecated(
        since = "0.1.0",
        note = "Phase 5.3 step 2: no longer emitted. Concurrent renames now apply via last-in-causal-order wins policy. See replay.rs RenameSheet handler."
    )]
    #[error(
        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
         expected current name {expected:?}, found {found:?}"
    )]
    SheetRenameNameMismatch {
        index: usize,
        id: SheetId,
        expected: String,
        found: String,
    },

    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
    /// new name (duplicate, reserved character, empty).
    #[error(
        "replay rename-sheet rejected at op index {index}: sheet {id} \
         from {old_name:?} to {new_name:?} ({source})"
    )]
    SheetRenameRejected {
        index: usize,
        id: SheetId,
        old_name: String,
        new_name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
    /// under canonical comparison, or an Excel-reserved character.
    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
    /// accepted any name, so an op log produced against a buggy
    /// storage path could let conflicting sheets enter replay state.
    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
    SheetNameRejected {
        index: usize,
        name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
    /// the producer should have validated. Catches snapshot-vs-replay
    /// divergence (e.g. snapshot already has the table; another producer
    /// raced).
    #[error("replay create-table rejected at op index {index}: {reason}")]
    TableCreateRejected {
        index: usize,
        name: String,
        reason: &'static str,
    },

    /// **W5-118 (Phase 4.8.H) + Phase 5.3 step 5 megaudit closure (2026-05-20):**
    /// originally fired when `DropTable` referenced a missing table. The
    /// step 5 megaudit (Codex HIGH + Opus-A V1 LIM #4) flagged this as
    /// producing an order-dependent CRDT-merge failure (drop-then-rename
    /// works; rename-then-drop hard-failed). The `DropTable` handler now
    /// advisory-skips on missing source. This variant still fires from
    /// `apply_rename_table` when the source table doesn't exist AND a
    /// new-name table doesn't exist either (i.e., not an idempotent
    /// concurrent-rename case — see `replay.rs:802-820`).
    #[error("replay drop-table at op index {index}: table {name:?} not found")]
    TableNotFound { index: usize, name: String },

    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op references a column
    /// that doesn't exist in the target table (case-insensitive). Either
    /// the source column was already dropped/renamed before this op, or
    /// the op log has diverged from the snapshot.
    #[error(
        "replay rename-column at op index {index}: table {table:?} \
         has no column {column:?}"
    )]
    TableColumnNotFound {
        index: usize,
        table: String,
        column: String,
    },

    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op was rejected by a
    /// validation rule (target name already in the table, empty, etc.).
    /// `reason` is a static string describing which invariant fired.
    #[error("replay rename-column rejected at op index {index}: table {table:?} column {column:?} ({reason})")]
    TableColumnRejected {
        index: usize,
        table: String,
        column: String,
        reason: &'static str,
    },

    /// **W5-122 (Phase 4.8.J):** `ResizeTable` op was rejected by a
    /// validation rule (arithmetic mismatch, trailing-columns
    /// mismatch, column-name collision, footprint overlap, etc.).
    /// `reason` is a static string describing which invariant fired.
    #[error("replay resize-table rejected at op index {index}: table {name:?} ({reason})")]
    TableResizeRejected {
        index: usize,
        name: String,
        reason: &'static str,
    },

    /// **W5-146 (Phase 4.9.J):** `Op::SetLocale` wire value didn't
    /// match any known locale code. Mirrors qbook v7's
    /// `QbookError::UnknownLocale` (W5-145) — a forward-compat
    /// op-log file with an unrecognized locale string surfaces this
    /// instead of silently substituting EnUs (closes Sonnet L-10).
    /// Captures the offending string for the IDE diagnostic.
    #[error("replay unknown locale at op index {index}: {found:?}")]
    UnknownLocale { index: usize, found: String },

    /// **W5-151 (Phase 4.9.O MEDIUM-2 closure):** `Op::SetReferenceMode`
    /// wire value didn't match `A1` or `R1C1`. Per design § 4.9.J,
    /// the forward-compat path captures unknown strings into
    /// `ReferenceModeWire::Unknown(_)` and replay surfaces this
    /// distinct error rather than letting the op silently no-op.
    /// Parallels `UnknownLocale` above.
    #[error("replay unknown reference mode at op index {index}: {found:?}")]
    UnknownReferenceMode { index: usize, found: String },

    /// **Phase 5.7 V3.6.0.X audit-of-D4 CONVERGENT-HIGH-1 closure
    /// (2026-05-24):** `Op::SetDateSystem` wire value didn't match
    /// `Excel1900` or `Excel1904`.  Forward-compat path captures
    /// unknown strings into `DateSystemWire::Unknown(_)` and replay
    /// surfaces this distinct error.  Parallels `UnknownLocale` +
    /// `UnknownReferenceMode`.
    #[error("replay unknown date system at op index {index}: {found:?}")]
    UnknownDateSystem { index: usize, found: String },

    /// **W3 (insert/delete rows & columns):** a structural row/column
    /// `Op::Insert/Delete{Rows,Columns}` was rejected by storage — an
    /// invalid sheet/range, or an edit that would split a table footprint
    /// or push it off the grid. The producer validates these at the napi
    /// boundary, so a replay failure here indicates op-log corruption or a
    /// producer that bypassed validation.
    #[error("replay structural edit rejected at op index {index}: {source}")]
    StructuralEdit {
        index: usize,
        #[source]
        source: ql_storage::StructuralEditError,
    },

    /// **Wave Q1 (2026-06-23):** an `Op::AddChart`/`UpdateChart` carried a
    /// `chart_type` token that isn't `"line"`/`"bar"`/`"scatter"`
    /// (`ql_storage::ChartKind::from_wire_str` returned `None`). Surfaced
    /// rather than silently defaulting. Parallels `UnknownReferenceMode`.
    #[error("replay unknown chart kind at op index {index}: {found:?}")]
    UnknownChartKind { index: usize, found: String },

    /// **Wave Q1 (2026-06-23):** an `Op::UpdateChart` referenced a chart id
    /// that isn't present. In a valid op log an `UpdateChart` always follows
    /// the matching `AddChart`, so this indicates op-log corruption or a
    /// producer that bypassed validation. (`RemoveChart` of a missing id is
    /// an idempotent no-op, not this error — mirroring `DropTable`.)
    #[error("replay update-chart references unknown chart id {id} at op index {index}")]
    ChartNotFound { index: usize, id: u32 },

    /// **Tier C2 (Phase 4 v2 backlog, 2026-06-24):** an `Op::BatchCommit`
    /// tree nested deeper than [`MAX_REPLAY_BATCH_DEPTH`]. `apply_op` recurses
    /// once per `BatchCommit` level, so a hostile or corrupt `.qbook` with a
    /// deeply-nested batch (`BatchCommit{[BatchCommit{[ … ]}]}`) would
    /// otherwise overflow the replay thread's stack. Before this guard the
    /// ONLY thing bounding the recursion was `serde_json`'s default 128-level
    /// deserialize limit — which does not protect programmatically-built logs
    /// or a future deserializer with a higher cap. `depth` is the level at
    /// which the limit tripped. Legitimate producer batches nest one level.
    #[error(
        "replay batch nesting too deep at op index {index}: reached depth {depth} \
         (max {max})"
    )]
    BatchDepthExceeded { index: usize, depth: u32, max: u32 },
}

/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
/// so `ReplayError` can stay `Clone + std::error::Error` without
/// borrowing into the table.
///
/// Phase 5.2 D-1 step 3: `id` / `existing_id` / `attempted_id` are now
/// `ql_storage::FormatId` (tagged tuple) rather than the pre-step-3
/// `u32`. Display formatting uses the FormatId's `Debug` impl so error
/// messages identify both built-in and peer-allocated custom variants.
#[derive(Clone, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum FormatRejectedSource {
    #[error("format id {id:?} already bound to {existing:?}, can't re-bind to {attempted:?}")]
    IdCollision {
        id: ql_storage::FormatId,
        existing: String,
        attempted: String,
    },
    #[error(
        "format string {string:?} already at id {existing_id:?}, can't bind to id {attempted_id:?}"
    )]
    StringCollision {
        string: String,
        existing_id: ql_storage::FormatId,
        attempted_id: ql_storage::FormatId,
    },
    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
    /// replayed `Op::RegisterFormat` with a `Custom(local_peer, u32::MAX)`
    /// id would have panicked at `FormatTable::register_at`'s counter
    /// advancement before this guard landed; now surfaces as a recoverable
    /// replay error.
    #[error("format counter overflow for peer {peer:?} (counter == u32::MAX)")]
    CounterOverflow { peer: ql_types::PeerId },
    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
    /// replayed `Op::RegisterFormat` with `Builtin(n > 163)`. Built-in
    /// format ids are contractually `0..=FIRST_XLSX_BUILTIN_MAX`;
    /// `FormatIdWire::Builtin { id: u32 }` carries no range bound at the
    /// type level so a malformed op can smuggle the bad shape past serde
    /// validation. Surfaces here as a replay error rather than letting
    /// the storage table silently accept and later drop the entry.
    #[error(
        "builtin format id {id} out of range (max {FIRST_XLSX_BUILTIN_MAX})",
        FIRST_XLSX_BUILTIN_MAX = 163
    )]
    BuiltinOutOfRange { id: u32 },
}

impl From<ql_storage::FormatTableError> for FormatRejectedSource {
    fn from(e: ql_storage::FormatTableError) -> Self {
        match e {
            ql_storage::FormatTableError::IdCollision {
                id,
                existing,
                attempted,
            } => FormatRejectedSource::IdCollision {
                id,
                existing,
                attempted,
            },
            ql_storage::FormatTableError::StringCollision {
                string,
                existing_id,
                attempted_id,
            } => FormatRejectedSource::StringCollision {
                string,
                existing_id,
                attempted_id,
            },
            ql_storage::FormatTableError::CounterOverflow { peer } => {
                FormatRejectedSource::CounterOverflow { peer }
            }
            ql_storage::FormatTableError::BuiltinOutOfRange { id } => {
                FormatRejectedSource::BuiltinOutOfRange { id }
            }
            _ => unreachable!(
                "FormatTableError gained a variant — extend FormatRejectedSource::From"
            ),
        }
    }
}

/// **FE-4 W4 (2026-06-10):** wrapper around `ql_storage::StyleTableError` that
/// owns its data so `ReplayError` stays `Clone + std::error::Error` without
/// borrowing into the table. Mirrors [`FormatRejectedSource`].
#[derive(Clone, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StyleRejectedSource {
    #[error("style id {id:?} already bound to a different style, can't re-bind")]
    IdCollision { id: ql_storage::StyleId },
    #[error("style already at id {existing_id:?}, can't bind to id {attempted_id:?}")]
    StyleCollision {
        existing_id: ql_storage::StyleId,
        attempted_id: ql_storage::StyleId,
    },
    #[error("style counter overflow for peer {peer:?} (counter == u32::MAX)")]
    CounterOverflow { peer: ql_types::PeerId },
}

impl From<ql_storage::StyleTableError> for StyleRejectedSource {
    fn from(e: ql_storage::StyleTableError) -> Self {
        match e {
            ql_storage::StyleTableError::IdCollision { id, .. } => {
                StyleRejectedSource::IdCollision { id }
            }
            ql_storage::StyleTableError::StyleCollision {
                existing_id,
                attempted_id,
            } => StyleRejectedSource::StyleCollision {
                existing_id,
                attempted_id,
            },
            ql_storage::StyleTableError::CounterOverflow { peer } => {
                StyleRejectedSource::CounterOverflow { peer }
            }
            _ => {
                unreachable!("StyleTableError gained a variant — extend StyleRejectedSource::From")
            }
        }
    }
}

/// Replay every op in `log` against `workbook` in append order.
///
/// Returns the total count of ops applied on success. On failure, the
/// workbook is in a partial state — the per-op `ReplayError` variants
/// (e.g., `TableNotFound { index, .. }`, `SheetRenameRejected { index, .. }`)
/// carry the `index` field telling the caller how far replay got.
///
/// # Caller contract on `Err` (Phase 5.3 step 5 megaudit closure)
///
/// **`replay_into` is NOT transactional.** On `Err(_)`, the workbook
/// passed by `&mut` reference is in a HALF-MERGED state: ops 0..index
/// have been applied; the op at `index` errored; ops at `index+1..` were
/// not attempted. The mutation is NOT rolled back. The caller MUST
/// discard the workbook (e.g., re-construct from a clean state then
/// re-replay up to but not including the failing op) — reusing the
/// passed-by-mut-ref workbook after `Err` operates on the partial state
/// and produces incorrect downstream behavior.
///
/// This is the audit-locked V1 policy per Phase 5.3 step 5 megaudit
/// (Opus-A HIGH-1 / V1 LIM #1). The CRDT-merge use case requires
/// `replay_into` to be safe under concurrent ops; the V1 hard-fails
/// (e.g., cross-source `RenameTable` target collision) trigger this
/// partial-state path. Future V2 closure paths considered: workbook
/// snapshot/restore (memory cost), two-phase replay validate-then-apply
/// (compute cost), or replay-side soft-fail with synthesized correction
/// ops (architectural change). For V1, the documentation contract is
/// the only protection.
///
/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
/// and is unused in 2A.3.a (replay persists formula text without
/// re-evaluating; callers drive evaluation through `recompute_all`).
pub fn replay_into(
    log: &OpLog,
    workbook: &mut Workbook,
    _registry: &FunctionRegistry,
) -> Result<usize, ReplayError> {
    let mut count = 0;
    for (index, op_result) in log.iter().enumerate() {
        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
        apply_op(&op, workbook, index, 0)?;
        count += 1;
    }
    Ok(count)
}

/// **Phase 5.7 V3.6.0.8 D6 (2026-05-25)** -- apply a half-open range
/// of ops `[from_index, to_index)` from `log` onto a pre-existing
/// `workbook`.
///
/// Contract differs from [`replay_into`]: this helper accepts a
/// workbook that ALREADY reflects ops at indices `0..from_index` and
/// applies the slice `from_index..to_index` forward.  Used by
/// `ql_collab::CollabSession::workbook_snapshot_delta` (V3.6.0.8.3) to
/// apply ops appended since the cached `workbook_snapshot_workbook`
/// without paying full `replay_into` cost.  Each op is applied via the
/// shared private `apply_op` helper so wire semantics match
/// `replay_into` exactly.
///
/// Skipping the rename-repair walks (`repair_sheet_rename_chain` /
/// `repair_table_rename_chain` / `repair_column_rename_chain`) is the
/// CALLER's responsibility.  V3.6.0.8.3's cell-only fast-path
/// guarantees `from_index..to_index` contains NO
/// `Op::Rename{Sheet,Table,Column}` op (checked at the napi layer
/// before invoking this helper); rename ops trigger the full-rebuild
/// branch via `replay_into` + repair walks.
///
/// # Cost
///
/// O(to_index - from_index) ops applied.  Iteration uses `log.iter()`
/// internally (Loro's BTree iterator); skip-take incurs O(log N) per
/// seek but the slice length dominates for typical small deltas.
///
/// # Errors
///
/// - [`ReplayError::Deserialize`] if any op in the range fails to
///   decode from its wire bytes (same propagation as [`replay_into`]).
/// - Per-op apply errors (`InvalidCell`, `UnknownSheet`,
///   `FormatNotRegistered`, etc.) propagate with the op's absolute
///   index in `log` (matches `replay_into`'s index semantic; debugging
///   stays grep-able against op log dumps).
///
/// # Panics
///
/// Returns the number of ops applied (always `to_index - from_index`
/// on success).  Out-of-range `to_index` (i.e., `to_index > log.len()`)
/// silently stops at log end -- caller is responsible for bounding.
/// `from_index >= to_index` is a no-op returning `Ok(0)`.
///
/// **NOT TRANSACTIONAL** -- mirrors [`replay_into`]'s warning.  On
/// `Err(_)`, `workbook` is in a HALF-MERGED state; the partial
/// application is NOT rolled back.  V3.6.0.8.3 napi recovers by
/// clearing the cache + returning `fullRebuildRequired=true`.
pub fn apply_ops_in_range(
    log: &OpLog,
    workbook: &mut Workbook,
    from_index: usize,
    to_index: usize,
    _registry: &FunctionRegistry,
) -> Result<usize, ReplayError> {
    if from_index >= to_index {
        return Ok(0);
    }
    // **Phase 5.7 V3.6.0.8.4 OPUS-HIGH-3 closure (2026-05-25)**: walk
    // via [`OpLog::get`] random-access instead of `iter().skip(N)`.
    // Pre-closure: `iter().skip(N)` deserializes ALL N skipped ops via
    // std `Iterator::skip` (which calls `next()` N times + discards).
    // For a 100k-op log with a 10-op delta, skip(100000-10) cost ~100k
    // unnecessary `serde_json::from_str<Op>` calls -- enough to defeat
    // the V3.6.0.7 spike's D6 perf contract.  Post-closure: K *
    // O(log N) via Loro's BTree random-access (per V3.6.0.X audit-of-
    // D3 closure on `OpLog::get` complexity docstring).
    let mut count = 0;
    for index in from_index..to_index {
        let op_result = match log.get(index) {
            Some(r) => r,
            None => break,
        };
        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
        apply_op(&op, workbook, index, 0)?;
        count += 1;
    }
    Ok(count)
}

/// **Tier C2 (Phase 4 v2 backlog, 2026-06-24):** maximum `Op::BatchCommit`
/// nesting depth `apply_op` will descend before bailing with
/// [`ReplayError::BatchDepthExceeded`].
///
/// Legitimate producer batches nest exactly one level (a structural edit
/// plus its formula-rewrite ops), so 64 is a generous ceiling — and it
/// matches the engine's existing `MAX_LAMBDA_DEPTH = 64` precedent.
///
/// Ordering vs serde on the LOAD path (corrected per audit): each
/// `BatchCommit` is ~2 JSON nesting levels, so `serde_json`'s default
/// 128-level deserialize recursion limit already rejects a persisted batch
/// nested beyond ~64 levels during `OpLog::iter`/`get` — i.e. BEFORE
/// `apply_op` ever recurses. This guard therefore does NOT fire first on the
/// `.qbook` load path; it is DEFENSE-IN-DEPTH for callers that reach
/// `apply_op` WITHOUT a serde round-trip (programmatically-built logs, or a
/// future deserializer configured with a higher cap). See
/// [`ReplayError::BatchDepthExceeded`].
const MAX_REPLAY_BATCH_DEPTH: u32 = 64;

/// Recursive helper. `index` is the op's position in the outer log (or
/// the synthetic position of the enclosing BatchCommit for nested ops —
/// 2A.3.a flattens by reporting the parent's index for nested failures).
/// `depth` is the current `Op::BatchCommit` nesting level (0 at the top
/// level); only the `BatchCommit` arm increments it. Guarded against
/// unbounded recursion by [`MAX_REPLAY_BATCH_DEPTH`].
fn apply_op(op: &Op, workbook: &mut Workbook, index: usize, depth: u32) -> Result<(), ReplayError> {
    // Tier C2 DoS guard: a deeply-nested `BatchCommit` (hostile/corrupt log)
    // would otherwise overflow this thread's stack — one frame per level.
    if depth > MAX_REPLAY_BATCH_DEPTH {
        return Err(ReplayError::BatchDepthExceeded {
            index,
            depth,
            max: MAX_REPLAY_BATCH_DEPTH,
        });
    }
    match op {
        Op::PutValue {
            sheet,
            row,
            col,
            value,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // **Phase 5.7 V3.5.0.3b (2026-05-24)**: silent no-op on
            // tombstoned sheets per the CRDT semantic decision lock.
            // Concurrent {PutValue, RemoveSheet} ordering:
            //   - PutValue first -> writes cell, then RemoveSheet
            //     tombstones (cell stays in storage; unreachable via
            //     snapshot which filters tombstones).
            //   - RemoveSheet first -> PutValue silently dropped (this
            //     branch).
            // All peers converge to the same final state by Loro's
            // deterministic causal-merge order.
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            let v: Value = value
                .to_value()
                .map_err(|source| ReplayError::ValueDecode { index, source })?;
            workbook.put_at(*sheet, *row, *col, v);
            Ok(())
        }
        Op::ClearValue { sheet, row, col } => {
            // **F2 Blank-durability closure (2026-05-27):** clear the
            // cell's literal value by writing `Value::Blank` to the user
            // overlay — the SAME mechanism `WorkbookRuntime::set_value`
            // uses for a Blank input (`workbook.put_at(.., Value::Blank)`;
            // the read cascade reports a Blank overlay entry identically
            // to an absent one). The formula association, if any, is
            // intentionally untouched — value and formula are independent
            // overlays, so a stand-alone ClearValue must not strip a
            // formula (that is `ClearFormula`'s job).
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // V3.5.0.3b: silent no-op on tombstoned sheet (see Op::PutValue).
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            workbook.put_at(*sheet, *row, *col, Value::Blank);
            Ok(())
        }
        Op::PutFormula {
            sheet,
            row,
            col,
            text,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // V3.5.0.3b: silent no-op on tombstoned sheet (see Op::PutValue).
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            workbook.put_formula(*sheet, *row, *col, text.as_str());
            Ok(())
        }
        Op::ClearFormula { sheet, row, col } => {
            // clear_formula is idempotent on missing entries; we still
            // validate bounds so a corrupted op-log can't sneak past.
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // V3.5.0.3b: silent no-op on tombstoned sheet (see Op::PutValue).
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            workbook.clear_formula(*sheet, *row, *col);
            Ok(())
        }
        Op::SetName {
            scope,
            name,
            target,
        } => {
            let target = target
                .to_target(name)
                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
            match scope {
                None => {
                    // Workbook-scoped (historical path).
                    workbook.set_name(name, target).map_err(|source| {
                        ReplayError::NameRejected {
                            index,
                            name: name.clone(),
                            source,
                        }
                    })?;
                }
                Some(sheet) => {
                    // **W5-92 (Phase 4.6.D):** sheet-scoped. Validate sheet
                    // first so an unknown id surfaces as InvalidSheet, not
                    // a panicking out-of-bounds index.
                    let sheet_count = workbook.sheet_count();
                    let sheet_ref =
                        workbook
                            .sheet_mut(*sheet)
                            .ok_or(ReplayError::InvalidSheet {
                                index,
                                sheet: *sheet,
                                sheet_count,
                            })?;
                    sheet_ref.set_scoped_name(name, target).map_err(|source| {
                        ReplayError::NameRejected {
                            index,
                            name: name.clone(),
                            source,
                        }
                    })?;
                }
            }
            Ok(())
        }
        Op::RemoveName { scope, name } => {
            // **FE-5 W-N (2026-06-12):** the compensating replay for the
            // `SetName` arm above. Routes to `NameTable::clear` for the right
            // scope so a re-materialized workbook (undo/redo's
            // `baseline + replay(oplog)`) does NOT resurrect a deleted name.
            // `clear` uppercases the query + is idempotent on a missing key
            // (a merged log that removes the same name twice converges).
            match scope {
                None => {
                    // Workbook-scoped (mirrors the `SetName { scope: None }` arm).
                    workbook.names_mut().clear(name);
                }
                Some(sheet) => {
                    // Sheet-scoped. Validate the sheet id first so an unknown
                    // id surfaces as InvalidSheet (mirrors `SetName`), not a
                    // silent no-op that would mask a corrupt log.
                    let sheet_count = workbook.sheet_count();
                    let sheet_ref =
                        workbook
                            .sheet_mut(*sheet)
                            .ok_or(ReplayError::InvalidSheet {
                                index,
                                sheet: *sheet,
                                sheet_count,
                            })?;
                    sheet_ref.scoped_names_mut().clear(name);
                }
            }
            Ok(())
        }
        Op::AddSheet { name, chunk_rows } => {
            // **W5-93 (Phase 4.6.E closure):** route through the fallible
            // `try_add_sheet_with_chunk_rows` and surface a clean
            // `ReplayError::SheetNameRejected` on validation failure.
            // Codex HIGH-1 flagged that the prior infallible path
            // silently accepted duplicate-canonical names + reserved
            // characters at the replay boundary too.
            //
            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
            // duplicate-canonical-name. Phase 5 multi-peer scenario:
            // peer A and peer B both call `add_sheet("S")` locally;
            // each producer-side validates against its own snapshot
            // (no collision visible); both emit
            // `Op::AddSheet { name: "S", ... }`; merged log has both.
            // First replay succeeds; second hits the duplicate guard.
            // Pre-D-2 we rejected the second op (worse UX than Google
            // Sheets, which auto-renames to S(2)). Now we walk
            // `<name>(2)`, `<name>(3)`, … until we find a free name.
            // `Empty` + `ReservedCharacter` still reject — auto-rename
            // only resolves the collaboration-collision case.
            let mut chosen = name.clone();
            let mut suffix = 2u32;
            const AUTO_RENAME_CEILING: u32 = 10_000;
            loop {
                match workbook.try_add_sheet_with_chunk_rows(chosen.clone(), *chunk_rows) {
                    Ok(_) => return Ok(()),
                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
                        chosen = format!("{name}({suffix})");
                        suffix += 1;
                        if suffix > AUTO_RENAME_CEILING {
                            // Pathological: more than 10k sheets all
                            // share the same base name (impossible in
                            // realistic workbooks; max sheets per
                            // workbook is 65,535). Surface a clean
                            // error rather than loop forever.
                            return Err(ReplayError::SheetNameRejected {
                                index,
                                name: name.clone(),
                                source: ql_storage::SheetNameError::Duplicate {
                                    name: name.clone(),
                                },
                            });
                        }
                    }
                    Err(other) => {
                        return Err(ReplayError::SheetNameRejected {
                            index,
                            name: name.clone(),
                            source: other,
                        });
                    }
                }
            }
        }
        Op::RenameSheet {
            id,
            old_name,
            new_name,
        } => {
            // **W5-91 (Phase 4.6.C) + Phase 5.3 step 2 + step-2 audit
            // closure (2026-05-20):** snapshot-vs-replay reconciliation
            // + CRDT concurrent-rename policy.
            //
            // Two cases (post-step-2-audit-closure):
            //
            //   1. Current display name == new_name (EXACT equality, not
            //      canonical) → idempotent. Replay-on-top-of-snapshot OR
            //      concurrent peers picked the same target. No-op.
            //
            //      **MEDIUM-1 audit closure (Codex):** pre-closure the
            //      idempotency check used canonical equality, which
            //      silently dropped case-only renames (e.g. "Sheet1" →
            //      "SHEET1"). Storage permits case-only renames and
            //      updates the display field; replay must do the same.
            //
            //   2. Otherwise → apply the rename. Subsumes:
            //      - pre-step-2 case 2 (current == old_name; fresh rename).
            //      - pre-step-2 case 3 (current ∈ neither; **Phase 5.3
            //        step 2 policy**, audit-locked: last-in-causal-order
            //        wins under CRDT merge — apply to current sheet name.
            //        Matches `crdt-data-model.md` § 311-334 last-wins
            //        rule for SetName + same-cell writes).
            //      - case-only rename (canonical equal, display differs).
            //
            // **HIGH-1 audit closure (Codex + Opus convergent):** rename
            // target collision (`new_name` already used by a different
            // sheet) auto-disambiguates via D-2-style suffix walk
            // (`<name>(2)`, `<name>(3)`, …). Pre-closure this propagated
            // `SheetRenameRejected` and hard-failed replay — same blast
            // radius as the original pre-step-2 bug, just shifted to a
            // different concurrent scenario (peer A: sheet0 S1→X, peer
            // B: sheet1 S3→X, both valid locally, second errors on merge).
            //
            // D-2 (AddSheet auto-rename) set the precedent at
            // `replay.rs:458-490`; RenameSheet now follows the same
            // pattern for consistency. `Empty` + `ReservedCharacter`
            // still reject — auto-rename only resolves collisions.
            //
            // Edge cases:
            //   - Sheet doesn't exist at id → `InvalidSheet` (unchanged).
            //   - `new_name` is empty → `SheetRenameRejected { source:
            //     SheetNameError::Empty }` propagated from storage. The
            //     wire op format does not enforce non-empty; producer-side
            //     `WorkbookRuntime::rename_sheet` validates, but a
            //     malformed log can still bypass that path. HIGH-2 audit
            //     closure (Opus): documented here.
            //   - Reserved-character in `new_name` → `SheetRenameRejected
            //     { source: ReservedCharacter(_) }`. Same caveat as Empty.
            const AUTO_RENAME_CEILING: u32 = 10_000;

            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
                ReplayError::InvalidSheet {
                    index,
                    sheet: *id,
                    sheet_count: workbook.sheet_count(),
                },
            )?;
            if current == *new_name {
                // Case 1: already at exact target display. No-op.
                return Ok(());
            }
            // Case 2: apply rename, auto-disambiguating Duplicate via D-2
            // pattern. Empty + ReservedCharacter still reject.
            let mut chosen = new_name.clone();
            let mut suffix = 2u32;
            loop {
                match workbook.rename_sheet(*id, chosen.clone()) {
                    Ok(_) => return Ok(()),
                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
                        chosen = format!("{new_name}({suffix})");
                        suffix += 1;
                        if suffix > AUTO_RENAME_CEILING {
                            return Err(ReplayError::SheetRenameRejected {
                                index,
                                id: *id,
                                old_name: old_name.clone(),
                                new_name: new_name.clone(),
                                source: ql_storage::SheetNameError::Duplicate {
                                    name: new_name.clone(),
                                },
                            });
                        }
                    }
                    Err(other) => {
                        return Err(ReplayError::SheetRenameRejected {
                            index,
                            id: *id,
                            old_name: old_name.clone(),
                            new_name: new_name.clone(),
                            source: other,
                        });
                    }
                }
            }
        }
        Op::MoveSheet { id, new_index } => {
            // **Phase 5.7 V3.5.0.3c (2026-05-24)**: reorder `id` to
            // `new_index` in the workbook's display-order overlay.
            // Per the V3.5.0.3c CRDT semantic decision lock (documented
            // at op.rs Op::MoveSheet docstring):
            //
            // - id stability preserved: sheet ids in `Workbook.sheets`
            //   are UNCHANGED.  Only `Workbook.sheet_display_order` is
            //   mutated.  Subsequent ops referencing the moved sheet by
            //   id keep landing on the correct sheet.
            //
            // - Idempotent if id is not in display_order: silently
            //   no-ops.  Cross-peer case: peer sees Op::MoveSheet for
            //   an id whose Op::AddSheet hasn't replayed locally;
            //   Loro causal-merge will eventually rectify but the
            //   strict-error path would break the merge.
            //
            // - Idempotent if new_index >= display_order.len():
            //   clamped to len (append-to-end semantics).
            //
            // - Move-tombstoned-sheet silently applies: display order
            //   records user's intent even for deleted sheets (V3.6+
            //   un-delete preserves the move).  workbook_snapshot
            //   napi layer applies the tombstone filter; here in
            //   replay we just update the overlay.
            //
            // No CRDT auto-disambiguate dance needed (unlike AddSheet's
            // D-2 collision resolver or RenameSheet's HIGH-1 collision
            // resolver) -- move has no name conflict surface.
            workbook.move_sheet(*id, *new_index);
            Ok(())
        }
        Op::RemoveSheet { id } => {
            // **Phase 5.7 V3.5.0.3b (2026-05-24)**: tombstone the sheet
            // at `*id`.  Per the V3.5.0.3b CRDT semantic decision lock
            // (documented at op.rs Op::RemoveSheet docstring):
            //
            // - Idempotent: re-removing an already-tombstoned sheet is
            //   a no-op (HashSet semantics in workbook.remove_sheet).
            //
            // - Out-of-range ids: silently ignored.  A peer that hasn't
            //   seen the corresponding `Op::AddSheet` might still see
            //   another peer's `Op::RemoveSheet` for the (not-yet-
            //   created) id; deterministic causal-merge order will
            //   eventually replay AddSheet before RemoveSheet, but the
            //   strict-error-on-missing approach would break the merge.
            //   `Workbook::remove_sheet` enforces the no-op behavior
            //   internally.
            //
            // - Storage retained: tombstoning does NOT free the
            //   underlying `Sheet` storage.  Sheet stays at sheets[id]
            //   for id-stability of subsequent cell-keyed ops.
            //
            // No CRDT auto-disambiguate dance is needed here (unlike
            // AddSheet's D-2 collision resolver and RenameSheet's
            // HIGH-1 disambiguation), because remove has no "target
            // name" to collide on.
            workbook.remove_sheet(*id);
            Ok(())
        }
        Op::RestoreSheet { id } => {
            // **Phase 5.7 V3.6.0.10 D8 (2026-05-25)**: un-tombstone
            // the sheet at `*id`.  Reverses the V3.5.0.3b tombstone
            // effect from `Op::RemoveSheet`.  Per the V3.6.0.10 D8
            // CRDT semantic (documented at op.rs Op::RestoreSheet
            // docstring):
            //
            // - Idempotent: restoring a non-tombstoned sheet is a
            //   no-op (HashSet::remove on absent).
            //
            // - Out-of-range ids: silently dropped.  Matches the
            //   Op::RemoveSheet permissive contract; a peer might
            //   see Op::RestoreSheet for an id whose Op::AddSheet
            //   hasn't replayed locally yet; Loro's causal-merge
            //   order will eventually rectify but the strict-error
            //   path would break the merge.  Workbook::restore_sheet
            //   enforces the no-op behavior internally.
            //
            // - Cell preservation: cells written BEFORE the original
            //   Op::RemoveSheet are still in `sheets[id]` (the
            //   V3.5.0.3b tombstone preserves storage); they reappear.
            //   Cells silently dropped while tombstoned do NOT
            //   reappear -- they never reached storage.
            //
            // - Cross-peer convergence: concurrent {RemoveSheet,
            //   RestoreSheet} resolved by Loro's causal-merge order
            //   (last-replayed wins).  Both peers converge to the
            //   same final tombstone state.
            workbook.restore_sheet(*id);
            Ok(())
        }
        Op::RegisterFormat { id, string } => {
            // **W5-80:** route through `FormatTable::register_at` so
            // collisions surface as `FormatRejected` (rather than the
            // panic-on-duplicate behavior `intern` would have via the
            // by_string fast path; `register_at` is the explicit-id form).
            //
            // Phase 5.2 D-1 step 4: `Op::RegisterFormat.id` is now
            // `FormatIdWire`. Convert to `ql_storage::FormatId` via
            // `to_storage()`. The pre-step-4 `legacy_from_u32` migration
            // helper is no longer needed for the wire-replay path; it's
            // reserved for envelope-load migration in step 5.
            let fid = id.to_storage();
            workbook
                .formats_mut()
                .register_at(fid, string.as_str())
                .map_err(|e| ReplayError::FormatRejected {
                    index,
                    source: e.into(),
                })?;
            Ok(())
        }
        Op::SetCellFormat {
            sheet,
            row,
            col,
            id,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // V3.5.0.X audit-closure Opus-H1 (2026-05-24): silent no-op
            // on tombstoned sheet (see Op::PutValue).  V3.5.0.5 added the
            // SetCellFormat handler AFTER V3.5.0.3b shipped the tombstone
            // guards on PutValue/PutFormula/ClearFormula; the cell-keyed
            // sweep was not re-run.  Without this guard, SetCellFormat on
            // a tombstoned sheet would write to format_overlay (invisible
            // via workbook_snapshot but surfaces in list_sheets_from_cache
            // as a phantom entry, and a future Op::RestoreSheet would
            // surface unexpected format mutations).
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            // **W5-80:** require the id to be registered. Catches
            // producer bugs where `SetCellFormat` was emitted without
            // a preceding `RegisterFormat`. `None` means clear.
            if let Some(wire_id) = id {
                // Phase 5.2 D-1 step 4: same wire→storage conversion.
                let fid = wire_id.to_storage();
                if workbook.formats().lookup(fid).is_none() {
                    return Err(ReplayError::FormatNotRegistered { index, id: fid });
                }
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .format_overlay_mut()
                    .set(*row, *col, fid);
            } else {
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .format_overlay_mut()
                    .clear(*row, *col);
            }
            Ok(())
        }
        // **FE-4 W4 (2026-06-10):** register a style value at its id. Mirrors
        // `Op::RegisterFormat`: route through `StyleTable::register_at` so
        // id/value collisions + counter overflow surface as `StyleRejected`
        // (idempotent on a same-id-same-style replay).
        Op::RegisterStyle { id, style } => {
            let sid = id.to_storage();
            let style = style.to_storage();
            workbook.styles_mut().register_at(sid, style).map_err(|e| {
                ReplayError::StyleRejected {
                    index,
                    source: e.into(),
                }
            })?;
            Ok(())
        }
        // **FE-4 W4 (2026-06-10):** set or clear a cell's style id. Mirrors
        // `Op::SetCellFormat` exactly: tombstone no-op, unknown-id refused,
        // `None` clears the overlay entry.
        Op::SetCellStyle {
            sheet,
            row,
            col,
            id,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            // Tombstone guard (mirrors SetCellFormat): a style write on a
            // tombstoned sheet is a silent no-op.
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            if let Some(wire_id) = id {
                let sid = wire_id.to_storage();
                if workbook.styles().lookup(sid).is_none() {
                    return Err(ReplayError::StyleNotRegistered { index, id: sid });
                }
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .style_overlay_mut()
                    .set(*row, *col, sid);
            } else {
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .style_overlay_mut()
                    .clear(*row, *col);
            }
            Ok(())
        }
        // **Wave G2 (engine-filter):** hide/show a set of rows. Mirrors
        // `SetCellStyle`'s VALIDATE-then-tombstone order: every row is validated
        // BEFORE the tombstone no-op, so a bad row aborts the whole op atomically
        // (No-Fallbacks — never a partial hidden set) REGARDLESS of whether the
        // sheet is tombstoned. **(Codex HIGH):** this ordering is load-bearing —
        // collab's `op_statically_aborts_batch` rejects `row > MAX_ROW`
        // UNCONDITIONALLY, so if replay let a bad-row op no-op on a tombstoned
        // sheet (validating AFTER the tombstone check), a batch with such an op +
        // a valid live-sheet op would replay OK while the cache walker suppressed
        // the whole batch -> `last_snapshot` divergence. Validating first keeps
        // replay and the static batch-abort in lockstep.
        Op::SetRowsHidden {
            sheet,
            rows,
            hidden,
        } => {
            let count = workbook.sheet_count();
            if (*sheet as usize) >= count {
                return Err(ReplayError::InvalidSheet {
                    index,
                    sheet: *sheet,
                    sheet_count: count,
                });
            }
            // Validate ALL rows up-front (before the tombstone no-op — see above).
            for &row in rows {
                if row > MAX_ROW {
                    return Err(ReplayError::InvalidCell {
                        index,
                        row,
                        col: 0,
                        why: "hidden row exceeds MAX_ROW (1,048,575)",
                    });
                }
            }
            // Tombstoned sheet → silent no-op (mirrors SetCellStyle).
            if workbook.is_sheet_removed(*sheet) {
                return Ok(());
            }
            let s = workbook.sheet_mut(*sheet).expect("sheet validated above");
            for &row in rows {
                s.set_row_hidden(row, *hidden);
            }
            Ok(())
        }
        // **W3 (insert/delete rows & columns):** the structural edit's
        // POSITIONAL shift. The accompanying formula-TEXT rewrite rides as
        // separate `Op::PutFormula` ops in the enclosing `BatchCommit`. A
        // tombstoned sheet → silent no-op (mirrors `PutValue`). Storage
        // rejections (invalid range, table split, off-grid overflow) surface
        // as `ReplayError::StructuralEdit`.
        Op::InsertRows { sheet, at, count } => apply_structural(workbook, *sheet, index, |wb| {
            wb.insert_rows(*sheet, *at, *count)
        }),
        Op::DeleteRows { sheet, start, end } => apply_structural(workbook, *sheet, index, |wb| {
            wb.delete_rows(*sheet, *start, *end)
        }),
        Op::InsertColumns { sheet, at, count } => apply_structural(workbook, *sheet, index, |wb| {
            wb.insert_columns(*sheet, *at, *count)
        }),
        Op::DeleteColumns { sheet, start, end } => {
            apply_structural(workbook, *sheet, index, |wb| {
                wb.delete_columns(*sheet, *start, *end)
            })
        }
        Op::BatchCommit { ops } => {
            // **MED-1 (megaudit, Codex) closure — rollback atomicity.**
            // Pre-fix this applied each inner op DIRECTLY to `workbook`, so a
            // batch that half-failed (e.g. a structural inner op the storage
            // rejects, or a malformed cell op) left storage half-mutated — the
            // op.rs "atomically" claim was a lie. Now apply the whole batch to
            // a CLONE, then swap on success: a mid-batch failure returns the
            // error with `workbook` byte-identical to its pre-batch state.
            //
            // `Workbook::clone` is shallow over Arrow chunk Arcs (refcount
            // bumps; no buffer copy — see the Workbook Clone contract), and
            // all id allocators / format + table counters live INSIDE the
            // Workbook, so cloning isolates every inner-op side effect until
            // the batch commits as a unit. Determinism is preserved: the inner
            // ops apply in the same order to the clone, and the same fresh
            // column ids / format ids are allocated.
            //
            // Phase 2A.3.a: nested ops flatten to the parent's index for error
            // reporting (a nested BatchCommit recurses through this same arm,
            // so it is itself atomic over its own clone).
            let mut staged = workbook.clone();
            for inner_op in ops {
                apply_op(inner_op, &mut staged, index, depth + 1)?;
            }
            *workbook = staged;
            Ok(())
        }
        Op::CreateTable {
            name,
            sheet,
            top_row,
            top_col,
            rows,
            cols,
            has_header,
            has_totals,
            column_names,
        } => apply_create_table(
            workbook,
            index,
            name,
            *sheet,
            *top_row,
            *top_col,
            *rows,
            *cols,
            *has_header,
            *has_totals,
            column_names,
        ),
        Op::DropTable { name } => {
            // **Phase 5.3 step 5 megaudit closure (Codex HIGH + Opus-A
            // V1 LIM #4, 2026-05-20):** advisory-skip on missing source
            // under CRDT merge. Pre-closure the handler hard-failed via
            // `TableNotFound` when the table was already gone, producing
            // an order-dependent failure:
            //   drop(T) then rename(T→T2) → OK (rename advisory-skips)
            //   rename(T→T2) then drop(T) → Err(TableNotFound)
            // The two orderings are logically equivalent (concurrent
            // ops on the same table; final state: table absent), so the
            // hard-fail in one direction is a CRDT-merge regression.
            //
            // Post-closure: idempotent skip when the table is gone. This
            // mirrors the `apply_rename_table` policy at lines 802-820
            // (advisory-skip on missing source) — same bug class, same
            // fix shape.
            let canonical = name.to_ascii_uppercase();
            let _ = workbook.tables_mut().remove(canonical.as_str());
            Ok(())
        }
        Op::RenameTable { old_name, new_name } => {
            apply_rename_table(workbook, index, old_name, new_name)
        }
        Op::RenameColumn {
            table,
            old_name,
            new_name,
        } => apply_rename_column(workbook, index, table, old_name, new_name),
        Op::ResizeTable {
            name,
            new_rows,
            new_cols,
            added_columns,
            removed_columns,
        } => apply_resize_table(
            workbook,
            index,
            name,
            *new_rows,
            *new_cols,
            added_columns,
            removed_columns,
        ),
        // **W5-146 (Phase 4.9.J) + W5-151 (4.9.O MEDIUM-2 closure):**
        // workbook-scope reference-mode change. Forward-compat
        // unknown wire values surface `ReplayError::UnknownReferenceMode`
        // with the captured string (mirrors the `LocaleWire::Unknown`
        // path below).
        Op::SetReferenceMode { mode } => match mode.clone().to_runtime() {
            Ok(m) => {
                workbook.set_reference_mode(m);
                Ok(())
            }
            Err(found) => Err(ReplayError::UnknownReferenceMode { index, found }),
        },
        // **W5-146 (Phase 4.9.J):** workbook-scope locale change.
        // Unknown wire values (forward-compat op-log file) surface
        // `ReplayError::UnknownLocale` with the captured string.
        Op::SetLocale { locale } => match locale.clone().to_runtime() {
            Ok(loc) => {
                workbook.set_locale(loc);
                Ok(())
            }
            Err(found) => Err(ReplayError::UnknownLocale { index, found }),
        },
        // **Phase 5.7 V3.6.0.X audit-of-D4 CONVERGENT-HIGH-1 closure
        // (2026-05-24):** workbook-scope date-system change.  Mirrors
        // the SetLocale handler.  Without this replay arm,
        // `workbook.date_system()` would always default to `Excel1900`
        // regardless of the op-log content (and `from_qbook` would
        // silently drop the loaded workbook's date_system).  Codex
        // Lane A HIGH-1 + Opus Lane B HIGH-1 both empirically
        // demonstrated.
        Op::SetDateSystem { date_system } => match date_system.clone().to_runtime() {
            Ok(ds) => {
                workbook.set_date_system(ds);
                Ok(())
            }
            Err(found) => Err(ReplayError::UnknownDateSystem { index, found }),
        },
        Op::AddChart {
            id,
            name,
            chart_type,
            sheet,
            anchor_row,
            anchor_col,
            width_px,
            height_px,
            src_sheet,
            src_start_row,
            src_start_col,
            src_end_row,
            src_end_col,
            title,
        } => {
            let chart = decode_chart(
                index,
                *id,
                name,
                chart_type,
                *sheet,
                *anchor_row,
                *anchor_col,
                *width_px,
                *height_px,
                *src_sheet,
                *src_start_row,
                *src_start_col,
                *src_end_row,
                *src_end_col,
                title,
            )?;
            // Idempotent-skip: an AddChart whose id is already present is a
            // no-op (replay re-runnability + CRDT convergence). Charts are
            // inert metadata (no cell registration), so a re-add cannot
            // corrupt grid state.
            if workbook.charts().lookup(*id).is_none() {
                workbook.charts_mut().insert(chart);
            }
            Ok(())
        }
        Op::UpdateChart {
            id,
            name,
            chart_type,
            sheet,
            anchor_row,
            anchor_col,
            width_px,
            height_px,
            src_sheet,
            src_start_row,
            src_start_col,
            src_end_row,
            src_end_col,
            title,
        } => {
            let chart = decode_chart(
                index,
                *id,
                name,
                chart_type,
                *sheet,
                *anchor_row,
                *anchor_col,
                *width_px,
                *height_px,
                *src_sheet,
                *src_start_row,
                *src_start_col,
                *src_end_row,
                *src_end_col,
                title,
            )?;
            // A missing id is a divergence: in a valid log an UpdateChart
            // always follows the matching AddChart. Fail loudly.
            if workbook.charts().lookup(*id).is_none() {
                return Err(ReplayError::ChartNotFound { index, id: *id });
            }
            workbook.charts_mut().insert(chart);
            Ok(())
        }
        Op::RemoveChart { id } => {
            // Idempotent no-op when the id is already gone (mirrors
            // `DropTable`'s advisory-skip for CRDT convergence).
            let _ = workbook.charts_mut().remove(*id);
            Ok(())
        }
    }
}

/// **Wave Q1 (2026-06-23):** decode an `AddChart`/`UpdateChart` op's wire
/// fields into a [`ql_storage::ChartObject`]. The only fallible step is the
/// `chart_type` token (`"line"`/`"bar"`/`"scatter"`); an unknown token
/// surfaces [`ReplayError::UnknownChartKind`] rather than silently
/// defaulting. Charts are inert metadata (they never register cells), so —
/// unlike table footprints — out-of-range anchor/source coordinates cannot
/// panic the storage layer and are not re-validated here (the producer
/// validates at the napi boundary).
#[allow(clippy::too_many_arguments)]
fn decode_chart(
    index: usize,
    id: u32,
    name: &str,
    chart_type: &str,
    sheet: SheetId,
    anchor_row: RowId,
    anchor_col: ColId,
    width_px: u32,
    height_px: u32,
    src_sheet: SheetId,
    src_start_row: RowId,
    src_start_col: ColId,
    src_end_row: RowId,
    src_end_col: ColId,
    title: &Option<String>,
) -> Result<ql_storage::ChartObject, ReplayError> {
    let kind = ql_storage::ChartKind::from_wire_str(chart_type).ok_or_else(|| {
        ReplayError::UnknownChartKind {
            index,
            found: chart_type.to_string(),
        }
    })?;
    Ok(ql_storage::ChartObject {
        id,
        name: name.to_string(),
        chart_type: kind,
        sheet,
        anchor_row,
        anchor_col,
        width_px,
        height_px,
        source_range: ql_types::Range::new(
            src_sheet,
            src_start_row,
            src_start_col,
            src_end_row,
            src_end_col,
        ),
        title: title.clone(),
    })
}

/// **W5-119 (Phase 4.8.I) + Phase 5.3 step 4 (2026-05-20):**
/// replay a `RenameTable`. Validates source exists, target name is
/// available (TableTable + NameTable shared namespace), then re-keys
/// the entry.
///
/// **Phase 5.3 step 4 (audit-locked, mirrors step 2 for
/// RenameSheet):** two CRDT-merge scenarios required this handler to
/// be made resilient:
///
/// 1. **Concurrent rename of same table** (last-wins): peer A
///    renames T→T1, peer B (concurrent) renames T→T2. After Loro's
///    causal merge, the second op's `old_name="T"` no longer
///    resolves to a live table. Pre-step-4 this errored with
///    `TableNotFound`. Post-step-4: if NO table at `old_canonical`
///    exists but the workbook still has the post-first-rename
///    name (T1 or T2 depending on causal order), we no-op the
///    second rename if its `new_name` matches a current table
///    (idempotency); otherwise, we treat the rename as advisory
///    and skip if the table simply doesn't exist anywhere.
///    Note: unlike sheets which carry stable IDs, tables are
///    keyed by canonical name — there's no equivalent "rename
///    current table to new_name" because we can't disambiguate
///    which current table the wire op was thought to be acting on.
///    Skip is the safer policy.
///
/// 2. **Cross-table target collision** (V1 LIMITATION — hard-fail):
///    peer A renames T1→X, peer B renames T2→X (different sources,
///    same target). After merge, the second op errors with
///    `TableCreateRejected`. Pre-step-4-audit the handler attempted
///    D-2-style auto-disambig (X → X(2)), but the step 4 audit
///    (Codex+Opus HIGH-1) showed this produced silent formula-
///    corruption when combined with `repair_table_rename_chain` —
///    the repair keyed its chain by op's wire `new_name` and missed
///    the auto-disambig'd canonical. Reverted to hard-reject. V2
///    closure path: emit synthesized correction op at replay (would
///    require API change to surface the disambig outcome to repair).
fn apply_rename_table(
    workbook: &mut Workbook,
    index: usize,
    old_name: &str,
    new_name: &str,
) -> Result<(), ReplayError> {
    let old_canonical = old_name.to_ascii_uppercase();

    // **Step 4 audit-locked policy** (V1 — tables): source table
    // missing under CRDT merge means a concurrent peer renamed it.
    // Three scenarios:
    //  (a) the rename has already been applied as part of this peer's
    //      causal-order replay (idempotent — current state has new_name).
    //  (b) a concurrent peer renamed it to a DIFFERENT target (e.g.
    //      peer A: T→T2; peer B: T→T3). Sheets handle this via stable
    //      sheet IDs (rename current sheet to new_name); tables don't
    //      have stable IDs (keyed by canonical name) so we can't
    //      disambiguate which table this op was thought to be acting
    //      on. Apply "advisory skip" — drop the second rename's intent
    //      to avoid corruption.
    //  (c) the source genuinely doesn't exist (corruption or stale op
    //      against a never-existed table).
    //
    // V1 policy: skip silently in case (a) and (b); error only when
    // there's clearly no related table state to interpret the op
    // against (no current_canonical, no new_canonical, no plausible
    // post-rename state).
    //
    // **V1 limitation (deferred to V2):** scenario (b) loses peer
    // B's rename intent. Causality-aware tracking would let us tell
    // "this op was authored when T existed locally; the table was
    // since renamed to T2 by a concurrent peer; we COULD apply
    // T2→T3." Today the only safe call is advisory-skip.
    if workbook.tables().lookup(&old_canonical).is_none() {
        let new_canonical = new_name.to_ascii_uppercase();
        if workbook.tables().lookup(&new_canonical).is_some() {
            // Case (a): idempotent — new_name already exists.
            return Ok(());
        }
        // Cases (b) and (c): no related state. Advisory skip
        // (case b) accepts losing the rename intent rather than
        // hard-failing replay; the alternative would be re-erroring
        // and making merged logs un-replayable. The diagnostic
        // surface for (b) would require op-log-level reporting
        // beyond replay's return type — deferred to V2.
        return Ok(());
    }

    // **Step 4 audit closure (Codex+Opus HIGH-1, 2026-05-20):**
    // auto-disambiguation REVERTED. The previous implementation
    // walked suffixes (X → X(2)) on TableTable collision, but the
    // repair pass at `ql_collab::repair_table_rename_chain` keys
    // its chain by the op's wire `new_name`, not the actual
    // post-replay canonical (which would be the suffixed `X(2)`).
    // That mismatch caused silent formula-text corruption:
    // formulas referencing peer B's old table got rewritten to the
    // OTHER table named X (peer A's), pointing at the wrong sheet.
    //
    // Reverting to hard-reject on collision restores correctness:
    // - Cross-source target collision (peer A: T1→X; peer B: T2→X
    //   concurrent): the second op errors via TableCreateRejected.
    //   This is a HARD-FAIL — V1 limitation, documented in plan.
    //   Future V2 closure paths: emit synthesized correction op at
    //   replay (would require API change), OR reconcile via
    //   causality-aware tracking.
    let new_canonical_arc: std::sync::Arc<str> =
        std::sync::Arc::from(new_name.to_ascii_uppercase().as_str());
    // No-op same-canonical case.
    if old_canonical.eq_ignore_ascii_case(new_name) {
        return Ok(());
    }
    // NameTable collision (different namespace).
    if workbook.names().lookup_ci(&new_canonical_arc).is_some() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: new_name.to_owned(),
            reason: "defined-name with this canonical name already exists (rename target)",
        });
    }
    // TableTable collision.
    if workbook.tables().lookup(&new_canonical_arc).is_some() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: new_name.to_owned(),
            reason: "table with this canonical name already exists (rename target)",
        });
    }
    // Apply the rename.
    let mut meta = workbook
        .tables_mut()
        .remove(&old_canonical)
        .expect("source verified above");
    meta.name = std::sync::Arc::clone(&new_canonical_arc);
    meta.display_name = std::sync::Arc::from(new_name);
    workbook.tables_mut().insert(new_canonical_arc, meta);
    Ok(())
}

/// **W5-121 (Phase 4.8.I.2):** replay a `RenameColumn`. Validates the
/// target table exists, the source column exists (case-insensitive), and
/// the target column name is available within the table. Mutates the
/// matching `TableColumn`'s `name` (lowercase canonical) and `display`
/// (case-preserving). Bumps the `TableTable` generation so plan caches
/// invalidate. Same-canonical column renames are rejected — the producer
/// side treats those as a no-op and doesn't emit the op, so receiving
/// one indicates log divergence.
fn apply_rename_column(
    workbook: &mut ql_storage::Workbook,
    index: usize,
    table: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), ReplayError> {
    let table_canonical = table.to_ascii_uppercase();

    // **Phase 5.3 step 5c audit closure (Codex+Opus convergent HIGH-1,
    // 2026-05-20):** advisory-skip when the table itself is missing.
    //
    // Pre-closure this hard-failed with `TableNotFound { name: table }`
    // when peer A renamed `Tbl → Sales` concurrent with peer B's
    // `RenameColumn { table: "Tbl", ... }` — the entire merged log
    // became un-replayable. Empirical reproducer (Opus probe P1,
    // Codex first-HIGH probe): replay errored with TableNotFound at
    // the column rename's op index.
    //
    // Root cause: asymmetry with `apply_rename_table` at lines
    // 802-820, which already advisory-skips on missing source as a
    // step-4-audit-closure. Step 4 closed the table case but didn't
    // extend the same fix to the cross-kind column case.
    //
    // Post-closure: advisory-skip the column rename. The column
    // rename intent is lost (V1 limitation — same as the
    // concurrent-rename intermediate-names case for sheets / tables;
    // future V2 closure: causality-aware tracking via Loro op-ids
    // that re-targets the column op to the renamed-to table
    // canonical). Production-side renames always emit the column op
    // AFTER any table rename in linear (single-writer) history, so
    // this affects only adversarial cross-peer interleavings — but
    // those interleavings ARE common in real collab flows, so V1
    // closure required.
    if workbook.tables_mut().get_mut(&table_canonical).is_none() {
        return Ok(());
    }
    // Re-borrow with the now-confirmed-present check.
    let meta = workbook
        .tables_mut()
        .get_mut(&table_canonical)
        .expect("just-checked above");

    // **Phase 5.3 step 4 (V1, mirrors apply_rename_table policy)**:
    // missing source column under CRDT merge means a concurrent peer
    // renamed it. Idempotent skip if new_name already exists OR if
    // the table itself has been re-structured (advisory). Errors only
    // if there's clearly no related column state.
    if meta.lookup_column(old_name).is_none() {
        if meta.lookup_column(new_name).is_some() {
            // Idempotent: new_name already exists from a prior
            // causal-order rename.
            return Ok(());
        }
        // Advisory skip: concurrent peer renamed to a different
        // target. V1 limitation — see apply_rename_table for the
        // full rationale (no stable column-id equivalent).
        return Ok(());
    }
    let (col_idx, _) = meta.lookup_column(old_name).expect("just-checked");

    if new_name.is_empty() {
        return Err(ReplayError::TableColumnRejected {
            index,
            table: table.to_owned(),
            column: new_name.to_owned(),
            reason: "column name cannot be empty",
        });
    }
    let old_lower = old_name.to_ascii_lowercase();
    let new_lower = new_name.to_ascii_lowercase();
    if old_lower == new_lower {
        return Err(ReplayError::TableColumnRejected {
            index,
            table: table.to_owned(),
            column: new_name.to_owned(),
            reason: "rename to same canonical column name (producer should not emit)",
        });
    }

    // **Step 4 audit closure (Codex+Opus HIGH-2, 2026-05-20):**
    // column auto-disambiguation REVERTED. Same root cause as
    // table HIGH-1: column repair pass (deferred from step 4)
    // would have needed to track replay's suffix choice. Without
    // that integration, suffixing silently produces wrong-column
    // bindings post-merge. Reverting to hard-reject on collision
    // restores correctness:
    // - Cross-source target collision (peer A: A→Z; peer B: B→Z
    //   concurrent in the same table): the second op errors via
    //   TableColumnRejected. This is a HARD-FAIL — V1 limitation.
    if meta.lookup_column(new_name).is_some() {
        return Err(ReplayError::TableColumnRejected {
            index,
            table: table.to_owned(),
            column: new_name.to_owned(),
            reason: "column with this canonical name already exists (rename target)",
        });
    }

    meta.columns[col_idx as usize].name = std::sync::Arc::from(new_lower.as_str());
    meta.columns[col_idx as usize].display = std::sync::Arc::from(new_name);
    workbook.tables_mut().bump_generation();
    Ok(())
}

/// **W5-122 (Phase 4.8.J):** replay a `ResizeTable`. Validates the
/// target table exists, the arithmetic invariant
/// (`new_cols == old_cols + added.len() - removed.len()`),
/// `removed_columns` exactly match the current trailing columns
/// (case-insensitive on display), the final column roster has unique
/// canonical names, and the new footprint cells outside the old
/// footprint don't overlap other tables. Mutates the table metadata
/// in place (rows/cols + columns vec). Bumps `TableTable` generation.
fn apply_resize_table(
    workbook: &mut ql_storage::Workbook,
    index: usize,
    name: &str,
    new_rows: u32,
    new_cols: u32,
    added_columns: &[String],
    removed_columns: &[String],
) -> Result<(), ReplayError> {
    use ql_storage::TableColumn;
    let canonical = name.to_ascii_uppercase();
    // Snapshot the immutable bits we need to validate before mutating.
    let (sheet, top_row, top_col, old_rows, old_cols, old_displays) = {
        let meta =
            workbook
                .tables()
                .lookup(&canonical)
                .ok_or_else(|| ReplayError::TableNotFound {
                    index,
                    name: name.to_owned(),
                })?;
        (
            meta.sheet,
            meta.top_row,
            meta.top_col,
            meta.rows,
            meta.cols,
            meta.columns
                .iter()
                .map(|c| c.display.as_ref().to_owned())
                .collect::<Vec<_>>(),
        )
    };
    if new_rows == 0 || new_cols == 0 {
        return Err(ReplayError::TableResizeRejected {
            index,
            name: name.to_owned(),
            reason: "table rows and cols must both be > 0",
        });
    }
    // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
    // upper bound mirrors producer side.
    if let Err(reason) =
        ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, new_rows, new_cols)
    {
        return Err(ReplayError::TableResizeRejected {
            index,
            name: name.to_owned(),
            reason,
        });
    }
    let added_len = added_columns.len() as u32;
    let removed_len = removed_columns.len() as u32;
    if removed_len > old_cols {
        return Err(ReplayError::TableResizeRejected {
            index,
            name: name.to_owned(),
            reason: "removed_columns count exceeds existing column count",
        });
    }
    // Arithmetic invariant.
    if new_cols != old_cols + added_len - removed_len {
        return Err(ReplayError::TableResizeRejected {
            index,
            name: name.to_owned(),
            reason: "new_cols does not match old_cols + added - removed",
        });
    }
    // removed_columns must exactly match trailing displays
    // (case-insensitive).
    let trailing_start = (old_cols - removed_len) as usize;
    for (i, expected) in removed_columns.iter().enumerate() {
        let idx = trailing_start + i;
        if !old_displays[idx].eq_ignore_ascii_case(expected) {
            return Err(ReplayError::TableResizeRejected {
                index,
                name: name.to_owned(),
                reason: "removed_columns do not match trailing columns",
            });
        }
    }
    // added_columns: non-empty + unique vs final roster.
    if added_columns.iter().any(|s| s.is_empty()) {
        return Err(ReplayError::TableResizeRejected {
            index,
            name: name.to_owned(),
            reason: "added column names cannot be empty",
        });
    }
    // Build the final canonical (lowercase) roster.
    let mut final_canon: Vec<String> = old_displays
        .iter()
        .take(trailing_start)
        .map(|d| d.to_ascii_lowercase())
        .collect();
    for a in added_columns {
        final_canon.push(a.to_ascii_lowercase());
    }
    {
        use std::collections::HashSet;
        let mut seen: HashSet<&str> = HashSet::new();
        for cn in &final_canon {
            if !seen.insert(cn.as_str()) {
                return Err(ReplayError::TableResizeRejected {
                    index,
                    name: name.to_owned(),
                    reason: "final column roster has duplicate canonical names",
                });
            }
        }
    }
    // Footprint-overlap check: only cells NEWLY claimed by this resize
    // need checking. Old-footprint cells already belong to this table.
    // We test all cells in [top_row..top_row+new_rows] x [top_col..
    // top_col+new_cols] and skip those inside the OLD footprint.
    let old_end_row = top_row + old_rows;
    let old_end_col = top_col + old_cols;
    let new_end_row = top_row + new_rows;
    let new_end_col = top_col + new_cols;
    for r in top_row..new_end_row {
        for c in top_col..new_end_col {
            let inside_old = r < old_end_row && c < old_end_col;
            if inside_old {
                continue;
            }
            if let Some(other) = workbook.table_at(sheet, r, c) {
                if !other.name.eq_ignore_ascii_case(&canonical) {
                    return Err(ReplayError::TableResizeRejected {
                        index,
                        name: name.to_owned(),
                        reason: "new footprint overlaps an existing table",
                    });
                }
            }
            // **W5-124 (Phase 4.8.J.2):** spill-anchor check mirrors
            // producer side. Per design § 4.3 invariant #5, tables
            // block ALL spill anchors inside their footprint.
            if workbook.spill_anchor_at(sheet, r, c).is_some() {
                return Err(ReplayError::TableResizeRejected {
                    index,
                    name: name.to_owned(),
                    reason: "new footprint contains a spill anchor",
                });
            }
        }
    }
    // ----- Mutation -----
    // Allocate new column ids BEFORE taking &mut on the table entry
    // (allocate_column_id lives on TableTable not TableMetadata).
    let new_ids: Vec<u32> = (0..added_columns.len())
        .map(|_| workbook.tables_mut().allocate_column_id())
        .collect();
    let meta = workbook
        .tables_mut()
        .get_mut(&canonical)
        .expect("verified at top");
    meta.rows = new_rows;
    meta.cols = new_cols;
    meta.columns
        .truncate(meta.columns.len() - removed_len as usize);
    for (cn, id) in added_columns.iter().zip(new_ids) {
        meta.columns.push(TableColumn {
            id,
            name: std::sync::Arc::from(cn.to_ascii_lowercase().as_str()),
            display: std::sync::Arc::from(cn.as_str()),
            totals_function: None,
        });
    }
    workbook.tables_mut().bump_generation();
    Ok(())
}

/// **W5-118 (Phase 4.8.H):** apply a `CreateTable` op against the
/// workbook. Validates the same invariants the producer side checks
/// (mirror via `WorkbookRuntime::create_table`).
#[allow(clippy::too_many_arguments)]
fn apply_create_table(
    workbook: &mut Workbook,
    index: usize,
    name: &str,
    sheet: SheetId,
    top_row: RowId,
    top_col: ColId,
    rows: u32,
    cols: u32,
    has_header: bool,
    has_totals: bool,
    column_names: &[String],
) -> Result<(), ReplayError> {
    use ql_storage::{TableColumn, TableMetadata};
    let canonical: std::sync::Arc<str> = std::sync::Arc::from(name.to_ascii_uppercase().as_str());
    if workbook.tables().lookup(&canonical).is_some() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table with this canonical name already exists",
        });
    }
    if workbook.names().lookup_ci(&canonical).is_some() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "defined-name with this canonical name already exists (shared namespace)",
        });
    }
    if column_names.len() != cols as usize {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "column_names length does not match cols",
        });
    }
    if column_names.iter().any(|s| s.is_empty()) {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table column names cannot be empty",
        });
    }
    // Column-name uniqueness (case-insensitive).
    {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = HashSet::new();
        for cn in column_names {
            if !seen.insert(cn.to_ascii_lowercase()) {
                return Err(ReplayError::TableCreateRejected {
                    index,
                    name: name.to_owned(),
                    reason: "table column names must be unique (case-insensitive)",
                });
            }
        }
    }
    if workbook.sheet(sheet).is_none() {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table references unknown sheet",
        });
    }
    if rows == 0 || cols == 0 {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason: "table rows and cols must both be > 0",
        });
    }
    // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
    // upper bound mirrors producer side.
    if let Err(reason) =
        ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, rows, cols)
    {
        return Err(ReplayError::TableCreateRejected {
            index,
            name: name.to_owned(),
            reason,
        });
    }
    // Non-overlap + no-spill-anchor inside the footprint.
    // **W5-124 (Phase 4.8.J.2):** spill-anchor check mirrors producer
    // side per design § 4.3 invariant #5.
    for r in top_row..top_row + rows {
        for c in top_col..top_col + cols {
            if workbook.table_at(sheet, r, c).is_some() {
                return Err(ReplayError::TableCreateRejected {
                    index,
                    name: name.to_owned(),
                    reason: "table footprint overlaps an existing table",
                });
            }
            if workbook.spill_anchor_at(sheet, r, c).is_some() {
                return Err(ReplayError::TableCreateRejected {
                    index,
                    name: name.to_owned(),
                    reason: "table footprint contains a spill anchor",
                });
            }
        }
    }
    // Build columns with freshly-allocated ids.
    let columns: Vec<TableColumn> = column_names
        .iter()
        .map(|cn| TableColumn {
            id: workbook.tables_mut().allocate_column_id(),
            name: std::sync::Arc::from(cn.to_ascii_lowercase().as_str()),
            display: std::sync::Arc::from(cn.as_str()),
            totals_function: None,
        })
        .collect();
    let meta = TableMetadata {
        name: canonical.clone(),
        display_name: std::sync::Arc::from(name),
        sheet,
        top_row,
        top_col,
        rows,
        cols,
        has_header,
        has_totals,
        columns,
    };
    workbook.tables_mut().insert(canonical, meta);
    Ok(())
}

fn validate_cell(
    workbook: &Workbook,
    sheet: SheetId,
    row: RowId,
    col: ColId,
    index: usize,
) -> Result<(), ReplayError> {
    let count = workbook.sheet_count();
    if (sheet as usize) >= count {
        return Err(ReplayError::InvalidSheet {
            index,
            sheet,
            sheet_count: count,
        });
    }
    if row > MAX_ROW {
        return Err(ReplayError::InvalidCell {
            index,
            row,
            col,
            why: "row exceeds MAX_ROW (1,048,575)",
        });
    }
    if col > MAX_COLUMN {
        return Err(ReplayError::InvalidCell {
            index,
            row,
            col,
            why: "col exceeds MAX_COLUMN (16,383)",
        });
    }
    Ok(())
}

/// **W3 (insert/delete rows & columns):** shared replay helper for the four
/// structural-edit ops. Validates the sheet, silently no-ops on a tombstoned
/// sheet (mirrors `Op::PutValue`), then runs `edit`, mapping a storage
/// rejection to `ReplayError::StructuralEdit`.
fn apply_structural(
    workbook: &mut Workbook,
    sheet: SheetId,
    index: usize,
    edit: impl FnOnce(&mut Workbook) -> Result<(), ql_storage::StructuralEditError>,
) -> Result<(), ReplayError> {
    let count = workbook.sheet_count();
    if (sheet as usize) >= count {
        return Err(ReplayError::InvalidSheet {
            index,
            sheet,
            sheet_count: count,
        });
    }
    // Tombstoned sheet → silent no-op (CRDT semantic, see Op::PutValue).
    if workbook.is_sheet_removed(sheet) {
        return Ok(());
    }
    edit(workbook).map_err(|source| ReplayError::StructuralEdit { index, source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{CellWireValue, NamedTargetWire};
    use ql_functions::default_registry;
    use ql_storage::NamedTarget;
    use ql_types::Address;

    fn fresh_workbook_with_one_sheet() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    #[test]
    fn replay_empty_log_succeeds() {
        let log = OpLog::new();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn replay_put_value_lands_in_workbook() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 5,
            col: 3,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 1);
        assert_eq!(wb.read(Address::new(0, 5, 3)), Value::Number(42.0));
    }

    #[test]
    fn replay_put_formula_persists_text_only() {
        let mut log = OpLog::new();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "A1 + 1".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // Formula text persisted ...
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("A1 + 1"));
        // ... value NOT evaluated (replay leaves recompute to the caller).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    // ===== Wave Q1 (2026-06-23) — chart op replay =====

    fn add_chart_op(id: u32, kind: &str) -> Op {
        Op::AddChart {
            id,
            name: format!("chart{id}"),
            chart_type: kind.to_string(),
            sheet: 0,
            anchor_row: 1,
            anchor_col: 1,
            width_px: 100,
            height_px: 100,
            src_sheet: 0,
            src_start_row: 0,
            src_start_col: 0,
            src_end_row: 5,
            src_end_col: 0,
            title: None,
        }
    }

    #[test]
    fn replay_add_chart_lands_in_store() {
        let mut log = OpLog::new();
        log.append(add_chart_op(0, "line")).unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.charts().len(), 1);
        assert_eq!(
            wb.charts().lookup(0).unwrap().chart_type,
            ql_storage::ChartKind::Line
        );
    }

    #[test]
    fn replay_duplicate_add_chart_is_idempotent_skip() {
        // A re-applied AddChart for an already-present id is a no-op skip (NOT an
        // error, NOT an overwrite) — replay re-runnability + CRDT convergence.
        let mut log = OpLog::new();
        log.append(add_chart_op(0, "line")).unwrap();
        log.append(add_chart_op(0, "bar")).unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.charts().len(), 1, "duplicate id skipped, not double-inserted");
        assert_eq!(
            wb.charts().lookup(0).unwrap().chart_type,
            ql_storage::ChartKind::Line,
            "first AddChart wins; the duplicate is skipped (not an overwrite)"
        );
    }

    #[test]
    fn replay_add_then_remove_chart_leaves_empty() {
        let mut log = OpLog::new();
        log.append(add_chart_op(3, "scatter")).unwrap();
        log.append(Op::RemoveChart { id: 3 }).unwrap();
        // A RemoveChart for a missing id is an idempotent no-op (mirrors DropTable).
        log.append(Op::RemoveChart { id: 99 }).unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(wb.charts().is_empty());
    }

    #[test]
    fn replay_update_chart_preserves_id_and_replaces_state() {
        // The id-stability pin: AddChart's id survives the full replay so a later
        // UpdateChart referencing that id still hits (the reason AddChart carries
        // the id on the wire rather than re-allocating at replay).
        let mut log = OpLog::new();
        log.append(add_chart_op(7, "line")).unwrap();
        log.append(Op::UpdateChart {
            id: 7,
            name: "renamed".to_string(),
            chart_type: "scatter".to_string(),
            sheet: 0,
            anchor_row: 9,
            anchor_col: 9,
            width_px: 200,
            height_px: 200,
            src_sheet: 0,
            src_start_row: 0,
            src_start_col: 0,
            src_end_row: 1,
            src_end_col: 1,
            title: Some("t".to_string()),
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        let c = wb.charts().lookup(7).expect("chart 7 present after update");
        assert_eq!(c.chart_type, ql_storage::ChartKind::Scatter, "update replaced kind");
        assert_eq!(c.name, "renamed");
        assert_eq!(c.anchor_row, 9);
    }

    #[test]
    fn replay_unknown_chart_kind_errors_loudly() {
        let mut log = OpLog::new();
        log.append(add_chart_op(0, "pie")).unwrap(); // not a v1 kind
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::UnknownChartKind { ref found, .. } if found == "pie"),
            "expected UnknownChartKind, got {err:?}"
        );
    }

    #[test]
    fn replay_update_missing_chart_errors_loudly() {
        let mut log = OpLog::new();
        log.append(Op::UpdateChart {
            id: 1,
            name: "x".to_string(),
            chart_type: "line".to_string(),
            sheet: 0,
            anchor_row: 0,
            anchor_col: 0,
            width_px: 1,
            height_px: 1,
            src_sheet: 0,
            src_start_row: 0,
            src_start_col: 0,
            src_end_row: 0,
            src_end_col: 0,
            title: None,
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::ChartNotFound { id: 1, .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn replay_clear_formula_idempotent() {
        let mut log = OpLog::new();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "A1 + 1".to_owned(),
        })
        .unwrap();
        log.append(Op::ClearFormula {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();
        // Second ClearFormula on the now-empty cell — still ok.
        log.append(Op::ClearFormula {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// **F2 Blank-durability closure (2026-05-27):** a `PutValue(A1=5)`
    /// followed by `ClearValue(A1)` must replay to A1 == Blank, NOT 5.
    /// This is the canonical save/load + undo durability guarantee: the
    /// value-clear is now visible in the op log and reproduces on replay
    /// into a fresh workbook.
    #[test]
    fn replay_clear_value_resets_prior_put_value() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(5.0),
        })
        .unwrap();
        log.append(Op::ClearValue {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 2);
        // The value-clear reproduced: A1 is Blank, not the prior 5.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    /// **F2 closure:** `ClearValue` leaves any formula association at the
    /// cell untouched (value and formula are independent overlays; a
    /// stand-alone value-clear must not strip a formula).
    #[test]
    fn replay_clear_value_preserves_formula() {
        let mut log = OpLog::new();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "A2 + 1".to_owned(),
        })
        .unwrap();
        log.append(Op::ClearValue {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("A2 + 1"));
    }

    /// **F2 closure + V3.5.0.3b tombstone semantic:** replaying
    /// `ClearValue` onto a tombstoned sheet is a silent no-op (mirrors
    /// the `PutValue` / `PutFormula` / `ClearFormula` tombstone guard).
    #[test]
    fn replay_clear_value_on_tombstoned_sheet_is_silent_noop() {
        let mut log = OpLog::new();
        // Put a value, then tombstone the sheet, then try to clear it.
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(7.0),
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "S2".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
        log.append(Op::RemoveSheet { id: 0 }).unwrap();
        log.append(Op::ClearValue {
            sheet: 0,
            row: 0,
            col: 0,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        // Replay must succeed (silent no-op, not an error) ...
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 4);
        assert!(wb.is_sheet_removed(0));
        // ... and the ClearValue did NOT touch the (now-tombstoned)
        // sheet's preserved storage: the cell still reads 7.0 underneath
        // the tombstone (snapshot filtering happens at a higher layer).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
    }

    #[test]
    fn replay_set_name_registers_target() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: None,
            name: "TaxRate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.21),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(matches!(
            wb.names().lookup_ci("TaxRate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
    }

    /// **FE-5 W-N (2026-06-12):** SetName followed by RemoveName replays to a
    /// workbook with the name GONE. This is the resurrect-bug guard at the
    /// replay layer: `baseline + replay([SetName, RemoveName])` must NOT carry
    /// the name (without `RemoveName`, the lone `SetName` would resurrect it).
    #[test]
    fn replay_remove_name_clears_workbook_scoped() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: None,
            name: "SALES".to_owned(),
            target: NamedTargetWire::Range {
                sheet: 0,
                start_row: 0,
                start_col: 0,
                end_row: 9,
                end_col: 0,
            },
        })
        .unwrap();
        log.append(Op::RemoveName {
            scope: None,
            name: "SALES".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(
            wb.names().lookup_ci("SALES").is_none(),
            "RemoveName must clear the name on replay (no resurrect)"
        );
    }

    /// Sheet-scoped RemoveName clears the sheet's scoped table.
    #[test]
    fn replay_remove_name_clears_sheet_scoped() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
        log.append(Op::SetName {
            scope: Some(1),
            name: "LOCALRATE".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.05),
            },
        })
        .unwrap();
        log.append(Op::RemoveName {
            scope: Some(1),
            name: "LOCALRATE".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(
            wb.sheet(1)
                .unwrap()
                .scoped_names()
                .lookup_ci("LOCALRATE")
                .is_none(),
            "sheet-scoped RemoveName must clear the sheet's scoped name"
        );
    }

    /// RemoveName with an unknown sheet scope surfaces InvalidSheet (mirrors
    /// SetName), not a silent no-op that would mask a corrupt log.
    #[test]
    fn replay_remove_name_unknown_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::RemoveName {
            scope: Some(42),
            name: "X".to_owned(),
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::InvalidSheet { sheet: 42, .. }));
    }

    /// RemoveName of a name that was never set is idempotent (NameTable::clear
    /// no-ops a missing key) — a merged log that removes twice converges.
    #[test]
    fn replay_remove_name_idempotent_on_missing() {
        let mut log = OpLog::new();
        log.append(Op::RemoveName {
            scope: None,
            name: "GHOST".to_owned(),
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(wb.names().lookup_ci("GHOST").is_none());
    }

    #[test]
    fn replay_add_sheet_grows_workbook() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Inventory".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet_count(), 2);
        assert_eq!(wb.sheet(1).unwrap().name(), "Inventory");
    }

    #[test]
    fn replay_batch_commit_applies_inner_ops_in_order() {
        let mut log = OpLog::new();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::PutValue {
                    sheet: 0,
                    row: 0,
                    col: 0,
                    value: CellWireValue::Number(7.0),
                },
                Op::PutFormula {
                    sheet: 0,
                    row: 0,
                    col: 1,
                    text: "A1 * 2".to_owned(),
                },
            ],
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(wb.formula_at(0, 0, 1).map(|s| s.as_ref()), Some("A1 * 2"));
    }

    #[test]
    fn replay_invalid_sheet_returns_indexed_error() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();
        // Op index 1: out-of-range sheet 5.
        log.append(Op::PutValue {
            sheet: 5,
            row: 0,
            col: 0,
            value: CellWireValue::Number(2.0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        match result {
            Err(ReplayError::InvalidSheet {
                index,
                sheet,
                sheet_count,
            }) => {
                assert_eq!(index, 1);
                assert_eq!(sheet, 5);
                assert_eq!(sheet_count, 1);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
        // Op 0 DID land (partial-state semantics).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
    }

    #[test]
    fn replay_invalid_cell_row_above_max_returns_indexed_error() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 1_048_576,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        assert!(
            matches!(
                result,
                Err(ReplayError::InvalidCell {
                    index: 0,
                    row: 1_048_576,
                    ..
                })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

    #[test]
    fn replay_reserved_name_returns_name_rejected() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: None,
            name: "AI".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(42.0),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        match result {
            Err(ReplayError::NameRejected {
                index,
                name,
                source: _,
            }) => {
                assert_eq!(index, 0);
                assert_eq!(name, "AI");
            }
            other => panic!("expected NameRejected, got {other:?}"),
        }
    }

    // ===== W5-80 / Phase 4.5.D part 4 — format op tests =====

    #[test]
    fn replay_register_format_installs_custom_id() {
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            // Step 4: Op carries FormatIdWire. id=200 (>=164) maps to
            // Custom(LEGACY_PEER, 36) via from_u32_legacy.
            id: crate::FormatIdWire::from_u32_legacy(200),
            string: "\"€\" #,##0.00".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.formats()
                .lookup(ql_storage::FormatId::legacy_from_u32(200)),
            Some("\"€\" #,##0.00")
        );
    }

    #[test]
    fn replay_register_format_idempotent_for_existing_builtin() {
        // Re-registering an Excel built-in at its canonical id is a no-op
        // (pre-populated by Workbook::default). Replay must not error.
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: crate::FormatIdWire::Builtin { id: 0 },
            string: "General".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.formats().lookup(ql_storage::FormatId::Builtin(0)),
            Some("General")
        );
    }

    #[test]
    fn replay_register_format_id_collision_errors() {
        // Built-in id 0 is "General"; registering a DIFFERENT string at
        // id 0 must surface as `FormatRejected`.
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: crate::FormatIdWire::Builtin { id: 0 },
            string: "WRONG".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::FormatRejected { index, source }) => {
                assert_eq!(index, 0);
                assert!(matches!(
                    source,
                    FormatRejectedSource::IdCollision {
                        id: ql_storage::FormatId::Builtin(0),
                        ..
                    }
                ));
            }
            other => panic!("expected FormatRejected, got {other:?}"),
        }
    }

    #[test]
    fn replay_set_cell_format_binds_overlay() {
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: crate::FormatIdWire::from_u32_legacy(200),
            string: "0.000".to_owned(),
        })
        .unwrap();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 3,
            col: 5,
            id: Some(crate::FormatIdWire::from_u32_legacy(200)),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().format_overlay().get(3, 5),
            Some(ql_storage::FormatId::legacy_from_u32(200))
        );
    }

    #[test]
    fn replay_set_cell_format_with_none_clears_overlay() {
        let mut log = OpLog::new();
        log.append(Op::RegisterFormat {
            id: crate::FormatIdWire::from_u32_legacy(200),
            string: "0.000".to_owned(),
        })
        .unwrap();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 3,
            col: 5,
            id: Some(crate::FormatIdWire::from_u32_legacy(200)),
        })
        .unwrap();
        // Now clear via id=None.
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 3,
            col: 5,
            id: None,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().format_overlay().get(3, 5), None);
    }

    #[test]
    fn replay_set_cell_format_unregistered_id_errors() {
        // Op references id 999 but no RegisterFormat preceded it.
        let mut log = OpLog::new();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 0,
            col: 0,
            id: Some(crate::FormatIdWire::from_u32_legacy(999)),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::FormatNotRegistered { index, id }) => {
                assert_eq!(index, 0);
                // Step 4: id field is now FormatId, not u32.
                assert_eq!(id, ql_storage::FormatId::legacy_from_u32(999));
            }
            other => panic!("expected FormatNotRegistered, got {other:?}"),
        }
    }

    #[test]
    fn replay_set_cell_format_invalid_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::SetCellFormat {
            sheet: 99,
            row: 0,
            col: 0,
            id: Some(crate::FormatIdWire::Builtin { id: 0 }),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::InvalidSheet { sheet, .. }) => assert_eq!(sheet, 99),
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
    }

    #[test]
    fn replay_register_and_set_cell_format_built_in_id_14() {
        // Common path: cells using a built-in m/d/yyyy format don't need
        // an explicit RegisterFormat (id 14 is pre-populated). Just
        // SetCellFormat should succeed.
        let mut log = OpLog::new();
        log.append(Op::SetCellFormat {
            sheet: 0,
            row: 0,
            col: 0,
            id: Some(crate::FormatIdWire::Builtin { id: 14 }),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().format_overlay().get(0, 0),
            Some(ql_storage::FormatId::Builtin(14))
        );
    }

    // ===== FE-4 W4 — style op replay tests =====

    fn bold_style_wire() -> crate::StyleWire {
        crate::StyleWire::from_storage(ql_storage::Style {
            bold: true,
            ..ql_storage::Style::default()
        })
    }

    #[test]
    fn replay_register_and_set_cell_style_binds_overlay() {
        let sid = crate::StyleIdWire {
            peer: ql_types::LEGACY_PEER,
            counter: 0,
        };
        let mut log = OpLog::new();
        log.append(Op::RegisterStyle {
            id: sid,
            style: bold_style_wire(),
        })
        .unwrap();
        log.append(Op::SetCellStyle {
            sheet: 0,
            row: 3,
            col: 5,
            id: Some(sid),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().style_overlay().get(3, 5),
            Some(sid.to_storage())
        );
        assert_eq!(
            wb.styles().lookup(sid.to_storage()),
            Some(bold_style_wire().to_storage())
        );
    }

    #[test]
    fn replay_set_cell_style_none_clears_overlay() {
        let sid = crate::StyleIdWire {
            peer: ql_types::LEGACY_PEER,
            counter: 0,
        };
        let mut log = OpLog::new();
        log.append(Op::RegisterStyle {
            id: sid,
            style: bold_style_wire(),
        })
        .unwrap();
        log.append(Op::SetCellStyle {
            sheet: 0,
            row: 3,
            col: 5,
            id: Some(sid),
        })
        .unwrap();
        log.append(Op::SetCellStyle {
            sheet: 0,
            row: 3,
            col: 5,
            id: None,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().style_overlay().get(3, 5), None);
    }

    #[test]
    fn replay_set_cell_style_unregistered_id_errors() {
        let mut log = OpLog::new();
        log.append(Op::SetCellStyle {
            sheet: 0,
            row: 0,
            col: 0,
            id: Some(crate::StyleIdWire {
                peer: ql_types::LEGACY_PEER,
                counter: 99,
            }),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::StyleNotRegistered { index, id }) => {
                assert_eq!(index, 0);
                assert_eq!(id, ql_storage::StyleId::new(ql_types::LEGACY_PEER, 99));
            }
            other => panic!("expected StyleNotRegistered, got {other:?}"),
        }
    }

    // ===== Wave G2 (engine-filter) — SetRowsHidden replay =====

    #[test]
    fn replay_set_rows_hidden_applies_to_sheet() {
        let mut log = OpLog::new();
        log.append(Op::SetRowsHidden {
            sheet: 0,
            rows: vec![2, 4, 7],
            hidden: true,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        let hidden = wb.sheet(0).unwrap().hidden_rows();
        assert_eq!(hidden.iter().copied().collect::<Vec<_>>(), vec![2, 4, 7]);
    }

    #[test]
    fn replay_set_rows_hidden_false_shows_rows() {
        let mut log = OpLog::new();
        log.append(Op::SetRowsHidden {
            sheet: 0,
            rows: vec![2, 4],
            hidden: true,
        })
        .unwrap();
        log.append(Op::SetRowsHidden {
            sheet: 0,
            rows: vec![2],
            hidden: false,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        let hidden = wb.sheet(0).unwrap().hidden_rows();
        assert_eq!(hidden.iter().copied().collect::<Vec<_>>(), vec![4]);
    }

    #[test]
    fn replay_set_rows_hidden_row_past_max_errors_atomically() {
        let mut log = OpLog::new();
        // Second row is out of range — the whole op must abort, leaving NO
        // partial hidden set (No-Fallbacks atomicity).
        log.append(Op::SetRowsHidden {
            sheet: 0,
            rows: vec![3, MAX_ROW + 1],
            hidden: true,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::InvalidCell { index, row, .. }) => {
                assert_eq!(index, 0);
                assert_eq!(row, MAX_ROW + 1);
            }
            other => panic!("expected InvalidCell, got {other:?}"),
        }
        // The valid row 3 must NOT have been applied (atomic abort).
        assert!(wb.sheet(0).unwrap().hidden_rows().is_empty());
    }

    #[test]
    fn replay_set_rows_hidden_unknown_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::SetRowsHidden {
            sheet: 9,
            rows: vec![1],
            hidden: true,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::InvalidSheet { index, sheet, .. }) => {
                assert_eq!(index, 0);
                assert_eq!(sheet, 9);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
    }

    #[test]
    fn replay_set_rows_hidden_bad_row_errors_even_on_tombstoned_sheet() {
        // **(Codex HIGH):** a bad row must abort replay BEFORE the tombstone
        // no-op, so the op never silently no-ops on a tombstoned sheet while
        // collab's `op_statically_aborts_batch` (which rejects row > MAX_ROW
        // UNCONDITIONALLY) suppresses the batch -> no last_snapshot divergence.
        let mut log = OpLog::new();
        log.append(Op::RemoveSheet { id: 0 }).unwrap(); // tombstone sheet 0
        log.append(Op::SetRowsHidden {
            sheet: 0,
            rows: vec![MAX_ROW + 1],
            hidden: true,
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::InvalidCell { index, row, .. }) => {
                assert_eq!(index, 1, "the SetRowsHidden op (index 1) must error");
                assert_eq!(row, MAX_ROW + 1);
            }
            other => panic!("expected InvalidCell (validate before tombstone), got {other:?}"),
        }
    }

    #[test]
    fn replay_register_style_id_collision_errors() {
        let sid = crate::StyleIdWire {
            peer: ql_types::LEGACY_PEER,
            counter: 0,
        };
        let mut log = OpLog::new();
        log.append(Op::RegisterStyle {
            id: sid,
            style: bold_style_wire(),
        })
        .unwrap();
        // Re-register the SAME id with a DIFFERENT style → StyleRejected.
        log.append(Op::RegisterStyle {
            id: sid,
            style: crate::StyleWire::from_storage(ql_storage::Style {
                italic: true,
                ..ql_storage::Style::default()
            }),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        match replay_into(&log, &mut wb, &reg) {
            Err(ReplayError::StyleRejected { index, source }) => {
                assert_eq!(index, 1);
                assert!(matches!(source, StyleRejectedSource::IdCollision { .. }));
            }
            other => panic!("expected StyleRejected, got {other:?}"),
        }
    }

    #[test]
    fn replay_set_cell_style_on_tombstoned_sheet_is_noop() {
        let sid = crate::StyleIdWire {
            peer: ql_types::LEGACY_PEER,
            counter: 0,
        };
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "S2".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::RegisterStyle {
            id: sid,
            style: bold_style_wire(),
        })
        .unwrap();
        log.append(Op::RemoveSheet { id: 1 }).unwrap();
        // SetCellStyle on the tombstoned sheet 1 → silent no-op.
        log.append(Op::SetCellStyle {
            sheet: 1,
            row: 0,
            col: 0,
            id: Some(sid),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // No overlay entry written on the tombstoned sheet.
        assert_eq!(wb.sheet(1).unwrap().style_overlay().get(0, 0), None);
    }

    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====

    #[test]
    fn replay_rename_sheet_basic() {
        // AddSheet + RenameSheet replays into a sheet with the new name.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
    }

    #[test]
    fn replay_rename_sheet_already_renamed_is_noop() {
        // Replay-on-top-of-snapshot path: snapshot already has the new
        // name; replay must NOT error.
        let mut log = OpLog::new();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        wb.add_sheet("Renamed"); // snapshot already at the new name
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
    }

    /// **Phase 5.3 step 2 (2026-05-20):** test name + assertion
    /// inverted by the audit-locked CRDT policy change. Pre-step-2
    /// this asserted `SheetRenameNameMismatch` fired when the
    /// current sheet name matched neither old nor new (e.g. a
    /// snapshot whose state diverged from the op's `old_name`).
    /// Post-step-2 that case applies the rename to the current
    /// sheet ("last-in-causal-order wins" policy) — current name
    /// after replay is `new_name`.
    ///
    /// The renamed test reflects the new property: replay applies
    /// the rename even when current ≠ old_name.
    #[test]
    fn replay_rename_sheet_current_neither_old_nor_new_applies_rename() {
        // Snapshot has a name that's neither old nor new ⇒ under
        // Phase 5.3 step 2, this is the canonical concurrent-rename
        // scenario: another peer's rename already changed the sheet
        // name; this op's `old_name` is interpreted as "what the
        // peer thought was current," and replay applies the rename
        // to whatever the sheet currently is.
        let mut log = OpLog::new();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        wb.add_sheet("Something Else");
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).expect("replay must apply rename, not error");
        assert_eq!(
            wb.sheet(0).unwrap().name(),
            "Renamed",
            "Phase 5.3 step 2: 'last-in-causal-order wins' — rename applies to current sheet"
        );
    }

    #[test]
    fn replay_rename_sheet_invalid_id_errors() {
        let mut log = OpLog::new();
        log.append(Op::RenameSheet {
            id: 7,
            old_name: "Sheet1".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::InvalidSheet { .. }));
    }

    /// **Phase 5.3 step 2 audit closure (Codex+Opus HIGH-1, 2026-05-20):**
    /// test name + assertion inverted by the D-2-compatible auto-rename
    /// policy. Pre-closure this asserted `SheetRenameRejected` fired when
    /// the target name collided with another sheet. Post-closure replay
    /// auto-disambiguates via the suffix walk (`Sheet2(2)`, etc.) —
    /// mirrors D-2's AddSheet auto-rename. The merged log is no longer
    /// un-replayable; both peers' rename intents are preserved (with
    /// suffix on the second).
    #[test]
    fn replay_rename_sheet_duplicate_target_auto_disambiguates() {
        // Two sheets exist; renaming the first to the second's name must
        // succeed via auto-disambiguation (Sheet2 → Sheet2(2)).
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "Sheet2".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Sheet2".to_owned(),
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg)
            .expect("replay must auto-disambiguate, not error (post-HIGH-1 closure)");
        // Sheet 0 was renamed; "Sheet2" was already taken by sheet 1, so
        // auto-rename suffixes to "Sheet2(2)".
        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet2(2)");
        assert_eq!(wb.sheet(1).unwrap().name(), "Sheet2");
    }

    #[test]
    fn replay_rename_inside_batchcommit() {
        // Producer pattern: rewrite-then-rename batched as a single
        // BatchCommit. Verify the batch replays atomically.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "S2".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::PutFormula {
            sheet: 1, // S2!A1
            row: 0,
            col: 0,
            text: "S1!A1 + 1".to_owned(),
        })
        .unwrap();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::PutFormula {
                    sheet: 1,
                    row: 0,
                    col: 0,
                    text: "SX!A1 + 1".to_owned(),
                },
                Op::RenameSheet {
                    id: 0,
                    old_name: "S1".to_owned(),
                    new_name: "SX".to_owned(),
                },
            ],
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet(0).unwrap().name(), "SX");
        assert_eq!(
            wb.formula_at(1, 0, 0).map(|s| s.as_ref().to_owned()),
            Some("SX!A1 + 1".to_owned())
        );
    }

    // ===== W5-92 (Phase 4.6.D) Op::SetName scoped variant =====

    #[test]
    fn replay_set_name_sheet_scoped_lands_on_sheet() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 1024,
        })
        .unwrap();
        log.append(Op::SetName {
            scope: Some(0),
            name: "Rate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.21),
            },
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // Sheet-scoped name present on sheet 0.
        assert!(matches!(
            wb.sheet(0).unwrap().scoped_names().lookup_ci("Rate"),
            Some(ql_storage::NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        // Workbook-scoped table is empty (sheet-scoped doesn't bleed up).
        assert!(wb.names().is_empty());
    }

    #[test]
    fn replay_set_name_scope_none_lands_on_workbook() {
        // Backwards-compat: scope: None (the v3+old wire shape) still
        // routes to the workbook scope, matching the historical behavior.
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: None,
            name: "Rate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.10),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(matches!(
            wb.names().lookup_ci("Rate"),
            Some(ql_storage::NamedTarget::Constant(Value::Number(n))) if n == 0.10
        ));
        // Sheet 0 has no scoped entry.
        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
    }

    #[test]
    fn replay_set_name_scope_unknown_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: Some(7),
            name: "X".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(1.0),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::InvalidSheet { sheet: 7, .. }),
            "expected InvalidSheet, got {err:?}"
        );
    }

    #[test]
    fn replay_set_name_scope_reserved_name_rejected() {
        // The reserved-name guard fires on the sheet-scoped path too.
        let mut log = OpLog::new();
        log.append(Op::SetName {
            scope: Some(0),
            name: "AI".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(42.0),
            },
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(
            matches!(err, ReplayError::NameRejected { .. }),
            "expected NameRejected, got {err:?}"
        );
    }

    // ===== W5-93 (Phase 4.6.E closure) Op::AddSheet name validation =====

    #[test]
    fn replay_add_sheet_canonical_duplicate_auto_renames() {
        // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename replaces
        // the pre-D-2 behavior of rejecting duplicate-canonical names
        // at replay. Phase 5 collaboration scenario: peer A and peer B
        // both call `add_sheet("Sheet1")` locally with no collision
        // visible at producer time; both append the op; merged log
        // has both. Per the Google Sheets / Excel Online pattern, the
        // second auto-renames to `Sheet1(2)` rather than rejecting.
        //
        // Pre-D-2 this test was `replay_add_sheet_canonical_duplicate_rejected`
        // asserting `ReplayError::SheetNameRejected`. The D-2 spec
        // (5.1 audit Opus H-3) inverted that expectation.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "SHEET1".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).expect("auto-rename succeeds");
        assert_eq!(wb.sheet_count(), 2);
        // First sheet keeps its name.
        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet1");
        // Second sheet auto-renamed (original was "SHEET1" which is
        // a canonical-duplicate of "Sheet1"; suffix starts at (2)).
        assert_eq!(wb.sheet(1).unwrap().name(), "SHEET1(2)");
    }

    #[test]
    fn replay_add_sheet_auto_rename_walks_suffix_until_free() {
        // Three peers concurrently add "Sheet1"; replay should
        // produce Sheet1, Sheet1(2), Sheet1(3).
        let mut log = OpLog::new();
        for _ in 0..3 {
            log.append(Op::AddSheet {
                name: "Sheet1".to_owned(),
                chunk_rows: 16,
            })
            .unwrap();
        }

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet_count(), 3);
        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet1");
        assert_eq!(wb.sheet(1).unwrap().name(), "Sheet1(2)");
        assert_eq!(wb.sheet(2).unwrap().name(), "Sheet1(3)");
    }

    #[test]
    fn replay_add_sheet_auto_rename_skips_already_taken_suffix() {
        // Pre-existing "Sheet1(2)" forces the second AddSheet("Sheet1")
        // to skip to (3). Verifies the loop genuinely walks until
        // it finds a free slot.
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "Sheet1(2)".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();
        log.append(Op::AddSheet {
            name: "Sheet1".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.sheet_count(), 3);
        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet1");
        assert_eq!(wb.sheet(1).unwrap().name(), "Sheet1(2)");
        assert_eq!(
            wb.sheet(2).unwrap().name(),
            "Sheet1(3)",
            "auto-rename must skip already-taken (2) and land on (3)"
        );
    }

    #[test]
    fn replay_add_sheet_reserved_char_rejected() {
        let mut log = OpLog::new();
        log.append(Op::AddSheet {
            name: "Bad?Sheet".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();

        let mut wb = Workbook::new();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::SheetNameRejected { .. }));
    }

    // ===================================================================
    // W5-146 (Phase 4.9.J) — SetReferenceMode + SetLocale replay tests.
    // ===================================================================

    #[test]
    fn replay_set_reference_mode_applies_to_workbook() {
        let mut log = OpLog::new();
        log.append(Op::SetReferenceMode {
            mode: crate::op::ReferenceModeWire::R1C1,
        })
        .unwrap();
        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::R1C1);
    }

    #[test]
    fn replay_set_locale_applies_to_workbook() {
        let mut log = OpLog::new();
        log.append(Op::SetLocale {
            locale: crate::op::LocaleWire::De,
        })
        .unwrap();
        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.locale(), ql_types::Locale::De);
    }

    /// **Unknown locale wire value (forward-compat) → loud error.**
    /// Closes Sonnet L-10. The `LocaleWire` deserializer captures
    /// unknown strings into `Unknown(s)`; replay surfaces them as
    /// `ReplayError::UnknownLocale { index, found }`.
    #[test]
    fn replay_set_locale_unknown_value_errors_loudly() {
        let mut log = OpLog::new();
        log.append(Op::SetLocale {
            locale: crate::op::LocaleWire::Unknown("xx".to_string()),
        })
        .unwrap();
        let mut wb = Workbook::new();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        match err {
            ReplayError::UnknownLocale { index, found } => {
                assert_eq!(index, 0);
                assert_eq!(found, "xx");
            }
            other => panic!("expected UnknownLocale, got {other:?}"),
        }
    }

    /// **W5-151 (Phase 4.9.O MEDIUM-2 closure):** unknown
    /// reference-mode wire value (forward-compat) → loud error.
    /// Mirrors the locale path; pins design § 4.9.J's promised
    /// `ReplayError::UnknownReferenceMode`.
    #[test]
    fn replay_set_reference_mode_unknown_value_errors_loudly() {
        let mut log = OpLog::new();
        log.append(Op::SetReferenceMode {
            mode: crate::op::ReferenceModeWire::Unknown("Mixed".to_string()),
        })
        .unwrap();
        let mut wb = Workbook::new();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        match err {
            ReplayError::UnknownReferenceMode { index, found } => {
                assert_eq!(index, 0);
                assert_eq!(found, "Mixed");
            }
            other => panic!("expected UnknownReferenceMode, got {other:?}"),
        }
    }

    // ========================================================================
    // W3 (insert/delete rows & columns) — op replay.
    // ========================================================================

    #[test]
    fn replay_insert_rows_shifts_value() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 4,
            col: 0,
            value: CellWireValue::Number(7.0),
        })
        .unwrap();
        log.append(Op::InsertRows {
            sheet: 0,
            at: 0,
            count: 2,
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let n = replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(n, 2);
        // A5 (row 4) → A7 (row 6).
        assert_eq!(wb.read(Address::new(0, 6, 0)), Value::Number(7.0));
        assert_eq!(wb.read(Address::new(0, 4, 0)), Value::Blank);
    }

    #[test]
    fn replay_delete_rows_removes_and_shifts() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 1,
            col: 0,
            value: CellWireValue::Number(2.0),
        })
        .unwrap();
        log.append(Op::PutValue {
            sheet: 0,
            row: 4,
            col: 0,
            value: CellWireValue::Number(5.0),
        })
        .unwrap();
        log.append(Op::DeleteRows {
            sheet: 0,
            start: 1,
            end: 2,
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Blank); // A2 gone
        assert_eq!(wb.read(Address::new(0, 2, 0)), Value::Number(5.0)); // A5 → A3
    }

    #[test]
    fn replay_batchcommit_shifts_keys_then_rewrites_text() {
        // The producer model: BatchCommit { [InsertRows, PutFormula(new pos,
        // rewritten text)] }. After replay the formula lives at the shifted
        // KEY with the rewritten TEXT.
        let mut log = OpLog::new();
        log.append(Op::PutFormula {
            sheet: 0,
            row: 4,
            col: 0,
            text: "=A1".to_owned(),
        })
        .unwrap();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::InsertRows {
                    sheet: 0,
                    at: 0,
                    count: 1,
                },
                // Formula at A5 → A6, text unchanged here (=A1 doesn't move
                // because row 0 < insert point... but the POSITION shifted).
                Op::PutFormula {
                    sheet: 0,
                    row: 5,
                    col: 0,
                    text: "=A1".to_owned(),
                },
            ],
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // Formula now at the shifted position A6 (row 5).
        assert_eq!(wb.formula_at(0, 5, 0).map(|s| s.as_ref()), Some("=A1"));
        assert!(wb.formula_at(0, 4, 0).is_none());
    }

    // ===== MED-1 (megaudit, Codex): BatchCommit replay is rollback-atomic =====

    #[test]
    fn structural_batchcommit_half_failure_leaves_no_mutation() {
        // A batch whose FIRST op is a valid structural InsertRows and whose
        // SECOND op fails (PutValue on an out-of-range sheet). Pre-fix the
        // InsertRows would already have shifted storage when the second op
        // failed → half-applied structural edit. Post-fix: the whole batch is
        // staged on a clone; the failure leaves the workbook UNCHANGED.
        let mut log = OpLog::new();
        // A value at A1 so we can detect whether the insert shifted it.
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::InsertRows {
                    sheet: 0,
                    at: 0,
                    count: 1,
                },
                // Out-of-range sheet → ReplayError::InvalidSheet mid-batch.
                Op::PutValue {
                    sheet: 9,
                    row: 0,
                    col: 0,
                    value: CellWireValue::Number(1.0),
                },
            ],
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        assert!(
            matches!(result, Err(ReplayError::InvalidSheet { .. })),
            "expected the batch's second inner op to fail, got {result:?}"
        );
        // The InsertRows must NOT have taken effect: A1 stays at row 0 (no
        // shift to row 1), proving no half-applied structural edit.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(42.0));
        assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Blank);
    }

    #[test]
    fn cell_batchcommit_half_failure_leaves_no_torn_state() {
        // Broader coverage: a non-structural batch that half-fails also leaves
        // no torn cell state. First op writes A1; second op fails on a bad
        // sheet → the A1 write inside the batch is rolled back.
        let mut log = OpLog::new();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::PutValue {
                    sheet: 0,
                    row: 0,
                    col: 0,
                    value: CellWireValue::Number(5.0),
                },
                Op::PutValue {
                    sheet: 9, // invalid → fail
                    row: 0,
                    col: 0,
                    value: CellWireValue::Number(6.0),
                },
            ],
        })
        .unwrap();

        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let result = replay_into(&log, &mut wb, &reg);
        assert!(matches!(result, Err(ReplayError::InvalidSheet { .. })));
        // The in-batch A1 write must have been rolled back (clone discarded).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    #[test]
    fn successful_batchcommit_still_commits_atomically() {
        // Regression guard: a batch where ALL inner ops succeed still applies
        // (the clone is swapped in).
        let mut log = OpLog::new();
        log.append(Op::BatchCommit {
            ops: vec![
                Op::PutValue {
                    sheet: 0,
                    row: 0,
                    col: 0,
                    value: CellWireValue::Number(1.0),
                },
                Op::PutValue {
                    sheet: 0,
                    row: 1,
                    col: 0,
                    value: CellWireValue::Number(2.0),
                },
            ],
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Number(2.0));
    }

    // ===== Tier C2 (Phase 4 v2 backlog): BatchCommit replay depth guard =====
    //
    // These call `apply_op` DIRECTLY with a hand-built (non-serde) Op tree.
    // That is the only way to reach the guard: the public `replay_into` path
    // deserializes each op via `serde_json` (`OpLog::iter`), whose own
    // recursion limit rejects deeply-nested batches first (each `BatchCommit`
    // is several JSON levels). The guard is the defense-in-depth backstop for
    // non-serde callers / a future deserializer with a higher cap — exactly
    // C2's "don't rely on serde's default" intent. (`replay_into`'s end-to-end
    // loudness on deep input is covered in `tests/replay_depth_guard.rs`.)

    /// `BatchCommit{[BatchCommit{[ … PutValue(A1=1) … ]}]}` nested `depth`
    /// levels deep, built ITERATIVELY so constructing it never recurses.
    fn nest_batch(depth: usize) -> Op {
        let mut op = Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        };
        for _ in 0..depth {
            op = Op::BatchCommit { ops: vec![op] };
        }
        op
    }

    /// Run `apply_op` on a `nest_batch(depth)` tree on a generous-stack worker
    /// thread, so the at-limit OK case exercises the guard logic without the
    /// test harness's own default stack being the variable under test (the
    /// guard bounds live recursion regardless). The deep tree is dropped inside
    /// the worker too, so its recursive `Drop` is also off the harness stack.
    fn apply_nested_batch(depth: usize) -> Result<Workbook, ReplayError> {
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(move || {
                let mut wb = fresh_workbook_with_one_sheet();
                apply_op(&nest_batch(depth), &mut wb, 0, 0).map(|()| wb)
            })
            .expect("spawn worker thread")
            .join()
            .expect("worker thread panicked / overflowed its stack")
    }

    #[test]
    fn apply_op_allows_batch_at_max_depth() {
        // Nesting exactly to the cap reaches the innermost PutValue at recursion
        // depth == MAX (rejection is strictly `depth > MAX`), so it applies.
        let wb = apply_nested_batch(MAX_REPLAY_BATCH_DEPTH as usize)
            .expect("batch nested exactly at the cap should apply");
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
    }

    #[test]
    fn apply_op_rejects_batch_one_over_max_depth() {
        let err = apply_nested_batch(MAX_REPLAY_BATCH_DEPTH as usize + 1)
            .expect_err("batch nested one past the cap must be rejected");
        match err {
            ReplayError::BatchDepthExceeded { depth, max, .. } => {
                assert_eq!(max, MAX_REPLAY_BATCH_DEPTH);
                assert!(
                    depth > max,
                    "reported depth {depth} should exceed max {max}"
                );
            }
            other => panic!("expected BatchDepthExceeded, got {other:?}"),
        }
    }

    #[test]
    fn apply_op_rejects_pathologically_deep_batch() {
        // Far past the cap: the guard bails after ~MAX frames and returns a
        // typed error instead of recursing the full depth. Returning at all
        // (no abort) is the regression.
        let err = apply_nested_batch(2_000).expect_err("deep batch must be rejected");
        assert!(
            matches!(err, ReplayError::BatchDepthExceeded { .. }),
            "expected BatchDepthExceeded, got {err:?}"
        );
    }

    #[test]
    fn batch_depth_guard_error_leaves_workbook_untouched() {
        // Rollback atomicity under the BatchDepthExceeded path: a too-deep
        // batch wraps a PutValue; the guard fires before any inner op applies,
        // and every staged clone is discarded on the `?` unwind. So a
        // pre-seeded cell is unchanged AND the would-be-written cell stays
        // blank. (Audit Lane B LOW: close the coverage gap for the guard error
        // path specifically — distinct from the existing InvalidSheet
        // half-failure rollback tests.)
        let (a1, b1) = std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let mut wb = fresh_workbook_with_one_sheet();
                // Pre-seed A1 directly (depth 0, applies).
                apply_op(
                    &Op::PutValue {
                        sheet: 0,
                        row: 0,
                        col: 0,
                        value: CellWireValue::Number(7.0),
                    },
                    &mut wb,
                    0,
                    0,
                )
                .expect("pre-seed A1");
                // A too-deep batch whose innermost op would write B1.
                let mut deep = Op::PutValue {
                    sheet: 0,
                    row: 0,
                    col: 1,
                    value: CellWireValue::Number(9.0),
                };
                for _ in 0..(MAX_REPLAY_BATCH_DEPTH as usize + 1) {
                    deep = Op::BatchCommit { ops: vec![deep] };
                }
                let err =
                    apply_op(&deep, &mut wb, 0, 0).expect_err("too-deep batch must be rejected");
                assert!(
                    matches!(err, ReplayError::BatchDepthExceeded { .. }),
                    "expected BatchDepthExceeded, got {err:?}"
                );
                (
                    wb.read(Address::new(0, 0, 0)),
                    wb.read(Address::new(0, 0, 1)),
                )
            })
            .expect("spawn worker thread")
            .join()
            .expect("worker thread panicked / overflowed its stack");
        assert_eq!(a1, Value::Number(7.0), "pre-seeded A1 must be unchanged");
        assert_eq!(b1, Value::Blank, "B1 must never have been written");
    }

    #[test]
    fn replay_insert_columns_shifts() {
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 1,
            value: CellWireValue::Number(9.0),
        })
        .unwrap();
        log.append(Op::InsertColumns {
            sheet: 0,
            at: 0,
            count: 1,
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        replay_into(&log, &mut wb, &reg).unwrap();
        // B1 (col 1) → C1 (col 2).
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(9.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Blank);
    }

    #[test]
    fn replay_structural_on_invalid_sheet_errors() {
        let mut log = OpLog::new();
        log.append(Op::InsertRows {
            sheet: 9,
            at: 0,
            count: 1,
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
        assert!(matches!(err, ReplayError::InvalidSheet { .. }));
    }

    #[test]
    fn replay_insert_rows_is_undo_idempotent_via_rebuild() {
        // Undo round-trip: a log WITHOUT the structural op rebuilds to the
        // pre-insert state; replaying the SAME log twice into fresh workbooks
        // is identical (deterministic).
        let mut log = OpLog::new();
        log.append(Op::PutValue {
            sheet: 0,
            row: 3,
            col: 0,
            value: CellWireValue::Number(11.0),
        })
        .unwrap();
        log.append(Op::InsertRows {
            sheet: 0,
            at: 0,
            count: 1,
        })
        .unwrap();
        let reg = default_registry();
        let mut wb1 = fresh_workbook_with_one_sheet();
        replay_into(&log, &mut wb1, &reg).unwrap();
        let mut wb2 = fresh_workbook_with_one_sheet();
        replay_into(&log, &mut wb2, &reg).unwrap();
        // Same value position in both (deterministic replay).
        assert_eq!(wb1.read(Address::new(0, 4, 0)), Value::Number(11.0));
        assert_eq!(wb2.read(Address::new(0, 4, 0)), Value::Number(11.0));
    }

    #[test]
    fn replay_structural_on_tombstoned_sheet_is_noop() {
        let mut log = OpLog::new();
        // Add a second sheet so removing sheet 1 leaves sheet 0 intact.
        log.append(Op::AddSheet {
            name: "S2".to_owned(),
            chunk_rows: 16,
        })
        .unwrap();
        log.append(Op::RemoveSheet { id: 1 }).unwrap();
        log.append(Op::InsertRows {
            sheet: 1,
            at: 0,
            count: 5,
        })
        .unwrap();
        let mut wb = fresh_workbook_with_one_sheet();
        let reg = default_registry();
        // No error: the structural edit on a tombstoned sheet is a silent no-op.
        replay_into(&log, &mut wb, &reg).unwrap();
        assert!(wb.is_sheet_removed(1));
    }
}
