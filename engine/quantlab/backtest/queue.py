"""
Concurrent Backtest Queue.

Provides job queue management for parallel backtest execution.

Spec Reference: Technical Spec §10.2
"""

import queue
import threading
import time
import uuid
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from enum import Enum
from typing import Any
from typing import Callable
from typing import Generic
from typing import TypeVar


class JobStatus(Enum):
    """Status of a backtest job."""

    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


class JobPriority(Enum):
    """Priority levels for backtest jobs."""

    LOW = 0
    NORMAL = 1
    HIGH = 2
    URGENT = 3


@dataclass
class BacktestJob:
    """A backtest job in the queue."""

    job_id: str
    strategy_id: str
    config: dict[str, Any]
    priority: JobPriority = JobPriority.NORMAL
    status: JobStatus = JobStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    result: Any = None
    error: str | None = None
    progress: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    # Event for signaling job completion (avoid busy-polling)
    _completion_event: threading.Event = field(
        default_factory=threading.Event, repr=False, compare=False
    )

    def __lt__(self, other: "BacktestJob") -> bool:
        """Compare by priority (higher priority first)."""
        if self.priority.value != other.priority.value:
            return self.priority.value > other.priority.value
        return self.created_at < other.created_at

    def signal_completion(self) -> None:
        """Signal that the job has completed (success, failure, or cancelled)."""
        self._completion_event.set()

    def wait_completion(self, timeout: float | None = None) -> bool:
        """
        Wait for job completion.

        Args:
            timeout: Maximum wait time in seconds (None = wait forever)

        Returns:
            True if job completed, False if timed out
        """
        return self._completion_event.wait(timeout=timeout)


@dataclass
class WorkerStats:
    """Statistics for a queue worker."""

    worker_id: str
    jobs_completed: int = 0
    jobs_failed: int = 0
    total_runtime_sec: float = 0.0
    current_job_id: str | None = None
    is_busy: bool = False
    last_active: datetime | None = None


@dataclass
class QueueStats:
    """Statistics for the backtest queue."""

    pending_jobs: int = 0
    running_jobs: int = 0
    completed_jobs: int = 0
    failed_jobs: int = 0
    avg_wait_time_sec: float = 0.0
    avg_run_time_sec: float = 0.0
    workers_active: int = 0
    workers_idle: int = 0


T = TypeVar("T")


class PriorityQueue(Generic[T]):
    """Thread-safe priority queue."""

    def __init__(self) -> None:
        self._queue: list[T] = []
        self._lock = threading.Lock()
        self._not_empty = threading.Condition(self._lock)

    def put(self, item: T) -> None:
        """Add item to queue."""
        with self._not_empty:
            # Insert maintaining sorted order
            import bisect

            bisect.insort(self._queue, item)
            self._not_empty.notify()

    def get(self, timeout: float | None = None) -> T | None:
        """Get highest priority item from queue."""
        with self._not_empty:
            if not self._queue:
                self._not_empty.wait(timeout)

            if not self._queue:
                return None

            return self._queue.pop(0)

    def peek(self) -> T | None:
        """Peek at highest priority item without removing."""
        with self._lock:
            return self._queue[0] if self._queue else None

    def qsize(self) -> int:
        """Get queue size."""
        with self._lock:
            return len(self._queue)

    def empty(self) -> bool:
        """Check if queue is empty."""
        with self._lock:
            return len(self._queue) == 0

    def remove(self, item: T) -> bool:
        """
        Remove a specific item from the queue.

        Args:
            item: Item to remove

        Returns:
            True if item was found and removed
        """
        with self._lock:
            try:
                self._queue.remove(item)
                return True
            except ValueError:
                return False


class BacktestQueueWorker:
    """Worker thread for processing backtest jobs."""

    def __init__(
        self,
        worker_id: str,
        job_queue: PriorityQueue[BacktestJob],
        executor: Callable[[BacktestJob], Any],
        on_complete: Callable[[BacktestJob], None] | None = None,
        on_error: Callable[[BacktestJob, Exception], None] | None = None,
    ) -> None:
        """
        Initialize worker.

        Args:
            worker_id: Unique worker identifier
            job_queue: Queue to pull jobs from
            executor: Function to execute backtests
            on_complete: Callback on job completion
            on_error: Callback on job error
        """
        self.worker_id = worker_id
        self.job_queue = job_queue
        self.executor = executor
        self.on_complete = on_complete
        self.on_error = on_error

        self.stats = WorkerStats(worker_id=worker_id)

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def start(self) -> None:
        """Start worker thread."""
        if self._thread is not None and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._work_loop,
            daemon=True,
            name=f"BacktestWorker-{self.worker_id}",
        )
        self._thread.start()

    def stop(self, wait: bool = True) -> None:
        """Stop worker thread."""
        self._stop_event.set()

        if wait and self._thread is not None:
            self._thread.join(timeout=30.0)
            self._thread = None

    def _work_loop(self) -> None:
        """Main work loop."""
        while not self._stop_event.is_set():
            job = self.job_queue.get(timeout=1.0)

            if job is None:
                continue

            if self._stop_event.is_set():
                # Put job back if we're stopping
                self.job_queue.put(job)
                break

            # Skip cancelled jobs - they remain in queue but are not processed
            if job.status == JobStatus.CANCELLED:
                continue

            self._process_job(job)

    def _process_job(self, job: BacktestJob) -> None:
        """Process a single job."""
        self.stats.is_busy = True
        self.stats.current_job_id = job.job_id
        self.stats.last_active = datetime.now()

        job.status = JobStatus.RUNNING
        job.started_at = datetime.now()

        start_time = time.time()

        try:
            result = self.executor(job)

            job.result = result
            job.status = JobStatus.COMPLETED
            job.progress = 1.0

            self.stats.jobs_completed += 1

            if self.on_complete:
                self.on_complete(job)

        except Exception as e:
            job.error = str(e)
            job.status = JobStatus.FAILED

            self.stats.jobs_failed += 1

            if self.on_error:
                self.on_error(job, e)

        finally:
            job.completed_at = datetime.now()
            elapsed = time.time() - start_time
            self.stats.total_runtime_sec += elapsed

            self.stats.is_busy = False
            self.stats.current_job_id = None

            # Signal completion to wake up any waiters
            job.signal_completion()

    def is_busy(self) -> bool:
        """Check if worker is processing a job."""
        return self.stats.is_busy


class BacktestQueue:
    """
    Concurrent backtest execution queue.

    Features:
    - Priority-based job scheduling
    - Multiple worker threads
    - Progress tracking
    - Cancellation support
    - Statistics and monitoring
    """

    def __init__(
        self,
        executor: Callable[[BacktestJob], Any],
        num_workers: int = 4,
        max_queue_size: int = 1000,
    ) -> None:
        """
        Initialize backtest queue.

        Args:
            executor: Function to execute backtests
            num_workers: Number of worker threads
            max_queue_size: Maximum queue size
        """
        self.executor = executor
        self.num_workers = num_workers
        self.max_queue_size = max_queue_size

        self._job_queue: PriorityQueue[BacktestJob] = PriorityQueue()
        self._jobs: dict[str, BacktestJob] = {}
        self._jobs_lock = threading.Lock()

        self._workers: list[BacktestQueueWorker] = []
        self._is_running = False

        self._on_complete_callbacks: list[Callable[[BacktestJob], None]] = []
        self._on_error_callbacks: list[Callable[[BacktestJob, Exception], None]] = []

        # Statistics tracking
        self._wait_times: list[float] = []
        self._run_times: list[float] = []

    def start(self) -> None:
        """Start the queue and workers."""
        if self._is_running:
            return

        self._is_running = True

        # Create and start workers
        for i in range(self.num_workers):
            worker = BacktestQueueWorker(
                worker_id=f"worker_{i}",
                job_queue=self._job_queue,
                executor=self.executor,
                on_complete=self._handle_completion,
                on_error=self._handle_error,
            )
            worker.start()
            self._workers.append(worker)

    def stop(self, wait: bool = True) -> None:
        """Stop the queue and all workers."""
        self._is_running = False

        for worker in self._workers:
            worker.stop(wait=wait)

        self._workers.clear()

    def submit(
        self,
        strategy_id: str,
        config: dict[str, Any],
        priority: JobPriority = JobPriority.NORMAL,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """
        Submit a backtest job.

        Args:
            strategy_id: Strategy identifier
            config: Backtest configuration
            priority: Job priority
            metadata: Additional metadata

        Returns:
            Job ID

        Raises:
            RuntimeError: If queue is full
        """
        with self._jobs_lock:
            if len(self._jobs) >= self.max_queue_size:
                raise RuntimeError("Queue is full")

            job_id = str(uuid.uuid4())

            job = BacktestJob(
                job_id=job_id,
                strategy_id=strategy_id,
                config=config,
                priority=priority,
                status=JobStatus.QUEUED,
                metadata=metadata or {},
            )

            self._jobs[job_id] = job

        self._job_queue.put(job)

        return job_id

    def cancel(self, job_id: str) -> bool:
        """
        Cancel a job.

        Args:
            job_id: Job to cancel

        Returns:
            True if cancelled successfully
        """
        with self._jobs_lock:
            job = self._jobs.get(job_id)

            if job is None:
                return False

            if job.status in (JobStatus.PENDING, JobStatus.QUEUED):
                job.status = JobStatus.CANCELLED
                # Also try to remove from queue to prevent workers from picking it up
                # This is best-effort - worker also checks cancelled status
                self._job_queue.remove(job)
                # Signal completion to wake up any waiters
                job.signal_completion()
                return True

            return False

    def get_job(self, job_id: str) -> BacktestJob | None:
        """Get job by ID."""
        with self._jobs_lock:
            return self._jobs.get(job_id)

    def get_job_status(self, job_id: str) -> JobStatus | None:
        """Get job status."""
        job = self.get_job(job_id)
        return job.status if job else None

    def get_job_result(self, job_id: str) -> Any:
        """Get job result (blocks until complete)."""
        job = self.get_job(job_id)

        if job is None:
            raise ValueError(f"Job not found: {job_id}")

        # Wait for completion using event (no busy-polling)
        job.wait_completion()

        if job.status == JobStatus.FAILED:
            raise RuntimeError(f"Job failed: {job.error}")

        if job.status == JobStatus.CANCELLED:
            raise RuntimeError("Job was cancelled")

        return job.result

    def wait_for_job(
        self,
        job_id: str,
        timeout: float | None = None,
    ) -> bool:
        """
        Wait for a job to complete.

        Args:
            job_id: Job to wait for
            timeout: Maximum wait time in seconds

        Returns:
            True if job completed, False if timed out
        """
        job = self.get_job(job_id)

        if job is None:
            return False

        # Wait for completion using event (no busy-polling)
        return job.wait_completion(timeout=timeout)

    def list_jobs(
        self,
        status: JobStatus | None = None,
        strategy_id: str | None = None,
    ) -> list[BacktestJob]:
        """List jobs with optional filtering."""
        with self._jobs_lock:
            jobs = list(self._jobs.values())

        if status is not None:
            jobs = [j for j in jobs if j.status == status]

        if strategy_id is not None:
            jobs = [j for j in jobs if j.strategy_id == strategy_id]

        return sorted(jobs, key=lambda j: j.created_at)

    def on_complete(
        self,
        callback: Callable[[BacktestJob], None],
    ) -> None:
        """Register completion callback."""
        self._on_complete_callbacks.append(callback)

    def on_error(
        self,
        callback: Callable[[BacktestJob, Exception], None],
    ) -> None:
        """Register error callback."""
        self._on_error_callbacks.append(callback)

    def _handle_completion(self, job: BacktestJob) -> None:
        """Handle job completion."""
        # Track timing
        if job.started_at and job.created_at:
            wait_time = (job.started_at - job.created_at).total_seconds()
            self._wait_times.append(wait_time)

            # Limit tracking history
            if len(self._wait_times) > 1000:
                self._wait_times = self._wait_times[-1000:]

        if job.completed_at and job.started_at:
            run_time = (job.completed_at - job.started_at).total_seconds()
            self._run_times.append(run_time)

            if len(self._run_times) > 1000:
                self._run_times = self._run_times[-1000:]

        # Notify callbacks
        for callback in self._on_complete_callbacks:
            try:
                callback(job)
            except Exception:
                pass

    def _handle_error(self, job: BacktestJob, error: Exception) -> None:
        """Handle job error."""
        for callback in self._on_error_callbacks:
            try:
                callback(job, error)
            except Exception:
                pass

    def get_stats(self) -> QueueStats:
        """Get queue statistics."""
        with self._jobs_lock:
            jobs = list(self._jobs.values())

        pending = sum(1 for j in jobs if j.status in (JobStatus.PENDING, JobStatus.QUEUED))
        running = sum(1 for j in jobs if j.status == JobStatus.RUNNING)
        completed = sum(1 for j in jobs if j.status == JobStatus.COMPLETED)
        failed = sum(1 for j in jobs if j.status == JobStatus.FAILED)

        workers_active = sum(1 for w in self._workers if w.is_busy())
        workers_idle = len(self._workers) - workers_active

        avg_wait = sum(self._wait_times) / len(self._wait_times) if self._wait_times else 0.0
        avg_run = sum(self._run_times) / len(self._run_times) if self._run_times else 0.0

        return QueueStats(
            pending_jobs=pending,
            running_jobs=running,
            completed_jobs=completed,
            failed_jobs=failed,
            avg_wait_time_sec=avg_wait,
            avg_run_time_sec=avg_run,
            workers_active=workers_active,
            workers_idle=workers_idle,
        )

    def get_worker_stats(self) -> list[WorkerStats]:
        """Get worker statistics."""
        return [w.stats for w in self._workers]

    def clear_completed(self) -> int:
        """
        Clear completed and failed jobs from history.

        Returns:
            Number of jobs cleared
        """
        cleared = 0

        with self._jobs_lock:
            to_remove = [
                job_id
                for job_id, job in self._jobs.items()
                if job.status
                in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
            ]

            for job_id in to_remove:
                del self._jobs[job_id]
                cleared += 1

        return cleared

    def __enter__(self) -> "BacktestQueue":
        """Context manager entry."""
        self.start()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.stop()


class BatchBacktestRunner:
    """
    Run multiple backtests in batch.

    Convenience wrapper around BacktestQueue for common batch operations.
    """

    def __init__(
        self,
        executor: Callable[[BacktestJob], Any],
        num_workers: int = 4,
    ) -> None:
        """Initialize batch runner."""
        self.queue = BacktestQueue(
            executor=executor,
            num_workers=num_workers,
        )

    def run_batch(
        self,
        jobs: list[tuple[str, dict[str, Any]]],
        timeout: float | None = None,
    ) -> list[Any]:
        """
        Run a batch of backtests.

        Args:
            jobs: List of (strategy_id, config) tuples
            timeout: Maximum total time for batch

        Returns:
            List of results in same order as jobs
        """
        with self.queue:
            job_ids = []

            for strategy_id, config in jobs:
                job_id = self.queue.submit(strategy_id, config)
                job_ids.append(job_id)

            results = []
            start_time = time.time()

            for job_id in job_ids:
                remaining = None
                if timeout is not None:
                    elapsed = time.time() - start_time
                    remaining = max(0, timeout - elapsed)

                if not self.queue.wait_for_job(job_id, timeout=remaining):
                    results.append(None)  # Timed out
                else:
                    job = self.queue.get_job(job_id)
                    results.append(job.result if job else None)

            return results

    def run_parameter_sweep(
        self,
        strategy_id: str,
        base_config: dict[str, Any],
        param_name: str,
        param_values: list[Any],
    ) -> dict[Any, Any]:
        """
        Run parameter sweep over single parameter.

        Args:
            strategy_id: Strategy to test
            base_config: Base configuration
            param_name: Parameter to sweep
            param_values: Values to test

        Returns:
            Dictionary of param_value -> result
        """
        jobs = []

        for value in param_values:
            config = base_config.copy()
            config[param_name] = value
            jobs.append((strategy_id, config))

        results = self.run_batch(jobs)

        return dict(zip(param_values, results))
