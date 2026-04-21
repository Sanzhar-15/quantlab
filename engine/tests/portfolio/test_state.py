"""
Tests for Portfolio State Management.

Tests position tracking, equity calculations, and portfolio history.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.portfolio.state import (
    PortfolioHistory,
    PortfolioSnapshot,
    PortfolioState,
    Position,
    PositionSide,
)


class TestPositionSide:
    """Tests for PositionSide enum."""

    def test_long_value(self) -> None:
        """Test LONG enum value."""
        assert PositionSide.LONG.value == "long"

    def test_short_value(self) -> None:
        """Test SHORT enum value."""
        assert PositionSide.SHORT.value == "short"

    def test_flat_value(self) -> None:
        """Test FLAT enum value."""
        assert PositionSide.FLAT.value == "flat"


class TestPosition:
    """Tests for Position dataclass."""

    @pytest.fixture
    def long_position(self) -> Position:
        """Create a long position."""
        return Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("160"),
        )

    @pytest.fixture
    def short_position(self) -> Position:
        """Create a short position."""
        return Position(
            symbol="TSLA",
            quantity=Decimal("-50"),
            avg_cost=Decimal("200"),
            last_price=Decimal("180"),
        )

    def test_creation_basic(self) -> None:
        """Test basic position creation."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        assert pos.symbol == "AAPL"
        assert pos.quantity == Decimal("100")
        assert pos.avg_cost == Decimal("150")

    def test_creation_with_explicit_long_side(self) -> None:
        """Test creation with explicit LONG side."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            side=PositionSide.LONG,
        )

        assert pos.quantity == Decimal("100")
        assert pos.side == PositionSide.LONG

    def test_creation_with_explicit_short_side(self) -> None:
        """Test creation with explicit SHORT side."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),  # Positive but short
            avg_cost=Decimal("150"),
            side=PositionSide.SHORT,
        )

        # Quantity should be made negative for short
        assert pos.quantity == Decimal("-100")
        assert pos.side == PositionSide.SHORT

    def test_creation_with_negative_qty_long_side(self) -> None:
        """Test that negative quantity becomes positive for LONG side."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
            side=PositionSide.LONG,
        )

        assert pos.quantity == Decimal("100")
        assert pos.side == PositionSide.LONG

    def test_default_values(self) -> None:
        """Test default values."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        assert pos.realized_pnl == Decimal("0")
        assert pos.unrealized_pnl == Decimal("0")
        assert pos.last_price == Decimal("0")
        assert pos.opened_at is None

    def test_side_property_long(self, long_position) -> None:
        """Test side property for long position."""
        assert long_position.side == PositionSide.LONG

    def test_side_property_short(self, short_position) -> None:
        """Test side property for short position."""
        assert short_position.side == PositionSide.SHORT

    def test_side_property_flat(self) -> None:
        """Test side property for flat position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("0"),
            avg_cost=Decimal("150"),
        )
        assert pos.side == PositionSide.FLAT

    def test_is_long(self, long_position, short_position) -> None:
        """Test is_long property."""
        assert long_position.is_long is True
        assert short_position.is_long is False

    def test_is_short(self, long_position, short_position) -> None:
        """Test is_short property."""
        assert long_position.is_short is False
        assert short_position.is_short is True

    def test_is_flat(self) -> None:
        """Test is_flat property."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("0"),
            avg_cost=Decimal("150"),
        )
        assert pos.is_flat is True

    def test_market_value_long(self, long_position) -> None:
        """Test market value for long position."""
        # 100 * 160 = 16000
        assert long_position.market_value == Decimal("16000")

    def test_market_value_short(self, short_position) -> None:
        """Test market value for short position."""
        # -50 * 180 = -9000
        assert short_position.market_value == Decimal("-9000")

    def test_abs_quantity(self, long_position, short_position) -> None:
        """Test abs_quantity property."""
        assert long_position.abs_quantity == Decimal("100")
        assert short_position.abs_quantity == Decimal("50")

    def test_cost_basis(self, long_position, short_position) -> None:
        """Test cost basis calculation."""
        # Long: 100 * 150 = 15000
        assert long_position.cost_basis == Decimal("15000")
        # Short: 50 * 200 = 10000
        assert short_position.cost_basis == Decimal("10000")

    def test_total_pnl(self) -> None:
        """Test total P&L."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            realized_pnl=Decimal("500"),
            unrealized_pnl=Decimal("300"),
        )

        assert pos.total_pnl == Decimal("800")

    def test_update_price_long(self) -> None:
        """Test update_price for long position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("150"),
        )

        pos.update_price(Decimal("160"))

        assert pos.last_price == Decimal("160")
        # Unrealized = (160 - 150) * 100 = 1000
        assert pos.unrealized_pnl == Decimal("1000")

    def test_update_price_long_loss(self) -> None:
        """Test update_price for long position with loss."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        pos.update_price(Decimal("140"))

        # Unrealized = (140 - 150) * 100 = -1000
        assert pos.unrealized_pnl == Decimal("-1000")

    def test_update_price_short(self) -> None:
        """Test update_price for short position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
        )

        pos.update_price(Decimal("140"))

        assert pos.last_price == Decimal("140")
        # Unrealized = (150 - 140) * 100 = 1000 (profit)
        assert pos.unrealized_pnl == Decimal("1000")

    def test_update_price_short_loss(self) -> None:
        """Test update_price for short position with loss."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
        )

        pos.update_price(Decimal("160"))

        # Unrealized = (150 - 160) * 100 = -1000 (loss)
        assert pos.unrealized_pnl == Decimal("-1000")

    def test_add_to_position_from_flat(self) -> None:
        """Test adding to position from flat."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("0"),
            avg_cost=Decimal("0"),
        )
        timestamp = datetime(2026, 1, 15, 10, 0, 0)

        pos.add_to_position(Decimal("100"), Decimal("150"), timestamp)

        assert pos.quantity == Decimal("100")
        assert pos.avg_cost == Decimal("150")
        assert pos.opened_at == timestamp

    def test_add_to_position_existing(self) -> None:
        """Test adding to existing position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        pos.add_to_position(Decimal("50"), Decimal("160"))

        assert pos.quantity == Decimal("150")
        # Avg cost: (100*150 + 50*160) / 150 = 23000/150 = 153.33...
        expected = (Decimal("100") * Decimal("150") + Decimal("50") * Decimal("160")) / Decimal("150")
        assert pos.avg_cost == expected

    def test_reduce_position_long(self) -> None:
        """Test reducing long position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        realized = pos.reduce_position(Decimal("-50"), Decimal("160"))

        # Realized = (160 - 150) * 50 = 500
        assert realized == Decimal("500")
        assert pos.quantity == Decimal("50")
        assert pos.realized_pnl == Decimal("500")

    def test_reduce_position_short(self) -> None:
        """Test reducing short position."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
        )

        realized = pos.reduce_position(Decimal("50"), Decimal("140"))

        # Realized = (150 - 140) * 50 = 500 (profit, price went down)
        assert realized == Decimal("500")
        assert pos.quantity == Decimal("-50")
        assert pos.realized_pnl == Decimal("500")

    def test_reduce_position_loss(self) -> None:
        """Test reducing position with loss."""
        pos = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        realized = pos.reduce_position(Decimal("-50"), Decimal("140"))

        # Realized = (140 - 150) * 50 = -500
        assert realized == Decimal("-500")

    def test_to_dict(self, long_position) -> None:
        """Test to_dict conversion."""
        data = long_position.to_dict()

        assert data["symbol"] == "AAPL"
        assert data["quantity"] == "100"
        assert data["avg_cost"] == "150"
        assert data["side"] == "long"


class TestPortfolioState:
    """Tests for PortfolioState dataclass."""

    @pytest.fixture
    def portfolio(self) -> PortfolioState:
        """Create a portfolio with positions."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("160"),
        )
        state.positions["TSLA"] = Position(
            symbol="TSLA",
            quantity=Decimal("-50"),
            avg_cost=Decimal("200"),
            last_price=Decimal("180"),
        )
        return state

    def test_init_basic(self) -> None:
        """Test basic initialization."""
        state = PortfolioState(cash=Decimal("100000"))

        assert state.cash == Decimal("100000")
        assert state.positions == {}

    def test_init_with_initial_cash_alias(self) -> None:
        """Test initialization with initial_cash alias."""
        state = PortfolioState(initial_cash=Decimal("100000"))

        assert state.cash == Decimal("100000")

    def test_init_default_values(self) -> None:
        """Test default values."""
        state = PortfolioState()

        assert state.cash == Decimal("0")
        assert state.positions == {}
        assert state.total_deposits == Decimal("0")
        assert state.total_withdrawals == Decimal("0")
        assert state.session_id == ""

    def test_init_initial_capital_from_cash(self) -> None:
        """Test initial capital defaults to cash."""
        state = PortfolioState(cash=Decimal("100000"))

        assert state.initial_capital == Decimal("100000")

    def test_init_explicit_initial_capital(self) -> None:
        """Test explicit initial capital."""
        state = PortfolioState(
            cash=Decimal("50000"),
            initial_capital=Decimal("100000"),
        )

        assert state.initial_capital == Decimal("100000")

    def test_long_positions(self, portfolio) -> None:
        """Test long_positions property."""
        longs = portfolio.long_positions

        assert "AAPL" in longs
        assert "TSLA" not in longs

    def test_short_positions(self, portfolio) -> None:
        """Test short_positions property."""
        shorts = portfolio.short_positions

        assert "TSLA" in shorts
        assert "AAPL" not in shorts

    def test_long_value(self, portfolio) -> None:
        """Test long_value calculation."""
        # AAPL: 100 * 160 = 16000
        assert portfolio.long_value == Decimal("16000")

    def test_short_value(self, portfolio) -> None:
        """Test short_value calculation."""
        # TSLA: |-50 * 180| = 9000
        assert portfolio.short_value == Decimal("9000")

    def test_gross_exposure(self, portfolio) -> None:
        """Test gross_exposure calculation."""
        # Long + Short = 16000 + 9000 = 25000
        assert portfolio.gross_exposure == Decimal("25000")

    def test_net_exposure(self, portfolio) -> None:
        """Test net_exposure calculation."""
        # Long - Short = 16000 - 9000 = 7000
        assert portfolio.net_exposure == Decimal("7000")

    def test_equity(self, portfolio) -> None:
        """Test equity calculation."""
        # Cash + Long - Short = 50000 + 16000 - 9000 = 57000
        assert portfolio.equity == Decimal("57000")

    def test_total_realized_pnl(self) -> None:
        """Test total realized P&L."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            realized_pnl=Decimal("500"),
        )
        state.positions["GOOG"] = Position(
            symbol="GOOG",
            quantity=Decimal("50"),
            avg_cost=Decimal("100"),
            realized_pnl=Decimal("300"),
        )

        assert state.total_realized_pnl == Decimal("800")

    def test_total_unrealized_pnl(self) -> None:
        """Test total unrealized P&L."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            unrealized_pnl=Decimal("1000"),
        )
        state.positions["GOOG"] = Position(
            symbol="GOOG",
            quantity=Decimal("50"),
            avg_cost=Decimal("100"),
            unrealized_pnl=Decimal("-200"),
        )

        assert state.total_unrealized_pnl == Decimal("800")

    def test_total_pnl(self) -> None:
        """Test total P&L."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            realized_pnl=Decimal("500"),
            unrealized_pnl=Decimal("300"),
        )

        assert state.total_pnl == Decimal("800")

    def test_return_pct(self) -> None:
        """Test return percentage."""
        state = PortfolioState(
            cash=Decimal("110000"),
            initial_capital=Decimal("100000"),
        )

        # Return = (110000 - 100000) / 100000 = 0.10
        assert state.return_pct == Decimal("0.1")

    def test_return_pct_zero_capital(self) -> None:
        """Test return percentage with zero initial capital."""
        state = PortfolioState(
            cash=Decimal("50000"),
            initial_capital=Decimal("0"),
        )

        assert state.return_pct == Decimal("0")

    def test_get_position(self, portfolio) -> None:
        """Test get_position."""
        pos = portfolio.get_position("AAPL")

        assert pos is not None
        assert pos.symbol == "AAPL"

    def test_get_position_nonexistent(self, portfolio) -> None:
        """Test get_position for nonexistent symbol."""
        pos = portfolio.get_position("XYZ")
        assert pos is None

    def test_get_quantity(self, portfolio) -> None:
        """Test get_quantity."""
        qty = portfolio.get_quantity("AAPL")
        assert qty == Decimal("100")

    def test_get_quantity_nonexistent(self, portfolio) -> None:
        """Test get_quantity for nonexistent symbol."""
        qty = portfolio.get_quantity("XYZ")
        assert qty == Decimal("0")

    def test_update_prices(self, portfolio) -> None:
        """Test update_prices."""
        portfolio.update_prices({
            "AAPL": Decimal("170"),
            "TSLA": Decimal("190"),
            "XYZ": Decimal("100"),  # Nonexistent symbol
        })

        assert portfolio.positions["AAPL"].last_price == Decimal("170")
        assert portfolio.positions["TSLA"].last_price == Decimal("190")

    def test_update_market_price(self, portfolio) -> None:
        """Test update_market_price."""
        portfolio.update_market_price("AAPL", Decimal("175"))

        assert portfolio.positions["AAPL"].last_price == Decimal("175")

    def test_update_market_price_nonexistent(self, portfolio) -> None:
        """Test update_market_price for nonexistent symbol."""
        # Should not raise
        portfolio.update_market_price("XYZ", Decimal("100"))

    def test_update_position_new(self) -> None:
        """Test update_position for new position."""
        state = PortfolioState(cash=Decimal("50000"))

        state.update_position("AAPL", Decimal("100"), Decimal("150"), PositionSide.LONG)

        assert "AAPL" in state.positions
        assert state.positions["AAPL"].quantity == Decimal("100")

    def test_update_position_existing(self, portfolio) -> None:
        """Test update_position for existing position."""
        portfolio.update_position("AAPL", Decimal("200"), Decimal("155"), PositionSide.LONG)

        assert portfolio.positions["AAPL"].quantity == Decimal("200")
        assert portfolio.positions["AAPL"].avg_cost == Decimal("155")

    def test_update_position_short(self) -> None:
        """Test update_position for short position."""
        state = PortfolioState(cash=Decimal("50000"))

        state.update_position("TSLA", Decimal("100"), Decimal("200"), PositionSide.SHORT)

        assert state.positions["TSLA"].quantity == Decimal("-100")

    def test_apply_fill_new_position(self) -> None:
        """Test apply_fill for new position."""
        state = PortfolioState(cash=Decimal("100000"))
        timestamp = datetime(2026, 1, 15, 10, 0, 0)

        realized = state.apply_fill("AAPL", Decimal("100"), Decimal("150"), Decimal("10"), timestamp)

        assert realized == Decimal("0")
        # Cash: 100000 - (100 * 150) - 10 = 84990
        assert state.cash == Decimal("84990")
        assert state.positions["AAPL"].quantity == Decimal("100")
        assert state.positions["AAPL"].opened_at == timestamp

    def test_apply_fill_add_to_position(self) -> None:
        """Test apply_fill adding to existing position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        realized = state.apply_fill("AAPL", Decimal("50"), Decimal("160"), Decimal("5"))

        assert realized == Decimal("0")
        assert state.positions["AAPL"].quantity == Decimal("150")

    def test_apply_fill_reduce_position(self) -> None:
        """Test apply_fill reducing position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        realized = state.apply_fill("AAPL", Decimal("-50"), Decimal("160"), Decimal("5"))

        # Realized = (160 - 150) * 50 = 500
        assert realized == Decimal("500")
        assert state.positions["AAPL"].quantity == Decimal("50")

    def test_apply_fill_close_position(self) -> None:
        """Test apply_fill closing entire position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )

        realized = state.apply_fill("AAPL", Decimal("-100"), Decimal("160"), Decimal("5"))

        assert realized == Decimal("1000")
        assert "AAPL" not in state.positions

    def test_apply_fill_flip_position(self) -> None:
        """Test apply_fill flipping position."""
        state = PortfolioState(cash=Decimal("100000"))
        timestamp = datetime(2026, 1, 15, 10, 0, 0)
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            opened_at=datetime(2026, 1, 10),
        )

        realized = state.apply_fill("AAPL", Decimal("-150"), Decimal("160"), Decimal("5"), timestamp)

        # Close 100 shares: (160 - 150) * 100 = 1000
        assert realized == Decimal("1000")
        # Now short 50 shares
        assert state.positions["AAPL"].quantity == Decimal("-50")
        assert state.positions["AAPL"].avg_cost == Decimal("160")
        assert state.positions["AAPL"].opened_at == timestamp

    def test_apply_fill_short_add(self) -> None:
        """Test apply_fill adding to short position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("-100"),
            avg_cost=Decimal("150"),
        )

        realized = state.apply_fill("AAPL", Decimal("-50"), Decimal("160"), Decimal("5"))

        assert realized == Decimal("0")
        assert state.positions["AAPL"].quantity == Decimal("-150")

    def test_apply_fill_to_flat(self) -> None:
        """Test apply_fill opening from flat position."""
        state = PortfolioState(cash=Decimal("100000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("0"),
            avg_cost=Decimal("150"),
        )
        timestamp = datetime(2026, 1, 15, 10, 0, 0)

        realized = state.apply_fill("AAPL", Decimal("100"), Decimal("160"), Decimal("5"), timestamp)

        assert realized == Decimal("0")
        assert state.positions["AAPL"].quantity == Decimal("100")
        assert state.positions["AAPL"].avg_cost == Decimal("160")
        assert state.positions["AAPL"].opened_at == timestamp

    def test_validate_equity_identity(self, portfolio) -> None:
        """Test validate_equity_identity."""
        assert portfolio.validate_equity_identity() is True

    def test_to_dict(self, portfolio) -> None:
        """Test to_dict conversion."""
        data = portfolio.to_dict()

        assert "cash" in data
        assert "equity" in data
        assert "long_value" in data
        assert "short_value" in data
        assert "gross_exposure" in data
        assert "net_exposure" in data
        assert "positions" in data
        assert "AAPL" in data["positions"]


class TestPortfolioSnapshot:
    """Tests for PortfolioSnapshot class."""

    def test_snapshot_creation(self) -> None:
        """Test snapshot creation."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
            last_price=Decimal("160"),
            realized_pnl=Decimal("500"),
            unrealized_pnl=Decimal("1000"),
        )
        timestamp = datetime(2026, 1, 15, 10, 0, 0)

        snapshot = PortfolioSnapshot(state, timestamp)

        assert snapshot.timestamp == timestamp
        assert snapshot.cash == Decimal("50000")
        assert snapshot.equity == state.equity
        assert snapshot.long_value == state.long_value
        assert snapshot.short_value == state.short_value
        assert "AAPL" in snapshot.positions

    def test_snapshot_copies_positions(self) -> None:
        """Test that snapshot copies positions."""
        state = PortfolioState(cash=Decimal("50000"))
        state.positions["AAPL"] = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150"),
        )
        timestamp = datetime(2026, 1, 15)

        snapshot = PortfolioSnapshot(state, timestamp)

        # Modify original
        state.positions["AAPL"].quantity = Decimal("200")

        # Snapshot should be unchanged
        assert snapshot.positions["AAPL"].quantity == Decimal("100")


class TestPortfolioHistory:
    """Tests for PortfolioHistory class."""

    @pytest.fixture
    def history(self) -> PortfolioHistory:
        """Create portfolio history with snapshots."""
        history = PortfolioHistory()

        # Add snapshots
        for i in range(5):
            state = PortfolioState(cash=Decimal(50000 + i * 1000))
            state.positions["AAPL"] = Position(
                symbol="AAPL",
                quantity=Decimal("100"),
                avg_cost=Decimal("150"),
                last_price=Decimal(150 + i * 5),
            )
            timestamp = datetime(2026, 1, 15 + i, 10, 0, 0)
            history.record(state, timestamp)

        return history

    def test_record(self) -> None:
        """Test recording snapshots."""
        history = PortfolioHistory()
        state = PortfolioState(cash=Decimal("50000"))
        timestamp = datetime(2026, 1, 15)

        history.record(state, timestamp)

        assert len(history) == 1

    def test_equity_curve(self, history) -> None:
        """Test equity curve."""
        curve = history.equity_curve

        assert len(curve) == 5
        for timestamp, equity in curve:
            assert isinstance(timestamp, datetime)
            assert isinstance(equity, Decimal)

    def test_cash_curve(self, history) -> None:
        """Test cash curve."""
        curve = history.cash_curve

        assert len(curve) == 5
        # Cash should increase
        for i, (timestamp, cash) in enumerate(curve):
            expected = Decimal(50000 + i * 1000)
            assert cash == expected

    def test_exposure_curve(self, history) -> None:
        """Test exposure curve."""
        curve = history.exposure_curve

        assert len(curve) == 5
        for timestamp, long_val, short_val in curve:
            assert isinstance(timestamp, datetime)
            assert long_val > Decimal("0")
            assert short_val == Decimal("0")

    def test_len(self, history) -> None:
        """Test __len__."""
        assert len(history) == 5

    def test_getitem(self, history) -> None:
        """Test __getitem__."""
        snapshot = history[0]

        assert isinstance(snapshot, PortfolioSnapshot)
        assert snapshot.cash == Decimal("50000")

    def test_empty_history(self) -> None:
        """Test empty history."""
        history = PortfolioHistory()

        assert len(history) == 0
        assert history.equity_curve == []
        assert history.cash_curve == []
        assert history.exposure_curve == []
