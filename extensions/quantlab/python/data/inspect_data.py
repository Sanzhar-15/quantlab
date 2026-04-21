#!/usr/bin/env python3
"""
Data file inspection utilities for QuantLab.
Provides column info, preview data, and basic statistics for CSV, Parquet, and Excel files.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load_dataframe(file_path: str):
    """Load a data file into a pandas DataFrame."""
    import pandas as pd

    path = Path(file_path)
    suffix = path.suffix.lower()

    if suffix == '.csv':
        return pd.read_csv(file_path)
    elif suffix == '.parquet':
        return pd.read_parquet(file_path)
    elif suffix in ('.xlsx', '.xls'):
        return pd.read_excel(file_path)
    else:
        raise ValueError(f"Unsupported file format: {suffix}")


def get_column_info(df) -> list[dict[str, Any]]:
    """Extract column information from a DataFrame."""
    columns = []

    for col in df.columns:
        info: dict[str, Any] = {
            'name': str(col),
            'dtype': str(df[col].dtype),
            'nullCount': int(df[col].isna().sum()),
            'uniqueCount': int(df[col].nunique())
        }

        # Add min/max for numeric columns
        if df[col].dtype in ('float64', 'int64', 'float32', 'int32'):
            info['min'] = float(df[col].min()) if not df[col].isna().all() else None
            info['max'] = float(df[col].max()) if not df[col].isna().all() else None

        # Add sample values
        sample_vals = df[col].dropna().head(5).tolist()
        # Convert to JSON-serializable types
        info['sampleValues'] = [
            float(v) if isinstance(v, (int, float)) and not isinstance(v, bool)
            else str(v) for v in sample_vals
        ]

        columns.append(info)

    return columns


def get_preview(df, sample_size: int = 100) -> dict[str, Any]:
    """Get a preview of the data."""
    import math

    sample = df.head(sample_size)

    # Convert to records, handling NaN and special types
    records = []
    for _, row in sample.iterrows():
        record = {}
        for col in df.columns:
            val = row[col]
            if isinstance(val, float) and math.isnan(val):
                record[str(col)] = None
            elif isinstance(val, (int, float)) and not isinstance(val, bool):
                record[str(col)] = float(val)
            else:
                record[str(col)] = str(val)
        records.append(record)

    return {
        'rows': len(df),
        'sample': records
    }


def get_statistics(df) -> dict[str, Any]:
    """Get basic statistics for numeric columns."""
    stats = {}

    for col in df.columns:
        if df[col].dtype in ('float64', 'int64', 'float32', 'int32'):
            col_stats = df[col].describe()
            stats[str(col)] = {
                'count': int(col_stats.get('count', 0)),
                'mean': float(col_stats.get('mean', 0)),
                'std': float(col_stats.get('std', 0)),
                'min': float(col_stats.get('min', 0)),
                'q25': float(col_stats.get('25%', 0)),
                'median': float(col_stats.get('50%', 0)),
                'q75': float(col_stats.get('75%', 0)),
                'max': float(col_stats.get('max', 0))
            }

    return stats


def detect_date_column(df) -> str | None:
    """Find datetime column or parse date-like column."""
    import pandas as pd

    # Check for datetime64 columns
    datetime_cols = [col for col in df.columns if pd.api.types.is_datetime64_any_dtype(df[col])]
    if datetime_cols:
        return datetime_cols[0]

    # Heuristic column name matching
    date_keywords = ['date', 'time', 'timestamp', 'datetime', 'Date', 'Time']
    for col in df.columns:
        if any(kw in str(col) for kw in date_keywords):
            try:
                pd.to_datetime(df[col], errors='raise')
                return str(col)
            except:
                continue

    # Try first column if looks date-like
    if len(df.columns) > 0:
        first_col = df.columns[0]
        if len(df) > 0:
            sample = str(df[first_col].iloc[0])
            if '-' in sample or '/' in sample:
                try:
                    pd.to_datetime(df[first_col], errors='raise')
                    return str(first_col)
                except:
                    pass

    return None


def get_date_range(df, date_column: str) -> dict[str, Any] | None:
    """Extract min/max dates from column."""
    import pandas as pd

    try:
        dates = pd.to_datetime(df[date_column], errors='coerce').dropna()
        if len(dates) == 0:
            return None

        return {
            'dateColumn': date_column,
            'start': dates.min().strftime('%Y-%m-%d'),
            'end': dates.max().strftime('%Y-%m-%d')
        }
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description='Inspect data files')
    parser.add_argument('file', help='Path to data file')
    parser.add_argument('--action', choices=['columns', 'preview', 'stats', 'all'],
                        default='all', help='Action to perform')
    parser.add_argument('--sample-size', type=int, default=100,
                        help='Number of rows for preview')

    args = parser.parse_args()

    try:
        df = load_dataframe(args.file)

        result: dict[str, Any] = {}

        if args.action in ('columns', 'all'):
            result['columns'] = get_column_info(df)

        if args.action in ('preview', 'all'):
            result['preview'] = get_preview(df, args.sample_size)

        if args.action in ('stats', 'all'):
            result['statistics'] = get_statistics(df)

        # Always try to detect date range if columns are included
        if args.action in ('columns', 'all'):
            date_col = detect_date_column(df)
            if date_col:
                date_range = get_date_range(df, date_col)
                if date_range:
                    result['dateRange'] = date_range

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({
            'error': str(e),
            'type': type(e).__name__
        }), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
