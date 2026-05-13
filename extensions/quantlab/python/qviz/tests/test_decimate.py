"""Tests for the vectorized LTTB decimator."""

from __future__ import annotations

import time

import numpy as np
import pytest

from qviz.decimate import decimate_for_viewport, lttb


# ---------------------------------------------------------------------------
# Correctness invariants
# ---------------------------------------------------------------------------


def test_returns_unchanged_when_threshold_geq_n() -> None:
    xs = np.arange(10).astype(np.float64)
    ys = np.sin(xs)
    out_x, out_y = lttb(xs, ys, threshold=10)
    np.testing.assert_array_equal(out_x, xs)
    np.testing.assert_array_equal(out_y, ys)
    out_x2, out_y2 = lttb(xs, ys, threshold=100)
    np.testing.assert_array_equal(out_x2, xs)


def test_returns_unchanged_when_threshold_below_3() -> None:
    xs = np.arange(100).astype(np.float64)
    ys = xs * 2
    for t in (0, 1, 2):
        out_x, out_y = lttb(xs, ys, threshold=t)
        np.testing.assert_array_equal(out_x, xs)
        np.testing.assert_array_equal(out_y, ys)


def test_first_and_last_always_preserved() -> None:
    xs = np.linspace(0, 1, 1000)
    ys = np.sin(xs * 20)
    out_x, out_y = lttb(xs, ys, threshold=50)
    assert out_x[0] == xs[0]
    assert out_y[0] == ys[0]
    assert out_x[-1] == xs[-1]
    assert out_y[-1] == ys[-1]


def test_output_length_matches_threshold() -> None:
    xs = np.arange(10_000).astype(np.float64)
    ys = np.random.default_rng(0).standard_normal(10_000)
    for t in (10, 100, 500, 3000):
        out_x, out_y = lttb(xs, ys, threshold=t)
        assert len(out_x) == t
        assert len(out_y) == t


def test_output_x_is_monotonic() -> None:
    xs = np.arange(10_000).astype(np.float64)
    ys = np.random.default_rng(0).standard_normal(10_000)
    out_x, _ = lttb(xs, ys, threshold=300)
    assert np.all(np.diff(out_x) > 0)


def test_preserves_sharp_peak() -> None:
    """A spike in a flat series must be picked. This is LTTB's whole job."""
    n = 10_000
    xs = np.arange(n).astype(np.float64)
    ys = np.zeros(n)
    ys[5000] = 100.0  # spike
    out_x, out_y = lttb(xs, ys, threshold=200)
    assert ys[5000] in out_y, "LTTB lost the spike — algorithm bug"


def test_preserves_trough() -> None:
    n = 10_000
    xs = np.arange(n).astype(np.float64)
    ys = np.zeros(n)
    ys[5000] = -100.0
    out_x, out_y = lttb(xs, ys, threshold=200)
    assert ys[5000] in out_y


def test_handles_int_x_axis() -> None:
    """Common case: x is int64 (timestamp ns)."""
    xs = np.arange(0, 10_000_000, 100, dtype=np.int64)  # ns timestamps
    ys = np.random.default_rng(0).standard_normal(len(xs))
    out_x, out_y = lttb(xs, ys, threshold=200)
    assert out_x.dtype == xs.dtype
    assert len(out_x) == 200
    assert out_x[0] == xs[0]
    assert out_x[-1] == xs[-1]


def test_handles_nan_in_y() -> None:
    n = 1000
    xs = np.arange(n).astype(np.float64)
    ys = np.sin(xs / 50)
    ys[100:120] = np.nan
    # Should not raise; NaN areas treated as 0 so first-of-bucket gets picked.
    out_x, out_y = lttb(xs, ys, threshold=100)
    assert len(out_x) == 100
    assert out_x[0] == xs[0]
    assert out_x[-1] == xs[-1]


def test_invalid_shape_rejected() -> None:
    xs = np.arange(10)
    ys = np.arange(11)
    with pytest.raises(ValueError, match="equal shape"):
        lttb(xs, ys, threshold=5)


def test_2d_rejected() -> None:
    xs = np.arange(10).reshape(2, 5).astype(np.float64)
    ys = np.arange(10).reshape(2, 5).astype(np.float64)
    with pytest.raises(ValueError, match="1D"):
        lttb(xs, ys, threshold=5)


# ---------------------------------------------------------------------------
# Performance — the spike's 132ms target is the floor; production wants <30ms
# ---------------------------------------------------------------------------


def test_lttb_1m_is_fast() -> None:
    """1M -> 3000 should run in well under spike's 132ms.

    Spike used pure-Python loop and clocked 132ms.
    Production target: 30ms (vectorized inner loop).
    Allowing 60ms for headroom (CI runners + cold caches).
    """
    rng = np.random.default_rng(0)
    n = 1_000_000
    xs = np.arange(n, dtype=np.int64) * 1_000_000
    ys = rng.standard_normal(n)

    # warmup
    lttb(xs, ys, threshold=3000)
    t0 = time.perf_counter()
    out_x, _ = lttb(xs, ys, threshold=3000)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert len(out_x) == 3000
    assert elapsed_ms < 60, f"vectorized LTTB too slow: {elapsed_ms:.0f}ms"


# ---------------------------------------------------------------------------
# decimate_for_viewport
# ---------------------------------------------------------------------------


def test_viewport_decimation_picks_reasonable_target() -> None:
    rng = np.random.default_rng(0)
    n = 1_000_000
    xs = np.arange(n, dtype=np.float64)
    ys = rng.standard_normal(n)
    # 1600 pixels @ 2 pts/pixel -> target 3200
    out_x, _ = decimate_for_viewport(xs, ys, viewport_pixels=1600)
    assert len(out_x) == 3200


def test_viewport_decimation_minimum_floor() -> None:
    """Even with a tiny viewport, never go below 64 points."""
    xs = np.arange(1000).astype(np.float64)
    ys = np.zeros(1000)
    out_x, _ = decimate_for_viewport(xs, ys, viewport_pixels=10)
    assert len(out_x) == 64


# ---------------------------------------------------------------------------
# Megaudit G2 (2026-05-13): integer bucket boundaries + degenerate-lookahead
# ---------------------------------------------------------------------------


def test_g2_integer_bucket_bounds_match_rational_floor() -> None:
    """The integer formula `(k * (n-2)) // (t-2) + 1` must agree with
    the rational floor on representative (n, threshold) pairs.

    Audit note (G2 codex audit, 2026-05-13): a brute-force scan over
    n < 1000 found ~36k (n, t) pairs where the old float formula
    differed from the integer formula's rational-floor truth — the
    drift is widespread at small thresholds, not limited to the
    handful of representative pairs below. Production thresholds
    (typically 64..6400 against parquet row counts in the millions)
    don't hit the drift band, so the integer-formula switch is a
    correctness upgrade with no production output shift on the chart
    sizes Quantbook actually serves."""
    from qviz.decimate import _compute_bucket_bounds
    import math
    for n, t in [(10, 8), (20, 18), (100, 50), (1000, 100),
                 (1_000_000, 3000), (1_000_000, 5000),
                 (17, 13), (117, 9)]:
        starts, ends = _compute_bucket_bounds(n, t)
        t2 = t - 2
        n2 = n - 2
        # Reference: rational floor.
        ref_starts = np.array(
            [math.floor(k * n2 / t2) + 1 for k in range(t2)],
            dtype=np.int64,
        )
        ref_ends = np.array(
            [min(math.floor((k + 1) * n2 / t2) + 1, n - 1) for k in range(t2)],
            dtype=np.int64,
        )
        np.testing.assert_array_equal(starts, ref_starts, err_msg=f"(n={n},t={t})")
        np.testing.assert_array_equal(ends, ref_ends, err_msg=f"(n={n},t={t})")


def test_g2_lookahead_degenerate_uses_next_bucket_first_point() -> None:
    """Pin the Steinarsson 2013 fallback for empty lookahead windows.

    Audit calibration (G2 opus + codex, 2026-05-13): both auditors
    independently brute-forced (n, t) pairs and confirmed
    `_compute_bucket_bounds` provably cannot produce zero-width
    windows for valid `lttb_indices` inputs (`3 <= t < n`). The
    degenerate branch is therefore DEFENSIVE-ONLY — a future caller
    feeding hand-crafted bounds, or a refactor that loosens the
    bucket-bounds invariant, would land here. This test pins the
    correct behavior of that branch via synthetic boundaries; it does
    NOT prove the pre-G2 code was buggy on production inputs (it was
    not). The branch matters for spec-compliance and helper-level
    safety, not as a fix for a production bug."""
    from qviz.decimate import _compute_lookahead_means
    # Three buckets, second has empty lookahead (avg_start == avg_end).
    # Layout: bucket_starts=[1,3,5], bucket_ends=[3,5,5].
    # avg_starts mirror bucket_ends: [3,5,5]
    # avg_ends defined by next bucket starts: [5,5,8 (n=8)]
    # → window lengths [2, 0, 3]. Bucket 1 (index 1) is degenerate.
    bucket_starts = np.array([1, 3, 5], dtype=np.int64)
    bucket_ends = np.array([3, 5, 5], dtype=np.int64)
    n = 8
    xf = np.arange(n, dtype=np.float64)
    # Spike at index 5 (the next-bucket-first-point for the degenerate
    # bucket 1).
    yf = np.array([0., 0., 0., 0., 0., 100., 0., 0.], dtype=np.float64)
    avg_x, avg_y = _compute_lookahead_means(bucket_starts, bucket_ends, xf, yf, n)
    # Degenerate bucket 1: lookahead must be the next bucket's first
    # point (bucket_starts[2] == 5).
    assert avg_x[1] == xf[5], avg_x
    assert avg_y[1] == yf[5], (avg_y, "must equal the spike value 100")


def test_g2_integer_formula_matches_old_float_on_normal_inputs() -> None:
    """Pin that for "normal" (n, threshold) pairs where the OLD float
    formula didn't underfloor, the new integer formula produces
    IDENTICAL output. Catches a wider-than-expected behavior shift."""
    from qviz.decimate import _compute_bucket_bounds
    for n, t in [(1_000_000, 3000), (1_000_000, 5000), (100, 50)]:
        new_starts, new_ends = _compute_bucket_bounds(n, t)
        # Old float formula:
        bucket_size = (n - 2) / (t - 2)
        old_starts = (
            np.floor(np.arange(t - 2) * bucket_size).astype(np.int64) + 1
        )
        old_ends = (
            np.floor((np.arange(t - 2) + 1) * bucket_size).astype(np.int64) + 1
        )
        old_ends = np.minimum(old_ends, n - 1)
        np.testing.assert_array_equal(new_starts, old_starts,
            err_msg=f"normal-thresholds invariant (n={n},t={t})")
        np.testing.assert_array_equal(new_ends, old_ends,
            err_msg=f"normal-thresholds invariant (n={n},t={t})")


def test_g2_cross_platform_determinism_f32_vs_f64() -> None:
    """Boundary formula is pure integer arithmetic; selected indices
    must be identical regardless of input ys precision. The float64
    area arithmetic CAN diverge across (f32,f64) at floating-point
    noise level, but the index path goes through the same boundary
    formula in both cases — pin the index equality on a smooth input
    where the area math doesn't switch winners."""
    from qviz.decimate import lttb_indices
    rng = np.random.default_rng(42)
    xs = np.arange(10_000, dtype=np.float64)
    # Use a smooth signal so the area-max winner doesn't depend on
    # f32-vs-f64 rounding (which could flip ties).
    ys64 = np.sin(xs * 0.01).astype(np.float64)
    ys32 = ys64.astype(np.float32)
    idx64 = lttb_indices(xs, ys64, 300)
    idx32 = lttb_indices(xs, ys32, 300)
    np.testing.assert_array_equal(idx64, idx32)


def test_g2_hand_computed_n10_t8() -> None:
    """Pin a hand-computed example for n=10, threshold=8. With the
    integer formula:
      n2 = 8, t2 = 6.
      k = [0..5]: starts = [0,1,2,4,5,6] + 1 = [1,2,3,5,6,7]
                  ends   = [1,2,4,5,6,8] + 1 = [2,3,5,6,7,9]
    First+last fixed at 0, 9. Hand-computed selection on a flat input
    with a spike at index 4: the bucket containing index 4 picks it."""
    from qviz.decimate import lttb_indices
    xs = np.arange(10, dtype=np.float64)
    ys = np.array([0., 0., 0., 0., 100., 0., 0., 0., 0., 0.], dtype=np.float64)
    idx = lttb_indices(xs, ys, 8)
    assert idx[0] == 0, idx
    assert idx[-1] == 9, idx
    # Spike at index 4 falls in bucket #2 (start=3, end=5), so the
    # output must contain 4.
    assert 4 in idx, idx
    # Indices monotonic, no repeats.
    assert np.all(np.diff(idx) > 0), idx
