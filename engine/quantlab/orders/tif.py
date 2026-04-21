"""
Time-in-Force Order Management.

Handles order expiration and validity based on time-in-force settings.

Spec Reference: Technical Spec §3.3
"""

from dataclasses import dataclass
from datetime import date
from datetime import datetime
from datetime import time
from datetime import timedelta
from decimal import Decimal
from enum import Enum
from typing import Any


class TimeInForce(Enum):
    """Time in force specifications."""

    GFD = "gfd"  # Good for Day - expires at end of trading day
    DAY = "gfd"  # Alias for GFD (compatibility)
    GTC = "gtc"  # Good Till Cancelled - no expiration
    IOC = "ioc"  # Immediate or Cancel - must fill immediately or cancel
    FOK = "fok"  # Fill or Kill - must fill completely immediately or cancel
    GTD = "gtd"  # Good Till Date - expires on specified date
    OPG = "opg"  # At the Open - only valid at market open
    CLS = "cls"  # At the Close - only valid at market close


@dataclass
class TIFStatus:
    """Time-in-force status for an order."""

    is_valid: bool
    is_expired: bool
    reason: str = ""
    remaining_bars: int | None = None


class TIFHandler:
    """
    Time-in-force handler for orders.

    Manages order validity and expiration based on TIF type.
    """

    def __init__(
        self,
        market_open: time = time(9, 30),  # 9:30 AM
        market_close: time = time(16, 0),  # 4:00 PM
        timezone: str = "America/New_York",
    ) -> None:
        """
        Initialize TIF handler.

        Args:
            market_open: Market open time
            market_close: Market close time
            timezone: Market timezone
        """
        self.market_open = market_open
        self.market_close = market_close
        self.timezone = timezone

    def is_expired(
        self,
        request: Any,
        current_time: datetime,
    ) -> bool:
        """
        Check if an order has expired based on its time-in-force.

        Simple API for tests.

        Args:
            request: Order request with time_in_force attribute
            current_time: Current datetime to check against

        Returns:
            True if order has expired
        """
        tif = getattr(request, "time_in_force", TimeInForce.GFD)

        if tif == TimeInForce.GTC:
            # GTC never expires
            return False

        elif tif == TimeInForce.GFD or tif.value == "gfd":
            # GFD/DAY expires after market close
            current_time_only = current_time.time()
            return current_time_only > self.market_close

        elif tif == TimeInForce.IOC:
            # IOC expires immediately if not filled
            return True

        elif tif == TimeInForce.FOK:
            # FOK expires immediately if not filled completely
            return True

        # Default: not expired
        return False

    def check_validity(
        self,
        tif: TimeInForce,
        order_created_bar: int,
        current_bar: int,
        current_timestamp: datetime,
        gtd_date: date | None = None,
        is_open_bar: bool = False,
        is_close_bar: bool = False,
    ) -> TIFStatus:
        """
        Check if order is still valid based on TIF.

        Args:
            tif: Time in force type
            order_created_bar: Bar index when order was created
            current_bar: Current bar index
            current_timestamp: Current bar timestamp
            gtd_date: Expiration date for GTD orders
            is_open_bar: True if this is the market open bar
            is_close_bar: True if this is the market close bar

        Returns:
            TIFStatus with validity information
        """
        if tif == TimeInForce.GFD:
            return self._check_gfd(order_created_bar, current_bar, current_timestamp)

        elif tif == TimeInForce.GTC:
            return TIFStatus(is_valid=True, is_expired=False)

        elif tif == TimeInForce.IOC:
            return self._check_ioc(order_created_bar, current_bar)

        elif tif == TimeInForce.FOK:
            # FOK is handled during order fill - always valid here
            return self._check_ioc(order_created_bar, current_bar)

        elif tif == TimeInForce.GTD:
            return self._check_gtd(current_timestamp, gtd_date)

        elif tif == TimeInForce.OPG:
            return self._check_opg(is_open_bar)

        elif tif == TimeInForce.CLS:
            return self._check_cls(is_close_bar)

        else:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason=f"Unknown TIF type: {tif}",
            )

    def _check_gfd(
        self,
        order_created_bar: int,
        current_bar: int,
        current_timestamp: datetime,
    ) -> TIFStatus:
        """
        Check GFD (Good for Day) validity.

        For daily bars: expires after one bar
        For intraday: expires at market close
        """
        # Simplified: for daily timeframe, GFD = one bar
        # The order executes on bar t+1, so it's valid for the execution bar only
        bars_since_creation = current_bar - order_created_bar

        if bars_since_creation > 1:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason="GFD order expired (day ended)",
            )

        return TIFStatus(
            is_valid=True,
            is_expired=False,
            remaining_bars=1 - bars_since_creation,
        )

    def _check_ioc(
        self,
        order_created_bar: int,
        current_bar: int,
    ) -> TIFStatus:
        """
        Check IOC (Immediate or Cancel) validity.

        IOC orders must be filled on the first attempt or cancelled.
        """
        # IOC must fill on the very next bar (bar t+1)
        if current_bar > order_created_bar + 1:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason="IOC order cancelled (not filled immediately)",
            )

        return TIFStatus(is_valid=True, is_expired=False)

    def _check_gtd(
        self,
        current_timestamp: datetime,
        gtd_date: date | None,
    ) -> TIFStatus:
        """Check GTD (Good Till Date) validity."""
        if gtd_date is None:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason="GTD date not specified",
            )

        if current_timestamp.date() > gtd_date:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason=f"GTD order expired (date {gtd_date} passed)",
            )

        return TIFStatus(is_valid=True, is_expired=False)

    def _check_opg(self, is_open_bar: bool) -> TIFStatus:
        """Check OPG (At the Open) validity."""
        if not is_open_bar:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason="OPG order only valid at market open",
            )

        return TIFStatus(is_valid=True, is_expired=False)

    def _check_cls(self, is_close_bar: bool) -> TIFStatus:
        """Check CLS (At the Close) validity."""
        if not is_close_bar:
            # CLS is pending until close
            return TIFStatus(is_valid=False, is_expired=False)

        return TIFStatus(is_valid=True, is_expired=False)

    def should_expire(
        self,
        tif: TimeInForce,
        partial_filled: bool,
        fill_quantity: Decimal,
        order_quantity: Decimal,
    ) -> bool:
        """
        Check if order should expire after a partial fill.

        Args:
            tif: Time in force type
            partial_filled: True if order was partially filled
            fill_quantity: Quantity filled so far
            order_quantity: Original order quantity

        Returns:
            True if remaining quantity should be cancelled
        """
        if tif == TimeInForce.IOC:
            # IOC cancels any unfilled portion
            return partial_filled and fill_quantity < order_quantity

        elif tif == TimeInForce.FOK:
            # FOK requires complete fill - any partial should cancel
            return fill_quantity < order_quantity

        # Other TIF types don't expire on partial fills
        return False


class OrderExpiry:
    """
    Track order expiration across bars.

    Manages expiration state for all pending orders.
    """

    def __init__(self, tif_handler: TIFHandler | None = None) -> None:
        self.tif_handler = tif_handler or TIFHandler()
        self._order_metadata: dict[str, dict[str, Any]] = {}

    def register_order(
        self,
        order_id: str,
        tif: TimeInForce,
        created_bar: int,
        gtd_date: date | None = None,
    ) -> None:
        """Register a new order for expiration tracking."""
        self._order_metadata[order_id] = {
            "tif": tif,
            "created_bar": created_bar,
            "gtd_date": gtd_date,
        }

    def check_expired(
        self,
        order_id: str,
        current_bar: int,
        current_timestamp: datetime,
        is_open_bar: bool = False,
        is_close_bar: bool = False,
    ) -> TIFStatus:
        """Check if an order has expired."""
        if order_id not in self._order_metadata:
            return TIFStatus(
                is_valid=False,
                is_expired=True,
                reason="Order not registered",
            )

        meta = self._order_metadata[order_id]
        return self.tif_handler.check_validity(
            tif=meta["tif"],
            order_created_bar=meta["created_bar"],
            current_bar=current_bar,
            current_timestamp=current_timestamp,
            gtd_date=meta.get("gtd_date"),
            is_open_bar=is_open_bar,
            is_close_bar=is_close_bar,
        )

    def remove_order(self, order_id: str) -> None:
        """Remove order from expiration tracking."""
        self._order_metadata.pop(order_id, None)

    def get_expired_orders(
        self,
        current_bar: int,
        current_timestamp: datetime,
        order_ids: list[str],
        is_open_bar: bool = False,
        is_close_bar: bool = False,
    ) -> list[str]:
        """Get list of expired order IDs."""
        expired = []
        for order_id in order_ids:
            status = self.check_expired(
                order_id=order_id,
                current_bar=current_bar,
                current_timestamp=current_timestamp,
                is_open_bar=is_open_bar,
                is_close_bar=is_close_bar,
            )
            if status.is_expired:
                expired.append(order_id)

        return expired
