"""
Risk-Adjusted Metrics.

Calculates Sharpe, Sortino, Calmar, and other risk-adjusted returns.

Spec Reference: Technical Spec §7.2
"""

from dataclasses import dataclass
from decimal import Decimal
from decimal import localcontext
from typing import Sequence

from quantlab.metrics.returns import mean_return
from quantlab.metrics.returns import simple_returns


# Standard trading days per year constants (centralized to avoid hardcoding)
EQUITY_TRADING_DAYS_PER_YEAR = 252
CRYPTO_TRADING_DAYS_PER_YEAR = 365
WEEKLY_PERIODS_PER_YEAR = 52
MONTHLY_PERIODS_PER_YEAR = 12


def _decimal_sqrt(value: Decimal, precision: int = 28) -> Decimal:
    """
    Compute square root of a Decimal with arbitrary precision.

    Uses Newton-Raphson method for Decimal-safe computation.

    Args:
        value: Non-negative Decimal to compute sqrt of
        precision: Number of decimal places of precision

    Returns:
        Square root as Decimal
    """
    if value < Decimal("0"):
        raise ValueError("Cannot compute sqrt of negative number")

    if value == Decimal("0"):
        return Decimal("0")

    if value == Decimal("1"):
        return Decimal("1")

    with localcontext() as ctx:
        ctx.prec = precision + 2

        if value < Decimal("1"):
            x = value
        else:
            x = value / Decimal("2")

        two = Decimal("2")
        epsilon = Decimal(10) ** -(precision + 1)

        for _ in range(100):
            x_new = (x + value / x) / two
            if abs(x_new - x) < epsilon:
                break
            x = x_new

        return +x.quantize(Decimal(10) ** -precision)


def annualization_factor(periods_per_year: int) -> Decimal:
    """
    Calculate annualization factor from periods per year.

    Args:
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)

    Returns:
        sqrt(periods_per_year) as Decimal
    """
    return _decimal_sqrt(Decimal(str(periods_per_year)))


@dataclass
class RiskMetrics:
    """Complete risk metrics."""

    sharpe_ratio: Decimal
    sortino_ratio: Decimal
    calmar_ratio: Decimal
    volatility: Decimal
    downside_deviation: Decimal
    var_95: Decimal  # Value at Risk 95%
    cvar_95: Decimal  # Conditional VaR 95%
    max_drawdown: Decimal


def standard_deviation(values: Sequence[Decimal]) -> Decimal:
    """
    Calculate standard deviation using sample variance.

    Uses Decimal-safe square root to maintain precision.

    Args:
        values: Sequence of values

    Returns:
        Standard deviation (not annualized)
    """
    if len(values) < 2:
        return Decimal("0")

    mean = sum(values) / Decimal(str(len(values)))

    squared_diffs = [(v - mean) ** 2 for v in values]
    variance = sum(squared_diffs) / Decimal(str(len(values) - 1))

    return _decimal_sqrt(variance)


def volatility(
    returns: Sequence[Decimal],
    periods_per_year: int = 252,
) -> Decimal:
    """
    Calculate annualized volatility.

    Args:
        returns: Period returns
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)

    Returns:
        Annualized volatility
    """
    if len(returns) < 2:
        return Decimal("0")

    std = standard_deviation(returns)
    ann_factor = annualization_factor(periods_per_year)
    return std * ann_factor


def downside_deviation(
    returns: Sequence[Decimal],
    threshold: Decimal = Decimal("0"),
    periods_per_year: int = 252,
    annualize: bool = True,
) -> Decimal:
    """
    Calculate downside deviation.

    Only considers returns below threshold.

    Args:
        returns: Period returns
        threshold: Return threshold (default 0)
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)
        annualize: Whether to annualize the result (default True)

    Returns:
        Downside deviation (annualized by default)
    """
    downside_returns = [
        (r - threshold) ** 2
        for r in returns
        if r < threshold
    ]

    if not downside_returns:
        return Decimal("0")

    downside_var = sum(downside_returns) / Decimal(str(len(returns)))
    downside_std = _decimal_sqrt(downside_var)

    if annualize:
        ann_factor = annualization_factor(periods_per_year)
        return downside_std * ann_factor

    return downside_std


def sharpe_ratio(
    returns: Sequence[Decimal],
    risk_free_rate: Decimal = Decimal("0.02"),  # 2% annual
    periods_per_year: int = 252,
) -> Decimal:
    """
    Calculate Sharpe ratio.

    Sharpe = (Mean_Excess_Return / StdDev) * sqrt(periods_per_year)

    Args:
        returns: Period returns
        risk_free_rate: Annual risk-free rate
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)

    Returns:
        Annualized Sharpe ratio
    """
    if len(returns) < 2:
        return Decimal("0")

    period_rf = risk_free_rate / Decimal(str(periods_per_year))
    excess = [r - period_rf for r in returns]

    mean_excess = mean_return(excess)
    vol = standard_deviation(returns)

    if vol == Decimal("0"):
        return Decimal("0")

    ann_factor = annualization_factor(periods_per_year)
    return (mean_excess / vol) * ann_factor


def sortino_ratio(
    returns: Sequence[Decimal],
    risk_free_rate: Decimal = Decimal("0.02"),
    periods_per_year: int = 252,
) -> Decimal:
    """
    Calculate Sortino ratio.

    Sortino = (Mean_Excess_Return / Downside_Deviation) * sqrt(periods_per_year)

    Better than Sharpe when returns are not normally distributed.

    Args:
        returns: Period returns
        risk_free_rate: Annual risk-free rate
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)

    Returns:
        Annualized Sortino ratio
    """
    if len(returns) < 2:
        return Decimal("0")

    period_rf = risk_free_rate / Decimal(str(periods_per_year))
    excess = [r - period_rf for r in returns]

    mean_excess = mean_return(excess)

    # Get non-annualized downside deviation for correct Sortino calculation
    down_dev = downside_deviation(
        returns,
        threshold=period_rf,
        periods_per_year=periods_per_year,
        annualize=False,  # Don't annualize here, we do it at the end
    )

    if down_dev == Decimal("0"):
        return Decimal("0")

    ann_factor = annualization_factor(periods_per_year)
    return (mean_excess / down_dev) * ann_factor


def calmar_ratio(
    annualized_return_or_equity: Decimal | Sequence[Decimal],
    max_drawdown: Decimal | None = None,
    periods_per_year: int = 252,
) -> Decimal:
    """
    Calculate Calmar ratio.

    Calmar = Annualized_Return / Max_Drawdown

    Can be called with:
    - calmar_ratio(annualized_return, max_drawdown) - direct values
    - calmar_ratio(equity_curve) - calculates from equity curve

    Args:
        annualized_return_or_equity: Annualized return or equity curve
        max_drawdown: Maximum drawdown (positive value), or None if passing equity curve
        periods_per_year: Periods per year for annualization

    Returns:
        Calmar ratio
    """
    # Check if we got an equity curve (sequence) or a direct value
    if isinstance(annualized_return_or_equity, Sequence) and not isinstance(annualized_return_or_equity, str):
        # Equity curve passed - calculate return and drawdown
        equity = annualized_return_or_equity
        if len(equity) < 2:
            return Decimal("0")

        # Calculate annualized return
        from quantlab.metrics.returns import total_return, annualized_return
        total_ret = total_return(equity[0], equity[-1])
        annual_ret = annualized_return(total_ret, len(equity) - 1, periods_per_year)

        # Calculate max drawdown
        from quantlab.metrics.drawdown import max_drawdown as calc_max_dd
        max_dd = calc_max_dd(equity)

        if max_dd == Decimal("0"):
            # Return large finite value for no drawdown (Decimal("inf") doesn't serialize)
            # Use 999999 as sentinel for "excellent" - no drawdown with positive returns
            if annual_ret > Decimal("0"):
                return Decimal("999999")
            return Decimal("0")

        return annual_ret / abs(max_dd)
    else:
        # Direct annualized return value passed
        annualized_ret = annualized_return_or_equity
        if max_drawdown is None or max_drawdown == Decimal("0"):
            # Same handling for zero drawdown
            if annualized_ret > Decimal("0"):
                return Decimal("999999")
            return Decimal("0")

        return annualized_ret / abs(max_drawdown)


def omega_ratio(
    returns: Sequence[Decimal],
    threshold: Decimal = Decimal("0"),
) -> Decimal:
    """
    Calculate Omega ratio.

    Omega = Sum(gains above threshold) / Sum(losses below threshold)

    Args:
        returns: Period returns
        threshold: Return threshold

    Returns:
        Omega ratio (high value like 999999 if no losses)
    """
    if not returns:
        return Decimal("0")

    gains = sum(max(r - threshold, Decimal("0")) for r in returns)
    losses = sum(max(threshold - r, Decimal("0")) for r in returns)

    if losses == Decimal("0"):
        # No losses - return large finite value (serializes better than inf)
        return Decimal("999999") if gains > Decimal("0") else Decimal("0")

    return gains / losses


def information_ratio(
    returns: Sequence[Decimal],
    benchmark_returns: Sequence[Decimal],
    periods_per_year: int = 252,
) -> Decimal:
    """
    Calculate Information ratio.

    IR = (Mean_Excess_Return / Tracking_Error) * sqrt(periods_per_year)

    Args:
        returns: Portfolio returns
        benchmark_returns: Benchmark returns
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)

    Returns:
        Annualized Information ratio

    Raises:
        ValueError: If returns and benchmark_returns have different lengths
    """
    if len(returns) != len(benchmark_returns):
        raise ValueError(
            f"Returns length ({len(returns)}) must equal benchmark length "
            f"({len(benchmark_returns)})"
        )

    if len(returns) < 2:
        return Decimal("0")

    excess = [r - b for r, b in zip(returns, benchmark_returns)]

    mean_excess = mean_return(excess)
    tracking_error = standard_deviation(excess)

    if tracking_error == Decimal("0"):
        return Decimal("0")

    ann_factor = annualization_factor(periods_per_year)
    return (mean_excess / tracking_error) * ann_factor


def value_at_risk(
    returns: Sequence[Decimal],
    confidence: Decimal = Decimal("0.95"),
) -> Decimal:
    """
    Calculate Value at Risk (VaR).

    Historical VaR at specified confidence level.

    Args:
        returns: Period returns
        confidence: Confidence level (0.95 = 95%)

    Returns:
        VaR (positive value = potential loss)
    """
    if not returns:
        return Decimal("0")

    sorted_returns = sorted(returns)
    index = int(len(sorted_returns) * (Decimal("1") - confidence))
    index = max(0, index)

    return -sorted_returns[index]


def conditional_var(
    returns: Sequence[Decimal],
    confidence: Decimal = Decimal("0.95"),
) -> Decimal:
    """
    Calculate Conditional VaR (Expected Shortfall).

    Average loss beyond VaR.

    Args:
        returns: Period returns
        confidence: Confidence level

    Returns:
        CVaR (positive value = expected loss in tail)
    """
    if not returns:
        return Decimal("0")

    var = value_at_risk(returns, confidence)

    # Get returns worse than VaR
    tail_returns = [r for r in returns if r <= -var]

    if not tail_returns:
        return var

    return -mean_return(tail_returns)


def calculate_risk_metrics(
    equity: Sequence[Decimal],
    risk_free_rate: Decimal = Decimal("0.02"),
    periods_per_year: int = 252,
    max_dd: Decimal | None = None,
) -> RiskMetrics:
    """
    Calculate complete risk metrics.

    Args:
        equity: Equity curve
        risk_free_rate: Annual risk-free rate
        periods_per_year: Number of periods per year (252 for daily equity,
                         365 for daily crypto, 52 for weekly, 12 for monthly)
        max_dd: Max drawdown if already calculated

    Returns:
        RiskMetrics with all calculations
    """
    returns = simple_returns(equity)

    if len(returns) < 2:
        return RiskMetrics(
            sharpe_ratio=Decimal("0"),
            sortino_ratio=Decimal("0"),
            calmar_ratio=Decimal("0"),
            volatility=Decimal("0"),
            downside_deviation=Decimal("0"),
            var_95=Decimal("0"),
            cvar_95=Decimal("0"),
            max_drawdown=Decimal("0"),
        )

    vol = volatility(returns, periods_per_year)
    down_dev = downside_deviation(returns, Decimal("0"), periods_per_year)

    sharpe = sharpe_ratio(returns, risk_free_rate, periods_per_year)
    sortino = sortino_ratio(returns, risk_free_rate, periods_per_year)

    # Calculate max drawdown if not provided
    if max_dd is None:
        from quantlab.metrics.drawdown import max_drawdown
        max_dd = max_drawdown(equity)

    # Calmar needs annualized return
    from quantlab.metrics.returns import total_return, annualized_return
    total_ret = total_return(equity[0], equity[-1])
    annual_ret = annualized_return(total_ret, len(returns), periods_per_year)
    calmar = calmar_ratio(annual_ret, max_dd)

    var_95 = value_at_risk(returns, Decimal("0.95"))
    cvar_95 = conditional_var(returns, Decimal("0.95"))

    return RiskMetrics(
        sharpe_ratio=sharpe,
        sortino_ratio=sortino,
        calmar_ratio=calmar,
        volatility=vol,
        downside_deviation=down_dev,
        var_95=var_95,
        cvar_95=cvar_95,
        max_drawdown=max_dd,
    )
