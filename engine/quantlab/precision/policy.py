"""
Decimal precision policy for different asset classes.

All prices and quantities MUST use Decimal, not float.

Spec Reference: Technical Spec §14.5
"""

from decimal import ROUND_DOWN
from decimal import ROUND_HALF_UP
from decimal import Decimal
from enum import Enum
from typing import Literal


# Type for supported rounding modes
RoundingMode = Literal["ROUND_HALF_UP", "ROUND_DOWN"]


class AssetClass(Enum):
    """Supported asset classes with their precision rules."""

    EQUITY_US = "equity_us"
    CRYPTO = "crypto"
    FOREX = "forex"


class PrecisionPolicy:
    """
    Precision and rounding rules for an asset class.

    Usage:
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)
        rounded_price = policy.round_price(Decimal("123.456"))
        rounded_qty = policy.round_quantity(Decimal("100.5"))
    """

    # Asset class configurations
    _CONFIGS = {
        AssetClass.EQUITY_US: {
            "price_decimals": 2,
            "quantity_decimals": 0,
            "rounding": ROUND_HALF_UP,
        },
        AssetClass.CRYPTO: {
            "price_decimals": 8,
            "quantity_decimals": 8,
            "rounding": ROUND_DOWN,
        },
        AssetClass.FOREX: {
            "price_decimals": 5,
            "quantity_decimals": 0,
            "rounding": ROUND_HALF_UP,
        },
    }

    def __init__(
        self,
        price_decimals: int,
        quantity_decimals: int,
        rounding: RoundingMode = ROUND_HALF_UP,
    ) -> None:
        """
        Initialize precision policy.

        Args:
            price_decimals: Number of decimal places for prices
            quantity_decimals: Number of decimal places for quantities
            rounding: Rounding mode (ROUND_HALF_UP or ROUND_DOWN)

        Raises:
            ValueError: If rounding mode is not supported
        """
        if rounding not in (ROUND_HALF_UP, ROUND_DOWN):
            raise ValueError(
                f"Unsupported rounding mode: {rounding}. "
                f"Use ROUND_HALF_UP or ROUND_DOWN."
            )

        self.price_decimals = price_decimals
        self.quantity_decimals = quantity_decimals
        self.rounding = rounding

        # Pre-compute quantize values
        self._price_quantize = Decimal(10) ** -price_decimals
        self._quantity_quantize = Decimal(10) ** -quantity_decimals

    @classmethod
    def for_asset_class(cls, asset_class: AssetClass) -> "PrecisionPolicy":
        """
        Get the precision policy for an asset class.

        Args:
            asset_class: The asset class

        Returns:
            PrecisionPolicy configured for the asset class
        """
        config = cls._CONFIGS[asset_class]
        return cls(
            price_decimals=config["price_decimals"],
            quantity_decimals=config["quantity_decimals"],
            rounding=config["rounding"],
        )

    def round_price(self, price: Decimal) -> Decimal:
        """
        Round a price to the correct precision.

        Args:
            price: Price to round

        Returns:
            Rounded price
        """
        return price.quantize(self._price_quantize, rounding=self.rounding)

    def round_quantity(self, quantity: Decimal) -> Decimal:
        """
        Round a quantity to the correct precision.

        Args:
            quantity: Quantity to round

        Returns:
            Rounded quantity
        """
        return quantity.quantize(self._quantity_quantize, rounding=self.rounding)

    def validate_price(self, price: Decimal) -> bool:
        """
        Check if a price has valid precision.

        Args:
            price: Price to validate

        Returns:
            True if price has valid precision
        """
        rounded = self.round_price(price)
        return price == rounded

    def validate_quantity(self, quantity: Decimal) -> bool:
        """
        Check if a quantity has valid precision.

        Args:
            quantity: Quantity to validate

        Returns:
            True if quantity has valid precision
        """
        rounded = self.round_quantity(quantity)
        return quantity == rounded


def decimal_from_string(s: str) -> Decimal:
    """
    Safely convert a string to Decimal.

    Args:
        s: String representation of a number

    Returns:
        Decimal value

    Raises:
        ValueError: If string is not a valid decimal
    """
    try:
        return Decimal(s)
    except Exception as e:
        raise ValueError(f"Invalid decimal string: {s}") from e


def decimal_close(
    a: Decimal,
    b: Decimal,
    tolerance: Decimal | None = None,
) -> bool:
    """
    Check if two Decimal values are within tolerance.

    Args:
        a: First value
        b: Second value
        tolerance: Maximum allowed difference (default: 0.01)

    Returns:
        True if values are within tolerance
    """
    if tolerance is None:
        tolerance = Decimal("0.01")
    return abs(a - b) <= tolerance


def ensure_decimal(value: Decimal | str | int | float) -> Decimal:
    """
    Ensure a value is a Decimal.

    Args:
        value: Value to convert

    Returns:
        Decimal value

    Note:
        Using float is discouraged due to precision loss.
        This function accepts float for compatibility but logs a warning.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, str):
        return Decimal(value)
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        # Convert via string to preserve visible precision
        # This is a compromise - prefer str or Decimal inputs
        return Decimal(str(value))
    raise TypeError(f"Cannot convert {type(value)} to Decimal")
