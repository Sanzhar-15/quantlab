//! `ql-connectors` — external dataset connector surface.
//!
//! Reserved for **Engine Phase 6.5** per `docs/MASTER-PLAN.md` — Postgres,
//! Parquet, CSV, Terminal, and other external data sources behind a uniform
//! `DataSource` trait with credentials boundary and refresh semantics.
//! Tracked as GAP-PS-05 in `docs/known-gaps.md`.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Engine Phase 6.5 work lands here.
    }
}
