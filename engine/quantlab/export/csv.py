"""
CSV Export Module.

Exports backtest results to CSV format for spreadsheet analysis.

Spec Reference: Technical Spec §17.4
"""

import csv
from datetime import datetime
from decimal import Decimal
from io import StringIO
from pathlib import Path
from typing import Any


class CSVExporter:
    """
    CSV export for backtest results.

    Produces two CSV files:
    - trades.csv: Individual trade records
    - metrics.csv: Summary metrics
    """

    # Trade columns in order
    TRADE_COLUMNS = [
        "trade_id",
        "symbol",
        "side",
        "quantity",
        "entry_price",
        "exit_price",
        "entry_time",
        "exit_time",
        "pnl",
        "pnl_percent",
        "commission",
        "holding_period_bars",
    ]

    # Metric columns in order
    METRIC_COLUMNS = [
        "metric",
        "value",
    ]

    def __init__(self) -> None:
        pass

    def export_trades(
        self,
        output_path: Path,
        trades: list[dict[str, Any]],
    ) -> Path:
        """
        Export trades to CSV file.

        Args:
            output_path: Path to write CSV file
            trades: List of trade records

        Returns:
            Path to written file
        """
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=self.TRADE_COLUMNS,
                extrasaction="ignore",
            )
            writer.writeheader()

            for trade in trades:
                row = self._serialize_trade(trade)
                writer.writerow(row)

        return output_path

    def export_trades_string(self, trades: list[dict[str, Any]]) -> str:
        """Export trades to CSV string."""
        output = StringIO()
        writer = csv.DictWriter(
            output,
            fieldnames=self.TRADE_COLUMNS,
            extrasaction="ignore",
        )
        writer.writeheader()

        for trade in trades:
            row = self._serialize_trade(trade)
            writer.writerow(row)

        return output.getvalue()

    def export_metrics(
        self,
        output_path: Path,
        metrics: dict[str, Any],
    ) -> Path:
        """
        Export metrics to CSV file.

        Args:
            output_path: Path to write CSV file
            metrics: Performance metrics dictionary

        Returns:
            Path to written file
        """
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(self.METRIC_COLUMNS)

            for key, value in metrics.items():
                writer.writerow([key, self._format_value(value)])

        return output_path

    def export_metrics_string(self, metrics: dict[str, Any]) -> str:
        """Export metrics to CSV string."""
        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(self.METRIC_COLUMNS)

        for key, value in metrics.items():
            writer.writerow([key, self._format_value(value)])

        return output.getvalue()

    def export_equity_curve(
        self,
        output_path: Path,
        equity_curve: list[dict[str, Any]],
    ) -> Path:
        """
        Export equity curve to CSV file.

        Args:
            output_path: Path to write CSV file
            equity_curve: List of equity curve points

        Returns:
            Path to written file
        """
        if not equity_curve:
            return output_path

        columns = list(equity_curve[0].keys())

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=columns)
            writer.writeheader()

            for point in equity_curve:
                row = {k: self._format_value(v) for k, v in point.items()}
                writer.writerow(row)

        return output_path

    def _serialize_trade(self, trade: dict[str, Any]) -> dict[str, Any]:
        """Serialize trade record for CSV."""
        result = {}
        for col in self.TRADE_COLUMNS:
            value = trade.get(col, "")
            result[col] = self._format_value(value)
        return result

    def _format_value(self, value: Any) -> str:
        """Format value for CSV output."""
        if value is None:
            return ""
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, float):
            if value != value:  # NaN check
                return ""
            return f"{value:.6f}"
        return str(value)


def export_trades_csv(
    output_path: Path | str,
    trades: list[dict[str, Any]],
) -> Path:
    """
    Convenience function to export trades to CSV.

    Args:
        output_path: Path for output file
        trades: Trade records

    Returns:
        Path to written file
    """
    exporter = CSVExporter()
    output_path = Path(output_path)
    return exporter.export_trades(output_path, trades)


def export_metrics_csv(
    output_path: Path | str,
    metrics: dict[str, Any],
) -> Path:
    """
    Convenience function to export metrics to CSV.

    Args:
        output_path: Path for output file
        metrics: Performance metrics

    Returns:
        Path to written file
    """
    exporter = CSVExporter()
    output_path = Path(output_path)
    return exporter.export_metrics(output_path, metrics)
