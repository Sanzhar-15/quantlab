//! `ql-io` — Quantbook native `.qbook/` workbook directory format.
//!
//! Phase 1 W5-6 scope: load + save round-trip for the `.qbook/` directory layout.
//! See `qbook_format.rs` for the format spec + implementation.
//!
//! Foreign-format support (xlsx, ods) lives in `ql-io-xlsx` / `ql-io-ods` crates.

pub mod qbook_format;

pub use qbook_format::{
    error_to_canonical_text, load_workbook, save_workbook, save_workbook_extending, CellRecord,
    CellWireValue, NamedEntry, NamedTargetWire, NamesSection, QbookError, SheetEnvelope,
    WorkbookEnvelope, MIN_SUPPORTED_SCHEMA_VERSION, WORKBOOK_SCHEMA_VERSION,
};
