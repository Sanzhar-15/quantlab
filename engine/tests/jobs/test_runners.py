"""
Tests for Job Runners.

Tests BacktestJob, OptimizeJob, MonteCarloJob, and WFAJob.
"""

import pytest
from pathlib import Path

from quantlab.jobs import (
    # Backtest
    BacktestJob,
    BacktestConfig,
    BacktestResult,
    Trade,
    # Optimize
    OptimizeJob,
    OptimizeConfig,
    OptimizeResult,
    ParameterRange,
    # Monte Carlo
    MonteCarloJob,
    MonteCarloConfig,
    MonteCarloResult,
    DistributionStats,
    # WFA
    WFAJob,
    WFAConfig,
    WFAResult,
    # Base
    JobType,
    JobExecutor,
    NDJSONWriter,
)


class TestBacktestConfig:
    """Tests for BacktestConfig dataclass."""

    def test_creation(self) -> None:
        """Test config creation."""
        config = BacktestConfig(
            symbol="AAPL",
            timeframe="1D",
            initial_capital=100000,
            commission=0.001,
        )
        assert config.symbol == "AAPL"
        assert config.initial_capital == 100000
        assert config.commission == 0.001

    def test_defaults(self) -> None:
        """Test default values."""
        config = BacktestConfig(symbol="GOOG", timeframe="1H")
        assert config.initial_capital == 100000.0
        assert config.commission == 0.001
        assert config.slippage == 0.0005
        assert config.use_code_defaults is True

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        config = BacktestConfig(symbol="MSFT", timeframe="1D")
        d = config.to_dict()

        assert d["symbol"] == "MSFT"
        assert d["initialCapital"] == 100000.0

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "symbol": "TSLA",
            "timeframe": "1D",
            "initialCapital": 50000,
        }
        config = BacktestConfig.from_dict(data)

        assert config.symbol == "TSLA"
        assert config.initial_capital == 50000


class TestTrade:
    """Tests for Trade dataclass."""

    def test_creation(self) -> None:
        """Test trade creation."""
        trade = Trade(
            entry_time=1704067200.0,
            exit_time=1704153600.0,
            entry_price=100.0,
            exit_price=105.0,
            quantity=10.0,
            side="long",
            pnl=50.0,
            pnl_percent=5.0,
            commission=1.0,
        )
        assert trade.side == "long"
        assert trade.pnl == 50.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        trade = Trade(
            entry_time=1704067200.0,
            exit_time=1704153600.0,
            entry_price=100.0,
            exit_price=95.0,
            quantity=10.0,
            side="short",
            pnl=50.0,
            pnl_percent=5.0,
            commission=1.0,
        )
        d = trade.to_dict()

        assert d["side"] == "short"
        assert d["entryPrice"] == 100.0


class TestBacktestResult:
    """Tests for BacktestResult dataclass."""

    def test_to_metrics(self) -> None:
        """Test conversion to metrics."""
        result = BacktestResult(
            total_return=5000.0,
            total_return_percent=5.0,
            sharpe_ratio=1.5,
            max_drawdown_percent=10.0,
            win_rate=60.0,
            total_trades=50,
        )
        metrics = result.to_metrics()

        assert len(metrics) >= 5
        metric_names = [m.name for m in metrics]
        assert "Total Return" in metric_names
        assert "Sharpe Ratio" in metric_names


class TestBacktestJob:
    """Tests for BacktestJob class."""

    def test_job_type(self) -> None:
        """Test job type."""
        job = BacktestJob()
        assert job.job_type == JobType.BACKTEST

    def test_validate_config(self) -> None:
        """Test config validation."""
        job = BacktestJob()

        # Valid config
        config = BacktestConfig(symbol="AAPL", timeframe="1D")
        errors = job.validate_config(config)
        assert len(errors) == 0

        # Invalid: empty symbol
        config = BacktestConfig(symbol="", timeframe="1D")
        errors = job.validate_config(config)
        assert len(errors) > 0

        # Invalid: negative capital
        config = BacktestConfig(
            symbol="AAPL",
            timeframe="1D",
            initial_capital=-1000,
        )
        errors = job.validate_config(config)
        assert len(errors) > 0


class TestParameterRange:
    """Tests for ParameterRange dataclass."""

    def test_generate_values_float(self) -> None:
        """Test generating float values."""
        pr = ParameterRange(
            name="threshold",
            min_value=0.01,
            max_value=0.05,
            step=0.01,
            param_type="float",
        )
        values = pr.generate_values()

        assert len(values) == 5
        assert values[0] == 0.01
        assert values[-1] == 0.05

    def test_generate_values_int(self) -> None:
        """Test generating int values."""
        pr = ParameterRange(
            name="period",
            min_value=10,
            max_value=30,
            step=5,
            param_type="int",
        )
        values = pr.generate_values()

        assert values == [10, 15, 20, 25, 30]
        assert all(isinstance(v, int) for v in values)


class TestOptimizeConfig:
    """Tests for OptimizeConfig dataclass."""

    def test_creation(self) -> None:
        """Test config creation."""
        ranges = [
            ParameterRange("fast", 5, 15, 5, "int"),
            ParameterRange("slow", 15, 30, 5, "int"),
        ]
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=ranges,
            metric="sharpe",
        )
        assert len(config.parameter_ranges) == 2
        assert config.metric == "sharpe"


class TestOptimizeJob:
    """Tests for OptimizeJob class."""

    def test_job_type(self) -> None:
        """Test job type."""
        job = OptimizeJob()
        assert job.job_type == JobType.OPTIMIZE

    def test_validate_config(self) -> None:
        """Test config validation."""
        job = OptimizeJob()

        # Valid config
        ranges = [ParameterRange("period", 10, 30, 5, "int")]
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=ranges,
        )
        errors = job.validate_config(config)
        assert len(errors) == 0

        # Invalid: no parameter ranges
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[],
        )
        errors = job.validate_config(config)
        assert len(errors) > 0

        # Invalid: min >= max
        ranges = [ParameterRange("period", 30, 10, 5, "int")]
        config = OptimizeConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=ranges,
        )
        errors = job.validate_config(config)
        assert len(errors) > 0


class TestDistributionStats:
    """Tests for DistributionStats dataclass."""

    def test_creation(self) -> None:
        """Test stats creation."""
        stats = DistributionStats(
            mean=10.0,
            median=9.5,
            std=2.0,
            min=5.0,
            max=15.0,
        )
        assert stats.mean == 10.0
        assert stats.std == 2.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        stats = DistributionStats(mean=10.0, median=9.5)
        d = stats.to_dict()

        assert d["mean"] == 10.0
        assert d["median"] == 9.5


class TestMonteCarloConfig:
    """Tests for MonteCarloConfig dataclass."""

    def test_defaults(self) -> None:
        """Test default values."""
        config = MonteCarloConfig(symbol="AAPL", timeframe="1D")

        assert config.num_simulations == 1000
        assert config.confidence_level == 0.95
        assert config.shuffle_method == "trades"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        config = MonteCarloConfig(
            symbol="GOOG",
            timeframe="1D",
            num_simulations=500,
        )
        d = config.to_dict()

        assert d["numSimulations"] == 500


class TestMonteCarloJob:
    """Tests for MonteCarloJob class."""

    def test_job_type(self) -> None:
        """Test job type."""
        job = MonteCarloJob()
        assert job.job_type == JobType.MONTE_CARLO

    def test_validate_config(self) -> None:
        """Test config validation."""
        job = MonteCarloJob()

        # Valid config
        config = MonteCarloConfig(symbol="AAPL", timeframe="1D")
        errors = job.validate_config(config)
        assert len(errors) == 0

        # Invalid: too few simulations
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            num_simulations=5,
        )
        errors = job.validate_config(config)
        assert len(errors) > 0

        # Invalid: bad confidence level
        config = MonteCarloConfig(
            symbol="AAPL",
            timeframe="1D",
            confidence_level=0.1,
        )
        errors = job.validate_config(config)
        assert len(errors) > 0


class TestMonteCarloResult:
    """Tests for MonteCarloResult dataclass."""

    def test_to_metrics(self) -> None:
        """Test conversion to metrics."""
        result = MonteCarloResult(
            original_return=10.0,
            probability_of_loss=25.0,
            var_95=-5.0,
            num_simulations=1000,
        )
        result.return_distribution = DistributionStats(mean=8.0)

        metrics = result.to_metrics()
        assert len(metrics) >= 4


class TestWFAConfig:
    """Tests for WFAConfig dataclass."""

    def test_defaults(self) -> None:
        """Test default values."""
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=[ParameterRange("period", 10, 30, 5, "int")],
        )

        assert config.num_splits == 5
        assert config.train_ratio == 0.7
        assert config.optimization_metric == "sharpe"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        ranges = [ParameterRange("period", 10, 30, 5, "int")]
        config = WFAConfig(
            symbol="GOOG",
            timeframe="1D",
            num_splits=3,
            parameter_ranges=ranges,
        )
        d = config.to_dict()

        assert d["numSplits"] == 3
        assert d["trainRatio"] == 0.7


class TestWFAJob:
    """Tests for WFAJob class."""

    def test_job_type(self) -> None:
        """Test job type."""
        job = WFAJob()
        assert job.job_type == JobType.WFA

    def test_validate_config(self) -> None:
        """Test config validation."""
        job = WFAJob()

        # Valid config
        ranges = [ParameterRange("period", 10, 30, 5, "int")]
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            parameter_ranges=ranges,
        )
        errors = job.validate_config(config)
        assert len(errors) == 0

        # Invalid: too few splits
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            num_splits=1,
            parameter_ranges=ranges,
        )
        errors = job.validate_config(config)
        assert len(errors) > 0

        # Invalid: bad train ratio
        config = WFAConfig(
            symbol="AAPL",
            timeframe="1D",
            train_ratio=0.95,
            parameter_ranges=ranges,
        )
        errors = job.validate_config(config)
        assert len(errors) > 0


class TestWFAResult:
    """Tests for WFAResult dataclass."""

    def test_to_metrics(self) -> None:
        """Test conversion to metrics."""
        result = WFAResult(
            combined_test_return=15.0,
            avg_test_sharpe=1.2,
            avg_efficiency_ratio=0.85,
            consistency_ratio=80.0,
            robustness_score=75.0,
            positive_splits=4,
            total_splits=5,
        )
        metrics = result.to_metrics()

        assert len(metrics) >= 4
        metric_names = [m.name for m in metrics]
        assert "Combined Test Return" in metric_names


class TestJobExecution:
    """Integration tests for job execution."""

    @pytest.fixture
    def executor(self, tmp_path: Path) -> JobExecutor:
        """Create a test executor."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)
        return JobExecutor(artifact_root=tmp_path, writer=writer)

    @pytest.fixture
    def mock_strategy_file(self, tmp_path: Path) -> Path:
        """Create a mock strategy file."""
        strategy_path = tmp_path / "strategy.py"
        strategy_path.write_text("""
import quantlab as ql

period = ql.param(20)

def strategy(data):
    return ql.long(data.close[-1] > 100)
""")
        return strategy_path

    def test_backtest_execution(
        self,
        executor: JobExecutor,
        mock_strategy_file: Path,
    ) -> None:
        """Test backtest job execution."""
        job = BacktestJob()
        config = BacktestConfig(
            symbol="AAPL",
            timeframe="1D",
            initial_capital=100000,
        )

        result = executor.execute(
            job=job,
            job_id="backtest-001",
            strategy_path=str(mock_strategy_file),
            config=config,
            params={"fast_period": 10, "slow_period": 20},
        )

        assert result.success is True
        assert "result" in result.artifact_paths
        assert "equity" in result.artifact_paths
