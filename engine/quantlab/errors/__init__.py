"""
Error handling module.

Provides:
- Error taxonomy with categories and severity
- Structured error format with codes
- Recoverable vs non-recoverable classification
- User action suggestions

Error Code Format: {category}{number}
    ORD - Order errors
    RSK - Risk errors
    CON - Connection errors
    BRK - Broker errors
    DAT - Data errors
    CFG - Configuration errors
    AUT - Authentication errors
    INT - Internal errors
    VAL - Validation errors

Spec Reference: Technical Spec §13.2
"""

from .taxonomy import AuthenticationError
from .taxonomy import BrokerError
from .taxonomy import ConfigurationError
from .taxonomy import ConnectionError
from .taxonomy import DataError
from .taxonomy import ErrorCategory
from .taxonomy import ErrorCode
from .taxonomy import ErrorSeverity
from .taxonomy import InternalError
from .taxonomy import OrderError
from .taxonomy import QuantLabError
from .taxonomy import RecoveryType
from .taxonomy import RiskError
from .taxonomy import StructuredError
from .taxonomy import ValidationError
from .taxonomy import ERROR_CODES
from .taxonomy import register_error

# Re-export common error codes for convenience
from .taxonomy import (
    # Order errors
    ORD001,
    ORD002,
    ORD003,
    ORD004,
    ORD005,
    ORD006,
    ORD007,
    # Risk errors
    RSK001,
    RSK002,
    RSK003,
    RSK004,
    RSK005,
    # Connection errors
    CON001,
    CON002,
    CON003,
    CON004,
    # Broker errors
    BRK001,
    BRK002,
    BRK003,
    BRK004,
    # Data errors
    DAT001,
    DAT002,
    DAT003,
    DAT004,
    # Configuration errors
    CFG001,
    CFG002,
    CFG003,
    CFG004,
    # Authentication errors
    AUT001,
    AUT002,
    AUT003,
    # Internal errors
    INT001,
    INT002,
    INT003,
    # Validation errors
    VAL001,
    VAL002,
)

__all__ = [
    # Base classes
    "QuantLabError",
    "StructuredError",
    "ErrorCode",
    # Enums
    "ErrorCategory",
    "ErrorSeverity",
    "RecoveryType",
    # Exception classes by category
    "OrderError",
    "RiskError",
    "ConnectionError",
    "BrokerError",
    "DataError",
    "ConfigurationError",
    "AuthenticationError",
    "InternalError",
    "ValidationError",
    # Registry
    "ERROR_CODES",
    "register_error",
    # Order codes
    "ORD001",
    "ORD002",
    "ORD003",
    "ORD004",
    "ORD005",
    "ORD006",
    "ORD007",
    # Risk codes
    "RSK001",
    "RSK002",
    "RSK003",
    "RSK004",
    "RSK005",
    # Connection codes
    "CON001",
    "CON002",
    "CON003",
    "CON004",
    # Broker codes
    "BRK001",
    "BRK002",
    "BRK003",
    "BRK004",
    # Data codes
    "DAT001",
    "DAT002",
    "DAT003",
    "DAT004",
    # Configuration codes
    "CFG001",
    "CFG002",
    "CFG003",
    "CFG004",
    # Authentication codes
    "AUT001",
    "AUT002",
    "AUT003",
    # Internal codes
    "INT001",
    "INT002",
    "INT003",
    # Validation codes
    "VAL001",
    "VAL002",
]
