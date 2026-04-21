"""
Tests for Phase 3 DataService module.

Tests OHLCV data pipeline, caching, and binary encoding.
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock, patch

from quantlab.data.service import (
    OHLCVBar,
    OHLCVSeries,
    Timeframe,
    DataCache,
    BinaryEncoder,
    MockDataGenerator,
    CSVLoader,
    DataService,
)


class TestOHLCVBar:
    """Tests for OHLCVBar dataclass."""

    def test_creation(self) -> None:
        """Test basic bar creation."""
        bar = OHLCVBar(
            timestamp=1704067200.0,
            open=100.0,
            high=105.0,
            low=98.0,
            close=103.0,
            volume=1000000,
        )
        assert bar.timestamp == 1704067200.0
        assert bar.open == 100.0
        assert bar.high == 105.0
        assert bar.low == 98.0
        assert bar.close == 103.0
        assert bar.volume == 1000000

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        bar = OHLCVBar(
            timestamp=1704067200.0,
            open=100.0,
            high=105.0,
            low=98.0,
            close=103.0,
            volume=1000000,
        )
        d = bar.to_dict()
        assert d["timestamp"] == 1704067200.0
        assert d["open"] == 100.0
        assert d["high"] == 105.0
        assert d["low"] == 98.0
        assert d["close"] == 103.0
        assert d["volume"] == 1000000

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        d = {
            "timestamp": 1704067200.0,
            "open": 100.0,
            "high": 105.0,
            "low": 98.0,
            "close": 103.0,
            "volume": 1000000,
        }
        bar = OHLCVBar.from_dict(d)
        assert bar.timestamp == 1704067200.0
        assert bar.close == 103.0


class TestOHLCVSeries:
    """Tests for OHLCVSeries dataclass."""

    def test_creation(self) -> None:
        """Test series creation."""
        bars = [
            OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000),
            OHLCVBar(1704153600.0, 103.0, 108.0, 101.0, 106.0, 1200000),
        ]
        series = OHLCVSeries(
            symbol="AAPL",
            timeframe=Timeframe.D1,
            bars=bars,
        )
        assert series.symbol == "AAPL"
        assert series.timeframe == Timeframe.D1
        assert len(series.bars) == 2

    def test_to_dict(self) -> None:
        """Test series conversion to dictionary."""
        bars = [
            OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000),
        ]
        series = OHLCVSeries(
            symbol="AAPL",
            timeframe=Timeframe.D1,
            bars=bars,
        )
        d = series.to_dict()
        assert d["symbol"] == "AAPL"
        assert d["timeframe"] == "1D"
        assert d["barCount"] == 1
        assert len(d["bars"]) == 1


class TestTimeframe:
    """Tests for Timeframe enum."""

    def test_values(self) -> None:
        """Test timeframe values."""
        assert Timeframe.M1.value == "1m"
        assert Timeframe.M5.value == "5m"
        assert Timeframe.H1.value == "1H"
        assert Timeframe.D1.value == "1D"
        assert Timeframe.W1.value == "1W"

    def test_from_string(self) -> None:
        """Test timeframe from string."""
        assert Timeframe.from_string("1m") == Timeframe.M1
        assert Timeframe.from_string("1D") == Timeframe.D1
        assert Timeframe.from_string("1H") == Timeframe.H1

    def test_from_string_invalid(self) -> None:
        """Test timeframe from invalid string."""
        with pytest.raises(ValueError):
            Timeframe.from_string("invalid")

    def test_to_seconds(self) -> None:
        """Test timeframe to seconds conversion."""
        assert Timeframe.M1.to_seconds() == 60
        assert Timeframe.M5.to_seconds() == 300
        assert Timeframe.H1.to_seconds() == 3600
        assert Timeframe.D1.to_seconds() == 86400
        assert Timeframe.W1.to_seconds() == 604800


class TestDataCache:
    """Tests for DataCache class."""

    def test_get_miss(self) -> None:
        """Test cache miss."""
        cache = DataCache(max_size=10, ttl_seconds=60)
        result = cache.get("AAPL", Timeframe.D1)
        assert result is None

    def test_put_and_get(self) -> None:
        """Test cache put and get."""
        cache = DataCache(max_size=10, ttl_seconds=60)
        bars = [OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000)]
        series = OHLCVSeries("AAPL", Timeframe.D1, bars)

        cache.put("AAPL", Timeframe.D1, series)
        result = cache.get("AAPL", Timeframe.D1)

        assert result is not None
        assert result.symbol == "AAPL"

    def test_lru_eviction(self) -> None:
        """Test LRU eviction when cache is full."""
        cache = DataCache(max_size=2, ttl_seconds=60)

        # Add 3 items to cache with max_size=2
        for symbol in ["AAPL", "GOOG", "MSFT"]:
            bars = [OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000)]
            series = OHLCVSeries(symbol, Timeframe.D1, bars)
            cache.put(symbol, Timeframe.D1, series)

        # First item should be evicted
        assert cache.get("AAPL", Timeframe.D1) is None
        assert cache.get("GOOG", Timeframe.D1) is not None
        assert cache.get("MSFT", Timeframe.D1) is not None

    def test_ttl_expiration(self) -> None:
        """Test TTL expiration."""
        cache = DataCache(max_size=10, ttl_seconds=1)
        bars = [OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000)]
        series = OHLCVSeries("AAPL", Timeframe.D1, bars)

        cache.put("AAPL", Timeframe.D1, series)
        assert cache.get("AAPL", Timeframe.D1) is not None

        # Manually expire by manipulating timestamp
        key = ("AAPL", Timeframe.D1)
        cache._timestamps[key] = datetime.now() - timedelta(seconds=10)

        assert cache.get("AAPL", Timeframe.D1) is None

    def test_invalidate(self) -> None:
        """Test cache invalidation."""
        cache = DataCache(max_size=10, ttl_seconds=60)
        bars = [OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000)]
        series = OHLCVSeries("AAPL", Timeframe.D1, bars)

        cache.put("AAPL", Timeframe.D1, series)
        assert cache.get("AAPL", Timeframe.D1) is not None

        cache.invalidate("AAPL", Timeframe.D1)
        assert cache.get("AAPL", Timeframe.D1) is None

    def test_clear(self) -> None:
        """Test cache clear."""
        cache = DataCache(max_size=10, ttl_seconds=60)
        for symbol in ["AAPL", "GOOG"]:
            bars = [OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000)]
            series = OHLCVSeries(symbol, Timeframe.D1, bars)
            cache.put(symbol, Timeframe.D1, series)

        cache.clear()

        assert cache.get("AAPL", Timeframe.D1) is None
        assert cache.get("GOOG", Timeframe.D1) is None


class TestBinaryEncoder:
    """Tests for BinaryEncoder class."""

    def test_encode_struct(self) -> None:
        """Test struct encoding."""
        bars = [
            OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000),
            OHLCVBar(1704153600.0, 103.0, 108.0, 101.0, 106.0, 1200000),
        ]
        data = BinaryEncoder.encode_struct(bars)

        assert isinstance(data, bytes)
        # Each bar: 5 doubles (8 bytes) + 1 long (8 bytes) = 48 bytes
        assert len(data) == 48 * 2

    def test_decode_struct(self) -> None:
        """Test struct decoding."""
        bars = [
            OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000),
            OHLCVBar(1704153600.0, 103.0, 108.0, 101.0, 106.0, 1200000),
        ]
        data = BinaryEncoder.encode_struct(bars)
        decoded = BinaryEncoder.decode_struct(data)

        assert len(decoded) == 2
        assert decoded[0].timestamp == bars[0].timestamp
        assert decoded[0].close == bars[0].close
        assert decoded[1].volume == bars[1].volume

    def test_encode_arrow(self) -> None:
        """Test Arrow IPC encoding."""
        bars = [
            OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000),
            OHLCVBar(1704153600.0, 103.0, 108.0, 101.0, 106.0, 1200000),
        ]
        data = BinaryEncoder.encode_arrow(bars)

        assert isinstance(data, bytes)
        # Arrow format includes header
        assert len(data) > 0

    def test_decode_arrow(self) -> None:
        """Test Arrow IPC decoding."""
        bars = [
            OHLCVBar(1704067200.0, 100.0, 105.0, 98.0, 103.0, 1000000),
            OHLCVBar(1704153600.0, 103.0, 108.0, 101.0, 106.0, 1200000),
        ]
        data = BinaryEncoder.encode_arrow(bars)
        decoded = BinaryEncoder.decode_arrow(data)

        assert len(decoded) == 2
        assert decoded[0].timestamp == bars[0].timestamp
        assert decoded[0].close == bars[0].close

    def test_roundtrip_struct(self) -> None:
        """Test struct encode/decode roundtrip."""
        original = [
            OHLCVBar(1704067200.0, 100.5, 105.25, 98.75, 103.125, 1000000),
        ]
        data = BinaryEncoder.encode_struct(original)
        decoded = BinaryEncoder.decode_struct(data)

        assert decoded[0].timestamp == original[0].timestamp
        assert decoded[0].open == original[0].open
        assert decoded[0].high == original[0].high
        assert decoded[0].low == original[0].low
        assert decoded[0].close == original[0].close
        assert decoded[0].volume == original[0].volume


class TestMockDataGenerator:
    """Tests for MockDataGenerator class."""

    def test_generate_bars(self) -> None:
        """Test mock bar generation."""
        generator = MockDataGenerator(seed=42)
        bars = generator.generate_bars(
            symbol="TEST",
            timeframe=Timeframe.D1,
            count=100,
        )

        assert len(bars) == 100
        for bar in bars:
            assert bar.high >= bar.open
            assert bar.high >= bar.close
            assert bar.low <= bar.open
            assert bar.low <= bar.close
            assert bar.volume > 0

    def test_reproducible_with_seed(self) -> None:
        """Test that same seed produces same data."""
        gen1 = MockDataGenerator(seed=42)
        gen2 = MockDataGenerator(seed=42)

        bars1 = gen1.generate_bars("TEST", Timeframe.D1, 10)
        bars2 = gen2.generate_bars("TEST", Timeframe.D1, 10)

        for b1, b2 in zip(bars1, bars2):
            assert b1.close == b2.close

    def test_generate_series(self) -> None:
        """Test series generation."""
        generator = MockDataGenerator()
        series = generator.generate_series("AAPL", Timeframe.D1, 50)

        assert series.symbol == "AAPL"
        assert series.timeframe == Timeframe.D1
        assert len(series.bars) == 50


class TestDataService:
    """Tests for DataService class."""

    def test_creation(self) -> None:
        """Test service creation."""
        service = DataService()
        assert service is not None

    def test_get_ohlcv_mock(self) -> None:
        """Test getting OHLCV data with mock generator."""
        service = DataService(use_mock=True)
        series = service.get_ohlcv("AAPL", Timeframe.D1)

        assert series.symbol == "AAPL"
        assert len(series.bars) > 0

    def test_get_ohlcv_cached(self) -> None:
        """Test that data is cached."""
        service = DataService(use_mock=True)

        # First call
        series1 = service.get_ohlcv("AAPL", Timeframe.D1)
        # Second call should hit cache
        series2 = service.get_ohlcv("AAPL", Timeframe.D1)

        # Should be same object from cache
        assert series1 is series2

    def test_get_ohlcv_binary_struct(self) -> None:
        """Test getting binary OHLCV data (struct format)."""
        service = DataService(use_mock=True)
        data = service.get_ohlcv_binary("AAPL", Timeframe.D1, use_arrow=False)

        assert isinstance(data, bytes)
        assert len(data) > 0

    def test_get_ohlcv_binary_arrow(self) -> None:
        """Test getting binary OHLCV data (Arrow format)."""
        service = DataService(use_mock=True)
        data = service.get_ohlcv_binary("AAPL", Timeframe.D1, use_arrow=True)

        assert isinstance(data, bytes)
        assert len(data) > 0

    def test_invalidate_cache(self) -> None:
        """Test cache invalidation."""
        service = DataService(use_mock=True)

        series1 = service.get_ohlcv("AAPL", Timeframe.D1)
        service.invalidate_cache("AAPL", Timeframe.D1)
        series2 = service.get_ohlcv("AAPL", Timeframe.D1)

        # Should be different objects after invalidation
        assert series1 is not series2

    def test_get_available_symbols(self) -> None:
        """Test getting available symbols."""
        service = DataService(use_mock=True)
        symbols = service.get_available_symbols()

        assert isinstance(symbols, list)
        # Mock generator has predefined symbols
        assert len(symbols) > 0

    def test_get_available_timeframes(self) -> None:
        """Test getting available timeframes."""
        service = DataService()
        timeframes = service.get_available_timeframes()

        assert isinstance(timeframes, list)
        assert Timeframe.D1 in timeframes


class TestCSVLoader:
    """Tests for CSVLoader class."""

    def test_parse_csv_content(self) -> None:
        """Test parsing CSV content."""
        csv_content = """timestamp,open,high,low,close,volume
1704067200,100.0,105.0,98.0,103.0,1000000
1704153600,103.0,108.0,101.0,106.0,1200000
"""
        bars = CSVLoader.parse_csv_content(csv_content)

        assert len(bars) == 2
        assert bars[0].timestamp == 1704067200.0
        assert bars[0].close == 103.0
        assert bars[1].volume == 1200000

    def test_parse_csv_with_date_string(self) -> None:
        """Test parsing CSV with date strings."""
        csv_content = """date,open,high,low,close,volume
2024-01-01,100.0,105.0,98.0,103.0,1000000
2024-01-02,103.0,108.0,101.0,106.0,1200000
"""
        bars = CSVLoader.parse_csv_content(csv_content)

        assert len(bars) == 2
        # Date should be converted to timestamp
        assert bars[0].timestamp > 0

    def test_parse_empty_csv(self) -> None:
        """Test parsing empty CSV."""
        csv_content = """timestamp,open,high,low,close,volume
"""
        bars = CSVLoader.parse_csv_content(csv_content)
        assert len(bars) == 0
