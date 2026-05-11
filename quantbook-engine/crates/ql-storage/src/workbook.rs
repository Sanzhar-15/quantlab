//! `Workbook` — top-level container; holds the sheet list + the name table.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - `sheets: Vec<Sheet>` indexed by `SheetId` (u16).
//! - `names: NameTable` — workbook-level defined names. Phase 0 ships an empty stub; full
//!   resolution + scoping lands with `ql-formula-semantics` in Week 2 Day 6+.

use ql_types::{Address, ColId, Range, RowId, SheetId, Value};

use crate::sheet::Sheet;

/// What a defined name resolves to.
///
/// Per codex r13 N9 + opus arch F5: the prior `lookup -> Option<Address>` couldn't represent
/// the common Excel defined-name targets (range, constant, formula). The shape was a wrong
/// stub that would force a breaking change in Week 3 ql-calcgraph binding. Widening to the
/// enum NOW is non-breaking later — calcgraph callers pattern-match on the variant they need.
///
/// Phase 0 ships ALL variants for forward compatibility but the table is empty (NameTable
/// always returns `None`); Week 3 ql-calcgraph + Phase 3 ql-formula-semantics will populate.
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

/// Defined-names table. Phase 0 stub — `lookup` always returns `None`. Sheet-scope vs
/// workbook-scope names arrive with `ql-formula-semantics` in Week 2 Days 6+.
#[derive(Clone, Debug, Default)]
pub struct NameTable {
    // Reserved; entries Vec or HashMap will land when Phase 3+ binding work needs it.
    _phantom: (),
}

impl NameTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Phase 0 never resolves names — every lookup returns `None`. The signature is locked
    /// so future expansion is non-breaking (calcgraph callers can pattern-match on
    /// `NamedTarget` variants now).
    pub fn lookup(&self, _name: &str) -> Option<NamedTarget> {
        None
    }
}

/// Top-level Quantbook container.
#[derive(Clone, Debug, Default)]
pub struct Workbook {
    sheets: Vec<Sheet>,
    names: NameTable,
}

impl Workbook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    pub fn names(&self) -> &NameTable {
        &self.names
    }

    /// Append a new sheet; returns its `SheetId`. Panics if the next ID would exceed
    /// `SheetId::MAX` (65,535). Excel allows ≤255 sheets in practice; we cap at the type
    /// limit so the ID always fits the field.
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

    /// Add a sheet with an explicit chunk size — test-only convenience.
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

    /// Read by `Address`. Out-of-bounds sheet/row/col reads as `Value::Blank`.
    pub fn read(&self, addr: Address) -> Value {
        match self.sheet(addr.sheet) {
            Some(s) => s.read(addr.row, addr.col),
            None => Value::Blank,
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
    pub fn put_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        self.put(Address::new(sheet, row, col), value);
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
        // Read out-of-bounds sheet → Blank.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
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
    fn names_lookup_is_phase0_stub() {
        let wb = Workbook::new();
        assert!(wb.names().lookup("MyName").is_none());
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
}
