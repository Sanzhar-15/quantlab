"""
Bar Data Structures.

Provides the canonical OHLCV bar representation used throughout the engine.

Spec Reference: Technical Spec §3.1
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any


@dataclass(frozen=True)
class Bar:
    """
    Single OHLCV bar.

    Timestamp represents bar CLOSE time (not open).
    All prices use Decimal for precision.
    """

    timestamp: datetime  # Bar close time (UTC)
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    symbol: str

    def __post_init__(self) -> None:
        """Validate bar data."""
        if self.close <= Decimal("0"):
            raise ValueError(f"Close price ({self.close}) must be positive")
        if self.open <= Decimal("0"):
            raise ValueError(f"Open price ({self.open}) must be positive")
        if self.high < self.low:
            raise ValueError(f"High ({self.high}) cannot be less than low ({self.low})")
        if self.high < self.open or self.high < self.close:
            raise ValueError(f"High ({self.high}) must be >= open and close")
        if self.low > self.open or self.low > self.close:
            raise ValueError(f"Low ({self.low}) must be <= open and close")
        if self.volume < Decimal("0"):
            raise ValueError(f"Volume ({self.volume}) cannot be negative")

    @property
    def typical_price(self) -> Decimal:
        """Typical price: (H + L + C) / 3."""
        return (self.high + self.low + self.close) / Decimal("3")

    @property
    def vwap_proxy(self) -> Decimal:
        """VWAP proxy: (O + H + L + C) / 4."""
        return (self.open + self.high + self.low + self.close) / Decimal("4")

    @property
    def range(self) -> Decimal:
        """Bar range (high - low)."""
        return self.high - self.low

    @property
    def body(self) -> Decimal:
        """Bar body (close - open)."""
        return self.close - self.open

    @property
    def is_green(self) -> bool:
        """True if close > open."""
        return self.close > self.open

    @property
    def is_red(self) -> bool:
        """True if close < open."""
        return self.close < self.open

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "timestamp": self.timestamp.isoformat(),
            "open": str(self.open),
            "high": str(self.high),
            "low": str(self.low),
            "close": str(self.close),
            "volume": str(self.volume),
            "symbol": self.symbol,
        }


@dataclass
class BarSeries:
    """
    Series of bars for a single symbol.

    Bars are stored in chronological order (oldest first).
    """

    symbol: str
    timeframe: str
    bars: list[Bar]

    def __len__(self) -> int:
        return len(self.bars)

    def __getitem__(self, index: int) -> Bar:
        return self.bars[index]

    @property
    def timestamps(self) -> list[datetime]:
        """Get all timestamps."""
        return [bar.timestamp for bar in self.bars]

    @property
    def opens(self) -> list[Decimal]:
        """Get all open prices."""
        return [bar.open for bar in self.bars]

    @property
    def highs(self) -> list[Decimal]:
        """Get all high prices."""
        return [bar.high for bar in self.bars]

    @property
    def lows(self) -> list[Decimal]:
        """Get all low prices."""
        return [bar.low for bar in self.bars]

    @property
    def closes(self) -> list[Decimal]:
        """Get all close prices."""
        return [bar.close for bar in self.bars]

    @property
    def volumes(self) -> list[Decimal]:
        """Get all volumes."""
        return [bar.volume for bar in self.bars]

    def slice(self, start: int, end: int | None = None) -> "BarSeries":
        """Get a slice of the series."""
        return BarSeries(
            symbol=self.symbol,
            timeframe=self.timeframe,
            bars=self.bars[start:end],
        )

    def up_to(self, index: int) -> "BarSeries":
        """Get bars up to and including the given index (for strategy evaluation)."""
        return self.slice(0, index + 1)
