"""
Tests for Risk Management module.

Tests RiskLimits, RiskMonitor, and related classes.
"""

import pytest
from decimal import Decimal

from quantlab.trading import (
    RiskLevel,
    RiskViolationType,
    RiskLimits,
    RiskViolation,
    RiskStatus,
    RiskMonitor,
    PositionTracker,
    OrderManager,
    Order,
    OrderSide,
    OrderType,
    OrderRequest,
)


class TestRiskEnums:
    """Tests for risk-related enums."""

    def test_risk_level_values(self) -> None:
        """Test risk level values."""
        assert RiskLevel.INFO.value == "info"
        assert RiskLevel.WARNING.value == "warning"
        assert RiskLevel.CRITICAL.value == "critical"
        assert RiskLevel.BREACH.value == "breach"

    def test_violation_type_values(self) -> None:
        """Test violation type values."""
        assert RiskViolationType.POSITION_SIZE.value == "position_size"
        assert RiskViolationType.DAILY_LOSS.value == "daily_loss"
        assert RiskViolationType.MAX_DRAWDOWN.value == "max_drawdown"


class TestRiskLimits:
    """Tests for RiskLimits dataclass."""

    def test_creation(self) -> None:
        """Test limits creation."""
        limits = RiskLimits(
            max_position_size=Decimal("5000"),
            daily_loss_limit=Decimal("500"),
        )
        assert limits.max_position_size == Decimal("5000")
        assert limits.daily_loss_limit == Decimal("500")

    def test_defaults(self) -> None:
        """Test default values."""
        limits = RiskLimits()

        assert limits.max_position_size == Decimal("10000")
        assert limits.max_open_orders == 10
        assert limits.warning_threshold == 0.8

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        limits = RiskLimits(
            max_position_size=Decimal("5000"),
            max_drawdown_percent=15.0,
        )
        d = limits.to_dict()

        assert d["maxPositionSize"] == 5000.0
        assert d["maxDrawdownPercent"] == 15.0

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "maxPositionSize": 8000,
            "dailyLossLimit": 800,
            "maxOpenOrders": 5,
        }
        limits = RiskLimits.from_dict(data)

        assert limits.max_position_size == Decimal("8000")
        assert limits.daily_loss_limit == Decimal("800")
        assert limits.max_open_orders == 5


class TestRiskViolation:
    """Tests for RiskViolation dataclass."""

    def test_creation(self) -> None:
        """Test violation creation."""
        violation = RiskViolation(
            violation_type=RiskViolationType.POSITION_SIZE,
            level=RiskLevel.WARNING,
            message="Position size exceeds limit",
            current_value=8000,
            limit_value=10000,
        )
        assert violation.level == RiskLevel.WARNING
        assert violation.current_value == 8000

    def test_utilization(self) -> None:
        """Test utilization calculation."""
        violation = RiskViolation(
            violation_type=RiskViolationType.DAILY_LOSS,
            level=RiskLevel.WARNING,
            message="Daily loss approaching limit",
            current_value=800,
            limit_value=1000,
        )
        assert violation.utilization == 80.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        violation = RiskViolation(
            violation_type=RiskViolationType.MAX_DRAWDOWN,
            level=RiskLevel.CRITICAL,
            message="Drawdown exceeded",
            current_value=25.0,
            limit_value=20.0,
            session_id="session-001",
        )
        d = violation.to_dict()

        assert d["violationType"] == "max_drawdown"
        assert d["level"] == "critical"
        assert d["sessionId"] == "session-001"


class TestRiskStatus:
    """Tests for RiskStatus dataclass."""

    def test_creation(self) -> None:
        """Test status creation."""
        status = RiskStatus(session_id="session-001")

        assert status.is_trading_allowed is True
        assert len(status.violations) == 0

    def test_highest_violation_level(self) -> None:
        """Test highest violation level."""
        status = RiskStatus(session_id="session-001")

        # No violations
        assert status.highest_violation_level is None

        # Add violations
        status.violations = [
            RiskViolation(
                violation_type=RiskViolationType.POSITION_SIZE,
                level=RiskLevel.INFO,
                message="Info",
                current_value=50,
                limit_value=100,
            ),
            RiskViolation(
                violation_type=RiskViolationType.DAILY_LOSS,
                level=RiskLevel.WARNING,
                message="Warning",
                current_value=80,
                limit_value=100,
            ),
        ]

        assert status.highest_violation_level == RiskLevel.WARNING

    def test_has_critical_violations(self) -> None:
        """Test critical violations check."""
        status = RiskStatus(session_id="session-001")

        assert status.has_critical_violations is False

        status.violations = [
            RiskViolation(
                violation_type=RiskViolationType.POSITION_SIZE,
                level=RiskLevel.CRITICAL,
                message="Critical",
                current_value=100,
                limit_value=100,
            ),
        ]

        assert status.has_critical_violations is True

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        status = RiskStatus(
            session_id="session-001",
            total_exposure=Decimal("50000"),
            daily_pnl=Decimal("-200"),
        )
        d = status.to_dict()

        assert d["sessionId"] == "session-001"
        assert d["totalExposure"] == 50000.0
        assert d["dailyPnl"] == -200.0


class TestRiskMonitor:
    """Tests for RiskMonitor class."""

    @pytest.fixture
    def position_tracker(self) -> PositionTracker:
        """Create position tracker."""
        return PositionTracker()

    @pytest.fixture
    def order_manager(self) -> OrderManager:
        """Create order manager."""
        return OrderManager()

    @pytest.fixture
    def monitor(
        self,
        position_tracker: PositionTracker,
        order_manager: OrderManager,
    ) -> RiskMonitor:
        """Create risk monitor."""
        return RiskMonitor(position_tracker, order_manager)

    @pytest.fixture
    def limits(self) -> RiskLimits:
        """Create test limits."""
        return RiskLimits(
            max_position_size=Decimal("10000"),
            max_total_exposure=Decimal("50000"),
            daily_loss_limit=Decimal("1000"),
            max_open_orders=5,
            max_order_size=Decimal("5000"),
        )

    def test_set_get_limits(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test setting and getting limits."""
        monitor.set_limits("session-001", limits)
        retrieved = monitor.get_limits("session-001")

        assert retrieved.max_position_size == limits.max_position_size

    def test_get_default_limits(self, monitor: RiskMonitor) -> None:
        """Test getting default limits."""
        limits = monitor.get_limits("nonexistent")

        assert limits.max_position_size == Decimal("10000")

    def test_update_daily_pnl(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test updating daily P&L."""
        monitor.set_limits("session-001", limits)

        monitor.update_daily_pnl("session-001", Decimal("500"))
        monitor.update_daily_pnl("session-001", Decimal("-200"))

        status = monitor.get_status("session-001")
        assert status.daily_pnl == Decimal("300")

    def test_reset_daily_metrics(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test resetting daily metrics."""
        monitor.set_limits("session-001", limits)
        monitor.update_daily_pnl("session-001", Decimal("500"))

        monitor.reset_daily_metrics("session-001")

        status = monitor.get_status("session-001")
        assert status.daily_pnl == Decimal("0")

    def test_check_order_valid(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test checking a valid order."""
        monitor.set_limits("session-001", limits)

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("10"),
            limit_price=Decimal("100"),
        )

        violations = monitor.check_order("session-001", order)
        assert len(violations) == 0

    def test_check_order_exceeds_size(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test checking an order that exceeds size limit."""
        monitor.set_limits("session-001", limits)

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("100"),  # 10,000 notional > 5,000 limit
        )

        violations = monitor.check_order("session-001", order)
        assert len(violations) > 0
        assert any(v.violation_type == RiskViolationType.POSITION_SIZE for v in violations)

    def test_check_order_trading_halted(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test checking order when trading is halted."""
        monitor.set_limits("session-001", limits)
        monitor._trading_halted["session-001"] = True

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("10"),
        )

        violations = monitor.check_order("session-001", order)
        assert len(violations) > 0
        assert violations[0].violation_type == RiskViolationType.TRADING_HALTED

    def test_get_status(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test getting risk status."""
        monitor.set_limits("session-001", limits)

        status = monitor.get_status("session-001")

        assert status.session_id == "session-001"
        assert status.is_trading_allowed is True
        assert status.total_exposure == Decimal("0")

    def test_status_with_violations(
        self,
        monitor: RiskMonitor,
        position_tracker: PositionTracker,
    ) -> None:
        """Test status with violations."""
        limits = RiskLimits(
            max_total_exposure=Decimal("10000"),
            warning_threshold=0.8,
        )
        monitor.set_limits("session-001", limits)

        # Create position that exceeds warning threshold
        pos = position_tracker.get_or_create_position("session-001", "AAPL")
        pos.quantity = Decimal("100")
        pos.current_price = Decimal("90")  # 9000 exposure = 90% of limit

        status = monitor.get_status("session-001")

        # Should have warning
        assert len(status.violations) > 0
        assert status.highest_violation_level == RiskLevel.WARNING

    def test_daily_loss_breach_halts_trading(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test that exceeding daily loss halts trading."""
        monitor.set_limits("session-001", limits)

        # Simulate losses exceeding limit
        monitor.update_daily_pnl("session-001", Decimal("-1100"))

        status = monitor.get_status("session-001")

        assert status.is_trading_allowed is False
        assert any(
            v.violation_type == RiskViolationType.DAILY_LOSS
            for v in status.violations
        )

    def test_resume_trading(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test resuming trading."""
        monitor.set_limits("session-001", limits)
        monitor._trading_halted["session-001"] = True

        monitor.resume_trading("session-001")

        assert monitor.is_trading_allowed("session-001") is True

    def test_is_trading_allowed(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test is_trading_allowed check."""
        monitor.set_limits("session-001", limits)

        assert monitor.is_trading_allowed("session-001") is True

        monitor._trading_halted["session-001"] = True

        assert monitor.is_trading_allowed("session-001") is False

    def test_clear_session(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test clearing session data."""
        monitor.set_limits("session-001", limits)
        monitor.update_daily_pnl("session-001", Decimal("500"))

        monitor.clear_session("session-001")

        # Should get default limits now
        retrieved = monitor.get_limits("session-001")
        assert retrieved != limits

    def test_violation_callback(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test violation callback."""
        monitor.set_limits("session-001", limits)

        violations_received: list[RiskViolation] = []
        monitor.on_violation(lambda v: violations_received.append(v))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("100"),  # Exceeds limit
        )

        monitor.check_order("session-001", order)

        assert len(violations_received) > 0

    def test_trading_halted_callback(
        self,
        monitor: RiskMonitor,
        limits: RiskLimits,
    ) -> None:
        """Test trading halted callback."""
        monitor.set_limits("session-001", limits)

        halted_events: list[tuple[str, str]] = []
        monitor.on_trading_halted(lambda s, r: halted_events.append((s, r)))

        # Trigger daily loss breach
        monitor.update_daily_pnl("session-001", Decimal("-1100"))
        monitor.get_status("session-001")  # This triggers the check

        assert len(halted_events) == 1
        assert halted_events[0][0] == "session-001"
