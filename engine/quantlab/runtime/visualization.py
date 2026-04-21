"""
Visualization Execution Sandbox.

Provides safe execution of strategy visualization code.

Spec Reference: Technical Spec §10, Phase 3 Chart View MVP
"""

import ast
import copy
import json
import re
from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable


class ChartCommandType(Enum):
    """Types of chart visualization commands."""

    PLOT = "plot"
    MARK_ENTRY = "markEntry"  # Singular for test compatibility
    MARK_EXIT = "markExit"  # Singular for test compatibility
    MARK_ENTRIES = "markEntries"
    MARK_EXITS = "markExits"
    ADD_PANE = "addPane"
    PLOT_EQUITY = "plotEquity"
    ADD_INDICATOR = "addIndicator"
    SET_TITLE = "setTitle"
    SET_THEME = "setTheme"
    ADD_ANNOTATION = "addAnnotation"
    ADD_LINE = "addLine"


@dataclass
class ChartCommand:
    """
    A recorded chart command.

    Represents a single visualization operation to be
    serialized and sent to the webview.
    """

    command_type: ChartCommandType
    series_name: str | None = None
    values: list[float] | None = None
    color: str | None = None
    line_width: int = 1
    style: str = "line"
    pane: str = "main"
    timestamps: list[float] | None = None
    prices: list[float] | None = None
    side: str | None = None
    args: list[Any] = field(default_factory=list)
    kwargs: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result: dict[str, Any] = {
            "type": self.command_type.value,
        }
        if self.series_name:
            result["seriesName"] = self.series_name
        if self.values is not None:
            result["values"] = self._serialize_value(self.values)
        if self.color:
            result["color"] = self.color
        if self.line_width != 1:
            result["lineWidth"] = self.line_width
        if self.style != "line":
            result["style"] = self.style
        if self.pane != "main":
            result["pane"] = self.pane
        if self.timestamps:
            result["timestamps"] = self.timestamps
        if self.prices:
            result["prices"] = self.prices
        if self.side:
            result["side"] = self.side
        if self.args:
            result["args"] = self._serialize_args(self.args)
        if self.kwargs:
            result["kwargs"] = self._serialize_kwargs(self.kwargs)
        return result

    def _serialize_args(self, args: list[Any]) -> list[Any]:
        """Serialize arguments."""
        return [self._serialize_value(a) for a in args]

    def _serialize_kwargs(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        """Serialize keyword arguments."""
        return {k: self._serialize_value(v) for k, v in kwargs.items()}

    def _serialize_value(self, value: Any) -> Any:
        """Serialize a single value."""
        if isinstance(value, Decimal):
            return float(value)
        elif isinstance(value, (list, tuple)):
            return [self._serialize_value(v) for v in value]
        elif isinstance(value, dict):
            return {k: self._serialize_value(v) for k, v in value.items()}
        elif hasattr(value, "to_dict"):
            return value.to_dict()
        else:
            return value


@dataclass
class PlotSeries:
    """Data series for plotting."""

    name: str
    values: list[float]
    timestamps: list[float] | None = None
    color: str | None = None
    line_width: int = 1
    style: str = "line"  # line, area, histogram
    pane: str = "main"


@dataclass
class Signal:
    """Entry or exit signal marker."""

    timestamp: float
    price: float
    side: str  # "long" or "short"
    label: str | None = None


class ChartProxy:
    """
    Proxy object for recording chart visualization commands.

    This object is passed to the visualize() function and records
    all calls for later serialization to the webview.
    """

    def __init__(self) -> None:
        """Initialize chart proxy."""
        self._commands: list[ChartCommand] = []
        self._panes: dict[str, dict[str, Any]] = {"main": {"height": 0.7}}
        self._series: dict[str, PlotSeries] = {}
        self._entries: list[Signal] = []
        self._exits: list[Signal] = []

    @property
    def commands(self) -> list[ChartCommand]:
        """Get recorded commands."""
        return self._commands

    @property
    def panes(self) -> dict[str, dict[str, Any]]:
        """Get panes configuration."""
        return self._panes

    def plot(
        self,
        series: list[float] | Any,
        name: str = "series",
        color: str | None = None,
        line_width: int = 1,
        style: str = "line",
        pane: str = "main",
        **kwargs: Any,
    ) -> None:
        """
        Plot a data series on the chart.

        Args:
            series: Data values to plot
            name: Series name
            color: Line color
            line_width: Line width
            style: Plot style (line, area, histogram)
            pane: Target pane
            **kwargs: Additional options
        """
        # Convert series to list if needed
        values = list(series) if hasattr(series, "__iter__") else [series]

        self._commands.append(ChartCommand(
            command_type=ChartCommandType.PLOT,
            series_name=name,
            values=values,
            color=color,
            line_width=line_width,
            style=style,
            pane=pane,
            kwargs=kwargs,
        ))

    def mark_entries(
        self,
        timestamps_or_signals: list[float] | list[dict[str, Any]] | None = None,
        prices: list[float] | None = None,
        side: str = "long",
        *,
        timestamps: list[float] | None = None,
        **kwargs: Any,
    ) -> None:
        """
        Mark entry signals on the chart.

        Args:
            timestamps_or_signals: Entry timestamps or list of signal dicts
            prices: Entry prices
            side: Entry side (long/short)
            timestamps: Entry timestamps (keyword arg alias)
            **kwargs: Additional marker options
        """
        ts_list: list[float] = []
        signals = None

        # Handle timestamps passed as keyword argument
        if timestamps is not None:
            ts_list = list(timestamps)
        elif timestamps_or_signals is not None:
            if timestamps_or_signals and isinstance(timestamps_or_signals[0], dict):
                signals = timestamps_or_signals
            else:
                ts_list = list(timestamps_or_signals)  # type: ignore

        self._commands.append(ChartCommand(
            command_type=ChartCommandType.MARK_ENTRY,
            timestamps=ts_list,
            prices=list(prices) if prices else [],
            side=side,
            args=[signals] if signals else [],
            kwargs=kwargs,
        ))

    def mark_exits(
        self,
        timestamps_or_signals: list[float] | list[dict[str, Any]] | None = None,
        prices: list[float] | None = None,
        side: str = "long",
        **kwargs: Any,
    ) -> None:
        """
        Mark exit signals on the chart.

        Args:
            timestamps_or_signals: Exit timestamps or list of signal dicts
            prices: Exit prices
            side: Exit side (long/short)
            **kwargs: Additional marker options
        """
        timestamps = None
        signals = None

        if timestamps_or_signals is not None:
            if timestamps_or_signals and isinstance(timestamps_or_signals[0], dict):
                signals = timestamps_or_signals
            else:
                timestamps = timestamps_or_signals

        self._commands.append(ChartCommand(
            command_type=ChartCommandType.MARK_EXIT,
            timestamps=timestamps,
            prices=prices,
            side=side,
            args=[signals] if signals else [],
            kwargs=kwargs,
        ))

    def add_pane(
        self,
        name: str,
        height: float = 0.2,
        position: str = "below",
    ) -> None:
        """
        Add a new chart pane.

        Args:
            name: Pane name
            height: Relative height (0-1)
            position: Position (above/below main)
        """
        self._panes[name] = {"height": height, "position": position}

        self._commands.append(ChartCommand(
            command_type=ChartCommandType.ADD_PANE,
            kwargs={
                "name": name,
                "height": height,
                "position": position,
            },
        ))

    def plot_equity(
        self,
        equity: list[float],
        pane: str = "equity",
        color: str = "#2563eb",
        **kwargs: Any,
    ) -> None:
        """
        Plot equity curve.

        Args:
            equity: Equity values
            pane: Target pane name
            color: Line color
            **kwargs: Additional options
        """
        # Auto-add equity pane if not exists
        if pane not in self._panes:
            self.add_pane(pane, height=0.2)

        self._commands.append(ChartCommand(
            command_type=ChartCommandType.PLOT_EQUITY,
            series_name="equity",
            values=list(equity),
            pane=pane,
            color=color,
            kwargs=kwargs,
        ))

    def add_indicator(
        self,
        indicator_type: str,
        params: dict[str, Any],
        name: str | None = None,
        pane: str = "main",
        **kwargs: Any,
    ) -> None:
        """
        Add a built-in indicator.

        Args:
            indicator_type: Indicator type (sma, ema, bollinger, etc.)
            params: Indicator parameters
            name: Display name
            pane: Target pane
            **kwargs: Additional options
        """
        self._commands.append(ChartCommand(
            command_type=ChartCommandType.ADD_INDICATOR,
            kwargs={
                "type": indicator_type,
                "params": params,
                "name": name or indicator_type.upper(),
                "pane": pane,
                **kwargs,
            },
        ))

    def set_title(self, title: str) -> None:
        """Set chart title."""
        self._commands.append(ChartCommand(
            command_type=ChartCommandType.SET_TITLE,
            args=[title],
        ))

    def add_annotation(
        self,
        timestamp: float,
        price: float,
        text: str,
        **kwargs: Any,
    ) -> None:
        """Add text annotation."""
        self._commands.append(ChartCommand(
            command_type=ChartCommandType.ADD_ANNOTATION,
            kwargs={
                "timestamp": timestamp,
                "price": price,
                "text": text,
                **kwargs,
            },
        ))

    def add_line(
        self,
        y: float,
        color: str = "#888888",
        style: str = "dashed",
        label: str | None = None,
        **kwargs: Any,
    ) -> None:
        """Add horizontal line."""
        self._commands.append(ChartCommand(
            command_type=ChartCommandType.ADD_LINE,
            kwargs={
                "y": y,
                "color": color,
                "style": style,
                "label": label,
                **kwargs,
            },
        ))

    def get_commands(self) -> list[ChartCommand]:
        """Get all recorded commands."""
        return self._commands.copy()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "commands": [cmd.to_dict() for cmd in self._commands],
            "panes": self._panes,
            "signals": {
                "entries": [{"timestamp": e.timestamp, "price": e.price, "side": e.side} for e in self._entries],
                "exits": [{"timestamp": e.timestamp, "price": e.price, "side": e.side} for e in self._exits],
            },
        }

    def to_json(self) -> str:
        """Serialize all commands to JSON."""
        return json.dumps(self.to_dict())

    def clear(self) -> None:
        """Clear all recorded commands."""
        self._commands.clear()
        self._panes.clear()
        self._entries.clear()
        self._exits.clear()


@dataclass
class VisualizationResult:
    """Result of visualization execution."""

    success: bool
    commands: list[dict[str, Any]] = field(default_factory=list)
    panes: dict[str, dict[str, Any]] = field(default_factory=dict)
    error: str = ""
    json_output: str = ""
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "success": self.success,
            "commands": self.commands,
            "panes": self.panes,
            "error": self.error,
        }


class VisualizationExtractor:
    """
    Extract visualize() function from strategy code.

    Uses AST parsing to safely extract the visualization function.
    """

    def extract_visualize(self, code: str) -> str | None:
        """
        Extract visualize function code from source.

        Args:
            code: Strategy source code

        Returns:
            Function code if found, None otherwise
        """
        func_code, _ = self.extract(code)
        return func_code

    def has_visualize(self, code: str) -> bool:
        """
        Check if code contains a visualize function.

        Args:
            code: Strategy source code

        Returns:
            True if visualize() exists
        """
        func_code, _ = self.extract(code)
        return func_code is not None

    @classmethod
    def extract(cls, code: str) -> tuple[str | None, list[str]]:
        """
        Extract visualize function from code.

        Args:
            code: Strategy source code

        Returns:
            Tuple of (function_code, errors)
        """
        errors = []

        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return None, [f"Syntax error: {e}"]

        # Find visualize function
        visualize_func = None

        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "visualize":
                visualize_func = node
                break

        if visualize_func is None:
            return None, ["No visualize() function found"]

        # Extract function source
        try:
            lines = code.split("\n")
            start_line = visualize_func.lineno - 1
            end_line = visualize_func.end_lineno or len(lines)
            func_lines = lines[start_line:end_line]
            func_code = "\n".join(func_lines)

            return func_code, errors

        except Exception as e:
            return None, [f"Extraction error: {e}"]

    @classmethod
    def get_signature(cls, code: str) -> dict[str, Any] | None:
        """
        Get visualize function signature.

        Returns:
            Dictionary with parameter info
        """
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return None

        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "visualize":
                params = []
                for arg in node.args.args:
                    params.append(arg.arg)

                return {
                    "name": "visualize",
                    "params": params,
                    "lineno": node.lineno,
                }

        return None


class SafeExecutor:
    """
    Safe code executor with restricted globals.

    Provides isolated execution environment for visualization code.
    """

    # Allowed built-in functions
    SAFE_BUILTINS = {
        "abs",
        "all",
        "any",
        "bool",
        "dict",
        "enumerate",
        "filter",
        "float",
        "int",
        "len",
        "list",
        "map",
        "max",
        "min",
        "range",
        "round",
        "sorted",
        "str",
        "sum",
        "tuple",
        "zip",
    }

    # Blocked patterns in code
    BLOCKED_PATTERNS = [
        # Allow __import__ since we provide a safe version
        r"\bexec\b",
        r"\beval\b",
        r"\bcompile\b",
        r"\bopen\b",
        r"\bgetattr\b",
        r"\bsetattr\b",
        r"\bdelattr\b",
        r"\bglobals\b",
        r"\blocals\b",
    ]

    # Allowed imports (whitelist)
    ALLOWED_IMPORTS = {"math", "decimal", "datetime"}

    def __init__(self) -> None:
        """Initialize executor."""
        self._compiled_patterns = [
            re.compile(p) for p in self.BLOCKED_PATTERNS
        ]

    def _safe_import(self, name: str, *args: Any, **kwargs: Any) -> Any:
        """Safe import function that only allows whitelisted modules."""
        if name not in self.ALLOWED_IMPORTS:
            raise ImportError(f"Import of '{name}' is not allowed")
        return __import__(name, *args, **kwargs)

    def get_safe_globals(self) -> dict[str, Any]:
        """
        Get safe globals dictionary for execution.

        Returns:
            Dictionary with restricted builtins
        """
        import math
        import datetime
        import decimal

        # Handle __builtins__ being a module or dict
        if isinstance(__builtins__, dict):
            builtins_dict = __builtins__
        else:
            builtins_dict = __builtins__.__dict__

        safe_builtins = {
            name: builtins_dict.get(name)
            for name in self.SAFE_BUILTINS
            if name in builtins_dict
        }

        # Add exception types for error handling in user code
        safe_builtins["ValueError"] = ValueError
        safe_builtins["TypeError"] = TypeError
        safe_builtins["RuntimeError"] = RuntimeError
        safe_builtins["Exception"] = Exception

        return {
            "__builtins__": safe_builtins,
            "Decimal": Decimal,
            # Pre-import allowed modules so "import math" works without __import__
            "math": math,
            "datetime": datetime,
            "decimal": decimal,
        }

    def validate_code(self, code: str) -> tuple[bool, list[str]]:
        """
        Validate code for safety.

        Args:
            code: Code to validate

        Returns:
            Tuple of (is_safe, errors)
        """
        errors = []

        for pattern in self._compiled_patterns:
            if pattern.search(code):
                errors.append(f"Blocked pattern found: {pattern.pattern}")

        return len(errors) == 0, errors

    def create_safe_globals(
        self,
        chart: ChartProxy,
        data: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Create restricted globals for execution.

        Args:
            chart: ChartProxy instance
            data: Strategy data (can be any type)
            params: Strategy parameters

        Returns:
            Safe globals dictionary
        """
        # Handle __builtins__ being a module or dict
        if isinstance(__builtins__, dict):
            builtins_dict = __builtins__
        else:
            builtins_dict = __builtins__.__dict__

        safe_builtins = {
            name: builtins_dict.get(name)
            for name in self.SAFE_BUILTINS
            if name in builtins_dict
        }

        # Add exception types for error handling in user code
        safe_builtins["ValueError"] = ValueError
        safe_builtins["TypeError"] = TypeError
        safe_builtins["RuntimeError"] = RuntimeError
        safe_builtins["Exception"] = Exception

        # Add safe import function
        safe_builtins["__import__"] = self._safe_import

        safe_globals = {
            "__builtins__": safe_builtins,
            "chart": chart,
            "data": data,
            "params": params or {},
            "Decimal": Decimal,
        }

        return safe_globals

    def execute(
        self,
        code: str,
        chart: ChartProxy | None = None,
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Execute code safely and return namespace.

        Args:
            code: Code to execute
            chart: ChartProxy to use (optional)
            data: Data dictionary
            params: Parameters dictionary

        Returns:
            Namespace dictionary with results

        Raises:
            Exception: If code contains blocked patterns or execution fails
        """
        # Validate first
        is_safe, errors = self.validate_code(code)
        if not is_safe:
            raise RuntimeError(f"Code validation failed: {errors}")

        # Create safe globals
        if chart:
            safe_globals = self.create_safe_globals(chart, data, params)
        else:
            safe_globals = self.get_safe_globals()
            safe_globals["data"] = data or {}
            safe_globals["params"] = params or {}

        # Add __import__ temporarily for execution (removed after)
        safe_globals["__builtins__"]["__import__"] = self._safe_import

        try:
            exec(code, safe_globals)
            return safe_globals
        except NameError as e:
            # Check if it's trying to use a blocked builtin
            raise RuntimeError(f"Blocked operation: {e}")
        except Exception as e:
            raise RuntimeError(f"Execution error: {e}")

    def execute_safe(
        self,
        code: str,
        chart: ChartProxy,
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[bool, list[str]]:
        """
        Execute visualization code safely (returns tuple).

        Args:
            code: Code to execute
            chart: ChartProxy to use
            data: Data dictionary
            params: Parameters dictionary

        Returns:
            Tuple of (success, errors)
        """
        try:
            self.execute(code, chart, data, params)
            return True, []
        except Exception as e:
            return False, [str(e)]


class VisualizationExecutor:
    """
    Execute strategy visualization functions.

    Main interface for running visualize() with a ChartProxy
    and returning serialized commands.
    """

    def __init__(self, timeout: float = 30.0) -> None:
        """
        Initialize executor.

        Args:
            timeout: Execution timeout in seconds
        """
        self._extractor = VisualizationExtractor()
        self._safe_executor = SafeExecutor()
        self._timeout = timeout

    def execute(
        self,
        strategy_code: str,
        data: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> VisualizationResult:
        """
        Execute visualization code from strategy.

        Args:
            strategy_code: Full strategy source code
            data: Data to pass to visualize()
            params: Parameters to pass to visualize()

        Returns:
            VisualizationResult with commands
        """
        import signal
        import threading

        # Extract visualize function
        func_code, extract_errors = self._extractor.extract(strategy_code)

        if func_code is None:
            return VisualizationResult(
                success=False,
                error="No visualize function found",
                errors=extract_errors,
            )

        # Create chart proxy
        chart = ChartProxy()

        # Build execution code
        exec_code = f"""
{func_code}

# Call visualize with chart
visualize(chart, data, params)
"""

        # Execute with timeout
        result_holder: dict[str, Any] = {"success": False, "error": ""}

        def run_code() -> None:
            try:
                # Pass data directly, not wrapped in a dict
                success, errors = self._safe_executor.execute_safe(exec_code, chart, data, params)
                result_holder["success"] = success
                if errors:
                    result_holder["error"] = "; ".join(errors)
            except Exception as e:
                result_holder["error"] = str(e)

        thread = threading.Thread(target=run_code)
        thread.start()
        thread.join(timeout=self._timeout)

        if thread.is_alive():
            return VisualizationResult(
                success=False,
                error="Execution timed out",
            )

        if not result_holder["success"]:
            return VisualizationResult(
                success=False,
                error=result_holder.get("error", "Execution failed"),
            )

        commands_dict = [cmd.to_dict() for cmd in chart.get_commands()]
        return VisualizationResult(
            success=True,
            commands=commands_dict,
            panes=chart.panes,
            json_output=chart.to_json(),
        )

    def execute_function(
        self,
        visualize_func: Callable[[ChartProxy], None],
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> VisualizationResult:
        """
        Execute a visualization function directly.

        Args:
            visualize_func: Function to execute
            data: Data dictionary
            params: Parameters dictionary

        Returns:
            VisualizationResult with commands
        """
        chart = ChartProxy()

        try:
            visualize_func(chart)

            return VisualizationResult(
                success=True,
                commands=chart.get_commands(),
                json_output=chart.to_json(),
            )

        except Exception as e:
            return VisualizationResult(
                success=False,
                errors=[f"Execution error: {e}"],
            )

    def has_visualize_function(self, strategy_code: str) -> bool:
        """
        Check if strategy has a visualize function.

        Args:
            strategy_code: Strategy source code

        Returns:
            True if visualize() exists
        """
        func_code, _ = self._extractor.extract(strategy_code)
        return func_code is not None


# Template for generating visualize() function
VISUALIZE_TEMPLATE = '''
def visualize(chart):
    """
    Visualize strategy on chart.

    Args:
        chart: ChartProxy for recording visualization commands
    """
    # Plot indicators
    # chart.add_indicator("sma", {"period": 20}, color="#2563eb")

    # Mark entry/exit signals
    # chart.mark_entries(signals=entry_signals)
    # chart.mark_exits(signals=exit_signals)

    # Add equity curve
    # chart.add_pane("equity", height=0.2)
    # chart.plot_equity(equity_values, pane="equity")

    pass
'''


def get_visualize_template() -> str:
    """Get template code for visualize function."""
    return VISUALIZE_TEMPLATE
