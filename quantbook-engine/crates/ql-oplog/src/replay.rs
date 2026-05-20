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

    /// **W5-118 (Phase 4.8.H):** `DropTable` op references a missing
    /// table. Surfaces snapshot-vs-replay divergence loudly per
    /// no-fallbacks doctrine.
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

/// Replay every op in `log` against `workbook` in append order.
///
/// Returns the total count of ops applied on success. On failure, the
/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
/// the caller how far replay got.
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
        apply_op(&op, workbook, index)?;
        count += 1;
    }
    Ok(count)
}

/// Recursive helper. `index` is the op's position in the outer log (or
/// the synthetic position of the enclosing BatchCommit for nested ops —
/// 2A.3.a flattens by reporting the parent's index for nested failures).
fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
    match op {
        Op::PutValue {
            sheet,
            row,
            col,
            value,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            let v: Value = value
                .to_value()
                .map_err(|source| ReplayError::ValueDecode { index, source })?;
            workbook.put_at(*sheet, *row, *col, v);
            Ok(())
        }
        Op::PutFormula {
            sheet,
            row,
            col,
            text,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            workbook.put_formula(*sheet, *row, *col, text.as_str());
            Ok(())
        }
        Op::ClearFormula { sheet, row, col } => {
            // clear_formula is idempotent on missing entries; we still
            // validate bounds so a corrupted op-log can't sneak past.
            validate_cell(workbook, *sheet, *row, *col, index)?;
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
        Op::BatchCommit { ops } => {
            for inner_op in ops {
                // Phase 2A.3.a: nested ops flatten to the parent's index
                // for error reporting. Phase 5+ may extend with
                // (outer, inner) tuple indexing once the producer side
                // emits nested commits in practice.
                apply_op(inner_op, workbook, index)?;
            }
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
            let canonical = name.to_ascii_uppercase();
            if workbook.tables_mut().remove(canonical.as_str()).is_none() {
                return Err(ReplayError::TableNotFound {
                    index,
                    name: name.clone(),
                });
            }
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
    }
}

/// **W5-119 (Phase 4.8.I):** replay a `RenameTable`. Validates source
/// exists, target name is available (TableTable + NameTable shared
/// namespace), then re-keys the entry. Note: formula text rewrites
/// arrive as accompanying `Op::PutFormula` ops; this arm doesn't
/// touch formula cells.
fn apply_rename_table(
    workbook: &mut Workbook,
    index: usize,
    old_name: &str,
    new_name: &str,
) -> Result<(), ReplayError> {
    let old_canonical = old_name.to_ascii_uppercase();
    let new_canonical: std::sync::Arc<str> =
        std::sync::Arc::from(new_name.to_ascii_uppercase().as_str());

    // Verify source.
    if workbook.tables().lookup(&old_canonical).is_none() {
        return Err(ReplayError::TableNotFound {
            index,
            name: old_name.to_owned(),
        });
    }
    // Verify target availability (skip the no-op same-name case).
    if !old_canonical.eq_ignore_ascii_case(new_name) {
        if workbook.tables().lookup(&new_canonical).is_some() {
            return Err(ReplayError::TableCreateRejected {
                index,
                name: new_name.to_owned(),
                reason: "table with this canonical name already exists (rename target)",
            });
        }
        if workbook.names().lookup_ci(&new_canonical).is_some() {
            return Err(ReplayError::TableCreateRejected {
                index,
                name: new_name.to_owned(),
                reason: "defined-name with this canonical name already exists (rename target)",
            });
        }
    }
    // Take the entry out, mutate name + display, reinsert under new key.
    let mut meta = workbook
        .tables_mut()
        .remove(&old_canonical)
        .expect("verified above");
    meta.name = std::sync::Arc::clone(&new_canonical);
    meta.display_name = std::sync::Arc::from(new_name);
    workbook.tables_mut().insert(new_canonical, meta);
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
    let meta = workbook
        .tables_mut()
        .get_mut(&table_canonical)
        .ok_or_else(|| ReplayError::TableNotFound {
            index,
            name: table.to_owned(),
        })?;
    let (col_idx, _) =
        meta.lookup_column(old_name)
            .ok_or_else(|| ReplayError::TableColumnNotFound {
                index,
                table: table.to_owned(),
                column: old_name.to_owned(),
            })?;
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
}
