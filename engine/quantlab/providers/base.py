"""
Data Provider Base Interface.

Defines the abstract interface for data providers (brokers, market data feeds).

Spec Reference: Technical Spec §10.5
"""

import asyncio
import logging
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


logger = logging.getLogger(__name__)


class ConnectionStatus(Enum):
    """Provider connection status."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    ERROR = "error"


class DataType(Enum):
    """Types of data subscriptions."""

    QUOTE = "quote"
    BAR = "bar"
    TRADE = "trade"


@dataclass
class ConnectionResult:
    """Result of connection attempt."""

    success: bool
    status: ConnectionStatus
    message: str = ""
    latency_ms: float = 0.0
    server_time: datetime | None = None


@dataclass
class Quote:
    """Market quote data."""

    symbol: str
    bid: Decimal
    ask: Decimal
    bid_size: int
    ask_size: int
    timestamp: datetime
    source: str = ""

    @property
    def mid(self) -> Decimal:
        """Mid price."""
        return (self.bid + self.ask) / 2

    @property
    def spread(self) -> Decimal:
        """Bid-ask spread."""
        return self.ask - self.bid

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "bid": str(self.bid),
            "ask": str(self.ask),
            "bidSize": self.bid_size,
            "askSize": self.ask_size,
            "timestamp": self.timestamp.isoformat(),
            "source": self.source,
        }


@dataclass
class Bar:
    """OHLCV bar data."""

    symbol: str
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    timeframe: str = "1m"
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "timestamp": self.timestamp.isoformat(),
            "open": str(self.open),
            "high": str(self.high),
            "low": str(self.low),
            "close": str(self.close),
            "volume": self.volume,
            "timeframe": self.timeframe,
            "source": self.source,
        }


@dataclass
class TradeEvent:
    """Trade/tick data."""

    symbol: str
    price: Decimal
    size: int
    timestamp: datetime
    side: str = ""  # 'buy', 'sell', or ''
    trade_id: str = ""
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "price": str(self.price),
            "size": self.size,
            "timestamp": self.timestamp.isoformat(),
            "side": self.side,
            "tradeId": self.trade_id,
            "source": self.source,
        }


# Callback type aliases
QuoteCallback = Callable[[Quote], None]
BarCallback = Callable[[Bar], None]
TradeCallback = Callable[[TradeEvent], None]
StatusCallback = Callable[[ConnectionStatus], None]


@dataclass
class Subscription:
    """Active data subscription."""

    symbol: str
    data_type: DataType
    callback: QuoteCallback | BarCallback | TradeCallback
    timeframe: str = "1m"
    active: bool = True


class DataProvider(ABC):
    """
    Abstract base class for data providers.

    Implements the DataProvider adapter interface per §10.5.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self._status = ConnectionStatus.DISCONNECTED
        self._subscriptions: dict[str, list[Subscription]] = {}
        self._status_callbacks: list[StatusCallback] = []
        self._last_quote_times: dict[str, datetime] = {}
        self._latency_ms: float = 0.0

    @property
    def status(self) -> ConnectionStatus:
        """Current connection status."""
        return self._status

    @property
    def is_connected(self) -> bool:
        """Check if connected."""
        return self._status == ConnectionStatus.CONNECTED

    @property
    def latency_ms(self) -> float:
        """Last measured latency in milliseconds."""
        return self._latency_ms

    @abstractmethod
    async def connect(self) -> ConnectionResult:
        """
        Establish connection to data provider.

        Returns:
            ConnectionResult with status
        """
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Disconnect from data provider."""
        pass

    @abstractmethod
    async def subscribe(
        self,
        symbol: str,
        data_type: DataType,
        callback: QuoteCallback | BarCallback | TradeCallback,
        timeframe: str = "1m",
    ) -> bool:
        """
        Subscribe to market data.

        Args:
            symbol: Symbol to subscribe to
            data_type: Type of data (quote, bar, trade)
            callback: Callback for data updates
            timeframe: Timeframe for bars

        Returns:
            True if subscription successful
        """
        pass

    @abstractmethod
    async def unsubscribe(self, symbol: str, data_type: DataType) -> bool:
        """
        Unsubscribe from market data.

        Args:
            symbol: Symbol to unsubscribe
            data_type: Type of data

        Returns:
            True if unsubscription successful
        """
        pass

    @abstractmethod
    async def get_historical_bars(
        self,
        symbol: str,
        timeframe: str,
        start: datetime,
        end: datetime,
    ) -> list[Bar]:
        """
        Get historical bar data.

        Args:
            symbol: Symbol to get data for
            timeframe: Bar timeframe (1m, 5m, 1h, 1d, etc.)
            start: Start datetime
            end: End datetime

        Returns:
            List of bars
        """
        pass

    @abstractmethod
    async def get_latest_quote(self, symbol: str) -> Quote | None:
        """
        Get latest quote for a symbol.

        Args:
            symbol: Symbol to get quote for

        Returns:
            Latest quote or None if unavailable
        """
        pass

    def on_status_change(self, callback: StatusCallback) -> None:
        """Register status change callback."""
        self._status_callbacks.append(callback)

    def _set_status(self, status: ConnectionStatus) -> None:
        """Update status and notify callbacks."""
        if self._status != status:
            self._status = status
            for callback in self._status_callbacks:
                try:
                    callback(status)
                except Exception as e:
                    logger.error(f"Status callback error: {e}")

    def _update_quote_time(self, symbol: str, timestamp: datetime) -> None:
        """Update last quote time for staleness tracking."""
        self._last_quote_times[symbol] = timestamp

    def get_quote_age(self, symbol: str) -> float | None:
        """
        Get age of last quote in seconds.

        Args:
            symbol: Symbol to check

        Returns:
            Age in seconds, or None if no quote received
        """
        if symbol not in self._last_quote_times:
            return None
        age = datetime.now(timezone.utc) - self._last_quote_times[symbol]
        return age.total_seconds()

    def _add_subscription(self, subscription: Subscription) -> None:
        """Track subscription internally."""
        symbol = subscription.symbol
        if symbol not in self._subscriptions:
            self._subscriptions[symbol] = []
        self._subscriptions[symbol].append(subscription)

    def _remove_subscription(self, symbol: str, data_type: DataType) -> None:
        """Remove subscription tracking."""
        if symbol in self._subscriptions:
            self._subscriptions[symbol] = [
                s for s in self._subscriptions[symbol]
                if s.data_type != data_type
            ]
            if not self._subscriptions[symbol]:
                del self._subscriptions[symbol]

    def _dispatch_quote(self, quote: Quote) -> None:
        """Dispatch quote to subscribers."""
        self._update_quote_time(quote.symbol, quote.timestamp)
        if quote.symbol in self._subscriptions:
            for sub in self._subscriptions[quote.symbol]:
                if sub.data_type == DataType.QUOTE and sub.active:
                    try:
                        sub.callback(quote)
                    except Exception as e:
                        logger.error(f"Quote callback error: {e}")

    def _dispatch_bar(self, bar: Bar) -> None:
        """Dispatch bar to subscribers."""
        if bar.symbol in self._subscriptions:
            for sub in self._subscriptions[bar.symbol]:
                if sub.data_type == DataType.BAR and sub.active:
                    if sub.timeframe == bar.timeframe:
                        try:
                            sub.callback(bar)
                        except Exception as e:
                            logger.error(f"Bar callback error: {e}")

    def _dispatch_trade(self, trade: TradeEvent) -> None:
        """Dispatch trade to subscribers."""
        if trade.symbol in self._subscriptions:
            for sub in self._subscriptions[trade.symbol]:
                if sub.data_type == DataType.TRADE and sub.active:
                    try:
                        sub.callback(trade)
                    except Exception as e:
                        logger.error(f"Trade callback error: {e}")


@dataclass
class StalenessConfig:
    """Configuration for quote staleness detection."""

    stale_threshold_seconds: float = 30.0
    critical_threshold_seconds: float = 60.0
    check_interval_seconds: float = 5.0


class QuoteStalenessMonitor:
    """
    Monitors quote staleness per §10.5.

    Thresholds:
    - 30s: Stale warning
    - 60s: Critical, may trigger circuit breaker
    """

    def __init__(
        self,
        provider: DataProvider,
        config: StalenessConfig | None = None,
    ) -> None:
        self.provider = provider
        self.config = config or StalenessConfig()
        self._running = False
        self._task: asyncio.Task | None = None
        self._stale_callbacks: list[Callable[[str, float], None]] = []
        self._critical_callbacks: list[Callable[[str, float], None]] = []

    def on_stale(self, callback: Callable[[str, float], None]) -> None:
        """Register callback for stale quotes (symbol, age_seconds)."""
        self._stale_callbacks.append(callback)

    def on_critical(self, callback: Callable[[str, float], None]) -> None:
        """Register callback for critical staleness (symbol, age_seconds)."""
        self._critical_callbacks.append(callback)

    async def start(self) -> None:
        """Start monitoring."""
        self._running = True
        self._task = asyncio.create_task(self._monitor_loop())

    async def stop(self) -> None:
        """Stop monitoring."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _monitor_loop(self) -> None:
        """Background monitoring loop."""
        while self._running:
            try:
                for symbol in list(self.provider._last_quote_times.keys()):
                    age = self.provider.get_quote_age(symbol)
                    if age is None:
                        continue

                    if age >= self.config.critical_threshold_seconds:
                        for cb in self._critical_callbacks:
                            try:
                                cb(symbol, age)
                            except Exception as e:
                                logger.error(f"Critical callback error: {e}")
                    elif age >= self.config.stale_threshold_seconds:
                        for cb in self._stale_callbacks:
                            try:
                                cb(symbol, age)
                            except Exception as e:
                                logger.error(f"Stale callback error: {e}")

                await asyncio.sleep(self.config.check_interval_seconds)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Staleness monitor error: {e}")
                await asyncio.sleep(1)
