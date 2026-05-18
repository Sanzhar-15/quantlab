//! Hybrid xlsx reader: calamine grid + targeted OOXML scanner.
//!
//! **W5-D-14a (this commit):** minimal viable hybrid — calamine grid
//! only. OOXML scanner submodules (workbook_xml, styles_xml,
//! tables_xml, defined_names, etc.) land in subsequent W5-D-14
//! commits per the plan in `.plans/_active.md`.

pub(crate) mod calamine_grid;
pub(crate) mod convert;
