"""
Tests for Phase 3 Visualization Protocol module.

Tests protocol messages for Chart View communication.
"""

import pytest
import json
from datetime import datetime

from quantlab.protocol.visualization import (
    VisualizationMessageType,
    ChartDataFormat,
    OHLCVData,
    SignalMarker,
    PlotCommand,
    IndicatorCommand,
    PaneCommand,
    VisualizationRequest,
    VisualizationResponse,
    DataLoadResponse,
    VisualizationCommandsResponse,
    ParametersResponse,
    ComplexityResponse,
    VisualizationErrorCode,
    create_data_response,
    create_commands_response,
    create_params_response,
    create_complexity_response,
)


class TestVisualizationMessageType:
    """Tests for VisualizationMessageType enum."""

    def test_request_types(self) -> None:
        """Test request message types."""
        assert VisualizationMessageType.VIZ_INIT.value == "viz.init"
        assert VisualizationMessageType.VIZ_LOAD_DATA.value == "viz.loadData"
        assert VisualizationMessageType.VIZ_EXECUTE.value == "viz.execute"
        assert VisualizationMessageType.VIZ_GET_PARAMS.value == "viz.getParams"
        assert VisualizationMessageType.VIZ_UPDATE_PARAM.value == "viz.updateParam"
        assert VisualizationMessageType.VIZ_APPLY_PARAMS.value == "viz.applyParams"
        assert VisualizationMessageType.VIZ_ANALYZE.value == "viz.analyze"

    def test_response_types(self) -> None:
        """Test response message types."""
        assert VisualizationMessageType.VIZ_DATA.value == "viz.data"
        assert VisualizationMessageType.VIZ_COMMANDS.value == "viz.commands"
        assert VisualizationMessageType.VIZ_PARAMS.value == "viz.params"
        assert VisualizationMessageType.VIZ_COMPLEXITY.value == "viz.complexity"
        assert VisualizationMessageType.VIZ_ERROR.value == "viz.error"


class TestChartDataFormat:
    """Tests for ChartDataFormat enum."""

    def test_formats(self) -> None:
        """Test data format values."""
        assert ChartDataFormat.JSON.value == "json"
        assert ChartDataFormat.BINARY.value == "binary"
        assert ChartDataFormat.ARROW.value == "arrow"


class TestOHLCVData:
    """Tests for OHLCVData dataclass."""

    def test_creation(self) -> None:
        """Test OHLCV data creation."""
        data = OHLCVData(
            timestamp=1704067200.0,
            open=100.0,
            high=105.0,
            low=98.0,
            close=103.0,
            volume=1000000,
        )
        assert data.timestamp == 1704067200.0
        assert data.close == 103.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        data = OHLCVData(
            timestamp=1704067200.0,
            open=100.0,
            high=105.0,
            low=98.0,
            close=103.0,
            volume=1000000,
        )
        d = data.to_dict()

        assert d["timestamp"] == 1704067200.0
        assert d["open"] == 100.0
        assert d["high"] == 105.0
        assert d["low"] == 98.0
        assert d["close"] == 103.0
        assert d["volume"] == 1000000


class TestSignalMarker:
    """Tests for SignalMarker dataclass."""

    def test_entry_marker(self) -> None:
        """Test entry signal marker."""
        marker = SignalMarker(
            timestamp=1704067200.0,
            price=100.0,
            side="long",
            type="entry",
            label="Buy Signal",
        )
        assert marker.side == "long"
        assert marker.type == "entry"

    def test_exit_marker(self) -> None:
        """Test exit signal marker."""
        marker = SignalMarker(
            timestamp=1704153600.0,
            price=105.0,
            side="long",
            type="exit",
        )
        assert marker.type == "exit"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        marker = SignalMarker(
            timestamp=1704067200.0,
            price=100.0,
            side="short",
            type="entry",
            color="#FF0000",
        )
        d = marker.to_dict()

        assert d["side"] == "short"
        assert d["type"] == "entry"
        assert d["color"] == "#FF0000"


class TestPlotCommand:
    """Tests for PlotCommand dataclass."""

    def test_basic_plot(self) -> None:
        """Test basic plot command."""
        cmd = PlotCommand(
            series_name="sma_20",
            values=[1.0, 2.0, 3.0],
        )
        assert cmd.series_name == "sma_20"
        assert cmd.style == "line"  # default
        assert cmd.pane == "main"  # default

    def test_styled_plot(self) -> None:
        """Test styled plot command."""
        cmd = PlotCommand(
            series_name="rsi",
            values=[50.0, 60.0, 55.0],
            color="#00FF00",
            line_width=2,
            style="histogram",
            pane="indicators",
        )
        assert cmd.color == "#00FF00"
        assert cmd.style == "histogram"
        assert cmd.pane == "indicators"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        cmd = PlotCommand(
            series_name="test",
            values=[1.0, 2.0],
            timestamps=[1704067200.0, 1704153600.0],
        )
        d = cmd.to_dict()

        assert d["type"] == "plot"
        assert d["seriesName"] == "test"
        assert d["values"] == [1.0, 2.0]
        assert d["timestamps"] == [1704067200.0, 1704153600.0]


class TestIndicatorCommand:
    """Tests for IndicatorCommand dataclass."""

    def test_sma_indicator(self) -> None:
        """Test SMA indicator command."""
        cmd = IndicatorCommand(
            indicator_type="sma",
            params={"period": 20},
            name="SMA 20",
        )
        assert cmd.indicator_type == "sma"
        assert cmd.params["period"] == 20

    def test_bollinger_indicator(self) -> None:
        """Test Bollinger Bands indicator command."""
        cmd = IndicatorCommand(
            indicator_type="bollinger",
            params={"period": 20, "std_dev": 2.0},
            pane="main",
        )
        assert cmd.params["std_dev"] == 2.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        cmd = IndicatorCommand(
            indicator_type="rsi",
            params={"period": 14},
            pane="oscillators",
            color="#0000FF",
        )
        d = cmd.to_dict()

        assert d["type"] == "indicator"
        assert d["indicatorType"] == "rsi"
        assert d["params"]["period"] == 14
        assert d["pane"] == "oscillators"


class TestPaneCommand:
    """Tests for PaneCommand dataclass."""

    def test_basic_pane(self) -> None:
        """Test basic pane command."""
        cmd = PaneCommand(name="indicators")
        assert cmd.name == "indicators"
        assert cmd.height == 0.2  # default
        assert cmd.position == "below"  # default

    def test_custom_pane(self) -> None:
        """Test custom pane command."""
        cmd = PaneCommand(
            name="equity",
            height=0.3,
            position="above",
        )
        assert cmd.height == 0.3
        assert cmd.position == "above"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        cmd = PaneCommand(name="volume", height=0.15)
        d = cmd.to_dict()

        assert d["type"] == "addPane"
        assert d["name"] == "volume"
        assert d["height"] == 0.15


class TestVisualizationRequest:
    """Tests for VisualizationRequest dataclass."""

    def test_basic_request(self) -> None:
        """Test basic request creation."""
        req = VisualizationRequest(
            message_type=VisualizationMessageType.VIZ_INIT,
            payload={"theme": "dark"},
        )
        assert req.message_type == VisualizationMessageType.VIZ_INIT
        assert req.request_id is not None

    def test_to_dict(self) -> None:
        """Test conversion to JSON-RPC format."""
        req = VisualizationRequest(
            message_type=VisualizationMessageType.VIZ_LOAD_DATA,
            payload={"symbol": "AAPL"},
            request_id="test-123",
        )
        d = req.to_dict()

        assert d["jsonrpc"] == "2.0"
        assert d["method"] == "viz.loadData"
        assert d["params"]["symbol"] == "AAPL"
        assert d["id"] == "test-123"

    def test_init_chart_factory(self) -> None:
        """Test init_chart factory method."""
        req = VisualizationRequest.init_chart(theme="dark", locale="en-US")

        assert req.message_type == VisualizationMessageType.VIZ_INIT
        assert req.payload["theme"] == "dark"
        assert req.payload["locale"] == "en-US"

    def test_load_data_factory(self) -> None:
        """Test load_data factory method."""
        req = VisualizationRequest.load_data(
            symbol="AAPL",
            timeframe="1D",
            start="2024-01-01",
            end="2024-12-31",
        )

        assert req.message_type == VisualizationMessageType.VIZ_LOAD_DATA
        assert req.payload["symbol"] == "AAPL"
        assert req.payload["timeframe"] == "1D"

    def test_execute_visualization_factory(self) -> None:
        """Test execute_visualization factory method."""
        req = VisualizationRequest.execute_visualization(
            strategy_path="/path/to/strategy.py",
            params={"period": 20},
        )

        assert req.message_type == VisualizationMessageType.VIZ_EXECUTE
        assert req.payload["strategyPath"] == "/path/to/strategy.py"
        assert req.payload["params"]["period"] == 20

    def test_get_params_factory(self) -> None:
        """Test get_params factory method."""
        req = VisualizationRequest.get_params("/path/to/strategy.py")

        assert req.message_type == VisualizationMessageType.VIZ_GET_PARAMS
        assert req.payload["strategyPath"] == "/path/to/strategy.py"

    def test_update_param_factory(self) -> None:
        """Test update_param factory method."""
        req = VisualizationRequest.update_param(
            param_name="period",
            value=30,
        )

        assert req.message_type == VisualizationMessageType.VIZ_UPDATE_PARAM
        assert req.payload["paramName"] == "period"
        assert req.payload["value"] == 30

    def test_analyze_complexity_factory(self) -> None:
        """Test analyze_complexity factory method."""
        req = VisualizationRequest.analyze_complexity("/path/to/strategy.py")

        assert req.message_type == VisualizationMessageType.VIZ_ANALYZE


class TestVisualizationResponse:
    """Tests for VisualizationResponse dataclass."""

    def test_success_response(self) -> None:
        """Test successful response."""
        resp = VisualizationResponse(
            request_id="test-123",
            success=True,
            data={"result": "ok"},
        )
        assert resp.success is True
        assert resp.data["result"] == "ok"

    def test_error_response(self) -> None:
        """Test error response."""
        resp = VisualizationResponse(
            request_id="test-123",
            success=False,
            error="Something went wrong",
            error_code=-32000,
        )
        assert resp.success is False
        assert resp.error == "Something went wrong"

    def test_to_dict_success(self) -> None:
        """Test conversion to dict for success."""
        resp = VisualizationResponse.success(
            request_id="test-123",
            data={"value": 42},
        )
        d = resp.to_dict()

        assert d["jsonrpc"] == "2.0"
        assert d["id"] == "test-123"
        assert d["result"]["value"] == 42
        assert "error" not in d

    def test_to_dict_error(self) -> None:
        """Test conversion to dict for error."""
        resp = VisualizationResponse.error(
            request_id="test-123",
            message="Not found",
            code=-32100,
        )
        d = resp.to_dict()

        assert d["jsonrpc"] == "2.0"
        assert d["id"] == "test-123"
        assert d["error"]["code"] == -32100
        assert d["error"]["message"] == "Not found"
        assert "result" not in d

    def test_success_factory(self) -> None:
        """Test success factory method."""
        resp = VisualizationResponse.success("req-1", {"data": "value"})

        assert resp.success is True
        assert resp.request_id == "req-1"

    def test_error_factory(self) -> None:
        """Test error factory method."""
        resp = VisualizationResponse.error("req-1", "Error message", -32001)

        assert resp.success is False
        assert resp.error == "Error message"
        assert resp.error_code == -32001


class TestDataLoadResponse:
    """Tests for DataLoadResponse dataclass."""

    def test_creation(self) -> None:
        """Test data load response creation."""
        resp = DataLoadResponse(
            symbol="AAPL",
            timeframe="1D",
            bars=[{"timestamp": 1704067200.0, "close": 100.0}],
            start_timestamp=1704067200.0,
            end_timestamp=1704153600.0,
            bar_count=1,
            format=ChartDataFormat.JSON,
        )
        assert resp.symbol == "AAPL"
        assert resp.bar_count == 1

    def test_to_dict_json(self) -> None:
        """Test conversion to dict for JSON format."""
        resp = DataLoadResponse(
            symbol="AAPL",
            timeframe="1D",
            bars=[{"timestamp": 1704067200.0, "close": 100.0}],
            start_timestamp=1704067200.0,
            end_timestamp=1704153600.0,
            bar_count=1,
            format=ChartDataFormat.JSON,
        )
        d = resp.to_dict()

        assert d["symbol"] == "AAPL"
        assert d["bars"] is not None
        assert d["barCount"] == 1

    def test_to_dict_binary(self) -> None:
        """Test conversion to dict for binary format."""
        resp = DataLoadResponse(
            symbol="AAPL",
            timeframe="1D",
            bars=[],
            start_timestamp=1704067200.0,
            end_timestamp=1704153600.0,
            bar_count=100,
            format=ChartDataFormat.BINARY,
            binary_data=b"binary_data_here",
        )
        d = resp.to_dict()

        assert "bars" not in d
        assert d["binarySize"] == 16


class TestVisualizationCommandsResponse:
    """Tests for VisualizationCommandsResponse dataclass."""

    def test_creation(self) -> None:
        """Test commands response creation."""
        resp = VisualizationCommandsResponse(
            commands=[{"type": "plot", "seriesName": "sma"}],
            panes={"main": {"height": 1.0}},
            signals=[{"timestamp": 1704067200.0, "type": "entry"}],
        )
        assert len(resp.commands) == 1
        assert "main" in resp.panes

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        resp = VisualizationCommandsResponse(
            commands=[{"type": "plot"}],
            panes={},
            signals=[],
        )
        d = resp.to_dict()

        assert "commands" in d
        assert "panes" in d
        assert "signals" in d


class TestParametersResponse:
    """Tests for ParametersResponse dataclass."""

    def test_creation(self) -> None:
        """Test parameters response creation."""
        resp = ParametersResponse(
            groups=[
                {
                    "name": "Strategy",
                    "parameters": [
                        {"name": "period", "type": "int", "default": 20},
                    ],
                }
            ],
            parameter_count=1,
            has_visualize=True,
        )
        assert len(resp.groups) == 1
        assert resp.has_visualize is True

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        resp = ParametersResponse(
            groups=[],
            parameter_count=0,
            has_visualize=False,
        )
        d = resp.to_dict()

        assert d["parameterCount"] == 0
        assert d["hasVisualize"] is False


class TestComplexityResponse:
    """Tests for ComplexityResponse dataclass."""

    def test_creation(self) -> None:
        """Test complexity response creation."""
        resp = ComplexityResponse(
            level="safe",
            score=10,
            confidence=0.95,
            factors=[],
            color="#059669",
            indicator_dots=1,
        )
        assert resp.level == "safe"
        assert resp.score == 10

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        resp = ComplexityResponse(
            level="partial",
            score=35,
            confidence=0.85,
            factors=[{"name": "external_import", "severity": 3}],
            color="#d97706",
            indicator_dots=2,
        )
        d = resp.to_dict()

        assert d["level"] == "partial"
        assert d["score"] == 35
        assert d["indicatorDots"] == 2


class TestVisualizationErrorCode:
    """Tests for VisualizationErrorCode class."""

    def test_error_codes(self) -> None:
        """Test error code values."""
        assert VisualizationErrorCode.STRATEGY_NOT_FOUND == -32100
        assert VisualizationErrorCode.PARSE_ERROR == -32101
        assert VisualizationErrorCode.EXECUTION_ERROR == -32102
        assert VisualizationErrorCode.DATA_LOAD_ERROR == -32103
        assert VisualizationErrorCode.PARAM_INVALID == -32104
        assert VisualizationErrorCode.NO_VISUALIZE_FUNCTION == -32105
        assert VisualizationErrorCode.COMPLEXITY_TOO_HIGH == -32106


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_create_data_response(self) -> None:
        """Test create_data_response helper."""
        bars = [
            {"timestamp": 1704067200.0, "close": 100.0},
            {"timestamp": 1704153600.0, "close": 101.0},
        ]
        resp = create_data_response("req-1", "AAPL", "1D", bars)

        assert resp.success is True
        assert resp.request_id == "req-1"
        data = resp.data
        assert data["symbol"] == "AAPL"
        assert data["barCount"] == 2

    def test_create_commands_response(self) -> None:
        """Test create_commands_response helper."""
        commands = [{"type": "plot", "seriesName": "sma"}]
        panes = {"main": {"height": 1.0}}
        signals = [{"timestamp": 1704067200.0, "type": "entry"}]

        resp = create_commands_response("req-1", commands, panes, signals)

        assert resp.success is True
        data = resp.data
        assert len(data["commands"]) == 1
        assert len(data["signals"]) == 1

    def test_create_params_response(self) -> None:
        """Test create_params_response helper."""
        groups = [
            {
                "name": "Strategy",
                "parameters": [{"name": "period"}],
            }
        ]
        resp = create_params_response("req-1", groups, 1, True)

        assert resp.success is True
        data = resp.data
        assert data["parameterCount"] == 1
        assert data["hasVisualize"] is True

    def test_create_complexity_response(self) -> None:
        """Test create_complexity_response helper."""
        factors = [{"name": "external_import", "severity": 3}]
        resp = create_complexity_response(
            "req-1",
            level="safe",
            score=10,
            confidence=0.95,
            factors=factors,
            color="#059669",
            indicator_dots=1,
        )

        assert resp.success is True
        data = resp.data
        assert data["level"] == "safe"
        assert data["score"] == 10
