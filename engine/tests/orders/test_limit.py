"""
Tests for Limit Order Handler.

Tests limit order execution with price constraints and price improvement.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar
from quantlab.orders.base import FillInfo, NoFill, OrderSide
from quantlab.orders.limit import AggressiveLimitOrderHandler, LimitOrderHandler


class TestLimitOrderHandler:
    """Tests for LimitOrderHandler class."""

    @pytest.fixture
    def handler(self) -> LimitOrderHandler:
        """Create a limit order handler."""
        return LimitOrderHandler()

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

        assert handler.order_type == OrderType.LIMIT

    def test_can_fill_buy_limit_triggered(self, handler, bar) -> None:
        """Test can_fill for triggered buy limit."""
        # Limit at 96, bar low is 95 - triggers
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("96"),
        )

        assert result is True

    def test_can_fill_buy_limit_not_triggered(self, handler, bar) -> None:
        """Test can_fill for non-triggered buy limit."""
        # Limit at 94, bar low is 95 - doesn't trigger
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("94"),
        )

        assert result is False

    def test_can_fill_sell_limit_triggered(self, handler, bar) -> None:
        """Test can_fill for triggered sell limit."""
        # Limit at 104, bar high is 105 - triggers
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("104"),
        )

        assert result is True

    def test_can_fill_sell_limit_not_triggered(self, handler, bar) -> None:
        """Test can_fill for non-triggered sell limit."""
        # Limit at 106, bar high is 105 - doesn't trigger
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("106"),
        )

        assert result is False

    def test_can_fill_no_limit_price(self, handler, bar) -> None:
        """Test can_fill without limit price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=None,
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
            limit_price=Decimal("101"),
        )

        assert result is False

    def test_calculate_fill_no_limit_price(self, handler, bar) -> None:
        """Test calculate_fill without limit price."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=None,
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
            limit_price=Decimal("101"),
        )

        assert isinstance(result, NoFill)
        assert "Zero volume" in result.reason

    def test_calculate_fill_buy_limit_triggered(self, handler, bar) -> None:
        """Test calculate_fill for triggered buy limit."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("96"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        # Price improvement: fills at better of open or limit
        assert result.fill_price == Decimal("96")  # limit < open

    def test_calculate_fill_buy_limit_price_improvement(self, handler) -> None:
        """Test buy limit gets price improvement when open gaps down."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("94"),  # Opens below limit
            high=Decimal("100"),
            low=Decimal("93"),
            close=Decimal("98"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("96"),
        )

        assert isinstance(result, FillInfo)
        # Price improvement: fills at open (better price)
        assert result.fill_price == Decimal("94")

    def test_calculate_fill_buy_limit_not_triggered(self, handler, bar) -> None:
        """Test calculate_fill when buy limit not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("94"),  # Below bar low
        )

        assert isinstance(result, NoFill)
        assert "above limit" in result.reason

    def test_calculate_fill_sell_limit_triggered(self, handler, bar) -> None:
        """Test calculate_fill for triggered sell limit."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("104"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        # Price improvement: fills at better of open or limit
        assert result.fill_price == Decimal("104")  # limit > open

    def test_calculate_fill_sell_limit_price_improvement(self, handler) -> None:
        """Test sell limit gets price improvement when open gaps up."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("106"),  # Opens above limit
            high=Decimal("110"),
            low=Decimal("105"),
            close=Decimal("108"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("104"),
        )

        assert isinstance(result, FillInfo)
        # Price improvement: fills at open (better price)
        assert result.fill_price == Decimal("106")

    def test_calculate_fill_sell_limit_not_triggered(self, handler, bar) -> None:
        """Test calculate_fill when sell limit not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("106"),  # Above bar high
        )

        assert isinstance(result, NoFill)
        assert "below limit" in result.reason

    def test_calculate_fill_volume_participation(self, handler, bar) -> None:
        """Test calculate_fill with volume participation limit."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("5000"),  # Large order
            bar=bar,
            limit_price=Decimal("102"),
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
            limit_price=Decimal("102"),
            max_participation=Decimal("0"),  # Zero participation
        )

        assert isinstance(result, NoFill)
        assert "participation limit" in result.reason


class TestLimitOrderHandlerTryFill:
    """Tests for LimitOrderHandler.try_fill method."""

    @pytest.fixture
    def handler(self) -> LimitOrderHandler:
        """Create a limit order handler."""
        return LimitOrderHandler()

    def test_try_fill_buy_success(self, handler) -> None:
        """Test try_fill for buy when price at or below limit."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150"),
        )

        result = handler.try_fill(request, Decimal("145"))

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        assert result.fill_price == Decimal("145")  # Price improvement

    def test_try_fill_buy_at_limit(self, handler) -> None:
        """Test try_fill for buy when price at limit."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150"),
        )

        result = handler.try_fill(request, Decimal("150"))

        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("150")

    def test_try_fill_buy_above_limit(self, handler) -> None:
        """Test try_fill for buy when price above limit."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150"),
        )

        result = handler.try_fill(request, Decimal("155"))

        assert isinstance(result, NoFill)
        assert "above limit" in result.reason

    def test_try_fill_sell_success(self, handler) -> None:
        """Test try_fill for sell when price at or above limit."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150"),
        )

        result = handler.try_fill(request, Decimal("155"))

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        assert result.fill_price == Decimal("155")  # Price improvement

    def test_try_fill_sell_at_limit(self, handler) -> None:
        """Test try_fill for sell when price at limit."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150"),
        )

        result = handler.try_fill(request, Decimal("150"))

        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("150")

    def test_try_fill_sell_below_limit(self, handler) -> None:
        """Test try_fill for sell when price below limit."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150"),
        )

        result = handler.try_fill(request, Decimal("145"))

        assert isinstance(result, NoFill)
        assert "below limit" in result.reason

    def test_try_fill_no_limit_price(self, handler) -> None:
        """Test try_fill without limit price."""
        from quantlab.orders.base import OrderRequest, OrderType

        request = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=None,
        )

        result = handler.try_fill(request, Decimal("150"))

        assert isinstance(result, NoFill)
        assert "not specified" in result.reason


class TestAggressiveLimitOrderHandler:
    """Tests for AggressiveLimitOrderHandler class."""

    @pytest.fixture
    def handler(self) -> AggressiveLimitOrderHandler:
        """Create an aggressive limit order handler."""
        return AggressiveLimitOrderHandler()

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

    def test_calculate_fill_no_limit_price(self, handler, bar) -> None:
        """Test calculate_fill without limit price."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=None,
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
            limit_price=Decimal("101"),
        )

        assert isinstance(result, NoFill)
        assert "Zero volume" in result.reason

    def test_calculate_fill_buy_no_price_improvement(self, handler) -> None:
        """Test buy limit fills at limit price, not open (no price improvement)."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("94"),  # Opens below limit
            high=Decimal("100"),
            low=Decimal("93"),
            close=Decimal("98"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("96"),
        )

        assert isinstance(result, FillInfo)
        # No price improvement: fills at limit, not open
        assert result.fill_price == Decimal("96")

    def test_calculate_fill_buy_not_triggered(self, handler, bar) -> None:
        """Test calculate_fill when buy limit not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("94"),  # Below bar low
        )

        assert isinstance(result, NoFill)
        assert "above limit" in result.reason

    def test_calculate_fill_sell_no_price_improvement(self, handler) -> None:
        """Test sell limit fills at limit price, not open (no price improvement)."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime(2026, 1, 15),
            open=Decimal("106"),  # Opens above limit
            high=Decimal("110"),
            low=Decimal("105"),
            close=Decimal("108"),
            volume=Decimal("10000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("104"),
        )

        assert isinstance(result, FillInfo)
        # No price improvement: fills at limit, not open
        assert result.fill_price == Decimal("104")

    def test_calculate_fill_sell_not_triggered(self, handler, bar) -> None:
        """Test calculate_fill when sell limit not triggered."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("106"),  # Above bar high
        )

        assert isinstance(result, NoFill)
        assert "below limit" in result.reason

    def test_calculate_fill_volume_participation(self, handler, bar) -> None:
        """Test calculate_fill with volume participation limit."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("5000"),
            bar=bar,
            limit_price=Decimal("102"),
            max_participation=Decimal("0.1"),
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
            volume=Decimal("100"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("1000"),
            bar=bar,
            limit_price=Decimal("102"),
            max_participation=Decimal("0"),
        )

        assert isinstance(result, NoFill)
        assert "participation limit" in result.reason
