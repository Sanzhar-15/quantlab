"""
Crypto Calendar.

24/7 cryptocurrency trading calendar.

Spec Reference: Technical Spec §6.3
"""

from datetime import time
from decimal import Decimal

from quantlab.calendar.schema import CalendarSchema
from quantlab.calendar.schema import TradingSession


# Create the 24/7 crypto calendar instance
CRYPTO_24_7 = CalendarSchema(
    name="Cryptocurrency Markets",
    code="crypto_24_7",
    description="24/7 cryptocurrency trading - no holidays or closures",
    timezone="UTC",
    regular_sessions=[
        TradingSession(
            name="Continuous",
            start_time=time(0, 0),
            end_time=time(23, 59, 59),
            is_regular=True,
        ),
    ],
    trading_days=[0, 1, 2, 3, 4, 5, 6],  # Every day
    holidays=[],  # No holidays
    early_closes=[],  # No early closes
    trading_days_per_year=365,
    trading_hours_per_day=Decimal("24"),
    has_extended_hours=False,  # Always open
    pre_market_session=None,
    after_hours_session=None,
    country="",  # Global
    exchange="CRYPTO",
    mic_code="",
)


# Alternative crypto calendars for different conventions

CRYPTO_DAILY = CalendarSchema(
    name="Cryptocurrency Daily",
    code="crypto_daily",
    description="Cryptocurrency with daily bar convention (UTC midnight close)",
    timezone="UTC",
    regular_sessions=[
        TradingSession(
            name="Daily",
            start_time=time(0, 0),
            end_time=time(23, 59, 59),
            is_regular=True,
        ),
    ],
    trading_days=[0, 1, 2, 3, 4, 5, 6],
    holidays=[],
    early_closes=[],
    trading_days_per_year=365,
    trading_hours_per_day=Decimal("24"),
    has_extended_hours=False,
    country="",
    exchange="CRYPTO",
    mic_code="",
)


CRYPTO_CME = CalendarSchema(
    name="CME Bitcoin Futures",
    code="crypto_cme",
    description="CME Bitcoin futures trading hours",
    timezone="America/Chicago",
    regular_sessions=[
        TradingSession(
            name="Regular",
            start_time=time(17, 0),  # 5 PM Sunday
            end_time=time(16, 0),  # 4 PM Friday
            is_regular=True,
        ),
    ],
    trading_days=[0, 1, 2, 3, 4],  # Monday-Friday
    holidays=[],  # CME has some holidays
    early_closes=[],
    trading_days_per_year=252,
    trading_hours_per_day=Decimal("23"),  # 23 hours per day
    has_extended_hours=False,
    country="US",
    exchange="CME",
    mic_code="XCME",
)
