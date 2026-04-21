"""
Tests for optimization job module.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from quantlab.jobs.backtest import BacktestResult
from quantlab.jobs.base import JobConfig
from quantlab.jobs.base import JobContext
from quantlab.jobs.base import JobType
from quantlab.jobs.optimize import (
    OptimizationRun,
    OptimizeConfig,
    OptimizeJob,
    OptimizeResult,
    ParameterRange,
)


class TestParameterRange:
    """Tests for ParameterRange dataclass."""

    def test_create_range(self) -> None:
        """Should create parameter range."""
        pr = ParameterRange(
            name="fast_period",
            min_value=5.0,
            max_value=20.0,
            step=5.0,
        )

        assert pr.name == "fast_period"
        assert pr.min_value == 5.0
        assert pr.max_value == 20.0
        assert pr.step == 5.0
        assert pr.param_type == "float"

    def test_create_int_range(self) -> None:
        """Should create integer parameter range."""
        pr = ParameterRange(
            name="window",
            min_value=10,
            max_value=50,
            step=10,
            param_type="int",
        )

        assert pr.param_type == "int"

    def test_generate_values_float(self) -> None:
        """Should generate float values."""
        pr = ParameterRange(
            name="threshold",
            min_value=0.1,
            max_value=0.5,
            step=0.1,
        )

        values = pr.generate_values()

        assert len(values) == 5
        assert values[0] == 0.1
        assert values[4] == 0.5

    def test_generate_values_int(self) -> None:
        """Should generate integer values."""
        pr = ParameterRange(
            name="period",
            min_value=10,
            max_value=30,
            step=10,
            param_type="int",
        )

        values = pr.generate_values()

        assert values == [10, 20, 30]
        assert all(isinstance(v, int) for v in values)

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        pr = ParameterRange(
            name="param",
            min_value=1.0,
            max_value=10.0,
            step=1.0,
            param_type="float",
        )

        d = pr.to_dict()

        assert d["name"] == "param"
        assert d["minValue"] == 1.0
        assert d["maxValue"] == 10.0
        assert d["step"] == 1.0
        assert d["paramType"] == "float"

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "name": "lookback",
            "minValue": 5,
            "maxValue": 50,
            "step": 5,
            "paramType": "int",
        }

        pr = ParameterRange.from_dict(data)

        assert pr.name == "lookback"
        assert pr.min_value == 5
        assert pr.max_value == 50
        assert pr.step == 5
        assert pr.param_type == "int"

    def test_from_dict_default_type(self) -> None:
        """Should default to float type."""
        data = {
            "name": "value",
            "minValue": 0.0,
            "maxValue": 1.0,
            "step": 0.1,
        }

        pr = ParameterRange.from_dict(data)

        assert pr.param_type == "float"


class TestOptimizeConfig:
    """Tests for OptimizeConfig dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        config = OptimizeConfig(symbol="AAPL", timeframe="1D")

        assert config.symbol == "AAPL"
        assert config.parameter_ranges == []
        assert config.metric == "sharpe"
        assert config.maximize is True
        assert config.initial_capital == 100000.0
        assert config.commission == 0.001
        assert config.slippage == 0.0005

    def test_with_parameter_ranges(self) -> None:
        """Should accept parameter ranges."""
        ranges = [
            ParameterRange("fast", 5, 20, 5),
            ParameterRange("slow", 10, 50, 10),
        ]
        config = OptimizeConfig(
            symbol="MSFT",
            timeframe="1D",
            parameter_ranges=ranges,
        )

        assert len(config.parameter_ranges) == 2

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        ranges = [ParameterRange("fast", 5, 20, 5)]
        config = OptimizeConfig(
            symbol="GOOG",
            timeframe="1H",
            parameter_ranges=ranges,
            metric="return",
            maximize=False,
        )

        d = config.to_dict()

        assert d["symbol"] == "GOOG"
        assert d["metric"] == "return"
        assert d["maximize"] is False
        assert len(d["parameterRanges"]) == 1

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "symbol": "TSLA",
            "timeframe": "1D",
            "parameterRanges": [
                {"name": "period", "minValue": 10, "maxValue": 30, "step": 5},
            ],
            "metric": "sortino",
            "maximize": True,
            "initialCapital": 50000.0,
        }

        config = OptimizeConfig.from_dict(data)

        assert config.symbol == "TSLA"
        assert len(config.parameter_ranges) == 1
        assert config.metric == "sortino"
        assert config.initial_capital == 50000.0

    def test_from_dict_defaults(self) -> None:
        """Should use defaults for missing values."""
        data = {"symbol": "AMZN", "timeframe": "1D"}

        config = OptimizeConfig.from_dict(data)

        assert config.symbol == "AMZN"
        assert config.parameter_ranges == []
        assert config.metric == "sharpe"


class TestOptimizationRun:
    """Tests for OptimizationRun dataclass."""

    def test_create_run(self) -> None:
        """Should create optimization run."""
        run = OptimizationRun(
            params={"fast": 10, "slow": 20},
            metric_value=1.5,
            sharpe=1.5,
            total_return_percent=15.0,
            max_drawdown_percent=8.0,
            total_trades=50,
            win_rate=55.0,
        )

        assert run.params == {"fast": 10, "slow": 20}
        assert run.metric_value == 1.5
        assert run.sharpe == 1.5
        assert run.total_return_percent == 15.0

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        run = OptimizationRun(
            params={"period": 15},
            metric_value=2.0,
            sharpe=2.0,
            total_return_percent=20.0,
            max_drawdown_percent=5.0,
            total_trades=30,
            win_rate=60.0,
        )

        d = run.to_dict()

        assert d["params"] == {"period": 15}
        assert d["metricValue"] == 2.0
        assert d["sharpe"] == 2.0
        assert d["totalReturnPercent"] == 20.0
        assert d["totalTrades"] == 30
        assert d["winRate"] == 60.0


class TestOptimizeResult:
    """Tests for OptimizeResult dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        result = OptimizeResult()

        assert result.best_params == {}
        assert result.best_metric_value == 0.0
        assert result.best_sharpe == 0.0
        assert result.best_return_percent == 0.0
        assert result.runs == []
        assert result.total_combinations == 0
        assert result.completed_combinations == 0
        assert result.heatmap_data is None

    def test_to_metrics(self) -> None:
        """Should convert to metric values."""
        result = OptimizeResult(
            best_params={"fast": 10, "slow": 30},
            best_sharpe=1.8,
            best_return_percent=25.0,
            completed_combinations=100,
        )

        metrics = result.to_metrics()

        assert len(metrics) == 4
        metric_names = [m.name for m in metrics]
        assert "Best Sharpe" in metric_names
        assert "Best Return %" in metric_names
        assert "Combinations Tested" in metric_names
        assert "Best Parameters" in metric_names

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        result = OptimizeResult(
            best_params={"period": 20},
            best_metric_value=1.5,
            best_sharpe=1.5,
            best_return_percent=18.0,
            total_combinations=50,
            completed_combinations=48,
        )

        d = result.to_dict()

        assert d["bestParams"] == {"period": 20}
        assert d["bestMetricValue"] == 1.5
        assert d["bestSharpe"] == 1.5
        assert d["totalCombinations"] == 50
        assert d["completedCombinations"] == 48


class TestOptimizeJob:
    """Tests for OptimizeJob class."""

    def test_job_type(self) -> None:
        """Should return correct job type."""
        job = OptimizeJob()

        assert job.job_type == JobType.OPTIMIZE

    def test_validate_config_valid(self) -> None:
        """Should pass valid config."""
        job = OptimizeJob()
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[
                ParameterRange("fast", 5, 20, 5),
            ],
        )

        errors = job.validate_config(config)

        assert errors == []

    def test_validate_config_no_ranges(self) -> None:
        """Should reject config with no parameter ranges."""
        job = OptimizeJob()
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
        )

        errors = job.validate_config(config)

        assert any("At least one parameter range" in e for e in errors)

    def test_validate_config_invalid_range_min_max(self) -> None:
        """Should reject range with min >= max."""
        job = OptimizeJob()
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[
                ParameterRange("bad", 20, 10, 5),  # min > max
            ],
        )

        errors = job.validate_config(config)

        assert any("min must be less than max" in e for e in errors)

    def test_validate_config_invalid_step(self) -> None:
        """Should reject range with non-positive step."""
        job = OptimizeJob()
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[
                ParameterRange("bad", 10, 20, -5),  # negative step
            ],
        )

        errors = job.validate_config(config)

        assert any("step must be positive" in e for e in errors)


class TestOptimizeJobHelpers:
    """Tests for OptimizeJob helper methods."""

    def test_generate_combinations_single_param(self) -> None:
        """Should generate combinations for single parameter."""
        job = OptimizeJob()
        ranges = [ParameterRange("period", 10, 30, 10)]

        combos = job._generate_combinations(ranges)

        assert len(combos) == 3
        assert {"period": 10} in combos
        assert {"period": 20} in combos
        assert {"period": 30} in combos

    def test_generate_combinations_two_params(self) -> None:
        """Should generate combinations for two parameters."""
        job = OptimizeJob()
        ranges = [
            ParameterRange("fast", 5, 10, 5),
            ParameterRange("slow", 20, 30, 10),
        ]

        combos = job._generate_combinations(ranges)

        # 2 fast values * 2 slow values = 4 combinations
        assert len(combos) == 4
        assert {"fast": 5.0, "slow": 20.0} in combos
        assert {"fast": 10.0, "slow": 30.0} in combos

    def test_generate_combinations_empty(self) -> None:
        """Should return single empty dict for no ranges."""
        job = OptimizeJob()

        combos = job._generate_combinations([])

        assert combos == [{}]

    def test_get_metric_value_sharpe(self) -> None:
        """Should extract sharpe ratio."""
        job = OptimizeJob()
        result = BacktestResult()
        result.sharpe_ratio = 1.5

        value = job._get_metric_value(result, "sharpe")

        assert value == 1.5

    def test_get_metric_value_return(self) -> None:
        """Should extract return percent."""
        job = OptimizeJob()
        result = BacktestResult()
        result.total_return_percent = 25.0

        value = job._get_metric_value(result, "return")

        assert value == 25.0

    def test_get_metric_value_drawdown(self) -> None:
        """Should extract negative drawdown."""
        job = OptimizeJob()
        result = BacktestResult()
        result.max_drawdown_percent = 10.0

        value = job._get_metric_value(result, "drawdown")

        # Should be negative so minimizing works
        assert value == -10.0

    def test_get_metric_value_win_rate(self) -> None:
        """Should extract win rate."""
        job = OptimizeJob()
        result = BacktestResult()
        result.win_rate = 55.0

        value = job._get_metric_value(result, "win_rate")

        assert value == 55.0

    def test_get_metric_value_default(self) -> None:
        """Should default to sharpe for unknown metric."""
        job = OptimizeJob()
        result = BacktestResult()
        result.sharpe_ratio = 1.2

        value = job._get_metric_value(result, "unknown")

        assert value == 1.2

    def test_generate_heatmap_two_params(self) -> None:
        """Should generate heatmap for two parameters."""
        job = OptimizeJob()
        ranges = [
            ParameterRange("fast", 5, 10, 5),
            ParameterRange("slow", 20, 30, 10),
        ]
        runs = [
            OptimizationRun(
                params={"fast": 5.0, "slow": 20.0},
                metric_value=1.0, sharpe=1.0, total_return_percent=10.0,
                max_drawdown_percent=5.0, total_trades=20, win_rate=50.0,
            ),
            OptimizationRun(
                params={"fast": 10.0, "slow": 30.0},
                metric_value=2.0, sharpe=2.0, total_return_percent=20.0,
                max_drawdown_percent=8.0, total_trades=30, win_rate=55.0,
            ),
        ]

        heatmap = job._generate_heatmap(runs, ranges, "sharpe")

        assert heatmap is not None
        assert heatmap["param1"] == "fast"
        assert heatmap["param2"] == "slow"
        assert heatmap["metric"] == "sharpe"
        assert "matrix" in heatmap

    def test_generate_heatmap_wrong_param_count(self) -> None:
        """Should return None for non-2D cases."""
        job = OptimizeJob()
        ranges = [ParameterRange("single", 5, 10, 5)]

        heatmap = job._generate_heatmap([], ranges, "sharpe")

        assert heatmap is None

    def test_simplified_backtest(self) -> None:
        """Should run simplified backtest."""
        from quantlab.jobs.backtest import BacktestConfig

        job = OptimizeJob()
        config = BacktestConfig(
            symbol="AAPL",
            timeframe="1D",
            initial_capital=100000.0,
        )
        params = {"fast_period": 10, "slow_period": 20}

        result = job._simplified_backtest(config, params)

        assert result is not None
        assert hasattr(result, "total_return_percent")
        assert hasattr(result, "sharpe_ratio")
        assert hasattr(result, "max_drawdown_percent")


class TestOptimizeJobRun:
    """Tests for OptimizeJob.run method."""

    def _create_mock_context(self, tmp_path: Path) -> MagicMock:
        """Create mock job context."""
        ctx = MagicMock(spec=JobContext)
        ctx.config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[
                ParameterRange("fast_period", 5, 15, 5),
                ParameterRange("slow_period", 20, 40, 10),
            ],
            metric="sharpe",
            maximize=True,
        )
        ctx.artifacts_dir = tmp_path
        ctx.check_cancelled.return_value = None

        def mock_write_artifact(name: str, data: Any) -> Path:
            path = tmp_path / f"{name}.json"
            return path

        ctx.write_artifact.side_effect = mock_write_artifact
        return ctx

    def test_run_basic(self, tmp_path: Path) -> None:
        """Should run optimization."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        assert result.success is True
        assert len(result.metrics) > 0
        assert "bestParams" in result.details
        assert "totalCombinations" in result.details

    def test_run_reports_progress(self, tmp_path: Path) -> None:
        """Should report progress during run."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)

        job.run(ctx)

        assert ctx.progress.call_count > 0

    def test_run_logs_info(self, tmp_path: Path) -> None:
        """Should log information during run."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)

        job.run(ctx)

        assert ctx.log_info.call_count > 0

    def test_run_writes_artifacts(self, tmp_path: Path) -> None:
        """Should write result artifacts."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        assert ctx.write_artifact.call_count >= 2
        assert "result" in result.artifact_paths
        assert "runs" in result.artifact_paths

    def test_run_minimize(self, tmp_path: Path) -> None:
        """Should run with minimize."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)
        ctx.config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[
                ParameterRange("fast_period", 5, 15, 5),
            ],
            metric="drawdown",
            maximize=False,  # Minimize drawdown
        )

        result = job.run(ctx)

        assert result.success is True

    def test_run_generates_heatmap(self, tmp_path: Path) -> None:
        """Should generate heatmap for 2 params."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        # Result should include heatmap data (written to artifact)
        assert result.success is True

    def test_run_from_generic_config(self, tmp_path: Path) -> None:
        """Should work with generic JobConfig."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)

        # Use a generic config that will be converted
        generic_config = MagicMock(spec=JobConfig)
        generic_config.symbol = "AAPL"
        generic_config.to_dict.return_value = {
            "symbol": "AAPL",
            "timeframe": "1D",
            "parameterRanges": [
                {"name": "fast_period", "minValue": 5, "maxValue": 10, "step": 5},
            ],
        }
        ctx.config = generic_config

        result = job.run(ctx)

        assert result.success is True

    def test_run_single_empty_combination(self, tmp_path: Path) -> None:
        """Should run with empty parameter ranges (single default run)."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)
        ctx.config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[],  # No ranges = single empty combination
        )

        # With no ranges, runs single combination with empty params
        result = job.run(ctx)

        assert result.success is True
        assert result.details["totalCombinations"] == 1

    def test_run_warns_large_search_space(self, tmp_path: Path) -> None:
        """Should warn about large search space."""
        job = OptimizeJob()
        ctx = self._create_mock_context(tmp_path)
        # Many parameter values = large search space
        ctx.config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[
                ParameterRange("p1", 1, 100, 1),  # 100 values
                ParameterRange("p2", 1, 200, 1),  # 200 values = 20000 combos
            ],
        )

        result = job.run(ctx)

        assert result.success is True
        # Should have logged a warning
        ctx.log_warn.assert_called()
