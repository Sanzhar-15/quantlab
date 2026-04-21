"""
Tests for logging configuration module.
"""

import json
import logging
from datetime import datetime
from datetime import timedelta
from pathlib import Path

import pytest

from quantlab.logging.config import (
    LOG_CONFIGS,
    ContextAdapter,
    JsonFormatter,
    LogConfig,
    SecureFilter,
    cleanup_old_logs,
    get_logger,
    setup_logging,
)


class TestLogConfig:
    """Tests for LogConfig dataclass."""

    def test_create_config(self) -> None:
        """Should create log config."""
        config = LogConfig(
            name="test",
            filename="test.log",
            max_bytes=10 * 1024 * 1024,
            backup_count=5,
            retention_days=30,
        )

        assert config.name == "test"
        assert config.filename == "test.log"
        assert config.max_bytes == 10 * 1024 * 1024
        assert config.backup_count == 5
        assert config.retention_days == 30
        assert config.level == logging.INFO

    def test_custom_level(self) -> None:
        """Should accept custom log level."""
        config = LogConfig(
            name="debug",
            filename="debug.log",
            max_bytes=1024,
            backup_count=1,
            retention_days=1,
            level=logging.DEBUG,
        )

        assert config.level == logging.DEBUG

    def test_max_mb_property(self) -> None:
        """Should calculate max size in MB."""
        config = LogConfig(
            name="test",
            filename="test.log",
            max_bytes=50 * 1024 * 1024,
            backup_count=5,
            retention_days=30,
        )

        assert config.max_mb == 50


class TestStandardLogConfigs:
    """Tests for standard log configurations."""

    def test_app_config_exists(self) -> None:
        """Should have app log config."""
        assert "app" in LOG_CONFIGS
        config = LOG_CONFIGS["app"]
        assert config.filename == "app.log"
        assert config.max_mb == 10
        assert config.backup_count == 5
        assert config.retention_days == 7

    def test_engine_config_exists(self) -> None:
        """Should have engine log config."""
        assert "engine" in LOG_CONFIGS
        config = LOG_CONFIGS["engine"]
        assert config.filename == "engine.log"
        assert config.max_mb == 50
        assert config.backup_count == 10
        assert config.retention_days == 30

    def test_daemon_config_exists(self) -> None:
        """Should have daemon log config."""
        assert "daemon" in LOG_CONFIGS
        config = LOG_CONFIGS["daemon"]
        assert config.filename == "daemon.log"
        assert config.max_mb == 50
        assert config.backup_count == 5
        assert config.retention_days == 90


class TestJsonFormatter:
    """Tests for JsonFormatter class."""

    def test_init_defaults(self) -> None:
        """Should initialize with default settings."""
        formatter = JsonFormatter()

        assert formatter._include_exc_info is True
        assert formatter._include_stack_info is False

    def test_init_custom(self) -> None:
        """Should accept custom settings."""
        formatter = JsonFormatter(
            include_exc_info=False,
            include_stack_info=True,
        )

        assert formatter._include_exc_info is False
        assert formatter._include_stack_info is True

    def test_format_basic(self) -> None:
        """Should format basic log record as JSON."""
        formatter = JsonFormatter()

        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname="test.py",
            lineno=10,
            msg="Test message",
            args=(),
            exc_info=None,
        )

        output = formatter.format(record)

        data = json.loads(output)
        assert "timestamp" in data
        assert data["level"] == "INFO"
        assert data["logger"] == "test.logger"
        assert data["message"] == "Test message"

    def test_format_with_context(self) -> None:
        """Should include context in output."""
        formatter = JsonFormatter()

        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=10,
            msg="Test message",
            args=(),
            exc_info=None,
        )
        record.context = {"order_id": "ord-123", "symbol": "AAPL"}

        output = formatter.format(record)

        data = json.loads(output)
        assert "context" in data
        assert data["context"]["order_id"] == "ord-123"
        assert data["context"]["symbol"] == "AAPL"

    def test_format_debug_includes_source(self) -> None:
        """Should include source location for DEBUG level."""
        formatter = JsonFormatter()

        record = logging.LogRecord(
            name="test",
            level=logging.DEBUG,
            pathname="test.py",
            lineno=42,
            msg="Debug message",
            args=(),
            exc_info=None,
        )

        output = formatter.format(record)

        data = json.loads(output)
        assert "source" in data
        assert data["source"]["line"] == 42

    def test_format_with_exception(self) -> None:
        """Should include exception info."""
        formatter = JsonFormatter()

        try:
            raise ValueError("Test error")
        except ValueError:
            import sys
            exc_info = sys.exc_info()

        record = logging.LogRecord(
            name="test",
            level=logging.ERROR,
            pathname="test.py",
            lineno=10,
            msg="Error occurred",
            args=(),
            exc_info=exc_info,
        )

        output = formatter.format(record)

        data = json.loads(output)
        assert "exception" in data
        assert "ValueError" in data["exception"]

    def test_format_without_exception_when_disabled(self) -> None:
        """Should not include exception when disabled."""
        formatter = JsonFormatter(include_exc_info=False)

        try:
            raise ValueError("Test error")
        except ValueError:
            import sys
            exc_info = sys.exc_info()

        record = logging.LogRecord(
            name="test",
            level=logging.ERROR,
            pathname="test.py",
            lineno=10,
            msg="Error occurred",
            args=(),
            exc_info=exc_info,
        )

        output = formatter.format(record)

        data = json.loads(output)
        assert "exception" not in data


class TestContextAdapter:
    """Tests for ContextAdapter class."""

    def test_init(self) -> None:
        """Should initialize adapter."""
        logger = logging.getLogger("test")
        adapter = ContextAdapter(logger)

        assert adapter.logger is logger
        assert adapter.extra == {}

    def test_init_with_extra(self) -> None:
        """Should initialize with extra context."""
        logger = logging.getLogger("test")
        adapter = ContextAdapter(logger, {"session_id": "abc123"})

        assert adapter.extra == {"session_id": "abc123"}

    def test_with_context(self) -> None:
        """Should create new adapter with additional context."""
        logger = logging.getLogger("test")
        adapter = ContextAdapter(logger, {"session_id": "abc"})

        new_adapter = adapter.with_context(order_id="ord-123")

        # Original unchanged
        assert adapter.extra == {"session_id": "abc"}

        # New adapter has merged context
        assert new_adapter.extra == {"session_id": "abc", "order_id": "ord-123"}

    def test_process_adds_context(self) -> None:
        """Should add context to kwargs."""
        logger = logging.getLogger("test")
        adapter = ContextAdapter(logger, {"session_id": "xyz"})

        msg, kwargs = adapter.process("Test message", {})

        assert msg == "Test message"
        assert "extra" in kwargs
        assert kwargs["extra"]["context"]["session_id"] == "xyz"

    def test_process_merges_existing_context(self) -> None:
        """Should merge with existing context in kwargs."""
        logger = logging.getLogger("test")
        adapter = ContextAdapter(logger, {"session_id": "xyz"})

        msg, kwargs = adapter.process(
            "Test message",
            {"extra": {"context": {"order_id": "ord-1"}}}
        )

        assert kwargs["extra"]["context"]["session_id"] == "xyz"
        assert kwargs["extra"]["context"]["order_id"] == "ord-1"


class TestSecureFilter:
    """Tests for SecureFilter class."""

    def test_filter_passes_normal_records(self) -> None:
        """Should pass through normal log records."""
        filter = SecureFilter()

        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=10,
            msg="Normal message",
            args=(),
            exc_info=None,
        )

        result = filter.filter(record)

        assert result is True
        assert record.msg == "Normal message"

    def test_redact_dict_sensitive_keys(self) -> None:
        """Should redact sensitive keys in dictionary."""
        filter = SecureFilter()

        d = {
            "username": "john",
            "password": "secret123",
            "api_key": "abc-def-ghi",
            "data": "normal data",
        }

        result = filter._redact_dict(d)

        assert result["username"] == "john"
        assert result["password"] == "[REDACTED]"
        assert result["api_key"] == "[REDACTED]"
        assert result["data"] == "normal data"

    def test_redact_dict_nested(self) -> None:
        """Should redact nested dictionaries."""
        filter = SecureFilter()

        d = {
            "config": {
                "api_key": "secret",
                "host": "localhost",
            }
        }

        result = filter._redact_dict(d)

        assert result["config"]["api_key"] == "[REDACTED]"
        assert result["config"]["host"] == "localhost"

    def test_redact_dict_token_key(self) -> None:
        """Should redact token keys."""
        filter = SecureFilter()

        d = {
            "access_token": "bearer_xyz",
            "refresh_token": "refresh_xyz",
        }

        result = filter._redact_dict(d)

        assert result["access_token"] == "[REDACTED]"
        assert result["refresh_token"] == "[REDACTED]"

    def test_redact_dict_auth_key(self) -> None:
        """Should redact auth keys."""
        filter = SecureFilter()

        d = {
            "auth_header": "Basic xyz",
            "authorization": "Bearer abc",
        }

        result = filter._redact_dict(d)

        assert result["auth_header"] == "[REDACTED]"
        assert result["authorization"] == "[REDACTED]"

    def test_filter_redacts_context(self) -> None:
        """Should redact sensitive context values."""
        filter = SecureFilter()

        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="test.py",
            lineno=10,
            msg="Request made",
            args=(),
            exc_info=None,
        )
        record.context = {
            "url": "https://api.example.com",
            "api_key": "secret-key",
        }

        filter.filter(record)

        assert record.context["url"] == "https://api.example.com"
        assert record.context["api_key"] == "[REDACTED]"


class TestSetupLogging:
    """Tests for setup_logging function."""

    def _cleanup_logging(self) -> None:
        """Clean up logging handlers."""
        root = logging.getLogger()
        for handler in root.handlers[:]:
            handler.close()
            root.removeHandler(handler)

        daemon_logger = logging.getLogger("quantlab.daemon")
        for handler in daemon_logger.handlers[:]:
            handler.close()
            daemon_logger.removeHandler(handler)

    def test_setup_creates_log_dir(self, tmp_path: Path) -> None:
        """Should create log directory."""
        log_dir = tmp_path / "logs"

        try:
            setup_logging(log_dir=log_dir, console=False)
            assert log_dir.exists()
        finally:
            self._cleanup_logging()

    def test_setup_creates_engine_log(self, tmp_path: Path) -> None:
        """Should create engine log file."""
        log_dir = tmp_path / "logs"

        try:
            setup_logging(log_dir=log_dir, console=False)

            # Log something to create the file
            logger = logging.getLogger("test")
            logger.info("Test message")

            assert (log_dir / "engine.log").exists()
        finally:
            self._cleanup_logging()

    def test_setup_with_session_id(self, tmp_path: Path) -> None:
        """Should create daemon log with session ID."""
        log_dir = tmp_path / "logs"

        try:
            setup_logging(log_dir=log_dir, console=False, session_id="test-session")

            # Log from daemon logger
            daemon_logger = logging.getLogger("quantlab.daemon")
            daemon_logger.info("Daemon message")

            assert (log_dir / "daemon_test-session.log").exists()
        finally:
            self._cleanup_logging()

    def test_setup_with_text_format(self, tmp_path: Path) -> None:
        """Should use text format when json_format=False."""
        log_dir = tmp_path / "logs"

        try:
            setup_logging(log_dir=log_dir, console=False, json_format=False)

            logger = logging.getLogger("test")
            logger.info("Test message")

            log_content = (log_dir / "engine.log").read_text()

            # Should not be JSON
            assert not log_content.startswith("{")
        finally:
            self._cleanup_logging()


class TestGetLogger:
    """Tests for get_logger function."""

    def test_returns_context_adapter(self) -> None:
        """Should return ContextAdapter."""
        logger = get_logger("test.module")

        assert isinstance(logger, ContextAdapter)

    def test_logger_name(self) -> None:
        """Should use correct logger name."""
        logger = get_logger("myapp.submodule")

        assert logger.logger.name == "myapp.submodule"


class TestCleanupOldLogs:
    """Tests for cleanup_old_logs function."""

    def test_cleanup_nonexistent_dir(self, tmp_path: Path) -> None:
        """Should return 0 for nonexistent directory."""
        nonexistent = tmp_path / "nonexistent"

        deleted = cleanup_old_logs(log_dir=nonexistent)

        assert deleted == 0

    def test_cleanup_empty_dir(self, tmp_path: Path) -> None:
        """Should return 0 for empty directory."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        deleted = cleanup_old_logs(log_dir=log_dir)

        assert deleted == 0

    def test_cleanup_old_files(self, tmp_path: Path) -> None:
        """Should delete old log files."""
        import os
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        # Create old engine log files
        old_file = log_dir / "engine.log.1"
        old_file.write_text("old log content")

        # Set modification time to 100 days ago
        old_time = datetime.now() - timedelta(days=100)
        os.utime(old_file, (old_time.timestamp(), old_time.timestamp()))

        deleted = cleanup_old_logs(log_dir=log_dir)

        assert deleted >= 1
        assert not old_file.exists()

    def test_cleanup_keeps_recent_files(self, tmp_path: Path) -> None:
        """Should keep recent log files."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        # Create recent engine log file
        recent_file = log_dir / "engine.log"
        recent_file.write_text("recent log content")

        deleted = cleanup_old_logs(log_dir=log_dir)

        assert recent_file.exists()

    def test_cleanup_with_max_age_override(self, tmp_path: Path) -> None:
        """Should use max_age_days override."""
        import os
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        # Create file that's 5 days old
        old_file = log_dir / "engine.log.1"
        old_file.write_text("5 day old content")
        old_time = datetime.now() - timedelta(days=5)
        os.utime(old_file, (old_time.timestamp(), old_time.timestamp()))

        # Delete files older than 3 days
        deleted = cleanup_old_logs(log_dir=log_dir, max_age_days=3)

        assert deleted >= 1
        assert not old_file.exists()
