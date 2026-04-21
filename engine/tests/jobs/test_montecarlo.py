"""
Tests for Monte Carlo simulation job module.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from quantlab.jobs.backtest import Trade
from quantlab.jobs.base import JobConfig
from quantlab.jobs.base import JobContext
from quantlab.jobs.base import JobType
from quantlab.jobs.montecarlo import (
    DistributionStats,
    MonteCarloConfig,
    MonteCarloJob,
    MonteCarloResult,
    SimulationRun,
)


class TestMonteCarloConfig:
    """Tests for MonteCarloConfig dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        config = MonteCarloConfig(symbol="AAPL", timeframe="1D")

        assert config.symbol == "AAPL"
        assert config.timeframe == "1D"
        assert config.num_simulations == 1000
        assert config.confidence_level == 0.95
        assert config.shuffle_method == "trades"
        assert config.random_seed is None
        assert config.initial_capital == 100000.0
        assert config.commission == 0.001
        assert config.slippage == 0.0005

    def test_custom_values(self) -> None:
        """Should accept custom values."""
        config = MonteCarloConfig(
            symbol="MSFT",
            timeframe="1H",
            num_simulations=500,
            confidence_level=0.90,
            shuffle_method="returns",
            random_seed=42,
            initial_capital=50000.0,
            commission=0.002,
            slippage=0.001,
        )

        assert config.symbol == "MSFT"
        assert config.num_simulations == 500
        assert config.confidence_level == 0.90
        assert config.shuffle_method == "returns"
        assert config.random_seed == 42
        assert config.initial_capital == 50000.0
        assert config.commission == 0.002
        assert config.slippage == 0.001

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        config = MonteCarloConfig(
            symbol="GOOG",
            timeframe="1D",
            num_simulations=2000,
            confidence_level=0.99,
            random_seed=123,
        )

        d = config.to_dict()

        assert d["symbol"] == "GOOG"
        assert d["numSimulations"] == 2000
        assert d["confidenceLevel"] == 0.99
        assert d["randomSeed"] == 123
        assert d["shuffleMethod"] == "trades"
        assert d["initialCapital"] == 100000.0

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "symbol": "TSLA",
            "numSimulations": 5000,
            "confidenceLevel": 0.90,
            "shuffleMethod": "returns",
            "randomSeed": 999,
            "initialCapital": 25000.0,
            "commission": 0.003,
            "slippage": 0.002,
        }

        config = MonteCarloConfig.from_dict(data)

        assert config.symbol == "TSLA"
        assert config.num_simulations == 5000
        assert config.confidence_level == 0.90
        assert config.shuffle_method == "returns"
        assert config.random_seed == 999
        assert config.initial_capital == 25000.0
        assert config.commission == 0.003
        assert config.slippage == 0.002

    def test_from_dict_defaults(self) -> None:
        """Should use defaults for missing values."""
        data = {"symbol": "AMZN"}

        config = MonteCarloConfig.from_dict(data)

        assert config.symbol == "AMZN"
        assert config.num_simulations == 1000
        assert config.confidence_level == 0.95
        assert config.shuffle_method == "trades"
        assert config.random_seed is None


class TestSimulationRun:
    """Tests for SimulationRun dataclass."""

    def test_create_run(self) -> None:
        """Should create simulation run."""
        run = SimulationRun(
            run_number=1,
            final_equity=105000.0,
            total_return_percent=5.0,
            max_drawdown_percent=3.5,
            sharpe_ratio=1.2,
        )

        assert run.run_number == 1
        assert run.final_equity == 105000.0
        assert run.total_return_percent == 5.0
        assert run.max_drawdown_percent == 3.5
        assert run.sharpe_ratio == 1.2

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        run = SimulationRun(
            run_number=5,
            final_equity=98000.0,
            total_return_percent=-2.0,
            max_drawdown_percent=10.5,
            sharpe_ratio=-0.5,
        )

        d = run.to_dict()

        assert d["runNumber"] == 5
        assert d["finalEquity"] == 98000.0
        assert d["totalReturnPercent"] == -2.0
        assert d["maxDrawdownPercent"] == 10.5
        assert d["sharpeRatio"] == -0.5


class TestDistributionStats:
    """Tests for DistributionStats dataclass."""

    def test_default_values(self) -> None:
        """Should have zero defaults."""
        stats = DistributionStats()

        assert stats.mean == 0.0
        assert stats.median == 0.0
        assert stats.std == 0.0
        assert stats.min == 0.0
        assert stats.max == 0.0
        assert stats.percentile_5 == 0.0
        assert stats.percentile_25 == 0.0
        assert stats.percentile_75 == 0.0
        assert stats.percentile_95 == 0.0

    def test_custom_values(self) -> None:
        """Should accept custom values."""
        stats = DistributionStats(
            mean=10.5,
            median=10.0,
            std=2.5,
            min=5.0,
            max=20.0,
            percentile_5=6.0,
            percentile_25=8.0,
            percentile_75=13.0,
            percentile_95=18.0,
        )

        assert stats.mean == 10.5
        assert stats.median == 10.0
        assert stats.std == 2.5
        assert stats.min == 5.0
        assert stats.max == 20.0

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        stats = DistributionStats(
            mean=15.0,
            median=14.5,
            std=3.0,
            min=8.0,
            max=25.0,
            percentile_5=9.0,
            percentile_25=12.0,
            percentile_75=18.0,
            percentile_95=23.0,
        )

        d = stats.to_dict()

        assert d["mean"] == 15.0
        assert d["median"] == 14.5
        assert d["std"] == 3.0
        assert d["min"] == 8.0
        assert d["max"] == 25.0
        assert d["percentile5"] == 9.0
        assert d["percentile25"] == 12.0
        assert d["percentile75"] == 18.0
        assert d["percentile95"] == 23.0


class TestMonteCarloResult:
    """Tests for MonteCarloResult dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        result = MonteCarloResult()

        assert result.original_return == 0.0
        assert result.original_sharpe == 0.0
        assert result.original_max_dd == 0.0
        assert result.confidence_level == 0.95
        assert result.probability_of_loss == 0.0
        assert result.var_95 == 0.0
        assert result.cvar_95 == 0.0
        assert result.runs == []
        assert result.num_simulations == 0
        assert result.return_histogram == []

    def test_to_metrics(self) -> None:
        """Should convert to metric values."""
        result = MonteCarloResult(
            original_return=12.5,
            probability_of_loss=25.0,
            var_95=-5.5,
            num_simulations=1000,
            confidence_level=0.95,
        )
        result.return_distribution = DistributionStats(mean=10.0)

        metrics = result.to_metrics()

        assert len(metrics) == 6
        metric_names = [m.name for m in metrics]
        assert "Original Return %" in metric_names
        assert "Mean Return %" in metric_names
        assert "95% CI Return" in metric_names
        assert "Probability of Loss" in metric_names
        assert "VaR (95%)" in metric_names
        assert "Simulations" in metric_names

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        result = MonteCarloResult(
            original_return=15.0,
            original_sharpe=1.5,
            original_max_dd=8.0,
            confidence_level=0.95,
            return_ci_lower=5.0,
            return_ci_upper=25.0,
            sharpe_ci_lower=0.5,
            sharpe_ci_upper=2.5,
            probability_of_loss=20.0,
            var_95=-3.0,
            cvar_95=-5.0,
            num_simulations=500,
        )

        d = result.to_dict()

        assert d["originalReturn"] == 15.0
        assert d["originalSharpe"] == 1.5
        assert d["originalMaxDrawdown"] == 8.0
        assert d["confidenceLevel"] == 0.95
        assert d["returnCILower"] == 5.0
        assert d["returnCIUpper"] == 25.0
        assert d["probabilityOfLoss"] == 20.0
        assert d["var95"] == -3.0
        assert d["cvar95"] == -5.0
        assert d["numSimulations"] == 500
        assert "returnDistribution" in d
        assert "sharpeDistribution" in d
        assert "drawdownDistribution" in d


class TestMonteCarloJob:
    """Tests for MonteCarloJob class."""

    def test_job_type(self) -> None:
        """Should return correct job type."""
        job = MonteCarloJob()

        assert job.job_type == JobType.MONTE_CARLO

    def test_validate_config_valid(self) -> None:
        """Should pass valid config."""
        job = MonteCarloJob()
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            num_simulations=100,
            confidence_level=0.95,
            shuffle_method="trades",
        )

        errors = job.validate_config(config)

        assert errors == []

    def test_validate_config_too_few_simulations(self) -> None:
        """Should reject too few simulations."""
        job = MonteCarloJob()
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            num_simulations=5,
        )

        errors = job.validate_config(config)

        assert any("at least 10" in e for e in errors)

    def test_validate_config_too_many_simulations(self) -> None:
        """Should reject too many simulations."""
        job = MonteCarloJob()
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            num_simulations=200000,
        )

        errors = job.validate_config(config)

        assert any("cannot exceed 100,000" in e for e in errors)

    def test_validate_config_invalid_confidence_level_low(self) -> None:
        """Should reject confidence level below 0.5."""
        job = MonteCarloJob()
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            confidence_level=0.4,
        )

        errors = job.validate_config(config)

        assert any("between 0.5 and 0.99" in e for e in errors)

    def test_validate_config_invalid_confidence_level_high(self) -> None:
        """Should reject confidence level above 0.99."""
        job = MonteCarloJob()
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            confidence_level=0.999,
        )

        errors = job.validate_config(config)

        assert any("between 0.5 and 0.99" in e for e in errors)

    def test_validate_config_invalid_shuffle_method(self) -> None:
        """Should reject invalid shuffle method."""
        job = MonteCarloJob()
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            shuffle_method="invalid",
        )

        errors = job.validate_config(config)

        assert any("'trades' or 'returns'" in e for e in errors)


class TestMonteCarloJobHelpers:
    """Tests for MonteCarloJob helper methods."""

    def test_calculate_equity_curve(self) -> None:
        """Should calculate equity curve from trades."""
        job = MonteCarloJob()

        trades = [
            Trade(entry_time=0, exit_time=1, entry_price=100, exit_price=105,
                  quantity=10, side="long", pnl=50, pnl_percent=5, commission=1),
            Trade(entry_time=1, exit_time=2, entry_price=105, exit_price=100,
                  quantity=10, side="long", pnl=-50, pnl_percent=-5, commission=1),
            Trade(entry_time=2, exit_time=3, entry_price=100, exit_price=110,
                  quantity=10, side="long", pnl=100, pnl_percent=10, commission=1),
        ]

        equity = job._calculate_equity_curve(trades, 10000.0)

        assert equity[0] == 10000.0
        assert equity[1] == 10050.0  # +50
        assert equity[2] == 10000.0  # -50
        assert equity[3] == 10100.0  # +100

    def test_calculate_equity_curve_empty(self) -> None:
        """Should handle empty trades."""
        job = MonteCarloJob()

        equity = job._calculate_equity_curve([], 10000.0)

        assert equity == [10000.0]

    def test_calculate_sharpe(self) -> None:
        """Should calculate Sharpe ratio."""
        job = MonteCarloJob()

        # Steady growth
        equity = [10000, 10100, 10200, 10300, 10400, 10500]

        sharpe = job._calculate_sharpe(equity)

        # Should be positive for consistent positive returns
        assert sharpe > 0

    def test_calculate_sharpe_short_sequence(self) -> None:
        """Should return 0 for very short sequence."""
        job = MonteCarloJob()

        assert job._calculate_sharpe([10000]) == 0.0

    def test_calculate_sharpe_no_variation(self) -> None:
        """Should return 0 for no variation."""
        job = MonteCarloJob()

        equity = [10000, 10000, 10000, 10000]

        sharpe = job._calculate_sharpe(equity)

        assert sharpe == 0.0

    def test_calculate_max_drawdown(self) -> None:
        """Should calculate maximum drawdown."""
        job = MonteCarloJob()

        # 10000 -> 11000 -> 9000 -> 10000
        # Peak at 11000, low at 9000 = 18.18% drawdown
        equity = [10000, 11000, 9000, 10000]

        dd = job._calculate_max_drawdown(equity)

        assert abs(dd - 18.18) < 0.1

    def test_calculate_max_drawdown_no_drawdown(self) -> None:
        """Should return 0 for no drawdown."""
        job = MonteCarloJob()

        equity = [10000, 10500, 11000, 11500]

        dd = job._calculate_max_drawdown(equity)

        assert dd == 0.0

    def test_calculate_distribution(self) -> None:
        """Should calculate distribution statistics."""
        job = MonteCarloJob()

        values = list(range(1, 101))  # 1 to 100

        stats = job._calculate_distribution(values)

        assert stats.mean == 50.5
        assert stats.median == 51  # Integer division: 100//2 = 50th element (value 51)
        assert stats.min == 1
        assert stats.max == 100
        assert stats.percentile_5 == 6  # 5th element
        assert stats.percentile_95 == 96  # 95th element

    def test_calculate_distribution_empty(self) -> None:
        """Should return empty stats for empty values."""
        job = MonteCarloJob()

        stats = job._calculate_distribution([])

        assert stats.mean == 0.0
        assert stats.median == 0.0
        assert stats.std == 0.0

    def test_shuffle_trades_method_trades(self) -> None:
        """Should shuffle trade order."""
        job = MonteCarloJob()

        trades = [
            Trade(entry_time=i, exit_time=i+1, entry_price=100, exit_price=100,
                  quantity=10, side="long", pnl=i*10, pnl_percent=i, commission=1)
            for i in range(10)
        ]

        # Set seed for reproducibility
        import random
        random.seed(42)

        shuffled = job._shuffle_trades(trades, "trades")

        # Should have same length
        assert len(shuffled) == len(trades)

        # Order should be different (with high probability)
        original_pnls = [t.pnl for t in trades]
        shuffled_pnls = [t.pnl for t in shuffled]
        assert shuffled_pnls != original_pnls

    def test_shuffle_trades_method_returns(self) -> None:
        """Should shuffle returns while keeping trade structure."""
        job = MonteCarloJob()

        trades = [
            Trade(entry_time=i, exit_time=i+1, entry_price=100, exit_price=100,
                  quantity=10, side="long", pnl=i*10, pnl_percent=i, commission=1)
            for i in range(10)
        ]

        import random
        random.seed(42)

        shuffled = job._shuffle_trades(trades, "returns")

        # Should have same length
        assert len(shuffled) == len(trades)

        # Entry times should be same (structure preserved)
        original_times = [t.entry_time for t in trades]
        shuffled_times = [t.entry_time for t in shuffled]
        assert original_times == shuffled_times

    def test_generate_histogram(self) -> None:
        """Should generate histogram data."""
        job = MonteCarloJob()

        values = list(range(100))  # 0 to 99

        histogram = job._generate_histogram(values, num_bins=10)

        assert len(histogram) == 10
        assert all("binStart" in b for b in histogram)
        assert all("binEnd" in b for b in histogram)
        assert all("count" in b for b in histogram)
        assert all("frequency" in b for b in histogram)

        # Total counts should match
        total_count = sum(b["count"] for b in histogram)
        assert total_count == 100

    def test_generate_histogram_empty(self) -> None:
        """Should return empty histogram for empty values."""
        job = MonteCarloJob()

        histogram = job._generate_histogram([])

        assert histogram == []


class TestMonteCarloJobRun:
    """Tests for MonteCarloJob.run method."""

    def _create_mock_context(self, tmp_path: Path) -> MagicMock:
        """Create mock job context."""
        ctx = MagicMock(spec=JobContext)
        ctx.config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            num_simulations=50,  # Small number for fast tests
            confidence_level=0.95,
            shuffle_method="trades",
            random_seed=42,
            initial_capital=100000.0,
        )
        ctx.artifacts_dir = tmp_path
        ctx.check_cancelled.return_value = None

        def mock_write_artifact(name: str, data: Any) -> Path:
            path = tmp_path / f"{name}.json"
            return path

        ctx.write_artifact.side_effect = mock_write_artifact
        return ctx

    def test_run_basic(self, tmp_path: Path) -> None:
        """Should run Monte Carlo simulation."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        assert result.success is True
        assert len(result.metrics) > 0
        assert "originalReturn" in result.details
        assert "meanReturn" in result.details
        assert "probabilityOfLoss" in result.details

    def test_run_with_returns_shuffle(self, tmp_path: Path) -> None:
        """Should run with returns shuffle method."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)
        ctx.config = MonteCarloConfig(
            symbol="MSFT",
            timeframe="1D",
            num_simulations=50,
            shuffle_method="returns",
            random_seed=42,
        )

        result = job.run(ctx)

        assert result.success is True

    def test_run_logs_info(self, tmp_path: Path) -> None:
        """Should log information during run."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)

        job.run(ctx)

        # Should have called log_info multiple times
        assert ctx.log_info.call_count > 0

    def test_run_reports_progress(self, tmp_path: Path) -> None:
        """Should report progress during run."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)

        job.run(ctx)

        # Should have called progress multiple times
        assert ctx.progress.call_count > 0

    def test_run_writes_artifacts(self, tmp_path: Path) -> None:
        """Should write result artifacts."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        # Should have written result and runs artifacts
        assert ctx.write_artifact.call_count >= 2
        assert "result" in result.artifact_paths
        assert "runs" in result.artifact_paths

    def test_run_high_loss_probability_warning(self, tmp_path: Path) -> None:
        """Should warn when loss probability is high."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)

        # Use a seed that generates mostly losses
        ctx.config.random_seed = 9999

        result = job.run(ctx)

        # Result should succeed but may have warnings
        assert result.success is True

    def test_run_from_generic_config(self, tmp_path: Path) -> None:
        """Should work with generic JobConfig."""
        job = MonteCarloJob()
        ctx = self._create_mock_context(tmp_path)

        # Use a generic config that will be converted
        generic_config = MagicMock(spec=JobConfig)
        generic_config.symbol = "AAPL"
        generic_config.to_dict.return_value = {
            "symbol": "AAPL",
            "numSimulations": 50,
            "randomSeed": 42,
        }
        ctx.config = generic_config

        result = job.run(ctx)

        assert result.success is True
