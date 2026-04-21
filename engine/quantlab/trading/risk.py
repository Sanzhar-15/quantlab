"""
Risk Management System.

Monitors positions and orders against risk limits.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

import logging
import threading
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from datetime import timedelta
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable

from .orders import Order


logger = logging.getLogger(__name__)
from .orders import OrderManager
from .positions import Position
from .positions import PositionTracker


class RiskLevel(Enum):
    """Risk violation severity level."""

    INFO = "info"  # Informational, no action needed
    WARNING = "warning"  # Warning, caution advised
    CRITICAL = "critical"  # Critical, action required
    BREACH = "breach"  # Hard limit breach, trading halted


class RiskViolationType(Enum):
    """Types of risk violations."""

    POSITION_SIZE = "position_size"
    DAILY_LOSS = "daily_loss"
    MAX_DRAWDOWN = "max_drawdown"
    OPEN_ORDERS = "open_orders"
    CONCENTRATION = "concentration"
    MARGIN = "margin"
    TRADING_HALTED = "trading_halted"


@dataclass
class RiskLimits:
    """
    Risk limit configuration for a session.

    Defines maximum allowable values for various risk metrics.
    """

    # Position limits
    max_position_size: Decimal = Decimal("10000")  # Max value per position
    max_position_quantity: Decimal = Decimal("1000")  # Max shares per position
    max_total_exposure: Decimal = Decimal("100000")  # Total portfolio exposure

    # Loss limits
    daily_loss_limit: Decimal = Decimal("1000")  # Max daily loss
    max_drawdown_percent: float = 20.0  # Max drawdown percentage

    # Order limits
    max_open_orders: int = 10  # Max concurrent open orders
    max_order_size: Decimal = Decimal("1000")  # Max single order value

    # Concentration limits
    max_concentration_percent: float = 25.0  # Max % in single position

    # Margin limits (for live trading)
    min_margin_ratio: float = 0.25  # Minimum margin ratio

    # Warning thresholds (% of limit before warning)
    warning_threshold: float = 0.8  # 80% of limit triggers warning

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "maxPositionSize": float(self.max_position_size),
            "maxPositionQuantity": float(self.max_position_quantity),
            "maxTotalExposure": float(self.max_total_exposure),
            "dailyLossLimit": float(self.daily_loss_limit),
            "maxDrawdownPercent": self.max_drawdown_percent,
            "maxOpenOrders": self.max_open_orders,
            "maxOrderSize": float(self.max_order_size),
            "maxConcentrationPercent": self.max_concentration_percent,
            "minMarginRatio": self.min_margin_ratio,
            "warningThreshold": self.warning_threshold,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RiskLimits":
        """Create from dictionary."""
        return cls(
            max_position_size=Decimal(str(data.get("maxPositionSize", 10000))),
            max_position_quantity=Decimal(str(data.get("maxPositionQuantity", 1000))),
            max_total_exposure=Decimal(str(data.get("maxTotalExposure", 100000))),
            daily_loss_limit=Decimal(str(data.get("dailyLossLimit", 1000))),
            max_drawdown_percent=data.get("maxDrawdownPercent", 20.0),
            max_open_orders=data.get("maxOpenOrders", 10),
            max_order_size=Decimal(str(data.get("maxOrderSize", 1000))),
            max_concentration_percent=data.get("maxConcentrationPercent", 25.0),
            min_margin_ratio=data.get("minMarginRatio", 0.25),
            warning_threshold=data.get("warningThreshold", 0.8),
        )


@dataclass
class RiskViolation:
    """A risk limit violation."""

    violation_type: RiskViolationType
    level: RiskLevel
    message: str
    current_value: float
    limit_value: float
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    session_id: str | None = None
    symbol: str | None = None

    @property
    def utilization(self) -> float:
        """Get utilization as percentage of limit."""
        if self.limit_value == 0:
            return 0.0
        return (self.current_value / self.limit_value) * 100

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "violationType": self.violation_type.value,
            "level": self.level.value,
            "message": self.message,
            "currentValue": self.current_value,
            "limitValue": self.limit_value,
            "utilization": self.utilization,
            "timestamp": self.timestamp.isoformat(),
            "sessionId": self.session_id,
            "symbol": self.symbol,
        }


@dataclass
class RiskStatus:
    """Current risk status for a session."""

    session_id: str
    is_trading_allowed: bool = True
    violations: list[RiskViolation] = field(default_factory=list)

    # Current metrics
    total_exposure: Decimal = Decimal("0")
    daily_pnl: Decimal = Decimal("0")
    max_drawdown: float = 0.0
    open_orders_count: int = 0

    # Utilization (% of limits used)
    exposure_utilization: float = 0.0
    daily_loss_utilization: float = 0.0
    drawdown_utilization: float = 0.0
    orders_utilization: float = 0.0

    @property
    def highest_violation_level(self) -> RiskLevel | None:
        """Get the highest severity violation level."""
        if not self.violations:
            return None

        level_order = [
            RiskLevel.INFO,
            RiskLevel.WARNING,
            RiskLevel.CRITICAL,
            RiskLevel.BREACH,
        ]

        highest = RiskLevel.INFO
        for violation in self.violations:
            if level_order.index(violation.level) > level_order.index(highest):
                highest = violation.level

        return highest

    @property
    def has_critical_violations(self) -> bool:
        """Check if there are critical or breach violations."""
        return any(
            v.level in (RiskLevel.CRITICAL, RiskLevel.BREACH)
            for v in self.violations
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "sessionId": self.session_id,
            "isTradingAllowed": self.is_trading_allowed,
            "violations": [v.to_dict() for v in self.violations],
            "totalExposure": float(self.total_exposure),
            "dailyPnl": float(self.daily_pnl),
            "maxDrawdown": self.max_drawdown,
            "openOrdersCount": self.open_orders_count,
            "exposureUtilization": self.exposure_utilization,
            "dailyLossUtilization": self.daily_loss_utilization,
            "drawdownUtilization": self.drawdown_utilization,
            "ordersUtilization": self.orders_utilization,
            "highestViolationLevel": (
                self.highest_violation_level.value
                if self.highest_violation_level else None
            ),
            "hasCriticalViolations": self.has_critical_violations,
        }


class RiskMonitor:
    """
    Monitors trading activity against risk limits.

    Tracks positions, orders, and P&L to detect limit violations.
    """

    def __init__(
        self,
        position_tracker: PositionTracker,
        order_manager: OrderManager,
    ) -> None:
        """
        Initialize risk monitor.

        Args:
            position_tracker: Position tracker instance
            order_manager: Order manager instance
        """
        self._position_tracker = position_tracker
        self._order_manager = order_manager

        # Limits per session
        self._limits: dict[str, RiskLimits] = {}

        # Daily P&L tracking (reset at start of day)
        self._daily_pnl: dict[str, Decimal] = {}
        self._daily_high_water: dict[str, Decimal] = {}
        self._last_reset: dict[str, datetime] = {}

        # Trading halted flag
        self._trading_halted: dict[str, bool] = {}

        # Thread safety
        self._lock = threading.Lock()

        # Event callbacks
        self._on_violation: list[Callable[[RiskViolation], None]] = []
        self._on_trading_halted: list[Callable[[str, str], None]] = []

    def set_limits(self, session_id: str, limits: RiskLimits) -> None:
        """Set risk limits for a session."""
        with self._lock:
            self._limits[session_id] = limits
            if session_id not in self._daily_pnl:
                self._daily_pnl[session_id] = Decimal("0")
                self._daily_high_water[session_id] = Decimal("0")
                self._last_reset[session_id] = datetime.now(timezone.utc)
                self._trading_halted[session_id] = False

    def get_limits(self, session_id: str) -> RiskLimits:
        """Get risk limits for a session."""
        with self._lock:
            return self._limits.get(session_id, RiskLimits())

    def update_daily_pnl(
        self,
        session_id: str,
        realized_pnl: Decimal,
    ) -> None:
        """
        Update daily P&L for a session.

        Args:
            session_id: Session ID
            realized_pnl: Realized P&L to add
        """
        violation = None

        with self._lock:
            if session_id not in self._daily_pnl:
                self._daily_pnl[session_id] = Decimal("0")
                self._daily_high_water[session_id] = Decimal("0")

            self._daily_pnl[session_id] += realized_pnl

            # Update high water mark
            if self._daily_pnl[session_id] > self._daily_high_water[session_id]:
                self._daily_high_water[session_id] = self._daily_pnl[session_id]

            # Check if daily loss limit is breached and halt trading if so
            limits = self._limits.get(session_id, RiskLimits())
            if self._daily_pnl[session_id] < -limits.daily_loss_limit:
                self._trading_halted[session_id] = True
                # Prepare violation to notify after releasing lock
                violation = RiskViolation(
                    violation_type=RiskViolationType.DAILY_LOSS,
                    level=RiskLevel.BREACH,
                    message=f"Daily loss {float(self._daily_pnl[session_id]):.2f} exceeds limit {float(limits.daily_loss_limit):.2f}",
                    current_value=float(abs(self._daily_pnl[session_id])),
                    limit_value=float(limits.daily_loss_limit),
                    session_id=session_id,
                )

        # Notify outside the lock to avoid potential deadlocks
        if violation:
            self._notify_violation(violation)

    def reset_daily_metrics(self, session_id: str) -> None:
        """Reset daily P&L tracking for a session."""
        with self._lock:
            self._daily_pnl[session_id] = Decimal("0")
            self._daily_high_water[session_id] = Decimal("0")
            self._last_reset[session_id] = datetime.now(timezone.utc)

    def check_order(
        self,
        session_id: str,
        order: Order,
    ) -> list[RiskViolation]:
        """
        Check if an order would violate risk limits.

        Args:
            session_id: Session ID
            order: Order to check

        Returns:
            List of violations (empty if order is allowed)
        """
        violations = []
        limits = self.get_limits(session_id)

        # Check if trading is halted
        if self._trading_halted.get(session_id, False):
            violations.append(RiskViolation(
                violation_type=RiskViolationType.TRADING_HALTED,
                level=RiskLevel.BREACH,
                message="Trading is halted for this session",
                current_value=1,
                limit_value=0,
                session_id=session_id,
            ))
            return violations

        # Check order size
        order_value = float(order.notional_value)
        max_order = float(limits.max_order_size)
        if order_value > max_order:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.POSITION_SIZE,
                level=RiskLevel.BREACH,
                message=f"Order size {order_value:.2f} exceeds limit {max_order:.2f}",
                current_value=order_value,
                limit_value=max_order,
                session_id=session_id,
                symbol=order.symbol,
            ))

        # Check open orders count
        open_orders = self._order_manager.get_open_orders(session_id)
        if len(open_orders) >= limits.max_open_orders:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.OPEN_ORDERS,
                level=RiskLevel.BREACH,
                message=f"Max open orders ({limits.max_open_orders}) reached",
                current_value=len(open_orders),
                limit_value=limits.max_open_orders,
                session_id=session_id,
            ))

        # Check if this would exceed position limits
        position = self._position_tracker.get_position(session_id, order.symbol)
        current_exposure = Decimal("0")
        if position:
            current_exposure = position.market_value

        new_exposure = current_exposure + order.notional_value
        if new_exposure > limits.max_position_size:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.POSITION_SIZE,
                level=RiskLevel.WARNING,
                message=f"Position would exceed limit: {float(new_exposure):.2f}",
                current_value=float(new_exposure),
                limit_value=float(limits.max_position_size),
                session_id=session_id,
                symbol=order.symbol,
            ))

        # Notify violations
        for violation in violations:
            self._notify_violation(violation)

        return violations

    def get_status(self, session_id: str) -> RiskStatus:
        """
        Get current risk status for a session.

        Args:
            session_id: Session ID

        Returns:
            Risk status with current metrics and violations
        """
        limits = self.get_limits(session_id)
        status = RiskStatus(session_id=session_id)

        # Check if trading is halted
        status.is_trading_allowed = not self._trading_halted.get(session_id, False)

        # Get position summary
        summary = self._position_tracker.get_summary(session_id)
        status.total_exposure = summary.total_market_value

        # Calculate exposure utilization
        if limits.max_total_exposure > 0:
            status.exposure_utilization = (
                float(status.total_exposure / limits.max_total_exposure) * 100
            )

        # Get daily P&L
        with self._lock:
            status.daily_pnl = self._daily_pnl.get(session_id, Decimal("0"))
            high_water = self._daily_high_water.get(session_id, Decimal("0"))

        # Calculate drawdown
        if high_water > 0:
            drawdown = high_water - status.daily_pnl
            status.max_drawdown = float(drawdown / high_water) * 100

        # Calculate daily loss utilization
        if limits.daily_loss_limit > 0 and status.daily_pnl < 0:
            status.daily_loss_utilization = (
                float(abs(status.daily_pnl) / limits.daily_loss_limit) * 100
            )

        # Calculate drawdown utilization
        if limits.max_drawdown_percent > 0:
            status.drawdown_utilization = (
                status.max_drawdown / limits.max_drawdown_percent
            ) * 100

        # Get open orders count
        open_orders = self._order_manager.get_open_orders(session_id)
        status.open_orders_count = len(open_orders)

        # Calculate orders utilization
        if limits.max_open_orders > 0:
            status.orders_utilization = (
                status.open_orders_count / limits.max_open_orders
            ) * 100

        # Check for violations
        status.violations = self._check_all_limits(session_id, limits, status)

        return status

    def _check_all_limits(
        self,
        session_id: str,
        limits: RiskLimits,
        status: RiskStatus,
    ) -> list[RiskViolation]:
        """Check all risk limits and return violations."""
        violations = []

        # Check exposure
        exposure_pct = status.exposure_utilization / 100
        if exposure_pct >= 1.0:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.POSITION_SIZE,
                level=RiskLevel.BREACH,
                message="Total exposure exceeds limit",
                current_value=float(status.total_exposure),
                limit_value=float(limits.max_total_exposure),
                session_id=session_id,
            ))
        elif exposure_pct >= limits.warning_threshold:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.POSITION_SIZE,
                level=RiskLevel.WARNING,
                message="Total exposure approaching limit",
                current_value=float(status.total_exposure),
                limit_value=float(limits.max_total_exposure),
                session_id=session_id,
            ))

        # Check daily loss
        if status.daily_pnl < 0:
            loss_pct = status.daily_loss_utilization / 100
            if loss_pct >= 1.0:
                violations.append(RiskViolation(
                    violation_type=RiskViolationType.DAILY_LOSS,
                    level=RiskLevel.BREACH,
                    message="Daily loss limit exceeded",
                    current_value=float(abs(status.daily_pnl)),
                    limit_value=float(limits.daily_loss_limit),
                    session_id=session_id,
                ))
                # Halt trading on daily loss breach
                self._halt_trading(session_id, "Daily loss limit exceeded")
            elif loss_pct >= limits.warning_threshold:
                violations.append(RiskViolation(
                    violation_type=RiskViolationType.DAILY_LOSS,
                    level=RiskLevel.WARNING,
                    message="Daily loss approaching limit",
                    current_value=float(abs(status.daily_pnl)),
                    limit_value=float(limits.daily_loss_limit),
                    session_id=session_id,
                ))

        # Check drawdown
        dd_pct = status.drawdown_utilization / 100
        if dd_pct >= 1.0:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.MAX_DRAWDOWN,
                level=RiskLevel.CRITICAL,
                message="Max drawdown exceeded",
                current_value=status.max_drawdown,
                limit_value=limits.max_drawdown_percent,
                session_id=session_id,
            ))
        elif dd_pct >= limits.warning_threshold:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.MAX_DRAWDOWN,
                level=RiskLevel.WARNING,
                message="Drawdown approaching limit",
                current_value=status.max_drawdown,
                limit_value=limits.max_drawdown_percent,
                session_id=session_id,
            ))

        # Check open orders
        orders_pct = status.orders_utilization / 100
        if orders_pct >= 1.0:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.OPEN_ORDERS,
                level=RiskLevel.BREACH,
                message="Max open orders reached",
                current_value=status.open_orders_count,
                limit_value=limits.max_open_orders,
                session_id=session_id,
            ))
        elif orders_pct >= limits.warning_threshold:
            violations.append(RiskViolation(
                violation_type=RiskViolationType.OPEN_ORDERS,
                level=RiskLevel.INFO,
                message="Open orders approaching limit",
                current_value=status.open_orders_count,
                limit_value=limits.max_open_orders,
                session_id=session_id,
            ))

        # Check concentration
        positions = self._position_tracker.get_positions_for_session(session_id)
        for position in positions:
            if status.total_exposure > 0:
                concentration = (
                    float(position.market_value / status.total_exposure) * 100
                )
                if concentration > limits.max_concentration_percent:
                    violations.append(RiskViolation(
                        violation_type=RiskViolationType.CONCENTRATION,
                        level=RiskLevel.WARNING,
                        message=f"Position concentration too high: {concentration:.1f}%",
                        current_value=concentration,
                        limit_value=limits.max_concentration_percent,
                        session_id=session_id,
                        symbol=position.symbol,
                    ))

        return violations

    def _halt_trading(self, session_id: str, reason: str) -> None:
        """Halt trading for a session."""
        with self._lock:
            self._trading_halted[session_id] = True

        for callback in self._on_trading_halted:
            try:
                callback(session_id, reason)
            except Exception as e:
                logger.warning(
                    f"Trading halted callback failed for session {session_id}: {e}",
                    exc_info=True,
                )

    def resume_trading(self, session_id: str) -> None:
        """Resume trading for a session."""
        with self._lock:
            self._trading_halted[session_id] = False

    def is_trading_allowed(self, session_id: str) -> bool:
        """Check if trading is allowed for a session."""
        return not self._trading_halted.get(session_id, False)

    def clear_session(self, session_id: str) -> None:
        """Clear all risk data for a session."""
        with self._lock:
            self._limits.pop(session_id, None)
            self._daily_pnl.pop(session_id, None)
            self._daily_high_water.pop(session_id, None)
            self._last_reset.pop(session_id, None)
            self._trading_halted.pop(session_id, None)

    def on_violation(
        self,
        callback: Callable[[RiskViolation], None],
    ) -> None:
        """Register violation callback."""
        self._on_violation.append(callback)

    def on_trading_halted(
        self,
        callback: Callable[[str, str], None],
    ) -> None:
        """Register trading halted callback."""
        self._on_trading_halted.append(callback)

    def _notify_violation(self, violation: RiskViolation) -> None:
        """Notify violation listeners."""
        for callback in self._on_violation:
            try:
                callback(violation)
            except Exception as e:
                logger.warning(
                    f"Risk violation callback failed: {e}",
                    exc_info=True,
                )
