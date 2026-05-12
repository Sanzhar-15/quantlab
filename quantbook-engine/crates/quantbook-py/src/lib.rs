//! `quantbook-py` — Python bindings via PyO3 (the `quantbook` Python
//! package: `qb.show()`, `qb.publish()`, `qb.bind()`, etc.).
//!
//! Reserved for **Engine Phase 6.3** per `docs/MASTER-PLAN.md` — built over
//! the stable session API delivered in 6.1. Maturin wheel target. Tracked as
//! GAP-PS-01 in `docs/known-gaps.md`.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Engine Phase 6.3 work lands here.
    }
}
