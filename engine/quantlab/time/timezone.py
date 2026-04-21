"""
Timezone handling utilities.

All times stored as UTC internally, displayed in local timezone.

Spec Reference: Technical Spec §14.4, Decisions N83, N84
"""

from datetime import date
from datetime import datetime
from datetime import time as dt_time
from datetime import timedelta
from datetime import timezone
from zoneinfo import ZoneInfo


# Common timezone aliases
UTC = ZoneInfo("UTC")
NEW_YORK = ZoneInfo("America/New_York")
CHICAGO = ZoneInfo("America/Chicago")
LOS_ANGELES = ZoneInfo("America/Los_Angeles")
LONDON = ZoneInfo("Europe/London")
TOKYO = ZoneInfo("Asia/Tokyo")


class TimezoneHandler:
    """
    Handle timezone conversions for trading applications.

    Usage:
        handler = TimezoneHandler("America/New_York")
        utc_time = handler.to_utc(local_datetime)
        local_time = handler.from_utc(utc_datetime)
    """

    def __init__(self, local_tz: str | ZoneInfo = "America/New_York") -> None:
        """
        Initialize timezone handler.

        Args:
            local_tz: Local timezone name or ZoneInfo object
        """
        if isinstance(local_tz, str):
            self.local_tz = ZoneInfo(local_tz)
        else:
            self.local_tz = local_tz

    def to_utc(self, dt: datetime) -> datetime:
        """
        Convert local datetime to UTC.

        Args:
            dt: Datetime in local timezone (naive or aware)

        Returns:
            Datetime in UTC
        """
        if dt.tzinfo is None:
            # Assume local timezone for naive datetime
            dt = dt.replace(tzinfo=self.local_tz)
        return dt.astimezone(UTC)

    def from_utc(self, dt: datetime) -> datetime:
        """
        Convert UTC datetime to local timezone for display.

        Args:
            dt: Datetime in UTC

        Returns:
            Datetime in local timezone
        """
        if dt.tzinfo is None:
            # Assume UTC for naive datetime
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(self.local_tz)

    def now_utc(self) -> datetime:
        """Get current time in UTC."""
        return datetime.now(UTC)

    def now_local(self) -> datetime:
        """Get current time in local timezone."""
        return datetime.now(self.local_tz)

    def is_dst(self, dt: datetime | None = None) -> bool:
        """
        Check if DST is in effect for a given datetime.

        Args:
            dt: Datetime to check (default: now)

        Returns:
            True if DST is in effect
        """
        if dt is None:
            dt = self.now_local()
        elif dt.tzinfo is None:
            dt = dt.replace(tzinfo=self.local_tz)

        # Check if DST offset is non-zero
        std_offset = self.local_tz.utcoffset(datetime(dt.year, 1, 1))
        current_offset = dt.utcoffset()
        return current_offset != std_offset


def parse_iso_datetime(s: str) -> datetime:
    """
    Parse ISO 8601 datetime string.

    Supports:
    - 2026-01-26T14:30:00Z
    - 2026-01-26T14:30:00+00:00
    - 2026-01-26T14:30:00

    Args:
        s: ISO 8601 datetime string

    Returns:
        Datetime object (UTC if no timezone specified)
    """
    # Handle 'Z' suffix
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"

    dt = datetime.fromisoformat(s)

    # Default to UTC if no timezone
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    elif dt.utcoffset() == timedelta(0):
        # Convert datetime.timezone.utc to ZoneInfo('UTC') for consistency
        dt = dt.replace(tzinfo=UTC)

    return dt


def format_iso_datetime(dt: datetime) -> str:
    """
    Format datetime as ISO 8601 string with Z suffix.

    Args:
        dt: Datetime object

    Returns:
        ISO 8601 string (e.g., "2026-01-26T14:30:00Z")
    """
    utc_dt = dt.astimezone(UTC)
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def combine_date_time(d: date, t: dt_time, tz: ZoneInfo | str) -> datetime:
    """
    Combine date and time in a specific timezone.

    Args:
        d: Date
        t: Time
        tz: Timezone

    Returns:
        Datetime in the specified timezone
    """
    if isinstance(tz, str):
        tz = ZoneInfo(tz)
    return datetime.combine(d, t, tzinfo=tz)


def get_market_open_utc(
    d: date,
    open_time: dt_time,
    market_tz: str | ZoneInfo,
) -> datetime:
    """
    Get market open time in UTC for a given date.

    This correctly handles DST transitions.

    Args:
        d: Trading date
        open_time: Market open time (e.g., time(9, 30))
        market_tz: Market timezone

    Returns:
        Market open time in UTC
    """
    if isinstance(market_tz, str):
        market_tz = ZoneInfo(market_tz)

    local_open = datetime.combine(d, open_time, tzinfo=market_tz)
    return local_open.astimezone(UTC)


def get_market_close_utc(
    d: date,
    close_time: dt_time,
    market_tz: str | ZoneInfo,
) -> datetime:
    """
    Get market close time in UTC for a given date.

    This correctly handles DST transitions.

    Args:
        d: Trading date
        close_time: Market close time (e.g., time(16, 0))
        market_tz: Market timezone

    Returns:
        Market close time in UTC
    """
    if isinstance(market_tz, str):
        market_tz = ZoneInfo(market_tz)

    local_close = datetime.combine(d, close_time, tzinfo=market_tz)
    return local_close.astimezone(UTC)


def is_dst_transition_day(d: date, tz: str | ZoneInfo) -> bool:
    """
    Check if a date includes a DST transition.

    Args:
        d: Date to check
        tz: Timezone to check

    Returns:
        True if DST transition occurs on this date
    """
    if isinstance(tz, str):
        tz = ZoneInfo(tz)

    # Check if UTC offset changes between start and end of day
    start = datetime.combine(d, dt_time(0, 0), tzinfo=tz)
    end = datetime.combine(d, dt_time(23, 59, 59), tzinfo=tz)

    return start.utcoffset() != end.utcoffset()


def get_dst_transition_info(d: date, tz: str | ZoneInfo) -> dict:
    """
    Get information about DST transition on a given date.

    Args:
        d: Date to check
        tz: Timezone to check

    Returns:
        Dictionary with transition info:
        - 'is_transition': True if DST transition occurs
        - 'direction': 'spring_forward' or 'fall_back' or None
        - 'offset_before': UTC offset before transition
        - 'offset_after': UTC offset after transition
        - 'hours_in_day': Actual hours in the day (23 or 25 for transition days)
    """
    if isinstance(tz, str):
        tz = ZoneInfo(tz)

    start = datetime.combine(d, dt_time(0, 0), tzinfo=tz)
    end = datetime.combine(d, dt_time(23, 59, 59), tzinfo=tz)

    offset_before = start.utcoffset()
    offset_after = end.utcoffset()

    is_transition = offset_before != offset_after

    if not is_transition:
        return {
            "is_transition": False,
            "direction": None,
            "offset_before": offset_before,
            "offset_after": offset_after,
            "hours_in_day": 24,
        }

    # Determine direction
    if offset_after > offset_before:
        # Spring forward (lose an hour)
        direction = "spring_forward"
        hours_in_day = 23
    else:
        # Fall back (gain an hour)
        direction = "fall_back"
        hours_in_day = 25

    return {
        "is_transition": True,
        "direction": direction,
        "offset_before": offset_before,
        "offset_after": offset_after,
        "hours_in_day": hours_in_day,
    }


def localize_with_dst_handling(
    dt: datetime,
    tz: str | ZoneInfo,
    prefer_dst: bool = True,
) -> datetime:
    """
    Localize a naive datetime with proper DST handling.

    During DST fall-back transitions, a local time may exist twice.
    This function lets you choose which interpretation to use.

    Args:
        dt: Naive datetime to localize
        tz: Target timezone
        prefer_dst: If True, prefer DST interpretation during ambiguous times.
                   If False, prefer standard time.

    Returns:
        Localized datetime

    Note:
        For times during spring-forward gap (non-existent times),
        the result will be shifted forward to the first valid time.
    """
    if isinstance(tz, str):
        tz = ZoneInfo(tz)

    if dt.tzinfo is not None:
        return dt.astimezone(tz)

    # Create initial localized datetime
    localized = dt.replace(tzinfo=tz)

    # Check if this date has a DST transition
    info = get_dst_transition_info(dt.date(), tz)

    if not info["is_transition"]:
        return localized

    if info["direction"] == "fall_back":
        # During fall-back, times can be ambiguous
        # We need to check if this time falls in the overlap period
        # Convert to UTC and back to check
        utc_time = localized.astimezone(UTC)
        round_trip = utc_time.astimezone(tz)

        if round_trip.hour != dt.hour or round_trip.minute != dt.minute:
            # This time is in the ambiguous overlap period
            # Adjust based on prefer_dst setting
            if prefer_dst:
                # Use the DST interpretation (earlier UTC time)
                localized = localized - timedelta(hours=1)
                localized = localized.replace(tzinfo=tz)
            # else: keep the standard time interpretation

    return localized


def get_trading_day_duration(
    d: date,
    open_time: dt_time,
    close_time: dt_time,
    market_tz: str | ZoneInfo,
) -> timedelta:
    """
    Get the actual duration of a trading day, accounting for DST.

    On DST transition days, trading day duration may be 23 or 25 hours.

    Args:
        d: Trading date
        open_time: Market open time
        close_time: Market close time
        market_tz: Market timezone

    Returns:
        Actual trading duration as timedelta
    """
    open_utc = get_market_open_utc(d, open_time, market_tz)
    close_utc = get_market_close_utc(d, close_time, market_tz)

    return close_utc - open_utc
