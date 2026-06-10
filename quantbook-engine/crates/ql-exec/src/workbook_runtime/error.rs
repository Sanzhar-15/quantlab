//! `WorkbookRuntime` error + result types.
//!
//! Extracted from `workbook_runtime.rs` as **Tier D1 Step 1** per
//! `docs/architecture/workbook-runtime-split-design.md`. Contains:
//! - [`RuntimeError`] — top-level error enum for the runtime pipeline.
//! - [`RecomputeFailure`] — per-cell structural failure during a
//!   recompute pass.
//! - [`RecomputeResult`] — aggregate outcome of `recompute_all` /
//!   `recompute_dirty`.
//!
//! No behavior changes — pure code move. The types remain in the
//! `crate::workbook_runtime` module path via `pub use` in
//! `crate::workbook_runtime::mod` so all existing callers compile
//! unchanged.

use std::sync::Arc;

use ql_formula_syntax::{LexError, ParseError, PrintError};
use ql_types::{ColId, RowId, SheetId};

use crate::plan::BindError;

/// Errors from the runtime pipeline. Each upstream stage's error wraps cleanly.
/// Phase 2A.6 audit H1/L4 (2026-05-12) added `InvalidSheet` so callers that pass
/// a sheet id outside the workbook's range get a clean error instead of a panic
/// from `Workbook::put_at`. Phase 2A.6 audit H4 added `ConflictingOps` for
/// the `WorkbookTransaction` mixed-kind-on-same-cell case.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RuntimeError {
    // Phase 2A.11 audit M16: switched from `{0:?}` debug formatters to `{0}`
    // Display now that LexError + BindError implement thiserror::Error with
    // user-facing strings. IDE error display reads cleanly: "lex error:
    // unexpected character: '@'" instead of "lex error: UnexpectedChar('@')".
    #[error("lex error: {0}")]
    Lex(LexError),

    #[error("parse error: {0}")]
    Parse(#[from] ParseError),

    /// **W5-147 (Phase 4.9.K):** the canonicalize step of `set_formula`
    /// (per design § 4.4) failed. This happens when the parsed AST
    /// contains an intermediate `Expr::R1C1Ref` with a relative axis
    /// that the printer can't resolve, or a malformed R1C1 axis. In
    /// practice the bind site always has a cell anchor, so the only
    /// reachable case is a hand-built AST with `AxisSpec::Abs(0)` —
    /// effectively impossible from `set_formula` since the lexer
    /// already rejects it as `MalformedR1C1`. Kept as a typed error
    /// for defense-in-depth.
    #[error("print error: {0}")]
    Print(#[from] PrintError),

    #[error("bind error: {0}")]
    Bind(BindError),

    #[error("invalid sheet {sheet}: workbook has {sheet_count} sheets")]
    InvalidSheet { sheet: SheetId, sheet_count: usize },

    /// Phase 2A.7 audit H1: row/col outside the Excel grid (MAX_ROW = 1,048,575;
    /// MAX_COLUMN = 16,383). Surfaces at buffer time so `Sheet::put` doesn't
    /// panic mid-commit. `why` describes which bound was exceeded.
    #[error("invalid cell (sheet={sheet}, row={row}, col={col}): {why}")]
    InvalidCell {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        why: &'static str,
    },

    #[error(
        "conflicting transaction ops on cell (sheet={sheet}, row={row}, col={col}): \
         a value and a formula were both buffered for this cell in the same transaction"
    )]
    ConflictingOps {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Phase 2A.3.b (2026-05-12): the producer-side append into an attached
    /// op log failed (serde_json refused the wire value — e.g. NaN/Inf — or
    /// Loro surfaced an internal error). Producer order is append-then-mutate:
    /// when this fires, the workbook is unchanged. Callers attaching an op
    /// log handle the error; callers that don't attach one never see this
    /// variant.
    #[error("op log error: {0}")]
    OpLog(#[from] ql_oplog::OpLogError),

    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
    /// the name in the workbook's `NameTable`. Currently the only
    /// `NameTableError` variant is `Reserved` (per CORR-06 the `AI` name is
    /// engine-reserved); see `ql_storage::NameTableError` for additional
    /// variants when they land.
    #[error("name table error: {0}")]
    Name(#[from] ql_storage::NameTableError),

    /// **W5-91 (Phase 4.6.C):** sheet-name validation refused — empty
    /// string, Excel-reserved character, or canonical duplicate.
    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
    /// `add_sheet` variants that validate).
    #[error("sheet name rejected: {0}")]
    SheetName(#[from] ql_storage::SheetNameError),

    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
    /// called with `chunk_rows == 0`. `Sheet::with_chunk_rows` accepts it
    /// silently, then the first cell write panics deep inside the column
    /// store. Pre-validating at the runtime entry refuses the value cleanly
    /// before any op-log append, so a bad input can't poison a workbook.
    #[error("invalid chunk_rows {0}: must be > 0 (engine default is 16384)")]
    InvalidChunkRows(u32),

    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
    /// called with the workbook already at `SheetId::MAX` (65,535) sheets.
    /// `Workbook::add_sheet_with_chunk_rows` panics in that case; the
    /// runtime now refuses before any op-log append.
    #[error("workbook has {current} sheets; cannot add another (limit {max})")]
    TooManySheets { current: u32, max: u32 },

    /// **W5-82 (Phase 4.5.D part 6):** `set_cell_format` was called with
    /// `Some(FormatId)` referencing an id that hasn't been registered
    /// in the workbook's `FormatTable`. Producer-side enforcement of the
    /// "RegisterFormat before SetCellFormat" ordering; mirrors replay's
    /// `FormatNotRegistered`. Callers should obtain the id via
    /// `intern_format` (which handles registration automatically).
    ///
    /// Phase 5.2 D-1 step 3: payload changed from `u32` to
    /// `ql_storage::FormatId` (tagged tuple) — error messages now
    /// distinguish `Builtin(n)` from `Custom(peer, counter)` rather
    /// than only carrying the legacy u32.
    #[error("format id {0:?} is not registered in the workbook FormatTable")]
    UnknownFormatId(ql_storage::FormatId),

    /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B LOW-2,
    /// 2026-05-20):** `WorkbookRuntime::intern_format` was called when
    /// the local peer's custom-format counter is at `u32::MAX`.
    /// Allocating one more Custom id would overflow. Pre-closure the
    /// overflow panicked AFTER `Op::RegisterFormat` was already written
    /// to the local log — log got an op that local replay couldn't
    /// reproduce. Post-closure: refuse before the op is appended.
    ///
    /// Reachability is implausible (~4.3B per-peer custom formats),
    /// but matches the step-5 audit's pre-validation discipline.
    #[error("format counter for peer {peer:?} is exhausted (u32::MAX per-peer custom formats)")]
    FormatCounterExhausted { peer: ql_types::PeerId },

    /// **FE-4 W4 (2026-06-10):** `WorkbookRuntime::set_cell_style` was given a
    /// `StyleId` that isn't registered in the workbook's `StyleTable`. Mirrors
    /// [`Self::UnknownFormatId`]: producer-side enforcement so an op log that
    /// reaches the wire is well-formed (replay does the same check).
    #[error("style id {0:?} is not registered in the workbook StyleTable")]
    UnknownStyleId(ql_storage::StyleId),

    /// **FE-4 W4 (2026-06-10):** `WorkbookRuntime::intern_style` was called when
    /// the local peer's style counter is at `u32::MAX`. Mirrors
    /// [`Self::FormatCounterExhausted`] — refuse before the op is appended.
    #[error("style counter for peer {peer:?} is exhausted (u32::MAX per-peer styles)")]
    StyleCounterExhausted { peer: ql_types::PeerId },

    /// **W5-106-AUDIT (Codex MEDIUM closure):** recompute_dirty's
    /// fixed-point loop hit its MAX_ITERATIONS bound with cells still
    /// dirty. Signals a runaway spill shape transition or workbook
    /// misconfiguration; the recompute result is partial.
    #[error("recompute_dirty hit iteration cap with cells still dirty")]
    RecomputeIterationCap,

    /// **W5-118 (Phase 4.8.H):** `create_table` was rejected by a
    /// validation rule. `reason` is a static string describing which
    /// invariant fired (uniqueness, overlap, empty column name, ...).
    #[error("table {name:?} create rejected: {reason}")]
    TableCreateRejected { name: String, reason: &'static str },

    /// **W5-118 (Phase 4.8.H):** `drop_table` was called on a name
    /// that doesn't exist.
    #[error("table {0:?} not found")]
    TableNotFound(String),

    /// **W5-121 (Phase 4.8.I.2):** `rename_column` referenced a column
    /// name (case-insensitive) that does not exist in the target table.
    #[error("table {table:?} has no column {column:?}")]
    TableColumnNotFound { table: String, column: String },

    /// **W5-121 (Phase 4.8.I.2):** `rename_column` was rejected by a
    /// validation rule (target column name already in the table, empty,
    /// etc.). `reason` is a static string describing which invariant
    /// fired.
    #[error("table {table:?} column {column:?} rejected: {reason}")]
    TableColumnRejected {
        table: String,
        column: String,
        reason: &'static str,
    },

    /// **W5-122 (Phase 4.8.J):** `resize_table` was rejected by a
    /// validation rule (zero dims, arithmetic mismatch, trailing-
    /// columns mismatch, column-name collision, footprint overlap,
    /// etc.). `reason` is a static string describing which invariant
    /// fired.
    #[error("table {name:?} resize rejected: {reason}")]
    TableResizeRejected { name: String, reason: &'static str },
}

impl From<LexError> for RuntimeError {
    fn from(e: LexError) -> Self {
        Self::Lex(e)
    }
}

impl From<BindError> for RuntimeError {
    fn from(e: BindError) -> Self {
        Self::Bind(e)
    }
}

/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
///
/// Phase 2B.2 (2026-05-12): part of the [`RecomputeResult`] aggregation
/// replacing the prior short-circuit `Result<usize, RuntimeError>` return
/// shape. Captures everything a caller needs to display the failure
/// without re-walking the workbook: the cell address, the formula text
/// that was tried, and the structural error from lex/parse/bind.
///
/// Evaluation-time errors that surface as `Value::Error(...)` (e.g. `=10/0`
/// → `#DIV/0!`) do NOT appear here — those are normal cell values per
/// Excel canon and get written to the workbook like any other recompute
/// success. `RecomputeFailure` is reserved for STRUCTURAL failures where
/// the formula cannot be evaluated at all.
///
/// Not `Clone` — `RuntimeError` contains `loro::LoroError` (via the
/// Phase 2A.3.b `OpLog` variant) which is not Clone. Pass by ownership
/// or borrow.
#[derive(Debug)]
pub struct RecomputeFailure {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
    pub formula_text: Arc<str>,
    pub error: RuntimeError,
}

/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
///
/// Phase 2B.2 (2026-05-12): replaces the prior `Result<usize, RuntimeError>`
/// return shape. The previous signature short-circuited on first failure,
/// dropping per-cell context and forcing callers to re-walk the workbook
/// to find what went wrong. The new shape:
///
/// - `attempted` — total formula cells in the workbook snapshot at start.
/// - `succeeded` — formulas that lex/parse/bind/eval'd cleanly and were
///   written back to the workbook.
/// - `failures` — every formula that failed structurally, in iteration
///   order. Each entry carries cell address + formula text + error.
///
/// "Is this workbook now consistent?" is exposed via `is_complete()`
/// (= `failures.is_empty()`); see `failed_count()` for the count.
/// Phase 2B.7 audit (correctness M2) dropped a redundant `partial_state`
/// `pub` field that mirrored `!is_complete()` — having two sources of
/// truth created a soundness footgun (external constructors could lie).
///
/// No-fallback semantics: failures are NOT swallowed. The struct makes
/// every failure visible and aggregable. Callers that want short-circuit
/// semantics can check `is_complete()` and bail.
///
/// Cells past a failure point keep their pre-recompute (potentially stale)
/// values; their formula text is preserved either way (recompute never
/// clears formula on failure). Iteration order is `HashMap`-arbitrary
/// today (GAP-R-01); Engine Phase 3 calcgraph integration makes it
/// topological.
///
/// Not `Clone` for the same reason as `RecomputeFailure`.
///
/// Phase 3.8 (W5-41, 2026-05-12) adds the `skipped_value_equality` field
/// — VEQ-3-03's "profile records skipped downstream vertices." A dirty
/// formula whose direct cell deps all stayed at their prior values, and
/// which has no range deps or volatile flag, is skipped entirely during
/// `recompute_dirty`. The counter is `0` for `recompute_all` (which
/// always processes every formula in HashMap order — no VEQ logic).
///
/// Phase 3.9 (W5-42, 2026-05-12) adds `simd_classified` — SIMD-3-03's
/// "graph profile shows region execution." Counts how many of the dirty
/// formulas had plans that `lower::classify` says are SIMD-eligible
/// (`SimdShape != NotApplicable`). V1 of Phase 3.9 doesn't yet batch
/// these into bulk Arrow kernel calls (that's the Phase 4.7+ array-
/// formula / FormulaRegion binder work); the count is the observability
/// surface that proves the graph scheduler SEES region-eligible cells.
#[derive(Debug)]
pub struct RecomputeResult {
    pub attempted: usize,
    pub succeeded: usize,
    pub failures: Vec<RecomputeFailure>,
    /// Phase 3.8 (VEQ-3-03): count of formulas that were in the dirty
    /// set but skipped because no upstream value actually changed.
    /// Always `0` for the legacy `recompute_all` path.
    pub skipped_value_equality: usize,
    /// Phase 3.9 (SIMD-3-03): count of dirty formulas whose plan
    /// `lower::classify` recognized as SIMD-eligible (a recognized
    /// `SimdShape`). V1 ships observability only — the bulk SIMD
    /// dispatch via `simd::*` lives on the bench / FormulaRegion path
    /// (Phase 4.7+); this counter proves the graph scheduler is aware
    /// of region-eligible formulas. Always `0` for `recompute_all`.
    pub simd_classified: usize,
    /// Phase 6.1B inc.2c-3 (snapshot_delta): the `(sheet, row, col)` cells whose
    /// computed value was (re)written by this pass. `recompute_dirty` reports the
    /// precise value-changed set (its internal VEQ `changed` set);
    /// `recompute_all` reports every formula cell it touched (a safe over-report —
    /// the legacy full-pass path rewrites everything). The owning
    /// `WorkbookSession` folds these into its delta change-log, because recompute
    /// commits via `put_computed_at` and appends **no** ops, so an op-walk alone
    /// would miss recompute-changed dependents (the snapshot_delta gating
    /// problem). Always empty is harmless; never under-reporting is the contract.
    pub changed_cells: Vec<(SheetId, RowId, ColId)>,
}

impl RecomputeResult {
    /// True iff every formula recomputed without a structural failure.
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty()
    }

    /// Number of structural failures (lex/parse/bind). Excludes evaluation
    /// errors like `#DIV/0!` which are normal cell values.
    pub fn failed_count(&self) -> usize {
        self.failures.len()
    }
}
