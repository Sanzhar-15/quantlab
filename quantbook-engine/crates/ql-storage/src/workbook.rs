//! `Workbook` — top-level container; holds the sheet list + the name table.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - `sheets: Vec<Sheet>` indexed by `SheetId` (u16).
//! - `names: NameTable` — workbook-level defined names. Phase 2A.1 (2026-05-12)
//!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
//!   binder in `ql-exec` resolves names against this table at bind time.
//!   Sheet-scope names land Phase 3+ with `ql-formula-semantics`.

use std::collections::HashMap;
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
pub enum NameTableError {
    /// The name is reserved by the engine. Per CORR-06: `AI`. Future
    /// reservations belong in `is_reserved_name` below.
    #[error("name {0:?} is reserved by the engine and cannot be registered")]
    Reserved(Arc<str>),
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
        self.entries.insert(upper, target);
        // Phase 2B.3: bump generation so bind-plan caches keyed by the prior
        // generation miss on next lookup. wrapping_add so we never panic on
        // u64::MAX (practically unreachable but defensive).
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

    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    pub fn names(&self) -> &NameTable {
        &self.names
    }

    /// Mutable access to the name table. Phase 2A.1 (2026-05-12) addition for
    /// runtime registration of defined names.
    pub fn names_mut(&mut self) -> &mut NameTable {
        &mut self.names
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
    pub fn add_sheet(&mut self, name: impl Into<String>) -> SheetId {
        let id = self.sheets.len();
        assert!(
            id < SheetId::MAX as usize,
            "too many sheets (max {}, current {})",
            SheetId::MAX as usize,
            id
        );
        self.sheets.push(Sheet::new(name));
        id as SheetId
    }

    /// Add a sheet with an explicit chunk size. Used by tests AND by ql-io
    /// (W5-6 `load_workbook`) to reconstruct sheets at the saved chunk layout.
    /// Audit L7 fix (2026-05-12): doc previously said "test-only" but production
    /// code calls this.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log. Use
    /// `ql_exec::WorkbookRuntime::add_sheet` for op-log-recording sheet
    /// creation. The qbook loader calls this directly because op-log
    /// reconstruction is the loader's job (it replays the saved
    /// `oplog.bin`), not this method's. GAP-O-02.
    pub fn add_sheet_with_chunk_rows(
        &mut self,
        name: impl Into<String>,
        chunk_rows: u32,
    ) -> SheetId {
        let id = self.sheets.len();
        assert!(
            id < SheetId::MAX as usize,
            "too many sheets (max {})",
            SheetId::MAX as usize
        );
        self.sheets.push(Sheet::with_chunk_rows(name, chunk_rows));
        id as SheetId
    }

    pub fn sheet(&self, id: SheetId) -> Option<&Sheet> {
        self.sheets.get(id as usize)
    }

    pub fn sheet_mut(&mut self, id: SheetId) -> Option<&mut Sheet> {
        self.sheets.get_mut(id as usize)
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
}
