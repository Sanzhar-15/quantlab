"""
Performance Metrics Types.

Dataclasses for representing performance metrics from backtests.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PerformanceMetrics:
    """
    Comprehensive performance metrics from a backtest.

    All percentage values are stored as percentages (e.g., 15.5 for 15.5%).
    """

    # Return metrics
    total_return: float | None = None
    total_return_pct: float | None = None
    cagr: float | None = None

    # Risk-adjusted metrics
    sharpe_ratio: float | None = None
    sortino_ratio: float | None = None
    calmar_ratio: float | None = None
    omega_ratio: float | None = None

    # Drawdown metrics
    max_drawdown: float | None = None
    max_drawdown_pct: float | None = None
    max_drawdown_duration: int | None = None  # in bars
    avg_drawdown: float | None = None

    # Volatility
    volatility: float | None = None
    downside_deviation: float | None = None

    # Trade metrics
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    win_rate: float | None = None
    profit_factor: float | None = None
    expectancy: float | None = None
    avg_win: float | None = None
    avg_loss: float | None = None
    largest_win: float | None = None
    largest_loss: float | None = None

    # System quality
    sqn: float | None = None  # System Quality Number

    # Stability
    r_squared: float | None = None
    stability_score: float | None = None

    # Holding periods
    avg_holding_period: float | None = None  # in bars
    avg_winning_trade_duration: float | None = None
    avg_losing_trade_duration: float | None = None

    # Exposure
    exposure_time: float | None = None  # percentage of time in market

    def to_dict(self) -> dict[str, Any]:
        """Convert metrics to dictionary."""
        return {
            "total_return": self.total_return,
            "total_return_pct": self.total_return_pct,
            "cagr": self.cagr,
            "sharpe_ratio": self.sharpe_ratio,
            "sortino_ratio": self.sortino_ratio,
            "calmar_ratio": self.calmar_ratio,
            "omega_ratio": self.omega_ratio,
            "max_drawdown": self.max_drawdown,
            "max_drawdown_pct": self.max_drawdown_pct,
            "max_drawdown_duration": self.max_drawdown_duration,
            "avg_drawdown": self.avg_drawdown,
            "volatility": self.volatility,
            "downside_deviation": self.downside_deviation,
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "win_rate": self.win_rate,
            "profit_factor": self.profit_factor,
            "expectancy": self.expectancy,
            "avg_win": self.avg_win,
            "avg_loss": self.avg_loss,
            "largest_win": self.largest_win,
            "largest_loss": self.largest_loss,
            "sqn": self.sqn,
            "r_squared": self.r_squared,
            "stability_score": self.stability_score,
            "avg_holding_period": self.avg_holding_period,
            "exposure_time": self.exposure_time,
        }

    def __str__(self) -> str:
        """Human-readable string representation."""
        lines = ["Performance Metrics:"]

        if self.total_return_pct is not None:
            lines.append(f"  Total Return: {self.total_return_pct:.2f}%")
        if self.sharpe_ratio is not None:
            lines.append(f"  Sharpe Ratio: {self.sharpe_ratio:.3f}")
        if self.sortino_ratio is not None:
            lines.append(f"  Sortino Ratio: {self.sortino_ratio:.3f}")
        if self.max_drawdown_pct is not None:
            lines.append(f"  Max Drawdown: {self.max_drawdown_pct:.2f}%")
        if self.win_rate is not None:
            lines.append(f"  Win Rate: {self.win_rate:.1f}%")
        if self.profit_factor is not None:
            lines.append(f"  Profit Factor: {self.profit_factor:.2f}")
        if self.total_trades:
            lines.append(f"  Total Trades: {self.total_trades}")

        return "\n".join(lines)
