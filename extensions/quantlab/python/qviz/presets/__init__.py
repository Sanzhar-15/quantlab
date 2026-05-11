"""Preset functions that emit canonical `.qviz.json` files.

Each preset takes a pandas DataFrame and an output stem (relative to CWD,
which is treated as the workspace root) and writes two files:

    <stem>.parquet     # the data
    <stem>.qviz.json   # the visualisation spec

Stem rules: no extension, no `.` in the basename, no `..` segments, no
absolute paths. The preset adds `.parquet` / `.qviz.json` via string
concat (not `Path.with_suffix`), so a stem like `BTC.USD` is rejected
loudly instead of silently producing mismatched filenames.

All presets accept `overwrite=False` by default and refuse to clobber
existing files at the output paths.
"""

from __future__ import annotations

from .candlestick import candlestick
from .drawdown import drawdown
from .equity_curve import equity_curve
from .factor_exposure import factor_exposure
from .pnl_by_strategy import pnl_by_strategy

__all__ = [
    "candlestick",
    "drawdown",
    "equity_curve",
    "factor_exposure",
    "pnl_by_strategy",
]
