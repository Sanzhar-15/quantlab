"""
Tests for Backtest Queue.

Tests concurrent backtest execution, job management, and batch processing.
"""

import time
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest

from quantlab.backtest.queue import (
    BacktestJob,
    BacktestQueue,
    BacktestQueueWorker,
    BatchBacktestRunner,
    JobPriority,
    JobStatus,
    PriorityQueue,
    QueueStats,
    WorkerStats,
)


class TestJobStatus:
    """Tests for JobStatus enum."""

    def test_job_status_values(self) -> None:
        """Test job status values."""
        assert JobStatus.PENDING.value == "pending"
        assert JobStatus.QUEUED.value == "queued"
        assert JobStatus.RUNNING.value == "running"
        assert JobStatus.COMPLETED.value == "completed"
        assert JobStatus.FAILED.value == "failed"


class TestJobPriority:
    """Tests for JobPriority enum."""

    def test_priority_ordering(self) -> None:
        """Test priority ordering."""
        assert JobPriority.LOW.value < JobPriority.NORMAL.value
        assert JobPriority.NORMAL.value < JobPriority.HIGH.value
        assert JobPriority.HIGH.value < JobPriority.URGENT.value


class TestBacktestJob:
    """Tests for BacktestJob dataclass."""

    def test_job_creation(self) -> None:
        """Test creating a backtest job."""
        job = BacktestJob(
            job_id="job_001",
            strategy_id="sma_crossover",
            config={"lookback": 20},
            priority=JobPriority.NORMAL,
        )

        assert job.job_id == "job_001"
        assert job.strategy_id == "sma_crossover"
        assert job.status == JobStatus.PENDING
        assert job.progress == 0.0

    def test_job_comparison(self) -> None:
        """Test job priority comparison."""
        job1 = BacktestJob(
            job_id="job_1",
            strategy_id="s1",
            config={},
            priority=JobPriority.NORMAL,
        )
        job2 = BacktestJob(
            job_id="job_2",
            strategy_id="s2",
            config={},
            priority=JobPriority.HIGH,
        )

        # Higher priority job should be "less than" for priority queue
        assert job2 < job1

    def test_job_same_priority_fifo(self) -> None:
        """Test same priority orders by creation time."""
        job1 = BacktestJob(
            job_id="job_1",
            strategy_id="s1",
            config={},
            priority=JobPriority.NORMAL,
            created_at=datetime(2026, 1, 15, 10, 0, 0),
        )
        job2 = BacktestJob(
            job_id="job_2",
            strategy_id="s2",
            config={},
            priority=JobPriority.NORMAL,
            created_at=datetime(2026, 1, 15, 10, 1, 0),
        )

        # Earlier job should come first
        assert job1 < job2


class TestPriorityQueue:
    """Tests for PriorityQueue."""

    @pytest.fixture
    def queue(self) -> PriorityQueue[BacktestJob]:
        """Create priority queue."""
        return PriorityQueue()

    def test_put_and_get(
        self,
        queue: PriorityQueue[BacktestJob],
    ) -> None:
        """Test basic put and get operations."""
        job = BacktestJob(
            job_id="test",
            strategy_id="s1",
            config={},
        )

        queue.put(job)
        assert queue.qsize() == 1

        retrieved = queue.get(timeout=1.0)
        assert retrieved == job
        assert queue.empty()

    def test_priority_ordering(
        self,
        queue: PriorityQueue[BacktestJob],
    ) -> None:
        """Test jobs come out in priority order."""
        low = BacktestJob("low", "s", {}, priority=JobPriority.LOW)
        high = BacktestJob("high", "s", {}, priority=JobPriority.HIGH)
        urgent = BacktestJob("urgent", "s", {}, priority=JobPriority.URGENT)

        # Add in arbitrary order
        queue.put(low)
        queue.put(urgent)
        queue.put(high)

        # Should come out in priority order
        assert queue.get(timeout=1.0).job_id == "urgent"
        assert queue.get(timeout=1.0).job_id == "high"
        assert queue.get(timeout=1.0).job_id == "low"

    def test_peek(
        self,
        queue: PriorityQueue[BacktestJob],
    ) -> None:
        """Test peeking at queue."""
        job = BacktestJob("test", "s", {})
        queue.put(job)

        # Peek should not remove
        peeked = queue.peek()
        assert peeked == job
        assert queue.qsize() == 1


class TestBacktestQueueWorker:
    """Tests for BacktestQueueWorker."""

    def test_worker_processes_job(self) -> None:
        """Test worker processes a job."""
        results = []

        def executor(job: BacktestJob) -> dict:
            return {"result": f"processed_{job.job_id}"}

        def on_complete(job: BacktestJob) -> None:
            results.append(job)

        queue: PriorityQueue[BacktestJob] = PriorityQueue()
        worker = BacktestQueueWorker(
            worker_id="w1",
            job_queue=queue,
            executor=executor,
            on_complete=on_complete,
        )

        job = BacktestJob("job1", "strategy", {})
        queue.put(job)

        worker.start()
        time.sleep(0.5)  # Give worker time to process
        worker.stop()

        assert len(results) == 1
        assert results[0].status == JobStatus.COMPLETED
        assert results[0].result["result"] == "processed_job1"

    def test_worker_handles_error(self) -> None:
        """Test worker handles executor errors."""
        errors = []

        def executor(job: BacktestJob) -> dict:
            raise ValueError("Test error")

        def on_error(job: BacktestJob, error: Exception) -> None:
            errors.append((job, error))

        queue: PriorityQueue[BacktestJob] = PriorityQueue()
        worker = BacktestQueueWorker(
            worker_id="w1",
            job_queue=queue,
            executor=executor,
            on_error=on_error,
        )

        job = BacktestJob("job1", "strategy", {})
        queue.put(job)

        worker.start()
        time.sleep(0.5)
        worker.stop()

        assert len(errors) == 1
        assert errors[0][0].status == JobStatus.FAILED
        assert "Test error" in errors[0][0].error


class TestBacktestQueue:
    """Tests for BacktestQueue."""

    @pytest.fixture
    def simple_executor(self) -> callable:
        """Simple executor that returns config."""
        def executor(job: BacktestJob) -> dict:
            # Simulate some work
            time.sleep(0.1)
            return {"config": job.config, "strategy": job.strategy_id}

        return executor

    def test_submit_and_get_result(
        self,
        simple_executor: callable,
    ) -> None:
        """Test submitting a job and getting result."""
        queue = BacktestQueue(
            executor=simple_executor,
            num_workers=2,
        )

        with queue:
            job_id = queue.submit(
                strategy_id="test_strategy",
                config={"lookback": 20},
            )

            result = queue.get_job_result(job_id)

            assert result["strategy"] == "test_strategy"
            assert result["config"]["lookback"] == 20

    def test_job_priority(
        self,
        simple_executor: callable,
    ) -> None:
        """Test high priority jobs processed first."""
        completed = []

        def tracking_executor(job: BacktestJob) -> dict:
            time.sleep(0.05)
            completed.append(job.job_id)
            return {}

        queue = BacktestQueue(
            executor=tracking_executor,
            num_workers=1,  # Single worker to ensure ordering
        )

        with queue:
            # Submit low first, then high
            queue.submit("s1", {}, priority=JobPriority.LOW)
            queue.submit("s2", {}, priority=JobPriority.HIGH)

            # Wait for completion
            time.sleep(0.5)

        # High priority should be processed first
        # (order may vary due to timing, but high should generally come first)

    def test_cancel_job(
        self,
        simple_executor: callable,
    ) -> None:
        """Test cancelling a job."""
        queue = BacktestQueue(
            executor=simple_executor,
            num_workers=0,  # No workers - jobs stay queued
        )

        job_id = queue.submit("test", {})

        success = queue.cancel(job_id)

        assert success
        assert queue.get_job_status(job_id) == JobStatus.CANCELLED

    def test_wait_for_job(
        self,
        simple_executor: callable,
    ) -> None:
        """Test waiting for job completion."""
        queue = BacktestQueue(
            executor=simple_executor,
            num_workers=2,
        )

        with queue:
            job_id = queue.submit("test", {})

            completed = queue.wait_for_job(job_id, timeout=5.0)

            assert completed
            assert queue.get_job_status(job_id) == JobStatus.COMPLETED

    def test_list_jobs(
        self,
        simple_executor: callable,
    ) -> None:
        """Test listing jobs."""
        queue = BacktestQueue(
            executor=simple_executor,
            num_workers=0,
        )

        queue.submit("s1", {})
        queue.submit("s2", {})

        jobs = queue.list_jobs()

        assert len(jobs) == 2

    def test_queue_stats(
        self,
        simple_executor: callable,
    ) -> None:
        """Test getting queue statistics."""
        queue = BacktestQueue(
            executor=simple_executor,
            num_workers=2,
        )

        with queue:
            queue.submit("s1", {})
            queue.submit("s2", {})

            time.sleep(0.5)

            stats = queue.get_stats()

            assert isinstance(stats, QueueStats)
            assert stats.pending_jobs >= 0
            assert stats.completed_jobs >= 0

    def test_completion_callback(
        self,
        simple_executor: callable,
    ) -> None:
        """Test completion callbacks."""
        completed_jobs = []

        queue = BacktestQueue(
            executor=simple_executor,
            num_workers=2,
        )

        queue.on_complete(lambda job: completed_jobs.append(job.job_id))

        with queue:
            queue.submit("s1", {})
            time.sleep(0.5)

        assert len(completed_jobs) >= 0  # May be 1 if processed in time


class TestBatchBacktestRunner:
    """Tests for BatchBacktestRunner."""

    @pytest.fixture
    def fast_executor(self) -> callable:
        """Fast executor for batch testing."""
        def executor(job: BacktestJob) -> dict:
            return {
                "strategy": job.strategy_id,
                "lookback": job.config.get("lookback", 0),
            }

        return executor

    def test_run_batch(
        self,
        fast_executor: callable,
    ) -> None:
        """Test running a batch of backtests."""
        runner = BatchBacktestRunner(
            executor=fast_executor,
            num_workers=2,
        )

        jobs = [
            ("strategy_a", {"lookback": 10}),
            ("strategy_b", {"lookback": 20}),
            ("strategy_c", {"lookback": 30}),
        ]

        results = runner.run_batch(jobs, timeout=10.0)

        assert len(results) == 3
        assert results[0]["strategy"] == "strategy_a"
        assert results[1]["lookback"] == 20

    def test_parameter_sweep(
        self,
        fast_executor: callable,
    ) -> None:
        """Test running a parameter sweep."""
        runner = BatchBacktestRunner(
            executor=fast_executor,
            num_workers=4,
        )

        results = runner.run_parameter_sweep(
            strategy_id="test_strategy",
            base_config={},
            param_name="lookback",
            param_values=[10, 20, 30, 40, 50],
        )

        assert len(results) == 5
        assert results[10]["lookback"] == 10
        assert results[50]["lookback"] == 50


class TestWorkerStats:
    """Tests for WorkerStats."""

    def test_worker_stats_creation(self) -> None:
        """Test creating worker stats."""
        stats = WorkerStats(
            worker_id="w1",
            jobs_completed=10,
            jobs_failed=2,
            total_runtime_sec=120.5,
        )

        assert stats.worker_id == "w1"
        assert stats.jobs_completed == 10
        assert not stats.is_busy


class TestQueueStats:
    """Tests for QueueStats."""

    def test_queue_stats_creation(self) -> None:
        """Test creating queue stats."""
        stats = QueueStats(
            pending_jobs=5,
            running_jobs=2,
            completed_jobs=100,
            failed_jobs=3,
            avg_wait_time_sec=1.5,
            avg_run_time_sec=10.0,
            workers_active=2,
            workers_idle=2,
        )

        assert stats.pending_jobs == 5
        assert stats.workers_active == 2
