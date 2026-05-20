//! `ql-io` — Quantbook native `.qbook/` workbook directory format.
//!
//! Phase 1 W5-6 scope: load + save round-trip for the `.qbook/` directory layout.
//! See `qbook_format.rs` for the format spec + implementation.
//!
//! Foreign-format support (xlsx, ods) lives in `ql-io-xlsx` / `ql-io-ods` crates.
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. `QbookError` carries
//! `#[non_exhaustive]` — downstream consumers must include a `_` arm
//! when matching across crate boundaries. Wire enums (`CellWireValue`,
//! `NamedTargetWire`, `ReferenceModeWire`, `LocaleWire`,
//! `DateSystemWire`, `TotalsFunctionWire`) are exhaustive by design;
//! adding a variant requires bumping `WORKBOOK_SCHEMA_VERSION` and
//! coordinating all producer/consumer sites in one major-version cut.

pub mod oplog_persistence;
pub mod qbook_format;

// Wire-format types live in `ql-oplog::wire` post Tier D2 (2026-05-19).
// `ql-io` re-exports them so external callers that import
// `ql_io::CellWireValue` / `ql_io::NamedTargetWire` /
// `ql_io::error_to_canonical_text` continue to compile.
pub use ql_oplog::wire::{error_to_canonical_text, CellWireValue, NamedTargetWire};

pub use oplog_persistence::{
    load_workbook_with_oplog, save_workbook_with_oplog, PersistenceError, OPLOG_FILENAME,
    OPLOG_HEADER_LEN, OPLOG_MAGIC, OPLOG_MIN_SUPPORTED_SCHEMA_VERSION, OPLOG_SCHEMA_VERSION,
};
pub use qbook_format::{
    load_workbook, save_workbook, save_workbook_extending, CellRecord, FormatEntry, FormatEntryId,
    FormatOverlayEntry, FormatsSection, NamedEntry, NamesSection, QbookError, SheetEnvelope,
    WorkbookEnvelope, MIN_SUPPORTED_SCHEMA_VERSION, WORKBOOK_SCHEMA_VERSION,
};
