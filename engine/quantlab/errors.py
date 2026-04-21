"""
Centralized Error Taxonomy.

Provides structured error codes, categories, and responses for the entire system.

Spec Reference: Technical Spec §16
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from enum import Enum
from typing import Any


class ErrorCategory(Enum):
    """High-level error categories."""

    # Protocol errors (1xxx)
    PROTOCOL = "protocol"

    # Authentication/Session errors (2xxx)
    AUTH = "auth"

    # Order/Trading errors (3xxx)
    ORDER = "order"

    # Risk errors (4xxx)
    RISK = "risk"

    # Data errors (5xxx)
    DATA = "data"

    # Broker/Connection errors (6xxx)
    BROKER = "broker"

    # Strategy errors (7xxx)
    STRATEGY = "strategy"

    # System errors (8xxx)
    SYSTEM = "system"

    # Validation errors (9xxx)
    VALIDATION = "validation"


class ErrorCode(Enum):
    """
    Centralized error codes with numeric values.

    Format: CXXX where C = category (1-9), XXX = specific error

    This extends the JSON-RPC error codes from protocol/message.py with
    application-specific codes organized by category.
    """

    # Protocol errors (1xxx)
    PARSE_ERROR = 1001
    INVALID_REQUEST = 1002
    METHOD_NOT_FOUND = 1003
    INVALID_PARAMS = 1004
    INTERNAL_ERROR = 1005
    PROTOCOL_VERSION_MISMATCH = 1006
    MESSAGE_TOO_LARGE = 1007
    TIMEOUT = 1008

    # Authentication/Session errors (2xxx)
    NOT_AUTHENTICATED = 2001
    INVALID_TOKEN = 2002
    TOKEN_EXPIRED = 2003
    SESSION_NOT_FOUND = 2004
    SESSION_NOT_ACTIVE = 2005
    SESSION_ALREADY_RUNNING = 2006
    SESSION_LIMIT_EXCEEDED = 2007
    PERMISSION_DENIED = 2008

    # Order errors (3xxx)
    ORDER_REJECTED = 3001
    ORDER_NOT_FOUND = 3002
    ORDER_ALREADY_FILLED = 3003
    ORDER_ALREADY_CANCELLED = 3004
    ORDER_INVALID_STATE = 3005
    ORDER_INVALID_QUANTITY = 3006
    ORDER_INVALID_PRICE = 3007
    ORDER_INVALID_SIDE = 3008
    ORDER_INVALID_TYPE = 3009
    ORDER_DUPLICATE = 3010
    ORDER_CANCEL_FAILED = 3011
    ORDER_MODIFY_FAILED = 3012

    # Risk errors (4xxx)
    EXPOSURE_LIMIT_BREACH = 4001
    POSITION_LIMIT_BREACH = 4002
    DAILY_LOSS_LIMIT_BREACH = 4003
    CONSECUTIVE_LOSS_LIMIT = 4004
    CIRCUIT_BREAKER_ACTIVE = 4005
    INSUFFICIENT_MARGIN = 4006
    RISK_CHECK_FAILED = 4007
    FLATTEN_REQUIRED = 4008

    # Data errors (5xxx)
    DATA_NOT_FOUND = 5001
    DATA_INVALID_FORMAT = 5002
    DATA_PARSE_ERROR = 5003
    DATA_STALE = 5004
    DATA_HASH_MISMATCH = 5005
    DATA_INCOMPLETE = 5006
    DATA_RANGE_INVALID = 5007
    DATA_SOURCE_ERROR = 5008

    # Broker/Connection errors (6xxx)
    BROKER_DISCONNECTED = 6001
    BROKER_TIMEOUT = 6002
    BROKER_REJECTED = 6003
    BROKER_ERROR = 6004
    QUOTE_STALE = 6005
    QUOTE_UNAVAILABLE = 6006
    RECONNECTION_FAILED = 6007
    RATE_LIMITED = 6008

    # Strategy errors (7xxx)
    STRATEGY_NOT_FOUND = 7001
    STRATEGY_LOAD_FAILED = 7002
    STRATEGY_EXECUTION_ERROR = 7003
    STRATEGY_VALIDATION_FAILED = 7004
    STRATEGY_NOT_TRUSTED = 7005
    STRATEGY_MODIFIED = 7006
    STRATEGY_TIMEOUT = 7007

    # System errors (8xxx)
    SYSTEM_ERROR = 8001
    OUT_OF_MEMORY = 8002
    DISK_FULL = 8003
    FILE_NOT_FOUND = 8004
    FILE_PERMISSION_DENIED = 8005
    CHECKPOINT_ERROR = 8006
    AUDIT_LOG_ERROR = 8007
    DAEMON_NOT_RUNNING = 8008

    # Validation errors (9xxx)
    VALIDATION_ERROR = 9001
    INVALID_SYMBOL = 9002
    INVALID_TIMEFRAME = 9003
    INVALID_DATE_RANGE = 9004
    INVALID_PARAMETER = 9005
    REQUIRED_FIELD_MISSING = 9006
    VALUE_OUT_OF_RANGE = 9007
    TYPE_MISMATCH = 9008

    @property
    def category(self) -> ErrorCategory:
        """Get the category for this error code."""
        code = self.value
        if 1000 <= code < 2000:
            return ErrorCategory.PROTOCOL
        elif 2000 <= code < 3000:
            return ErrorCategory.AUTH
        elif 3000 <= code < 4000:
            return ErrorCategory.ORDER
        elif 4000 <= code < 5000:
            return ErrorCategory.RISK
        elif 5000 <= code < 6000:
            return ErrorCategory.DATA
        elif 6000 <= code < 7000:
            return ErrorCategory.BROKER
        elif 7000 <= code < 8000:
            return ErrorCategory.STRATEGY
        elif 8000 <= code < 9000:
            return ErrorCategory.SYSTEM
        else:
            return ErrorCategory.VALIDATION

    @property
    def is_retryable(self) -> bool:
        """Check if this error type is potentially retryable."""
        retryable_codes = {
            ErrorCode.TIMEOUT,
            ErrorCode.BROKER_DISCONNECTED,
            ErrorCode.BROKER_TIMEOUT,
            ErrorCode.QUOTE_STALE,
            ErrorCode.QUOTE_UNAVAILABLE,
            ErrorCode.RECONNECTION_FAILED,
            ErrorCode.RATE_LIMITED,
            ErrorCode.STRATEGY_TIMEOUT,
        }
        return self in retryable_codes

    @property
    def is_critical(self) -> bool:
        """Check if this error is critical and requires immediate attention."""
        critical_codes = {
            ErrorCode.EXPOSURE_LIMIT_BREACH,
            ErrorCode.CIRCUIT_BREAKER_ACTIVE,
            ErrorCode.FLATTEN_REQUIRED,
            ErrorCode.OUT_OF_MEMORY,
            ErrorCode.DISK_FULL,
            ErrorCode.AUDIT_LOG_ERROR,
        }
        return self in critical_codes


# Human-readable error messages
ERROR_MESSAGES: dict[ErrorCode, str] = {
    # Protocol
    ErrorCode.PARSE_ERROR: "Failed to parse message",
    ErrorCode.INVALID_REQUEST: "Invalid request format",
    ErrorCode.METHOD_NOT_FOUND: "Method not found",
    ErrorCode.INVALID_PARAMS: "Invalid parameters",
    ErrorCode.INTERNAL_ERROR: "Internal server error",
    ErrorCode.PROTOCOL_VERSION_MISMATCH: "Protocol version mismatch",
    ErrorCode.MESSAGE_TOO_LARGE: "Message exceeds maximum size",
    ErrorCode.TIMEOUT: "Request timed out",

    # Auth/Session
    ErrorCode.NOT_AUTHENTICATED: "Authentication required",
    ErrorCode.INVALID_TOKEN: "Invalid authentication token",
    ErrorCode.TOKEN_EXPIRED: "Authentication token has expired",
    ErrorCode.SESSION_NOT_FOUND: "Session not found",
    ErrorCode.SESSION_NOT_ACTIVE: "Session is not active",
    ErrorCode.SESSION_ALREADY_RUNNING: "Session is already running",
    ErrorCode.SESSION_LIMIT_EXCEEDED: "Maximum concurrent sessions exceeded",
    ErrorCode.PERMISSION_DENIED: "Permission denied",

    # Order
    ErrorCode.ORDER_REJECTED: "Order rejected",
    ErrorCode.ORDER_NOT_FOUND: "Order not found",
    ErrorCode.ORDER_ALREADY_FILLED: "Order has already been filled",
    ErrorCode.ORDER_ALREADY_CANCELLED: "Order has already been cancelled",
    ErrorCode.ORDER_INVALID_STATE: "Invalid order state for this operation",
    ErrorCode.ORDER_INVALID_QUANTITY: "Invalid order quantity",
    ErrorCode.ORDER_INVALID_PRICE: "Invalid order price",
    ErrorCode.ORDER_INVALID_SIDE: "Invalid order side",
    ErrorCode.ORDER_INVALID_TYPE: "Invalid order type",
    ErrorCode.ORDER_DUPLICATE: "Duplicate order ID",
    ErrorCode.ORDER_CANCEL_FAILED: "Failed to cancel order",
    ErrorCode.ORDER_MODIFY_FAILED: "Failed to modify order",

    # Risk
    ErrorCode.EXPOSURE_LIMIT_BREACH: "Exposure limit would be exceeded",
    ErrorCode.POSITION_LIMIT_BREACH: "Position limit would be exceeded",
    ErrorCode.DAILY_LOSS_LIMIT_BREACH: "Daily loss limit exceeded",
    ErrorCode.CONSECUTIVE_LOSS_LIMIT: "Consecutive loss limit reached",
    ErrorCode.CIRCUIT_BREAKER_ACTIVE: "Circuit breaker is active - trading halted",
    ErrorCode.INSUFFICIENT_MARGIN: "Insufficient margin",
    ErrorCode.RISK_CHECK_FAILED: "Risk check failed",
    ErrorCode.FLATTEN_REQUIRED: "Position flatten required",

    # Data
    ErrorCode.DATA_NOT_FOUND: "Data not found",
    ErrorCode.DATA_INVALID_FORMAT: "Invalid data format",
    ErrorCode.DATA_PARSE_ERROR: "Failed to parse data",
    ErrorCode.DATA_STALE: "Data is stale",
    ErrorCode.DATA_HASH_MISMATCH: "Data integrity check failed",
    ErrorCode.DATA_INCOMPLETE: "Data is incomplete",
    ErrorCode.DATA_RANGE_INVALID: "Invalid date range",
    ErrorCode.DATA_SOURCE_ERROR: "Data source error",

    # Broker
    ErrorCode.BROKER_DISCONNECTED: "Broker connection lost",
    ErrorCode.BROKER_TIMEOUT: "Broker request timed out",
    ErrorCode.BROKER_REJECTED: "Broker rejected request",
    ErrorCode.BROKER_ERROR: "Broker error",
    ErrorCode.QUOTE_STALE: "Quote data is stale",
    ErrorCode.QUOTE_UNAVAILABLE: "Quote not available",
    ErrorCode.RECONNECTION_FAILED: "Failed to reconnect to broker",
    ErrorCode.RATE_LIMITED: "Rate limit exceeded",

    # Strategy
    ErrorCode.STRATEGY_NOT_FOUND: "Strategy file not found",
    ErrorCode.STRATEGY_LOAD_FAILED: "Failed to load strategy",
    ErrorCode.STRATEGY_EXECUTION_ERROR: "Strategy execution error",
    ErrorCode.STRATEGY_VALIDATION_FAILED: "Strategy validation failed",
    ErrorCode.STRATEGY_NOT_TRUSTED: "Strategy is not trusted",
    ErrorCode.STRATEGY_MODIFIED: "Strategy file has been modified",
    ErrorCode.STRATEGY_TIMEOUT: "Strategy execution timed out",

    # System
    ErrorCode.SYSTEM_ERROR: "System error",
    ErrorCode.OUT_OF_MEMORY: "Out of memory",
    ErrorCode.DISK_FULL: "Disk space full",
    ErrorCode.FILE_NOT_FOUND: "File not found",
    ErrorCode.FILE_PERMISSION_DENIED: "File permission denied",
    ErrorCode.CHECKPOINT_ERROR: "Checkpoint error",
    ErrorCode.AUDIT_LOG_ERROR: "Audit log error",
    ErrorCode.DAEMON_NOT_RUNNING: "Daemon is not running",

    # Validation
    ErrorCode.VALIDATION_ERROR: "Validation error",
    ErrorCode.INVALID_SYMBOL: "Invalid symbol",
    ErrorCode.INVALID_TIMEFRAME: "Invalid timeframe",
    ErrorCode.INVALID_DATE_RANGE: "Invalid date range",
    ErrorCode.INVALID_PARAMETER: "Invalid parameter",
    ErrorCode.REQUIRED_FIELD_MISSING: "Required field missing",
    ErrorCode.VALUE_OUT_OF_RANGE: "Value out of range",
    ErrorCode.TYPE_MISMATCH: "Type mismatch",
}


@dataclass
class QuantlabError:
    """
    Structured error response.

    Provides consistent error format across the entire system.
    """

    code: ErrorCode
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    request_id: str | None = None
    session_id: str | None = None

    @property
    def category(self) -> ErrorCategory:
        """Get error category."""
        return self.code.category

    @property
    def is_retryable(self) -> bool:
        """Check if error is retryable."""
        return self.code.is_retryable

    @property
    def is_critical(self) -> bool:
        """Check if error is critical."""
        return self.code.is_critical

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "code": self.code.value,
            "error": self.code.name,
            "category": self.category.value,
            "message": self.message,
            "details": self.details,
            "timestamp": self.timestamp.isoformat(),
            "request_id": self.request_id,
            "session_id": self.session_id,
            "retryable": self.is_retryable,
            "critical": self.is_critical,
        }

    def to_json_rpc_error(self) -> dict[str, Any]:
        """Convert to JSON-RPC 2.0 error format."""
        return {
            "code": self.code.value,
            "message": self.message,
            "data": {
                "error": self.code.name,
                "category": self.category.value,
                "details": self.details,
                "timestamp": self.timestamp.isoformat(),
                "retryable": self.is_retryable,
            },
        }

    @classmethod
    def from_code(
        cls,
        code: ErrorCode,
        details: dict[str, Any] | None = None,
        request_id: str | None = None,
        session_id: str | None = None,
    ) -> "QuantlabError":
        """Create error from code with default message."""
        return cls(
            code=code,
            message=ERROR_MESSAGES.get(code, "Unknown error"),
            details=details or {},
            request_id=request_id,
            session_id=session_id,
        )

    @classmethod
    def from_exception(
        cls,
        exc: Exception,
        code: ErrorCode = ErrorCode.SYSTEM_ERROR,
        request_id: str | None = None,
        session_id: str | None = None,
    ) -> "QuantlabError":
        """Create error from exception."""
        return cls(
            code=code,
            message=str(exc),
            details={"exception_type": type(exc).__name__},
            request_id=request_id,
            session_id=session_id,
        )


class QuantlabException(Exception):
    """
    Base exception for Quantlab errors.

    Wraps QuantlabError for exception handling.
    """

    def __init__(self, error: QuantlabError) -> None:
        self.error = error
        super().__init__(error.message)

    @classmethod
    def from_code(
        cls,
        code: ErrorCode,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> "QuantlabException":
        """Create exception from error code."""
        error = QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Unknown error"),
            details=details or {},
        )
        return cls(error)


# Convenience exception classes for common error types
class AuthenticationError(QuantlabException):
    """Authentication-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.NOT_AUTHENTICATED,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Authentication error"),
            details=details or {},
        ))


class OrderError(QuantlabException):
    """Order-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.ORDER_REJECTED,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Order error"),
            details=details or {},
        ))


class RiskError(QuantlabException):
    """Risk-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.RISK_CHECK_FAILED,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Risk error"),
            details=details or {},
        ))


class DataError(QuantlabException):
    """Data-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.DATA_NOT_FOUND,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Data error"),
            details=details or {},
        ))


class BrokerError(QuantlabException):
    """Broker-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.BROKER_ERROR,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Broker error"),
            details=details or {},
        ))


class StrategyError(QuantlabException):
    """Strategy-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.STRATEGY_EXECUTION_ERROR,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Strategy error"),
            details=details or {},
        ))


class ValidationError(QuantlabException):
    """Validation-related errors."""

    def __init__(
        self,
        code: ErrorCode = ErrorCode.VALIDATION_ERROR,
        message: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(QuantlabError(
            code=code,
            message=message or ERROR_MESSAGES.get(code, "Validation error"),
            details=details or {},
        ))
