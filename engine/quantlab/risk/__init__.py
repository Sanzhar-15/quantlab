"""
Risk management module.

Provides:
- ExposureManager for thread-safe exposure reservation
- Circuit breakers for risk limit enforcement
- Consecutive loss tracking
- Daily loss limit tracking
- Order validation against risk limits

Spec Reference: Technical Spec §11.1, Decision E27, E28, L74
"""

from .circuit_breaker import CircuitBreaker
from .circuit_breaker import CircuitBreakerEvent
from .circuit_breaker import CircuitBreakerState
from .circuit_breaker import RiskManager
from .circuit_breaker import TriggerReason
from .consecutive import ConsecutiveLossTracker
from .consecutive import DailyLossTracker
from .consecutive import LossStreakEvent
from .consecutive import TradeResult
from .exposure import ExposureError
from .exposure import ExposureLimitBreach
from .exposure import ExposureManager
from .exposure import ExposureSnapshot
from .exposure import Fill
from .exposure import OrderRequest
from .exposure import OrderSide
from .exposure import ReservationExpired
from .exposure import ReservationHandle
from .exposure import ReservationNotFound
from .exposure import ReservationResult

__all__ = [
    # Exposure Management
    "ExposureManager",
    "ExposureSnapshot",
    "OrderRequest",
    "OrderSide",
    "Fill",
    "ReservationHandle",
    "ReservationResult",
    "ExposureError",
    "ExposureLimitBreach",
    "ReservationNotFound",
    "ReservationExpired",
    # Circuit Breaker
    "CircuitBreaker",
    "CircuitBreakerState",
    "CircuitBreakerEvent",
    "TriggerReason",
    "RiskManager",
    # Consecutive Loss Tracking
    "ConsecutiveLossTracker",
    "DailyLossTracker",
    "TradeResult",
    "LossStreakEvent",
]
