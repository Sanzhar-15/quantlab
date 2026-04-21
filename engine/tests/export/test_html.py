"""
Tests for HTML Report Generator.

Tests HTMLReportGenerator functionality for creating visual reports.
"""

from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from quantlab.export.html import (
    HTMLReportGenerator,
    export_to_html,
)


class TestHTMLReportGenerator:
    """Tests for HTMLReportGenerator class."""

    @pytest.fixture
    def generator(self):
        """Create HTML report generator."""
        return HTMLReportGenerator(
            strategy_name="TestStrategy",
            strategy_file="test_strategy.py",
        )

    @pytest.fixture
    def sample_metrics(self):
        """Create sample metrics data."""
        return {
            "total_return": 0.25,
            "cagr": 0.15,
            "sharpe_ratio": 1.5,
            "max_drawdown": -0.10,
            "win_rate": 0.55,
            "profit_factor": 1.8,
            "total_trades": 50,
            "avg_holding_period": 5.5,
            "avg_win": 500.0,
            "avg_loss": -300.0,
        }

    @pytest.fixture
    def sample_trades(self):
        """Create sample trade data."""
        return [
            {
                "symbol": "AAPL",
                "side": "buy",
                "quantity": 100,
                "entry_price": 150.00,
                "exit_price": 155.00,
                "entry_time": datetime(2024, 1, 15, 9, 30),
                "exit_time": datetime(2024, 1, 15, 16, 0),
                "pnl": 500.00,
            },
            {
                "symbol": "MSFT",
                "side": "sell",
                "quantity": 50,
                "entry_price": 300.00,
                "exit_price": 305.00,
                "entry_time": datetime(2024, 1, 16, 10, 0),
                "exit_time": datetime(2024, 1, 16, 14, 0),
                "pnl": -250.00,
            },
        ]

    @pytest.fixture
    def sample_equity_curve(self):
        """Create sample equity curve."""
        return [
            {"timestamp": "2024-01-01", "equity": 100000},
            {"timestamp": "2024-01-02", "equity": 101000},
            {"timestamp": "2024-01-03", "equity": 100500},
            {"timestamp": "2024-01-04", "equity": 102000},
            {"timestamp": "2024-01-05", "equity": 103000},
        ]

    def test_init_default(self) -> None:
        """Test default initialization."""
        generator = HTMLReportGenerator()

        assert generator.strategy_name == "Strategy"
        assert generator.strategy_file == ""

    def test_init_with_params(self, generator) -> None:
        """Test initialization with parameters."""
        assert generator.strategy_name == "TestStrategy"
        assert generator.strategy_file == "test_strategy.py"

    def test_generate_string(
        self, generator, sample_metrics, sample_trades
    ) -> None:
        """Test generating HTML string."""
        html = generator.generate_string(sample_metrics, sample_trades)

        assert isinstance(html, str)
        assert "<!DOCTYPE html>" in html
        assert "TestStrategy" in html
        assert "Performance Summary" in html

    def test_generate_string_contains_metrics(
        self, generator, sample_metrics, sample_trades
    ) -> None:
        """Test that metrics are in HTML."""
        html = generator.generate_string(sample_metrics, sample_trades)

        assert "Total Return" in html
        assert "Sharpe Ratio" in html
        assert "Max Drawdown" in html

    def test_generate_string_contains_trades(
        self, generator, sample_metrics, sample_trades
    ) -> None:
        """Test that trades are in HTML."""
        html = generator.generate_string(sample_metrics, sample_trades)

        assert "AAPL" in html
        assert "MSFT" in html
        assert "Trade History" in html

    def test_generate_string_with_equity_curve(
        self, generator, sample_metrics, sample_trades, sample_equity_curve
    ) -> None:
        """Test HTML with equity curve."""
        html = generator.generate_string(
            sample_metrics, sample_trades, equity_curve=sample_equity_curve
        )

        assert "Equity Curve" in html
        assert "<svg" in html
        assert "equity-line" in html

    def test_generate_string_with_parameters(
        self, generator, sample_metrics, sample_trades
    ) -> None:
        """Test HTML with parameters."""
        parameters = {"lookback": 20, "threshold": 0.05}
        html = generator.generate_string(
            sample_metrics, sample_trades, parameters=parameters
        )

        assert "Strategy Parameters" in html
        assert "Lookback" in html
        assert "Threshold" in html

    def test_generate_file(
        self, generator, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test generating HTML file."""
        output_path = tmp_path / "report.html"

        result = generator.generate(output_path, sample_metrics, sample_trades)

        assert result == output_path
        assert output_path.exists()

        content = output_path.read_text()
        assert "<!DOCTYPE html>" in content

    def test_generate_empty_trades(self, generator, sample_metrics) -> None:
        """Test HTML with empty trades."""
        html = generator.generate_string(sample_metrics, [])

        assert "No trades executed" in html

    def test_generate_many_trades_limited(
        self, generator, sample_metrics
    ) -> None:
        """Test that only first 100 trades are shown."""
        trades = [
            {
                "symbol": "AAPL",
                "side": "buy",
                "quantity": 100,
                "entry_price": 150.00,
                "exit_price": 155.00,
                "pnl": 500.00,
            }
            for _ in range(150)
        ]

        html = generator.generate_string(sample_metrics, trades)

        assert "Showing first 100 of 150 trades" in html

    def test_generate_minimal_equity_curve(self, generator, sample_metrics, sample_trades) -> None:
        """Test HTML with minimal equity curve (skipped)."""
        equity_curve = [{"equity": 100000}]  # Only one point
        html = generator.generate_string(
            sample_metrics, sample_trades, equity_curve=equity_curve
        )

        # Should not have equity curve section with only one point
        assert "Equity Curve" not in html


class TestHTMLFormatters:
    """Tests for HTML formatting methods."""

    @pytest.fixture
    def generator(self):
        """Create HTML report generator."""
        return HTMLReportGenerator()

    def test_escape_html(self, generator) -> None:
        """Test HTML escaping."""
        result = generator._escape("<script>alert('xss')</script>")

        assert "<script>" not in result
        assert "&lt;script&gt;" in result

    def test_escape_ampersand(self, generator) -> None:
        """Test escaping ampersand."""
        result = generator._escape("A & B")
        assert "&amp;" in result

    def test_escape_quotes(self, generator) -> None:
        """Test escaping quotes."""
        result = generator._escape('"quoted"')
        assert "&quot;" in result

    def test_format_percent(self, generator) -> None:
        """Test percentage formatting."""
        result = generator._format_percent(0.25)
        assert result == "25.00%"

    def test_format_percent_none(self, generator) -> None:
        """Test percentage formatting with None."""
        result = generator._format_percent(None)
        assert result == "N/A"

    def test_format_percent_invalid(self, generator) -> None:
        """Test percentage formatting with invalid value."""
        result = generator._format_percent("not a number")
        assert result == "not a number"

    def test_format_number(self, generator) -> None:
        """Test number formatting."""
        result = generator._format_number(1.5)
        assert result == "1.50"

    def test_format_number_none(self, generator) -> None:
        """Test number formatting with None."""
        result = generator._format_number(None)
        assert result == "N/A"

    def test_format_currency(self, generator) -> None:
        """Test currency formatting."""
        result = generator._format_currency(1234.56)
        assert result == "$1,234.56"

    def test_format_currency_none(self, generator) -> None:
        """Test currency formatting with None."""
        result = generator._format_currency(None)
        assert result == "N/A"

    def test_format_price(self, generator) -> None:
        """Test price formatting."""
        result = generator._format_price(150.50)
        assert result == "$150.50"

    def test_format_price_none(self, generator) -> None:
        """Test price formatting with None."""
        result = generator._format_price(None)
        assert result == "N/A"

    def test_format_time_datetime(self, generator) -> None:
        """Test time formatting with datetime."""
        dt = datetime(2024, 1, 15, 10, 30)
        result = generator._format_time(dt)
        assert "2024-01-15" in result
        assert "10:30" in result

    def test_format_time_string(self, generator) -> None:
        """Test time formatting with string."""
        result = generator._format_time("2024-01-15T10:30:00")
        assert "2024-01-15" in result

    def test_format_time_none(self, generator) -> None:
        """Test time formatting with None."""
        result = generator._format_time(None)
        assert result == "N/A"

    def test_format_value_decimal(self, generator) -> None:
        """Test value formatting with Decimal."""
        result = generator._format_value(Decimal("123.456"))
        assert result == "123.456"

    def test_format_value_float(self, generator) -> None:
        """Test value formatting with float."""
        result = generator._format_value(3.14159)
        assert "3.1416" in result

    def test_format_value_nan(self, generator) -> None:
        """Test value formatting with NaN."""
        result = generator._format_value(float("nan"))
        assert result == "N/A"

    def test_format_value_none(self, generator) -> None:
        """Test value formatting with None."""
        result = generator._format_value(None)
        assert result == "N/A"

    def test_format_key(self, generator) -> None:
        """Test key formatting."""
        result = generator._format_key("total_return")
        assert result == "Total Return"


class TestHTMLValueClasses:
    """Tests for CSS class assignment."""

    @pytest.fixture
    def generator(self):
        """Create HTML report generator."""
        return HTMLReportGenerator()

    def test_value_class_positive_return(self, generator) -> None:
        """Test positive return gets positive class."""
        result = generator._get_value_class("total_return", 0.10)
        assert result == "positive"

    def test_value_class_negative_return(self, generator) -> None:
        """Test negative return gets negative class."""
        result = generator._get_value_class("total_return", -0.10)
        assert result == "negative"

    def test_value_class_zero_return(self, generator) -> None:
        """Test zero return gets neutral class."""
        result = generator._get_value_class("total_return", 0.0)
        assert result == "neutral"

    def test_value_class_high_sharpe(self, generator) -> None:
        """Test high Sharpe gets positive class."""
        result = generator._get_value_class("sharpe_ratio", 1.5)
        assert result == "positive"

    def test_value_class_negative_sharpe(self, generator) -> None:
        """Test negative Sharpe gets negative class."""
        result = generator._get_value_class("sharpe_ratio", -0.5)
        assert result == "negative"

    def test_value_class_high_win_rate(self, generator) -> None:
        """Test high win rate gets positive class."""
        result = generator._get_value_class("win_rate", 0.6)
        assert result == "positive"

    def test_value_class_low_win_rate(self, generator) -> None:
        """Test low win rate gets negative class."""
        result = generator._get_value_class("win_rate", 0.35)
        assert result == "negative"

    def test_value_class_bad_drawdown(self, generator) -> None:
        """Test bad drawdown gets negative class."""
        result = generator._get_value_class("max_drawdown", -0.20)
        assert result == "negative"

    def test_value_class_none(self, generator) -> None:
        """Test None value gets neutral class."""
        result = generator._get_value_class("total_return", None)
        assert result == "neutral"

    def test_value_class_na(self, generator) -> None:
        """Test N/A value gets neutral class."""
        result = generator._get_value_class("total_return", "N/A")
        assert result == "neutral"


class TestExportToHTML:
    """Tests for export_to_html convenience function."""

    @pytest.fixture
    def sample_metrics(self):
        """Create sample metrics."""
        return {
            "total_return": 0.25,
            "sharpe_ratio": 1.5,
        }

    @pytest.fixture
    def sample_trades(self):
        """Create sample trades."""
        return [
            {
                "symbol": "AAPL",
                "side": "buy",
                "quantity": 100,
                "pnl": 500.00,
            }
        ]

    def test_export_to_html(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_html function."""
        output_path = tmp_path / "report.html"

        result = export_to_html(output_path, sample_metrics, sample_trades)

        assert result == output_path
        assert output_path.exists()

    def test_export_to_html_string_path(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_html with string path."""
        output_path = str(tmp_path / "report.html")

        result = export_to_html(output_path, sample_metrics, sample_trades)

        assert isinstance(result, Path)
        assert result.exists()

    def test_export_to_html_with_strategy_name(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_html with strategy name."""
        output_path = tmp_path / "report.html"

        result = export_to_html(
            output_path,
            sample_metrics,
            sample_trades,
            strategy_name="MyStrategy",
        )

        content = result.read_text()
        assert "MyStrategy" in content

    def test_export_to_html_with_equity_curve(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_html with equity curve."""
        output_path = tmp_path / "report.html"
        equity_curve = [
            {"equity": 100000},
            {"equity": 101000},
            {"equity": 102000},
        ]

        result = export_to_html(
            output_path,
            sample_metrics,
            sample_trades,
            equity_curve=equity_curve,
        )

        content = result.read_text()
        assert "Equity Curve" in content

    def test_export_to_html_with_parameters(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_html with parameters."""
        output_path = tmp_path / "report.html"
        parameters = {"lookback": 20}

        result = export_to_html(
            output_path,
            sample_metrics,
            sample_trades,
            parameters=parameters,
        )

        content = result.read_text()
        assert "Strategy Parameters" in content
