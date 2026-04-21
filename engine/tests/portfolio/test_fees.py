"""
Tests for Fee Management.

Tests borrow fees, margin interest, and account fees.
"""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.portfolio.fees import (
    FeeType,
    FeeRecord,
    BorrowFeeSchedule,
    BorrowFeeCalculator,
    MarginInterestCalculator,
    RegulatoryFeeCalculator,
    FeeManager,
)


class TestFeeType:
    """Tests for FeeType enum."""

    def test_borrow_fee(self) -> None:
        """Test borrow fee type."""
        assert FeeType.BORROW_FEE.value == "borrow_fee"

    def test_margin_interest(self) -> None:
        """Test margin interest type."""
        assert FeeType.MARGIN_INTEREST.value == "margin_interest"

    def test_sec_fee(self) -> None:
        """Test SEC fee type."""
        assert FeeType.SEC_FEE.value == "sec_fee"


class TestFeeRecord:
    """Tests for FeeRecord dataclass."""

    def test_basic_record(self) -> None:
        """Test basic fee record creation."""
        record = FeeRecord(
            fee_type=FeeType.BORROW_FEE,
            amount=Decimal("10.50"),
            timestamp=datetime(2024, 1, 15, 10, 0),
        )
        assert record.fee_type == FeeType.BORROW_FEE
        assert record.amount == Decimal("10.50")
        assert record.description == ""

    def test_record_with_symbol(self) -> None:
        """Test fee record with symbol."""
        record = FeeRecord(
            fee_type=FeeType.BORROW_FEE,
            amount=Decimal("10.50"),
            timestamp=datetime(2024, 1, 15, 10, 0),
            symbol="AAPL",
            description="Daily borrow fee",
            reference_value=Decimal("100000"),
        )
        assert record.symbol == "AAPL"
        assert record.reference_value == Decimal("100000")


class TestBorrowFeeSchedule:
    """Tests for BorrowFeeSchedule dataclass."""

    def test_basic_schedule(self) -> None:
        """Test basic borrow fee schedule."""
        schedule = BorrowFeeSchedule(
            symbol="AAPL",
            base_rate=Decimal("0.02"),
        )
        assert schedule.symbol == "AAPL"
        assert schedule.base_rate == Decimal("0.02")
        assert schedule.is_hard_to_borrow is False

    def test_effective_rate_basic(self) -> None:
        """Test effective rate without HTB."""
        schedule = BorrowFeeSchedule(
            symbol="AAPL",
            base_rate=Decimal("0.02"),
        )
        assert schedule.effective_rate == Decimal("0.02")

    def test_effective_rate_htb(self) -> None:
        """Test effective rate with HTB premium."""
        schedule = BorrowFeeSchedule(
            symbol="GME",
            base_rate=Decimal("0.02"),
            hard_to_borrow_premium=Decimal("0.10"),
            is_hard_to_borrow=True,
        )
        assert schedule.effective_rate == Decimal("0.12")  # 2% + 10%

    def test_get_rate_for_value_no_tiers(self) -> None:
        """Test rate lookup without tiers."""
        schedule = BorrowFeeSchedule(
            symbol="AAPL",
            base_rate=Decimal("0.02"),
        )
        rate = schedule.get_rate_for_value(Decimal("100000"))
        assert rate == Decimal("0.02")

    def test_get_rate_for_value_with_tiers(self) -> None:
        """Test rate lookup with tiers."""
        schedule = BorrowFeeSchedule(
            symbol="AAPL",
            base_rate=Decimal("0.02"),
            tiered_rates=[
                (Decimal("10000"), Decimal("0.015")),
                (Decimal("100000"), Decimal("0.01")),
            ],
        )
        # Below first tier
        assert schedule.get_rate_for_value(Decimal("5000")) == Decimal("0.02")
        # First tier
        assert schedule.get_rate_for_value(Decimal("50000")) == Decimal("0.015")
        # Second tier
        assert schedule.get_rate_for_value(Decimal("200000")) == Decimal("0.01")


class TestBorrowFeeCalculator:
    """Tests for BorrowFeeCalculator class."""

    @pytest.fixture
    def calculator(self) -> BorrowFeeCalculator:
        """Create a borrow fee calculator."""
        return BorrowFeeCalculator(
            default_rate=Decimal("0.02"),
            day_count=365,
        )

    def test_init(self, calculator) -> None:
        """Test calculator initialization."""
        assert calculator.default_rate == Decimal("0.02")
        assert calculator.day_count == Decimal("365")

    def test_get_rate_default(self, calculator) -> None:
        """Test getting default rate."""
        rate = calculator.get_rate("AAPL")
        assert rate == Decimal("0.02")

    def test_get_rate_with_schedule(self, calculator) -> None:
        """Test getting rate from schedule."""
        schedule = BorrowFeeSchedule(
            symbol="AAPL",
            base_rate=Decimal("0.03"),
        )
        calculator.set_schedule(schedule)

        rate = calculator.get_rate("AAPL")
        assert rate == Decimal("0.03")

    def test_calculate_daily_fee(self, calculator) -> None:
        """Test daily fee calculation."""
        fee = calculator.calculate_daily_fee(
            symbol_or_position="AAPL",
            quantity=Decimal("1000"),
            price=Decimal("150"),
        )
        # Loan value: 1000 * 150 = 150,000
        # Daily rate: 0.02 / 365 = 0.0000548
        # Daily fee: 150,000 * 0.0000548 = 8.22
        expected = Decimal("150000") * Decimal("0.02") / Decimal("365")
        assert abs(fee - expected) < Decimal("0.01")

    def test_calculate_daily_fee_missing_params(self, calculator) -> None:
        """Test daily fee with missing parameters."""
        with pytest.raises(ValueError, match="quantity and price required"):
            calculator.calculate_daily_fee("AAPL")

    def test_calculate_period_fee(self, calculator) -> None:
        """Test period fee calculation."""
        fee = calculator.calculate_period_fee(
            symbol="AAPL",
            quantity=Decimal("1000"),
            price=Decimal("150"),
            days=30,
        )
        daily_fee = Decimal("150000") * Decimal("0.02") / Decimal("365")
        expected = daily_fee * 30
        assert abs(fee - expected) < Decimal("0.01")


class TestMarginInterestCalculator:
    """Tests for MarginInterestCalculator class."""

    @pytest.fixture
    def calculator(self) -> MarginInterestCalculator:
        """Create a margin interest calculator."""
        return MarginInterestCalculator(
            base_rate=Decimal("0.085"),
            spread=Decimal("0.01"),
            day_count=360,
        )

    def test_init(self, calculator) -> None:
        """Test calculator initialization."""
        assert calculator.base_rate == Decimal("0.085")
        assert calculator.spread == Decimal("0.01")

    def test_get_rate_small_balance(self, calculator) -> None:
        """Test rate for small balance."""
        rate = calculator.get_rate(Decimal("10000"))
        # Base + spread = 0.085 + 0.01 = 0.095
        assert rate == Decimal("0.095")

    def test_get_rate_medium_balance(self, calculator) -> None:
        """Test rate for medium balance (first tier reduction)."""
        rate = calculator.get_rate(Decimal("50000"))
        # Base + spread - reduction = 0.095 - 0.005 = 0.09
        assert rate == Decimal("0.090")

    def test_get_rate_large_balance(self, calculator) -> None:
        """Test rate for large balance (second tier reduction)."""
        rate = calculator.get_rate(Decimal("500000"))
        # Base + spread - reduction = 0.095 - 0.01 = 0.085
        assert rate == Decimal("0.085")

    def test_calculate_daily_interest_positive_balance(self, calculator) -> None:
        """Test daily interest calculation."""
        interest = calculator.calculate_daily_interest(Decimal("100000"))
        # For 100000 balance, tier reduction is 1%
        # Rate: 0.085 + 0.01 - 0.01 = 0.085
        # Daily: 100000 * 0.085 / 360 = 23.61
        expected = Decimal("100000") * Decimal("0.085") / Decimal("360")
        assert abs(interest - expected) < Decimal("0.01")

    def test_calculate_daily_interest_no_debit(self, calculator) -> None:
        """Test no interest when no debit."""
        interest = calculator.calculate_daily_interest(Decimal("0"))
        assert interest == Decimal("0")

    def test_calculate_daily_interest_negative(self, calculator) -> None:
        """Test no interest for negative (credit) balance."""
        interest = calculator.calculate_daily_interest(Decimal("-50000"))
        assert interest == Decimal("0")

    def test_calculate_period_interest(self, calculator) -> None:
        """Test period interest calculation."""
        interest = calculator.calculate_period_interest(
            debit_balance=Decimal("100000"),
            days=30,
        )
        # For 100000 balance, tier reduction is 1%, so rate is 0.085
        daily = Decimal("100000") * Decimal("0.085") / Decimal("360")
        expected = daily * 30
        assert abs(interest - expected) < Decimal("0.01")


class TestRegulatoryFeeCalculator:
    """Tests for RegulatoryFeeCalculator class."""

    @pytest.fixture
    def calculator(self) -> RegulatoryFeeCalculator:
        """Create a regulatory fee calculator."""
        return RegulatoryFeeCalculator()

    def test_calculate_sec_fee_sell(self, calculator) -> None:
        """Test SEC fee on sell transaction."""
        fee = calculator.calculate_sec_fee(
            notional_value=Decimal("100000"),
            is_sell=True,
        )
        # SEC rate: $27.80 per million = 0.0000278
        expected = Decimal("100000") * Decimal("0.0000278")
        # Rounded to cents
        assert fee == Decimal("2.78")

    def test_calculate_sec_fee_buy(self, calculator) -> None:
        """Test no SEC fee on buy transaction."""
        fee = calculator.calculate_sec_fee(
            notional_value=Decimal("100000"),
            is_sell=False,
        )
        assert fee == Decimal("0")

    def test_calculate_taf_fee_sell(self, calculator) -> None:
        """Test TAF fee on sell transaction."""
        fee = calculator.calculate_taf_fee(
            quantity=Decimal("1000"),
            is_sell=True,
        )
        # TAF rate: $0.000166 per share
        expected = Decimal("1000") * Decimal("0.000166")
        assert abs(fee - expected) < Decimal("0.01")

    def test_calculate_taf_fee_buy(self, calculator) -> None:
        """Test no TAF fee on buy transaction."""
        fee = calculator.calculate_taf_fee(
            quantity=Decimal("1000"),
            is_sell=False,
        )
        assert fee == Decimal("0")

    def test_calculate_taf_fee_max(self, calculator) -> None:
        """Test TAF fee capped at maximum."""
        # Very large quantity
        fee = calculator.calculate_taf_fee(
            quantity=Decimal("1000000"),
            is_sell=True,
        )
        assert fee == Decimal("8.30")  # Max cap

    def test_calculate_total_sell(self, calculator) -> None:
        """Test total regulatory fees on sell."""
        total = calculator.calculate_total(
            quantity=Decimal("1000"),
            price=Decimal("150"),
            is_sell=True,
        )
        # Notional: 150,000
        # SEC: 150000 * 0.0000278 = 4.17
        # TAF: 1000 * 0.000166 = 0.166
        assert total > Decimal("0")

    def test_calculate_total_buy(self, calculator) -> None:
        """Test total regulatory fees on buy (should be zero)."""
        total = calculator.calculate_total(
            quantity=Decimal("1000"),
            price=Decimal("150"),
            is_sell=False,
        )
        assert total == Decimal("0")


class TestFeeManager:
    """Tests for FeeManager class."""

    @pytest.fixture
    def manager(self) -> FeeManager:
        """Create a fee manager."""
        return FeeManager()

    def test_init_default(self) -> None:
        """Test default initialization."""
        manager = FeeManager()
        assert manager.borrow_calculator is not None
        assert manager.margin_calculator is not None
        assert manager.regulatory_calculator is not None

    def test_init_custom_calculators(self) -> None:
        """Test initialization with custom calculators."""
        borrow = BorrowFeeCalculator(default_rate=Decimal("0.05"))
        manager = FeeManager(borrow_calculator=borrow)
        assert manager.borrow_calculator.default_rate == Decimal("0.05")

    def test_record_fee(self, manager) -> None:
        """Test recording a fee."""
        record = FeeRecord(
            fee_type=FeeType.BORROW_FEE,
            amount=Decimal("10.50"),
            timestamp=datetime(2024, 1, 15, 10, 0),
            symbol="AAPL",
        )
        manager.record_fee(record)

        assert manager.get_fees_by_type(FeeType.BORROW_FEE) == Decimal("10.50")
        assert manager.get_fees_by_symbol("AAPL") == Decimal("10.50")

    def test_accrue_daily_borrow_fees(self, manager) -> None:
        """Test accruing daily borrow fees."""
        positions = {
            "AAPL": (Decimal("1000"), Decimal("150")),
            "MSFT": (Decimal("500"), Decimal("300")),
        }
        total = manager.accrue_daily_borrow_fees(
            short_positions=positions,
            timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert total > Decimal("0")
        assert manager.get_fees_by_type(FeeType.BORROW_FEE) == total

    def test_accrue_daily_margin_interest(self, manager) -> None:
        """Test accruing daily margin interest."""
        interest = manager.accrue_daily_margin_interest(
            debit_balance=Decimal("100000"),
            timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert interest > Decimal("0")
        assert manager.get_fees_by_type(FeeType.MARGIN_INTEREST) == interest

    def test_accrue_daily_margin_interest_no_debit(self, manager) -> None:
        """Test no margin interest when no debit."""
        interest = manager.accrue_daily_margin_interest(
            debit_balance=Decimal("0"),
            timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert interest == Decimal("0")

    def test_calculate_trade_fees_sell(self, manager) -> None:
        """Test calculating trade fees for sell."""
        fees = manager.calculate_trade_fees(
            symbol="AAPL",
            quantity=Decimal("1000"),
            price=Decimal("150"),
            is_sell=True,
            timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert fees > Decimal("0")

    def test_calculate_trade_fees_buy(self, manager) -> None:
        """Test calculating trade fees for buy (no fees)."""
        fees = manager.calculate_trade_fees(
            symbol="AAPL",
            quantity=Decimal("1000"),
            price=Decimal("150"),
            is_sell=False,
            timestamp=datetime(2024, 1, 15, 10, 0),
        )

        assert fees == Decimal("0")

    def test_get_total_fees(self, manager) -> None:
        """Test getting total fees."""
        record1 = FeeRecord(
            fee_type=FeeType.BORROW_FEE,
            amount=Decimal("10"),
            timestamp=datetime(2024, 1, 15, 10, 0),
        )
        record2 = FeeRecord(
            fee_type=FeeType.MARGIN_INTEREST,
            amount=Decimal("25"),
            timestamp=datetime(2024, 1, 15, 10, 0),
        )
        manager.record_fee(record1)
        manager.record_fee(record2)

        assert manager.get_total_fees() == Decimal("35")

    def test_get_fee_history(self, manager) -> None:
        """Test getting fee history."""
        record1 = FeeRecord(
            fee_type=FeeType.BORROW_FEE,
            amount=Decimal("10"),
            timestamp=datetime(2024, 1, 15, 10, 0),
            symbol="AAPL",
        )
        record2 = FeeRecord(
            fee_type=FeeType.SEC_FEE,
            amount=Decimal("5"),
            timestamp=datetime(2024, 1, 15, 11, 0),
            symbol="MSFT",
        )
        manager.record_fee(record1)
        manager.record_fee(record2)

        # All records
        all_records = manager.get_fee_history()
        assert len(all_records) == 2

        # Filter by type
        borrow_records = manager.get_fee_history(fee_type=FeeType.BORROW_FEE)
        assert len(borrow_records) == 1

        # Filter by symbol
        aapl_records = manager.get_fee_history(symbol="AAPL")
        assert len(aapl_records) == 1

    def test_to_dict(self, manager) -> None:
        """Test converting to dictionary."""
        record = FeeRecord(
            fee_type=FeeType.BORROW_FEE,
            amount=Decimal("10"),
            timestamp=datetime(2024, 1, 15, 10, 0),
            symbol="AAPL",
        )
        manager.record_fee(record)

        result = manager.to_dict()

        assert "total_fees" in result
        assert "by_type" in result
        assert "by_symbol" in result
        assert result["total_fees"] == "10"
        assert result["by_symbol"]["AAPL"] == "10"
