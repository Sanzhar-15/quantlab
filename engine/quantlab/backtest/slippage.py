"""
Slippage Models.

Models price impact from order execution.

Spec Reference: Technical Spec §3.2
"""

from abc import ABC
from abc import abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from decimal import localcontext
from enum import Enum
from typing import Any

from quantlab.backtest.bar import Bar


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
        ctx.prec = precision + 2  # Extra precision for intermediate calculations

        # Initial guess using string conversion to avoid float precision issues
        # For numbers < 1, start with value itself; for larger, start with value/2
        if value < Decimal("1"):
            x = value
        else:
            x = value / Decimal("2")

        # Newton-Raphson iteration: x_new = (x + value/x) / 2
        two = Decimal("2")
        epsilon = Decimal(10) ** -(precision + 1)

        for _ in range(100):  # Max iterations (should converge much faster)
            x_new = (x + value / x) / two
            if abs(x_new - x) < epsilon:
                break
            x = x_new

        # Round to requested precision
        return +x.quantize(Decimal(10) ** -precision)


class SlippageModel(Enum):
    """Available slippage models."""

    NONE = "none"
    FIXED_BPS = "fixed_bps"
    VOLATILITY = "volatility"
    VOLUME_IMPACT = "volume_impact"


class SlippageCalculator(ABC):
    """Abstract base for slippage calculators."""

    @abstractmethod
    def calculate(
        self,
        base_price: Decimal,
        quantity: Decimal,
        is_buy: bool,
        bar: Bar,
    ) -> Decimal:
        """
        Calculate slippage-adjusted fill price.

        Args:
            base_price: Base fill price before slippage
            quantity: Order quantity
            is_buy: True for buy orders
            bar: Execution bar

        Returns:
            Slippage-adjusted fill price
        """
        pass


class NoSlippage(SlippageCalculator):
    """No slippage model - fills at exact price."""

    def calculate(
        self,
        base_price: Decimal,
        quantity: Decimal,  # noqa: ARG002
        is_buy: bool,  # noqa: ARG002
        bar: Bar,  # noqa: ARG002
    ) -> Decimal:
        return base_price


@dataclass
class FixedBpsSlippage(SlippageCalculator):
    """
    Fixed basis points slippage.

    Applies a fixed percentage slippage to all orders.
    """

    bps: Decimal = Decimal("10")  # 10 bps = 0.1%
    min_price: Decimal = Decimal("0.01")  # Minimum allowed price to prevent negatives

    def calculate(
        self,
        base_price: Decimal,
        quantity: Decimal,  # noqa: ARG002
        is_buy: bool,
        bar: Bar,  # noqa: ARG002
    ) -> Decimal:
        slippage_pct = self.bps / Decimal("10000")

        if is_buy:
            # Buy orders slip up
            return base_price * (Decimal("1") + slippage_pct)
        else:
            # Sell orders slip down - ensure never negative
            result = base_price * (Decimal("1") - slippage_pct)
            return max(result, self.min_price)


@dataclass
class VolatilitySlippage(SlippageCalculator):
    """
    Volatility-based slippage.

    Slippage is proportional to bar range (high - low).
    """

    range_fraction: Decimal = Decimal("0.25")  # 25% of bar range
    min_price: Decimal = Decimal("0.01")  # Minimum allowed price to prevent negatives

    def calculate(
        self,
        base_price: Decimal,
        quantity: Decimal,  # noqa: ARG002
        is_buy: bool,
        bar: Bar,
    ) -> Decimal:
        slippage_amount = bar.range * self.range_fraction

        if is_buy:
            result = base_price + slippage_amount
            # FIX-M1: Clamp to bar high — fill price cannot exceed bar range
            return min(result, bar.high)
        else:
            result = base_price - slippage_amount
            # FIX-M1: Clamp to bar low and min_price
            return max(result, self.min_price, bar.low)


@dataclass
class VolumeImpactSlippage(SlippageCalculator):
    """
    Volume-based market impact slippage.

    Larger orders relative to volume have higher slippage.
    Uses square-root impact model with Decimal-safe computation.
    """

    impact_coefficient: Decimal = Decimal("0.1")  # Impact scaling factor
    min_price: Decimal = Decimal("0.01")  # Minimum allowed price to prevent negatives

    def calculate(
        self,
        base_price: Decimal,
        quantity: Decimal,
        is_buy: bool,
        bar: Bar,
    ) -> Decimal:
        if bar.volume == Decimal("0"):
            return base_price

        # Volume participation ratio (clamp to non-negative)
        participation = abs(quantity / bar.volume)

        # Square-root impact model using Decimal-safe sqrt
        # This maintains backtest determinism by avoiding float conversion
        impact_pct = self.impact_coefficient * decimal_sqrt(participation)

        if is_buy:
            result = base_price * (Decimal("1") + impact_pct)
            # FIX-M1: Clamp to bar high — fill price cannot exceed bar range
            return min(result, bar.high)
        else:
            result = base_price * (Decimal("1") - impact_pct)
            # FIX-M1: Clamp to bar low and min_price
            return max(result, self.min_price, bar.low)


def create_slippage_calculator(
    model: SlippageModel,
    params: dict[str, Any] | None = None,
) -> SlippageCalculator:
    """
    Create slippage calculator for the given model.

    Args:
        model: Slippage model type
        params: Model-specific parameters

    Returns:
        SlippageCalculator instance
    """
    params = params or {}

    if model == SlippageModel.NONE:
        return NoSlippage()

    elif model == SlippageModel.FIXED_BPS:
        bps = Decimal(str(params.get("bps", 10)))
        return FixedBpsSlippage(bps=bps)

    elif model == SlippageModel.VOLATILITY:
        fraction = Decimal(str(params.get("range_fraction", 0.25)))
        return VolatilitySlippage(range_fraction=fraction)

    elif model == SlippageModel.VOLUME_IMPACT:
        coeff = Decimal(str(params.get("impact_coefficient", 0.1)))
        return VolumeImpactSlippage(impact_coefficient=coeff)

    else:
        raise ValueError(f"Unknown slippage model: {model}")
