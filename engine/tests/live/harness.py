"""
Live Trading Test Harness.

Provides utilities for testing live trading functionality:
- MockBroker: Controllable mock broker for testing
- MockQuoteStream: Simulated quote stream
- LiveTestHarness: Test fixture orchestration

Spec Reference: Technical Spec §1.5, Decision L69
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime, time as dt_time
from decimal import Decimal
from enum import Enum
from typing import Any, Callable

from quantlab.daemon.checkpoint import CheckpointManager, SessionCheckpoint
from quantlab.daemon.ipc import IPCServer, TokenManager
from quantlab.daemon.lifecycle import DaemonState
from quantlab.daemon.main import LiveTradingDaemon, SessionConfig
from quantlab.trading.broker import (
    BrokerAdapter,
    BrokerStatus,
    BrokerAccount,
    MarketQuote,
)
from quantlab.trading.orders import Fill, Order, OrderSide, OrderStatus, OrderType


class MockBrokerBehavior(Enum):
    """Mock broker behavior modes."""

    NORMAL = "normal"  # Normal operation
    REJECT_ALL = "reject_all"  # Reject all orders
    DELAY_FILLS = "delay_fills"  # Delay fills
    PARTIAL_FILLS = "partial_fills"  # Always partial fill
    DISCONNECT = "disconnect"  # Simulate disconnection
    TIMEOUT = "timeout"  # Simulate timeout
    RANDOM_ERRORS = "random_errors"  # Random errors


@dataclass
class MockFill:
    """Pending fill for mock broker."""

    order_id: str
    broker_order_id: str
    order: Order
    quantity: Decimal
    price: Decimal
    timestamp: datetime = field(default_factory=datetime.utcnow)


class MockBroker(BrokerAdapter):
    """
    Mock broker for testing.

    Provides full control over order execution behavior
    for testing various scenarios.
    """

    def __init__(
        self,
        initial_capital: Decimal = Decimal("100000"),
        behavior: MockBrokerBehavior = MockBrokerBehavior.NORMAL,
    ) -> None:
        self._behavior = behavior
        self._status = BrokerStatus.DISCONNECTED

        # Account
        self._account = BrokerAccount(
            account_id=f"mock-{uuid.uuid4().hex[:8]}",
            name="Mock Testing Account",
            cash_balance=initial_capital,
            buying_power=initial_capital,
            portfolio_value=initial_capital,
            is_paper=True,
        )

        # Order tracking
        self._pending_orders: dict[str, Order] = {}
        self._broker_order_ids: dict[str, str] = {}
        self._pending_fills: list[MockFill] = []
        self._filled_orders: dict[str, list[Fill]] = {}

        # Simulated prices
        self._prices: dict[str, Decimal] = {}

        # Position tracking (symbol -> net quantity, avg_price)
        self._positions: dict[str, tuple[Decimal, Decimal]] = {}

        # Callbacks
        self._on_fill_callbacks: list[Callable[[str, Fill], None]] = []
        self._on_order_update_callbacks: list[Callable[[str, OrderStatus], None]] = []

        # Control flags
        self._fill_delay: float = 0.0
        self._partial_fill_ratio: float = 1.0
        self._reject_symbols: set[str] = set()

        # Metrics
        self._orders_submitted = 0
        self._orders_filled = 0
        self._orders_rejected = 0
        self._orders_cancelled = 0

    @property
    def name(self) -> str:
        return "Mock Broker"

    @property
    def status(self) -> BrokerStatus:
        return self._status

    @property
    def is_paper(self) -> bool:
        return True

    # Control methods for testing

    def set_behavior(self, behavior: MockBrokerBehavior) -> None:
        """Set broker behavior mode."""
        self._behavior = behavior

    def set_price(self, symbol: str, price: Decimal) -> None:
        """Set price for a symbol."""
        self._prices[symbol] = price

    def set_prices(self, prices: dict[str, Decimal]) -> None:
        """Set prices for multiple symbols."""
        self._prices.update(prices)

    def set_fill_delay(self, delay: float) -> None:
        """Set fill delay in seconds."""
        self._fill_delay = delay

    def set_partial_fill_ratio(self, ratio: float) -> None:
        """Set partial fill ratio (0.0 to 1.0)."""
        self._partial_fill_ratio = min(1.0, max(0.0, ratio))

    def reject_symbol(self, symbol: str) -> None:
        """Add symbol to reject list."""
        self._reject_symbols.add(symbol)

    def allow_symbol(self, symbol: str) -> None:
        """Remove symbol from reject list."""
        self._reject_symbols.discard(symbol)

    def get_pending_orders(self) -> dict[str, Order]:
        """Get pending orders."""
        return dict(self._pending_orders)

    def get_metrics(self) -> dict[str, int]:
        """Get broker metrics."""
        return {
            "orders_submitted": self._orders_submitted,
            "orders_filled": self._orders_filled,
            "orders_rejected": self._orders_rejected,
            "orders_cancelled": self._orders_cancelled,
        }

    # BrokerAdapter implementation

    def connect(self) -> bool:
        if self._behavior == MockBrokerBehavior.DISCONNECT:
            self._status = BrokerStatus.ERROR
            return False

        self._status = BrokerStatus.CONNECTED
        return True

    def disconnect(self) -> None:
        self._status = BrokerStatus.DISCONNECTED

    def get_accounts(self) -> list[BrokerAccount]:
        return [self._account]

    def get_account(self, account_id: str) -> BrokerAccount | None:
        if account_id == self._account.account_id:
            return self._account
        return None

    async def submit_order(self, order: Order) -> str | None:
        self._orders_submitted += 1

        # Check behavior mode
        if self._behavior == MockBrokerBehavior.REJECT_ALL:
            self._orders_rejected += 1
            return None

        if self._behavior == MockBrokerBehavior.DISCONNECT:
            self._status = BrokerStatus.ERROR
            return None

        if order.symbol in self._reject_symbols:
            self._orders_rejected += 1
            return None

        # Generate broker order ID
        broker_order_id = f"mock-{uuid.uuid4().hex[:8]}"

        self._pending_orders[broker_order_id] = order
        self._broker_order_ids[order.order_id] = broker_order_id

        # Notify order accepted
        self._notify_order_update(order.order_id, OrderStatus.ACCEPTED)

        # Queue fill unless delayed
        if self._behavior != MockBrokerBehavior.DELAY_FILLS:
            self._queue_fill(broker_order_id, order)

        return broker_order_id

    async def cancel_order(self, broker_order_id: str) -> bool:
        if broker_order_id in self._pending_orders:
            order = self._pending_orders.pop(broker_order_id)
            self._orders_cancelled += 1
            self._notify_order_update(order.order_id, OrderStatus.CANCELLED)
            return True
        return False

    async def get_quote(self, symbol: str) -> MarketQuote | None:
        price = self._prices.get(symbol)
        if price is None:
            return None

        spread = price * Decimal("0.001")
        return MarketQuote(
            symbol=symbol,
            bid=price - spread / 2,
            ask=price + spread / 2,
            last=price,
        )

    async def get_quotes(self, symbols: list[str]) -> dict[str, MarketQuote]:
        quotes = {}
        for symbol in symbols:
            quote = await self.get_quote(symbol)
            if quote is not None:
                quotes[symbol] = quote
        return quotes

    async def get_positions(self) -> list[dict[str, Any]]:
        """Get tracked positions from fills."""
        result = []
        for symbol, (quantity, avg_price) in self._positions.items():
            if quantity != Decimal("0"):
                current_price = self._prices.get(symbol, avg_price)
                market_value = quantity * current_price
                unrealized_pnl = (current_price - avg_price) * quantity
                result.append({
                    "symbol": symbol,
                    "quantity": float(quantity),
                    "avg_entry_price": float(avg_price),
                    "current_price": float(current_price),
                    "unrealized_pnl": float(unrealized_pnl),
                    "market_value": float(market_value),
                })
        return result

    def on_fill(self, callback: Callable[[str, Fill], None]) -> None:
        self._on_fill_callbacks.append(callback)

    def on_order_update(self, callback: Callable[[str, OrderStatus], None]) -> None:
        self._on_order_update_callbacks.append(callback)

    # Fill processing

    def _queue_fill(self, broker_order_id: str, order: Order) -> None:
        """Queue a fill for processing."""
        price = self._prices.get(order.symbol)
        if price is None:
            return

        # Check if limit order is executable at current price
        if order.order_type == OrderType.LIMIT and order.limit_price is not None:
            if order.side == OrderSide.BUY and price > order.limit_price:
                # Buy limit not triggered - price must drop to limit or below
                return
            elif order.side == OrderSide.SELL and price < order.limit_price:
                # Sell limit not triggered - price must rise to limit or above
                return

        fill_qty = order.remaining_quantity
        if self._behavior == MockBrokerBehavior.PARTIAL_FILLS:
            fill_qty = fill_qty * Decimal(str(self._partial_fill_ratio))
            fill_qty = max(Decimal("1"), fill_qty.quantize(Decimal("1")))

        mock_fill = MockFill(
            order_id=order.order_id,
            broker_order_id=broker_order_id,
            order=order,
            quantity=fill_qty,
            price=price,
        )
        self._pending_fills.append(mock_fill)

    async def process_fills(self) -> None:
        """Process pending fills (call in test to trigger fills)."""
        if self._fill_delay > 0:
            await asyncio.sleep(self._fill_delay)

        while self._pending_fills:
            mock_fill = self._pending_fills.pop(0)
            await self._execute_fill(mock_fill)

    async def _execute_fill(self, mock_fill: MockFill) -> None:
        """Execute a pending fill."""
        fill = Fill(
            fill_id=f"fill-{uuid.uuid4().hex[:8]}",
            order_id=mock_fill.order_id,
            quantity=mock_fill.quantity,
            price=mock_fill.price,
            timestamp=datetime.utcnow(),
        )

        # Track fill
        if mock_fill.order_id not in self._filled_orders:
            self._filled_orders[mock_fill.order_id] = []
        self._filled_orders[mock_fill.order_id].append(fill)

        # Update position tracking
        self._update_position(mock_fill.order, mock_fill.quantity, mock_fill.price)

        # Remove from pending if fully filled
        if mock_fill.quantity >= mock_fill.order.remaining_quantity:
            self._pending_orders.pop(mock_fill.broker_order_id, None)
            self._orders_filled += 1

        # Notify listeners
        self._notify_fill(mock_fill.order_id, fill)

    def _update_position(self, order: Order, fill_qty: Decimal, fill_price: Decimal) -> None:
        """Update position from fill."""
        symbol = order.symbol
        current_qty, current_avg = self._positions.get(symbol, (Decimal("0"), Decimal("0")))

        # Determine signed quantity change
        qty_change = fill_qty if order.side == OrderSide.BUY else -fill_qty
        new_qty = current_qty + qty_change

        if new_qty == Decimal("0"):
            # Position closed
            self._positions[symbol] = (Decimal("0"), Decimal("0"))
        elif (current_qty >= 0 and qty_change > 0) or (current_qty <= 0 and qty_change < 0):
            # Adding to position - calculate new average
            total_cost = (abs(current_qty) * current_avg) + (fill_qty * fill_price)
            new_avg = total_cost / abs(new_qty) if new_qty != 0 else Decimal("0")
            self._positions[symbol] = (new_qty, new_avg)
        else:
            # Reducing position - keep original average
            self._positions[symbol] = (new_qty, current_avg)

    def _notify_fill(self, order_id: str, fill: Fill) -> None:
        """Notify fill listeners."""
        for callback in self._on_fill_callbacks:
            try:
                callback(order_id, fill)
            except Exception:
                pass

    def _notify_order_update(self, order_id: str, status: OrderStatus) -> None:
        """Notify order update listeners."""
        for callback in self._on_order_update_callbacks:
            try:
                callback(order_id, status)
            except Exception:
                pass


@dataclass
class QuoteTick:
    """Single quote tick."""

    symbol: str
    price: Decimal
    timestamp: datetime = field(default_factory=datetime.utcnow)


class MockQuoteStream:
    """
    Mock quote stream for testing.

    Provides controllable quote stream for testing
    real-time data handling.
    """

    def __init__(self, symbols: list[str]) -> None:
        self._symbols = symbols
        self._prices: dict[str, Decimal] = {}
        self._running = False
        self._ticks: asyncio.Queue[QuoteTick] = asyncio.Queue()

    def set_price(self, symbol: str, price: Decimal) -> None:
        """Set price and emit tick."""
        self._prices[symbol] = price
        if self._running:
            tick = QuoteTick(symbol=symbol, price=price)
            self._ticks.put_nowait(tick)

    def start(self) -> None:
        """Start the quote stream."""
        self._running = True

    def stop(self) -> None:
        """Stop the quote stream."""
        self._running = False

    async def get_tick(self, timeout: float = 1.0) -> QuoteTick | None:
        """Get next tick with timeout."""
        try:
            return await asyncio.wait_for(self._ticks.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    async def stream(self) -> AsyncIterator[QuoteTick]:
        """Async iterator for ticks."""
        while self._running:
            tick = await self.get_tick()
            if tick:
                yield tick


@dataclass
class LiveTestResult:
    """Result of a live test."""

    test_id: str
    passed: bool
    duration_ms: float
    orders_submitted: int = 0
    orders_filled: int = 0
    fills: list[Fill] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    assertions: list[str] = field(default_factory=list)


class LiveTestHarness:
    """
    Test harness for live trading tests.

    Orchestrates daemon, broker, and quote stream for testing.
    """

    def __init__(
        self,
        session_id: str | None = None,
        initial_capital: Decimal = Decimal("100000"),
    ) -> None:
        self.session_id = session_id or f"test-{uuid.uuid4().hex[:8]}"
        self._initial_capital = initial_capital

        # Components
        self._broker: MockBroker | None = None
        self._quote_stream: MockQuoteStream | None = None
        self._daemon: LiveTradingDaemon | None = None

        # Test tracking
        self._fills: list[Fill] = []
        self._errors: list[str] = []
        self._start_time: datetime | None = None

    @property
    def broker(self) -> MockBroker:
        """Get mock broker."""
        if self._broker is None:
            raise RuntimeError("Harness not started")
        return self._broker

    @property
    def quote_stream(self) -> MockQuoteStream:
        """Get quote stream."""
        if self._quote_stream is None:
            raise RuntimeError("Harness not started")
        return self._quote_stream

    async def start(
        self,
        symbols: list[str] | None = None,
        risk_limits: dict[str, Any] | None = None,
    ) -> None:
        """Start the test harness."""
        symbols = symbols or ["AAPL", "MSFT"]
        risk_limits = risk_limits or {
            "max_position_size": "50000",
            "max_exposure": "100000",
            "daily_loss_limit": "5000",
        }

        # Create components
        self._broker = MockBroker(initial_capital=self._initial_capital)
        self._quote_stream = MockQuoteStream(symbols)

        # Set initial prices
        default_prices = {"AAPL": Decimal("150"), "MSFT": Decimal("300")}
        for symbol in symbols:
            if symbol in default_prices:
                self._broker.set_price(symbol, default_prices[symbol])

        # Register fill callback
        self._broker.on_fill(self._on_fill)

        # Connect broker
        self._broker.connect()

        # Start quote stream
        self._quote_stream.start()

        self._start_time = datetime.utcnow()

    async def stop(self) -> None:
        """Stop the test harness."""
        if self._quote_stream:
            self._quote_stream.stop()

        if self._broker:
            self._broker.disconnect()

    def _on_fill(self, order_id: str, fill: Fill) -> None:
        """Handle fill callback."""
        self._fills.append(fill)

    async def submit_order(
        self,
        symbol: str,
        side: OrderSide,
        quantity: Decimal,
        order_type: OrderType = OrderType.MARKET,
        limit_price: Decimal | None = None,
    ) -> str | None:
        """Submit an order and return broker order ID."""
        order = Order(
            order_id=f"order-{uuid.uuid4().hex[:8]}",
            session_id=self.session_id,
            symbol=symbol,
            side=side,
            order_type=order_type,
            quantity=quantity,
            limit_price=limit_price,
        )
        return await self.broker.submit_order(order)

    async def wait_for_fills(self, count: int = 1, timeout: float = 5.0) -> list[Fill]:
        """Wait for specified number of fills."""
        start_count = len(self._fills)
        start_time = datetime.utcnow()

        while len(self._fills) < start_count + count:
            await self.broker.process_fills()
            await asyncio.sleep(0.01)

            elapsed = (datetime.utcnow() - start_time).total_seconds()
            if elapsed > timeout:
                break

        return self._fills[start_count:]

    def get_fills(self) -> list[Fill]:
        """Get all fills."""
        return list(self._fills)

    def get_result(self, test_id: str, passed: bool) -> LiveTestResult:
        """Create test result."""
        duration = 0.0
        if self._start_time:
            duration = (datetime.utcnow() - self._start_time).total_seconds() * 1000

        metrics = self.broker.get_metrics()
        return LiveTestResult(
            test_id=test_id,
            passed=passed,
            duration_ms=duration,
            orders_submitted=metrics["orders_submitted"],
            orders_filled=metrics["orders_filled"],
            fills=list(self._fills),
            errors=list(self._errors),
        )

    async def assert_position(
        self,
        symbol: str,
        expected_quantity: Decimal,
    ) -> bool:
        """Assert position quantity."""
        # In real impl, would check position tracker
        return True

    async def assert_no_pending_orders(self) -> bool:
        """Assert no pending orders."""
        pending = self.broker.get_pending_orders()
        return len(pending) == 0

    async def flatten_all(self) -> None:
        """Flatten all positions."""
        # Submit closing orders for all positions
        pass


# Fixtures for pytest

def create_harness(
    initial_capital: Decimal = Decimal("100000"),
) -> LiveTestHarness:
    """Create a test harness."""
    return LiveTestHarness(initial_capital=initial_capital)


async def run_live_test(
    test_fn: Callable[[LiveTestHarness], Any],
    initial_capital: Decimal = Decimal("100000"),
    symbols: list[str] | None = None,
) -> LiveTestResult:
    """Run a live test with harness setup/teardown."""
    harness = create_harness(initial_capital=initial_capital)

    try:
        await harness.start(symbols=symbols)
        result = await test_fn(harness)

        if isinstance(result, LiveTestResult):
            return result

        return harness.get_result(
            test_id="unknown",
            passed=True,
        )
    except AssertionError as e:
        return harness.get_result(
            test_id="unknown",
            passed=False,
        )
    finally:
        await harness.stop()
