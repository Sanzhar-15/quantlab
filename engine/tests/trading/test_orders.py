"""
Tests for Order Management module.

Tests Order, OrderManager, and related classes.
"""

import pytest
from decimal import Decimal
from datetime import datetime

from quantlab.trading import (
    OrderType,
    OrderSide,
    OrderStatus,
    TimeInForce,
    Fill,
    Order,
    OrderRequest,
    OrderManager,
    generate_order_id,
)


class TestOrderEnums:
    """Tests for order-related enums."""

    def test_order_type_values(self) -> None:
        """Test order type values."""
        assert OrderType.MARKET.value == "market"
        assert OrderType.LIMIT.value == "limit"
        assert OrderType.STOP.value == "stop"
        assert OrderType.STOP_LIMIT.value == "stop_limit"

    def test_order_side_values(self) -> None:
        """Test order side values."""
        assert OrderSide.BUY.value == "buy"
        assert OrderSide.SELL.value == "sell"

    def test_order_status_values(self) -> None:
        """Test order status values."""
        assert OrderStatus.PENDING.value == "pending"
        assert OrderStatus.SUBMITTED.value == "submitted"
        assert OrderStatus.FILLED.value == "filled"
        assert OrderStatus.CANCELLED.value == "cancelled"

    def test_time_in_force_values(self) -> None:
        """Test time in force values."""
        assert TimeInForce.DAY.value == "day"
        assert TimeInForce.GTC.value == "gtc"
        assert TimeInForce.IOC.value == "ioc"


class TestGenerateOrderId:
    """Tests for generate_order_id function."""

    def test_format(self) -> None:
        """Test order ID format."""
        order_id = generate_order_id()

        assert order_id.startswith("order-")
        assert len(order_id) == 18  # "order-" + 12 hex chars

    def test_uniqueness(self) -> None:
        """Test that IDs are unique."""
        ids = set()
        for _ in range(100):
            ids.add(generate_order_id())

        assert len(ids) == 100


class TestFill:
    """Tests for Fill dataclass."""

    def test_creation(self) -> None:
        """Test fill creation."""
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("150.50"),
            timestamp=datetime.utcnow(),
        )
        assert fill.fill_id == "fill-001"
        assert fill.quantity == Decimal("100")

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("50"),
            price=Decimal("100.00"),
            timestamp=datetime(2024, 1, 1, 12, 0, 0),
            commission=Decimal("1.50"),
        )
        d = fill.to_dict()

        assert d["fillId"] == "fill-001"
        assert d["quantity"] == 50.0
        assert d["price"] == 100.0
        assert d["commission"] == 1.5


class TestOrder:
    """Tests for Order dataclass."""

    @pytest.fixture
    def order(self) -> Order:
        """Create test order."""
        return Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

    def test_creation(self, order: Order) -> None:
        """Test order creation."""
        assert order.order_id == "order-001"
        assert order.symbol == "AAPL"
        assert order.side == OrderSide.BUY
        assert order.status == OrderStatus.PENDING

    def test_is_open(self, order: Order) -> None:
        """Test is_open property."""
        assert order.is_open is True

        order.status = OrderStatus.FILLED
        assert order.is_open is False

    def test_is_complete(self, order: Order) -> None:
        """Test is_complete property."""
        assert order.is_complete is False

        order.status = OrderStatus.FILLED
        assert order.is_complete is True

        order.status = OrderStatus.CANCELLED
        assert order.is_complete is True

    def test_remaining_quantity(self, order: Order) -> None:
        """Test remaining quantity calculation."""
        assert order.remaining_quantity == Decimal("100")

        order.filled_quantity = Decimal("30")
        assert order.remaining_quantity == Decimal("70")

    def test_notional_value(self, order: Order) -> None:
        """Test notional value calculation."""
        # Uses limit price
        assert order.notional_value == Decimal("15000")

    def test_add_fill(self, order: Order) -> None:
        """Test adding a fill."""
        fill = Fill(
            fill_id="fill-001",
            order_id=order.order_id,
            quantity=Decimal("50"),
            price=Decimal("150.50"),
            timestamp=datetime.utcnow(),
        )
        order.add_fill(fill)

        assert order.filled_quantity == Decimal("50")
        assert order.avg_fill_price == Decimal("150.50")
        assert order.status == OrderStatus.PARTIAL

    def test_full_fill(self, order: Order) -> None:
        """Test fully filling an order."""
        fill = Fill(
            fill_id="fill-001",
            order_id=order.order_id,
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime.utcnow(),
        )
        order.add_fill(fill)

        assert order.status == OrderStatus.FILLED
        assert order.filled_at is not None

    def test_submit(self, order: Order) -> None:
        """Test submitting an order."""
        order.submit("broker-001")

        assert order.status == OrderStatus.SUBMITTED
        assert order.broker_order_id == "broker-001"
        assert order.submitted_at is not None

    def test_accept(self, order: Order) -> None:
        """Test accepting an order."""
        order.submit()
        order.accept()

        assert order.status == OrderStatus.ACCEPTED

    def test_cancel(self, order: Order) -> None:
        """Test cancelling an order."""
        order.submit()
        order.cancel()

        assert order.status == OrderStatus.CANCELLED
        assert order.cancelled_at is not None

    def test_reject(self, order: Order) -> None:
        """Test rejecting an order."""
        order.reject("Insufficient funds")

        assert order.status == OrderStatus.REJECTED
        assert order.reject_reason == "Insufficient funds"

    def test_to_dict(self, order: Order) -> None:
        """Test conversion to dictionary."""
        d = order.to_dict()

        assert d["orderId"] == "order-001"
        assert d["symbol"] == "AAPL"
        assert d["side"] == "buy"
        assert d["orderType"] == "limit"
        assert d["quantity"] == 100.0
        assert d["limitPrice"] == 150.0


class TestOrderRequest:
    """Tests for OrderRequest dataclass."""

    def test_creation(self) -> None:
        """Test request creation."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        assert request.symbol == "AAPL"
        assert request.order_type == OrderType.MARKET

    def test_validate_valid_market(self) -> None:
        """Test validation of valid market order."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        errors = request.validate()
        assert len(errors) == 0

    def test_validate_valid_limit(self) -> None:
        """Test validation of valid limit order."""
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

    def test_validate_negative_quantity(self) -> None:
        """Test validation rejects negative quantity."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("-100"),
        )
        errors = request.validate()
        assert len(errors) > 0
        assert "Quantity must be positive" in errors[0]

    def test_validate_limit_without_price(self) -> None:
        """Test validation rejects limit order without price."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
        )
        errors = request.validate()
        assert len(errors) > 0
        assert "Limit price required" in errors[0]

    def test_validate_stop_without_price(self) -> None:
        """Test validation rejects stop order without price."""
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
        )
        errors = request.validate()
        assert len(errors) > 0
        assert "Stop price required" in errors[0]

    def test_validate_stop_limit(self) -> None:
        """Test validation of stop-limit order."""
        # Missing both prices
        request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
        )
        errors = request.validate()
        assert len(errors) == 2


class TestOrderManager:
    """Tests for OrderManager class."""

    @pytest.fixture
    def manager(self) -> OrderManager:
        """Create test manager."""
        return OrderManager()

    @pytest.fixture
    def order_request(self) -> OrderRequest:
        """Create test order request."""
        return OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

    def test_create_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test creating an order."""
        order = manager.create_order(order_request)

        assert order is not None
        assert order.symbol == "AAPL"
        assert order.status == OrderStatus.PENDING

    def test_create_invalid_order(self, manager: OrderManager) -> None:
        """Test creating an invalid order."""
        invalid_request = OrderRequest(
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            # Missing limit_price
        )

        with pytest.raises(ValueError):
            manager.create_order(invalid_request)

    def test_get_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test getting an order by ID."""
        order = manager.create_order(order_request)
        retrieved = manager.get_order(order.order_id)

        assert retrieved is order

    def test_get_orders_for_session(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test getting orders for a session."""
        manager.create_order(order_request)
        manager.create_order(order_request)

        orders = manager.get_orders_for_session("session-001")
        assert len(orders) == 2

    def test_get_open_orders(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test getting open orders."""
        order1 = manager.create_order(order_request)
        order2 = manager.create_order(order_request)

        # Fill one order
        manager.fill_order(
            order1.order_id,
            Decimal("100"),
            Decimal("150.00"),
        )

        open_orders = manager.get_open_orders("session-001")
        assert len(open_orders) == 1
        assert open_orders[0] is order2

    def test_submit_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test submitting an order."""
        order = manager.create_order(order_request)
        manager.submit_order(order.order_id, "broker-001")

        assert order.status == OrderStatus.SUBMITTED
        assert order.broker_order_id == "broker-001"

    def test_accept_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test accepting an order."""
        order = manager.create_order(order_request)
        manager.submit_order(order.order_id)
        manager.accept_order(order.order_id)

        assert order.status == OrderStatus.ACCEPTED

    def test_fill_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test filling an order."""
        order = manager.create_order(order_request)
        fill = manager.fill_order(
            order.order_id,
            Decimal("100"),
            Decimal("150.50"),
            Decimal("1.00"),
        )

        assert fill is not None
        assert order.status == OrderStatus.FILLED
        assert order.filled_quantity == Decimal("100")

    def test_cancel_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test cancelling an order."""
        order = manager.create_order(order_request)
        manager.submit_order(order.order_id)
        manager.cancel_order(order.order_id)

        assert order.status == OrderStatus.CANCELLED

    def test_cancel_filled_order_fails(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test that cancelling a filled order fails."""
        order = manager.create_order(order_request)
        manager.fill_order(
            order.order_id,
            Decimal("100"),
            Decimal("150.00"),
        )

        with pytest.raises(ValueError):
            manager.cancel_order(order.order_id)

    def test_reject_order(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test rejecting an order."""
        order = manager.create_order(order_request)
        manager.reject_order(order.order_id, "Insufficient funds")

        assert order.status == OrderStatus.REJECTED
        assert order.reject_reason == "Insufficient funds"

    def test_cancel_all_orders(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test cancelling all orders for a session."""
        order1 = manager.create_order(order_request)
        order2 = manager.create_order(order_request)
        manager.submit_order(order1.order_id)
        manager.submit_order(order2.order_id)

        cancelled = manager.cancel_all_orders("session-001")

        assert len(cancelled) == 2
        assert order1.status == OrderStatus.CANCELLED
        assert order2.status == OrderStatus.CANCELLED

    def test_order_update_callback(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test order update callback."""
        updates: list[Order] = []
        manager.on_order_update(lambda o: updates.append(o))

        order = manager.create_order(order_request)
        manager.submit_order(order.order_id)

        assert len(updates) >= 1

    def test_fill_callback(
        self,
        manager: OrderManager,
        order_request: OrderRequest,
    ) -> None:
        """Test fill callback."""
        fills: list[tuple[Order, Fill]] = []
        manager.on_fill(lambda o, f: fills.append((o, f)))

        order = manager.create_order(order_request)
        manager.fill_order(
            order.order_id,
            Decimal("100"),
            Decimal("150.00"),
        )

        assert len(fills) == 1
        assert fills[0][0] is order
