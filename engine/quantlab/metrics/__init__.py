"""
Metrics calculation module.

Provides:
- Return series calculation (simple returns on total equity)
- Risk-adjusted metrics (Sharpe, Sortino, Calmar)
- Trade metrics (win rate, profit factor)
- Drawdown calculations
- Stability score (R-squared)
- Annualization factors per calendar

Spec Reference: Technical Spec §7
"""

from .drawdown import DrawdownMetrics
from .drawdown import DrawdownPeriod
from .drawdown import calculate_drawdown_metrics
from .drawdown import drawdown_series
from .drawdown import identify_drawdown_periods
from .drawdown import max_drawdown
from .drawdown import max_drawdown_duration
from .drawdown import ulcer_index
from .drawdown import underwater_curve
from .returns import ReturnMetrics
from .returns import annualized_return
from .returns import calculate_return_metrics
from .returns import cumulative_returns
from .returns import geometric_mean_return
from .returns import log_returns
from .returns import mean_return
from .returns import rolling_returns
from .returns import simple_returns
from .returns import total_return
from .risk import CRYPTO_TRADING_DAYS_PER_YEAR
from .risk import EQUITY_TRADING_DAYS_PER_YEAR
from .risk import MONTHLY_PERIODS_PER_YEAR
from .risk import RiskMetrics
from .risk import WEEKLY_PERIODS_PER_YEAR
from .risk import calmar_ratio
from .risk import calculate_risk_metrics
from .risk import conditional_var
from .risk import downside_deviation
from .risk import information_ratio
from .risk import omega_ratio
from .risk import sharpe_ratio
from .risk import sortino_ratio
from .risk import standard_deviation
from .risk import value_at_risk
from .risk import volatility
from .stability import StabilityMetrics
from .stability import calculate_stability_metrics
from .stability import common_sense_ratio
from .stability import gain_to_pain_ratio
from .stability import kelly_criterion
from .stability import kurtosis
from .stability import r_squared
from .stability import recovery_factor
from .stability import skewness
from .stability import stability_score
from .stability import tail_ratio
from .trade import Trade
from .trade import TradeMetrics
from .trade import avg_holding_period
from .trade import calculate_trade_metrics
from .trade import consecutive_losses
from .trade import consecutive_wins
from .trade import expectancy
from .trade import loss_rate
from .trade import payoff_ratio
from .trade import profit_factor
from .trade import sqn
from .trade import win_rate
from .annualize import (
    MarketType,
    AnnualizationConfig,
    MARKET_CONFIGS,
    DEFAULT_TRADING_DAYS_PER_YEAR,
    DEFAULT_TRADING_HOURS_PER_DAY,
    SQRT_252,
    SQRT_365,
    get_annualization_factor,
    annualize_return,
    annualize_volatility,
    calculate_sharpe_ratio as compute_sharpe_ratio,
    calculate_sortino_ratio as compute_sortino_ratio,
    get_market_config,
)

__all__ = [
    # Return metrics
    "ReturnMetrics",
    "simple_returns",
    "log_returns",
    "total_return",
    "annualized_return",
    "cumulative_returns",
    "rolling_returns",
    "mean_return",
    "geometric_mean_return",
    "calculate_return_metrics",
    # Constants
    "EQUITY_TRADING_DAYS_PER_YEAR",
    "CRYPTO_TRADING_DAYS_PER_YEAR",
    "WEEKLY_PERIODS_PER_YEAR",
    "MONTHLY_PERIODS_PER_YEAR",
    # Risk metrics
    "RiskMetrics",
    "standard_deviation",
    "volatility",
    "downside_deviation",
    "sharpe_ratio",
    "sortino_ratio",
    "calmar_ratio",
    "omega_ratio",
    "information_ratio",
    "value_at_risk",
    "conditional_var",
    "calculate_risk_metrics",
    # Drawdown metrics
    "DrawdownPeriod",
    "DrawdownMetrics",
    "drawdown_series",
    "max_drawdown",
    "max_drawdown_duration",
    "underwater_curve",
    "identify_drawdown_periods",
    "ulcer_index",
    "calculate_drawdown_metrics",
    # Trade metrics
    "Trade",
    "TradeMetrics",
    "win_rate",
    "loss_rate",
    "profit_factor",
    "payoff_ratio",
    "expectancy",
    "sqn",
    "consecutive_wins",
    "consecutive_losses",
    "avg_holding_period",
    "calculate_trade_metrics",
    # Stability metrics
    "StabilityMetrics",
    "r_squared",
    "stability_score",
    "skewness",
    "kurtosis",
    "tail_ratio",
    "common_sense_ratio",
    "gain_to_pain_ratio",
    "recovery_factor",
    "kelly_criterion",
    "calculate_stability_metrics",
    # Annualization utilities
    "MarketType",
    "AnnualizationConfig",
    "MARKET_CONFIGS",
    "DEFAULT_TRADING_DAYS_PER_YEAR",
    "DEFAULT_TRADING_HOURS_PER_DAY",
    "SQRT_252",
    "SQRT_365",
    "get_annualization_factor",
    "annualize_return",
    "annualize_volatility",
    "compute_sharpe_ratio",
    "compute_sortino_ratio",
    "get_market_config",
    # Custom metrics registry (FIX-E005)
    "register_metric",
    "unregister_metric",
    "get_metric",
    "list_custom_metrics",
    "calculate_all_metrics",
]


# =============================================================================
# Custom Metrics Registry (FIX-E005)
# =============================================================================

from decimal import Decimal
from typing import Any, Callable

# Registry for custom metrics
_custom_metrics: dict[str, Callable[[Any], Decimal | float]] = {}


def register_metric(name: str, func: Callable[[Any], Decimal | float]) -> None:
    """
    Register a custom metric function (FIX-E005).

    The function should accept a BacktestResult and return a Decimal or float.

    Example:
        def my_metric(result):
            return Decimal(str(len(result.trades)))

        register_metric("trade_count", my_metric)

    Args:
        name: Metric name (must be unique)
        func: Function that takes a result and returns a numeric value

    Raises:
        ValueError: If metric name already registered
    """
    if name in _custom_metrics:
        raise ValueError(f"Metric '{name}' is already registered")
    _custom_metrics[name] = func


def unregister_metric(name: str) -> bool:
    """
    Unregister a custom metric.

    Args:
        name: Metric name to remove

    Returns:
        True if metric was removed, False if not found
    """
    if name in _custom_metrics:
        del _custom_metrics[name]
        return True
    return False


def get_metric(name: str) -> Callable[[Any], Decimal | float]:
    """
    Get a metric function by name.

    Checks custom metrics first, then built-in metrics.

    Args:
        name: Metric name

    Returns:
        Metric calculation function

    Raises:
        ValueError: If metric not found
    """
    if name in _custom_metrics:
        return _custom_metrics[name]

    # Check built-in metrics
    builtin = {
        "sharpe": sharpe_ratio,
        "sortino": sortino_ratio,
        "calmar": calmar_ratio,
        "max_drawdown": max_drawdown,
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "sqn": sqn,
        "expectancy": expectancy,
        "volatility": volatility,
        "total_return": total_return,
    }

    if name in builtin:
        return builtin[name]

    raise ValueError(f"Unknown metric: {name}")


def list_custom_metrics() -> list[str]:
    """List all registered custom metric names."""
    return list(_custom_metrics.keys())


def calculate_all_metrics(
    result: Any,
    include_custom: bool = True,
    include_builtin: bool = True,
) -> dict[str, Decimal | float]:
    """
    Calculate all registered metrics for a backtest result.

    Args:
        result: Backtest result object
        include_custom: Include custom metrics
        include_builtin: Include built-in metrics

    Returns:
        Dictionary of metric name -> value
    """
    import logging
    logger = logging.getLogger(__name__)

    metrics: dict[str, Decimal | float] = {}

    # Calculate built-in metrics
    if include_builtin and hasattr(result, "equity_curve") and result.equity_curve:
        try:
            returns = simple_returns(result.equity_curve)
            if returns:
                metrics["sharpe"] = sharpe_ratio(returns)
                metrics["sortino"] = sortino_ratio(returns)
                metrics["volatility"] = volatility(returns)
            metrics["max_drawdown"] = max_drawdown(result.equity_curve)
            metrics["total_return"] = total_return(result.equity_curve)
        except Exception as e:
            logger.warning(f"Error calculating built-in metrics: {e}")

    if include_builtin and hasattr(result, "trades") and result.trades:
        try:
            pnls = [t.pnl if hasattr(t, "pnl") else Decimal("0") for t in result.trades]
            metrics["win_rate"] = win_rate(pnls)
            metrics["profit_factor"] = profit_factor(pnls)
            metrics["expectancy"] = expectancy(pnls)
        except Exception as e:
            logger.warning(f"Error calculating trade metrics: {e}")

    # Calculate custom metrics
    if include_custom:
        for name, func in _custom_metrics.items():
            try:
                metrics[name] = func(result)
            except Exception as e:
                logger.warning(f"Custom metric '{name}' failed: {e}")

    return metrics
