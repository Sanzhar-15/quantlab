"""
Job Base Classes.

Provides base class for all job types with progress reporting,
logging, cancellation, and artifact management.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

import json
import os
import tempfile
import threading
import time
import traceback
from abc import ABC
from abc import abstractmethod
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from enum import Enum
from pathlib import Path
from typing import Any
from typing import Callable

from quantlab.runtime.memory import MemoryLimits, MemoryMonitor, MemoryEvent, MemoryAction

from .protocol import (
    JobResult,
    LogLevel,
    MetricValue,
    NDJSONWriter,
)


class JobStatus(Enum):
    """Job execution status."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobType(Enum):
    """Available job types."""

    BACKTEST = "backtest"
    OPTIMIZE = "optimize"
    MONTE_CARLO = "montecarlo"
    WFA = "wfa"


@dataclass
class JobConfig:
    """Base configuration for all jobs."""

    symbol: str
    timeframe: str
    start_date: str | None = None
    end_date: str | None = None
    data_source: str = "default"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "startDate": self.start_date,
            "endDate": self.end_date,
            "dataSource": self.data_source,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "JobConfig":
        """Create from dictionary."""
        return cls(
            symbol=data.get("symbol", ""),
            timeframe=data.get("timeframe", "1D"),
            start_date=data.get("startDate"),
            end_date=data.get("endDate"),
            data_source=data.get("dataSource", "default"),
        )


class MemoryLimitExceededException(Exception):
    """Raised when job exceeds memory limits."""

    def __init__(self, job_id: str, current_mb: float, limit_mb: float) -> None:
        self.job_id = job_id
        self.current_mb = current_mb
        self.limit_mb = limit_mb
        super().__init__(
            f"Job {job_id} exceeded memory limit: {current_mb:.1f}MB > {limit_mb}MB"
        )


@dataclass
class JobContext:
    """Context provided to job during execution."""

    job_id: str
    job_type: JobType
    strategy_path: str
    config: JobConfig
    params: dict[str, Any]
    artifact_dir: Path
    writer: NDJSONWriter

    # Cancellation
    _cancelled: bool = field(default=False, repr=False)
    _cancel_lock: threading.Lock = field(
        default_factory=threading.Lock, repr=False
    )

    # Memory monitoring (per §10.1)
    _memory_monitor: MemoryMonitor | None = field(default=None, repr=False)
    _memory_limits: MemoryLimits = field(default_factory=MemoryLimits, repr=False)
    _memory_paused: bool = field(default=False, repr=False)

    @property
    def is_cancelled(self) -> bool:
        """Check if job has been cancelled."""
        with self._cancel_lock:
            return self._cancelled

    def cancel(self) -> None:
        """Request job cancellation."""
        with self._cancel_lock:
            self._cancelled = True

    def check_cancelled(self) -> None:
        """
        Check if cancelled and raise if so.

        Raises:
            JobCancelledException: If job was cancelled
        """
        if self.is_cancelled:
            raise JobCancelledException(self.job_id)

    def start_memory_monitoring(self, limits: MemoryLimits | None = None) -> None:
        """
        Start memory monitoring for this job.

        Args:
            limits: Memory limits to enforce (uses defaults if not specified)
        """
        if limits:
            self._memory_limits = limits

        self._memory_monitor = MemoryMonitor(
            limits=self._memory_limits,
            check_interval_sec=1.0,
            enable_monitoring=True,
        )

        # Register callback for memory events
        self._memory_monitor.register_callback(self._on_memory_event)
        self._memory_monitor.start()
        self.log_debug(f"Memory monitoring started (soft limit: {self._memory_limits.soft_limit_mb}MB)")

    def stop_memory_monitoring(self) -> None:
        """Stop memory monitoring."""
        if self._memory_monitor:
            self._memory_monitor.stop()
            self._memory_monitor = None

    def _on_memory_event(self, event: MemoryEvent) -> None:
        """Handle memory events from monitor."""
        if event.action_taken == MemoryAction.LOG_WARNING:
            self.log_warn(event.message)
        elif event.action_taken == MemoryAction.FORCE_GC:
            self.log_warn(f"Memory pressure: {event.message} - forcing GC")
        elif event.action_taken == MemoryAction.PAUSE_PROCESSING:
            self.log_warn(f"Memory critical: {event.message} - pausing")
            self._memory_paused = True
        elif event.action_taken == MemoryAction.ABORT:
            self.log_error(f"Memory limit exceeded: {event.message}")

    def check_memory(self) -> None:
        """
        Check memory limits and handle accordingly.

        Raises:
            MemoryLimitExceededException: If hard limit exceeded
        """
        if not self._memory_monitor:
            return

        # Wait if paused due to memory pressure
        if self._memory_paused:
            self.log_info("Waiting for memory pressure to ease...")
            if self._memory_monitor.wait_if_paused(timeout=30.0):
                self._memory_paused = False
                self.log_info("Memory pressure eased, resuming")
            else:
                # Timeout waiting for memory - abort
                usage = self._memory_monitor.get_current_usage()
                raise MemoryLimitExceededException(
                    self.job_id,
                    usage.get("rss_mb", 0),
                    self._memory_limits.hard_limit_mb,
                )

    def get_memory_usage(self) -> dict[str, Any]:
        """Get current memory usage statistics."""
        if self._memory_monitor:
            return self._memory_monitor.get_current_usage()
        return {"error": "Memory monitoring not enabled"}

    def progress(
        self,
        percent: float,
        message: str = "",
        eta: str | None = None,
    ) -> None:
        """
        Report progress.

        Also checks for cancellation and memory limits.

        Args:
            percent: Progress percentage (0-100)
            message: Progress message
            eta: Estimated time remaining

        Raises:
            JobCancelledException: If job was cancelled
            MemoryLimitExceededException: If memory limits exceeded
        """
        self.check_cancelled()
        self.check_memory()
        self.writer.progress(self.job_id, percent, message, eta)

    def log(
        self,
        message: str,
        level: LogLevel = LogLevel.INFO,
    ) -> None:
        """
        Log a message.

        Args:
            message: Log message
            level: Log level
        """
        self.writer.log(self.job_id, message, level)

    def log_debug(self, message: str) -> None:
        """Log a debug message."""
        self.log(message, LogLevel.DEBUG)

    def log_info(self, message: str) -> None:
        """Log an info message."""
        self.log(message, LogLevel.INFO)

    def log_warn(self, message: str) -> None:
        """Log a warning message."""
        self.log(message, LogLevel.WARN)

    def log_error(self, message: str) -> None:
        """Log an error message."""
        self.log(message, LogLevel.ERROR)

    def write_artifact(
        self,
        name: str,
        data: dict[str, Any] | list[Any],
    ) -> Path:
        """
        Write a JSON artifact atomically.

        Args:
            name: Artifact filename (without .json extension)
            data: Data to write

        Returns:
            Path to written artifact
        """
        artifact_path = self.artifact_dir / f"{name}.json"

        # Write atomically via temp file
        fd, temp_path = tempfile.mkstemp(
            suffix=".json",
            dir=self.artifact_dir,
        )
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2, default=str)
            os.rename(temp_path, artifact_path)
        except Exception:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            raise

        return artifact_path


class JobCancelledException(Exception):
    """Raised when a job is cancelled."""

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        super().__init__(f"Job {job_id} was cancelled")


class Job(ABC):
    """
    Abstract base class for all jobs.

    Subclasses must implement:
    - run(ctx): Execute the job
    - job_type: Property returning the job type
    """

    @property
    @abstractmethod
    def job_type(self) -> JobType:
        """Return the job type."""
        ...

    @abstractmethod
    def run(self, ctx: JobContext) -> JobResult:
        """
        Execute the job.

        Args:
            ctx: Job execution context

        Returns:
            JobResult with metrics and artifacts

        Raises:
            JobCancelledException: If job was cancelled
            Exception: On job failure
        """
        ...

    def validate_config(self, config: JobConfig) -> list[str]:
        """
        Validate job configuration.

        Args:
            config: Configuration to validate

        Returns:
            List of validation error messages (empty if valid)
        """
        errors = []
        if not config.symbol:
            errors.append("Symbol is required")
        if not config.timeframe:
            errors.append("Timeframe is required")
        return errors


def generate_job_id(job_type: str) -> str:
    """
    Generate a stable, human-readable job ID.

    Format: {job_type}-{date}-{sequence}
    Example: backtest-20260119-00042

    Args:
        job_type: Type of job

    Returns:
        Generated job ID
    """
    date_str = datetime.now().strftime("%Y%m%d")
    # Use timestamp-based sequence for uniqueness
    seq = int(time.time() * 1000) % 100000
    return f"{job_type}-{date_str}-{seq:05d}"


class JobExecutor:
    """
    Executes jobs with proper lifecycle management.

    Handles:
    - Job setup and teardown
    - Progress reporting
    - Error handling
    - Artifact management
    - Cancellation
    """

    def __init__(
        self,
        artifact_root: Path,
        writer: NDJSONWriter | None = None,
    ) -> None:
        """
        Initialize executor.

        Args:
            artifact_root: Root directory for job artifacts
            writer: NDJSON writer for output
        """
        self._artifact_root = Path(artifact_root)
        self._writer = writer or NDJSONWriter()
        self._jobs: dict[str, JobContext] = {}
        self._lock = threading.Lock()

    def execute(
        self,
        job: Job,
        job_id: str,
        strategy_path: str,
        config: JobConfig,
        params: dict[str, Any] | None = None,
    ) -> JobResult:
        """
        Execute a job.

        Args:
            job: Job instance to execute
            job_id: Unique job identifier
            strategy_path: Path to strategy file
            config: Job configuration
            params: Strategy parameters

        Returns:
            JobResult with execution results
        """
        start_time = time.time()

        # Create artifact directory
        artifact_dir = self._artifact_root / job_id
        artifact_dir.mkdir(parents=True, exist_ok=True)

        # Create context
        ctx = JobContext(
            job_id=job_id,
            job_type=job.job_type,
            strategy_path=strategy_path,
            config=config,
            params=params or {},
            artifact_dir=artifact_dir,
            writer=self._writer,
        )

        # Register job
        with self._lock:
            self._jobs[job_id] = ctx

        try:
            # Validate config
            errors = job.validate_config(config)
            if errors:
                raise ValueError(f"Invalid configuration: {'; '.join(errors)}")

            # Log start
            ctx.log_info(f"Starting {job.job_type.value} job")
            ctx.progress(0, "Initializing...")

            # Execute job
            result = job.run(ctx)

            # Calculate duration
            duration = time.time() - start_time

            # Save config artifact
            ctx.write_artifact("config", {
                "jobId": job_id,
                "jobType": job.job_type.value,
                "strategyPath": strategy_path,
                "config": config.to_dict(),
                "params": params or {},
                "completedAt": datetime.now(timezone.utc).isoformat(),
                "durationSeconds": duration,
            })

            # Update artifact paths
            result.artifact_paths["config"] = str(artifact_dir / "config.json")

            # Log completion
            ctx.log_info(f"Job completed in {duration:.2f}s")
            ctx.progress(100, "Complete")

            # Send completion message
            self._writer.complete(job_id, result, duration)

            return result

        except JobCancelledException:
            duration = time.time() - start_time
            ctx.log_warn("Job cancelled by user")
            result = JobResult(
                success=False,
                warnings=["Job was cancelled"],
            )
            # Don't send failed for cancellation
            return result

        except Exception as e:
            duration = time.time() - start_time
            error_msg = str(e)
            stack = traceback.format_exc()

            ctx.log_error(f"Job failed: {error_msg}")
            self._writer.failed(job_id, error_msg, stack)

            return JobResult(
                success=False,
                warnings=[f"Job failed: {error_msg}"],
            )

        finally:
            # Unregister job
            with self._lock:
                self._jobs.pop(job_id, None)

    def cancel(self, job_id: str) -> bool:
        """
        Cancel a running job.

        Args:
            job_id: Job to cancel

        Returns:
            True if job was found and cancelled
        """
        with self._lock:
            ctx = self._jobs.get(job_id)
            if ctx:
                ctx.cancel()
                return True
            return False

    def is_running(self, job_id: str) -> bool:
        """Check if a job is currently running."""
        with self._lock:
            return job_id in self._jobs
