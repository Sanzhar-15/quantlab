"""
Unified Data Loader.

Auto-detects file format and loads market data from various sources.

Supported formats:
- CSV (.csv)
- Parquet (.parquet, .pq)
- Directory of files
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import Sequence

from quantlab.providers.base import Bar


logger = logging.getLogger(__name__)


class DataLoaderError(Exception):
    """Error loading data."""
    pass


def load_data(
    path: str | Path,
    symbol: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    **kwargs,
) -> list[Bar]:
    """
    Load market data from file, auto-detecting format.

    Supports CSV, Parquet, and directories of data files.

    Args:
        path: Path to data file or directory
        symbol: Symbol name (defaults to filename if not specified)
        start: Optional start date filter
        end: Optional end date filter
        **kwargs: Additional loader-specific arguments

    Returns:
        List of Bar objects sorted by timestamp

    Example:
        # Load from CSV
        bars = load_data("data/AAPL.csv")

        # Load from Parquet with date range
        bars = load_data(
            "data/SPY.parquet",
            start=datetime(2023, 1, 1),
            end=datetime(2023, 12, 31),
        )

        # Load from directory (all files)
        bars = load_data("data/")
    """
    path = Path(path)

    if not path.exists():
        raise DataLoaderError(f"Path not found: {path}")

    if path.is_dir():
        return _load_directory(path, symbol, start, end, **kwargs)

    # Determine format from extension
    suffix = path.suffix.lower()

    if suffix == ".csv":
        return _load_csv(path, symbol, start, end, **kwargs)
    elif suffix in (".parquet", ".pq"):
        return _load_parquet(path, symbol, start, end, **kwargs)
    else:
        # Try to auto-detect by reading first bytes
        return _load_auto_detect(path, symbol, start, end, **kwargs)


def _load_csv(
    path: Path,
    symbol: str | None,
    start: datetime | None,
    end: datetime | None,
    **kwargs,
) -> list[Bar]:
    """Load from CSV file."""
    from quantlab.data.csv_loader import CSVLoader

    if symbol is None:
        symbol = path.stem.upper()

    loader = CSVLoader(path, **kwargs)
    bars = loader.load_bars(symbol, start, end)
    return sorted(bars, key=lambda b: b.timestamp)


def _load_parquet(
    path: Path,
    symbol: str | None,
    start: datetime | None,
    end: datetime | None,
    **kwargs,
) -> list[Bar]:
    """Load from Parquet file."""
    from quantlab.data.parquet_loader import ParquetLoader, HAS_PYARROW

    if not HAS_PYARROW:
        raise DataLoaderError(
            "PyArrow is required for Parquet files. Install with: pip install pyarrow"
        )

    if symbol is None:
        symbol = path.stem.upper()

    loader = ParquetLoader(path, **kwargs)
    bars = loader.load_bars(symbol, start, end)
    return sorted(bars, key=lambda b: b.timestamp)


def _load_directory(
    path: Path,
    symbol: str | None,
    start: datetime | None,
    end: datetime | None,
    **kwargs,
) -> list[Bar]:
    """Load from directory of files."""
    all_bars: list[Bar] = []

    # Find all data files
    patterns = ["*.csv", "*.parquet", "*.pq"]
    files = []
    for pattern in patterns:
        files.extend(path.glob(pattern))

    if not files:
        raise DataLoaderError(f"No data files found in directory: {path}")

    for file_path in sorted(files):
        try:
            file_symbol = symbol or file_path.stem.upper()
            bars = load_data(file_path, file_symbol, start, end, **kwargs)
            all_bars.extend(bars)
        except Exception as e:
            logger.warning(f"Error loading {file_path}: {e}")
            continue

    return sorted(all_bars, key=lambda b: b.timestamp)


def _load_auto_detect(
    path: Path,
    symbol: str | None,
    start: datetime | None,
    end: datetime | None,
    **kwargs,
) -> list[Bar]:
    """Auto-detect format by inspecting file content."""
    # Read first bytes to detect format
    with open(path, "rb") as f:
        header = f.read(4)

    # Parquet magic bytes: PAR1
    if header == b"PAR1":
        return _load_parquet(path, symbol, start, end, **kwargs)

    # Otherwise assume CSV
    return _load_csv(path, symbol, start, end, **kwargs)


def load_multi(
    paths: Sequence[str | Path],
    start: datetime | None = None,
    end: datetime | None = None,
    **kwargs,
) -> dict[str, list[Bar]]:
    """
    Load data from multiple files.

    Args:
        paths: List of file paths
        start: Optional start date filter
        end: Optional end date filter
        **kwargs: Additional loader arguments

    Returns:
        Dictionary mapping symbol to list of bars

    Example:
        data = load_multi(["AAPL.csv", "MSFT.csv", "GOOGL.csv"])
        aapl_bars = data["AAPL"]
    """
    result: dict[str, list[Bar]] = {}

    for path in paths:
        path = Path(path)
        symbol = path.stem.upper()
        try:
            bars = load_data(path, symbol, start, end, **kwargs)
            result[symbol] = bars
        except Exception as e:
            logger.error(f"Error loading {path}: {e}")
            raise

    return result


# =============================================================================
# Forward-fill detection and gap handling (NEW-ENG-004 + NEW-ENG-005)
# =============================================================================


def detect_gaps(
    bars: list[Bar],
    expected_freq: str = "1D",
    exchange: str | None = None,
) -> list[dict]:
    """Detect missing bars in a time series (NEW-ENG-004).

    Args:
        bars: List of Bar objects with timestamps
        expected_freq: Expected bar frequency ('1D', '1H', '1min', etc.)
        exchange: Optional exchange name for calendar-aware detection (NEW-ENG-005)

    Returns:
        List of gap descriptions: [{"start": ..., "end": ..., "count": ...}]
    """
    if len(bars) < 2:
        return []

    # Build expected trading dates
    trading_dates: set[str] | None = None
    if exchange:
        try:
            from quantlab.calendar import get_calendar
            calendar = get_calendar(exchange)
            if calendar and hasattr(calendar, 'trading_dates'):
                first_ts = bars[0].timestamp
                last_ts = bars[-1].timestamp
                td = calendar.trading_dates(first_ts, last_ts)
                trading_dates = {d.strftime("%Y-%m-%d") for d in td}
        except (ImportError, Exception) as e:
            logger.debug(f"Calendar not available for gap detection: {e}")

    gaps: list[dict] = []
    for i in range(1, len(bars)):
        prev = bars[i - 1]
        curr = bars[i]

        if not hasattr(prev, 'timestamp') or not hasattr(curr, 'timestamp'):
            continue

        prev_ts = prev.timestamp
        curr_ts = curr.timestamp

        if prev_ts is None or curr_ts is None:
            continue

        # Calculate expected gap based on frequency
        if expected_freq in ("1D", "D"):
            # For daily: check if more than 3 calendar days apart (skips weekends)
            delta = (curr_ts - prev_ts).days
            if delta <= 3:
                continue
            # If we have a trading calendar, check if the days in between are all holidays
            if trading_dates:
                missing_dates = []
                from datetime import timedelta
                check_date = prev_ts + timedelta(days=1)
                while check_date < curr_ts:
                    date_str = check_date.strftime("%Y-%m-%d")
                    if date_str in trading_dates:
                        missing_dates.append(date_str)
                    check_date += timedelta(days=1)
                if not missing_dates:
                    continue  # All missing days are non-trading — no real gap
                gaps.append({
                    "start": missing_dates[0],
                    "end": missing_dates[-1],
                    "count": len(missing_dates),
                    "bar_index": i,
                })
            else:
                gaps.append({
                    "start": (prev_ts).isoformat(),
                    "end": (curr_ts).isoformat(),
                    "count": delta - 1,
                    "bar_index": i,
                })

    return gaps


def forward_fill_bars(
    bars: list[Bar],
    expected_freq: str = "1D",
    exchange: str | None = None,
    max_fill_days: int = 5,
) -> list[Bar]:
    """Forward-fill missing bars in a time series (NEW-ENG-004).

    Fills gaps by repeating the previous bar's close price for OHLC
    and setting volume to 0. Bars are tagged with is_forward_filled=True.

    Args:
        bars: List of Bar objects sorted by timestamp
        expected_freq: Expected bar frequency
        exchange: Optional exchange for calendar-aware filling (NEW-ENG-005)
        max_fill_days: Maximum consecutive days to forward-fill

    Returns:
        List of bars with gaps filled
    """
    if len(bars) < 2 or expected_freq not in ("1D", "D"):
        return bars

    # Get trading calendar if available
    trading_dates: list | None = None
    if exchange:
        try:
            from quantlab.calendar import get_calendar
            calendar = get_calendar(exchange)
            if calendar and hasattr(calendar, 'trading_dates'):
                td = calendar.trading_dates(bars[0].timestamp, bars[-1].timestamp)
                trading_dates = sorted(td)
        except (ImportError, Exception) as e:
            logger.debug(f"Calendar not available for forward-fill: {e}")

    result: list[Bar] = [bars[0]]
    bar_by_date: dict[str, Bar] = {}
    for bar in bars:
        if hasattr(bar, 'timestamp') and bar.timestamp:
            bar_by_date[bar.timestamp.strftime("%Y-%m-%d")] = bar

    if trading_dates:
        # Calendar-aware fill: iterate over expected trading dates
        last_bar = bars[0]
        consecutive_fills = 0
        for td in trading_dates:
            date_str = td.strftime("%Y-%m-%d")
            if date_str in bar_by_date:
                result.append(bar_by_date[date_str])
                last_bar = bar_by_date[date_str]
                consecutive_fills = 0
            elif consecutive_fills < max_fill_days:
                # Forward-fill: use previous close for all OHLC, volume=0
                filled = Bar(
                    symbol=last_bar.symbol,
                    timestamp=td,
                    open=last_bar.close,
                    high=last_bar.close,
                    low=last_bar.close,
                    close=last_bar.close,
                    volume=0,
                )
                result.append(filled)
                consecutive_fills += 1
                logger.debug(f"Forward-filled bar for {date_str} using close={last_bar.close}")
        # Deduplicate (first bar already added)
        if result and len(result) > 1 and result[0].timestamp == result[1].timestamp:
            result = result[1:]
    else:
        # No calendar — return bars as-is (can't determine which days to fill)
        return bars

    return result
