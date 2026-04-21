"""
Custom Calendar Support.

Allows users to define custom trading calendars.

Spec Reference: Technical Spec §6.4
"""

from datetime import date
from datetime import datetime
from datetime import time
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from quantlab.calendar.schema import CalendarSchema
from quantlab.calendar.schema import DayType
from quantlab.calendar.schema import EarlyClose
from quantlab.calendar.schema import Holiday
from quantlab.calendar.schema import TradingDay
from quantlab.calendar.schema import TradingSession


class CustomCalendar:
    """
    Custom calendar with flexible configuration.

    Allows defining arbitrary trading schedules.
    """

    def __init__(
        self,
        name: str,
        code: str,
        timezone: str = "UTC",
        description: str = "",
    ) -> None:
        """
        Initialize custom calendar.

        Args:
            name: Calendar name
            code: Short code
            timezone: Timezone string
            description: Description
        """
        self.name = name
        self.code = code
        self.timezone = timezone
        self.description = description

        self._regular_sessions: list[TradingSession] = []
        self._trading_days: list[int] = [0, 1, 2, 3, 4]  # Mon-Fri default
        self._holidays: list[Holiday] = []
        self._early_closes: list[EarlyClose] = []
        self._special_days: dict[date, TradingDay] = {}

        # Annualization
        self._trading_days_per_year: int = 252
        self._trading_hours_per_day: Decimal = Decimal("6.5")

        # Extended hours
        self._pre_market: TradingSession | None = None
        self._after_hours: TradingSession | None = None

    def set_regular_hours(
        self,
        open_time: time,
        close_time: time,
        session_name: str = "Regular",
    ) -> "CustomCalendar":
        """
        Set regular trading hours.

        Args:
            open_time: Market open time
            close_time: Market close time
            session_name: Session name

        Returns:
            Self for chaining
        """
        self._regular_sessions = [
            TradingSession(
                name=session_name,
                start_time=open_time,
                end_time=close_time,
                is_regular=True,
            )
        ]
        return self

    def add_session(
        self,
        name: str,
        start: time,
        end: time,
        is_regular: bool = False,
    ) -> "CustomCalendar":
        """
        Add a trading session.

        Args:
            name: Session name
            start: Start time
            end: End time
            is_regular: Whether this is regular hours

        Returns:
            Self for chaining
        """
        self._regular_sessions.append(
            TradingSession(
                name=name,
                start_time=start,
                end_time=end,
                is_regular=is_regular,
            )
        )
        return self

    def set_trading_days(self, days: list[int]) -> "CustomCalendar":
        """
        Set trading days of the week.

        Args:
            days: List of weekday numbers (0=Monday, 6=Sunday)

        Returns:
            Self for chaining
        """
        self._trading_days = days
        return self

    def add_holiday(
        self,
        name: str,
        month: int,
        day: int | None = None,
        weekday: int | None = None,
        week: int | None = None,
    ) -> "CustomCalendar":
        """
        Add a holiday.

        Args:
            name: Holiday name
            month: Month (1-12)
            day: Day of month (for fixed holidays)
            weekday: Day of week (0-6, for floating holidays)
            week: Week of month (1-5, for floating holidays)

        Returns:
            Self for chaining
        """
        self._holidays.append(
            Holiday(
                name=name,
                date=date(2000, 1, 1),  # Placeholder
                recurring=True,
                month=month,
                day=day,
                weekday=weekday,
                week=week,
            )
        )
        return self

    def add_one_time_holiday(
        self,
        name: str,
        holiday_date: date,
    ) -> "CustomCalendar":
        """
        Add a one-time holiday.

        Args:
            name: Holiday name
            holiday_date: Specific date

        Returns:
            Self for chaining
        """
        self._holidays.append(
            Holiday(
                name=name,
                date=holiday_date,
                recurring=False,
            )
        )
        return self

    def add_early_close(
        self,
        name: str,
        close_time: time,
        month: int,
        day: int,
    ) -> "CustomCalendar":
        """
        Add an early close day.

        Args:
            name: Early close name
            close_time: Close time on this day
            month: Month
            day: Day

        Returns:
            Self for chaining
        """
        self._early_closes.append(
            EarlyClose(
                name=name,
                date=date(2000, 1, 1),
                close_time=close_time,
                recurring=True,
                month=month,
                day=day,
            )
        )
        return self

    def add_special_day(
        self,
        trading_date: date,
        day_type: DayType,
        sessions: list[TradingSession] | None = None,
        note: str = "",
    ) -> "CustomCalendar":
        """
        Add a special trading day.

        Args:
            trading_date: The date
            day_type: Type of day
            sessions: Custom sessions for this day
            note: Note about the day

        Returns:
            Self for chaining
        """
        self._special_days[trading_date] = TradingDay(
            date=trading_date,
            day_type=day_type,
            sessions=sessions or [],
            note=note,
        )
        return self

    def set_extended_hours(
        self,
        pre_market_start: time | None = None,
        pre_market_end: time | None = None,
        after_hours_start: time | None = None,
        after_hours_end: time | None = None,
    ) -> "CustomCalendar":
        """
        Set extended hours.

        Args:
            pre_market_start: Pre-market session start
            pre_market_end: Pre-market session end
            after_hours_start: After-hours session start
            after_hours_end: After-hours session end

        Returns:
            Self for chaining
        """
        if pre_market_start and pre_market_end:
            self._pre_market = TradingSession(
                name="Pre-Market",
                start_time=pre_market_start,
                end_time=pre_market_end,
                is_regular=False,
            )

        if after_hours_start and after_hours_end:
            self._after_hours = TradingSession(
                name="After-Hours",
                start_time=after_hours_start,
                end_time=after_hours_end,
                is_regular=False,
            )

        return self

    def set_annualization(
        self,
        trading_days_per_year: int,
        trading_hours_per_day: Decimal,
    ) -> "CustomCalendar":
        """
        Set annualization parameters.

        Args:
            trading_days_per_year: Trading days per year
            trading_hours_per_day: Trading hours per day

        Returns:
            Self for chaining
        """
        self._trading_days_per_year = trading_days_per_year
        self._trading_hours_per_day = trading_hours_per_day
        return self

    def build(self) -> CalendarSchema:
        """
        Build the CalendarSchema.

        Returns:
            Complete CalendarSchema
        """
        return CalendarSchema(
            name=self.name,
            code=self.code,
            description=self.description,
            timezone=self.timezone,
            regular_sessions=self._regular_sessions,
            trading_days=self._trading_days,
            holidays=self._holidays,
            early_closes=self._early_closes,
            trading_days_per_year=self._trading_days_per_year,
            trading_hours_per_day=self._trading_hours_per_day,
            has_extended_hours=self._pre_market is not None or self._after_hours is not None,
            pre_market_session=self._pre_market,
            after_hours_session=self._after_hours,
        )

    def get_trading_day(self, d: date) -> TradingDay:
        """
        Get trading day information for a date.

        Args:
            d: Date to check

        Returns:
            TradingDay with full schedule info
        """
        # Check special days first
        if d in self._special_days:
            return self._special_days[d]

        # Build calendar schema for checks
        schema = self.build()

        # Check weekend
        if d.weekday() not in self._trading_days:
            return TradingDay(
                date=d,
                day_type=DayType.WEEKEND,
                sessions=[],
            )

        # Check holiday
        if schema.is_holiday(d):
            return TradingDay(
                date=d,
                day_type=DayType.HOLIDAY,
                sessions=[],
            )

        # Check early close
        early_close = schema.get_early_close_time(d)
        if early_close:
            sessions = [
                TradingSession(
                    name="Regular",
                    start_time=self._regular_sessions[0].start_time if self._regular_sessions else time(9, 30),
                    end_time=early_close,
                    is_regular=True,
                )
            ]
            return TradingDay(
                date=d,
                day_type=DayType.EARLY_CLOSE,
                sessions=sessions,
            )

        # Regular day
        return TradingDay(
            date=d,
            day_type=DayType.REGULAR,
            sessions=self._regular_sessions.copy(),
        )


class TradingSchedule:
    """
    Generate trading schedule from calendar.

    Provides iteration over trading days.
    """

    def __init__(self, calendar: CalendarSchema) -> None:
        """
        Initialize trading schedule.

        Args:
            calendar: Calendar schema
        """
        self.calendar = calendar

    def trading_days(
        self,
        start: date,
        end: date,
    ) -> list[date]:
        """
        Get list of trading days in range.

        Args:
            start: Start date (inclusive)
            end: End date (inclusive)

        Returns:
            List of trading dates
        """
        days = []
        current = start

        while current <= end:
            if self.calendar.is_trading_day(current):
                days.append(current)
            current = date.fromordinal(current.toordinal() + 1)

        return days

    def next_trading_day(self, d: date) -> date:
        """
        Get next trading day after date.

        Args:
            d: Reference date

        Returns:
            Next trading date
        """
        next_day = date.fromordinal(d.toordinal() + 1)

        while not self.calendar.is_trading_day(next_day):
            next_day = date.fromordinal(next_day.toordinal() + 1)

        return next_day

    def prev_trading_day(self, d: date) -> date:
        """
        Get previous trading day before date.

        Args:
            d: Reference date

        Returns:
            Previous trading date
        """
        prev_day = date.fromordinal(d.toordinal() - 1)

        while not self.calendar.is_trading_day(prev_day):
            prev_day = date.fromordinal(prev_day.toordinal() - 1)

        return prev_day

    def trading_day_offset(self, d: date, offset: int) -> date:
        """
        Get trading day offset from date.

        Args:
            d: Reference date
            offset: Number of trading days (+/-)

        Returns:
            Offset trading date
        """
        if offset == 0:
            return d

        current = d
        remaining = abs(offset)
        step = 1 if offset > 0 else -1

        while remaining > 0:
            current = date.fromordinal(current.toordinal() + step)
            if self.calendar.is_trading_day(current):
                remaining -= 1

        return current

    def count_trading_days(self, start: date, end: date) -> int:
        """
        Count trading days between dates.

        Args:
            start: Start date (inclusive)
            end: End date (exclusive)

        Returns:
            Number of trading days
        """
        return len(self.trading_days(start, date.fromordinal(end.toordinal() - 1)))
