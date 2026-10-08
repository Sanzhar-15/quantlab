"""F-ENGINE-CSV-1: the CSV loader's one UTC rule and its named row errors (no row dropped silently)."""

import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from quantlab.data.csv_loader import CSVLoader, CSVLoaderError, _utc
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
    with pytest.raises(CSVLoaderError, match=r"row 5 cannot be read \(date 'not-a-date' does not match the format %Y-%m-%d of the earlier rows\).*'not-a-date'"):
        CSVLoader(path).load_bars("BARS")


def test_an_unreadable_price_is_a_named_error(tmp_path):
    path = write(tmp_path, "2025-01-01,1,1,1,abc,1\n")
    with pytest.raises(CSVLoaderError, match=r"row 2 cannot be read .*'abc'"):
        CSVLoader(path).load_bars("BARS")


def test_a_short_row_is_a_named_error_and_a_blank_line_is_not_a_row(tmp_path):
    assert len(CSVLoader(write(tmp_path, daily(2) + "\n" + "2025-01-04,1,1,1,1,1\n", "blank.csv")).load_bars("B")) == 3
    with pytest.raises(CSVLoaderError, match=r"row 3 has 5 cells, 6 needed"):
        CSVLoader(write(tmp_path, daily(1) + "2025-01-02,1,1,1,1\n", "short.csv")).load_bars("B")


@pytest.mark.parametrize("cell, where", [("", "close"), ("nan", "close"), ("NULL", "open"), ("inf", "high"), ("", "volume"), ("nan", "volume"), ("12.5", "volume")])
def test_an_empty_or_non_numeric_cell_never_becomes_a_number(tmp_path, cell, where):
    cells = {"open": "1", "high": "1", "low": "1", "close": "1", "volume": "100"}
    cells[where] = cell
    path = write(tmp_path, daily(1) + f"2025-01-02,{cells['open']},{cells['high']},{cells['low']},{cells['close']},{cells['volume']}\n")
    with pytest.raises(CSVLoaderError, match=r"row 3 cannot be read"):
        CSVLoader(path).load_bars("BARS")


def test_volume_with_a_zero_fraction_and_thousands_commas_still_reads(tmp_path):
    path = write(tmp_path, '2025-01-01,"1,000.5",1001,999,1000,1000000.0\n')
    bar = CSVLoader(path).load_bars("BARS")[0]
    assert (str(bar.open), bar.volume) == ("1000.5", 1000000)


def test_a_row_in_another_date_format_is_a_named_error_not_re_detected(tmp_path):
    # %Y-%m-%d is detected on row 2; row 4 in %m/%d/%Y must not be re-detected (it could as well be %d/%m/%Y).
    path = write(tmp_path, daily(2) + "01/03/2025,1,1,1,1,1\n")
    with pytest.raises(CSVLoaderError, match=r"row 4 cannot be read \(date '01/03/2025' does not match the format %Y-%m-%d of the earlier rows\)"):
        CSVLoader(path).load_bars("BARS")


def test_an_epoch_number_after_text_dates_is_a_named_error(tmp_path):
    path = write(tmp_path, daily(1) + "1735776000,1,1,1,1,1\n")
    with pytest.raises(CSVLoaderError, match=r"row 3 cannot be read \(date '1735776000' does not match the format %Y-%m-%d"):
        CSVLoader(path).load_bars("BARS")


def test_a_directory_with_one_bad_file_fails_naming_it_not_a_partial_dataset(tmp_path):
    # Review c1 M1: _load_directory caught every error and continued with the other files.
    (tmp_path / "good.csv").write_text("date,close,volume\n2025-01-01,1,100\n")
    (tmp_path / "bad.csv").write_text("date,close,volume\n2025-01-01,1,100\n2025-01-02,1,nan\n")
    with pytest.raises(CSVLoaderError, match=r"bad\.csv: row 3 cannot be read"):
        load_data(tmp_path)


def test_a_csv_module_error_is_named_with_the_file_and_line(tmp_path):
    # Review c1 S2: a field over csv.field_size_limit() raised a bare csv.Error.
    path = write(tmp_path, daily(1) + "2025-01-02,1,1,1,1," + "9" * (csv.field_size_limit() + 1) + "\n")
    with pytest.raises(CSVLoaderError, match=r"bars\.csv: line 3 cannot be read by the csv module \(field larger than field limit"):
        CSVLoader(path).load_bars("BARS")


def test_an_empty_file_is_a_named_error(tmp_path):
    path = tmp_path / "empty.csv"
    path.write_text("")
    with pytest.raises(CSVLoaderError, match=r"empty\.csv: empty file, no header row"):
        CSVLoader(path).load_bars("BARS")


def test_an_offset_timestamp_is_converted_to_utc(tmp_path):
    # Review c1 S3: the filter test passed without the conversion; this one reads the clock time and the zone.
    path = write(tmp_path, "2025-01-01T02:00:00+0200,1,1,1,1,1\n")
    bar = CSVLoader(path, date_format="%Y-%m-%dT%H:%M:%S%z").load_bars("BARS")[0]
    assert bar.timestamp == datetime(2025, 1, 1, 0, 0, tzinfo=UTC)
    assert bar.timestamp.tzinfo is UTC
    assert _utc(datetime(2025, 1, 3, 1, tzinfo=timezone(timedelta(hours=2)))).tzinfo is UTC


def test_a_bad_cell_outside_the_date_range_still_rejects_the_file(tmp_path):
    # Review c1 S4: cells were parsed only inside the range, so the claim "every bad cell is an error" did not hold.
    path = write(tmp_path, "2025-01-01,1,1,1,1,1\n2025-01-02,1,1,1,nan,1\n")
    with pytest.raises(CSVLoaderError, match=r"row 3 cannot be read"):
        CSVLoader(path).load_bars("BARS", None, datetime(2025, 1, 1))
