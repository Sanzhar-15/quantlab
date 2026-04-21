"""
Position Tracking System.

Tracks positions, calculates P&L, and manages position state.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

import logging
import threading
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from typing import Any
from typing import Callable


logger = logging.getLogger(__name__)

from quantlab.precision.policy import AssetClass, PrecisionPolicy

from .orders import Fill
from .orders import OrderSide


# Default precision policy (US equities)
_DEFAULT_PRECISION = PrecisionPolicy.for_asset_class(AssetClass.EQUITY_US)


@dataclass
class Position:
    """
    Represents a position in a symbol.

    Tracks quantity, average price, and P&L.
    All prices and quantities are validated against PrecisionPolicy (per §14.5).
    """

    symbol: str
    session_id: str

    # Position state
    quantity: Decimal = Decimal("0")
    avg_entry_price: Decimal = Decimal("0")

    # P&L tracking
    realized_pnl: Decimal = Decimal("0")
    unrealized_pnl: Decimal = Decimal("0")
    total_commission: Decimal = Decimal("0")

    # Market data (updated externally)
    current_price: Decimal | None = None

    # Timestamps
    opened_at: datetime | None = None
    last_update: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    # Trade tracking
    entry_count: int = 0
    exit_count: int = 0

    # Precision policy for this position's asset class (per §14.5)
    precision_policy: PrecisionPolicy = field(default_factory=lambda: _DEFAULT_PRECISION)

    @property
    def is_long(self) -> bool:
        """Check if position is long."""
        return self.quantity > 0

    @property
    def is_short(self) -> bool:
        """Check if position is short."""
        return self.quantity < 0

    @property
    def is_flat(self) -> bool:
        """Check if position is flat (no exposure)."""
        return self.quantity == 0

    @property
    def market_value(self) -> Decimal:
        """Get current market value of position."""
        if self.current_price is None:
            return Decimal("0")
        return abs(self.quantity) * self.current_price

    @property
    def cost_basis(self) -> Decimal:
        """Get total cost basis of position."""
        return abs(self.quantity) * self.avg_entry_price

    @property
    def total_pnl(self) -> Decimal:
        """Get total P&L (realized + unrealized)."""
        return self.realized_pnl + self.unrealized_pnl

    @property
    def total_pnl_percent(self) -> float:
        """Get total P&L as percentage."""
        if self.cost_basis == 0:
            return 0.0
        return float(self.total_pnl / self.cost_basis * 100)

    def update_price(self, price: Decimal) -> None:
        """
        Update current price and recalculate unrealized P&L.

        Args:
            price: Current market price
        """
        self.current_price = price
        self.last_update = datetime.now(timezone.utc)

        if self.is_flat:
            self.unrealized_pnl = Decimal("0")
        else:
            # Calculate unrealized P&L
            if self.is_long:
                self.unrealized_pnl = (
                    self.quantity * (price - self.avg_entry_price)
                )
            else:
                # Short position: profit when price falls
                self.unrealized_pnl = (
                    abs(self.quantity) * (self.avg_entry_price - price)
                )

    def apply_fill(self, fill: Fill, side: OrderSide) -> Decimal:
        """
        Apply a fill to the position.

        Validates and rounds prices/quantities per precision policy (§14.5).

        Args:
            fill: Fill to apply
            side: Order side (buy or sell)

        Returns:
            Realized P&L from this fill
        """
        realized = Decimal("0")

        # Validate and round fill data per precision policy (§14.5)
        qty = self.precision_policy.round_quantity(fill.quantity)
        price = self.precision_policy.round_price(fill.price)
        commission = self.precision_policy.round_price(fill.commission)

        # Track commission
        self.total_commission += commission

        # Determine if this is opening or closing
        if side == OrderSide.BUY:
            if self.quantity >= 0:
                # Adding to long position
                realized = self._add_to_position(qty, price)
                self.entry_count += 1
            else:
                # Closing short position
                realized = self._reduce_position(qty, price)
                self.exit_count += 1
        else:  # SELL
            if self.quantity <= 0:
                # Adding to short position
                realized = self._add_to_position(-qty, price)
                self.entry_count += 1
            else:
                # Closing long position
                realized = self._reduce_position(qty, price)
                self.exit_count += 1

        self.realized_pnl += realized
        self.last_update = datetime.now(timezone.utc)

        # Update opened_at timestamp
        if self.opened_at is None and not self.is_flat:
            self.opened_at = datetime.now(timezone.utc)
        elif self.is_flat:
            self.opened_at = None

        # Recalculate unrealized P&L
        if self.current_price is not None:
            self.update_price(self.current_price)

        return realized

    def _add_to_position(self, qty: Decimal, price: Decimal) -> Decimal:
        """
        Add to current position (same direction).

        Args:
            qty: Quantity to add (positive for long, negative for short)
            price: Entry price

        Returns:
            Realized P&L (always 0 for adding)
        """
        if self.quantity == 0:
            # Opening new position
            self.quantity = qty
            self.avg_entry_price = price
        else:
            # Average into position
            total_cost = (
                abs(self.quantity) * self.avg_entry_price +
                abs(qty) * price
            )
            new_quantity = self.quantity + qty
            if new_quantity != 0:
                self.avg_entry_price = total_cost / abs(new_quantity)
            self.quantity = new_quantity

        return Decimal("0")

    def _reduce_position(self, qty: Decimal, price: Decimal) -> Decimal:
        """
        Reduce current position (opposite direction).

        Args:
            qty: Quantity to reduce (always positive)
            price: Exit price

        Returns:
            Realized P&L
        """
        # Save original position state BEFORE mutation
        original_quantity = self.quantity
        was_long = self.is_long
        was_short = self.is_short

        # Calculate realized P&L only on the closed portion
        close_qty = min(qty, abs(original_quantity))

        if was_long:
            realized = close_qty * (price - self.avg_entry_price)
            self.quantity -= qty
        else:
            realized = close_qty * (self.avg_entry_price - price)
            self.quantity += qty

        # Check if we've crossed to opposite side (position flip)
        position_flipped = (was_long and self.is_short) or (was_short and self.is_long)
        if position_flipped:
            # The flip portion is at the new price
            self.avg_entry_price = price

        # If flat, reset avg price
        if self.is_flat:
            self.avg_entry_price = Decimal("0")

        return realized

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "sessionId": self.session_id,
            "quantity": float(self.quantity),
            "avgEntryPrice": float(self.avg_entry_price),
            "currentPrice": float(self.current_price) if self.current_price else None,
            "marketValue": float(self.market_value),
            "costBasis": float(self.cost_basis),
            "realizedPnl": float(self.realized_pnl),
            "unrealizedPnl": float(self.unrealized_pnl),
            "totalPnl": float(self.total_pnl),
            "totalPnlPercent": self.total_pnl_percent,
            "totalCommission": float(self.total_commission),
            "isLong": self.is_long,
            "isShort": self.is_short,
            "isFlat": self.is_flat,
            "entryCount": self.entry_count,
            "exitCount": self.exit_count,
            "openedAt": self.opened_at.isoformat() if self.opened_at else None,
            "lastUpdate": self.last_update.isoformat(),
        }


@dataclass
class PositionSummary:
    """Aggregated position summary for a session."""

    session_id: str
    total_positions: int = 0
    long_positions: int = 0
    short_positions: int = 0
    total_market_value: Decimal = Decimal("0")
    total_realized_pnl: Decimal = Decimal("0")
    total_unrealized_pnl: Decimal = Decimal("0")
    total_commission: Decimal = Decimal("0")

    @property
    def total_pnl(self) -> Decimal:
        """Get total P&L."""
        return self.total_realized_pnl + self.total_unrealized_pnl

    @property
    def net_pnl(self) -> Decimal:
        """Get net P&L after commission."""
        return self.total_pnl - self.total_commission

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "sessionId": self.session_id,
            "totalPositions": self.total_positions,
            "longPositions": self.long_positions,
            "shortPositions": self.short_positions,
            "totalMarketValue": float(self.total_market_value),
            "totalRealizedPnl": float(self.total_realized_pnl),
            "totalUnrealizedPnl": float(self.total_unrealized_pnl),
            "totalPnl": float(self.total_pnl),
            "totalCommission": float(self.total_commission),
            "netPnl": float(self.net_pnl),
        }


class PositionTracker:
    """
    Tracks positions across trading sessions.

    Manages position state, updates, and aggregation.
    """

    def __init__(self) -> None:
        """Initialize position tracker."""
        # positions[session_id][symbol] = Position
        self._positions: dict[str, dict[str, Position]] = {}
        self._lock = threading.Lock()

        # Event callbacks
        self._on_position_update: list[Callable[[Position], None]] = []
        self._on_pnl_change: list[Callable[[str, Decimal], None]] = []

    def get_position(
        self,
        session_id: str,
        symbol: str,
    ) -> Position | None:
        """Get position for a symbol in a session."""
        with self._lock:
            session_positions = self._positions.get(session_id, {})
            return session_positions.get(symbol)

    def get_or_create_position(
        self,
        session_id: str,
        symbol: str,
    ) -> Position:
        """Get or create a position for a symbol."""
        with self._lock:
            if session_id not in self._positions:
                self._positions[session_id] = {}

            if symbol not in self._positions[session_id]:
                self._positions[session_id][symbol] = Position(
                    symbol=symbol,
                    session_id=session_id,
                )

            return self._positions[session_id][symbol]

    def get_positions_for_session(
        self,
        session_id: str,
        include_flat: bool = False,
    ) -> list[Position]:
        """
        Get all positions for a session.

        Args:
            session_id: Session ID
            include_flat: Whether to include flat positions

        Returns:
            List of positions
        """
        with self._lock:
            positions = list(self._positions.get(session_id, {}).values())
            if not include_flat:
                positions = [p for p in positions if not p.is_flat]
            return positions

    def get_all_positions(
        self,
        include_flat: bool = False,
    ) -> list[Position]:
        """Get all positions across all sessions."""
        with self._lock:
            all_positions = []
            for session_positions in self._positions.values():
                for position in session_positions.values():
                    if include_flat or not position.is_flat:
                        all_positions.append(position)
            return all_positions

    def apply_fill(
        self,
        session_id: str,
        symbol: str,
        fill: Fill,
        side: OrderSide,
    ) -> Decimal:
        """
        Apply a fill to a position.

        Args:
            session_id: Session ID
            symbol: Symbol
            fill: Fill to apply
            side: Order side

        Returns:
            Realized P&L from the fill
        """
        position = self.get_or_create_position(session_id, symbol)
        realized = position.apply_fill(fill, side)

        self._notify_position_update(position)
        if realized != 0:
            self._notify_pnl_change(session_id, realized)

        return realized

    def update_price(
        self,
        session_id: str,
        symbol: str,
        price: Decimal,
    ) -> None:
        """
        Update the current price for a position.

        Args:
            session_id: Session ID
            symbol: Symbol
            price: Current market price
        """
        position = self.get_position(session_id, symbol)
        if position is not None:
            position.update_price(price)
            self._notify_position_update(position)

    def update_all_prices(
        self,
        session_id: str,
        prices: dict[str, Decimal],
    ) -> None:
        """
        Update prices for multiple positions.

        Args:
            session_id: Session ID
            prices: Map of symbol to price
        """
        with self._lock:
            session_positions = self._positions.get(session_id, {})
            for symbol, price in prices.items():
                if symbol in session_positions:
                    position = session_positions[symbol]
                    position.update_price(price)
                    self._notify_position_update(position)

    def get_summary(self, session_id: str) -> PositionSummary:
        """
        Get aggregated position summary for a session.

        Args:
            session_id: Session ID

        Returns:
            Position summary
        """
        positions = self.get_positions_for_session(session_id, include_flat=False)

        summary = PositionSummary(session_id=session_id)
        summary.total_positions = len(positions)

        for position in positions:
            if position.is_long:
                summary.long_positions += 1
            elif position.is_short:
                summary.short_positions += 1

            summary.total_market_value += position.market_value
            summary.total_realized_pnl += position.realized_pnl
            summary.total_unrealized_pnl += position.unrealized_pnl
            summary.total_commission += position.total_commission

        return summary

    def close_all_positions(
        self,
        session_id: str,
        prices: dict[str, Decimal],
    ) -> Decimal:
        """
        Close all positions at given prices (for simulation).

        Args:
            session_id: Session ID
            prices: Map of symbol to closing price

        Returns:
            Total realized P&L from closing
        """
        total_realized = Decimal("0")
        positions = self.get_positions_for_session(session_id, include_flat=False)

        for position in positions:
            if position.symbol in prices:
                price = prices[position.symbol]
                # Create a closing fill
                qty = abs(position.quantity)
                fill = Fill(
                    fill_id=f"close-{position.symbol}",
                    order_id="close",
                    quantity=qty,
                    price=price,
                    timestamp=datetime.now(timezone.utc),
                )

                # Determine closing side
                if position.is_long:
                    side = OrderSide.SELL
                else:
                    side = OrderSide.BUY

                realized = position.apply_fill(fill, side)
                total_realized += realized
                self._notify_position_update(position)

        if total_realized != 0:
            self._notify_pnl_change(session_id, total_realized)

        return total_realized

    def clear_session(self, session_id: str) -> None:
        """Clear all positions for a session."""
        with self._lock:
            if session_id in self._positions:
                del self._positions[session_id]

    def on_position_update(
        self,
        callback: Callable[[Position], None],
    ) -> None:
        """Register position update callback."""
        self._on_position_update.append(callback)

    def on_pnl_change(
        self,
        callback: Callable[[str, Decimal], None],
    ) -> None:
        """Register P&L change callback."""
        self._on_pnl_change.append(callback)

    def _notify_position_update(self, position: Position) -> None:
        """Notify position update listeners."""
        for callback in self._on_position_update:
            try:
                callback(position)
            except Exception as e:
                logger.warning(
                    f"Position update callback failed for {position.symbol}: {e}",
                    exc_info=True,
                )

    def _notify_pnl_change(
        self,
        session_id: str,
        realized_pnl: Decimal,
    ) -> None:
        """Notify P&L change listeners."""
        for callback in self._on_pnl_change:
            try:
                callback(session_id, realized_pnl)
            except Exception as e:
                logger.warning(
                    f"P&L change callback failed for session {session_id}: {e}",
                    exc_info=True,
                )
