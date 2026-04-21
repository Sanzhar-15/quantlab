"""
CSV Data Loader.

Provides loading of market data from CSV files.

Supports various CSV formats with configurable column mapping.
"""

import csv
import logging
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from pathlib import Path
from typing import Iterator

from quantlab.providers.base import Bar


logger = logging.getLogger(__name__)


class CSVLoaderError(Exception):
    """Error loading CSV data."""
    pass


class CSVLoader:
    """
    Load market data from CSV files.

    Supports:
    - Various date formats
    - Column mapping for different schemas
    - Date filtering
    - Lazy loading via iterator

    Usage:
        loader = CSVLoader("data/SPY.csv")
        bars = loader.load_bars(
            symbol="SPY",
            start=datetime(2023, 1, 1),
            end=datetime(2023, 12, 31),
        )
    """

    # Default column mappings (lowercase variations)
    DEFAULT_COLUMN_MAP = {
        "timestamp": ["timestamp", "date", "datetime", "time", "Date", "DateTime", "DATE"],
        "open": ["open", "Open", "o", "OPEN"],
        "high": ["high", "High", "h", "HIGH"],
        "low": ["low", "Low", "l", "LOW"],
        "close": ["close", "Close", "c", "CLOSE", "adj_close", "Adj Close", "adj close"],
        "volume": ["volume", "Volume", "v", "VOLUME", "vol", "Vol"],
    }

    # Common date formats to try
    DATE_FORMATS = [
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%m/%d/%Y",
        "%m/%d/%Y %H:%M:%S",
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%Y%m%d",
    ]

    def __init__(
        self,
        path: Path | str,
        column_map: dict[str, list[str]] | None = None,
        date_format: str | None = None,
        delimiter: str = ",",
    ) -> None:
        """
        Initialize CSV loader.

        Args:
            path: Path to CSV file
            column_map: Optional custom column name mappings
            date_format: Optional specific date format (auto-detected if None)
            delimiter: CSV delimiter (default: comma)
        """
        self.path = Path(path)
        self.column_map = column_map or self.DEFAULT_COLUMN_MAP
        self.date_format = date_format
        self.delimiter = delimiter
        self._detected_date_format: str | None = None
        self._column_indices: dict[str, int] = {}

        if not self.path.exists():
            raise CSVLoaderError(f"CSV file not found: {self.path}")

    def _find_column_index(self, headers: list[str], field: str) -> int | None:
        """Find column index for a field using the column map."""
        candidates = self.column_map.get(field, [field])
        for candidate in candidates:
            if candidate in headers:
                return headers.index(candidate)
            # Case-insensitive fallback
            for i, h in enumerate(headers):
                if h.lower() == candidate.lower():
                    return i
        return None

    def _parse_date(self, date_str: str) -> datetime:
        """Parse date string, auto-detecting format if needed."""
        date_str = date_str.strip()

        # Check for Unix epoch timestamp (integer or float)
        if self._detected_date_format == "__epoch__":
            return datetime.fromtimestamp(float(date_str), tz=timezone.utc)

        try:
            epoch = float(date_str)
            # Heuristic: if it looks like a Unix timestamp (> year 2000 in seconds)
            if epoch > 946684800 and date_str.replace(".", "").replace("-", "").isdigit():
                self._detected_date_format = "__epoch__"
                return datetime.fromtimestamp(epoch, tz=timezone.utc)
        except (ValueError, OverflowError):
            pass

        # Use detected format if available
        if self._detected_date_format:
            try:
                return datetime.strptime(date_str, self._detected_date_format)
            except ValueError:
                pass  # Fall through to auto-detect

        # Use specified format
        if self.date_format:
            return datetime.strptime(date_str, self.date_format)

        # Auto-detect format
        for fmt in self.DATE_FORMATS:
            try:
                result = datetime.strptime(date_str, fmt)
                self._detected_date_format = fmt  # Cache for future rows
                return result
            except ValueError:
                continue

        raise CSVLoaderError(f"Could not parse date: {date_str}")

    def _parse_decimal(self, value: str) -> Decimal:
        """Parse string to Decimal, handling common formats."""
        value = value.strip().replace(",", "")
        if not value or value.lower() in ("nan", "null", ""):
            return Decimal("0")
        return Decimal(value)

    def _parse_int(self, value: str) -> int:
        """Parse string to int, handling common formats."""
        value = value.strip().replace(",", "")
        if not value or value.lower() in ("nan", "null", ""):
            return 0
        # Handle float strings like "1000000.0"
        return int(float(value))

    def load_bars(
        self,
        symbol: str,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[Bar]:
        """
        Load bars from CSV file.

        Args:
            symbol: Symbol name to assign to bars
            start: Optional start date filter
            end: Optional end date filter

        Returns:
            List of Bar objects
        """
        return list(self.iter_bars(symbol, start, end))

    def iter_bars(
        self,
        symbol: str,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> Iterator[Bar]:
        """
        Iterate over bars from CSV file.

        Args:
            symbol: Symbol name to assign to bars
            start: Optional start date filter
            end: Optional end date filter

        Yields:
            Bar objects
        """
        with open(self.path, "r", newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f, delimiter=self.delimiter)

            # Read and process headers
            headers = next(reader)
            headers = [h.strip() for h in headers]

            # Find required columns
            ts_idx = self._find_column_index(headers, "timestamp")
            open_idx = self._find_column_index(headers, "open")
            high_idx = self._find_column_index(headers, "high")
            low_idx = self._find_column_index(headers, "low")
            close_idx = self._find_column_index(headers, "close")
            volume_idx = self._find_column_index(headers, "volume")

            if ts_idx is None:
                raise CSVLoaderError(f"Could not find timestamp column. Headers: {headers}")
            if close_idx is None:
                raise CSVLoaderError(f"Could not find close column. Headers: {headers}")

            # Read data rows
            for row_num, row in enumerate(reader, start=2):
                try:
                    if len(row) < max(ts_idx, close_idx) + 1:
                        continue  # Skip incomplete rows

                    timestamp = self._parse_date(row[ts_idx])

                    # Apply date filters
                    if start and timestamp < start:
                        continue
                    if end and timestamp > end:
                        continue

                    # Parse OHLCV (use close for missing O/H/L)
                    close = self._parse_decimal(row[close_idx])
                    open_price = self._parse_decimal(row[open_idx]) if open_idx is not None else close
                    high = self._parse_decimal(row[high_idx]) if high_idx is not None else close
                    low = self._parse_decimal(row[low_idx]) if low_idx is not None else close
                    volume = self._parse_int(row[volume_idx]) if volume_idx is not None else 0

                    yield Bar(
                        symbol=symbol,
                        timestamp=timestamp,
                        open=open_price,
                        high=high,
                        low=low,
                        close=close,
                        volume=volume,
                    )

                except Exception as e:
                    logger.warning(f"Error parsing row {row_num}: {e}")
                    continue

    def get_date_range(self) -> tuple[datetime, datetime] | None:
        """
        Get the date range of data in the file.

        Returns:
            Tuple of (start_date, end_date) or None if file is empty
        """
        first_date = None
        last_date = None

        for bar in self.iter_bars(symbol=""):
            if first_date is None:
                first_date = bar.timestamp
            last_date = bar.timestamp

        if first_date and last_date:
            return (first_date, last_date)
        return None

    def get_row_count(self) -> int:
        """Get approximate row count (excluding header)."""
        with open(self.path, "r") as f:
            return sum(1 for _ in f) - 1


def load_csv(
    path: str | Path,
    symbol: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    **kwargs,
) -> list[Bar]:
    """
    Convenience function to load bars from CSV.

    Args:
        path: Path to CSV file
        symbol: Symbol name (defaults to filename without extension)
        start: Optional start date filter
        end: Optional end date filter
        **kwargs: Additional arguments passed to CSVLoader

    Returns:
        List of Bar objects
    """
    path = Path(path)
    if symbol is None:
        symbol = path.stem.upper()

    loader = CSVLoader(path, **kwargs)
    return loader.load_bars(symbol, start, end)
