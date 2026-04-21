"""
Class-Based Strategy API.

Provides an object-oriented API for strategies.

Spec Reference: Technical Spec §8.5
"""

from abc import ABC
from abc import abstractmethod
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from typing import Any
from typing import Callable

from quantlab.api.event import Context
from quantlab.api.params import Param
from quantlab.api.params import extract_params
from quantlab.api.state import StateCapture
from quantlab.api.state import StrategyState


class Strategy(ABC, StateCapture):
    """
    Abstract base class for strategies.

    Extend this class to implement custom trading strategies.

    Example:
        class MyStrategy(Strategy):
            lookback = param(20, min=5, max=100)

            def on_bar(self, ctx):
                if some_condition:
                    ctx.buy("AAPL", 100)
    """

    # Strategy metadata
    name: str = ""
    description: str = ""
    version: str = "1.0.0"

    def __init__(self, **params: Any) -> None:
        """
        Initialize strategy with parameters.

        Args:
            **params: Parameter overrides
        """
        super().__init__()

        # Set name from class if not defined
        if not self.name:
            self.name = self.__class__.__name__

        # Apply parameter overrides
        for name, value in params.items():
            if hasattr(self, name):
                setattr(self, name, value)

        # Internal state
        self._initialized = False
        self._bar_count = 0

    def initialize(self, ctx: Context) -> None:
        """
        Called once before first bar.

        Override to set up indicators, state, etc.

        Args:
            ctx: Strategy context
        """
        pass

    @abstractmethod
    def on_bar(self, ctx: Context) -> None:
        """
        Called on each new bar.

        Must be implemented by subclasses.

        Args:
            ctx: Strategy context with market data and order methods
        """
        pass

    def on_fill(self, ctx: Context, fill: Any) -> None:
        """
        Called when an order is filled.

        Override to handle fills.

        Args:
            ctx: Strategy context
            fill: Fill details
        """
        pass

    def on_order_rejected(self, ctx: Context, order: Any, reason: str) -> None:
        """
        Called when an order is rejected.

        Args:
            ctx: Strategy context
            order: Rejected order
            reason: Rejection reason
        """
        pass

    def on_day_start(self, ctx: Context) -> None:
        """Called at the start of each trading day."""
        pass

    def on_day_end(self, ctx: Context) -> None:
        """Called at the end of each trading day."""
        pass

    def finalize(self, ctx: Context) -> None:
        """
        Called after last bar.

        Override to clean up resources.

        Args:
            ctx: Strategy context
        """
        pass

    def get_parameters(self) -> dict[str, Any]:
        """Get current parameter values."""
        params = {}
        param_specs = extract_params(self)

        for name in param_specs:
            params[name] = getattr(self, name)

        return params

    def set_parameters(self, params: dict[str, Any]) -> None:
        """Set parameter values."""
        param_specs = extract_params(self)

        for name, value in params.items():
            if name in param_specs:
                setattr(self, name, value)

    def capture_state(self, strategy_name: str | None = None) -> StrategyState:
        """
        Capture current strategy state.

        Returns:
            StrategyState for checkpointing
        """
        return StrategyState(
            strategy_name=strategy_name or self.name,
            strategy_version=self.version,
            params=self.get_parameters(),
            internal_state=self._custom_state.copy(),
            indicator_state=self._indicator_cache.copy(),
        )

    def restore_state(self, state: StrategyState) -> None:
        """
        Restore strategy from checkpoint.

        Args:
            state: State to restore
        """
        self.set_parameters(state.params)
        self._custom_state = state.internal_state.copy()
        self._indicator_cache = state.indicator_state.copy()


class StrategyRunner:
    """
    Runs a strategy through data.

    Handles lifecycle and event dispatch.
    """

    def __init__(
        self,
        strategy: Strategy,
        params: dict[str, Any] | None = None,
    ) -> None:
        """
        Initialize runner.

        Args:
            strategy: Strategy instance to run
            params: Parameter overrides
        """
        self.strategy = strategy
        self._ctx: Context | None = None

        # Apply parameter overrides
        if params:
            for name, value in params.items():
                if hasattr(strategy, name):
                    setattr(strategy, name, value)

    def setup(self, initial_cash: Decimal) -> Context:
        """
        Set up the strategy context.

        Args:
            initial_cash: Starting cash

        Returns:
            Initialized context
        """
        self._ctx = Context(cash=initial_cash, equity=initial_cash)
        return self._ctx

    def run_bar(
        self,
        bar_index: int,
        timestamp: datetime,
        data: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """
        Process a single bar.

        Args:
            bar_index: Current bar index
            timestamp: Bar timestamp
            data: OHLCV data by symbol

        Returns:
            List of orders generated
        """
        if self._ctx is None:
            raise RuntimeError("Call setup() first")

        # Update context
        self._ctx.bar_index = bar_index
        self._ctx.timestamp = timestamp
        self._ctx.data = data
        self._ctx.pending_orders = []

        # Initialize on first bar
        if not self.strategy._initialized:
            self.strategy.initialize(self._ctx)
            self.strategy._initialized = True

        # Call strategy
        self.strategy.on_bar(self._ctx)
        self.strategy._bar_count += 1

        return self._ctx.pending_orders

    def apply_fill(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        commission: Decimal = Decimal("0"),
    ) -> None:
        """
        Apply a fill to the context.

        Args:
            symbol: Filled symbol
            quantity: Filled quantity
            price: Fill price
            commission: Commission
        """
        if self._ctx is None:
            return

        # Update position
        current = self._ctx.positions.get(symbol, Decimal("0"))
        self._ctx.positions[symbol] = current + quantity

        # Update cash
        notional = quantity * price
        self._ctx.cash -= notional + commission

        # Remove zero positions
        if self._ctx.positions[symbol] == Decimal("0"):
            del self._ctx.positions[symbol]

        # Update equity
        self._ctx.equity = self._ctx.cash
        for sym, pos in self._ctx.positions.items():
            if sym in self._ctx.data:
                close = self._ctx.data[sym].get("close", [])
                if close:
                    last_price = close[-1] if isinstance(close, list) else close
                    self._ctx.equity += pos * last_price

    def finish(self) -> None:
        """Finalize the strategy run."""
        if self._ctx is not None:
            self.strategy.finalize(self._ctx)


# Example class-based strategies


class SMACrossover(Strategy):
    """
    Simple Moving Average Crossover Strategy.

    Goes long when fast SMA crosses above slow SMA.
    """

    name = "SMA Crossover"
    description = "Trades moving average crossovers"

    # Parameters
    fast_period: int = 10
    slow_period: int = 30
    symbol: str = "AAPL"

    def __init__(
        self,
        fast_period: int = 10,
        slow_period: int = 30,
        symbol: str = "AAPL",
    ) -> None:
        super().__init__()
        self.fast_period = fast_period
        self.slow_period = slow_period
        self.symbol = symbol

    def on_bar(self, ctx: Context) -> None:
        """Process bar."""
        prices = ctx.get_history(self.symbol, periods=self.slow_period)

        if len(prices) < self.slow_period:
            return

        # Calculate SMAs
        fast_sma = sum(prices[-self.fast_period:]) / self.fast_period
        slow_sma = sum(prices) / self.slow_period

        # Get previous SMAs from state
        prev_fast = ctx.get_state("prev_fast")
        prev_slow = ctx.get_state("prev_slow")

        # Check for crossover
        if prev_fast is not None and prev_slow is not None:
            # Bullish crossover
            if prev_fast <= prev_slow and fast_sma > slow_sma:
                if not ctx.is_long(self.symbol):
                    ctx.close_position(self.symbol)
                    ctx.buy(self.symbol, 100)

            # Bearish crossover
            elif prev_fast >= prev_slow and fast_sma < slow_sma:
                if ctx.is_long(self.symbol):
                    ctx.close_position(self.symbol)

        # Save state
        ctx.set_state("prev_fast", fast_sma)
        ctx.set_state("prev_slow", slow_sma)


class MeanReversion(Strategy):
    """
    Bollinger Band Mean Reversion Strategy.

    Buys at lower band, sells at upper band.
    """

    name = "Mean Reversion"
    description = "Bollinger Band mean reversion"

    period: int = 20
    num_std: float = 2.0
    symbol: str = "AAPL"

    def __init__(
        self,
        period: int = 20,
        num_std: float = 2.0,
        symbol: str = "AAPL",
    ) -> None:
        super().__init__()
        self.period = period
        self.num_std = num_std
        self.symbol = symbol

    def on_bar(self, ctx: Context) -> None:
        """Process bar."""
        import math

        prices = ctx.get_history(self.symbol, periods=self.period)

        if len(prices) < self.period:
            return

        # Calculate bands
        mean = sum(prices) / len(prices)
        variance = sum((p - mean) ** 2 for p in prices) / len(prices)
        std = Decimal(str(math.sqrt(float(variance))))

        upper = mean + Decimal(str(self.num_std)) * std
        lower = mean - Decimal(str(self.num_std)) * std

        current = ctx.get_price(self.symbol)
        if current is None:
            return

        # Trading logic
        if current <= lower and not ctx.has_position(self.symbol):
            ctx.buy(self.symbol, 100)
        elif current >= upper and ctx.is_long(self.symbol):
            ctx.close_position(self.symbol)
        elif current >= mean and ctx.is_long(self.symbol):
            # Take profit at mean
            pass  # Optional partial exit
