"""
Tests for Walk-Forward Analysis job module.
"""

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from quantlab.jobs.base import JobConfig
from quantlab.jobs.base import JobContext
from quantlab.jobs.base import JobType
from quantlab.jobs.optimize import ParameterRange
from quantlab.jobs.wfa import (
    WFAConfig,
    WFAJob,
    WFAResult,
    WFASplit,
)


class TestWFAConfig:
    """Tests for WFAConfig dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        config = WFAConfig(symbol="AAPL", timeframe="1D")

        assert config.symbol == "AAPL"
        assert config.num_splits == 5
        assert config.train_ratio == 0.7
        assert config.optimization_metric == "sharpe"
        assert config.parameter_ranges == []
        assert config.initial_capital == 100000.0
        assert config.anchored is False
        assert config.min_train_bars == 50

    def test_custom_values(self) -> None:
        """Should accept custom values."""
        ranges = [ParameterRange("fast", 5, 20, 5)]
        config = WFAConfig(
            symbol="MSFT",
            timeframe="1H",
            num_splits=10,
            train_ratio=0.8,
            optimization_metric="return",
            parameter_ranges=ranges,
            initial_capital=50000.0,
            anchored=True,
            min_train_bars=100,
        )

        assert config.num_splits == 10
        assert config.train_ratio == 0.8
        assert config.optimization_metric == "return"
        assert len(config.parameter_ranges) == 1
        assert config.anchored is True

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        ranges = [ParameterRange("period", 10, 30, 5)]
        config = WFAConfig(
            symbol="GOOG",
            timeframe="1D",
            num_splits=8,
            parameter_ranges=ranges,
            anchored=True,
        )

        d = config.to_dict()

        assert d["symbol"] == "GOOG"
        assert d["numSplits"] == 8
        assert d["trainRatio"] == 0.7
        assert d["anchored"] is True
        assert len(d["parameterRanges"]) == 1

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "symbol": "TSLA",
            "timeframe": "1D",
            "numSplits": 6,
            "trainRatio": 0.75,
            "optimizationMetric": "win_rate",
            "parameterRanges": [
                {"name": "fast", "minValue": 5, "maxValue": 15, "step": 5},
            ],
            "initialCapital": 75000.0,
            "anchored": True,
            "minTrainBars": 75,
        }

        config = WFAConfig.from_dict(data)

        assert config.symbol == "TSLA"
        assert config.num_splits == 6
        assert config.train_ratio == 0.75
        assert config.optimization_metric == "win_rate"
        assert len(config.parameter_ranges) == 1
        assert config.anchored is True
        assert config.min_train_bars == 75

    def test_from_dict_defaults(self) -> None:
        """Should use defaults for missing values."""
        data = {"symbol": "AMZN", "timeframe": "1D"}

        config = WFAConfig.from_dict(data)

        assert config.num_splits == 5
        assert config.train_ratio == 0.7
        assert config.anchored is False


class TestWFASplit:
    """Tests for WFASplit dataclass."""

    def test_create_split(self) -> None:
        """Should create WFA split result."""
        split = WFASplit(
            split_number=1,
            train_start_idx=0,
            train_end_idx=70,
            test_start_idx=70,
            test_end_idx=100,
            best_params={"fast": 10, "slow": 20},
            train_metric_value=1.5,
            train_sharpe=1.5,
            train_return_percent=12.0,
            test_metric_value=1.2,
            test_sharpe=1.2,
            test_return_percent=8.0,
            test_max_drawdown_percent=5.0,
            test_total_trades=15,
            efficiency_ratio=0.8,
        )

        assert split.split_number == 1
        assert split.train_end_idx == 70
        assert split.test_sharpe == 1.2
        assert split.efficiency_ratio == 0.8

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        split = WFASplit(
            split_number=2,
            train_start_idx=100,
            train_end_idx=200,
            test_start_idx=200,
            test_end_idx=250,
            best_params={"period": 15},
            train_metric_value=2.0,
            train_sharpe=2.0,
            train_return_percent=18.0,
            test_metric_value=1.5,
            test_sharpe=1.5,
            test_return_percent=10.0,
            test_max_drawdown_percent=8.0,
            test_total_trades=20,
            efficiency_ratio=0.75,
        )

        d = split.to_dict()

        assert d["splitNumber"] == 2
        assert d["trainStartIdx"] == 100
        assert d["testEndIdx"] == 250
        assert d["bestParams"] == {"period": 15}
        assert d["trainSharpe"] == 2.0
        assert d["testReturnPercent"] == 10.0
        assert d["efficiencyRatio"] == 0.75


class TestWFAResult:
    """Tests for WFAResult dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        result = WFAResult()

        assert result.avg_train_sharpe == 0.0
        assert result.avg_test_sharpe == 0.0
        assert result.avg_efficiency_ratio == 0.0
        assert result.combined_test_return == 0.0
        assert result.positive_splits == 0
        assert result.total_splits == 0
        assert result.robustness_score == 0.0
        assert result.splits == []

    def test_to_metrics(self) -> None:
        """Should convert to metric values."""
        result = WFAResult(
            combined_test_return=25.0,
            avg_test_sharpe=1.3,
            avg_efficiency_ratio=0.85,
            consistency_ratio=80.0,
            robustness_score=75.0,
            positive_splits=4,
            total_splits=5,
        )

        metrics = result.to_metrics()

        assert len(metrics) == 6
        metric_names = [m.name for m in metrics]
        assert "Combined Test Return" in metric_names
        assert "Avg Test Sharpe" in metric_names
        assert "Efficiency Ratio" in metric_names
        assert "Consistency" in metric_names
        assert "Robustness Score" in metric_names
        assert "Profitable Splits" in metric_names

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        result = WFAResult(
            avg_train_sharpe=1.5,
            avg_test_sharpe=1.2,
            avg_efficiency_ratio=0.8,
            combined_test_return=20.0,
            positive_splits=3,
            total_splits=4,
            consistency_ratio=75.0,
            robustness_score=70.0,
        )

        d = result.to_dict()

        assert d["avgTrainSharpe"] == 1.5
        assert d["avgTestSharpe"] == 1.2
        assert d["avgEfficiencyRatio"] == 0.8
        assert d["combinedTestReturn"] == 20.0
        assert d["positiveSplits"] == 3
        assert d["totalSplits"] == 4
        assert d["consistencyRatio"] == 75.0


class TestWFAJob:
    """Tests for WFAJob class."""

    def test_job_type(self) -> None:
        """Should return correct job type."""
        job = WFAJob()

        assert job.job_type == JobType.WFA

    def test_validate_config_valid(self) -> None:
        """Should pass valid config."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=5,
            train_ratio=0.7,
            parameter_ranges=[ParameterRange("fast", 5, 15, 5)],
        )

        errors = job.validate_config(config)

        assert errors == []

    def test_validate_config_too_few_splits(self) -> None:
        """Should reject config with < 2 splits."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=1,
            parameter_ranges=[ParameterRange("fast", 5, 15, 5)],
        )

        errors = job.validate_config(config)

        assert any("at least 2" in e for e in errors)

    def test_validate_config_too_many_splits(self) -> None:
        """Should reject config with > 20 splits."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=25,
            parameter_ranges=[ParameterRange("fast", 5, 15, 5)],
        )

        errors = job.validate_config(config)

        assert any("cannot exceed 20" in e for e in errors)

    def test_validate_config_invalid_train_ratio_low(self) -> None:
        """Should reject train ratio < 0.5."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            train_ratio=0.4,
            parameter_ranges=[ParameterRange("fast", 5, 15, 5)],
        )

        errors = job.validate_config(config)

        assert any("between 0.5 and 0.9" in e for e in errors)

    def test_validate_config_invalid_train_ratio_high(self) -> None:
        """Should reject train ratio > 0.9."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            train_ratio=0.95,
            parameter_ranges=[ParameterRange("fast", 5, 15, 5)],
        )

        errors = job.validate_config(config)

        assert any("between 0.5 and 0.9" in e for e in errors)

    def test_validate_config_no_ranges(self) -> None:
        """Should reject config with no parameter ranges."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
        )

        errors = job.validate_config(config)

        assert any("At least one parameter range" in e for e in errors)


class TestWFAJobHelpers:
    """Tests for WFAJob helper methods."""

    def test_load_data(self) -> None:
        """Should generate mock data."""
        job = WFAJob()
        config = WFAConfig(symbol="AAPL", timeframe="1D")

        data = job._load_data(config)

        assert len(data) == 500
        assert all("timestamp" in bar for bar in data)
        assert all("open" in bar for bar in data)
        assert all("close" in bar for bar in data)

    def test_calculate_splits_rolling(self) -> None:
        """Should calculate rolling split boundaries."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=5,
            train_ratio=0.7,
            anchored=False,
        )

        splits = job._calculate_splits(500, config)

        # Should have 5 splits
        assert len(splits) == 5

        # Each split should have train_start, train_end, test_start, test_end
        for train_start, train_end, test_start, test_end in splits:
            assert train_start < train_end
            assert train_end == test_start
            assert test_start < test_end

    def test_calculate_splits_anchored(self) -> None:
        """Should calculate anchored split boundaries."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=5,
            train_ratio=0.7,
            anchored=True,
            min_train_bars=50,
        )

        splits = job._calculate_splits(500, config)

        # All train periods should start at 0
        for train_start, train_end, test_start, test_end in splits:
            assert train_start == 0

    def test_backtest(self) -> None:
        """Should run backtest with parameters."""
        job = WFAJob()
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            initial_capital=100000.0,
        )

        # Generate some mock data
        data = [{"close": 100 + i * 0.1, "timestamp": i} for i in range(100)]
        params = {"fast_period": 5, "slow_period": 10}

        result = job._backtest(config, data, params)

        assert "metric" in result
        assert "sharpe" in result
        assert "return" in result
        assert "max_dd" in result
        assert "trades" in result
        assert "equity" in result
        assert len(result["equity"]) == len(data)

    def test_calculate_robustness_score(self) -> None:
        """Should calculate robustness score."""
        job = WFAJob()
        result = WFAResult(
            consistency_ratio=100.0,  # 40 points
            avg_efficiency_ratio=1.0,  # 30 points
            combined_test_return=30.0,  # 30 points
        )

        score = job._calculate_robustness_score(result)

        assert score == 100.0  # Maximum score

    def test_calculate_robustness_score_partial(self) -> None:
        """Should calculate partial robustness score."""
        job = WFAJob()
        result = WFAResult(
            consistency_ratio=50.0,  # 20 points
            avg_efficiency_ratio=0.5,  # 15 points
            combined_test_return=10.0,  # 10 points
        )

        score = job._calculate_robustness_score(result)

        assert score == 45.0

    def test_calculate_robustness_score_zero_return(self) -> None:
        """Should handle negative returns."""
        job = WFAJob()
        result = WFAResult(
            consistency_ratio=50.0,  # 20 points
            avg_efficiency_ratio=0.5,  # 15 points
            combined_test_return=-10.0,  # 0 points (negative)
        )

        score = job._calculate_robustness_score(result)

        assert score == 35.0  # Only consistency + efficiency


class TestWFAJobRun:
    """Tests for WFAJob.run method."""

    def _create_mock_context(self, tmp_path: Path) -> MagicMock:
        """Create mock job context."""
        ctx = MagicMock(spec=JobContext)
        ctx.config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=3,  # Small for fast tests
            train_ratio=0.7,
            parameter_ranges=[
                ParameterRange("fast_period", 5, 10, 5),
                ParameterRange("slow_period", 15, 20, 5),
            ],
        )
        ctx.artifacts_dir = tmp_path
        ctx.check_cancelled.return_value = None

        def mock_write_artifact(name: str, data: Any) -> Path:
            path = tmp_path / f"{name}.json"
            return path

        ctx.write_artifact.side_effect = mock_write_artifact
        return ctx

    def test_run_basic(self, tmp_path: Path) -> None:
        """Should run Walk-Forward Analysis."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        assert result.success is True
        assert len(result.metrics) > 0
        assert "combinedTestReturn" in result.details
        assert "robustnessScore" in result.details

    def test_run_reports_progress(self, tmp_path: Path) -> None:
        """Should report progress during run."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        job.run(ctx)

        assert ctx.progress.call_count > 0

    def test_run_logs_info(self, tmp_path: Path) -> None:
        """Should log information during run."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        job.run(ctx)

        assert ctx.log_info.call_count > 0

    def test_run_writes_artifacts(self, tmp_path: Path) -> None:
        """Should write result artifacts."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        assert ctx.write_artifact.call_count >= 3
        assert "result" in result.artifact_paths
        assert "splits" in result.artifact_paths
        assert "equity" in result.artifact_paths

    def test_run_anchored(self, tmp_path: Path) -> None:
        """Should run with anchored mode."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)
        ctx.config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=3,
            anchored=True,
            parameter_ranges=[
                ParameterRange("fast_period", 5, 10, 5),
            ],
        )

        result = job.run(ctx)

        assert result.success is True

    def test_run_from_generic_config(self, tmp_path: Path) -> None:
        """Should work with generic JobConfig."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        generic_config = MagicMock(spec=JobConfig)
        generic_config.symbol = "AAPL"
        generic_config.to_dict.return_value = {
            "symbol": "AAPL",
            "timeframe": "1D",
            "numSplits": 3,
            "parameterRanges": [
                {"name": "fast_period", "minValue": 5, "maxValue": 10, "step": 5},
            ],
        }
        ctx.config = generic_config

        result = job.run(ctx)

        assert result.success is True

    def test_run_warns_low_consistency(self, tmp_path: Path) -> None:
        """Should warn when consistency is low."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        # Result should succeed (warning doesn't cause failure)
        assert result.success is True

    def test_run_warns_low_efficiency(self, tmp_path: Path) -> None:
        """Should warn when efficiency ratio is low."""
        job = WFAJob()
        ctx = self._create_mock_context(tmp_path)

        result = job.run(ctx)

        # Result should succeed (warning doesn't cause failure)
        assert result.success is True
