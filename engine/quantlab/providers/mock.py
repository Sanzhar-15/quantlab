"""
Mock Data Provider.

Provides simulated market data for testing and development.

Spec Reference: Technical Spec §10.3
"""

import asyncio
import logging
import random
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from decimal import Decimal
from typing import Any

from .base import Bar
from .base import BarCallback
from .base import ConnectionResult
from .base import ConnectionStatus
from .base import DataProvider
from .base import DataType
from .base import Quote
from .base import QuoteCallback
from .base import Subscription
from .base import TradeCallback
from .base import TradeEvent


logger = logging.getLogger(__name__)


@dataclass
class MockSymbolConfig:
    """Configuration for a mock symbol."""

    symbol: str
    base_price: Decimal
    volatility: Decimal = Decimal("0.001")  # 0.1%
    spread: Decimal = Decimal("0.01")
    avg_volume: int = 10000


class MockDataProvider(DataProvider):
    """
    Mock data provider for testing.

    Generates realistic-looking market data with configurable behavior.
    """

    def __init__(
        self,
        symbols: list[MockSymbolConfig] | None = None,
        latency_ms: float = 10.0,
        update_interval_ms: float = 100.0,
    ) -> None:
        super().__init__("mock")
        self._symbol_configs: dict[str, MockSymbolConfig] = {}
        self._current_prices: dict[str, Decimal] = {}
        self._latency = latency_ms
        self._update_interval = update_interval_ms / 1000.0
        self._running = False
        self._update_task: asyncio.Task | None = None

        # Initialize default symbols if none provided
        if symbols:
            for config in symbols:
                self._symbol_configs[config.symbol] = config
                self._current_prices[config.symbol] = config.base_price
        else:
            self._add_default_symbols()

    def _add_default_symbols(self) -> None:
        """Add default test symbols."""
        defaults = [
            MockSymbolConfig("AAPL", Decimal("175.00")),
            MockSymbolConfig("MSFT", Decimal("380.00")),
            MockSymbolConfig("GOOGL", Decimal("140.00")),
            MockSymbolConfig("SPY", Decimal("450.00"), volatility=Decimal("0.0005")),
            MockSymbolConfig("QQQ", Decimal("380.00"), volatility=Decimal("0.0006")),
        ]
        for config in defaults:
            self._symbol_configs[config.symbol] = config
            self._current_prices[config.symbol] = config.base_price

    def add_symbol(self, config: MockSymbolConfig) -> None:
        """Add a symbol configuration."""
        self._symbol_configs[config.symbol] = config
        self._current_prices[config.symbol] = config.base_price

    async def connect(self) -> ConnectionResult:
        """Simulate connection."""
        self._set_status(ConnectionStatus.CONNECTING)
        await asyncio.sleep(self._latency / 1000.0)
        self._set_status(ConnectionStatus.CONNECTED)
        self._latency_ms = self._latency
        self._running = True
        self._update_task = asyncio.create_task(self._update_loop())

        return ConnectionResult(
            success=True,
            status=ConnectionStatus.CONNECTED,
            message="Connected to mock provider",
            latency_ms=self._latency,
            server_time=datetime.now(timezone.utc),
        )

    async def disconnect(self) -> None:
        """Disconnect from mock provider."""
        self._running = False
        if self._update_task:
            self._update_task.cancel()
            try:
                await self._update_task
            except asyncio.CancelledError:
                pass
        self._set_status(ConnectionStatus.DISCONNECTED)

    async def subscribe(
        self,
        symbol: str,
        data_type: DataType,
        callback: QuoteCallback | BarCallback | TradeCallback,
        timeframe: str = "1m",
    ) -> bool:
        """Subscribe to mock data."""
        if symbol not in self._symbol_configs:
            # Auto-create config for unknown symbols
            self._symbol_configs[symbol] = MockSymbolConfig(
                symbol=symbol,
                base_price=Decimal("100.00"),
            )
            self._current_prices[symbol] = Decimal("100.00")

        subscription = Subscription(
            symbol=symbol,
            data_type=data_type,
            callback=callback,
            timeframe=timeframe,
        )
        self._add_subscription(subscription)
        logger.debug(f"Mock subscribed to {symbol} {data_type.value}")
        return True

    async def unsubscribe(self, symbol: str, data_type: DataType) -> bool:
        """Unsubscribe from mock data."""
        self._remove_subscription(symbol, data_type)
        logger.debug(f"Mock unsubscribed from {symbol} {data_type.value}")
        return True

    async def get_historical_bars(
        self,
        symbol: str,
        timeframe: str,
        start: datetime,
        end: datetime,
    ) -> list[Bar]:
        """Generate mock historical bars."""
        if symbol not in self._symbol_configs:
            return []

        config = self._symbol_configs[symbol]
        bars = []

        # Determine bar interval
        interval = self._timeframe_to_timedelta(timeframe)
        current = start

        price = config.base_price

        while current < end:
            # Generate OHLCV
            change = price * config.volatility * Decimal(str(random.uniform(-1, 1)))
            open_price = price
            close_price = price + change

            high_extra = abs(change) * Decimal(str(random.uniform(0, 0.5)))
            low_extra = abs(change) * Decimal(str(random.uniform(0, 0.5)))

            high_price = max(open_price, close_price) + high_extra
            low_price = min(open_price, close_price) - low_extra

            volume = int(config.avg_volume * random.uniform(0.5, 1.5))

            bars.append(
                Bar(
                    symbol=symbol,
                    timestamp=current,
                    open=open_price.quantize(Decimal("0.01")),
                    high=high_price.quantize(Decimal("0.01")),
                    low=low_price.quantize(Decimal("0.01")),
                    close=close_price.quantize(Decimal("0.01")),
                    volume=volume,
                    timeframe=timeframe,
                    source="mock",
                )
            )

            price = close_price
            current += interval

        return bars

    async def get_latest_quote(self, symbol: str) -> Quote | None:
        """Get latest mock quote."""
        if symbol not in self._symbol_configs:
            return None

        config = self._symbol_configs[symbol]
        price = self._current_prices[symbol]
        half_spread = config.spread / 2

        return Quote(
            symbol=symbol,
            bid=(price - half_spread).quantize(Decimal("0.01")),
            ask=(price + half_spread).quantize(Decimal("0.01")),
            bid_size=random.randint(100, 1000),
            ask_size=random.randint(100, 1000),
            timestamp=datetime.now(timezone.utc),
            source="mock",
        )

    async def _update_loop(self) -> None:
        """Background loop to generate updates."""
        while self._running:
            try:
                await asyncio.sleep(self._update_interval)

                # Update prices and dispatch to subscribers
                for symbol, config in self._symbol_configs.items():
                    if symbol not in self._subscriptions:
                        continue

                    # Update price
                    change = (
                        self._current_prices[symbol]
                        * config.volatility
                        * Decimal(str(random.uniform(-1, 1)))
                    )
                    self._current_prices[symbol] += change

                    # Generate and dispatch quote
                    quote = await self.get_latest_quote(symbol)
                    if quote:
                        self._dispatch_quote(quote)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Mock update loop error: {e}")

    def _timeframe_to_timedelta(self, timeframe: str) -> timedelta:
        """Convert timeframe string to timedelta."""
        if timeframe.endswith("m"):
            return timedelta(minutes=int(timeframe[:-1]))
        elif timeframe.endswith("h"):
            return timedelta(hours=int(timeframe[:-1]))
        elif timeframe.endswith("d"):
            return timedelta(days=int(timeframe[:-1]))
        elif timeframe.endswith("w"):
            return timedelta(weeks=int(timeframe[:-1]))
        else:
            return timedelta(minutes=1)

    def set_price(self, symbol: str, price: Decimal) -> None:
        """Manually set price for testing."""
        self._current_prices[symbol] = price

    def inject_quote(self, quote: Quote) -> None:
        """Inject a quote for testing."""
        self._dispatch_quote(quote)

    def inject_bar(self, bar: Bar) -> None:
        """Inject a bar for testing."""
        self._dispatch_bar(bar)

    def inject_trade(self, trade: TradeEvent) -> None:
        """Inject a trade for testing."""
        self._dispatch_trade(trade)

    # =========================================================================
    # Enhanced Mock Broker Methods (FIX-T003)
    # =========================================================================

    def simulate_disconnect(self, duration_seconds: float = 1.0) -> None:
        """
        Simulate a broker disconnect for testing reconnection (FIX-T003).

        Args:
            duration_seconds: How long to stay disconnected
        """
        import threading

        self._set_status(ConnectionStatus.DISCONNECTED)
        logger.info(f"Mock broker simulating disconnect for {duration_seconds}s")

        def reconnect():
            import time
            time.sleep(duration_seconds)
            self._set_status(ConnectionStatus.CONNECTED)
            logger.info("Mock broker reconnected")

        thread = threading.Thread(target=reconnect, daemon=True)
        thread.start()

    def simulate_latency_spike(self, latency_ms: float, duration_seconds: float = 5.0) -> None:
        """
        Simulate a latency spike for testing (FIX-T003).

        Args:
            latency_ms: Increased latency during spike
            duration_seconds: Duration of spike
        """
        import threading

        original_latency = self._latency
        self._latency = latency_ms
        logger.info(f"Mock broker simulating latency spike: {latency_ms}ms")

        def restore():
            import time
            time.sleep(duration_seconds)
            self._latency = original_latency
            logger.info(f"Mock broker latency restored to {original_latency}ms")

        thread = threading.Thread(target=restore, daemon=True)
        thread.start()

    def set_fill_probability(self, probability: float) -> None:
        """
        Set probability of order fills for testing partial fills (FIX-T003).

        Args:
            probability: Probability of fill (0.0 to 1.0)
        """
        self._fill_probability = max(0.0, min(1.0, probability))

    def set_reject_next_order(self, reason: str = "Insufficient funds") -> None:
        """
        Configure next order to be rejected (FIX-T003).

        Args:
            reason: Rejection reason message
        """
        self._reject_next_order = reason

    async def simulate_fill(
        self,
        symbol: str,
        side: str,
        quantity: int,
        price: Decimal | None = None,
    ) -> dict[str, Any]:
        """
        Simulate an order fill for testing (FIX-T003).

        Args:
            symbol: Symbol for fill
            side: "buy" or "sell"
            quantity: Fill quantity
            price: Fill price (uses current price if None)

        Returns:
            Fill data dict
        """
        if price is None:
            price = self._current_prices.get(symbol, Decimal("100.00"))

        fill = {
            "order_id": f"mock-{symbol}-{datetime.now(timezone.utc).timestamp()}",
            "symbol": symbol,
            "side": side,
            "quantity": quantity,
            "filled_quantity": quantity,
            "price": float(price),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": "filled",
        }

        logger.debug(f"Mock fill generated: {fill}")
        return fill

    def get_order_book(self, symbol: str, depth: int = 5) -> dict[str, Any]:
        """
        Get mock order book for testing (FIX-T003).

        Args:
            symbol: Symbol to get order book for
            depth: Number of levels per side

        Returns:
            Order book with bids and asks
        """
        if symbol not in self._symbol_configs:
            return {"bids": [], "asks": [], "symbol": symbol}

        config = self._symbol_configs[symbol]
        price = self._current_prices[symbol]
        spread = config.spread

        bids = []
        asks = []

        for i in range(depth):
            offset = spread * Decimal(str(i + 1)) / 2
            bid_price = price - offset
            ask_price = price + offset

            bids.append({
                "price": float(bid_price.quantize(Decimal("0.01"))),
                "size": random.randint(100, 1000),
            })
            asks.append({
                "price": float(ask_price.quantize(Decimal("0.01"))),
                "size": random.randint(100, 1000),
            })

        return {
            "symbol": symbol,
            "bids": bids,
            "asks": asks,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    def reset(self) -> None:
        """
        Reset mock provider to initial state (FIX-T003).

        Useful for test isolation.
        """
        # Reset prices to base values
        for symbol, config in self._symbol_configs.items():
            self._current_prices[symbol] = config.base_price

        # Clear any pending test configurations
        self._fill_probability = 1.0
        self._reject_next_order = None

        # Clear subscriptions
        self._subscriptions.clear()

        logger.info("Mock provider reset to initial state")

    # Initialize test configuration attributes
    _fill_probability: float = 1.0
    _reject_next_order: str | None = None
