//! xlsx writer behind a backend boundary.
//!
//! **W5-D-14e (this commit):** `umya_export` writes `NewWorkbook`
//! mode (generate fresh xlsx from Quantbook state). Cells + formula
//! text + cached values. Round-trip semantic-equivalence smoke test
//! lives in `tests/calamine_smoke.rs`.
//!
//! **Future**:
//! - `ExportMode::UpdateOriginal` — load the preserved original
//!   package, patch supported parts, opaquely preserve unknown OOXML
//!   parts (CF / DV / comments / drawings). Lands as a follow-up.
//! - Per-cell styles (FormatId → numFmtId via cellXfs).
//! - Tables / named ranges round-trip.

pub(crate) mod umya_export;
pub(crate) mod update_original;
