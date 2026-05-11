"""qviz.pnl_by_strategy — emit a `.qviz.json` for a PnL-by-strategy bar chart.

Default aggregates with sum and sorts descending; pass aggregate=False
for caller-pre-aggregated data.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from ._common import (
    check_acceptable_string,
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

_GENERATOR = make_generator_string("pnl_by_strategy")


def pnl_by_strategy(
    df: pd.DataFrame,
    output: str | Path,
    *,
    strategy_col: str = "strategy",
    pnl_col: str = "pnl",
    title: str | None = None,
    description: str | None = None,
    aggregate: bool = True,
    overwrite: bool = False,
) -> Path:
    """Bar chart of PnL by strategy.

    With `aggregate=True` (default), the spec contains a
    groupby+aggregate(fn=sum)+sort(desc) pipeline; rows with the same
    strategy collapse to a single bar. With `aggregate=False` the spec
    has no transforms (caller-pre-aggregated input).

    Required columns: strategy_col (string/categorical), pnl_col (numeric).
    """
    check_column_name(strategy_col, "strategy_col")
    check_column_name(pnl_col, "pnl_col")
    check_bool(aggregate, "aggregate")
    check_bool(overwrite, "overwrite")
    if strategy_col == pnl_col:
        raise ValueError(
            f"qviz.pnl_by_strategy: strategy_col and pnl_col must differ "
            f"(both are {strategy_col!r})"
        )
    y_field = f"{pnl_col}_sum" if aggregate else pnl_col
    if aggregate and y_field == strategy_col:
        raise ValueError(
            f"qviz.pnl_by_strategy: derived alias {y_field!r} collides with "
            f"strategy_col; rename one of them"
        )

    require_columns_typed(df, [
        (strategy_col, "nominal"),
        (pnl_col, "numeric"),
    ], "qviz.pnl_by_strategy")

    # Normalize inf so JSON / Arrow wire paths agree on the on-disk values.
    df = df.copy()
    df[pnl_col] = normalize_finite_floats(df[pnl_col])

    abs_stem, uri_stem = resolve_output_under_cwd(output)
    parquet_path, spec_path, parquet_uri = derive_paths(abs_stem, uri_stem)
    check_overwrite(parquet_path, spec_path, overwrite)

    write_parquet_atomic(df, parquet_path)
    dataset = compute_dataset_block(parquet_path, parquet_uri)

    transforms: list[dict[str, Any]] = []
    if aggregate:
        transforms.extend([
            {"kind": "groupby", "columns": [strategy_col]},
            {"kind": "aggregate", "aggs": [
                {"column": pnl_col, "fn": "sum", "as": y_field},
            ]},
            # Secondary key on strategy_col asc for deterministic tie-break
            # (DuckDB ORDER BY isn't stable under parallel execution).
            {"kind": "sort", "columns": [
                {"column": y_field, "desc": True},
                {"column": strategy_col, "desc": False},
            ]},
        ])

    chart: dict[str, Any] = {
        "family": "general",
        "type": "bar",
        "encodings": {
            "x": {"field": strategy_col, "type": "nominal"},
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
