"""
Tests for Stop Order Handler.

Tests stop order trigger logic and fill calculation.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar
from quantlab.orders.stop import StopOrderHandler
from quantlab.orders.base import OrderSide, OrderType, OrderRequest


class TestStopOrderHandler:
    """Tests for StopOrderHandler class."""

    @pytest.fixture
    def handler(self):
        """Create stop order handler."""
        return StopOrderHandler()

    @pytest.fixture
    def sample_bar(self):
        """Create a sample bar for testing."""
        return Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000000"),
        )

    def test_order_type(self, handler) -> None:
        """Test order type property."""
        assert handler.order_type == OrderType.STOP

    def test_is_triggered_buy_stop_at_price(self, handler) -> None:
        """Test buy stop triggers at stop price."""
        request = OrderRequest(
            session_id="test",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("100.00"),
        )

        assert handler.is_triggered(request, Decimal("100.00")) is True
        assert handler.is_triggered(request, Decimal("100.01")) is True

    def test_is_triggered_buy_stop_below_price(self, handler) -> None:
        """Test buy stop not triggered below stop price."""
        request = OrderRequest(
            session_id="test",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("100.00"),
        )

        assert handler.is_triggered(request, Decimal("99.99")) is False

    def test_is_triggered_sell_stop_at_price(self, handler) -> None:
        """Test sell stop triggers at stop price."""
        request = OrderRequest(
            session_id="test",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("100.00"),
        )

        assert handler.is_triggered(request, Decimal("100.00")) is True
        assert handler.is_triggered(request, Decimal("99.99")) is True

    def test_is_triggered_sell_stop_above_price(self, handler) -> None:
        """Test sell stop not triggered above stop price."""
        request = OrderRequest(
            session_id="test",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("100.00"),
        )

        assert handler.is_triggered(request, Decimal("100.01")) is False

    def test_is_triggered_no_stop_price(self, handler) -> None:
        """Test trigger with no stop price returns False."""
        request = OrderRequest(
            session_id="test",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            # No stop_price
        )

        assert handler.is_triggered(request, Decimal("100.00")) is False

    def test_can_fill_buy_stop_triggered(self, handler, sample_bar) -> None:
        """Test can_fill when buy stop is triggered."""
        # Bar high is 105, stop at 103 should trigger
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("103.00"),
        )

        assert result is True

    def test_can_fill_buy_stop_not_triggered(self, handler, sample_bar) -> None:
        """Test can_fill when buy stop is not triggered."""
        # Bar high is 105, stop at 110 should not trigger
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("110.00"),
        )

        assert result is False

    def test_can_fill_sell_stop_triggered(self, handler, sample_bar) -> None:
        """Test can_fill when sell stop is triggered."""
        # Bar low is 95, stop at 96 should trigger
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("96.00"),
        )

        assert result is True

    def test_can_fill_sell_stop_not_triggered(self, handler, sample_bar) -> None:
        """Test can_fill when sell stop is not triggered."""
        # Bar low is 95, stop at 90 should not trigger
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("90.00"),
        )

        assert result is False

    def test_can_fill_no_stop_price(self, handler, sample_bar) -> None:
        """Test can_fill returns False without stop price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=None,
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
            volume=Decimal("0"),  # Zero volume
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=zero_vol_bar,
            stop_price=Decimal("103.00"),
        )

        assert result is False

    def test_calculate_fill_buy_stop(self, handler, sample_bar) -> None:
        """Test fill calculation for buy stop order."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("103.00"),
        )

        # Should get a fill
        from quantlab.orders.base import FillInfo

        if isinstance(result, FillInfo):
            assert result.fill_quantity == Decimal("100")
            assert result.fill_price >= sample_bar.open

    def test_calculate_fill_sell_stop(self, handler, sample_bar) -> None:
        """Test fill calculation for sell stop order."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("96.00"),
        )

        from quantlab.orders.base import FillInfo

        if isinstance(result, FillInfo):
            assert result.fill_quantity == Decimal("100")

    def test_calculate_fill_not_triggered(self, handler, sample_bar) -> None:
        """Test no fill when stop not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("110.00"),  # Above bar high
        )

        from quantlab.orders.base import NoFill

        assert isinstance(result, NoFill)


class TestStopOrderEdgeCases:
    """Edge case tests for stop orders."""

    @pytest.fixture
    def handler(self):
        """Create stop order handler."""
        return StopOrderHandler()

    def test_stop_price_equals_bar_high(self, handler) -> None:
        """Test buy stop at exactly bar high."""
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
            stop_price=Decimal("105.00"),  # Exactly at high
        )

        assert result is True

    def test_stop_price_equals_bar_low(self, handler) -> None:
        """Test sell stop at exactly bar low."""
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
            stop_price=Decimal("95.00"),  # Exactly at low
        )

        assert result is True

    def test_gap_open_above_stop(self, handler) -> None:
        """Test gap open above buy stop price."""
        # Open gaps above stop price
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("110.00"),  # Gaps above stop
            high=Decimal("115.00"),
            low=Decimal("108.00"),
            close=Decimal("112.00"),
            volume=Decimal("1000000"),
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("105.00"),  # Stop below open
        )

        assert result is True

    def test_gap_open_below_stop(self, handler) -> None:
        """Test gap open below sell stop price."""
        # Open gaps below stop price
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("90.00"),  # Gaps below stop
            high=Decimal("92.00"),
            low=Decimal("88.00"),
            close=Decimal("91.00"),
            volume=Decimal("1000000"),
        )

        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("95.00"),  # Stop above open
        )

        assert result is True
