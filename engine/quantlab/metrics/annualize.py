"""
Annualization Constants and Functions.

Centralizes trading day assumptions and annualization calculations
to ensure consistency across the codebase.

Spec Reference: Technical Spec §14
"""

from decimal import Decimal
from decimal import localcontext
from enum import Enum
from typing import NamedTuple


class MarketType(Enum):
    """Market types with different trading day counts."""

    US_EQUITY = "us_equity"  # NYSE/NASDAQ: ~252 days
    CRYPTO = "crypto"  # 24/7/365: 365 days
    FOREX = "forex"  # ~252 days (weekdays)
    FUTURES = "futures"  # ~252 days
    CUSTOM = "custom"


class AnnualizationConfig(NamedTuple):
    """Configuration for annualization calculations."""

    trading_days_per_year: int
    trading_hours_per_day: Decimal


# Standard market configurations
MARKET_CONFIGS: dict[MarketType, AnnualizationConfig] = {
    MarketType.US_EQUITY: AnnualizationConfig(
        trading_days_per_year=252,
        trading_hours_per_day=Decimal("6.5"),
    ),
    MarketType.CRYPTO: AnnualizationConfig(
        trading_days_per_year=365,
        trading_hours_per_day=Decimal("24"),
    ),
    MarketType.FOREX: AnnualizationConfig(
        trading_days_per_year=252,
        trading_hours_per_day=Decimal("24"),
    ),
    MarketType.FUTURES: AnnualizationConfig(
        trading_days_per_year=252,
        trading_hours_per_day=Decimal("23"),  # Varies by product
    ),
}


# Default for US equities (most common case)
DEFAULT_TRADING_DAYS_PER_YEAR = 252
DEFAULT_TRADING_HOURS_PER_DAY = Decimal("6.5")


def decimal_sqrt(value: Decimal, precision: int = 28) -> Decimal:
    """
    Compute square root of a Decimal with arbitrary precision.

    Uses Newton-Raphson method for Decimal-safe computation.

    Args:
        value: Non-negative Decimal to compute sqrt of
        precision: Number of decimal places of precision

    Returns:
        Square root as Decimal

    Raises:
        ValueError: If value is negative
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


# Pre-computed annualization factors for common use cases
_SQRT_252 = decimal_sqrt(Decimal("252"))
_SQRT_365 = decimal_sqrt(Decimal("365"))


def get_annualization_factor(trading_days: int = DEFAULT_TRADING_DAYS_PER_YEAR) -> Decimal:
    """
    Get the square root of trading days for annualizing volatility/Sharpe.

    Args:
        trading_days: Number of trading days per year

    Returns:
        Square root of trading days as Decimal
    """
    if trading_days == 252:
        return _SQRT_252
    if trading_days == 365:
        return _SQRT_365
    return decimal_sqrt(Decimal(str(trading_days)))


def annualize_return(
    period_return: Decimal,
    trading_days: int = DEFAULT_TRADING_DAYS_PER_YEAR,
) -> Decimal:
    """
    Annualize a daily return.

    Args:
        period_return: Daily return (e.g., 0.001 = 0.1%)
        trading_days: Number of trading days per year

    Returns:
        Annualized return
    """
    return period_return * Decimal(str(trading_days))


def annualize_volatility(
    daily_volatility: Decimal,
    trading_days: int = DEFAULT_TRADING_DAYS_PER_YEAR,
) -> Decimal:
    """
    Annualize daily volatility.

    Uses sqrt(trading_days) scaling.

    Args:
        daily_volatility: Daily volatility (standard deviation)
        trading_days: Number of trading days per year

    Returns:
        Annualized volatility
    """
    return daily_volatility * get_annualization_factor(trading_days)


def calculate_sharpe_ratio(
    avg_daily_return: Decimal,
    daily_std: Decimal,
    risk_free_rate: Decimal = Decimal("0"),
    trading_days: int = DEFAULT_TRADING_DAYS_PER_YEAR,
) -> Decimal | None:
    """
    Calculate annualized Sharpe ratio from daily returns.

    Args:
        avg_daily_return: Average daily return
        daily_std: Standard deviation of daily returns
        risk_free_rate: Daily risk-free rate (default 0)
        trading_days: Number of trading days per year

    Returns:
        Annualized Sharpe ratio, or None if std is zero
    """
    if daily_std == Decimal("0"):
        return None

    excess_return = avg_daily_return - risk_free_rate
    annualized_return = excess_return * Decimal(str(trading_days))
    annualized_std = daily_std * get_annualization_factor(trading_days)

    return annualized_return / annualized_std


def calculate_sortino_ratio(
    avg_daily_return: Decimal,
    downside_deviation: Decimal,
    risk_free_rate: Decimal = Decimal("0"),
    trading_days: int = DEFAULT_TRADING_DAYS_PER_YEAR,
) -> Decimal | None:
    """
    Calculate annualized Sortino ratio from daily returns.

    Args:
        avg_daily_return: Average daily return
        downside_deviation: Downside deviation (std of negative returns only)
        risk_free_rate: Daily risk-free rate (default 0)
        trading_days: Number of trading days per year

    Returns:
        Annualized Sortino ratio, or None if downside_deviation is zero
    """
    if downside_deviation == Decimal("0"):
        return None

    excess_return = avg_daily_return - risk_free_rate
    annualized_return = excess_return * Decimal(str(trading_days))
    annualized_dd = downside_deviation * get_annualization_factor(trading_days)

    return annualized_return / annualized_dd


def get_market_config(market_type: MarketType) -> AnnualizationConfig:
    """
    Get annualization configuration for a market type.

    Args:
        market_type: Type of market

    Returns:
        AnnualizationConfig with trading days and hours
    """
    return MARKET_CONFIGS.get(
        market_type,
        MARKET_CONFIGS[MarketType.US_EQUITY],
    )


# Convenience constants
SQRT_252 = _SQRT_252
SQRT_365 = _SQRT_365
