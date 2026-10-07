"""F-ENGINE-CSV-1: the CSV loader's one UTC rule and its named row errors (no row dropped silently)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from quantlab.data.csv_loader import CSVLoader, CSVLoaderError
from quantlab.data.loader import load_data

UTC = timezone.utc
HEADER = "date,open,high,low,close,volume\n"


def write(tmp_path: Path, body: str, name: str = "bars.csv") -> Path:
    path = tmp_path / name
    path.write_text(HEADER + body)
    return path


def daily(n: int) -> str:
    first = datetime(2025, 1, 1)
    return "".join(f"{(first + timedelta(days=i)):%Y-%m-%d},{100 + i}.0,{101 + i}.0,{99 + i}.0,{100 + i}.5,{1000 + i}\n" for i in range(n))


def test_date_only_rows_with_aware_range_as_backtest_passes_it(tmp_path):
    # backtest() turns dateStart/dateEnd into UTC-aware datetimes before loading (runner.py "Ensure timezone awareness").
    path = write(tmp_path, daily(10))
    bars = load_data(path, "BARS", datetime(2025, 1, 1, tzinfo=UTC), datetime(2025, 1, 10, tzinfo=UTC))
    assert [b.timestamp for b in bars] == [datetime(2025, 1, 1, tzinfo=UTC) + timedelta(days=i) for i in range(10)]


def test_naive_range_and_inclusive_bounds(tmp_path):
    path = write(tmp_path, daily(10))
    bars = CSVLoader(path).load_bars("BARS", datetime(2025, 1, 3), datetime(2025, 1, 5))
    assert [b.timestamp.day for b in bars] == [3, 4, 5]
    assert all(b.timestamp.tzinfo is UTC for b in bars)


def test_aware_range_in_another_zone_is_converted(tmp_path):
    path = write(tmp_path, daily(10))
    plus2 = timezone(timedelta(hours=2))
    # 2025-01-03 01:00 +02:00 is 2025-01-02 23:00 UTC: the 2nd (00:00 UTC) is before it, the 3rd is after.
    bars = CSVLoader(path).load_bars("BARS", datetime(2025, 1, 3, 1, tzinfo=plus2), None)
    assert bars[0].timestamp == datetime(2025, 1, 3, tzinfo=UTC)


def test_epoch_and_text_timestamps_are_the_same_kind(tmp_path):
    epoch = write(tmp_path, "1735689600,1,1,1,1,1\n1735776000,1,1,1,1,1\n", "epoch.csv")
    text = write(tmp_path, "2025-01-01,1,1,1,1,1\n2025-01-02,1,1,1,1,1\n", "text.csv")
    assert [b.timestamp for b in CSVLoader(epoch).load_bars("E")] == [b.timestamp for b in CSVLoader(text).load_bars("T")]


def test_an_unreadable_date_is_a_named_error_not_a_dropped_row(tmp_path):
    path = write(tmp_path, daily(3) + "not-a-date,1,1,1,1,1\n" + "2025-01-05,1,1,1,1,1\n")
    with pytest.raises(CSVLoaderError, match=r"row 5 cannot be read \(Could not parse date: not-a-date\).*'not-a-date'"):
        CSVLoader(path).load_bars("BARS")


def test_an_unreadable_price_is_a_named_error(tmp_path):
    path = write(tmp_path, "2025-01-01,1,1,1,abc,1\n")
    with pytest.raises(CSVLoaderError, match=r"row 2 cannot be read .*'abc'"):
        CSVLoader(path).load_bars("BARS")


def test_a_short_row_is_a_named_error_and_a_blank_line_is_not_a_row(tmp_path):
    assert len(CSVLoader(write(tmp_path, daily(2) + "\n" + "2025-01-04,1,1,1,1,1\n", "blank.csv")).load_bars("B")) == 3
    with pytest.raises(CSVLoaderError, match=r"row 3 has 5 cells, 6 needed"):
        CSVLoader(write(tmp_path, daily(1) + "2025-01-02,1,1,1,1\n", "short.csv")).load_bars("B")
