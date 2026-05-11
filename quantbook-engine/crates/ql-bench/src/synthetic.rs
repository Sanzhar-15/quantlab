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
/// All columns are uniform `[0.0, 1.0)` — the simplest distribution. Use this for the
/// gate-relevant headline number (`OG-02 ≤100ms`); for distribution-sensitivity checks
/// (`A7` chunk-size sweep, `OG-03` allocation count) see [`phase0_fixture_mixed`].
pub fn phase0_fixture(seed: u64) -> Vec<ArrayRef> {
    float64_columns(PHASE0_COLS, PHASE0_ROWS, seed)
}

/// Mixed-distribution variant of the Phase 0 25M-cell fixture. Same 50×500k shape so it's
/// drop-in for the same hot path, but with realistic-quant column distributions so the
/// bench result isn't sensitive only to the easy uniform case.
///
/// Opus-architecture audit finding #3 + codex r12 R4: uniform `[0, 1)` data has no zeros,
/// no NaNs, no wide-magnitude variance — Arrow vectorization on it doesn't represent the
/// production-workload case (prices ~10^3, returns ~10^-3, volumes integer ~10^6, gaps as
/// NaN). If `OG-02` slips by 20% on uniform vs mixed, the root cause is real and worth
/// investigating; if both numbers agree, the architecture is robust.
///
/// Column mix (per the audit recommendation):
/// - cols 0..30  — uniform `[0, 1)` (same SplitMix64 stream as `phase0_fixture`)
/// - cols 30..40 — log-uniform `[10^0, 10^5)` (price-shaped)
/// - cols 40..45 — normal-ish around 0 with σ ≈ 0.02 (returns-shaped)
/// - cols 45..48 — large-integer-ish 10^3..10^9 (volumes)
/// - cols 48..50 — 5% sparse NaN (gaps)
pub fn phase0_fixture_mixed(seed: u64) -> Vec<ArrayRef> {
    let mut out: Vec<ArrayRef> = Vec::with_capacity(PHASE0_COLS);

    // Helpers — Box–Muller for normal samples (returns one sample per call; sufficient for
    // bench-input gen even though we waste the second half of the pair).
    let box_muller = |rng: &mut SplitMix64| -> f64 {
        let u1 = rng.next_f64().max(f64::MIN_POSITIVE); // avoid log(0)
        let u2 = rng.next_f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    };

    for col_idx in 0..PHASE0_COLS {
        let mut rng = SplitMix64::new(seed.wrapping_add(col_idx as u64));
        let mut buf: Vec<f64> = Vec::with_capacity(PHASE0_ROWS);

        if col_idx < 30 {
            // Uniform — same shape as phase0_fixture columns 0..30.
            for _ in 0..PHASE0_ROWS {
                buf.push(rng.next_f64());
            }
        } else if col_idx < 40 {
            // Log-uniform [10^0, 10^5).
            for _ in 0..PHASE0_ROWS {
                let u = rng.next_f64();
                buf.push(10f64.powf(u * 5.0));
            }
        } else if col_idx < 45 {
            // Normal(0, 0.02) — daily returns scale.
            for _ in 0..PHASE0_ROWS {
                buf.push(box_muller(&mut rng) * 0.02);
            }
        } else if col_idx < 48 {
            // Integer-ish volumes 10^3..10^9.
            for _ in 0..PHASE0_ROWS {
                let u = rng.next_f64();
                buf.push((10f64.powf(3.0 + u * 6.0)).floor());
            }
        } else {
            // 5% sparse NaN; remaining 95% uniform [0, 1). Gaps mimic missing market data.
            for _ in 0..PHASE0_ROWS {
                let u = rng.next_f64();
                if u < 0.05 {
                    buf.push(f64::NAN);
                } else {
                    buf.push(u);
                }
            }
        }

        out.push(Arc::new(Float64Array::from(buf)) as ArrayRef);
    }
    out
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

    // -- phase0_fixture_mixed (audit-driven realism check) ---------------------

    #[test]
    fn mixed_fixture_shape_and_count() {
        // Use a tiny per-column row count for speed; the size invariants are what matter.
        // We call the helper with PHASE0_COLS but only sample column 0 and a few segment
        // boundaries to keep the test fast.
        let cols = phase0_fixture_mixed(7);
        assert_eq!(cols.len(), PHASE0_COLS);
        for c in &cols {
            assert_eq!(c.len(), PHASE0_ROWS);
            assert_eq!(c.data_type(), &arrow_schema::DataType::Float64);
        }
    }

    #[test]
    fn mixed_fixture_log_uniform_band_in_range() {
        // Cols 30..40 are log-uniform [10^0, 10^5). Sample col 30 first 100 rows.
        let cols = phase0_fixture_mixed(11);
        let arr = cols[30]
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("Float64Array");
        for i in 0..100 {
            let v = arr.value(i);
            assert!(
                (1.0..1e5 + 1e-9).contains(&v),
                "log-uniform col 30 row {i} out of [1, 1e5): {v}"
            );
        }
    }

    #[test]
    fn mixed_fixture_normal_returns_within_reasonable_sigma() {
        // Col 40 is Normal(0, 0.02). Within ±6σ ≈ ±0.12 with very high probability.
        // First 1000 samples: at most a handful >0.12 in absolute value.
        let cols = phase0_fixture_mixed(13);
        let arr = cols[40]
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("Float64Array");
        let mut extreme = 0;
        for i in 0..1000 {
            if arr.value(i).abs() > 0.12 {
                extreme += 1;
            }
        }
        assert!(
            extreme < 5,
            "too many extreme samples in normal column: {extreme}/1000"
        );
    }

    #[test]
    fn mixed_fixture_volumes_integer_shape() {
        // Cols 45..48 are floor(10^(3+u*6)) — always integer-valued floats, range [10^3, 10^9].
        let cols = phase0_fixture_mixed(17);
        let arr = cols[45]
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("Float64Array");
        for i in 0..100 {
            let v = arr.value(i);
            assert!((1e3..=1e9).contains(&v), "volume col 45 row {i} = {v}");
            assert_eq!(v.fract(), 0.0, "expected integer, got {v}");
        }
    }

    #[test]
    fn mixed_fixture_sparse_nan_columns_have_nans() {
        // Cols 48..50 are 5% NaN. Across PHASE0_ROWS at p=0.05 the NaN count is ~N(25000, ~150),
        // so far more than 100 NaNs in the first 10k rows. Use a generous lower bound.
        let cols = phase0_fixture_mixed(19);
        let arr = cols[48]
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("Float64Array");
        let mut nan_count = 0;
        for i in 0..10_000 {
            if arr.value(i).is_nan() {
                nan_count += 1;
            }
        }
        // Expected ~500 NaNs in 10k samples; allow [250, 750] to handle SplitMix64 variance.
        assert!(
            (250..=750).contains(&nan_count),
            "expected ~5% NaN, got {nan_count}/10000"
        );
    }

    #[test]
    fn mixed_fixture_reproducible_across_calls() {
        let a = phase0_fixture_mixed(99);
        let b = phase0_fixture_mixed(99);
        // Compare column 0 first row (uniform) and column 40 first row (normal) — both byte-equal.
        let a0 = a[0].as_any().downcast_ref::<Float64Array>().unwrap();
        let b0 = b[0].as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(a0.value(0), b0.value(0));
        let a40 = a[40].as_any().downcast_ref::<Float64Array>().unwrap();
        let b40 = b[40].as_any().downcast_ref::<Float64Array>().unwrap();
        assert_eq!(a40.value(0), b40.value(0));
    }
}
