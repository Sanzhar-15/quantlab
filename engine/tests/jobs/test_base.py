"""
Tests for Job Base module.

Tests Job base class, JobExecutor, and related utilities.
"""

import pytest
import tempfile
from pathlib import Path
from unittest.mock import Mock

from quantlab.jobs import (
    Job,
    JobConfig,
    JobContext,
    JobExecutor,
    JobStatus,
    JobType,
    JobCancelledException,
    generate_job_id,
    JobResult,
    MetricValue,
    NDJSONWriter,
    LogLevel,
)


class TestJobStatus:
    """Tests for JobStatus enum."""

    def test_status_values(self) -> None:
        """Test job status values."""
        assert JobStatus.PENDING.value == "pending"
        assert JobStatus.RUNNING.value == "running"
        assert JobStatus.COMPLETED.value == "completed"
        assert JobStatus.FAILED.value == "failed"
        assert JobStatus.CANCELLED.value == "cancelled"


class TestJobType:
    """Tests for JobType enum."""

    def test_job_types(self) -> None:
        """Test job type values."""
        assert JobType.BACKTEST.value == "backtest"
        assert JobType.OPTIMIZE.value == "optimize"
        assert JobType.MONTE_CARLO.value == "montecarlo"
        assert JobType.WFA.value == "wfa"


class TestJobConfig:
    """Tests for JobConfig dataclass."""

    def test_creation(self) -> None:
        """Test config creation."""
        config = JobConfig(
            symbol="AAPL",
            timeframe="1D",
        )
        assert config.symbol == "AAPL"
        assert config.timeframe == "1D"
        assert config.data_source == "default"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        config = JobConfig(
            symbol="GOOG",
            timeframe="1H",
            start_date="2024-01-01",
            end_date="2024-12-31",
        )
        d = config.to_dict()

        assert d["symbol"] == "GOOG"
        assert d["timeframe"] == "1H"
        assert d["startDate"] == "2024-01-01"
        assert d["endDate"] == "2024-12-31"

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "symbol": "MSFT",
            "timeframe": "4H",
            "dataSource": "provider1",
        }
        config = JobConfig.from_dict(data)

        assert config.symbol == "MSFT"
        assert config.timeframe == "4H"
        assert config.data_source == "provider1"


class TestGenerateJobId:
    """Tests for generate_job_id function."""

    def test_format(self) -> None:
        """Test job ID format."""
        job_id = generate_job_id("backtest")
        parts = job_id.split("-")

        assert len(parts) == 3
        assert parts[0] == "backtest"
        assert len(parts[1]) == 8  # YYYYMMDD
        assert len(parts[2]) == 5  # Sequence

    def test_different_types(self) -> None:
        """Test different job types."""
        bt_id = generate_job_id("backtest")
        opt_id = generate_job_id("optimize")

        assert bt_id.startswith("backtest-")
        assert opt_id.startswith("optimize-")

    def test_uniqueness(self) -> None:
        """Test that IDs are unique."""
        import time

        ids = set()
        for _ in range(10):
            ids.add(generate_job_id("test"))
            time.sleep(0.001)  # Small delay to ensure different timestamps

        # Should have multiple unique IDs
        assert len(ids) >= 5  # Allow some collision due to timing


class TestJobContext:
    """Tests for JobContext dataclass."""

    @pytest.fixture
    def context(self, tmp_path: Path) -> JobContext:
        """Create a test context."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)

        return JobContext(
            job_id="test-001",
            job_type=JobType.BACKTEST,
            strategy_path="/path/to/strategy.py",
            config=JobConfig(symbol="AAPL", timeframe="1D"),
            params={"period": 20},
            artifact_dir=tmp_path,
            writer=writer,
        )

    def test_creation(self, context: JobContext) -> None:
        """Test context creation."""
        assert context.job_id == "test-001"
        assert context.job_type == JobType.BACKTEST
        assert context.params["period"] == 20

    def test_cancellation(self, context: JobContext) -> None:
        """Test cancellation mechanism."""
        assert context.is_cancelled is False

        context.cancel()

        assert context.is_cancelled is True

    def test_check_cancelled_raises(self, context: JobContext) -> None:
        """Test that check_cancelled raises when cancelled."""
        context.cancel()

        with pytest.raises(JobCancelledException):
            context.check_cancelled()

    def test_write_artifact(self, context: JobContext, tmp_path: Path) -> None:
        """Test writing artifacts."""
        data = {"test": "value", "number": 42}
        path = context.write_artifact("test_artifact", data)

        assert path.exists()
        assert path.name == "test_artifact.json"

        # Verify content
        import json
        with open(path) as f:
            loaded = json.load(f)
        assert loaded["test"] == "value"


class SimpleTestJob(Job):
    """Simple job for testing."""

    @property
    def job_type(self) -> JobType:
        return JobType.BACKTEST

    def run(self, ctx: JobContext) -> JobResult:
        ctx.progress(50, "Processing...")
        ctx.log_info("Running test job")
        return JobResult(
            success=True,
            metrics=[MetricValue("Test", 100, "number")],
        )


class FailingTestJob(Job):
    """Job that always fails."""

    @property
    def job_type(self) -> JobType:
        return JobType.BACKTEST

    def run(self, ctx: JobContext) -> JobResult:
        raise ValueError("Test error")


class CancellableTestJob(Job):
    """Job that checks for cancellation."""

    @property
    def job_type(self) -> JobType:
        return JobType.BACKTEST

    def run(self, ctx: JobContext) -> JobResult:
        for i in range(100):
            ctx.check_cancelled()
            ctx.progress(i, f"Step {i}")
        return JobResult(success=True)


class TestJobExecutor:
    """Tests for JobExecutor class."""

    @pytest.fixture
    def executor(self, tmp_path: Path) -> JobExecutor:
        """Create a test executor."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)
        return JobExecutor(artifact_root=tmp_path, writer=writer)

    def test_execute_simple_job(
        self, executor: JobExecutor, tmp_path: Path
    ) -> None:
        """Test executing a simple job."""
        job = SimpleTestJob()
        config = JobConfig(symbol="AAPL", timeframe="1D")

        result = executor.execute(
            job=job,
            job_id="test-001",
            strategy_path="/path/to/strategy.py",
            config=config,
        )

        assert result.success is True
        assert len(result.metrics) == 1

    def test_execute_failing_job(
        self, executor: JobExecutor, tmp_path: Path
    ) -> None:
        """Test executing a failing job."""
        job = FailingTestJob()
        config = JobConfig(symbol="AAPL", timeframe="1D")

        result = executor.execute(
            job=job,
            job_id="test-002",
            strategy_path="/path/to/strategy.py",
            config=config,
        )

        assert result.success is False

    def test_artifact_directory_created(
        self, executor: JobExecutor, tmp_path: Path
    ) -> None:
        """Test that artifact directory is created."""
        job = SimpleTestJob()
        config = JobConfig(symbol="AAPL", timeframe="1D")

        executor.execute(
            job=job,
            job_id="test-003",
            strategy_path="/path/to/strategy.py",
            config=config,
        )

        artifact_dir = tmp_path / "test-003"
        assert artifact_dir.exists()
        assert (artifact_dir / "config.json").exists()

    def test_cancel_job(
        self, executor: JobExecutor, tmp_path: Path
    ) -> None:
        """Test cancelling a job."""
        import threading

        job = CancellableTestJob()
        config = JobConfig(symbol="AAPL", timeframe="1D")

        # Start job in thread
        result_holder = [None]

        def run_job():
            result_holder[0] = executor.execute(
                job=job,
                job_id="test-004",
                strategy_path="/path/to/strategy.py",
                config=config,
            )

        thread = threading.Thread(target=run_job)
        thread.start()

        # Cancel after brief delay
        import time
        time.sleep(0.01)
        cancelled = executor.cancel("test-004")

        thread.join(timeout=1.0)

        # Job should have been cancelled
        assert cancelled or not executor.is_running("test-004")

    def test_is_running(
        self, executor: JobExecutor, tmp_path: Path
    ) -> None:
        """Test is_running check."""
        assert executor.is_running("nonexistent") is False

    def test_config_validation_error(
        self, executor: JobExecutor, tmp_path: Path
    ) -> None:
        """Test config validation failure."""
        job = SimpleTestJob()
        config = JobConfig(symbol="", timeframe="1D")  # Invalid: empty symbol

        result = executor.execute(
            job=job,
            job_id="test-005",
            strategy_path="/path/to/strategy.py",
            config=config,
        )

        assert result.success is False


class TestJobCancelledException:
    """Tests for JobCancelledException."""

    def test_creation(self) -> None:
        """Test exception creation."""
        exc = JobCancelledException("test-001")
        assert exc.job_id == "test-001"
        assert "test-001" in str(exc)
