"""
Vectorized Strategy API.

Provides a functional API for strategies that operate on entire arrays.

Spec Reference: Technical Spec §8.3
"""

from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from typing import Any
from typing import Callable
from typing import Protocol
from typing import TypeAlias

from quantlab.api.params import ParamSpec
from quantlab.api.params import extract_function_params


# Type aliases
SignalArray: TypeAlias = list[Decimal]  # Would be numpy array in practice
DataDict: TypeAlias = dict[str, Any]  # Symbol -> OHLCV data


@dataclass
class VectorizedSignals:
    """
    Signals from vectorized strategy.

    Contains position targets for each symbol.
    """

    # Symbol -> target position (1=long, -1=short, 0=flat)
    positions: dict[str, Decimal] = field(default_factory=dict)

    # Symbol -> weight (for portfolio allocation)
    weights: dict[str, Decimal] = field(default_factory=dict)

    # Symbol -> quantity (explicit quantity)
    quantities: dict[str, Decimal] = field(default_factory=dict)

    # Metadata
    timestamp: Any = None
    bar_index: int = 0

    def set_position(
        self,
        symbol: str,
        target: Decimal | float | int,
    ) -> None:
        """Set target position for symbol."""
        self.positions[symbol] = Decimal(str(target))

    def set_weight(
        self,
        symbol: str,
        weight: Decimal | float,
    ) -> None:
        """Set portfolio weight for symbol."""
        self.weights[symbol] = Decimal(str(weight))

    def set_quantity(
        self,
        symbol: str,
        quantity: Decimal | int,
    ) -> None:
        """Set explicit quantity for symbol."""
        self.quantities[symbol] = Decimal(str(quantity))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "positions": {k: str(v) for k, v in self.positions.items()},
            "weights": {k: str(v) for k, v in self.weights.items()},
            "quantities": {k: str(v) for k, v in self.quantities.items()},
            "bar_index": self.bar_index,
        }


class VectorizedStrategy(Protocol):
    """
    Protocol for vectorized strategies.

    Strategies implement a function that receives all data
    and returns signals for each bar.
    """

    def __call__(
        self,
        data: DataDict,
        **params: Any,
    ) -> VectorizedSignals:
        """
        Generate signals from data.

        Args:
            data: Dictionary of symbol -> OHLCV arrays
            **params: Strategy parameters

        Returns:
            VectorizedSignals
        """
        ...


@dataclass
class VectorizedStrategyWrapper:
    """
    Wrapper for vectorized strategy functions.

    Provides parameter extraction and validation.
    """

    func: Callable[..., VectorizedSignals]
    name: str = ""
    description: str = ""
    params: dict[str, ParamSpec] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.name:
            self.name = self.func.__name__

        if not self.description:
            self.description = self.func.__doc__ or ""

        if not self.params:
            self.params = extract_function_params(self.func)

    def __call__(
        self,
        data: DataDict,
        **kwargs: Any,
    ) -> VectorizedSignals:
        """Execute strategy."""
        return self.func(data, **kwargs)

    def get_default_params(self) -> dict[str, Any]:
        """Get default parameter values."""
        return {name: spec.default for name, spec in self.params.items()}


def vectorized_strategy(
    func: Callable | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
) -> Callable[[Callable], VectorizedStrategyWrapper] | VectorizedStrategyWrapper:
    """
    Decorator to create vectorized strategy.

    Can be used with or without arguments:
        @vectorized_strategy
        def my_strategy(data):
            ...

        @vectorized_strategy(name="SMA Crossover")
        def sma_crossover(data, fast=10, slow=30):
            ...
            return VectorizedSignals(positions=positions)
    """
    def decorator(fn: Callable) -> VectorizedStrategyWrapper:
        wrapper = VectorizedStrategyWrapper(
            func=fn,
            name=name or fn.__name__,
            description=description or fn.__doc__ or "",
        )
        # Copy params to wrapper for test compatibility
        wrapper.params = extract_function_params(fn)
        return wrapper

    if func is not None:
        # Used without parentheses: @vectorized_strategy
        return decorator(func)
    else:
        # Used with parentheses: @vectorized_strategy(name="...")
        return decorator


# Convenience functions for building signals


def long(symbol: str, weight: float = 1.0) -> VectorizedSignals:
    """Create long signal for a symbol."""
    signals = VectorizedSignals()
    signals.set_position(symbol, Decimal("1"))
    signals.set_weight(symbol, Decimal(str(weight)))
    return signals


def short(symbol: str, weight: float = 1.0) -> VectorizedSignals:
    """Create short signal for a symbol."""
    signals = VectorizedSignals()
    signals.set_position(symbol, Decimal("-1"))
    signals.set_weight(symbol, Decimal(str(weight)))
    return signals


def flat(symbol: str) -> VectorizedSignals:
    """Create flat signal for a symbol."""
    signals = VectorizedSignals()
    signals.set_position(symbol, Decimal("0"))
    return signals


def combine_signals(*signal_lists: VectorizedSignals) -> VectorizedSignals:
    """Combine multiple signal objects."""
    combined = VectorizedSignals()

    for signals in signal_lists:
        combined.positions.update(signals.positions)
        combined.weights.update(signals.weights)
        combined.quantities.update(signals.quantities)

    return combined


# Example vectorized strategies


def example_momentum(
    data: DataDict,
    lookback: int = 20,
    threshold: float = 0.0,
) -> VectorizedSignals:
    """
    Example momentum strategy.

    Goes long if return over lookback period exceeds threshold.

    Args:
        data: OHLCV data by symbol
        lookback: Lookback period
        threshold: Minimum return to go long

    Returns:
        VectorizedSignals
    """
    signals = VectorizedSignals()

    for symbol, ohlcv in data.items():
        # Get close prices
        close = ohlcv.get("close", [])

        if len(close) < lookback + 1:
            continue

        # Calculate return over lookback
        current = close[-1]
        past = close[-lookback - 1]

        if past > 0:
            momentum = (current - past) / past

            if momentum > threshold:
                signals.set_position(symbol, Decimal("1"))
            elif momentum < -threshold:
                signals.set_position(symbol, Decimal("-1"))
            else:
                signals.set_position(symbol, Decimal("0"))

    return signals


def example_mean_reversion(
    data: DataDict,
    lookback: int = 20,
    num_std: float = 2.0,
) -> VectorizedSignals:
    """
    Example mean reversion strategy.

    Goes long when price is below lower band, short when above upper band.

    Args:
        data: OHLCV data by symbol
        lookback: Lookback for moving average
        num_std: Number of standard deviations for bands

    Returns:
        VectorizedSignals
    """
    import math

    signals = VectorizedSignals()

    for symbol, ohlcv in data.items():
        close = ohlcv.get("close", [])

        if len(close) < lookback:
            continue

        # Calculate mean and std
        window = close[-lookback:]
        mean = sum(window) / len(window)
        variance = sum((x - mean) ** 2 for x in window) / len(window)
        std = math.sqrt(variance)

        current = close[-1]
        upper = mean + num_std * std
        lower = mean - num_std * std

        if current < lower:
            signals.set_position(symbol, Decimal("1"))
        elif current > upper:
            signals.set_position(symbol, Decimal("-1"))
        else:
            signals.set_position(symbol, Decimal("0"))

    return signals
