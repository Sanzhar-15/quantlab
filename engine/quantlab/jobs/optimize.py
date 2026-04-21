"""
Optimization Job Runner.

Executes parameter optimization with grid search.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

import itertools
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from .backtest import BacktestConfig
from .backtest import BacktestJob
from .backtest import BacktestResult
from .base import Job
from .base import JobConfig
from .base import JobContext
from .base import JobType
from .protocol import JobResult
from .protocol import LogLevel
from .protocol import MetricValue


@dataclass
class ParameterRange:
    """Definition of a parameter range for optimization."""

    name: str
    min_value: float
    max_value: float
    step: float
    param_type: str = "float"  # "int" or "float"

    def generate_values(self) -> list[float | int]:
        """Generate all values in the range."""
        values = []
        current = self.min_value
        while current <= self.max_value:
            if self.param_type == "int":
                values.append(int(current))
            else:
                values.append(round(current, 6))
            current += self.step
        return values

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "minValue": self.min_value,
            "maxValue": self.max_value,
            "step": self.step,
            "paramType": self.param_type,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ParameterRange":
        """Create from dictionary."""
        return cls(
            name=data["name"],
            min_value=data["minValue"],
            max_value=data["maxValue"],
            step=data["step"],
            param_type=data.get("paramType", "float"),
        )


@dataclass
class OptimizeConfig(JobConfig):
    """Configuration for optimization jobs."""

    # Parameter ranges
    parameter_ranges: list[ParameterRange] = field(default_factory=list)

    # Optimization settings
    metric: str = "sharpe"  # "sharpe", "return", "sortino", "calmar"
    maximize: bool = True

    # Backtest settings
    initial_capital: float = 100000.0
    commission: float = 0.001
    slippage: float = 0.0005

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        d = super().to_dict()
        d.update({
            "parameterRanges": [p.to_dict() for p in self.parameter_ranges],
            "metric": self.metric,
            "maximize": self.maximize,
            "initialCapital": self.initial_capital,
            "commission": self.commission,
            "slippage": self.slippage,
        })
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "OptimizeConfig":
        """Create from dictionary."""
        ranges = [
            ParameterRange.from_dict(r)
            for r in data.get("parameterRanges", [])
        ]
        return cls(
            symbol=data.get("symbol", ""),
            timeframe=data.get("timeframe", "1D"),
            start_date=data.get("startDate"),
            end_date=data.get("endDate"),
            data_source=data.get("dataSource", "default"),
            parameter_ranges=ranges,
            metric=data.get("metric", "sharpe"),
            maximize=data.get("maximize", True),
            initial_capital=data.get("initialCapital", 100000.0),
            commission=data.get("commission", 0.001),
            slippage=data.get("slippage", 0.0005),
        )


@dataclass
class OptimizationRun:
    """Result of a single optimization run."""

    params: dict[str, Any]
    metric_value: float
    sharpe: float
    total_return_percent: float
    max_drawdown_percent: float
    total_trades: int
    win_rate: float

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "params": self.params,
            "metricValue": self.metric_value,
            "sharpe": self.sharpe,
            "totalReturnPercent": self.total_return_percent,
            "maxDrawdownPercent": self.max_drawdown_percent,
            "totalTrades": self.total_trades,
            "winRate": self.win_rate,
        }


@dataclass
class OptimizeResult:
    """Results from an optimization run."""

    # Best result
    best_params: dict[str, Any] = field(default_factory=dict)
    best_metric_value: float = 0.0
    best_sharpe: float = 0.0
    best_return_percent: float = 0.0

    # All runs
    runs: list[OptimizationRun] = field(default_factory=list)
    total_combinations: int = 0
    completed_combinations: int = 0

    # Heatmap data (for 2D visualization)
    heatmap_data: dict[str, Any] | None = None

    def to_metrics(self) -> list[MetricValue]:
        """Convert to metric values for display."""
        return [
            MetricValue(
                name="Best Sharpe",
                value=round(self.best_sharpe, 2),
                format="number",
            ),
            MetricValue(
                name="Best Return %",
                value=round(self.best_return_percent, 2),
                format="percent",
            ),
            MetricValue(
                name="Combinations Tested",
                value=self.completed_combinations,
                format="number",
            ),
            MetricValue(
                name="Best Parameters",
                value=str(self.best_params),
                format="number",
            ),
        ]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "bestParams": self.best_params,
            "bestMetricValue": self.best_metric_value,
            "bestSharpe": self.best_sharpe,
            "bestReturnPercent": self.best_return_percent,
            "totalCombinations": self.total_combinations,
            "completedCombinations": self.completed_combinations,
            "runs": [r.to_dict() for r in self.runs],
            "heatmapData": self.heatmap_data,
        }


class OptimizeJob(Job):
    """
    Optimization job runner.

    Performs grid search optimization over parameter ranges.
    """

    @property
    def job_type(self) -> JobType:
        """Return job type."""
        return JobType.OPTIMIZE

    def validate_config(self, config: JobConfig) -> list[str]:
        """Validate optimization configuration."""
        errors = super().validate_config(config)

        if isinstance(config, OptimizeConfig):
            if not config.parameter_ranges:
                errors.append("At least one parameter range is required")

            for pr in config.parameter_ranges:
                if pr.min_value >= pr.max_value:
                    errors.append(
                        f"Parameter {pr.name}: min must be less than max"
                    )
                if pr.step <= 0:
                    errors.append(
                        f"Parameter {pr.name}: step must be positive"
                    )

        return errors

    def run(self, ctx: JobContext) -> JobResult:
        """
        Execute optimization.

        Args:
            ctx: Job execution context

        Returns:
            JobResult with optimization results
        """
        ctx.log_info(f"Starting optimization for {ctx.config.symbol}")

        # Parse config
        if isinstance(ctx.config, OptimizeConfig):
            config = ctx.config
        else:
            config = OptimizeConfig.from_dict(ctx.config.to_dict())

        ctx.log_info(f"Optimizing metric: {config.metric}")
        ctx.log_info(f"Parameter ranges: {len(config.parameter_ranges)}")

        # Generate parameter combinations
        ctx.progress(5, "Generating parameter combinations...")
        combinations = self._generate_combinations(config.parameter_ranges)

        result = OptimizeResult()
        result.total_combinations = len(combinations)

        ctx.log_info(f"Total combinations to test: {result.total_combinations}")

        if result.total_combinations == 0:
            raise ValueError("No parameter combinations to test")

        if result.total_combinations > 10000:
            ctx.log_warn(
                f"Large search space: {result.total_combinations} combinations"
            )

        # Create backtest job for running each combination
        backtest_job = BacktestJob()

        # Test each combination
        best_value = float('-inf') if config.maximize else float('inf')

        for i, params in enumerate(combinations):
            # Check cancellation
            ctx.check_cancelled()

            # Report progress
            pct = 10 + (i / len(combinations)) * 80
            ctx.progress(
                pct,
                f"Testing combination {i+1}/{len(combinations)}",
            )

            # Run backtest with these parameters
            try:
                bt_result = self._run_backtest(
                    ctx=ctx,
                    backtest_job=backtest_job,
                    config=config,
                    params=params,
                )

                # Extract metric value
                metric_value = self._get_metric_value(bt_result, config.metric)

                # Record run
                run = OptimizationRun(
                    params=params,
                    metric_value=metric_value,
                    sharpe=bt_result.sharpe_ratio,
                    total_return_percent=bt_result.total_return_percent,
                    max_drawdown_percent=bt_result.max_drawdown_percent,
                    total_trades=bt_result.total_trades,
                    win_rate=bt_result.win_rate,
                )
                result.runs.append(run)
                result.completed_combinations += 1

                # Update best
                is_better = (
                    metric_value > best_value if config.maximize
                    else metric_value < best_value
                )
                if is_better:
                    best_value = metric_value
                    result.best_params = params
                    result.best_metric_value = metric_value
                    result.best_sharpe = bt_result.sharpe_ratio
                    result.best_return_percent = bt_result.total_return_percent

                    ctx.log_info(
                        f"New best: {config.metric}={metric_value:.4f}, "
                        f"params={params}"
                    )

            except Exception as e:
                ctx.log_warn(f"Combination {params} failed: {e}")
                continue

        # Generate heatmap data if 2 parameters
        if len(config.parameter_ranges) == 2:
            result.heatmap_data = self._generate_heatmap(
                result.runs,
                config.parameter_ranges,
                config.metric,
            )

        # Write artifacts
        ctx.progress(95, "Writing artifacts...")

        result_path = ctx.write_artifact("result", result.to_dict())
        runs_path = ctx.write_artifact("runs", [r.to_dict() for r in result.runs])

        ctx.log_info(f"Optimization complete")
        ctx.log_info(f"Best {config.metric}: {result.best_metric_value:.4f}")
        ctx.log_info(f"Best params: {result.best_params}")

        # Build job result
        warnings = []
        if result.completed_combinations < result.total_combinations:
            failed = result.total_combinations - result.completed_combinations
            warnings.append(f"{failed} combinations failed")

        return JobResult(
            success=True,
            metrics=result.to_metrics(),
            warnings=warnings,
            details={
                "bestParams": result.best_params,
                "totalCombinations": result.total_combinations,
                "completedCombinations": result.completed_combinations,
            },
            artifact_paths={
                "result": str(result_path),
                "runs": str(runs_path),
            },
        )

    def _generate_combinations(
        self,
        ranges: list[ParameterRange],
    ) -> list[dict[str, Any]]:
        """Generate all parameter combinations."""
        if not ranges:
            return [{}]

        param_values = {}
        for pr in ranges:
            param_values[pr.name] = pr.generate_values()

        # Generate cartesian product
        keys = list(param_values.keys())
        value_lists = [param_values[k] for k in keys]

        combinations = []
        for values in itertools.product(*value_lists):
            combo = dict(zip(keys, values))
            combinations.append(combo)

        return combinations

    def _run_backtest(
        self,
        ctx: JobContext,
        backtest_job: BacktestJob,
        config: OptimizeConfig,
        params: dict[str, Any],
    ) -> BacktestResult:
        """Run a single backtest with given parameters."""
        # Create mock context for backtest
        # In production, this would be a proper sub-job

        bt_config = BacktestConfig(
            symbol=config.symbol,
            timeframe=config.timeframe,
            start_date=config.start_date,
            end_date=config.end_date,
            initial_capital=config.initial_capital,
            commission=config.commission,
            slippage=config.slippage,
        )

        # Execute simplified backtest inline
        result = BacktestResult()
        result = self._simplified_backtest(bt_config, params)

        return result

    def _simplified_backtest(
        self,
        config: BacktestConfig,
        params: dict[str, Any],
    ) -> BacktestResult:
        """Run a simplified backtest for optimization."""
        import random

        result = BacktestResult()

        # Get parameters
        fast_period = params.get("fast_period", 10)
        slow_period = params.get("slow_period", 20)

        # Generate mock data
        num_bars = 252
        price = 100.0
        equity = config.initial_capital
        position = 0.0
        entry_price = 0.0

        closes = []
        for _ in range(num_bars):
            change = random.gauss(0, 0.02)
            price *= (1 + change)
            closes.append(price)

        # Run strategy
        for i in range(slow_period, num_bars):
            fast_sma = sum(closes[i-fast_period+1:i+1]) / fast_period
            slow_sma = sum(closes[i-slow_period+1:i+1]) / slow_period

            if fast_sma > slow_sma and position == 0:
                position = equity / closes[i]
                entry_price = closes[i]
                equity -= position * entry_price * config.commission

            elif fast_sma < slow_sma and position > 0:
                pnl = position * (closes[i] - entry_price)
                pnl -= position * closes[i] * config.commission
                equity += pnl
                result.total_trades += 1
                if pnl > 0:
                    result.winning_trades += 1
                position = 0.0

            current_eq = equity + (position * (closes[i] - entry_price) if position > 0 else 0)
            result.equity_curve.append(current_eq)

        # Calculate metrics
        initial = config.initial_capital
        final = result.equity_curve[-1] if result.equity_curve else initial

        result.total_return_percent = (final / initial - 1) * 100

        if result.total_trades > 0:
            result.win_rate = (result.winning_trades / result.total_trades) * 100

        # Simplified sharpe
        if len(result.equity_curve) > 1:
            returns = []
            for i in range(1, len(result.equity_curve)):
                ret = (result.equity_curve[i] / result.equity_curve[i-1]) - 1
                returns.append(ret)

            if len(returns) >= 2:
                avg_ret = sum(returns) / len(returns)
                var = sum((r - avg_ret) ** 2 for r in returns) / (len(returns) - 1)
                std = var ** 0.5
                if std > 0:
                    result.sharpe_ratio = (avg_ret * 252) / (std * (252 ** 0.5))

        # Drawdown
        peak = initial
        max_dd_pct = 0
        for eq in result.equity_curve:
            if eq > peak:
                peak = eq
            dd_pct = ((peak - eq) / peak) * 100 if peak > 0 else 0
            if dd_pct > max_dd_pct:
                max_dd_pct = dd_pct

        result.max_drawdown_percent = max_dd_pct

        return result

    def _get_metric_value(
        self,
        result: BacktestResult,
        metric: str,
    ) -> float:
        """Extract metric value from backtest result."""
        metrics = {
            "sharpe": result.sharpe_ratio,
            "return": result.total_return_percent,
            "drawdown": -result.max_drawdown_percent,  # Negative so minimize works
            "win_rate": result.win_rate,
            "trades": result.total_trades,
        }
        return metrics.get(metric, result.sharpe_ratio)

    def _generate_heatmap(
        self,
        runs: list[OptimizationRun],
        ranges: list[ParameterRange],
        metric: str,
    ) -> dict[str, Any]:
        """Generate heatmap data for 2D parameter visualization."""
        if len(ranges) != 2:
            return None

        param1, param2 = ranges[0].name, ranges[1].name

        # Build matrix
        values1 = sorted(set(r.params.get(param1) for r in runs))
        values2 = sorted(set(r.params.get(param2) for r in runs))

        matrix = []
        for v2 in values2:
            row = []
            for v1 in values1:
                # Find run with these params
                run = next(
                    (r for r in runs
                     if r.params.get(param1) == v1 and r.params.get(param2) == v2),
                    None
                )
                if run:
                    row.append(run.metric_value)
                else:
                    row.append(None)
            matrix.append(row)

        return {
            "param1": param1,
            "param2": param2,
            "values1": values1,
            "values2": values2,
            "matrix": matrix,
            "metric": metric,
        }
