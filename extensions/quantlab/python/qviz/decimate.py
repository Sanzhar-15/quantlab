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

    bucket_size = (n - 2) / (threshold - 2)
    bucket_starts = np.floor(np.arange(threshold - 2) * bucket_size).astype(np.int64) + 1
    bucket_ends = np.floor((np.arange(threshold - 2) + 1) * bucket_size).astype(np.int64) + 1
    bucket_ends = np.minimum(bucket_ends, n - 1)

    avg_starts = bucket_ends.copy()
    avg_ends = np.minimum(np.roll(bucket_ends, -1), n)
    avg_ends[-1] = n

    cum_x = np.concatenate(([0.0], np.cumsum(xf)))
    cum_y = np.concatenate(([0.0], np.cumsum(yf)))
    win_lens = (avg_ends - avg_starts).astype(np.float64)
    avg_x = (cum_x[avg_ends] - cum_x[avg_starts]) / np.maximum(win_lens, 1)
    avg_y = (cum_y[avg_ends] - cum_y[avg_starts]) / np.maximum(win_lens, 1)
    avg_x[-1] = xf[-1]
    avg_y[-1] = yf[-1]

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
