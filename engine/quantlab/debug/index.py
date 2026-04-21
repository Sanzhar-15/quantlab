"""
Debug File Index for Random Access.

Provides efficient random access to debug file contents.

This module creates and manages an index that allows O(1) access
to any bar's state, conditions, signals, and fills.

Spec Reference: Technical Spec Section 19.2
"""

import json
import logging
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


@dataclass
class BarIndex:
    """Index entry for a single bar."""

    bar_index: int
    has_state: bool = False
    has_signals: bool = False
    has_fills: bool = False
    has_conditions: bool = False
    signal_count: int = 0
    fill_count: int = 0
    condition_count: int = 0


@dataclass
class DebugIndex:
    """
    Index for a debug file.

    Enables efficient lookup of bars with specific content.
    """

    bar_count: int = 0
    trade_bars: list[int] = field(default_factory=list)  # Bars with fills
    signal_bars: list[int] = field(default_factory=list)  # Bars with signals
    condition_bars: list[int] = field(default_factory=list)  # Bars with conditions
    bar_entries: dict[int, BarIndex] = field(default_factory=dict)

    def add_bar(
        self,
        bar_index: int,
        has_state: bool = True,
        signal_count: int = 0,
        fill_count: int = 0,
        condition_count: int = 0,
    ) -> None:
        """Add a bar to the index."""
        entry = BarIndex(
            bar_index=bar_index,
            has_state=has_state,
            has_signals=signal_count > 0,
            has_fills=fill_count > 0,
            has_conditions=condition_count > 0,
            signal_count=signal_count,
            fill_count=fill_count,
            condition_count=condition_count,
        )

        self.bar_entries[bar_index] = entry
        self.bar_count = max(self.bar_count, bar_index + 1)

        if fill_count > 0:
            if bar_index not in self.trade_bars:
                self.trade_bars.append(bar_index)
                self.trade_bars.sort()

        if signal_count > 0:
            if bar_index not in self.signal_bars:
                self.signal_bars.append(bar_index)
                self.signal_bars.sort()

        if condition_count > 0:
            if bar_index not in self.condition_bars:
                self.condition_bars.append(bar_index)
                self.condition_bars.sort()

    def get_next_trade_bar(self, current: int) -> int | None:
        """Get the next bar with a trade after current."""
        for bar in self.trade_bars:
            if bar > current:
                return bar
        return None

    def get_prev_trade_bar(self, current: int) -> int | None:
        """Get the previous bar with a trade before current."""
        for bar in reversed(self.trade_bars):
            if bar < current:
                return bar
        return None

    def get_next_signal_bar(self, current: int) -> int | None:
        """Get the next bar with a signal after current."""
        for bar in self.signal_bars:
            if bar > current:
                return bar
        return None

    def get_prev_signal_bar(self, current: int) -> int | None:
        """Get the previous bar with a signal before current."""
        for bar in reversed(self.signal_bars):
            if bar < current:
                return bar
        return None

    def has_trades(self, bar_index: int) -> bool:
        """Check if bar has trades."""
        entry = self.bar_entries.get(bar_index)
        return entry.has_fills if entry else False

    def has_signals(self, bar_index: int) -> bool:
        """Check if bar has signals."""
        entry = self.bar_entries.get(bar_index)
        return entry.has_signals if entry else False

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "bar_count": self.bar_count,
            "trade_bars": self.trade_bars,
            "signal_bars": self.signal_bars,
            "condition_bars": self.condition_bars,
            "bar_entries": {
                str(k): {
                    "bar_index": v.bar_index,
                    "has_state": v.has_state,
                    "has_signals": v.has_signals,
                    "has_fills": v.has_fills,
                    "has_conditions": v.has_conditions,
                    "signal_count": v.signal_count,
                    "fill_count": v.fill_count,
                    "condition_count": v.condition_count,
                }
                for k, v in self.bar_entries.items()
            },
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DebugIndex":
        """Create from dictionary."""
        index = cls(
            bar_count=data.get("bar_count", 0),
            trade_bars=data.get("trade_bars", []),
            signal_bars=data.get("signal_bars", []),
            condition_bars=data.get("condition_bars", []),
        )

        for k, v in data.get("bar_entries", {}).items():
            index.bar_entries[int(k)] = BarIndex(
                bar_index=v["bar_index"],
                has_state=v.get("has_state", False),
                has_signals=v.get("has_signals", False),
                has_fills=v.get("has_fills", False),
                has_conditions=v.get("has_conditions", False),
                signal_count=v.get("signal_count", 0),
                fill_count=v.get("fill_count", 0),
                condition_count=v.get("condition_count", 0),
            )

        return index


class DebugIndexBuilder:
    """
    Builds a debug file index.

    Used during backtest execution to track what's in each bar.
    """

    def __init__(self) -> None:
        """Initialize index builder."""
        self._index = DebugIndex()
        self._current_bar = 0
        self._signal_counts: dict[int, int] = {}
        self._fill_counts: dict[int, int] = {}
        self._condition_counts: dict[int, int] = {}

    def set_bar(self, bar_index: int) -> None:
        """Set the current bar index."""
        self._current_bar = bar_index

    def record_signal(self, bar_index: int | None = None) -> None:
        """Record a signal at the specified or current bar."""
        idx = bar_index if bar_index is not None else self._current_bar
        self._signal_counts[idx] = self._signal_counts.get(idx, 0) + 1

    def record_fill(self, bar_index: int | None = None) -> None:
        """Record a fill at the specified or current bar."""
        idx = bar_index if bar_index is not None else self._current_bar
        self._fill_counts[idx] = self._fill_counts.get(idx, 0) + 1

    def record_condition(self, bar_index: int | None = None) -> None:
        """Record a condition capture at the specified or current bar."""
        idx = bar_index if bar_index is not None else self._current_bar
        self._condition_counts[idx] = self._condition_counts.get(idx, 0) + 1

    def build(self, total_bars: int) -> DebugIndex:
        """
        Build the final index.

        Args:
            total_bars: Total number of bars in the backtest

        Returns:
            Complete debug index
        """
        self._index.bar_count = total_bars

        # Combine all bars
        all_bars = set(range(total_bars))
        all_bars.update(self._signal_counts.keys())
        all_bars.update(self._fill_counts.keys())
        all_bars.update(self._condition_counts.keys())

        for bar_idx in sorted(all_bars):
            if bar_idx < total_bars:
                self._index.add_bar(
                    bar_index=bar_idx,
                    has_state=True,
                    signal_count=self._signal_counts.get(bar_idx, 0),
                    fill_count=self._fill_counts.get(bar_idx, 0),
                    condition_count=self._condition_counts.get(bar_idx, 0),
                )

        return self._index


def save_index(index: DebugIndex, path: Path) -> None:
    """
    Save debug index to file.

    Args:
        index: Debug index to save
        path: Output path (will use .idx extension)
    """
    idx_path = path.with_suffix(".idx")
    with open(idx_path, "w") as f:
        json.dump(index.to_dict(), f, indent=2)

    logger.debug(f"Index saved: {idx_path}")


def load_index(path: Path) -> DebugIndex | None:
    """
    Load debug index from file.

    Args:
        path: Debug file path (will look for .idx extension)

    Returns:
        Debug index or None if not found
    """
    idx_path = path.with_suffix(".idx")

    if not idx_path.exists():
        return None

    try:
        with open(idx_path, "r") as f:
            data = json.load(f)
        return DebugIndex.from_dict(data)
    except Exception as e:
        logger.warning(f"Failed to load index: {e}")
        return None
