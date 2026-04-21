"""
Portfolio State Management.

Tracks portfolio state including cash, positions, and equity.

Spec Reference: Technical Spec §4.1
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any


class PositionSide(Enum):
    """Position side."""

    LONG = "long"
    SHORT = "short"
    FLAT = "flat"


@dataclass
class Position:
    """
    Single position in a security.

    Tracks quantity, cost basis, and P&L.
    """

    symbol: str
    quantity: Decimal  # Positive for long, negative for short
    avg_cost: Decimal
    realized_pnl: Decimal = Decimal("0")
    unrealized_pnl: Decimal = Decimal("0")
    last_price: Decimal = Decimal("0")
    opened_at: datetime | None = None
    _explicit_side: PositionSide | None = None  # For test compatibility

    def __init__(
        self,
        symbol: str,
        quantity: Decimal,
        avg_cost: Decimal,
        realized_pnl: Decimal = Decimal("0"),
        unrealized_pnl: Decimal = Decimal("0"),
        last_price: Decimal = Decimal("0"),
        opened_at: datetime | None = None,
        side: PositionSide | None = None,
    ) -> None:
        """Initialize position with optional explicit side."""
        self.symbol = symbol
        self.quantity = quantity
        self.avg_cost = avg_cost
        self.realized_pnl = realized_pnl
        self.unrealized_pnl = unrealized_pnl
        self.last_price = last_price
        self.opened_at = opened_at
        self._explicit_side = side
        # If explicit side provided and quantity doesn't match, adjust quantity sign
        if side == PositionSide.SHORT and quantity > Decimal("0"):
            self.quantity = -abs(quantity)
        elif side == PositionSide.LONG and quantity < Decimal("0"):
            self.quantity = abs(quantity)

    @property
    def side(self) -> PositionSide:
        """Get position side."""
        if self.quantity > Decimal("0"):
            return PositionSide.LONG
        elif self.quantity < Decimal("0"):
            return PositionSide.SHORT
        else:
            return PositionSide.FLAT

    @property
    def is_long(self) -> bool:
        """Check if long position."""
        return self.quantity > Decimal("0")

    @property
    def is_short(self) -> bool:
        """Check if short position."""
        return self.quantity < Decimal("0")

    @property
    def is_flat(self) -> bool:
        """Check if no position."""
        return self.quantity == Decimal("0")

    @property
    def market_value(self) -> Decimal:
        """Current market value (can be negative for shorts)."""
        return self.quantity * self.last_price

    @property
    def abs_quantity(self) -> Decimal:
        """Absolute quantity."""
        return abs(self.quantity)

    @property
    def cost_basis(self) -> Decimal:
        """Total cost basis."""
        return abs(self.quantity) * self.avg_cost

    @property
    def total_pnl(self) -> Decimal:
        """Total P&L (realized + unrealized)."""
        return self.realized_pnl + self.unrealized_pnl

    def update_price(self, price: Decimal) -> None:
        """Update last price and recalculate unrealized P&L."""
        self.last_price = price
        if self.is_long:
            self.unrealized_pnl = (price - self.avg_cost) * self.quantity
        elif self.is_short:
            # Short: profit when price goes down
            self.unrealized_pnl = (self.avg_cost - price) * abs(self.quantity)

    def add_to_position(
        self,
        quantity: Decimal,
        price: Decimal,
        timestamp: datetime | None = None,
    ) -> None:
        """
        Add to existing position (same direction).

        Updates average cost using weighted average.
        """
        if self.is_flat:
            self.quantity = quantity
            self.avg_cost = price
            self.opened_at = timestamp
        else:
            old_value = abs(self.quantity) * self.avg_cost
            new_value = abs(quantity) * price
            new_total = abs(self.quantity) + abs(quantity)

            if new_total > Decimal("0"):
                self.avg_cost = (old_value + new_value) / new_total

            self.quantity += quantity

    def reduce_position(
        self,
        quantity: Decimal,
        price: Decimal,
    ) -> Decimal:
        """
        Reduce existing position (opposite direction).

        Returns realized P&L from the reduction.
        """
        reduce_qty = min(abs(quantity), abs(self.quantity))

        if self.is_long:
            realized = (price - self.avg_cost) * reduce_qty
        else:
            realized = (self.avg_cost - price) * reduce_qty

        self.realized_pnl += realized
        self.quantity += quantity  # quantity should be opposite sign

        return realized

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "quantity": str(self.quantity),
            "avg_cost": str(self.avg_cost),
            "realized_pnl": str(self.realized_pnl),
            "unrealized_pnl": str(self.unrealized_pnl),
            "last_price": str(self.last_price),
            "side": self.side.value,
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Position":
        """Create Position from dictionary.

        Required for restoring checkpointed/serialized state.
        """
        opened_at = None
        if data.get("opened_at"):
            opened_at = datetime.fromisoformat(data["opened_at"])

        return cls(
            symbol=data["symbol"],
            quantity=Decimal(data["quantity"]),
            avg_cost=Decimal(data["avg_cost"]),
            realized_pnl=Decimal(data.get("realized_pnl", "0")),
            unrealized_pnl=Decimal(data.get("unrealized_pnl", "0")),
            last_price=Decimal(data.get("last_price", "0")),
            opened_at=opened_at,
            side=PositionSide(data["side"]) if data.get("side") else None,
        )


@dataclass
class PortfolioState:
    """
    Complete portfolio state.

    Tracks all positions, cash, and portfolio-level metrics.

    Equity Identity:
        Equity = Cash + Long_Value - Short_Value
               = Cash + Sum(Long_Qty * Price) - Sum(|Short_Qty| * Price)
    """

    cash: Decimal
    positions: dict[str, Position] = field(default_factory=dict)
    timestamp: datetime | None = None

    # Tracking
    initial_capital: Decimal = Decimal("0")
    total_deposits: Decimal = Decimal("0")
    total_withdrawals: Decimal = Decimal("0")

    # Session tracking
    session_id: str = ""

    def __init__(
        self,
        cash: Decimal | None = None,
        positions: dict[str, Position] | None = None,
        timestamp: datetime | None = None,
        initial_capital: Decimal = Decimal("0"),
        total_deposits: Decimal = Decimal("0"),
        total_withdrawals: Decimal = Decimal("0"),
        session_id: str = "",
        initial_cash: Decimal | None = None,  # Alias for cash
    ) -> None:
        """Initialize portfolio state."""
        # Support both cash and initial_cash parameters
        self.cash = cash if cash is not None else (initial_cash if initial_cash is not None else Decimal("0"))
        self.positions = positions if positions is not None else {}
        self.timestamp = timestamp
        self.initial_capital = initial_capital if initial_capital != Decimal("0") else self.cash
        self.total_deposits = total_deposits
        self.total_withdrawals = total_withdrawals
        self.session_id = session_id

    @property
    def long_positions(self) -> dict[str, Position]:
        """Get all long positions."""
        return {
            symbol: pos
            for symbol, pos in self.positions.items()
            if pos.is_long
        }

    @property
    def short_positions(self) -> dict[str, Position]:
        """Get all short positions."""
        return {
            symbol: pos
            for symbol, pos in self.positions.items()
            if pos.is_short
        }

    @property
    def long_value(self) -> Decimal:
        """Total value of long positions."""
        return sum(
            pos.market_value
            for pos in self.positions.values()
            if pos.is_long
        )

    @property
    def short_value(self) -> Decimal:
        """Total value of short positions (absolute)."""
        return sum(
            abs(pos.market_value)
            for pos in self.positions.values()
            if pos.is_short
        )

    @property
    def gross_exposure(self) -> Decimal:
        """Gross exposure = Long_Value + Short_Value."""
        return self.long_value + self.short_value

    @property
    def net_exposure(self) -> Decimal:
        """Net exposure = Long_Value - Short_Value."""
        return self.long_value - self.short_value

    @property
    def equity(self) -> Decimal:
        """
        Total equity.

        Equity = Cash + Long_Value - Short_Value
        """
        return self.cash + self.long_value - self.short_value

    @property
    def total_realized_pnl(self) -> Decimal:
        """Total realized P&L across all positions."""
        return sum(pos.realized_pnl for pos in self.positions.values())

    @property
    def total_unrealized_pnl(self) -> Decimal:
        """Total unrealized P&L across all positions."""
        return sum(pos.unrealized_pnl for pos in self.positions.values())

    @property
    def total_pnl(self) -> Decimal:
        """Total P&L (realized + unrealized)."""
        return self.total_realized_pnl + self.total_unrealized_pnl

    @property
    def return_pct(self) -> Decimal:
        """Return percentage based on initial capital."""
        if self.initial_capital == Decimal("0"):
            return Decimal("0")
        return (self.equity - self.initial_capital) / self.initial_capital

    def get_position(self, symbol: str) -> Position | None:
        """Get position for a symbol."""
        return self.positions.get(symbol)

    def get_quantity(self, symbol: str) -> Decimal:
        """Get position quantity (0 if no position)."""
        pos = self.positions.get(symbol)
        return pos.quantity if pos else Decimal("0")

    def update_prices(self, prices: dict[str, Decimal]) -> None:
        """Update all position prices."""
        for symbol, price in prices.items():
            if symbol in self.positions:
                self.positions[symbol].update_price(price)

    def update_market_price(self, symbol: str, price: Decimal) -> None:
        """Update market price for a single symbol."""
        if symbol in self.positions:
            self.positions[symbol].update_price(price)

    def update_position(
        self,
        symbol: str,
        quantity: Decimal,
        avg_cost: Decimal,
        side: PositionSide = PositionSide.LONG,
    ) -> None:
        """
        Update or create a position.

        Args:
            symbol: Security symbol
            quantity: Position quantity (always positive, side determines direction)
            avg_cost: Average cost/entry price
            side: Position side (LONG or SHORT)
        """
        # Adjust quantity sign based on side
        actual_qty = quantity if side == PositionSide.LONG else -abs(quantity)

        if symbol in self.positions:
            pos = self.positions[symbol]
            pos.quantity = actual_qty
            pos.avg_cost = avg_cost
        else:
            self.positions[symbol] = Position(
                symbol=symbol,
                quantity=actual_qty,
                avg_cost=avg_cost,
                side=side,
            )

    def apply_fill(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        commission: Decimal = Decimal("0"),
        timestamp: datetime | None = None,
    ) -> Decimal:
        """
        Apply a fill to the portfolio.

        Args:
            symbol: Security symbol
            quantity: Fill quantity (positive=buy, negative=sell)
            price: Fill price
            commission: Commission amount
            timestamp: Fill timestamp

        Returns:
            Realized P&L if position reduced
        """
        realized_pnl = Decimal("0")

        # Update cash
        notional = quantity * price
        self.cash -= notional  # Buy reduces cash, sell increases
        self.cash -= commission  # Commission always reduces cash

        # Update position
        if symbol not in self.positions:
            # New position
            self.positions[symbol] = Position(
                symbol=symbol,
                quantity=quantity,
                avg_cost=price,
                opened_at=timestamp,
            )
        else:
            pos = self.positions[symbol]

            # Check if increasing or reducing position
            if pos.is_flat:
                # Opening new position
                pos.quantity = quantity
                pos.avg_cost = price
                pos.opened_at = timestamp
            elif (pos.is_long and quantity > 0) or (pos.is_short and quantity < 0):
                # Adding to position
                pos.add_to_position(quantity, price, timestamp)
            else:
                # Reducing or flipping position
                if abs(quantity) <= abs(pos.quantity):
                    # Partial or full close
                    realized_pnl = pos.reduce_position(quantity, price)
                else:
                    # Close and flip
                    close_qty = -pos.quantity
                    flip_qty = quantity + pos.quantity

                    realized_pnl = pos.reduce_position(close_qty, price)

                    # New position in opposite direction
                    pos.quantity = flip_qty
                    pos.avg_cost = price
                    pos.opened_at = timestamp

            # Remove flat positions
            if pos.is_flat:
                del self.positions[symbol]

        # FIX-H5: Update last_price so equity is immediately correct after fill
        if symbol in self.positions:
            self.positions[symbol].update_price(price)

        return realized_pnl

    def validate_equity_identity(
        self,
        prices: dict[str, Decimal] | None = None,
        tolerance: Decimal = Decimal("0.01"),
    ) -> bool:
        """
        Validate the equity identity against independent price source.

        FIX-H5: If prices dict is provided, computes equity independently
        and compares against self.equity.  Otherwise verifies internal
        consistency of position-level values.

        Args:
            prices: Optional independent prices {symbol: price}
            tolerance: Maximum allowed deviation
        """
        if prices is not None:
            independent_equity = self.cash
            for sym, pos in self.positions.items():
                p = prices.get(sym, pos.last_price)
                independent_equity += pos.quantity * p
            return abs(independent_equity - self.equity) < tolerance

        # Fallback: verify position-level values sum correctly
        expected_long = sum(
            pos.market_value for pos in self.positions.values()
            if pos.is_long
        )
        expected_short = sum(
            abs(pos.market_value) for pos in self.positions.values()
            if pos.is_short
        )
        return (
            abs(expected_long - self.long_value) < tolerance
            and abs(expected_short - self.short_value) < tolerance
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "cash": str(self.cash),
            "equity": str(self.equity),
            "long_value": str(self.long_value),
            "short_value": str(self.short_value),
            "gross_exposure": str(self.gross_exposure),
            "net_exposure": str(self.net_exposure),
            "realized_pnl": str(self.total_realized_pnl),
            "unrealized_pnl": str(self.total_unrealized_pnl),
            "initial_capital": str(self.initial_capital),
            "total_deposits": str(self.total_deposits),
            "total_withdrawals": str(self.total_withdrawals),
            "session_id": self.session_id,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "positions": {
                symbol: pos.to_dict()
                for symbol, pos in self.positions.items()
            },
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PortfolioState":
        """Create PortfolioState from dictionary.

        Required for restoring checkpointed/serialized state.
        """
        timestamp = None
        if data.get("timestamp"):
            timestamp = datetime.fromisoformat(data["timestamp"])

        # Restore positions
        positions: dict[str, Position] = {}
        positions_data = data.get("positions", {})
        for symbol, pos_data in positions_data.items():
            positions[symbol] = Position.from_dict(pos_data)

        return cls(
            cash=Decimal(data["cash"]),
            positions=positions,
            timestamp=timestamp,
            initial_capital=Decimal(data.get("initial_capital", "0")),
            total_deposits=Decimal(data.get("total_deposits", "0")),
            total_withdrawals=Decimal(data.get("total_withdrawals", "0")),
            session_id=data.get("session_id", ""),
        )


class PortfolioSnapshot:
    """
    Immutable portfolio snapshot for history tracking.

    Used to record portfolio state at specific points in time.
    """

    def __init__(self, state: PortfolioState, timestamp: datetime) -> None:
        self.timestamp = timestamp
        self.cash = state.cash
        self.equity = state.equity
        self.long_value = state.long_value
        self.short_value = state.short_value
        self.gross_exposure = state.gross_exposure
        self.net_exposure = state.net_exposure
        self.realized_pnl = state.total_realized_pnl
        self.unrealized_pnl = state.total_unrealized_pnl
        self.positions = {
            symbol: Position(
                symbol=pos.symbol,
                quantity=pos.quantity,
                avg_cost=pos.avg_cost,
                realized_pnl=pos.realized_pnl,
                unrealized_pnl=pos.unrealized_pnl,
                last_price=pos.last_price,
            )
            for symbol, pos in state.positions.items()
        }


class PortfolioHistory:
    """Track portfolio state over time."""

    def __init__(self) -> None:
        self._snapshots: list[PortfolioSnapshot] = []

    def record(self, state: PortfolioState, timestamp: datetime) -> None:
        """Record a portfolio snapshot."""
        self._snapshots.append(PortfolioSnapshot(state, timestamp))

    @property
    def equity_curve(self) -> list[tuple[datetime, Decimal]]:
        """Get equity curve as (timestamp, equity) pairs."""
        return [(s.timestamp, s.equity) for s in self._snapshots]

    @property
    def cash_curve(self) -> list[tuple[datetime, Decimal]]:
        """Get cash curve."""
        return [(s.timestamp, s.cash) for s in self._snapshots]

    @property
    def exposure_curve(self) -> list[tuple[datetime, Decimal, Decimal]]:
        """Get exposure curve as (timestamp, long, short) triples."""
        return [(s.timestamp, s.long_value, s.short_value) for s in self._snapshots]

    def __len__(self) -> int:
        return len(self._snapshots)

    def __getitem__(self, index: int) -> PortfolioSnapshot:
        return self._snapshots[index]
