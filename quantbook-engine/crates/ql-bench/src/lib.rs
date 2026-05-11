//! `ql-bench` — synthetic data + machine introspection + Criterion config for the Phase 0
//! acceptance benches. See `.plans/_QUANTBOOK-v1-SPECIFICATION.md` Part V §4 Week 1 Days 3-4.
//!
//! The acceptance benches themselves live under `benches/` here and under
//! `crates/ql-calcgraph/benches/`; this crate provides their shared building blocks so the
//! exit-packet numbers are comparable across runs and across amendments.

#![allow(dead_code)]

pub mod machine;
pub mod report;
pub mod synthetic;

#[cfg(test)]
mod tests {
    #[test]
    fn smoke() {
        // crate compiles; module-level tests live alongside each module.
    }
}
