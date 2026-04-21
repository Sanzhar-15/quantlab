"""
Market calendar module.

Provides:
- Calendar YAML schema and loading
- Built-in calendars (NYSE, NASDAQ, crypto_24_7)
- Custom calendar support
- Holiday and early close handling
- Annualization factor calculation

Spec Reference: Technical Spec §6
"""

from .builtin import CRYPTO_24_7
from .builtin import NASDAQ
from .builtin import NYSE
from .custom import CustomCalendar
from .custom import TradingSchedule
from .loader import CalendarLoader
from .loader import CalendarRegistry
from .loader import get_calendar
from .loader import register_calendar
from .schema import CalendarSchema
from .schema import DayType
from .schema import EarlyClose
from .schema import Holiday
from .schema import TradingDay
from .schema import TradingSession

__all__ = [
    # Schema types
    "DayType",
    "TradingSession",
    "TradingDay",
    "Holiday",
    "EarlyClose",
    "CalendarSchema",
    # Loaders
    "CalendarLoader",
    "CalendarRegistry",
    "get_calendar",
    "register_calendar",
    # Custom
    "CustomCalendar",
    "TradingSchedule",
    # Built-in calendars
    "NYSE",
    "NASDAQ",
    "CRYPTO_24_7",
]
