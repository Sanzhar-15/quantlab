"""qviz.factor_exposure — emit a `.qviz.json` for a long-format factor-exposure bar chart.

V1: long-format snapshot — one row per (factor, exposure) point. Default
aggregates with mean and sorts descending; pass aggregate=False for
caller-pre-aggregated data.

Caveat: `aggregate=True` computes an UNWEIGHTED mean of repeated
factor rows. For time-series exposure snapshots with non-uniform
sampling (different lookback windows, different position sizes),
pre-aggregate in the caller's domain logic and pass aggregate=False —
the unweighted preset mean will be misleading otherwise.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from ._common import (
    check_bool,
    check_column_name,
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

_GENERATOR = make_generator_string("factor_exposure")


def factor_exposure(
    df: pd.DataFrame,
    output: str | Path,
    *,
    factor_col: str = "factor",
    exposure_col: str = "exposure",
    title: str | None = None,
    description: str | None = None,
    aggregate: bool = True,
    overwrite: bool = False,
) -> Path:
    """Bar chart of factor exposures (snapshot).

    With `aggregate=True` (default), the spec contains
    groupby+aggregate(fn=mean)+sort(desc) so multiple rows per factor
    average. With `aggregate=False` the spec has no transforms.

    Required columns: factor_col (string/categorical), exposure_col (numeric).
    """
    check_column_name(factor_col, "factor_col")
    check_column_name(exposure_col, "exposure_col")
    check_bool(aggregate, "aggregate")
    check_bool(overwrite, "overwrite")
    if factor_col == exposure_col:
        raise ValueError(
            f"qviz.factor_exposure: factor_col and exposure_col must differ "
            f"(both are {factor_col!r})"
        )
    y_field = f"{exposure_col}_mean" if aggregate else exposure_col
    if aggregate and y_field == factor_col:
        raise ValueError(
            f"qviz.factor_exposure: derived alias {y_field!r} collides with "
            f"factor_col; rename one of them"
        )

    require_columns_typed(df, [
        (factor_col, "nominal"),
        (exposure_col, "numeric"),
    ], "qviz.factor_exposure")

    df = df.copy()
    df[exposure_col] = normalize_finite_floats(df[exposure_col])

    abs_stem, uri_stem = resolve_output_under_cwd(output)
    parquet_path, spec_path, parquet_uri = derive_paths(abs_stem, uri_stem)
    check_overwrite(parquet_path, spec_path, overwrite)

    write_parquet_atomic(df, parquet_path)
    dataset = compute_dataset_block(parquet_path, parquet_uri)

    transforms: list[dict[str, Any]] = []
    if aggregate:
        transforms.extend([
            {"kind": "groupby", "columns": [factor_col]},
            {"kind": "aggregate", "aggs": [
                {"column": exposure_col, "fn": "mean", "as": y_field},
            ]},
            {"kind": "sort", "columns": [
                {"column": y_field, "desc": True},
                {"column": factor_col, "desc": False},
            ]},
        ])

    chart: dict[str, Any] = {
        "family": "general",
        "type": "bar",
        "encodings": {
            "x": {"field": factor_col, "type": "nominal"},
            "y": {"field": y_field, "type": "quantitative"},
        },
    }

    spec = build_qviz_spec(
        dataset=dataset,
        chart=chart,
        generator=_GENERATOR,
        transforms=transforms,
        title=title,
        description=description,
    )
    write_spec(spec, spec_path)
    return spec_path
