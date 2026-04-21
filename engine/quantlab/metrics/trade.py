"""
Trade Metrics.

Calculates metrics based on individual trades.

Spec Reference: Technical Spec §7.4
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from typing import Sequence


@dataclass
class Trade:
    """Single trade record."""

    trade_id: str
    symbol: str
    entry_time: datetime
    exit_time: datetime
    entry_price: Decimal
    exit_price: Decimal
    quantity: Decimal
    side: str  # "long" or "short"
    pnl: Decimal
    pnl_pct: Decimal
    commission: Decimal = Decimal("0")
    slippage: Decimal = Decimal("0")

    @property
    def is_winner(self) -> bool:
        """Check if trade was profitable."""
        return self.pnl > Decimal("0")

    @property
    def is_loser(self) -> bool:
        """Check if trade was unprofitable."""
        return self.pnl < Decimal("0")

    @property
    def holding_period(self) -> int:
        """Calculate holding period in seconds."""
        return int((self.exit_time - self.entry_time).total_seconds())

    @property
    def gross_pnl(self) -> Decimal:
        """P&L before costs."""
        return self.pnl + self.commission + self.slippage


@dataclass
class TradeMetrics:
    """Complete trade metrics."""

    total_trades: int
    winning_trades: int
    losing_trades: int
    even_trades: int
    win_rate: Decimal
    loss_rate: Decimal
    avg_win: Decimal
    avg_loss: Decimal
    largest_win: Decimal
    largest_loss: Decimal
    profit_factor: Decimal
    payoff_ratio: Decimal
    expectancy: Decimal
    avg_pnl: Decimal
    total_pnl: Decimal
    avg_holding_period: Decimal
    gross_profit: Decimal
    gross_loss: Decimal
    total_commission: Decimal
    total_slippage: Decimal


def win_rate(trades: Sequence[Trade] | Sequence[Decimal]) -> Decimal:
    """
    Calculate win rate.

    Win Rate = Winning_Trades / Total_Trades

    Args:
        trades: List of trades or list of P&L values

    Returns:
        Win rate (0-1)
    """
    if not trades:
        return Decimal("0")

    # Check if first element is a Decimal (P&L list) or Trade object
    first = trades[0]
    if isinstance(first, Decimal):
        # List of P&L values
        winners = sum(1 for pnl in trades if pnl > Decimal("0"))
    else:
        # List of Trade objects
        winners = sum(1 for t in trades if t.is_winner)

    return Decimal(str(winners)) / Decimal(str(len(trades)))


def loss_rate(trades: Sequence[Trade]) -> Decimal:
    """
    Calculate loss rate.

    Args:
        trades: List of trades

    Returns:
        Loss rate (0-1)
    """
    if not trades:
        return Decimal("0")

    losers = sum(1 for t in trades if t.is_loser)
    return Decimal(str(losers)) / Decimal(str(len(trades)))


def profit_factor(trades: Sequence[Trade] | Sequence[Decimal]) -> Decimal:
    """
    Calculate profit factor.

    Profit Factor = Gross_Profits / Gross_Losses

    Args:
        trades: List of trades or list of P&L values

    Returns:
        Profit factor (>1 is profitable)
    """
    if not trades:
        return Decimal("0")

    # Check if first element is a Decimal (P&L list) or Trade object
    first = trades[0]
    if isinstance(first, Decimal):
        # List of P&L values
        gross_profit = sum(pnl for pnl in trades if pnl > Decimal("0"))
        gross_loss = abs(sum(pnl for pnl in trades if pnl < Decimal("0")))
    else:
        # List of Trade objects
        gross_profit = sum(t.pnl for t in trades if t.pnl > Decimal("0"))
        gross_loss = abs(sum(t.pnl for t in trades if t.pnl < Decimal("0")))

    if gross_loss == Decimal("0"):
        return Decimal("0") if gross_profit == Decimal("0") else Decimal("999")

    return gross_profit / gross_loss


def payoff_ratio(trades: Sequence[Trade]) -> Decimal:
    """
    Calculate payoff ratio (avg win / avg loss).

    Also known as risk/reward ratio.

    Args:
        trades: List of trades

    Returns:
        Payoff ratio
    """
    winners = [t for t in trades if t.is_winner]
    losers = [t for t in trades if t.is_loser]

    if not winners or not losers:
        return Decimal("0")

    avg_win = sum(t.pnl for t in winners) / Decimal(str(len(winners)))
    avg_loss = abs(sum(t.pnl for t in losers) / Decimal(str(len(losers))))

    if avg_loss == Decimal("0"):
        return Decimal("0")

    return avg_win / avg_loss


def expectancy(trades: Sequence[Trade]) -> Decimal:
    """
    Calculate expectancy per trade.

    Expectancy = (Win_Rate * Avg_Win) - (Loss_Rate * Avg_Loss)

    Args:
        trades: List of trades

    Returns:
        Expected value per trade
    """
    if not trades:
        return Decimal("0")

    winners = [t for t in trades if t.is_winner]
    losers = [t for t in trades if t.is_loser]

    w_rate = win_rate(trades)
    l_rate = loss_rate(trades)

    avg_win = Decimal("0")
    if winners:
        avg_win = sum(t.pnl for t in winners) / Decimal(str(len(winners)))

    avg_loss = Decimal("0")
    if losers:
        avg_loss = abs(sum(t.pnl for t in losers) / Decimal(str(len(losers))))

    return (w_rate * avg_win) - (l_rate * avg_loss)


def sqn(trades: Sequence[Trade]) -> Decimal:
    """
    Calculate System Quality Number (Van Tharp).

    SQN = sqrt(N) * (Mean_R / Std_R)

    Where R = trade profit in terms of risk (R-multiple)

    Args:
        trades: List of trades

    Returns:
        SQN value
    """
    import math

    if len(trades) < 2:
        return Decimal("0")

    # Use P&L percentage as R-multiple approximation
    r_values = [t.pnl_pct for t in trades]

    mean_r = sum(r_values) / Decimal(str(len(r_values)))

    squared_diffs = [(r - mean_r) ** 2 for r in r_values]
    variance = sum(squared_diffs) / Decimal(str(len(r_values) - 1))
    std_r = Decimal(str(math.sqrt(float(variance))))

    if std_r == Decimal("0"):
        return Decimal("0")

    sqrt_n = Decimal(str(math.sqrt(len(trades))))
    return sqrt_n * (mean_r / std_r)


def consecutive_wins(trades: Sequence[Trade]) -> int:
    """
    Calculate maximum consecutive wins.

    Args:
        trades: List of trades

    Returns:
        Maximum consecutive winning trades
    """
    max_streak = 0
    current_streak = 0

    for trade in trades:
        if trade.is_winner:
            current_streak += 1
            max_streak = max(max_streak, current_streak)
        else:
            current_streak = 0

    return max_streak


def consecutive_losses(trades: Sequence[Trade]) -> int:
    """
    Calculate maximum consecutive losses.

    Args:
        trades: List of trades

    Returns:
        Maximum consecutive losing trades
    """
    max_streak = 0
    current_streak = 0

    for trade in trades:
        if trade.is_loser:
            current_streak += 1
            max_streak = max(max_streak, current_streak)
        else:
            current_streak = 0

    return max_streak


def avg_holding_period(trades: Sequence[Trade]) -> Decimal:
    """
    Calculate average holding period in days.

    Args:
        trades: List of trades

    Returns:
        Average holding period in days
    """
    if not trades:
        return Decimal("0")

    total_seconds = sum(t.holding_period for t in trades)
    avg_seconds = total_seconds / len(trades)
    return Decimal(str(avg_seconds / 86400))  # Convert to days


def calculate_trade_metrics(trades: Sequence[Trade]) -> TradeMetrics:
    """
    Calculate complete trade metrics.

    Args:
        trades: List of trades

    Returns:
        TradeMetrics with all calculations
    """
    if not trades:
        return TradeMetrics(
            total_trades=0,
            winning_trades=0,
            losing_trades=0,
            even_trades=0,
            win_rate=Decimal("0"),
            loss_rate=Decimal("0"),
            avg_win=Decimal("0"),
            avg_loss=Decimal("0"),
            largest_win=Decimal("0"),
            largest_loss=Decimal("0"),
            profit_factor=Decimal("0"),
            payoff_ratio=Decimal("0"),
            expectancy=Decimal("0"),
            avg_pnl=Decimal("0"),
            total_pnl=Decimal("0"),
            avg_holding_period=Decimal("0"),
            gross_profit=Decimal("0"),
            gross_loss=Decimal("0"),
            total_commission=Decimal("0"),
            total_slippage=Decimal("0"),
        )

    winners = [t for t in trades if t.is_winner]
    losers = [t for t in trades if t.is_loser]
    evens = [t for t in trades if t.pnl == Decimal("0")]

    gross_profit = sum(t.pnl for t in winners)
    gross_loss = abs(sum(t.pnl for t in losers))
    total_pnl = sum(t.pnl for t in trades)
    total_comm = sum(t.commission for t in trades)
    total_slip = sum(t.slippage for t in trades)

    avg_win = gross_profit / Decimal(str(len(winners))) if winners else Decimal("0")
    avg_loss = gross_loss / Decimal(str(len(losers))) if losers else Decimal("0")

    largest_win = max((t.pnl for t in winners), default=Decimal("0"))
    largest_loss = abs(min((t.pnl for t in losers), default=Decimal("0")))

    return TradeMetrics(
        total_trades=len(trades),
        winning_trades=len(winners),
        losing_trades=len(losers),
        even_trades=len(evens),
        win_rate=win_rate(trades),
        loss_rate=loss_rate(trades),
        avg_win=avg_win,
        avg_loss=avg_loss,
        largest_win=largest_win,
        largest_loss=largest_loss,
        profit_factor=profit_factor(trades),
        payoff_ratio=payoff_ratio(trades),
        expectancy=expectancy(trades),
        avg_pnl=total_pnl / Decimal(str(len(trades))),
        total_pnl=total_pnl,
        avg_holding_period=avg_holding_period(trades),
        gross_profit=gross_profit,
        gross_loss=gross_loss,
        total_commission=total_comm,
        total_slippage=total_slip,
    )
