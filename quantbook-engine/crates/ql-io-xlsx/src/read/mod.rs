//! Hybrid xlsx reader: calamine grid + targeted OOXML scanner.
//!
//! **W5-D-14a:** calamine grid path live.
//! **W5-D-14b (this commit):** OOXML scanner foundation — package
//! index + `xl/workbook.xml` parser (date1904 + sheet metadata +
//! scoped defined names) + feature-inventory detection.

pub(crate) mod calamine_grid;
pub(crate) mod convert;
pub(crate) mod feature_inventory;
pub(crate) mod package;
pub(crate) mod rels;
pub(crate) mod styles_import;
pub(crate) mod styles_xml;
pub(crate) mod tables_import;
pub(crate) mod tables_xml;
pub(crate) mod workbook_xml;
