"""
Benchmark Runner.

Executes benchmarks and collects timing statistics.
"""

import argparse
import gc
import json
import statistics
import time
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any


@dataclass
class BenchmarkConfig:
    """Configuration for a benchmark."""

    name: str
    data_file: str
    strategy_file: str
    target_p95_seconds: float
    warmup_runs: int = 2
    measured_runs: int = 5
    description: str = ""


@dataclass
class BenchmarkResult:
    """Result of a benchmark run."""

    name: str
    runs: list[float]  # Individual run times in seconds
    mean: float
    median: float
    std: float
    min: float
    max: float
    p95: float
    target_p95: float
    passed: bool
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# Default benchmark configurations
BENCHMARKS = [
    BenchmarkConfig(
        name="bench_small",
        data_file="data/bench_small.csv",
        strategy_file="strategies/sma_crossover.py",
        target_p95_seconds=0.5,
        description="1Y daily data (252 bars), SMA crossover",
    ),
    BenchmarkConfig(
        name="bench_medium",
        data_file="data/bench_medium.csv",
        strategy_file="strategies/rsi_macd.py",
        target_p95_seconds=2.0,
        description="5Y daily data (1,260 bars), RSI + MACD",
    ),
    BenchmarkConfig(
        name="bench_large",
        data_file="data/bench_large.csv",
        strategy_file="strategies/momentum.py",
        target_p95_seconds=60.0,
        description="1Y minute data (~98k bars), Momentum",
    ),
    BenchmarkConfig(
        name="bench_multi",
        data_file="data/bench_multi.csv",
        strategy_file="strategies/rotation.py",
        target_p95_seconds=10.0,
        description="5Y 10-symbol data (12,600 bars), Rotation",
    ),
]


class BenchmarkRunner:
    """
    Runs benchmarks and collects timing statistics.

    Usage:
        runner = BenchmarkRunner()
        results = runner.run_all()
        runner.save_results(results, "results.json")
    """

    def __init__(self, benchmarks_dir: Path | None = None):
        self.benchmarks_dir = benchmarks_dir or Path(__file__).parent
        self.configs = BENCHMARKS

    def run_benchmark(self, config: BenchmarkConfig) -> BenchmarkResult:
        """Run a single benchmark."""
        data_path = self.benchmarks_dir / config.data_file
        strategy_path = self.benchmarks_dir / config.strategy_file

        # Check files exist
        if not data_path.exists():
            return BenchmarkResult(
                name=config.name,
                runs=[],
                mean=0,
                median=0,
                std=0,
                min=0,
                max=0,
                p95=0,
                target_p95=config.target_p95_seconds,
                passed=False,
                error=f"Data file not found: {data_path}",
            )

        if not strategy_path.exists():
            return BenchmarkResult(
                name=config.name,
                runs=[],
                mean=0,
                median=0,
                std=0,
                min=0,
                max=0,
                p95=0,
                target_p95=config.target_p95_seconds,
                passed=False,
                error=f"Strategy file not found: {strategy_path}",
            )

        # Warmup runs (not measured)
        for _ in range(config.warmup_runs):
            self._run_backtest(data_path, strategy_path)
            gc.collect()

        # Measured runs
        times = []
        for _ in range(config.measured_runs):
            gc.collect()
            start = time.perf_counter()
            self._run_backtest(data_path, strategy_path)
            elapsed = time.perf_counter() - start
            times.append(elapsed)

        # Calculate statistics
        times_sorted = sorted(times)
        p95_index = int(len(times_sorted) * 0.95)
        p95 = times_sorted[min(p95_index, len(times_sorted) - 1)]

        return BenchmarkResult(
            name=config.name,
            runs=times,
            mean=statistics.mean(times),
            median=statistics.median(times),
            std=statistics.stdev(times) if len(times) > 1 else 0,
            min=min(times),
            max=max(times),
            p95=p95,
            target_p95=config.target_p95_seconds,
            passed=p95 <= config.target_p95_seconds,
            metadata={
                "data_file": str(data_path),
                "strategy_file": str(strategy_path),
                "warmup_runs": config.warmup_runs,
                "measured_runs": config.measured_runs,
            },
        )

    def _run_backtest(self, data_path: Path, strategy_path: Path) -> None:
        """
        Execute a backtest using the actual engine.

        Loads data from CSV, adapts the strategy file, and runs
        the BacktestEngine.
        """
        from datetime import datetime
        from decimal import Decimal

        from quantlab.backtest.bar import Bar, BarSeries
        from quantlab.backtest.config import BacktestConfig
        from quantlab.backtest.core import BacktestEngine, Signal, OrderSide, OrderType
        from quantlab.data.service import CSVLoader, Timeframe

        # Load data from CSV
        series = CSVLoader.load(data_path, timeframe=Timeframe.DAILY)

        if not series.bars:
            raise ValueError(f"No data loaded from {data_path}")

        # Convert OHLCVSeries to BarSeries format expected by engine
        symbol = series.symbol
        bars = []
        for ohlcv_bar in series.bars:
            # Convert timestamp to datetime if needed
            ts = ohlcv_bar.timestamp
            if isinstance(ts, (int, float)):
                ts = datetime.fromtimestamp(ts)

            bar = Bar(
                timestamp=ts,
                open=Decimal(str(ohlcv_bar.open)),
                high=Decimal(str(ohlcv_bar.high)),
                low=Decimal(str(ohlcv_bar.low)),
                close=Decimal(str(ohlcv_bar.close)),
                volume=Decimal(str(ohlcv_bar.volume)),
                symbol=symbol,
            )
            bars.append(bar)

        bar_series = BarSeries(symbol=symbol, timeframe="1d", bars=bars)

        # Create strategy adapter
        # The benchmark strategies use pandas-like syntax, so we create
        # a simple adapter that implements the Protocol expected by BacktestEngine
        class BenchmarkStrategyAdapter:
            """Adapts benchmark strategies to the BacktestEngine Protocol."""

            def __init__(self, strategy_path: Path):
                self._strategy_path = strategy_path
                self._position = Decimal("0")
                self._lookback = 20  # Default lookback for SMA

            def evaluate(
                self, data: dict[str, BarSeries], bar_index: int
            ) -> list[Signal]:
                """Generate signals using simple SMA crossover logic."""
                signals = []

                for sym, series in data.items():
                    if bar_index < self._lookback:
                        continue

                    # Get closing prices for SMA calculation
                    closes = [series[i].close for i in range(bar_index - self._lookback + 1, bar_index + 1)]

                    if len(closes) < self._lookback:
                        continue

                    # Simple SMA crossover (fast=10, slow=20)
                    fast_period = 10
                    slow_period = 20

                    if len(closes) >= slow_period:
                        fast_sma = sum(closes[-fast_period:]) / fast_period
                        slow_sma = sum(closes[-slow_period:]) / slow_period

                        current_price = series[bar_index].close

                        # Generate signals based on crossover
                        if fast_sma > slow_sma and self._position <= Decimal("0"):
                            # Buy signal
                            signals.append(Signal(
                                symbol=sym,
                                side=OrderSide.BUY,
                                quantity=Decimal("100"),
                                order_type=OrderType.MARKET,
                            ))
                            self._position = Decimal("100")
                        elif fast_sma < slow_sma and self._position > Decimal("0"):
                            # Sell signal
                            signals.append(Signal(
                                symbol=sym,
                                side=OrderSide.SELL,
                                quantity=self._position,
                                order_type=OrderType.MARKET,
                            ))
                            self._position = Decimal("0")

                return signals

        strategy = BenchmarkStrategyAdapter(strategy_path)

        # Get date range from data
        start_date = bars[0].timestamp
        end_date = bars[-1].timestamp

        # Create config
        config = BacktestConfig(
            start_date=start_date,
            end_date=end_date,
            initial_capital=Decimal("100000"),
            symbols=[symbol],
        )

        # Create and run engine
        engine = BacktestEngine(config)
        engine.load_data({symbol: bar_series})
        result = engine.run(strategy)

        # Result is discarded since runner only measures timing
        # But we verify it completed without error
        if result.error:
            raise RuntimeError(f"Backtest error: {result.error}")

    def run_all(self) -> list[BenchmarkResult]:
        """Run all configured benchmarks."""
        results = []
        for config in self.configs:
            print(f"Running {config.name}...")
            result = self.run_benchmark(config)
            results.append(result)
            status = "PASS" if result.passed else "FAIL"
            print(f"  {status}: p95={result.p95:.3f}s (target: {result.target_p95:.1f}s)")
        return results

    def run_by_name(self, names: list[str]) -> list[BenchmarkResult]:
        """Run specific benchmarks by name."""
        results = []
        for config in self.configs:
            if config.name in names:
                result = self.run_benchmark(config)
                results.append(result)
        return results

    def save_results(self, results: list[BenchmarkResult], output_path: Path | str) -> None:
        """Save benchmark results to JSON."""
        output_path = Path(output_path)
        data = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "results": [asdict(r) for r in results],
            "summary": {
                "total": len(results),
                "passed": sum(1 for r in results if r.passed),
                "failed": sum(1 for r in results if not r.passed),
            },
        }
        with output_path.open("w") as f:
            json.dump(data, f, indent=2)
        print(f"Results saved to {output_path}")

    def report(self, results: list[BenchmarkResult]) -> str:
        """Generate a text report of benchmark results."""
        lines = [
            "=" * 70,
            "BENCHMARK RESULTS",
            "=" * 70,
            "",
            f"{'Name':<20} {'p95':>10} {'Target':>10} {'Mean':>10} {'Status':>10}",
            "-" * 70,
        ]

        for r in results:
            status = "PASS" if r.passed else "FAIL"
            lines.append(
                f"{r.name:<20} {r.p95:>10.3f}s {r.target_p95:>10.1f}s {r.mean:>10.3f}s {status:>10}"
            )

        lines.extend([
            "-" * 70,
            f"Total: {len(results)} | Passed: {sum(1 for r in results if r.passed)} | "
            f"Failed: {sum(1 for r in results if not r.passed)}",
            "=" * 70,
        ])

        return "\n".join(lines)


    def run_by_strategy(self, strategy_names: list[str]) -> list[BenchmarkResult]:
        """Run benchmarks that use specified strategies (FIX-B006)."""
        results = []
        for config in self.configs:
            strategy_stem = Path(config.strategy_file).stem
            if strategy_stem in strategy_names:
                result = self.run_benchmark(config)
                results.append(result)
        return results


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Run Quantlab benchmarks")
    parser.add_argument("--output", "-o", type=str, help="Output JSON file path")
    parser.add_argument("--benchmark", "-b", type=str, nargs="*", help="Specific benchmarks to run by name")
    parser.add_argument(
        "--strategy", "-s", type=str, nargs="*",
        help="Run benchmarks using specific strategies (e.g., sma_crossover momentum)",
    )
    parser.add_argument("--list", "-l", action="store_true", help="List available benchmarks")
    args = parser.parse_args()

    runner = BenchmarkRunner()

    if args.list:
        print("Available benchmarks:")
        for config in runner.configs:
            strategy_name = Path(config.strategy_file).stem
            print(f"  {config.name} [strategy: {strategy_name}]: {config.description}")
        return

    if args.benchmark:
        results = runner.run_by_name(args.benchmark)
    elif args.strategy:
        results = runner.run_by_strategy(args.strategy)
    else:
        results = runner.run_all()

    print()
    print(runner.report(results))

    if args.output:
        runner.save_results(results, args.output)


if __name__ == "__main__":
    main()
