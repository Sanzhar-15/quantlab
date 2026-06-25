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

    // Enumerate shadow part names. Used in step 3a/3b for precedence
    // decisions.
    let mut shadow_part_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..shadow_zip.len() {
        let entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
        shadow_part_names.insert(entry.name().to_string());
    }

    // Enumerate original part names — used so step 3a can decide
    // whether to skip shadow's version of an "original-wins" part
    // (theme, docProps, customXml). Without this check we'd silently
    // replace the original's theme/docProps with umya's stubs even
    // though `classify_part` flags them as Preserve.
    //
    // **W5-D-14.2.3 (separate-Opus H-1 closure).**
    let mut original_part_names: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for i in 0..original_zip.len() {
        let entry = original_zip.by_index(i).map_err(XlsxError::Zip)?;
        original_part_names.insert(entry.name().to_string());
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
        // (merged later) AND EXCEPT "original-wins" parts where the
        // original also has them. Original-wins parts get written by
        // step 3b — writing shadow's stub here would clobber the real
        // content.
        //
        // **W5-D-14.2.3 (separate-Opus H-1 closure):** prior version
        // wrote shadow first unconditionally, so for paths shadow ALSO
        // emits (theme1.xml, docProps/app.xml, docProps/core.xml) the
        // original's bytes were dropped — even though `classify_part`
        // marks those paths Preserve. Verified empirically:
        // basic_text.xlsx round-trip lost
        // `<dc:creator>Nicolas Hatcher</dc:creator>` and the original
        // theme1.xml (8390 bytes) was replaced by umya's stub (6518).
        for i in 0..shadow_zip.len() {
            let mut entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if name == "[Content_Types].xml" {
                continue;
            }
            if matches!(classify_part(&name), PartAction::Preserve)
                && original_part_names.contains(&name)
            {
                // Original wins; step 3b will emit it.
                continue;
            }
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }

        // Step 3b: walk the original. Two paths:
        // (1) original-wins parts that ALSO exist in shadow — skipped
        //     in step 3a, write here.
        // (2) parts that aren't in shadow at all — classify_part
        //     decides.
        for i in 0..original_zip.len() {
            let mut entry = original_zip.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if name == "[Content_Types].xml" {
                continue;
            }
            let action = classify_part(&name);
            let in_shadow = shadow_part_names.contains(&name);

            if in_shadow {
                // Only write original if it's an original-wins
                // (Preserve) path. Otherwise shadow's content was
                // already written in step 3a.
                if matches!(action, PartAction::Preserve) {
                    let mut content = Vec::new();
                    entry.read_to_end(&mut content)?;
                    writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
                    writer.write_all(&content)?;
                    preserved_part_paths.push(name);
                }
                continue;
            }

            match action {
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

    // **W5-D-PM-3 (megaudit self H-2 / Opus-A MEDIUM-1 closure):**
    // scan the ORIGINAL's worksheet xmls for inline-feature
    // signatures (`<conditionalFormatting>`, `<dataValidations>`,
    // `<mergeCells>`, `<hyperlinks>`, `<sheetProtection>`). These
    // are not standalone parts (so `classify_part` never sees them),
    // but the shadow's worksheet xml REPLACES the original's — they
    // get clobbered. Without this scan, Strict mode would silently
    // permit the loss. Now each inline feature found gets a
    // `dropped` entry that the policy enforcement below honours.
    let inline_drops = scan_inline_features(&source.original_bytes)?;
    dropped.extend(inline_drops);

    // **W5-D-14.2.2 (Codex audit H-B closure):** enforce the
    // unsupported-policy decision BEFORE writing the output. Prior
    // ordering wrote the (lossy) file first and then errored, which
    // could destroy a caller's pre-existing file at `output_path`
    // under `Strict` mode. The contract is "Strict means no-loss";
    // touching the user's destination on a drop violates it.
    //
    // **Phase 5.2 D-1 step 6 audit closure (Codex HIGH-3, 2026-05-20):**
    // pre-closure, the Strict check only inspected the local `dropped`
    // vector (preserved-parts tracking + inline drops in this module).
    // The `export_new_workbook` shadow call ALSO populates
    // `report.dropped_features` (e.g. the multi-peer-format-id-flatten
    // entries shipped at step 6). Strict UpdateOriginal could succeed
    // while losing data through those entries. Closure: merge BOTH
    // sources before the Strict check.
    let mut all_drops: Vec<UnsupportedFeature> = dropped;
    all_drops.append(&mut report.dropped_features);
    if !all_drops.is_empty() {
        match unsupported_policy {
            UnsupportedPolicy::Permissive => {
                report.dropped_features.extend(all_drops);
            }
            UnsupportedPolicy::Strict => {
                let first = all_drops.into_iter().next().unwrap();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }
        }
    }

    // **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** atomic write
    // via tmp + rename. See `umya_export::atomic_write_to_path`.
    crate::write::umya_export::atomic_write_to_path_public(output_path, &out_buf)?;

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
}

/// Classify an original-package part path. The preserve list is
/// deliberately narrow.
///
/// **W5-D-14.2.2 (Codex audit H-A closure):** any part that is
/// REACHED via a sheet-level relationship (drawings, charts, comments,
/// embeddings, media, oleObjects) cannot be preserved by the
/// shadow+overlay strategy alone — the shadow's worksheet xml +
/// sheet rels REPLACE the original's, so the `<drawing r:id="...">`
/// inline anchor and the matching `<Relationship>` are both gone.
/// Without those references, the preserved part exists in the zip
/// but is unreachable.
///
/// Until we ship the sheet-rels + inline-anchor merge (v2 of
/// UpdateOriginal), sheet-anchored parts are honestly DROPPED with
/// a `dropped_features` entry. Only the parts that survive via
/// workbook-level / root-level rels (theme, customXml, docProps) are
/// preserved — and even those rely on the shadow's rels rendering
/// the same rel target paths (e.g. `xl/theme/theme1.xml`).
fn classify_part(name: &str) -> PartAction {
    // VBA macros: drop. Security model is "no macros round-trip".
    if name == "xl/vbaProject.bin" || name.starts_with("xl/activeX/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Macros);
    }

    // **Workbook- / root-anchored parts** — these survive via rels
    // umya/shadow emits at workbook/root level (or via fixed-path
    // conventions Excel understands).
    if name.starts_with("xl/theme/") {
        return PartAction::Preserve;
    }
    // `xl/customXml/` IS a directory (item1.xml, itemProps1.xml...).
    if name.starts_with("xl/customXml/") {
        return PartAction::Preserve;
    }
    // `xl/customProperty.xml` is a SINGLE file, not a directory.
    // **W5-D-14.2.3 (separate-Opus H-3 closure):** the prior code
    // checked `starts_with("xl/customProperty/")` which never matches
    // the real path.
    if name == "xl/customProperty.xml" {
        return PartAction::Preserve;
    }
    if name.starts_with("docProps/") {
        return PartAction::Preserve;
    }

    // **Sheet-anchored parts** — drop honestly until v2 rels-merge.
    // Each variant maps to the closest `UnsupportedFeatureKind` so
    // `dropped_features` is informative.
    if name.starts_with("xl/drawings/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Drawings);
    }
    if name.starts_with("xl/charts/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Drawings);
    }
    if name.starts_with("xl/media/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Images);
    }
    if name.starts_with("xl/embeddings/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("embeddings"));
    }
    if name.starts_with("xl/comments") && name.ends_with(".xml") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Comments);
    }
    if name.starts_with("xl/threadedComments/") || name.starts_with("xl/persons/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Comments);
    }
    if name.starts_with("xl/pivotCache/") || name.starts_with("xl/pivotTables/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::PivotTables);
    }
    if name.starts_with("xl/slicers/")
        || name.starts_with("xl/slicerCaches/")
        || name.starts_with("xl/timelines/")
        || name.starts_with("xl/timelineCaches/")
    {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other(
            "slicers-and-timelines",
        ));
    }
    // `xl/queryTables/` is a directory; `xl/connections.xml` is a
    // single file. Both relate to Power Query / external data.
    // **W5-D-14.2.3 (separate-Opus H-3 closure):** the prior code
    // checked `starts_with("xl/connections/")` which never matches
    // the real `xl/connections.xml` path — workbook had its
    // connections feature silently dropped without a `dropped_features`
    // entry.
    if name.starts_with("xl/queryTables/") || name == "xl/connections.xml" {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("query-tables"));
    }
    if name.starts_with("xl/externalLinks/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::ExternalLinks);
    }
    // `xl/cellMetadata.xml` is a single file too (W5-D-14.2.3 H-3 fix).
    if name.starts_with("xl/richData/") || name == "xl/cellMetadata.xml" {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("rich-data"));
    }
    if name.starts_with("xl/printerSettings/") {
        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("printer-settings"));
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

/// **W5-D-PM-3 (megaudit self H-2 / Opus-A MEDIUM-1 closure):** scan
/// the original zip for inline-feature signatures inside worksheet
/// xmls. Returns one `UnsupportedFeature` entry per (sheet path,
/// feature kind) pair found.
///
/// Detection is substring-based, scoped to `xl/worksheets/*.xml`.
/// False positives possible (a literal `<conditionalFormatting>` in
/// a cell value would match) but real-world cell content doesn't
/// contain XML element syntax — they'd be escaped to entities.
fn scan_inline_features(original_bytes: &[u8]) -> Result<Vec<UnsupportedFeature>, XlsxError> {
    let mut out = Vec::new();
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(original_bytes)).map_err(XlsxError::Zip)?;
    let inline_signatures: &[(&str, UnsupportedFeatureKind)] = &[
        (
            "<conditionalFormatting",
            UnsupportedFeatureKind::ConditionalFormatting,
        ),
        ("<dataValidations", UnsupportedFeatureKind::DataValidation),
        ("<mergeCells", UnsupportedFeatureKind::Other("mergeCells")),
        ("<hyperlinks", UnsupportedFeatureKind::Hyperlinks),
        ("<sheetProtection", UnsupportedFeatureKind::Protection),
    ];
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(XlsxError::Zip)?;
        let name = entry.name().to_string();
        if !name.starts_with("xl/worksheets/") || !name.ends_with(".xml") {
            continue;
        }
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_err() {
            continue;
        }
        for (sig, kind) in inline_signatures {
            if content.contains(sig) {
                out.push(UnsupportedFeature {
                    kind: *kind,
                    part: name.clone(),
                    detail: format!(
                        "UpdateOriginal v1 does not preserve inline-in-sheet feature {:?}; \
                         shadow's worksheet xml replaces the original",
                        sig
                    ),
                });
            }
        }
    }
    Ok(out)
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
///
/// **W5-D-14.2 self-audit HIGH-1 fix:** the counter MUST be
/// module-static (not per-call); a per-call `AtomicU64::new(0)`
/// returns `0` every time, defeating concurrent-call dedup. Two
/// threads exporting to the same parent dir would otherwise race
/// on the same shadow filename.
fn sibling_tmp_path(output_path: &std::path::Path) -> std::path::PathBuf {
    static SHADOW_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = output_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let stem = output_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("ql-export");
    let pid = std::process::id();
    let n = SHADOW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
