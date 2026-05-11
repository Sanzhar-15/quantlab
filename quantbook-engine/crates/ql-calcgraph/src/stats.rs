//! Graph instrumentation counters.
//!
//! Per the Week 3 plan (W3-6) + CORR-24: locked-shape u64 counters tracking three things
//! the A4 acceptance assertions and the W3-7 graph-profile.json export both consume:
//!
//! - `stripe_inserts` — total `StripeIndex::insert` calls. Equals
//!   `StripeIndex::total_insertions` modulo HashSet dedup. Used to verify the A5 linear-
//!   scaling claim in observability output.
//!
//! - `dependents_scan_fallback` — Phase 0 stays at 0; reserved for Week 4+ when an
//!   optimized lookup path may fall back to scanning if instrumentation indicates a
//!   degenerate case (mirrors Formualizer `engine/graph/mod.rs:18-21` instrumentation).
//!   The field PRESENCE is the W3-6 deliverable; non-zero values come in Week 4.
//!
//! - `chunked_reduce_chunks_processed` — incremented during a chunk-level reduction over
//!   a Range or FormulaRegion (e.g. recomputing `SUM(A:A)` walks chunks of column A and
//!   bumps this once per chunk). Phase 0 W3-6 locks PRESENCE; Week 4 ql-exec wires the
//!   actual increments when the SIMD reduction lands.
//!
//! ## Why plain `u64` and not `AtomicU64`?
//!
//! The graph takes `&mut self` for all mutations, so single-writer borrow rules give us
//! the synchronization for free. Formualizer uses `Mutex<GraphInstr>` because their
//! parallel evaluator reads `&Graph` concurrently and instrument-from-multiple-threads
//! would otherwise race. Phase 0 Quantbook is single-threaded; revisit when Week 4's
//! rayon-parallel layer evaluator lands.

/// Per-graph instrumentation counters. All fields default to 0 and are always present
/// (no `#[cfg(test)]` gate) so tools consuming the W3-7 profile export get a stable
/// shape regardless of build profile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GraphStats {
    pub stripe_inserts: u64,
    pub dependents_scan_fallback: u64,
    pub chunked_reduce_chunks_processed: u64,
}

impl GraphStats {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_stats_zero() {
        let s = GraphStats::default();
        assert_eq!(s.stripe_inserts, 0);
        assert_eq!(s.dependents_scan_fallback, 0);
        assert_eq!(s.chunked_reduce_chunks_processed, 0);
    }

    #[test]
    fn stats_are_copy_and_eq() {
        let a = GraphStats {
            stripe_inserts: 5,
            dependents_scan_fallback: 0,
            chunked_reduce_chunks_processed: 12,
        };
        let b = a;
        assert_eq!(a, b);
    }
}
