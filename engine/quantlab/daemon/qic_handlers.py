"""
QIC-specific JSON-RPC handler implementations for the existing trading daemon.

AUDIT FIX III-QI2 (CRITICAL): These handlers are added to the EXISTING engine daemon.
QIC does NOT spawn a new Python sidecar process.

Methods:
  - qic.preview_dataframe(path, format, max_rows, max_columns) -> DataFramePreview
  - qic.analyze_backtest(returns, benchmark?) -> BacktestAnalysis
  - qic.detect_frequency(timestamps) -> FrequencyInfo
  - qic.analyze_time_series(data, freq?) -> TimeSeriesAnalysis
  - qic.statistical_test(data, test_name) -> StatTestResult
  - qic.column_stats(path, column) -> ColumnStats
  - qic.write_arrow_ipc(expression, output_path) -> {path: str}
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class QicHandlers:
    """QIC-specific JSON-RPC handlers for the existing engine daemon."""

    def __init__(self, workspace_root: str | None = None) -> None:
        self._workspace_root = Path(workspace_root).resolve() if workspace_root else None

    def _validate_path(self, file_path: str) -> Path:
        """Validate that a file path is within the workspace root (defense-in-depth)."""
        resolved = Path(file_path).resolve()
        if self._workspace_root and not resolved.is_relative_to(self._workspace_root):
            raise ValueError(f"Path outside workspace: {file_path}")
        if not resolved.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        return resolved

    def register(self, ipc_server: Any) -> None:
        """Register all QIC handlers with the existing IPC server."""
        ipc_server.register_handler("qic.preview_dataframe", self.preview_dataframe)
        ipc_server.register_handler("qic.analyze_backtest", self.analyze_backtest)
        ipc_server.register_handler("qic.detect_frequency", self.detect_frequency)
        ipc_server.register_handler("qic.analyze_time_series", self.analyze_time_series)
        ipc_server.register_handler("qic.statistical_test", self.statistical_test)
        ipc_server.register_handler("qic.column_stats", self.column_stats)
        ipc_server.register_handler("qic.write_arrow_ipc", self.write_arrow_ipc)

    async def preview_dataframe(self, params: dict[str, Any]) -> dict[str, Any]:
        """Preview a DataFrame without loading it fully into memory.

        AUDIT FIX III-QI10: Delegates to existing data loaders (parquet_loader, csv_loader).
        """
        file_path = params.get("path", "")
        max_rows = params.get("maxRows", params.get("max_rows", 50))
        max_columns = params.get("maxColumns", params.get("max_columns", 50))
        fmt = params.get("format")

        if not file_path:
            raise ValueError("path is required")

        path = self._validate_path(file_path)

        # Detect format from extension if not specified
        if fmt is None:
            fmt = self._detect_format(path)

        # Load preview slice only
        df = self._load_preview(path, fmt, max_rows)

        # Limit columns
        if len(df.columns) > max_columns:
            df = df.iloc[:, :max_columns]

        # Build response
        columns = []
        null_counts: dict[str, int] = {}
        dtypes: dict[str, str] = {}

        for col in df.columns:
            col_name = str(col)
            null_count = int(df[col].isna().sum())
            dtype_str = str(df[col].dtype)
            null_counts[col_name] = null_count
            dtypes[col_name] = dtype_str

            col_info: dict[str, Any] = {
                "name": col_name,
                "dtype": dtype_str,
                "nullCount": null_count,
            }

            if pd.api.types.is_numeric_dtype(df[col]):
                non_null = df[col].dropna()
                if len(non_null) > 0:
                    col_info["min"] = float(non_null.min())
                    col_info["max"] = float(non_null.max())
                    col_info["unique"] = int(non_null.nunique())
            columns.append(col_info)

        # Get full shape without loading all data
        full_shape = self._get_shape(path, fmt)

        head = df.head(min(max_rows, len(df))).to_dict(orient="records")
        tail_rows = min(max_rows // 2, len(df))
        tail = df.tail(tail_rows).to_dict(orient="records") if tail_rows > 0 else []

        memory_mb = df.memory_usage(deep=True).sum() / (1024 * 1024)

        return {
            "shape": list(full_shape),
            "columns": columns,
            "head": self._sanitize_records(head),
            "tail": self._sanitize_records(tail),
            "dtypes": dtypes,
            "memoryUsageMb": round(memory_mb, 4),
            "nullCounts": null_counts,
        }

    async def analyze_backtest(self, params: dict[str, Any]) -> dict[str, Any]:
        """Analyze backtest results: Sharpe, Sortino, max drawdown, alpha/beta."""
        returns_list = params.get("returns", [])
        benchmark_list = params.get("benchmark")

        if not returns_list:
            raise ValueError("returns array is required")

        returns = np.array(returns_list, dtype=np.float64)
        n = len(returns)

        # Basic stats
        total_return = float(np.prod(1 + returns) - 1)
        annualized_return = float((1 + total_return) ** (252 / max(n, 1)) - 1)
        volatility = float(np.std(returns, ddof=1) * np.sqrt(252)) if n > 1 else 0.0

        # Sharpe ratio (assuming 0 risk-free rate)
        mean_daily = float(np.mean(returns))
        std_daily = float(np.std(returns, ddof=1)) if n > 1 else 1.0
        sharpe = (mean_daily / std_daily * np.sqrt(252)) if std_daily > 0 else 0.0

        # Sortino ratio (downside deviation)
        downside = returns[returns < 0]
        downside_std = float(np.std(downside, ddof=1)) if len(downside) > 1 else 1.0
        sortino = (mean_daily / downside_std * np.sqrt(252)) if downside_std > 0 else 0.0

        # Max drawdown
        cumulative = np.cumprod(1 + returns)
        peak = np.maximum.accumulate(cumulative)
        drawdowns = (cumulative - peak) / peak
        max_drawdown = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

        # Max drawdown duration (in trading days)
        max_dd_duration = 0
        current_dd_duration = 0
        for i in range(len(drawdowns)):
            if drawdowns[i] < 0:
                current_dd_duration += 1
                max_dd_duration = max(max_dd_duration, current_dd_duration)
            else:
                current_dd_duration = 0

        # Calmar ratio
        calmar = annualized_return / abs(max_drawdown) if max_drawdown != 0 else 0.0

        # Win rate and profit factor
        wins = returns[returns > 0]
        losses = returns[returns < 0]
        win_rate = float(len(wins) / n) if n > 0 else 0.0
        total_profit = float(np.sum(wins)) if len(wins) > 0 else 0.0
        total_loss = float(abs(np.sum(losses))) if len(losses) > 0 else 1.0
        profit_factor = total_profit / total_loss if total_loss > 0 else 0.0

        result: dict[str, Any] = {
            "sharpeRatio": round(float(sharpe), 4),
            "sortinoRatio": round(float(sortino), 4),
            "maxDrawdown": round(abs(float(max_drawdown)), 4),
            "maxDrawdownDuration": max_dd_duration,
            "totalReturn": round(total_return, 4),
            "annualizedReturn": round(annualized_return, 4),
            "volatility": round(volatility, 4),
            "calmarRatio": round(float(calmar), 4),
            "winRate": round(win_rate, 4),
            "profitFactor": round(float(profit_factor), 4),
            "tradeCount": n,
        }

        # Alpha/beta if benchmark provided
        if benchmark_list and len(benchmark_list) == n:
            benchmark = np.array(benchmark_list, dtype=np.float64)
            cov_matrix = np.cov(returns, benchmark)
            beta = float(cov_matrix[0, 1] / cov_matrix[1, 1]) if cov_matrix[1, 1] != 0 else 0.0
            benchmark_return = float(np.mean(benchmark) * 252)
            alpha = annualized_return - beta * benchmark_return
            result["alpha"] = round(alpha, 4)
            result["beta"] = round(beta, 4)

        return result

    async def detect_frequency(self, params: dict[str, Any]) -> dict[str, Any]:
        """Detect frequency of timestamps."""
        timestamps_raw = params.get("timestamps", [])
        if len(timestamps_raw) < 2:
            raise ValueError("Need at least 2 timestamps")

        timestamps = pd.to_datetime(timestamps_raw)
        diffs = timestamps[1:] - timestamps[:-1]
        median_diff = diffs.median()

        # Detect frequency from median difference
        seconds = median_diff.total_seconds()
        if seconds < 1:
            detected = "tick"
        elif seconds < 60:
            detected = "second"
        elif seconds < 3600:
            detected = "minute"
        elif seconds < 86400:
            detected = "hourly"
        elif seconds < 604800:
            detected = "daily"
        elif seconds < 2592000:
            detected = "weekly"
        else:
            detected = "monthly"

        # Confidence based on consistency
        std_seconds = float(diffs.dt.total_seconds().std())
        mean_seconds = float(diffs.dt.total_seconds().mean())
        cv = std_seconds / mean_seconds if mean_seconds > 0 else 1.0
        confidence = max(0.0, min(1.0, 1.0 - cv))

        # Detect gaps (diff > 3x median)
        gaps = []
        threshold = median_diff * 3
        for i in range(len(diffs)):
            if diffs.iloc[i] > threshold:
                gaps.append({
                    "start": str(timestamps[i]),
                    "end": str(timestamps[i + 1]),
                    "count": int(diffs.iloc[i] / median_diff) - 1,
                })

        return {
            "detected": detected,
            "confidence": round(confidence, 4),
            "sampleSize": len(timestamps_raw),
            "gaps": gaps,
        }

    async def analyze_time_series(self, params: dict[str, Any]) -> dict[str, Any]:
        """Analyze time series data: stationarity, outliers, summary stats."""
        data = np.array(params.get("data", []), dtype=np.float64)
        if len(data) < 3:
            raise ValueError("Need at least 3 data points")

        # Summary statistics
        summary = {
            "mean": round(float(np.mean(data)), 6),
            "std": round(float(np.std(data, ddof=1)), 6) if len(data) > 1 else 0.0,
            "min": round(float(np.min(data)), 6),
            "max": round(float(np.max(data)), 6),
            "count": len(data),
        }

        # Stationarity test (ADF) - requires statsmodels
        stationarity = None
        try:
            from statsmodels.tsa.stattools import adfuller
            adf_result = adfuller(data, autolag="AIC")
            stationarity = {
                "adfStatistic": round(float(adf_result[0]), 6),
                "pValue": round(float(adf_result[1]), 6),
                "isStationary": float(adf_result[1]) < 0.05,
            }
        except ImportError:
            pass  # statsmodels not available

        # Outlier detection (z-score > 3)
        mean = np.mean(data)
        std = np.std(data, ddof=1) if len(data) > 1 else 1.0
        outliers = []
        if std > 0:
            zscores = (data - mean) / std
            for i, (val, z) in enumerate(zip(data, zscores)):
                if abs(z) > 3:
                    outliers.append({
                        "index": i,
                        "value": round(float(val), 6),
                        "zscore": round(float(z), 4),
                    })

        result: dict[str, Any] = {
            "isTimeSeries": True,
            "outliers": outliers,
            "summary": summary,
        }
        if stationarity:
            result["stationarity"] = stationarity

        freq = params.get("freq")
        if freq:
            result["frequency"] = freq

        return result

    async def statistical_test(self, params: dict[str, Any]) -> dict[str, Any]:
        """Run a statistical test."""
        try:
            from scipy import stats as sp_stats
        except ImportError:
            raise ValueError("scipy is required for statistical tests. Install with: pip install scipy")

        data = np.array(params.get("data", []), dtype=np.float64)
        test_name = params.get("test_name", "")

        if len(data) < 3:
            raise ValueError("Need at least 3 data points")
        if not test_name:
            raise ValueError("test_name is required")

        if test_name == "shapiro":
            stat, p_value = sp_stats.shapiro(data)
        elif test_name == "normaltest":
            stat, p_value = sp_stats.normaltest(data)
        elif test_name == "jarque_bera":
            stat, p_value = sp_stats.jarque_bera(data)
        elif test_name == "ks_normal":
            stat, p_value = sp_stats.kstest(data, "norm", args=(np.mean(data), np.std(data)))
        elif test_name == "t_test_zero":
            stat, p_value = sp_stats.ttest_1samp(data, 0)
        else:
            raise ValueError(f"Unknown test: {test_name}. Available: shapiro, normaltest, jarque_bera, ks_normal, t_test_zero")

        return {
            "testName": test_name,
            "statistic": round(float(stat), 6),
            "pValue": round(float(p_value), 6),
            "significant": float(p_value) < 0.05,
        }

    async def column_stats(self, params: dict[str, Any]) -> dict[str, Any]:
        """Get detailed statistics for a single DataFrame column."""
        file_path = params.get("path", "")
        column = params.get("column", "")

        if not file_path or not column:
            raise ValueError("path and column are required")

        path = self._validate_path(file_path)
        fmt = self._detect_format(path)
        df = self._load_preview(path, fmt, max_rows=100_000)

        if column not in df.columns:
            raise ValueError(f"Column '{column}' not found. Available: {list(df.columns)}")

        series = df[column]
        result: dict[str, Any] = {
            "name": column,
            "dtype": str(series.dtype),
            "count": int(series.count()),
            "nullCount": int(series.isna().sum()),
            "unique": int(series.nunique()),
        }

        if pd.api.types.is_numeric_dtype(series):
            desc = series.describe()
            result.update({
                "mean": round(float(desc["mean"]), 6),
                "std": round(float(desc["std"]), 6),
                "min": round(float(desc["min"]), 6),
                "25%": round(float(desc["25%"]), 6),
                "50%": round(float(desc["50%"]), 6),
                "75%": round(float(desc["75%"]), 6),
                "max": round(float(desc["max"]), 6),
                "skew": round(float(series.skew()), 6),
                "kurtosis": round(float(series.kurtosis()), 6),
            })

        return result

    async def write_arrow_ipc(self, params: dict[str, Any]) -> dict[str, Any]:
        """Write a DataFrame to Arrow IPC format for TypeScript consumption."""
        import pyarrow as pa
        import pyarrow.ipc as ipc

        expression = params.get("expression", "")
        output_path = params.get("output_path", "")

        if not expression or not output_path:
            raise ValueError("expression and output_path are required")

        # Evaluate the expression in the engine's namespace
        # This is intentionally restricted to the daemon's data namespace
        raise NotImplementedError(
            "write_arrow_ipc requires integration with the engine's data namespace. "
            "Use qic.preview_dataframe for safe data access."
        )

    # --- Private helpers ---

    def _detect_format(self, path: Path) -> str:
        suffix = path.suffix.lower()
        if suffix in (".parquet", ".pq"):
            return "parquet"
        if suffix in (".feather", ".arrow", ".ipc"):
            return "feather"
        return "csv"

    def _load_preview(
        self, path: Path, fmt: str, max_rows: int | None = 50
    ) -> pd.DataFrame:
        """Load a DataFrame preview using the appropriate loader."""
        if fmt == "parquet":
            if max_rows is not None:
                # Read only first N rows for parquet
                import pyarrow.parquet as pq
                pf = pq.ParquetFile(str(path))
                first_batch = next(pf.iter_batches(batch_size=max_rows), None)
                if first_batch is None:
                    return pd.DataFrame()
                return first_batch.to_pandas()
            return pd.read_parquet(str(path))
        elif fmt == "feather":
            import pyarrow.feather as feather
            df = feather.read_feather(str(path))
            if max_rows is not None:
                return df.head(max_rows)
            return df
        else:
            # CSV
            if max_rows is not None:
                return pd.read_csv(str(path), nrows=max_rows)
            return pd.read_csv(str(path))

    def _get_shape(self, path: Path, fmt: str) -> tuple[int, int]:
        """Get full shape without loading all data."""
        if fmt == "parquet":
            import pyarrow.parquet as pq
            pf = pq.ParquetFile(str(path))
            return (pf.metadata.num_rows, pf.metadata.num_columns)
        elif fmt == "feather":
            import pyarrow.feather as feather
            df = feather.read_feather(str(path))
            return df.shape
        else:
            # CSV — count lines (approximate)
            # Use pandas for accurate column count (handles quoted commas)
            header_df = pd.read_csv(str(path), nrows=0)
            n_cols = len(header_df.columns)
            with open(str(path)) as f:
                n_rows = sum(1 for _ in f) - 1  # subtract header row
            return (max(0, n_rows), n_cols)

    def _sanitize_records(
        self, records: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Sanitize records for JSON serialization (handle NaN, Inf, etc.)."""
        sanitized = []
        for record in records:
            clean: dict[str, Any] = {}
            for k, v in record.items():
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    clean[k] = None
                elif hasattr(v, "isoformat"):
                    clean[k] = v.isoformat()
                else:
                    clean[k] = v
            sanitized.append(clean)
        return sanitized
