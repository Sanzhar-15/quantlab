"""Tests for order base classes and validation."""

from decimal import Decimal

import pytest

from quantlab.orders.base import FillInfo
from quantlab.orders.base import NoFill
from quantlab.orders.base import OrderRequest
from quantlab.orders.base import OrderSide
from quantlab.orders.base import OrderStatus
from quantlab.orders.base import OrderType
from quantlab.orders.base import TimeInForce


class TestOrderSide:
    """Tests for OrderSide enum."""

    def test_buy_side(self):
        """BUY side should have value 'buy'."""
        assert OrderSide.BUY.value == "buy"

    def test_sell_side(self):
        """SELL side should have value 'sell'."""
        assert OrderSide.SELL.value == "sell"


class TestOrderType:
    """Tests for OrderType enum."""

    def test_market_order_type(self):
        """MARKET type should have value 'market'."""
        assert OrderType.MARKET.value == "market"

    def test_limit_order_type(self):
        """LIMIT type should have value 'limit'."""
        assert OrderType.LIMIT.value == "limit"

    def test_stop_order_type(self):
        """STOP type should have value 'stop'."""
        assert OrderType.STOP.value == "stop"

    def test_stop_limit_order_type(self):
        """STOP_LIMIT type should have value 'stop_limit'."""
        assert OrderType.STOP_LIMIT.value == "stop_limit"


class TestTimeInForce:
    """Tests for TimeInForce enum."""

    def test_gfd(self):
        """GFD should have value 'gfd'."""
        assert TimeInForce.GFD.value == "gfd"

    def test_day_is_alias_for_gfd(self):
        """DAY should be an alias for GFD."""
        assert TimeInForce.DAY.value == "gfd"

    def test_gtc(self):
        """GTC should have value 'gtc'."""
        assert TimeInForce.GTC.value == "gtc"

    def test_ioc(self):
        """IOC should have value 'ioc'."""
        assert TimeInForce.IOC.value == "ioc"


class TestOrderStatus:
    """Tests for OrderStatus enum."""

    def test_pending_status(self):
        """PENDING status should have value 'pending'."""
        assert OrderStatus.PENDING.value == "pending"

    def test_open_status(self):
        """OPEN status should have value 'open'."""
        assert OrderStatus.OPEN.value == "open"

    def test_partially_filled_status(self):
        """PARTIALLY_FILLED status should have value 'partially_filled'."""
        assert OrderStatus.PARTIALLY_FILLED.value == "partially_filled"

    def test_filled_status(self):
        """FILLED status should have value 'filled'."""
        assert OrderStatus.FILLED.value == "filled"

    def test_cancelled_status(self):
        """CANCELLED status should have value 'cancelled'."""
        assert OrderStatus.CANCELLED.value == "cancelled"

    def test_rejected_status(self):
        """REJECTED status should have value 'rejected'."""
        assert OrderStatus.REJECTED.value == "rejected"

    def test_expired_status(self):
        """EXPIRED status should have value 'expired'."""
        assert OrderStatus.EXPIRED.value == "expired"


class TestOrderRequest:
    """Tests for OrderRequest dataclass."""

    def test_create_market_order(self):
        """Should create a market order request."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        assert order.symbol == "AAPL"
        assert order.side == OrderSide.BUY
        assert order.order_type == OrderType.MARKET
        assert order.quantity == Decimal("100")
        assert order.limit_price is None
        assert order.stop_price is None
        assert order.time_in_force == TimeInForce.GFD

    def test_create_limit_order(self):
        """Should create a limit order request."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            limit_price=Decimal("150.00"),
        )
        assert order.order_type == OrderType.LIMIT
        assert order.limit_price == Decimal("150.00")

    def test_create_stop_order(self):
        """Should create a stop order request."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("140.00"),
        )
        assert order.order_type == OrderType.STOP
        assert order.stop_price == Decimal("140.00")

    def test_create_stop_limit_order(self):
        """Should create a stop-limit order request."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("155.00"),
            limit_price=Decimal("157.00"),
        )
        assert order.order_type == OrderType.STOP_LIMIT
        assert order.stop_price == Decimal("155.00")
        assert order.limit_price == Decimal("157.00")

    def test_optional_fields(self):
        """Should support optional fields."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            time_in_force=TimeInForce.GTC,
            session_id="session-123",
            client_order_id="client-order-456",
            metadata={"strategy": "momentum"},
        )
        assert order.time_in_force == TimeInForce.GTC
        assert order.session_id == "session-123"
        assert order.client_order_id == "client-order-456"
        assert order.metadata == {"strategy": "momentum"}


class TestOrderRequestValidate:
    """Tests for OrderRequest.validate() method."""

    def test_valid_market_order(self):
        """Valid market order should have no errors."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        errors = order.validate()
        assert errors == []

    def test_zero_quantity(self):
        """Zero quantity should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("0"),
        )
        errors = order.validate()
        assert "Quantity must be positive" in errors

    def test_negative_quantity(self):
        """Negative quantity should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("-100"),
        )
        errors = order.validate()
        assert "Quantity must be positive" in errors

    def test_limit_order_without_limit_price(self):
        """Limit order without limit_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=None,
        )
        errors = order.validate()
        assert "Limit price required for limit orders" in errors

    def test_limit_order_with_zero_limit_price(self):
        """Limit order with zero limit_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("0"),
        )
        errors = order.validate()
        assert "Limit price must be positive" in errors

    def test_limit_order_with_negative_limit_price(self):
        """Limit order with negative limit_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("-50.00"),
        )
        errors = order.validate()
        assert "Limit price must be positive" in errors

    def test_valid_limit_order(self):
        """Valid limit order should have no errors."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )
        errors = order.validate()
        assert errors == []

    def test_stop_order_without_stop_price(self):
        """Stop order without stop_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=None,
        )
        errors = order.validate()
        assert "Stop price required for stop orders" in errors

    def test_stop_order_with_zero_stop_price(self):
        """Stop order with zero stop_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("0"),
        )
        errors = order.validate()
        assert "Stop price must be positive" in errors

    def test_stop_order_with_negative_stop_price(self):
        """Stop order with negative stop_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("-140.00"),
        )
        errors = order.validate()
        assert "Stop price must be positive" in errors

    def test_valid_stop_order(self):
        """Valid stop order should have no errors."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("140.00"),
        )
        errors = order.validate()
        assert errors == []

    def test_stop_limit_without_stop_price(self):
        """Stop-limit order without stop_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=None,
            limit_price=Decimal("157.00"),
        )
        errors = order.validate()
        assert "Stop price required for stop-limit orders" in errors

    def test_stop_limit_without_limit_price(self):
        """Stop-limit order without limit_price should be invalid."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("155.00"),
            limit_price=None,
        )
        errors = order.validate()
        assert "Limit price required for stop-limit orders" in errors

    def test_stop_limit_without_both_prices(self):
        """Stop-limit order without both prices should have both errors."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=None,
            limit_price=None,
        )
        errors = order.validate()
        assert "Stop price required for stop-limit orders" in errors
        assert "Limit price required for stop-limit orders" in errors

    def test_valid_stop_limit_order(self):
        """Valid stop-limit order should have no errors."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("155.00"),
            limit_price=Decimal("157.00"),
        )
        errors = order.validate()
        assert errors == []

    def test_multiple_errors(self):
        """Should collect multiple errors."""
        order = OrderRequest(
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("0"),
            stop_price=None,
            limit_price=None,
        )
        errors = order.validate()
        assert len(errors) == 3
        assert "Quantity must be positive" in errors


class TestFillInfo:
    """Tests for FillInfo dataclass."""

    def test_create_fill_info(self):
        """Should create FillInfo with all fields."""
        fill = FillInfo(
            fill_price=Decimal("150.00"),
            fill_quantity=Decimal("100"),
            remaining_quantity=Decimal("50"),
            reason="Market order filled",
        )
        assert fill.fill_price == Decimal("150.00")
        assert fill.fill_quantity == Decimal("100")
        assert fill.remaining_quantity == Decimal("50")
        assert fill.reason == "Market order filled"

    def test_default_reason(self):
        """Reason should default to empty string."""
        fill = FillInfo(
            fill_price=Decimal("150.00"),
            fill_quantity=Decimal("100"),
            remaining_quantity=Decimal("0"),
        )
        assert fill.reason == ""

    def test_is_complete_true(self):
        """is_complete should be True when remaining is 0."""
        fill = FillInfo(
            fill_price=Decimal("150.00"),
            fill_quantity=Decimal("100"),
            remaining_quantity=Decimal("0"),
        )
        assert fill.is_complete is True

    def test_is_complete_false(self):
        """is_complete should be False when remaining > 0."""
        fill = FillInfo(
            fill_price=Decimal("150.00"),
            fill_quantity=Decimal("50"),
            remaining_quantity=Decimal("50"),
        )
        assert fill.is_complete is False


class TestNoFill:
    """Tests for NoFill dataclass."""

    def test_create_no_fill(self):
        """Should create NoFill with reason."""
        no_fill = NoFill(reason="Price not reached")
        assert no_fill.reason == "Price not reached"

    def test_no_fill_as_fill_result(self):
        """NoFill should be valid FillResult."""
        result: FillInfo | NoFill = NoFill(reason="Zero volume")
        assert isinstance(result, NoFill)
