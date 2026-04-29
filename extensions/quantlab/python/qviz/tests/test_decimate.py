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
