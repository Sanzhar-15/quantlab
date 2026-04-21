"""
Tests for Market Order Handler.

Tests market order execution and fill calculation.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar
from quantlab.orders.market import MarketOrderHandler, get_market_fill_price
from quantlab.orders.base import OrderSide, OrderType, OrderRequest, FillInfo, NoFill


class TestMarketOrderHandler:
    """Tests for MarketOrderHandler class."""

    @pytest.fixture
    def handler(self):
        """Create market order handler."""
        return MarketOrderHandler()

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
        assert handler.order_type == OrderType.MARKET

    def test_can_fill_with_volume(self, handler, sample_bar) -> None:
        """Test can_fill returns True with volume."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
        )

        assert result is True

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
        )

        assert result is False

    def test_can_fill_ignores_limit_price(self, handler, sample_bar) -> None:
        """Test can_fill ignores limit price parameter."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("90.00"),  # Ignored for market orders
        )

        assert result is True

    def test_can_fill_ignores_stop_price(self, handler, sample_bar) -> None:
        """Test can_fill ignores stop price parameter."""
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,
            stop_price=Decimal("110.00"),  # Ignored for market orders
        )

        assert result is True

    def test_calculate_fill_basic(self, handler, sample_bar) -> None:
        """Test basic fill calculation."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
        )

        assert isinstance(result, FillInfo)
        assert result.fill_price == sample_bar.open
        assert result.fill_quantity == Decimal("100")
        assert result.remaining_quantity == Decimal("0")

    def test_calculate_fill_zero_volume(self, handler) -> None:
        """Test fill returns NoFill for zero volume."""
        zero_vol_bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("0"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=zero_vol_bar,
        )

        assert isinstance(result, NoFill)
        assert "Zero volume" in result.reason

    def test_calculate_fill_partial_volume_participation(self, handler) -> None:
        """Test fill with volume participation limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000"),  # Small volume
        )

        # Try to fill 500 shares with 10% participation
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("500"),
            bar=bar,
            max_participation=Decimal("0.10"),  # 10% = 100 shares max
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")  # Limited by participation
        assert result.remaining_quantity == Decimal("400")

    def test_calculate_fill_full_participation(self, handler, sample_bar) -> None:
        """Test fill with 100% participation (default)."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            max_participation=Decimal("1.0"),
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        assert result.remaining_quantity == Decimal("0")

    def test_calculate_fill_sell_side(self, handler, sample_bar) -> None:
        """Test fill calculation for sell side."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("50"),
            bar=sample_bar,
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("50")
        assert result.fill_price == sample_bar.open

    def test_try_fill_market_order(self, handler) -> None:
        """Test try_fill method for market orders."""
        request = OrderRequest(
            session_id="test",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = handler.try_fill(request, Decimal("150.00"))

        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("150.00")
        assert result.fill_quantity == Decimal("100")
        assert result.remaining_quantity == Decimal("0")

    def test_fill_reason_message(self, handler, sample_bar) -> None:
        """Test fill has appropriate reason message."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
        )

        assert isinstance(result, FillInfo)
        assert "market" in result.reason.lower() or "open" in result.reason.lower()


class TestMarketOrderEdgeCases:
    """Edge case tests for market orders."""

    @pytest.fixture
    def handler(self):
        """Create market order handler."""
        return MarketOrderHandler()

    def test_very_small_quantity(self, handler) -> None:
        """Test filling very small quantity."""
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
            quantity=Decimal("0.001"),
            bar=bar,
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("0.001")

    def test_very_large_quantity_limited_by_volume(self, handler) -> None:
        """Test large quantity is limited by volume."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("100"),  # Small volume
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("1000"),  # Large quantity
            bar=bar,
            max_participation=Decimal("0.5"),  # 50 shares max
        )

        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("50")
        assert result.remaining_quantity == Decimal("950")

    def test_zero_participation_returns_no_fill(self, handler) -> None:
        """Test zero participation returns NoFill."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1000"),
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            max_participation=Decimal("0"),
        )

        assert isinstance(result, NoFill)


class TestGetMarketFillPrice:
    """Tests for get_market_fill_price function."""

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

    def test_next_open_default(self, sample_bar) -> None:
        """Test next_open is the default fill assumption."""
        result = get_market_fill_price(sample_bar, "next_open")
        assert result == Decimal("100.00")

    def test_next_open_explicit(self, sample_bar) -> None:
        """Test next_open fill assumption."""
        result = get_market_fill_price(sample_bar, "next_open")
        assert result == sample_bar.open

    def test_next_close(self, sample_bar) -> None:
        """Test next_close fill assumption."""
        result = get_market_fill_price(sample_bar, "next_close")
        assert result == sample_bar.close

    def test_typical_price(self, sample_bar) -> None:
        """Test typical_price fill assumption."""
        result = get_market_fill_price(sample_bar, "typical_price")
        assert result == sample_bar.typical_price

    def test_unknown_assumption_defaults_to_open(self, sample_bar) -> None:
        """Test unknown assumption defaults to open."""
        result = get_market_fill_price(sample_bar, "unknown_assumption")
        assert result == sample_bar.open


class TestMarketOrderFillComplete:
    """Tests for FillInfo.is_complete property."""

    @pytest.fixture
    def handler(self):
        """Create market order handler."""
        return MarketOrderHandler()

    def test_complete_fill(self, handler) -> None:
        """Test fill is_complete when fully filled."""
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
        )

        assert isinstance(result, FillInfo)
        assert result.is_complete is True

    def test_partial_fill_not_complete(self, handler) -> None:
        """Test fill is_complete is False for partial fill."""
        bar = Bar(
            symbol="AAPL",
            timestamp=datetime.now(),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("100"),  # Limited volume
        )

        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("500"),
            bar=bar,
            max_participation=Decimal("0.1"),  # Only 10 shares
        )

        assert isinstance(result, FillInfo)
        assert result.is_complete is False
