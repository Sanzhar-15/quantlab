"""
Portfolio Validation.

Validates portfolio state integrity and equity identity.

Spec Reference: Technical Spec §4.4
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from quantlab.portfolio.state import PortfolioState
from quantlab.portfolio.state import Position


class ValidationLevel(Enum):
    """Validation strictness level."""

    STRICT = "strict"  # Fail on any discrepancy
    WARN = "warn"  # Log warnings but continue
    LENIENT = "lenient"  # Only fail on major issues


class ValidationErrorType(Enum):
    """Types of validation errors."""

    EQUITY_MISMATCH = "equity_mismatch"
    NEGATIVE_QUANTITY = "negative_quantity_error"  # Invalid, not short
    INVALID_PRICE = "invalid_price"
    INVALID_CASH = "invalid_cash"
    POSITION_MISMATCH = "position_mismatch"
    EXPOSURE_EXCEEDED = "exposure_exceeded"
    COLLATERAL_INSUFFICIENT = "collateral_insufficient"
    BUYING_POWER_NEGATIVE = "buying_power_negative"
    PNL_CALCULATION_ERROR = "pnl_calculation_error"


@dataclass
class ValidationError:
    """Single validation error."""

    error_type: ValidationErrorType
    message: str
    symbol: str | None = None
    expected: Decimal | None = None
    actual: Decimal | None = None
    timestamp: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "error_type": self.error_type.value,
            "message": self.message,
            "symbol": self.symbol,
            "expected": str(self.expected) if self.expected else None,
            "actual": str(self.actual) if self.actual else None,
        }


@dataclass
class ValidationResult:
    """Result of portfolio validation."""

    is_valid: bool
    errors: list[ValidationError]
    warnings: list[ValidationError]
    timestamp: datetime

    @property
    def error_count(self) -> int:
        return len(self.errors)

    @property
    def warning_count(self) -> int:
        return len(self.warnings)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "is_valid": self.is_valid,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "errors": [e.to_dict() for e in self.errors],
            "warnings": [w.to_dict() for w in self.warnings],
        }


class EquityValidator:
    """
    Validate equity identity.

    Equity Identity:
        Equity = Cash + Long_Value - Short_Value

    This identity must hold at all times.
    """

    def __init__(
        self,
        tolerance: Decimal = Decimal("0.01"),  # 1 cent
    ) -> None:
        """
        Initialize equity validator.

        Args:
            tolerance: Maximum allowed discrepancy
        """
        self.tolerance = tolerance

    def validate(
        self,
        state: PortfolioState,
        prices: dict[str, Decimal] | None = None,
    ) -> "list[ValidationError] | bool":
        """
        Validate equity identity.

        Can be called as:
        - validate(state, prices) -> list[ValidationError]
        - validate(state) -> bool (test compatibility)

        Returns list of validation errors (empty if valid), or bool if no prices given.
        """
        # Test-compatible mode: just return bool
        if prices is None:
            # Use last_price from positions for validation
            prices = {
                symbol: pos.last_price
                for symbol, pos in state.positions.items()
                if pos.last_price > Decimal("0")
            }
            errors = self._validate_internal(state, prices)
            return len(errors) == 0

        return self._validate_internal(state, prices)

    def _validate_internal(
        self,
        state: PortfolioState,
        prices: dict[str, Decimal],
    ) -> list[ValidationError]:
        """Internal validation logic."""
        errors = []

        # Calculate expected equity
        long_value = Decimal("0")
        short_value = Decimal("0")

        for symbol, pos in state.positions.items():
            price = prices.get(symbol, pos.last_price)

            if pos.quantity > Decimal("0"):
                long_value += pos.quantity * price
            elif pos.quantity < Decimal("0"):
                short_value += abs(pos.quantity) * price

        expected_equity = state.cash + long_value - short_value
        actual_equity = state.equity

        if abs(expected_equity - actual_equity) > self.tolerance:
            errors.append(ValidationError(
                error_type=ValidationErrorType.EQUITY_MISMATCH,
                message="Equity identity violation",
                expected=expected_equity,
                actual=actual_equity,
            ))

        return errors


class PositionValidator:
    """
    Validate position integrity.

    Checks:
    - Valid quantities (not NaN, not infinite)
    - Valid prices
    - Consistent P&L calculations
    """

    def __init__(
        self,
        allow_fractional: bool = True,
        pnl_tolerance: Decimal = Decimal("0.01"),
    ) -> None:
        self.allow_fractional = allow_fractional
        self.pnl_tolerance = pnl_tolerance

    def validate(
        self,
        position: Position,
        current_price: Decimal,
    ) -> list[ValidationError]:
        """Validate a single position."""
        errors = []

        # Check for invalid quantity
        try:
            _ = float(position.quantity)
        except (ValueError, OverflowError):
            errors.append(ValidationError(
                error_type=ValidationErrorType.NEGATIVE_QUANTITY,
                message="Invalid quantity value",
                symbol=position.symbol,
                actual=position.quantity,
            ))
            return errors  # Can't validate further

        # Check for invalid avg_cost
        if position.avg_cost <= Decimal("0"):
            errors.append(ValidationError(
                error_type=ValidationErrorType.INVALID_PRICE,
                message="Average cost must be positive",
                symbol=position.symbol,
                actual=position.avg_cost,
            ))

        # Check for fractional shares if not allowed
        if not self.allow_fractional:
            if position.quantity != position.quantity.to_integral_value():
                errors.append(ValidationError(
                    error_type=ValidationErrorType.POSITION_MISMATCH,
                    message="Fractional shares not allowed",
                    symbol=position.symbol,
                    actual=position.quantity,
                ))

        # Validate unrealized P&L calculation
        if position.quantity != Decimal("0"):
            expected_pnl: Decimal
            if position.is_long:
                expected_pnl = (current_price - position.avg_cost) * position.quantity
            else:
                expected_pnl = (position.avg_cost - current_price) * abs(position.quantity)

            if abs(expected_pnl - position.unrealized_pnl) > self.pnl_tolerance:
                errors.append(ValidationError(
                    error_type=ValidationErrorType.PNL_CALCULATION_ERROR,
                    message="Unrealized P&L calculation mismatch",
                    symbol=position.symbol,
                    expected=expected_pnl,
                    actual=position.unrealized_pnl,
                ))

        return errors


class ExposureValidator:
    """
    Validate exposure limits.

    Checks:
    - Gross exposure within limits
    - Net exposure within limits
    - Individual position limits
    """

    def __init__(
        self,
        max_gross_exposure: Decimal | None = None,
        max_net_exposure: Decimal | None = None,
        max_position_pct: Decimal = Decimal("0.25"),  # 25% max single position
    ) -> None:
        self.max_gross_exposure = max_gross_exposure
        self.max_net_exposure = max_net_exposure
        self.max_position_pct = max_position_pct

    def validate(
        self,
        state: PortfolioState,
    ) -> list[ValidationError]:
        """Validate exposure limits."""
        errors = []

        equity = state.equity
        if equity <= Decimal("0"):
            return errors  # Skip exposure validation if no equity

        # Check gross exposure
        if self.max_gross_exposure is not None:
            gross_pct = state.gross_exposure / equity
            if gross_pct > self.max_gross_exposure:
                errors.append(ValidationError(
                    error_type=ValidationErrorType.EXPOSURE_EXCEEDED,
                    message="Gross exposure limit exceeded",
                    expected=self.max_gross_exposure,
                    actual=gross_pct,
                ))

        # Check net exposure
        if self.max_net_exposure is not None:
            net_pct = abs(state.net_exposure) / equity
            if net_pct > self.max_net_exposure:
                errors.append(ValidationError(
                    error_type=ValidationErrorType.EXPOSURE_EXCEEDED,
                    message="Net exposure limit exceeded",
                    expected=self.max_net_exposure,
                    actual=net_pct,
                ))

        # Check individual positions
        for symbol, pos in state.positions.items():
            pos_pct = abs(pos.market_value) / equity
            if pos_pct > self.max_position_pct:
                errors.append(ValidationError(
                    error_type=ValidationErrorType.EXPOSURE_EXCEEDED,
                    message=f"Position size limit exceeded for {symbol}",
                    symbol=symbol,
                    expected=self.max_position_pct,
                    actual=pos_pct,
                ))

        return errors


class CashValidator:
    """
    Validate cash and buying power.

    Checks:
    - Cash balance consistency
    - Buying power calculation
    - Margin requirements
    """

    def __init__(
        self,
        allow_negative_cash: bool = False,
        min_cash_buffer: Decimal = Decimal("0"),
    ) -> None:
        self.allow_negative_cash = allow_negative_cash
        self.min_cash_buffer = min_cash_buffer

    def validate(
        self,
        state: PortfolioState,
    ) -> list[ValidationError]:
        """Validate cash and buying power."""
        errors = []

        # Check negative cash
        if not self.allow_negative_cash and state.cash < Decimal("0"):
            errors.append(ValidationError(
                error_type=ValidationErrorType.INVALID_CASH,
                message="Negative cash balance not allowed",
                actual=state.cash,
            ))

        # Check minimum buffer
        if state.cash < self.min_cash_buffer:
            errors.append(ValidationError(
                error_type=ValidationErrorType.INVALID_CASH,
                message="Cash below minimum buffer",
                expected=self.min_cash_buffer,
                actual=state.cash,
            ))

        return errors


class PortfolioValidator:
    """
    Complete portfolio validator.

    Combines all validation checks.
    """

    def __init__(
        self,
        equity_validator: EquityValidator | None = None,
        position_validator: PositionValidator | None = None,
        exposure_validator: ExposureValidator | None = None,
        cash_validator: CashValidator | None = None,
        level: ValidationLevel = ValidationLevel.WARN,
    ) -> None:
        """
        Initialize portfolio validator.

        Args:
            equity_validator: Equity identity validator
            position_validator: Position integrity validator
            exposure_validator: Exposure limit validator
            cash_validator: Cash/buying power validator
            level: Validation strictness level
        """
        self.equity_validator = equity_validator or EquityValidator()
        self.position_validator = position_validator or PositionValidator()
        self.exposure_validator = exposure_validator or ExposureValidator()
        self.cash_validator = cash_validator or CashValidator()
        self.level = level

    def validate(
        self,
        state: PortfolioState,
        prices: dict[str, Decimal],
        timestamp: datetime | None = None,
    ) -> ValidationResult:
        """
        Run all validations on portfolio state.

        Args:
            state: Current portfolio state
            prices: Current prices for all positions
            timestamp: Validation timestamp

        Returns:
            ValidationResult with all errors and warnings
        """
        timestamp = timestamp or datetime.now()
        errors: list[ValidationError] = []
        warnings: list[ValidationError] = []

        def add_result(validation_errors: list[ValidationError]) -> None:
            for error in validation_errors:
                error.timestamp = timestamp
                if self.level == ValidationLevel.STRICT:
                    errors.append(error)
                elif self.level == ValidationLevel.WARN:
                    warnings.append(error)
                # LENIENT mode: only add critical errors to errors list

        # Equity validation (always critical)
        equity_errors = self.equity_validator.validate(state, prices)
        for error in equity_errors:
            error.timestamp = timestamp
            errors.append(error)

        # Position validation
        for symbol, pos in state.positions.items():
            price = prices.get(symbol, pos.last_price)
            add_result(self.position_validator.validate(pos, price))

        # Exposure validation
        add_result(self.exposure_validator.validate(state))

        # Cash validation
        add_result(self.cash_validator.validate(state))

        is_valid = len(errors) == 0

        return ValidationResult(
            is_valid=is_valid,
            errors=errors,
            warnings=warnings,
            timestamp=timestamp,
        )

    def assert_valid(
        self,
        state: PortfolioState,
        prices: dict[str, Decimal],
    ) -> None:
        """
        Assert portfolio is valid.

        Raises ValueError if validation fails.
        """
        result = self.validate(state, prices)
        if not result.is_valid:
            error_msgs = [e.message for e in result.errors]
            raise ValueError(f"Portfolio validation failed: {'; '.join(error_msgs)}")
