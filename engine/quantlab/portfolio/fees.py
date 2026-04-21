"""
Fee Management.

Handles various portfolio-related fees including borrow fees, margin interest, and account fees.

Spec Reference: Technical Spec §4.3
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from decimal import Decimal
from enum import Enum
from typing import Any


class FeeType(Enum):
    """Types of portfolio fees."""

    BORROW_FEE = "borrow_fee"  # Stock borrow fee for shorts
    MARGIN_INTEREST = "margin_interest"  # Interest on margin borrowing
    ACCOUNT_FEE = "account_fee"  # Monthly/annual account fees
    INACTIVITY_FEE = "inactivity_fee"  # Inactivity fee
    DATA_FEE = "data_fee"  # Market data subscription
    PLATFORM_FEE = "platform_fee"  # Platform access fee
    ADR_FEE = "adr_fee"  # ADR custody fee
    SEC_FEE = "sec_fee"  # SEC regulatory fee
    TAF_FEE = "taf_fee"  # Trading Activity Fee
    DIVIDEND_TAX = "dividend_tax"  # Dividend withholding tax


@dataclass
class FeeRecord:
    """Record of a fee charge."""

    fee_type: FeeType
    amount: Decimal
    timestamp: datetime
    description: str = ""
    symbol: str | None = None
    reference_value: Decimal | None = None  # Value used to calculate fee


@dataclass
class BorrowFeeSchedule:
    """
    Borrow fee schedule for a symbol.

    Supports tiered rates based on loan value.
    """

    symbol: str
    base_rate: Decimal  # Annual rate (e.g., 0.02 = 2%)
    hard_to_borrow_premium: Decimal = Decimal("0")  # Additional rate if HTB
    is_hard_to_borrow: bool = False
    tiered_rates: list[tuple[Decimal, Decimal]] = field(default_factory=list)
    # [(threshold, rate), ...] - value thresholds in ascending order

    @property
    def effective_rate(self) -> Decimal:
        """Get effective annual rate."""
        rate = self.base_rate
        if self.is_hard_to_borrow:
            rate += self.hard_to_borrow_premium
        return rate

    def get_rate_for_value(self, loan_value: Decimal) -> Decimal:
        """Get rate based on loan value tiers."""
        if not self.tiered_rates:
            return self.effective_rate

        for threshold, rate in reversed(self.tiered_rates):
            if loan_value >= threshold:
                return rate

        return self.effective_rate


class BorrowFeeCalculator:
    """
    Calculate borrow fees for short positions.

    Fees are calculated daily and accrued.
    """

    def __init__(
        self,
        default_rate: Decimal = Decimal("0.02"),  # 2% annual
        day_count: int = 365,  # 365 or 360
    ) -> None:
        """
        Initialize borrow fee calculator.

        Args:
            default_rate: Default annual borrow rate
            day_count: Days per year for rate calculation
        """
        self.default_rate = default_rate
        self.day_count = Decimal(str(day_count))
        self._schedules: dict[str, BorrowFeeSchedule] = {}

    def set_schedule(self, schedule: BorrowFeeSchedule) -> None:
        """Set borrow fee schedule for a symbol."""
        self._schedules[schedule.symbol] = schedule

    def get_rate(self, symbol: str) -> Decimal:
        """Get annual borrow rate for a symbol."""
        if symbol in self._schedules:
            return self._schedules[symbol].effective_rate
        return self.default_rate

    def calculate_daily_fee(
        self,
        symbol_or_position: "str | Any",
        quantity: Decimal | None = None,
        price: Decimal | None = None,
    ) -> Decimal:
        """
        Calculate daily borrow fee.

        Fee = Quantity * Price * Annual_Rate / Days_Per_Year

        Can be called with either:
        - calculate_daily_fee(symbol, quantity, price)
        - calculate_daily_fee(short_position)  # ShortPosition object
        """
        # Handle ShortPosition object (test compatibility)
        if hasattr(symbol_or_position, 'symbol') and hasattr(symbol_or_position, 'quantity'):
            position = symbol_or_position
            symbol = position.symbol
            qty = position.quantity
            # Use entry_price for loan value calculation
            prc = position.entry_price
            # Use position's borrow_rate if available
            rate = getattr(position, 'borrow_rate', self.default_rate)
            loan_value = qty * prc
            daily_rate = rate / self.day_count
            return loan_value * daily_rate

        # Standard call with symbol, quantity, price
        symbol = symbol_or_position
        if quantity is None or price is None:
            raise ValueError("quantity and price required when symbol is a string")

        loan_value = quantity * price
        rate = self.get_rate(symbol)

        if symbol in self._schedules:
            rate = self._schedules[symbol].get_rate_for_value(loan_value)

        daily_rate = rate / self.day_count
        return loan_value * daily_rate

    def calculate_period_fee(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        days: int,
    ) -> Decimal:
        """Calculate borrow fee for a period."""
        daily_fee = self.calculate_daily_fee(symbol, quantity, price)
        return daily_fee * Decimal(str(days))


class MarginInterestCalculator:
    """
    Calculate margin interest on borrowed cash.

    Applies when portfolio borrows cash (negative cash balance).
    """

    def __init__(
        self,
        base_rate: Decimal = Decimal("0.085"),  # 8.5% base
        spread: Decimal = Decimal("0.01"),  # 1% spread over base
        day_count: int = 360,
    ) -> None:
        """
        Initialize margin interest calculator.

        Args:
            base_rate: Base interest rate (e.g., Fed Funds + spread)
            spread: Additional spread over base
            day_count: Days per year for calculation
        """
        self.base_rate = base_rate
        self.spread = spread
        self.day_count = Decimal(str(day_count))

        # Tiered rates based on debit balance
        self._tiers: list[tuple[Decimal, Decimal]] = [
            # (min_balance, rate_reduction)
            (Decimal("0"), Decimal("0")),
            (Decimal("25000"), Decimal("0.005")),  # 0.5% reduction
            (Decimal("100000"), Decimal("0.01")),  # 1% reduction
            (Decimal("1000000"), Decimal("0.015")),  # 1.5% reduction
        ]

    def get_rate(self, debit_balance: Decimal) -> Decimal:
        """Get interest rate based on debit balance."""
        base = self.base_rate + self.spread

        reduction = Decimal("0")
        for threshold, tier_reduction in reversed(self._tiers):
            if debit_balance >= threshold:
                reduction = tier_reduction
                break

        return base - reduction

    def calculate_daily_interest(self, debit_balance: Decimal) -> Decimal:
        """Calculate daily margin interest."""
        if debit_balance <= Decimal("0"):
            return Decimal("0")

        rate = self.get_rate(debit_balance)
        daily_rate = rate / self.day_count
        return debit_balance * daily_rate

    def calculate_period_interest(
        self,
        debit_balance: Decimal,
        days: int,
    ) -> Decimal:
        """Calculate margin interest for a period."""
        daily = self.calculate_daily_interest(debit_balance)
        return daily * Decimal(str(days))


class RegulatoryFeeCalculator:
    """
    Calculate regulatory fees (SEC, TAF, etc.).

    These fees are typically charged on sell transactions.
    """

    def __init__(
        self,
        sec_rate: Decimal = Decimal("0.0000278"),  # $27.80 per million
        taf_rate: Decimal = Decimal("0.000166"),  # $0.000166 per share
        taf_max: Decimal = Decimal("8.30"),  # Max TAF per trade
    ) -> None:
        """
        Initialize regulatory fee calculator.

        Rates are updated periodically by regulators.
        """
        self.sec_rate = sec_rate
        self.taf_rate = taf_rate
        self.taf_max = taf_max

    def calculate_sec_fee(
        self,
        notional_value: Decimal,
        is_sell: bool,
    ) -> Decimal:
        """
        Calculate SEC fee.

        SEC fee only applies to sell transactions.
        """
        if not is_sell:
            return Decimal("0")

        fee = notional_value * self.sec_rate
        # Round up to nearest cent
        return (fee * 100).to_integral_value() / 100

    def calculate_taf_fee(
        self,
        quantity: Decimal,
        is_sell: bool,
    ) -> Decimal:
        """
        Calculate Trading Activity Fee (TAF).

        TAF only applies to sell transactions.
        """
        if not is_sell:
            return Decimal("0")

        fee = quantity * self.taf_rate
        return min(fee, self.taf_max)

    def calculate_total(
        self,
        quantity: Decimal,
        price: Decimal,
        is_sell: bool,
    ) -> Decimal:
        """Calculate total regulatory fees."""
        notional = quantity * price
        sec = self.calculate_sec_fee(notional, is_sell)
        taf = self.calculate_taf_fee(quantity, is_sell)
        return sec + taf


class FeeManager:
    """
    Central fee management.

    Tracks and accrues all portfolio fees.
    """

    def __init__(
        self,
        borrow_calculator: BorrowFeeCalculator | None = None,
        margin_calculator: MarginInterestCalculator | None = None,
        regulatory_calculator: RegulatoryFeeCalculator | None = None,
    ) -> None:
        """Initialize fee manager with calculators."""
        self.borrow_calculator = borrow_calculator or BorrowFeeCalculator()
        self.margin_calculator = margin_calculator or MarginInterestCalculator()
        self.regulatory_calculator = regulatory_calculator or RegulatoryFeeCalculator()

        self._fee_history: list[FeeRecord] = []
        self._accrued_by_type: dict[FeeType, Decimal] = {ft: Decimal("0") for ft in FeeType}
        self._accrued_by_symbol: dict[str, Decimal] = {}

    def record_fee(self, record: FeeRecord) -> None:
        """Record a fee charge."""
        self._fee_history.append(record)
        self._accrued_by_type[record.fee_type] += record.amount

        if record.symbol:
            current = self._accrued_by_symbol.get(record.symbol, Decimal("0"))
            self._accrued_by_symbol[record.symbol] = current + record.amount

    def accrue_daily_borrow_fees(
        self,
        short_positions: dict[str, tuple[Decimal, Decimal]],  # symbol -> (qty, price)
        timestamp: datetime,
    ) -> Decimal:
        """
        Accrue daily borrow fees for all short positions.

        Returns total fees accrued.
        """
        total = Decimal("0")

        for symbol, (quantity, price) in short_positions.items():
            fee = self.borrow_calculator.calculate_daily_fee(symbol, quantity, price)
            total += fee

            self.record_fee(FeeRecord(
                fee_type=FeeType.BORROW_FEE,
                amount=fee,
                timestamp=timestamp,
                symbol=symbol,
                description=f"Daily borrow fee for {quantity} shares of {symbol}",
                reference_value=quantity * price,
            ))

        return total

    def accrue_daily_margin_interest(
        self,
        debit_balance: Decimal,
        timestamp: datetime,
    ) -> Decimal:
        """
        Accrue daily margin interest.

        Returns interest accrued.
        """
        if debit_balance <= Decimal("0"):
            return Decimal("0")

        interest = self.margin_calculator.calculate_daily_interest(debit_balance)

        self.record_fee(FeeRecord(
            fee_type=FeeType.MARGIN_INTEREST,
            amount=interest,
            timestamp=timestamp,
            description=f"Daily margin interest on ${debit_balance}",
            reference_value=debit_balance,
        ))

        return interest

    def calculate_trade_fees(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        is_sell: bool,
        timestamp: datetime,
    ) -> Decimal:
        """
        Calculate and record regulatory fees for a trade.

        Returns total regulatory fees.
        """
        total = self.regulatory_calculator.calculate_total(quantity, price, is_sell)

        if total > Decimal("0"):
            self.record_fee(FeeRecord(
                fee_type=FeeType.SEC_FEE,
                amount=total,
                timestamp=timestamp,
                symbol=symbol,
                description=f"Regulatory fees for {'sell' if is_sell else 'buy'} of {quantity} {symbol}",
                reference_value=quantity * price,
            ))

        return total

    def get_total_fees(self) -> Decimal:
        """Get total fees accrued."""
        return sum(self._accrued_by_type.values())

    def get_fees_by_type(self, fee_type: FeeType) -> Decimal:
        """Get fees by type."""
        return self._accrued_by_type.get(fee_type, Decimal("0"))

    def get_fees_by_symbol(self, symbol: str) -> Decimal:
        """Get fees by symbol."""
        return self._accrued_by_symbol.get(symbol, Decimal("0"))

    def get_fee_history(
        self,
        fee_type: FeeType | None = None,
        symbol: str | None = None,
    ) -> list[FeeRecord]:
        """Get fee history with optional filters."""
        records = self._fee_history

        if fee_type:
            records = [r for r in records if r.fee_type == fee_type]

        if symbol:
            records = [r for r in records if r.symbol == symbol]

        return records

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "total_fees": str(self.get_total_fees()),
            "by_type": {
                ft.value: str(amount)
                for ft, amount in self._accrued_by_type.items()
                if amount != Decimal("0")
            },
            "by_symbol": {
                symbol: str(amount)
                for symbol, amount in self._accrued_by_symbol.items()
            },
        }
