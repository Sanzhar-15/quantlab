"""
Event-Driven Strategy API.

Provides an event-based API where strategies respond to market events.

Spec Reference: Technical Spec §8.4
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable
from typing import Protocol


class EventType(Enum):
    """Types of market events."""

    BAR = "bar"  # New bar available
    FILL = "fill"  # Order filled
    ORDER_REJECTED = "order_rejected"
    POSITION_CHANGED = "position_changed"
    DAY_START = "day_start"
    DAY_END = "day_end"
    TICK = "tick"  # Real-time tick
    CUSTOM = "custom"


@dataclass
class MarketEvent:
    """Base market event."""

    event_type: EventType
    timestamp: datetime
    symbol: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class BarEvent(MarketEvent):
    """New bar event."""

    open: Decimal = Decimal("0")
    high: Decimal = Decimal("0")
    low: Decimal = Decimal("0")
    close: Decimal = Decimal("0")
    volume: Decimal = Decimal("0")
    bar_index: int = 0

    def __post_init__(self) -> None:
        self.event_type = EventType.BAR


@dataclass
class FillEvent(MarketEvent):
    """Order fill event."""

    order_id: str = ""
    quantity: Decimal = Decimal("0")
    price: Decimal = Decimal("0")
    commission: Decimal = Decimal("0")
    side: str = ""  # "buy" or "sell"

    def __post_init__(self) -> None:
        self.event_type = EventType.FILL


@dataclass
class Context:
    """
    Strategy context.

    Provides access to portfolio state, data, and order submission.
    """

    # Current bar
    bar_index: int = 0
    timestamp: datetime | None = None
    bar: Any = None  # Current bar data for test compatibility

    # Portfolio
    cash: Decimal = Decimal("0")
    equity: Decimal = Decimal("0")
    positions: dict[str, Decimal] = field(default_factory=dict)
    portfolio: Any = None  # Portfolio object for test compatibility

    # Data access
    data: dict[str, Any] = field(default_factory=dict)  # symbol -> OHLCV

    # Pending orders
    pending_orders: list[dict[str, Any]] = field(default_factory=list)

    # Custom state
    state: dict[str, Any] = field(default_factory=dict)

    # Order callbacks (set by engine)
    _order_callback: Callable[..., str] | None = None

    def get_position(self, symbol: str) -> Decimal:
        """Get current position for symbol."""
        return self.positions.get(symbol, Decimal("0"))

    def has_position(self, symbol: str) -> bool:
        """Check if we have a position in symbol."""
        return self.get_position(symbol) != Decimal("0")

    def is_long(self, symbol: str) -> bool:
        """Check if long in symbol."""
        return self.get_position(symbol) > Decimal("0")

    def is_short(self, symbol: str) -> bool:
        """Check if short in symbol."""
        return self.get_position(symbol) < Decimal("0")

    def get_price(self, symbol: str, field: str = "close") -> Decimal | None:
        """Get current price for symbol."""
        if symbol not in self.data:
            return None

        ohlcv = self.data[symbol]
        prices = ohlcv.get(field, [])

        if not prices:
            return None

        return prices[-1] if isinstance(prices, list) else prices

    def get_history(
        self,
        symbol: str,
        field: str = "close",
        periods: int = 1,
    ) -> list[Decimal]:
        """
        Get historical prices.

        Args:
            symbol: Symbol to get
            field: Price field (open, high, low, close, volume)
            periods: Number of periods to get

        Returns:
            List of prices (most recent last)
        """
        if symbol not in self.data:
            return []

        ohlcv = self.data[symbol]
        prices = ohlcv.get(field, [])

        if not prices:
            return []

        if isinstance(prices, list):
            return list(prices[-periods:])
        return [prices]

    def order(
        self,
        symbol: str,
        quantity: Decimal | int,
        order_type: str = "market",
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,
    ) -> str:
        """
        Submit an order.

        Args:
            symbol: Symbol to trade
            quantity: Quantity (positive=buy, negative=sell)
            order_type: Order type (market, limit, stop, stop_limit)
            limit_price: Limit price if applicable
            stop_price: Stop price if applicable

        Returns:
            Order ID
        """
        if self._order_callback:
            return self._order_callback(
                symbol=symbol,
                quantity=Decimal(str(quantity)),
                order_type=order_type,
                limit_price=limit_price,
                stop_price=stop_price,
            )

        # Fallback: just track in pending
        order_id = f"ord-{len(self.pending_orders):06d}"
        self.pending_orders.append({
            "order_id": order_id,
            "symbol": symbol,
            "quantity": Decimal(str(quantity)),
            "order_type": order_type,
            "limit_price": limit_price,
            "stop_price": stop_price,
        })
        return order_id

    def buy(
        self,
        symbol: str,
        quantity: Decimal | int,
        order_type: str = "market",
        limit_price: Decimal | None = None,
    ) -> str:
        """Submit buy order."""
        return self.order(symbol, abs(quantity), order_type, limit_price)

    def sell(
        self,
        symbol: str,
        quantity: Decimal | int,
        order_type: str = "market",
        limit_price: Decimal | None = None,
    ) -> str:
        """Submit sell order."""
        return self.order(symbol, -abs(quantity), order_type, limit_price)

    def close_position(self, symbol: str) -> str | None:
        """Close existing position."""
        pos = self.get_position(symbol)
        if pos == Decimal("0"):
            return None
        return self.order(symbol, -pos)

    def set_state(self, key: str, value: Any) -> None:
        """Set custom state value."""
        self.state[key] = value

    def get_state(self, key: str, default: Any = None) -> Any:
        """Get custom state value."""
        return self.state.get(key, default)


class EventHandler(Protocol):
    """Protocol for event handlers."""

    def __call__(self, ctx: Context, event: MarketEvent) -> None:
        """Handle an event."""
        ...


@dataclass
class EventDrivenStrategy:
    """
    Event-driven strategy wrapper.

    Wraps event handler functions.
    """

    on_bar: Callable[[Context], None] | None = None
    on_fill: Callable[[Context, FillEvent], None] | None = None
    on_start: Callable[[Context], None] | None = None
    on_end: Callable[[Context], None] | None = None
    name: str = ""
    description: str = ""
    params: dict[str, Any] = field(default_factory=dict)

    def handle_event(self, ctx: Context, event: MarketEvent) -> None:
        """Route event to appropriate handler."""
        if event.event_type == EventType.BAR and self.on_bar:
            self.on_bar(ctx)
        elif event.event_type == EventType.FILL and self.on_fill:
            if isinstance(event, FillEvent):
                self.on_fill(ctx, event)
        elif event.event_type == EventType.DAY_START and self.on_start:
            self.on_start(ctx)
        elif event.event_type == EventType.DAY_END and self.on_end:
            self.on_end(ctx)


def event_strategy(
    func: Callable[[Context], None] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
) -> Callable[[Callable[[Context], None]], EventDrivenStrategy] | EventDrivenStrategy:
    """
    Decorator to create event-driven strategy from on_bar function.

    Can be used with or without arguments:
        @event_strategy
        def my_strategy(ctx):
            ...

        @event_strategy(name="Simple Moving Average")
        def sma_strategy(ctx):
            prices = ctx.get_history("AAPL", periods=20)
            if len(prices) >= 20:
                sma = sum(prices) / 20
                if ctx.get_price("AAPL") > sma:
                    ctx.buy("AAPL", 100)
    """
    def decorator(fn: Callable[[Context], None]) -> EventDrivenStrategy:
        from quantlab.api.params import extract_function_params
        return EventDrivenStrategy(
            on_bar=fn,
            name=name or fn.__name__,
            description=description or fn.__doc__ or "",
            params=extract_function_params(fn),
        )

    if func is not None:
        # Used without parentheses: @event_strategy
        return decorator(func)
    else:
        # Used with parentheses: @event_strategy(name="...")
        return decorator


# Example event-driven strategies


@event_strategy(name="Simple Momentum")
def example_momentum_event(ctx: Context) -> None:
    """
    Simple momentum strategy.

    Buys when price is above 20-period SMA.
    """
    symbol = "AAPL"  # Example symbol
    lookback = 20

    prices = ctx.get_history(symbol, periods=lookback)
    if len(prices) < lookback:
        return

    current = ctx.get_price(symbol)
    if current is None:
        return

    sma = sum(prices) / len(prices)

    if current > sma and not ctx.is_long(symbol):
        ctx.buy(symbol, 100)
    elif current < sma and ctx.is_long(symbol):
        ctx.close_position(symbol)


@event_strategy(name="RSI Reversal")
def example_rsi_event(ctx: Context) -> None:
    """
    RSI-based reversal strategy.

    Buys when RSI < 30, sells when RSI > 70.
    """
    symbol = "AAPL"
    period = 14

    prices = ctx.get_history(symbol, periods=period + 1)
    if len(prices) < period + 1:
        return

    # Calculate RSI
    gains = []
    losses = []

    for i in range(1, len(prices)):
        change = prices[i] - prices[i - 1]
        if change > 0:
            gains.append(float(change))
            losses.append(0)
        else:
            gains.append(0)
            losses.append(abs(float(change)))

    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    if avg_loss == 0:
        rsi = 100
    else:
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

    # Trading logic
    if rsi < 30 and not ctx.is_long(symbol):
        ctx.buy(symbol, 100)
    elif rsi > 70 and ctx.is_long(symbol):
        ctx.close_position(symbol)
