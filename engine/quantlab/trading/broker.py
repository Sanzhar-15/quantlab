"""
Broker Adapter System.

Abstract broker interface and paper trading implementation.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

import logging
import random
import threading
import time
import uuid
from abc import ABC
from abc import abstractmethod
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable

from .orders import Fill


logger = logging.getLogger(__name__)
from .orders import Order
from .orders import OrderSide
from .orders import OrderStatus
from .orders import OrderType


class BrokerStatus(Enum):
    """Broker connection status."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


@dataclass
class BrokerAccount:
    """Broker account information."""

    account_id: str
    name: str
    currency: str = "USD"

    # Balance
    cash_balance: Decimal = Decimal("0")
    buying_power: Decimal = Decimal("0")
    portfolio_value: Decimal = Decimal("0")

    # Margin (for margin accounts)
    margin_used: Decimal = Decimal("0")
    margin_available: Decimal = Decimal("0")

    # Status
    is_active: bool = True
    is_paper: bool = True

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "accountId": self.account_id,
            "name": self.name,
            "currency": self.currency,
            "cashBalance": float(self.cash_balance),
            "buyingPower": float(self.buying_power),
            "portfolioValue": float(self.portfolio_value),
            "marginUsed": float(self.margin_used),
            "marginAvailable": float(self.margin_available),
            "isActive": self.is_active,
            "isPaper": self.is_paper,
        }


@dataclass
class MarketQuote:
    """Market quote data."""

    symbol: str
    bid: Decimal
    ask: Decimal
    last: Decimal
    volume: int = 0
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def mid(self) -> Decimal:
        """Get mid price."""
        return (self.bid + self.ask) / 2

    @property
    def spread(self) -> Decimal:
        """Get bid-ask spread."""
        return self.ask - self.bid

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "bid": float(self.bid),
            "ask": float(self.ask),
            "last": float(self.last),
            "mid": float(self.mid),
            "spread": float(self.spread),
            "volume": self.volume,
            "timestamp": self.timestamp.isoformat(),
        }


class BrokerAdapter(ABC):
    """
    Abstract broker adapter interface.

    Provides a common interface for submitting orders and receiving fills.
    Implementations can connect to real brokers or simulate paper trading.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Get broker name."""
        pass

    @property
    @abstractmethod
    def status(self) -> BrokerStatus:
        """Get connection status."""
        pass

    @property
    @abstractmethod
    def is_paper(self) -> bool:
        """Check if this is a paper trading broker."""
        pass

    @abstractmethod
    def connect(self) -> bool:
        """
        Connect to the broker.

        Returns:
            True if connection successful
        """
        pass

    @abstractmethod
    def disconnect(self) -> None:
        """Disconnect from the broker."""
        pass

    @abstractmethod
    def get_accounts(self) -> list[BrokerAccount]:
        """
        Get available accounts.

        Returns:
            List of accounts
        """
        pass

    @abstractmethod
    def get_account(self, account_id: str) -> BrokerAccount | None:
        """
        Get account by ID.

        Args:
            account_id: Account ID

        Returns:
            Account or None if not found
        """
        pass

    @abstractmethod
    async def submit_order(self, order: Order) -> str | None:
        """
        Submit an order to the broker.

        Args:
            order: Order to submit

        Returns:
            Broker order ID if successful, None otherwise
        """
        pass

    @abstractmethod
    async def cancel_order(self, broker_order_id: str) -> bool:
        """
        Cancel an order.

        Args:
            broker_order_id: Broker's order ID

        Returns:
            True if cancellation submitted
        """
        pass

    @abstractmethod
    async def get_quote(self, symbol: str) -> MarketQuote | None:
        """
        Get current quote for a symbol.

        Args:
            symbol: Symbol to quote

        Returns:
            Quote or None if unavailable
        """
        pass

    @abstractmethod
    async def get_quotes(self, symbols: list[str]) -> dict[str, MarketQuote]:
        """
        Get quotes for multiple symbols.

        Args:
            symbols: List of symbols

        Returns:
            Map of symbol to quote
        """
        pass

    @abstractmethod
    async def get_positions(self) -> list[dict[str, Any]]:
        """
        Get current positions at broker.

        Returns:
            List of position dicts with 'symbol', 'quantity', 'avg_entry_price'
        """
        pass

    def on_fill(
        self,
        callback: Callable[[str, Fill], None],
    ) -> None:
        """
        Register fill callback.

        Args:
            callback: Callback(order_id, fill)
        """
        pass

    def on_order_update(
        self,
        callback: Callable[[str, OrderStatus], None],
    ) -> None:
        """
        Register order update callback.

        Args:
            callback: Callback(order_id, status)
        """
        pass


@dataclass
class PaperBrokerConfig:
    """Configuration for paper broker."""

    # Starting capital
    initial_capital: Decimal = Decimal("100000")

    # Execution settings
    fill_delay_ms: int = 100  # Simulated fill delay
    partial_fill_probability: float = 0.0  # Probability of partial fill
    reject_probability: float = 0.0  # Probability of rejection

    # Slippage simulation
    slippage_bps: float = 5.0  # Slippage in basis points (0.05%)

    # Commission
    commission_per_share: Decimal = Decimal("0.005")
    min_commission: Decimal = Decimal("1.0")


class PaperBroker(BrokerAdapter):
    """
    Paper trading broker implementation.

    Simulates order execution without real money.
    """

    def __init__(self, config: PaperBrokerConfig | None = None) -> None:
        """
        Initialize paper broker.

        Args:
            config: Broker configuration
        """
        self._config = config or PaperBrokerConfig()
        self._status = BrokerStatus.DISCONNECTED

        # Account
        self._account = BrokerAccount(
            account_id=f"paper-{uuid.uuid4().hex[:8]}",
            name="Paper Trading Account",
            cash_balance=self._config.initial_capital,
            buying_power=self._config.initial_capital,
            portfolio_value=self._config.initial_capital,
            is_paper=True,
        )

        # Order tracking
        self._pending_orders: dict[str, Order] = {}
        self._broker_order_ids: dict[str, str] = {}  # order_id -> broker_order_id

        # Simulated prices
        self._prices: dict[str, Decimal] = {}

        # Callbacks
        self._on_fill_callbacks: list[Callable[[str, Fill], None]] = []
        self._on_order_update_callbacks: list[Callable[[str, OrderStatus], None]] = []

        # Threading
        self._lock = threading.Lock()
        self._fill_thread: threading.Thread | None = None
        self._running = False

    @property
    def name(self) -> str:
        """Get broker name."""
        return "Paper Broker"

    @property
    def status(self) -> BrokerStatus:
        """Get connection status."""
        return self._status

    @property
    def is_paper(self) -> bool:
        """Check if this is a paper trading broker."""
        return True

    def connect(self) -> bool:
        """Connect to the broker."""
        self._status = BrokerStatus.CONNECTING

        # Start fill simulation thread
        self._running = True
        self._fill_thread = threading.Thread(
            target=self._fill_loop,
            daemon=True,
        )
        self._fill_thread.start()

        self._status = BrokerStatus.CONNECTED
        return True

    def disconnect(self) -> None:
        """Disconnect from the broker."""
        self._running = False
        if self._fill_thread:
            self._fill_thread.join(timeout=1.0)
        self._status = BrokerStatus.DISCONNECTED

    def get_accounts(self) -> list[BrokerAccount]:
        """Get available accounts."""
        return [self._account]

    def get_account(self, account_id: str) -> BrokerAccount | None:
        """Get account by ID."""
        if account_id == self._account.account_id:
            return self._account
        return None

    def set_price(self, symbol: str, price: Decimal) -> None:
        """
        Set simulated price for a symbol.

        Args:
            symbol: Symbol
            price: Price
        """
        with self._lock:
            self._prices[symbol] = price

    def set_prices(self, prices: dict[str, Decimal]) -> None:
        """
        Set simulated prices for multiple symbols.

        Args:
            prices: Map of symbol to price
        """
        with self._lock:
            self._prices.update(prices)

    async def submit_order(self, order: Order) -> str | None:
        """Submit an order to the broker."""
        # Check if we should reject
        if random.random() < self._config.reject_probability:
            return None

        # Generate broker order ID
        broker_order_id = f"paper-{uuid.uuid4().hex[:8]}"

        with self._lock:
            self._pending_orders[broker_order_id] = order
            self._broker_order_ids[order.order_id] = broker_order_id

        # Notify order accepted
        self._notify_order_update(order.order_id, OrderStatus.ACCEPTED)

        return broker_order_id

    async def cancel_order(self, broker_order_id: str) -> bool:
        """Cancel an order."""
        with self._lock:
            if broker_order_id in self._pending_orders:
                order = self._pending_orders.pop(broker_order_id)
                self._notify_order_update(order.order_id, OrderStatus.CANCELLED)
                return True
        return False

    async def get_quote(self, symbol: str) -> MarketQuote | None:
        """Get current quote for a symbol."""
        with self._lock:
            price = self._prices.get(symbol)
            if price is None:
                return None

            # Simulate spread
            spread = price * Decimal("0.001")  # 0.1% spread
            return MarketQuote(
                symbol=symbol,
                bid=price - spread / 2,
                ask=price + spread / 2,
                last=price,
            )

    async def get_quotes(self, symbols: list[str]) -> dict[str, MarketQuote]:
        """Get quotes for multiple symbols."""
        quotes = {}
        for symbol in symbols:
            quote = await self.get_quote(symbol)
            if quote:
                quotes[symbol] = quote
        return quotes

    async def get_positions(self) -> list[dict[str, Any]]:
        """Get current positions at broker (paper broker has no real positions)."""
        # Paper broker doesn't track real positions - return empty
        # Real broker implementations would query actual broker positions
        return []

    def on_fill(
        self,
        callback: Callable[[str, Fill], None],
    ) -> None:
        """Register fill callback."""
        self._on_fill_callbacks.append(callback)

    def on_order_update(
        self,
        callback: Callable[[str, OrderStatus], None],
    ) -> None:
        """Register order update callback."""
        self._on_order_update_callbacks.append(callback)

    def _fill_loop(self) -> None:
        """Background thread to simulate fills."""
        while self._running:
            time.sleep(self._config.fill_delay_ms / 1000.0)

            # Get orders to fill - snapshot under lock
            with self._lock:
                orders_to_fill = list(self._pending_orders.items())

            for broker_order_id, order in orders_to_fill:
                # Verify order still exists and hasn't been cancelled
                with self._lock:
                    if broker_order_id not in self._pending_orders:
                        # Order was cancelled or removed - skip
                        continue
                    # Get fresh reference in case order was modified
                    order = self._pending_orders[broker_order_id]

                self._try_fill_order(broker_order_id, order)

    def _try_fill_order(self, broker_order_id: str, order: Order) -> None:
        """Try to fill an order."""
        # Atomically check price and verify order still exists
        with self._lock:
            # Re-verify order exists (may have been cancelled)
            if broker_order_id not in self._pending_orders:
                return

            price = self._prices.get(order.symbol)
            if price is None:
                return

            # Check if order can be filled based on type
            fill_price = self._get_fill_price(order, price)
            if fill_price is None:
                return

            # Determine fill quantity
            fill_qty = order.remaining_quantity
            if random.random() < self._config.partial_fill_probability:
                fill_qty = fill_qty * Decimal(str(random.uniform(0.3, 0.7)))
                fill_qty = fill_qty.quantize(Decimal("1"))  # Round to whole shares
                if fill_qty <= 0:
                    fill_qty = Decimal("1")

            # Calculate commission
            commission = max(
                fill_qty * self._config.commission_per_share,
                self._config.min_commission,
            )

            # Create fill
            fill = Fill(
                fill_id=f"fill-{uuid.uuid4().hex[:8]}",
                order_id=order.order_id,
                quantity=fill_qty,
                price=fill_price,
                timestamp=datetime.now(timezone.utc),
                commission=commission,
            )

            # Update account
            self._update_account_for_fill(order, fill)

            # Remove from pending if fully filled
            if fill_qty >= order.remaining_quantity:
                self._pending_orders.pop(broker_order_id, None)

        # Notify outside lock to avoid deadlocks
        self._notify_fill(order.order_id, fill)

    def _get_fill_price(
        self,
        order: Order,
        market_price: Decimal,
    ) -> Decimal | None:
        """
        Get fill price for an order.

        Args:
            order: Order to fill
            market_price: Current market price

        Returns:
            Fill price or None if order cannot be filled
        """
        # Apply slippage
        slippage = market_price * Decimal(str(self._config.slippage_bps / 10000))
        if order.side == OrderSide.BUY:
            slipped_price = market_price + slippage
        else:
            slipped_price = market_price - slippage

        # Check order type
        if order.order_type == OrderType.MARKET:
            return slipped_price

        elif order.order_type == OrderType.LIMIT:
            if order.limit_price is None:
                return None
            if order.side == OrderSide.BUY:
                if market_price <= order.limit_price:
                    return min(order.limit_price, slipped_price)
            else:
                if market_price >= order.limit_price:
                    return max(order.limit_price, slipped_price)
            return None

        elif order.order_type == OrderType.STOP:
            if order.stop_price is None:
                return None
            if order.side == OrderSide.BUY:
                if market_price >= order.stop_price:
                    return slipped_price
            else:
                if market_price <= order.stop_price:
                    return slipped_price
            return None

        elif order.order_type == OrderType.STOP_LIMIT:
            if order.stop_price is None or order.limit_price is None:
                return None
            # Check stop trigger
            stop_triggered = False
            if order.side == OrderSide.BUY:
                stop_triggered = market_price >= order.stop_price
            else:
                stop_triggered = market_price <= order.stop_price

            if not stop_triggered:
                return None

            # Check limit
            if order.side == OrderSide.BUY:
                if market_price <= order.limit_price:
                    return min(order.limit_price, slipped_price)
            else:
                if market_price >= order.limit_price:
                    return max(order.limit_price, slipped_price)
            return None

        return None

    def _update_account_for_fill(self, order: Order, fill: Fill) -> None:
        """Update account for a fill."""
        # Calculate trade notional (price * quantity) - always positive
        trade_notional = fill.quantity * fill.price

        if order.side == OrderSide.BUY:
            # Buy: pay notional + commission
            self._account.cash_balance -= (trade_notional + fill.commission)
        else:
            # Sell: receive notional - commission
            self._account.cash_balance += (trade_notional - fill.commission)

        self._account.buying_power = self._account.cash_balance

    def _notify_fill(self, order_id: str, fill: Fill) -> None:
        """Notify fill listeners."""
        for callback in self._on_fill_callbacks:
            try:
                callback(order_id, fill)
            except Exception as e:
                logger.warning(
                    f"Fill callback failed for order {order_id}: {e}",
                    exc_info=True,
                )

    def _notify_order_update(
        self,
        order_id: str,
        status: OrderStatus,
    ) -> None:
        """Notify order update listeners."""
        for callback in self._on_order_update_callbacks:
            try:
                callback(order_id, status)
            except Exception as e:
                logger.warning(
                    f"Order update callback failed for order {order_id}: {e}",
                    exc_info=True,
                )


class BrokerManager:
    """
    Manages broker adapters.

    Provides a registry of available brokers and their connections.
    """

    def __init__(self) -> None:
        """Initialize broker manager."""
        self._brokers: dict[str, BrokerAdapter] = {}
        self._lock = threading.Lock()

    def register_broker(
        self,
        broker_id: str,
        broker: BrokerAdapter,
    ) -> None:
        """
        Register a broker adapter.

        Args:
            broker_id: Unique broker identifier
            broker: Broker adapter instance
        """
        with self._lock:
            self._brokers[broker_id] = broker

    def get_broker(self, broker_id: str) -> BrokerAdapter | None:
        """
        Get broker by ID.

        Args:
            broker_id: Broker ID

        Returns:
            Broker adapter or None
        """
        with self._lock:
            return self._brokers.get(broker_id)

    def get_all_brokers(self) -> dict[str, BrokerAdapter]:
        """Get all registered brokers."""
        with self._lock:
            return dict(self._brokers)

    def get_connected_brokers(self) -> list[BrokerAdapter]:
        """Get all connected brokers."""
        with self._lock:
            return [
                b for b in self._brokers.values()
                if b.status == BrokerStatus.CONNECTED
            ]

    def create_paper_broker(
        self,
        broker_id: str,
        config: PaperBrokerConfig | None = None,
    ) -> PaperBroker:
        """
        Create and register a paper broker.

        Args:
            broker_id: Broker ID
            config: Broker configuration

        Returns:
            Created paper broker
        """
        broker = PaperBroker(config)
        self.register_broker(broker_id, broker)
        return broker

    def disconnect_all(self) -> None:
        """Disconnect all brokers."""
        with self._lock:
            for broker_id, broker in self._brokers.items():
                try:
                    broker.disconnect()
                except Exception as e:
                    logger.warning(
                        f"Failed to disconnect broker {broker_id}: {e}",
                        exc_info=True,
                    )


@dataclass
class ReconnectionConfig:
    """Configuration for broker auto-reconnection."""

    enabled: bool = True
    initial_delay_seconds: float = 1.0
    max_delay_seconds: float = 60.0
    backoff_multiplier: float = 2.0
    jitter: float = 0.1  # Random jitter factor (0-1)
    max_attempts: int = 10  # 0 = unlimited
    reset_delay_on_success: bool = True


@dataclass
class ReconnectionEvent:
    """Event emitted during reconnection attempts."""

    broker_id: str
    attempt: int
    timestamp: float
    success: bool
    error: str | None = None
    next_delay: float | None = None


class BrokerReconnector:
    """
    Auto-reconnection manager for broker connections.

    Implements exponential backoff with jitter for connection retries.

    Features:
    - Exponential backoff: delay doubles with each failure
    - Jitter: random factor prevents thundering herd
    - Maximum delay cap: prevents excessive wait times
    - Configurable retry limits
    - Callback support for monitoring

    Usage:
        reconnector = BrokerReconnector(broker, config)
        reconnector.on_event(handle_reconnection_event)
        reconnector.start()  # Begins monitoring in background
        ...
        reconnector.stop()
    """

    def __init__(
        self,
        broker: BrokerAdapter,
        broker_id: str,
        config: ReconnectionConfig | None = None,
        on_connected: Callable[[], None] | None = None,
        on_disconnected: Callable[[], None] | None = None,
    ) -> None:
        """
        Initialize reconnector.

        Args:
            broker: Broker adapter to monitor
            broker_id: Identifier for the broker
            config: Reconnection configuration
            on_connected: Callback when connection established
            on_disconnected: Callback when disconnection detected
        """
        self._broker = broker
        self._broker_id = broker_id
        self._config = config or ReconnectionConfig()
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected

        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._monitor_thread: threading.Thread | None = None

        # State
        self._current_delay = self._config.initial_delay_seconds
        self._attempt_count = 0
        self._is_reconnecting = False
        self._last_status = BrokerStatus.DISCONNECTED
        self._events: list[ReconnectionEvent] = []
        self._event_callbacks: list[Callable[[ReconnectionEvent], None]] = []

    @property
    def is_running(self) -> bool:
        """Check if reconnector is running."""
        return self._monitor_thread is not None and self._monitor_thread.is_alive()

    @property
    def is_reconnecting(self) -> bool:
        """Check if currently attempting reconnection."""
        return self._is_reconnecting

    @property
    def attempt_count(self) -> int:
        """Get current reconnection attempt count."""
        return self._attempt_count

    def on_event(self, callback: Callable[[ReconnectionEvent], None]) -> None:
        """Register callback for reconnection events."""
        self._event_callbacks.append(callback)

    def start(self) -> None:
        """Start background monitoring and reconnection."""
        if not self._config.enabled:
            logger.info(f"Auto-reconnection disabled for broker {self._broker_id}")
            return

        if self.is_running:
            return

        self._stop_event.clear()
        self._monitor_thread = threading.Thread(
            target=self._monitoring_loop,
            daemon=True,
            name=f"BrokerReconnector-{self._broker_id}",
        )
        self._monitor_thread.start()
        logger.info(f"Auto-reconnection started for broker {self._broker_id}")

    def stop(self) -> None:
        """Stop background monitoring."""
        self._stop_event.set()

        if self._monitor_thread:
            self._monitor_thread.join(timeout=5.0)
            self._monitor_thread = None

        logger.info(f"Auto-reconnection stopped for broker {self._broker_id}")

    def _monitoring_loop(self) -> None:
        """Background monitoring loop."""
        while not self._stop_event.is_set():
            try:
                current_status = self._broker.status

                # Detect disconnection
                if (
                    current_status in (BrokerStatus.DISCONNECTED, BrokerStatus.ERROR)
                    and self._last_status == BrokerStatus.CONNECTED
                ):
                    logger.warning(f"Broker {self._broker_id} disconnected")
                    if self._on_disconnected:
                        try:
                            self._on_disconnected()
                        except Exception as e:
                            logger.error(f"Disconnection callback error: {e}")

                # Attempt reconnection if disconnected
                if current_status in (BrokerStatus.DISCONNECTED, BrokerStatus.ERROR):
                    self._attempt_reconnection()

                # Detect successful connection
                elif (
                    current_status == BrokerStatus.CONNECTED
                    and self._last_status != BrokerStatus.CONNECTED
                ):
                    self._handle_connection_restored()

                self._last_status = current_status

            except Exception as e:
                logger.error(f"Reconnection monitor error: {e}")

            # Wait before next check
            self._stop_event.wait(timeout=1.0)

    def _attempt_reconnection(self) -> None:
        """Attempt to reconnect to the broker."""
        with self._lock:
            if self._is_reconnecting:
                return

            # Check max attempts
            if (
                self._config.max_attempts > 0
                and self._attempt_count >= self._config.max_attempts
            ):
                logger.error(
                    f"Broker {self._broker_id}: max reconnection attempts "
                    f"({self._config.max_attempts}) exceeded"
                )
                return

            self._is_reconnecting = True
            self._attempt_count += 1

        try:
            logger.info(
                f"Broker {self._broker_id}: reconnection attempt "
                f"{self._attempt_count} (delay: {self._current_delay:.1f}s)"
            )

            # Attempt connection
            success = self._broker.connect()

            # Record event
            event = ReconnectionEvent(
                broker_id=self._broker_id,
                attempt=self._attempt_count,
                timestamp=time.time(),
                success=success,
                error=None if success else "Connection failed",
                next_delay=None if success else self._calculate_next_delay(),
            )
            self._record_event(event)

            if success:
                logger.info(f"Broker {self._broker_id}: reconnection successful")
                if self._config.reset_delay_on_success:
                    self._current_delay = self._config.initial_delay_seconds
                    self._attempt_count = 0
            else:
                # Wait with backoff before next attempt
                self._wait_with_backoff()

        except Exception as e:
            logger.error(f"Broker {self._broker_id}: reconnection error: {e}")
            event = ReconnectionEvent(
                broker_id=self._broker_id,
                attempt=self._attempt_count,
                timestamp=time.time(),
                success=False,
                error=str(e),
                next_delay=self._calculate_next_delay(),
            )
            self._record_event(event)
            self._wait_with_backoff()

        finally:
            with self._lock:
                self._is_reconnecting = False

    def _calculate_next_delay(self) -> float:
        """Calculate delay for next reconnection attempt."""
        # Exponential backoff
        next_delay = self._current_delay * self._config.backoff_multiplier

        # Add jitter (random factor between -jitter and +jitter)
        jitter = (random.random() * 2 - 1) * self._config.jitter * next_delay
        next_delay += jitter

        # Cap at maximum
        return min(next_delay, self._config.max_delay_seconds)

    def _wait_with_backoff(self) -> None:
        """Wait before next reconnection attempt using backoff."""
        wait_time = self._current_delay
        self._current_delay = self._calculate_next_delay()

        logger.debug(
            f"Broker {self._broker_id}: waiting {wait_time:.1f}s before next attempt"
        )

        # Wait in small increments to allow early termination
        end_time = time.time() + wait_time
        while time.time() < end_time and not self._stop_event.is_set():
            time.sleep(0.1)

    def _handle_connection_restored(self) -> None:
        """Handle successful connection restoration."""
        logger.info(f"Broker {self._broker_id}: connection restored")

        if self._on_connected:
            try:
                self._on_connected()
            except Exception as e:
                logger.error(f"Connection callback error: {e}")

        # Reset state
        with self._lock:
            if self._config.reset_delay_on_success:
                self._current_delay = self._config.initial_delay_seconds
                self._attempt_count = 0

    def _record_event(self, event: ReconnectionEvent) -> None:
        """Record and broadcast reconnection event."""
        self._events.append(event)

        # Limit history
        if len(self._events) > 100:
            self._events = self._events[-100:]

        # Notify callbacks
        for callback in self._event_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"Reconnection event callback error: {e}")

    def get_events(self, limit: int | None = None) -> list[ReconnectionEvent]:
        """Get reconnection event history."""
        if limit:
            return self._events[-limit:]
        return list(self._events)

    def reset(self) -> None:
        """Reset reconnection state."""
        with self._lock:
            self._current_delay = self._config.initial_delay_seconds
            self._attempt_count = 0
            self._events.clear()

        logger.info(f"Broker {self._broker_id}: reconnection state reset")

    def status(self) -> dict[str, Any]:
        """Get reconnector status."""
        return {
            "broker_id": self._broker_id,
            "enabled": self._config.enabled,
            "is_running": self.is_running,
            "is_reconnecting": self._is_reconnecting,
            "attempt_count": self._attempt_count,
            "current_delay": self._current_delay,
            "max_attempts": self._config.max_attempts,
            "broker_status": self._broker.status.value,
            "recent_events": [
                {
                    "attempt": e.attempt,
                    "success": e.success,
                    "error": e.error,
                    "timestamp": e.timestamp,
                }
                for e in self._events[-5:]
            ],
        }


class QueuedOrderPriority(Enum):
    """Priority levels for queued orders."""

    EMERGENCY = 0  # Emergency orders (flatten, stop-loss)
    HIGH = 1  # High priority orders
    NORMAL = 2  # Normal priority orders
    LOW = 3  # Low priority orders


@dataclass
class QueuedOrder:
    """An order queued during broker disconnection."""

    order: Order
    priority: QueuedOrderPriority
    queued_at: float
    retry_count: int = 0
    max_retries: int = 3
    timeout_seconds: float = 300.0  # 5 minutes default
    error_message: str | None = None

    @property
    def is_expired(self) -> bool:
        """Check if queued order has expired."""
        return (time.time() - self.queued_at) > self.timeout_seconds

    @property
    def can_retry(self) -> bool:
        """Check if order can be retried."""
        return self.retry_count < self.max_retries


@dataclass
class QueueBufferConfig:
    """Configuration for order queue buffer."""

    enabled: bool = True
    max_queue_size: int = 100
    default_timeout_seconds: float = 300.0  # 5 minutes
    max_retries_per_order: int = 3
    retry_delay_seconds: float = 1.0
    process_on_reconnect: bool = True
    preserve_order_priority: bool = True
    log_queued_orders: bool = True


@dataclass
class QueueEvent:
    """Event emitted by the order queue buffer."""

    event_type: str  # "queued", "submitted", "expired", "failed", "cleared"
    order_id: str
    symbol: str
    timestamp: float
    details: dict[str, Any] = field(default_factory=dict)


class OrderQueueBuffer:
    """
    Buffers orders during broker disconnection.

    When the broker is disconnected, orders are queued locally and
    automatically submitted when connection is restored.

    Features:
    - Priority-based queue processing
    - Configurable order timeout
    - Automatic retry on submission failure
    - Event callbacks for monitoring
    - Thread-safe operations

    Usage:
        buffer = OrderQueueBuffer(broker, config)
        buffer.on_event(handle_queue_event)

        # When broker disconnects
        buffer.enable_buffering()

        # Orders are automatically queued
        buffer.queue_order(order, QueuedOrderPriority.NORMAL)

        # When broker reconnects
        buffer.process_queue()  # Or call enable_live() for auto-process

    Spec Reference: Technical Spec Phase 4 - Order Queue Buffering
    """

    def __init__(
        self,
        broker: BrokerAdapter,
        config: QueueBufferConfig | None = None,
    ) -> None:
        """
        Initialize order queue buffer.

        Args:
            broker: Broker adapter for order submission
            config: Buffer configuration
        """
        self._broker = broker
        self._config = config or QueueBufferConfig()

        self._lock = threading.Lock()
        self._queue: list[QueuedOrder] = []
        self._is_buffering = False
        self._processing = False

        # Event handling
        self._event_callbacks: list[Callable[[QueueEvent], None]] = []
        self._events: list[QueueEvent] = []

        # Statistics
        self._stats = {
            "total_queued": 0,
            "total_submitted": 0,
            "total_expired": 0,
            "total_failed": 0,
        }

    @property
    def is_buffering(self) -> bool:
        """Check if buffering is currently enabled."""
        return self._is_buffering

    @property
    def queue_size(self) -> int:
        """Get current queue size."""
        with self._lock:
            return len(self._queue)

    @property
    def is_processing(self) -> bool:
        """Check if queue is currently being processed."""
        return self._processing

    def enable_buffering(self) -> None:
        """
        Enable order buffering mode.

        Call this when broker disconnects to start queuing orders locally.
        """
        with self._lock:
            if self._is_buffering:
                return
            self._is_buffering = True

        logger.info("Order queue buffering enabled")

    def disable_buffering(self) -> None:
        """
        Disable buffering mode without processing queue.

        Orders remain in queue but new orders go directly to broker.
        """
        with self._lock:
            self._is_buffering = False

        logger.info("Order queue buffering disabled")

    def enable_live(self, process_queue: bool = True) -> None:
        """
        Switch to live mode, optionally processing queued orders.

        Call this when broker reconnects.

        Args:
            process_queue: Whether to immediately process queued orders
        """
        with self._lock:
            self._is_buffering = False

        if process_queue and self._config.process_on_reconnect:
            self.process_queue()

        logger.info("Switched to live mode (process_queue=%s)", process_queue)

    def on_event(self, callback: Callable[[QueueEvent], None]) -> None:
        """Register callback for queue events."""
        self._event_callbacks.append(callback)

    def queue_order(
        self,
        order: Order,
        priority: QueuedOrderPriority = QueuedOrderPriority.NORMAL,
        timeout_seconds: float | None = None,
    ) -> bool:
        """
        Queue an order for later submission.

        Args:
            order: Order to queue
            priority: Order priority
            timeout_seconds: Custom timeout (uses config default if None)

        Returns:
            True if order was queued successfully
        """
        if not self._config.enabled:
            logger.warning("Order queue buffer is disabled, order not queued")
            return False

        with self._lock:
            # Check queue size limit
            if len(self._queue) >= self._config.max_queue_size:
                logger.error(
                    f"Order queue full ({self._config.max_queue_size}), "
                    f"cannot queue order {order.order_id}"
                )
                return False

            # Create queued order
            queued = QueuedOrder(
                order=order,
                priority=priority,
                queued_at=time.time(),
                timeout_seconds=timeout_seconds or self._config.default_timeout_seconds,
                max_retries=self._config.max_retries_per_order,
            )

            # Insert maintaining priority order
            if self._config.preserve_order_priority:
                # Find insertion point based on priority
                insert_idx = len(self._queue)
                for i, existing in enumerate(self._queue):
                    if queued.priority.value < existing.priority.value:
                        insert_idx = i
                        break
                self._queue.insert(insert_idx, queued)
            else:
                self._queue.append(queued)

            self._stats["total_queued"] += 1

        # Record and emit event
        event = QueueEvent(
            event_type="queued",
            order_id=order.order_id,
            symbol=order.symbol,
            timestamp=time.time(),
            details={
                "priority": priority.name,
                "timeout_seconds": queued.timeout_seconds,
                "queue_position": insert_idx if self._config.preserve_order_priority else len(self._queue) - 1,
                "queue_size": self.queue_size,
            },
        )
        self._record_event(event)

        if self._config.log_queued_orders:
            logger.info(
                f"Order queued: {order.order_id} ({order.symbol} {order.side.value} "
                f"{order.quantity}) priority={priority.name}"
            )

        return True

    async def process_queue(self) -> dict[str, Any]:
        """
        Process all queued orders.

        Submits orders to broker in priority order, handling failures
        and expired orders.

        Returns:
            Processing results summary
        """
        if self._processing:
            logger.warning("Queue already being processed")
            return {"error": "already_processing"}

        self._processing = True
        results = {
            "submitted": 0,
            "expired": 0,
            "failed": 0,
            "remaining": 0,
            "orders": [],
        }

        try:
            while True:
                # Get next order to process
                with self._lock:
                    if not self._queue:
                        break

                    # Remove expired orders
                    self._queue = [q for q in self._queue if not q.is_expired]

                    if not self._queue:
                        break

                    queued = self._queue.pop(0)

                # Check if expired during processing
                if queued.is_expired:
                    results["expired"] += 1
                    self._stats["total_expired"] += 1
                    self._record_event(QueueEvent(
                        event_type="expired",
                        order_id=queued.order.order_id,
                        symbol=queued.order.symbol,
                        timestamp=time.time(),
                        details={"queued_duration": time.time() - queued.queued_at},
                    ))
                    results["orders"].append({
                        "order_id": queued.order.order_id,
                        "status": "expired",
                    })
                    continue

                # Submit to broker
                try:
                    broker_order_id = await self._broker.submit_order(queued.order)

                    if broker_order_id:
                        results["submitted"] += 1
                        self._stats["total_submitted"] += 1
                        self._record_event(QueueEvent(
                            event_type="submitted",
                            order_id=queued.order.order_id,
                            symbol=queued.order.symbol,
                            timestamp=time.time(),
                            details={"broker_order_id": broker_order_id},
                        ))
                        results["orders"].append({
                            "order_id": queued.order.order_id,
                            "status": "submitted",
                            "broker_order_id": broker_order_id,
                        })
                    else:
                        # Submission returned None - retry or fail
                        queued.retry_count += 1
                        if queued.can_retry:
                            with self._lock:
                                self._queue.insert(0, queued)
                            await self._async_sleep(self._config.retry_delay_seconds)
                        else:
                            results["failed"] += 1
                            self._stats["total_failed"] += 1
                            self._record_event(QueueEvent(
                                event_type="failed",
                                order_id=queued.order.order_id,
                                symbol=queued.order.symbol,
                                timestamp=time.time(),
                                details={
                                    "reason": "max_retries_exceeded",
                                    "retry_count": queued.retry_count,
                                },
                            ))
                            results["orders"].append({
                                "order_id": queued.order.order_id,
                                "status": "failed",
                                "reason": "max_retries",
                            })

                except Exception as e:
                    logger.error(f"Error submitting queued order {queued.order.order_id}: {e}")
                    queued.retry_count += 1
                    queued.error_message = str(e)

                    if queued.can_retry:
                        with self._lock:
                            self._queue.insert(0, queued)
                        await self._async_sleep(self._config.retry_delay_seconds)
                    else:
                        results["failed"] += 1
                        self._stats["total_failed"] += 1
                        self._record_event(QueueEvent(
                            event_type="failed",
                            order_id=queued.order.order_id,
                            symbol=queued.order.symbol,
                            timestamp=time.time(),
                            details={"reason": str(e), "retry_count": queued.retry_count},
                        ))
                        results["orders"].append({
                            "order_id": queued.order.order_id,
                            "status": "failed",
                            "reason": str(e),
                        })

            results["remaining"] = self.queue_size

        finally:
            self._processing = False

        logger.info(
            f"Queue processing complete: submitted={results['submitted']}, "
            f"expired={results['expired']}, failed={results['failed']}, "
            f"remaining={results['remaining']}"
        )

        return results

    async def _async_sleep(self, seconds: float) -> None:
        """Async-compatible sleep."""
        import asyncio
        await asyncio.sleep(seconds)

    def clear_queue(self) -> int:
        """
        Clear all queued orders.

        Returns:
            Number of orders cleared
        """
        with self._lock:
            count = len(self._queue)
            cleared_orders = list(self._queue)
            self._queue.clear()

        for queued in cleared_orders:
            self._record_event(QueueEvent(
                event_type="cleared",
                order_id=queued.order.order_id,
                symbol=queued.order.symbol,
                timestamp=time.time(),
                details={},
            ))

        logger.info(f"Cleared {count} orders from queue")
        return count

    def remove_order(self, order_id: str) -> bool:
        """
        Remove a specific order from the queue.

        Args:
            order_id: Order ID to remove

        Returns:
            True if order was found and removed
        """
        with self._lock:
            for i, queued in enumerate(self._queue):
                if queued.order.order_id == order_id:
                    self._queue.pop(i)
                    self._record_event(QueueEvent(
                        event_type="cleared",
                        order_id=order_id,
                        symbol=queued.order.symbol,
                        timestamp=time.time(),
                        details={"removed_manually": True},
                    ))
                    return True
        return False

    def get_queued_orders(self) -> list[dict[str, Any]]:
        """Get list of queued orders with details."""
        with self._lock:
            return [
                {
                    "order_id": q.order.order_id,
                    "symbol": q.order.symbol,
                    "side": q.order.side.value,
                    "quantity": float(q.order.quantity),
                    "order_type": q.order.order_type.value,
                    "priority": q.priority.name,
                    "queued_at": q.queued_at,
                    "is_expired": q.is_expired,
                    "retry_count": q.retry_count,
                    "time_remaining": max(0, q.timeout_seconds - (time.time() - q.queued_at)),
                }
                for q in self._queue
            ]

    def expire_old_orders(self) -> int:
        """
        Remove expired orders from queue.

        Returns:
            Number of orders expired
        """
        expired_count = 0
        with self._lock:
            new_queue = []
            for queued in self._queue:
                if queued.is_expired:
                    expired_count += 1
                    self._stats["total_expired"] += 1
                    self._record_event(QueueEvent(
                        event_type="expired",
                        order_id=queued.order.order_id,
                        symbol=queued.order.symbol,
                        timestamp=time.time(),
                        details={"queued_duration": time.time() - queued.queued_at},
                    ))
                else:
                    new_queue.append(queued)
            self._queue = new_queue

        if expired_count:
            logger.info(f"Expired {expired_count} orders from queue")

        return expired_count

    def _record_event(self, event: QueueEvent) -> None:
        """Record and broadcast queue event."""
        self._events.append(event)

        # Limit history
        if len(self._events) > 500:
            self._events = self._events[-500:]

        # Notify callbacks
        for callback in self._event_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"Queue event callback error: {e}")

    def get_events(self, limit: int | None = None) -> list[QueueEvent]:
        """Get queue event history."""
        if limit:
            return self._events[-limit:]
        return list(self._events)

    def get_statistics(self) -> dict[str, Any]:
        """Get queue statistics."""
        return {
            **self._stats,
            "current_queue_size": self.queue_size,
            "is_buffering": self._is_buffering,
            "is_processing": self._processing,
            "config": {
                "enabled": self._config.enabled,
                "max_queue_size": self._config.max_queue_size,
                "default_timeout": self._config.default_timeout_seconds,
                "max_retries": self._config.max_retries_per_order,
            },
        }

    def status(self) -> dict[str, Any]:
        """Get buffer status."""
        with self._lock:
            queue_summary = []
            for q in self._queue[:10]:  # First 10 orders
                queue_summary.append({
                    "order_id": q.order.order_id,
                    "symbol": q.order.symbol,
                    "priority": q.priority.name,
                    "time_remaining": max(0, q.timeout_seconds - (time.time() - q.queued_at)),
                })

        return {
            "is_buffering": self._is_buffering,
            "is_processing": self._processing,
            "queue_size": self.queue_size,
            "statistics": self._stats,
            "queue_preview": queue_summary,
            "broker_status": self._broker.status.value,
        }
