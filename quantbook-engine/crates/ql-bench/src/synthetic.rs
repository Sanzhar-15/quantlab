//! Synthetic data generation for Phase 0 acceptance benches.
//!
//! Goal: deterministic, replayable Float64 columns that the Phase 0 OG-02/OG-03 benches
//! (`benches/phase0_vector_25m.rs`) and amendments A1/A5/A7 build on.
//!
//! No external RNG crate — SplitMix64 inline is sufficient for benchmark inputs (we need
//! determinism + speed, not statistical quality beyond uniform-on-`[0, 1)`).

use std::sync::Arc;

use arrow_array::{ArrayRef, Float64Array};

/// Phase 0 OG-02 acceptance fixture size: 50 columns × 500,000 rows = 25,000,000 cells.
pub const PHASE0_COLS: usize = 50;
/// Phase 0 OG-02 acceptance fixture size: 500,000 rows per column.
pub const PHASE0_ROWS: usize = 500_000;
/// Phase 0 OG-02 acceptance fixture total cell count: 25,000,000.
pub const PHASE0_CELLS: usize = PHASE0_COLS * PHASE0_ROWS;

/// SplitMix64 — Sebastiano Vigna, used as the xoshiro family seeder.
/// Reference: <https://prng.di.unimi.it/splitmix64.c> (public domain).
#[derive(Clone, Copy, Debug)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform Float64 in `[0.0, 1.0)`. Uses the high 53 bits of the u64 stream.
    pub fn next_f64(&mut self) -> f64 {
        // 53-bit mantissa → divide by 2^53.
        (self.next_u64() >> 11) as f64 * (1.0 / ((1u64 << 53) as f64))
    }
}

/// Generate `cols` Float64 columns × `rows` rows of uniform `[0.0, 1.0)` data.
///
/// Each column uses an independent SplitMix64 stream seeded `seed.wrapping_add(col_idx as u64)`,
/// so requesting fewer columns yields a *prefix* of the full set — useful for differential
/// benches where you want a single column without affecting the bytes of any other.
pub fn float64_columns(cols: usize, rows: usize, seed: u64) -> Vec<ArrayRef> {
    (0..cols)
        .map(|col_idx| {
            let mut rng = SplitMix64::new(seed.wrapping_add(col_idx as u64));
            let mut buf: Vec<f64> = Vec::with_capacity(rows);
            for _ in 0..rows {
                buf.push(rng.next_f64());
            }
            Arc::new(Float64Array::from(buf)) as ArrayRef
        })
        .collect()
}

/// The Phase 0 OG-02 25M-cell fixture: 50 cols × 500k rows × Float64, seeded.
pub fn phase0_fixture(seed: u64) -> Vec<ArrayRef> {
    float64_columns(PHASE0_COLS, PHASE0_ROWS, seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::Array;
    use arrow_schema::DataType;

    #[test]
    fn splitmix64_is_deterministic() {
        let mut a = SplitMix64::new(42);
        let mut b = SplitMix64::new(42);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn splitmix64_different_seeds_diverge() {
        let mut a = SplitMix64::new(42);
        let mut b = SplitMix64::new(43);
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn float64_uniform_in_unit_interval() {
        let mut rng = SplitMix64::new(123);
        let mut sum = 0.0_f64;
        const N: usize = 10_000;
        for _ in 0..N {
            let x = rng.next_f64();
            assert!((0.0..1.0).contains(&x), "out of range: {x}");
            sum += x;
        }
        // Crude sanity check on uniformity: mean of `N` uniform `[0, 1)` samples should be
        // within a few sigma of 0.5. sigma(mean) = sqrt(1/12 / N) ≈ 0.0029 for N=10k → 5σ = 0.014.
        let mean = sum / N as f64;
        assert!((mean - 0.5).abs() < 0.02, "mean off: {mean}");
    }

    #[test]
    fn float64_columns_shape_and_dtype() {
        let cols = float64_columns(3, 100, 7);
        assert_eq!(cols.len(), 3);
        for c in &cols {
            assert_eq!(c.len(), 100);
            assert_eq!(c.data_type(), &DataType::Float64);
        }
    }

    #[test]
    fn float64_columns_reproducible_across_calls() {
        let a = float64_columns(2, 50, 99);
        let b = float64_columns(2, 50, 99);
        for (ca, cb) in a.iter().zip(b.iter()) {
            let ax = ca.as_any().downcast_ref::<Float64Array>().unwrap();
            let bx = cb.as_any().downcast_ref::<Float64Array>().unwrap();
            assert_eq!(ax.values(), bx.values());
        }
    }

    #[test]
    fn columns_are_prefix_independent() {
        // Requesting 1 column then 3 columns at the same seed: column[0] must match —
        // a downstream bench that swaps fixture width should not see column-0 churn.
        let one = float64_columns(1, 100, 10);
        let three = float64_columns(3, 100, 10);
        let one0 = one[0].as_any().downcast_ref::<Float64Array>().unwrap();
        let three0 = three[0].as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(one0.values(), three0.values());
    }

    #[test]
    fn phase0_constants_match_25m_cells() {
        assert_eq!(PHASE0_CELLS, 25_000_000);
    }
}
