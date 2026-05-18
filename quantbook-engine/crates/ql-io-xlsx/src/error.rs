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

    /// **DEPRECATED — never constructed; slated for removal in 0.2.**
    ///
    /// **W5-D-PM-5 (megaudit Opus-C HIGH-3 closure):** the hybrid-reader
    /// reconciliation step described in `calamine_grid.rs:60-62` never
    /// landed (calamine's sheet order is used unchanged at
    /// `convert.rs:33`). This variant is dead code that forces callers
    /// writing exhaustive matches on `XlsxError` to handle a case that
    /// cannot happen. Kept for one cycle as `#[deprecated]` to ease the
    /// transition; remove in 0.2.0.
    #[deprecated(
        since = "0.1.1",
        note = "Never constructed; reconciliation pass was never implemented. \
                Will be removed in 0.2.0."
    )]
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
    /// **W5-D-PM-3 (megaudit Opus-A HIGH-3 closure):** sheet
    /// visibility state (`state="hidden"` / `"veryHidden"`).
    /// Quantbook's `Sheet` doesn't model state; on
    /// `UpdateOriginal` export we silently lose the attribute
    /// because the shadow's `xl/workbook.xml` replaces the
    /// original's. Recording this in the import inventory lets
    /// Strict mode surface the loss and Permissive callers see it
    /// in `dropped_features`.
    HiddenSheets,
    /// Any other OOXML part not modeled by the engine. Used as a
    /// catch-all so the inventory is exhaustive even for parts we
    /// haven't enumerated yet.
    Other(&'static str),
}
