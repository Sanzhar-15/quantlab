//! `ql-io-xlsx` — Excel .xlsx import/export surface.
//!
//! **Engine Phase 4.11** per `docs/MASTER-PLAN.md:503-507`. Architectural
//! decisions and rationale documented in
//! `docs/audits/2026-05-18-phase-4-11-architecture-codex.md` and
//! `.plans/_active.md`.
//!
//! # Architecture
//!
//! ## Read: hybrid (calamine + targeted OOXML scanner)
//!
//! - `calamine` owns the cell grid: sheet names/order, sparse cell
//!   values, formula text via `worksheet_formula`, shared strings.
//! - Targeted OOXML scanner (zip + quick-xml) owns metadata that
//!   calamine compresses or drops: `date1904`, scoped defined names,
//!   table XML, styles, feature inventory (CF, DV, comments,
//!   drawings).
//!
//! Per Codex's Phase 4.11 architecture review: pure calamine doesn't
//! pass Phase 4.11's scope/table/date1904/style requirements
//! (formualizer's calamine backend is 1169 lines because it also
//! parses XML directly). Roll-own first is reinventing well-trodden
//! ground. Hybrid is the optimum.
//!
//! ## Write: `umya-spreadsheet` (`UpdateOriginal`) + later
//! `rust_xlsxwriter` (`NewWorkbook`)
//!
//! Behind a backend boundary from day one. `UpdateOriginal` mode
//! preserves opaque OOXML parts from the original package (CF, DV,
//! comments, drawings) — Quantbook's `Workbook` doesn't model those
//! features, but we don't want to silently drop them on round-trip.
//! `NewWorkbook` mode generates a fresh package from engine state
//! and is reserved for workbooks that didn't originate in xlsx.
//!
//! ## First batch (W5-D-14): round-trip spine with feature inventory
//!
//! NOT minimal-import-only (silently drops metadata Phase 4.11 says
//! must survive). NOT read-only-full (delays write integration).
//! Round-trip spine catches library/model mismatches while the design
//! is still malleable.

#![deny(missing_docs)]

mod error;
mod model;
mod options;
mod report;

// Submodules for the read and write implementations land in W5-D-14
// itself. Stubs declared here so the public API can reference them
// without the impl crates being fully populated yet.
mod read;
mod write;

pub use error::{UnsupportedFeatureKind, XlsxError};
pub use model::{FeatureInventory, XlsxPreservation};
pub use options::{
    ExportMode, FormulaCachePolicy, RecomputeMode, UnsupportedPolicy, XlsxExportOptions,
    XlsxImportOptions,
};
pub use report::{
    FormulaImportFailure, UnsupportedFeature, XlsxExportReport, XlsxImportReport, XlsxWarning,
};

use ql_functions::FunctionRegistry;
use ql_storage::Workbook;

/// Successful import bundle.
///
/// The caller receives the populated `Workbook`, the import report
/// (containing unsupported-feature inventory + formula failures +
/// warnings), and — if `XlsxImportOptions::preserve_package = true` —
/// the raw OOXML package snapshot for high-fidelity round-trip via
/// `ExportMode::UpdateOriginal`.
#[derive(Debug)]
pub struct XlsxImportResult {
    /// The populated workbook. Sheets, cells, formulas, names,
    /// tables, formats all loaded.
    pub workbook: Workbook,

    /// Per-import report. Always present, even on a clean import (the
    /// report's `feature_inventory.is_clean()` returns `true` in that
    /// case).
    pub report: XlsxImportReport,

    /// Original-package snapshot for round-trip. `None` if
    /// `XlsxImportOptions::preserve_package` was `false`.
    pub preservation: Option<XlsxPreservation>,
}

/// Import an xlsx workbook from a filesystem path.
///
/// **W5-D-14 (Phase 4.11 round-trip spine):** stub returning
/// `XlsxError::Engine("not yet implemented")`. Implementation arrives
/// in the next W5-D-14 commit (calamine grid reader + OOXML scanner +
/// recompute pass).
pub fn import_xlsx_path(
    _path: impl AsRef<std::path::Path>,
    _registry: &FunctionRegistry,
    _options: XlsxImportOptions,
) -> Result<XlsxImportResult, XlsxError> {
    Err(XlsxError::Engine(
        "import_xlsx_path not yet implemented (Phase 4.11 W5-D-14 in progress)".to_string(),
    ))
}

/// Import an xlsx workbook from an in-memory byte buffer.
///
/// **W5-D-14:** stub. Implementation in next W5-D-14 commit.
pub fn import_xlsx_bytes(
    _bytes: &[u8],
    _registry: &FunctionRegistry,
    _options: XlsxImportOptions,
) -> Result<XlsxImportResult, XlsxError> {
    Err(XlsxError::Engine(
        "import_xlsx_bytes not yet implemented (Phase 4.11 W5-D-14 in progress)".to_string(),
    ))
}

/// Export a `Workbook` to an xlsx file.
///
/// **W5-D-14:** stub. Implementation in next W5-D-14 commit (umya
/// `UpdateOriginal` backend). `NewWorkbook` mode (rust_xlsxwriter)
/// lands in W5-D-17.
pub fn export_xlsx_path(
    _workbook: &Workbook,
    _registry: &FunctionRegistry,
    _out: impl AsRef<std::path::Path>,
    _options: XlsxExportOptions,
) -> Result<XlsxExportReport, XlsxError> {
    Err(XlsxError::Engine(
        "export_xlsx_path not yet implemented (Phase 4.11 W5-D-14 in progress)".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_api_stubs_return_engine_error() {
        // **W5-D-14 scaffolding pin:** the public entry points exist
        // and return a typed error (not a panic) when called before
        // the implementation lands. This locks the API surface in
        // place so callers can write integration code against it
        // while the impl is in progress.
        let reg = ql_functions::default_registry();
        let opts = XlsxImportOptions::default();
        match import_xlsx_path("nonexistent.xlsx", &reg, opts.clone()) {
            Err(XlsxError::Engine(msg)) => assert!(msg.contains("not yet implemented")),
            other => panic!("expected Engine error, got {other:?}"),
        }
        match import_xlsx_bytes(&[], &reg, opts) {
            Err(XlsxError::Engine(msg)) => assert!(msg.contains("not yet implemented")),
            other => panic!("expected Engine error, got {other:?}"),
        }
        let wb = Workbook::new();
        let export_opts = XlsxExportOptions::default();
        match export_xlsx_path(&wb, &reg, "/tmp/never-written.xlsx", export_opts) {
            Err(XlsxError::Engine(msg)) => assert!(msg.contains("not yet implemented")),
            other => panic!("expected Engine error, got {other:?}"),
        }
    }

    #[test]
    fn unsupported_feature_kind_is_hashable() {
        // FeatureInventory uses UnsupportedFeatureKind as a HashMap
        // key. Pin the trait bound at the scaffolding stage so the
        // import inventory path can rely on it.
        use std::collections::HashSet;
        let mut s: HashSet<UnsupportedFeatureKind> = HashSet::new();
        s.insert(UnsupportedFeatureKind::ConditionalFormatting);
        s.insert(UnsupportedFeatureKind::DataValidation);
        s.insert(UnsupportedFeatureKind::Other("table-extras"));
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn feature_inventory_record_and_is_clean() {
        let mut inv = FeatureInventory::default();
        assert!(inv.is_clean());
        inv.record(UnsupportedFeatureKind::ConditionalFormatting);
        assert!(!inv.is_clean());
        assert_eq!(
            inv.counts
                .get(&UnsupportedFeatureKind::ConditionalFormatting),
            Some(&1)
        );
        inv.record(UnsupportedFeatureKind::ConditionalFormatting);
        assert_eq!(
            inv.counts
                .get(&UnsupportedFeatureKind::ConditionalFormatting),
            Some(&2)
        );
    }
}
