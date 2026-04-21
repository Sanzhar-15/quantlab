"""
Walk-Forward Analysis Job Runner.

Runs walk-forward optimization to test strategy robustness
across multiple in-sample/out-of-sample periods.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

from dataclasses import dataclass
from dataclasses import field
from typing import Any

from .optimize import OptimizeJob
from .optimize import ParameterRange
from .backtest import BacktestConfig
from .base import Job
from .base import JobConfig
from .base import JobContext
from .base import JobType
from .protocol import JobResult
from .protocol import LogLevel
from .protocol import MetricValue


@dataclass
class WFAConfig(JobConfig):
    """Configuration for Walk-Forward Analysis jobs."""

    # WFA settings
    num_splits: int = 5  # Number of walk-forward windows
    train_ratio: float = 0.7  # 70% training, 30% testing
    optimization_metric: str = "sharpe"

    # Parameter ranges (for optimization on training data)
    parameter_ranges: list[ParameterRange] = field(default_factory=list)

    # Backtest settings
    initial_capital: float = 100000.0
    commission: float = 0.001
    slippage: float = 0.0005

    # Advanced options
    anchored: bool = False  # If True, always start from beginning
    min_train_bars: int = 50  # Minimum bars in training period

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        d = super().to_dict()
        d.update({
            "numSplits": self.num_splits,
            "trainRatio": self.train_ratio,
            "optimizationMetric": self.optimization_metric,
            "parameterRanges": [p.to_dict() for p in self.parameter_ranges],
            "initialCapital": self.initial_capital,
            "commission": self.commission,
            "slippage": self.slippage,
            "anchored": self.anchored,
            "minTrainBars": self.min_train_bars,
        })
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WFAConfig":
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
            num_splits=data.get("numSplits", 5),
            train_ratio=data.get("trainRatio", 0.7),
            optimization_metric=data.get("optimizationMetric", "sharpe"),
            parameter_ranges=ranges,
            initial_capital=data.get("initialCapital", 100000.0),
            commission=data.get("commission", 0.001),
            slippage=data.get("slippage", 0.0005),
            anchored=data.get("anchored", False),
            min_train_bars=data.get("minTrainBars", 50),
        )


@dataclass
class WFASplit:
    """Result of a single WFA split."""

    split_number: int
    train_start_idx: int
    train_end_idx: int
    test_start_idx: int
    test_end_idx: int

    # Optimization result
    best_params: dict[str, Any] = field(default_factory=dict)
    train_metric_value: float = 0.0
    train_sharpe: float = 0.0
    train_return_percent: float = 0.0

    # Test result
    test_metric_value: float = 0.0
    test_sharpe: float = 0.0
    test_return_percent: float = 0.0
    test_max_drawdown_percent: float = 0.0
    test_total_trades: int = 0

    # Robustness metrics
    efficiency_ratio: float = 0.0  # test/train metric ratio

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "splitNumber": self.split_number,
            "trainStartIdx": self.train_start_idx,
            "trainEndIdx": self.train_end_idx,
            "testStartIdx": self.test_start_idx,
            "testEndIdx": self.test_end_idx,
            "bestParams": self.best_params,
            "trainMetricValue": self.train_metric_value,
            "trainSharpe": self.train_sharpe,
            "trainReturnPercent": self.train_return_percent,
            "testMetricValue": self.test_metric_value,
            "testSharpe": self.test_sharpe,
            "testReturnPercent": self.test_return_percent,
            "testMaxDrawdownPercent": self.test_max_drawdown_percent,
            "testTotalTrades": self.test_total_trades,
            "efficiencyRatio": self.efficiency_ratio,
        }


@dataclass
class WFAResult:
    """Results from Walk-Forward Analysis."""

    # Aggregate metrics
    avg_train_sharpe: float = 0.0
    avg_test_sharpe: float = 0.0
    avg_efficiency_ratio: float = 0.0
    combined_test_return: float = 0.0
    combined_test_sharpe: float = 0.0

    # Consistency metrics
    positive_splits: int = 0
    total_splits: int = 0
    consistency_ratio: float = 0.0  # % of profitable test periods

    # Robustness score (0-100)
    robustness_score: float = 0.0

    # Per-split results
    splits: list[WFASplit] = field(default_factory=list)

    # Combined equity curve (from all test periods)
    combined_equity: list[float] = field(default_factory=list)
    combined_timestamps: list[float] = field(default_factory=list)

    def to_metrics(self) -> list[MetricValue]:
        """Convert to metric values for display."""
        return [
            MetricValue(
                name="Combined Test Return",
                value=round(self.combined_test_return, 2),
                format="percent",
            ),
            MetricValue(
                name="Avg Test Sharpe",
                value=round(self.avg_test_sharpe, 2),
                format="number",
            ),
            MetricValue(
                name="Efficiency Ratio",
                value=round(self.avg_efficiency_ratio, 2),
                format="number",
                description="Test/Train performance ratio",
            ),
            MetricValue(
                name="Consistency",
                value=round(self.consistency_ratio, 1),
                format="percent",
            ),
            MetricValue(
                name="Robustness Score",
                value=round(self.robustness_score, 0),
                format="number",
            ),
            MetricValue(
                name="Profitable Splits",
                value=f"{self.positive_splits}/{self.total_splits}",
                format="number",
            ),
        ]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "avgTrainSharpe": self.avg_train_sharpe,
            "avgTestSharpe": self.avg_test_sharpe,
            "avgEfficiencyRatio": self.avg_efficiency_ratio,
            "combinedTestReturn": self.combined_test_return,
            "combinedTestSharpe": self.combined_test_sharpe,
            "positiveSplits": self.positive_splits,
            "totalSplits": self.total_splits,
            "consistencyRatio": self.consistency_ratio,
            "robustnessScore": self.robustness_score,
            "splits": [s.to_dict() for s in self.splits],
        }


class WFAJob(Job):
    """
    Walk-Forward Analysis job runner.

    Divides data into multiple train/test periods, optimizes
    parameters on training data, and validates on test data.
    """

    @property
    def job_type(self) -> JobType:
        """Return job type."""
        return JobType.WFA

    def validate_config(self, config: JobConfig) -> list[str]:
        """Validate WFA configuration."""
        errors = super().validate_config(config)

        if isinstance(config, WFAConfig):
            if config.num_splits < 2:
                errors.append("Number of splits must be at least 2")
            if config.num_splits > 20:
                errors.append("Number of splits cannot exceed 20")
            if not 0.5 <= config.train_ratio <= 0.9:
                errors.append("Train ratio must be between 0.5 and 0.9")
            if not config.parameter_ranges:
                errors.append("At least one parameter range is required")

        return errors

    def run(self, ctx: JobContext) -> JobResult:
        """
        Execute Walk-Forward Analysis.

        Args:
            ctx: Job execution context

        Returns:
            JobResult with WFA results
        """
        ctx.log_info(f"Starting Walk-Forward Analysis for {ctx.config.symbol}")

        # Parse config
        if isinstance(ctx.config, WFAConfig):
            config = ctx.config
        else:
            config = WFAConfig.from_dict(ctx.config.to_dict())

        ctx.log_info(f"Number of splits: {config.num_splits}")
        ctx.log_info(f"Train/Test ratio: {config.train_ratio:.0%}/{1-config.train_ratio:.0%}")
        ctx.log_info(f"Optimization metric: {config.optimization_metric}")

        # Load data
        ctx.progress(5, "Loading market data...")
        data = self._load_data(config)

        if len(data) < config.min_train_bars * config.num_splits:
            raise ValueError(
                f"Insufficient data for {config.num_splits} splits "
                f"(need at least {config.min_train_bars * config.num_splits} bars)"
            )

        ctx.log_info(f"Loaded {len(data)} bars")

        # Calculate split boundaries
        splits = self._calculate_splits(len(data), config)

        result = WFAResult()
        result.total_splits = len(splits)

        # Process each split
        for i, (train_start, train_end, test_start, test_end) in enumerate(splits):
            ctx.check_cancelled()

            pct = 10 + (i / len(splits)) * 80
            ctx.progress(pct, f"Processing split {i+1}/{len(splits)}")

            ctx.log_info(
                f"Split {i+1}: Train [{train_start}:{train_end}], "
                f"Test [{test_start}:{test_end}]"
            )

            # Optimize on training data
            train_data = data[train_start:train_end]
            best_params, train_metric, train_sharpe, train_return = self._optimize(
                ctx, config, train_data
            )

            ctx.log_info(f"Split {i+1} best params: {best_params}")
            ctx.log_info(f"Split {i+1} train {config.optimization_metric}: {train_metric:.4f}")

            # Validate on test data
            test_data = data[test_start:test_end]
            test_result = self._backtest(config, test_data, best_params)

            # Record split result
            split = WFASplit(
                split_number=i + 1,
                train_start_idx=train_start,
                train_end_idx=train_end,
                test_start_idx=test_start,
                test_end_idx=test_end,
                best_params=best_params,
                train_metric_value=train_metric,
                train_sharpe=train_sharpe,
                train_return_percent=train_return,
                test_metric_value=test_result["metric"],
                test_sharpe=test_result["sharpe"],
                test_return_percent=test_result["return"],
                test_max_drawdown_percent=test_result["max_dd"],
                test_total_trades=test_result["trades"],
            )

            # Calculate efficiency ratio
            if train_metric != 0:
                split.efficiency_ratio = test_result["metric"] / train_metric
            else:
                split.efficiency_ratio = 0

            result.splits.append(split)

            # Track profitable splits
            if test_result["return"] > 0:
                result.positive_splits += 1

            # Append test equity to combined
            result.combined_equity.extend(test_result["equity"])
            result.combined_timestamps.extend(
                [test_data[j]["timestamp"] for j in range(len(test_result["equity"]))]
            )

            ctx.log_info(
                f"Split {i+1} test {config.optimization_metric}: {test_result['metric']:.4f}, "
                f"efficiency: {split.efficiency_ratio:.2f}"
            )

        # Calculate aggregate metrics
        ctx.progress(92, "Calculating aggregate metrics...")

        result.avg_train_sharpe = (
            sum(s.train_sharpe for s in result.splits) / len(result.splits)
        )
        result.avg_test_sharpe = (
            sum(s.test_sharpe for s in result.splits) / len(result.splits)
        )
        result.avg_efficiency_ratio = (
            sum(s.efficiency_ratio for s in result.splits) / len(result.splits)
        )

        # Combined test return
        if result.combined_equity:
            initial = config.initial_capital
            final = result.combined_equity[-1] if result.combined_equity else initial
            result.combined_test_return = (final / initial - 1) * 100

        # Consistency ratio
        result.consistency_ratio = (
            result.positive_splits / result.total_splits * 100
        )

        # Calculate robustness score (0-100)
        result.robustness_score = self._calculate_robustness_score(result)

        # Write artifacts
        ctx.progress(95, "Writing artifacts...")

        result_path = ctx.write_artifact("result", result.to_dict())
        splits_path = ctx.write_artifact("splits", [s.to_dict() for s in result.splits])
        equity_path = ctx.write_artifact("equity", {
            "timestamps": result.combined_timestamps,
            "equity": result.combined_equity,
        })

        ctx.log_info("Walk-Forward Analysis complete")
        ctx.log_info(f"Combined test return: {result.combined_test_return:.2f}%")
        ctx.log_info(f"Robustness score: {result.robustness_score:.0f}/100")

        # Build job result
        warnings = []
        if result.consistency_ratio < 50:
            warnings.append(
                f"Low consistency: only {result.consistency_ratio:.0f}% profitable splits"
            )
        if result.avg_efficiency_ratio < 0.5:
            warnings.append(
                f"Low efficiency ratio ({result.avg_efficiency_ratio:.2f}): "
                "strategy may be overfit"
            )

        return JobResult(
            success=True,
            metrics=result.to_metrics(),
            warnings=warnings,
            details={
                "combinedTestReturn": result.combined_test_return,
                "avgEfficiencyRatio": result.avg_efficiency_ratio,
                "consistencyRatio": result.consistency_ratio,
                "robustnessScore": result.robustness_score,
            },
            artifact_paths={
                "result": str(result_path),
                "splits": str(splits_path),
                "equity": str(equity_path),
            },
        )

    def _load_data(self, config: WFAConfig) -> list[dict[str, Any]]:
        """Load market data for WFA."""
        import random
        import time

        # Generate mock data (in production, use DataService)
        bars = []
        price = 100.0
        num_bars = 500  # About 2 years of daily data

        current_time = time.time() - (num_bars * 86400)

        for i in range(num_bars):
            change = random.gauss(0, 0.015)
            price *= (1 + change)

            open_price = price * (1 + random.uniform(-0.003, 0.003))
            high_price = max(price, open_price) * (1 + random.uniform(0, 0.008))
            low_price = min(price, open_price) * (1 - random.uniform(0, 0.008))

            bars.append({
                "timestamp": current_time,
                "open": round(open_price, 2),
                "high": round(high_price, 2),
                "low": round(low_price, 2),
                "close": round(price, 2),
                "volume": int(1000000 * random.uniform(0.5, 1.5)),
            })

            current_time += 86400

        return bars

    def _calculate_splits(
        self,
        total_bars: int,
        config: WFAConfig,
    ) -> list[tuple[int, int, int, int]]:
        """Calculate train/test split boundaries."""
        splits = []

        if config.anchored:
            # Anchored: always start training from bar 0
            test_size = total_bars // config.num_splits

            for i in range(config.num_splits):
                test_start = (i + 1) * test_size
                test_end = min((i + 2) * test_size, total_bars)
                train_end = test_start

                if train_end < config.min_train_bars:
                    continue

                splits.append((0, train_end, test_start, test_end))
        else:
            # Rolling: each window is the same size
            window_size = total_bars // config.num_splits
            train_size = int(window_size * config.train_ratio)
            test_size = window_size - train_size

            for i in range(config.num_splits):
                start = i * window_size
                train_end = start + train_size
                test_start = train_end
                test_end = min(start + window_size, total_bars)

                if train_size < config.min_train_bars:
                    continue

                splits.append((start, train_end, test_start, test_end))

        return splits

    def _optimize(
        self,
        ctx: JobContext,
        config: WFAConfig,
        data: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], float, float, float]:
        """Optimize parameters on training data."""
        import random
        import itertools

        # Generate parameter combinations
        param_values = {}
        for pr in config.parameter_ranges:
            param_values[pr.name] = pr.generate_values()

        keys = list(param_values.keys())
        value_lists = [param_values[k] for k in keys]

        best_params = {}
        best_metric = float('-inf')
        best_sharpe = 0.0
        best_return = 0.0

        for values in itertools.product(*value_lists):
            params = dict(zip(keys, values))

            # Run simplified backtest
            result = self._backtest(config, data, params)

            if result["metric"] > best_metric:
                best_metric = result["metric"]
                best_params = params
                best_sharpe = result["sharpe"]
                best_return = result["return"]

        return best_params, best_metric, best_sharpe, best_return

    def _backtest(
        self,
        config: WFAConfig,
        data: list[dict[str, Any]],
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Run backtest with given parameters."""
        equity = config.initial_capital
        position = 0.0
        entry_price = 0.0
        trades = 0
        wins = 0

        fast_period = params.get("fast_period", 10)
        slow_period = params.get("slow_period", 20)

        closes = [bar["close"] for bar in data]
        equity_curve = []

        for i in range(len(data)):
            if i < slow_period:
                equity_curve.append(equity)
                continue

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
                trades += 1
                if pnl > 0:
                    wins += 1
                position = 0.0

            current_eq = equity + (position * (closes[i] - entry_price) if position > 0 else 0)
            equity_curve.append(current_eq)

        # Calculate metrics
        initial = config.initial_capital
        final = equity_curve[-1] if equity_curve else initial
        total_return = (final / initial - 1) * 100

        # Sharpe
        sharpe = 0.0
        if len(equity_curve) > 1:
            returns = []
            for i in range(1, len(equity_curve)):
                ret = (equity_curve[i] / equity_curve[i-1]) - 1
                returns.append(ret)

            if len(returns) >= 2:
                avg_ret = sum(returns) / len(returns)
                var = sum((r - avg_ret) ** 2 for r in returns) / (len(returns) - 1)
                std = var ** 0.5
                if std > 0:
                    sharpe = (avg_ret * 252) / (std * (252 ** 0.5))

        # Max drawdown
        peak = initial
        max_dd = 0
        for eq in equity_curve:
            if eq > peak:
                peak = eq
            dd = (peak - eq) / peak * 100 if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd

        # Metric value
        metrics = {
            "sharpe": sharpe,
            "return": total_return,
            "win_rate": (wins / trades * 100) if trades > 0 else 0,
        }
        metric_value = metrics.get(config.optimization_metric, sharpe)

        return {
            "metric": metric_value,
            "sharpe": sharpe,
            "return": total_return,
            "max_dd": max_dd,
            "trades": trades,
            "equity": equity_curve,
        }

    def _calculate_robustness_score(self, result: WFAResult) -> float:
        """
        Calculate robustness score (0-100).

        Based on:
        - Consistency ratio (40%)
        - Average efficiency ratio (30%)
        - Combined test performance (30%)
        """
        # Consistency component (0-40)
        consistency_score = min(40, result.consistency_ratio * 0.4)

        # Efficiency component (0-30)
        # Efficiency of 1.0 = 30 points, 0.5 = 15, 0 = 0
        efficiency_score = min(30, max(0, result.avg_efficiency_ratio * 30))

        # Performance component (0-30)
        # Positive return = up to 30 points
        if result.combined_test_return > 0:
            perf_score = min(30, result.combined_test_return)
        else:
            perf_score = 0

        return consistency_score + efficiency_score + perf_score
