//! `.qbook/` workbook directory format.
//!
//! Per spec Part V §3 + T2-D01 (Round 7 architectural lock). The on-disk shape:
//!
//! ```text
//! my-workbook.qbook/
//! ├── workbook.toml          # envelope: schema_version, name, sheet list, names
//! └── sheets/
//!     ├── 0.jsonl            # sheet 0 cells, one JSON line per non-blank cell
//!     ├── 1.jsonl
//!     └── ...
//! ```
//!
//! - **TOML envelope** (`workbook.toml`): human-readable metadata, sheet manifest,
//!   defined-names table (since v2). Users can edit it by hand if needed.
//! - **JSONL per sheet**: one cell per line, append-friendly, line-oriented (clean
//!   diffs in tools that don't know about the format). Blank cells without formulas
//!   are NOT emitted — the file is a sparse representation.
//! - **Per-sheet partitioning**: opening one sheet doesn't require parsing all
//!   others. Scales to multi-million-cell workbooks at the partition boundary.
//!
//! ## Schema versions
//!
//! - **v1** (Phase 1 W5-6 + W5-9): envelope { schema_version, name, sheets },
//!   CellRecord { row, col, value, formula? }. CellWireValue ∈ {Number, Boolean,
//!   Text, Error}.
//! - **v2** (Phase 2A.8, this revision; megaudit closure for H2/M8-M12):
//!     - Envelope gains `names: Option<NamesSection>` for `NameTable` persistence
//!       (closes M12). v1 files load as `names: None`.
//!     - `CellWireValue::Pending` variant for formula-bearing cells whose saved
//!       value would be `Value::Blank` (closes M11 — was previously encoded as
//!       `Error(#NULL!)` which conflated a real spreadsheet error with a
//!       not-yet-evaluated formula).
//!     - `#[serde(deny_unknown_fields)]` on every envelope / record / wire-value
//!       struct (closes M9 — previously unknown fields silently dropped on read).
//!
//! ## Compatibility policy
//!
//! - **v1 → v2 load**: ACCEPTED. The v2 reader treats a v1 envelope as
//!   `names: None` and converts legacy `Error(#NULL!)` placeholders into Pending
//!   when the cell carries a formula. Existing v1 fixtures continue to load.
//! - **v2 → v1 load**: REJECTED via the existing `UnsupportedSchema` path. No
//!   silent forward-compat per the no-fallbacks rule.
//! - **Within a version**: `deny_unknown_fields` rejects extra fields loudly.
//!   Any future additive change requires an explicit version bump.
//!
//! ## Atomic save (Phase 2A.8 megaudit H2 closure)
//!
//! Save protocol uses a backup-rename sequence so a crash at any moment leaves
//! either the prior workbook or the new one intact at `path` (or recoverable
//! from a `.bak-<random>` sibling):
//!
//! ```text
//! 1. write_workbook_to_dir(wb, name, &temp)     // temp = <path>.tmp-save-<random>
//! 2. if path.exists(): fs::rename(path, &bak)   // bak = <path>.bak-<random>
//! 3. fs::rename(&temp, path)                    // install new
//! 4. fs::remove_dir_all(&bak)                   // best-effort cleanup (logged on failure)
//! ```
//!
//! Invariant: between any two adjacent steps, **at least one** of `path` or
//! `bak` contains a complete valid workbook.
//!
//! `load_workbook` runs `recover_from_crashed_save` first, which detects
//! orphan `.bak-*` siblings and either rolls forward (cleanup if `path` is
//! valid) or rolls back (rename `bak` → `path` if `path` is missing/invalid).
//!
//! ## Deferred to Phase 3+
//! - Computed-overlay separation (CORR-25 deferred).
//! - Cell formatting / number formats / styles.
//! - Sheet-scoped named ranges (`Sheet1!Local`).

use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use ql_oplog::wire::{
    CellWireValue, FormatIdWire, NamedTargetWire, StyleIdWire, StyleWire, WireDecodeError,
};
use ql_storage::{Sheet, Workbook};
use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// On-disk schema version. Bumped on incompatible changes.
///
/// - `1` = Phase 1 W5-6 + W5-9: cell values + optional formulas.
/// - `2` = Phase 2A.8 megaudit closure: adds NameTable persistence, explicit
///   `Pending` CellWireValue, `deny_unknown_fields` strictness.
///
/// Loaders accept v1 AND v2 envelopes (v2 reader rewrites v1's `Error(#NULL!)`
/// placeholders into `Pending` when the cell carries a formula). v1 readers
/// (pre-2A.8 binaries, if any exist) refuse v2 via the `UnsupportedSchema`
/// error path.
/// **W5-71 (Phase 4.5.A.2):** bumped to v3. v3 adds an optional
/// `date_system` envelope field (`"1900"` or `"1904"`, default `"1900"`
/// on missing). Loaders accept v1, v2, AND v3 envelopes. A v2 envelope
/// loaded by a v3 reader gets `Workbook::date_system = Excel1900` (the
/// default). A v3 envelope's `date_system` is currently always set on
/// save; old binaries (v2 readers) refuse v3 via `UnsupportedSchema`.
///
/// **W5-81 (Phase 4.5.D part 5):** bumped to v4. v4 adds:
///   - top-level `formats: Option<FormatsSection>` — custom format
///     entries (id >= 164). Excel built-in ids 0-163 are NOT persisted;
///     `FormatTable::default()` re-seeds them on load.
///   - per-sheet `format_overlay: Option<Vec<FormatOverlayEntry>>` —
///     sparse `(row, col, id)` tuples binding cells to format ids.
///
/// **W5-92 (Phase 4.6.D):** bumped to v5. v5 adds:
///   - `NamedEntry.scope: Option<u16>` — `None` = workbook-scoped
///     (existing behavior; v1-v4 default), `Some(id)` = sheet-scoped
///     (new). The field is `#[serde(default, skip_serializing_if = ...)]`
///     so v1-v4 wire payloads continue to deserialize cleanly with
///     `scope = None` on every entry.
///
/// Loaders accept v1..=v5. v1-v4 envelopes load with all-workbook-
/// scoped names (regression-neutral). v4 readers refuse v5 via
/// `UnsupportedSchema` (the schema_version comparison upgrade is the
/// only fail-loud surface — `NamedEntry` itself uses `serde(default)`
/// so a v4 reader that somehow saw a v5 `NamedEntry` with `scope: Some`
/// would deserialize but then mis-route the name to the workbook scope
/// — the version gate prevents that path).
///
/// **W5-123 (Phase 4.8.L):** bumped to v6. v6 adds:
///   - top-level `tables: Option<TablesSection>` — workbook-scoped
///     table metadata (name, footprint, header/totals flags, ordered
///     column roster with stable ids + display + canonical names +
///     optional TotalsFunction). v1-v5 envelopes omit; loader treats
///     `None` as "no tables registered."
///
/// **W5-145 (Phase 4.9.I):** bumped to v7. v7 adds:
///   - top-level `reference_mode: Option<ReferenceModeWire>` —
///     workbook-scope R1C1/A1 preference (W5-133). `None` on v1-v6
///     and on v7-when-default; loader maps `None` to `ReferenceMode::A1`.
///   - top-level `locale: Option<LocaleWire>` — workbook-scope EnUs/De/Fr
///     preference (W5-133). `None` on v1-v6 and on v7-when-default;
///     loader maps `None` to `Locale::EnUs`.
///
/// **Two-phase load (closes Sonnet H-2):** `load_workbook` first
/// deserializes `SchemaVersionProbe { schema_version: u32 }`,
/// checks the range, then deserializes the full `WorkbookEnvelope`.
/// This means a v6 reader sees a v7 file's `schema_version: 7` and
/// errors with `UnsupportedSchema { found: 7 }` BEFORE serde tries
/// (and fails) to apply `deny_unknown_fields` to the new fields.
///
/// **v7-fields-on-v6-file rejected (closes Codex HIGH-5):** post-
/// deserialize loader assertion — if `schema_version < 7`, both
/// `reference_mode` and `locale` MUST be `None`. A hand-edited v6
/// file with v7 fields surfaces as `QbookError::ForwardCompatFieldOnOldVersion`
/// rather than silently dropping the field.
///
/// **Phase 5.2 D-1 step 5 (2026-05-20):** bumped to v8. v8 changes:
///   - `FormatEntry.id` + `FormatOverlayEntry.id` shape change from
///     bare `u32` to [`FormatEntryId`] (untagged enum: `Wire(FormatIdWire)`
///     for v8 envelopes, `LegacyU32(u32)` for v1-v7 envelopes). The
///     untagged-enum dispatch handles per-field migration without
///     version-switched deserialization. v8 envelopes serialize the
///     tagged-tuple shape via `toml::to_string_pretty`, which emits
///     section-header form for nested structs:
///     ```text
///     [[formats.entries]]
///     string = "0%"
///
///     [formats.entries.id]
///     kind = "custom"
///     peer = 0
///     counter = 0
///     ```
///     (Not inline-table form `id = { kind = "custom", peer = 0,
///     counter = 0 }` — `toml-rs` requires `toml_edit` for inline
///     emission. Step-5 audit Opus MEDIUM closure documents this.)
///     v<8 envelopes carry `id = 14` (bare integer) and route through
///     `FormatId::legacy_from_u32` at load.
///   - Save path emits `Wire(FormatIdWire::from_storage(fid))` directly.
///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
///     (which would have fired on multi-peer custom ids) are removed —
///     v8 envelopes can express non-LEGACY peer Custom ids losslessly.
///   - Gates the step-4 wire format: step 4 changed `Op::RegisterFormat`
///     + `Op::SetCellFormat` to carry `FormatIdWire`. The envelope's
///       persistence schema needs to match so saved `.qbook` files can
///       round-trip multi-peer FormatIds (not just LEGACY_PEER ones).
///
/// **Compatibility (design § 10.3 + MEDIUM-7 closure):**
///   - v6 reader loading v1-v5: tables field absent → empty TableTable.
///   - v5 reader loading v6: refused via the existing
///     `schema_version > WORKBOOK_SCHEMA_VERSION` check → loud
///     `UnsupportedSchema`. Silently dropping table metadata would
///     break formulas referencing `Sales[Qty]` after re-load (the
///     formula would surface `BindError::UnknownTable` → `#NAME?`
///     where pre-save it was a valid SUM).
///   - v7 reader loading v1-v6: `reference_mode` + `locale` absent
///     → default A1 / EnUs (regression-neutral).
///   - v6 reader loading v7: refused via the two-phase probe →
///     loud `UnsupportedSchema { found: 7 }`.
///   - v8 reader loading v1-v7: `FormatEntry.id` deserializes as
///     `LegacyU32(u32)`, migration via `FormatId::legacy_from_u32`
///     (n ≤ 163 → `Builtin(n)`; n ≥ 164 → `Custom(LEGACY_PEER, n-164)`).
///   - v7 reader loading v8: refused via the two-phase probe →
///     loud `UnsupportedSchema { found: 8 }`. A v7 reader cannot
///     deserialize the tagged-tuple `id` field as bare `u32`.
///   - **v9 (FE-4 W4, 2026-06-10):** adds the workbook-level `styles`
///     section + the per-sheet `style_overlay` section (cell-style
///     foundation). Both are additive `Option`s with `#[serde(default)]`, so
///     a v9 reader loads v1-v8 envelopes (treating the absent sections as "no
///     styles"); a v<9 reader loading v9 is refused at the schema-version gate
///     (the envelope's `deny_unknown_fields` would also reject the new keys).
pub const WORKBOOK_SCHEMA_VERSION: u32 = 9;

/// The earliest schema version this reader still accepts. v1 fixtures (Phase 1)
/// continue to load on v2 binaries; older versions would need explicit handling.
///
/// Phase 2A.13 audit cycle-3 LOW-9: now `pub` so external callers (e.g.
/// `ql-oplog`) can inspect the accepted version range without reaching into
/// qbook_format internals.
pub const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Phase 2A.13 audit cycle-3 H1: sentinel filename written inside every
/// engine-saved workbook directory. Recovery scanning uses this to
/// distinguish engine-owned `.bak-<random>` siblings (which it may delete
/// or restore) from user-created sibling directories that happen to match
/// the `.bak-*` pattern (e.g., `book.qbook.bak-2025-review`).
///
/// The marker is written LAST in `write_workbook_to_dir` (after envelope +
/// all sheet JSONLs), so a partial write doesn't leave a misleading marker
/// in an incomplete directory. A v1 workbook re-saved on a v2 binary gains
/// the marker after one successful save; until then, recovery will refuse
/// to touch marker-less `.bak-*` siblings.
const ATOMIC_SAVE_MARKER_FILENAME: &str = ".atomic-save-marker-v1";

/// Errors that can occur during save / load.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum QbookError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("TOML deserialize error: {0}")]
    TomlDe(#[from] toml::de::Error),

    #[error("TOML serialize error: {0}")]
    TomlSer(#[from] toml::ser::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error(
        "unsupported schema version {found} (this build supports versions \
         {MIN_SUPPORTED_SCHEMA_VERSION}..={WORKBOOK_SCHEMA_VERSION})"
    )]
    UnsupportedSchema { found: u32 },

    /// Phase 2A.8 audit M12: a NamedTargetWire couldn't be reconstructed into a
    /// `ql_storage::NamedTarget`. Carries the name and a reason string.
    #[error("malformed name {name:?}: {reason}")]
    MalformedName { name: String, reason: String },

    /// Phase 2A.8 audit H2: `path` doesn't have a parent directory or sensible
    /// file name, so the atomic-save temp/backup paths can't be derived.
    /// Surfaces from `make_save_paths` rather than the prior `unwrap_or` silent
    /// fallback.
    #[error("invalid workbook path {path:?}: {reason}")]
    InvalidPath { path: PathBuf, reason: &'static str },

    /// Phase 2A.13 audit cycle-3 M5: step 3 of the atomic-save protocol
    /// (rename temp → target) failed AND the rollback (rename backup → target)
    /// also failed. The user-visible state is "workbook may now be unavailable
    /// at `path`; backup data may still be at `backup_path`." Surfaces this
    /// fact directly instead of just bubbling up the original temp-rename
    /// error and burying the rollback failure in stderr.
    #[error(
        "atomic save rollback failed at {backup_path:?}: install error ({install}); \
         backup restore error ({restore}). Workbook may be unavailable at the target; \
         the backup directory still holds the prior state."
    )]
    AtomicSaveRollbackFailed {
        backup_path: PathBuf,
        install: String,
        restore: String,
    },

    #[error("malformed cell record in {file:?} at line {line}: {detail}")]
    MalformedCell {
        file: PathBuf,
        line: usize,
        detail: String,
    },

    #[error("workbook directory {path:?} does not exist or is not a directory")]
    NotADirectory { path: PathBuf },

    /// A cell value that doesn't survive JSON round-trip cleanly. serde_json
    /// silently encodes NaN/Inf as `null`, which then fails to load as a Number.
    /// Save-side validation rejects them with this error. Audit M6 fix (2026-05-12).
    #[error(
        "non-finite f64 cell at sheet {sheet} row {row} col {col}: {value} cannot be serialized"
    )]
    NonFiniteNumber {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: f64,
    },

    #[error("missing required file {file:?}")]
    MissingFile { file: PathBuf },

    /// Sheet ids in the envelope must be sequential 0..N. Audit M3 fix (2026-05-12).
    #[error("non-sequential sheet ids in envelope: expected id {expected}, found {found}")]
    NonSequentialSheetIds { expected: u16, found: u16 },

    /// **W5-81 (Phase 4.5.D part 5):** envelope's `formats` section
    /// references an id whose registration collides with the
    /// pre-populated built-in table OR an internal inconsistency
    /// (same string at two ids). The `details` field is the
    /// `FormatTableError`'s `Debug` rendering.
    ///
    /// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
    /// `ql_storage::FormatId` (tagged tuple) — mirrors the step-4 change
    /// to `ReplayError::FormatNotRegistered.id`. Error messages now
    /// distinguish `Builtin(n)` from `Custom(peer, counter)` rather than
    /// only carrying the legacy u32.
    #[error("malformed format entry id={id:?}: {details}")]
    MalformedFormat {
        id: ql_storage::FormatId,
        details: String,
    },

    /// **W5-81 (Phase 4.5.D part 5):** per-sheet `format_overlay` carries
    /// coordinates outside the workbook's row/col bounds.
    #[error("malformed format overlay entry on sheet {sheet}: row={row}, col={col} ({why})")]
    MalformedFormatOverlay {
        sheet: u16,
        row: u32,
        col: u32,
        why: &'static str,
    },

    /// **FE-4 W4 (2026-06-10; v9):** envelope's `styles` section references an
    /// id whose registration collides at the StyleTable (same id → different
    /// style, or same style → different id). The visual-formatting analog of
    /// [`Self::MalformedFormat`]. `details` is the `StyleTableError`'s `Debug`.
    #[error("malformed style entry id={id:?}: {details}")]
    MalformedStyle {
        id: ql_storage::StyleId,
        details: String,
    },

    /// **FE-4 W4 (2026-06-10; v9):** per-sheet `style_overlay` carries
    /// out-of-bounds coordinates OR binds a cell to a style id not registered
    /// in the StyleTable. The visual-formatting analog of
    /// [`Self::MalformedFormatOverlay`].
    #[error("malformed style overlay entry on sheet {sheet}: row={row}, col={col} ({why})")]
    MalformedStyleOverlay {
        sheet: u16,
        row: u32,
        col: u32,
        why: &'static str,
    },

    /// **W5-93 (Phase 4.6.E closure):** sheet name in the envelope's
    /// `[[sheets]]` section failed `Workbook::validate_sheet_name`
    /// (empty, duplicate under canonical comparison, or contains an
    /// Excel-reserved character `: \ / ? * [ ]`). Codex HIGH-1: the
    /// loader previously accepted any name silently, so a hand-edited
    /// `.qbook` could enter storage with conflicting sheets.
    #[error("malformed sheet {sheet_id}: name {name:?} ({source})")]
    MalformedSheet {
        sheet_id: u16,
        name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-123 (Phase 4.8.L):** entry in the envelope's `[[tables]]`
    /// section failed a structural invariant — unknown sheet id, zero
    /// dims, columns length / cols mismatch, or any other shape error
    /// that would leave `TableTable` inconsistent. A hand-edited or
    /// corrupted v6 envelope surfaces here loudly rather than silently
    /// producing a table that fails to bind formulas downstream.
    #[error("malformed table {name:?}: {reason}")]
    MalformedTable { name: String, reason: String },

    /// **W5-145 (Phase 4.9.I):** the envelope's `locale` field has a
    /// string value that doesn't match any known locale. Per design §
    /// 4.9.I closure of Sonnet M-2 — a v7 file with `locale = "xx"`
    /// surfaces this rather than silently substituting EnUs. Encoded
    /// values: `"en"`, `"de"`, `"fr"`.
    #[error("unknown locale {found:?} (expected one of: \"en\", \"de\", \"fr\")")]
    UnknownLocale { found: String },

    /// **W5-145 (Phase 4.9.I):** post-deserialize loader assertion
    /// (closes Codex HIGH-5). A `.qbook` declaring `schema_version <
    /// 7` but carrying v7-only fields (`reference_mode` or `locale`)
    /// is malformed — either a hand-edited corruption or a buggy
    /// down-converter. Surfaced loudly so the user fixes the file
    /// rather than getting silent field-drop.
    #[error(
        "envelope at schema_version {schema_version} carries forward-compat field {field:?}; \
         only v7+ envelopes may set this field"
    )]
    ForwardCompatFieldOnOldVersion {
        schema_version: u32,
        field: &'static str,
    },

    /// **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure**: wire-
    /// type decode failure (unknown error sigil, out-of-range axis on a
    /// named cell/range, etc.). Wraps the smaller `WireDecodeError` owned
    /// by `ql-oplog` so the `?` operator works at qbook-load call sites
    /// without explicit `.map_err`. Call sites that want to attach
    /// file/line context still use `.map_err(|e| QbookError::MalformedCell
    /// { file, line, detail: e.to_string() })`.
    #[error("wire decode error: {0}")]
    Wire(#[from] WireDecodeError),
}

/// TOML envelope for the workbook. Top-level metadata.
///
/// Phase 2A.8: `#[serde(deny_unknown_fields)]` rejects any unknown TOML key —
/// previously the loader silently dropped extras, which would let a v2-only
/// field be skipped by a still-v1 reader. Any future field requires an
/// explicit schema-version bump.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkbookEnvelope {
    pub schema_version: u32,
    /// User-supplied workbook name. Defaults to the directory name when omitted.
    pub name: String,
    /// Per-sheet metadata in id order.
    pub sheets: Vec<SheetEnvelope>,
    /// Phase 2A.8: workbook-scope defined-names section. Present in v2 envelopes
    /// (`Some` even when empty), absent in v1. `#[serde(default)]` lets v1 files
    /// load with `names: None`; the loader treats that as "no names registered."
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<NamesSection>,
    /// **W5-71 (Phase 4.5.A.2):** Excel date system. Present in v3 envelopes
    /// (always `Some` on save), absent in v1/v2 (loader maps `None` to
    /// `DateSystem::Excel1900` — the default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_system: Option<DateSystemWire>,
    /// **W5-81 (Phase 4.5.D part 5):** workbook-level format-string
    /// interning table. v4 envelopes carry custom format entries (id ≥
    /// 164) only; built-ins 0-163 are re-seeded by `FormatTable::default()`
    /// on load. v1-v3 envelopes omit the field; the loader treats `None`
    /// as "no custom formats registered" and proceeds with defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formats: Option<FormatsSection>,
    /// **FE-4 W4 (2026-06-10; schema v9):** workbook-level cell-STYLE interning
    /// table. v9 envelopes carry every registered style; v1-v8 omit the field
    /// (loader treats `None` as "no styles registered"). Styles have no Excel
    /// built-ins to re-seed, so every entry is persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub styles: Option<StylesSection>,
    /// **W5-123 (Phase 4.8.L):** workbook-scoped table metadata. v6
    /// envelopes carry the section when at least one table is
    /// registered; v1-v5 omit (and v6 omits an empty `TableTable` to
    /// keep TOML minimal). Loader treats `None` as "no tables
    /// registered."
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tables: Option<TablesSection>,

    /// **W5-145 (Phase 4.9.I):** workbook-scope reference mode (A1
    /// vs R1C1) per W5-133. v7 envelopes carry the value when it's
    /// non-default (R1C1); v1-v6 omit (loader maps `None` →
    /// `ReferenceMode::A1`). Saved through
    /// `Workbook::reference_mode()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_mode: Option<ReferenceModeWire>,

    /// **W5-145 (Phase 4.9.I):** workbook-scope locale (EnUs / De /
    /// Fr). v7 envelopes carry the value when it's non-default; v1-v6
    /// omit (loader maps `None` → `Locale::EnUs`). Custom
    /// deserializer surfaces unknown strings as
    /// `QbookError::UnknownLocale` (closes Sonnet M-2). Saved through
    /// `Workbook::locale()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<LocaleWire>,
}

/// **W5-145 (Phase 4.9.I):** schema-version probe for the two-phase
/// load (closes Sonnet H-2). Deserialized FIRST to extract just
/// the version field, then the full envelope is deserialized only
/// after the version check passes. This means a v6 reader sees
/// `schema_version: 7` and surfaces `UnsupportedSchema { found: 7 }`
/// BEFORE serde tries (and fails with `deny_unknown_fields`) on
/// the new v7 fields.
#[derive(Deserialize)]
struct SchemaVersionProbe {
    schema_version: u32,
}

/// **W5-145 (Phase 4.9.I):** wire representation of `ReferenceMode`.
/// Serialized as a string `"A1"` or `"R1C1"` for human-readable TOML.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
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

/// **W5-145 (Phase 4.9.I):** wire representation of `Locale`.
/// Serialized as a short string `"en"` / `"de"` / `"fr"`. Unknown
/// strings deserialize to `LocaleWire::Unknown(String)` so the
/// loader can produce `QbookError::UnknownLocale` with the captured
/// value (closes Sonnet M-2). Save path produces canonical short
/// strings only (never `Unknown`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocaleWire {
    En,
    De,
    Fr,
    /// Set by the custom deserializer for any string that doesn't
    /// match a known locale code. The loader rejects this with
    /// `QbookError::UnknownLocale` AFTER deserialize succeeds.
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

    /// Convert to runtime `Locale`. Returns `Err(unknown_value)` if
    /// the wire was `Unknown(_)`; the loader maps that to
    /// `QbookError::UnknownLocale`.
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
            // Save path never produces Unknown (it's read-side only).
            // If it ever did (e.g. a round-trip from a corrupted load)
            // we'd serialize the original string verbatim, which is
            // honest behavior — but `save_workbook` validates the
            // workbook before write so this is defensive.
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

/// **W5-71 (Phase 4.5.A.2):** wire representation of `ql_types::DateSystem`.
/// Serialized as a string `"1900"` or `"1904"` for human-readable TOML.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DateSystemWire {
    #[serde(rename = "1900")]
    Excel1900,
    #[serde(rename = "1904")]
    Excel1904,
}

impl DateSystemWire {
    pub fn from_runtime(system: ql_types::DateSystem) -> Self {
        match system {
            ql_types::DateSystem::Excel1900 => Self::Excel1900,
            ql_types::DateSystem::Excel1904 => Self::Excel1904,
        }
    }

    pub fn to_runtime(self) -> ql_types::DateSystem {
        match self {
            Self::Excel1900 => ql_types::DateSystem::Excel1900,
            Self::Excel1904 => ql_types::DateSystem::Excel1904,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetEnvelope {
    pub id: u16,
    pub name: String,
    /// Per-sheet chunk size (default 16384). Phase 1 W5-6 captures the constructed
    /// value so loaders reconstruct sheets at the same chunk layout.
    pub chunk_rows: u32,
    /// Highest-row written + 1, conservative. Reads beyond this still return Blank;
    /// the field exists for save-side allocation hints and observability.
    pub row_extent: u32,
    pub col_extent: u32,
    /// **W5-81 (Phase 4.5.D part 5):** per-sheet sparse cell-format overlay.
    /// `Some([])` and `None` are equivalent ("no custom formats on this
    /// sheet"); save serializes as `None` for v4 sheets with empty
    /// overlay to keep TOML minimal. Loader maps `None` → empty overlay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_overlay: Option<Vec<FormatOverlayEntry>>,
    /// **FE-4 W4 (2026-06-10; schema v9):** per-sheet sparse cell-STYLE
    /// overlay (the visual-formatting analog of `format_overlay`). `None` ≡
    /// "no styles on this sheet"; omitted on save for an empty overlay.
    /// v1-v8 envelopes lack the field; the loader maps `None` → empty overlay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_overlay: Option<Vec<StyleOverlayEntry>>,
}

/// **W5-81 (Phase 4.5.D part 5):** workbook-level format-table wire format.
///
/// Persists ONLY custom entries (`id >= FIRST_CUSTOM_FORMAT_ID`). Built-in
/// ids 0-163 are re-seeded by `FormatTable::default()` at load time, so
/// putting them on disk would bloat every workbook with the same constants.
/// Entries are sorted by id for deterministic diffs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormatsSection {
    pub entries: Vec<FormatEntry>,
}

/// **Phase 5.2 D-1 step 5 (2026-05-20):** envelope-side `id` field used
/// by [`FormatEntry`] + [`FormatOverlayEntry`]. Two shapes coexist for
/// backwards compatibility:
///
/// - `Wire(FormatIdWire)` — v8+ shape. Serializes as the tagged tuple
///   (e.g. `{ "kind": "builtin", "id": 14 }`). Lossless for multi-peer
///   Custom ids.
/// - `LegacyU32(u32)` — v1-v7 shape. Serializes as a bare number (e.g.
///   `14`). Loader migrates via [`FormatId::legacy_from_u32`]:
///   `n <= 163` → `Builtin(n)`; `n >= 164` → `Custom(LEGACY_PEER, n-164)`.
///
/// `#[serde(untagged)]` makes serde dispatch on shape during deserialize:
/// struct shape → `Wire`; integer shape → `LegacyU32`. Save path always
/// emits `Wire`. v8 readers loading v<8 envelopes hit `LegacyU32` and
/// migrate at the `to_storage()` boundary.
///
/// Variant order matters for untagged: serde tries variants top-to-bottom.
/// `Wire` first means a struct-shaped payload always lands as `Wire`; a
/// numeric payload falls through to `LegacyU32`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum FormatEntryId {
    /// v8+ wire shape. Always emitted on save post-step-5.
    Wire(FormatIdWire),
    /// v1-v7 legacy shape. Only encountered on load when migrating an
    /// old envelope; never emitted post-step-5.
    LegacyU32(u32),
}

impl FormatEntryId {
    /// Project the envelope-side id into a runtime [`ql_storage::FormatId`].
    /// Dispatches on variant: `Wire` decodes via [`FormatIdWire::to_storage`];
    /// `LegacyU32` migrates via [`FormatId::legacy_from_u32`].
    ///
    /// **Step 5 migration contract:** this is the ONLY conversion needed
    /// at the load boundary. Callers shouldn't pattern-match the variant
    /// themselves — both shapes route to the same `FormatId` after this
    /// call.
    pub fn to_storage(&self) -> ql_storage::FormatId {
        match self {
            FormatEntryId::Wire(w) => w.to_storage(),
            FormatEntryId::LegacyU32(n) => ql_storage::FormatId::legacy_from_u32(*n),
        }
    }

    /// Construct from a runtime [`ql_storage::FormatId`]. Always returns
    /// the v8+ `Wire` variant. Use this at the save boundary.
    pub fn from_storage(id: ql_storage::FormatId) -> Self {
        FormatEntryId::Wire(FormatIdWire::from_storage(id))
    }
}

/// **W5-81 (Phase 4.5.D part 5):** one row in the workbook FormatTable.
///
/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
/// [`FormatEntryId`] — an untagged enum that accepts both v8 wire shape
/// and v<8 legacy `u32`. Save path emits the v8 shape; loader handles
/// both.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormatEntry {
    pub id: FormatEntryId,
    pub string: String,
}

/// **W5-81 (Phase 4.5.D part 5):** one entry in a sheet's cell-format
/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
/// for deterministic diffs.
///
/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
/// [`FormatEntryId`] (same shape change as [`FormatEntry`]).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormatOverlayEntry {
    pub row: u32,
    pub col: u32,
    pub id: FormatEntryId,
}

/// **FE-4 W4 (2026-06-10; schema v9):** workbook-level cell-STYLE interning
/// table (the visual-formatting analog of [`FormatsSection`]). Persists EVERY
/// registered style (styles have no Excel built-ins, so unlike formats there
/// is nothing to re-seed on load — all entries are written). Entries sorted by
/// `StyleId` for deterministic diffs. Omitted (`None`) when no styles exist.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StylesSection {
    pub entries: Vec<StyleEntry>,
}

/// **FE-4 W4 (2026-06-10):** one row in the workbook StyleTable. `id` is the
/// op-log wire shape ([`StyleIdWire`] — `{peer, counter}`); `style` is the
/// full [`StyleWire`] value (bold/italic/fill/align + per-edge borders). Both
/// reuse the op-log wire types (mirrors how [`FormatEntry`] reuses
/// `FormatIdWire`), so the `.qbook` envelope and the op log share one wire
/// vocabulary and round-trip every sub-field losslessly.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StyleEntry {
    pub id: StyleIdWire,
    pub style: StyleWire,
}

/// **FE-4 W4 (2026-06-10):** one entry in a sheet's cell-style overlay —
/// `(row, col)` ↦ StyleId. Sorted by `(row, col)` on save (mirrors
/// [`FormatOverlayEntry`]).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StyleOverlayEntry {
    pub row: u32,
    pub col: u32,
    pub id: StyleIdWire,
}

/// **W5-123 (Phase 4.8.L):** workbook-scoped table metadata. Mirror of
/// `ql_storage::TableTable` projected into serializable shapes. Each
/// `TableEntry` preserves stable column ids across save/load (the
/// loader bypasses `TableTable::allocate_column_id` and `insert`
/// auto-bumps the allocator past the highest persisted id).
///
/// Entries are sorted ascending by canonical (uppercase) name on save
/// for deterministic diffs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TablesSection {
    pub entries: Vec<TableEntry>,
}

/// **W5-123 (Phase 4.8.L):** one entry in `TablesSection`. Mirrors
/// `ql_storage::TableMetadata`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableEntry {
    /// Canonical (uppercase) name. The loader keys `TableTable` by this.
    pub name: String,
    /// Case-preserving display name (the form the user typed at create
    /// time; printed by the formula printer).
    pub display_name: String,
    pub sheet: u16,
    pub top_row: u32,
    pub top_col: u32,
    pub rows: u32,
    pub cols: u32,
    pub has_header: bool,
    pub has_totals: bool,
    pub columns: Vec<TableColumnEntry>,
}

/// **W5-123 (Phase 4.8.L):** one entry in `TableEntry::columns`.
/// Mirrors `ql_storage::TableColumn`. `id` is the stable monotonic
/// id allocated at create / resize time; preserving it across
/// save/load is necessary so future Phase-5 column-move ops can
/// reference columns by id rather than position.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableColumnEntry {
    pub id: u32,
    /// Canonical (lowercase) name; used for case-insensitive `Table[Col]`
    /// lookups via `TableMetadata::lookup_column`.
    pub name: String,
    /// Case-preserving display name (the form the user typed; printed
    /// by `Sales[<display>]`).
    pub display: String,
    /// Per-column totals-row function (Phase 4.10 will materialize
    /// auto-populated totals from this). Omitted on the wire when
    /// `None` to keep TOML minimal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totals_function: Option<TotalsFunctionWire>,
}

/// **W5-123 (Phase 4.8.L):** wire representation of
/// `ql_storage::TotalsFunction`. Serialized as a snake_case string in
/// TOML for readability.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TotalsFunctionWire {
    None,
    Average,
    Count,
    CountNums,
    Max,
    Min,
    StdDev,
    Sum,
    Variance,
    Custom,
}

impl TotalsFunctionWire {
    pub fn from_runtime(t: ql_storage::TotalsFunction) -> Self {
        match t {
            ql_storage::TotalsFunction::None => Self::None,
            ql_storage::TotalsFunction::Average => Self::Average,
            ql_storage::TotalsFunction::Count => Self::Count,
            ql_storage::TotalsFunction::CountNums => Self::CountNums,
            ql_storage::TotalsFunction::Max => Self::Max,
            ql_storage::TotalsFunction::Min => Self::Min,
            ql_storage::TotalsFunction::StdDev => Self::StdDev,
            ql_storage::TotalsFunction::Sum => Self::Sum,
            ql_storage::TotalsFunction::Variance => Self::Variance,
            ql_storage::TotalsFunction::Custom => Self::Custom,
        }
    }

    pub fn to_runtime(self) -> ql_storage::TotalsFunction {
        match self {
            Self::None => ql_storage::TotalsFunction::None,
            Self::Average => ql_storage::TotalsFunction::Average,
            Self::Count => ql_storage::TotalsFunction::Count,
            Self::CountNums => ql_storage::TotalsFunction::CountNums,
            Self::Max => ql_storage::TotalsFunction::Max,
            Self::Min => ql_storage::TotalsFunction::Min,
            Self::StdDev => ql_storage::TotalsFunction::StdDev,
            Self::Sum => ql_storage::TotalsFunction::Sum,
            Self::Variance => ql_storage::TotalsFunction::Variance,
            Self::Custom => ql_storage::TotalsFunction::Custom,
        }
    }
}

/// Phase 2A.8: workbook-scope defined names. The on-disk wire format mirrors
/// `ql_storage::NameTable` + `NamedTarget`, projected into serializable shapes.
///
/// Names are stored in canonical (upper-case) form, matching `NameTable::set`'s
/// canonicalization. Order is sorted ascending by name for deterministic diffs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamesSection {
    pub entries: Vec<NamedEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamedEntry {
    pub name: String,
    pub target: NamedTargetWire,
    /// **W5-92 (Phase 4.6.D):** name scope.
    /// - `None` (default; v1-v4 wire) = workbook-scoped.
    /// - `Some(sheet_id)` = sheet-scoped; sheet-scoped beats workbook-
    ///   scoped at lookup time (Excel canon, XS-4-03).
    ///
    /// `serde(default)` keeps the field optional in v1-v4 payloads;
    /// `skip_serializing_if` keeps v1-v4 round-trips byte-stable for
    /// workbook-scoped names (the common case).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<u16>,
}

// (Tier D2 (2026-05-19): `NamedTargetWire` moved to
//  `ql_oplog::wire::NamedTargetWire`. Re-exported via `ql_io::lib.rs`
//  for backwards compat with external callers. Used here by the
//  `NamedEntry` struct + the save/load routines below.)

/// JSONL cell record — one line per non-blank or formula-bearing cell.
///
/// Tagged enum representation keeps the wire format compact + self-describing:
/// `{"row":5,"col":3,"value":{"Number":42.0}}`.
///
/// - **W5-9** added the optional `formula` field. If `Some`, the cell carries a
///   formula whose evaluated result is `value`. If `None` (or absent in the
///   JSON), the cell is a literal value.
/// - **Phase 2A.8** added `deny_unknown_fields` per audit M9. Any unrecognized
///   JSON field is rejected loudly at parse time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CellRecord {
    pub row: u32,
    pub col: u32,
    pub value: CellWireValue,
    /// Formula source (without leading `=`). Phase 1 W5-9. Omitted from JSON when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
}

// (Tier D2 (2026-05-19): `CellWireValue`, `error_to_canonical_text`,
//  `parse_canonical_error_text`, and the `impl` blocks moved to
//  `ql_oplog::wire`. Re-exported via `ql_io::lib.rs` for backwards
//  compat. The `to_value()` return type is now `WireDecodeError`,
//  which `QbookError` wraps via a `#[from]` impl below.)

/// Save a `Workbook` to `path` (a `.qbook/` directory). **Crash-safe atomic save**
/// per the Phase 2A.8 megaudit H2 closure:
///
/// 1. Write the new workbook to `<path>.tmp-save-<random>`.
/// 2. If `path` already exists, rename it to `<path>.bak-<random>`.
/// 3. Rename the temp directory into `path`.
/// 4. Best-effort remove the backup; on failure, log a warning to stderr but
///    DO NOT silently swallow (megaudit M8). The next `load_workbook` will
///    detect the orphan via `recover_from_crashed_save` and clean it up.
///
/// **Invariant**: between any two adjacent steps, at least one of `path` or
/// `<path>.bak-<random>` contains a complete valid workbook. A crash at any
/// instant leaves a recoverable on-disk state.
///
/// Cross-filesystem note: the temp and backup paths are *siblings* of the
/// target, sharing its parent directory. POSIX `rename(2)` is atomic within a
/// single filesystem; the sibling-only design preserves that property.
pub fn save_workbook(wb: &Workbook, name: &str, path: &Path) -> Result<(), QbookError> {
    save_workbook_extending(wb, name, path, |_| Ok(()))
}

/// Phase 2A.3.c (2026-05-12): closure-based extension primitive. Same atomic-save
/// protocol as `save_workbook`, with an additional hook (`extend`) that fires
/// AFTER `write_workbook_to_dir` populates the temp directory but BEFORE the
/// atomic `rename(temp → target)`. Used by `ql_oplog::save_workbook_with_oplog`
/// to write `oplog.bin` as a sidecar — it rides the same atomic rename and
/// recovers via the same crash-rollback path.
///
/// The closure receives the temp directory path. It can `fs::write` arbitrary
/// files into it. The atomic-save invariant still holds: at every step
/// boundary, at least one of {target, `<target>.bak-<random>`} contains a
/// complete valid workbook + any sidecars the closure wrote.
///
/// Closure failure cleans up the temp directory and propagates the error —
/// same semantics as a `write_workbook_to_dir` failure.
///
/// Public `save_workbook` is a thin wrapper that calls this with a no-op
/// closure; callers without sidecars should keep using `save_workbook`.
pub fn save_workbook_extending<F>(
    wb: &Workbook,
    name: &str,
    path: &Path,
    extend: F,
) -> Result<(), QbookError>
where
    F: FnOnce(&Path) -> Result<(), QbookError>,
{
    let paths = make_save_paths(path)?;

    // Phase 2A.13 audit cycle-3 H5: refuse to save into a path that exists
    // but is NOT a directory. `path.exists() && !path.is_dir()` means a
    // regular file (or symlink, FIFO, etc.) is sitting where the workbook
    // directory should be. The previous code would have happily renamed
    // that file to `<base>.bak-<suffix>`, then installed our directory in
    // its place — the user's original file becomes an orphan no one will
    // ever find (recovery would try `remove_dir_all` on it and fail with
    // `NotADirectory`). Loud refusal is the right answer.
    if path.exists() && !path.is_dir() {
        return Err(QbookError::InvalidPath {
            path: path.to_path_buf(),
            reason: "target exists but is not a directory",
        });
    }

    // Step 1: write everything to the temp dir. If this fails, the original
    // target (if any) is untouched and we clean up the partial temp.
    if let Err(e) = write_workbook_to_dir(wb, name, &paths.temp) {
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            // The original save error is what the caller wants; the cleanup
            // failure goes to stderr per the M8 audit (don't silence).
            eprintln!(
                "warning: failed to clean partial temp directory {:?} after save error: {cleanup_err}",
                paths.temp
            );
        }
        return Err(e);
    }

    // Phase 2A.3.c: extension hook fires after the engine has finished
    // populating the temp dir (envelope + sheets + marker), but before the
    // atomic rename. Sidecars written here become part of the all-or-nothing
    // visibility guarantee.
    if let Err(e) = extend(&paths.temp) {
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            eprintln!(
                "warning: failed to clean partial temp directory {:?} after extend error: {cleanup_err}",
                paths.temp
            );
        }
        return Err(e);
    }

    // Step 2: if target exists, move it aside (NOT remove). After this, the
    // old state is at `.bak-<random>` and the target is missing.
    let had_existing = path.exists();
    if had_existing {
        fs::rename(path, &paths.backup)?;
    }

    // Step 3: install the new state at the target. If this fails after step 2,
    // we have `.bak-<random>` only and no target — recovery on next load will
    // roll back. To avoid leaving the temp dir orphaned in that case, attempt
    // a rollback ourselves before returning.
    if let Err(install_err) = fs::rename(&paths.temp, path) {
        // Phase 2A.13 audit cycle-3 M5: when install fails AND restore also
        // fails, surface a compound error (was: silently `eprintln!`ed the
        // restore failure and returned only the install error).
        let restore_err: Option<std::io::Error> = if had_existing {
            fs::rename(&paths.backup, path).err()
        } else {
            None
        };
        // The temp dir didn't move into place; try to clean it up.
        if let Err(cleanup_err) = fs::remove_dir_all(&paths.temp) {
            eprintln!(
                "warning: failed to clean temp directory {:?} after rename failure: {cleanup_err}",
                paths.temp
            );
        }
        if let Some(restore_err) = restore_err {
            // Both failed → compound user-visible error.
            return Err(QbookError::AtomicSaveRollbackFailed {
                backup_path: paths.backup.clone(),
                install: install_err.to_string(),
                restore: restore_err.to_string(),
            });
        }
        // Restore succeeded (or no prior target existed): the user's prior
        // workbook is intact at `path`. Return the install error so the
        // caller knows the save itself failed.
        return Err(QbookError::Io(install_err));
    }

    // Step 4: best-effort backup cleanup. On failure, log loudly — but the
    // save itself succeeded, so we return Ok. `recover_from_crashed_save` on
    // a future load will eventually clean up the orphan.
    if had_existing {
        if let Err(e) = fs::remove_dir_all(&paths.backup) {
            eprintln!(
                "warning: save succeeded but backup cleanup failed at {:?}: {e}",
                paths.backup
            );
        }
    }
    Ok(())
}

/// Phase 2A.8 audit M10: each save uses a fresh, collision-resistant suffix so
/// concurrent saves from two threads in the same process never share temp /
/// backup paths. The suffix mixes wall-clock nanos, PID, and the calling
/// thread's id — sufficient uniqueness for the IDE save-path workload without
/// pulling in a random-source crate.
fn save_session_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    // ThreadId formats as "ThreadId(N)" — hash via length + a fixed mixer to
    // get a u64 contribution. Stable within a process.
    let tid_str = format!("{:?}", std::thread::current().id());
    let tid_hash = tid_str.bytes().fold(0u64, |acc, b| {
        acc.wrapping_mul(0x100000001B3).wrapping_add(b as u64)
    });
    let mixed = nanos
        .wrapping_mul(0x9E3779B97F4A7C15)
        .wrapping_add(pid.wrapping_mul(0xBF58476D1CE4E5B9))
        ^ tid_hash;
    format!("{mixed:016x}")
}

/// Resolved temp + backup paths for one save invocation. Sharing the suffix
/// between temp and backup lets `recover_from_crashed_save` link them
/// unambiguously if a crash occurs mid-protocol.
struct SavePaths {
    temp: PathBuf,
    backup: PathBuf,
}

/// Derive temp + backup sibling paths for `target`. Phase 2A.8 audit M9
/// closure: degenerate paths (no parent, no file_name) error loudly via
/// `QbookError::InvalidPath` rather than the prior `unwrap_or` silent fallback.
fn make_save_paths(target: &Path) -> Result<SavePaths, QbookError> {
    let parent = target.parent().ok_or_else(|| QbookError::InvalidPath {
        path: target.to_path_buf(),
        reason: "no parent directory",
    })?;
    let basename = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "no file name",
        })?;
    // Refuse to save into a target whose basename is itself a temp/backup name
    // — that would let a path like `foo.bak-abc/` collide with our own
    // backup-rename protocol. Phase 2A.8 conservative gate; the IDE shouldn't
    // pick names like this, but a hostile caller could.
    if basename.contains(".tmp-save-") || basename.contains(".bak-") {
        return Err(QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "basename collides with atomic-save protocol naming",
        });
    }
    let suffix = save_session_suffix();
    Ok(SavePaths {
        temp: parent.join(format!("{basename}.tmp-save-{suffix}")),
        backup: parent.join(format!("{basename}.bak-{suffix}")),
    })
}

/// Phase 2A.8 audit H2 recovery protocol. Called at the top of
/// `load_workbook`. Detects orphan `.bak-<random>` siblings of `target` and
/// either rolls forward (target is intact, just clean up bak) or rolls back
/// (target missing/invalid, rename bak → target).
///
/// If multiple `.bak-*` orphans exist (unlikely; would require multiple
/// crashes across save sessions), we conservatively refuse to load and ask
/// the caller to manually resolve. Returning an error here is safer than
/// guessing which backup is "the right one."
fn recover_from_crashed_save(target: &Path) -> Result<(), QbookError> {
    let Some(parent) = target.parent() else {
        return Ok(()); // No parent, nothing to scan.
    };
    let basename = match target.file_name() {
        Some(s) => s.to_string_lossy().into_owned(),
        None => return Ok(()),
    };
    let bak_prefix = format!("{basename}.bak-");

    // Scan the parent dir for orphan .bak-* siblings.
    // Phase 2A.13 audit cycle-3 H1: ONLY consider directories that carry our
    // atomic-save marker file (`is_engine_owned_backup`). A user-created
    // sibling like `book.qbook.bak-2025-review` shares the filename prefix
    // but lacks the marker — recovery leaves it alone.
    let mut orphans: Vec<PathBuf> = Vec::new();
    let read_dir = match fs::read_dir(parent) {
        Ok(it) => it,
        Err(_) => return Ok(()), // Parent unreadable; load will fail downstream with a clearer error.
    };
    for entry in read_dir.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with(&bak_prefix) {
                let p = entry.path();
                if is_engine_owned_backup(&p) {
                    orphans.push(p);
                }
                // Else: user-created sibling that just happens to match the
                // `.bak-*` prefix. Not ours, don't touch.
            }
        }
    }

    if orphans.is_empty() {
        return Ok(());
    }

    // Phase 2A.13 audit cycle-3 M6: when the target is valid AND we have
    // multiple orphans, they're ALL stale (a valid target can only result
    // from a single most-recent successful save; any older `.bak-*` is from
    // a prior save whose step-4 cleanup never completed). Clean them all up
    // instead of refusing to load — accumulated `eprintln!` warnings from
    // repeated step-4 failures would otherwise create a permanent deadlock.
    if target_envelope_is_valid(target) {
        for bak in &orphans {
            if let Err(e) = fs::remove_dir_all(bak) {
                eprintln!(
                    "warning: load detected orphan backup {bak:?} but cleanup failed: {e}; \
                     target is valid, so load proceeds"
                );
            }
        }
        return Ok(());
    }

    // Target is missing or invalid. We need to restore from a backup.
    // Multi-orphan case here IS ambiguous (we don't know which backup
    // matches the missing target); refuse and ask the user.
    if orphans.len() > 1 {
        return Err(QbookError::InvalidPath {
            path: target.to_path_buf(),
            reason: "target is missing/invalid AND multiple .bak-* siblings present; \
                     ambiguous crash recovery — resolve manually before loading",
        });
    }
    let bak = orphans.into_iter().next().expect("len == 1");

    // Step 2 completed but step 3 didn't (or step 3 partially completed
    // and left an invalid target). Roll back: restore the old state.
    if target.exists() {
        if let Err(e) = fs::remove_dir_all(target) {
            return Err(QbookError::Io(e));
        }
    }
    // Phase 2A.13 audit cycle-3 M4: concurrent loader race. Two loaders
    // seeing the same orphan can race here — one wins, the other sees
    // `NotFound` because the bak is already consumed. If we lose the
    // rename race, re-check whether the target is NOW valid (the other
    // loader's rename succeeded and installed it). Only return the I/O
    // error if the rollback genuinely failed.
    if let Err(rename_err) = fs::rename(&bak, target) {
        if target_envelope_is_valid(target) {
            // Another loader won the race and the rollback is already done.
            // We're good — proceed with load.
            return Ok(());
        }
        return Err(QbookError::Io(rename_err));
    }
    Ok(())
}

/// Cheap envelope-validity check used by recovery. The full load is the real
/// validity test, but recovery needs a quick yes/no to decide forward vs
/// back. We check: directory exists, `workbook.toml` parses, every claimed
/// sheet JSONL file exists. We DO NOT parse JSONL line-by-line — that's the
/// load path's job.
fn target_envelope_is_valid(target: &Path) -> bool {
    if !target.is_dir() {
        return false;
    }
    let toml_path = target.join("workbook.toml");
    if !toml_path.is_file() {
        return false;
    }
    let toml_str = match fs::read_to_string(&toml_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let envelope: WorkbookEnvelope = match toml::from_str(&toml_str) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let sheets_dir = target.join("sheets");
    for sheet_env in &envelope.sheets {
        let sheet_path = sheets_dir.join(format!("{}.jsonl", sheet_env.id));
        if !sheet_path.is_file() {
            return false;
        }
    }
    true
}

/// Inner write that populates `dir` with `workbook.toml` + `sheets/*.jsonl`. Used by
/// `save_workbook` against a temp dir; not a public surface (the atomic-save wrapper
/// is what callers want).
/// **M7 (6.3-2b):** the honest persisted footprint of a sheet for the `.qbook`
/// envelope `row_extent`/`col_extent` — a true upper bound covering every cell the
/// save actually writes: non-blank values (JSONL value records) ∪ formula cells
/// (the formula-only pass) ∪ format-overlay cells (the envelope `format_overlay`
/// section). So a reader sizing a grid from these fields sees every cell that will
/// materialize on load. Tighter than `Sheet::bounds` (which inflates on a `Blank`
/// write and never shrinks) — the value contribution shrinks to real data — while
/// still covering far-flung formula-only / format-only cells (which a bare value
/// extent would under-report). The fields are write-only metadata (the loader
/// re-grows `bounds` from the JSONL puts), but keeping them honest avoids the
/// inflated footprint M7 exists to remove without ever under-reporting.
fn effective_sheet_footprint(wb: &Workbook, sheet: &Sheet, sheet_id: SheetId) -> (RowId, ColId) {
    let vb = sheet.effective_value_bounds();
    let mut row_extent = vb.row_extent;
    let mut col_extent = vb.col_extent;
    // `+1` one-past-max, fail-loud on overflow (No-Fallbacks; coords are gated to
    // MAX_ROW/MAX_COLUMN by the writers, so this is defense-in-depth, never reached).
    let mut grow = |r: RowId, c: ColId| {
        row_extent = row_extent.max(r.checked_add(1).expect("footprint row extent overflow"));
        col_extent = col_extent.max(c.checked_add(1).expect("footprint col extent overflow"));
    };
    for (s, r, c, _) in wb.iter_formulas() {
        if s == sheet_id {
            grow(r, c);
        }
    }
    for ((r, c), _) in sheet.format_overlay().iter() {
        grow(r, c);
    }
    (row_extent, col_extent)
}

fn write_workbook_to_dir(wb: &Workbook, name: &str, dir: &Path) -> Result<(), QbookError> {
    fs::create_dir_all(dir)?;
    let sheets_dir = dir.join("sheets");
    fs::create_dir_all(&sheets_dir)?;

    // Build the envelope.
    let mut sheet_envelopes: Vec<SheetEnvelope> = Vec::new();
    for sheet_id in 0..(wb.sheet_count() as SheetId) {
        let sheet = wb.sheet(sheet_id).expect("sheet_count was wrong");
        // **M7 (6.3-2b):** honest tight footprint (value ∪ formula ∪ format
        // positions) rather than the conservative `Sheet::bounds`.
        let (env_row_extent, env_col_extent) = effective_sheet_footprint(wb, sheet, sheet_id);
        // **W5-81 (Phase 4.5.D part 5):** serialize the per-sheet cell-format
        // overlay if it has any entries. Sorted by (row, col) for diffability.
        let format_overlay = {
            let overlay = sheet.format_overlay();
            if overlay.is_empty() {
                None
            } else {
                let mut entries: Vec<FormatOverlayEntry> = overlay
                    .iter()
                    .map(|((r, c), fid)| FormatOverlayEntry {
                        row: r,
                        col: c,
                        // Phase 5.2 D-1 step 5: envelope schema bumped to
                        // v8 — emit the tagged-tuple wire shape directly.
                        // Lossless for non-LEGACY peer Custom ids (which
                        // pre-step-5 hit the to_legacy_u32().expect() panic).
                        id: FormatEntryId::from_storage(fid),
                    })
                    .collect();
                entries.sort_by_key(|e| (e.row, e.col));
                Some(entries)
            }
        };
        // **FE-4 W4 (2026-06-10):** serialize the per-sheet cell-style overlay
        // if non-empty (mirrors format_overlay). Sorted by (row, col).
        let style_overlay = {
            let overlay = sheet.style_overlay();
            if overlay.is_empty() {
                None
            } else {
                let mut entries: Vec<StyleOverlayEntry> = overlay
                    .iter()
                    .map(|((r, c), sid)| StyleOverlayEntry {
                        row: r,
                        col: c,
                        id: StyleIdWire::from_storage(sid),
                    })
                    .collect();
                entries.sort_by_key(|e| (e.row, e.col));
                Some(entries)
            }
        };
        sheet_envelopes.push(SheetEnvelope {
            id: sheet_id,
            name: sheet.name().to_owned(),
            chunk_rows: sheet_chunk_rows(sheet),
            row_extent: env_row_extent,
            col_extent: env_col_extent,
            format_overlay,
            style_overlay,
        });
    }

    // Phase 2A.8: serialize the workbook's NameTable. Sorted ascending by
    // (scope, name) for deterministic on-disk diffs (workbook-scoped first
    // since `None < Some` under derive(Ord); then by name). Omitted (None)
    // when both workbook-scoped table AND every sheet's scoped_names table
    // are empty, so v1-reader compatibility round-trips cleanly for the
    // empty-names common case.
    //
    // **W5-92 (Phase 4.6.D):** collects workbook-scoped names first, then
    // sheet-scoped names from each sheet's `scoped_names` table. The
    // `scope` field on `NamedEntry` distinguishes the two; legacy v1-v4
    // readers emit only the workbook-scoped entries (no per-sheet names
    // existed pre-v5).
    let names_section = {
        let mut entries: Vec<NamedEntry> = Vec::new();
        for (name, target) in wb.names().iter() {
            entries.push(NamedEntry {
                name: name.as_ref().to_owned(),
                target: NamedTargetWire::from_target(target),
                scope: None,
            });
        }
        for sheet_id in 0..wb.sheet_count() as ql_types::SheetId {
            if let Some(sheet) = wb.sheet(sheet_id) {
                for (name, target) in sheet.scoped_names().iter() {
                    entries.push(NamedEntry {
                        name: name.as_ref().to_owned(),
                        target: NamedTargetWire::from_target(target),
                        scope: Some(sheet_id),
                    });
                }
            }
        }
        if entries.is_empty() {
            None
        } else {
            // Deterministic ordering: workbook-scoped (scope=None) entries
            // first, then sheet-scoped grouped by sheet id; within each
            // group, names sorted ascending.
            entries.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));
            Some(NamesSection { entries })
        }
    };

    // **W5-81 (Phase 4.5.D part 5):** serialize custom FormatTable entries
    // (id ≥ FIRST_CUSTOM_FORMAT_ID). Built-ins are re-seeded from
    // `FormatTable::default()` on load and aren't persisted. None if the
    // table has no custom entries (typical for built-in-only workbooks).
    let formats_section = {
        // Collect (FormatId, owned-string) tuples up front so we can sort
        // by the storage-side `FormatId` (derived Ord since step 3). This
        // avoids needing Ord on `FormatEntryId` and keeps the on-disk
        // ordering identical to a Builtin-vs-Custom + counter-monotonic
        // semantic — the same property `entries.sort_by_key(|e| e.id)`
        // had pre-step-5 when `id: u32`.
        let mut pairs: Vec<(ql_storage::FormatId, String)> = wb
            .formats()
            .iter()
            // Phase 5.2 D-1 step 3: `id.is_custom()` replaces the
            // pre-step-3 `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter.
            // Persist only custom (peer-allocated) entries; built-ins
            // re-seed from `FormatTable::default()` on load.
            .filter(|(id, _)| id.is_custom())
            .map(|(id, s)| (id, s.to_owned()))
            .collect();
        if pairs.is_empty() {
            None
        } else {
            pairs.sort_by_key(|(id, _)| *id);
            let entries: Vec<FormatEntry> = pairs
                .into_iter()
                .map(|(id, string)| FormatEntry {
                    // Phase 5.2 D-1 step 5: emit v8 tagged-tuple shape
                    // directly. Pre-step-5 this site used
                    // `id.to_legacy_u32().expect(...)` which would have
                    // panicked on non-LEGACY peer Custom ids; post-step-5
                    // the envelope expresses them losslessly.
                    id: FormatEntryId::from_storage(id),
                    string,
                })
                .collect();
            Some(FormatsSection { entries })
        }
    };

    // **FE-4 W4 (2026-06-10):** serialize the StyleTable. Unlike formats there
    // are no built-ins to skip — persist EVERY registered style. Sorted by
    // `StyleId`. None if no styles are registered (typical for the common case).
    let styles_section = {
        let mut pairs: Vec<(ql_storage::StyleId, ql_storage::Style)> = wb.styles().iter().collect();
        if pairs.is_empty() {
            None
        } else {
            pairs.sort_by_key(|(id, _)| *id);
            let entries: Vec<StyleEntry> = pairs
                .into_iter()
                .map(|(id, style)| StyleEntry {
                    id: StyleIdWire::from_storage(id),
                    style: StyleWire::from_storage(style),
                })
                .collect();
            Some(StylesSection { entries })
        }
    };

    // **W5-123 (Phase 4.8.L):** serialize `TableTable` if non-empty.
    // Sorted ascending by canonical (uppercase) name for deterministic
    // diffs. Empty TableTable → `None` so v1-v5 readers don't see an
    // unexpected `[[tables]]` block that they'd misinterpret (the
    // schema-version gate already forces UnsupportedSchema for them,
    // but omitting on empty also keeps v6 TOML minimal for the common
    // "no tables yet" case).
    let tables_section = {
        let mut entries: Vec<TableEntry> = wb
            .tables()
            .iter()
            .map(|(_canon, meta)| TableEntry {
                name: meta.name.as_ref().to_owned(),
                display_name: meta.display_name.as_ref().to_owned(),
                sheet: meta.sheet,
                top_row: meta.top_row,
                top_col: meta.top_col,
                rows: meta.rows,
                cols: meta.cols,
                has_header: meta.has_header,
                has_totals: meta.has_totals,
                columns: meta
                    .columns
                    .iter()
                    .map(|c| TableColumnEntry {
                        id: c.id,
                        name: c.name.as_ref().to_owned(),
                        display: c.display.as_ref().to_owned(),
                        totals_function: c.totals_function.map(TotalsFunctionWire::from_runtime),
                    })
                    .collect(),
            })
            .collect();
        if entries.is_empty() {
            None
        } else {
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Some(TablesSection { entries })
        }
    };

    // **W5-145 (Phase 4.9.I):** persist reference_mode + locale ONLY
    // when non-default — keeps the TOML minimal for the common A1/EnUs
    // case. v6→v7 readers see `None` for the default case (interpreted
    // as A1/EnUs by the loader's default path); the field is only
    // written when the workbook has been actively set to R1C1 or a
    // non-EN locale.
    let reference_mode_wire = match wb.reference_mode() {
        ql_types::ReferenceMode::A1 => None,
        mode => Some(ReferenceModeWire::from_runtime(mode)),
    };
    let locale_wire = match wb.locale() {
        ql_types::Locale::EnUs => None,
        locale => Some(LocaleWire::from_runtime(locale)),
    };

    let envelope = WorkbookEnvelope {
        schema_version: WORKBOOK_SCHEMA_VERSION,
        name: name.to_owned(),
        sheets: sheet_envelopes,
        names: names_section,
        // **W5-71 (Phase 4.5.A.2):** persist the workbook's date system.
        date_system: Some(DateSystemWire::from_runtime(wb.date_system())),
        // **W5-81 (Phase 4.5.D part 5):** persist custom format entries.
        formats: formats_section,
        // **FE-4 W4 (2026-06-10; v9):** persist cell-style entries.
        styles: styles_section,
        // **W5-123 (Phase 4.8.L):** persist workbook tables.
        tables: tables_section,
        // **W5-145 (Phase 4.9.I):** persist non-default reference_mode + locale.
        reference_mode: reference_mode_wire,
        locale: locale_wire,
    };
    let toml_str = toml::to_string_pretty(&envelope)?;
    fs::write(dir.join("workbook.toml"), toml_str)?;

    // Per-sheet JSONL.
    for sheet_id in 0..(wb.sheet_count() as SheetId) {
        let sheet = wb.sheet(sheet_id).expect("sheet_count was wrong");
        let sheet_path = sheets_dir.join(format!("{sheet_id}.jsonl"));
        let f = fs::File::create(&sheet_path)?;
        let mut writer = BufWriter::new(f);
        // **M7 (6.3-2b):** sweep the effective value extent (non-blank values) rather
        // than the conservative `Sheet::bounds`. Formula cells outside this rectangle
        // (incl. formula-only cells whose computed value is Blank) are caught by the
        // formula-only pass below — its `formula_positions` covers EVERY sheet formula
        // regardless of position, so narrowing here is lossless (a skipped formula cell
        // simply emits as `Pending` in that pass, identical wire output). Format-only
        // cells (blank value, no formula) are never in the JSONL at all — they ride the
        // bounds-independent envelope `format_overlay` section.
        let bounds = sheet.effective_value_bounds();

        // Collect formula cells for this sheet so we can emit them even when their
        // row/col falls outside the value-bounds rectangle (e.g. a formula cell
        // with no evaluated value yet, or a formula at an extreme position).
        // Sort by (row, col) for deterministic output.
        let mut formula_positions: Vec<(RowId, ColId)> = wb
            .iter_formulas()
            .filter(|(s, _, _, _)| *s == sheet_id)
            .map(|(_, r, c, _)| (r, c))
            .collect();
        formula_positions.sort();

        // Track which (row, col) pairs we've already written from the value-bounds
        // sweep, so the formula-only pass doesn't double-emit.
        let mut written: std::collections::HashSet<(RowId, ColId)> =
            std::collections::HashSet::new();

        // Naive iteration over value bounds. Sparse cells (Blank without a formula)
        // are skipped. Phase 2 may optimize via direct chunk-walking; not on hot path.
        for row in 0..bounds.row_extent {
            for col in 0..bounds.col_extent {
                // **W5-105 (Phase 4.7.L) — design § 12.2 closure**: skip
                // non-anchor spill TARGET cells. Their computed values are
                // runtime-derived from the anchor's formula via the
                // load → recompute_all pipeline (Phase 4.7.J #128 made
                // recompute_all dispatch top-level arrays through
                // `write_spill`). Saving target cells would emit
                // `CellRecord { value: <spilled>, formula: None }` records
                // that on reload look like user-typed values BLOCKING the
                // re-spill — the very issue Codex W5-94 design HIGH-5
                // identified as motivating the schema-skip approach.
                //
                // The anchor cell itself still saves (its formula text is
                // what replay + recompute_all needs).
                if let Some(anchor) = wb.spill_target_anchor(sheet_id, row, col) {
                    if anchor != (sheet_id, row, col) {
                        continue;
                    }
                }

                let v = sheet.read(row, col);
                // Audit M6 fix (2026-05-12): reject NaN/Inf at the save boundary.
                if let Value::Number(n) = v {
                    if !n.is_finite() {
                        return Err(QbookError::NonFiniteNumber {
                            sheet: sheet_id,
                            row,
                            col,
                            value: n,
                        });
                    }
                }
                let wire = CellWireValue::from_value(&v);
                let formula = wb
                    .formula_at(sheet_id, row, col)
                    .map(|s| s.as_ref().to_owned());
                // Emit if there's a non-blank value OR a formula.
                if wire.is_some() || formula.is_some() {
                    // Phase 2A.8 audit M11: formula-bearing cells with Blank
                    // saved value encode as `Pending` (was: `Error(#NULL!)`,
                    // which conflated "not yet evaluated" with a real Excel
                    // #NULL! error). `Pending` is a distinct wire variant the
                    // loader recognizes as "recompute required."
                    let rec = CellRecord {
                        row,
                        col,
                        value: wire.unwrap_or(CellWireValue::Pending),
                        formula,
                    };
                    let line = serde_json::to_string(&rec)?;
                    writeln!(writer, "{line}")?;
                    written.insert((row, col));
                }
            }
        }

        // Emit formula cells whose (row, col) fell outside the value-bounds
        // rectangle. These are formula-only cells with Blank values: encoded
        // as `Pending` per Phase 2A.8 audit M11 so the formula text survives
        // round-trip without conflating with a real #NULL! error.
        for (row, col) in formula_positions {
            if written.contains(&(row, col)) {
                continue;
            }
            let formula = wb
                .formula_at(sheet_id, row, col)
                .map(|s| s.as_ref().to_owned());
            let rec = CellRecord {
                row,
                col,
                value: CellWireValue::Pending,
                formula,
            };
            let line = serde_json::to_string(&rec)?;
            writeln!(writer, "{line}")?;
        }
        writer.flush()?;
    }

    // Phase 2A.13 audit cycle-3 H1: write the atomic-save marker LAST, after
    // envelope + all sheet JSONLs. A partial write that fails before this
    // point leaves a directory WITHOUT the marker, so recovery won't
    // mistake the partial result for an engine-owned backup. Marker
    // content is the schema version + a human-readable note (no parsing —
    // the filename's presence is the only signal recovery consults).
    fs::write(
        dir.join(ATOMIC_SAVE_MARKER_FILENAME),
        format!(
            "Quantbook atomic-save marker v1 (schema_version={WORKBOOK_SCHEMA_VERSION}).\n\
             Presence of this file proves the directory was written by the\n\
             engine's atomic-save protocol. Used by recover_from_crashed_save\n\
             to distinguish engine-owned `.bak-<random>` siblings from\n\
             user-created sibling directories. Safe to ignore.\n"
        ),
    )?;

    Ok(())
}

/// Phase 2A.13 audit cycle-3 H1: a directory is "engine-owned" iff it contains
/// our marker file. Used by recovery to filter `.bak-<random>` siblings —
/// user-created directories that match the prefix but lack the marker are
/// left alone.
fn is_engine_owned_backup(dir: &Path) -> bool {
    dir.join(ATOMIC_SAVE_MARKER_FILENAME).is_file()
}

/// Load a `Workbook` from a `.qbook/` directory.
///
/// Phase 2A.8 audit H2: before reading, calls `recover_from_crashed_save` to
/// detect and resolve orphan `.bak-<random>` siblings left by a prior crashed
/// save. Recovery either rolls forward (target valid, cleanup orphan) or rolls
/// back (target missing/invalid, restore orphan).
pub fn load_workbook(path: &Path) -> Result<Workbook, QbookError> {
    // Recovery happens BEFORE the directory check — if the prior save crashed
    // between step 2 (rename → bak) and step 3 (rename temp → target), the
    // target may not yet exist. Recovery restores it from .bak.
    recover_from_crashed_save(path)?;

    if !path.is_dir() {
        return Err(QbookError::NotADirectory {
            path: path.to_path_buf(),
        });
    }

    // Read + parse envelope.
    let toml_path = path.join("workbook.toml");
    if !toml_path.is_file() {
        return Err(QbookError::MissingFile { file: toml_path });
    }
    let toml_str = fs::read_to_string(&toml_path)?;

    // **W5-145 (Phase 4.9.I):** two-phase load (closes Sonnet H-2).
    // Phase 1: probe just the schema_version field. This lets a vN
    // reader reject vN+1 files BEFORE serde encounters the new fields
    // and trips `deny_unknown_fields` with a less informative
    // `TomlDe` error. `SchemaVersionProbe` derives `Deserialize`
    // without `deny_unknown_fields`, so it tolerates extra fields.
    let probe: SchemaVersionProbe = toml::from_str(&toml_str)?;
    if probe.schema_version < MIN_SUPPORTED_SCHEMA_VERSION
        || probe.schema_version > WORKBOOK_SCHEMA_VERSION
    {
        return Err(QbookError::UnsupportedSchema {
            found: probe.schema_version,
        });
    }
    let schema_version = probe.schema_version;
    // Phase 2: full envelope deserialization. Now that we know the
    // version is in range, `deny_unknown_fields` runs against a
    // shape that we know matches this build.
    let envelope: WorkbookEnvelope = toml::from_str(&toml_str)?;

    // **W5-145 (Phase 4.9.I):** post-deserialize assertion that v7-only
    // fields aren't present on a v6-or-older envelope (closes Codex
    // HIGH-5). serde's `#[serde(default)]` on the new fields means a
    // hand-edited v6 file with `reference_mode = "R1C1"` would
    // deserialize cleanly into a Some(_) without the version gate
    // catching it. We catch it here and refuse loudly.
    if schema_version < 7 {
        if envelope.reference_mode.is_some() {
            return Err(QbookError::ForwardCompatFieldOnOldVersion {
                schema_version,
                field: "reference_mode",
            });
        }
        if envelope.locale.is_some() {
            return Err(QbookError::ForwardCompatFieldOnOldVersion {
                schema_version,
                field: "locale",
            });
        }
    }

    // **Phase 5.2 D-1 step 5 audit Codex MEDIUM-1 closure (2026-05-20):**
    // post-deserialize assertion that the v8-only tagged-tuple
    // `FormatEntryId::Wire` shape isn't present on a v7-or-older envelope.
    // `#[serde(untagged)]` dispatch on `FormatEntryId` is purely structural
    // — without this guard, a hand-edited v7 envelope with `id = { kind =
    // "custom", peer = 42, counter = 7 }` would silently deserialize as
    // `Wire(_)` and load successfully, violating the v1-v7 contract of
    // "bare integer ids only."
    //
    // Cross-variant tolerance: v8 envelopes with `LegacyU32(_)` entries
    // ARE accepted (auto-upgrade case for hand-edited migrations). Only
    // the v<8-with-Wire direction is rejected.
    if schema_version < 8 {
        if let Some(ref fs) = envelope.formats {
            for entry in &fs.entries {
                if matches!(entry.id, FormatEntryId::Wire(_)) {
                    return Err(QbookError::ForwardCompatFieldOnOldVersion {
                        schema_version,
                        field: "formats.entries[].id (tagged-tuple shape)",
                    });
                }
            }
        }
        for sheet in &envelope.sheets {
            if let Some(ref overlay) = sheet.format_overlay {
                for entry in overlay {
                    if matches!(entry.id, FormatEntryId::Wire(_)) {
                        return Err(QbookError::ForwardCompatFieldOnOldVersion {
                            schema_version,
                            field: "sheets[].format_overlay[].id (tagged-tuple shape)",
                        });
                    }
                }
            }
        }
    }

    // **W5-145 (Phase 4.9.I):** apply v7 fields if present. Unknown
    // locale strings surface as `QbookError::UnknownLocale` (closes
    // Sonnet M-2) — the custom Deserialize captured the string into
    // `LocaleWire::Unknown(s)`; `to_runtime()` returns Err(s) here.
    let reference_mode = envelope
        .reference_mode
        .map(|w| w.to_runtime())
        .unwrap_or(ql_types::ReferenceMode::A1);
    let locale = match envelope.locale.clone() {
        Some(w) => w
            .to_runtime()
            .map_err(|found| QbookError::UnknownLocale { found })?,
        None => ql_types::Locale::EnUs,
    };

    let is_v1 = schema_version == 1;

    // Phase 2A.13 audit cycle-3 H4: counter for legacy-pending migrations so we
    // can warn the user once per load (rather than silently corrupting any
    // legitimate `#NULL!` formula results from v1 workbooks).
    let mut legacy_pending_migrations: usize = 0;

    // Construct the Workbook + sheets in id order. Sheet ids in the envelope must be
    // sequential 0..N — Workbook::add_sheet allocates ids in that order.
    // Audit M3 fix (2026-05-12): previously this panicked; now returns Result error.
    let mut wb = Workbook::new();
    // **W5-71 (Phase 4.5.A.2):** apply the envelope's date_system, defaulting
    // to Excel1900 when absent (v1/v2 envelopes lack the field). v3+
    // envelopes always carry it.
    if let Some(ds_wire) = envelope.date_system {
        wb.set_date_system(ds_wire.to_runtime());
    }
    // (Else: leave at Workbook::default(), which is Excel1900.)
    // **W5-145 (Phase 4.9.I):** apply v7 reference_mode + locale.
    // Defaults already enforced above; setting unconditionally is
    // a no-op for the default (A1 / EnUs) case.
    wb.set_reference_mode(reference_mode);
    wb.set_locale(locale);
    // **W5-81 (Phase 4.5.D part 5):** apply the envelope's FormatsSection.
    // v4 envelopes carry custom format entries (id ≥ 164); v1-v3 don't.
    // Built-ins 0-163 are already in the FormatTable from
    // `Workbook::default()`. `register_at` is idempotent for the
    // pre-seeded builtins; mismatches surface as `MalformedFormat`.
    if let Some(ref fs) = envelope.formats {
        for entry in &fs.entries {
            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
            // (untagged enum). `to_storage()` dispatches per-variant:
            // - v8 `Wire(FormatIdWire)` → `FormatIdWire::to_storage()`.
            // - v<8 `LegacyU32(n)` → `FormatId::legacy_from_u32(n)`
            //   (n ≤ 163 → Builtin; n ≥ 164 → Custom(LEGACY_PEER, n-164)).
            let fid = entry.id.to_storage();
            wb.formats_mut()
                .register_at(fid, entry.string.as_str())
                .map_err(|err| QbookError::MalformedFormat {
                    id: fid,
                    details: format!("{err:?}"),
                })?;
        }
    }
    // **FE-4 W4 (2026-06-10; v9):** apply the envelope's StylesSection. v9
    // envelopes carry every registered style; v1-v8 omit the field (None →
    // no styles). `register_at` surfaces collisions as `MalformedStyle`.
    if let Some(ref ss) = envelope.styles {
        for entry in &ss.entries {
            let sid = entry.id.to_storage();
            wb.styles_mut()
                .register_at(sid, entry.style.to_storage())
                .map_err(|err| QbookError::MalformedStyle {
                    id: sid,
                    details: format!("{err:?}"),
                })?;
        }
    }
    let sheets_dir = path.join("sheets");
    for (expected_id, sheet_env) in envelope.sheets.iter().enumerate() {
        if sheet_env.id as usize != expected_id {
            return Err(QbookError::NonSequentialSheetIds {
                expected: expected_id as u16,
                found: sheet_env.id,
            });
        }
        // W5-93 (Phase 4.6.E closure): route through the fallible variant
        // so a malformed `.qbook` (hand-edited duplicate name, reserved
        // char, empty) surfaces as `QbookError::MalformedSheet` rather
        // than a process-killing panic. Previously the loader silently
        // accepted any name.
        let sheet_id = wb
            .try_add_sheet_with_chunk_rows(sheet_env.name.clone(), sheet_env.chunk_rows)
            .map_err(|source| QbookError::MalformedSheet {
                sheet_id: sheet_env.id,
                name: sheet_env.name.clone(),
                source,
            })?;
        assert_eq!(
            sheet_id as usize, expected_id,
            "Workbook::try_add_sheet_with_chunk_rows returned non-sequential id — programmer error in ql-storage"
        );

        // **W5-81 (Phase 4.5.D part 5):** apply the per-sheet cell-format
        // overlay. v4 envelopes carry `format_overlay`; v1-v3 don't.
        //
        // **W5-84 closure (Codex MEDIUM-3):** the loader now VALIDATES
        // that each overlay id resolves in the workbook's `FormatTable`,
        // matching the runtime + replay contract (which both surface
        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
        // corrupted `.qbook` binding a cell to an unregistered id no
        // longer falls through to silent General fallback at render
        // time — it now surfaces `MalformedFormatOverlay` at load.
        if let Some(ref overlay_entries) = sheet_env.format_overlay {
            // Snapshot the set of registered ids BEFORE the overlay
            // mutation so we don't borrow `wb` twice (mutable on the
            // sheet + immutable on `wb.formats()`).
            //
            // Phase 5.2 D-1 step 3: HashSet keys are now `FormatId`
            // (the enum) rather than `u32`. Phase 5.2 D-1 step 5:
            // `entry.id` is now `FormatEntryId` (untagged enum) routing
            // both v8 Wire and v<8 LegacyU32 shapes through `to_storage()`.
            let known_ids: std::collections::HashSet<ql_storage::FormatId> =
                wb.formats().iter().map(|(id, _)| id).collect();
            let sheet_mut = wb.sheet_mut(sheet_id).expect("just-added sheet must exist");
            for entry in overlay_entries {
                // Bounds-check to mirror the cell-record validation
                // below — out-of-range coordinates surface as
                // `MalformedFormatOverlay` rather than silently binding
                // a sentinel address.
                if entry.row > MAX_ROW || entry.col > MAX_COLUMN {
                    return Err(QbookError::MalformedFormatOverlay {
                        sheet: sheet_id,
                        row: entry.row,
                        col: entry.col,
                        why: "out-of-range row/col",
                    });
                }
                let fid = entry.id.to_storage();
                if !known_ids.contains(&fid) {
                    return Err(QbookError::MalformedFormatOverlay {
                        sheet: sheet_id,
                        row: entry.row,
                        col: entry.col,
                        why: "format id not registered in FormatTable",
                    });
                }
                sheet_mut
                    .format_overlay_mut()
                    .set(entry.row, entry.col, fid);
            }
        }

        // **FE-4 W4 (2026-06-10; v9):** apply the per-sheet cell-style overlay
        // (mirrors format_overlay). Each id MUST resolve in the workbook's
        // StyleTable (validated above), else `MalformedStyleOverlay`. v1-v8
        // envelopes lack the field (None → no styles on this sheet).
        if let Some(ref overlay_entries) = sheet_env.style_overlay {
            let known_style_ids: std::collections::HashSet<ql_storage::StyleId> =
                wb.styles().iter().map(|(id, _)| id).collect();
            let sheet_mut = wb.sheet_mut(sheet_id).expect("just-added sheet must exist");
            for entry in overlay_entries {
                if entry.row > MAX_ROW || entry.col > MAX_COLUMN {
                    return Err(QbookError::MalformedStyleOverlay {
                        sheet: sheet_id,
                        row: entry.row,
                        col: entry.col,
                        why: "out-of-range row/col",
                    });
                }
                let sid = entry.id.to_storage();
                if !known_style_ids.contains(&sid) {
                    return Err(QbookError::MalformedStyleOverlay {
                        sheet: sheet_id,
                        row: entry.row,
                        col: entry.col,
                        why: "style id not registered in StyleTable",
                    });
                }
                sheet_mut.style_overlay_mut().set(entry.row, entry.col, sid);
            }
        }

        // Audit M2 fix (2026-05-12): a missing sheet JSONL is now an explicit
        // MissingFile error rather than silently treating the sheet as empty
        // (which would mask corruption / partial saves). The on-disk format
        // emits an empty file for an empty sheet, so file-presence is the
        // correctness oracle.
        let sheet_path = sheets_dir.join(format!("{sheet_id}.jsonl"));
        if !sheet_path.is_file() {
            return Err(QbookError::MissingFile { file: sheet_path });
        }
        let f = fs::File::open(&sheet_path)?;
        let reader = BufReader::new(f);
        for (line_no, line) in reader.lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let rec: CellRecord =
                serde_json::from_str(&line).map_err(|e| QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail: format!("JSON parse: {e}"),
                })?;
            // Audit H4 fix (2026-05-12): validate row/col bounds at the loader so
            // hand-crafted JSONL with out-of-bounds coordinates produces a clean
            // MalformedCell error instead of panicking inside Sheet::put.
            if rec.row > MAX_ROW {
                return Err(QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail: format!("row {} exceeds MAX_ROW {MAX_ROW}", rec.row),
                });
            }
            if rec.col > MAX_COLUMN {
                return Err(QbookError::MalformedCell {
                    file: sheet_path.clone(),
                    line: line_no + 1,
                    detail: format!("col {} exceeds MAX_COLUMN {MAX_COLUMN}", rec.col),
                });
            }
            // Phase 2A.8 audit M11: detect the v1 legacy encoding of a
            // formula-bearing Blank cell (`Error("#NULL!")` + formula) and
            // rewrite it to the v2 Pending semantic during the v1 load path.
            // v2 files emit `Pending` directly and skip this branch.
            //
            // Phase 2A.13 audit cycle-3 H4: this rule cannot distinguish
            // "engine wrote #NULL! as Pending stand-in" from "user's formula
            // legitimately evaluated to #NULL!" (Excel's intersection-of-
            // disjoint-ranges error, e.g. `=SUM(A1 B1)` with a space). Both
            // encode identically in v1. We count migrations and warn ONCE
            // per load at the end so the user can audit suspect formulas
            // rather than silently corrupting real #NULL! results.
            let is_legacy_pending = is_v1
                && rec.formula.is_some()
                && matches!(&rec.value, CellWireValue::Error(s) if s == "#NULL!");
            if is_legacy_pending {
                legacy_pending_migrations += 1;
            }

            let value = if rec.value.is_pending() || is_legacy_pending {
                // Pending cells contribute no Value to the cell — leave it
                // Blank until recompute runs. The formula text below is what
                // matters for the recompute pass.
                Value::Blank
            } else {
                // Tier D2 (2026-05-19): `to_value()` now returns
                // `WireDecodeError`. Attach the qbook-specific
                // file/line context as `QbookError::MalformedCell` so
                // load-failure diagnostics keep the same shape.
                rec.value
                    .to_value()
                    .map_err(|e| QbookError::MalformedCell {
                        file: sheet_path.clone(),
                        line: line_no + 1,
                        detail: e.to_string(),
                    })?
            };
            // Phase 3.5 (CORR-25, 2026-05-12) — OVR-3-03: load routes
            // cells with formulas to the COMPUTED overlay; cells without
            // formulas go to the USER overlay. This preserves the
            // engine's semantic invariant ("formula-owned cell has no
            // user-overlay entry"). Pending/Blank values are skipped on
            // the formula path because there's nothing to display until
            // recompute runs; the formula text alone is enough to drive
            // the recompute pass.
            let row = rec.row as RowId;
            let col = rec.col as ColId;
            if let Some(formula_text) = rec.formula {
                wb.put_formula(sheet_id, row, col, formula_text);
                if !matches!(value, Value::Blank) {
                    wb.put_computed_at(sheet_id, row, col, value);
                }
            } else {
                wb.put_at(sheet_id, row, col, value);
            }
        }
    }

    // Phase 2A.8: hydrate the workbook's NameTable from the envelope's
    // `names` section. v1 envelopes lack the section (envelope.names is None);
    // those workbooks load with an empty NameTable, matching prior behavior.
    //
    // Phase 2A.9 audit M6: `Workbook::set_name` may now refuse reserved names
    // (currently `AI` per CORR-06). A v2 file that somehow contains a reserved
    // name (e.g., hand-edited TOML) surfaces as `QbookError::MalformedName`.
    // **W5-92 (Phase 4.6.D):** route by scope. `scope: None` (the v1-v4
    // historical case) lands in the workbook-scoped `NameTable`;
    // `scope: Some(id)` lands in that sheet's `scoped_names` table. An
    // unknown sheet id surfaces as `MalformedName` (the load-time
    // analog of the op-log replay's `InvalidSheet` — we can't carry the
    // structural error through `QbookError`'s vocabulary without a new
    // variant, and `MalformedName` is the right shape for "name's
    // target is bad").
    if let Some(names_section) = envelope.names {
        for entry in names_section.entries {
            let target = entry.target.to_target(&entry.name)?;
            match entry.scope {
                None => {
                    wb.set_name(&entry.name, target)
                        .map_err(|e| QbookError::MalformedName {
                            name: entry.name.clone(),
                            reason: format!("rejected by workbook NameTable: {e}"),
                        })?;
                }
                Some(sheet_id) => {
                    let sheet =
                        wb.sheet_mut(sheet_id)
                            .ok_or_else(|| QbookError::MalformedName {
                                name: entry.name.clone(),
                                reason: format!("scope refers to unknown sheet id {sheet_id}"),
                            })?;
                    sheet.set_scoped_name(&entry.name, target).map_err(|e| {
                        QbookError::MalformedName {
                            name: entry.name.clone(),
                            reason: format!("rejected by sheet {sheet_id} NameTable: {e}"),
                        }
                    })?;
                }
            }
        }
    }

    // **W5-123 (Phase 4.8.L):** hydrate `TableTable` from the envelope's
    // `tables` section. v6+ envelopes carry the section; v1-v5 don't,
    // so a `None` envelope tables field is the regression-neutral path
    // (loader leaves `TableTable::default()`).
    //
    // Direct `tables_mut().insert(...)` bypasses `WorkbookRuntime::
    // create_table` validation; that's the intentional loader pattern
    // (matches how `Workbook::add_sheet` etc. are called bypassing
    // op-log emission). Per design § 4.3 invariants 1-4 the persisted
    // shape is already legal (it was validated at create / resize
    // time on a prior session). We do enforce structural shape
    // (non-zero dims, columns length matches cols, sheet id exists)
    // so a corrupted / hand-edited TOML surfaces `MalformedTable`
    // rather than panicking downstream.
    if let Some(tables_section) = envelope.tables {
        for entry in tables_section.entries {
            if wb.sheet(entry.sheet).is_none() {
                return Err(QbookError::MalformedTable {
                    name: entry.name.clone(),
                    reason: format!("references unknown sheet id {}", entry.sheet),
                });
            }
            if entry.rows == 0 || entry.cols == 0 {
                return Err(QbookError::MalformedTable {
                    name: entry.name.clone(),
                    reason: "table rows and cols must both be > 0".into(),
                });
            }
            // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate
            // footprint upper bound mirrors producer + replay. A hand-
            // edited / corrupted TOML with `top_row + rows - 1 > MAX_ROW`
            // would otherwise let a table register cells beyond the
            // addressable grid, and a u32-overflowing footprint would
            // skip downstream checks.
            if let Err(reason) = ql_storage::TableMetadata::validate_footprint_bounds(
                entry.top_row,
                entry.top_col,
                entry.rows,
                entry.cols,
            ) {
                return Err(QbookError::MalformedTable {
                    name: entry.name.clone(),
                    reason: reason.to_owned(),
                });
            }
            if entry.columns.len() != entry.cols as usize {
                return Err(QbookError::MalformedTable {
                    name: entry.name.clone(),
                    reason: format!(
                        "columns length {} does not match cols {}",
                        entry.columns.len(),
                        entry.cols
                    ),
                });
            }
            // **W5-126 (Phase 4.8.O.2 — Codex MEDIUM-1):** re-validate
            // the runtime registry invariants at load time. The W5-123
            // docstring said "loader trusts the file" — Codex flagged
            // that a hand-edited / corrupted v6 TOML could enter the
            // engine with state that runtime mutation wouldn't allow.
            // Concrete failure modes: silent duplicate-name overwrite
            // (leaks column ids into the allocator); namespace
            // collision with NameTable; overlapping table footprints
            // (HashMap-order indeterminism in `Workbook::table_at`);
            // duplicate or empty column names breaking `lookup_column`.
            let canonical_upper = entry.name.to_ascii_uppercase();
            // Name uniqueness against already-loaded tables (catches
            // duplicate canonical names within the same TablesSection
            // entries vec, since each insert lands in `wb.tables_mut()`
            // before the next iteration).
            if wb.tables().lookup(&canonical_upper).is_some() {
                return Err(QbookError::MalformedTable {
                    name: entry.name.clone(),
                    reason: "duplicate canonical table name in [[tables.entries]]".into(),
                });
            }
            // Shared namespace with NameTable. NameTable hydration ran
            // above; workbook-scoped conflicts are checked here via
            // `lookup_ci`. **Sheet-scoped name collisions are
            // intentionally NOT checked** — `WorkbookRuntime::create_table`
            // also only checks workbook-scoped names, so loader and
            // runtime are consistent (design § 13 #3: sheet-scoped
            // names shadow workbook-scoped within their sheet, and
            // tables are workbook-scoped, so the binder resolves them
            // from separate paths). Closing this is a wider design
            // change that belongs to a future polish wave, not the
            // loader.
            if wb.names().lookup_ci(&canonical_upper).is_some() {
                return Err(QbookError::MalformedTable {
                    name: entry.name.clone(),
                    reason: "table name collides with a workbook-scoped defined name".into(),
                });
            }
            // Column-level shape: non-empty `name` AND `display`,
            // unique canonical (lowercase) names, no `u32::MAX`
            // column ids (closes Codex MEDIUM-2 — `TableTable::insert`
            // does unchecked `max_id + 1` on the column-id allocator).
            {
                use std::collections::HashSet;
                let mut seen_canon: HashSet<String> = HashSet::new();
                for col in &entry.columns {
                    if col.name.is_empty() || col.display.is_empty() {
                        return Err(QbookError::MalformedTable {
                            name: entry.name.clone(),
                            reason: "table column names cannot be empty".into(),
                        });
                    }
                    if col.id == u32::MAX {
                        return Err(QbookError::MalformedTable {
                            name: entry.name.clone(),
                            reason: "column id cannot be u32::MAX (would overflow allocator)"
                                .into(),
                        });
                    }
                    if !seen_canon.insert(col.name.to_ascii_lowercase()) {
                        return Err(QbookError::MalformedTable {
                            name: entry.name.clone(),
                            reason: "duplicate canonical column name within table".into(),
                        });
                    }
                }
            }
            // Footprint non-overlap against tables already inserted in
            // earlier loop iterations.
            for r in entry.top_row..entry.top_row + entry.rows {
                for c in entry.top_col..entry.top_col + entry.cols {
                    if wb.table_at(entry.sheet, r, c).is_some() {
                        return Err(QbookError::MalformedTable {
                            name: entry.name.clone(),
                            reason: "table footprint overlaps a previously loaded table".into(),
                        });
                    }
                }
            }
            // **W5-128 (Phase 4.8.O.4 — Codex closure-verify MEDIUM-1 second-pass):**
            // insert under the UPPERCASE canonical, not the raw
            // `entry.name`. Engine-saved files always have uppercase
            // `entry.name`, but a hand-edited TOML with mixed-case
            // (`name = "Sales"`) would otherwise enter the HashMap
            // under key "Sales" while `TableTable::lookup` uppercases
            // every query — silently making the table unfindable.
            // The new pin in `load_normalizes_mixed_case_table_name`
            // catches the regression at boundary cases the W5-126
            // tests missed (those used identical uppercase names).
            let canonical: std::sync::Arc<str> = std::sync::Arc::from(canonical_upper.as_str());
            let columns: Vec<ql_storage::TableColumn> = entry
                .columns
                .into_iter()
                .map(|c| ql_storage::TableColumn {
                    id: c.id,
                    name: std::sync::Arc::from(c.name.as_str()),
                    display: std::sync::Arc::from(c.display.as_str()),
                    totals_function: c.totals_function.map(TotalsFunctionWire::to_runtime),
                })
                .collect();
            let meta = ql_storage::TableMetadata {
                name: std::sync::Arc::clone(&canonical),
                display_name: std::sync::Arc::from(entry.display_name.as_str()),
                sheet: entry.sheet,
                top_row: entry.top_row,
                top_col: entry.top_col,
                rows: entry.rows,
                cols: entry.cols,
                has_header: entry.has_header,
                has_totals: entry.has_totals,
                columns,
            };
            // `insert` auto-bumps `next_column_id` past any persisted
            // column id (added in 4.8.L to keep the loader-side ids
            // collision-free with future runtime allocations).
            wb.tables_mut().insert(canonical, meta);
        }
    }

    // Phase 2A.13 audit cycle-3 H4: warn once per load if we rewrote any v1
    // `Error("#NULL!") + formula` cells to Pending. The rewrite is correct
    // for engine-produced files (where #NULL! was a stand-in for "not yet
    // evaluated") but COULD silently corrupt legitimate Excel #NULL! results
    // — the v1 wire format conflated both cases. The user should re-check
    // any formulas that legitimately produce #NULL! after this load.
    if legacy_pending_migrations > 0 {
        eprintln!(
            "warning: load_workbook {path:?} migrated {legacy_pending_migrations} v1 \
             `Error(#NULL!) + formula` cells to the v2 Pending semantic. \
             If any of those formulas were authored to produce #NULL! intentionally \
             (e.g. `=SUM(A1 B1)` with a space), their evaluated values will be lost \
             until recompute. Re-save the workbook in v2 format to remove this ambiguity."
        );
    }

    Ok(wb)
}

/// Read the actual `chunk_rows` from a sheet. Audit H5 fix (2026-05-12): uses the
/// `Sheet::chunk_rows()` accessor (added in W5-7) so the envelope reflects the
/// real layout instead of the env default.
fn sheet_chunk_rows(sheet: &Sheet) -> u32 {
    sheet.chunk_rows()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    // Tier D2 (2026-05-19): these test imports used to come from the
    // file-level `use ql_types::{..., ErrorValue, Range};` block which
    // was trimmed after wire-types moved to ql-oplog. Tests still need
    // them; import directly here.
    use ql_oplog::wire::error_to_canonical_text;
    use ql_storage::NamedTarget;
    use ql_types::{Address, ErrorValue, Range};

    fn cell(row: u32, col: u32, v: Value) -> ((SheetId, RowId, ColId), Value) {
        ((0, row, col), v)
    }

    fn wb_with(name: &str, cells: &[((SheetId, RowId, ColId), Value)]) -> Workbook {
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet(name);
        for ((_s, r, c), v) in cells {
            wb.put_at(sheet_id, *r, *c, v.clone());
        }
        wb
    }

    // ===== save + load round-trip =====

    #[test]
    fn roundtrip_empty_workbook_one_sheet() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with("Sheet1", &[]);
        save_workbook(&wb, "test", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet_count(), 1);
        assert_eq!(loaded.sheet(0).unwrap().name(), "Sheet1");
    }

    #[test]
    fn roundtrip_with_number_cells() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with(
            "Sheet1",
            &[
                cell(0, 0, Value::Number(1.0)),
                cell(0, 1, Value::Number(2.0)),
                cell(5, 3, Value::Number(42.5)),
            ],
        );
        save_workbook(&wb, "test", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        let s = loaded.sheet(0).unwrap();
        assert_eq!(s.read(0, 0), Value::Number(1.0));
        assert_eq!(s.read(0, 1), Value::Number(2.0));
        assert_eq!(s.read(5, 3), Value::Number(42.5));
        // Cells not written remain Blank.
        assert_eq!(s.read(10, 10), Value::Blank);
    }

    #[test]
    fn roundtrip_with_all_value_variants() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with(
            "S",
            &[
                cell(0, 0, Value::Number(42.0)),
                cell(0, 1, Value::Boolean(true)),
                cell(0, 2, Value::Boolean(false)),
                cell(0, 3, Value::Text(Arc::from("hello"))),
                cell(0, 4, Value::Error(ErrorValue::DivZero)),
                cell(0, 5, Value::Error(ErrorValue::Ref)),
                cell(0, 6, Value::Error(ErrorValue::AINotAvailable)),
            ],
        );
        save_workbook(&wb, "v", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        let s = loaded.sheet(0).unwrap();
        assert_eq!(s.read(0, 0), Value::Number(42.0));
        assert_eq!(s.read(0, 1), Value::Boolean(true));
        assert_eq!(s.read(0, 2), Value::Boolean(false));
        assert_eq!(s.read(0, 3), Value::text("hello"));
        assert_eq!(s.read(0, 4), Value::Error(ErrorValue::DivZero));
        assert_eq!(s.read(0, 5), Value::Error(ErrorValue::Ref));
        assert_eq!(s.read(0, 6), Value::Error(ErrorValue::AINotAvailable));
    }

    #[test]
    fn roundtrip_multi_sheet() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ms.qbook");

        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("First");
        let s2 = wb.add_sheet("Second");
        wb.put_at(s1, 0, 0, Value::Number(100.0));
        wb.put_at(s2, 0, 0, Value::Number(200.0));

        save_workbook(&wb, "ms", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert_eq!(loaded.sheet_count(), 2);
        assert_eq!(loaded.sheet(0).unwrap().name(), "First");
        assert_eq!(loaded.sheet(1).unwrap().name(), "Second");
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(100.0));
        assert_eq!(loaded.sheet(1).unwrap().read(0, 0), Value::Number(200.0));
    }

    #[test]
    fn roundtrip_preserves_text_with_special_chars() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.qbook");
        let s = "line1\nline2\t\"quoted\" and \\backslash and unicode: λ";
        let wb = wb_with("S", &[cell(0, 0, Value::Text(Arc::from(s)))]);
        save_workbook(&wb, "t", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.sheet(0).unwrap().read(0, 0),
            Value::Text(Arc::from(s))
        );
    }

    #[test]
    fn blank_cells_are_skipped_in_jsonl() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sparse.qbook");
        // Two distant cells with vast Blank space between.
        let wb = wb_with(
            "S",
            &[
                cell(0, 0, Value::Number(1.0)),
                cell(100, 100, Value::Number(2.0)),
            ],
        );
        save_workbook(&wb, "s", &path).unwrap();

        // Read the JSONL directly; expect exactly 2 non-empty lines.
        let jsonl = fs::read_to_string(path.join("sheets/0.jsonl")).unwrap();
        let lines: Vec<&str> = jsonl.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2, "blanks should NOT be emitted");
    }

    // ===== schema version enforcement =====

    #[test]
    fn unsupported_schema_version_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Hand-write an envelope with a bogus schema version.
        fs::write(
            path.join("workbook.toml"),
            "schema_version = 999\nname = \"x\"\nsheets = []\n",
        )
        .unwrap();

        match load_workbook(&path) {
            Err(QbookError::UnsupportedSchema { found: 999 }) => {}
            other => panic!("expected UnsupportedSchema(999), got {other:?}"),
        }
    }

    #[test]
    fn missing_workbook_toml_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.qbook");
        fs::create_dir_all(&path).unwrap();

        match load_workbook(&path) {
            Err(QbookError::MissingFile { .. }) => {}
            other => panic!("expected MissingFile, got {other:?}"),
        }
    }

    #[test]
    fn nonexistent_path_errors() {
        let path = std::path::Path::new("/nonexistent/path/does/not/exist.qbook");
        match load_workbook(path) {
            Err(QbookError::NotADirectory { .. }) => {}
            other => panic!("expected NotADirectory, got {other:?}"),
        }
    }

    #[test]
    fn malformed_jsonl_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");

        // First write a valid workbook to set up the directory structure.
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();

        // Now corrupt the sheet's JSONL.
        fs::write(path.join("sheets/0.jsonl"), "this is not json\n").unwrap();

        match load_workbook(&path) {
            Err(QbookError::MalformedCell { line: 1, .. }) => {}
            other => panic!("expected MalformedCell at line 1, got {other:?}"),
        }
    }

    /// Audit H4 regression (2026-05-12): out-of-bounds row in a JSONL cell record
    /// used to panic inside Sheet::put. Now: clean MalformedCell error with the
    /// line number and a row-bound message.
    #[test]
    fn row_over_max_row_errors_not_panics() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oob.qbook");

        // Set up a valid workbook then overwrite the JSONL with an out-of-bounds row.
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();
        // u32::MAX is well over Excel's MAX_ROW = 1_048_575.
        fs::write(
            path.join("sheets/0.jsonl"),
            "{\"row\":4294967295,\"col\":0,\"value\":{\"Number\":1.0}}\n",
        )
        .unwrap();

        match load_workbook(&path) {
            Err(QbookError::MalformedCell { detail, .. }) => {
                assert!(
                    detail.contains("MAX_ROW"),
                    "detail should mention MAX_ROW: {detail:?}"
                );
            }
            other => panic!("expected MalformedCell mentioning MAX_ROW, got {other:?}"),
        }
    }

    #[test]
    fn col_over_max_col_errors_not_panics() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oob_col.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();
        // u32::MAX > MAX_COLUMN = 16_383.
        fs::write(
            path.join("sheets/0.jsonl"),
            "{\"row\":0,\"col\":4294967295,\"value\":{\"Number\":1.0}}\n",
        )
        .unwrap();

        match load_workbook(&path) {
            Err(QbookError::MalformedCell { detail, .. }) => {
                assert!(
                    detail.contains("MAX_COLUMN"),
                    "detail should mention MAX_COLUMN: {detail:?}"
                );
            }
            other => panic!("expected MalformedCell mentioning MAX_COLUMN, got {other:?}"),
        }
    }

    /// Audit M2 regression (2026-05-12): missing sheet JSONL used to silently treat
    /// the sheet as empty. Now: MissingFile error.
    #[test]
    fn missing_sheet_jsonl_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("partial.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "x", &path).unwrap();

        // Delete the sheet's JSONL while keeping the envelope intact.
        fs::remove_file(path.join("sheets/0.jsonl")).unwrap();

        match load_workbook(&path) {
            Err(QbookError::MissingFile { file }) => {
                assert!(file.to_string_lossy().contains("0.jsonl"));
            }
            other => panic!("expected MissingFile for sheets/0.jsonl, got {other:?}"),
        }
    }

    /// Audit M3 regression (2026-05-12): sheet IDs in envelope must be sequential 0..N.
    /// Previously a panic; now a Result error.
    #[test]
    fn non_sequential_sheet_ids_errors_not_panics() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_ids.qbook");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Hand-write an envelope with non-sequential IDs ([0, 2] — skips 1).
        fs::write(
            path.join("workbook.toml"),
            r#"schema_version = 1
name = "x"

[[sheets]]
id = 0
name = "S0"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[sheets]]
id = 2
name = "S2"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#,
        )
        .unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join("sheets/2.jsonl"), "").unwrap();

        match load_workbook(&path) {
            Err(QbookError::NonSequentialSheetIds {
                expected: 1,
                found: 2,
            }) => {}
            other => panic!("expected NonSequentialSheetIds {{1,2}}, got {other:?}"),
        }
    }

    /// Audit H5 regression (2026-05-12): chunk_rows used to be a known lie in the
    /// envelope because no public accessor existed on Sheet. Now Sheet::chunk_rows()
    /// is the source of truth, and the envelope reflects the actual layout.
    #[test]
    fn chunk_rows_envelope_reflects_actual_sheet_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("chunks.qbook");

        // Construct a workbook where the sheet has chunk_rows = 64 (not the default
        // 16384 or env value).
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet_with_chunk_rows("Tiny", 64);
        wb.put_at(sheet_id, 0, 0, Value::Number(1.0));
        save_workbook(&wb, "x", &path).unwrap();

        let toml_str = fs::read_to_string(path.join("workbook.toml")).unwrap();
        let env: WorkbookEnvelope = toml::from_str(&toml_str).unwrap();
        assert_eq!(
            env.sheets[0].chunk_rows, 64,
            "envelope must report actual chunk_rows"
        );

        // Round-trip: the loaded sheet must report the same chunk_rows.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(sheet_id).unwrap().chunk_rows(), 64);
    }

    // ===== envelope content =====

    #[test]
    fn envelope_contains_expected_metadata() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("meta.qbook");
        let wb = wb_with("Inventory", &[cell(2, 4, Value::Number(99.0))]);
        save_workbook(&wb, "my workbook", &path).unwrap();

        let toml_str = fs::read_to_string(path.join("workbook.toml")).unwrap();
        let env: WorkbookEnvelope = toml::from_str(&toml_str).unwrap();
        assert_eq!(env.schema_version, WORKBOOK_SCHEMA_VERSION); // Phase 2A.8: now 2
        assert_eq!(env.name, "my workbook");
        assert_eq!(env.sheets.len(), 1);
        assert_eq!(env.sheets[0].name, "Inventory");
        assert_eq!(env.sheets[0].id, 0);
        // Bounds: row 2, col 4 → row_extent = 3, col_extent = 5.
        assert_eq!(env.sheets[0].row_extent, 3);
        assert_eq!(env.sheets[0].col_extent, 5);
    }

    // ===== CellWireValue conversions =====

    #[test]
    fn wire_value_blank_is_none() {
        assert!(CellWireValue::from_value(&Value::Blank).is_none());
    }

    #[test]
    fn wire_value_error_canonical_text() {
        assert_eq!(error_to_canonical_text(ErrorValue::Ref), "#REF!");
        assert_eq!(error_to_canonical_text(ErrorValue::DivZero), "#DIV/0!");
        assert_eq!(
            error_to_canonical_text(ErrorValue::AINotAvailable),
            "#AI_NOT_AVAILABLE_V1"
        );
    }

    #[test]
    fn wire_value_error_roundtrip_all_variants() {
        for e in ql_types::ErrorValue::ALL.iter() {
            let wire = CellWireValue::Error(error_to_canonical_text(*e));
            let v = wire.to_value().unwrap();
            assert_eq!(v, Value::Error(*e), "round-trip failed for {e:?}");
        }
    }

    #[test]
    fn wire_value_unknown_error_text_errors() {
        // Tier D2 (2026-05-19): `to_value` now returns `WireDecodeError`
        // not `QbookError`. The unknown-sigil variant is
        // `WireDecodeError::UnknownErrorSigil`.
        let wire = CellWireValue::Error("#NOT_A_REAL_ERROR".to_string());
        let result = wire.to_value();
        assert!(matches!(
            result,
            Err(WireDecodeError::UnknownErrorSigil { .. })
        ));
    }

    // ===== nan / inf handling =====

    #[test]
    fn nan_inf_become_num_error_via_value_constructor() {
        // Even if a Number(NaN) somehow got serialized (it can't from Value::number,
        // but a buggy external writer could try), to_value sanitizes via Value::number.
        let wire = CellWireValue::Number(f64::NAN);
        let v = wire.to_value().unwrap();
        assert_eq!(v, Value::Error(ErrorValue::Num));
    }

    /// Audit M6 fix (2026-05-12): file-level NaN handling. serde_json silently
    /// encodes NaN as `null`, producing files that fail to load — a silent
    /// corruption. Save-side validation rejects NaN/Inf explicitly with a
    /// NonFiniteNumber error carrying the cell coordinates.
    #[test]
    fn save_with_nan_value_errors_cleanly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nan-save.qbook");

        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("S");
        // Bypass Value::number sanitizer by using the pub enum variant directly.
        wb.put_at(sheet_id, 5, 3, Value::Number(f64::NAN));

        match save_workbook(&wb, "nan-test", &path) {
            Err(QbookError::NonFiniteNumber {
                sheet,
                row,
                col,
                value,
            }) => {
                assert_eq!(sheet, sheet_id);
                assert_eq!(row, 5);
                assert_eq!(col, 3);
                assert!(value.is_nan());
            }
            other => panic!("expected NonFiniteNumber error, got {other:?}"),
        }
        // After a failed save, the target should NOT exist (atomic-save guarantee).
        assert!(
            !path.exists(),
            "atomic-save invariant violated: target exists after failed save at {path:?}"
        );
    }

    #[test]
    fn save_with_inf_value_errors_cleanly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("inf-save.qbook");

        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("S");
        wb.put_at(sheet_id, 0, 0, Value::Number(f64::INFINITY));

        match save_workbook(&wb, "inf-test", &path) {
            Err(QbookError::NonFiniteNumber { value, .. }) => {
                assert!(value.is_infinite());
            }
            other => panic!("expected NonFiniteNumber error, got {other:?}"),
        }
        // Atomic-save invariant: target absent after failed save.
        assert!(!path.exists());
    }

    #[test]
    fn save_with_neg_inf_value_errors_cleanly() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("neg-inf-save.qbook");

        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("S");
        wb.put_at(sheet_id, 0, 0, Value::Number(f64::NEG_INFINITY));

        let result = save_workbook(&wb, "neg-inf-test", &path);
        assert!(matches!(result, Err(QbookError::NonFiniteNumber { .. })));
        assert!(!path.exists());
    }

    // ===== atomic save (audit M4 fix) =====

    // ===== W5-9: formula round-trip =====

    /// W5-9: formula cells survive save → load round-trip with both the formula text
    /// AND the evaluated value preserved.
    #[test]
    fn roundtrip_formula_with_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("f.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Cell (0, 0) has a literal value.
        wb.put_at(s, 0, 0, Value::Number(5.0));
        // Cell (1, 0) has BOTH a value and a formula.
        wb.put_at(s, 1, 0, Value::Number(15.0));
        wb.put_formula(s, 1, 0, "A1 * 3");

        save_workbook(&wb, "formulas", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        // Literal cell.
        assert_eq!(loaded.sheet(s).unwrap().read(0, 0), Value::Number(5.0));
        assert!(loaded.formula_at(s, 0, 0).is_none());
        // Formula cell.
        assert_eq!(loaded.sheet(s).unwrap().read(1, 0), Value::Number(15.0));
        assert_eq!(
            loaded.formula_at(s, 1, 0).map(|s| s.as_ref()),
            Some("A1 * 3")
        );
    }

    #[test]
    fn roundtrip_formula_only_cell_outside_bounds() {
        // A formula cell at (100, 100) where the sheet's value-bounds extent is (0, 0)
        // — pure formula-only state. Should survive round-trip via the formula-positions
        // emit path.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fonly.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 100, 100, "SUM(A:A)");
        // Note: NO put_at for (100, 100). bounds stays at (0, 0).

        save_workbook(&wb, "fonly", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert_eq!(
            loaded.formula_at(s, 100, 100).map(|s| s.as_ref()),
            Some("SUM(A:A)")
        );
        // Phase 2A.8 audit M11: formula-only Blank cells round-trip via the
        // Pending wire variant, which decodes to Value::Blank (was: #NULL!
        // sentinel, which conflated with a real spreadsheet error).
        assert_eq!(loaded.sheet(s).unwrap().read(100, 100), Value::Blank);
    }

    #[test]
    fn roundtrip_multiple_formulas_across_sheets() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("multi-f.qbook");

        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Sheet1");
        let s2 = wb.add_sheet("Sheet2");
        wb.put_at(s1, 0, 0, Value::Number(1.0));
        wb.put_formula(s1, 0, 0, "1");
        wb.put_at(s2, 5, 5, Value::Number(99.0));
        wb.put_formula(s2, 5, 5, "B5 + 1");

        save_workbook(&wb, "multi", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert_eq!(loaded.formula_count(), 2);
        assert_eq!(loaded.formula_at(s1, 0, 0).map(|s| s.as_ref()), Some("1"));
        assert_eq!(
            loaded.formula_at(s2, 5, 5).map(|s| s.as_ref()),
            Some("B5 + 1")
        );
    }

    #[test]
    fn old_schema_v1_files_without_formula_field_load_as_literal_only() {
        // Backwards-compat: a CellRecord JSON missing the `formula` field (old W5-6
        // schema-v1-format files) deserializes with formula = None via serde default.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        fs::write(
            path.join("workbook.toml"),
            r#"schema_version = 1
name = "legacy"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 1
col_extent = 1
"#,
        )
        .unwrap();
        // No `formula` field — emulates the W5-6 format.
        fs::write(
            path.join("sheets/0.jsonl"),
            "{\"row\":0,\"col\":0,\"value\":{\"Number\":7.0}}\n",
        )
        .unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(7.0));
        assert!(loaded.formula_at(0, 0, 0).is_none());
        assert_eq!(loaded.formula_count(), 0);
    }

    /// Audit M4 acceptance (2026-05-12): a successful save replaces the target
    /// atomically via a sibling temp dir + rename. No temp leftover after success.
    #[test]
    fn atomic_save_leaves_no_temp_or_backup_after_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("atomic.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "atomic-test", &path).unwrap();
        assert!(path.exists(), "target should exist after save");

        // Phase 2A.8: after a successful save, neither `<base>.tmp-save-*`
        // nor `<base>.bak-*` sibling should remain.
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        let parent = path.parent().unwrap();
        for entry in std::fs::read_dir(parent).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(&format!("{basename}.tmp-save-")),
                "found leftover temp sibling: {name}"
            );
            assert!(
                !name.starts_with(&format!("{basename}.bak-")),
                "found leftover backup sibling: {name}"
            );
        }
    }

    /// Phase 2A.8 (was Audit M4): a failed save does NOT clobber the existing
    /// target. Pre-populate target with one workbook, then attempt to save a
    /// NaN-bearing workbook (which the save-side NaN guard will reject). The
    /// pre-existing target must remain readable and unchanged.
    #[test]
    fn failed_save_does_not_clobber_target() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preserved.qbook");

        // First, write a valid workbook with known content.
        let original = wb_with("S", &[cell(0, 0, Value::Number(42.0))]);
        save_workbook(&original, "first", &path).unwrap();
        assert!(path.exists());

        // Attempt a save that will fail (NaN-bearing).
        let mut bad_wb = Workbook::new();
        let sheet_id = bad_wb.add_sheet("S");
        bad_wb.put_at(sheet_id, 0, 0, Value::Number(f64::NAN));
        let result = save_workbook(&bad_wb, "bad", &path);
        assert!(result.is_err(), "expected save to fail");

        // Target must still exist with the original content.
        assert!(path.exists(), "target was clobbered by failed save");
        let reloaded = load_workbook(&path).unwrap();
        assert_eq!(reloaded.sheet(0).unwrap().read(0, 0), Value::Number(42.0));

        // No orphan temp/backup siblings.
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        let parent = path.parent().unwrap();
        for entry in std::fs::read_dir(parent).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(&format!("{basename}.tmp-save-"))
                    && !name.starts_with(&format!("{basename}.bak-")),
                "found orphan sibling: {name}"
            );
        }
    }

    /// Phase 2A.8 audit H2 recovery test — roll-forward case. Simulate a
    /// crash after step 3 (rename temp → target succeeded) but before step 4
    /// (backup cleanup): an orphan `.bak-*` sibling exists, AND the target is
    /// a valid workbook. Recovery should clean up the orphan and load the
    /// target normally.
    ///
    /// Phase 2A.13 audit cycle-3 H1 update: the orphan also needs the
    /// `.atomic-save-marker-v1` file inside it; otherwise recovery treats it
    /// as a user-created sibling and leaves it alone.
    #[test]
    fn load_recovers_orphan_backup_when_target_valid_roll_forward() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rollforward.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(7.0))]);
        save_workbook(&wb, "rollforward", &path).unwrap();

        // Manually create an orphan .bak-* sibling alongside the (valid)
        // target. Loader should detect and remove it.
        let bak = path.parent().unwrap().join(format!(
            "{}.bak-deadbeef",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&bak).unwrap();
        fs::write(bak.join("workbook.toml"), "garbage that won't parse").unwrap();
        // H1: mark this orphan as engine-owned so recovery acts on it.
        fs::write(bak.join(ATOMIC_SAVE_MARKER_FILENAME), "engine-owned").unwrap();
        assert!(bak.exists());

        // Load: should succeed AND clean up the orphan.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(7.0));
        assert!(!bak.exists(), "load should have cleaned up the orphan .bak");
    }

    /// Phase 2A.13 audit cycle-3 H1: a user-created sibling directory whose
    /// name happens to match the `.bak-*` prefix is NOT engine-owned and
    /// recovery must leave it alone. Closes the megaudit's `book.qbook.bak-
    /// 2025-review` data-loss vector.
    #[test]
    fn load_does_not_touch_user_created_sibling_lacking_marker() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("user-sibling.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(42.0))]);
        save_workbook(&wb, "user-sibling", &path).unwrap();

        // Plant a user-created sibling matching the .bak-* prefix but
        // lacking the engine marker. Could be a manual backup the user
        // made, e.g. `mybook.qbook.bak-2025-review/`.
        let user_sibling = path.parent().unwrap().join(format!(
            "{}.bak-2025-review",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&user_sibling).unwrap();
        fs::write(user_sibling.join("notes.md"), "my own backup, don't touch").unwrap();
        assert!(!is_engine_owned_backup(&user_sibling));

        // Load: succeeds, leaves the user's sibling intact.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(42.0));
        assert!(
            user_sibling.exists(),
            "recovery must NOT touch user-created marker-less siblings"
        );
        assert_eq!(
            fs::read_to_string(user_sibling.join("notes.md")).unwrap(),
            "my own backup, don't touch"
        );
    }

    /// Phase 2A.8 audit H2 recovery test — rollback case. Simulate a crash
    /// after step 2 (target renamed to backup) but before step 3 (temp →
    /// target completed): backup exists with a valid envelope, target does
    /// not exist. Recovery should rename the backup back to the target.
    #[test]
    fn load_recovers_orphan_backup_when_target_missing_rollback() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rollback.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(99.0))]);
        save_workbook(&wb, "rollback", &path).unwrap();

        // Simulate the post-step-2 state: rename the valid target to a .bak.
        let bak = path.parent().unwrap().join(format!(
            "{}.bak-deadbeef",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::rename(&path, &bak).unwrap();
        assert!(bak.exists());
        assert!(!path.exists(), "target should be temporarily missing");

        // Load: recovery rolls back from .bak to target, then loads normally.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(99.0));
        assert!(path.exists(), "target should exist after recovery");
        assert!(!bak.exists(), "backup should be consumed by rollback");
    }

    /// Phase 2A.13 audit cycle-3 M6: multiple orphan `.bak-*` siblings WITH a
    /// valid target are all stale (the most-recent successful save left a
    /// valid target; any older backups failed step-4 cleanup). Clean them
    /// all up; the load succeeds. Previously refused with InvalidPath,
    /// creating a permanent deadlock under repeated step-4 failures.
    #[test]
    fn load_cleans_all_orphans_when_target_valid_post_2a13() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("multi-stale.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "multi-stale", &path).unwrap();

        // Plant TWO engine-owned orphan .bak-* siblings.
        let parent = path.parent().unwrap();
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        let baks: Vec<_> = ["aaa", "bbb"]
            .iter()
            .map(|tag| {
                let bak = parent.join(format!("{basename}.bak-{tag}"));
                fs::create_dir_all(&bak).unwrap();
                fs::write(bak.join(ATOMIC_SAVE_MARKER_FILENAME), "engine-owned").unwrap();
                bak
            })
            .collect();

        // Load: target is valid → both orphans get cleaned, load succeeds.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(0).unwrap().read(0, 0), Value::Number(1.0));
        for bak in &baks {
            assert!(!bak.exists(), "orphan {bak:?} should have been cleaned up");
        }
    }

    /// Phase 2A.13 audit cycle-3 M6: multi-orphan case WITH a missing/invalid
    /// target remains genuinely ambiguous (which backup matches the missing
    /// target?). Refuse to load with InvalidPath so the user resolves
    /// manually. Verifies the narrowed refusal condition.
    #[test]
    fn load_refuses_when_multiple_orphans_and_target_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ambiguous-missing.qbook");

        // Plant two engine-owned orphans BUT no target.
        let parent = path.parent().unwrap();
        let basename = path.file_name().unwrap().to_string_lossy().into_owned();
        for tag in ["aaa", "bbb"] {
            let bak = parent.join(format!("{basename}.bak-{tag}"));
            fs::create_dir_all(&bak).unwrap();
            fs::write(bak.join(ATOMIC_SAVE_MARKER_FILENAME), "engine-owned").unwrap();
        }

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::InvalidPath { .. })),
            "expected InvalidPath for ambiguous recovery, got {result:?}"
        );
    }

    /// Phase 2A.8 audit M10: per-save random suffix means concurrent saves
    /// from two threads don't share temp/backup paths. Direct test of the
    /// suffix generator running quickly in sequence (simulating the
    /// concurrent case): two consecutive calls produce distinct suffixes.
    #[test]
    fn save_session_suffix_is_distinct_per_call() {
        let s1 = save_session_suffix();
        // A small sleep to ensure the nanos differ on platforms with coarser
        // clock resolution.
        std::thread::sleep(std::time::Duration::from_nanos(1));
        let s2 = save_session_suffix();
        assert_ne!(s1, s2, "save_session_suffix must produce unique values");
    }

    /// Phase 2A.13 audit cycle-3 H5: save refuses if the target path exists
    /// but is a regular file (not a directory). Prior behavior would have
    /// silently renamed the user's file to `.bak-<suffix>` and installed
    /// the workbook directory in its place, orphaning the user's file.
    #[test]
    fn save_refuses_when_target_is_a_regular_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("conflict.qbook");
        // Plant a regular file at the target path. (The user's mistake;
        // the engine doesn't enforce that `.qbook` paths are directories.)
        fs::write(&path, b"this is a regular file, not a workbook").unwrap();
        assert!(path.is_file());

        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        let result = save_workbook(&wb, "conflict", &path);
        match result {
            Err(QbookError::InvalidPath { path: p, reason }) => {
                assert_eq!(p, path);
                assert!(reason.contains("not a directory"));
            }
            other => panic!("expected InvalidPath, got {other:?}"),
        }
        // The user's file is intact.
        assert!(path.is_file());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "this is a regular file, not a workbook"
        );
    }

    /// Phase 2A.8 audit M9 (deny_unknown_fields): a workbook.toml with an
    /// unrecognized field at the envelope level is rejected loudly.
    #[test]
    fn load_rejects_unknown_envelope_field() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("extra-field.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(1.0))]);
        save_workbook(&wb, "extra", &path).unwrap();

        // Inject an extra field into workbook.toml.
        let toml_path = path.join("workbook.toml");
        let mut contents = fs::read_to_string(&toml_path).unwrap();
        contents.push_str("\nunknown_future_field = \"hello\"\n");
        fs::write(&toml_path, contents).unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::TomlDe(_))),
            "expected TomlDe error for unknown envelope field, got {result:?}"
        );
    }

    /// Phase 2A.8 audit M12: NameTable round-trips through save/load.
    #[test]
    fn name_table_round_trip_through_save_load() {
        use std::sync::Arc;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("names.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(7.0));
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        wb.set_name("AnchorA1", NamedTarget::Cell(Address::new(s, 0, 0)))
            .unwrap();
        wb.set_name(
            "SalesRange",
            NamedTarget::Range(Range::new(s, 1, 0, 100, 3)),
        )
        .unwrap();
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("Revenue - Costs")))
            .unwrap();

        save_workbook(&wb, "names", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        // All four names survive.
        assert_eq!(loaded.names().len(), 4);
        assert!(matches!(
            loaded.names().lookup("TAXRATE"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        assert!(matches!(
            loaded.names().lookup("ANCHORA1"),
            Some(NamedTarget::Cell(_))
        ));
        assert!(matches!(
            loaded.names().lookup("SALESRANGE"),
            Some(NamedTarget::Range(_))
        ));
        assert!(matches!(
            loaded.names().lookup("PROFIT"),
            Some(NamedTarget::Formula(_))
        ));
    }

    // ===== W5-71 Phase 4.5.A.2 — date_system v2→v3 migration =====

    #[test]
    fn date_system_excel1900_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ds_1900.qbook");
        let mut wb = Workbook::new();
        // Default is Excel1900; verify it survives save/load.
        wb.add_sheet("S");
        assert_eq!(wb.date_system(), ql_types::DateSystem::Excel1900);
        save_workbook(&wb, "ds_1900", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.date_system(), ql_types::DateSystem::Excel1900);
    }

    #[test]
    fn date_system_excel1904_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ds_1904.qbook");
        let mut wb = Workbook::new();
        wb.set_date_system(ql_types::DateSystem::Excel1904);
        wb.add_sheet("S");
        save_workbook(&wb, "ds_1904", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.date_system(), ql_types::DateSystem::Excel1904);
    }

    #[test]
    fn v2_envelope_missing_date_system_loads_as_excel1900() {
        // Hand-craft a v2 envelope without the new field; expect the v3
        // reader to default-load as Excel1900.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v2.qbook");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::create_dir_all(path.join("sheets")).unwrap();
        let v2_toml = r#"
schema_version = 2
name = "legacy_v2"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        std::fs::write(path.join("workbook.toml"), v2_toml).unwrap();
        // Empty sheet JSONL.
        std::fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        // Engine-owned marker (so recovery passes).
        std::fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        // Default date_system on missing field is Excel1900.
        assert_eq!(loaded.date_system(), ql_types::DateSystem::Excel1900);
    }

    #[test]
    fn date_system_wire_round_trip() {
        // Pure type-level test: wire enum round-trips runtime enum.
        for ds in [
            ql_types::DateSystem::Excel1900,
            ql_types::DateSystem::Excel1904,
        ] {
            let wire = DateSystemWire::from_runtime(ds);
            assert_eq!(wire.to_runtime(), ds);
        }
    }

    // ===== W5-81 Phase 4.5.D part 5 — formats + overlay v3→v4 migration =====

    #[test]
    fn empty_format_table_round_trips_without_persisting_builtins() {
        // A fresh workbook has the pre-seeded built-ins in its FormatTable
        // but no CUSTOM entries. Save should omit the `formats` section
        // entirely so v3-style envelopes still produce minimal TOML.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty_formats.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        save_workbook(&wb, "empty_formats", &path).unwrap();
        // Round-trip: built-ins still present after load.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId::Builtin(14)),
            Some("m/d/yyyy")
        );
        // The TOML envelope should NOT contain a `[formats]` table (built-
        // ins aren't persisted; the section is None when empty).
        let toml_str = std::fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(
            !toml_str.contains("[formats]") && !toml_str.contains("formats ="),
            "envelope must omit empty formats section, got:\n{toml_str}"
        );
    }

    #[test]
    fn custom_format_round_trips_through_save_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("custom_formats.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        // Intern two custom formats.
        let id_a = wb.formats_mut().intern("\"⚓\" #,##0.00");
        let id_b = wb.formats_mut().intern("0.0000");
        // Step 3: first custom = Custom(LEGACY_PEER, 0); legacy u32 = 164.
        // Second custom = Custom(LEGACY_PEER, 1); legacy u32 = 165.
        assert_eq!(
            id_a.to_legacy_u32(),
            Some(ql_storage::FIRST_CUSTOM_FORMAT_ID)
        );
        assert_eq!(
            id_b.to_legacy_u32(),
            Some(ql_storage::FIRST_CUSTOM_FORMAT_ID + 1)
        );
        save_workbook(&wb, "custom_formats", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        // Both custom entries survive.
        assert_eq!(loaded.formats().lookup(id_a), Some("\"⚓\" #,##0.00"));
        assert_eq!(loaded.formats().lookup(id_b), Some("0.0000"));
        // Built-ins still present too.
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId::Builtin(0)),
            Some("General")
        );
    }

    #[test]
    fn per_sheet_format_overlay_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("overlay.qbook");
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("A");
        let s1 = wb.add_sheet("B");
        // Bind cells on both sheets to different built-in ids.
        wb.sheet_mut(s0)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, ql_storage::FormatId::Builtin(14)); // m/d/yyyy
        wb.sheet_mut(s0)
            .unwrap()
            .format_overlay_mut()
            .set(3, 5, ql_storage::FormatId::Builtin(4)); // #,##0.00
        wb.sheet_mut(s1).unwrap().format_overlay_mut().set(
            10,
            20,
            ql_storage::FormatId::Builtin(49),
        ); // @
        save_workbook(&wb, "overlay", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        // Sheet A overlay round-trips.
        assert_eq!(
            loaded.sheet(s0).unwrap().format_overlay().get(0, 0),
            Some(ql_storage::FormatId::Builtin(14))
        );
        assert_eq!(
            loaded.sheet(s0).unwrap().format_overlay().get(3, 5),
            Some(ql_storage::FormatId::Builtin(4))
        );
        // Sheet B overlay round-trips.
        assert_eq!(
            loaded.sheet(s1).unwrap().format_overlay().get(10, 20),
            Some(ql_storage::FormatId::Builtin(49))
        );
        // Sheet A doesn't see Sheet B's binding.
        assert_eq!(loaded.sheet(s0).unwrap().format_overlay().get(10, 20), None);
    }

    // -- M7 (6.3-2b): effective-extent save --------------------------------------

    #[test]
    fn m7_format_only_cell_outside_value_bbox_survives_narrowed_walk() {
        // A format-only cell (blank value, no formula) far outside the value extent
        // must survive — it rides the bounds-independent envelope format_overlay
        // section, not the (now narrowed) JSONL value-walk.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fmt_only.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1.0)); // value extent = just (0,0)
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(50, 7, ql_storage::FormatId::Builtin(14)); // far format-only cell
        save_workbook(&wb, "fmt_only", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.sheet(s).unwrap().format_overlay().get(50, 7),
            Some(ql_storage::FormatId::Builtin(14)),
            "format-only cell must survive the narrowed value-walk"
        );
    }

    #[test]
    fn m7_formula_only_blank_cell_outside_value_bbox_survives() {
        // A formula-only cell whose value is Blank, positioned far outside the value
        // extent, is caught by the formula-only pass (not the narrowed value-walk).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fml_only.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1.0)); // value extent = just (0,0)
        wb.put_formula(s, 200, 200, "SUM(A:A)"); // formula-only, Blank value, far away
        save_workbook(&wb, "fml_only", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.formula_at(s, 200, 200).map(|f| f.as_ref()),
            Some("SUM(A:A)"),
            "formula-only cell outside the value bbox must survive"
        );
    }

    #[test]
    fn m7_envelope_extent_is_honest_union_not_inflated_bounds() {
        // Envelope row_extent/col_extent = union(value, formula, format) footprint,
        // tight to real data — NOT the conservative Sheet::bounds (which a far Blank
        // inflates).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("env_extent.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        wb.put_at(s, 9, 9, Value::Blank); // inflates Sheet::bounds to {10,10}
        wb.put_formula(s, 3, 4, "A1"); // formula extends the union to row 4, col 5
        save_workbook(&wb, "env_extent", &path).unwrap();
        let toml_str = fs::read_to_string(path.join("workbook.toml")).unwrap();
        let env: WorkbookEnvelope = toml::from_str(&toml_str).unwrap();
        // Union of value bbox {1,1} and formula at (3,4) -> {4,5}; the far Blank is excluded.
        assert_eq!(
            env.sheets[0].row_extent, 4,
            "envelope row_extent must be the tight union"
        );
        assert_eq!(
            env.sheets[0].col_extent, 5,
            "envelope col_extent must be the tight union"
        );
    }

    #[test]
    fn m7_trailing_blank_shrink_full_round_trip_stable() {
        // Values + a far explicit Blank: the save/load round-trip preserves all real
        // cells while the inflated trailing region is dropped.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("shrink.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        wb.put_at(s, 1, 1, Value::text("x"));
        wb.put_at(s, 40, 40, Value::Blank); // inflates bounds only
        save_workbook(&wb, "shrink", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet(s).unwrap().read(0, 0), Value::Number(1.0));
        assert_eq!(loaded.sheet(s).unwrap().read(1, 1), Value::text("x"));
        // The far Blank carried no data and is gone (reads Blank either way).
        assert_eq!(loaded.sheet(s).unwrap().read(40, 40), Value::Blank);
    }

    #[test]
    fn full_format_round_trip_custom_id_plus_overlay() {
        // Real-world path: intern a custom format, bind a cell to it,
        // round-trip, verify everything survives.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("full.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        let fmt = "\"$\"#,##0.00;[Red]\"$\"#,##0.00"; // V1 parser doesn't
                                                      // support [Red] but the parser refuses LATE; the FormatTable doesn't
                                                      // call the parser at registration — it just interns the string.
                                                      // Use a parser-friendly format here for symmetry with future tests.
        let _ = fmt; // silence unused
        let id = wb.formats_mut().intern("\"€\" #,##0.00");
        wb.sheet_mut(s).unwrap().format_overlay_mut().set(2, 1, id);
        save_workbook(&wb, "full", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        let loaded_id = loaded.sheet(s).unwrap().format_overlay().get(2, 1).unwrap();
        assert_eq!(loaded_id, id);
        assert_eq!(loaded.formats().lookup(loaded_id), Some("\"€\" #,##0.00"));
    }

    // ===== FE-4 W4 — style table + overlay .qbook round-trip (v9) =====

    #[test]
    fn full_style_round_trip_with_all_borders() {
        // Acceptance #4 + #11 (.qbook half): intern a fully-bordered style,
        // bind a cell, round-trip, verify the StyleTable interns it distinctly
        // AND every per-edge {style,color} survives save→load.
        use ql_storage::{BorderEdge, BorderStyle, Borders, HAlign, Rgb, Style};
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("styles.qbook");
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        let edge = BorderEdge {
            style: BorderStyle::Double,
            color: Rgb::new(0x11, 0x22, 0x33),
        };
        let rich = Style {
            bold: true,
            italic: true,
            fill: Some(Rgb::new(0xab, 0xcd, 0xef)),
            align: HAlign::Center,
            borders: Borders {
                top: edge,
                bottom: BorderEdge {
                    style: BorderStyle::Thin,
                    color: Rgb::new(1, 2, 3),
                },
                left: BorderEdge {
                    style: BorderStyle::Medium,
                    color: Rgb::new(4, 5, 6),
                },
                right: edge,
            },
        };
        let borderless = wb.styles_mut().intern(Style {
            bold: true,
            ..Style::default()
        });
        let rich_id = wb.styles_mut().intern(rich);
        assert_ne!(borderless, rich_id, "bordered interns distinctly");
        wb.sheet_mut(s)
            .unwrap()
            .style_overlay_mut()
            .set(2, 1, rich_id);
        wb.sheet_mut(s)
            .unwrap()
            .style_overlay_mut()
            .set(0, 0, borderless);

        save_workbook(&wb, "styles", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        // Overlay survives.
        assert_eq!(
            loaded.sheet(s).unwrap().style_overlay().get(2, 1),
            Some(rich_id)
        );
        assert_eq!(
            loaded.sheet(s).unwrap().style_overlay().get(0, 0),
            Some(borderless)
        );
        // The full rich style (every border edge) survives.
        let got = loaded.styles().lookup(rich_id).unwrap();
        assert_eq!(got, rich, "every style sub-field must survive save→load");
        assert_eq!(got.borders.top.style, BorderStyle::Double);
        assert_eq!(got.borders.top.color, Rgb::new(0x11, 0x22, 0x33));
        assert_eq!(got.borders.bottom.style, BorderStyle::Thin);
        assert_eq!(got.borders.left.style, BorderStyle::Medium);
        assert_eq!(got.borders.right, edge);
        assert_eq!(got.fill, Some(Rgb::new(0xab, 0xcd, 0xef)));
        assert_eq!(got.align, HAlign::Center);
    }

    #[test]
    fn v8_envelope_without_styles_loads_clean() {
        // A v8 envelope (no styles/style_overlay sections) loads on the v9
        // reader with an empty StyleTable — backward compat.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v8.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let v8_toml = r#"
schema_version = 8
name = "legacy_v8"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        fs::write(path.join("workbook.toml"), v8_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert!(loaded.styles().is_empty());
        assert!(loaded.sheet(0).unwrap().style_overlay().is_empty());
    }

    #[test]
    fn v3_envelope_missing_formats_loads_with_defaults() {
        // Hand-craft a v3-style envelope without `formats` / `format_overlay`.
        // The v4 reader must default-load it cleanly with the pre-seeded
        // built-ins + empty overlays (regression-neutral).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v3.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let v3_toml = r#"
schema_version = 3
name = "legacy_v3"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        fs::write(path.join("workbook.toml"), v3_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        // Built-ins were re-seeded by FormatTable::default().
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId::Builtin(0)),
            Some("General")
        );
        // No custom entries.
        for id in ql_storage::FIRST_CUSTOM_FORMAT_ID..(ql_storage::FIRST_CUSTOM_FORMAT_ID + 10) {
            assert!(
                loaded
                    .formats()
                    .lookup(ql_storage::FormatId::legacy_from_u32(id))
                    .is_none(),
                "v3 envelope must not produce custom format at id {id}"
            );
        }
        // Empty overlay.
        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
    }

    #[test]
    fn malformed_format_id_collision_surfaces_as_error() {
        // Hand-craft a v4 envelope that tries to re-bind id 0 (General)
        // to a different string. The loader must surface
        // `MalformedFormat`.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_format.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let bad_toml = r#"
schema_version = 4
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[formats.entries]]
id = 0
string = "NOT_GENERAL"
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        // Phase 5.2 D-1 step 5: MalformedFormat.id changed u32 → FormatId.
        // The v4 envelope's `id = 0` migrates through `legacy_from_u32(0)`
        // = `Builtin(0)`.
        assert!(
            matches!(
                result,
                Err(QbookError::MalformedFormat {
                    id: ql_storage::FormatId::Builtin(0),
                    ..
                })
            ),
            "expected MalformedFormat(Builtin(0)), got {result:?}"
        );
    }

    #[test]
    fn malformed_format_overlay_out_of_range_surfaces_as_error() {
        // Hand-craft a v4 envelope with an out-of-range row in the
        // overlay. The loader must surface `MalformedFormatOverlay`.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_overlay.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // MAX_ROW is u32::MAX in `ql_types`; we use a far-too-large row.
        let row_too_big = u32::MAX;
        let bad_toml = format!(
            r#"
schema_version = 4
name = "bad_overlay"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[sheets.format_overlay]]
row = {row_too_big}
col = 0
id = 0
"#
        );
        fs::write(path.join("workbook.toml"), &bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                result,
                Err(QbookError::MalformedFormatOverlay { sheet: 0, .. })
            ),
            "expected MalformedFormatOverlay, got {result:?}"
        );
    }

    #[test]
    fn malformed_format_overlay_unregistered_id_surfaces_as_error() {
        // **W5-84 closure (Codex MEDIUM-3):** an overlay entry pointing
        // at an unregistered FormatId must surface as
        // `MalformedFormatOverlay` at load — not silently bind through
        // to a render-time General fallback.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("phantom_id_overlay.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // id 999 is NOT pre-populated as a built-in and not in any
        // `[[formats.entries]]` section, so it should never be bindable
        // by the loader. Mirrors runtime / replay's contract.
        let bad_toml = r#"
schema_version = 4
name = "phantom_id"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[sheets.format_overlay]]
row = 0
col = 0
id = 999
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                result,
                Err(QbookError::MalformedFormatOverlay {
                    sheet: 0,
                    row: 0,
                    col: 0,
                    why: "format id not registered in FormatTable",
                })
            ),
            "expected MalformedFormatOverlay(unregistered id), got {result:?}"
        );
    }

    // ===== Phase 5.2 D-1 step 5 (2026-05-20) — qbook envelope v7 → v8 =====

    /// **Step 5 fixture test:** hand-craft a v7 envelope with bare-u32
    /// FormatEntry + FormatOverlayEntry ids and verify the v8 loader's
    /// migration produces correct tagged-tuple FormatIds.
    ///
    /// Pre-step-5 this envelope had `id: u32` natively; post-step-5 the
    /// loader's `FormatEntryId::LegacyU32(n)` variant + `to_storage()`
    /// handle the migration. The test pins:
    /// - `n = 14` (built-in range) → `Builtin(14)` after migration.
    /// - `n = 164` (first custom in legacy encoding) → `Custom(LEGACY_PEER, 0)`.
    /// - `n = 200` (mid-range custom) → `Custom(LEGACY_PEER, 36)`.
    /// - Cell overlay binding to `n = 14` (built-in) resolves to `Builtin(14)`.
    /// - Cell overlay binding to `n = 200` resolves to the migrated Custom.
    #[test]
    fn v7_envelope_bare_u32_ids_migrate_to_tagged_tuple() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v7.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // v7 envelope: schema_version = 7, FormatEntry.id as bare u32,
        // FormatOverlayEntry.id as bare u32. Mirrors the on-disk shape
        // a pre-5.2 binary would have written.
        let v7_toml = r#"
schema_version = 7
name = "legacy"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 1
col_extent = 1

[[sheets.format_overlay]]
row = 0
col = 0
id = 14

[[sheets.format_overlay]]
row = 1
col = 0
id = 200

[[formats.entries]]
id = 164
string = "yyyy-mm-dd"

[[formats.entries]]
id = 200
string = "0.000%"
"#;
        fs::write(path.join("workbook.toml"), v7_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let loaded = load_workbook(&path).expect("v7 envelope must load via legacy migration");

        // FormatTable: custom entries land under LEGACY_PEER with
        // counter = id - 164 (matches FormatId::legacy_from_u32).
        assert_eq!(
            loaded
                .formats()
                .lookup(ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 0)),
            Some("yyyy-mm-dd"),
            "id=164 must migrate to Custom(LEGACY_PEER, 0)"
        );
        assert_eq!(
            loaded
                .formats()
                .lookup(ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 36)),
            Some("0.000%"),
            "id=200 must migrate to Custom(LEGACY_PEER, 36)"
        );
        // Built-ins remain at their canonical ids (re-seeded by
        // FormatTable::default(), no migration needed for them).
        assert_eq!(
            loaded.formats().lookup(ql_storage::FormatId::Builtin(14)),
            Some("m/d/yyyy")
        );

        // Cell overlay: bare-u32 ids migrate the same way.
        let overlay = loaded.sheet(0).unwrap().format_overlay();
        assert_eq!(
            overlay.get(0, 0),
            Some(ql_storage::FormatId::Builtin(14)),
            "overlay id=14 must migrate to Builtin(14)"
        );
        assert_eq!(
            overlay.get(1, 0),
            Some(ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 36)),
            "overlay id=200 must migrate to Custom(LEGACY_PEER, 36)"
        );
    }

    /// **Step 5 round-trip test:** verify v8 envelopes preserve non-LEGACY
    /// peer Custom FormatIds losslessly through save → load. This is the
    /// property step 5 enables — pre-step-5 the save path's
    /// `to_legacy_u32().expect(...)` would have panicked on
    /// `Custom(PeerId(42), 0)` because legacy u32 can't express
    /// non-LEGACY peers.
    #[test]
    fn v8_envelope_preserves_multi_peer_custom_format_ids() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("multi_peer.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Take over as a non-LEGACY peer and allocate a custom format
        // under that peer's namespace. Pre-step-5 saving this would
        // have panicked.
        wb.formats_mut().set_local_peer(ql_types::PeerId::new(42));
        let custom_id = wb.formats_mut().intern("\"€\" #,##0.00");
        assert_eq!(
            custom_id,
            ql_storage::FormatId::Custom(ql_types::PeerId::new(42), 0),
            "intern under PeerId(42) must allocate Custom(42, 0)"
        );
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, custom_id);

        save_workbook(&wb, "multi_peer", &path).unwrap();
        let loaded = load_workbook(&path).expect("v8 round-trip must succeed");

        // FormatTable: the non-LEGACY peer custom survives unchanged.
        assert_eq!(
            loaded.formats().lookup(custom_id),
            Some("\"€\" #,##0.00"),
            "Custom(PeerId(42), 0) must round-trip through v8 envelope"
        );
        // Cell overlay: still bound to the same FormatId.
        assert_eq!(
            loaded.sheet(0).unwrap().format_overlay().get(0, 0),
            Some(custom_id),
            "overlay binding to Custom(PeerId(42), 0) must round-trip"
        );
    }

    /// **Step 5 round-trip test:** verify v8 envelopes serialize the
    /// tagged-tuple shape on disk (not bare u32). Inspects the saved
    /// workbook.toml directly to confirm the wire format.
    ///
    /// Step-5 audit Opus LOW closure: assertions strengthened to pin
    /// the actual on-disk layout. `toml::to_string_pretty` emits
    /// section-header form for nested structs, not inline-table form —
    /// this test pins that specific shape so future serializer changes
    /// (e.g. switching to `toml_edit` for inline form) trip the test.
    #[test]
    fn v8_envelope_serializes_tagged_tuple_shape_on_disk() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v8_shape.qbook");

        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        let custom_id = wb.formats_mut().intern("#,##0.00 USD");
        wb.sheet_mut(0)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, custom_id);

        save_workbook(&wb, "v8_shape", &path).unwrap();

        let toml_bytes = fs::read_to_string(path.join("workbook.toml")).unwrap();
        // Schema version on disk is the current ship version (8).
        assert!(
            toml_bytes.contains(&format!("schema_version = {}", WORKBOOK_SCHEMA_VERSION)),
            "envelope must carry current schema_version, got:\n{toml_bytes}"
        );
        // formats section emits the section-header tagged-tuple form.
        // The custom entry tags `kind = "custom"` under a section-header
        // path. (toml-rs `to_string_pretty` doesn't emit inline tables
        // for nested structs.)
        assert!(
            toml_bytes.contains("[formats.entries.id]")
                && toml_bytes.contains(r#"kind = "custom""#),
            "v8 envelope's formats section must use section-header tagged-tuple shape \
             ('[formats.entries.id]' + 'kind = \"custom\"'); got:\n{toml_bytes}"
        );
        // Overlay section uses the analogous section-header path.
        assert!(
            toml_bytes.contains("[sheets.format_overlay.id]"),
            "v8 envelope's overlay section must use '[sheets.format_overlay.id]' \
             section-header path; got:\n{toml_bytes}"
        );
        // Negative pin: no bare-integer `id = N` lines for FormatEntry /
        // FormatOverlayEntry should appear (would indicate accidental
        // legacy emission).
        for line in toml_bytes.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("id = ") && !trimmed.starts_with("id = 0") {
                // Sheet ids (e.g. `id = 0`) are bare integers — exempt.
                // FormatEntry / FormatOverlayEntry ids would land here
                // post-step-5 if the serializer regressed to inline.
                continue;
            }
            // The sheet `id` entries are bare; the FormatEntry id is now
            // section-headed. Either way, no FormatEntry-shaped inline
            // serialization should leak through.
            assert!(
                !line.contains(r#"id = { kind"#),
                "v8 envelope must NOT emit inline-table FormatEntryId; got:\n{toml_bytes}"
            );
        }
        // Sanity: round-trip still works.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.formats().lookup(custom_id), Some("#,##0.00 USD"));
    }

    /// **Step 5 ordering test:** verify untagged enum dispatch is
    /// unambiguous — a v8-shaped TOML envelope (struct `id`) MUST
    /// deserialize as `Wire(_)`, not `LegacyU32(_)`. A v<8-shaped TOML
    /// envelope (numeric `id`) MUST deserialize as `LegacyU32(_)`.
    #[test]
    fn format_entry_id_untagged_dispatch_is_unambiguous() {
        // Wire shape (struct).
        let wire_toml = r#"
id = { kind = "builtin", id = 14 }
string = "m/d/yyyy"
"#;
        let wire_entry: FormatEntry = toml::from_str(wire_toml).expect("wire shape parses");
        assert!(
            matches!(wire_entry.id, FormatEntryId::Wire(_)),
            "tagged-tuple id must dispatch to Wire variant"
        );
        assert_eq!(
            wire_entry.id.to_storage(),
            ql_storage::FormatId::Builtin(14)
        );

        // LegacyU32 shape (bare integer).
        let legacy_toml = r#"
id = 14
string = "m/d/yyyy"
"#;
        let legacy_entry: FormatEntry = toml::from_str(legacy_toml).expect("legacy shape parses");
        assert!(
            matches!(legacy_entry.id, FormatEntryId::LegacyU32(14)),
            "bare-u32 id must dispatch to LegacyU32 variant"
        );
        // legacy_from_u32(14) = Builtin(14) — same final FormatId.
        assert_eq!(
            legacy_entry.id.to_storage(),
            ql_storage::FormatId::Builtin(14)
        );

        // Edge case: legacy id=164 migrates to Custom(LEGACY_PEER, 0).
        let legacy_custom_toml = r#"
id = 164
string = "yyyy-mm-dd"
"#;
        let legacy_custom: FormatEntry = toml::from_str(legacy_custom_toml).unwrap();
        assert!(matches!(legacy_custom.id, FormatEntryId::LegacyU32(164)));
        assert_eq!(
            legacy_custom.id.to_storage(),
            ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 0)
        );
    }

    /// **Step 5:** the `FormatEntryId::from_storage(FormatId)` constructor
    /// is the canonical save-side path. Verify it always emits `Wire`,
    /// regardless of variant.
    #[test]
    fn format_entry_id_from_storage_always_emits_wire_variant() {
        let cases = [
            ql_storage::FormatId::Builtin(0),
            ql_storage::FormatId::Builtin(163),
            ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 0),
            ql_storage::FormatId::Custom(ql_types::PeerId::new(42), 7),
        ];
        for fid in cases {
            let envelope_id = FormatEntryId::from_storage(fid);
            assert!(
                matches!(envelope_id, FormatEntryId::Wire(_)),
                "from_storage({fid:?}) must produce Wire variant"
            );
            assert_eq!(
                envelope_id.to_storage(),
                fid,
                "from_storage → to_storage must round-trip {fid:?}"
            );
        }
    }

    // ===== Step 5 audit closure regression tests (2026-05-20) =====

    /// **Codex HIGH-1 closure:** a v8 envelope with `id = Custom(LEGACY_PEER,
    /// u32::MAX)` must NOT panic the loader. Pre-fix the loader's
    /// `register_at` panicked at `counter.checked_add(1).expect(...)`
    /// because the FormatTable's local_peer defaults to LEGACY_PEER.
    /// Post-fix the load surfaces `MalformedFormat` carrying the
    /// `CounterOverflow` cause.
    #[test]
    fn v8_envelope_counter_overflow_load_surfaces_malformed_format_not_panic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("counter_overflow.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // v8 envelope with the maximum counter value for LEGACY_PEER.
        // Pre-step-5-audit closure: this panicked register_at.
        let bad_toml = r#"
schema_version = 8
name = "counter_overflow"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[formats.entries]]
string = "MAX_FMT"

[formats.entries.id]
kind = "custom"
peer = 0
counter = 4294967295
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        // The error must be `MalformedFormat` with the offending id;
        // the `details` field carries the FormatTableError::CounterOverflow
        // shape (Debug-rendered).
        match result {
            Err(QbookError::MalformedFormat { id, details }) => {
                assert_eq!(
                    id,
                    ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, u32::MAX),
                    "id field must carry the offending FormatId"
                );
                assert!(
                    details.contains("CounterOverflow"),
                    "details must mention CounterOverflow; got {details:?}"
                );
            }
            other => panic!("expected MalformedFormat(CounterOverflow), got {other:?}"),
        }
    }

    /// **Codex HIGH-2 closure:** a v8 envelope with `id = Builtin(200)` must
    /// be rejected at load (not silently accepted-then-dropped-on-resave).
    /// `FormatIdWire::Builtin { id: u32 }` accepts any u32 at the wire
    /// layer; the storage-side invariant `n <= 163` is enforced inside
    /// `register_at` (step-5-audit closure).
    #[test]
    fn v8_envelope_builtin_out_of_range_load_surfaces_malformed_format() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("builtin_oor.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let bad_toml = r#"
schema_version = 8
name = "builtin_oor"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[formats.entries]]
string = "bogus-builtin"

[formats.entries.id]
kind = "builtin"
id = 200
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        match result {
            Err(QbookError::MalformedFormat { id, details }) => {
                assert_eq!(
                    id,
                    ql_storage::FormatId::Builtin(200),
                    "id field must carry the offending Builtin(200)"
                );
                assert!(
                    details.contains("BuiltinOutOfRange"),
                    "details must mention BuiltinOutOfRange; got {details:?}"
                );
            }
            other => panic!("expected MalformedFormat(BuiltinOutOfRange), got {other:?}"),
        }
    }

    /// **Codex MEDIUM-1 closure:** a v7 envelope with `id = { kind = ... }`
    /// (the v8 tagged-tuple shape) must be rejected. `#[serde(untagged)]`
    /// dispatch on `FormatEntryId` is purely structural — without the
    /// post-deserialize version gate, a hand-edited v7 file with Wire-shaped
    /// ids would silently load. The guard surfaces this as
    /// `ForwardCompatFieldOnOldVersion`.
    #[test]
    fn v7_envelope_with_v8_wire_id_in_formats_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v7_with_v8_id.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let bad_toml = r#"
schema_version = 7
name = "v7_with_v8"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0

[[formats.entries]]
string = "smuggled"

[formats.entries.id]
kind = "custom"
peer = 42
counter = 7
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                result,
                Err(QbookError::ForwardCompatFieldOnOldVersion {
                    schema_version: 7,
                    field: f,
                }) if f.contains("formats.entries[].id")
            ),
            "expected ForwardCompatFieldOnOldVersion on v7 envelope with Wire id, got {result:?}"
        );
    }

    /// **Codex MEDIUM-1 closure (overlay path):** same as above but the
    /// Wire-shaped id appears in `sheets[].format_overlay[].id` instead
    /// of `formats.entries[].id`. Both code paths must reject.
    #[test]
    fn v7_envelope_with_v8_wire_id_in_overlay_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v7_overlay_v8_id.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let bad_toml = r#"
schema_version = 7
name = "v7_overlay_v8"
date_system = "1900"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 1
col_extent = 1

[[sheets.format_overlay]]
row = 0
col = 0

[sheets.format_overlay.id]
kind = "builtin"
id = 14
"#;
        fs::write(path.join("workbook.toml"), bad_toml).unwrap();
        fs::write(path.join("sheets/0.jsonl"), "").unwrap();
        fs::write(path.join(ATOMIC_SAVE_MARKER_FILENAME), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                result,
                Err(QbookError::ForwardCompatFieldOnOldVersion {
                    schema_version: 7,
                    field: f,
                }) if f.contains("sheets[].format_overlay[].id")
            ),
            "expected ForwardCompatFieldOnOldVersion on v7 overlay with Wire id, got {result:?}"
        );
    }

    /// **Opus LOW closure (round-trip robustness):** a workbook with two
    /// non-LEGACY peers' custom ids round-trips losslessly through save →
    /// load. Single-peer round-trip is covered by
    /// `v8_envelope_preserves_multi_peer_custom_format_ids`; this adds
    /// the two-peer case + verifies sort determinism (two consecutive
    /// saves produce byte-identical workbook.toml).
    #[test]
    fn v8_envelope_two_peer_round_trip_and_sort_determinism() {
        let dir = TempDir::new().unwrap();
        let path_a = dir.path().join("two_peer_a.qbook");
        let path_b = dir.path().join("two_peer_b.qbook");

        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        // Two non-LEGACY peers each allocate the same string + a distinct
        // string.
        wb.formats_mut().set_local_peer(ql_types::PeerId::new(10));
        let id_a_same = wb.formats_mut().intern("$#,##0");
        let id_a_solo = wb.formats_mut().intern("0.000");
        wb.formats_mut().set_local_peer(ql_types::PeerId::new(20));
        let id_b_same = wb.formats_mut().intern("$#,##0"); // same string, different peer
        let id_b_solo = wb.formats_mut().intern("0.0000");

        assert_ne!(
            id_a_same, id_b_same,
            "post-step-4 by_string restructure: cross-peer same-string allocates distinct ids"
        );

        save_workbook(&wb, "two_peer", &path_a).unwrap();
        save_workbook(&wb, "two_peer", &path_b).unwrap();

        // Byte-identical: deterministic sort + serialization.
        let toml_a = fs::read_to_string(path_a.join("workbook.toml")).unwrap();
        let toml_b = fs::read_to_string(path_b.join("workbook.toml")).unwrap();
        assert_eq!(
            toml_a, toml_b,
            "two consecutive saves of the same workbook must produce byte-identical TOML"
        );

        // Round-trip preserves all 4 ids.
        let loaded = load_workbook(&path_a).expect("two-peer round-trip must succeed");
        assert_eq!(loaded.formats().lookup(id_a_same), Some("$#,##0"));
        assert_eq!(loaded.formats().lookup(id_a_solo), Some("0.000"));
        assert_eq!(loaded.formats().lookup(id_b_same), Some("$#,##0"));
        assert_eq!(loaded.formats().lookup(id_b_solo), Some("0.0000"));
    }

    /// Phase 2A.8 audit M11: a formula-bearing cell with Blank value
    /// round-trips through the new `Pending` wire variant. On load, the
    /// formula is preserved and the cell value is Blank (Pending decodes to
    /// Blank); recompute would resolve it.
    #[test]
    fn formula_only_cell_round_trips_as_pending() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("pending.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Cell with a formula but no evaluated value yet (Value::Blank).
        wb.put_formula(s, 5, 3, "1 + 1");
        save_workbook(&wb, "pending", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert_eq!(
            loaded.formula_at(s, 5, 3).map(|s| s.as_ref()),
            Some("1 + 1")
        );
        // Pending decodes to Blank — recompute would resolve to 2.0.
        assert_eq!(loaded.read(Address::new(s, 5, 3)), Value::Blank);
    }

    /// **W5-105 (Phase 4.7.L)**: spill TARGET cells must NOT be saved
    /// — only the anchor cell (with its formula text) round-trips.
    /// Verified by reading the saved sheet JSONL directly: target rows
    /// for B1/C1 are absent; A1's record has the formula text and a
    /// Pending value placeholder.
    #[test]
    fn spill_target_cells_skipped_on_save() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("spill-skip.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Simulate the post-set_formula state for `A1 = {1, 2, 3}`:
        //   - Formula text at A1.
        //   - Computed values at A1=1, B1=2, C1=3.
        //   - Spill anchor registered with shape (1, 3).
        wb.put_formula(s, 0, 0, "{1, 2, 3}");
        wb.put_computed_at(s, 0, 0, Value::Number(1.0));
        wb.put_computed_at(s, 0, 1, Value::Number(2.0));
        wb.put_computed_at(s, 0, 2, Value::Number(3.0));
        wb.register_spill((s, 0, 0), ql_storage::SpillShape::new(1, 3))
            .unwrap();

        save_workbook(&wb, "spill-skip", &path).unwrap();

        // Read the saved sheet JSONL directly to confirm B1/C1 are NOT
        // recorded.
        let sheet_path = path.join("sheets").join(format!("{s}.jsonl"));
        let content = fs::read_to_string(&sheet_path).unwrap();
        // Anchor A1 record must be present.
        assert!(
            content.lines().any(|l| {
                let r: CellRecord = serde_json::from_str(l).unwrap();
                r.row == 0 && r.col == 0 && r.formula.is_some()
            }),
            "anchor A1 record must be present with formula text. got:\n{content}"
        );
        // B1 and C1 records must be ABSENT.
        for (row, col, name) in [(0, 1, "B1"), (0, 2, "C1")] {
            assert!(
                content.lines().all(|l| {
                    let r: CellRecord = serde_json::from_str(l).unwrap();
                    !(r.row == row && r.col == col)
                }),
                "{name} record must NOT appear in saved JSONL (spill target). got:\n{content}"
            );
        }
    }

    /// **W5-105 (Phase 4.7.L)** load round-trip: save a workbook with a
    /// spill, load it back, verify:
    ///   - the anchor's formula text survives.
    ///   - the anchor's computed value survives in the COMPUTED lane
    ///     (the loader at qbook_format.rs:1449-1453 routes formula
    ///     cells' non-Blank saved values through `put_computed_at`,
    ///     preserving the formula-owned-cell invariant "no user-overlay
    ///     entry on a formula cell").
    ///   - the SpillAnchorTable + target cells (B1, C1) are EMPTY.
    ///     `recompute_all` re-derives them per design § 12.3.
    #[test]
    fn spill_targets_load_as_blank_pending_recompute() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("spill-load.qbook");

        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 0, 0, "{1, 2, 3}");
        wb.put_computed_at(s, 0, 0, Value::Number(1.0));
        wb.put_computed_at(s, 0, 1, Value::Number(2.0));
        wb.put_computed_at(s, 0, 2, Value::Number(3.0));
        wb.register_spill((s, 0, 0), ql_storage::SpillShape::new(1, 3))
            .unwrap();

        save_workbook(&wb, "spill-load", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        // Anchor formula text survives.
        assert_eq!(
            loaded.formula_at(s, 0, 0).map(|s| s.as_ref()),
            Some("{1, 2, 3}")
        );
        // Anchor's value at load: Number(1.0) in user lane. (Per design
        // § 12.2: anchors save normally — formula + value. The
        // pre-recompute state has the value in user lane; recompute_all
        // then routes through write_spill → clear_user_at → put_computed_at
        // to correct the lane.)
        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(1.0));
        // B1 and C1 are Blank — they weren't saved.
        assert_eq!(loaded.read(Address::new(s, 0, 1)), Value::Blank);
        assert_eq!(loaded.read(Address::new(s, 0, 2)), Value::Blank);
        // SpillAnchorTable does NOT round-trip — it's runtime-derived
        // by recompute_all from the formula text. Loaded workbook has
        // no spill state until recompute fires.
        assert_eq!(loaded.spill_anchor_at(s, 0, 0), None);
    }

    /// Phase 2A.8 backward-compat test: a hand-crafted v1 envelope (no `names`
    /// section, legacy `Error("#NULL!")` placeholder for formula-bearing Blank
    /// cells) loads cleanly on the v2 reader. The legacy `#NULL!` + formula
    /// combo gets rewritten to the Pending semantic on load.
    #[test]
    fn v1_envelope_loads_on_v2_reader_with_legacy_pending_rewrite() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v1-compat.qbook");

        // Manually build a v1 workbook directory:
        //   workbook.toml: schema_version = 1, no `names` section
        //   sheets/0.jsonl: a literal cell + a formula-bearing Blank
        //     cell encoded as Error("#NULL!") (the v1 legacy encoding).
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 1
name = "legacy-v1"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 1
col_extent = 1
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        let jsonl = "{\"row\":0,\"col\":0,\"value\":{\"Number\":42.0}}\n\
                     {\"row\":5,\"col\":3,\"value\":{\"Error\":\"#NULL!\"},\"formula\":\"1 + 1\"}\n";
        fs::write(path.join("sheets").join("0.jsonl"), jsonl).unwrap();

        let loaded = load_workbook(&path).unwrap();

        // Literal cell intact.
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(42.0));

        // Legacy formula-bearing #NULL! rewritten to Pending semantic:
        // cell value is Blank, formula text preserved.
        assert_eq!(loaded.read(Address::new(0, 5, 3)), Value::Blank);
        assert_eq!(
            loaded.formula_at(0, 5, 3).map(|s| s.as_ref()),
            Some("1 + 1")
        );

        // v1 envelope had no names section → NameTable empty.
        assert!(loaded.names().is_empty());
    }

    /// Phase 2A.8 forward-compat: a hand-crafted envelope with an unknown
    /// schema version is rejected via the existing UnsupportedSchema path.
    /// No silent forward compat. **W5-81 (Phase 4.5.D part 5):** updated
    /// from version 4 to version 5 after v4 became the current ship
    /// version (adding FormatTable + per-sheet format overlay).
    /// **W5-92 (Phase 4.6.D):** updated from version 5 to version 6 after
    /// v5 became the current ship version (adding `NamedEntry.scope`
    /// for sheet-scoped names).
    /// **W5-123 (Phase 4.8.L):** updated from version 6 to version 7
    /// after v6 became the current ship version (adding workbook
    /// `tables` section for TableTable persistence).
    /// **W5-145 (Phase 4.9.I):** updated from version 7 to version 8
    /// after v7 became the current ship version (adding workbook
    /// `reference_mode` + `locale` for the R1C1/locale preference).
    /// **Phase 5.2 D-1 step 5 (2026-05-20):** v8 is now current; bumped
    /// "future" probe to v9.
    #[test]
    fn future_schema_version_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("future.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 10
name = "future"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::UnsupportedSchema { found: 10 })),
            "expected UnsupportedSchema, got {result:?}"
        );
    }

    /// Phase 2A.8 audit H2 crash-window simulation. Verify the documented
    /// invariant: at every step boundary in the save protocol, at least one
    /// of {target, `<target>.bak-*`} contains a complete valid workbook.
    ///
    /// Strategy: factor the save into discrete observable states by reaching
    /// inside the protocol via the same `make_save_paths` + write helpers
    /// that production save uses. At each step boundary, verify on-disk
    /// state then run `load_workbook` (which invokes `recover_from_crashed_save`)
    /// and confirm the recovery produces a usable workbook.
    #[test]
    fn crash_window_at_every_step_recovers_a_valid_workbook() {
        // Build a baseline workbook on disk first.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-sim.qbook");
        let original = wb_with("S", &[cell(0, 0, Value::Number(100.0))]);
        save_workbook(&original, "v1", &path).unwrap();
        let original_v1_value = Value::Number(100.0);

        // Now simulate a second save that crashes at each step. The "new"
        // workbook would have a different value; on recovery we should
        // always be able to load *something* coherent.
        let new_wb = wb_with("S", &[cell(0, 0, Value::Number(200.0))]);

        // --- Step 1 crash: temp dir exists, target intact ---
        {
            let paths = make_save_paths(&path).unwrap();
            write_workbook_to_dir(&new_wb, "v2", &paths.temp).unwrap();
            // Simulated crash. The temp dir is orphaned, but the target is
            // intact and there's no .bak yet, so recovery is a no-op and load
            // returns the original.
            let loaded = load_workbook(&path).unwrap();
            assert_eq!(loaded.read(Address::new(0, 0, 0)), original_v1_value);
            // Cleanup the orphan temp dir before the next sub-test.
            fs::remove_dir_all(&paths.temp).unwrap();
        }

        // --- Step 2 crash: target renamed to .bak, no target, temp pending ---
        {
            let paths = make_save_paths(&path).unwrap();
            write_workbook_to_dir(&new_wb, "v2", &paths.temp).unwrap();
            fs::rename(&path, &paths.backup).unwrap();
            // Simulated crash AFTER step 2. Target missing; .bak holds the
            // original. Recovery should roll back.
            assert!(!path.exists());
            let loaded = load_workbook(&path).unwrap();
            assert_eq!(loaded.read(Address::new(0, 0, 0)), original_v1_value);
            // After rollback recovery, the original is back at `path`. Cleanup
            // the orphan temp dir.
            assert!(path.exists());
            fs::remove_dir_all(&paths.temp).unwrap();
        }

        // --- Step 3 crash: target installed (new), backup exists, awaiting cleanup ---
        {
            let paths = make_save_paths(&path).unwrap();
            write_workbook_to_dir(&new_wb, "v2", &paths.temp).unwrap();
            fs::rename(&path, &paths.backup).unwrap();
            fs::rename(&paths.temp, &path).unwrap();
            // Simulated crash AFTER step 3. Both target (new) and .bak (old)
            // exist. Recovery should roll FORWARD (target is valid; clean up
            // the orphan .bak).
            let loaded = load_workbook(&path).unwrap();
            assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(200.0));
            assert!(!paths.backup.exists(), "orphan .bak should be removed");
        }
    }

    // ===== Phase 2A.3.c — save_workbook_extending =====

    #[test]
    fn save_workbook_extending_writes_sidecar_into_target() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sidecar.qbook");
        let wb = wb_with("S", &[cell(0, 0, Value::Number(7.0))]);

        save_workbook_extending(&wb, "sidecar", &path, |temp_dir| {
            fs::write(temp_dir.join("custom.bin"), b"hello").map_err(QbookError::Io)
        })
        .unwrap();

        // The workbook persisted normally.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(7.0));
        // And the sidecar moved with the atomic rename.
        assert!(path.join("custom.bin").is_file());
        assert_eq!(fs::read(path.join("custom.bin")).unwrap(), b"hello");
    }

    #[test]
    fn save_workbook_extending_closure_failure_cleans_temp_and_preserves_target() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("closure-fail.qbook");
        // Seed with an initial workbook so we can verify the failed save
        // doesn't perturb it.
        let original = wb_with("S", &[cell(0, 0, Value::Number(100.0))]);
        save_workbook(&original, "v1", &path).unwrap();

        // Attempt a save_workbook_extending where the closure fails. The
        // protocol should clean up the temp dir and leave the target
        // unchanged.
        let new_wb = wb_with("S", &[cell(0, 0, Value::Number(200.0))]);
        let result = save_workbook_extending(&new_wb, "v2", &path, |_| {
            Err(QbookError::InvalidPath {
                path: PathBuf::from("/synthetic"),
                reason: "synthetic-closure-failure",
            })
        });
        assert!(
            matches!(
                result,
                Err(QbookError::InvalidPath {
                    reason: "synthetic-closure-failure",
                    ..
                })
            ),
            "expected synthetic closure-failure error, got {result:?}"
        );

        // Original target still has v1 values.
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.read(Address::new(0, 0, 0)), Value::Number(100.0));
        // No orphan temp dir lingering. The temp suffix is random per call,
        // so glob the parent for .tmp-save-* directories — none should match.
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-save-"))
            .collect();
        assert!(
            entries.is_empty(),
            "expected no .tmp-save-* orphans, got {entries:?}"
        );
    }

    // ===== W5-92 (Phase 4.6.D) sheet-scoped names + schema v5 =====

    #[test]
    fn schema_version_constant_is_nine() {
        // Sanity check so future bumps trip this test until the doc is updated.
        // W5-145 (Phase 4.9.I) bumped from 6 to 7 (workbook reference_mode + locale).
        // Phase 5.2 D-1 step 5 (2026-05-20) bumped from 7 to 8: FormatEntry.id
        // + FormatOverlayEntry.id u32 → FormatEntryId untagged enum
        // (Wire(FormatIdWire) | LegacyU32(u32)). v8 envelopes carry tagged-tuple
        // FormatIds losslessly (multi-peer); v<8 envelopes route through
        // FormatId::legacy_from_u32 at load time.
        // FE-4 W4 (2026-06-10) bumped from 8 to 9: added the workbook `styles`
        // section + per-sheet `style_overlay` section (cell-style foundation).
        assert_eq!(WORKBOOK_SCHEMA_VERSION, 9);
    }

    #[test]
    fn sheet_scoped_name_round_trips_through_save_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("scoped.qbook");
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S1");
        let s1 = wb.add_sheet("S2");
        // Workbook-scoped name.
        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        // Sheet-scoped names — different sheets can hold the same name.
        wb.sheet_mut(s0)
            .unwrap()
            .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        wb.sheet_mut(s1)
            .unwrap()
            .set_scoped_name("Bonus", NamedTarget::Constant(Value::Number(100.0)))
            .unwrap();

        save_workbook(&wb, "scoped", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();

        assert!(matches!(
            loaded.names().lookup_ci("Rate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.05
        ));
        assert!(matches!(
            loaded.sheet(s0).unwrap().scoped_names().lookup_ci("Rate"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        assert!(matches!(
            loaded.sheet(s1).unwrap().scoped_names().lookup_ci("Bonus"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 100.0
        ));
        // Cross-checks: sheet 1 has no "Rate"; sheet 0 has no "Bonus".
        assert!(loaded
            .sheet(s1)
            .unwrap()
            .scoped_names()
            .lookup_ci("Rate")
            .is_none());
        assert!(loaded
            .sheet(s0)
            .unwrap()
            .scoped_names()
            .lookup_ci("Bonus")
            .is_none());
    }

    #[test]
    fn v4_envelope_missing_scope_loads_into_workbook_scope() {
        // Hand-craft a v4 envelope with a `names` entry that has no
        // `scope` field. The v5 reader must default `scope: None` and
        // assign the name to the workbook scope (regression-neutral
        // for pre-v5 files).
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("legacy_v4.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let v4_toml = r#"
schema_version = 4
name = "legacy_v4"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[names]
entries = [
  { name = "Legacy", target = { kind = "constant", value = { Number = 1.5 } } },
]
"#;
        fs::write(path.join("workbook.toml"), v4_toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let loaded = load_workbook(&path).unwrap();
        assert!(matches!(
            loaded.names().lookup_ci("Legacy"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 1.5
        ));
        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
    }

    #[test]
    fn load_rejects_scoped_name_referencing_unknown_sheet() {
        // A hand-crafted v5 envelope with a scoped entry pointing at a
        // non-existent sheet must surface MalformedName, not silently
        // create the sheet or drop the name.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_scope.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 5
name = "bad_scope"
date_system = "1900"
sheets = [
  { id = 0, name = "S", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[names]
entries = [
  { name = "X", scope = 7, target = { kind = "constant", value = { Number = 1.0 } } },
]
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                &result,
                Err(QbookError::MalformedName { name, .. }) if name == "X"
            ),
            "expected MalformedName for X, got {result:?}"
        );
    }

    #[test]
    fn workbook_only_names_round_trip_serializes_without_scope_field() {
        // Wire-compat check: when no sheet-scoped names exist, the
        // serialized names entries should NOT emit a `scope` field
        // (Option::is_none + skip_serializing_if). Round-tripping
        // through the v4-style on-disk shape lets v4 readers load v5
        // files cleanly when no sheet-scoped names are present.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("wb_only.qbook");
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        wb.set_name("R", NamedTarget::Constant(Value::Number(0.5)))
            .unwrap();
        save_workbook(&wb, "wb_only", &path).unwrap();

        // Read the workbook.toml and verify no `scope =` appears.
        let toml = fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(
            !toml.contains("scope ="),
            "expected workbook-only names to omit scope field, got: {toml}"
        );

        let loaded = load_workbook(&path).unwrap();
        assert!(matches!(
            loaded.names().lookup_ci("R"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.5
        ));
    }

    // ===== W5-93 (Phase 4.6.E closure) sheet-name validation at load =====

    #[test]
    fn load_rejects_envelope_with_duplicate_canonical_sheet_names() {
        // Codex HIGH-1: a hand-edited `.qbook` with two sheets sharing
        // a canonical name (`Sheet1` + `SHEET1`) must surface as
        // MalformedSheet rather than enter storage silently.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("dup_sheets.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 5
name = "dup_sheets"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
  { id = 1, name = "SHEET1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        fs::write(path.join("sheets").join("1.jsonl"), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(
                &result,
                Err(QbookError::MalformedSheet { sheet_id: 1, name, .. }) if name == "SHEET1"
            ),
            "expected MalformedSheet at id=1 for SHEET1, got {result:?}"
        );
    }

    #[test]
    fn load_rejects_envelope_with_reserved_char_sheet_name() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad_sheet.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 5
name = "bad_sheet"
date_system = "1900"
sheets = [
  { id = 0, name = "Bad:Sheet", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();

        let result = load_workbook(&path);
        assert!(
            matches!(&result, Err(QbookError::MalformedSheet { .. })),
            "expected MalformedSheet, got {result:?}"
        );
    }

    // ===== W5-123 (Phase 4.8.L) — schema v6 + TableTable persistence =====

    fn wb_with_table(table_name: &str, columns: &[&str]) -> Workbook {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("Data");
        let canonical_lower: Vec<Arc<str>> = columns
            .iter()
            .map(|c| Arc::from(c.to_ascii_lowercase().as_str()))
            .collect();
        let display: Vec<Arc<str>> = columns.iter().map(|c| Arc::from(*c)).collect();
        let cols: Vec<TableColumn> = canonical_lower
            .iter()
            .zip(display.iter())
            .map(|(n, d)| TableColumn {
                id: wb.tables_mut().allocate_column_id(),
                name: Arc::clone(n),
                display: Arc::clone(d),
                totals_function: None,
            })
            .collect();
        let canonical_upper: Arc<str> = Arc::from(table_name.to_ascii_uppercase().as_str());
        let display_name: Arc<str> = Arc::from(table_name);
        let meta = TableMetadata {
            name: Arc::clone(&canonical_upper),
            display_name,
            sheet: sheet_id,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: columns.len() as u32,
            has_header: true,
            has_totals: false,
            columns: cols,
        };
        wb.tables_mut().insert(canonical_upper, meta);
        wb
    }

    #[test]
    fn roundtrip_with_single_table_preserves_metadata() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with_table("Sales", &["Qty", "Price"]);
        let pre_meta = wb.lookup_table("Sales").unwrap().clone();
        save_workbook(&wb, "test", &path).unwrap();

        let loaded = load_workbook(&path).unwrap();
        let post = loaded.lookup_table("Sales").expect("table reloaded");
        assert_eq!(post.name, pre_meta.name);
        assert_eq!(post.display_name, pre_meta.display_name);
        assert_eq!(post.sheet, pre_meta.sheet);
        assert_eq!(post.top_row, pre_meta.top_row);
        assert_eq!(post.top_col, pre_meta.top_col);
        assert_eq!(post.rows, pre_meta.rows);
        assert_eq!(post.cols, pre_meta.cols);
        assert_eq!(post.has_header, pre_meta.has_header);
        assert_eq!(post.has_totals, pre_meta.has_totals);
        assert_eq!(post.columns.len(), pre_meta.columns.len());
        for (a, b) in post.columns.iter().zip(pre_meta.columns.iter()) {
            assert_eq!(a.id, b.id, "column ids must survive verbatim");
            assert_eq!(a.name, b.name);
            assert_eq!(a.display, b.display);
            assert_eq!(a.totals_function, b.totals_function);
        }
    }

    #[test]
    fn roundtrip_with_multiple_tables_preserves_each() {
        use ql_storage::{TableColumn, TableMetadata};
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("Sheet1");
        // Two tables on the same sheet at non-overlapping locations.
        for (name, top_row) in &[("Sales", 0u32), ("Orders", 10u32)] {
            let id = wb.tables_mut().allocate_column_id();
            let canonical: Arc<str> = Arc::from(name.to_ascii_uppercase().as_str());
            wb.tables_mut().insert(
                Arc::clone(&canonical),
                TableMetadata {
                    name: Arc::clone(&canonical),
                    display_name: Arc::from(*name),
                    sheet: sheet_id,
                    top_row: *top_row,
                    top_col: 0,
                    rows: 3,
                    cols: 1,
                    has_header: true,
                    has_totals: false,
                    columns: vec![TableColumn {
                        id,
                        name: Arc::from("qty"),
                        display: Arc::from("Qty"),
                        totals_function: None,
                    }],
                },
            );
        }
        save_workbook(&wb, "test", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert!(loaded.lookup_table("Sales").is_some());
        assert!(loaded.lookup_table("Orders").is_some());
        assert_eq!(loaded.lookup_table("Sales").unwrap().top_row, 0);
        assert_eq!(loaded.lookup_table("Orders").unwrap().top_row, 10);
    }

    #[test]
    fn roundtrip_with_totals_function_preserves_each_variant() {
        use ql_storage::{TableColumn, TableMetadata, TotalsFunction};
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let mut wb = Workbook::new();
        let sheet_id = wb.add_sheet("Sheet1");
        let variants = [
            TotalsFunction::None,
            TotalsFunction::Average,
            TotalsFunction::Count,
            TotalsFunction::CountNums,
            TotalsFunction::Max,
            TotalsFunction::Min,
            TotalsFunction::StdDev,
            TotalsFunction::Sum,
            TotalsFunction::Variance,
            TotalsFunction::Custom,
        ];
        let columns: Vec<TableColumn> = variants
            .iter()
            .enumerate()
            .map(|(i, t)| TableColumn {
                id: wb.tables_mut().allocate_column_id(),
                name: Arc::from(format!("c{i}").as_str()),
                display: Arc::from(format!("C{i}").as_str()),
                totals_function: Some(*t),
            })
            .collect();
        let canonical: Arc<str> = Arc::from("ALLTOTALS");
        wb.tables_mut().insert(
            Arc::clone(&canonical),
            TableMetadata {
                name: Arc::clone(&canonical),
                display_name: Arc::from("AllTotals"),
                sheet: sheet_id,
                top_row: 0,
                top_col: 0,
                rows: 3,
                cols: variants.len() as u32,
                has_header: true,
                has_totals: true,
                columns,
            },
        );
        save_workbook(&wb, "test", &path).unwrap();
        let loaded = load_workbook(&path).unwrap();
        let meta = loaded.lookup_table("AllTotals").unwrap();
        for (i, v) in variants.iter().enumerate() {
            assert_eq!(
                meta.columns[i].totals_function,
                Some(*v),
                "totals_function for column {i} must round-trip"
            );
        }
    }

    // (Cross-crate end-to-end test "table + formula + recompute_all
    // after load" lives in `crates/ql-exec/tests/load_workbook_e2e.rs`
    // — it needs `WorkbookRuntime` + `default_registry`, which would
    // require ql-io to dev-depend on ql-exec / ql-functions and create
    // a dev-circular-dep here.)

    #[test]
    fn roundtrip_no_tables_omits_section_from_toml() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.qbook");
        let wb = wb_with("Sheet1", &[]);
        save_workbook(&wb, "test", &path).unwrap();
        let toml_str = fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(
            !toml_str.contains("[[tables.entries]]") && !toml_str.contains("[tables]"),
            "empty TableTable must not emit a [[tables.entries]] block; got:\n{toml_str}"
        );
    }

    #[test]
    fn v5_envelope_loads_into_v6_with_empty_tables() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v5.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 5
name = "v5_compat"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let loaded = load_workbook(&path).unwrap();
        assert_eq!(loaded.sheet_count(), 1);
        assert!(loaded.tables().is_empty(), "v5 file → empty TableTable");
    }

    // (Forward-compat "v7 loud-fails on v6 reader" is covered by the
    // pre-existing `future_schema_version_rejected` test above — once
    // 4.8.L bumped to v6, that test was already updated to use v7.)

    #[test]
    fn malformed_table_unknown_sheet_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Build a v6 envelope with a table on a sheet that doesn't
        // exist in the sheets array.
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "PHANTOM"
display_name = "Phantom"
sheet = 99
top_row = 0
top_col = 0
rows = 3
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref name, .. } if name == "PHANTOM"),
            "expected MalformedTable for PHANTOM, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_columns_length_mismatch_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "SALES"
display_name = "Sales"
sheet = 0
top_row = 0
top_col = 0
rows = 3
cols = 2
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("columns length")),
            "expected MalformedTable about columns length, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_zero_dims_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "EMPTY"
display_name = "Empty"
sheet = 0
top_row = 0
top_col = 0
rows = 0
cols = 0
has_header = false
has_totals = false
columns = []
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("> 0")),
            "expected MalformedTable about zero dims, got {err:?}"
        );
    }

    // ===== W5-125 (Phase 4.8.O.1) — loader footprint-bounds upper-limit check =====

    #[test]
    fn malformed_table_rejected_when_footprint_past_max_row() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // top_row = 1_048_574, rows = 3 → last_row = 1_048_576 > MAX_ROW (1_048_575).
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "FAR"
display_name = "Far"
sheet = 0
top_row = 1048574
top_col = 0
rows = 3
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("MAX_ROW")),
            "expected MalformedTable about MAX_ROW, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_rejected_when_footprint_past_max_column() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // top_col = 16383, cols = 2 → last_col = 16384 > MAX_COLUMN (16383).
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "WIDE"
display_name = "Wide"
sheet = 0
top_row = 0
top_col = 16383
rows = 1
cols = 2
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "a"
display = "A"

[[tables.entries.columns]]
id = 1
name = "b"
display = "B"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("MAX_COLUMN")),
            "expected MalformedTable about MAX_COLUMN, got {err:?}"
        );
    }

    // ===== W5-126 (Phase 4.8.O.2) — loader re-validates runtime invariants =====
    //
    // Closes Codex 4.8.O megaudit MEDIUM-1 (loader skipped overlap /
    // namespace / column dedup checks) and MEDIUM-2 (`max_id + 1`
    // unchecked at u32::MAX) by surfacing the same shape as
    // `WorkbookRuntime::create_table` would reject.

    #[test]
    fn malformed_table_rejected_when_duplicate_canonical_name() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Two entries with the same canonical name (case-insensitive).
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "SALES"
display_name = "Sales"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"

[[tables.entries]]
name = "SALES"
display_name = "Sales"
sheet = 0
top_row = 10
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 1
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("duplicate canonical table name")),
            "expected MalformedTable about duplicate canonical, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_rejected_when_name_collides_with_defined_name() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // `Rate` is registered as a defined-name constant; table named
        // `Rate` collides with it (Excel canon — shared namespace).
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[names.entries]]
name = "Rate"
target = { kind = "constant", value = { Number = 0.21 } }

[[tables.entries]]
name = "RATE"
display_name = "Rate"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("collides with a workbook-scoped defined name")),
            "expected MalformedTable about defined-name collision, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_rejected_when_footprints_overlap() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Two non-duplicate names but overlapping footprints on sheet 0.
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "A"
display_name = "A"
sheet = 0
top_row = 0
top_col = 0
rows = 5
cols = 2
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "x"
display = "X"

[[tables.entries.columns]]
id = 1
name = "y"
display = "Y"

[[tables.entries]]
name = "B"
display_name = "B"
sheet = 0
top_row = 2
top_col = 1
rows = 3
cols = 2
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 2
name = "p"
display = "P"

[[tables.entries.columns]]
id = 3
name = "q"
display = "Q"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("overlaps")),
            "expected MalformedTable about overlap, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_rejected_when_column_name_empty() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "T"
display_name = "T"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = ""
display = "X"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("cannot be empty")),
            "expected MalformedTable about empty column name, got {err:?}"
        );
    }

    #[test]
    fn malformed_table_rejected_when_duplicate_column_name() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // Two columns with the same canonical (case-insensitive) name.
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "T"
display_name = "T"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 2
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"

[[tables.entries.columns]]
id = 1
name = "qty"
display = "QTY"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("duplicate canonical column name")),
            "expected MalformedTable about duplicate column, got {err:?}"
        );
    }

    /// **W5-126 / Codex MEDIUM-2:** persisted column id at u32::MAX
    /// would panic in `TableTable::insert` (`max_id + 1` overflow) or
    /// wrap in release. Catch at load.
    #[test]
    fn malformed_table_rejected_when_column_id_is_u32_max() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "T"
display_name = "T"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 4294967295
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("u32::MAX")),
            "expected MalformedTable about u32::MAX column id, got {err:?}"
        );
    }

    /// Happy path: two distinct non-overlapping tables on the same
    /// sheet — should load cleanly. Pins that the new MEDIUM-1
    /// validation doesn't reject legitimate multi-table workbooks.
    #[test]
    fn load_accepts_two_non_overlapping_tables() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ok.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "ok"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "A"
display_name = "A"
sheet = 0
top_row = 0
top_col = 0
rows = 3
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "x"
display = "X"

[[tables.entries]]
name = "B"
display_name = "B"
sheet = 0
top_row = 10
top_col = 0
rows = 3
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 1
name = "y"
display = "Y"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let loaded = load_workbook(&path).expect("non-overlapping tables must load");
        assert!(loaded.lookup_table("A").is_some());
        assert!(loaded.lookup_table("B").is_some());
    }

    // ===== W5-128 (Phase 4.8.O.4) — Codex closure-verify MEDIUM-1 second-pass =====

    /// **W5-128 / Codex closure-verify MEDIUM-1:** the loader inserts
    /// under `canonical_upper`, not the raw `entry.name`. A hand-
    /// edited TOML with `name = "Sales"` (mixed case) loaded under
    /// the raw key would have been silently unfindable since
    /// `TableTable::lookup` uppercases every query. After the fix,
    /// the table is reachable via the canonical (uppercase) key
    /// regardless of how `entry.name` was cased on disk.
    #[test]
    fn load_normalizes_mixed_case_table_name() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mixed.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        // `entry.name = "Sales"` — mixed-case. Loader must uppercase
        // before inserting so subsequent lookups find it.
        let toml = r#"
schema_version = 6
name = "mixed"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "Sales"
display_name = "Sales"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let loaded = load_workbook(&path).expect("mixed-case name must normalize");
        // Loader must canonicalize the key — `lookup_table` uppercases
        // every query, so the table must be findable.
        let meta = loaded
            .lookup_table("Sales")
            .expect("table findable post-load");
        // `meta.name` is the canonical (uppercase) form per design.
        assert_eq!(meta.name.as_ref(), "SALES");
        // `meta.display_name` preserves the case-preserving form
        // straight from the on-disk `display_name`.
        assert_eq!(meta.display_name.as_ref(), "Sales");
    }

    /// **W5-128 / Codex closure-verify MEDIUM-1:** two entries with
    /// the SAME canonical name but DIFFERENT cases (`"Sales"` and
    /// `"SALES"`). Pre-fix the W5-126 duplicate check missed this
    /// because the first insert keyed by raw `"Sales"` and the
    /// second's `lookup("SALES")` returned None against the
    /// mixed-case key. Post-fix both inserts canonicalize and the
    /// duplicate-name error fires.
    #[test]
    fn malformed_table_rejected_when_mixed_case_duplicate_canonical_name() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "bad"
date_system = "1900"
sheets = [
  { id = 0, name = "Sheet1", chunk_rows = 16384, row_extent = 0, col_extent = 0 },
]

[[tables.entries]]
name = "Sales"
display_name = "Sales"
sheet = 0
top_row = 0
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 0
name = "qty"
display = "Qty"

[[tables.entries]]
name = "SALES"
display_name = "Sales"
sheet = 0
top_row = 10
top_col = 0
rows = 2
cols = 1
has_header = true
has_totals = false

[[tables.entries.columns]]
id = 1
name = "qty"
display = "Qty"
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        assert!(
            matches!(err, QbookError::MalformedTable { ref reason, .. } if reason.contains("duplicate canonical table name")),
            "expected MalformedTable about duplicate canonical, got {err:?}"
        );
    }

    // ===================================================================
    // W5-145 (Phase 4.9.I) — v7 schema bump tests.
    // ===================================================================

    /// **v7 default workbook round-trips with no `reference_mode` /
    /// `locale` fields written.** Empty / default workbook omits both
    /// fields per the save-side `if non-default` guard.
    #[test]
    fn v7_default_workbook_omits_reference_mode_and_locale() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("default.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        save_workbook(&wb, "default", &path).unwrap();
        let toml = fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(!toml.contains("reference_mode"));
        assert!(!toml.contains("locale"));
        // Reload and verify defaults.
        let wb2 = load_workbook(&path).unwrap();
        assert_eq!(wb2.reference_mode(), ql_types::ReferenceMode::A1);
        assert_eq!(wb2.locale(), ql_types::Locale::EnUs);
    }

    /// **v7 R1C1 workbook writes + round-trips `reference_mode`.**
    #[test]
    fn v7_r1c1_workbook_round_trips_reference_mode() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("r1c1.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        save_workbook(&wb, "r1c1", &path).unwrap();
        let toml = fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(toml.contains("reference_mode = \"R1C1\""));
        let wb2 = load_workbook(&path).unwrap();
        assert_eq!(wb2.reference_mode(), ql_types::ReferenceMode::R1C1);
        assert_eq!(wb2.locale(), ql_types::Locale::EnUs);
    }

    /// **v7 DE locale round-trips.**
    #[test]
    fn v7_de_locale_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("de.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.set_locale(ql_types::Locale::De);
        save_workbook(&wb, "de", &path).unwrap();
        let toml = fs::read_to_string(path.join("workbook.toml")).unwrap();
        assert!(toml.contains("locale = \"de\""));
        let wb2 = load_workbook(&path).unwrap();
        assert_eq!(wb2.locale(), ql_types::Locale::De);
    }

    /// **FR locale round-trips.**
    #[test]
    fn v7_fr_locale_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fr.qbook");
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.set_locale(ql_types::Locale::Fr);
        save_workbook(&wb, "fr", &path).unwrap();
        let wb2 = load_workbook(&path).unwrap();
        assert_eq!(wb2.locale(), ql_types::Locale::Fr);
    }

    /// **Unknown locale string surfaces `UnknownLocale`.** Hand-written
    /// v7 file with `locale = "xx"` rejects loudly (closes Sonnet M-2).
    #[test]
    fn v7_unknown_locale_string_rejected_with_captured_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("bad-locale.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 7
name = "bad"
locale = "xx"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        match err {
            QbookError::UnknownLocale { found } => assert_eq!(found, "xx"),
            other => panic!("expected UnknownLocale, got {other:?}"),
        }
    }

    /// **v6 file with `reference_mode` rejected as forward-compat field.**
    /// Closes Codex HIGH-5.
    #[test]
    fn v6_file_with_reference_mode_rejected_as_forward_compat() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v6-rm.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "v6"
reference_mode = "R1C1"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        match err {
            QbookError::ForwardCompatFieldOnOldVersion {
                schema_version,
                field,
            } => {
                assert_eq!(schema_version, 6);
                assert_eq!(field, "reference_mode");
            }
            other => panic!("expected ForwardCompatFieldOnOldVersion, got {other:?}"),
        }
    }

    /// **v6 file with `locale` rejected as forward-compat field.**
    #[test]
    fn v6_file_with_locale_rejected_as_forward_compat() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v6-loc.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "v6"
locale = "de"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let err = load_workbook(&path).unwrap_err();
        match err {
            QbookError::ForwardCompatFieldOnOldVersion {
                schema_version,
                field,
            } => {
                assert_eq!(schema_version, 6);
                assert_eq!(field, "locale");
            }
            other => panic!("expected ForwardCompatFieldOnOldVersion, got {other:?}"),
        }
    }

    /// **v6 file with neither v7 field loads cleanly on v7 reader.**
    /// Backward compat: v1-v6 files load with default A1/EnUs.
    #[test]
    fn v6_file_without_v7_fields_loads_with_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("v6.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 6
name = "v6"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let wb = load_workbook(&path).unwrap();
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::A1);
        assert_eq!(wb.locale(), ql_types::Locale::EnUs);
    }

    /// **Two-phase load: a v6 reader hitting a v7 file's
    /// `schema_version: 7` surfaces `UnsupportedSchema { found: 7 }`
    /// even when the v7 file carries fields the v6 reader doesn't
    /// recognize.** Closes Sonnet H-2: probe-first ensures the
    /// version gate runs BEFORE deny_unknown_fields trips on the
    /// new field.
    ///
    /// We can't run a true "v6 reader against v7 file" in this
    /// test (the build IS v7), but the equivalent verification is
    /// that `schema_version: 99` (any-out-of-range) is caught by
    /// the probe AS-IS, not via the full envelope parse.
    #[test]
    fn two_phase_load_rejects_out_of_range_via_probe() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("oor.qbook");
        fs::create_dir_all(path.join("sheets")).unwrap();
        let toml = r#"
schema_version = 99
name = "oor"
# fields below would fail deny_unknown_fields on the full envelope,
# but the probe-first design catches the version gate first:
some_future_field = "ignored"

[[sheets]]
id = 0
name = "S"
chunk_rows = 16384
row_extent = 0
col_extent = 0
"#;
        fs::write(path.join("workbook.toml"), toml).unwrap();
        fs::write(path.join("sheets").join("0.jsonl"), "").unwrap();
        let result = load_workbook(&path);
        assert!(
            matches!(result, Err(QbookError::UnsupportedSchema { found: 99 })),
            "expected UnsupportedSchema(99) via probe, got {result:?}"
        );
    }
}
