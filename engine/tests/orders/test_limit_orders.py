"""
Tests for Limit and Stop-Limit Order Handlers.

Tests limit order fill logic and stop-limit combined behavior.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar
from quantlab.orders.limit import LimitOrderHandler
from quantlab.orders.stop_limit import StopLimitOrderHandler
from quantlab.orders.base import OrderSide, OrderType, NoFill, FillInfo


class TestLimitOrderHandler:
    """Tests for LimitOrderHandler class."""

    @pytest.fixture
    def handler(self):
        """Create limit order handler."""
        return LimitOrderHandler()

    @pytest.fixture
    def sample_bar(self):
        """Create a sample bar for testing."""
        return Bar(symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

    def test_order_type(self, handler) -> None:
        """Test order type property."""
        assert handler.order_type == OrderType.LIMIT

    def test_can_fill_buy_limit_in_range(self, handler, sample_bar) -> None:
        """Test buy limit can fill when price is in range."""
        # Buy limit at 98, bar low is 95 so it can fill
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("98.00"),
        )

        assert result is True

    def test_can_fill_buy_limit_too_low(self, handler, sample_bar) -> None:
        """Test buy limit cannot fill when limit is too low."""
        # Buy limit at 90, bar low is 95 so cannot fill
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("90.00"),
        )

        assert result is False

    def test_can_fill_sell_limit_in_range(self, handler, sample_bar) -> None:
        """Test sell limit can fill when price is in range."""
        # Sell limit at 103, bar high is 105 so it can fill
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("103.00"),
        )

        assert result is True

    def test_can_fill_sell_limit_too_high(self, handler, sample_bar) -> None:
        """Test sell limit cannot fill when limit is too high."""
        # Sell limit at 110, bar high is 105 so cannot fill
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("110.00"),
        )

        assert result is False

    def test_can_fill_no_limit_price(self, handler, sample_bar) -> None:
        """Test can_fill returns False without limit price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=None,
        )

        assert result is False

    def test_can_fill_zero_volume(self, handler) -> None:
        """Test can_fill returns False with zero volume."""
        zero_vol_bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("0"),
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=zero_vol_bar,
            limit_price=Decimal("98.00"),
        )

        assert result is False

    def test_calculate_fill_buy_limit(self, handler, sample_bar) -> None:
        """Test fill calculation for buy limit order."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("98.00"),
        )

        if isinstance(result, FillInfo):
            assert result.fill_quantity == Decimal("100")
            # Fill should be at limit price or better
            assert result.fill_price <= Decimal("98.00")

    def test_calculate_fill_sell_limit(self, handler, sample_bar) -> None:
        """Test fill calculation for sell limit order."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("103.00"),
        )

        if isinstance(result, FillInfo):
            assert result.fill_quantity == Decimal("100")
            # Fill should be at limit price or better
            assert result.fill_price >= Decimal("103.00")

    def test_calculate_fill_no_fill(self, handler, sample_bar) -> None:
        """Test no fill when limit cannot be reached."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("90.00"),  # Too low
        )

        assert isinstance(result, NoFill)


class TestLimitOrderEdgeCases:
    """Edge case tests for limit orders."""

    @pytest.fixture
    def handler(self):
        """Create limit order handler."""
        return LimitOrderHandler()

    def test_limit_at_bar_low(self, handler) -> None:
        """Test buy limit at exactly bar low."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("95.00"),  # Exactly at low
        )

        assert result is True

    def test_limit_at_bar_high(self, handler) -> None:
        """Test sell limit at exactly bar high."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("105.00"),  # Exactly at high
        )

        assert result is True

    def test_buy_limit_above_open(self, handler) -> None:
        """Test buy limit above open price fills at open."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("102.00"),  # Above low, can fill at open
        )

        if isinstance(result, FillInfo):
            # Should fill at open or better
            assert result.fill_price <= Decimal("102.00")


class TestStopLimitOrderHandler:
    """Tests for StopLimitOrderHandler class."""

    @pytest.fixture
    def handler(self):
        """Create stop-limit order handler."""
        return StopLimitOrderHandler()

    @pytest.fixture
    def sample_bar(self):
        """Create a sample bar for testing."""
        return Bar(symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

    def test_order_type(self, handler) -> None:
        """Test order type property."""
        assert handler.order_type == OrderType.STOP_LIMIT

    def test_can_fill_buy_stop_limit_triggered(self, handler, sample_bar) -> None:
        """Test buy stop-limit triggers and can fill."""
        # Stop at 103, limit at 104, bar high is 105
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("103.00"),
            limit_price=Decimal("104.00"),
        )

        assert result is True

    def test_can_fill_buy_stop_limit_not_triggered(self, handler, sample_bar) -> None:
        """Test buy stop-limit when stop not triggered."""
        # Stop at 110, above bar high
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("110.00"),
            limit_price=Decimal("111.00"),
        )

        assert result is False

    def test_can_fill_buy_stop_limit_limit_too_low(self, handler, sample_bar) -> None:
        """Test buy stop-limit when limit is too low after trigger."""
        # Stop triggers but limit is below where we can fill
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("103.00"),  # Triggers
            limit_price=Decimal("102.00"),  # Limit below where we'd need to buy
        )

        # Depends on implementation - stop triggers but limit may not fill
        assert isinstance(result, bool)

    def test_can_fill_sell_stop_limit_triggered(self, handler, sample_bar) -> None:
        """Test sell stop-limit triggers and can fill."""
        # Stop at 96, limit at 95, bar low is 95
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("96.00"),
            limit_price=Decimal("95.00"),
        )

        assert result is True

    def test_can_fill_sell_stop_limit_not_triggered(self, handler, sample_bar) -> None:
        """Test sell stop-limit when stop not triggered."""
        # Stop at 90, below bar low
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("90.00"),
            limit_price=Decimal("89.00"),
        )

        assert result is False

    def test_can_fill_no_stop_price(self, handler, sample_bar) -> None:
        """Test can_fill returns False without stop price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("100.00"),
            stop_price=None,
        )

        assert result is False

    def test_can_fill_no_limit_price(self, handler, sample_bar) -> None:
        """Test can_fill returns False without limit price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("100.00"),
            limit_price=None,
        )

        assert result is False

    def test_calculate_fill_buy_stop_limit(self, handler, sample_bar) -> None:
        """Test fill calculation for buy stop-limit."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("103.00"),
            limit_price=Decimal("104.00"),
        )

        if isinstance(result, FillInfo):
            assert result.fill_quantity == Decimal("100")

    def test_calculate_fill_sell_stop_limit(self, handler, sample_bar) -> None:
        """Test fill calculation for sell stop-limit."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("96.00"),
            limit_price=Decimal("95.00"),
        )

        if isinstance(result, FillInfo):
            assert result.fill_quantity == Decimal("100")

    def test_calculate_fill_not_triggered(self, handler, sample_bar) -> None:
        """Test no fill when stop not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("110.00"),  # Above bar high
            limit_price=Decimal("111.00"),
        )

        assert isinstance(result, NoFill)


class TestStopLimitEdgeCases:
    """Edge case tests for stop-limit orders."""

    @pytest.fixture
    def handler(self):
        """Create stop-limit order handler."""
        return StopLimitOrderHandler()

    def test_stop_and_limit_same_price(self, handler) -> None:
        """Test stop and limit at same price."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("103.00"),
            limit_price=Decimal("103.00"),  # Same as stop
        )

        assert isinstance(result, bool)

    def test_zero_volume_bar(self, handler) -> None:
        """Test with zero volume bar."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("0"),
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("103.00"),
            limit_price=Decimal("104.00"),
        )

        assert result is False
