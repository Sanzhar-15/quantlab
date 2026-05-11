"""qviz.candlestick — emit a candlestick `.qviz.json` for an OHLCV DataFrame.

Required columns: time (datetime-like), open/high/low/close (numeric).
Optional column: volume (numeric).

The preset adds an implicit ascending sort by time so an unsorted
DataFrame doesn't render as crossed candles. Caller's `limit=` argument
applies AFTER the sort, so the first-N candles are the earliest in time.
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
    check_limit,
    check_overwrite,
    compute_dataset_block,
    derive_paths,
    make_generator_string,
    require_columns_typed,
    resolve_output_under_cwd,
    write_parquet_atomic,
)
from ._spec_builder import build_qviz_spec, write_spec

_GENERATOR = make_generator_string("candlestick")


def candlestick(
    df: pd.DataFrame,
    output: str | Path,
    *,
    title: str | None = None,
    description: str | None = None,
    timezone: str = "UTC",
    decimation: DecimationLiteral = "auto",
    limit: int | None = None,
    overwrite: bool = False,
) -> Path:
    """Write `<output>.parquet` + `<output>.qviz.json` for a candlestick chart.

    Args:
      df: DataFrame with columns time/open/high/low/close (volume optional).
      output: stem (no extension, no `.` in basename) relative to CWD.
      title, description: optional spec metadata. Validated against the
        TS validator's string rules (≤ 4 KiB, no NUL, no C0 controls).
      timezone: trading_options.timezone (default "UTC"); free string.
      decimation: chart.options.decimation. Runtime-validated.
      limit: optional row cap added as a `limit` transform AFTER the
        implicit sort. Range [1, 10_000_000]; bool rejected.
      overwrite: if False (default), refuses to clobber existing files.

    Returns:
      Path to the written `.qviz.json`.
    """
    check_decimation(decimation)
    check_acceptable_string(timezone, "timezone", allow_empty=False)
    check_bool(overwrite, "overwrite")
    if limit is not None:
        check_limit(limit, "limit")

    require_columns_typed(df, [
        ("time", "temporal"),
        ("open", "numeric"),
        ("high", "numeric"),
        ("low", "numeric"),
        ("close", "numeric"),
    ], "qviz.candlestick")
    if "volume" in df.columns and not _is_numeric_or_absent(df, "volume"):
        raise TypeError(
            "qviz.candlestick: column 'volume' must be numeric "
            f"(got dtype {df['volume'].dtype!r})"
        )

    abs_stem, uri_stem = resolve_output_under_cwd(output)
    parquet_path, spec_path, parquet_uri = derive_paths(abs_stem, uri_stem)
    check_overwrite(parquet_path, spec_path, overwrite)

    write_parquet_atomic(df, parquet_path)
    dataset = compute_dataset_block(parquet_path, parquet_uri)

    ohlcv: dict[str, str] = {
        "time": "time",
        "open": "open",
        "high": "high",
        "low": "low",
        "close": "close",
    }
    if "volume" in df.columns:
        ohlcv["volume"] = "volume"

    chart: dict[str, Any] = {
        "family": "timeseries",
        "type": "candlestick",
        "encodings": {"ohlcv": ohlcv},
        "options": {"decimation": decimation},
    }

    # Implicit sort BEFORE limit so the first-N candles are the earliest
    # in time, not whatever order the parquet readers happened to spit out.
    transforms: list[dict[str, Any]] = [
        {"kind": "sort", "columns": [{"column": "time", "desc": False}]},
    ]
    if limit is not None:
        transforms.append({"kind": "limit", "n": int(limit)})

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


def _is_numeric_or_absent(df: pd.DataFrame, col: str) -> bool:
    if col not in df.columns:
        return True
    s = df[col]
    return pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s)
