"""
IPC protocol module.

Provides:
- JSON-RPC 2.0 message handling
- Sequence number tracking
- Message ordering guarantees
- Critical message acknowledgment with retry
- Protocol version negotiation
- Deprecation warning system

Spec Reference: Technical Spec §15, Decision A5
"""

from .jsonrpc import JsonRpcClient
from .jsonrpc import JsonRpcProtocol
from .jsonrpc import JsonRpcServer
from .message import ErrorCode
from .message import Message
from .message import MESSAGE_RELIABILITY
from .message import MESSAGE_STREAM
from .message import MessageType
from .message import Notification
from .message import PROTOCOL_VERSION
from .message import ReliabilityClass
from .message import Request
from .message import Response
from .message import StreamType
from .reliability import AckTracker
from .reliability import MessageBuffer
from .reliability import ReliabilityManager
from .reliability import StateSnapshot
from .transport import ConnectionClosed
from .transport import Transport
from .transport import TransportError
from .transport import UnixSocketServer
from .transport import UnixSocketTransport
from .transport import create_transport
from .transport import get_socket_path
from .visualization import ChartDataFormat
from .visualization import ComplexityResponse
from .visualization import DataLoadResponse
from .visualization import IndicatorCommand
from .visualization import OHLCVData
from .visualization import PaneCommand
from .visualization import ParametersResponse
from .visualization import PlotCommand
from .visualization import SignalMarker
from .visualization import VisualizationCommandsResponse
from .visualization import VisualizationErrorCode
from .visualization import VisualizationMessageType
from .visualization import VisualizationRequest
from .visualization import VisualizationResponse
from .visualization import create_commands_response
from .visualization import create_complexity_response
from .visualization import create_data_response
from .visualization import create_params_response

__all__ = [
    # Message types
    "Message",
    "Request",
    "Response",
    "Notification",
    "MessageType",
    "ReliabilityClass",
    "StreamType",
    "ErrorCode",
    # Protocol constants
    "PROTOCOL_VERSION",
    "MESSAGE_RELIABILITY",
    "MESSAGE_STREAM",
    # Protocol handlers
    "JsonRpcProtocol",
    "JsonRpcClient",
    "JsonRpcServer",
    # Reliability
    "ReliabilityManager",
    "AckTracker",
    "MessageBuffer",
    "StateSnapshot",
    # Transport
    "Transport",
    "UnixSocketTransport",
    "UnixSocketServer",
    "create_transport",
    "get_socket_path",
    # Exceptions
    "TransportError",
    "ConnectionClosed",
    # Phase 3: Visualization Protocol
    "VisualizationMessageType",
    "ChartDataFormat",
    "OHLCVData",
    "SignalMarker",
    "PlotCommand",
    "IndicatorCommand",
    "PaneCommand",
    "VisualizationRequest",
    "VisualizationResponse",
    "DataLoadResponse",
    "VisualizationCommandsResponse",
    "ParametersResponse",
    "ComplexityResponse",
    "VisualizationErrorCode",
    "create_data_response",
    "create_commands_response",
    "create_params_response",
    "create_complexity_response",
]
