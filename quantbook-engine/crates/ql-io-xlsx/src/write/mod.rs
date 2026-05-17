//! xlsx writer behind a backend boundary.
//!
//! **Phase 4.11 W5-D-14 — scaffolding.** Two backends planned:
//! - `umya_roundtrip` (W5-D-14): `ExportMode::UpdateOriginal` mode;
//!   loads the preserved original xlsx package and patches it.
//! - `generated` (W5-D-17): `ExportMode::NewWorkbook` mode;
//!   generates a clean package from engine state via rust_xlsxwriter.
//!
//! The backend boundary is defined at the public-API level (the
//! `ExportMode` enum). Each backend submodule has its own private
//! interface; the public surface stays stable.
