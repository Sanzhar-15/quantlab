"""
Consecutive Loss Tracking.

Tracks consecutive losing trades and triggers circuit breakers.

Spec Reference: Technical Spec §11.1, Decision L74
"""

import logging
import threading
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from typing import Any
from typing import Callable


logger = logging.getLogger(__name__)


@dataclass
class TradeResult:
    """Result of a closed trade."""

    trade_id: str
    symbol: str
    pnl: Decimal
    closed_at: datetime
    entry_price: Decimal
    exit_price: Decimal
    quantity: Decimal
    side: str  # "long" or "short"


@dataclass
class LossStreakEvent:
    """Event emitted when loss streak threshold is reached."""

    consecutive_losses: int
    threshold: int
    total_loss: Decimal
    triggered_at: datetime
    trades: list[TradeResult] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "consecutive_losses": self.consecutive_losses,
            "threshold": self.threshold,
            "total_loss": str(self.total_loss),
            "triggered_at": self.triggered_at.isoformat(),
            "trade_ids": [t.trade_id for t in self.trades],
        }


class ConsecutiveLossTracker:
    """
    Tracks consecutive losing trades.

    Triggers circuit breaker when threshold is reached.

    Usage:
        tracker = ConsecutiveLossTracker(limit=3)
        tracker.on_threshold(handle_circuit_breaker)

        for trade in closed_trades:
            if tracker.record_trade(trade.pnl):
                # Circuit breaker triggered
                pause_trading()
    """

    def __init__(
        self,
        limit: int = 3,
        reset_on_win: bool = True,
    ) -> None:
        """
        Initialize tracker.

        Args:
            limit: Number of consecutive losses to trigger circuit breaker
            reset_on_win: Whether to reset counter on any winning trade
        """
        self._limit = limit
        self._reset_on_win = reset_on_win

        # Thread safety lock
        self._lock = threading.Lock()

        self._consecutive_losses = 0
        self._total_loss = Decimal("0")
        self._recent_trades: list[TradeResult] = []
        self._max_recent_trades = 100  # Limit memory usage
        self._callbacks: list[Callable[[LossStreakEvent], None]] = []

        # Statistics
        self._total_trades = 0
        self._trigger_count = 0
        self._max_streak = 0

    @property
    def limit(self) -> int:
        """Loss threshold that triggers circuit breaker."""
        return self._limit

    @property
    def consecutive_losses(self) -> int:
        """Current consecutive loss count."""
        return self._consecutive_losses

    @property
    def total_loss_in_streak(self) -> Decimal:
        """Total loss amount in current streak."""
        return self._total_loss

    @property
    def max_streak(self) -> int:
        """Maximum consecutive losses seen."""
        return self._max_streak

    def on_threshold(
        self,
        callback: Callable[[LossStreakEvent], None],
    ) -> None:
        """Register callback for when threshold is reached."""
        self._callbacks.append(callback)

    def record_trade(self, pnl: Decimal, trade: TradeResult | None = None) -> bool:
        """
        Record a trade result.

        Thread-safe: uses lock to protect state modifications.
        Callbacks are executed outside the lock to prevent blocking.

        Args:
            pnl: Profit/loss of the trade (negative = loss)
            trade: Optional full trade result for tracking

        Returns:
            True if circuit breaker should trigger
        """
        should_trigger = False
        event: LossStreakEvent | None = None

        with self._lock:
            self._total_trades += 1

            if pnl < Decimal("0"):
                # Loss
                self._consecutive_losses += 1
                self._total_loss += abs(pnl)

                if trade:
                    self._recent_trades.append(trade)
                    # Trim recent trades to limit memory usage
                    if len(self._recent_trades) > self._max_recent_trades:
                        self._recent_trades = self._recent_trades[-self._max_recent_trades:]

                # Update max streak
                if self._consecutive_losses > self._max_streak:
                    self._max_streak = self._consecutive_losses

                logger.debug(
                    f"Loss recorded: {pnl}, consecutive: {self._consecutive_losses}/{self._limit}"
                )

                if self._consecutive_losses >= self._limit:
                    self._trigger_count += 1
                    should_trigger = True
                    # Capture event data while holding lock
                    event = LossStreakEvent(
                        consecutive_losses=self._consecutive_losses,
                        threshold=self._limit,
                        total_loss=self._total_loss,
                        triggered_at=datetime.now(),
                        trades=list(self._recent_trades),
                    )

            else:
                # Win or breakeven
                if self._reset_on_win:
                    if self._consecutive_losses > 0:
                        logger.debug(
                            f"Win recorded ({pnl}), resetting loss counter from {self._consecutive_losses}"
                        )
                    self._reset_streak()

        # Execute callbacks OUTSIDE the lock to prevent blocking
        if should_trigger and event:
            self._execute_callbacks(event)

        return should_trigger

    def _execute_callbacks(self, event: LossStreakEvent) -> None:
        """Execute circuit breaker callbacks (outside lock)."""
        logger.warning(
            f"Circuit breaker triggered: {event.consecutive_losses} consecutive losses, "
            f"total loss: {event.total_loss}"
        )

        for callback in self._callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"Circuit breaker callback error: {e}")

    def _reset_streak(self) -> None:
        """Reset the loss streak."""
        self._consecutive_losses = 0
        self._total_loss = Decimal("0")
        self._recent_trades.clear()

    def reset(self) -> None:
        """Manually reset the tracker (e.g., after user acknowledgment)."""
        with self._lock:
            self._reset_streak()
        logger.info("Consecutive loss tracker manually reset")

    def update_limit(self, new_limit: int) -> None:
        """Update the loss limit threshold."""
        event = None
        with self._lock:
            old_limit = self._limit
            self._limit = new_limit
            logger.info(f"Loss limit updated: {old_limit} -> {new_limit}")

            # Check if we should trigger with new limit
            if self._consecutive_losses >= self._limit:
                event = LossStreakEvent(
                    consecutive_losses=self._consecutive_losses,
                    threshold=self._limit,
                    total_loss=self._total_loss,
                    triggered_at=datetime.now(),
                    trades=list(self._recent_trades),
                )
                self._trigger_count += 1

        # FIX-H8: Fire callbacks OUTSIDE lock to prevent deadlock
        if event:
            self._execute_callbacks(event)

    def statistics(self) -> dict[str, Any]:
        """Get tracker statistics."""
        return {
            "total_trades": self._total_trades,
            "current_streak": self._consecutive_losses,
            "max_streak": self._max_streak,
            "trigger_count": self._trigger_count,
            "limit": self._limit,
        }


class DailyLossTracker:
    """
    Tracks daily loss limits.

    Separate from consecutive losses - tracks total daily P&L.
    """

    def __init__(self, daily_limit: Decimal) -> None:
        """
        Initialize tracker.

        Args:
            daily_limit: Maximum daily loss allowed (positive number)
        """
        # Thread safety lock
        self._lock = threading.Lock()

        self._daily_limit = abs(daily_limit)
        self._current_pnl = Decimal("0")
        self._trade_count = 0
        self._last_reset: datetime | None = None
        self._callbacks: list[Callable[[Decimal, Decimal], None]] = []

    @property
    def daily_limit(self) -> Decimal:
        """Maximum daily loss allowed."""
        return self._daily_limit

    @property
    def current_pnl(self) -> Decimal:
        """Current daily P&L."""
        return self._current_pnl

    @property
    def remaining_risk(self) -> Decimal:
        """Remaining risk budget for today."""
        if self._current_pnl >= Decimal("0"):
            return self._daily_limit
        return self._daily_limit + self._current_pnl

    def on_limit_breach(
        self,
        callback: Callable[[Decimal, Decimal], None],
    ) -> None:
        """Register callback for daily limit breach."""
        self._callbacks.append(callback)

    def record_pnl(self, pnl: Decimal) -> bool:
        """
        Record P&L change.

        Thread-safe: uses lock to protect state modifications.

        Args:
            pnl: P&L amount (positive = profit, negative = loss)

        Returns:
            True if daily limit is breached
        """
        should_trigger = False
        with self._lock:
            self._current_pnl += pnl
            self._trade_count += 1

            logger.debug(
                f"Daily P&L: {self._current_pnl} (limit: -{self._daily_limit})"
            )

            if self._current_pnl < -self._daily_limit:
                should_trigger = True

        # FIX-H8: Fire callbacks OUTSIDE lock to prevent deadlock
        if should_trigger:
            self._trigger_limit_breach()

        return should_trigger

    def _trigger_limit_breach(self) -> None:
        """Trigger limit breach callbacks."""
        logger.warning(
            f"Daily loss limit breached: P&L {self._current_pnl} < -{self._daily_limit}"
        )

        for callback in self._callbacks:
            try:
                callback(self._current_pnl, self._daily_limit)
            except Exception as e:
                logger.error(f"Daily limit callback error: {e}")

    def reset_daily(self) -> None:
        """Reset for new trading day."""
        with self._lock:
            prev_pnl = self._current_pnl
            self._current_pnl = Decimal("0")
            self._trade_count = 0
            self._last_reset = datetime.now()

        logger.info(f"Daily P&L reset (previous: {prev_pnl})")

    def update_limit(self, new_limit: Decimal) -> None:
        """Update daily loss limit."""
        should_trigger = False
        with self._lock:
            old_limit = self._daily_limit
            self._daily_limit = abs(new_limit)
            logger.info(f"Daily loss limit updated: {old_limit} -> {self._daily_limit}")

            # Check if already breached with new limit
            if self._current_pnl < -self._daily_limit:
                should_trigger = True

        # FIX-H8: Fire callback outside the lock to prevent deadlock
        if should_trigger:
            self._trigger_limit_breach()

    def statistics(self) -> dict[str, Any]:
        """Get tracker statistics."""
        return {
            "current_pnl": str(self._current_pnl),
            "daily_limit": str(self._daily_limit),
            "remaining_risk": str(self.remaining_risk),
            "trade_count": self._trade_count,
            "last_reset": self._last_reset.isoformat() if self._last_reset else None,
        }
