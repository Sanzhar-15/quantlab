"""
Tests for Calendar System.

Tests trading calendars, holidays, and timezone handling.
"""

from datetime import date
from datetime import datetime
from datetime import time
from datetime import timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from quantlab.calendar import (
    CalendarSchema,
    CRYPTO_24_7,
    CustomCalendar,
    DayType,
    Holiday,
    NASDAQ,
    NYSE,
    TradingSession,
)


class TestTradingSession:
    """Tests for TradingSession dataclass."""

    def test_trading_session_creation(self) -> None:
        """Test creating a trading session."""
        session = TradingSession(
            name="Regular",
            start_time=time(9, 30),
            end_time=time(16, 0),
        )

        assert session.start_time == time(9, 30)
        assert session.end_time == time(16, 0)

    def test_session_duration(self) -> None:
        """Test calculating session duration."""
        session = TradingSession(
            name="Regular",
            start_time=time(9, 30),
            end_time=time(16, 0),
        )

        duration = session.duration
        # 6.5 hours
        assert duration == timedelta(hours=6, minutes=30)

    def test_session_contains(self) -> None:
        """Test checking if time is within session."""
        session = TradingSession(
            name="Regular",
            start_time=time(9, 30),
            end_time=time(16, 0),
        )

        assert session.contains(time(10, 0))
        assert session.contains(time(15, 59))
        assert not session.contains(time(8, 0))
        assert not session.contains(time(17, 0))


class TestHoliday:
    """Tests for Holiday dataclass."""

    def test_fixed_date_holiday(self) -> None:
        """Test fixed date holiday."""
        holiday = Holiday(
            name="Independence Day",
            date=date(2026, 7, 4),
            recurring=True,
            month=7,
            day=4,
        )

        assert holiday.name == "Independence Day"
        assert holiday.recurring is True

    def test_floating_holiday(self) -> None:
        """Test floating holiday (e.g., Thanksgiving)."""
        holiday = Holiday(
            name="Thanksgiving",
            date=None,  # type: ignore
            recurring=True,
            month=11,
            weekday=3,  # Thursday
            week=4,  # Fourth Thursday
        )

        # Get 2026 Thanksgiving
        thanksgiving_2026 = holiday.get_date_for_year(2026)
        assert thanksgiving_2026.month == 11
        assert thanksgiving_2026.weekday() == 3  # Thursday


class TestCalendarSchema:
    """Tests for CalendarSchema."""

    def test_trading_days_per_year(self) -> None:
        """Test default trading days per year."""
        assert NYSE.trading_days_per_year == 252

    def test_trading_hours_per_day(self) -> None:
        """Test default trading hours per day."""
        assert NYSE.trading_hours_per_day == Decimal("6.5")

    def test_annualization_factor_daily(self) -> None:
        """Test annualization factor for daily data."""
        factor = NYSE.annualization_factor("1d")

        # sqrt(252) ≈ 15.87
        expected = Decimal("252").sqrt()
        assert abs(factor - expected) < Decimal("0.01")

    def test_annualization_factor_hourly(self) -> None:
        """Test annualization factor for hourly data."""
        factor = NYSE.annualization_factor("1h")

        # sqrt(252 * 6.5) ≈ 40.48
        periods = Decimal("252") * Decimal("6.5")
        expected = periods.sqrt()
        assert abs(factor - expected) < Decimal("0.1")

    def test_annualization_factor_minute(self) -> None:
        """Test annualization factor for minute data."""
        factor = NYSE.annualization_factor("1m")

        # sqrt(252 * 390) ≈ 313.57
        periods = Decimal("252") * Decimal("390")  # 6.5 hours * 60 minutes
        expected = periods.sqrt()
        assert abs(factor - expected) < Decimal("1")


class TestNYSECalendar:
    """Tests for NYSE calendar."""

    def test_is_trading_day_weekday(self) -> None:
        """Test that weekdays are trading days."""
        # Wednesday, Jan 15, 2026
        assert NYSE.is_trading_day(date(2026, 1, 15))

    def test_is_not_trading_day_weekend(self) -> None:
        """Test that weekends are not trading days."""
        # Saturday, Jan 17, 2026
        assert not NYSE.is_trading_day(date(2026, 1, 17))
        # Sunday, Jan 18, 2026
        assert not NYSE.is_trading_day(date(2026, 1, 18))

    def test_is_not_trading_day_holiday(self) -> None:
        """Test that holidays are not trading days."""
        # New Year's Day 2026
        assert not NYSE.is_trading_day(date(2026, 1, 1))

    def test_regular_open_close_times(self) -> None:
        """Test NYSE regular hours."""
        assert NYSE.regular_open == time(9, 30)
        assert NYSE.regular_close == time(16, 0)

    def test_has_extended_hours(self) -> None:
        """Test NYSE has extended hours."""
        assert NYSE.has_extended_hours is True
        assert NYSE.pre_market_session is not None
        assert NYSE.after_hours_session is not None


class TestNASDAQCalendar:
    """Tests for NASDAQ calendar."""

    def test_nasdaq_same_hours_as_nyse(self) -> None:
        """Test NASDAQ has same hours as NYSE."""
        assert NASDAQ.regular_open == NYSE.regular_open
        assert NASDAQ.regular_close == NYSE.regular_close


class TestCryptoCalendar:
    """Tests for 24/7 crypto calendar."""

    def test_crypto_always_trading(self) -> None:
        """Test crypto markets are always open."""
        # Test various dates including weekends
        assert CRYPTO_24_7.is_trading_day(date(2026, 1, 17))  # Saturday
        assert CRYPTO_24_7.is_trading_day(date(2026, 1, 18))  # Sunday
        assert CRYPTO_24_7.is_trading_day(date(2026, 12, 25))  # Christmas

    def test_crypto_trading_days_per_year(self) -> None:
        """Test crypto has 365 trading days."""
        assert CRYPTO_24_7.trading_days_per_year == 365

    def test_crypto_trading_hours_per_day(self) -> None:
        """Test crypto has 24 trading hours."""
        assert CRYPTO_24_7.trading_hours_per_day == Decimal("24")

    def test_crypto_no_extended_hours(self) -> None:
        """Test crypto doesn't have extended hours (always open)."""
        assert CRYPTO_24_7.has_extended_hours is False


class TestCustomCalendar:
    """Tests for custom calendar."""

    def test_create_custom_calendar(self) -> None:
        """Test creating a custom calendar with builder pattern."""
        builder = CustomCalendar(
            name="Test Exchange",
            code="test",
            timezone="America/New_York",
        )
        builder.set_regular_hours(time(9, 0), time(17, 0))
        builder.set_annualization(250, Decimal("8"))

        calendar = builder.build()

        assert calendar.name == "Test Exchange"
        assert calendar.regular_open == time(9, 0)
        assert calendar.regular_close == time(17, 0)

    def test_custom_calendar_with_holidays(self) -> None:
        """Test custom calendar with custom holidays."""
        builder = CustomCalendar(
            name="Test Exchange",
            code="test",
            timezone="America/New_York",
        )
        builder.set_regular_hours(time(9, 0), time(17, 0))
        builder.add_one_time_holiday("Founders Day", date(2026, 6, 15))

        calendar = builder.build()

        assert not calendar.is_trading_day(date(2026, 6, 15))
        assert calendar.is_trading_day(date(2026, 6, 16))  # Next day


class TestTimezoneHandling:
    """Tests for timezone conversions."""

    def test_calendar_timezone(self) -> None:
        """Test NYSE is in Eastern timezone."""
        assert NYSE.timezone == "America/New_York"
        assert NYSE.tz == ZoneInfo("America/New_York")

    def test_crypto_utc(self) -> None:
        """Test crypto calendar is UTC."""
        assert CRYPTO_24_7.timezone == "UTC"
        assert CRYPTO_24_7.tz == ZoneInfo("UTC")
