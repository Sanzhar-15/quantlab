"""
Calendar Schema Definitions.

Defines data structures for market calendars and trading schedules.

Spec Reference: Technical Spec §6.1
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import date
from datetime import datetime
from datetime import time
from datetime import timedelta
from decimal import Decimal
from enum import Enum
from typing import Any
from zoneinfo import ZoneInfo


class DayType(Enum):
    """Types of trading days."""

    REGULAR = "regular"  # Normal trading day
    EARLY_CLOSE = "early_close"  # Shortened hours
    LATE_OPEN = "late_open"  # Delayed opening
    HOLIDAY = "holiday"  # Market closed
    WEEKEND = "weekend"  # Weekend closure
    SPECIAL = "special"  # Other special schedule


@dataclass
class TradingSession:
    """
    Single trading session within a day.

    Markets may have multiple sessions (pre-market, regular, after-hours).
    """

    name: str
    start_time: time
    end_time: time
    is_regular: bool = True  # Regular hours (vs extended)

    @property
    def duration(self) -> timedelta:
        """Session duration."""
        start_dt = datetime.combine(date.today(), self.start_time)
        end_dt = datetime.combine(date.today(), self.end_time)
        if end_dt < start_dt:
            end_dt += timedelta(days=1)  # Crosses midnight
        return end_dt - start_dt

    @property
    def duration_hours(self) -> Decimal:
        """Session duration in hours."""
        return Decimal(str(self.duration.total_seconds() / 3600))

    def contains(self, t: time) -> bool:
        """Check if time is within session."""
        if self.end_time < self.start_time:
            # Crosses midnight
            return t >= self.start_time or t <= self.end_time
        return self.start_time <= t <= self.end_time

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "start": self.start_time.isoformat(),
            "end": self.end_time.isoformat(),
            "is_regular": self.is_regular,
        }


@dataclass
class TradingDay:
    """
    Trading day specification.

    Defines the schedule for a single day.
    """

    date: date
    day_type: DayType
    sessions: list[TradingSession] = field(default_factory=list)
    note: str = ""

    @property
    def is_trading_day(self) -> bool:
        """Check if market is open at all."""
        return self.day_type not in (DayType.HOLIDAY, DayType.WEEKEND)

    @property
    def regular_session(self) -> TradingSession | None:
        """Get the regular trading session."""
        for session in self.sessions:
            if session.is_regular:
                return session
        return None

    @property
    def open_time(self) -> time | None:
        """Market open time."""
        if not self.sessions:
            return None
        return self.sessions[0].start_time

    @property
    def close_time(self) -> time | None:
        """Market close time."""
        if not self.sessions:
            return None
        return self.sessions[-1].end_time

    @property
    def total_trading_hours(self) -> Decimal:
        """Total trading hours in the day."""
        return sum(
            (s.duration_hours for s in self.sessions),
            Decimal("0"),
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "date": self.date.isoformat(),
            "day_type": self.day_type.value,
            "sessions": [s.to_dict() for s in self.sessions],
            "note": self.note,
        }


@dataclass
class Holiday:
    """
    Holiday definition.

    Holidays are days when the market is closed.
    """

    name: str
    date: date
    observed_date: date | None = None  # When observed if different
    recurring: bool = False  # True for annual holidays
    month: int | None = None  # For recurring
    day: int | None = None  # For recurring
    weekday: int | None = None  # 0=Mon, 4=Fri for floating holidays
    week: int | None = None  # Week of month for floating holidays

    def get_date_for_year(self, year: int) -> date:
        """
        Get holiday date for a specific year.

        Handles observed dates (moved to Monday if on weekend).
        """
        if not self.recurring:
            return self.date

        if self.month is None:
            return self.date

        # Fixed date holiday
        if self.day is not None:
            actual_date = date(year, self.month, self.day)
        elif self.weekday is not None and self.week is not None:
            # Floating holiday (e.g., 3rd Monday)
            first_of_month = date(year, self.month, 1)
            days_to_weekday = (self.weekday - first_of_month.weekday()) % 7
            first_weekday = first_of_month + timedelta(days=days_to_weekday)
            actual_date = first_weekday + timedelta(weeks=self.week - 1)
        else:
            return self.date

        # Check for weekend and observe on Monday/Friday
        if actual_date.weekday() == 5:  # Saturday
            actual_date -= timedelta(days=1)  # Friday
        elif actual_date.weekday() == 6:  # Sunday
            actual_date += timedelta(days=1)  # Monday

        return actual_date

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "date": self.date.isoformat(),
            "observed_date": self.observed_date.isoformat() if self.observed_date else None,
            "recurring": self.recurring,
            "month": self.month,
            "day": self.day,
            "weekday": self.weekday,
            "week": self.week,
        }


@dataclass
class EarlyClose:
    """
    Early close definition.

    Days when market closes before normal time.
    """

    name: str
    date: date
    close_time: time
    recurring: bool = False
    month: int | None = None
    day: int | None = None
    weekday: int | None = None  # 0=Mon, 4=Fri for floating early closes
    week: int | None = None  # Week of month for floating early closes

    def get_date_for_year(self, year: int) -> date:
        """Get early close date for a specific year."""
        if not self.recurring or self.month is None:
            return self.date

        # Fixed day early close (e.g., July 3rd)
        if self.day is not None:
            return date(year, self.month, self.day)

        # Floating early close (e.g., "Friday after 4th Thursday in November")
        if self.weekday is not None and self.week is not None:
            # Find first day of month
            first_day = date(year, self.month, 1)
            first_weekday = first_day.weekday()

            # Days until target weekday
            days_until_weekday = (self.weekday - first_weekday) % 7

            # Calculate date of nth occurrence
            target_date = first_day + timedelta(days=days_until_weekday + 7 * (self.week - 1))

            return target_date

        return self.date

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "date": self.date.isoformat(),
            "close_time": self.close_time.isoformat(),
            "recurring": self.recurring,
        }


@dataclass
class CalendarSchema:
    """
    Complete market calendar schema.

    Defines all trading rules for a market.
    """

    # Identification
    name: str
    code: str  # Short code (e.g., "nyse", "nasdaq")
    description: str = ""

    # Timezone
    timezone: str = "America/New_York"

    # Regular schedule
    regular_sessions: list[TradingSession] = field(default_factory=list)
    trading_days: list[int] = field(default_factory=lambda: [0, 1, 2, 3, 4])  # Mon-Fri

    # Holidays and special days
    holidays: list[Holiday] = field(default_factory=list)
    early_closes: list[EarlyClose] = field(default_factory=list)

    # Annualization
    trading_days_per_year: int = 252
    trading_hours_per_day: Decimal = Decimal("6.5")

    # Extended hours
    has_extended_hours: bool = True
    pre_market_session: TradingSession | None = None
    after_hours_session: TradingSession | None = None

    # Metadata
    country: str = "US"
    exchange: str = ""
    mic_code: str = ""  # Market Identifier Code

    @property
    def tz(self) -> ZoneInfo:
        """Get timezone object."""
        return ZoneInfo(self.timezone)

    @property
    def regular_open(self) -> time | None:
        """Regular market open time."""
        for session in self.regular_sessions:
            if session.is_regular:
                return session.start_time
        return None

    @property
    def regular_close(self) -> time | None:
        """Regular market close time."""
        for session in self.regular_sessions:
            if session.is_regular:
                return session.end_time
        return None

    def is_holiday(self, d: date) -> bool:
        """Check if date is a holiday."""
        for holiday in self.holidays:
            if holiday.recurring:
                if holiday.get_date_for_year(d.year) == d:
                    return True
            elif holiday.date == d or holiday.observed_date == d:
                return True
        return False

    def get_early_close_time(self, d: date) -> time | None:
        """Get early close time for date if applicable."""
        for early_close in self.early_closes:
            if early_close.recurring:
                if early_close.get_date_for_year(d.year) == d:
                    return early_close.close_time
            elif early_close.date == d:
                return early_close.close_time
        return None

    def is_trading_day(self, d: date) -> bool:
        """Check if date is a trading day."""
        # Check weekend
        if d.weekday() not in self.trading_days:
            return False
        # Check holiday
        if self.is_holiday(d):
            return False
        return True

    def annualization_factor(self, timeframe: str = "1d") -> Decimal:
        """
        Get annualization factor for returns/volatility.

        Args:
            timeframe: Bar timeframe

        Returns:
            Annualization factor (sqrt of periods per year)
        """
        import math

        if timeframe == "1d":
            periods = self.trading_days_per_year
        elif timeframe.endswith("h"):
            hours = int(timeframe[:-1])
            periods_per_day = float(self.trading_hours_per_day) / hours
            periods = int(self.trading_days_per_year * periods_per_day)
        elif timeframe.endswith("m"):
            minutes = int(timeframe[:-1])
            periods_per_day = float(self.trading_hours_per_day) * 60 / minutes
            periods = int(self.trading_days_per_year * periods_per_day)
        else:
            periods = self.trading_days_per_year

        return Decimal(str(math.sqrt(periods)))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "code": self.code,
            "description": self.description,
            "timezone": self.timezone,
            "regular_sessions": [s.to_dict() for s in self.regular_sessions],
            "trading_days": self.trading_days,
            "holidays": [h.to_dict() for h in self.holidays],
            "early_closes": [e.to_dict() for e in self.early_closes],
            "trading_days_per_year": self.trading_days_per_year,
            "trading_hours_per_day": str(self.trading_hours_per_day),
            "has_extended_hours": self.has_extended_hours,
            "pre_market_session": self.pre_market_session.to_dict() if self.pre_market_session else None,
            "after_hours_session": self.after_hours_session.to_dict() if self.after_hours_session else None,
            "country": self.country,
            "exchange": self.exchange,
            "mic_code": self.mic_code,
        }
