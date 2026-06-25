//! `ql-io-ods` — OpenDocument .ods import/export surface.
//!
//! Reserved for **post-v1** per `docs/MASTER-PLAN.md` — Engine Phase 4
//! focuses on xlsx; ODS round-trip likely lands in v1.5 unless customer-asked.
//! Distinct from `ql-io` which owns the native `.qbook/` format. Tracked as
//! GAP-P-02 in `docs/known-gaps.md`.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Post-v1 work lands here.
    }
}
