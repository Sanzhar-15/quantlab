//! `Workbook` — top-level container; holds the sheet list + the name table.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - `sheets: Vec<Sheet>` indexed by `SheetId` (u16).
//! - `names: NameTable` — workbook-level defined names. Phase 2A.1 (2026-05-12)
//!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
//!   binder in `ql-exec` resolves names against this table at bind time.
//!   Sheet-scope names land Phase 3+ with `ql-formula-semantics`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ql_types::{Address, ColId, ErrorValue, Range, RowId, SheetId, Value};

use crate::sheet::Sheet;

/// What a defined name resolves to.
///
/// Per codex r13 N9 + opus arch F5: the prior `lookup -> Option<Address>` couldn't represent
/// the common Excel defined-name targets (range, constant, formula). The shape was a wrong
/// stub that would force a breaking change in Week 3 ql-calcgraph binding. Widening to the
/// enum NOW is non-breaking later — calcgraph callers pattern-match on the variant they need.
///
/// Phase 0 shipped all variants for forward compatibility. Phase 2A.1 (2026-05-12)
/// added real storage for `Cell` and `Constant` variants; the `Range` and `Formula`
/// variants are still resolution-deferred (the binder returns
/// `BindError::UnsupportedVariant` for them — Phase 2B+ aggregate-context wiring
/// closes that gap).
#[derive(Clone, Debug, PartialEq)]
pub enum NamedTarget {
    /// Named single cell (`SalesRow1 = $A$1`).
    Cell(Address),
    /// Named range (`Sales = $A$2:$A$1000`).
    Range(Range),
    /// Named constant (`TaxRate = 0.21`).
    Constant(Value),
    /// Named formula (`Profit = Revenue - Costs`). Stored as the raw formula source; the
    /// binder re-parses + evaluates in the use-site context. Phase 3+ feature.
    Formula(std::sync::Arc<str>),
}

/// Defined-names table.
///
/// Phase 2A.1 (2026-05-12): real workbook-scope storage. Phase 2A.6 audit fix
/// (H2/M6/D5): canonicalization is enforced at the **insert** boundary — `set`
/// uppercases the key on write, so every entry lives at its canonical
/// upper-case form. `lookup` is case-sensitive on canonical form (fast path for
/// the parser, which already canonicalizes); `lookup_ci` exists as a
/// belt-and-suspenders entry point for callers that bypass the parser
/// canonicalization. Sheet-scope names (Excel's `Sheet1!Local`) are deferred to
/// Phase 3+ ql-formula-semantics.
///
/// ## Generation counter (Phase 2B.3)
///
/// `generation` is bumped on every successful `set` / `clear`. Bind-plan
/// caches in `ql-exec` key cached plans by `(formula_text, sheet,
/// generation)` so a name registration / rename invalidates affected plans
/// without an explicit cache-flush call — the next lookup just misses.
#[derive(Clone, Debug, Default)]
pub struct NameTable {
    entries: HashMap<Arc<str>, NamedTarget>,
    /// Monotonic counter bumped on every successful mutation. See struct
    /// docs for the cache-invalidation contract. Wraps at u64::MAX (4×10^18
    /// mutations — not a realistic concern).
    generation: u64,
}

/// Errors emitted by `NameTable::set` when a registration is refused.
///
/// Phase 2A.9 audit M6 (2026-05-12): closes the AI() reservation hole. The
/// previous `NameTable::set` returned `()` and silently accepted any name,
/// including ones reserved by the engine. A user calling
/// `wb.set_name("AI", NamedTarget::Constant(...))` then writing `=AI` bypassed
/// the CORR-06 AI sentinel because `=AI` (no parens) goes through the binder's
/// NameRef path instead of the function-call path. Now the registration
/// itself is refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum NameTableError {
    /// The name is reserved by the engine. Per CORR-06: `AI`. Future
    /// reservations belong in `is_reserved_name` below.
    #[error("name {0:?} is reserved by the engine and cannot be registered")]
    Reserved(Arc<str>),
}

/// **Phase 4.6.AA (W5-86):** errors from `Workbook::validate_sheet_name`,
/// used by `add_sheet` / `rename_sheet` (Phase 4.6.C). Distinct from
/// `NameTableError` because the validation rules differ (sheet names
/// allow reserved-name-table entries like `AI`; sheet names reject
/// Excel-reserved characters; etc.).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum SheetNameError {
    /// Empty string — Excel canon rejects.
    #[error("sheet name cannot be empty")]
    Empty,

    /// Excel-reserved character in the proposed name. Set: `:`, `\`,
    /// `/`, `?`, `*`, `[`, `]`. xlsx round-trip prerequisite (Phase 4.11).
    #[error("sheet name contains Excel-reserved character {0:?}")]
    ReservedCharacter(char),

    /// Canonical duplicate of an existing sheet name (case-insensitive
    /// comparison per `Workbook::canonical_sheet_name`).
    #[error("sheet name {name:?} is already in use (case-insensitive)")]
    Duplicate { name: String },
}

/// Phase 2A.9 audit M6: the canonical-uppercase reserved-name list. Names
/// here cannot be registered via `NameTable::set` or `Workbook::set_name`.
/// Keep small; document each entry.
fn is_reserved_name(canonical: &str) -> bool {
    matches!(
        canonical,
        // CORR-06 / T4-D05: AI is the reserved sentinel that dispatches to
        // `Error(AINotAvailable)` until the Phase 4+ AI() function ships.
        "AI"
    )
}

/// **W5-D-PM12-2 (megaudit Opus-A HIGH-4 closure):** does `name` look
/// like an Excel column letter (`K`, `XFC`) or cell reference
/// (`A1`, `XFD1048576`)?
///
/// Helper kept available for the deferred HIGH-4 closure that
/// will reject these names at the producer once the binder's
/// AggregateArg-side literal-range support lands (HIGH-1). The
/// current code path doesn't call this — see `NameTable::set` for
/// the deferred-closure rationale.
#[allow(dead_code)]
fn looks_like_excel_cell_ref(canonical: &str) -> bool {
    let bytes = canonical.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    // Walk letters first.
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    // Excel column max is XFD = 3 letters. Anything else can't be a
    // ref shape.
    if i == 0 || i > 3 {
        return false;
    }
    // Pure-letter case: matches a column-letter token (`K`, `XFC`).
    if i == bytes.len() {
        return true;
    }
    // Letter-then-digits case: cell-ref shape (`A1`, `XFD1048576`).
    let rest = &canonical[i..];
    rest.bytes().all(|b| b.is_ascii_digit())
}

impl NameTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a name → target binding. The key is uppercased before insertion
    /// so the table always stores entries in canonical Excel case.
    ///
    /// Phase 2A.6 audit M6/D5 added the on-write canonicalization (was: stored
    /// as-is, creating a disagreement with `lookup` that uppercased queries).
    ///
    /// Phase 2A.9 audit M6 added the reserved-name guard. Names returned `true`
    /// from `is_reserved_name` (currently just `AI` per CORR-06) are refused
    /// with `NameTableError::Reserved`. The return type is now `Result` —
    /// callers that previously expected `()` need to handle the error or
    /// `.expect(...)` it.
    pub fn set(
        &mut self,
        name: impl AsRef<str>,
        target: NamedTarget,
    ) -> Result<(), NameTableError> {
        let upper: Arc<str> = Arc::from(name.as_ref().to_ascii_uppercase().as_str());
        if is_reserved_name(&upper) {
            return Err(NameTableError::Reserved(upper));
        }
        // **W5-D-PM12-2 megaudit Opus-A HIGH-4 — DEFERRED.**
        // Initial closure attempted to reject cell-ref-shaped names
        // (`K`, `XFC`, `A1`) at the producer, but existing tests
        // (env.rs:530+, 555, 592 etc.) intentionally register
        // single-letter names like `R` and the binder resolves them
        // correctly when used in non-product context. The Opus-A
        // failure case is `K*A1` where the binder treats `K` as a
        // column→range and `A1` as a cell → `RangeRef × CellRef`
        // which the AggregateArg gate rejects. The root cause is
        // shared with HIGH-1 (literal RangeRef in non-Function
        // context). Closing HIGH-1 likely closes HIGH-4 too.
        // Deferred until HIGH-1 lands or a separate
        // name-precedence-over-column-letter binder pass.
        self.entries.insert(upper, target);
        self.generation = self.generation.wrapping_add(1);
        Ok(())
    }

    /// Remove a name binding. Uppercases the query so callers don't have to
    /// match the on-write canonicalization. Idempotent.
    pub fn clear(&mut self, name: &str) {
        let upper = name.to_ascii_uppercase();
        // Only bump generation if a binding was actually removed — idempotent
        // no-op clears don't invalidate any cache.
        if self.entries.remove(upper.as_str()).is_some() {
            self.generation = self.generation.wrapping_add(1);
        }
    }

    /// Phase 2B.3 (2026-05-12): monotonic generation counter, bumped on every
    /// successful `set` / `clear`. Bind-plan caches in `ql-exec` key cached
    /// plans by `(formula_text, sheet, generation)` so a name mutation
    /// invalidates affected plans on next lookup without an explicit flush.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Phase 2B.7 audit H3 (2026-05-12): pre-check whether `set(name, _)`
    /// would succeed without doing the mutation. Lets the `ql-exec`
    /// `WorkbookRuntime::set_name` wrapper run validate-then-append-then-
    /// mutate so a reserved-name rejection doesn't leave the workbook
    /// either (a) modified with no op log entry, or (b) un-modified but
    /// with an orphan op log entry.
    ///
    /// Returns `Ok(())` if a future `set(name, _)` will succeed,
    /// `Err(NameTableError::Reserved(...))` otherwise. Pure: no
    /// mutation, no generation bump.
    pub fn would_accept(&self, name: &str) -> Result<(), NameTableError> {
        let upper: Arc<str> = Arc::from(name.to_ascii_uppercase().as_str());
        if is_reserved_name(&upper) {
            return Err(NameTableError::Reserved(upper));
        }
        Ok(())
    }

    /// Look up a name. Case-sensitive on the canonical-uppercase form — used
    /// by the parser-internal path where the query is already canonicalized.
    /// External callers should prefer `lookup_ci` unless they've already
    /// uppercased the query.
    pub fn lookup(&self, name: &str) -> Option<NamedTarget> {
        self.entries.get(name).cloned()
    }

    /// Case-insensitive lookup: uppercases the query before searching.
    /// Phase 2A.6 audit H2: the `NameLookup for NameTable` impl uses this so
    /// the binder is robust against future callers who forget to canonicalize.
    pub fn lookup_ci(&self, name: &str) -> Option<NamedTarget> {
        let upper = name.to_ascii_uppercase();
        self.entries.get(upper.as_str()).cloned()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Iterate all `(name, target)` bindings. Order is HashMap-arbitrary.
    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &NamedTarget)> + '_ {
        self.entries.iter()
    }
}

/// Top-level Quantbook container.
///
/// Phase 1 W5-9 adds `formula_cells`: a HashMap keyed by `(sheet, row, col)` mapping
/// formula-bearing cells to their formula source text (e.g. `"A1 + B1"`). The cell's
/// EVALUATED result still lives in the Sheet's columnar storage as a Value; this map
/// records that the value was *produced by a formula* (so it can be recomputed and so
/// the save path persists the formula). Cells without an entry here are literals.
///
/// This is the minimum Phase 1 formula-persistence model. Phase 4+ adds:
/// - Calcgraph dependency tracking (computed-overlay separation per CORR-25).
/// - Automatic recompute on dependency change.
/// - Cross-sheet formula references.
///
/// ## Clone semantics
///
/// `Clone` is **shallow with respect to Arrow chunk buffers**: each
/// `ColumnStore` holds `Vec<Arc<dyn arrow_array::Array>>`, and cloning the
/// Workbook clones the Arc handles (cheap refcount bump), NOT the underlying
/// Arrow buffers. This is safe today because the only mutating APIs
/// (`Workbook::put`, `Sheet::put`, `ColumnStore::put`, `replace_chunk`,
/// `append_chunk`) operate at the chunk granularity — they install whole new
/// `ArrayRef` values, never mutate an existing Arrow buffer in place. So a
/// clone and the original never see each other's writes through their shared
/// chunk Arcs.
///
/// Phase 2A.12 audit H4 (persistence-agent finding): if a future API ever
/// mutates a chunk's bytes in place (e.g. `Float64Array::values_mut` via
/// `Arc::make_mut`), it MUST also break the Arc-sharing contract — either
/// clone the buffer first or document the in-place mutation. The
/// chunk-replace-only invariant is what makes shallow Clone correct.
#[derive(Clone, Debug, Default)]
pub struct Workbook {
    sheets: Vec<Sheet>,
    names: NameTable,
    formula_cells: HashMap<(SheetId, RowId, ColId), Arc<str>>,
    /// **W5-71 (Phase 4.5.A.2):** Excel date system for this workbook.
    /// Default `Excel1900` (Windows Excel canon). The `.qbook` envelope
    /// persists this; xlsx I/O (Phase 4.11) maps it from the workbook's
    /// `date1904` SST flag. Functions read this via
    /// `WorkbookEnv::eval_context()` to drive serial ↔ date conversion.
    date_system: ql_types::DateSystem,
    /// **W5-79 (Phase 4.5.D part 3):** workbook-level format-string
    /// interning table. Cells with non-General formats reference an id
    /// into this table via per-sheet [`crate::CellFormatOverlay`].
    /// Default loads the Excel built-ins from
    /// `docs/architecture/2026-05-13-format-string-grammar.md` § 10
    /// (parser-relevant subset).
    formats: crate::FormatTable,
    /// **W5-101 (Phase 4.7.H):** spill-anchor table. Workbook-level
    /// because spills can theoretically span sheets (rare in Excel; v1
    /// keeps single-sheet but the table doesn't assume). Map-only by
    /// design; mutation goes through `register_spill` / `clear_spill_at`
    /// — the latter is the workbook-layer convenience that also clears
    /// computed overlays at every target cell. See
    /// `crates/ql-storage/src/spill.rs` module docs.
    spill_anchors: crate::SpillAnchorTable,
    /// **W5-110 (Phase 4.8.A):** workbook-level table registry. Mirrors
    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
    /// `WorkbookRuntime::create_table` etc.; direct access here is for
    /// the qbook loader + tests. See `crates/ql-storage/src/tables.rs`
    /// module docs.
    tables: crate::TableTable,
    /// **W5-133 (Phase 4.9.A):** formula-text reference mode. A
    /// workbook-level user preference; default `A1`. Storage canon
    /// stays A1 regardless of this setting — `R1C1` only affects how
    /// the lexer/parser interpret user input and how the printer
    /// emits the stored canonical AST. See Phase 4.9 design doc § 1.
    reference_mode: ql_types::ReferenceMode,
    /// **W5-133 (Phase 4.9.A):** locale for separator + decimal rules.
    /// Workbook-level. Default `EnUs`. Storage canon stays EN
    /// separators (decimal `.`, arg `,`, array row `;`, array col
    /// `,`) regardless of this setting; non-EN locales affect only
    /// the edit-time lex/print transforms. Promoted from
    /// `EvalContext::locale` (which previously held this for the
    /// eval layer only) — the persistent home is now the workbook.
    /// See Phase 4.9 design doc § 1 + § 3.2.
    locale: ql_types::Locale,
    /// **Phase 5.7 V3.5.0.3b (2026-05-24):** tombstoned sheet ids per
    /// the V3.5.0.3b CRDT semantic decision lock.  `Op::RemoveSheet { id }`
    /// inserts `id` into this set instead of mutating `sheets`; this
    /// preserves the id-stability invariant that all post-RemoveSheet
    /// ops (PutValue/PutFormula/ClearFormula/RenameSheet) depend on
    /// (they reference sheets by id, not by position).
    ///
    /// **Idempotent**: re-removing an already-tombstoned sheet is a
    /// no-op (HashSet semantics).  Cross-peer concurrent
    /// `Op::RemoveSheet` on the same id converges deterministically.
    ///
    /// **Snapshot filter**: callers iterating sheets MUST check
    /// `is_sheet_removed(id)` to skip tombstoned slots.  The napi
    /// `workbookSnapshot` method does this at V3.5.0.3b ship.
    ///
    /// **Storage retained**: tombstoning does NOT free the underlying
    /// `Sheet` storage at `sheets[id]`.  The Sheet stays in place
    /// (preserving id stability for subsequent ops); cell data is
    /// reachable via `sheet(id)` even when tombstoned (caller's
    /// responsibility to honor the tombstone).  V3.6+ may add a
    /// reclamation pass that compacts truly-orphaned sheet storage
    /// once the op log is also purged of references.
    removed_sheets: HashSet<SheetId>,
    /// **Phase 5.7 V3.5.0.3c (2026-05-24):** display-order overlay per
    /// V3.5.0.3c CRDT semantic decision lock.  `Op::MoveSheet { id,
    /// new_index }` reorders entries in this vec WITHOUT mutating the
    /// underlying `sheets: Vec<Sheet>` -- sheet ids stay stable so
    /// subsequent ops keep their referent.
    ///
    /// **Default**: `[0, 1, ..., sheet_count() - 1]` in append order.
    /// Each `try_add_sheet_with_chunk_rows` appends the newly-assigned
    /// id to the end.  Sessions that never call `Op::MoveSheet` see
    /// `display_order` identical to `0..sheet_count()` -- preserving
    /// the V3.5.0.3b iteration-order contract for backward compat.
    ///
    /// **Tombstone interaction**: `removed_sheets` and
    /// `sheet_display_order` are ORTHOGONAL.  A tombstoned sheet
    /// CAN have a display-order entry (move-on-tombstoned-sheet is
    /// silently applied per the V3.5.0.3c semantic; display order
    /// remembers the user's intent even for deleted sheets).
    /// `workbookSnapshot` napi-layer applies BOTH filters: iterates
    /// `display_order` AND skips tombstoned ids.
    ///
    /// **`Op::RemoveSheet` does NOT remove from display_order**:
    /// preserving the entry allows V3.6+ un-delete to restore display
    /// position correctly.  Today the entry stays but is filtered out
    /// of snapshot via `is_sheet_removed` check.
    sheet_display_order: Vec<SheetId>,
}

impl Workbook {
    pub fn new() -> Self {
        Self::default()
    }

    /// **W5-71 (Phase 4.5.A.2):** the workbook's date system.
    pub fn date_system(&self) -> ql_types::DateSystem {
        self.date_system
    }

    /// **W5-71 (Phase 4.5.A.2):** set the workbook's date system.
    /// Used by the `.qbook` loader on file load (defaults to `Excel1900`
    /// when missing from the envelope) and by xlsx import in Phase 4.11.
    /// Switching post-load shifts every serial by 1462 days — not
    /// recommended as a runtime operation.
    ///
    /// **W5-76 mega-audit caveat:** `WorkbookEnv` (`ql-exec`) caches the
    /// `EvalContext` (and therefore the `DateSystem`) at construction.
    /// Mutating the workbook's date system AFTER a `WorkbookEnv` has been
    /// constructed will produce a stale eval context until a fresh
    /// `WorkbookEnv` is created. Today every recompute path constructs
    /// a fresh `WorkbookEnv`, so normal evaluation is safe; callers that
    /// hold a long-lived `WorkbookEnv` across `set_date_system` must
    /// rebuild it. Treat this method as loader-only.
    pub fn set_date_system(&mut self, system: ql_types::DateSystem) {
        self.date_system = system;
    }

    /// **W5-133 (Phase 4.9.A):** the workbook's formula-text
    /// reference mode (`A1` or `R1C1`). Default `A1`. Phase 4.9
    /// design doc § 1 + § 4.4.
    pub fn reference_mode(&self) -> ql_types::ReferenceMode {
        self.reference_mode
    }

    /// **W5-133 (Phase 4.9.A):** set the workbook's reference mode.
    /// Used by the `.qbook` loader (v7) and by
    /// `WorkbookRuntime::set_reference_mode` (4.9.K). Switching mode
    /// does NOT rewrite stored formula text — storage canon stays A1.
    /// Only display + input transforms change.
    pub fn set_reference_mode(&mut self, mode: ql_types::ReferenceMode) {
        self.reference_mode = mode;
    }

    /// **W5-133 (Phase 4.9.A):** the workbook's locale. Default
    /// `EnUs`. Used by the lexer + printer for separator + decimal
    /// rules; see `ql-formula-syntax::locale_data` for the per-locale
    /// data tables.
    pub fn locale(&self) -> ql_types::Locale {
        self.locale
    }

    /// **W5-133 (Phase 4.9.A):** set the workbook's locale. Used by
    /// the `.qbook` loader (v7) and by `WorkbookRuntime::set_locale`
    /// (4.9.K). Switching locale does NOT rewrite stored formula text
    /// — storage canon stays EN separators. Only display + input
    /// transforms change.
    pub fn set_locale(&mut self, locale: ql_types::Locale) {
        self.locale = locale;
    }

    /// **W5-79 (Phase 4.5.D part 3):** read access to the workbook's
    /// format-string interning table.
    pub fn formats(&self) -> &crate::FormatTable {
        &self.formats
    }

    /// **W5-79 (Phase 4.5.D part 3):** mutable access for `intern` /
    /// `register_at`. Phase 4.5.D part 4 (W5-80) will route mutations
    /// through `WorkbookRuntime::register_format` so they land in the
    /// op log; direct access stays available for the loader + tests.
    pub fn formats_mut(&mut self) -> &mut crate::FormatTable {
        &mut self.formats
    }

    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    // ===== Phase 4.6.AA (W5-86): sheet registry + canonicalizer =====

    /// **Phase 4.6.AA (W5-86):** canonicalize a sheet name for
    /// case-insensitive comparison. ASCII uppercase per the parent
    /// design doc § 7.3 (consistency with `NameTable::set`'s rule;
    /// Unicode casefolding deferred to a follow-up gap).
    ///
    /// Excel canonical: sheet names compare case-insensitively (so
    /// `"Sheet1"` and `"SHEET1"` are the same sheet) but the DISPLAY
    /// form preserves user-supplied case. This function returns the
    /// canonical form used for lookup / duplicate-detection ONLY;
    /// display goes through `Sheet::name()`.
    ///
    /// V1 simplification: ASCII-only uppercase. `"Café"` and `"café"`
    /// canonicalize to different forms (the non-ASCII `é` is not
    /// folded). Excel itself uses Unicode casefolding here; if a real
    /// workbook with non-ASCII sheet names surfaces a collision, this
    /// gets revisited.
    pub fn canonical_sheet_name(name: &str) -> String {
        name.to_ascii_uppercase()
    }

    /// **Phase 4.6.AA (W5-86):** find a sheet by name (case-insensitive
    /// per `canonical_sheet_name`). Returns the first match in id order.
    ///
    /// Lookup cost: O(sheet_count). Acceptable for typical workbooks
    /// (low double-digits of sheets). If profiling shows pain, a
    /// canonical-name → id index can be added without changing this
    /// API surface.
    pub fn sheet_id_by_name(&self, name: &str) -> Option<SheetId> {
        let canonical = Self::canonical_sheet_name(name);
        for (idx, sheet) in self.sheets.iter().enumerate() {
            if Self::canonical_sheet_name(sheet.name()) == canonical {
                return Some(idx as SheetId);
            }
        }
        None
    }

    /// **Phase 4.6.C (W5-91):** rename a sheet by id. Validates the new
    /// name via [`validate_sheet_name`] (rejects empty, Excel-reserved
    /// chars, canonical duplicates) and swaps the sheet's display name.
    ///
    /// **DOES NOT touch formula text.** Stored formulas in
    /// `formula_cells` and `NamedTarget::Formula` entries continue to
    /// reference the OLD sheet name. The runtime wrapper
    /// `WorkbookRuntime::rename_sheet` (`ql-exec`) owns the
    /// tokenization-aware text rewrite + op-log recording per the
    /// parent design doc § 3.1. Direct callers of this method (loader,
    /// tests, op-log replay) get bare name swap only.
    ///
    /// **Phase 4.6 design doc § 3 (Codex HIGH-1 closure):** the swap is
    /// fast (O(1) on the sheet's `name` field); the expensive text
    /// rewrite is the caller's responsibility and is bounded by the
    /// workbook's total formula text size.
    pub fn rename_sheet(
        &mut self,
        id: SheetId,
        new_name: impl Into<String>,
    ) -> Result<(), SheetNameError> {
        let new_name: String = new_name.into();
        // Validate first. If the new name canonically matches the CURRENT
        // sheet name, that's a no-op rename (case-only change is allowed
        // as a display update; duplicate check rejects all other matches).
        let current_canonical = self
            .sheet(id)
            .map(|s| Self::canonical_sheet_name(s.name()))
            .ok_or_else(|| SheetNameError::Duplicate {
                name: format!("<sheet id {id} not found>"),
            })?;
        let new_canonical = Self::canonical_sheet_name(&new_name);
        if new_canonical != current_canonical {
            // Full validation only when canonical name actually changes.
            self.validate_sheet_name(&new_name)?;
        } else if new_name.is_empty() {
            return Err(SheetNameError::Empty);
        }
        // Swap the name. `Sheet::set_name` is private; mutate through
        // sheet_mut + a new accessor.
        if let Some(sheet) = self.sheets.get_mut(id as usize) {
            sheet.set_name(new_name);
        }
        Ok(())
    }

    /// **Phase 4.6.AA (W5-86):** validate a sheet name for use with
    /// `add_sheet` / `rename_sheet`. Rejects:
    /// - empty string (Excel canon)
    /// - canonical duplicate of an existing sheet name
    /// - Excel-reserved characters `:`, `\`, `/`, `?`, `*`, `[`, `]`
    ///   (also xlsx round-trip prerequisite for Phase 4.11)
    ///
    /// Per the parent design's named-divergence catalog: V1 matches
    /// Excel's rejection set exactly. Length limit (Excel's 31-char
    /// max) is NOT enforced in V1 — that's a UX hint, not a correctness
    /// boundary; tracked for follow-up if xlsx import surfaces it.
    pub fn validate_sheet_name(&self, name: &str) -> Result<(), SheetNameError> {
        if name.is_empty() {
            return Err(SheetNameError::Empty);
        }
        for c in name.chars() {
            if matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']') {
                return Err(SheetNameError::ReservedCharacter(c));
            }
        }
        if self.sheet_id_by_name(name).is_some() {
            return Err(SheetNameError::Duplicate {
                name: name.to_owned(),
            });
        }
        Ok(())
    }

    pub fn names(&self) -> &NameTable {
        &self.names
    }

    /// Mutable access to the name table. Phase 2A.1 (2026-05-12) addition for
    /// runtime registration of defined names.
    pub fn names_mut(&mut self) -> &mut NameTable {
        &mut self.names
    }

    // ===== W5-110 (Phase 4.8.A): table registry =====

    /// **W5-110 (Phase 4.8.A):** read access to the workbook's table
    /// registry. See `crate::TableTable` and the design doc at
    /// `docs/architecture/2026-05-14-structured-references-and-tables.md`.
    pub fn tables(&self) -> &crate::TableTable {
        &self.tables
    }

    /// **W5-110 (Phase 4.8.A) — LOW-LEVEL.** Mutable access to the
    /// table registry. Bypasses the op log silently; product mutations
    /// go through `WorkbookRuntime::create_table` etc. (4.8.H+) which
    /// emit op-log entries. Direct callers: qbook loader, tests,
    /// engine-internal reconstruction.
    pub fn tables_mut(&mut self) -> &mut crate::TableTable {
        &mut self.tables
    }

    /// **W5-110 (Phase 4.8.A):** convenience case-insensitive table
    /// lookup. Returns `None` if no table with that name exists.
    pub fn lookup_table(&self, name: &str) -> Option<&crate::TableMetadata> {
        self.tables.lookup(name)
    }

    /// **W5-110 (Phase 4.8.A):** reverse lookup — which table contains
    /// the given cell, if any? Used by:
    /// - the binder for `[@Col]` resolution.
    /// - `create_table` / `resize_table` overlap validation.
    /// - `write_spill` to block spill anchors inside table footprints
    ///   (design § 4.3 invariant #5).
    pub fn table_at(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
    ) -> Option<&crate::TableMetadata> {
        self.tables
            .table_at(ql_types::Address::new(sheet, row, col))
    }

    /// Phase 2A.1 convenience: register a name → target binding on the workbook's
    /// name table. Phase 2A.6 audit M6: canonicalization lives on
    /// `NameTable::set` (this is a thin pass-through). Phase 2A.9 audit M6:
    /// reserved-name registration (currently `AI` per CORR-06) is refused —
    /// callers must handle or `.expect(...)` the `Result`.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** This method bypasses the op
    /// log silently: callers that want their name registration to land in an
    /// attached `OpLog` must go through `ql_exec::WorkbookRuntime::set_name`
    /// instead. Direct `Workbook::set_name` callers are: (a) the qbook
    /// loader (reconstructing from disk; op-log is loaded separately), and
    /// (b) tests / engine-internal reconstruction code. Tracked as
    /// GAP-O-01 in `docs/known-gaps.md`.
    pub fn set_name(&mut self, name: &str, target: NamedTarget) -> Result<(), NameTableError> {
        self.names.set(name, target)
    }

    /// Append a new sheet; returns its `SheetId`. Panics if the next ID would exceed
    /// `SheetId::MAX` (65,535). Excel allows ≤255 sheets in practice; we cap at the type
    /// limit so the ID always fits the field.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log
    /// silently — use `ql_exec::WorkbookRuntime::add_sheet` to record the
    /// sheet creation in an attached `OpLog`. Tracked as GAP-O-02 in
    /// `docs/known-gaps.md`.
    /// Infallible add. Panics on validation failure — `validate_sheet_name`
    /// catches empty, duplicate-under-canonical-comparison, and reserved-
    /// character cases at the storage boundary. **W5-93 (Phase 4.6.E
    /// closure):** Codex HIGH-1 flagged the prior silent acceptance:
    /// `wb.add_sheet("Sheet1")` + `wb.add_sheet("SHEET1")` previously
    /// produced two duplicate-canonical sheets without complaint.
    ///
    /// Test-friendly: the panic surfaces a bad-name bug immediately.
    /// Production callers route through `WorkbookRuntime::add_sheet`
    /// (which pre-validates) or `try_add_sheet_with_chunk_rows`
    /// (which returns a clean `Err`).
    pub fn add_sheet(&mut self, name: impl Into<String>) -> SheetId {
        self.try_add_sheet_with_chunk_rows(name, crate::column::chunk_rows_from_env())
            .expect(
                "Workbook::add_sheet: name validation failed (empty / duplicate / reserved char)",
            )
    }

    /// Add a sheet with an explicit chunk size. Used by tests AND by ql-io
    /// (W5-6 `load_workbook`) to reconstruct sheets at the saved chunk layout.
    /// Audit L7 fix (2026-05-12): doc previously said "test-only" but production
    /// code calls this.
    ///
    /// **W5-93 (Phase 4.6.E closure):** now panics on validation failure
    /// via `try_add_sheet_with_chunk_rows().expect(...)`. Fallible
    /// callers should use `try_add_sheet_with_chunk_rows` directly.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log. Use
    /// `ql_exec::WorkbookRuntime::add_sheet` for op-log-recording sheet
    /// creation. The qbook loader uses `try_add_sheet_with_chunk_rows`
    /// because op-log reconstruction is the loader's job (it replays the
    /// saved `oplog.bin`), not this method's. GAP-O-02.
    pub fn add_sheet_with_chunk_rows(
        &mut self,
        name: impl Into<String>,
        chunk_rows: u32,
    ) -> SheetId {
        self.try_add_sheet_with_chunk_rows(name, chunk_rows)
            .expect("Workbook::add_sheet_with_chunk_rows: name validation failed (empty / duplicate / reserved char)")
    }

    /// **W5-93 (Phase 4.6.E closure):** fallible add. Validates `name`
    /// via `validate_sheet_name` and surfaces `SheetNameError` for
    /// empty, duplicate-under-canonical-comparison, or reserved-
    /// character (`: \ / ? * [ ]`) inputs. Production callers (loader,
    /// runtime, replay) use this directly to convert a malformed input
    /// into a clean error rather than a panic.
    pub fn try_add_sheet_with_chunk_rows(
        &mut self,
        name: impl Into<String>,
        chunk_rows: u32,
    ) -> Result<SheetId, SheetNameError> {
        let name: String = name.into();
        self.validate_sheet_name(&name)?;
        let id = self.sheets.len();
        assert!(
            id < SheetId::MAX as usize,
            "too many sheets (max {})",
            SheetId::MAX as usize
        );
        self.sheets.push(Sheet::with_chunk_rows(name, chunk_rows));
        // **Phase 5.7 V3.5.0.3c (2026-05-24):** append the newly-assigned
        // id to the display-order overlay.  Sessions that never call
        // `Op::MoveSheet` see `sheet_display_order` == `0..sheet_count()`
        // -- preserving the V3.5.0.3b iteration-order contract.
        self.sheet_display_order.push(id as SheetId);
        Ok(id as SheetId)
    }

    pub fn sheet(&self, id: SheetId) -> Option<&Sheet> {
        self.sheets.get(id as usize)
    }

    pub fn sheet_mut(&mut self, id: SheetId) -> Option<&mut Sheet> {
        self.sheets.get_mut(id as usize)
    }

    /// **Phase 5.7 V3.5.0.3b (2026-05-24):** mark `id` as tombstoned.
    /// Idempotent (re-removing is a no-op).  Does NOT free the
    /// underlying `Sheet` storage -- the sheet stays at `sheets[id]`
    /// to preserve id stability for subsequent ops that reference it
    /// by id.
    ///
    /// **Out-of-range ids**: `id >= sheet_count()` is silently ignored
    /// (no error).  This matches CRDT idempotency: a peer that hasn't
    /// seen an `Op::AddSheet` might still see a peer's `Op::RemoveSheet`
    /// for that id; the local replay drops it.  Strict callers can
    /// pre-check via `id < sheet_count()`.
    ///
    /// Use [`Self::is_sheet_removed`] to check tombstone status.
    pub fn remove_sheet(&mut self, id: SheetId) {
        if (id as usize) < self.sheets.len() {
            self.removed_sheets.insert(id);
        }
    }

    /// **Phase 5.7 V3.5.0.3b (2026-05-24):** check if `id` is tombstoned.
    /// Returns `false` for ids that don't exist in `sheets` (out-of-range
    /// or never-created).
    pub fn is_sheet_removed(&self, id: SheetId) -> bool {
        self.removed_sheets.contains(&id)
    }

    /// **Phase 5.7 V3.6.0.10 D8 (2026-05-25):** un-tombstone `id`,
    /// reversing [`Self::remove_sheet`].  Idempotent: removing the id
    /// from `removed_sheets` when it wasn't tombstoned is a no-op.
    /// Out-of-range ids are silently dropped (matches the
    /// `remove_sheet` permissive semantic).
    ///
    /// **Cell preservation**: the V3.5.0.3b tombstone semantic
    /// preserves the underlying `Sheet` storage at `sheets[id]` --
    /// cells written before the tombstone are still there.  Restoring
    /// the sheet simply un-flags it; the cells reappear.  Cells
    /// written WHILE the sheet was tombstoned (via the silent-no-op
    /// guard in `Op::PutValue` etc. apply_op) DO NOT reappear --
    /// they were never written.  Documented as the V3.6.0.10 D8
    /// semantic contract.
    ///
    /// **Cross-peer convergence**: HashSet::remove on absent is a
    /// no-op; concurrent {RemoveSheet, RestoreSheet} produces the
    /// last-writer-wins outcome via Loro's causal-merge iteration
    /// order (matches the V3.5.0.3b idempotent-remove pattern).
    pub fn restore_sheet(&mut self, id: SheetId) {
        if (id as usize) < self.sheets.len() {
            self.removed_sheets.remove(&id);
        }
    }

    /// **Phase 5.7 V3.5.0.3c (2026-05-24):** reorder `id` to `new_index`
    /// in the display-order overlay.  Sheet ids themselves stay stable
    /// (preserving the V3.5.0.3b id-stability invariant); only the
    /// display order changes.
    ///
    /// **`new_index` clamping**: out-of-range values are clamped to
    /// `[0, display_order.len()]` (inclusive upper bound after the
    /// remove, equivalent to "append to end").  This matches the CRDT
    /// idempotency contract -- a peer racing two moves shouldn't get
    /// a hard error.
    ///
    /// **Idempotent if `id` not in display_order**: silently no-ops.
    /// Covers the rare cross-peer case where a peer sees `Op::MoveSheet`
    /// for an `id` whose `Op::AddSheet` hasn't replayed locally yet
    /// (Loro causal-merge eventually rectifies, but the strict-error
    /// path would break the merge).
    ///
    /// **Idempotent if `id` already at `new_index`**: silently no-ops
    /// (current_pos == new_index_clamped after the remove-then-insert
    /// dance; the data structure is unchanged).
    ///
    /// Use [`Self::sheet_display_order`] to inspect the current order.
    pub fn move_sheet(&mut self, id: SheetId, new_index: u32) {
        let current_pos = match self.sheet_display_order.iter().position(|&i| i == id) {
            Some(p) => p,
            None => return, // id not in display_order; silent no-op
        };
        self.sheet_display_order.remove(current_pos);
        // Clamp new_index to the new (post-remove) length.
        let clamped = (new_index as usize).min(self.sheet_display_order.len());
        self.sheet_display_order.insert(clamped, id);
    }

    /// **Phase 5.7 V3.5.0.3c (2026-05-24):** current display order.
    /// Default (no `Op::MoveSheet` applied): `[0, 1, ..., sheet_count()
    /// - 1]` in `Op::AddSheet` append order.  After `move_sheet` calls
    /// the order can be any permutation of the sheet ids.
    ///
    /// **May contain tombstoned ids**: callers iterating for display
    /// MUST filter via `is_sheet_removed(id)` (the napi `workbook_snapshot`
    /// does this at V3.5.0.3c ship; direct Rust callers must too).
    pub fn sheet_display_order(&self) -> &[SheetId] {
        &self.sheet_display_order
    }

    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====

    /// **W5-101 (Phase 4.7.H):** read access to the spill-anchor table.
    /// Production callers (runtime, calcgraph dep extraction in 4.7.I,
    /// persistence save-skip in 4.7.L) use this for lookups.
    pub fn spill_anchors(&self) -> &crate::SpillAnchorTable {
        &self.spill_anchors
    }

    /// **W5-101 (Phase 4.7.H):** convenience: is `(sheet, row, col)` an
    /// active spill anchor? Returns `Some(&shape)` iff yes. Delegates to
    /// `SpillAnchorTable::anchor_at`.
    pub fn spill_anchor_at(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
    ) -> Option<&crate::SpillShape> {
        self.spill_anchors.anchor_at(sheet, row, col)
    }

    /// **W5-101 (Phase 4.7.H):** reverse lookup — if `(sheet, row, col)`
    /// is a spill target (anchor or any non-anchor target cell), return
    /// the anchor. `O(1)`. Used by the runtime spill-invalidation path
    /// (4.7.K) on `set_value` to detect user writes into spill ranges.
    pub fn spill_target_anchor(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
    ) -> Option<(SheetId, RowId, ColId)> {
        self.spill_anchors.target_anchor(sheet, row, col)
    }

    /// **W5-101 (Phase 4.7.H):** register a new spill. Map-only — does
    /// NOT touch computed overlays. The runtime spill-writeback path
    /// (4.7.J) couples this with `put_computed_at` calls for each
    /// target cell value AFTER `register_spill` succeeds.
    pub fn register_spill(
        &mut self,
        anchor: (SheetId, RowId, ColId),
        shape: crate::SpillShape,
    ) -> Result<(), crate::SpillBlockError> {
        self.spill_anchors.register(anchor, shape)
    }

    /// **W5-101 (Phase 4.7.H):** workbook-layer convenience: unregister
    /// the anchor + clear the computed overlay at every target cell.
    /// This is the function the runtime calls during the "clear old
    /// spill before re-eval" step (design § 8.3) and when clearing a
    /// formula at an anchor cell (design § 10.3).
    ///
    /// Errors:
    /// - `SpillNotFoundError` — the cell isn't an anchor. Callers that
    ///   want a no-op-on-miss behavior should pre-check
    ///   `spill_anchor_at(...).is_some()`.
    pub fn clear_spill_at(
        &mut self,
        anchor: (SheetId, RowId, ColId),
    ) -> Result<(), crate::SpillNotFoundError> {
        let shape = self.spill_anchors.unregister(anchor)?;
        // Iterate the cleared rectangle and clear computed overlays.
        // This is the coupling reason `clear_spill_at` lives on
        // `Workbook` (which owns sheet access) rather than on the
        // map-only `SpillAnchorTable`.
        let (asheet, arow, acol) = anchor;
        if let Some(sheet) = self.sheets.get_mut(asheet as usize) {
            for dr in 0..shape.rows {
                for dc in 0..shape.cols {
                    sheet.clear_computed(arow + dr, acol + dc);
                }
            }
        }
        Ok(())
    }

    /// **W5-101-AUDIT (Codex LOW-3):** idempotent variant of
    /// `clear_spill_at`. Returns `true` if a spill was cleared, `false`
    /// if no anchor was registered at the cell. Friendlier API for the
    /// runtime spill-writeback path (Phase 4.7.J) which calls "clear
    /// before re-eval" regardless of whether a prior spill existed.
    /// Equivalent to `clear_spill_at(anchor).is_ok()` semantically.
    pub fn clear_spill_if_present(&mut self, anchor: (SheetId, RowId, ColId)) -> bool {
        self.clear_spill_at(anchor).is_ok()
    }

    /// Read by `Address`.
    ///
    /// - **Missing sheet** (sheet id ≥ `sheet_count()`) → `Value::Error(Ref)`
    ///   (Excel canon: `#REF!`).
    /// - **Within-sheet missing row/col** → `Value::Blank` (Excel canon: empty
    ///   cell coerces to 0 / "" / FALSE in arithmetic / text / logical
    ///   contexts).
    ///
    /// Phase 2A.13 audit cycle-3 M2: the prior implementation returned `Blank`
    /// for missing-sheet too, conflating "sheet deleted" with "empty cell."
    /// The Phase 2A.7 H6 fix corrected this at the evaluator layer
    /// (`ql-exec::WorkbookEnv::read_cell`); this commit aligns the storage
    /// layer's public read API. Any host code that bypasses `WorkbookEnv`
    /// (CLI tools, IDE inspectors, tests) now sees the same `#REF!` semantic.
    pub fn read(&self, addr: Address) -> Value {
        match self.sheet(addr.sheet) {
            Some(s) => s.read(addr.row, addr.col),
            None => Value::Error(ErrorValue::Ref),
        }
    }

    /// Write by `Address`. Panics if `addr.sheet` is out of bounds (callers must `add_sheet`
    /// first; this avoids implicit-sheet-creation silent bugs).
    pub fn put(&mut self, addr: Address, value: Value) {
        // Capture sheet_count before the mut-borrow so the panic path can use it.
        let total = self.sheet_count();
        match self.sheet_mut(addr.sheet) {
            Some(s) => s.put(addr.row, addr.col, value),
            None => panic!(
                "Workbook::put: sheet {} does not exist (have {})",
                addr.sheet, total
            ),
        }
    }

    /// Convenience: write a literal row,col,value tuple without constructing an Address.
    /// Phase 3.5: this is the USER-edit path — routes to `Sheet::put` →
    /// `ColumnStore::put` which writes the user overlay AND clears any stale computed
    /// entry at the same cell.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log AND the
    /// runtime's bind-plan cache; does NOT clear any pre-existing formula
    /// at the cell (use `clear_formula` separately if needed). Product code
    /// should route through `ql_exec::WorkbookRuntime::set_value`, which
    /// records `Op::PutValue` + an optional `Op::ClearFormula`. Direct
    /// `put_at` is for the qbook loader, the op-log replay path, runtime-
    /// internal pass 2 of formula recompute, and tests. GAP-O-03.
    pub fn put_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        self.put(Address::new(sheet, row, col), value);
    }

    /// **Phase 3.5 (2026-05-12) — CORR-25.** Write a FORMULA-OUTPUT value at
    /// `(sheet, row, col)`. Routes to the computed-overlay lane (NOT the user lane).
    /// Used by `WorkbookRuntime::set_formula` (with the freshly-evaluated result of
    /// the formula text) and by `recompute_all` / `recompute_dirty` for every
    /// formula cell in their pass.
    ///
    /// Panics if `sheet` is out of bounds — same contract as `put_at`. Does NOT touch
    /// the user overlay; if a cell is transitioning from "user-typed value" to
    /// "formula", the caller (the runtime) MUST first call `clear_user_at` so the
    /// stale user value doesn't mask the new computed value via the read cascade.
    pub fn put_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        let total = self.sheet_count();
        match self.sheet_mut(sheet) {
            Some(s) => s.put_computed(row, col, value),
            None => {
                panic!("Workbook::put_computed_at: sheet {sheet} does not exist (have {total})")
            }
        }
    }

    /// **Phase 3.5.** Drop the computed-overlay entry at `(sheet, row, col)`. No-op if
    /// the cell has no computed entry or the sheet is out of bounds. Called by
    /// `clear_formula` (the formula text is gone → its output is stale).
    pub fn clear_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        if let Some(s) = self.sheet_mut(sheet) {
            s.clear_computed(row, col);
        }
    }

    /// **Phase 3.5.** Drop the user-overlay entry at `(sheet, row, col)`. No-op if
    /// the cell has no user entry or the sheet is out of bounds. Called by the runtime's
    /// `set_formula` to clear a stale user value before writing the new computed
    /// formula output.
    pub fn clear_user_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        if let Some(s) = self.sheet_mut(sheet) {
            s.clear_user(row, col);
        }
    }

    /// Phase 1 W5-9: record formula source text for a cell. The caller is responsible
    /// for evaluating the formula and storing the result via `put`/`put_at` — this
    /// method just persists the formula association. Pass an empty string or omit the
    /// call to mark a cell as literal-only.
    ///
    /// `formula` is the formula body WITHOUT the leading `=` (matching Excel's
    /// canonical AST representation).
    ///
    /// Phase 2A.13 audit cycle-3 H2: panics if `sheet >= sheet_count()`, `row >
    /// MAX_ROW`, or `col > MAX_COLUMN`. The prior implementation accepted any
    /// (sheet, row, col), making `validate_cell` at the runtime/transaction layer
    /// bypassable: a `formula_cells` entry with an out-of-bounds coord would
    /// later panic deep inside `Sheet::put` during `recompute_all`'s
    /// `put_at`. Matching the storage-layer convention from `Sheet::put` and
    /// `Workbook::put_at` (which also panic on invariant violation), the
    /// in-process programmer-error path stays loud. Trust-boundary callers
    /// (ql-io loader, IDE host) MUST validate before reaching here.
    pub fn put_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula: impl Into<Arc<str>>,
    ) {
        assert!(
            (sheet as usize) < self.sheets.len(),
            "Workbook::put_formula: sheet {sheet} does not exist (have {})",
            self.sheets.len()
        );
        assert!(
            row <= ql_types::MAX_ROW,
            "Workbook::put_formula: row {row} exceeds MAX_ROW {}",
            ql_types::MAX_ROW
        );
        assert!(
            col <= ql_types::MAX_COLUMN,
            "Workbook::put_formula: col {col} exceeds MAX_COLUMN {}",
            ql_types::MAX_COLUMN
        );
        self.formula_cells.insert((sheet, row, col), formula.into());
    }

    /// Remove any formula association for a cell. Used when a formula cell becomes a
    /// literal (e.g. user types over the formula with a value). Idempotent: removing
    /// a non-existent entry is a no-op.
    ///
    /// Phase 3.5 (CORR-25): ALSO drops any computed-overlay entry at this cell. A
    /// cell without a formula text has no business carrying a formula output; the
    /// invariant the rest of the engine relies on is "computed overlay populated ⇒
    /// formula text present", and `clear_formula` is the only path that breaks the
    /// formula→computed pair, so the storage layer enforces both sides here.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log. Use
    /// `ql_exec::WorkbookRuntime::clear_formula` to record `Op::ClearFormula`
    /// in an attached log. GAP-O-03.
    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        self.formula_cells.remove(&(sheet, row, col));
        self.clear_computed_at(sheet, row, col);
    }

    /// Borrow the formula source for a cell, if it has one.
    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
        self.formula_cells.get(&(sheet, row, col))
    }

    /// Count of formula cells across the workbook.
    pub fn formula_count(&self) -> usize {
        self.formula_cells.len()
    }

    /// Iterate every formula cell as `(sheet, row, col, formula)`. Iteration order is
    /// HashMap-arbitrary; callers that need determinism (qbook save) should sort first.
    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
        self.formula_cells
            .iter()
            .map(|((s, r, c), f)| (*s, *r, *c, f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::ErrorValue;

    #[test]
    fn empty_workbook_has_no_sheets() {
        let wb = Workbook::new();
        assert_eq!(wb.sheet_count(), 0);
        assert!(wb.sheet(0).is_none());
        // Phase 2A.13 audit cycle-3 M2: read out-of-bounds sheet → #REF!
        // (was: Blank). Aligns the storage-layer public read API with
        // `WorkbookEnv::read_cell` per Excel canon.
        assert_eq!(
            wb.read(Address::new(0, 0, 0)),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn add_sheet_returns_zero_based_id() {
        let mut wb = Workbook::new();
        let id0 = wb.add_sheet("Sheet1");
        assert_eq!(id0, 0);
        let id1 = wb.add_sheet("Sheet2");
        assert_eq!(id1, 1);
        assert_eq!(wb.sheet_count(), 2);
        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet1");
        assert_eq!(wb.sheet(1).unwrap().name(), "Sheet2");
    }

    #[test]
    fn put_then_read_across_sheets() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let s1 = wb.add_sheet("S1");
        wb.put_at(s0, 0, 0, Value::Number(1.0));
        wb.put_at(s1, 0, 0, Value::Number(99.0));
        // Each sheet maintains its own cells.
        assert_eq!(wb.read(Address::new(s0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(Address::new(s1, 0, 0)), Value::Number(99.0));
    }

    #[test]
    fn sheets_are_isolated() {
        let mut wb = Workbook::new();
        let a = wb.add_sheet_with_chunk_rows("A", 4);
        let b = wb.add_sheet_with_chunk_rows("B", 4);
        wb.put_at(a, 5, 3, Value::Number(50.0));
        // Sheet B at the same coords reads Blank.
        assert_eq!(wb.read(Address::new(b, 5, 3)), Value::Blank);
        // Sheet A keeps the value.
        assert_eq!(wb.read(Address::new(a, 5, 3)), Value::Number(50.0));
    }

    #[test]
    fn names_lookup_on_empty_table_returns_none() {
        let wb = Workbook::new();
        assert!(wb.names().lookup("MyName").is_none());
        assert!(wb.names().lookup_ci("MyName").is_none());
    }

    /// Phase 2A.6 audit M6/D5 (2026-05-12): `NameTable::set` canonicalizes
    /// (uppercases) the key on insert, so a raw `NameTable::set("mixedCase",
    /// target)` and `Workbook::set_name("MIXEDCASE", target)` produce the same
    /// canonical entry. Pin both paths through both `lookup` (case-sensitive
    /// on canonical form) and `lookup_ci` (case-insensitive query).
    #[test]
    fn name_table_set_canonicalizes_key_on_insert() {
        let mut wb = Workbook::new();
        let target = NamedTarget::Constant(Value::Number(0.21));

        // Path A: raw NameTable::set with mixed case.
        wb.names_mut().set("MixedCase", target.clone()).unwrap();
        // Case-sensitive lookup on the canonical (upper) form succeeds.
        assert!(wb.names().lookup("MIXEDCASE").is_some());
        // The mixed-case query does NOT find it via plain lookup …
        assert!(wb.names().lookup("MixedCase").is_none());
        // … but lookup_ci uppercases the query and does.
        assert!(wb.names().lookup_ci("MixedCase").is_some());
        assert!(wb.names().lookup_ci("mixedcase").is_some());

        // Path B: convenience set_name accepts any case and produces the same
        // canonical entry.
        wb.set_name("anothername", target.clone()).unwrap();
        assert!(wb.names().lookup("ANOTHERNAME").is_some());

        // Path C: clear removes via case-insensitive query.
        wb.names_mut().clear("MIXEDCASE");
        assert!(wb.names().lookup_ci("MixedCase").is_none());
        wb.names_mut().clear("anothername");
        assert!(wb.names().lookup_ci("anothername").is_none());
    }

    #[test]
    fn named_target_variants_distinct() {
        // Lock the enum shape for forward compatibility (codex r13 N9 / opus arch F5).
        let cell = NamedTarget::Cell(Address::new(0, 0, 0));
        let rng = NamedTarget::Range(ql_types::Range::new(0, 0, 0, 9, 0));
        let con = NamedTarget::Constant(Value::Number(0.21));
        let frm = NamedTarget::Formula(std::sync::Arc::from("=A1+B1"));
        assert_ne!(cell, rng);
        assert_ne!(cell, con);
        assert_ne!(cell, frm);
        assert_ne!(rng, con);
        assert_ne!(rng, frm);
        assert_ne!(con, frm);
    }

    #[test]
    #[should_panic(expected = "sheet 5 does not exist")]
    fn put_to_missing_sheet_panics() {
        let mut wb = Workbook::new();
        wb.add_sheet("only-sheet");
        wb.put_at(5, 0, 0, Value::Number(1.0));
    }

    // ===== Phase 2A.13 audit cycle-3 H2: put_formula bounds checks =====

    #[test]
    #[should_panic(expected = "Workbook::put_formula: sheet 5 does not exist")]
    fn put_formula_to_missing_sheet_panics() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.put_formula(5, 0, 0, "A1 + 1");
    }

    #[test]
    #[should_panic(expected = "Workbook::put_formula: row 1048576 exceeds MAX_ROW")]
    fn put_formula_above_max_row_panics() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.put_formula(0, 1_048_576, 0, "A1 + 1");
    }

    #[test]
    #[should_panic(expected = "Workbook::put_formula: col 16384 exceeds MAX_COLUMN")]
    fn put_formula_above_max_col_panics() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.put_formula(0, 0, 16_384, "A1 + 1");
    }

    #[test]
    fn put_formula_at_max_row_max_col_ok() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.put_formula(0, 1_048_575, 16_383, "boundary");
        assert_eq!(
            wb.formula_at(0, 1_048_575, 16_383).map(|s| s.as_ref()),
            Some("boundary")
        );
    }

    #[test]
    fn heterogeneous_workbook_state() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet_with_chunk_rows("S", 4);
        for (r, v) in [
            Value::Number(1.0),
            Value::Boolean(true),
            Value::text("hi"),
            Value::Error(ErrorValue::Ref),
            Value::Error(ErrorValue::AINotAvailable),
            Value::Blank,
        ]
        .into_iter()
        .enumerate()
        {
            wb.put_at(s, r as u32, 0, v);
        }
        assert_eq!(wb.read(Address::new(s, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(Address::new(s, 1, 0)), Value::Boolean(true));
        assert_eq!(wb.read(Address::new(s, 2, 0)), Value::text("hi"));
        assert_eq!(
            wb.read(Address::new(s, 3, 0)),
            Value::Error(ErrorValue::Ref)
        );
        assert_eq!(
            wb.read(Address::new(s, 4, 0)),
            Value::Error(ErrorValue::AINotAvailable)
        );
        assert_eq!(wb.read(Address::new(s, 5, 0)), Value::Blank);
    }

    // ===== W5-9: formula_cells =====

    #[test]
    fn formula_cells_default_empty() {
        let wb = Workbook::new();
        assert_eq!(wb.formula_count(), 0);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn put_and_get_formula() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 0, 0, "A1 + B1");
        assert_eq!(wb.formula_count(), 1);
        assert_eq!(wb.formula_at(s, 0, 0).map(|s| s.as_ref()), Some("A1 + B1"));
        assert!(wb.formula_at(s, 0, 1).is_none());
    }

    #[test]
    fn clear_formula_removes_entry() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 0, 0, "A1 + 1");
        wb.clear_formula(s, 0, 0);
        assert_eq!(wb.formula_count(), 0);
        assert!(wb.formula_at(s, 0, 0).is_none());
    }

    #[test]
    fn clear_nonexistent_formula_is_noop() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        // No panic; idempotent.
        wb.clear_formula(0, 5, 5);
        assert_eq!(wb.formula_count(), 0);
    }

    #[test]
    fn put_formula_replaces_existing() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 0, 0, "A1 + 1");
        wb.put_formula(s, 0, 0, "B1 * 2");
        assert_eq!(wb.formula_count(), 1);
        assert_eq!(wb.formula_at(s, 0, 0).map(|s| s.as_ref()), Some("B1 * 2"));
    }

    #[test]
    fn iter_formulas_yields_all() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_formula(s, 0, 0, "f1");
        wb.put_formula(s, 1, 0, "f2");
        wb.put_formula(s, 5, 3, "f3");
        let mut items: Vec<_> = wb
            .iter_formulas()
            .map(|(sh, r, c, f)| (sh, r, c, f.as_ref().to_owned()))
            .collect();
        items.sort();
        assert_eq!(
            items,
            vec![
                (s, 0, 0, "f1".to_owned()),
                (s, 1, 0, "f2".to_owned()),
                (s, 5, 3, "f3".to_owned()),
            ]
        );
    }

    #[test]
    fn formula_and_value_coexist_on_same_cell() {
        // A formula cell ALSO holds an evaluated value in the Sheet's columnar storage.
        // The caller (or future runtime) is responsible for keeping them consistent.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_formula(s, 0, 0, "A1 + 1");
        // Both visible.
        assert_eq!(wb.read(Address::new(s, 0, 0)), Value::Number(42.0));
        assert_eq!(wb.formula_at(s, 0, 0).map(|s| s.as_ref()), Some("A1 + 1"));
    }

    // ===== Phase 2A.9 audit M6: reserved-name rejection =====

    /// `Workbook::set_name("AI", ...)` is refused — the AI sentinel per
    /// CORR-06 can't be overridden by a user-defined name.
    #[test]
    fn set_name_rejects_reserved_ai_canonical_upper() {
        let mut wb = Workbook::new();
        let result = wb.set_name("AI", NamedTarget::Constant(Value::Number(42.0)));
        match result {
            Err(NameTableError::Reserved(name)) => assert_eq!(name.as_ref(), "AI"),
            other => panic!("expected Reserved(AI), got {other:?}"),
        }
        // NameTable remains empty.
        assert!(wb.names().is_empty());
    }

    /// Case-insensitive: `Workbook::set_name("ai", ...)` also refused (the
    /// uppercase-on-insert step canonicalizes before checking reservation).
    #[test]
    fn set_name_rejects_reserved_ai_case_insensitive() {
        let mut wb = Workbook::new();
        let result = wb.set_name("ai", NamedTarget::Constant(Value::Number(42.0)));
        assert!(matches!(result, Err(NameTableError::Reserved(_))));
        let result_mixed = wb.set_name("Ai", NamedTarget::Constant(Value::Number(42.0)));
        assert!(matches!(result_mixed, Err(NameTableError::Reserved(_))));
    }

    /// Non-reserved names succeed as before.
    #[test]
    fn set_name_accepts_non_reserved() {
        let mut wb = Workbook::new();
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        assert!(wb.names().lookup("TAXRATE").is_some());
    }

    // ===== W5-86 / Phase 4.6.AA — sheet registry + canonicalizer =====

    #[test]
    fn canonical_sheet_name_uppercases_ascii() {
        assert_eq!(Workbook::canonical_sheet_name("Sheet1"), "SHEET1");
        assert_eq!(Workbook::canonical_sheet_name("sheet1"), "SHEET1");
        assert_eq!(Workbook::canonical_sheet_name("SHEET1"), "SHEET1");
    }

    #[test]
    fn canonical_sheet_name_passes_non_ascii_through() {
        // V1 simplification: ASCII-only uppercasing; non-ASCII letters
        // stay as-is. `Café` and `café` canonicalize to different forms.
        // Documented as a known V1 simplification.
        assert_eq!(Workbook::canonical_sheet_name("Café"), "CAFé");
    }

    #[test]
    fn sheet_id_by_name_finds_case_insensitive() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Inventory");
        let s1 = wb.add_sheet("Q3 2025");
        assert_eq!(wb.sheet_id_by_name("Inventory"), Some(s0));
        assert_eq!(wb.sheet_id_by_name("inventory"), Some(s0));
        assert_eq!(wb.sheet_id_by_name("INVENTORY"), Some(s0));
        assert_eq!(wb.sheet_id_by_name("Q3 2025"), Some(s1));
        assert_eq!(wb.sheet_id_by_name("q3 2025"), Some(s1));
    }

    #[test]
    fn sheet_id_by_name_returns_none_on_miss() {
        let mut wb = Workbook::new();
        wb.add_sheet("S1");
        assert_eq!(wb.sheet_id_by_name("S2"), None);
        assert_eq!(wb.sheet_id_by_name(""), None);
    }

    #[test]
    fn sheet_id_by_name_first_match_in_id_order() {
        // Duplicates are caught at add time via `validate_sheet_name`, but
        // if a workbook somehow has two sheets with the same canonical
        // name (e.g. loaded from a corrupted .qbook), `sheet_id_by_name`
        // returns the FIRST in id order.
        let mut wb = Workbook::new();
        // Bypass validation to construct the test fixture.
        let s0 = wb.add_sheet("Test");
        wb.sheets.push(Sheet::new("test")); // Same canonical form.
        let s1: SheetId = (wb.sheet_count() - 1) as SheetId;
        assert_eq!(wb.sheet_id_by_name("test"), Some(s0));
        // Confirm both exist.
        assert!(wb.sheet(s0).is_some());
        assert!(wb.sheet(s1).is_some());
    }

    #[test]
    fn validate_sheet_name_rejects_empty() {
        let wb = Workbook::new();
        assert_eq!(wb.validate_sheet_name(""), Err(SheetNameError::Empty));
    }

    #[test]
    fn validate_sheet_name_rejects_excel_reserved_characters() {
        let wb = Workbook::new();
        for c in [':', '\\', '/', '?', '*', '[', ']'] {
            let name = format!("S{c}1");
            let result = wb.validate_sheet_name(&name);
            assert_eq!(
                result,
                Err(SheetNameError::ReservedCharacter(c)),
                "expected ReservedCharacter({c:?}) for {name:?}, got {result:?}"
            );
        }
    }

    #[test]
    fn validate_sheet_name_rejects_canonical_duplicate() {
        let mut wb = Workbook::new();
        wb.add_sheet("Inventory");
        assert_eq!(
            wb.validate_sheet_name("Inventory"),
            Err(SheetNameError::Duplicate {
                name: "Inventory".to_owned()
            })
        );
        // Case-insensitive duplicate also rejected.
        assert_eq!(
            wb.validate_sheet_name("inventory"),
            Err(SheetNameError::Duplicate {
                name: "inventory".to_owned()
            })
        );
        assert_eq!(
            wb.validate_sheet_name("INVENTORY"),
            Err(SheetNameError::Duplicate {
                name: "INVENTORY".to_owned()
            })
        );
    }

    #[test]
    fn validate_sheet_name_accepts_valid_names() {
        let mut wb = Workbook::new();
        wb.add_sheet("Already_Exists");
        // Various non-conflicting valid names.
        assert!(wb.validate_sheet_name("Sheet1").is_ok());
        assert!(wb.validate_sheet_name("Q3 2025").is_ok());
        assert!(wb.validate_sheet_name("Data.csv").is_ok()); // dot is OK
        assert!(wb.validate_sheet_name("a").is_ok());
        assert!(wb.validate_sheet_name("Café").is_ok()); // Unicode OK
                                                         // Reserved-char rejection takes precedence over duplicate check.
                                                         // (Order is: empty → reserved-char → duplicate.)
    }

    #[test]
    fn validate_sheet_name_reserved_chars_anywhere_in_name_rejected() {
        let wb = Workbook::new();
        assert!(matches!(
            wb.validate_sheet_name("S1:Sheet"),
            Err(SheetNameError::ReservedCharacter(':'))
        ));
        assert!(matches!(
            wb.validate_sheet_name("ends_with*"),
            Err(SheetNameError::ReservedCharacter('*'))
        ));
        assert!(matches!(
            wb.validate_sheet_name("?starts_with"),
            Err(SheetNameError::ReservedCharacter('?'))
        ));
    }

    // W5-91 (Phase 4.6.C) — rename_sheet coverage.

    #[test]
    fn rename_sheet_basic_swaps_name() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        wb.rename_sheet(s0, "Renamed").unwrap();
        assert_eq!(wb.sheet(s0).unwrap().name(), "Renamed");
        assert_eq!(wb.sheet_id_by_name("Renamed"), Some(s0));
        assert_eq!(wb.sheet_id_by_name("renamed"), Some(s0));
        assert_eq!(wb.sheet_id_by_name("Sheet1"), None);
    }

    #[test]
    fn rename_sheet_case_only_rename_allowed() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        // Same canonical key ⇒ duplicate-check skipped, name still updates.
        wb.rename_sheet(s0, "SHEET1").unwrap();
        assert_eq!(wb.sheet(s0).unwrap().name(), "SHEET1");
        assert_eq!(wb.sheet_id_by_name("sheet1"), Some(s0));
    }

    #[test]
    fn rename_sheet_duplicate_target_rejected() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        let _ = wb.add_sheet("Sheet2");
        let err = wb.rename_sheet(s0, "sheet2").unwrap_err();
        assert!(matches!(err, SheetNameError::Duplicate { .. }));
        // Original name preserved on failure.
        assert_eq!(wb.sheet(s0).unwrap().name(), "Sheet1");
    }

    #[test]
    fn rename_sheet_empty_rejected() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Sheet1");
        assert!(matches!(
            wb.rename_sheet(s0, ""),
            Err(SheetNameError::Empty)
        ));
        assert_eq!(wb.sheet(s0).unwrap().name(), "Sheet1");
    }

    #[test]
    fn rename_sheet_unknown_id_errors() {
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("Sheet1");
        // SheetId 7 doesn't exist — surfaces as Duplicate carrying a
        // synthetic name. (The runtime layer surfaces InvalidSheet
        // via its own pre-check before calling this.)
        let err = wb.rename_sheet(7, "Other").unwrap_err();
        assert!(matches!(err, SheetNameError::Duplicate { .. }));
    }

    // W5-93 (Phase 4.6.E closure) — sheet-name validation at add_sheet path.

    #[test]
    fn try_add_sheet_rejects_canonical_duplicate() {
        // Codex HIGH-1: pre-W5-93 the storage layer silently accepted
        // duplicate-canonical names like `Sheet1` + `SHEET1`. Now the
        // fallible variant surfaces a clean error.
        let mut wb = Workbook::new();
        wb.try_add_sheet_with_chunk_rows("Sheet1", 16).unwrap();
        let err = wb.try_add_sheet_with_chunk_rows("SHEET1", 16).unwrap_err();
        assert!(matches!(err, SheetNameError::Duplicate { .. }));
        assert_eq!(wb.sheet_count(), 1);
    }

    #[test]
    fn try_add_sheet_rejects_reserved_char() {
        let mut wb = Workbook::new();
        let err = wb
            .try_add_sheet_with_chunk_rows("Bad:Sheet", 16)
            .unwrap_err();
        assert!(matches!(err, SheetNameError::ReservedCharacter(':')));
        assert_eq!(wb.sheet_count(), 0);
    }

    #[test]
    fn try_add_sheet_rejects_empty_name() {
        let mut wb = Workbook::new();
        let err = wb.try_add_sheet_with_chunk_rows("", 16).unwrap_err();
        assert!(matches!(err, SheetNameError::Empty));
        assert_eq!(wb.sheet_count(), 0);
    }

    #[test]
    #[should_panic(expected = "name validation failed")]
    fn add_sheet_panics_on_duplicate() {
        // The infallible wrapper panics with a clear message rather
        // than silently producing a corrupt workbook. Closes Codex
        // HIGH-1 at the test-friendly path.
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        wb.add_sheet("Sheet1"); // panics here
    }

    // ===== W5-101 (Phase 4.7.H) Workbook spill-anchor integration =====

    #[test]
    fn workbook_register_spill_round_trip() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        // Register a 2x3 spill at (0, 1, 1) — covers B2:D3.
        wb.register_spill((0, 1, 1), crate::SpillShape::new(2, 3))
            .unwrap();
        assert_eq!(
            wb.spill_anchor_at(0, 1, 1),
            Some(&crate::SpillShape::new(2, 3))
        );
        // Reverse lookup at every target cell.
        for dr in 0..2 {
            for dc in 0..3 {
                assert_eq!(
                    wb.spill_target_anchor(0, 1 + dr, 1 + dc),
                    Some((0, 1, 1)),
                    "cell ({},{}) → anchor (0,1,1)",
                    1 + dr,
                    1 + dc
                );
            }
        }
    }

    #[test]
    fn workbook_clear_spill_at_clears_computed_overlays() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        // Register a 1x3 spill at (0, 0, 0) covering A1:C1.
        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
            .unwrap();
        // Simulate the runtime writing computed values at each target.
        wb.put_computed_at(0, 0, 0, Value::Number(10.0));
        wb.put_computed_at(0, 0, 1, Value::Number(20.0));
        wb.put_computed_at(0, 0, 2, Value::Number(30.0));
        // Sanity: reads return the computed values.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(10.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(20.0));
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(30.0));
        // clear_spill_at: unregisters AND clears overlays at every target.
        wb.clear_spill_at((0, 0, 0)).unwrap();
        // Anchor + targets gone from the table.
        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
        assert!(wb.spill_target_anchor(0, 0, 1).is_none());
        // Reads now fall through to Blank (computed overlay cleared).
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Blank);
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Blank);
    }

    #[test]
    fn workbook_register_spill_rejects_collision_with_existing() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.register_spill((0, 0, 0), crate::SpillShape::new(3, 1))
            .unwrap();
        // Second spill at (0, 1, 0) would overlap A2/A3 of the first.
        let err = wb
            .register_spill((0, 1, 0), crate::SpillShape::new(3, 1))
            .unwrap_err();
        assert!(matches!(
            err,
            crate::SpillBlockError::TargetCellOccupied { .. }
        ));
    }

    #[test]
    fn workbook_clear_spill_at_unknown_anchor_errors() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        let err = wb.clear_spill_at((0, 5, 5)).unwrap_err();
        assert_eq!(err.row, 5);
        assert_eq!(err.col, 5);
    }

    #[test]
    fn workbook_clear_spill_at_preserves_user_overlays_outside_rectangle() {
        // A user-typed value outside the spill rectangle must survive
        // clear_spill_at. Verifies the clear loop is bounded to the
        // shape rectangle.
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
            .unwrap();
        wb.put_computed_at(0, 0, 0, Value::Number(1.0));
        wb.put_computed_at(0, 0, 1, Value::Number(2.0));
        wb.put_computed_at(0, 0, 2, Value::Number(3.0));
        // User value at A2 (row 1, col 0) — OUTSIDE the 1x3 spill.
        wb.put_at(0, 1, 0, Value::Number(99.0));
        wb.clear_spill_at((0, 0, 0)).unwrap();
        // Spill range cleared.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
        // User value at A2 untouched.
        assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Number(99.0));
    }

    #[test]
    fn workbook_spill_anchors_accessor_returns_table() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        assert_eq!(wb.spill_anchors().len(), 0);
        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 2))
            .unwrap();
        wb.register_spill((0, 5, 5), crate::SpillShape::new(1, 1))
            .unwrap();
        assert_eq!(wb.spill_anchors().len(), 2);
    }

    // ===== W5-101-AUDIT (Codex LOW-3) — clear_spill_if_present =====

    #[test]
    fn workbook_clear_spill_if_present_returns_true_when_cleared() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 1))
            .unwrap();
        let cleared = wb.clear_spill_if_present((0, 0, 0));
        assert!(cleared);
        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
    }

    #[test]
    fn workbook_clear_spill_if_present_returns_false_when_missing() {
        // Idempotent: calling on a non-anchor is a no-op + returns false.
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        let cleared = wb.clear_spill_if_present((0, 5, 5));
        assert!(!cleared);
    }

    #[test]
    fn workbook_clear_spill_at_clears_anchor_own_computed_overlay() {
        // Sonnet-anticipated test: verify the anchor cell itself
        // (the (0,0) of its own spill range) gets its computed
        // overlay cleared.
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 1))
            .unwrap();
        wb.put_computed_at(0, 0, 0, Value::Number(42.0));
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(42.0));
        wb.clear_spill_at((0, 0, 0)).unwrap();
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    // ===== W5-133 (Phase 4.9.A) — reference_mode + locale accessors =====

    #[test]
    fn workbook_default_reference_mode_is_a1() {
        let wb = Workbook::new();
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::A1);
    }

    #[test]
    fn workbook_default_locale_is_en_us() {
        let wb = Workbook::new();
        assert_eq!(wb.locale(), ql_types::Locale::EnUs);
    }

    #[test]
    fn workbook_set_reference_mode_round_trips() {
        let mut wb = Workbook::new();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        wb.set_reference_mode(ql_types::ReferenceMode::A1);
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::A1);
    }

    #[test]
    fn workbook_set_locale_round_trips_all_variants() {
        let mut wb = Workbook::new();
        for locale in [
            ql_types::Locale::EnUs,
            ql_types::Locale::De,
            ql_types::Locale::Fr,
        ] {
            wb.set_locale(locale);
            assert_eq!(wb.locale(), locale);
        }
    }

    /// Setting reference_mode + locale together — neither setter
    /// clobbers the other (they're independent fields).
    #[test]
    fn workbook_reference_mode_and_locale_are_independent() {
        let mut wb = Workbook::new();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        wb.set_locale(ql_types::Locale::De);
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        assert_eq!(wb.locale(), ql_types::Locale::De);
        wb.set_reference_mode(ql_types::ReferenceMode::A1);
        // Locale unchanged.
        assert_eq!(wb.locale(), ql_types::Locale::De);
    }
}
