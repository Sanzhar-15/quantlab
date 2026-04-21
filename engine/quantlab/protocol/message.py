"""
IPC Message Types and Structures.

Defines all message types for communication between UI and daemon.

Spec Reference: Technical Spec §15, Appendix_B_IPC_Protocol
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from enum import Enum
from typing import Any
from typing import Literal
import uuid


class MessageType(Enum):
    """IPC message types."""

    # Control messages (Critical - require ACK)
    SESSION_START = "session.start"
    SESSION_STOP = "session.stop"
    SESSION_PAUSE = "session.pause"
    SESSION_RESUME = "session.resume"
    ORDER_SUBMIT = "order.submit"
    ORDER_CANCEL = "order.cancel"
    ORDER_MODIFY = "order.modify"
    FLATTEN_REQUEST = "flatten.request"
    RISK_ACTION = "risk.action"

    # State messages (Important - best effort + snapshot)
    POSITIONS_UPDATE = "positions.update"
    ORDERS_UPDATE = "orders.update"
    FILLS_UPDATE = "fills.update"
    PERFORMANCE_UPDATE = "performance.update"
    ACTIVITY_UPDATE = "activity.update"  # Activity log stream

    # Status messages
    HEARTBEAT = "heartbeat"
    CONNECTION_STATUS = "connection.status"
    RISK_ALERT = "risk.alert"
    STATUS_UPDATE = "status.update"
    ERROR = "error"
    ERROR_STATE = "error.state"  # Structured error state
    POSITIONS = "positions"
    ORDERS = "orders"  # FIX-CGP-005: For order state notifications
    FILLS = "fills"  # FIX-CGP-005: For fill state notifications

    # Log messages (Telemetry - fire and forget)
    LOG_ENTRY = "log.entry"

    # Handshake and Authentication
    HANDSHAKE_REQUEST = "handshake.request"
    HANDSHAKE_RESPONSE = "handshake.response"
    NEGOTIATE = "negotiate"  # Version negotiation
    AUTH = "auth"  # Authentication request
    AUTH_RESULT = "auth_result"  # Authentication response

    @property
    def reliability_class(self) -> "ReliabilityClass":
        """Get the reliability class for this message type."""
        return get_message_reliability(self)


class ReliabilityClass(Enum):
    """Message reliability classification."""

    CRITICAL = "critical"      # ACK required, retry 3x with exponential backoff
    IMPORTANT = "important"    # Best-effort + snapshot on reconnect
    TELEMETRY = "telemetry"    # Fire-and-forget, dropped when buffer full

    @property
    def requires_ack(self) -> bool:
        """Check if this reliability class requires acknowledgment."""
        return self == ReliabilityClass.CRITICAL


# Protocol version
PROTOCOL_VERSION = "1.0"


# Stream types for message routing
class StreamType(Enum):
    """Message stream types for routing and ordering."""

    CONTROL = "control"  # Session/order control messages
    STATE = "state"      # Position/order/fill updates
    STATUS = "status"    # Connection/health status
    LOGS = "logs"        # Log entries and activity


# Message type to stream mapping
MESSAGE_STREAM: dict[MessageType, StreamType] = {
    # Control stream
    MessageType.SESSION_START: StreamType.CONTROL,
    MessageType.SESSION_STOP: StreamType.CONTROL,
    MessageType.SESSION_PAUSE: StreamType.CONTROL,
    MessageType.SESSION_RESUME: StreamType.CONTROL,
    MessageType.ORDER_SUBMIT: StreamType.CONTROL,
    MessageType.ORDER_CANCEL: StreamType.CONTROL,
    MessageType.ORDER_MODIFY: StreamType.CONTROL,
    MessageType.FLATTEN_REQUEST: StreamType.CONTROL,
    MessageType.RISK_ACTION: StreamType.CONTROL,
    MessageType.NEGOTIATE: StreamType.CONTROL,
    MessageType.AUTH: StreamType.CONTROL,
    MessageType.AUTH_RESULT: StreamType.CONTROL,
    MessageType.HANDSHAKE_REQUEST: StreamType.CONTROL,
    MessageType.HANDSHAKE_RESPONSE: StreamType.CONTROL,

    # State stream
    MessageType.POSITIONS_UPDATE: StreamType.STATE,
    MessageType.ORDERS_UPDATE: StreamType.STATE,
    MessageType.FILLS_UPDATE: StreamType.STATE,
    MessageType.PERFORMANCE_UPDATE: StreamType.STATE,
    MessageType.ACTIVITY_UPDATE: StreamType.STATE,
    MessageType.POSITIONS: StreamType.STATE,

    # Status stream
    MessageType.HEARTBEAT: StreamType.STATUS,
    MessageType.CONNECTION_STATUS: StreamType.STATUS,
    MessageType.RISK_ALERT: StreamType.STATUS,
    MessageType.STATUS_UPDATE: StreamType.STATUS,
    MessageType.ERROR: StreamType.STATUS,
    MessageType.ERROR_STATE: StreamType.STATUS,

    # Logs stream
    MessageType.LOG_ENTRY: StreamType.LOGS,
}


def get_message_reliability(msg_type: MessageType) -> ReliabilityClass:
    """
    Get reliability class for a message type.

    Raises KeyError for unknown types instead of silently defaulting,
    to ensure new message types are explicitly assigned reliability.
    """
    if msg_type not in MESSAGE_RELIABILITY:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(
            f"Unknown message type {msg_type} has no reliability mapping. "
            f"Add it to MESSAGE_RELIABILITY dict. Defaulting to TELEMETRY."
        )
        return ReliabilityClass.TELEMETRY
    return MESSAGE_RELIABILITY[msg_type]


# Message type to reliability class mapping
MESSAGE_RELIABILITY: dict[MessageType, ReliabilityClass] = {
    # Critical
    MessageType.SESSION_START: ReliabilityClass.CRITICAL,
    MessageType.SESSION_STOP: ReliabilityClass.CRITICAL,
    MessageType.SESSION_PAUSE: ReliabilityClass.CRITICAL,
    MessageType.SESSION_RESUME: ReliabilityClass.CRITICAL,
    MessageType.ORDER_SUBMIT: ReliabilityClass.CRITICAL,
    MessageType.ORDER_CANCEL: ReliabilityClass.CRITICAL,
    MessageType.ORDER_MODIFY: ReliabilityClass.CRITICAL,
    MessageType.FLATTEN_REQUEST: ReliabilityClass.CRITICAL,
    MessageType.RISK_ACTION: ReliabilityClass.CRITICAL,

    # Important
    MessageType.POSITIONS_UPDATE: ReliabilityClass.IMPORTANT,
    MessageType.ORDERS_UPDATE: ReliabilityClass.IMPORTANT,
    MessageType.FILLS_UPDATE: ReliabilityClass.IMPORTANT,
    MessageType.PERFORMANCE_UPDATE: ReliabilityClass.IMPORTANT,
    MessageType.ACTIVITY_UPDATE: ReliabilityClass.IMPORTANT,
    MessageType.CONNECTION_STATUS: ReliabilityClass.IMPORTANT,
    MessageType.RISK_ALERT: ReliabilityClass.IMPORTANT,

    # Telemetry
    MessageType.HEARTBEAT: ReliabilityClass.TELEMETRY,
    MessageType.LOG_ENTRY: ReliabilityClass.TELEMETRY,

    # Status messages
    MessageType.STATUS_UPDATE: ReliabilityClass.IMPORTANT,
    MessageType.ERROR: ReliabilityClass.CRITICAL,
    MessageType.ERROR_STATE: ReliabilityClass.IMPORTANT,
    MessageType.POSITIONS: ReliabilityClass.IMPORTANT,

    # Handshake and auth (critical)
    MessageType.HANDSHAKE_REQUEST: ReliabilityClass.CRITICAL,
    MessageType.HANDSHAKE_RESPONSE: ReliabilityClass.CRITICAL,
    MessageType.NEGOTIATE: ReliabilityClass.CRITICAL,
    MessageType.AUTH: ReliabilityClass.CRITICAL,
    MessageType.AUTH_RESULT: ReliabilityClass.CRITICAL,
}


@dataclass
class Message:
    """
    Base IPC message structure.

    All messages follow JSON-RPC 2.0 format with extensions for
    sequence numbers and reliability.
    """

    type: MessageType
    payload: dict[str, Any]
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sequence: int = 0
    session_id: str | None = None
    overflow_info: dict[str, Any] | None = None  # Set when buffer overflow occurred

    @property
    def reliability(self) -> ReliabilityClass:
        """Get the reliability class for this message type."""
        return get_message_reliability(self.type)

    @property
    def requires_ack(self) -> bool:
        """Check if this message requires acknowledgment."""
        return self.reliability == ReliabilityClass.CRITICAL

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        stream = MESSAGE_STREAM.get(self.type, StreamType.CONTROL)
        meta: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": self.session_id,
            "sequence": self.sequence,
            "timestamp": self.timestamp.isoformat(),
            "stream": stream.value,
        }
        # Include overflow info if messages were dropped (per IPC Protocol spec)
        if self.overflow_info:
            meta["overflow"] = True
            meta["overflowInfo"] = self.overflow_info
        return {
            "jsonrpc": "2.0",
            "method": self.type.value,
            "params": self.payload,
            "id": self.id,
            "_meta": meta,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Message":
        """Create message from dictionary."""
        # Support both _meta (spec) and meta (legacy)
        meta = data.get("_meta", data.get("meta", {}))
        return cls(
            type=MessageType(data["method"]),
            payload=data.get("params", {}),
            id=data.get("id", str(uuid.uuid4())),
            timestamp=datetime.fromisoformat(meta.get("timestamp", "").replace("Z", "+00:00"))
            if meta.get("timestamp")
            else datetime.now(timezone.utc),
            sequence=meta.get("sequence", 0),
            # Support both sessionId (spec) and session_id (legacy)
            session_id=meta.get("sessionId", meta.get("session_id")),
        )


@dataclass
class Request:
    """JSON-RPC 2.0 request message."""

    message_type: MessageType
    params: dict[str, Any]
    session_id: str = ""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sequence: int = 0
    overflow_info: dict[str, Any] | None = None  # Set when buffer overflow occurred

    @property
    def reliability(self) -> ReliabilityClass:
        """Get the reliability class for this message type."""
        return get_message_reliability(self.message_type)

    @property
    def requires_ack(self) -> bool:
        """Check if this message requires acknowledgment."""
        return self.reliability == ReliabilityClass.CRITICAL

    def to_dict(self) -> dict[str, Any]:
        """Convert to JSON-RPC request format."""
        stream = MESSAGE_STREAM.get(self.message_type, StreamType.CONTROL)
        meta: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": self.session_id,
            "sequence": self.sequence,
            "timestamp": self.timestamp.isoformat(),
            "stream": stream.value,
        }
        # Include overflow info if messages were dropped (per IPC Protocol spec)
        if self.overflow_info:
            meta["overflow"] = True
            meta["overflowInfo"] = self.overflow_info
        return {
            "jsonrpc": "2.0",
            "method": self.message_type.value,
            "params": self.params,
            "id": self.id,
            "_meta": meta,
        }

    def to_json(self) -> str:
        """Convert to JSON string."""
        import json
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, json_str: str) -> "Request":
        """Create request from JSON string."""
        import json
        data = json.loads(json_str)
        # Support both _meta (spec) and meta (legacy)
        meta = data.get("_meta", data.get("meta", {}))
        return cls(
            message_type=MessageType(data["method"]),
            params=data.get("params", {}),
            id=data.get("id", str(uuid.uuid4())),
            session_id=meta.get("sessionId", meta.get("session_id", "")),
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Request":
        """Create request from dictionary."""
        # Support both _meta (spec) and meta (legacy)
        meta = data.get("_meta", data.get("meta", {}))
        return cls(
            message_type=MessageType(data["method"]),
            params=data.get("params", {}),
            id=data.get("id", str(uuid.uuid4())),
            timestamp=datetime.fromisoformat(meta.get("timestamp", "").replace("Z", "+00:00"))
            if meta.get("timestamp")
            else datetime.now(timezone.utc),
            sequence=meta.get("sequence", 0),
            # Support both sessionId (spec) and session_id (legacy)
            session_id=meta.get("sessionId", meta.get("session_id", "")),
        )


@dataclass
class Response:
    """JSON-RPC 2.0 response message."""

    id: str
    result: Any | None = None
    error: dict[str, Any] | None = None
    session_id: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def success(self) -> bool:
        """Check if response indicates success."""
        return self.error is None

    def to_dict(self) -> dict[str, Any]:
        """Convert to JSON-RPC response format."""
        data: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self.id,
        }
        if self.error is not None:
            data["error"] = self.error
        else:
            data["result"] = self.result
        return data

    def to_json(self) -> str:
        """Convert to JSON string."""
        import json
        return json.dumps(self.to_dict())

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Response":
        """Create response from dictionary."""
        return cls(
            id=data.get("id", ""),
            result=data.get("result"),
            error=data.get("error"),
        )

    @classmethod
    def from_json(cls, json_str: str) -> "Response":
        """Create response from JSON string."""
        import json
        return cls.from_dict(json.loads(json_str))

    @classmethod
    def success_response(cls, id: str, result: Any = None) -> "Response":
        """Create a success response."""
        return cls(id=id, result=result)

    @classmethod
    def error_response(
        cls,
        id: str,
        code: int,
        message: str,
        data: Any = None,
    ) -> "Response":
        """Create an error response."""
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return cls(id=id, error=error)


@dataclass
class Notification:
    """
    JSON-RPC 2.0 notification (no response expected).

    Used for state updates, heartbeats, and logs.
    """

    message_type: MessageType
    params: dict[str, Any]
    session_id: str = ""
    id: str | None = None  # Notifications have no ID
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sequence: int = 0
    overflow_info: dict[str, Any] | None = None  # Set when buffer overflow occurred

    @property
    def reliability(self) -> ReliabilityClass:
        """Get the reliability class for this message type."""
        return get_message_reliability(self.message_type)

    def to_dict(self) -> dict[str, Any]:
        """Convert to JSON-RPC notification format (no id)."""
        stream = MESSAGE_STREAM.get(self.message_type, StreamType.STATE)
        meta: dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": self.session_id,
            "sequence": self.sequence,
            "timestamp": self.timestamp.isoformat(),
            "stream": stream.value,
        }
        # Include overflow info if messages were dropped (per IPC Protocol spec)
        if self.overflow_info:
            meta["overflow"] = True
            meta["overflowInfo"] = self.overflow_info
        return {
            "jsonrpc": "2.0",
            "method": self.message_type.value,
            "params": self.params,
            "_meta": meta,
        }

    def to_json(self) -> str:
        """Convert to JSON string."""
        import json
        return json.dumps(self.to_dict())


# Standard JSON-RPC error codes
# FIX-H10: Renamed from ErrorCode to RpcErrorCode to avoid conflict
# with the canonical ErrorCode Enum in quantlab.errors
class RpcErrorCode:
    """
    JSON-RPC 2.0 and application wire-format error codes.

    JSON-RPC reserved codes: -32700 to -32600
    Application codes (per IPC Protocol spec): 1001-3002

    These are the numeric codes sent over the IPC wire.
    For the internal error taxonomy, see quantlab.errors.ErrorCode.
    """

    # JSON-RPC 2.0 standard error codes (negative)
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603

    # Application error codes per IPC Protocol spec (positive: 1001-3002)
    # Authentication/Session (1001-1003)
    NOT_AUTHENTICATED = 1001
    SESSION_NOT_FOUND = 1002
    SESSION_NOT_ACTIVE = 1003

    # Order errors (2001-2003)
    ORDER_REJECTED = 2001
    ORDER_NOT_FOUND = 2002
    ORDER_ALREADY_FILLED = 2003

    # Broker/Connection errors (3001-3002)
    BROKER_DISCONNECTED = 3001
    QUOTE_STALE = 3002

    # Extended application codes (not in spec, for internal use)
    SESSION_ALREADY_RUNNING = 1004
    EXPOSURE_LIMIT_BREACH = 2004
    BROKER_ERROR = 3003
    RATE_LIMITED = 3004
    INVALID_STATE = 1005


# Backward-compat alias for code that imports the old name
ErrorCode = RpcErrorCode
