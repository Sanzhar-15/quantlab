"""
Tests for Decimal precision policy.
"""

from decimal import ROUND_DOWN
from decimal import ROUND_HALF_UP
from decimal import Decimal

import pytest

from quantlab.precision.policy import (
    AssetClass,
    PrecisionPolicy,
    decimal_close,
    decimal_from_string,
    ensure_decimal,
)


class TestPrecisionPolicy:
    """Tests for PrecisionPolicy class."""

    def test_equity_us_config(self):
        """US equity should have 2 price decimals, 0 quantity decimals."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)
        assert policy.price_decimals == 2
        assert policy.quantity_decimals == 0
        assert policy.rounding == ROUND_HALF_UP

    def test_crypto_config(self):
        """Crypto should have 8 decimals and ROUND_DOWN."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.CRYPTO)
        assert policy.price_decimals == 8
        assert policy.quantity_decimals == 8
        assert policy.rounding == ROUND_DOWN

    def test_forex_config(self):
        """Forex should have 5 price decimals."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.FOREX)
        assert policy.price_decimals == 5
        assert policy.quantity_decimals == 0


class TestRoundPrice:
    """Tests for round_price method."""

    def test_equity_round_price(self):
        """Equity prices should round to 2 decimals."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)

        assert policy.round_price(Decimal("100.123")) == Decimal("100.12")
        assert policy.round_price(Decimal("100.125")) == Decimal("100.13")  # HALF_UP
        assert policy.round_price(Decimal("100.999")) == Decimal("101.00")

    def test_crypto_round_price(self):
        """Crypto prices should round to 8 decimals with ROUND_DOWN."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.CRYPTO)

        assert policy.round_price(Decimal("0.123456789")) == Decimal("0.12345678")
        assert policy.round_price(Decimal("0.999999999")) == Decimal("0.99999999")

    def test_forex_round_price(self):
        """Forex prices should round to 5 decimals."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.FOREX)

        assert policy.round_price(Decimal("1.123456")) == Decimal("1.12346")


class TestRoundQuantity:
    """Tests for round_quantity method."""

    def test_equity_round_quantity(self):
        """Equity quantities should be whole numbers."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)

        assert policy.round_quantity(Decimal("100.5")) == Decimal("101")
        assert policy.round_quantity(Decimal("100.4")) == Decimal("100")

    def test_crypto_round_quantity(self):
        """Crypto quantities allow 8 decimals."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.CRYPTO)

        assert policy.round_quantity(Decimal("0.123456789")) == Decimal("0.12345678")


class TestValidation:
    """Tests for validation methods."""

    def test_validate_price_valid(self):
        """Valid prices should return True."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)

        assert policy.validate_price(Decimal("100.00")) is True
        assert policy.validate_price(Decimal("100.50")) is True

    def test_validate_price_invalid(self):
        """Invalid precision should return False."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)

        assert policy.validate_price(Decimal("100.001")) is False
        assert policy.validate_price(Decimal("100.123")) is False

    def test_validate_quantity_valid(self):
        """Valid quantities should return True."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)

        assert policy.validate_quantity(Decimal("100")) is True

    def test_validate_quantity_invalid(self):
        """Fractional shares should return False for equity."""
        policy = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)

        assert policy.validate_quantity(Decimal("100.5")) is False


class TestDecimalFromString:
    """Tests for decimal_from_string function."""

    def test_valid_decimal(self):
        """Valid decimal strings should convert."""
        assert decimal_from_string("100.50") == Decimal("100.50")
        assert decimal_from_string("0") == Decimal("0")
        assert decimal_from_string("-50.25") == Decimal("-50.25")

    def test_invalid_decimal(self):
        """Invalid strings should raise ValueError."""
        with pytest.raises(ValueError):
            decimal_from_string("not a number")

        with pytest.raises(ValueError):
            decimal_from_string("")


class TestDecimalClose:
    """Tests for decimal_close function."""

    def test_exactly_equal(self):
        """Exactly equal values should return True."""
        assert decimal_close(Decimal("100"), Decimal("100")) is True

    def test_within_tolerance(self):
        """Values within tolerance should return True."""
        assert decimal_close(Decimal("100.00"), Decimal("100.005")) is True
        assert decimal_close(Decimal("100"), Decimal("100.01")) is True

    def test_outside_tolerance(self):
        """Values outside tolerance should return False."""
        assert decimal_close(Decimal("100"), Decimal("100.02")) is False

    def test_custom_tolerance(self):
        """Custom tolerance should be respected."""
        assert decimal_close(
            Decimal("100"),
            Decimal("100.1"),
            tolerance=Decimal("0.001"),
        ) is False

        assert decimal_close(
            Decimal("100"),
            Decimal("100.1"),
            tolerance=Decimal("1"),
        ) is True


class TestEnsureDecimal:
    """Tests for ensure_decimal function."""

    def test_decimal_passthrough(self):
        """Decimal should pass through unchanged."""
        d = Decimal("100.50")
        assert ensure_decimal(d) is d

    def test_string_conversion(self):
        """Strings should convert to Decimal."""
        assert ensure_decimal("100.50") == Decimal("100.50")

    def test_int_conversion(self):
        """Integers should convert to Decimal."""
        assert ensure_decimal(100) == Decimal("100")

    def test_float_conversion(self):
        """Floats should convert (via string for precision)."""
        result = ensure_decimal(100.5)
        assert result == Decimal("100.5")

    def test_invalid_type(self):
        """Invalid types should raise TypeError."""
        with pytest.raises(TypeError):
            ensure_decimal([100])

        with pytest.raises(TypeError):
            ensure_decimal({"value": 100})
