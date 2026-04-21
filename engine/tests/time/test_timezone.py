"""
Tests for timezone handling utilities.
"""

from datetime import date
from datetime import datetime
from datetime import time
from zoneinfo import ZoneInfo

import pytest

from quantlab.time.timezone import (
    NEW_YORK,
    UTC,
    TimezoneHandler,
    combine_date_time,
    format_iso_datetime,
    get_market_close_utc,
    get_market_open_utc,
    parse_iso_datetime,
)


class TestTimezoneHandler:
    """Tests for TimezoneHandler class."""

    def test_init_with_string(self):
        """Should accept timezone as string."""
        handler = TimezoneHandler("America/New_York")
        assert handler.local_tz == NEW_YORK

    def test_init_with_zoneinfo(self):
        """Should accept timezone as ZoneInfo."""
        handler = TimezoneHandler(NEW_YORK)
        assert handler.local_tz == NEW_YORK

    def test_to_utc_naive(self):
        """Naive datetime should be treated as local."""
        handler = TimezoneHandler("America/New_York")

        # 2:30 PM in New York (no DST, so UTC-5)
        local = datetime(2026, 1, 15, 14, 30, 0)
        utc = handler.to_utc(local)

        assert utc.tzinfo == UTC
        assert utc.hour == 19  # 14:30 + 5 = 19:30 UTC

    def test_to_utc_aware(self):
        """Aware datetime should convert to UTC."""
        handler = TimezoneHandler("America/New_York")

        local = datetime(2026, 1, 15, 14, 30, 0, tzinfo=NEW_YORK)
        utc = handler.to_utc(local)

        assert utc.tzinfo == UTC
        assert utc.hour == 19

    def test_from_utc(self):
        """UTC datetime should convert to local."""
        handler = TimezoneHandler("America/New_York")

        utc = datetime(2026, 1, 15, 19, 30, 0, tzinfo=UTC)
        local = handler.from_utc(utc)

        assert local.tzinfo == NEW_YORK
        assert local.hour == 14

    def test_roundtrip(self):
        """Round-trip conversion should preserve time."""
        handler = TimezoneHandler("America/New_York")

        original = datetime(2026, 1, 15, 14, 30, 0, tzinfo=NEW_YORK)
        utc = handler.to_utc(original)
        back = handler.from_utc(utc)

        assert back == original


class TestParseIsoDatetime:
    """Tests for parse_iso_datetime function."""

    def test_with_z_suffix(self):
        """Should parse Z suffix as UTC."""
        result = parse_iso_datetime("2026-01-26T14:30:00Z")

        assert result.year == 2026
        assert result.month == 1
        assert result.day == 26
        assert result.hour == 14
        assert result.minute == 30
        assert result.tzinfo == UTC

    def test_with_offset(self):
        """Should parse timezone offset."""
        result = parse_iso_datetime("2026-01-26T14:30:00+00:00")

        assert result.hour == 14
        assert result.tzinfo is not None

    def test_naive_defaults_to_utc(self):
        """Naive datetime should default to UTC."""
        result = parse_iso_datetime("2026-01-26T14:30:00")

        assert result.tzinfo == UTC

    def test_with_negative_offset(self):
        """Should parse negative timezone offset."""
        result = parse_iso_datetime("2026-01-26T14:30:00-05:00")

        # 14:30 in UTC-5 = 19:30 UTC
        utc = result.astimezone(UTC)
        assert utc.hour == 19


class TestFormatIsoDatetime:
    """Tests for format_iso_datetime function."""

    def test_utc_datetime(self):
        """UTC datetime should format with Z suffix."""
        dt = datetime(2026, 1, 26, 14, 30, 0, tzinfo=UTC)
        result = format_iso_datetime(dt)

        assert result == "2026-01-26T14:30:00Z"

    def test_local_datetime_converts(self):
        """Local datetime should convert to UTC."""
        dt = datetime(2026, 1, 26, 9, 30, 0, tzinfo=NEW_YORK)  # 14:30 UTC
        result = format_iso_datetime(dt)

        assert result == "2026-01-26T14:30:00Z"

    def test_naive_datetime(self):
        """Naive datetime should be treated as UTC."""
        dt = datetime(2026, 1, 26, 14, 30, 0)
        result = format_iso_datetime(dt)

        # Note: naive datetime behavior depends on system timezone
        assert "2026-01-26" in result
        assert result.endswith("Z")


class TestCombineDateTime:
    """Tests for combine_date_time function."""

    def test_combine_with_string_tz(self):
        """Should combine date and time with string timezone."""
        d = date(2026, 1, 26)
        t = time(9, 30)
        result = combine_date_time(d, t, "America/New_York")

        assert result.date() == d
        assert result.time() == t
        assert result.tzinfo == NEW_YORK

    def test_combine_with_zoneinfo(self):
        """Should combine date and time with ZoneInfo."""
        d = date(2026, 1, 26)
        t = time(9, 30)
        result = combine_date_time(d, t, NEW_YORK)

        assert result.tzinfo == NEW_YORK


class TestMarketTimes:
    """Tests for market open/close time functions."""

    def test_market_open_utc_winter(self):
        """NYSE opens at 14:30 UTC in winter (EST)."""
        d = date(2026, 1, 15)  # Winter, EST (UTC-5)
        open_time = time(9, 30)

        result = get_market_open_utc(d, open_time, "America/New_York")

        assert result.tzinfo == UTC
        assert result.hour == 14
        assert result.minute == 30

    def test_market_close_utc_winter(self):
        """NYSE closes at 21:00 UTC in winter (EST)."""
        d = date(2026, 1, 15)  # Winter, EST (UTC-5)
        close_time = time(16, 0)

        result = get_market_close_utc(d, close_time, "America/New_York")

        assert result.tzinfo == UTC
        assert result.hour == 21
        assert result.minute == 0

    def test_market_open_utc_summer(self):
        """NYSE opens at 13:30 UTC in summer (EDT)."""
        d = date(2026, 7, 15)  # Summer, EDT (UTC-4)
        open_time = time(9, 30)

        result = get_market_open_utc(d, open_time, "America/New_York")

        assert result.tzinfo == UTC
        assert result.hour == 13
        assert result.minute == 30

    def test_dst_transition_spring(self):
        """Should handle spring DST transition correctly."""
        # March 8, 2026 is the spring DST transition
        # After this date, NYC is EDT (UTC-4)
        d_before = date(2026, 3, 7)
        d_after = date(2026, 3, 9)
        open_time = time(9, 30)

        before = get_market_open_utc(d_before, open_time, "America/New_York")
        after = get_market_open_utc(d_after, open_time, "America/New_York")

        # Before DST: 9:30 EST = 14:30 UTC
        assert before.hour == 14

        # After DST: 9:30 EDT = 13:30 UTC
        assert after.hour == 13


class TestTimezoneHandlerDST:
    """Tests for DST detection."""

    def test_is_dst_winter(self):
        """Winter should not be DST."""
        handler = TimezoneHandler("America/New_York")
        winter = datetime(2026, 1, 15, 12, 0, 0, tzinfo=NEW_YORK)

        assert handler.is_dst(winter) is False

    def test_is_dst_summer(self):
        """Summer should be DST."""
        handler = TimezoneHandler("America/New_York")
        summer = datetime(2026, 7, 15, 12, 0, 0, tzinfo=NEW_YORK)

        assert handler.is_dst(summer) is True
