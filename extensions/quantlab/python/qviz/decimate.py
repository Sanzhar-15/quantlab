"""LTTB downsampling, vectorized.

LTTB = Largest-Triangle-Three-Buckets. Reduces N points to M while preserving
visual peaks/troughs. Standard reference: Sveinn Steinarsson's MSc thesis,
"Downsampling Time Series for Visual Representation" (2013).

The spike used a Python for-loop (~132ms on 1M -> 3000). This vectorized
version runs the bucket pass in numpy and targets ~10ms on the same input.

Algorithm:
  1. Always include first and last points.
  2. Divide remaining n-2 points into threshold-2 buckets of equal width.
  3. For each bucket, pick the point that forms the largest triangle with:
     - the previously picked point (anchor)
     - the average of all points in the *next* bucket (lookahead)
"""

from __future__ import annotations

from typing import Tuple

import numpy as np


def _compute_bucket_bounds(
    n: int, threshold: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Megaudit G2 (2026-05-13): compute integer-arithmetic LTTB bucket
    boundaries. Replaces the previous `np.floor((k+1) * (n-2)/(t-2))`
    float formula. The integer formula is deterministic across
    platforms and avoids underfloor edge cases at certain (n, t)
    pairs (e.g. `(17, 13)`, `(117, 9)`) where float rounding produced
    indices one off from the rational-floor truth.

    Returns (bucket_starts, bucket_ends), both length `threshold - 2`,
    1-indexed-from-1 to match the spec's "first / last point are always
    included" convention.
    """
    t2 = threshold - 2
    n2 = n - 2
    k = np.arange(t2, dtype=np.int64)
    bucket_starts = (k * n2) // t2 + 1
    bucket_ends = ((k + 1) * n2) // t2 + 1
    # Defensive cap on bucket_ends (previously `np.minimum(... n-1)`).
    # The integer formula's max is `((t2) * n2) // t2 + 1 = n2 + 1 = n - 1`
    # so it shouldn't exceed n-1, but pin the bound anyway.
    bucket_ends = np.minimum(bucket_ends, n - 1)
    return bucket_starts, bucket_ends


def _compute_lookahead_means(
    bucket_starts: np.ndarray,
    bucket_ends: np.ndarray,
    xf: np.ndarray,
    yf: np.ndarray,
    n: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Megaudit G2 (2026-05-13): extracted for testability. The
    lookahead point for bucket `i` is the MEAN of the points in the
    NEXT bucket (Steinarsson 2013 spec). The lookahead's start/end
    range is `[bucket_ends[i], avg_ends[i])`.

    Degenerate handling: when `avg_starts[i] == avg_ends[i]` (the next
    bucket is empty), the Steinarsson spec says use the next bucket's
    first point. **The current `_compute_bucket_bounds` provably
    cannot produce zero-width windows for valid `lttb_indices` inputs
    (`3 <= threshold < n`)** — both Opus and Codex audits independently
    confirmed this via brute-force scans (G2 audit, 2026-05-13). The
    degenerate branch is therefore DEFENSIVE-ONLY: a future helper
    caller that feeds hand-crafted bounds, or a refactor that loosens
    the bucket-bounds invariant, would land here without producing
    cumsum-leaked output.

    For the FINAL bucket, lookahead is the last point (the spec's
    "anchor for the last triangle is the explicitly-included final
    point"). Set unconditionally at the bottom of this function.
    """
    t2 = bucket_starts.shape[0]
    avg_starts = bucket_ends.copy()
    avg_ends = np.empty_like(avg_starts)
    avg_ends[:-1] = bucket_ends[1:]
    avg_ends[-1] = n

    cum_x = np.concatenate(([0.0], np.cumsum(xf)))
    cum_y = np.concatenate(([0.0], np.cumsum(yf)))
    win_lens = (avg_ends - avg_starts).astype(np.int64)

    # Compute the mean per window. For zero-width windows, the divisor
    # is forced to 1 to avoid div/0; the resulting value is then
    # overwritten by the degenerate fallback below.
    safe_lens = np.where(win_lens == 0, 1, win_lens).astype(np.float64)
    avg_x = (cum_x[avg_ends] - cum_x[avg_starts]) / safe_lens
    avg_y = (cum_y[avg_ends] - cum_y[avg_starts]) / safe_lens

    # Degenerate fallback: use the next bucket's first point. For the
    # final bucket the next-bucket equivalent is the last point, which
    # we set below regardless of degeneracy.
    if t2 > 0:
        degenerate = win_lens == 0
        if degenerate.any():
            next_start = np.empty(t2, dtype=np.int64)
            next_start[:-1] = bucket_starts[1:]
            next_start[-1] = n - 1
            avg_x[degenerate] = xf[next_start[degenerate]]
            avg_y[degenerate] = yf[next_start[degenerate]]

    avg_x[-1] = xf[-1]
    avg_y[-1] = yf[-1]
    return avg_x, avg_y


def lttb_indices(
    xs: np.ndarray,
    ys: np.ndarray,
    threshold: int,
) -> np.ndarray:
    """Return the LTTB-selected INDICES into (xs, ys) — the building block
    for multi-column decimation (e.g. carrying OHLCV columns alongside
    a decimated close-series).

    Same edge cases as `lttb`: when threshold >= len(xs) or threshold < 3,
    returns `np.arange(len(xs))`.
    """
    if xs.shape != ys.shape or xs.ndim != 1:
        raise ValueError(
            f"xs and ys must be 1D arrays of equal shape, got {xs.shape} vs {ys.shape}"
        )
    n = xs.shape[0]
    if threshold >= n or threshold < 3:
        return np.arange(n, dtype=np.int64)

    if xs.dtype.kind in ("i", "u", "M"):
        xf = xs.astype(np.float64, copy=False)
    else:
        xf = xs.astype(np.float64, copy=False)
    yf = ys.astype(np.float64, copy=False)

    bucket_starts, bucket_ends = _compute_bucket_bounds(n, threshold)
    # Megaudit G2 audit (2026-05-13): the integer-bounds invariant
    # `bucket_ends[i] < bucket_ends[i+1]` ensures no lookahead window
    # is zero-width, which means `_compute_lookahead_means`'s
    # degenerate fallback is never exercised via this path. Pin
    # explicitly so a future refactor that loosens bucket-bounds
    # math fails here rather than silently sliding into the
    # defensive branch.
    if __debug__:
        assert bucket_starts.shape == bucket_ends.shape
        if bucket_starts.shape[0] > 1:
            assert (np.diff(bucket_ends) > 0).all(), (
                f"bucket_ends must be strictly increasing for n={n}, t={threshold}"
            )
    avg_x, avg_y = _compute_lookahead_means(bucket_starts, bucket_ends, xf, yf, n)

    out_idx = np.empty(threshold, dtype=np.int64)
    out_idx[0] = 0
    out_idx[threshold - 1] = n - 1
    anchor = 0
    for i in range(threshold - 2):
        b_start = bucket_starts[i]
        b_end = bucket_ends[i]
        if b_end <= b_start:
            out_idx[i + 1] = b_start
            anchor = b_start
            continue
        ax = xf[anchor]; ay = yf[anchor]
        cx = avg_x[i]; cy = avg_y[i]
        bx = xf[b_start:b_end]; by = yf[b_start:b_end]
        areas = np.abs((ax - cx) * (by - ay) - (ax - bx) * (cy - ay))
        areas = np.where(np.isnan(areas), 0.0, areas)
        local_max = int(np.argmax(areas))
        chosen = int(b_start) + local_max
        out_idx[i + 1] = chosen
        anchor = chosen
    return out_idx


def lttb(
    xs: np.ndarray,
    ys: np.ndarray,
    threshold: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Return (xs', ys') with len <= threshold, preserving first/last and shape.

    Inputs:
      xs, ys: 1D arrays of equal length. xs is monotonic (typically time).
      threshold: target output length, > 2.

    Output:
      Two arrays of length min(len(xs), threshold), with the same dtypes as inputs.

    Edge cases:
      - threshold >= len(xs) or threshold == 0: returns inputs unchanged.
      - threshold < 3: returns inputs unchanged (LTTB is undefined below 3).
      - NaN in ys: propagated; if a bucket contains all-NaN ys, that bucket
        falls back to picking the first point. (Production filters NaN earlier.)
    """
    idx = lttb_indices(xs, ys, threshold)
    return xs[idx], ys[idx]


def decimate_for_viewport(
    xs: np.ndarray,
    ys: np.ndarray,
    viewport_pixels: int,
    points_per_pixel: float = 2.0,
) -> Tuple[np.ndarray, np.ndarray]:
    """Decimate based on viewport width rather than absolute count.

    Codex's review correctly noted: "100k is the wrong threshold". On a
    1600-pixel-wide chart, the human eye can't differentiate more than ~3000
    points per series; rendering more is wasted work and visual noise.

    points_per_pixel=2.0 gives a slight oversample for retina-density displays
    and to retain micro-features that would otherwise alias.
    """
    target = max(64, int(viewport_pixels * points_per_pixel))
    return lttb(xs, ys, target)
