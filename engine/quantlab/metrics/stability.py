"""
Stability Metrics.

Calculates stability score, R-squared, and equity curve quality metrics.

Spec Reference: Technical Spec §7.5
"""

import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Sequence


@dataclass
class StabilityMetrics:
    """Complete stability metrics."""

    stability_score: Decimal  # R-squared of equity curve
    linearity: Decimal  # How linear the equity growth is
    skewness: Decimal  # Distribution skewness
    kurtosis: Decimal  # Distribution kurtosis
    tail_ratio: Decimal  # Ratio of right to left tail
    common_sense_ratio: Decimal  # Profit factor * (1 - max_dd)


def linear_regression(y: Sequence[Decimal]) -> tuple[Decimal, Decimal]:
    """
    Perform simple linear regression.

    y = a + b*x

    Args:
        y: Y values (equity)

    Returns:
        Tuple of (intercept, slope)
    """
    n = len(y)
    if n < 2:
        return Decimal("0"), Decimal("0")

    # X is just 0, 1, 2, ... n-1
    sum_x = Decimal(str(n * (n - 1) // 2))
    sum_y = sum(y)
    sum_xy = sum(Decimal(str(i)) * y[i] for i in range(n))
    sum_x2 = Decimal(str(n * (n - 1) * (2 * n - 1) // 6))

    n_dec = Decimal(str(n))

    denominator = n_dec * sum_x2 - sum_x ** 2
    if denominator == Decimal("0"):
        return sum_y / n_dec, Decimal("0")

    slope = (n_dec * sum_xy - sum_x * sum_y) / denominator
    intercept = (sum_y - slope * sum_x) / n_dec

    return intercept, slope


def r_squared(y: Sequence[Decimal]) -> Decimal:
    """
    Calculate R-squared (coefficient of determination).

    Measures how well the equity curve fits a linear trend.
    Higher R² = more consistent returns.

    Args:
        y: Equity curve

    Returns:
        R-squared (0-1)
    """
    n = len(y)
    if n < 2:
        return Decimal("0")

    intercept, slope = linear_regression(y)

    # Calculate predicted values
    y_pred = [intercept + slope * Decimal(str(i)) for i in range(n)]

    # Calculate R²
    y_mean = sum(y) / Decimal(str(n))

    ss_tot = sum((yi - y_mean) ** 2 for yi in y)
    ss_res = sum((y[i] - y_pred[i]) ** 2 for i in range(n))

    if ss_tot == Decimal("0"):
        return Decimal("1")  # Perfect fit (constant equity)

    r2 = Decimal("1") - (ss_res / ss_tot)

    return max(Decimal("0"), min(r2, Decimal("1")))


def stability_score(equity: Sequence[Decimal]) -> Decimal:
    """
    Calculate stability score.

    Stability score is the R-squared of the cumulative return curve
    regressed against a linear function.

    Args:
        equity: Equity curve

    Returns:
        Stability score (0-1, higher is better)
    """
    return r_squared(equity)


def skewness(returns: Sequence[Decimal]) -> Decimal:
    """
    Calculate skewness of return distribution.

    Positive skewness = more positive outliers (good)
    Negative skewness = more negative outliers (bad)

    Args:
        returns: Return series

    Returns:
        Skewness
    """
    if len(returns) < 3:
        return Decimal("0")

    n = len(returns)
    mean = sum(returns) / Decimal(str(n))

    # Calculate moments
    m2 = sum((r - mean) ** 2 for r in returns) / Decimal(str(n))
    m3 = sum((r - mean) ** 3 for r in returns) / Decimal(str(n))

    if m2 == Decimal("0"):
        return Decimal("0")

    std = Decimal(str(math.sqrt(float(m2))))
    skew = m3 / (std ** 3)

    # Apply sample correction
    correction = Decimal(str(math.sqrt(n * (n - 1)))) / Decimal(str(n - 2))
    return skew * correction


def kurtosis(returns: Sequence[Decimal]) -> Decimal:
    """
    Calculate excess kurtosis of return distribution.

    Positive kurtosis = fat tails (more extreme moves)
    Negative kurtosis = thin tails

    Args:
        returns: Return series

    Returns:
        Excess kurtosis (0 = normal distribution)
    """
    if len(returns) < 4:
        return Decimal("0")

    n = len(returns)
    mean = sum(returns) / Decimal(str(n))

    m2 = sum((r - mean) ** 2 for r in returns) / Decimal(str(n))
    m4 = sum((r - mean) ** 4 for r in returns) / Decimal(str(n))

    if m2 == Decimal("0"):
        return Decimal("0")

    # Raw kurtosis
    raw = m4 / (m2 ** 2)

    # Sample correction and excess
    n_dec = Decimal(str(n))
    num = (n_dec + 1) * (n_dec - 1) * (raw - Decimal("3"))
    denom = (n_dec - 2) * (n_dec - 3)

    if denom == Decimal("0"):
        return Decimal("0")

    excess = num / denom + Decimal("3") - Decimal("3")  # Subtract 3 for excess
    return excess


# Minimum sample size for reliable tail ratio calculation
TAIL_RATIO_MIN_SAMPLES = 20


def tail_ratio(
    returns: Sequence[Decimal],
    percentile: Decimal = Decimal("0.05"),
    min_samples: int = TAIL_RATIO_MIN_SAMPLES,
) -> Decimal:
    """
    Calculate tail ratio.

    Tail Ratio = |95th percentile| / |5th percentile|

    Higher ratio = better risk/reward in tails.

    Args:
        returns: Return series
        percentile: Percentile for tails (default 5%)
        min_samples: Minimum samples for reliable calculation (default 20)

    Returns:
        Tail ratio

    Note:
        For sample sizes < min_samples, the result may be unreliable
        and a warning will be logged.
    """
    if not returns:
        return Decimal("0")

    n = len(returns)

    # Warn if sample size is too small for reliable percentile estimation
    if n < min_samples:
        import logging
        logger = logging.getLogger(__name__)
        logger.warning(
            f"Tail ratio: sample size {n} < recommended minimum {min_samples}. "
            f"Result may be statistically unreliable."
        )

    sorted_returns = sorted(returns)

    low_idx = int(n * float(percentile))
    high_idx = int(n * float(Decimal("1") - percentile))

    low_idx = max(0, low_idx)
    high_idx = min(n - 1, high_idx)

    left_tail = abs(sorted_returns[low_idx])
    right_tail = abs(sorted_returns[high_idx])

    if left_tail == Decimal("0"):
        return Decimal("0")

    return right_tail / left_tail


def common_sense_ratio(
    profit_factor: Decimal,
    max_drawdown: Decimal,
) -> Decimal:
    """
    Calculate Common Sense Ratio.

    CSR = Profit_Factor * (1 - Max_Drawdown)

    Penalizes strategies with high drawdowns.

    Args:
        profit_factor: Profit factor
        max_drawdown: Maximum drawdown (as decimal, 0.2 = 20%)

    Returns:
        Common sense ratio
    """
    return profit_factor * (Decimal("1") - max_drawdown)


def gain_to_pain_ratio(returns: Sequence[Decimal]) -> Decimal:
    """
    Calculate Gain-to-Pain ratio.

    GtP = Sum(all returns) / Sum(absolute negative returns)

    Args:
        returns: Return series

    Returns:
        Gain-to-pain ratio
    """
    if not returns:
        return Decimal("0")

    total = sum(returns)
    pain = sum(abs(r) for r in returns if r < Decimal("0"))

    if pain == Decimal("0"):
        return Decimal("0") if total == Decimal("0") else Decimal("999")

    return total / pain


def recovery_factor(
    total_return: Decimal,
    max_drawdown: Decimal,
) -> Decimal:
    """
    Calculate Recovery Factor.

    RF = Total_Return / Max_Drawdown

    Higher = strategy recovers quickly from drawdowns.

    Args:
        total_return: Total return (as decimal)
        max_drawdown: Maximum drawdown (as decimal)

    Returns:
        Recovery factor
    """
    if max_drawdown == Decimal("0"):
        return Decimal("0")

    return total_return / max_drawdown


def kelly_criterion(
    win_rate: Decimal,
    payoff_ratio: Decimal,
) -> Decimal:
    """
    Calculate Kelly Criterion optimal position size.

    Kelly% = W - (1-W)/R

    Where W = win rate, R = payoff ratio

    Args:
        win_rate: Win rate (0-1)
        payoff_ratio: Average win / Average loss

    Returns:
        Optimal fraction to risk
    """
    if payoff_ratio == Decimal("0"):
        return Decimal("0")

    kelly = win_rate - ((Decimal("1") - win_rate) / payoff_ratio)
    return max(Decimal("0"), kelly)


def calculate_stability_metrics(
    equity: Sequence[Decimal],
    returns: Sequence[Decimal] | None = None,
    profit_factor: Decimal = Decimal("0"),
    max_drawdown: Decimal = Decimal("0"),
) -> StabilityMetrics:
    """
    Calculate complete stability metrics.

    Args:
        equity: Equity curve
        returns: Return series (calculated if not provided)
        profit_factor: Profit factor
        max_drawdown: Maximum drawdown

    Returns:
        StabilityMetrics with all calculations
    """
    if returns is None:
        from quantlab.metrics.returns import simple_returns
        returns = simple_returns(equity)

    return StabilityMetrics(
        stability_score=stability_score(equity),
        linearity=r_squared(equity),
        skewness=skewness(returns),
        kurtosis=kurtosis(returns),
        tail_ratio=tail_ratio(returns),
        common_sense_ratio=common_sense_ratio(profit_factor, max_drawdown),
    )
