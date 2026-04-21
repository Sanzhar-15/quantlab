"""
Short Selling Model.

Implements short selling with 100% collateral requirement and borrow tracking.

Spec Reference: Technical Spec §4.2
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from decimal import Decimal
from typing import Any


@dataclass
class ShortOpenResult:
    """Result of opening a short position."""
    success: bool
    position: "ShortPosition | None" = None
    error: str = ""
    collateral_required: Decimal = Decimal("0")


@dataclass
class ShortPosition:
    """
    Short position with collateral tracking.

    Collateral Model:
    - 100% collateral required (can be configured)
    - Collateral = Short_Value * collateral_ratio
    - As short gains, excess collateral can be released
    - As short loses, additional collateral required
    """

    symbol: str
    quantity: Decimal  # Always positive for short quantity
    entry_price: Decimal
    entry_date: datetime | None = None
    collateral_required: Decimal = Decimal("0")  # Cash set aside
    current_price: Decimal = Decimal("0")
    accrued_borrow_fee: Decimal = Decimal("0")
    borrow_rate: Decimal = Decimal("0.02")  # Annual borrow rate (test compatibility)

    @property
    def market_value(self) -> Decimal:
        """Current market value of short position."""
        return self.quantity * self.current_price

    @property
    def unrealized_pnl(self) -> Decimal:
        """Unrealized P&L (profit if price went down)."""
        return (self.entry_price - self.current_price) * self.quantity

    @property
    def equity_contribution(self) -> Decimal:
        """
        Net equity contribution.

        Collateral - Current_Value + Unrealized_PnL
        Simplifies to: Collateral - Current_Value + (Entry - Current) * Qty
        """
        return self.collateral_required - self.market_value + self.unrealized_pnl

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "quantity": str(self.quantity),
            "entry_price": str(self.entry_price),
            "entry_date": self.entry_date.isoformat(),
            "collateral_required": str(self.collateral_required),
            "current_price": str(self.current_price),
            "market_value": str(self.market_value),
            "unrealized_pnl": str(self.unrealized_pnl),
            "accrued_borrow_fee": str(self.accrued_borrow_fee),
        }


@dataclass
class ShortBorrow:
    """
    Track a borrowed security for short selling.

    Represents the borrow agreement with the lender.
    """

    symbol: str
    quantity: Decimal
    borrow_date: datetime
    rate: Decimal  # Annual rate (e.g., 0.02 = 2%)
    locate_id: str | None = None  # Borrow locate reference

    def daily_fee(self, price: Decimal) -> Decimal:
        """Calculate daily borrow fee."""
        # Daily fee = Quantity * Price * Annual_Rate / 365
        return (self.quantity * price * self.rate) / Decimal("365")

    def accrued_fee(
        self,
        price: Decimal,
        from_date: datetime,
        to_date: datetime,
    ) -> Decimal:
        """Calculate accrued fee for a period.

        FIX-M2: Uses fractional days via total_seconds() instead of
        integer-truncated timedelta.days, so intraday positions accrue
        proportional borrow fees.
        """
        total_seconds = Decimal(str((to_date - from_date).total_seconds()))
        if total_seconds <= Decimal("0"):
            return Decimal("0")
        fractional_days = total_seconds / Decimal("86400")
        return self.daily_fee(price) * fractional_days


class ShortSellingManager:
    """
    Manage short selling operations.

    Handles:
    - Collateral calculation and tracking
    - Borrow fee accrual
    - Short availability checks
    - Margin/collateral calls
    """

    def __init__(
        self,
        collateral_ratio: Decimal = Decimal("1.0"),  # 100%
        default_borrow_rate: Decimal = Decimal("0.02"),  # 2% annual
        min_collateral_ratio: Decimal = Decimal("0.5"),  # 50% maintenance
    ) -> None:
        """
        Initialize short selling manager.

        Args:
            collateral_ratio: Initial collateral requirement (1.0 = 100%)
            default_borrow_rate: Default annual borrow rate
            min_collateral_ratio: Minimum maintenance margin
        """
        self.collateral_ratio = collateral_ratio
        self.default_borrow_rate = default_borrow_rate
        self.min_collateral_ratio = min_collateral_ratio

        self._short_positions: dict[str, ShortPosition] = {}
        self._borrows: dict[str, ShortBorrow] = {}
        self._borrow_rates: dict[str, Decimal] = {}
        self._hard_to_borrow: set[str] = set()
        self._available_collateral: Decimal | None = None  # None = unlimited

    def set_available_collateral(self, amount: Decimal) -> None:
        """Set available collateral for short selling."""
        self._available_collateral = amount

    def set_borrow_rate(self, symbol: str, rate: Decimal) -> None:
        """Set borrow rate for a symbol."""
        self._borrow_rates[symbol] = rate

    def get_borrow_rate(self, symbol: str) -> Decimal:
        """Get borrow rate for a symbol."""
        return self._borrow_rates.get(symbol, self.default_borrow_rate)

    def mark_hard_to_borrow(self, symbol: str) -> None:
        """Mark a symbol as hard to borrow."""
        self._hard_to_borrow.add(symbol)

    def is_available_to_short(self, symbol: str) -> bool:
        """Check if symbol can be shorted."""
        return symbol not in self._hard_to_borrow

    def calculate_collateral(
        self,
        quantity: Decimal,
        price: Decimal,
    ) -> Decimal:
        """Calculate required collateral for a short."""
        return quantity * price * self.collateral_ratio

    def calculate_maintenance_collateral(
        self,
        quantity: Decimal,
        price: Decimal,
    ) -> Decimal:
        """Calculate minimum maintenance collateral."""
        return quantity * price * self.min_collateral_ratio

    def open_short(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        timestamp: datetime | None = None,
        locate_id: str | None = None,
    ) -> ShortOpenResult:
        """
        Open a new short position.

        Args:
            symbol: Security symbol
            quantity: Quantity to short (positive)
            price: Entry price
            timestamp: Open timestamp (defaults to now)
            locate_id: Borrow locate reference

        Returns:
            ShortOpenResult with success status and position
        """
        timestamp = timestamp or datetime.now()
        collateral = self.calculate_collateral(quantity, price)

        # Check collateral availability
        if self._available_collateral is not None:
            if collateral > self._available_collateral:
                return ShortOpenResult(
                    success=False,
                    error="Insufficient collateral available",
                    collateral_required=collateral,
                )

        if symbol in self._short_positions:
            # Add to existing short
            existing = self._short_positions[symbol]
            additional_collateral = collateral

            # Weighted average entry price
            total_qty = existing.quantity + quantity
            existing.entry_price = (
                (existing.entry_price * existing.quantity + price * quantity) / total_qty
            )
            existing.quantity = total_qty
            existing.collateral_required += additional_collateral

            # Update available collateral
            if self._available_collateral is not None:
                self._available_collateral -= additional_collateral

            return ShortOpenResult(
                success=True,
                position=existing,
                collateral_required=additional_collateral,
            )

        # New short position
        position = ShortPosition(
            symbol=symbol,
            quantity=quantity,
            entry_price=price,
            entry_date=timestamp,
            collateral_required=collateral,
            current_price=price,
            borrow_rate=self.get_borrow_rate(symbol),
        )

        self._short_positions[symbol] = position

        # Create borrow record
        rate = self.get_borrow_rate(symbol)
        self._borrows[symbol] = ShortBorrow(
            symbol=symbol,
            quantity=quantity,
            borrow_date=timestamp,
            rate=rate,
            locate_id=locate_id,
        )

        # Update available collateral
        if self._available_collateral is not None:
            self._available_collateral -= collateral

        return ShortOpenResult(
            success=True,
            position=position,
            collateral_required=collateral,
        )

    def close_short(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        timestamp: datetime,
    ) -> tuple[Decimal, Decimal, Decimal]:
        """
        Close (cover) a short position.

        Args:
            symbol: Security symbol
            quantity: Quantity to cover (positive)
            price: Cover price
            timestamp: Close timestamp

        Returns:
            Tuple of (realized_pnl, collateral_released, total_borrow_fee)
        """
        if symbol not in self._short_positions:
            raise ValueError(f"No short position in {symbol}")

        position = self._short_positions[symbol]

        # Calculate P&L
        close_qty = min(quantity, position.quantity)
        realized_pnl = (position.entry_price - price) * close_qty

        # Calculate collateral to release
        collateral_per_share = position.collateral_required / position.quantity
        collateral_released = collateral_per_share * close_qty

        # Calculate borrow fees
        borrow = self._borrows.get(symbol)
        borrow_fee = Decimal("0")
        if borrow:
            borrow_fee = borrow.accrued_fee(price, borrow.borrow_date, timestamp)
            borrow_fee = borrow_fee * (close_qty / position.quantity)

        # Update position
        position.quantity -= close_qty
        position.collateral_required -= collateral_released
        position.accrued_borrow_fee += borrow_fee

        if position.quantity == Decimal("0"):
            del self._short_positions[symbol]
            if symbol in self._borrows:
                del self._borrows[symbol]

        return realized_pnl, collateral_released, borrow_fee

    def update_price(self, symbol: str, price: Decimal) -> None:
        """Update current price for a short position."""
        if symbol in self._short_positions:
            self._short_positions[symbol].current_price = price

    def accrue_borrow_fees(
        self,
        timestamp: datetime,
        prices: dict[str, Decimal],
    ) -> dict[str, Decimal]:
        """
        Accrue borrow fees for all short positions.

        Args:
            timestamp: Current timestamp
            prices: Current prices

        Returns:
            Dictionary of symbol -> accrued fee
        """
        accrued = {}

        for symbol, borrow in self._borrows.items():
            if symbol in prices and symbol in self._short_positions:
                price = prices[symbol]
                daily_fee = borrow.daily_fee(price)
                accrued[symbol] = daily_fee
                self._short_positions[symbol].accrued_borrow_fee += daily_fee

        return accrued

    def check_margin_call(
        self,
        symbol: str,
        price: Decimal,
    ) -> tuple[bool, Decimal]:
        """
        Check if position requires additional collateral.

        Args:
            symbol: Security symbol
            price: Current price

        Returns:
            Tuple of (is_margin_call, additional_required)
        """
        if symbol not in self._short_positions:
            return False, Decimal("0")

        position = self._short_positions[symbol]

        # Calculate current collateral requirement
        current_value = position.quantity * price
        min_collateral = current_value * self.min_collateral_ratio

        # Check if below maintenance
        if position.collateral_required < min_collateral:
            # Need to bring back to initial ratio
            required = current_value * self.collateral_ratio
            additional = required - position.collateral_required
            return True, additional

        return False, Decimal("0")

    def get_total_short_value(self) -> Decimal:
        """Get total value of all short positions."""
        return sum(pos.market_value for pos in self._short_positions.values())

    def get_total_collateral(self) -> Decimal:
        """Get total collateral held for shorts."""
        return sum(pos.collateral_required for pos in self._short_positions.values())

    def get_total_unrealized_pnl(self) -> Decimal:
        """Get total unrealized P&L on shorts."""
        return sum(pos.unrealized_pnl for pos in self._short_positions.values())

    def get_total_borrow_fees(self) -> Decimal:
        """Get total accrued borrow fees."""
        return sum(pos.accrued_borrow_fee for pos in self._short_positions.values())

    def get_position(self, symbol: str) -> ShortPosition | None:
        """Get short position for a symbol."""
        return self._short_positions.get(symbol)

    @property
    def positions(self) -> dict[str, ShortPosition]:
        """Get all short positions."""
        return self._short_positions.copy()


@dataclass
class ShortSellingConfig:
    """Configuration for short selling."""

    allow_short: bool = True
    collateral_ratio: Decimal = Decimal("1.0")  # 100%
    min_collateral_ratio: Decimal = Decimal("0.5")  # 50% maintenance
    default_borrow_rate: Decimal = Decimal("0.02")  # 2% annual
    max_short_exposure: Decimal | None = None  # None = no limit
    require_locate: bool = False  # Require borrow locate before shorting
