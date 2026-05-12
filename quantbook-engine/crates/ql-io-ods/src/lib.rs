//! `ql-io-ods` — Phase 2A.12 audit M16/DOC: rewrote stale "Phase 0 stub" doc.
//!
//! Reserved for Phase 4+ — .ods import/export. Distinct from ql-io which owns the native .qbook/ format.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Phase 4+ work lands here.
    }
}
