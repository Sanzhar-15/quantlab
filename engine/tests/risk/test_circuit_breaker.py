"""
Tests for circuit breaker implementation.
"""

import pytest

from quantlab.risk.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerEvent,
    CircuitBreakerState,
    TriggerReason,
)


class TestCircuitBreaker:
    """Tests for CircuitBreaker class."""

    def test_initial_state_closed(self):
        """Should start in CLOSED state."""
        breaker = CircuitBreaker()

        assert breaker.state == CircuitBreakerState.CLOSED
        assert breaker.is_closed is True
        assert breaker.is_open is False

    def test_trip_opens_breaker(self):
        """Trip should open circuit breaker."""
        breaker = CircuitBreaker()

        breaker.trip(
            TriggerReason.CONSECUTIVE_LOSSES,
            "3 consecutive losses",
        )

        assert breaker.state == CircuitBreakerState.OPEN
        assert breaker.is_open is True
        assert breaker.trigger_reason == TriggerReason.CONSECUTIVE_LOSSES

    def test_trip_callback(self):
        """Should call registered callbacks on trip."""
        breaker = CircuitBreaker()
        events = []

        def on_trip(reason, message):
            events.append((reason, message))

        breaker.on_trip(on_trip)
        breaker.trip(TriggerReason.DAILY_LOSS_LIMIT, "Limit reached")

        assert len(events) == 1
        assert events[0][0] == TriggerReason.DAILY_LOSS_LIMIT

    def test_state_change_callback(self):
        """Should notify state change callbacks."""
        breaker = CircuitBreaker()
        events = []

        def on_state_change(event: CircuitBreakerEvent):
            events.append(event)

        breaker.on_state_change(on_state_change)
        breaker.trip(TriggerReason.EXPOSURE_BREACH, "Limit exceeded")

        assert len(events) == 1
        assert events[0].previous_state == CircuitBreakerState.CLOSED
        assert events[0].new_state == CircuitBreakerState.OPEN

    def test_reset_closes_breaker(self):
        """Reset should close circuit breaker."""
        breaker = CircuitBreaker()

        breaker.trip(TriggerReason.MANUAL, "Test")
        breaker.reset(acknowledged_by="user@test.com")

        assert breaker.state == CircuitBreakerState.CLOSED
        assert breaker.is_closed is True
        assert breaker.trigger_reason is None

    def test_trip_when_already_open(self):
        """Should ignore trip when already open."""
        breaker = CircuitBreaker()
        events = []

        def on_trip(reason, message):
            events.append((reason, message))

        breaker.on_trip(on_trip)

        breaker.trip(TriggerReason.CONSECUTIVE_LOSSES, "First")
        breaker.trip(TriggerReason.DAILY_LOSS_LIMIT, "Second")

        assert len(events) == 1  # Only first trip counted
        assert breaker.trigger_reason == TriggerReason.CONSECUTIVE_LOSSES

    def test_check_order_allowed_closed(self):
        """Orders should be allowed when closed."""
        breaker = CircuitBreaker()

        allowed, reason = breaker.check_order_allowed()

        assert allowed is True
        assert reason == ""

    def test_check_order_allowed_open(self):
        """Orders should be blocked when open."""
        breaker = CircuitBreaker()
        breaker.trip(TriggerReason.MANUAL, "Testing block")

        allowed, reason = breaker.check_order_allowed()

        assert allowed is False
        assert "Testing block" in reason

    def test_status(self):
        """Should return status dictionary."""
        breaker = CircuitBreaker()
        breaker.trip(TriggerReason.CONNECTION_LOST, "Broker disconnected")

        status = breaker.status()

        assert status["state"] == "open"
        assert status["is_trading_allowed"] is False
        assert status["trigger_reason"] == "connection_lost"
        assert status["trigger_message"] == "Broker disconnected"

    def test_trigger_count(self):
        """Should track trigger count."""
        breaker = CircuitBreaker()

        breaker.trip(TriggerReason.MANUAL, "First")
        breaker.reset()
        breaker.trip(TriggerReason.MANUAL, "Second")

        status = breaker.status()
        assert status["trigger_count"] == 2


class TestTriggerReason:
    """Tests for TriggerReason enum."""

    def test_trigger_reasons(self):
        """Should have expected trigger reasons."""
        assert TriggerReason.CONSECUTIVE_LOSSES.value == "consecutive_losses"
        assert TriggerReason.DAILY_LOSS_LIMIT.value == "daily_loss_limit"
        assert TriggerReason.EXPOSURE_BREACH.value == "exposure_breach"
        assert TriggerReason.CONNECTION_LOST.value == "connection_lost"
        assert TriggerReason.MANUAL.value == "manual"
        assert TriggerReason.ERROR_RATE.value == "error_rate"
        assert TriggerReason.MARKET_HALT.value == "market_halt"


class TestCircuitBreakerEvent:
    """Tests for CircuitBreakerEvent dataclass."""

    def test_to_dict(self):
        """Should serialize to dictionary."""
        from datetime import datetime

        event = CircuitBreakerEvent(
            previous_state=CircuitBreakerState.CLOSED,
            new_state=CircuitBreakerState.OPEN,
            reason=TriggerReason.MANUAL,
            message="Test trip",
            triggered_at=datetime(2026, 1, 26, 14, 30, 0),
            metadata={"test": True},
        )

        data = event.to_dict()

        assert data["previous_state"] == "closed"
        assert data["new_state"] == "open"
        assert data["reason"] == "manual"
        assert data["message"] == "Test trip"
        assert data["metadata"]["test"] is True


class TestRiskManager:
    """Tests for RiskManager class."""

    def test_init_basic(self):
        """Should initialize with circuit breaker only."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)

        assert manager.circuit_breaker is breaker
        assert manager.exposure_manager is None
        assert manager._consecutive_loss_limit == 3
        assert manager._daily_loss_limit is None

    def test_init_with_max_exposure(self):
        """Should initialize with exposure manager."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, max_exposure=Decimal("100000"))

        assert manager.exposure_manager is not None

    def test_init_with_consecutive_loss_limit(self):
        """Should initialize with custom consecutive loss limit."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, consecutive_loss_limit=5)

        assert manager._consecutive_loss_limit == 5

    def test_init_with_daily_loss_limit(self):
        """Should initialize with daily loss tracker."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, daily_loss_limit=Decimal("5000"))

        assert manager._daily_tracker is not None

    def test_circuit_breaker_property(self):
        """Should return circuit breaker."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)

        assert manager.circuit_breaker is breaker

    def test_exposure_manager_property_none(self):
        """Should return None when no exposure limit set."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)

        assert manager.exposure_manager is None

    def test_exposure_manager_property_set(self):
        """Should return exposure manager when configured."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, max_exposure=Decimal("50000"))

        assert manager.exposure_manager is not None

    def test_check_order_allowed_when_closed(self):
        """Should allow orders when circuit breaker closed."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)

        allowed, reason = manager.check_order_allowed()

        assert allowed is True
        assert reason == ""

    def test_check_order_allowed_when_open(self):
        """Should block orders when circuit breaker open."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        breaker.trip(TriggerReason.MANUAL, "Test halt")
        manager = RiskManager(breaker)

        allowed, reason = manager.check_order_allowed()

        assert allowed is False
        assert "Test halt" in reason

    def test_record_trade_result_profit(self):
        """Should record profitable trade."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)

        # Record profitable trade
        manager.record_trade_result(Decimal("100"))

        # Circuit breaker should remain closed
        assert breaker.is_closed is True

    def test_record_trade_result_single_loss(self):
        """Should record loss without tripping breaker."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, consecutive_loss_limit=3)

        # Record single loss
        manager.record_trade_result(Decimal("-50"))

        # Circuit breaker should remain closed
        assert breaker.is_closed is True

    def test_record_trade_result_consecutive_losses_trip(self):
        """Should trip breaker after consecutive losses."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, consecutive_loss_limit=3)

        # Record consecutive losses
        manager.record_trade_result(Decimal("-50"))
        manager.record_trade_result(Decimal("-30"))
        manager.record_trade_result(Decimal("-20"))

        # Circuit breaker should be open
        assert breaker.is_open is True
        assert breaker.trigger_reason == TriggerReason.CONSECUTIVE_LOSSES

    def test_record_trade_result_losses_reset_by_profit(self):
        """Should reset consecutive count after profit."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, consecutive_loss_limit=3)

        # Two losses
        manager.record_trade_result(Decimal("-50"))
        manager.record_trade_result(Decimal("-30"))
        # One profit resets the count
        manager.record_trade_result(Decimal("100"))
        # Two more losses
        manager.record_trade_result(Decimal("-50"))
        manager.record_trade_result(Decimal("-30"))

        # Circuit breaker should still be closed
        assert breaker.is_closed is True

    def test_record_trade_result_daily_loss_trip(self):
        """Should trip breaker when daily loss limit exceeded."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(
            breaker,
            consecutive_loss_limit=10,  # High to not trigger
            daily_loss_limit=Decimal("1000"),
        )

        # Record losses exceeding daily limit
        manager.record_trade_result(Decimal("-500"))
        manager.record_trade_result(Decimal("-600"))

        # Circuit breaker should be open
        assert breaker.is_open is True
        assert breaker.trigger_reason == TriggerReason.DAILY_LOSS_LIMIT

    def test_record_trade_result_daily_loss_with_profits(self):
        """Should track net daily pnl including profits."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(
            breaker,
            consecutive_loss_limit=10,
            daily_loss_limit=Decimal("1000"),
        )

        # Mix of trades - net should be -500
        manager.record_trade_result(Decimal("-800"))
        manager.record_trade_result(Decimal("300"))

        # Circuit breaker should still be closed
        assert breaker.is_closed is True

    def test_reset_daily(self):
        """Should reset daily tracker."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(
            breaker,
            daily_loss_limit=Decimal("1000"),
        )

        # Record some losses
        manager.record_trade_result(Decimal("-500"))

        # Reset daily
        manager.reset_daily()

        # After reset, should be able to lose another 1000
        manager.record_trade_result(Decimal("-900"))
        assert breaker.is_closed is True

        # Now exceeding limit trips breaker
        manager.record_trade_result(Decimal("-200"))
        assert breaker.is_open is True

    def test_reset_daily_no_tracker(self):
        """Should handle reset when no daily tracker configured."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)  # No daily limit

        # Should not raise
        manager.reset_daily()

    def test_status_basic(self):
        """Should return basic status."""
        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker)

        status = manager.status()

        assert "circuit_breaker" in status
        assert "consecutive_losses" in status
        assert status["circuit_breaker"]["state"] == "closed"

    def test_status_with_exposure_manager(self):
        """Should include exposure in status."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, max_exposure=Decimal("100000"))

        status = manager.status()

        assert "exposure" in status

    def test_status_with_daily_tracker(self):
        """Should include daily loss in status."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, daily_loss_limit=Decimal("5000"))

        status = manager.status()

        assert "daily_loss" in status

    def test_status_after_losses(self):
        """Should track statistics in status."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(breaker, consecutive_loss_limit=5)

        # Record some trades
        manager.record_trade_result(Decimal("-100"))
        manager.record_trade_result(Decimal("-50"))

        status = manager.status()

        assert status["consecutive_losses"]["current_streak"] == 2

    def test_status_full_config(self):
        """Should include all components in status."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(
            breaker,
            max_exposure=Decimal("100000"),
            consecutive_loss_limit=5,
            daily_loss_limit=Decimal("5000"),
        )

        status = manager.status()

        assert "circuit_breaker" in status
        assert "consecutive_losses" in status
        assert "exposure" in status
        assert "daily_loss" in status

    def test_consecutive_loss_handler_metadata(self):
        """Should include metadata when tripping for consecutive losses."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        events = []

        def on_state_change(event: CircuitBreakerEvent):
            events.append(event)

        breaker.on_state_change(on_state_change)

        manager = RiskManager(breaker, consecutive_loss_limit=2)

        # Trigger consecutive loss
        manager.record_trade_result(Decimal("-100"))
        manager.record_trade_result(Decimal("-50"))

        assert len(events) == 1
        assert events[0].reason == TriggerReason.CONSECUTIVE_LOSSES
        assert "consecutive_losses" in events[0].metadata

    def test_daily_loss_handler_metadata(self):
        """Should include metadata when tripping for daily loss."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        events = []

        def on_state_change(event: CircuitBreakerEvent):
            events.append(event)

        breaker.on_state_change(on_state_change)

        manager = RiskManager(
            breaker,
            consecutive_loss_limit=10,
            daily_loss_limit=Decimal("500"),
        )

        # Trigger daily loss
        manager.record_trade_result(Decimal("-600"))

        assert len(events) == 1
        assert events[0].reason == TriggerReason.DAILY_LOSS_LIMIT
        assert "current_pnl" in events[0].metadata
        assert "limit" in events[0].metadata

    def test_manager_integration_multiple_triggers(self):
        """Should handle which trigger fires first."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        manager = RiskManager(
            breaker,
            consecutive_loss_limit=2,
            daily_loss_limit=Decimal("10000"),  # High to not trigger first
        )

        # Two losses - consecutive should trip first
        manager.record_trade_result(Decimal("-100"))
        manager.record_trade_result(Decimal("-100"))

        assert breaker.trigger_reason == TriggerReason.CONSECUTIVE_LOSSES

    def test_manager_preserves_breaker_state(self):
        """Manager should work with already-tripped breaker."""
        from decimal import Decimal

        from quantlab.risk.circuit_breaker import RiskManager

        breaker = CircuitBreaker()
        breaker.trip(TriggerReason.MANUAL, "Pre-existing halt")

        manager = RiskManager(breaker)

        # Recording trades should not error
        manager.record_trade_result(Decimal("-100"))

        # Breaker should still show original reason
        assert breaker.trigger_reason == TriggerReason.MANUAL
