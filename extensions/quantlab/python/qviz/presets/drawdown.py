"""qviz.drawdown — emit a `.qviz.json` for an area chart of drawdown over time.

Computes drawdown in Python so the on-disk parquet matches the chart
exactly. Drawdown is defined as `equity / running_max - 1` on the
positive-peak ranges and `NaN` everywhere else (including any segment
where running_max ≤ 0, matching the daemon's NULLIF semantics at
`compiler.py:461-466`). Drawdown is always ≤ 0 on the well-defined
regions; undefined regions render as gaps.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ._common import (
    DecimationLiteral,
    check_acceptable_string,
    check_bool,
    check_column_name,
    check_decimation,
    check_overwrite,
    compute_dataset_block,
    derive_paths,
    make_generator_string,
    normalize_finite_floats,
    require_columns_typed,
    resolve_output_under_cwd,
    write_parquet_atomic,
)
from ._spec_builder import build_qviz_spec, write_spec

_GENERATOR = make_generator_string("drawdown")
_DRAWDOWN_COL = "drawdown"


def drawdown(
    df: pd.DataFrame,
    output: str | Path,
    *,
    time_col: str = "time",
    equity_col: str = "equity",
    title: str | None = None,
    description: str | None = None,
    timezone: str = "UTC",
    decimation: DecimationLiteral = "auto",
    overwrite: bool = False,
) -> Path:
    """Write `<output>.parquet` + `<output>.qviz.json` for a drawdown area chart.

    Output parquet has columns [time_col, "drawdown"]. `time_col` and
    `equity_col` must differ AND must not equal "drawdown" (the
    preset-derived column name).
    """
    check_column_name(time_col, "time_col")
    check_column_name(equity_col, "equity_col")
    check_decimation(decimation)
    check_acceptable_string(timezone, "timezone", allow_empty=False)
    check_bool(overwrite, "overwrite")
    if time_col == equity_col:
        raise ValueError(
            f"qviz.drawdown: time_col and equity_col must differ "
            f"(both are {time_col!r})"
        )
    if time_col == _DRAWDOWN_COL:
        raise ValueError(
            f"qviz.drawdown: time_col must not equal {_DRAWDOWN_COL!r} "
            f"(the preset writes a column with that name)"
        )

    require_columns_typed(df, [
        (time_col, "temporal"),
        (equity_col, "numeric"),
    ], "qviz.drawdown")

    # Cast equity to float64 BEFORE any math so the output parquet's dtype
    # is stable regardless of upstream float32/Int64/nullable input. Then
    # normalize inf so the cumulative-max isn't poisoned by an inf peak.
    equity_f64 = pd.to_numeric(df[equity_col], errors="raise").astype("float64")
    equity_f64 = normalize_finite_floats(equity_f64)
    equity_np = equity_f64.to_numpy(copy=False)
    running_max = np.maximum.accumulate(np.where(np.isnan(equity_np), -np.inf, equity_np))
    # Wherever cumulative-max never met a finite positive value, drawdown
    # is undefined. NULLIF-on-zero parity with the daemon (`max <= 0`),
    # plus a guard for `running_max == -inf` (all-NaN prefix).
    valid = np.isfinite(running_max) & (running_max > 0) & np.isfinite(equity_np)
    drawdown_arr = np.full(equity_np.shape, np.nan, dtype="float64")
    np.divide(equity_np, running_max, out=drawdown_arr, where=valid)
    drawdown_arr = np.where(valid, drawdown_arr - 1.0, np.nan)

    df_out = pd.DataFrame({
        time_col: df[time_col].to_numpy(),
        _DRAWDOWN_COL: drawdown_arr,
    })

    abs_stem, uri_stem = resolve_output_under_cwd(output)
    parquet_path, spec_path, parquet_uri = derive_paths(abs_stem, uri_stem)
    check_overwrite(parquet_path, spec_path, overwrite)

    write_parquet_atomic(df_out, parquet_path)
    dataset = compute_dataset_block(parquet_path, parquet_uri)

    chart: dict[str, Any] = {
        "family": "timeseries",
        "type": "area",
        "encodings": {
            "x": {"field": time_col, "type": "temporal"},
            "y": {"field": _DRAWDOWN_COL, "type": "quantitative"},
        },
        # y_axis_zero is honored by the general renderer (general.ts) but
        # not by the timeseries renderer; keeping it as a hint anyway so
        # the spec is self-describing.
        "options": {"decimation": decimation},
    }

    transforms: list[dict[str, Any]] = [
        {"kind": "sort", "columns": [{"column": time_col, "desc": False}]},
    ]

    spec = build_qviz_spec(
        dataset=dataset,
        chart=chart,
        generator=_GENERATOR,
        transforms=transforms,
        title=title,
        description=description,
        trading_options={"timezone": timezone},
    )
    write_spec(spec, spec_path)
    return spec_path
