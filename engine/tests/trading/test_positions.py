"""
Tests for Position Tracking module.

Tests Position, PositionTracker, and related classes.
"""

import pytest
from decimal import Decimal
from datetime import datetime

from quantlab.trading import (
    Position,
    PositionSummary,
    PositionTracker,
    Fill,
    OrderSide,
)


class TestPosition:
    """Tests for Position dataclass."""

    @pytest.fixture
    def position(self) -> Position:
        """Create test position."""
        return Position(
            symbol="AAPL",
            session_id="session-001",
        )

    def test_creation(self, position: Position) -> None:
        """Test position creation."""
        assert position.symbol == "AAPL"
        assert position.quantity == Decimal("0")
        assert position.is_flat is True

    def test_is_long(self, position: Position) -> None:
        """Test is_long property."""
        assert position.is_long is False

        position.quantity = Decimal("100")
        assert position.is_long is True
        assert position.is_short is False

    def test_is_short(self, position: Position) -> None:
        """Test is_short property."""
        position.quantity = Decimal("-100")
        assert position.is_short is True
        assert position.is_long is False

    def test_is_flat(self, position: Position) -> None:
        """Test is_flat property."""
        assert position.is_flat is True

        position.quantity = Decimal("100")
        assert position.is_flat is False

    def test_market_value(self, position: Position) -> None:
        """Test market value calculation."""
        position.quantity = Decimal("100")
        position.current_price = Decimal("150.00")

        assert position.market_value == Decimal("15000")

    def test_cost_basis(self, position: Position) -> None:
        """Test cost basis calculation."""
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("145.00")

        assert position.cost_basis == Decimal("14500")

    def test_update_price_long(self, position: Position) -> None:
        """Test price update for long position."""
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("150.00")

        position.update_price(Decimal("155.00"))

        assert position.unrealized_pnl == Decimal("500")

    def test_update_price_short(self, position: Position) -> None:
        """Test price update for short position."""
        position.quantity = Decimal("-100")
        position.avg_entry_price = Decimal("150.00")

        position.update_price(Decimal("145.00"))

        assert position.unrealized_pnl == Decimal("500")

    def test_total_pnl(self, position: Position) -> None:
        """Test total P&L calculation."""
        position.realized_pnl = Decimal("200")
        position.unrealized_pnl = Decimal("300")

        assert position.total_pnl == Decimal("500")

    def test_apply_fill_open_long(self, position: Position) -> None:
        """Test applying fill to open long position."""
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime.utcnow(),
        )

        realized = position.apply_fill(fill, OrderSide.BUY)

        assert realized == Decimal("0")
        assert position.quantity == Decimal("100")
        assert position.avg_entry_price == Decimal("150.00")
        assert position.is_long is True

    def test_apply_fill_add_to_long(self, position: Position) -> None:
        """Test adding to long position."""
        # Initial position
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("150.00")

        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("160.00"),
            timestamp=datetime.utcnow(),
        )

        realized = position.apply_fill(fill, OrderSide.BUY)

        assert realized == Decimal("0")
        assert position.quantity == Decimal("200")
        assert position.avg_entry_price == Decimal("155.00")

    def test_apply_fill_close_long(self, position: Position) -> None:
        """Test closing long position."""
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("150.00")

        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("160.00"),
            timestamp=datetime.utcnow(),
        )

        realized = position.apply_fill(fill, OrderSide.SELL)

        assert realized == Decimal("1000")  # 100 * (160 - 150)
        assert position.quantity == Decimal("0")
        assert position.is_flat is True

    def test_apply_fill_partial_close(self, position: Position) -> None:
        """Test partial close of position."""
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("150.00")

        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("50"),
            price=Decimal("160.00"),
            timestamp=datetime.utcnow(),
        )

        realized = position.apply_fill(fill, OrderSide.SELL)

        assert realized == Decimal("500")  # 50 * (160 - 150)
        assert position.quantity == Decimal("50")

    def test_apply_fill_open_short(self, position: Position) -> None:
        """Test opening short position."""
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime.utcnow(),
        )

        realized = position.apply_fill(fill, OrderSide.SELL)

        assert realized == Decimal("0")
        assert position.quantity == Decimal("-100")
        assert position.is_short is True

    def test_apply_fill_close_short(self, position: Position) -> None:
        """Test closing short position."""
        position.quantity = Decimal("-100")
        position.avg_entry_price = Decimal("150.00")

        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("140.00"),
            timestamp=datetime.utcnow(),
        )

        realized = position.apply_fill(fill, OrderSide.BUY)

        assert realized == Decimal("1000")  # 100 * (150 - 140)
        assert position.is_flat is True

    def test_commission_tracking(self, position: Position) -> None:
        """Test commission tracking."""
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime.utcnow(),
            commission=Decimal("5.00"),
        )

        position.apply_fill(fill, OrderSide.BUY)

        assert position.total_commission == Decimal("5.00")

    def test_to_dict(self, position: Position) -> None:
        """Test conversion to dictionary."""
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("150.00")
        position.current_price = Decimal("155.00")
        position.update_price(position.current_price)

        d = position.to_dict()

        assert d["symbol"] == "AAPL"
        assert d["quantity"] == 100.0
        assert d["avgEntryPrice"] == 150.0
        assert d["unrealizedPnl"] == 500.0
        assert d["isLong"] is True


class TestPositionSummary:
    """Tests for PositionSummary dataclass."""

    def test_creation(self) -> None:
        """Test summary creation."""
        summary = PositionSummary(session_id="session-001")
        assert summary.total_positions == 0
        assert summary.total_pnl == Decimal("0")

    def test_total_pnl(self) -> None:
        """Test total P&L calculation."""
        summary = PositionSummary(
            session_id="session-001",
            total_realized_pnl=Decimal("500"),
            total_unrealized_pnl=Decimal("300"),
        )
        assert summary.total_pnl == Decimal("800")

    def test_net_pnl(self) -> None:
        """Test net P&L calculation."""
        summary = PositionSummary(
            session_id="session-001",
            total_realized_pnl=Decimal("500"),
            total_unrealized_pnl=Decimal("300"),
            total_commission=Decimal("50"),
        )
        assert summary.net_pnl == Decimal("750")

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        summary = PositionSummary(
            session_id="session-001",
            total_positions=3,
            long_positions=2,
            short_positions=1,
        )
        d = summary.to_dict()

        assert d["totalPositions"] == 3
        assert d["longPositions"] == 2
        assert d["shortPositions"] == 1


class TestPositionTracker:
    """Tests for PositionTracker class."""

    @pytest.fixture
    def tracker(self) -> PositionTracker:
        """Create test tracker."""
        return PositionTracker()

    def test_get_or_create_position(self, tracker: PositionTracker) -> None:
        """Test getting or creating a position."""
        position = tracker.get_or_create_position("session-001", "AAPL")

        assert position is not None
        assert position.symbol == "AAPL"
        assert position.is_flat is True

        # Same position returned on second call
        position2 = tracker.get_or_create_position("session-001", "AAPL")
        assert position2 is position

    def test_get_position(self, tracker: PositionTracker) -> None:
        """Test getting a position."""
        # Non-existent position
        result = tracker.get_position("session-001", "AAPL")
        assert result is None

        # Create and get
        tracker.get_or_create_position("session-001", "AAPL")
        result = tracker.get_position("session-001", "AAPL")
        assert result is not None

    def test_get_positions_for_session(self, tracker: PositionTracker) -> None:
        """Test getting positions for a session."""
        # Create positions
        pos1 = tracker.get_or_create_position("session-001", "AAPL")
        pos2 = tracker.get_or_create_position("session-001", "GOOG")

        # Make pos1 non-flat
        pos1.quantity = Decimal("100")

        positions = tracker.get_positions_for_session("session-001")
        assert len(positions) == 1  # Only non-flat by default

        positions_all = tracker.get_positions_for_session(
            "session-001",
            include_flat=True,
        )
        assert len(positions_all) == 2

    def test_apply_fill(self, tracker: PositionTracker) -> None:
        """Test applying a fill."""
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime.utcnow(),
        )

        realized = tracker.apply_fill(
            "session-001",
            "AAPL",
            fill,
            OrderSide.BUY,
        )

        assert realized == Decimal("0")

        position = tracker.get_position("session-001", "AAPL")
        assert position is not None
        assert position.quantity == Decimal("100")

    def test_update_price(self, tracker: PositionTracker) -> None:
        """Test updating price."""
        # Create position
        position = tracker.get_or_create_position("session-001", "AAPL")
        position.quantity = Decimal("100")
        position.avg_entry_price = Decimal("150.00")

        tracker.update_price("session-001", "AAPL", Decimal("155.00"))

        assert position.unrealized_pnl == Decimal("500")

    def test_update_all_prices(self, tracker: PositionTracker) -> None:
        """Test updating multiple prices."""
        pos1 = tracker.get_or_create_position("session-001", "AAPL")
        pos1.quantity = Decimal("100")
        pos1.avg_entry_price = Decimal("150.00")

        pos2 = tracker.get_or_create_position("session-001", "GOOG")
        pos2.quantity = Decimal("50")
        pos2.avg_entry_price = Decimal("100.00")

        tracker.update_all_prices("session-001", {
            "AAPL": Decimal("160.00"),
            "GOOG": Decimal("110.00"),
        })

        assert pos1.unrealized_pnl == Decimal("1000")
        assert pos2.unrealized_pnl == Decimal("500")

    def test_get_summary(self, tracker: PositionTracker) -> None:
        """Test getting position summary."""
        pos1 = tracker.get_or_create_position("session-001", "AAPL")
        pos1.quantity = Decimal("100")
        pos1.current_price = Decimal("150.00")
        pos1.realized_pnl = Decimal("100")
        pos1.unrealized_pnl = Decimal("200")

        pos2 = tracker.get_or_create_position("session-001", "GOOG")
        pos2.quantity = Decimal("-50")  # Short
        pos2.current_price = Decimal("100.00")
        pos2.realized_pnl = Decimal("50")
        pos2.unrealized_pnl = Decimal("100")

        summary = tracker.get_summary("session-001")

        assert summary.total_positions == 2
        assert summary.long_positions == 1
        assert summary.short_positions == 1
        assert summary.total_realized_pnl == Decimal("150")
        assert summary.total_unrealized_pnl == Decimal("300")

    def test_close_all_positions(self, tracker: PositionTracker) -> None:
        """Test closing all positions."""
        pos = tracker.get_or_create_position("session-001", "AAPL")
        pos.quantity = Decimal("100")
        pos.avg_entry_price = Decimal("150.00")

        realized = tracker.close_all_positions("session-001", {
            "AAPL": Decimal("160.00"),
        })

        assert realized == Decimal("1000")
        assert pos.is_flat is True

    def test_clear_session(self, tracker: PositionTracker) -> None:
        """Test clearing session positions."""
        tracker.get_or_create_position("session-001", "AAPL")
        tracker.get_or_create_position("session-001", "GOOG")

        tracker.clear_session("session-001")

        positions = tracker.get_positions_for_session(
            "session-001",
            include_flat=True,
        )
        assert len(positions) == 0

    def test_position_update_callback(self, tracker: PositionTracker) -> None:
        """Test position update callback."""
        updates: list[Position] = []
        tracker.on_position_update(lambda p: updates.append(p))

        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime.utcnow(),
        )

        tracker.apply_fill("session-001", "AAPL", fill, OrderSide.BUY)

        assert len(updates) >= 1

    def test_pnl_change_callback(self, tracker: PositionTracker) -> None:
        """Test P&L change callback."""
        pnl_changes: list[tuple[str, Decimal]] = []
        tracker.on_pnl_change(lambda s, p: pnl_changes.append((s, p)))

        # Create position
        pos = tracker.get_or_create_position("session-001", "AAPL")
        pos.quantity = Decimal("100")
        pos.avg_entry_price = Decimal("150.00")

        # Close position
        fill = Fill(
            fill_id="fill-001",
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("160.00"),
            timestamp=datetime.utcnow(),
        )

        tracker.apply_fill("session-001", "AAPL", fill, OrderSide.SELL)

        assert len(pnl_changes) == 1
        assert pnl_changes[0][1] == Decimal("1000")
