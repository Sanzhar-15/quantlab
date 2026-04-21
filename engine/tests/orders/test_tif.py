"""
Tests for Time-in-Force Order Management.

Tests order expiration and validity based on time-in-force settings.
"""

from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal

import pytest

from quantlab.orders.tif import (
    TimeInForce,
    TIFStatus,
    TIFHandler,
    OrderExpiry,
)


@dataclass
class MockOrderRequest:
    """Mock order request for testing."""

    time_in_force: TimeInForce


class TestTimeInForce:
    """Tests for TimeInForce enum."""

    def test_gfd_value(self) -> None:
        """Test GFD value."""
        assert TimeInForce.GFD.value == "gfd"

    def test_gtc_value(self) -> None:
        """Test GTC value."""
        assert TimeInForce.GTC.value == "gtc"

    def test_ioc_value(self) -> None:
        """Test IOC value."""
        assert TimeInForce.IOC.value == "ioc"

    def test_fok_value(self) -> None:
        """Test FOK value."""
        assert TimeInForce.FOK.value == "fok"


class TestTIFStatus:
    """Tests for TIFStatus dataclass."""

    def test_valid_status(self) -> None:
        """Test valid order status."""
        status = TIFStatus(is_valid=True, is_expired=False)
        assert status.is_valid is True
        assert status.is_expired is False
        assert status.reason == ""

    def test_expired_status(self) -> None:
        """Test expired order status."""
        status = TIFStatus(
            is_valid=False, is_expired=True, reason="Order expired"
        )
        assert status.is_valid is False
        assert status.is_expired is True
        assert status.reason == "Order expired"

    def test_remaining_bars(self) -> None:
        """Test remaining bars tracking."""
        status = TIFStatus(is_valid=True, is_expired=False, remaining_bars=5)
        assert status.remaining_bars == 5


class TestTIFHandler:
    """Tests for TIFHandler class."""

    @pytest.fixture
    def handler(self) -> TIFHandler:
        """Create a TIF handler."""
        return TIFHandler(
            market_open=time(9, 30),
            market_close=time(16, 0),
            timezone="America/New_York",
        )

    def test_init(self, handler) -> None:
        """Test handler initialization."""
        assert handler.market_open == time(9, 30)
        assert handler.market_close == time(16, 0)
        assert handler.timezone == "America/New_York"

    # is_expired tests
    def test_is_expired_gtc_never_expires(self, handler) -> None:
        """Test GTC orders never expire."""
        request = MockOrderRequest(time_in_force=TimeInForce.GTC)
        current_time = datetime(2024, 1, 15, 23, 59)  # Late night

        result = handler.is_expired(request, current_time)

        assert result is False

    def test_is_expired_gfd_during_market_hours(self, handler) -> None:
        """Test GFD not expired during market hours."""
        request = MockOrderRequest(time_in_force=TimeInForce.GFD)
        current_time = datetime(2024, 1, 15, 14, 30)  # 2:30 PM

        result = handler.is_expired(request, current_time)

        assert result is False

    def test_is_expired_gfd_after_close(self, handler) -> None:
        """Test GFD expired after market close."""
        request = MockOrderRequest(time_in_force=TimeInForce.GFD)
        current_time = datetime(2024, 1, 15, 16, 30)  # 4:30 PM

        result = handler.is_expired(request, current_time)

        assert result is True

    def test_is_expired_ioc_always_expires(self, handler) -> None:
        """Test IOC always expires if not filled."""
        request = MockOrderRequest(time_in_force=TimeInForce.IOC)
        current_time = datetime(2024, 1, 15, 10, 0)

        result = handler.is_expired(request, current_time)

        assert result is True

    def test_is_expired_fok_always_expires(self, handler) -> None:
        """Test FOK always expires if not completely filled."""
        request = MockOrderRequest(time_in_force=TimeInForce.FOK)
        current_time = datetime(2024, 1, 15, 10, 0)

        result = handler.is_expired(request, current_time)

        assert result is True

    def test_is_expired_default_not_expired(self, handler) -> None:
        """Test default TIF returns not expired."""
        request = MockOrderRequest(time_in_force=TimeInForce.CLS)
        current_time = datetime(2024, 1, 15, 10, 0)

        result = handler.is_expired(request, current_time)

        assert result is False

    # check_validity tests
    def test_check_validity_gfd_valid(self, handler) -> None:
        """Test GFD order still valid."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.GFD,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_validity_gfd_expired(self, handler) -> None:
        """Test GFD order expired."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.GFD,
            order_created_bar=0,
            current_bar=5,
            current_timestamp=timestamp,
        )

        assert status.is_valid is False
        assert status.is_expired is True
        assert "expired" in status.reason.lower()

    def test_check_validity_gtc_always_valid(self, handler) -> None:
        """Test GTC always valid."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.GTC,
            order_created_bar=0,
            current_bar=100,
            current_timestamp=timestamp,
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_validity_ioc_valid(self, handler) -> None:
        """Test IOC valid on next bar."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.IOC,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_validity_ioc_expired(self, handler) -> None:
        """Test IOC expired after next bar."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.IOC,
            order_created_bar=0,
            current_bar=5,
            current_timestamp=timestamp,
        )

        assert status.is_valid is False
        assert status.is_expired is True

    def test_check_validity_fok(self, handler) -> None:
        """Test FOK uses same logic as IOC."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.FOK,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
        )

        assert status.is_valid is True

    def test_check_validity_gtd_valid(self, handler) -> None:
        """Test GTD valid before date."""
        timestamp = datetime(2024, 1, 15, 10, 0)
        gtd_date = date(2024, 1, 20)

        status = handler.check_validity(
            tif=TimeInForce.GTD,
            order_created_bar=0,
            current_bar=5,
            current_timestamp=timestamp,
            gtd_date=gtd_date,
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_validity_gtd_expired(self, handler) -> None:
        """Test GTD expired after date."""
        timestamp = datetime(2024, 1, 25, 10, 0)
        gtd_date = date(2024, 1, 20)

        status = handler.check_validity(
            tif=TimeInForce.GTD,
            order_created_bar=0,
            current_bar=5,
            current_timestamp=timestamp,
            gtd_date=gtd_date,
        )

        assert status.is_valid is False
        assert status.is_expired is True
        assert "expired" in status.reason.lower()

    def test_check_validity_gtd_no_date(self, handler) -> None:
        """Test GTD without date specified."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.GTD,
            order_created_bar=0,
            current_bar=5,
            current_timestamp=timestamp,
            gtd_date=None,
        )

        assert status.is_valid is False
        assert status.is_expired is True
        assert "not specified" in status.reason.lower()

    def test_check_validity_opg_at_open(self, handler) -> None:
        """Test OPG valid at market open."""
        timestamp = datetime(2024, 1, 15, 9, 30)

        status = handler.check_validity(
            tif=TimeInForce.OPG,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
            is_open_bar=True,
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_validity_opg_not_at_open(self, handler) -> None:
        """Test OPG invalid when not at open."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.OPG,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
            is_open_bar=False,
        )

        assert status.is_valid is False
        assert status.is_expired is True
        assert "open" in status.reason.lower()

    def test_check_validity_cls_at_close(self, handler) -> None:
        """Test CLS valid at market close."""
        timestamp = datetime(2024, 1, 15, 16, 0)

        status = handler.check_validity(
            tif=TimeInForce.CLS,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
            is_close_bar=True,
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_validity_cls_pending(self, handler) -> None:
        """Test CLS pending until close."""
        timestamp = datetime(2024, 1, 15, 10, 0)

        status = handler.check_validity(
            tif=TimeInForce.CLS,
            order_created_bar=0,
            current_bar=1,
            current_timestamp=timestamp,
            is_close_bar=False,
        )

        assert status.is_valid is False
        assert status.is_expired is False  # Not expired, just pending

    # should_expire tests
    def test_should_expire_ioc_partial(self, handler) -> None:
        """Test IOC expires on partial fill."""
        result = handler.should_expire(
            tif=TimeInForce.IOC,
            partial_filled=True,
            fill_quantity=Decimal("50"),
            order_quantity=Decimal("100"),
        )

        assert result is True

    def test_should_expire_ioc_complete(self, handler) -> None:
        """Test IOC doesn't expire on complete fill."""
        result = handler.should_expire(
            tif=TimeInForce.IOC,
            partial_filled=True,
            fill_quantity=Decimal("100"),
            order_quantity=Decimal("100"),
        )

        assert result is False

    def test_should_expire_fok_partial(self, handler) -> None:
        """Test FOK expires on any partial fill."""
        result = handler.should_expire(
            tif=TimeInForce.FOK,
            partial_filled=True,
            fill_quantity=Decimal("99"),
            order_quantity=Decimal("100"),
        )

        assert result is True

    def test_should_expire_gfd_partial(self, handler) -> None:
        """Test GFD doesn't expire on partial fill."""
        result = handler.should_expire(
            tif=TimeInForce.GFD,
            partial_filled=True,
            fill_quantity=Decimal("50"),
            order_quantity=Decimal("100"),
        )

        assert result is False


class TestOrderExpiry:
    """Tests for OrderExpiry class."""

    @pytest.fixture
    def expiry(self) -> OrderExpiry:
        """Create an order expiry tracker."""
        return OrderExpiry()

    def test_init_default(self) -> None:
        """Test default initialization."""
        expiry = OrderExpiry()
        assert expiry.tif_handler is not None

    def test_init_custom_handler(self) -> None:
        """Test with custom handler."""
        handler = TIFHandler(
            market_open=time(10, 0),
            market_close=time(17, 0),
        )
        expiry = OrderExpiry(tif_handler=handler)
        assert expiry.tif_handler == handler

    def test_register_order(self, expiry) -> None:
        """Test registering an order."""
        expiry.register_order(
            order_id="order-001",
            tif=TimeInForce.GFD,
            created_bar=5,
        )

        assert "order-001" in expiry._order_metadata

    def test_register_order_with_gtd(self, expiry) -> None:
        """Test registering GTD order with date."""
        expiry.register_order(
            order_id="order-001",
            tif=TimeInForce.GTD,
            created_bar=5,
            gtd_date=date(2024, 1, 20),
        )

        assert expiry._order_metadata["order-001"]["gtd_date"] == date(2024, 1, 20)

    def test_check_expired_valid(self, expiry) -> None:
        """Test checking valid order."""
        expiry.register_order(
            order_id="order-001",
            tif=TimeInForce.GTC,
            created_bar=0,
        )

        status = expiry.check_expired(
            order_id="order-001",
            current_bar=100,
            current_timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert status.is_valid is True
        assert status.is_expired is False

    def test_check_expired_unregistered(self, expiry) -> None:
        """Test checking unregistered order."""
        status = expiry.check_expired(
            order_id="unknown-order",
            current_bar=10,
            current_timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert status.is_valid is False
        assert status.is_expired is True
        assert "not registered" in status.reason.lower()

    def test_remove_order(self, expiry) -> None:
        """Test removing an order."""
        expiry.register_order(
            order_id="order-001",
            tif=TimeInForce.GFD,
            created_bar=5,
        )

        expiry.remove_order("order-001")

        assert "order-001" not in expiry._order_metadata

    def test_remove_nonexistent_order(self, expiry) -> None:
        """Test removing nonexistent order."""
        # Should not raise
        expiry.remove_order("nonexistent-order")

    def test_get_expired_orders(self, expiry) -> None:
        """Test getting list of expired orders."""
        # Register some orders
        expiry.register_order("order-001", TimeInForce.GTC, created_bar=0)
        expiry.register_order("order-002", TimeInForce.GFD, created_bar=0)

        # Check at bar 10 - GFD should be expired
        expired = expiry.get_expired_orders(
            current_bar=10,
            current_timestamp=datetime(2024, 1, 15, 10, 0),
            order_ids=["order-001", "order-002"],
        )

        assert "order-001" not in expired  # GTC not expired
        assert "order-002" in expired  # GFD expired

    def test_get_expired_orders_empty(self, expiry) -> None:
        """Test getting expired orders when none exist."""
        expired = expiry.get_expired_orders(
            current_bar=10,
            current_timestamp=datetime(2024, 1, 15, 10, 0),
            order_ids=[],
        )

        assert expired == []
