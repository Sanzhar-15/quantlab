"""
Tests for Stop Order Handler.

Tests stop-market and trailing stop order execution.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar
from quantlab.orders.base import FillInfo, NoFill, OrderSide
from quantlab.orders.stop import StopOrderHandler, TrailingStopHandler


class TestStopOrderHandler:
    """Tests for StopOrderHandler class."""

    @pytest.fixture
    def handler(self) -> StopOrderHandler:
        """Create a stop order handler."""
        return StopOrderHandler()

    @pytest.fixture
    def bar(self) -> Bar:
        """Create a test bar."""
        return Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15, 10, 0, 0),
            open=Decimal("100"),
            high=Decimal("105"),
            low=Decimal("95"),
            close=Decimal("102"),
            volume=Decimal("10000"),
        )

    def test_order_type(self, handler) -> None:
        """Test order type."""
        from quantlab.orders.base import OrderType

        assert handler.order_type == OrderType.STOP

    def test_can_fill_buy_stop_triggered(self, handler, bar) -> None:
        """Test can_fill for triggered buy stop."""
        # Stop at 104, bar high is 105 - triggers
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("104"),
        )

        assert result is True

    def test_can_fill_buy_stop_not_triggered(self, handler, bar) -> None:
        """Test can_fill for non-triggered buy stop."""
        # Stop at 106, bar high is 105 - doesn't trigger
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("106"),
        )

        assert result is False

    def test_can_fill_sell_stop_triggered(self, handler, bar) -> None:
        """Test can_fill for triggered sell stop."""
        # Stop at 96, bar low is 95 - triggers
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("96"),
        )

        assert result is True

    def test_can_fill_sell_stop_not_triggered(self, handler, bar) -> None:
        """Test can_fill for non-triggered sell stop."""
        # Stop at 94, bar low is 95 - doesn't trigger
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("94"),
        )

        assert result is False

    def test_can_fill_no_stop_price(self, handler, bar) -> None:
        """Test can_fill without stop price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=None,
        )

        assert result is False

    def test_can_fill_zero_volume(self, handler) -> None:
        """Test can_fill with zero volume bar."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("100"),
            low=Decimal("100"),
            close=Decimal("100"),
            volume=Decimal("0"),
        )

        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("104"),
        )

        assert result is False

    def test_calculate_fill_no_stop_price(self, handler, bar) -> None:
        """Test calculate_fill without stop price."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=None,
        )

        assert isinstance(result, NoFill)
        assert "not specified" in result.reason

    def test_calculate_fill_zero_volume(self, handler) -> None:
        """Test calculate_fill with zero volume."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("100"),
            low=Decimal("100"),
            close=Decimal("100"),
            volume=Decimal("0"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("104"),
        )

        assert isinstance(result, NoFill)
        assert "Zero volume" in result.reason

    def test_calculate_fill_buy_stop_triggered(self, handler, bar) -> None:
        """Test calculate_fill for triggered buy stop."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("104"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        assert result.fill_price == Decimal("104")  # Fills at stop

    def test_calculate_fill_buy_stop_gap_through(self, handler) -> None:
        """Test calculate_fill for buy stop with gap through."""
        # Open gaps above stop price
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("106"),  # Opens above stop
            high=Decimal("110"),
            low=Decimal("105"),
            close=Decimal("108"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("104"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("106")  # Fills at open (slippage)

    def test_calculate_fill_sell_stop_triggered(self, handler, bar) -> None:
        """Test calculate_fill for triggered sell stop."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("96"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        assert result.fill_price == Decimal("96")

    def test_calculate_fill_sell_stop_gap_through(self, handler) -> None:
        """Test calculate_fill for sell stop with gap through."""
        # Open gaps below stop price
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("94"),  # Opens below stop
            high=Decimal("96"),
            low=Decimal("92"),
            close=Decimal("93"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("96"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("94")  # Fills at open (slippage)

    def test_calculate_fill_not_triggered(self, handler, bar) -> None:
        """Test calculate_fill when stop not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("110"),  # Stop above high
        )

        assert isinstance(result, NoFill)
        assert "not triggered" in result.reason

    def test_calculate_fill_volume_participation(self, handler, bar) -> None:
        """Test calculate_fill with volume participation limit."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("5000"),  # Large order
            bar=bar,
            stop_price=Decimal("104"),
            max_participation=Decimal("0.1"),  # 10% of 10000 = 1000
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("1000")
        assert result.remaining_quantity == Decimal("4000")

    def test_calculate_fill_exceeds_participation(self, handler) -> None:
        """Test calculate_fill when participation limit yields zero fill."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("105"),
            low=Decimal("95"),
            close=Decimal("102"),
            volume=Decimal("100"),  # Very low volume
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("1000"),
            bar=bar,
            stop_price=Decimal("104"),
            max_participation=Decimal("0"),  # Zero participation
        )

        assert isinstance(result, NoFill)
        assert "participation limit" in result.reason


class TestStopOrderHandlerIsTriggered:
    """Tests for StopOrderHandler.is_triggered method."""

    @pytest.fixture
    def handler(self) -> StopOrderHandler:
        """Create a stop order handler."""
        return StopOrderHandler()

    def test_is_triggered_buy_above(self, handler) -> None:
        """Test buy stop triggered when price above stop."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150"),
        )

        assert handler.is_triggered(request, Decimal("155")) is True

    def test_is_triggered_buy_at(self, handler) -> None:
        """Test buy stop triggered when price at stop."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150"),
        )

        assert handler.is_triggered(request, Decimal("150")) is True

    def test_is_triggered_buy_below(self, handler) -> None:
        """Test buy stop not triggered when price below stop."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150"),
        )

        assert handler.is_triggered(request, Decimal("145")) is False

    def test_is_triggered_sell_below(self, handler) -> None:
        """Test sell stop triggered when price below stop."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150"),
        )

        assert handler.is_triggered(request, Decimal("145")) is True

    def test_is_triggered_sell_at(self, handler) -> None:
        """Test sell stop triggered when price at stop."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150"),
        )

        assert handler.is_triggered(request, Decimal("150")) is True

    def test_is_triggered_sell_above(self, handler) -> None:
        """Test sell stop not triggered when price above stop."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150"),
        )

        assert handler.is_triggered(request, Decimal("155")) is False

    def test_is_triggered_no_stop_price(self, handler) -> None:
        """Test is_triggered without stop price."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=None,
        )

        assert handler.is_triggered(request, Decimal("150")) is False


class TestTrailingStopHandler:
    """Tests for TrailingStopHandler class."""

    def test_init_with_trail_amount(self) -> None:
        """Test initialization with trail amount."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))

        assert handler.trail_amount == Decimal("5")
        assert handler.trail_percent is None

    def test_init_with_trail_percent(self) -> None:
        """Test initialization with trail percent."""
        handler = TrailingStopHandler(trail_percent=Decimal("0.05"))

        assert handler.trail_amount is None
        assert handler.trail_percent == Decimal("0.05")

    def test_init_missing_trail_value(self) -> None:
        """Test initialization without trail value raises error."""
        with pytest.raises(ValueError, match="Either trail_amount or trail_percent"):
            TrailingStopHandler()

    def test_order_type(self) -> None:
        """Test order type."""
        from quantlab.orders.base import OrderType

        handler = TrailingStopHandler(trail_amount=Decimal("5"))
        assert handler.order_type == OrderType.STOP

    def test_update_watermark_sell_amount(self) -> None:
        """Test update_watermark for sell with trail amount."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))

        # Initial price
        stop = handler.update_watermark("order1", OrderSide.SELL, Decimal("100"))
        assert stop == Decimal("95")  # 100 - 5

        # Price rises - stop should trail up
        stop = handler.update_watermark("order1", OrderSide.SELL, Decimal("110"))
        assert stop == Decimal("105")  # 110 - 5

        # Price falls - stop stays at watermark
        stop = handler.update_watermark("order1", OrderSide.SELL, Decimal("105"))
        assert stop == Decimal("105")  # Watermark is still 110

    def test_update_watermark_sell_percent(self) -> None:
        """Test update_watermark for sell with trail percent."""
        handler = TrailingStopHandler(trail_percent=Decimal("0.05"))

        stop = handler.update_watermark("order1", OrderSide.SELL, Decimal("100"))
        assert stop == Decimal("95")  # 100 * 0.95

        stop = handler.update_watermark("order1", OrderSide.SELL, Decimal("110"))
        assert stop == Decimal("104.5")  # 110 * 0.95

    def test_update_watermark_buy_amount(self) -> None:
        """Test update_watermark for buy with trail amount."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))

        # Initial price
        stop = handler.update_watermark("order1", OrderSide.BUY, Decimal("100"))
        assert stop == Decimal("105")  # 100 + 5

        # Price falls - stop should trail down
        stop = handler.update_watermark("order1", OrderSide.BUY, Decimal("90"))
        assert stop == Decimal("95")  # 90 + 5

        # Price rises - stop stays at watermark
        stop = handler.update_watermark("order1", OrderSide.BUY, Decimal("95"))
        assert stop == Decimal("95")  # Watermark is still 90

    def test_update_watermark_buy_percent(self) -> None:
        """Test update_watermark for buy with trail percent."""
        handler = TrailingStopHandler(trail_percent=Decimal("0.05"))

        stop = handler.update_watermark("order1", OrderSide.BUY, Decimal("100"))
        assert stop == Decimal("105")  # 100 * 1.05

        stop = handler.update_watermark("order1", OrderSide.BUY, Decimal("90"))
        assert stop == Decimal("94.5")  # 90 * 1.05

    def test_can_fill_triggered(self) -> None:
        """Test can_fill when triggered."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("105"),
            low=Decimal("95"),
            close=Decimal("102"),
            volume=Decimal("10000"),
        )

        # Sell stop at 96, bar low is 95 - triggers
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("96"),
        )

        assert result is True

    def test_can_fill_not_triggered(self) -> None:
        """Test can_fill when not triggered."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("105"),
            low=Decimal("95"),
            close=Decimal("102"),
            volume=Decimal("10000"),
        )

        # Sell stop at 94, bar low is 95 - doesn't trigger
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("94"),
        )

        assert result is False

    def test_can_fill_no_stop_price(self) -> None:
        """Test can_fill without stop price."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("105"),
            low=Decimal("95"),
            close=Decimal("102"),
            volume=Decimal("10000"),
        )

        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=None,
        )

        assert result is False

    def test_can_fill_zero_volume(self) -> None:
        """Test can_fill with zero volume."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("100"),
            low=Decimal("100"),
            close=Decimal("100"),
            volume=Decimal("0"),
        )

        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("96"),
        )

        assert result is False

    def test_calculate_fill(self) -> None:
        """Test calculate_fill delegates to StopOrderHandler."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("100"),
            high=Decimal("105"),
            low=Decimal("95"),
            close=Decimal("102"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            stop_price=Decimal("96"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")

    def test_clear_watermark(self) -> None:
        """Test clearing watermarks."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))

        # Set watermarks
        handler.update_watermark("order1", OrderSide.SELL, Decimal("100"))
        handler.update_watermark("order2", OrderSide.BUY, Decimal("100"))

        assert "order1" in handler._high_water_mark
        assert "order2" in handler._low_water_mark

        # Clear one
        handler.clear_watermark("order1")
        handler.clear_watermark("order2")

        assert "order1" not in handler._high_water_mark
        assert "order2" not in handler._low_water_mark

    def test_clear_watermark_nonexistent(self) -> None:
        """Test clearing nonexistent watermark doesn't raise."""
        handler = TrailingStopHandler(trail_amount=Decimal("5"))

        # Should not raise
        handler.clear_watermark("nonexistent")
