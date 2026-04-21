"""
JSON Export Module.

Exports backtest results to JSON format for programmatic access.

Spec Reference: Technical Spec §17.4
"""

import json
from dataclasses import dataclass, asdict
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from pathlib import Path
from typing import Any


@dataclass
class ExportMetadata:
    """Metadata for exported report."""

    version: str = "1.0"
    exported_at: str = ""
    strategy_file: str = ""
    strategy_name: str = ""
    quantlab_version: str = ""

    def __post_init__(self) -> None:
        if not self.exported_at:
            self.exported_at = datetime.now(timezone.utc).isoformat()


@dataclass
class TradeRecord:
    """Single trade record for export."""

    trade_id: str
    symbol: str
    side: str
    quantity: str
    entry_price: str
    exit_price: str
    entry_time: str
    exit_time: str
    pnl: str
    pnl_percent: str
    commission: str
    holding_period_bars: int


@dataclass
class PerformanceMetrics:
    """Performance metrics for export."""

    total_return: str
    cagr: str
    sharpe_ratio: str
    sortino_ratio: str
    max_drawdown: str
    max_drawdown_duration: int
    win_rate: str
    profit_factor: str
    average_trade: str
    total_trades: int
    winning_trades: int
    losing_trades: int
    average_win: str
    average_loss: str
    largest_win: str
    largest_loss: str
    avg_holding_period: float
    exposure_time: str


@dataclass
class EquityCurvePoint:
    """Single point on equity curve."""

    timestamp: str
    equity: str
    drawdown: str
    benchmark: str | None = None


class JSONExporter:
    """
    JSON export for backtest results.

    Produces a comprehensive JSON file with all results data.
    """

    def __init__(
        self,
        strategy_file: str | None = None,
        strategy_name: str | None = None,
    ) -> None:
        self.metadata = ExportMetadata(
            strategy_file=strategy_file or "",
            strategy_name=strategy_name or "",
            quantlab_version="10.0.0",
        )

    def export(
        self,
        output_path: Path,
        metrics: dict[str, Any],
        trades: list[dict[str, Any]],
        equity_curve: list[dict[str, Any]] | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> Path:
        """
        Export results to JSON file.

        Args:
            output_path: Path to write JSON file
            metrics: Performance metrics dictionary
            trades: List of trade records
            equity_curve: Optional equity curve data
            parameters: Optional strategy parameters

        Returns:
            Path to written file
        """
        export_data = {
            "metadata": asdict(self.metadata),
            "metrics": self._serialize_metrics(metrics),
            "trades": [self._serialize_trade(t) for t in trades],
            "parameters": parameters or {},
        }

        if equity_curve:
            export_data["equity_curve"] = equity_curve

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2, default=self._json_serializer)

        return output_path

    def export_string(
        self,
        metrics: dict[str, Any],
        trades: list[dict[str, Any]],
        equity_curve: list[dict[str, Any]] | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> str:
        """Export to JSON string."""
        export_data = {
            "metadata": asdict(self.metadata),
            "metrics": self._serialize_metrics(metrics),
            "trades": [self._serialize_trade(t) for t in trades],
            "parameters": parameters or {},
        }

        if equity_curve:
            export_data["equity_curve"] = equity_curve

        return json.dumps(export_data, indent=2, default=self._json_serializer)

    def _serialize_metrics(self, metrics: dict[str, Any]) -> dict[str, Any]:
        """Serialize metrics with proper types."""
        result = {}
        for key, value in metrics.items():
            if isinstance(value, Decimal):
                result[key] = str(value)
            elif isinstance(value, datetime):
                result[key] = value.isoformat()
            elif isinstance(value, float) and (value != value):  # NaN check
                result[key] = None
            else:
                result[key] = value
        return result

    def _serialize_trade(self, trade: dict[str, Any]) -> dict[str, Any]:
        """Serialize trade record."""
        result = {}
        for key, value in trade.items():
            if isinstance(value, Decimal):
                result[key] = str(value)
            elif isinstance(value, datetime):
                result[key] = value.isoformat()
            else:
                result[key] = value
        return result

    def _json_serializer(self, obj: Any) -> Any:
        """Custom JSON serializer for special types."""
        if isinstance(obj, Decimal):
            return str(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        if hasattr(obj, "__dict__"):
            return obj.__dict__
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def export_to_json(
    output_path: Path | str,
    metrics: dict[str, Any],
    trades: list[dict[str, Any]],
    strategy_file: str | None = None,
    equity_curve: list[dict[str, Any]] | None = None,
) -> Path:
    """
    Convenience function to export results to JSON.

    Args:
        output_path: Path for output file
        metrics: Performance metrics
        trades: Trade records
        strategy_file: Optional strategy file path
        equity_curve: Optional equity curve data

    Returns:
        Path to written file
    """
    exporter = JSONExporter(strategy_file=strategy_file)
    output_path = Path(output_path)
    return exporter.export(output_path, metrics, trades, equity_curve)
