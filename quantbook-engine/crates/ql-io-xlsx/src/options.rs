//! Options types for xlsx import and export.
//!
//! Public surface for callers to control: recompute behavior on import,
//! how unsupported features are handled, and whether to preserve the
//! original OOXML package for high-fidelity round-trip.

use crate::model::XlsxPreservation;

/// Import-time policy.
#[derive(Debug, Clone, Default)]
pub struct XlsxImportOptions {
    /// What to do when formulas are loaded.
    pub recompute: RecomputeMode,

    /// What to do when unsupported OOXML features are detected.
    pub unsupported_policy: UnsupportedPolicy,

    /// If `true`, retain the raw OOXML package (zip bytes + part index)
    /// in the result's `preservation` field. Required for
    /// `ExportMode::UpdateOriginal` to preserve opaque OOXML parts on
    /// round-trip. Adds memory cost proportional to file size.
    pub preserve_package: bool,
}

/// Whether to recompute formulas after raw-loading the workbook.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum RecomputeMode {
    /// Recompute every formula; report failures but keep imported
    /// cached values on failure. **Default.** This is the safest mode:
    /// no formula failure destroys the user's ability to inspect or
    /// re-export the workbook.
    #[default]
    BestEffort,

    /// Recompute every formula; on first failure abort the whole
    /// import with an error. Useful for strict CI pipelines that
    /// require full engine support.
    Strict,

    /// Skip recompute entirely. Imported cached values are preserved
    /// as-is. Formulas remain in the workbook as text. Use when the
    /// caller will recompute explicitly later (e.g., in a different
    /// runtime configuration).
    Skip,
}

/// What happens when the importer / exporter detects a feature the
/// engine doesn't model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum UnsupportedPolicy {
    /// Detect-and-report: every unsupported feature is added to the
    /// import / export report; the operation succeeds. **Default.**
    /// For export: silently drops the feature from the output. For
    /// import: silently ignores the OOXML element. The caller should
    /// inspect the report to know what was lost.
    #[default]
    Permissive,

    /// Detect-and-error: any unsupported feature triggers
    /// [`XlsxError::UnsupportedFeature`]. Useful for round-trip
    /// fidelity verification — the caller doesn't want silent loss.
    Strict,
}

/// Export-time policy.
#[derive(Debug, Clone, Default)]
pub struct XlsxExportOptions {
    /// Generate-new vs update-original mode.
    pub mode: ExportMode,

    /// What to do when unsupported features would be lost.
    pub unsupported_policy: UnsupportedPolicy,

    /// What to do with formula cached values.
    pub formula_cache: FormulaCachePolicy,
}

/// Whether the export generates a new workbook or updates an existing
/// one (from a prior import).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum ExportMode {
    /// Generate a fresh xlsx from Quantbook state. Use for workbooks
    /// that originated in Quantbook (not imported from xlsx). The
    /// generated file contains only what the engine models — no
    /// preservation of features the engine doesn't track. **Default.**
    #[default]
    NewWorkbook,

    /// Patch the original xlsx package, preserving opaque OOXML parts.
    /// The `source` is the `XlsxPreservation` captured during import
    /// (requires `XlsxImportOptions::preserve_package = true`). Use
    /// for round-trip workflows where users edit a workbook that
    /// originated outside Quantbook (Excel, Sheets, LibreOffice) and
    /// want the original's CF / DV / comments / drawings to survive.
    UpdateOriginal {
        /// Original-package snapshot captured during import.
        source: XlsxPreservation,
    },
}

/// Whether to write formula cached values into the output.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum FormulaCachePolicy {
    /// Write the engine's recomputed values as cached values. Excel
    /// will display these immediately on open; recalc happens when
    /// the user triggers it. **Default.** Best for fidelity.
    #[default]
    WriteRecomputed,

    /// Don't write cached values — the consumer must recalculate.
    /// Matches `rust_xlsxwriter`'s default behavior. Useful when the
    /// engine's results may not match the consumer's recalc (e.g.,
    /// engine has W5-58 strict text divergences).
    SkipCache,
}
