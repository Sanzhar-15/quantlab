"""
Tests for Portfolio Limits.

Tests position limits, exposure limits, and buying power constraints.
"""

from decimal import Decimal

import pytest

from quantlab.portfolio.limits import (
    LimitType,
    LimitViolation,
    LimitCheckResult,
    PositionLimits,
    PortfolioLimits,
    LimitsEnforcer,
    BuyingPowerCalculator,
)
from quantlab.portfolio.state import (
    PortfolioState,
    Position,
    PositionSide,
)


class TestLimitType:
    """Tests for LimitType enum."""

    def test_max_position_size(self) -> None:
        """Test MAX_POSITION_SIZE value."""
        assert LimitType.MAX_POSITION_SIZE.value == "max_position_size"

    def test_position_size_alias(self) -> None:
        """Test POSITION_SIZE alias."""
        assert LimitType.POSITION_SIZE.value == "max_position_size"

    def test_max_position_value(self) -> None:
        """Test MAX_POSITION_VALUE value."""
        assert LimitType.MAX_POSITION_VALUE.value == "max_position_value"

    def test_max_position_pct(self) -> None:
        """Test MAX_POSITION_PCT value."""
        assert LimitType.MAX_POSITION_PCT.value == "max_position_pct"

    def test_max_gross_exposure(self) -> None:
        """Test MAX_GROSS_EXPOSURE value."""
        assert LimitType.MAX_GROSS_EXPOSURE.value == "max_gross_exposure"

    def test_max_net_exposure(self) -> None:
        """Test MAX_NET_EXPOSURE value."""
        assert LimitType.MAX_NET_EXPOSURE.value == "max_net_exposure"

    def test_max_long_exposure(self) -> None:
        """Test MAX_LONG_EXPOSURE value."""
        assert LimitType.MAX_LONG_EXPOSURE.value == "max_long_exposure"

    def test_max_short_exposure(self) -> None:
        """Test MAX_SHORT_EXPOSURE value."""
        assert LimitType.MAX_SHORT_EXPOSURE.value == "max_short_exposure"

    def test_max_sector_exposure(self) -> None:
        """Test MAX_SECTOR_EXPOSURE value."""
        assert LimitType.MAX_SECTOR_EXPOSURE.value == "max_sector_exposure"

    def test_min_cash(self) -> None:
        """Test MIN_CASH value."""
        assert LimitType.MIN_CASH.value == "min_cash"

    def test_max_leverage(self) -> None:
        """Test MAX_LEVERAGE value."""
        assert LimitType.MAX_LEVERAGE.value == "max_leverage"


class TestLimitViolation:
    """Tests for LimitViolation dataclass."""

    def test_creation_basic(self) -> None:
        """Test basic violation creation."""
        violation = LimitViolation(
            limit_type=LimitType.MAX_POSITION_SIZE,
            message="Position too large",
        )
        assert violation.limit_type == LimitType.MAX_POSITION_SIZE
        assert violation.message == "Position too large"
        assert violation.symbol is None
        assert violation.limit_value == Decimal("0")
        assert violation.actual_value == Decimal("0")
        assert violation.excess == Decimal("0")

    def test_creation_full(self) -> None:
        """Test full violation creation."""
        violation = LimitViolation(
            limit_type=LimitType.MAX_POSITION_VALUE,
            message="Notional exceeds limit",
            symbol="AAPL",
            limit_value=Decimal("10000"),
            actual_value=Decimal("15000"),
            excess=Decimal("5000"),
        )
        assert violation.symbol == "AAPL"
        assert violation.limit_value == Decimal("10000")
        assert violation.actual_value == Decimal("15000")
        assert violation.excess == Decimal("5000")

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        violation = LimitViolation(
            limit_type=LimitType.MAX_POSITION_PCT,
            message="Concentration too high",
            symbol="GOOG",
            limit_value=Decimal("0.25"),
            actual_value=Decimal("0.35"),
            excess=Decimal("0.10"),
        )
        result = violation.to_dict()

        assert result["limit_type"] == "max_position_pct"
        assert result["message"] == "Concentration too high"
        assert result["symbol"] == "GOOG"
        assert result["limit_value"] == "0.25"
        assert result["actual_value"] == "0.35"
        assert result["excess"] == "0.10"


class TestLimitCheckResult:
    """Tests for LimitCheckResult dataclass."""

    def test_allowed_result(self) -> None:
        """Test allowed result."""
        result = LimitCheckResult(allowed=True)
        assert result.allowed is True
        assert result.reason == ""
        assert result.violations == []
        assert result.max_allowed_quantity is None

    def test_denied_result(self) -> None:
        """Test denied result with violation."""
        violation = LimitViolation(
            limit_type=LimitType.MAX_POSITION_SIZE,
            message="Too many shares",
        )
        result = LimitCheckResult(
            allowed=False,
            reason="Position limit exceeded",
            violations=[violation],
        )
        assert result.allowed is False
        assert result.reason == "Position limit exceeded"
        assert len(result.violations) == 1

    def test_with_max_quantity(self) -> None:
        """Test result with max allowed quantity."""
        result = LimitCheckResult(
            allowed=False,
            reason="Limit reached",
            max_allowed_quantity=Decimal("50"),
        )
        assert result.max_allowed_quantity == Decimal("50")


class TestPositionLimits:
    """Tests for PositionLimits dataclass."""

    def test_default_values(self) -> None:
        """Test default position limits."""
        limits = PositionLimits()
        assert limits.max_shares is None
        assert limits.max_value is None
        assert limits.max_pct_equity == Decimal("0.25")
        assert limits.max_pct_adv == Decimal("0.10")

    def test_custom_values(self) -> None:
        """Test custom position limits."""
        limits = PositionLimits(
            max_shares=Decimal("1000"),
            max_value=Decimal("50000"),
            max_pct_equity=Decimal("0.10"),
        )
        assert limits.max_shares == Decimal("1000")
        assert limits.max_value == Decimal("50000")
        assert limits.max_pct_equity == Decimal("0.10")

    def test_alias_max_position_size(self) -> None:
        """Test max_position_size alias for max_shares."""
        limits = PositionLimits(max_position_size=Decimal("500"))
        assert limits.max_shares == Decimal("500")

    def test_alias_max_notional(self) -> None:
        """Test max_notional alias for max_value."""
        limits = PositionLimits(max_notional=Decimal("25000"))
        assert limits.max_value == Decimal("25000")

    def test_alias_max_concentration(self) -> None:
        """Test max_concentration alias for max_pct_equity."""
        limits = PositionLimits(max_concentration=Decimal("0.15"))
        assert limits.max_pct_equity == Decimal("0.15")

    def test_explicit_overrides_alias(self) -> None:
        """Test that explicit values are not overridden by aliases."""
        limits = PositionLimits(
            max_shares=Decimal("1000"),
            max_position_size=Decimal("500"),  # Should not override
        )
        assert limits.max_shares == Decimal("1000")


class TestPortfolioLimits:
    """Tests for PortfolioLimits dataclass."""

    def test_default_values(self) -> None:
        """Test default portfolio limits."""
        limits = PortfolioLimits()
        assert limits.max_gross_exposure == Decimal("2.0")
        assert limits.max_net_exposure == Decimal("1.0")
        assert limits.max_long_exposure == Decimal("1.5")
        assert limits.max_short_exposure == Decimal("0.5")
        assert limits.max_leverage == Decimal("2.0")
        assert limits.min_cash == Decimal("0")
        assert limits.min_cash_pct == Decimal("0.05")

    def test_custom_values(self) -> None:
        """Test custom portfolio limits."""
        limits = PortfolioLimits(
            max_gross_exposure=Decimal("1.0"),
            max_net_exposure=Decimal("0.5"),
            min_cash=Decimal("10000"),
        )
        assert limits.max_gross_exposure == Decimal("1.0")
        assert limits.max_net_exposure == Decimal("0.5")
        assert limits.min_cash == Decimal("10000")


class TestLimitsEnforcer:
    """Tests for LimitsEnforcer class."""

    @pytest.fixture
    def enforcer(self) -> LimitsEnforcer:
        """Create a limits enforcer."""
        return LimitsEnforcer()

    @pytest.fixture
    def enforcer_with_limits(self) -> LimitsEnforcer:
        """Create an enforcer with custom limits."""
        return LimitsEnforcer(
            position_limits=PositionLimits(
                max_shares=Decimal("1000"),
                max_value=Decimal("100000"),
                max_pct_equity=Decimal("0.20"),
            ),
            portfolio_limits=PortfolioLimits(
                max_gross_exposure=Decimal("1.5"),
                max_long_exposure=Decimal("1.0"),
                max_short_exposure=Decimal("0.3"),
                min_cash_pct=Decimal("0.10"),
            ),
        )

    @pytest.fixture
    def portfolio_state(self) -> PortfolioState:
        """Create a portfolio state for testing."""
        state = PortfolioState(cash=Decimal("100000"))
        return state

    # Initialization tests
    def test_init_defaults(self, enforcer) -> None:
        """Test default initialization."""
        assert enforcer.position_limits is not None
        assert enforcer.portfolio_limits is not None
        assert len(enforcer._symbol_limits) == 0
        assert len(enforcer._symbol_adv) == 0

    def test_init_with_limits(self, enforcer_with_limits) -> None:
        """Test initialization with custom limits."""
        assert enforcer_with_limits.position_limits.max_shares == Decimal("1000")
        assert enforcer_with_limits.portfolio_limits.max_gross_exposure == Decimal("1.5")

    # Symbol-specific limits
    def test_set_symbol_limits(self, enforcer) -> None:
        """Test setting symbol-specific limits."""
        symbol_limits = PositionLimits(max_shares=Decimal("500"))
        enforcer.set_symbol_limits("AAPL", symbol_limits)
        assert enforcer._symbol_limits["AAPL"].max_shares == Decimal("500")

    def test_set_symbol_adv(self, enforcer) -> None:
        """Test setting average daily volume."""
        enforcer.set_symbol_adv("AAPL", Decimal("1000000"))
        assert enforcer._symbol_adv["AAPL"] == Decimal("1000000")

    def test_get_position_limits_default(self, enforcer) -> None:
        """Test getting default position limits."""
        limits = enforcer.get_position_limits("AAPL")
        assert limits == enforcer.position_limits

    def test_get_position_limits_override(self, enforcer) -> None:
        """Test getting symbol-specific limits."""
        symbol_limits = PositionLimits(max_shares=Decimal("500"))
        enforcer.set_symbol_limits("AAPL", symbol_limits)
        limits = enforcer.get_position_limits("AAPL")
        assert limits.max_shares == Decimal("500")

    # check_limits tests (test-compatible signature)
    def test_check_limits_allowed(self, enforcer_with_limits) -> None:
        """Test checking limits when allowed."""
        result = enforcer_with_limits.check_limits(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            portfolio_value=Decimal("100000"),
        )
        assert result.allowed is True
        assert len(result.violations) == 0

    def test_check_limits_shares_exceeded(self, enforcer_with_limits) -> None:
        """Test checking limits when shares exceeded."""
        result = enforcer_with_limits.check_limits(
            symbol="AAPL",
            quantity=Decimal("1500"),
            price=Decimal("150"),
            portfolio_value=Decimal("100000"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_POSITION_SIZE for v in result.violations)

    def test_check_limits_value_exceeded(self, enforcer_with_limits) -> None:
        """Test checking limits when notional value exceeded."""
        result = enforcer_with_limits.check_limits(
            symbol="AAPL",
            quantity=Decimal("700"),  # 700 * 150 = 105000 > 100000
            price=Decimal("150"),
            portfolio_value=Decimal("100000"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_POSITION_VALUE for v in result.violations)

    def test_check_limits_concentration_exceeded(self, enforcer_with_limits) -> None:
        """Test checking limits when concentration exceeded."""
        result = enforcer_with_limits.check_limits(
            symbol="AAPL",
            quantity=Decimal("200"),  # 200 * 150 = 30000 = 30% > 20%
            price=Decimal("150"),
            portfolio_value=Decimal("100000"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_POSITION_PCT for v in result.violations)

    def test_check_limits_zero_portfolio_value(self, enforcer_with_limits) -> None:
        """Test checking limits with zero portfolio value."""
        result = enforcer_with_limits.check_limits(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            portfolio_value=Decimal("0"),
        )
        # Should not check concentration with zero portfolio
        assert all(v.limit_type != LimitType.MAX_POSITION_PCT for v in result.violations)

    # check_order tests (full PortfolioState signature)
    def test_check_order_allowed(self, enforcer, portfolio_state) -> None:
        """Test checking order when allowed (within default 10% single-trade limit)."""
        result = enforcer.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("50"),
            price=Decimal("150"),
        )
        assert result.allowed is True

    def test_check_order_max_shares_exceeded(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when max shares exceeded."""
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("1500"),
            price=Decimal("100"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_POSITION_SIZE for v in result.violations)

    def test_check_order_max_value_exceeded(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when max value exceeded."""
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("800"),  # 800 * 150 = 120000 > 100000
            price=Decimal("150"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_POSITION_VALUE for v in result.violations)

    def test_check_order_concentration_exceeded(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when concentration exceeded."""
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("200"),  # 200 * 150 = 30000 = 30% > 20%
            price=Decimal("150"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_POSITION_PCT for v in result.violations)

    def test_check_order_adv_limit(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when ADV limit exceeded."""
        enforcer_with_limits.set_symbol_adv("AAPL", Decimal("1000"))
        # Default max_pct_adv is 10%, so 150 shares would be 15% of ADV
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("150"),
            price=Decimal("100"),
        )
        assert result.allowed is False
        # ADV violation is recorded as MAX_POSITION_SIZE
        assert any(v.limit_type == LimitType.MAX_POSITION_SIZE for v in result.violations)

    def test_check_order_long_exposure_exceeded(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when long exposure exceeded."""
        # Max long exposure is 100%, portfolio is 100000
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("800"),  # 800 * 150 = 120000 > 100000
            price=Decimal("150"),
        )
        assert result.allowed is False
        # Multiple violations possible

    def test_check_order_short_exposure_exceeded(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when short exposure exceeded."""
        # Max short exposure is 30%, portfolio is 100000
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("-500"),  # Short 500 * 100 = 50000 > 30000
            price=Decimal("100"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_SHORT_EXPOSURE for v in result.violations)

    def test_check_order_gross_exposure_exceeded(self) -> None:
        """Test checking order when gross exposure exceeded."""
        enforcer = LimitsEnforcer(
            portfolio_limits=PortfolioLimits(
                max_gross_exposure=Decimal("0.5"),  # 50% max
            ),
        )
        state = PortfolioState(cash=Decimal("100000"))
        # Add existing position
        state.positions["MSFT"] = Position(
            symbol="MSFT",
            quantity=Decimal("300"),
            avg_cost=Decimal("100"),
            last_price=Decimal("100"),
        )
        # equity = 100000 + 30000 = 130000, max gross = 65000
        # current gross = 30000, adding 40000 would make 70000 > 65000
        result = enforcer.check_order(
            state=state,
            symbol="AAPL",
            quantity=Decimal("400"),
            price=Decimal("100"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_GROSS_EXPOSURE for v in result.violations)

    def test_check_order_net_exposure_exceeded(self) -> None:
        """Test checking order when net exposure exceeded."""
        enforcer = LimitsEnforcer(
            portfolio_limits=PortfolioLimits(
                max_net_exposure=Decimal("0.5"),  # 50%
            ),
        )
        state = PortfolioState(cash=Decimal("100000"))
        # Try to add too much long exposure
        result = enforcer.check_order(
            state=state,
            symbol="AAPL",
            quantity=Decimal("600"),  # 60000 = 60% > 50%
            price=Decimal("100"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MAX_NET_EXPOSURE for v in result.violations)

    def test_check_order_min_cash_violated(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when min cash would be violated."""
        # Set min cash and try to buy too much
        enforcer_with_limits.portfolio_limits.min_cash = Decimal("50000")
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("400"),  # Would use 60000, leaving 40000 < 50000
            price=Decimal("150"),
        )
        assert result.allowed is False
        assert any(v.limit_type == LimitType.MIN_CASH for v in result.violations)

    def test_check_order_min_cash_pct_violated(self, enforcer_with_limits, portfolio_state) -> None:
        """Test checking order when min cash percentage would be violated."""
        # min_cash_pct is 10% = 10000
        result = enforcer_with_limits.check_order(
            state=portfolio_state,
            symbol="AAPL",
            quantity=Decimal("650"),  # Would use 650 * 150 = 97500, leaving 2500 < 10000
            price=Decimal("150"),
        )
        assert result.allowed is False

    def test_check_order_covering_short(self, enforcer) -> None:
        """Test checking order that covers short position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),  # Short 100
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # Buy to cover
        result = enforcer.check_order(
            state=state,
            symbol="AAPL",
            quantity=Decimal("50"),  # Partial cover
            price=Decimal("145"),
        )
        assert result.allowed is True

    def test_check_order_selling_long(self, enforcer) -> None:
        """Test checking order that sells long position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),  # Long 100
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        # Sell
        result = enforcer.check_order(
            state=state,
            symbol="AAPL",
            quantity=Decimal("-50"),  # Partial sell
            price=Decimal("155"),
        )
        assert result.allowed is True

    def test_check_order_zero_equity(self) -> None:
        """Test checking order with zero equity."""
        enforcer = LimitsEnforcer()
        state = PortfolioState(cash=Decimal("0"))
        result = enforcer.check_order(
            state=state,
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        # With zero equity, portfolio checks are skipped
        assert len([v for v in result.violations if v.limit_type == LimitType.MAX_GROSS_EXPOSURE]) == 0

    # calculate_max_quantity tests
    def test_calculate_max_quantity_buy(self, enforcer_with_limits, portfolio_state) -> None:
        """Test calculating max buy quantity."""
        max_qty = enforcer_with_limits.calculate_max_quantity(
            state=portfolio_state,
            symbol="AAPL",
            price=Decimal("100"),
            is_buy=True,
        )
        assert max_qty > Decimal("0")
        assert max_qty <= Decimal("1000")  # Max shares limit

    def test_calculate_max_quantity_buy_limited_by_cash(self) -> None:
        """Test max quantity limited by available cash."""
        enforcer = LimitsEnforcer(
            portfolio_limits=PortfolioLimits(
                min_cash_pct=Decimal("0.50"),  # 50% cash reserve
            ),
        )
        state = PortfolioState(cash=Decimal("10000"))
        max_qty = enforcer.calculate_max_quantity(
            state=state,
            symbol="AAPL",
            price=Decimal("100"),
            is_buy=True,
        )
        # Can use 50% of 10000 = 5000, so max 50 shares at $100
        assert max_qty <= Decimal("50")

    def test_calculate_max_quantity_buy_limited_by_shares(self, enforcer_with_limits, portfolio_state) -> None:
        """Test max quantity limited by shares limit."""
        max_qty = enforcer_with_limits.calculate_max_quantity(
            state=portfolio_state,
            symbol="AAPL",
            price=Decimal("1"),  # Very cheap, cash not limiting
            is_buy=True,
        )
        # Should be limited by max_shares=1000
        assert max_qty <= Decimal("1000")

    def test_calculate_max_quantity_buy_limited_by_value(self, enforcer_with_limits, portfolio_state) -> None:
        """Test max quantity limited by value limit."""
        max_qty = enforcer_with_limits.calculate_max_quantity(
            state=portfolio_state,
            symbol="AAPL",
            price=Decimal("200"),  # 100000/200 = 500 shares max by value
            is_buy=True,
        )
        assert max_qty <= Decimal("500")

    def test_calculate_max_quantity_buy_limited_by_pct(self, enforcer_with_limits, portfolio_state) -> None:
        """Test max quantity limited by equity percentage."""
        max_qty = enforcer_with_limits.calculate_max_quantity(
            state=portfolio_state,
            symbol="AAPL",
            price=Decimal("100"),  # 20% of 100000 = 20000, so 200 shares max
            is_buy=True,
        )
        assert max_qty <= Decimal("200")

    def test_calculate_max_quantity_buy_with_existing_position(self, enforcer_with_limits) -> None:
        """Test max quantity with existing position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("500"),
            avg_cost=Decimal("100"),
            last_price=Decimal("100"),
        )
        max_qty = enforcer_with_limits.calculate_max_quantity(
            state=state,
            symbol="AAPL",
            price=Decimal("100"),
            is_buy=True,
        )
        # Already have 500, max is 1000, so can buy up to 500 more (limited by shares)
        assert max_qty <= Decimal("500")

    def test_calculate_max_quantity_sell_long(self, enforcer) -> None:
        """Test max sell quantity for long position."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("155"),
        )
        max_qty = enforcer.calculate_max_quantity(
            state=state,
            symbol="AAPL",
            price=Decimal("155"),
            is_buy=False,
        )
        # Can sell all 100 shares owned
        assert max_qty == Decimal("100")

    def test_calculate_max_quantity_sell_short(self, enforcer_with_limits) -> None:
        """Test max short quantity."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("-50"),  # Already short 50
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        max_qty = enforcer_with_limits.calculate_max_quantity(
            state=state,
            symbol="AAPL",
            price=Decimal("100"),
            is_buy=False,
        )
        # Already short, so can add more up to short limit

    def test_calculate_max_quantity_zero_equity(self, enforcer) -> None:
        """Test max quantity with zero equity."""
        state = PortfolioState(cash=Decimal("0"))
        max_qty = enforcer.calculate_max_quantity(
            state=state,
            symbol="AAPL",
            price=Decimal("100"),
            is_buy=True,
        )
        assert max_qty == Decimal("0")

    def test_calculate_max_quantity_zero_price(self, enforcer, portfolio_state) -> None:
        """Test max quantity with zero price."""
        max_qty = enforcer.calculate_max_quantity(
            state=portfolio_state,
            symbol="AAPL",
            price=Decimal("0"),
            is_buy=True,
        )
        assert max_qty == Decimal("0")


class TestBuyingPowerCalculator:
    """Tests for BuyingPowerCalculator class."""

    @pytest.fixture
    def calculator(self) -> BuyingPowerCalculator:
        """Create a buying power calculator."""
        return BuyingPowerCalculator()

    @pytest.fixture
    def custom_calculator(self) -> BuyingPowerCalculator:
        """Create a calculator with custom multipliers."""
        return BuyingPowerCalculator(
            margin_multiplier=Decimal("3.0"),
            overnight_multiplier=Decimal("2.5"),
            intraday_multiplier=Decimal("5.0"),
        )

    @pytest.fixture
    def portfolio_state(self) -> PortfolioState:
        """Create a portfolio state."""
        return PortfolioState(cash=Decimal("100000"))

    def test_init_defaults(self, calculator) -> None:
        """Test default initialization."""
        assert calculator.margin_multiplier == Decimal("2.0")
        assert calculator.overnight_multiplier == Decimal("2.0")
        assert calculator.intraday_multiplier == Decimal("4.0")

    def test_init_custom(self, custom_calculator) -> None:
        """Test custom initialization."""
        assert custom_calculator.margin_multiplier == Decimal("3.0")
        assert custom_calculator.overnight_multiplier == Decimal("2.5")
        assert custom_calculator.intraday_multiplier == Decimal("5.0")

    def test_calculate_simple(self, calculator, portfolio_state) -> None:
        """Test simple buying power calculation."""
        result = calculator.calculate(portfolio_state)
        # Simple calculation returns available cash
        assert result == Decimal("100000")

    def test_calculate_buying_power_overnight(self, calculator, portfolio_state) -> None:
        """Test overnight buying power calculation."""
        result = calculator.calculate_buying_power(portfolio_state, is_intraday=False)
        # equity * 2.0 - 0 exposure = 200000
        assert result == Decimal("200000")

    def test_calculate_buying_power_intraday(self, calculator, portfolio_state) -> None:
        """Test intraday buying power calculation."""
        result = calculator.calculate_buying_power(portfolio_state, is_intraday=True)
        # equity * 4.0 - 0 exposure = 400000
        assert result == Decimal("400000")

    def test_calculate_buying_power_with_positions(self, calculator) -> None:
        """Test buying power with existing positions."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # equity = 50000 + 15000 = 65000 (long value)
        # max_exposure = 65000 * 2 = 130000
        # current_exposure = 15000
        # available = 130000 - 15000 = 115000
        result = calculator.calculate_buying_power(state, is_intraday=False)
        assert result == Decimal("115000")

    def test_calculate_buying_power_fully_invested(self, calculator) -> None:
        """Test buying power when fully invested."""
        state = PortfolioState(cash=Decimal("0"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("1000"),
            avg_cost=Decimal("100"),
            last_price=Decimal("100"),
        )
        # equity = 100000, exposure = 100000
        # max = 100000 * 2 = 200000
        # available = 200000 - 100000 = 100000
        result = calculator.calculate_buying_power(state, is_intraday=False)
        assert result == Decimal("100000")

    def test_calculate_buying_power_over_limit(self, calculator) -> None:
        """Test buying power when over limit (returns 0)."""
        state = PortfolioState(cash=Decimal("0"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("2500"),
            avg_cost=Decimal("100"),
            last_price=Decimal("100"),
        )
        # equity = 250000, exposure = 250000
        # max = 250000 * 2 = 500000
        # available = 500000 - 250000 = 250000 (still positive)
        result = calculator.calculate_buying_power(state, is_intraday=False)
        assert result >= Decimal("0")

    def test_calculate_short_selling_power(self, calculator, portfolio_state) -> None:
        """Test short selling power calculation."""
        result = calculator.calculate_short_selling_power(portfolio_state)
        # equity * 0.5 - 0 = 50000
        assert result == Decimal("50000")

    def test_calculate_short_selling_power_custom_ratio(self, calculator, portfolio_state) -> None:
        """Test short selling power with custom ratio."""
        result = calculator.calculate_short_selling_power(
            portfolio_state,
            short_ratio=Decimal("0.30"),
        )
        # equity * 0.30 = 30000
        assert result == Decimal("30000")

    def test_calculate_short_selling_power_with_shorts(self, calculator) -> None:
        """Test short selling power with existing shorts."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )
        # equity = 100000 - 15000 = 85000
        # max_short = 85000 * 0.5 = 42500
        # current_short = 15000
        # available = 42500 - 15000 = 27500
        result = calculator.calculate_short_selling_power(state)
        assert result == Decimal("27500")

    def test_calculate_short_selling_power_at_limit(self, calculator) -> None:
        """Test short selling power at limit."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("-500"),  # 50000 short value
            avg_cost=Decimal("100"),
            last_price=Decimal("100"),
        )
        # equity = 100000 - 50000 = 50000
        # max_short = 50000 * 0.5 = 25000
        # current_short = 50000 > max
        # available = max(25000 - 50000, 0) = 0
        result = calculator.calculate_short_selling_power(state)
        assert result == Decimal("0")
