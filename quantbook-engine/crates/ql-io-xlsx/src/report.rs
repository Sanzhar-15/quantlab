//! Import/export reports.
//!
//! The xlsx I/O entry points return a report alongside the result.
//! The report is the engine's contract for what survived round-trip:
//! every unsupported feature is enumerated, every formula that
//! failed to recompute is listed, every soft warning is captured.
//!
//! Per Codex's Phase 4.11 architecture review: the key assertion isn't
//! that every OOXML feature is implemented in batch one — it's that
//! Quantbook never silently claims fidelity it doesn't have.

use crate::error::UnsupportedFeatureKind;
use crate::model::FeatureInventory;

/// Result-side report attached to a successful import.
#[derive(Debug, Clone, Default)]
pub struct XlsxImportReport {
    /// Tally of all unsupported features detected.
    pub feature_inventory: FeatureInventory,

    /// Per-feature occurrence records with location detail.
    pub unsupported: Vec<UnsupportedFeature>,

    /// Formulas the engine couldn't recompute. Their imported cached
    /// value is preserved per `RecomputeMode::BestEffort`.
    pub formula_failures: Vec<FormulaImportFailure>,

    /// Soft warnings (e.g., calamine reported a sheet with quirks).
    pub warnings: Vec<XlsxWarning>,
}

/// One occurrence of an unsupported feature.
#[derive(Debug, Clone)]
pub struct UnsupportedFeature {
    /// What kind.
    pub kind: UnsupportedFeatureKind,
    /// The OOXML part where it appeared.
    pub part: String,
    /// Optional location detail (cell address, table name, etc.).
    pub detail: String,
}

/// One formula the engine couldn't recompute on import.
#[derive(Debug, Clone)]
pub struct FormulaImportFailure {
    /// Sheet index in workbook order.
    pub sheet: u16,
    /// Row (0-based).
    pub row: u32,
    /// Column (0-based).
    pub col: u32,
    /// The formula text as stored in OOXML (without leading `=`).
    pub formula: String,
    /// Why recompute failed (engine error message).
    pub reason: String,
}

/// Soft warning attached to an import or export.
#[derive(Debug, Clone)]
pub struct XlsxWarning {
    /// Where (file path, OOXML part, cell, etc.).
    pub location: String,
    /// What.
    pub message: String,
}

/// Result-side report attached to a successful export.
#[derive(Debug, Clone, Default)]
pub struct XlsxExportReport {
    /// Features the writer couldn't preserve. Each entry is a real
    /// fidelity loss the caller should know about.
    pub dropped_features: Vec<UnsupportedFeature>,

    /// Soft warnings (e.g., umya version compatibility note).
    pub warnings: Vec<XlsxWarning>,

    /// Number of cells written (cells with a value, formula, or both).
    pub cells_written: u64,

    /// Number of formula cached values written.
    pub formula_caches_written: u64,
}
