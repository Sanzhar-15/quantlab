"""
Tests for Order Priority Management.

Tests order execution priority and queue management.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.orders.priority import (
    PriorityRule,
    PriorityKey,
    QueuedOrder,
    OrderQueue,
    OrderPriorityManager,
)
from quantlab.orders.base import OrderSide, OrderType


class TestPriorityRule:
    """Tests for PriorityRule enum."""

    def test_fifo(self) -> None:
        """Test FIFO value."""
        assert PriorityRule.FIFO.value == "fifo"

    def test_price_time(self) -> None:
        """Test PRICE_TIME value."""
        assert PriorityRule.PRICE_TIME.value == "price_time"

    def test_pro_rata(self) -> None:
        """Test PRO_RATA value."""
        assert PriorityRule.PRO_RATA.value == "pro_rata"


class TestPriorityKey:
    """Tests for PriorityKey dataclass."""

    def test_creation(self) -> None:
        """Test priority key creation."""
        key = PriorityKey(
            price_priority=100,
            time_priority=1,
            order_id="order-001",
        )
        assert key.price_priority == 100
        assert key.time_priority == 1
        assert key.order_id == "order-001"

    def test_comparison(self) -> None:
        """Test priority key comparison."""
        key1 = PriorityKey(100, 1, "order-001")
        key2 = PriorityKey(200, 1, "order-002")
        # Lower price_priority = higher priority
        assert key1 < key2

    def test_comparison_same_price(self) -> None:
        """Test comparison with same price priority."""
        key1 = PriorityKey(100, 1, "order-001")
        key2 = PriorityKey(100, 2, "order-002")
        # Same price, earlier time wins
        assert key1 < key2

    def test_comparison_same_price_and_time(self) -> None:
        """Test comparison with same price and time."""
        key1 = PriorityKey(100, 1, "order-001")
        key2 = PriorityKey(100, 1, "order-002")
        # Same price and time, order_id breaks tie
        assert key1 < key2

    def test_for_market_order(self) -> None:
        """Test market order priority key."""
        key = PriorityKey.for_market_order(sequence=1, order_id="order-001")
        assert key.price_priority == 0  # Highest priority
        assert key.time_priority == 1
        assert key.order_id == "order-001"

    def test_for_limit_buy_order(self) -> None:
        """Test limit buy order priority key."""
        key = PriorityKey.for_limit_order(
            side=OrderSide.BUY,
            limit_price=Decimal("100.00"),
            sequence=1,
            order_id="order-001",
        )
        # Higher price = higher priority for buys
        assert key.price_priority < 1000000000

    def test_for_limit_sell_order(self) -> None:
        """Test limit sell order priority key."""
        key = PriorityKey.for_limit_order(
            side=OrderSide.SELL,
            limit_price=Decimal("100.00"),
            sequence=1,
            order_id="order-001",
        )
        # Lower price = higher priority for sells
        assert key.price_priority > 0

    def test_buy_price_priority_ordering(self) -> None:
        """Test buy orders: higher price = higher priority."""
        key_high = PriorityKey.for_limit_order(
            side=OrderSide.BUY,
            limit_price=Decimal("105.00"),
            sequence=1,
            order_id="order-001",
        )
        key_low = PriorityKey.for_limit_order(
            side=OrderSide.BUY,
            limit_price=Decimal("100.00"),
            sequence=2,
            order_id="order-002",
        )
        # Higher price ($105) should have higher priority (lower key)
        assert key_high < key_low

    def test_sell_price_priority_ordering(self) -> None:
        """Test sell orders: lower price = higher priority."""
        key_low = PriorityKey.for_limit_order(
            side=OrderSide.SELL,
            limit_price=Decimal("100.00"),
            sequence=1,
            order_id="order-001",
        )
        key_high = PriorityKey.for_limit_order(
            side=OrderSide.SELL,
            limit_price=Decimal("105.00"),
            sequence=2,
            order_id="order-002",
        )
        # Lower price ($100) should have higher priority (lower key)
        assert key_low < key_high

    def test_market_before_limit(self) -> None:
        """Test market orders have priority over limit orders."""
        market_key = PriorityKey.for_market_order(sequence=2, order_id="order-002")
        limit_key = PriorityKey.for_limit_order(
            side=OrderSide.BUY,
            limit_price=Decimal("1000.00"),  # Very high price
            sequence=1,
            order_id="order-001",
        )
        # Market order should have higher priority
        assert market_key < limit_key


class TestQueuedOrder:
    """Tests for QueuedOrder dataclass."""

    def test_creation(self) -> None:
        """Test queued order creation."""
        order = QueuedOrder(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
            stop_price=None,
            created_at=datetime(2024, 1, 15, 10, 30),
            sequence=1,
        )
        assert order.order_id == "order-001"
        assert order.symbol == "AAPL"
        assert order.side == OrderSide.BUY
        assert order.order_type == OrderType.LIMIT
        assert order.quantity == Decimal("100")
        assert order.limit_price == Decimal("150.00")
        assert order.stop_price is None
        assert order.sequence == 1
        assert order.priority_key is None

    def test_comparison_with_priority_keys(self) -> None:
        """Test comparison with priority keys."""
        order1 = QueuedOrder(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            limit_price=None,
            stop_price=None,
            created_at=datetime(2024, 1, 15, 10, 30),
            sequence=1,
            priority_key=PriorityKey(0, 1, "order-001"),
        )
        order2 = QueuedOrder(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            limit_price=None,
            stop_price=None,
            created_at=datetime(2024, 1, 15, 10, 31),
            sequence=2,
            priority_key=PriorityKey(0, 2, "order-002"),
        )
        assert order1 < order2

    def test_comparison_without_priority_keys(self) -> None:
        """Test comparison falls back to sequence."""
        order1 = QueuedOrder(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            limit_price=None,
            stop_price=None,
            created_at=datetime(2024, 1, 15, 10, 30),
            sequence=1,
        )
        order2 = QueuedOrder(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            limit_price=None,
            stop_price=None,
            created_at=datetime(2024, 1, 15, 10, 31),
            sequence=2,
        )
        assert order1 < order2


class TestOrderQueue:
    """Tests for OrderQueue class."""

    @pytest.fixture
    def queue(self) -> OrderQueue:
        """Create an order queue."""
        return OrderQueue(symbol="AAPL")

    def test_init_default(self) -> None:
        """Test default initialization."""
        queue = OrderQueue()
        assert queue.symbol == ""
        assert queue.priority_rule == PriorityRule.PRICE_TIME
        assert queue.price_tick == Decimal("0.01")

    def test_init_custom(self) -> None:
        """Test custom initialization."""
        queue = OrderQueue(
            symbol="MSFT",
            priority_rule=PriorityRule.FIFO,
            price_tick=Decimal("0.05"),
        )
        assert queue.symbol == "MSFT"
        assert queue.priority_rule == PriorityRule.FIFO
        assert queue.price_tick == Decimal("0.05")

    def test_simple_add(self, queue) -> None:
        """Test simple add method for test compatibility."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add("order-001", Decimal("150.00"), ts)
        assert len(queue._simple_orders) == 1

    def test_get_orders_by_price(self, queue) -> None:
        """Test getting orders sorted by price."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add("order-001", Decimal("150.00"), ts)
        queue.add("order-002", Decimal("145.00"), ts)
        queue.add("order-003", Decimal("155.00"), ts)

        orders = queue.get_orders_by_price()
        assert orders[0][1] == Decimal("145.00")
        assert orders[1][1] == Decimal("150.00")
        assert orders[2][1] == Decimal("155.00")

    def test_add_order_market(self, queue) -> None:
        """Test adding market order."""
        ts = datetime(2024, 1, 15, 10, 30)
        order = queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            created_at=ts,
        )
        assert order.order_id == "order-001"
        assert order.priority_key.price_priority == 0
        assert queue.buy_count == 1

    def test_add_order_limit_buy(self, queue) -> None:
        """Test adding limit buy order."""
        ts = datetime(2024, 1, 15, 10, 30)
        order = queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        assert order.order_id == "order-001"
        assert order.limit_price == Decimal("150.00")
        assert queue.buy_count == 1

    def test_add_order_limit_sell(self, queue) -> None:
        """Test adding limit sell order."""
        ts = datetime(2024, 1, 15, 10, 30)
        order = queue.add_order(
            order_id="order-001",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("155.00"),
        )
        assert order.order_id == "order-001"
        assert queue.sell_count == 1

    def test_add_order_stop(self, queue) -> None:
        """Test adding stop order."""
        ts = datetime(2024, 1, 15, 10, 30)
        order = queue.add_order(
            order_id="order-001",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            created_at=ts,
            stop_price=Decimal("145.00"),
        )
        assert order.stop_price == Decimal("145.00")

    def test_get_next_order(self, queue) -> None:
        """Test getting next order without removing."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            created_at=ts,
        )

        order = queue.get_next_order(OrderSide.BUY)
        assert order is not None
        assert order.order_id == "order-001"
        # Should still be in queue
        assert queue.buy_count == 1

    def test_get_next_order_empty(self, queue) -> None:
        """Test getting next order from empty queue."""
        order = queue.get_next_order(OrderSide.BUY)
        assert order is None

    def test_pop_next_order(self, queue) -> None:
        """Test popping next order removes it."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            created_at=ts,
        )

        order = queue.pop_next_order(OrderSide.BUY)
        assert order is not None
        assert order.order_id == "order-001"
        # Should be removed from queue
        assert queue.buy_count == 0

    def test_pop_next_order_empty(self, queue) -> None:
        """Test popping from empty queue."""
        order = queue.pop_next_order(OrderSide.SELL)
        assert order is None

    def test_remove_order(self, queue) -> None:
        """Test removing order by ID."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )

        result = queue.remove_order("order-001")
        assert result is True
        assert queue.buy_count == 0

    def test_remove_order_not_found(self, queue) -> None:
        """Test removing non-existent order."""
        result = queue.remove_order("nonexistent")
        assert result is False

    def test_get_order(self, queue) -> None:
        """Test getting order by ID."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )

        order = queue.get_order("order-001")
        assert order is not None
        assert order.order_id == "order-001"

    def test_get_order_not_found(self, queue) -> None:
        """Test getting non-existent order."""
        order = queue.get_order("nonexistent")
        assert order is None

    def test_get_orders_at_price(self, queue) -> None:
        """Test getting all orders at a price level."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        queue.add_order(
            order_id="order-002",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        queue.add_order(
            order_id="order-003",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("75"),
            created_at=ts,
            limit_price=Decimal("149.00"),  # Different price
        )

        orders = queue.get_orders_at_price(OrderSide.BUY, Decimal("150.00"))
        assert len(orders) == 2
        assert all(o.limit_price == Decimal("150.00") for o in orders)

    def test_buy_count(self, queue) -> None:
        """Test buy order count."""
        ts = datetime(2024, 1, 15, 10, 30)
        assert queue.buy_count == 0

        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            created_at=ts,
        )
        queue.add_order(
            order_id="order-002",
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            quantity=Decimal("50"),
            created_at=ts,
        )

        assert queue.buy_count == 1
        assert queue.sell_count == 1

    def test_clear(self, queue) -> None:
        """Test clearing all orders."""
        ts = datetime(2024, 1, 15, 10, 30)
        queue.add_order(
            order_id="order-001",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
            created_at=ts,
        )
        queue.add_order(
            order_id="order-002",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts,
            limit_price=Decimal("155.00"),
        )

        queue.clear()

        assert queue.buy_count == 0
        assert queue.sell_count == 0

    def test_priority_ordering(self, queue) -> None:
        """Test orders are returned in priority order."""
        ts = datetime(2024, 1, 15, 10, 30)

        # Add market order second
        queue.add_order(
            order_id="order-limit",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        queue.add_order(
            order_id="order-market",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("50"),
            created_at=ts,
        )

        # Market order should have priority
        order = queue.get_next_order(OrderSide.BUY)
        assert order.order_id == "order-market"

    def test_fifo_within_price(self, queue) -> None:
        """Test FIFO ordering within same price."""
        ts1 = datetime(2024, 1, 15, 10, 30)
        ts2 = datetime(2024, 1, 15, 10, 31)

        queue.add_order(
            order_id="order-first",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts1,
            limit_price=Decimal("150.00"),
        )
        queue.add_order(
            order_id="order-second",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts2,
            limit_price=Decimal("150.00"),
        )

        # First order should have priority
        order = queue.get_next_order(OrderSide.BUY)
        assert order.order_id == "order-first"


class TestOrderPriorityManager:
    """Tests for OrderPriorityManager class."""

    @pytest.fixture
    def manager(self) -> OrderPriorityManager:
        """Create a priority manager."""
        return OrderPriorityManager()

    def test_init_default(self) -> None:
        """Test default initialization."""
        manager = OrderPriorityManager()
        assert manager.priority_rule == PriorityRule.PRICE_TIME
        assert manager.default_price_tick == Decimal("0.01")

    def test_init_custom(self) -> None:
        """Test custom initialization."""
        manager = OrderPriorityManager(
            priority_rule=PriorityRule.FIFO,
            default_price_tick=Decimal("0.05"),
        )
        assert manager.priority_rule == PriorityRule.FIFO
        assert manager.default_price_tick == Decimal("0.05")

    def test_set_price_tick(self, manager) -> None:
        """Test setting symbol-specific price tick."""
        manager.set_price_tick("AAPL", Decimal("0.01"))
        manager.set_price_tick("SPY", Decimal("0.01"))

        assert manager._symbol_ticks["AAPL"] == Decimal("0.01")
        assert manager._symbol_ticks["SPY"] == Decimal("0.01")

    def test_get_queue_creates_new(self, manager) -> None:
        """Test getting queue creates new if not exists."""
        queue = manager.get_queue("AAPL")
        assert queue is not None
        assert queue.symbol == "AAPL"

    def test_get_queue_returns_existing(self, manager) -> None:
        """Test getting queue returns existing."""
        queue1 = manager.get_queue("AAPL")
        queue2 = manager.get_queue("AAPL")
        assert queue1 is queue2

    def test_get_queue_uses_symbol_tick(self, manager) -> None:
        """Test get_queue uses symbol-specific price tick."""
        manager.set_price_tick("MSFT", Decimal("0.05"))
        queue = manager.get_queue("MSFT")
        assert queue.price_tick == Decimal("0.05")

    def test_add_order(self, manager) -> None:
        """Test adding order."""
        ts = datetime(2024, 1, 15, 10, 30)
        order = manager.add_order(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        assert order.order_id == "order-001"
        assert order.symbol == "AAPL"

    def test_get_execution_order(self, manager) -> None:
        """Test getting orders in execution order."""
        ts = datetime(2024, 1, 15, 10, 30)

        # Add orders with different prices
        manager.add_order(
            order_id="order-low",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("145.00"),
        )
        manager.add_order(
            order_id="order-high",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        manager.add_order(
            order_id="order-market",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("75"),
            created_at=ts,
        )

        orders = manager.get_execution_order("AAPL", OrderSide.BUY)
        assert len(orders) == 3
        # Market order first, then highest price
        assert orders[0].order_id == "order-market"
        assert orders[1].order_id == "order-high"
        assert orders[2].order_id == "order-low"

    def test_remove_order(self, manager) -> None:
        """Test removing order."""
        ts = datetime(2024, 1, 15, 10, 30)
        manager.add_order(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )

        result = manager.remove_order("AAPL", "order-001")
        assert result is True

        queue = manager.get_queue("AAPL")
        assert queue.buy_count == 0

    def test_remove_order_wrong_symbol(self, manager) -> None:
        """Test removing order with wrong symbol."""
        ts = datetime(2024, 1, 15, 10, 30)
        manager.add_order(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )

        result = manager.remove_order("MSFT", "order-001")
        assert result is False

    def test_remove_order_no_queue(self, manager) -> None:
        """Test removing order when no queue exists."""
        result = manager.remove_order("AAPL", "order-001")
        assert result is False

    def test_clear_symbol(self, manager) -> None:
        """Test clearing all orders for a symbol."""
        ts = datetime(2024, 1, 15, 10, 30)
        manager.add_order(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        manager.add_order(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts,
            limit_price=Decimal("155.00"),
        )

        manager.clear_symbol("AAPL")

        queue = manager.get_queue("AAPL")
        assert queue.buy_count == 0
        assert queue.sell_count == 0

    def test_clear_symbol_no_queue(self, manager) -> None:
        """Test clearing symbol with no queue (no error)."""
        manager.clear_symbol("AAPL")  # Should not raise

    def test_clear_all(self, manager) -> None:
        """Test clearing all orders from all queues."""
        ts = datetime(2024, 1, 15, 10, 30)
        manager.add_order(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        manager.add_order(
            order_id="order-002",
            symbol="MSFT",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts,
            limit_price=Decimal("300.00"),
        )

        manager.clear_all()

        assert manager.get_queue("AAPL").buy_count == 0
        assert manager.get_queue("MSFT").buy_count == 0

    def test_multiple_symbols(self, manager) -> None:
        """Test managing multiple symbols."""
        ts = datetime(2024, 1, 15, 10, 30)

        manager.add_order(
            order_id="aapl-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            created_at=ts,
            limit_price=Decimal("150.00"),
        )
        manager.add_order(
            order_id="msft-001",
            symbol="MSFT",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("50"),
            created_at=ts,
            limit_price=Decimal("310.00"),
        )

        aapl_queue = manager.get_queue("AAPL")
        msft_queue = manager.get_queue("MSFT")

        assert aapl_queue.buy_count == 1
        assert aapl_queue.sell_count == 0
        assert msft_queue.buy_count == 0
        assert msft_queue.sell_count == 1
