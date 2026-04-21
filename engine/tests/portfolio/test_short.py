"""
Tests for Short Selling Model.

Tests collateral tracking, borrow fees, and short position management.
"""

from datetime import datetime
from datetime import timedelta
from decimal import Decimal

import pytest

from quantlab.portfolio.short import (
    ShortBorrow,
    ShortOpenResult,
    ShortPosition,
    ShortSellingConfig,
    ShortSellingManager,
)


class TestShortOpenResult:
    """Tests for ShortOpenResult dataclass."""

    def test_success_result(self) -> None:
        """Test successful open result."""
        result = ShortOpenResult(
            success=True,
            collateral_required=Decimal("5000"),
        )

        assert result.success is True
        assert result.error == ""
        assert result.collateral_required == Decimal("5000")
        assert result.position is None

    def test_failed_result(self) -> None:
        """Test failed open result."""
        result = ShortOpenResult(
            success=False,
            error="Insufficient collateral",
            collateral_required=Decimal("10000"),
        )

        assert result.success is False
        assert result.error == "Insufficient collateral"
        assert result.position is None

    def test_result_with_position(self) -> None:
        """Test result with position."""
        position = ShortPosition(
            symbol="AAPL",
            quantity=Decimal("100"),
            entry_price=Decimal("150"),
        )
        result = ShortOpenResult(
            success=True,
            position=position,
            collateral_required=Decimal("15000"),
        )

        assert result.position is not None
        assert result.position.symbol == "AAPL"


class TestShortPosition:
    """Tests for ShortPosition dataclass."""

    @pytest.fixture
    def position(self) -> ShortPosition:
        """Create a short position."""
        return ShortPosition(
            symbol="AAPL",
            quantity=Decimal("100"),
            entry_price=Decimal("150"),
            entry_date=datetime(2026, 1, 15),
            collateral_required=Decimal("15000"),
            current_price=Decimal("145"),
            borrow_rate=Decimal("0.02"),
        )

    def test_creation(self, position) -> None:
        """Test position creation."""
        assert position.symbol == "AAPL"
        assert position.quantity == Decimal("100")
        assert position.entry_price == Decimal("150")
        assert position.collateral_required == Decimal("15000")

    def test_market_value(self, position) -> None:
        """Test market value calculation."""
        # 100 shares * $145 = $14,500
        assert position.market_value == Decimal("14500")

    def test_market_value_zero_price(self) -> None:
        """Test market value with zero price."""
        position = ShortPosition(
            symbol="XYZ",
            quantity=Decimal("100"),
            entry_price=Decimal("50"),
            current_price=Decimal("0"),
        )
        assert position.market_value == Decimal("0")

    def test_unrealized_pnl_profit(self, position) -> None:
        """Test unrealized P&L when price dropped (profit)."""
        # Entry: $150, Current: $145
        # Profit = (150 - 145) * 100 = $500
        assert position.unrealized_pnl == Decimal("500")

    def test_unrealized_pnl_loss(self) -> None:
        """Test unrealized P&L when price rose (loss)."""
        position = ShortPosition(
            symbol="AAPL",
            quantity=Decimal("100"),
            entry_price=Decimal("150"),
            current_price=Decimal("160"),
        )
        # Loss = (150 - 160) * 100 = -$1000
        assert position.unrealized_pnl == Decimal("-1000")

    def test_unrealized_pnl_breakeven(self) -> None:
        """Test unrealized P&L at breakeven."""
        position = ShortPosition(
            symbol="AAPL",
            quantity=Decimal("100"),
            entry_price=Decimal("150"),
            current_price=Decimal("150"),
        )
        assert position.unrealized_pnl == Decimal("0")

    def test_equity_contribution(self, position) -> None:
        """Test equity contribution calculation."""
        # Collateral: $15,000
        # Market Value: $14,500
        # Unrealized P&L: $500
        # Equity = 15000 - 14500 + 500 = $1,000
        assert position.equity_contribution == Decimal("1000")

    def test_equity_contribution_loss_scenario(self) -> None:
        """Test equity contribution with loss."""
        position = ShortPosition(
            symbol="AAPL",
            quantity=Decimal("100"),
            entry_price=Decimal("150"),
            collateral_required=Decimal("15000"),
            current_price=Decimal("160"),
        )
        # Collateral: $15,000
        # Market Value: $16,000
        # Unrealized P&L: -$1000
        # Equity = 15000 - 16000 + (-1000) = -$2,000
        assert position.equity_contribution == Decimal("-2000")

    def test_to_dict(self, position) -> None:
        """Test conversion to dictionary."""
        data = position.to_dict()

        assert data["symbol"] == "AAPL"
        assert data["quantity"] == "100"
        assert data["entry_price"] == "150"
        assert data["collateral_required"] == "15000"
        assert data["current_price"] == "145"
        assert data["market_value"] == "14500"
        assert data["unrealized_pnl"] == "500"
        assert "entry_date" in data

    def test_default_values(self) -> None:
        """Test default values."""
        position = ShortPosition(
            symbol="XYZ",
            quantity=Decimal("50"),
            entry_price=Decimal("100"),
        )

        assert position.collateral_required == Decimal("0")
        assert position.current_price == Decimal("0")
        assert position.accrued_borrow_fee == Decimal("0")
        assert position.borrow_rate == Decimal("0.02")


class TestShortBorrow:
    """Tests for ShortBorrow dataclass."""

    @pytest.fixture
    def borrow(self) -> ShortBorrow:
        """Create a short borrow."""
        return ShortBorrow(
            symbol="AAPL",
            quantity=Decimal("100"),
            borrow_date=datetime(2026, 1, 15),
            rate=Decimal("0.02"),  # 2% annual
            locate_id="LOC123",
        )

    def test_creation(self, borrow) -> None:
        """Test borrow creation."""
        assert borrow.symbol == "AAPL"
        assert borrow.quantity == Decimal("100")
        assert borrow.rate == Decimal("0.02")
        assert borrow.locate_id == "LOC123"

    def test_daily_fee(self, borrow) -> None:
        """Test daily fee calculation."""
        # Daily fee = 100 * 150 * 0.02 / 365
        price = Decimal("150")
        expected = (Decimal("100") * price * Decimal("0.02")) / Decimal("365")
        assert borrow.daily_fee(price) == expected

    def test_daily_fee_higher_rate(self) -> None:
        """Test daily fee with higher borrow rate."""
        borrow = ShortBorrow(
            symbol="HTB",
            quantity=Decimal("100"),
            borrow_date=datetime(2026, 1, 15),
            rate=Decimal("0.10"),  # 10% annual (hard to borrow)
        )
        price = Decimal("50")
        expected = (Decimal("100") * price * Decimal("0.10")) / Decimal("365")
        assert borrow.daily_fee(price) == expected

    def test_accrued_fee(self, borrow) -> None:
        """Test accrued fee calculation."""
        price = Decimal("150")
        from_date = datetime(2026, 1, 15)
        to_date = datetime(2026, 1, 25)  # 10 days

        daily_fee = borrow.daily_fee(price)
        expected = daily_fee * Decimal("10")

        assert borrow.accrued_fee(price, from_date, to_date) == expected

    def test_accrued_fee_zero_days(self, borrow) -> None:
        """Test accrued fee with zero days."""
        price = Decimal("150")
        from_date = datetime(2026, 1, 15)
        to_date = datetime(2026, 1, 15)  # Same day

        assert borrow.accrued_fee(price, from_date, to_date) == Decimal("0")

    def test_accrued_fee_negative_days(self, borrow) -> None:
        """Test accrued fee with negative days."""
        price = Decimal("150")
        from_date = datetime(2026, 1, 25)
        to_date = datetime(2026, 1, 15)  # Backwards

        assert borrow.accrued_fee(price, from_date, to_date) == Decimal("0")

    def test_accrued_fee_one_day(self, borrow) -> None:
        """Test accrued fee for one day."""
        price = Decimal("150")
        from_date = datetime(2026, 1, 15)
        to_date = datetime(2026, 1, 16)  # 1 day

        daily_fee = borrow.daily_fee(price)
        assert borrow.accrued_fee(price, from_date, to_date) == daily_fee

    def test_no_locate_id(self) -> None:
        """Test borrow without locate ID."""
        borrow = ShortBorrow(
            symbol="AAPL",
            quantity=Decimal("100"),
            borrow_date=datetime(2026, 1, 15),
            rate=Decimal("0.02"),
        )
        assert borrow.locate_id is None


class TestShortSellingManager:
    """Tests for ShortSellingManager class."""

    @pytest.fixture
    def manager(self) -> ShortSellingManager:
        """Create a short selling manager."""
        return ShortSellingManager(
            collateral_ratio=Decimal("1.0"),
            default_borrow_rate=Decimal("0.02"),
            min_collateral_ratio=Decimal("0.5"),
        )

    def test_init_defaults(self) -> None:
        """Test initialization with defaults."""
        manager = ShortSellingManager()

        assert manager.collateral_ratio == Decimal("1.0")
        assert manager.default_borrow_rate == Decimal("0.02")
        assert manager.min_collateral_ratio == Decimal("0.5")

    def test_init_custom(self) -> None:
        """Test initialization with custom values."""
        manager = ShortSellingManager(
            collateral_ratio=Decimal("1.5"),
            default_borrow_rate=Decimal("0.05"),
            min_collateral_ratio=Decimal("0.75"),
        )

        assert manager.collateral_ratio == Decimal("1.5")
        assert manager.default_borrow_rate == Decimal("0.05")
        assert manager.min_collateral_ratio == Decimal("0.75")

    def test_set_available_collateral(self, manager) -> None:
        """Test setting available collateral."""
        manager.set_available_collateral(Decimal("100000"))
        assert manager._available_collateral == Decimal("100000")

    def test_set_borrow_rate(self, manager) -> None:
        """Test setting borrow rate."""
        manager.set_borrow_rate("HTB", Decimal("0.10"))
        assert manager.get_borrow_rate("HTB") == Decimal("0.10")

    def test_get_borrow_rate_default(self, manager) -> None:
        """Test getting default borrow rate."""
        assert manager.get_borrow_rate("AAPL") == Decimal("0.02")

    def test_mark_hard_to_borrow(self, manager) -> None:
        """Test marking symbol as hard to borrow."""
        manager.mark_hard_to_borrow("HTB")
        assert "HTB" in manager._hard_to_borrow

    def test_is_available_to_short(self, manager) -> None:
        """Test availability check."""
        assert manager.is_available_to_short("AAPL") is True

        manager.mark_hard_to_borrow("HTB")
        assert manager.is_available_to_short("HTB") is False

    def test_calculate_collateral(self, manager) -> None:
        """Test collateral calculation."""
        # 100 shares * $150 * 100% = $15,000
        collateral = manager.calculate_collateral(Decimal("100"), Decimal("150"))
        assert collateral == Decimal("15000")

    def test_calculate_collateral_higher_ratio(self) -> None:
        """Test collateral calculation with higher ratio."""
        manager = ShortSellingManager(collateral_ratio=Decimal("1.5"))
        # 100 shares * $150 * 150% = $22,500
        collateral = manager.calculate_collateral(Decimal("100"), Decimal("150"))
        assert collateral == Decimal("22500")

    def test_calculate_maintenance_collateral(self, manager) -> None:
        """Test maintenance collateral calculation."""
        # 100 shares * $150 * 50% = $7,500
        maint = manager.calculate_maintenance_collateral(Decimal("100"), Decimal("150"))
        assert maint == Decimal("7500")

    def test_open_short_success(self, manager) -> None:
        """Test opening a short position."""
        result = manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        assert result.success is True
        assert result.position is not None
        assert result.position.symbol == "AAPL"
        assert result.position.quantity == Decimal("100")
        assert result.position.entry_price == Decimal("150")
        assert result.collateral_required == Decimal("15000")

    def test_open_short_with_locate_id(self, manager) -> None:
        """Test opening short with locate ID."""
        result = manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
            locate_id="LOC123",
        )

        assert result.success is True
        assert manager._borrows["AAPL"].locate_id == "LOC123"

    def test_open_short_insufficient_collateral(self, manager) -> None:
        """Test opening short with insufficient collateral."""
        manager.set_available_collateral(Decimal("5000"))

        result = manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),  # Requires $15,000
        )

        assert result.success is False
        assert "Insufficient collateral" in result.error
        assert result.collateral_required == Decimal("15000")

    def test_open_short_add_to_existing(self, manager) -> None:
        """Test adding to existing short position."""
        # Open initial position
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        # Add to position
        result = manager.open_short(
            symbol="AAPL",
            quantity=Decimal("50"),
            price=Decimal("140"),
            timestamp=datetime(2026, 1, 20),
        )

        assert result.success is True
        assert result.position.quantity == Decimal("150")
        # Weighted average: (150*100 + 140*50) / 150 = 146.67
        expected_avg = (Decimal("150") * Decimal("100") + Decimal("140") * Decimal("50")) / Decimal("150")
        assert result.position.entry_price == expected_avg

    def test_open_short_deducts_collateral(self, manager) -> None:
        """Test that opening short deducts from available collateral."""
        manager.set_available_collateral(Decimal("20000"))

        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),  # Uses $15,000
        )

        assert manager._available_collateral == Decimal("5000")

    def test_close_short_full_position(self, manager) -> None:
        """Test closing entire short position."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        pnl, collateral, fee = manager.close_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("140"),  # Price dropped - profit!
            timestamp=datetime(2026, 1, 25),
        )

        # P&L = (150 - 140) * 100 = $1,000 profit
        assert pnl == Decimal("1000")
        # All collateral released
        assert collateral == Decimal("15000")
        # Position removed
        assert "AAPL" not in manager._short_positions

    def test_close_short_partial_position(self, manager) -> None:
        """Test partial close of short position."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        pnl, collateral, fee = manager.close_short(
            symbol="AAPL",
            quantity=Decimal("50"),
            price=Decimal("140"),
            timestamp=datetime(2026, 1, 25),
        )

        # P&L = (150 - 140) * 50 = $500
        assert pnl == Decimal("500")
        # Half collateral released
        assert collateral == Decimal("7500")
        # Position reduced but still exists
        assert manager._short_positions["AAPL"].quantity == Decimal("50")

    def test_close_short_loss(self, manager) -> None:
        """Test closing short at a loss."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        pnl, _, _ = manager.close_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("160"),  # Price rose - loss!
            timestamp=datetime(2026, 1, 25),
        )

        # P&L = (150 - 160) * 100 = -$1,000 loss
        assert pnl == Decimal("-1000")

    def test_close_short_nonexistent(self, manager) -> None:
        """Test closing nonexistent position raises error."""
        with pytest.raises(ValueError, match="No short position"):
            manager.close_short(
                symbol="XYZ",
                quantity=Decimal("100"),
                price=Decimal("50"),
                timestamp=datetime.now(),
            )

    def test_update_price(self, manager) -> None:
        """Test updating position price."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
        )

        manager.update_price("AAPL", Decimal("145"))

        assert manager._short_positions["AAPL"].current_price == Decimal("145")

    def test_update_price_nonexistent(self, manager) -> None:
        """Test updating price for nonexistent position."""
        # Should not raise
        manager.update_price("XYZ", Decimal("100"))

    def test_accrue_borrow_fees(self, manager) -> None:
        """Test accruing borrow fees."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        accrued = manager.accrue_borrow_fees(
            timestamp=datetime(2026, 1, 16),
            prices={"AAPL": Decimal("150")},
        )

        assert "AAPL" in accrued
        assert accrued["AAPL"] > Decimal("0")
        assert manager._short_positions["AAPL"].accrued_borrow_fee > Decimal("0")

    def test_accrue_borrow_fees_missing_price(self, manager) -> None:
        """Test accruing fees when price missing."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        accrued = manager.accrue_borrow_fees(
            timestamp=datetime(2026, 1, 16),
            prices={"GOOG": Decimal("100")},  # Wrong symbol
        )

        assert "AAPL" not in accrued

    def test_check_margin_call_no_call(self, manager) -> None:
        """Test margin call check when no call needed."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        # Price dropped - no margin call
        is_call, additional = manager.check_margin_call("AAPL", Decimal("140"))

        assert is_call is False
        assert additional == Decimal("0")

    def test_check_margin_call_triggered(self, manager) -> None:
        """Test margin call when triggered."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("100"),  # Entry at $100
            timestamp=datetime(2026, 1, 15),
        )

        # Price rose significantly - margin call
        # Collateral: $10,000, Maintenance: $15,000 * 0.5 = $7,500
        # But price at $200 means maintenance = $20,000 * 0.5 = $10,000
        is_call, additional = manager.check_margin_call("AAPL", Decimal("250"))

        assert is_call is True
        assert additional > Decimal("0")

    def test_check_margin_call_nonexistent(self, manager) -> None:
        """Test margin call check for nonexistent position."""
        is_call, additional = manager.check_margin_call("XYZ", Decimal("100"))

        assert is_call is False
        assert additional == Decimal("0")

    def test_get_total_short_value(self, manager) -> None:
        """Test getting total short value."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.update_price("AAPL", Decimal("145"))

        manager.open_short(
            symbol="GOOG",
            quantity=Decimal("50"),
            price=Decimal("100"),
        )
        manager.update_price("GOOG", Decimal("95"))

        # AAPL: 100 * 145 = 14,500
        # GOOG: 50 * 95 = 4,750
        # Total: 19,250
        total = manager.get_total_short_value()
        assert total == Decimal("19250")

    def test_get_total_short_value_empty(self, manager) -> None:
        """Test total short value with no positions."""
        assert manager.get_total_short_value() == Decimal("0")

    def test_get_total_collateral(self, manager) -> None:
        """Test getting total collateral."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),  # $15,000 collateral
        )
        manager.open_short(
            symbol="GOOG",
            quantity=Decimal("50"),
            price=Decimal("100"),  # $5,000 collateral
        )

        total = manager.get_total_collateral()
        assert total == Decimal("20000")

    def test_get_total_unrealized_pnl(self, manager) -> None:
        """Test getting total unrealized P&L."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
        )
        manager.update_price("AAPL", Decimal("140"))  # +$1,000

        manager.open_short(
            symbol="GOOG",
            quantity=Decimal("50"),
            price=Decimal("100"),
        )
        manager.update_price("GOOG", Decimal("110"))  # -$500

        total = manager.get_total_unrealized_pnl()
        assert total == Decimal("500")  # Net profit

    def test_get_total_borrow_fees(self, manager) -> None:
        """Test getting total borrow fees."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
            timestamp=datetime(2026, 1, 15),
        )

        manager.accrue_borrow_fees(
            timestamp=datetime(2026, 1, 16),
            prices={"AAPL": Decimal("150")},
        )

        total = manager.get_total_borrow_fees()
        assert total > Decimal("0")

    def test_get_position(self, manager) -> None:
        """Test getting specific position."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
        )

        position = manager.get_position("AAPL")
        assert position is not None
        assert position.symbol == "AAPL"

    def test_get_position_nonexistent(self, manager) -> None:
        """Test getting nonexistent position."""
        position = manager.get_position("XYZ")
        assert position is None

    def test_positions_property(self, manager) -> None:
        """Test positions property returns copy."""
        manager.open_short(
            symbol="AAPL",
            quantity=Decimal("100"),
            price=Decimal("150"),
        )

        positions = manager.positions
        assert "AAPL" in positions

        # Modifying copy shouldn't affect manager
        del positions["AAPL"]
        assert "AAPL" in manager._short_positions

    def test_custom_borrow_rate_used(self, manager) -> None:
        """Test custom borrow rate is used for position."""
        manager.set_borrow_rate("HTB", Decimal("0.15"))

        result = manager.open_short(
            symbol="HTB",
            quantity=Decimal("100"),
            price=Decimal("50"),
            timestamp=datetime(2026, 1, 15),
        )

        assert result.position.borrow_rate == Decimal("0.15")


class TestShortSellingConfig:
    """Tests for ShortSellingConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default configuration."""
        config = ShortSellingConfig()

        assert config.allow_short is True
        assert config.collateral_ratio == Decimal("1.0")
        assert config.min_collateral_ratio == Decimal("0.5")
        assert config.default_borrow_rate == Decimal("0.02")
        assert config.max_short_exposure is None
        assert config.require_locate is False

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = ShortSellingConfig(
            allow_short=False,
            collateral_ratio=Decimal("1.5"),
            min_collateral_ratio=Decimal("0.75"),
            default_borrow_rate=Decimal("0.05"),
            max_short_exposure=Decimal("100000"),
            require_locate=True,
        )

        assert config.allow_short is False
        assert config.collateral_ratio == Decimal("1.5")
        assert config.min_collateral_ratio == Decimal("0.75")
        assert config.default_borrow_rate == Decimal("0.05")
        assert config.max_short_exposure == Decimal("100000")
        assert config.require_locate is True

    def test_no_short_exposure_limit(self) -> None:
        """Test config with no short exposure limit."""
        config = ShortSellingConfig(max_short_exposure=None)
        assert config.max_short_exposure is None
