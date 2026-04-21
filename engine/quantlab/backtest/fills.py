"""
Fill Assumption Models.

Determines the price at which orders fill during backtest.

Spec Reference: Technical Spec §3.1
"""

import logging
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Protocol

from quantlab.backtest.bar import Bar


logger = logging.getLogger(__name__)


class FillAssumption(Enum):
    """
    Fill assumption modes.

    Determines the price at which market orders fill.
    """

    NEXT_OPEN = "next_open"  # Fill at open[t+1] (DEFAULT)
    NEXT_CLOSE = "next_close"  # Fill at close[t+1]
    TYPICAL_PRICE = "typical_price"  # Fill at (O+H+L+C)/4 of t+1


class FillPriceCalculator(Protocol):
    """Protocol for fill price calculation."""

    def calculate(self, bar: Bar) -> Decimal:
        """Calculate fill price for the given execution bar."""
        ...


class NextOpenFill:
    """Fill at execution bar's open price."""

    def calculate(self, bar: Bar) -> Decimal:
        return bar.open


class NextCloseFill:
    """Fill at execution bar's close price."""

    def calculate(self, bar: Bar) -> Decimal:
        return bar.close


class TypicalPriceFill:
    """Fill at execution bar's typical price (O+H+L+C)/4."""

    def calculate(self, bar: Bar) -> Decimal:
        return bar.vwap_proxy


def get_fill_calculator(assumption: FillAssumption) -> FillPriceCalculator:
    """Get fill price calculator for the given assumption."""
    calculators: dict[FillAssumption, FillPriceCalculator] = {
        FillAssumption.NEXT_OPEN: NextOpenFill(),
        FillAssumption.NEXT_CLOSE: NextCloseFill(),
        FillAssumption.TYPICAL_PRICE: TypicalPriceFill(),
    }
    return calculators[assumption]


@dataclass
class FillResult:
    """Result of a fill attempt."""

    filled: bool
    fill_price: Decimal | None = None
    fill_quantity: Decimal | None = None
    remaining_quantity: Decimal | None = None
    reason: str | None = None

    @classmethod
    def success(
        cls,
        price: Decimal,
        quantity: Decimal,
        remaining: Decimal = Decimal("0"),
    ) -> "FillResult":
        """Create successful fill result."""
        return cls(
            filled=True,
            fill_price=price,
            fill_quantity=quantity,
            remaining_quantity=remaining,
        )

    @classmethod
    def no_fill(cls, reason: str) -> "FillResult":
        """Create no-fill result."""
        return cls(filled=False, reason=reason)


class VolumeParticipation:
    """
    Enforces volume participation limits.

    Prevents fills that would exceed a percentage of bar volume.
    """

    DEFAULT_MAX_PARTICIPATION = Decimal("0.10")  # 10% max

    def __init__(self, max_participation: Decimal | None = None) -> None:
        self._max_participation = max_participation or self.DEFAULT_MAX_PARTICIPATION

    def max_fillable_quantity(self, bar: Bar, warn_on_zero: bool = True) -> Decimal:
        """
        Get maximum quantity that can be filled in this bar.

        Args:
            bar: Execution bar
            warn_on_zero: Log warning if bar has zero volume

        Returns:
            Maximum quantity respecting volume participation limit
        """
        if bar.volume <= Decimal("0"):
            if warn_on_zero:
                logger.warning(
                    f"Zero or negative volume for {bar.symbol} at {bar.timestamp}: "
                    f"no fills possible for this bar"
                )
            return Decimal("0")

        return bar.volume * self._max_participation

    def apply_limit(
        self,
        requested_quantity: Decimal,
        bar: Bar,
        warn_on_zero: bool = True,
    ) -> tuple[Decimal, Decimal]:
        """
        Apply volume participation limit.

        Args:
            requested_quantity: Quantity requested
            bar: Execution bar
            warn_on_zero: Log warning if bar has zero volume

        Returns:
            Tuple of (fillable_quantity, remaining_quantity)
        """
        max_qty = self.max_fillable_quantity(bar, warn_on_zero=warn_on_zero)

        if requested_quantity <= max_qty:
            return requested_quantity, Decimal("0")

        return max_qty, requested_quantity - max_qty

    def can_fill_fully(self, quantity: Decimal, bar: Bar) -> bool:
        """Check if full quantity can be filled within volume limit."""
        return quantity <= self.max_fillable_quantity(bar)


class VolumeTracker:
    """
    Tracks volume participation across multiple orders in the same bar.

    Use this to properly accumulate volume consumption when processing
    multiple orders in a single bar to avoid exceeding participation limits.

    Usage:
        tracker = VolumeTracker(max_participation=Decimal("0.10"))

        # Process multiple orders for same bar
        fill1, remaining1 = tracker.request_fill("AAPL", bar, Decimal("500"))
        fill2, remaining2 = tracker.request_fill("AAPL", bar, Decimal("300"))

        # After bar processing completes
        tracker.reset()
    """

    def __init__(self, max_participation: Decimal = Decimal("0.10")) -> None:
        """
        Initialize volume tracker.

        Args:
            max_participation: Maximum volume participation rate (0-1)
        """
        self._max_participation = max_participation
        # Key: (symbol, timestamp) -> consumed volume
        self._consumed: dict[tuple[str, str], Decimal] = {}

    def get_remaining_capacity(self, bar: Bar) -> Decimal:
        """
        Get remaining fillable volume for this bar.

        Args:
            bar: The execution bar

        Returns:
            Remaining volume available for fills
        """
        if bar.volume <= Decimal("0"):
            return Decimal("0")

        max_volume = bar.volume * self._max_participation
        key = (bar.symbol, bar.timestamp.isoformat())
        consumed = self._consumed.get(key, Decimal("0"))

        return max(Decimal("0"), max_volume - consumed)

    def request_fill(
        self,
        bar: Bar,
        requested_quantity: Decimal,
        warn_on_zero: bool = True,
    ) -> tuple[Decimal, Decimal]:
        """
        Request a fill and track volume consumption.

        Args:
            bar: Execution bar
            requested_quantity: Quantity requested
            warn_on_zero: Log warning if bar has zero volume

        Returns:
            Tuple of (fillable_quantity, remaining_quantity)
        """
        if bar.volume <= Decimal("0"):
            if warn_on_zero:
                logger.warning(
                    f"Zero or negative volume for {bar.symbol} at {bar.timestamp}: "
                    f"no fills possible for this bar"
                )
            return Decimal("0"), requested_quantity

        remaining_capacity = self.get_remaining_capacity(bar)

        if remaining_capacity <= Decimal("0"):
            logger.debug(
                f"Volume participation limit reached for {bar.symbol} at {bar.timestamp}"
            )
            return Decimal("0"), requested_quantity

        # Fill up to remaining capacity
        fill_quantity = min(requested_quantity, remaining_capacity)
        remaining = requested_quantity - fill_quantity

        # Record consumption
        key = (bar.symbol, bar.timestamp.isoformat())
        self._consumed[key] = self._consumed.get(key, Decimal("0")) + fill_quantity

        if fill_quantity < requested_quantity:
            logger.debug(
                f"Partial fill due to volume participation: {fill_quantity}/{requested_quantity} "
                f"for {bar.symbol}"
            )

        return fill_quantity, remaining

    def reset(self) -> None:
        """Reset consumed volume tracking (call after each bar is processed)."""
        self._consumed.clear()

    def reset_symbol(self, symbol: str) -> None:
        """Reset tracking for a specific symbol."""
        keys_to_remove = [k for k in self._consumed if k[0] == symbol]
        for k in keys_to_remove:
            del self._consumed[k]
