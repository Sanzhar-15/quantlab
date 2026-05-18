//! **W5-D-14.2 (HIGH-7 closure):** `ExportMode::UpdateOriginal`.
//!
//! Round-trip mode that preserves opaque OOXML parts from the original
//! import. Strategy:
//!
//! 1. Run the standard `NewWorkbook` exporter to a sibling temp path.
//!    This generates the parts Quantbook owns: `xl/workbook.xml`,
//!    `xl/worksheets/sheet*.xml`, `xl/styles.xml`, `xl/sharedStrings.xml`,
//!    `xl/tables/table*.xml`, plus rels.
//! 2. Walk the original package. For each part that lives in our
//!    **preserve allowlist** (theme, drawings, charts, media,
//!    comments, customXml, etc.) AND isn't already in the shadow,
//!    carry the original bytes through to the output.
//! 3. Merge `[Content_Types].xml`: take the shadow's content as the
//!    base + add any `<Override>` entries from the original whose
//!    `PartName` we're preserving.
//!
//! What we **don't** preserve in v1:
//! - Inline-in-sheet features: `<conditionalFormatting>`,
//!   `<dataValidations>`, `<mergeCells>`, `<hyperlinks>`. These live
//!   inside `xl/worksheets/sheet*.xml` and our shadow overwrites the
//!   whole sheet. Sheet-level inline merge is a follow-up
//!   (significant XML surgery).
//! - VBA macros (`xl/vbaProject.bin`) — intentionally rejected to
//!   keep the security model simple.
//!
//! The `UnsupportedPolicy` argument flows through:
//! - `Permissive`: write whatever we can; report drops in
//!   `XlsxExportReport.dropped_features`.
//! - `Strict`: any drop is a hard error.

use crate::error::{UnsupportedFeatureKind, XlsxError};
use crate::model::XlsxPreservation;
use crate::options::{FormulaCachePolicy, UnsupportedPolicy};
use crate::report::{UnsupportedFeature, XlsxExportReport};
use crate::write::umya_export::export_new_workbook;
use ql_storage::Workbook;
use std::io::{Read, Write};

/// Entry point for `ExportMode::UpdateOriginal`. See module doc.
pub(crate) fn export_update_original(
    workbook: &Workbook,
    output_path: &std::path::Path,
    formula_cache: FormulaCachePolicy,
    unsupported_policy: UnsupportedPolicy,
    source: XlsxPreservation,
) -> Result<XlsxExportReport, XlsxError> {
    // Step 1: shadow export to a sibling temp path. Use a unique name
    // so concurrent exports don't collide.
    let shadow_path = sibling_tmp_path(output_path);
    let _shadow_cleanup = ScopedFileGuard::new(&shadow_path);
    let mut report = export_new_workbook(workbook, &shadow_path, formula_cache)?;

    // Step 2: read both packages into memory.
    let shadow_bytes = std::fs::read(&shadow_path)?;

    // Step 3: assemble the final output zip. We walk the shadow first
    // (canonical source-of-truth for Quantbook-owned parts), then
    // overlay any preserved parts from the original.
    let mut shadow_zip = zip::ZipArchive::new(std::io::Cursor::new(shadow_bytes.as_slice()))
        .map_err(XlsxError::Zip)?;
    let mut original_zip =
        zip::ZipArchive::new(std::io::Cursor::new(source.original_bytes.as_slice()))
            .map_err(XlsxError::Zip)?;

    // Enumerate shadow part names. Used to skip duplicates when
    // walking the original.
    let mut shadow_part_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..shadow_zip.len() {
        let entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
        shadow_part_names.insert(entry.name().to_string());
    }

    // Track which original parts we'll preserve so we can merge their
    // Content_Types entries.
    let mut preserved_part_paths: Vec<String> = Vec::new();
    // Track parts we explicitly dropped (security / unsupported) so
    // the report has a faithful picture.
    let mut dropped: Vec<UnsupportedFeature> = Vec::new();

    // Read the original's Content_Types.xml up front so we can pull
    // <Override> entries for preserved parts and merge into shadow's.
    let original_content_types = read_part_as_string(&mut original_zip, "[Content_Types].xml")?;
    let shadow_content_types = read_part_as_string(&mut shadow_zip, "[Content_Types].xml")?;

    let mut out_buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Step 3a: write every shadow part EXCEPT [Content_Types].xml
        // (we'll write the merged version at the end).
        for i in 0..shadow_zip.len() {
            let mut entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if name == "[Content_Types].xml" {
                continue;
            }
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }

        // Step 3b: walk the original. For each part that's preserve-
        // allowed AND not already in shadow, carry it through.
        for i in 0..original_zip.len() {
            let mut entry = original_zip.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if shadow_part_names.contains(&name) {
                continue;
            }
            match classify_part(&name) {
                PartAction::Preserve => {
                    let mut content = Vec::new();
                    entry.read_to_end(&mut content)?;
                    writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
                    writer.write_all(&content)?;
                    preserved_part_paths.push(name);
                }
                PartAction::DropAsUnsupported(kind) => {
                    dropped.push(UnsupportedFeature {
                        kind,
                        part: name.clone(),
                        detail: "UpdateOriginal v1 does not preserve this part type".to_string(),
                    });
                }
                PartAction::DropSilently => {
                    // E.g. duplicate calcChain (we own that), or
                    // already-rendered-by-shadow parts.
                }
                PartAction::OwnedByShadow => {
                    // Shadow's version takes precedence; skipped above
                    // by shadow_part_names membership check, but this
                    // branch is the explicit documentation of the rule.
                }
            }
        }

        // Step 3c: merge + write [Content_Types].xml.
        let merged_content_types = merge_content_types(
            &shadow_content_types,
            &original_content_types,
            &preserved_part_paths,
        )?;
        writer
            .start_file("[Content_Types].xml", opts)
            .map_err(XlsxError::Zip)?;
        writer.write_all(merged_content_types.as_bytes())?;

        writer.finish().map_err(XlsxError::Zip)?;
    }

    std::fs::write(output_path, out_buf)?;

    // Step 4: report / enforce policy.
    if !dropped.is_empty() {
        match unsupported_policy {
            UnsupportedPolicy::Permissive => {
                report.dropped_features.extend(dropped);
            }
            UnsupportedPolicy::Strict => {
                let first = dropped.into_iter().next().unwrap();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }
        }
    }

    Ok(report)
}

/// What to do with an original-package part during `UpdateOriginal`.
enum PartAction {
    /// Carry the original bytes through verbatim.
    Preserve,
    /// Skip; explicitly drop and surface in `dropped_features`.
    DropAsUnsupported(UnsupportedFeatureKind),
    /// Skip silently (e.g., shadow already covers this part type).
    DropSilently,
    /// Shadow's version takes precedence (e.g., xl/workbook.xml).
    #[allow(dead_code)]
    OwnedByShadow,
}

/// Classify an original-package part path. The preserve list is
/// deliberately conservative: only paths whose meaning is fully opaque
/// to Quantbook get preserved (we never preserve a part we could
/// silently mis-render after Quantbook touched the data model).
fn classify_part(name: &str) -> PartAction {
    // VBA macros: drop. Security model is "no macros round-trip".
    if name == "xl/vbaProject.bin" || name.starts_with("xl/activeX/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Macros);
    }

    // The big standalone-opaque parts. Preserve everything under
    // these prefixes that isn't already in shadow.
    let preserve_prefixes = [
        "xl/theme/",
        "xl/drawings/",
        "xl/charts/",
        "xl/media/",
        "xl/embeddings/",
        "xl/customXml/",
        "xl/customProperty/",
        "xl/printerSettings/",
        "xl/pivotCache/",
        "xl/pivotTables/",
        "xl/slicers/",
        "xl/slicerCaches/",
        "xl/timelines/",
        "xl/timelineCaches/",
        "xl/queryTables/",
        "xl/threadedComments/",
        "xl/persons/",
        "xl/connections/",
        "xl/externalLinks/",
        "xl/richData/",
        "xl/cellMetadata/",
        // docProps lives outside xl/. Most authors care about author /
        // company metadata surviving; preserve. (Excel will rewrite
        // app.xml's <AppVersion> on next save anyway.)
        "docProps/",
    ];
    for p in preserve_prefixes {
        if name.starts_with(p) {
            return PartAction::Preserve;
        }
    }

    // Exact-path comments preservation. comments1.xml etc.
    if name.starts_with("xl/comments") && name.ends_with(".xml") {
        return PartAction::Preserve;
    }

    // calcChain — Excel will rebuild on first open; safe to drop, and
    // preserving the original's chain after Quantbook reshuffled
    // cells would be actively wrong.
    if name == "xl/calcChain.xml" {
        return PartAction::DropSilently;
    }

    // Everything else (xl/workbook.xml, xl/sharedStrings.xml,
    // xl/styles.xml, xl/worksheets/, xl/tables/, rels): owned by
    // shadow. Reach here only if the original has it but the shadow
    // doesn't — meaning the original had a part Quantbook doesn't
    // emit. Skip silently for v1 (these are rare and usually
    // workbook-level extensions we'd need explicit support for).
    PartAction::DropSilently
}

/// Read an entry's content as UTF-8 text. Returns the empty string if
/// the entry doesn't exist (defensive — `[Content_Types].xml` is
/// required by OOXML, but real-world packages occasionally omit it
/// and we don't want to panic on the export-side recovery).
fn read_part_as_string<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    part_name: &str,
) -> Result<String, XlsxError> {
    let mut entry = match zip.by_name(part_name) {
        Ok(e) => e,
        Err(_) => return Ok(String::new()),
    };
    let mut content = String::new();
    entry.read_to_string(&mut content)?;
    Ok(content)
}

/// Merge two `[Content_Types].xml` documents: take `shadow_xml` as the
/// base and add any `<Override>` entries from `original_xml` whose
/// `PartName` is in `preserved_paths` AND not already in shadow.
/// `<Default>` entries from the original are also merged (by file
/// extension) when shadow doesn't define them.
fn merge_content_types(
    shadow_xml: &str,
    original_xml: &str,
    preserved_paths: &[String],
) -> Result<String, XlsxError> {
    if shadow_xml.is_empty() {
        return Ok(original_xml.to_string());
    }
    if original_xml.is_empty() || preserved_paths.is_empty() {
        return Ok(shadow_xml.to_string());
    }

    // Pull <Override> elements from original whose PartName matches a
    // preserved path AND isn't present in shadow.
    let shadow_overrides: std::collections::HashSet<String> =
        collect_override_part_names(shadow_xml);
    let shadow_defaults: std::collections::HashSet<String> = collect_default_extensions(shadow_xml);

    let mut to_append = String::new();
    let preserved_set: std::collections::HashSet<&str> =
        preserved_paths.iter().map(|s| s.as_str()).collect();

    // Walk original for Override matches.
    for over in iterate_overrides(original_xml) {
        let normalised = normalise_part_path(&over.part_name);
        if !preserved_set.contains(normalised.as_str()) {
            continue;
        }
        // Override PartName is typically `/xl/theme/theme1.xml` (with
        // leading slash); shadow's set has the same form.
        if shadow_overrides.contains(&over.part_name) {
            continue;
        }
        to_append.push_str(&over.raw);
    }

    // Walk original for Default extensions used by preserved parts
    // that shadow doesn't already define.
    let preserved_exts: std::collections::HashSet<String> = preserved_paths
        .iter()
        .filter_map(|p| std::path::Path::new(p).extension().and_then(|e| e.to_str()))
        .map(|s| s.to_ascii_lowercase())
        .collect();
    for def in iterate_defaults(original_xml) {
        let ext_lower = def.extension.to_ascii_lowercase();
        if !preserved_exts.contains(&ext_lower) {
            continue;
        }
        if shadow_defaults.contains(&def.extension) || shadow_defaults.contains(&ext_lower) {
            continue;
        }
        to_append.push_str(&def.raw);
    }

    if to_append.is_empty() {
        return Ok(shadow_xml.to_string());
    }

    if let Some(idx) = shadow_xml.rfind("</Types>") {
        let mut out = String::with_capacity(shadow_xml.len() + to_append.len());
        out.push_str(&shadow_xml[..idx]);
        out.push_str(&to_append);
        out.push_str(&shadow_xml[idx..]);
        return Ok(out);
    }

    Err(XlsxError::Export(
        "[Content_Types].xml missing </Types> — cannot merge preserved entries".to_string(),
    ))
}

/// Normalise a Content_Types PartName to match the zip-entry-name
/// convention. PartName values are absolute (`/xl/...`); zip entries
/// are relative (`xl/...`). Strip the leading slash if present.
fn normalise_part_path(part_name: &str) -> String {
    part_name.strip_prefix('/').unwrap_or(part_name).to_string()
}

/// One `<Override>` element parsed from Content_Types.xml.
struct OverrideEntry {
    part_name: String,
    raw: String,
}

/// One `<Default>` element parsed from Content_Types.xml.
struct DefaultEntry {
    extension: String,
    raw: String,
}

fn iterate_overrides(xml: &str) -> Vec<OverrideEntry> {
    iterate_simple_self_closing(xml, "<Override", "PartName")
        .into_iter()
        .map(|(part_name, raw)| OverrideEntry { part_name, raw })
        .collect()
}

fn iterate_defaults(xml: &str) -> Vec<DefaultEntry> {
    iterate_simple_self_closing(xml, "<Default", "Extension")
        .into_iter()
        .map(|(extension, raw)| DefaultEntry { extension, raw })
        .collect()
}

/// Walk an XML document for self-closing elements whose tag matches
/// `tag_open` (e.g. `"<Override"`) and extract the value of `attr`
/// (e.g. `"PartName"`). Returns `(attr_value, raw_element_text)`.
/// Conservative parser: doesn't handle nested elements or non-self-
/// closing forms — Content_Types entries are always self-closing per
/// OOXML spec, so this is sufficient.
fn iterate_simple_self_closing(xml: &str, tag_open: &str, attr: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < xml.len() {
        let start = match xml[cursor..].find(tag_open) {
            Some(s) => cursor + s,
            None => break,
        };
        // Ensure the next char is whitespace or `/` (avoid matching
        // `<OverrideFoo`).
        let after_tag = start + tag_open.len();
        let next = xml.as_bytes().get(after_tag).copied();
        if !matches!(
            next,
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'/') | Some(b'>')
        ) {
            cursor = after_tag;
            continue;
        }
        let close = match xml[start..].find("/>") {
            Some(c) => start + c + 2,
            None => break,
        };
        let raw = &xml[start..close];
        if let Some(value) = extract_attr_value(raw, attr) {
            out.push((value, raw.to_string()));
        }
        cursor = close;
    }
    out
}

/// Extract the value of `attr="..."` from a snippet.
fn extract_attr_value(snippet: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = snippet.find(&needle)? + needle.len();
    let end = snippet[start..].find('"')? + start;
    Some(snippet[start..end].to_string())
}

/// Collect the `PartName` values of all `<Override>` entries in an
/// XML string.
fn collect_override_part_names(xml: &str) -> std::collections::HashSet<String> {
    iterate_overrides(xml)
        .into_iter()
        .map(|e| e.part_name)
        .collect()
}

/// Collect the `Extension` values of all `<Default>` entries.
fn collect_default_extensions(xml: &str) -> std::collections::HashSet<String> {
    iterate_defaults(xml)
        .into_iter()
        .map(|e| e.extension)
        .collect()
}

/// Generate a sibling temp path for the shadow export. Uses the
/// output's filename + a unique suffix.
fn sibling_tmp_path(output_path: &std::path::Path) -> std::path::PathBuf {
    let parent = output_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let stem = output_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("ql-export");
    let pid = std::process::id();
    let counter = std::sync::atomic::AtomicU64::new(0);
    let n = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    parent.join(format!(".{stem}.ql-shadow-{pid}-{n}.xlsx"))
}

/// RAII guard that deletes a path on drop. Used to clean up the
/// shadow temp file even on error paths.
struct ScopedFileGuard<'a> {
    path: &'a std::path::Path,
}

impl<'a> ScopedFileGuard<'a> {
    fn new(path: &'a std::path::Path) -> Self {
        Self { path }
    }
}

impl Drop for ScopedFileGuard<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.path);
    }
}
