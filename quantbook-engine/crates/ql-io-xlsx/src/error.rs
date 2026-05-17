//! Error types for `ql-io-xlsx`.
//!
//! Single sum type covering import, export, package, XML parse, and
//! engine-integration failures. Per the engine-wide no-fallbacks rule:
//! errors are surfaced loudly with enough context to diagnose, never
//! silently swallowed or replaced with defaults.

use thiserror::Error;

/// Top-level error type for xlsx import / export.
///
/// **Phase 4.11 (W5-D-14):** kept narrow at first ship. Variants will
/// be added as new failure modes surface during the round-trip spine
/// implementation. Each variant should carry enough context (file path,
/// part name, XML element, etc.) to localize the failure.
#[derive(Debug, Error)]
pub enum XlsxError {
    /// Filesystem I/O failed (file not found, permission denied, etc.).
    #[error("xlsx file I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The zip archive is malformed or unreadable.
    #[error("xlsx zip archive error: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// Calamine reported a structural error reading a sheet or formula.
    #[error("xlsx calamine error: {0}")]
    Calamine(String),

    /// quick-xml parser surfaced malformed OOXML.
    #[error("xlsx xml parse error at {part}: {source}")]
    XmlParse {
        /// The OOXML part where parsing failed (e.g.
        /// `xl/workbook.xml`).
        part: String,
        /// The underlying quick-xml parse error.
        #[source]
        source: quick_xml::Error,
    },

    /// An OOXML part referenced an unknown attribute or value, or the
    /// XML structure doesn't match Excel's documented schema. Distinct
    /// from `XmlParse` (which is well-formedness) — this is
    /// semantic validity.
    #[error("xlsx malformed OOXML at {part}: {message}")]
    MalformedOoxml {
        /// The OOXML part with the issue.
        part: String,
        /// Human-readable description of what was malformed.
        message: String,
    },

    /// A workbook feature was encountered that the engine cannot
    /// represent. Whether this is fatal depends on
    /// [`UnsupportedPolicy`]: `Strict` returns the error, `Permissive`
    /// records it in the import report and continues.
    #[error("xlsx unsupported feature {feature:?} in {part}: {detail}")]
    UnsupportedFeature {
        /// What kind of feature (CF, DV, comments, drawings, etc.).
        feature: UnsupportedFeatureKind,
        /// The OOXML part that contained the feature.
        part: String,
        /// Additional context (cell range, table name, etc.).
        detail: String,
    },

    /// The hybrid reader's calamine view disagreed with the OOXML
    /// scanner view on a load-bearing property (sheet count/order,
    /// formula text for a cell, etc.). Pre-W5-D-14 design assumption:
    /// these are import errors, not best-effort guesses.
    #[error("xlsx hybrid-reader reconciliation failure: {message}")]
    Reconciliation {
        /// Description of the disagreement.
        message: String,
    },

    /// Export couldn't write the output file (umya or generated path).
    #[error("xlsx export error: {0}")]
    Export(String),

    /// Engine integration failed (bind error, runtime error, op-log
    /// error). The xlsx I/O layer translates these to `XlsxError` so
    /// callers don't need to depend on the engine crates' error types.
    #[error("xlsx engine integration error: {0}")]
    Engine(String),
}

/// Categories of OOXML features the engine doesn't represent.
///
/// Used by [`XlsxError::UnsupportedFeature`] and the
/// import/export reports. The variants here track exactly what the
/// hybrid reader's feature inventory detects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UnsupportedFeatureKind {
    /// Conditional formatting rules (`xl/worksheets/sheet*.xml`
    /// `<conditionalFormatting>`).
    ConditionalFormatting,
    /// Data validation (`<dataValidations>`).
    DataValidation,
    /// Comments and notes (`xl/comments*.xml`).
    Comments,
    /// Drawings + embedded objects (`xl/drawings/`).
    Drawings,
    /// Images (linked or embedded).
    Images,
    /// Hyperlinks (`<hyperlinks>`).
    Hyperlinks,
    /// Merged cells (`<mergeCells>`).
    MergedCells,
    /// Sheet protection.
    Protection,
    /// Workbook-level external links (`xl/externalLinks/`).
    ExternalLinks,
    /// Pivot tables.
    PivotTables,
    /// VBA macros (`xl/vbaProject.bin`).
    Macros,
    /// Any other OOXML part not modeled by the engine. Used as a
    /// catch-all so the inventory is exhaustive even for parts we
    /// haven't enumerated yet.
    Other(&'static str),
}
