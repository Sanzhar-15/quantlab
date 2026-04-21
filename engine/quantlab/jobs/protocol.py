"""
Job Protocol Messages.

Defines NDJSON message types for engine-extension communication.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

import json
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from enum import Enum
from typing import Any


class JobMessageType(Enum):
    """Message types for job communication."""

    # Engine -> Extension
    PROGRESS = "progress"
    LOG = "log"
    COMPLETE = "complete"
    FAILED = "failed"

    # Extension -> Engine
    RUN = "run"
    CANCEL = "cancel"


class LogLevel(Enum):
    """Log message levels."""

    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


@dataclass
class ProgressMessage:
    """Progress update message."""

    job_id: str
    progress: float  # 0-100
    message: str = ""
    eta: str | None = None
    items_completed: int = 0
    items_total: int = 0
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": JobMessageType.PROGRESS.value,
            "jobId": self.job_id,
            "timestamp": self.timestamp.isoformat(),
            "progress": self.progress,
            "message": self.message,
            "eta": self.eta,
            "itemsCompleted": self.items_completed,
            "itemsTotal": self.items_total,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


@dataclass
class LogMessage:
    """Log message."""

    job_id: str
    message: str
    level: LogLevel = LogLevel.INFO
    source: str | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": JobMessageType.LOG.value,
            "jobId": self.job_id,
            "timestamp": self.timestamp.isoformat(),
            "message": self.message,
            "level": self.level.value,
            "source": self.source,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


@dataclass
class MetricValue:
    """A single metric value."""

    name: str
    value: float | int | str
    format: str | None = None  # "percent", "currency", "number"
    description: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "value": self.value,
            "format": self.format,
            "description": self.description,
        }


@dataclass
class JobResult:
    """Result of a completed job."""

    success: bool
    metrics: list[MetricValue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)
    artifact_paths: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "success": self.success,
            "metrics": [m.to_dict() for m in self.metrics],
            "warnings": self.warnings,
            "details": self.details,
            "artifactPaths": self.artifact_paths,
        }


@dataclass
class CompleteMessage:
    """Job completion message."""

    job_id: str
    result: JobResult
    duration_seconds: float = 0.0
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": JobMessageType.COMPLETE.value,
            "jobId": self.job_id,
            "timestamp": self.timestamp.isoformat(),
            "result": self.result.to_dict(),
            "durationSeconds": self.duration_seconds,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


@dataclass
class FailedMessage:
    """Job failure message."""

    job_id: str
    error: str
    error_code: str | None = None
    stack: str | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": JobMessageType.FAILED.value,
            "jobId": self.job_id,
            "timestamp": self.timestamp.isoformat(),
            "error": self.error,
            "errorCode": self.error_code,
            "stack": self.stack,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


@dataclass
class RunRequest:
    """Request to run a job."""

    job_type: str  # "backtest", "optimize", "montecarlo", "wfa"
    job_id: str
    strategy_path: str
    config: dict[str, Any] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "run",
            "jobType": self.job_type,
            "jobId": self.job_id,
            "strategyPath": self.strategy_path,
            "config": self.config,
            "params": self.params,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunRequest":
        """Create from dictionary."""
        return cls(
            job_type=data["jobType"],
            job_id=data["jobId"],
            strategy_path=data["strategyPath"],
            config=data.get("config", {}),
            params=data.get("params", {}),
        )


@dataclass
class CancelRequest:
    """Request to cancel a job."""

    job_id: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "cancel",
            "jobId": self.job_id,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


# Type alias for any job message
JobMessage = ProgressMessage | LogMessage | CompleteMessage | FailedMessage


class NDJSONParser:
    """Parser for NDJSON messages with chunk buffering."""

    def __init__(self) -> None:
        """Initialize parser."""
        self._buffer = ""

    def feed(self, data: str) -> list[dict[str, Any]]:
        """
        Feed data and return parsed messages.

        Handles partial lines by buffering.

        Args:
            data: Raw string data

        Returns:
            List of parsed message dictionaries
        """
        self._buffer += data
        messages = []

        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            line = line.strip()
            if line:
                try:
                    messages.append(json.loads(line))
                except json.JSONDecodeError:
                    # Invalid JSON, skip
                    pass

        return messages

    def flush(self) -> list[dict[str, Any]]:
        """
        Flush any remaining buffered data.

        Returns:
            List of parsed message dictionaries
        """
        messages = []
        if self._buffer.strip():
            try:
                messages.append(json.loads(self._buffer.strip()))
            except json.JSONDecodeError:
                pass
        self._buffer = ""
        return messages


class NDJSONWriter:
    """Writer for NDJSON messages."""

    def __init__(self, output_func: Any = None) -> None:
        """
        Initialize writer.

        Args:
            output_func: Function to call with output (default: print)
        """
        self._output = output_func or print

    def write(self, message: ProgressMessage | LogMessage | CompleteMessage | FailedMessage | RunRequest | CancelRequest) -> None:
        """
        Write a message.

        Args:
            message: Message to write
        """
        self._output(message.to_ndjson())

    def progress(
        self,
        job_id: str,
        progress: float,
        message: str = "",
        eta: str | None = None,
    ) -> None:
        """Write a progress message."""
        msg = ProgressMessage(
            job_id=job_id,
            progress=progress,
            message=message,
            eta=eta,
        )
        self.write(msg)

    def log(
        self,
        job_id: str,
        message: str,
        level: LogLevel = LogLevel.INFO,
    ) -> None:
        """Write a log message."""
        msg = LogMessage(
            job_id=job_id,
            message=message,
            level=level,
        )
        self.write(msg)

    def complete(
        self,
        job_id: str,
        result: JobResult,
        duration_seconds: float = 0.0,
    ) -> None:
        """Write a completion message."""
        msg = CompleteMessage(
            job_id=job_id,
            result=result,
            duration_seconds=duration_seconds,
        )
        self.write(msg)

    def failed(
        self,
        job_id: str,
        error: str,
        stack: str | None = None,
    ) -> None:
        """Write a failure message."""
        msg = FailedMessage(
            job_id=job_id,
            error=error,
            stack=stack,
        )
        self.write(msg)
