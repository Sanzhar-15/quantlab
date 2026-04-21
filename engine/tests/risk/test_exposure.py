"""
Tests for Exposure Reservation Model.

Tests thread-safe exposure management for concurrent order handling.
"""

from datetime import datetime
from datetime import timedelta
from decimal import Decimal

import pytest

from quantlab.risk.exposure import (
    ExposureError,
    ExposureLimitBreach,
    ExposureManager,
    ExposureSnapshot,
    Fill,
    OrderRequest,
    OrderSide,
    ReservationExpired,
    ReservationHandle,
    ReservationNotFound,
    ReservationResult,
)


class TestExposureExceptions:
    """Tests for exposure exception classes."""

    def test_exposure_error(self) -> None:
        """Test ExposureError exception."""
        with pytest.raises(ExposureError):
            raise ExposureError("Test error")

    def test_exposure_limit_breach(self) -> None:
        """Test ExposureLimitBreach exception."""
        with pytest.raises(ExposureLimitBreach):
            raise ExposureLimitBreach("Limit breached")

        # Check inheritance
        with pytest.raises(ExposureError):
            raise ExposureLimitBreach("Limit breached")

    def test_reservation_not_found(self) -> None:
        """Test ReservationNotFound exception."""
        with pytest.raises(ReservationNotFound):
            raise ReservationNotFound("Not found")

    def test_reservation_expired(self) -> None:
        """Test ReservationExpired exception."""
        with pytest.raises(ReservationExpired):
            raise ReservationExpired("Expired")


class TestOrderRequest:
    """Tests for OrderRequest dataclass."""

    def test_creation(self) -> None:
        """Test order request creation."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )

        assert request.order_id == "order-001"
        assert request.symbol == "AAPL"
        assert request.side == OrderSide.BUY
        assert request.quantity == Decimal("100")
        assert request.price == Decimal("150")
        assert request.order_type == "market"

    def test_market_order(self) -> None:
        """Test market order without price."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
        )

        assert request.price is None


class TestFill:
    """Tests for Fill dataclass."""

    def test_creation(self) -> None:
        """Test fill creation."""
        fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150.50"),
        )

        assert fill.order_id == "order-001"
        assert fill.symbol == "AAPL"
        assert fill.fill_quantity == Decimal("100")
        assert fill.fill_price == Decimal("150.50")
        assert fill.is_partial is False

    def test_partial_fill(self) -> None:
        """Test partial fill."""
        fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("50"),
            fill_price=Decimal("150.50"),
            is_partial=True,
        )

        assert fill.is_partial is True


class TestReservationHandle:
    """Tests for ReservationHandle dataclass."""

    def test_creation(self) -> None:
        """Test handle creation."""
        now = datetime.now()
        handle = ReservationHandle(
            reservation_id="res-001",
            order_id="order-001",
            amount=Decimal("15000"),
            symbol="AAPL",
            side=OrderSide.BUY,
            created_at=now,
            expires_at=now + timedelta(minutes=5),
        )

        assert handle.reservation_id == "res-001"
        assert handle.order_id == "order-001"
        assert handle.amount == Decimal("15000")

    def test_is_expired_false(self) -> None:
        """Test is_expired when not expired."""
        now = datetime.now()
        handle = ReservationHandle(
            reservation_id="res-001",
            order_id="order-001",
            amount=Decimal("15000"),
            symbol="AAPL",
            side=OrderSide.BUY,
            created_at=now,
            expires_at=now + timedelta(minutes=5),
        )

        assert handle.is_expired() is False

    def test_is_expired_true(self) -> None:
        """Test is_expired when expired."""
        now = datetime.now()
        handle = ReservationHandle(
            reservation_id="res-001",
            order_id="order-001",
            amount=Decimal("15000"),
            symbol="AAPL",
            side=OrderSide.BUY,
            created_at=now - timedelta(minutes=10),
            expires_at=now - timedelta(minutes=5),
        )

        assert handle.is_expired() is True


class TestReservationResult:
    """Tests for ReservationResult dataclass."""

    def test_success_result(self) -> None:
        """Test successful result."""
        result = ReservationResult(
            success=True,
            available=Decimal("50000"),
            requested=Decimal("15000"),
        )

        assert result.success is True
        assert result.reason is None

    def test_failure_result(self) -> None:
        """Test failure result."""
        result = ReservationResult(
            success=False,
            reason="EXPOSURE_LIMIT_BREACH",
            available=Decimal("5000"),
            requested=Decimal("15000"),
        )

        assert result.success is False
        assert result.reason == "EXPOSURE_LIMIT_BREACH"


class TestExposureSnapshot:
    """Tests for ExposureSnapshot dataclass."""

    def test_creation(self) -> None:
        """Test snapshot creation."""
        snapshot = ExposureSnapshot(
            current_exposure=Decimal("50000"),
            reserved_exposure=Decimal("10000"),
            max_exposure=Decimal("100000"),
            available_exposure=Decimal("40000"),
            reservation_count=2,
            positions={"AAPL": Decimal("100")},
        )

        assert snapshot.current_exposure == Decimal("50000")
        assert snapshot.reserved_exposure == Decimal("10000")
        assert snapshot.reservation_count == 2

    def test_to_dict(self) -> None:
        """Test to_dict conversion."""
        snapshot = ExposureSnapshot(
            current_exposure=Decimal("50000"),
            reserved_exposure=Decimal("10000"),
            max_exposure=Decimal("100000"),
            available_exposure=Decimal("40000"),
            reservation_count=2,
            positions={"AAPL": Decimal("100")},
        )

        data = snapshot.to_dict()

        assert data["current_exposure"] == "50000"
        assert data["reserved_exposure"] == "10000"
        assert data["max_exposure"] == "100000"
        assert data["positions"]["AAPL"] == "100"


class TestExposureManager:
    """Tests for ExposureManager class."""

    @pytest.fixture
    def manager(self) -> ExposureManager:
        """Create an exposure manager."""
        return ExposureManager(max_exposure=Decimal("100000"))

    def test_init(self) -> None:
        """Test initialization."""
        manager = ExposureManager(max_exposure=Decimal("100000"))

        assert manager.max_exposure == Decimal("100000")
        assert manager.current_exposure == Decimal("0")
        assert manager.reserved_exposure == Decimal("0")
        assert manager.available_exposure == Decimal("100000")

    def test_init_custom_timeout(self) -> None:
        """Test initialization with custom timeout."""
        manager = ExposureManager(
            max_exposure=Decimal("100000"),
            reservation_timeout=timedelta(minutes=10),
        )

        assert manager._reservation_timeout == timedelta(minutes=10)

    def test_snapshot(self, manager) -> None:
        """Test snapshot creation."""
        snapshot = manager.snapshot()

        assert isinstance(snapshot, ExposureSnapshot)
        assert snapshot.max_exposure == Decimal("100000")
        assert snapshot.current_exposure == Decimal("0")
        assert snapshot.reservation_count == 0

    def test_reserve_success(self, manager) -> None:
        """Test successful reservation."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )

        result = manager.reserve(request)

        assert result.success is True
        assert result.handle is not None
        assert result.handle.amount == Decimal("15000")
        assert manager.reserved_exposure == Decimal("15000")
        assert manager.available_exposure == Decimal("85000")

    def test_reserve_with_price_estimate(self, manager) -> None:
        """Test reservation with price estimate for market order."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
        )

        result = manager.reserve(request, price_estimate=Decimal("150"))

        assert result.success is True
        assert result.handle.amount == Decimal("15000")

    def test_reserve_limit_breach(self, manager) -> None:
        """Test reservation that would breach limit."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("1000"),
            price=Decimal("150"),  # $150,000 > $100,000 limit
        )

        result = manager.reserve(request)

        assert result.success is False
        assert result.reason == "EXPOSURE_LIMIT_BREACH"
        assert result.requested == Decimal("150000")
        assert result.available == Decimal("100000")

    def test_reserve_multiple(self, manager) -> None:
        """Test multiple reservations."""
        req1 = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        req2 = OrderRequest(
            order_id="order-002",
            symbol="GOOG",
            side=OrderSide.BUY,
            quantity=Decimal("50"),
            price=Decimal("100"),
        )

        result1 = manager.reserve(req1)
        result2 = manager.reserve(req2)

        assert result1.success is True
        assert result2.success is True
        assert manager.reserved_exposure == Decimal("20000")

    def test_commit_full_fill(self, manager) -> None:
        """Test committing full fill."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )
        manager.commit("order-001", fill)

        assert manager.reserved_exposure == Decimal("0")
        assert manager.current_exposure == Decimal("15000")
        assert "order-001" not in manager._reservations

    def test_commit_partial_fill(self, manager) -> None:
        """Test committing partial fill."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("50"),
            fill_price=Decimal("150"),
            is_partial=True,
        )
        manager.commit("order-001", fill)

        assert manager.current_exposure == Decimal("7500")
        # Remaining reservation reduced

    def test_commit_no_reservation(self, manager) -> None:
        """Test commit without prior reservation."""
        fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )

        # Should not raise, handles legacy orders
        manager.commit("order-001", fill)

        assert manager.current_exposure == Decimal("15000")

    def test_release(self, manager) -> None:
        """Test releasing reservation."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        manager.release("order-001")

        assert manager.reserved_exposure == Decimal("0")
        assert "order-001" not in manager._reservations

    def test_release_nonexistent(self, manager) -> None:
        """Test releasing nonexistent reservation."""
        # Should not raise
        manager.release("nonexistent")

    def test_modify_success(self, manager) -> None:
        """Test modifying reservation."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        result = manager.modify(
            "order-001",
            new_quantity=Decimal("50"),
            new_price=Decimal("150"),
        )

        assert result.success is True
        assert manager.reserved_exposure == Decimal("7500")

    def test_modify_not_found(self, manager) -> None:
        """Test modifying nonexistent reservation."""
        result = manager.modify("nonexistent")

        assert result.success is False
        assert result.reason == "RESERVATION_NOT_FOUND"

    def test_modify_limit_breach(self, manager) -> None:
        """Test modification that would breach limit."""
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        result = manager.modify(
            "order-001",
            new_quantity=Decimal("1000"),
            new_price=Decimal("150"),
        )

        assert result.success is False
        assert result.reason == "EXPOSURE_LIMIT_BREACH"

    def test_position_tracking_buy(self, manager) -> None:
        """Test position tracking for buys."""
        fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )
        manager.commit("order-001", fill)

        assert manager._positions["AAPL"] == Decimal("100")

    def test_position_tracking_sell(self, manager) -> None:
        """Test position tracking for sells."""
        # First buy
        buy_fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )
        manager.commit("order-001", buy_fill)

        # Then sell
        sell_fill = Fill(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.SELL,
            fill_quantity=Decimal("50"),
            fill_price=Decimal("155"),
        )
        manager.commit("order-002", sell_fill)

        assert manager._positions["AAPL"] == Decimal("50")

    def test_position_tracking_close_position(self, manager) -> None:
        """Test position tracking when closing position."""
        buy_fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )
        manager.commit("order-001", buy_fill)

        sell_fill = Fill(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.SELL,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("155"),
        )
        manager.commit("order-002", sell_fill)

        # Position should be removed
        assert "AAPL" not in manager._positions

    def test_closing_long_reduces_exposure(self, manager) -> None:
        """Test that selling long position reduces exposure calculation."""
        # Establish long position
        buy_fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )
        manager.commit("order-001", buy_fill)

        # Reserve to sell - should have reduced exposure
        sell_request = OrderRequest(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=Decimal("50"),
            price=Decimal("160"),
        )
        result = manager.reserve(sell_request)

        assert result.success is True
        # Closing position, not opening new exposure
        assert result.handle.amount == Decimal("0")

    def test_closing_short_reduces_exposure(self, manager) -> None:
        """Test that buying to cover short reduces exposure calculation."""
        # Establish short position (sell first)
        sell_fill = Fill(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            fill_quantity=Decimal("100"),
            fill_price=Decimal("150"),
        )
        manager.commit("order-001", sell_fill)

        # Reserve to buy/cover - should have reduced exposure
        buy_request = OrderRequest(
            order_id="order-002",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("50"),
            price=Decimal("140"),
        )
        result = manager.reserve(buy_request)

        assert result.success is True
        # Closing position, not opening new exposure
        assert result.handle.amount == Decimal("0")

    def test_cleanup_expired(self, manager) -> None:
        """Test cleanup of expired reservations."""
        # Create a reservation that expires immediately
        manager._reservation_timeout = timedelta(seconds=-1)
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        assert manager.reserved_exposure == Decimal("15000")

        # Cleanup
        manager._cleanup_expired()

        assert manager.reserved_exposure == Decimal("0")
        assert "order-001" not in manager._reservations

    def test_update_max_exposure(self, manager) -> None:
        """Test updating max exposure."""
        manager.update_max_exposure(Decimal("200000"))

        assert manager.max_exposure == Decimal("200000")
        assert manager.available_exposure == Decimal("200000")

    def test_reset(self, manager) -> None:
        """Test reset."""
        # Create some state
        request = OrderRequest(
            order_id="order-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.reserve(request)

        fill = Fill(
            order_id="order-002",
            symbol="GOOG",
            side=OrderSide.BUY,
            fill_quantity=Decimal("50"),
            fill_price=Decimal("100"),
        )
        manager.commit("order-002", fill)

        # Reset
        manager.reset()

        assert manager.current_exposure == Decimal("0")
        assert manager.reserved_exposure == Decimal("0")
        assert len(manager._reservations) == 0
        assert len(manager._positions) == 0


@pytest.mark.asyncio
class TestExposureManagerAsync:
    """Async tests for ExposureManager."""

    @pytest.fixture
    def manager(self) -> ExposureManager:
        """Create an exposure manager."""
        return ExposureManager(max_exposure=Decimal("100000"))

    async def test_start_stop_cleanup(self, manager) -> None:
        """Test starting and stopping cleanup task."""
        await manager.start_cleanup()
        assert manager._running is True
        assert manager._cleanup_task is not None

        await manager.stop_cleanup()
        assert manager._running is False

    async def test_start_cleanup_idempotent(self, manager) -> None:
        """Test that starting cleanup twice is safe."""
        await manager.start_cleanup()
        await manager.start_cleanup()  # Should not error

        await manager.stop_cleanup()
