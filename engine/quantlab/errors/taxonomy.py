"""
Error Taxonomy.

Provides a structured error hierarchy with:
- Error codes (unique identifiers)
- Categories (grouping)
- Severity levels
- Recovery suggestions
- User-friendly messages

Spec Reference: Technical Spec §13.2
"""

from dataclasses import dataclass
from dataclasses import field
from enum import Enum
from typing import Any


class ErrorCategory(Enum):
    """Error categories for grouping and routing."""

    # Trading errors
    ORDER = "order"
    POSITION = "position"
    RISK = "risk"

    # Infrastructure errors
    CONNECTION = "connection"
    BROKER = "broker"
    DATA = "data"

    # System errors
    INTERNAL = "internal"
    CONFIGURATION = "configuration"
    AUTHENTICATION = "authentication"

    # User errors
    VALIDATION = "validation"
    PERMISSION = "permission"


class ErrorSeverity(Enum):
    """
    Error severity levels.

    INFO: Informational, no action needed
    WARNING: Non-critical issue, may need attention
    ERROR: Operation failed, action needed
    CRITICAL: System stability at risk, immediate action
    """

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class RecoveryType(Enum):
    """
    How the error can be recovered.

    AUTOMATIC: System will retry automatically
    USER_RETRY: User should retry the operation
    USER_ACTION: User needs to take specific action
    SUPPORT: Contact support needed
    FATAL: Cannot be recovered
    """

    AUTOMATIC = "automatic"
    USER_RETRY = "user_retry"
    USER_ACTION = "user_action"
    SUPPORT = "support"
    FATAL = "fatal"


@dataclass
class ErrorCode:
    """
    Error code definition.

    Error codes follow the pattern: {category}{number}
    E.g., ORD001 for order errors, CON001 for connection errors
    """

    code: str
    category: ErrorCategory
    severity: ErrorSeverity
    recovery: RecoveryType
    message_template: str
    user_action: str | None = None


# Error code registry
ERROR_CODES: dict[str, ErrorCode] = {}


def register_error(
    code: str,
    category: ErrorCategory,
    severity: ErrorSeverity,
    recovery: RecoveryType,
    message_template: str,
    user_action: str | None = None,
) -> ErrorCode:
    """Register an error code."""
    error = ErrorCode(
        code=code,
        category=category,
        severity=severity,
        recovery=recovery,
        message_template=message_template,
        user_action=user_action,
    )
    ERROR_CODES[code] = error
    return error


# ============================================================================
# Order Errors (ORD)
# ============================================================================

ORD001 = register_error(
    "ORD001",
    ErrorCategory.ORDER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Order rejected: {reason}",
    "Review order parameters and try again",
)

ORD002 = register_error(
    "ORD002",
    ErrorCategory.ORDER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Insufficient buying power for order. Required: {required}, Available: {available}",
    "Reduce order size or deposit more funds",
)

ORD003 = register_error(
    "ORD003",
    ErrorCategory.ORDER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Order would exceed position limit: {limit}",
    "Reduce order size to stay within limits",
)

ORD004 = register_error(
    "ORD004",
    ErrorCategory.ORDER,
    ErrorSeverity.WARNING,
    RecoveryType.USER_RETRY,
    "Order expired: {order_id}",
    "Submit a new order if still desired",
)

ORD005 = register_error(
    "ORD005",
    ErrorCategory.ORDER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Invalid order quantity: {quantity}. Must be positive and meet lot size: {lot_size}",
    "Adjust quantity to valid increment",
)

ORD006 = register_error(
    "ORD006",
    ErrorCategory.ORDER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Symbol not tradeable: {symbol}",
    "Check symbol is valid and market is open",
)

ORD007 = register_error(
    "ORD007",
    ErrorCategory.ORDER,
    ErrorSeverity.ERROR,
    RecoveryType.AUTOMATIC,
    "Order submission failed, retrying: {attempt}/{max_attempts}",
    None,
)

# ============================================================================
# Risk Errors (RSK)
# ============================================================================

RSK001 = register_error(
    "RSK001",
    ErrorCategory.RISK,
    ErrorSeverity.CRITICAL,
    RecoveryType.USER_ACTION,
    "Circuit breaker triggered: {reason}",
    "Review positions and acknowledge to resume trading",
)

RSK002 = register_error(
    "RSK002",
    ErrorCategory.RISK,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Exposure limit breach: {current} / {limit}",
    "Close positions or increase limit in settings",
)

RSK003 = register_error(
    "RSK003",
    ErrorCategory.RISK,
    ErrorSeverity.WARNING,
    RecoveryType.USER_ACTION,
    "Consecutive loss limit reached: {count} losses",
    "Review strategy performance and acknowledge to continue",
)

RSK004 = register_error(
    "RSK004",
    ErrorCategory.RISK,
    ErrorSeverity.CRITICAL,
    RecoveryType.USER_ACTION,
    "Daily loss limit reached: {loss} / {limit}",
    "Trading paused for the day. Resume tomorrow or adjust limits.",
)

RSK005 = register_error(
    "RSK005",
    ErrorCategory.RISK,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Order would exceed exposure limit. Available: {available}",
    "Reduce order size",
)

# ============================================================================
# Connection Errors (CON)
# ============================================================================

CON001 = register_error(
    "CON001",
    ErrorCategory.CONNECTION,
    ErrorSeverity.ERROR,
    RecoveryType.AUTOMATIC,
    "Connection lost to {service}. Reconnecting...",
    None,
)

CON002 = register_error(
    "CON002",
    ErrorCategory.CONNECTION,
    ErrorSeverity.CRITICAL,
    RecoveryType.USER_ACTION,
    "Failed to connect to {service} after {attempts} attempts",
    "Check network connection and service status",
)

CON003 = register_error(
    "CON003",
    ErrorCategory.CONNECTION,
    ErrorSeverity.WARNING,
    RecoveryType.AUTOMATIC,
    "Connection unstable: {latency}ms latency",
    None,
)

CON004 = register_error(
    "CON004",
    ErrorCategory.CONNECTION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "IPC connection to daemon lost",
    "Restart the application or check daemon status",
)

# ============================================================================
# Broker Errors (BRK)
# ============================================================================

BRK001 = register_error(
    "BRK001",
    ErrorCategory.BROKER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Broker authentication failed: {reason}",
    "Check credentials in Settings > Brokers",
)

BRK002 = register_error(
    "BRK002",
    ErrorCategory.BROKER,
    ErrorSeverity.ERROR,
    RecoveryType.SUPPORT,
    "Broker API error: {error}",
    "Contact broker support if issue persists",
)

BRK003 = register_error(
    "BRK003",
    ErrorCategory.BROKER,
    ErrorSeverity.WARNING,
    RecoveryType.AUTOMATIC,
    "Broker rate limit reached. Waiting {seconds}s",
    None,
)

BRK004 = register_error(
    "BRK004",
    ErrorCategory.BROKER,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Broker account restricted: {reason}",
    "Contact broker to resolve account restriction",
)

# ============================================================================
# Data Errors (DAT)
# ============================================================================

DAT001 = register_error(
    "DAT001",
    ErrorCategory.DATA,
    ErrorSeverity.ERROR,
    RecoveryType.AUTOMATIC,
    "Market data feed interrupted for {symbol}",
    None,
)

DAT002 = register_error(
    "DAT002",
    ErrorCategory.DATA,
    ErrorSeverity.WARNING,
    RecoveryType.AUTOMATIC,
    "Stale data detected for {symbol}: {age}s old",
    None,
)

DAT003 = register_error(
    "DAT003",
    ErrorCategory.DATA,
    ErrorSeverity.ERROR,
    RecoveryType.USER_RETRY,
    "Historical data unavailable for {symbol} ({start} - {end})",
    "Try a different date range or data provider",
)

DAT004 = register_error(
    "DAT004",
    ErrorCategory.DATA,
    ErrorSeverity.ERROR,
    RecoveryType.SUPPORT,
    "Data corruption detected in {file}",
    "Contact support to recover data",
)

# ============================================================================
# Configuration Errors (CFG)
# ============================================================================

CFG001 = register_error(
    "CFG001",
    ErrorCategory.CONFIGURATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Invalid configuration: {field} - {reason}",
    "Correct the configuration value in settings",
)

CFG002 = register_error(
    "CFG002",
    ErrorCategory.CONFIGURATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Strategy file not found: {path}",
    "Check file path and ensure strategy exists",
)

CFG003 = register_error(
    "CFG003",
    ErrorCategory.CONFIGURATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Strategy syntax error at line {line}: {error}",
    "Fix the syntax error in your strategy code",
)

CFG004 = register_error(
    "CFG004",
    ErrorCategory.CONFIGURATION,
    ErrorSeverity.WARNING,
    RecoveryType.USER_ACTION,
    "Deprecated configuration: {key}. Use {replacement} instead.",
    "Update your configuration to use the new key",
)

# ============================================================================
# Authentication Errors (AUT)
# ============================================================================

AUT001 = register_error(
    "AUT001",
    ErrorCategory.AUTHENTICATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Invalid master password",
    "Enter correct password or reset if forgotten",
)

AUT002 = register_error(
    "AUT002",
    ErrorCategory.AUTHENTICATION,
    ErrorSeverity.CRITICAL,
    RecoveryType.USER_ACTION,
    "Account locked after {attempts} failed attempts. Wait {minutes} minutes.",
    "Wait for lockout to expire or contact support",
)

AUT003 = register_error(
    "AUT003",
    ErrorCategory.AUTHENTICATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "IPC authentication failed",
    "Restart the application",
)

# ============================================================================
# Internal Errors (INT)
# ============================================================================

INT001 = register_error(
    "INT001",
    ErrorCategory.INTERNAL,
    ErrorSeverity.CRITICAL,
    RecoveryType.SUPPORT,
    "Internal error: {message}",
    "Please report this error with logs",
)

INT002 = register_error(
    "INT002",
    ErrorCategory.INTERNAL,
    ErrorSeverity.ERROR,
    RecoveryType.AUTOMATIC,
    "Unexpected state: {state}. Recovering...",
    None,
)

INT003 = register_error(
    "INT003",
    ErrorCategory.INTERNAL,
    ErrorSeverity.CRITICAL,
    RecoveryType.FATAL,
    "Fatal error: {message}",
    "Application must be restarted",
)

# ============================================================================
# Validation Errors (VAL)
# ============================================================================

VAL001 = register_error(
    "VAL001",
    ErrorCategory.VALIDATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Invalid input: {field} - {reason}",
    "Correct the input value",
)

VAL002 = register_error(
    "VAL002",
    ErrorCategory.VALIDATION,
    ErrorSeverity.ERROR,
    RecoveryType.USER_ACTION,
    "Required field missing: {field}",
    "Provide a value for the required field",
)


@dataclass
class StructuredError:
    """
    Structured error with full context.

    This is what gets logged and sent to the UI.
    """

    code: str
    category: ErrorCategory
    severity: ErrorSeverity
    recovery: RecoveryType
    message: str
    user_action: str | None = None
    context: dict[str, Any] = field(default_factory=dict)
    exception: Exception | None = None

    @classmethod
    def from_code(
        cls,
        code: str | ErrorCode,
        context: dict[str, Any] | None = None,
        exception: Exception | None = None,
    ) -> "StructuredError":
        """
        Create structured error from error code.

        Args:
            code: Error code string or ErrorCode object
            context: Values to interpolate in message template
            exception: Original exception if any

        Returns:
            StructuredError instance
        """
        if isinstance(code, str):
            error_def = ERROR_CODES.get(code)
            if not error_def:
                error_def = INT001
                context = context or {}
                context["message"] = f"Unknown error code: {code}"
        else:
            error_def = code

        ctx = context or {}

        # Format message with context
        try:
            message = error_def.message_template.format(**ctx)
        except KeyError:
            message = error_def.message_template

        return cls(
            code=error_def.code,
            category=error_def.category,
            severity=error_def.severity,
            recovery=error_def.recovery,
            message=message,
            user_action=error_def.user_action,
            context=ctx,
            exception=exception,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "code": self.code,
            "category": self.category.value,
            "severity": self.severity.value,
            "recovery": self.recovery.value,
            "message": self.message,
            "context": self.context,
        }

        if self.user_action:
            result["user_action"] = self.user_action

        if self.exception:
            result["exception"] = str(self.exception)

        return result

    def is_critical(self) -> bool:
        """Check if error is critical."""
        return self.severity == ErrorSeverity.CRITICAL

    def is_recoverable(self) -> bool:
        """Check if error can be recovered."""
        return self.recovery != RecoveryType.FATAL


class QuantLabError(Exception):
    """
    Base exception for all QuantLab errors.

    Carries structured error information.
    """

    def __init__(
        self,
        code: str | ErrorCode,
        context: dict[str, Any] | None = None,
        cause: Exception | None = None,
    ) -> None:
        self.structured = StructuredError.from_code(code, context, cause)
        super().__init__(self.structured.message)

    @property
    def code(self) -> str:
        """Error code."""
        return self.structured.code

    @property
    def category(self) -> ErrorCategory:
        """Error category."""
        return self.structured.category

    @property
    def severity(self) -> ErrorSeverity:
        """Error severity."""
        return self.structured.severity

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return self.structured.to_dict()


class OrderError(QuantLabError):
    """Order-related errors."""

    pass


class RiskError(QuantLabError):
    """Risk-related errors."""

    pass


class ConnectionError(QuantLabError):
    """Connection-related errors."""

    pass


class BrokerError(QuantLabError):
    """Broker-related errors."""

    pass


class DataError(QuantLabError):
    """Data-related errors."""

    pass


class ConfigurationError(QuantLabError):
    """Configuration-related errors."""

    pass


class AuthenticationError(QuantLabError):
    """Authentication-related errors."""

    pass


class InternalError(QuantLabError):
    """Internal errors."""

    pass


class ValidationError(QuantLabError):
    """Validation errors."""

    pass
