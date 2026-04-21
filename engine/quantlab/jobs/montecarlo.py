"""
Monte Carlo Simulation Job Runner.

Runs Monte Carlo simulations by shuffling trades to estimate
distribution of possible outcomes.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

import random
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from quantlab.metrics import EQUITY_TRADING_DAYS_PER_YEAR

from .backtest import BacktestConfig
from .backtest import BacktestJob
from .backtest import Trade
from .base import Job
from .base import JobConfig
from .base import JobContext
from .base import JobType
from .protocol import JobResult
from .protocol import LogLevel
from .protocol import MetricValue


@dataclass
class MonteCarloConfig(JobConfig):
    """Configuration for Monte Carlo simulation jobs."""

    # Simulation settings
    num_simulations: int = 1000
    confidence_level: float = 0.95  # 95% confidence interval
    shuffle_method: str = "trades"  # "trades" or "returns"
    random_seed: int | None = None

    # Backtest settings (for initial run)
    initial_capital: float = 100000.0
    commission: float = 0.001
    slippage: float = 0.0005

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        d = super().to_dict()
        d.update({
            "numSimulations": self.num_simulations,
            "confidenceLevel": self.confidence_level,
            "shuffleMethod": self.shuffle_method,
            "randomSeed": self.random_seed,
            "initialCapital": self.initial_capital,
            "commission": self.commission,
            "slippage": self.slippage,
        })
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MonteCarloConfig":
        """Create from dictionary."""
        return cls(
            symbol=data.get("symbol", ""),
            timeframe=data.get("timeframe", "1D"),
            start_date=data.get("startDate"),
            end_date=data.get("endDate"),
            data_source=data.get("dataSource", "default"),
            num_simulations=data.get("numSimulations", 1000),
            confidence_level=data.get("confidenceLevel", 0.95),
            shuffle_method=data.get("shuffleMethod", "trades"),
            random_seed=data.get("randomSeed"),
            initial_capital=data.get("initialCapital", 100000.0),
            commission=data.get("commission", 0.001),
            slippage=data.get("slippage", 0.0005),
        )


@dataclass
class SimulationRun:
    """Result of a single simulation run."""

    run_number: int
    final_equity: float
    total_return_percent: float
    max_drawdown_percent: float
    sharpe_ratio: float

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "runNumber": self.run_number,
            "finalEquity": self.final_equity,
            "totalReturnPercent": self.total_return_percent,
            "maxDrawdownPercent": self.max_drawdown_percent,
            "sharpeRatio": self.sharpe_ratio,
        }


@dataclass
class DistributionStats:
    """Statistics for a distribution."""

    mean: float = 0.0
    median: float = 0.0
    std: float = 0.0
    min: float = 0.0
    max: float = 0.0
    percentile_5: float = 0.0
    percentile_25: float = 0.0
    percentile_75: float = 0.0
    percentile_95: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "mean": self.mean,
            "median": self.median,
            "std": self.std,
            "min": self.min,
            "max": self.max,
            "percentile5": self.percentile_5,
            "percentile25": self.percentile_25,
            "percentile75": self.percentile_75,
            "percentile95": self.percentile_95,
        }


@dataclass
class MonteCarloResult:
    """Results from Monte Carlo simulation."""

    # Original backtest results
    original_return: float = 0.0
    original_sharpe: float = 0.0
    original_max_dd: float = 0.0

    # Distribution statistics
    return_distribution: DistributionStats = field(
        default_factory=DistributionStats
    )
    sharpe_distribution: DistributionStats = field(
        default_factory=DistributionStats
    )
    drawdown_distribution: DistributionStats = field(
        default_factory=DistributionStats
    )

    # Confidence intervals
    confidence_level: float = 0.95
    return_ci_lower: float = 0.0
    return_ci_upper: float = 0.0
    sharpe_ci_lower: float = 0.0
    sharpe_ci_upper: float = 0.0

    # Risk metrics
    probability_of_loss: float = 0.0
    var_95: float = 0.0  # Value at Risk
    cvar_95: float = 0.0  # Conditional VaR (Expected Shortfall)

    # Individual runs
    runs: list[SimulationRun] = field(default_factory=list)
    num_simulations: int = 0

    # Histogram data
    return_histogram: list[dict[str, Any]] = field(default_factory=list)

    def to_metrics(self) -> list[MetricValue]:
        """Convert to metric values for display."""
        return [
            MetricValue(
                name="Original Return %",
                value=round(self.original_return, 2),
                format="percent",
            ),
            MetricValue(
                name="Mean Return %",
                value=round(self.return_distribution.mean, 2),
                format="percent",
            ),
            MetricValue(
                name=f"{int(self.confidence_level*100)}% CI Return",
                value=f"{self.return_ci_lower:.1f}% - {self.return_ci_upper:.1f}%",
                format="number",
            ),
            MetricValue(
                name="Probability of Loss",
                value=round(self.probability_of_loss, 1),
                format="percent",
            ),
            MetricValue(
                name="VaR (95%)",
                value=round(self.var_95, 2),
                format="percent",
            ),
            MetricValue(
                name="Simulations",
                value=self.num_simulations,
                format="number",
            ),
        ]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "originalReturn": self.original_return,
            "originalSharpe": self.original_sharpe,
            "originalMaxDrawdown": self.original_max_dd,
            "returnDistribution": self.return_distribution.to_dict(),
            "sharpeDistribution": self.sharpe_distribution.to_dict(),
            "drawdownDistribution": self.drawdown_distribution.to_dict(),
            "confidenceLevel": self.confidence_level,
            "returnCILower": self.return_ci_lower,
            "returnCIUpper": self.return_ci_upper,
            "sharpeCILower": self.sharpe_ci_lower,
            "sharpeCIUpper": self.sharpe_ci_upper,
            "probabilityOfLoss": self.probability_of_loss,
            "var95": self.var_95,
            "cvar95": self.cvar_95,
            "numSimulations": self.num_simulations,
            "returnHistogram": self.return_histogram,
        }


class MonteCarloJob(Job):
    """
    Monte Carlo simulation job runner.

    Runs multiple simulations by shuffling trades or returns
    to estimate the distribution of possible outcomes.
    """

    @property
    def job_type(self) -> JobType:
        """Return job type."""
        return JobType.MONTE_CARLO

    def validate_config(self, config: JobConfig) -> list[str]:
        """Validate Monte Carlo configuration."""
        errors = super().validate_config(config)

        if isinstance(config, MonteCarloConfig):
            if config.num_simulations < 10:
                errors.append("Number of simulations must be at least 10")
            if config.num_simulations > 100000:
                errors.append("Number of simulations cannot exceed 100,000")
            if not 0.5 <= config.confidence_level <= 0.99:
                errors.append("Confidence level must be between 0.5 and 0.99")
            if config.shuffle_method not in ("trades", "returns"):
                errors.append("Shuffle method must be 'trades' or 'returns'")

        return errors

    def run(self, ctx: JobContext) -> JobResult:
        """
        Execute Monte Carlo simulation.

        Args:
            ctx: Job execution context

        Returns:
            JobResult with simulation results
        """
        ctx.log_info(f"Starting Monte Carlo simulation for {ctx.config.symbol}")

        # Parse config
        if isinstance(ctx.config, MonteCarloConfig):
            config = ctx.config
        else:
            config = MonteCarloConfig.from_dict(ctx.config.to_dict())

        ctx.log_info(f"Simulations: {config.num_simulations}")
        ctx.log_info(f"Confidence level: {config.confidence_level * 100}%")
        ctx.log_info(f"Shuffle method: {config.shuffle_method}")

        # Set random seed if provided
        if config.random_seed is not None:
            random.seed(config.random_seed)

        # Run initial backtest to get trades
        ctx.progress(5, "Running initial backtest...")

        trades = self._run_initial_backtest(ctx, config)

        if len(trades) < 5:
            raise ValueError(
                f"Insufficient trades for Monte Carlo simulation "
                f"(got {len(trades)}, need at least 5)"
            )

        ctx.log_info(f"Original backtest: {len(trades)} trades")

        # Calculate original metrics
        result = MonteCarloResult()
        result.confidence_level = config.confidence_level
        result.num_simulations = config.num_simulations

        original_equity = self._calculate_equity_curve(
            trades, config.initial_capital
        )
        result.original_return = (
            (original_equity[-1] / config.initial_capital - 1) * 100
        )
        result.original_sharpe = self._calculate_sharpe(original_equity)
        result.original_max_dd = self._calculate_max_drawdown(original_equity)

        ctx.log_info(f"Original return: {result.original_return:.2f}%")
        ctx.log_info(f"Original Sharpe: {result.original_sharpe:.2f}")

        # Run simulations
        ctx.progress(10, "Running simulations...")

        returns = []
        sharpes = []
        drawdowns = []

        batch_size = max(1, config.num_simulations // 100)

        for i in range(config.num_simulations):
            # Check cancellation periodically
            if i % batch_size == 0:
                ctx.check_cancelled()
                pct = 10 + (i / config.num_simulations) * 80
                ctx.progress(pct, f"Simulation {i+1}/{config.num_simulations}")

            # Shuffle trades
            shuffled = self._shuffle_trades(trades, config.shuffle_method)

            # Calculate equity curve
            equity = self._calculate_equity_curve(
                shuffled, config.initial_capital
            )

            # Calculate metrics
            ret = (equity[-1] / config.initial_capital - 1) * 100
            sharpe = self._calculate_sharpe(equity)
            dd = self._calculate_max_drawdown(equity)

            returns.append(ret)
            sharpes.append(sharpe)
            drawdowns.append(dd)

            # Record run
            run = SimulationRun(
                run_number=i + 1,
                final_equity=equity[-1],
                total_return_percent=ret,
                max_drawdown_percent=dd,
                sharpe_ratio=sharpe,
            )
            result.runs.append(run)

        # Calculate distribution statistics
        ctx.progress(92, "Calculating statistics...")

        result.return_distribution = self._calculate_distribution(returns)
        result.sharpe_distribution = self._calculate_distribution(sharpes)
        result.drawdown_distribution = self._calculate_distribution(drawdowns)

        # Calculate confidence intervals
        alpha = 1 - config.confidence_level
        lower_pct = alpha / 2
        upper_pct = 1 - alpha / 2

        sorted_returns = sorted(returns)
        sorted_sharpes = sorted(sharpes)

        n = len(sorted_returns)
        result.return_ci_lower = sorted_returns[int(n * lower_pct)]
        result.return_ci_upper = sorted_returns[int(n * upper_pct) - 1]
        result.sharpe_ci_lower = sorted_sharpes[int(n * lower_pct)]
        result.sharpe_ci_upper = sorted_sharpes[int(n * upper_pct) - 1]

        # Calculate risk metrics
        result.probability_of_loss = (
            sum(1 for r in returns if r < 0) / len(returns) * 100
        )
        result.var_95 = sorted_returns[int(n * 0.05)]
        loss_returns = [r for r in returns if r < result.var_95]
        if loss_returns:
            result.cvar_95 = sum(loss_returns) / len(loss_returns)
        else:
            result.cvar_95 = result.var_95

        # Generate histogram data
        result.return_histogram = self._generate_histogram(returns)

        # Write artifacts
        ctx.progress(95, "Writing artifacts...")

        result_path = ctx.write_artifact("result", result.to_dict())
        runs_path = ctx.write_artifact("runs", [r.to_dict() for r in result.runs])

        ctx.log_info("Monte Carlo simulation complete")
        ctx.log_info(
            f"Return CI ({config.confidence_level*100}%): "
            f"{result.return_ci_lower:.1f}% to {result.return_ci_upper:.1f}%"
        )
        ctx.log_info(f"Probability of loss: {result.probability_of_loss:.1f}%")

        # Build job result
        warnings = []
        if result.probability_of_loss > 50:
            warnings.append(
                f"High probability of loss: {result.probability_of_loss:.1f}%"
            )

        return JobResult(
            success=True,
            metrics=result.to_metrics(),
            warnings=warnings,
            details={
                "originalReturn": result.original_return,
                "meanReturn": result.return_distribution.mean,
                "probabilityOfLoss": result.probability_of_loss,
            },
            artifact_paths={
                "result": str(result_path),
                "runs": str(runs_path),
            },
        )

    def _run_initial_backtest(
        self,
        ctx: JobContext,
        config: MonteCarloConfig,
    ) -> list[Trade]:
        """Run initial backtest to get trades."""
        # For now, generate mock trades
        # In production, would run actual backtest
        import time

        trades = []
        equity = config.initial_capital
        num_trades = random.randint(30, 100)

        current_time = time.time() - (365 * 86400)

        for i in range(num_trades):
            # Random trade duration
            duration = random.randint(1, 10) * 86400

            # Random entry/exit
            entry_price = 100 + random.uniform(-20, 20)
            side = random.choice(["long", "short"])

            # Random P&L with slight edge
            pnl_pct = random.gauss(0.002, 0.02)  # Slight positive edge
            if side == "short":
                pnl_pct = -pnl_pct

            exit_price = entry_price * (1 + pnl_pct)
            quantity = (equity * 0.1) / entry_price

            pnl = quantity * (exit_price - entry_price)
            if side == "short":
                pnl = -pnl

            commission = quantity * (entry_price + exit_price) * config.commission

            trade = Trade(
                entry_time=current_time,
                exit_time=current_time + duration,
                entry_price=entry_price,
                exit_price=exit_price,
                quantity=quantity,
                side=side,
                pnl=pnl - commission,
                pnl_percent=pnl_pct * 100,
                commission=commission,
            )
            trades.append(trade)

            current_time += duration + random.randint(1, 5) * 86400

        return trades

    def _shuffle_trades(
        self,
        trades: list[Trade],
        method: str,
    ) -> list[Trade]:
        """Shuffle trades for simulation."""
        if method == "trades":
            # Shuffle trade order
            shuffled = trades.copy()
            random.shuffle(shuffled)
            return shuffled
        else:
            # Shuffle returns (P&L percentages)
            pnl_pcts = [t.pnl_percent for t in trades]
            random.shuffle(pnl_pcts)

            shuffled = []
            for trade, pnl_pct in zip(trades, pnl_pcts):
                new_trade = Trade(
                    entry_time=trade.entry_time,
                    exit_time=trade.exit_time,
                    entry_price=trade.entry_price,
                    exit_price=trade.entry_price * (1 + pnl_pct / 100),
                    quantity=trade.quantity,
                    side=trade.side,
                    pnl=trade.quantity * trade.entry_price * pnl_pct / 100,
                    pnl_percent=pnl_pct,
                    commission=trade.commission,
                )
                shuffled.append(new_trade)

            return shuffled

    def _calculate_equity_curve(
        self,
        trades: list[Trade],
        initial_capital: float,
    ) -> list[float]:
        """Calculate equity curve from trades."""
        equity = [initial_capital]
        current = initial_capital

        for trade in trades:
            current += trade.pnl
            equity.append(current)

        return equity

    def _calculate_sharpe(self, equity: list[float]) -> float:
        """Calculate Sharpe ratio from equity curve."""
        if len(equity) < 2:
            return 0.0

        returns = []
        for i in range(1, len(equity)):
            ret = (equity[i] / equity[i-1]) - 1
            returns.append(ret)

        if len(returns) < 2:
            return 0.0

        avg_ret = sum(returns) / len(returns)
        variance = sum((r - avg_ret) ** 2 for r in returns) / (len(returns) - 1)
        std = variance ** 0.5

        if std == 0:
            return 0.0

        # Annualize (assuming one trade per day on average)
        annual_factor = EQUITY_TRADING_DAYS_PER_YEAR ** 0.5
        return (avg_ret * EQUITY_TRADING_DAYS_PER_YEAR) / (std * annual_factor)

    def _calculate_max_drawdown(self, equity: list[float]) -> float:
        """Calculate maximum drawdown percentage."""
        peak = equity[0]
        max_dd = 0

        for value in equity:
            if value > peak:
                peak = value
            dd = (peak - value) / peak * 100 if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd

        return max_dd

    def _calculate_distribution(self, values: list[float]) -> DistributionStats:
        """Calculate distribution statistics."""
        if not values:
            return DistributionStats()

        sorted_vals = sorted(values)
        n = len(sorted_vals)

        mean = sum(values) / n
        variance = sum((v - mean) ** 2 for v in values) / n
        std = variance ** 0.5

        median = sorted_vals[n // 2]

        return DistributionStats(
            mean=mean,
            median=median,
            std=std,
            min=sorted_vals[0],
            max=sorted_vals[-1],
            percentile_5=sorted_vals[int(n * 0.05)],
            percentile_25=sorted_vals[int(n * 0.25)],
            percentile_75=sorted_vals[int(n * 0.75)],
            percentile_95=sorted_vals[int(n * 0.95)],
        )

    def _generate_histogram(
        self,
        values: list[float],
        num_bins: int = 20,
    ) -> list[dict[str, Any]]:
        """Generate histogram data."""
        if not values:
            return []

        min_val = min(values)
        max_val = max(values)
        bin_width = (max_val - min_val) / num_bins

        bins = []
        for i in range(num_bins):
            bin_start = min_val + i * bin_width
            bin_end = bin_start + bin_width
            count = sum(
                1 for v in values
                if bin_start <= v < bin_end or (i == num_bins - 1 and v == max_val)
            )
            bins.append({
                "binStart": bin_start,
                "binEnd": bin_end,
                "count": count,
                "frequency": count / len(values),
            })

        return bins
