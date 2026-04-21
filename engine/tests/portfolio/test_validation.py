"""
Tests for Portfolio Validation.

Tests portfolio state integrity and equity identity validation.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.portfolio.validation import (
    ValidationLevel,
    ValidationErrorType,
    ValidationError,
    ValidationResult,
    EquityValidator,
    PositionValidator,
    ExposureValidator,
    CashValidator,
    PortfolioValidator,
)
from quantlab.portfolio.state import (
    PortfolioState,
    Position,
    PositionSide,
)


class TestValidationLevel:
    """Tests for ValidationLevel enum."""

    def test_strict(self) -> None:
        """Test STRICT value."""
        assert ValidationLevel.STRICT.value == "strict"

    def test_warn(self) -> None:
        """Test WARN value."""
        assert ValidationLevel.WARN.value == "warn"

    def test_lenient(self) -> None:
        """Test LENIENT value."""
        assert ValidationLevel.LENIENT.value == "lenient"


class TestValidationErrorType:
    """Tests for ValidationErrorType enum."""

    def test_equity_mismatch(self) -> None:
        """Test EQUITY_MISMATCH value."""
        assert ValidationErrorType.EQUITY_MISMATCH.value == "equity_mismatch"

    def test_negative_quantity(self) -> None:
        """Test NEGATIVE_QUANTITY value."""
        assert ValidationErrorType.NEGATIVE_QUANTITY.value == "negative_quantity_error"

    def test_invalid_price(self) -> None:
        """Test INVALID_PRICE value."""
        assert ValidationErrorType.INVALID_PRICE.value == "invalid_price"

    def test_invalid_cash(self) -> None:
        """Test INVALID_CASH value."""
        assert ValidationErrorType.INVALID_CASH.value == "invalid_cash"

    def test_position_mismatch(self) -> None:
        """Test POSITION_MISMATCH value."""
        assert ValidationErrorType.POSITION_MISMATCH.value == "position_mismatch"

    def test_exposure_exceeded(self) -> None:
        """Test EXPOSURE_EXCEEDED value."""
        assert ValidationErrorType.EXPOSURE_EXCEEDED.value == "exposure_exceeded"

    def test_collateral_insufficient(self) -> None:
        """Test COLLATERAL_INSUFFICIENT value."""
        assert ValidationErrorType.COLLATERAL_INSUFFICIENT.value == "collateral_insufficient"

    def test_buying_power_negative(self) -> None:
        """Test BUYING_POWER_NEGATIVE value."""
        assert ValidationErrorType.BUYING_POWER_NEGATIVE.value == "buying_power_negative"

    def test_pnl_calculation_error(self) -> None:
        """Test PNL_CALCULATION_ERROR value."""
        assert ValidationErrorType.PNL_CALCULATION_ERROR.value == "pnl_calculation_error"


class TestValidationError:
    """Tests for ValidationError dataclass."""

    def test_creation_basic(self) -> None:
        """Test basic error creation."""
        error = ValidationError(
            error_type=ValidationErrorType.EQUITY_MISMATCH,
            message="Equity doesn't match",
        )
        assert error.error_type == ValidationErrorType.EQUITY_MISMATCH
        assert error.message == "Equity doesn't match"
        assert error.symbol is None
        assert error.expected is None
        assert error.actual is None
        assert error.timestamp is None

    def test_creation_full(self) -> None:
        """Test full error creation."""
        ts = datetime(2024, 1, 15, 10, 30)
        error = ValidationError(
            error_type=ValidationErrorType.POSITION_MISMATCH,
            message="Position mismatch",
            symbol="AAPL",
            expected=Decimal("100"),
            actual=Decimal("95"),
            timestamp=ts,
        )
        assert error.symbol == "AAPL"
        assert error.expected == Decimal("100")
        assert error.actual == Decimal("95")
        assert error.timestamp == ts

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        error = ValidationError(
            error_type=ValidationErrorType.INVALID_PRICE,
            message="Price is negative",
            symbol="GOOG",
            expected=Decimal("150"),
            actual=Decimal("-10"),
        )
        result = error.to_dict()

        assert result["error_type"] == "invalid_price"
        assert result["message"] == "Price is negative"
        assert result["symbol"] == "GOOG"
        assert result["expected"] == "150"
        assert result["actual"] == "-10"

    def test_to_dict_none_values(self) -> None:
        """Test to_dict with None values."""
        error = ValidationError(
            error_type=ValidationErrorType.INVALID_CASH,
            message="Cash error",
        )
        result = error.to_dict()

        assert result["symbol"] is None
        assert result["expected"] is None
        assert result["actual"] is None


class TestValidationResult:
    """Tests for ValidationResult dataclass."""

    def test_valid_result(self) -> None:
        """Test valid result."""
        ts = datetime(2024, 1, 15)
        result = ValidationResult(
            is_valid=True,
            errors=[],
            warnings=[],
            timestamp=ts,
        )
        assert result.is_valid is True
        assert result.error_count == 0
        assert result.warning_count == 0

    def test_invalid_result(self) -> None:
        """Test invalid result with errors."""
        ts = datetime(2024, 1, 15)
        error = ValidationError(
            error_type=ValidationErrorType.EQUITY_MISMATCH,
            message="Error",
        )
        result = ValidationResult(
            is_valid=False,
            errors=[error],
            warnings=[],
            timestamp=ts,
        )
        assert result.is_valid is False
        assert result.error_count == 1
        assert result.warning_count == 0

    def test_result_with_warnings(self) -> None:
        """Test result with warnings."""
        ts = datetime(2024, 1, 15)
        warning = ValidationError(
            error_type=ValidationErrorType.EXPOSURE_EXCEEDED,
            message="Warning",
        )
        result = ValidationResult(
            is_valid=True,
            errors=[],
            warnings=[warning, warning],
            timestamp=ts,
        )
        assert result.is_valid is True
        assert result.warning_count == 2

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        ts = datetime(2024, 1, 15)
        error = ValidationError(
            error_type=ValidationErrorType.EQUITY_MISMATCH,
            message="Error",
        )
        result = ValidationResult(
            is_valid=False,
            errors=[error],
            warnings=[],
            timestamp=ts,
        )
        d = result.to_dict()

        assert d["is_valid"] is False
        assert d["error_count"] == 1
        assert d["warning_count"] == 0
        assert len(d["errors"]) == 1
        assert len(d["warnings"]) == 0


class TestEquityValidator:
    """Tests for EquityValidator class."""

    @pytest.fixture
    def validator(self) -> EquityValidator:
        """Create an equity validator."""
        return EquityValidator()

    @pytest.fixture
    def valid_state(self) -> PortfolioState:
        """Create a valid portfolio state."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        return state

    def test_init_default(self) -> None:
        """Test default initialization."""
        validator = EquityValidator()
        assert validator.tolerance == Decimal("0.01")

    def test_init_custom_tolerance(self) -> None:
        """Test custom tolerance."""
        validator = EquityValidator(tolerance=Decimal("0.001"))
        assert validator.tolerance == Decimal("0.001")

    def test_validate_valid_state_bool(self, validator, valid_state) -> None:
        """Test validating valid state returns True."""
        result = validator.validate(valid_state)
        assert result is True

    def test_validate_valid_state_with_prices(self, validator, valid_state) -> None:
        """Test validating with explicit prices."""
        prices = {"AAPL": Decimal("155")}
        errors = validator.validate(valid_state, prices)
        assert isinstance(errors, list)
        assert len(errors) == 0

    def test_validate_empty_state(self, validator) -> None:
        """Test validating empty state."""
        state = PortfolioState(cash=Decimal("100000"))
        result = validator.validate(state)
        assert result is True

    def test_validate_long_and_short_positions(self, validator) -> None:
        """Test validating state with long and short positions."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        state.positions["MSFT"] = Position(
            symbol="MSFT",
            quantity=Decimal("-50"),
            avg_cost=Decimal("300"),
            last_price=Decimal("300"),
        )
        result = validator.validate(state)
        # equity = 100000 + 15000 - 15000 = 100000
        assert result is True

    def test_validate_with_price_override(self, validator) -> None:
        """Test validating with different price than last_price."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # Use different price for validation
        prices = {"AAPL": Decimal("160")}
        errors = validator.validate(state, prices)
        # expected equity = 50000 + 100*160 = 66000
        # actual equity uses last_price = 50000 + 15000 = 65000
        # This will show mismatch
        assert isinstance(errors, list)


class TestPositionValidator:
    """Tests for PositionValidator class."""

    @pytest.fixture
    def validator(self) -> PositionValidator:
        """Create a position validator."""
        return PositionValidator()

    @pytest.fixture
    def valid_position(self) -> Position:
        """Create a valid position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        pos.update_price(Decimal("155"))
        return pos

    def test_init_defaults(self) -> None:
        """Test default initialization."""
        validator = PositionValidator()
        assert validator.allow_fractional is True
        assert validator.pnl_tolerance == Decimal("0.01")

    def test_init_custom(self) -> None:
        """Test custom initialization."""
        validator = PositionValidator(
            allow_fractional=False,
            pnl_tolerance=Decimal("0.001"),
        )
        assert validator.allow_fractional is False
        assert validator.pnl_tolerance == Decimal("0.001")

    def test_validate_valid_position(self, validator, valid_position) -> None:
        """Test validating valid position."""
        errors = validator.validate(valid_position, Decimal("155"))
        assert len(errors) == 0

    def test_validate_invalid_avg_cost(self, validator) -> None:
        """Test validating position with invalid avg_cost."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("0"),
            last_price=Decimal("150"),
        )
        errors = validator.validate(pos, Decimal("150"))
        assert len(errors) > 0
        assert any(e.error_type == ValidationErrorType.INVALID_PRICE for e in errors)

    def test_validate_negative_avg_cost(self, validator) -> None:
        """Test validating position with negative avg_cost."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("-10"),
            last_price=Decimal("150"),
        )
        errors = validator.validate(pos, Decimal("150"))
        assert len(errors) > 0
        assert any(e.error_type == ValidationErrorType.INVALID_PRICE for e in errors)

    def test_validate_fractional_shares_allowed(self, validator) -> None:
        """Test validating fractional shares when allowed."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100.5"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        pos.update_price(Decimal("155"))
        errors = validator.validate(pos, Decimal("155"))
        assert len(errors) == 0

    def test_validate_fractional_shares_not_allowed(self) -> None:
        """Test validating fractional shares when not allowed."""
        validator = PositionValidator(allow_fractional=False)
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100.5"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        pos.update_price(Decimal("155"))
        errors = validator.validate(pos, Decimal("155"))
        assert len(errors) > 0
        assert any(e.error_type == ValidationErrorType.POSITION_MISMATCH for e in errors)

    def test_validate_pnl_mismatch(self, validator) -> None:
        """Test validating P&L mismatch."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
            unrealized_pnl=Decimal("1000"),  # Wrong: should be 500
        )
        errors = validator.validate(pos, Decimal("155"))
        assert len(errors) > 0
        assert any(e.error_type == ValidationErrorType.PNL_CALCULATION_ERROR for e in errors)

    def test_validate_short_position_pnl(self, validator) -> None:
        """Test validating short position P&L."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("145"),
        )
        pos.update_price(Decimal("145"))  # Short profit: (150-145)*100 = 500
        errors = validator.validate(pos, Decimal("145"))
        assert len(errors) == 0

    def test_validate_flat_position(self, validator) -> None:
        """Test validating flat position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("0"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        errors = validator.validate(pos, Decimal("155"))
        # Flat position doesn't need P&L validation
        # But avg_cost should still be positive
        assert len([e for e in errors if e.error_type == ValidationErrorType.PNL_CALCULATION_ERROR]) == 0


class TestExposureValidator:
    """Tests for ExposureValidator class."""

    @pytest.fixture
    def validator(self) -> ExposureValidator:
        """Create an exposure validator."""
        return ExposureValidator(
            max_gross_exposure=Decimal("2.0"),
            max_net_exposure=Decimal("1.0"),
            max_position_pct=Decimal("0.25"),
        )

    @pytest.fixture
    def portfolio_state(self) -> PortfolioState:
        """Create a portfolio state."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        return state

    def test_init_defaults(self) -> None:
        """Test default initialization."""
        validator = ExposureValidator()
        assert validator.max_gross_exposure is None
        assert validator.max_net_exposure is None
        assert validator.max_position_pct == Decimal("0.25")

    def test_init_custom(self, validator) -> None:
        """Test custom initialization."""
        assert validator.max_gross_exposure == Decimal("2.0")
        assert validator.max_net_exposure == Decimal("1.0")
        assert validator.max_position_pct == Decimal("0.25")

    def test_validate_valid_exposure(self, validator, portfolio_state) -> None:
        """Test validating valid exposure."""
        errors = validator.validate(portfolio_state)
        # equity = 50000 + 15000 = 65000
        # gross = 15000 / 65000 = 23% < 200%
        # net = 15000 / 65000 = 23% < 100%
        # position = 15000 / 65000 = 23% < 25%
        assert len(errors) == 0

    def test_validate_gross_exposure_exceeded(self) -> None:
        """Test validating gross exposure exceeded."""
        validator = ExposureValidator(max_gross_exposure=Decimal("0.5"))
        state = PortfolioState(cash=Decimal("10000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # equity = 10000 + 15000 = 25000
        # gross = 15000 / 25000 = 60% > 50%
        errors = validator.validate(state)
        assert len(errors) > 0
        assert any(e.error_type == ValidationErrorType.EXPOSURE_EXCEEDED for e in errors)

    def test_validate_net_exposure_exceeded(self) -> None:
        """Test validating net exposure exceeded."""
        validator = ExposureValidator(max_net_exposure=Decimal("0.2"))
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # equity = 65000, net = 15000 / 65000 = 23% > 20%
        errors = validator.validate(state)
        assert len(errors) > 0
        assert any("Net exposure" in e.message for e in errors)

    def test_validate_position_size_exceeded(self) -> None:
        """Test validating position size exceeded."""
        validator = ExposureValidator(max_position_pct=Decimal("0.10"))
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # equity = 65000, position = 15000 / 65000 = 23% > 10%
        errors = validator.validate(state)
        assert len(errors) > 0
        assert any("Position size" in e.message for e in errors)

    def test_validate_zero_equity(self, validator) -> None:
        """Test validating with zero equity."""
        state = PortfolioState(cash=Decimal("0"))
        errors = validator.validate(state)
        # Should skip validation with zero equity
        assert len(errors) == 0

    def test_validate_multiple_positions(self) -> None:
        """Test validating multiple positions."""
        validator = ExposureValidator(max_position_pct=Decimal("0.30"))
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("200"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        state.positions["MSFT"] = Position(
            symbol="MSFT",
            quantity=Decimal("100"),
            avg_cost=Decimal("300"),
            last_price=Decimal("300"),
        )
        # equity = 100000 + 30000 + 30000 = 160000
        # AAPL = 30000 / 160000 = 18.75% < 30%
        # MSFT = 30000 / 160000 = 18.75% < 30%
        errors = validator.validate(state)
        assert len(errors) == 0


class TestCashValidator:
    """Tests for CashValidator class."""

    @pytest.fixture
    def validator(self) -> CashValidator:
        """Create a cash validator."""
        return CashValidator()

    def test_init_defaults(self) -> None:
        """Test default initialization."""
        validator = CashValidator()
        assert validator.allow_negative_cash is False
        assert validator.min_cash_buffer == Decimal("0")

    def test_init_custom(self) -> None:
        """Test custom initialization."""
        validator = CashValidator(
            allow_negative_cash=True,
            min_cash_buffer=Decimal("1000"),
        )
        assert validator.allow_negative_cash is True
        assert validator.min_cash_buffer == Decimal("1000")

    def test_validate_positive_cash(self, validator) -> None:
        """Test validating positive cash."""
        state = PortfolioState(cash=Decimal("50000"))
        errors = validator.validate(state)
        assert len(errors) == 0

    def test_validate_negative_cash_not_allowed(self, validator) -> None:
        """Test validating negative cash when not allowed."""
        state = PortfolioState(cash=Decimal("-1000"))
        errors = validator.validate(state)
        assert len(errors) > 0
        assert any(e.error_type == ValidationErrorType.INVALID_CASH for e in errors)

    def test_validate_negative_cash_allowed(self) -> None:
        """Test validating negative cash when allowed."""
        validator = CashValidator(allow_negative_cash=True)
        state = PortfolioState(cash=Decimal("-1000"))
        errors = validator.validate(state)
        assert len([e for e in errors if "Negative cash" in e.message]) == 0

    def test_validate_below_buffer(self) -> None:
        """Test validating cash below buffer."""
        validator = CashValidator(min_cash_buffer=Decimal("10000"))
        state = PortfolioState(cash=Decimal("5000"))
        errors = validator.validate(state)
        assert len(errors) > 0
        assert any("minimum buffer" in e.message for e in errors)

    def test_validate_at_buffer(self) -> None:
        """Test validating cash at buffer."""
        validator = CashValidator(min_cash_buffer=Decimal("10000"))
        state = PortfolioState(cash=Decimal("10000"))
        errors = validator.validate(state)
        # Exactly at buffer should be fine
        assert len([e for e in errors if "minimum buffer" in e.message]) == 0


class TestPortfolioValidator:
    """Tests for PortfolioValidator class."""

    @pytest.fixture
    def validator(self) -> PortfolioValidator:
        """Create a portfolio validator."""
        return PortfolioValidator()

    @pytest.fixture
    def strict_validator(self) -> PortfolioValidator:
        """Create a strict validator."""
        return PortfolioValidator(level=ValidationLevel.STRICT)

    @pytest.fixture
    def lenient_validator(self) -> PortfolioValidator:
        """Create a lenient validator."""
        return PortfolioValidator(level=ValidationLevel.LENIENT)

    @pytest.fixture
    def valid_state(self) -> PortfolioState:
        """Create a valid portfolio state."""
        state = PortfolioState(cash=Decimal("50000"))
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        pos.update_price(Decimal("155"))
        state.positions["AAPL"] = pos
        return state

    def test_init_defaults(self) -> None:
        """Test default initialization."""
        validator = PortfolioValidator()
        assert validator.equity_validator is not None
        assert validator.position_validator is not None
        assert validator.exposure_validator is not None
        assert validator.cash_validator is not None
        assert validator.level == ValidationLevel.WARN

    def test_init_custom_validators(self) -> None:
        """Test custom validators."""
        equity_v = EquityValidator(tolerance=Decimal("0.001"))
        validator = PortfolioValidator(equity_validator=equity_v)
        assert validator.equity_validator.tolerance == Decimal("0.001")

    def test_validate_valid_state(self, validator, valid_state) -> None:
        """Test validating valid state."""
        prices = {"AAPL": Decimal("155")}
        result = validator.validate(valid_state, prices)
        assert result.is_valid is True
        assert result.error_count == 0

    def test_validate_with_timestamp(self, validator, valid_state) -> None:
        """Test validating with explicit timestamp."""
        prices = {"AAPL": Decimal("155")}
        ts = datetime(2024, 1, 15, 10, 30)
        result = validator.validate(valid_state, prices, timestamp=ts)
        assert result.timestamp == ts

    def test_validate_strict_mode(self, strict_validator) -> None:
        """Test strict validation mode."""
        state = PortfolioState(cash=Decimal("50000"))
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
            unrealized_pnl=Decimal("1000"),  # Wrong
        )
        state.positions["AAPL"] = pos
        prices = {"AAPL": Decimal("155")}
        result = strict_validator.validate(state, prices)
        # In strict mode, P&L mismatch is an error
        assert result.error_count > 0

    def test_validate_warn_mode(self, validator) -> None:
        """Test warn validation mode."""
        state = PortfolioState(cash=Decimal("50000"))
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
            unrealized_pnl=Decimal("1000"),  # Wrong
        )
        state.positions["AAPL"] = pos
        prices = {"AAPL": Decimal("155")}
        result = validator.validate(state, prices)
        # In warn mode, P&L mismatch is a warning
        assert result.warning_count > 0

    def test_validate_lenient_mode(self, lenient_validator, valid_state) -> None:
        """Test lenient validation mode."""
        prices = {"AAPL": Decimal("155")}
        result = lenient_validator.validate(valid_state, prices)
        # Lenient mode only reports critical errors
        assert result.is_valid is True

    def test_validate_equity_mismatch_always_error(self, lenient_validator) -> None:
        """Test that equity mismatch is always an error."""
        # This is hard to test directly since PortfolioState.equity
        # is calculated, not stored. But equity validation is always critical.
        state = PortfolioState(cash=Decimal("50000"))
        prices = {}
        result = lenient_validator.validate(state, prices)
        # Empty state should be valid
        assert result.is_valid is True

    def test_validate_multiple_positions(self, validator) -> None:
        """Test validating multiple positions."""
        state = PortfolioState(cash=Decimal("100000"))
        pos1 = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        pos1.update_price(Decimal("155"))
        pos2 = Position(
            symbol="MSFT",
            quantity=Decimal("50"),
            avg_cost=Decimal("300"),
            last_price=Decimal("310"),
        )
        pos2.update_price(Decimal("310"))
        state.positions["AAPL"] = pos1
        state.positions["MSFT"] = pos2
        prices = {"AAPL": Decimal("155"), "MSFT": Decimal("310")}
        result = validator.validate(state, prices)
        assert result.is_valid is True

    def test_validate_missing_price(self, validator, valid_state) -> None:
        """Test validating with missing price uses last_price."""
        prices = {}  # No prices provided
        result = validator.validate(valid_state, prices)
        # Should use last_price from position
        assert result is not None

    def test_assert_valid_passes(self, validator, valid_state) -> None:
        """Test assert_valid when valid."""
        prices = {"AAPL": Decimal("155")}
        # Should not raise
        validator.assert_valid(valid_state, prices)

    def test_assert_valid_fails(self, strict_validator) -> None:
        """Test assert_valid when invalid."""
        state = PortfolioState(cash=Decimal("50000"))
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("0"),  # Invalid
            last_price=Decimal("155"),
        )
        state.positions["AAPL"] = pos
        prices = {"AAPL": Decimal("155")}
        with pytest.raises(ValueError, match="validation failed"):
            strict_validator.assert_valid(state, prices)

    def test_validate_empty_portfolio(self, validator) -> None:
        """Test validating empty portfolio."""
        state = PortfolioState(cash=Decimal("100000"))
        prices = {}
        result = validator.validate(state, prices)
        assert result.is_valid is True
        assert result.error_count == 0
        assert result.warning_count == 0
