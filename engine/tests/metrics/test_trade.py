"""
Tests for Trade Metrics.

Tests trade statistics and performance calculations.
"""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from quantlab.metrics.trade import (
    Trade,
    TradeMetrics,
    win_rate,
    loss_rate,
    profit_factor,
    payoff_ratio,
    expectancy,
    sqn,
    consecutive_wins,
    consecutive_losses,
    avg_holding_period,
    calculate_trade_metrics,
)


@pytest.fixture
def sample_trade() -> Trade:
    """Create a sample trade."""
    return Trade(
        trade_id="trade-001",
        symbol="AAPL",
        entry_time=datetime(2024, 1, 15, 9, 30),
        exit_time=datetime(2024, 1, 15, 16, 0),
        entry_price=Decimal("150.00"),
        exit_price=Decimal("155.00"),
        quantity=Decimal("100"),
        side="long",
        pnl=Decimal("500"),
        pnl_pct=Decimal("0.0333"),
        commission=Decimal("10"),
        slippage=Decimal("5"),
    )


@pytest.fixture
def winning_trades() -> list[Trade]:
    """Create a list of winning trades."""
    base_time = datetime(2024, 1, 15, 9, 30)
    return [
        Trade(
            trade_id=f"trade-{i}",
            symbol="AAPL",
            entry_time=base_time,
            exit_time=base_time + timedelta(hours=6),
            entry_price=Decimal("150.00"),
            exit_price=Decimal("155.00"),
            quantity=Decimal("100"),
            side="long",
            pnl=Decimal(str(100 * (i + 1))),
            pnl_pct=Decimal(str(0.01 * (i + 1))),
        )
        for i in range(5)
    ]


@pytest.fixture
def losing_trades() -> list[Trade]:
    """Create a list of losing trades."""
    base_time = datetime(2024, 1, 15, 9, 30)
    return [
        Trade(
            trade_id=f"trade-{i}",
            symbol="AAPL",
            entry_time=base_time,
            exit_time=base_time + timedelta(hours=6),
            entry_price=Decimal("155.00"),
            exit_price=Decimal("150.00"),
            quantity=Decimal("100"),
            side="long",
            pnl=Decimal(str(-50 * (i + 1))),
            pnl_pct=Decimal(str(-0.005 * (i + 1))),
        )
        for i in range(3)
    ]


@pytest.fixture
def mixed_trades(winning_trades, losing_trades) -> list[Trade]:
    """Create a mixed list of winning and losing trades."""
    return winning_trades + losing_trades


class TestTrade:
    """Tests for Trade dataclass."""

    def test_is_winner(self, sample_trade) -> None:
        """Test is_winner property."""
        assert sample_trade.is_winner is True

    def test_is_loser(self) -> None:
        """Test is_loser property."""
        trade = Trade(
            trade_id="trade-001",
            symbol="AAPL",
            entry_time=datetime(2024, 1, 15, 9, 30),
            exit_time=datetime(2024, 1, 15, 16, 0),
            entry_price=Decimal("155.00"),
            exit_price=Decimal("150.00"),
            quantity=Decimal("100"),
            side="long",
            pnl=Decimal("-500"),
            pnl_pct=Decimal("-0.0323"),
        )
        assert trade.is_loser is True

    def test_holding_period(self, sample_trade) -> None:
        """Test holding_period property."""
        # 6.5 hours = 23400 seconds
        assert sample_trade.holding_period == 23400

    def test_gross_pnl(self, sample_trade) -> None:
        """Test gross_pnl property."""
        # pnl + commission + slippage = 500 + 10 + 5 = 515
        assert sample_trade.gross_pnl == Decimal("515")


class TestWinRate:
    """Tests for win_rate function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = win_rate([])
        assert result == Decimal("0")

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winning trades."""
        result = win_rate(winning_trades)
        assert result == Decimal("1")

    def test_all_losers(self, losing_trades) -> None:
        """Test with all losing trades."""
        result = win_rate(losing_trades)
        assert result == Decimal("0")

    def test_mixed_trades(self, mixed_trades) -> None:
        """Test with mixed trades."""
        result = win_rate(mixed_trades)
        # 5 winners out of 8 trades
        assert abs(result - Decimal("0.625")) < Decimal("0.001")

    def test_with_pnl_list(self) -> None:
        """Test with P&L list instead of Trade objects."""
        pnl_list = [Decimal("100"), Decimal("-50"), Decimal("200"), Decimal("-30")]
        result = win_rate(pnl_list)
        # 2 winners out of 4
        assert result == Decimal("0.5")


class TestLossRate:
    """Tests for loss_rate function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = loss_rate([])
        assert result == Decimal("0")

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winning trades."""
        result = loss_rate(winning_trades)
        assert result == Decimal("0")

    def test_all_losers(self, losing_trades) -> None:
        """Test with all losing trades."""
        result = loss_rate(losing_trades)
        assert result == Decimal("1")

    def test_mixed_trades(self, mixed_trades) -> None:
        """Test with mixed trades."""
        result = loss_rate(mixed_trades)
        # 3 losers out of 8 trades
        assert abs(result - Decimal("0.375")) < Decimal("0.001")


class TestProfitFactor:
    """Tests for profit_factor function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = profit_factor([])
        assert result == Decimal("0")

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winning trades."""
        result = profit_factor(winning_trades)
        # No losses, should return high value
        assert result == Decimal("999")

    def test_all_losers(self, losing_trades) -> None:
        """Test with all losing trades."""
        result = profit_factor(losing_trades)
        # No profits, should return 0
        assert result == Decimal("0")

    def test_mixed_trades(self, mixed_trades) -> None:
        """Test with mixed trades."""
        result = profit_factor(mixed_trades)
        # Total profit: 100+200+300+400+500 = 1500
        # Total loss: 50+100+150 = 300
        # PF = 1500/300 = 5
        assert result == Decimal("5")

    def test_with_pnl_list(self) -> None:
        """Test with P&L list instead of Trade objects."""
        pnl_list = [Decimal("100"), Decimal("-50"), Decimal("200"), Decimal("-30")]
        result = profit_factor(pnl_list)
        # Total profit: 300, Total loss: 80
        # PF = 300/80 = 3.75
        assert result == Decimal("3.75")


class TestPayoffRatio:
    """Tests for payoff_ratio function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = payoff_ratio([])
        assert result == Decimal("0")

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winning trades."""
        result = payoff_ratio(winning_trades)
        # No losers, should return 0
        assert result == Decimal("0")

    def test_all_losers(self, losing_trades) -> None:
        """Test with all losing trades."""
        result = payoff_ratio(losing_trades)
        # No winners, should return 0
        assert result == Decimal("0")

    def test_mixed_trades(self, mixed_trades) -> None:
        """Test with mixed trades."""
        result = payoff_ratio(mixed_trades)
        # Avg win: 1500/5 = 300
        # Avg loss: 300/3 = 100
        # Payoff = 300/100 = 3
        assert result == Decimal("3")


class TestExpectancy:
    """Tests for expectancy function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = expectancy([])
        assert result == Decimal("0")

    def test_positive_expectancy(self, mixed_trades) -> None:
        """Test with positive expectancy."""
        result = expectancy(mixed_trades)
        # Win rate: 0.625, Avg win: 300
        # Loss rate: 0.375, Avg loss: 100
        # Expectancy = 0.625 * 300 - 0.375 * 100 = 187.5 - 37.5 = 150
        assert abs(result - Decimal("150")) < Decimal("1")

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winners (no losers)."""
        result = expectancy(winning_trades)
        # All winners, expectancy = avg win
        avg_win = sum(t.pnl for t in winning_trades) / len(winning_trades)
        assert result == avg_win


class TestSQN:
    """Tests for sqn function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = sqn([])
        assert result == Decimal("0")

    def test_single_trade(self, sample_trade) -> None:
        """Test with single trade."""
        result = sqn([sample_trade])
        assert result == Decimal("0")

    def test_consistent_trades(self) -> None:
        """Test with consistent trades."""
        base_time = datetime(2024, 1, 15, 9, 30)
        trades = [
            Trade(
                trade_id=f"trade-{i}",
                symbol="AAPL",
                entry_time=base_time,
                exit_time=base_time + timedelta(hours=6),
                entry_price=Decimal("150.00"),
                exit_price=Decimal("155.00"),
                quantity=Decimal("100"),
                side="long",
                pnl=Decimal("100"),
                pnl_pct=Decimal("0.03"),  # Consistent 3%
            )
            for i in range(10)
        ]
        result = sqn(trades)
        # Constant returns -> std = 0 -> SQN = 0
        assert result == Decimal("0")


class TestConsecutiveWins:
    """Tests for consecutive_wins function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = consecutive_wins([])
        assert result == 0

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winning trades."""
        result = consecutive_wins(winning_trades)
        assert result == 5

    def test_all_losers(self, losing_trades) -> None:
        """Test with all losing trades."""
        result = consecutive_wins(losing_trades)
        assert result == 0


class TestConsecutiveLosses:
    """Tests for consecutive_losses function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = consecutive_losses([])
        assert result == 0

    def test_all_winners(self, winning_trades) -> None:
        """Test with all winning trades."""
        result = consecutive_losses(winning_trades)
        assert result == 0

    def test_all_losers(self, losing_trades) -> None:
        """Test with all losing trades."""
        result = consecutive_losses(losing_trades)
        assert result == 3


class TestAvgHoldingPeriod:
    """Tests for avg_holding_period function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = avg_holding_period([])
        assert result == Decimal("0")

    def test_single_trade(self, sample_trade) -> None:
        """Test with single trade."""
        result = avg_holding_period([sample_trade])
        # 23400 seconds = 0.27083... days
        assert abs(result - Decimal("0.27083")) < Decimal("0.001")


class TestCalculateTradeMetrics:
    """Tests for calculate_trade_metrics function."""

    def test_empty_trades(self) -> None:
        """Test with empty trades."""
        result = calculate_trade_metrics([])

        assert result.total_trades == 0
        assert result.winning_trades == 0
        assert result.win_rate == Decimal("0")
        assert result.profit_factor == Decimal("0")

    def test_complete_metrics(self, mixed_trades) -> None:
        """Test complete metrics calculation."""
        result = calculate_trade_metrics(mixed_trades)

        assert isinstance(result, TradeMetrics)
        assert result.total_trades == 8
        assert result.winning_trades == 5
        assert result.losing_trades == 3
        assert result.total_pnl == Decimal("1200")  # 1500 - 300
        assert result.profit_factor == Decimal("5")

    def test_metrics_dataclass_fields(self, mixed_trades) -> None:
        """Test that all fields are present."""
        result = calculate_trade_metrics(mixed_trades)

        assert hasattr(result, "total_trades")
        assert hasattr(result, "winning_trades")
        assert hasattr(result, "losing_trades")
        assert hasattr(result, "even_trades")
        assert hasattr(result, "win_rate")
        assert hasattr(result, "loss_rate")
        assert hasattr(result, "avg_win")
        assert hasattr(result, "avg_loss")
        assert hasattr(result, "largest_win")
        assert hasattr(result, "largest_loss")
        assert hasattr(result, "profit_factor")
        assert hasattr(result, "payoff_ratio")
        assert hasattr(result, "expectancy")
        assert hasattr(result, "avg_pnl")
        assert hasattr(result, "total_pnl")
        assert hasattr(result, "avg_holding_period")
        assert hasattr(result, "gross_profit")
        assert hasattr(result, "gross_loss")
        assert hasattr(result, "total_commission")
        assert hasattr(result, "total_slippage")

    def test_largest_win_loss(self, mixed_trades) -> None:
        """Test largest win and loss calculation."""
        result = calculate_trade_metrics(mixed_trades)

        assert result.largest_win == Decimal("500")  # Largest winner
        assert result.largest_loss == Decimal("150")  # Largest loser (absolute)

    def test_even_trades(self) -> None:
        """Test even trades (zero P&L)."""
        base_time = datetime(2024, 1, 15, 9, 30)
        trades = [
            Trade(
                trade_id="trade-0",
                symbol="AAPL",
                entry_time=base_time,
                exit_time=base_time + timedelta(hours=6),
                entry_price=Decimal("150.00"),
                exit_price=Decimal("150.00"),  # No change
                quantity=Decimal("100"),
                side="long",
                pnl=Decimal("0"),  # Even trade
                pnl_pct=Decimal("0"),
            ),
            Trade(
                trade_id="trade-1",
                symbol="AAPL",
                entry_time=base_time,
                exit_time=base_time + timedelta(hours=6),
                entry_price=Decimal("150.00"),
                exit_price=Decimal("155.00"),
                quantity=Decimal("100"),
                side="long",
                pnl=Decimal("500"),
                pnl_pct=Decimal("0.0333"),
            ),
        ]
        result = calculate_trade_metrics(trades)

        assert result.even_trades == 1
        assert result.winning_trades == 1
        assert result.losing_trades == 0
