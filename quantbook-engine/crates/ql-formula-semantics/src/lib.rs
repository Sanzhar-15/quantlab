//! `ql-formula-semantics` — Phase 2A.12 audit M16/DOC: rewrote stale "Phase 0 stub" doc.
//!
//! Reserved for Phase 3+ — sheet-scope named names, named formula resolution, defined-name visibility rules. Phase 2A.1 wired workbook-scope names directly in ql-storage::NameTable + ql-exec binder; this crate hosts the Phase 3+ semantic layer.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Phase 3+ work lands here.
    }
}
