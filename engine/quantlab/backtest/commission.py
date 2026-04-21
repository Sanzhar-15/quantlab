"""
Commission Models.

Models trading costs and fees.

Spec Reference: Technical Spec §3.2
"""

from abc import ABC
from abc import abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Any


class CommissionModel(Enum):
    """Available commission models."""

    NONE = "none"
    PER_SHARE = "per_share"
    PER_TRADE = "per_trade"
    PERCENTAGE = "percentage"
    TIERED = "tiered"


class CommissionCalculator(ABC):
    """Abstract base for commission calculators."""

    @abstractmethod
    def calculate(
        self,
        quantity: Decimal,
        price: Decimal,
        is_buy: bool,
    ) -> Decimal:
        """
        Calculate commission for a trade.

        Args:
            quantity: Number of shares/units
            price: Fill price
            is_buy: True for buy orders

        Returns:
            Commission amount
        """
        pass


class NoCommission(CommissionCalculator):
    """No commission model."""

    def calculate(
        self,
        quantity: Decimal,  # noqa: ARG002
        price: Decimal,  # noqa: ARG002
        is_buy: bool,  # noqa: ARG002
    ) -> Decimal:
        return Decimal("0")


@dataclass
class PerShareCommission(CommissionCalculator):
    """
    Per-share commission.

    Common for stock trading (e.g., $0.005 per share).
    """

    rate: Decimal = Decimal("0.005")  # $0.005 per share
    minimum: Decimal = Decimal("1.00")  # $1.00 minimum

    def calculate(
        self,
        quantity: Decimal,
        price: Decimal,  # noqa: ARG002
        is_buy: bool,  # noqa: ARG002
    ) -> Decimal:
        commission = quantity * self.rate
        return max(commission, self.minimum)


@dataclass
class PerTradeCommission(CommissionCalculator):
    """
    Flat per-trade commission.

    Common for some brokers (e.g., $4.95 per trade).
    """

    rate: Decimal = Decimal("4.95")

    def calculate(
        self,
        quantity: Decimal,  # noqa: ARG002
        price: Decimal,  # noqa: ARG002
        is_buy: bool,  # noqa: ARG002
    ) -> Decimal:
        return self.rate


@dataclass
class PercentageCommission(CommissionCalculator):
    """
    Percentage-based commission.

    Commission is a percentage of notional value.
    """

    rate: Decimal = Decimal("0.001")  # 0.1% = 10 bps
    minimum: Decimal = Decimal("0")

    def calculate(
        self,
        quantity: Decimal,
        price: Decimal,
        is_buy: bool,  # noqa: ARG002
    ) -> Decimal:
        notional = quantity * price
        commission = notional * self.rate
        return max(commission, self.minimum)


@dataclass
class TieredCommission(CommissionCalculator):
    """
    Tiered commission based on trade value.

    Different rates for different trade sizes.
    Requires a tier with threshold 0 to ensure all trades are matched.
    """

    tiers: list[tuple[Decimal, Decimal]]  # [(threshold, rate), ...]

    def __init__(
        self,
        tiers: list[tuple[Decimal, Decimal]] | None = None,
    ) -> None:
        # Default tiers: value threshold, rate
        self.tiers = tiers or [
            (Decimal("0"), Decimal("0.0035")),  # 0-10K: 35 bps
            (Decimal("10000"), Decimal("0.002")),  # 10K-100K: 20 bps
            (Decimal("100000"), Decimal("0.001")),  # 100K+: 10 bps
        ]
        # Sort by threshold descending for lookup
        self.tiers = sorted(self.tiers, key=lambda x: x[0], reverse=True)

        # Validate: must have a tier with threshold 0 to match all trades
        thresholds = [t[0] for t in self.tiers]
        if Decimal("0") not in thresholds:
            raise ValueError(
                "TieredCommission requires a tier with threshold 0 to ensure all trades "
                "are matched. Add a tier like (Decimal('0'), Decimal('0.003'))."
            )

        # Validate: all thresholds must be non-negative
        for threshold, rate in self.tiers:
            if threshold < Decimal("0"):
                raise ValueError(f"Tier threshold must be non-negative, got {threshold}")
            if rate < Decimal("0"):
                raise ValueError(f"Tier rate must be non-negative, got {rate}")

    def calculate(
        self,
        quantity: Decimal,
        price: Decimal,
        is_buy: bool,  # noqa: ARG002
    ) -> Decimal:
        notional = quantity * price

        # Find applicable tier (tiers are sorted descending by threshold)
        for threshold, rate in self.tiers:
            if notional >= threshold:
                return notional * rate

        # Should never reach here since we validate 0 threshold exists
        # But return 0 as a safe fallback
        return Decimal("0")


def create_commission_calculator(
    model: CommissionModel,
    params: dict[str, Any] | None = None,
) -> CommissionCalculator:
    """
    Create commission calculator for the given model.

    Args:
        model: Commission model type
        params: Model-specific parameters

    Returns:
        CommissionCalculator instance
    """
    params = params or {}

    if model == CommissionModel.NONE:
        return NoCommission()

    elif model == CommissionModel.PER_SHARE:
        rate = Decimal(str(params.get("rate", "0.005")))
        minimum = Decimal(str(params.get("minimum", "1.00")))
        return PerShareCommission(rate=rate, minimum=minimum)

    elif model == CommissionModel.PER_TRADE:
        rate = Decimal(str(params.get("rate", "4.95")))
        return PerTradeCommission(rate=rate)

    elif model == CommissionModel.PERCENTAGE:
        rate = Decimal(str(params.get("rate", "0.001")))
        minimum = Decimal(str(params.get("minimum", "0")))
        return PercentageCommission(rate=rate, minimum=minimum)

    elif model == CommissionModel.TIERED:
        tiers_raw = params.get("tiers")
        tiers = None
        if tiers_raw:
            tiers = []
            for t in tiers_raw:
                if isinstance(t, dict):
                    # Dictionary format: {threshold: X, rate: Y}
                    tiers.append((
                        Decimal(str(t.get("threshold", 0))),
                        Decimal(str(t.get("rate", 0)))
                    ))
                else:
                    # Tuple/list format: [threshold, rate]
                    tiers.append((Decimal(str(t[0])), Decimal(str(t[1]))))
        return TieredCommission(tiers=tiers)

    else:
        raise ValueError(f"Unknown commission model: {model}")
