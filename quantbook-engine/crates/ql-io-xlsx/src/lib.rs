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
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. The `XlsxPreservation`
//! struct and the `XlsxError`, `UnsupportedFeatureKind`, `ExportMode`,
//! `RecomputeMode`, `UnsupportedPolicy`, `FormulaCachePolicy` enums
//! all carry `#[non_exhaustive]` — downstream consumers must include
//! a `_` arm when matching across crate boundaries, and must
//! construct `XlsxPreservation` through `XlsxPreservation::new(bytes)`
//! rather than the struct-literal syntax.

#![deny(missing_docs)]

mod error;
mod model;
mod options;
mod report;

// Submodules for the read and write implementations land in W5-D-14
// itself. Stubs declared here so the public API can reference them
// without the impl crates being fully populated yet.
mod read;
// **inc.2c-12 (2026-05-27):** the writer (umya-spreadsheet + its image/rav1e/
// exr/tiff codec deps) is behind the `write` feature so reader-only consumers
// (`ql-exec`'s default build, and through it WASM / bindings) don't pull the
// heavy codec tree. `write` is ON by default for this crate's own builds/tests
// (which exercise round-trip); `ql-exec` depends with `default-features = false`
// and re-enables it only behind its own `xlsx-write` feature.
#[cfg(feature = "write")]
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

/// Injected formula-recompute provider (dependency inversion).
///
/// `ql-io-xlsx` is a pure-I/O crate and must **not** depend on the compute
/// engine (`ql-exec`): `ql-exec` owns `WorkbookSession`, whose `import` calls
/// this crate, so an `ql-io-xlsx → ql-exec` edge would form a dependency cycle.
/// Instead the importer accepts a recomputer implemented by the engine layer.
/// This mirrors the `.qbook` path, where `ql_io::load_workbook` loads raw and
/// `ql-exec` recomputes — xlsx import now splits the same way.
///
/// Implementations MUST be **BestEffort**: recompute every formula, never abort
/// on a per-cell failure, and append each *structural* failure (lex/parse/bind)
/// to `report.formula_failures`. The public-API `RecomputeMode::Strict` abort is
/// decided by the importer *after* this returns (by inspecting that vec).
/// Evaluation errors that produce a `Value::Error` cell (`#DIV/0!`, `#N/A`, …)
/// are normal cell values, NOT failures, and must not be reported here.
pub trait XlsxRecomputer {
    /// Recompute every formula in `wb`, appending structural failures to
    /// `report.formula_failures`. Returns the recomputed workbook.
    fn recompute_into(
        &self,
        wb: Workbook,
        registry: &FunctionRegistry,
        report: &mut XlsxImportReport,
    ) -> Workbook;
}

/// Import an xlsx workbook from a filesystem path.
///
/// **W5-D-14a (Phase 4.11 round-trip spine):** minimum viable import
/// — sheets + cells + formula text via calamine, with recompute pass
/// via the engine. Date system, scoped names, tables, styles, and
/// feature inventory land in subsequent W5-D-14 commits per the plan.
pub fn import_xlsx_path(
    path: impl AsRef<std::path::Path>,
    registry: &FunctionRegistry,
    options: XlsxImportOptions,
    recomputer: Option<&dyn XlsxRecomputer>,
) -> Result<XlsxImportResult, XlsxError> {
    let bytes = std::fs::read(path.as_ref())?;
    import_xlsx_bytes(&bytes, registry, options, recomputer)
}

/// Import an xlsx workbook from an in-memory byte buffer.
///
/// **W5-D-14a:** calamine grid → Workbook + recompute pass.
/// **W5-D-14b:** OOXML scanner — `xl/workbook.xml` for date system +
/// scoped defined names, feature inventory for unsupported parts
/// (CF, DV, comments, drawings, etc.).
pub fn import_xlsx_bytes(
    bytes: &[u8],
    registry: &FunctionRegistry,
    options: XlsxImportOptions,
    recomputer: Option<&dyn XlsxRecomputer>,
) -> Result<XlsxImportResult, XlsxError> {
    let mut report = XlsxImportReport::default();

    // **W5-D-14b — Phase 0**: build the OOXML package handle. Shared
    // between the workbook-properties parse, the feature-inventory
    // scan, and (later) the styles + tables parsers.
    let package = read::package::XlsxPackage::from_bytes(bytes.to_vec());

    // **W5-D-14b — Phase 0a**: parse `xl/workbook.xml` for the date
    // system + scoped defined names. Authoritative for these
    // (calamine drops `localSheetId`).
    let workbook_props = read::workbook_xml::parse_workbook_xml(&package)?;

    // **W5-D-PM-3 (megaudit Opus-B HIGH-7 closure):** zero-sheet
    // workbook is invalid OOXML — Excel rejects on any meaningful
    // operation. The prior import accepted silently. Strict mode
    // had no way to fire because `feature_inventory` was clean.
    // Reject early as a typed error.
    if workbook_props.sheets.is_empty() {
        return Err(XlsxError::MalformedOoxml {
            part: "xl/workbook.xml".to_string(),
            message: "workbook has no <sheet> elements (Excel requires ≥1 sheet)".to_string(),
        });
    }

    // **W5-D-PM-3 (megaudit Opus-A HIGH-3 closure):** record any
    // hidden / veryHidden sheets in the feature inventory.
    // Quantbook's `Sheet` doesn't model visibility state, so on
    // export via `UpdateOriginal` the shadow's workbook.xml
    // replaces the original's `state` attrs — silently dropping
    // the visibility. The inventory entry lets Strict mode surface
    // the loss + Permissive callers see it.
    for sheet in &workbook_props.sheets {
        if !matches!(sheet.state, read::workbook_xml::SheetState::Visible) {
            report
                .feature_inventory
                .record(UnsupportedFeatureKind::HiddenSheets);
        }
    }

    // **W5-D-14b — Phase 0b**: scan for unsupported OOXML features.
    // Populates `report.feature_inventory`; respects
    // `options.unsupported_policy` further down.
    read::feature_inventory::scan_unsupported_features(&package, &mut report.feature_inventory)?;

    // Phase 1 — build the calamine grid reader. Calamine takes
    // ownership of the byte buffer (it needs random-access reads
    // into the zip).
    let mut grid = read::calamine_grid::CalamineGrid::from_bytes(bytes.to_vec())?;

    // Phase 2 — raw-load cells + formula text into a fresh
    // Workbook. No recompute yet (per Codex's
    // "raw-load first, recompute as separate phase" architecture).
    let (mut workbook, _cells_loaded, _formulas_loaded) =
        read::convert::build_workbook_from_grid(&mut grid, &mut report)?;

    // **W5-D-14b — Phase 2a**: apply workbook-level properties from
    // the OOXML scanner. Date system is the most-load-bearing —
    // every date serial in the workbook depends on it.
    workbook.set_date_system(workbook_props.date_system);

    // **W5-D-14c — Phase 2c**: import tables. Walks each sheet's
    // `.rels` file, resolves table xml paths, parses each, registers
    // with the workbook's TableTable. Tables are now available for
    // structured-ref binding (e.g. `=Sales[Qty]`) immediately after
    // import. Closes Phase 4.11 acceptance XLSX-4-03 (tables-side).
    //
    // **W5-D-14.1 (audit HIGH-9 closure):** the sheet → rels-path map
    // is now derived from `xl/_rels/workbook.xml.rels` (the
    // OOXML-spec-correct path) instead of the prior 1:1 sheet-index
    // heuristic. Real-world workbooks where sheets have been
    // deleted/reordered no longer attach tables to the wrong sheet.
    let _sheet_names_unused_post_w5_d_14_1 = grid.sheet_names();
    let sheet_rels_paths = read::sheet_parts::build_sheet_rels_paths(&package, &workbook_props)?;
    let _tables_imported =
        read::tables_import::import_tables(&package, &mut workbook, &sheet_rels_paths)?;

    // **W5-D-PM-3 / NF-04 (w128 audit fold):** the prior standalone warning
    // loop here re-computed `build_sheet_part_paths` a second time to warn on
    // `<sheet>` entries whose r:id didn't resolve. After NF-04 that case is no
    // longer a warning — `build_sheet_part_paths` (already called above via
    // `build_sheet_rels_paths`, and again below for the style scan) now
    // ERRORS loudly on a missing r:id, so the loop could only ever fire for
    // the distinct path-escape sentinel. The warning was therefore both
    // redundant (3rd identical computation) and misleadingly worded; it is
    // consolidated into the per-cell-style scan loop below, with a corrected
    // message.

    // **W5-D-14d — Phase 2d**: import styles. Parses `xl/styles.xml`
    // for custom number formats (`numFmtId >= 164`) and registers
    // them with the workbook's FormatTable via `register_at` so the
    // imported id matches the OOXML id exactly (replay-determinism
    // for round-trip). Per-cell application landed in W5-D-15 — see
    // the cell-styles scanner wiring below.
    let style_index = read::styles_xml::parse_styles_xml(&package)?;
    let _custom_formats_registered =
        read::styles_import::register_custom_formats(&mut workbook, &style_index)?;

    // **W5-D-15 — Phase 2d-bis (XLSX-4-03 per-cell format closure):**
    // walk each sheet's worksheet xml, parse `<c r="..." s="N"/>`
    // pairs, and populate `Sheet::format_overlay`. Cells with `s="0"`
    // or absent `s` use General — no overlay entry needed.
    let sheet_part_paths = read::sheet_parts::build_sheet_part_paths(&package, &workbook_props)?;
    for (sheet_idx, part_path) in sheet_part_paths.iter().enumerate() {
        if part_path.is_empty() {
            // **W5-D-PM-3 / NF-04 (w128 fold):** post-NF-04,
            // `build_sheet_part_paths` ERRORS on a `<sheet>` whose r:id is
            // absent from `xl/_rels/workbook.xml.rels`, so an empty slot here
            // is NOT a missing r:id — it is the path-escape sentinel
            // (`resolve_rel_target` returns "" for a `Target=` that walks
            // above the package root). Surface that distinct, hostile-path
            // cause as a warning; the sheet's styles/content are skipped.
            if let Some(sheet) = workbook_props.sheets.get(sheet_idx) {
                report.warnings.push(XlsxWarning {
                    location: format!("sheet[{}] '{}'", sheet_idx, sheet.name),
                    message: format!(
                        "sheet r:id={:?} resolves to a Target outside the package root \
                         (path-escape); sheet styles/content will be empty",
                        sheet.r_id
                    ),
                });
            }
            continue;
        }
        let Some(content) = package.read_part_string(part_path)? else {
            continue;
        };
        let styled_cells = read::cell_styles_xml::parse_cell_styles_xml(&content, part_path)?;
        if styled_cells.is_empty() {
            continue;
        }
        // Phase 5.2 D-1 step 8 megaudit closure (Codex MEDIUM-1,
        // 2026-05-20): pre-collect overlay set instructions so we can
        // partition into "id resolves in FormatTable" vs "unregistered
        // custom id" without holding two borrows on `workbook`.
        // Unregistered custom ids skip the overlay set + add an
        // UnsupportedFeature entry so the caller learns about the
        // malformed xlsx file IMMEDIATELY at import — not later at
        // .qbook save (where MalformedFormatOverlay fires).
        let mut planned_sets: Vec<(u32, u32, ql_storage::FormatId)> = Vec::new();
        let mut unresolved_drops: Vec<(u32, u32, u32, ql_storage::FormatId)> = Vec::new();
        for (row, col, xf_idx) in styled_cells {
            let Some(xf) = style_index.cell_xfs.get(xf_idx as usize) else {
                continue;
            };
            if !xf.apply_number_format {
                continue;
            }
            if xf.num_fmt_id == 0 {
                continue;
            }
            // Phase 5.2 D-1 step 3: xlsx import uses the legacy
            // u32 → FormatId migration helper. n <= 163 → Builtin(n);
            // n >= 164 → Custom(LEGACY_PEER, n - 164). All imported
            // custom ids land under LEGACY_PEER (xlsx has no peer
            // concept).
            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
            // Validate: id must be registered in the format table.
            // Builtins (0..=163) are always present via FormatTable::default();
            // Customs (>=164) require a matching `<numFmt>` entry that
            // styles_import processed earlier.
            if workbook.formats().lookup(fmt_id).is_some() {
                planned_sets.push((row, col, fmt_id));
            } else {
                unresolved_drops.push((row, col, xf.num_fmt_id, fmt_id));
            }
        }
        // Apply the resolved sets.
        if !planned_sets.is_empty() {
            let Some(sheet) = workbook.sheet_mut(sheet_idx as ql_types::SheetId) else {
                continue;
            };
            for (row, col, fmt_id) in planned_sets {
                sheet.format_overlay_mut().set(row, col, fmt_id);
            }
        }
        // Report the unresolved drops so the caller sees them at
        // import time. Per the no-fallback rule: silent loss
        // (cell would render as General on read) is forbidden;
        // explicit reporting is the closure.
        for (row, col, raw_id, fmt_id) in unresolved_drops {
            report.unsupported.push(UnsupportedFeature {
                kind: UnsupportedFeatureKind::Other("xlsx-overlay-unregistered-numfmt"),
                part: part_path.to_string(),
                detail: format!(
                    "sheet {sheet_idx} cell ({row},{col}) references numFmtId={raw_id} \
                     (=> {fmt_id:?}) which has no <numFmt> declaration in xl/styles.xml; \
                     overlay entry skipped (cell renders as General)"
                ),
            });
        }
    }

    // **W5-D-14.2 — Phase 2e (HIGH-4 closure):** register defined names
    // (workbook-scope + sheet-scope) into the engine's `NameTable` /
    // `Sheet::scoped_names`. Names whose target text doesn't match
    // the simple-address subset fall back to `NamedTarget::Formula`
    // (deferred to the bind-aware parser).
    let _names_registered =
        read::names_import::register_defined_names(&mut workbook, &workbook_props)?;

    // **W5-D-14b — Phase 2b**: apply UnsupportedPolicy::Strict if any
    // unsupported features were detected. Permissive mode just
    // leaves the inventory in the report.
    if options.unsupported_policy == UnsupportedPolicy::Strict
        && !report.feature_inventory.is_clean()
    {
        // Pick the first kind to put in the error; full inventory is
        // already in the report.
        let (first_kind, _count) = report
            .feature_inventory
            .counts
            .iter()
            .next()
            .expect("inventory non-empty per is_clean() check");
        return Err(XlsxError::UnsupportedFeature {
            feature: *first_kind,
            part: "workbook".to_string(),
            detail: format!(
                "strict mode rejected {} unsupported feature kind(s); see import report",
                report.feature_inventory.counts.len()
            ),
        });
    }

    // Phase 3 — recompute (dispatched by RecomputeMode). The recompute provider
    // is INJECTED (dependency inversion via `XlsxRecomputer`) so this crate does
    // not depend on the compute engine. BestEffort/Strict require a recomputer;
    // a missing one is a loud caller error (No-Fallbacks), never a silent skip.
    let workbook = match options.recompute {
        RecomputeMode::Skip => workbook,
        RecomputeMode::BestEffort => {
            let recomputer = recomputer.ok_or_else(|| {
                XlsxError::Engine(
                    "RecomputeMode::BestEffort requires a recomputer, but none was provided"
                        .to_string(),
                )
            })?;
            recomputer.recompute_into(workbook, registry, &mut report)
        }
        RecomputeMode::Strict => {
            let recomputer = recomputer.ok_or_else(|| {
                XlsxError::Engine(
                    "RecomputeMode::Strict requires a recomputer, but none was provided"
                        .to_string(),
                )
            })?;
            let recomputed = recomputer.recompute_into(workbook, registry, &mut report);
            if !report.formula_failures.is_empty() {
                // Strict mode: any failure is fatal.
                return Err(XlsxError::Engine(format!(
                    "strict recompute failed: {} formula(s) couldn't be evaluated; first: \
                     sheet={}, row={}, col={}, formula={:?}, reason={}",
                    report.formula_failures.len(),
                    report.formula_failures[0].sheet,
                    report.formula_failures[0].row,
                    report.formula_failures[0].col,
                    report.formula_failures[0].formula,
                    report.formula_failures[0].reason,
                )));
            }
            recomputed
        }
    };

    // Phase 4 — preservation handle. We stash the original bytes
    // verbatim; UpdateOriginal mode reads from `original_bytes`
    // directly.
    let preservation = if options.preserve_package {
        Some(XlsxPreservation {
            original_bytes: bytes.to_vec(),
        })
    } else {
        None
    };

    Ok(XlsxImportResult {
        workbook,
        report,
        preservation,
    })
}

/// Export a `Workbook` to an xlsx file.
///
/// **W5-D-14e:** `ExportMode::NewWorkbook` wired through
/// umya-spreadsheet. Cells + formula text + cached values
/// round-trip. `ExportMode::UpdateOriginal` (preserve opaque OOXML
/// parts from a prior import) lands in a follow-up.
///
/// **inc.2c-12 (2026-05-27):** behind the `write` feature (the umya writer
/// dependency tree). See [`export_xlsx_bytes`] for the in-memory companion.
#[cfg(feature = "write")]
pub fn export_xlsx_path(
    workbook: &Workbook,
    _registry: &FunctionRegistry,
    out: impl AsRef<std::path::Path>,
    options: XlsxExportOptions,
) -> Result<XlsxExportReport, XlsxError> {
    let out_path = out.as_ref();
    match options.mode {
        ExportMode::NewWorkbook => {
            // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** previously
            // NewWorkbook ignored `unsupported_policy`. Things that
            // SHOULD be dropped (Constant(Error)/Constant(Blank)
            // named-target values; future-deferred features) never
            // populated `dropped_features` and never triggered Strict.
            // Now collect drops + enforce policy. The exporter populates
            // `report.dropped_features`; we apply Strict here.
            //
            // **Phase 5.2 D-1 step 6 audit closure (Codex HIGH-3,
            // 2026-05-20):** when Strict fires post-write, the lossy
            // file is still on disk. The contract is "Strict means no
            // loss" — a caller who sees `Err` must be able to assume
            // the destination wasn't touched. Pre-closure this was
            // false: NewWorkbook Strict would create/overwrite
            // `out_path` and then return Err, leaving a partial-
            // semantic file behind. Now: on Strict-fail, delete the
            // file we just wrote so the no-loss contract holds.
            let mut report =
                write::umya_export::export_new_workbook(workbook, out_path, options.formula_cache)?;
            report.warnings.shrink_to_fit();
            if !report.dropped_features.is_empty()
                && options.unsupported_policy == UnsupportedPolicy::Strict
            {
                // Remove the lossy file before returning Err. Best-
                // effort: if removal itself fails, we still return the
                // original UnsupportedFeature error (the dropped-feature
                // information is more useful than the IO error for the
                // caller's debugging).
                let _ = std::fs::remove_file(out_path);
                let first = report.dropped_features[0].clone();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }
            Ok(report)
        }
        ExportMode::UpdateOriginal { source } => write::update_original::export_update_original(
            workbook,
            out_path,
            options.formula_cache,
            options.unsupported_policy,
            source,
        ),
    }
}

/// Export a `Workbook` to xlsx **bytes** (in-memory, no filesystem side
/// effects).
///
/// **inc.2c-12 (2026-05-27):** the in-memory companion to [`export_xlsx_path`],
/// backing `WorkbookSession::export("xlsx")` (the engine session trait returns
/// `Vec<u8>`). umya 2.2.0 exposes `writer::xlsx::write_writer<W: io::Write>`, so
/// the package is serialized straight into a `Vec<u8>` and the post-process
/// pass runs in memory — no tempfile.
///
/// Only [`ExportMode::NewWorkbook`] is supported. [`ExportMode::UpdateOriginal`]
/// patches an on-disk source package and has no in-memory-bytes path in v1; a
/// caller that requests it gets a loud [`XlsxError::Export`] rather than a
/// silent downgrade to `NewWorkbook` (No-Fallbacks).
///
/// Returns the bytes plus the [`XlsxExportReport`] (the
/// `dropped_features`/`warnings` fidelity record), matching `export_xlsx_path`.
/// Under [`UnsupportedPolicy::Strict`] any dropped feature is a hard error
/// (nothing was written, so — unlike the path variant — there is no file to
/// clean up).
#[cfg(feature = "write")]
pub fn export_xlsx_bytes(
    workbook: &Workbook,
    _registry: &FunctionRegistry,
    options: XlsxExportOptions,
) -> Result<(Vec<u8>, XlsxExportReport), XlsxError> {
    match options.mode {
        ExportMode::NewWorkbook => {
            let (bytes, mut report) =
                write::umya_export::export_new_workbook_to_bytes(workbook, options.formula_cache)?;
            report.warnings.shrink_to_fit();
            if !report.dropped_features.is_empty()
                && options.unsupported_policy == UnsupportedPolicy::Strict
            {
                let first = report.dropped_features[0].clone();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }
            Ok((bytes, report))
        }
        ExportMode::UpdateOriginal { .. } => Err(XlsxError::Export(
            "UpdateOriginal mode is not supported for in-memory bytes export in v1; \
             use export_xlsx_path for round-trip package patching"
                .to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_nonexistent_file_returns_io_error() {
        // **W5-D-14a:** import path now wired through calamine. A
        // missing file surfaces as `XlsxError::Io`, not a panic.
        let reg = ql_functions::default_registry();
        let opts = XlsxImportOptions::default();
        // NOTE: the lib-test cannot reference `ql_exec::EngineXlsxRecomputer`
        // here — that impl targets the *normal-dependency* copy of this crate
        // (`ql-exec -> ql-io-xlsx`), a distinct crate instance from the one the
        // lib-test compiles against, so the trait bound never matches. `None`
        // is correct because a missing file fails at `std::fs::read` before the
        // recompute phase is ever reached.
        match import_xlsx_path(
            "/tmp/this-file-does-not-exist-xlsxio.xlsx",
            &reg,
            opts,
            None,
        ) {
            Err(XlsxError::Io(_)) => {}
            other => panic!("expected Io error, got {other:?}"),
        }
    }

    #[test]
    fn import_invalid_bytes_returns_zip_error() {
        // **W5-D-14b:** invalid bytes (not a zip) surface as a
        // structured xlsx error. After W5-D-14b the OOXML scanner
        // runs first (package handle), so the failure is `Zip` not
        // `Calamine` (pre-W5-D-14b ordering).
        let reg = ql_functions::default_registry();
        let opts = XlsxImportOptions::default();
        // NOTE: `None` (not `ql_exec::EngineXlsxRecomputer`) — see the lib-test
        // crate-instance note above. Invalid bytes fail at the OOXML/zip parse
        // before the recompute phase, so the recomputer is never invoked.
        match import_xlsx_bytes(b"not an xlsx file", &reg, opts, None) {
            Err(XlsxError::Zip(_)) | Err(XlsxError::Calamine(_)) => {}
            other => panic!("expected Zip or Calamine error, got {other:?}"),
        }
    }

    // **inc.2c-12:** exercises the writer (`export_xlsx_path`), so gated on the
    // `write` feature. (The crate's own test builds enable `write` by default.)
    #[cfg(feature = "write")]
    #[test]
    fn export_update_original_empty_preservation_falls_through_to_shadow() {
        // **W5-D-14.2 (HIGH-7 closure):** UpdateOriginal with empty
        // preservation bytes is a degenerate case — the implementation
        // should detect that there's nothing to preserve and surface
        // a zip-parse error (empty bytes are not a valid zip).
        let reg = ql_functions::default_registry();
        let wb = Workbook::new();
        let preservation = XlsxPreservation {
            original_bytes: Vec::new(),
        };
        let export_opts = XlsxExportOptions {
            mode: ExportMode::UpdateOriginal {
                source: preservation,
            },
            ..Default::default()
        };
        let tmp = std::env::temp_dir().join("w5-d-14-2-update-original-empty.xlsx");
        let _ = std::fs::remove_file(&tmp);
        match export_xlsx_path(&wb, &reg, &tmp, export_opts) {
            Err(XlsxError::Zip(_)) => {} // empty bytes → zip parse error
            other => panic!("expected Zip error for empty preservation, got {other:?}"),
        }
        let _ = std::fs::remove_file(&tmp);
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
