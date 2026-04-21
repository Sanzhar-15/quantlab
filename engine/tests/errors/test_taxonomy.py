"""
Tests for error taxonomy.
"""

import pytest

from quantlab.errors.taxonomy import (
    ErrorCategory,
    ErrorCode,
    ErrorSeverity,
    QuantLabError,
    RecoveryType,
    StructuredError,
    ERROR_CODES,
    ORD001,
    ORD002,
    RSK001,
    CON001,
    INT001,
)


class TestErrorCategory:
    """Tests for ErrorCategory enum."""

    def test_categories(self):
        """Should have expected categories."""
        assert ErrorCategory.ORDER.value == "order"
        assert ErrorCategory.RISK.value == "risk"
        assert ErrorCategory.CONNECTION.value == "connection"
        assert ErrorCategory.BROKER.value == "broker"
        assert ErrorCategory.DATA.value == "data"
        assert ErrorCategory.INTERNAL.value == "internal"
        assert ErrorCategory.CONFIGURATION.value == "configuration"
        assert ErrorCategory.AUTHENTICATION.value == "authentication"
        assert ErrorCategory.VALIDATION.value == "validation"


class TestErrorSeverity:
    """Tests for ErrorSeverity enum."""

    def test_severity_levels(self):
        """Should have expected severity levels."""
        assert ErrorSeverity.INFO.value == "info"
        assert ErrorSeverity.WARNING.value == "warning"
        assert ErrorSeverity.ERROR.value == "error"
        assert ErrorSeverity.CRITICAL.value == "critical"


class TestRecoveryType:
    """Tests for RecoveryType enum."""

    def test_recovery_types(self):
        """Should have expected recovery types."""
        assert RecoveryType.AUTOMATIC.value == "automatic"
        assert RecoveryType.USER_RETRY.value == "user_retry"
        assert RecoveryType.USER_ACTION.value == "user_action"
        assert RecoveryType.SUPPORT.value == "support"
        assert RecoveryType.FATAL.value == "fatal"


class TestErrorCodes:
    """Tests for error code registry."""

    def test_error_codes_registered(self):
        """Should have error codes in registry."""
        assert "ORD001" in ERROR_CODES
        assert "RSK001" in ERROR_CODES
        assert "CON001" in ERROR_CODES
        assert "INT001" in ERROR_CODES

    def test_ord001_definition(self):
        """ORD001 should be defined correctly."""
        assert ORD001.code == "ORD001"
        assert ORD001.category == ErrorCategory.ORDER
        assert ORD001.severity == ErrorSeverity.ERROR
        assert ORD001.recovery == RecoveryType.USER_RETRY

    def test_rsk001_is_critical(self):
        """RSK001 (circuit breaker) should be critical."""
        assert RSK001.severity == ErrorSeverity.CRITICAL

    def test_con001_automatic_recovery(self):
        """CON001 should have automatic recovery."""
        assert CON001.recovery == RecoveryType.AUTOMATIC


class TestStructuredError:
    """Tests for StructuredError class."""

    def test_from_code_string(self):
        """Should create from code string."""
        error = StructuredError.from_code(
            "ORD002",
            context={"required": "50000", "available": "10000"},
        )

        assert error.code == "ORD002"
        assert error.category == ErrorCategory.ORDER
        assert "50000" in error.message
        assert "10000" in error.message

    def test_from_code_object(self):
        """Should create from ErrorCode object."""
        error = StructuredError.from_code(
            ORD001,
            context={"reason": "Invalid symbol"},
        )

        assert error.code == "ORD001"
        assert "Invalid symbol" in error.message

    def test_unknown_code_falls_back(self):
        """Unknown code should fall back to INT001."""
        error = StructuredError.from_code("UNKNOWN123")

        assert error.code == "INT001"
        assert "UNKNOWN123" in error.message

    def test_to_dict(self):
        """Should serialize to dictionary."""
        error = StructuredError.from_code(
            "RSK001",
            context={"reason": "3 consecutive losses"},
        )

        data = error.to_dict()

        assert data["code"] == "RSK001"
        assert data["category"] == "risk"
        assert data["severity"] == "critical"
        assert data["recovery"] == "user_action"
        assert "consecutive losses" in data["message"]

    def test_is_critical(self):
        """Should identify critical errors."""
        critical = StructuredError.from_code("RSK001", {"reason": "test"})
        non_critical = StructuredError.from_code("ORD001", {"reason": "test"})

        assert critical.is_critical() is True
        assert non_critical.is_critical() is False

    def test_is_recoverable(self):
        """Should identify recoverable errors."""
        recoverable = StructuredError.from_code("CON001", {"service": "broker"})
        fatal = StructuredError.from_code("INT003", {"message": "crash"})

        assert recoverable.is_recoverable() is True
        assert fatal.is_recoverable() is False


class TestQuantLabError:
    """Tests for QuantLabError exception class."""

    def test_create_with_code_string(self):
        """Should create exception with code string."""
        error = QuantLabError(
            "ORD001",
            context={"reason": "Rejected by broker"},
        )

        assert error.code == "ORD001"
        assert error.category == ErrorCategory.ORDER
        assert "Rejected by broker" in str(error)

    def test_create_with_code_object(self):
        """Should create exception with ErrorCode object."""
        error = QuantLabError(
            ORD002,
            context={"required": "10000", "available": "5000"},
        )

        assert error.code == "ORD002"
        assert "10000" in str(error)

    def test_to_dict(self):
        """Should convert to dictionary."""
        error = QuantLabError(
            "RSK002",
            context={"current": "100000", "limit": "50000"},
        )

        data = error.to_dict()

        assert data["code"] == "RSK002"
        assert data["category"] == "risk"

    def test_exception_chaining(self):
        """Should support exception chaining."""
        original = ValueError("Invalid value")
        error = QuantLabError(
            "INT001",
            context={"message": "Processing failed"},
            cause=original,
        )

        assert error.structured.exception == original

    def test_inherits_from_exception(self):
        """Should be catchable as Exception."""
        with pytest.raises(Exception):
            raise QuantLabError("ORD001", {"reason": "test"})

    def test_severity_property(self):
        """Should expose severity."""
        error = QuantLabError("RSK001", {"reason": "test"})

        assert error.severity == ErrorSeverity.CRITICAL


class TestSpecificExceptions:
    """Tests for specific exception classes."""

    def test_order_error(self):
        """OrderError should work."""
        from quantlab.errors import OrderError

        error = OrderError("ORD001", {"reason": "test"})
        assert error.category == ErrorCategory.ORDER

    def test_risk_error(self):
        """RiskError should work."""
        from quantlab.errors import RiskError

        error = RiskError("RSK001", {"reason": "test"})
        assert error.category == ErrorCategory.RISK

    def test_connection_error(self):
        """ConnectionError should work."""
        from quantlab.errors import ConnectionError

        error = ConnectionError("CON001", {"service": "broker"})
        assert error.category == ErrorCategory.CONNECTION
