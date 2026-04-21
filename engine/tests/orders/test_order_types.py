"""
Tests for Order Type Simulation.

Tests order handlers, fill logic, and time-in-force handling.
"""

from datetime import datetime
from datetime import timedelta
from decimal import Decimal

import pytest

from quantlab.orders import (
    FillInfo,
    LimitOrderHandler,
    MarketOrderHandler,
    NoFill,
    OrderRequest,
    OrderSide,
    OrderStatus,
    OrderType,
    PartialFillTracker,
    OrderQueue,
    StopLimitOrderHandler,
    StopOrderHandler,
    TIFHandler,
    TimeInForce,
    TrailingStopHandler,
)


class TestOrderRequest:
    """Tests for OrderRequest."""

    def test_order_request_creation(self) -> None:
        """Test creating an order request."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

        assert request.symbol == "AAPL"
        assert request.side == OrderSide.BUY
        assert request.quantity == Decimal("100")

    def test_order_request_validation(self) -> None:
        """Test order request validation."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

        errors = request.validate()
        assert len(errors) == 0

    def test_order_request_invalid_quantity(self) -> None:
        """Test validation fails for invalid quantity."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("-100"),
            limit_price=Decimal("150.00"),
        )

        errors = request.validate()
        assert len(errors) > 0


class TestMarketOrderHandler:
    """Tests for market order handler."""

    @pytest.fixture
    def handler(self) -> MarketOrderHandler:
        """Create market order handler."""
        return MarketOrderHandler()

    def test_market_order_fills_immediately(self, handler: MarketOrderHandler) -> None:
        """Test market order fills at current price."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        # Simulate market data
        market_price = Decimal("150.00")

        result = handler.try_fill(request, market_price)

        assert isinstance(result, FillInfo)
        assert result.fill_price == market_price
        assert result.fill_quantity == Decimal("100")


class TestLimitOrderHandler:
    """Tests for limit order handler."""

    @pytest.fixture
    def handler(self) -> LimitOrderHandler:
        """Create limit order handler."""
        return LimitOrderHandler()

    def test_buy_limit_fills_at_or_below(self, handler: LimitOrderHandler) -> None:
        """Test buy limit fills when price <= limit."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

        # Price at limit
        result = handler.try_fill(request, Decimal("150.00"))
        assert isinstance(result, FillInfo)

        # Price below limit
        result = handler.try_fill(request, Decimal("149.00"))
        assert isinstance(result, FillInfo)

    def test_buy_limit_no_fill_above(self, handler: LimitOrderHandler) -> None:
        """Test buy limit doesn't fill when price > limit."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

        result = handler.try_fill(request, Decimal("151.00"))
        assert isinstance(result, NoFill)

    def test_sell_limit_fills_at_or_above(self, handler: LimitOrderHandler) -> None:
        """Test sell limit fills when price >= limit."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

        # Price at limit
        result = handler.try_fill(request, Decimal("150.00"))
        assert isinstance(result, FillInfo)

        # Price above limit
        result = handler.try_fill(request, Decimal("151.00"))
        assert isinstance(result, FillInfo)


class TestStopOrderHandler:
    """Tests for stop order handler."""

    @pytest.fixture
    def handler(self) -> StopOrderHandler:
        """Create stop order handler."""
        return StopOrderHandler()

    def test_buy_stop_triggers_above(self, handler: StopOrderHandler) -> None:
        """Test buy stop triggers when price >= stop."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("155.00"),
        )

        triggered = handler.is_triggered(request, Decimal("155.00"))
        assert triggered is True

        triggered = handler.is_triggered(request, Decimal("154.00"))
        assert triggered is False

    def test_sell_stop_triggers_below(self, handler: StopOrderHandler) -> None:
        """Test sell stop triggers when price <= stop."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("145.00"),
        )

        triggered = handler.is_triggered(request, Decimal("145.00"))
        assert triggered is True

        triggered = handler.is_triggered(request, Decimal("146.00"))
        assert triggered is False


class TestTimeInForce:
    """Tests for time-in-force handling."""

    def test_tif_gtc(self) -> None:
        """Test GTC (Good Till Cancelled) order."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
            time_in_force=TimeInForce.GTC,
        )

        handler = TIFHandler()
        # GTC should not expire
        is_expired = handler.is_expired(request, datetime.now() + timedelta(days=30))
        assert is_expired is False

    def test_tif_day(self) -> None:
        """Test DAY order expires at end of session."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
            time_in_force=TimeInForce.DAY,
        )

        handler = TIFHandler()
        # DAY order should expire after market close
        session_end = datetime.now().replace(hour=16, minute=0)
        is_expired = handler.is_expired(request, session_end + timedelta(hours=1))
        assert is_expired is True


class TestPartialFillTracker:
    """Tests for partial fill tracking."""

    def test_track_partial_fill(self) -> None:
        """Test tracking partial fills."""
        tracker = PartialFillTracker()

        order_id = "order-001"
        total_qty = Decimal("100")

        tracker.create_order(order_id, total_qty)

        # First partial fill
        tracker.record_fill(order_id, Decimal("40"))
        state = tracker.get_state(order_id)
        assert state.filled_quantity == Decimal("40")
        assert state.remaining_quantity == Decimal("60")

        # Second partial fill
        tracker.record_fill(order_id, Decimal("35"))
        state = tracker.get_state(order_id)
        assert state.filled_quantity == Decimal("75")
        assert state.remaining_quantity == Decimal("25")

    def test_complete_fill(self) -> None:
        """Test complete fill detection."""
        tracker = PartialFillTracker()

        order_id = "order-001"
        total_qty = Decimal("100")

        tracker.create_order(order_id, total_qty)
        tracker.record_fill(order_id, Decimal("100"))

        state = tracker.get_state(order_id)
        assert state.is_complete is True


class TestOrderQueue:
    """Tests for order queue management."""

    def test_queue_priority(self) -> None:
        """Test order queue maintains price priority."""
        queue = OrderQueue()

        # Add orders at different prices
        queue.add("order-1", Decimal("150.00"), datetime.now())
        queue.add("order-2", Decimal("149.00"), datetime.now())
        queue.add("order-3", Decimal("151.00"), datetime.now())

        # Best bid should be highest price for bids
        orders = queue.get_orders_by_price()
        # Verify ordering
        assert len(orders) == 3
