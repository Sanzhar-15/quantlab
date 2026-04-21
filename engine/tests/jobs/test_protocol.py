"""
Tests for Job Protocol module.

Tests NDJSON message serialization and parsing.
"""

import json
import pytest
from datetime import datetime

from quantlab.jobs import (
    JobMessageType,
    LogLevel,
    ProgressMessage,
    LogMessage,
    CompleteMessage,
    FailedMessage,
    JobResult,
    MetricValue,
    RunRequest,
    CancelRequest,
    NDJSONParser,
    NDJSONWriter,
)


class TestJobMessageType:
    """Tests for JobMessageType enum."""

    def test_message_types(self) -> None:
        """Test message type values."""
        assert JobMessageType.PROGRESS.value == "progress"
        assert JobMessageType.LOG.value == "log"
        assert JobMessageType.COMPLETE.value == "complete"
        assert JobMessageType.FAILED.value == "failed"
        assert JobMessageType.RUN.value == "run"
        assert JobMessageType.CANCEL.value == "cancel"


class TestLogLevel:
    """Tests for LogLevel enum."""

    def test_log_levels(self) -> None:
        """Test log level values."""
        assert LogLevel.DEBUG.value == "debug"
        assert LogLevel.INFO.value == "info"
        assert LogLevel.WARN.value == "warn"
        assert LogLevel.ERROR.value == "error"


class TestProgressMessage:
    """Tests for ProgressMessage dataclass."""

    def test_creation(self) -> None:
        """Test progress message creation."""
        msg = ProgressMessage(
            job_id="test-001",
            progress=50.0,
            message="Processing...",
        )
        assert msg.job_id == "test-001"
        assert msg.progress == 50.0
        assert msg.message == "Processing..."

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        msg = ProgressMessage(
            job_id="test-001",
            progress=75.5,
            message="Almost done",
            eta="2 minutes",
            items_completed=75,
            items_total=100,
        )
        d = msg.to_dict()

        assert d["type"] == "progress"
        assert d["jobId"] == "test-001"
        assert d["progress"] == 75.5
        assert d["message"] == "Almost done"
        assert d["eta"] == "2 minutes"
        assert d["itemsCompleted"] == 75
        assert d["itemsTotal"] == 100

    def test_to_ndjson(self) -> None:
        """Test conversion to NDJSON."""
        msg = ProgressMessage(
            job_id="test-001",
            progress=50.0,
        )
        ndjson = msg.to_ndjson()

        assert ndjson.endswith("\n")
        parsed = json.loads(ndjson)
        assert parsed["type"] == "progress"
        assert parsed["jobId"] == "test-001"


class TestLogMessage:
    """Tests for LogMessage dataclass."""

    def test_creation(self) -> None:
        """Test log message creation."""
        msg = LogMessage(
            job_id="test-001",
            message="Starting backtest",
        )
        assert msg.level == LogLevel.INFO  # default

    def test_with_level(self) -> None:
        """Test log message with level."""
        msg = LogMessage(
            job_id="test-001",
            message="Something went wrong",
            level=LogLevel.ERROR,
        )
        d = msg.to_dict()
        assert d["level"] == "error"


class TestMetricValue:
    """Tests for MetricValue dataclass."""

    def test_creation(self) -> None:
        """Test metric value creation."""
        metric = MetricValue(
            name="Sharpe Ratio",
            value=1.5,
            format="number",
        )
        assert metric.name == "Sharpe Ratio"
        assert metric.value == 1.5

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        metric = MetricValue(
            name="Return",
            value=15.5,
            format="percent",
            description="Total return percentage",
        )
        d = metric.to_dict()

        assert d["name"] == "Return"
        assert d["value"] == 15.5
        assert d["format"] == "percent"


class TestJobResult:
    """Tests for JobResult dataclass."""

    def test_success_result(self) -> None:
        """Test successful job result."""
        result = JobResult(
            success=True,
            metrics=[
                MetricValue("Sharpe", 1.5, "number"),
                MetricValue("Return", 10.0, "percent"),
            ],
        )
        assert result.success is True
        assert len(result.metrics) == 2

    def test_failed_result(self) -> None:
        """Test failed job result."""
        result = JobResult(
            success=False,
            warnings=["Job failed: timeout"],
        )
        assert result.success is False
        assert len(result.warnings) == 1

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        result = JobResult(
            success=True,
            metrics=[MetricValue("Test", 42, "number")],
            artifact_paths={"result": "/path/to/result.json"},
        )
        d = result.to_dict()

        assert d["success"] is True
        assert d["artifactPaths"]["result"] == "/path/to/result.json"


class TestCompleteMessage:
    """Tests for CompleteMessage dataclass."""

    def test_creation(self) -> None:
        """Test complete message creation."""
        result = JobResult(success=True)
        msg = CompleteMessage(
            job_id="test-001",
            result=result,
            duration_seconds=10.5,
        )
        assert msg.job_id == "test-001"
        assert msg.duration_seconds == 10.5

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        result = JobResult(success=True)
        msg = CompleteMessage(
            job_id="test-001",
            result=result,
        )
        d = msg.to_dict()

        assert d["type"] == "complete"
        assert d["result"]["success"] is True


class TestFailedMessage:
    """Tests for FailedMessage dataclass."""

    def test_creation(self) -> None:
        """Test failed message creation."""
        msg = FailedMessage(
            job_id="test-001",
            error="Something went wrong",
        )
        assert msg.error == "Something went wrong"

    def test_with_stack(self) -> None:
        """Test failed message with stack trace."""
        msg = FailedMessage(
            job_id="test-001",
            error="Exception occurred",
            error_code="ERR_001",
            stack="Traceback...",
        )
        d = msg.to_dict()

        assert d["error"] == "Exception occurred"
        assert d["errorCode"] == "ERR_001"
        assert d["stack"] == "Traceback..."


class TestRunRequest:
    """Tests for RunRequest dataclass."""

    def test_creation(self) -> None:
        """Test run request creation."""
        req = RunRequest(
            job_type="backtest",
            job_id="backtest-001",
            strategy_path="/path/to/strategy.py",
            config={"symbol": "AAPL"},
        )
        assert req.job_type == "backtest"
        assert req.strategy_path == "/path/to/strategy.py"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        req = RunRequest(
            job_type="optimize",
            job_id="opt-001",
            strategy_path="/strategy.py",
            config={"metric": "sharpe"},
            params={"period": 20},
        )
        d = req.to_dict()

        assert d["type"] == "run"
        assert d["jobType"] == "optimize"
        assert d["params"]["period"] == 20

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "jobType": "backtest",
            "jobId": "bt-001",
            "strategyPath": "/path.py",
            "config": {"symbol": "GOOG"},
        }
        req = RunRequest.from_dict(data)

        assert req.job_type == "backtest"
        assert req.job_id == "bt-001"


class TestCancelRequest:
    """Tests for CancelRequest dataclass."""

    def test_creation(self) -> None:
        """Test cancel request creation."""
        req = CancelRequest(job_id="test-001")
        assert req.job_id == "test-001"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        req = CancelRequest(job_id="test-001")
        d = req.to_dict()

        assert d["type"] == "cancel"
        assert d["jobId"] == "test-001"


class TestNDJSONParser:
    """Tests for NDJSONParser class."""

    def test_parse_single_message(self) -> None:
        """Test parsing a single message."""
        parser = NDJSONParser()
        messages = parser.feed('{"type": "progress", "progress": 50}\n')

        assert len(messages) == 1
        assert messages[0]["type"] == "progress"
        assert messages[0]["progress"] == 50

    def test_parse_multiple_messages(self) -> None:
        """Test parsing multiple messages."""
        parser = NDJSONParser()
        data = '{"type": "log", "message": "test1"}\n{"type": "log", "message": "test2"}\n'
        messages = parser.feed(data)

        assert len(messages) == 2
        assert messages[0]["message"] == "test1"
        assert messages[1]["message"] == "test2"

    def test_partial_message_buffering(self) -> None:
        """Test buffering of partial messages."""
        parser = NDJSONParser()

        # Feed partial message
        messages1 = parser.feed('{"type": "prog')
        assert len(messages1) == 0

        # Feed rest of message
        messages2 = parser.feed('ress", "progress": 75}\n')
        assert len(messages2) == 1
        assert messages2[0]["progress"] == 75

    def test_flush(self) -> None:
        """Test flushing remaining buffer."""
        parser = NDJSONParser()
        parser.feed('{"type": "test"}')

        messages = parser.flush()
        assert len(messages) == 1
        assert messages[0]["type"] == "test"

    def test_invalid_json_skipped(self) -> None:
        """Test that invalid JSON is skipped."""
        parser = NDJSONParser()
        data = 'invalid json\n{"valid": true}\n'
        messages = parser.feed(data)

        assert len(messages) == 1
        assert messages[0]["valid"] is True


class TestNDJSONWriter:
    """Tests for NDJSONWriter class."""

    def test_write_progress(self) -> None:
        """Test writing progress message."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)

        writer.progress("job-001", 50.0, "Processing...")

        assert len(outputs) == 1
        parsed = json.loads(outputs[0])
        assert parsed["type"] == "progress"
        assert parsed["progress"] == 50.0

    def test_write_log(self) -> None:
        """Test writing log message."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)

        writer.log("job-001", "Test message", LogLevel.WARN)

        parsed = json.loads(outputs[0])
        assert parsed["type"] == "log"
        assert parsed["level"] == "warn"

    def test_write_complete(self) -> None:
        """Test writing complete message."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)

        result = JobResult(success=True)
        writer.complete("job-001", result, 10.5)

        parsed = json.loads(outputs[0])
        assert parsed["type"] == "complete"
        assert parsed["durationSeconds"] == 10.5

    def test_write_failed(self) -> None:
        """Test writing failed message."""
        outputs = []
        writer = NDJSONWriter(output_func=outputs.append)

        writer.failed("job-001", "Error occurred", "Stack trace...")

        parsed = json.loads(outputs[0])
        assert parsed["type"] == "failed"
        assert parsed["error"] == "Error occurred"
