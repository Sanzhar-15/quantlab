"""
Tests for Bar data structures.

Tests Bar and BarSeries classes.
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar, BarSeries


class TestBar:
    """Tests for Bar dataclass."""

    @pytest.fixture
    def valid_bar(self) -> Bar:
        """Create a valid bar."""
        return Bar(
            timestamp=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc),
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("99.00"),
            close=Decimal("103.00"),
            volume=Decimal("1000"),
            symbol="AAPL",
        )

    def test_bar_creation(self, valid_bar: Bar) -> None:
        """Test creating a valid bar."""
        assert valid_bar.symbol == "AAPL"
        assert valid_bar.open == Decimal("100.00")
        assert valid_bar.close == Decimal("103.00")

    def test_bar_high_less_than_low_raises(self) -> None:
        """Test that high < low raises ValueError."""
        with pytest.raises(ValueError, match="High.*cannot be less than low"):
            Bar(
                timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
                open=Decimal("100"),
                high=Decimal("99"),  # Less than low
                low=Decimal("100"),
                close=Decimal("100"),
                volume=Decimal("100"),
                symbol="TEST",
            )

    def test_bar_high_less_than_open_raises(self) -> None:
        """Test that high < open raises ValueError."""
        with pytest.raises(ValueError, match="High.*must be >= open"):
            Bar(
                timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
                open=Decimal("105"),  # Greater than high
                high=Decimal("104"),
                low=Decimal("100"),
                close=Decimal("103"),
                volume=Decimal("100"),
                symbol="TEST",
            )

    def test_bar_low_greater_than_open_raises(self) -> None:
        """Test that low > open raises ValueError."""
        with pytest.raises(ValueError, match="Low.*must be <="):
            Bar(
                timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
                open=Decimal("99"),  # Less than low
                high=Decimal("105"),
                low=Decimal("100"),
                close=Decimal("103"),
                volume=Decimal("100"),
                symbol="TEST",
            )

    def test_bar_negative_volume_raises(self) -> None:
        """Test that negative volume raises ValueError."""
        with pytest.raises(ValueError, match="Volume.*cannot be negative"):
            Bar(
                timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
                open=Decimal("100"),
                high=Decimal("105"),
                low=Decimal("99"),
                close=Decimal("103"),
                volume=Decimal("-1"),
                symbol="TEST",
            )

    def test_typical_price(self, valid_bar: Bar) -> None:
        """Test typical price calculation."""
        # (105 + 99 + 103) / 3 = 307 / 3 = 102.333...
        expected = (Decimal("105") + Decimal("99") + Decimal("103")) / Decimal("3")
        assert valid_bar.typical_price == expected

    def test_vwap_proxy(self, valid_bar: Bar) -> None:
        """Test VWAP proxy calculation."""
        # (100 + 105 + 99 + 103) / 4 = 407 / 4 = 101.75
        expected = Decimal("407") / Decimal("4")
        assert valid_bar.vwap_proxy == expected

    def test_range(self, valid_bar: Bar) -> None:
        """Test range calculation."""
        assert valid_bar.range == Decimal("6")  # 105 - 99

    def test_body(self, valid_bar: Bar) -> None:
        """Test body calculation."""
        assert valid_bar.body == Decimal("3")  # 103 - 100

    def test_is_green(self, valid_bar: Bar) -> None:
        """Test is_green when close > open."""
        assert valid_bar.is_green is True

    def test_is_green_false(self) -> None:
        """Test is_green when close <= open."""
        bar = Bar(
            timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
            open=Decimal("103"),
            high=Decimal("105"),
            low=Decimal("99"),
            close=Decimal("100"),
            volume=Decimal("100"),
            symbol="TEST",
        )
        assert bar.is_green is False

    def test_is_red(self) -> None:
        """Test is_red when close < open."""
        bar = Bar(
            timestamp=datetime(2024, 1, 15, tzinfo=timezone.utc),
            open=Decimal("103"),
            high=Decimal("105"),
            low=Decimal("99"),
            close=Decimal("100"),
            volume=Decimal("100"),
            symbol="TEST",
        )
        assert bar.is_red is True

    def test_is_red_false(self, valid_bar: Bar) -> None:
        """Test is_red when close >= open."""
        assert valid_bar.is_red is False

    def test_to_dict(self, valid_bar: Bar) -> None:
        """Test to_dict conversion."""
        d = valid_bar.to_dict()
        assert d["symbol"] == "AAPL"
        assert d["open"] == "100.00"
        assert d["high"] == "105.00"
        assert d["low"] == "99.00"
        assert d["close"] == "103.00"
        assert d["volume"] == "1000"
        assert "timestamp" in d


class TestBarSeries:
    """Tests for BarSeries class."""

    @pytest.fixture
    def bar_series(self) -> BarSeries:
        """Create a bar series with multiple bars."""
        bars = [
            Bar(
                timestamp=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc),
                open=Decimal("100"),
                high=Decimal("105"),
                low=Decimal("99"),
                close=Decimal("103"),
                volume=Decimal("1000"),
                symbol="AAPL",
            ),
            Bar(
                timestamp=datetime(2024, 1, 15, 11, 0, 0, tzinfo=timezone.utc),
                open=Decimal("103"),
                high=Decimal("108"),
                low=Decimal("102"),
                close=Decimal("107"),
                volume=Decimal("1500"),
                symbol="AAPL",
            ),
            Bar(
                timestamp=datetime(2024, 1, 15, 12, 0, 0, tzinfo=timezone.utc),
                open=Decimal("107"),
                high=Decimal("110"),
                low=Decimal("105"),
                close=Decimal("109"),
                volume=Decimal("2000"),
                symbol="AAPL",
            ),
        ]
        return BarSeries(symbol="AAPL", timeframe="1H", bars=bars)

    def test_len(self, bar_series: BarSeries) -> None:
        """Test length."""
        assert len(bar_series) == 3

    def test_getitem(self, bar_series: BarSeries) -> None:
        """Test indexing."""
        assert bar_series[0].open == Decimal("100")
        assert bar_series[2].close == Decimal("109")

    def test_timestamps(self, bar_series: BarSeries) -> None:
        """Test timestamps property."""
        ts = bar_series.timestamps
        assert len(ts) == 3
        assert ts[0] == datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc)

    def test_opens(self, bar_series: BarSeries) -> None:
        """Test opens property."""
        opens = bar_series.opens
        assert opens == [Decimal("100"), Decimal("103"), Decimal("107")]

    def test_highs(self, bar_series: BarSeries) -> None:
        """Test highs property."""
        highs = bar_series.highs
        assert highs == [Decimal("105"), Decimal("108"), Decimal("110")]

    def test_lows(self, bar_series: BarSeries) -> None:
        """Test lows property."""
        lows = bar_series.lows
        assert lows == [Decimal("99"), Decimal("102"), Decimal("105")]

    def test_closes(self, bar_series: BarSeries) -> None:
        """Test closes property."""
        closes = bar_series.closes
        assert closes == [Decimal("103"), Decimal("107"), Decimal("109")]

    def test_volumes(self, bar_series: BarSeries) -> None:
        """Test volumes property."""
        volumes = bar_series.volumes
        assert volumes == [Decimal("1000"), Decimal("1500"), Decimal("2000")]

    def test_slice(self, bar_series: BarSeries) -> None:
        """Test slice method."""
        sliced = bar_series.slice(1, 3)
        assert len(sliced) == 2
        assert sliced[0].open == Decimal("103")

    def test_up_to(self, bar_series: BarSeries) -> None:
        """Test up_to method."""
        partial = bar_series.up_to(1)
        assert len(partial) == 2
        assert partial[1].close == Decimal("107")
