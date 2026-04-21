"""
Report Schema Module.

Defines report schemas for PDF and HTML export per §17.4.

Spec Reference: Technical Spec §17.4
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from typing import Any


@dataclass
class DateRange:
    """Date range for report."""

    start: datetime
    end: datetime

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
        }


@dataclass
class ProvenanceInfo:
    """
    Provenance information for audit trail.

    Required per §17.4 for reproducibility.
    """

    strategy_hash: str
    data_rev: str
    environment_hash: str
    run_id: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "strategyHash": self.strategy_hash,
            "dataRev": self.data_rev,
            "environmentHash": self.environment_hash,
            "runId": self.run_id,
        }


@dataclass
class ReportSummary:
    """Summary statistics for report."""

    date_range: DateRange
    initial_capital: Decimal
    final_equity: Decimal
    total_return: Decimal
    sharpe_ratio: Decimal
    max_drawdown: Decimal
    trade_count: int

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "dateRange": self.date_range.to_dict(),
            "initialCapital": str(self.initial_capital),
            "finalEquity": str(self.final_equity),
            "totalReturn": str(self.total_return),
            "sharpeRatio": str(self.sharpe_ratio),
            "maxDrawdown": str(self.max_drawdown),
            "tradeCount": self.trade_count,
        }


@dataclass
class ChartSpec:
    """Specification for embedded chart."""

    chart_type: str  # "equity", "drawdown", "returns", etc.
    width: int = 800
    height: int = 400
    format: str = "png"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": self.chart_type,
            "width": self.width,
            "height": self.height,
            "format": self.format,
        }


@dataclass
class MetricsTableRow:
    """Single row in metrics table."""

    metric_name: str
    value: str
    benchmark_value: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "metricName": self.metric_name,
            "value": self.value,
        }
        if self.benchmark_value is not None:
            result["benchmarkValue"] = self.benchmark_value
        return result


@dataclass
class TradeTableRow:
    """Single row in trades table."""

    date: datetime
    symbol: str
    side: str
    quantity: str
    price: str
    pnl: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "date": self.date.isoformat(),
            "symbol": self.symbol,
            "side": self.side,
            "quantity": self.quantity,
            "price": self.price,
            "pnl": self.pnl,
        }


@dataclass
class Disclaimer:
    """
    Required legal disclaimer per Product Spec §11.2.

    Must be included in all exported reports.
    """

    text: str = (
        "DISCLAIMER: This report is for informational purposes only. "
        "Past performance is not indicative of future results. "
        "Backtest results are hypothetical and do not represent actual trading. "
        "Trading involves substantial risk of loss."
    )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {"text": self.text}


@dataclass
class ReportFooter:
    """Footer configuration for report."""

    page_numbers: bool = True
    confidentiality: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {"pageNumbers": self.page_numbers}
        if self.confidentiality:
            result["confidentiality"] = self.confidentiality
        return result


@dataclass
class ReportHeader:
    """Header for report."""

    title: str
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    quantlab_version: str = "10.0.0"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "title": self.title,
            "generatedAt": self.generated_at.isoformat(),
            "quantlabVersion": self.quantlab_version,
        }


@dataclass
class PDFReportSchema:
    """
    PDF report schema per §17.4.

    Defines the complete structure for PDF export.
    """

    version: str = "1.0"
    header: ReportHeader = field(default_factory=lambda: ReportHeader(title="Backtest Report"))
    provenance: ProvenanceInfo | None = None
    summary: ReportSummary | None = None
    equity_chart: ChartSpec = field(default_factory=lambda: ChartSpec(chart_type="equity"))
    metrics_table: list[MetricsTableRow] = field(default_factory=list)
    trades_table: list[TradeTableRow] = field(default_factory=list)
    trades_max_rows: int = 100  # First/last 50 if > 100
    disclaimer: Disclaimer = field(default_factory=Disclaimer)
    footer: ReportFooter = field(default_factory=ReportFooter)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "version": self.version,
            "header": self.header.to_dict(),
            "disclaimer": self.disclaimer.to_dict(),
            "footer": self.footer.to_dict(),
        }

        if self.provenance:
            result["provenance"] = self.provenance.to_dict()

        if self.summary:
            result["summary"] = self.summary.to_dict()

        result["equityChart"] = self.equity_chart.to_dict()
        result["metricsTable"] = {
            "columns": ["metricName", "value", "benchmarkValue"],
            "rows": [row.to_dict() for row in self.metrics_table],
        }

        # Apply max rows limit for trades
        trades = self.trades_table
        if len(trades) > self.trades_max_rows:
            half = self.trades_max_rows // 2
            trades = trades[:half] + trades[-half:]

        result["tradesTable"] = {
            "columns": ["date", "symbol", "side", "quantity", "price", "pnl"],
            "rows": [row.to_dict() for row in trades],
            "maxRows": self.trades_max_rows,
            "totalTrades": len(self.trades_table),
        }

        return result


@dataclass
class HTMLReportSchema:
    """
    HTML report schema per §17.4.

    Defines the complete structure for HTML export.
    """

    version: str = "1.0"
    title: str = "Backtest Report"
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    run_id: str = ""
    quantlab_version: str = "10.0.0"

    # Content sections
    provenance: ProvenanceInfo | None = None
    summary: ReportSummary | None = None
    metrics: list[MetricsTableRow] = field(default_factory=list)
    trades: list[TradeTableRow] = field(default_factory=list)
    equity_data: list[dict[str, Any]] = field(default_factory=list)

    # Styling
    theme: str = "light"
    include_charts: bool = True

    # Disclaimer
    disclaimer: Disclaimer = field(default_factory=Disclaimer)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "version": self.version,
            "title": self.title,
            "generatedAt": self.generated_at.isoformat(),
            "runId": self.run_id,
            "quantlabVersion": self.quantlab_version,
            "provenance": self.provenance.to_dict() if self.provenance else None,
            "summary": self.summary.to_dict() if self.summary else None,
            "metrics": [row.to_dict() for row in self.metrics],
            "trades": [row.to_dict() for row in self.trades],
            "equityData": self.equity_data,
            "theme": self.theme,
            "includeCharts": self.include_charts,
            "disclaimer": self.disclaimer.to_dict(),
        }

    def generate_meta_tags(self) -> str:
        """
        Generate HTML meta tags per §17.4.

        Returns:
            HTML string with meta tags
        """
        return f"""<meta charset="utf-8">
<meta name="generator" content="Quantlab {self.quantlab_version}">
<meta name="created" content="{self.generated_at.isoformat()}">
<meta name="run-id" content="{self.run_id}">"""


def create_report_summary(
    metrics: dict[str, Any],
    date_range: tuple[datetime, datetime],
) -> ReportSummary:
    """
    Create ReportSummary from metrics dictionary.

    Args:
        metrics: Performance metrics
        date_range: Start and end dates

    Returns:
        ReportSummary instance
    """
    return ReportSummary(
        date_range=DateRange(start=date_range[0], end=date_range[1]),
        initial_capital=Decimal(str(metrics.get("initial_capital", 100000))),
        final_equity=Decimal(str(metrics.get("final_equity", 0))),
        total_return=Decimal(str(metrics.get("total_return", 0))),
        sharpe_ratio=Decimal(str(metrics.get("sharpe_ratio", 0))),
        max_drawdown=Decimal(str(metrics.get("max_drawdown", 0))),
        trade_count=int(metrics.get("total_trades", 0)),
    )


def create_metrics_table(metrics: dict[str, Any]) -> list[MetricsTableRow]:
    """
    Create metrics table rows from metrics dictionary.

    Args:
        metrics: Performance metrics

    Returns:
        List of MetricsTableRow
    """
    # Standard metric names for display
    metric_names = {
        "total_return": "Total Return",
        "cagr": "CAGR",
        "sharpe_ratio": "Sharpe Ratio",
        "sortino_ratio": "Sortino Ratio",
        "max_drawdown": "Max Drawdown",
        "win_rate": "Win Rate",
        "profit_factor": "Profit Factor",
        "avg_trade": "Average Trade",
        "total_trades": "Total Trades",
    }

    rows = []
    for key, display_name in metric_names.items():
        if key in metrics:
            value = metrics[key]
            # Format percentages
            if key in ("total_return", "cagr", "max_drawdown", "win_rate"):
                if isinstance(value, (int, float)):
                    value = f"{value * 100:.2f}%"
            elif isinstance(value, (int, float)):
                value = f"{value:.4f}" if isinstance(value, float) else str(value)
            else:
                value = str(value)

            rows.append(MetricsTableRow(metric_name=display_name, value=value))

    return rows


def create_trades_table(trades: list[dict[str, Any]]) -> list[TradeTableRow]:
    """
    Create trades table rows from trades list.

    Args:
        trades: List of trade records

    Returns:
        List of TradeTableRow
    """
    rows = []
    for trade in trades:
        # Parse date
        date = trade.get("exit_time") or trade.get("entry_time")
        if isinstance(date, str):
            date = datetime.fromisoformat(date.replace("Z", "+00:00"))
        elif not isinstance(date, datetime):
            date = datetime.now(timezone.utc)

        rows.append(
            TradeTableRow(
                date=date,
                symbol=str(trade.get("symbol", "")),
                side=str(trade.get("side", "")),
                quantity=str(trade.get("quantity", "")),
                price=str(trade.get("exit_price", trade.get("entry_price", ""))),
                pnl=str(trade.get("pnl", "")),
            )
        )

    return rows
