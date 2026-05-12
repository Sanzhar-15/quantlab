//! `ql-ai` — real AI() function implementation.
//!
//! Reserved for **Engine Phase 6.6** per `docs/MASTER-PLAN.md` — provider
//! boundary, prompt/value marshalling, cancellation, caching policy,
//! provenance, no-secret-leak defaults. CORR-06 / T4-D05 reserves the AI
//! sentinel TODAY; `ql-functions::scalar_fns::ai` dispatches to
//! `Error(AINotAvailable)`. This crate hosts the eventual implementation.
//! Tracked as GAP-PS-06 in `docs/known-gaps.md`.
//!
//! Currently empty (no public surface). The crate exists in the workspace
//! so the dependency graph is fixed from Phase 0 — adding it later would
//! be a breaking change for any consumer pinning the workspace shape.

#![allow(dead_code)]

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // Engine Phase 6.6 work lands here.
    }
}
