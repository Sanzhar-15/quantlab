//! `ql-oplog` — Phase 2A.12 audit M16/DOC: rewrote stale "Phase 0 stub" doc.
//!
//! Reserved for Phase 2A.3 — Loro op log scaffolding (T1-D05 architectural lock).
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Phase 2A.3 work lands here.
    }
}
