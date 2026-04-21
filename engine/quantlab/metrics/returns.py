"""
Return Calculations.

Calculates various return metrics from equity curves.

Spec Reference: Technical Spec §7.1
"""

import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Sequence


@dataclass
class ReturnMetrics:
    """Complete return metrics."""

    total_return: Decimal
    annualized_return: Decimal
    total_return_pct: Decimal
    annualized_return_pct: Decimal
    periods: int
    trading_days: int


def simple_returns(equity: Sequence[Decimal]) -> list[Decimal]:
    """
    Calculate simple period returns.

    R_t = (E_t - E_{t-1}) / E_{t-1}

    Args:
        equity: Equity curve values

    Returns:
        List of simple returns (length = len(equity) - 1)
    """
    if len(equity) < 2:
        return []

    returns = []
    for i in range(1, len(equity)):
        if equity[i - 1] == Decimal("0"):
            returns.append(Decimal("0"))
        else:
            r = (equity[i] - equity[i - 1]) / equity[i - 1]
            returns.append(r)

    return returns


def log_returns(equity: Sequence[Decimal]) -> list[Decimal]:
    """
    Calculate logarithmic returns.

    r_t = ln(E_t / E_{t-1})

    Args:
        equity: Equity curve values

    Returns:
        List of log returns
    """
    if len(equity) < 2:
        return []

    returns = []
    for i in range(1, len(equity)):
        if equity[i - 1] <= Decimal("0") or equity[i] <= Decimal("0"):
            returns.append(Decimal("0"))
        else:
            r = Decimal(str(math.log(float(equity[i] / equity[i - 1]))))
            returns.append(r)

    return returns


def total_return(
    initial_equity_or_curve: Decimal | Sequence[Decimal],
    final_equity: Decimal | None = None,
) -> Decimal:
    """
    Calculate total return.

    Can be called with:
    - total_return(initial_equity, final_equity) - direct values
    - total_return(equity_curve) - calculates from curve

    Args:
        initial_equity_or_curve: Starting equity or full equity curve
        final_equity: Ending equity (None if passing curve)

    Returns:
        Total return as decimal (0.1 = 10%)
    """
    # Check if we got an equity curve (sequence) or a direct value
    if isinstance(initial_equity_or_curve, Sequence) and not isinstance(initial_equity_or_curve, str):
        # Equity curve passed
        equity = initial_equity_or_curve
        if len(equity) < 2:
            return Decimal("0")
        initial = equity[0]
        final = equity[-1]
    else:
        # Direct values passed
        initial = initial_equity_or_curve
        final = final_equity if final_equity is not None else initial

    if initial == Decimal("0"):
        return Decimal("0")

    return (final - initial) / initial


def annualized_return(
    total_return: Decimal,
    periods: int,
    periods_per_year: int = 252,
) -> Decimal:
    """
    Calculate annualized return from total return.

    CAGR = (1 + total_return)^(periods_per_year/periods) - 1

    Args:
        total_return: Total return as decimal
        periods: Number of periods
        periods_per_year: Periods per year (252 for daily)

    Returns:
        Annualized return
    """
    if periods <= 0:
        return Decimal("0")

    try:
        factor = Decimal(str(float(total_return) + 1))
        exponent = Decimal(str(periods_per_year)) / Decimal(str(periods))
        annualized = Decimal(str(float(factor) ** float(exponent))) - Decimal("1")
        return annualized
    except (ValueError, OverflowError):
        return Decimal("0")


def cumulative_returns(returns: Sequence[Decimal]) -> list[Decimal]:
    """
    Calculate cumulative returns.

    Args:
        returns: Simple returns

    Returns:
        Cumulative returns (starting at 0)
    """
    cumulative = [Decimal("0")]

    for r in returns:
        prev = cumulative[-1]
        cum_r = (Decimal("1") + prev) * (Decimal("1") + r) - Decimal("1")
        cumulative.append(cum_r)

    return cumulative


def rolling_returns(
    equity: Sequence[Decimal],
    window: int,
) -> list[Decimal]:
    """
    Calculate rolling returns over window.

    Args:
        equity: Equity curve
        window: Rolling window size

    Returns:
        Rolling returns
    """
    if len(equity) < window:
        return []

    returns = []
    for i in range(window, len(equity)):
        if equity[i - window] == Decimal("0"):
            returns.append(Decimal("0"))
        else:
            r = (equity[i] - equity[i - window]) / equity[i - window]
            returns.append(r)

    return returns


def excess_returns(
    returns: Sequence[Decimal],
    risk_free_rate: Decimal,
    periods_per_year: int = 252,
) -> list[Decimal]:
    """
    Calculate excess returns over risk-free rate.

    Args:
        returns: Simple returns
        risk_free_rate: Annual risk-free rate
        periods_per_year: Periods per year

    Returns:
        Excess returns
    """
    period_rf = risk_free_rate / Decimal(str(periods_per_year))
    return [r - period_rf for r in returns]


def mean_return(returns: Sequence[Decimal]) -> Decimal:
    """Calculate mean return."""
    if not returns:
        return Decimal("0")
    return sum(returns) / Decimal(str(len(returns)))


def geometric_mean_return(returns: Sequence[Decimal]) -> Decimal:
    """
    Calculate geometric mean return.

    More accurate for compounding returns.
    """
    if not returns:
        return Decimal("0")

    product = Decimal("1")
    for r in returns:
        product *= (Decimal("1") + r)

    try:
        geo_mean = Decimal(str(float(product) ** (1 / len(returns)))) - Decimal("1")
        return geo_mean
    except (ValueError, OverflowError):
        return Decimal("0")


def calculate_return_metrics(
    equity: Sequence[Decimal],
    periods_per_year: int = 252,
) -> ReturnMetrics:
    """
    Calculate complete return metrics.

    Args:
        equity: Equity curve
        periods_per_year: Periods per year

    Returns:
        ReturnMetrics with all calculations
    """
    if len(equity) < 2:
        return ReturnMetrics(
            total_return=Decimal("0"),
            annualized_return=Decimal("0"),
            total_return_pct=Decimal("0"),
            annualized_return_pct=Decimal("0"),
            periods=0,
            trading_days=0,
        )

    initial = equity[0]
    final = equity[-1]
    periods = len(equity) - 1

    total_ret = total_return(initial, final)
    annual_ret = annualized_return(total_ret, periods, periods_per_year)

    return ReturnMetrics(
        total_return=total_ret,
        annualized_return=annual_ret,
        total_return_pct=total_ret * Decimal("100"),
        annualized_return_pct=annual_ret * Decimal("100"),
        periods=periods,
        trading_days=periods,
    )
