//! Per-evaluation timing records — completes OG-06 ("senior engineer attributes time
//! spent within 10 min").
//!
//! Phase 0 W3-7 shipped the profile JSON shape with zero time fields. W5-5 wires this
//! `Timings` struct into the profile so a runtime evaluator (Week 4 `ql-exec` runtime
//! integration, currently in design) can populate it and the resulting JSON reads
//! time-spent at a glance.
//!
//! ## Shape (locked at schema_version 2)
//!
//! - `last_eval_duration_us` — total wall-clock for the most recent evaluation pass
//!   (microseconds, u64). Zero if no eval has run.
//! - `recompute_us_by_node_type` — time attributed per node variant. Sum should
//!   approximate `last_eval_duration_us`.
//! - `fingerprint_cache_hits` / `fingerprint_cache_misses` — formula-region
//!   memoization metrics. Hit rate = hits / (hits + misses).
//! - `simd_dispatch_count` / `scalar_dispatch_count` — count of SIMD vs scalar
//!   evaluations during the last eval pass. The OG-02 acceptance lives in the SIMD
//!   bucket.
//!
//! ## Why microseconds not nanoseconds
//!
//! u64 nanoseconds overflow after ~584 years; u64 microseconds after ~584,000 years.
//! Excel-scale workloads typically run in milliseconds (OG-02 = 3.4 ms = 3400 μs). u64
//! μs gives 6+ significant digits at workload scale without overflow risk; finer
//! granularity isn't observable above measurement noise.

use serde::Serialize;

/// Timing snapshot for a single evaluation pass. Default = all-zero (no eval run yet).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Timings {
    /// Total wall-clock for the last `recompute()` call, microseconds.
    pub last_eval_duration_us: u64,
    /// Time attributed per node variant during the last eval.
    pub recompute_us_by_node_type: NodeTypeTimings,
    /// Count of formula-region fingerprint cache hits during the last eval.
    pub fingerprint_cache_hits: u64,
    /// Count of formula-region fingerprint cache misses during the last eval.
    pub fingerprint_cache_misses: u64,
    /// Count of SIMD kernel dispatches during the last eval.
    pub simd_dispatch_count: u64,
    /// Count of scalar evaluator calls during the last eval.
    pub scalar_dispatch_count: u64,
}

impl Timings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Computed cache hit rate. Returns `None` when no cache lookups happened.
    pub fn fingerprint_cache_hit_rate(&self) -> Option<f64> {
        let total = self.fingerprint_cache_hits + self.fingerprint_cache_misses;
        if total == 0 {
            None
        } else {
            Some((self.fingerprint_cache_hits as f64) / (total as f64))
        }
    }

    /// Convenience: bump SIMD dispatch counter.
    pub fn record_simd_dispatch(&mut self) {
        self.simd_dispatch_count = self
            .simd_dispatch_count
            .checked_add(1)
            .expect("Timings::record_simd_dispatch: overflow u64");
    }

    /// Convenience: bump scalar dispatch counter.
    pub fn record_scalar_dispatch(&mut self) {
        self.scalar_dispatch_count = self
            .scalar_dispatch_count
            .checked_add(1)
            .expect("Timings::record_scalar_dispatch: overflow u64");
    }

    /// Add elapsed time to the per-node-type bucket.
    pub fn record_node_eval(&mut self, kind: NodeKind, elapsed_us: u64) {
        let slot = match kind {
            NodeKind::Cell => &mut self.recompute_us_by_node_type.cell_us,
            NodeKind::Range => &mut self.recompute_us_by_node_type.range_us,
            NodeKind::FormulaRegion => &mut self.recompute_us_by_node_type.formula_region_us,
            NodeKind::Spill => &mut self.recompute_us_by_node_type.spill_us,
        };
        *slot = slot
            .checked_add(elapsed_us)
            .expect("Timings::record_node_eval: overflow u64");
    }
}

/// Per-variant time attribution. Sum of all fields ≈ `last_eval_duration_us` (minus
/// scheduler / IO overhead).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NodeTypeTimings {
    pub cell_us: u64,
    pub range_us: u64,
    pub formula_region_us: u64,
    pub spill_us: u64,
}

impl NodeTypeTimings {
    pub fn total_us(&self) -> u64 {
        self.cell_us + self.range_us + self.formula_region_us + self.spill_us
    }
}

/// Node-variant discriminator for `Timings::record_node_eval`. Mirrors
/// `ql_calcgraph::Node`'s 4 variants without coupling ql-profile to ql-calcgraph for
/// just the timing API.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeKind {
    Cell,
    Range,
    FormulaRegion,
    Spill,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_timings_zero() {
        let t = Timings::default();
        assert_eq!(t.last_eval_duration_us, 0);
        assert_eq!(t.simd_dispatch_count, 0);
        assert_eq!(t.scalar_dispatch_count, 0);
        assert_eq!(t.fingerprint_cache_hit_rate(), None);
        assert_eq!(t.recompute_us_by_node_type.total_us(), 0);
    }

    #[test]
    fn record_dispatches() {
        let mut t = Timings::new();
        t.record_simd_dispatch();
        t.record_simd_dispatch();
        t.record_scalar_dispatch();
        assert_eq!(t.simd_dispatch_count, 2);
        assert_eq!(t.scalar_dispatch_count, 1);
    }

    #[test]
    fn record_node_eval_accumulates() {
        let mut t = Timings::new();
        t.record_node_eval(NodeKind::Cell, 100);
        t.record_node_eval(NodeKind::Cell, 200);
        t.record_node_eval(NodeKind::FormulaRegion, 50);
        assert_eq!(t.recompute_us_by_node_type.cell_us, 300);
        assert_eq!(t.recompute_us_by_node_type.formula_region_us, 50);
        assert_eq!(t.recompute_us_by_node_type.range_us, 0);
        assert_eq!(t.recompute_us_by_node_type.total_us(), 350);
    }

    #[test]
    fn cache_hit_rate_computes_correctly() {
        let mut t = Timings::new();
        // No data → None
        assert_eq!(t.fingerprint_cache_hit_rate(), None);
        t.fingerprint_cache_hits = 3;
        t.fingerprint_cache_misses = 1;
        assert_eq!(t.fingerprint_cache_hit_rate(), Some(0.75));
        t.fingerprint_cache_hits = 0;
        t.fingerprint_cache_misses = 10;
        assert_eq!(t.fingerprint_cache_hit_rate(), Some(0.0));
    }
}
