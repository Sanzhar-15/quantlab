//! Shared Criterion configuration for Phase 0 acceptance benches.
//!
//! Every Phase 0 bench (`benches/phase0_vector_25m.rs`, A1 region split/merge, A5 range-node
//! prefix-SUM, A7 chunk-size sweep) constructs its `Criterion` via `default_criterion()` so
//! the timing methodology is identical across the suite. CI compares regression deltas against
//! Criterion's JSON output via the standard `target/criterion/<bench>/<id>/estimates.json`.

use std::time::Duration;

use criterion::Criterion;

/// Phase 0 acceptance Criterion: 20 samples × 10s measurement / 3s warm-up. Used for the
/// 25M-cell hot-path bench (OG-02/03) and any acceptance gate where the measurement budget
/// is allowed to be larger than dev-loop benches.
pub fn default_criterion() -> Criterion {
    Criterion::default()
        .sample_size(20)
        .measurement_time(Duration::from_secs(10))
        .warm_up_time(Duration::from_secs(3))
        .significance_level(0.01)
        .noise_threshold(0.02)
}

/// Faster Criterion for tight dev-loop / pre-commit sanity (10 samples × 3s / 1s).
/// Do NOT use for acceptance numbers — variance is too high.
pub fn fast_criterion() -> Criterion {
    Criterion::default()
        .sample_size(10)
        .measurement_time(Duration::from_secs(3))
        .warm_up_time(Duration::from_secs(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_criterion_constructs() {
        // Compile + construct: validates that the workspace `criterion` feature set is
        // sufficient. If `html_reports` ever gets removed, this is where it breaks first.
        let _ = default_criterion();
    }

    #[test]
    fn fast_criterion_constructs() {
        let _ = fast_criterion();
    }
}
