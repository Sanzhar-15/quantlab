"""
NASDAQ Calendar.

NASDAQ Stock Market trading calendar.

Spec Reference: Technical Spec §6.3
"""

from datetime import time
from decimal import Decimal

from quantlab.calendar.schema import CalendarSchema
from quantlab.calendar.schema import EarlyClose
from quantlab.calendar.schema import Holiday
from quantlab.calendar.schema import TradingSession


# NASDAQ follows the same holiday schedule as NYSE
def _create_nasdaq_holidays() -> list[Holiday]:
    """Create list of NASDAQ holidays (same as NYSE)."""
    return [
        Holiday(
            name="New Year's Day",
            date=None,  # type: ignore
            recurring=True,
            month=1,
            day=1,
        ),
        Holiday(
            name="Independence Day",
            date=None,  # type: ignore
            recurring=True,
            month=7,
            day=4,
        ),
        Holiday(
            name="Christmas Day",
            date=None,  # type: ignore
            recurring=True,
            month=12,
            day=25,
        ),
        Holiday(
            name="Martin Luther King Jr. Day",
            date=None,  # type: ignore
            recurring=True,
            month=1,
            weekday=0,
            week=3,
        ),
        Holiday(
            name="Presidents' Day",
            date=None,  # type: ignore
            recurring=True,
            month=2,
            weekday=0,
            week=3,
        ),
        Holiday(
            name="Memorial Day",
            date=None,  # type: ignore
            recurring=True,
            month=5,
            weekday=0,
            week=5,
        ),
        Holiday(
            name="Juneteenth",
            date=None,  # type: ignore
            recurring=True,
            month=6,
            day=19,
        ),
        Holiday(
            name="Labor Day",
            date=None,  # type: ignore
            recurring=True,
            month=9,
            weekday=0,
            week=1,
        ),
        Holiday(
            name="Thanksgiving Day",
            date=None,  # type: ignore
            recurring=True,
            month=11,
            weekday=3,
            week=4,
        ),
    ]


def _create_nasdaq_early_closes() -> list[EarlyClose]:
    """Create list of NASDAQ early close days."""
    return [
        EarlyClose(
            name="Day before Independence Day",
            date=None,  # type: ignore
            close_time=time(13, 0),
            recurring=True,
            month=7,
            day=3,
        ),
        EarlyClose(
            name="Day after Thanksgiving",
            date=None,  # type: ignore
            close_time=time(13, 0),
            recurring=True,
            month=11,
            weekday=4,  # Friday (0=Mon, 4=Fri)
            week=4,  # 4th Friday (day after 4th Thursday)
        ),
        EarlyClose(
            name="Christmas Eve",
            date=None,  # type: ignore
            close_time=time(13, 0),
            recurring=True,
            month=12,
            day=24,
        ),
    ]


# Create the NASDAQ calendar instance
NASDAQ = CalendarSchema(
    name="NASDAQ Stock Market",
    code="nasdaq",
    description="NASDAQ regular trading hours",
    timezone="America/New_York",
    regular_sessions=[
        TradingSession(
            name="Regular",
            start_time=time(9, 30),
            end_time=time(16, 0),
            is_regular=True,
        ),
    ],
    trading_days=[0, 1, 2, 3, 4],  # Monday-Friday
    holidays=_create_nasdaq_holidays(),
    early_closes=_create_nasdaq_early_closes(),
    trading_days_per_year=252,
    trading_hours_per_day=Decimal("6.5"),
    has_extended_hours=True,
    pre_market_session=TradingSession(
        name="Pre-Market",
        start_time=time(4, 0),
        end_time=time(9, 30),
        is_regular=False,
    ),
    after_hours_session=TradingSession(
        name="After-Hours",
        start_time=time(16, 0),
        end_time=time(20, 0),
        is_regular=False,
    ),
    country="US",
    exchange="NASDAQ",
    mic_code="XNAS",
)
