"""
Tests for CSV Export Module.

Tests CSVExporter functionality for trades and metrics export.
"""

import csv
from datetime import datetime
from decimal import Decimal
from io import StringIO
from pathlib import Path

import pytest

from quantlab.export.csv import (
    CSVExporter,
    export_trades_csv,
    export_metrics_csv,
)


class TestCSVExporter:
    """Tests for CSVExporter class."""

    @pytest.fixture
    def exporter(self):
        """Create CSV exporter."""
        return CSVExporter()

    @pytest.fixture
    def sample_trades(self):
        """Create sample trade data."""
        return [
            {
                "trade_id": "T001",
                "symbol": "AAPL",
                "side": "buy",
                "quantity": Decimal("100"),
                "entry_price": Decimal("150.00"),
                "exit_price": Decimal("155.00"),
                "entry_time": datetime(2024, 1, 15, 9, 30, 0),
                "exit_time": datetime(2024, 1, 15, 16, 0, 0),
                "pnl": Decimal("500.00"),
                "pnl_percent": 3.33,
                "commission": Decimal("10.00"),
                "holding_period_bars": 78,
            },
            {
                "trade_id": "T002",
                "symbol": "MSFT",
                "side": "sell",
                "quantity": Decimal("50"),
                "entry_price": Decimal("300.00"),
                "exit_price": Decimal("295.00"),
                "entry_time": datetime(2024, 1, 16, 10, 0, 0),
                "exit_time": datetime(2024, 1, 16, 14, 30, 0),
                "pnl": Decimal("-250.00"),
                "pnl_percent": -1.67,
                "commission": Decimal("10.00"),
                "holding_period_bars": 54,
            },
        ]

    @pytest.fixture
    def sample_metrics(self):
        """Create sample metrics data."""
        return {
            "total_return": Decimal("0.1234"),
            "sharpe_ratio": 1.5,
            "max_drawdown": Decimal("-0.15"),
            "win_rate": 0.55,
            "total_trades": 100,
            "start_date": datetime(2024, 1, 1),
        }

    def test_init(self, exporter) -> None:
        """Test exporter initialization."""
        assert exporter is not None
        assert len(exporter.TRADE_COLUMNS) > 0
        assert len(exporter.METRIC_COLUMNS) == 2

    def test_export_trades_string(self, exporter, sample_trades) -> None:
        """Test exporting trades to string."""
        result = exporter.export_trades_string(sample_trades)

        assert isinstance(result, str)
        assert "trade_id" in result
        assert "T001" in result
        assert "AAPL" in result
        assert "T002" in result
        assert "MSFT" in result

    def test_export_trades_string_columns(self, exporter, sample_trades) -> None:
        """Test that all columns are in CSV header."""
        result = exporter.export_trades_string(sample_trades)
        lines = result.strip().split("\n")
        header = lines[0]

        for col in exporter.TRADE_COLUMNS:
            assert col in header

    def test_export_trades_string_row_count(self, exporter, sample_trades) -> None:
        """Test correct number of rows in output."""
        result = exporter.export_trades_string(sample_trades)
        lines = result.strip().split("\n")

        # Header + 2 data rows
        assert len(lines) == 3

    def test_export_trades_file(self, exporter, sample_trades, tmp_path) -> None:
        """Test exporting trades to file."""
        output_path = tmp_path / "trades.csv"

        result = exporter.export_trades(output_path, sample_trades)

        assert result == output_path
        assert output_path.exists()

        # Read and verify
        with open(output_path) as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 2
        assert rows[0]["trade_id"] == "T001"
        assert rows[1]["trade_id"] == "T002"

    def test_export_metrics_string(self, exporter, sample_metrics) -> None:
        """Test exporting metrics to string."""
        result = exporter.export_metrics_string(sample_metrics)

        assert isinstance(result, str)
        assert "metric" in result
        assert "value" in result
        assert "total_return" in result
        assert "sharpe_ratio" in result

    def test_export_metrics_file(self, exporter, sample_metrics, tmp_path) -> None:
        """Test exporting metrics to file."""
        output_path = tmp_path / "metrics.csv"

        result = exporter.export_metrics(output_path, sample_metrics)

        assert result == output_path
        assert output_path.exists()

        with open(output_path) as f:
            content = f.read()

        assert "total_return" in content
        assert "0.1234" in content

    def test_export_equity_curve(self, exporter, tmp_path) -> None:
        """Test exporting equity curve."""
        equity_curve = [
            {"timestamp": datetime(2024, 1, 1), "equity": Decimal("100000")},
            {"timestamp": datetime(2024, 1, 2), "equity": Decimal("100500")},
            {"timestamp": datetime(2024, 1, 3), "equity": Decimal("101200")},
        ]
        output_path = tmp_path / "equity.csv"

        result = exporter.export_equity_curve(output_path, equity_curve)

        assert result == output_path
        assert output_path.exists()

    def test_export_equity_curve_empty(self, exporter, tmp_path) -> None:
        """Test exporting empty equity curve."""
        output_path = tmp_path / "equity.csv"

        result = exporter.export_equity_curve(output_path, [])

        assert result == output_path

    def test_format_value_none(self, exporter) -> None:
        """Test formatting None value."""
        result = exporter._format_value(None)
        assert result == ""

    def test_format_value_decimal(self, exporter) -> None:
        """Test formatting Decimal value."""
        result = exporter._format_value(Decimal("123.456"))
        assert result == "123.456"

    def test_format_value_datetime(self, exporter) -> None:
        """Test formatting datetime value."""
        dt = datetime(2024, 1, 15, 10, 30, 0)
        result = exporter._format_value(dt)
        assert "2024-01-15" in result

    def test_format_value_float(self, exporter) -> None:
        """Test formatting float value."""
        result = exporter._format_value(3.14159265)
        assert "3.141593" in result  # 6 decimal places

    def test_format_value_nan(self, exporter) -> None:
        """Test formatting NaN value."""
        result = exporter._format_value(float("nan"))
        assert result == ""

    def test_format_value_string(self, exporter) -> None:
        """Test formatting string value."""
        result = exporter._format_value("hello")
        assert result == "hello"

    def test_format_value_int(self, exporter) -> None:
        """Test formatting int value."""
        result = exporter._format_value(42)
        assert result == "42"


class TestCSVExporterEdgeCases:
    """Edge case tests for CSV export."""

    @pytest.fixture
    def exporter(self):
        """Create CSV exporter."""
        return CSVExporter()

    def test_empty_trades(self, exporter) -> None:
        """Test exporting empty trades list."""
        result = exporter.export_trades_string([])
        lines = result.strip().split("\n")

        # Should only have header
        assert len(lines) == 1

    def test_empty_metrics(self, exporter) -> None:
        """Test exporting empty metrics dict."""
        result = exporter.export_metrics_string({})
        lines = result.strip().split("\n")

        # Should only have header
        assert len(lines) == 1

    def test_extra_fields_ignored(self, exporter) -> None:
        """Test that extra fields are ignored."""
        trades = [
            {
                "trade_id": "T001",
                "symbol": "AAPL",
                "side": "buy",
                "extra_field": "ignored",
            }
        ]
        result = exporter.export_trades_string(trades)

        assert "T001" in result
        assert "extra_field" not in result.split("\n")[0]  # Not in header

    def test_missing_fields_handled(self, exporter) -> None:
        """Test that missing fields are handled gracefully."""
        trades = [
            {
                "trade_id": "T001",
                # Missing most fields
            }
        ]
        result = exporter.export_trades_string(trades)

        assert "T001" in result


class TestConvenienceFunctions:
    """Tests for convenience export functions."""

    @pytest.fixture
    def sample_trades(self):
        """Create sample trade data."""
        return [
            {
                "trade_id": "T001",
                "symbol": "AAPL",
                "side": "buy",
                "quantity": Decimal("100"),
                "entry_price": Decimal("150.00"),
                "exit_price": Decimal("155.00"),
                "pnl": Decimal("500.00"),
            }
        ]

    @pytest.fixture
    def sample_metrics(self):
        """Create sample metrics data."""
        return {
            "total_return": Decimal("0.1234"),
            "sharpe_ratio": 1.5,
        }

    def test_export_trades_csv(self, sample_trades, tmp_path) -> None:
        """Test export_trades_csv convenience function."""
        output_path = tmp_path / "trades.csv"

        result = export_trades_csv(output_path, sample_trades)

        assert result == output_path
        assert output_path.exists()

    def test_export_trades_csv_string_path(self, sample_trades, tmp_path) -> None:
        """Test export_trades_csv with string path."""
        output_path = str(tmp_path / "trades.csv")

        result = export_trades_csv(output_path, sample_trades)

        assert isinstance(result, Path)
        assert result.exists()

    def test_export_metrics_csv(self, sample_metrics, tmp_path) -> None:
        """Test export_metrics_csv convenience function."""
        output_path = tmp_path / "metrics.csv"

        result = export_metrics_csv(output_path, sample_metrics)

        assert result == output_path
        assert output_path.exists()

    def test_export_metrics_csv_string_path(self, sample_metrics, tmp_path) -> None:
        """Test export_metrics_csv with string path."""
        output_path = str(tmp_path / "metrics.csv")

        result = export_metrics_csv(output_path, sample_metrics)

        assert isinstance(result, Path)
        assert result.exists()
