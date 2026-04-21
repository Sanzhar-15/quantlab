"""
Tests for JSON Export Module.

Tests JSONExporter functionality and dataclasses.
"""

import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from quantlab.export.json import (
    ExportMetadata,
    TradeRecord,
    PerformanceMetrics,
    EquityCurvePoint,
    JSONExporter,
    export_to_json,
)


class TestExportMetadata:
    """Tests for ExportMetadata dataclass."""

    def test_default_values(self) -> None:
        """Test default metadata values."""
        metadata = ExportMetadata()

        assert metadata.version == "1.0"
        assert metadata.exported_at != ""  # Should be auto-set
        assert metadata.strategy_file == ""
        assert metadata.strategy_name == ""
        assert metadata.quantlab_version == ""

    def test_custom_values(self) -> None:
        """Test custom metadata values."""
        metadata = ExportMetadata(
            version="2.0",
            strategy_file="my_strategy.py",
            strategy_name="MyStrategy",
            quantlab_version="10.0.0",
        )

        assert metadata.version == "2.0"
        assert metadata.strategy_file == "my_strategy.py"
        assert metadata.strategy_name == "MyStrategy"

    def test_exported_at_auto_set(self) -> None:
        """Test that exported_at is auto-set in __post_init__."""
        metadata = ExportMetadata()

        # Should be valid ISO timestamp
        datetime.fromisoformat(metadata.exported_at)


class TestTradeRecord:
    """Tests for TradeRecord dataclass."""

    def test_creation(self) -> None:
        """Test trade record creation."""
        record = TradeRecord(
            trade_id="T001",
            symbol="AAPL",
            side="buy",
            quantity="100",
            entry_price="150.00",
            exit_price="155.00",
            entry_time="2024-01-15T09:30:00",
            exit_time="2024-01-15T16:00:00",
            pnl="500.00",
            pnl_percent="3.33",
            commission="10.00",
            holding_period_bars=78,
        )

        assert record.trade_id == "T001"
        assert record.symbol == "AAPL"
        assert record.holding_period_bars == 78


class TestPerformanceMetrics:
    """Tests for PerformanceMetrics dataclass."""

    def test_creation(self) -> None:
        """Test performance metrics creation."""
        metrics = PerformanceMetrics(
            total_return="0.1234",
            cagr="0.08",
            sharpe_ratio="1.5",
            sortino_ratio="2.0",
            max_drawdown="-0.15",
            max_drawdown_duration=30,
            win_rate="0.55",
            profit_factor="1.8",
            average_trade="150.00",
            total_trades=100,
            winning_trades=55,
            losing_trades=45,
            average_win="350.00",
            average_loss="-200.00",
            largest_win="1500.00",
            largest_loss="-800.00",
            avg_holding_period=5.5,
            exposure_time="0.65",
        )

        assert metrics.total_trades == 100
        assert metrics.winning_trades == 55
        assert metrics.avg_holding_period == 5.5


class TestEquityCurvePoint:
    """Tests for EquityCurvePoint dataclass."""

    def test_creation(self) -> None:
        """Test equity curve point creation."""
        point = EquityCurvePoint(
            timestamp="2024-01-15T09:30:00",
            equity="100500.00",
            drawdown="-0.005",
        )

        assert point.timestamp == "2024-01-15T09:30:00"
        assert point.equity == "100500.00"
        assert point.benchmark is None

    def test_with_benchmark(self) -> None:
        """Test equity curve point with benchmark."""
        point = EquityCurvePoint(
            timestamp="2024-01-15T09:30:00",
            equity="100500.00",
            drawdown="-0.005",
            benchmark="100200.00",
        )

        assert point.benchmark == "100200.00"


class TestJSONExporter:
    """Tests for JSONExporter class."""

    @pytest.fixture
    def exporter(self):
        """Create JSON exporter."""
        return JSONExporter(
            strategy_file="my_strategy.py",
            strategy_name="MyStrategy",
        )

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
        }

    def test_init_default(self) -> None:
        """Test default initialization."""
        exporter = JSONExporter()

        assert exporter.metadata.strategy_file == ""
        assert exporter.metadata.strategy_name == ""
        assert exporter.metadata.quantlab_version == "10.0.0"

    def test_init_with_params(self, exporter) -> None:
        """Test initialization with parameters."""
        assert exporter.metadata.strategy_file == "my_strategy.py"
        assert exporter.metadata.strategy_name == "MyStrategy"

    def test_export_string(self, exporter, sample_metrics, sample_trades) -> None:
        """Test exporting to JSON string."""
        result = exporter.export_string(sample_metrics, sample_trades)

        assert isinstance(result, str)

        data = json.loads(result)
        assert "metadata" in data
        assert "metrics" in data
        assert "trades" in data
        assert "parameters" in data

    def test_export_string_with_equity_curve(
        self, exporter, sample_metrics, sample_trades
    ) -> None:
        """Test exporting with equity curve."""
        equity_curve = [
            {"timestamp": "2024-01-01", "equity": "100000"},
            {"timestamp": "2024-01-02", "equity": "100500"},
        ]

        result = exporter.export_string(
            sample_metrics, sample_trades, equity_curve=equity_curve
        )

        data = json.loads(result)
        assert "equity_curve" in data
        assert len(data["equity_curve"]) == 2

    def test_export_string_with_parameters(
        self, exporter, sample_metrics, sample_trades
    ) -> None:
        """Test exporting with strategy parameters."""
        parameters = {"lookback": 20, "threshold": 0.05}

        result = exporter.export_string(
            sample_metrics, sample_trades, parameters=parameters
        )

        data = json.loads(result)
        assert data["parameters"]["lookback"] == 20
        assert data["parameters"]["threshold"] == 0.05

    def test_export_file(
        self, exporter, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test exporting to JSON file."""
        output_path = tmp_path / "results.json"

        result = exporter.export(output_path, sample_metrics, sample_trades)

        assert result == output_path
        assert output_path.exists()

        with open(output_path) as f:
            data = json.load(f)

        assert "metadata" in data
        assert "metrics" in data
        assert "trades" in data

    def test_serialize_metrics_decimal(self, exporter) -> None:
        """Test serializing Decimal metrics."""
        metrics = {"value": Decimal("123.456")}
        result = exporter._serialize_metrics(metrics)

        assert result["value"] == "123.456"

    def test_serialize_metrics_datetime(self, exporter) -> None:
        """Test serializing datetime metrics."""
        dt = datetime(2024, 1, 15, 10, 30, 0)
        metrics = {"date": dt}
        result = exporter._serialize_metrics(metrics)

        assert "2024-01-15" in result["date"]

    def test_serialize_metrics_nan(self, exporter) -> None:
        """Test serializing NaN metrics."""
        metrics = {"value": float("nan")}
        result = exporter._serialize_metrics(metrics)

        assert result["value"] is None

    def test_serialize_metrics_regular(self, exporter) -> None:
        """Test serializing regular metrics."""
        metrics = {"count": 100, "rate": 0.55}
        result = exporter._serialize_metrics(metrics)

        assert result["count"] == 100
        assert result["rate"] == 0.55

    def test_serialize_trade_decimal(self, exporter) -> None:
        """Test serializing Decimal trade values."""
        trade = {"price": Decimal("150.00")}
        result = exporter._serialize_trade(trade)

        assert result["price"] == "150.00"

    def test_serialize_trade_datetime(self, exporter) -> None:
        """Test serializing datetime trade values."""
        dt = datetime(2024, 1, 15, 10, 30, 0)
        trade = {"timestamp": dt}
        result = exporter._serialize_trade(trade)

        assert "2024-01-15" in result["timestamp"]

    def test_json_serializer_decimal(self, exporter) -> None:
        """Test custom JSON serializer for Decimal."""
        result = exporter._json_serializer(Decimal("123.456"))
        assert result == "123.456"

    def test_json_serializer_datetime(self, exporter) -> None:
        """Test custom JSON serializer for datetime."""
        dt = datetime(2024, 1, 15, 10, 30, 0)
        result = exporter._json_serializer(dt)
        assert "2024-01-15" in result

    def test_json_serializer_object_with_dict(self, exporter) -> None:
        """Test custom JSON serializer for objects with __dict__."""

        class Obj:
            def __init__(self):
                self.value = 42

        obj = Obj()
        result = exporter._json_serializer(obj)
        assert result == {"value": 42}

    def test_json_serializer_unsupported(self, exporter) -> None:
        """Test custom JSON serializer raises for unsupported types."""
        with pytest.raises(TypeError):
            exporter._json_serializer(set([1, 2, 3]))


class TestJSONExporterEdgeCases:
    """Edge case tests for JSON export."""

    @pytest.fixture
    def exporter(self):
        """Create JSON exporter."""
        return JSONExporter()

    def test_empty_trades(self, exporter) -> None:
        """Test exporting with empty trades list."""
        result = exporter.export_string({}, [])
        data = json.loads(result)

        assert data["trades"] == []
        assert data["metrics"] == {}

    def test_empty_metrics(self, exporter) -> None:
        """Test exporting with empty metrics."""
        result = exporter.export_string({}, [{"id": "T001"}])
        data = json.loads(result)

        assert data["metrics"] == {}
        assert len(data["trades"]) == 1


class TestConvenienceFunction:
    """Tests for export_to_json convenience function."""

    @pytest.fixture
    def sample_trades(self):
        """Create sample trade data."""
        return [
            {
                "trade_id": "T001",
                "symbol": "AAPL",
                "side": "buy",
            }
        ]

    @pytest.fixture
    def sample_metrics(self):
        """Create sample metrics data."""
        return {
            "total_return": Decimal("0.1234"),
        }

    def test_export_to_json(self, sample_metrics, sample_trades, tmp_path) -> None:
        """Test export_to_json convenience function."""
        output_path = tmp_path / "results.json"

        result = export_to_json(output_path, sample_metrics, sample_trades)

        assert result == output_path
        assert output_path.exists()

    def test_export_to_json_string_path(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_json with string path."""
        output_path = str(tmp_path / "results.json")

        result = export_to_json(output_path, sample_metrics, sample_trades)

        assert isinstance(result, Path)
        assert result.exists()

    def test_export_to_json_with_strategy_file(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_json with strategy file."""
        output_path = tmp_path / "results.json"

        result = export_to_json(
            output_path,
            sample_metrics,
            sample_trades,
            strategy_file="my_strategy.py",
        )

        with open(result) as f:
            data = json.load(f)

        assert data["metadata"]["strategy_file"] == "my_strategy.py"

    def test_export_to_json_with_equity_curve(
        self, sample_metrics, sample_trades, tmp_path
    ) -> None:
        """Test export_to_json with equity curve."""
        output_path = tmp_path / "results.json"
        equity_curve = [{"timestamp": "2024-01-01", "equity": "100000"}]

        result = export_to_json(
            output_path,
            sample_metrics,
            sample_trades,
            equity_curve=equity_curve,
        )

        with open(result) as f:
            data = json.load(f)

        assert "equity_curve" in data
