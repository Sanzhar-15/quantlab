"""
Metrics Calculator.

High-level interface for calculating performance metrics from backtest results.
"""

import math
from typing import Any

from quantlab.metrics.types import PerformanceMetrics


class MetricsCalculator:
    """
    Calculate performance metrics from backtest data.

    Usage:
        calculator = MetricsCalculator()
        metrics = calculator.calculate(
            equity_curve=[100000, 101000, 99500, 102000],
            trades=[{"pnl": 1000}, {"pnl": -1500}, {"pnl": 2500}],
            initial_capital=100000,
        )
    """

    def __init__(
        self,
        trading_days_per_year: int = 252,
        risk_free_rate: float = 0.0,
    ) -> None:
        """
        Initialize calculator.

        Args:
            trading_days_per_year: For annualization (default: 252 for equities)
            risk_free_rate: Risk-free rate for Sharpe calculation (default: 0)
        """
        self.trading_days = trading_days_per_year
        self.risk_free_rate = risk_free_rate

    def calculate(
        self,
        equity_curve: list[float],
        trades: list[dict[str, Any]] | None = None,
        initial_capital: float = 100000,
    ) -> PerformanceMetrics:
        """
        Calculate all performance metrics.

        Args:
            equity_curve: List of equity values over time
            trades: List of trade dictionaries with 'pnl', 'side', etc.
            initial_capital: Starting capital

        Returns:
            PerformanceMetrics with all calculated values
        """
        metrics = PerformanceMetrics()

        if not equity_curve or len(equity_curve) < 2:
            return metrics

        # Total return
        final_equity = equity_curve[-1]
        metrics.total_return = final_equity - initial_capital
        metrics.total_return_pct = (
            (final_equity / initial_capital - 1) * 100 if initial_capital > 0 else 0
        )

        # Calculate returns series
        returns = self._calculate_returns(equity_curve)

        if returns:
            # Volatility and risk metrics
            metrics.volatility = self._calculate_volatility(returns)
            metrics.downside_deviation = self._calculate_downside_deviation(returns)

            # Risk-adjusted returns
            metrics.sharpe_ratio = self._calculate_sharpe(returns)
            metrics.sortino_ratio = self._calculate_sortino(returns)

        # Drawdown metrics
        dd_pct, dd_duration = self._calculate_max_drawdown(equity_curve)
        metrics.max_drawdown_pct = dd_pct
        metrics.max_drawdown_duration = dd_duration

        # CAGR
        num_periods = len(equity_curve)
        if num_periods > 1 and initial_capital > 0 and final_equity > 0:
            years = num_periods / self.trading_days
            if years > 0:
                metrics.cagr = ((final_equity / initial_capital) ** (1 / years) - 1) * 100

        # Calmar ratio
        if metrics.cagr and metrics.max_drawdown_pct and metrics.max_drawdown_pct != 0:
            metrics.calmar_ratio = abs(metrics.cagr / metrics.max_drawdown_pct)

        # Trade metrics
        if trades:
            self._calculate_trade_metrics(trades, metrics)

        return metrics

    def _calculate_returns(self, equity_curve: list[float]) -> list[float]:
        """Calculate simple returns from equity curve."""
        returns = []
        for i in range(1, len(equity_curve)):
            if equity_curve[i - 1] != 0:
                ret = (equity_curve[i] / equity_curve[i - 1]) - 1
                returns.append(ret)
        return returns

    def _calculate_volatility(self, returns: list[float]) -> float:
        """Calculate annualized volatility."""
        if len(returns) < 2:
            return 0.0

        mean = sum(returns) / len(returns)
        # FIX-H3: Use sample variance (n-1) to match metrics.risk module
        variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
        daily_vol = math.sqrt(variance)

        # Annualize
        return daily_vol * math.sqrt(self.trading_days) * 100

    def _calculate_downside_deviation(
        self,
        returns: list[float],
        mar: float = 0.0,
    ) -> float:
        """Calculate downside deviation (only negative returns)."""
        downside = [min(0, r - mar) ** 2 for r in returns]
        if len(downside) < 2:
            return 0.0

        # FIX-H3: Use sample variance (n-1) for consistency with volatility/Sharpe
        downside_var = sum(downside) / (len(downside) - 1)
        return math.sqrt(downside_var) * math.sqrt(self.trading_days) * 100

    def _calculate_sharpe(self, returns: list[float]) -> float:
        """Calculate annualized Sharpe ratio."""
        if len(returns) < 2:
            return 0.0

        mean = sum(returns) / len(returns)
        # FIX-H3: Use sample variance (n-1) to match metrics.risk module
        variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
        std = math.sqrt(variance)

        if std == 0:
            return 0.0

        daily_rf = self.risk_free_rate / self.trading_days
        excess_return = mean - daily_rf

        return (excess_return / std) * math.sqrt(self.trading_days)

    def _calculate_sortino(self, returns: list[float]) -> float:
        """Calculate Sortino ratio using downside deviation."""
        if len(returns) < 2:
            return 0.0

        mean = sum(returns) / len(returns)
        downside = [min(0, r) ** 2 for r in returns]
        # FIX-H3: Use sample variance (n-1) for consistency
        downside_var = sum(downside) / (len(downside) - 1)
        downside_dev = math.sqrt(downside_var)

        if downside_dev == 0:
            return 0.0

        daily_rf = self.risk_free_rate / self.trading_days
        excess_return = mean - daily_rf

        return (excess_return / downside_dev) * math.sqrt(self.trading_days)

    def _calculate_max_drawdown(
        self,
        equity_curve: list[float],
    ) -> tuple[float, int]:
        """Calculate maximum drawdown percentage and duration."""
        if not equity_curve:
            return 0.0, 0

        peak = equity_curve[0]
        max_dd = 0.0
        max_duration = 0
        current_duration = 0

        for value in equity_curve:
            if value >= peak:
                peak = value
                current_duration = 0
            elif peak > 0:
                current_duration += 1
                dd = (peak - value) / peak * 100
                if dd > max_dd:
                    max_dd = dd
                    max_duration = current_duration

        return max_dd, max_duration

    def _calculate_trade_metrics(
        self,
        trades: list[dict[str, Any]],
        metrics: PerformanceMetrics,
    ) -> None:
        """Calculate trade-based metrics."""
        metrics.total_trades = len(trades)

        # Extract PnLs
        pnls = []
        for t in trades:
            if "pnl" in t:
                pnls.append(float(t["pnl"]))
            elif "price" in t and "quantity" in t:
                # Estimate from price * quantity
                pnls.append(float(t.get("price", 0)) * float(t.get("quantity", 0)) * 0.01)

        if not pnls:
            return

        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p < 0]

        metrics.winning_trades = len(wins)
        metrics.losing_trades = len(losses)

        if metrics.total_trades > 0:
            metrics.win_rate = (len(wins) / metrics.total_trades) * 100

        if wins:
            metrics.avg_win = sum(wins) / len(wins)
            metrics.largest_win = max(wins)

        if losses:
            metrics.avg_loss = sum(losses) / len(losses)
            metrics.largest_loss = min(losses)

        # Profit factor
        total_wins = sum(wins) if wins else 0
        total_losses = abs(sum(losses)) if losses else 0

        if total_losses > 0:
            metrics.profit_factor = total_wins / total_losses
        elif total_wins > 0:
            metrics.profit_factor = float("inf")

        # Expectancy
        if metrics.total_trades > 0:
            metrics.expectancy = sum(pnls) / metrics.total_trades

        # SQN (System Quality Number)
        if len(pnls) > 1:
            mean_pnl = sum(pnls) / len(pnls)
            # FIX-H3: Use sample variance (n-1) to match metrics.risk module
            variance = sum((p - mean_pnl) ** 2 for p in pnls) / (len(pnls) - 1)
            std_pnl = math.sqrt(variance)

            if std_pnl > 0:
                metrics.sqn = (mean_pnl / std_pnl) * math.sqrt(len(pnls))
