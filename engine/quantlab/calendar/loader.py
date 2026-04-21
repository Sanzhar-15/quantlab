"""
Calendar Loader.

Loads calendar definitions from YAML files.

Spec Reference: Technical Spec §6.2
"""

import json
from datetime import date
from datetime import time
from decimal import Decimal
from pathlib import Path
from typing import Any

from quantlab.calendar.schema import CalendarSchema
from quantlab.calendar.schema import EarlyClose
from quantlab.calendar.schema import Holiday
from quantlab.calendar.schema import TradingSession


def parse_time(time_str: str) -> time:
    """
    Parse time string.

    Supports formats: "HH:MM", "HH:MM:SS", "H:MM AM/PM"
    """
    time_str = time_str.strip()

    # Handle AM/PM format
    if "AM" in time_str.upper() or "PM" in time_str.upper():
        upper = time_str.upper()
        is_pm = "PM" in upper
        time_part = upper.replace("AM", "").replace("PM", "").strip()
        parts = time_part.split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0

        if is_pm and hour != 12:
            hour += 12
        elif not is_pm and hour == 12:
            hour = 0

        return time(hour, minute)

    # Handle 24-hour format
    parts = time_str.split(":")
    hour = int(parts[0])
    minute = int(parts[1]) if len(parts) > 1 else 0
    second = int(parts[2]) if len(parts) > 2 else 0

    return time(hour, minute, second)


def parse_date(date_str: str) -> date:
    """Parse date string in ISO format."""
    return date.fromisoformat(date_str)


class CalendarLoader:
    """
    Load calendar definitions from YAML/JSON files.

    Supports both YAML and JSON formats.
    """

    def __init__(self, calendar_dir: Path | str | None = None) -> None:
        """
        Initialize calendar loader.

        Args:
            calendar_dir: Directory containing calendar files
        """
        if calendar_dir:
            self.calendar_dir = Path(calendar_dir)
        else:
            # Default to builtin directory
            self.calendar_dir = Path(__file__).parent / "builtin"

    def _parse_yaml(self, content: str) -> dict[str, Any]:
        """
        Parse YAML content.

        Falls back to JSON if yaml not available.
        """
        try:
            import yaml
            return yaml.safe_load(content)
        except ImportError:
            # Try parsing as JSON
            return json.loads(content)

    def _parse_session(self, data: dict[str, Any]) -> TradingSession:
        """Parse trading session from dict."""
        return TradingSession(
            name=data.get("name", "regular"),
            start_time=parse_time(data["start"]),
            end_time=parse_time(data["end"]),
            is_regular=data.get("is_regular", True),
        )

    def _parse_holiday(self, data: dict[str, Any]) -> Holiday:
        """Parse holiday from dict."""
        return Holiday(
            name=data["name"],
            date=parse_date(data["date"]) if "date" in data else date(2000, 1, 1),
            observed_date=parse_date(data["observed_date"]) if data.get("observed_date") else None,
            recurring=data.get("recurring", False),
            month=data.get("month"),
            day=data.get("day"),
            weekday=data.get("weekday"),
            week=data.get("week"),
        )

    def _parse_early_close(self, data: dict[str, Any]) -> EarlyClose:
        """Parse early close from dict."""
        return EarlyClose(
            name=data["name"],
            date=parse_date(data["date"]) if "date" in data else date(2000, 1, 1),
            close_time=parse_time(data["close_time"]),
            recurring=data.get("recurring", False),
            month=data.get("month"),
            day=data.get("day"),
        )

    def _validate_calendar_data(self, data: dict[str, Any]) -> list[str]:
        """
        Validate calendar data structure.

        Returns list of validation errors (empty if valid).
        """
        errors = []

        # Required fields
        if "name" not in data:
            errors.append("Missing required field: name")

        # Validate trading days (must be weekday indices 0-6)
        trading_days = data.get("trading_days", [0, 1, 2, 3, 4])
        for day in trading_days:
            if not isinstance(day, int) or day < 0 or day > 6:
                errors.append(f"Invalid trading day: {day} (must be 0-6)")

        # Validate sessions
        for i, session in enumerate(data.get("regular_sessions", [])):
            if "start" not in session:
                errors.append(f"Session {i}: missing 'start' time")
            if "end" not in session:
                errors.append(f"Session {i}: missing 'end' time")
            if "start" in session and "end" in session:
                try:
                    start = parse_time(session["start"])
                    end = parse_time(session["end"])
                    if start >= end:
                        errors.append(
                            f"Session {i}: start time {session['start']} must be before "
                            f"end time {session['end']}"
                        )
                except (ValueError, KeyError) as e:
                    errors.append(f"Session {i}: invalid time format: {e}")

        # Validate holidays
        for i, holiday in enumerate(data.get("holidays", [])):
            if "name" not in holiday:
                errors.append(f"Holiday {i}: missing 'name'")
            if not holiday.get("recurring", False):
                if "date" not in holiday:
                    errors.append(f"Holiday {i} ({holiday.get('name', 'unnamed')}): "
                                  "non-recurring holiday requires 'date'")
            else:
                # Recurring holiday needs month+day or month+weekday+week
                has_fixed = "month" in holiday and "day" in holiday
                has_floating = "month" in holiday and "weekday" in holiday and "week" in holiday
                if not has_fixed and not has_floating:
                    errors.append(
                        f"Holiday {i} ({holiday.get('name', 'unnamed')}): "
                        "recurring holiday requires (month+day) or (month+weekday+week)"
                    )

        # Validate early closes
        for i, ec in enumerate(data.get("early_closes", [])):
            if "name" not in ec:
                errors.append(f"Early close {i}: missing 'name'")
            if "close_time" not in ec:
                errors.append(f"Early close {i}: missing 'close_time'")
            if not ec.get("recurring", False) and "date" not in ec:
                errors.append(f"Early close {i} ({ec.get('name', 'unnamed')}): "
                              "non-recurring early close requires 'date'")

        return errors

    def load_from_dict(self, data: dict[str, Any], validate: bool = True) -> CalendarSchema:
        """
        Load calendar from dictionary.

        Args:
            data: Calendar data dictionary
            validate: Whether to validate the data (default True)

        Returns:
            CalendarSchema

        Raises:
            ValueError: If validation fails
        """
        # Validate data structure
        if validate:
            errors = self._validate_calendar_data(data)
            if errors:
                import logging
                logger = logging.getLogger(__name__)
                for error in errors:
                    logger.error(f"Calendar validation error: {error}")
                raise ValueError(f"Calendar validation failed: {'; '.join(errors)}")
        # Parse regular sessions
        regular_sessions = []
        for session_data in data.get("regular_sessions", []):
            regular_sessions.append(self._parse_session(session_data))

        # If no sessions defined, create default
        if not regular_sessions and "regular_open" in data:
            regular_sessions = [
                TradingSession(
                    name="regular",
                    start_time=parse_time(data["regular_open"]),
                    end_time=parse_time(data["regular_close"]),
                    is_regular=True,
                )
            ]

        # Parse holidays
        holidays = []
        for holiday_data in data.get("holidays", []):
            holidays.append(self._parse_holiday(holiday_data))

        # Parse early closes
        early_closes = []
        for ec_data in data.get("early_closes", []):
            early_closes.append(self._parse_early_close(ec_data))

        # Parse extended hours
        pre_market = None
        if data.get("pre_market_session"):
            pre_market = self._parse_session(data["pre_market_session"])
            pre_market = TradingSession(
                name=pre_market.name,
                start_time=pre_market.start_time,
                end_time=pre_market.end_time,
                is_regular=False,
            )

        after_hours = None
        if data.get("after_hours_session"):
            after_hours = self._parse_session(data["after_hours_session"])
            after_hours = TradingSession(
                name=after_hours.name,
                start_time=after_hours.start_time,
                end_time=after_hours.end_time,
                is_regular=False,
            )

        return CalendarSchema(
            name=data["name"],
            code=data.get("code", data["name"].lower()),
            description=data.get("description", ""),
            timezone=data.get("timezone", "America/New_York"),
            regular_sessions=regular_sessions,
            trading_days=data.get("trading_days", [0, 1, 2, 3, 4]),
            holidays=holidays,
            early_closes=early_closes,
            trading_days_per_year=data.get("trading_days_per_year", 252),
            trading_hours_per_day=Decimal(str(data.get("trading_hours_per_day", "6.5"))),
            has_extended_hours=data.get("has_extended_hours", True),
            pre_market_session=pre_market,
            after_hours_session=after_hours,
            country=data.get("country", "US"),
            exchange=data.get("exchange", ""),
            mic_code=data.get("mic_code", ""),
        )

    def load_from_file(self, path: Path | str) -> CalendarSchema:
        """
        Load calendar from a file.

        Args:
            path: Path to calendar file (YAML or JSON)

        Returns:
            CalendarSchema
        """
        path = Path(path)

        with open(path) as f:
            content = f.read()

        if path.suffix in (".yaml", ".yml"):
            data = self._parse_yaml(content)
        else:
            data = json.loads(content)

        return self.load_from_dict(data)

    def load_builtin(self, name: str) -> CalendarSchema | None:
        """
        Load a built-in calendar by name.

        Args:
            name: Calendar name (e.g., "nyse", "nasdaq", "crypto")

        Returns:
            CalendarSchema or None if not found

        Note:
            Checks both Python-defined calendars (in builtin module) and
            YAML/JSON files in the calendar directory. Python-defined
            calendars take precedence.
        """
        # First, check Python-defined builtin calendars
        # FIX-3.4: Support both Python module calendars and data file calendars
        name_upper = name.upper().replace("-", "_").replace(" ", "_")
        name_lower = name.lower()

        try:
            from quantlab.calendar.builtin import NYSE, NASDAQ, CRYPTO_24_7

            builtin_map = {
                "nyse": NYSE,
                "nasdaq": NASDAQ,
                "crypto": CRYPTO_24_7,
                "crypto_24_7": CRYPTO_24_7,
            }

            if name_lower in builtin_map:
                return builtin_map[name_lower]
        except ImportError:
            pass  # Fall through to file-based loading

        # Try different file extensions
        for ext in (".yaml", ".yml", ".json"):
            path = self.calendar_dir / f"{name}{ext}"
            if path.exists():
                return self.load_from_file(path)

        return None

    def list_available(self) -> list[str]:
        """List available calendar names.

        Returns both Python-defined builtin calendars and any YAML/JSON
        calendar files in the calendar directory.
        """
        names = set()

        # Add Python-defined builtin calendars
        # FIX-3.4: Include builtin module calendars in listing
        try:
            from quantlab.calendar import builtin
            for name in builtin.__all__:
                names.add(name.lower())
        except (ImportError, AttributeError):
            pass

        # Add file-based calendars
        if self.calendar_dir.exists():
            for path in self.calendar_dir.iterdir():
                if path.suffix in (".yaml", ".yml", ".json"):
                    names.add(path.stem)

        return sorted(names)


class CalendarRegistry:
    """
    Registry of loaded calendars.

    Provides centralized access to calendars.
    """

    _instance: "CalendarRegistry | None" = None

    def __init__(self) -> None:
        self._calendars: dict[str, CalendarSchema] = {}
        self._loader = CalendarLoader()

    @classmethod
    def get_instance(cls) -> "CalendarRegistry":
        """Get singleton instance."""
        if cls._instance is None:
            cls._instance = CalendarRegistry()
        return cls._instance

    def register(self, calendar: CalendarSchema) -> None:
        """Register a calendar."""
        self._calendars[calendar.code] = calendar

    def get(self, code: str) -> CalendarSchema | None:
        """
        Get calendar by code.

        Loads from file if not already registered.
        """
        if code not in self._calendars:
            calendar = self._loader.load_builtin(code)
            if calendar:
                self._calendars[code] = calendar

        return self._calendars.get(code)

    def list_calendars(self) -> list[str]:
        """List all available calendar codes."""
        # Combine registered and available from files
        codes = set(self._calendars.keys())
        codes.update(self._loader.list_available())
        return sorted(codes)


def get_calendar(code: str) -> CalendarSchema | None:
    """
    Get calendar by code (convenience function).

    Args:
        code: Calendar code

    Returns:
        CalendarSchema or None
    """
    return CalendarRegistry.get_instance().get(code)


def register_calendar(calendar: CalendarSchema) -> None:
    """
    Register a calendar (convenience function).

    Args:
        calendar: Calendar to register
    """
    CalendarRegistry.get_instance().register(calendar)
