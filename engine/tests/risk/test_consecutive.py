"""
Tests for consecutive loss tracking.
"""

from decimal import Decimal

import pytest

from quantlab.risk.consecutive import (
    ConsecutiveLossTracker,
    DailyLossTracker,
    LossStreakEvent,
)


class TestConsecutiveLossTracker:
    """Tests for ConsecutiveLossTracker class."""

    def test_init_default_limit(self):
        """Should initialize with default limit of 3."""
        tracker = ConsecutiveLossTracker()

        assert tracker.limit == 3
        assert tracker.consecutive_losses == 0

    def test_init_custom_limit(self):
        """Should accept custom limit."""
        tracker = ConsecutiveLossTracker(limit=5)

        assert tracker.limit == 5

    def test_record_loss(self):
        """Should increment consecutive losses."""
        tracker = ConsecutiveLossTracker(limit=5)

        tracker.record_trade(Decimal("-100"))

        assert tracker.consecutive_losses == 1

    def test_record_win_resets(self):
        """Win should reset consecutive losses."""
        tracker = ConsecutiveLossTracker(limit=5)

        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("50"))

        assert tracker.consecutive_losses == 0

    def test_trigger_at_limit(self):
        """Should trigger circuit breaker at limit."""
        tracker = ConsecutiveLossTracker(limit=3)
        triggered = False

        def on_trigger(event: LossStreakEvent):
            nonlocal triggered
            triggered = True

        tracker.on_threshold(on_trigger)

        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))
        result = tracker.record_trade(Decimal("-100"))

        assert result is True
        assert triggered is True

    def test_no_trigger_before_limit(self):
        """Should not trigger before reaching limit."""
        tracker = ConsecutiveLossTracker(limit=3)

        result1 = tracker.record_trade(Decimal("-100"))
        result2 = tracker.record_trade(Decimal("-100"))

        assert result1 is False
        assert result2 is False
        assert tracker.consecutive_losses == 2

    def test_total_loss_tracking(self):
        """Should track total loss in streak."""
        tracker = ConsecutiveLossTracker(limit=5)

        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-150"))
        tracker.record_trade(Decimal("-200"))

        assert tracker.total_loss_in_streak == Decimal("450")

    def test_win_resets_total_loss(self):
        """Win should reset total loss tracking."""
        tracker = ConsecutiveLossTracker(limit=5)

        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-150"))
        tracker.record_trade(Decimal("50"))

        assert tracker.total_loss_in_streak == Decimal("0")

    def test_max_streak_tracking(self):
        """Should track maximum streak."""
        tracker = ConsecutiveLossTracker(limit=10)

        # First streak of 3
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("50"))  # Reset

        # Second streak of 2
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))

        assert tracker.max_streak == 3
        assert tracker.consecutive_losses == 2

    def test_manual_reset(self):
        """Should allow manual reset."""
        tracker = ConsecutiveLossTracker(limit=5)

        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))

        tracker.reset()

        assert tracker.consecutive_losses == 0
        assert tracker.total_loss_in_streak == Decimal("0")

    def test_update_limit(self):
        """Should update limit and check if already breached."""
        tracker = ConsecutiveLossTracker(limit=5)
        triggered = False

        def on_trigger(event: LossStreakEvent):
            nonlocal triggered
            triggered = True

        tracker.on_threshold(on_trigger)

        # Record 3 losses
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))

        # Lower limit to 3 should trigger
        tracker.update_limit(3)

        assert triggered is True

    def test_statistics(self):
        """Should return statistics."""
        tracker = ConsecutiveLossTracker(limit=3)

        tracker.record_trade(Decimal("-100"))
        tracker.record_trade(Decimal("-100"))

        stats = tracker.statistics()

        assert stats["current_streak"] == 2
        assert stats["limit"] == 3
        assert stats["total_trades"] == 2


class TestDailyLossTracker:
    """Tests for DailyLossTracker class."""

    def test_init(self):
        """Should initialize with daily limit."""
        tracker = DailyLossTracker(daily_limit=Decimal("1000"))

        assert tracker.daily_limit == Decimal("1000")
        assert tracker.current_pnl == Decimal("0")

    def test_record_loss(self):
        """Should track losses."""
        tracker = DailyLossTracker(daily_limit=Decimal("1000"))

        tracker.record_pnl(Decimal("-500"))

        assert tracker.current_pnl == Decimal("-500")
        assert tracker.remaining_risk == Decimal("500")

    def test_record_profit(self):
        """Should track profits."""
        tracker = DailyLossTracker(daily_limit=Decimal("1000"))

        tracker.record_pnl(Decimal("500"))

        assert tracker.current_pnl == Decimal("500")
        assert tracker.remaining_risk == Decimal("1000")  # Full limit available

    def test_trigger_at_limit(self):
        """Should trigger when daily limit breached."""
        tracker = DailyLossTracker(daily_limit=Decimal("1000"))
        triggered = False

        def on_breach(pnl, limit):
            nonlocal triggered
            triggered = True

        tracker.on_limit_breach(on_breach)

        tracker.record_pnl(Decimal("-500"))
        result = tracker.record_pnl(Decimal("-600"))  # Total -1100

        assert result is True
        assert triggered is True

    def test_reset_daily(self):
        """Should reset for new trading day."""
        tracker = DailyLossTracker(daily_limit=Decimal("1000"))

        tracker.record_pnl(Decimal("-500"))
        tracker.reset_daily()

        assert tracker.current_pnl == Decimal("0")
        assert tracker.remaining_risk == Decimal("1000")

    def test_statistics(self):
        """Should return statistics."""
        tracker = DailyLossTracker(daily_limit=Decimal("1000"))

        tracker.record_pnl(Decimal("-300"))
        tracker.record_pnl(Decimal("100"))

        stats = tracker.statistics()

        assert stats["current_pnl"] == "-200"
        assert stats["daily_limit"] == "1000"
        assert stats["trade_count"] == 2
