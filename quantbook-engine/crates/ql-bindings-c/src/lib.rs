//! `ql-bindings-c` — Phase 2A.12 audit M16/DOC: rewrote stale "Phase 0 stub" doc.
//!
//! C FFI bindings for embedders — **v1.5-deferred** (decision-lock §2.8, ratified
//! 2026-05-30; Phase-6.7 closure). No v1 consumer: the IDE uses napi, the service
//! uses HTTP. Currently empty (no public surface).
//!
//! The crate exists in the workspace so the dependency graph is fixed from Phase 0 —
//! adding it later would be a breaking change for any consumer pinning the workspace
//! shape. Real C FFI work lands in v1.5.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Phase 6+ work lands here.
    }
}
