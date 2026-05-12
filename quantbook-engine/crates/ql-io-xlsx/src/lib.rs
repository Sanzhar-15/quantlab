//! `ql-io-xlsx` — Excel .xlsx import/export surface.
//!
//! Reserved for **Engine Phase 4.11** per `docs/MASTER-PLAN.md` — calamine
//! for read, deliberate writer choice for export, OOXML semantic preservation
//! for formulas/styles/names/tables/CF/DV/comments/images. Distinct from
//! `ql-io` which owns the native `.qbook/` format. Tracked as GAP-P-02 in
//! `docs/known-gaps.md`.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Engine Phase 4.11 work lands here.
    }
}
