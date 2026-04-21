"""
Tests for Phase 3 Visualization Sandbox module.

Tests ChartProxy, VisualizationExecutor, and SafeExecutor.
"""

import pytest
import json
from unittest.mock import Mock, patch

from quantlab.runtime.visualization import (
    ChartCommand,
    ChartCommandType,
    ChartProxy,
    VisualizationExecutor,
    VisualizationResult,
    SafeExecutor,
    VisualizationExtractor,
)


class TestChartCommand:
    """Tests for ChartCommand dataclass."""

    def test_plot_command(self) -> None:
        """Test creating a plot command."""
        cmd = ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name="sma_20",
            values=[1.0, 2.0, 3.0],
            color="#FF0000",
        )
        assert cmd.command_type == ChartCommandType.PLOT
        assert cmd.series_name == "sma_20"
        assert cmd.values == [1.0, 2.0, 3.0]
        assert cmd.color == "#FF0000"

    def test_marker_command(self) -> None:
        """Test creating a marker command."""
        cmd = ChartCommand(
            command_type=ChartCommandType.MARK_ENTRY,
            timestamps=[1704067200.0],
            prices=[100.0],
            side="long",
        )
        assert cmd.command_type == ChartCommandType.MARK_ENTRY
        assert cmd.side == "long"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        cmd = ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name="sma_20",
            values=[1.0, 2.0, 3.0],
        )
        d = cmd.to_dict()
        assert d["type"] == "plot"
        assert d["seriesName"] == "sma_20"


class TestChartProxy:
    """Tests for ChartProxy class."""

    def test_plot(self) -> None:
        """Test plot method."""
        proxy = ChartProxy()
        proxy.plot([1.0, 2.0, 3.0], name="test_series")

        assert len(proxy.commands) == 1
        assert proxy.commands[0].command_type == ChartCommandType.PLOT
        assert proxy.commands[0].series_name == "test_series"

    def test_plot_with_options(self) -> None:
        """Test plot with color and style options."""
        proxy = ChartProxy()
        proxy.plot(
            [1.0, 2.0, 3.0],
            name="styled_series",
            color="#00FF00",
            line_width=2,
            style="dashed",
        )

        cmd = proxy.commands[0]
        assert cmd.color == "#00FF00"
        assert cmd.line_width == 2
        assert cmd.style == "dashed"

    def test_plot_to_pane(self) -> None:
        """Test plotting to a specific pane."""
        proxy = ChartProxy()
        proxy.plot([1.0, 2.0, 3.0], name="rsi", pane="indicators")

        assert proxy.commands[0].pane == "indicators"

    def test_mark_entries(self) -> None:
        """Test marking entry signals."""
        proxy = ChartProxy()
        proxy.mark_entries(
            timestamps=[1704067200.0, 1704153600.0],
            prices=[100.0, 105.0],
            side="long",
        )

        assert len(proxy.commands) == 1
        cmd = proxy.commands[0]
        assert cmd.command_type == ChartCommandType.MARK_ENTRY
        assert cmd.side == "long"
        assert len(cmd.timestamps) == 2

    def test_mark_exits(self) -> None:
        """Test marking exit signals."""
        proxy = ChartProxy()
        proxy.mark_exits(
            timestamps=[1704240000.0],
            prices=[108.0],
            side="long",
        )

        cmd = proxy.commands[0]
        assert cmd.command_type == ChartCommandType.MARK_EXIT
        assert cmd.side == "long"

    def test_add_pane(self) -> None:
        """Test adding a pane."""
        proxy = ChartProxy()
        proxy.add_pane("indicators", height=0.3)

        assert "indicators" in proxy.panes
        assert proxy.panes["indicators"]["height"] == 0.3

    def test_plot_equity(self) -> None:
        """Test plotting equity curve."""
        proxy = ChartProxy()
        equity = [10000.0, 10100.0, 10050.0, 10200.0]
        proxy.plot_equity(equity)

        # Should add pane and plot
        assert "equity" in proxy.panes
        assert any(
            cmd.series_name == "equity" for cmd in proxy.commands
        )

    def test_to_dict(self) -> None:
        """Test converting proxy state to dictionary."""
        proxy = ChartProxy()
        proxy.plot([1.0, 2.0], name="test")
        proxy.add_pane("indicators")
        proxy.mark_entries([1704067200.0], [100.0], "long")

        d = proxy.to_dict()
        assert "commands" in d
        assert "panes" in d
        assert "signals" in d

    def test_to_json(self) -> None:
        """Test JSON serialization."""
        proxy = ChartProxy()
        proxy.plot([1.0, 2.0], name="test")

        json_str = proxy.to_json()
        parsed = json.loads(json_str)

        assert "commands" in parsed
        assert len(parsed["commands"]) == 1

    def test_clear(self) -> None:
        """Test clearing proxy state."""
        proxy = ChartProxy()
        proxy.plot([1.0, 2.0], name="test")
        proxy.add_pane("indicators")

        proxy.clear()

        assert len(proxy.commands) == 0
        assert len(proxy.panes) == 0


class TestVisualizationExtractor:
    """Tests for VisualizationExtractor class."""

    def test_extract_visualize_function(self) -> None:
        """Test extracting visualize function from code."""
        code = '''
def visualize(chart, data, params):
    sma = calculate_sma(data.close, params["period"])
    chart.plot(sma, name="SMA")
    chart.mark_entries([1704067200.0], [100.0], "long")
'''
        extractor = VisualizationExtractor()
        func_code = extractor.extract_visualize(code)

        assert func_code is not None
        assert "def visualize" in func_code
        assert "chart.plot" in func_code

    def test_no_visualize_function(self) -> None:
        """Test code without visualize function."""
        code = '''
def strategy(data):
    return signals
'''
        extractor = VisualizationExtractor()
        func_code = extractor.extract_visualize(code)

        assert func_code is None

    def test_has_visualize(self) -> None:
        """Test checking for visualize function."""
        extractor = VisualizationExtractor()

        code_with = '''
def visualize(chart, data, params):
    pass
'''
        code_without = '''
def strategy(data):
    pass
'''
        assert extractor.has_visualize(code_with) is True
        assert extractor.has_visualize(code_without) is False


class TestSafeExecutor:
    """Tests for SafeExecutor class."""

    def test_safe_builtins(self) -> None:
        """Test that safe builtins are available."""
        executor = SafeExecutor()
        globals_dict = executor.get_safe_globals()

        # Should have safe builtins
        assert "len" in globals_dict["__builtins__"]
        assert "range" in globals_dict["__builtins__"]
        assert "sum" in globals_dict["__builtins__"]
        assert "min" in globals_dict["__builtins__"]
        assert "max" in globals_dict["__builtins__"]

    def test_dangerous_builtins_removed(self) -> None:
        """Test that dangerous builtins are not available."""
        executor = SafeExecutor()
        globals_dict = executor.get_safe_globals()

        builtins = globals_dict["__builtins__"]
        assert "eval" not in builtins
        assert "exec" not in builtins
        assert "compile" not in builtins
        assert "__import__" not in builtins
        assert "open" not in builtins

    def test_execute_simple(self) -> None:
        """Test executing simple code."""
        executor = SafeExecutor()
        code = "result = 1 + 2"
        namespace = executor.execute(code)

        assert namespace["result"] == 3

    def test_execute_with_math(self) -> None:
        """Test executing code with math module."""
        executor = SafeExecutor()
        code = """
import math
result = math.sqrt(16)
"""
        namespace = executor.execute(code)
        assert namespace["result"] == 4.0

    def test_execute_blocks_dangerous(self) -> None:
        """Test that dangerous operations are blocked."""
        executor = SafeExecutor()

        # Should raise on eval
        with pytest.raises(Exception):
            executor.execute("eval('1+1')")

        # Should raise on open
        with pytest.raises(Exception):
            executor.execute("open('/etc/passwd')")


class TestVisualizationExecutor:
    """Tests for VisualizationExecutor class."""

    def test_execute_simple_strategy(self) -> None:
        """Test executing a simple visualization."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    chart.plot([1.0, 2.0, 3.0], name="test")
'''
        result = executor.execute(code)

        assert result.success is True
        assert len(result.commands) == 1
        assert result.commands[0]["seriesName"] == "test"

    def test_execute_with_data(self) -> None:
        """Test executing with data."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    chart.plot(data.close, name="close")
'''
        # Create mock data
        mock_data = Mock()
        mock_data.close = [100.0, 101.0, 102.0]

        result = executor.execute(code, data=mock_data)

        assert result.success is True
        assert result.commands[0]["values"] == [100.0, 101.0, 102.0]

    def test_execute_with_params(self) -> None:
        """Test executing with parameters."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    period = params.get("period", 20)
    chart.plot([float(period)], name="period_value")
'''
        params = {"period": 50}
        result = executor.execute(code, params=params)

        assert result.success is True
        assert result.commands[0]["values"] == [50.0]

    def test_execute_error_handling(self) -> None:
        """Test error handling in execution."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    raise ValueError("Test error")
'''
        result = executor.execute(code)

        assert result.success is False
        assert "Test error" in result.error

    def test_execute_no_visualize_function(self) -> None:
        """Test code without visualize function."""
        executor = VisualizationExecutor()
        code = '''
def strategy(data):
    pass
'''
        result = executor.execute(code)

        assert result.success is False
        assert "visualize" in result.error.lower()

    def test_execute_with_panes(self) -> None:
        """Test execution that adds panes."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    chart.add_pane("rsi", height=0.2)
    chart.plot([50.0, 60.0, 55.0], name="rsi", pane="rsi")
'''
        result = executor.execute(code)

        assert result.success is True
        assert "rsi" in result.panes
        assert result.panes["rsi"]["height"] == 0.2

    def test_execute_with_signals(self) -> None:
        """Test execution with entry/exit signals."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    chart.mark_entries([1704067200.0], [100.0], "long")
    chart.mark_exits([1704153600.0], [105.0], "long")
'''
        result = executor.execute(code)

        assert result.success is True
        # Commands include both entries and exits
        entry_cmd = [c for c in result.commands if c["type"] == "markEntry"]
        exit_cmd = [c for c in result.commands if c["type"] == "markExit"]
        assert len(entry_cmd) == 1
        assert len(exit_cmd) == 1

    def test_timeout(self) -> None:
        """Test execution timeout."""
        executor = VisualizationExecutor(timeout=0.1)
        code = '''
def visualize(chart, data, params):
    import time
    time.sleep(10)
'''
        result = executor.execute(code)

        assert result.success is False
        assert "timeout" in result.error.lower() or "time" in result.error.lower()


class TestVisualizationResult:
    """Tests for VisualizationResult dataclass."""

    def test_success_result(self) -> None:
        """Test successful result."""
        result = VisualizationResult(
            success=True,
            commands=[{"type": "plot", "seriesName": "test"}],
            panes={"main": {"height": 1.0}},
        )
        assert result.success is True
        assert len(result.commands) == 1

    def test_error_result(self) -> None:
        """Test error result."""
        result = VisualizationResult(
            success=False,
            error="Something went wrong",
            commands=[],
            panes={},
        )
        assert result.success is False
        assert result.error == "Something went wrong"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        result = VisualizationResult(
            success=True,
            commands=[{"type": "plot"}],
            panes={},
        )
        d = result.to_dict()
        assert d["success"] is True
        assert "commands" in d


class TestChartCommandSerialization:
    """Additional tests for ChartCommand serialization."""

    def test_serialize_decimal_values(self) -> None:
        """Test serializing Decimal values."""
        from decimal import Decimal
        cmd = ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name="test",
            values=[Decimal("1.5"), Decimal("2.5")],
        )
        d = cmd.to_dict()
        assert d["values"] == [1.5, 2.5]

    def test_serialize_nested_lists(self) -> None:
        """Test serializing nested lists."""
        from decimal import Decimal
        cmd = ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name="test",
            values=[[1.0, 2.0], [3.0, 4.0]],
        )
        d = cmd.to_dict()
        assert d["values"] == [[1.0, 2.0], [3.0, 4.0]]

    def test_serialize_dict_kwargs(self) -> None:
        """Test serializing dict in kwargs."""
        cmd = ChartCommand(
            command_type=ChartCommandType.ADD_INDICATOR,
            kwargs={"config": {"period": 20, "color": "blue"}},
        )
        d = cmd.to_dict()
        assert d["kwargs"]["config"] == {"period": 20, "color": "blue"}

    def test_serialize_object_with_to_dict(self) -> None:
        """Test serializing object with to_dict method."""
        class MockObj:
            def to_dict(self):
                return {"key": "value"}

        cmd = ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name="test",
            args=[MockObj()],
        )
        d = cmd.to_dict()
        assert d["args"] == [{"key": "value"}]

    def test_to_dict_with_all_fields(self) -> None:
        """Test to_dict with all optional fields set."""
        cmd = ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name="full",
            values=[1.0, 2.0],
            color="#FF0000",
            line_width=2,
            style="dashed",
            pane="custom",
            timestamps=[1000.0, 2000.0],
            prices=[100.0, 200.0],
            side="long",
            args=["arg1"],
            kwargs={"key": "value"},
        )
        d = cmd.to_dict()
        assert d["type"] == "plot"
        assert d["seriesName"] == "full"
        assert d["values"] == [1.0, 2.0]
        assert d["color"] == "#FF0000"
        assert d["lineWidth"] == 2
        assert d["style"] == "dashed"
        assert d["pane"] == "custom"
        assert d["timestamps"] == [1000.0, 2000.0]
        assert d["prices"] == [100.0, 200.0]
        assert d["side"] == "long"
        assert d["args"] == ["arg1"]
        assert d["kwargs"] == {"key": "value"}


class TestChartProxyAdvanced:
    """Advanced tests for ChartProxy methods."""

    def test_plot_with_iterable(self) -> None:
        """Test plot with non-list iterable."""
        proxy = ChartProxy()
        proxy.plot(iter([1.0, 2.0, 3.0]), name="iter_series")
        assert proxy.commands[0].values == [1.0, 2.0, 3.0]

    def test_plot_with_single_value(self) -> None:
        """Test plot with single non-iterable value."""
        proxy = ChartProxy()
        proxy.plot(42.0, name="single")
        # Should convert to list
        cmd = proxy.commands[0]
        assert len(cmd.values) > 0

    def test_mark_entries_with_signals_dict(self) -> None:
        """Test mark_entries with signal dictionaries."""
        proxy = ChartProxy()
        signals = [
            {"timestamp": 1000.0, "price": 100.0, "side": "long"},
            {"timestamp": 2000.0, "price": 110.0, "side": "long"},
        ]
        proxy.mark_entries(signals)
        cmd = proxy.commands[0]
        assert cmd.args == [signals]

    def test_mark_exits_with_signals_dict(self) -> None:
        """Test mark_exits with signal dictionaries."""
        proxy = ChartProxy()
        signals = [
            {"timestamp": 1000.0, "price": 105.0, "side": "long"},
        ]
        proxy.mark_exits(signals)
        cmd = proxy.commands[0]
        assert cmd.args == [signals]

    def test_plot_equity_with_existing_pane(self) -> None:
        """Test plot_equity when pane already exists."""
        proxy = ChartProxy()
        proxy.add_pane("equity", height=0.3)
        proxy.plot_equity([10000.0, 10100.0])
        # Should not add duplicate pane
        # Count ADD_PANE commands
        pane_cmds = [c for c in proxy.commands if c.command_type == ChartCommandType.ADD_PANE]
        assert len(pane_cmds) == 1

    def test_add_indicator(self) -> None:
        """Test add_indicator method."""
        proxy = ChartProxy()
        proxy.add_indicator("sma", {"period": 20}, name="SMA_20", pane="main")
        cmd = proxy.commands[0]
        assert cmd.command_type == ChartCommandType.ADD_INDICATOR
        assert cmd.kwargs["type"] == "sma"
        assert cmd.kwargs["params"] == {"period": 20}
        assert cmd.kwargs["name"] == "SMA_20"

    def test_add_indicator_default_name(self) -> None:
        """Test add_indicator with default name."""
        proxy = ChartProxy()
        proxy.add_indicator("ema", {"period": 10})
        cmd = proxy.commands[0]
        assert cmd.kwargs["name"] == "EMA"

    def test_set_title(self) -> None:
        """Test set_title method."""
        proxy = ChartProxy()
        proxy.set_title("My Strategy")
        cmd = proxy.commands[0]
        assert cmd.command_type == ChartCommandType.SET_TITLE
        assert cmd.args == ["My Strategy"]

    def test_add_annotation(self) -> None:
        """Test add_annotation method."""
        proxy = ChartProxy()
        proxy.add_annotation(1704067200.0, 100.0, "Buy Signal", color="green")
        cmd = proxy.commands[0]
        assert cmd.command_type == ChartCommandType.ADD_ANNOTATION
        assert cmd.kwargs["timestamp"] == 1704067200.0
        assert cmd.kwargs["price"] == 100.0
        assert cmd.kwargs["text"] == "Buy Signal"
        assert cmd.kwargs["color"] == "green"

    def test_add_line(self) -> None:
        """Test add_line method."""
        proxy = ChartProxy()
        proxy.add_line(50.0, color="#FF0000", style="solid", label="Support")
        cmd = proxy.commands[0]
        assert cmd.command_type == ChartCommandType.ADD_LINE
        assert cmd.kwargs["y"] == 50.0
        assert cmd.kwargs["color"] == "#FF0000"
        assert cmd.kwargs["style"] == "solid"
        assert cmd.kwargs["label"] == "Support"

    def test_get_commands(self) -> None:
        """Test get_commands returns a copy."""
        proxy = ChartProxy()
        proxy.plot([1.0], name="test")
        cmds1 = proxy.get_commands()
        cmds2 = proxy.get_commands()
        assert cmds1 is not cmds2
        assert len(cmds1) == len(cmds2)


class TestVisualizationExtractorAdvanced:
    """Advanced tests for VisualizationExtractor."""

    def test_extract_syntax_error(self) -> None:
        """Test extract with syntax error in code."""
        code = """
def visualize(chart, data, params
    chart.plot([1, 2, 3])
"""
        func_code, errors = VisualizationExtractor.extract(code)
        assert func_code is None
        assert any("Syntax error" in e for e in errors)

    def test_get_signature(self) -> None:
        """Test get_signature method."""
        code = """
def visualize(chart, data, params):
    pass
"""
        sig = VisualizationExtractor.get_signature(code)
        assert sig is not None
        assert sig["name"] == "visualize"
        assert sig["params"] == ["chart", "data", "params"]
        assert sig["lineno"] == 2

    def test_get_signature_no_function(self) -> None:
        """Test get_signature with no visualize function."""
        code = """
def other_func():
    pass
"""
        sig = VisualizationExtractor.get_signature(code)
        assert sig is None

    def test_get_signature_syntax_error(self) -> None:
        """Test get_signature with syntax error."""
        code = "def visualize(chart"
        sig = VisualizationExtractor.get_signature(code)
        assert sig is None


class TestSafeExecutorAdvanced:
    """Advanced tests for SafeExecutor."""

    def test_validate_code_blocked_patterns(self) -> None:
        """Test validate_code detects blocked patterns."""
        executor = SafeExecutor()

        # Test each blocked pattern
        blocked_codes = [
            "exec('print(1)')",
            "eval('1+1')",
            "compile('x=1', '', 'exec')",
            "open('/etc/passwd')",
            "getattr(obj, 'attr')",
            "setattr(obj, 'attr', val)",
            "delattr(obj, 'attr')",
            "globals()",
            "locals()",
        ]

        for code in blocked_codes:
            is_safe, errors = executor.validate_code(code)
            assert not is_safe, f"Code '{code}' should be blocked"
            assert len(errors) > 0

    def test_validate_code_safe_patterns(self) -> None:
        """Test validate_code allows safe patterns."""
        executor = SafeExecutor()
        safe_code = """
x = 1 + 2
y = len([1, 2, 3])
z = sum([1, 2, 3])
"""
        is_safe, errors = executor.validate_code(safe_code)
        assert is_safe
        assert len(errors) == 0

    def test_safe_import_allowed(self) -> None:
        """Test _safe_import allows whitelisted modules."""
        executor = SafeExecutor()
        # math is allowed
        math_module = executor._safe_import("math")
        assert math_module is not None
        assert hasattr(math_module, "sqrt")

    def test_safe_import_blocked(self) -> None:
        """Test _safe_import blocks non-whitelisted modules."""
        executor = SafeExecutor()
        with pytest.raises(ImportError) as exc:
            executor._safe_import("os")
        assert "not allowed" in str(exc.value)

    def test_create_safe_globals(self) -> None:
        """Test create_safe_globals with chart, data, params."""
        executor = SafeExecutor()
        chart = ChartProxy()
        data = {"close": [100.0, 101.0]}
        params = {"period": 20}

        safe_globals = executor.create_safe_globals(chart, data, params)

        assert safe_globals["chart"] is chart
        assert safe_globals["data"] is data
        assert safe_globals["params"] == params
        assert "__builtins__" in safe_globals

    def test_execute_with_chart(self) -> None:
        """Test execute with chart parameter."""
        executor = SafeExecutor()
        chart = ChartProxy()
        code = "chart.plot([1.0, 2.0], name='test')"

        executor.execute(code, chart=chart)
        assert len(chart.commands) == 1

    def test_execute_name_error(self) -> None:
        """Test execute with undefined name."""
        executor = SafeExecutor()
        code = "result = undefined_variable"

        with pytest.raises(RuntimeError) as exc:
            executor.execute(code)
        assert "Blocked operation" in str(exc.value)

    def test_execute_safe_success(self) -> None:
        """Test execute_safe with successful code."""
        executor = SafeExecutor()
        chart = ChartProxy()
        code = "chart.plot([1.0], name='test')"

        success, errors = executor.execute_safe(code, chart)
        assert success
        assert len(errors) == 0

    def test_execute_safe_failure(self) -> None:
        """Test execute_safe with failing code."""
        executor = SafeExecutor()
        chart = ChartProxy()
        code = "chart.plot(undefined_var)"

        success, errors = executor.execute_safe(code, chart)
        assert not success
        assert len(errors) > 0

    def test_execute_with_allowed_imports(self) -> None:
        """Test execute with allowed datetime import."""
        executor = SafeExecutor()
        # Use datetime constructor instead of today() which needs time module
        code = """
import datetime
d = datetime.date(2024, 1, 15)
result = d.year > 2020
"""
        namespace = executor.execute(code)
        assert namespace["result"] is True

    def test_execute_with_decimal(self) -> None:
        """Test execute with decimal import."""
        executor = SafeExecutor()
        code = """
import decimal
value = decimal.Decimal("10.5")
result = float(value)
"""
        namespace = executor.execute(code)
        assert namespace["result"] == 10.5


class TestVisualizationExecutorAdvanced:
    """Advanced tests for VisualizationExecutor."""

    def test_execute_function_success(self) -> None:
        """Test execute_function with direct function."""
        executor = VisualizationExecutor()

        def my_viz(chart):
            chart.plot([1.0, 2.0], name="direct")
            chart.set_title("Direct Function")

        result = executor.execute_function(my_viz)
        assert result.success is True
        assert len(result.commands) == 2

    def test_execute_function_error(self) -> None:
        """Test execute_function with error in function."""
        executor = VisualizationExecutor()

        def bad_viz(chart):
            raise ValueError("Function error")

        result = executor.execute_function(bad_viz)
        assert result.success is False
        assert "Function error" in result.errors[0]

    def test_has_visualize_function_true(self) -> None:
        """Test has_visualize_function returns True."""
        executor = VisualizationExecutor()
        code = """
def visualize(chart, data, params):
    chart.plot([1, 2, 3])
"""
        assert executor.has_visualize_function(code) is True

    def test_has_visualize_function_false(self) -> None:
        """Test has_visualize_function returns False."""
        executor = VisualizationExecutor()
        code = """
def strategy(data):
    pass
"""
        assert executor.has_visualize_function(code) is False

    def test_execute_complex_visualization(self) -> None:
        """Test execute with complex visualization."""
        executor = VisualizationExecutor()
        code = '''
def visualize(chart, data, params):
    chart.set_title("Complex Strategy")
    chart.add_pane("indicators", height=0.3)
    chart.plot([50.0, 55.0, 60.0], name="RSI", pane="indicators", color="#FF0000")
    chart.add_indicator("sma", {"period": 20})
    chart.add_line(30.0, label="Oversold")
    chart.add_line(70.0, label="Overbought")
    chart.add_annotation(1000.0, 50.0, "Signal")
    chart.mark_entries([1000.0], [100.0], "long")
    chart.mark_exits([2000.0], [110.0], "long")
'''
        result = executor.execute(code)
        assert result.success is True
        assert len(result.commands) >= 8


class TestChartCommandTypes:
    """Tests for ChartCommandType enum values."""

    def test_all_command_types(self) -> None:
        """Test all command type values."""
        assert ChartCommandType.PLOT.value == "plot"
        assert ChartCommandType.MARK_ENTRY.value == "markEntry"
        assert ChartCommandType.MARK_EXIT.value == "markExit"
        assert ChartCommandType.MARK_ENTRIES.value == "markEntries"
        assert ChartCommandType.MARK_EXITS.value == "markExits"
        assert ChartCommandType.ADD_PANE.value == "addPane"
        assert ChartCommandType.PLOT_EQUITY.value == "plotEquity"
        assert ChartCommandType.ADD_INDICATOR.value == "addIndicator"
        assert ChartCommandType.SET_TITLE.value == "setTitle"
        assert ChartCommandType.SET_THEME.value == "setTheme"
        assert ChartCommandType.ADD_ANNOTATION.value == "addAnnotation"
        assert ChartCommandType.ADD_LINE.value == "addLine"


class TestVisualizationTemplate:
    """Tests for visualization template."""

    def test_get_visualize_template(self) -> None:
        """Test get_visualize_template function."""
        from quantlab.runtime.visualization import get_visualize_template

        template = get_visualize_template()
        assert "def visualize(chart):" in template
        assert "chart.add_indicator" in template
        assert "chart.mark_entries" in template
