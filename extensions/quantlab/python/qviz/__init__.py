"""Quantlab Visualise (qviz) — Python package.

The package has two faces:

  - The query daemon (`qviz.daemon`, `qviz.reader`, `qviz.compiler`,
    `qviz.cache`, `qviz.ipc`, `qviz.security`, `qviz.decimate`): the
    VS Code extension talks to a long-running Python process that
    reads parquet/csv/tsv, compiles validated `.qviz.json` specs to
    DuckDB SQL, and streams Arrow IPC / JSON rows back.

  - The preset API (`qviz.candlestick`, `qviz.equity_curve`, ...): a
    thin Python surface that turns a pandas DataFrame into a `.qviz.json`
    + parquet pair, ready to open in the VS Code custom editor.

Preset usage:

    >>> import qviz
    >>> import pandas as pd
    >>> df = pd.DataFrame({
    ...     "time": pd.date_range("2026-01-01", periods=3, freq="D"),
    ...     "open":  [100, 101, 102],
    ...     "high":  [101, 102, 103],
    ...     "low":   [99,  100, 101],
    ...     "close": [101, 102, 103],
    ... })
    >>> qviz.candlestick(df, "out/example")  # doctest: +SKIP
    PosixPath('.../out/example.qviz.json')

The output stem is resolved relative to the current working directory,
which is treated as the workspace root (the VS Code daemon resolves
`dataset.uri` against the workspace root). The caller must `cd` to the
workspace root before invoking the preset; the preset rejects absolute
paths and stems whose basename contains `.`.
"""

from __future__ import annotations

from .presets import (
    candlestick,
    drawdown,
    equity_curve,
    factor_exposure,
    pnl_by_strategy,
)

__all__ = [
    "candlestick",
    "drawdown",
    "equity_curve",
    "factor_exposure",
    "pnl_by_strategy",
]
