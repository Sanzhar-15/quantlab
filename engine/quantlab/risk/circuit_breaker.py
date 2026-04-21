"""
Circuit Breaker Implementation.

Provides automated trading halt when risk conditions are met.

Spec Reference: Technical Spec §11.1, Decision L74
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import TYPE_CHECKING
from typing import Any
from typing import Callable

if TYPE_CHECKING:
    from quantlab.logging.audit import AuditLog


logger = logging.getLogger(__name__)


class CircuitBreakerState(Enum):
    """Circuit breaker states."""

    CLOSED = "closed"  # Normal operation
    OPEN = "open"  # Trading halted
    HALF_OPEN = "half_open"  # Testing if safe to resume (not used currently)


class TriggerReason(Enum):
    """Reasons for circuit breaker trigger."""

    CONSECUTIVE_LOSSES = "consecutive_losses"
    DAILY_LOSS_LIMIT = "daily_loss_limit"
    EXPOSURE_BREACH = "exposure_breach"
    CONNECTION_LOST = "connection_lost"
    MANUAL = "manual"
    ERROR_RATE = "error_rate"
    MARKET_HALT = "market_halt"


@dataclass
class CircuitBreakerEvent:
    """Event when circuit breaker state changes."""

    previous_state: CircuitBreakerState
    new_state: CircuitBreakerState
    reason: TriggerReason | None
    message: str
    triggered_at: datetime
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "previous_state": self.previous_state.value,
            "new_state": self.new_state.value,
            "reason": self.reason.value if self.reason else None,
            "message": self.message,
            "triggered_at": self.triggered_at.isoformat(),
            "metadata": self.metadata,
        }


class CircuitBreaker:
    """
    Circuit breaker for automated trading halt.

    Triggers when:
    - Consecutive loss limit reached
    - Daily loss limit breached
    - Exposure limit breached
    - Connection lost to broker
    - Manual trigger

    CRITICAL: The circuit breaker NEVER auto-resets.
    User must explicitly acknowledge and reset.
    """

    def __init__(
        self,
        session_id: str = "",
        audit_log: "AuditLog | None" = None,
    ) -> None:
        self._session_id = session_id
        self._audit_log = audit_log

        # Thread safety lock
        self._lock = threading.Lock()

        self._state = CircuitBreakerState.CLOSED
        self._trigger_reason: TriggerReason | None = None
        self._trigger_message: str = ""
        self._triggered_at: datetime | None = None
        self._trigger_count = 0

        # Track all trigger events for diagnostics (not just first)
        self._trigger_history: list[dict[str, Any]] = []
        self._max_trigger_history = 100  # Limit history size

        # Callbacks
        self._state_callbacks: list[Callable[[CircuitBreakerEvent], None]] = []
        self._on_trip_callbacks: list[Callable[[TriggerReason, str], None]] = []

    def set_session_id(self, session_id: str) -> None:
        """Set the session ID for audit logging."""
        self._session_id = session_id

    def set_audit_log(self, audit_log: "AuditLog") -> None:
        """Set the audit log for compliance logging."""
        self._audit_log = audit_log

    @property
    def state(self) -> CircuitBreakerState:
        """Current circuit breaker state."""
        return self._state

    @property
    def is_open(self) -> bool:
        """Check if circuit breaker is open (trading halted)."""
        return self._state == CircuitBreakerState.OPEN

    @property
    def is_closed(self) -> bool:
        """Check if circuit breaker is closed (trading allowed)."""
        return self._state == CircuitBreakerState.CLOSED

    @property
    def trigger_reason(self) -> TriggerReason | None:
        """Reason for current trip (if open)."""
        return self._trigger_reason

    @property
    def trigger_history(self) -> list[dict[str, Any]]:
        """
        Get history of all trigger events (including additional triggers while open).

        Returns a copy to prevent external modification.
        """
        with self._lock:
            return list(self._trigger_history)

    def get_recent_triggers(self, count: int = 10) -> list[dict[str, Any]]:
        """Get the N most recent trigger events."""
        with self._lock:
            return list(self._trigger_history[-count:])

    @property
    def trigger_message(self) -> str:
        """Human-readable message for current trip."""
        return self._trigger_message

    def on_state_change(
        self,
        callback: Callable[[CircuitBreakerEvent], None],
    ) -> None:
        """Register callback for state changes."""
        self._state_callbacks.append(callback)

    def on_trip(
        self,
        callback: Callable[[TriggerReason, str], None],
    ) -> None:
        """Register callback for when circuit breaker trips."""
        self._on_trip_callbacks.append(callback)

    def trip(
        self,
        reason: TriggerReason,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """
        Trip the circuit breaker (halt trading).

        Thread-safe: uses lock to protect state modifications.
        Callbacks receive captured state to avoid race conditions.

        Args:
            reason: Why the breaker tripped
            message: Human-readable explanation
            metadata: Additional context
        """
        # Capture all data needed for callbacks inside lock
        with self._lock:
            # Always record trigger in history for diagnostics
            trigger_event = {
                "reason": reason.value,
                "message": message,
                "timestamp": datetime.now().isoformat(),
                "metadata": metadata or {},
                "state_at_trigger": self._state.value,
            }
            self._trigger_history.append(trigger_event)

            # Trim history if too large
            if len(self._trigger_history) > self._max_trigger_history:
                self._trigger_history = self._trigger_history[-self._max_trigger_history:]

            if self._state == CircuitBreakerState.OPEN:
                logger.warning(
                    f"Circuit breaker already open, additional trigger recorded: "
                    f"{reason.value} - {message}"
                )
                return

            previous_state = self._state
            self._state = CircuitBreakerState.OPEN
            self._trigger_reason = reason
            self._trigger_message = message
            self._triggered_at = datetime.now()
            self._trigger_count += 1

            # Capture values for callbacks while holding lock
            triggered_at = self._triggered_at
            trigger_count = self._trigger_count
            # Copy callback lists to avoid modification during iteration
            state_callbacks = list(self._state_callbacks)
            trip_callbacks = list(self._on_trip_callbacks)

        logger.warning(f"Circuit breaker TRIPPED: {reason.value} - {message}")

        event = CircuitBreakerEvent(
            previous_state=previous_state,
            new_state=CircuitBreakerState.OPEN,
            reason=reason,
            message=message,
            triggered_at=triggered_at,
            metadata=metadata or {},
        )

        # Audit log: circuit breaker trip
        if self._audit_log and self._session_id:
            try:
                from quantlab.logging.audit import AuditAction

                self._audit_log.log(
                    AuditAction.CIRCUIT_BREAKER_TRIP,
                    self._session_id,
                    {
                        "reason": reason.value,
                        "message": message,
                        "trigger_count": trigger_count,
                        **(metadata or {}),
                    },
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for circuit breaker trip: {e}")

        # Notify listeners (using captured callback lists)
        for callback in state_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"State change callback error: {e}")

        for callback in trip_callbacks:
            try:
                callback(reason, message)
            except Exception as e:
                logger.error(f"Trip callback error: {e}")

    def reset(self, acknowledged_by: str | None = None) -> bool:
        """
        Reset the circuit breaker (allow trading to resume).

        Thread-safe: uses lock to protect state modifications.
        Callbacks receive captured state to avoid race conditions.
        IMPORTANT: This should only be called after user acknowledgment.

        Args:
            acknowledged_by: User/process that acknowledged the reset

        Returns:
            True if reset was successful
        """
        reset_time = datetime.now()

        # Capture all data needed for callbacks inside lock
        with self._lock:
            if self._state == CircuitBreakerState.CLOSED:
                logger.debug("Circuit breaker already closed")
                return True

            previous_state = self._state
            prev_reason = self._trigger_reason

            self._state = CircuitBreakerState.CLOSED
            self._trigger_reason = None
            self._trigger_message = ""

            # Copy callback list to avoid modification during iteration
            state_callbacks = list(self._state_callbacks)

        reset_msg = f"Circuit breaker reset"
        if acknowledged_by:
            reset_msg += f" by {acknowledged_by}"

        logger.info(reset_msg)

        event = CircuitBreakerEvent(
            previous_state=previous_state,
            new_state=CircuitBreakerState.CLOSED,
            reason=None,
            message=reset_msg,
            triggered_at=reset_time,
            metadata={"acknowledged_by": acknowledged_by} if acknowledged_by else {},
        )

        # Audit log: circuit breaker reset
        if self._audit_log and self._session_id:
            try:
                from quantlab.logging.audit import AuditAction

                self._audit_log.log(
                    AuditAction.CIRCUIT_BREAKER_RESET,
                    self._session_id,
                    {
                        "acknowledged_by": acknowledged_by,
                        "previous_reason": prev_reason.value if prev_reason else None,
                    },
                    user_id=acknowledged_by,
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for circuit breaker reset: {e}")

        # Notify listeners (using captured callback list)
        for callback in state_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"State change callback error: {e}")

        return True

    def check_order_allowed(self) -> tuple[bool, str]:
        """
        Check if orders are allowed.

        Thread-safe: reads state under lock.

        Returns:
            Tuple of (allowed, reason_if_not)
        """
        with self._lock:
            if self._state == CircuitBreakerState.OPEN:
                return False, f"Trading halted: {self._trigger_message}"
            return True, ""

    def status(self) -> dict[str, Any]:
        """Get current status."""
        return {
            "state": self._state.value,
            "is_trading_allowed": self.is_closed,
            "trigger_reason": self._trigger_reason.value if self._trigger_reason else None,
            "trigger_message": self._trigger_message,
            "triggered_at": self._triggered_at.isoformat() if self._triggered_at else None,
            "trigger_count": self._trigger_count,
        }


class RiskManager:
    """
    Coordinates all risk controls.

    Integrates:
    - Circuit breaker
    - Exposure limits
    - Consecutive loss tracking
    - Daily loss limits
    """

    def __init__(
        self,
        circuit_breaker: CircuitBreaker,
        max_exposure: Decimal | None = None,
        consecutive_loss_limit: int = 3,
        daily_loss_limit: Decimal | None = None,
    ) -> None:
        self._circuit_breaker = circuit_breaker
        self._max_exposure = max_exposure
        self._consecutive_loss_limit = consecutive_loss_limit
        self._daily_loss_limit = daily_loss_limit

        # Import here to avoid circular imports
        from quantlab.risk.consecutive import ConsecutiveLossTracker
        from quantlab.risk.consecutive import DailyLossTracker
        from quantlab.risk.exposure import ExposureManager

        # Initialize components
        self._exposure_manager: ExposureManager | None = None
        if max_exposure:
            self._exposure_manager = ExposureManager(max_exposure)

        self._loss_tracker = ConsecutiveLossTracker(limit=consecutive_loss_limit)
        self._loss_tracker.on_threshold(self._handle_consecutive_loss)

        self._daily_tracker: DailyLossTracker | None = None
        if daily_loss_limit:
            self._daily_tracker = DailyLossTracker(daily_loss_limit)
            self._daily_tracker.on_limit_breach(self._handle_daily_loss)

    @property
    def circuit_breaker(self) -> CircuitBreaker:
        """Get circuit breaker."""
        return self._circuit_breaker

    @property
    def exposure_manager(self) -> Any:  # ExposureManager | None
        """Get exposure manager."""
        return self._exposure_manager

    def check_order_allowed(self) -> tuple[bool, str]:
        """Check if new orders are allowed."""
        return self._circuit_breaker.check_order_allowed()

    def record_trade_result(self, pnl: Decimal) -> None:
        """Record a closed trade result."""
        # Check consecutive losses
        self._loss_tracker.record_trade(pnl)

        # Check daily loss
        if self._daily_tracker:
            self._daily_tracker.record_pnl(pnl)

    def _handle_consecutive_loss(self, event: Any) -> None:
        """Handle consecutive loss threshold."""
        self._circuit_breaker.trip(
            TriggerReason.CONSECUTIVE_LOSSES,
            f"{event.consecutive_losses} consecutive losses (limit: {event.threshold})",
            metadata=event.to_dict(),
        )

    def _handle_daily_loss(self, current_pnl: Decimal, limit: Decimal) -> None:
        """Handle daily loss limit breach."""
        self._circuit_breaker.trip(
            TriggerReason.DAILY_LOSS_LIMIT,
            f"Daily loss {current_pnl} exceeds limit -{limit}",
            metadata={"current_pnl": str(current_pnl), "limit": str(limit)},
        )

    def reset_daily(self) -> None:
        """Reset daily trackers (new trading day)."""
        if self._daily_tracker:
            self._daily_tracker.reset_daily()

    def status(self) -> dict[str, Any]:
        """Get full risk status."""
        result: dict[str, Any] = {
            "circuit_breaker": self._circuit_breaker.status(),
            "consecutive_losses": self._loss_tracker.statistics(),
        }

        if self._exposure_manager:
            result["exposure"] = self._exposure_manager.snapshot().to_dict()

        if self._daily_tracker:
            result["daily_loss"] = self._daily_tracker.statistics()

        return result
