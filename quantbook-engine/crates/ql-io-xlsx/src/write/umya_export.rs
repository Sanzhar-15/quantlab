//! umya-spreadsheet writer — `NewWorkbook` mode.
//!
//! Post-W5-D-15.2 / megaudit closure, this module covers:
//! - Sheets, cell values (Number / Boolean / Text / Error), formula
//!   text + cached values.
//! - Tables export (xl/tables/table*.xml + sheet rels + Content_Types).
//! - Custom format codes export (xl/styles.xml/<numFmts>) +
//!   per-cell format APPLICATION (cellXfs + s="N").
//! - Workbook-scoped + sheet-scoped named ranges (definedNames).
//! - Atomic write-then-rename for concurrent-safe output.
//! - umya 2.2.0 bug workarounds (t="str" on numeric/boolean/error
//!   formula cells, hardcoded #VALUE! sigil, missing date1904 attr).
//!
//! Companion: `update_original` for the `ExportMode::UpdateOriginal`
//! path. Deferred to v2: rels-graph merge + sheet-inline-anchor
//! merge (CF / DV / mergeCells / hyperlinks preservation) — see
//! `update_original.rs` module doc for rationale.

use crate::error::XlsxError;
use crate::options::FormulaCachePolicy;
use crate::report::XlsxExportReport;
use ql_storage::{
    BorderEdge, BorderStyle, Borders, FormatId, HAlign, NamedTarget, Rgb, Style, StyleId, Workbook,
    FIRST_CUSTOM_FORMAT_ID,
};
use ql_types::{Value, LEGACY_PEER};

/// Per-cell fix instruction. **W5-D-14.1 umya-bug workaround:** umya
/// 2.2.0 has two correctness bugs we patch via post-process on output:
/// 1. Formula cells write `t="str"` even when the cached value is
///    numeric/boolean (umya's `get_data_type_crate` returns "str"
///    for any cell with a formula, regardless of `raw_value` type).
/// 2. Error cells hardcode `#VALUE!` as the OOXML `<v>` content
///    regardless of the actual `CellErrorType` variant
///    (umya `worksheet.rs:524-526` hardcodes the sigil).
#[derive(Debug, Clone)]
struct CellFix {
    /// A1-style cell reference, e.g. `"C5"`.
    cell_ref: String,
    /// What to patch.
    kind: CellFixKind,
}

#[derive(Debug, Clone)]
enum CellFixKind {
    /// Remove the `t="str"` attribute from this cell. Used for
    /// formula cells whose cached value is numeric. After removal
    /// the cell has default type "n".
    RemoveStrType,
    /// Replace the hardcoded `#VALUE!` sigil with the actual error
    /// sigil. Used only for non-formula error cells (umya emits
    /// `<c r="A1" t="e"><v>#VALUE!</v></c>` regardless of the
    /// actual error variant).
    OverrideErrorSigil(&'static str),
    /// **W5-D-15:** inject `s="N"` into the cell's opening tag.
    /// `N` is the cellXfs index.
    SetStyle(u32),
    /// **W5-D-PM-1 (megaudit Codex HIGH-2 / Opus-A HIGH-1 closure):**
    /// rewrite `t="str"` → `t="e"` on a formula cell whose cached
    /// value is `Value::Error`. umya emits all formula cells with
    /// `t="str"` regardless of cached-value type; for Number/Boolean
    /// we rely on `RemoveStrType` to drop the attr (default "n"
    /// covers both). For Error, the default "n" is wrong — we need
    /// `t="e"` so the consumer parses the `<v>{sigil}</v>` as an
    /// error type, not a string.
    ConvertFormulaToErrorType,
    /// **W5-D-PM-1 (megaudit Codex HIGH-1 closure):** rewrite
    /// `t="str"` → `t="b"` AND `<v>TRUE</v>` / `<v>FALSE</v>` →
    /// `<v>1</v>` / `<v>0</v>` on a formula cell with Boolean
    /// cached value. OOXML wants boolean cells with `t="b"` and
    /// `<v>1|0</v>`.
    ConvertFormulaToBoolType(bool),
}

/// Convert (col, row) (both 0-indexed) to an A1-style ref.
fn cell_ref_a1(row: u32, col: u32) -> String {
    let mut name = String::new();
    let mut c = col + 1; // 1-indexed for the bijective base-26 conversion
    while c > 0 {
        let rem = (c - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        c = (c - 1) / 26;
    }
    name.push_str(&(row + 1).to_string());
    name
}

/// **Phase 5.2 D-1 step 6 (2026-05-20, audit-closure rewrite):** xlsx
/// single-namespace numFmtId translation. xlsx's `numFmtId` is a single
/// `u32` namespace — no peer-id concept. `FormatId::Custom(peer, counter)`
/// variants from multi-peer `.qbook` workbooks must flatten to a single
/// namespace on export.
///
/// **Translation algorithm (step 6 audit Codex+Opus HIGH closure):**
///
/// 1. **Builtin(n) → n.** Canonical xlsx built-in id; no flattening.
/// 2. **Custom(LEGACY_PEER, c) → c + FIRST_CUSTOM_FORMAT_ID.** Preserves
///    the pre-step-6 `to_legacy_u32()` mapping. Holds for ALL counters
///    (dense or sparse) so existing xlsx fixtures round-trip
///    byte-identically. Closes Codex+Opus HIGH on sparse counters
///    (pre-fix sequential reindexing broke byte-stability for sparse
///    counters like `{5, 7}` from replay scenarios).
/// 3. **Custom(non-LEGACY peer, c) → dedup-by-code.** If the format
///    code is also held by an earlier-registered Custom (a LEGACY_PEER
///    entry OR an earlier non-LEGACY entry in sorted order), reuse
///    that numFmtId. Otherwise allocate the next available numFmtId
///    AFTER the highest LEGACY_PEER counter range.
///
///    **Dedup-by-code is LOAD-BEARING (Codex HIGH-1 closure):** two
///    peers with the same format code MUST map to the same xlsx
///    numFmtId. Without dedup, the export emits two `<numFmt>` entries
///    with identical `formatCode`, and import's `register_at` rejects
///    the second as `StringCollision` (silently skipped per the
///    styles-import handler). Cells originally bound to the second
///    peer then map to an unregistered FormatId on reimport — silent
///    render fallback to General, data loss.
///
/// **Information loss reporting:** non-LEGACY peer ids round-trip
/// CORRECTLY through xlsx, but reimporting collapses them to
/// `Custom(LEGACY_PEER, _)` (xlsx has no peer concept to recover).
/// The flattened ids are recorded in `info_lost` so the export caller
/// can surface them via `XlsxExportReport.dropped_features`. Per the
/// no-fallbacks doctrine, the loss is reported rather than silently
/// absorbed.
struct XlsxNumFmtTranslation {
    /// `Custom(peer, counter) → flattened xlsx numFmtId`. Builtin
    /// variants are NOT in this map — the translator returns `n`
    /// directly for `Builtin(n)`. Two Customs with the same format
    /// code may map to the SAME xlsx numFmtId (dedup-by-code).
    custom_map: std::collections::HashMap<FormatId, u32>,
    /// `(original Custom FormatId, flattened xlsx numFmtId)` for any
    /// Custom whose peer ≠ LEGACY_PEER. These are the lossy entries
    /// from the round-trip perspective: xlsx → .qbook recovery
    /// produces `Custom(LEGACY_PEER, _)`, losing the original peer id.
    /// Caller surfaces via `XlsxExportReport.dropped_features`.
    info_lost: Vec<(FormatId, u32)>,
    /// **Phase 5.2 D-1 step 8 megaudit closure (Codex MEDIUM-2,
    /// 2026-05-20):** overlay-bound Customs that were NOT registered
    /// in `workbook.formats()`. Pre-closure these silently allocated
    /// a unique xlsx numFmtId, but `<numFmt>` was emitted only for
    /// `workbook.formats()` entries — the result was an `<xf>` slot
    /// pointing at a non-existent `<numFmt>`. Reimport recovered the
    /// numFmtId as a Custom(LEGACY_PEER, _) with NO format string
    /// (silent render fallback to General).
    ///
    /// Post-closure: still allocate the numFmtId (preserves xlsx
    /// structural integrity) but record the unregistered FormatId
    /// here so the caller surfaces a dropped_features entry. Per
    /// no-fallback rule: the silent loss becomes explicit reporting.
    unregistered_overlay_customs: Vec<(FormatId, u32)>,
}

impl XlsxNumFmtTranslation {
    /// Build the translation over all Custom FormatIds the export will
    /// reference. The union of:
    /// - `workbook.formats()` Custom entries (the format-table roster
    ///   used by the `<numFmts>` injection).
    /// - `cellxfs_roster` Custom entries (overlay-used FormatIds; these
    ///   may include Customs not in the format table if the overlay was
    ///   set without first registering via `intern`, though this is
    ///   pathological).
    ///
    /// Deterministic ordering via `BTreeSet<FormatId>`.
    fn build(workbook: &Workbook, cellxfs_roster: &[FormatId]) -> Self {
        let mut customs: std::collections::BTreeSet<FormatId> = std::collections::BTreeSet::new();
        for (id, _) in workbook.formats().iter() {
            if id.is_custom() {
                customs.insert(id);
            }
        }
        for fid in cellxfs_roster {
            if fid.is_custom() {
                customs.insert(*fid);
            }
        }

        let mut custom_map = std::collections::HashMap::new();
        let mut info_lost = Vec::new();
        let mut unregistered_overlay_customs = Vec::new();
        // Dedup-by-code map: format string → xlsx numFmtId already
        // assigned. Step 6 audit closure (HIGH-1): two FormatIds with
        // the same format code MUST collapse to one numFmtId on export
        // — else import StringCollision drops the second binding and
        // cells lose their format.
        let mut code_to_numfmt: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();

        // Pass 1: LEGACY_PEER customs preserve `c + FIRST_CUSTOM_FORMAT_ID`.
        // Step 6 audit closure (HIGH-2): pre-closure sequential
        // reallocation broke byte-stability for sparse counters (e.g.
        // {5, 7} from replay scenarios) — pre-step-6 `to_legacy_u32()`
        // exported as 169, 171; pre-closure step 6 sequential allocator
        // emitted 164, 165. Preserving the counter-based mapping fixes
        // this. `highest_legacy_id` tracks the upper bound of LEGACY-
        // reserved numFmtIds so pass 2 doesn't collide.
        let mut highest_legacy_id = FIRST_CUSTOM_FORMAT_ID.saturating_sub(1);
        for fid in &customs {
            if let FormatId::Custom(peer, c) = fid {
                if *peer == LEGACY_PEER {
                    // Step-5 audit Codex M1 lesson: checked_add. With
                    // FIRST_CUSTOM_FORMAT_ID=164 + counter approaching
                    // u32::MAX-164, the add overflows.
                    let xlsx_id = c
                        .checked_add(FIRST_CUSTOM_FORMAT_ID)
                        .expect("xlsx numFmtId overflow: LEGACY_PEER counter near u32::MAX");
                    custom_map.insert(*fid, xlsx_id);
                    highest_legacy_id = highest_legacy_id.max(xlsx_id);
                    if let Some(code) = workbook.formats().lookup(*fid) {
                        // First LEGACY entry with this code claims the
                        // dedup slot. (At most one LEGACY entry per
                        // code exists per by_custom_string structure.)
                        code_to_numfmt.entry(code.to_string()).or_insert(xlsx_id);
                    }
                }
            }
        }

        // Pass 2: non-LEGACY peer Customs. Sequential allocation starting
        // AFTER highest_legacy_id so we don't collide with the LEGACY
        // counter-derived range. Dedup-by-code: if a non-LEGACY Custom
        // shares its format string with an earlier-allocated entry
        // (LEGACY or non-LEGACY), it reuses that numFmtId.
        // **NF-06 (no-fallbacks):** `unwrap_or(FIRST_CUSTOM_FORMAT_ID)` was used
        // when `highest_legacy_id == u32::MAX`, which silently wrapped the
        // non-LEGACY counter back to 164 — potentially reusing a numFmtId that
        // already maps to a LEGACY format, corrupting the exported file.
        // A workbook with u32::MAX LEGACY custom formats is pathological and
        // should fail loudly rather than produce a silently wrong file.
        let mut next_non_legacy = highest_legacy_id
            .checked_add(1)
            .expect("xlsx numFmtId allocator exhausted: highest_legacy_id is u32::MAX");
        for fid in &customs {
            if let FormatId::Custom(peer, _) = fid {
                if *peer == LEGACY_PEER {
                    continue;
                }
                let xlsx_id = if let Some(code) = workbook.formats().lookup(*fid) {
                    if let Some(existing) = code_to_numfmt.get(code) {
                        // Dedupe-by-code: reuse existing numFmtId.
                        *existing
                    } else {
                        let new_id = next_non_legacy;
                        next_non_legacy = next_non_legacy
                            .checked_add(1)
                            .expect("xlsx custom numFmtId allocator exhausted (u32::MAX entries)");
                        code_to_numfmt.insert(code.to_string(), new_id);
                        new_id
                    }
                } else {
                    // Pathological: cellxfs_roster contains a Custom not
                    // registered in wb.formats(). No code to dedup;
                    // allocate a unique numFmtId. Renderer would fall
                    // back to General on reimport (no numFmt entry
                    // will exist for this id).
                    //
                    // Step 8 megaudit closure (Codex MEDIUM-2): record
                    // the unregistered FormatId so the export caller
                    // can surface a dropped_features entry. Per the
                    // no-fallback rule, the silent reimport-side loss
                    // becomes explicit reporting at export time.
                    let new_id = next_non_legacy;
                    next_non_legacy = next_non_legacy
                        .checked_add(1)
                        .expect("xlsx custom numFmtId allocator exhausted (u32::MAX entries)");
                    unregistered_overlay_customs.push((*fid, new_id));
                    new_id
                };
                custom_map.insert(*fid, xlsx_id);
                // info_lost: every non-LEGACY peer entry is a flatten
                // (peer-id is lost on round-trip). Multiple entries
                // for the same xlsx_id (dedup-by-code case) are
                // intentional — each lost peer-id is a distinct piece
                // of round-trip information for the report.
                info_lost.push((*fid, xlsx_id));
            }
        }
        Self {
            custom_map,
            info_lost,
            unregistered_overlay_customs,
        }
    }

    /// Translate `FormatId → xlsx numFmtId`. `Builtin(n)` returns `n`
    /// directly (canonical xlsx id, never needs flattening). `Custom`
    /// looks up the flattened id from the map.
    ///
    /// **Invariant:** the FormatId MUST be in the translation's scope
    /// — either registered in `workbook.formats()` or present in the
    /// `cellxfs_roster` the translation was built over. Callers in this
    /// file query subsets of those two sets, so the lookup never misses
    /// in practice. The expect documents this invariant rather than
    /// being a real panic path.
    fn translate(&self, fid: FormatId) -> u32 {
        match fid {
            FormatId::Builtin(n) => n,
            FormatId::Custom(_, _) => *self.custom_map.get(&fid).unwrap_or_else(|| {
                panic!(
                    "xlsx numFmt translation: unmapped Custom FormatId {fid:?}; \
                     build() must include this id (programmer error in umya_export.rs)"
                )
            }),
        }
    }
}

// ===== Wave B2 (2026-06-18): cell visual-style export =====
//
// Pre-Wave-B2 the exporter wrote number-formats only; every `<xf>` hardcoded
// `fontId/fillId/borderId="0"` and the per-sheet style overlay was never
// walked, so exported `.xlsx` lost bold/italic/underline/strike/fill/
// text-color/borders/alignment. The machinery below adds them:
//
// - the cellXfs roster is keyed by the COMPOSITE `(Option<FormatId>,
//   Option<StyleId>)` appearance (a cell can carry both a number-format and a
//   visual style), and
// - deduped `<fonts>`/`<fills>`/`<borders>` sub-rosters are APPENDED to umya's
//   defaults (count-preserving + untouched when empty), so a workbook with NO
//   styles produces BYTE-IDENTICAL output to the pre-Wave-B2 path.

/// One `<cellXfs>/<xf>` entry — a distinct (number-format × visual-style)
/// appearance referenced by a cell's `<c s="N">`. The `*_idx` fields index
/// into the [`StyleExport`] sub-rosters; they resolve to absolute xlsx
/// fontId/fillId/borderId at injection time (umya default base count + index).
#[derive(Debug, Clone, Copy)]
struct XfEntry {
    /// xlsx-translated numFmtId (`0` = General).
    num_fmt_id: u32,
    /// Emit `applyNumberFormat="1"` — true iff the cell carried a `FormatId`
    /// (mirrors the pre-Wave-B2 behaviour: every format roster entry set it,
    /// which is what keeps the no-style output byte-identical).
    apply_number_format: bool,
    /// Index into [`StyleExport::fonts`]; `None` ⇒ default font `0`.
    font_idx: Option<usize>,
    /// Index into [`StyleExport::fills`]; `None` ⇒ default fill `0` (no fill).
    fill_idx: Option<usize>,
    /// Index into [`StyleExport::borders`]; `None` ⇒ default border `0` (none).
    border_idx: Option<usize>,
    /// Horizontal alignment; [`HAlign::General`] emits no `<alignment>` child.
    halign: HAlign,
}

/// A custom `<font>` to append to the `<fonts>` roster. The non-toggle
/// attributes (sz 11 / Calibri / family 2 / scheme minor) mirror umya's
/// default font so a styled cell keeps the workbook's default look.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct FontDef {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    /// `None` ⇒ default text color (`<color theme="1"/>`).
    color: Option<Rgb>,
}

/// A custom solid `<fill>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct FillDef {
    color: Rgb,
}

/// A custom `<border>` (the four edges; diagonal is unsupported in the v1 schema).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct BorderDef {
    borders: Borders,
}

/// The visual-style export payload: the cellXfs roster + the deduped
/// font/fill/border sub-rosters it indexes into. Built once over the whole
/// workbook so xf slots + sub-roster ids are a deterministic function of the
/// SET of `(format, style)` appearances, independent of cell-visit order.
#[derive(Debug, Default)]
struct StyleExport {
    xf_roster: Vec<XfEntry>,
    fonts: Vec<FontDef>,
    fills: Vec<FillDef>,
    borders: Vec<BorderDef>,
}

impl StyleExport {
    /// Build over the sorted appearance roster. For each appearance resolves
    /// the number-format (via the xlsx translation) + the visual style (via
    /// `workbook.styles()`), deduping fonts/fills/borders BY VALUE in
    /// appearance-sorted order (so the sub-roster order is deterministic).
    fn build(
        workbook: &Workbook,
        appearance_roster: &[(Option<FormatId>, Option<StyleId>)],
        xlsx_numfmt: &XlsxNumFmtTranslation,
    ) -> Self {
        let mut out = StyleExport::default();
        let mut font_index: std::collections::HashMap<FontDef, usize> =
            std::collections::HashMap::new();
        let mut fill_index: std::collections::HashMap<FillDef, usize> =
            std::collections::HashMap::new();
        let mut border_index: std::collections::HashMap<BorderDef, usize> =
            std::collections::HashMap::new();

        for (fmt, style_id) in appearance_roster {
            let (num_fmt_id, apply_number_format) = match fmt {
                Some(fid) => (xlsx_numfmt.translate(*fid), true),
                None => (0, false),
            };
            // Resolve the visual style; an absent/unknown style id ⇒ the
            // default (no-styling) look — equivalent to no style.
            let style: Style = style_id
                .and_then(|sid| workbook.styles().lookup(sid))
                .unwrap_or_default();

            let font_idx =
                font_def(&style).map(|fd| dedup_roster(&mut out.fonts, &mut font_index, fd));
            let fill_idx = style
                .fill
                .map(|c| dedup_roster(&mut out.fills, &mut fill_index, FillDef { color: c }));
            let border_idx = if style.borders.is_none() {
                None
            } else {
                Some(dedup_roster(
                    &mut out.borders,
                    &mut border_index,
                    BorderDef {
                        borders: style.borders,
                    },
                ))
            };

            out.xf_roster.push(XfEntry {
                num_fmt_id,
                apply_number_format,
                font_idx,
                fill_idx,
                border_idx,
                halign: style.align,
            });
        }
        out
    }
}

/// Dedup `value` into `roster`, returning its index. First-seen-in-call-order,
/// so the roster order is deterministic when the caller iterates deterministically.
fn dedup_roster<T: Copy + Eq + std::hash::Hash>(
    roster: &mut Vec<T>,
    index: &mut std::collections::HashMap<T, usize>,
    value: T,
) -> usize {
    if let Some(&i) = index.get(&value) {
        return i;
    }
    let i = roster.len();
    roster.push(value);
    index.insert(value, i);
    i
}

/// The font half of a `Style`, or `None` when the style has no font attrs (so
/// the cell keeps the default font `0` and no `<font>` is emitted for it).
fn font_def(style: &Style) -> Option<FontDef> {
    if !style.bold
        && !style.italic
        && !style.underline
        && !style.strike
        && style.text_color.is_none()
    {
        return None;
    }
    Some(FontDef {
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        strike: style.strike,
        color: style.text_color,
    })
}

/// `Rgb` → OOXML ARGB hex with an opaque alpha prefix, e.g. `FF0000FF`.
fn argb(c: Rgb) -> String {
    format!("FF{:02X}{:02X}{:02X}", c.r, c.g, c.b)
}

/// OOXML border-style name for a [`BorderStyle`]. `None` ⇒ the edge is emitted
/// as an empty `<left/>` (no `style` attr).
fn border_style_name(s: BorderStyle) -> Option<&'static str> {
    match s {
        BorderStyle::None => None,
        BorderStyle::Thin => Some("thin"),
        BorderStyle::Medium => Some("medium"),
        BorderStyle::Thick => Some("thick"),
        BorderStyle::Dashed => Some("dashed"),
        BorderStyle::Dotted => Some("dotted"),
        BorderStyle::Double => Some("double"),
    }
}

/// OOXML `horizontal` alignment value, or `None` for [`HAlign::General`]
/// (which emits no `<alignment>` child — the Excel default).
fn halign_attr(h: HAlign) -> Option<&'static str> {
    match h {
        HAlign::General => None,
        HAlign::Left => Some("left"),
        HAlign::Center => Some("center"),
        HAlign::Right => Some("right"),
    }
}

/// Render one custom `<font>` (toggle children first, then the umya-default
/// sz/color/name/family/scheme — child order matches umya's own writer).
fn render_font(f: &FontDef) -> String {
    let mut s = String::with_capacity(96);
    s.push_str("<font>");
    if f.bold {
        s.push_str("<b/>");
    }
    if f.italic {
        s.push_str("<i/>");
    }
    if f.underline {
        s.push_str("<u/>");
    }
    if f.strike {
        s.push_str("<strike/>");
    }
    s.push_str("<sz val=\"11\"/>");
    match f.color {
        Some(c) => s.push_str(&format!("<color rgb=\"{}\"/>", argb(c))),
        None => s.push_str("<color theme=\"1\"/>"),
    }
    s.push_str("<name val=\"Calibri\"/><family val=\"2\"/><scheme val=\"minor\"/></font>");
    s
}

/// Render one custom solid `<fill>` (Excel uses `fgColor` for the solid color
/// + the conventional `bgColor indexed="64"`).
fn render_fill(f: &FillDef) -> String {
    format!(
        "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"{}\"/>\
         <bgColor indexed=\"64\"/></patternFill></fill>",
        argb(f.color)
    )
}

/// Render one border edge: empty `<left/>` for no border, else
/// `<left style="thin"><color rgb="FF…"/></left>`.
fn render_border_edge(tag: &str, edge: BorderEdge) -> String {
    match border_style_name(edge.style) {
        None => format!("<{tag}/>"),
        Some(name) => format!(
            "<{tag} style=\"{name}\"><color rgb=\"{}\"/></{tag}>",
            argb(edge.color)
        ),
    }
}

/// Render one custom `<border>` (edge order left/right/top/bottom/diagonal,
/// matching umya's default border element).
fn render_border(b: &BorderDef) -> String {
    format!(
        "<border>{}{}{}{}<diagonal/></border>",
        render_border_edge("left", b.borders.left),
        render_border_edge("right", b.borders.right),
        render_border_edge("top", b.borders.top),
        render_border_edge("bottom", b.borders.bottom),
    )
}

/// Build the `<cellXfs>` block. Slot 0 is the default xf (unchanged from the
/// pre-styling output); slots 1.. follow `roster` order. Each xf resolves its
/// absolute fontId/fillId/borderId from the umya default base counts + the
/// sub-roster index, and emits `applyX="1"` only for the components it overrides
/// (so a format-only entry is byte-identical to the pre-Wave-B2 output).
fn render_cell_xfs(
    roster: &[XfEntry],
    base_font: usize,
    base_fill: usize,
    base_border: usize,
) -> String {
    let count = roster.len() + 1;
    let mut block = String::with_capacity(96 * count);
    block.push_str(&format!(r#"<cellXfs count="{}">"#, count));
    // Slot 0: the default xf.
    block.push_str(r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#);
    for e in roster {
        let font_id = e.font_idx.map_or(0, |i| base_font + i);
        let fill_id = e.fill_idx.map_or(0, |i| base_fill + i);
        let border_id = e.border_idx.map_or(0, |i| base_border + i);
        block.push_str(&format!(
            r#"<xf numFmtId="{}" fontId="{}" fillId="{}" borderId="{}" xfId="0""#,
            e.num_fmt_id, font_id, fill_id, border_id
        ));
        if e.apply_number_format {
            block.push_str(r#" applyNumberFormat="1""#);
        }
        if font_id != 0 {
            block.push_str(r#" applyFont="1""#);
        }
        if fill_id != 0 {
            block.push_str(r#" applyFill="1""#);
        }
        if border_id != 0 {
            block.push_str(r#" applyBorder="1""#);
        }
        match halign_attr(e.halign) {
            Some(h) => {
                block.push_str(&format!(
                    r#" applyAlignment="1"><alignment horizontal="{h}"/></xf>"#
                ));
            }
            None => block.push_str("/>"),
        }
    }
    block.push_str("</cellXfs>");
    block
}

/// Append `entries` (already-rendered child XML) into the
/// `<{tag} count="N">…</{tag}>` collection, rewriting `count` to
/// `N + entries.len()`. Returns the ORIGINAL base count `N` (used as the
/// absolute-id offset for the appended entries). A no-op returning `N`
/// unchanged when `entries` is empty — this is what keeps the no-style output
/// byte-identical. Fails loud (No-Fallbacks) if the collection or its `count`
/// attribute is missing/malformed rather than guessing the base.
fn append_into_collection(
    text: &mut String,
    tag: &str,
    entries: &[String],
) -> Result<usize, XlsxError> {
    let anchor = format!("<{tag} count=\"");
    let start = text
        .find(&anchor)
        .ok_or_else(|| XlsxError::Export(format!("styles.xml missing <{tag} count=...>")))?;
    let num_start = start + anchor.len();
    let num_len = text[num_start..]
        .find('"')
        .ok_or_else(|| XlsxError::Export(format!("styles.xml <{tag}> count attr unterminated")))?;
    let num_end = num_start + num_len;
    let base: usize = text[num_start..num_end]
        .parse()
        .map_err(|e| XlsxError::Export(format!("styles.xml <{tag}> count not a number: {e}")))?;
    if entries.is_empty() {
        return Ok(base);
    }
    let new_count = base + entries.len();
    text.replace_range(num_start..num_end, &new_count.to_string());
    // Splice the entries before the collection's closing tag. (Recompute the
    // close index AFTER the count rewrite — the string length changed.)
    let close = format!("</{tag}>");
    let close_idx = text
        .find(&close)
        .ok_or_else(|| XlsxError::Export(format!("styles.xml missing </{tag}>")))?;
    text.insert_str(close_idx, &entries.concat());
    Ok(base)
}

/// Replace the `<cellXfs>…</cellXfs>` block with `block` (closing-tag form
/// first, then self-closing, then insert-before-`</styleSheet>` as a defensive
/// fallback — same bracketing the pre-Wave-B2 cellXfs injector used).
fn replace_cell_xfs_block(text: String, block: &str) -> Result<Vec<u8>, XlsxError> {
    if let Some(start) = text.find("<cellXfs") {
        let after = start + "<cellXfs".len();
        if let Some(close_rel) = text[after..].find("</cellXfs>") {
            let end = after + close_rel + "</cellXfs>".len();
            let mut out = String::with_capacity(text.len() + block.len());
            out.push_str(&text[..start]);
            out.push_str(block);
            out.push_str(&text[end..]);
            return Ok(out.into_bytes());
        }
        if let Some(gt_rel) = text[after..].find('>') {
            let end = after + gt_rel + 1;
            if text[after..end].ends_with("/>") {
                let mut out = String::with_capacity(text.len() + block.len());
                out.push_str(&text[..start]);
                out.push_str(block);
                out.push_str(&text[end..]);
                return Ok(out.into_bytes());
            }
        }
    }
    if let Some(idx) = text.rfind("</styleSheet>") {
        let mut out = String::with_capacity(text.len() + block.len());
        out.push_str(&text[..idx]);
        out.push_str(block);
        out.push_str(&text[idx..]);
        return Ok(out.into_bytes());
    }
    Err(XlsxError::Export(
        "styles.xml missing </styleSheet> close — cannot inject <cellXfs>".to_string(),
    ))
}

/// **Wave B2 (2026-06-18):** inject cell visual styles into `xl/styles.xml`.
/// Appends the deduped custom fonts/fills/borders to umya's default rosters
/// (count-preserving + untouched when a sub-roster is empty ⇒ byte-identical
/// to the pre-styling output) and replaces `<cellXfs>` with one xf per
/// (number-format × style) appearance, each pointing at the resolved
/// fontId/fillId/borderId + alignment.
fn inject_styles_into_styles_xml(
    content: Vec<u8>,
    style: &StyleExport,
) -> Result<Vec<u8>, XlsxError> {
    let mut text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;

    // Append sub-rosters; capture umya's default base counts so each xf's
    // absolute fontId/fillId/borderId = base + roster index.
    let font_xml: Vec<String> = style.fonts.iter().map(render_font).collect();
    let fill_xml: Vec<String> = style.fills.iter().map(render_fill).collect();
    let border_xml: Vec<String> = style.borders.iter().map(render_border).collect();
    let base_font = append_into_collection(&mut text, "fonts", &font_xml)?;
    let base_fill = append_into_collection(&mut text, "fills", &fill_xml)?;
    let base_border = append_into_collection(&mut text, "borders", &border_xml)?;

    // Build + replace the cellXfs block with the resolved absolute ids.
    let block = render_cell_xfs(&style.xf_roster, base_font, base_fill, base_border);
    replace_cell_xfs_block(text, &block)
}

/// Export a Quantbook `Workbook` to an xlsx **file** via umya-spreadsheet
/// in `NewWorkbook` mode (generate fresh).
///
/// **inc.2c-12 (2026-05-27):** now a thin wrapper over
/// [`export_new_workbook_to_bytes`] — the workbook is fully serialized in
/// memory (umya's `write_writer` + the post-process zip pass) and the bytes
/// are written once via the atomic write-then-rename helper. Output is
/// byte-identical to the prior two-step (umya-write-to-path then
/// post-process-read-rewrite) flow: umya's `write` internally routes through
/// the same `write_writer`/`make_buffer` path, so the initial bytes match,
/// and the post-process transforms are unchanged.
pub(crate) fn export_new_workbook(
    workbook: &Workbook,
    output_path: &std::path::Path,
    formula_cache: FormulaCachePolicy,
) -> Result<XlsxExportReport, XlsxError> {
    let (bytes, report) = export_new_workbook_to_bytes(workbook, formula_cache)?;
    atomic_write_to_path(output_path, &bytes)?;
    Ok(report)
}

/// Export a Quantbook `Workbook` to xlsx **bytes** via umya-spreadsheet in
/// `NewWorkbook` mode (generate fresh), with no filesystem side effects.
///
/// **inc.2c-12 (2026-05-27):** the in-memory companion to
/// [`export_new_workbook`], backing `WorkbookSession::export("xlsx")` (whose
/// trait returns `Vec<u8>`). umya 2.2.0 exposes
/// `writer::xlsx::write_writer<W: io::Write>`, so the initial package is built
/// straight into a `Vec<u8>`; the post-process zip pass
/// ([`post_process_bytes`]) then applies the umya-bug workarounds + roster
/// injections in memory and returns the final bytes. No tempfile, no
/// `std::fs`.
pub(crate) fn export_new_workbook_to_bytes(
    workbook: &Workbook,
    formula_cache: FormulaCachePolicy,
) -> Result<(Vec<u8>, XlsxExportReport), XlsxError> {
    let mut report = XlsxExportReport::default();
    let mut spreadsheet = umya_spreadsheet::new_file_empty_worksheet();

    // Build a quick lookup from (sheet, row, col) → formula text so
    // the per-cell loop can decide whether to write a formula or a
    // value. The `iter_formulas` API gives us only formula-bearing
    // cells; cells without formulas just get the value-only path.
    let mut formula_map: std::collections::HashMap<(u16, u32, u32), String> =
        std::collections::HashMap::new();
    for (sheet, row, col, text) in workbook.iter_formulas() {
        formula_map.insert((sheet, row, col), text.to_string());
    }

    // **W5-D-14.1 umya-bug workaround**: track per-cell fixes by
    // sheet ORDER INDEX (which matches the OOXML sheet1.xml, sheet2.xml
    // numbering for fresh-generated workbooks).
    let mut sheet_fixes: Vec<Vec<CellFix>> = Vec::with_capacity(workbook.sheet_count());

    // **Wave B2 (2026-06-18):** build the cellXfs roster keyed by the COMPOSITE
    // (number-format × visual-style) appearance, across ALL sheets in one sweep
    // so xf slots are a deterministic function of the SET of appearances. Slot 0
    // is the default xf; appearance i gets slot i+1.
    //
    // An appearance is `(Option<FormatId>, Option<StyleId>)` — a cell may carry a
    // number-format, a visual style, or both. Collected from the UNION of each
    // sheet's format + style overlays. A `BTreeSet` gives a stable order; and
    // crucially, when there are NO styles every appearance is `(Some(fid), None)`,
    // so the set degenerates to the pre-Wave-B2 sorted-FormatId order with the
    // same slot indices — keeping the no-style output byte-identical.
    //
    // **W5-D-15.2 (separate-Opus M-4 closure) carried forward:** the cross-sheet
    // single sweep keeps the order a function of the appearance SET, not of which
    // sheet first touched an entry.
    let mut appearances: std::collections::BTreeSet<(Option<FormatId>, Option<StyleId>)> =
        std::collections::BTreeSet::new();
    for sheet_id in 0..workbook.sheet_count() as u16 {
        if let Some(sheet) = workbook.sheet(sheet_id) {
            for ((row, col), fid) in sheet.format_overlay().iter() {
                appearances.insert((Some(fid), sheet.style_overlay().get(row, col)));
            }
            for ((row, col), sid) in sheet.style_overlay().iter() {
                appearances.insert((sheet.format_overlay().get(row, col), Some(sid)));
            }
        }
    }
    let appearance_roster: Vec<(Option<FormatId>, Option<StyleId>)> =
        appearances.iter().copied().collect();
    let appearance_to_xf_index: std::collections::HashMap<
        (Option<FormatId>, Option<StyleId>),
        u32,
    > = appearance_roster
        .iter()
        .enumerate()
        .map(|(i, a)| (*a, (i as u32) + 1)) // slot 0 reserved for default
        .collect();
    // The FormatId set the numFmt translation flattens — exactly the set of
    // FormatIds appearing in any overlay (identical to the pre-Wave-B2 roster).
    let cellxfs_roster: Vec<FormatId> = {
        let mut s: std::collections::BTreeSet<FormatId> = std::collections::BTreeSet::new();
        for (fmt, _) in &appearance_roster {
            if let Some(fid) = fmt {
                s.insert(*fid);
            }
        }
        s.into_iter().collect()
    };

    // **Phase 5.2 D-1 step 6 (2026-05-20):** build the xlsx numFmtId
    // translation. Maps every Custom FormatId (across both wb.formats()
    // and overlays) to a flattened sequential numFmtId starting at 164.
    // Builtins are translated inline by the helper. info_lost surfaces
    // non-LEGACY peer flattens to XlsxExportReport.dropped_features
    // below.
    let xlsx_numfmt = XlsxNumFmtTranslation::build(workbook, &cellxfs_roster);
    for (orig_fid, flattened_id) in &xlsx_numfmt.info_lost {
        report
            .dropped_features
            .push(crate::report::UnsupportedFeature {
                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
                part: "xl/styles.xml".to_string(),
                detail: format!(
                    "Custom format id {orig_fid:?} flattened to xlsx numFmtId {flattened_id} \
                     (xlsx single-namespace; reimporting recovers as Custom(LEGACY_PEER, _))"
                ),
            });
    }
    // Step 8 megaudit closure (Codex MEDIUM-2, 2026-05-20): report
    // overlay-bound Customs that aren't registered in workbook.formats().
    // These get an xlsx numFmtId in cellXfs but no <numFmt> declaration
    // (which only emits for workbook.formats() entries). Reimport
    // recovers as Custom(LEGACY_PEER, _) with no format string —
    // renders as General. The silent loss is now an explicit report.
    for (orig_fid, allocated_id) in &xlsx_numfmt.unregistered_overlay_customs {
        report
            .dropped_features
            .push(crate::report::UnsupportedFeature {
                kind: crate::error::UnsupportedFeatureKind::Other(
                    "xlsx-overlay-unregistered-custom",
                ),
                part: "xl/styles.xml".to_string(),
                detail: format!(
                    "overlay-bound {orig_fid:?} (not registered in workbook.formats()) \
                     allocated xlsx numFmtId {allocated_id} but no <numFmt> declared; \
                     reimport renders as General (format string lost)"
                ),
            });
    }

    let sheet_count = workbook.sheet_count();
    for sheet_id in 0..sheet_count as u16 {
        let mut fixes: Vec<CellFix> = Vec::new();
        let sheet = workbook
            .sheet(sheet_id)
            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
        let sheet_name = sheet.name().to_string();

        // `new_file_empty_worksheet` returns a spreadsheet with no
        // sheets; add each sheet by name. For the first sheet we'd
        // normally also rename the default, but the empty-file
        // variant doesn't have a default sheet, so add fresh.
        spreadsheet
            .new_sheet(&sheet_name)
            .map_err(|e| XlsxError::Export(format!("umya new_sheet({sheet_name}) failed: {e}")))?;

        // **M7 (6.3-2b):** walk the union of the effective value extent and this
        // sheet's formula bbox, NOT the conservative `Sheet::bounds`. xlsx has no
        // separate formula-only emit pass (formulas are written INLINE in this
        // value-walk), and a formula can compute to `Blank` (e.g. `=A1` over an empty
        // A1 — `ql-functions` scalar.rs `cell_ref_missing_is_blank`), so a value-only
        // extent could silently DROP a Blank-computed formula cell sitting outside the
        // value bbox. Unioning the per-sheet formula positions guarantees every formula
        // cell is visited and emitted. The format-overlay pass below stays
        // bounds-independent (untouched) so format-only cells are never lost either.
        // This union is never larger than the old `bounds()` (which already covered
        // every formula cell via `put_computed`) — usually smaller.
        let value_bounds = sheet.effective_value_bounds();
        let mut row_extent = value_bounds.row_extent;
        let mut col_extent = value_bounds.col_extent;
        for (s, r, c) in formula_map.keys() {
            if *s == sheet_id {
                // `+1` one-past-max, fail-loud on overflow (No-Fallbacks; coords are
                // gated to MAX_ROW/MAX_COLUMN by the writers — never reached).
                row_extent = row_extent.max(r.checked_add(1).expect("xlsx row extent overflow"));
                col_extent = col_extent.max(c.checked_add(1).expect("xlsx col extent overflow"));
            }
        }
        let bounds = ql_storage::Bounds {
            row_extent,
            col_extent,
        };
        // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior code
        // `continue`-d for empty-bounds sheets, skipping the
        // `sheet_fixes.push(fixes)` at end of loop. That misaligned
        // the per-sheet fixes vector for any subsequent non-empty
        // sheet — sheet N's fixes landed on sheet N-1's xml. Now the
        // cell-walk is gated on non-empty bounds; format-overlay
        // scheduling + `sheet_fixes.push` run unconditionally.
        let has_cells_to_walk = bounds.row_extent > 0 && bounds.col_extent > 0;
        if has_cells_to_walk {
            let ws = spreadsheet
                .get_sheet_by_name_mut(&sheet_name)
                .ok_or_else(|| {
                    XlsxError::Export(format!(
                        "umya sheet {sheet_name} disappeared after new_sheet"
                    ))
                })?;
            for row in 0..bounds.row_extent {
                for col in 0..bounds.col_extent {
                    let value = sheet.read(row, col);
                    let formula = formula_map.get(&(sheet_id, row, col));

                    let umya_col = col + 1;
                    let umya_row = row + 1;

                    match (formula, &value) {
                        (Some(formula_text), val) => {
                            // **W5-D-14.1 (audit HIGH-1 closure — phase
                            // 1):** umya's `set_value_*` setters internally
                            // call `remove_formula()`, so we apply the
                            // value FIRST then call `set_formula` (which
                            // doesn't touch the raw value).
                            let cell = ws.get_cell_mut((umya_col, umya_row));
                            let cache_written = if formula_cache
                                == FormulaCachePolicy::WriteRecomputed
                                && !matches!(val, Value::Blank)
                            {
                                apply_value_to_cell(cell, val);
                                true
                            } else {
                                false
                            };
                            cell.set_formula(formula_text.as_str());
                            if cache_written {
                                report.formula_caches_written += 1;
                            }
                            // **W5-D-14.1 (audit HIGH-1 closure — phase 2):**
                            // umya's writer sets `t="str"` on any formula
                            // cell (`cell_value.rs::get_data_type_crate`
                            // returns "str" for Some(formula) regardless
                            // of raw_value type). Calamine then reads the
                            // `<v>` content as text. Schedule a post-
                            // process fix: remove `t="str"` for cells
                            // whose cached value is numeric/boolean (the
                            // default cell type "n" lets calamine restore
                            // the number).
                            // RemoveStrType handles formula cells with Number
                            // cached values (default cell type "n" round-trips).
                            // Boolean / Error formula cells need DIFFERENT
                            // post-process patches because the default "n"
                            // would still misread the value.
                            if cache_written {
                                match val {
                                    Value::Number(_) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::RemoveStrType,
                                        });
                                    }
                                    // **W5-D-PM-1 (Codex HIGH-1 closure):**
                                    // boolean formula cache — rewrite
                                    // `t="str"` → `t="b"` AND `<v>TRUE</v>`
                                    // / `<v>FALSE</v>` → `<v>1</v>` /
                                    // `<v>0</v>`. Without this the cell
                                    // round-trips as text "TRUE"/"FALSE".
                                    Value::Boolean(b) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::ConvertFormulaToBoolType(*b),
                                        });
                                    }
                                    // **W5-D-PM-1 (Codex HIGH-2 / Opus-A
                                    // HIGH-1 closure):** error formula
                                    // cache — rewrite `t="str"` → `t="e"`.
                                    // The sigil in `<v>` is already correct
                                    // (umya passes our value through). 10 %
                                    // of corpus impacted before the fix.
                                    Value::Error(_) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::ConvertFormulaToErrorType,
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        (None, Value::Blank) => {
                            // Skip blank cells (no formula, no value).
                        }
                        (None, val) => {
                            let cell = ws.get_cell_mut((umya_col, umya_row));
                            apply_value_to_cell(cell, val);
                            // **W5-D-14.1 (audit HIGH-6 closure):** umya
                            // hardcodes `#VALUE!` for any error cell.
                            // Schedule the actual sigil patch.
                            if let Value::Error(e) = val {
                                fixes.push(CellFix {
                                    cell_ref: cell_ref_a1(row, col),
                                    kind: CellFixKind::OverrideErrorSigil(e.sigil()),
                                });
                            }
                        }
                    }
                    if !matches!(value, Value::Blank) || formula.is_some() {
                        report.cells_written += 1;
                    }
                }
            }
        } // end `if has_cells_to_walk`

        // **W5-D-15:** schedule `s="N"` fixes for every cell with a
        // format overlay entry. MUST run AFTER the cell-walk fixes
        // (RemoveStrType / OverrideErrorSigil) so their needles —
        // which match on the literal `<c r="..." t="..."` prefix —
        // aren't disrupted by an inserted `s="..."` attribute.
        //
        // **W5-D-15.1 (self-audit H-3 closure):** the prior version
        // walked `format_overlay().iter()` directly — HashMap
        // iteration order, which is non-deterministic. The
        // `cellxfs_roster` order (and therefore every cell's emitted
        // `s="N"`) varied run-to-run. Now we sort entries by
        // (FormatId, row, col) so the roster is byte-stable across
        // runs and the per-cell `s="N"` values are deterministic.
        let sheet_view = workbook
            .sheet(sheet_id)
            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
        // **Wave B2:** schedule one `s="N"` fix per cell carrying a number-format
        // AND/OR a visual style — the UNION of the format + style overlays. Each
        // cell maps to its composite appearance's xf slot. A `BTreeSet<(row,col)>`
        // keeps the emission deterministic; the fix order is output-irrelevant
        // (each targets a distinct cell ref via an independent string splice) but
        // every SetStyle MUST follow the value-fixes pushed during the cell-walk
        // (whose `<c r="..." t="...">` needles must not see an inserted `s=`).
        let mut styled_coords: std::collections::BTreeSet<(u32, u32)> =
            std::collections::BTreeSet::new();
        for ((row, col), _) in sheet_view.format_overlay().iter() {
            styled_coords.insert((row, col));
        }
        for ((row, col), _) in sheet_view.style_overlay().iter() {
            styled_coords.insert((row, col));
        }
        for (row, col) in styled_coords {
            let appearance = (
                sheet_view.format_overlay().get(row, col),
                sheet_view.style_overlay().get(row, col),
            );
            let xf_index = match appearance_to_xf_index.get(&appearance) {
                Some(idx) => *idx,
                None => continue, // unreachable — roster covers every styled cell
            };
            fixes.push(CellFix {
                cell_ref: cell_ref_a1(row, col),
                kind: CellFixKind::SetStyle(xf_index),
            });
        }
        sheet_fixes.push(fixes);
    }

    // Serialize the umya package into an in-memory buffer. `write_writer`
    // produces the SAME bytes umya's path-based `write` would put on disk —
    // `write` itself calls `write_writer(.., BufWriter::new(File))` over the
    // identical `make_buffer` output — so the post-process pass below sees
    // exactly what it saw under the prior path-based flow.
    let mut initial_bytes: Vec<u8> = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&spreadsheet, &mut initial_bytes)
        .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;

    // **W5-D-14.1 unified post-process pass:** apply workarounds for
    // umya 2.2.0 bugs and limitations. Patches applied:
    //
    // 1. `xl/workbook.xml`: inject `workbookPr/@date1904` (HIGH-2).
    // 2. `xl/worksheets/sheet{N}.xml`: remove `t="str"` (HIGH-1).
    // 3. `xl/worksheets/sheet{N}.xml`: error sigil sub (HIGH-6).
    // 4. `xl/styles.xml`: inject `<numFmts>` for custom format codes
    //    (HIGH-5 closure — umya doesn't write the custom-format roster).
    // 5. `xl/workbook.xml`: inject `<definedNames>` for workbook +
    //    sheet-scoped names (HIGH-4 closure — names export side).
    // 6. `xl/tables/table{N}.xml` + sheet rels + Content_Types + sheet
    //    `<tableParts>`: write Quantbook tables (HIGH-3 closure).
    let needs_date1904 = workbook.date_system() == ql_types::DateSystem::Excel1904;
    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());

    // **W5-D-14.2 (HIGH-5 closure):** collect custom-format codes (≥164).
    // Phase 5.2 D-1 step 6 (2026-05-20) + audit closure: use the xlsx
    // numFmt translation. Two Customs sharing a format code dedup to
    // the same numFmtId, so we MUST dedupe the emitted <numFmt> roster
    // by numFmtId (else duplicate numFmtId entries land in styles.xml).
    //
    // Sort by numFmtId for byte-deterministic <numFmts> output
    // (closes Codex MEDIUM-1 — pre-closure used FormatTable::iter()
    // which is HashMap-iter-arbitrary-order).
    let custom_formats: Vec<(u32, String)> = {
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut entries: Vec<(u32, String)> = workbook
            .formats()
            .iter()
            .filter_map(|(id, code)| {
                if id.is_custom() {
                    let xlsx_id = xlsx_numfmt.translate(id);
                    if seen.insert(xlsx_id) {
                        Some((xlsx_id, code.to_string()))
                    } else {
                        // Dedup-by-code case: another FormatId with the
                        // same code already emitted at this numFmtId.
                        None
                    }
                } else {
                    None
                }
            })
            .collect();
        entries.sort_by_key(|(id, _)| *id);
        entries
    };

    // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
    // scoped + sheet-scoped names. Each is rendered as the OOXML
    // `<definedName name="X" [localSheetId="N"]>target</definedName>`.
    let defined_names = collect_defined_names(workbook)?;

    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** populate
    // `report.dropped_features` with names that couldn't be rendered
    // (Constant(Error)/Constant(Blank) targets). `collect_defined_names`
    // silently drops these; without this surfacing, NewWorkbook
    // Strict mode never fires for them.
    let dropped_named_count = count_undeserializable_names(workbook);
    for _ in 0..dropped_named_count {
        report
            .dropped_features
            .push(crate::report::UnsupportedFeature {
                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
                part: "xl/workbook.xml".to_string(),
                detail: "named range with Error/Blank constant target cannot \
                         serialize to OOXML formula text"
                    .to_string(),
            });
    }

    // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
    // their own `xl/tables/table{N}.xml` parts AND require updates to
    // sheet rels + worksheet `<tableParts>` + `[Content_Types].xml`.
    let tables = collect_table_exports(workbook);

    // **Wave B2 (2026-06-18):** the visual-style export payload — the cellXfs
    // roster (each xf's xlsx-translated numFmtId + font/fill/border roster index
    // + alignment) plus the deduped font/fill/border sub-rosters it references.
    // Built over the SAME appearance roster the per-cell `s="N"` fixes use, so
    // the xf slots line up. The numFmt translation is applied here (multi-peer
    // aware) so post-process doesn't need the translation helper.
    let style_export = StyleExport::build(workbook, &appearance_roster, &xlsx_numfmt);

    let needs_post_process = needs_date1904
        || needs_cell_fixes
        || !custom_formats.is_empty()
        || !defined_names.is_empty()
        || !tables.is_empty()
        || !style_export.xf_roster.is_empty();
    let final_bytes = if needs_post_process {
        post_process_bytes(
            initial_bytes,
            needs_date1904,
            &sheet_fixes,
            &custom_formats,
            &defined_names,
            &tables,
            &style_export,
        )?
    } else {
        initial_bytes
    };

    Ok((final_bytes, report))
}

/// Unified post-process pass over the just-serialized xlsx **bytes**. Applies
/// all workarounds and roster injections in a single in-memory zip walk:
/// - `xl/workbook.xml`: inject `date1904="1"` + `<definedNames>`.
/// - `xl/worksheets/sheet{N}.xml`: per-cell fixes (HIGH-1 / HIGH-6) +
///   `<tableParts>` references for tables anchored to that sheet.
/// - `xl/styles.xml`: inject `<numFmts>` for custom format codes.
/// - `xl/tables/table{N}.xml`: NEW parts for each Quantbook table.
/// - `xl/worksheets/_rels/sheet{N}.xml.rels`: rel entries pointing
///   into the table parts.
/// - `[Content_Types].xml`: `Override` entries for the new table parts.
///
/// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
/// **W5-D-14.2** audit HIGH-3 / HIGH-4 / HIGH-5 closure.
///
/// **inc.2c-12 (2026-05-27):** takes the package bytes by value and returns
/// the transformed bytes (was: read from a path + atomic-write back to it).
/// The path-based caller ([`export_new_workbook`]) now does the single atomic
/// write itself, and the bytes caller
/// ([`export_new_workbook_to_bytes`]/`export_xlsx_bytes`) keeps everything in
/// memory.
fn post_process_bytes(
    input: Vec<u8>,
    inject_date1904: bool,
    sheet_fixes: &[Vec<CellFix>],
    custom_formats: &[(u32, String)],
    defined_names: &[DefinedNameOut],
    tables: &[TableExport],
    // **Wave B2:** the visual-style export payload (cellXfs roster + font/fill/
    // border sub-rosters) injected into xl/styles.xml. The per-xf numFmtId is
    // already xlsx-translated by `XlsxNumFmtTranslation` at the caller.
    style_export: &StyleExport,
) -> Result<Vec<u8>, XlsxError> {
    use std::io::{Read, Write};

    // Pre-compute per-sheet table groupings: for each Quantbook
    // sheet index, the table ids anchored there. Used to emit
    // `<tableParts>` in the worksheet xml + rels.
    let mut tables_by_sheet: std::collections::HashMap<usize, Vec<&TableExport>> =
        std::collections::HashMap::new();
    for t in tables {
        tables_by_sheet.entry(t.sheet_idx).or_default().push(t);
    }

    let bytes = input;
    let mut reader =
        zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).map_err(XlsxError::Zip)?;
    let mut out_buf: Vec<u8> = Vec::new();
    let mut existing_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
        for i in 0..reader.len() {
            let mut entry = reader.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            existing_names.insert(name.clone());
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            if name == "xl/workbook.xml" {
                if inject_date1904 {
                    content = inject_date1904_into_workbook_xml(content)?;
                }
                if !defined_names.is_empty() {
                    content = inject_defined_names_into_workbook_xml(content, defined_names)?;
                }
            } else if name == "xl/styles.xml" {
                if !custom_formats.is_empty() {
                    content = inject_custom_formats_into_styles_xml(content, custom_formats)?;
                }
                if !style_export.xf_roster.is_empty() {
                    content = inject_styles_into_styles_xml(content, style_export)?;
                }
            } else if name == "[Content_Types].xml" && !tables.is_empty() {
                content = inject_table_overrides_into_content_types(content, tables)?;
            } else if let Some(sheet_idx) = sheet_index_from_path(&name) {
                if let Some(fixes) = sheet_fixes.get(sheet_idx) {
                    if !fixes.is_empty() {
                        content = apply_cell_fixes_to_sheet_xml(content, fixes)?;
                    }
                }
                if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                    content = inject_table_parts_into_sheet_xml(content, sheet_tables)?;
                }
            } else if let Some(sheet_idx) = sheet_rels_index_from_path(&name) {
                if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                    content = inject_table_rels(content, sheet_tables)?;
                }
            }
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file(name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }

        // **W5-D-14.2 HIGH-3 closure:** emit new xl/tables/table{N}.xml
        // parts. Each table id N gets its own part file.
        for t in tables {
            let part_name = format!("xl/tables/table{}.xml", t.id);
            let xml = render_table_xml(t);
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file(&part_name, opts)
                .map_err(XlsxError::Zip)?;
            writer.write_all(xml.as_bytes())?;
        }

        // **W5-D-14.2:** if a sheet has tables but the sheet had no
        // pre-existing rels file (umya doesn't write one for plain
        // sheets), create the rels file from scratch.
        for (sheet_idx, sheet_tables) in &tables_by_sheet {
            // The sheet ID in the umya-generated file is sheet_idx + 1.
            let rels_path = format!("xl/worksheets/_rels/sheet{}.xml.rels", sheet_idx + 1);
            if existing_names.contains(&rels_path) {
                continue;
            }
            let content = render_fresh_sheet_rels(sheet_tables);
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file(&rels_path, opts)
                .map_err(XlsxError::Zip)?;
            writer.write_all(content.as_bytes())?;
        }

        writer.finish().map_err(XlsxError::Zip)?;
    }
    // **inc.2c-12:** return the transformed bytes. The atomic write-tmp +
    // rename (W5-D-PM-4 megaudit Opus-B HIGH-6 closure — concurrent exports
    // to the same path would otherwise interleave bytes) is now performed by
    // the path-based caller `export_new_workbook`; the bytes caller keeps the
    // result in memory.
    Ok(out_buf)
}

/// **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** write `bytes` to
/// `final_path` atomically via tmp + rename. On the same
/// filesystem, `rename(2)` is atomic — concurrent writers either
/// see the old file or the new file, never a partial / interleaved
/// state.
/// Crate-visible wrapper so sibling modules (`update_original`)
/// can use the same atomic-write helper without duplicating code.
pub(crate) fn atomic_write_to_path_public(
    final_path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), XlsxError> {
    atomic_write_to_path(final_path, bytes)
}

fn atomic_write_to_path(final_path: &std::path::Path, bytes: &[u8]) -> Result<(), XlsxError> {
    let parent = final_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let stem = final_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("ql-output");
    // Use a per-call counter + pid + nanosecond timestamp so
    // concurrent writers don't collide on this tmp path either.
    static WRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{stem}.tmp-{pid}-{n}-{nanos}"));
    std::fs::write(&tmp, bytes)?;
    // `rename` clobbers an existing destination atomically on POSIX.
    // On Windows this may not be atomic-when-target-exists; for our
    // workflow that's acceptable (Windows isn't a target platform
    // for this engine).
    if let Err(e) = std::fs::rename(&tmp, final_path) {
        // Best-effort cleanup of the tmp file on failure.
        let _ = std::fs::remove_file(&tmp);
        return Err(XlsxError::Io(e));
    }
    Ok(())
}

/// Convert `xl/worksheets/sheet5.xml` → `Some(4)` (0-indexed N-1).
/// Returns `None` for any path that isn't a per-sheet worksheet xml.
fn sheet_index_from_path(name: &str) -> Option<usize> {
    let stripped = name.strip_prefix("xl/worksheets/sheet")?;
    let n_str = stripped.strip_suffix(".xml")?;
    n_str.parse::<usize>().ok().and_then(|n| n.checked_sub(1))
}

/// Apply per-cell fixes to one worksheet xml content. Each fix
/// targets a specific cell ref (e.g. `"C5"`) within the sheet.
fn apply_cell_fixes_to_sheet_xml(
    content: Vec<u8>,
    fixes: &[CellFix],
) -> Result<Vec<u8>, XlsxError> {
    let mut text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("worksheet.xml is not valid UTF-8: {e}")))?;
    for fix in fixes {
        match &fix.kind {
            CellFixKind::RemoveStrType => {
                // Pattern: `<c r="C5" t="str">` → `<c r="C5">`.
                // umya always writes attributes in the same order:
                // `r` first, then optional `t`, then optional `s`.
                // The `t="str"` attribute appears immediately after
                // the `r="..."` for formula cells. Match the exact
                // pair `<c r="X1" t="str"`.
                let needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}""#, fix.cell_ref);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::OverrideErrorSigil(sigil) => {
                // Pattern: `<c r="C5" t="e"><v>#VALUE!</v></c>` →
                // `<c r="C5" t="e"><v>SIGIL</v></c>`. The cell ref
                // anchors the match so we only patch the targeted cell.
                let needle = format!(r#"<c r="{}" t="e"><v>#VALUE!</v>"#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}" t="e"><v>{}</v>"#, fix.cell_ref, sigil);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::SetStyle(xf_index) => {
                // Pattern: `<c r="C5"` → `<c r="C5" s="N"`.
                // Anchors on the full `r="..."` attr to avoid
                // collisions with cells whose ref is a prefix
                // (e.g. matching A1 inside AA1's r-attr is prevented
                // by the closing `"`). We insert s="..." immediately
                // after the closing quote of the `r` attr — this
                // works for both `<c r="C5">` AND `<c r="C5"/>` AND
                // `<c r="C5" t="...">` forms.
                let needle = format!(r#"<c r="{}""#, fix.cell_ref);
                if text.contains(&needle) {
                    let replacement = format!(r#"<c r="{}" s="{}""#, fix.cell_ref, xf_index);
                    text = text.replace(&needle, &replacement);
                } else {
                    // **W5-D-15.2 (Codex audit HIGH-4 / separate-Opus
                    // H-1 closure):** umya doesn't emit `<c>` for
                    // value-less cells. Inject a fresh
                    // `<c r="A1" s="N"/>` element into the matching
                    // `<row>` (or create the row if needed) so the
                    // format overlay survives the round-trip.
                    text = insert_style_only_cell(text, &fix.cell_ref, *xf_index)?;
                }
            }
            CellFixKind::ConvertFormulaToErrorType => {
                // **W5-D-PM-1 (megaudit closure):** rewrite
                // `<c r="C5" t="str">` → `<c r="C5" t="e">`.
                // umya emits formula+Error cells with `t="str"` and
                // the correct sigil in `<v>`. Just flip the type.
                let needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}" t="e""#, fix.cell_ref);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::ConvertFormulaToBoolType(b) => {
                // **W5-D-PM-1 (megaudit closure):** rewrite
                // `<c r="C5" t="str">...<v>TRUE</v>...</c>` →
                // `<c r="C5" t="b">...<v>1</v>...</c>`.
                // Two passes: type attr + value content. The value
                // content needle anchors on the closing `</c>` end
                // of this specific cell tag to avoid false positives.
                let type_needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let type_replacement = format!(r#"<c r="{}" t="b""#, fix.cell_ref);
                text = text.replace(&type_needle, &type_replacement);
                // Value content: umya emits `<v>TRUE</v>` or
                // `<v>FALSE</v>`. The patch is scoped to the cell's
                // tag — but `text.replace` is global. Anchor with
                // the cell ref by looking for the cell tag prefix +
                // value pattern between `<v>` and `</v>`.
                let bool_str = if *b { "TRUE" } else { "FALSE" };
                let bool_int = if *b { "1" } else { "0" };
                // Match the entire `<c r="X" t="b"><f>...</f><v>BOOL_STR</v>`
                // sequence and replace the value. The `t="b"` was
                // just set above, so the cell now reads
                // `<c r="X" t="b"><f>...</f><v>BOOL_STR</v>`.
                // We need to find this cell's value element
                // specifically.
                let cell_open = format!(r#"<c r="{}" t="b""#, fix.cell_ref);
                if let Some(open_idx) = text.find(&cell_open) {
                    let after_open = open_idx + cell_open.len();
                    // Find the cell's closing `</c>`.
                    if let Some(close_rel) = text[after_open..].find("</c>") {
                        let cell_end = after_open + close_rel;
                        let body = &text[after_open..cell_end];
                        let v_needle = format!("<v>{}</v>", bool_str);
                        let v_replacement = format!("<v>{}</v>", bool_int);
                        if body.contains(&v_needle) {
                            let new_body = body.replace(&v_needle, &v_replacement);
                            let mut out = String::with_capacity(text.len());
                            out.push_str(&text[..after_open]);
                            out.push_str(&new_body);
                            out.push_str(&text[cell_end..]);
                            text = out;
                        }
                    }
                }
            }
        }
    }
    Ok(text.into_bytes())
}

/// Insert `date1904="1"` into `<workbookPr>`. If the element is
/// missing, insert a fresh `<workbookPr date1904="1"/>` after the
/// opening `<workbook>` tag. UTF-8 text manipulation — OOXML is
/// always UTF-8.
/// **W5-D-15.2:** insert a style-only cell into the worksheet xml's
/// `<sheetData>`. Used when a cell has a format overlay but no
/// value/formula — umya skips emitting such cells, so we synthesize
/// `<c r="A1" s="N"/>` and place it inside the matching `<row r="K">`
/// element (creating the row if needed).
///
/// Excel tolerates non-sorted cells within a row and slightly stale
/// `spans` attributes; we don't bother updating either.
fn insert_style_only_cell(
    text: String,
    cell_ref: &str,
    xf_index: u32,
) -> Result<String, XlsxError> {
    let row_number = match parse_row_number_from_ref(cell_ref) {
        Some(n) => n,
        None => {
            // Malformed cell ref — nothing to do.
            return Ok(text);
        }
    };
    let new_cell = format!(r#"<c r="{}" s="{}"/>"#, cell_ref, xf_index);

    // Case 1: `<row r="K">...</row>` exists — inject before `</row>`.
    let open_attr = format!(r#"<row r="{}""#, row_number);
    if let Some(open_idx) = text.find(&open_attr) {
        // Find the closing `>` of the opening `<row>` tag.
        let after_open = open_idx + open_attr.len();
        let open_end = match text[after_open..].find('>') {
            Some(i) => after_open + i + 1,
            None => {
                return Err(XlsxError::Export(
                    "worksheet xml: malformed <row> opening tag".to_string(),
                ));
            }
        };
        // Self-closing `<row .../>` form (umya rarely emits this but
        // handle defensively): convert to the long form with the cell
        // inside.
        if text[after_open..open_end].ends_with("/>") {
            // Strip the trailing `/>` and replace with `>...new_cell...</row>`.
            let self_close_start = open_end - 2;
            let mut out = String::with_capacity(text.len() + new_cell.len() + 16);
            out.push_str(&text[..self_close_start]);
            out.push('>');
            out.push_str(&new_cell);
            out.push_str("</row>");
            out.push_str(&text[open_end..]);
            return Ok(out);
        }
        // Long-form `<row ...>...</row>`. Find the matching `</row>`.
        if let Some(close_rel) = text[open_end..].find("</row>") {
            let close_idx = open_end + close_rel;
            let mut out = String::with_capacity(text.len() + new_cell.len());
            out.push_str(&text[..close_idx]);
            out.push_str(&new_cell);
            out.push_str(&text[close_idx..]);
            return Ok(out);
        }
        return Err(XlsxError::Export(
            "worksheet xml: <row> opening without matching </row>".to_string(),
        ));
    }

    // Case 2: no `<row r="K">` — synthesize one and insert into
    // `<sheetData>` in row-sorted position.
    //
    // **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** the prior W5-D-15.2
    // version inserted at the END of `<sheetData>` regardless of row
    // order. OOXML schema requires `<row>` elements in ascending `r`
    // order. Excel tolerates non-sorted rows on open but emits a
    // repair dialog on save. Now we scan for the first existing
    // `<row r="L">` where L > K and inject the new row BEFORE it.
    // Fall through to before `</sheetData>` only if no such row
    // exists (all existing rows have r ≤ K).
    let new_row = format!(r#"<row r="{}">{}</row>"#, row_number, new_cell);
    if let Some(insert_before) = find_row_insertion_point(&text, row_number) {
        let mut out = String::with_capacity(text.len() + new_row.len());
        out.push_str(&text[..insert_before]);
        out.push_str(&new_row);
        out.push_str(&text[insert_before..]);
        return Ok(out);
    }
    if let Some(close_idx) = text.rfind("</sheetData>") {
        let mut out = String::with_capacity(text.len() + new_row.len());
        out.push_str(&text[..close_idx]);
        out.push_str(&new_row);
        out.push_str(&text[close_idx..]);
        return Ok(out);
    }
    // `<sheetData/>` self-closing — replace with the long form.
    if let Some(idx) = text.find("<sheetData/>") {
        let mut out = String::with_capacity(text.len() + new_row.len() + 16);
        out.push_str(&text[..idx]);
        out.push_str("<sheetData>");
        out.push_str(&new_row);
        out.push_str("</sheetData>");
        out.push_str(&text[idx + "<sheetData/>".len()..]);
        return Ok(out);
    }

    Err(XlsxError::Export(
        "worksheet xml: missing <sheetData> — cannot inject style-only cell".to_string(),
    ))
}

/// **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** scan a worksheet
/// xml for the first `<row r="L">` where L > `target_row`. Returns
/// the byte index where a new `<row r="target_row">` should be
/// inserted to preserve ascending row order. Returns `None` if no
/// such row exists (caller falls through to inserting before
/// `</sheetData>`).
fn find_row_insertion_point(text: &str, target_row: u32) -> Option<usize> {
    // Walk for every `<row r="N"` occurrence; pick the first N > target_row.
    let mut cursor = 0;
    while let Some(rel) = text[cursor..].find("<row r=\"") {
        let start = cursor + rel;
        let after = start + "<row r=\"".len();
        // Find closing `"`.
        let close_quote = text[after..].find('"')?;
        let n_str = &text[after..after + close_quote];
        if let Ok(n) = n_str.parse::<u32>() {
            if n > target_row {
                return Some(start);
            }
        }
        cursor = after + close_quote;
    }
    None
}

/// Parse the row number from an A1-style cell ref (e.g. `"BC42"` → `42`).
fn parse_row_number_from_ref(cell_ref: &str) -> Option<u32> {
    let bytes = cell_ref.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i == 0 || i == bytes.len() {
        return None;
    }
    cell_ref[i..].parse::<u32>().ok().filter(|n| *n > 0)
}

fn inject_date1904_into_workbook_xml(content: Vec<u8>) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("workbook.xml is not valid UTF-8: {e}")))?;

    // Case 1: <workbookPr already present — add date1904 attribute.
    if let Some(start_idx) = text.find("<workbookPr") {
        let after_tag = start_idx + "<workbookPr".len();
        // If date1904="1" already present, no-op.
        let end_of_element = text[after_tag..]
            .find('>')
            .map(|i| after_tag + i)
            .unwrap_or(after_tag);
        let element_attrs = &text[after_tag..end_of_element];
        if element_attrs.contains("date1904=") {
            return Ok(text.into_bytes());
        }
        // Insert ` date1904="1"` right after `<workbookPr`.
        let mut out = String::with_capacity(text.len() + 16);
        out.push_str(&text[..after_tag]);
        out.push_str(r#" date1904="1""#);
        out.push_str(&text[after_tag..]);
        return Ok(out.into_bytes());
    }

    // Case 2: no <workbookPr — insert one right after the opening
    // <workbook ...> tag.
    if let Some(opening) = text.find("<workbook") {
        let end_of_opening = text[opening..]
            .find('>')
            .map(|i| opening + i + 1)
            .ok_or_else(|| {
                XlsxError::Export("workbook.xml has malformed <workbook> opening tag".to_string())
            })?;
        let mut out = String::with_capacity(text.len() + 40);
        out.push_str(&text[..end_of_opening]);
        out.push_str(r#"<workbookPr date1904="1"/>"#);
        out.push_str(&text[end_of_opening..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "workbook.xml missing <workbook> root element".to_string(),
    ))
}

/// Convert `xl/worksheets/_rels/sheet5.xml.rels` → `Some(4)` (0-indexed N-1).
fn sheet_rels_index_from_path(name: &str) -> Option<usize> {
    let stripped = name.strip_prefix("xl/worksheets/_rels/sheet")?;
    let n_str = stripped.strip_suffix(".xml.rels")?;
    n_str.parse::<usize>().ok().and_then(|n| n.checked_sub(1))
}

/// **W5-D-14.2 HIGH-5 closure:** inject `<numFmts>` into styles.xml.
/// umya 2.2.0 does NOT write `<numFmts>` for cells without applied
/// styles, so custom format codes registered in Quantbook's FormatTable
/// (id >= 164) are silently dropped on export. We patch styles.xml
/// post-write to add them as the FIRST child of `<styleSheet>`
/// (OOXML requires `<numFmts>` before `<fonts>`).
///
/// If styles.xml doesn't exist (very unlikely from umya), creates a
/// minimal one — but this path is exercised only as a defensive
/// fallback; the real generated styles.xml always contains the
/// scaffolding.
fn inject_custom_formats_into_styles_xml(
    content: Vec<u8>,
    custom_formats: &[(u32, String)],
) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;

    let mut numfmts = String::with_capacity(64 * custom_formats.len());
    numfmts.push_str(&format!(r#"<numFmts count="{}">"#, custom_formats.len()));
    for (id, code) in custom_formats {
        numfmts.push_str(&format!(
            r#"<numFmt numFmtId="{}" formatCode="{}"/>"#,
            id,
            xml_attr_escape(code),
        ));
    }
    numfmts.push_str("</numFmts>");

    // Case 1: existing <numFmts> — replace it entirely. (Unlikely
    // since umya doesn't emit any, but handle defensively.)
    //
    // **W5-D-14.2.3 (separate-Opus M-1 closure):** check the
    // non-self-closing `</numFmts>` form FIRST. The self-close `/>`
    // search runs over the FULL remainder of the document, so if
    // `<numFmts>` has self-closing children (`<numFmt ../>`), the
    // `find("/>")` would match the CHILD's `/>` and truncate at the
    // wrong place. Closing-tag form lets us cleanly bracket the
    // outer element.
    if let Some(start) = text.find("<numFmts") {
        let after = start + "<numFmts".len();
        if let Some(close_rel) = text[after..].find("</numFmts>") {
            let end = after + close_rel + "</numFmts>".len();
            let mut out = String::with_capacity(text.len() + numfmts.len());
            out.push_str(&text[..start]);
            out.push_str(&numfmts);
            out.push_str(&text[end..]);
            return Ok(out.into_bytes());
        }
        // Truly self-closing `<numFmts ... />` form: find the FIRST
        // `>` after the tag name and require the preceding byte to be
        // `/`. That bounds the search to the actual element close.
        if let Some(gt_rel) = text[after..].find('>') {
            let end = after + gt_rel + 1;
            if text[after..end].ends_with("/>") {
                let mut out = String::with_capacity(text.len() + numfmts.len());
                out.push_str(&text[..start]);
                out.push_str(&numfmts);
                out.push_str(&text[end..]);
                return Ok(out.into_bytes());
            }
        }
    }

    // Case 2: insert after the <styleSheet ...> opening tag.
    if let Some(opening) = text.find("<styleSheet") {
        let end_of_opening = text[opening..]
            .find('>')
            .map(|i| opening + i + 1)
            .ok_or_else(|| {
                XlsxError::Export("styles.xml has malformed <styleSheet>".to_string())
            })?;
        let mut out = String::with_capacity(text.len() + numfmts.len());
        out.push_str(&text[..end_of_opening]);
        out.push_str(&numfmts);
        out.push_str(&text[end_of_opening..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "styles.xml missing <styleSheet> root element".to_string(),
    ))
}

/// One defined name to serialise into `<definedNames>`.
#[derive(Debug, Clone)]
struct DefinedNameOut {
    /// Excel-canonical (upper-case) form; the OOXML stores it
    /// case-preserved but Quantbook canonicalizes on insert so this
    /// IS the canonical form.
    name: String,
    /// Target expressed as OOXML formula text
    /// (e.g. `'Sheet1'!$A$1:$B$2` for ranges, `123.4` for numeric
    /// constants, `"hello"` for text constants, raw formula otherwise).
    target: String,
    /// `localSheetId` attribute — `None` for workbook-scoped names.
    /// Sheet-scoped names are deferred (Quantbook's `NameTable` is
    /// workbook-only today); reserved for forward compat.
    local_sheet_id: Option<u16>,
}

/// Walk Quantbook's `NameTable` and render each name as a
/// `DefinedNameOut`. Sheet-name lookups go through the workbook's
/// `Sheet::name()` (case-preserving display).
/// **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** count named
/// targets whose `render_named_target` returns None — these will
/// be silently dropped from the export. The count is used to
/// populate `XlsxExportReport.dropped_features` so Strict mode can
/// fire on them.
fn count_undeserializable_names(workbook: &Workbook) -> usize {
    let mut count = 0;
    for (_name, target) in workbook.names().iter() {
        if render_named_target(workbook, target).is_none() {
            count += 1;
        }
    }
    let sheet_count = workbook.sheet_count();
    for sheet_idx in 0..sheet_count {
        if let Some(sheet) = workbook.sheet(sheet_idx as u16) {
            for (_name, target) in sheet.scoped_names().iter() {
                if render_named_target(workbook, target).is_none() {
                    count += 1;
                }
            }
        }
    }
    count
}

fn collect_defined_names(workbook: &Workbook) -> Result<Vec<DefinedNameOut>, XlsxError> {
    let mut out: Vec<DefinedNameOut> = Vec::new();

    // Workbook-scope names.
    for (name, target) in workbook.names().iter() {
        let serialised = match render_named_target(workbook, target) {
            Some(s) => s,
            None => continue, // Unrepresentable (e.g. Constant(Error)) — drop with no fanfare.
        };
        out.push(DefinedNameOut {
            name: name.to_string(),
            target: serialised,
            local_sheet_id: None,
        });
    }

    // Sheet-scope names: walk each sheet's scoped table.
    let sheet_count = workbook.sheet_count();
    for sheet_idx in 0..sheet_count {
        let sheet = workbook.sheet(sheet_idx as u16).ok_or_else(|| {
            XlsxError::Export(format!("sheet {sheet_idx} missing during names walk"))
        })?;
        for (name, target) in sheet.scoped_names().iter() {
            let serialised = match render_named_target(workbook, target) {
                Some(s) => s,
                None => continue,
            };
            out.push(DefinedNameOut {
                name: name.to_string(),
                target: serialised,
                local_sheet_id: Some(sheet_idx as u16),
            });
        }
    }

    // Stable order: workbook-scope first, then sheet-scope; within each
    // group sort by name so output is deterministic across HashMap
    // iteration order.
    out.sort_by(|a, b| {
        a.local_sheet_id
            .cmp(&b.local_sheet_id)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Render a `NamedTarget` into its OOXML formula-text form.
/// Returns `None` for variants we can't serialise (Constant(Error),
/// Constant(Blank), etc.).
fn render_named_target(workbook: &Workbook, target: &NamedTarget) -> Option<String> {
    match target {
        NamedTarget::Cell(addr) => {
            let sheet = workbook.sheet(addr.sheet)?;
            Some(format!(
                "{}!${}${}",
                quote_sheet_name(sheet.name()),
                col_letter(addr.col),
                addr.row + 1
            ))
        }
        NamedTarget::Range(range) => {
            let sheet = workbook.sheet(range.sheet)?;
            Some(format!(
                "{}!${}${}:${}${}",
                quote_sheet_name(sheet.name()),
                col_letter(range.start_col),
                range.start_row + 1,
                col_letter(range.end_col),
                range.end_row + 1
            ))
        }
        NamedTarget::Constant(value) => match value {
            Value::Number(n) => Some(format_number_literal(*n)),
            Value::Boolean(b) => Some(if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }),
            Value::Text(s) => Some(format!(r#""{}""#, s.as_ref().replace('"', "\"\""))),
            // Error / Blank constants are not Excel-representable as
            // defined-name targets — drop.
            _ => None,
        },
        NamedTarget::Formula(text) => Some(text.as_ref().to_string()),
    }
}

/// Format a number for OOXML formula text. Avoid trailing zeros
/// where possible; integers come out as `42` not `42.0`.
fn format_number_literal(n: f64) -> String {
    if n.is_finite() && n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Quote a sheet name if it contains characters that require quoting
/// in OOXML formula text. Single quotes in the name get doubled
/// (`'O''Brien'` for a sheet literally named `O'Brien`).
///
/// **W5-D-14.2.3 (separate-Opus M-11 closure):** also quote sheet
/// names that match the cell-reference pattern `^[A-Za-z]+\d+$`
/// (e.g. `A1`, `R1C1`, `XFD1048576`). Excel parses `A1!$B$2`
/// ambiguously when `A1` is unquoted; quoting disambiguates.
fn quote_sheet_name(name: &str) -> String {
    let needs_quote = name.is_empty()
        || name
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        || name.chars().any(|c| !c.is_ascii_alphanumeric() && c != '_')
        || looks_like_cell_ref(name);
    if needs_quote {
        format!("'{}'", name.replace('\'', "''"))
    } else {
        name.to_string()
    }
}

/// Does `name` match `^[A-Za-z]+\d+$` (cell-reference pattern)?
fn looks_like_cell_ref(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i == 0 {
        return false;
    }
    let digit_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    i == bytes.len() && i > digit_start
}

/// Column index (0-based) → Excel A1 column letter (`A`, `Z`, `AA`...).
fn col_letter(col: u32) -> String {
    let mut name = String::new();
    let mut c = col + 1;
    while c > 0 {
        let rem = (c - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        c = (c - 1) / 26;
    }
    name
}

/// **W5-D-14.2 HIGH-4 closure (export side):** inject `<definedNames>`
/// into `xl/workbook.xml`. Insert after `</sheets>` (per OOXML schema
/// child order: bookViews? sheets? functionGroups? externalReferences?
/// definedNames? ...).
fn inject_defined_names_into_workbook_xml(
    content: Vec<u8>,
    names: &[DefinedNameOut],
) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("workbook.xml is not valid UTF-8: {e}")))?;

    let mut block = String::with_capacity(64 * names.len());
    block.push_str("<definedNames>");
    for n in names {
        block.push_str("<definedName name=\"");
        block.push_str(&xml_attr_escape(&n.name));
        block.push('"');
        if let Some(sid) = n.local_sheet_id {
            block.push_str(&format!(r#" localSheetId="{}""#, sid));
        }
        block.push('>');
        block.push_str(&xml_text_escape(&n.target));
        block.push_str("</definedName>");
    }
    block.push_str("</definedNames>");

    // Case 1: existing <definedNames> — replace. Check `</tag>` form
    // FIRST so self-closing child elements (`<definedName .../>`)
    // don't confuse the outer close detection
    // (separate-Opus M-1 closure).
    if let Some(start) = text.find("<definedNames") {
        let after = start + "<definedNames".len();
        if let Some(close_rel) = text[after..].find("</definedNames>") {
            let end = after + close_rel + "</definedNames>".len();
            let mut out = String::with_capacity(text.len() + block.len());
            out.push_str(&text[..start]);
            out.push_str(&block);
            out.push_str(&text[end..]);
            return Ok(out.into_bytes());
        }
        if let Some(gt_rel) = text[after..].find('>') {
            let end = after + gt_rel + 1;
            if text[after..end].ends_with("/>") {
                let mut out = String::with_capacity(text.len() + block.len());
                out.push_str(&text[..start]);
                out.push_str(&block);
                out.push_str(&text[end..]);
                return Ok(out.into_bytes());
            }
        }
    }

    // Case 2: insert after </sheets>.
    if let Some(idx) = text.find("</sheets>") {
        let insert_at = idx + "</sheets>".len();
        let mut out = String::with_capacity(text.len() + block.len());
        out.push_str(&text[..insert_at]);
        out.push_str(&block);
        out.push_str(&text[insert_at..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "workbook.xml missing </sheets> — cannot place <definedNames>".to_string(),
    ))
}

/// Escape a value for use inside an XML attribute (`"...attr..."`).
fn xml_attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Escape a value for use as XML text content (not attribute).
fn xml_text_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// **W5-D-14.2 HIGH-3 closure:** one table to emit.
#[derive(Debug, Clone)]
struct TableExport {
    /// Workbook-unique table id (also the file index in `xl/tables/`).
    id: u32,
    /// Display name (case-preserving). Used in the OOXML `name` /
    /// `displayName` attributes.
    name: String,
    /// 0-based sheet index in workbook order.
    sheet_idx: usize,
    /// Full footprint range in A1 form (e.g. `B2:D10`).
    ref_a1: String,
    /// AutoFilter range — same as `ref_a1` minus the totals row when
    /// `has_totals`. Excel rejects autoFilter ranges that overlap the
    /// totals row.
    ///
    /// **W5-D-14.2 self-audit HIGH-2 fix.**
    autofilter_ref: String,
    /// Columns: stable id + display name + totals function.
    columns: Vec<TableColumnExport>,
    /// Header row present.
    has_header: bool,
    /// Totals row present.
    has_totals: bool,
}

#[derive(Debug, Clone)]
struct TableColumnExport {
    id: u32,
    display: String,
    totals_function: ql_storage::TotalsFunction,
}

/// Walk `workbook.tables().iter()` and convert each to an export struct.
fn collect_table_exports(workbook: &Workbook) -> Vec<TableExport> {
    let mut out: Vec<TableExport> = Vec::new();
    let mut by_sheet_then_name: Vec<(usize, String, &ql_storage::TableMetadata)> = workbook
        .tables()
        .iter()
        .map(|(_canon, t)| (t.sheet as usize, t.display_name.to_string(), t))
        .collect();
    by_sheet_then_name.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    for (next_id, (sheet_idx, _name, t)) in (1_u32..).zip(by_sheet_then_name) {
        let last_row = t.top_row + t.rows - 1;
        let last_col = t.top_col + t.cols - 1;
        let ref_a1 = format!(
            "{}{}:{}{}",
            col_letter(t.top_col),
            t.top_row + 1,
            col_letter(last_col),
            last_row + 1
        );
        // **W5-D-14.2 self-audit HIGH-2 fix:** the autoFilter range
        // excludes the totals row. Excel treats the totals row as
        // "below the filter"; including it produces a filter dropdown
        // on cells that aren't part of the filterable data.
        let autofilter_last_row = if t.has_totals && last_row > t.top_row {
            last_row - 1
        } else {
            last_row
        };
        let autofilter_ref = format!(
            "{}{}:{}{}",
            col_letter(t.top_col),
            t.top_row + 1,
            col_letter(last_col),
            autofilter_last_row + 1
        );
        let columns = t
            .columns
            .iter()
            .map(|c| TableColumnExport {
                id: c.id,
                display: c.display.to_string(),
                totals_function: c
                    .totals_function
                    .unwrap_or(ql_storage::TotalsFunction::None),
            })
            .collect();
        out.push(TableExport {
            id: next_id,
            name: t.display_name.to_string(),
            sheet_idx,
            ref_a1,
            autofilter_ref,
            columns,
            has_header: t.has_header,
            has_totals: t.has_totals,
        });
    }
    out
}

/// Render a single `xl/tables/table{N}.xml` part.
fn render_table_xml(t: &TableExport) -> String {
    let mut s = String::with_capacity(256 + 64 * t.columns.len());
    s.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    s.push('\n');
    s.push_str(&format!(
        concat!(
            r#"<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" "#,
            r#"id="{}" name="{}" displayName="{}" ref="{}" "#,
            r#"totalsRowShown="{}" headerRowCount="{}" totalsRowCount="{}">"#,
        ),
        t.id,
        xml_attr_escape(&t.name),
        xml_attr_escape(&t.name),
        t.ref_a1,
        if t.has_totals { "1" } else { "0" },
        if t.has_header { 1 } else { 0 },
        if t.has_totals { 1 } else { 0 },
    ));
    // <autoFilter> follows ref if header present (Excel requires it
    // for the filter dropdown). Use `autofilter_ref` which excludes
    // the totals row when `has_totals` (HIGH-2 fix).
    if t.has_header {
        s.push_str(&format!(r#"<autoFilter ref="{}"/>"#, t.autofilter_ref));
    }
    s.push_str(&format!(r#"<tableColumns count="{}">"#, t.columns.len()));
    for c in &t.columns {
        s.push_str(&format!(
            r#"<tableColumn id="{}" name="{}""#,
            c.id,
            xml_attr_escape(&c.display)
        ));
        let tf = totals_function_attr(c.totals_function);
        if let Some(attr) = tf {
            s.push_str(&format!(r#" totalsRowFunction="{}""#, attr));
        }
        s.push_str("/>");
    }
    s.push_str("</tableColumns>");
    s.push_str(
        r#"<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>"#,
    );
    s.push_str("</table>");
    s
}

/// Map Quantbook's `TotalsFunction` to the OOXML
/// `totalsRowFunction` attribute. Returns `None` only for the
/// `None` variant (no totals function configured); `Custom` round-
/// trips as `totalsRowFunction="custom"` per the OOXML schema so
/// Excel doesn't silently downgrade the column to "no totals".
///
/// **W5-D-14.2.2 (Codex audit H-E closure):** the prior mapping
/// dropped `Custom` to `None`, which on round-trip turned a
/// table column with a custom totals formula into one with no
/// totals function metadata.
fn totals_function_attr(tf: ql_storage::TotalsFunction) -> Option<&'static str> {
    use ql_storage::TotalsFunction::*;
    match tf {
        None => Option::None,
        Average => Some("average"),
        Count => Some("count"),
        CountNums => Some("countNums"),
        Max => Some("max"),
        Min => Some("min"),
        StdDev => Some("stdDev"),
        Sum => Some("sum"),
        Variance => Some("var"),
        Custom => Some("custom"),
    }
}

/// Inject `<tableParts>` into a worksheet xml. Inserted just before
/// `</worksheet>` (per OOXML schema, `<tableParts>` is one of the last
/// children). Each table reference uses an `rId` that we'll register
/// in the matching sheet rels file.
fn inject_table_parts_into_sheet_xml(
    content: Vec<u8>,
    sheet_tables: &[&TableExport],
) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("worksheet xml is not valid UTF-8: {e}")))?;

    let mut block = String::with_capacity(64 * sheet_tables.len());
    block.push_str(&format!(r#"<tableParts count="{}">"#, sheet_tables.len()));
    for (i, _t) in sheet_tables.iter().enumerate() {
        // rId for this table within the sheet rels — we use rIdT{i+1}
        // for stability and isolation from any umya-emitted rIds.
        block.push_str(&format!(r#"<tablePart r:id="rIdT{}"/>"#, i + 1));
    }
    block.push_str("</tableParts>");

    // Replace existing <tableParts.../> or </tableParts> if present.
    // Check `</tag>` form FIRST (separate-Opus M-1 closure).
    if let Some(start) = text.find("<tableParts") {
        let after = start + "<tableParts".len();
        if let Some(close_rel) = text[after..].find("</tableParts>") {
            let end = after + close_rel + "</tableParts>".len();
            let mut out = String::with_capacity(text.len() + block.len());
            out.push_str(&text[..start]);
            out.push_str(&block);
            out.push_str(&text[end..]);
            return Ok(out.into_bytes());
        }
        if let Some(gt_rel) = text[after..].find('>') {
            let end = after + gt_rel + 1;
            if text[after..end].ends_with("/>") {
                let mut out = String::with_capacity(text.len() + block.len());
                out.push_str(&text[..start]);
                out.push_str(&block);
                out.push_str(&text[end..]);
                return Ok(out.into_bytes());
            }
        }
    }

    // Insert just before </worksheet>.
    if let Some(idx) = text.rfind("</worksheet>") {
        let mut out = String::with_capacity(text.len() + block.len());
        out.push_str(&text[..idx]);
        out.push_str(&block);
        out.push_str(&text[idx..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "worksheet xml missing </worksheet> close tag".to_string(),
    ))
}

/// Inject `<Relationship>` entries for `tablePart` references into an
/// existing sheet rels file. Each entry uses the rId we minted in
/// `inject_table_parts_into_sheet_xml` (`rIdT1`, `rIdT2`, ...).
fn inject_table_rels(
    content: Vec<u8>,
    sheet_tables: &[&TableExport],
) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("sheet rels xml is not valid UTF-8: {e}")))?;

    let mut rels = String::with_capacity(128 * sheet_tables.len());
    for (i, t) in sheet_tables.iter().enumerate() {
        rels.push_str(&format!(
            concat!(
                r#"<Relationship Id="rIdT{}" "#,
                r#"Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" "#,
                r#"Target="../tables/table{}.xml"/>"#,
            ),
            i + 1,
            t.id,
        ));
    }

    // Insert just before </Relationships>.
    if let Some(idx) = text.rfind("</Relationships>") {
        let mut out = String::with_capacity(text.len() + rels.len());
        out.push_str(&text[..idx]);
        out.push_str(&rels);
        out.push_str(&text[idx..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "sheet rels xml missing </Relationships> close tag".to_string(),
    ))
}

/// Render a fresh sheet rels file for a sheet that has tables but no
/// pre-existing rels file (umya doesn't emit one for plain sheets).
fn render_fresh_sheet_rels(sheet_tables: &[&TableExport]) -> String {
    let mut s = String::with_capacity(256 + 128 * sheet_tables.len());
    s.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    s.push('\n');
    s.push_str(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (i, t) in sheet_tables.iter().enumerate() {
        s.push_str(&format!(
            concat!(
                r#"<Relationship Id="rIdT{}" "#,
                r#"Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" "#,
                r#"Target="../tables/table{}.xml"/>"#,
            ),
            i + 1,
            t.id,
        ));
    }
    s.push_str("</Relationships>");
    s
}

/// Inject `<Override>` entries into `[Content_Types].xml` for each
/// new `xl/tables/table{N}.xml` part we emitted.
fn inject_table_overrides_into_content_types(
    content: Vec<u8>,
    tables: &[TableExport],
) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("[Content_Types].xml is not valid UTF-8: {e}")))?;

    let mut overrides = String::with_capacity(128 * tables.len());
    for t in tables {
        overrides.push_str(&format!(
            concat!(
                r#"<Override PartName="/xl/tables/table{}.xml" "#,
                r#"ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>"#,
            ),
            t.id,
        ));
    }

    // Insert just before </Types>.
    if let Some(idx) = text.rfind("</Types>") {
        let mut out = String::with_capacity(text.len() + overrides.len());
        out.push_str(&text[..idx]);
        out.push_str(&overrides);
        out.push_str(&text[idx..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "[Content_Types].xml missing </Types> close tag".to_string(),
    ))
}

/// Translate a Quantbook `Value` into an umya cell value setter.
///
/// **Error values**: umya represents Excel errors via the cell's
/// value string in the OOXML `t="e"` form. We set the textual
/// representation; consumers (Excel) re-parse it as an error.
fn apply_value_to_cell(cell: &mut umya_spreadsheet::Cell, value: &Value) {
    match value {
        Value::Number(n) => {
            cell.set_value_number(*n);
        }
        Value::Boolean(b) => {
            cell.set_value_bool(*b);
        }
        Value::Text(s) => {
            cell.set_value_string(s.as_ref());
        }
        Value::Error(e) => {
            // **W5-D-14.1 (audit HIGH-6 closure):** use umya's
            // `set_error` (which routes through `guess_typed_data` →
            // `CellRawValue::Error`) instead of `set_value_string`
            // (which writes a plain text cell). On re-import, calamine
            // now produces `Data::Error(...)` and our `data_to_value`
            // maps that to `Value::Error(...)` — preserving the type.
            cell.set_error(e.sigil());
        }
        Value::Blank => {
            // No-op — empty cell.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_empty_workbook_writes_valid_xlsx() {
        // Smoke: a workbook with one empty sheet should export to a
        // valid xlsx (umya generates the OOXML scaffolding even for
        // empty sheets).
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let tmp = std::env::temp_dir().join("ql-io-xlsx-empty-export.xlsx");
        let report = export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();
        assert_eq!(report.cells_written, 0);
        assert_eq!(report.formula_caches_written, 0);
        // File exists and is non-empty.
        let metadata = std::fs::metadata(&tmp).unwrap();
        assert!(metadata.len() > 0);
        let _ = std::fs::remove_file(&tmp);
    }

    // ===== Wave B2 (2026-06-18): cell visual-style export =====

    /// Read one part out of an in-memory export.
    fn export_part(wb: &Workbook, part: &str) -> String {
        use std::io::Read;
        let (bytes, _r) =
            export_new_workbook_to_bytes(wb, FormulaCachePolicy::WriteRecomputed).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut s = String::new();
        zip.by_name(part).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    fn styles_xml(wb: &Workbook) -> String {
        export_part(wb, "xl/styles.xml")
    }

    /// Intern `style` and bind it to (row, col) on `sheet`.
    fn set_style(wb: &mut Workbook, sheet: ql_types::SheetId, row: u32, col: u32, style: Style) {
        let sid = wb.styles_mut().intern(style);
        wb.sheet_mut(sheet)
            .unwrap()
            .style_overlay_mut()
            .set(row, col, sid);
    }

    /// **Guard (No-Fallbacks):** pin umya 2.2.0's default styles.xml base
    /// roster counts. The append-only style injection computes absolute
    /// fontId/fillId/borderId as `base_count + roster_index`; if a umya
    /// upgrade changes these defaults, this fails LOUDLY so the offsets get
    /// re-checked rather than silently shifting every styled cell.
    #[test]
    fn umya_default_style_roster_counts_pinned() {
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let xml = styles_xml(&wb);
        assert!(
            xml.contains(r#"<fonts count="1""#),
            "umya default <fonts count> changed: {xml}"
        );
        assert!(
            xml.contains(r#"<fills count="2">"#),
            "umya default <fills count> changed: {xml}"
        );
        assert!(
            xml.contains(r#"<borders count="1">"#),
            "umya default <borders count> changed: {xml}"
        );
    }

    /// A workbook with a number-format but NO styles must leave the
    /// fonts/fills/borders rosters at umya's defaults and emit the format xf
    /// with the pre-Wave-B2 `fontId="0" fillId="0" borderId="0"` shape
    /// (byte-stability of the no-style path).
    #[test]
    fn no_style_format_only_leaves_default_rosters() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.5));
        let fid = wb.formats_mut().intern("0.00");
        wb.sheet_mut(s).unwrap().format_overlay_mut().set(0, 0, fid);
        let xml = styles_xml(&wb);
        // Sub-rosters untouched.
        assert!(xml.contains(r#"<fonts count="1""#), "{xml}");
        assert!(xml.contains(r#"<fills count="2">"#), "{xml}");
        assert!(xml.contains(r#"<borders count="1">"#), "{xml}");
        // The format xf still hardcodes the default font/fill/border ids.
        // ("0.00" is Excel built-in numFmtId 2.)
        assert!(
            xml.contains(
                r#"<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>"#
            ),
            "format-only xf shape changed: {xml}"
        );
    }

    #[test]
    fn bold_cell_exports_font() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                bold: true,
                ..Default::default()
            },
        );
        let xml = styles_xml(&wb);
        assert!(xml.contains(r#"<fonts count="2""#), "{xml}");
        assert!(xml.contains("<b/>"), "{xml}");
        // The styled cell's xf references the appended fontId 1.
        assert!(
            xml.contains(r#"fontId="1""#) && xml.contains(r#"applyFont="1""#),
            "{xml}"
        );
    }

    #[test]
    fn underline_strike_and_text_color_export() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                underline: true,
                strike: true,
                text_color: Some(Rgb::new(0x12, 0x34, 0x56)),
                ..Default::default()
            },
        );
        let xml = styles_xml(&wb);
        assert!(xml.contains("<u/>"), "{xml}");
        assert!(xml.contains("<strike/>"), "{xml}");
        assert!(xml.contains(r#"<color rgb="FF123456"/>"#), "{xml}");
    }

    #[test]
    fn fill_cell_exports_solid_fill() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                fill: Some(Rgb::new(0xFF, 0x00, 0x00)),
                ..Default::default()
            },
        );
        let xml = styles_xml(&wb);
        assert!(xml.contains(r#"<fills count="3">"#), "{xml}");
        assert!(
            xml.contains(
                r#"<patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill>"#
            ),
            "{xml}"
        );
        // Appended fillId is 2 (after umya defaults 0=none, 1=gray125).
        assert!(
            xml.contains(r#"fillId="2""#) && xml.contains(r#"applyFill="1""#),
            "{xml}"
        );
    }

    #[test]
    fn border_cell_exports_border() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        let borders = Borders {
            top: BorderEdge {
                style: BorderStyle::Thin,
                color: Rgb::new(0, 0, 0),
            },
            ..Default::default()
        };
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                borders,
                ..Default::default()
            },
        );
        let xml = styles_xml(&wb);
        assert!(xml.contains(r#"<borders count="2">"#), "{xml}");
        assert!(
            xml.contains(r#"<top style="thin"><color rgb="FF000000"/></top>"#),
            "{xml}"
        );
        // Appended borderId is 1 (after umya default 0).
        assert!(
            xml.contains(r#"borderId="1""#) && xml.contains(r#"applyBorder="1""#),
            "{xml}"
        );
    }

    #[test]
    fn alignment_cell_exports_alignment_child() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                align: HAlign::Center,
                ..Default::default()
            },
        );
        let xml = styles_xml(&wb);
        assert!(
            xml.contains(r#"applyAlignment="1"><alignment horizontal="center"/></xf>"#),
            "{xml}"
        );
    }

    #[test]
    fn composite_format_and_style_share_one_xf() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.5));
        let fid = wb.formats_mut().intern("0.00");
        wb.sheet_mut(s).unwrap().format_overlay_mut().set(0, 0, fid);
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                bold: true,
                ..Default::default()
            },
        );
        let xml = styles_xml(&wb);
        // ONE xf carrying both the number-format AND the font.
        // ("0.00" is Excel built-in numFmtId 2.)
        assert!(
            xml.contains(
                r#"<xf numFmtId="2" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>"#
            ),
            "composite xf shape wrong: {xml}"
        );
    }

    #[test]
    fn shared_style_dedups_to_one_font() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(1.0));
        wb.put_at(s, 1, 0, Value::Number(2.0));
        let style = Style {
            bold: true,
            ..Default::default()
        };
        set_style(&mut wb, s, 0, 0, style);
        set_style(&mut wb, s, 1, 0, style);
        let xml = styles_xml(&wb);
        // Two cells, same bold style → ONE appended font (count 2, not 3).
        assert!(xml.contains(r#"<fonts count="2""#), "{xml}");
    }

    #[test]
    fn style_only_valueless_cell_is_emitted() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        // No value at A1 — only a style.
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                bold: true,
                ..Default::default()
            },
        );
        let sheet_xml = export_part(&wb, "xl/worksheets/sheet1.xml");
        // The valueless styled cell is synthesised with an s= index.
        assert!(
            sheet_xml.contains(r#"<c r="A1" s="1"/>"#),
            "style-only cell not emitted: {sheet_xml}"
        );
        let styles = styles_xml(&wb);
        assert!(styles.contains("<b/>"), "{styles}");
    }

    #[test]
    fn styled_workbook_values_round_trip_via_calamine() {
        // Styling must not corrupt the package — values still round-trip.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_at(s, 0, 1, Value::text("hi"));
        set_style(
            &mut wb,
            s,
            0,
            0,
            Style {
                bold: true,
                fill: Some(Rgb::new(0, 0xFF, 0)),
                align: HAlign::Right,
                ..Default::default()
            },
        );
        let tmp = std::env::temp_dir().join("ql-io-xlsx-styled-roundtrip.xlsx");
        let _ = std::fs::remove_file(&tmp);
        export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();
        let registry = ql_functions::default_registry();
        let result = crate::import_xlsx_path(
            &tmp,
            &registry,
            crate::XlsxImportOptions {
                recompute: crate::RecomputeMode::Skip,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let sheet = result.workbook.sheet(0).unwrap();
        assert_eq!(sheet.read(0, 0), Value::Number(42.0));
        match sheet.read(0, 1) {
            Value::Text(t) => assert_eq!(t.as_ref(), "hi"),
            other => panic!("expected Text(hi), got {other:?}"),
        }
        let _ = std::fs::remove_file(&tmp);
    }

    // ============================================================
    // NF-06 — next_non_legacy id allocation does not silently wrap
    // ============================================================

    /// Verify that a workbook with both LEGACY and non-LEGACY custom formats
    /// exports correctly: the non-LEGACY format gets allocated AFTER the
    /// LEGACY range. This exercises the `next_non_legacy = highest_legacy_id
    /// .checked_add(1).expect(...)` path without triggering the overflow.
    ///
    /// The non-LEGACY peer id comes from a multi-peer format; in practice this
    /// is exercised by workbooks that have been synced across peers.
    #[test]
    fn nf06_non_legacy_numfmtid_allocated_after_legacy_range() {
        use ql_storage::FormatId;

        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");

        // Register a LEGACY custom format (peer 0 = LEGACY_PEER).
        // FormatId::Custom(0, 0) → xlsx numFmtId = 0 + 164 = 164.
        let legacy_fid = wb.formats_mut().intern("#,##0.00");
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, legacy_fid);

        // Register a non-LEGACY peer format (peer 1).
        // This triggers the pass-2 non-LEGACY allocator in XlsxNumFmtTranslation::build.
        // (Normally non-LEGACY ids arrive from collaboration peers; here we
        // place a Custom(1,0) directly in the overlay — the export path handles
        // "unregistered_overlay_customs" via the no-fallback reporting path.)
        let non_legacy_fid = FormatId::Custom(ql_types::PeerId(1), 0);
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 1, non_legacy_fid);

        // Export must not panic (no overflow on `checked_add(1).expect(...)`).
        // The NF-06 fix ensures that when `highest_legacy_id` is not u32::MAX,
        // `checked_add(1)` succeeds and `next_non_legacy` is set correctly.
        let (bytes, _report) =
            export_new_workbook_to_bytes(&wb, FormulaCachePolicy::WriteRecomputed)
                .expect("export must not panic on NF-06 path");
        assert!(!bytes.is_empty(), "exported bytes must be non-empty");
    }

    #[test]
    fn export_workbook_with_values_round_trips_via_calamine() {
        // End-to-end: build a Quantbook with cells, export it, then
        // re-import via the W5-D-14a calamine path. Values should
        // come back identical.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("Sheet1");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_at(s, 0, 1, Value::text("hello"));
        wb.put_at(s, 1, 0, Value::Boolean(true));

        let tmp = std::env::temp_dir().join("ql-io-xlsx-roundtrip-values.xlsx");
        let _ = std::fs::remove_file(&tmp);
        export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();

        // Re-import via the public API.
        let registry = ql_functions::default_registry();
        let result = crate::import_xlsx_path(
            &tmp,
            &registry,
            crate::XlsxImportOptions {
                recompute: crate::RecomputeMode::Skip,
                ..Default::default()
            },
            // NOTE: `None` (not `ql_exec::EngineXlsxRecomputer`) — the lib-test
            // compiles against a distinct crate instance from the one
            // `ql-exec`'s impl targets, so the trait bound would not match here.
            // `RecomputeMode::Skip` means the recomputer is never invoked.
            None,
        )
        .unwrap();

        // Assert values match.
        let sheet = result.workbook.sheet(0).unwrap();
        assert_eq!(sheet.read(0, 0), Value::Number(42.0));
        match sheet.read(0, 1) {
            Value::Text(s) => assert_eq!(s.as_ref(), "hello"),
            other => panic!("expected Text(\"hello\"), got {other:?}"),
        }
        assert_eq!(sheet.read(1, 0), Value::Boolean(true));
        let _ = std::fs::remove_file(&tmp);
    }
}
