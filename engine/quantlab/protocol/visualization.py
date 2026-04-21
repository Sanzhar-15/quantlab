"""
Visualization Protocol Messages.

Defines message types for Chart View communication between extension and engine.

Spec Reference: Technical Spec §15, Phase 3 Chart View MVP
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Sequence
import uuid


class VisualizationMessageType(Enum):
    """Visualization-specific message types."""

    # Extension → Engine (Requests)
    VIZ_INIT = "viz.init"
    VIZ_LOAD_DATA = "viz.loadData"
    VIZ_EXECUTE = "viz.execute"
    VIZ_GET_PARAMS = "viz.getParams"
    VIZ_UPDATE_PARAM = "viz.updateParam"
    VIZ_APPLY_PARAMS = "viz.applyParams"
    VIZ_RESET_PARAMS = "viz.resetParams"
    VIZ_ANALYZE = "viz.analyze"
    VIZ_SCREENSHOT = "viz.screenshot"

    # Engine → Extension (Responses/Updates)
    VIZ_DATA = "viz.data"
    VIZ_COMMANDS = "viz.commands"
    VIZ_PARAMS = "viz.params"
    VIZ_COMPLEXITY = "viz.complexity"
    VIZ_ERROR = "viz.error"
    VIZ_PROGRESS = "viz.progress"


class ChartDataFormat(Enum):
    """Data format for chart data transfer."""

    JSON = "json"
    BINARY = "binary"  # Raw struct
    ARROW = "arrow"  # Arrow IPC


@dataclass
class OHLCVData:
    """OHLCV data for chart."""

    timestamp: float
    open: float
    high: float
    low: float
    close: float
    volume: int

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "timestamp": self.timestamp,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }


@dataclass
class SignalMarker:
    """Entry/exit signal marker."""

    timestamp: float
    price: float
    side: str  # "long" | "short"
    type: str  # "entry" | "exit"
    label: str | None = None
    color: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "timestamp": self.timestamp,
            "price": self.price,
            "side": self.side,
            "type": self.type,
            "label": self.label,
            "color": self.color,
        }


@dataclass
class PlotCommand:
    """Command to plot a data series."""

    series_name: str
    values: list[float]
    timestamps: list[float] | None = None
    color: str | None = None
    line_width: int = 1
    style: str = "line"
    pane: str = "main"
    y_axis: str = "right"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "plot",
            "seriesName": self.series_name,
            "values": self.values,
            "timestamps": self.timestamps,
            "color": self.color,
            "lineWidth": self.line_width,
            "style": self.style,
            "pane": self.pane,
            "yAxis": self.y_axis,
        }


@dataclass
class IndicatorCommand:
    """Command to add a built-in indicator."""

    indicator_type: str  # "sma", "ema", "bollinger", "rsi", etc.
    params: dict[str, Any]
    name: str | None = None
    pane: str = "main"
    color: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "indicator",
            "indicatorType": self.indicator_type,
            "params": self.params,
            "name": self.name,
            "pane": self.pane,
            "color": self.color,
        }


@dataclass
class PaneCommand:
    """Command to add a chart pane."""

    name: str
    height: float = 0.2
    position: str = "below"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "addPane",
            "name": self.name,
            "height": self.height,
            "position": self.position,
        }


@dataclass
class VisualizationRequest:
    """
    Request message for visualization operations.

    Sent from extension to engine.
    """

    message_type: VisualizationMessageType
    payload: dict[str, Any]
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "jsonrpc": "2.0",
            "method": self.message_type.value,
            "params": self.payload,
            "id": self.request_id,
        }

    @classmethod
    def init_chart(
        cls,
        theme: str = "light",
        locale: str = "en-US",
    ) -> "VisualizationRequest":
        """Create init request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_INIT,
            payload={
                "theme": theme,
                "locale": locale,
            },
        )

    @classmethod
    def load_data(
        cls,
        symbol: str,
        timeframe: str,
        start: str | None = None,
        end: str | None = None,
        format: ChartDataFormat = ChartDataFormat.JSON,
    ) -> "VisualizationRequest":
        """Create data load request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_LOAD_DATA,
            payload={
                "symbol": symbol,
                "timeframe": timeframe,
                "start": start,
                "end": end,
                "format": format.value,
            },
        )

    @classmethod
    def execute_visualization(
        cls,
        strategy_path: str,
        params: dict[str, Any] | None = None,
    ) -> "VisualizationRequest":
        """Create visualization execute request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_EXECUTE,
            payload={
                "strategyPath": strategy_path,
                "params": params or {},
            },
        )

    @classmethod
    def get_params(
        cls,
        strategy_path: str,
    ) -> "VisualizationRequest":
        """Create get parameters request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_GET_PARAMS,
            payload={
                "strategyPath": strategy_path,
            },
        )

    @classmethod
    def update_param(
        cls,
        param_name: str,
        value: Any,
        strategy_path: str | None = None,
    ) -> "VisualizationRequest":
        """Create parameter update request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_UPDATE_PARAM,
            payload={
                "paramName": param_name,
                "value": value,
                "strategyPath": strategy_path,
            },
        )

    @classmethod
    def apply_params(
        cls,
        strategy_path: str,
        params: dict[str, Any],
    ) -> "VisualizationRequest":
        """Create apply params to source request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_APPLY_PARAMS,
            payload={
                "strategyPath": strategy_path,
                "params": params,
            },
        )

    @classmethod
    def analyze_complexity(
        cls,
        strategy_path: str,
    ) -> "VisualizationRequest":
        """Create complexity analysis request."""
        return cls(
            message_type=VisualizationMessageType.VIZ_ANALYZE,
            payload={
                "strategyPath": strategy_path,
            },
        )


@dataclass
class VisualizationResponse:
    """
    Response message for visualization operations.

    Sent from engine to extension.
    """

    request_id: str
    success: bool
    data: dict[str, Any] | None = None
    error: str | None = None
    error_code: int | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        response: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self.request_id,
        }
        if self.success:
            response["result"] = self.data
        else:
            from quantlab.protocol.message import RpcErrorCode as ErrorCode
            response["error"] = {
                "code": self.error_code or ErrorCode.INTERNAL_ERROR,
                "message": self.error or "Unknown error",
            }
        return response

    @classmethod
    def success(
        cls,
        request_id: str,
        data: dict[str, Any],
    ) -> "VisualizationResponse":
        """Create success response."""
        return cls(
            request_id=request_id,
            success=True,
            data=data,
        )

    @classmethod
    def error(
        cls,
        request_id: str,
        message: str,
        code: int | None = None,
    ) -> "VisualizationResponse":
        """Create error response."""
        return cls(
            request_id=request_id,
            success=False,
            error=message,
            error_code=code,
        )


@dataclass
class DataLoadResponse:
    """Response containing loaded chart data."""

    symbol: str
    timeframe: str
    bars: list[dict[str, Any]]
    start_timestamp: float
    end_timestamp: float
    bar_count: int
    format: ChartDataFormat
    binary_data: bytes | None = None  # For binary format

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "startTimestamp": self.start_timestamp,
            "endTimestamp": self.end_timestamp,
            "barCount": self.bar_count,
            "format": self.format.value,
        }
        if self.format == ChartDataFormat.JSON:
            result["bars"] = self.bars
        elif self.binary_data:
            result["binarySize"] = len(self.binary_data)
            # Binary data sent separately via transferable
        return result


@dataclass
class VisualizationCommandsResponse:
    """Response containing visualization commands."""

    commands: list[dict[str, Any]]
    panes: dict[str, dict[str, Any]]
    signals: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "commands": self.commands,
            "panes": self.panes,
            "signals": self.signals,
        }


@dataclass
class ParametersResponse:
    """Response containing parameter definitions."""

    groups: list[dict[str, Any]]
    parameter_count: int
    has_visualize: bool

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "groups": self.groups,
            "parameterCount": self.parameter_count,
            "hasVisualize": self.has_visualize,
        }


@dataclass
class ComplexityResponse:
    """Response containing complexity analysis."""

    level: str  # "safe", "partial", "view_only"
    score: int
    confidence: float
    factors: list[dict[str, Any]]
    color: str
    indicator_dots: int

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "level": self.level,
            "score": self.score,
            "confidence": self.confidence,
            "factors": self.factors,
            "color": self.color,
            "indicatorDots": self.indicator_dots,
        }


class VisualizationErrorCode:
    """Error codes for visualization operations."""

    STRATEGY_NOT_FOUND = -32100
    PARSE_ERROR = -32101
    EXECUTION_ERROR = -32102
    DATA_LOAD_ERROR = -32103
    PARAM_INVALID = -32104
    NO_VISUALIZE_FUNCTION = -32105
    COMPLEXITY_TOO_HIGH = -32106


def create_data_response(
    request_id: str,
    symbol: str,
    timeframe: str,
    bars: Sequence[dict[str, Any]],
) -> VisualizationResponse:
    """
    Create a data load response.

    Args:
        request_id: Request ID
        symbol: Symbol
        timeframe: Timeframe
        bars: OHLCV bars

    Returns:
        VisualizationResponse
    """
    bar_list = list(bars)
    data = DataLoadResponse(
        symbol=symbol,
        timeframe=timeframe,
        bars=bar_list,
        start_timestamp=bar_list[0]["timestamp"] if bar_list else 0,
        end_timestamp=bar_list[-1]["timestamp"] if bar_list else 0,
        bar_count=len(bar_list),
        format=ChartDataFormat.JSON,
    )

    return VisualizationResponse.success(request_id, data.to_dict())


def create_commands_response(
    request_id: str,
    commands: list[dict[str, Any]],
    panes: dict[str, dict[str, Any]],
    signals: list[dict[str, Any]] | None = None,
) -> VisualizationResponse:
    """
    Create a visualization commands response.

    Args:
        request_id: Request ID
        commands: Chart commands
        panes: Pane definitions
        signals: Signal markers

    Returns:
        VisualizationResponse
    """
    data = VisualizationCommandsResponse(
        commands=commands,
        panes=panes,
        signals=signals or [],
    )

    return VisualizationResponse.success(request_id, data.to_dict())


def create_params_response(
    request_id: str,
    groups: list[dict[str, Any]],
    parameter_count: int,
    has_visualize: bool,
) -> VisualizationResponse:
    """
    Create a parameters response.

    Args:
        request_id: Request ID
        groups: Parameter groups
        parameter_count: Total parameter count
        has_visualize: Whether strategy has visualize function

    Returns:
        VisualizationResponse
    """
    data = ParametersResponse(
        groups=groups,
        parameter_count=parameter_count,
        has_visualize=has_visualize,
    )

    return VisualizationResponse.success(request_id, data.to_dict())


def create_complexity_response(
    request_id: str,
    level: str,
    score: int,
    confidence: float,
    factors: list[dict[str, Any]],
    color: str,
    indicator_dots: int,
) -> VisualizationResponse:
    """
    Create a complexity analysis response.

    Args:
        request_id: Request ID
        level: Complexity level
        score: Complexity score
        confidence: Confidence level
        factors: Contributing factors
        color: Indicator color
        indicator_dots: Number of indicator dots

    Returns:
        VisualizationResponse
    """
    data = ComplexityResponse(
        level=level,
        score=score,
        confidence=confidence,
        factors=factors,
        color=color,
        indicator_dots=indicator_dots,
    )

    return VisualizationResponse.success(request_id, data.to_dict())
