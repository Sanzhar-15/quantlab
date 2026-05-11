"""qviz.equity_curve — emit a `.qviz.json` for an equity-over-time line chart.

Required columns: time_col (temporal), equity_col (numeric).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

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

_GENERATOR = make_generator_string("equity_curve")


def equity_curve(
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
    """Write `<output>.parquet` + `<output>.qviz.json` for a line chart.

    Args:
      df: DataFrame with temporal `time_col` and numeric `equity_col`.
      output: stem (no extension, no `.` in basename) relative to CWD.
      time_col / equity_col: column names. Subject to isAcceptableString +
        nonempty validation.
      title, description, timezone: optional metadata; validated.
      decimation: chart.options.decimation.
      overwrite: if False (default), refuses to clobber existing files.
    """
    check_column_name(time_col, "time_col")
    check_column_name(equity_col, "equity_col")
    check_decimation(decimation)
    check_acceptable_string(timezone, "timezone", allow_empty=False)
    check_bool(overwrite, "overwrite")
    if time_col == equity_col:
        raise ValueError(
            f"qviz.equity_curve: time_col and equity_col must differ "
            f"(both are {time_col!r})"
        )

    require_columns_typed(df, [
        (time_col, "temporal"),
        (equity_col, "numeric"),
    ], "qviz.equity_curve")

    # Normalize inf/-inf to NaN so the on-disk parquet is the single
    # source of truth across Arrow IPC and JSON wire paths.
    df = df.copy()
    df[equity_col] = normalize_finite_floats(df[equity_col])

    abs_stem, uri_stem = resolve_output_under_cwd(output)
    parquet_path, spec_path, parquet_uri = derive_paths(abs_stem, uri_stem)
    check_overwrite(parquet_path, spec_path, overwrite)

    write_parquet_atomic(df, parquet_path)
    dataset = compute_dataset_block(parquet_path, parquet_uri)

    chart: dict[str, Any] = {
        "family": "timeseries",
        "type": "line",
        "encodings": {
            "x": {"field": time_col, "type": "temporal"},
            "y": {"field": equity_col, "type": "quantitative"},
        },
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
